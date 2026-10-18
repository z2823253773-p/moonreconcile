import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as network from '../scripts/workbench-package-network.mjs';

const endpoint = Object.freeze({ host: 'registry.npmjs.org', address: '104.16.0.34', port: 443 });
const result = (outcome, extra = {}, status = 0) => ({ status, stdout: JSON.stringify({ ...endpoint, outcome, ...extra }), stderr: '' });

test('external positive control rejects changed address or port even when status is zero', () => {
  for (const extra of [{ address: '104.16.1.34' }, { port: 444 }, { host: 'other.example' }]) {
    assert.throws(() => network.externalControlEvidence('darwin', result('connected', extra), endpoint), /endpoint/);
  }
});

test('fixed resolver validates public IPv4 and resolves exactly once outside isolation', async (t) => {
  const calls = [];
  t.mock.method(dns, 'lookup', async (...args) => { calls.push(args); return { address: endpoint.address, family: 4 }; });
  const resolved = await network.resolveExternalEndpoint('darwin');
  assert.deepEqual(resolved, endpoint);
  assert.ok(Object.isFrozen(resolved));
  assert.deepEqual(calls, [['registry.npmjs.org', { family: 4 }]]);
  assert.deepEqual(await network.resolveExternalEndpoint('linux'), { host: '1.1.1.1', address: '1.1.1.1', port: 443 });
  assert.equal(calls.length, 1, 'Linux must not resolve DNS inside its isolated namespace');
});

test('resolver failure and invalid, private, reserved or non-IPv4 responses fail closed', async (t) => {
  for (const address of ['bad', '::1', '01.2.3.4', '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
    t.mock.method(dns, 'lookup', async () => ({ address, family: 4 }));
    await assert.rejects(network.resolveExternalEndpoint('darwin'), /public unicast IPv4/);
    t.mock.restoreAll();
  }
  t.mock.method(dns, 'lookup', async () => ({ address: endpoint.address, family: 6 }));
  await assert.rejects(network.resolveExternalEndpoint('darwin'), /IPv4/);
  t.mock.restoreAll();
  t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('resolver failed'), { code: 'ENOTFOUND' }); });
  await assert.rejects(network.resolveExternalEndpoint('darwin'), /resolver failed/);
});

test('external positive and denial evidence require exact fresh outcomes', () => {
  assert.match(network.externalControlEvidence('darwin', result('connected'), endpoint), /104\.16\.0\.34:443/);
  for (const control of [result('timeout', {}, 4), result('error', { error: 'ECONNREFUSED' }, 1), result('timeout'), { status: null, error: new Error('timeout') }]) {
    assert.throws(() => network.externalControlEvidence('darwin', control, endpoint), /fresh unsandboxed/);
  }
  for (const error of ['EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH']) {
    assert.equal(network.externalDenialEvidence(result('error', { error }), endpoint).error, error);
  }
  for (const denial of [result('connected', {}, 5), result('connected'), result('timeout', {}, 4), result('timeout'), result('error', { error: 'ECONNREFUSED' }), result('error', { error: 'ETIMEDOUT' }), result('error', { error: 'EPERM', address: '104.16.1.34' }), result('error', { error: 'EPERM', port: 444 }), { status: 0, stdout: 'EPERM' }]) {
    assert.throws(() => network.externalDenialEvidence(denial, endpoint));
  }
  assert.match(network.externalControlEvidence('linux'), /not applicable/);
});

test('generated raw TCP probes bind numeric endpoint and unchanged 3 second deadline', () => {
  for (const kind of ['positive', 'denial']) {
    const script = network.externalProbeScript(endpoint, kind);
    assert.match(script, /3000/);
    assert.match(script, /104\.16\.0\.34/);
    assert.doesNotMatch(script, /process\.env|proxy|lookup/i);
    assert.equal(spawnSync(process.execPath, ['--check', '--input-type=module'], { input: script }).status, 0);
  }
  assert.throws(() => network.externalProbeScript({ ...endpoint, port: 444 }, 'denial'), /endpoint/);
});
