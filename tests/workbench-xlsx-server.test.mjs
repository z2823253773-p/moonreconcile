import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { startWorkbench } from '../workbench/server.mjs';
import { run } from '../cli/main.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const fixture=name=>path.join(root,'fixtures','xlsx',name);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function client(app) {
  const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const request=async(route,body,extra={})=>{const response=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};};
  const terminal=async(id)=>{for(let i=0;i<500;i++){const result=await request(`/api/jobs/${id}`);const current=result.body.job;if(current&&!['running','cancelling'].includes(current.state))return current;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('job wait timed out');};
  const job=async(route,body)=>{const start=await request(route,body);assert.equal(start.status,202,JSON.stringify(start.body));return terminal(start.body.job_id);};
  const upload=async(kind,bytes)=>{const response=await fetch(`${app.origin}/api/assets?kind=${kind}`,{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/octet-stream','x-filename':'source.xlsx'},body:bytes});const body=await response.json();return {status:response.status,...body};};
  return {headers,request,job,terminal,upload};
}

test('csv_wire_shape_unchanged and xlsx_requires_exact_bound_profile',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
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
  const bridge=path.join(dir,'bridge.mjs'),real=new URL('../_build/js/debug/build/cmd/bridge/bridge.js',import.meta.url).href;
  await fs.writeFile(bridge,`import {invoke_bridge as core} from ${JSON.stringify(real)};export function invoke_bridge(s){if(JSON.parse(s).csv?.includes('text_id'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delay});return core(s);}`);
  return bridge;
}

test('quota_during_conversion_keeps_registered_state_and_removes_candidates',async t=>{
  const bridge=await slowBridge(t),app=await startWorkbench({bridgePath:bridge,xlsxEnabled:true,limits:{session_bytes:30000,kill_ms:100}});t.after(()=>app.close());const c=await client(app);
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
  const bridge=await slowBridge(t,1200),app=await startWorkbench({bridgePath:bridge,xlsxEnabled:true,limits:{job_ms:1000,kill_ms:50}});t.after(()=>app.close());const c=await client(app);
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

test('xlsx_routes_keep_auth_origin_and_full_envelope_limits',async t=>{
  const app=await startWorkbench({xlsxEnabled:true,limits:{response_bytes:300}});t.after(()=>app.close());const c=await client(app);
  const defaults=await startWorkbench();t.after(()=>defaults.close());
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
