import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

// The engine version the host is willing to replay. It must agree with the
// version the MoonBit core reports inside every Result and with moon.mod.
export const ENGINE_VERSION = "0.1.0";

// 64 MiB of raw bytes, counting BOM, quotes and newlines. Test-only injection
// points may lower this; the CLI never exposes a production override.
export const DEFAULT_LIMITS = Object.freeze({ maxInputBytes: 64 * 1024 * 1024 });

const UTF8_BOM = "﻿";

export class CliError extends Error {
  constructor(code, message, { phase = "host", side = null, record = null, field = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.phase = phase;
    this.side = side;
    this.record = record;
    this.field = field;
  }

  details() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        phase: this.phase,
        side: this.side,
        record: this.record,
        field: this.field,
      },
    };
  }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Canonical form of a JSON value: object keys sorted lexically and recursively,
// array order preserved, no indentation, exactly one final newline. The writer
// is explicit so that numeric looking map keys ("10" before "2") are not
// reordered the way JSON.stringify reorders integer-like properties.
export function canonicalJsonStringify(value) {
  return `${writeCanonical(value)}\n`;
}

function writeCanonical(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CliError("internal_error", "cannot canonicalize a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CliError("internal_error", `cannot canonicalize a ${typeof value} value`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(writeCanonical).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${writeCanonical(value[key])}`);
  return `{${members.join(",")}}`;
}

// Fatal UTF-8 decoding. A single leading BOM is preserved in the returned
// string (so the engine sees exactly the decoded bytes) and is never stripped
// from the snapshot. CSV callers reject later markers; JSON callers allow
// U+FEFF string data while JSON.parse still validates marker placement.
export function decodeUtf8Fatal(bytes, { side = null, phase = "input", allowInteriorBom = false } = {}) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError("invalid_encoding", "input is not valid UTF-8", { phase, side });
  }
  const start = text.startsWith(UTF8_BOM) ? 1 : 0;
  if (!allowInteriorBom && text.indexOf(UTF8_BOM, start) !== -1) {
    throw new CliError(
      "invalid_encoding",
      "a UTF-8 byte-order mark is only allowed once, at the start of the file",
      { phase, side },
    );
  }
  return text;
}

// JSON documents are parsed by the host, and JSON.parse does not skip a BOM.
export function stripLeadingBom(text) {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

export function parseJsonText(text, { phase = "input", side = null, what = "JSON" } = {}) {
  try {
    return JSON.parse(stripLeadingBom(text));
  } catch (error) {
    throw new CliError("invalid_json", `${what} is not valid JSON: ${error.message}`, { phase, side });
  }
}

export function ioFailure(action, error, { phase = "input", side = null } = {}) {
  return new CliError("io_error", `${action}: ${error.message}`, { phase, side });
}

// Bounded read: stat first, refuse limit+1 before allocating, then confirm the
// file neither shrank nor grew while being read.
export async function readFileBounded(fsImpl, filePath, maxBytes, { phase = "input", side = null } = {}) {
  let handle;
  try {
    handle = await fsImpl.open(filePath, "r");
  } catch (error) {
    throw ioFailure(`cannot read ${filePath}`, error, { phase, side });
  }
  let operationError = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new CliError("io_error", `${filePath} is not a regular file`, { phase, side });
    }
    if (stat.size > maxBytes) {
      throw new CliError(
        "input_limit_exceeded",
        `${filePath} is ${stat.size} bytes, exceeding the ${maxBytes}-byte raw input budget`,
        { phase, side },
      );
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw new CliError("io_error", `${filePath} changed size while being read`, { phase, side });
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: grown } = await handle.read(probe, 0, 1, stat.size);
    if (grown > 0) {
      throw new CliError("io_error", `${filePath} grew while being read`, { phase, side });
    }
    return buffer;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!operationError) throw ioFailure(`cannot close ${filePath}`, error, { phase, side });
    }
  }
}

export async function lstatOrNull(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Resolves symlinks in every existing ancestor, then re-appends the segments
// that do not exist yet. Used to compare destinations with protected sources
// without falling back to string prefix matching.
export async function canonicalizeForCreation(fsImpl, target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    const stat = await lstatOrNull(fsImpl, current);
    if (stat) {
      const real = await fsImpl.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return tail.length === 0 ? current : path.join(current, ...tail.reverse());
    }
    tail.push(path.basename(current));
    current = parent;
  }
}

export function isSamePath(left, right) {
  return left === right;
}

export function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNotProtected(fsImpl, canonicalDest, protectedPaths) {
  for (const protectedPath of protectedPaths) {
    if (!protectedPath) continue;
    const canonicalProtected = await canonicalizeForCreation(fsImpl, protectedPath);
    if (isSamePath(canonicalDest, canonicalProtected)) {
      throw new CliError("output_conflict", `output path ${canonicalDest} aliases a protected input file`);
    }
  }
}

// Destination policy for the two directory producing commands. The directory
// must be absent or empty, must not be a symlink, and must not alias an input
// file or sit inside a read-only source run.
export async function assertDirectoryDestination(fsImpl, destPath, { protectedPaths = [], sourceRuns = [] } = {}) {
  const resolved = path.resolve(destPath);
  const existing = await lstatOrNull(fsImpl, resolved);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new CliError("output_conflict", `output path ${resolved} is a symlink; refusing to publish through it`);
    }
    if (!existing.isDirectory()) {
      throw new CliError("output_conflict", `output path ${resolved} exists and is not a directory`);
    }
    const entries = await fsImpl.readdir(resolved);
    if (entries.length > 0) {
      throw new CliError("output_conflict", `output directory ${resolved} is not empty`);
    }
  }
  const canonicalDest = await canonicalizeForCreation(fsImpl, resolved);
  for (const sourceRun of sourceRuns) {
    if (!sourceRun) continue;
    const canonicalSource = await canonicalizeForCreation(fsImpl, sourceRun);
    if (isSamePath(canonicalDest, canonicalSource) || containsPath(canonicalSource, canonicalDest)) {
      throw new CliError("output_conflict", `output path ${resolved} is inside or aliases the immutable source run`);
    }
  }
  await assertNotProtected(fsImpl, canonicalDest, protectedPaths);
  const parent = path.dirname(resolved);
  const parentStat = await lstatOrNull(fsImpl, parent);
  if (!parentStat || !parentStat.isDirectory()) {
    throw new CliError("io_error", `parent directory ${parent} does not exist`, { phase: "output" });
  }
  return resolved;
}

// init-config writes a single file with no-overwrite semantics.
export async function assertFileDestination(fsImpl, destPath, { protectedPaths = [] } = {}) {
  const resolved = path.resolve(destPath);
  const existing = await lstatOrNull(fsImpl, resolved);
  if (existing) {
    throw new CliError("output_conflict", `refusing to overwrite existing path ${resolved}`);
  }
  const canonicalDest = await canonicalizeForCreation(fsImpl, resolved);
  await assertNotProtected(fsImpl, canonicalDest, protectedPaths);
  const parentStat = await lstatOrNull(fsImpl, path.dirname(resolved));
  if (!parentStat || !parentStat.isDirectory()) {
    throw new CliError("io_error", `parent directory ${path.dirname(resolved)} does not exist`, { phase: "output" });
  }
  return resolved;
}

async function writeFileSynced(fsImpl, filePath, data, onCreate = null) {
  let handle;
  try {
    handle = await fsImpl.open(filePath, "wx", 0o644);
  } catch (error) {
    throw ioFailure(`cannot create ${filePath}`, error, { phase: "output" });
  }
  onCreate?.();
  let failure = null;
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    failure = ioFailure(`cannot write ${filePath}`, error, { phase: "output" });
  }
  try {
    await handle.close();
  } catch (error) {
    if (!failure) failure = ioFailure(`cannot close ${filePath}`, error, { phase: "output" });
  }
  if (failure) throw failure;
}

async function syncDirectory(fsImpl, dirPath) {
  // Directory fsync improves durability where it is supported; the rename is
  // still the publication step, so an unsupported directory flush is not fatal.
  try {
    const handle = await fsImpl.open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return;
  }
}

async function removeOwnedStaging(fsImpl, staging, warn) {
  try {
    await fsImpl.rm(staging, { recursive: true, force: true });
  } catch (error) {
    warn(`cleanup failed; owned staging directory remains at ${staging}: ${error.message}`);
  }
}

// An unavailable precheck is not an I/O failure: platforms without statfs, or
// with only partial support, continue with checked writes and say so. A real
// filesystem error still aborts the command.
const UNSUPPORTED_STATFS = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "EPERM", "EACCES"]);

export async function checkDiskSpace(dirPath, neededBytes, statfsImpl, warn) {
  const required = (BigInt(neededBytes) * 2n) + (1024n * 1024n);
  let stats;
  try {
    stats = await statfsImpl(dirPath);
  } catch (error) {
    if (!UNSUPPORTED_STATFS.has(error.code)) {
      throw ioFailure(`cannot determine free disk space for ${dirPath}`, error, { phase: "output" });
    }
    warn(`disk space precheck unavailable on this platform (${error.code}); continuing with checked writes`);
    return false;
  }
  if (!Number.isFinite(stats?.bavail) || !Number.isFinite(stats?.bsize)) {
    warn("disk space precheck unavailable on this platform (partial statfs support); continuing with checked writes");
    return false;
  }
  const available = BigInt(stats.bavail) * BigInt(stats.bsize);
  if (available < required) {
    throw new CliError(
      "disk_space_insufficient",
      `only ${available} bytes are available but about ${required} bytes are required to write the run directory`,
      { phase: "output" },
    );
  }
  return true;
}

// Every output is written into a sibling staging directory on the same
// filesystem, flushed and closed, and only then renamed into place. A
// pre-existing empty destination is removed with rmdir immediately before the
// rename; a destination that turns nonempty in between fails safely.
export async function publishRunDirectory({ fs: fsImpl, destPath, entries, warn }) {
  const parent = path.dirname(destPath);
  let staging;
  try {
    staging = await fsImpl.mkdtemp(path.join(parent, ".reconcile-stage-"));
  } catch (error) {
    throw ioFailure(`cannot create a staging directory in ${parent}`, error, { phase: "output" });
  }
  let published = false;
  try {
    for (const [relative, data] of entries) {
      const target = path.join(staging, relative);
      const subdirectory = path.dirname(target);
      if (subdirectory !== staging) await fsImpl.mkdir(subdirectory, { recursive: true });
      await writeFileSynced(fsImpl, target, data);
    }
    await syncDirectory(fsImpl, staging);

    const existing = await lstatOrNull(fsImpl, destPath);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new CliError("output_conflict", `output path ${destPath} changed while the run was being written`);
      }
      if ((await fsImpl.readdir(destPath)).length !== 0) {
        throw new CliError("output_conflict", `output directory ${destPath} became nonempty while the run was being written`);
      }
      await fsImpl.rmdir(destPath);
    }
    await fsImpl.rename(staging, destPath);
    published = true;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw ioFailure(`cannot publish ${destPath}`, error, { phase: "output" });
  } finally {
    if (!published) await removeOwnedStaging(fsImpl, staging, warn);
  }
  return destPath;
}

export async function publishFileExclusive({ fs: fsImpl, destPath, data }) {
  const parent = path.dirname(destPath);
  let staging;
  try {
    staging = await fsImpl.mkdtemp(path.join(parent, ".reconcile-file-stage-"));
  } catch (error) {
    throw ioFailure(`cannot create a staging directory in ${parent}`, error, { phase: "output" });
  }
  const tempPath = path.join(staging, "config.json");
  let ownsTemp = false;
  let failure = null;
  try {
    await writeFileSynced(fsImpl, tempPath, data, () => { ownsTemp = true; });
    try {
      // link() is atomic and exclusive. A filesystem without this primitive
      // must fail rather than degrade to an overwriting rename.
      await fsImpl.link(tempPath, destPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new CliError("output_conflict", `refusing to overwrite existing path ${destPath}`);
      }
      throw ioFailure(`cannot publish ${destPath} atomically without replacement`, error, { phase: "output" });
    }
  } catch (error) {
    failure = error instanceof CliError ? error : ioFailure(`cannot write ${destPath}`, error, { phase: "output" });
  }

  let cleanupError = null;
  if (ownsTemp) {
    try {
      await fsImpl.unlink(tempPath);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupError = error;
    }
  }
  try {
    await fsImpl.rmdir(staging);
  } catch (error) {
    if (error.code !== "ENOENT") cleanupError ??= error;
  }
  if (cleanupError) {
    const residual = `cleanup failed; owned staging directory remains at ${staging}: ${cleanupError.message}`;
    if (failure) {
      failure = new CliError(failure.code, `${failure.message}; ${residual}`, {
        phase: failure.phase,
        side: failure.side,
        record: failure.record,
        field: failure.field,
      });
    } else {
      failure = ioFailure(residual, cleanupError, { phase: "output" });
    }
  }
  if (failure) throw failure;
  return destPath;
}

export async function defaultStatfs(dirPath) {
  if (typeof fsPromises.statfs !== "function") {
    const error = new Error("statfs is not implemented by this Node.js runtime");
    error.code = "ENOSYS";
    throw error;
  }
  return fsPromises.statfs(dirPath);
}
