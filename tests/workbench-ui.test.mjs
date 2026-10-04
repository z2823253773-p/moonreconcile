import assert from 'node:assert/strict';
import test from 'node:test';
import { invoke_bridge as invoke } from '../_build/js/debug/build/cmd/bridge/bridge.js';
import { createWorkbenchState } from '../workbench/public/state.mjs';
import { renderConfigView } from '../workbench/public/config-view.mjs';
import { renderImportView } from '../workbench/public/import-view.mjs';

class FakeNode {
  constructor(tag) { this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.value='';this.disabled=false;this.nodeType=1;this._text='';this.classList={add:()=>{},remove:()=>{}}; }
  set textContent(value) { this._text=String(value);this.children=[]; }
  get textContent() { return this._text+this.children.map((child)=>child.textContent).join(''); }
  setAttribute(key,value) { this.attrs[key]=String(value);if(key==='id')this.id=String(value); }
  addEventListener(type,fn) { (this.listeners[type]??=[]).push(fn); }
  append(...nodes) { for(const node of nodes){if(node==null)continue;node.parent=this;this.children.push(node);} }
  replaceChildren(...nodes) { this.children=[];this._text='';this.append(...nodes); }
  querySelectorAll(selector) { const selectors=selector.split(',').map((s)=>s.trim());return walk(this).filter((n)=>selectors.includes(n.tag)||selectors.some((s)=>s.startsWith('.')&&n.className?.split(' ').includes(s.slice(1)))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  after(node) { const siblings=this.parent.children;siblings.splice(siblings.indexOf(this)+1,0,node);node.parent=this.parent; }
  remove() { if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1); }
  fire(type,details={}) { return Promise.all((this.listeners[type]??[]).map((fn)=>fn({preventDefault(){},dataTransfer:{dropEffect:'none',files:[]},...details}))); }
}

function walk(root) { return [root,...root.children.flatMap(walk)]; }
function makeDocument() { const body=new FakeNode('body');return {body,createElement:(tag)=>new FakeNode(tag),createTextNode:(text)=>{const node=new FakeNode('#text');node.textContent=text;return node;}}; }
function buttonBy(root,text) { const node=walk(root).find((item)=>item.tag==='button'&&item.textContent===text);assert.ok(node,`button ${text} exists`);return node; }
function inputByLabel(root,text) { const node=walk(root).find((item)=>item.tag==='label'&&item.textContent.startsWith(text));assert.ok(node,`label ${text} exists`);return node.children.find((item)=>['input','textarea','select'].includes(item.tag)); }
function configWith({mappingCount=0,candidates=0}={}) {
  const fields=Array.from({length:Math.max(candidates,1)},(_,i)=>({name:`field-${i}`,left:`left-${i}`,right:`right-${i}`,type:'text',compare:true,trim_ascii:i===0,lower_ascii:false,left_values:i===0?Object.fromEntries(Array.from({length:mappingCount},(_,j)=>[`key-${j}`,`value-${j}`])):{},right_values:{},missing:[],both_missing:'equal',abs_tol:'0',rel_tol:'0',days_tol:0}));
  const config={schema_version:1,fields,key:[],ignore_left:[],ignore_right:[],candidates:candidates?{fields:Array.from({length:candidates},(_,i)=>({field:`field-${i}`,metric:'exact',weight:1})),threshold:1,blocking:[]}:null};
  assert.equal(JSON.parse(invoke(JSON.stringify({op:'check_config',config}))).ok,true);
  return config;
}
function mountConfig(config,{headersLeft=['left-0','unused-left'],headersRight=['right-0','unused-right']}={}) {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const dispose=renderConfigView({root,store,api:{}});
  store.update({left_import_id:'left-import',right_import_id:'right-import',left_headers:headersLeft,right_headers:headersRight,config,config_asset_id:'validated-config',draft_dirty:false});
  return {root,store,dispose};
}

test('candidate scoring and the 49-to-50 mapping boundary remain reachable', async () => {
  const {root,dispose}=mountConfig(configWith({mappingCount:49,candidates:51}));
  let candidateSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('候选评分字段'));
  await buttonBy(candidateSection,'下一页').fire('click');
  candidateSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('候选评分字段'));
  assert.ok(walk(candidateSection).some((node)=>node.tag==='input'&&node.value==='field-50'));
  let mappingSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('左侧值映射'));
  await buttonBy(mappingSection,'添加').fire('click');
  mappingSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('左侧值映射'));
  assert.match(mappingSection.textContent,/1–50 \/ 50/);
  assert.equal(mappingSection.querySelectorAll('input').length,100);
  dispose();
});

test('validated rules list unmapped columns and transformations, then hide binding on edit', async () => {
  const config=configWith();config.key=['field-0'];config.ignore_right=['unused-right'];config.fields[0].left_values={A:'a'};config.fields[0].compare=false;
  const {root,store,dispose}=mountConfig(config);
  assert.match(root.textContent,/unused-left/);
  assert.match(root.textContent,/字段名|逻辑字段/);
  assert.match(root.textContent,/主键/);
  assert.match(root.textContent,/ASCII/);
  assert.match(root.textContent,/A → a/);
  assert.match(root.textContent,/候选/);
  assert.match(root.textContent,/未映射且未忽略/);
  assert.match(root.textContent,/当前规则已校验，可运行新比较更新结果/);
  const fieldName=inputByLabel(root,'逻辑字段名');fieldName.value='changed';await fieldName.fire('input');
  assert.equal(store.get().config_asset_id,null);
  assert.equal(root.querySelector('.validation-summary').hidden,true);
  assert.equal(buttonBy(root,'导出已校验配置').disabled,true);
  dispose();
});

test('late compare and summary responses cannot clear stale edits', async () => {
  const document=makeDocument();globalThis.document=document;const appRoot=new FakeNode('main');document.querySelector=()=>appRoot;
  globalThis.location={origin:'http://127.0.0.1:7777',hash:'#token=ui-test',pathname:'/',search:''};globalThis.history={replaceState(){}};
  let compareNumber=0,releaseCompare,releaseSummary;const jobRequests=new Map();
  const preview={headers:['id'],row_count:1,column_count:1,rows:[{record:1,cells:[{column:'id',value:'1',truncated:false}]}],offset:0,next_offset:1,has_more:false};
  const validConfig={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:true,trim_ascii:false,lower_ascii:false,left_values:{},right_values:{},missing:[],both_missing:'equal',abs_tol:'0',rel_tol:'0',days_tol:0}],key:['id'],ignore_left:[],ignore_right:[],candidates:null};
  const ok=(body)=>new Response(JSON.stringify({ok:true,...body}),{status:200,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(url)=>{
    const path=new URL(url).pathname;
    if(path==='/api/examples/orders'){jobRequests.set('example',{left_import_id:'left',right_import_id:'right',config_asset_id:'cfg',source_label:'合成 orders'});return ok({job_id:'example'});}
    if(path==='/api/imports/left'||path==='/api/imports/right')return ok({import:{import_id:path.split('/').at(-1)},asset:{asset_id:`asset-${path.split('/').at(-1)}`,name:`${path.split('/').at(-1)}.csv`,bytes:6,sha256:'a'.repeat(64)}});
    if(path.endsWith('/preview')){const id=`preview-${path.split('/')[3]}`;jobRequests.set(id,{preview});return ok({job_id:id});}
    if(path==='/api/configs/cfg/export')return new Response(JSON.stringify(validConfig));
    if(path==='/api/runs'){compareNumber++;return ok({job_id:`compare-${compareNumber}`});}
    if(path.startsWith('/api/jobs/')){
      const id=path.split('/').at(-1);
      if(id==='example'||id.startsWith('preview-'))return ok({job:{state:'succeeded',output:jobRequests.get(id)}});
      if(id==='compare-1')return ok({job:{state:'succeeded',output:{revision:{revision_id:'revision-1',exit_code:0}}}});
      if(id==='compare-2')return await new Promise((resolve)=>{releaseCompare=()=>resolve(ok({job:{state:'succeeded',output:{revision:{revision_id:'revision-2',exit_code:0}}}}));});
    }
    if(path.endsWith('/summary')){
      if(path.includes('revision-1'))return ok({revision:{revision_id:'revision-1',exit_code:0},computation:{status:'complete'},summary:{}});
      return await new Promise((resolve)=>{releaseSummary=()=>resolve(ok({revision:{revision_id:'revision-2',exit_code:0},computation:{status:'complete'},summary:{}}));});
    }
    throw new Error(`Unexpected request ${path}`);
  };
  await import('../workbench/public/app.mjs?race-test');
  await buttonBy(appRoot,'载入合成 orders 示例').fire('click');
  await waitFor(()=>walk(appRoot).some((node)=>node.textContent.includes('id')));
  await buttonBy(appRoot,'运行核心比较').fire('click');
  await waitFor(()=>walk(appRoot).some((node)=>node.textContent.includes('revision-1')));
  await buttonBy(appRoot,'运行核心比较').fire('click');
  await waitFor(()=>typeof releaseCompare==='function');
  assert.equal(buttonBy(appRoot,'导出已校验配置').disabled,false,'read-only config export remains available during the compare job');
  assert.equal(inputByLabel(appRoot,'逻辑字段名').disabled,true,'rule editing is locked during the compare job');
  const name=inputByLabel(appRoot,'逻辑字段名');name.value='edited-during-compare';await name.fire('input');
  releaseCompare();await waitFor(()=>typeof releaseSummary==='function');
  const afterJobNotice=appRoot.querySelector('.stale-notice');assert.ok(afterJobNotice,'stale remains after old comparison completes');
  const currentName=inputByLabel(appRoot,'逻辑字段名');currentName.value='edited-during-summary';await currentName.fire('input');
  releaseSummary();await waitFor(()=>walk(appRoot).some((node)=>node.textContent.includes('revision-2 · 旧版本')));
  assert.ok(appRoot.querySelector('.stale-notice'),'late summary does not clear stale state');
});

test('replacing an example side displays the uploaded filename and clears the blanket example label', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('section'),store=createWorkbenchState();
  let nextJob=0;const jobs=new Map();
  const api={
    request:async(path,{body}={})=>{
      if(path==='/api/examples/orders'){const result={left_import_id:'left',right_import_id:'right',config_asset_id:'cfg',source_label:'合成 orders'};jobs.set('j-example',result);return{job_id:'j-example'};}
      if(path==='/api/imports/left'||path==='/api/imports/right'){const id=path.split('/').at(-1);return{import:{import_id:id},asset:{asset_id:`asset-${id}`,name:`${id}.csv`,bytes:6,sha256:'b'.repeat(64)}};}
      if(path.startsWith('/api/imports/')&&path.endsWith('/preview')){const id=`j-preview-${++nextJob}`,side=path.includes('/left/')?'left':'right';jobs.set(id,{preview:{headers:['id'],row_count:1,column_count:1,rows:[],offset:0,next_offset:1,has_more:false}});return{job_id:id};}
      if(path==='/api/imports') {const id=`j-import-${++nextJob}`,file=body.side;const entry={import:{import_id:`new-${file}`},preview:{headers:['id'],row_count:1,column_count:1,rows:[],offset:0,next_offset:1,has_more:false}};jobs.set(id,entry);return{job_id:id};}
      throw new Error(path);
    },waitJob:async(id)=>({output:jobs.get(id)}),upload:async(_kind,file)=>({asset_id:'fresh-asset',name:file.name,bytes:8,sha256:'c'.repeat(64)}),download:async()=>new Blob([JSON.stringify({schema_version:1,fields:[],key:[],ignore_left:[],ignore_right:[],candidates:null})]),
  };
  renderImportView({root,store,api});await buttonBy(root,'载入合成 orders 示例').fire('click');
  await waitFor(()=>Boolean(store.get().left_import_id));
  const file=inputByLabel(root,'左侧来源 CSV');file.files=[{name:'actual-export.csv'}];await file.fire('change');
  await waitFor(()=>store.get().left_import_id==='new-left');
  const leftCard=walk(root).find((node)=>node.className==='source-card'&&node.textContent.includes('左侧来源'));
  assert.match(leftCard.textContent,/actual-export\.csv/);assert.doesNotMatch(leftCard.textContent,/合成 orders/);
  assert.doesNotMatch(root.textContent,/当前示例来源：合成 orders/);
});

test('a delayed canonical-config download cannot validate a rule edited while waiting', async () => {
  const config=configWith();
  let releaseText,downloadStarted=false;
  const api={
    upload:async()=>({asset_id:'uploaded-config'}),
    request:async()=>({job_id:'check-job'}),
    waitJob:async()=>({output:{config_asset_id:'normalized-config'}}),
    download:async()=>({text:()=>{downloadStarted=true;return new Promise((resolve)=>{releaseText=()=>resolve(JSON.stringify(config));});}}),
  };
  const document=makeDocument();globalThis.document=document;const testRoot=new FakeNode('main'),testStore=createWorkbenchState();
  const cleanup=renderConfigView({root:testRoot,store:testStore,api});
  testStore.update({left_import_id:'left-import',right_import_id:'right-import',left_headers:['left-0'],right_headers:['right-0'],config,config_asset_id:'validated-config',draft_dirty:false});
  const run=buttonBy(testRoot,'校验并保存规则').fire('click');
  await waitFor(()=>downloadStarted);
  const name=inputByLabel(testRoot,'逻辑字段名');name.value='edited-during-download';await name.fire('input');
  releaseText();await run;
  assert.equal(testStore.get().config_asset_id,null);
  assert.equal(testStore.get().config.fields[0].name,'edited-during-download');
  assert.match(testRoot.textContent,/校验期间来源或规则已变化/);
  cleanup();
});

test('drag and drop cannot replace a source during a global job', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('section'),store=createWorkbenchState();
  let uploads=0;const api={upload:async()=>{uploads++;return{asset_id:'drop-asset'};}};
  store.update({left_import_id:'existing-left',active_job:{job_id:'compare',state:'running'}});
  renderImportView({root,store,api});
  const drop=walk(root).find((node)=>node.className==='drop-zone');
  await drop.fire('drop',{dataTransfer:{files:[{name:'replacement.csv'}]}});
  assert.equal(uploads,0);assert.equal(store.get().left_import_id,'existing-left');
  assert.match(root.textContent,/任务进行中，完成或取消后再替换来源/);
});

test('blank missing markers remain editable and clearing ignore lists creates empty arrays', async () => {
  const config=configWith();config.fields[0].missing=[''];config.ignore_left=['unused-left'];
  const {root,store,dispose}=mountConfig(config);
  assert.match(root.textContent,/缺失标记（空值也可作为一项）（1）/);
  let missingSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('缺失标记'));
  await buttonBy(missingSection,'删除缺失标记').fire('click');
  assert.deepEqual(store.get().config.fields[0].missing,[]);
  missingSection=walk(root).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('缺失标记'));
  await buttonBy(missingSection,'添加').fire('click');
  assert.deepEqual(store.get().config.fields[0].missing,['']);
  const ignore=inputByLabel(root,'忽略左侧列（每行一项）');ignore.value='';await ignore.fire('input');
  assert.deepEqual(store.get().config.ignore_left,[]);
  dispose();
});

async function waitFor(predicate) { for(let i=0;i<100;i++){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,0));}throw new Error('Timed out waiting for UI state'); }
