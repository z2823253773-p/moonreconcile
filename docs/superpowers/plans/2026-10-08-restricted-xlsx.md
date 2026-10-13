# Restricted XLSX B Implementation Plan

> **Implementation workflow:** One authorized implementation writer owns the change. GPT-6.1-sol performs independent scoped review at high reasoning effort. Do not add implementation writers. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verified, restricted XLSX-to-CSV import adapter with explicit profiles, traceable materials and mixed-format report-bundle restore, while retaining MoonBit's sole authority over reconciliation.

**Architecture:** Bounded ZIP/namespace-aware XML and lexical conversion run only in the existing killable worker. Canonical CSV goes through existing full core inspect and normal Config/compare/review; parent commits source materials/imports/restored revisions atomically. Independent versioned B host/profile/bundle schemas leave CSV v1 behavior and core manifest v1 intact.

**Tech Stack:** Existing Node22.23.3, MoonBit JS bridge, native HTML/ESM, yauzl3.4.0/yazl3.3.1/buffer-crc321.0.0, candidate `saxes@6.0.0` with pinned transitive `xmlchars@2.2.0`. Task1 implementation and native stored-value oracle exist. Initial independent review failed on raised XML ceilings and missing boundary regressions; round 1/2 repairs are implemented with 23/23 focused XML tests, independent repair review SPEC/QUALITY PASS and controller 22/22 accepted Task1 at repaired d63c2d9. Python zipfile+ElementTree is a development oracle only; genuine Excel/LibreOffice-saved synthetic files are evidence, not runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-quarter-workbench-design.md` opening frozen P0 and §8 are binding. Read companion `docs/superpowers/plans/2026-10-08-restricted-xlsx-preflight.md` for exact B-planning decisions/DTOs/errors/limits. Task1 implementation is candidate commit `d87373fe2ea382a9476e7841b46d3e760db38b2d` from base `22fa85a01460723c3823f66bb4ae098e428bbacf`; the controller adopted a narrow metadata-policy amendment in `01e40ffd0e44f0350388b7b6d504e03ae4a5bf7d`, documented below. Initial independent review failed; round 1/2 repairs addressed the two XML findings; independent repair review and controller clean-head gates accepted Task1 at d63c2d9. Task1 is ACCEPTED LOCAL at d63c2d9. Task2 candidate bb0481b7 is NOT ACCEPTED and repair round1/2 is in progress; Tasks3–7 remain PLANNED / NOT IMPLEMENTED. Production XLSX remains disabled. Evidence and Task1 report are under `.superpowers/sdd/2026-10-08-restricted-xlsx/`; prior `2026-10-04-local-workbench/xlsx-b` records remain historical/read-only. No push/merge/release.

## Global Constraints

- Node.js >=22; app_version="0.2.0", api_version=1, engine_version="0.1.0", Config v1, manifest v1 and existing op/request/result/exit semantics unchanged. No core algorithm or CSV parser duplication.
- Source canonical CSV<=67108864 bytes, data records<=100000, columns<=256, cell UTF8<=65536. XLSX compressed<=67108864, entries<=2048, actual decompressed<=268435456, XML<=67108864/depth64. Exact B schemas/additional bounded-work decisions are in preflight; only lower testing limits allowed.
- Single explicitly selected visible ordinary worksheet; explicit rectangular range and column mode; formula_policy="reject"; no first-sheet/type/key/trim/tolerance guesses, no formula recalculation/external fetch. Include empty/hidden/filtered rows and expose warnings.
- Raw originals, profile, adapter manifest, row mapping, warnings/counts and independent hashes stay outside standard run/manifest v1. Old CSV12-file exports/restores stay exact; v2 mixed16/two-XLSX19-file bundle regenerated CSV hash + core report byte equality required.
- Local only, no external account/CDN/logged data/token/path/filename; same ownership/authentication/cancel/timeout/quota and final no-await publication latch. Failed jobs publish nothing, old results remain.
- Only `/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench`, branch feature/quarter-workbench, Task1 base `22fa85a01460723c3823f66bb4ae098e428bbacf`. Historical A+C accepted SHA `607d1736` and its acceptance evidence remain read-only; Main72eb305 remains untouched; no push/global SDK mutation. A+C accepted tests are baseline evidence, not B proof.
- Roles already supplied: **one GPT-6-luna initial implementer at a time**, Sol local review/integration per task, final fresh **GPT-6.1-sol high** scope audit. Do not ask again for roles or dispatch multiple product writers. Each task requires exact diff/local commit/review/evidence before next task. Planning does not dispatch implementers.
- Production XLSX capabilities/entry remain closed until full Task7 gate; task tests may use internal xlsxEnabled construction only. All new preflight choices freeze at Task1; dependent code cannot redefine schemas.

## Review Focus

- Character references forming markup/attributes, nested ampersands and literal OOXML escape strings must remain text with a single decode per syntax layer (Task1/3).
- Real application saves can alter long numeric input before storage: compare to actual stored lexemes, never claim recovery of user's lost Excel precision; genuine sample and independent expected CSV required (Task1/3).
- Formula/cache/security content outside selection or unused parts must still reject; dimension and SST metadata cannot justify sparse allocation (Task2/3).
- Profile/source change, swap, old revision and mixed restore must retain immutable original identity and reject wrong profile/hash (Task4/5/6).
- Worker-exit→async hash→cancel/quota/reset races must preserve no-await final latch; service healthy and no half-import/restored batch (Task4/6).

---

## Task sequence, files and commands

New adapter modules are `workbench/xlsx/{xml,package,values,adapter,contracts}.mjs` with one responsibility each; keep archive v2 metadata in `workbench/xlsx-bundle.mjs`, UI selection in `workbench/public/xlsx-view.mjs`. No new engine op/public MoonBit interface. Tests `tests/workbench-xlsx-*.test.mjs` are automatically included by current scripts/run-unit-tests.mjs; Python oracle is `scripts/check-xlsx-oracle.py`, fixtures/metadata in `tests/fixtures/xlsx/`. Existing source files touched are named per task below.

Run commands from the sole worktree. Verified absolute Node22 and isolated SDK paths (check existence/version before execution; if drift, stop that gate and record it):

```bash
export PATH="$PWD/.verify/node/bin:$PWD/.verify/moon/bin:/usr/bin:/bin:/opt/homebrew/bin"
export MOON_HOME="$PWD/.verify/moon"
export MOONBIT_HOME="$PWD/.verify/moon"
export MOONRECONCILE_NODE_BINARY="$PWD/.verify/node/bin/node"
"$PWD/.verify/node/bin/node" --version
"$PWD/.verify/moon/bin/moon" version --all
```

Use this checkout's `.verify/node/bin/node` and `.verify/node/bin/npm`; isolate MoonBit with `.verify/moon/bin/moon` and set process-level `MOON_HOME` and `MOONBIT_HOME` to `.verify/moon`. Verified versions: Node22.23.3, npm10.9.9, Moon0.1.20260920; sanitized PATH is `$PWD/.verify/node/bin:$PWD/.verify/moon/bin:/usr/bin:/bin:/opt/homebrew/bin`. Python3.14.6 at `/opt/homebrew/bin/python3` is the development oracle only, never required in package. Logs retain real commands/process exits/source hashes, redact tokens and distinguish blocked environment gate from product failure. Never claim Node24 test as Node22 evidence.

### Task 1: XML correctness, dependency audit and genuine-sample gate

**Files:** Create `workbench/xlsx/xml.mjs`, `tests/workbench-xlsx-xml.test.mjs`, `scripts/check-xlsx-oracle.py`, `tests/fixtures/xlsx/{xml-cases.json,genuine-save-manifest.json}` and genuine synthetic `.xlsx` fixtures; modify package.json/lock, docs/dependency-audit.md and update both B plan documents. Evidence `.superpowers/sdd/2026-10-08-restricted-xlsx/evidence/task-1/`. No XLSX upload/catalog route.

**Interfaces:** `parseXmlEvents(bytes:Uint8Array,{onEvent:(XmlEvent)=>void,limits:XlsxLimits,part:string}):void`; XmlEvent exact discriminants `open {uri,local,attributes:[{uri,local,value}]}`, `text {value}`, `cdata {value}`, `close {uri,local}`. Throws sanitized adapter error, never returns partial success; namespace/source positions are parser metadata, not arbitrary local paths. Oracle CLI `python3 scripts/check-xlsx-oracle.py --xml-cases tests/fixtures/xlsx/xml-cases.json --genuine-manifest tests/fixtures/xlsx/genuine-save-manifest.json` produces PASS only after independent decoded strings/raw workbook readback and sample provenance checks. No JS parser reuse in Python.

- [x] Write the three Node regression tests first and preserve the original missing-module RED; Python ElementTree independently verifies the XML vectors. Node 22 round 1 focused suite passes 23/23 cases, retaining all original 15 assertions/cases and adding rejection of raised frozen limits, true four-byte UTF-8 splits at offsets 4093/4094/4095, supplementary numeric references, high/low surrogate rejection, and invalid/truncated UTF-8 across the feed boundary/final decoder flush. The reference split remains at byte 4095; its following emoji remains at byte 4100. RED exit 1 showed both raised-limit tests failing before the fix; logs are in `evidence/task-1/repair-round-1/` under the Task1 SDD directory.
- [x] Inspect/pin the exact candidate graph and license; `npm ls --all` and `npm audit --omit=dev --json` exited 0 with no reported production vulnerabilities. Initial Sol review conditionally accepts the archived saxes/xmlchars maintenance risk for the bounded local worker after frozen-ceiling enforcement; the round 1 fix still requires independent repair review. Lock/integrity and offline LICENSE provenance checks are implemented. This does not itself approve the candidate.
- [x] Implement `parseXmlEvents` with namespace events, UTF-8/XML declaration checks, bounded input/depth, immediate parser-error stop and no global predecode. Round 1 rejects caller `xml_bytes>67108864` or `xml_depth>64` as `invalid_xlsx` before any event; valid lower limits retain their existing `xlsx_limit_exceeded` enforcement. Focused Node tests, the independent Python oracle (6 XML vectors/5 native saves), and actual `npm run build` all exited 0; full repaired-SHA gates remain controller-owned.
- [x] Save four synthetic XLSX fixtures with isolated LibreOffice26.2.4.2 profiles and one synthetic Microsoft Excel16.113.4 workbook (build 16.113.26100421); independently verify all five with Python ElementTree/ZIP against the separate fixture-relative `genuine-save-expected.json` (not workbook XML). The Excel `docProps/app.xml` `AppVersion` is `16.0300`, distinct from the installed bundle version. Excel readback confirms `00123` and one-pass `_x000D_` CR storage; LO normalized CRLF to LF and rounded a long number before storage. Controller adopted a narrow exact LO metadata subtree plus three proven-unused Default declarations; LO1904 is a future positive inventory candidate only. LO1900 has a real table part and remains unsupported; Excel has additional extensions and remains unsupported. Native worksheet autoFilter positive evidence is still missing. These are oracle/source-storage results, not product importer evidence. The AppleScript save timed out; CUA observed save completion and the resulting disk file/hash were read back.
- [x] Task1 committed round1 repair and controller-frozen policy independently reviewed SPEC/QUALITY PASS; controller clean-head22/22 accepted d63c2d9. Task2 remains unaccepted pending its own repair review/gates. Task2 must test the exact LO metadata grammar, all malformed/unknown extensions, full formula scans, and the three unused declarations without authorizing actual font/image/table parts. Product importer status remains unproven; production XLSX stays disabled.

#### Task1-frozen metadata/content-type exception

Allow only one optional `extLst` directly under the ordinary SpreadsheetML workbook root, with no non-xmlns attributes. It must contain exactly one direct `ext`, whose only ordinary attribute is `{}uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}"`; that contains exactly one `{http://schemas.libreoffice.org/}extCalcPr` with its only ordinary attribute `{}stringRefSyntax="CalcA1ExcelA1"`, no children and no non-whitespace text. `extLst`/`ext` allow only XML whitespace between children. Match namespace URI/local name, not prefix. Reject duplicate, misplaced, extra/unknown subtree, attribute/value, or any `AlternateContent`. This metadata is inert and never bypasses all-workbook formula scanning or full package checks.

Allow only these three proven-unused `Default` declarations after complete ZIP entry inventory and effective content-type resolution: `fntdata` → `application/x-fontdata`; `jpeg` → `image/jpeg`; `png` → `image/png`. Extension names use the frozen OPC normalization rule; case differences in entry names do not create a bypass. They do not authorize matching actual entries, related/unreferenced image/font parts, aliases, duplicates/conflicts, part-specific overrides, or other Default declarations. Validate all entries and existing table/image/font guards as usual. LO1904 can be used as a future package-inventory positive candidate; LO1900's real table/filter and the Excel workbook remain unsupported. A native worksheet `autoFilter` sample is still needed. These exact amendments do not broaden the XML parser, formula support, or product capability.

Task2 tests must cover valid exact metadata (including alternate namespace prefixes and absence), malformed/duplicate/wrong-context/unknown metadata, extra attributes or content, nested formulas and `AlternateContent`; then prove metadata never bypasses the complete workbook formula scan. Test the three Default pairs as unused versus matching actual, related and unreferenced entries, Overrides, case aliases, conflicts, duplicates, and a fourth Default. All ordinary ZIP/relationship/formula guards remain mandatory. LO1904 is the inventory-positive candidate; LO1900 table-based filter and Excel extension structures remain negative. A later genuine worksheet `autoFilter` fixture is still required for positive filtered-row evidence.

### Task 2: Bounded OOXML package inventory and security rejection

**Files:** Create `workbench/xlsx/{package,contracts}.mjs`, `tests/workbench-xlsx-package.test.mjs`, `tests/fixtures/xlsx/malicious-manifest.json`; extend `scripts/check-xlsx-oracle.py` with malicious Pythonzipfile mutations. Modify `workbench/archive.mjs` only if extracting minimal proven common ZIP guards; keep exact v1 RUN_BUNDLE_FILES behavior.

**Interfaces:** `inspectXlsxPackage({assetPath:string,stagingPath:string,limits:XlsxLimits,signal?:AbortSignal}):Promise<PackageInventory>`; `PackageInventory={source:{bytes,sha256},date_system,sheets:InternalSheet[],parts:Map<string,OwnedPart>}`, InternalSheet=SheetDTO+`relationship_id,part`; OwnedPart=`{path,bytes,sha256,content_type}` paths internal-only. `disposeXlsxPackage(inventory):Promise<void>` removes only caller-owned extracted temp parts. `assertImportSpec(value:unknown,inventory:PackageInventory):ImportSpec`, `projectWorkbook(inventory,asset_id):WorkbookDTO`. Exports XLSX_LIMITS, frozen schema/error validators and no core types. All entry paths remapped to generated owned names.

- [ ] Write RED `package_follows_relations_not_sheet_filename`, `selectable_visible_worksheet_only`, `zip_actual_limits_and_metadata_checked`. Use genuine files and independent mutations: local/central mismatch, bit3 descriptor valid, CRC/truncation/forged size, duplicates/case/NFC aliases/path traversal/symlink/nonregular/overlap/encryption/method, safe inert directories counted, 2048/2049, 64MiB compressed+1, 256MiB actual+1, XML64MiB+1/depth65. Reduced limits exercise actual counters plus production constants asserted exactly; `node --test tests/workbench-xlsx-package.test.mjs` records RED.
- [ ] Implement inventory with yauzl and syntax-aware XML; use Task1-frozen explicit allowed OPC content types/relation URIs in `workbench/xlsx/contracts.mjs` against genuine samples. Tests reject missing/duplicate relationId, contained ../ internal target versus escaping/root/external/encoded target, wrong namespace/type/sheet target, bogus hash-bound sheetId, hidden/veryHidden/other selection, disguised XLS/XLSB/XLSM, vba/ActiveX/OLE/external hyperlink/data links/encrypted input and forbidden content in unused parts. Do not loosen package guards to make genuine sample pass without a recorded amendment/review of the Task1-frozen decision.
- [ ] Run Node test and oracle dangerous-fixture checks; ensure all handles close/no attacker-name writes; server-level health remains Task4. Sol security review diff, then local commit `feat: validate bounded restricted OOXML packages`. Candidate dependency/genuine-source gate stays mandatory, no endpoint activation.

### Task 3: Exact lexical conversion, profiles and core validation

**Files:** Create `workbench/xlsx/{values,adapter}.mjs`, `tests/workbench-xlsx-values.test.mjs`, `tests/workbench-xlsx-adapter.test.mjs`; extend scripts/check-xlsx-oracle.py/fixtures expected CSV and profile/error cases.

**Interfaces:** `expandDecimalLexeme(value:string,limits:XlsxLimits):string`; `decodeSpreadsheetText(value:string):string`; `excelSerialDate(value:string,dateSystem:"1900"|"1904"):string`; `convertCell(cell:StoredCell,mode:Mode,context:{date_system,number_format,limits}):{value:string,category:"blank"|"text"|"numeric_lexemes"|"booleans"|"dates"|"zero_padded_identifiers",expanded:boolean}`. StoredCell=`{coordinate,row,column,type:"blank"|"text"|"numeric"|"boolean",stored_value:string,style_index:null|integer}`; reject formulas/errors before this type. `convertXlsx({assetPath,importSpec,side,stagingPath,invoke,limits,signal}):Promise<ConvertedImport>`; ConvertedImport=`{csv_path,profile_path,adapter_manifest_path,preview}` with fixed generated outputs `<stagingPath>/canonical.csv`, `profile.json`, `adapter.json` allocated by parent, temporary parts in `<stagingPath>/parts`. CSV header is `renderCsv(headers,[])`; append each bounded row as `renderCsv([], [row]).slice(1)` using the existing encoder (remove only that empty header's LF), retaining exact LF/quoting/one-empty-column records, with total bytes counted before each append; no Node CSV parse or full unbounded rows array. Adapter invokes `callEngine(inspect_csv...)`/inspectImport for full final validation and preview.

- [ ] Write RED values/adapter tests asserting all preflight modes, date systems/serial59/60/61/fraction/negative/year bound, 9007199254740993 exact, 30digit preserved, `1.2300E+2`=`123.00`, bounded hostile exponent before allocation, zero format123+00000=`00123` and complex/fraction reject, TRUE/FALSE, text00123/Unicode/CR/LF/whitespace/shared/inline/rich/CDATA/entity preservation and OOXML escaping once. Reject incompatible mode, t=d/error/formula any cache/shared/array/dynamic outside range, duplicate coords/row-coordinate disagreement/invalid SST/styles; unordered legal rows/cells are sorted by physical coordinate without dropping blanks. Explicitly test one-column all-empty rows and whitespace-only-header rejection by existing core. Run `node --test tests/workbench-xlsx-values.test.mjs tests/workbench-xlsx-adapter.test.mjs` record RED.
- [ ] Implement values and adapter using Task2 inventory; no Number/parseFloat for cell numeric values, bounded string operations (bounded date integer arithmetic only after exact validation). Read all worksheets for forbidden features, selected ordinary visible sheet for data, selected merges reject, count outside values. Validate range before allocation, never trust dimension/SST size, enforce populated/SST bounds. Headers full exact text, hidden/filtered/empty rows retained; selected rectangle has no nonlinear row map. Produce exact canonical profile/AdapterManifest, warnings/counts/full hashes and UTF8 cell/CSV budgets, then **core full inspect**; failure leaves only owned staging for parent cleanup.
- [ ] Extend independent Python oracle CLI `--adapter-output <owned-results-directory>` to compare CSV bytes using Pythoncsv writer with matching explicit LF/quoting rules, decimal.Decimal/string oracle, datetime date oracle and ElementTree raw-cell oracle, plus hashes/profile/mapping/counts. Compare genuine stored data as stored, distinguish spreadsheet pre-storage rounding from adapter loss. Run Node pair, oracle, existing `tests/inspect.test.mjs`; Sol reviews conversions/source identity, local commit `feat: convert XLSX with explicit lossless profiles`.

### Task 4: Worker/API import integration and atomic failures

**Files:** Modify `workbench/{contracts,session,jobs,engine-host,server,worker}.mjs`; Create `tests/workbench-xlsx-server.test.mjs`, `tests/workbench-xlsx-jobs.test.mjs`. Production default remains CSV only.

**Interfaces:** Preserve `executeTask(task,{invoke,signal})`; add kind `xlsx_catalog` with payload `{asset_id}`/paths `{xlsx,staging}` → internal `{catalog_path}`; import xlsx payload `{side,import_spec}`/paths `{xlsx,csv,profile,adapter_manifest,staging}` → `{csv_path,profile_path,adapter_manifest_path,preview}`. Large manifests/catalog stay files, not unlimited IPC. `source_cell` paths from registered import and payload `{side,record,column}`→`{source_cell}`; adapter export `readSourceCell({assetPath,profilePath,canonicalCsvPath,side,record,column,invoke,stagingPath,limits}):Promise<SourceCellDTO>`. Session adds `checkImportBatch({newAssets,newImport}):void`, `commitImportBatch({newAssets,newImport}):void`, exact newAssets one canonicalCSV; only registered source allowed, quota projected precommit. `startWorkbench` construction option xlsxEnabled defaultsfalse until Task7. DTO/wire schemas exactly preflight, existing preview/cell core output unchanged.

- [ ] RED endpoint tests `csv_wire_shape_unchanged`, `xlsx_requires_exact_bound_profile`, `mixed_compare_report_equals_cli`, `xlsx_source_cell_is_revision_bound`: source originalSHA distinct canonicalSHA, source-cell shows actual stored→imported value, mixedCSV/XLSX direct CLI on canonical CSV yields same report bytes. Wrong fields/hash/sheet/mode/asset kind fail and uploads alone never imply Import readiness. Auth401/HostOrigin403/full response envelope2MiB/catalog huge fail exercised with new routes. Run Node server/jobs tests RED.
- [ ] Implement worker paths/catalog/import/projection/strict body routing and discriminated ImportDTO; original remains source asset, entry.path normalizedCSV, canonical_asset_id internal-only. Hash/profile/full inspect before candidate; parent prepares canonical asset/manifests off-registry, final valid()/generation/head/no-await commit only after child exit, fitOutput/quota. Add count-aware oneasset+oneimport batch commit; no async writes in commit. Existing Config/draft/run/review/branch consume entry.path; update their byte/hash/reservation source to normalized CSV stat/canonical asset, never compressed original size. Reservations count source/material/canonical copies separately, material disk counted.
- [ ] Failure tests `cancel_after_candidate_before_hash_never_publishes`, `quota_during_unzip_keeps_previous`, `disk_full_releases_staging`, `timeout_kills_child`, `reset_during_upload_or_child_409`: injected low limits/delayed hashing/late IPC, inspect imports/assets/heads unchanged apart from completed source upload, no normalized asset orphan, exit-before cleanup and graceful close. While malicious/long conversion runs, capabilities response<1000ms local test; follow-up CSV job succeeds after rejection. Run test pair + `npm run test:workbench` + oracle. Sol independent P0/security review, local commit `feat: integrate atomic restricted XLSX jobs`.

### Task 5: Explicit worksheet/range/mode UI and source explanation

**Files:** Create `workbench/public/xlsx-view.mjs`, `tests/workbench-xlsx-ui.test.mjs`, `tests/e2e/xlsx.spec.mjs`; Modify `workbench/public/{import-view,result-view,app,state}.mjs`, `workbench/public/index.html`, `workbench/public/styles.css` and `workbench/server.mjs` static whitelist. Retain current String escape/config/idle fixes.

**Interfaces:** `renderXlsxSelection({root,api,asset,side,onConfirmed:(ImportSpec)=>Promise<void>,onCancel:()=>void}):{dispose:()=>void}`; catalog starts job, shows visible sheet select with no default, named range integer inputs, per-column mode select with no default and confirmation. Explicitly confirm range/modes before `/api/imports`; after conversion, display warnings/counts via completed manifest export and ask binding confirmation before replacing current source. Declining leaves old UI source/report and retains the new unused ready import until session reset (no implicit destructive cleanup); user can revise profile/reimport. Add no draft/semantic guessing. `renderImportView` continues `{dispose,bindRevision,clear}`; saved per-side source keeps `{asset,import,profile,preview}` so swap reuses each original XLSX+profile with opposite side and full validation, CSV old shape unchanged. Revision/source changes use existing generation/stale semantics.

- [ ] RED model/browser tests explicit selection required, hidden/other disabled, range bounds/modes enumerated, workbook-hash replacement invalidates profile; hidden/filter/outside warnings visible; blank rows record mapping shown; stored_text numeric date not auto date; formula rejection physicalsheet/A1 position; CSV logical error label unchanged. Actual UI .xlsx drag/select only enabled in B test-host constructor, no fake placeholder success. Run Node UI + targeted Playwright test with test-only enabled server.
- [ ] Implement xlsx-view safe textContent DOM/exact API flows, sourceSHA and canonicalSHA separately, “导入后的原值” and stored→imported details through full source-cell job. Source-changing attempts/failed swap retain old current selection/report; explicit reimport success invalidates config/decisions as current CSV does. Use existing keyboard labels/dialogs, paging/full-value behavior and no token storage/network calls. app/index labels remain CSV-only until capability says xlsx.
- [ ] Run genuine saved mixed form→core compare→review→source detail E2E, malformed formula rejection, 390px/keyboard/HTML Unicode safety, swap/profile/source-old-report cases; `npm run test:workbench` and original full browser suite. Sol UI/contracts review, local commit `feat: add explicit restricted XLSX selection and provenance UI`.

### Task 6: Versioned materials bundle and verified mixed restore

**Files:** Create `workbench/xlsx-bundle.mjs`, `tests/workbench-xlsx-bundle.test.mjs`; Modify `workbench/archive.mjs`, `workbench/engine-host.mjs`, `workbench/server.mjs`, `workbench/session.mjs`, `tests/e2e/xlsx.spec.mjs`; extend `scripts/check-xlsx-oracle.py` bundle inventory/mutations.

**Interfaces:** Extend `writeRunBundle({runPath,sidecar,destPath,limits,importMaterials?:ImportMaterials})`; `readRunBundle(...)` returns original `{runPath,sidecar}` for v1, adds `importMaterials` only v2. `ImportMaterials={manifestPath,sides:[{side,format,sourcePath?,profilePath?,adapterManifestPath?}]}` internal owned paths, shape discriminated. `validateImportBundleManifest(value,sidecar):ImportBundleManifest`; `verifyAndRegenerateImports({runPath,materials,stagingPath,invoke,limits,signal}):Promise<{left:RestoredSide,right:RestoredSide}>`, RestoredSide=`{format,source_path,csv_path,profile_path:null|string,adapter_manifest_path:null|string,preview}`. Return internal normalized files; parent checkRestoreCapacity/commitRestored now exact format-aware3/4/5assets and2imports per preflight, not weakened arbitrary-length array. Revision/config/head/public DTO remain unchanged.

- [ ] RED `csv_bundle_remains_exact12`, `mixed_bundle_exact16`, `two_xlsx_bundle_exact19`, `restored_import_retains_xlsx_source`, `v2_reconversion_before_core_replay`. Independent Pythonzipfile confirms inventory/hash/profile rows; assert no manifestv1 extension/no row-map. Preserve A+C v1 fixtures and acceptanceZIP immutably; both version readers reject unknown versions/material paths/missing/duplicate/case/NFC entries.
- [ ] Implement exact version discriminator/allowlists and material metadata, bundle reservation bytes/asset counts. v2 original hash/profile schema/adapter version→reconvert→canonicalCSV and derived AdapterManifest equality→CLIresolve/report bytes→atomic fresh imports/config/revision. Test altered source/profile/date system/adapter/counts/mapping/warnings with internally consistent outer hashes: wrongCSV fails xlsx_conversion_mismatch; forged core report still replay_mismatch. Restore v1 unchanged core replay; three/four/fiveasset capacity ownership/hash/head check before no-await commit. Tampered data never registers.
- [ ] Test cancel during reconversion/after hashes, partial right failure after left success, asset/import quota boundary and double-restores: no half-batch/late publication, old report/head/source materials intact. Actual browser mixed download/reset/restore/source-cell/decision reimport and branch yield matching canonicalCSV/core reports with fresh IDs; reconstructed source bytes equal originals. Run Node bundle + original archive/review/jobs + full workbench/E2E + independent oracle. Sol bundle/sourceidentity/P0 review; local commit `feat: restore versioned XLSX materials with verified regeneration`.

### Task 7: Offline package, full B gate and capability activation

**Files:** Modify `scripts/{package-workbench,check-workbench-package,workbench-package-provenance}.mjs`, `tests/{workbench-package,workbench-package-validation}.test.mjs`, `docs/{dependency-audit,workbench,workbench-start-here,limitations}.md`, `README.md`, `.github/workflows/ci.yml`, `workbench/public/import-view.mjs`/`workbench/server.mjs` only for final activation; create `docs/evidence/xlsx-validation-2026-10-08.md`. Keep original A+C evidenceZIP/hash receipts. No release/push.

**Interfaces:** Existing buildInputs/sourceInputs/EXPECTED/packageContract/source-at-HEAD/provenance/license verifier now include exact adopted parser tree+all B modules; build provenance genuinely regenerated (provenance script is a build input). Existing strict checker adds genuine mixed import/source-detail/bundle-regeneration/CLI equivalence and rejected formula gates under network isolation; only package runtime Node, no npm/moon/python/LibreOffice. It accepts CSV+XLSX capabilities **only after full B activation**, never a partial claim. Source app/package version remains0.2.0; independent B versions pinned. Audited third-party notices carry both parser/transitive licenses; development samples/browser/Python never become runtime requirements.

- [ ] RED package tests assert copied B modules/exact locked production parser/licenses, no dev/absolute-path/symlink leakage, clean-source/head/proof/hash checks unchanged; independent altered-module/lock/manifest/license/ZIP tests must fail. Preserve strict checker's expectation that ordinary preactivation default startup is CSV-only; its B end-to-end path executes only after activation. B flow before activation is proved only through internal xlsxEnabled test hosts, never counted as a passing strict B package gate. Commit reviewed packaging+guide change before strict source-at-HEAD gate. Build with isolated SDK, package fresh owned output; don't overwrite accepted immutable A+C evidence.
- [ ] Run **all** NodeXML/package/value/adapter/API/jobs/UI/bundle tests, Python independent/genuine oracle, full existing gates: `moon check --target js`, `moon test --target js`, `moon info`, `moon fmt`, `moon fmt --check`, `npm test`, `npm run test:workbench`, `npm run test:workbench:e2e`, `python3 scripts/check-assignment-oracle.py`, `python3 scripts/check-library-consumer.py`, `npm run test:workflows`, `npm run test:public-data`, `node scripts/readme-smoke.mjs`, `node --test tests/workbench-package.test.mjs tests/workbench-package-validation.test.mjs`. Moon source/.mbti must have no unexplained B change. Final fresh Solhigh review from Task1 base `22fa85a01460723c3823f66bb4ae098e428bbacf` through candidateSHA checks complete B/preflight coverage and any residual failures; historical accepted A+C SHA `607d1736` stays baseline evidence. Fix and rerun affected/full gates as warranted. No all-gates-pass claim while genuine/oracle/dependency/security gate is blocked.
- [ ] Only after above complete, Sol integration changes xlsxEnabled default to true and publishes exact capabilities/import picker, updating strict checker to require the real B closure; the explicit activation commit is `feat: enable fully verified restricted XLSX imports`. This commit is a gate candidate, not accepted delivery. Re-run full gate on that clean activation SHA, `npm run build`, `npm run package:workbench`, `npm run test:workbench:package` with real Node22/external-deny+loopback-allow positive/negative controls, no SDK/npm/Python PATH. SourceZIP/provenance/HEAD/source tree/bridge/parser licenses/file graph all match. Existing checker must produce passed only after childexit/ownedcleanup/sourcefinalcheck; same freshly produced ZIP used for actual relocated browser from genuine synthetic XLSX+CSV, explicit range/modes→Config form→compare/review→download/reset/restore→stored-value details/coreCLI bytes. Gate reports entryexit0/graceful/TMPempty scope honestly; private driver may use dev Playwright but service/worker/core load from relocated package. Store hashes/screenshots/commands/real exits, no token/raw sensitive data.
- [ ] Final Solhigh scope audit runs against **activationSHA plus final evidence**, not just preactivation. If final integration gate fails, B is NOT ACCEPTED; withdraw advertised support in a corrective local commit and do not ship partial capability. Review exact diff and no unreviewed dirty source; freeze accepted B source/ZIP/bridge/dependency/evidence hashes. This step records acceptance of the already committed activation SHA; it does not create an empty duplicate activation commit. Any real fix creates a new reviewed SHA, then reruns affected/final gates and package provenance. Local acceptance only; remoteCI/Linux namespaces/realuserbenefit/competition unverified. No push/merge/release/registration/globaltoolchain; failed intermediate commits/logs retained, not called delivery.

## Self-review coverage and Task 1 startup

| Binding requirement / risk | Owner / check |
| --- | --- |
| Frozen P0/full response budget/auth/cancel/quota/head/owned cleanup | T4/T6/T7 race/API/full regression gates |
| §8 lexical XML singledecode/three rejected counterexamples/CDATA/rich/SST | T1 first RED+ElementTree; T3 full converter/oracle |
| Explicit visible worksheet/range/modes/blank-hidden-filter/outside/header | T2/T3 package/profile, T5 real UI |
| Numeric lexemes/bounded exponent/zero padding/1900-1904/60/fraction/bool | T3 exact vectors+Python independent+genuine saves |
| MaliciousZIP/XML/relations/macros/OLE/ActiveX/external/encryption/sparse/SST/duplicate/formulas/cache | T2 inventory/mutations + T3 full workbook rejection + T4 survival |
| Raw original/profile/manifest/rowmapping/warnings/counts/hashes outside manifestv1 | T3 canonical materials; T4 source identity; T6 bundle graph |
| CSV/XLSX mixed/oldCSV12/versioned16-19/restore regeneration/core replay | T4 CLIbytes; T6 oracle/tamper/atomicrestore; T7 relocatedsameZIP |
| Pinned audited candidate/realNode22/licenses/offline source provenance | T1 hard gate; T7 cleanSHA/pkg/full finalSolhigh |
| No placeholder/public capability before complete scope gate | T4/5 constructor-only; T7 reviewed activation and repeat gate |

Task1 evidence status: ACCEPTED LOCAL d63c2d9 after initial candidate d87373fe, metadata follow-up01e40ff and repair round1. Independent repair review SPEC/QUALITY PASS and controller clean-head22/22 plus independent oracle6XML/5native accepted only Task1 scope; historical failed/candidate logs remain retained. Task2 bb0481b7 initial review SPEC/QUALITY FAIL; sole repair round1/2 in progress. Native sixth source74dbde now preserved for approved ref-only/emptydrawing/staticFilterDatabase inventory tests, while Task3 conversion/UI/restore/activation proof is still outstanding. Tasks3–7 remain PLANNED / NOT IMPLEMENTED; production CSV-only.

## Review-cycle limit

For each implementation scope, record exact base/head, reviewer finding, cycle number, repair, and disposition in the ignored governance ledger. One cycle is one implementation repair followed by one independent review. Allow at most two such cycles; if the second review still has an unresolved finding, stop implementation and report the evidence with concrete decision options. Do not restart the counter by splitting a scope or editing the ledger history. Keep failed logs and historical artifact names intact.

Historical Task1 startup brief (retained snapshot; superseded by Task1 acceptance and current Task2 repair):

> Task1-only implementation started from base `22fa85a01460723c3823f66bb4ae098e428bbacf`, candidate `d87373fe2ea382a9476e7841b46d3e760db38b2d` and policy follow-up `01e40ffd0e44f0350388b7b6d504e03ae4a5bf7d`; historical A+C acceptance at `607d1736` stays preserved. Initial Sol review failed F1 raised XML ceilings/F2 missing UTF-8 and surrogate regressions despite controller 22/22 on 01e40ff. Round 1/2 repairs now reject above-ceiling configuration before callbacks and provide XML 23/23 plus independent oracle/build exit 0, with exact SHA/logs in the ignored repair report. Do not reset the two-round cap or claim Task1 acceptance; independent repair review and repaired-SHA controller gates remain pending. No Task2 code, route or public capability is present. Retain the exact LO metadata/unused Default policy, all formula/package guards, unsupported LO1900 tables/Excel extensions and native worksheet autoFilter evidence gap. Production XLSX remains disabled.


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
