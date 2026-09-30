# Task 4 independent spec and quality review

Verdict: **PASS — Task 4 only**, with one nonblocking performance follow-up. No blocking correctness/spec finding found.

Reviewed exact milestone `4fe8f74d3a416e01c56e2f727fe3dd4454c3c69e` against `c2683333674de2e120dfcd097a16a6f191690b7b`. Read spec sections 6–8, plan global constraints/locked JSON/Task 4, and ignored Task 4 brief/preflight/implementation report. Code and tests ran from isolated git archive `/private/tmp/moonreconcile-astra-t4`. No tracked source edits, commits, or pushes performed.

## Fresh evidence

- `moon test --target js`: 63 passed, 0 failed.
- `npm test`: JS bridge build successful; 8 Node tests passed, 0 failed.
- `node adversarial.mjs` in scratch archive: 9 independent adversarial scenarios passed. Harness: `/private/tmp/moonreconcile-astra-t4/adversarial.mjs`.
- Adversarial cases exercised OR-of-AND blocking union with overlapping matches; missing-marker fixed denominator; exact decimal tolerance boundary and invalid/null aggregate; astral Unicode edit distance; production pair-overflow preserving an exact pair and discarding candidates; actual 100/101 qualified component side boundary and competitor retention; pre-score 101-by-101 graph splitting into 101 qualified singleton components; numeric L2/L10 output ordering; production 512/513 astral-codepoint boundary. Every harness call checks per-side record conservation, candidate counts, and pending status of suggested endpoints.
- 100000 distinct STAR edges (one side 100000 records, other side one record) completed with 100000 candidates, all affected records unprocessed, exit 3, about 2.49 seconds locally.
- Same 100000-edge STAR with edit scoring requiring a 513-codepoint operand completed with null/unprocessed candidates and exit 3, about 2.73 seconds locally.
- Environment: Node v24.15.0; moon 0.1.20260713 (75c7e1f). These are narrow local observations, not supported-capacity claims or representative memory/output benchmarks.

## Spec/code assessment

Pair generation uses right-side indexes per blocking group and deduplicates before charging the pair budget; all-pairs product is checked before enumeration. Pair-stage overflow returns no partial candidates while report integration preserves exact outcomes. Canonical normalization is reused, invalid typed evidence yields null, missing/empty identity yields zero, weights stay in the denominator, and BigInt precedes weighted multiplication.

Pre-score connected components control atomic scoring admission; threshold-qualified components separately control assignment admission. Budget rejection leaves DP allowance for later components. Ordering is derived from numeric input/candidate traversal, not hash enumeration. DP estimates use checked recurrence-cell arithmetic. Fixed production budgets remain private constants; no production expansion option was introduced. Resource records conserve counts and force exit 3; suggestions never create formal pairs. Locked result/candidate outer wire shapes remain intact.

Hungarian matrix rows are independently allocated, dummy routes permit partial matching, forbidden real edges stay prohibited, and supplied production scores bound the solver arithmetic. Existing fresh tests cover the 16000 greedy counterexample and 10000-over-two-4000 total-weight objective, no-edge/unequal-side cases, atomic cost rejection/budget reuse and 256 maximum-weight fields. Root is separately running its independent 240-graph exhaustive goldens; this report does not claim that execution as its own evidence.

## Nonblocking finding

**P3 — Sparse-component traversal/output still has quadratic work.** `candidates.mbt:276-277` and `562-563` allocate/initialize arrays sized to the entire input for each component. `candidates.mbt:657` calls `selected.contains(i)` for every emitted candidate. On singleton components there can be one component and selected entry per candidate, giving quadratic initialization/membership work despite the indexed blocking join. Resource marking at `373-378` and `603-610` likewise scans accumulating arrays, though tested 100000-edge STAR paths completed correctly.

Reproduction: `node adversarial.mjs 10000 sparse` versus `node adversarial.mjs 30000 sparse` in the scratch archive. Each side contains distinct `x0...xN` strings, exact scoring, and blocking on the same field, producing N singleton edges. Observed approximately 0.77 seconds and 6.94 seconds respectively (three times the rows, nine times elapsed time). Both returned complete, exit 1, all candidates retained and all records pending; no resource/crash defect reproduced.

Recommended follow-up before performance claims: allocate endpoint marks once (or use per-component sparse sets/generation stamps), use a selected-edge boolean array, and remove unnecessary linear membership checks for already-disjoint component endpoint sets. Measure again in Task 7. This is nonblocking for Task 4 because the approved spec expressly describes these budgets as unmeasured initial protection bounds and assigns representative capacity measurement to later work.

Manual resolve semantics, CLI directory transactions, real workflow evidence, public publication, contest review and acceptance remain outside this Task 4 verdict.
