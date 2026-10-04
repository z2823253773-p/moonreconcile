import process from 'node:process';
import { executeTask } from './engine-host.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import { sanitizeError } from './contracts.mjs';
process.umask(0o077);
let started=false;
process.on('message',async message=>{
  if(started||!message?.task||!message.job_id)return;started=true;
  const {job_id,task}=message;
  const send=(value)=>process.send?.({job_id,...value},()=>process.disconnect());
  try {
    process.send?.({job_id,type:'phase',phase:task.kind==='compare'||task.kind==='branch'?'comparing':task.kind==='review'?'resolving':'validating'});
    const invoke=await loadBridgeInvoke(task.bridge_path);
    const output=await executeTask(task,{invoke,signal:{get aborted(){return !process.connected;}}});send({type:'result',output});
  }catch(e){send({type:'error',error:sanitizeError(e,Object.values(task.paths??{}))});}
});
