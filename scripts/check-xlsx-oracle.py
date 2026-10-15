#!/usr/bin/env python3
"""Independent ElementTree and ZIP readback for restricted XLSX Task 1 fixtures."""

import argparse
import csv
import io
import zlib
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
            shared.append(_text_runs(item)[0])
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
                value = _text_runs(cell.find(f"{{{MAIN}}}is"))[0]
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
        require(expected_name.as_posix() in {"genuine-save-expected.json", "native-filter-expected.json", "conversion-expected.json"},
                f"{name}: unexpected independent expected-data file")
        if expected_name.as_posix() in {"native-filter-expected.json", "conversion-expected.json"}:
            extra = json.loads((manifest_path.parent / expected_name).read_text(encoding="utf-8"))
            require(extra.get("schema_version") == 1, "unsupported independent expected design")
            expected.update({item["id"]: item for item in extra["samples"]})
        require(name in expected, f"sample {name} lacks independent expected cells")
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
        if "auto_filter_ref" in wanted:
            with zipfile.ZipFile(file_path) as archive:
                worksheet = first_worksheet_path(archive)
                root = ET.fromstring(archive.read(worksheet))
                filters = root.findall(f"{{{MAIN}}}autoFilter")
                require(len(filters) == 1 and filters[0].attrib == {"ref": wanted["auto_filter_ref"]} and len(filters[0]) == 0, "native ref-only grammar mismatch")
                markers = root.findall(f"{{{MAIN}}}drawing")
                types = ET.fromstring(archive.read("[Content_Types].xml"))
                drawing_type = "application/vnd.openxmlformats-officedocument.drawing+xml"
                drawings = [node.get("PartName")[1:] for node in types if node.get("ContentType") == drawing_type]
                require(len(markers) == len(drawings) == 1, "native drawing cardinality mismatch")
                drawing = ET.fromstring(archive.read(drawings[0]))
                require(drawing.tag == "{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}wsDr" and not drawing.attrib and len(drawing) == 0 and not (drawing.text or "").strip(" \t\r\n"), "native empty target mismatch")
                inbound = []
                for rel_path in archive.namelist():
                    if not rel_path.endswith(".rels"): continue
                    source = "" if rel_path == "_rels/.rels" else rel_path.replace("/_rels/", "/")[:-5]
                    for relation in ET.fromstring(archive.read(rel_path)):
                        target = posixpath.normpath(posixpath.join(posixpath.dirname(source), relation.get("Target", "")))
                        if target == drawings[0]: inbound.append((source, relation.attrib))
                require(len(inbound) == 1 and inbound[0][0] == worksheet and inbound[0][1]["Type"] == REL + "/drawing" and inbound[0][1]["Id"] == markers[0].get("{"+REL+"}id"), "native all-inbound binding mismatch")
        for coordinate, value in wanted["cells"].items():
            require(data["cells"].get(coordinate) == value,
                    f"{name}: {coordinate} expected {value!r}, got {data['cells'].get(coordinate)!r}")
        outputs.append({"path": sample["path"], "bytes": len(raw), "sha256": sample["sha256"],
                        "date_system": data["date_system"], "cells_read": len(data["cells"])})
    require(seen == set(expected), "genuine manifest must contain each planned sample exactly once")
    return outputs



def _decode_xstring_once(value):
    """Decode ST_Xstring escapes once, including escaped literal escape tokens."""
    output = []
    index = 0
    while index < len(value):
        match = re.match(r"_x([0-9A-Fa-f]{4})_", value[index:])
        if match is None:
            output.append(value[index]); index += 1; continue
        unit = int(match.group(1), 16); end = index + len(match.group(0))
        if unit == 0x5f:
            tail = re.match(r"x([0-9A-Fa-f]{4})_", value[end:])
            if tail:
                output.append("_x" + tail.group(1) + "_"); index = end + len(tail.group(0)); continue
        if 0xd800 <= unit <= 0xdbff:
            low = re.match(r"_x([0-9A-Fa-f]{4})_", value[end:])
            require(low is not None and 0xdc00 <= int(low.group(1), 16) <= 0xdfff, "unpaired high surrogate in Xstring")
            low_unit = int(low.group(1), 16)
            output.append(chr(0x10000 + ((unit - 0xd800) << 10) + low_unit - 0xdc00))
            index = end + len(low.group(0)); continue
        require(not 0xdc00 <= unit <= 0xdfff, "unpaired low surrogate in Xstring")
        output.append(chr(unit)); index = end
    return "".join(output)


class OracleRejection(Exception):
    def __init__(self, code, record=None, field=None, phase="xlsx"):
        self.diagnostic = {"code":code,"phase":phase,"record":record,"field":field}
        super().__init__(code)


def _numeric_decimal(raw):
    from decimal import Decimal
    if (len(raw.encode("utf-8")) > 65536 or
        re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?",raw) is None):
        raise OracleRejection("xlsx_numeric_limit")
    exponent = re.split("[eE]",raw)[1] if re.search("[eE]",raw) else "0"
    magnitude=exponent.lstrip("+-").lstrip("0") or "0"
    if len(magnitude)>5 or len(magnitude)==5 and magnitude>"65536":
        raise OracleRejection("xlsx_numeric_limit")
    return Decimal(raw)


def _decimal_expand_oracle(raw):
    decimal = _numeric_decimal(raw)
    if "e" not in raw.lower(): return raw
    # Decimal provides the value oracle; original coefficient padding is part of
    # the lexical contract and is independently retained from the XML spelling.
    sign = raw[0] if raw[:1] in "+-" else ""
    body = raw[len(sign):]
    mantissa, exponent = re.split(r"[eE]", body)
    whole, dot, fraction = mantissa.partition(".")
    exponent_digits=exponent.lstrip("+-").lstrip("0") or "0"
    shift=int(exponent_digits)*(-1 if exponent.startswith("-") else 1)
    digits=whole+fraction;point=len(whole)+shift
    length=(2-point+len(digits) if point<=0 else max(point,len(digits)+(point<len(digits))))+len(sign)
    if length>65536: raise OracleRejection("xlsx_numeric_limit")
    if point <= 0: result = "0." + "0" * -point + digits
    elif point >= len(digits): result = digits + "0" * (point - len(digits))
    else: result = digits[:point] + "." + digits[point:]
    expanded=sign+result
    from decimal import Decimal
    require(decimal==Decimal(expanded),"lexical expansion differs from Decimal value")
    return expanded


def _text_runs(item):
    """Expanded-name traversal of the supported string content, excluding rPh."""
    parts=[];runs=0
    for child in item if item is not None else ():
        if child.tag==f"{{{MAIN}}}t":parts.append(child.text or "")
        elif child.tag==f"{{{MAIN}}}r":
            runs+=1
            parts.extend(node.text or "" for node in child if node.tag==f"{{{MAIN}}}t")
    return "".join(parts),runs


def _related_path(source, relation):
    return posixpath.normpath(posixpath.join(posixpath.dirname(source),relation.get("Target","")))


def _raw_workbook_for_adapter(archive, source_sha, worksheet_meta=None, sheet_id=None):
    root_rels=ET.fromstring(archive.read("_rels/.rels"))
    office=next(node for node in root_rels if node.tag==f"{{{PKG_REL}}}Relationship" and node.get("Type")==REL+"/officeDocument")
    workbook_path=_related_path("",office)
    workbook=ET.fromstring(archive.read(workbook_path))
    relpath=posixpath.join(posixpath.dirname(workbook_path),"_rels",posixpath.basename(workbook_path)+".rels")
    relations=ET.fromstring(archive.read(relpath))
    rels={node.get("Id"):node for node in relations if node.tag==f"{{{PKG_REL}}}Relationship"}
    wanted=sheet_id or worksheet_meta["sheet_id"]
    sheet=next(node for node in workbook.find(f"{{{MAIN}}}sheets") if source_sha+":"+node.get("sheetId","")==wanted)
    rid=sheet.get(f"{{{REL}}}id");relation=rels[rid];worksheet_path=_related_path(workbook_path,relation)
    require(relation.get("Type")==REL+"/worksheet","oracle selection is not ordinary worksheet")
    pr=workbook.find(f"{{{MAIN}}}workbookPr")
    date_system="1904" if pr is not None and pr.get("date1904","false") in ("true","1") else "1900"
    metadata={"sheet_id":wanted,"name":sheet.get("name"),"relationship_id":rid,"part":worksheet_path,"date_system":date_system}
    if worksheet_meta is not None:require(metadata==worksheet_meta,"adapter worksheet identity differs from raw relation graph")
    def related_root(kind):
        candidates=[node for node in relations if node.get("Type")==REL+"/"+kind]
        return ET.fromstring(archive.read(_related_path(workbook_path,candidates[0]))) if candidates else None
    sst=related_root("sharedStrings");shared=[_text_runs(item) for item in sst.findall(f"{{{MAIN}}}si")] if sst is not None else []
    styles=related_root("styles")
    if styles is None:formats=["General"]
    else:
        custom={node.get("numFmtId"):node.get("formatCode") for node in styles.findall(f"{{{MAIN}}}numFmts/{{{MAIN}}}numFmt")}
        formats=[custom.get(node.get("numFmtId"),"0" if node.get("numFmtId")=="1" else "General") for node in styles.findall(f"{{{MAIN}}}cellXfs/{{{MAIN}}}xf")]
    ws=ET.fromstring(archive.read(worksheet_path));cells={};hidden={}
    columns=ws.findall(f"{{{MAIN}}}cols/{{{MAIN}}}col")
    for row in ws.findall(f"{{{MAIN}}}sheetData/{{{MAIN}}}row"):
        rownum=int(row.get("r"));hidden[rownum]=row.get("hidden","false") in ("true","1")
        for node in row.findall(f"{{{MAIN}}}c"):
            ref=node.get("r");column,_=_coordinate_oracle(ref);kind=node.get("t","n")
            raw=node.findtext(f"{{{MAIN}}}v","");rich=0
            if kind=="s":raw,rich=shared[int(raw)];typ="text"
            elif kind=="inlineStr":raw,rich=_text_runs(node.find(f"{{{MAIN}}}is"));typ="text" if raw else "blank"
            elif kind=="str":typ="text" if raw else "blank"
            elif kind=="b":typ="boolean" if raw else "blank"
            elif kind=="n":typ="numeric" if raw else "blank"
            else:raise AssertionError("unsupported raw edge-domain type")
            inherited=next((col.get("style","0") for col in columns if int(col.get("min"))<=column<=int(col.get("max"))),"0")
            style=int(node.get("s",row.get("s",inherited)))
            cells[ref]={"raw":raw,"type":typ,"style":style,"format":formats[style],"rich_runs":rich}
    return {"cells":cells,"row_hidden":hidden,"date_system":date_system,"ws":ws,"worksheet":metadata}


def _date_oracle(raw, date_system):
    from datetime import date,timedelta
    value=_numeric_decimal(raw)
    _decimal_expand_oracle(raw)  # enforce bounded normalization before date arithmetic
    if raw.startswith("-") or value!=value.to_integral_value():raise OracleRejection("xlsx_date_rejected")
    base=date(1899,12,31) if date_system=="1900" else date(1904,1,1)
    maximum=(date(9999,12,31)-base).days+(1 if date_system=="1900" else 0)
    if value>maximum or date_system=="1900" and value==60:raise OracleRejection("xlsx_date_rejected")
    days=int(value)
    return (base+timedelta(days=days-(1 if date_system=="1900" and days>60 else 0))).isoformat()


def _zero_oracle(raw,fmt):
    value=_numeric_decimal(raw)
    if (not isinstance(fmt,str) or re.fullmatch("0{1,256}",fmt) is None or
        raw.startswith("-") or value!=value.to_integral_value()):raise OracleRejection("xlsx_value_mode_mismatch")
    _decimal_expand_oracle(raw)  # enforce the same frozen expansion budget
    integral=format(value,"f").partition(".")[0].lstrip("+").lstrip("0") or "0"
    return integral.zfill(len(fmt))


def _coordinate_oracle(ref):
    match=re.fullmatch(r"([A-Z]+)([0-9]+)",ref);col=0
    for char in match[1]:col=26*col+ord(char)-64
    return col,int(match[2])


def _coordinate_text(column,row):
    letters=""
    while column:column,rem=divmod(column-1,26);letters=chr(65+rem)+letters
    return letters+str(row)


def _csv_compat(rows):
    # Existing core encoder quotes CR as well as LF and leaves a sole empty
    # field unquoted. Python csv.writer's defaults differ in these two cases.
    stream=io.StringIO(newline="")
    for row in rows:
        if row==[""]:stream.write("\n")
        else:
            record=io.StringIO(newline="");csv.writer(record,lineterminator="\r\n",quoting=csv.QUOTE_MINIMAL).writerow(row)
            stream.write(record.getvalue()[:-2]+"\n")
    return stream.getvalue().encode("utf-8")


def _convert_oracle(cell,mode,date_system):
    raw=cell["raw"];typ=cell["type"]
    if typ=="blank" or raw=="":return "","blank"
    if typ=="text":
        if mode!="stored_text":raise OracleRejection("xlsx_value_mode_mismatch")
        try:return _decode_xstring_once(raw),"text"
        except AssertionError:raise OracleRejection("xlsx_value_mode_mismatch")
    if typ=="boolean":
        if mode!="stored_text":raise OracleRejection("xlsx_value_mode_mismatch")
        return ("TRUE" if raw=="1" else "FALSE"),"booleans"
    _numeric_decimal(raw)
    if mode=="stored_text":return raw,"text"
    if mode=="decimal_lexeme":return _decimal_expand_oracle(raw),"numeric_lexemes"
    if mode=="excel_date":return _date_oracle(raw,date_system),"dates"
    if mode=="zero_padded_identifier":return _zero_oracle(raw,cell["format"]),"zero_padded_identifiers"
    raise AssertionError("unknown mode")


def _derive_adapter(source,spec,limits=None):
    require(set(spec)=={"schema_version","source_sha256","sheet_id","header_row","column_start","column_end","last_row","columns","formula_policy"},"import spec keys mismatch")
    require(spec["schema_version"]==1 and spec["formula_policy"]=="reject","import spec version/policy mismatch")
    require([item["column"] for item in spec["columns"]]==list(range(spec["column_start"],spec["column_end"]+1)) and all(set(item)=={"column","mode"} for item in spec["columns"]),"import spec columns mismatch")
    source_sha=hashlib.sha256(source).hexdigest();require(spec["source_sha256"]==source_sha,"oracle source binding mismatch")
    width=spec["column_end"]-spec["column_start"]+1;height=spec["last_row"]-spec["header_row"]
    limits=limits or {}
    if width>limits.get("columns",256) or height>limits.get("data_rows",100000):raise OracleRejection("xlsx_limit_exceeded")
    with zipfile.ZipFile(io.BytesIO(source)) as archive:raw=_raw_workbook_for_adapter(archive,source_sha,sheet_id=spec["sheet_id"])
    cells=raw["cells"];headers=[]
    for col in range(spec["column_start"],spec["column_end"]+1):
        ref=_coordinate_text(col,spec["header_row"]);cell=cells.get(ref)
        require(cell and cell["type"]=="text","oracle invalid header type")
        try:header=_decode_xstring_once(cell["raw"])
        except AssertionError:raise OracleRejection("xlsx_value_mode_mismatch",spec["header_row"],ref)
        if not header:raise OracleRejection("xlsx_value_mode_mismatch",spec["header_row"],ref)
        headers.append(header)
    if len(set(headers))!=len(headers):raise OracleRejection("invalid_import_spec",spec["header_row"])
    counts={k:0 for k in ("blank","text","numeric_lexemes","expanded_exponents","booleans","dates","zero_padded_identifiers")};rows=[]
    for row in range(spec["header_row"]+1,spec["last_row"]+1):
        values=[]
        for column in spec["columns"]:
            ref=_coordinate_text(column["column"],row);cell=cells.get(ref,{"raw":"","type":"blank","format":"General"})
            try:value,category=_convert_oracle(cell,column["mode"],raw["date_system"])
            except OracleRejection as error:raise OracleRejection(error.diagnostic["code"],row,ref)
            counts[category]+=1
            if category=="numeric_lexemes" and re.search("[eE]",cell["raw"]):counts["expanded_exponents"]+=1
            values.append(value)
        rows.append(values)
    # Core's existing blank-header check happens after CSV conversion.
    for index,header in enumerate(headers):
        if not header.strip():raise OracleRejection("invalid_header",1,"column_"+str(index+1),"input")
    warnings={k:0 for k in ("hidden_rows_included","filtered_rows_included","outside_range_value_cells","outside_range_merges","rich_text_formatting_ignored")}
    def selected(col,row):return spec["header_row"]<=row<=spec["last_row"] and spec["column_start"]<=col<=spec["column_end"]
    for ref,cell in cells.items():
        col,row=_coordinate_oracle(ref)
        if cell["raw"] and not selected(col,row):warnings["outside_range_value_cells"]+=1
        if selected(col,row) and cell["type"]=="text" and cell["rich_runs"]>1:warnings["rich_text_formatting_ignored"]+=1
    for row,hidden in raw["row_hidden"].items():
        if spec["header_row"]<row<=spec["last_row"] and hidden:warnings["hidden_rows_included"]+=1
    ws=raw["ws"];auto=ws.find(f"{{{MAIN}}}autoFilter")
    if auto is not None:
        start,end=map(_coordinate_oracle,auto.get("ref").split(":"));left,top=start;right,bottom=end
        if left<=spec["column_end"] and right>=spec["column_start"]:warnings["filtered_rows_included"]=max(0,min(bottom,spec["last_row"])-max(top,spec["header_row"]+1)+1)
    for merge in ws.findall(f"{{{MAIN}}}mergeCells/{{{MAIN}}}mergeCell"):
        (left,top),(right,bottom)=map(_coordinate_oracle,merge.get("ref").split(":"))
        if left<=spec["column_end"] and right>=spec["column_start"] and top<=spec["last_row"] and bottom>=spec["header_row"]:raise OracleRejection("unsupported_xlsx_feature")
        warnings["outside_range_merges"]+=1
    return {"csv":_csv_compat([headers]+rows),"rows":rows,"counts":counts,"warnings":[{"code":k,"count":v} for k,v in warnings.items() if v],"worksheet":raw["worksheet"]}


def _canonical_json(value):
    return (json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(",",":"))+"\n").encode("utf-8")


def _check_actual(directory,source,spec,derived):
    csv_bytes=(directory/"canonical.csv").read_bytes();profile_bytes=(directory/"profile.json").read_bytes();adapter_bytes=(directory/"adapter.json").read_bytes()
    require(csv_bytes==derived["csv"],f"{directory.name}: actual CSV differs from independent XML/Decimal/datetime/CSV oracle")
    expected_profile={"schema_version":1,"adapter_id":"restricted-ooxml","adapter_version":"1.0.0","import_spec":spec}
    require(profile_bytes==_canonical_json(expected_profile),"profile schema or canonical bytes mismatch")
    def identity(data):return {"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()}
    expected_manifest={"schema_version":1,"adapter_id":"restricted-ooxml","adapter_version":"1.0.0","profile":identity(profile_bytes),"source":identity(source),"canonical_csv":identity(csv_bytes),"worksheet":derived["worksheet"],"row_mapping":{"kind":"rectangle","header_row":spec["header_row"],"data_first_row":spec["header_row"]+1,"row_count":spec["last_row"]-spec["header_row"],"column_start":spec["column_start"],"column_end":spec["column_end"]},"warnings":derived["warnings"],"conversion_counts":derived["counts"]}
    require(adapter_bytes==_canonical_json(expected_manifest),f"{directory.name}: adapter schema/counts/warnings/mapping/hash canonical bytes mismatch")
    return {"path":directory.name,**identity(csv_bytes),"rows":len(derived["rows"]),"counts":derived["counts"],"warnings":derived["warnings"]}


def check_adapter_output(manifest_path,output_root):
    expected_doc=json.loads((manifest_path.parent/"genuine-save-expected.json").read_text(encoding="utf-8"));expected={v["id"]:v for v in expected_doc["samples"]};checked=[]
    for name in ("lo-conversion-1900.xlsx","lo-conversion-1904.xlsx"):
        sample=expected[name];directory=output_root/name.removesuffix(".xlsx");source=(manifest_path.parent/name).read_bytes()
        profile=json.loads((directory/"profile.json").read_bytes());spec=profile["import_spec"]
        require(spec["schema_version"]==1 and spec["formula_policy"]=="reject","profile schema/policy mismatch")
        require(all(spec[k]==sample["range"][k] for k in ("header_row","column_start","column_end","last_row")),"native oracle range mismatch")
        require([v["mode"] for v in spec["columns"]]==sample["modes"],"native oracle modes mismatch")
        derived=_derive_adapter(source,spec);checked.append(_check_actual(directory,source,spec,derived))
        require(derived["rows"]==sample["rows"] and len(derived["rows"])==sample["row_count"],"native independent stored values mismatch")
        require(derived["csv"]==(manifest_path.parent/sample["expected_csv"]).read_bytes(),"native independent reference bytes mismatch")
        require(len(derived["csv"])==sample["csv_bytes"] and hashlib.sha256(derived["csv"]).hexdigest()==sample["csv_sha256"],"native reference identity mismatch")
    return checked


def check_edge_output(vectors_path,output_root):
    document=json.loads(vectors_path.read_text(encoding="utf-8"));require(document["schema_version"]==1,"edge domain schema mismatch");checked=[]
    for vector in document["cases"]:
        require(vector["label"]=="synthetic","edge inputs must remain synthetic")
        directory=output_root/vector["id"];source=(directory/"source.xlsx").read_bytes();spec=json.loads((directory/"import-spec.json").read_bytes())
        require(all(spec[k]==vector[k] for k in ("header_row","column_start","column_end","last_row")),"edge rectangle mismatch")
        require([v["mode"] for v in spec["columns"]]==vector["modes"],"edge modes mismatch")
        try:derived=_derive_adapter(source,spec,vector.get("limits"))
        except OracleRejection as error:
            require(error.diagnostic==vector.get("error"),f"{vector['id']}: independent rejection differs from frozen expectation: {error.diagnostic}")
            require(json.loads((directory/"error.json").read_bytes())==error.diagnostic,f"{vector['id']}: actual adapter rejection differs from independent oracle")
            require(not (directory/"profile.json").exists() and not (directory/"adapter.json").exists(),"failed conversion produced successful materials")
            if vector.get("no_csv"):require(not (directory/"canonical.csv").exists(),"lower rectangle limit allocated CSV")
            checked.append({"id":vector["id"],"rejection":error.diagnostic,"source_sha256":hashlib.sha256(source).hexdigest()});continue
        require("error" not in vector,f"{vector['id']}: independent oracle wrongly accepted rejection case")
        require(derived["csv"]==vector["csv"].encode(),"independent edge CSV differs from explicit expected bytes")
        require(not (directory/"error.json").exists(),"successful adapter output has an error receipt")
        checked.append({"id":vector["id"],**_check_actual(directory,source,spec,derived)})
    return checked


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
    elif mutation in {"local_flag_mismatch", "local_method_mismatch"}:
        local = struct.unpack_from("<I", data, records[0]["offset"] + 42)[0]
        field = 6 if mutation == "local_flag_mismatch" else 8
        old = struct.unpack_from("<H", data, local + field)[0]
        struct.pack_into("<H", data, local + field, old ^ (0x800 if field == 6 else 8))
        require(struct.unpack_from("<H", data, local + field)[0] != struct.unpack_from("<H", data, records[0]["offset"] + (8 if field == 6 else 10))[0], "mismatch mutation missing")
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
                 "local_flag_mismatch", "local_method_mismatch", "encrypted_entry", "truncated_archive"}
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

    # Build valid stored records explicitly so descriptor/overlap probes cannot stop
    # at an unrelated filename/CRC/size disagreement first.
    def stored_zip(items, descriptor_form=None, overlap=False, truncate_deflate=False):
        local_data, central = bytearray(), bytearray()
        def local_record(name, payload, flags=0):
            n = name.encode(); crc = zlib.crc32(payload) & 0xffffffff
            return struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, flags, 0, 0, 0,
                0 if flags else crc, 0 if flags else len(payload), 0 if flags else len(payload), len(n), 0) + n + payload
        def add(name, payload, offset, flags=0):
            n = name.encode(); crc = zlib.crc32(payload) & 0xffffffff
            central.extend(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, flags, 0, 0, 0,
                crc, len(payload), len(payload), len(n), 0, 0, 0, 0, 0, offset) + n)
        if overlap:
            inside_name, inside_bytes = "xl/inside.bin", b"payload"
            inner = local_record(inside_name, inside_bytes)
            outer_name = "xl/overlap.bin"
            outer = local_record(outer_name, inner)
            add(outer_name, inner, 0)
            add(inside_name, inside_bytes, 30 + len(outer_name))
            local_data.extend(outer)
            require(30 + len(outer_name) < len(outer), "overlap intervals do not overlap")
        for index, (name, payload) in enumerate(items):
            offset = len(local_data); flags = 8 if descriptor_form is not None else 0
            if truncate_deflate and index == 0:
                compressor = zlib.compressobj(wbits=-15)
                compressed = (compressor.compress(payload) + compressor.flush())[:-2]
                n = name.encode(); crc = zlib.crc32(payload) & 0xffffffff
                local_data.extend(struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, 0, 8, 0, 0, crc, len(compressed), len(payload), len(n), 0) + n + compressed)
                central.extend(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0, 8, 0, 0, crc, len(compressed), len(payload), len(n), 0, 0, 0, 0, 0, offset) + n)
                failed = False
                try: zlib.decompress(compressed, -15)
                except zlib.error: failed = True
                require(failed, "truncated compressed fixture was not truncated")
            else:
                local_data.extend(local_record(name, payload, flags)); add(name, payload, offset, flags)
            if flags:
                desc = struct.pack("<III", zlib.crc32(payload) & 0xffffffff, len(payload), len(payload))
                if descriptor_form != "unsigned": desc = b"PK\x07\x08" + desc
                if index == 0 and descriptor_form == "corrupt": desc = desc[:-1] + bytes([desc[-1] ^ 1])
                if index == len(items)-1 and descriptor_form == "truncated": desc = desc[:7]
                local_data.extend(desc)
        offset = len(local_data); count = len(items) + (2 if overlap else 0)
        return bytes(local_data + central + struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, count, count, len(central), offset, 0))
    with zipfile.ZipFile(base) as src:
        stored_items = [(i.filename, src.read(i.filename)) for i in src.infolist()]
    for form in ("unsigned", "corrupt", "truncated"):
        case = "bit3_descriptor_" + form; out = destination / (case + ".xlsx")
        out.write_bytes(stored_zip(stored_items, form)); outputs[case] = out
        if form == "unsigned":
            with zipfile.ZipFile(out) as archive: require(archive.testzip() is None, "unsigned descriptor readback failed")
        else:
            require(b"PK\x05\x06" in out.read_bytes()[-22:], "descriptor truncation must retain EOCD")
    out = destination / "overlapping_local_records.xlsx"
    out.write_bytes(stored_zip(stored_items, overlap=True)); outputs["overlapping_local_records"] = out
    raw = out.read_bytes(); records = _central_records(raw)
    first, second = records[:2]
    for record in records:
        local = struct.unpack_from("<I", raw, record["offset"]+42)[0]
        n = struct.unpack_from("<H", raw, local+26)[0]
        require(raw[local+30:local+30+n] == record["name"], "overlap probe local name mismatch")
        crc, csize, usize = struct.unpack_from("<III", raw, local+14)
        require((crc,csize,usize) == struct.unpack_from("<III",raw,record["offset"]+16), "overlap probe metadata mismatch")
        payload = raw[local+30+n:local+30+n+csize]
        require(zlib.crc32(payload)&0xffffffff == crc, "overlap probe CRC mismatch")
    out = destination / "truncated_deflate_stream.xlsx"
    out.write_bytes(stored_zip(stored_items, truncate_deflate=True)); outputs["truncated_deflate_stream"] = out
    require(out.read_bytes()[-22:-18] == b"PK\x05\x06", "stream truncation must retain EOCD")
    with zipfile.ZipFile(out) as archive:
        first = archive.infolist()[0]; raw = out.read_bytes(); local = first.header_offset
        require(first.compress_type == struct.unpack_from("<H",raw,local+8)[0] == 8, "truncated stream local method mismatch")
        require(first.compress_size == struct.unpack_from("<I",raw,local+18)[0], "truncated stream local size mismatch")
        require(first.CRC == struct.unpack_from("<I",raw,local+14)[0], "truncated stream local CRC mismatch")
    for count in (2048, 2049):
        out = destination / f"entry_count_{count}.xlsx"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as archive:
            for name, payload in stored_items: archive.writestr(name, payload)
            for index in range(count-len(stored_items)): archive.writestr(f"safe/{index:04}/", b"")
        with zipfile.ZipFile(out) as archive:
            require(len(archive.infolist()) == count and archive.testzip() is None, "exact-count supported package invalid")
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
                            "overlapping_local_records", "local_flag_mismatch", "local_method_mismatch", "encrypted_entry", "truncated_archive", "bit3_descriptor_corrupt", "bit3_descriptor_truncated"}:
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
    parser.add_argument("--adapter-output", type=Path, help="owned directory containing lo-conversion-1900/ and lo-conversion-1904/ adapter results")
    parser.add_argument("--edge-vectors", type=Path)
    parser.add_argument("--edge-output", type=Path)
    args = parser.parse_args()
    require(bool(args.edge_vectors)==bool(args.edge_output),"edge vectors and actual output directory are required together")
    xml_count, _cases = check_xml_cases(args.xml_cases)
    samples = check_genuine(args.genuine_manifest)
    adapter = check_adapter_output(args.genuine_manifest, args.adapter_output) if args.adapter_output else []
    edge=check_edge_output(args.edge_vectors,args.edge_output) if args.edge_vectors else []
    malicious = []
    if args.malicious_manifest:
        source = args.genuine_manifest.parent / "lo-1904-values.xlsx"
        malicious = check_malicious(args.malicious_manifest, source, args.write_malicious_dir)
    print(json.dumps({"status": "PASS", "xml_cases_checked": xml_count, "genuine_samples": samples,
                      "adapter_outputs": adapter, "edge_outputs":edge, "malicious_zip_mutations": malicious}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}")
        raise SystemExit(1)
