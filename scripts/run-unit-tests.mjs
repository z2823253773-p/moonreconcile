#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workbenchOnly = process.argv.includes('--workbench');
const files = (await readdir(path.join(root, 'tests')))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => name !== 'workbench-package.test.mjs')
  .filter((name) => !workbenchOnly || name.startsWith('workbench-'))
  .sort()
  .map((name) => path.join(root, 'tests', name));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
