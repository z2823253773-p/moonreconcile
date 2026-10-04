# Task 2 implementation evidence

Status: **BLOCKED / partial implementation**. This checkout contains a working local CSV upload → inspect/import → check_config → compare path, but it does not meet the complete Task 2 contract. Do not proceed to Task 3 until the remaining contracts below are implemented and independently reviewed.

| Evidence | Result |
| --- | --- |
| Base | `a52122c5aa915e17ff7abbe8835c0f59cdcd21ea` |
| Implementation HEAD | `00584fb319b34296171a4ac2fc9a42674d59e792` |
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
