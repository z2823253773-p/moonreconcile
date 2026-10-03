# Independent bounded increment review

Verdict: **PASS — no actionable correctness or scope/claims findings in the reviewed increment.**

Repository: `<repository-root>`

BASE: `8aa28378662d71abb9f9343b6c85594a8aec9b60`

HEAD: `4e4a4d82a44aad2a9c5df2b37a9f7d4a99467c0b`

Reviewed on 2026-10-03. This review covers only the authorized new increment. Historical Task 1–8 completion and whole-branch acceptance are outside this review. Read `AGENTS.md`; did not edit tracked files, commit, push or delegate. Root's subsequently uncommitted documentation/evidence is outside the pinned production diff reviewed here.

## Implementation and compatibility

- Production changes are bounded to `decisions.mbt` and the help/version dispatch in `cli/main.mjs`. Strict source/decision parsers, resource constants, matching engine and public `.mbti` interfaces are unchanged by this diff.
- Indexed identity deduplication retains the first decision and the original conflicting-reason error position. Input shape/nonexistent record and exact-key locks retain their input-order checks before subsequent acceptance validation.
- The endpoint indexes retain the first two acceptance positions, which is sufficient to find the earliest other acceptance for any current row. The final minimum across shared-endpoint acceptance, same-pair rejection and unmatched conflicts preserves the old nested scan's earliest-row and message behavior. The reason requirement still precedes conflict checking for each acceptance.
- Candidate qualification retains the first matching candidate's score semantics; disposal and rejection indexes preserve pending/unprocessed filtering and candidate suggestion suppression. `Array.sort_by` uses the original decision ordering; deduplication removes comparator-identical rows.
- Help/version dispatch occurs before argument parsing and bridge loading. Exact global help/version and all four known-command help forms work; extra operands and unknown-command help remain invalid.

## New targeted checks actually executed by this reviewer

1. **11 no-I/O CLI cases:** global help/version, all four known-command help forms, and five invalid forms. Injected filesystem, statfs, engine and clock callbacks all throw if called. Valid forms return 0 with stdout and no stderr; invalid forms return 2 with `invalid_arguments`. No injected callback was triggered.
2. **1,440 full-response conflict permutation comparisons:** all 720 permutations of two shared-endpoint accepts, a second left conflict, a same-pair reject and left/right unmatched declarations, each with and without candidate scoring. Every current response equals the independently built frozen BASE response byte for byte, including code, reason/message and row location. All cases intentionally produce `conflicting_decisions`.
3. **32 additional full-response comparisons:** complete versus 101×101 incomplete computation; qualified versus below-threshold acceptances; blank versus explicit override reasons; duplicate decisions; rejection and unmatched dispositions. Outcomes: 20 complete successes, 8 incomplete successes, 4 `manual_override_needs_reason`; every complete response byte string equals BASE.
4. **Independent Python subset check:** parsed committed CSVs using Python standard `csv`, checked SHA-256/byte sizes, CN/FR scope, actual order of every stable source ID, complete pair membership, one-sided IDs, and every changed literal field/value against `expected.json`. Observed 2558/2569 records, 2558 pairs, 11 later-only IDs, 18 changed cells in 10 records.
5. **Retained artifact integrity:** full upstream source bytes in the task's temporary evidence directory match both pinned full hashes and byte sizes; all six generated artifacts in `reproduced-fixture` equal committed fixtures byte for byte. Baseline/current built bridges and benchmark driver hashes match `review-performance-4e4a4d8.json`.

These checks completed successfully. The full reported suites were not repeated.

## Reported-suite and benchmark evidence inspected

Read `precommit-gates.json` and corresponding `precommit-gate-0..5.txt`. They record exit 0 for core check, 96/96 core tests, 57/57 Node tests, 240 independently verified assignment goldens, three synthetic workflows plus seven rejected mutations, and the three-stage OurAirports CLI workflow. Existing Node coverage includes cumulative histories and fully reviewed incomplete computations; these paths were also reviewed in source.

Inspected `scripts/benchmark-review.mjs` and `review-performance-4e4a4d8.json`: clean pinned HEAD; frozen BASE; 37 baseline source files checked against Git objects; request/response/driver/bridge hashes retained; alternating old/new invocations and three observations each. Complete success responses match byte for byte for both 10,000 accept actions and 20,000 unmatched actions. Recorded medians: accept 1604.980→126.039 ms; unmatched 1927.462→86.288 ms. These are retained single-machine synthetic pure-engine observations, not measurements newly rerun by this reviewer, throughput guarantees, memory measurements or user savings. Inspected the separate 3,000-case seeded full-envelope equivalence driver; its reported run is additional root-provided evidence, not counted as a reviewer rerun.

## Public-data provenance, gate and claims

- `prepare-ourairports.py` validates pinned full-source hashes, uses independent standard-library CSV parsing and stable-ID/literal string comparison, preserves order/cells, validates reproduced subset hashes and refuses an existing output directory.
- `check-ourairports.mjs` performs public CLI compare→resolve→cumulative replay, checks every record state, exact pair set and pair count, all changed fields and total comparison count, retained input bytes, all eleven required artifacts, completion status and exit 1, and complete reviewed/replayed report equality.
- CI runs the new gate after bridge build on both already configured supported runners. The gate itself is network-free.
- README, public-data README/provenance and modified planning/limitations documents explicitly separate actual public snapshots and authored absence dispositions from customer use, airport/business truth, time savings, matching accuracy, Excel/XLSX fidelity and contest acceptance. V05/V06 remain pending. No broad matching/benefit claim was added.
- Independently opened the [official downloads/terms](https://ourairports.com/data/) and [official field dictionary](https://ourairports.com/help/data-dictionary.html). They support the Public Domain/no-accuracy-guarantee scope and persistent internal `id` selection. The source is credited with direct URLs and exact revision/hash metadata. GitHub/raw license retrieval through the browsing service returned cache misses; the directly verified official Public Domain terms independently support use of the dataset. This is not a new substantive blocker.

## Limits of this verdict

PASS applies to the pinned bounded increment and reviewed evidence. No remote CI outcome for this new HEAD, contest acceptance, customer deployment, XLSX fidelity, aviation correctness, maximum-capacity workload or peak memory usage is claimed. No additional performance rerun or whole-branch re-review was performed.
