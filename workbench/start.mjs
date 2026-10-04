#!/usr/bin/env node
import { startWorkbench } from './server.mjs';
const app=await startWorkbench();
process.stdout.write(`${app.origin}/#token=${app.token}\n`);
const close=async()=>{await app.close();process.exit(0);};
process.once('SIGINT',close);process.once('SIGTERM',close);
