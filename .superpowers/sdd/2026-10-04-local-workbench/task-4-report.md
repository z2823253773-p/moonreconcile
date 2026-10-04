# Task 4 implementation report

Base: `f5b3a5ce51d7fd020585573b1feb78e0159b258c`
Branch: `feature/quarter-workbench`
Scope: versioned review, cumulative decisions, original Result evidence and branch rebinding. No Task 5/6/B work was started.

## Implemented

- Added real `review` and `branch` jobs. Resolve and branch use the selected revision's registered baseline CSV/config snapshot. Review validates the requested parent revision and baseline head before starting, rechecks the head synchronously at publication, and rejects a child Result that omits any complete parent `(action,left_id,right_id,reason)` tuple. The baseline head is changed only after the result is committed; each published Result receives a new `revision_id` while resolve retains the `run_id`.
- The browser review model serializes cumulative decisions with the existing `renderCsv` implementation. It does not parse CSV or decide whether an action is authorized. `/cli/render.mjs` is served through one exact fixed static route mapped to `../../cli/render.mjs`; query strings and all other non-whitelisted paths remain unavailable. Existing exact Host, Origin and fetch-site checks apply to it.
- Added Result summary and evidence UI for the existing summary/computation/structure/issue values; fields, candidates, records, issues, pairs and decisions preserve core order and original evidence fields. Each collection has bounded pagination and its native filters; Next uses the server's `next_offset`/`has_more`, and Previous returns to remembered offsets. Full item downloads and original-revision source-cell reads are available for every record status.
- Candidate actions show all competing scores/suggestions/diagnostics and never auto-accept a top score. Exact-key pair locks come from a complete paginated pair read and remain independent of visible page changes. Applied decisions are read-only; pending actions can be removed. Manual decisions and uploaded cumulative CSV are sent to core `resolve` without frontend parsing. A failed batch preserves the parent report and pending draft. Source/rule generation changes clear local unapplied drafts and prevent applying stale results.
- The current known head can explicitly branch even after input edits; older history entries remain read-only and cannot bypass the server's head check. Confirmation explains that the workbench inputs will return to the selected head's bound original files/config. The branch compares those snapshots, synchronizes the visible source metadata/previews and canonical config, then separately publishes the branch revision and clears stale state. This required `workbench/public/import-view.mjs` in addition to the original brief's file list.
- Job kind allowlist now admits `review` and `branch`, as directed by the controller ruling. Existing Task 2 auth, exact request schemas, quotas, cancellation and exit-before-commit paths are retained.

## Tests and observed output

- TDD focused regressions cover orders unmatched resolution (unresolved `0`, different `3`, exit `1`), catalog top-candidate rejection plus lower-score acceptance and unmatched right row, distinct revision/same run ID, complete-tuple/noncumulative rejection, atomic conflict failure and old-report hash retention, stale-parent rejection, original-snapshot branch, exact-key lock, manual-outside-candidate missing reason through core, reviewed 101×101 exit `3`, cumulative decision export/reimport byte-identical report, and cancelled resolve preserving the old hash/registry.
- An early combined focused run found two failures in newly added regressions (a route test used `Sec-Fetch-Site: none` with a query, which correctly remained disallowed, and a test predicate threw before pagination loaded). Both tests were corrected; later source-generation branch regression also caught and fixed an await guard that used the pre-edit generation.
- `npm test` with the isolated plan toolchain on PATH — **exit 0; 125/125 tests passed**. Full log: `/private/tmp/task4-npm-test-final.log`.
- `npm run test:workflows` with the isolated plan toolchain on PATH — **exit 0**; synthetic orders/migration/catalog compare/resolve/replay and seven mutation checks passed. Log: `/private/tmp/task4-workflows-final.log`.
- `git diff --check` — exit `0` before final report/commit.
- Browser-driven verification is owned by the controller and has not yet been claimed by this implementer. In particular, the earlier browser attempt correctly exposed a real `/cli/render.mjs` 404 and blocked review; the fixed exact route and focused security regression now pass. Controller should restart the service and perform fresh orders/catalog, cumulative reimport byte oracle, and source-edit→branch/rebind checks on the committed SHA.
- Node 22 package gate remains a later Task 6 check; no claim is made for it.

## Scope additions and limits

The two deliberate file-list additions are `workbench/jobs.mjs` (controller ruling: review/branch are real manager job kinds) and `workbench/public/import-view.mjs` (controller ruling: branch must update visible bindings, not only Store IDs/config). The static renderer route is exact and fixed; there is no general static-file fallback. No workbook/XLSX entry point was added.
