import { executeTask } from './engine-host.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import process from 'node:process';
process.umask(0o077);
let active;
process.on('message',async m=>{
  if(!m?.task||!m.job_id)return;active=m.job_id;
  try { const invoke=await loadBridgeInvoke(m.task.bridge_path);const output=await executeTask(m.task,{invoke,signal:{get aborted(){return !process.connected;}}});if(active===m.job_id)process.send?.({job_id:m.job_id,type:'result',output},()=>process.disconnect()); }
  catch(e){process.send?.({job_id:m.job_id,type:'error',error:e.error??{code:e.code??'task_failed',message:e.message,phase:'engine',side:null,record:null,field:null}},()=>process.disconnect());}
});
