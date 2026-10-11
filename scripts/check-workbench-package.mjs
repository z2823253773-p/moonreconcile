#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { gitIdentity, verifySourceAtHead, verifyPackage, files, PACKAGE_PROVENANCE } from './workbench-package-provenance.mjs';
import { spawnOwnedServer, stopAndVerify } from './workbench-package-lifecycle.mjs';
import { externalControlEvidence } from './workbench-package-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'moonreconcile-workbench-0.2.0';
const PACKAGE_DIR = path.resolve(process.env.MOONRECONCILE_PACKAGE_DIR ?? path.join(ROOT, 'dist', NAME));
const ZIP_PATH = path.resolve(process.env.MOONRECONCILE_PACKAGE_ZIP ?? path.join(ROOT, 'dist', `${NAME}.zip`));
const EVIDENCE_PATH = path.resolve(process.env.MOONRECONCILE_VALIDATION_EVIDENCE ?? path.join(ROOT, 'dist/workbench-package-validation-2026-10-08.json'));
const SANDBOX_PROFILE = '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))';

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function status(result) { return result.status ?? (result.error ? 127 : 1); }
function assertStatus(result, expected, label) {
  assert.equal(status(result), expected, `${label}: status=${status(result)}\n${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`);
}

function nodeBinary() {
  const candidates = [process.env.MOONRECONCILE_NODE_BINARY, process.env.MOONRECONCILE_NODE22,
    '/private/tmp/moonreconcile-quarter-node22/bin/node'];
  for (const candidate of candidates.filter(Boolean)) {
    try { if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate; } catch {}
  }
  if (Number(process.versions.node.split('.')[0]) === 22) return process.execPath;
  throw new Error('Set MOONRECONCILE_NODE_BINARY to the controlled Node.js 22 binary; Node 24 is not a substitute.');
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function extractZip(file, destination) {
  const zip = await openZip(file);
  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error) => { if (!failed) { failed = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      void (async () => {
        const normalized = path.posix.normalize(entry.fileName);
        if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) throw new Error(`unsafe ZIP path: ${entry.fileName}`);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new Error(`ZIP symlink rejected: ${entry.fileName}`);
        const target = path.join(destination, ...normalized.split('/'));
        if (entry.fileName.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream)));
          await pipeline(input, createWriteStream(target, { mode: 0o600, flags: 'wx' }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => { if (!failed) resolve(); });
    zip.readEntry();
  });
}

function runOfflineNode(node, args, options) {
  if (process.platform === 'darwin') return spawnSync('/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, node, ...args], options);
  if (process.platform === 'linux' && process.env.MOONRECONCILE_NETWORK_ISOLATED === '1') return spawnSync(node, args, options);
  throw new Error('Linux package validation must run inside the unshare --net wrapper with loopback enabled.');
}

function waitForStartup(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timer;
    const clean = () => { clearTimeout(timer); child.stdout.off('data', onOut); child.stderr.off('data', onErr); child.off('exit', onExit); child.off('error', onError); };
    const onOut = (chunk) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith('http://127.0.0.1:'));
      if (line) {
        clean();
        const url = new URL(line);
        const token = new URLSearchParams(url.hash.slice(1)).get('token');
        if (!token) return reject(new Error('workbench startup URL did not include a token'));
        url.hash = '';
        resolve({ origin: url.toString().replace(/\/$/, ''), token, stdout, stderr: () => stderr });
      }
    };
    const onErr = (chunk) => { stderr += chunk.toString('utf8'); };
    const onExit = (code) => { clean(); reject(new Error(`workbench exited before startup (status ${code}): ${stderr}`)); };
    const onError = (error) => { clean(); reject(error); };
    child.stdout.on('data', onOut); child.stderr.on('data', onErr); child.once('exit', onExit); child.once('error', onError);
    timer = setTimeout(() => { clean(); reject(new Error(`workbench startup timed out: ${stderr}`)); }, timeoutMs);
  });
}

async function api(origin, token, route, { method = 'GET', body, bytes, kind, filename } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (bytes !== undefined) {
    payload = bytes;
    headers['Content-Type'] = 'application/octet-stream';
    headers['X-Filename'] = encodeURIComponent(filename ?? 'upload.bin');
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const url = new URL(route, origin);
  if (kind) url.searchParams.set('kind', kind);
  const response = await fetch(url, { method, headers, body: payload });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${url.pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  if (['application/zip', 'application/octet-stream'].some((type) => response.headers.get('content-type')?.includes(type)) || url.pathname.endsWith('/export')) return Buffer.from(await response.arrayBuffer());
  return response.json();
}

async function job(origin, token, result) {
  const jobId = result.job_id;
  assert.ok(jobId, 'job response must contain job_id');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await api(origin, token, `/api/jobs/${jobId}`);
    const current = response.job;
    if (current.state === 'succeeded') return current.output;
    if (current.state === 'failed' || current.state === 'cancelled') throw new Error(`workbench ${current.kind} job ${current.state}: ${JSON.stringify(current.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('workbench task did not finish within 60 seconds');
}

async function upload(origin, token, kind, file, filename) {
  return (await api(origin, token, '/api/assets', { method: 'POST', kind, bytes: await fs.readFile(file), filename })).asset;
}

async function main() {
  // Supersede the previous attempt before any identity/runtime checks.
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, JSON.stringify({ status: 'running', created_at: new Date().toISOString() }) + '\n');
  assertSupportedRunner();
  const identity = gitIdentity(ROOT, true);
  const provenance = await verifyPackage(ROOT, PACKAGE_DIR);
  await verifySourceAtHead(ROOT, provenance.source_inputs);
  assert.ok(await fs.stat(PACKAGE_DIR), 'run npm run package:workbench before the package gate');
  const archiveBytes = await fs.readFile(ZIP_PATH);
  const packageManifest = JSON.parse(await fs.readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  assert.equal(packageManifest.version, '0.2.0');
  assert.deepEqual(Object.keys(packageManifest.dependencies).sort(), ['buffer-crc32', 'yauzl', 'yazl']);
  assert.equal(packageManifest.devDependencies, undefined);

  const runtime = nodeBinary();
  const versionResult = spawnSync(runtime, ['--version'], { encoding: 'utf8' });
  assertStatus(versionResult, 0, 'Node runtime version');
  assert.equal(Number(versionResult.stdout.trim().replace(/^v/, '').split('.')[0]), 22, `offline package gate must use Node 22, received ${versionResult.stdout.trim()}`);
  if (path.basename(runtime) !== 'node') throw new Error(`configured runtime path must name node: ${runtime}`);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'moonreconcile-package-gate-'));
  const home = path.join(temp, 'home');
  const sessionParent = path.join(temp, 'sessions');
  const onlyBin = path.join(temp, 'node-only-bin');
  const extracted = path.join(temp, 'relocated');
  await Promise.all([fs.mkdir(sessionParent), fs.mkdir(home), fs.mkdir(onlyBin), fs.mkdir(extracted)]);
  const nodeOnly = path.join(onlyBin, 'node');
  await fs.copyFile(runtime, nodeOnly);
  await fs.chmod(nodeOnly, 0o755);
  assert.deepEqual(await fs.readdir(onlyBin), ['node']);
  const relocated = path.join(extracted, NAME);
  const result = { created_at: new Date().toISOString(), ...identity, package_source_sha: provenance.source_sha, package_source_worktree_clean: provenance.source_worktree_clean,
    provenance_sha256: hash(await fs.readFile(path.join(PACKAGE_DIR, PACKAGE_PROVENANCE))),
    package: NAME, package_version: packageManifest.version, node_binary_sha256: hash(await fs.readFile(nodeOnly)),
    node_version: versionResult.stdout.trim(), bridge_sha256: hash(await fs.readFile(path.join(PACKAGE_DIR, 'runtime/bridge.js'))),
    archive_sha256: hash(archiveBytes), package_dependencies: packageManifest.dependencies, environment: { path_entries: ['node'], npm_available: false, moon_available: false, python_available: false },
    network_isolation: { mechanism: process.platform === 'darwin' ? 'macOS sandbox-exec; deny network-outbound; allow localhost only' : 'Linux unshare --net namespace with loopback enabled before Node starts', profile: process.platform === 'darwin' ? SANDBOX_PROFILE : 'isolated network namespace; no external interface; lo brought up by CI wrapper', loopback: 'pending', external_probe: 'pending' }, gates: [] };

  let child;
  let failure;
  try {
    await extractZip(ZIP_PATH, extracted);
    assert.deepEqual(await files(extracted), Object.fromEntries(Object.entries(await files(PACKAGE_DIR)).map(([name, sha]) => [`${NAME}/${name}`, sha])), 'archive must equal the complete package directory, without extra or missing files');
    await verifyPackage(ROOT, relocated);
    result.gates.push({ name: 'source-build-package-archive-identity', status: 0, packaged_source_sha: provenance.source_sha, validated_source_sha: identity.source_sha });
    const locked = JSON.parse(await fs.readFile(path.join(relocated, 'package-lock.json'), 'utf8'));
    assert.ok(!Object.keys(locked.packages).some((key) => /playwright/i.test(key)), 'browser packages must not ship');
    const homeEnv = { PATH: onlyBin, HOME: home, TMPDIR: sessionParent, TMP: sessionParent, LANG: 'en_US.UTF-8' };
    const dependencyToolProbe = runOfflineNode(nodeOnly, ['-e', `import {spawnSync} from 'node:child_process';const results=[];for(const name of ['npm','moon','python3']){const r=spawnSync(name,['--version']);results.push({name,error:r.error?.code??null,status:r.status});if(r.error?.code!=='ENOENT')process.exit(3)}process.stdout.write(JSON.stringify(results));process.exit(0)`], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 10000 });
    assertStatus(dependencyToolProbe, 0, 'runtime cannot invoke npm, moon, or python');
    result.gates.push({ name: 'only-node-on-PATH', status: status(dependencyToolProbe) });

    const external = runOfflineNode(nodeOnly, ['-e', `import net from 'node:net';const socket=net.createConnection({host:'1.1.1.1',port:443});const timer=setTimeout(()=>{socket.destroy();process.exit(4)},3000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();process.exit(5)});socket.once('error',(error)=>{clearTimeout(timer);process.stdout.write(error.code??'unknown');process.exit(['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'].includes(error.code)?0:6)})`], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 7000 });
    assertStatus(external, 0, 'external TCP probe must be denied by network sandbox');
    result.network_isolation.external_probe = `denied (${external.stdout.trim() || external.stderr.trim() || 'socket error'})`;
    result.gates.push({ name: 'external-network-denied', status: status(external), observed: external.stdout.trim() });
    if (process.platform === 'darwin') {
      const externalControl = spawnSync(nodeOnly, ['-e', `import net from 'node:net';const socket=net.createConnection({host:'1.1.1.1',port:443});const timer=setTimeout(()=>{socket.destroy();process.stdout.write('timeout');process.exit(4)},3000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();process.stdout.write('connected');process.exit(0)});socket.once('error',(error)=>{clearTimeout(timer);process.stdout.write(error.code??'unknown');process.exit(1)})`], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 7000 });
      result.network_isolation.external_control = externalControlEvidence(process.platform, externalControl);
      result.gates.push({ name: 'fresh-external-network-positive-control', status: status(externalControl) });
    } else {
      result.network_isolation.external_control = externalControlEvidence(process.platform);
    }

    child = process.platform === 'darwin'
      ? spawnOwnedServer('/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, nodeOnly, 'workbench/start.mjs'], { cwd: relocated, env: homeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnOwnedServer(nodeOnly, ['workbench/start.mjs'], { cwd: relocated, env: homeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const app = await waitForStartup(child);
    result.network_isolation.loopback = 'Node 22 child fetched local workbench index successfully';
    const localLoopback = runOfflineNode(nodeOnly, ['-e', `const response=await fetch(${JSON.stringify(app.origin)},{headers:{'Sec-Fetch-Site':'none'}});process.exit(response.status===200?0:4)`], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 10000 });
    assertStatus(localLoopback, 0, 'sandboxed Node child must reach loopback server');
    result.gates.push({ name: 'loopback-allowed', status: status(localLoopback) });

    const caps = await api(app.origin, app.token, '/api/capabilities');
    assert.deepEqual(caps.formats, ['csv']);
    const leftFile = path.join(relocated, 'examples/orders/left.csv');
    const rightFile = path.join(relocated, 'examples/orders/right.csv');
    const rulesFile = path.join(relocated, 'examples/orders/rules.json');
    const decisionsFile = path.join(relocated, 'examples/orders/reviewed.csv');
    const leftAsset = await upload(app.origin, app.token, 'csv', leftFile, 'orders-left.csv');
    const rightAsset = await upload(app.origin, app.token, 'csv', rightFile, 'orders-right.csv');
    const leftImport = (await job(app.origin, app.token, await api(app.origin, app.token, '/api/imports', { method: 'POST', body: { asset_id: leftAsset.asset_id, side: 'left' } }))).import;
    const rightImport = (await job(app.origin, app.token, await api(app.origin, app.token, '/api/imports', { method: 'POST', body: { asset_id: rightAsset.asset_id, side: 'right' } }))).import;
    const checked = await job(app.origin, app.token, await api(app.origin, app.token, '/api/config/check', { method: 'POST', body: { left_import_id: leftImport.import_id, right_import_id: rightImport.import_id, config: JSON.parse(await fs.readFile(rulesFile, 'utf8')) } }));
    const compared = await job(app.origin, app.token, await api(app.origin, app.token, '/api/runs', { method: 'POST', body: { left_import_id: leftImport.import_id, right_import_id: rightImport.import_id, config_asset_id: checked.config_asset_id } }));
    const decisionAsset = await upload(app.origin, app.token, 'decisions', decisionsFile, 'reviewed.csv');
    const reviewed = await job(app.origin, app.token, await api(app.origin, app.token, `/api/runs/${compared.revision.revision_id}/reviews`, { method: 'POST', body: { base_revision: compared.revision.revision_id, decisions_asset_id: decisionAsset.asset_id } }));
    const reviewedReport = await api(app.origin, app.token, `/api/runs/${reviewed.revision.revision_id}/export?kind=report`);
    assert.equal(hash(reviewedReport), reviewed.revision.report_sha256);
    result.gates.push({ name: 'upload-import-check-compare-review', status: 0, revision_exit_code: reviewed.revision.exit_code });

    const validatedConfig = await api(app.origin, app.token, `/api/configs/${checked.config_asset_id}/export`);
    const oracle = path.join(temp, 'cli-oracle');
    await fs.mkdir(oracle);
    const configPath = path.join(oracle, 'config.json');
    const decisionsPath = path.join(oracle, 'decisions.csv');
    const comparePath = path.join(oracle, 'compared');
    const resolvePath = path.join(oracle, 'resolved');
    await fs.writeFile(configPath, validatedConfig);
    await fs.copyFile(decisionsFile, decisionsPath);
    const compare = runOfflineNode(nodeOnly, ['cli/main.mjs', 'compare', leftFile, rightFile, '--config', configPath, '--out', comparePath], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 30000 });
    assert.ok([0, 1, 3].includes(status(compare)), `packaged CLI compare failed: ${compare.stderr}`);
    const resolve = runOfflineNode(nodeOnly, ['cli/main.mjs', 'resolve', comparePath, '--decisions', decisionsPath, '--out', resolvePath], { cwd: relocated, env: homeEnv, encoding: 'utf8', timeout: 30000 });
    assert.ok([0, 1, 3].includes(status(resolve)), `packaged CLI resolve failed: ${resolve.stderr}`);
    const cliReport = await fs.readFile(path.join(resolvePath, 'report.json'));
    assert.deepEqual(reviewedReport, cliReport, 'packaged CLI review replay report must be byte-equal to workbench report');
    result.gates.push({ name: 'independent-packaged-cli-report-byte-equality', status: 0, report_sha256: hash(cliReport), cli_compare_status: status(compare), cli_resolve_status: status(resolve) });

    const bundled = await job(app.origin, app.token, await api(app.origin, app.token, `/api/runs/${reviewed.revision.revision_id}/bundle`, { method: 'POST', body: {} }));
    const zipBytes = await api(app.origin, app.token, `/api/bundles/${bundled.bundle_asset_id}/export`);
    const savedBundle = path.join(temp, 'reviewed-run.zip');
    await fs.writeFile(savedBundle, zipBytes);
    await api(app.origin, app.token, '/api/sessions/reset', { method: 'POST', body: { confirm: true } });
    const runAsset = await upload(app.origin, app.token, 'run', savedBundle, 'reviewed-run.zip');
    const restored = await job(app.origin, app.token, await api(app.origin, app.token, '/api/restores', { method: 'POST', body: { asset_id: runAsset.asset_id } }));
    const restoredReport = await api(app.origin, app.token, `/api/runs/${restored.revision.revision_id}/export?kind=report`);
    assert.deepEqual(restoredReport, reviewedReport, 'restored ZIP replay must preserve report bytes');
    result.gates.push({ name: 'zip-save-reset-restore-replay', status: 0, restored_report_sha256: hash(restoredReport), zip_sha256: hash(zipBytes) });

    result.gates.push({ name: 'workbench-worker-process', status: 0, evidence: 'import/check/compare/review/bundle/restore jobs completed with only Node on PATH' });
  } catch (error) {
    failure = error;
  } finally {
    if (child) {
      try { result.shutdown = await stopAndVerify(child, sessionParent); }
      catch (error) { result.shutdown = error.shutdown; failure ??= error; }
    }
    try { await fs.rm(temp, { recursive: true, force: true }); }
    catch (error) { failure ??= error; }
  }
  if (failure) { failure.validation = result; throw failure; }
  assert.deepEqual(gitIdentity(ROOT, true), identity, 'source identity changed during package validation');
  await verifyPackage(ROOT, PACKAGE_DIR);
  await verifySourceAtHead(ROOT, provenance.source_inputs);
  assert.equal(hash(await fs.readFile(ZIP_PATH)), result.archive_sha256, 'archive bytes changed during package validation');
  result.status = 'passed';
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`validation artifact: ${EVIDENCE_PATH}\n`);
}

function assertSupportedRunner() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) throw new Error(`package validation must run on Node.js 22; received ${process.version}`);
  if (process.platform === 'darwin') return;
  if (process.platform === 'linux' && process.env.MOONRECONCILE_NETWORK_ISOLATED === '1') return;
  throw new Error('Use macOS sandbox-exec or the Linux unshare --net wrapper; never run the package gate without verified network isolation.');
}

main().catch(async (error) => {
  const failed = { ...error.validation, created_at: new Date().toISOString(), status: 'failed', error: error.message };
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(failed, null, 2)}\n`);
  process.stderr.write(`package validation failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
