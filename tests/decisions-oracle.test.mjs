// Independent seeded disposition oracle; synthetic only.
import assert from 'node:assert/strict';
import {invoke_bridge} from '../_build/js/debug/build/cmd/bridge/bridge.js';
let seed=93005;
const rand=(n)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const config={schema_version:1,fields:[{name:'id',left:'id',right:'id',type:'text',compare:false},{name:'value',left:'v',right:'v',type:'text'}]};
for(let t=0;t<200;t++){
 const n=1+rand(5),m=1+rand(5),lv=Array.from({length:n},()=>String(rand(3))),rv=Array.from({length:m},()=>String(rand(3)));
 const lc='id,v\n'+lv.map((v,i)=>`l${i},${v}\n`).join(''),rc='id,v\n'+rv.map((v,i)=>`r${i},${v}\n`).join('');
 const l=[...Array(n).keys()],r=[...Array(m).keys()],rows=[],pairs=[];
 while(l.length&&r.length&&rand(2)) {const a=l.splice(rand(l.length),1)[0],b=r.splice(rand(r.length),1)[0];rows.push(`accept,L${a+1},R${b+1},truth`);pairs.push([a,b]);}
 const ul=[],ur=[];
 for(const a of l)if(rand(2)){rows.push(`left_unmatched,L${a+1},,truth`);ul.push(a);}
 for(const b of r)if(rand(2)){rows.push(`right_unmatched,,R${b+1},truth`);ur.push(b);}
 const request=(list)=>JSON.parse(invoke_bridge(JSON.stringify({op:'resolve',left_csv:lc,right_csv:rc,config,decisions_csv:'action,left_id,right_id,reason\n'+list.join('\n')+'\n'})));
 const a=request(rows),b=request([...rows].reverse().concat(rows));
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.deepEqual(a.result,b.result);
 const result=a.result;
 assert.equal(result.pairs.length,pairs.length);
 for(const [side,total,unmatched] of [['left',n,ul],['right',m,ur]]){
  const summary=result.summary.per_side[side];
  assert.equal(summary.total,total);assert.equal(summary.paired,pairs.length);assert.equal(summary.unmatched,unmatched.length);assert.equal(summary.pending_review,total-pairs.length-unmatched.length);assert.equal(summary.unprocessed,0);
 }
 const states=new Map(result.records.map(x=>[x.id,x.status]));
 for(const [a,b]of pairs){assert.equal(states.get(`L${a+1}`),'paired');assert.equal(states.get(`R${b+1}`),'paired');}
 for(const a of ul)assert.equal(states.get(`L${a+1}`),'unmatched');for(const b of ur)assert.equal(states.get(`R${b+1}`),'unmatched');
 let different=0;for(const [a,b]of pairs)if(lv[a]!==rv[b])different++;
 assert.equal(result.fields.filter(x=>x.status==='different').length,different);
 assert.equal(result.fields.filter(x=>x.status==='equal').length,pairs.length-different);
 const issue=different||ul.length||ur.length||pairs.length<n||pairs.length<m;
 assert.equal(result.exit_code,issue?1:0);
}
console.log('200 independent cumulative-review/state/field/exit cases passed');

const size=101, csv=(prefix)=>'id,v\n'+Array.from({length:size},(_,i)=>`${prefix}${i},same\n`).join('');
const incomplete=JSON.parse(invoke_bridge(JSON.stringify({op:'resolve',left_csv:csv('l'),right_csv:csv('r'),config:{...config,candidates:{fields:[{field:'value',metric:'exact',weight:1}],threshold:10000,blocking:[]}},decisions_csv:'action,left_id,right_id,reason\n'+Array.from({length:size},(_,i)=>`accept,L${i+1},R${i+1},verified\n`).join('')})));
assert.equal(incomplete.ok,true);assert.equal(incomplete.result.computation.status,'incomplete');assert.equal(incomplete.result.exit_code,3);assert.equal(incomplete.result.summary.unresolved_count,0);assert.equal(incomplete.result.pairs.length,101);
for(const side of ['left','right'])assert.deepEqual(incomplete.result.summary.per_side[side],{total:101,paired:101,unmatched:0,pending_review:0,unprocessed:0});
console.log('Production 101x101 resource-limited fully-reviewed case preserved incomplete/exit3/unresolved0');
