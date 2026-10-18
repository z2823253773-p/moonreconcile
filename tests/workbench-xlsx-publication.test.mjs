import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { startWorkbench } from '../workbench/server.mjs';
import { canonicalJsonStringify } from '../cli/io.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const importKeys=['import_id','asset_id','side','format','status','headers','row_count','column_count','sha256','adapter'].sort();
const columnName=index=>{let result='';for(let n=index;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;};

async function workbook(columns,{data=false}={}) {
  const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main',rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships',pkg='http://schemas.openxmlformats.org/package/2006/relationships';
  const headers=Array.from({length:columns},(_,i)=>`<c r="${columnName(i+1)}1" t="inlineStr"><is><t>h${i+1}</t></is></c>`).join('');
  const parts={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':`<Relationships xmlns="${pkg}"><Relationship Id="office" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Data" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="${pkg}"><Relationship Id="sheet" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="${main}"><sheetData><row r="1">${headers}</row>${data?'<row r="2"><c r="A2"><v>1</v></c></row>':''}</sheetData></worksheet>`,
  };
  const zip=new yazl.ZipFile(),chunks=[];
  const done=(async()=>{for await(const chunk of zip.outputStream)chunks.push(chunk);return Buffer.concat(chunks);})();
  for(const [name,xml] of Object.entries(parts))zip.addBuffer(Buffer.from(xml),name);
  zip.end();return done;
}

async function client(app) {
  const headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const request=async(route,body)=>{const response=await fetch(app.origin+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const job=async(route,body)=>{
    const start=await request(route,body);assert.equal(start.status,202,JSON.stringify(start.body));
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){const current=(await request(`/api/jobs/${start.body.job_id}`)).body.job;if(!['running','cancelling'].includes(current.state))return current;await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error('job wait timed out');
  };
  const upload=async(bytes,name='source.xlsx')=>{const response=await fetch(app.origin+'/api/assets?kind=xlsx',{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/octet-stream','x-filename':encodeURIComponent(name)},body:bytes});const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));return result.asset;};
  const spec=async(asset,columns,lastRow)=>{
    const catalog=await job('/api/xlsx/catalog',{asset_id:asset.asset_id});assert.equal(catalog.state,'succeeded',JSON.stringify(catalog.error));
    assert.equal(catalog.output.workbook.sheets[0].value_cells,columns+(lastRow===2?1:0));
    return {schema_version:1,source_sha256:asset.sha256,sheet_id:catalog.output.workbook.sheets[0].sheet_id,header_row:1,column_start:1,column_end:columns,last_row:lastRow,columns:Array.from({length:columns},(_,i)=>({column:i+1,mode:'stored_text'})),formula_policy:'reject'};
  };
  return {request,job,upload,spec};
}

test('xlsx sparse rectangle accepts over one million implicit blanks through worker core and API',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const columns=256,rows=3907,asset=await c.upload(await workbook(columns)),spec=await c.spec(asset,columns,rows+1);
  const result=await c.job('/api/imports',{asset_id:asset.asset_id,side:'left',import_spec:spec});
  assert.equal(result.state,'succeeded',JSON.stringify(result.error));
  const entry=result.output.import,internal=app.session.getImport(entry.import_id),canonical=app.session.getAsset(internal.canonical_asset_id);
  const headers=Array.from({length:columns},(_,i)=>`h${i+1}`),csv=Buffer.from(headers.join(',')+'\n'+(','.repeat(columns-1)+'\n').repeat(rows));
  assert.equal(rows*columns,1000192);
  assert.deepEqual(Object.keys(entry).sort(),importKeys);assert.equal(entry.row_count,rows);assert.equal(entry.column_count,columns);assert.deepEqual(entry.headers,headers);
  assert.deepEqual(await fs.readFile(canonical.path),csv);assert.equal(entry.sha256,sha(csv));assert.equal(entry.asset_id,asset.asset_id);
  const profileBytes=Buffer.from(canonicalJsonStringify({schema_version:1,adapter_id:'restricted-ooxml',adapter_version:'1.0.0',import_spec:spec}));
  const manifest=(await c.request(`/api/imports/${entry.import_id}/materials/export?kind=manifest`)).body;
  assert.deepEqual(manifest,{schema_version:1,adapter_id:'restricted-ooxml',adapter_version:'1.0.0',profile:{bytes:profileBytes.length,sha256:sha(profileBytes)},source:{bytes:asset.bytes,sha256:asset.sha256},canonical_csv:{bytes:csv.length,sha256:sha(csv)},worksheet:{sheet_id:spec.sheet_id,name:'Data',relationship_id:'sheet',part:'xl/worksheets/sheet1.xml',date_system:'1900'},row_mapping:{kind:'rectangle',header_row:1,data_first_row:2,row_count:rows,column_start:1,column_end:columns},warnings:[],conversion_counts:{blank:1000192,text:0,numeric_lexemes:0,expanded_exponents:0,booleans:0,dates:0,zero_padded_identifiers:0}});
  assert.equal(entry.adapter.import_manifest_sha256,sha(await fs.readFile(internal.adapter_manifest_path)));
  assert.equal(result.output.preview.rows.length,20);assert.equal(result.output.preview.has_more,true);assert.equal(result.output.preview.next_offset,20);
  assert.ok(result.output.preview.rows.every(row=>row.cells.length===columns&&row.cells.every(cell=>cell.value===''&&cell.utf8_bytes===0)));
});

test('xlsx accepts a 255 code point Unicode filename and preserves original public identity',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const name='😀中'.repeat(125)+'.xlsx';assert.equal([...name].length,255);
  const asset=await c.upload(await workbook(1,{data:true}),name),spec=await c.spec(asset,1,2);
  assert.equal(asset.name,name);
  const result=await c.job('/api/imports',{asset_id:asset.asset_id,side:'left',import_spec:spec});
  assert.equal(result.state,'succeeded',JSON.stringify(result.error));
  const entry=result.output.import,internal=app.session.getImport(entry.import_id),canonical=app.session.getAsset(internal.canonical_asset_id);
  assert.deepEqual(Object.keys(entry).sort(),importKeys);assert.equal(entry.asset_id,asset.asset_id);assert.equal(app.session.getAsset(entry.asset_id).name,name);
  assert.ok([...canonical.name].length<=255);assert.equal(entry.sha256,sha(Buffer.from('h1\n1\n')));
});

test('xlsx internal source_path binds to registered source and never appears in wire DTOs',async t=>{
  const app=await startWorkbench({xlsxEnabled:true});t.after(()=>app.close());const c=await client(app);
  const asset=await c.upload(await workbook(1,{data:true})),spec=await c.spec(asset,1,2);
  const result=await c.job('/api/imports',{asset_id:asset.asset_id,side:'left',import_spec:spec});assert.equal(result.state,'succeeded',JSON.stringify(result.error));
  const entry=app.session.getImport(result.output.import.import_id);
  assert.equal(entry.source_path,app.session.getAsset(asset.asset_id).path);
  assert.notEqual(entry.source_path,entry.path);assert.equal(Object.hasOwn(result.output.import,'source_path'),false);
  const publicImport=(await c.request(`/api/imports/${entry.import_id}`)).body.import;
  assert.deepEqual(Object.keys(publicImport).sort(),importKeys);assert.equal(JSON.stringify(publicImport).includes(entry.source_path),false);
});

for(const [name,counts] of [
  ['negative',{text:-1,numeric_lexemes:2}],
  ['fractional',{text:0.5,numeric_lexemes:0.5}],
  ['unsafe',{text:Number.MAX_SAFE_INTEGER+1}],
  ['wrong rectangle sum',{text:0}],
  ['expanded exponent exceeds numeric subcount',{text:1,expanded_exponents:1}],
])test(`xlsx parent rejects ${name} conversion counts after real conversion`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xlsx-count-candidate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const workerPath=path.join(dir,'worker.mjs');
  await fs.writeFile(workerPath,`import fs from 'node:fs/promises';import {executeTask} from ${JSON.stringify(new URL('../workbench/engine-host.mjs',import.meta.url).href)};import {loadBridgeInvoke} from ${JSON.stringify(new URL('../cli/bridge.mjs',import.meta.url).href)};process.on('message',async({job_id,task})=>{try{const output=await executeTask(task,{invoke:await loadBridgeInvoke(task.bridge_path),signal:new AbortController().signal});if(task.kind==='import'){const manifest=JSON.parse(await fs.readFile(output.adapter_manifest_path,'utf8'));Object.assign(manifest.conversion_counts,${JSON.stringify(counts)});await fs.writeFile(output.adapter_manifest_path,JSON.stringify(manifest));}process.send({job_id,type:'result',output},()=>process.disconnect());}catch(error){process.send({job_id,type:'error',error:error.error},()=>process.disconnect());}});`);
  const app=await startWorkbench({xlsxEnabled:true,workerPath});t.after(()=>app.close());const c=await client(app);
  const asset=await c.upload(await workbook(1,{data:true})),spec=await c.spec(asset,1,2),before=await fs.readdir(app.session.root);
  const result=await c.job('/api/imports',{asset_id:asset.asset_id,side:'left',import_spec:spec});
  assert.equal(result.state,'failed');assert.equal(result.error.code,'invalid_worker_output');assert.equal(app.session.assets.size,1);assert.equal(app.session.imports.size,0);assert.deepEqual(await fs.readdir(app.session.root),before);
});
