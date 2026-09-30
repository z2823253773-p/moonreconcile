import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = process.env.BENCH_ROOT ? path.resolve(process.env.BENCH_ROOT) : fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root,'cli/main.mjs');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'moonreconcile-bench-'));
const repeatCount=Number(process.env.BENCH_REPEATS??3);
const sha=process.env.BENCH_SHA??spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
const moon=spawnSync('moon',['version','--all'],{encoding:'utf8'}).stdout.trim();
const exactCsv=(n,side)=>`id,group,name\n${Array.from({length:n},(_,i)=>`id${i},g${i},item${i}\n`).join('')}`;
const candidateCsv=(n,side,groups)=>`id,group,name\n${Array.from({length:n},(_,i)=>`${side}${i},${groups?`g${Math.floor(i/(n/groups))}`:'shared'},${groups?`name${Math.floor(i/(n/groups))}`:'identical'}\n`).join('')}`;
function writeFile(p,s){return fs.writeFile(p,s)}
async function bytes(dir){let sum=0;async function walk(d){for(const e of await fs.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())sum+=(await fs.stat(p)).size;}}await walk(dir);return sum;}
async function measure(spec, iteration, engineRoot=root) {
  const id=`${spec.name}-${iteration}-${path.basename(engineRoot)}`; const input=path.join(tmp,id); const out=path.join(tmp,`${id}-run`); await fs.mkdir(input);
  await writeFile(path.join(input,'left.csv'),spec.left);await writeFile(path.join(input,'right.csv'),spec.right);await writeFile(path.join(input,'rules.json'),JSON.stringify(spec.config));
  const args=[cli,'compare',path.join(input,'left.csv'),path.join(input,'right.csv'),'--config',path.join(input,'rules.json'),'--out',out];
  const start=performance.now(); let result,rssBytes=null,rssTool;
  if(process.platform==='darwin') {rssTool='/usr/bin/time -l (bytes)';result=spawnSync('/usr/bin/time',['-l',process.execPath,...args],{cwd:engineRoot,encoding:'utf8'});const m=result.stderr.match(/maximum resident set size\s+(\d+)/);if(m)rssBytes=Number(m[1]);}
  else if(process.platform==='linux') {rssTool='/usr/bin/time -v (KiB converted to bytes)';result=spawnSync('/usr/bin/time',['-v',process.execPath,...args],{cwd:engineRoot,encoding:'utf8'});const m=result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);if(m)rssBytes=Number(m[1])*1024;}
  else {rssTool='unavailable';result=spawnSync(process.execPath,args,{cwd:engineRoot,encoding:'utf8'});}
  const elapsed=performance.now()-start;
  const childExit=process.platform==='darwin'?Number(result.stdout.match(/\nexit: (\d+)\n?$/)?.[1]??result.status):result.status;
  assert.equal(childExit,spec.exit,`${spec.name} child exit=${childExit}; wrapper=${result.status}: ${result.stderr}`);
  const report=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));
  const leftPending=report.summary.per_side.left.pending_review+report.summary.per_side.left.unprocessed;
  const rightPending=report.summary.per_side.right.pending_review+report.summary.per_side.right.unprocessed;
  const comp=new Map();for(const c of report.candidates){let x=comp.get(c.component_id);if(!x){x={left:new Set(),right:new Set()};comp.set(c.component_id,x);}x.left.add(c.left_id);x.right.add(c.right_id);}
  const largest=(side)=>Math.max(0,...[...comp.values()].map(x=>x[side].size));
  const rssEvidence=rssBytes===null?(process.platform==='darwin'?'unavailable: /usr/bin/time -l emitted no maximum resident set size (sandbox denied sysctl)':process.platform==='linux'?'unavailable: /usr/bin/time -v maximum RSS field was not found':'unavailable'):rssTool;
  return {case:spec.name,iteration,sha,rows_left:spec.leftRows,rows_right:spec.rightRows,exact_pairs:report.pairs.filter(p=>p.source==='exact_key').length,remaining_left:leftPending,remaining_right:rightPending,candidate_count:report.candidates.length,potential_candidate_pairs:spec.potential,density:spec.potential?report.candidates.length/spec.potential:null,candidate_component_count:comp.size,largest_component_left:largest('left'),largest_component_right:largest('right'),wall_ms:Number(elapsed.toFixed(3)),child_peak_rss_bytes:rssBytes,rss_measurement:rssEvidence,output_bytes:await bytes(out),exit_status:childExit,time_wrapper_status:result.status};
}
const id={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'group',left:'group',right:'group',type:'text',compare:false},{name:'name',left:'name',right:'name',type:'text'}],key:['id']};
const cand={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'group',left:'group',right:'group',type:'text',compare:false},{name:'name',left:'name',right:'name',type:'text'}],candidates:{fields:[{field:'name',metric:'exact',weight:1}],threshold:10000,blocking:[['group']]}};
function spec(name,left,right,config,meta){return {name,left,right,config,...meta};}
const cases=[];
for(const n of [1000,10000])cases.push(spec(`exact-${n}`,exactCsv(n,'L'),exactCsv(n,'R'),id,{leftRows:n,rightRows:n,potential:0,componentLeft:0,componentRight:0,exit:0}));
for(const n of [10000,30000])cases.push(spec(`sparse-${n}`,candidateCsv(n,'L',n),candidateCsv(n,'R',n),cand,{leftRows:n,rightRows:n,potential:n,componentLeft:1,componentRight:1,exit:1}));
// One exact block followed by 1000 disconnected singleton candidate components.
{
 const n=10000, make=side=>`id,group,name\n${Array.from({length:9000},(_,i)=>`exact${i},e${i},exact${i}\n`).join('')}${Array.from({length:1000},(_,i)=>`${side}c${i},c${i},cand${i}\n`).join('')}`;
 cases.push(spec('mixed-9000-exact-1000-candidates',make('L'),make('R'),{...cand,key:['id']},{leftRows:n,rightRows:n,potential:1000,componentLeft:1,componentRight:1,exit:1}));
}
for(const n of [100,101])cases.push(spec(`dense-${n}x${n}`,candidateCsv(n,'L',1),candidateCsv(n,'R',1),cand,{leftRows:n,rightRows:n,potential:n*n,componentLeft:n,componentRight:n,exit:n===100?1:3}));
for(const [l,r] of [[1000,100],[1001,100]])cases.push(spec(`pair-budget-${l}x${r}`,candidateCsv(l,'L',1),candidateCsv(r,'R',1),cand,{leftRows:l,rightRows:r,potential:l*r,componentLeft:l,componentRight:r,exit:l*r>100000?3:3}));
const selection=process.env.BENCH_CASES?new Set(process.env.BENCH_CASES.split(',')):null;
const selectedCases=selection?cases.filter(item=>selection.has(item.name)):cases;
const results=[];
for(const item of selectedCases) {const count=item.name.startsWith('sparse-')?repeatCount:1;for(let i=1;i<=count;i++)results.push(await measure(item,i));}
const host=spawnSync('uname',['-a'],{encoding:'utf8'}).stdout.trim();
const cpuProbe=spawnSync('sysctl',['-n','machdep.cpu.brand_string'],{encoding:'utf8'});const cpu=cpuProbe.stdout.trim()||spawnSync('sh',['-lc','grep -m1 "model name" /proc/cpuinfo'],{encoding:'utf8'}).stdout.trim()||`${spawnSync('uname',['-m'],{encoding:'utf8'}).stdout.trim()} (CPU model unavailable: system query was denied)`;
const record={label:'synthetic benchmark; end-to-end child CLI compare including CSV parse and report writing; fixture generation/build excluded',recorded_at:new Date().toISOString(),tested_sha:sha,host,os:os.platform(),cpu,node:process.version,moon,repeat_count:repeatCount,rss_method:process.platform==='darwin'?'/usr/bin/time -l child maximum resident set size bytes (emitted no value in this sandbox because sysctl was denied)':process.platform==='linux'?'/usr/bin/time -v child maximum resident set size KiB converted to bytes':'unavailable',command:'BENCH_REPEATS=3 node scripts/benchmark.mjs',cases:results};
const destination=process.env.BENCH_OUTPUT?path.resolve(process.env.BENCH_OUTPUT):path.join(root,'docs/evidence/task7-benchmark.json');await fs.writeFile(destination,`${JSON.stringify(record,null,2)}\n`);console.log(`wrote ${results.length} observations to ${destination}; temporary inputs/runs: ${tmp}`);
