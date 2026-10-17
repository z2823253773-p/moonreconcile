import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_RELATIVE = '_build/js/debug/build/cmd/bridge/bridge.js';
export const BUILD_PROVENANCE = '_build/js/debug/build/cmd/bridge/bridge.provenance.json';
export const PACKAGE_PROVENANCE = 'PACKAGE-PROVENANCE.json';
export const VERSION = '0.2.0';
export const EXPECTED = { 'buffer-crc32': '1.0.0', saxes: '6.0.0', yauzl: '3.4.0', yazl: '3.3.1' };
export const PINNED_TRANSITIVE = { xmlchars: '2.2.0', pend: '1.2.0' };
export const PINNED_OVERRIDES = { xmlchars: '2.2.0' };
const PRODUCTION_EDGES = {
  'buffer-crc32': {}, saxes: { xmlchars: '^2.2.0' }, yauzl: { pend: '~1.2.0' },
  yazl: { 'buffer-crc32': '^1.0.0' }, xmlchars: {}, pend: {},
};
export const PINNED_ARTIFACTS = {
  'buffer-crc32': { version: '1.0.0', integrity: 'sha512-Db1SbgBS/fg/392AblrMJk97KggmvYhr4pB5ZIMTWtaivCPMWLkmb7m21cJvpvgK+J3nsU2CmmixNBZx4vFj/w==' },
  saxes: { version: '6.0.0', integrity: 'sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==' },
  yauzl: { version: '3.4.0', integrity: 'sha512-jIH9yLR9wqr0wOS0TpBvo/g/2UgZH5qePVbjgRliiF0BYvOZyaBknKsF+x9Iht0O6sqgnB93rCICdOZFecJuDw==' },
  yazl: { version: '3.3.1', integrity: 'sha512-BbETDVWG+VcMUle37k5Fqp//7SDOK2/1+T7X8TD96M3D9G8jK5VLUdQVdVjGi8im7FGkazX7kk5hkU8X4L5Bng==' },
  xmlchars: { version: '2.2.0', integrity: 'sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==' },
  pend: { version: '1.2.0', integrity: 'sha512-F3asv42UuXchdzt+xXqfW1OGlVBe+mxa2mqI0pg5yAHZPvFmY3Y6drSf/GQ1A86WgWEN9Kzh/WrgKa6iGcHXLg==' },
};
export const SAXES_LICENSE = {
  relativePath: 'docs/licenses/saxes-6.0.0-LICENSE.txt',
  sha256: '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e',
};
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

export function gitIdentity(root, requireClean = false) {
  const git = (args) => {
    const result = spawnSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `Git identity check failed: ${result.stderr ?? result.error?.message}`);
    return result.stdout.trim();
  };
  const sha = git(['rev-parse', 'HEAD']);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const clean = git(['status', '--porcelain']).length === 0;
  if (requireClean) assert.ok(clean, 'strict package validation requires a clean source worktree');
  return { source_sha: sha, source_worktree_clean: clean };
}

export async function verifySourceAtHead(root, inputs) {
  const tree = spawnSync('git', ['-c', `safe.directory=${root}`, 'ls-tree', '-rz', '--full-tree', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(tree.status, 0, `Git source tree check failed: ${tree.stderr ?? tree.error?.message}`);
  const committed = new Map(tree.stdout.split('\0').filter(Boolean).map((entry) => {
    const [metadata, name] = entry.split('\t');
    return [name, metadata.split(' ')[2]];
  }));
  for (const name of Object.keys(inputs)) {
    const oid = committed.get(name);
    assert.ok(oid, `package source input is absent from claimed HEAD: ${name}`);
    const bytes = await fs.readFile(path.join(root, name));
    const actual = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(actual, oid, `package source input differs from claimed HEAD: ${name}`);
  }
}

// Paths in every provenance record are relative logical names. No developer
// home, environment, session path or token is serialized into the package.
export async function files(root, relative = '', exclude = new Set()) {
  const output = {};
  const walk = async (name) => {
    if (exclude.has(name)) return;
    const location = path.join(root, name);
    const stat = await fs.lstat(location);
    assert.ok(!stat.isSymbolicLink(), `provenance refuses symlink: ${name}`);
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(location)).sort()) await walk(path.posix.join(name, child));
    } else {
      assert.ok(stat.isFile(), `provenance refuses non-file: ${name}`);
      output[name] = digest(await fs.readFile(location));
    }
  };
  await walk(relative);
  return output;
}

async function namedFiles(root, names) {
  const result = {};
  for (const name of [...names].sort()) Object.assign(result, await files(root, name));
  return result;
}

export async function buildInputs(root) {
  const names = (await fs.readdir(root)).filter((name) => /\.mbt$|\.mbti$|^moon\.(mod|pkg)(\.json)?$/.test(name));
  return namedFiles(root, [...names, 'cmd', 'scripts/build.mjs', 'scripts/workbench-package-provenance.mjs']);
}

export async function sourceInputs(root) {
  return { ...await buildInputs(root), ...await namedFiles(root, [
    'cli', 'workbench', 'examples', 'package.json', 'package-lock.json', 'LICENSE',
    SAXES_LICENSE.relativePath,
    'docs/workbench.md', 'docs/limitations.md', 'docs/workbench-start-here.md',
    'scripts/package-workbench.mjs', 'scripts/check-workbench-package.mjs',
    'scripts/workbench-package-lifecycle.mjs', 'scripts/workbench-package-network.mjs',
  ]) };
}

export function toolchainHome() {
  let home = process.env.MOONBIT_HOME ?? process.env.MOON_HOME;
  if (!home) {
    const moon = spawnSync('which', ['moon'], { encoding: 'utf8' });
    if (moon.status === 0) home = path.dirname(path.dirname(moon.stdout.trim()));
  }
  assert.ok(home && path.isAbsolute(home), 'set process-scoped MOONBIT_HOME or MOON_HOME to an absolute toolchain path');
  return home;
}

export async function toolchainInputs() {
  const home = toolchainHome();
  const result = await namedFiles(home, ['bin/moon', 'bin/moonc']);
  const walk = async (relative) => {
    for (const entry of (await fs.readdir(path.join(home, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      // Core's JS precompiled interfaces/objects are compilation inputs too.
      // Its databases, locks, docs and other target caches are not stable inputs.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || (relative.endsWith('/_build') && entry.name !== 'js')) continue;
        await walk(name);
      } else if (/\.(mbt|mbti|mi|core)$|(^|\/)moon\.(mod|pkg)(\.json)?$|^lib\/core\/(LICENSE|NOTICE)$/.test(name)) {
        Object.assign(result, await files(home, name));
      }
    }
  };
  await walk('lib/core');
  return result;
}

export async function verifyBridge(root) {
  const record = await json(path.join(root, BUILD_PROVENANCE));
  assert.equal(record.schema_version, 1, 'unsupported bridge provenance');
  assert.deepEqual(await buildInputs(root), record.build_inputs, 'compiled bridge source/build inputs changed; rebuild before packaging');
  assert.deepEqual(await toolchainInputs(), record.toolchain_inputs, 'compiled bridge toolchain inputs changed; rebuild before packaging');
  assert.equal(digest(await fs.readFile(path.join(root, BRIDGE_RELATIVE))), record.bridge_sha256, 'compiled bridge bytes differ from build provenance');
  return record;
}

export async function packageContract(root) {
  const manifest = await json(path.join(root, 'package.json'));
  const rootLock = await json(path.join(root, 'package-lock.json'));
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.dependencies, EXPECTED, 'audit changed production dependency contract before packaging');
  assert.deepEqual(manifest.overrides, PINNED_OVERRIDES, 'audit changed the exact XML parser transitive pin');
  assert.deepEqual(rootLock.packages?.['']?.dependencies, EXPECTED, 'lockfile root dependencies differ from manifest');
  const rejectAlternateEdges = (entry, name) => {
    for (const key of ['optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies']) {
      assert.ok(!Object.hasOwn(entry, key), `unreviewed production dependency declaration: ${name}.${key}`);
    }
  };
  rejectAlternateEdges(manifest, 'manifest');
  rejectAlternateEdges(rootLock.packages[''], 'lock root');
  for (const name of Object.keys(PRODUCTION_EDGES)) {
    assert.ok(!Object.keys(rootLock.packages).some((key) => key.startsWith(`node_modules/${name}/node_modules/`)), `nested production dependency shadows frozen closure: ${name}`);
  }
  const dependencies = { ...EXPECTED };
  const packages = { '': { name: 'moonreconcile-workbench', version: VERSION, dependencies, engines: { node: '>=22' } } };
  const visit = (name) => {
    assert.ok(Object.hasOwn(PRODUCTION_EDGES, name), `unreviewed production dependency: ${name}`);
    const key = `node_modules/${name}`;
    if (packages[key]) return;
    const entry = rootLock.packages?.[key];
    assert.ok(entry, `missing locked dependency: ${name}`);
    rejectAlternateEdges(entry, name);
    assert.deepEqual(entry.dependencies ?? {}, PRODUCTION_EDGES[name], `production dependency edges drift: ${name}`);
    assert.ok(!entry.link && !entry.dev && !entry.optional && !entry.inBundle, `non-production locked dependency: ${name}`);
    assert.ok(!Object.hasOwn(entry, 'name') || entry.name === name, `aliased production dependency: ${name}`);
    if (dependencies[name]) assert.equal(entry.version, dependencies[name]);
    if (PINNED_TRANSITIVE[name]) assert.equal(entry.version, PINNED_TRANSITIVE[name], `locked transitive dependency drift: ${name}`);
    if (PINNED_ARTIFACTS[name]) {
      assert.equal(entry.version, PINNED_ARTIFACTS[name].version, `locked candidate version drift: ${name}`);
      assert.equal(entry.integrity, PINNED_ARTIFACTS[name].integrity, `locked candidate integrity drift: ${name}`);
    }
    packages[key] = entry;
    Object.keys(entry.dependencies ?? {}).forEach(visit);
  };
  Object.keys(dependencies).forEach(visit);
  assert.deepEqual(Object.keys(packages).filter(Boolean).sort(), Object.keys(PRODUCTION_EDGES).map((name) => `node_modules/${name}`).sort(), 'production dependency closure differs from frozen six packages');
  return {
    manifest: { name: 'moonreconcile-workbench', version: VERSION, private: true, type: 'module', engines: { node: '>=22' }, scripts: { start: 'node workbench/start.mjs' }, bin: { reconcile: './cli/main.mjs' }, dependencies },
    lock: { name: 'moonreconcile-workbench', version: VERSION, lockfileVersion: 3, requires: true, packages },
  };
}

export function packageGuide(source) {
  return source.replace('](workbench.md)', '](docs/workbench.md)').replace('](../cli/main.mjs)', '](cli/main.mjs)').replace('](limitations.md)', '](docs/limitations.md)');
}

export async function thirdPartyNotices(packageRoot, lock, sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const core = path.join(toolchainHome(), 'lib/core');
  const sections = ['# Third-party notices', '', 'The compiled MoonBit bridge contains MoonBit core runtime code.', 'MoonBit core is licensed under Apache License 2.0; its source NOTICE is included verbatim below.', '', '## MoonBit core LICENSE', '', await fs.readFile(path.join(core, 'LICENSE'), 'utf8'), '', '## MoonBit core NOTICE', '', await fs.readFile(path.join(core, 'NOTICE'), 'utf8')];
  for (const key of Object.keys(lock.packages).filter(Boolean).sort()) {
    const name = key.slice('node_modules/'.length);
    const directory = path.join(packageRoot, key);
    const metadata = await json(path.join(directory, 'package.json'));
    assert.equal(metadata.version, lock.packages[key].version, `installed dependency version: ${name}`);
    let text;
    let preservedSupplement = false;
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
      try { text = await fs.readFile(path.join(directory, file), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!text && name === 'saxes' && metadata.version === '6.0.0') {
      const supplemental = await fs.readFile(path.join(sourceRoot, SAXES_LICENSE.relativePath));
      assert.equal(digest(supplemental), SAXES_LICENSE.sha256, 'saxes v6.0.0 supplemental license source hash changed');
      text = supplemental.toString('utf8');
      preservedSupplement = true;
    }
    assert.ok(text, `license text missing from production dependency: ${name}`);
    const license = typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license);
    sections.push('', `## ${name}@${metadata.version} (${license})`, '', preservedSupplement ? text : text.trimEnd());
  }
  return `${sections.join('\n')}\n`;
}

export async function writePackageProvenance(root, packageRoot, inputs, bridge) {
  assert.deepEqual(await sourceInputs(root), inputs, 'source inputs changed while packaging');
  const record = { schema_version: 1, ...gitIdentity(root), source_inputs: inputs, bridge, files: await files(packageRoot) };
  await fs.writeFile(path.join(packageRoot, PACKAGE_PROVENANCE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function verifyPackage(root, packageRoot) {
  const record = await json(path.join(packageRoot, PACKAGE_PROVENANCE));
  assert.equal(record.schema_version, 1, 'unsupported package provenance');
  assert.deepEqual(await sourceInputs(root), record.source_inputs, 'package provenance source inputs differ from current source');
  const bridge = await verifyBridge(root);
  assert.deepEqual(record.bridge, bridge, 'package bridge provenance differs from current build');
  assert.deepEqual(await files(packageRoot, '', new Set([PACKAGE_PROVENANCE])), record.files, 'package files differ from provenance');
  assert.equal(record.files['runtime/bridge.js'], bridge.bridge_sha256);
  for (const [name, expected] of Object.entries(record.source_inputs)) {
    if (/^(cli|workbench|examples)\//.test(name) || ['LICENSE', 'docs/workbench.md', 'docs/limitations.md'].includes(name)) {
      assert.equal(record.files[name], expected, `shipped source differs: ${name}`);
    }
  }
  const contract = await packageContract(root);
  for (const [name, expected] of [['package.json', contract.manifest], ['package-lock.json', contract.lock]]) {
    assert.equal(await fs.readFile(path.join(packageRoot, name), 'utf8'), `${JSON.stringify(expected, null, 2)}\n`, `generated ${name} differs from current authoritative inputs`);
  }
  const guide = packageGuide(await fs.readFile(path.join(root, 'docs/workbench-start-here.md'), 'utf8'));
  for (const name of ['START-HERE.md', 'README.md']) assert.equal(await fs.readFile(path.join(packageRoot, name), 'utf8'), guide);
  assert.equal(await fs.readFile(path.join(packageRoot, 'THIRD-PARTY-NOTICES'), 'utf8'), await thirdPartyNotices(packageRoot, contract.lock, root), 'license notices differ from current authoritative inputs');
  return record;
}
