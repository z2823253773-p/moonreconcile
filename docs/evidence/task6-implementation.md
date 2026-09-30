# Task 6 implementation report

## Recorded revision

- Branch: `feature/initial-product`
- Commit: `ed0eeba35b7751fb3810d967922ccddde33ec93d`
- Task 5 base before Task 6: `3ae6245` (`Accept human review and preserve independent replay oracles`)
- Scope commit: tracked Task 6 host implementation, build script, `package.json` and Node CLI tests only. No push performed, no other project touched.

## Test-first evidence and gates

The Node suite was written before the host existed. The first `node --test tests/cli.test.mjs` run could not load the CLI entry point and reported `1` test, `0` pass, `1` fail with `ERR_MODULE_NOT_FOUND` for `cli/main.mjs`, confirming the new suite was exercising behavior that was not implemented yet.

Final checks on the committed source:

- `npm run build` — passed (`moon build cmd/bridge --target js`, "no work to do").
- `moon test --target js` — 82 tests passed, 0 failed.
- `node --test tests/*.test.mjs` — 43 tests passed, 0 failed (34 Task 6 CLI tests plus the 9 pre-existing bridge/decision tests).
- `git diff --check` — clean before commit.
- Commit: `ed0eeba35b7751fb3810d967922ccddde33ec93d`.

## Implementation

- Added `cli/main.mjs`, `cli/io.mjs`, `cli/render.mjs`, `cli/bridge.mjs`, `scripts/build.mjs` and the Node CLI test suite. `package.json` gained `bin.reconcile` and the `build` script; `npm test` now runs the build then the Node suite.
- Every business question goes through the single exported bridge `invoke` with JSON in and JSON out. The host only parses arguments, reads, hashes, canonicalizes, validates manifests and publishes files; no matching, scoring or numeric comparison logic lives in Node.
- Canonical configuration serialization uses an explicit recursive writer with lexical key ordering, array order preserved, no indentation and exactly one final newline, so numeric-looking map keys are not reordered the way `JSON.stringify` reorders integer-like properties. Hashes are taken over the actual UTF-8 bytes.
- Fatal UTF-8 decoding uses `TextDecoder` with `fatal` and `ignoreBOM`, so a single leading byte-order mark stays in the decoded string and in the snapshot bytes, while any further `U+FEFF` is rejected as `invalid_encoding`.
- A 64 MiB raw-byte input budget is enforced by stat-before-allocate plus a post-read growth check. Only the internal runtime seam can lower it; the CLI exposes no production override.
- Publication is transactional: each run directory and each exclusive config file is written to a sibling staging path, flushed, and published by rename or atomic `link`, with owned staging removed on any failure. Destinations must be absent or empty and must not be symlinks; alias and source-run containment checks resolve symlinks with `realpath` rather than string prefixes.
- `resolve` validates the manifest, then snapshot sizes and digests, then the config digest and canonical form, then recomputes the run id, and only then invokes the engine. Source runs stay read-only and destinations may not sit inside or alias them.
- The run id is `sha256` of the JSON array `[engine_version, left_sha256, right_sha256, config_sha256]`, so it is stable across timestamps and independent of machine state. A reviewed run keeps the parent run id and records the decision file digest as provenance.
- The decision export is cumulative and editable: applied decisions are preserved in core order and remaining opportunities appear as blank rows. A suggestion is never prefilled as a new recommendation. `report.json` is the direct locked Result; nested evidence is written as compact JSON cells so no field is dropped by a flat table.
- `summary.md` reports computation coverage separately from review status and from unresolved business differences. Human-confirmed unmatched records stay visible as differences.
- Exit handling follows priority `2 > 3 > 1 > 0`: validation and I/O failures report a structured fatal error on stderr and publish nothing, while 0, 1 and 3 all publish the full set of eleven files with the core exit code.

## Decisions

- `checkDiskSpace` treats an unsupported `statfs` (`ENOSYS`, `ENOTSUP`, `EOPNOTSUPP`, `EINVAL`, `EPERM`, `EACCES`), partial stats, or a runtime without `statfs` as advisory: it warns and continues with checked writes. Any other filesystem error is a real I/O failure and aborts with `io_error`.
- The manifest fingerprint check runs before the engine is invoked, so a tampered run is rejected without the host re-deriving any engine semantics. A tampered byte size therefore surfaces as `fingerprint_mismatch`, not `invalid_manifest`.
- The reviewed run reuses the stored canonical `config.json` bytes verbatim and additionally asserts the engine's re-normalized config canonicalizes to the same bytes, so a core normalization change cannot silently drift.
- The decision file has no hash lock, because it is meant to be edited and replayed; only snapshots and config are fingerprinted.

## Unverified limits

- The 64 MiB byte budget and the cell/record limits are tested with synthetic fixtures; throughput and memory behavior on real workflow data have not been benchmarked.
- The disk-space precheck is advisory by design, so a genuinely full disk surfaces as a write failure during publication rather than being predicted in every case.
- Real user input files, XLSX and other non-CSV sources, and production data compatibility remain unverified. Task 7 (public-command acceptance) and Task 8 (CI toolchain) were not implemented here.

## fixround1 repair report

- Reviewed base: `ed0eeba35b7751fb3810d967922ccddde33ec93d`.
- Repair commit: `4304f75c8fafbde63e2a6be8d88cbfa4a116bea9`.
- Scope: `cli/io.mjs`, `cli/main.mjs`, `cli/render.mjs`, and `tests/cli.test.mjs`; no MoonBit business logic, Task 7 feature, or push.

### Regressions and repairs

The first regression run was intentionally red. `node --check tests/cli.test.mjs && node --test tests/cli.test.mjs` exited 1 with 8 failing regression cases: a source-run descendant named `..reviewed` (including a symlink alias) was published; interior U+FEFF in canonical config made resolve fail; rejecting a candidate removed pending endpoints from the editable template; HTML/link/emphasis/code in headers remained active Markdown; run and init-config close errors were swallowed; an unowned exclusive-create collision was deleted; and unsupported hard-link publication fell back to rename. The cleanup reporting case was added after that baseline and then verified green.

- Containment now rejects only actual parent path segments (`..` or `../...`), so valid names beginning with two dots remain descendants and are blocked, including after symlink canonicalization.
- File handles propagate close errors when no earlier write/sync error exists; if both occur, the earlier operation error remains primary. The regressions inject real `writeFile`, `sync`, and `close` failures on run and init-config paths and assert that no incomplete destination is treated as published.
- `init-config` now stages inside a uniquely acquired sibling directory, tracks file ownership from successful `wx` open, removes only its own staged file, and reports the residual staging path when cleanup fails. Atomic hard-link publication remains the only publish primitive; unsupported no-replace operation returns `io_error` with no rename fallback.
- JSON configuration decoding permits U+FEFF string values while preserving fatal UTF-8 decoding; CSV decoding continues to reject double and interior byte-order marks. A canonical run containing mapped U+FEFF data now resolves from its untouched blank template.
- The cumulative decisions template retains blank rows for both pending endpoints after a rejected pair. Markdown values escape HTML delimiters and active inline markup, with controlled source line breaks still rendered as `<br>`.

### Verification

- Red baseline: `node --check tests/cli.test.mjs && node --test tests/cli.test.mjs` — exit 1, 8 of 41 tests failed on the reported defects.
- Focused repaired regressions: `node --test --test-name-pattern='U\\+FEFF|rejecting a candidate|source headers|resolve refuses destinations|file close failure|init-config close failure|unowned staging collision|atomic no-replace|staging cleanup' tests/cli.test.mjs` — 9 selected tests passed at that point. Later single-file cleanup regressions also passed in focused runs.
- Final `npm run build` — exit 0 (`Finished. moon: no work to do`).
- Final `moon check --target js` — exit 0.
- Final `moon test --target js` — 82 passed, 0 failed.
- Final `node --test tests/*.test.mjs` — 53 passed, 0 failed; the independent cumulative-review oracle reported 200 cases passed and retained the production 101×101 incomplete/exit-3 result.
- Final `git diff --check HEAD^ HEAD` — clean. Commit `4304f75c8fafbde63e2a6be8d88cbfa4a116bea9` contains only the four scoped CLI/test files.

### Boundaries

The no-replace config publication depends on same-filesystem hard-link support. If unavailable, init-config now fails clearly with exit 2 and preserves no-overwrite semantics; no portable rename fallback is claimed. The regression uses filesystem fault injection for unsupported links and deterministic collision/error interleavings; it does not claim physical unsupported-filesystem or power-loss testing. Fresh independent Astra review remains pending.
