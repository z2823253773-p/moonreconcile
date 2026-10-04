import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { sha256Hex } from '../cli/io.mjs';

export async function createSession({rootParent,limits={}}={}) {
  let root=await fs.mkdtemp(path.join(rootParent??os.tmpdir(),'moonreconcile-'));
  root=await fs.realpath(root);
  await fs.chmod(root,0o700);
  const owner_id=randomBytes(16).toString('hex');
  await fs.writeFile(path.join(root,'.owner'),owner_id,{mode:0o600});
  const assets=new Map(), imports=new Map(), revisions=new Map(), heads=new Map();
  let closing=false;
  const saveAsset=async(kind,name,data)=>{const bytes=Buffer.from(data);if(assets.size>=(limits.assets??64))throw Object.assign(new Error('asset quota exceeded'),{code:'quota_exceeded'});const disk=(await fs.statfs(root)).bsize*(await fs.statfs(root)).bavail;if(bytes.length>Math.min(limits.session_bytes??1073741824,disk))throw Object.assign(new Error('session disk quota exceeded'),{code:'quota_exceeded'});const id=randomUUID();const file=path.join(root,`${id}.asset`);await fs.writeFile(file,bytes,{mode:0o600,flag:'wx'});const entry={asset_id:id,kind,name,bytes:bytes.length,sha256:sha256Hex(bytes),path:file};assets.set(id,entry);return entry;};
  const entry=(map,id)=>{const e=map.get(id);if(!e)throw Object.assign(new Error('not found'),{status:404,code:'not_found'});return e;};
  const cleanup=async()=>{if(closing)return;closing=true;const real=await fs.realpath(root);if(real!==root||await fs.readFile(path.join(root,'.owner'),'utf8')!==owner_id)throw new Error('workspace ownership check failed');await fs.rm(root,{recursive:true,force:false});};
  return {root,limits,assets,imports,revisions,heads,saveAsset,getAsset:id=>entry(assets,id),getImport:id=>entry(imports,id),getRevision:id=>entry(revisions,id),
    registerImport:e=>imports.set(e.import_id,e),
    publishRevision:async({runPath,left_import_id,right_import_id,config_asset_id,parent_revision_id=null,baseline_revision_id=null})=>{
      if(revisions.size>=(limits.revisions??32))throw Object.assign(new Error('revision quota exceeded'),{code:'quota_exceeded'});
      const report=await fs.readFile(path.join(runPath,'report.json'));const manifest=JSON.parse(await fs.readFile(path.join(runPath,'manifest.json'),'utf8'));const decisions=await fs.readFile(path.join(runPath,'decisions.csv'));
      const id=randomUUID();const r={revision_id:id,parent_revision_id,baseline_revision_id:baseline_revision_id??id,run_id:manifest.run_id,report_sha256:sha256Hex(report),decisions_sha256:sha256Hex(decisions),left_import_id,right_import_id,config_asset_id,exit_code:JSON.parse(report).exit_code,path:runPath};
      revisions.set(id,r);if(!parent_revision_id)heads.set(id,id);else {const base=baseline_revision_id;heads.set(base,id);}return r;
    }, reset:async()=>{if(closing)throw new Error('closed');imports.clear();assets.clear();revisions.clear();heads.clear();for(const n of await fs.readdir(root))if(n!=='.owner')await fs.rm(path.join(root,n),{recursive:true,force:true});},close:cleanup};
}
