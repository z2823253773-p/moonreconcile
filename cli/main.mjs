#!/usr/bin/env node
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadBridgeInvoke } from "./bridge.mjs";
import {
  CliError,
  DEFAULT_LIMITS,
  ENGINE_VERSION,
  canonicalJsonStringify,
  checkDiskSpace,
  decodeUtf8Fatal,
  defaultStatfs,
  assertDirectoryDestination,
  assertFileDestination,
  parseJsonText,
  publishFileExclusive,
  publishRunDirectory,
  readFileBounded,
  sha256Hex,
} from "./io.mjs";
import {
  renderCandidatesCsv,
  renderDecisionsCsv,
  renderFieldsCsv,
  renderPairsCsv,
  renderReportJson,
  renderSummaryMarkdown,
  renderUnresolvedCsv,
} from "./render.mjs";

const COMMANDS = {
  "init-config": { operands: ["LEFT", "RIGHT"], options: { "--out": "CONFIG" } },
  "check-config": { operands: ["CONFIG"], options: {} },
  compare: { operands: ["LEFT", "RIGHT"], options: { "--config": "CONFIG", "--out": "RUN" } },
  resolve: { operands: ["RUN"], options: { "--decisions": "CSV", "--out": "REVIEWED" } },
};

const USAGE = [
  "usage:",
  "  reconcile init-config LEFT RIGHT --out CONFIG",
  "  reconcile check-config CONFIG",
  "  reconcile compare LEFT RIGHT --config CONFIG --out RUN",
  "  reconcile resolve RUN --decisions CSV --out REVIEWED",
  "  reconcile --help | --version",
  "",
  "Exit codes: 0 complete without issues; 1 differences or outstanding review;",
  "            2 input/configuration/I/O error; 3 incomplete computation.",
  "Suggestions require review. init-config writes a draft, not executable rules.",
].join("\n");

function parseArguments(argv) {
  if (argv.length === 0) throw new CliError("invalid_arguments", `no command given\n${USAGE}`);
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new CliError("invalid_arguments", `unknown command '${command}'\n${USAGE}`);
  const operands = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith("-")) {
      if (!Object.hasOwn(spec.options, token)) {
        throw new CliError("invalid_arguments", `unknown option ${token} for '${command}'`);
      }
      if (options[token] !== undefined) throw new CliError("invalid_arguments", `repeated option ${token}`);
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("invalid_arguments", `option ${token} requires a value`);
      }
      options[token] = value;
      index += 1;
    } else {
      operands.push(token);
    }
  }
  if (operands.length !== spec.operands.length) {
    throw new CliError(
      "invalid_arguments",
      `'${command}' expects ${spec.operands.length} operand(s) ${spec.operands.join(" ")}, received ${operands.length}`,
    );
  }
  for (const option of Object.keys(spec.options)) {
    if (options[option] === undefined) throw new CliError("invalid_arguments", `missing required option ${option}`);
  }
  return { command, operands, options };
}

function makeContext(runtime) {
  return {
    cwd: runtime.cwd ?? process.cwd(),
    fs: runtime.fs ?? fsPromises,
    limits: { ...DEFAULT_LIMITS, ...runtime.limits },
    statfs: runtime.statfs ?? defaultStatfs,
    stdout: runtime.stdout ?? ((text) => process.stdout.write(text)),
    stderr: runtime.stderr ?? ((text) => process.stderr.write(text)),
    now: runtime.now ?? (() => new Date()),
    invoke: runtime.invoke ?? null,
  };
}

function resolvePath(context, value) {
  return path.resolve(context.cwd, value);
}

function warn(context, message) {
  context.stderr(`warning: ${message}\n`);
}

async function getInvoke(context) {
  if (!context.invoke) context.invoke = await loadBridgeInvoke();
  return context.invoke;
}

// The single boundary to the MoonBit engine: JSON in, JSON out. The host never
// reproduces engine semantics, so an engine refusal is reported as a fatal
// host outcome (exit 2) and never rewritten into a successful run.
async function callEngine(context, request) {
  const invoke = await getInvoke(context);
  let raw;
  try {
    raw = invoke(JSON.stringify(request));
  } catch (error) {
    throw new CliError("engine_failure", `the MoonBit engine failed: ${error.message}`);
  }
  let response;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new CliError("invalid_bridge_response", "the MoonBit engine returned a response that is not valid JSON");
  }
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    throw new CliError("invalid_bridge_response", "the MoonBit engine returned an unrecognized response envelope");
  }
  if (!response.ok) {
    const failure = response.error ?? {};
    throw new CliError(
      typeof failure.code === "string" ? failure.code : "engine_error",
      typeof failure.message === "string" ? failure.message : "the MoonBit engine reported an error",
      {
        phase: typeof failure.phase === "string" ? failure.phase : "engine",
        side: typeof failure.side === "string" ? failure.side : null,
        record: Number.isInteger(failure.record) ? failure.record : null,
        field: typeof failure.field === "string" ? failure.field : null,
      },
    );
  }
  return response;
}

function requireResult(response) {
  const { result } = response;
  if (!result || typeof result !== "object" || typeof result.exit_code !== "number") {
    throw new CliError("invalid_bridge_response", "the MoonBit engine returned a response without a Result");
  }
  if (result.engine_version !== ENGINE_VERSION) {
    throw new CliError(
      "unsupported_engine_version",
      `the engine reported version '${result.engine_version}' but this host supports '${ENGINE_VERSION}'`,
      { phase: "engine" },
    );
  }
  return result;
}

async function readSnapshot(context, filePath, side) {
  return readFileBounded(context.fs, filePath, context.limits.maxInputBytes, { phase: "input", side });
}

async function readConfigJson(context, filePath) {
  const bytes = await readFileBounded(context.fs, filePath, context.limits.maxInputBytes, { phase: "input" });
  const text = decodeUtf8Fatal(bytes, { phase: "input", allowInteriorBom: true });
  return parseJsonText(text, { what: `configuration ${filePath}` });
}

function runIdFrom(engineVersion, leftSha256, rightSha256, configSha256) {
  const material = JSON.stringify([engineVersion, leftSha256, rightSha256, configSha256]);
  return sha256Hex(Buffer.from(material, "utf8"));
}

async function publishRun(context, { dest, result, runId, configBytes, leftBytes, rightBytes, provenance, extraManifest }) {
  const manifest = {
    schema_version: 1,
    run_id: runId,
    engine_version: ENGINE_VERSION,
    left_sha256: sha256Hex(leftBytes),
    left_bytes: leftBytes.length,
    right_sha256: sha256Hex(rightBytes),
    right_bytes: rightBytes.length,
    config_sha256: sha256Hex(configBytes),
    config_bytes: configBytes.length,
    provenance,
    ...extraManifest,
    created: context.now().toISOString(),
  };
  const entries = [
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["input/left.csv", leftBytes],
    ["input/right.csv", rightBytes],
    ["config.json", configBytes],
    ["report.json", renderReportJson(result)],
    ["pairs.csv", renderPairsCsv(result)],
    ["fields.csv", renderFieldsCsv(result)],
    ["candidates.csv", renderCandidatesCsv(result)],
    ["decisions.csv", renderDecisionsCsv(result)],
    ["unresolved.csv", renderUnresolvedCsv(result)],
    ["summary.md", renderSummaryMarkdown(result, { runId })],
  ];
  const needed = entries.reduce(
    (total, [, data]) => total + (typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length),
    0,
  );
  await checkDiskSpace(path.dirname(dest), needed, context.statfs, (message) => warn(context, message));
  await publishRunDirectory({ fs: context.fs, destPath: dest, entries, warn: (message) => warn(context, message) });
  context.stdout(`run: ${dest}\nrun_id: ${runId}\nexit: ${result.exit_code}\n`);
  return result.exit_code;
}

async function commandInitConfig(parsed, context) {
  const [leftPath, rightPath] = parsed.operands.map((operand) => resolvePath(context, operand));
  const dest = await assertFileDestination(context.fs, resolvePath(context, parsed.options["--out"]), {
    protectedPaths: [leftPath, rightPath],
  });
  const leftText = decodeUtf8Fatal(await readSnapshot(context, leftPath, "left"), { side: "left" });
  const rightText = decodeUtf8Fatal(await readSnapshot(context, rightPath, "right"), { side: "right" });
  const response = await callEngine(context, { op: "init_config", left_csv: leftText, right_csv: rightText });
  const bytes = Buffer.from(canonicalJsonStringify(response.config), "utf8");
  await publishFileExclusive({ fs: context.fs, destPath: dest, data: bytes });
  context.stdout(`config: ${dest}\n`);
  return 0;
}

async function commandCheckConfig(parsed, context) {
  const configPath = resolvePath(context, parsed.operands[0]);
  const config = await readConfigJson(context, configPath);
  const response = await callEngine(context, { op: "check_config", config });
  context.stdout(canonicalJsonStringify(response.config));
  return 0;
}

async function commandCompare(parsed, context) {
  const [leftPath, rightPath] = parsed.operands.map((operand) => resolvePath(context, operand));
  const configPath = resolvePath(context, parsed.options["--config"]);
  const dest = await assertDirectoryDestination(context.fs, resolvePath(context, parsed.options["--out"]), {
    protectedPaths: [leftPath, rightPath, configPath],
  });
  const leftBytes = await readSnapshot(context, leftPath, "left");
  const rightBytes = await readSnapshot(context, rightPath, "right");
  const leftText = decodeUtf8Fatal(leftBytes, { side: "left" });
  const rightText = decodeUtf8Fatal(rightBytes, { side: "right" });
  const config = await readConfigJson(context, configPath);
  const response = await callEngine(context, {
    op: "compare",
    left_csv: leftText,
    right_csv: rightText,
    config,
  });
  const result = requireResult(response);
  const configBytes = Buffer.from(canonicalJsonStringify(response.config), "utf8");
  const runId = runIdFrom(ENGINE_VERSION, sha256Hex(leftBytes), sha256Hex(rightBytes), sha256Hex(configBytes));
  return publishRun(context, {
    dest,
    result,
    runId,
    configBytes,
    leftBytes,
    rightBytes,
    provenance: `compare ${leftPath} + ${rightPath}`,
    extraManifest: {},
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_MANIFEST_KEYS = [
  "schema_version",
  "run_id",
  "engine_version",
  "left_sha256",
  "left_bytes",
  "right_sha256",
  "right_bytes",
  "config_sha256",
  "config_bytes",
  "provenance",
];
const OPTIONAL_MANIFEST_KEYS = ["created", "parent_run_id", "decisions_sha256"];

function invalidManifest(message) {
  return new CliError("invalid_manifest", message, { phase: "manifest" });
}

function requireSha256(manifest, key) {
  if (typeof manifest[key] !== "string" || !HEX64.test(manifest[key])) {
    throw invalidManifest(`manifest field '${key}' must be a lowercase 64 character SHA-256 digest`);
  }
}

function requireByteSize(manifest, key) {
  if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) {
    throw invalidManifest(`manifest field '${key}' must be a nonnegative safe integer`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest("manifest.json must contain a JSON object");
  }
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!Object.hasOwn(manifest, key)) throw invalidManifest(`manifest is missing required field '${key}'`);
  }
  for (const key of Object.keys(manifest)) {
    if (!REQUIRED_MANIFEST_KEYS.includes(key) && !OPTIONAL_MANIFEST_KEYS.includes(key)) {
      throw invalidManifest(`manifest contains unrecognized field '${key}'`);
    }
  }
  if (manifest.schema_version !== 1) throw invalidManifest("manifest schema_version must be 1");
  if (typeof manifest.engine_version !== "string") throw invalidManifest("manifest engine_version must be a string");
  if (manifest.engine_version !== ENGINE_VERSION) {
    throw new CliError(
      "unsupported_engine_version",
      `the run was produced by engine version '${manifest.engine_version}' but this host supports '${ENGINE_VERSION}'`,
      { phase: "manifest" },
    );
  }
  if (typeof manifest.provenance !== "string") throw invalidManifest("manifest provenance must be a string");
  requireSha256(manifest, "run_id");
  requireSha256(manifest, "left_sha256");
  requireSha256(manifest, "right_sha256");
  requireSha256(manifest, "config_sha256");
  requireByteSize(manifest, "left_bytes");
  requireByteSize(manifest, "right_bytes");
  requireByteSize(manifest, "config_bytes");
  for (const key of ["parent_run_id", "decisions_sha256"]) {
    if (Object.hasOwn(manifest, key)) requireSha256(manifest, key);
  }
  if (Object.hasOwn(manifest, "created") && typeof manifest.created !== "string") {
    throw invalidManifest("manifest created must be a string when present");
  }
  return manifest;
}

async function readRunArtifact(context, runPath, relative, { phase, side = null }) {
  return readFileBounded(context.fs, path.join(runPath, relative), context.limits.maxInputBytes, { phase, side });
}

async function commandResolve(parsed, context) {
  const runPath = resolvePath(context, parsed.operands[0]);
  const decisionsPath = resolvePath(context, parsed.options["--decisions"]);
  const dest = await assertDirectoryDestination(context.fs, resolvePath(context, parsed.options["--out"]), {
    protectedPaths: [decisionsPath],
    sourceRuns: [runPath],
  });

  const manifestBytes = await readRunArtifact(context, runPath, "manifest.json", { phase: "manifest" });
  const manifest = validateManifest(
    parseJsonText(decodeUtf8Fatal(manifestBytes, { phase: "manifest" }), { phase: "manifest", what: "manifest.json" }),
  );

  const leftBytes = await readRunArtifact(context, runPath, "input/left.csv", { phase: "input", side: "left" });
  const rightBytes = await readRunArtifact(context, runPath, "input/right.csv", { phase: "input", side: "right" });
  const compareFingerprint = (name, bytes, shaKey, sizeKey) => {
    if (bytes.length !== manifest[sizeKey] || sha256Hex(bytes) !== manifest[shaKey]) {
      throw new CliError(
        "fingerprint_mismatch",
        `immutable snapshot ${name} does not match the manifest fingerprint`,
        { phase: "manifest" },
      );
    }
  };
  compareFingerprint("input/left.csv", leftBytes, "left_sha256", "left_bytes");
  compareFingerprint("input/right.csv", rightBytes, "right_sha256", "right_bytes");

  const configBytes = await readRunArtifact(context, runPath, "config.json", { phase: "config" });
  if (configBytes.length !== manifest.config_bytes || sha256Hex(configBytes) !== manifest.config_sha256) {
    throw new CliError("config_digest_mismatch", "config.json does not match the manifest fingerprint", {
      phase: "manifest",
    });
  }
  const configText = decodeUtf8Fatal(configBytes, { phase: "config", allowInteriorBom: true });
  const config = parseJsonText(configText, { phase: "config", what: "config.json" });
  if (canonicalJsonStringify(config) !== configText) {
    throw invalidManifest("config.json is not the canonical normalized configuration for this run");
  }

  const expectedRunId = runIdFrom(manifest.engine_version, manifest.left_sha256, manifest.right_sha256, manifest.config_sha256);
  if (expectedRunId !== manifest.run_id) {
    throw new CliError("run_id_mismatch", "manifest run_id does not match the recomputed run identifier", {
      phase: "manifest",
    });
  }

  const decisionsBytes = await readFileBounded(context.fs, decisionsPath, context.limits.maxDecisionBytes, {
    phase: "decisions",
    side: "decisions",
  });
  const decisionsText = decodeUtf8Fatal(decisionsBytes, { phase: "decisions", side: "decisions" });

  const response = await callEngine(context, {
    op: "resolve",
    left_csv: decodeUtf8Fatal(leftBytes, { side: "left" }),
    right_csv: decodeUtf8Fatal(rightBytes, { side: "right" }),
    config,
    decisions_csv: decisionsText,
  });
  const result = requireResult(response);
  if (canonicalJsonStringify(response.config) !== configText) {
    throw new CliError(
      "config_digest_mismatch",
      "the engine normalized the verified configuration differently from the immutable snapshot",
      { phase: "manifest" },
    );
  }

  return publishRun(context, {
    dest,
    result,
    runId: manifest.run_id,
    configBytes,
    leftBytes,
    rightBytes,
    provenance: `resolve ${runPath} with decisions ${decisionsPath}`,
    extraManifest: {
      parent_run_id: manifest.run_id,
      decisions_sha256: sha256Hex(decisionsBytes),
    },
  });
}

function reportFailure(error, context) {
  const failure =
    error instanceof CliError
      ? error
      : new CliError("internal_error", error?.stack ?? String(error));
  context.stderr(`${JSON.stringify(failure.details())}\n`);
  return 2;
}

export async function run(argv, runtime = {}) {
  const context = makeContext(runtime);
  try {
    if ((argv.length === 1 && argv[0] === "--help") ||
      (argv.length === 2 && Object.hasOwn(COMMANDS, argv[0]) && argv[1] === "--help")) {
      context.stdout(`${USAGE}\n`);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--version") {
      context.stdout(`MoonReconcile ${ENGINE_VERSION}\n`);
      return 0;
    }
    const parsed = parseArguments(argv);
    switch (parsed.command) {
      case "init-config":
        return await commandInitConfig(parsed, context);
      case "check-config":
        return await commandCheckConfig(parsed, context);
      case "compare":
        return await commandCompare(parsed, context);
      case "resolve":
        return await commandResolve(parsed, context);
      default:
        throw new CliError("invalid_arguments", `unknown command '${parsed.command}'`);
    }
  } catch (error) {
    return reportFailure(error, context);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
