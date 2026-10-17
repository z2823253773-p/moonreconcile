import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { isIPv4 } from 'node:net';

function publicIPv4(address) {
  assert.ok(typeof address === 'string' && isIPv4(address), 'external endpoint must be a public unicast IPv4 address');
  const [a, b, c] = address.split('.').map(Number);
  assert.ok(!(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)), 'external endpoint must be a public unicast IPv4 address');
}

function validateEndpoint(endpoint) {
  assert.equal(endpoint?.port, 443, 'external endpoint port must remain 443');
  assert.ok(endpoint.host === 'registry.npmjs.org' || (endpoint.host === '1.1.1.1' && endpoint.address === '1.1.1.1'), 'unexpected external endpoint host');
  publicIPv4(endpoint.address);
}

// The checker calls this once, before entering the macOS sandbox. Linux's
// caller already occupies its isolated namespace and must not perform DNS.
// There is deliberately no CLI/environment endpoint or proxy override.
export async function resolveExternalEndpoint(platform) {
  if (platform === 'linux') return Object.freeze({ host: '1.1.1.1', address: '1.1.1.1', port: 443 });
  assert.equal(platform, 'darwin', 'unsupported network isolation platform');
  const resolved = await dns.lookup('registry.npmjs.org', { family: 4 });
  assert.equal(resolved.family, 4, 'external resolver must return IPv4');
  const endpoint = { host: 'registry.npmjs.org', address: resolved.address, port: 443 };
  validateEndpoint(endpoint);
  return Object.freeze(endpoint);
}

export function externalProbeScript(endpoint, kind) {
  validateEndpoint(endpoint);
  assert.ok(kind === 'positive' || kind === 'denial');
  return `import net from 'node:net';
const endpoint=${JSON.stringify(endpoint)};
const finish=(outcome,error,status)=>{clearTimeout(timer);socket.destroy();process.stdout.write(JSON.stringify({...endpoint,outcome,...(error?{error}:{})}));process.exit(status)};
const socket=net.createConnection({host:endpoint.address,port:endpoint.port,family:4});
const timer=setTimeout(()=>finish('timeout',null,4),3000);
socket.once('connect',()=>finish('connected',null,${kind === 'positive' ? 0 : 5}));
socket.once('error',(error)=>finish('error',error.code??'unknown',${kind === 'positive' ? '1' : "['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'].includes(error.code)?0:6"}));`;
}

function probeRecord(control, endpoint) {
  validateEndpoint(endpoint);
  assert.ok(!control.error && control.signal == null, 'external probe did not exit normally');
  const record = JSON.parse(control.stdout);
  assert.deepEqual({ host: record.host, address: record.address, port: record.port }, endpoint, 'external probe endpoint differs from frozen endpoint');
  return record;
}

export function externalDenialEvidence(control, endpoint) {
  assert.equal(control?.status, 0, `external TCP probe must be explicitly denied: ${control?.stdout ?? ''} ${control?.stderr ?? control?.error?.message ?? ''}`);
  const record = probeRecord(control, endpoint);
  assert.equal(record.outcome, 'error', 'external sandbox probe must explicitly deny, not connect or time out');
  assert.ok(['EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH'].includes(record.error), 'unexpected external sandbox probe error');
  return record;
}

export function externalControlEvidence(platform, control, endpoint) {
  if (platform === 'darwin') {
    assert.equal(control?.status, 0, `fresh unsandboxed external TCP positive control must succeed: ${control?.stdout ?? ''} ${control?.stderr ?? control?.error?.message ?? ''}`);
    const record = probeRecord(control, endpoint);
    assert.equal(record.outcome, 'connected', 'fresh unsandboxed external TCP positive control must connect');
    assert.ok(!record.error, 'fresh unsandboxed external TCP positive control must not report an error');
    return `this invocation: unsandboxed Node connected to ${endpoint.host} resolved once as ${endpoint.address}:${endpoint.port}`;
  }
  assert.equal(platform, 'linux', 'unsupported network isolation platform');
  return 'not applicable inside this invocation network namespace; external denial and loopback are checked directly';
}
