#!/usr/bin/env python3
"""Independent ElementTree and ZIP readback for restricted XLSX Task 1 fixtures."""

import argparse
import io
import hashlib
import json
from pathlib import Path
import posixpath
import re
import struct
import tempfile
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


def _write_copy(source, destination, mutate=None, extra=()):
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            if mutate and info.filename in mutate:
                value = mutate[info.filename](src.read(info.filename))
            else:
                value = src.read(info.filename)
            dst.writestr(info, value)
        for item in extra:
            info, value = item
            dst.writestr(info, value)


def _central_records(data):
    result = []
    offset = data.find(b"PK\x01\x02")
    while offset >= 0 and offset + 46 <= len(data):
        if data[offset:offset + 4] != b"PK\x01\x02":
            break
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", data, offset + 28)
        end = offset + 46 + name_len + extra_len + comment_len
        if end > len(data):
            break
        result.append({"offset": offset, "name": data[offset + 46:offset + 46 + name_len], "end": end})
        offset = data.find(b"PK\x01\x02", end)
    return result


def _mutate_raw(source, destination, mutation):
    data = bytearray(source.read_bytes())
    records = _central_records(data)
    if not records:
        raise AssertionError("base archive has no central directory")
    if mutation == "local_central_name_mismatch":
        first = records[0]
        n = struct.unpack_from("<H", data, first["offset"] + 28)[0]
        local = data.find(b"PK\x03\x04")
        old = bytes(data[local + 30:local + 30 + n])
        data[local + 30:local + 30 + n] = b"x" * n
        require(data.find(old, first["offset"] + 46, first["end"]) >= 0, "central name disappeared")
    elif mutation == "crc_mismatch":
        local = data.find(b"PK\x03\x04")
        old = struct.unpack_from("<I", data, local + 14)[0]
        new = old ^ 0x01010101
        struct.pack_into("<I", data, local + 14, new)
        struct.pack_into("<I", data, records[0]["offset"] + 16, new)
    elif mutation == "forged_uncompressed_size":
        local = data.find(b"PK\x03\x04")
        csize = struct.unpack_from("<I", data, local + 18)[0]
        usize = struct.unpack_from("<I", data, local + 22)[0]
        struct.pack_into("<I", data, local + 22, max(0, usize - 1))
        struct.pack_into("<I", data, records[0]["offset"] + 24, max(0, usize - 1))
    elif mutation == "overlapping_local_records":
        require(len(records) > 1, "need two central members")
        first_local = struct.unpack_from("<I", data, records[0]["offset"] + 42)[0]
        struct.pack_into("<I", data, records[1]["offset"] + 42, first_local)
    elif mutation == "encrypted_entry":
        local = data.find(b"PK\x03\x04")
        flags = struct.unpack_from("<H", data, local + 6)[0] | 1
        struct.pack_into("<H", data, local + 6, flags)
        struct.pack_into("<H", data, records[0]["offset"] + 8, flags)
    elif mutation == "truncated_archive":
        data = data[:-12]
    else:
        raise AssertionError(f"unknown raw mutation {mutation}")
    destination.write_bytes(data)


class _NonSeekable(io.BytesIO):
    def seekable(self):
        return False

    def seek(self, *_args, **_kwargs):
        raise io.UnsupportedOperation("non-seekable test output")


def write_malicious_packages(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    base = source
    outputs = {}
    raw_cases = {"local_central_name_mismatch", "crc_mismatch", "forged_uncompressed_size",
                 "overlapping_local_records", "encrypted_entry", "truncated_archive"}
    for case in raw_cases:
        out = destination / f"{case}.xlsx"
        _mutate_raw(base, out, case)
        outputs[case] = out

    def info(name, mode=None, compression=zipfile.ZIP_STORED):
        item = zipfile.ZipInfo(name)
        item.compress_type = compression
        if mode is not None:
            item.create_system = 3
            item.external_attr = mode << 16
        return item

    duplicate = destination / "duplicate_name.xlsx"
    with zipfile.ZipFile(base) as src, zipfile.ZipFile(duplicate, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist(): dst.writestr(item, src.read(item.filename))
        dst.writestr("xl/workbook.xml", b"<workbook/>")
    outputs["duplicate_name"] = duplicate

    for case, extras in {
        "case_alias": [(info("XL/WORKBOOK.XML"), b"x")],
        "nfc_alias": [(info("xl/caf\u00e9.xml"), b"x"), (info("xl/cafe\u0301.xml"), b"y")],
        "path_traversal": [(info("../escape.xml"), b"x")],
        "symlink_entry": [(info("xl/link", 0o120777), b"xl/workbook.xml")],
        "special_file_entry": [(info("xl/fifo", 0o010644), b"x")],
        "unsupported_method": [(info("xl/bzip.bin", compression=zipfile.ZIP_BZIP2), b"x")],
        "safe_inert_directory": [(info("inert/", 0o040755 | 0x10), b"")],
    }.items():
        out = destination / f"{case}.xlsx"
        _write_copy(base, out, extra=extras)
        outputs[case] = out

    # A non-seekable writer forces bit 3 and writes a valid data descriptor.
    sink = _NonSeekable()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED) as archive, zipfile.ZipFile(base) as src:
        for item in src.infolist():
            archive.writestr(item.filename, src.read(item.filename))
    descriptor = destination / "bit3_descriptor_valid.xlsx"
    descriptor.write_bytes(sink.getvalue())
    with zipfile.ZipFile(descriptor) as archive:
        require(archive.infolist()[0].flag_bits & 8, "bit-3 fixture did not use a data descriptor")
        require(archive.testzip() is None and archive.read("xl/workbook.xml"), "bit-3 XLSX fixture failed independent readback")
    outputs["bit3_descriptor_valid"] = descriptor

    for count in (2048, 2049):
        out = destination / f"entry_count_{count}.xlsx"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as archive:
            for index in range(count):
                archive.writestr(f"safe/{index:04}.txt", b"")
        outputs[f"entry_count_{count}"] = out
    return outputs


def check_malicious(manifest_path, source, out_dir=None):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("schema_version") == 1, "unsupported malicious fixture schema")
    cases = manifest.get("zip_mutations")
    require(isinstance(cases, list) and len(cases) >= 16, "malicious ZIP mutation list is incomplete")
    with tempfile.TemporaryDirectory(prefix="xlsx-oracle-") as temporary:
        directory = Path(out_dir) if out_dir else Path(temporary)
        outputs = write_malicious_packages(source, directory)
        require(set(cases) == set(outputs), "Python mutation set differs from manifest")
        require(set(manifest.get("lower_limit_tests", [])) == {"compressed_bytes", "actual_unzip_bytes", "xml_bytes", "xml_depth"},
                "lower-limit test list is incomplete")
        result = []
        for name in cases:
            path = outputs[name]
            if name not in {"local_central_name_mismatch", "crc_mismatch", "forged_uncompressed_size",
                            "overlapping_local_records", "encrypted_entry", "truncated_archive"}:
                with zipfile.ZipFile(path) as archive:
                    if name == "safe_inert_directory":
                        require(any(item.is_dir() for item in archive.infolist()), "directory mutation was not retained")
                    elif name == "bit3_descriptor_valid":
                        require(archive.infolist()[0].flag_bits & 8, "descriptor flag missing")
            result.append({"id": name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        # Limits are exercised by the Node package tests with lower injected ceilings;
        # production constants remain part of those exact-value assertions.
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xml-cases", required=True, type=Path)
    parser.add_argument("--genuine-manifest", required=True, type=Path)
    parser.add_argument("--malicious-manifest", type=Path)
    parser.add_argument("--write-malicious-dir", type=Path)
    args = parser.parse_args()
    xml_count, _cases = check_xml_cases(args.xml_cases)
    samples = check_genuine(args.genuine_manifest)
    malicious = []
    if args.malicious_manifest:
        source = args.genuine_manifest.parent / "lo-1904-values.xlsx"
        malicious = check_malicious(args.malicious_manifest, source, args.write_malicious_dir)
    print(json.dumps({"status": "PASS", "xml_cases_checked": xml_count, "genuine_samples": samples,
                      "malicious_zip_mutations": malicious}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}")
        raise SystemExit(1)
