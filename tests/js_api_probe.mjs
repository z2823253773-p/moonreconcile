// Runtime probe: does the MoonBit JS target export a plain String -> String
// function that Node can import and call directly?
//
// This is the question Task 1 asked before fixing the bridge design. The answer
// is yes, and the generated module shape is:
//
//   export { <mangled name> as invoke_bridge }
//
// so the Node adapter can do:
//
//   import { invoke_bridge as invoke } from "../_build/js/debug/build/cmd/bridge/bridge.js";
//
// which is exactly what tests/bridge.test.mjs relies on. Kept as a standalone
// script so the export contract can be re-probed after a toolkit upgrade without
// running the whole suite:
//
//   moon build cmd/bridge --target js
//   node tests/js_api_probe.mjs

import assert from "node:assert/strict";
import { invoke_bridge as invoke } from "../_build/js/debug/build/cmd/bridge/bridge.js";

// The exported binding must be a plain callable taking and returning strings.
assert.equal(typeof invoke, "function");
assert.equal(typeof invoke("{}"), "string");

// A JSON request survives the boundary unchanged in shape.
const response = JSON.parse(
  invoke(JSON.stringify({ op: "check_config", config: { schema_version: 1, fields: [] } })),
);
assert.equal(response.ok, false);
assert.equal(response.error.code, "invalid_config");
assert.equal(typeof response.error.phase, "string");

// Malformed input is reported as structured JSON, never thrown across the boundary.
const malformed = JSON.parse(invoke("{"));
assert.equal(malformed.ok, false);
assert.equal(malformed.error.code, "invalid_json");

console.log("Node imported and called the MoonBit String -> String export.");
console.log("Export shape: cmd/bridge/bridge.js -> invoke_bridge");
