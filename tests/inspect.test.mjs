import assert from "node:assert/strict";
import test from "node:test";
import { invoke_bridge as invoke } from "../_build/js/debug/build/cmd/bridge/bridge.js";

const call = (request) => JSON.parse(invoke(JSON.stringify(request)));
const page = (csv, extra = {}) => call({
  op: "inspect_csv", csv, side: "left", offset: 0, limit: 20, ...extra,
});

test("inspect_preserves_logical_records_and_full_cell", () => {
  const long = "界🙂\\\"\n".repeat(51) + "界🙂";
  assert.equal(Array.from(long).length, 257);
  const escapedLong = long.replaceAll('"', '""');
  const csv = `id,note\n1,"中文\r\nquoted"\n2,"${escapedLong}"\n`;
  const second = page(csv, { offset: 1, limit: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.preview.rows.length, 1);
  assert.equal(second.preview.rows[0].record, 2);
  assert.equal(Array.from(second.preview.rows[0].cells[1].value).length, 256);
  assert.equal(second.preview.rows[0].cells[1].value, Array.from(long).slice(0, 256).join(""));
  assert.equal(second.preview.rows[0].cells[1].truncated, true);
  assert.equal(second.preview.rows[0].cells[1].utf8_bytes, Buffer.byteLength(long, "utf8"));

  const full = call({
    op: "inspect_csv", csv, side: "left", cell: { record: 2, column: "note" },
  });
  assert.deepEqual(full, {
    ok: true,
    cell: { side: "left", record: 2, column: "note", value: long, utf8_bytes: Buffer.byteLength(long, "utf8"), truncated: false },
  });
});

test("inspect_csv rejects invalid protocol shapes and values", () => {
  const base = { op: "inspect_csv", csv: "id\n1\n", side: "left", offset: 0, limit: 20 };
  for (const request of [
    { ...base, side: "other" },
    { ...base, offset: -1 },
    { ...base, offset: 2147483648 },
    { ...base, offset: 1.5 },
    { ...base, offset: "0" },
    { op: "inspect_csv", csv: "id\n1\n", side: "left", limit: 20 },
    { ...base, limit: 0 },
    { ...base, limit: 101 },
    { ...base, limit: 1.5 },
    { ...base, cell: { record: 1, column: "id" } },
    { ...base, unexpected: true },
    { ...base, cell: { record: 1, column: "id" }, offset: 0 },
    { op: "inspect_csv", csv: "id\n1\n", side: "left", cell: { column: "id" } },
    { op: "inspect_csv", csv: "id\n1\n", side: "left", cell: { record: 1 } },
    { ...base, cell: { record: 2, column: "id" }, offset: undefined, limit: undefined },
    { ...base, cell: { record: 1, column: "missing" }, offset: undefined, limit: undefined },
  ]) {
    const result = call(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "invalid_request", JSON.stringify(request));
  }
  const invalidCell = call({ op: "inspect_csv", csv: "id\n1\n", side: "left", cell: { record: 2147483648, column: "id" } });
  assert.equal(invalidCell.error.code, "invalid_request");
  const badCellNumber = call({ op: "inspect_csv", csv: "id\n1\n", side: "left", cell: { record: 1.5, column: "id" } });
  assert.equal(badCellNumber.error.code, "invalid_request");
  const nonFiniteOffset = JSON.parse(invoke('{"op":"inspect_csv","csv":"id\\n1\\n","side":"left","offset":1e999,"limit":1}'));
  assert.equal(nonFiniteOffset.error.code, "invalid_request");
  const nonFiniteRecord = JSON.parse(invoke('{"op":"inspect_csv","csv":"id\\n1\\n","side":"left","cell":{"record":1e999,"column":"id"}}'));
  assert.equal(nonFiniteRecord.error.code, "invalid_request");
});

test("inspect_csv reuses strict CSV errors and emits empty pages past the end", () => {
  for (const [csv, code, record] of [
    ["id,id\n1,2\n", "invalid_header", 1],
    ['id,note\n1,bad"quote\n', "invalid_csv", 2],
    [`id,note\n1,${"x".repeat(65537)}\n`, "input_limit_exceeded", 2],
  ]) {
    const result = page(csv);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.record, record, "CSV diagnostics count the header as record 1");
  }
  const pastEnd = page("id\n1\n", { offset: 1 });
  assert.deepEqual(pastEnd.preview.rows, []);
  assert.equal(pastEnd.preview.next_offset, 1);
  assert.equal(pastEnd.preview.has_more, false);
});

test("inspect_csv validates the full CSV before returning a requested page", () => {
  const result = page('id,note\n1,ok\n2,bad"quote\n', { offset: 0, limit: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_csv");
  assert.equal(result.error.record, 3);
});

test("inspect_csv production response stays within the UTF-8 JSON budget", () => {
  const headers = Array.from({ length: 256 }, (_, index) => `c${index}`);
  const escapedValue = `"${"🙂\\\"\n".repeat(64).replaceAll('"', '""')}"`;
  const row = Array(256).fill(escapedValue).join(",");
  const csv = `${headers.join(",")}\n${Array(40).fill(row).join("\n")}\n`;
  const result = page(csv, { limit: 100 });
  assert.equal(result.ok, true);
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(bytes <= 2_097_152, `response used ${bytes} UTF-8 bytes`);
  assert.ok(result.preview.rows.length > 0);
  assert.ok(result.preview.rows.length < 40);
  assert.equal(result.preview.next_offset, result.preview.rows.length);
  assert.equal(result.preview.has_more, true);
});
