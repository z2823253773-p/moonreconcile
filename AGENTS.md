# MoonReconcile agent guide

This is a [MoonBit](https://docs.moonbitlang.com) project.

You can browse and install extra skills here:
<https://github.com/moonbitlang/skills>

## Project Structure

- MoonBit packages are organized per directory; each directory contains a
  `moon.pkg` file listing its dependencies. Each package has its files and
  blackbox test files (ending in `_test.mbt`) and whitebox test files (ending in
  `_wbtest.mbt`).

- In the toplevel directory, there is a `moon.mod` file listing module
  metadata.

## Coding convention

- MoonBit code is organized in block style, each block is separated by `///|`,
  the order of each block is irrelevant. In some refactorings, you can process
  block by block independently.

- Try to keep deprecated blocks in file called `deprecated.mbt` in each
  directory.

## Tooling

- `moon fmt` is used to format your code properly.

- `moon ide` provides project navigation helpers like `peek-def`, `outline`, and
  `find-references`. See $moonbit-agent-guide for details.

- `moon info` is used to update the generated interface of the package, each
  package has a generated interface file `.mbti`, it is a brief formal
  description of the package. If nothing in `.mbti` changes, this means your
  change does not bring the visible changes to the external package users, it is
  typically a safe refactoring.

- In the last step, run `moon info && moon fmt` to update the interface and
  format the code. Check the diffs of `.mbti` file to see if the changes are
  expected.

- Run `moon test` to check tests pass. MoonBit supports snapshot testing; when
  changes affect outputs, run `moon test --update` to refresh snapshots.

- Prefer `assert_eq` or `assert_true(pattern is Pattern(...))` for results that
  are stable or very unlikely to change. For snapshot tests that record
  structured debugging output, derive `Debug` and use `debug_inspect`, rather
  than deriving `Show` for debugging. For solid, well-defined results (e.g.
  scientific computations), prefer assertion tests. You can use
  `moon coverage analyze > uncovered.log` to see which parts of your code are
  not covered by tests.

## Verification and implementation governance

- Product implementation belongs to `.worktrees/quarter-workbench` on
  `feature/quarter-workbench`. Preserve the main `feature/initial-product`
  checkout and previously accepted evidence. Work is local by default; do not
  push, merge, release, or submit competition materials without authorization.

- `make verify` is the local one-command acceptance entrypoint. It requires a
  clean tracked and untracked source tree, checks every tracked file against
  the current HEAD blob, bootstraps only hard-pinned archives into `.verify/`,
  and records stage logs plus a JSON summary under `.verify/runs/`.
- Do not run the strict package validator on dirty source or report a green
  status when any stage fails, times out, is skipped, or lacks required
  isolation. Keep local acceptance, remote CI, and user/competition outcomes
  as separate evidence claims. See `docs/verify.md` for prerequisites and
  platform limits.
- Keep all pre-existing A+C business assertions and the frozen P0 scope intact.
  Do not alter matching, scoring, parsing, DTO/security contracts, or accepted
  package evidence as part of verifier work.
- One implementation writer owns a change. GPT-6.1-sol performs the independent
  scoped review at high reasoning effort. Allow at most two repair-and-review
  cycles; after the second unresolved cycle, stop implementation and present
  the concrete findings and decision options. Record the exact base/head,
  finding, cycle count, and final state in the ignored governance ledger.
