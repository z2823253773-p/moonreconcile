import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Builds the pure MoonBit JSON bridge into the ignored build tree. The CLI
// loads _build/js/debug/build/cmd/bridge/bridge.js and nothing else.
const result = spawnSync("moon", ["build", "cmd/bridge", "--target", "js"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  process.stderr.write(`failed to run the MoonBit toolchain: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
