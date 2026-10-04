import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../cli/main.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import { canonicalJsonStringify, decodeUtf8Fatal, sha256Hex } from '../cli/io.mjs';

export function callEngine(request, invoke) {
  let value;
  try { value=JSON.parse(invoke(JSON.stringify(request))); } catch(e) { throw Object.assign(new Error('engine_failure'),{error:{code:'engine_failure',message:'Engine call failed',phase:'engine',side:null,record:null,field:null}}); }
  if (!value || typeof value.ok!=='boolean') throw new Error('invalid bridge response');
  if (!value.ok) { const e=value.error??{};throw Object.assign(new Error(e.message??'engine error'),{error:{code:e.code??'engine_error',message:e.message??'engine error',phase:e.phase??'engine',side:e.side??null,record:e.record??null,field:e.field??null}}); }
  return value;
}
const kinds=new Set(['import','preview','cell','draft','check','compare','example']);
export async function executeTask(task,{invoke,signal}={}) {
  if(!kinds.has(task.kind)) throw new Error(`unknown task kind: ${task.kind}`);
  if(signal?.aborted) throw new Error('cancelled');
  const p=task.payload, paths=task.paths;
  if(task.kind==='import'||task.kind==='preview'||task.kind==='cell') {
    const asset=decodeUtf8Fatal(await fs.readFile(paths.csv),{phase:'input',side:p.side}); const req=task.kind==='cell'?{op:'inspect_csv',csv:asset,side:p.side,cell:{record:p.record,column:p.column}}:{op:'inspect_csv',csv:asset,side:p.side,offset:p.offset??0,limit:p.limit??20};
    const response=callEngine(req,invoke); return task.kind==='cell'?{cell:response.cell}:{preview:response.preview};
  }
  if(task.kind==='draft') {
    const out=paths.config; const code=await run(['init-config',paths.left,paths.right,'--out',out],{invoke,cwd:path.dirname(out)});if(code!==0)throw new Error('init config failed');return {config_path:out,draft:true};
  }
  if(task.kind==='check') {
    const config=JSON.parse(decodeUtf8Fatal(await fs.readFile(paths.configInput),{phase:'input'})); const result=callEngine({op:'check_config',config},invoke);await fs.writeFile(paths.config,canonicalJsonStringify(result.config),{mode:0o600,flag:'wx'});return {config_path:paths.config,draft:false};
  }
  if(task.kind==='compare') {
    const code=await run(['compare',paths.left,paths.right,'--config',paths.config,'--out',paths.run],{invoke,cwd:path.dirname(paths.run)});
    if(code!==0&&code!==1&&code!==3)throw new Error('comparison failed');return {run_path:paths.run,exit_code:code};
  }
  throw new Error('task not implemented');
}

export async function inspectImport(bytes,{invoke,side,limit=20}) {
  const csv=decodeUtf8Fatal(bytes,{phase:'input',side});return callEngine({op:'inspect_csv',csv,side,offset:0,limit},invoke).preview;
}
