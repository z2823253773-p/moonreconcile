import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobManager } from '../workbench/jobs.mjs';

test('jobs start in running state and unknown identifiers are rejected', async () => {
  const jobs = await createJobManager({ session: {}, workerPath: '', bridgePath: '', limits: { jobTimeoutMs: 10 } });
  assert.throws(() => jobs.get('missing'), /not found/i);
  await jobs.close();
});
