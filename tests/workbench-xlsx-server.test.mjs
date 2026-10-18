import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { startWorkbench } from '../workbench/server.mjs';
import { run } from '../cli/main.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const fixture=name=>path.join(root,'fixtures','xlsx',name);
const task6Evidence=path.resolve(root,'../.superpowers/sdd/2026-10-08-restricted-xlsx/evidence/task-6');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function client(app) {
  const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const request=async(route,body,extra={})=>{const response=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};};
  const terminal=async(id)=>{for(let i=0;i<500;i++){const result=await request(`/api/jobs/${id}`);const current=result.body.job;if(current&&!['running','cancelling'].includes(current.state))return current;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('job wait timed out');};
  const job=async(route,body)=>{const start=await request(route,body);assert.equal(start.status,202,JSON.stringify(start.body));return terminal(start.body.job_id);};
  const upload=async(kind,bytes)=>{const response=await fetch(`${app.origin}/api/assets?kind=${kind}`,{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/octet-stream','x-filename':'source.xlsx'},body:bytes});const body=await response.json();return {status:response.status,...body};};
  return {headers,request,job,terminal,upload};
}

test('default_host_preserves_csv_wire_shape and xlsx_requires_exact_bound_profile',async t=>{
  const app=await startWorkbench();t.after(()=>app.close());const c=await client(app);
  const caps=(await c.request('/api/capabilities')).body;
  assert.deepEqual(caps.formats,['csv','xlsx']);
  assert.equal(caps.xlsx_api_version,1);
  const csv=await c.upload('csv',Buffer.from('id\n00123\n'));
  const csvImport=await c.job('/api/imports',{asset_id:csv.asset.asset_id,side:'left'});
  assert.equal(csvImport.state,'succeeded',JSON.stringify(csvImport.error));
  assert.deepEqual(Object.keys(csvImport.output.import).sort(),['asset_id','column_count','format','headers','import_id','row_count','sha256','side','status'].sort());
  const registeredImports=app.session.imports.size;

  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx'));
  const xlsx=await c.upload('xlsx',bytes);assert.equal(xlsx.status,201,JSON.stringify(xlsx));
  assert.equal(app.session.imports.size,registeredImports,'upload alone must not register an Import');
  assert.equal(xlsx.asset.sha256,sha(bytes));
  const catalog=await c.job('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id});
  assert.equal(catalog.state,'succeeded',JSON.stringify(catalog.error));
  assert.deepEqual(Object.keys(catalog.output),['workbook']);
  const workbook=catalog.output.workbook,sheet=workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:[{column:1,mode:'stored_text'},{column:2,mode:'decimal_lexeme'},{column:3,mode:'stored_text'},{column:4,mode:'excel_date'},{column:5,mode:'zero_padded_identifier'},{column:6,mode:'stored_text'}],formula_policy:'reject'};
  assert.equal(app.session.imports.size,registeredImports,'catalog alone must not register an Import');
  const wrongKindCsv=await c.upload('csv',Buffer.from('id\n1\n'));
  assert.equal((await c.request('/api/imports',{asset_id:wrongKindCsv.asset.asset_id,side:'left',import_spec:spec})).status,422);
  for(const bad of [{...spec,source_sha256:'0'.repeat(64)},{...spec,unexpected:true},{...spec,columns:spec.columns.map((value,index)=>index?value:{...value,mode:'guess'})}]) {
    const rejected=await c.request('/api/imports',{asset_id:xlsx.asset.asset_id,side:'right',import_spec:bad});assert.equal(rejected.status,400);
  }
  const missingSheet=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'right',import_spec:{...spec,sheet_id:`${spec.source_sha256}:999`}});
  assert.equal(missingSheet.state,'failed');assert.equal(missingSheet.error.code,'invalid_import_spec');assert.equal(app.session.imports.size,registeredImports);
  const badCellMode=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'right',import_spec:{...spec,columns:spec.columns.map((item,index)=>index?item:{...item,mode:'decimal_lexeme'})}});
  assert.equal(badCellMode.state,'failed');assert.equal(badCellMode.error.phase,'xlsx');assert.equal(badCellMode.error.record,2);assert.equal(badCellMode.error.field,'A2');assert.equal(app.session.imports.size,registeredImports);
  const imported=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'left',import_spec:spec});
  assert.equal(imported.state,'succeeded',JSON.stringify(imported.error));
  const entry=imported.output.import;
  assert.deepEqual(Object.keys(entry).sort(),['import_id','asset_id','side','format','status','headers','row_count','column_count','sha256','adapter'].sort());
  assert.equal(entry.asset_id,xlsx.asset.asset_id);assert.notEqual(entry.sha256,xlsx.asset.sha256);
  assert.equal(entry.adapter.source_sha256,xlsx.asset.sha256);assert.equal(entry.adapter.canonical_csv_sha256,entry.sha256);
});

async function slowBridge(t, delay=900) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-slow-bridge-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bridge=path.join(dir,'bridge.mjs'),entered=path.join(dir,'entered'),real=new URL('../_build/js/debug/build/cmd/bridge/bridge.js',import.meta.url).href;
  await fs.writeFile(bridge,`import fs from 'node:fs';import {invoke_bridge as core} from ${JSON.stringify(real)};export function invoke_bridge(s){if(JSON.parse(s).csv?.includes('text_id')){fs.writeFileSync(${JSON.stringify(entered)},'entered');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delay});}return core(s);}`);
  return {bridge,entered};
}

test('quota_during_conversion_keeps_registered_state_and_removes_candidates',async t=>{
  const bridge=await slowBridge(t),app=await startWorkbench({bridgePath:bridge.bridge,xlsxEnabled:true,limits:{session_bytes:30000,kill_ms:100}});t.after(()=>app.close());const c=await client(app);
  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',bytes),baselineCsv=await c.upload('csv',Buffer.from('id\n1\n'));
  const previous=await c.job('/api/imports',{asset_id:baselineCsv.asset.asset_id,side:'left'});assert.equal(previous.state,'succeeded');
  const before={assets:[...app.session.assets.keys()],imports:[...app.session.imports.keys()],heads:[...app.session.heads.entries()],revisions:app.session.revisions.size};
  const started=await c.request('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id});assert.equal(started.status,202);
  const catalog=await c.terminal(started.body.job_id);assert.equal(catalog.state,'succeeded',JSON.stringify(catalog.error));const sheet=catalog.output.workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:catalog.output.workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const request=await c.request('/api/imports',{asset_id:xlsx.asset.asset_id,side:'right',import_spec:spec});assert.equal(request.status,202);
  const rootEntries=await fs.readdir(app.session.root);
  for(let i=0;i<100&&app.jobs.get(request.body.job_id).phase==='reading';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(app.jobs.get(request.body.job_id).state,'running');
  const startedAt=performance.now();assert.equal((await c.request('/api/capabilities')).status,200);assert.ok(performance.now()-startedAt<1000,'capabilities remain responsive during child conversion');
  assert.equal((await c.request('/api/sessions/reset',{confirm:true})).status,409,'reset cannot race an active child');
  app.session.limits.session_bytes=9000;
  const job=await c.terminal(request.body.job_id);assert.equal(job.state,'failed');assert.equal(job.error.code,'quota_exceeded');
  assert.deepEqual([...app.session.assets.keys()],before.assets);assert.deepEqual([...app.session.imports.keys()],before.imports);assert.deepEqual([...app.session.heads.entries()],before.heads);assert.equal(app.session.revisions.size,before.revisions);
  assert.deepEqual(await fs.readdir(app.session.root),rootEntries);
  app.session.limits.session_bytes=30000;
  const followup=await c.job('/api/imports',{asset_id:baselineCsv.asset.asset_id,side:'right'});assert.equal(followup.state,'succeeded',JSON.stringify(followup.error));
});

test('timeout_kills_xlsx_child_releases_materials_and_allows_followup_csv',async t=>{
  // Keep this injected host budget below the normal contract while giving the
  // deliberate XLSX bridge stall a clear 2 s margin before timeout.
  const bridge=await slowBridge(t,3000),app=await startWorkbench({bridgePath:bridge.bridge,xlsxEnabled:true,limits:{job_ms:1000,kill_ms:50}});t.after(()=>app.close());const c=await client(app);
  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',bytes);
  const catalog=await c.job('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id});assert.equal(catalog.state,'succeeded',JSON.stringify(catalog.error));const sheet=catalog.output.workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:catalog.output.workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const request=await c.request('/api/imports',{asset_id:xlsx.asset.asset_id,side:'left',import_spec:spec});assert.equal(request.status,202);
  const rootEntries=await fs.readdir(app.session.root);
  const job=await c.terminal(request.body.job_id);assert.equal(job.state,'failed');assert.equal(job.error.code,'job_timeout');
  assert.equal(app.session.assets.size,1);assert.equal(app.session.imports.size,0);assert.deepEqual(await fs.readdir(app.session.root),rootEntries);
  const csv=await c.upload('csv',Buffer.from('id\n1\n')),followup=await c.job('/api/imports',{asset_id:csv.asset.asset_id,side:'left'});assert.equal(followup.state,'succeeded',JSON.stringify(followup.error));
});

test('xlsx_source_cell_is_revision_bound and fixed materials export is owned',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',bytes);
  assert.equal(xlsx.status,201,JSON.stringify(xlsx));
  const workbook=(await c.job('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id})).output.workbook,sheet=workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const left=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'left',import_spec:spec});assert.equal(left.state,'succeeded',JSON.stringify(left.error));
  const canonicalBytes=await fs.readFile(fixture('lo-conversion-1900-reference.csv'));
  const csv=await c.upload('csv',canonicalBytes);
  const right=await c.job('/api/imports',{asset_id:csv.asset.asset_id,side:'right'});assert.equal(right.state,'succeeded',JSON.stringify(right.error));
  const cell=await c.job(`/api/imports/${left.output.import.import_id}/source-cell`,{record:1,column:'text_id'});
  assert.equal(cell.state,'succeeded',JSON.stringify(cell.error));
  assert.deepEqual(Object.keys(cell.output),['source_cell']);
  assert.equal(cell.output.source_cell.coordinate,'A2');assert.equal(cell.output.source_cell.stored_value,'00123');assert.equal(cell.output.source_cell.imported_value,'00123');
  assert.equal((await c.request(`/api/imports/${left.output.import.import_id}/materials/export?kind=profile`)).status,200);
  assert.equal((await c.request(`/api/imports/${left.output.import.import_id}/materials/export?kind=manifest`)).status,200);
  assert.equal((await c.request(`/api/imports/${left.output.import.import_id}/materials/export?kind=../../source`)).status,400);
  const checked=await c.job('/api/config/check',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config:{schema_version:1,fields:[{name:'text_id',left:'text_id',right:'text_id',type:'text',compare:false}],key:['text_id']}});
  assert.equal(checked.state,'succeeded',JSON.stringify(checked.error));
  const compared=await c.job('/api/runs',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config_asset_id:checked.output.config_asset_id});
  assert.equal(compared.state,'succeeded',JSON.stringify(compared.error));
  const revisionCell=await c.job(`/api/runs/${compared.output.revision.revision_id}/source-cell`,{side:'left',record:1,column:'text_id'});
  assert.equal(revisionCell.state,'succeeded',JSON.stringify(revisionCell.error));assert.equal(revisionCell.output.source_cell.coordinate,'A2');
  const oracle=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-cli-oracle-'));t.after(()=>fs.rm(oracle,{recursive:true,force:true}));
  const invoke=await loadBridgeInvoke(),leftEntry=app.session.getImport(left.output.import.import_id),rightEntry=app.session.getImport(right.output.import.import_id),configAsset=app.session.getAsset(checked.output.config_asset_id),directRun=path.join(oracle,'run');
  const code=await run(['compare',leftEntry.path,rightEntry.path,'--config',configAsset.path,'--out',directRun],{invoke,cwd:oracle,stdout:()=>{},stderr:()=>{}});assert.ok([0,1,3].includes(code));
  const serverReport=await fs.readFile(path.join(app.session.getRevision(compared.output.revision.revision_id).path,'report.json'));
  const cliReport=await fs.readFile(path.join(directRun,'report.json'));assert.deepEqual(serverReport,cliReport);
  const canonical=app.session.getAsset(app.session.getImport(left.output.import.import_id).canonical_asset_id);
  await fs.writeFile(canonical.path,'different\nvalue\n');
  const coreError=await c.job(`/api/imports/${left.output.import.import_id}/source-cell`,{record:1,column:'text_id'});
  assert.equal(coreError.state,'failed');assert.equal(coreError.error.code,'invalid_request');assert.equal(coreError.error.phase,'request');
});

test('mixed XLSX bundle restores its source identity after reset and keeps explicit CSV-only restore off',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',bytes);
  const workbook=(await c.job('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id})).output.workbook,sheet=workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const left=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'left',import_spec:spec});assert.equal(left.state,'succeeded',JSON.stringify(left.error));
  const csv=await c.upload('csv',await fs.readFile(fixture('lo-conversion-1900-reference.csv'))),right=await c.job('/api/imports',{asset_id:csv.asset.asset_id,side:'right'});assert.equal(right.state,'succeeded',JSON.stringify(right.error));
  const checked=await c.job('/api/config/check',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config:{schema_version:1,fields:[{name:'text_id',left:'text_id',right:'text_id',type:'text',compare:false}],key:['text_id']}});assert.equal(checked.state,'succeeded',JSON.stringify(checked.error));
  const compared=await c.job('/api/runs',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config_asset_id:checked.output.config_asset_id});assert.equal(compared.state,'succeeded',JSON.stringify(compared.error));
  const revision=compared.output.revision,report=await fs.readFile(path.join(app.session.getRevision(revision.revision_id).path,'report.json'));
  const packed=await c.job(`/api/runs/${revision.revision_id}/bundle`,{});assert.equal(packed.state,'succeeded',JSON.stringify(packed.error));
  const response=await fetch(`${app.origin}/api/bundles/${packed.output.bundle_asset_id}/export`,{headers:c.headers});assert.equal(response.status,200);const bundle=Buffer.from(await response.arrayBuffer());
  await fs.mkdir(task6Evidence,{recursive:true});await fs.writeFile(path.join(task6Evidence,'actual-mixed-v2.zip'),bundle);
  const slow=await slowBridge(t,3000),cancelApp=await startWorkbench({bridgePath:slow.bridge,xlsxEnabled:true});t.after(()=>cancelApp.close());
  const cancelClient=await client(cancelApp),cancelUpload=await cancelClient.upload('run',bundle),cancelStart=await cancelClient.request('/api/restores',{asset_id:cancelUpload.asset.asset_id});
  assert.equal(cancelStart.status,202);
  let entered=false;for(let i=0;i<500;i++){try{await fs.access(slow.entered);entered=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(entered,true,'restore cancellation must occur after regeneration reaches the injected bridge');
  const cancelled=await fetch(`${cancelApp.origin}/api/jobs/${cancelStart.body.job_id}`,{method:'DELETE',headers:cancelClient.headers});
  assert.equal(cancelled.status,200);const cancelledJob=(await cancelled.json()).job;assert.equal(cancelledJob.state,'cancelled');
  assert.equal(cancelApp.session.assets.size,1);assert.equal(cancelApp.session.imports.size,0);assert.equal(cancelApp.session.revisions.size,0);assert.equal(cancelApp.session.heads.size,0);
  const activeBridge=await slowBridge(t,1200),activeApp=await startWorkbench({bridgePath:activeBridge.bridge,xlsxEnabled:true});t.after(()=>activeApp.close());
  const activeClient=await client(activeApp),activeUpload=await activeClient.upload('run',bundle),firstStart=await activeClient.request('/api/restores',{asset_id:activeUpload.asset.asset_id});
  assert.equal(firstStart.status,202);let activeEntered=false;
  for(let i=0;i<500;i++){try{await fs.access(activeBridge.entered);activeEntered=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(activeEntered,true,'first restore must reach regeneration before duplicate request');
  const duplicate=await activeClient.request('/api/restores',{asset_id:activeUpload.asset.asset_id});assert.equal(duplicate.status,409);
  const onlyRestore=await activeClient.terminal(firstStart.body.job_id);assert.equal(onlyRestore.state,'succeeded',JSON.stringify(onlyRestore.error));
  assert.equal(activeApp.session.assets.size,5);assert.equal(activeApp.session.imports.size,2);assert.equal(activeApp.session.revisions.size,1);assert.equal(activeApp.session.heads.size,1);
  await c.request('/api/sessions/reset',{confirm:true});
  const uploaded=await c.upload('run',bundle);const restored=await c.job('/api/restores',{asset_id:uploaded.asset.asset_id});assert.equal(restored.state,'succeeded',JSON.stringify(restored.error));
  const fresh=restored.output.revision,restoredLeft=app.session.getImport(fresh.left_import_id),restoredSource=app.session.getAsset(restoredLeft.asset_id);
  assert.equal(restoredLeft.format,'xlsx');assert.equal(restoredSource.kind,'xlsx');assert.equal(restoredLeft.sha256,restoredLeft.adapter.canonical_csv_sha256);assert.equal(restoredSource.sha256,sha(bytes));
  assert.equal(app.session.assets.size,5);assert.equal(app.session.imports.size,2);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(fresh.revision_id).path,'report.json')),report);
  const branch=await c.job(`/api/runs/${fresh.revision_id}/branch`,{});assert.equal(branch.state,'succeeded',JSON.stringify(branch.error));assert.notEqual(branch.output.revision.revision_id,fresh.revision_id);assert.equal(branch.output.revision.left_import_id,fresh.left_import_id);
  const priorEntry=app.session.getImport(fresh.left_import_id),priorSource=await fs.readFile(priorEntry.source_path),priorProfile=await fs.readFile(priorEntry.profile_path);
  const afterHashUpload=await c.upload('run',bundle),beforeAfterHash={assets:[...app.session.assets.keys()].sort(),imports:[...app.session.imports.keys()].sort(),revisions:[...app.session.revisions.keys()].sort(),heads:[...app.session.heads],report:await fs.readFile(path.join(app.session.getRevision(branch.output.revision.revision_id).path,'report.json'))};
  let resolveEntered,releaseCandidate;const afterHashEntered=new Promise(resolve=>{resolveEntered=resolve;}),candidateGate=new Promise(resolve=>{releaseCandidate=resolve;});
  const originalPrepareAsset=app.session.prepareAsset.bind(app.session);let holdNextSource=true,hashedCandidate=null;
  app.session.prepareAsset=async(kind,name,file)=>{
    const prepared=await originalPrepareAsset(kind,name,file);
    if(holdNextSource&&kind==='xlsx'&&name==='restored-left.xlsx'){
      holdNextSource=false;hashedCandidate=prepared;resolveEntered(prepared);await candidateGate;
    }
    return prepared;
  };
  const afterHashStart=await c.request('/api/restores',{asset_id:afterHashUpload.asset.asset_id});assert.equal(afterHashStart.status,202);
  const hashed=await Promise.race([afterHashEntered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('restore did not reach post-hash asset barrier')),10000);timer.unref();})]);
  const afterHashCancel=fetch(`${app.origin}/api/jobs/${afterHashStart.body.job_id}`,{method:'DELETE',headers:c.headers});
  for(let i=0;i<100&&app.jobs.get(afterHashStart.body.job_id).state!=='cancelling';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(app.jobs.get(afterHashStart.body.job_id).state,'cancelling');releaseCandidate();
  const afterHashResponse=await afterHashCancel;assert.equal(afterHashResponse.status,200);const afterHashJob=await afterHashResponse.json();
  app.session.prepareAsset=originalPrepareAsset;
  assert.equal(afterHashJob.job.state,'cancelled',JSON.stringify(afterHashJob.job.error));assert.equal(hashed.sha256,sha(priorSource));
  assert.deepEqual([...app.session.assets.keys()].sort(),beforeAfterHash.assets);assert.deepEqual([...app.session.imports.keys()].sort(),beforeAfterHash.imports);
  assert.deepEqual([...app.session.revisions.keys()].sort(),beforeAfterHash.revisions);assert.deepEqual([...app.session.heads],beforeAfterHash.heads);
  assert.equal(app.session.assets.has(hashedCandidate.asset_id),false);
  assert.deepEqual(await fs.readFile(priorEntry.source_path),priorSource);assert.deepEqual(await fs.readFile(priorEntry.profile_path),priorProfile);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(branch.output.revision.revision_id).path,'report.json')),beforeAfterHash.report);
  const secondUpload=await c.upload('run',bundle),secondRestore=await c.job('/api/restores',{asset_id:secondUpload.asset.asset_id});
  assert.equal(secondRestore.state,'succeeded',JSON.stringify(secondRestore.error));assert.notEqual(secondRestore.output.revision.revision_id,fresh.revision_id);
  assert.notEqual(secondRestore.output.revision.left_import_id,fresh.left_import_id);assert.equal(app.session.imports.size,4);
  await fs.writeFile(path.join(task6Evidence,'restore-cancel-duplicate-receipt.json'),JSON.stringify({cancel:{bridge_entered:entered,state:cancelledJob.state,published_assets:cancelApp.session.assets.size,published_imports:cancelApp.session.imports.size,published_revisions:cancelApp.session.revisions.size},cancel_after_asset_hash:{candidate_sha256:hashed.sha256,expected_sha256:sha(priorSource),candidate_not_registered:!app.session.assets.has(hashedCandidate.asset_id),state:afterHashJob.job.state,old_head_report_source_profile_preserved:true},concurrent_duplicate:{http_status:duplicate.status,first_restore_state:onlyRestore.state,published_assets:activeApp.session.assets.size,published_imports:activeApp.session.imports.size,published_revisions:activeApp.session.revisions.size},sequential_double_restore:{first_revision:fresh.revision_id,second_revision:secondRestore.output.revision.revision_id,first_left_import:fresh.left_import_id,second_left_import:secondRestore.output.revision.left_import_id,total_imports:app.session.imports.size}},null,2)+'\n');
  const production=await startWorkbench({xlsxEnabled:false});t.after(()=>production.close());const p=await client(production),foreign=await p.upload('run',bundle),rejected=await p.job('/api/restores',{asset_id:foreign.asset.asset_id});
  assert.equal(rejected.state,'failed');assert.equal(rejected.error.code,'unsupported_format');assert.equal(production.session.imports.size,0);assert.equal(production.session.revisions.size,0);
});

test('two XLSX export preserves both originals and registers five owned assets only after verified restore',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app),bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx'));
  const xlsxLeft=await c.upload('xlsx',bytes),xlsxRight=await c.upload('xlsx',bytes);
  const workbook=(await c.job('/api/xlsx/catalog',{asset_id:xlsxLeft.asset.asset_id})).output.workbook,sheet=workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const left=await c.job('/api/imports',{asset_id:xlsxLeft.asset.asset_id,side:'left',import_spec:spec}),right=await c.job('/api/imports',{asset_id:xlsxRight.asset.asset_id,side:'right',import_spec:spec});
  assert.equal(left.state,'succeeded',JSON.stringify(left.error));assert.equal(right.state,'succeeded',JSON.stringify(right.error));
  const checked=await c.job('/api/config/check',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config:{schema_version:1,fields:[{name:'text_id',left:'text_id',right:'text_id',type:'text',compare:false}],key:['text_id']}});assert.equal(checked.state,'succeeded',JSON.stringify(checked.error));
  const compared=await c.job('/api/runs',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config_asset_id:checked.output.config_asset_id});assert.equal(compared.state,'succeeded',JSON.stringify(compared.error));
  const packed=await c.job(`/api/runs/${compared.output.revision.revision_id}/bundle`,{});assert.equal(packed.state,'succeeded',JSON.stringify(packed.error));
  const response=await fetch(`${app.origin}/api/bundles/${packed.output.bundle_asset_id}/export`,{headers:c.headers});assert.equal(response.status,200);const bundle=Buffer.from(await response.arrayBuffer());
  await fs.mkdir(task6Evidence,{recursive:true});await fs.writeFile(path.join(task6Evidence,'actual-two-xlsx-v2.zip'),bundle);
  await c.request('/api/sessions/reset',{confirm:true});const uploaded=await c.upload('run',bundle),restored=await c.job('/api/restores',{asset_id:uploaded.asset.asset_id});
  assert.equal(restored.state,'succeeded',JSON.stringify(restored.error));assert.equal(app.session.assets.size,6,'five restored assets plus the uploaded run bundle');assert.equal(app.session.imports.size,2);
  for(const id of [restored.output.revision.left_import_id,restored.output.revision.right_import_id]){
    const entry=app.session.getImport(id);assert.equal(entry.format,'xlsx');assert.equal(app.session.getAsset(entry.asset_id).kind,'xlsx');
    assert.equal(entry.adapter.source_sha256,sha(bytes));assert.equal(entry.adapter.canonical_csv_sha256,entry.sha256);
  }
  const duplicateUpload=await c.upload('run',bundle),duplicateRestore=await c.job('/api/restores',{asset_id:duplicateUpload.asset.asset_id});
  assert.equal(duplicateRestore.state,'succeeded',JSON.stringify(duplicateRestore.error));
  assert.notEqual(duplicateRestore.output.revision.revision_id,restored.output.revision.revision_id);
  assert.notEqual(duplicateRestore.output.revision.left_import_id,restored.output.revision.left_import_id);
  assert.equal(app.session.imports.size,4,'each restore creates fresh Imports');
  const beforeHeads=[...app.session.heads],beforeImports=[...app.session.imports.keys()].sort(),beforeRevisions=[...app.session.revisions.keys()].sort();
  const beforeReport=await fs.readFile(path.join(app.session.getRevision(duplicateRestore.output.revision.revision_id).path,'report.json'));
  const oracle=path.resolve(root,'../scripts/check-xlsx-oracle.py'),mutationDir=path.join(task6Evidence,'mutations-two-xlsx');await fs.mkdir(mutationDir,{recursive:true});
  const mutationReceipt=execFileSync('python3',[oracle,'--task6-mutate-from',path.join(task6Evidence,'actual-two-xlsx-v2.zip'),'--task6-mutations-output',mutationDir],{stdio:['ignore','pipe','pipe']});
  await fs.writeFile(path.join(task6Evidence,'right-side-mutation-python-receipt.json'),mutationReceipt);
  const rightMutation=await c.upload('run',await fs.readFile(path.join(mutationDir,'profile_mode_changed_right.zip'))),rightFailure=await c.job('/api/restores',{asset_id:rightMutation.asset.asset_id});
  assert.equal(rightFailure.state,'failed');assert.equal(rightFailure.error.code,'xlsx_conversion_mismatch');
  assert.deepEqual([...app.session.heads],beforeHeads);assert.deepEqual([...app.session.imports.keys()].sort(),beforeImports);assert.deepEqual([...app.session.revisions.keys()].sort(),beforeRevisions);
  assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(duplicateRestore.output.revision.revision_id).path,'report.json')),beforeReport);
  await fs.writeFile(path.join(task6Evidence,'right-side-partial-failure-receipt.json'),JSON.stringify({id:'profile_mode_changed_right',archive_sha256:sha(await fs.readFile(path.join(mutationDir,'profile_mode_changed_right.zip'))),expected_code:'xlsx_conversion_mismatch',observed_code:rightFailure.error.code,state:rightFailure.state,left_reconversion_completes_before_right_rejection:true,head_imports_revisions_report_unchanged:true},null,2)+'\n');
  const quotaReceipts=[];
  for(const limits of [{assets:5},{imports:1}]){
    const constrained=await startWorkbench({xlsxEnabled:true,limits});t.after(()=>constrained.close());const limited=await client(constrained),input=await limited.upload('run',bundle);
    const rejected=await limited.job('/api/restores',{asset_id:input.asset.asset_id});assert.equal(rejected.state,'failed');assert.equal(rejected.error.code,'quota_exceeded');
    assert.equal(constrained.session.assets.size,1);assert.equal(constrained.session.imports.size,0);assert.equal(constrained.session.revisions.size,0);assert.equal(constrained.session.heads.size,0);
    quotaReceipts.push({limit:limits,expected_code:'quota_exceeded',observed_code:rejected.error.code,uploaded_bundle_asset_retained:constrained.session.assets.size===1,published_imports:constrained.session.imports.size,published_revisions:constrained.session.revisions.size});
  }
  await fs.writeFile(path.join(task6Evidence,'restore-quota-receipt.json'),JSON.stringify({status:'PASS',cases:quotaReceipts},null,2)+'\n');
});

test('deeply altered v2 materials with refreshed outer hashes fail before restore publication',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const source=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',source);
  const workbook=(await c.job('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id})).output.workbook,sheet=workbook.sheets.find(item=>item.selectable);
  const spec={schema_version:1,source_sha256:workbook.source_sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:['stored_text','decimal_lexeme','stored_text','excel_date','zero_padded_identifier','stored_text'].map((mode,index)=>({column:index+1,mode})),formula_policy:'reject'};
  const left=await c.job('/api/imports',{asset_id:xlsx.asset.asset_id,side:'left',import_spec:spec});
  const csv=await c.upload('csv',await fs.readFile(fixture('lo-conversion-1900-reference.csv'))),right=await c.job('/api/imports',{asset_id:csv.asset.asset_id,side:'right'});
  assert.equal(left.state,'succeeded',JSON.stringify(left.error));assert.equal(right.state,'succeeded',JSON.stringify(right.error));
  const checked=await c.job('/api/config/check',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config:{schema_version:1,fields:[{name:'text_id',left:'text_id',right:'text_id',type:'text',compare:false}],key:['text_id']}});
  const compared=await c.job('/api/runs',{left_import_id:left.output.import.import_id,right_import_id:right.output.import.import_id,config_asset_id:checked.output.config_asset_id});
  assert.equal(compared.state,'succeeded',JSON.stringify(compared.error));
  const packed=await c.job(`/api/runs/${compared.output.revision.revision_id}/bundle`,{}),exported=await fetch(`${app.origin}/api/bundles/${packed.output.bundle_asset_id}/export`,{headers:c.headers});
  const bundlePath=path.join(task6Evidence,'actual-mixed-v2-mutation-base.zip');await fs.writeFile(bundlePath,Buffer.from(await exported.arrayBuffer()));
  const mutationsDir=path.join(task6Evidence,'mutations');await fs.mkdir(mutationsDir,{recursive:true});
  const oracle=path.resolve(root,'../scripts/check-xlsx-oracle.py');
  const mutationReceipt=execFileSync('python3',[oracle,'--task6-mutate-from',bundlePath,'--task6-alternate-source',fixture('lo-conversion-1904.xlsx'),'--task6-mutations-output',mutationsDir],{stdio:['ignore','pipe','pipe']});
  await fs.writeFile(path.join(task6Evidence,'deep-mutation-python-receipt.json'),mutationReceipt);
  const beforeHead=compared.output.revision.revision_id,beforeHeads=[...app.session.heads],beforeImports=[...app.session.imports.keys()].sort(),beforeRevisions=[...app.session.revisions.keys()].sort();
  const beforeReport=await fs.readFile(path.join(app.session.getRevision(beforeHead).path,'report.json'));
  const cases=[
    ['profile_mode_changed','xlsx_conversion_mismatch'],['profile_schema_changed','invalid_bundle'],['adapter_mapping_changed','xlsx_conversion_mismatch'],
    ['adapter_warning_changed','xlsx_conversion_mismatch'],['adapter_counts_changed','xlsx_conversion_mismatch'],['adapter_version_changed','xlsx_conversion_mismatch'],
    ['canonical_csv_changed','xlsx_conversion_mismatch'],['date_system_rebound','xlsx_conversion_mismatch'],['forged_core_report','replay_mismatch'],
  ];
  const observed=[];
  for(const [name,code] of cases){
    const bytes=await fs.readFile(path.join(mutationsDir,`${name}.zip`)),uploaded=await c.upload('run',bytes);
    const assetsBefore=app.session.assets.size,failed=await c.job('/api/restores',{asset_id:uploaded.asset.asset_id});
    assert.equal(failed.state,'failed',`${name}: ${JSON.stringify(failed.error)}`);assert.equal(failed.error.code,code,name);
    observed.push({id:name,archive_sha256:sha(bytes),expected_code:code,observed_code:failed.error.code,restore_state:failed.state});
    assert.equal(app.session.assets.size,assetsBefore,`${name}: failed restore published staged assets`);
    assert.deepEqual([...app.session.heads],beforeHeads,`${name}: failed restore changed branch heads`);
    assert.deepEqual([...app.session.imports.keys()].sort(),beforeImports,`${name}: failed restore changed imports`);
    assert.deepEqual([...app.session.revisions.keys()].sort(),beforeRevisions,`${name}: failed restore changed revisions`);
    assert.deepEqual(await fs.readFile(path.join(app.session.getRevision(beforeHead).path,'report.json')),beforeReport,`${name}: failed restore changed report`);
  }
  await fs.writeFile(path.join(task6Evidence,'deep-mutation-restore-results.json'),JSON.stringify({status:'PASS',outer_hashes_consistent:true,cases:observed,atomicity:'head/import/revision/report unchanged; failed candidate assets not published'},null,2)+'\n');
});

test('xlsx_routes_keep_auth_origin_and_full_envelope_limits',async t=>{
  const app=await startWorkbench({xlsxEnabled:true,limits:{response_bytes:300}});t.after(()=>app.close());const c=await client(app);
  const defaults=await startWorkbench({xlsxEnabled:false});t.after(()=>defaults.close());
  assert.deepEqual((await (await fetch(defaults.origin+'/api/capabilities',{headers:{authorization:`Bearer ${defaults.token}`} })).json()).formats,['csv']);
  assert.equal((await fetch(defaults.origin+'/api/assets?kind=xlsx',{method:'POST',headers:{authorization:`Bearer ${defaults.token}`,'content-type':'application/octet-stream'},body:'x'})).status,422);
  const unauth=[
    fetch(app.origin+'/api/assets?kind=xlsx',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'x'}),
    fetch(app.origin+'/api/imports',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
    fetch(app.origin+'/api/imports/00000000-0000-4000-8000-000000000000',{headers:{}}),
    fetch(app.origin+'/api/imports/00000000-0000-4000-8000-000000000000/source-cell',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
    fetch(app.origin+'/api/imports/00000000-0000-4000-8000-000000000000/materials/export?kind=profile'),
    fetch(app.origin+'/api/runs/00000000-0000-4000-8000-000000000000/source-cell',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
  ];
  assert.deepEqual(await Promise.all(unauth.map(async response=>(await response).status)),Array(unauth.length).fill(401));
  assert.equal((await fetch(app.origin+'/api/xlsx/catalog',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(app.origin+'/api/xlsx/catalog',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json',origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(app.origin+'/api/imports',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json',origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(app.origin+'/api/imports/00000000-0000-4000-8000-000000000000/source-cell',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json',origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(app.origin+'/api/imports/00000000-0000-4000-8000-000000000000/materials/export?kind=profile',{headers:{authorization:`Bearer ${app.token}`,origin:'http://evil.example'}})).status,403);
  assert.equal((await fetch(app.origin+'/api/runs/00000000-0000-4000-8000-000000000000/source-cell',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/json',origin:'http://evil.example'},body:'{}'})).status,403);
  assert.equal((await c.request('/api/capabilities')).status,413);
  const bytes=await fs.readFile(fixture('lo-conversion-1900.xlsx')),xlsx=await c.upload('xlsx',bytes);assert.equal(xlsx.status,201,JSON.stringify(xlsx));
  const queued=await c.request('/api/xlsx/catalog',{asset_id:xlsx.asset.asset_id});assert.equal(queued.status,202);
  for(let i=0;i<600&&['running','cancelling'].includes(app.jobs.get(queued.body.job_id).state);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const job=app.jobs.get(queued.body.job_id);assert.equal(job.state,'failed');assert.equal(job.error.code,'response_limit_exceeded');
  assert.equal((await c.request('/api/jobs/'+queued.body.job_id)).status,413);
});
