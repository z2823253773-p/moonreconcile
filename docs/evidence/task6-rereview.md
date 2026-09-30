# Task 6 fixround1 scoped independent re-review

- Exact revision: `4304f75c8fafbde63e2a6be8d88cbfa4a116bea9`.
- Comparison base: `ed0eeba35b7751fb3810d967922ccddde33ec93d`.
- **Scoped SPEC PASS / QUALITY PASS. All seven prior findings ADDRESSED.** No new blocking regression found in the changed paths inspected.
- Scope: the seven findings in task-6-review.md, the four-file repair diff, added/modified regression tests, updated task-6-report.md, and directly affected I/O/encoding/rendering behavior. This is not a fresh broad audit of Task 5 or unchanged CLI paths.

## Findings disposition

| Prior finding | Disposition | Independent evidence |
| --- | --- | --- |
| P1 `..reviewed` source-run containment bypass | ADDRESSED | Actual relative parent segments are distinguished from ordinary names beginning with two dots. Both direct `run/..reviewed` and symlink-alias variants return 2/output_conflict, create no output and leave source directory entries unchanged. |
| P1 swallowed file-close failure | ADDRESSED | Real file handles wrapped to close then throw: compare and init-config both return 2, no success stdout, no destination. Separate write/sync plus close faults retain the primary write/sync error. |
| P2 cleanup deletes unowned config staging collision | ADDRESSED | Staging directory acquired with mkdtemp. Ownership callback runs immediately after successful wx open, before write/sync/close. Injected foreign config.json causes EEXIST; sentinel survives, destination absent, residual staging path reported. Successful-open-then-write-failure and successful-open-then-close-failure both clean owned files and staging. |
| P2 escaped U+FEFF config becomes unreplayable | ADDRESSED | Prior end-to-end fixture now returns 1 on compare and 1 on resolve, preserves literal U+FEFF canonical string data and identical run ID. Fatal malformed UTF-8 remains fatal for both JSON and CSV; CSV initial BOM is preserved and double/interior BOM still rejected. |
| P2 reject removes pending endpoint template rows | ADDRESSED | One rejected candidate leaves unresolved count 2; exported cumulative template retains reject plus `,L1,,` and `,,R1,` blank rows. Existing cumulative accept replay still works. |
| P2 active HTML/link/emphasis/code source headers | ADDRESSED | Prior `<details><summary>…`, `[click](…)`, `**bold**`, and backtick payloads are escaped; additional ampersand/backslash payload is preserved literally in generated Markdown. Controlled newline conversion stays in the renderer. |
| P2 unsupported hardlink fallback overwrites destination | ADDRESSED | Fallback rename removed. Injected ENOTSUP returns 2/io_error with atomic-no-replacement context, empty stdout, zero rename calls and no destination. Normal native hardlink publication successfully writes a draft config. Accepted controller ruling: unsupported filesystems lose availability rather than no-overwrite safety. |

## Additional directly affected checks

- Injected primary link error plus failed owned unlink: error retains the original publication failure, identifies cleanup failure and gives the actual residual staging directory; residual owned file remains inspectable. No destination is published in this case.
- Static check of post-publication cleanup: a cleanup failure returns a clear error and preserves the already published complete destination; it does not delete the published file. This matches the new explicit regression and does not claim rollback of completed publication.
- Reused the prior independent positive probe against the new archive: exact BOM/CRLF/Unicode/multiline snapshots; original source deletion; two cumulative review rounds; current decision-byte hash and unchanged run/parent IDs; prior report immutability; repeated replay semantic equality. All passed.
- No matching, scoring, decimal/date, decision-core or incomplete-history changes exist in this repair diff. No reason found to rerun unchanged core/oracle suites solely for this scoped review.

## Reproducible evidence

The exact commit was extracted with git archive into `/private/tmp/task6-rereview.p0r084`. Its own `npm run build` completed successfully (3 build tasks). Probes imported this archive's CLI and real generated bridge; no mutable source checkout module was used.

- `/private/tmp/task6-rereview.p0r084/scoped-probe.mjs`
- `/private/tmp/task6-rereview.p0r084/scoped-results.txt`
- `/private/tmp/task6-rereview.p0r084/positive-probe.mjs`
- `/private/tmp/task6-rereview.p0r084/positive-results.txt`
- Synthetic fixture outputs: `/private/tmp/task6-scoped.8W1eKK` and `/private/tmp/task6-positive.2lgD9C`.

The updated implementation report records 82 MoonBit / 53 Node gates green. Those are implementer/controller full-suite evidence and were not duplicated by this reviewer. Current independent evidence is the archive build and targeted probes above. Node runtime remains v24.15.0.

## Residual scope

No Node 22, Windows, physical unsupported filesystem, real disk exhaustion, power-loss or adversarial directory-rename test. Markdown review covers the previously reported CommonMark HTML/inline payloads and the changed escaping path, not every downstream renderer extension. The earlier broader review's boundaries remain unchanged. No tracked files edited, no commit or push, no subagent spawned. This ignored report is the sole repository change.
