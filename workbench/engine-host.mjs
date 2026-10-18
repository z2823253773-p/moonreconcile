import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../cli/main.mjs';
import { canonicalJsonStringify, decodeUtf8Fatal, parseJsonText } from '../cli/io.mjs';
import { assertDto, exact, failure, sanitizeError, errorDto } from './contracts.mjs';
import { readRunBundle, writeRunBundle } from './archive.mjs';
import { inspectXlsxPackage, disposeXlsxPackage, projectWorkbook } from './xlsx/package.mjs';
import { convertXlsx, readSourceCell } from './xlsx/adapter.mjs';
import { XLSX_LIMITS } from './xlsx/contracts.mjs';
import { verifyAndRegenerateImports } from './xlsx-bundle.mjs';

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
const kinds=new Set(['import','preview','cell','xlsx_catalog','source_cell','draft','check','compare','example','review','branch','restore','bundle']);
export async function executeTask(task,{invoke,signal}={}) {
  if(!kinds.has(task.kind))throw failure('invalid_task',`unknown task kind: ${task.kind}`);
  if(signal?.aborted)throw failure('cancelled','Task cancelled');
  const p=task.payload??{},paths=task.paths??{};
  try {
    if(task.kind==='xlsx_catalog') {
      const activeLimits={...XLSX_LIMITS,...p.limits};
      const packageStaging=path.join(paths.staging,'catalog-parts');await fs.mkdir(packageStaging,{recursive:true,mode:0o700});
      const inventory=await inspectXlsxPackage({assetPath:paths.xlsx,stagingPath:packageStaging,limits:activeLimits,signal});
      try {
        const workbook=projectWorkbook(inventory,p.asset_id),catalogPath=path.join(paths.staging,'workbook.json');
        await fs.writeFile(catalogPath,canonicalJsonStringify(workbook),{mode:0o600,flag:'wx'});
        return {catalog_path:catalogPath};
      } finally {await disposeXlsxPackage(inventory);}
    }
    if(task.kind==='import'&&p.format==='xlsx') {
      const result=await convertXlsx({assetPath:paths.xlsx,importSpec:p.import_spec,side:p.side,stagingPath:paths.staging,invoke,limits:{...XLSX_LIMITS,...p.limits},signal});
      await fs.rename(result.csv_path,paths.csv);await fs.rename(result.profile_path,paths.profile);await fs.rename(result.adapter_manifest_path,paths.adapter_manifest);
      return {csv_path:paths.csv,profile_path:paths.profile,adapter_manifest_path:paths.adapter_manifest,preview:result.preview};
    }
    if(task.kind==='source_cell') {
      const source_cell=await readSourceCell({assetPath:paths.xlsx,profilePath:paths.profile,canonicalCsvPath:paths.csv,side:p.side,record:p.record,column:p.column,invoke,stagingPath:paths.staging,limits:{...XLSX_LIMITS,...p.limits},signal});
      assertDto('source_cell',source_cell);return {source_cell};
    }
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
    if(task.kind==='review') {
      const exit_code=await runCli(['resolve',paths.baseline,'--decisions',paths.decisions,'--out',paths.run],invoke,path.dirname(paths.run));
      return {run_path:paths.run,exit_code};
    }
    if(task.kind==='branch') {
      const exit_code=await runCli(['compare',paths.left,paths.right,'--config',paths.config,'--out',paths.run],invoke,path.dirname(paths.run));
      return {run_path:paths.run,exit_code};
    }
    if(task.kind==='bundle') {
      const sidecar=parseJsonText(decodeUtf8Fatal(await fs.readFile(paths.sidecar),{phase:'input',what:'workbench bundle metadata'}),{phase:'input',what:'workbench bundle metadata'});
      const bundle=await writeRunBundle({runPath:paths.run,sidecar,destPath:paths.bundle,limits:p.limits,importMaterials:paths.importMaterials});
      return {bundle_path:paths.bundle,...bundle};
    }
    if(task.kind==='restore') {
      const {runPath,sidecar,importMaterials}=await readRunBundle({assetPath:paths.bundle,stagingPath:paths.restore,limits:p.limits});
      if(importMaterials&&!p.xlsxEnabled)throw failure('unsupported_format','XLSX bundle restore is not enabled',422,'restoring');
      const restoredImports=importMaterials?await verifyAndRegenerateImports({runPath,materials:importMaterials,stagingPath:paths.restore,invoke,limits:{...XLSX_LIMITS,...p.xlsxLimits},signal}):null;
      const replay=path.join(paths.restore,'replayed-run'),decisions=path.join(runPath,'decisions.csv');
      const exit_code=await runCli(['resolve',runPath,'--decisions',decisions,'--out',replay],invoke,paths.restore);
      const expected=await fs.readFile(path.join(runPath,'report.json'));
      const replayed=await fs.readFile(path.join(replay,'report.json'));
      if(!expected.equals(replayed))throw failure('replay_mismatch','Replayed report does not match the archived report',422,'restoring');
      const left=await executeTask({kind:'import',payload:{side:'left',offset:0,limit:20},paths:{csv:path.join(runPath,'input','left.csv')}},{invoke,signal});
      const right=await executeTask({kind:'import',payload:{side:'right',offset:0,limit:20},paths:{csv:path.join(runPath,'input','right.csv')}},{invoke,signal});
      return {run_path:replay,source_run_path:runPath,sidecar,exit_code,left_preview:restoredImports?.left.preview??left.preview,right_preview:restoredImports?.right.preview??right.preview,...(restoredImports?{restored_imports:restoredImports}:{})};
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
