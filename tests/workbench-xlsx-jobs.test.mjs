import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createSession } from '../workbench/session.mjs';
import { createJobManager } from '../workbench/jobs.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const fixture=path.join(root,'fixtures','xlsx','lo-conversion-1900.xlsx');
const wait=async(fn,ms=10000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('job wait timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('xlsx_catalog_worker_reads_registered_source_and_keeps_large_output_on_disk',async t=>{
  const session=await createSession(),jobs=await createJobManager({session,limits:{job_ms:30000}});t.after(async()=>{await jobs.close();await session.close();});
  const source=await session.saveAsset('xlsx','workbook.xlsx',await fs.readFile(fixture));
  const job=jobs.start('xlsx_catalog',{prepare:async({staging})=>({task:{kind:'xlsx_catalog',payload:{asset_id:source.asset_id},paths:{xlsx:source.path,staging}},prepareOutput:async output=>{
    assert.equal(output.catalog_path,path.join(staging,'workbook.json'));
    const workbook=JSON.parse(await fs.readFile(output.catalog_path,'utf8'));
    assert.equal(workbook.source_sha256,source.sha256);assert.equal(workbook.asset_id,source.asset_id);
    return {output:{workbook},commit(){}};
  }})});
  await wait(()=>!['running','cancelling'].includes(job.state));
  assert.equal(job.state,'succeeded',JSON.stringify(job.error));
  assert.deepEqual(Object.keys(job.output),['workbook']);
  assert.equal(job.output.workbook.source_sha256,source.sha256);
  assert.ok(job.output.workbook.sheets.some(sheet=>sheet.selectable));
});

test('cancel_after_candidate_before_hash_never_publishes_and_cleans_owned_staging',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-candidate-worker-'));
  const session=await createSession(),worker=path.join(dir,'late.mjs');
  await fs.writeFile(worker,`import fs from 'node:fs';process.on('message',m=>{fs.writeFileSync(m.task.paths.staging+'/canonical.csv','candidate');fs.writeFileSync(m.task.paths.staging+'/workbook.json','candidate catalog');process.send({job_id:m.job_id,type:'result',output:{catalog_path:m.task.paths.staging+'/workbook.json'}},()=>process.disconnect());});`);
  const jobs=await createJobManager({session,workerPath:worker,limits:{kill_ms:50}});t.after(async()=>{await jobs.close();await session.close();await fs.rm(dir,{recursive:true,force:true});});
  let release,entered=false,hashed=false,commits=0;const gate=new Promise(resolve=>release=resolve);
  const job=jobs.start('xlsx_catalog',{prepare:async({staging})=>({task:{kind:'xlsx_catalog',payload:{asset_id:'00000000-0000-4000-8000-000000000000'},paths:{staging}},prepareOutput:async()=>{entered=true;await gate;const candidate=await fs.readFile(path.join(staging,'workbook.json'));hashed=createHash('sha256').update(candidate).digest('hex').length===64;return {output:{workbook:{xlsx_api_version:1,asset_id:'00000000-0000-4000-8000-000000000000',source_sha256:'0'.repeat(64),date_system:'1900',sheets:[]}},commit(){commits++;}};}})});
  await wait(()=>entered);const cancel=jobs.cancel(job.job_id);release();await cancel;
  assert.equal(job.state,'cancelled');assert.equal(commits,0);assert.equal(hashed,true);assert.equal(session.assets.size,0);assert.equal(session.imports.size,0);assert.equal(jobs.active,null);
  assert.equal((await fs.readdir(session.root)).some(name=>name.startsWith('job-')),false);
});

test('disk_full_after_candidate_preparation_keeps_registry_and_removes_owned_materials',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-disk-full-worker-')),worker=path.join(dir,'worker.mjs');
  await fs.writeFile(worker,"process.on('message',m=>process.send({job_id:m.job_id,type:'result',output:{ready:true}},()=>process.disconnect()));");
  const session=await createSession(),jobs=await createJobManager({session,workerPath:worker});t.after(async()=>{await jobs.close();await session.close();await fs.rm(dir,{recursive:true,force:true});});
  const source=await session.saveAsset('xlsx','source.xlsx',await fs.readFile(fixture));
  const before=await fs.readdir(session.root);let release,entered=false;const gate=new Promise(resolve=>release=resolve);
  const job=jobs.start('import',{prepare:async({staging})=>({task:{payload:{format:'xlsx'},paths:{staging}},prepareOutput:async()=>{const csv=path.join(staging,'canonical.csv'),profile=path.join(staging,'profile.json'),manifest=path.join(staging,'adapter.json');await Promise.all([fs.writeFile(csv,'id\\n1\\n',{mode:0o600}),fs.writeFile(profile,'{}',{mode:0o600}),fs.writeFile(manifest,'{}',{mode:0o600})]);entered=true;await gate;return {output:{import:{import_id:randomUUID()}},commit(){throw new Error('must not commit after quota failure');}};}})});
  await wait(()=>entered);session.checkQuota=async()=>{throw Object.assign(new Error('injected disk-full quota failure'),{error:{code:'quota_exceeded',message:'Session disk quota exceeded',phase:'publishing',side:null,record:null,field:null}});};release();
  await wait(()=>!['running','cancelling'].includes(job.state));
  assert.equal(job.state,'failed');assert.equal(job.error.code,'quota_exceeded');assert.equal(session.assets.size,1);assert.equal(session.imports.size,0);assert.equal(jobs.active,null);
  assert.deepEqual(await fs.readdir(session.root),before,'canonical CSV and materials remain owned by staging until the no-await commit');
});

test('registered_source_and_canonical_csv_hashes_are_distinct_material_receipts',async t=>{
  const session=await createSession();t.after(()=>session.close());
  const source=await session.saveAsset('xlsx','workbook.xlsx',await fs.readFile(fixture));
  const canonical=await fs.readFile(path.join(root,'fixtures','xlsx','lo-conversion-1900-reference.csv'));
  assert.notEqual(sha(canonical),source.sha256);
});

test('import_batch_projects_capacity_before_atomic_asset_and_import_commit',async t=>{
  const session=await createSession({limits:{imports:1}});t.after(()=>session.close());
  const source=await session.saveAsset('xlsx','source.xlsx',await fs.readFile(fixture));
  const csv=await session.saveAsset('csv','prior.csv','id\n1\n');
  const prior={import_id:randomUUID(),asset_id:csv.asset_id,side:'left',format:'csv',status:'ready',headers:['id'],row_count:1,column_count:1,sha256:csv.sha256,path:csv.path};session.commitImport(prior);
  const stage=await session.staging('batch'),canonicalPath=path.join(stage,'canonical.csv');await fs.writeFile(canonicalPath,'id\n1\n',{mode:0o600});
  const canonical=await session.prepareAsset('csv','canonical.csv',canonicalPath),entry={import_id:randomUUID(),asset_id:source.asset_id,canonical_asset_id:canonical.asset_id,side:'right',format:'xlsx',status:'ready',headers:['id'],row_count:1,column_count:1,sha256:canonical.sha256,path:canonical.path,profile_path:path.join(stage,'profile.json'),adapter_manifest_path:path.join(stage,'adapter.json'),adapter:{adapter_id:'restricted-ooxml',adapter_version:'1.0.0',profile_schema_version:1,profile_sha256:'1'.repeat(64),import_manifest_sha256:'2'.repeat(64),source_sha256:source.sha256,canonical_csv_sha256:canonical.sha256}};
  assert.throws(()=>session.checkImportBatch({newAssets:[canonical],newImport:entry}),error=>error.code==='quota_exceeded');
  assert.equal(session.assets.has(canonical.asset_id),false);assert.equal(session.imports.has(entry.import_id),false);
  session.limits.imports=2;session.checkImportBatch({newAssets:[canonical],newImport:entry});
  assert.equal(session.assets.has(canonical.asset_id),false);assert.equal(session.imports.has(entry.import_id),false);
  session.commitImportBatch({newAssets:[canonical],newImport:entry});
  assert.equal(session.assets.get(canonical.asset_id),canonical);assert.equal(session.imports.get(entry.import_id),entry);
});
