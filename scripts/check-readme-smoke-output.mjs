import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [runDir] = process.argv.slice(2);
if (!runDir) throw new Error("usage: check-readme-smoke-output.mjs RUN_DIR");
const names = new Set(await readdir(runDir));
for (const name of ["manifest.json", "report.json", "decisions.csv", "unresolved.csv", "summary.md"]) {
  assert.ok(names.has(name), `final run is missing ${name}`);
}
const report = JSON.parse(await readFile(join(runDir, "report.json"), "utf8"));
assert.equal(report.computation?.status, "complete", "reviewed example should finish computation");
const summary = await readFile(join(runDir, "summary.md"), "utf8");
assert.match(summary, /Record accounting/);
assert.match(summary, /Field comparison/);
