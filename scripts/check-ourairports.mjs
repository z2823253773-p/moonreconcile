// Real public snapshot fixture, checked against independently prepared CSV reference.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "examples/ourairports");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
const expected = await json(path.join(fixture, "expected.json"));
const provenance = await json(path.join(fixture, "provenance.json"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const required = ["manifest.json", "input/left.csv", "input/right.csv", "config.json", "report.json", "pairs.csv", "fields.csv", "candidates.csv", "decisions.csv", "unresolved.csv", "summary.md"];
const originals = {};
for (const snapshot of provenance.snapshots) {
  const bytes = await fs.readFile(path.join(fixture, snapshot.side + ".csv"));
  assert.equal(digest(bytes), snapshot.subset_sha256, "fixture must match pinned independently prepared source");
  assert.equal(bytes.length, snapshot.subset_bytes);
  originals[snapshot.side] = bytes;
}
const left = new Map(expected.left_source_ids.map((source, i) => [source, "L" + (i + 1)]));
const right = new Map(expected.right_source_ids.map((source, i) => [source, "R" + (i + 1)]));
assert.equal(left.size, expected.left_source_ids.length);
assert.equal(right.size, expected.right_source_ids.length);
const expectedPairs = new Set([...left].filter(([source]) => right.has(source)).map(([source, id]) => id + ":" + right.get(source)));
assert.equal(expectedPairs.size, expected.pair_count);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "moonreconcile-public-snapshot-"));
const run = (args) => {
  const result = spawnSync(process.execPath, [path.join(root, "cli/main.mjs"), ...args], {cwd: root, encoding: "utf8"});
  assert.equal(result.status, 1, `actual differences must remain exit1: ${result.stderr}`);
};
try {
  const stages = ["compare", "reviewed", "replayed"].map(name => path.join(temp, name));
  run(["compare", path.join(fixture,"left.csv"), path.join(fixture,"right.csv"), "--config", path.join(fixture,"rules.json"), "--out", stages[0]]);
  run(["resolve", stages[0], "--decisions", path.join(fixture,"reviewed.csv"), "--out", stages[1]]);
  run(["resolve", stages[1], "--decisions", path.join(stages[1],"decisions.csv"), "--out", stages[2]]);
  let reviewed;
  for (let i=0; i<stages.length; i++) {
    const stage = stages[i];
    for (const name of required) assert.ok((await fs.stat(path.join(stage,name))).isFile(), name);
    for (const side of ["left","right"]) assert.deepEqual(await fs.readFile(path.join(stage,"input",side+".csv")), originals[side]);
    const report = await json(path.join(stage,"report.json"));
    assert.equal(report.computation.status,"complete");
    assert.equal(report.exit_code,1);
    assert.equal(report.records.length,left.size+right.size);
    const records = new Map(report.records.map(record => [record.id,record]));
    assert.equal(records.size,left.size+right.size);
    assert.deepEqual(new Set(report.pairs.map(pair=>pair.left_id+":"+pair.right_id)),expectedPairs);
    assert.equal(report.pairs.length,expected.pair_count);
    assert.ok(report.pairs.every(pair=>pair.source==="exact_key"));
    for(const [side, ids, other, label] of [["left",left,right,"left_only_source_ids"],["right",right,left,"right_only_source_ids"]]) {
      const lone=new Set(expected[label]);
      for(const [source,id] of ids) assert.equal(records.get(id)?.status, other.has(source)?"paired":i===0?"pending_review":"unmatched");
      assert.deepEqual(report.summary.per_side[side],{total:ids.size,paired:expected.pair_count,unmatched:i===0?0:lone.size,pending_review:i===0?lone.size:0,unprocessed:0});
    }
    const differences=report.fields.filter(field=>field.status==="different").map(field=>({left_id:field.left_id,right_id:field.right_id,field:field.field,left_value:field.left_raw,right_value:field.right_raw}));
    const sort = values => values.sort((a,b)=>(a.left_id+"/"+a.field).localeCompare(b.left_id+"/"+b.field,"en"));
    assert.deepEqual(sort(differences),sort(expected.field_changes.map(({source_id,...change})=>change)));
    assert.equal(report.fields.length,expected.pair_count*(expected.headers.length-1));
    assert.ok(report.fields.every(field=>field.status==="equal"||field.status==="different"));
    assert.equal(report.summary.unresolved_count,i===0?expected.left_only_source_ids.length+expected.right_only_source_ids.length:0);
    if(i===1) reviewed=report;
    if(i===2) assert.deepEqual(report,reviewed,"complete cumulative replay must be identical");
  }
  console.log("Public OurAirports CN/FR snapshots: 2558/2569 records,2558 exact pairs,11 additions,18 changed fields; compare→review→replay and byte snapshots verified");
} finally { await fs.rm(temp,{recursive:true,force:true}); }
