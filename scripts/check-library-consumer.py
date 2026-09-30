#!/usr/bin/env python3
"""Build an independent MoonBit consumer against an exact Git archive, without Node."""
import io
import pathlib
import shutil
import subprocess
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
with tempfile.TemporaryDirectory(prefix="moonreconcile-consumer-") as directory:
    workspace = pathlib.Path(directory)
    library = workspace / "library"
    library.mkdir()
    archive = subprocess.check_output(["git", "archive", sha], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(library, filter="data")
    shutil.copytree(root / "tests/fixtures/library-consumer", workspace / "consumer")
    subprocess.run(["moon", "work", "init", "library", "consumer"], cwd=workspace, check=True)
    subprocess.run(["moon", "test", "--target", "js"], cwd=workspace / "consumer", check=True)
print(f"Independent MoonBit consumer verified against {sha}; workspace suite includes two external tests")
