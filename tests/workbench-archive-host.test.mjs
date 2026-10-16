import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWorkbench } from '../workbench/server.mjs';
import { mutateZip } from './helpers/zip-mutations.mjs';
const task6Evidence=path.resolve(import.meta.dirname,'../.superpowers/sdd/2026-10-08-restricted-xlsx/evidence/task-6');

function client(app) {
  const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const request=async(route,body)=>{const response=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const wait=async(id)=>{for(let n=0;n<500;n++){const job=(await request(`/api/jobs/${id}`)).body.job;if(!['running','cancelling'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('job wait timeout');};
  const job=async(route,body)=>{const accepted=await request(route,body);assert.equal(accepted.status,202,JSON.stringify(accepted.body));return wait(accepted.body.job_id);};
  const upload=async(kind,bytes,name=`${kind}.bin`)=>{const response=await fetch(`${app.origin}/api/assets?kind=${kind}`,{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream','x-filename':encodeURIComponent(name)},body:bytes});const data=await response.json();assert.equal(response.status,201,JSON.stringify(data));return data.asset;};
  return {request,job,wait,upload,headers};
}

async function makeBundle(app,c) {
  const example=await c.job('/api/examples/orders',{});assert.equal(example.state,'succeeded',JSON.stringify(example.error));
  const compared=await c.job('/api/runs',{left_import_id:example.output.left_import_id,right_import_id:example.output.right_import_id,config_asset_id:example.output.config_asset_id});
  assert.equal(compared.state,'succeeded',JSON.stringify(compared.error));
  const revision=compared.output.revision,report=await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json'));
  const packed=await c.job(`/api/runs/${revision.revision_id}/bundle`,{});assert.equal(packed.state,'succeeded',JSON.stringify(packed.error));
  const exported=await fetch(`${app.origin}/api/bundles/${packed.output.bundle_asset_id}/export`,{headers:c.headers});assert.equal(exported.status,200);
  return {revision,report,bundle:Buffer.from(await exported.arrayBuffer()),bundle_asset_id:packed.output.bundle_asset_id,example};
}

for(const kind of ['local-path','local-encrypted','local-flags','local-compression','osx-symlink','osx-special'])test(`HTTP restore rejects ${kind} and preserves every published entry and owned directory`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-header-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=await startWorkbench();t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c);
  const baseline=path.join(root,'baseline.zip'),malformed=path.join(root,`${kind}.zip`);await fs.writeFile(baseline,saved.bundle);mutateZip(baseline,malformed,kind);
  const asset=await c.upload('run',await fs.readFile(malformed),`${kind}.zip`);
  const snapshot=async()=>structuredClone({assets:[...app.session.assets.entries()],imports:[...app.session.imports.entries()],revisions:[...app.session.revisions.entries()],bindings:[...app.session.bindings.entries()],heads:[...app.session.heads.entries()],directories:(await fs.readdir(app.session.root)).sort()});
  const before=await snapshot(),failed=await c.job('/api/restores',{asset_id:asset.asset_id});
  assert.equal(failed.state,'failed',JSON.stringify(failed.error));assert.equal(failed.error.code,'invalid_bundle');assert.equal(failed.output,null);assert.equal(app.jobs.active,null);
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(saved.revision.revision_id).path,'report.json')),saved.report);
});

test('bundle export, reset, upload, CLI replay restore, and fresh local registration are atomic',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c),oldIds={revision:saved.revision.revision_id,left:saved.revision.left_import_id,right:saved.revision.right_import_id,config:saved.revision.config_asset_id};
  await fs.mkdir(task6Evidence,{recursive:true});await fs.writeFile(path.join(task6Evidence,'actual-csv-v1.zip'),saved.bundle);
  assert.deepEqual((await c.request('/api/sessions/reset',{confirm:true})).status,200);assert.equal(app.session.assets.size,0);assert.equal(app.session.revisions.size,0);
  assert.equal((await c.request(`/api/bundles/${saved.bundle_asset_id}/export`)).status,404);
  const asset=await c.upload('run',saved.bundle,'orders.zip');assert.equal((await fetch(`${app.origin}/api/bundles/${asset.asset_id}/export`,{headers:c.headers})).status,404);
  const restored=await c.job('/api/restores',{asset_id:asset.asset_id});assert.equal(restored.state,'succeeded',JSON.stringify(restored.error));
  const revision=restored.output.revision;assert.notEqual(revision.revision_id,oldIds.revision);assert.notEqual(revision.left_import_id,oldIds.left);assert.notEqual(revision.right_import_id,oldIds.right);assert.notEqual(revision.config_asset_id,oldIds.config);
  assert.equal(app.session.assets.size,4);assert.equal(app.session.imports.size,2);assert.equal(app.session.revisions.size,1);
  assert.deepEqual(app.session.bindings.get(revision.config_asset_id),[revision.left_import_id,revision.right_import_id]);
  const current=await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json'));assert.deepEqual(current,saved.report);
  assert.equal((await c.request(`/api/runs/${revision.revision_id}/summary`)).body.revision.report_sha256,revision.report_sha256);
});

async function assertAtomicQuotaFailure(limit) {
  const app=await startWorkbench({limits:limit}),c=client(app);
  try {
    const saved=await makeBundle(app,c),before={assets:app.session.assets.size,imports:app.session.imports.size,revisions:app.session.revisions.size,bindings:app.session.bindings.size};
    const asset=await c.upload('run',saved.bundle,'quota-test.zip'),job=await c.job('/api/restores',{asset_id:asset.asset_id});
    assert.equal(job.state,'failed',JSON.stringify(job));assert.equal(job.output,null);assert.equal(job.error.code,'quota_exceeded');
    assert.equal(app.session.assets.size,before.assets+1);assert.equal(app.session.imports.size,before.imports);assert.equal(app.session.revisions.size,before.revisions);assert.equal(app.session.bindings.size,before.bindings);
    const old=app.session.getRevision(saved.revision.revision_id);assert.equal(old.report_sha256,saved.revision.report_sha256);
    assert.deepEqual(await fs.readFile(path.join(old.path,'report.json')),saved.report);
  } finally {await app.close();}
}

test('restore asset quota precheck preserves every old registry entry and report',async()=>{await assertAtomicQuotaFailure({assets:6});});
test('restore import quota precheck preserves every old registry entry and report',async()=>{await assertAtomicQuotaFailure({imports:3});});
test('restore revision quota precheck preserves every old registry entry and report',async()=>{await assertAtomicQuotaFailure({revisions:1});});

test('final no-await restore latch rechecks asset capacity after a concurrent upload',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-slow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const real=new URL('../_build/js/debug/build/cmd/bridge/bridge.js',import.meta.url).href,bridgePath=path.join(dir,'bridge.mjs');
  await fs.writeFile(bridgePath,`import {invoke_bridge as core} from ${JSON.stringify(real)};export function invoke_bridge(s){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);return core(s);}`);
  const app=await startWorkbench({bridgePath,limits:{assets:7}});t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c),asset=await c.upload('run',saved.bundle,'race.zip');
  const accepted=await c.request('/api/restores',{asset_id:asset.asset_id});assert.equal(accepted.status,202);
  const extra=await c.upload('csv','other.csv');assert.ok(extra.asset_id);const job=await c.wait(accepted.body.job_id);
  assert.equal(job.state,'failed',JSON.stringify(job));assert.equal(job.error.code,'quota_exceeded');
  assert.equal(app.session.assets.size,6);assert.equal(app.session.imports.size,2);assert.equal(app.session.revisions.size,1);assert.equal(app.session.bindings.size,1);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(saved.revision.revision_id).path,'report.json')),saved.report);
});

test('self-consistent forged report fails HTTP restore without publishing any partial registry entries',async t=>{
  const {execFileSync}=await import('node:child_process');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-forged-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=await startWorkbench();t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c);
  const input=path.join(root,'input.zip'),forged=path.join(root,'forged.zip');await fs.writeFile(input,saved.bundle);
  execFileSync('python3',['-c',String.raw`import sys,zipfile,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z: data={name:z.read(name) for name in z.namelist()}
r=json.loads(data['run/report.json']);r['summary']['unresolved_count']=99
data['run/report.json']=(json.dumps(r,separators=(',',':'))+'\n').encode()
m=json.loads(data['workbench.json']);h=hashlib.sha256(data['run/report.json']).hexdigest()
m['revision']['report_sha256']=h
for f in m['files']:
 if f['path']=='run/report.json':f['bytes']=len(data[f['path']]);f['sha256']=h
data['workbench.json']=(json.dumps(m)+'\n').encode()
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for name,content in data.items():z.writestr(name,content)
`,input,forged]);
  const asset=await c.upload('run',await fs.readFile(forged),'forged.zip');
  const before={assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],bindings:[...app.session.bindings.entries()],heads:[...app.session.heads.entries()]};
  const failed=await c.job('/api/restores',{asset_id:asset.asset_id});assert.equal(failed.state,'failed');assert.equal(failed.error.code,'replay_mismatch');assert.equal(failed.output,null);
  assert.deepEqual({assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],bindings:[...app.session.bindings.entries()],heads:[...app.session.heads.entries()]},before);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(saved.revision.revision_id).path,'report.json')),saved.report);
});

test('reviewed ZIP restore creates a self-baseline retaining applied actions, and branch really re-compares',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c);
  const decisions=await c.upload('decisions','action,left_id,right_id,reason\nleft_unmatched,L3,,confirmed\n','decisions.csv');
  const reviewed=await c.job(`/api/runs/${saved.revision.revision_id}/reviews`,{base_revision:saved.revision.revision_id,decisions_asset_id:decisions.asset_id});assert.equal(reviewed.state,'succeeded',JSON.stringify(reviewed.error));
  const revision=reviewed.output.revision,report=await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json'));
  const packed=await c.job(`/api/runs/${revision.revision_id}/bundle`,{});assert.equal(packed.state,'succeeded');
  const zip=await fetch(`${app.origin}/api/bundles/${packed.output.bundle_asset_id}/export`,{headers:c.headers}),asset=await c.upload('run',Buffer.from(await zip.arrayBuffer()),'reviewed.zip');
  const restored=await c.job('/api/restores',{asset_id:asset.asset_id});assert.equal(restored.state,'succeeded',JSON.stringify(restored.error));
  const fresh=restored.output.revision;assert.equal(fresh.baseline_revision_id,fresh.revision_id);assert.equal(fresh.parent_revision_id,null);assert.notEqual(fresh.left_import_id,revision.left_import_id);assert.notEqual(fresh.right_import_id,revision.right_import_id);assert.notEqual(fresh.config_asset_id,revision.config_asset_id);
  const restoredReport=await fs.readFile(path.join(app.session.getRevision(fresh.revision_id).path,'report.json'));assert.deepEqual(restoredReport,report);assert.equal(JSON.parse(restoredReport).decisions.length,1);
  const branched=await c.job(`/api/runs/${fresh.revision_id}/branch`,{});assert.equal(branched.state,'succeeded',JSON.stringify(branched.error));const branch=JSON.parse(await fs.readFile(path.join(app.session.getRevision(branched.output.revision.revision_id).path,'report.json')));
  assert.deepEqual(branch.decisions,[]);assert.equal(branch.records.find(r=>r.id==='L3').status,'pending_review');
  const replay=await c.job(`/api/runs/${branched.output.revision.revision_id}/reviews`,{base_revision:branched.output.revision.revision_id,decisions_asset_id:decisions.asset_id});assert.equal(replay.state,'succeeded',JSON.stringify(replay.error));assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(replay.output.revision.revision_id).path,'report.json')),report);
});

for(const kind of ['bundle','restore'])test(`cancel actual ${kind} waits for child exit before owned cleanup and preserves old reports`,async t=>{
  const {pathToFileURL}=await import('node:url');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-actual-cancel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const worker=path.join(root,'worker.mjs'),flag=path.join(root,'hang'),sentinel=path.join(root,'executed.json');
  const host=pathToFileURL(path.resolve('workbench/engine-host.mjs')).href,bridge=pathToFileURL(path.resolve('cli/bridge.mjs')).href;
  // The exact production executeTask runs before holding the worker alive. This
  // makes cancellation exercise completed ZIP I/O and the exit-before-commit latch.
  await fs.writeFile(worker,`import fs from 'node:fs';import {executeTask} from ${JSON.stringify(host)};import {loadBridgeInvoke} from ${JSON.stringify(bridge)};process.on('message',async m=>{try{const invoke=await loadBridgeInvoke(m.task.bridge_path);const output=await executeTask(m.task,{invoke});if(fs.existsSync(${JSON.stringify(flag)})&&m.task.kind===${JSON.stringify(kind)}){fs.writeFileSync(${JSON.stringify(sentinel)},JSON.stringify({pid:process.pid,staging:m.task.paths.staging??Object.values(m.task.paths)[0]}));process.send({job_id:m.job_id,type:'result',output});setInterval(()=>{},20);}else process.send({job_id:m.job_id,type:'result',output},()=>process.disconnect());}catch(e){process.send({job_id:m.job_id,type:'error',error:{code:e.code??'worker_failed',message:e.message,phase:e.phase??null,side:null,record:null,field:null}},()=>process.disconnect());}});`);
  const app=await startWorkbench({workerPath:worker});t.after(()=>app.close());const c=client(app),saved=await makeBundle(app,c);const asset=await c.upload('run',saved.bundle,'restore.zip');await fs.writeFile(flag,'hold');const directoriesBefore=(await fs.readdir(app.session.root)).sort();
  const before={assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],bindings:[...app.session.bindings.entries()],heads:[...app.session.heads.entries()]};
  const accepted=await c.request(kind==='bundle'?`/api/runs/${saved.revision.revision_id}/bundle`:'/api/restores',kind==='bundle'?{}:{asset_id:asset.asset_id});assert.equal(accepted.status,202);
  for(let n=0;n<500;n++){if((await c.request(`/api/jobs/${accepted.body.job_id}`)).body.job.phase==='publishing')break;await new Promise(r=>setTimeout(r,10));}
  const child=JSON.parse(await fs.readFile(sentinel,'utf8'));assert.doesNotThrow(()=>process.kill(child.pid,0));
  const cancelled=await fetch(`${app.origin}/api/jobs/${accepted.body.job_id}`,{method:'DELETE',headers:c.headers});assert.equal(cancelled.status,200);const job=(await cancelled.json()).job;assert.equal(job.state,'cancelled');assert.equal(job.output,null);assert.equal(app.jobs.active,null);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});assert.deepEqual((await fs.readdir(app.session.root)).sort(),directoriesBefore);
  assert.deepEqual({assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],bindings:[...app.session.bindings.entries()],heads:[...app.session.heads.entries()]},before);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(saved.revision.revision_id).path,'report.json')),saved.report);
});

for(const limit of [{zip_bytes:200},{unzip_bytes:200}])test(`bundle worker honors the configured ${Object.keys(limit)[0]} cap and preserves the published run`,async t=>{
  const app=await startWorkbench({limits:limit});t.after(()=>app.close());const c=client(app);
  const example=await c.job('/api/examples/orders',{}),compared=await c.job('/api/runs',{left_import_id:example.output.left_import_id,right_import_id:example.output.right_import_id,config_asset_id:example.output.config_asset_id});assert.equal(compared.state,'succeeded');const revision=compared.output.revision;
  const oldReport=await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json')),before={assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],directories:(await fs.readdir(app.session.root)).sort()};
  const packed=await c.job(`/api/runs/${revision.revision_id}/bundle`,{});assert.equal(packed.state,'failed');assert.equal(packed.error.code,'quota_exceeded');assert.equal(packed.output,null);assert.equal(app.jobs.active,null);
  assert.deepEqual({assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],revisions:[...app.session.revisions.keys()],directories:(await fs.readdir(app.session.root)).sort()},before);assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json')),oldReport);
});
