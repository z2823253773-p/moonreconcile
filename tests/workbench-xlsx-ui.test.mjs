import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchState } from '../workbench/public/state.mjs';
import { renderImportView } from '../workbench/public/import-view.mjs';
import { renderXlsxSelection } from '../workbench/public/xlsx-view.mjs';
import { XLSX_LIMITS as hostXlsxLimits } from '../workbench/contracts.mjs';
import { XLSX_LIMITS as parserXlsxLimits } from '../workbench/xlsx/contracts.mjs';

class FakeNode {
  constructor(tag) { this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.nodeType=1;this.value='';this.disabled=false;this._text=''; }
  set textContent(value) { this._text=String(value);this.children=[]; }
  get textContent() { return this._text+this.children.map(child=>child.textContent).join(''); }
  setAttribute(key,value) { this.attrs[key]=String(value);if(key==='id')this.id=String(value); }
  addEventListener(type,listener) { (this.listeners[type]??=[]).push(listener); }
  append(...nodes) { for(const node of nodes){if(node==null)continue;node.parent=this;this.children.push(node);} }
  replaceChildren(...nodes) { this.children=[];this._text='';this.append(...nodes); }
  showModal() { this.open=true; }
  close() { this.open=false; }
  remove() { if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1); }
  querySelector() { return null; }
  async fire(type) { for(const listener of this.listeners[type]??[]) await listener({preventDefault(){}}); }
}
function walk(root) { return [root,...root.children.flatMap(walk)]; }
function setupDocument() {
  const body=new FakeNode('body');
  globalThis.document={body,createElement:tag=>new FakeNode(tag),createTextNode:text=>{const node=new FakeNode('#text');node.nodeType=3;node.textContent=text;return node;}};
  return body;
}
function byLabel(root,name) {
  const label=walk(root).find(node=>node.tag==='label'&&node.textContent.startsWith(name));
  assert.ok(label,`label ${name} exists`);return label.children.find(node=>['input','select'].includes(node.tag));
}

test('XLSX UI requires a deliberate visible worksheet/range/mode and disables hidden or other sheets',async()=>{
  const body=setupDocument(),root=new FakeNode('main');let confirmed=false;
  const workbook={xlsx_api_version:1,asset_id:'asset-xlsx',source_sha256:'a'.repeat(64),date_system:'1904',sheets:[
    {sheet_id:`${'a'.repeat(64)}:1`,name:'Visible',state:'visible',kind:'worksheet',selectable:true,value_cells:2,min_row:1,max_row:2,min_column:1,max_column:1},
    {sheet_id:`${'a'.repeat(64)}:2`,name:'Hidden',state:'hidden',kind:'worksheet',selectable:false,value_cells:1,min_row:1,max_row:1,min_column:1,max_column:1},
    {sheet_id:`${'a'.repeat(64)}:3`,name:'Chart',state:'visible',kind:'other',selectable:false,value_cells:0,min_row:null,max_row:null,min_column:null,max_column:null},
  ]};
  const api={request:async route=>{assert.equal(route,'/api/xlsx/catalog');return {job_id:'catalog-job'};},waitJob:async()=>({output:{workbook}})};
  const view=renderXlsxSelection({root,api,asset:{asset_id:'asset-xlsx',name:'sample.xlsx',bytes:128,sha256:'a'.repeat(64)},side:'left',onConfirmed:async()=>{confirmed=true;},onCancel(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const dialog=body.children.find(node=>node.tag==='dialog'),sheet=byLabel(dialog,'工作表');
  assert.equal(sheet.value,'','no worksheet is preselected');
  for(const name of ['Hidden','Chart']) { const option=walk(sheet).find(node=>node.tag==='option'&&node.textContent.startsWith(name));assert.equal(option.disabled,true,`${name} must be disabled`); }
  const visible=walk(sheet).find(node=>node.tag==='option'&&node.textContent.startsWith('Visible'));assert.equal(visible.disabled,false);
  assert.equal(walk(dialog).find(node=>node.tag==='button'&&node.textContent==='检查选择并转换').disabled,true);
  const modes=['stored_text','decimal_lexeme','excel_date','zero_padded_identifier'];
  sheet.value=`${'a'.repeat(64)}:1`;await sheet.fire('change');
  for(const [name,value] of [['标题行','1'],['起始列','1'],['结束列','1'],['最后一行','2']]) { const input=byLabel(dialog,name);input.value=value;await input.fire('input'); }
  await walk(dialog).find(node=>node.tag==='button'&&node.textContent==='更新范围和转换方式').fire('click');
  const mode=walk(dialog).find(node=>node.tag==='select'&&node.attrs['aria-label']==='第 1 列转换方式');assert.ok(mode);assert.equal(mode.value,'');
  assert.deepEqual(walk(mode).filter(node=>node.tag==='option').slice(1).map(option=>option.value),modes);
  assert.equal(confirmed,false);view.dispose();
});


const tick=()=>new Promise(resolve=>setImmediate(resolve));
const findButton=(root,text)=>{const node=walk(root).find(item=>item.tag==='button'&&item.textContent===text);assert.ok(node,`button ${text} exists`);return node;};
const errorDto=(phase,record,field)=>Object.assign(new Error('Invalid spreadsheet value.'),{code:'xlsx_value_mode_mismatch',phase,side:'left',record,field});
async function conversionAlert(error,{catalogFailure=false}={}) {
  const body=setupDocument();globalThis.confirm=()=>true;
  const hash='a'.repeat(64),workbook={source_sha256:hash,sheets:[{sheet_id:`${hash}:1`,name:'Synthetic',selectable:true,state:'visible',kind:'worksheet'}]};
  const api={request:async route=>({job_id:route}),waitJob:async id=>{if(catalogFailure||id==='/api/imports')throw error;return {output:{workbook}};}};
  const view=renderXlsxSelection({root:new FakeNode('main'),api,asset:{asset_id:'asset',name:'sample.xlsx',sha256:hash,bytes:1},side:'left',onConfirmed(){},onCancel(){}});
  await tick();const dialog=body.children[0];
  if(!catalogFailure){const sheet=byLabel(dialog,'工作表');sheet.value=`${hash}:1`;await sheet.fire('change');
    for(const [name,value] of [['标题行','1'],['起始列','1'],['结束列','1'],['最后一行','2']]){const input=byLabel(dialog,name);input.value=value;await input.fire('input');}
    await findButton(dialog,'更新范围和转换方式').fire('click');const mode=walk(dialog).find(node=>node.attrs['aria-label']==='第 1 列转换方式');mode.value='decimal_lexeme';await mode.fire('change');
    await findButton(dialog,'检查选择并转换').fire('click');await tick();
  }
  const text=walk(dialog).find(node=>node.attrs.role==='alert')?.textContent;view.dispose();return text;
}

test('XLSX conversion alert retains real physical row and A1 coordinates',async()=>{
  const alert=await conversionAlert(errorDto('xlsx',200,'AZ200'));
  assert.match(alert,/物理.*第 200 行/);assert.match(alert,/单元格 AZ200/);assert.doesNotMatch(alert,/逻辑记录/);
});
test('XLSX conversion preserves core including-header logical origin by phase',async()=>{
  const alert=await conversionAlert(errorDto('inspect_csv',2,'id'));
  assert.match(alert,/含表头的逻辑记录 2/);assert.match(alert,/字段 id/);assert.doesNotMatch(alert,/物理|工作簿级别/);
});
test('null-coordinate XLSX package rejection is workbook-level without a guessed cell',async()=>{
  const alert=await conversionAlert(Object.assign(errorDto('xlsx',null,null),{code:'xlsx_formula_rejected'}),{catalogFailure:true});
  assert.match(alert,/工作簿级别/);assert.doesNotMatch(alert,/单元格|物理第|A[0-9]|xl\//);
});

test('host and XLSX parser share the same frozen limit contract',()=>{
  assert.strictEqual(hostXlsxLimits,parserXlsxLimits);
  assert.equal(Object.isFrozen(hostXlsxLimits),true);
  assert.deepEqual(Object.keys(hostXlsxLimits),['compressed_bytes','entries','actual_unzip_bytes','xml_bytes','xml_depth','cell_bytes','csv_bytes','data_rows','columns']);
});

test('catalog failure removes the loading status while a pending catalog keeps it',async()=>{
  const body=setupDocument();let rejectCatalog;
  const catalogResult=new Promise((_,reject)=>{rejectCatalog=reject;});
  const api={request:async()=>({job_id:'catalog'}),waitJob:()=>catalogResult};
  const view=renderXlsxSelection({root:new FakeNode('main'),api,asset:{asset_id:'asset',name:'sample.xlsx',sha256:'a'.repeat(64),bytes:1},side:'left',onConfirmed(){},onCancel(){}});
  await tick();const dialog=body.children[0];
  assert.ok(walk(dialog).some(node=>node.attrs.role==='status'&&node.textContent.includes('正在读取工作簿清单')));
  rejectCatalog(Object.assign(new Error('Invalid workbook.'),{code:'invalid_xlsx',phase:'xlsx'}));
  await tick();
  assert.equal(walk(dialog).some(node=>node.attrs.role==='status'&&node.textContent.includes('正在读取工作簿清单')),false);
  assert.ok(walk(dialog).some(node=>node.attrs.role==='alert'&&node.textContent.includes('工作簿清单读取失败')));
  view.dispose();
});

function revisionModel() {
  setupDocument();globalThis.confirm=()=>true;const store=createWorkbenchState(),root=new FakeNode('main');
  const preview={headers:['id'],row_count:1,column_count:1,rows:[{record:1,cells:[{column:'id',value:'00123',truncated:false}]}],offset:0,next_offset:1,has_more:false};
  const profile={import_spec:{schema_version:1,source_sha256:'a'.repeat(64),sheet_id:`${'a'.repeat(64)}:1`,header_row:1,column_start:1,column_end:1,last_row:2,columns:[{column:1,mode:'stored_text'}],formula_policy:'reject'}};
  const manifest={worksheet:{name:'OriginalSheet',date_system:'1904'},row_mapping:{header_row:1,data_first_row:2,row_count:1,column_start:1,column_end:1},warnings:[]};
  const xlsx={asset:{asset_id:'original-xlsx',name:'original.xlsx',kind:'xlsx',sha256:'a'.repeat(64),bytes:12},import:{import_id:'xlsx-import',format:'xlsx',sha256:'b'.repeat(64)}};
  const csv={asset:{asset_id:'original-csv',name:'original.csv',kind:'csv',sha256:'c'.repeat(64),bytes:8},import:{import_id:'csv-import',sha256:'c'.repeat(64)}};
  const requests=[],downloads=[];let block=null,fail=null;
  const api={
    request:async(route,{body}={})=>{if(route==='/api/imports'){requests.push(body);return {job_id:'swap'};}if(route.endsWith('/preview'))return {job_id:'preview'};return route.endsWith('xlsx-import')?xlsx:csv;},
    waitJob:async id=>({output:id==='preview'?{preview}:{import:{import_id:`swapped-${requests.length}`,sha256:'d'.repeat(64)},preview}}),
    download:async route=>{downloads.push(route);if(route.includes('materials')){if(block)await block;if(fail)throw fail;return new Blob([JSON.stringify(route.endsWith('profile')?profile:manifest)]);}return new Blob([JSON.stringify({schema_version:1})]);},
  };
  const view=renderImportView({root,store,api,xlsxEnabled:true});
  const revision={revision_id:'branch',left_import_id:'xlsx-import',right_import_id:'csv-import',config_asset_id:'config'};
  return {root,store,view,revision,requests,downloads,profile,setBlock(value){block=value;},setFailure(value){fail=value;}};
}
test('branch revision retains original XLSX materials and explicit profile for swap while CSV stays ordinary',async()=>{
  const model=revisionModel();await model.view.bindRevision(model.revision);
  assert.match(model.root.textContent,/原始文件 SHA-256/);assert.match(model.root.textContent,/规范 CSV SHA-256/);assert.match(model.root.textContent,/OriginalSheet/);
  assert.ok(model.downloads.includes('/api/imports/xlsx-import/materials/export?kind=profile'));
  assert.ok(model.downloads.includes('/api/imports/xlsx-import/materials/export?kind=manifest'));
  await findButton(model.root,'交换左右并重置关联规则').fire('click');await tick();
  assert.deepEqual(model.requests,[{asset_id:'original-csv',side:'left'},{asset_id:'original-xlsx',side:'right',import_spec:model.profile.import_spec}]);
  assert.equal(model.store.get().left_import_id,'swapped-1');assert.equal(model.store.get().right_import_id,'swapped-2');model.view.dispose();
});
for(const interruption of ['material failure','generation change','revision selection change'])test(`branch material hydration is atomic on ${interruption}`,async()=>{
  const model=revisionModel(),old={...model.revision,revision_id:'old',left_import_id:'csv-import'};await model.view.bindRevision(old);
  const before=model.root.textContent,beforeState=model.store.get();let release;
  model.setBlock(new Promise(resolve=>{release=resolve;}));if(interruption==='material failure')model.setFailure(new Error('material unavailable'));
  const binding=model.view.bindRevision(model.revision);await tick();
  // The old cards and binding stay visible while registered materials are read.
  assert.equal(model.store.get().left_import_id,beforeState.left_import_id);assert.equal(model.store.get().revision.revision_id,'old');
  assert.equal(model.root.textContent,before);
  if(interruption==='generation change')model.store.invalidateRules();
  if(interruption==='revision selection change')model.store.update({revision:{...old,revision_id:'other-selection'}});
  release();await assert.rejects(binding,interruption==='material failure'?/material unavailable/:/已变化/);
  assert.equal(model.store.get().left_import_id,beforeState.left_import_id);assert.equal(model.store.get().right_import_id,beforeState.right_import_id);
  assert.equal(model.root.textContent,before);assert.equal(model.store.get().active_job,null);model.view.dispose();
});
