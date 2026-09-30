import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../cli/main.mjs";
import { ENGINE_VERSION, canonicalJsonStringify, sha256Hex } from "../cli/io.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "cli", "main.mjs");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const RUN_FILES = [
  "manifest.json",
  "input/left.csv",
  "input/right.csv",
  "config.json",
  "report.json",
  "pairs.csv",
  "fields.csv",
  "candidates.csv",
  "decisions.csv",
  "unresolved.csv",
  "summary.md",
];
const LINKED_KEYS = [
  "schema_version",
  "engine_version",
  "computation",
  "records",
  "pairs",
  "fields",
  "candidates",
  "decisions",
  "structure",
  "key_issues",
  "summary",
  "exit_code",
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function mkTmp(prefix = "moonreconcile-cli-") {
  return fsPromises.mkdtemp(path.join(await fsPromises.realpath(os.tmpdir()), prefix));
}

function cli(args, { cwd = ROOT } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function failingError(stderr) {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  assert.ok(lines.length > 0, "expected a structured diagnostic on stderr");
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.ok, false, `expected ok:false, got ${JSON.stringify(parsed).slice(0, 200)}`);
  assert.equal(typeof parsed.error.code, "string");
  assert.equal(typeof parsed.error.message, "string");
  assert.equal(typeof parsed.error.phase, "string");
  return parsed.error;
}

async function readText(file) {
  return fsPromises.readFile(file, "utf8");
}

async function exists(target) {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function listDir(dir) {
  return (await fsPromises.readdir(dir, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
}

async function hashTree(dir) {
  const files = [];
  async function walk(current, prefix) {
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else files.push(`${rel}:${sha256Hex(await fsPromises.readFile(path.join(current, entry.name)))}`);
    }
  }
  await walk(dir, "");
  return files.join("\n");
}

async function stagingLeftovers(dir) {
  return (await listDir(dir)).filter((name) => name.startsWith(".reconcile-stage-"));
}

// Independent CSV reader used only to verify rendered exports.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function writeFixture(dir, { left, right, config, leftBytes, rightBytes } = {}) {
  const paths = {
    left: path.join(dir, "left.csv"),
    right: path.join(dir, "right.csv"),
    config: path.join(dir, "config.json"),
  };
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(paths.left, leftBytes ?? left);
  await fsPromises.writeFile(paths.right, rightBytes ?? right);
  await fsPromises.writeFile(paths.config, canonicalJsonStringify(config));
  return paths;
}

const TEXT_ID = { name: "id", left: "id", right: "id", type: "text" };

const EQUAL_CONFIG = {
  schema_version: 1,
  fields: [
    { name: "id", left: "id", right: "id", type: "text", compare: false },
    { name: "amount", left: "amount", right: "amount", type: "decimal" },
  ],
  key: ["id"],
};

const PENDING_CONFIG = {
  schema_version: 1,
  fields: [
    { name: "id", left: "id", right: "id", type: "text", compare: false },
    { name: "label", left: "label", right: "label", type: "text" },
  ],
  key: ["id"],
  candidates: {
    fields: [{ field: "label", metric: "exact", weight: 10000 }],
    threshold: 10000,
  },
};

async function quietRun(args, runtime = {}) {
  const stdout = [];
  const stderr = [];
  const code = await run(args, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...runtime,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function baseFs() {
  return { ...fsPromises };
}

function errorWithCode(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// end to end: compare -> edit decisions -> delete originals -> resolve
// ---------------------------------------------------------------------------

test("end to end compare, cumulative review after deleting originals", async () => {
  const dir = await mkTmp();
  const left = "id,label\n1,alpha\n2,beta\n";
  const right = "id,label\n9,alpha\n8,gamma\n";
  // no key matches on either side: every correspondence needs human review
  const paths = await writeFixture(dir, { left, right, config: PENDING_CONFIG });
  const leftBefore = await fsPromises.readFile(paths.left);
  const rightBefore = await fsPromises.readFile(paths.right);
  const run1 = path.join(dir, "run-001");

  const compared = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]);
  assert.equal(compared.status, 1, compared.stderr);
  assert.match(compared.stdout, /^run: /m);
  assert.match(compared.stdout, /^run_id: [0-9a-f]{64}$/m);
  assert.match(compared.stdout, /^exit: 1$/m);

  for (const entry of RUN_FILES) assert.ok(await exists(path.join(run1, entry)), `missing ${entry}`);
  assert.deepEqual(await listDir(run1), [
    "candidates.csv",
    "config.json",
    "decisions.csv",
    "fields.csv",
    "input",
    "manifest.json",
    "pairs.csv",
    "report.json",
    "summary.md",
    "unresolved.csv",
  ]);

  // originals are untouched and byte-identical to the snapshots
  assert.deepEqual(await fsPromises.readFile(paths.left), leftBefore);
  assert.deepEqual(await fsPromises.readFile(paths.right), rightBefore);
  assert.deepEqual(await fsPromises.readFile(path.join(run1, "input/left.csv")), leftBefore);
  assert.deepEqual(await fsPromises.readFile(path.join(run1, "input/right.csv")), rightBefore);

  const manifest = JSON.parse(await readText(path.join(run1, "manifest.json")));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.engine_version, "0.1.0");
  assert.equal(manifest.left_bytes, leftBefore.length);
  assert.equal(manifest.left_sha256, sha256Hex(leftBefore));
  assert.equal(manifest.right_bytes, rightBefore.length);
  assert.equal(manifest.right_sha256, sha256Hex(rightBefore));
  assert.equal(manifest.parent_run_id, undefined);
  const configBytes = await fsPromises.readFile(path.join(run1, "config.json"));
  assert.equal(manifest.config_sha256, sha256Hex(configBytes));
  assert.equal(manifest.config_bytes, configBytes.length);
  assert.equal(
    manifest.run_id,
    sha256Hex(
      Buffer.from(
        JSON.stringify(["0.1.0", manifest.left_sha256, manifest.right_sha256, manifest.config_sha256]),
        "utf8",
      ),
    ),
  );

  // report.json is the direct locked Result, not a wrapper
  assert.deepEqual(Object.keys(JSON.parse(await readText(path.join(run1, "report.json")))).sort(), [...LINKED_KEYS].sort());

  // the template never prefills an accept action
  const template = parseCsv(await readText(path.join(run1, "decisions.csv")));
  assert.deepEqual(template[0], ["action", "left_id", "right_id", "reason"]);
  assert.ok(template.length > 1, "template should offer suggestions or pending side rows");
  for (const row of template.slice(1)) assert.equal(row[0], "", `prefilled action in ${JSON.stringify(row)}`);

  // edit the cumulative decision file and delete every original path
  const reviewed = path.join(dir, "reviewed.csv");
  await fsPromises.writeFile(
    reviewed,
    'action,left_id,right_id,reason\naccept,L1,R1,"line one\nline two"\nleft_unmatched,L2,,no partner\nright_unmatched,,R2,no partner\n',
  );
  await fsPromises.rm(paths.left);
  await fsPromises.rm(paths.right);
  await fsPromises.rm(paths.config);

  const run2 = path.join(dir, "run-001-reviewed");
  const resolved = cli(["resolve", run1, "--decisions", reviewed, "--out", run2]);
  // human confirmed unmatched records remain reportable business differences
  assert.equal(resolved.status, 1, resolved.stderr);

  const report = JSON.parse(await readText(path.join(run2, "report.json")));
  assert.equal(report.exit_code, 1);
  assert.equal(report.summary.unresolved_count, 0);
  assert.deepEqual(report.pairs.map((pair) => pair.source), ["human_review"]);
  assert.deepEqual(report.summary.per_side.left, { total: 2, paired: 1, unmatched: 1, pending_review: 0, unprocessed: 0 });
  assert.equal(report.decisions.length, 3);
  assert.equal(report.decisions.find((decision) => decision.action === "accept").reason, "line one\nline two");

  const reviewedManifest = JSON.parse(await readText(path.join(run2, "manifest.json")));
  assert.equal(reviewedManifest.run_id, manifest.run_id);
  assert.equal(reviewedManifest.parent_run_id, manifest.run_id);
  assert.equal(reviewedManifest.decisions_sha256, sha256Hex(await fsPromises.readFile(reviewed)));
  assert.deepEqual(await fsPromises.readFile(path.join(run2, "input/left.csv")), leftBefore);
  assert.deepEqual(await fsPromises.readFile(path.join(run2, "config.json")), configBytes);

  // reviewed decisions.csv keeps the applied decisions in order
  const reviewedTemplate = parseCsv(await readText(path.join(run2, "decisions.csv")));
  assert.deepEqual(
    reviewedTemplate.slice(1).map((row) => row[0]).sort(),
    ["accept", "left_unmatched", "right_unmatched"],
  );
  assert.ok(reviewedTemplate.slice(1).every((row) => row.length === 4));

  // the released cumulative file can be replayed without losing review
  const run3 = path.join(dir, "run-001-reviewed-2");
  assert.equal(cli(["resolve", run1, "--decisions", path.join(run2, "decisions.csv"), "--out", run3]).status, 1);
  assert.deepEqual(JSON.parse(await readText(path.join(run3, "report.json"))), report);
});

test("resolve is reproducible and read-only on the source run", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,label\n1,alpha\n", right: "id,label\n2,alpha\n", config: PENDING_CONFIG });
  const run1 = path.join(dir, "run-001");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]).status, 1);

  const decisions = path.join(dir, "decisions.csv");
  await fsPromises.writeFile(decisions, "action,left_id,right_id,reason\naccept,L1,R1,verified\n");
  const before = await hashTree(run1);
  const run2 = path.join(dir, "run-002");
  const run3 = path.join(dir, "run-003");
  assert.equal(cli(["resolve", run1, "--decisions", decisions, "--out", run2]).status, 0);
  assert.equal(cli(["resolve", run1, "--decisions", decisions, "--out", run3]).status, 0);
  assert.equal(await hashTree(run1), before, "resolve must not modify the source run");
  for (const name of RUN_FILES) {
    if (name === "manifest.json") continue; // created is provenance, not semantics
    assert.deepEqual(
      await fsPromises.readFile(path.join(run2, name)),
      await fsPromises.readFile(path.join(run3, name)),
      `${name} must be reproducible`,
    );
  }
  const stripCreated = async (run) => {
    const parsed = JSON.parse(await readText(path.join(run, "manifest.json")));
    const { created, ...rest } = parsed;
    return rest;
  };
  assert.deepEqual(await stripCreated(run2), await stripCreated(run3), "manifest semantics must be reproducible");

  // a previously reviewed run does not lock the editable cumulative decisions
  await fsPromises.writeFile(decisions, "action,left_id,right_id,reason\naccept,L1,R1,verified by second reviewer\n");
  const run4 = path.join(dir, "run-004");
  assert.equal(cli(["resolve", run2, "--decisions", decisions, "--out", run4]).status, 0);
  const manifest2 = JSON.parse(await readText(path.join(run2, "manifest.json")));
  const manifest4 = JSON.parse(await readText(path.join(run4, "manifest.json")));
  assert.equal(manifest4.parent_run_id, manifest2.run_id);
  assert.equal(manifest4.run_id, manifest2.run_id);
  assert.notEqual(manifest4.decisions_sha256, manifest2.decisions_sha256);
});

// ---------------------------------------------------------------------------
// strict arguments
// ---------------------------------------------------------------------------

test("strict argument parsing rejects unknown, repeated, missing and extra operands", async () => {
  const cases = [
    [],
    ["frobnicate"],
    ["compare", "a.csv", "b.csv", "--out", "run"],
    ["compare", "a.csv", "b.csv", "--config", "c.json"],
    ["compare", "a.csv", "b.csv", "--config", "c.json", "--out", "run", "extra"],
    ["compare", "a.csv", "b.csv", "--config", "c.json", "--out", "run", "--wat", "x"],
    ["compare", "a.csv", "b.csv", "--config", "c.json", "--config", "d.json", "--out", "run"],
    ["compare", "a.csv", "--config", "c.json", "--out", "run"],
    ["check-config"],
    ["check-config", "c.json", "--out", "x"],
    ["resolve", "run-001", "--out", "reviewed"],
    ["init-config", "left.csv", "right.csv"],
    ["compare", "a.csv", "b.csv", "--config", "c.json", "--out", "run", "--max-input-bytes", "5"],
    ["COMPARE", "a.csv", "b.csv", "--config", "c.json", "--out", "run"],
  ];
  for (const args of cases) {
    const result = cli(args);
    assert.equal(result.status, 2, `expected exit 2 for ${JSON.stringify(args)}`);
    assert.equal(failingError(result.stderr).code, "invalid_arguments", JSON.stringify(args));
    assert.equal(result.stdout, "");
  }
});

test("check-config prints canonical normalized config and rejects drafts", async () => {
  const dir = await mkTmp();
  const configPath = path.join(dir, "rules.json");
  await fsPromises.writeFile(
    configPath,
    JSON.stringify({ schema_version: 1, fields: [{ name: "status", left: "status", right: "status", type: "text" }], key: [] }),
  );
  const checked = cli(["check-config", configPath]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(checked.stdout.endsWith("}\n"));
  assert.ok(!checked.stdout.endsWith("\n\n"), "exactly one final newline");
  assert.ok(!checked.stdout.includes("\n  "), "canonical output is not indented");
  const parsed = JSON.parse(checked.stdout);
  assert.equal(parsed.draft, false);
  assert.equal(parsed.fields[0].trim_ascii, false);

  const draftPath = path.join(dir, "draft.json");
  await fsPromises.writeFile(
    draftPath,
    canonicalJsonStringify({ ...parsed, draft: true, fields: [{ ...parsed.fields[0], type: null }] }),
  );
  const draft = cli(["check-config", draftPath]);
  assert.equal(draft.status, 2);
  assert.equal(failingError(draft.stderr).code, "invalid_config");

  const missing = cli(["check-config", path.join(dir, "nope.json")]);
  assert.equal(missing.status, 2);
  assert.equal(failingError(missing.stderr).phase, "input");
});

// ---------------------------------------------------------------------------
// encoding: invalid UTF-8 and BOM policy
// ---------------------------------------------------------------------------

test("invalid UTF-8 is fatal and publishes nothing", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, {
    leftBytes: Buffer.from([0x69, 0x64, 0x0a, 0xff, 0xfe, 0x0a]),
    right: "id\n1\n",
    config: { schema_version: 1, fields: [TEXT_ID], key: ["id"] },
  });
  const out = path.join(dir, "run");
  const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
  assert.equal(result.status, 2);
  const error = failingError(result.stderr);
  assert.equal(error.code, "invalid_encoding");
  assert.equal(error.side, "left");
  assert.equal(await exists(out), false, "no pseudo-success directory");
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("an initial BOM is accepted and preserved in snapshot bytes and hash", async () => {
  const dir = await mkTmp();
  const leftBytes = Buffer.concat([BOM, Buffer.from("id,amount\n001,100.00\n", "utf8")]);
  const rightBytes = Buffer.concat([BOM, Buffer.from("id,amount\n001,100\n", "utf8")]);
  const paths = await writeFixture(dir, { leftBytes, rightBytes, config: EQUAL_CONFIG });
  const out = path.join(dir, "run");
  const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fsPromises.readFile(path.join(out, "input/left.csv")), leftBytes);
  const manifest = JSON.parse(await readText(path.join(out, "manifest.json")));
  assert.equal(manifest.left_sha256, sha256Hex(leftBytes), "hash covers the raw bytes including the BOM");
  assert.equal(manifest.left_bytes, leftBytes.length);
});

test("double and interior byte-order marks are rejected", async () => {
  const dir = await mkTmp();
  const config = { schema_version: 1, fields: [TEXT_ID], key: ["id"] };
  const doubleBom = Buffer.concat([BOM, BOM, Buffer.from("id\n1\n", "utf8")]);
  const interiorBom = Buffer.concat([Buffer.from("i", "utf8"), BOM, Buffer.from("d\n1\n", "utf8")]);
  for (const [index, bytes] of [doubleBom, interiorBom].entries()) {
    const paths = await writeFixture(dir, { leftBytes: bytes, right: "id\n1\n", config });
    const out = path.join(dir, `run-${index}`);
    const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
    assert.equal(result.status, 2, `fixture ${index}`);
    const error = failingError(result.stderr);
    assert.equal(error.code, "invalid_encoding");
    assert.equal(error.side, "left");
    assert.equal(await exists(out), false);
  }
});

test("the raw byte budget is enforced by an injectable internal limit, not a CLI flag", async () => {
  const dir = await mkTmp();
  const config = { schema_version: 1, fields: [TEXT_ID], key: ["id"] };
  const paths = await writeFixture(dir, { left: "id\n1\n", right: "id\n1\n", config });
  const over = await quietRun(
    ["compare", paths.left, paths.right, "--config", paths.config, "--out", path.join(dir, "over")],
    { limits: { maxInputBytes: 4 } },
  );
  assert.equal(over.code, 2);
  assert.equal(JSON.parse(over.stderr).error.code, "input_limit_exceeded");
  assert.equal(await exists(path.join(dir, "over")), false);

  const exactPaths = await writeFixture(path.join(dir, "exact"), { left: "id\n1\n", right: "id\n1\n", config });
  const configSize = (await fsPromises.stat(exactPaths.config)).size;
  const exact = await quietRun(
    ["compare", exactPaths.left, exactPaths.right, "--config", exactPaths.config, "--out", path.join(dir, "exact-run")],
    { limits: { maxInputBytes: configSize } },
  );
  assert.equal(exact.code, 0, exact.stderr);

  // the budget counts raw UTF-8 bytes, never JavaScript string length
  const wide = Buffer.from(`id,note\n1,${"é".repeat(150)}\n`, "utf8");
  assert.ok(configSize < wide.length - 1, "fixture must exceed the configuration file");
  const widePaths = await writeFixture(path.join(dir, "wide"), { leftBytes: wide, right: "id\n1\n", config });
  const byteOver = await quietRun(
    ["compare", widePaths.left, widePaths.right, "--config", widePaths.config, "--out", path.join(dir, "wide-over")],
    { limits: { maxInputBytes: wide.length - 1 } },
  );
  assert.equal(byteOver.code, 2);
  assert.equal(JSON.parse(byteOver.stderr).error.code, "input_limit_exceeded");
  const byteExact = await quietRun(
    ["compare", widePaths.left, widePaths.right, "--config", widePaths.config, "--out", path.join(dir, "wide-exact")],
    { limits: { maxInputBytes: wide.length } },
  );
  // parsing succeeded under the exact budget; exit 1 only reflects the unmapped note column
  assert.equal(byteExact.code, 1, byteExact.stderr);
});

test("cell budgets stay with the MoonBit core and are reported to the CLI", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, {
    left: `id,note\n1,${"a".repeat(65537)}\n`,
    right: "id,note\n1,x\n",
    config: { schema_version: 1, fields: [{ name: "id", left: "id", right: "id", type: "text" }], key: ["id"] },
  });
  const out = path.join(dir, "run");
  const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
  assert.equal(result.status, 2);
  const error = failingError(result.stderr);
  assert.equal(error.code, "input_limit_exceeded");
  assert.equal(error.phase, "input");
  assert.equal(error.side, "left");
  assert.equal(error.record, 2);
  assert.equal(error.field, "note");
  assert.equal(await exists(out), false);
});

// ---------------------------------------------------------------------------
// output path protection
// ---------------------------------------------------------------------------

test("output destinations must be absent or empty and never alias inputs", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });

  const nonempty = path.join(dir, "nonempty");
  await fsPromises.mkdir(nonempty);
  await fsPromises.writeFile(path.join(nonempty, "keep.txt"), "keep");
  const blocked = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", nonempty]);
  assert.equal(blocked.status, 2);
  assert.equal(failingError(blocked.stderr).code, "output_conflict");
  assert.deepEqual(await listDir(nonempty), ["keep.txt"]);

  const asInput = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", paths.right]);
  assert.equal(asInput.status, 2);
  assert.equal(failingError(asInput.stderr).code, "output_conflict");
  assert.equal(await readText(paths.right), "id,amount\n001,100\n");

  const asConfig = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", paths.config]);
  assert.equal(asConfig.status, 2);
  assert.equal(failingError(asConfig.stderr).code, "output_conflict");

  const empty = path.join(dir, "empty");
  await fsPromises.mkdir(empty);
  const allowed = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", empty]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.ok(await exists(path.join(empty, "report.json")));
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("init-config never overwrites an existing file or an input alias", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id\n1\n", right: "id\n1\n", config: EQUAL_CONFIG });
  const leftBefore = await fsPromises.readFile(paths.left);

  const aliased = cli(["init-config", paths.left, paths.right, "--out", paths.left]);
  assert.equal(aliased.status, 2);
  assert.equal(failingError(aliased.stderr).code, "output_conflict");
  assert.deepEqual(await fsPromises.readFile(paths.left), leftBefore);

  const fresh = path.join(dir, "draft.json");
  assert.equal(cli(["init-config", paths.left, paths.right, "--out", fresh]).status, 0);
  const text = await readText(fresh);
  assert.equal(text, canonicalJsonStringify(JSON.parse(text)));
  const draft = JSON.parse(text);
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.key, []);
  assert.ok(draft.fields.every((field) => field.type === null));

  const again = cli(["init-config", paths.left, paths.right, "--out", fresh]);
  assert.equal(again.status, 2);
  assert.equal(failingError(again.stderr).code, "output_conflict");
  assert.equal(cli(["check-config", fresh]).status, 2);
});

test("resolve refuses destinations inside or aliasing the source run", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,label\n1,alpha\n", right: "id,label\n2,alpha\n", config: PENDING_CONFIG });
  const run1 = path.join(dir, "run-001");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]).status, 1);
  const decisions = path.join(dir, "d.csv");
  await fsPromises.writeFile(decisions, "action,left_id,right_id,reason\n");
  const before = await hashTree(run1);

  const nested = cli(["resolve", run1, "--decisions", decisions, "--out", path.join(run1, "nested")]);
  assert.equal(nested.status, 2);
  assert.equal(failingError(nested.stderr).code, "output_conflict");

  const same = cli(["resolve", run1, "--decisions", decisions, "--out", run1]);
  assert.equal(same.status, 2);
  assert.equal(failingError(same.stderr).code, "output_conflict");

  const alias = path.join(dir, "alias");
  await fsPromises.symlink(run1, alias);
  const viaSymlink = cli(["resolve", run1, "--decisions", decisions, "--out", path.join(alias, "nested")]);
  assert.equal(viaSymlink.status, 2);
  assert.equal(failingError(viaSymlink.stderr).code, "output_conflict");

  const elsewhere = path.join(dir, "elsewhere");
  await fsPromises.mkdir(elsewhere);
  const directSymlink = path.join(dir, "symlink-out");
  await fsPromises.symlink(elsewhere, directSymlink);
  const symlinkOut = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", directSymlink]);
  assert.equal(symlinkOut.status, 2);
  assert.equal(failingError(symlinkOut.stderr).code, "output_conflict");
  assert.deepEqual(await listDir(elsewhere), []);

  assert.equal(await hashTree(run1), before, "source run must stay immutable");
});

test("output paths with non ASCII segments work", async () => {
  const dir = await mkTmp();
  const nested = path.join(dir, "表 目录", "输入");
  const paths = await writeFixture(nested, {
    left: "id,label\n1,café ☕\n",
    right: "id,label\n1,café ☕\n",
    config: {
      schema_version: 1,
      fields: [
        { name: "id", left: "id", right: "id", type: "text", compare: false },
        { name: "label", left: "label", right: "label", type: "text" },
      ],
      key: ["id"],
    },
  });
  const out = path.join(dir, "输出 运行");
  const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readText(path.join(out, "report.json")));
  assert.equal(report.fields[0].field, "label");
  assert.equal(report.fields[0].left_raw, "café ☕");
});

// ---------------------------------------------------------------------------
// write failures, staging cleanup and advisory disk precheck
// ---------------------------------------------------------------------------

test("a write failure publishes nothing and removes only its own staging", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const out = path.join(dir, "run");
  const base = baseFs();
  const result = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", out], {
    fs: {
      ...base,
      open: async (target, flags, mode) => {
        if (String(target).endsWith("report.json") && flags === "wx") throw errorWithCode("ENOSPC", "injected write failure");
        return base.open(target, flags, mode);
      },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "io_error");
  assert.equal(await exists(out), false, "no partial destination");
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("a publish failure cleans staging rather than leaving a partial run", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const out = path.join(dir, "run");
  const base = baseFs();
  const result = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", out], {
    fs: {
      ...base,
      rename: async () => {
        throw errorWithCode("EXDEV", "injected publish failure");
      },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "io_error");
  assert.equal(await exists(out), false);
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("an fsync failure aborts publication", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const out = path.join(dir, "run");
  const base = baseFs();
  const result = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", out], {
    fs: {
      ...base,
      open: async (target, flags, mode) => {
        const handle = await base.open(target, flags, mode);
        if (!String(target).endsWith("pairs.csv")) return handle;
        return new Proxy(handle, {
          get(inner, key) {
            if (key === "sync") return async () => {
              throw errorWithCode("EIO", "injected fsync failure");
            };
            const value = inner[key];
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "io_error");
  assert.equal(await exists(out), false);
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("the disk precheck is advisory: it blocks on a negative statfs and continues when unsupported", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const blockedOut = path.join(dir, "blocked");
  const blocked = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", blockedOut], {
    statfs: async () => ({ bsize: 4096, blocks: 100, bfree: 0, bavail: 0, files: 0, ffree: 0 }),
  });
  assert.equal(blocked.code, 2);
  assert.equal(JSON.parse(blocked.stderr).error.code, "disk_space_insufficient");
  assert.equal(await exists(blockedOut), false);
  assert.deepEqual(await stagingLeftovers(dir), []);

  const unsupportedOut = path.join(dir, "unsupported");
  const unsupported = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", unsupportedOut], {
    statfs: async () => {
      throw errorWithCode("ENOSYS", "statfs not supported");
    },
  });
  assert.equal(unsupported.code, 0, unsupported.stderr);
  assert.match(unsupported.stderr, /disk space precheck/i);
  assert.ok(await exists(path.join(unsupportedOut, "report.json")));

  const partialOut = path.join(dir, "partial");
  const partial = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", partialOut], {
    statfs: async () => ({ bsize: 4096 }),
  });
  assert.equal(partial.code, 0, partial.stderr);
  assert.match(partial.stderr, /disk space precheck/i);

  // a real filesystem error is not an unsupported platform
  const brokenOut = path.join(dir, "broken");
  const broken = await quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", brokenOut], {
    statfs: async () => {
      throw errorWithCode("EIO", "disk is failing");
    },
  });
  assert.equal(broken.code, 2);
  assert.equal(JSON.parse(broken.stderr).error.code, "io_error");
  assert.equal(await exists(brokenOut), false);
});

// ---------------------------------------------------------------------------
// canonical configuration
// ---------------------------------------------------------------------------

test("canonical config sorts numeric looking keys lexically and keeps arrays stable", async () => {
  const dir = await mkTmp();
  const configPath = path.join(dir, "rules.json");
  await fsPromises.writeFile(
    configPath,
    JSON.stringify({
      schema_version: 1,
      fields: [
        {
          name: "status",
          left: "status",
          right: "status",
          type: "text",
          left_values: { 10: "ten", 2: "two", a: "A" },
          right_values: { z: "Z", b: "B" },
        },
        { name: "id", left: "id", right: "id", type: "text", compare: false },
      ],
      key: ["status", "id"],
      ignore_left: ["note"],
    }),
  );
  const checked = cli(["check-config", configPath]);
  assert.equal(checked.status, 0, checked.stderr);
  const canonical = checked.stdout;
  const ten = canonical.indexOf('"10"');
  const two = canonical.indexOf('"2"');
  assert.ok(ten !== -1 && two !== -1 && ten < two, "numeric looking keys sort lexically, not numerically");
  assert.ok(canonical.indexOf('"a"') > two, "object keys are sorted lexically");
  assert.deepEqual(JSON.parse(canonical).key, ["status", "id"], "array order is stable");
  assert.deepEqual(
    JSON.parse(canonical).fields.map((field) => field.name),
    ["status", "id"],
  );
  assert.ok(!canonical.includes("\n ") && !canonical.includes("\n\t"), "no indentation");
  assert.equal(canonical.length - canonical.trimEnd().length, 1, "exactly one final newline");
  assert.equal(canonical, canonicalJsonStringify(JSON.parse(canonical)), "canonical form is idempotent");
  assert.notEqual(JSON.stringify(JSON.parse(canonical)), canonical, "an explicit writer is required");
});

// ---------------------------------------------------------------------------
// manifest fingerprint verification
// ---------------------------------------------------------------------------

async function preparedRun(dir, decisionsContent = "action,left_id,right_id,reason\naccept,L1,R1,verified\n") {
  const paths = await writeFixture(dir, { left: "id,label\n1,alpha\n", right: "id,label\n2,alpha\n", config: PENDING_CONFIG });
  const run1 = path.join(dir, "run-001");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]).status, 1);
  const decisions = path.join(dir, "decisions.csv");
  await fsPromises.writeFile(decisions, decisionsContent);
  return { dir, paths, run1, decisions };
}

async function rewriteManifest(run, mutate) {
  const manifestPath = path.join(run, "manifest.json");
  const manifest = JSON.parse(await readText(manifestPath));
  mutate(manifest);
  await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function recomputeRunId(manifest) {
  return sha256Hex(
    Buffer.from(JSON.stringify([manifest.engine_version, manifest.left_sha256, manifest.right_sha256, manifest.config_sha256]), "utf8"),
  );
}

test("resolve verifies fingerprints and engine version before invoking the engine", async () => {
  const cases = [
    {
      name: "snapshot bytes",
      mutate: async (run) => fsPromises.writeFile(path.join(run, "input/left.csv"), "id,label\n1,tampered\n"),
      code: "fingerprint_mismatch",
    },
    {
      name: "recorded byte size",
      mutate: (run) => rewriteManifest(run, (manifest) => {
        manifest.left_bytes += 1;
      }),
      code: "fingerprint_mismatch",
    },
    {
      name: "input hash",
      mutate: (run) => rewriteManifest(run, (manifest) => {
        manifest.left_sha256 = "0".repeat(64);
      }),
      code: "fingerprint_mismatch",
    },
    {
      name: "config bytes",
      mutate: async (run) => {
        const config = JSON.parse(await readText(path.join(run, "config.json")));
        config.fields[0].name = "renamed";
        await fsPromises.writeFile(path.join(run, "config.json"), JSON.stringify(config));
      },
      code: "config_digest_mismatch",
    },
    {
      name: "non canonical config",
      mutate: async (run) => {
        const pretty = `${JSON.stringify(JSON.parse(await readText(path.join(run, "config.json"))), null, 4)}\n`;
        await fsPromises.writeFile(path.join(run, "config.json"), pretty);
        await rewriteManifest(run, (manifest) => {
          manifest.config_sha256 = sha256Hex(Buffer.from(pretty, "utf8"));
          manifest.config_bytes = Buffer.byteLength(pretty, "utf8");
          manifest.run_id = recomputeRunId(manifest);
        });
      },
      code: "invalid_manifest",
    },
    {
      name: "engine version",
      mutate: (run) => rewriteManifest(run, (manifest) => {
        manifest.engine_version = "9.9.9";
        manifest.run_id = recomputeRunId(manifest);
      }),
      code: "unsupported_engine_version",
    },
    {
      name: "run id",
      mutate: (run) => rewriteManifest(run, (manifest) => {
        manifest.run_id = manifest.run_id.replace(/^./, manifest.run_id[0] === "a" ? "b" : "a");
      }),
      code: "run_id_mismatch",
    },
    {
      name: "manifest structure",
      mutate: async (run) => fsPromises.writeFile(path.join(run, "manifest.json"), '{"schema_version":1}\n'),
      code: "invalid_manifest",
    },
  ];

  for (const scenario of cases) {
    const dir = await mkTmp();
    const { run1, decisions } = await preparedRun(dir);
    await scenario.mutate(run1);
    const out = path.join(dir, "reviewed");
    let invoked = 0;
    const result = await quietRun(["resolve", run1, "--decisions", decisions, "--out", out], {
      invoke: () => {
        invoked += 1;
        throw new Error("engine must not be invoked for rejected material");
      },
    });
    assert.equal(result.code, 2, `${scenario.name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stderr).error.code, scenario.code, scenario.name);
    assert.equal(invoked, 0, `${scenario.name} must fail before the engine runs`);
    assert.equal(await exists(out), false, scenario.name);
  }
});

test("resolve rejects a missing snapshot or manifest", async () => {
  const dir = await mkTmp();
  const { run1, decisions } = await preparedRun(dir);
  await fsPromises.rm(path.join(run1, "input/right.csv"));
  const out = path.join(dir, "reviewed");
  const result = cli(["resolve", run1, "--decisions", decisions, "--out", out]);
  assert.equal(result.status, 2);
  assert.equal(failingError(result.stderr).phase, "input");
  assert.equal(await exists(out), false);
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test("malformed decision files are rejected without publishing", async () => {
  const dir = await mkTmp();
  const { run1, decisions } = await preparedRun(dir);
  const cases = [
    ["action,left_id,wrong,reason\n", "invalid_decision_schema"],
    ["action,left_id,right_id,reason\nbogus,L1,R1,\n", "invalid_decision_action"],
    ["action,left_id,right_id,reason\naccept,L1,,\n", "invalid_decision"],
    ["action,left_id,right_id,reason\naccept,L01,R1,\n", "invalid_decision"],
    ["action,left_id,right_id,reason\naL1,R1,\n", "invalid_row_width"],
    ["", "invalid_csv"],
    ["action,left_id,right_id,reason\naccept,L1,R1,\nreject,L1,R1,\n", "conflicting_decisions"],
  ];
  for (const [index, [content, code]] of cases.entries()) {
    await fsPromises.writeFile(decisions, content);
    const out = path.join(dir, `out-${index}`);
    const result = cli(["resolve", run1, "--decisions", decisions, "--out", out]);
    assert.equal(result.status, 2, `${code}: ${result.stderr}`);
    assert.equal(failingError(result.stderr).code, code, `expected ${code} for ${JSON.stringify(content)}`);
    assert.equal(await exists(out), false, code);
  }
});

test("a blank cumulative template replays as unfinished review", async () => {
  const dir = await mkTmp();
  const { run1 } = await preparedRun(dir);
  const inputs = await writeFixture(path.join(dir, "inputs"), {
    left: "id,label\n1,alpha\n",
    right: "id,label\n2,alpha\n",
    config: PENDING_CONFIG,
  });
  const compareOut = path.join(dir, "template");
  assert.equal(cli(["compare", inputs.left, inputs.right, "--config", inputs.config, "--out", compareOut]).status, 1);

  const out = path.join(dir, "blank-resolved");
  const result = cli(["resolve", run1, "--decisions", path.join(compareOut, "decisions.csv"), "--out", out]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(await readText(path.join(out, "report.json")));
  assert.equal(report.decisions.length, 0);
  assert.equal(report.summary.unresolved_count, 2);
});

test("decision reasons with commas, quotes and newlines survive into evidence", async () => {
  const dir = await mkTmp();
  const reason = 'needs "manual" review,\nsecond line';
  const { run1, decisions } = await preparedRun(
    dir,
    'action,left_id,right_id,reason\naccept,L1,R1,"needs ""manual"" review,\nsecond line"\n',
  );
  const out = path.join(dir, "reviewed");
  const result = cli(["resolve", run1, "--decisions", decisions, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readText(path.join(out, "report.json")));
  assert.equal(report.decisions[0].reason, reason);
  const decisionsCsv = await readText(path.join(out, "decisions.csv"));
  assert.deepEqual(parseCsv(decisionsCsv)[1], ["accept", "L1", "R1", reason]);
  assert.ok(decisionsCsv.includes('"needs ""manual"" review,\nsecond line"'));
});

// ---------------------------------------------------------------------------
// exit codes and artifact publication
// ---------------------------------------------------------------------------

async function writeManyPairs(dir, count) {
  let left = "id,label\n";
  let right = "id,label\n";
  for (let index = 1; index <= count; index += 1) {
    left += `L${index},same\n`;
    right += `R${index},same\n`;
  }
  return writeFixture(dir, {
    left,
    right,
    config: {
      schema_version: 1,
      fields: [
        { name: "id", left: "id", right: "id", type: "text", compare: false },
        { name: "label", left: "label", right: "label", type: "text" },
      ],
      key: [],
      candidates: { fields: [{ field: "label", metric: "exact", weight: 10000 }], threshold: 10000 },
    },
  });
}

test("exit priority 2 > 3 > 1 > 0 publishes artifacts for 0, 1 and 3", async () => {
  const dir = await mkTmp();

  const zeroPaths = await writeFixture(path.join(dir, "zero"), {
    left: "id,amount\n001,100.00\n",
    right: "id,amount\n001,100\n",
    config: EQUAL_CONFIG,
  });
  const zero = cli(["compare", zeroPaths.left, zeroPaths.right, "--config", zeroPaths.config, "--out", path.join(dir, "zero-run")]);
  assert.equal(zero.status, 0, zero.stderr);
  for (const entry of RUN_FILES) assert.ok(await exists(path.join(dir, "zero-run", entry)));

  const onePaths = await writeFixture(path.join(dir, "one"), {
    left: "id,amount\n001,100.00\n",
    right: "id,amount\n001,100\n2,7\n",
    config: EQUAL_CONFIG,
  });
  const one = cli(["compare", onePaths.left, onePaths.right, "--config", onePaths.config, "--out", path.join(dir, "one-run")]);
  assert.equal(one.status, 1, one.stderr);
  for (const entry of RUN_FILES) assert.ok(await exists(path.join(dir, "one-run", entry)));

  const threePaths = await writeManyPairs(path.join(dir, "three"), 101);
  const threeOut = path.join(dir, "three-run");
  const three = cli(["compare", threePaths.left, threePaths.right, "--config", threePaths.config, "--out", threeOut]);
  assert.equal(three.status, 3, three.stderr);
  for (const entry of RUN_FILES) assert.ok(await exists(path.join(threeOut, entry)));
  const threeReport = JSON.parse(await readText(path.join(threeOut, "report.json")));
  assert.equal(threeReport.computation.status, "incomplete");
  assert.equal(threeReport.summary.per_side.left.unprocessed, 101);
  assert.ok(threeReport.computation.issues.some((issue) => issue.code === "candidate_component_limit_exceeded"));

  // a host level failure outranks an already computed 3
  const blockedOut = path.join(dir, "blocked-three");
  await fsPromises.mkdir(blockedOut);
  await fsPromises.writeFile(path.join(blockedOut, "keep"), "keep");
  const blocked = cli(["compare", threePaths.left, threePaths.right, "--config", threePaths.config, "--out", blockedOut]);
  assert.equal(blocked.status, 2);
  assert.equal(failingError(blocked.stderr).code, "output_conflict");
  assert.deepEqual(await listDir(blockedOut), ["keep"]);

  // a later I/O failure also outranks a computed 1
  const base = baseFs();
  const lateFailure = await quietRun(
    ["compare", onePaths.left, onePaths.right, "--config", onePaths.config, "--out", path.join(dir, "late")],
    {
      fs: {
        ...base,
        rename: async () => {
          throw errorWithCode("EIO", "injected late failure");
        },
      },
    },
  );
  assert.equal(lateFailure.code, 2);
  assert.equal(await exists(path.join(dir, "late")), false);
});

test("unprocessed records stay visible after a fully reviewed incomplete run", async () => {
  const dir = await mkTmp();
  const paths = await writeManyPairs(dir, 101);
  const run1 = path.join(dir, "run-001");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]).status, 3);

  const rows = [];
  for (let index = 1; index <= 101; index += 1) rows.push(`accept,L${index},R${index},manual pair ${index}`);
  const decisions = path.join(dir, "decisions.csv");
  await fsPromises.writeFile(decisions, `action,left_id,right_id,reason\n${rows.join("\n")}\n`);
  const reviewed = path.join(dir, "run-002");
  const result = cli(["resolve", run1, "--decisions", decisions, "--out", reviewed]);
  assert.equal(result.status, 3, result.stderr);
  const report = JSON.parse(await readText(path.join(reviewed, "report.json")));
  assert.equal(report.computation.status, "incomplete");
  assert.equal(report.summary.unresolved_count, 0);
  assert.equal(report.summary.per_side.left.paired, 101);
  assert.equal(report.summary.per_side.left.unprocessed, 0);
  assert.ok(report.computation.issues.some((issue) => issue.code === "candidate_component_limit_exceeded"));
  assert.equal(report.pairs.length, 101);
});

test("a fully reviewed run with no usable key exits zero", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, {
    left: "id,label\n1,alpha\n2,beta\n",
    right: "id,label\n9,alpha\n8,beta\n",
    config: PENDING_CONFIG,
  });
  const run1 = path.join(dir, "run-001");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", run1]).status, 1);
  const decisions = path.join(dir, "decisions.csv");
  await fsPromises.writeFile(decisions, "action,left_id,right_id,reason\naccept,L1,R1,a\naccept,L2,R2,b\n");
  const reviewed = path.join(dir, "run-002");
  assert.equal(cli(["resolve", run1, "--decisions", decisions, "--out", reviewed]).status, 0);
  const report = JSON.parse(await readText(path.join(reviewed, "report.json")));
  assert.equal(report.exit_code, 0);
  assert.equal(report.summary.unresolved_count, 0);
  assert.equal(report.summary.per_side.left.paired, 2);
  assert.ok(report.key_issues.length > 0, "historical key diagnostics stay visible");
});

// ---------------------------------------------------------------------------
// exports: report, csv and markdown consistency
// ---------------------------------------------------------------------------

test("every export is consistent with the locked Result", async () => {
  const dir = await mkTmp();
  const left = 'id,note,amount\n1,"multi\nline, ""quoted""",100.00\n2,plain,7\n';
  const right = 'id,note,amount\n1,"multi\nline, ""quoted""",100\n9,other,7\n';
  const config = {
    schema_version: 1,
    fields: [
      { name: "id", left: "id", right: "id", type: "text", compare: false },
      { name: "note", left: "note", right: "note", type: "text" },
      { name: "amount", left: "amount", right: "amount", type: "decimal" },
    ],
    key: ["id"],
  };
  const paths = await writeFixture(dir, { left, right, config });
  const out = path.join(dir, "run");
  const result = cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]);
  assert.equal(result.status, 1, result.stderr);

  const report = JSON.parse(await readText(path.join(out, "report.json")));
  const bridge = await import("../_build/js/debug/build/cmd/bridge/bridge.js");
  const direct = JSON.parse(bridge.invoke_bridge(JSON.stringify({ op: "compare", left_csv: left, right_csv: right, config }))).result;
  assert.deepEqual(report, direct, "report.json is the engine Result verbatim");
  assert.equal(report.summary.unresolved_count, 2);

  const pairs = parseCsv(await readText(path.join(out, "pairs.csv")));
  assert.deepEqual(pairs[0], ["left_id", "right_id", "source", "reason", "override"]);
  assert.equal(pairs.length - 1, report.pairs.length);
  report.pairs.forEach((pair, index) => {
    assert.deepEqual(pairs[index + 1], [pair.left_id, pair.right_id, pair.source, pair.reason, String(pair.override)]);
  });

  const fields = parseCsv(await readText(path.join(out, "fields.csv")));
  assert.equal(fields.length - 1, report.fields.length);
  const evidenceIndex = fields[0].indexOf("evidence");
  const rawIndex = fields[0].indexOf("left_raw");
  assert.ok(evidenceIndex > 0, "fields.csv keeps lossless evidence");
  report.fields.forEach((field, index) => {
    assert.deepEqual(JSON.parse(fields[index + 1][evidenceIndex]), field, "field evidence must be lossless");
    assert.equal(fields[index + 1][0], field.left_id);
    assert.equal(fields[index + 1][rawIndex], field.left_raw);
  });
  assert.ok(report.fields.some((field) => field.left_raw.includes("multi\nline")), "multiline values are compared");

  const candidates = parseCsv(await readText(path.join(out, "candidates.csv")));
  assert.equal(candidates.length - 1, report.candidates.length);
  assert.ok(candidates[0].includes("evidence"));

  const unresolved = parseCsv(await readText(path.join(out, "unresolved.csv")));
  assert.deepEqual(unresolved[0], ["side", "id", "record", "status", "reason"]);
  const expectedUnresolved = report.records.filter((record) => ["pending_review", "unprocessed"].includes(record.status));
  assert.equal(unresolved.length - 1, expectedUnresolved.length);
  assert.equal(unresolved.length - 1, report.summary.unresolved_count);

  const decisions = parseCsv(await readText(path.join(out, "decisions.csv")));
  assert.deepEqual(decisions[0], ["action", "left_id", "right_id", "reason"]);
  assert.ok(decisions.slice(1).every((row) => row[0] === ""));

  const summary = await readText(path.join(out, "summary.md"));
  assert.match(summary, /^# Reconciliation summary/m);
  assert.match(summary, /engine version: 0\.1\.0/);
  assert.match(summary, /computation status: complete/);
  assert.match(summary, /unresolved records: 2/);
  assert.match(summary, /^\| left \| 2 \| 1 \| 0 \| 1 \| 0 \|$/m);
  assert.match(summary, /^\| right \| 2 \| 1 \| 0 \| 1 \| 0 \|$/m);
  assert.match(summary, /^\| equal \| 1 \|$/m);
  assert.match(summary, /^\| equivalent_by_rule \| 1 \|$/m);
  assert.ok(!/all reconciled/i.test(summary));
});

test("markdown escapes source values that could corrupt the layout", async () => {
  const dir = await mkTmp();
  const left = 'id,"we|ird\nname"\n1,x\n';
  const right = "id,note\n1,y\n";
  const paths = await writeFixture(dir, {
    left,
    right,
    config: { schema_version: 1, fields: [TEXT_ID], key: ["id"] },
  });
  const out = path.join(dir, "run");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]).status, 1);
  const summary = await readText(path.join(out, "summary.md"));
  assert.ok(summary.includes("we\\|ird<br>name"), "pipes and newlines from source headers must be escaped");
  assert.ok(!summary.includes("we|ird"), "raw pipe must never reach the report");
  assert.match(summary, /unmapped left/);
  assert.match(summary, /unmapped right: note/);
});

test("summary reports computation coverage separately from unresolved differences", async () => {
  const dir = await mkTmp();
  const paths = await writeManyPairs(path.join(dir, "in"), 101);
  const out = path.join(dir, "run");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]).status, 3);
  const summary = await readText(path.join(out, "summary.md"));
  assert.match(summary, /computation status: incomplete/);
  assert.match(summary, /candidate_component_limit_exceeded/);
  assert.match(summary, /unresolved records: 202/);
  assert.ok(!/all reconciled/i.test(summary));
});

test("init-config output is canonical and round-trips through check-config once edited", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,name\n1,widget\n", right: "id,label\n1,widget\n", config: EQUAL_CONFIG });
  const draftPath = path.join(dir, "draft.json");
  assert.equal(cli(["init-config", paths.left, paths.right, "--out", draftPath]).status, 0);
  const text = await readText(draftPath);
  assert.equal(text, canonicalJsonStringify(JSON.parse(text)));

  const edited = JSON.parse(text);
  edited.draft = false;
  edited.fields = [
    { ...edited.fields.find((field) => field.left === "id" && field.right === "id"), type: "text" },
    { ...edited.fields.find((field) => field.left === "name"), right: "label", type: "text", compare: true },
  ];
  edited.key = ["id"];
  const editedPath = path.join(dir, "edited.json");
  await fsPromises.writeFile(editedPath, JSON.stringify(edited, null, 2));
  const checked = cli(["check-config", editedPath]);
  assert.equal(checked.status, 0, checked.stderr);
  const compared = cli(["compare", paths.left, paths.right, "--config", editedPath, "--out", path.join(dir, "run")]);
  assert.equal(compared.status, 0, compared.stderr);
});

test("a checkout without a built bridge fails with an actionable error", async () => {
  const dir = await mkTmp();
  const checkout = path.join(dir, "checkout");
  await fsPromises.mkdir(path.join(checkout, "cli"), { recursive: true });
  for (const name of await fsPromises.readdir(path.join(ROOT, "cli"))) {
    await fsPromises.copyFile(path.join(ROOT, "cli", name), path.join(checkout, "cli", name));
  }
  const configPath = path.join(dir, "rules.json");
  await fsPromises.writeFile(
    configPath,
    canonicalJsonStringify({ schema_version: 1, fields: [TEXT_ID], key: ["id"] }),
  );
  const result = spawnSync(process.execPath, [path.join(checkout, "cli", "main.mjs"), "check-config", configPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stderr.trim().split("\n").pop()).error;
  assert.equal(error.code, "bridge_unavailable");
  assert.match(error.message, /npm run build/);
});

test("concurrent compare runs do not collide in staging", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const targets = [path.join(dir, "a"), path.join(dir, "b")];
  const results = await Promise.all(
    targets.map((out) => quietRun(["compare", paths.left, paths.right, "--config", paths.config, "--out", out])),
  );
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  for (const target of targets) {
    for (const entry of RUN_FILES) assert.ok(await exists(path.join(target, entry)), `${target} missing ${entry}`);
  }
  assert.deepEqual(
    await fsPromises.readFile(path.join(targets[0], "report.json")),
    await fsPromises.readFile(path.join(targets[1], "report.json")),
  );
  assert.deepEqual(await stagingLeftovers(dir), []);
});

test("the host engine version agrees with module metadata and the core Result", async () => {
  const pkg = JSON.parse(await readText(path.join(ROOT, "package.json")));
  assert.equal(ENGINE_VERSION, pkg.version);
  assert.match(await readText(path.join(ROOT, "moon.mod")), new RegExp(`^version = "${ENGINE_VERSION}"$`, "m"));

  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const out = path.join(dir, "run");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", out]).status, 0);
  const report = JSON.parse(await readText(path.join(out, "report.json")));
  assert.equal(report.engine_version, ENGINE_VERSION);
  const manifest = JSON.parse(await readText(path.join(out, "manifest.json")));
  assert.equal(manifest.engine_version, ENGINE_VERSION);
});

test("run identifiers are stable and independent of generated timestamps", async () => {
  const dir = await mkTmp();
  const paths = await writeFixture(dir, { left: "id,amount\n001,100.00\n", right: "id,amount\n001,100\n", config: EQUAL_CONFIG });
  const first = path.join(dir, "first");
  const second = path.join(dir, "second");
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", first]).status, 0);
  assert.equal(cli(["compare", paths.left, paths.right, "--config", paths.config, "--out", second]).status, 0);
  const a = JSON.parse(await readText(path.join(first, "manifest.json")));
  const b = JSON.parse(await readText(path.join(second, "manifest.json")));
  assert.equal(a.run_id, b.run_id);
  assert.deepEqual({ ...a, created: null }, { ...b, created: null });
  assert.match(a.created, /^\d{4}-\d{2}-\d{2}T/);
});
