import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkbench } from '../workbench/server.mjs';

async function setup(t, bridgePath) {
  const app = await startWorkbench({ bridgePath });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  const request = async (route, body) => {
    const response = await fetch(app.origin + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = response.headers.get('content-type') ?? '';
    return { status: response.status, body: contentType.includes('json') ? await response.json() : await response.text() };
  };
  const waitJob = async response => {
    assert.equal(response.status, 202, JSON.stringify(response.body));
    for (let i = 0; i < 400; i++) {
      const job = (await request(`/api/jobs/${response.body.job_id}`)).body.job;
      if (!['running', 'cancelling'].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('job wait timeout');
  };
  const start = async (route, body) => waitJob(await request(route, body));
  const upload = async (kind, data) => {
    const response = await fetch(`${app.origin}/api/assets?kind=${kind}`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/octet-stream' }, body: data });
    assert.equal(response.status, 201);
    return (await response.json()).asset;
  };
  const example = async name => (await start(`/api/examples/${name}`, {})).output;
  return { app, request, start, upload, example };
}

test('orders_review_preserves_differences and revision_id differs while run_id stays', async t => {
  const c = await setup(t), ex = await c.example('orders');
  const parentJob = await c.start('/api/runs', { left_import_id: ex.left_import_id, right_import_id: ex.right_import_id, config_asset_id: ex.config_asset_id });
  assert.equal(parentJob.state, 'succeeded', JSON.stringify(parentJob.error));
  const parent = parentJob.output.revision;
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nleft_unmatched,L3,,source-system audit confirms missing sync\n');
  const endpoint = `/api/runs/${parent.revision_id}/reviews`;
  const review = await c.start(endpoint, { base_revision: parent.revision_id, decisions_asset_id: decisions.asset_id });
  assert.equal(review.state, 'succeeded', JSON.stringify(review.error));
  const child = review.output.revision;
  assert.notEqual(child.revision_id, parent.revision_id);
  assert.equal(child.run_id, parent.run_id);
  const summary = await c.request(`/api/runs/${child.revision_id}/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.summary.unresolved_count, 0);
  assert.equal(summary.body.summary.fields.different, 3);
  assert.equal(summary.body.revision.exit_code, 1);
});

test('catalog_can_reject_top_and_accept_competitor without accepting highest score by default', async t => {
  const c = await setup(t), ex = await c.example('catalog');
  const parentJob = await c.start('/api/runs', { left_import_id: ex.left_import_id, right_import_id: ex.right_import_id, config_asset_id: ex.config_asset_id });
  const parent = parentJob.output.revision;
  const top = await c.request(`/api/runs/${parent.revision_id}/candidates?left_id=L1&right_id=R2`);
  assert.equal(top.body.items[0].item.score, 10000);
  assert.equal(top.body.items[0].item.suggested, true);
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nreject,L1,R2,decoy\naccept,L1,R1,confirmed\nright_unmatched,,R2,truth\n');
  const review = await c.start(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: decisions.asset_id });
  assert.equal(review.state, 'succeeded', JSON.stringify(review.error));
  const report = await c.request(`/api/runs/${review.output.revision.revision_id}/summary`);
  assert.equal(report.status, 200);
  const pairs = await c.request(`/api/runs/${review.output.revision.revision_id}/pairs`);
  assert.ok(pairs.body.items.some(({ item }) => item.left_id === 'L1' && item.right_id === 'R1'));
});

test('imported_decisions_are_append_only uses complete tuples and detects noncumulative input', async t => {
  const c = await setup(t), ex = await c.example('orders');
  const parent = (await c.start('/api/runs', { left_import_id: ex.left_import_id, right_import_id: ex.right_import_id, config_asset_id: ex.config_asset_id })).output.revision;
  const first = await c.upload('decisions', 'action,left_id,right_id,reason\nleft_unmatched,L3,,audit\n');
  const child = await c.start(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: first.asset_id });
  assert.equal(child.state, 'succeeded');
  const missing = await c.upload('decisions', 'action,left_id,right_id,reason\n');
  const invalid = await c.start(`/api/runs/${child.output.revision.revision_id}/reviews`, { base_revision: child.output.revision.revision_id, decisions_asset_id: missing.asset_id });
  assert.equal(invalid.state, 'failed');
  assert.equal(invalid.error.code, 'noncumulative_decisions');
  assert.equal(c.app.session.revisions.size, 2);
});

test('whole conflict batch publishes no revision and stale base is rejected', async t => {
  const c = await setup(t), ex = await c.example('catalog');
  const parent = (await c.start('/api/runs', { left_import_id: ex.left_import_id, right_import_id: ex.right_import_id, config_asset_id: ex.config_asset_id })).output.revision;
  const beforeHash = parent.report_sha256;
  const conflicted = await c.upload('decisions', 'action,left_id,right_id,reason\naccept,L1,R1,a\nreject,L1,R1,b\n');
  const conflict = await c.start(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: conflicted.asset_id });
  assert.equal(conflict.state, 'failed');
  assert.equal(conflict.error.code, 'conflicting_decisions');
  assert.equal(c.app.session.revisions.size, 1);
  assert.equal((await c.request(`/api/runs/${parent.revision_id}/summary`)).body.revision.report_sha256, beforeHash);
  const valid = await c.upload('decisions', 'action,left_id,right_id,reason\naccept,L1,R1,confirmed\n');
  const accepted = await c.start(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: valid.asset_id });
  assert.equal(accepted.state, 'succeeded', JSON.stringify(accepted.error));
  const stale = await c.request(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: valid.asset_id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_revision');
});

test('branch recomputes original baseline into a distinct revision and clears decisions', async t => {
  const c = await setup(t), ex = await c.example('orders');
  const parent = (await c.start('/api/runs', { left_import_id: ex.left_import_id, right_import_id: ex.right_import_id, config_asset_id: ex.config_asset_id })).output.revision;
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nleft_unmatched,L3,,audit\n');
  const child = await c.start(`/api/runs/${parent.revision_id}/reviews`, { base_revision: parent.revision_id, decisions_asset_id: decisions.asset_id });
  const branched = await c.start(`/api/runs/${child.output.revision.revision_id}/branch`, {});
  assert.equal(branched.state, 'succeeded', JSON.stringify(branched.error));
  assert.notEqual(branched.output.revision.revision_id, parent.revision_id);
  assert.notEqual(branched.output.revision.baseline_revision_id, parent.baseline_revision_id);
  const applied = await c.request(`/api/runs/${branched.output.revision.revision_id}/decisions`);
  assert.equal(applied.body.total, 0);
});

test('exact key pairs stay locked by the core and manual outside-candidate accept needs a reason', async t => {
  const c = await setup(t), orders = await c.example('orders');
  const exact = (await c.start('/api/runs', { left_import_id: orders.left_import_id, right_import_id: orders.right_import_id, config_asset_id: orders.config_asset_id })).output.revision;
  const lockedCsv = await c.upload('decisions', 'action,left_id,right_id,reason\naccept,L1,R1,confirmed\n');
  const locked = await c.start(`/api/runs/${exact.revision_id}/reviews`, { base_revision: exact.revision_id, decisions_asset_id: lockedCsv.asset_id });
  assert.equal(locked.state, 'failed');
  assert.equal(locked.error.code, 'locked_exact_pair');
  assert.equal(c.app.session.revisions.size, 1);

  const left = await c.upload('csv', 'id,name\n1,A\n'), right = await c.upload('csv', 'id,name\n1,A\n2,B\n');
  const li = await c.start('/api/imports', { asset_id: left.asset_id, side: 'left' });
  const ri = await c.start('/api/imports', { asset_id: right.asset_id, side: 'right' });
  const checked = await c.start('/api/config/check', { left_import_id: li.output.import.import_id, right_import_id: ri.output.import.import_id, config: { schema_version: 1, fields: [{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'name',left:'name',right:'name',type:'text'}], key: [], candidates: { fields: [{field:'name',metric:'exact',weight:10000}], threshold: 10000 } } });
  const baseline = await c.start('/api/runs', { left_import_id: li.output.import.import_id, right_import_id: ri.output.import.import_id, config_asset_id: checked.output.config_asset_id });
  const manual = await c.upload('decisions', 'action,left_id,right_id,reason\naccept,L1,R2,\n');
  const denied = await c.start(`/api/runs/${baseline.output.revision.revision_id}/reviews`, { base_revision: baseline.output.revision.revision_id, decisions_asset_id: manual.asset_id });
  assert.equal(denied.state, 'failed');
  assert.equal(denied.error.code, 'manual_override_needs_reason');
  assert.equal(c.app.session.revisions.size, 2);
});

test('101 by 101 incomplete review stays exit 3', async t => {
  const c = await setup(t);
  const many = 'id,label\n' + Array.from({length:101}, (_, i) => `${i+1},same\n`).join('');
  const left = await c.upload('csv', many), right = await c.upload('csv', many);
  const li = await c.start('/api/imports', { asset_id: left.asset_id, side: 'left' }), ri = await c.start('/api/imports', { asset_id: right.asset_id, side: 'right' });
  const checked = await c.start('/api/config/check', { left_import_id: li.output.import.import_id, right_import_id: ri.output.import.import_id, config: { schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'label',left:'label',right:'label',type:'text'}],key:[],candidates:{fields:[{field:'label',metric:'exact',weight:10000}],threshold:10000} } });
  const base = await c.start('/api/runs', { left_import_id:li.output.import.import_id,right_import_id:ri.output.import.import_id,config_asset_id:checked.output.config_asset_id });
  assert.equal(base.output.revision.exit_code, 3);
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nleft_unmatched,L101,,' + 'explicit\n');
  const reviewed = await c.start(`/api/runs/${base.output.revision.revision_id}/reviews`, { base_revision:base.output.revision.revision_id,decisions_asset_id:decisions.asset_id });
  assert.equal(reviewed.state, 'succeeded', JSON.stringify(reviewed.error));
  assert.equal(reviewed.output.revision.exit_code, 3);
});

test('cumulative decisions export reimports to byte-identical report', async t => {
  const c = await setup(t), ex = await c.example('catalog');
  const base = (await c.start('/api/runs', { left_import_id:ex.left_import_id,right_import_id:ex.right_import_id,config_asset_id:ex.config_asset_id })).output.revision;
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nreject,L1,R2,decoy\naccept,L1,R1,confirmed\nright_unmatched,,R2,truth\n');
  const first = await c.start(`/api/runs/${base.revision_id}/reviews`, { base_revision:base.revision_id,decisions_asset_id:decisions.asset_id });
  assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
  const exported = await fetch(`${c.app.origin}/api/runs/${first.output.revision.revision_id}/export?kind=decisions`, { headers: { authorization: `Bearer ${c.app.token}` } });
  assert.equal(exported.status, 200);
  const cumulative = await c.upload('decisions', Buffer.from(await exported.arrayBuffer()));
  const second = await c.start(`/api/runs/${first.output.revision.revision_id}/reviews`, { base_revision:first.output.revision.revision_id,decisions_asset_id:cumulative.asset_id });
  assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  const [firstReport, secondReport] = await Promise.all([first, second].map(async job => Buffer.from(await (await fetch(`${c.app.origin}/api/runs/${job.output.revision.revision_id}/export?kind=report`, { headers: { authorization: `Bearer ${c.app.token}` } })).arrayBuffer())));
  assert.deepEqual(secondReport, firstReport);
});

test('cancelling a real resolve preserves the old revision hash and registry', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'task4-slow-bridge-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const realBridge = fileURLToPath(new URL('../_build/js/debug/build/cmd/bridge/bridge.js', import.meta.url));
  const bridgePath = path.join(temp, 'bridge.mjs');
  await fs.writeFile(bridgePath, `import {invoke_bridge as core} from ${JSON.stringify(realBridge)};export function invoke_bridge(s){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700);return core(s);}`);
  const c = await setup(t, bridgePath), ex = await c.example('orders');
  const parent = (await c.start('/api/runs', { left_import_id:ex.left_import_id,right_import_id:ex.right_import_id,config_asset_id:ex.config_asset_id })).output.revision;
  const decisions = await c.upload('decisions', 'action,left_id,right_id,reason\nleft_unmatched,L3,,audit\n');
  const accepted = await c.request(`/api/runs/${parent.revision_id}/reviews`, { base_revision:parent.revision_id,decisions_asset_id:decisions.asset_id });
  assert.equal(accepted.status, 202);
  await new Promise(resolve => setTimeout(resolve, 100));
  const response = await fetch(`${c.app.origin}/api/jobs/${accepted.body.job_id}`, { method:'DELETE',headers:{authorization:`Bearer ${c.app.token}`} });
  const cancelled = await response.json();
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal(c.app.session.revisions.size, 1);
  assert.equal((await c.request(`/api/runs/${parent.revision_id}/summary`)).body.revision.report_sha256, parent.report_sha256);
});
