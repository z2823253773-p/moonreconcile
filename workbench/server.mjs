import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJsonStringify } from '../cli/io.mjs';
import { createSession } from './session.mjs';
import { createJobManager } from './jobs.mjs';
import { assertCumulativeDecisions } from './public/review-model.mjs';
import { RUN_BUNDLE_FILES } from './archive.mjs';
import { APP_VERSION, API_VERSION, HOST_LIMITS, XLSX_LIMITS, errorDto, failure, exact, isId, integer, project, sanitizeError, jsonBytes, normalizeLimits } from './contracts.mjs';
import { assertImportSpec } from './xlsx/contracts.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const HEADERS={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const COLLECTIONS={fields:'fields',candidates:'candidates',records:'records',issues:'key_issues',pairs:'pairs',decisions:'decisions'};
const FILTERS={fields:['status','field','left_id','right_id'],candidates:['left_id','right_id','suggested'],records:['side','status'],issues:[],pairs:[],decisions:[]};
const EXAMPLES={orders:'合成 orders 示例',migration:'合成 migration 示例',catalog:'合成 catalog 示例',ourairports:'OurAirports 公开快照 CN/FR（2026-09-01 / 2026-10-01），来源见 examples/ourairports/provenance.json'};
const STATIC_FILES=new Map([
  ['/','index.html'],['/index.html','index.html'],
  ['/public/app.mjs','app.mjs'],['/public/idle-reminder.mjs','idle-reminder.mjs'],['/public/api.mjs','api.mjs'],['/public/state.mjs','state.mjs'],
  ['/public/dom.mjs','dom.mjs'],['/public/import-view.mjs','import-view.mjs'],['/public/xlsx-view.mjs','xlsx-view.mjs'],
  ['/public/config-view.mjs','config-view.mjs'],['/public/config-model.mjs','config-model.mjs'],
  ['/public/result-view.mjs','result-view.mjs'],['/public/review-view.mjs','review-view.mjs'],['/public/review-model.mjs','review-model.mjs'],
  ['/public/export-view.mjs','export-view.mjs'],
  ['/public/styles.css','styles.css'],
  ['/cli/render.mjs','../../cli/render.mjs'],
]);
const STATIC_TYPES={html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
function ids(value,keys) {for(const k of keys)if(!isId(value[k]))throw failure('invalid_request','Invalid identifier');}
function page(value) {exact(value,['offset','limit']);if(!integer(value.offset)||!integer(value.limit,1,100))throw failure('invalid_request','Invalid pagination');}
function cell(value,withSide=false) {exact(value,withSide?['side','record','column']:['record','column']);if(!integer(value.record,1,100000)||typeof value.column!=='string'||(withSide&&!['left','right'].includes(value.side)))throw failure('invalid_request','Invalid cell request');}
function importEntry(asset,side,preview) {return {import_id:randomUUID(),asset_id:asset.asset_id,side,format:'csv',status:'ready',headers:preview.headers,row_count:preview.row_count,column_count:preview.column_count,sha256:asset.sha256,path:asset.path};}
const sha256=async(file)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const keySet=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validWorkbook(workbook,asset) {
  if(!keySet(workbook,['xlsx_api_version','asset_id','source_sha256','date_system','sheets'])||workbook.xlsx_api_version!==1||workbook.asset_id!==asset.asset_id||workbook.source_sha256!==asset.sha256||!['1900','1904'].includes(workbook.date_system)||!Array.isArray(workbook.sheets)||workbook.sheets.length<1||workbook.sheets.length>2048)return false;
  const sheetKeys=['sheet_id','name','state','kind','selectable','value_cells','min_row','max_row','min_column','max_column'],ids=new Set();
  return workbook.sheets.every(sheet=>{
    if(!keySet(sheet,sheetKeys)||typeof sheet.sheet_id!=='string'||!new RegExp(`^${asset.sha256}:[1-9][0-9]*$`).test(sheet.sheet_id)||ids.has(sheet.sheet_id)||typeof sheet.name!=='string'||[...sheet.name].length>255||!['visible','hidden','veryHidden'].includes(sheet.state)||!['worksheet','other'].includes(sheet.kind)||sheet.selectable!==(sheet.kind==='worksheet'&&sheet.state==='visible')||!integer(sheet.value_cells,0,1000000))return false;
    ids.add(sheet.sheet_id);
    if(sheet.value_cells===0)return sheet.min_row===null&&sheet.max_row===null&&sheet.min_column===null&&sheet.max_column===null;
    return integer(sheet.min_row,1,1048576)&&integer(sheet.max_row,sheet.min_row,1048576)&&integer(sheet.min_column,1,16384)&&integer(sheet.max_column,sheet.min_column,16384);
  });
}
export async function startWorkbench({bridgePath,workerPath,rootParent,limits:overrides={},xlsxEnabled=false}={}) {
  const limits=normalizeLimits(overrides),session=await createSession({rootParent,limits:overrides});
  const jobs=await createJobManager({session,bridgePath,workerPath,limits:overrides}),token=randomBytes(32).toString('hex');
  const uploads=new Set(),requests=new Set(),bundles=new Set();let origin,closing=false;
  const canonicalBytes=entry=>session.getAsset(entry.canonical_asset_id??entry.asset_id).bytes;
  function startJob(kind,payload){
    if(closing)throw failure('session_closed','Session is closing',409);
    return jobs.start(kind,payload);
  }
  function imports(body) {
    ids(body,['left_import_id','right_import_id']);const left=session.getImport(body.left_import_id),right=session.getImport(body.right_import_id);
    if(left.side!=='left'||right.side!=='right')throw failure('invalid_request','Import sides must be left/right');return {left,right};
  }
  function configJob(kind,body,left,right,source) {
    return startJob(kind,{reservation:canonicalBytes(left)+canonicalBytes(right)+(source?.bytes??0),prepare:async({staging})=>{
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
    // Returning the default async iterator destroys an unfinished request and
    // can reset a keep-alive socket before its bounded error response arrives.
    let size=0;const chunks=[];for await(const c of req.iterator({destroyOnReturn:false})){if(closing)throw failure('session_closed','Session is closing',409);size+=c.length;if(size>limits.request_bytes)throw failure('request_too_large','JSON orchestration limit exceeded',413);chunks.push(c);}
    if(closing)throw failure('session_closed','Session is closing',409);
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
      if(kind==='xlsx'&&!xlsxEnabled)throw failure('unsupported_format','Only CSV input is supported',422);
      if(!['csv','config','decisions','run',...(xlsxEnabled?['xlsx']:[])].includes(kind)||url.searchParams.size!==1)throw failure('invalid_request','Invalid asset kind');
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
    let finish;const state={req,done:new Promise(resolve=>finish=resolve)};requests.add(state);
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
      const staticEntry=req.method==='GET'&&STATIC_FILES.has(route)&&url.searchParams.size===0;
      const permittedSite=fetchSite==='same-origin'||(staticEntry&&fetchSite==='none');
      if((req.headers.origin&&req.headers.origin!==origin)||(fetchSite&&!permittedSite))throw failure('forbidden','Cross-site request rejected',403);
      if(!route.startsWith('/api/')) {
        if(staticEntry){const file=STATIC_FILES.get(route),type=STATIC_TYPES[file.split('.').at(-1)];const body=await fs.readFile(path.join(ROOT,'workbench','public',file));res.writeHead(200,{...HEADERS,'Content-Type':type,'Content-Length':body.length});res.end(body);return;}
        return reply(404,{ok:false,error:errorDto('not_found','Route not found')});
      }
      if(req.headers.authorization!==`Bearer ${token}`)throw failure('unauthorized','Bearer token required',401);
      const noQuery=()=>{if(url.searchParams.size)throw failure('invalid_request','Unexpected query property');};
      if(req.method==='GET'&&route==='/api/capabilities'){noQuery();return reply(200,{ok:true,app_version:APP_VERSION,api_version:API_VERSION,engine_version:'0.1.0',formats:xlsxEnabled?['csv','xlsx']:['csv'],...(xlsxEnabled?{xlsx_api_version:1,import_profile_schema_version:1,xlsx_limits:XLSX_LIMITS}:{}),limits:HOST_LIMITS});}
      if(req.method==='POST'&&route==='/api/assets')return reply(201,{ok:true,asset:await upload(req)});
      if(req.method==='POST'&&route==='/api/xlsx/catalog') {
        if(!xlsxEnabled)throw failure('unsupported_format','XLSX import is not enabled',422);
        noQuery();const body=await readJson(req);exact(body,['asset_id']);ids(body,['asset_id']);const source=session.getAsset(body.asset_id);if(source.kind!=='xlsx')throw failure('unsupported_format','XLSX asset required',422);
        return accepted(startJob('xlsx_catalog',{reservation:source.bytes,prepare:async({staging})=>({task:{payload:{asset_id:source.asset_id},paths:{xlsx:source.path,staging}},prepareOutput:async result=>{
          const catalogPath=path.join(staging,'workbook.json');if(result.catalog_path!==catalogPath)throw failure('invalid_worker_output','Invalid catalog candidate');
          const workbook=JSON.parse(await fs.readFile(catalogPath,'utf8'));
          if(!validWorkbook(workbook,source))throw failure('invalid_worker_output','Invalid workbook catalog');
          return {output:{workbook},commit(){}};
        }})}));
      }
      if(req.method==='POST'&&route==='/api/imports') {
        noQuery();const b=await readJson(req);const xlsxBody=Object.hasOwn(b,'import_spec');exact(b,xlsxBody?['asset_id','side','import_spec']:['asset_id','side']);ids(b,['asset_id']);if(!['left','right'].includes(b.side))throw failure('invalid_request','Invalid side');
        const asset=session.getAsset(b.asset_id);
        if(xlsxBody) {
          if(!xlsxEnabled)throw failure('unsupported_format','XLSX import is not enabled',422);
          if(asset.kind!=='xlsx')throw failure('unsupported_format','XLSX asset required',422);
          const spec=b.import_spec;assertImportSpec(spec,{source:{sha256:spec?.source_sha256},sheets:[{sheet_id:spec?.sheet_id,selectable:true}]});
          if(spec.source_sha256!==asset.sha256)throw failure('xlsx_source_mismatch','Workbook source does not match upload',400,'xlsx');
          return accepted(startJob('import',{reservation:asset.bytes*3,prepare:async({staging})=>{
            const csv=path.join(staging,'canonical.csv'),profile=path.join(staging,'profile.json'),adapterManifest=path.join(staging,'adapter.json');
            return {task:{payload:{format:'xlsx',asset_id:asset.asset_id,side:b.side,import_spec:spec},paths:{xlsx:asset.path,csv,profile,adapter_manifest:adapterManifest,staging}},prepareOutput:async o=>{
              if(o.csv_path!==csv||o.profile_path!==profile||o.adapter_manifest_path!==adapterManifest)throw failure('invalid_worker_output','Invalid XLSX import candidate');
              const [csvStat,profileBytes,manifestBytes]=await Promise.all([fs.stat(csv),fs.readFile(profile),fs.readFile(adapterManifest)]);
              if(!csvStat.isFile()||csvStat.size>XLSX_LIMITS.csv_bytes||profileBytes.length>1048576||manifestBytes.length>1048576)throw failure('xlsx_limit_exceeded','Converted material exceeds its limit',413,'xlsx');
              const profileDoc=JSON.parse(profileBytes.toString('utf8')),manifest=JSON.parse(manifestBytes.toString('utf8'));
              const [profileHash,manifestHash,csvHash]=await Promise.all([sha256(profile),sha256(adapterManifest),sha256(csv)]);
              const mapping=manifest?.row_mapping,counts=manifest?.conversion_counts,worksheet=manifest?.worksheet;
              const rectangleCells=(spec.last_row-spec.header_row)*(spec.column_end-spec.column_start+1);
              const validManifest=keySet(manifest,['schema_version','adapter_id','adapter_version','profile','source','canonical_csv','worksheet','row_mapping','warnings','conversion_counts'])&&
                keySet(manifest.profile,['bytes','sha256'])&&keySet(manifest.source,['bytes','sha256'])&&keySet(manifest.canonical_csv,['bytes','sha256'])&&
                keySet(worksheet,['sheet_id','name','relationship_id','part','date_system'])&&keySet(mapping,['kind','header_row','data_first_row','row_count','column_start','column_end'])&&
                keySet(counts,['blank','text','numeric_lexemes','expanded_exponents','booleans','dates','zero_padded_identifiers'])&&Array.isArray(manifest.warnings)&&
                manifest.warnings.every(item=>keySet(item,['code','count'])&&['hidden_rows_included','filtered_rows_included','outside_range_value_cells','outside_range_merges','rich_text_formatting_ignored'].includes(item.code)&&integer(item.count,1,1000000))&&
                Object.values(counts).every(value=>integer(value,0,rectangleCells))&&counts.blank+counts.text+counts.numeric_lexemes+counts.booleans+counts.dates+counts.zero_padded_identifiers===rectangleCells&&counts.expanded_exponents<=counts.numeric_lexemes&&
                manifest.schema_version===1&&manifest.adapter_id==='restricted-ooxml'&&manifest.adapter_version==='1.0.0'&&
                worksheet.sheet_id===spec.sheet_id&&typeof worksheet.name==='string'&&typeof worksheet.relationship_id==='string'&&typeof worksheet.part==='string'&&['1900','1904'].includes(worksheet.date_system)&&
                mapping.kind==='rectangle'&&mapping.header_row===spec.header_row&&mapping.data_first_row===spec.header_row+1&&mapping.row_count===o.preview.row_count&&mapping.row_count===spec.last_row-spec.header_row&&mapping.column_start===spec.column_start&&mapping.column_end===spec.column_end&&
                manifest.profile.sha256===profileHash&&manifest.profile.bytes===profileBytes.length&&manifest.source.sha256===asset.sha256&&manifest.source.bytes===asset.bytes&&manifest.canonical_csv.sha256===csvHash&&manifest.canonical_csv.bytes===csvStat.size;
              if(!keySet(profileDoc,['schema_version','adapter_id','adapter_version','import_spec'])||profileDoc.schema_version!==1||profileDoc.adapter_id!=='restricted-ooxml'||profileDoc.adapter_version!=='1.0.0'||canonicalJsonStringify(profileDoc.import_spec)!==canonicalJsonStringify(spec)||!validManifest)throw failure('invalid_worker_output','XLSX source or material hash changed');
              const canonical=await session.prepareAsset('csv','canonical.csv',csv);
              if(canonical.sha256!==csvHash||canonical.bytes!==csvStat.size)throw failure('invalid_worker_output','Canonical CSV hash changed');
              const adapter={adapter_id:'restricted-ooxml',adapter_version:'1.0.0',profile_schema_version:1,profile_sha256:profileHash,import_manifest_sha256:manifestHash,source_sha256:asset.sha256,canonical_csv_sha256:csvHash};
              const entry={import_id:randomUUID(),asset_id:asset.asset_id,side:b.side,format:'xlsx',status:'ready',headers:o.preview.headers,row_count:o.preview.row_count,column_count:o.preview.column_count,sha256:csvHash,adapter,canonical_asset_id:canonical.asset_id,path:canonical.path,source_path:asset.path,profile_path:profile,adapter_manifest_path:adapterManifest};
              session.checkImportBatch({newAssets:[canonical],newImport:entry});
              return {output:{import:project('import',entry),preview:o.preview},commit:()=>session.commitImportBatch({newAssets:[canonical],newImport:entry})};
            }};
          }}));
        }
        if(asset.kind!=='csv')throw failure('unsupported_format','CSV asset required',422);
        return accepted(startJob('import',{prepare:async()=>({task:{payload:{side:b.side,offset:0,limit:20},paths:{csv:asset.path}},prepareOutput:async o=>{
          const entry=importEntry(asset,b.side,o.preview);if(session.imports.size>=limits.imports)throw failure('quota_exceeded','Import count quota exceeded',413);
          return {output:{import:project('import',entry),preview:o.preview},commit:()=>session.commitImport(entry)};
        }})}));
      }
      const importMetadata=route.match(/^\/api\/imports\/([^/]+)$/);
      if(req.method==='GET'&&importMetadata){noQuery();const entry=session.getImport(importMetadata[1]);return reply(200,{ok:true,import:project('import',entry),asset:project('asset',session.getAsset(entry.asset_id))});}
      const importMaterials=route.match(/^\/api\/imports\/([^/]+)\/materials\/export$/);
      if(req.method==='GET'&&importMaterials){const entry=session.getImport(importMaterials[1]),kind=url.searchParams.get('kind');if(url.searchParams.size!==1||!['profile','manifest'].includes(kind))throw failure('invalid_request','Invalid material kind');if(entry.format!=='xlsx')throw failure('not_found','Import materials not found',404);return await stream(kind==='profile'?entry.profile_path:entry.adapter_manifest_path,'application/json',kind==='profile'?'profile.json':'adapter.json');}
      const im=route.match(/^\/api\/imports\/([^/]+)\/(preview|cell)$/);
      if(req.method==='POST'&&im) {
        noQuery();const imp=session.getImport(im[1]),b=await readJson(req);if(im[2]==='preview')page(b);else cell(b);
        return accepted(startJob(im[2],{task:{payload:{side:imp.side,...b},paths:{csv:imp.path}}}));
      }
      const importSourceCell=route.match(/^\/api\/imports\/([^/]+)\/source-cell$/);
      if(req.method==='POST'&&importSourceCell){noQuery();const imp=session.getImport(importSourceCell[1]),b=await readJson(req);cell(b);if(imp.format!=='xlsx')throw failure('unsupported_format','Source cells require an XLSX import',422);const source=session.getAsset(imp.asset_id),canonical=session.getAsset(imp.canonical_asset_id);return accepted(startJob('source_cell',{prepare:async({staging})=>({task:{payload:{side:imp.side,record:b.record,column:b.column},paths:{xlsx:source.path,csv:canonical.path,profile:imp.profile_path,staging}},prepareOutput:async result=>({output:result})})}));}
      const revisionSourceCell=route.match(/^\/api\/runs\/([^/]+)\/source-cell$/);
      if(req.method==='POST'&&revisionSourceCell){noQuery();const revision=session.getRevision(revisionSourceCell[1]),b=await readJson(req);cell(b,true);const importId=b.side==='left'?revision.left_import_id:revision.right_import_id,imp=session.getImport(importId);if(imp.format!=='xlsx')throw failure('unsupported_format','Source cells require an XLSX import',422);const source=session.getAsset(imp.asset_id),canonical=session.getAsset(imp.canonical_asset_id);return accepted(startJob('source_cell',{prepare:async({staging})=>({task:{payload:{side:imp.side,record:b.record,column:b.column},paths:{xlsx:source.path,csv:canonical.path,profile:imp.profile_path,staging}},prepareOutput:async result=>({output:result})})}));}
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
        return accepted(startJob('example',{reservation:reserve*2,prepare:async({staging})=>{
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
        const reserve=canonicalBytes(left)+canonicalBytes(right)+config.bytes;
        return accepted(startJob('compare',{reservation:reserve,prepare:async({staging})=>{
          const run=path.join(staging,'run');return {task:{payload:{},paths:{left:left.path,right:right.path,config:config.path,run}},prepareOutput:async o=>{
            if(o.run_path!==run||![0,1,3].includes(o.exit_code))throw failure('invalid_worker_output','Invalid comparison candidate');
            const revision=await session.prepareRevision({runPath:run,left_import_id:left.import_id,right_import_id:right.import_id,config_asset_id:config.asset_id});
            if(revision.exit_code!==o.exit_code)throw failure('invalid_worker_output','Result exit code mismatch');
            return {output:{revision:project('revision',revision)},commit:()=>session.commitRevision(revision)};
          }};
        }}));
      }
      const bundleCreate=route.match(/^\/api\/runs\/([^/]+)\/bundle$/);
      if(req.method==='POST'&&bundleCreate) {
        noQuery();exact(await readJson(req),[]);const revision=session.getRevision(bundleCreate[1]);
        const metadata=[];let reservation=0;
        for(const name of RUN_BUNDLE_FILES) {
          const file=path.join(revision.path,name),stat=await fs.stat(file);reservation+=stat.size;
          metadata.push({path:`run/${name}`,bytes:stat.size,sha256:await session.hashFile(file)});
        }
        const registeredMaterials=[];
        for(const side of ['left','right']){
          const entry=session.getImport(side==='left'?revision.left_import_id:revision.right_import_id);
          if(entry.format==='xlsx'){
            for(const file of [entry.source_path,entry.profile_path,entry.adapter_manifest_path])reservation+=(await fs.stat(file)).size;
            registeredMaterials.push({side,format:'xlsx',sourcePath:entry.source_path,profilePath:entry.profile_path,adapterManifestPath:entry.adapter_manifest_path});
          }else registeredMaterials.push({side,format:'csv',sourcePath:path.join(revision.path,'input',`${side}.csv`)});
        }
        const sidecar={schema_version:1,app_version:APP_VERSION,engine_version:'0.1.0',revision:{revision_id:revision.revision_id,parent_revision_id:revision.parent_revision_id,baseline_revision_id:revision.baseline_revision_id,run_id:revision.run_id,report_sha256:revision.report_sha256,decisions_sha256:revision.decisions_sha256},files:metadata};
        return accepted(startJob('bundle',{reservation,prepare:async({staging})=>{
          const sidecarPath=path.join(staging,'workbench.json'),bundlePath=path.join(staging,'bundle.zip');
          await fs.writeFile(sidecarPath,JSON.stringify(sidecar)+'\n',{mode:0o600,flag:'wx'});
          const xlsxPresent=registeredMaterials.some(item=>item.format==='xlsx');
          const importMaterials=xlsxPresent?{manifestPath:path.join(staging,'import','manifest.json'),sides:registeredMaterials}:null;
          if(importMaterials)await fs.mkdir(path.dirname(importMaterials.manifestPath),{recursive:true,mode:0o700});
          return {task:{payload:{limits:{zip_bytes:limits.zip_bytes,unzip_bytes:limits.unzip_bytes,zip_entries:limits.zip_entries}},paths:{run:revision.path,sidecar:sidecarPath,bundle:bundlePath,importMaterials}},prepareOutput:async result=>{
            if(result.bundle_path!==bundlePath||!Number.isSafeInteger(result.bytes)||result.bytes<1||! /^[0-9a-f]{64}$/.test(result.sha256))throw failure('invalid_worker_output','Invalid bundle candidate');
            const asset=await session.prepareAsset('run','moonreconcile-bundle.zip',bundlePath);
            if(asset.bytes!==result.bytes||asset.sha256!==result.sha256)throw failure('invalid_worker_output','Bundle hash or byte count changed');
            return {output:{bundle_asset_id:asset.asset_id},commit:()=>{session.commitAsset(asset);bundles.add(asset.asset_id);}};
          }};
        }}));
      }
      const bundleExport=route.match(/^\/api\/bundles\/([^/]+)\/export$/);
      if(req.method==='GET'&&bundleExport) {
        noQuery();const asset=session.getAsset(bundleExport[1]);if(asset.kind!=='run'||!bundles.has(asset.asset_id))throw failure('not_found','Completed bundle not found',404);
        return await stream(asset.path,'application/zip','moonreconcile-bundle.zip');
      }
      if(req.method==='POST'&&route==='/api/restores') {
        noQuery();const body=await readJson(req);exact(body,['asset_id']);ids(body,['asset_id']);const source=session.getAsset(body.asset_id);
        if(source.kind!=='run')throw failure('invalid_request','Run ZIP asset required');
        return accepted(startJob('restore',{reservation:source.bytes,prepare:async({staging})=>{
          const restorePath=path.join(staging,'restore');
          return {task:{payload:{limits:{zip_bytes:limits.zip_bytes,unzip_bytes:limits.unzip_bytes,zip_entries:limits.zip_entries},xlsxEnabled,xlsxLimits:XLSX_LIMITS},paths:{bundle:source.path,restore:restorePath}},prepareOutput:async result=>{
            const replayPath=path.join(restorePath,'replayed-run');
            if(result.run_path!==replayPath||![0,1,3].includes(result.exit_code)||!result.left_preview||!result.right_preview)throw failure('invalid_worker_output','Invalid restore candidate');
            const restored=result.restored_imports;
            if((result.sidecar.schema_version===2)!==Boolean(restored))throw failure('invalid_worker_output','Restore version metadata mismatch');
            const newAssets=[],newImports=[];
            for(const side of ['left','right']){
              const item=restored?.[side];
              if(item&&item.format==='xlsx'){
                const sourceAsset=await session.prepareAsset('xlsx',`restored-${side}.xlsx`,item.source_path);
                const canonical=await session.prepareAsset('csv',`restored-${side}.csv`,path.join(replayPath,'input',`${side}.csv`));
                const profileBytes=await fs.readFile(item.profile_path),manifestBytes=await fs.readFile(item.adapter_manifest_path);
                const adapterManifest=JSON.parse(manifestBytes.toString('utf8'));
                await Promise.all([session.owned(item.profile_path),session.owned(item.adapter_manifest_path)]);
                if(sourceAsset.sha256!==adapterManifest.source.sha256||canonical.sha256!==adapterManifest.canonical_csv.sha256||profileBytes.length!==adapterManifest.profile.bytes||createHash('sha256').update(profileBytes).digest('hex')!==adapterManifest.profile.sha256)throw failure('xlsx_conversion_mismatch','Restored XLSX material hashes changed');
                newAssets.push(sourceAsset,canonical);
                const adapter={adapter_id:'restricted-ooxml',adapter_version:'1.0.0',profile_schema_version:1,profile_sha256:adapterManifest.profile.sha256,import_manifest_sha256:createHash('sha256').update(manifestBytes).digest('hex'),source_sha256:sourceAsset.sha256,canonical_csv_sha256:canonical.sha256};
                newImports.push({import_id:randomUUID(),asset_id:sourceAsset.asset_id,side,format:'xlsx',status:'ready',headers:item.preview.headers,row_count:item.preview.row_count,column_count:item.preview.column_count,sha256:canonical.sha256,adapter,canonical_asset_id:canonical.asset_id,path:canonical.path,source_path:sourceAsset.path,profile_path:item.profile_path,adapter_manifest_path:item.adapter_manifest_path});
              }else{
                const asset=await session.prepareAsset('csv',`restored-${side}.csv`,path.join(replayPath,'input',`${side}.csv`));newAssets.push(asset);newImports.push(importEntry(asset,side,side==='left'?result.left_preview:result.right_preview));
              }
            }
            const configAsset=await session.prepareAsset('config','restored-config.json',path.join(replayPath,'config.json'));
            newAssets.push(configAsset);
            const left=newImports.find(entry=>entry.side==='left'),right=newImports.find(entry=>entry.side==='right');
            const revision=await session.prepareRevision({runPath:replayPath,left_import_id:left.import_id,right_import_id:right.import_id,config_asset_id:configAsset.asset_id,prospectiveAssets:newAssets,prospectiveImports:newImports});
            if(revision.exit_code!==result.exit_code)throw failure('invalid_worker_output','Restored result exit code mismatch');
            session.checkRestoreCapacity({newAssets,newImports,revision});
            return {output:{revision:project('revision',revision)},commit:()=>session.commitRestored({newAssets,newImports,configAssetId:configAsset.asset_id,revision})};
          }};
        }}));
      }
      const reviews=route.match(/^\/api\/runs\/([^/]+)\/reviews$/);
      if(req.method==='POST'&&reviews) {
        noQuery();const b=await readJson(req);exact(b,['base_revision','decisions_asset_id']);ids(b,['base_revision','decisions_asset_id']);
        const parent=session.getRevision(reviews[1]);
        if(b.base_revision!==parent.revision_id||session.heads.get(parent.baseline_revision_id)!==parent.revision_id)throw failure('stale_revision','Review base is not the current branch head',409);
        const decisionAsset=session.getAsset(b.decisions_asset_id);if(decisionAsset.kind!=='decisions')throw failure('invalid_request','Decision asset required');
        const baseline=session.getRevision(parent.baseline_revision_id);
        const left=session.getImport(baseline.left_import_id),right=session.getImport(baseline.right_import_id),config=session.getAsset(baseline.config_asset_id);
        const reservation=canonicalBytes(left)+canonicalBytes(right)+config.bytes+decisionAsset.bytes;
        return accepted(startJob('review',{reservation,prepare:async({staging})=>{
          const run=path.join(staging,'run');return {task:{payload:{},paths:{baseline:baseline.path,decisions:decisionAsset.path,run}},prepareOutput:async o=>{
            if(o.run_path!==run||![0,1,3].includes(o.exit_code))throw failure('invalid_worker_output','Invalid review candidate');
            const parentResult=JSON.parse(await fs.readFile(path.join(parent.path,'report.json'),'utf8'));
            const candidate=JSON.parse(await fs.readFile(path.join(run,'report.json'),'utf8'));
            assertCumulativeDecisions(parentResult.decisions,candidate.decisions);
            const revision=await session.prepareRevision({runPath:run,left_import_id:baseline.left_import_id,right_import_id:baseline.right_import_id,config_asset_id:baseline.config_asset_id,parent_revision_id:parent.revision_id,baseline_revision_id:baseline.revision_id});
            if(revision.exit_code!==o.exit_code)throw failure('invalid_worker_output','Result exit code mismatch');
            return {output:{revision:project('revision',revision)},commit:()=>session.commitRevision(revision)};
          }};
        }}));
      }
      const branch=route.match(/^\/api\/runs\/([^/]+)\/branch$/);
      if(req.method==='POST'&&branch) {
        noQuery();exact(await readJson(req),[]);const parent=session.getRevision(branch[1]);
        if(session.heads.get(parent.baseline_revision_id)!==parent.revision_id)throw failure('stale_revision','Branch source is not the current branch head',409);
        const baseline=session.getRevision(parent.baseline_revision_id),left=session.getImport(baseline.left_import_id),right=session.getImport(baseline.right_import_id),config=session.getAsset(baseline.config_asset_id);
        const reservation=canonicalBytes(left)+canonicalBytes(right)+config.bytes;
        return accepted(startJob('branch',{reservation,prepare:async({staging})=>{
          const run=path.join(staging,'run');return {task:{payload:{},paths:{left:path.join(baseline.path,'input/left.csv'),right:path.join(baseline.path,'input/right.csv'),config:path.join(baseline.path,'config.json'),run}},prepareOutput:async o=>{
            if(o.run_path!==run||![0,1,3].includes(o.exit_code))throw failure('invalid_worker_output','Invalid branch candidate');
            const revision=await session.prepareRevision({runPath:run,left_import_id:baseline.left_import_id,right_import_id:baseline.right_import_id,config_asset_id:baseline.config_asset_id});
            if(revision.exit_code!==o.exit_code)throw failure('invalid_worker_output','Result exit code mismatch');
            return {output:{revision:project('revision',revision)},commit:()=>{if(session.heads.get(parent.baseline_revision_id)!==parent.revision_id)throw failure('stale_revision','Branch source head changed',409);session.commitRevision(revision);}};
          }};
        }}));
      }
      const jm=route.match(/^\/api\/jobs\/([^/]+)$/);
      if(jm&&['GET','DELETE'].includes(req.method)) {noQuery();if(!isId(jm[1]))throw failure('invalid_request','Invalid identifier');return reply(200,{ok:true,job:project('job',req.method==='DELETE'?await jobs.cancel(jm[1]):jobs.get(jm[1]))});}
      const summary=route.match(/^\/api\/runs\/([^/]+)\/summary$/);
      if(req.method==='GET'&&summary) {
        noQuery();const revision=session.getRevision(summary[1]);const result=JSON.parse(await fs.readFile(path.join(revision.path,'report.json'),'utf8'));
        const output={ok:true,revision:project('revision',revision),computation:result.computation,summary:result.summary,structure:result.structure,issues:result.key_issues};
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
        noQuery();const revision=session.getRevision(runCell[1]),b=await readJson(req);cell(b,true);const csv=path.join(revision.path,'input',b.side+'.csv');return accepted(startJob('cell',{task:{payload:b,paths:{csv}}}));
      }
      if(req.method==='POST'&&route==='/api/sessions/reset') {
        noQuery();const b=await readJson(req);exact(b,['confirm']);if(b.confirm!==true)throw failure('invalid_request','Explicit reset confirmation required');
        if(jobs.active||uploads.size)throw failure('session_busy','Active uploads or tasks prevent reset',409);
        if(closing)throw failure('session_closed','Session is closing',409);
        await jobs.reset();bundles.clear();return reply(200,{ok:true});
      }
      return reply(404,{ok:false,error:errorDto('not_found','Route not found')});
    }catch(e){
      if(e.code==='request_too_large'){
        // Discard, never buffer, the remainder while the 413 is flushed. The
        // response closes this connection; shutdown still aborts all sockets.
        req.resume();res.setHeader('Connection','close');
      }
      reply(e.status??400,{ok:false,error:sanitizeError(e,[session.root])});
    }
    finally{requests.delete(state);finish();}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(e){await jobs.close();await session.close();throw e;}
  origin=`http://127.0.0.1:${server.address().port}`;
  let closePromise;
  const close=()=>closePromise??=(async()=>{
    closing=true;
    const stopped=new Promise(resolve=>server.close(resolve));
    server.closeAllConnections();
    for(const request of requests)request.req.destroy();
    for(const u of uploads){u.cause=failure('upload_aborted','Server is closing',409);u.req.destroy();}
    await Promise.all([...requests].map(request=>request.done));
    await Promise.all([...uploads].map(u=>u.done));await jobs.close();
    await stopped;await session.close();
  })();
  return {origin,token,session,jobs,close};
}
