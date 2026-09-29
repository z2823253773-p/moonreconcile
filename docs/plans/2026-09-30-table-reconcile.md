# MoonReconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publicly deliver a reproducible CSV reconciliation CLI and reusable MoonBit engine covering configuration, exact correspondence, explained field comparison, candidate suggestions, human review import, and final reports.

**Architecture:** MoonBit owns CSV semantics, validation, transformations, exact decimal/date comparison, keys, candidate generation, Hungarian assignment, decision validation, and report data. A thin Node.js adapter owns byte decoding, filesystem transactions, SHA-256 manifests, CLI arguments, and serialization of engine-produced report data. Target MoonBit JavaScript first; publish a source repository with an executable Node CLI and runnable examples.

**Tech Stack:** Installed MoonBit 0.1.20260713 / moonc v0.10.4+2cc641edf (verify actual build metadata), MoonBit JS target, Node.js >=22, Node built-in test runner, GitHub Actions; no mandatory Python runtime. Evaluate NyaCSV before choosing an actual CSV parser dependency.

**Spec:** `docs/spec.md` in this repository (copied verbatim from the approved design; authoritative). Repository plan: `docs/plans/2026-09-30-table-reconcile.md`; the parent workspace plan is a synchronized reference copy.

## Global Constraints

- New repository only: `moonreconcile/`; never edit the sibling `moontick/` project or create a Git repository at their parent.
- User has authorized execution by GPT6-Luna, planning/review by GPT6-Astra, and GitHub publication. No further plan approval is required.
- Implement the full `导入 → 列映射与规则配置 → 记录对应 → 字段差异解释 → 人工复核 → 最终报告导出` loop.
- `首个完整版本中，所有候选分配均需人工接受；只有满足唯一键契约的对应自动成立。`
- `不自动猜测类型、货币、日期格式、主键或 Unicode 规范化方式。原值始终保留。`
- Decimal input: at most 64 digits and 18 fractional digits, optional sign, integer and optional fractional part; no scientific notation/currency/grouping; exact intermediate arithmetic.
- Input budgets: 64 MiB/file, 100000 data logical records/file, 256 columns, 64 KiB UTF-8/cell. Candidate budget 100000 unique pairs. Component limit 100 rows/side. Edit fields 512 codepoints and 20000000 DP cells cumulatively.
- `记录状态为 paired、unmatched、pending_review、unprocessed` and field status `equal、equivalent_by_rule、different、invalid_value`.
- Per-side conservation: paired + unmatched + pending_review + unprocessed = input count; candidates never count as paired.
- Exit priority `2 > 3 > 1 > 0`: validation/I/O; budget incomplete; complete with issues/unresolved; complete with no issues.
- Real workflow evidence is absent. Label all three bundled workflows synthetic; publish no personal or clinical data. Do not claim accuracy, saved labor, contest acceptance, or real-user validation.
- CSV-only entry is conditional on actual workflow compatibility. No XLSX promise or formula recalculation; record this unvalidated constraint.
- Current official requirements must be verified by the coordinating agent; do not import older contest requirements from memory.

## Review Focus

1. CSV quoted newlines, CRLF, BOM, malformed closing quotes, invalid UTF-8, and trailing empty cells must retain logical record identity and reject bad syntax (Task 1).
2. Positive/negative 64-digit decimals, scale differences, zero, tolerance equality, calendar leap boundaries, and common missing fields must not produce false correspondence (Tasks 2 and 4).
3. Candidate/component resource limits must never turn a truncated graph into a successful final result; manually resolving rows must retain incomplete computation history (Tasks 4 and 5).
4. Decision endpoint conflicts, stale/tampered snapshots/configuration, deleted original files, and repeated imports must be all-or-nothing and reproducible (Tasks 5 and 6).
5. Disk/write failure, nonempty output directories, delimiter-containing identifiers, and deterministic iteration order must preserve originals and avoid ambiguous or apparently successful artifacts (Tasks 3 and 6).

---

## Locked interfaces and file map

All paths below are relative to the new repository. Keep one root MoonBit library package initially, split responsibility into files; do not introduce package dependency cycles. A small `cmd/bridge` MoonBit executable/export module imports the library. Probe the actual JS export mechanism before fixing generated filenames; the stable Node-facing API is `invoke(requestJson: string): string`, a pure JSON-in/JSON-out function. If the installed compiler cannot export it directly, use a generated wrapper around one MoonBit-exported string function, not a host reimplementation of the engine.

Files:

- `moon.mod`, `moon.pkg`: reusable library metadata/imports.
- `model.mbt`, `config.mbt`, `csv.mbt`: model, strict config/input contracts.
- `decimal.mbt`, `date.mbt`, `rules.mbt`: exact rules and explanations.
- `exact.mbt`, `candidates.mbt`, `assignment.mbt`: correspondence and candidate graph.
- `decisions.mbt`, `report.mbt`, `engine.mbt`: validated decisions, final state, dispatch.
- Matching `*_wbtest.mbt`: package tests and independent assignment oracle.
- `cmd/bridge/main.mbt`, `cmd/bridge/moon.pkg`: bridge exports only.
- `cli/main.mjs`, `cli/io.mjs`, `cli/render.mjs`, `cli/bridge.mjs`: args, I/O/hash transaction, CSV/Markdown rendering, generated bridge loading.
- `scripts/build.mjs`: build bridge into deterministic ignored build output.
- `tests/cli.test.mjs`, `tests/oracle.test.mjs`, `tests/fixtures/`: integration checks and independent reference cases.
- `examples/{orders,migration,catalog}/`: synthetic left/right CSV, rules, review decisions, scenario README.
- `docs/{configuration,review-workflow,architecture,validation,project-proposal,limitations,dependency-audit}.md`, `README.md`, `LICENSE`, `.github/workflows/ci.yml`, `.gitignore`, `package.json`.

### JSON protocol v1

The wire protocol is the authoritative cross-task integration boundary. Inner MoonBit types may be idiomatic algebraic types; no host algorithm may fill missing engine semantics.

Request operation shapes:

- `{"op":"init_config","left_csv":string,"right_csv":string}` → `{"ok":true,"config":Config}` with draft fields whose `type` is `null`, plus `draft:true`; no inferred types or keys. The draft is intentionally not executable until edited (`check_config` rejects `draft:true` or null types). Suggest source-column mapping only where exact header names agree, leaving other sources null; this is a visible template, never automatic matching.
- `{"op":"check_config","config":Config}` → `{"ok":true,"config":Config}`; canonical normalized defaults returned.
- `{"op":"compare","left_csv":string,"right_csv":string,"config":Config}` → `{"ok":true,"config":Config,"result":Result}`.
- `{"op":"resolve","left_csv":string,"right_csv":string,"config":Config,"decisions_csv":string}` → same output; recompute original algorithm and apply the full cumulative decision table atomically. The host verifies run fingerprints first. An original candidate stage limited by resources remains `computation.status:"incomplete"` after human decisions cover every row, and exit code remains 3; human coverage never retroactively proves algorithm completion.
- Any error → `{"ok":false,"error":{"code":string,"message":string,"phase":string,"side":string|null,"record":integer|null,"field":string|null}}`. Validation failure is not a successful result with empty rows.

Config v1 (reject unknown properties and malformed/noninteger settings):

```json
{
  "schema_version": 1,
  "fields": [
    {"name":"order_id","left":"Order ID","right":"id","type":"text",
     "compare":true,"trim_ascii":false,"lower_ascii":false,
     "left_values":{},"right_values":{},"missing":[],
     "both_missing":"equal","abs_tol":"0","rel_tol":"0","days_tol":0}
  ],
  "key":["order_id"],
  "ignore_left":[],"ignore_right":[],
  "candidates":null
}
```

- Field `type`: `text|decimal|date`; source columns/name unique; a source column may map to only one logical field. Fields can be identity-only with `compare:false`.
- Transform order: ASCII trim → ASCII lowercase → per-side single finite value-map lookup → explicit missing-marker lookup → type parse. Preserve raw, transformed and canonical values. Validate transforms/maps as strings; one map lookup, never chain mappings. Missing marker defaults to none; empty text remains legitimate content.
- Both missing policy: `equal|issue`; `issue` yields `different` with explanation `both_missing_requires_review`. One missing yields `different`. Empty or missing on either side always identity score zero.
- Text abs/rel/date tolerances must be default; date abs/rel tolerances default; decimal days tolerance default. Reject irrelevant nondefault options rather than silently ignoring them.
- `key` default empty; field names must exist. Canonical typed, transformed, nonmissing and nonempty key components use unambiguous JSON-array encoding, never delimiter concatenation. Empty transformed text is valid content by default but cannot prove identity: diagnose an empty key and keep the row for review, even when empty is not an explicit missing marker.
- `candidates` when enabled: `{"fields":[{"field":"name","metric":"edit","weight":1}],"threshold":7000,"blocking":[["brand"]]}`. Metrics `exact|edit|decimal|date` must match referenced field type (exact/edit text). Weights 1..10000 and threshold 1..10000. `blocking` is OR of AND field-name lists; empty outer list means all-pairs; empty inner lists rejected.
- Initial fixed budgets are engine constants, not user-configurable production options. Internal test entry points may inject smaller limits; do not expose silent budget expansion.

`Result` always contains `schema_version:1`, `engine_version`, `computation:{status:"complete"|"incomplete", issues:[]}`, `records`, `pairs`, `fields`, `candidates`, `decisions`, `structure`, `key_issues`, `summary`, and `exit_code`.

- Record IDs `L1`, `R1` use data logical record number, starting at 1. `records` entries: `{id,side,record,status,reason}`; stable left-record then right-record order.
- Pairs: `{left_id,right_id,source:"exact_key"|"human_review",reason,override:boolean}`.
- Fields: `{left_id,right_id,field,type,left_raw,right_raw,left_transformed,right_transformed,left_canonical,right_canonical,status,rules:[],difference:null|string,tolerance:null|string,explanation}`. Decimal signed difference is left-minus-right; date signed difference is left-minus-right days. Threshold/difference also saved on rule equivalence.
- Candidates: `{left_id,right_id,score:null|integer,field_scores:[],diagnostics:[],suggested:boolean,component_id}`. Invalid-type score remains null. Include competing qualifying candidates, never only chosen assignments.
- Structure `{unmapped_left:[],unmapped_right:[],ignored_left:[],ignored_right:[]}`. Each declared ignored column must exist and cannot also be mapped.
- Summary includes per-side `{total,paired,unmatched,pending_review,unprocessed}`, field counts by status, structural/key issue counts, candidate count, and unresolved count. `unmatched` remains a reportable business issue.
- Stable sorting uses record integers/field declaration order, never incidental map enumeration. No clocks/random IDs in engine semantic result.

Decision CSV schema exactly `action,left_id,right_id,reason`. Supported actions `accept,reject,left_unmatched,right_unmatched`; empty action is unfinished review and ignored. `accept` requires both IDs; side-unmatched requires only its own side ID; reject requires both IDs. A manual accept outside the threshold-qualified candidates requires nonblank reason and `override:true`. Core validates all decisions before changing any state.

Run directory files: `manifest.json`, `input/left.csv`, `input/right.csv`, `config.json`, `report.json`, `pairs.csv`, `fields.csv`, `candidates.csv`, `decisions.csv`, `unresolved.csv`, `summary.md`. Manifest v1 contains `run_id`, `engine_version`, normalized-config SHA-256, both input SHA-256 and byte sizes, provenance string, optional created timestamp. Run ID is lowercase SHA-256 hex of UTF-8 JSON serialization of the array `[engine_version,left_sha256,right_sha256,config_sha256]`; each hash is lowercase 64-character SHA-256 hex. Canonical config bytes use recursive object-key sorting, stable array order, no indentation, UTF-8 and one final newline, implemented by the host strictly as serialization of the core-returned normalized config. A reviewed run additionally records parent run ID and decision-file hash. SHA verification covers immutable snapshots, normalized config, engine version and run ID; it never relies solely on report.json. SHA hashes are stale-material checks, not adversarial authentication. Snapshots/config/result are read-only inputs on resolve; manifest and output files are not a cryptographic authentication claim.

## Task 1: Prove the runtime bridge and strict import/configuration contract

**Files:** module/package/bridge/build setup, `model.mbt`, `config.mbt`, `csv.mbt`, `engine.mbt`, their tests, `docs/dependency-audit.md`, minimal `package.json`, `.gitignore`.

**Interfaces:** Produces public `invoke(request_json : String) -> String`; dispatch init/check operations now, compare/resolve explicit unsupported errors until implemented. Internal `parse_csv(text : String, side : String) -> Result[Table, EngineError]`, `parse_config(json : Json) -> Result[Config, EngineError]`, and `normalize_config(config : Config) -> Json`.

- [ ] Write failing bridge smoke test asserting valid JSON `{op:"check_config",config:{schema_version:1,fields:[]}}` returns a structured config error, and malformed JSON returns a structured error rather than process crash.
- [ ] Run `npm test -- --test-name-pattern=bridge` (or exact Node test command once script exists); record the expected missing implementation failure.
- [ ] Probe current MoonBit JS exports in a temporary isolated file and NyaCSV with quoted CRLF, empty trailing cells, quotes inside unquoted fields, duplicate header, blank header, logical record reporting, and final newline. Save exact dependency version, commands and outcomes in dependency audit. Reuse only if the contract can be enforced; otherwise implement a small strict state-machine parser and explain the failed contract, without adding unused dependencies.
- [ ] Implement build and bridge plus strict CSV/header/row-width validation and normalized configuration. Accept an initial UTF-8 BOM only at file start. Blank interior CSV records must conform to row width; final record separator alone adds no data record.
- [ ] Add tests: `quoted_newline_uses_one_record`, `crlf_and_trailing_empty_preserved`, `illegal_quote_rejected`, `duplicate_or_blank_header_rejected`, `unequal_width_reports_record`, `duplicate_mapping_rejected`, `unknown_rule_rejected`, `init_draft_does_not_infer_key_or_type`. Assert leading-zero raw values survive unchanged.
- [ ] Run `moon test --target js` and bridge tests; confirm all pass. Commit the independently runnable import/configuration milestone.

## Task 2: Exact business field rules and explainable comparison

**Files:** `decimal.mbt`, `date.mbt`, `rules.mbt` and focused tests.

**Interfaces:** Consumes `FieldConfig`. Produces `normalize_value(raw : String, field : FieldConfig, side : String) -> NormalizedValue`, `compare_field(left : String, right : String, field : FieldConfig) -> FieldComparison`; internal arbitrary-length decimal sign/digits/scale operations with no binary floating point.

- [ ] Write failing tests for `compare_field("100.00","100",decimal)` → `equivalent_by_rule`; `001` vs `1` text → `different`; `-0.01` vs `0.01` with abs tolerance `0.02` → equivalent, signed difference `-0.02`, threshold `0.02`; same with tolerance `0.019` → different.
- [ ] Run targeted MoonBit tests and capture expected failures.
- [ ] Implement decimal canonicalization, exact add/subtract/multiply/compare, strict Gregorian day indexing, transforms, missing semantics and explanations. Relative-threshold multiplication may exceed 64 digits/18 scale internally and must remain exact. `equal` requires valid values with identical raw strings; invalid identical strings remain `invalid_value`.
- [ ] Add tests `max_digits_exact`, `negative_relative_tolerance_rejected`, `relative_boundary_exact`, `science_notation_invalid`, `leap_2000_valid_1900_invalid`, `date_day_boundary`, `mapping_is_single_lookup`, `empty_not_missing_by_default`, `zero_not_missing`, `both_missing_issue`. Two invalid/missing values never generate positive identity evidence.
- [ ] Run `moon test --target js`; cross-check decimal expected values with fixed independently generated golden cases using Python Decimal only in development if available. Commit rules milestone.

## Task 3: Exact correspondence, structure report and record accounting

**Files:** `exact.mbt`, `report.mbt`, `engine.mbt` and tests.

**Interfaces:** Consumes Table/Config/field rules. Produces `compare_tables(left : Table, right : Table, config : Config) -> ReconciliationResult` and `result_to_json(result : ReconciliationResult) -> Json`; later candidate/decision modules extend this result without changing the wire contract.

- [ ] Write failing test with reordered/renamed columns and a two-part key: one unique match, a duplicate-key group, a missing-key row, one unmapped column and one explicitly ignored column. Assert only unique complete keys pair and all counts conserve.
- [ ] Run targeted tests and confirm intended missing-engine failure.
- [ ] Implement canonical composite-key indexing with per-side multiplicity counts, mandatory column checks, structural/key diagnostics, exact pair field comparisons, remaining pending records, summaries and exit precedence. Duplicate/missing key records remain diagnosable even if later human paired.
- [ ] Add `delimiter_key_collision_impossible`, `no_key_all_pending`, `all_exact_needs_no_candidates`, `invalid_typed_key_not_paired`, `empty_text_key_not_paired_even_without_missing_marker`, `all_rule_equivalent_exit_zero`, `unmapped_column_exit_one`, and per-side conservation assertions. A lone one-sided record is pending, never automatically unmatched.
- [ ] Run `moon test --target js`; commit exact reconciliation milestone.

## Task 4: Budgeted candidate graph and maximum-weight partial matching

**Files:** `candidates.mbt`, `assignment.mbt`, tests, `tests/oracle.test.mjs` if needed.

**Interfaces:** Consumes unmatched remaining Table rows and Config. Produces `generate_candidates(left_remaining : Array[Record], right_remaining : Array[Record], config : Config, budget : Budget) -> CandidateStage`; `solve_assignment(left_count : Int, right_count : Int, edges : Array[WeightedEdge]) -> Array[PairIndex]`. `CandidateStage` preserves coverage/resource issues and component statuses.

- [ ] Write failing tests for all-pairs/no blocking; OR-of-AND blocking deduplication; weighted fixed denominator; Unicode-codepoint edit similarity; empty/missing identity score zero. Example weights 1/3 and scores 10000/0 must yield 2500.
- [ ] Run targeted tests, confirming missing candidate behavior.
- [ ] Implement preflight unique-pair budget detection and union graph construction, safe cost estimates and codepoint Levenshtein scoring. Build stable connected components of threshold-qualified scored edges, then enforce component side limits before assignment. When scoring itself is unavailable, conservatively mark the affected connected component of the pre-score candidate-pair graph unprocessed (and explain this coverage limitation); do not incorrectly apply the 100-per-side solver limit before threshold filtering. If pair budget exceeds, discard incomplete candidate phase data and retain exact results with remaining `unprocessed`. If an expensive edge/component cannot be fully scored, mark the affected component unprocessed; never solve on a graph with that edge silently removed.
- [ ] Implement Hungarian maximum weight partial matching using virtual unmatched nodes and prohibited low-threshold/invalid edges. Preflight integer bounds; ties are deterministically resolved but reported only as suggestions.
- [ ] Add independent exhaustive partial-matching oracle for deterministic small graphs up to 4x4, plus `greedy_fails` edges (L1-R1=9000,L1-R2=8000,L2-R1=8000 gives total 16000), disconnected graphs, no eligible edges, unequal side sizes, tied weights, and threshold exclusion. Compare total weight and valid one-to-one selection, not a tied exact pair identity.
- [ ] Add budget boundary tests using injectable internal Budget: exact limit succeeds, limit+1 yields incomplete; 513 codepoints; missing blocking values remain pending; costly component never partially solves. Candidate output retains competitors and every suggestion remains `pending_review`.
- [ ] Run full MoonBit and oracle tests; commit candidate milestone.

## Task 5: Atomic human review and replay

**Files:** `decisions.mbt`, updates to `report.mbt` and `engine.mbt`, tests.

**Interfaces:** `parse_decisions(csv : String) -> Result[Array[Decision], EngineError]`; `apply_decisions(base : ReconciliationResult, decisions : Array[Decision], left : Table, right : Table, config : Config) -> Result[ReconciliationResult, EngineError]`. `resolve` rebuilds base from original snapshots with the same engine and config, then applies full cumulative decisions once.

- [ ] Write failing tests for acceptance preserving field differences; rejecting a candidate keeping rows pending; side-unmatched yielding unmatched plus exit 1; exact-key endpoints being locked.
- [ ] Run tests and confirm intended failure.
- [ ] Implement whole-batch validation, exact duplicate deduplication, contradictory decision rejection, cumulative replay, explicit noncandidate overrides with reasons, and unused endpoints handling. Unknown or malformed decision actions are errors; empty action means no decision.
- [ ] Add `conflict_rejects_entire_batch`, `accept_and_reject_conflict`, `two_accepts_same_endpoint_conflict`, `accept_and_unmatched_conflict`, `manual_override_needs_reason`, `identical_repeat_idempotent`, `decision_order_semantics_stable`, `blank_rows_pending`, `resource_limited_manual_pair_keeps_incomplete_history`. Ensure field report is recomputed for every accepted human pair.
- [ ] Run full core tests and compare semantic JSON after reordered identical cumulative decisions; commit review milestone.

## Task 6: CLI, immutable snapshots, fingerprints and usable exports

**Files:** `cli/*.mjs`, `scripts/build.mjs`, `tests/cli.test.mjs`, package scripts and integration fixtures.

**Interfaces:** Exactly `reconcile init-config LEFT RIGHT --out CONFIG`, `reconcile check-config CONFIG`, `reconcile compare LEFT RIGHT --config CONFIG --out RUN`, `reconcile resolve RUN --decisions CSV --out REVIEWED`. Host calls `invoke` only for business semantics.

- [ ] Write failing end-to-end test using temporary synthetic inputs: compare → edit decisions → delete original paths → resolve → inspect matching JSON/CSV/Markdown and exit codes. Assert originals unchanged and exact byte snapshots.
- [ ] Run `node --test tests/cli.test.mjs`; capture expected failure.
- [ ] Implement strict argument parsing; fatal UTF-8 decoder; file/cell/input budgets at appropriate layers; disk availability precheck using Node statfs where supported; write failure handling; output directory must be absent or empty. Build every output in a sibling temporary directory, publish only after successful flush/close, and remove only tool-owned temporary outputs on failure. Do not overwrite a nonempty directory or input paths.
- [ ] Implement SHA-256 on raw snapshot bytes and canonical normalized config bytes; manifest engine version/run ID validation; resolve checks all before engine invocation and never requires original paths. Reject unsupported engine version rather than silently use changed algorithms.
- [ ] Implement deterministic CSV escaping and Markdown escaping/summary from core data. Decision template contains blank actions for suggested pairs plus pending side rows, never prefilled accept actions. Machine JSON contains all source evidence; final outputs keep unresolved records and computation history visible.
- [ ] Add CLI tests for invalid UTF-8, 64 MiB boundary via bounded fixtures or injectable I/O budget, nonempty output rejection, same input/output protection, simulated write failure, tampered snapshot/config/version/run ID, malformed decisions, exit priority, multiline fields, non-ASCII paths, and two resolve runs with identical semantic results.
- [ ] Run `npm run build`, `moon test --target js`, `node --test tests/*.test.mjs`; commit runnable CLI milestone.

## Task 7: Three complete workflows, comparison baseline and measured scale

**Files:** three examples, `scripts/benchmark.mjs`, `docs/validation.md`, `docs/limitations.md`, `docs/dependency-audit.md`.

**Interfaces:** Uses shipped CLI exactly; no special example-only algorithm paths.

- [ ] Add executable workflow assertions for orders (unique IDs, statuses, amount/date differences and missed row), migration (renamed/unmapped/ignored columns, duplicate/missing keys and allowed conversions), catalog (different IDs, candidates, competing products, manual accepted/negative decisions). Each includes original inputs, rules, reviewed CSV, commands and expected semantic counts.
- [ ] Run examples before filling fixture expectations; require expected fields and pending states to demonstrate meaningful failure until fixtures/implementation align.
- [ ] Finish fixtures labeled synthetic, then run each compare→resolve chain and verify full JSON/CSV/Markdown outputs and conservation. Do not commit generated input snapshots from any personal paths.
- [ ] Implement deterministic benchmark generation: 1000 and 10000 exact-key rows, plus sparse and dense candidate workloads within/over configured limits. Record machine/OS, Node/Moon versions, elapsed time, process peak RSS when available, row counts, candidate density, output bytes and exit status. Do not describe configured 100000-row budget as tested capacity.
- [ ] Audit current MoonRow/DataComPy/Record Linkage documentation or run small comparisons; distinguish documented support, locally verified behavior, and unknowns. Provide exact-join-plus-rules baseline on synthetic data and candidate true/false suggestion/review counts against explicit synthetic truth. No claims of real-world benefit.
- [ ] Run all workflows and benchmarks, save reproducible commands and actual results, commit examples/validation milestone.

## Task 8: Documentation, independent acceptance and GitHub publication

**Files:** README, configuration/review/architecture/project-proposal docs, MIT license, CI workflow, clean .gitignore; evidence status manifest.

**Interfaces:** Public user runs clone → install declared tools → build → example compare → review → resolve; reusable MoonBit library is consumable separately from Node adapter.

- [ ] Write a README acceptance smoke test that executes the documented commands from a clean checkout, accepting explicitly documented exit 1/3 where appropriate.
- [ ] Write Chinese project proposal: problem/workflows, existing-tool overlap, implemented capabilities, MoonBit/host boundaries, exact rules, real measured tests/performance, synthetic-data caveat, known limits, demand-validation gap, and continuation criteria. Distinguish delivered code/GitHub status from contest acceptance and real workflow adoption.
- [ ] Add CI on Ubuntu and macOS with pinned or explicitly recorded MoonBit toolchain installation, Node 22, build/core/integration/oracle/workflow tests. Do not fabricate a passing remote run.
- [ ] Have Astra review current exact commit for spec coverage and high-risk invariants, while Luna fixes actionable findings using failing regression tests. No release claim until all required local gates pass; unresolved scope defects remain named blockers.
- [ ] Inspect tracked/public payload: no credentials, private source snapshots, personal path-derived data, old project files, dependency caches or giant generated runs. Stage only intended new repository files, use meaningful milestone commits (no arbitrary count requirement).
- [ ] Publish the authorized repository to `https://github.com/z2823253773-p/moonreconcile`, push the tested commit, verify repository API/README visibility and remote CI exact SHA. If network/auth blocks occur, report actual blocker and retain local deliverables; do not claim upload succeeded.
- [ ] Verify from a fresh checkout and run the documented example. Deliver repository URL, exact tested SHA, proposal path, actual local/remote evidence, and remaining demand/XLSX/contest uncertainty. Mooncakes publication is a separate optional action, not implied by GitHub delivery.

## Acceptance ledger and handoff

Implementation is complete only when Tasks 1–8 pass (publication proof included), all six product stages work, all four record states conserve counts, full suggestions require human review, and each workflow produces final reports. Existing competing tools and absent real workflow evidence are product risks; they do not excuse missing implementation semantics.

Astra owns this plan and final independent review; Luna owns implementation tasks. Start Luna on Task 1 immediately, then Task 2; sequentially integrate contracts before parallel work. A reviewer may reject a task without changing adjacent interfaces. Record task status, exact commands, failure evidence, fixes, SHA and any contract change in `docs/validation.md`. Major contract changes require synchronizing this plan and tests; no renewed user permission is needed for routine implementation choices already within scope.

Self-review completed: every spec section has a task; interface names and JSON keys align; the five review risks map to explicit tests; real workflow/XLSX need is honestly unverified; all data processing algorithms stay in MoonBit. Work must not stop after exact diff, matching alone, or export-only output.
