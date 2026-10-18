import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli/main.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import { callEngine, executeTask } from '../workbench/engine-host.mjs';
import { assertDto } from '../workbench/contracts.mjs';

test('strict DTO validation rejects field types, paths and malformed identifiers',()=>{
  for(const value of [{asset_id:'x',kind:'csv',name:'x',bytes:-1,sha256:'bad'},{asset_id:'x',kind:'csv',name:'x',bytes:1,sha256:'bad',path:'/private/tmp'}])assert.throws(()=>assertDto('asset',value));
});
test('orders_api_report_equals_cli; draft remains explicit and non-runnable',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'host-test-'));t.after(()=>fs.rm(root,{recursive:true}));
  const invoke=await loadBridgeInvoke();const paths={left:path.resolve('examples/orders/left.csv'),right:path.resolve('examples/orders/right.csv'),config:path.resolve('examples/orders/rules.json'),run:path.join(root,'host')};
  const o=await executeTask({kind:'compare',payload:{},paths},{invoke});assert.equal(o.exit_code,1);
  assert.equal(await run(['compare',paths.left,paths.right,'--config',paths.config,'--out',path.join(root,'cli')],{invoke,stdout:()=>{},stderr:()=>{}}),1);
  assert.deepEqual(await fs.readFile(path.join(paths.run,'report.json')),await fs.readFile(path.join(root,'cli/report.json')));
  const draft=path.join(root,'draft.json');await executeTask({kind:'draft',payload:{},paths:{...paths,config:draft}},{invoke});const d=JSON.parse(await fs.readFile(draft));assert.equal(d.draft,true);assert.ok(d.fields.every(f=>f.type===null));assert.throws(()=>callEngine({op:'check_config',config:d},invoke));
});
test('exit2 preserves six-field machine error and sanitizes paths and stacks',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'host-error-'));t.after(()=>fs.rm(root,{recursive:true}));
  await assert.rejects(executeTask({kind:'compare',payload:{},paths:{left:root+'/absent.csv',right:root+'/absent2.csv',config:root+'/absent.json',run:root+'/out'}},{invoke:()=>''}),e=>{
    assert.equal(Object.keys(e.error).length,6);assert.ok(!e.error.message.includes(root));assert.ok(!e.error.message.includes(' at '));return true;
  });
});
test('unknown task kinds cannot invoke engine',async()=>{await assert.rejects(executeTask({kind:'invented',payload:{},paths:{}},{invoke:()=>{throw Error('must not invoke');}}),/unknown/);});
for(const [name,transform] of [
  ['leading document BOM',s=>'\uFEFF'+s],
  ['interior mapping U+FEFF',s=>s.replace('mapped','mapped\uFEFFvalue')],
])test(`config asset matches CLI with ${name}`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'config-bom-'));t.after(()=>fs.rm(root,{recursive:true}));const invoke=await loadBridgeInvoke();
  const config={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',left_values:{raw:'mapped'}}],key:['id']};
  const source=path.join(root,'source.json'),output=path.join(root,'normal.json');await fs.writeFile(source,transform(JSON.stringify(config)));let stdout='';
  assert.equal(await run(['check-config',source],{invoke,stdout:s=>stdout+=s,stderr:()=>{}}),0);
  await executeTask({kind:'check',payload:{},paths:{configInput:source,config:output}},{invoke});
  assert.deepEqual(JSON.parse(await fs.readFile(output,'utf8')),JSON.parse(stdout));
});
test('malformed config asset retains invalid_json ErrorDTO code',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'config-invalid-'));t.after(()=>fs.rm(root,{recursive:true}));const source=path.join(root,'source.json');await fs.writeFile(source,'\uFEFF{');
  await assert.rejects(executeTask({kind:'check',payload:{},paths:{configInput:source,config:path.join(root,'normal.json')}},{invoke:await loadBridgeInvoke()}),e=>e.error.code==='invalid_json');
});
