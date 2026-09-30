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

test("compare returns exact reconciliation JSON and resolve remains unsupported", () => {
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
  assert.equal(response.result.run_status, "complete");
  assert.equal(response.result.exit_code, 1);
  assert.equal(response.result.pairs.length, 1);
  assert.equal(response.result.pairs[0].source, "exact_key");
  assert.equal(response.result.pairs[0].fields[0].status, "equivalent_by_rule");
  assert.deepEqual(response.result.records.left, {
    total: 2,
    paired: 1,
    unmatched: 0,
    pending_review: 1,
    unprocessed: 0,
    pending_records: [2],
  });

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
  assert.equal(candidatePending.ok, false);
  assert.equal(candidatePending.error.code, "candidate_stage_not_implemented");

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
  assert.equal(missingColumn.result.exit_code, 2);
  assert.equal(missingColumn.result.diagnostics[0].field, "left_id");

  const resolve = call({ op: "resolve" });
  assert.equal(resolve.ok, false);
  assert.equal(resolve.error.code, "unsupported_operation");
});
