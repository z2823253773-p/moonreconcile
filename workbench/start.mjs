#!/usr/bin/env node
import { startWorkbench } from './server.mjs';
if(Number(process.versions.node.split('.')[0])<22)throw new Error('MoonReconcile workbench requires Node.js 22 or newer');
const app=await startWorkbench();
process.stdout.write(`${app.origin}/#token=${app.token}\n`);
let stopping=false;
const close=async()=>{if(stopping)return;stopping=true;try{await app.close();process.stdout.write('Local session cleaned. No recoverable bundle was created in this session.\n');process.exitCode=0;}catch{process.stderr.write('Local workspace cleanup refused; preserve the workspace for ownership inspection.\n');process.exitCode=1;}};
process.once('SIGINT',close);process.once('SIGTERM',close);
