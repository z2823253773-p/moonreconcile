import assert from "node:assert/strict";
import test from "node:test";
import { invoke_bridge as invoke } from "../_build/js/debug/build/cmd/bridge/bridge.js";

const call = (request) => JSON.parse(invoke(JSON.stringify(request)));

test("bridge returns structured errors for malformed JSON and invalid config", () => {
  const malformed = JSON.parse(invoke("{"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "invalid_json");
  assert.equal(typeof malformed.error.phase, "string");

  const invalidConfig = JSON.parse(
    invoke(JSON.stringify({
      op: "check_config",
      config: { schema_version: 1, fields: [] },
    })),
  );
  assert.equal(invalidConfig.ok, false);
  assert.equal(invalidConfig.error.code, "invalid_config");
  assert.equal(typeof invalidConfig.error.message, "string");
});

test("no request may crash the host process", () => {
  for (const raw of ["", "[]", "null", "12", "{}", '{"op":1}', '{"op":"nope"}']) {
    const response = JSON.parse(invoke(raw));
    assert.equal(response.ok, false, `expected failure for input: ${raw}`);
    assert.equal(typeof response.error.code, "string");
    assert.equal(typeof response.error.message, "string");
    assert.equal(typeof response.error.phase, "string");
  }
});

test("check_config returns canonical normalized defaults", () => {
  const response = call({
    op: "check_config",
    config: {
      schema_version: 1,
      fields: [
        { name: "amount", left: "Amount", right: "amt", type: "decimal" },
      ],
      key: ["amount"],
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.config.draft, false);
  assert.deepEqual(response.config.key, ["amount"]);
  assert.deepEqual(response.config.ignore_left, []);
  assert.deepEqual(response.config.candidates, null);

  const [field] = response.config.fields;
  assert.equal(field.name, "amount");
  assert.equal(field.type, "decimal");
  assert.equal(field.compare, true);
  assert.equal(field.trim_ascii, false);
  assert.equal(field.lower_ascii, false);
  assert.deepEqual(field.missing, []);
  assert.equal(field.both_missing, "equal");
  assert.equal(field.abs_tol, "0");
  assert.equal(field.rel_tol, "0");
  assert.equal(field.days_tol, 0);
});

test("init_config produces an unexecutable draft and check_config rejects it", () => {
  const draftResponse = call({
    op: "init_config",
    left_csv: "id,name\n001,Widget\n",
    right_csv: "id,label\n001,Widget\n",
  });
  assert.equal(draftResponse.ok, true);
  assert.equal(draftResponse.config.draft, true);
  assert.deepEqual(draftResponse.config.key, []);
  assert.deepEqual(draftResponse.config.candidates, null);

  const byName = Object.fromEntries(
    draftResponse.config.fields.map((field) => [field.name, field]),
  );
  // Only exact header agreement is suggested; nothing is inferred.
  assert.equal(byName.id.left, "id");
  assert.equal(byName.id.right, "id");
  assert.equal(byName.name.left, "name");
  assert.equal(byName.name.right, null);
  assert.equal(byName.label.left, null);
  assert.equal(byName.label.right, "label");
  for (const field of draftResponse.config.fields) {
    assert.equal(field.type, null, `${field.name} must not have an inferred type`);
  }

  const rejected = call({ op: "check_config", config: draftResponse.config });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "invalid_config");
});

test("init_config returns a structured error for malformed CSV", () => {
  const bad = call({
    op: "init_config",
    left_csv: 'id,note\n1,bad"quote\n',
    right_csv: "id,note\n1,x\n",
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid_csv");
  assert.equal(bad.error.side, "left");
  assert.equal(typeof bad.error.record, "number");
  assert.equal(bad.error.field, "note");

});

test("compare returns exact reconciliation JSON and resolve applies human review", () => {
  const config = {
    schema_version: 1,
    fields: [
      { name: "id", left: "id", right: "id", type: "text", compare: false },
      { name: "amount", left: "amount", right: "amount", type: "decimal" },
    ],
    key: ["id"],
  };
  const response = call({
    op: "compare",
    left_csv: "id,amount\n001,100.00\n2,7\n",
    right_csv: "id,amount\n001,100\n3,7\n",
    config,
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.computation.status, "complete");
  assert.equal(response.result.exit_code, 1);
  assert.equal(response.result.pairs.length, 1);
  assert.equal(response.result.pairs[0].source, "exact_key");
  assert.equal(response.result.fields[0].status, "equivalent_by_rule");
  assert.deepEqual(response.result.summary.per_side.left, {
    total: 2,
    paired: 1,
    unmatched: 0,
    pending_review: 1,
    unprocessed: 0,
  });
  assert.deepEqual(response.result.records[1], {
    id: "L2",
    side: "left",
    record: 2,
    status: "pending_review",
    reason: "review_required",
  });
  assert.deepEqual(response.result.records[2], {
    id: "R1",
    side: "right",
    record: 1,
    status: "paired",
    reason: "exact_key",
  });
  assert.deepEqual(response.result.candidates, []);
  assert.deepEqual(response.result.decisions, []);
  assert.equal(response.result.summary.candidate_count, 0);
  assert.equal(response.result.summary.key_issue_count, 2);
  assert.equal(response.result.summary.unresolved_count, 2);

  const exactOnly = call({
    op: "compare",
    left_csv: "id,label\n1,alpha\n",
    right_csv: "id,label\n1,alpha\n",
    config: {
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
    },
  });
  assert.equal(exactOnly.ok, true);
  assert.equal(exactOnly.result.exit_code, 0);
  assert.equal(exactOnly.result.pairs.length, 1);

  const candidatePending = call({
    op: "compare",
    left_csv: "id,label\n1,alpha\n",
    right_csv: "id,label\n2,alpha\n",
    config: {
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
    },
  });
  assert.equal(candidatePending.ok, true);
  assert.equal(candidatePending.result.candidates.length, 1);
  assert.equal(candidatePending.result.candidates[0].score, 10000);
  assert.equal(candidatePending.result.candidates[0].suggested, true);
  assert.equal(candidatePending.result.pairs.length, 0);
  assert.equal(candidatePending.result.records[0].status, "pending_review");

  const missingColumn = call({
    op: "compare",
    left_csv: "other\nx\n",
    right_csv: "right_id\n1\n",
    config: {
      schema_version: 1,
      fields: [{ name: "id", left: "left_id", right: "right_id", type: "text" }],
      key: ["id"],
    },
  });
  assert.equal(missingColumn.ok, false);
  assert.equal(missingColumn.error.code, "missing_mandatory_column");
  assert.equal(missingColumn.error.side, "left");
  assert.equal(missingColumn.error.field, "left_id");
  assert.equal(missingColumn.result.exit_code, 2);

  const resolution = call({
    op: "resolve",
    left_csv: "id,amount\n001,100.00\n2,7\n",
    right_csv: "id,amount\n001,100\n3,7\n",
    config,
    decisions_csv: "action,left_id,right_id,reason\naccept,L2,R2,manually verified\n",
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.result.exit_code, 0);
  assert.equal(resolution.result.pairs[1].source, "human_review");
  assert.equal(resolution.result.decisions[0].override, true);
});

test("compare follows the locked Result wire schema and returns normalized config", () => {
  const response = call({
    op: "compare",
    left_csv: "id,amount\n001,100.00\n",
    right_csv: "id,amount\n001,100\n",
    config: {
      schema_version: 1,
      fields: [
        { name: "id", left: "id", right: "id", type: "text", compare: false },
        { name: "amount", left: "amount", right: "amount", type: "decimal" },
      ],
      key: ["id"],
    },
  });
  assert.equal(response.ok, true);
  assert.ok(response.config);
  assert.equal(response.config.fields[1].trim_ascii, false);
  assert.equal(response.config.fields[1].abs_tol, "0");
  const result = response.result;
  assert.deepEqual(
    Object.keys(result).sort(),
    [
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
    ].sort(),
  );
  assert.equal(result.schema_version, 1);
  assert.equal(typeof result.engine_version, "string");
  assert.equal(result.computation.status, "complete");
  assert.deepEqual(result.computation.issues, []);
  assert.deepEqual(result.records, [
    { id: "L1", side: "left", record: 1, status: "paired", reason: "exact_key" },
    { id: "R1", side: "right", record: 1, status: "paired", reason: "exact_key" },
  ]);
  assert.deepEqual(result.pairs, [
    { left_id: "L1", right_id: "R1", source: "exact_key", reason: "unique_canonical_key", override: false },
  ]);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].left_id, "L1");
  assert.equal(result.fields[0].right_id, "R1");
  assert.equal(result.fields[0].status, "equivalent_by_rule");
  assert.deepEqual(result.summary.per_side.left, {
    total: 1,
    paired: 1,
    unmatched: 0,
    pending_review: 0,
    unprocessed: 0,
  });
  assert.deepEqual(result.summary.fields, {
    equal: 0,
    equivalent_by_rule: 1,
    different: 0,
    invalid_value: 0,
  });
  assert.equal(result.summary.unresolved_count, 0);
  assert.equal(result.summary.structural_issue_count, 0);
  assert.equal(result.summary.key_issue_count, 0);
  assert.deepEqual(result.structure, {
    unmapped_left: [],
    unmapped_right: [],
    ignored_left: [],
    ignored_right: [],
  });
  assert.deepEqual(result.key_issues, []);
});

test("compare rejects absent explicitly ignored columns on either side", () => {
  for (const side of ["left", "right"]) {
    const config = {
      schema_version: 1,
      fields: [{ name: "id", left: "id", right: "id", type: "text" }],
      key: ["id"],
      ignore_left: side === "left" ? ["left_typo"] : [],
      ignore_right: side === "right" ? ["right_typo"] : [],
    };
    const response = call({
      op: "compare",
      left_csv: "id\n1\n",
      right_csv: "id\n1\n",
      config,
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "missing_ignored_column");
    assert.equal(response.error.side, side);
    assert.equal(response.error.field, `${side}_typo`);
    assert.equal(response.result.exit_code, 2);
    assert.equal(response.result.summary.structural_issue_count, 1);
  }
});

test("pure invoke admits decision templates above the source cap and rejects excess active or raw rows atomically", () => {
  const request = {
    op: "resolve", left_csv: "id\n1\n", right_csv: "id\n1\n",
    config: { schema_version: 1, fields: [{ name: "id", left: "id", right: "id", type: "text" }] },
  };
  const header = "action,left_id,right_id,reason\n";
  const admitted = call({ ...request, decisions_csv: header + ",L1,,\n".repeat(100002) });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.result.exit_code, 1);
  assert.equal(admitted.result.decisions.length, 0);
  assert.deepEqual(admitted.result.records.map((row) => row.id), ["L1", "R1"]);
  for (const [csv, code] of [
    [header + ",,,\n".repeat(400001), "input_limit_exceeded"],
    [header + "reject,L1,R1,x\n".repeat(100001), "decision_limit_exceeded"],
  ]) {
    const rejected = call({ ...request, decisions_csv: csv });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, code);
    assert.equal(Object.hasOwn(rejected, "result"), false);
  }
});
