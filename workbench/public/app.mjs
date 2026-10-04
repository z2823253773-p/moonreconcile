import { createApiClient, consumeTokenFragment } from './api.mjs';
import { renderImportView } from './import-view.mjs';
import { renderConfigView } from './config-view.mjs';
import { renderResultView } from './result-view.mjs';
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
  const importView=renderImportView({root:importRoot,store,api});renderConfigView({root:configRoot,store,api});
  let busy=false,jobId=null,summary=null,resultDispose=null,resultRevisionId=null,latestRevisionId=null;
  const history=[];
  const remember=revision=>{if(revision&&!history.some(saved=>saved.revision_id===revision.revision_id))history.push(revision);};
  const resultHost=element('div',{className:'result-host'});
  function renderRun(){
    runRoot.replaceChildren(element('h2',{text:'校验、运行与结果'}));
    const s=store.get();
    if(s.revision&&s.stale)runRoot.append(element('p',{className:'notice warning',role:'status',text:`旧版本 ${s.revision.revision_id} 保留为只读。${s.config_asset_id&&!s.draft_dirty?'当前规则已校验，可运行新比较更新结果。':'校验当前规则后可运行新比较。'}`}));
    if(s.active_job)runRoot.append(element('p',{className:'notice',role:'status',text:`任务处理中：${s.active_job.phase??'读取或校验'}。不显示估算百分比。`}));
    const enabled=Boolean(s.left_import_id&&s.right_import_id&&s.config_asset_id&&!s.draft_dirty&&!s.active_job&&!busy);
    runRoot.append(button(busy?'比较处理中…':'运行核心比较',()=>void compare(),{disabled:!enabled}));
    if(jobId)runRoot.append(button('取消当前任务',()=>void cancel(),{className:'danger'}));
    if(s.error)runRoot.append(element('p',{className:'notice error',role:'alert',text:s.error}));
    if(summary){
      if(resultRevisionId!==summary.revision.revision_id){resultDispose?.();resultRevisionId=summary.revision.revision_id;resultHost.replaceChildren();resultDispose=renderResultView({root:resultHost,store,api,summary,onPublished:publishRevision,history,onSelectHistory:selectHistory,isCurrentHead:summary.revision.revision_id===latestRevisionId});}
      runRoot.append(resultHost);
    }
  }
  async function compare(){
    const s=store.get();if(!s.config_asset_id||s.draft_dirty||s.active_job)return;
    const generation=store.generation();
    busy=true;summary=null;resultDispose?.();resultDispose=null;resultRevisionId=null;resultHost.replaceChildren();renderRun();
    try{
      const accepted=await api.request('/api/runs',{method:'POST',body:{left_import_id:s.left_import_id,right_import_id:s.right_import_id,config_asset_id:s.config_asset_id}});
      jobId=accepted.job_id;store.update({active_job:{job_id:jobId,phase:'comparing',state:'running'},error:null});renderRun();
      const job=await api.waitJob(jobId);const revision=job.output.revision;
      remember(store.get().revision);remember(revision);latestRevisionId=revision.revision_id;
      const stillCurrent=generation===store.generation();
      store.update({revision,...(stillCurrent?{stale:false,pending_decisions:[]}:{stale:true}),active_job:null,error:null});
      const summaryGeneration=store.generation();
      if(store.get().revision?.revision_id===revision.revision_id)await loadSummary(revision,summaryGeneration);
    }catch(error){store.update({active_job:null,error:error.message});}
    finally{jobId=null;busy=false;renderRun();}
  }
  async function loadSummary(revision,generation){
    try{const loaded=await api.request(`/api/runs/${revision.revision_id}/summary`);if(generation!==store.generation()||store.get().revision?.revision_id!==revision.revision_id)return;summary=loaded;renderRun();}
    catch(error){if(generation!==store.generation()||store.get().revision?.revision_id!==revision.revision_id)return;summary={revision,display_error:`比较已完成，但摘要超过显示预算或暂时不可读：${error.message}`};store.update({error:error.message});}
  }
  async function publishRevision(revision,{branch=false}={}){
    remember(store.get().revision);remember(revision);latestRevisionId=revision.revision_id;
    if(branch)await importView.bindRevision(revision,store.get().revision?.revision_id);
    else store.update({revision,stale:false,pending_decisions:[],active_job:null,error:null});
    const generation=store.generation();await loadSummary(revision,generation);
  }
  async function selectHistory(revision){
    const current=revision.revision_id===latestRevisionId&&store.get().left_import_id===revision.left_import_id&&store.get().right_import_id===revision.right_import_id&&store.get().config_asset_id===revision.config_asset_id&&!store.get().draft_dirty;
    store.update({revision,stale:!current,error:null});
    const generation=store.generation();await loadSummary(revision,generation);
  }
  async function cancel(){if(!jobId)return;try{await api.request(`/api/jobs/${jobId}`,{method:'DELETE'});}catch(error){store.update({error:error.message});renderRun();}}
  let lastGeneration=store.generation();
  store.subscribe((s)=>{
    const ready=s.left_import_id&&s.right_import_id;stepText.textContent=ready?'步骤 2：检查列、主键与规则':'步骤 1：选择左右 CSV';renderRun();
    const generation=store.generation();
    if(generation!==lastGeneration){lastGeneration=generation;if(!summary&&!s.active_job&&s.revision)void loadSummary(s.revision,generation);}
  });
  renderRun();
}
