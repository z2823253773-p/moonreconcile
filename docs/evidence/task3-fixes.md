# Task 3 review fixes

Review base: `67bed1879aa61e2793c47aa18fb6a557e63502c0`.

Addressed all three blocking findings without changing the spec or plan:

1. `result_to_json` now emits the locked Result envelope: schema and engine versions, computation status/issues, ordered `L<n>` then `R<n>` record entries, ID-based pairs, top-level field comparisons, candidate and decision arrays, structure, key issues, summary counters, and exit code. Internal pairs now carry source, reason, and override state for later decision extensions.
2. Compare validates both ignored-column declarations before reconciliation. A missing ignored column returns `ok:false`, a fatal `missing_ignored_column` error naming side and column, and a Result with exit code 2. Missing mapped columns remain fatal and are also reported with side/field.
3. Successful compare returns `normalize_config(config)` beside the result.

Regression-first evidence: before implementation, `npm test` failed the new wire-schema/config test because `response.config` was absent, and failed the ignored-column test because the request incorrectly succeeded. Mixed-key assertions now check duplicate/missing diagnostic codes, side, and data record number.

Final verification:

- `moon fmt` — passed.
- `moon info` — passed.
- `moon check --target js` — passed with no warnings.
- `moon test --target js` — passed, 50/50.
- `npm test` — passed, including bridge build and 8/8 Node tests.
- `git diff --check` — passed.

No Task 4 or Task 5 algorithms were added. The candidate-enabled pending-row path remains explicitly unsupported pending Task 4. No push was performed.

Fix commit: `17104463288a6cbdced0c1e4efaff78c8d849323`.
