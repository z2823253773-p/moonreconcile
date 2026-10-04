import { button, element, label } from './dom.mjs';
import { formatTaskFailure } from './result-view.mjs';

function save(blob,name) {
  const url=URL.createObjectURL(blob),link=element('a',{href:url,download:name});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function renderExportView({root,store,api,onRestored=async()=>{},onReset=async()=>{}}) {
  let busy=false,jobId=null,message='';
  const errorDetail=error=>formatTaskFailure('',error);
  const render=()=>{
    const revision=store.get().revision;root.replaceChildren(element('h3',{text:'导出与恢复'}));
    const pending=store.get().pending_decisions??[];
    root.append(element('p',{className:'notice',role:'note',text:`待应用决定：${pending.length} 项。导出只包含当前选中已发布版本的累计决定，不包含这些未提交草稿。恢复会重放报告。`}));
    if(message)root.append(element('p',{className:'notice error',role:'alert',text:message}));
    const files=element('div',{className:'toolbar'});
    for(const [kind,name] of [['report','report.json'],['summary','summary.md'],['decisions','decisions.csv']])files.append(button(`下载 ${name}`,()=>void download(`/api/runs/${revision.revision_id}/export?kind=${kind}`,name),{disabled:busy||Boolean(store.get().active_job)||!revision}));
    const archive=button(busy?'正在打包…':'下载完整运行 ZIP',()=>void createBundle(),{className:'secondary',disabled:busy||Boolean(store.get().active_job)||!revision});
    files.append(archive);root.append(files);
    const zip=element('input',{type:'file',accept:'.zip,application/zip',disabled:busy||Boolean(store.get().active_job)});zip.setAttribute('aria-label','选择 MoonReconcile ZIP 工作包');
    const restore=button(busy?'正在恢复…':'恢复 ZIP 工作包',()=>{if(zip.files?.[0])void restoreBundle(zip.files[0]);},{disabled:busy||Boolean(store.get().active_job)});
    const reset=button('重置本机工作台',()=>void resetSession(),{className:'danger',disabled:busy||Boolean(store.get().active_job)});
    root.append(label('ZIP 工作包',zip),restore,reset);
    if(busy)root.append(element('p',{className:'notice',role:'status',text:store.get().active_job?.phase?`服务正在${store.get().active_job.phase}工作包。取消会等待本任务退出后清理暂存。`:'正在上传 ZIP 工作包。'}),jobId?button('取消当前任务',()=>void cancel(),{className:'danger'}):null);
  };
  async function wait(route,body,keepLock=false) {
    const uploadReservation=store.get().active_job?.job_id===null&&store.get().active_job?.phase==='上传工作包'&&busy;
    if(store.get().active_job&&!uploadReservation)throw Object.assign(new Error('已有工作台任务正在运行。'),{code:'session_busy'});
    busy=true;store.update({active_job:{job_id:null,phase:route.includes('/bundle')?'packing':'restoring',state:'running'}});render();
    try{const accepted=await api.request(route,{method:'POST',body});jobId=accepted.job_id;store.update({active_job:{job_id:jobId,phase:route.includes('/bundle')?'packing':'restoring',state:'running'}});render();return await api.waitJob(jobId);}
    finally{const finished=jobId;jobId=null;if(keepLock){store.update({active_job:{job_id:null,phase:'revision-bind',state:'running'}});}else{busy=false;if(store.get().active_job?.job_id===finished||store.get().active_job?.job_id===null)store.update({active_job:null});}render();}
  }
  async function download(route,name) {
    message='';render();try{save(await api.download(route),name);}catch(error){message=`下载失败：${errorDetail(error)}`;render();}
  }
  async function createBundle() {
    if(busy||store.get().active_job||!store.get().revision)return;const revisionId=store.get().revision.revision_id;
    try{const job=await wait(`/api/runs/${revisionId}/bundle`,{},true);save(await api.download(`/api/bundles/${job.output.bundle_asset_id}/export`),`moonreconcile-${revisionId.slice(0,8)}.zip`);}
    catch(error){message=`ZIP 导出失败：${errorDetail(error)}`;render();}
    finally{busy=false;if(store.get().active_job?.job_id===null)store.update({active_job:null});render();}
  }
  async function restoreBundle(file) {
    if(busy||store.get().active_job)return;
    const startRevisionId=store.get().revision?.revision_id??null,startGeneration=store.generation();
    message='';busy=true;store.update({active_job:{job_id:null,phase:'上传工作包',state:'running'}});render();
    try {
      const asset=await api.upload('run',file);
      const job=await wait('/api/restores',{asset_id:asset.asset_id},true);
      const bound=await onRestored(job.output.revision,{startRevisionId,startGeneration});
      message=bound===false?'ZIP 已重放验证，新版本已登记到历史；当前选择或来源已变化，保留当前工作台。':'ZIP 已重放验证并恢复为本机会话中的新版本。';
    } catch(error){message=`ZIP 恢复失败：${errorDetail(error)}`;}
    finally{busy=false;jobId=null;if(store.get().active_job?.job_id===null)store.update({active_job:null});render();}
  }
  async function resetSession(){
    if(busy||store.get().active_job)return;
    if(!globalThis.confirm('清空本机工作台中的来源、规则、报告和任务历史？此操作不能撤销。'))return;
    busy=true;store.update({active_job:{job_id:null,phase:'重置',state:'running'}});render();
    try{await api.request('/api/sessions/reset',{method:'POST',body:{confirm:true}});await onReset();message='本机工作台已重置。';}
    catch(error){message=`重置失败：${errorDetail(error)}`;}
    finally{busy=false;if(store.get().active_job?.phase==='重置')store.update({active_job:null});render();}
  }
  async function cancel(){if(!jobId)return;try{await api.request(`/api/jobs/${jobId}`,{method:'DELETE'});}catch(error){message=`取消失败：${errorDetail(error)}`;}render();}
  const unsubscribe=store.subscribe(()=>render());render();
  const dispose=()=>{unsubscribe();root.replaceChildren();};dispose.refresh=render;return dispose;
}
