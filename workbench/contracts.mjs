export const APP_VERSION = '0.2.0';
export const API_VERSION = 1;
export const HOST_LIMITS = Object.freeze({
  session_bytes: 1073741824, assets: 64, imports: 64, revisions: 32, jobs: 256,
  uploads: 1, children: 1, upload_ms: 60000, job_ms: 180000, kill_ms: 1000,
  quota_poll_ms: 250, zip_bytes: 268435456, unzip_bytes: 1073741824, zip_entries: 32,
  request_bytes: 1048576, response_bytes: 2097152,
});
export const errorDto = (code, message, phase='host', side=null, record=null, field=null) => ({code,message,phase,side,record,field});
const shapes = {
  asset: ['asset_id','kind','name','bytes','sha256'],
  import: ['import_id','asset_id','side','format','status','headers','row_count','column_count','sha256'],
  job: ['job_id','kind','state','phase','output','error'],
  revision: ['revision_id','parent_revision_id','baseline_revision_id','run_id','report_sha256','decisions_sha256','left_import_id','right_import_id','config_asset_id','exit_code'],
};
export function assertDto(kind, value) {
  const keys=shapes[kind];
  if (!keys || !value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(value,k))) throw Object.assign(new Error('invalid DTO'),{error:errorDto('invalid_request','invalid DTO')});
  return value;
}
