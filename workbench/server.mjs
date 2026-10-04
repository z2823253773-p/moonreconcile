import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSession } from './session.mjs';
import { createJobManager } from './jobs.mjs';
import { APP_VERSION, API_VERSION, HOST_LIMITS, errorDto } from './contracts.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const JSON_TYPE='application/json; charset=utf-8';
function safeJob(j){return {job_id:j.job_id,kind:j.kind,state:j.state,phase:j.phase,output:j.output??null,error:j.error??null};}
function dtoError(code,message,phase='host'){return {ok:false,error:errorDto(code,message,phase)};}
export async function startWorkbench({bridgePath,rootParent,limits={}}={}) {
  const session=await createSession({rootParent,limits});const token=randomBytes(32).toString('hex');
  const jobs=await createJobManager({session,bridgePath,limits:{jobTimeoutMs:limits.job_ms??HOST_LIMITS.job_ms,killMs:limits.kill_ms??HOST_LIMITS.kill_ms,jobs:limits.jobs??HOST_LIMITS.jobs}});
  const boundConfigs=new Map();let uploadActive=false, origin;
  const server=http.createServer(async(req,res)=>{
    const headers={'Content-Type':JSON_TYPE,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
    const reply=(status,body,extra={})=>{res.writeHead(status,{...headers,...extra});res.end(JSON.stringify(body));};
    try {
      if(req.headers.host!==new URL(origin).host)return reply(403,dtoError('forbidden','invalid Host'));
      const isApi=req.url?.startsWith('/api/');
      if(!isApi){res.writeHead(404,headers);res.end('Not found');return;}
      const supplied=req.headers.authorization===`Bearer ${token}`;
      if(!supplied)return reply(401,dtoError('unauthorized','Bearer token required'));
      if(req.headers.origin&&req.headers.origin!==origin)return reply(403,dtoError('forbidden','cross-origin request rejected'));
      const fetchSite=req.headers['sec-fetch-site'];if(fetchSite&&fetchSite!=='same-origin'&&!req.headers.origin)return reply(403,dtoError('forbidden','cross-site request rejected'));
      const url=new URL(req.url,origin), route=url.pathname;
      const readJson=async()=>{let parts=[],size=0;for await(const c of req){size+=c.length;if(size>(limits.request_bytes??HOST_LIMITS.request_bytes))throw Object.assign(new Error('request too large'),{status:413,code:'request_too_large'});parts.push(c);}const b=Buffer.concat(parts);let v;try{v=JSON.parse(b.toString('utf8'));}catch{throw Object.assign(new Error('invalid JSON body'),{status:400,code:'invalid_request'});}if(!v||Array.isArray(v)||typeof v!=='object')throw Object.assign(new Error('JSON object required'),{status:400,code:'invalid_request'});return v;};
      const exact=(obj,keys)=>{if(Object.keys(obj).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(obj,k)))throw Object.assign(new Error('unexpected or missing property'),{status:400,code:'invalid_request'});};
      const makeTask=(kind,payload,paths,commit)=>jobs.start(kind,{task:{kind,payload,paths,bridge_path:bridgePath},commit});
      if(req.method==='GET'&&route==='/api/capabilities')return reply(200,{ok:true,app_version:APP_VERSION,api_version:API_VERSION,engine_version:'0.1.0',formats:['csv'],limits:{...HOST_LIMITS,...limits}});
      if(req.method==='POST'&&route==='/api/assets'){
        if(uploadActive)throw Object.assign(new Error('upload busy'),{status:409,code:'upload_busy'});uploadActive=true;
        try{const kind=url.searchParams.get('kind');if(!['csv','config','decisions','run'].includes(kind)||url.searchParams.size!==1)throw Object.assign(new Error('invalid asset kind'),{status:400,code:'invalid_request'});if(!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type']??''))throw Object.assign(new Error('application/octet-stream required'),{status:400,code:'invalid_request'});let filename='upload';try{filename=decodeURIComponent(req.headers['x-filename']??'upload');}catch{throw Object.assign(new Error('invalid filename'),{status:400,code:'invalid_request'});}if([...filename].length>255)throw Object.assign(new Error('filename too long'),{status:400,code:'invalid_request'});const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>(limits.asset_bytes??67108864))throw Object.assign(new Error('asset limit exceeded'),{status:413,code:'quota_exceeded'});chunks.push(c);}const asset=await session.saveAsset(kind,filename,Buffer.concat(chunks));return reply(201,{ok:true,asset:{asset_id:asset.asset_id,kind:asset.kind,name:asset.name,bytes:asset.bytes,sha256:asset.sha256}});}finally{uploadActive=false;}
      }
      if(req.method==='POST'&&route==='/api/imports'){
        const b=await readJson();exact(b,['asset_id','side']);if(!['left','right'].includes(b.side))throw Object.assign(new Error('invalid side'),{status:400,code:'invalid_request'});const a=session.getAsset(b.asset_id);if(a.kind!=='csv')throw Object.assign(new Error('unsupported format'),{status:422,code:'unsupported_format'});
        const dir=path.join(session.root,randomUUID());await fs.mkdir(dir,{mode:0o700});const csv=path.join(dir,'input.csv');const output=path.join(dir,'result.json');await fs.copyFile(a.path,csv);
        const j=makeTask('import',{side:b.side,offset:0,limit:20},{csv},o=>{const p=o.preview, imp={import_id:randomUUID(),asset_id:a.asset_id,side:b.side,format:'csv',status:'ready',headers:p.headers,row_count:p.row_count,column_count:p.column_count,sha256:a.sha256,path:csv};session.registerImport(imp);return {import:projectImport(imp),preview:p};});return reply(202,{ok:true,job_id:j.job_id});
      }
      const im=route.match(/^\/api\/imports\/([0-9a-f-]+)\/(preview|cell)$/i);
      if(req.method==='POST'&&im){const imp=session.getImport(im[1]),b=await readJson();let payload,kind;if(im[2]==='preview'){exact(b,['offset','limit']);if(!Number.isInteger(b.offset)||b.offset<0||!Number.isInteger(b.limit)||b.limit<1||b.limit>100)throw Object.assign(new Error('invalid pagination'),{status:400,code:'invalid_request'});payload={side:imp.side,...b};kind='preview';}else{exact(b,['record','column']);payload={side:imp.side,...b};kind='cell';}const dir=path.join(session.root,randomUUID());await fs.mkdir(dir,{mode:0o700});return reply(202,{ok:true,job_id:makeTask(kind,payload,{csv:imp.path}).job_id});}
      if(req.method==='POST'&&route==='/api/config/draft'){
        const b=await readJson();exact(b,['left_import_id','right_import_id']);const l=session.getImport(b.left_import_id),r=session.getImport(b.right_import_id);if(l.side!=='left'||r.side!=='right')throw Object.assign(new Error('import sides must be left/right'),{status:400,code:'invalid_request'});const dir=path.join(session.root,randomUUID());await fs.mkdir(dir,{mode:0o700});const cfg=path.join(dir,'config.json');const j=makeTask('draft',{},{left:l.path,right:r.path,config:cfg},async o=>{const asset=await session.saveAsset('config','draft.json',await fs.readFile(o.config_path));boundConfigs.set(asset.asset_id,[l.import_id,r.import_id]);return {config_asset_id:asset.asset_id,draft:true};});return reply(202,{ok:true,job_id:j.job_id});
      }
      if(req.method==='POST'&&route==='/api/config/check'){
        const b=await readJson();if(Object.keys(b).some(k=>!['left_import_id','right_import_id','config','config_asset_id'].includes(k))||!Object.hasOwn(b,'left_import_id')||!Object.hasOwn(b,'right_import_id')||('config'in b)==('config_asset_id'in b))throw Object.assign(new Error('invalid schema'),{status:400,code:'invalid_request'});const l=session.getImport(b.left_import_id),r=session.getImport(b.right_import_id);if(l.side!=='left'||r.side!=='right')throw Object.assign(new Error('import sides must be left/right'),{status:400,code:'invalid_request'});let source;if(b.config_asset_id){const a=session.getAsset(b.config_asset_id);if(a.kind!=='config')throw Object.assign(new Error('config asset required'),{status:400,code:'invalid_request'});source=a.path;}else {const a=await session.saveAsset('config','config-input.json',JSON.stringify(b.config));source=a.path;}
        const dir=path.join(session.root,randomUUID());await fs.mkdir(dir,{mode:0o700});const cfg=path.join(dir,'checked.json');const j=makeTask('check',{},{configInput:source,config:cfg},async o=>{const asset=await session.saveAsset('config','config.json',await fs.readFile(o.config_path));boundConfigs.set(asset.asset_id,[l.import_id,r.import_id]);return {config_asset_id:asset.asset_id,draft:false};});return reply(202,{ok:true,job_id:j.job_id});
      }
      if(req.method==='POST'&&route==='/api/runs'){
        const b=await readJson();exact(b,['left_import_id','right_import_id','config_asset_id']);const l=session.getImport(b.left_import_id),r=session.getImport(b.right_import_id),c=session.getAsset(b.config_asset_id);if(c.kind!=='config'||JSON.stringify(boundConfigs.get(c.asset_id))!==JSON.stringify([l.import_id,r.import_id]))throw Object.assign(new Error('validated config is not bound to these imports'),{status:409,code:'config_binding_mismatch'});const dir=path.join(session.root,randomUUID());await fs.mkdir(dir,{mode:0o700});const cfg=path.join(dir,'config.json'),out=path.join(dir,'run');await fs.copyFile(c.path,cfg);const j=makeTask('compare',{},{left:l.path,right:r.path,config:cfg,run:out},async o=>({revision:await session.publishRevision({runPath:o.run_path,left_import_id:l.import_id,right_import_id:r.import_id,config_asset_id:c.asset_id})}));return reply(202,{ok:true,job_id:j.job_id});
      }
      const jm=route.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);if(jm&&req.method==='GET')return reply(200,{ok:true,job:safeJob(jobs.get(jm[1]))});if(jm&&req.method==='DELETE')return reply(200,{ok:true,job:safeJob(await jobs.cancel(jm[1]))});
      return reply(404,dtoError('not_found','route not found'));
    }catch(e){reply(e.status??400,dtoError(e.code??'invalid_request',e.message??'request failed'));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const addr=server.address();origin=`http://127.0.0.1:${addr.port}`;
  let closed=false;
  return {origin,token,session,jobs,close:async()=>{if(closed)return;closed=true;await jobs.close();await new Promise(resolve=>server.close(resolve));await session.close();}};
}
function projectImport(i){return {import_id:i.import_id,asset_id:i.asset_id,side:i.side,format:i.format,status:i.status,headers:i.headers,row_count:i.row_count,column_count:i.column_count,sha256:i.sha256};}
