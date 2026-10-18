import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeRunBundle, readRunBundle } from '../workbench/archive.mjs';
import { executeTask } from '../workbench/engine-host.mjs';
import { loadBridgeInvoke } from '../cli/bridge.mjs';
import { run } from '../cli/main.mjs';
import { mutateZip, repackPythonZip } from './helpers/zip-mutations.mjs';

const RUN_FILES = [
  'manifest.json','input/left.csv','input/right.csv','config.json','report.json',
  'pairs.csv','fields.csv','candidates.csv','decisions.csv','unresolved.csv','summary.md',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFor = name => Buffer.from(name === 'report.json' ? '{"schema_version":1,"engine_version":"0.1.0","exit_code":0}\n' : `${name}\n`);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moonreconcile-archive-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const runPath = path.join(root, 'run');
  await fs.mkdir(path.join(runPath,'input'), {recursive:true});
  for (const name of RUN_FILES) await fs.writeFile(path.join(runPath,name), bytesFor(name));
  const files = await Promise.all(RUN_FILES.map(async name => {const b=bytesFor(name);return {path:`run/${name}`,bytes:b.length,sha256:sha(b)};}));
  const sidecar = {schema_version:1,app_version:'0.2.0',engine_version:'0.1.0',revision:{revision_id:'00000000-0000-4000-8000-000000000001',parent_revision_id:null,baseline_revision_id:'00000000-0000-4000-8000-000000000001',run_id:'a'.repeat(64),report_sha256:sha(bytesFor('report.json')),decisions_sha256:sha(bytesFor('decisions.csv'))},files};
  return {root,runPath,sidecar};
}

test('writes the exact twelve-file whitelist and restores verified bytes', async t => {
  const f=await fixture(t),destPath=path.join(f.root,'bundle.zip'),assetPath=path.join(f.root,'input.zip'),stagingPath=path.join(f.root,'restore');
  const written=await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath});
  await fs.copyFile(destPath,assetPath);
  const read=await readRunBundle({assetPath,stagingPath});
  assert.equal(written.sha256,sha(await fs.readFile(destPath)));
  assert.deepEqual(read.sidecar,f.sidecar);
  for(const name of RUN_FILES)assert.deepEqual(await fs.readFile(path.join(read.runPath,name)),bytesFor(name));
  assert.deepEqual((await (await import('node:fs/promises')).readdir(read.runPath)).sort(),['candidates.csv','config.json','decisions.csv','fields.csv','input','manifest.json','pairs.csv','report.json','summary.md','unresolved.csv']);
});

for(const kind of ['local-path','local-name','local-encrypted','local-strong-encrypted','local-flags','local-descriptor','local-compression','osx-symlink','osx-special','osx-directory'])test(`rejects ${kind} metadata mutated independently of valid ZIP payloads`,async t=>{
  const f=await fixture(t),baseline=path.join(f.root,'baseline.zip'),assetPath=path.join(f.root,`${kind}.zip`),stagingPath=path.join(f.root,'stage');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:baseline});
  mutateZip(baseline,assetPath,kind);
  await assert.rejects(readRunBundle({assetPath,stagingPath}),{code:'invalid_bundle'});
  await assert.rejects(fs.stat(stagingPath),{code:'ENOENT'});
});

for(const kind of ['local-crc','local-compressed-size','local-uncompressed-size'])test(`rejects contradictory ${kind} without a data descriptor`,async t=>{
  const f=await fixture(t),baseline=path.join(f.root,'baseline.zip'),python=path.join(f.root,'python.zip'),assetPath=path.join(f.root,`${kind}.zip`),stagingPath=path.join(f.root,'stage');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:baseline});
  repackPythonZip(baseline,python,'deflated');mutateZip(python,assetPath,kind);
  await assert.rejects(readRunBundle({assetPath,stagingPath}),{code:'invalid_bundle'});
  await assert.rejects(fs.stat(stagingPath),{code:'ENOENT'});
});

for(const kind of ['python-stored','python-deflated','descriptor-values','osx-regular'])test(`preserves valid ${kind} ZIP bytes`,async t=>{
  const f=await fixture(t),baseline=path.join(f.root,'baseline.zip'),assetPath=path.join(f.root,`${kind}.zip`),stagingPath=path.join(f.root,'stage');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:baseline});
  if(kind.startsWith('python-'))repackPythonZip(baseline,assetPath,kind.slice(7));
  else mutateZip(baseline,assetPath,kind);
  const restored=await readRunBundle({assetPath,stagingPath});
  assert.deepEqual(restored.sidecar,f.sidecar);
  for(const name of RUN_FILES)assert.deepEqual(await fs.readFile(path.join(restored.runPath,name)),bytesFor(name));
});

test('rejects duplicate, unsafe, aliased, unknown, directory, and non-file ZIP entries', async t => {
  const f=await fixture(t),out=path.join(f.root,'malicious.zip');
  const encoded=Object.fromEntries(RUN_FILES.map(name=>[name,bytesFor(name).toString('base64')]));
  const python=String.raw`import json,sys,zipfile,warnings
warnings.filterwarnings('ignore',category=UserWarning)
kind,out=sys.argv[1:3]
sidecar=json.loads(sys.argv[3])
data_map=json.loads(sys.argv[4])
base=['workbench.json']+['run/'+p for p in ${JSON.stringify(RUN_FILES)}]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  names=base.copy()
  if kind=='duplicate': names.append('run/report.json')
  elif kind=='traversal': names.append('../outside')
  elif kind=='backslash': names.append('run\\evil')
  elif kind=='absolute': names.append('/tmp/evil')
  elif kind=='alias': names.append('RUN/REPORT.JSON')
  elif kind=='unicode': names.append('run/cafe\u0301.csv')
  elif kind=='unknown': names.append('extra.bin')
  elif kind=='directory': names.append('run/extra/')
  for name in names:
    data=(json.dumps(sidecar).encode() if name=='workbench.json' else __import__('base64').b64decode(data_map.get(name[4:],'eA==')))
    if kind=='symlink' and name=='run/report.json':
      i=zipfile.ZipInfo(name);i.create_system=3;i.external_attr=(0o120777<<16);z.writestr(i,data)
    elif kind=='special' and name=='run/report.json':
      i=zipfile.ZipInfo(name);i.create_system=3;i.external_attr=(0o060000<<16);z.writestr(i,data)
    else: z.writestr(name,data)
`;
  for(const kind of ['duplicate','traversal','backslash','absolute','alias','unicode','unknown','directory','symlink','special']){
    execFileSync('python3',['-c',python,kind,out,JSON.stringify(f.sidecar),JSON.stringify(encoded)]);
    await assert.rejects(readRunBundle({assetPath:out,stagingPath:path.join(f.root,`stage-${kind}`),limits:{zip_entries:20}}),{code:'invalid_bundle'});
  }
});

test('rejects missing entries, schema/hash/size mismatch, encryption, corruption, and truncation', async t => {
  const f=await fixture(t),out=path.join(f.root,'malformed.zip');
  const encoded=Object.fromEntries(RUN_FILES.map(name=>[name,bytesFor(name).toString('base64')]));
  const python=String.raw`import json,sys,zipfile
kind,out=sys.argv[1:3]
meta=json.loads(sys.argv[3])
data_map=json.loads(sys.argv[4])
files=${JSON.stringify(RUN_FILES)}
if kind=='missing': files=files[:-1]
elif kind=='field': meta['surprise']=1
elif kind=='engine': meta['engine_version']='9'
elif kind=='hash': meta['files'][0]['sha256']='0'*64
elif kind=='bytes': meta['files'][0]['bytes']+=9
with zipfile.ZipFile(out,'w',zipfile.ZIP_STORED) as z:
  z.writestr('workbench.json',json.dumps(meta))
  for name in files:z.writestr('run/'+name, (b'changed' if kind=='tamper' and name=='report.json' else (b'\x00'*4096 if kind=='bomb' and name=='summary.md' else __import__('base64').b64decode(data_map[name]))))
if kind=='encrypted':
  # Set encrypted flag on the first local entry and its central-directory record.
  b=bytearray(open(out,'rb').read());
  for sig,off in [(b'PK\x03\x04',6),(b'PK\x01\x02',8)]:
    i=b.find(sig);b[i+off]|=1
  open(out,'wb').write(b)
`;
  for(const kind of ['missing','field','engine','hash','bytes','tamper','encrypted','truncated']){
    execFileSync('python3',['-c',python,kind,out,JSON.stringify(f.sidecar),JSON.stringify(encoded)]);
    if(kind==='truncated'){const b=await fs.readFile(out);await fs.writeFile(out,b.subarray(0,b.length-19));}
    await assert.rejects(readRunBundle({assetPath:out,stagingPath:path.join(f.root,`stage-${kind}`),limits:{zip_entries:20,unzip_bytes:2048}}));
  }
});

test('counts real decompressed bytes and enforces raw archive and per-entry caps', async t => {
  const f=await fixture(t),out=path.join(f.root,'bundle.zip'),stage=path.join(f.root,'stage');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:out});
  await assert.rejects(readRunBundle({assetPath:out,stagingPath:stage,limits:{unzip_bytes:30}}),{code:'quota_exceeded'});
  await assert.rejects(readRunBundle({assetPath:out,stagingPath:stage,limits:{zip_bytes:12}}),{code:'quota_exceeded'});
});

test('writer enforces compressed and decompressed caps and removes a partial archive', async t => {
  const f=await fixture(t),out=path.join(f.root,'limited.zip');
  await assert.rejects(writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:out,limits:{zip_bytes:12}}),{code:'quota_exceeded'});
  await assert.rejects(fs.stat(out),{code:'ENOENT'});
  await assert.rejects(writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:out,limits:{unzip_bytes:40}}),{code:'quota_exceeded'});
});

test('yauzl size validation does not replace the required streamed CRC comparison', async t => {
  const f=await fixture(t),out=path.join(f.root,'crc.zip');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:out});
  const python=String.raw`import struct,sys
p=sys.argv[1];b=bytearray(open(p,'rb').read());target=b'run/report.json'
for sig,off in [(b'PK\x03\x04',14),(b'PK\x01\x02',16)]:
  pos=0
  while True:
    pos=b.find(sig,pos)
    if pos<0:break
    if sig==b'PK\x03\x04': n,x=struct.unpack_from('<HH',b,pos+26);name=bytes(b[pos+30:pos+30+n])
    else: n,x,c=struct.unpack_from('<HHH',b,pos+28);name=bytes(b[pos+46:pos+46+n])
    if name==target:
      value=struct.unpack_from('<I',b,pos+off)[0];struct.pack_into('<I',b,pos+off,value^1);break
    pos+=4
open(p,'wb').write(b)
`;
  execFileSync('python3',['-c',python,out]);
  await assert.rejects(readRunBundle({assetPath:out,stagingPath:path.join(f.root,'crc-stage')}),{code:'invalid_bundle'});
});

test('bundle_roundtrip_cli_report_equal: CLI replay is byte-identical and self-consistent forged reports fail replay', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-cli-bundle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const invoke=await loadBridgeInvoke(),source=path.resolve('examples/orders'),original=path.join(root,'original'),bundle=path.join(root,'original.zip'),sidecarPath=path.join(root,'sidecar.json');
  const exit=await run(['compare',path.join(source,'left.csv'),path.join(source,'right.csv'),'--config',path.join(source,'rules.json'),'--out',original],{invoke,cwd:root,stdout:()=>{},stderr:()=>{}});assert.equal(exit,1);
  const buildSidecar=async runPath=>{
    const manifest=JSON.parse(await fs.readFile(path.join(runPath,'manifest.json'),'utf8')),report=await fs.readFile(path.join(runPath,'report.json')),decisions=await fs.readFile(path.join(runPath,'decisions.csv'));
    const files=[];for(const name of RUN_FILES){const content=await fs.readFile(path.join(runPath,name));files.push({path:`run/${name}`,bytes:content.length,sha256:sha(content)});}
    return {schema_version:1,app_version:'0.2.0',engine_version:'0.1.0',revision:{revision_id:'00000000-0000-4000-8000-000000000001',parent_revision_id:null,baseline_revision_id:'00000000-0000-4000-8000-000000000001',run_id:manifest.run_id,report_sha256:sha(report),decisions_sha256:sha(decisions)},files};
  };
  const sidecar=await buildSidecar(original);await fs.writeFile(sidecarPath,JSON.stringify(sidecar));
  await executeTask({kind:'bundle',payload:{},paths:{run:original,sidecar:sidecarPath,bundle}},{invoke});
  const restored=await executeTask({kind:'restore',payload:{},paths:{bundle,restore:path.join(root,'restore')}},{invoke});
  assert.deepEqual(await fs.readFile(path.join(original,'report.json')),await fs.readFile(path.join(restored.run_path,'report.json')));
  const forgedRun=path.join(root,'forged');await fs.cp(original,forgedRun,{recursive:true});
  const forgedReport=JSON.parse(await fs.readFile(path.join(forgedRun,'report.json'),'utf8'));forgedReport.summary.candidate_count=(forgedReport.summary.candidate_count??0)+1;
  await fs.writeFile(path.join(forgedRun,'report.json'),JSON.stringify(forgedReport)+'\n');
  const forgedSidecar=await buildSidecar(forgedRun);forgedSidecar.revision.report_sha256=forgedSidecar.files.find(f=>f.path==='run/report.json').sha256;
  const forgedSidecarPath=path.join(root,'forged-sidecar.json'),forgedBundle=path.join(root,'forged.zip');await fs.writeFile(forgedSidecarPath,JSON.stringify(forgedSidecar));
  await writeRunBundle({runPath:forgedRun,sidecar:forgedSidecar,destPath:forgedBundle});
  await assert.rejects(executeTask({kind:'restore',payload:{},paths:{bundle:forgedBundle,restore:path.join(root,'forged-restore')}},{invoke}),{code:'replay_mismatch'});
});
