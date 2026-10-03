// Manual seeded full-envelope comparison against a separately built frozen checkout.
import assert from "node:assert/strict";
import path from "node:path";
import {pathToFileURL} from "node:url";
assert.equal(process.argv.length,3,"usage: node scripts/check-review-equivalence.mjs BUILT_BASELINE_CHECKOUT");
const root=path.resolve(import.meta.dirname,"..");
const old=(await import(pathToFileURL(path.resolve(process.argv[2],"_build/js/debug/build/cmd/bridge/bridge.js")))).invoke_bridge;
const current=(await import(pathToFileURL(path.join(root,"_build/js/debug/build/cmd/bridge/bridge.js")))).invoke_bridge;
let seed=93007;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const cell=s=>/[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
const counts={success:0,errors:{}};
for(let t=0;t<3000;t++){
 const n=1+rand(8),m=1+rand(8);const keyed=rand(3)===0,candidates=rand(3)===0;
 const config={schema_version:1,fields:[{name:"id",left:"id",right:"id",type:"text",compare:false},{name:"v",left:"v",right:"v",type:"text"}],key:keyed?["id"]:[]};
 if(candidates)config.candidates={fields:[{field:"v",metric:"exact",weight:1}],threshold:5000,blocking:[]};
 const left="id,v\n"+Array.from({length:n},(_,i)=>`${keyed?'same'+i:'l'+i},${rand(3)}\n`).join("");
 const right="id,v\n"+Array.from({length:m},(_,i)=>`${keyed&&i%2===0?'same'+i:'r'+i},${rand(3)}\n`).join("");
 const rows=[];for(let i=0,limit=rand(15);i<limit;i++){
  const action=["accept","reject","left_unmatched","right_unmatched","", "bad"][rand(6)];
  let l="L"+(1+rand(n+2)),r="R"+(1+rand(m+2));
  if(action==="left_unmatched")r="";if(action==="right_unmatched")l="";
  if(rand(10)===0)l="L01";if(rand(10)===0)r="";
  const reason=["checked","", "changed",`é,quoted\n"reason"`][rand(4)];
  rows.push([action,l,r,reason].map(cell).join(","));if(rand(6)===0)rows.push(rows.at(-1));
 }
 const request=JSON.stringify({op:"resolve",left_csv:left,right_csv:right,config,decisions_csv:"action,left_id,right_id,reason\n"+rows.join("\n")+"\n"});
 const outcome=JSON.parse(current(request));if(outcome.ok)counts.success++;else counts.errors[outcome.error.code]=(counts.errors[outcome.error.code]??0)+1;
 assert.equal(current(request),old(request),`complete success/error envelope mismatch at seeded case ${t}`);
}
console.log(JSON.stringify(counts));
console.log("3000 seeded success/error/row-location/reason/lock/candidate cases identical to frozen baseline");
