import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import crc32 from 'buffer-crc32';
import { APP_VERSION, failure, exact } from './contracts.mjs';
import {canonicalJsonStringify} from '../cli/io.mjs';
import {buildImportBundle,validateImportBundleManifest} from './xlsx-bundle.mjs';

const RUN_FILES = Object.freeze([
  'manifest.json','input/left.csv','input/right.csv','config.json','report.json',
  'pairs.csv','fields.csv','candidates.csv','decisions.csv','unresolved.csv','summary.md',
]);
const MATERIAL_JSON_FILES = new Set(['import/manifest.json',...['left','right'].flatMap(side=>[`import/${side}.profile.json`,`import/${side}.adapter.json`])]);
const ZIP_FILES = new Set(['workbench.json', ...RUN_FILES.map(name => `run/${name}`),'import/manifest.json',...['left','right'].flatMap(side=>[`import/${side}.xlsx`,`import/${side}.profile.json`,`import/${side}.adapter.json`])]);
const DEFAULT_LIMITS = Object.freeze({zip_bytes:268435456,unzip_bytes:1073741824,zip_entries:32,sidecar_bytes:1048576,entry_bytes:134217728});
const hashBytes = value => createHash('sha256').update(value).digest('hex');
const hashFile = async file => {const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};

function normalizeLimits(overrides={}) {
  const limits={...DEFAULT_LIMITS};
  for(const [key,value] of Object.entries(overrides)) {
    if(!Object.hasOwn(limits,key)||!Number.isSafeInteger(value)||value<1||value>limits[key])throw failure('invalid_limits','Only lower ZIP limits may be injected');
    limits[key]=value;
  }
  return limits;
}
function validSha(value){return typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);}
function entryLimit(name,limits) {
  const role=name==='workbench.json'?limits.sidecar_bytes:MATERIAL_JSON_FILES.has(name)?1048576:name==='run/decisions.csv'?134217728:name==='run/input/left.csv'||name==='run/input/right.csv'?67108864:67108864;
  return Math.min(limits.entry_bytes,role);
}
function validateSidecar(value) {
  exact(value,['schema_version','app_version','engine_version','revision','files']);
  if(![1,2].includes(value.schema_version)||value.app_version!==APP_VERSION||value.engine_version!=='0.1.0')throw failure('invalid_bundle','Unsupported workbench bundle version');
  exact(value.revision,['revision_id','parent_revision_id','baseline_revision_id','run_id','report_sha256','decisions_sha256']);
  const isId=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
  if(!isId(value.revision.revision_id)||(value.revision.parent_revision_id!==null&&!isId(value.revision.parent_revision_id))||!isId(value.revision.baseline_revision_id)||!validSha(value.revision.run_id)||!validSha(value.revision.report_sha256)||!validSha(value.revision.decisions_sha256))throw failure('invalid_bundle','Invalid historical revision metadata');
  if(!Array.isArray(value.files)||value.files.length<RUN_FILES.length||value.files.length>(value.schema_version===1?RUN_FILES.length:20))throw failure('invalid_bundle','Bundle file metadata has an invalid count');
  const seen=new Set();
  for(const file of value.files) {
    exact(file,['path','bytes','sha256']);
    const runPath=RUN_FILES.some(name=>file.path===`run/${name}`);
    const materialPath=value.schema_version===2&&['import/manifest.json','import/left.xlsx','import/right.xlsx','import/left.profile.json','import/right.profile.json','import/left.adapter.json','import/right.adapter.json'].includes(file.path);
    if((!runPath&&!materialPath)||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!validSha(file.sha256))throw failure('invalid_bundle','Invalid or duplicate run file metadata');
    seen.add(file.path);
  }
  if(RUN_FILES.some(name=>!seen.has(`run/${name}`)))throw failure('invalid_bundle','Bundle is missing run file metadata');
  if(value.schema_version===1&&seen.size!==RUN_FILES.length)throw failure('invalid_bundle','Unexpected schema-v1 files');
  return value;
}
function archiveError(message='Invalid or damaged ZIP bundle') {return failure('invalid_bundle',message,422,'restoring');}
function entryType(entry) {
  const creator=(entry.versionMadeBy>>>8)&0xff, mode=(entry.externalFileAttributes>>>16)&0xffff;
  if(entry.fileName.endsWith('/')||(entry.externalFileAttributes&0x10)!==0)throw archiveError('Directory entries are not allowed');
  if(creator===3||creator===19) {
    const type=mode&0o170000;
    if(type!==0&&type!==0o100000)throw archiveError('Non-regular files are not allowed');
  }
}
function validateEntryName(name) {
  if(typeof name!=='string'||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(part=>part===''||part==='.'||part==='..'))throw archiveError('Unsafe ZIP entry path');
  const canonical=name.normalize('NFC').toLocaleLowerCase('en-US');
  if(!ZIP_FILES.has(name))throw archiveError('Unexpected ZIP entry');
  return canonical;
}
function nextEntry(zip) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{zip.removeListener('entry',onEntry);zip.removeListener('end',onEnd);zip.removeListener('error',onError);};
    const onEntry=entry=>{cleanup();resolve(entry);};
    const onEnd=()=>{cleanup();resolve(null);};
    const onError=error=>{cleanup();reject(error);};
    zip.once('entry',onEntry);zip.once('end',onEnd);zip.once('error',onError);
    try{zip.readEntry();}catch(error){cleanup();reject(error);}
  });
}
async function openZip(file) {
  try{return await yauzl.openPromise(file,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true});}
  catch(error){throw archiveError(error.message);}
}
async function streamEntry(zip,entry,dest,limits,totals,expectedCrc) {
  if(entry.generalPurposeBitFlag&0x1)throw archiveError('Encrypted ZIP entries are not supported');
  const cap=entryLimit(entry.fileName,limits);
  if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>cap)throw failure('quota_exceeded','ZIP entry uncompressed byte limit exceeded',413,'restoring');
  let input;
  try {
    // openReadStream only reads a minimal local header. Check its full metadata
    // before trusting the central directory to choose names and decode bytes.
    const local=await zip.readLocalFileHeaderPromise(entry);
    if(local.generalPurposeBitFlag&0x41)throw archiveError('Encrypted ZIP entries are not supported');
    if(!local.fileName.equals(entry.fileNameRaw)||local.generalPurposeBitFlag!==entry.generalPurposeBitFlag||local.compressionMethod!==entry.compressionMethod)throw archiveError('ZIP local and central metadata disagree');
    // Bit 3 permits local CRC/size placeholders; streamed bytes and CRC below
    // still verify the authoritative central values for descriptor entries.
    if(!(local.generalPurposeBitFlag&0x8)&&(local.crc32!==entry.crc32||local.compressedSize!==entry.compressedSize||local.uncompressedSize!==entry.uncompressedSize))throw archiveError('ZIP local and central sizes or CRC disagree');
    input=await zip.openReadStreamPromise(entry);
  } catch(error){throw archiveError(error.message);}
  const file=await fs.open(dest,'wx',0o600);
  const hash=createHash('sha256');let actual=0,crc=0;
  try {
    for await(const chunk of input) {
      actual+=chunk.length;totals.actual+=chunk.length;
      if(actual>cap||totals.actual>limits.unzip_bytes)throw failure('quota_exceeded','ZIP actual decompressed byte limit exceeded',413,'restoring');
      hash.update(chunk);crc=crc32.unsigned(chunk,crc);await file.writeFile(chunk);
    }
    if(actual!==entry.uncompressedSize)throw archiveError('ZIP entry size does not match its data');
    if(crc!==(expectedCrc>>>0))throw archiveError('ZIP entry CRC does not match its data');
    return {bytes:actual,sha256:hash.digest('hex')};
  } catch(error) {input.destroy();throw error;}
  finally {await file.close();}
}

export async function writeRunBundle({runPath,sidecar,destPath,limits:overrides={},importMaterials}={}) {
  const limits=normalizeLimits(overrides);let bundleSidecar=sidecar,materialRecords=[];
  validateSidecar(sidecar);
  if(importMaterials){
    const built=await buildImportBundle({runPath,materials:importMaterials.sides,manifestPath:importMaterials.manifestPath});
    materialRecords=[...built.records,built.manifestRecord];
    const files=[...sidecar.files,...materialRecords.map(({path,bytes,sha256})=>({path,bytes,sha256}))];
    bundleSidecar={...sidecar,schema_version:2,files};validateSidecar(bundleSidecar);
  }
  const sidecarBytes=Buffer.from(`${JSON.stringify(bundleSidecar)}\n`);
  if(sidecarBytes.length>limits.sidecar_bytes)throw failure('quota_exceeded','Bundle sidecar byte limit exceeded',413,'packing');
  if(RUN_FILES.length+1+materialRecords.length>limits.zip_entries)throw failure('quota_exceeded','ZIP entry count limit exceeded',413,'packing');
  const files=[];let uncompressed=sidecarBytes.length;
  for(const name of RUN_FILES) {
    const file=path.join(runPath,name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw failure('invalid_bundle','Run bundles can contain regular files only',422,'packing');
    const metadata=sidecar.files.find(item=>item.path===`run/${name}`);
    if(stat.size!==metadata.bytes||await hashFile(file)!==metadata.sha256)throw failure('invalid_bundle','Run file does not match bundle metadata',422,'packing');
    if(stat.size>entryLimit(`run/${name}`,limits))throw failure('quota_exceeded','Run file exceeds ZIP entry limit',413,'packing');
    uncompressed+=stat.size;if(uncompressed>limits.unzip_bytes)throw failure('quota_exceeded','Run bundle uncompressed byte limit exceeded',413,'packing');
    files.push([file,`run/${name}`]);
  }
  for(const item of materialRecords){
    if(item.bytes>entryLimit(item.path,limits))throw failure('quota_exceeded','Bundle material exceeds ZIP entry limit',413,'packing');
    uncompressed+=item.bytes;if(uncompressed>limits.unzip_bytes)throw failure('quota_exceeded','Run bundle uncompressed byte limit exceeded',413,'packing');
  }
  const zip=new yazl.ZipFile();
  zip.addBuffer(sidecarBytes,'workbench.json',{compress:true});
  for(const [file,name] of files)zip.addFile(file,name,{compress:true});
  for(const item of materialRecords)zip.addBuffer(item.data,item.path,{compress:true});
  const output=zip.outputStream,destination=createWriteStream(destPath,{flags:'wx',mode:0o600});let compressed=0;
  const counter=new Transform({transform(chunk,encoding,callback){compressed+=chunk.length;if(compressed>limits.zip_bytes)callback(failure('quota_exceeded','ZIP archive byte limit exceeded',413,'packing'));else callback(null,chunk);}});
  const done=pipeline(output,counter,destination);
  zip.end();
  try{await done;}catch(error){await fs.rm(destPath,{force:true});if(error.code==='quota_exceeded')throw error;throw failure('bundle_write_failed','Could not write ZIP bundle',500,'packing');}
  const stat=await fs.stat(destPath);
  if(stat.size>limits.zip_bytes){await fs.rm(destPath,{force:true});throw failure('quota_exceeded','ZIP archive byte limit exceeded',413,'packing');}
  return {bytes:stat.size,sha256:await hashFile(destPath)};
}

export async function readRunBundle({assetPath,stagingPath,limits:overrides={}}={}) {
  const limits=normalizeLimits(overrides);let zip,stageMade=false;
  try {
    const archiveStat=await fs.stat(assetPath);
    if(!archiveStat.isFile()||archiveStat.size>limits.zip_bytes)throw failure('quota_exceeded','ZIP archive byte limit exceeded',413,'restoring');
    await fs.mkdir(stagingPath,{mode:0o700});stageMade=true;
    const runPath=path.join(stagingPath,'run');await fs.mkdir(path.join(runPath,'input'),{mode:0o700,recursive:true});
    zip=await openZip(assetPath);
    const seen=new Set(),aliases=new Set(),actuals=new Map(),totals={actual:0};let sidecar=null,count=0,importManifest=null;
    for(let entry=await nextEntry(zip);entry;entry=await nextEntry(zip)) {
      count++;if(count>limits.zip_entries)throw failure('quota_exceeded','ZIP entry count limit exceeded',413,'restoring');
      entryType(entry);const alias=validateEntryName(entry.fileName);
      if(!Buffer.from(entry.fileName,'utf8').equals(entry.fileNameRaw)||entry.extraFields.some(field=>field.id===0x7075))throw archiveError('ZIP entry name encoding or Unicode alias is not allowed');
      if(seen.has(entry.fileName)||aliases.has(alias))throw archiveError('Duplicate or aliased ZIP entry');
      seen.add(entry.fileName);aliases.add(alias);
      if(entry.generalPurposeBitFlag&0x1)throw archiveError('Encrypted ZIP entries are not supported');
      if(entry.fileName==='workbench.json') {
        if(entry.uncompressedSize>limits.sidecar_bytes)throw failure('quota_exceeded','Bundle sidecar byte limit exceeded',413,'restoring');
        const sidecarPath=path.join(stagingPath,'workbench.json');
        const out=await streamEntry(zip,entry,sidecarPath,limits,totals,entry.crc32);
        try{sidecar=JSON.parse(await fs.readFile(sidecarPath,'utf8'));validateSidecar(sidecar);}catch(error){if(error.code==='quota_exceeded')throw error;throw archiveError('Invalid workbench.json schema');}
        actuals.set(entry.fileName,out);
      } else {
        const dest=path.join(stagingPath,entry.fileName);
        await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});
        const out=await streamEntry(zip,entry,dest,limits,totals,entry.crc32);actuals.set(entry.fileName,out);
      }
    }
    if(!sidecar)throw archiveError('Missing workbench.json');
    const allowedNames=sidecar.schema_version===1?new Set(['workbench.json',...RUN_FILES.map(name=>`run/${name}`)]):new Set([...sidecar.files.map(f=>f.path),'workbench.json']);
    if(count!==allowedNames.size||seen.size!==allowedNames.size||[...allowedNames].some(name=>!seen.has(name)))throw archiveError(sidecar.schema_version===1?'ZIP must contain exactly the twelve allowed files':'ZIP entries do not match the v2 manifest');
    if(sidecar.schema_version===2){
      try{const manifestBytes=await fs.readFile(path.join(stagingPath,'import/manifest.json'));importManifest=JSON.parse(manifestBytes.toString('utf8'));if(canonicalJsonStringify(importManifest)!==manifestBytes.toString('utf8'))throw archiveError('Import manifest is not canonical JSON');validateImportBundleManifest(importManifest,sidecar);}
      catch(error){if(error.code&&error.code!=='invalid_request')throw error;throw archiveError('Invalid import manifest');}
    }
    for(const item of sidecar.files) {
      const actual=actuals.get(item.path);
      if(!actual||actual.bytes!==item.bytes||actual.sha256!==item.sha256)throw archiveError('Run bytes do not match workbench.json');
    }
    const report=actuals.get('run/report.json'),decisions=actuals.get('run/decisions.csv');
    if(report.sha256!==sidecar.revision.report_sha256||decisions.sha256!==sidecar.revision.decisions_sha256)throw archiveError('Revision digest metadata does not match run files');
    if(sidecar.schema_version===1)return {runPath,sidecar};
    const materials={manifestPath:path.join(stagingPath,'import/manifest.json'),sides:importManifest.sides.map(item=>item.format==='csv'?{side:item.side,format:'csv',sourcePath:path.join(stagingPath,item.source.path),source:item.source}:{side:item.side,format:'xlsx',sourcePath:path.join(stagingPath,item.source.path),profilePath:path.join(stagingPath,item.profile.path),adapterManifestPath:path.join(stagingPath,item.adapter_manifest.path),source:item.source,canonical_csv:item.canonical_csv,profile:item.profile,adapter_manifest:item.adapter_manifest})};
    return {runPath,sidecar,importMaterials:materials};
  } catch(error) {
    if(stageMade)await fs.rm(stagingPath,{recursive:true,force:true}).catch(()=>{});
    if(error.code)throw error;
    throw archiveError(error.message);
  } finally {zip?.close();}
}

export { RUN_FILES as RUN_BUNDLE_FILES };
