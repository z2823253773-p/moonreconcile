# Task 4 implementation report

- Repository: `/Users/henryz/Desktop/比赛/moonreconcile`
- Base branch / SHA: `feature/initial-product` / `c2683333674de2e120dfcd097a16a6f191690b7b`
- Local milestone commit: `4fe8f74d3a416e01c56e2f727fe3dd4454c3c69e` (`Implement budgeted candidate matching`); worktree clean, branch one commit ahead of origin.
- Scope: candidate pair generation, scoring, pre-score and qualified component handling, maximum-weight partial assignment, report integration. No decision workflow, CLI, or push performed in this report state.

## Implemented behavior

`compare_tables` keeps exact-key pairs and sends remaining records through candidate generation when candidates are configured. With no blocking rules it preflights the all-pairs product before enumeration. With OR-of-AND blocking rules it builds per-group right-side indexes, unions and deduplicates pairs, and emits candidates in left-record/right-record numeric order. Invalid, missing, or empty blocking values cannot establish a group match; records without coverage remain `pending_review`, with `candidate_blocking_uncovered` in computation issues.

Scoring uses the mapped-field transforms and canonical decimal/date parsers. Exact text and type-tolerance metrics score 10000 or 0; edit similarity uses Unicode codepoints. Empty/missing identity evidence scores zero. Invalid typed evidence makes the aggregate null and retains field diagnostics. The fixed-weight numerator uses `BigInt`, with integer-floor division after summing.

The full pre-score pair graph defines atomic scoring-failure scope. Each pre-score component is admitted as a whole after codepoint and DP-cell preflight. A rejected component leaves DP budget available for later components. Only valid, threshold-qualified edges enter the second graph; its connected components receive the 100-record-per-side solver limit. `P<n>` identifies pre-score components; `Q<n>` identifies qualified components. IDs follow numeric candidate order and do not assert that a component was solved when candidates carry `P<n>`.

Assignment uses a square Hungarian reduction with real and dummy vertices. Dummy assignments have zero reward, prohibited real-real edges remain unavailable, and only positive supplied edge weights can be selected. It maximizes total score with deterministic traversal; selected proposals set `suggested:true` but never create formal pairs. Solver helpers are internal and capped at 100 records per side.

The locked top-level Result keys remain unchanged. Candidate rows use the documented outer shape; `field_scores` entries contain `field`, `metric`, `weight`, and integer-or-null `score`; diagnostics contain `code`, `field` when applicable, and `message`. Resource-limited records appear as `unprocessed`, computation status becomes `incomplete`, and exit code is 3. Coverage gaps are explanatory issues while the computation remains complete.

## Fixed production budgets

- Distinct candidate pairs per stage: 100,000.
- Edit-string length: 512 Unicode codepoints per value.
- Edit DP budget: 20,000,000 recurrence cells, counted as `len(left) * len(right)` per required field comparison; boundary-row initialization is excluded.
- Qualified assignment component: at most 100 records on either side.
- Budget injection is private to package tests; production calls use fixed constants.

## Validation run

- `moon info && moon fmt`: passed.
- `moon check --target js`: passed.
- `moon test --target js`: 63 passed, 0 failed.
- `npm test`: build passed; 8 bridge tests passed, 0 failed.
- `git diff --check`: passed.

Focused tests cover 256 fields at weight 10,000, fixed denominator, greedy-fails assignment, high-score-over-two-low-score assignment, unequal/no-edge partial matching, OR-of-AND deduplication, uncovered blocking rows, transactional pair-budget overflow with exact pairs preserved, exact/one-over DP cell limit, 512/513 codepoints, component-atomic scoring and budget reuse, and qualified side-limit isolation. Root's independent 240-graph exhaustive oracle remains to be run. No empirical 1,000/10,000-row benchmark is claimed.

## Remaining review items

- Run the independent exhaustive oracle and Astra code review, then resolve any findings with regression tests.
- Performance capacity remains unmeasured beyond the specified algorithmic budgets.
- No remote publication evidence is claimed here.
