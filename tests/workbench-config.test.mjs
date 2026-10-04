import assert from 'node:assert/strict';
import test from 'node:test';
import { invoke_bridge as invoke } from '../_build/js/debug/build/cmd/bridge/bridge.js';
import { configToForm, formToConfig } from '../workbench/public/config-model.mjs';
import { createApiClient, consumeTokenFragment } from '../workbench/public/api.mjs';
import { createWorkbenchState } from '../workbench/public/state.mjs';
import { startWorkbench } from '../workbench/server.mjs';

const coreCheck = (config) => JSON.parse(invoke(JSON.stringify({ op: 'check_config', config })));
const canonical = (config) => JSON.stringify(coreCheck(config).config);

test('all_config_v1_properties_round_trip', () => {
  const raw = {
    schema_version: 1,
    fields: [
      { name: 'id', left: 'id', right: 'external id', type: 'text', compare: false, trim_ascii: true, lower_ascii: true,
        left_values: { '__proto__': 'literal proto', '10': 'ten', '2': 'two' }, right_values: { '__proto__': 'safe', '10': 'dix', '2': 'deux' },
        missing: [''], both_missing: 'issue', abs_tol: '0', rel_tol: '0', days_tol: 0 },
      { name: 'amount', left: 'amount', right: 'total', type: 'decimal', compare: true, trim_ascii: false, lower_ascii: false,
        left_values: {}, right_values: {}, missing: ['N/A'], both_missing: 'equal', abs_tol: '0.02', rel_tol: '0.10', days_tol: 0 },
      { name: 'day', left: 'day', right: 'date', type: 'date', compare: true, trim_ascii: false, lower_ascii: false,
        left_values: {}, right_values: {}, missing: [], both_missing: 'equal', abs_tol: '0', rel_tol: '0', days_tol: 2 },
    ],
    key: ['id'], ignore_left: ['unused-left'], ignore_right: ['unused-right'],
    candidates: { fields: [{ field: 'amount', metric: 'decimal', weight: 10 }, { field: 'day', metric: 'date', weight: 3 }], threshold: 8000, blocking: [['id'], ['amount', 'day']] },
  };
  Object.defineProperty(raw.fields[0].left_values, '__proto__', { value: 'literal proto', enumerable: true, configurable: true, writable: true });
  Object.defineProperty(raw.fields[0].right_values, '__proto__', { value: 'safe', enumerable: true, configurable: true, writable: true });
  const normalized = coreCheck(raw);
  assert.equal(normalized.ok, true, JSON.stringify(normalized.error));
  const model = configToForm(normalized.config);
  assert.deepEqual(model.fields[0].left_values.map((entry) => entry.key), ['2', '10', '__proto__']);
  assert.ok(model.fields[0].missing.includes(''));
  const roundTrip = formToConfig(model);
  assert.equal(canonical(roundTrip), JSON.stringify(normalized.config));
  assert.equal(typeof roundTrip.fields[1].abs_tol, 'string');
  assert.equal(roundTrip.fields[1].abs_tol, '0.02');
});

test('duplicate mapping keys are rejected without losing special keys', () => {
  const model = configToForm({ schema_version: 1, draft: false, fields: [{ name: 'x', left: 'x', right: 'x', type: 'text', compare: true, trim_ascii: false, lower_ascii: false, left_values: {}, right_values: {}, missing: [], both_missing: 'equal', abs_tol: '0', rel_tol: '0', days_tol: 0 }], key: [], ignore_left: [], ignore_right: [], candidates: null });
  model.fields[0].left_values = [{ key: '__proto__', value: 'one' }, { key: '__proto__', value: 'two' }];
  assert.throws(() => formToConfig(model), /重复/);
});

test('unknown core config keys remain core errors', () => {
  const result = coreCheck({ schema_version: 1, fields: [{ name: 'x', left: 'x', right: 'x', type: 'text' }], unexpected: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_config');
});

test('changing a field type or deleting a field preserves tolerance text and references', () => {
  const normalized = coreCheck({
    schema_version: 1,
    fields: [{ name: 'id', left: 'id', right: 'id', type: 'decimal', abs_tol: '0.02' }, { name: 'name', left: 'name', right: 'name', type: 'text' }],
    key: ['id'], ignore_left: ['legacy'], ignore_right: [],
    candidates: { fields: [{ field: 'name', metric: 'exact', weight: 4 }], threshold: 100, blocking: [['id']] },
  });
  const model = configToForm(normalized.config);
  model.fields[0].type = 'text';
  model.fields.splice(1, 1);
  const config = formToConfig(model);
  assert.equal(config.fields[0].abs_tol, '0.02');
  assert.deepEqual(config.key, ['id']);
  assert.deepEqual(config.ignore_left, ['legacy']);
  assert.deepEqual(config.candidates.fields, [{ field: 'name', metric: 'exact', weight: 4 }]);
  assert.deepEqual(config.candidates.blocking, [['id']]);
});

test('strict integer controls do not reinterpret decimal notation', () => {
  const model = configToForm({ schema_version: 1, fields: [{ name: 'day', left: 'day', right: 'day', type: 'date', days_tol: 1 }], key: [] });
  model.fields[0].days_tol = '1e2';
  const result = coreCheck(formToConfig(model));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_config');
});

test('static app is fixed-whitelist and imports expose safe asset metadata', async (t) => {
  const app=await startWorkbench();t.after(()=>app.close());
  const root=await fetch(app.origin+'/');assert.equal(root.status,200);assert.match(await root.text(),/public\/app\.mjs/);
  const script=await fetch(app.origin+'/public/config-model.mjs');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
  assert.equal((await fetch(app.origin+'/public/unknown.mjs')).status,404);
  const auth={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const upload=await fetch(app.origin+'/api/assets?kind=csv',{method:'POST',headers:{authorization:`Bearer ${app.token}`,'content-type':'application/octet-stream','x-filename':encodeURIComponent('左侧.csv')},body:'id\n1\n'});
  const asset=(await upload.json()).asset;
  const created=await fetch(app.origin+'/api/imports',{method:'POST',headers:auth,body:JSON.stringify({asset_id:asset.asset_id,side:'left'})});
  const jobId=(await created.json()).job_id;let job;
  for(let i=0;i<200;i++){job=(await (await fetch(`${app.origin}/api/jobs/${jobId}`,{headers:auth})).json()).job;if(!['running','cancelling'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(job.state,'succeeded');
  const metadata=await fetch(`${app.origin}/api/imports/${job.output.import.import_id}`,{headers:auth});assert.equal(metadata.status,200);
  const dto=await metadata.json();assert.equal(dto.import.import_id,job.output.import.import_id);assert.equal(dto.asset.asset_id,asset.asset_id);assert.equal(dto.asset.sha256,asset.sha256);assert.equal(dto.asset.bytes,Buffer.byteLength('id\n1\n'));assert.equal('path' in dto.import,false);assert.equal('path' in dto.asset,false);
});

test('session token is removed from fragment and client rejects cross-origin destinations', async () => {
  let cleaned='';const location={hash:'#token=abc123',pathname:'/',search:'?safe=1'};
  assert.equal(consumeTokenFragment(location,{replaceState:(_state,_title,url)=>cleaned=url}),'abc123');assert.equal(cleaned,'/?safe=1');
  let called=false;const client=createApiClient({origin:'http://127.0.0.1:1234',token:'secret',fetchImpl:async(_url,init)=>{called=true;assert.equal(init.headers.Authorization,'Bearer secret');return new Response(JSON.stringify({ok:true,value:1}),{status:200,headers:{'content-type':'application/json'}});}});
  assert.equal((await client.request('/api/test')).value,1);await assert.rejects(client.download('https://example.org/x'),/本机绝对路径/);assert.equal(called,true);
});

test('edits stale old revisions, recheck keeps stale, and only compare clears it', () => {
  const store=createWorkbenchState();store.update({left_import_id:'left-a',right_import_id:'right-a'});
  store.update({config:{fields:[]},draft_dirty:true});assert.equal(store.get().stale,true);assert.equal(store.get().config_asset_id,null);
  store.update({config:{fields:[]},config_asset_id:'cfg-a',draft_dirty:false});assert.equal(store.get().stale,true);assert.equal(store.get().config_asset_id,'cfg-a');
  store.update({revision:{revision_id:'rev-a'},stale:false,pending_decisions:[{action:'accept'}]});assert.equal(store.get().stale,false);
  store.update({left_import_id:'left-b'});assert.equal(store.get().stale,true);assert.equal(store.get().revision.revision_id,'rev-a');assert.equal(store.get().config_asset_id,null);assert.deepEqual(store.get().pending_decisions,[]);
});
