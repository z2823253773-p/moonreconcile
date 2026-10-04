import { button, element, label } from './dom.mjs';

const LIMIT = 20;
const EXAMPLES = [['orders','合成 orders 示例'],['migration','合成 migration 示例'],['catalog','合成 catalog 示例'],['ourairports','OurAirports 公开快照']];

export function renderImportView({ root, store, api }) {
  const sources = { left: null, right: null }, errors = { left: null, right: null };
  const pageLimit = { left: LIMIT, right: LIMIT };
  let activeJob = null, busy = false, notice = '', exampleLabel = '';
  const render = () => {
    root.replaceChildren(element('h2',{text:'选择左右 CSV'}));
    root.append(element('p',{className:'notice',role:'note',text:'文件仅发送到本机服务暂存。每侧显示抽样预览行数与完整校验总行数；SHA-256、文件字节和列数来自服务端。'}));
    if (notice) root.append(element('p',{className:'notice error',role:'alert',text:notice}));
    const sides=element('div',{className:'source-grid'});
    for (const side of ['left','right']) {
      const title=side==='left'?'左侧来源':'右侧来源',box=element('section',{className:'source-card'});box.append(element('h3',{text:title}));
      const file=element('input',{type:'file',accept:'.csv',disabled:busy||Boolean(store.get().active_job)});file.setAttribute('aria-label',`${title} CSV 文件`);
      file.addEventListener('change',()=>{const picked=file.files?.[0];if(picked)void loadFile(side,picked);});
      const drop=element('div',{className:'drop-zone',tabindex:'0',role:'group','aria-label':`${title} 拖放区域`,text:'选择 CSV，或将文件拖放到这里'});
      drop.addEventListener('dragover',(event)=>{event.preventDefault();drop.classList.add('dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));
      drop.addEventListener('drop',(event)=>{event.preventDefault();drop.classList.remove('dragging');const picked=event.dataTransfer?.files?.[0];if(picked)void loadFile(side,picked);});
      drop.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();file.click();}});
      box.append(label(`${title} CSV`,file),drop);
      const source=sources[side];if(source){const perPage=element('select',{disabled:busy||Boolean(store.get().active_job)},[5,10,20].map((size)=>element('option',{value:size,selected:pageLimit[side]===size,text:`${size} 行`})));perPage.addEventListener('change',()=>{pageLimit[side]=Number(perPage.value);void page(side,source.preview.offset);});box.append(label('每页预览行数（可缩小显示）',perPage));box.append(element('div',{className:'source-meta'},[
        element('p',{text:`${source.label??source.name} · ${source.bytes.toLocaleString()} 字节 · SHA-256 ${source.sha256}`}),
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
    const accepted=await api.request(route,{method:'POST',body});activeJob={job_id:accepted.job_id,phase:'读取/校验'};store.update({active_job:{...activeJob,state:'running'}});render();
    try {const job=await api.waitJob(activeJob.job_id);return job.output;}
    finally {activeJob=null;store.update({active_job:null});}
  }
  async function loadFile(side,file) {
    busy=true;notice='';errors[side]=null;render();
    try {
      const asset=await api.upload('csv',file);const out=await waitFor('/api/imports',{asset_id:asset.asset_id,side});
      sources[side]={...asset,label:exampleLabel||file.name,preview:out.preview,import:out.import};
      store.update({[`${side}_import_id`]:out.import.import_id,[`${side}_headers`]:out.preview.headers,error:null});
    } catch(error) {errors[side]=error;notice=`${side==='left'?'左侧':'右侧'}文件未导入：${error.message}`;store.update({error:error.message});}
    finally{busy=false;render();}
  }
  async function page(side,offset) {
    busy=true;render();try{const s=sources[side];s.preview=(await waitFor(`/api/imports/${s.import.import_id}/preview`,{offset,limit:pageLimit[side]})).preview;}
    catch(error){notice=`预览失败（${error.code??'错误'}）：${error.message}。可将每页行数调到 5 后重试；若单行或表头仍超出显示预算，请缩短/拆分源表列后重新导入。`}finally{busy=false;render();}
  }
  async function loadExample(name) {
    busy=true;notice='';render();
    try {
      const result=await waitFor(`/api/examples/${name}`,{});exampleLabel=result.source_label;
      const leftMeta=await api.request(`/api/imports/${result.left_import_id}`),rightMeta=await api.request(`/api/imports/${result.right_import_id}`);
      const leftPreview=await waitFor(`/api/imports/${result.left_import_id}/preview`,{offset:0,limit:LIMIT});
      const rightPreview=await waitFor(`/api/imports/${result.right_import_id}/preview`,{offset:0,limit:LIMIT});
      const configBlob=await api.download(`/api/configs/${result.config_asset_id}/export`);
      sources.left={...leftMeta.asset,name:`${name} 左侧`,label:result.source_label,preview:leftPreview.preview,import:leftMeta.import};
      sources.right={...rightMeta.asset,name:`${name} 右侧`,label:result.source_label,preview:rightPreview.preview,import:rightMeta.import};
      const config=JSON.parse(await configBlob.text());
      store.update({left_import_id:result.left_import_id,right_import_id:result.right_import_id,left_headers:leftPreview.preview.headers,right_headers:rightPreview.preview.headers,config_asset_id:result.config_asset_id,config,draft_dirty:false,error:null,pending_decisions:[]});
    } catch(error){notice=`示例载入失败：${error.message}`;store.update({error:error.message});}
    finally{busy=false;render();}
  }
  async function cancel(){if(!activeJob)return;try{await api.request(`/api/jobs/${activeJob.job_id}`,{method:'DELETE'});notice='已请求取消，等待服务确认任务结束。';}catch(error){notice=error.message;}render();}
  async function swapSides(){
    if(!sources.left||!sources.right||!globalThis.confirm('交换左右来源会用已有 CSV 资产重新导入两侧，清除规则和待应用决定，并将当前报告标记为旧版本。继续？'))return;
    const oldLeft=sources.left,oldRight=sources.right;busy=true;notice='正在用已有文件重新导入左右两侧…';render();
    try{
      const newLeft=await waitFor('/api/imports',{asset_id:oldRight.asset_id,side:'left'});
      const newRight=await waitFor('/api/imports',{asset_id:oldLeft.asset_id,side:'right'});
      sources.left={...oldRight,import:newLeft.import,preview:newLeft.preview};sources.right={...oldLeft,import:newRight.import,preview:newRight.preview};errors.left=null;errors.right=null;
      store.update({left_import_id:newLeft.import.import_id,right_import_id:newRight.import.import_id,left_headers:newLeft.preview.headers,right_headers:newRight.preview.headers,config_asset_id:null,config:null,draft_dirty:false,pending_decisions:[],error:null});
      notice='左右 CSV 已交换并重新导入。请重新设置并校验规则；旧报告仍可只读查看。';
    }catch(error){notice=`交换未完成：${error.message}`;}
    finally{busy=false;render();}
  }
  function errorCard(error){const children=[element('p',{text:`${error.code??'导入错误'}：${error.message}`})];if(error.record!=null)children.push(element('p',{text:`错误位置：含表头的逻辑记录 ${error.record}${error.field?`，字段 ${error.field}`:''}。修正后重新选择文件。预览数据行号不包含表头。`}));return element('div',{className:'notice error',role:'alert'},children);}
  function renderRows(side,preview){const table=element('table',{className:'preview-table'}),thead=element('thead'),head=element('tr');head.append(element('th',{scope:'col',text:'数据记录'}));for(const column of preview.headers)head.append(element('th',{scope:'col',text:column}));thead.append(head);const body=element('tbody');for(const row of preview.rows){const tr=element('tr');tr.append(element('th',{scope:'row',text:row.record}));for(const cell of row.cells){const td=element('td'),text=element('span',{text:cell.value});td.append(text);if(cell.truncated){td.append(element('span',{className:'truncated-tag',text:`已截断 · ${cell.utf8_bytes} UTF-8 字节`}));td.append(button('查看完整值',()=>void fullCell(side,row.record,cell.column),{className:'secondary'}));}tr.append(td);}body.append(tr);}table.append(thead,body);return element('div',{className:'table-scroll'},table);}
  async function fullCell(side,record,column){try{const out=await waitFor(`/api/imports/${sources[side].import.import_id}/cell`,{record,column});const dialog=element('dialog');dialog.append(element('h3',{text:`完整单元格：${column} · 数据记录 ${record}`}),element('pre',{text:out.cell.value}),button('关闭',()=>dialog.close()));document.body.append(dialog);dialog.showModal();}catch(error){notice=`读取完整单元格失败：${error.message}`;render();}}
  let lastJob=store.get().active_job;
  const dispose=store.subscribe((next)=>{if(next.active_job!==lastJob){lastJob=next.active_job;if(!busy)render();}});
  render();return()=>{dispose();root.replaceChildren();};
}
