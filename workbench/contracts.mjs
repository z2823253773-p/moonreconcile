export const APP_VERSION = '0.2.0';
export const API_VERSION = 1;
export { XLSX_LIMITS } from './xlsx/contracts.mjs';
export const HOST_LIMITS = Object.freeze({
  session_bytes: 1073741824, assets: 64, imports: 64, revisions: 32, jobs: 256,
  uploads: 1, children: 1, upload_ms: 60000, job_ms: 180000, kill_ms: 1000,
  quota_poll_ms: 250, zip_bytes: 268435456, unzip_bytes: 1073741824, zip_entries: 32,
  request_bytes: 1048576, response_bytes: 2097152,
});
export const errorDto = (code, message, phase='host', side=null, record=null, field=null) => ({code,message,phase,side,record,field});
export function failure(code,message,status=400,phase='host') {
  return Object.assign(new Error(message),{code,status,error:errorDto(code,message,phase)});
}
export function normalizeLimits(overrides={}) {
  const limits={...HOST_LIMITS};
  for(const [key,value] of Object.entries(overrides)) {
    if(key==='asset_bytes'){if(!Number.isSafeInteger(value)||value<1||value>67108864)throw failure('invalid_limits','Invalid lower asset test limit');limits[key]=value;continue;}
    if(!Object.hasOwn(limits,key)||!Number.isSafeInteger(value)||value<1||value>limits[key])throw failure('invalid_limits','Only lower test limits may be injected');
    limits[key]=value;
  }
  return limits;
}
export const isId = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const integer = (v,min=0,max=2147483647) => Number.isSafeInteger(v)&&v>=min&&v<=max;
export const object = v => v!==null&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
export function exact(value,keys) {
  if(!object(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw failure('invalid_request','Unexpected or missing property');
  return value;
}
export const JOB_KINDS=['import','preview','cell','xlsx_catalog','source_cell','draft','check','compare','example','review','branch','restore','bundle'];
export const PHASES=['reading','validating','comparing','resolving','packing','restoring','publishing'];
const shapes={
  asset:['asset_id','kind','name','bytes','sha256'],
  import:['import_id','asset_id','side','format','status','headers','row_count','column_count','sha256'],
  job:['job_id','kind','state','phase','output','error'],
  revision:['revision_id','parent_revision_id','baseline_revision_id','run_id','report_sha256','decisions_sha256','left_import_id','right_import_id','config_asset_id','exit_code'],
  error:['code','message','phase','side','record','field'],
  preview:['side','headers','row_count','column_count','offset','limit','rows','next_offset','has_more'],
  cell:['side','record','column','value','utf8_bytes','truncated'],
  source_cell:['side','record','column','sheet_name','coordinate','cell_type','stored_value','imported_value','mode','style_index','number_format'],
};
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const text=v=>typeof v==='string';
const side=v=>['left','right'].includes(v);
const strings=v=>Array.isArray(v)&&v.every(text);
export function assertDto(kind,v) {
  if(!shapes[kind])throw failure('invalid_request','Unknown DTO');
  if(kind==='import'&&object(v)&&Object.hasOwn(v,'adapter'))exact(v,[...shapes.import,'adapter']);else exact(v,shapes[kind]);let valid=false;
  if(kind==='error')valid=text(v.code)&&text(v.message)&&text(v.phase)&&[null,'left','right','decisions'].includes(v.side)&&(v.record===null||integer(v.record,1))&&(v.field===null||text(v.field));
  if(kind==='asset')valid=isId(v.asset_id)&&['csv','xlsx','config','decisions','run'].includes(v.kind)&&text(v.name)&&[...v.name].length<=255&&integer(v.bytes,0,Number.MAX_SAFE_INTEGER)&&hash(v.sha256);
  if(kind==='import') {
    const csv=Object.keys(v).length===9&&!Object.hasOwn(v,'adapter');
    const xlsx=Object.keys(v).length===10&&object(v.adapter);
    valid=isId(v.import_id)&&isId(v.asset_id)&&side(v.side)&&(['csv','xlsx'].includes(v.format))&&(v.format==='csv'?csv:xlsx)&&v.status==='ready'&&strings(v.headers)&&integer(v.row_count,0,100000)&&integer(v.column_count,1,256)&&v.column_count===v.headers.length&&hash(v.sha256);
    if(valid&&v.format==='xlsx') {
      exact(v.adapter,['adapter_id','adapter_version','profile_schema_version','profile_sha256','import_manifest_sha256','source_sha256','canonical_csv_sha256']);
      valid=v.adapter.adapter_id==='restricted-ooxml'&&v.adapter.adapter_version==='1.0.0'&&v.adapter.profile_schema_version===1&&hash(v.adapter.profile_sha256)&&hash(v.adapter.import_manifest_sha256)&&hash(v.adapter.source_sha256)&&hash(v.adapter.canonical_csv_sha256)&&v.sha256===v.adapter.canonical_csv_sha256;
    }
  }
  if(kind==='revision')valid=isId(v.revision_id)&&(v.parent_revision_id===null||isId(v.parent_revision_id))&&isId(v.baseline_revision_id)&&hash(v.run_id)&&hash(v.report_sha256)&&hash(v.decisions_sha256)&&isId(v.left_import_id)&&isId(v.right_import_id)&&isId(v.config_asset_id)&&[0,1,3].includes(v.exit_code);
  if(kind==='job')valid=isId(v.job_id)&&JOB_KINDS.includes(v.kind)&&['running','cancelling','succeeded','failed','cancelled'].includes(v.state)&&PHASES.includes(v.phase)&&(v.output===null||object(v.output))&&(v.error===null||assertDto('error',v.error))&&(v.state==='succeeded'?object(v.output)&&v.error===null:v.output===null);
  if(kind==='cell')valid=side(v.side)&&integer(v.record,1,100000)&&text(v.column)&&text(v.value)&&integer(v.utf8_bytes,0,65536)&&v.truncated===false;
  if(kind==='source_cell') {
    const modes=['stored_text','decimal_lexeme','excel_date','zero_padded_identifier'];
    valid=side(v.side)&&integer(v.record,1,100000)&&text(v.column)&&text(v.sheet_name)&&text(v.coordinate)&&/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(v.coordinate)&&['blank','text','numeric','boolean'].includes(v.cell_type)&&text(v.stored_value)&&Buffer.byteLength(v.stored_value,'utf8')<=65536&&text(v.imported_value)&&Buffer.byteLength(v.imported_value,'utf8')<=65536&&modes.includes(v.mode)&&(v.style_index===null||integer(v.style_index))&&(v.number_format===null||text(v.number_format)&&Buffer.byteLength(v.number_format,'utf8')<=65536);
  }
  if(kind==='preview') {
    valid=side(v.side)&&strings(v.headers)&&integer(v.row_count,0,100000)&&integer(v.column_count,1,256)&&v.column_count===v.headers.length&&integer(v.offset)&&integer(v.limit,1,100)&&Array.isArray(v.rows)&&v.rows.length<=v.limit&&integer(v.next_offset)&&typeof v.has_more==='boolean';
    if(valid)valid=v.next_offset===v.offset+v.rows.length&&v.has_more===(v.next_offset<v.row_count)&&v.rows.every((row,i)=>{exact(row,['record','cells']);return row.record===v.offset+i+1&&Array.isArray(row.cells)&&row.cells.length===v.column_count&&row.cells.every((c,j)=>{exact(c,['column','value','utf8_bytes','truncated']);return c.column===v.headers[j]&&text(c.value)&&integer(c.utf8_bytes,0,65536)&&typeof c.truncated==='boolean';});});
  }
  if(!valid)throw failure('invalid_request',`Invalid ${kind} DTO`);
  return v;
}
export function project(kind,entry) {const keys=kind==='import'&&entry.format==='xlsx'?[...shapes.import,'adapter']:shapes[kind];return assertDto(kind,Object.fromEntries(keys.map(k=>[k,entry[k]])));}
export function sanitizeError(value,paths=[]) {
  let e=value?.error??value;
  try{assertDto('error',e);}catch{e=errorDto(value?.code??'host_failure','Local task failed');}
  let message=e.message.split(/\n|\r/)[0];
  if(e.code==='internal_error')message='Internal task failure';
  for(const p of paths.filter(x=>typeof x==='string'&&x.length).sort((a,b)=>b.length-a.length))message=message.split(p).join('[local file]');
  const routes=[];message=message.replace(/\/api\/[a-zA-Z0-9_/?=&.-]+/g,s=>{routes.push(s);return `EVIDENCEROUTE${routes.length-1}END`;});
  message=message.replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"<>:,]+[\\/])*[^\s'"<>:,]*/g,'[local file]').replace(/\s+at\s+.*/,'');
  message=message.replace(/EVIDENCEROUTE(\d+)END/g,(_,index)=>routes[Number(index)]);
  return {...e,message:message.slice(0,4000)};
}
export const jsonBytes=v=>Buffer.byteLength(JSON.stringify(v));
