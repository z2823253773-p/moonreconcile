#!/usr/bin/env node
import { assertSupportedNodeVersion } from './runtime.mjs';
assertSupportedNodeVersion();
const { startWorkbench } = await import('./server.mjs');
const app=await startWorkbench();
process.stdout.write(`${app.origin}/#token=${app.token}\n`);
let stopping=false;
const close=async()=>{if(stopping)return;stopping=true;try{await app.close();process.stdout.write('Local session cleaned. Only ZIP bundles you previously downloaded remain available.\n');process.exitCode=0;}catch{process.stderr.write('Local workspace cleanup refused; preserve the workspace for ownership inspection.\n');process.exitCode=1;}};
process.once('SIGINT',close);process.once('SIGTERM',close);
