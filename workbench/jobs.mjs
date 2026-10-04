import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DEFAULT_WORKER=fileURLToPath(new URL('./worker.mjs',import.meta.url));
export async function createJobManager({session,workerPath=DEFAULT_WORKER,bridgePath,limits={}}={}) {
  const jobs=new Map();let active=null,closed=false;
  const start=(kind,payload)=>{
    if(closed)throw new Error('closed');if(active)throw Object.assign(new Error('job busy'),{status:409,code:'job_busy'});
    if(jobs.size>=(limits.jobs??256))throw Object.assign(new Error('job quota exceeded'),{status:429,code:'quota_exceeded'});
    const id=randomUUID(), job={job_id:id,kind,state:'running',phase:kind==='compare'?'comparing':'validating',output:null,error:null};jobs.set(id,job);active=id;
    const task=payload.task??{kind,payload:payload.payload??payload,paths:payload.paths??{},bridge_path:bridgePath};
    const child=fork(workerPath,[],{stdio:['ignore','ignore','ignore','ipc'],cwd:session.root,env:{...process.env},execArgv:[]});let timer,killTimer;
    const finalize=()=>{clearTimeout(timer);clearTimeout(killTimer);if(active===id)active=null;};
    const cancel=async()=>{if(job.state!=='running'&&job.state!=='cancelling')return job;job.state='cancelling';child.kill('SIGTERM');await new Promise(resolve=>{killTimer=setTimeout(()=>{child.kill('SIGKILL');resolve();},limits.killMs??1000);child.once('exit',resolve);});if(job.state==='cancelling')job.state='cancelled';finalize();return job;};
    job.cancel=cancel;
    child.on('message',m=>{if(!m||m.job_id!==id||active!==id||job.state!=='running')return;if(m.type==='phase')job.phase=m.phase;else if(m.type==='result')job._candidate=m.output;else if(m.type==='error')job.error=m.error;});
    child.on('error',e=>{job.error={code:'worker_failed',message:e.message,phase:'host',side:null,record:null,field:null};});
    child.on('exit',async code=>{
      clearTimeout(timer);if(job.state==='cancelling'){job.state='cancelled';job._candidate=null;job.error=null;}
      else if(job.state==='running'){
        if(job.error){job.state='failed';}
        else if(code===0&&job._candidate){try{job.output=await payload.commit?.(job._candidate)??job._candidate;if(Buffer.byteLength(JSON.stringify({ok:true,job:safe(job)}))>(limits.responseBytes??2097152))throw Object.assign(new Error('job output exceeds response budget; retry with a smaller page'),{code:'response_limit_exceeded'});job.state='succeeded';}catch(e){job.output=null;job.error={code:e.code??'publish_failed',message:e.message,phase:'publishing',side:null,record:null,field:null};job.state='failed';}}
        else {job.error={code:'worker_failed',message:`worker exited ${code}`,phase:'host',side:null,record:null,field:null};job.state='failed';}
      }
      delete job._candidate;finalize();
    });
    child.send({job_id:id,task});
    timer=setTimeout(()=>{if(job.state==='running'){job.error={code:'job_timeout',message:'job time limit exceeded',phase:'host',side:null,record:null,field:null};job.state='cancelling';child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),limits.killMs??1000).unref();}},limits.jobTimeoutMs??180000);
    return job;
  };
  return {start,get:id=>{const j=jobs.get(id);if(!j)throw Object.assign(new Error('job not found'),{status:404});return j;},cancel:async id=>{const j=jobs.get(id);if(!j)throw Object.assign(new Error('job not found'),{status:404});return j.cancel?j.cancel():j;},close:async()=>{closed=true;if(active)await (jobs.get(active)?.cancel?.());}};
}
function safe(j){return {job_id:j.job_id,kind:j.kind,state:j.state,phase:j.phase,output:j.output??null,error:j.error??null};}
