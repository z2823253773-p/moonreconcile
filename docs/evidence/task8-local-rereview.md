# Archived review evidence

This is the historical review at the exact SHA below. Later fixes and delivery gates have separate evidence; this report alone is not a current completion claim. Full agent logs and private runtime paths are excluded.

# Task 8 fix round 1 — scoped independent re-review

Date: 2026-10-02. Base: `d30061fc8480c41d57b04b385d4521a7d1cbc609`. Exact reviewed HEAD: `c24ff158e6699ba5d7c2fde4018f7fab9b69ba92`.

**SPEC: PASS. QUALITY: PASS. R8-1, R8-2, and R8-3: ADDRESSED. No remaining finding or new regression identified in this documentation-only fix scope.**

Read the entire `review-d30061f..c24ff15.diff`, original `task-8-review.md`, and appended fix-round evidence in `task-8-report.md`. The one-commit diff changes only README and review-workflow prose: 11 insertions, 4 deletions. No production source, tests, smoke scripts, API, or CI settings changed.

## Finding closure

| Finding | Status | Evidence |
| --- | --- | --- |
| R8-1, incorrect no-key / persistent-anomaly guidance | ADDRESSED | `docs/review-workflow.md:279-280` now says identical inputs without a usable key remain pending/exit 1 initially; complete human disposition and absence of other problems are necessary before informational diagnostics cease to prevent exit 0. It explicitly preserves duplicate/invalid/missing-key anomalies after human pairing and distinguishes correspondence confirmation from repairing source-key quality. This agrees with the unchanged production branch and the three exact-base probes retained in the original review. |
| R8-2, complete versus exit 3 | ADDRESSED | `README.md:38` now says commands may produce reports while returning 1 for outstanding issues or 3 for incomplete computation. It no longer labels exit 3 complete. |
| R8-3, undefined manual `SMOKE_DIR` | ADDRESSED | `README.md:40-47` gives `SMOKE_DIR="$(mktemp -d)"` followed by `export SMOKE_DIR`, explicitly in the same shell and from the checkout root. It distinguishes this setup from the automated runner's own scratch provisioning. The setup remains outside the extraction markers, avoiding the runner's separate-shell-per-command persistence problem. |

## Checks and attribution

- Independently confirmed HEAD and clean tracked working state, and checked the actual diff file list: only `README.md` and `docs/review-workflow.md`.
- Independently compared the entire marked README smoke block with base using exact string equality: byte-for-byte unchanged, nine `@expect` markers retained. The manual setup supplies the missing environment without changing automated extraction.
- Ran `git diff --check d30061fc8480c41d57b04b385d4521a7d1cbc609 c24ff158e6699ba5d7c2fde4018f7fab9b69ba92`: exit 0.
- Inspected the actual `a fully reviewed run with no usable key exits zero` assertions. They require initial compare exit 1, reviewed exit 0, unresolved count 0, expected paired count, and retained historical key diagnostics. Its fixture configures a key whose values do not match, so it directly covers the informational `key_not_found` route, not every possible no-key/anomaly case. The original review's separately executed no-configured-key and duplicate-key probes supply those unchanged semantic checks; the fix report does not claim the focused test alone proves anomaly persistence.
- The implementer reports running the manual setup plus all nine commands from a disposable clean clone, with expected statuses `0,0,0,0,1,0,1,1,0`; the automatic clean-clone smoke also passed nine commands, and the focused existing CLI test passed 1/1 at exact fix HEAD. These execution results are attributed to the implementer report. The reviewer inspected their meaning and unchanged command/source relationships and did not rerun whole suites, workflows, historical benchmarks, or these already-reported smoke paths merely to duplicate evidence.

## Limits

This closes the Task 8 local scoped findings, not the final whole-branch gate. D05 broad review/final acceptance-matrix closure, D07 public push/API/README and exact remote SHA, D08 actual two-OS CI with Node 22/Python 3.12, and D09 final delivery remain root-owned and pending. V05/V06 real workflow and CSV/XLSX fit remain unverified product evidence. No contest submission/approval, external success, new benchmark result, or changed historical redaction guarantee is inferred.

No tracked edits, index/HEAD changes, commits, push, remote mutation, global-toolchain changes, or subagents were used. This ignored re-review report is the sole newly written repository artifact.
