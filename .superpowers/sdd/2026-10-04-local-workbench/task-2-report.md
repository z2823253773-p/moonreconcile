# Task 2 implementation evidence

Historical Luna handoff status (superseded by the Sol integration evidence below): **BLOCKED / partial implementation**. This checkout contains a working local CSV upload → inspect/import → check_config → compare path, but it does not meet the complete Task 2 contract. Do not proceed to Task 3 until the remaining contracts below are implemented and independently reviewed.

| Evidence | Result |
| --- | --- |
| Base | `a52122c5aa915e17ff7abbe8835c0f59cdcd21ea` |
| Implementation commit | `95676b470a1fd26ca8283030397137a1de1a10d4` |
| Build | `MOON_HOME=MOONBIT_HOME=/private/tmp/moonreconcile-task8-toolchain PATH=/private/tmp/moonreconcile-task8-toolchain/bin:$PATH npm run build` — exit 0, MoonBit reported no work |
| Initial red | `node --test tests/workbench-{host,server,jobs}.test.mjs` — exit 1, 3 files failed to load because workbench modules did not exist |
| Focused tests | `node --test tests/workbench-{host,server,jobs}.test.mjs` (loopback permission) — exit 0, 4/4 |
| Full suite | `MOON_HOME=MOONBIT_HOME=/private/tmp/moonreconcile-task8-toolchain PATH=/private/tmp/moonreconcile-task8-toolchain/bin:$PATH npm test` (loopback permission) — exit 0, build succeeded; 66/66 tests |
| Orders API smoke | Local loopback client uploaded examples/orders left/right/rules; imports returned 3 and 2 rows; check returned `draft:false`; compare published revision with `exit_code=1` |
| Host/path hygiene | `git diff --check` exit 0; base unchanged before commit |

Implemented files: `workbench/contracts.mjs`, `workbench/session.mjs`, `workbench/engine-host.mjs`, `workbench/worker.mjs`, `workbench/jobs.mjs`, `workbench/server.mjs`, `workbench/start.mjs`; focused tests: `tests/workbench-host.test.mjs`, `tests/workbench-jobs.test.mjs`, `tests/workbench-server.test.mjs`.

Known gaps that block Task 2 completion:

- Upload streaming is buffered before registration. Disconnect cleanup is not tested, shared upload/job disk reservations and 250 ms asynchronous quota supervision are absent, and active upload/reset coordination is incomplete.
- Cancellation does not yet establish the specified no-publish latch and `SIGTERM` → bounded `SIGKILL` → staging cleanup order for all race outcomes. Timeout, late result, quota failure preserving the previous revision, and reset while uploading have no failure tests.
- Session quota accounting is incomplete; reset is not exposed over HTTP; ownership/symlink refusal has no adversarial test. Runtime files are private by default, but no test asserts 0700/0600.
- Job response budget checks a completed result, but preview-row reduction before publication is not implemented. Oversize item evidence exports and their same-origin ErrorDTO guidance are missing.
- `/api/examples/:name`, config export, run summary/collections/item exports, run cell and session reset routes are missing. No static allowlisted explanation page is served. Unsupported review/branch/bundle/restore remain 404 as expected for later tasks.
- CLI exit-2 strict machine-error extraction/path sanitization, complete strict DTO validation, IDs/field allowlists for every route, session bytes/assets/imports/revisions limits and close/reset races require additional work.
- Added tests exercise DTO dispatch, bearer/origin/Host/forwarding behavior and raw upload cap. They do not cover all required cancellation, disconnection, quota, cleanup and output-size failure contracts.

The first ordinary-sandbox localhost test attempt failed with `listen EPERM`; loopback-only tests were rerun with the controller-authorized escalation and passed. The full suite passed under that same local-only permission. No external network request, checkout switch, or push was performed.


## Sol integration — 2026-10-04

Status: **Task 2 interfaces implemented; required local gates pass; independent review pending.** The historical Luna gap list above describes the pre-integration checkout, not the current implementation.

- Original Task 2 base: `a52122c5aa915e17ff7abbe8835c0f59cdcd21ea`.
- Sol integration base: `031ab1221a06897bcdca22fcf48a5fdb0dc71a7b` (clean handoff).
- Sol implementation HEAD: `918e2fa1f381276e4dce943fd0b66df6433e5202`; commit message: `feat: add isolated local workbench service`.
- Only `workbench/*.mjs` and the three specified workbench test files changed in that implementation commit. This report is a subsequent evidence-only commit; its checkout HEAD is available with `git rev-parse HEAD`. The tracked report resides under an ignored SDD directory, so only this exact report path is force-staged. No core/CLI/version/dependency change, main-checkout modification, push or child agent.

Implemented: streaming upload with disconnect/timeout/close cleanup and active-reset refusal; shared upload/job reservations and parent asynchronous 250ms quota monitoring; TERM → 1000ms KILL supervision with exit-before-cleanup; candidate IPC only, exit-before-publication, final generation/state/head check and registry/job success commit without await; owned realpath/marker/symlink checks; strict DTO/body/query/ID and origin/Host/token controls; bounded CLI machine-error extraction and path/stack sanitization; final Job-envelope whole-row preview reduction before import registration; config file export; four real examples using import/check; run summary/structure, collections with original source_index, evidence item exports, report/summary/decisions exports, revision cells, and confirmed reset. Initial drafts remain explicit type=null, syntax checking binds canonical config to the import pair, and compare remains the business authority.

| Command / evidence | Actual result |
| --- | --- |
| `MOON_HOME=MOONBIT_HOME=/private/tmp/moonreconcile-task8-toolchain PATH=/private/tmp/moonreconcile-task8-toolchain/bin:$PATH npm run build` | exit 0; MoonBit reported no work |
| RED `node --test tests/workbench-host.test.mjs` | exit 1; 2/4 failed for missing strict DTO validation and exit2 ErrorDTO extraction; orders byte comparison and unknown-kind refusal passed after correcting the test runtime callback shape |
| RED `node --test tests/workbench-jobs.test.mjs` | exit 1; 4/5 failed for missing reservation and candidate/cancel/timeout/quota behavior; root ownership refusal passed |
| RED `node --test tests/workbench-server.test.mjs` | new real-example route failed (404). The later stream/reset fixture hung on the old missing reset route and was interrupted (exit 1); no completed RED server-suite count is claimed. The final completed server suite is green |
| RED added malformed preview IPC gate | exit 1; arbitrary internal-path object was incorrectly published as a preview; now exact Preview/Cell DTO output is checked before commit |
| `node --test tests/workbench-{host,jobs,server}.test.mjs` | exit 0; 22/22 passed. Follow-up strengthening of timeout/quota to use a real published CLI revision: jobs 7/7 passed |
| `MOON_HOME=MOONBIT_HOME=/private/tmp/moonreconcile-task8-toolchain PATH=/private/tmp/moonreconcile-task8-toolchain/bin:$PATH npm test` | exit 0; build and all 84/84 Node tests passed, including the strengthened 22 Task2 tests |
| `moon info` then `moon fmt`, with the isolated toolchain environment above | both exit 0; no core/interface/source diff introduced |
| `moon test --target js`, same toolchain | exit 0; 100/100 MoonBit tests |
| `node /private/tmp/task2-start-smoke.mjs` (spawns `node workbench/start.mjs`) | exit 0; actual raw left/right/config upload → import/check/compare exit1 → preview cancellation → capabilities → SIGTERM normal cleanup |
| `git diff --check` | exit 0 before implementation commit |

Specific evidence: orders host/CLI `report.json` bytes match exactly; real API exits 0/1/3 publish valid revisions and exit2 publishes none; timeout/quota tests preserve the actual prior report bytes/hash. A SIGTERM-ignoring fixture reaches SIGKILL, leaves no task staging, and never commits its late candidate; another cancellation occurs during awaited publication preparation. No-length overflow and disconnected uploads register no asset; uploads prevent reset; timeout and close terminate writers before workspace removal. The slow synchronous bridge runs in the child while capabilities returns below 1000ms on this test machine. All four packaged example inputs were exercised, and runtime directory/file permissions were recursively checked as 0700/0600. A large canonical config (>1MiB) succeeds through the raw config asset path after orchestration JSON is rejected; wide previews shrink complete rows before publishing and an impossible final envelope registers no import. Oversize field evidence returns a six-field ErrorDTO with a same-origin relative full-evidence export, which returns the complete 4000-character raw value.

Limits/timeouts were fault-injected downward where needed (including quota polling/kill delay) for reproducible tests. These tests do not claim full 1GiB/max-core-input throughput or instantaneous zero disk overshoot; production supervision is every 250ms. Node used here: v24.15.0. Loopback tests required the explicitly authorized local-only sandbox escalation; no external network was used.

Remaining scope belongs to later tasks: Task3 GUI, Task4 review/branch actions, Task5 ZIP bundle/restore success routes, Task6 Node22 relocated/offline packaging and browser gates. Those routes remain 404 and capabilities remains CSV-only. No known unimplemented Task2 interface/gate remains in this local implementation; independent review has not yet run.
