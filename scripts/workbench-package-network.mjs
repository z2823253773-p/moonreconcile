import assert from 'node:assert/strict';

export function externalControlEvidence(platform, control) {
  if (platform === 'darwin') {
    assert.equal(control?.status, 0, `fresh unsandboxed external TCP positive control must succeed: ${control?.stdout ?? ''} ${control?.stderr ?? control?.error?.message ?? ''}`);
    return 'this invocation: unsandboxed Node connected to 1.1.1.1:443';
  }
  assert.equal(platform, 'linux', 'unsupported network isolation platform');
  return 'not applicable inside this invocation network namespace; external denial and loopback are checked directly';
}
