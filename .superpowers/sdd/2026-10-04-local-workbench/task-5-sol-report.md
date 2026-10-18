# Task 5 Sol integration report — 2026-10-05

Status: implementation and local Task 5 gates passed; ready for independent review, not controller acceptance. Task 6/offline package and B/XLSX have not started. No push, release, main-checkout edit, SDK cleanup or ledger cleanup.

## Source identity and execution

Only implementation checkout: `/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench`, branch `feature/quarter-workbench`, base `ede6ac5cd01ee1487013550ac071635982cac55b`.

`task-5-evidence/source-manifest.json` records SHA-256 for every changed product/test/CI file and the actual generated bridge. The local commit containing this report is the reviewable integration snapshot; get its exact SHA with `git rev-parse HEAD`. No product source was changed after the final gates below. Saved console-log copies normalize trailing line whitespace; original captures remain under `/private/tmp/task5-sol-*`. The evidence manifest includes original-capture hashes when normalization changed a copy, and lists saved file hashes and byte counts; the report/evidence themselves are saved after the test run.

Node host: v24.15.0. Isolated compatibility runtime: `/private/tmp/moonreconcile-quarter-node22/bin/node`, v22.23.3. MoonBit: moon 0.1.20260920 (914d7da), moonc v0.10.14+7d59c7ec9. The existing isolated SDK was used and retained.

Formal browser: installed Google Chrome executable `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, version 154.0.8037.93. Playwright creates its own isolated temporary profile; the controller's `moonreconcile-quarter` CLI browser session was not used. Trace/video/auth navigation recording is off, the fragment is cleared, token checks assert booleans, and navigation exceptions redact the token. No token pattern matched the saved evidence scan.

## Delivered behavior

- Exact yauzl 3.4.0, yazl 3.3.1, buffer-crc32 1.0.0 runtime dependencies and development-only Playwright 1.63.0, with lockfile integrities. Streamed CRC uses buffer-crc32 without narrowing Node >=22 to >=22.2. The actual CRC vector was `cbf43926` for `123456789`.
- Worker-only whitelist ZIP write/read, exactly 12 files, schema/hash/byte/CRC/type/path validation, actual compressed/decompressed caps, and CLI resolve/report byte replay before restore publication. Historical sidecar IDs never look up local paths.
- Atomic restored assets/imports/config binding/self-baseline revision publication, preserving reviewed actions. Branch performs a fresh core compare of the original CSV/config and clears applied actions.
- Authenticated immutable report/summary/cumulative-decision downloads, ZIP save/restore/reset, pending-draft notice, cancellation, and consistent ErrorDTO formatting/record semantics. Pending actions are not included in published ZIPs.
- Global task reservations precede uploads/API awaits; bindings retain the outer lock; empty selection normalizes to null. Successful restore registers history/head before checking captured selection/source generation. A changed selection cannot be silently overwritten.
- Pending removal immediately updates Store. History selection clears the prior view's draft; rebuilding the same selected revision rehydrates its preserved Store draft. Cancelled compare restores the previous visible summary. Result task-label rendering follows shared job transitions.
- Restored the entire baseline CSS first line accidentally removed by the initial implementation, then added the export panel style. The verified 390px screenshot shows wrapped export controls within the page.
- Startup shutdown message is neutral and truthful: only previously downloaded ZIPs remain after local cleanup.
- CI code now installs locked dependencies, explicitly installs Playwright Chromium and runs the browser suite. The configuration honors explicit SDK/browser paths, uses the local SDK/Chrome only outside CI, and lets CI use its installed toolchain/browser. Remote CI has not run; this is local validation plus CI wiring.

## Final local gates

Current source gates are in `task-5-evidence/gates-verified-last/`, with exact commands, UTC timestamps, exit codes and logs in results.json. `MOON_HOME`/`MOONBIT_HOME` and PATH were process-scoped to the existing SDK.

| Gate | Actual result | Evidence |
| --- | --- | --- |
| moon check --target js | exit 0 | gates-verified-last/core-check.log |
| moon info; moon fmt; moon fmt --check | each exit 0; no MoonBit/interface diff | corresponding core logs |
| moon test --target js | 100/100, exit 0 | core-test.log |
| npm test | 162/162, exit 0 | npm-test.log |
| npm run test:workbench | 100/100, exit 0 | workbench.log |
| npm run test:workflows | synthetic orders/migration/catalog chains and seven mutation refusals, exit 0 | workflows.log |
| npm run test:public-data | actual pinned CN/FR 2558/2569 records, compare/review/replay bytes, exit 0 | public-data.log |
| npm run test:workbench:e2e | five full workflows passed, exit 0 | e2e-final.log |
| isolated Node 22 workbench suite | 99/99, exit 0, before the final pending-view two-line correction | node22-workbench.log |
| isolated Node 22 archive/UI/result suite | 41/41, exit 0, after that correction | node22-final.log |
| focused actual archive HTTP tests | 11/11, exit 0 | archive-host-latest.log |
| npm ls --all --json | exit 0, no dependency problems | npm-ls.json |
| npm audit --json --fetch-retries=0 --fetch-timeout=15000 | exit 0, metadata total vulnerabilities 0 | gates-final/audit.log |
| git diff --check | exit 0 | verified directly before commit |

The final Node 22 source correction only changes UI pending hydration/history clearing; the latest Node 22 41-test suite covers those changed modules. The 99-test Node 22 run covers the unchanged HTTP/archive host implementation. This is not an offline package gate.

E2E assertions use actual controls/downloads, not internal Store injections or API decisions represented as browser proof:

1. Orders starts from actual 3-left/2-right source values with distinct headers (explicit localized status substitutions), deletes unmatched draft columns through the blank form, sets mappings/types/key and string `0.02`, maps left 已支付/right settled to paid. Exact L1/R1 is locked; L3 is applied before ZIP/export. Downloads match an independently invoked CLI compare+resolve byte oracle. Source replacement makes the old result read-only. Reset removes source metadata; ZIP restores visible fresh sources/config and the applied decision. Restore report matches original bytes and a second CLI oracle. Nine major controls have 390px bounds and are reached by actual Tab traversal. Branch re-compares and clears actions; a file-input cumulative CSV replay reproduces the reviewed bytes.
2. Catalog changes the threshold through its form to 9000 and verifies actual `accept,L1,R1` without reason fails `manual_override_needs_reason`, decision data row 1, preserving report/draft. Threshold 8000 re-compares; UI rejects 10000-point L1/R2, accepts 8000-point L1/R1 and confirms R2 right_unmatched. Core conflict refuses the whole later batch; downloads/branch/cumulative replay match CLI bytes.
3. HTML-looking headers and a 3000-character Chinese value remain text; the full-value native dialog is exact, no image element or JS dialog executes. CSV syntax and invalid Config preserve location/error metadata.
4. Actual core compare with a controlled slow bridge is cancelled via UI. The previous visible summary/report bytes survive and controls unlock.
5. 101×101 candidate input configured through the blank form remains computation incomplete/exit 3 after UI review; downloads match the CLI oracle.

Actual HTTP archive tests additionally verify a self-consistent forged report fails replay without changing any registry/head/report; reviewed restore retains actions/fresh IDs/self-baseline; branch clears them through compare; actual production pack/restore execute before a fixture holds the child alive, DELETE waits for child exit before cleanup and cannot publish its candidate; configured writer zip/unzip limits reach the real worker.

## Failed attempts and corrections retained

- Default sandbox could not listen: historical npm 156 total/122 pass/34 fail and workbench 94/60/34, all listening failures `EPERM`; these predate the final cancellation-summary regression. Default formal E2E 0/5 also failed in beforeEach at listen EPERM. They are retained as environment failures, not browser behavior evidence.
- The one final escalation retry authorized by the handoff actually started. Its first full npm suite passed 157/157. Workbench 95 had 94 pass/one large-config `fetch ECONNRESET` failure. That failure was not blamed on the controller's concurrent probe.
- Focused original large-config and chunked keep-alive tests passed; a 20-request diagnostic produced no client failure but proved every default iterator early return changed unfinished req.complete=false requests from destroyed=false to destroyed=true. This identifies a premature-abort boundary, not a stable red/green reproduction of the observed ECONNRESET. The reader now uses iterator({destroyOnReturn:false}); the bounded 413 discards without buffering and closes its connection. Server 16/16, including unfinished-JSON shutdown, and both final complete suites passed. The new chunked regression passed before and after; do not claim it failed first.
- First real E2E was 2/5: three selectOption timeouts came from exact getByLabel matching label text containing option text. Snapshot accessible combobox names were correct; tests switched to role/name selectors, without changing product DOM.
- Following E2E attempts exposed the result job-label rerender issue (fixed with regression), then two test-only overbroad/wrong input locators: static “完整校验总行数” prose survived reset by design, so reset now asserts source-meta count zero; ZIP selection uses its actual aria-label. These failed logs are retained. Final full suite is 5/5.
- The initial npm audit attempt exited 1 with registry DNS ENOTFOUND. Docs were first downgraded, then updated only after the actual successful audit JSON was retained. Registry advisory audit is dated evidence, not a future security guarantee.

## Evidence and remaining acceptance

`task-5-evidence/screenshots/` contains final orders full-page/390px controls, catalog and HTML/error screenshots. The 390px controls image was visually inspected: report/summary/decisions/ZIP/restore/reset fit and the focus ring is visible. `orders-replay/` preserves actual UI-downloaded config/decisions/reports and source CSVs for byte checks. No authentication trace or browser profile is saved.

The controller's independent WIP API probe separately passed a reviewed valid bundle plus 13 malformed ZIP refusals and one self-consistent forged-report refusal, preserving old registries/report each time. That probe is controller-authored WIP evidence; its pinned-commit repetition remains the controller's job and is not substituted for this report's final gates.

Required next step: independent Sol review of the exact local commit and any controller acceptance checks. Node 22 relocation/offline network-isolated package proof belongs to Task 6; no such claim is made here. Main checkout, SDK, ignored ledgers and controller browser session remain outside this implementation's changes.
