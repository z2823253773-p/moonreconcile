#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import { BRIDGE_RELATIVE, verifyBridge, sourceInputs, packageContract, packageGuide, thirdPartyNotices, writePackageProvenance } from './workbench-package-provenance.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const VERSION = '0.2.0';
const NAME = `moonreconcile-workbench-${VERSION}`;
const DEFAULT_DIST = path.join(ROOT, 'dist');
const OUTPUT = path.resolve(process.env.MOONRECONCILE_PACKAGE_DIR ?? path.join(DEFAULT_DIST, NAME));
const ZIP_PATH = path.resolve(process.env.MOONRECONCILE_PACKAGE_ZIP ?? path.join(path.dirname(OUTPUT), `${path.basename(OUTPUT)}.zip`));
const DIST = path.dirname(OUTPUT);
const OWNER_FILE = path.join(DIST, `.${NAME}.owner.json`);

function fail(message) {
  throw new Error(message);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch { return false; }
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`refusing to write through a non-directory or symlink: ${directory}`);
}

async function copyTree(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`refusing to package symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await copyTree(path.join(source, entry.name), path.join(target, entry.name));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } else {
    fail(`refusing to package non-file entry: ${source}`);
  }
}

async function makeZip() {
  const zip = new yazl.ZipFile();
  const add = async (directory, relative = '') => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const name = path.posix.join(NAME, relative, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail(`refusing to zip symlink: ${file}`);
      if (entry.isDirectory()) await add(file, path.posix.join(relative, entry.name));
      else if (entry.isFile()) zip.addFile(file, name);
    }
  };
  await add(OUTPUT);
  await fs.mkdir(DIST, { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(ZIP_PATH, { flags: 'wx', mode: 0o600 });
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.on('error', reject).pipe(output);
    zip.end();
  });
}

async function main() {
  const bridgePath = path.join(ROOT, BRIDGE_RELATIVE);
  if (!await exists(bridgePath)) fail(`compiled bridge missing at ${bridgePath}; build it before packaging`);
  const buildRecord = await verifyBridge(ROOT);
  const inputs = await sourceInputs(ROOT);
  const contract = await packageContract(ROOT);
  const defaultOutput = path.join(DEFAULT_DIST, NAME);
  const defaultZip = path.join(DEFAULT_DIST, `${NAME}.zip`);
  const insideRoot = (candidate) => candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`);
  const insideTemp = (candidate) => {
    const relative = path.relative(path.resolve(os.tmpdir()), candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (insideRoot(OUTPUT) && OUTPUT !== defaultOutput) fail(`in-checkout package output is restricted to ${defaultOutput}`);
  if (insideRoot(ZIP_PATH) && ZIP_PATH !== defaultZip) fail(`in-checkout archive output is restricted to ${defaultZip}`);
  if (!insideRoot(OUTPUT) && !insideTemp(OUTPUT)) fail(`custom package output must be in the system temp directory: ${OUTPUT}`);
  if (!insideRoot(ZIP_PATH) && !insideTemp(ZIP_PATH)) fail(`custom archive output must be in the system temp directory: ${ZIP_PATH}`);
  if (ZIP_PATH === OUTPUT || ZIP_PATH.startsWith(`${OUTPUT}${path.sep}`) || OUTPUT.startsWith(`${ZIP_PATH}${path.sep}`)) fail('package and archive paths must not overlap');
  const ownerRecord = { name: NAME, output: OUTPUT, archive: ZIP_PATH, generated_by: 'scripts/package-workbench.mjs' };
  const outputExists = await exists(OUTPUT), archiveExists = await exists(ZIP_PATH), ownerExists = await exists(OWNER_FILE);
  const isDefaultArtifact = OUTPUT === defaultOutput && ZIP_PATH === defaultZip;
  await ensureDirectory(DIST);
  if (!isDefaultArtifact) {
    if (outputExists || archiveExists || ownerExists) {
      fail(`refusing to overwrite existing custom output paths; choose a new staging directory: ${OUTPUT}`);
    }
  } else {
    if (ownerExists) {
      if ((await fs.lstat(OWNER_FILE)).isSymbolicLink()) fail(`refusing to read ownership marker symlink: ${OWNER_FILE}`);
      const owner = JSON.parse(await fs.readFile(OWNER_FILE, 'utf8'));
      if (JSON.stringify(owner) !== JSON.stringify(ownerRecord)) fail(`output ownership marker does not match these paths: ${OWNER_FILE}`);
    } else {
      if (outputExists || archiveExists) fail('refusing to overwrite an existing package or archive without its matching ownership marker');
      await fs.writeFile(OWNER_FILE, `${JSON.stringify(ownerRecord, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  const bridge = await fs.readFile(bridgePath);
  if (!bridge.length) fail(`compiled bridge is empty: ${bridgePath}`);
  const { dependencies } = contract.manifest;

  if (isDefaultArtifact) {
    await fs.rm(OUTPUT, { recursive: true, force: true });
    await fs.rm(ZIP_PATH, { force: true });
  }
  await fs.mkdir(OUTPUT, { recursive: true });
  const packageManifest = contract.manifest;
  const lock = contract.lock;
  await fs.writeFile(path.join(OUTPUT, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await fs.mkdir(path.join(OUTPUT, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(OUTPUT, 'runtime/bridge.js'), bridge, { mode: 0o644 });
  for (const directory of ['cli', 'workbench', 'examples']) {
    await copyTree(path.join(ROOT, directory), path.join(OUTPUT, directory));
  }
  await copyTree(path.join(ROOT, 'docs/limitations.md'), path.join(OUTPUT, 'docs/limitations.md'));
  await copyTree(path.join(ROOT, 'docs/workbench.md'), path.join(OUTPUT, 'docs/workbench.md'));
  await copyTree(path.join(ROOT, 'LICENSE'), path.join(OUTPUT, 'LICENSE'));
  const sourceStartGuide = await fs.readFile(path.join(ROOT, 'docs/workbench-start-here.md'), 'utf8');
  const packagedStartGuide = packageGuide(sourceStartGuide);
  await fs.writeFile(path.join(OUTPUT, 'START-HERE.md'), packagedStartGuide);
  await fs.writeFile(path.join(OUTPUT, 'README.md'), packagedStartGuide);

  const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: OUTPUT, encoding: 'utf8', stdio: 'inherit',
  });
  if (install.error) fail(`could not run npm ci for locked production dependencies: ${install.error.message}`);
  if (install.status !== 0) fail(`npm ci failed with status ${install.status}`);
  await fs.writeFile(path.join(OUTPUT, 'THIRD-PARTY-NOTICES'), await thirdPartyNotices(OUTPUT, lock));
  await writePackageProvenance(ROOT, OUTPUT, inputs, buildRecord);
  await makeZip();
  process.stdout.write(JSON.stringify({
    package: OUTPUT,
    archive: ZIP_PATH,
    bridge_sha256: digest(bridge),
    archive_sha256: digest(await fs.readFile(ZIP_PATH)),
    dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, lock.packages[`node_modules/${name}`].version])),
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`package:workbench failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
