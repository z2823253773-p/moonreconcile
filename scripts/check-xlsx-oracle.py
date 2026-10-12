#!/usr/bin/env python3
"""Independent ElementTree and ZIP readback for restricted XLSX Task 1 fixtures."""

import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def decode_xstring(value):
    output = []
    index = 0
    while index < len(value):
        match = re.match(r"_x([0-9A-Fa-f]{4})_", value[index:])
        if match is None:
            output.append(value[index])
            index += 1
        else:
            output.append(chr(int(match.group(1), 16)))
            index += len(match.group(0))
    return "".join(output)


def check_xml_cases(path):
    cases = json.loads(path.read_text(encoding="utf-8"))
    require(cases.get("schema_version") == 1, "unsupported XML fixture schema")
    checked = 0
    for case in cases["cases"]:
        if "reject" in case:
            continue
        root = ET.fromstring(case["xml"].encode("utf-8"))
        require(root.tag.rsplit("}", 1)[-1] == case["root"], f"{case['id']}: wrong root")
        require((root.text or "") == case["text"], f"{case['id']}: wrong decoded text")
        require(len(root) == case.get("children", 0), f"{case['id']}: wrong child count")
        if "attributes" in case:
            require(root.attrib == case["attributes"], f"{case['id']}: wrong decoded attributes")
        checked += 1
    require(checked >= 3, "three required XML counterexamples were not checked")
    return checked, cases


def workbook_readback(archive, worksheet_path):
    names = archive.namelist()
    require(len(names) == len(set(names)), "duplicate ZIP member")
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    properties = workbook.find(f"{{{MAIN}}}workbookPr")
    date1904 = properties is not None and properties.get("date1904", "false").lower() in ("true", "1")
    sheet_root = ET.fromstring(archive.read(worksheet_path))
    shared = []
    if "xl/sharedStrings.xml" in names:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        for item in shared_root.findall(f"{{{MAIN}}}si"):
            shared.append("".join(node.text or "" for node in item.iter(f"{{{MAIN}}}t")))
    cells = {}
    hidden_rows = []
    for row in sheet_root.findall(f".//{{{MAIN}}}row"):
        row_number = int(row.get("r"))
        if row.get("hidden", "false").lower() in ("true", "1"):
            hidden_rows.append(row_number)
        for cell in row.findall(f"{{{MAIN}}}c"):
            reference = cell.get("r")
            kind = cell.get("t", "n")
            value_node = cell.find(f"{{{MAIN}}}v")
            if kind == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(f"{{{MAIN}}}t"))
            elif kind == "s":
                value = decode_xstring(shared[int(value_node.text)])
            elif kind == "b":
                value = "TRUE" if value_node is not None and value_node.text == "1" else "FALSE"
            elif value_node is not None:
                value = value_node.text or ""
            else:
                value = ""
            cells[reference] = value
    formulas = bool(sheet_root.findall(f".//{{{MAIN}}}f"))
    merges = bool(sheet_root.findall(f".//{{{MAIN}}}mergeCell"))
    auto_filter = sheet_root.find(f"{{{MAIN}}}autoFilter") is not None
    relationship_path = worksheet_path.rsplit('/', 1)[0] + '/_rels/' + worksheet_path.rsplit('/', 1)[1] + '.rels'
    if relationship_path in names:
        relationships = ET.fromstring(archive.read(relationship_path))
        for relationship in relationships.findall(f"{{{PKG_REL}}}Relationship"):
            if relationship.get("Type", "").endswith("/table"):
                target = relationship.get("Target", "")
                table_path = posixpath.normpath(posixpath.join(posixpath.dirname(worksheet_path), target))
                table_root = ET.fromstring(archive.read(table_path))
                auto_filter = auto_filter or table_root.find(f"{{{MAIN}}}autoFilter") is not None
    return {
        "date_system": "1904" if date1904 else "1900",
        "cells": cells,
        "hidden_rows": hidden_rows,
        "formula": formulas,
        "merge": merges,
        "auto_filter": auto_filter,
    }


def first_worksheet_path(archive):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = workbook.find(f"{{{MAIN}}}sheets")
    require(sheets is not None and len(sheets), "workbook has no sheets")
    sheet = sheets[0]
    relationship_id = sheet.get(f"{{{REL}}}id")
    require(relationship_id, "first workbook sheet has no relationship id")
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    matches = [item for item in relationships.findall(f"{{{PKG_REL}}}Relationship")
               if item.get("Id") == relationship_id]
    require(len(matches) == 1, "first workbook sheet relationship is missing or duplicated")
    relation = matches[0]
    require(relation.get("Type", "").endswith("/worksheet"), "first workbook sheet is not a worksheet")
    require(relation.get("TargetMode", "Internal") == "Internal", "first worksheet relationship is external")
    target = relation.get("Target", "")
    path = posixpath.normpath(posixpath.join("xl", target))
    require(path.startswith("xl/") and not path.startswith("../"), "first worksheet target escapes xl/")
    return path


def check_genuine(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("schema_version") == 1, "unsupported genuine-save manifest schema")
    require(isinstance(manifest.get("samples"), list) and manifest["samples"], "genuine-save manifest has no samples")
    expected_path = manifest_path.parent / "genuine-save-expected.json"
    expected_doc = json.loads(expected_path.read_text(encoding="utf-8"))
    require(expected_doc.get("schema_version") == 1, "unsupported independent expected-data schema")
    expected = {sample["id"]: sample for sample in expected_doc["samples"]}
    required_keys = {"path", "sha256", "bytes", "application", "application_version", "save_method", "expected_cells_path"}
    seen = set()
    outputs = []
    for sample in manifest["samples"]:
        require(set(sample) == required_keys, "genuine sample fields do not match the frozen schema")
        name = Path(sample["path"]).name
        require(name not in seen, f"duplicate sample {name}")
        seen.add(name)
        require(name in expected, f"sample {name} lacks independent expected cells")
        require(sample["application"] in ("LibreOffice", "Microsoft Excel"), f"{name}: unexpected save application")
        method = sample["save_method"].lower()
        if sample["application"] == "LibreOffice":
            require(sample["application_version"].startswith("26.2.4.2"), f"{name}: unexpected LibreOffice version")
            require("isolated" in method and "profile" in method, f"{name}: save method lacks isolated profile proof")
        else:
            require(sample["application_version"].startswith("16.113.4"), f"{name}: unexpected Excel bundle version")
            require("ui" in method and "disk" in method, f"{name}: save method lacks UI save and disk readback details")
        expected_name = Path(sample["expected_cells_path"])
        require(not expected_name.is_absolute() and ".." not in expected_name.parts,
                f"{name}: expected data path must be fixture-relative")
        require(expected_name.suffix == ".json", f"{name}: expected_cells_path must identify independent JSON, not workbook XML")
        require(expected_name.as_posix() == "genuine-save-expected.json",
                f"{name}: unexpected independent expected-data file")
        file_path = manifest_path.parent / sample["path"]
        raw = file_path.read_bytes()
        require(len(raw) == sample["bytes"], f"{name}: byte count mismatch")
        require(hashlib.sha256(raw).hexdigest() == sample["sha256"], f"{name}: SHA-256 mismatch")
        with zipfile.ZipFile(file_path) as archive:
            require(archive.testzip() is None, f"{name}: corrupt ZIP member")
            data = workbook_readback(archive, first_worksheet_path(archive))
        wanted = expected[name]["stored"]
        require(data["date_system"] == wanted["date_system"], f"{name}: date system mismatch")
        require(data["hidden_rows"] == wanted["hidden_rows"], f"{name}: hidden rows mismatch")
        require(data["formula"] == wanted["formula"], f"{name}: formula presence mismatch")
        require(data["merge"] == wanted["merge"], f"{name}: merge presence mismatch")
        require(data["auto_filter"] == wanted["auto_filter"], f"{name}: autoFilter mismatch")
        for coordinate, value in wanted["cells"].items():
            require(data["cells"].get(coordinate) == value,
                    f"{name}: {coordinate} expected {value!r}, got {data['cells'].get(coordinate)!r}")
        outputs.append({"path": sample["path"], "bytes": len(raw), "sha256": sample["sha256"],
                        "date_system": data["date_system"], "cells_read": len(data["cells"])})
    require(seen == set(expected), "genuine manifest must contain each planned sample exactly once")
    return outputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xml-cases", required=True, type=Path)
    parser.add_argument("--genuine-manifest", required=True, type=Path)
    args = parser.parse_args()
    xml_count, _cases = check_xml_cases(args.xml_cases)
    samples = check_genuine(args.genuine_manifest)
    print(json.dumps({"status": "PASS", "xml_cases_checked": xml_count, "genuine_samples": samples}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}")
        raise SystemExit(1)
