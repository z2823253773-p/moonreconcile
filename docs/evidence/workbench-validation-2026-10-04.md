# Precompiled workbench validation evidence

Validation run: 2026-10-08 (Asia/Shanghai). The filename is retained from the Task 6 contract; this evidence records the October 8 package and source.

## Exact source and package

- Source SHA, worktree cleanliness, package archive hash, and bridge hash for the latest strict gate are recorded in the generated machine-readable evidence: [`workbench-package-validation-2026-10-08.json`](../../dist/workbench-package-validation-2026-10-08.json). The ZIP is timestamped, so rebuilds can have a different archive hash while carrying the same files.
- Exact source implementation and follow-up link-fix commits are recorded in the local `.superpowers/sdd/2026-10-04-local-workbench/task-6-report.md` handoff. The report lives in ignored retained plan workspace, not in the package.

## Local checks

| Command | Result |
| --- | --- |
| `moon check --target js` | exit 0 |
| `moon test --target js` | exit 0; 100 passed |
| `moon info` / `moon fmt --check` | both exit 0 |
| `npm test` | ordinary sandbox attempt hit loopback `EPERM`; authorized local run exit 0, 185 passed |
| `npm run test:workbench` | exit 0; 123 passed |
| `npm run test:workbench:e2e` | exit 0; 5 tests passed |
| Node 22 `node --test tests/workbench-package.test.mjs` | exit 0; 6 passed |
| assignment oracle | exit 0; 240 exhaustive goldens |
| independent library consumer | exit 0; 102 passed against the exact archived source SHA |
| `npm run test:workflows` | exit 0; three workflow chains and seven mutations passed |
| `npm run test:public-data` | exit 0; 2558/2569 records, 11 additions, 18 changed fields |
| `node scripts/readme-smoke.mjs` | exit 0; nine documented commands passed from a fresh clone |

The package gate used the controlled Node `v22.23.3` binary (SHA-256 `68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b`). Its relocated runtime PATH contained only Node; npm, Moon, and Python probes returned unavailable. On macOS, `sandbox-exec` denied outbound networking (`EPERM`) while allowing local loopback. The unsandboxed positive control reached `1.1.1.1:443`. Upload/import/config check/compare/review, independent packaged CLI replay, ZIP export/reset/restore all passed; the reviewed report hash was `16b3362281d37c78718c533f0c53551b00dcd74ca9dfa66a81244f888409112b` before and after CLI replay and ZIP restore.

The package workflow's UI was not independently exercised by this report. Root-controller final packaged-browser acceptance and screenshots are pending separately. Remote Ubuntu/macOS CI, real users, customer benefit, contest acceptance, and XLSX/B remain unverified or out of scope.
