#!/usr/bin/env python3
"""One-command, pinned local acceptance runner. Uses only Python's standard library."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import unittest
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
VERSION = "22.23.3"
MOON_SELECTOR = "latest"
TIMEOUT_SECONDS = 900
MAX_ARCHIVE_BYTES = 260 * 1024 * 1024
MAX_UNPACKED_BYTES = 700 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 120_000

LOCKS = {
    ("Darwin", "arm64"): {
        "node_url": f"https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-darwin-arm64.tar.gz",
        "node_sha256": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
        "moon_url": "https://cli.moonbitlang.com/binaries/latest/moonbit-darwin-aarch64.tar.gz",
        "moon_sha256": "20967f9389ac54508899ee2fc051a3470d051452bac5818a9696ed4c144f3ec3",
    },
    ("Linux", "x86_64"): {
        "node_url": f"https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-linux-x64.tar.gz",
        "node_sha256": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
        "moon_url": "https://cli.moonbitlang.com/binaries/latest/moonbit-linux-x86_64.tar.gz",
        "moon_sha256": "9226694de9ff978db1ecf820b7710c4224e84ec7a76b19a222d96f0cd4e31b6a",
    },
}
CORE_URL = "https://cli.moonbitlang.com/cores/core-latest.tar.gz"
CORE_SHA256 = "6f18b8fdea18f85e628a75e4a1bd3977c5a5c9c6a836fd8824192b0e6bd91b14"


class VerifyError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(path: Path, expected_sha256: str) -> str:
    if not path.is_file() or path.is_symlink():
        raise VerifyError(f"pinned archive missing or not a regular file: {path}")
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise VerifyError(f"archive exceeds {MAX_ARCHIVE_BYTES} byte limit: {path.name}")
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise VerifyError(f"SHA-256 mismatch for {path.name}: expected {expected_sha256}, got {actual}")
    return actual


def archive_member_sha256(archive: Path, suffix: str) -> str:
    with tarfile.open(archive, "r:gz") as bundle:
        matches = [item for item in bundle if item.isfile() and item.name.removeprefix("./").endswith(suffix)]
        if len(matches) != 1:
            raise VerifyError(f"pinned archive must contain exactly one {suffix!r}, found {len(matches)}")
        source = bundle.extractfile(matches[0])
        if source is None:
            raise VerifyError(f"pinned archive member has no data: {matches[0].name}")
        digest = hashlib.sha256()
        with source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


def verify_tar_tree(archive: Path, installed_root: Path, *, strip_first_component: bool = False,
                    allowed_extra_roots: tuple[str, ...] = ()) -> None:
    """Compare every archive-provided immutable file/link with the installed cache."""
    expected: set[str] = set()
    with tarfile.open(archive, "r:gz") as bundle:
        for item in bundle:
            raw = item.name.removeprefix("./").rstrip("/")
            if not raw:
                continue
            parts = PurePosixPath(raw).parts
            if strip_first_component:
                if len(parts) < 2:
                    continue
                parts = parts[1:]
            relative = PurePosixPath(*parts)
            expected.add(str(relative))
            actual = _safe_destination(installed_root, relative)
            if item.isdir():
                if not actual.is_dir() or actual.is_symlink():
                    raise VerifyError(f"cached archive directory differs from pinned archive: {relative}")
            elif item.isfile():
                if not actual.is_file() or actual.is_symlink():
                    raise VerifyError(f"cached archive file missing or linked: {relative}")
                source = bundle.extractfile(item)
                if source is None:
                    raise VerifyError(f"pinned archive member has no data: {item.name}")
                digest = hashlib.sha256()
                with source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
                if sha256_file(actual) != digest.hexdigest():
                    raise VerifyError(f"cached immutable tool input differs from pinned archive: {relative}")
            elif item.issym():
                if not actual.is_symlink() or os.readlink(actual) != item.linkname:
                    raise VerifyError(f"cached archive link differs from pinned archive: {relative}")
            else:
                raise VerifyError(f"unexpected pinned archive entry type: {relative}")
    for path in installed_root.rglob("*"):
        if path.is_symlink() or path.is_file():
            relative = path.relative_to(installed_root).as_posix()
            if relative in expected or relative == ".verify-toolchain.json":
                continue
            if any(relative == root or relative.startswith(root.rstrip("/") + "/") for root in allowed_extra_roots):
                continue
            raise VerifyError(f"unexpected file in cached toolchain: {relative}")


def _member_path(name: str) -> PurePosixPath:
    member = PurePosixPath(name)
    if member.is_absolute() or any(part in ("..", "") for part in member.parts):
        raise VerifyError(f"unsafe archive path: {name!r}")
    return member


def _safe_destination(root: Path, member: PurePosixPath) -> Path:
    target = root.joinpath(*member.parts)
    try:
        target.relative_to(root)
    except ValueError as error:
        raise VerifyError(f"unsafe archive path: {member}") from error
    cursor = root
    for part in member.parts[:-1]:
        cursor = cursor / part
        if cursor.is_symlink():
            raise VerifyError(f"archive path traverses a symlink: {member}")
    return target


def safe_extract_tar(archive: Path, destination: Path) -> None:
    """Extract bounded tar.gz files without trusting archive paths or links."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    links: list[tuple[Path, str]] = []
    total = 0
    count = 0
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for item in bundle:
                count += 1
                if count > MAX_ARCHIVE_MEMBERS:
                    raise VerifyError("archive member count limit exceeded")
                raw = item.name.removeprefix("./")
                if raw in ("", "."):
                    continue
                member = _member_path(raw.rstrip("/") if item.isdir() else raw)
                target = _safe_destination(root, member)
                if item.isdir():
                    if target.exists() and not target.is_dir():
                        raise VerifyError(f"archive directory collides with a file: {member}")
                    target.mkdir(parents=True, exist_ok=True)
                elif item.isfile():
                    total += item.size
                    if item.size < 0 or total > MAX_UNPACKED_BYTES:
                        raise VerifyError("archive unpacked byte limit exceeded")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists() or target.is_symlink():
                        raise VerifyError(f"archive member collision: {member}")
                    source = bundle.extractfile(item)
                    if source is None:
                        raise VerifyError(f"archive member has no data: {member}")
                    with source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                    target.chmod(item.mode & 0o777)
                elif item.issym():
                    link = PurePosixPath(item.linkname)
                    if link.is_absolute():
                        raise VerifyError(f"unsafe archive link: {member} -> {item.linkname}")
                    resolved = PurePosixPath(os.path.normpath(str(member.parent / link)))
                    if resolved.is_absolute() or ".." in resolved.parts:
                        raise VerifyError(f"unsafe archive link: {member} -> {item.linkname}")
                    links.append((target, item.linkname))
                else:
                    raise VerifyError(f"unsupported archive entry type: {member}")
        for target, linkname in links:
            if target.exists() or target.is_symlink():
                raise VerifyError(f"archive link collides with an entry: {target.relative_to(root)}")
            target.parent.mkdir(parents=True, exist_ok=True)
            resolved_target = (target.parent / linkname).resolve(strict=False)
            if not resolved_target.is_relative_to(root):
                raise VerifyError(f"unsafe archive link target: {target.relative_to(root)} -> {linkname}")
            target.symlink_to(linkname)
    except (tarfile.TarError, OSError) as error:
        if isinstance(error, VerifyError):
            raise
        raise VerifyError(f"archive extraction failed: {error}") from error


def _ensure_private_cache(path: Path) -> None:
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        raise VerifyError(f"cache path must be an owned directory, not a symlink or file: {path}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise VerifyError(f"cache path is not a real directory: {path}")


def _download(url: str, target: Path, expected_sha256: str) -> str:
    _ensure_private_cache(target.parent)
    if target.exists():
        return verify_archive(target, expected_sha256)
    partial = target.with_name(target.name + ".part")
    if partial.exists() or partial.is_symlink():
        partial.unlink()
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "moonreconcile-verify/1"})
            with urllib.request.urlopen(request, timeout=30) as response, partial.open("xb") as output:
                received = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > MAX_ARCHIVE_BYTES:
                        raise VerifyError(f"download exceeds {MAX_ARCHIVE_BYTES} byte limit")
                    output.write(chunk)
            verify_archive(partial, expected_sha256)
            partial.replace(target)
            return expected_sha256
        except Exception as error:
            last_error = error
            if partial.exists():
                partial.unlink()
            if attempt < 2:
                time.sleep(1 + attempt)
    raise VerifyError(f"download failed for pinned URL {url}: {last_error}") from last_error


def _run_checked(argv: list[str], cwd: Path, env: dict[str, str], label: str, timeout: int = 120) -> str:
    # Share stage ownership and timeout handling with bootstrap helpers, too.
    with tempfile.TemporaryDirectory(prefix="moonreconcile-helper-", dir=system_temp_base(cwd)) as temporary:
        log = Path(temporary) / "helper.log"
        result = run_stage(label, argv, cwd, env, log, timeout)
        output = log.read_text().split("\n\n", 1)[-1]
        if result["exit_code"] != 0:
            raise VerifyError(f"{label} could not complete (exit {result['exit_code']}):\n{output[-4000:]}")
        return output


def _make_moon_executables(bin_dir: Path) -> None:
    for entry in bin_dir.iterdir():
        if entry.is_symlink():
            continue
        if entry.is_file():
            entry.chmod(entry.stat().st_mode | 0o111)
    tcc = bin_dir / "internal/tcc"
    if tcc.is_file() and not tcc.is_symlink():
        tcc.chmod(tcc.stat().st_mode | 0o111)


def bootstrap(cache: Path, lock: dict[str, str]) -> dict[str, str]:
    """Verify immutable archives, extract to owned staging, and install privately."""
    _ensure_private_cache(cache)
    downloads = cache / "downloads"
    _ensure_private_cache(downloads)
    node_archive = downloads / "node.tar.gz"
    moon_archive = downloads / "moon-sdk.tar.gz"
    core_archive = downloads / "moon-core.tar.gz"
    node_hash = _download(lock["node_url"], node_archive, lock["node_sha256"])
    moon_hash = _download(lock["moon_url"], moon_archive, lock["moon_sha256"])
    core_hash = _download(CORE_URL, core_archive, CORE_SHA256)
    expected_node_bin_hash = archive_member_sha256(node_archive, "bin/node")
    expected_moon_bin_hash = archive_member_sha256(moon_archive, "bin/moon")
    expected_moonc_bin_hash = archive_member_sha256(moon_archive, "bin/moonc")

    node_home = cache / "node"
    if node_home.is_symlink() or (node_home.exists() and not node_home.is_dir()):
        raise VerifyError("cached Node installation path must be a real directory")
    if (node_home / "bin").is_symlink() or (node_home / "bin/node").is_symlink():
        raise VerifyError("cached Node installation contains an unexpected symlink")
    if not (node_home / "bin/node").is_file():
        staging = Path(tempfile.mkdtemp(prefix="node-stage-", dir=cache))
        try:
            safe_extract_tar(node_archive, staging)
            candidates = list(staging.glob("node-v*/bin/node"))
            if len(candidates) != 1:
                raise VerifyError("Node archive layout did not contain exactly one node-v*/bin/node")
            extracted = candidates[0].parent.parent
            if node_home.exists() or node_home.is_symlink():
                shutil.rmtree(node_home)
            extracted.rename(node_home)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    node = node_home / "bin/node"
    if sha256_file(node) != expected_node_bin_hash:
        raise VerifyError("cached Node executable hash does not match the pinned v22.23.3 binary")
    verify_tar_tree(node_archive, node_home, strip_first_component=True)
    version = _run_checked([str(node), "--version"], ROOT, {"PATH": str(node.parent)}, "Node version").strip()
    if version != f"v{VERSION}":
        raise VerifyError(f"Node version mismatch: expected v{VERSION}, got {version}")

    moon_home = cache / "moon"
    if moon_home.is_symlink() or (moon_home.exists() and not moon_home.is_dir()):
        raise VerifyError("cached Moon installation path must be a real directory")
    marker = moon_home / ".verify-toolchain.json"
    if not marker.is_file():
        staging = Path(tempfile.mkdtemp(prefix="moon-stage-", dir=cache))
        try:
            safe_extract_tar(moon_archive, staging)
            lib = staging / "lib"
            core = lib / "core"
            if core.exists() or core.is_symlink():
                shutil.rmtree(core)
            safe_extract_tar(core_archive, lib)
            bin_dir = staging / "bin"
            moon = bin_dir / "moon"
            moonc = bin_dir / "moonc"
            if not moon.is_file() or not moonc.is_file():
                raise VerifyError("Moon SDK archive did not contain bin/moon and bin/moonc")
            _make_moon_executables(bin_dir)
            env = {
                "PATH": str(bin_dir), "MOON_HOME": str(staging),
                "MOONBIT_HOME": str(staging), "TMPDIR": str(system_temp_base(ROOT)), "LANG": "C.UTF-8",
            }
            moon_version = _run_checked([str(moon), "version", "--all"], ROOT, env, "Moon version").strip()
            expected_version = "0.1.20260920"
            if expected_version not in moon_version or "0.10.14+7d59c7ec9" not in moon_version:
                raise VerifyError(f"Moon toolchain version mismatch: {moon_version}")
            if sha256_file(moon) != expected_moon_bin_hash or sha256_file(moonc) != expected_moonc_bin_hash:
                raise VerifyError("Moon SDK executable hash does not match the verified pinned binaries")
            (staging / ".verify-toolchain.json").write_text(json.dumps({
                "moon_sdk_sha256": moon_hash, "moon_core_sha256": core_hash,
                "moon_version_output": moon_version,
            }, indent=2) + "\n")
            if moon_home.exists() or moon_home.is_symlink():
                shutil.rmtree(moon_home)
            staging.rename(moon_home)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    # A marker alone is insufficient: re-verify source archives and executables on every run.
    verify_archive(node_archive, lock["node_sha256"])
    verify_archive(moon_archive, lock["moon_sha256"])
    verify_archive(core_archive, CORE_SHA256)
    moon = moon_home / "bin/moon"
    moonc = moon_home / "bin/moonc"
    if moon_home.is_symlink() or moon.is_symlink() or moonc.is_symlink() or not moon.is_file() or not moonc.is_file():
        raise VerifyError("cached Moon installation is missing or contains an unexpected executable link")
    if sha256_file(node) != expected_node_bin_hash or sha256_file(moon) != expected_moon_bin_hash or sha256_file(moonc) != expected_moonc_bin_hash:
        raise VerifyError("cached tool executable hash mismatch; the extracted cache cannot be trusted")
    # The SDK archive's lib/core is deliberately replaced by the separately pinned core archive.
    verify_tar_tree(moon_archive, moon_home, allowed_extra_roots=("lib/core",))
    core_dir = moon_home / "lib/core"
    # Bundling creates disposable metadata here. Verify all pinned source bytes first, then discard
    # that owned build cache and bundle again so stale generated data is never trusted.
    verify_tar_tree(core_archive, core_dir, strip_first_component=True, allowed_extra_roots=("_build",))
    generated = core_dir / "_build"
    if generated.is_symlink():
        raise VerifyError("refusing a symlink at the owned Moon core build-cache path")
    if generated.exists():
        shutil.rmtree(generated)
    verify_tar_tree(core_archive, core_dir, strip_first_component=True)
    env = tool_env(cache, node_home, moon_home)
    core = moon_home / "lib/core"
    _run_checked([str(moon), "-C", str(core), "bundle", "--warn-list", "-a", "--all"], ROOT, env, "Moon core bundle", 300)
    _run_checked([str(moon), "-C", str(core), "bundle", "--warn-list", "-a", "--target", "wasm-gc", "--quiet"], ROOT, env, "Moon wasm-gc core bundle", 300)
    moon_version = _run_checked([str(moon), "version", "--all"], ROOT, env, "cached Moon version").strip()
    if "0.1.20260920" not in moon_version or "0.10.14+7d59c7ec9" not in moon_version:
        raise VerifyError(f"cached Moon version mismatch: {moon_version}")
    return {"node_version": version, "moon_version": moon_version,
            "node_archive_sha256": node_hash, "moon_sdk_sha256": moon_hash, "moon_core_sha256": core_hash}


def bootstrap_only_result(cache: Path, lock: dict[str, str]) -> dict[str, object]:
    try:
        return {"status": "bootstrap-passed", "cache": str(cache), "toolchain": bootstrap(cache, lock)}
    except Exception as error:
        return {"status": "bootstrap-failed", "cache": str(cache), "error": str(error)}


def system_temp_base(root: Path) -> Path:
    # Do not trust ambient TMPDIR: nested Moon workspaces affect enclosing checkouts.
    base = Path("/private/tmp" if platform.system() == "Darwin" else "/tmp").resolve()
    if base.is_relative_to(root.resolve()):
        raise VerifyError("system temporary directory must be outside the source checkout")
    return base


def invocation_env() -> dict[str, str]:
    allowed = {"HOME", "USER", "LOGNAME", "LANG", "TZ", "SYSTEMROOT",
               "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
               "http_proxy", "https_proxy", "all_proxy", "no_proxy",
               "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"}
    return {**{key: value for key, value in os.environ.items() if key in allowed or key.startswith("LC_")},
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONNOUSERSITE": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}


def tool_env(cache: Path, node_home: Path, moon_home: Path, temporary: Path | None = None) -> dict[str, str]:
    browser_cache = cache / "playwright-browsers"
    _ensure_private_cache(browser_cache)
    config = cache / "npm-config"
    _ensure_private_cache(config)
    for name in ("user.npmrc", "global.npmrc"):
        target = config / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise VerifyError("npm config override must be an owned regular file")
        target.write_text("")
    # Preserve HOME and documented transport/locale inputs, but no executable
    # preloads, Python search paths, dynamic-loader settings, or ambient npm config.
    ambient = invocation_env()
    scratch = temporary if temporary is not None else system_temp_base(cache.parent)
    return {
        **ambient,
        "PATH": os.pathsep.join([str(node_home / "bin"), str(moon_home / "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
        "MOON_HOME": str(moon_home), "MOONBIT_HOME": str(moon_home),
        "PLAYWRIGHT_BROWSERS_PATH": str(browser_cache), "npm_config_cache": str(cache / "npm-cache"),
        "npm_config_userconfig": str(config / "user.npmrc"), "npm_config_globalconfig": str(config / "global.npmrc"),
        "PYTHONNOUSERSITE": "1", "TMPDIR": str(scratch), "TMP": str(scratch), "TEMP": str(scratch),
        "MOONRECONCILE_NODE_BINARY": str(node_home / "bin/node"),
    }


def require_clean_source(root: Path) -> str:
    result = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=root,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise VerifyError(f"git status failed: {result.stderr.strip()}")
    if result.stdout.strip():
        raise VerifyError("working tree must be clean before make verify:\n" + result.stdout.rstrip())
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if head.returncode != 0:
        raise VerifyError(f"git rev-parse failed: {head.stderr.strip()}")
    verify_tracked_blobs(root, head.stdout.strip())
    return head.stdout.strip()


def verify_tracked_blobs(root: Path, head: str) -> int:
    tree = subprocess.run(["git", "ls-tree", "-rz", "--full-tree", head], cwd=root,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if tree.returncode != 0:
        raise VerifyError(f"git ls-tree failed: {tree.stderr.decode('utf-8', 'replace').strip()}")
    count = 0
    for record in tree.stdout.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split(" ", 2)
        if kind != "blob":
            continue
        path = root / os.fsdecode(raw_path)
        if mode == "120000":
            if not path.is_symlink():
                raise VerifyError(f"tracked symlink is missing or changed type: {os.fsdecode(raw_path)}")
            payload = os.fsencode(os.readlink(path))
        else:
            if path.is_symlink() or not path.is_file():
                raise VerifyError(f"tracked source file is missing or changed type: {os.fsdecode(raw_path)}")
            payload = path.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(payload)).encode("ascii") + b"\0" + payload).hexdigest()
        if actual != oid:
            raise VerifyError(f"tracked source blob differs from HEAD: {os.fsdecode(raw_path)}")
        count += 1
    return count


def run_stage(name: str, argv: list[str], cwd: Path, env: dict[str, str], log_path: Path,
              timeout: float) -> dict[str, object]:
    started = time.monotonic()
    result: dict[str, object] = {"name": name, "argv": argv, "cwd": str(cwd), "started_at": datetime.now(timezone.utc).isoformat()}
    try:
        stage_env = {**env, "MOONRECONCILE_VERIFIER_PROCESS_GROUP": "1"}
        process = subprocess.Popen(argv, cwd=cwd, env=stage_env, text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _stop_owned_process_group(process)
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired as error:
                # An unknown independently detached process may hold inherited pipes.
                # Do not scan/kill global processes or wait without a bound.
                output = error.output or ""
                if isinstance(output, bytes):
                    output = output.decode("utf-8", "replace")
                if process.stdout is not None:
                    process.stdout.close()
                result["cleanup_error"] = "pipe drain exceeded 5 seconds after owned group cleanup"
                output += "\nPIPE DRAIN FAILED: unknown detached pipe holder; stage remains failed\n"
            output = (output or "") + f"\nTIMEOUT after {timeout} seconds; owned process group terminated\n"
            code = 124
            result.update({"exit_code": code, "status": "failed", "timed_out_after_seconds": timeout,
                           "owned_process_group_terminated": True})
        else:
            code = process.returncode
            _stop_owned_process_group(process)
            result["owned_process_group_terminated"] = True
        output = output or ""
        if "status" not in result:
            result.update({"exit_code": code, "status": "passed" if code == 0 else "failed"})
    except KeyboardInterrupt:
        if "process" in locals():
            _stop_owned_process_group(process)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                if process.stdout is not None:
                    process.stdout.close()
        raise
    except OSError as error:
        output = f"PROCESS START FAILURE: {error}\n"
        code = 127
        result.update({"exit_code": code, "status": "failed", "start_error": str(error)})
    duration = round(time.monotonic() - started, 3)
    result["duration_seconds"] = duration
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(f"stage: {name}\nargv: {json.dumps(argv)}\nexit: {code}\nduration_seconds: {duration}\n\n{output}")
    return result


def _stop_owned_process_group(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        # The direct child may have exited while a descendant still holds the stage pipes.
        pass
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # Clear any unresponsive descendants in this invocation-owned session before communicate().
    time.sleep(0.05)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise VerifyError("owned direct process could not be reaped after SIGKILL") from error


def _strict_command(env: dict[str, str], node: Path) -> list[str]:
    script = "scripts/check-workbench-package.mjs"
    if platform.system() == "Darwin":
        if not Path("/usr/bin/sandbox-exec").is_file():
            raise VerifyError("strict package gate requires macOS sandbox-exec; no isolation skip is allowed")
        # The checker itself performs the positive external-network control before sandboxing its child.
        return [str(node), script]
    if platform.system() == "Linux":
        unshare = shutil.which("unshare", path=env["PATH"])
        ip = shutil.which("ip", path=env["PATH"])
        sudo = shutil.which("sudo", path=env["PATH"])
        if not unshare or not ip or not sudo:
            raise VerifyError("Linux strict package gate requires sudo, unshare, and ip; it cannot be silently skipped")
        # sudo executes a real network namespace and raises loopback only; this is not a claimed fake env isolation.
        wrapper = 'ip link set lo up && exec "$@"'
        return [sudo, "-n", unshare, "--net", "--", "/bin/sh", "-c", wrapper, "verify-netns",
                "env", "-i", "MOONRECONCILE_NETWORK_ISOLATED=1",
                "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1", f"MOONRECONCILE_NODE_BINARY={node}",
                f"MOONRECONCILE_VALIDATION_EVIDENCE={env['MOONRECONCILE_VALIDATION_EVIDENCE']}",
                f"MOONRECONCILE_PACKAGE_DIR={env['MOONRECONCILE_PACKAGE_DIR']}",
                f"MOONRECONCILE_PACKAGE_ZIP={env['MOONRECONCILE_PACKAGE_ZIP']}",
                "MOONRECONCILE_VERIFIER_PROCESS_GROUP=1", "PYTHONNOUSERSITE=1",
                f"TMPDIR={env['TMPDIR']}", f"TMP={env['TMP']}",
                f"npm_config_userconfig={env['npm_config_userconfig']}",
                f"npm_config_globalconfig={env['npm_config_globalconfig']}",
                f"MOON_HOME={env['MOON_HOME']}", f"MOONBIT_HOME={env['MOONBIT_HOME']}",
                f"PLAYWRIGHT_BROWSERS_PATH={env['PLAYWRIGHT_BROWSERS_PATH']}",
                f"npm_config_cache={env['npm_config_cache']}", f"PATH={env['PATH']}",
                str(node), script]
    raise VerifyError(f"strict package isolation is unsupported on {platform.system()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--unit-only", action="store_true", help="run verifier regression tests only")
    parser.add_argument("--bootstrap-only", action="store_true", help="cold-check pinned bootstrap without running product gates")
    args = parser.parse_args()
    root = args.root.resolve()
    clean_env = invocation_env()
    os.environ.clear()
    os.environ.update(clean_env)  # This process and its children only; preserve the real HOME.
    if args.unit_only:
        sys.path.insert(0, str(root))  # Only this explicitly selected checkout is added after isolated startup.
        suite = unittest.TestLoader().discover(str(root / "tests"), pattern="test_verify.py")
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1

    if args.bootstrap_only:
        lock = LOCKS.get((platform.system(), platform.machine()))
        if not lock:
            raise VerifyError(f"no hardcoded Node/Moon archive lock for {platform.system()} {platform.machine()}")
        verify_cache = root / ".verify"
        if verify_cache.is_symlink() or (verify_cache.exists() and not verify_cache.is_dir()):
            raise VerifyError(".verify cache must be a real project-local directory")
        cache = root / ".verify" / "bootstrap-probe"
        if cache.exists():
            if cache.is_symlink() or not cache.is_dir():
                raise VerifyError("bootstrap probe cache path must be an owned directory")
            for installed in (cache / "node", cache / "moon", cache / "home", cache / "tmp"):
                if installed.is_symlink():
                    raise VerifyError(f"bootstrap probe refuses a symlink: {installed}")
                if installed.is_dir():
                    shutil.rmtree(installed)
                elif installed.exists():
                    installed.unlink()
        _ensure_private_cache(cache)
        result = bootstrap_only_result(cache, lock)
        print(json.dumps(result, indent=2))
        return 0 if result["status"] == "bootstrap-passed" else 1

    # Gate clean-source before touching downloads, browser caches, or generated package outputs.
    head = require_clean_source(root)
    tracked_blob_count = verify_tracked_blobs(root, head)
    lock = LOCKS.get((platform.system(), platform.machine()))
    if not lock:
        raise VerifyError(f"no hardcoded Node/Moon archive lock for {platform.system()} {platform.machine()}")
    cache = root / ".verify"
    if cache.is_symlink() or (cache.exists() and not cache.is_dir()):
        raise VerifyError(".verify cache must be a real project-local directory")
    _ensure_private_cache(cache)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}"
    run_dir = cache / "runs" / run_id
    _ensure_private_cache(run_dir)
    temporary = tempfile.TemporaryDirectory(prefix="moonreconcile-verify-", dir=system_temp_base(root))
    tmp = Path(temporary.name)
    logs = run_dir / "logs"
    logs.mkdir(mode=0o700)
    summary: dict[str, object] = {
        "status": "running", "head": head, "branch": subprocess.check_output(["git", "branch", "--show-current"], cwd=root, text=True).strip(),
        "platform": f"{platform.system()} {platform.machine()}", "started_at": datetime.now(timezone.utc).isoformat(),
        "tracked_blob_count_at_start": tracked_blob_count, "stages": [],
        "lock": {"node_version": VERSION, "moon_selector": MOON_SELECTOR,
                                  "node_sha256": lock["node_sha256"], "moon_sha256": lock["moon_sha256"], "core_sha256": CORE_SHA256},
    }
    summary_path = run_dir / "summary.json"
    package_root: Path | None = None
    try:
        try:
            toolchain = bootstrap(cache, lock)
            summary["stages"].append({"name": "toolchain-bootstrap", "status": "passed", **toolchain})
        except Exception as error:
            summary["stages"].append({"name": "toolchain-bootstrap", "status": "failed", "error": str(error)})
            raise
        summary["toolchain"] = toolchain
        node_home, moon_home = cache / "node", cache / "moon"
        env = tool_env(cache, node_home, moon_home, tmp)
        summary["owned_temporary_root"] = str(tmp)
        (cache / "npm-cache").mkdir(mode=0o700, exist_ok=True)
        node = node_home / "bin/node"
        npm = node_home / "bin/npm"
        if platform.system() == "Windows":
            raise VerifyError("Windows is unsupported by the pinned verifier")
        _run_checked([str(npm), "--version"], root, env, "bundled npm version")
        stages: list[tuple[str, list[str], float]] = [
            ("verifier-unit", [sys.executable, "-I", "scripts/verify.py", "--unit-only"], TIMEOUT_SECONDS),
            ("moon-check", [str(moon_home / "bin/moon"), "check", "--target", "js"], TIMEOUT_SECONDS),
            ("moon-test", [str(moon_home / "bin/moon"), "test", "--target", "js"], TIMEOUT_SECONDS),
            ("moon-info", [str(moon_home / "bin/moon"), "info"], TIMEOUT_SECONDS),
            ("moon-fmt-check", [str(moon_home / "bin/moon"), "fmt", "--check"], TIMEOUT_SECONDS),
            ("npm-ci", [str(npm), "ci", "--no-audit", "--no-fund", "--cache", str(cache / "npm-cache")], TIMEOUT_SECONDS),
        ]
        for name, argv, timeout in stages:
            outcome = run_stage(name, argv, root, env, logs / f"{name}.log", timeout)
            summary["stages"].append(outcome)
            if outcome["exit_code"] != 0:
                raise VerifyError(f"stage {name} failed with exit {outcome['exit_code']}")
        install = [str(npm), "exec", "--", "playwright", "install", "chromium"]
        outcome = run_stage("playwright-chromium", install, root, env, logs / "playwright-chromium.log", TIMEOUT_SECONDS)
        summary["stages"].append(outcome)
        if outcome["exit_code"] != 0:
            raise VerifyError(f"stage playwright-chromium failed with exit {outcome['exit_code']}")
        browser_stage_log = logs / "playwright-browser-path.log"
        browser_stage = run_stage("playwright-browser-path", [str(node), "--input-type=module", "-e",
                                    "import { chromium } from '@playwright/test'; process.stdout.write(chromium.executablePath());"],
                                  root, env, browser_stage_log, 30)
        summary["stages"].append(browser_stage)
        if browser_stage["exit_code"] != 0:
            raise VerifyError("Playwright Chromium path lookup failed")
        browser_path = browser_stage_log.read_text().split("\n\n", 1)[-1].strip()
        browser_cache = (cache / "playwright-browsers").resolve()
        candidate_browser = Path(browser_path)
        if not candidate_browser.is_file() or not candidate_browser.resolve().is_relative_to(browser_cache):
            raise VerifyError(f"Playwright pinned Chromium is missing or outside project cache: {browser_path}")
        env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] = str(candidate_browser.resolve())
        summary["playwright_chromium"] = {"executable": env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"],
                                           "source": "@playwright/test locked package executablePath"}

        for name, argv in [
            ("build", [str(npm), "run", "build"]),
            ("npm-test", [str(npm), "test"]),
            ("workbench-tests", [str(npm), "run", "test:workbench"]),
            ("workbench-browser-e2e", [str(npm), "run", "test:workbench:e2e"]),
            ("workflows", [str(npm), "run", "test:workflows"]),
            ("public-data", [str(npm), "run", "test:public-data"]),
        ]:
            outcome = run_stage(name, argv, root, env, logs / f"{name}.log", TIMEOUT_SECONDS)
            summary["stages"].append(outcome)
            if outcome["exit_code"] != 0:
                raise VerifyError(f"stage {name} failed with exit {outcome['exit_code']}")

        # Python is an explicit system prerequisite; it is not installed or placed in the runtime PATH.
        python = sys.executable
        if not python:
            raise VerifyError("Python 3 is required for the independent assignment and consumer gates")
        required = [
            ("assignment-oracle", [python, "-I", "scripts/check-assignment-oracle.py"]),
            ("library-consumer", [python, "-I", "scripts/check-library-consumer.py"]),
            ("readme-smoke", [str(node), "scripts/readme-smoke.mjs"]),
            ("package-unit", [str(node), "--test", "tests/workbench-package.test.mjs"]),
            ("package-validation-unit", [str(node), "--test", "tests/workbench-package-validation.test.mjs"]),
        ]
        for name, argv in required:
            outcome = run_stage(name, argv, root, env, logs / f"{name}.log", TIMEOUT_SECONDS)
            summary["stages"].append(outcome)
            if outcome["exit_code"] != 0:
                raise VerifyError(f"stage {name} failed with exit {outcome['exit_code']}")

        package_root = Path(tempfile.mkdtemp(prefix="moonreconcile-verify-package-", dir=tmp))
        package_dir = package_root / "package"
        package_zip = package_root / "package.zip"
        package_env = dict(env)
        validation_json = run_dir / "workbench-package-validation.json"
        package_env.update({"MOONRECONCILE_PACKAGE_DIR": str(package_dir), "MOONRECONCILE_PACKAGE_ZIP": str(package_zip),
                            "MOONRECONCILE_VALIDATION_EVIDENCE": str(validation_json)})
        stage = run_stage("package-workbench", [str(node), "scripts/package-workbench.mjs"], root, package_env, logs / "package-workbench.log", TIMEOUT_SECONDS)
        summary["stages"].append(stage)
        if stage["exit_code"] != 0:
            raise VerifyError(f"package-workbench failed with exit {stage['exit_code']}")
        try:
            strict_argv = _strict_command(package_env, node)
        except Exception as error:
            summary["stages"].append({"name": "strict-offline-package", "status": "failed", "error": str(error)})
            raise
        validation = run_stage("strict-offline-package", strict_argv, root, package_env,
                               logs / "strict-offline-package.log", TIMEOUT_SECONDS)
        summary["stages"].append(validation)
        if validation["exit_code"] != 0:
            raise VerifyError(f"strict-offline-package failed with exit {validation['exit_code']}")
        summary["artifacts"] = {"package_zip_sha256": sha256_file(package_zip),
                                "package_zip_bytes": package_zip.stat().st_size,
                                "validation_json": package_env["MOONRECONCILE_VALIDATION_EVIDENCE"]}
        summary["status"] = "passed"
    except Exception as error:
        summary["status"] = "failed"
        summary["error"] = str(error)
        summary["failure_stage"] = next((stage["name"] for stage in summary["stages"] if stage["status"] == "failed"), None)
    finally:
        summary["ended_at"] = datetime.now(timezone.utc).isoformat()
        try:
            state = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=root,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if state.returncode != 0:
                raise VerifyError(f"final git status failed: {state.stderr.strip()}")
            current = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if current.returncode != 0:
                raise VerifyError(f"final git rev-parse failed: {current.stderr.strip()}")
            summary["source_after"] = state.stdout.splitlines()
            summary["head_after"] = current.stdout.strip()
            summary["tracked_blob_count_after"] = verify_tracked_blobs(root, head)
            if summary["source_after"] or summary["head_after"] != head:
                raise VerifyError("source identity or clean status changed while verification was running")
        except Exception as error:
            summary["status"] = "failed"
            summary["error"] = str(error)
        if package_root is not None and package_root.exists():
            try:
                if package_root.is_symlink() or not package_root.resolve().is_relative_to(tmp.resolve()) or not package_root.name.startswith("moonreconcile-verify-package-"):
                    raise VerifyError(f"refusing to remove package output outside its owned temporary directory: {package_root}")
                shutil.rmtree(package_root)
                summary["owned_package_cleanup"] = "removed"
            except Exception as error:
                summary["status"] = "failed"
                summary["error"] = f"owned package cleanup failed: {error}"
        try:
            temporary.cleanup()
            summary["owned_temporary_cleanup"] = "removed"
        except Exception as error:
            summary["status"] = "failed"
            summary["error"] = f"owned temporary cleanup failed: {error}"
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps({"status": summary["status"], "head": head, "run": str(run_dir),
                          "summary": str(summary_path), "failure_stage": summary.get("failure_stage"),
                          "error": summary.get("error")}, indent=2))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerifyError as error:
        print(f"make verify: {error}", file=sys.stderr)
        raise SystemExit(2)
