import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const name = 'moonreconcile-workbench-0.2.0';
const node = process.execPath;
let owned;
let originalPackage;
let originalZip;

function run(cwd, command, args, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

before(async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 22);
  owned = await fs.mkdtemp(path.join(os.tmpdir(), 'moonreconcile-validator-regression-'));
  originalPackage = path.join(owned, 'original', name);
  originalZip = `${originalPackage}.zip`;
  run(root, node, ['scripts/package-workbench.mjs'], { MOONRECONCILE_PACKAGE_DIR: originalPackage, MOONRECONCILE_PACKAGE_ZIP: originalZip });
});

after(async () => { if (owned) await fs.rm(owned, { recursive: true, force: true }); });

async function fixture(label) {
  const directory = path.join(owned, label);
  await fs.mkdir(directory);
  for (const relative of run(root, 'git', ['ls-files', '-z']).split('\0').filter(Boolean)) {
    await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await fs.copyFile(path.join(root, relative), path.join(directory, relative));
  }
  // Include this round's new helper before it is committed. All fixture writes
  // remain under the root created by this test, never under a reviewer fixture.
  for (const relative of ['scripts/workbench-package-provenance.mjs', 'scripts/workbench-package-lifecycle.mjs']) {
    try { await fs.copyFile(path.join(root, relative), path.join(directory, relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  const buildDir = '_build/js/debug/build/cmd/bridge';
  await fs.mkdir(path.join(directory, buildDir), { recursive: true });
  await fs.copyFile(path.join(root, buildDir, 'bridge.js'), path.join(directory, buildDir, 'bridge.js'));
  try { await fs.copyFile(path.join(root, buildDir, 'bridge.provenance.json'), path.join(directory, buildDir, 'bridge.provenance.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.join(directory, 'dist'));
  await fs.cp(originalPackage, path.join(directory, 'dist', name), { recursive: true });
  await fs.copyFile(originalZip, path.join(directory, 'dist', `${name}.zip`));
  run(directory, 'git', ['init', '-q']);
  run(directory, 'git', ['add', '.']);
  run(directory, 'git', ['-c', 'user.name=Validator regression', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture source']);
  return directory;
}

function commit(directory) {
  run(directory, 'git', ['add', '.']);
  run(directory, 'git', ['-c', 'user.name=Validator regression', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture changed source']);
}

async function check(directory) {
  const evidence = path.join(directory, 'dist/workbench-package-validation-2026-10-08.json');
  await fs.writeFile(evidence, '{"status":"passed","source_sha":"old-attempt"}\n');
  const child = spawn(node, ['scripts/check-workbench-package.mjs'], {
    cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOONRECONCILE_NODE_BINARY: node },
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    // The detached group belongs exclusively to this invocation and its children.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }, 15000);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const record = JSON.parse(await fs.readFile(evidence, 'utf8'));
  console.log(JSON.stringify({ fixture: path.basename(directory), checker_exit: exit, timed_out: timedOut, status: record.status, source_sha: record.source_sha, package_source_sha: record.package_source_sha, archive_sha256: record.archive_sha256, bridge_sha256: record.bridge_sha256, shutdown: record.shutdown }));
  return { ...exit, stdout, stderr, timedOut, record };
}

test('strict checker accepts an evidence-only commit with unchanged package inputs and verifies graceful cleanup', async () => {
  const directory = await fixture('evidence-only');
  await fs.writeFile(path.join(directory, 'docs/evidence/fixture-evidence.md'), 'Only evidence changed.\n');
  commit(directory);
  const result = await check(directory);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.record.status, 'passed');
  assert.equal(result.record.source_sha, run(directory, 'git', ['rev-parse', 'HEAD']).trim());
  assert.notEqual(result.record.source_sha, result.record.package_source_sha);
  assert.equal(result.record.shutdown.graceful, true);
  assert.equal(result.record.shutdown.forced, false);
  assert.equal(result.record.shutdown.exit_code, 0);
  assert.deepEqual(result.record.shutdown.remaining_sessions, []);
});

test('builder refuses an old bridge after committed core source inputs change', async () => {
  const directory = await fixture('new-core-old-bridge');
  await fs.appendFile(path.join(directory, 'engine.mbt'), '\n// changed core input after original compilation\n');
  commit(directory);
  const result = spawnSync(node, ['scripts/package-workbench.mjs'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, MOONRECONCILE_PACKAGE_DIR: path.join(owned, 'stale-bridge-output', name) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compiled bridge source\/build inputs changed/);
  console.log(JSON.stringify({ fixture: 'new-core-old-bridge', builder_exit: result.status, rejected: 'compiled bridge source/build inputs changed' }));
});

test('strict checker rejects an archive that differs from the complete package directory', async () => {
  const directory = await fixture('archive-mismatch');
  const { default: yazl } = await import('yazl');
  const { createWriteStream } = await import('node:fs');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('throw new Error("OLD ARCHIVE");\n'), `${name}/cli/main.mjs`);
  const target = path.join(directory, 'dist', `${name}.zip`);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(target);
    output.once('close', resolve); output.once('error', reject);
    zip.outputStream.once('error', reject).pipe(output); zip.end();
  });
  const result = await check(directory);
  assert.notEqual(result.code, 0);
  assert.equal(result.record.status, 'failed');
  assert.match(result.stderr, /archive must equal the complete package directory/);
});

test('strict checker rejects an old package at a new clean runtime source commit', async () => {
  const directory = await fixture('new-source-old-package');
  await fs.writeFile(path.join(directory, 'cli/main.mjs'), 'throw new Error("NEW SOURCE CANNOT RUN");\n');
  commit(directory);
  const result = await check(directory);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.timedOut, false);
  assert.equal(result.record.status, 'failed', JSON.stringify(result));
  assert.match(result.stderr, /source|provenance|input/i);
});

for (const mode of ['ignore', 'cleanup-refusal', 'cleanup-residue']) {
  test(`strict checker fails and reaps its child on ${mode}`, async () => {
    const directory = await fixture(mode);
    const start = path.join(directory, 'workbench/start.mjs');
    const pidFile = path.join(directory, 'dist/fixture-child.pid');
    const mutation = mode === 'ignore'
      ? "process.removeAllListeners('SIGTERM'); process.on('SIGTERM',()=>{});"
      : mode === 'cleanup-refusal'
        ? "process.prependOnceListener('SIGTERM',()=>writeFileSync(path.join(app.session.root,'.owner'),'ownership-refused'));"
        : "process.removeAllListeners('SIGTERM'); process.once('SIGTERM',()=>process.exit(0));";
    await fs.appendFile(start, `\nimport {writeFileSync} from 'node:fs';\nimport path from 'node:path';\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid));\n${mutation}\n`);
    commit(directory);
    const output = path.join(owned, `${mode}-staging`, name);
    const zip = `${output}.zip`;
    run(directory, node, ['scripts/package-workbench.mjs'], { MOONRECONCILE_PACKAGE_DIR: output, MOONRECONCILE_PACKAGE_ZIP: zip });
    await fs.rm(path.join(directory, 'dist', name), { recursive: true });
    await fs.cp(output, path.join(directory, 'dist', name), { recursive: true });
    await fs.copyFile(zip, path.join(directory, 'dist', `${name}.zip`));
    const result = await check(directory);
    assert.equal(result.timedOut, false, JSON.stringify(result));
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.equal(result.record.status, 'failed', JSON.stringify(result));
    assert.doesNotMatch(result.stdout, /"status": "passed"/);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(result.record.shutdown.remaining_sessions.length > 0);
    assert.equal(result.record.shutdown.graceful, false);
    if (mode === 'cleanup-residue') assert.equal(result.record.shutdown.exit_code, 0);
    assert.match(result.stderr, mode === 'ignore' ? /shutdown|grace|SIGTERM|exit/i : /cleanup|exit|session/i);
  });
}
