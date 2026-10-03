// Deterministic synthetic review-load comparison; manual performance gate, not CI SLA.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--baseline", "--baseline-sha", "--out"].includes(args[i]), `unknown argument ${args[i]}`);
  assert.ok(args[i + 1], `missing value ${args[i]}`);
  assert.ok(!(args[i] in options), `duplicate argument ${args[i]}`);
  options[args[i]] = args[i + 1];
}
assert.ok(options["--baseline"] && options["--baseline-sha"], "usage: node scripts/benchmark-review.mjs --baseline BUILT_CHECKOUT --baseline-sha SHA [--out NEW_JSON]");
const root = path.resolve(import.meta.dirname, "..");
assert.match(options["--baseline-sha"], /^[0-9a-f]{40}$/, "baseline must use a full source SHA");
const baselineRoot = path.resolve(options["--baseline"]);
const sourceFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", options["--baseline-sha"]], {cwd: root, encoding: "utf8"})
  .trim().split("\n").filter(file => /\.(mbt|mbti)$/.test(file) || /(^|\/)moon\.(mod|pkg)$/.test(file));
assert.ok(sourceFiles.length > 0, "baseline source must exist in repository history");
for (const file of sourceFiles) {
  assert.deepEqual(await readFile(path.join(baselineRoot, file)), execFileSync("git", ["show", `${options["--baseline-sha"]}:${file}`], {cwd: root}), `baseline source mismatch: ${file}`);
}
const old = (await import(pathToFileURL(path.resolve(options["--baseline"], "_build/js/debug/build/cmd/bridge/bridge.js")))).invoke_bridge;
const current = (await import(pathToFileURL(path.join(root, "_build/js/debug/build/cmd/bridge/bridge.js")))).invoke_bridge;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const config = {schema_version: 1, fields: [{name: "value", left: "value", right: "value", type: "text"}]};
const request = (n, mode) => JSON.stringify({op: "resolve", left_csv: "value\n" + "same\n".repeat(n), right_csv: "value\n" + "same\n".repeat(n), config,
  decisions_csv: "action,left_id,right_id,reason\n" + Array.from({length: n}, (_, i) => mode === "accept"
    ? `accept,L${i + 1},R${i + 1},checked\n`
    : `left_unmatched,L${i + 1},,checked\nright_unmatched,,R${i + 1},checked\n`).join("")});
for (const invoke of [old, current]) assert.equal(JSON.parse(invoke(request(200, "accept"))).ok, true);
const observations = [];
for (const mode of ["accept", "unmatched"]) {
  const wire = request(10000, mode);
  const times = {baseline: [], current: []};
  let expected;
  for (let rep = 0; rep < 3; rep++) {
    for (const [label, invoke] of rep % 2 === 0 ? [["baseline", old], ["current", current]] : [["current", current], ["baseline", old]]) {
      const start = performance.now();
      const raw = invoke(wire);
      times[label].push(performance.now() - start);
      const response = JSON.parse(raw);
      assert.equal(response.ok, true);
      assert.equal(response.result.records.length, 20000);
      assert.equal(response.result.summary.unresolved_count, 0);
      assert.equal(response.result.exit_code, mode === "accept" ? 0 : 1);
      if (expected === undefined) expected = raw;
      else assert.equal(raw, expected, "complete response must match the frozen engine byte for byte");
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[1];
  observations.push({mode, rows_per_side: 10000, active_actions: mode === "accept" ? 10000 : 20000,
    request_sha256: digest(wire), response_sha256: digest(expected), response_bytes: Buffer.byteLength(expected),
    milliseconds: times, baseline_median_ms: median(times.baseline), current_median_ms: median(times.current),
    ratio: median(times.current) / median(times.baseline)});
}
const evidence = {scope: "synthetic pure-invoke correctness/performance; not filesystem, user benefit or maximum-capacity evidence",
  baseline_sha: options["--baseline-sha"], current_sha: execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim(),
  working_tree_dirty: Boolean(execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim()),
  baseline_source_files_verified: sourceFiles.length,
  baseline_bridge_sha256: digest(await readFile(path.join(baselineRoot, "_build/js/debug/build/cmd/bridge/bridge.js"))),
  current_bridge_sha256: digest(await readFile(path.join(root, "_build/js/debug/build/cmd/bridge/bridge.js"))),
  driver_sha256: digest(await readFile(import.meta.filename)), node: process.version, platform: process.platform, arch: process.arch, observations};
if (options["--out"]) await writeFile(options["--out"], JSON.stringify(evidence, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify(evidence, null, 2));
for (const observation of observations) assert.ok(observation.ratio < 0.5, "local optimization acceptance: current median must be less than half the same-driver frozen baseline");
