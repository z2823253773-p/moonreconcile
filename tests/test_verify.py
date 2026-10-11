import io
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

    def test_bootstrap_failure_summary_never_claims_a_pass(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(verify, "bootstrap", side_effect=verify.VerifyError("pinned archive digest changed")):
            result = verify.bootstrap_only_result(Path(temporary), {})
        self.assertEqual(result["status"], "bootstrap-failed")
        self.assertIn("pinned archive digest changed", result["error"])


if __name__ == "__main__":
    unittest.main()
