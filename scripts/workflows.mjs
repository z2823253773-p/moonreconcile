import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'cli/main.mjs');
const required = ['manifest.json','input/left.csv','input/right.csv','config.json','report.json','pairs.csv','fields.csv','candidates.csv','decisions.csv','unresolved.csv','summary.md'];
const examples = ['orders','migration','catalog'];
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moonreconcile-workflows-'));
function invoke(args) {
  const r = spawnSync(process.execPath, [cli, ...args], {cwd:root, encoding:'utf8'});
  return {code:r.status, out:r.stdout, err:r.stderr};
}
async function readReport(dir) { return JSON.parse(await fs.readFile(path.join(dir,'report.json'),'utf8')); }
async function allArtifacts(dir, r) {
  for (const name of required) assert.ok((await fs.stat(path.join(dir,name))).isFile(), `${name} missing`);
  const count = (side, status) => r.records.filter(x => x.side === side && x.status === status).length;
  for (const side of ['left','right']) {
    const total = r.records.filter(x=>x.side===side).length;
    assert.equal(['paired','unmatched','pending_review','unprocessed'].reduce((s,k)=>s+count(side,k),0),total);
  }
  const reportJson=JSON.parse(await fs.readFile(path.join(dir,'report.json'),'utf8'));assert.deepEqual(reportJson,r);
  const pairs=parseCsv(await fs.readFile(path.join(dir,'pairs.csv'),'utf8'));assert.deepEqual(pairs[0],['left_id','right_id','source','reason','override']);assert.equal(pairs.length-1,r.pairs.length);
  const fields=parseCsv(await fs.readFile(path.join(dir,'fields.csv'),'utf8'));assert.deepEqual(fields[0].slice(0,6),['left_id','right_id','field','type','left_raw','right_raw']);assert.equal(fields.length-1,r.fields.length);
  const candidates=parseCsv(await fs.readFile(path.join(dir,'candidates.csv'),'utf8'));assert.equal(candidates.length-1,r.candidates.length);
  const unresolved=parseCsv(await fs.readFile(path.join(dir,'unresolved.csv'),'utf8'));assert.equal(unresolved.length-1,r.records.filter(x=>x.status==='pending_review'||x.status==='unprocessed').length);
  const md = await fs.readFile(path.join(dir,'summary.md'),'utf8');
  assert.ok(md.includes('## Record accounting'));assert.ok(md.includes(String(r.summary.unresolved_count)));
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));assert.equal(manifest.left_bytes,(await fs.readFile(path.join(dir,'input/left.csv'))).length);assert.equal(manifest.right_bytes,(await fs.readFile(path.join(dir,'input/right.csv'))).length);
}
function parseCsv(text) {
  const rows=[];let row=[],cell='',quoted=false,started=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}else if(c==='"'){quoted=true;started=true;}else if(c===','){row.push(cell);cell='';started=true;}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';started=false;}else {cell+=c;started=true;}}
  if(started||cell!==''||row.length) {row.push(cell);rows.push(row);}assert.equal(quoted,false,'valid exported CSV');return rows;
}
function semantic(r) {
  const {created,...manifest} = r;
  return JSON.stringify(r);
}
function exactReference(name) {
  // Fixture-scoped independent exact join + declared status/decimal/date rules.
  const dir = path.join(root,'examples',name);
  const l = (readFileSync(path.join(dir,'left.csv'),'utf8')), rr = (readFileSync(path.join(dir,'right.csv'),'utf8'));
  const cfg = JSON.parse(readFileSync(path.join(dir,'rules.json'),'utf8'));
  const parse = text => { const [h,...rows]=text.trimEnd().split('\n'); return rows.map(line=>Object.fromEntries(h.split(',').map((k,i)=>[k,line.split(',')[i]]))); };
  const left=parse(l), right=parse(rr); const key=cfg.key?.[0];
  if (!key) return {pairs:[], pendingLeft:left.length,pendingRight:right.length, fields:[]};
  const field=cfg.fields.find(f=>f.name===key); const lk=x=>x[field.left], rk=x=>x[field.right];
  const freq=a=>{const m=new Map();for(const x of a)m.set(lk(x), (m.get(lk(x))??0)+1);return m;};
  const lf=freq(left), rf=new Map(); for(const x of right)rf.set(rk(x),(rf.get(rk(x))??0)+1);
  const pairs=[]; for(let i=0;i<left.length;i++) if(lk(left[i]) && lf.get(lk(left[i]))===1 && rf.get(lk(left[i]))===1) pairs.push([i+1,right.findIndex(x=>rk(x)===lk(left[i]))+1]);
  const comparisons=[];
  for(const [li,ri] of pairs) for(const f of cfg.fields.filter(x=>x.compare!==false)) {
    let a=left[li-1][f.left],b=right[ri-1][f.right],status;
    if(f.type==='decimal') {const scale=x=>{const [w,d='']=x.split('.');return [BigInt(w+d),d.length]};const [ac,as]=scale(a),[bc,bs]=scale(b);const tt=f.abs_tol??'0';const [tc,ts]=scale(tt);const n=Math.max(as,bs,ts);const d=ac*10n**BigInt(n-as)-bc*10n**BigInt(n-bs);const tol=tc*10n**BigInt(n-ts);status=(d<0n?-d:d)<=tol?'equivalent_by_rule':'different';}
    else if(f.type==='date') { const day=s=>{const [y,m,d]=s.split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));if(dt.toISOString().slice(0,10)!==s)throw Error('invalid date');return dt.getTime()/86400000};status=day(a)===day(b)?'equal':'different'; }
    else {const mapped=f.right_values?.[b]??b; status=a===mapped?(a===b?'equal':'equivalent_by_rule'):'different';}
    comparisons.push({field:f.name,status});
  }
  return {pairs,pendingLeft:left.length-pairs.length,pendingRight:right.length-pairs.length,fields:comparisons};
}

for (const name of examples) {
  const base = path.join(root,'examples',name);
  const compareDir=path.join(tmp,`${name}-compare`), resolved=path.join(tmp,`${name}-resolved`), replay=path.join(tmp,`${name}-replay`);
  let c=invoke(['compare',`${base}/left.csv`,`${base}/right.csv`,'--config',`${base}/rules.json`,'--out',compareDir]);
  assert.equal(c.code,1,`${name} compare: ${c.err}`);
  const before=await readReport(compareDir); await allArtifacts(compareDir,before);
  const reference=exactReference(name);
  assert.equal(before.summary.per_side.left.paired,reference.pairs.length);
  assert.equal(before.summary.per_side.right.paired,reference.pairs.length);
  assert.equal(before.summary.per_side.left.pending_review,reference.pendingLeft);
  assert.equal(before.summary.per_side.right.pending_review,reference.pendingRight);
  assert.deepEqual(before.fields.map(({field,status})=>({field,status})),reference.fields,`${name} independent fixture baseline field outcomes`);
  if(name==='orders') {
    assert.deepEqual(before.fields.map(x=>x.status),['equivalent_by_rule','equivalent_by_rule','equal','different','different','different']);
    assert.equal(before.fields[1].difference,'-0.01'); assert.equal(before.fields[4].difference,'-1');
    assert.equal(before.records.find(x=>x.id==='L3').status,'pending_review');
  } else if(name==='migration') {
    assert.deepEqual(before.structure.unmapped_left,['legacy_note']); assert.deepEqual(before.structure.ignored_right,['export_stamp']);
    assert.equal(before.key_issues.filter(x=>x.code==='duplicate_key').length,4);
    assert.equal(before.key_issues.filter(x=>x.code==='invalid_or_missing_key').length,2);
  } else {
    assert.equal(before.candidates.length,2); assert.equal(before.candidates[0].score,8000);assert.equal(before.candidates[1].score,10000);
    assert.equal(before.candidates.filter(x=>x.suggested && x.right_id==='R2').length,1);
    assert.equal(reference.pairs.length,0,'exact-only baseline has no common catalog key');
    const truth=JSON.parse(await fs.readFile(path.join(base,'truth.json'),'utf8'));
    const truthPairs=new Set(truth.true_pairs.map(x=>JSON.stringify(x)));
    const trueCandidates=before.candidates.filter(x=>truthPairs.has(JSON.stringify([x.left_id,x.right_id])));
    const suggested=before.candidates.filter(x=>x.suggested);
    const wrongSuggestions=suggested.filter(x=>!truthPairs.has(JSON.stringify([x.left_id,x.right_id])));
    const review=parseCsv(await fs.readFile(path.join(base,'reviewed.csv'),'utf8')).slice(1);
    const accepted=review.filter(x=>x[0]==='accept');const rejected=review.filter(x=>x[0]==='reject');
    assert.deepEqual({true:trueCandidates.length,false:before.candidates.length-trueCandidates.length},truth.qualified_candidates);
    assert.deepEqual({true:suggested.filter(x=>truthPairs.has(JSON.stringify([x.left_id,x.right_id]))).length,false:wrongSuggestions.length,unmatched_left:suggested.filter(x=>truth.true_unmatched.left.includes(x.left_id)).length},truth.suggestions);
    assert.deepEqual({accepted_true:accepted.filter(x=>truthPairs.has(JSON.stringify([x[1],x[2]]))).length,accepted_false:accepted.filter(x=>!truthPairs.has(JSON.stringify([x[1],x[2]]))).length,rejected_false:rejected.filter(x=>!truthPairs.has(JSON.stringify([x[1],x[2]]))).length,confirmed_unmatched_right:review.filter(x=>x[0]==='right_unmatched'&&truth.true_unmatched.right.includes(x[2])).length},truth.review);

  }
  c=invoke(['resolve',compareDir,'--decisions',`${base}/reviewed.csv`,'--out',resolved]);
  assert.equal(c.code,1,`${name} resolve: ${c.err}`);
  const after=await readReport(resolved); await allArtifacts(resolved,after);
  c=invoke(['resolve',compareDir,'--decisions',path.join(resolved,'decisions.csv'),'--out',replay]);
  assert.equal(c.code,1,`${name} replay: ${c.err}`);
  const replayed=await readReport(replay); await allArtifacts(replay,replayed);
  assert.deepEqual(replayed,after,`${name} resolve replay changed semantic result`);
  if(name==='orders') {assert.equal(after.summary.per_side.left.unmatched,1);assert.equal(after.summary.per_side.left.pending_review,0);}
  if(name==='migration') {assert.equal(after.pairs.length,4);assert.equal(after.fields.length,8);assert.equal(after.summary.unresolved_count,0);}
  if(name==='catalog') {assert.deepEqual(after.pairs.map(x=>[x.left_id,x.right_id]),[['L1','R1']]);assert.equal(after.summary.per_side.right.unmatched,1);assert.equal(after.fields.filter(x=>x.status==='different').length,1);}
  console.log(`${name}: compare/resolve/replay pass; candidates=${before.candidates.length}; pairs=${after.pairs.length}; unresolved=${after.summary.unresolved_count}; exit=${c.code}`);
}
console.log(`Synthetic workflows passed. Temporary runs: ${tmp}`);
