import { createApiClient, consumeTokenFragment } from './api.mjs';
import { renderImportView } from './import-view.mjs';
import { renderConfigView } from './config-view.mjs';
import { createWorkbenchState } from './state.mjs';
import { button, element } from './dom.mjs';

const appRoot=document.querySelector('#app');
const token=consumeTokenFragment();
if(!token){appRoot.append(element('h1',{text:'MoonReconcile 本地工作台'}),element('p',{className:'notice error',role:'alert',text:'启动服务后，请使用终端提供的本机工作台链接。令牌只从链接片段读取，并立即从地址栏移除。'}));}
else {
  const store=createWorkbenchState(),api=createApiClient({origin:location.origin,token});
  const top=element('header',{className:'app-header'},[element('div',{},[element('p',{className:'eyebrow',text:'本机 CSV 核对'}),element('h1',{text:'MoonReconcile 工作台'}),element('p',{text:'选择文件，明确配置规则，再查看核心计算结果。'})])]);
  const steps=element('nav',{className:'step-nav','aria-label':'工作步骤'});const stepText=element('p',{role:'status',text:'步骤 1：选择左右 CSV'});steps.append(stepText);top.append(steps);
  const importRoot=element('section',{className:'panel',id:'imports'}),configRoot=element('section',{className:'panel',id:'config'}),runRoot=element('section',{className:'panel',id:'run'});
  appRoot.replaceChildren(top,importRoot,configRoot,runRoot);
  renderImportView({root:importRoot,store,api});renderConfigView({root:configRoot,store,api});
  let busy=false,jobId=null,summary=null;
  function renderRun(){
    runRoot.replaceChildren(element('h2',{text:'校验、运行与结果'}));
    const s=store.get();
    if(s.revision&&s.stale)runRoot.append(element('p',{className:'notice warning',role:'status',text:`旧版本 ${s.revision.revision_id} 保留为只读。变更来源或规则后，须完成新校验再运行。`}));
    if(s.active_job)runRoot.append(element('p',{className:'notice',role:'status',text:`任务处理中：${s.active_job.phase??'读取或校验'}。不显示估算百分比。`}));
    const enabled=Boolean(s.left_import_id&&s.right_import_id&&s.config_asset_id&&!s.draft_dirty&&!s.active_job&&!busy);
    runRoot.append(button(busy?'比较处理中…':'运行核心比较',()=>void compare(),{disabled:!enabled}));
    if(jobId)runRoot.append(button('取消当前任务',()=>void cancel(),{className:'danger'}));
    if(s.error)runRoot.append(element('p',{className:'notice error',role:'alert',text:s.error}));
    if(summary){
      const c=summary.computation||{},o=summary.summary||{};runRoot.append(element('div',{className:`result ${s.stale?'stale':''}`},[
        element('h3',{text:`结果 revision ${summary.revision.revision_id}${s.stale?' · 旧版本':''}`}),
        element('p',{text:summary.display_error??`计算状态：${c.status??'未知'}；退出码 ${summary.revision.exit_code}。完整状态由核心 Result 提供。`}),
        summary.display_error?null:element('pre',{text:JSON.stringify({computation:c,summary:o,structure:summary.structure},null,2)}),
        button('下载 report.json',()=>void download(`/api/runs/${summary.revision.revision_id}/export?kind=report`)),
      ]));
    }
  }
  async function compare(){
    const s=store.get();if(!s.config_asset_id||s.draft_dirty)return;
    busy=true;renderRun();
    try{
      const accepted=await api.request('/api/runs',{method:'POST',body:{left_import_id:s.left_import_id,right_import_id:s.right_import_id,config_asset_id:s.config_asset_id}});
      jobId=accepted.job_id;store.update({active_job:{job_id:jobId,phase:'comparing',state:'running'},error:null});renderRun();
      const job=await api.waitJob(jobId);const revision=job.output.revision;
      store.update({revision,stale:false,pending_decisions:[],active_job:null,error:null});
      try{summary=await api.request(`/api/runs/${revision.revision_id}/summary`);}
      catch(error){summary={revision,display_error:`比较已完成，但摘要超过显示预算或暂时不可读：${error.message}`};store.update({error:error.message});}
    }catch(error){store.update({active_job:null,error:error.message});}
    finally{jobId=null;busy=false;renderRun();}
  }
  async function cancel(){if(!jobId)return;try{await api.request(`/api/jobs/${jobId}`,{method:'DELETE'});}catch(error){store.update({error:error.message});renderRun();}}
  async function download(path){try{const blob=await api.download(path),url=URL.createObjectURL(blob),a=element('a',{href:url,download:'report.json'});a.click();setTimeout(()=>URL.revokeObjectURL(url),0);}catch(error){store.update({error:error.message});renderRun();}}
  store.subscribe((s)=>{const ready=s.left_import_id&&s.right_import_id;stepText.textContent=ready?'步骤 2：检查列、主键与规则':'步骤 1：选择左右 CSV';renderRun();});
  renderRun();
}
