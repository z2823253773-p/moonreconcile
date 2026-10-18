# Restricted XLSX B interface preflight

Status checkpoint 2026-10-17: **Tasks1–6 ACCEPTED LOCAL through `629241da9fcdcbb954a3813b283c3ad9c7276a2e`; Task7 Phase A `64b0602` under repair round1/2; production CSV-only**. Historical failed/candidate evidence and frozen interfaces below are retained. Current Phase A status and pending activation/final acceptance are recorded in `.superpowers/sdd/2026-10-08-restricted-xlsx/task-7-phase-a-report.md`.

## Verified starting point

- Sole implementation checkout: `/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench`, branch `feature/quarter-workbench`, Task1 base `22fa85a01460723c3823f66bb4ae098e428bbacf`. Historical accepted A+C source `607d1736edef17faca97959b5f2a9011a9f9189d` and acceptance record remain preserved; Main checkout `72eb305711fa54d864235b56406008b1aee7d68e` remains untouched.
- Read binding `AGENTS.md`, entire `docs/superpowers/specs/2026-10-04-quarter-workbench-design.md` including the opening P0裁决 and §8, and A+C plan `2026-10-04-local-workbench.md` for integration only. A+C tasks are already accepted; do not repeat their implementation.
- Current evidence: `.superpowers/sdd/2026-10-04-local-workbench/ac-controller-acceptance-2026-10-08.md` and **`ac-controller-evidence/acceptance.json`** (not a file at the ledger root): `accepted_local_A_C`, independent SPEC/QUALITY PASS, full gates/strict/actual relocated browser PASS; accepted ZIP SHA256 `746e488d28bb367b56eb1478fde81c05635a7ac8b831aa217f8fbc75905dddfa`. These are A+C evidence, not B evidence.
- Fully read `/Users/henryz/Desktop/比赛/MoonReconcile-季度项目交接/2026-10-04/xlsx-probe/controller-followup.md`. Old PARTIAL probe's globally predecoded `parseXml/textOf` is rejected. Its Python-built ZIP is not a genuine Excel/LibreOffice-saved sample; old Node24 probe success is not a Node22 product gate.

## B planning decisions: versions and strict wire schemas

Keep `APP_VERSION="0.2.0"`, `API_VERSION=1`, engine `0.1.0`, Config v1, core manifest v1, current CSV DTO field sets/routes and CLI algorithms unchanged. B's optional host protocol uses independent `xlsx_api_version:1`, `ImportSpec.schema_version:1`, profile v1, adapter version `1.0.0`, import-manifest v1, and **workbench bundle schema v2**. No release/version bump is part of this plan. Final production capability publication is Task 7 only; before that existing production startup still advertises only `formats:["csv"]` and rejects xlsx with 422. Tests can construct `startWorkbench({xlsxEnabled:true})` and that isolated test host exposes the exact B capabilities/routes for end-to-end tests; the production default is false until Task 7's reviewed activation commit. This is an internal construction option, never a CLI/env/HTTP bypass.

All following JSON objects have exact keys, integers are safe before conversion, arrays have explicit budgets, unknown keys fail. IDs are current UUID-v4 shape except `sheet_id`. HTTP authentication, Origin/Host/Sec-Fetch-Site, role byte limits, no-store and ErrorDTO remain current v1. XLSX worker jobs use existing phases; add job kinds `xlsx_catalog` and `source_cell`. No paths/URLs accepted or returned.

```text
POST /api/assets?kind=xlsx: current raw-upload contract, max 67108864 bytes.
Asset: same exact keys; kind enum adds xlsx only on enabled B host.
POST /api/xlsx/catalog: {asset_id}; asset.kind=xlsx; 202 job_id.
  job.output={workbook:WorkbookDTO}; catalog does not register an Import.
WorkbookDTO={xlsx_api_version:1,asset_id,source_sha256,date_system:"1900"|"1904",
  sheets:SheetDTO[]}
SheetDTO={sheet_id,name,state:"visible"|"hidden"|"veryHidden",
  kind:"worksheet"|"other",selectable:boolean,value_cells:integer,
  min_row:null|integer,max_row:null|integer,min_column:null|integer,max_column:null|integer}
ImportSpec={schema_version:1,source_sha256,sheet_id,header_row,column_start,
  column_end,last_row,columns:[{column:integer,mode:Mode}],formula_policy:"reject"}
Mode="stored_text"|"decimal_lexeme"|"excel_date"|"zero_padded_identifier"
POST /api/imports:
  CSV remains exactly {asset_id,side}.
  XLSX is exactly {asset_id,side,import_spec:ImportSpec}; no automatic sheet/range/mode.
XlsxImportDTO={import_id,asset_id,side,format:"xlsx",status:"ready",headers,
  row_count,column_count,sha256,adapter:{adapter_id:"restricted-ooxml",
  adapter_version:"1.0.0",profile_schema_version:1,profile_sha256,
  import_manifest_sha256,source_sha256,canonical_csv_sha256}}
  sha256=canonical CSV SHA; asset_id=original XLSX asset; original hash is explicit.
  CSV ImportDTO stays its original 9 keys without adapter.
GET /api/imports/:id: same {ok:true,import,asset}; xlsx asset is the original file.
POST /api/imports/:id/source-cell: {record,column}; 202, job.output={source_cell:SourceCellDTO}.
POST /api/runs/:id/source-cell: {side,record,column}; resolves revision's immutable import.
SourceCellDTO={side,record,column,sheet_name,coordinate,cell_type,
  stored_value,imported_value,mode,style_index:null|integer,number_format:null|string}
  both values are full strings <=65536 UTF8 bytes, never display-truncated.
GET /api/imports/:id/materials/export?kind=profile|manifest:
  authorized file stream; only owned registered xlsx materials, no arbitrary filename.
GET /api/capabilities (final gate only): current keys plus xlsx_api_version:1,
  import_profile_schema_version:1, formats:["csv","xlsx"], xlsx_limits:XLSX_LIMITS.
```

Bounds: `header_row` 1..1048576, columns 1..16384, end>=start, width<=256, last_row>=header_row, last_row<=1048576, last_row-header_row<=100000. Columns lists every selected physical column exactly once ascending; no mode default. `sheet_id = source_sha256 + ":" + workbook sheetId decimal`; both hash and relation identity rechecked against original bytes in catalog and conversion. Sheet names are opaque text, never paths. `sheets.length<=2048`; catalog exceeding final 2MiB job envelope fails `response_limit_exceeded`, no partial catalog. SheetDTO value_cells is 0..1000000; null bounds only when no value cells, otherwise row/column limits as above; selectable is exactly kind=worksheet AND state=visible. SourceCellDTO uses normalized cell_type enum `blank|text|numeric|boolean`, record1..row_count, column an exact header, mode the stored profile mode, style_index null or0..2147483647, and number_format null or UTF8<=65536. Header cells must be text, nonempty and unique after **no** trim/casefold; final core inspect also rejects whitespace-only headers using its existing is_blank contract. Modes apply to data rows only. Empty cells are `""`; every physical row in selected rectangle after header becomes one logical CSV row, including all-empty rows.

ErrorDTO retains `{code,message,phase,side,record,field}`. Adapter failures use phase `xlsx`; `record` is physical worksheet row, `field` is A1 coordinate (null for package errors); UI labels it explicitly. Core CSV validation errors keep existing including-header logical-record semantics. Stable B codes: `invalid_xlsx` (ZIP/XML/OPC structural failure), `unsupported_xlsx_feature` (unsafe/unsupported workbook feature), `invalid_import_spec` (shape/range/mode), `xlsx_source_mismatch` (hash/sheet binding), `xlsx_formula_rejected`, `xlsx_cell_error`, `xlsx_value_mode_mismatch`, `xlsx_date_rejected`, `xlsx_numeric_limit`, `xlsx_limit_exceeded`, `xlsx_conversion_mismatch` (restore regeneration). Synchronous profile errors HTTP400; unsupported format/features HTTP422 where caught at route; byte-limit upload413. Task failures appear as GET job failed/error; never map them to computation incomplete or successful empty output. Preserve current `quota_exceeded`, `job_timeout`, `invalid_bundle`, `replay_mismatch`, `response_limit_exceeded`.

## B planning decisions: conversion profile and package safety

`XLSX_LIMITS={compressed_bytes:67108864,entries:2048,actual_unzip_bytes:268435456,xml_bytes:67108864,xml_depth:64,cell_bytes:65536,csv_bytes:67108864,data_rows:100000,columns:256}`. Existing HOST_LIMITS stay 1GiB session, 64 assets/imports, 32 revisions, 256 jobs, one upload/child, upload60s/job180s/kill1000ms, parent quota250ms, orchestration1MiB/response2MiB. Lower test-only limits only; no user raising. Additional explicit bounded work: exponent absolute magnitude<=65536, resulting decimal UTF8<=65536, SST item count<=1000000 and aggregate decoded SST UTF8<=67108864, stored populated cells across all sheets<=1000000. These tighter host bounds must be displayed as host protection, not core limitations. Never allocate from dimension/max coordinate, SST count hints or exponent without checking.

- Candidate XML dependency `saxes@6.0.0` + pinned transitive `xmlchars@2.2.0` is installed in the checkout and locally probed in the Task1 candidate. Exact source/lock/license provenance and a dated zero-vulnerability `npm audit --omit=dev` result are recorded in `docs/dependency-audit.md`; the upstream repository is archived (2025-12-31). Initial Sol review conditionally accepted the saxes/xmlchars maintenance risk for this bounded local worker after frozen-ceiling enforcement. Round 1 implemented that guard; independent repair review SPEC/QUALITY PASS and controller clean-head 22/22 accepted Task1 at d63c2d9. A clean audit does not resolve maintenance risk. Rejection means revise the pinned decision and rerun the Task1 probes, never fall back to old predecoder.
- Genuine sample observations are stored separately from product behavior. Four LibreOffice 26.2.4.2 exports and one Microsoft Excel for Mac bundle version 16.113.4 (build 16.113.26100421) UI-saved file have independent expected-data JSON at `tests/fixtures/xlsx/genuine-save-expected.json`; `expected_cells_path` names this fixture-relative JSON, never worksheet XML. Excel `docProps/app.xml` separately records `AppVersion=16.0300`. Python independently reads stored workbook values. LibreOffice normalizes literal CRLF to LF; Excel stores `_x000D_`, which separate single-pass Xstring decoding yields as CR, and preserves `00123`. XML numeric character-reference CR behavior remains covered by its independent XML vector. The controller adopted the precise LO metadata and unused Default exceptions below. LO1904 is only a future positive candidate; LO1900 has a real table part and remains unsupported. Excel contains additional extensions and remains unsupported. The genuine-save oracle is storage evidence, not product importer evidence; no importer exists yet. Native worksheet `autoFilter` positive evidence remains outstanding.
- Task1 candidate parser configuration `new SaxesParser({xmlns:true,fragment:false,position:true,defaultXMLVersion:"1.0"})`; reject XML declarations not 1.0 and encodings other than UTF-8, invalid UTF8, DTD/doctype/custom entities, XInclude and unexpected schema extensions. On first parser error/doctype, throw and discard all output; never extend ENTITIES or fetch anything. XML depth and decoded accumulated cell/SST bytes are counted. Round 1 rejects caller `xml_bytes>67108864` or `xml_depth>64` as sanitized `invalid_xlsx` before parsing/events; valid lower testing limits remain permitted and exceeding them still raises `xlsx_limit_exceeded`. Node 22 focused tests 23/23 include true emoji UTF-8 splits at byte 4093/4094/4095, valid supplementary numeric references, invalid high/low surrogate references, and invalid/truncated UTF-8 crossing byte 4096 or caught at final decoder flush. RED exit 1 reproduced both raised-limit failures before repair; independent Python oracle 6 XML/5 native saves and real build exited 0, with evidence under `evidence/task-1/repair-round-1/` in the Task1 SDD directory. These focused results do not accept Task1 or replace controller repaired-SHA gates. Raw XML bytes are capped before parsing; parser token memory can be as large as capped XML (upstream does not provide per-token cap), so all parsing stays in killable child under timeout/quota. No whole-document entity replacement and no second XML decode; CDATA joins literal text. XML end-of-line normalization follows [XML 1.0](https://www.w3.org/TR/xml/); numeric CR references retain CR.
- OPC root content-type and officeDocument relation select workbook, then exact worksheet relation selects part; never guess `sheet1.xml`. Transitional SpreadsheetML only in v1; unsupported strict/other namespaces fail explicitly. Resolve package-relative relationship targets against source part, normalize legitimate internal `../` once, then require contained existing entry; reject absolute/URI/backslash/NUL/fragment/query/encoded traversal, duplicates and alias targets, missing/wrong type. Reject **any** external TargetMode/relationship anywhere (including hyperlink, data/pivot links), macros/vba, ActiveX, OLE/embedded package, encrypted OOXML container, XLS/XLSB/XLSM regardless of extension/content type. A chartsheet may appear as nonselectable `other`; selecting it fails. Inert styles/theme/docProps/internal hyperlinks are allowed by the exact v1 baseline below; extra benign genuine-save part types require an explicit Task1 freeze amendment, not an implementer's generic allow-all. Scan all package entries and relationship/XML parts, including unused parts, not only selected range. No disk extraction under attacker names.
- ZIP uses existing `yauzl@3.4.0`, CRC `buffer-crc32@1.0.0`; validate central/local filename, flags, method, sizes/CRC with descriptor-bit semantics, actual streamed bytes, CRC, truncation and actual aggregate sizes. Reject encryption flags0x41, symlink/special file, path traversal/absolute/backslash/NUL, duplicates, case/NFC aliases, overlapping local records and unsupported methods. Directory entries only if safe inert directories with no data, counted in 2048, never written; directories cannot alias a file. Validate every entry even unused data. The existing run-archive exact-file whitelist remains separate; reuse guard primitives only with regression proof.
- Reject formula markup in **any worksheet** (outside selected range included), with/without cached `<v>`, shared/array/data-table/dynamic formulas and formula-bearing calculation metadata. The exact LO `extCalcPr stringRefSyntax="CalcA1ExcelA1"` subtree frozen below is inert metadata only and is not evidence that formulas are absent; all-workbook formula scans remain mandatory. Do not read cache as stored numeric/text. Reject error cells anywhere, duplicate cell coordinates anywhere, row/cell coordinate disagreement, invalid/nonintegral/out-of-bounds SST indices, malformed style indices. Reject any merge intersecting the chosen rectangle (including header); merges outside it contribute a warning. Hidden/filtered rows inside range are included and warned; no visibility filtering. Count cells with nonempty stored content outside selected rectangle and show in completed import details before the UI replaces its currently bound source; selected worksheet must be visible. The range/modes are explicitly confirmed before conversion, and derived warnings get a second binding confirmation after conversion. `<dimension>` is informational only. Restriction to workbook-wide formula/error rejection is an explicit v1 conservative choice.
- Text shared/inline/rich joins only actual `<t>` descendants in document order; rich-run formatting ignored, phonetic `rPh` excluded, whitespace/Unicode retained. SpreadsheetML `_xHHHH_` escapes require a separate **single-pass** string-layer decoder after XML, preserving `_x005F_x0061_` as literal `_x0061_`, combining valid surrogate pairs and rejecting unpaired ones; never reparse resulting text as XML. Escape recognition is lowercase `_x` plus four case-insensitive hex digits, no recursive scan of output. The separate Xstring syntax and underscore escape are documented by [Microsoft's ST_Xstring notes](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/bd0aa042-434a-4ca7-b25f-4e1fd25a954d); docs are not local sample proof. Pin with genuine application sample and independent oracle in Task 1/3. XML decode and OOXML escape decode are different syntax layers, not two XML decodes.
- Numeric `<v>` is string only. All modes first validate numeric grammar `^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`; original lexeme bytes retained. `stored_text` retains its exact numeric lexeme, text `00123`, whitespace and date-like numeric serial without inferring a date. `decimal_lexeme` accepts numeric/blank only and moves the decimal point using strings, retains trailing fractional zeros, no Number/parseFloat/rounding: `9007199254740993` stays exact; `1.2300E+2`→`123.00`. Preserve plain lexemes; bounded expansion rejects `1e65537` before allocation. Empty exponent/sign-only/NaN/Infinity fail. Boolean `t=b` 0/1 becomes `FALSE`/`TRUE` in stored_text; other modes reject bool as mode mismatch. Unsupported cell types including ISO-date `t=d` fail rather than guess.
- `zero_padded_identifier` accepts blank/numeric only, exact nonnegative integral value and resolved format containing only 1..256 `0` characters (built-in format `0` allowed); pad to width, never truncate longer values. Reject fractional/negative/complex section/conditional/locale formats. Text identifiers must use stored_text. `excel_date` accepts blank/numeric exact integral serial after string normalization, no negative or fractional time; 1900 serial0→1899-12-31, 1→1900-01-01, 59→1900-02-28, 60 rejects, 61→1900-03-01; 1904 serial0→1904-01-01. Output `YYYY-MM-DD` through year9999; max serial computed from the chosen epoch by independent Python oracle, not guessed. Formatting never silently selects date mode.

Exact OPC baseline (**B planning decision, Task1 freeze**): namespace URIs `http://schemas.openxmlformats.org/spreadsheetml/2006/main`, `http://schemas.openxmlformats.org/package/2006/content-types`, `http://schemas.openxmlformats.org/package/2006/relationships`, `http://schemas.openxmlformats.org/officeDocument/2006/relationships`; XML namespace `http://www.w3.org/XML/1998/namespace`. Relationship types under the officeDocument2006 prefix are exactly `officeDocument,worksheet,chartsheet,sharedStrings,styles,theme,hyperlink,extended-properties,custom-properties`; core metadata relation `http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties` allowed. Content types are exactly workbook `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml`, worksheet/chartsheet/sharedStrings/styles `application/vnd.openxmlformats-officedocument.spreadsheetml.{worksheet,chartsheet,sharedStrings,styles}+xml`, theme `application/vnd.openxmlformats-officedocument.theme+xml`, core/extended/custom properties `application/vnd.openxmlformats-package.core-properties+xml`, `application/vnd.openxmlformats-officedocument.extended-properties+xml`, `application/vnd.openxmlformats-officedocument.custom-properties+xml`; relationship part `application/vnd.openxmlformats-package.relationships+xml`; generic XML default may classify a part but does not authorize arbitrary content. URI prefix concatenation enumerates constants, not wildcard suffix acceptance. Root relationship must have exactly one officeDocument target of the ordinary workbook content type; workbook sheetIds/relationIds are unique positive decimal integers/unique strings, respectively.

Namespace-aware benign-part validation uses exact roots: theme `http://schemas.openxmlformats.org/drawingml/2006/main`; core properties `http://schemas.openxmlformats.org/package/2006/metadata/core-properties` with DC `http://purl.org/dc/elements/1.1/`, terms `http://purl.org/dc/terms/` and XSI `http://www.w3.org/2001/XMLSchema-instance`; extended/custom properties `http://schemas.openxmlformats.org/officeDocument/2006/extended-properties` / `http://schemas.openxmlformats.org/officeDocument/2006/custom-properties`, values `http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes`. Namespace declarations alone do not authorize data or external access; local-name-only matching is forbidden. Proposed harmless extension attributes are exactly `{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable`, `{http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac}dyDescent` on row/sheetFormatPr and `knownFonts` on fonts. Every actual extension element and active `AlternateContent` rejects, except the one precise LibreOffice workbook metadata subtree frozen below; unknown extension siblings and children reject. Namespace identifiers are cross-checked against [Microsoft's namespace registry](https://github.com/dotnet/Open-XML-SDK/blob/main/data/namespaces.json). Unused xmlns declarations can be retained, but mc:Ignorable cannot hide unknown active data. Chartsheet may contain no external/active parts; unknown chart/drawing/metadata/calculation-chain/pivot relations fail closed in v1. Genuine files requiring extra benign types/attributes need a documented amendment and review; there is no allow-all escape hatch.

### Controller-frozen narrow LibreOffice metadata and content-type exceptions (2026-10-11)

The only allowed extension element subtree is the exact URI/local-name/value shape below, in the officeDocument-related ordinary workbook part. Namespace prefixes may differ because matching is by expanded URI and local name. XML namespace declarations are not ordinary attributes.

```text
{http://schemas.openxmlformats.org/spreadsheetml/2006/main}workbook
  optional single {same}extLst (no non-xmlns attributes)
    exactly one {same}ext (only ordinary attribute {}uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}")
      exactly one {http://schemas.libreoffice.org/}extCalcPr
        only ordinary attribute {}stringRefSyntax="CalcA1ExcelA1"
        no child elements and no non-whitespace character data
```

`extLst` and `ext` may contain only XML whitespace between children and no non-xmlns attributes beyond those named above. Reject duplicates, wrong parent/part/root, unknown namespace/URI, wrong value, extra attribute/element/non-whitespace text, nested or sibling extension content, or `AlternateContent`. This exception is metadata-only: it is not evaluated and does not authorize formulas, other extension markup, extra workbook relationships, or early return from complete package/formula validation. The same metadata occurs in a genuine LO workbook containing `<f>`, so the formula gate is independent and unchanged. LO1904 is a future package-inventory positive candidate only; its presence does not prove a product import.

The only additionally allowed `Default` content-type declaration pairs, and only when proven unused after complete entry inventory and effective content-type resolution, are:

| Extension | Content type |
| --- | --- |
| `fntdata` | `application/x-fontdata` |
| `jpeg` | `image/jpeg` |
| `png` | `image/png` |

The declarations must satisfy the ordinary exact content-types schema and uniqueness/conflict checks. Normalize the Extension token only using the frozen OPC rule; do not use ZIP entry-name case changes as an alias bypass. They do not authorize any matching actual ZIP entry, relationship, or override; any actual font/image part (including unreferenced parts), any matching entry, duplicate/conflicting declaration, a fourth Default pair, or a matching part-specific Override remains unsupported. Validate every entry's ZIP safety and inventory before concluding these declarations are unused. Real table parts, table-based filtering, images, font data and their relations remain unsupported. LO1900 is therefore a genuine source-value/rejection sample, not positive. Excel's `AlternateContent`, revision metadata and other extensions remain unsupported. A native worksheet `autoFilter` positive sample is still required later; the LO1900 table filter does not satisfy that evidence.

Task2 owns the positive and negative package tests for this exception. It must accept the exact subtree above, absence of `extLst`, and equivalent namespace prefixes; reject wrong part/root/parent, duplicates, wrong URI/namespace/value, non-xmlns extra attributes, non-whitespace text, extra/unknown nested or sibling elements, nested formula content, and any `AlternateContent`. A valid metadata subtree must never suppress rejection of formulas anywhere, including another or hidden sheet, outside the selected range, cached/shared/array/dynamic formula forms, or unused package parts. It must accept the three Default declarations only when no actual entry/effective Override uses them and reject matching actual or unreferenced PNG/JPEG/font data entries, related parts, case/alias variants, duplicate/conflicting declarations, actual-part Overrides, and a fourth unknown Default. Existing CRC/size/path/relationship/formula guards run in full before success. LO1904 is the candidate inventory positive; LO1900 table-based filter and all Excel extension structures remain negative. The later positive filter test requires a genuine worksheet `autoFilter` sample; it is not satisfied by a table filter.

Cell-type×mode table: blank→empty for all modes; shared/inline/rich/plain text→stored_text only; numeric→all four with each validator; boolean→stored_text TRUE/FALSE only; formula/error/unknown→reject before mode selection. Text is decoded stored string (shared index is resolved, not exposed as original value); numeric stored_value is untouched `<v>` lexeme. Leading/trailing text whitespace is never stripped, header is never converted by data modes. Filter warning count is rows inside selection affected by the worksheet's explicit autoFilter reference; no re-evaluation of filter predicates, never omission of rows.

## B planning decisions: materials and bundle v2

Internal `XlsxImportEntry` has public DTO fields plus `path` = canonical CSV, `canonical_asset_id`, `source_path`, `profile_path`, `adapter_manifest_path`; original `asset_id` stays original xlsx. Core compare/draft/check/review/branch receive `entry.path` exactly as CSV today. All reservations or input-byte/hash lookups for these core operations use canonical CSV bytes/hash (stat(entry.path)/canonical_asset_id), not the often much smaller original XLSX asset size; original/material copies count separately toward disk. No algorithm/op/report/manifest modification. Regeneration uses frozen profile + matching adapter version; no compatibility fallback.

`profile.json` exact `{schema_version:1,adapter_id:"restricted-ooxml",adapter_version:"1.0.0",import_spec:ImportSpec}`; canonical JSON bytes using existing `canonicalJsonStringify`. `AdapterManifest` exact `{schema_version:1,adapter_id,adapter_version,profile:{bytes,sha256},source:{bytes,sha256},canonical_csv:{bytes,sha256},worksheet:{sheet_id,name,relationship_id,part,date_system},row_mapping:{kind:"rectangle",header_row,data_first_row,row_count,column_start,column_end},warnings:Warning[],conversion_counts:Counts}`. No local paths/UI state. Warning exact `{code,count}` unique fixed codes in this fixed order `hidden_rows_included`, `filtered_rows_included`, `outside_range_value_cells`, `outside_range_merges`, `rich_text_formatting_ignored`; Counts exact `{blank,text,numeric_lexemes,expanded_exponents,booleans,dates,zero_padded_identifiers}` nonnegative safe integers, data-cell categories sum row_count*column_count (expanded is a numeric_lexemes subcount). Warnings with zero count omitted, at most five; hidden/filter counts cover selected data rows excluding the header, rich count is selected text cells using multiple styled runs. Profile/adapter JSON each<=1MiB; canonical CSV<=64MiB validated by core inspect before publication. Counts/hashes derived from conversion, not trusted from upload.

Rectangular mapping: logical data record r→physical row header_row+r; column name maps via exact headers to selected physical column. No skipped blanks/hidden rows, so **no row-map.json in v1**. Nonlinear mapping requires a later explicit schema/profile and plan; never invented opportunistically.

CSV-only export still produces **exact schema-v1 12-file package**, byte/schema behavior unchanged. Mixed XLSX or XLSX/XLSX uses workbench.json schema2 exact `{schema_version:2,app_version:"0.2.0",engine_version:"0.1.0",revision:<unchanged6keys>,files:[{path,bytes,sha256}]}`. files enumerate all 11 original run files and exact allowed import material files; workbench.json itself not listed. `import/manifest.json` exact `{schema_version:1,adapter_manifest_schema_version:1,sides:[SideManifest,SideManifest]}` sorted left/right, each exact:

```text
CSV SideManifest={side,format:"csv",source:{path:"run/input/<side>.csv",bytes,sha256}}
XLSX SideManifest={side,format:"xlsx",source:{path:"import/<side>.xlsx",bytes,sha256},
  canonical_csv:{path:"run/input/<side>.csv",bytes,sha256},
  profile:{path:"import/<side>.profile.json",bytes,sha256},
  adapter_manifest:{path:"import/<side>.adapter.json",bytes,sha256}}
```

V2 file whitelist = original12 + `import/manifest.json` + three files per XLSX side: **16 mixed / 19 two-XLSX files**, no directories/row-map/unknown/duplicates. Run11 and core manifest v1 remain untouched. Current run ZIP limits256MiB compressed/1GiB actual/32entries apply to outer bundle; each embedded source separately rechecked with XLSX limits. profile/adapter/import manifest<=1MiB, workbench.json<=1MiB. All metadata exact versions/hash/byte/path/side checks; hashes cover source/profile/adapter/normalized CSV independently. Tampering consistent outer hashes still requires regeneration + semantic validation.

Restore v1 retains current byte/hash/core replay. Restore v2 validates full package, reads original XLSX and profile, re-converts in child, compares canonical CSV bytes/hash and canonical derived AdapterManifest to archived materials, then executes unchanged CLI resolve and compares report.json bytes. Only then reconstructs current-session Imports with original-format/source identities and config binding, fresh IDs/head; revision's imports cannot silently become CSV. CSV side restored from run snapshot; XLSX side registers original xlsx plus canonical CSV internal asset; config adds one asset: **3/4/5 assets for v1/mixed/two-XLSX, always two Imports**. Update current `checkRestoreCapacity` hard-coded3 with exact format-aware batch validation and all quota/count/ownership checks; atomic no-await commit uses existing final latch. XLSX ordinary import atomically registers canonical CSV asset + XlsxImportEntry after original upload; profile/manifest files count toward disk, not fake public assets. Cumulative review/branch keep same source import objects and materials. Failure/cancel/timeout/disk-full leaves prior registry/head/result untouched; only owned staging is removed after child exit.

## Current interface integration points

`server.mjs:34` currently constructs CSV-only `importEntry`; :129 CSV import exact body, :138 metadata, :186 bundle v1, :218 restore3assets. `session.mjs:51` prepareAsset, :57 commitAsset, :58 commitImport; :83 checkRestoreCapacity and :91 commitRestored require exact3assets. `jobs.mjs:41` finalize prepares outputs then fits final envelope/quota and commits without await; preserve this boundary. `engine-host.mjs:29` executeTask currently decodes path csv; :59 bundle and :64 restore core replay. `archive.mjs` RUN_BUNDLE_FILES/readRunBundle/writeRunBundle protect exact v1. `contracts.mjs` strict projection must use discriminated CSV/XLSX Import shapes without adding adapter to CSV. `public/import-view.mjs` currently assumes upload csv, .csv accept and swap exact `{asset_id,side}`; B must retain/reuse profile when swapped, not lose provenance. `scripts/workbench-package-provenance.mjs:11` EXPECTED and :123 packageContract pin all production dependencies; :70 buildInputs includes provenance module, so candidate dependency changes require regenerated genuine build proof. Update packager/checker license/provenance/fixture coverage together, never weaken strict source-at-HEAD/clean-source checks.


## Task2 repair round 1 approved freeze (2026-10-13)

Task1 ACCEPTED LOCAL at d63c2d9aca9ed3b1042a90ed4230119d97e7cd3c, independent SPEC/QUALITY PASS and controller 22/22. Task2 initial bb0481b7 remains NOT ACCEPTED; sole repair round1/2 is in progress. Tasks3–7 remain PLANNED / NOT IMPLEMENTED; production CSV-only. Historical candidate/failed evidence remains retained.

OwnedPart = {path,bytes,sha256,content_type}: path is an absolute generated owned file path; bytes is a nonnegative numeric byte length. Consumers may read original verified bytes from that internal path; no raw bytes or paths enter WorkbookDTO. PackageInventory exact keys remain source/date_system/sheets/parts; disposal uses private ownership only.

The following authorized revision is now frozen, subject to the exact R1–R3 rulings that follow. Its original draft/provenance status text is historical; implementation remains unaccepted.

## 建议冻结的具体边界

仅允许全 workbook package 最多一个被唯一普通可见 worksheet 引用的、完整验证为没有内容的 DrawingML `wsDr` part，并要求同 worksheet 有下面精确 ref-only autoFilter。没有 drawing 时既有合法包路径继续有效；真实 drawing 内容、table-based filter、filter predicates、images/font/chart parts、external relationships 仍不支持。仍按 design §8包含选区的全部数据行，绝不按 visibility/predicates省略或重算；这是范围与告警支持，不是筛选计算能力。

全部元素和属性按 expanded namespace URI + local name 比较，不按 prefix/substring/producer 声明。xmlns 声明不算 ordinary attributes，不授权未知实际数据；既有 schema/唯一性/路径/关系检查保持。

```text
S = http://schemas.openxmlformats.org/spreadsheetml/2006/main
R = http://schemas.openxmlformats.org/officeDocument/2006/relationships
D = http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing
P = http://schemas.openxmlformats.org/package/2006/relationships
C = http://schemas.openxmlformats.org/package/2006/content-types
XML_WS = exactly U+0020, U+0009, U+000D, U+000A
DRAWING_CT = application/vnd.openxmlformats-officedocument.drawing+xml
```

`only XML_WS` 的算法须逐字符核对该四码点，或等价 `/^[\x20\x09\x0D\x0A]*$/`，允许空串；不能用 `trim()`、`\s`、Unicode whitespace类别、locale规则或字符串 normalize。适用于下面每个规定为空白的 text/cdata event，并保持跨事件累积一致。CDATA 中出现这四码点之外的字符也拒绝；CDATA 不重新解释为 XML，数值字符引用由 tokenizer解码一次后再按得到的码点判断。U+00A0、U+FEFF（作为元素内字符数据）、U+2003、U+2028等都不是 XML_WS。XML普通 EOL normalization以及 `&#13;` 保留 CR 的既有合同不改变。

## ref-only autoFilter 精确语法

任何普通 worksheet 中支持的 autoFilter 只能如下：worksheet part由普通 workbook worksheet关系确定，根恰 `{S}worksheet`；根的直属 `{S}autoFilter` 为 **0或1个**，其它位置出现 autoFilter 不合法。带 drawing例外的 worksheet必须是 visible且恰有1个此节点；catalog不依赖导入选区，不要求已选择该worksheet，但导入仍须用户显式选择可见普通 worksheet。

```text
{S}worksheet
  {S}autoFilter
    ordinary attribute set is exactly { {}ref }
    {}ref = COL ROW ':' COL ROW
    COL = 1..3 uppercase ASCII letters A..Z
    ROW = [1-9][0-9]{0,6}
    decoded ref lexical shape matches:
      ^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$
    both columns decode to integers 1..16384 (A..XFD)
    both rows decode to integers 1..1048576
    first_column <= last_column AND first_row <= last_row
    no child elements, no comments, no PI
    text/cdata content is only XML_WS
```

必须有且只有 unqualified `ref`；qualified ref、xml:space、mc:Ignorable、任何ordinary extra属性均拒绝。只接受一个显式 A1 rectangle，包含 `A1:A1` 的等端点矩形；单个 `A1`、`$A$1:$F$3`、lowercase、leading-zero rows、首尾/内部空白、reversed端点、union/list/multiple ranges、sheet-qualified/URI reference、R1C1、越过XFD或1048576均拒绝。ref词法比较发生于合法XML属性值的一次解码后，不做额外unescape或trim。列解码只需至多3个ASCII字母的有界整数运算；坐标不是单格存储值的Number转换。

不许可任何 `filterColumn/filters/filter/customFilters/dynamicFilter/top10/colorFilter/iconFilter/sortState/extLst/AlternateContent` 或其它子元素；带条件的 native筛选文件仍 unsupported。该拒绝适用于普通worksheet的 autoFilter，不因没有drawing而开放 predicates；table/filter结构仍按既有table拒绝。此处冻结的是此前模糊“validated autoFilter”的全部 v1支持语法，并不声称当前validator已实现。

autoFilter范围可以到工作表坐标上界，不据此分配矩阵、遍历百万行或抬高导入100000数据行/256列限额。告警只计用户选区的data rows（排除用户header row），且该selected rectangle与autoFilter矩形列区间相交时，取二者行区间内的selected data rows交集计数；不存在列相交则为0。它是“导入选区处于筛选范围的行数”，不是满足或不满足predicate的行数。该计数规则需要在adapter合同中与既有range-count文字一起精确同步；保持include-all。隐藏warning按selected data rows显式hidden标志独立计数，可与filtered warning重叠，不能相减或作为省略理由。

## 空 drawing、关系、Content_Types 的闭合合同

**整个package最多一个**受此例外允许的drawing part，整个package最多一条drawing关系、一个worksheet drawing标记；不能泛化为每worksheet无限多个。例外owner必须是普通visible worksheet，同owner恰一个上述ref-only autoFilter。其它hidden/veryHidden/other/chartsheet source均不满足例外；不允许由于它未被用户选择而跳过检查。

```text
owner {S}worksheet 根的直属 {S}drawing:
  exactly one marker if this exception exists
  ordinary attribute set exactly { {R}id }, value nonempty
  no children/comments/PI; text/cdata only XML_WS

owner worksheet relationship part, root {P}Relationships:
  exactly one matching direct {P}Relationship
  ordinary attribute set exactly { {}Id, {}Type, {}Target }
  Id matches marker {R}id exactly; Id unique in this source rels
  Type = R + /drawing exactly
  TargetMode absent (explicit Internal also outside this narrow exception)
  Target resolved once under original contained OPC rules to existing XML part

target part:
  root exactly {D}wsDr
  zero ordinary attributes, zero child elements, only XML_WS text/cdata
  no comments/PI anywhere in the part (including before/after root)
  normal XML declaration allowed only under original XML 1.0/UTF-8 policy
  NO relationship part for this target, including a valid empty .rels

Content_Types {C}Types:
  exactly one direct {C}Override for this target
  ordinary attributes exactly {}PartName and {}ContentType
  PartName matches target under original OPC comparison/normalization
  ContentType exactly DRAWING_CT
  NO new Default declaration of DRAWING_CT or drawing extension
```

target只有上述唯一inbound drawing关系，并被上述唯一worksheet marker使用；unreferenced空part、共有target、dangling标记/关系、wrong/missing effective content type、多余drawing entry/Override/关系都失败。原关系part中其它已经允许的关系仍独立验证；不将其变成“必须只含drawing关系”而误改既有internal hyperlink兼容。关系root/直属关系语法、唯一Id和Target检查照常。关系路径不硬猜 `xl/drawings/drawing1.xml`，只按validated source关系解析一次；安全internal `../`仍允许，absolute/URI/backslash/NUL/fragment/query/encoded traversal、aliases/case/NFC冲突仍拒绝。

原三对unused Default（fntdata/application/x-fontdata、jpeg/image/jpeg、png/image/png）保留原精确规则：必须先完整验证inventory/effective types才能证明unused；它们不许可任何实际相关entries/关系/Override。DRAWING_CT是这次唯一真实part类型例外，不能援用unused规则让未知Default、真实PNG/JPEG/font/table/chart内容成功。

任何oneCellAnchor/twoCellAnchor/absoluteAnchor、shape/pic/graphicFrame/connection/chart、extension/AlternateContent、非空文字、嵌套f/XInclude、错误namespace/root/位置/属性继续拒绝。不渲染、不求坐标、不解析drawing子结构、不递归读它的关系、不fetch，零children必须是实际验证结果，不是“忽略”子树。

## XML helper 必须允许的最小改动及边界

现 `workbench/xlsx/xml.mjs` 的 `parseXmlEvents(bytes,{onEvent,limits,part})`只emit open/text/cdata/close；没有comment或processinginstruction handler。该行为意味着它们会被丢弃，package事件树无法证明“无comment/PI”。不能靠字符串搜索（CDATA里的字面 `<!--`/`<?` 不是markup），也不能声称当前事件树已实现该禁止。

建议在options增加 **`rejectCommentsAndProcessingInstructions: boolean = false`**。仅此一项布尔策略开关；omitted/undefined与explicit false保留原行为，explicit true在Saxes的comment/processinginstruction回调遇到真正markup时立即抛既有sanitized `XlsxXmlError`/`unsupported_xlsx_feature`、phase=xlsx，停止解析并丢弃候选输出。除undefined的默认语义外，任何显式非boolean值（null、0、string、object）在解析/事件前以invalid_xlsx拒绝。XML declaration仍走原xmldecl handler，不按普通PI拒绝；不接入ENTITIES、不修改parser tokenizer配置、不改变existing error/depth callbacks。

**不新增/修改 XmlEvent类型或字段**，不emit comment/PI、不把其内容传给caller、不引入event subscription或generic API、不改变既有unknown-options处理。callback错误的原sanitization保持。XML fatal UTF8、XML1.0/UTF8声明校验、4096bytes streaming、64MiB/64depth硬上界、lower test limits、DTD/custom entity/XInclude拒绝、syntax first-error throw、一次XML character-reference解码及CDATA literal语义完全保持；这不是重开Task1 parser架构。

精确调用范围：仅在验证这个真实drawing target，以及ordinary worksheet中出现autoFilter或drawing marker的part时，request true。为保证ref-only node/marker内部“无comment/PI”且不增加事件API，此窄兼容规则**同时禁止这些qualifying worksheet整part中的comment/PI**，包括root外与cell等其它位置；不是只禁止两个节点内部。没有autoFilter/drawing的worksheet、theme/docProps/SST/styles/已有metadata等原默认调用不请求此选项，不新增全包comment/PI blanket拒绝。drawing所关联关系/Content_Types仍按原schema扫描，不对所有关系/Content_Types自动增加这个开关。

owner分类若在已有安全inventory扫描后才知道，可对qualifying worksheet的**同一原始、已验证来源bytes**作一次strict validation pass；不能对先前decoded文本重新做entity replacement/XML decode，不能重新inflate或绕过原aggregate解压计数。每次parser独立从原UTF8 bytes开始并且每次单次解码，不将第一次输出作为第二次输入；两次CPU工作仍在原worker timeout/quota内，仍按现XML限额、不抬高预算。implementation若能先确定qualifying owner，可一次strict parse完成；这里不强制新的树或scanner架构。非qualifying默认兼容必须实测保持。

**具体scope变更须写入implementation brief/owning task allowlist：** 在既有Task2 package/contracts/test之外，仅增加 `workbench/xlsx/xml.mjs` 上述布尔开关和 `tests/workbench-xlsx-xml.test.mjs` 对应focused regression测试。理由是已授权精准禁止comment/PI在当前helper不可观察，不能用忽略或regex伪实现；不是允许更改其它Task1 parser合同。本草案没有修改这些文件。controller/independent reviewer先确认契约与该文件scope，再由唯一writer实施；当前报告不消耗Task2 repair cycle。

## 完整扫描、安全及失败行为

每个actual ZIP entry（unused也包括）仍执行路径/local-central一致性、flags/method/CRC/size/descriptor/truncation/实际总解压/overlap/alias/special-file安全检查，不落盘攻击者路径。所有关系/XML和所有worksheet，包括hidden/选区外，继续扫描external/unknown parts、formula/error/重复坐标/SST/style/merge及既有限额。空drawing/合法metadata/unused Default都不授权早返回，也不是无公式证明；公式有无cache/shared/array/dynamic形式均拒绝，不拿cached值导入。外部/宏/ActiveX/OLE/table/chart/image/font/embedded等原拒绝保持。

malformed XML/OPC/A1语法或结构用既有invalid_xlsx；合法XML中的禁止comment/PI/children/unsupported content用既有unsupported_xlsx_feature；不新增错误schema。遇失败整批失败、丢弃partial output，不注册Import/manifest、不发布成功empty结果；limits保持既有code和sanitization。多种同时存在的违规不保证错误优先级，只要求明确failed、不可发布、不泄漏路径/内容。


### R1 — Target has exactly one inbound edge of any type

Read revision line 84's “唯一 inbound drawing 关系” as:

> Across the complete validated package relationship graph, the drawing target has exactly **one inbound relationship of any Type and from any source**. That sole edge must originate at the single visible ordinary worksheet owner, have Type exactly `R + /drawing`, and match the sole direct worksheet marker's `{R}id`. Any additional edge to the same target, including a hyperlink from the same owner or any edge from another source/root/chartsheet, rejects the exception.

Count normalized validated target identities, after all original containment/path/alias checks. A marker is separately required and is not itself a relationship edge. Reject multiple owners, duplicate marker/relationship/Override, dangling or unreferenced drawing target, additional drawing-typed relationships, actual drawing parts or drawing Overrides anywhere. Do not use a global DrawingML namespace/type allowlist or skip all other content validation after finding a valid empty target. A permitted internal hyperlink to **another** otherwise legal target can coexist; a hyperlink to this drawing target cannot.

Add an explicit test for the empty target plus a non-drawing inbound hyperlink, from both same-owner and other-source contexts. A test only counting drawing-typed edges cannot prove R1.

### R2 — Relationship and Override remain exact leaf schemas

The direct `{P}Relationship` at lines 61–67 and direct `{C}Override` at lines 76–80 must have their exact listed ordinary attribute sets, **zero element children**, and only XML_WS direct text/cdata. Their namespace-expanded parent/root and cardinalities remain exact. Existing ordinary content-types/relationship root schema, required attributes, uniqueness and target safety are fully enforced; “原 schema 照常” does not permit the current implementation's nested-child acceptance identified by I2. Unknown nested relation/Override elements, mixed non-whitespace content or misplaced duplicates reject.

This ruling does **not** add a blanket comment/PI prohibition to content-types or relationship parts. Revision line 98 preserves their prior comment/PI behavior. Whole-part strict comment/PI mode is for actual approved drawing target and ordinary worksheet parts containing autoFilter/drawing markers. Default behavior for nonqualifying parts is preserved; malformed/unknown parts must still fail their own complete schema validation.

Existing mandatory generic XML Default is retained. “No drawing extension Default” at line 81 means no new drawing-specific Default or DRAWING_CT Default; it does not prohibit the already-required `xml → application/xml` Default merely because the approved target ends in `.xml`. The target requires its one explicit correct Override; no generic Default grants drawing support.

### R3 — Strict validation parses original verified bytes only

When classification is known before parsing, one strict pass is preferred. The explicitly allowed additional strict validation pass at line 100 may use **the same immutable original, already verified UTF-8 part bytes** through the same helper with true. It may never accept decoded output/tree/text as XML input, globally replace entities, predecode, re-inflate or evade aggregate byte accounting. Each parse independently applies the same lower-only XML byte/depth ceilings and fatal first-error policy; both passes' CPU/memory work remains under unchanged killable worker timeout/quota. No new parser, token policy, XML event API or decoder is approved.

The strict policy applies to all qualifying ordinary worksheet parts even when no drawing is present, as revision lines 27/47/98 explicitly freeze. A hidden/unselected/unreferenced malformed worksheet is never exempt from full validation. The option is not an importer user control or capability bypass.

The narrowly approved source/test expansion is exactly `workbench/xlsx/xml.mjs` and `tests/workbench-xlsx-xml.test.mjs` for the boolean policy and focused tests, in addition to Task2's existing package/contracts/package tests, malicious mutations/oracle/fixture ownership and synchronized planning files. Do not broaden Task1 implementation scope or dependencies.



## Task2 static FilterDatabase approved clarification (same repair1/2)

Only the exact optional native static filter-range leaf below is authorized; no general named formula support, no acceptance or activation.

## 最窄 FilterDatabase 精确草案

仅在 **officeDocument关系选出的普通workbook part**根 `{S}workbook`直属允许可选单个 `{S}definedNames`；absence合法，presence只能恰1个直属 `{S}definedName`。全包不得在其他root/part/parent出现这两个元素，不能出现第二list/name（即使未引用）。不新增part、ContentType或relationship，不改变profile/manifest/DTO。

```text
S = http://schemas.openxmlformats.org/spreadsheetml/2006/main
XML_WS = only #x20 / #x9 / #xD / #xA

{S}workbook direct {S}definedNames, cardinality 0..1:
  zero non-xmlns attributes
  exactly one element child, direct {S}definedName
  surrounding text/cdata only XML_WS, no comments/PI

that {S}definedName:
  ordinary attribute set exactly:
    {}name          = _xlnm._FilterDatabase
    {}function      = false
    {}hidden        = true
    {}vbProcedure   = false
    {}localSheetId  = 0
  no element children, no comments/PI
  accumulated decoded text/cdata exactly:
    owner_name + '!$' + start_COL + '$' + start_ROW
               + ':$' + end_COL + '$' + end_ROW
```

最窄值规则保留本次唯一观察到的literal属性值：false/true按这些精确lowercase字符串比较，不接受0/1/省略/不同case；`localSheetId`只许可canonical字符串`0`，且绑定当前workbook sheet list**第0位**，不是sheetId的值、更不是关系Id尾号。样本sheetId=1不能把localSheetId改成1。未来确需其它ordinal须另明确扩展本值范围，不能实现时悄悄泛化。

第0位owner须恰为当前emptydrawing/ref-only autoFilter已验证的同一个普通visible worksheet，关系/part/name身份一致，autoFilter恰1且已按冻结A1 rectangle语法通过。owner sheetName仅接受本方案最小unquoted simple形态 `[A-Za-z_][A-Za-z0-9_]{0,30}`，本样本Synthetic符合；不在本次兼容quoted sheetnames/spaces/apostrophe/Unicode表达式语法。要求名称在workbook sheet list中精确唯一，不做trim/casefold/normalize；metadata的owner_name字面必须与该owner的name精确一致。

range四端点直接由已验证autoFilter `ref`拆解得到（uppercase A..XFD、canonical row1..1048576、ordered矩形），按上面的固定absolute语法生成唯一expected string再与leaf累积文本精确相等；不通用解析defined-name公式，不依赖“禁字符黑名单”，不接受leading '='、operators/functions/constants、named-reference、union/list、多range、R1C1、whole-column/row、sheet-range/3D、externalworkbook brackets/URI、relative地址、不同rectangle或首尾/内部额外whitespace。这里的`! : $`仅存在于唯一构造出的静态sheet+rectangle模板，不授权表达式运算符。

definedName值本身不trim；XML references仅tokenizer单次解码，CDATA只拼literal字符，不引入Xstring decoder或二次实体替换。definedNames外层只用四码点XML_WS，不能JS trim/\s。语法验证完才允许将该元数据视为inert；它不决定选区、模式、日期系统、header/record mapping、warning计数或stored values，已有worksheet autoFilter仍是范围告警来源。不存在或与owner/rectangle不一致就reject，不能回退为任意name或忽略错误。

comment/PI精确禁止需要使用已批准的default-false XML helper选项：在**含该候选definedNames的普通workbook整个part**请求true（含root外、其他workbookmetadata位置都禁止），明确记录该额外有限兼容限制。不新增XmlEvent/API/decoder，不对没有该list的workbook或其它benign parts改变默认行为；如已先读结构分类，strict pass只能重用同一immutable原bytes、同限额和worker预算，按R3，不把decoded输出重新解码。current native无comment/PI符合此限制。

所有其它definedNames/definedName内容、名字、context和属性均继续unsupported，包括Print_Area/Print_Titles、命名公式/常量、function/vbProcedure=true、未知extra属性、嵌套f、duplicate/mixedchildren、错误namespace/AlternateContent。**没有通用公式grammar放行**；实际worksheet公式、cached/shared/array/dynamic公式与formula-bearing未知calculation metadata仍全包拒绝。当前blanket guard只可被这个全上下文predicate取代，不能简单删词。

### F1 — Optional grammar means absence is allowed; presence requires every condition

Only the officeDocument-relation-selected ordinary workbook root may have one direct `{S}definedNames`. That list is optional; absence is legal. If present, it has zero ordinary attributes, exactly one direct `{S}definedName`, only exact XML_WS surrounding text/cdata and no comments/PI. The leaf has zero element children and exactly these five **unqualified** decoded attributes, with exact case-sensitive values:

```text
name=_xlnm._FilterDatabase
function=false
hidden=true
vbProcedure=false
localSheetId=0
```

No omission/default/boolean lexical alternatives/qualified or extra attributes are allowed. Reject any other list/leaf occurrence anywhere in the package, including wrong root/part/parent, duplicates, other namespaces masquerading as this schema or unknown siblings/children. Existing namespace/schema fail-closed rules remain. Prefix equivalence alone is legal; namespaces do not authorize content.

Draft line 85's “不存在 ... 就 reject” is read as **absence of the required owner/rectangle/binding when a list is present**, not a mandatory-list rule. If the list is absent, its absence cannot itself reject an otherwise supported package. If a list exists without a matching empty-drawing/ref-only owner, reject; do not silently ignore it.

### F2 — Binding is ordinal zero plus relation identity, never a guessed sheetId

`localSheetId="0"` refers to the workbook sheet-list ordinal zero, including the actual validated sheet-list ordering; it does not mean sheetId 0/1 or a relationship Id suffix. That first sheet must be the same visible ordinary worksheet owner already satisfying the complete single-empty-drawing + ref-only autoFilter predicate, with its validated relationship/part/name identity. No other ordinal or state/kind is accepted.

Owner name must match `[A-Za-z_][A-Za-z0-9_]{0,30}` and be exactly unique in the workbook list, with no trim/casefold/normalization. The metadata text must use this actual name exactly. There is no Excel-style sheet-name lookup, name evaluation or fallback; a renamed/moved/hidden/different owner, missing drawing/autoFilter or mismatched relation rejects. This specific simple-name boundary excludes quoted/Unicode/space/apostrophe sheet-name syntax for the named metadata without weakening ordinary opaque sheet-name rules for packages where this metadata is absent.

### F3 — Value acceptance is exact construction, not formula parsing

Build the expected decoded text from that owner's already validated autoFilter endpoints, retaining uppercase canonical COL and canonical bounded ROW tokens:

```text
owner_name + '!$' + start_COL + '$' + start_ROW + ':$' + end_COL + '$' + end_ROW
```

The accumulated decoded leaf text/cdata must equal this entire string exactly. Treat the fixed `!`, `$`, `:` characters only as literals in this single template, never as an admitted general formula/operator grammar. No trim, Xstring decoder, extra unescape, regex blacklist or parsing of arbitrary named formulas is permitted. XML tokenizer reference decoding occurs once; CDATA concatenates literal characters without reinterpretation. No row/column/range allocation follows the metadata.

All constants/functions/operators/leading `=`/relative/external/3D/union/whole-row-column/quoted-sheet/other-name forms and any differing rectangle or extra whitespace reject. Do not choose ImportSpec range/modes/date system, compute warnings, retrieve stored values or affect row mappings from this metadata: worksheet autoFilter remains the warning source and explicit ImportSpec remains the import source of selection.

### F4 — Strict-workbook restriction is explicit and remains default preserving

For a workbook containing a candidate definedNames list, request the already approved `rejectCommentsAndProcessingInstructions:true` and reject real comment/PI markup throughout that entire original workbook XML part, including root-exterior and otherwise inert metadata locations. This is the draft's explicit narrow compatibility restriction, not a claim the unchanged event API can isolate leaf-local comments.

Do not enable strict mode globally or change default behavior for workbooks without the list or other benign parts. Any additional strict validation pass uses only the same immutable original verified UTF-8 bytes under the same helper/ceilings and unchanged worker quota; no decoded text/tree reparsing or re-inflation. XML declarations continue through the original XML 1.0/UTF-8 declaration policy. No further XML helper option/event/decoder/dependency change is needed or authorized for this rule; its implementation is a package validation policy call and focused package tests.

### F5 — Full validation still finishes before accepting the static metadata

Only after all F1–F4 conditions pass may this exact leaf be classified inert. Other named formulas/constants, Print_Area/Print_Titles, unknown calculation metadata, actual worksheet `<f>`/errors and cached/shared/array/dynamic formula forms continue to reject across the entire package, including hidden/unselected/unreferenced parts. The existing exact LO extCalcPr exception, unused Default policy and empty-drawing R1–R3 remain independent. In particular R1 still counts **all** inbound relationships to the drawing target, not only drawing type.

Neither the list nor the valid empty drawing permits early success or skips ZIP/descriptor/CRC/size/overlap/alias/type/relationship/XML/SST/style/cell/budget validation. Failure publishes/registers nothing and uses the existing sanitized error categories; do not add DTO/profile/manifest fields or new parts/types/relations.
