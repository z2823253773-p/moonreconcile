import assert from 'node:assert/strict';
import test from 'node:test';
import { renderXlsxSelection } from '../workbench/public/xlsx-view.mjs';

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
