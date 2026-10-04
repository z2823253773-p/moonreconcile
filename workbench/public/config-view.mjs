import { configToForm, formToConfig } from './config-model.mjs';
import { button, element, label, optionList } from './dom.mjs';

const TYPES = [['', '请选择类型'], ['text', '文本'], ['decimal', '金额/小数'], ['date', '日期']];
const METRICS = [['', '请选择指标'], ['exact', '完全一致'], ['edit', '编辑距离'], ['decimal', '小数差异'], ['date', '日期差异']];
const textInput = (value, { placeholder = '', className = '' } = {}) => element('input', { type: 'text', value, placeholder, className, autocomplete: 'off' });
const area = (value) => element('textarea', { rows: 3, value });
const checkbox = (checked) => element('input', { type: 'checkbox', checked });
const select = (values, value) => element('select', {}, optionList(values, value));
const pageSize = 50;
const FIELD_LABELS = { name:'逻辑字段名', left:'左侧来源列', right:'右侧来源列', abs_tol:'绝对容差（十进制字符串）', rel_tol:'相对容差（十进制字符串）' };

function rowEditor({ title, rows, renderRow, add, page, setPage, root }) {
  const section = element('section', { className: 'editor-block' }); section.append(element('h4', { text: `${title}（${rows.length}）` }));
  const from = page * pageSize; rows.slice(from, from + pageSize).forEach((row, index) => section.append(renderRow(row, from + index)));
  const nav = element('div', { className: 'pager' });
  nav.append(button('上一页', () => { if (page > 0) { setPage(page - 1); root(); } }, { disabled: page <= 0 }));
  nav.append(element('span', { text: rows.length ? `${from + 1}–${Math.min(from + pageSize, rows.length)} / ${rows.length}` : '暂无项目' }));
  nav.append(button('下一页', () => { if (from + pageSize < rows.length) { setPage(page + 1); root(); } }, { disabled: from + pageSize >= rows.length }));
  section.append(nav, button('添加', () => { add(); setPage(Math.floor(Math.max(0, rows.length - 1) / pageSize)); root(); }, { className: 'secondary' }));
  return section;
}

export function renderConfigView({ root, store, api }) {
  let model = null, fieldPage = 0, candidatePage = 0, leftMapPage = {}, rightMapPage = {}, missingPages = {}, editGeneration = 0;
  let busy = false, activeJob = null, sourceHeaders = { left: [], right: [] };
  let validationNote = null, exportButton = null;
  const captureContext = () => ({ generation: store.generation(), left: store.get().left_import_id, right: store.get().right_import_id, edit: editGeneration });
  const contextMatches = (context) => context.generation === store.generation() && context.left === store.get().left_import_id && context.right === store.get().right_import_id && context.edit === editGeneration;
  const staleMessage = () => `规则或来源已变化，当前结果为旧版本。${store.get().config_asset_id && !store.get().draft_dirty ? '当前规则已校验，可运行新比较更新结果。' : '校验当前规则后运行新比较。'}`;
  const syncBindingPresentation = () => {
    const valid = Boolean(store.get().config_asset_id && !store.get().draft_dirty);
    if (validationNote) validationNote.hidden = !valid;
    if (exportButton) exportButton.disabled = !valid;
    syncUnmapped();
  };
  let unmappedSection = null;
  const syncUnmapped = () => {
    if (!unmappedSection) return;
    const state = store.get(), config = state.config;
    const valid = Boolean(state.config_asset_id && !state.draft_dirty && config);
    unmappedSection.replaceChildren();
    if (!valid) { unmappedSection.hidden = true; return; }
    unmappedSection.hidden = false;
    unmappedSection.append(element('h3', { text: '未映射且未忽略的来源列' }));
    for (const [side, title, headers, mappingKey, ignoredKey] of [
      ['left', '左侧', state.left_headers ?? [], 'left', 'ignore_left'],
      ['right', '右侧', state.right_headers ?? [], 'right', 'ignore_right'],
    ]) {
      const mapped = new Set((config.fields ?? []).map((field) => field[mappingKey]).filter(Boolean));
      const ignored = new Set(config[ignoredKey] ?? []);
      const values = headers.filter((header) => !mapped.has(header) && !ignored.has(header));
      unmappedSection.append(element('p', { text: `${title}：${values.length ? values.join('、') : '无'}` }));
    }
  };
  const updateDraft = () => {
    editGeneration++;
    try { store.update({ config: formToConfig(model), config_asset_id: null, draft_dirty: true, error: null }); }
    catch { store.invalidateRules({ error: null }); }
  };
  const inputFor = (text, node, key, convert = (v) => v) => {
    node.addEventListener('input', () => { text[key] = convert(node.value); updateDraft(); }); return label(FIELD_LABELS[key] ?? key, node);
  };
  const runJob = async (start) => {
    const outerBusy=busy;busy = true;store.update({active_job:{job_id:null,phase:'正在提交任务',state:'running'}});render();
    try {
      const accepted = await start(); activeJob = accepted.job_id; store.update({ active_job: { job_id: activeJob, phase: 'validating', state: 'running' }, error: null }); render();
      const job = await api.waitJob(activeJob);
      activeJob = null; return job.output;
    } catch (error) { activeJob = null; store.update({ error: error.message, active_job: null }); throw error; }
    finally { activeJob=null;busy=outerBusy;if(!outerBusy)store.update({active_job:null});render(); }
  };
  const invalidateRules = () => { if (model) updateDraft(); };
  const render = () => {
    sourceHeaders={left:store.get().left_headers??[],right:store.get().right_headers??[]};
    root.replaceChildren();
    root.append(element('h2', { text: '核对规则' }));
    if (store.get().stale) root.append(element('p', { className: 'notice warning stale-notice', role: 'status', text: staleMessage() }));
    if (store.get().error) root.append(element('p', { className: 'notice error', role: 'alert', text: store.get().error }));
    const controls = element('div', { className: 'toolbar' });
    const globallyBusy = busy || Boolean(store.get().active_job);
    controls.append(button('从当前列生成空白草稿', async () => {
      const current = store.get(); if (!current.left_import_id || !current.right_import_id) { store.update({ error: '请先分别导入左右 CSV。' }); render(); return; }
      const context = captureContext();
      try {
        const out = await runJob(() => api.request('/api/config/draft', { method: 'POST', body: { left_import_id: current.left_import_id, right_import_id: current.right_import_id } }));
        const blob = await api.download(`/api/configs/${out.config_asset_id}/export`), text = await blob.text();
        if (!contextMatches(context)) throw new Error('草稿生成期间来源或规则已变化；保留当前表单，请重新生成。');
        const draftConfig=JSON.parse(text);model = configToForm(draftConfig);resetPages();store.update({ config: draftConfig, config_asset_id: null, draft_dirty: true, error: null }); render();
      } catch(error) {store.update({error:error.message});render();}
    }, { disabled: globallyBusy }));
    const configFile = element('input', { type: 'file', accept: '.json,application/json', disabled: globallyBusy });
    configFile.addEventListener('change', async () => {
      const file=configFile.files?.[0];if(!file)return;const current=store.get();
      if(!current.left_import_id||!current.right_import_id){store.update({error:'导入配置前，请先导入左右 CSV，以便由核心校验配置。'});render();return;}
      if (busy || store.get().active_job) return;
      const context=captureContext();busy=true;store.update({active_job:{job_id:null,phase:'正在上传并校验配置',state:'running'}});render();
      try {
        const uploaded=await api.upload('config',file);
        const checked=await runJob(()=>api.request('/api/config/check',{method:'POST',body:{left_import_id:current.left_import_id,right_import_id:current.right_import_id,config_asset_id:uploaded.asset_id}}));
        const blob=await api.download(`/api/configs/${checked.config_asset_id}/export`),text=await blob.text();
        if(!contextMatches(context))throw new Error('校验期间来源或规则已变化；保留当前表单，请重新校验。');
        const normalized=JSON.parse(text);model=configToForm(normalized);resetPages();store.update({config:normalized,config_asset_id:checked.config_asset_id,draft_dirty:false,error:null});render();
      }catch(error){store.update({error:error.message});render();/* Keep the current form and validated binding on import/check failure. */}
      finally{busy=false;store.update({active_job:null});render();}
    });
    exportButton = button('导出已校验配置', async () => {
      const id = store.get().config_asset_id; if (!id) return; try { const blob = await api.download(`/api/configs/${id}/export`); downloadBlob(blob, 'moonreconcile-config.json'); } catch (error) { store.update({ error: error.message }); render(); }
    }, { disabled: !store.get().config_asset_id });
    controls.append(label('导入配置 JSON', configFile), exportButton);
    root.append(controls);
    if (!model) { root.append(element('p', { text: '导入左右文件后，可以从空白列草稿开始，也可以编辑后导入 Config v1 配置。所有字段类型都需明确选择。' })); return; }
    const global = element('details', { open: true, className: 'config-group' }); global.append(element('summary', { text: '字段、主键与忽略列' }));
    global.append(rowEditor({ title: '逻辑字段', rows: model.fields, page: fieldPage, setPage: (n) => fieldPage = n, root: render, add: () => {model.fields.push({ name: '', left: '', right: '', type: '', compare: true, trim_ascii: false, lower_ascii: false, left_values: [], right_values: [], missing: [], both_missing: 'equal', abs_tol: '0', rel_tol: '0', days_tol: 0 });invalidateRules();}, renderRow: (field, index) => {
      const card = element('article', { className: 'field-card' }); card.append(element('h3', { text: `字段 ${index + 1}: ${field.name || '未命名'}` }));
      const grid = element('div', { className: 'form-grid' });
      for (const key of ['name', 'left', 'right']) {
        const src = key === 'left' ? sourceHeaders.left : key === 'right' ? sourceHeaders.right : [];
        const control = src.length ? select([['', '请选择来源列'], ...src.map((value) => [value, value])], field[key]) : textInput(field[key], { placeholder: key === 'name' ? '逻辑字段名' : '导入后可从表头选择，也可输入列名' });
        grid.append(inputFor(field, control, key));
      }
      const typeControl = select(TYPES, field.type); typeControl.addEventListener('change', () => { field.type = typeControl.value; updateDraft(); }); grid.append(label('类型（必选）', typeControl));
      const toggles = element('div', { className: 'check-row' });
      for (const [key, caption] of [['compare', '参与逐行比较'], ['trim_ascii', '去除 ASCII 首尾空白'], ['lower_ascii', 'ASCII 转小写']]) { const control=checkbox(field[key]);control.addEventListener('change',()=>{field[key]=control.checked;updateDraft();});toggles.append(label(caption,control)); }
      const both = select([['equal', '双方缺失视为相等'], ['issue', '双方缺失生成问题']], field.both_missing); both.addEventListener('change', () => { field.both_missing = both.value; updateDraft(); }); grid.append(label('双方缺失', both));
      for (const key of ['abs_tol', 'rel_tol']) { const control=textInput(field[key], { placeholder: '例如 0.02' });control.inputMode='decimal';grid.append(inputFor(field,control,key)); }
      const days=textInput(String(field.days_tol));days.inputMode='numeric';days.pattern='[0-9]+';days.addEventListener('input',()=>{field.days_tol=days.value===''?'':(/^[0-9]+$/.test(days.value)?Number(days.value):days.value);updateDraft();});grid.append(label('日期容差（严格整数）',days));
      card.append(grid, toggles);
      for (const [key, caption] of [['left_values', '左侧值映射'], ['right_values', '右侧值映射']]) {
        const mapRows=field[key]; const pageKey=`${index}:${key}`; const pages=key==='left_values'?leftMapPage:rightMapPage;
        card.append(rowEditor({ title: caption, rows: mapRows, page: pages[pageKey] ?? 0, setPage: (n)=>pages[pageKey]=n, root: render, add: ()=>{mapRows.push({key:'',value:''});invalidateRules();}, renderRow: (entry, mapIndex) => {
          const row=element('div',{className:'map-row'});const k=textInput(entry.key),v=textInput(entry.value);k.addEventListener('input',()=>{entry.key=k.value;updateDraft();});v.addEventListener('input',()=>{entry.value=v.value;updateDraft();});row.append(label('原值',k),label('映射为',v),button('删除映射',()=>{mapRows.splice(mapIndex,1);pages[pageKey]=Math.min(pages[pageKey]??0,Math.max(0,Math.ceil(mapRows.length/pageSize)-1));invalidateRules();render();},{className:'danger'}));return row;
        }}));
      }
      card.append(rowEditor({title:'缺失标记（空值也可作为一项）',rows:field.missing,page:missingPages[index]??0,setPage:(n)=>missingPages[index]=n,root:render,add:()=>{field.missing.push('');invalidateRules();},renderRow:(value,missingIndex)=>{const row=element('div',{className:'map-row'}),entry=textInput(value);entry.addEventListener('input',()=>{field.missing[missingIndex]=entry.value;updateDraft();});row.append(label('缺失标记值',entry),button('删除缺失标记',()=>{field.missing.splice(missingIndex,1);missingPages[index]=Math.min(missingPages[index]??0,Math.max(0,Math.ceil(field.missing.length/pageSize)-1));invalidateRules();render();},{className:'danger'}));return row;}}));
      card.append(button('删除字段',()=>{model.fields.splice(index,1);fieldPage=Math.min(fieldPage,Math.max(0,Math.ceil(model.fields.length/pageSize)-1));resetMapPages();invalidateRules();render();},{className:'danger'}));
      return card;
    }}));
    for (const [key, title] of [['key','主键字段（每行一项）'],['ignore_left','忽略左侧列（每行一项）'],['ignore_right','忽略右侧列（每行一项）']]) { const input=area(model[key].join('\n'));input.addEventListener('input',()=>{model[key]=input.value.split('\n').filter((value)=>value!=='');updateDraft();});global.append(label(title,input)); }
    root.append(global);
    unmappedSection = element('section', { className: 'notice validation-summary', hidden: true });
    root.append(unmappedSection);
    const candidates = element('details', { className: 'config-group' }); candidates.append(element('summary', { text: '候选匹配（可选）' }));
    const candidateOn=checkbox(model.candidates!==null);candidateOn.addEventListener('change',()=>{model.candidates=candidateOn.checked?{fields:[],threshold:1,blocking:[]}:null;candidatePage=0;invalidateRules();render();});candidates.append(label('启用候选规则',candidateOn));
    if (model.candidates) {
      const c=model.candidates,threshold=textInput(String(c.threshold));threshold.inputMode='numeric';threshold.pattern='[0-9]+';threshold.addEventListener('input',()=>{c.threshold=threshold.value===''?'':(/^[0-9]+$/.test(threshold.value)?Number(threshold.value):threshold.value);updateDraft();});candidates.append(label('候选阈值（1–10000 严格整数）',threshold));
      candidates.append(rowEditor({title:'候选评分字段',rows:c.fields,page:candidatePage,setPage:(n)=>candidatePage=n,root:render,add:()=>{c.fields.push({field:'',metric:'',weight:1});invalidateRules();},renderRow:(item,index)=>{const row=element('div',{className:'form-grid'});const field=textInput(item.field);field.addEventListener('input',()=>{item.field=field.value;updateDraft();});const metric=select(METRICS,item.metric);metric.addEventListener('change',()=>{item.metric=metric.value;updateDraft();});const weight=textInput(String(item.weight));weight.inputMode='numeric';weight.pattern='[0-9]+';weight.addEventListener('input',()=>{item.weight=weight.value===''?'':(/^[0-9]+$/.test(weight.value)?Number(weight.value):weight.value);updateDraft();});row.append(label('评分逻辑字段',field),label('指标',metric),label('权重（1–10000 严格整数）',weight),button('删除评分字段',()=>{c.fields.splice(index,1);candidatePage=Math.min(candidatePage,Math.max(0,Math.ceil(c.fields.length/pageSize)-1));invalidateRules();render();},{className:'danger'}));return row;}}));
      const blocking=element('section',{className:'editor-block'});blocking.append(element('h4',{text:'Blocking 分组（组间 OR，组内 AND）'}));c.blocking.forEach((group,index)=>{const row=element('div',{className:'map-row'}),g=area(group.join('\n'));g.addEventListener('input',()=>{c.blocking[index]=g.value.split('\n');updateDraft();});row.append(label(`分组 ${index+1} 字段`,g),button('删除分组',()=>{c.blocking.splice(index,1);invalidateRules();render();},{className:'danger'}));blocking.append(row);});blocking.append(button('添加 Blocking 分组',()=>{c.blocking.push([]);invalidateRules();render();},{className:'secondary'}));candidates.append(blocking);
    }
    root.append(candidates);
    const actions=element('div',{className:'toolbar'});
    actions.append(button(busy?'处理中…':'校验并保存规则',async()=>{
      const current=store.get();if(!current.left_import_id||!current.right_import_id){store.update({error:'请先导入左右 CSV。'});render();return;}
      let config;try{config=formToConfig(model);}catch(error){store.update({error:error.message});render();return;}
        if(busy||store.get().active_job)return;
        const context=captureContext();busy=true;store.update({active_job:{job_id:null,phase:'正在上传规则配置',state:'running'}});render();
      try {
        const blob=new Blob([JSON.stringify(config)],{type:'application/json'});Object.defineProperty(blob,'name',{value:'config.json'});
        const asset=await api.upload('config',blob);
        const out=await runJob(()=>api.request('/api/config/check',{method:'POST',body:{left_import_id:current.left_import_id,right_import_id:current.right_import_id,config_asset_id:asset.asset_id}}));
        const canonicalBlob=await api.download(`/api/configs/${out.config_asset_id}/export`),canonicalText=await canonicalBlob.text();
        if(!contextMatches(context))throw new Error('校验期间来源或规则已变化；保留当前表单，请重新校验。');
        const normalized=JSON.parse(canonicalText);model=configToForm(normalized);resetPages();
        store.update({config:normalized,config_asset_id:out.config_asset_id,draft_dirty:false,error:null});render();
      } catch(error) {store.update({error:error.message});render(); /* error remains visible */}
      finally{busy=false;store.update({active_job:null});render();}
    },{disabled:busy||!model}));
    if (activeJob) actions.append(button('取消当前任务',async()=>{try{await api.request(`/api/jobs/${activeJob}`,{method:'DELETE'});}catch(error){store.update({error:error.message});render();}},{className:'danger'}));
    root.append(actions);
    validationNote=element('section',{className:'notice success validation-summary',role:'status',hidden:true});
    validationNote.append(element('h3',{text:'已校验配置摘要'}),element('p',{text:'规则由核心校验并绑定到当前左右导入。编辑规则后需重新校验。'}));
    const validated=store.get().config;
    for(const field of validated?.fields??[]) {
      const transforms=[field.trim_ascii?'去除 ASCII 首尾空白':null,field.lower_ascii?'ASCII 转小写':null].filter(Boolean);
      const maps=(items)=>{const pairs=Array.isArray(items)?items.map(({key,value})=>[key,value]):Object.entries(items??{});return pairs.length?pairs.map(([key,value])=>`${key} → ${value}`).join('；'):'无';};
      validationNote.append(element('p',{text:`字段 ${field.name}：${field.type}；左列 ${field.left}；右列 ${field.right}；${validated.key.includes(field.name)?'主键；':''}${field.compare?'参与比较':'不参与比较'}；双方缺失 ${field.both_missing}；变换 ${transforms.length?transforms.join('、'):'无'}；左右映射 ${maps(field.left_values)} / ${maps(field.right_values)}；缺失标记 ${JSON.stringify(field.missing)}；容差 abs=${field.abs_tol}, rel=${field.rel_tol}, days=${field.days_tol}。`}));
    }
    validationNote.append(element('p',{text:`主键：${validated?.key?.join('、')||'无'}；忽略左侧：${validated?.ignore_left?.join('、')||'无'}；忽略右侧：${validated?.ignore_right?.join('、')||'无'}。`}));
    if(validated?.candidates) {
      const c=validated.candidates;
      validationNote.append(element('p',{text:`候选匹配：阈值 ${c.threshold}；评分字段 ${c.fields.map((f)=>`${f.field}（${f.metric}，权重 ${f.weight}）`).join('、')||'无'}；Blocking ${c.blocking.map((g)=>`[${g.join('、')}]`).join('、')||'无'}。`}));
    } else validationNote.append(element('p',{text:'候选匹配：未启用。'}));
    root.append(validationNote);
    if(globallyBusy)for(const control of root.querySelectorAll('input,select,textarea,button'))if(control!==exportButton&&!control.textContent?.includes('取消')&&!control.textContent?.includes('下载 report'))control.disabled=true;
    syncBindingPresentation();
  };
  function resetMapPages(){leftMapPage={};rightMapPage={};missingPages={};}
  function resetPages(){fieldPage=0;candidatePage=0;resetMapPages();}
  let lastLeft=store.get().left_import_id,lastRight=store.get().right_import_id,lastConfig=store.get().config,lastStale=store.get().stale,lastAsset=store.get().config_asset_id,lastDraft=store.get().draft_dirty,lastJob=store.get().active_job;
  const syncStaleNotice=()=>{const existing=root.querySelector('.stale-notice');if(store.get().stale&&!existing){root.querySelector('h2')?.after(element('p',{className:'notice warning stale-notice',role:'status',text:staleMessage()}));}else if(store.get().stale&&existing)existing.textContent=staleMessage();else if(!store.get().stale)existing?.remove();};
  const dispose = store.subscribe((next) => {
    const sourceChanged=next.left_import_id!==lastLeft||next.right_import_id!==lastRight;
    const configChanged=next.config!==lastConfig;
    const bindingChanged=next.config_asset_id!==lastAsset||next.draft_dirty!==lastDraft;
    if(sourceChanged){lastLeft=next.left_import_id;lastRight=next.right_import_id;resetPages();if(configChanged)model=next.config?configToForm(next.config):null;render();}
    else if(lastStale!==next.stale)syncStaleNotice();
    if(configChanged){
      if(next.config_asset_id&&!next.draft_dirty){model=next.config?configToForm(next.config):null;resetPages();render();}
      else syncBindingPresentation();
    }
    if(bindingChanged){syncBindingPresentation();syncStaleNotice();}
    if(lastJob!==next.active_job){lastJob=next.active_job;if(!busy)render();else syncBindingPresentation();}
    lastConfig=next.config;lastStale=next.stale;lastAsset=next.config_asset_id;lastDraft=next.draft_dirty;
  });
  render();
  return () => { dispose(); root.replaceChildren(); };
}

function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=element('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),0);}
