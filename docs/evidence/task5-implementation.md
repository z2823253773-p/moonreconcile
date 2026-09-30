# Task 5 implementation report

## Recorded revision

- Branch: `feature/initial-product`
- Commit: `5281187566dff5eefefeddaa8433520b582056e6`
- Task 4 base before Task 5: `4fe8f74` (`Implement budgeted candidate matching`)
- Scope commit: tracked Task 5 implementation/tests plus `moon fmt` formatting of the independent assignment golden test. No push performed.

## Test-first evidence and gates

The initial `moon test --target js` run with `decisions_wbtest.mbt` in place failed at compile time because `Decision`, `parse_decisions`, and `apply_decisions` were not defined, and the result model did not yet expose unmatched records. This confirmed the new tests were exercising missing Task 5 behavior. After correcting test scaffolding, implementation was added and the full suite passed.

Final checks on the committed source:

- `moon info && moon fmt` — passed; generated `pkg.generated.mbti` inspected.
- `moon check --target js` — passed.
- `moon test --target js` — 82 tests passed, 0 failed.
- `npm test` — 8 Node bridge tests passed, 0 failed; now includes a working `resolve` request.
- `git diff --check` — passed before commit.
- Commit: `5281187566dff5eefefeddaa8433520b582056e6`.

## Implementation

- Added strict decision CSV parsing for the exact `action,left_id,right_id,reason` header, the four supported actions, canonical side-specific IDs, endpoint shapes, and ignored empty-action rows. Quoted commas and newlines remain supported by the existing strict CSV parser.
- Added atomic whole-batch validation before constructing a new result: exact-key endpoint locks, duplicate removal, reason-conflict rejection, pair/action conflicts, endpoint uniqueness, endpoint existence, and noncandidate acceptance override reasons.
- Rebuilds every accepted human pair's configured field comparisons from the original table rows. Accepted pairs do not erase `different` or `invalid_value` field results.
- Rejections and untouched rows remain pending; explicit side-unmatched decisions become reportable `unmatched` records. Rejected or otherwise disposed candidate suggestions are no longer marked suggested.
- Preserves original incomplete computation status/issues and exit code 3 after human disposition; resource-limited rows left undisposed remain `unprocessed`.
- `resolve` now reparses the supplied snapshots/config, rebuilds the base via `compare_tables`, then applies the full supplied decision table once. A fully reviewed no-key run can exit 0 when no other issue remains; duplicate/missing/invalid key diagnostics still force exit 1.
- Policy choices: same action/endpoints with different reasons reject the batch; ASCII-whitespace-only override reasons are blank; a valid reject can record a negative relation for existing remaining endpoints even when it was not a generated candidate. No assignment rerun occurs after review.

## Remaining boundaries

- Host-side run-directory snapshots, fingerprint checks, and CLI resolve file handling remain Task 6 work; this commit implements the MoonBit core JSON operation.
- Performance budgets have not been benchmarked against real workflow data. Synthetic tests establish behavior, not throughput or matching accuracy.
- Real user workflows, XLSX needs, and production data compatibility remain unverified.
