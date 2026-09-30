# Task 1 implementation report (controller audit)

Current branch: feature/initial-product.
Implementation commit: 67c3263e2cecda1e1ee178640db9d8475d85f4aa. Public-documentation/license correction: b4be7965ee58a93c7e8b98dad05545ed667b6c0b. The latter does not change engine logic. Reviewed tree HEAD is b4be7965ee58a93c7e8b98dad05545ed667b6c0b.

Fresh local commands and outcomes on 2026-09-30:
- `moon check --target js`: exit 0, no diagnostics.
- `moon test --target js`: exit 0, 11 passed, 0 failed.
- `npm test`: exit 0, 6 passed, 0 failed. This builds the JS bridge and runs Node tests.
- `git diff --check`: exit 0 before commit.
- `git status --porcelain=v1`: empty after push.

Independent remote confirmation: `gh api .../branches/feature/initial-product` and `git ls-remote` returned HEAD SHA b4be7965ee58a93c7e8b98dad05545ed667b6c0b. Public README API returned README.md blob SHA 31d0cd1a26c97cbffa207c85b978dc0042122670. Repo visibility PUBLIC. This proves delivery of Task 1 branch only, not full product or CI.

Historical failing baseline and exact red-test command were reported by Claude Code but not re-run or independently archived by controller. The source admits `compare` and `resolve` return unsupported_operation. No CLI/full reports/demo/performance/remote CI yet.

Task-specific concern for independent reviewer: check strict parser empty/trailing records and output limits; check config validation against locked JSON contract, including unknown properties, budget, and key semantics; check unsupported ops explicitly error; check public README/license consistent. Do not treat 11+6 basic tests as evidence for later tasks.

## GPT-6-Luna repair report

Status: **DONE** for assigned findings I1–I6 and M1–M3. I7 was handled separately by the coordinating agent; its probe files and dependency-audit edits are outside the implementation commit below.

RED evidence:
- Added boundary and rejection tests first. On the isolated core tree, moon test --target js reported 21 tests, 11 passed and 10 failed on the intended defects: missing column/row/cell limits, missing CSV field location, wrongly defaulted type errors, irrelevant tolerances, integer saturation, identity-only mapping, decimal digit/scale bounds, and omitted blocking normalization.
- The added positive-sign tolerance case was separately run before its fix: moon test --target js --filter decimal_tolerance_accepts_optional_positive_sign_but_rejects_negative reported 1 failed as expected.

Fixes:
- CSV now checks the 64 MiB UTF-8 text budget before expanding into characters, and enforces 256 columns, 100000 data records, and 65536 UTF-8 bytes per cell while parsing. The 64 MiB counter is tested at its exact/over boundary with a smaller injected test budget, including multibyte characters; production uses the fixed 64 MiB value.
- CSV syntax and budget errors include the current header name when known, otherwise a column identifier.
- Configuration defaults apply only when a property is absent. Present values of the wrong JSON type are rejected. Irrelevant nondefault tolerances are rejected; integer parsing checks the supported Int range before conversion; decimal tolerances enforce at most 64 digits and 18 fractional digits. A leading plus is accepted for nonnegative decimal tolerances and preserved; negative tolerances are rejected.
- Identity-only fields may use explicit side value maps. Missing candidate blocking normalizes to an empty array, and a parse-normalize-parse round trip is covered.
- Renamed the Node malformed-CSV test and removed its ineffective leading-zero claim. The MoonBit CSV test directly verifies that 001 remains unchanged.

Green evidence on the repository working tree after moon info && moon fmt:
- moon test --target js: exit 0, 23 passed, 0 failed.
- npm test: exit 0, build succeeded; 6 passed, 0 failed.
- git diff --check: exit 0.

Implementation commit: 5faf1bc6380ece250a8fda4084d8522dad3a4caf (fix: enforce task1 input and config contracts). Local commit only; not pushed.
