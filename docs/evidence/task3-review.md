# Task 3 independent review — FAIL

Reviewed exact commit `67bed1879aa61e2793c47aa18fb6a557e63502c0` against base `b3e57fd0207776fef2c86625faae8c66abfea6dd`. Scope: Task 3 semantics and locked interfaces; no claim about later milestones.

## Blocking findings

1. **P1 — Restore the locked Result wire schema before extending it.** `report.mbt:31-38,60-101` serializes a different interface from the locked protocol in `docs/plans/2026-09-30-table-reconcile.md`. It lacks `engine_version`, `computation`, top-level `fields`, `key_issues`, and `summary`; `records` is an aggregate object rather than ordered `{id,side,record,status,reason}` entries, and pairs use integer `left_record/right_record` instead of `left_id/right_id`, omit `reason/override`, and nest comparisons. Consequently the prescribed L1/R1 decision and export consumers cannot consume this result without changing the supposedly locked wire contract. Implement the planned schema now (including field status counts, structural/key counts and unresolved count), and test the full envelope, IDs, ordering and conservation at the bridge boundary. A successful one-row compare reproduces all missing keys.

2. **P1 — Reject absent explicitly ignored columns.** `exact.mbt:235-240` filters nonexistent ignored columns out of the report, while `missing_columns` checks only mapped sources (`exact.mbt:105-117`). The locked structure contract explicitly requires every declared ignored column to exist. Reproduction: both inputs `id\n1\n`; mapping/key `id`; `ignore_left:["typo"]`. Actual: `ok:true`, exit 0, `ignored_left:[]`. Expected: structured input/configuration failure (exit 2), naming the side and missing ignored source. Check both ignore lists before reconciliation; add a regression for each side and preserve existing mapped/ignored conflict validation.

3. **P2 — Include normalized config in successful compare responses.** `engine.mbt` final line of `handle_compare` calls `success_to_json("result",...)`, so even a valid successful comparison omits the required sibling `config`. The locked compare protocol requires `{ok:true,config:Config,result:Result}`, and the later snapshot fingerprint contract relies on serializing core-returned normalized configuration. Return `normalize_config(config)` alongside the result and assert default normalization in a bridge compare test.

## Independent verification

- Archived the exact reviewed commit to `/private/tmp/moonreconcile-astra-task3`; all builds/probes ran there, with no tracked repository modifications.
- `moon test --target js`: 50/50 passed.
- `npm test`: 6/6 passed, including bridge build.
- Additional Node probe: 200 deterministic generated cases checked unique-per-side nonempty exact correspondence against an independent oracle, including duplicates, empty keys, quoted newlines, quotes, delimiter text and Unicode; checked per-side count conservation and repeat-result determinism. All passed.
- Decimal canonical collision probe (`001.00`, `1` vs `+1.0`) correctly retained all records pending.
- Missing ignored column and missing result/envelope members were independently reproduced.

## Optional improvements

- Cache canonical key computations and resolved header indices. Current implementation normalizes each record key repeatedly in diagnosis passes and linearly resolves field/header names each time. This is not a demonstrated correctness failure; measure before optimization, especially at the planned wide-table/input scales.
- Add stronger diagnostics assertions: current mixed-key test checks only a lower bound on diagnostic count, which does not establish each expected code, side and record location.

Candidate-enabled pending records remain explicitly unsupported until Task 4 as agreed; the all-exact skip is valid. No issue is raised for the known tracked scratch-report remediation. Core exact pairing logic and field evidence passed the probes, but the three contractual findings block Task 3 acceptance.

## Scoped re-review — Task 3 PASS

Exact checked SHA: `17104463288a6cbdced0c1e4efaff78c8d849323`; fix base: `67bed1879aa61e2793c47aa18fb6a557e63502c0`.

All three blocking findings are resolved. The serializer now provides the locked Result members, ordered L/R record entries, ID-based pairs with reason/override, flattened comparison evidence, field-status and per-side summaries, structural/key counts, and unresolved count. Successful compare includes core-normalized config. Absent declared ignored columns on either side produce a located `missing_ignored_column` failure and exit 2; source-column failures retain priority.

Independent verification used a fresh archive of the exact fix SHA in `/private/tmp/moonreconcile-astra-task3-fix`:

- MoonBit JS tests: 50/50 passed.
- Node bridge tests: 8/8 passed.
- Adapted independent 200-case seeded oracle passed against the new ID and summary schema: unique/nonempty per-side correspondence, repeated-result determinism and independent conservation, including duplicates, quotes, newline keys and Unicode.
- Decimal canonical duplicates remain pending.
- Direct probes independently verified both ignored-column failures, error side/field, exit 2, locked result member presence, ordered L1/R1 IDs, field links, pair override flag, field summary and normalized defaults.

No new blocking findings in the scoped fix or adjacent exact-matching behavior. Earlier optional performance/test suggestions do not block acceptance. PASS applies only to Task 3, not candidate generation, decisions, full CLI, publication or product completion. No tracked edits or push performed.
