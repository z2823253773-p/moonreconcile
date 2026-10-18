# Task 5 narrow integration fix round 1 — 2026-10-08

## Status and source identity

R1 and R2 are implemented and pass the focused local gates below. Independent re-review remains required; this report does not accept Task 5 or establish Task 6/offline-package, browser E2E, remote CI, or XLSX readiness.

- Checkout: `/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench`, branch `feature/quarter-workbench`.
- Clean starting source: `da76545dc16e6b0d4a8b41a9ddee685fa562bd21`.
- Tested source/test commit: `66e1797dea7b8b5a0a9f78cdc53e0ad649966d3b` (`fix: reject contradictory bundle ZIP metadata`). This commit contains exactly the four files below. All focused GREEN checks exercised these bytes before commit; the commit did not change their contents.
- The subsequent report-only commit is a different HEAD identity, with the same product/test bytes. Its SHA is returned separately to the controller; it must not be substituted for the tested source commit without explaining this distinction.
- Node used: `/private/tmp/moonreconcile-quarter-node22/bin/node`, actual version `v22.23.3`.
- Generated bridge unchanged: `_build/js/debug/build/cmd/bridge/bridge.js` SHA-256 `e6f817bd20b68f9cd7b304759abeca5e0573a96554f970de798a651bc2d09bd0`.

## Exact changes

| File | Change |
| --- | --- |
| `workbench/archive.mjs` | Uses pinned yauzl 3.4.0 full `readLocalFileHeaderPromise(entry)` before opening each stream. Rejects local encryption/strong encryption; requires identical raw filenames, full general-purpose flags, and compression methods across local/central headers. When bit 3 is absent, also requires local CRC/compressed/uncompressed sizes to equal the central values. When bit 3 is present, permits local placeholders or populated values and retains the existing actual streamed size/CRC/hash checks. Creator 19 (OS X), like creator 3 (Unix), now rejects explicit nonregular POSIX types. |
| `tests/helpers/zip-mutations.mjs` | Test-only Python zipfile/struct mutations of a real yazl-generated package; locates the local entry using Python's `header_offset`, preserves compressed payload/central metadata for local mutations, and provides Python stored/deflated repacks. No handwritten production ZIP reader was added. |
| `tests/workbench-archive.test.mjs` | Adds 13 independent malformed-metadata rejection cases, verifies staging cleanup, and adds four valid compatibility controls. |
| `tests/workbench-archive-host.test.mjs` | Adds six real HTTP restore rejection/atomicity cases. Deep snapshots preserve the entire assets/imports/revisions/bindings/heads registries and owned directory list after upload; failure must publish no output, release the active job, preserve all snapshots and old report bytes. |

Malformed archive matrix: local traversal filename, differing whitelisted filename, encryption, strong-encryption, UTF-8 flag disagreement, descriptor flag disagreement, compression disagreement; creator-19 symlink/special/directory types; and local CRC/compressed-size/uncompressed-size disagreement in descriptor-free Python archives. Removing the corresponding checks makes these tests fail, as observed in RED.

Compatibility controls: unchanged production yazl roundtrip (including descriptor-zero placeholders), populated descriptor local CRC/sizes, creator-19 regular file, Python stored, and Python deflated packages. Existing production CLI replay and reviewed HTTP restore/branch checks remain green. This is not a promise to accept every ZIP creator or ZIP extension.

## Fresh executed verification

All commands ran from the checkout above. HTTP gates used authorized escalation only to listen on `127.0.0.1`; no bearer token was printed or retained. Relative log names below refer to `.superpowers/sdd/2026-10-04-local-workbench/task-5-fix-round1-evidence/`.

| Phase / command | Observed result | Log |
| --- | --- | --- |
| RED: Node22 `--test tests/workbench-archive.test.mjs` before production edits | 24 tests: 11 pass, 13 fail with `Missing expected rejection`; failures are exactly the 13 new rejection cases | `archive-red.log` |
| RED: Node22 `--test --test-name-pattern='HTTP restore rejects' tests/workbench-archive-host.test.mjs` before production edits | Six tests: all fail with actual `succeeded`, expected `failed` | `host-red.log` |
| GREEN: Node22 `--test tests/workbench-archive.test.mjs tests/workbench-ui.test.mjs tests/workbench-result.test.mjs` | Exit 0, 58/58 pass (archive 24 plus UI/result 34), zero skipped/cancelled/failures | `archive-ui-result-green.log` |
| GREEN: Node22 `--test tests/workbench-archive-host.test.mjs` | Exit 0, 17/17 pass | `host-green.log` |
| Final HTTP check after deepening snapshot assertions: same full archive-host command | Exit 0, 17/17 pass, zero skipped/cancelled/failures | `host-final-green.log` |
| Node22 `task-5-fix-round1-evidence/retained-fixture-probe.mjs` | Exit 0: retained valid baseline archive accepted and production restore report byte-equal; all three retained reviewer mutations rejected by both archive and production executeTask with `invalid_bundle`; rejected archive staging removed | `retained-fixture-green.log` |
| `git diff --check`; `git diff --cached --check` | Exit 0 before source commit | Controller tool output |
| Source commit/status and SHA-256 checks | Exact four source/test files committed; clean tracked checkout after source commit; generated bridge hash unchanged | `source-evidence-manifest.json` plus controller tool output |

RED commands saved full TAP logs, then used `tail` to display results; the outer shell's final exit 0 belongs to `tail`, not the failing Node test process. The RED evidence is the preserved TAP failures/counts; no separately captured Node RED exit status is claimed. GREEN commands ran the test process directly with output redirected and their actual process exit 0 was read from the tool.

An initial retained-fixture probe used URL `.pathname` on a Chinese path and failed with ENOENT before archive validation. The evidence-only script was corrected to `fileURLToPath`; the original diagnostic remains in `retained-fixture-path-error.log`. This is not a product regression or a passing validation result.

## Retained independent reviewer fixtures

Copied unchanged from `/private/tmp/task5-independent-probe-31Cl0G` into `task-5-fix-round1-evidence/reviewer-fixtures/`, with hashes in `reviewer-fixture-hashes.json`. They are ignored evidence, not product commit files. The reviewer report's hashes were independently recomputed and match:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `baseline.zip` | 5731 | `e42610b502d443da51afd69ac8f2dde068d75b31d6279b0b8d06a7436ca00eb6` |
| `local-path.zip` | 5731 | `912a4c59673ff78301f47cbfca0c821122de4a0f4bc197745a75dee8d0690895` |
| `local-encrypted.zip` | 5731 | `e2df2c05d22abfe4737271986fafbaea18b3cef2eb3fca3373233cb03e4ca967` |
| `osx-symlink.zip` | 5731 | `73a6df7b4b816da8fdfc60638f4ca9788d57c3c8dc2e7cd8d1f295b4370a4ab3` |

Retained baseline original/replayed report SHA-256: `9ad3a7139f11d2abcba4a18a54002b4452302ef04a577e534b45b24ea123af0a`.

## Boundaries and handoff

No changes to MoonBit business rules, bridge bytes, Config/manifest schemas, dependency pins, UI source, main checkout, global SDK, Task 6, or B/XLSX implementation. No push/merge/release. Historical broad suites, browser tests, dependency audit, workflow/public-data gates, and remote CI were not repeated for this narrow follow-up; the controller explicitly reserved broader gates for later. Ignored ledgers, toolchain, and prior evidence remain intact.

The next action is an independent scoped review of `da76545dc16e6b0d4a8b41a9ddee685fa562bd21..66e1797dea7b8b5a0a9f78cdc53e0ad649966d3b`, the new mutation utility (included in that commit), the fresh logs, and the original retained fixtures. Acceptance remains the reviewer's/controller's decision.
