# Archived fix evidence

Historical fix report; external CI and publication remain separate checks.

# Final combined fix wave: R1–R4

Status: DONE_WITH_CONCERNS (maximum throughput and external gates remain explicitly unverified). Fix commit **`0bcf96753df06a7eeedb74fb30c2db7ac24b2eb7`**, 16 explicit owned files, 331 insertions / 25 deletions. Implementation and required local checks complete. Base `c24ff158e6699ba5d7c2fde4018f7fab9b69ba92`, branch `feature/initial-product`. Scope: ONE combined fix wave; no subagents, push, global configuration or unrelated project edits. Root owns independent rereview, external gates, publication, its four new evidence documents and `docs/evidence/implementation-rulings.md` ruling 11.

## Fail-first evidence (actually executed)

1. Added real CLI `production 50001 per side templates replay with original IDs and applied history`, then ran `node --test --test-name-pattern='production 50001' tests/cli.test.mjs` against the old built core. Exit 1, 0/1 passed. Actual assertion: resolve returned **2 rather than 1**, diagnostic `input_limit_exceeded`, `CSV exceeds the 100000 data-record limit`, phase `input`, side `decisions`, record **100002**, field `reason`. Both actual source files were `value\n` plus `x\n` repeated 50001 times, no key/candidates. This reproduced the reported row defect with actual production budgets.
2. Core `moon test --target js --filter decision_template_above_source_row_cap_keeps_blank_actions_ignored` exited 2: 1 test, 0 passed, 1 failed (`Result::unwrap` on the old parser refusal).
3. After introducing role-aware raw parsing, but BEFORE active admission, core `moon test --target js --filter 'decision_active*'` exited 2: 2 tests, 0 passed, 2 failed (`false is not true` at missing active-row/byte refusal). Repeated after correcting independently calculated fixture byte constants; same two expected behavioral failures. First hand-written byte totals were corrected to the actual 31-byte header, 15-byte ASCII row and 27-byte escaped Unicode row before green verification.
4. Host `node --test --test-name-pattern='decision raw byte guard' tests/cli.test.mjs` exited 1: 0/1 passed. Actual decision input was **2039 raw UTF-8 bytes**, with source budget 1024 and decision budget 2039. Old host wrongly returned 2 using source maxInputBytes, `exceeding the 1024-byte raw input budget`, phase/side `decisions`.
5. A transient MoonBit syntax error in the new private byte helper (`bytes + if ...`) caused a build failure; corrected to parenthesized expression and rebuilt before any green claim. An intervening CLI run still saw the stale old core and failed the original row reproduction; final results below use the successful fresh build.

## Final behavior and closure proof

- Source wrapper retains **67108864 bytes / 100000 data logical records / 256 columns / 65536 UTF-8 bytes per decoded cell**. No source, snapshot, manifest or config host limits were raised.
- A private role-aware parser supports decision raw **134217728 bytes / 400000 data logical records**. Public `parse_decisions` keeps the same signature and enforces its exact four-column header and existing cell cap. Empty-action rows remain semantically ignored but count toward ALL raw bounds.
- Before application, the MoonBit parser separately admits at most **100000 nonblank-action rows, before deduplication**, and **67108864 bytes of canonical active CSV including the 31-byte header**. UTF-8 codepoint bytes, doubled quotes, conditional enclosing quotes, three commas per row and LF are counted. Budget failures return atomic error envelopes; no partial result is produced.
- Node selects `maxDecisionBytes` only for the decision input. `maxInputBytes` remains 64 MiB for original sources and run artifacts. Defaults merge with private runtime injection so existing small source-only tests remain correct. No CLI budget override was added and no reconciliation logic was duplicated in Node.
- Applied export decisions are a deduplicated subset of admitted actions, preserving canonical action/ID/reason values, so their canonical CSV remains <=100000 rows/64 MiB. Both original sources have <=100000 records each, so <=200000 record blanks; candidate graph has <=100000 candidate pairs, so <=100000 suggestion blanks. Longest valid exported ID is `L100000` or `R100000` (7 ASCII bytes). Empty-action record rows use <=11 bytes; pair rows <=18 bytes. Additional blanks total <=200000*11+100000*18 = **4000000 bytes**. Header is already counted once by active CSV. Total template <=400000 data rows and <=67108864+4000000 = **71108864 bytes < 134217728**, hence export/import row and byte closure. Arbitrary edited junk still must satisfy raw/active intake limits.
- R2 prose now gives equal only for identical raw decimal strings AND transformed delta zero; other in-tolerance values are equivalent. Invalid typed evidence scores remain null with diagnostics, distinct from missing/empty zero evidence.
- R3 prose distinguishes automatic locked valid unique exact keys from human acceptance of candidates/remaining records.
- R4 limits the claim to no additional third-party npm dependencies, acknowledging the toolchain/core, Node, Actions and installer dependency surface.
- Binding spec/plan, architecture/configuration/review/limitations and acceptance matrix/index reflect role budgets and exact test scales. Historical dated evidence and the original ten rulings remain untouched. Root-owned new ruling/evidence files excluded from staging.

## Fresh verification

Process environment for all moon/build commands: `MOON_HOME=/private/tmp/moonreconcile-task8-toolchain`, `MOONBIT_HOME=/private/tmp/moonreconcile-task8-toolchain`, prepend that `bin` to PATH. No global settings changed. Runtime: Node `v24.15.0`; moon `0.1.20260920 (914d7da 2026-09-20)`.

- `moon info` exit0; `moon fmt` exit0. `git diff -- '*.mbti'` empty: no public API changes.
- `moon check --target js` exit0, no warnings/errors.
- `moon test --target js` exit0: **95 tests, 95 passed, 0 failed**.
- `npm test` exit0: fresh `npm run build`, **56 Node tests, 56 passed, 0 failed**. Includes 200 independent cumulative-review/state/field/exit cases, production101x101 fully reviewed incomplete/exit3, new pure-invoke atomic raw/active boundary tests, production template replay, existing host filesystem/exports/rules regressions. Full stdout retained in `final-fix-npm-test.log` beside this report.
- Targeted new core `decision_*` run: 9/9 pass; private raw/active/canonical escaping tests included. Existing source limits and new source-role small-byte parser test passed in `*budget*` run (8/8), then full core suite.
- Targeted fresh CLI run `node --test --test-name-pattern='production 50001|decision raw byte guard' tests/cli.test.mjs`: **2/2 passed**. Actual production test performs compare, unchanged100002-row replay, adds one reject, and replays exported100003-row cumulative template; preserves ordered exact L1..L50001/R1..R50001, all100002 pending states/unresolved count, cumulative decision counts0/1/1 and exact source snapshot text.
- Source100000/100001 rows,256/257 cols and64KiB cell tests use production constants. New decision400000/400001 raw rows and100000/100001 active rows use production constants at parser level; active fixture contains repeated reject actions and does not invoke100000-action application.
- Byte guards use private small thresholds: source11/10 bytes (BOM,UTF-8,CRLF), raw decision43/42 bytes, active73/72 bytes (31 header+15 ASCII+27 Unicode/quote/comma/CR/LF), unnecessarily quoted raw-to-canonical46/45 bytes, header-only31/30 bytes, host decision2039/2038 raw bytes with independent1024-byte source budget. These do not claim giant max throughput.
- `git diff --check` exit0.

## Concerns and unverified scope

No known remaining R1–R4 defect. Byte composition defect was source-derived, not reproduced with a giant near64MiB fixture. No literal64MiB source/active file,128MiB raw decision,20000000-DP-cell or combined maximum end-to-end throughput/memory test was run. Maximum-action application can have substantial scan/sort cost; this fix certifies admission/closure, not an SLA. Full historical performance matrix was not repeated. Root still owns changed-scope independent rereview, exact-SHA release gates, remote CI and publication. No push performed.

## Local commit and handoff

`git diff --cached --check` exit0; `git commit -m "fix: close decision template intake budgets and correct review docs"` exit0. Exact HEAD `0bcf96753df06a7eeedb74fb30c2db7ac24b2eb7`. Branch remains `feature/initial-product`, ahead10; no push. After commit only root-owned modified `docs/evidence/implementation-rulings.md` and four root-owned new evidence files remain unstaged; executor-owned tracked worktree changes are empty. Required fresh gates above ran immediately before this commit; final change after gates was documentation wording only. Root owns independent scoped rereview and release/publication.
