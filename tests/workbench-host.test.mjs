import test from 'node:test';
import assert from 'node:assert/strict';
import { callEngine, executeTask } from '../workbench/engine-host.mjs';

test('callEngine keeps six-field engine errors and refuses unknown task kinds', async () => {
  assert.deepEqual(callEngine({ op: 'x' }, () => JSON.stringify({ ok: true, value: 1 })), { ok: true, value: 1 });
  await assert.rejects(() => executeTask({ kind: 'invented', payload: {}, paths: {}, bridge_path: '' }, { invoke: () => '' }), /unknown/i);
});
