# Task 6 independent spec and quality review

- Reviewed revision: `ed0eeba35b7751fb3810d967922ccddde33ec93d`, base `f8e7c49`.
- Verdict: **SPEC FAIL; QUALITY FAIL.** Do not accept Task 6 at this revision.
- Reviewer scope: AGENTS.md, spec sections 7–9, plan global constraints/locked JSON/Task 6, task-6 brief/preflight/report, the Task 6 diff and all four CLI modules/build script, selected integration tests. Existing 82 MoonBit / 43 Node gates are implementer/controller evidence, not independently rerun here.
- All executable probes used a `git archive` of the exact revision at `/private/tmp/task6-independent.Zx05kQ`, with its own successful `npm run build`. Runtime: Node v24.15.0. No tracked edits, commits or pushes; this ignored report is the only repository output.

## Blocking findings

### 1. [P1] A normal descendant beginning with `..` bypasses immutable-source containment

Location: `cli/io.mjs:193-195`, used by `assertDirectoryDestination` at lines 228–233.

`containsPath` rejects every relative path beginning with `..`, including legal child names such as `..reviewed`. Starting from a successful one-row exact compare, execute:

```sh
node cli/main.mjs resolve run --decisions run/decisions.csv --out run/..reviewed
```

Actual: exit **0**, success stdout, all reviewed artifacts created inside `run/..reviewed`; the source-run directory is mutated. Expected: exit 2, no source mutation. This is not a rename race or hostile concurrent change. Test the actual parent segment (`relative === '..'` or `relative.startsWith('..' + path.sep)`), retaining absolute-path checks. Add both literal-child and symlink-alias regression coverage.

### 2. [P1] File close errors are silently converted into successful publication

Location: `cli/io.mjs:272`, shared by run-directory and init-config publication.

The `finally` calls `handle.close().catch(() => {})` after write/fsync. A close error is a required checked I/O failure, not evidence the staged file is safe to publish. Independent fault injection wrapped only `wx` handles: close the real handle, then throw `EIO`. Comparing identical one-row CSVs returned **0**, empty stderr, success stdout and a published result after **all 11 closes reported EIO**. Expected: exit 2, no destination, owned staging cleaned. Preserve an earlier write/fsync failure if present; otherwise propagate close failure. Do not suppress the only failure in the operation. Directory-flush portability is a separate issue.

### 3. [P2] Exclusive config staging cleans a file it did not create

Location: `cli/io.mjs:376-399` (`publishFileExclusive`).

The generated temporary pathname is always removed in `finally`, even when opening it with `wx` failed with `EEXIST`. With Date.now/Math.random fixed in the isolated probe and a pre-existing sentinel at the computed `.reconcile-file-PID-123-0`, publication reports EEXIST but **deletes the sentinel**. An accidentally colliding prior artifact has the same behavior. This violates “cleanup only owned outputs”; it is independent of collision probability. Track successful acquisition/ownership or use an exclusively created staging directory; never unlink an unowned pathname. Cleanup failures for owned single-file staging are also currently swallowed rather than reported with the residual path.

### 4. [P2] JSON U+FEFF escaping makes a generated run unreplayable

Location: `cli/io.mjs:82-97`, called for config JSON in `cli/main.mjs` (readConfigJson and commandResolve).

Use `id\nx\n` on both sides and a valid config with `left_values:{"x":"\\uFEFF"}` and `right_values:{"x":"\\uFEFF"}` in its JSON source (one actual JSON Unicode escape, not a literal backslash value), no key. The core accepts this finite string map. Compare returns **1** and publishes a complete run. Canonical serialization outputs the actual U+FEFF inside each string. Resolve using that run's untouched blank decisions returns **2 invalid_encoding, phase config**, because the shared decoder treats any interior U+FEFF in JSON data as an illegal file BOM.

Fatal UTF-8 validity and CSV's BOM-placement rule must be separated. JSON string data can legitimately contain U+FEFF; the normalized config must replay regardless of input escape spelling. Maintain the required double/interior-BOM rejection for CSV. No CSV parser normalization change is requested.

### 5. [P2] Rejecting a pair removes unresolved records from the next editable template

Location: `cli/render.mjs:117-133`.

`decidedRecords` includes endpoints of `reject`, then filters those endpoints out of blank pending-side rows. Minimal input: one `id=1` row per side, no key, exact candidate scoring at threshold 1; resolve `reject,L1,R1,not same`.

Actual reviewed result: unresolved count **2**, both rows still pending (correct core semantics), but generated decisions.csv is only:

```csv
action,left_id,right_id,reason
reject,L1,R1,not same
```

No pending rows remain for the user to complete. Expected cumulative reject plus `,L1,,` and `,,R1,` review opportunities; a rejected relationship does not dispose either endpoint. Derive pending row visibility from core record status, or distinguish endpoint-consuming actions from rejection. JSON/unresolved.csv retain the rows, so this is a template/workflow defect, not a claim that core falsely resolves them.

### 6. [P2] Markdown source names are interpreted as active markup

Location: `cli/render.mjs:138-144`.

An unmapped CSV header containing `<details><summary>hidden</summary>`, `[click](https://example.com)`, `**bold**`, or backtick code is emitted literally into summary.md. The independent compare produced:

```text
- unmapped left: <details><summary>hidden</summary>, [click](https://example.com), **bold**, `code`
```

This changes source names into HTML/link/emphasis/code presentation; an unclosed details block can alter visibility of subsequent report content in a CommonMark/GFM renderer. Existing escaping only covers pipe, backslash and line breaks. Escape HTML delimiters and relevant Markdown punctuation before inserting the controlled `<br>` separators. Evidence strings should display literally; no claim of JavaScript execution is needed for this failure.

### 7. [P2] Unsupported-hardlink fallback overwrites a concurrently created config destination

Location: `cli/io.mjs:386-392`.

After `link()` returns an unsupported error, `lstat(dest)` followed by ordinary `rename(temp, dest)` is not exclusive file publication. Independent injection returned `ENOTSUP` from link, allowed the real lstat to observe absence, then created a user sentinel with `wx` immediately before calling the real rename. Publication returned the destination as successful and its contents were **NEW CONFIG**, overwriting **user-created-after-precheck**. This is a deterministic interleaving probe, not a claim that a physical unsupported filesystem was exercised.

The normal atomic-link path avoids this race; the fallback silently loses the declared init-config no-overwrite guarantee. If an atomic no-replace publication primitive is unavailable, fail safely rather than fall back to overwriting rename. The preflight's qualified directory-rename race limitation does not make an exclusive single-file fallback safe.

## Actual independent checks and passing observations

Probe scripts and captured outputs are retained at:

- `/private/tmp/task6-independent.Zx05kQ/independent-probe.mjs`
- `/private/tmp/task6-independent.Zx05kQ/independent-results.txt`
- `/private/tmp/task6-independent.Zx05kQ/positive-probe.mjs`
- `/private/tmp/task6-independent.Zx05kQ/positive-results.txt`
- `/private/tmp/task6-independent.Zx05kQ/exclusive-fallback-probe.mjs`
- `/private/tmp/task6-independent.Zx05kQ/exclusive-fallback-results.txt`

Synthetic output/evidence roots: `/private/tmp/task6-evidence.2WnSnN` and `/private/tmp/task6-positive.rUY2Cd`; fallback race fixture: `/private/tmp/task6-linkfallback.QHkTP3`.

Verified without duplicating the full suites:

- Exact-commit archive builds the real MoonBit bridge successfully.
- 16 independent malformed manifest mutations (schema/version types, unsupported version, digest format, negative/fractional/string/unsafe byte sizes, provenance/timestamp/provenance digest types) all return 2 before the injected engine hook can run.
- Fatal malformed UTF-8, double BOM and interior CSV BOM are rejected; initial BOM is retained as U+FEFF when decoded. End-to-end snapshots preserve BOM/CRLF/Unicode/quoted logical newlines byte-for-byte.
- Independent literal canonical-string expectation passes for numeric-looking keys (`10` before `2`), nested maps and stable arrays; exactly one final LF.
- Bounded read accepts the exact injected byte limit and rejects limit+1. Production constant is 64 * 1024 * 1024; a full 64 MiB throughput run was not repeated.
- Independent crypto recomputation matches run_id from the mandated four-element JSON array, with no final LF in the identity material.
- Delete both original CSVs and source config; resolve still works from snapshots. First review retains multiline/quoted Chinese reasons. Edit the reviewed cumulative template, resolve again and preserve both prior/new decisions; final status goes from 1 to 0 and prior report bytes remain unchanged.
- Reviewed run ID and parent ID equal original ID, current decision digest hashes exact consumed bytes, editing cumulative decisions is not blocked by historical digest. Repeating that replay yields identical report JSON.
- Ordinary nested destinations and symlink aliases into the source run are rejected. The `..reviewed` failure is the specific containment gap described above.
- Static review confirms business compare/resolve stays in invoke; JSON is direct Result; exports preserve nested field/candidate evidence in JSON cells; new recommended actions are blank. Source core computation-history behavior is unchanged by Task 6.

## Residual scope

No production workload benchmark, Node 22 execution, Windows filesystem exercise, real disk exhaustion, physical power-loss/durability test or adversarial rename-race proof. Focused probes supplement, not replace, the reported full-suite gates. Task 5's incomplete-history acceptance is inherited; this review did not rerun its production 101-row budget oracle. Final cross-task review remains outstanding. A passing full suite does not override the concrete transaction and replay failures above.
