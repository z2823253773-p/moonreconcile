import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startWorkbench } from '../workbench/server.mjs';

test('server exposes capability and enforces token/origin/host', async (t) => {
  const app = await startWorkbench({ rootParent: undefined });
  t.after(() => app.close());
  const noToken = await fetch(`${app.origin}/api/capabilities`);
  assert.equal(noToken.status, 401);
  const caps = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}` } });
  assert.equal(caps.status, 200);
  assert.deepEqual((await caps.json()).formats, ['csv']);
  const cross = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}`, origin: 'http://evil.example' } });
  assert.equal(cross.status, 403);
  const address = new URL(app.origin);
  const badHost = await new Promise((resolve, reject) => http.get({ hostname: address.hostname, port: address.port, path: '/api/capabilities', headers: { authorization: `Bearer ${app.token}`, host: '127.0.0.1:1', 'x-forwarded-host': address.host } }, response => { response.resume(); resolve(response); }).on('error', reject));
  assert.equal(badHost.statusCode, 403);
  const noOrigin = await fetch(`${app.origin}/api/capabilities`, { headers: { authorization: `Bearer ${app.token}`, 'x-forwarded-host': 'evil.example' } });
  assert.equal(noOrigin.status, 200);
});

test('asset upload enforces raw byte limit before publishing', async (t) => {
  const app = await startWorkbench({ limits: { asset_bytes: 4 } });
  t.after(() => app.close());
  const r = await fetch(`${app.origin}/api/assets?kind=csv`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/octet-stream' }, body: '12345' });
  assert.equal(r.status, 413);
  assert.equal(app.session.assets.size, 0);
});
