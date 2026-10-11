import io
import hashlib
import json
import os
import shlex
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

from scripts import verify


class VerifyTests(unittest.TestCase):
    def test_archive_hash_mismatch_fails_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "archive.tar.gz"
            archive.write_bytes(b"not an archive")
            destination = root / "out"
            with self.assertRaisesRegex(verify.VerifyError, "SHA-256 mismatch"):
                verify.verify_archive(archive, "0" * 64)
            self.assertFalse(destination.exists())

    def test_download_rejects_wrong_hash_and_removes_partial_archive(self):
        body = b"controlled local server payload"
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                target = Path(temporary) / "archive.tar.gz"
                url = f"http://127.0.0.1:{server.server_port}/wrong-hash"
                with self.assertRaisesRegex(verify.VerifyError, "download failed.*SHA-256 mismatch"):
                    verify._download(url, target, "0" * 64)
                self.assertFalse(target.exists())
                self.assertFalse(target.with_name(target.name + ".part").exists())
            self.assertEqual(len(requests), 3)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_tar_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "unsafe.tar.gz"
            data = b"escape"
            with tarfile.open(archive, "w:gz") as handle:
                member = tarfile.TarInfo("../outside")
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))
            destination = root / "extract"
            with self.assertRaisesRegex(verify.VerifyError, "unsafe archive path"):
                verify.safe_extract_tar(archive, destination)
            self.assertFalse((root / "outside").exists())

    def test_tar_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "unsafe.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                link = tarfile.TarInfo("escape")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                handle.addfile(link)
            with self.assertRaisesRegex(verify.VerifyError, "unsafe archive link"):
                verify.safe_extract_tar(archive, root / "extract")

    def test_cache_hit_detects_changed_immutable_tool_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "fixture.tar.gz"
            data = b"immutable fixture"
            with tarfile.open(archive, "w:gz") as handle:
                member = tarfile.TarInfo("tool/bin/tool")
                member.mode = 0o755
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))
            destination = root / "cache"
            verify.safe_extract_tar(archive, destination)
            verify.verify_tar_tree(archive, destination)
            (destination / "tool/bin/tool").write_bytes(b"corrupted")
            with self.assertRaisesRegex(verify.VerifyError, "differs from pinned archive"):
                verify.verify_tar_tree(archive, destination)

    def test_stage_failure_is_recorded_and_returned(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "stage.log"
            result = verify.run_stage("expected-failure", ["python3", "-c", "print('stage output'); raise SystemExit(7)"], Path(temporary), {}, log, 5)
            self.assertEqual(result["exit_code"], 7)
            self.assertEqual(result["status"], "failed")
            self.assertIn("stage output", log.read_text())

    def test_stage_timeout_is_nonzero_and_logged(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "stage.log"
            result = verify.run_stage("expected-timeout", ["python3", "-c", "import time; time.sleep(2)"], Path(temporary), {}, log, 0.05)
            self.assertEqual(result["status"], "failed")
            self.assertIsNotNone(result["timed_out_after_seconds"])

    def test_stage_timeout_terminates_only_its_owned_child_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "late-child-write"
            child = "import time; time.sleep(0.6); open(%r, 'w').write('late')" % str(marker)
            parent = "import subprocess,time,sys; subprocess.Popen([sys.executable,'-c',%r]); time.sleep(3)" % child
            log = root / "timeout.log"
            result = verify.run_stage("owned-timeout", [sys.executable, "-c", parent], root, {}, log, 0.1)
            self.assertEqual(result["exit_code"], 124)
            self.assertTrue(result["owned_process_group_terminated"])
            time.sleep(0.8)
            self.assertFalse(marker.exists(), "descendant in the owned process group survived timeout cleanup")

    def test_clean_source_check_rejects_tracked_and_untracked_changes(self):
        import subprocess

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "verify@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Verify Test"], cwd=root, check=True)
            file = root / "tracked.txt"
            file.write_text("initial\n")
            subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=root, check=True)
            file.write_text("modified\n")
            with self.assertRaisesRegex(verify.VerifyError, "working tree must be clean"):
                verify.require_clean_source(root)
            file.write_text("initial\n")
            (root / "untracked.txt").write_text("untracked\n")
            with self.assertRaisesRegex(verify.VerifyError, "working tree must be clean"):
                verify.require_clean_source(root)

    def node(self):
        pinned = verify.ROOT / ".verify/node/bin/node"
        node = str(pinned) if pinned.is_file() else shutil.which("node")
        self.assertTrue(node, "Node is required for actual verifier server/preload safety regressions")
        return node

    def test_fresh_process_temp_is_external_despite_ambient_checkout_tmpdir(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / ".verify"
            (cache / "tmp").mkdir(parents=True)
            code = "from scripts import verify; import tempfile,json; from pathlib import Path; c=Path(%r); e=verify.tool_env(c,c/'node',c/'moon'); print(json.dumps(e))" % str(cache)
            result = subprocess.run([sys.executable, "-c", code], cwd=verify.ROOT,
                                    env={**os.environ, "TMPDIR": str(cache / "tmp")}, capture_output=True, text=True, check=True)
            env = json.loads(result.stdout)
            probe = subprocess.run([sys.executable, "-c", "import tempfile; print(tempfile.mkdtemp(prefix='moonreconcile-temp-regression-'))"],
                                   env=env, capture_output=True, text=True, check=True)
            owned = Path(probe.stdout.strip())
            try:
                self.assertFalse(owned.resolve().is_relative_to(root.resolve()))
                self.assertFalse(owned.resolve().is_relative_to(verify.ROOT.resolve()))
            finally:
                owned.rmdir()

    def test_bootstrap_helper_timeout_kills_term_ignoring_group_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "survived"
            child = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(0.8); open(%r,'w').write('late')" % str(marker)
            parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',%r]); time.sleep(3)" % child
            with self.assertRaisesRegex(verify.VerifyError, "exit 124"):
                verify._run_checked([sys.executable, "-c", parent], root, {}, "helper-timeout", 0.15)
            time.sleep(0.9)
            self.assertFalse(marker.exists())

    def test_used_server_spawn_path_cleans_up_on_checker_failure_and_timeout(self):
        helper = (verify.ROOT / "scripts/workbench-package-lifecycle.mjs").as_uri()
        for mode in ("failure", "timeout"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ready, marker = root / "ready", root / "survived"
                # The exact exported spawn function used by the strict checker launches
                # a real localhost server with TERM ignored, exercising group escalation.
                server = "const fs=require('node:fs');const net=require('node:net');process.on('SIGTERM',()=>{});net.createServer().listen(0,'127.0.0.1',()=>fs.writeFileSync(%s,'ready'));setTimeout(()=>fs.writeFileSync(%s,'late'),1500);" % (json.dumps(str(ready)), json.dumps(str(marker)))
                code = "import {spawnOwnedServer} from %s;import fs from 'node:fs';const c=spawnOwnedServer(process.execPath,['-e',%s],{stdio:'ignore'});while(!fs.existsSync(%s))await new Promise(r=>setTimeout(r,10));if(c.ownedDetached)throw Error('server escaped runner group');%s" % (json.dumps(helper), json.dumps(server), json.dumps(str(ready)), "process.exit(7)" if mode == "failure" else "await new Promise(r=>setTimeout(r,5000))")
                result = verify.run_stage("checker-server-" + mode, [self.node(), "--input-type=module", "-e", code], root, {}, root / "stage.log", 0.7 if mode == "timeout" else 5)
                self.assertEqual(result["exit_code"], 7 if mode == "failure" else 124)
                self.assertTrue(ready.exists(), "fixture server never started")
                self.assertTrue(result["owned_process_group_terminated"])
                time.sleep(1.6)
                self.assertFalse(marker.exists(), "server survived checker failure/timeout")

    def test_unknown_detached_pipe_holder_fails_boundedly_without_global_scan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pid_path = root / "owned-fixture.pid"
            child = "import time; time.sleep(30)"
            parent = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',%r],start_new_session=True); open(%r,'w').write(str(p.pid)); time.sleep(30)" % (child, str(pid_path))
            started = time.monotonic()
            try:
                result = verify.run_stage("detached-pipe-boundary", [sys.executable, "-c", parent], root, {}, root / "stage.log", 0.3)
                self.assertEqual(result["exit_code"], 124)
                self.assertEqual(result["status"], "failed")
                self.assertIn("pipe drain", result["cleanup_error"])
                self.assertLess(time.monotonic() - started, 8)
                self.assertIn("PIPE DRAIN FAILED", (root / "stage.log").read_text())
            finally:
                # This intentionally unsupported detached fixture is explicitly owned
                # by this test; the runner must never scan unrelated global processes.
                if pid_path.exists():
                    try:
                        os.kill(int(pid_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_environment_blocks_actual_node_preload_and_home_npm_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "injected"
            hook = root / "hook.cjs"
            hook.write_text("require('node:fs').writeFileSync(%s,'injected')" % json.dumps(str(marker)))
            home = root / "home"
            home.mkdir()
            (home / ".npmrc").write_text("registry=https://ambient.invalid/\n")
            node = Path(self.node())
            with patch.dict(os.environ, {"NODE_OPTIONS": "--require=" + str(hook), "PYTHONPATH": str(root), "npm_config_registry": "https://ambient.invalid/", "HOME": str(home)}):
                env = verify.tool_env(root / "cache", node.parent.parent, root / "moon")
            self.assertEqual(env["HOME"], str(home))
            self.assertNotIn("PYTHONPATH", env)
            result = verify.run_stage("no-preload", [str(node), "-e", "console.log('controlled')"], root, env, root / "node.log", 5)
            self.assertEqual(result["exit_code"], 0)
            self.assertFalse(marker.exists())
            npm = node.parent / "npm"
            self.assertTrue(npm.is_file(), "bundled npm is needed for actual npm config regression")
            registry = verify._run_checked([str(npm), "config", "get", "registry"], root, env, "npm config")
            self.assertEqual(registry.strip(), "https://registry.npmjs.org/")
            self.assertEqual((home / ".npmrc").read_text(), "registry=https://ambient.invalid/\n")

    def test_make_entrypoint_blocks_python_sitecustomize_before_startup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "injected"
            (root / "sitecustomize.py").write_text("from pathlib import Path; Path(%r).write_text('injected')" % str(marker))
            command = subprocess.check_output(["make", "-n", "verify"], cwd=verify.ROOT, text=True).strip()
            result = subprocess.run(shlex.split(command) + ["--help"], cwd=verify.ROOT,
                                    env={**os.environ, "PYTHONPATH": str(root)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())

    def test_fresh_positive_control_is_required_and_linux_has_no_historical_claim(self):
        helper = (verify.ROOT / "scripts/workbench-package-network.mjs").as_uri()
        code = "import {externalControlEvidence} from %s;import {spawnSync} from 'node:child_process';const failed=spawnSync(process.execPath,['-e','process.exit(4)']);try{externalControlEvidence('darwin',failed);process.exit(9)}catch(e){if(!/fresh unsandboxed/.test(e.message))throw e}const linux=externalControlEvidence('linux');if(/macOS|previous|preflight/.test(linux))throw Error(linux);console.log('current failure rejected');" % json.dumps(helper)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = verify.run_stage("fresh-control-required", [self.node(), "--input-type=module", "-e", code], root, {}, root / "control.log", 5)
            self.assertEqual(result["exit_code"], 0)

    def test_cache_components_reject_live_dangling_and_file_parents_without_outside_writes(self):
        for name in ("runs", "downloads", "playwright-browsers", "npm-config", "bootstrap-probe"):
            for kind in ("live", "dangling", "file"):
                with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    cache, outside = root / ".verify", root / "outside"
                    cache.mkdir(); outside.mkdir()
                    sentinel = outside / "sentinel"
                    sentinel.write_bytes(b"unchanged")
                    target = cache / name
                    if kind == "file":
                        target.write_bytes(b"owned alternative")
                    else:
                        target.symlink_to(outside if kind == "live" else outside / "missing", target_is_directory=True)
                    with self.assertRaises(verify.VerifyError):
                        verify._ensure_private_cache(target / "child", boundary=root)
                    self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel"])
                    self.assertEqual(sentinel.read_bytes(), b"unchanged")
                    if kind != "file":
                        self.assertTrue(target.is_symlink(), "rejected link must not be deleted")

    def test_npm_pipeline_rejects_root_and_nested_links_before_actual_npm_can_write(self):
        for name in ("", "_logs", "_cacache/index-v5"):
            for dangling in (False, True):
                with self.subTest(name=name, dangling=dangling), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    cache, outside = root / ".verify", root / "outside"
                    cache.mkdir(); outside.mkdir()
                    (outside / "sentinel").write_bytes(b"unchanged")
                    link = cache / "npm-cache" / name if name else cache / "npm-cache"
                    link.parent.mkdir(parents=True, exist_ok=True)
                    link.symlink_to(outside / "missing" if dangling else outside, target_is_directory=True)
                    node = Path(self.node())
                    with self.assertRaises(verify.VerifyError):
                        env = verify.tool_env(cache, node.parent.parent, root / "moon")
                        verify.run_stage("must-not-execute-npm", [str(node.parent / "npm"), "config", "get", "registry"], root, env, root / "stage.log", 5)
                    self.assertFalse((root / "stage.log").exists())
                    self.assertTrue(link.is_symlink())
                    self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel"])
                    self.assertEqual((outside / "sentinel").read_bytes(), b"unchanged")

    def test_browser_writable_metadata_rejects_links_but_bundle_links_remain(self):
        for name in (".links", ".links/record", "__dirlock", "chromium-1/INSTALLATION_COMPLETE"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                cache, outside = root / ".verify", root / "outside"
                browser = cache / "playwright-browsers"
                browser.mkdir(parents=True); outside.mkdir()
                sentinel = outside / "sentinel"
                sentinel.write_bytes(b"unchanged")
                link = browser / name
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(outside if name in (".links", "__dirlock") else outside / "sentinel")
                with self.assertRaises(verify.VerifyError):
                    verify.tool_env(cache, cache / "node", cache / "moon")
                self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel"])
                self.assertEqual(sentinel.read_bytes(), b"unchanged")
                self.assertTrue(link.is_symlink())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / ".verify"
            framework = cache / "playwright-browsers/chromium-1/Framework/Versions"
            (framework / "A").mkdir(parents=True)
            (framework / "Current").symlink_to("A", target_is_directory=True)
            verify.tool_env(cache, cache / "node", cache / "moon")
            self.assertTrue((framework / "Current").is_symlink())

    def test_download_links_are_rejected_before_network_or_unlink(self):
        for name in ("archive.tar.gz", "archive.tar.gz.part"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                cache = root / ".verify/downloads"
                cache.mkdir(parents=True)
                link = cache / name
                link.symlink_to(root / "missing")
                with patch.object(verify.urllib.request, "urlopen", side_effect=AssertionError("network must not run")):
                    with self.assertRaises(verify.VerifyError):
                        verify._download("https://example.invalid/archive", cache / "archive.tar.gz", "0" * 64, boundary=root)
                self.assertTrue(link.is_symlink())
                self.assertFalse((root / "missing").exists())

    def test_bootstrap_probe_rejects_cache_link_before_destructive_reset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".verify").mkdir()
            outside = root / "outside"
            (outside / "node").mkdir(parents=True)
            sentinel = outside / "node/sentinel"
            sentinel.write_bytes(b"preserve")
            (root / ".verify/bootstrap-probe").symlink_to(outside, target_is_directory=True)
            with patch.object(sys, "argv", ["verify.py", "--root", str(root), "--bootstrap-only"]):
                with self.assertRaises(verify.VerifyError):
                    verify.main()
            self.assertEqual(sentinel.read_bytes(), b"preserve")
            self.assertTrue((root / ".verify/bootstrap-probe").is_symlink())

    def test_core_overlay_links_rejected_before_outside_build_cleanup(self):
        for location in ("lib", "lib/core", "lib/core/_build"):
            with self.subTest(location=location), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                cache = root / ".verify"
                downloads = cache / "downloads"
                downloads.mkdir(parents=True)
                def archive(name, entries):
                    target = downloads / name
                    with tarfile.open(target, "w:gz") as handle:
                        for relative, payload in entries.items():
                            member = tarfile.TarInfo(relative)
                            member.mode = 0o755
                            member.size = len(payload)
                            handle.addfile(member, io.BytesIO(payload))
                    return hashlib.sha256(target.read_bytes()).hexdigest()
                node_hash = archive("node.tar.gz", {"node-vfixture/bin/node": b"#!/bin/sh\necho v22.23.3\n"})
                moon_entries = {"bin/moon": b"#!/bin/sh\necho '0.1.20260920 0.10.14+7d59c7ec9'\n", "bin/moonc": b"#!/bin/sh\nexit 0\n"}
                moon_hash = archive("moon-sdk.tar.gz", moon_entries)
                core_hash = archive("moon-core.tar.gz", {"core/source.mbt": b"core fixture\n"})
                moon = cache / "moon"
                verify.safe_extract_tar(downloads / "moon-sdk.tar.gz", moon)
                (moon / ".verify-toolchain.json").write_text("{}")
                outside = root / "outside"
                (outside / "core/_build").mkdir(parents=True)
                (outside / "source.mbt").write_bytes(b"core fixture\n")
                (outside / "core/source.mbt").write_bytes(b"core fixture\n")
                sentinel = outside / "core/_build/sentinel"
                sentinel.write_bytes(b"preserve")
                (outside / "_build").mkdir()
                (outside / "_build/sentinel").write_bytes(b"preserve")
                link = moon / location
                link.parent.mkdir(parents=True, exist_ok=True)
                if location == "lib/core/_build":
                    (moon / "lib/core/source.mbt").write_bytes(b"core fixture\n")
                    target = outside / "_build"
                else:
                    target = outside
                link.symlink_to(target, target_is_directory=True)
                before = {str(p.relative_to(outside)): p.read_bytes() for p in outside.rglob("*") if p.is_file()}
                lock = {"node_url": "https://unused.invalid/node", "node_sha256": node_hash, "moon_url": "https://unused.invalid/moon", "moon_sha256": moon_hash}
                with patch.object(verify, "CORE_SHA256", core_hash):
                    with self.assertRaisesRegex(verify.VerifyError, "symlink"):
                        verify.bootstrap(cache, lock)
                after = {str(p.relative_to(outside)): p.read_bytes() for p in outside.rglob("*") if p.is_file()}
                self.assertEqual(after, before)
                self.assertTrue(link.is_symlink())

    def test_old_python_fails_before_cache_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(sys, "argv", ["verify.py", "--root", str(root), "--bootstrap-only"]), patch.object(sys, "version_info", (3, 11)):
                with self.assertRaisesRegex(verify.VerifyError, "Python 3.12"):
                    verify.main()
            self.assertFalse((root / ".verify").exists())

    def test_real_system_alias_base_and_verified_archive_internal_links_remain_supported(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            # Keep the lexical /tmp prefix even when tempfile canonicalizes its base.
            root = Path("/tmp") / Path(temporary).name
            cache = root / ".verify"
            verify._ensure_private_cache(cache / "runs/example", boundary=verify._cache_boundary(cache))
            self.assertTrue((Path(temporary) / ".verify/runs/example").is_dir())
            archive = root / "archive.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                member = tarfile.TarInfo("tool/bin/tool"); member.mode = 0o755; member.size = 4
                handle.addfile(member, io.BytesIO(b"tool"))
                link = tarfile.TarInfo("tool/bin/alias"); link.type = tarfile.SYMTYPE; link.linkname = "tool"
                handle.addfile(link)
            installed = cache / "sdk"
            verify.safe_extract_tar(archive, installed)
            verify.verify_tar_tree(archive, installed)
            verify._ensure_private_cache(installed, boundary=root)
            self.assertTrue((installed / "tool/bin/alias").is_symlink())
            verify.tool_env(cache, cache / "node", cache / "moon")

    def test_bootstrap_failure_summary_never_claims_a_pass(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(verify, "bootstrap", side_effect=verify.VerifyError("pinned archive digest changed")):
            result = verify.bootstrap_only_result(Path(temporary), {})
        self.assertEqual(result["status"], "bootstrap-failed")
        self.assertIn("pinned archive digest changed", result["error"])


if __name__ == "__main__":
    unittest.main()
