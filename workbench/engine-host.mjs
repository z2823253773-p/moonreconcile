import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../cli/main.mjs';
import { canonicalJsonStringify, decodeUtf8Fatal, parseJsonText } from '../cli/io.mjs';
import { assertDto, exact, failure, sanitizeError, errorDto } from './contracts.mjs';

function engineError(error,paths=[]) {const safe=sanitizeError(error,paths);return Object.assign(new Error(safe.message),{code:safe.code,error:safe});}
export function callEngine(request,invoke) {
  let value;
  try{value=JSON.parse(invoke(JSON.stringify(request)));}catch{throw failure('engine_failure','Engine call failed',400,'engine');}
  if(!value||typeof value.ok!=='boolean')throw failure('invalid_bridge_response','Invalid bridge envelope',400,'engine');
  if(!value.ok){try{assertDto('error',value.error);}catch{throw failure('invalid_bridge_response','Invalid bridge error',400,'engine');}throw engineError(value.error);}
  return value;
}
async function runCli(argv,invoke,cwd) {
  let stderr='',overflow=false;
  const capture=text=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(text)>65536)overflow=true;else stderr+=text;};
  const exit=await run(argv,{invoke,cwd,stdout:()=>{},stderr:capture});
  if([0,1,3].includes(exit))return exit;
  let error;
  if(!overflow) {
    const lines=stderr.trim().split('\n').filter(line=>line&&!line.startsWith('warning:'));
    if(lines.length===1)try{const v=JSON.parse(lines[0]);exact(v,['ok','error']);if(v.ok===false){assertDto('error',v.error);error=v.error;}}catch{}
  }
  throw engineError(error??errorDto('cli_failure','CLI failed without a valid machine error'),[cwd,...argv.filter(x=>path.isAbsolute(x))]);
}
const kinds=new Set(['import','preview','cell','draft','check','compare','example']);
export async function executeTask(task,{invoke,signal}={}) {
  if(!kinds.has(task.kind))throw failure('invalid_task',`unknown task kind: ${task.kind}`);
  if(signal?.aborted)throw failure('cancelled','Task cancelled');
  const p=task.payload??{},paths=task.paths??{};
  try {
    if(['import','preview','cell'].includes(task.kind)) {
      const csv=decodeUtf8Fatal(await fs.readFile(paths.csv),{phase:'input',side:p.side});
      const request=task.kind==='cell'?{op:'inspect_csv',csv,side:p.side,cell:{record:p.record,column:p.column}}:{op:'inspect_csv',csv,side:p.side,offset:p.offset??0,limit:p.limit??20};
      const response=callEngine(request,invoke),kind=task.kind==='cell'?'cell':'preview';assertDto(kind,response[kind]);return {[kind]:response[kind]};
    }
    if(task.kind==='draft') {
      await runCli(['init-config',paths.left,paths.right,'--out',paths.config],invoke,path.dirname(paths.config));return {config_path:paths.config,draft:true};
    }
    if(task.kind==='check') {
      const config=parseJsonText(decodeUtf8Fatal(await fs.readFile(paths.configInput),{phase:'input',allowInteriorBom:true}),{phase:'input',what:'configuration'});
      const result=callEngine({op:'check_config',config},invoke);
      await fs.writeFile(paths.config,canonicalJsonStringify(result.config),{mode:0o600,flag:'wx'});return {config_path:paths.config,draft:false};
    }
    if(task.kind==='compare') {
      const exit_code=await runCli(['compare',paths.left,paths.right,'--config',paths.config,'--out',paths.run],invoke,path.dirname(paths.run));
      return {run_path:paths.run,exit_code};
    }
    if(task.kind==='example') {
      const left=await executeTask({kind:'import',payload:{side:'left'},paths:{csv:paths.left}},{invoke,signal});
      const right=await executeTask({kind:'import',payload:{side:'right'},paths:{csv:paths.right}},{invoke,signal});
      const checked=await executeTask({kind:'check',payload:{},paths:{configInput:paths.configInput,config:paths.config}},{invoke,signal});
      // Large previews remain on disk; parent projects only import metadata.
      const meta=path.join(paths.staging,'imports.json');await fs.writeFile(meta,JSON.stringify({left:left.preview,right:right.preview}),{mode:0o600,flag:'wx'});
      return {metadata_path:meta,...checked};
    }
  }catch(e){throw engineError(e.error??{code:e.code??'task_failed',message:e.message,phase:e.phase??'engine',side:e.side??null,record:e.record??null,field:e.field??null},Object.values(paths));}
}
export async function inspectImport(bytes,{invoke,side,limit=20}) {return callEngine({op:'inspect_csv',csv:decodeUtf8Fatal(bytes,{phase:'input',side}),side,offset:0,limit},invoke).preview;}
