import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { assertXlsxCapabilities, genuineXlsxInputs } from '../scripts/workbench-package-xlsx.mjs';
import { packageContract, thirdPartyNotices, verifyPackage } from '../scripts/workbench-package-provenance.mjs';

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
  for (const relative of ['scripts/workbench-package-provenance.mjs', 'scripts/workbench-package-lifecycle.mjs', 'scripts/workbench-package-network.mjs', 'scripts/workbench-package-xlsx.mjs', 'docs/licenses/saxes-6.0.0-LICENSE.txt']) {
    try {
      await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await fs.copyFile(path.join(root, relative), path.join(directory, relative));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await fs.cp(path.join(root, 'workbench/xlsx'), path.join(directory, 'workbench/xlsx'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
  console.log(JSON.stringify({ fixture: path.basename(directory), checker_exit: exit, timed_out: timedOut, status: record.status, source_sha: record.source_sha, package_source_sha: record.package_source_sha, archive_sha256: record.archive_sha256, bridge_sha256: record.bridge_sha256, network_isolation: record.network_isolation, shutdown: record.shutdown, xlsx_gate: record.gates?.find(gate => gate.name === 'genuine-mixed-xlsx-regeneration-cli-formula-retention') }));
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
  assert.ok(result.record.gates.some(gate => gate.name === 'genuine-mixed-xlsx-regeneration-cli-formula-retention' && gate.status === 0));
  assert.equal(result.record.gates.find(gate => gate.name === 'genuine-mixed-xlsx-regeneration-cli-formula-retention').materials, 16);
  assert.equal(result.record.shutdown.graceful, true);
  assert.equal(result.record.shutdown.forced, false);
  assert.equal(result.record.shutdown.exit_code, 0);
  assert.deepEqual(result.record.shutdown.remaining_sessions, []);
});

test('strict XLSX capabilities reject partial formats, version and limit drift', () => {
  const caps = { formats: ['csv','xlsx'], app_version: '0.2.0', api_version: 1, engine_version: '0.1.0', xlsx_api_version: 1, import_profile_schema_version: 1, xlsx_limits: { compressed_bytes: 67108864, entries: 2048, actual_unzip_bytes: 268435456, xml_bytes: 67108864, xml_depth: 64, cell_bytes: 65536, csv_bytes: 67108864, data_rows: 100000, columns: 256 } };
  assertXlsxCapabilities(caps);
  for (const field of ['app_version','api_version','engine_version','xlsx_api_version','import_profile_schema_version']) {
    assert.throws(() => assertXlsxCapabilities({ ...caps, [field]: 99 }));
  }
  assert.throws(() => assertXlsxCapabilities({ ...caps, formats: ['csv'] }));
  assert.throws(() => assertXlsxCapabilities({ ...caps, xlsx_limits: { ...caps.xlsx_limits, extra: 1 } }));
  assert.throws(() => assertXlsxCapabilities({ ...caps, xlsx_limits: { ...caps.xlsx_limits, cell_bytes: 65537 } }));
});

test('strict genuine XLSX inputs require pinned bytes committed at HEAD', async () => {
  const directory = await fixture('genuine-input-drift');
  assert.equal((await genuineXlsxInputs(directory)).expected.stored.date_system, '1904');
  const input = path.join(directory, 'tests/fixtures/xlsx/lo-conversion-1904.xlsx');
  await fs.appendFile(input, 'changed');
  await assert.rejects(genuineXlsxInputs(directory), /differs from claimed HEAD/);
  commit(directory);
  await assert.rejects(genuineXlsxInputs(directory), /pinned genuine fixture changed/);
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

test('package contract rejects saxes and xmlchars lock drift', async () => {
  const directory = await fixture('xml-dependency-lock-drift');
  const lockPath = path.join(directory, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.packages['node_modules/saxes'].integrity = 'sha512-tampered';
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(packageContract(directory), /locked candidate integrity drift: saxes/);

  lock.packages['node_modules/saxes'].integrity = 'sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==';
  lock.packages['node_modules/xmlchars'].version = '2.3.0';
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(packageContract(directory), /locked transitive dependency drift: xmlchars/);
});

test('package contract pins every direct and transitive production artifact', async () => {
  const directory = await fixture('all-production-artifact-lock-drift');
  const lockPath = path.join(directory, 'package-lock.json');
  const baseline = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  for (const name of ['buffer-crc32','saxes','yauzl','yazl','xmlchars','pend']) {
    const lock = structuredClone(baseline);
    lock.packages[`node_modules/${name}`].integrity = 'sha512-tampered';
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(packageContract(directory), new RegExp(`locked candidate integrity drift: ${name}`));
  }
});

test('package contract freezes the exact production graph and edge declarations', async () => {
  const directory = await fixture('production-graph-drift');
  const lockPath = path.join(directory, 'package-lock.json');
  const baseline = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const approved = ['buffer-crc32', 'pend', 'saxes', 'xmlchars', 'yauzl', 'yazl'];
  const contract = await packageContract(directory);
  assert.deepEqual(Object.keys(contract.lock.packages).filter(Boolean).map((key) => key.slice(13)).sort(), approved);
  const mutations = {
    'extra transitive': (lock) => { lock.packages['node_modules/yauzl'].dependencies.extra = '1.0.0'; lock.packages['node_modules/extra'] = { version: '1.0.0' }; },
    'removed edge and entry': (lock) => { delete lock.packages['node_modules/saxes'].dependencies.xmlchars; delete lock.packages['node_modules/xmlchars']; },
    'missing transitive': (lock) => { delete lock.packages['node_modules/pend']; },
    'changed edge': (lock) => { lock.packages['node_modules/saxes'].dependencies = { pend: '^2.2.0' }; },
    'changed range': (lock) => { lock.packages['node_modules/saxes'].dependencies.xmlchars = '~2.2.0'; },
    'optional edge': (lock) => { lock.packages['node_modules/saxes'].optionalDependencies = { extra: '1.0.0' }; },
    'peer edge': (lock) => { lock.packages['node_modules/saxes'].peerDependencies = { extra: '1.0.0' }; },
    'nested shadow': (lock) => { lock.packages['node_modules/saxes/node_modules/xmlchars'] = { ...lock.packages['node_modules/xmlchars'] }; },
    'alias range': (lock) => { lock.packages['node_modules/saxes'].dependencies.xmlchars = 'npm:xmlchars@2.2.0'; },
    'root optional': (lock) => { lock.packages[''].optionalDependencies = { extra: '1.0.0' }; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const lock = structuredClone(baseline);
    mutate(lock);
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(packageContract(directory), /production|locked dependency/, label);
    console.log(JSON.stringify({ graph_mutation: label, rejected: true }));
  }
  // The checkout's separate development closure remains permitted.
  baseline.packages['node_modules/development-only-extra'] = { version: '1.0.0', dev: true };
  await fs.writeFile(lockPath, `${JSON.stringify(baseline, null, 2)}\n`);
  assert.deepEqual((await packageContract(directory)).lock, contract.lock);
});

test('package contract rejects manifest drift and provenance rejects changed XLSX source modules', async () => {
  const directory = await fixture('manifest-and-xlsx-module-drift');
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dependencies.saxes = '6.0.1';
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(packageContract(directory), /audit changed production dependency contract/);

  const tampered = path.join(owned, 'tampered-package');
  await fs.cp(originalPackage, tampered, { recursive: true });
  const parser = path.join(tampered, 'workbench/xlsx/package.mjs');
  await fs.appendFile(parser, '\n// altered package module\n');
  await assert.rejects(verifyPackage(root, tampered), /package files differ from provenance/);
});

test('package contract rejects pend version drift', async () => {
  const directory = await fixture('pend-version-drift');
  const lockPath = path.join(directory, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.packages['node_modules/pend'].version = '1.3.0';
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(packageContract(directory), /locked transitive dependency drift: pend/);
});

test('offline saxes notice supplement rejects missing or altered license source', async () => {
  const directory = await fixture('xml-license-source-drift');
  const contract = await packageContract(root);
  const sourceLicense = path.join(directory, 'docs/licenses/saxes-6.0.0-LICENSE.txt');
  await fs.rm(sourceLicense);
  await assert.rejects(thirdPartyNotices(root, contract.lock, directory));

  await fs.copyFile(path.join(root, 'docs/licenses/saxes-6.0.0-LICENSE.txt'), sourceLicense);
  await fs.appendFile(sourceLicense, 'changed\n');
  await assert.rejects(thirdPartyNotices(root, contract.lock, directory), /saxes v6\.0\.0 supplemental license source hash changed/);
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
