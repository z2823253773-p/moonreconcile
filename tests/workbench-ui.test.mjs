import assert from 'node:assert/strict';
import test from 'node:test';
import { invoke_bridge as invoke } from '../_build/js/debug/build/cmd/bridge/bridge.js';
import { createWorkbenchState } from '../workbench/public/state.mjs';
import { renderConfigView } from '../workbench/public/config-view.mjs';
import { renderImportView } from '../workbench/public/import-view.mjs';
import { renderResultView } from '../workbench/public/result-view.mjs';

class FakeNode {
  constructor(tag) { this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.value='';this.disabled=false;this.nodeType=1;this._text='';const self=this;this.classList={add:()=>{},remove:()=>{},contains:(name)=>self.className?.split(' ').includes(name)??false}; }
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
  showModal() { this.open=true; }
  close() { this.open=false; }
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
function mappingFixture() {
  const values=()=>{const map={};Object.defineProperty(map,'__proto__',{value:'special',enumerable:true,configurable:true,writable:true});map['10']='ten';map['2']='two';return map;};
  const field=(name,{left_values={},right_values={},missing=[]}={})=>({name,left:name,right:name,type:'text',compare:name!=='id',trim_ascii:false,lower_ascii:false,left_values,right_values,missing,both_missing:'equal',abs_tol:'0',rel_tol:'0',days_tol:0});
  return {schema_version:1,fields:[field('id'),field('status',{left_values:values(),right_values:values(),missing:['']}),field('memo')],key:['id'],ignore_left:[],ignore_right:[],candidates:null};
}
function coreConfigApi() {
  let serial=0;const uploads=new Map(),canonical=new Map(),jobs=new Map();
  return {
    upload:async(_kind,file)=>{const id=`upload-${++serial}`;uploads.set(id,JSON.parse(await file.text()));return{asset_id:id};},
    request:async(path,{body}={})=>{assert.equal(path,'/api/config/check');const checked=JSON.parse(invoke(JSON.stringify({op:'check_config',config:uploads.get(body.config_asset_id)})));assert.equal(checked.ok,true,JSON.stringify(checked.error));const id=`config-${serial}`,job=`job-${serial}`;canonical.set(id,checked.config);jobs.set(job,{config_asset_id:id});return{job_id:job};},
    waitJob:async(id)=>({output:jobs.get(id)}),
    download:async(path)=>new Blob([JSON.stringify(canonical.get(path.split('/')[3]))]),
  };
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

test('draft download stores canonical Config while the form keeps editable mapping rows locally', async () => {
  const config=mappingFixture(),document=makeDocument(),root=new FakeNode('main'),store=createWorkbenchState();globalThis.document=document;
  const api={request:async(path)=>{assert.equal(path,'/api/config/draft');return{job_id:'draft-job'};},waitJob:async()=>({output:{config_asset_id:'draft-asset'}}),download:async(path)=>{assert.equal(path,'/api/configs/draft-asset/export');return new Blob([JSON.stringify(config)]);}};
  renderConfigView({root,store,api});store.update({left_import_id:'left',right_import_id:'right',left_headers:['id','status','memo'],right_headers:['id','status','memo']});
  await buttonBy(root,'从当前列生成空白草稿').fire('click');
  assert.deepEqual(store.get().config,config,'draft state is canonical Config v1, never the editor FormModel');
  const statusCard=walk(root).find((node)=>node.tag==='article'&&node.className==='field-card'&&node.textContent.includes('字段 2: status'));
  const mapSection=walk(statusCard).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('左侧值映射'));
  assert.deepEqual(mapSection.querySelectorAll('input').map((input)=>input.value),['2','two','10','ten','__proto__','special']);
  assert.equal(store.get().config_asset_id,null);assert.equal(store.get().draft_dirty,true);
});

test('successful check stores canonical mappings and unrelated edits recheck to the same core result', async () => {
  const raw=mappingFixture(),expected=JSON.parse(invoke(JSON.stringify({op:'check_config',config:raw}))).config;
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState(),api=coreConfigApi();
  renderConfigView({root,store,api});store.update({left_import_id:'left',right_import_id:'right',left_headers:['id','status','memo'],right_headers:['id','status','memo'],config:raw,draft_dirty:true});
  await buttonBy(root,'校验并保存规则').fire('click');
  assert.deepEqual(store.get().config,expected,'validated state remains normalized Config v1, not the FormModel');
  assert.match(root.textContent,/缺失标记 \[""\]/);
  const memoCard=walk(root).find((node)=>node.tag==='article'&&node.className==='field-card'&&node.textContent.includes('字段 3: memo'));
  const memoName=inputByLabel(memoCard,'逻辑字段名');memoName.value='memo-renamed';await memoName.fire('input');
  await buttonBy(root,'校验并保存规则').fire('click');
  const rechecked=JSON.parse(invoke(JSON.stringify({op:'check_config',config:{...expected,fields:expected.fields.map((field)=>field.name==='memo'?{...field,name:'memo-renamed'}:field)}}))).config;
  assert.deepEqual(store.get().config,rechecked);
  assert.deepEqual(Object.entries(store.get().config.fields[1].left_values),[['2','two'],['10','ten'],['__proto__','special']]);
  assert.deepEqual(store.get().config.fields[1].missing,['']);
  const csv='id,status,memo\n1,__proto__,same\n2,2,same\n';
  const compared=JSON.parse(invoke(JSON.stringify({op:'compare',left_csv:csv,right_csv:csv,config:store.get().config})));
  assert.equal(compared.ok,true,JSON.stringify(compared.error));assert.equal(compared.result.exit_code,0);assert.equal(compared.result.summary.unresolved_count,0);
});

test('successful raw Config JSON import keeps canonical special mappings and blank missing marker', async () => {
  const raw=mappingFixture(),expected=JSON.parse(invoke(JSON.stringify({op:'check_config',config:raw}))).config;
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState(),api=coreConfigApi();
  renderConfigView({root,store,api});store.update({left_import_id:'left',right_import_id:'right',left_headers:['id','status','memo'],right_headers:['id','status','memo']});
  const file=inputByLabel(root,'导入配置 JSON');file.files=[{name:'mapped.json',text:async()=>JSON.stringify(raw)}];await file.fire('change');
  assert.deepEqual(store.get().config,expected,'imported validation publishes the core-normalized Config v1');
  assert.deepEqual(Object.entries(store.get().config.fields[1].right_values),[['2','two'],['10','ten'],['__proto__','special']]);
  assert.deepEqual(store.get().config.fields[1].missing,['']);
  const statusCard=walk(root).find((node)=>node.tag==='article'&&node.className==='field-card'&&node.textContent.includes('字段 2: status'));
  const mapSection=walk(statusCard).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('左侧值映射'));
  assert.deepEqual(mapSection.querySelectorAll('input').map((input)=>input.value),['2','two','10','ten','__proto__','special']);
  assert.match(root.textContent,/缺失标记 \[""\]/,'the checked summary distinguishes a blank item from an empty list');
});

test('invalid duplicate mapping stays local and can be fixed before lossless recheck', async () => {
  const raw=mappingFixture(),expected=JSON.parse(invoke(JSON.stringify({op:'check_config',config:raw}))).config;
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState(),api=coreConfigApi();
  renderConfigView({root,store,api});store.update({left_import_id:'left',right_import_id:'right',left_headers:['id','status','memo'],right_headers:['id','status','memo'],config:raw,draft_dirty:true});
  await buttonBy(root,'校验并保存规则').fire('click');
  assert.deepEqual(store.get().config,expected);
  const canonicalBefore=store.get().config;
  let statusCard=walk(root).find((node)=>node.tag==='article'&&node.className==='field-card'&&node.textContent.includes('字段 2: status'));
  let leftMap=walk(statusCard).find((node)=>node.tag==='section'&&node.children[0]?.textContent.startsWith('左侧值映射'));
  let mappingInputs=leftMap.querySelectorAll('input');
  mappingInputs[2].value='2';await mappingInputs[2].fire('input');
  assert.equal(store.get().config,canonicalBefore,'unrepresentable duplicate rows stay only in the local form');
  assert.equal(store.get().draft_dirty,true);assert.equal(store.get().config_asset_id,null);
  assert.equal(buttonBy(root,'导出已校验配置').disabled,true);
  assert.equal(walk(root).filter((node)=>node.className==='notice success validation-summary')[0].hidden,true);
  const invalidGeneration=store.generation();
  const memoCard=walk(root).find((node)=>node.tag==='article'&&node.className==='field-card'&&node.textContent.includes('字段 3: memo'));
  const memoName=inputByLabel(memoCard,'逻辑字段名');memoName.value='memo-renamed';await memoName.fire('input');
  assert.ok(store.generation()>invalidGeneration,'each additional unrepresentable edit invalidates async context');
  assert.equal(store.get().config,canonicalBefore);
  mappingInputs=leftMap.querySelectorAll('input');mappingInputs[2].value='10';await mappingInputs[2].fire('input');
  await buttonBy(root,'校验并保存规则').fire('click');
  assert.equal(store.get().config.fields[2].name,'memo-renamed');
  assert.deepEqual(Object.entries(store.get().config.fields[1].left_values),[['2','two'],['10','ten'],['__proto__','special']]);
  assert.deepEqual(store.get().config.fields[1].missing,['']);
  const csv='id,status,memo\n1,__proto__,same\n2,2,same\n';
  const compared=JSON.parse(invoke(JSON.stringify({op:'compare',left_csv:csv,right_csv:csv,config:store.get().config})));
  assert.equal(compared.ok,true,JSON.stringify(compared.error));assert.equal(compared.result.exit_code,0);assert.equal(compared.result.summary.unresolved_count,0);
});

test('result evidence reads source cells for paired records and keeps exact-pair locks across collection pages', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-ui',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'});
  const summary={revision,computation:{status:'complete',issues:[]},summary:{per_side:{left:{paired:1}},fields:{different:1}},structure:{left:{columns:1}},issues:[]};
  const requests=[];
  const api={request:async(path,{method='GET',body}={})=>{
    requests.push({path,method,body});
    if(path==='/api/imports/li')return{import:{import_id:'li',headers:['id']}};
    if(path==='/api/imports/ri')return{import:{import_id:'ri',headers:['id']}};
    if(path==='/api/runs/rev-ui/pairs?offset=0&limit=100')return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',source:'exact_key'}}],total:1,offset:0,next_offset:1,has_more:false};
    if(path==='/api/runs/rev-ui/pairs?offset=0&limit=20')return{items:[],total:1,offset:0,next_offset:0,has_more:true};
    if(path.startsWith('/api/runs/rev-ui/candidates?'))return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',score:10000,suggested:true}}],total:1,offset:0,next_offset:1,has_more:false};
    if(path.startsWith('/api/runs/rev-ui/records?'))return{items:[{source_index:0,item:{id:'L1',side:'left',record:1,status:'paired',reason:'matched'}}],total:1,offset:0,next_offset:1,has_more:false};
    if(path.startsWith('/api/runs/rev-ui/fields?'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};
    if(path.startsWith('/api/runs/rev-ui/issues?')||path.startsWith('/api/runs/rev-ui/decisions?'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};
    if(path==='/api/runs/rev-ui/cell')return{job_id:'cell-job'};
    throw new Error(`Unexpected request ${path}`);
  },waitJob:async()=>({output:{cell:{value:'snapshot L1',truncated:false}}}),download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'asset'})};
  const dispose=renderResultView({root,store,api,summary,onPublished:async()=>{}});
  await waitFor(()=>root.textContent.includes('精确键配对已锁定')&&buttonBy(root,'查看 id 原值'));
  const accept=buttonBy(root,'accept 此配对');assert.equal(accept.disabled,true);
  await buttonBy(root,'查看 id 原值').fire('click');
  await waitFor(()=>document.body.querySelector('dialog')?.textContent.includes('snapshot L1'));
  assert.ok(requests.some(item=>item.path==='/api/runs/rev-ui/cell'&&item.body.side==='left'));
  dispose();
});

test('short API pages advance by next_offset and previous returns to the recorded offset', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-pages',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  const offsets=[];const api={request:async path=>{
    if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};
    if(path.startsWith('/api/runs/rev-pages/pairs?offset=')&&path.endsWith('limit=100'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};
    const match=path.match(/\/fields\?offset=(\d+)&limit=(\d+)/);if(match){const offset=Number(match[1]);offsets.push(offset);return{items:Array.from({length:2},(_,i)=>({source_index:offset+i,item:{field:`f${offset+i}`}})),total:5,offset,next_offset:Math.min(offset+2,5),has_more:offset+2<5};}
    if(path.includes('/candidates?')||path.includes('/records?')||path.includes('/issues?')||path.includes('/pairs?')||path.includes('/decisions?'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};
    throw new Error(`Unexpected request ${path}`);
  },download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'asset'}),waitJob:async()=>({output:{}})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onPublished:async()=>{}});
  await waitFor(()=>walk(root).some(node=>node.tag==='button'&&node.textContent==='下一页'&&!node.disabled));
  await buttonBy(root,'下一页').fire('click');await waitFor(()=>offsets.includes(2));
  await buttonBy(root,'上一页').fire('click');await waitFor(()=>offsets.at(-1)===0);
  assert.deepEqual(offsets.slice(0,3),[0,2,0]);dispose();
});

test('source generation clears only unapplied review drafts and a stale current head can branch back to its bound inputs', async () => {
  const document=makeDocument();globalThis.document=document;globalThis.confirm=message=>{assert.match(message,/切回该版本输入/);return true;};
  const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-head',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  const requests=[];let published=null;
  const api={request:async(path)=>{requests.push(path);if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path==='/api/runs/rev-head/branch')return{job_id:'branch-job'};if(path.startsWith('/api/runs/rev-head/'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob:async()=>({output:{revision:{revision_id:'rev-branch',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'}}}),download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'asset'})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},isCurrentHead:true,onPublished:async value=>{published=value;}});
  await waitFor(()=>root.textContent.includes('手工决定'));
  const action=walk(root).find(node=>node.tag==='select');action.value='left_unmatched';await buttonBy(root,'添加手工决定').fire('click');
  assert.match(root.textContent,/待应用（1）/);
  store.update({left_import_id:'edited-import'});
  assert.match(root.textContent,/待应用（0）/);
  const branch=buttonBy(root,'从原始比较新建分支');assert.equal(branch.disabled,false);await branch.fire('click');
  await waitFor(()=>published?.revision_id==='rev-branch');assert.ok(requests.includes('/api/runs/rev-head/branch'));dispose();
});

for (const operation of ['review','branch']) test(`successful ${operation} registers its head even if history selection changes while waiting`, async () => {
  const document=makeDocument();globalThis.document=document;globalThis.confirm=()=>true;
  const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:`${operation}-parent`,exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};
  const selectedHistory={revision_id:`${operation}-history`,exit_code:1,left_import_id:'old-li',right_import_id:'old-ri',config_asset_id:'old-cfg'};
  store.update({left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg',config:{schema_version:1},draft_dirty:false});store.update({revision,stale:false});
  let finishJob,waitStarted=false,latestKnown=revision.revision_id;const jobResult=new Promise(resolve=>{finishJob=resolve;});const registered=[];let published=0,refreshView;const history=[revision,selectedHistory];
  const api={request:async(path)=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path===`/api/runs/${revision.revision_id}/pairs?offset=0&limit=100`)return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path===`/api/runs/${revision.revision_id}/decisions?offset=0&limit=100`)return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path===`/api/runs/${revision.revision_id}/reviews`||path===`/api/runs/${revision.revision_id}/branch`)return{job_id:`${operation}-job`};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob:()=>{waitStarted=true;return jobResult;},download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'decisions'})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},history,isCurrentHead:value=>value.revision_id===latestKnown,onSucceeded:(parent,child)=>{registered.push({parent,child});latestKnown=child.revision_id;if(!history.some(saved=>saved.revision_id===child.revision_id))history.push(child);refreshView?.();},onPublished:async()=>{published++;},onSelectHistory:async chosen=>store.update({revision:chosen,stale:false})});refreshView=dispose.refresh;
  if(operation==='review'){await waitFor(()=>root.textContent.includes('手工决定'));const action=walk(root).find(node=>node.tag==='select');action.value='left_unmatched';await buttonBy(root,'添加手工决定').fire('click');await buttonBy(root,'应用待处理决定').fire('click');}
  else await buttonBy(root,'从原始比较新建分支').fire('click');
  await waitFor(()=>waitStarted);await buttonBy(root,`${selectedHistory.revision_id.slice(0,8)} · exit ${selectedHistory.exit_code}`).fire('click');assert.equal(store.get().revision.revision_id,selectedHistory.revision_id);
  finishJob({output:{revision:{revision_id:`${operation}-child`,exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'}}});
  await waitFor(()=>registered.length===1);
  assert.equal(registered[0].parent.revision_id,revision.revision_id);assert.equal(registered[0].child.revision_id,`${operation}-child`);
  assert.equal(published,0);assert.equal(store.get().revision.revision_id,selectedHistory.revision_id);assert.equal(store.get().left_import_id,'li');
  const childId=`${operation}-child`;const childChoice=walk(root).find(node=>node.tag==='button'&&node.textContent.startsWith(childId.slice(0,8))&&node.textContent.includes('exit 1'));assert.ok(childChoice,'successful revision appears as a history choice');await childChoice.fire('click');assert.equal(store.get().revision.revision_id,childId);
  store.update({revision,stale:false});refreshView();assert.equal(buttonBy(root,'从原始比较新建分支').disabled,true,'previous parent remains read-only after its child becomes head');assert.equal(buttonBy(root,'添加手工决定').disabled,true,'previous parent cannot accept another review');dispose();
});

test('uploaded invalid decision CSV displays structured location and keeps the pending draft and parent revision', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-error',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  let uploaded=0,currentFailure={message:'Decision action is invalid',code:'invalid_decision_action',phase:'decisions',side:null,record:1,field:null};const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path==='/api/runs/rev-error/pairs?offset=0&limit=100')return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path==='/api/runs/rev-error/decisions?offset=0&limit=100')return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path==='/api/runs/rev-error/reviews')return{job_id:'failed-review'};if(path.startsWith('/api/runs/rev-error/'))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob:async()=>{throw Object.assign(new Error(currentFailure.message),currentFailure);},download:async()=>new Blob(['{}']),upload:async()=>{uploaded++;return{asset_id:'decisions'};}};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onSucceeded:()=>assert.fail('failed resolve cannot register a revision'),onPublished:async()=>assert.fail('failed resolve cannot publish')});
  await waitFor(()=>root.textContent.includes('手工决定'));walk(root).find(node=>node.tag==='select').value='left_unmatched';await buttonBy(root,'添加手工决定').fire('click');const file=inputByLabel(root,'上传累计决定 CSV');file.files=[{name:'invalid.csv',size:12}];await file.fire('change');
  await waitFor(()=>root.textContent.includes('invalid_decision_action'));
  assert.equal(uploaded,1);assert.match(root.textContent,/阶段 decisions/);assert.match(root.textContent,/决定数据行 1/);assert.match(root.textContent,/待应用（1）/);assert.equal(store.get().revision,revision);
  currentFailure={message:'Manual override requires a reason',code:'manual_override_needs_reason',phase:'decisions',side:null,record:27,field:null};await file.fire('change');await waitFor(()=>root.textContent.includes('决定数据行 27'));assert.equal(uploaded,2);assert.match(root.textContent,/待应用（1）/);
  currentFailure={message:'Malformed quoted CSV',code:'invalid_csv',phase:'decisions',side:'decisions',record:1,field:null};await file.fire('change');await waitFor(()=>root.textContent.includes('CSV 逻辑记录（含表头） 1'));assert.equal(uploaded,3);assert.match(root.textContent,/待应用（1）/);dispose();
});

for (const fixture of [
  {code:'invalid_row_width',csv:'action,left_id,right_id,reason\nleft_unmatched,L1,\n',record:2,label:'CSV 逻辑记录（含表头） 2'},
  {code:'invalid_header',csv:'action,left_id,right_id,left_id\n',record:1,label:'CSV 逻辑记录（含表头） 1'},
  {code:'input_limit_exceeded',csv:`action,left_id,right_id,reason\nleft_unmatched,L1,,${'x'.repeat(65537)}\n`,record:2,label:'CSV 逻辑记录（含表头） 2'},
  {code:'future_decision_failure',error:{code:'future_decision_failure',message:'Future core error',phase:'decisions',side:'decisions',record:4,field:null},record:4,label:'核心记录号 4'},
]) test(`uploaded ${fixture.code} preserves core record numbering without assuming decision data rows`, async () => {
  const csv='id,status,memo\n1,A,same\n';
  const failure=fixture.error??JSON.parse(invoke(JSON.stringify({op:'resolve',left_csv:csv,right_csv:csv,config:mappingFixture(),decisions_csv:fixture.csv}))).error;
  assert.equal(failure.code,fixture.code);assert.equal(failure.record,fixture.record);
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:`rev-${fixture.code}`,exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path===`/api/runs/${revision.revision_id}/reviews`)return{job_id:'failed-review'};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob:async()=>{throw Object.assign(new Error(failure.message),failure);},download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'decisions'})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onSucceeded:()=>assert.fail('failed job cannot register'),onPublished:async()=>assert.fail('failed job cannot publish')});
  await waitFor(()=>root.textContent.includes('手工决定'));const file=inputByLabel(root,'上传累计决定 CSV');file.files=[{name:'invalid.csv',size:12}];await file.fire('change');
  await waitFor(()=>root.textContent.includes(`错误码 ${fixture.code}`));assert.ok(root.textContent.includes(fixture.label),root.textContent);assert.doesNotMatch(root.textContent,/决定数据行/);assert.equal(store.get().revision,revision);dispose();
});

test('cancelled review and failed branch display their safe structured job details', async () => {
  const make=(revision,jobPath,waitJob)=>{const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();store.update({revision,stale:false});const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path===`/api/runs/${revision.revision_id}/pairs?offset=0&limit=100`)return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path===jobPath)return{job_id:'job'};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob,download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'decisions'})};const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onSucceeded:()=>assert.fail('unsuccessful job cannot register a revision'),onPublished:async()=>assert.fail('unsuccessful job cannot publish')});return{root,store,dispose};};
  globalThis.confirm=()=>true;
  const review={revision_id:'rev-cancel',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};
  const cancelled=make(review,`/api/runs/${review.revision_id}/reviews`,async()=>{throw Object.assign(new Error('Task cancelled'),{cancelled:true,job:{phase:'resolving'}});});
  await waitFor(()=>cancelled.root.textContent.includes('手工决定'));walk(cancelled.root).find(node=>node.tag==='select').value='left_unmatched';await buttonBy(cancelled.root,'添加手工决定').fire('click');await buttonBy(cancelled.root,'应用待处理决定').fire('click');await waitFor(()=>cancelled.root.textContent.includes('job_cancelled'));assert.match(cancelled.root.textContent,/resolving/);assert.match(cancelled.root.textContent,/待应用（1）/);cancelled.dispose();
  const branch={revision_id:'rev-branch-error',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};
  const failed=make(branch,`/api/runs/${branch.revision_id}/branch`,async()=>{throw Object.assign(new Error('CSV input row is invalid'),{code:'invalid_csv',phase:'comparing',side:'left',record:8,field:'id'});});
  await buttonBy(failed.root,'从原始比较新建分支').fire('click');await waitFor(()=>failed.root.textContent.includes('invalid_csv'));assert.match(failed.root.textContent,/comparing/);assert.match(failed.root.textContent,/left/);assert.match(failed.root.textContent,/CSV 逻辑记录（含表头） 8/);assert.match(failed.root.textContent,/字段 id/);assert.equal(failed.store.get().revision,branch);failed.dispose();
});

test('result rerenders preserve active-job disabling for unlocked review actions', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-active-controls',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path.includes('/candidates?'))return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',score:9000,suggested:true}}],total:1,offset:0,next_offset:1,has_more:false};if(path.includes('/records?'))return{items:[{source_index:0,item:{id:'L2',side:'left',record:2,status:'pending_review'}}],total:1,offset:0,next_offset:1,has_more:false};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},download:async()=>new Blob(['{}'])};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onPublished:async()=>{}});
  await waitFor(()=>walk(root).some(node=>node.tag==='button'&&node.textContent==='accept 此配对'&&!node.disabled));
  store.update({active_job:{job_id:'other-job',phase:'resolving',state:'running'}});dispose.refresh();
  for(const text of ['accept 此配对','reject 此配对','left_unmatched'])assert.equal(buttonBy(root,text).disabled,true,`${text} stays disabled after rerender`);
  store.update({active_job:null});dispose.refresh();assert.equal(buttonBy(root,'accept 此配对').disabled,false);dispose();
});

test('exact-pair accept/reject remain locked through unrelated updates and a failed review cleanup', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-lock-update',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path===`/api/runs/${revision.revision_id}/pairs?offset=0&limit=100`)return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',source:'exact_key'}}],total:1,offset:0,next_offset:1,has_more:false};if(path===`/api/runs/${revision.revision_id}/candidates?offset=0&limit=20`)return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',score:10000,suggested:true}}],total:1,offset:0,next_offset:1,has_more:false};if(path===`/api/runs/${revision.revision_id}/decisions?offset=0&limit=100`)return{items:[],total:0,offset:0,next_offset:0,has_more:false};if(path===`/api/runs/${revision.revision_id}/reviews`)return{job_id:'locked-failure'};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},waitJob:async()=>{throw Object.assign(new Error('conflicting decisions'),{code:'conflicting_decisions',phase:'resolving'});},download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'decisions'})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onPublished:async()=>{}});
  await waitFor(()=>root.textContent.includes('精确键配对已锁定'));
  assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);
  store.update({error:null});assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);
  await waitFor(()=>root.textContent.includes('手工决定'));walk(root).find(node=>node.tag==='select').value='left_unmatched';await buttonBy(root,'添加手工决定').fire('click');await buttonBy(root,'应用待处理决定').fire('click');await waitFor(()=>root.textContent.includes('conflicting_decisions'));
  assert.equal(store.get().active_job,null);assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);dispose();
});

test('exact-pair review actions stay disabled while lock loading fails', async () => {
  const document=makeDocument();globalThis.document=document;const root=new FakeNode('main'),store=createWorkbenchState();
  const revision={revision_id:'rev-lock-fail',exit_code:1,left_import_id:'li',right_import_id:'ri',config_asset_id:'cfg'};store.update({revision,stale:false});
  let rejectLocks;const locks=new Promise((_,reject)=>{rejectLocks=reject;});
  const api={request:async path=>{if(path.startsWith('/api/imports/'))return{import:{import_id:path.split('/').at(-1),headers:[]}};if(path===`/api/runs/${revision.revision_id}/pairs?offset=0&limit=100`)return locks;if(path===`/api/runs/${revision.revision_id}/candidates?offset=0&limit=20`)return{items:[{source_index:0,item:{left_id:'L1',right_id:'R1',score:9000,suggested:true}}],total:1,offset:0,next_offset:1,has_more:false};if(path.startsWith(`/api/runs/${revision.revision_id}/`))return{items:[],total:0,offset:0,next_offset:0,has_more:false};throw new Error(`Unexpected request ${path}`);},download:async()=>new Blob(['{}']),upload:async()=>({asset_id:'decisions'}),waitJob:async()=>({output:{}})};
  const dispose=renderResultView({root,store,api,summary:{revision,computation:{},summary:{},structure:{},issues:[]},onPublished:async()=>{}});
  await waitFor(()=>root.textContent.includes('所有竞争候选'));assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);
  store.update({error:null});assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);
  rejectLocks(new Error('pair evidence unavailable'));
  await waitFor(()=>root.textContent.includes('精确配对锁定信息'));assert.equal(buttonBy(root,'accept 此配对').disabled,true);assert.equal(buttonBy(root,'reject 此配对').disabled,true);dispose();
});

async function waitFor(predicate) { for(let i=0;i<100;i++){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,0));}throw new Error('Timed out waiting for UI state'); }
