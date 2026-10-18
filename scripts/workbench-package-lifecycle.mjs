import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const alive = (child) => child && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null;

function waitForClose(child, milliseconds) {
  if (!alive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => { clearTimeout(timer); child.off('close', onClose); resolve(closed); };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('close', onClose);
  });
}

// Standalone checkers own a detached service group. Under verify.py the service
// stays in the runner-owned group, so checker death cannot orphan its server.
export function spawnOwnedServer(command, args, options) {
  const detached = process.env.MOONRECONCILE_VERIFIER_PROCESS_GROUP !== '1';
  const child = spawn(command, args, { ...options, detached });
  child.ownedDetached = detached;
  return child;
}
function signalOwned(child, signal) {
  if (!alive(child)) return;
  try { process.kill(child.ownedDetached === false ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function stopAndVerify(child, sessionParent) {
  const record = { pid: child?.pid ?? null, graceful: false, forced: false, exit_code: child?.exitCode ?? null, signal: child?.signalCode ?? null, remaining_sessions: [] };
  try {
    assert.ok(alive(child), 'workbench exited before the graceful shutdown check');
    signalOwned(child, 'SIGTERM');
    if (!await waitForClose(child, 3000)) {
      record.forced = true;
      signalOwned(child, 'SIGKILL');
      assert.ok(await waitForClose(child, 3000), 'owned workbench did not exit after SIGKILL');
    }
    record.exit_code = child.exitCode;
    record.signal = child.signalCode;
    record.remaining_sessions = await fs.readdir(sessionParent);
    assert.equal(record.forced, false, 'workbench graceful SIGTERM shutdown timed out; owned process was killed and reaped');
    assert.equal(record.exit_code, 0, 'workbench graceful shutdown exit code must be zero');
    assert.equal(record.signal, null, 'workbench graceful shutdown must not end by signal');
    assert.deepEqual(record.remaining_sessions, [], 'owned sessions remain after workbench exit; cleanup failed');
    record.graceful = true;
    return record;
  } catch (error) {
    // A failed attempt still must reap its own child before returning failure.
    if (alive(child)) {
      record.forced = true;
      signalOwned(child, 'SIGKILL');
      await waitForClose(child, 3000);
    }
    record.exit_code = child?.exitCode ?? null;
    record.signal = child?.signalCode ?? null;
    record.remaining_sessions = await fs.readdir(sessionParent);
    error.shutdown = record;
    throw error;
  }
}
