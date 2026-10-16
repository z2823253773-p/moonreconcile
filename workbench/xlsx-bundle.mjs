import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJsonStringify} from '../cli/io.mjs';
import {failure,exact} from './contracts.mjs';
import {convertXlsx} from './xlsx/adapter.mjs';
import {XLSX_LIMITS} from './xlsx/contracts.mjs';

const sides=['left','right'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const validHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const materialName=(side,kind)=>kind==='source'?`import/${side}.xlsx`:kind==='profile'?`import/${side}.profile.json`:`import/${side}.adapter.json`;
const runCsv=side=>`run/input/${side}.csv`;
const fail=(code='invalid_bundle',message='Invalid XLSX bundle materials')=>failure(code,message,422,'restoring');
function exactSide(value,format){
  exact(value,format==='csv'?['side','format','source']:['side','format','source','canonical_csv','profile','adapter_manifest']);
  if(!sides.includes(value.side)||value.format!==format)throw fail();
}
function checkFile(value,expectedPath){
  exact(value,['path','bytes','sha256']);
  if(value.path!==expectedPath||!Number.isSafeInteger(value.bytes)||value.bytes<0||!validHash(value.sha256))throw fail();
}
export function validateImportBundleManifest(value,sidecar){
  exact(value,['schema_version','adapter_manifest_schema_version','sides']);
  if(value.schema_version!==1||value.adapter_manifest_schema_version!==1||!Array.isArray(value.sides)||value.sides.length!==2)throw fail();
  let xlsxCount=0;
  for(let i=0;i<2;i++){
    const item=value.sides[i],side=sides[i];
    if(item?.side!==side||!['csv','xlsx'].includes(item.format))throw fail();
    exactSide(item,item.format);
    if(item.format==='csv')checkFile(item.source,runCsv(side));
    else {
      xlsxCount++;
      checkFile(item.source,materialName(side,'source'));checkFile(item.canonical_csv,runCsv(side));
      checkFile(item.profile,materialName(side,'profile'));checkFile(item.adapter_manifest,materialName(side,'manifest'));
      if(item.source.bytes>XLSX_LIMITS.compressed_bytes||item.profile.bytes>1048576||item.adapter_manifest.bytes>1048576||item.canonical_csv.bytes>XLSX_LIMITS.csv_bytes)throw fail();
    }
  }
  if(xlsxCount<1)throw fail();
  const expected=new Set(sidecar.files.map(f=>f.path));
  const required=new Set(['import/manifest.json',...sidecar.files.filter(f=>f.path.startsWith('run/')).map(f=>f.path)]);
  for(const item of value.sides){
    if(item.format==='csv'){
      const run=sidecar.files.find(f=>f.path===item.source.path);if(!run||run.bytes!==item.source.bytes||run.sha256!==item.source.sha256)throw fail();
    }else for(const file of [item.source,item.canonical_csv,item.profile,item.adapter_manifest]){
      const archived=sidecar.files.find(f=>f.path===file.path);if(!archived||archived.bytes!==file.bytes||archived.sha256!==file.sha256)throw fail();
    }
    if(item.format==='xlsx')for(const file of [item.source,item.profile,item.adapter_manifest])required.add(file.path);
  }
  if(expected.size!==required.size||[...expected].some(name=>!required.has(name))||sidecar.files.filter(f=>f.path.startsWith('run/')).length!==11||sidecar.files.length!==12+3*xlsxCount)throw fail();
  return value;
}

async function fileRecord(file,relative){
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail('ownership_failed','Bundle material must be an owned regular file');
  if(stat.size>1048576&&relative.endsWith('.json'))throw fail();
  const data=await fs.readFile(file);return{path:relative,bytes:data.length,sha256:sha(data),data};
}
export async function buildImportBundle({runPath,materials,manifestPath}={}){
  if(!Array.isArray(materials)||materials.length!==2||!manifestPath)throw fail('invalid_worker_output','Import materials are incomplete');
  const ordered=[...materials].sort((a,b)=>sides.indexOf(a.side)-sides.indexOf(b.side));
  const records=[],manifestSides=[];
  for(let i=0;i<2;i++){
    const item=ordered[i],side=sides[i];if(item?.side!==side||!['csv','xlsx'].includes(item.format))throw fail('invalid_worker_output','Import side metadata is invalid');
    if(item.format==='csv'){
      const expected=path.resolve(runPath,'input',`${side}.csv`);if(path.resolve(item.sourcePath)!==expected)throw fail('invalid_worker_output','CSV material must be the archived run input');
      const source=await fileRecord(item.sourcePath,runCsv(side));manifestSides.push({side,format:'csv',source:{path:source.path,bytes:source.bytes,sha256:source.sha256}});
    }else{
      for(const [key,label] of [['sourcePath','source'],['profilePath','profile'],['adapterManifestPath','manifest']])if(typeof item[key]!=='string'||!path.isAbsolute(item[key]))throw fail('invalid_worker_output',`Missing owned XLSX ${label}`);
      const source=await fileRecord(item.sourcePath,materialName(side,'source'));
      const profile=await fileRecord(item.profilePath,materialName(side,'profile'));
      const adapter=await fileRecord(item.adapterManifestPath,materialName(side,'manifest'));
      const canonical=await fileRecord(path.resolve(runPath,'input',`${side}.csv`),runCsv(side));
      if(source.bytes>XLSX_LIMITS.compressed_bytes||profile.bytes>1048576||adapter.bytes>1048576||canonical.bytes>XLSX_LIMITS.csv_bytes)throw fail();
      records.push(source,profile,adapter);manifestSides.push({side,format:'xlsx',source:{path:source.path,bytes:source.bytes,sha256:source.sha256},canonical_csv:{path:canonical.path,bytes:canonical.bytes,sha256:canonical.sha256},profile:{path:profile.path,bytes:profile.bytes,sha256:profile.sha256},adapter_manifest:{path:adapter.path,bytes:adapter.bytes,sha256:adapter.sha256}});
    }
  }
  if(manifestSides.filter(item=>item.format==='xlsx').length===0)throw fail('invalid_worker_output','Version 2 bundles must contain at least one XLSX import');
  const value={schema_version:1,adapter_manifest_schema_version:1,sides:manifestSides};
  const bytes=Buffer.from(canonicalJsonStringify(value),'utf8');if(bytes.length>1048576)throw fail();
  await fs.writeFile(manifestPath,bytes,{flag:'wx',mode:0o600});
  return{manifestPath,manifest:value,manifestRecord:{path:'import/manifest.json',bytes:bytes.length,sha256:sha(bytes),data:bytes},records};
}

export async function verifyAndRegenerateImports({runPath,materials,stagingPath,invoke,limits=XLSX_LIMITS,signal}={}){
  if(!materials?.manifestPath||!Array.isArray(materials.sides)||materials.sides.length!==2)throw fail();
  const result={};
  for(const item of materials.sides){
    if(signal?.aborted)throw failure('cancelled','Task cancelled',409,'restoring');
    if(item.format==='csv'){
      const csvPath=path.join(runPath,'input',`${item.side}.csv`),csv=await fs.readFile(csvPath);
      if(csv.length!==item.source.bytes||sha(csv)!==item.source.sha256)throw fail('invalid_bundle','Archived CSV source hash mismatch');
      result[item.side]={format:'csv',source_path:csvPath,csv_path:csvPath,profile_path:null,adapter_manifest_path:null,preview:null};continue;
    }
    if(item.format!=='xlsx')throw fail();
    const sourcePath=path.join(stagingPath,item.source.path),profilePath=path.join(stagingPath,item.profile.path),adapterPath=path.join(stagingPath,item.adapter_manifest.path);
    const [source,profileBytes,adapterBytes]=await Promise.all([fs.readFile(sourcePath),fs.readFile(profilePath),fs.readFile(adapterPath)]);
    if(source.length!==item.source.bytes||sha(source)!==item.source.sha256||profileBytes.length!==item.profile.bytes||sha(profileBytes)!==item.profile.sha256||adapterBytes.length!==item.adapter_manifest.bytes||sha(adapterBytes)!==item.adapter_manifest.sha256)throw fail('invalid_bundle','Archived XLSX material hash mismatch');
    if(signal?.aborted)throw failure('cancelled','Task cancelled',409,'restoring');
    let profile,archivedAdapter;
    try{profile=JSON.parse(profileBytes.toString('utf8'));archivedAdapter=JSON.parse(adapterBytes.toString('utf8'));}catch{throw fail();}
    if(!profile||Object.keys(profile).sort().join(',')!=='adapter_id,adapter_version,import_spec,schema_version'||profile.schema_version!==1||profile.adapter_id!=='restricted-ooxml'||profile.adapter_version!=='1.0.0'||canonicalJsonStringify(profile)!==profileBytes.toString('utf8'))throw fail();
    const converted=await convertXlsx({assetPath:sourcePath,importSpec:profile.import_spec,side:item.side,stagingPath:path.join(stagingPath,`regenerated-${item.side}`),invoke,limits,signal});
    const csvPath=path.join(runPath,'input',`${item.side}.csv`),canonical=await fs.readFile(csvPath),generated=await fs.readFile(converted.csv_path),generatedAdapter=await fs.readFile(converted.adapter_manifest_path);
    if(signal?.aborted)throw failure('cancelled','Task cancelled',409,'restoring');
    if(canonical.length!==item.canonical_csv.bytes||sha(canonical)!==item.canonical_csv.sha256||!canonical.equals(generated))throw fail('xlsx_conversion_mismatch','Regenerated CSV does not match archived canonical CSV');
    if(!generatedAdapter.equals(adapterBytes)||canonicalJsonStringify(archivedAdapter)!==generatedAdapter.toString('utf8'))throw fail('xlsx_conversion_mismatch','Regenerated adapter metadata does not match archived metadata');
    result[item.side]={format:'xlsx',source_path:sourcePath,csv_path:converted.csv_path,profile_path:profilePath,adapter_manifest_path:adapterPath,preview:converted.preview};
  }
  return{left:result.left,right:result.right};
}
