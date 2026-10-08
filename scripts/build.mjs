import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildInputs, toolchainInputs, BRIDGE_RELATIVE, BUILD_PROVENANCE, digest, toolchainHome } from "./workbench-package-provenance.mjs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const inputs = await buildInputs(ROOT);
const sdk = await toolchainInputs();
// Clear stale proof before attempting a new compilation.
await fs.rm(path.join(ROOT, BUILD_PROVENANCE), { force: true });

// Builds the pure MoonBit JSON bridge into the ignored build tree. The CLI
// loads _build/js/debug/build/cmd/bridge/bridge.js and nothing else.
const result = spawnSync(path.join(toolchainHome(), "bin/moon"), ["build", "cmd/bridge", "--target", "js"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, MOON_HOME: toolchainHome(), MOONBIT_HOME: toolchainHome() },
  shell: process.platform === "win32",
});

if (result.error) {
  process.stderr.write(`failed to run the MoonBit toolchain: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

if (process.exitCode === 0) {
  assert.deepEqual(await buildInputs(ROOT), inputs, "build inputs changed during compilation");
  assert.deepEqual(await toolchainInputs(), sdk, "toolchain inputs changed during compilation");
  const record = { schema_version: 1, build_inputs: inputs, toolchain_inputs: sdk, bridge_sha256: digest(await fs.readFile(path.join(ROOT, BRIDGE_RELATIVE))) };
  await fs.writeFile(path.join(ROOT, BUILD_PROVENANCE), `${JSON.stringify(record, null, 2)}\n`);
}
