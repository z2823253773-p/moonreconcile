import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWorkbench } from '../workbench/server.mjs';

test('server exposes capability and enforces token/origin/host', async (t) => {
  const app = await startWorkbench({ rootParent: undefined });
  t.after(() => app.close());
  const noToken = await fetch(`${app.origin}/api/capabilities`);
  assert.equal(noToken.status, 401);
  const caps = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}` } });
  assert.equal(caps.status, 200);
  assert.deepEqual((await caps.json()).formats, ['csv']);
  const cross = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}`, origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  const address = new URL(app.origin);
  const badHost = await new Promise((resolve, reject) => http.get({ hostname: address.hostname, port: address.port, path: '/api/capabilities', headers: { authorization: `Bearer ${app.token}`, host: '127.0.0.1:1', 'x-forwarded-host': address.host } }, response => { response.resume(); resolve(response); }).on('error', reject));
  assert.equal(badHost.statusCode, 403);
  const noOrigin = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}`, 'x-forwarded-host': 'evil.example' } });
  assert.equal(noOrigin.status, 200);
});

test('asset upload enforces raw byte limit before publishing', async (t) => {
  const app = await startWorkbench({ limits: { asset_bytes: 4 } });
  t.after(() => app.close());
  const r = await fetch(`${app.origin}/api/assets?kind=csv`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/octet-stream' }, body: '12345' });
  assert.equal(r.status, 413);
  assert.equal(app.session.assets.size, 0);
});

test('real examples, draft/check binding, exports, summary, collections, cells and reset',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const api=async(route,body)=>{const r=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const job=async(route,body)=>{const q=await api(route,body);assert.equal(q.status,202);let j;for(let n=0;n<200;n++){j=(await api('/api/jobs/'+q.body.job_id)).body.job;if(!['running','cancelling'].includes(j.state))break;await new Promise(r=>setTimeout(r,20));}assert.equal(j.state,'succeeded',JSON.stringify(j.error));return j.output;};
  const ex=await job('/api/examples/orders',{});assert.ok(ex.source_label);
  const draft=await job('/api/config/draft',ex?{left_import_id:ex.left_import_id,right_import_id:ex.right_import_id}:{});assert.equal(draft.draft,true);
  assert.equal((await api('/api/runs',{...ex,source_label:undefined,config_asset_id:draft.config_asset_id})).status,409);
  const out=await job('/api/runs',{left_import_id:ex.left_import_id,right_import_id:ex.right_import_id,config_asset_id:ex.config_asset_id});assert.equal(out.revision.exit_code,1);assert.equal('path' in out.revision,false);
  const id=out.revision.revision_id;const summary=await api('/api/runs/'+id+'/summary');assert.equal(summary.status,200);assert.ok(summary.body.structure);
  const fields=await api('/api/runs/'+id+'/fields?offset=0&limit=1');assert.equal(fields.body.items[0].source_index,0);assert.ok(fields.body.items[0].item.field);
  assert.equal((await fetch(app.origin+'/api/runs/'+id+'/items/fields/0/export',{headers})).status,200);
  assert.equal((await fetch(app.origin+'/api/configs/'+ex.config_asset_id+'/export',{headers})).status,200);
  const cell=await job('/api/runs/'+id+'/cell',{side:'left',record:1,column:'order_id'});assert.equal(cell.cell.truncated,false);
  assert.equal((await api('/api/runs/'+id+'/fields?path=/tmp')).status,400);
  assert.equal((await api('/api/imports/'+ex.left_import_id+'/preview',{offset:2147483648,limit:1})).status,400);
  assert.equal((await api('/api/sessions/reset',{confirm:true})).status,200);assert.equal(app.session.revisions.size,0);
});
test('rejects_stream_over_limit_without_length and disconnect_leaves_no_asset',async t=>{
  const app=await startWorkbench({limits:{asset_bytes:8,upload_ms:150}});t.after(()=>app.close());const u=new URL(app.origin);
  const request=()=>http.request({hostname:u.hostname,port:u.port,path:'/api/assets?kind=csv',method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream'}});
  const over=request();const result=new Promise((r,j)=>{over.on('response',s=>{s.resume();r(s.statusCode);});over.on('error',j);});over.write('12345');over.end('6789');assert.equal(await result,413);assert.equal(app.session.assets.size,0);
  const aborted=request();aborted.on('error',()=>{});aborted.write('x');await new Promise(r=>setTimeout(r,30));
  const reset=await fetch(app.origin+'/api/sessions/reset',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'},body:'{"confirm":true}'});assert.equal(reset.status,409);aborted.destroy();await new Promise(r=>setTimeout(r,100));assert.equal(app.session.assets.size,0);assert.equal(app.session.reservations.size,0);
});

// Use real core fixtures: 101 fully connected candidates hit its production
// component limit. Lower host limits below are fault injection, not throughput claims.
async function apiClient(app) {
  const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const request=async(route,body)=>{const r=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const terminal=async(id)=>{for(let i=0;i<400;i++){const j=(await request('/api/jobs/'+id)).body.job;if(!['running','cancelling'].includes(j.state))return j;await new Promise(r=>setTimeout(r,10));}throw Error('job wait timeout');};
  const start=async(route,body)=>{const r=await request(route,body);assert.equal(r.status,202,JSON.stringify(r.body));return terminal(r.body.job_id);};
  const upload=async(kind,data)=>{const r=await fetch(app.origin+'/api/assets?kind='+kind,{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream'},body:data});assert.equal(r.status,201);return (await r.json()).asset;};
  const imported=async(side,csv)=>{const asset=await upload('csv',csv),j=await start('/api/imports',{asset_id:asset.asset_id,side});assert.equal(j.state,'succeeded',JSON.stringify(j.error));return j.output.import.import_id;};
  return {request,start,terminal,upload,imported,headers};
}
test('0/1/3 have Result revisions; exit2 never publishes and previous hash remains',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const c=await apiClient(app);
  const config={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text'}],key:['id']};
  const li=await c.imported('left','id\n1\n'),ri=await c.imported('right','id\n1\n');
  const checked=await c.start('/api/config/check',{left_import_id:li,right_import_id:ri,config});assert.equal(checked.state,'succeeded');
  const zero=await c.start('/api/runs',{left_import_id:li,right_import_id:ri,config_asset_id:checked.output.config_asset_id});assert.equal(zero.output.revision.exit_code,0);
  const bad=await c.start('/api/config/check',{left_import_id:li,right_import_id:ri,config:{...config,fields:[{name:'id',left:'absent',right:'id',type:'text'}]}});assert.equal(bad.state,'succeeded');
  const error=await c.start('/api/runs',{left_import_id:li,right_import_id:ri,config_asset_id:bad.output.config_asset_id});assert.equal(error.state,'failed');assert.equal(error.output,null);assert.equal(app.session.revisions.size,1);
  assert.equal((await c.request('/api/runs/'+zero.output.revision.revision_id+'/summary')).body.revision.report_sha256,zero.output.revision.report_sha256);
  const many='id,label\n'+Array.from({length:101},(_,i)=>`${i},same\n`).join('');const ml=await c.imported('left',many),mr=await c.imported('right',many);
  const rules={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'label',left:'label',right:'label',type:'text'}],key:[],candidates:{fields:[{field:'label',metric:'exact',weight:10000}],threshold:10000}};
  const norm=await c.start('/api/config/check',{left_import_id:ml,right_import_id:mr,config:rules});const three=await c.start('/api/runs',{left_import_id:ml,right_import_id:mr,config_asset_id:norm.output.config_asset_id});assert.equal(three.output.revision.exit_code,3);
});
test('wide preview shrinks whole rows before Job publication; no half import fits',async t=>{
  const app=await startWorkbench({limits:{response_bytes:1900}});t.after(()=>app.close());const c=await apiClient(app);
  const csv='a,b\n'+Array.from({length:20},()=>('a'.repeat(160)+','+'b'.repeat(160)+'\n')).join('');const asset=await c.upload('csv',csv);
  const j=await c.start('/api/imports',{asset_id:asset.asset_id,side:'left'});assert.equal(j.state,'succeeded');assert.ok(j.output.preview.rows.length<20);assert.ok(j.output.preview.rows.length>0);assert.equal(j.output.preview.next_offset,j.output.preview.rows.length);assert.equal(j.output.preview.has_more,true);
  const page=await c.start('/api/imports/'+j.output.import.import_id+'/preview',{offset:j.output.preview.next_offset,limit:20});assert.equal(page.state,'succeeded');assert.ok(Buffer.byteLength(JSON.stringify({ok:true,job:page}))<=1900);
  const impossible=await startWorkbench({limits:{response_bytes:700}});t.after(()=>impossible.close());const x=await apiClient(impossible),a=await x.upload('csv',csv),failed=await x.start('/api/imports',{asset_id:a.asset_id,side:'left'});assert.equal(failed.state,'failed');assert.equal(failed.error.code,'response_limit_exceeded');assert.equal(impossible.session.imports.size,0);
});
test('oversize evidence item exposes full same-origin export and summary points to report',async t=>{
  const app=await startWorkbench({limits:{response_bytes:2200}});t.after(()=>app.close());const c=await apiClient(app);
  const li=await c.imported('left','id,value\n1,'+'x'.repeat(4000)+'\n'),ri=await c.imported('right','id,value\n1,'+'y'.repeat(4000)+'\n');
  const norm=await c.start('/api/config/check',{left_import_id:li,right_import_id:ri,config:{schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'value',left:'value',right:'value',type:'text'}],key:['id']}});
  const run=await c.start('/api/runs',{left_import_id:li,right_import_id:ri,config_asset_id:norm.output.config_asset_id}),id=run.output.revision.revision_id;
  const list=await c.request('/api/runs/'+id+'/fields');assert.equal(list.status,413);assert.match(list.body.error.message,new RegExp('/api/runs/'+id+'/items/fields/0/export'));
  const exported=await fetch(app.origin+'/api/runs/'+id+'/items/fields/0/export',{headers:c.headers});assert.equal(exported.status,200);assert.equal((await exported.json()).left_raw.length,4000);
});
test('large config asset bypasses orchestration cap and exports canonical bytes',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const c=await apiClient(app);const li=await c.imported('left','id\n1\n'),ri=await c.imported('right','id\n1\n');
  const config={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',left_values:{unused:'x'.repeat(1100000)}}],key:['id']};
  assert.equal((await c.request('/api/config/check',{left_import_id:li,right_import_id:ri,config})).status,413);
  const asset=await c.upload('config',JSON.stringify(config));const checked=await c.start('/api/config/check',{left_import_id:li,right_import_id:ri,config_asset_id:asset.asset_id});assert.equal(checked.state,'succeeded',JSON.stringify(checked.error));
  const exported=await fetch(app.origin+'/api/configs/'+checked.output.config_asset_id+'/export',{headers:c.headers});const text=await exported.text();assert.equal(JSON.parse(text).fields[0].left_values.unused.length,1100000);assert.equal(text.endsWith('\n'),true);
});
test('upload timeout and close abort writers before owned cleanup',async t=>{
  const fs=await import('node:fs/promises');const app=await startWorkbench({limits:{upload_ms:60}});t.after(()=>app.close());const u=new URL(app.origin);
  const req=http.request({hostname:u.hostname,port:u.port,path:'/api/assets?kind=csv',method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream'}});req.on('error',()=>{});req.write('id\n');await new Promise(r=>setTimeout(r,120));assert.equal(app.session.assets.size,0);assert.equal(app.session.reservations.size,0);
  const next=http.request({hostname:u.hostname,port:u.port,path:'/api/assets?kind=csv',method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream'}});next.on('error',()=>{});next.write('id\n');await new Promise(r=>setTimeout(r,15));const root=app.session.root;await app.close();await assert.rejects(fs.stat(root),e=>e.code==='ENOENT');
});
test('health stays responsive during synchronous child work; job busy and cancellation are real',async t=>{
  const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slow-bridge-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const bridge=path.join(dir,'bridge.mjs'),real=new URL('../_build/js/debug/build/cmd/bridge/bridge.js',import.meta.url).href;
  await fs.writeFile(bridge,`import {invoke_bridge as core} from ${JSON.stringify(real)};export function invoke_bridge(s){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);return core(s);}`);
  const app=await startWorkbench({bridgePath:bridge});t.after(()=>app.close());const c=await apiClient(app),asset=await c.upload('csv','id\n1\n');
  const started=await c.request('/api/imports',{asset_id:asset.asset_id,side:'left'});assert.equal(started.status,202);await new Promise(r=>setTimeout(r,70));
  const before=performance.now();assert.equal((await c.request('/api/capabilities')).status,200);assert.ok(performance.now()-before<1000);
  assert.equal((await c.request('/api/imports',{asset_id:asset.asset_id,side:'right'})).status,409);
  assert.equal((await c.request('/api/sessions/reset',{confirm:true})).status,409);
  const cancelled=await fetch(app.origin+'/api/jobs/'+started.body.job_id,{method:'DELETE',headers:c.headers});assert.equal((await cancelled.json()).job.state,'cancelled');assert.equal(app.session.imports.size,0);
});
test('private runtime permissions, strict schemas/queries and unsupported routes',async t=>{
  const fs=await import('node:fs/promises'),path=await import('node:path');const app=await startWorkbench();t.after(()=>app.close());const c=await apiClient(app);
  for(const name of ['orders','migration','catalog','ourairports']){const j=await c.start('/api/examples/'+name,{});assert.equal(j.state,'succeeded',JSON.stringify(j.error));}
  const walk=async p=>{const stat=await fs.lstat(p);assert.equal(stat.mode&0o777,stat.isDirectory()?0o700:0o600,p);if(stat.isDirectory())for(const n of await fs.readdir(p))await walk(path.join(p,n));};await walk(app.session.root);
  assert.equal((await fetch(app.origin+'/')).status,200);assert.equal((await fetch(app.origin+'/../package.json')).status,404);
  for(const [route,body] of [['/api/imports',{asset_id:'bad',side:'left'}],['/api/config/check',{left_import_id:'bad',right_import_id:'bad',config:{},config_asset_id:'bad'}],['/api/sessions/reset',{confirm:false}]])assert.equal((await c.request(route,body)).status,400);
  assert.equal((await c.request('/api/capabilities?path=x')).status,400);assert.equal((await c.request('/api/jobs/bad')).status,400);
  assert.equal((await c.request('/api/jobs/00000000-0000-4000-8000-000000000000')).status,404);
  assert.equal((await c.request('/api/restores',{})).status,404);assert.equal((await c.request('/api/runs/00000000-0000-4000-8000-000000000000/bundle',{})).status,404);
  const site=await fetch(app.origin+'/api/capabilities',{headers:{authorization:`Bearer ${app.token}`,origin:app.origin,'sec-fetch-site':'cross-site'}});assert.equal(site.status,403);
  const upload=await fetch(app.origin+'/api/assets?kind=xlsx',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream'},body:'x'});assert.equal(upload.status,422);
});
test('anonymous fixed static navigation accepts none but API and cross-site checks stay strict',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());
  for(const route of ['/','/index.html'])for(const site of ['none','same-origin'])assert.equal((await fetch(app.origin+route,{headers:{'sec-fetch-site':site,'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}})).status,200);
  const csvRenderer=await fetch(app.origin+'/cli/render.mjs',{headers:{'sec-fetch-site':'none'}});assert.equal(csvRenderer.status,200);assert.match(await csvRenderer.text(),/export function renderCsv/);
  assert.equal((await fetch(app.origin+'/cli/render.mjs?extra=1',{headers:{'sec-fetch-site':'same-origin'}})).status,404);
  assert.equal((await fetch(app.origin+'/cli/render.mjs',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(app.origin+'/',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(app.origin+'/',{headers:{'sec-fetch-site':'none',origin:'http://evil.example'}})).status,403);
  assert.equal((await fetch(app.origin+'/api/capabilities',{headers:{authorization:`Bearer ${app.token}`,'sec-fetch-site':'none'}})).status,403);
  assert.equal((await fetch(app.origin+'/api/capabilities',{headers:{'sec-fetch-site':'same-origin'}})).status,401);
  assert.equal((await fetch(app.origin+'/package.json',{headers:{'sec-fetch-site':'none'}})).status,403);
});
test('successful reset clears old jobs and replenishes metadata quota',async t=>{
  const app=await startWorkbench({limits:{jobs:1}});t.after(()=>app.close());const c=await apiClient(app);
  const old=await c.start('/api/examples/orders',{});assert.equal(old.state,'succeeded');assert.equal((await c.request('/api/sessions/reset',{confirm:true})).status,200);
  assert.equal((await c.request('/api/jobs/'+old.job_id)).status,404);assert.equal(app.jobs.jobs.size,0);
  const next=await c.start('/api/examples/orders',{});assert.equal(next.state,'succeeded');assert.notEqual(next.job_id,old.job_id);
});
test('failed owned reset preserves old job metadata',async t=>{
  const fs=await import('node:fs/promises'),path=await import('node:path');const app=await startWorkbench();t.after(()=>app.close());const c=await apiClient(app),old=await c.start('/api/examples/orders',{}),marker=path.join(app.session.root,'.owner');
  const owned=await fs.readFile(marker);await fs.writeFile(marker,'foreign');try{assert.notEqual((await c.request('/api/sessions/reset',{confirm:true})).status,200);assert.equal((await c.request('/api/jobs/'+old.job_id)).body.job.state,'succeeded');}finally{await fs.writeFile(marker,owned);}
});
test('close aborts unfinished JSON readers and prevents late job/reset work',async()=>{
  const fs=await import('node:fs/promises');
  for(const [route,prefix,suffix] of [['/api/examples/orders','{','}'],['/api/sessions/reset','{"confirm":','true}']]){
    const app=await startWorkbench(),u=new URL(app.origin),root=app.session.root;
    const req=http.request({hostname:u.hostname,port:u.port,path:route,method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json'}});req.on('error',()=>{});req.write(prefix);await new Promise(r=>setTimeout(r,20));
    const closing=app.close();const result=await Promise.race([closing.then(()=>true),new Promise(r=>setTimeout(()=>r(false),250))]);
    req.end(suffix);req.destroy();await closing;
    assert.equal(result,true,route+' unfinished body blocked close');assert.equal(app.jobs.jobs.size,0);assert.equal(app.session.generation,1);await assert.rejects(fs.stat(root),e=>e.code==='ENOENT');
  }
});
