import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLimits, failure, errorDto, sanitizeError, project, PHASES, jsonBytes, assertDto, exact } from './contracts.mjs';
const DEFAULT_WORKER=fileURLToPath(new URL('./worker.mjs',import.meta.url));

// Trim only complete preview rows before any registry commit; every succeeded
// job must remain pollable with the final HTTP envelope.
function fitOutput(job,output,budget) {
  const fits=()=>jsonBytes({ok:true,job:{...project('job',job),state:'succeeded',phase:'publishing',output,error:null}})<=budget;
  if(output.preview) {
    const p=output.preview;assertDto('preview',p);
    while(!fits()&&p.rows.length>1){p.rows.pop();p.next_offset=p.offset+p.rows.length;p.has_more=p.next_offset<p.row_count;}
  }
  if(!fits())throw failure('response_limit_exceeded','Job display limit exceeded; request a smaller preview page or use the CLI',413,'publishing');
  return output;
}
export async function createJobManager({session,workerPath=DEFAULT_WORKER,bridgePath,limits:overrides={}}={}) {
  const limits=normalizeLimits(overrides),jobs=new Map();let active=null,closed=false,resetting=false;
  function start(kind,payload={}) {
    if(closed)throw failure('session_closed','Session is closing',409);
    if(resetting)throw failure('session_busy','Session is resetting',409);
    if(active)throw failure('job_busy','A task is already active',409);
    if(jobs.size>=limits.jobs)throw failure('quota_exceeded','Job metadata quota exceeded',413);
    if(!['import','preview','cell','draft','check','compare','example'].includes(kind))throw failure('invalid_task','Unsupported task kind');
    const job={job_id:randomUUID(),kind,state:'running',phase:'reading',output:null,error:null};jobs.set(job.job_id,job);
    const record={job,generation:session.generation,child:null,staging:null,blocked:false,cause:null,candidate:null,workerError:null,exited:false};active=record;
    let finish;record.done=new Promise(resolve=>finish=resolve);
    const valid=()=>!record.blocked&&!closed&&active===record&&job.state==='running'&&session.generation===record.generation;
    function stop(cause=null) {
      if(!['running','cancelling'].includes(job.state))return;
      record.blocked=true;record.cause??=cause;job.state='cancelling';record.candidate=null;
      if(record.child&&!record.exited) {
        record.child.kill('SIGTERM');
        record.killTimer??=setTimeout(()=>{if(!record.exited)record.child.kill('SIGKILL');},limits.kill_ms);
      }
    }
    record.stop=stop;
    record.timer=setTimeout(()=>stop(errorDto('job_timeout','Task time limit exceeded')),limits.job_ms);
    async function finalize(code) {
      try {
        if(valid()) {
          if(record.workerError)throw Object.assign(new Error(record.workerError.message),{error:record.workerError});
          if(code!==0||!record.candidate)throw failure('worker_failed','Worker exited without a valid result');
          job.phase='publishing';
          if(['preview','cell'].includes(kind)){exact(record.candidate,[kind]);assertDto(kind,record.candidate[kind]);}
          const prepared=record.prepareOutput?await record.prepareOutput(record.candidate):{output:record.candidate,commit:()=>{}};
          fitOutput(job,prepared.output,limits.response_bytes);
          await session.checkQuota();
          // No await from the final latch through registry/head/job commit.
          if(valid()) {prepared.commit?.();job.output=prepared.output;job.error=null;job.state='succeeded';}
        }
      }catch(e){if(!record.blocked){record.blocked=true;record.cause=sanitizeError(e,[session.root]);}}
      clearTimeout(record.timer);clearTimeout(record.killTimer);clearInterval(record.quotaTimer);
      if(job.state!=='succeeded') {
        if(record.staging)try{await session.remove(record.staging);}catch(e){record.cause=sanitizeError(e);}
        job.output=null;job.error=record.cause;job.state=record.cause?'failed':'cancelled';
      }
      session.release(job.job_id);if(active===record)active=null;finish(job);
    }
    void (async()=>{
      try {
        await session.reserve(job.job_id,payload.reservation??0);
        record.staging=await session.staging('job');await session.reserve(job.job_id,payload.reservation??0,record.staging);
        let checking=false;record.quotaTimer=setInterval(async()=>{
          if(checking)return;checking=true;
          try{await session.checkQuota();}catch(e){if(active===record&&['running','cancelling'].includes(job.state))stop(sanitizeError(e));}finally{checking=false;}
        },limits.quota_poll_ms);
        const prepared=payload.prepare?await payload.prepare({staging:record.staging,generation:record.generation}):{task:payload.task??{kind,payload,paths:{}},prepareOutput:payload.prepareOutput};
        record.prepareOutput=prepared.prepareOutput;
        if(!valid())return await finalize(null);
        const task={...prepared.task,kind,bridge_path:bridgePath};
        const child=fork(workerPath,[],{stdio:['ignore','ignore','ignore','ipc'],cwd:session.root,env:{...process.env},execArgv:[]});record.child=child;
        child.on('message',m=>{
          if(!valid()||!m||m.job_id!==job.job_id)return;
          if(m.type==='phase'&&PHASES.includes(m.phase))job.phase=m.phase;
          else if(m.type==='result'&&m.output&&typeof m.output==='object'&&!record.candidate){record.candidate=m.output;job.phase='publishing';}
          else if(m.type==='error')record.workerError=sanitizeError(m.error,[session.root]);
        });
        child.on('error',()=>{record.workerError=errorDto('worker_failed','Worker process failed');});
        child.once('exit',code=>{record.exited=true;void finalize(code);});
        child.send({job_id:job.job_id,task},e=>{if(e)stop(errorDto('worker_failed','Worker IPC failed'));});
      }catch(e){record.blocked=true;record.cause=sanitizeError(e,[session.root]);await finalize(null);}
    })();
    return job;
  }
  function get(id){const job=jobs.get(id);if(!job)throw failure('not_found','Job not found',404);return job;}
  async function cancel(id){const job=get(id);if(active?.job===job){const r=active;r.stop();await r.done;}return job;}
  async function reset(){
    if(closed)throw failure('session_closed','Session is closing',409);
    if(active||resetting)throw failure('session_busy','Active task or reset prevents reset',409);
    resetting=true;
    try{await session.reset();jobs.clear();}finally{resetting=false;}
  }
  async function close(){closed=true;if(active){const r=active;r.stop();await r.done;}}
  return {start,get,cancel,reset,close,jobs,get active(){return active?.job.job_id??null;}};
}
