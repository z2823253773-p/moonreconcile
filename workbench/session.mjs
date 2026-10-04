import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { sha256Hex } from '../cli/io.mjs';
import { normalizeLimits, failure, isId, project } from './contracts.mjs';

export async function createSession({rootParent,limits:overrides={}}={}) {
  const limits=normalizeLimits(overrides),parent=await fs.realpath(rootParent??os.tmpdir());
  const owner=randomBytes(32).toString('hex');let root,closed=false,resetting=false,generation=0;
  const assets=new Map(),imports=new Map(),revisions=new Map(),heads=new Map(),reservations=new Map(),bindings=new Map();
  async function newRoot() {
    root=await fs.mkdtemp(path.join(parent,'moonreconcile-'));root=await fs.realpath(root);
    await fs.chmod(root,0o700);await fs.writeFile(path.join(root,'.owner'),owner,{mode:0o600,flag:'wx'});
  }
  await newRoot();
  async function owned(target=root) {
    const stat=await fs.lstat(root),marker=await fs.lstat(path.join(root,'.owner'));
    if(marker.isSymbolicLink()||!marker.isFile())throw failure('ownership_failed','Workspace ownership marker changed');
    if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(root)!==root||path.dirname(root)!==parent||await fs.readFile(path.join(root,'.owner'),'utf8')!==owner)throw failure('ownership_failed','Workspace ownership check failed');
    const relative=path.relative(root,path.resolve(target));
    if(relative.startsWith('..')||path.isAbsolute(relative))throw failure('ownership_failed','Unregistered workspace path');
    let part=root;
    for(const component of relative.split(path.sep).filter(Boolean)) {part=path.join(part,component);const s=await fs.lstat(part);if(s.isSymbolicLink())throw failure('ownership_failed','Workspace symlink rejected');}
    if(await fs.realpath(target)!==path.resolve(target))throw failure('ownership_failed','Workspace realpath changed');
    return target;
  }
  async function bytes(target=root) {
    const s=await fs.lstat(target);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw failure('ownership_failed','Workspace symlink or special file rejected');
    if(s.isFile())return s.size;
    let total=0;for(const name of await fs.readdir(target))total+=await bytes(path.join(target,name));return total;
  }
  async function checkQuota() {
    await owned();let total=await bytes(),pending=0;
    for(const r of reservations.values()) {const written=r.dir?await bytes(r.dir).catch(e=>{if(e.code==='ENOENT')return 0;throw e;}):0;const extra=Math.max(0,r.bytes-written);pending+=extra;total+=extra;}
    const disk=await fs.statfs(root);
    if(total>limits.session_bytes||pending>disk.bsize*disk.bavail)throw failure('quota_exceeded','Session disk quota exceeded',413);
    return total;
  }
  async function reserve(key,amount=0,dir=null) {
    if(closed||resetting)throw failure('session_closed','Session is closing',409);
    const previous=reservations.get(key);reservations.set(key,{bytes:amount,dir});
    try{await checkQuota();}catch(e){if(previous)reservations.set(key,previous);else reservations.delete(key);throw e;}
  }
  const release=key=>reservations.delete(key);
  async function staging(prefix='job') {await owned();const dir=path.join(root,`${prefix}-${randomUUID()}`);await fs.mkdir(dir,{mode:0o700});return dir;}
  async function remove(target) {await owned(target);if(target===root)throw failure('ownership_failed','Cannot remove workspace as staging');await fs.rm(target,{recursive:true,force:false});}
  async function hashFile(file) {await owned(file);const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
  function get(map,id) {if(!isId(id))throw failure('invalid_request','Invalid identifier');const e=map.get(id);if(!e)throw failure('not_found','Identifier not found',404);return e;}
  async function prepareAsset(kind,name,file) {
    if(assets.size>=limits.assets)throw failure('quota_exceeded','Asset count quota exceeded',413);
    await owned(file);const s=await fs.stat(file);if(!s.isFile())throw failure('invalid_asset','Asset must be a regular file');
    const cap=kind==='decisions'?134217728:kind==='run'?limits.zip_bytes:67108864;
    if(s.size>Math.min(cap,limits.asset_bytes??cap))throw failure('quota_exceeded','Asset byte limit exceeded',413);
    await fs.chmod(file,0o600);const asset={asset_id:randomUUID(),kind,name,bytes:s.size,sha256:await hashFile(file),path:file};project('asset',asset);return asset;
  }
  function commitAsset(asset) {if(assets.size>=limits.assets)throw failure('quota_exceeded','Asset count quota exceeded',413);assets.set(asset.asset_id,asset);}
  function commitImport(entry) {if(imports.size>=limits.imports)throw failure('quota_exceeded','Import count quota exceeded',413);project('import',entry);imports.set(entry.import_id,entry);}
  async function saveAsset(kind,name,data) {
    const key=randomUUID(),dir=await staging('asset');
    try{await reserve(key,Buffer.byteLength(data),dir);const file=path.join(dir,'data');await fs.writeFile(file,data,{mode:0o600,flag:'wx'});const entry=await prepareAsset(kind,name,file);await checkQuota();commitAsset(entry);return entry;}
    catch(e){await remove(dir);throw e;}finally{release(key);}
  }
  async function prepareRevision({runPath,left_import_id,right_import_id,config_asset_id,parent_revision_id=null,baseline_revision_id=null}) {
    if(revisions.size>=limits.revisions)throw failure('quota_exceeded','Revision count quota exceeded',413);
    await owned(runPath);get(imports,left_import_id);get(imports,right_import_id);get(assets,config_asset_id);
    const files=['manifest.json','report.json','input/left.csv','input/right.csv','config.json','pairs.csv','fields.csv','candidates.csv','decisions.csv','unresolved.csv','summary.md'];
    for(const f of files)await owned(path.join(runPath,f));
    const report=await fs.readFile(path.join(runPath,'report.json')),manifest=JSON.parse(await fs.readFile(path.join(runPath,'manifest.json'),'utf8')),result=JSON.parse(report);
    if(manifest.schema_version!==1||manifest.engine_version!=='0.1.0'||result.schema_version!==1||result.engine_version!=='0.1.0'||![0,1,3].includes(result.exit_code))throw failure('invalid_result','No valid Result to publish');
    const id=randomUUID(),revision={revision_id:id,parent_revision_id,baseline_revision_id:baseline_revision_id??id,run_id:manifest.run_id,report_sha256:sha256Hex(report),decisions_sha256:await hashFile(path.join(runPath,'decisions.csv')),left_import_id,right_import_id,config_asset_id,exit_code:result.exit_code,path:runPath};project('revision',revision);
    await checkQuota();return revision;
  }
  function checkRevision(revision) {
    if(revisions.size>=limits.revisions)throw failure('quota_exceeded','Revision count quota exceeded',413);
    if(revision.parent_revision_id&&heads.get(revision.baseline_revision_id)!==revision.parent_revision_id)throw failure('stale_revision','Branch head changed',409);
  }
  function commitRevision(revision) {checkRevision(revision);revisions.set(revision.revision_id,revision);heads.set(revision.baseline_revision_id,revision.revision_id);}
  async function publishRevision(args) {const g=generation;const revision=await prepareRevision(args);if(closed||resetting||g!==generation)throw failure('session_closed','Session changed',409);commitRevision(revision);return project('revision',revision);}
  async function reset() {
    if(closed||resetting||reservations.size)throw failure('session_busy','Active uploads or tasks prevent reset',409);
    resetting=true;try{await owned();await fs.rm(root,{recursive:true});await newRoot();generation++;for(const m of [assets,imports,revisions,heads,bindings])m.clear();}finally{resetting=false;}
  }
  async function close() {if(closed)return;if(reservations.size)throw failure('session_busy','Active writes prevent cleanup',409);await owned();await fs.rm(root,{recursive:true});closed=true;generation++;}
  return {get root(){return root;},get generation(){return generation;},get closed(){return closed;},limits,assets,imports,revisions,heads,bindings,reservations,owned,bytes,checkQuota,reserve,release,staging,remove,hashFile,prepareAsset,commitAsset,commitImport,registerImport:commitImport,prepareRevision,checkRevision,commitRevision,publishRevision,saveAsset,getAsset:id=>get(assets,id),getImport:id=>get(imports,id),getRevision:id=>get(revisions,id),reset,close};
}
