import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSession } from './session.mjs';
import { createJobManager } from './jobs.mjs';
import { APP_VERSION, API_VERSION, HOST_LIMITS, errorDto, failure, exact, isId, integer, project, sanitizeError, jsonBytes, normalizeLimits } from './contracts.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const HEADERS={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const COLLECTIONS={fields:'fields',candidates:'candidates',records:'records',issues:'key_issues',pairs:'pairs',decisions:'decisions'};
const FILTERS={fields:['status','field','left_id','right_id'],candidates:['left_id','right_id','suggested'],records:['side','status'],issues:[],pairs:[],decisions:[]};
const EXAMPLES={orders:'合成 orders 示例',migration:'合成 migration 示例',catalog:'合成 catalog 示例',ourairports:'OurAirports 公开快照 CN/FR（2026-09-01 / 2026-10-01），来源见 examples/ourairports/provenance.json'};
const STATIC_PAGE='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MoonReconcile 本地工作台</title><h1>MoonReconcile 本地 CSV 服务</h1><p>API v1 已提供 CSV 导入、规则草稿与校验、比较、只读证据和取消。图形规则编辑器将在下一任务实现。数据仅暂存在本机；退出服务会清理当前会话。</p></html>';
function ids(value,keys) {for(const k of keys)if(!isId(value[k]))throw failure('invalid_request','Invalid identifier');}
function page(value) {exact(value,['offset','limit']);if(!integer(value.offset)||!integer(value.limit,1,100))throw failure('invalid_request','Invalid pagination');}
function cell(value,withSide=false) {exact(value,withSide?['side','record','column']:['record','column']);if(!integer(value.record,1,100000)||typeof value.column!=='string'||(withSide&&!['left','right'].includes(value.side)))throw failure('invalid_request','Invalid cell request');}
function importEntry(asset,side,preview) {return {import_id:randomUUID(),asset_id:asset.asset_id,side,format:'csv',status:'ready',headers:preview.headers,row_count:preview.row_count,column_count:preview.column_count,sha256:asset.sha256,path:asset.path};}
export async function startWorkbench({bridgePath,rootParent,limits:overrides={}}={}) {
  const limits=normalizeLimits(overrides),session=await createSession({rootParent,limits:overrides});
  const jobs=await createJobManager({session,bridgePath,limits:overrides}),token=randomBytes(32).toString('hex');
  const uploads=new Set();let origin,closing=false;
  function imports(body) {
    ids(body,['left_import_id','right_import_id']);const left=session.getImport(body.left_import_id),right=session.getImport(body.right_import_id);
    if(left.side!=='left'||right.side!=='right')throw failure('invalid_request','Import sides must be left/right');return {left,right};
  }
  function configJob(kind,body,left,right,source) {
    return jobs.start(kind,{reservation:source?.bytes??0,prepare:async({staging})=>{
      const config=path.join(staging,'config.json');let configInput=source?.path;
      if(kind==='check'&&!source){configInput=path.join(staging,'input.json');await fs.writeFile(configInput,JSON.stringify(body.config),{mode:0o600,flag:'wx'});}
      return {task:{payload:{},paths:{left:left.path,right:right.path,config,configInput}},prepareOutput:async o=>{
        if(o.config_path!==config||o.draft!==(kind==='draft'))throw failure('invalid_worker_output','Invalid config candidate');
        const asset=await session.prepareAsset('config',kind==='draft'?'draft.json':'config.json',config);
        return {output:{config_asset_id:asset.asset_id,draft:kind==='draft'},commit:()=>{session.commitAsset(asset);if(kind==='check')session.bindings.set(asset.asset_id,[left.import_id,right.import_id]);}};
      }};
    }});
  }
  async function readJson(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw failure('invalid_request','application/json required');
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limits.request_bytes)throw failure('request_too_large','JSON orchestration limit exceeded',413);chunks.push(c);}
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw failure('invalid_request','Invalid UTF-8 JSON body');}
    if(value===null||typeof value!=='object'||Array.isArray(value))throw failure('invalid_request','JSON object required');return value;
  }
  async function upload(req) {
    if(uploads.size>=limits.uploads)throw failure('upload_busy','An upload is already active',409);
    const state={req,cause:null};let finish;state.done=new Promise(r=>finish=r);uploads.add(state);
    const key=randomUUID();let dir,file,timer;
    try {
      // reserve() enters the shared writer ledger before its first await.
      await session.reserve(key,0);dir=await session.staging('upload');
      const url=new URL(req.url,origin);const kind=url.searchParams.get('kind');
      if(kind==='xlsx')throw failure('unsupported_format','Only CSV input is supported',422);
      if(!['csv','config','decisions','run'].includes(kind)||url.searchParams.size!==1)throw failure('invalid_request','Invalid asset kind');
      if(!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type']??''))throw failure('invalid_request','application/octet-stream required');
      let name;try{name=decodeURIComponent(req.headers['x-filename']??'upload');}catch{throw failure('invalid_request','Invalid encoded filename');}
      if([...name].length>255)throw failure('invalid_request','Filename exceeds 255 code points');
      const cap=Math.min(limits.asset_bytes??Infinity,kind==='decisions'?134217728:kind==='run'?limits.zip_bytes:67108864);
      let expected=Number(req.headers['content-length']??0);
      if(!Number.isSafeInteger(expected)||expected<0)throw failure('invalid_request','Invalid Content-Length');
      if(expected>cap)throw failure('quota_exceeded','Asset byte limit exceeded',413);
      await session.reserve(key,expected,dir);
      const target=path.join(dir,'data');file=await fs.open(target,'wx',0o600);let bytes=0;
      timer=setTimeout(()=>{state.cause=failure('upload_timeout','Upload time limit exceeded',408);req.destroy();},limits.upload_ms);
      for await(const chunk of req) {
        if(closing)throw failure('session_closed','Session is closing',409);
        bytes+=chunk.length;if(bytes>cap)throw failure('quota_exceeded','Asset byte limit exceeded',413);
        await session.reserve(key,Math.max(expected,bytes),dir);await file.writeFile(chunk);
      }
      if(req.aborted||!req.complete||closing)throw failure('upload_aborted','Upload did not complete',400);
      await file.close();file=null;const asset=await session.prepareAsset(kind,name,target);await session.checkQuota();
      if(req.aborted||closing)throw failure('upload_aborted','Upload did not complete',400);
      session.commitAsset(asset);dir=null;return project('asset',asset);
    }catch(e){throw state.cause??e;}
    finally{clearTimeout(timer);await file?.close();if(dir)await session.remove(dir);session.release(key);uploads.delete(state);finish();}
  }
  const server=http.createServer(async(req,res)=>{
    const reply=(status,body)=>{
      if(res.destroyed||res.headersSent)return;
      if(jsonBytes(body)>limits.response_bytes){status=413;body={ok:false,error:errorDto('response_limit_exceeded','Response display limit exceeded; use the evidence export route')};}
      res.writeHead(status,{...HEADERS,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));
    };
    const accepted=job=>reply(202,{ok:true,job_id:job.job_id});
    const stream=async(file,type,name)=>{
      await session.owned(file);const size=(await fs.stat(file)).size;
      res.writeHead(200,{...HEADERS,'Content-Type':type,'Content-Length':size,'Content-Disposition':`attachment; filename="${name}"`});
      const input=createReadStream(file);input.on('error',()=>res.destroy());res.on('close',()=>input.destroy());input.pipe(res);
    };
    try {
      if(closing)throw failure('session_closed','Session is closing',409);
      if(req.headers.host!==new URL(origin).host)throw failure('forbidden','Invalid Host',403);
      const url=new URL(req.url,origin),route=url.pathname;
      const fetchSite=req.headers['sec-fetch-site'];
      if((req.headers.origin&&req.headers.origin!==origin)||(fetchSite&&fetchSite!=='same-origin'))throw failure('forbidden','Cross-site request rejected',403);
      if(!route.startsWith('/api/')) {
        if(req.method==='GET'&&['/','/index.html'].includes(route)&&url.searchParams.size===0){res.writeHead(200,{...HEADERS,'Content-Type':'text/html; charset=utf-8'});res.end(STATIC_PAGE);return;}
        return reply(404,{ok:false,error:errorDto('not_found','Route not found')});
      }
      if(req.headers.authorization!==`Bearer ${token}`)throw failure('unauthorized','Bearer token required',401);
      const noQuery=()=>{if(url.searchParams.size)throw failure('invalid_request','Unexpected query property');};
      if(req.method==='GET'&&route==='/api/capabilities'){noQuery();return reply(200,{ok:true,app_version:APP_VERSION,api_version:API_VERSION,engine_version:'0.1.0',formats:['csv'],limits:HOST_LIMITS});}
      if(req.method==='POST'&&route==='/api/assets')return reply(201,{ok:true,asset:await upload(req)});
      if(req.method==='POST'&&route==='/api/imports') {
        noQuery();const b=await readJson(req);exact(b,['asset_id','side']);ids(b,['asset_id']);if(!['left','right'].includes(b.side))throw failure('invalid_request','Invalid side');
        const asset=session.getAsset(b.asset_id);if(asset.kind!=='csv')throw failure('unsupported_format','CSV asset required',422);
        return accepted(jobs.start('import',{prepare:async()=>({task:{payload:{side:b.side,offset:0,limit:20},paths:{csv:asset.path}},prepareOutput:async o=>{
          const entry=importEntry(asset,b.side,o.preview);if(session.imports.size>=limits.imports)throw failure('quota_exceeded','Import count quota exceeded',413);
          return {output:{import:project('import',entry),preview:o.preview},commit:()=>session.commitImport(entry)};
        }})}));
      }
      const im=route.match(/^\/api\/imports\/([^/]+)\/(preview|cell)$/);
      if(req.method==='POST'&&im) {
        noQuery();const imp=session.getImport(im[1]),b=await readJson(req);if(im[2]==='preview')page(b);else cell(b);
        return accepted(jobs.start(im[2],{task:{payload:{side:imp.side,...b},paths:{csv:imp.path}}}));
      }
      if(req.method==='POST'&&route==='/api/config/draft') {
        noQuery();const b=await readJson(req);exact(b,['left_import_id','right_import_id']);const {left,right}=imports(b);return accepted(configJob('draft',b,left,right));
      }
      if(req.method==='POST'&&route==='/api/config/check') {
        noQuery();const b=await readJson(req);const supplied=Object.hasOwn(b,'config_asset_id');exact(b,['left_import_id','right_import_id',supplied?'config_asset_id':'config']);
        const {left,right}=imports(b);let source;
        if(supplied){ids(b,['config_asset_id']);source=session.getAsset(b.config_asset_id);if(source.kind!=='config')throw failure('invalid_request','Config asset required');}
        return accepted(configJob('check',b,left,right,source));
      }
      const configExport=route.match(/^\/api\/configs\/([^/]+)\/export$/);
      if(req.method==='GET'&&configExport){noQuery();const asset=session.getAsset(configExport[1]);if(asset.kind!=='config')throw failure('invalid_request','Config asset required');return await stream(asset.path,'application/json','config.json');}
      const example=route.match(/^\/api\/examples\/([^/]+)$/);
      if(req.method==='POST'&&example) {
        noQuery();exact(await readJson(req),[]);const name=example[1];if(!Object.hasOwn(EXAMPLES,name))throw failure('not_found','Example not found',404);
        const base=path.join(ROOT,'examples',name),sourceFiles=['left.csv','right.csv','rules.json'];let reserve=0;for(const f of sourceFiles)reserve+=(await fs.stat(path.join(base,f))).size;
        return accepted(jobs.start('example',{reservation:reserve*2,prepare:async({staging})=>{
          const left=path.join(staging,'left.csv'),right=path.join(staging,'right.csv'),configInput=path.join(staging,'rules.json'),config=path.join(staging,'config.json');
          for(const [source,dest] of [['left.csv',left],['right.csv',right],['rules.json',configInput]]){await fs.copyFile(path.join(base,source),dest);await fs.chmod(dest,0o600);}
          return {task:{payload:{},paths:{left,right,configInput,config,staging}},prepareOutput:async o=>{
            if(o.metadata_path!==path.join(staging,'imports.json')||o.config_path!==config)throw failure('invalid_worker_output','Invalid example candidate');
            const meta=JSON.parse(await fs.readFile(o.metadata_path,'utf8'));
            const a=await session.prepareAsset('csv',name+'-left.csv',left),b=await session.prepareAsset('csv',name+'-right.csv',right),c=await session.prepareAsset('config',name+'-rules.json',config);
            const li=importEntry(a,'left',meta.left),ri=importEntry(b,'right',meta.right);project('import',li);project('import',ri);
            if(session.assets.size+3>limits.assets||session.imports.size+2>limits.imports)throw failure('quota_exceeded','Example registry quota exceeded',413);
            return {output:{left_import_id:li.import_id,right_import_id:ri.import_id,config_asset_id:c.asset_id,source_label:EXAMPLES[name]},commit:()=>{if(session.assets.size+3>limits.assets||session.imports.size+2>limits.imports)throw failure('quota_exceeded','Example registry quota exceeded',413);for(const asset of [a,b,c])session.commitAsset(asset);session.commitImport(li);session.commitImport(ri);session.bindings.set(c.asset_id,[li.import_id,ri.import_id]);}};
          }};
        }}));
      }
      if(req.method==='POST'&&route==='/api/runs') {
        noQuery();const b=await readJson(req);exact(b,['left_import_id','right_import_id','config_asset_id']);ids(b,['config_asset_id']);const {left,right}=imports(b),config=session.getAsset(b.config_asset_id);
        const binding=session.bindings.get(config.asset_id);if(config.kind!=='config'||binding?.[0]!==left.import_id||binding?.[1]!==right.import_id)throw failure('config_binding_mismatch','Validated config is not bound to these imports',409);
        const reserve=session.getAsset(left.asset_id).bytes+session.getAsset(right.asset_id).bytes+config.bytes;
        return accepted(jobs.start('compare',{reservation:reserve,prepare:async({staging})=>{
          const run=path.join(staging,'run');return {task:{payload:{},paths:{left:left.path,right:right.path,config:config.path,run}},prepareOutput:async o=>{
            if(o.run_path!==run||![0,1,3].includes(o.exit_code))throw failure('invalid_worker_output','Invalid comparison candidate');
            const revision=await session.prepareRevision({runPath:run,left_import_id:left.import_id,right_import_id:right.import_id,config_asset_id:config.asset_id});
            if(revision.exit_code!==o.exit_code)throw failure('invalid_worker_output','Result exit code mismatch');
            return {output:{revision:project('revision',revision)},commit:()=>session.commitRevision(revision)};
          }};
        }}));
      }
      const jm=route.match(/^\/api\/jobs\/([^/]+)$/);
      if(jm&&['GET','DELETE'].includes(req.method)) {noQuery();if(!isId(jm[1]))throw failure('invalid_request','Invalid identifier');return reply(200,{ok:true,job:project('job',req.method==='DELETE'?await jobs.cancel(jm[1]):jobs.get(jm[1]))});}
      const summary=route.match(/^\/api\/runs\/([^/]+)\/summary$/);
      if(req.method==='GET'&&summary) {
        noQuery();const revision=session.getRevision(summary[1]);const result=JSON.parse(await fs.readFile(path.join(revision.path,'report.json'),'utf8'));
        const output={ok:true,revision:project('revision',revision),computation:result.computation,summary:result.summary,structure:result.structure};
        if(jsonBytes(output)>limits.response_bytes)throw failure('response_limit_exceeded',`Summary exceeds display limit; export /api/runs/${revision.revision_id}/export?kind=report`,413);
        return reply(200,output);
      }
      const exportRun=route.match(/^\/api\/runs\/([^/]+)\/export$/);
      if(req.method==='GET'&&exportRun) {
        const revision=session.getRevision(exportRun[1]),kind=url.searchParams.get('kind'),files={report:['report.json','application/json'],summary:['summary.md','text/markdown; charset=utf-8'],decisions:['decisions.csv','text/csv; charset=utf-8']};
        if(url.searchParams.size!==1||!Object.hasOwn(files,kind))throw failure('invalid_request','Invalid export kind');const [file,type]=files[kind];return await stream(path.join(revision.path,file),type,file);
      }
      const itemExport=route.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/([^/]+)\/export$/);
      if(req.method==='GET'&&itemExport) {
        noQuery();const revision=session.getRevision(itemExport[1]),collection=itemExport[2];if(!Object.hasOwn(COLLECTIONS,collection)||! /^(0|[1-9][0-9]*)$/.test(itemExport[3]))throw failure('invalid_request','Invalid collection index');
        const index=Number(itemExport[3]);if(!integer(index))throw failure('invalid_request','Invalid collection index');
        const result=JSON.parse(await fs.readFile(path.join(revision.path,'report.json'),'utf8')),item=result[COLLECTIONS[collection]][index];if(item===undefined)throw failure('not_found','Evidence item not found',404);
        // The JSON download deliberately bypasses display budget; source bytes are quota-bound.
        const data=JSON.stringify(item)+'\n';res.writeHead(200,{...HEADERS,'Content-Type':'application/json','Content-Disposition':`attachment; filename="${collection}-${index}.json"`});res.end(data);return;
      }
      const collectionRoute=route.match(/^\/api\/runs\/([^/]+)\/([^/]+)$/);
      if(req.method==='GET'&&collectionRoute&&Object.hasOwn(COLLECTIONS,collectionRoute[2])) {
        const revision=session.getRevision(collectionRoute[1]),collection=collectionRoute[2],allowed=['offset','limit',...FILTERS[collection]];
        for(const k of url.searchParams.keys())if(!allowed.includes(k)||url.searchParams.getAll(k).length!==1)throw failure('invalid_request','Unknown or repeated query property');
        const parse=(key,fallback)=>{const s=url.searchParams.get(key);if(s===null)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(s))throw failure('invalid_request','Invalid pagination');return Number(s);};
        const offset=parse('offset',0),limit=parse('limit',20);page({offset,limit});
        if(url.searchParams.has('suggested')&&!['true','false'].includes(url.searchParams.get('suggested')))throw failure('invalid_request','Invalid suggested filter');
        if(url.searchParams.has('side')&&!['left','right'].includes(url.searchParams.get('side')))throw failure('invalid_request','Invalid side filter');
        const result=JSON.parse(await fs.readFile(path.join(revision.path,'report.json'),'utf8'));
        const entries=result[COLLECTIONS[collection]].map((item,source_index)=>({source_index,item})).filter(({item})=>FILTERS[collection].every(k=>!url.searchParams.has(k)||String(item[k])===url.searchParams.get(k)));
        const output={ok:true,items:[],total:entries.length,offset,next_offset:offset,has_more:offset<entries.length};
        for(const entry of entries.slice(offset,offset+limit)) {
          output.items.push(entry);output.next_offset=offset+output.items.length;output.has_more=output.next_offset<entries.length;
          if(jsonBytes(output)>limits.response_bytes){output.items.pop();output.next_offset=offset+output.items.length;output.has_more=output.next_offset<entries.length;if(!output.items.length)throw failure('response_limit_exceeded',`Item ${entry.source_index} exceeds display limit; export /api/runs/${revision.revision_id}/items/${collection}/${entry.source_index}/export`,413);break;}
        }
        return reply(200,output);
      }
      const runCell=route.match(/^\/api\/runs\/([^/]+)\/cell$/);
      if(req.method==='POST'&&runCell) {
        noQuery();const revision=session.getRevision(runCell[1]),b=await readJson(req);cell(b,true);const csv=path.join(revision.path,'input',b.side+'.csv');return accepted(jobs.start('cell',{task:{payload:b,paths:{csv}}}));
      }
      if(req.method==='POST'&&route==='/api/sessions/reset') {
        noQuery();const b=await readJson(req);exact(b,['confirm']);if(b.confirm!==true)throw failure('invalid_request','Explicit reset confirmation required');
        if(jobs.active||uploads.size)throw failure('session_busy','Active uploads or tasks prevent reset',409);
        await session.reset();return reply(200,{ok:true});
      }
      return reply(404,{ok:false,error:errorDto('not_found','Route not found')});
    }catch(e){reply(e.status??400,{ok:false,error:sanitizeError(e,[session.root])});}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(e){await jobs.close();await session.close();throw e;}
  origin=`http://127.0.0.1:${server.address().port}`;
  let closePromise;
  const close=()=>closePromise??=(async()=>{
    closing=true;
    for(const u of uploads){u.cause=failure('upload_aborted','Server is closing',409);u.req.destroy();}
    await Promise.all([...uploads].map(u=>u.done));await jobs.close();
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await session.close();
  })();
  return {origin,token,session,jobs,close};
}
