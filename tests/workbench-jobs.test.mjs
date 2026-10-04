import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSession } from '../workbench/session.mjs';
import { createJobManager } from '../workbench/jobs.mjs';
import { executeTask } from '../workbench/engine-host.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const wait = async (fn, ms=4000) => {const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('wait timed out');await new Promise(r=>setTimeout(r,10));}};
async function setup(t, script, limits={}) {
  const session=await createSession({limits});
  const worker=path.join(session.root,'fixture.mjs');await fs.writeFile(worker,script,{mode:0o600});
  const jobs=await createJobManager({session,workerPath:worker,limits});
  t.after(async()=>{await jobs.close();await session.close();});return {session,jobs};
}
test('cancel_ignores_late_worker_result and cleans only after SIGKILL exit', async t=>{
  const {session,jobs}=await setup(t,`import fs from 'node:fs';process.on('SIGTERM',()=>{});process.on('message',m=>{fs.writeFileSync(m.task.paths.staging+'/alive','x');process.send({job_id:m.job_id,type:'result',output:{value:1}});setInterval(()=>{},20);});`,{kill_ms:70});
  let commits=0;const job=jobs.start('compare',{prepare:async({staging})=>({task:{kind:'compare',paths:{staging}},prepareOutput:async o=>({output:o,commit:()=>{commits++;}})})});
  await wait(()=>job.phase==='publishing');const pending=jobs.cancel(job.job_id);assert.equal(job.state,'cancelling');await pending;
  assert.equal(job.state,'cancelled');assert.equal(commits,0);assert.equal(job.output,null);assert.equal(jobs.active,null);
  assert.equal((await fs.readdir(session.root)).some(x=>x.startsWith('job-')),false);
});
test('cancellation during async publication cannot register a late candidate',async t=>{
  const {jobs}=await setup(t,`process.on('message',m=>process.send({job_id:m.job_id,type:'result',output:{}},()=>process.disconnect()));`);
  let release, entered=false, commits=0;const gate=new Promise(r=>release=r);
  const j=jobs.start('check',{prepare:async()=>({task:{},prepareOutput:async()=>{entered=true;await gate;return {output:{config_asset_id:'x'},commit:()=>commits++};}})});
  await wait(()=>entered);const cancelled=jobs.cancel(j.job_id);release();await cancelled;assert.equal(j.state,'cancelled');assert.equal(commits,0);
});
test('timeout_and_quota_preserve_previous_revision',async t=>{
  for(const mode of ['timeout','quota']){
    const limits=mode==='timeout'?{job_ms:80,kill_ms:50}:{session_bytes:12000,quota_poll_ms:25,kill_ms:50};
    const {session,jobs}=await setup(t,`import fs from 'node:fs';process.on('message',m=>{${mode==='quota'?"fs.writeFileSync(m.task.paths.staging+'/large',Buffer.alloc(20000));":''}setInterval(()=>{},20);});`,limits);
    const invoke=await loadBridgeInvoke();
    const left=await session.saveAsset('csv','left.csv','id\n1\n'),right=await session.saveAsset('csv','right.csv','id\n1\n');
    const config=await session.saveAsset('config','config.json',JSON.stringify({schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text'}],key:['id']}));
    const imp=a=>({import_id:randomUUID(),asset_id:a.asset_id,side:a===left?'left':'right',format:'csv',status:'ready',headers:['id'],row_count:1,column_count:1,sha256:a.sha256,path:a.path});
    const li=imp(left),ri=imp(right);session.commitImport(li);session.commitImport(ri);
    const run=path.join(session.root,'prior-run');await executeTask({kind:'compare',payload:{},paths:{left:left.path,right:right.path,config:config.path,run}},{invoke});
    const previous=await session.publishRevision({runPath:run,left_import_id:li.import_id,right_import_id:ri.import_id,config_asset_id:config.asset_id});
    const reportBefore=await fs.readFile(path.join(run,'report.json'));let commits=0;
    const j=jobs.start('compare',{prepare:async({staging})=>({task:{paths:{staging}},prepareOutput:async()=>({output:{},commit:()=>commits++})})});
    await wait(()=>j.state==='failed');assert.equal(j.error.code,mode==='timeout'?'job_timeout':'quota_exceeded');assert.equal(commits,0);assert.equal(session.revisions.size,1);assert.deepEqual(await fs.readFile(path.join(run,'report.json')),reportBefore);assert.equal(previous.report_sha256,createHash('sha256').update(reportBefore).digest('hex'));
  }
});
test('cleanup_refuses_foreign_or_symlink_root',async()=>{
  const s=await createSession();const root=s.root;await fs.writeFile(path.join(root,'.owner'),'foreign');await assert.rejects(s.close(),/ownership/);await fs.rm(root,{recursive:true});
  const x=await createSession();const moved=x.root+'-moved';await fs.rename(x.root,moved);await fs.symlink(moved,x.root);await assert.rejects(x.close(),/ownership|symlink/);await fs.unlink(x.root);await fs.rm(moved,{recursive:true});
});
test('shared reservations reject upload/job overcommit and reset active writes',async t=>{
  const s=await createSession({limits:{session_bytes:1000}});t.after(()=>s.close());
  await s.reserve('upload',800);await assert.rejects(s.reserve('job',800),e=>e.code==='quota_exceeded');
  await assert.rejects(s.reset(),e=>e.status===409);s.release('upload');const old=s.root;await s.reset();assert.notEqual(s.root,old);
});
test('worker preview output cannot leak internal paths or omit the DTO',async t=>{
  const {jobs}=await setup(t,`process.on('message',m=>process.send({job_id:m.job_id,type:'result',output:{path:'/private/internal'}},()=>process.disconnect()));`);
  const j=jobs.start('preview',{task:{payload:{},paths:{}}});await wait(()=>!['running','cancelling'].includes(j.state));assert.equal(j.state,'failed');assert.equal(j.output,null);
});
test('ownership marker symlink is never followed for cleanup',async()=>{
  const s=await createSession(),root=s.root,marker=path.join(root,'.owner'),external=root+'-owner';await fs.copyFile(marker,external);await fs.unlink(marker);await fs.symlink(external,marker);
  await assert.rejects(s.close(),/ownership|marker/);assert.ok(await fs.stat(external));await fs.rm(root,{recursive:true});await fs.unlink(external);
});
