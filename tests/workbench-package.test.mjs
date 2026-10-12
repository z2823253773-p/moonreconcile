import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, lstat, rm, copyFile, chmod, mkdir, rename, cp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { assertSupportedNodeVersion } from '../workbench/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temp;
let packageRoot;
let generated;
let archive;
let nodeBinary;
let nodeOnlyPath;

before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'moonreconcile-package-tests-'));
  generated = path.join(temp, 'generated', 'moonreconcile-workbench-0.2.0');
  archive = path.join(temp, 'generated', 'moonreconcile-workbench-0.2.0.zip');
  const build = spawnSync(process.execPath, ['scripts/package-workbench.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MOONRECONCILE_PACKAGE_DIR: generated, MOONRECONCILE_PACKAGE_ZIP: archive },
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  packageRoot = path.join(temp, 'relocated', 'moonreconcile-workbench-0.2.0');
  await cp(generated, packageRoot, { recursive: true });
  nodeBinary = process.env.MOONRECONCILE_NODE_BINARY ?? process.env.MOONRECONCILE_NODE22;
  if (!nodeBinary && Number(process.versions.node.split('.')[0]) === 22) nodeBinary = process.execPath;
  assert.ok(nodeBinary, 'set MOONRECONCILE_NODE_BINARY to the actual Node 22 runtime');
  const version = spawnSync(nodeBinary, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(Number(version.stdout.trim().replace(/^v/, '').split('.')[0]), 22, `package tests require the actual Node 22 runtime, got ${version.stdout}`);
  nodeOnlyPath = path.join(temp, 'bin');
  await mkdir(nodeOnlyPath);
  await copyFile(nodeBinary, path.join(nodeOnlyPath, 'node'));
  await chmod(path.join(nodeOnlyPath, 'node'), 0o755);
});

after(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('builder_refuses_to_overwrite_existing_custom_outputs', async () => {
  const sentinel = path.join(generated, 'keep-me.txt');
  await writeFile(sentinel, 'foreign data\n');
  const secondBuild = spawnSync(process.execPath, ['scripts/package-workbench.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MOONRECONCILE_PACKAGE_DIR: generated, MOONRECONCILE_PACKAGE_ZIP: archive },
  });
  assert.notEqual(secondBuild.status, 0, `${secondBuild.stdout}\n${secondBuild.stderr}`);
  assert.equal(await readFile(sentinel, 'utf8'), 'foreign data\n');
});

async function packageJson() {
  return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
}

test('package_runs_without_moon_or_install', async (t) => {
  const testHome = path.join(temp, 'node-only-test');
  const nodeOnly = path.join(testHome, 'bin');
  await mkdir(testHome, { recursive: true });
  await mkdir(nodeOnly);
  await copyFile(nodeBinary, path.join(nodeOnly, 'node'));
  await chmod(path.join(nodeOnly, 'node'), 0o755);
  const pkg = await packageJson();
  const cli = spawnSync(path.join(nodeOnly, 'node'), ['cli/main.mjs', '--version'], {
    cwd: packageRoot,
    env: { PATH: nodeOnly, HOME: testHome, TMPDIR: testHome },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /0\.1\.0/);
  assert.equal(pkg.scripts?.install, undefined);
  assert.equal(pkg.scripts?.prestart, undefined);
  assert.equal(pkg.scripts?.start, 'node workbench/start.mjs');
  assert.equal((await readdir(nodeOnly)).join(','), 'node');
});

test('relocated_bridge_equals_checkout', async (t) => {
  const bridge = path.join(packageRoot, 'runtime/bridge.js');
  const out = spawnSync(nodeBinary, ['cli/main.mjs', 'check-config', 'examples/orders/rules.json'], {
    cwd: packageRoot,
    env: { PATH: nodeOnlyPath, HOME: temp, TMPDIR: temp },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.ok((await readFile(bridge)).length > 0);
  assert.equal(out.stderr, '');
  const checkout = spawnSync(process.execPath, ['cli/main.mjs', 'check-config', 'examples/orders/rules.json'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(checkout.status, 0, checkout.stderr);
  assert.equal(out.stdout, checkout.stdout);
  const devBridge = path.join(root, '_build/js/debug/build/cmd/bridge/bridge.js');
  assert.equal(
    await import('node:crypto').then(async ({ createHash }) => createHash('sha256').update(await readFile(bridge)).digest('hex')),
    await import('node:crypto').then(async ({ createHash }) => createHash('sha256').update(await readFile(devBridge)).digest('hex')),
  );

  const missing = path.join(packageRoot, 'runtime/missing-bridge.js');
  const fakeDev = path.join(path.dirname(packageRoot), '_build/js/debug/build/cmd/bridge/bridge.js');
  await rename(bridge, missing);
  try {
    for (const args of [['--input-type=module', '-e', "await import('./cli/bridge.mjs')"], ['cli/main.mjs', '--help'], ['cli/main.mjs', '--version']]) {
      const harmless = spawnSync(nodeBinary, args, { cwd: packageRoot, env: { PATH: nodeOnlyPath, HOME: temp, TMPDIR: temp }, encoding: 'utf8', timeout: 15000 });
      assert.equal(harmless.status, 0, harmless.stderr);
    }
    await mkdir(path.dirname(fakeDev), { recursive: true });
    await writeFile(fakeDev, 'export function invoke_bridge(){return "{}";}\n');
    const invalid = spawnSync(nodeBinary, ['cli/main.mjs', 'check-config', 'examples/orders/rules.json'], {
      cwd: packageRoot,
      env: { PATH: nodeOnlyPath, HOME: temp, TMPDIR: temp },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /runtime\/bridge\.js/);
  } finally {
    await rename(missing, bridge);
  }
});

test('package_contains_only_runtime_deps_and_licenses', async () => {
  const pkg = await packageJson();
  const entries = await readdir(packageRoot);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['buffer-crc32', 'saxes', 'yauzl', 'yazl']);
  assert.equal(pkg.devDependencies, undefined);
  assert.ok(entries.includes('LICENSE'));
  assert.ok(entries.includes('THIRD-PARTY-NOTICES'));
  const notices = await readFile(path.join(packageRoot, 'THIRD-PARTY-NOTICES'), 'utf8');
  assert.match(notices, /Apache License, Version 2\.0/);
  for (const dependency of ['buffer-crc32@1.0.0', 'yauzl@3.4.0', 'yazl@3.3.1', 'pend@1.2.0', 'saxes@6.0.0', 'xmlchars@2.2.0']) assert.ok(notices.includes(dependency), `missing notice for ${dependency}`);
  assert.ok(notices.includes('Three-Clause BSD License') || notices.includes('Permission is hereby granted, free of charge'), 'saxes license supplement must preserve its complete official text');
  assert.ok(notices.includes(await readFile(path.join(root, 'docs/licenses/saxes-6.0.0-LICENSE.txt'), 'utf8')), 'saxes license supplement must be included verbatim');
  assert.ok(entries.includes('package-lock.json'));
  assert.ok(entries.includes('runtime'));
  assert.ok(entries.includes('cli'));
  assert.ok(entries.includes('workbench'));
  assert.ok(entries.includes('examples'));
  assert.ok(!entries.includes('tests'));
  assert.ok(!entries.includes('_build'));
  assert.ok(!entries.includes('playwright.config.mjs'));
  for (const entry of entries) {
    const stat = await lstat(path.join(packageRoot, entry));
    assert.ok(!stat.isSymbolicLink(), `${entry} must not be a symlink`);
  }
  const lock = JSON.parse(await readFile(path.join(packageRoot, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(name => name.startsWith('node_modules/')).sort(), [
    'node_modules/buffer-crc32', 'node_modules/pend', 'node_modules/saxes',
    'node_modules/xmlchars', 'node_modules/yauzl', 'node_modules/yazl',
  ]);
  assert.equal(lock.packages['node_modules/saxes'].version, '6.0.0');
  assert.equal(lock.packages['node_modules/xmlchars'].version, '2.2.0');
  for (const name of Object.keys(lock.packages ?? {})) {
    assert.ok(!name.includes('/@playwright/'), `unexpected browser dependency ${name}`);
    assert.ok(!name.includes('/playwright'), `unexpected browser dependency ${name}`);
  }
  assert.doesNotMatch(await readFile(path.join(packageRoot, 'START-HERE.md'), 'utf8'), /\/Users\/|node_modules\/|_build/);
});

test('workbench_start_guide_links_resolve_in_checkout_and_package', async () => {
  const rootReadme = await readFile(path.join(root, 'README.md'), 'utf8');
  const startLinks = [...rootReadme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]).filter((href) => !/^https?:/.test(href));
  for (const href of startLinks) await readFile(path.resolve(root, href));

  const sourceGuide = await readFile(path.join(root, 'docs/workbench-start-here.md'), 'utf8');
  const packageGuide = await readFile(path.join(packageRoot, 'START-HERE.md'), 'utf8');
  for (const [text, base] of [[sourceGuide, path.join(root, 'docs')], [packageGuide, packageRoot]]) {
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const href of links) await readFile(path.resolve(base, href));
  }
});

test('runtime rejects Node versions below 22 clearly', async () => {
  assert.throws(() => assertSupportedNodeVersion('21.99.0'), /Node\.js 22 or newer/);
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.0.0'));
});
