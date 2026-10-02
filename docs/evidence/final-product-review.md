# Archived review evidence

This is the historical review at the exact SHA below. Later fixes and delivery gates have separate evidence; this report alone is not a current completion claim. Full agent logs and private runtime paths are excluded.

# Final independent whole-product review

Reviewed 2026-10-02. Fixed HEAD: `c24ff158e6699ba5d7c2fde4018f7fab9b69ba92`.

Binding requirements: `docs/spec.md`, `docs/plans/2026-09-30-table-reconcile.md` including JSON protocol v1, and the final review context. The supplied reviewer template was followed. This is the broad product review, not a third Task 8 documentation gate. No subagents were dispatched. Tracked files, index, HEAD, branch, global configuration and remote state were not changed; only this ignored report is written in the checkout. Focused execution used an exact-HEAD disposable archive.

## Strengths

- The advertised algorithm resides in MoonBit. Node handles I/O, fingerprints, invocation and presentation; the reusable `invoke` boundary is exercised independently by the consumer fixture. The split is understandable and avoids a second host implementation of reconciliation.
- The implementation preserves distinctions on which human review depends: logical record IDs, original and transformed values, invalid versus missing values, exact-key locks versus suggestions, human disposition versus algorithmic completeness, and informational key history versus real anomalies. Cumulative decisions are validated before application against original inputs.
- Candidate admission has separate pair, edit-work and solver-component boundaries. Whole-component admission avoids presenting a partial component as a complete optimum. Integer scoring, fixed denominators, Unicode codepoint distance and the partial assignment solver have substantive tests and independent assignment-oracle coverage.
- Host persistence is unusually careful for a small CLI: original-byte snapshots and fingerprints, recursively canonical configuration, run identity checks, stale-input rejection, owned staging, no-overwrite publication, and propagated write/sync/close failures. The tests exercise real filesystem and export behavior, not only mocked success paths.
- The three workflow checks inspect original record identity and complete exported results, include a deliberately wrong top suggestion, and have seven mutation controls. Public documentation generally distinguishes synthetic examples, retained local evidence, incomplete processing and pending external checks.

## Issues

### Critical / P0–P1

None found in the reviewed scope.

### Important / P2

**R1 — Exported decision templates are not closed under their own row/byte intake budgets.**

Locations: `decisions.mbt:75–78` and `93–95`; `csv.mbt:100–109`; `cli/render.mjs:117–137`; shared raw-byte limit at `cli/io.mjs:9–11`.

`parse_decisions` first sends the entire decision CSV through the same parser and 100000-data-record cap as a source table. Blank actions are ignored only after parsing. The renderer can emit one blank row for every pending/unprocessed record on each side, additional suggested-pair rows, and the cumulative applied decisions. Two individually legal source tables can therefore produce a template that `resolve` cannot read, even when the user leaves every action blank. This breaks the advertised compare → export → edit/replay → resolve loop without requiring expensive candidate computation or extreme byte volume.

**Reproduced at the fixed HEAD:** an exact-HEAD archive was built successfully with the isolated installed toolchain. Both source files were `value\n` followed by `x\n` repeated 50001 times. Configuration was `{"schema_version":1,"fields":[{"name":"value","left":"value","right":"value","type":"text"}]}`. No key or candidate configuration was needed. Calling the actual CLI `run()` entrypoint for compare returned 1 and emitted a valid run. Its own `decisions.csv` contained **100002 data rows, 977839 bytes**. Passing that unchanged file to resolve returned **2**, with:

```json
{"ok":false,"error":{"code":"input_limit_exceeded","message":"CSV exceeds the 100000 data-record limit","phase":"input","side":"decisions","record":100002,"field":"reason"}}
```

Local reproduction evidence: `a retained disposable local CLI probe`. Disposable exact-HEAD build: `an exact-HEAD disposable archive`. These paths are local review evidence, not portable public assets.

The same compositional gap exists at the byte guard: a valid, near-limit cumulative active decision file can gain renderer-added blank rows and exceed the shared 64 MiB raw-input ceiling on replay. That is a source-level consequence of adding output to an already bounded input; it was **not** reproduced with a giant byte fixture. Applied actions plus new blank rows must be considered together, rather than only raising one total row constant.

**Required correction:** preserve all existing source-table budgets. Give decision templates their own bounded raw row/byte intake and independently bound nonblank actions and their canonical CSV wire size. Establish that every exported template fits the corresponding import budget, including applied history, suggested-pair blanks and pending-record blanks. Keep errors atomic; do not truncate template rows or weaken source admission.

The executor's proposed conservative envelope is reasonable: at most 100000 active action rows and 64 MiB canonical active CSV, plus at most 200000 record blanks and 100000 suggested-pair blanks, fits a 400000-data-row/128 MiB raw-template envelope. This is a proposed correction, **not reviewed implemented behavior**. The bound must count UTF-8 bytes after CSV escaping, include the header consistently, retain the cell cap, and be enforced at both CLI and pure invocation boundaries. Empty-action junk may consume raw budgets even though it is ignored semantically.

Add focused regression evidence for unchanged exported-template replay across the combined-source threshold, applied history plus newly emitted blanks, and the separate action/raw boundary failures. One shared raised source limit or one larger undifferentiated decision-row limit would not establish closure. The missing regression is part of this finding, not a separate defect.

### Minor / P3

**R2 — The configuration reference contradicts implemented field and candidate semantics.**

Locations: `docs/configuration.md:106` and `133`.

Line 133 says missing/invalid values always score zero in candidates. Missing/empty evidence can score zero, but invalid typed evidence retains `null` scoring and diagnostics; it is not a usable numeric zero. The later candidate section and implementation describe that distinction correctly. Line 106 also says a decimal pair within tolerance and with identical original strings is `equal`, omitting that transformed decimal difference must be zero. The existing `same_raw_decimal_with_different_side_maps_is_not_reported_equal` test covers identical raw `1` values mapped to different side values within tolerance; their status is `equivalent_by_rule`.

Readers using these sentences to interpret or independently consume results get the wrong semantics. Correct the prose to match the existing tested behavior; an algorithm change is not requested.

**R3 — The review guide overstates how much identity confirmation requires a person.**

Location: `docs/review-workflow.md:9`.

The introduction says the program only suggests and all identity confirmation is written by a person in `decisions.csv`. A unique, valid configured key produces automatic `exact_key` matches, and those matches are locked against manual decision overrides. Narrow this introduction to candidate/remaining identity review and explicitly distinguish configured exact-key matches. The later workflow and code already implement the intended distinction; this is a public-description correction.

**R4 — The dependency audit infers absence of supply-chain risk from an empty npm dependency list.**

Location: `docs/dependency-audit.md:87`.

The statement that there is therefore no supply-chain risk surface goes beyond the evidence. The product still uses the MoonBit toolchain/core, Node and GitHub Actions, and the workflow downloads an official toolchain installer. The supported fact is that no additional third-party npm runtime/development dependencies are declared. Replace the absolute conclusion with that narrow fact or a reduced-dependency-surface statement. This finding does not demand a new dependency-pinning or security-hardening project.

## Reviewed scope and evidence

### Package and source coverage

The union of paths in `review-67c3263..c24ff15.diff` and `initial-foundation-snapshot.diff` covers all **114 tracked files** at the fixed HEAD, including files unchanged since the root commit. The aggregate diff's patch content matches the actual `git diff -U10 67c3263 c24ff15` apart from surrounding/trailing presentation whitespace. There is no fictitious preimplementation parent or main branch in this review.

Current production code was read across `model.mbt`, `csv.mbt`, `config.mbt`, `decimal.mbt`, `date.mbt`, `rules.mbt`, `exact.mbt`, `candidates.mbt`, `assignment.mbt`, `decisions.mbt`, `report.mbt`, `engine.mbt`, `moonreconcile.mbt`, all four `cli/*.mjs` modules, `scripts/build.mjs`, bridge command/package files, module/package manifests and generated public API. The initial command scaffold was also inspected.

The source pass covered strict CSV states and limits; decimal/date parsing and side transforms; missing/invalid ordering; collision-safe unique-key identity; candidate grouping, deduplication, scores and admission; partial Hungarian assignment; cumulative decision schema, canonical IDs, conflicts and exact locks; four record states and exit precedence; protocol response shape; snapshot/config/version validation; publication and failure cleanup; all eleven rendered artifacts and decision-template generation.

### Tests, scripts, workflows and documentation

Read the core CSV/config/rules/exact/candidate/decision tests, assignment test assertion machinery, complete CLI and bridge tests, cumulative decision oracle, JS API probe and consumer fixture. Literal assignment data were checked machinewise: all **240** MoonBit cases exactly matched `(left_count, right_count, edges, optimum)` in the oracle JSON. The independent exhaustive Python optimizer and the MoonBit endpoint/existence/weight assertions were reviewed. This is stronger than visually sampling literals, but is not a claim that this reviewer reran the entire oracle suite.

Read the full workflow verifier, benchmark driver, assignment checker, library-consumer checker and README prepare/smoke/output-check scripts. Reviewed the three example datasets/configurations/reviewed-decision files and truth catalog, workflow source, CI and setup workflows, NyaCSV probe source/tests, README, spec/plan, architecture, configuration, review workflow, limitations, validation, acceptance matrix, project proposal/one-page description and dependency audit. Inspected the current publication payload, dated official-requirements record, progress rulings, public implementation rulings and prior gate findings/outcomes, with particular attention to Task 8's budget-evidence caveat. Prior historical evidence was used as attributed evidence, not silently rerun or externally revalidated.

The current 114-file payload has no tracked symlinks; largest file is 77382 bytes. A scoped scan found no local `personal home prefix` paths, PEM private-key markers, common GitHub-token patterns or AKIA-shaped credentials. This is a limited payload check, not a comprehensive secret audit or a claim that earlier commits were rewritten.

### Execution and evidence attribution

- This reviewer built a disposable archive of the exact reviewed HEAD successfully and executed the focused real-CLI R1 reproduction above. The source checkout stayed unchanged.
- The root's retained local gate output records the d30061f execution: 88 core tests; 53 Node tests including 200 independent cumulative-decision cases and the production 101×101 incomplete case; 240 assignment goldens; 90 consumer tests; three workflows and seven mutation controls; nine README commands. At c24ff15 only two documentation files changed, and the root reran the fresh-clone nine-command README check. These are **root executions inspected by this reviewer**, not newly executed whole suites.
- Formatter-only semantic preservation is supported by the prior Task 8 token comparison, not a second independent token-comparison run here.
- A small exploratory pure-engine probe with 1000/2000/4000 explicit unmatched decisions completed successfully. It does not establish maximum decision performance or an SLA and is not release benchmark evidence.
- Production limits, parser boundaries, injected threshold tests, actual production-threshold tests and retained historical benchmarks are different evidence classes. The injected 64 MiB/DP-style tests do **not** certify a literal maximum end-to-end workload. R1 itself demonstrates why individually passing layers do not prove cross-stage closure.

## Recommendations

Resolve R1 and the three small documentation corrections in one combined fix wave, then conduct one scoped rereview of the changed intake/export bounds, regression evidence and prose. Keep source budgets and cumulative-decision semantics stable. Update the acceptance matrix to identify which boundaries have actual production-size execution, which are injected branch tests and which remain unverified. Complete the root-owned external gates only after observing their actual results.

## Declined to judge

These are explicit scope/evidence decisions for the executor to rule on; none is an implicit approval of behavior beyond the contract.

- Real-user accuracy, saved review effort, adoption and competitor performance: only synthetic examples and controlled truth are available; no authorized real user study or comparative runtime evidence was provided.
- XLSX ingestion, spreadsheet date/leading-zero conversion and formula recalculation: the implemented contract is CSV, and no real XLSX workflow has been validated. Their future importance is a product decision, not an implemented feature certified here.
- Many-to-many financial settlement, ML identity inference, graphical UI, database persistence, multiuser editing and timezone-aware values: explicitly outside the narrow v1 scope; this review did not turn them into new requirements.
- Treating scores as probabilities or assignment optimum as proof of identity: the product intentionally does neither; candidates require human review and retained evidence. No calibration is certified.
- Re-solving after a reject and requiring a rejected pair to have been an emitted candidate: the accepted cumulative-decision ruling preserves negative human evidence without mandatory solver reruns; no violation of that settled contract was found.
- Overriding exact-key matches through decisions, or inferring unmatched status merely from an absent candidate: deliberately disallowed by the identity/state contract. Changing keys requires a new comparison and unmatched status requires an explicit decision.
- Automatically merging new decisions with old actions omitted from the supplied file: the full supplied cumulative table is authoritative. Removing an old action intentionally changes the replay; append-only merge behavior is not promised.
- Adversarial tampering/authentication, concurrent hostile filesystem replacement and crash/power-loss durability beyond checked writes: fingerprints provide consistency/staleness checks, not authentication; no transactional durability/security guarantee is advertised. This review verified the ordinary failure/no-overwrite paths, not those stronger guarantees.
- Formula interpretation when a CSV is opened by a spreadsheet application: literal CSV preservation is implemented. Spreadsheet-specific interpretation and safe-import behavior were not empirically certified; assess that separately if the product adopts an Excel workflow.
- Arbitrary manually constructed exported low-level `Config`/`Table`/result values bypassing validation: the reviewed supported JSON operation boundary is `invoke`. The generated API exposes helpers, but this review does not certify defensive behavior for every invalid manually constructed internal value; any stronger helper-level public contract needs an explicit decision.
- Native/Wasm targets, other runtimes and future mutable toolchain releases: the advertised product path is the reviewed JS build. Additional target compatibility was not inferred from the source structure.
- Literal maximum end-to-end capacity and worst-case decision latency: bounded inputs and small/injected tests do not prove acceptable throughput at every maximum. Decision scans/sorting have scaling costs, but no separate demonstrated performance failure or advertised SLA breach was established here. The reproduced closure defect is reported as R1 rather than hidden under this abstention.
- Cross-file simultaneous source snapshots while another application edits both inputs: the tool fingerprints the bytes it reads; it does not promise a filesystem-wide or two-file transactional snapshot.
- Filesystems without the required no-overwrite publication primitive: failing safely is the accepted portability tradeoff. A fallback that can overwrite was not requested as an availability improvement.
- Unadvertised `cmd/main` hello scaffold: it is not the documented reconciliation CLI or library entrypoint. Removal would be optional cleanup, not a functional blocker.
- Retained benchmark host details and earlier-commit path metadata: current payload inspection does not prove history sanitization. Public history policy and the explicitly authorized publication payload remain the executor's responsibility.

## Cannot verify from this review

- A public push, remote exact HEAD/README visibility, successful real Ubuntu/macOS Node 22 and Python 3.12 CI, or final root acceptance-matrix closure. Workflow source and local results do not establish those external facts.
- Current contest eligibility, an application, organizer approval or acceptance. The dated requirements record is inspectable evidence of prior research, not proof of those outcomes.
- Mooncakes registry publication, which is optional and separate from the tested reusable library consumer.
- A literal 64 MiB/maximum-DP/full combined-bound end-to-end run, every supported maximum's runtime/memory use, or real-user benefit. Existing evidence must retain its actual scale and origin.

## Assessment

**Spec verdict: NEEDS FIXES. Quality verdict: NEEDS FIXES. Ready to merge: With fixes.**

The implementation substantially satisfies the six-stage product contract and has strong independent and end-to-end verification, but R1 breaks a central continuation workflow on ordinary valid source inputs. Fixing that cross-stage budget contract and the three minor prose errors, then observing the pending root-owned external gates, is necessary before an unqualified final acceptance claim.
