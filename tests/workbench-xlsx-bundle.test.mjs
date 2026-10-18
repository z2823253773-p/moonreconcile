import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import yauzl from 'yauzl';
import {writeRunBundle,readRunBundle} from '../workbench/archive.mjs';
import {inspectXlsxPackage,disposeXlsxPackage,projectWorkbook} from '../workbench/xlsx/package.mjs';
import {convertXlsx} from '../workbench/xlsx/adapter.mjs';
import {loadBridgeInvoke} from '../cli/bridge.mjs';

const ROOT=path.resolve(import.meta.dirname,'..');
const RUN_FILES=['manifest.json','input/left.csv','input/right.csv','config.json','report.json','pairs.csv','fields.csv','candidates.csv','decisions.csv','unresolved.csv','summary.md'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytesFor=n=>Buffer.from(n==='report.json'?'{}\n':`${n}\n`);

async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-xlsx-bundle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runPath=path.join(root,'run');await fs.mkdir(path.join(runPath,'input'),{recursive:true});
  for(const name of RUN_FILES)await fs.writeFile(path.join(runPath,name),bytesFor(name));
  const files=await Promise.all(RUN_FILES.map(async name=>{const b=await fs.readFile(path.join(runPath,name));return{path:`run/${name}`,bytes:b.length,sha256:sha(b)};}));
  const sidecar={schema_version:1,app_version:'0.2.0',engine_version:'0.1.0',revision:{revision_id:'00000000-0000-4000-8000-000000000001',parent_revision_id:null,baseline_revision_id:'00000000-0000-4000-8000-000000000001',run_id:'a'.repeat(64),report_sha256:sha(bytesFor('report.json')),decisions_sha256:sha(bytesFor('decisions.csv'))},files};
  return{root,runPath,sidecar};
}

async function xlsxMaterial(root,side,runPath,invoke){
  const sourcePath=path.resolve(ROOT,'tests/fixtures/xlsx/lo-conversion-1900.xlsx');
  const profilePath=path.join(root,`${side}.profile.json`),adapterManifestPath=path.join(root,`${side}.adapter.json`),csvPath=path.join(runPath,`input/${side}.csv`),parts=path.join(root,`${side}-parts`);
  await fs.mkdir(parts,{recursive:true});
  let inventory;
  try{
    inventory=await inspectXlsxPackage({assetPath:sourcePath,stagingPath:parts});
    const sheet=inventory.sheets.find(s=>s.selectable);
    const importSpec={schema_version:1,source_sha256:inventory.source.sha256,sheet_id:sheet.sheet_id,header_row:1,column_start:1,column_end:6,last_row:5,columns:[{column:1,mode:'stored_text'},{column:2,mode:'decimal_lexeme'},{column:3,mode:'stored_text'},{column:4,mode:'excel_date'},{column:5,mode:'zero_padded_identifier'},{column:6,mode:'stored_text'}],formula_policy:'reject'};
    const converted=await convertXlsx({assetPath:sourcePath,importSpec,side,stagingPath:path.join(root,`${side}-conversion`),invoke});
    await fs.copyFile(converted.profile_path,profilePath);await fs.copyFile(converted.adapter_manifest_path,adapterManifestPath);await fs.copyFile(converted.csv_path,csvPath);
  }finally{if(inventory)await disposeXlsxPackage(inventory);}
  return{side,format:'xlsx',sourcePath,profilePath,adapterManifestPath};
}

async function csvMaterial(runPath,side){return{side,format:'csv',sourcePath:path.join(runPath,`input/${side}.csv`)};}
async function pythonInventory(zipPath){
  const src=String.raw`import json,sys,zipfile,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 n=z.namelist(); m=json.loads(z.read('import/manifest.json')) if 'import/manifest.json' in n else None
 print(json.dumps({'names':n,'manifest':m,'hashes':{k:hashlib.sha256(z.read(k)).hexdigest() for k in n}}))`;
  return JSON.parse(execFileSync('python3',['-c',src,zipPath],{encoding:'utf8'}));
}

async function writeV2(t,sides){
  const f=await setup(t),invoke=await loadBridgeInvoke(),materials=[];
  for(let i=0;i<sides.length;i++){const side=i===0?'left':'right';materials.push(sides[i]==='xlsx'?await xlsxMaterial(f.root,side,f.runPath,invoke):await csvMaterial(f.runPath,side));}
  f.sidecar.files=await Promise.all(RUN_FILES.map(async name=>{const b=await fs.readFile(path.join(f.runPath,name));return{path:`run/${name}`,bytes:b.length,sha256:sha(b)};}));
  const normalized=materials;
  const destPath=path.join(f.root,'bundle.zip');
  const result=await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath,importMaterials:{manifestPath:path.join(f.root,'import-manifest.json'),sides:normalized}});
  return{...f,destPath,result,normalized};
}

test('csv_bundle_remains_exact12',async t=>{
  const f=await setup(t),destPath=path.join(f.root,'csv.zip');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath});
  const inventory=await pythonInventory(destPath);
  assert.equal(inventory.names.length,12);assert.equal(inventory.names.includes('import/manifest.json'),false);
  const read=await readRunBundle({assetPath:destPath,stagingPath:path.join(f.root,'restore')});
  assert.deepEqual(Object.keys(read).sort(),['runPath','sidecar']);
});

test('mixed_bundle_exact16_and_independent_zipfile_inventory',async t=>{
  const f=await writeV2(t,['xlsx','csv']),read=await readRunBundle({assetPath:f.destPath,stagingPath:path.join(f.root,'restore')});
  const inv=await pythonInventory(f.destPath);assert.equal(inv.names.length,16);assert.deepEqual(read.importMaterials.sides.map(s=>s.format),['xlsx','csv']);
  assert.equal(inv.manifest.sides.length,2);assert.equal(inv.manifest.sides[0].source.sha256,sha(await fs.readFile(f.normalized[0].sourcePath)));
  assert.equal(inv.hashes['import/left.profile.json'],sha(await fs.readFile(f.normalized[0].profilePath)));
  assert.equal(inv.names.some(n=>n.includes('row-map')),false);
});

test('two_xlsx_bundle_exact19',async t=>{
  const f=await writeV2(t,['xlsx','xlsx']),read=await readRunBundle({assetPath:f.destPath,stagingPath:path.join(f.root,'restore')});
  const inv=await pythonInventory(f.destPath);assert.equal(inv.names.length,19);assert.deepEqual(read.importMaterials.sides.map(s=>s.format),['xlsx','xlsx']);
  assert.equal(inv.hashes['import/left.xlsx'],sha(await fs.readFile(f.normalized[0].sourcePath)));
  assert.equal(inv.hashes['import/right.xlsx'],sha(await fs.readFile(f.normalized[1].sourcePath)));
});

test('v2_rejects_csv_only_13_file_bundle_and_malformed_version_inventories',async t=>{
  const f=await setup(t),base=path.join(f.root,'csv-v1.zip');
  await writeRunBundle({runPath:f.runPath,sidecar:f.sidecar,destPath:base});
  const generated=path.join(f.root,'mutations');await fs.mkdir(generated);
  const script=String.raw`import hashlib,json,sys,zipfile
base,out=sys.argv[1:]
with zipfile.ZipFile(base) as z: members={n:z.read(n) for n in z.namelist()}
s=json.loads(members['workbench.json']); runs={x['path']:x for x in s['files']}
s['schema_version']=2
sides=[]
for side in ('left','right'):
 p='run/input/'+side+'.csv'; item=runs[p]; sides.append({'side':side,'format':'csv','source':{'path':p,'bytes':item['bytes'],'sha256':item['sha256']}})
m=(json.dumps({'schema_version':1,'adapter_manifest_schema_version':1,'sides':sides},separators=(',',':'),sort_keys=True)+'\n').encode()
members['import/manifest.json']=m;s['files'].append({'path':'import/manifest.json','bytes':len(m),'sha256':hashlib.sha256(m).hexdigest()})
members['workbench.json']=(json.dumps(s,separators=(',',':'))+'\n').encode()
def write(name,edit=None,drop=None,duplicate=None):
 x=dict(members);side=json.loads(x['workbench.json'])
 if edit: edit(side,x)
 if drop: x.pop(drop,None)
 if name=='unknown-version': side['schema_version']=3;x['workbench.json']=(json.dumps(side,separators=(',',':'))+'\n').encode()
 with zipfile.ZipFile(out+'/'+name+'.zip','w',zipfile.ZIP_DEFLATED) as z:
  for n,v in x.items(): z.writestr(n,v)
  if duplicate: z.writestr(duplicate,x[duplicate])
write('csv-only-v2-13-files')
write('unknown-version')
write('missing-v2-entry',drop='import/manifest.json')
def bad_count(side,x): side['files']=side['files'][:-1];x['workbench.json']=(json.dumps(side,separators=(',',':'))+'\n').encode()
write('count-mismatch',edit=bad_count)
write('duplicate-entry',duplicate='run/report.json')
`;
  execFileSync('python3',['-c',script,base,generated],{stdio:'pipe'});
  for(const name of ['csv-only-v2-13-files','unknown-version','missing-v2-entry','count-mismatch','duplicate-entry']){
    await assert.rejects(readRunBundle({assetPath:path.join(generated,`${name}.zip`),stagingPath:path.join(f.root,`restore-${name}`)}),error=>error.code==='invalid_bundle',name);
  }
});

// These cases catch a missing material role cap before inflation/JSON parsing,
// and request-schema errors escaping the archive's invalid_bundle boundary.
const MATERIAL_JSON=['import/manifest.json','import/left.profile.json','import/right.profile.json','import/left.adapter.json','import/right.adapter.json'];
const MATERIAL_EVIDENCE=path.join(ROOT,'.superpowers/sdd/2026-10-08-restricted-xlsx/evidence/task-6/metadata-bounds');
function materialMutation(base,dest,target,{size,forgedSize,malformed}={}){
  const script=String.raw`import hashlib,json,struct,sys,zipfile
base,dest,target,options=sys.argv[1:];options=json.loads(options)
canonical=lambda v:(json.dumps(v,separators=(',',':'),sort_keys=True)+'\n').encode()
with zipfile.ZipFile(base) as z: members={n:z.read(n) for n in z.namelist()}
value=json.loads(members[target])
if 'size' in options:
 value['padding']='';value['padding']='x'*(options['size']-len(canonical(value)))
else:
 kind=options['malformed']
 if kind=='extra-root':value['unknown']=True
 elif kind=='missing-root':del value['schema_version']
 elif kind=='extra-side':value['sides'][0]['unknown']=True
 elif kind=='extra-file':value['sides'][0]['profile']['unknown']=True
members[target]=canonical(value)
manifest=json.loads(members['import/manifest.json'])
if target!='import/manifest.json':
 for side in manifest['sides']:
  for key in ('profile','adapter_manifest'):
   item=side.get(key)
   if item and item['path']==target:item.update(bytes=len(members[target]),sha256=hashlib.sha256(members[target]).hexdigest())
 members['import/manifest.json']=canonical(manifest)
sidecar=json.loads(members['workbench.json'])
for item in sidecar['files']:item.update(bytes=len(members[item['path']]),sha256=hashlib.sha256(members[item['path']]).hexdigest())
members['workbench.json']=canonical(sidecar)
with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as z:
 for name,data in members.items():z.writestr(name,data)
with zipfile.ZipFile(dest) as z:
 info=z.getinfo(target);actual=len(z.read(target));compressed=info.compress_size;offset=info.header_offset
 assert all(len(z.read(item['path']))==item['bytes'] and hashlib.sha256(z.read(item['path'])).hexdigest()==item['sha256'] for item in sidecar['files'])
if 'forgedSize' in options:
 data=bytearray(open(dest,'rb').read());struct.pack_into('<I',data,offset+22,options['forgedSize'])
 pos=data.rfind(b'PK\x05\x06');central=struct.unpack_from('<I',data,pos+16)[0]
 while data[central:central+4]==b'PK\x01\x02':
  length,extra,comment=struct.unpack_from('<HHH',data,central+28);name=data[central+46:central+46+length].decode()
  if name==target:struct.pack_into('<I',data,central+24,options['forgedSize']);break
  central+=46+length+extra+comment
 open(dest,'wb').write(data)
print(json.dumps({'target':target,'actual_bytes':actual,'compressed_bytes':compressed,'declared_bytes':options.get('forgedSize',actual),'outer_hashes_match_actual_bytes':True}))`;
  return JSON.parse(execFileSync('python3',['-c',script,base,dest,target,JSON.stringify({size,forgedSize,malformed})],{encoding:'utf8'}));
}

async function observeMaterialRead(t,options,target){
  const observed={stream_bytes:0,stream_opened:false,json_read_bytes:0};
  const originalStream=yauzl.ZipFile.prototype.openReadStreamPromise,originalRead=fs.readFile;
  t.mock.method(yauzl.ZipFile.prototype,'openReadStreamPromise',async function(entry,...args){
    const stream=await originalStream.call(this,entry,...args);
    if(entry.fileName===target){
      observed.stream_opened=true;const iterate=stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator]=async function*(){for await(const chunk of iterate()){observed.stream_bytes+=chunk.length;yield chunk;}};
    }
    return stream;
  });
  t.mock.method(fs,'readFile',async function(file,...args){
    const bytes=await originalRead.call(this,file,...args);
    if(file===path.join(options.stagingPath,target))observed.json_read_bytes+=Buffer.byteLength(bytes);
    return bytes;
  });
  try{await readRunBundle(options);return{...observed,code:null};}
  catch(error){return{...observed,code:error.code,message:error.message};}
  finally{t.mock.restoreAll();}
}

test('v2_material_json_is_bounded_before_inflation_and_read_with_owned_cleanup',async t=>{
  const f=await writeV2(t,['xlsx','xlsx']),original=await fs.readFile(f.destPath);
  const evidence=MATERIAL_EVIDENCE;await fs.mkdir(evidence,{recursive:true});
  for(const target of MATERIAL_JSON)for(const mode of ['frozen','lower','forged'])await t.test(`${target} ${mode}`,async sub=>{
    const cap=mode==='lower'?131072:1048576,label=`${target.replaceAll('/','-')}-${mode}`;
    const assetPath=path.join(f.root,`${label}.zip`),stagingPath=path.join(f.root,`restore-${label}`);
    const fixture=materialMutation(f.destPath,assetPath,target,{size:cap+1,...(mode==='forged'?{forgedSize:cap}:{})});
    const outcome=await observeMaterialRead(sub,{assetPath,stagingPath,...(mode==='lower'?{limits:{entry_bytes:cap}}:{})},target);
    const removed=await fs.access(stagingPath).then(()=>false,error=>error.code==='ENOENT');
    const receipt={...fixture,...outcome,cap,owned_stage_removed:removed};
    await fs.copyFile(assetPath,path.join(evidence,`${label}.zip`));await fs.writeFile(path.join(evidence,`${label}.json`),JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify(receipt));
    assert.ok(fixture.compressed_bytes<fixture.actual_bytes/100,'fixture must exercise compressed expansion');
    assert.equal(removed,true);assert.deepEqual(await fs.readFile(f.destPath),original,'cleanup preserves the caller-owned archive');
    assert.equal(outcome.json_read_bytes,0,'oversized material must never reach a whole JSON read');
    if(mode==='forged'){
      assert.ok(['quota_exceeded','invalid_bundle'].includes(outcome.code),JSON.stringify(outcome));
      assert.equal(outcome.stream_opened,true);assert.ok(outcome.stream_bytes>0,'retain the real bytes consumed before a forged-size guard fires');
      assert.ok(outcome.stream_bytes<=cap,'the ZIP size guard must stop before yielding bytes past the declared cap');
    }else{
      assert.equal(outcome.code,'quota_exceeded',JSON.stringify(outcome));
      assert.equal(outcome.stream_opened,false,'honest oversized declaration must fail before inflation');
      assert.equal(outcome.stream_bytes,0);
    }
  });
});

test('v2_material_profile_and_adapter_exact_1MiB_archive_boundary_remains_allowed',async t=>{
  const f=await writeV2(t,['xlsx','xlsx']);await fs.mkdir(MATERIAL_EVIDENCE,{recursive:true});
  for(const target of MATERIAL_JSON.slice(1))await t.test(target,async()=>{
    const assetPath=path.join(f.root,`${path.basename(target)}.zip`),stagingPath=path.join(f.root,`boundary-${path.basename(target)}`);
    materialMutation(f.destPath,assetPath,target,{size:1048576});
    const restored=await readRunBundle({assetPath,stagingPath});
    assert.equal(restored.sidecar.schema_version,2);assert.equal((await fs.stat(path.join(stagingPath,target))).size,1048576);
    await fs.copyFile(assetPath,path.join(MATERIAL_EVIDENCE,`${path.basename(target)}-exact-boundary.zip`));
  });
});

test('v2_malformed_material_manifest_schema_is_invalid_bundle_with_owned_cleanup',async t=>{
  const f=await writeV2(t,['xlsx','xlsx']);await fs.mkdir(MATERIAL_EVIDENCE,{recursive:true});
  for(const malformed of ['extra-root','missing-root','extra-side','extra-file'])await t.test(malformed,async()=>{
    const assetPath=path.join(f.root,`${malformed}.zip`),stagingPath=path.join(f.root,`restore-${malformed}`);
    materialMutation(f.destPath,assetPath,'import/manifest.json',{malformed});
    await assert.rejects(readRunBundle({assetPath,stagingPath}),error=>error.code==='invalid_bundle'&&error.error.phase==='restoring');
    await assert.rejects(fs.access(stagingPath),{code:'ENOENT'});
    await fs.copyFile(assetPath,path.join(MATERIAL_EVIDENCE,`malformed-${malformed}.zip`));
  });
});
