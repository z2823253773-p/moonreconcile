import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const suppliedToolchain=process.env.MOON_HOME??process.env.MOONBIT_HOME;
const localToolchain=path.join(root,'.superpowers/sdd/2026-10-04-local-workbench/toolchain');
const toolchain=suppliedToolchain?path.resolve(suppliedToolchain):!process.env.CI&&existsSync(path.join(localToolchain,'bin','moon'))?localToolchain:null;
if(toolchain){process.env.MOON_HOME=toolchain;process.env.MOONBIT_HOME=toolchain;process.env.PATH=`${path.join(toolchain,'bin')}:${process.env.PATH??''}`;}
execFileSync(process.execPath,['scripts/build.mjs'],{cwd:root,env:process.env,stdio:'inherit'});

const suppliedChrome=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??process.env.CHROME_PATH;
const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions=suppliedChrome?{executablePath:path.resolve(suppliedChrome)}:!process.env.CI&&existsSync(localChrome)?{executablePath:localChrome}:{};

export default defineConfig({
  testDir:'./tests/e2e',
  timeout:120_000,
  expect:{timeout:15_000},
  fullyParallel:false,
  workers:1,
  reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
  outputDir:'test-results',
  use:{actionTimeout:15_000,browserName:'chromium',headless:true,launchOptions,trace:'off',screenshot:'off',video:'off',acceptDownloads:true},
});
