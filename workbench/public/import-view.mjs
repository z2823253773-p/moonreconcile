import { button, element, label } from './dom.mjs';
import { renderXlsxSelection } from './xlsx-view.mjs';

const LIMIT = 20;
const EXAMPLES = [['orders','合成 orders 示例'],['migration','合成 migration 示例'],['catalog','合成 catalog 示例'],['ourairports','OurAirports 公开快照']];

export function renderImportView({ root, store, api, xlsxEnabled = false }) {
  const sources = { left: null, right: null }, errors = { left: null, right: null };
  const pageLimit = { left: LIMIT, right: LIMIT };
  let activeJob = null, busy = false, bindingRevision = null, notice = '', exampleLabel = '';
  const render = () => {
    root.replaceChildren(element('h2',{text:xlsxEnabled?'选择左右 CSV / XLSX':'选择左右 CSV'}));
    root.append(element('p',{className:'notice',role:'note',text:'文件仅发送到本机服务暂存。每侧显示抽样预览行数与完整校验总行数；SHA-256、文件字节和列数来自服务端。'}));
    if (notice) root.append(element('p',{className:'notice error',role:'alert',text:notice}));
    const sides=element('div',{className:'source-grid'});
    for (const side of ['left','right']) {
      const title=side==='left'?'左侧来源':'右侧来源',box=element('section',{className:'source-card'});box.append(element('h3',{text:title}));
      const file=element('input',{type:'file',accept:xlsxEnabled?'.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.csv,text/csv',disabled:busy||Boolean(store.get().active_job)});file.setAttribute('aria-label',xlsxEnabled?`${title} XLSX 文件`:`${title} CSV 文件`);
      file.addEventListener('change',()=>{const picked=file.files?.[0];if(picked)void loadFile(side,picked);});
      const drop=element('div',{className:'drop-zone',tabindex:'0',role:'group','aria-label':`${title} 拖放区域`,text:xlsxEnabled?'选择 CSV 或 XLSX，或将文件拖放到这里':'选择 CSV，或将文件拖放到这里'});
      drop.addEventListener('dragover',(event)=>{event.preventDefault();if(busy||store.get().active_job){drop.classList.remove('dragging');return;}drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));
      drop.addEventListener('drop',(event)=>{event.preventDefault();drop.classList.remove('dragging');if(busy||store.get().active_job){notice='任务进行中，完成或取消后再替换来源。';render();return;}const picked=event.dataTransfer?.files?.[0];if(picked)void loadFile(side,picked);});
      drop.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();file.click();}});
      box.append(label(xlsxEnabled?`${title} XLSX 文件`:`${title} CSV 文件`,file),drop);
      const source=sources[side];if(source){const perPage=element('select',{disabled:busy||Boolean(store.get().active_job)},[5,10,20].map((size)=>element('option',{value:size,selected:pageLimit[side]===size,text:`${size} 行`})));perPage.addEventListener('change',()=>{pageLimit[side]=Number(perPage.value);void page(side,source.preview.offset);});box.append(label('每页预览行数（可缩小显示）',perPage));box.append(element('div',{className:'source-meta'},[
        source.format==='xlsx'?element('p',{text:`${source.label??source.name} · ${source.bytes.toLocaleString()} 字节 · 原始文件 SHA-256 ${source.sha256}`}):element('p',{text:`${source.label??source.name} · ${source.bytes.toLocaleString()} 字节 · SHA-256 ${source.sha256}`}),
        ...(source.format==='xlsx'?[element('p',{text:`规范 CSV SHA-256 ${source.import.sha256}`}),element('p',{text:`工作表 ${source.manifest.worksheet.name} · 日期系统 ${source.manifest.worksheet.date_system} · 转换模式：${source.profile.import_spec.columns.map(item=>`${item.column}:${item.mode}`).join('、')}`}),element('p',{text:`行映射：物理第 ${source.manifest.row_mapping.header_row} 行为表头，数据从第 ${source.manifest.row_mapping.data_first_row} 行开始，${source.manifest.row_mapping.row_count} 条，列 ${source.manifest.row_mapping.column_start}–${source.manifest.row_mapping.column_end}`}),element('p',{text:source.manifest.warnings.length?`导入警告：${source.manifest.warnings.map(item=>`${item.code} ${item.count}`).join('；')}`:'导入警告：无'})]:[]),
        element('p',{text:`完整校验 ${source.preview.row_count.toLocaleString()} 行 × ${source.preview.column_count} 列；当前预览 ${source.preview.rows.length} 行。`}),
        element('p',{text:`完整表头：${source.preview.headers.join('、')}`}),
      ]));if(source.preview.has_more)box.append(button('下一页预览',()=>void page(side,source.preview.next_offset),{disabled:busy}));if(source.preview.offset>0)box.append(button('上一页预览',()=>void page(side,Math.max(0,source.preview.offset-pageLimit[side])),{disabled:busy}));box.append(renderRows(side,source.preview));}
      if(errors[side]) box.append(errorCard(errors[side]));sides.append(box);
    }
    root.append(sides);
    const tools=element('div',{className:'toolbar'});
    tools.append(button('交换左右并重置关联规则',()=>void swapSides(),{className:'secondary',disabled:busy||Boolean(store.get().active_job)||!sources.left||!sources.right}));
    for(const [name,text] of EXAMPLES)tools.append(button(`载入${text}`,()=>void loadExample(name),{disabled:busy||Boolean(store.get().active_job)}));
    root.append(tools);
    if(exampleLabel)root.append(element('p',{className:'notice',role:'status',text:`当前示例来源：${exampleLabel}`}));
    if(activeJob)root.append(element('div',{className:'job-status'},[element('span',{role:'status',text:`任务进行中：${activeJob.phase??'读取/校验'}。服务不提供百分比进度。`}),button('取消当前任务',()=>void cancel(),{className:'danger'})]));
  };
  async function waitFor(route,body) {
    const previous=bindingRevision??store.get().active_job;
    if(previous&&previous!==bindingRevision&&previous.job_id!==null)throw Object.assign(new Error('已有工作台任务正在运行。'),{code:'session_busy'});
    const reservation={job_id:null,phase:'正在提交导入任务',state:'running'};store.update({active_job:reservation});render();
    try {const accepted=await api.request(route,{method:'POST',body});activeJob={job_id:accepted.job_id,phase:'读取/校验'};store.update({active_job:{...activeJob,state:'running'}});render();const job=await api.waitJob(activeJob.job_id);return job.output;}
    finally {activeJob=null;store.update({active_job:bindingRevision??(previous?.job_id===null?previous:null)});}
  }
  async function loadFile(side,file) {
    if(busy||store.get().active_job){notice='任务进行中，完成或取消后再替换来源。';render();return;}
    if(/\.xlsx$/i.test(file.name??''))return loadXlsx(side,file);
    const generation=store.generation(),left=store.get().left_import_id,right=store.get().right_import_id;
    busy=true;store.update({active_job:{job_id:null,phase:'正在上传来源',state:'running'}});notice='';errors[side]=null;render();
    try {
      const asset=await api.upload('csv',file);const out=await waitFor('/api/imports',{asset_id:asset.asset_id,side});
      if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在上传期间已变化；本次文件未替换当前来源。');
      sources[side]={...asset,label:file.name,preview:out.preview,import:out.import};exampleLabel='';
      store.update({[`${side}_import_id`]:out.import.import_id,[`${side}_headers`]:out.preview.headers,error:null});
    } catch(error) {errors[side]=error;notice=`${side==='left'?'左侧':'右侧'}文件未导入：${error.message}`;store.update({error:error.message});}
    finally{busy=false;if(store.get().active_job?.job_id===null&&store.get().active_job?.phase==='正在上传来源')store.update({active_job:null});render();}
  }
  async function loadXlsx(side,file) {
    if(!xlsxEnabled){notice='当前服务只接受 CSV 来源。';render();return;}
    const generation=store.generation(),left=store.get().left_import_id,right=store.get().right_import_id;
    busy=true;store.update({active_job:{job_id:null,phase:'正在上传 XLSX 来源',state:'running'}});notice='';errors[side]=null;render();
    try {
      const asset=await api.upload('xlsx',file);
      if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在上传期间已变化；本次文件未替换当前来源。');
      xlsxSelection?.dispose();
      xlsxSelection=renderXlsxSelection({root,api,asset,side,
        onTaskState:task=>store.update({active_job:task}),
        onConfirmed:async candidate=>{
          if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在转换期间已变化；本次文件未替换当前来源。');
          sources[side]={...candidate.asset,label:file.name,format:'xlsx',import:candidate.import,preview:candidate.preview,profile:candidate.profile,manifest:candidate.manifest};
          exampleLabel='';errors[side]=null;store.update({[`${side}_import_id`]:candidate.import.import_id,[`${side}_headers`]:candidate.preview.headers,error:null});
          render();
        },onCancel:()=>{notice='XLSX 候选已保留在本机会话；当前来源未更换。';render();},
      });
    } catch(error) {error.inputFormat='xlsx';errors[side]=error;notice=`${side==='left'?'左侧':'右侧'}文件未导入：${error.message}`;store.update({error:error.message});}
    finally{busy=false;if(store.get().active_job?.job_id===null&&store.get().active_job?.phase==='正在上传 XLSX 来源')store.update({active_job:null});render();}
  }
  async function page(side,offset) {
    if(busy||store.get().active_job)return;
    busy=true;render();try{const s=sources[side];s.preview=(await waitFor(`/api/imports/${s.import.import_id}/preview`,{offset,limit:pageLimit[side]})).preview;}
    catch(error){notice=`预览失败（${error.code??'错误'}）：${error.message}。可将每页行数调到 5 后重试；若单行或表头仍超出显示预算，请缩短/拆分源表列后重新导入。`}finally{busy=false;render();}
  }
  async function loadExample(name) {
    if(busy||store.get().active_job)return;
    const generation=store.generation(),left=store.get().left_import_id,right=store.get().right_import_id;
    busy=true;store.update({active_job:{job_id:null,phase:'正在载入示例',state:'running'}});notice='';render();
    try {
      const result=await waitFor(`/api/examples/${name}`,{});
      const leftMeta=await api.request(`/api/imports/${result.left_import_id}`),rightMeta=await api.request(`/api/imports/${result.right_import_id}`);
      const leftPreview=await waitFor(`/api/imports/${result.left_import_id}/preview`,{offset:0,limit:LIMIT});
      const rightPreview=await waitFor(`/api/imports/${result.right_import_id}/preview`,{offset:0,limit:LIMIT});
      const configBlob=await api.download(`/api/configs/${result.config_asset_id}/export`);
      const configText=await configBlob.text();
      if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在示例载入期间已变化；当前来源未替换。');
      exampleLabel=result.source_label;
      sources.left={...leftMeta.asset,name:`${name} 左侧`,label:result.source_label,preview:leftPreview.preview,import:leftMeta.import};
      sources.right={...rightMeta.asset,name:`${name} 右侧`,label:result.source_label,preview:rightPreview.preview,import:rightMeta.import};
      const config=JSON.parse(configText);pageLimit.left=LIMIT;pageLimit.right=LIMIT;
      store.update({left_import_id:result.left_import_id,right_import_id:result.right_import_id,left_headers:leftPreview.preview.headers,right_headers:rightPreview.preview.headers,config_asset_id:result.config_asset_id,config,draft_dirty:false,error:null,pending_decisions:[]});
    } catch(error){notice=`示例载入失败：${error.message}`;store.update({error:error.message});}
    finally{busy=false;if(store.get().active_job?.job_id===null&&store.get().active_job?.phase==='正在载入示例')store.update({active_job:null});render();}
  }
  async function bindRevision(revision, expectedRevisionId = store.get().revision?.revision_id??null, expectedGeneration = store.generation()) {
    const generation = expectedGeneration, old = store.get(), priorLock=old.active_job;
    bindingRevision={job_id:'revision-bind',phase:'publishing',state:'running'};store.update({active_job:bindingRevision});
    const stillSelected = () => generation === store.generation() && (store.get().revision?.revision_id??null) === expectedRevisionId && (!store.get().active_job || store.get().active_job.phase === 'comparing' || store.get().active_job.job_id === 'revision-bind');
    try {
      const [leftMeta, rightMeta] = await Promise.all([
        api.request(`/api/imports/${revision.left_import_id}`),
        api.request(`/api/imports/${revision.right_import_id}`),
      ]);
      const configBlobPromise = api.download(`/api/configs/${revision.config_asset_id}/export`);
      const leftPage = await waitFor(`/api/imports/${revision.left_import_id}/preview`, { offset: 0, limit: LIMIT });
      const rightPage = await waitFor(`/api/imports/${revision.right_import_id}/preview`, { offset: 0, limit: LIMIT });
      const configBlob = await configBlobPromise;
      const config = JSON.parse(await configBlob.text());
      if (!stillSelected()) throw new Error('选择的版本或当前来源已变化；没有替换工作台绑定。');
      sources.left = { ...leftMeta.asset, label: '当前分支原始快照', preview: leftPage.preview, import: leftMeta.import };
      sources.right = { ...rightMeta.asset, label: '当前分支原始快照', preview: rightPage.preview, import: rightMeta.import };
      exampleLabel = '当前分支原始快照';
      store.update({
        left_import_id: revision.left_import_id, right_import_id: revision.right_import_id,
        left_headers: leftPage.preview.headers, right_headers: rightPage.preview.headers,
        config_asset_id: revision.config_asset_id, config, draft_dirty: false, pending_decisions: [], error: null,
      });
      // Input/config generation changes mark the old report stale. Publish this
      // new revision separately, only after both snapshot bindings are visible.
      store.update({ revision, stale: false, pending_decisions: [], error: null });
      busy = false; notice = ''; render();
      return { prior: old };
    } finally {bindingRevision=null;store.update({active_job:priorLock});}
  }
  async function cancel(){if(!activeJob)return;try{await api.request(`/api/jobs/${activeJob.job_id}`,{method:'DELETE'});notice='已请求取消，等待服务确认任务结束。';}catch(error){notice=error.message;}render();}
  async function swapSides(){
    if(busy||store.get().active_job||!sources.left||!sources.right||!globalThis.confirm('交换左右来源会使用已保存的原始来源资产和转换选择重新导入两侧，清除规则和待应用决定，并将当前报告标记为旧版本。继续？'))return;
    const oldLeft=sources.left,oldRight=sources.right,generation=store.generation(),left=store.get().left_import_id,right=store.get().right_import_id;busy=true;notice='正在用已有文件重新导入左右两侧…';render();
    try{
      const reimport=async(source,side)=>waitFor('/api/imports',{asset_id:source.asset_id,side,...(source.format==='xlsx'?{import_spec:source.profile.import_spec}:{})});
      const newLeft=await reimport(oldRight,'left');
      const newRight=await reimport(oldLeft,'right');
      if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在交换期间已变化；当前来源未替换。');
      const meta=async(source,output)=>source.format==='xlsx'?{...source,import:output.import,preview:output.preview,manifest:JSON.parse(await (await api.download(`/api/imports/${output.import.import_id}/materials/export?kind=manifest`)).text())}:{...source,import:output.import,preview:output.preview};
      const [leftSource,rightSource]=await Promise.all([meta(oldRight,newLeft),meta(oldLeft,newRight)]);
      if(generation!==store.generation()||left!==store.get().left_import_id||right!==store.get().right_import_id)throw new Error('来源在交换期间已变化；当前来源未替换。');
      sources.left=leftSource;sources.right=rightSource;errors.left=null;errors.right=null;
      store.update({left_import_id:newLeft.import.import_id,right_import_id:newRight.import.import_id,left_headers:newLeft.preview.headers,right_headers:newRight.preview.headers,config_asset_id:null,config:null,draft_dirty:false,pending_decisions:[],error:null});
      const formatLabel=oldLeft.format==='xlsx'&&oldRight.format==='xlsx'?'XLSX':oldLeft.format==='csv'&&oldRight.format==='csv'?'CSV':'来源';
      notice=`左右 ${formatLabel} 已交换并重新导入。请重新设置并校验规则；旧报告仍可只读查看。`;
    }catch(error){notice=`交换未完成：${error.message}`;}
    finally{busy=false;render();}
  }
  function errorCard(error){const children=[element('p',{text:`${error.code??'导入错误'}：${error.message}`})];if(error.record!=null)children.push(element('p',{text:error.inputFormat==='xlsx'?`工作表物理位置：第 ${error.record} 行${error.field?`，单元格 ${error.field}`:''}。修正后重新导入。`:`错误位置：含表头的逻辑记录 ${error.record}${error.field?`，字段 ${error.field}`:''}。修正后重新选择文件。预览数据行号不包含表头。`}));return element('div',{className:'notice error',role:'alert'},children);}
  function renderRows(side,preview){const table=element('table',{className:'preview-table'}),thead=element('thead'),head=element('tr');head.append(element('th',{scope:'col',text:'数据记录'}));for(const column of preview.headers)head.append(element('th',{scope:'col',text:column}));thead.append(head);const body=element('tbody');for(const row of preview.rows){const tr=element('tr');tr.append(element('th',{scope:'row',text:row.record}));for(const cell of row.cells){const td=element('td'),text=element('span',{text:cell.value});td.append(text);if(cell.truncated){td.append(element('span',{className:'truncated-tag',text:`已截断 · ${cell.utf8_bytes} UTF-8 字节`}));td.append(button('查看完整值',()=>void fullCell(side,row.record,cell.column),{className:'secondary'}));}tr.append(td);}body.append(tr);}table.append(thead,body);return element('div',{className:'table-scroll'},table);}
  async function fullCell(side,record,column){if(busy||store.get().active_job)return;try{const out=await waitFor(`/api/imports/${sources[side].import.import_id}/cell`,{record,column});const dialog=element('dialog');dialog.append(element('h3',{text:`完整单元格：${column} · 数据记录 ${record}`}),element('pre',{text:out.cell.value}),button('关闭',()=>dialog.close()));document.body.append(dialog);dialog.showModal();}catch(error){notice=`读取完整单元格失败：${error.message}`;render();}}
  let lastJob=store.get().active_job;
  const dispose=store.subscribe((next)=>{if(next.active_job!==lastJob){lastJob=next.active_job;if(!busy)render();}});
  function clear(){xlsxSelection?.dispose();xlsxSelection=null;sources.left=null;sources.right=null;errors.left=null;errors.right=null;pageLimit.left=LIMIT;pageLimit.right=LIMIT;activeJob=null;busy=false;bindingRevision=null;notice='';exampleLabel='';render();}
  let xlsxSelection=null;
  render();return { dispose:()=>{xlsxSelection?.dispose();dispose();root.replaceChildren();}, bindRevision, clear, setXlsxEnabled(value){xlsxEnabled=Boolean(value);render();} };
}
