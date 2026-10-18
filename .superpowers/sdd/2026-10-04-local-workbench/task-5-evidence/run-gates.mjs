import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const cwd='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench';
const profile=process.argv[2]??'default',dir=`/private/tmp/task5-sol-gates-${profile}`;
await fs.mkdir(dir,{recursive:true});
const sdk=path.join(cwd,'.superpowers/sdd/2026-10-04-local-workbench/toolchain');
const env={...process.env,MOON_HOME:sdk,MOONBIT_HOME:sdk,PATH:`${path.join(sdk,'bin')}:${process.env.PATH}`,npm_config_cache:'/private/tmp/task5-sol-npm-cache'};
const checks=[['core-check','moon',['check','--target','js']],['core-info','moon',['info']],['core-format','moon',['fmt']],['core-format-check','moon',['fmt','--check']],['core-test','moon',['test','--target','js']],['npm-test','npm',['test']],['workbench','npm',['run','test:workbench']],['workflows','npm',['run','test:workflows']],['public-data','npm',['run','test:public-data']]];
if(['final','verified'].includes(profile))checks.push(['e2e','npm',['run','test:workbench:e2e']]);if(profile==='final')checks.push(['audit','npm',['audit','--json','--fetch-retries=0','--fetch-timeout=15000']]);
const results=[];
for(const [name,command,args] of checks){
  console.log(`Starting ${name}`);const started=new Date().toISOString();
  const result=await new Promise(resolve=>{const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',error=>output+=error.message);child.on('close',(code,signal)=>resolve({code,signal,output}));});
  const output=result.output.replace(/#token=[A-Za-z0-9_-]+/g,'#token=[redacted]').replace(/Bearer [A-Za-z0-9_-]+/g,'Bearer [redacted]');
  await fs.writeFile(path.join(dir,`${name}.log`),output);
  const row={name,command:[command,...args],started,finished:new Date().toISOString(),exit_code:result.code,signal:result.signal,log:path.join(dir,`${name}.log`)};results.push(row);await fs.writeFile(path.join(dir,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(`${name} exit ${result.code}`);
}
process.exitCode=results.every(row=>row.exit_code===0)?0:1;
