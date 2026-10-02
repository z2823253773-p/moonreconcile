import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "moonreconcile-readme-smoke-"));
  const checkout = join(scratch, "checkout");
const smokeDir = join(scratch, "run");
try {
  await mkdir(smokeDir, { recursive: true });
  const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", sourceRoot, checkout], { encoding: "utf8" });
  assert.equal(clone.status, 0, `fresh clone failed: ${clone.stderr}`);
  const readme = await readFile(join(checkout, "README.md"), "utf8");
  const match = readme.match(/<!-- README-SMOKE:START -->\s*```sh\n([\s\S]*?)\n```\s*<!-- README-SMOKE:END -->/);
  assert.ok(match, "README must contain the marked shell acceptance block");
  const commands = match[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.ok(commands.length >= 8, "acceptance block should exercise all CLI stages and final artifacts");
  for (const line of commands) {
    const tagged = line.match(/^(.*?)\s+# @expect: ([0-3])$/);
    assert.ok(tagged, `each acceptance command needs an explicit expected exit: ${line}`);
    const [, command, expected] = tagged;
    const result = spawnSync("bash", ["-c", command], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, SMOKE_DIR: smokeDir },
    });
    process.stdout.write(`$ ${command}\n${result.stdout ?? ""}`);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, Number(expected), `unexpected exit from: ${command}`);
  }
  process.stdout.write(`README smoke passed: ${commands.length} documented commands from fresh clone ${checkout}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
