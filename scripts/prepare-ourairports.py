#!/usr/bin/env python3
"""Reproduce the pinned public-data fixture with standard-library CSV parsing."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--before", type=Path, required=True)
parser.add_argument("--after", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
provenance = json.loads((root / "examples/ourairports/provenance.json").read_text(encoding="utf-8"))
if args.out.exists():
    parser.error("--out must not exist; preparation never overwrites a prior fixture")
tables = []
subsets = []
for source, metadata in zip([args.before, args.after], provenance["snapshots"]):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != metadata["full_sha256"]:
        parser.error(f"{source.name}: bytes do not match pinned source hash")
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8")))
    headers = reader.fieldnames
    rows = list(reader)
    if len(rows) != metadata["full_records"]:
        parser.error("full source record count changed")
    subset = [row for row in rows if row["iso_country"] in {"CN", "FR"}]
    if any(None in row for row in subset) or len({row["id"] for row in subset}) != len(subset):
        parser.error("invalid row width or duplicate source ID")
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(subset)
    serialized = buffer.getvalue().encode("utf-8")
    if hashlib.sha256(serialized).hexdigest() != metadata["subset_sha256"]:
        parser.error("reproduced subset does not match pinned subset hash")
    tables.append((headers, subset))
    subsets.append(serialized)
if tables[0][0] != tables[1][0]:
    parser.error("source schema changed")
headers = tables[0][0]
left = {row["id"]: (i + 1, row) for i, row in enumerate(tables[0][1])}
right = {row["id"]: (i + 1, row) for i, row in enumerate(tables[1][1])}
changes = []
for source_id in sorted(left.keys() & right.keys(), key=int):
    for field in headers:
        if field != "id" and left[source_id][1][field] != right[source_id][1][field]:
            changes.append({"source_id": source_id, "left_id": f"L{left[source_id][0]}", "right_id": f"R{right[source_id][0]}", "field": field, "left_value": left[source_id][1][field], "right_value": right[source_id][1][field]})
left_only = sorted(left.keys() - right.keys(), key=int)
right_only = sorted(right.keys() - left.keys(), key=int)
expected = {"scope": "Independent literal field and stable-ID snapshot comparison, not airport correctness or user benefit", "key": "id", "headers": headers, "left_source_ids": list(left), "right_source_ids": list(right), "pair_count": len(left.keys() & right.keys()), "left_only_source_ids": left_only, "right_only_source_ids": right_only, "changed_record_count": len({row["source_id"] for row in changes}), "field_changes": changes}
config = {"schema_version": 1, "fields": [{"name": field, "left": field, "right": field, "type": "text", **({"compare": False} if field == "id" else {})} for field in headers], "key": ["id"]}
args.out.mkdir(parents=True)
for side, data in zip(["left", "right"], subsets):
    (args.out / (side + ".csv")).write_bytes(data)
for name, data in [("rules", config), ("expected", expected), ("provenance", provenance)]:
    (args.out / (name + ".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
with (args.out / "reviewed.csv").open("w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file, lineterminator="\n")
    writer.writerow(["action", "left_id", "right_id", "reason"])
    for source_id in left_only:
        writer.writerow(["left_unmatched", f"L{left[source_id][0]}", "", "Stable ID absent from the later CN/FR snapshot; dataset absence only"])
    for source_id in right_only:
        writer.writerow(["right_unmatched", "", f"R{right[source_id][0]}", "Stable ID absent from the earlier CN/FR snapshot; dataset absence only"])
print(f"Prepared {len(left)}/{len(right)} public records, {len(changes)} changed cells in {args.out}")
