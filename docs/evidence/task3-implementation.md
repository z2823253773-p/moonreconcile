# Task 3 implementation report

Base: `b3e57fd0207776fef2c86625faae8c66abfea6dd` (`feature/initial-product`, clean at start).

Task 3 adds exact composite-key correspondence, structural diagnostics, per-field comparison evidence, pending record IDs, independent left/right conservation counts, stable JSON reporting, and the `compare` bridge operation. Composite keys use JSON array encoding and per-side key-to-row-index maps. Only keys that are valid, nonmissing, nonempty for text fields, and unique on both sides pair automatically. Duplicate, invalid/missing, and one-sided records remain pending. Unmapped columns and explicitly ignored columns are reported separately. Missing configured source columns are fatal with exit code 2 and retain column diagnostics in the compare response. All-rule-equivalent exact pairs can exit 0; structural, field, key, or pending issues exit 1.

Coverage includes two-part reordered/renamed keys, duplicate and missing keys, delimiter-collision resistance, no-key behavior, all-exact candidate-stage skipping, invalid typed and empty text keys, equivalent-only exit 0, unmapped-column exit 1, missing mandatory columns, JSON field evidence, and per-side count conservation. `resolve` remains unsupported as planned.

Validation on the Task 3 tree:

- `moon fmt` — passed.
- `moon info` — passed; generated `pkg.generated.mbti` reflects the new public result and JSON interfaces.
- `moon check --target js` — passed.
- `moon test --target js` — passed, 50/50.
- `npm test` — passed, including bridge build and 6/6 Node tests.
- `git diff --check` — passed.

Remaining named gaps are later milestones: candidate generation/scoring and assignment (Task 4), human decision replay (`resolve`, Task 5), standalone CLI/snapshots/full exports (Task 6), workflow/benchmark/product validation (Task 7), and independent acceptance/publication (Task 8). For now, compare returns `candidate_stage_not_implemented` when candidates are configured and exact matching leaves pending records; no candidate-enabled run is represented as complete. No publication or push was performed.

Local implementation commit: `a5052997133c819e7b7315de56ae519c9c182719`. The verification report was committed immediately after it.
