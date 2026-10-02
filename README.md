# MoonReconcile

MoonReconcile compares two CSV exports, explains field differences under explicit rules, and carries human review decisions into a final report. Its six stages are import, column mapping and rules, record matching, field comparison, human review, and export.

The reusable comparison engine is written in MoonBit. Node.js provides the file and command-line adapter. Runtime use needs MoonBit to build and Node.js 22 or later to run the CLI; Python 3.12 is only used by the independent development checks.

## Current capabilities

- Strict UTF-8 CSV parsing, explicit field mapping, declared conversions and comparison rules.
- Unique-key matching, diagnostics for invalid or duplicate keys, and scored one-to-one suggestions for remaining rows. Suggestions always require human review.
- Cumulative review decisions, integrity-checked input snapshots, and JSON, CSV, and Markdown reports.
- Three complete synthetic examples for order reconciliation, migration checks, and product catalogs.

The examples are authored fixtures, not customer data. The catalog fixture deliberately makes the highest-scoring suggestion false to demonstrate why suggestions require review. It does not establish real-world accuracy or improved matching performance.

## Install and build

Install the [MoonBit toolchain](https://www.moonbitlang.com/download/) and [Node.js 22+](https://nodejs.org/). This repository has no npm runtime dependencies or lockfile.

```sh
moon check --target js
moon info
moon fmt --check
moon test --target js
npm test
python3 scripts/check-assignment-oracle.py
python3 scripts/check-library-consumer.py
npm run test:workflows
node scripts/readme-smoke.mjs
```

CI runs these gates on Ubuntu 24.04 and macOS 15, recording the actual MoonBit installer source hash and installed compiler versions. The installer selects the current official toolchain, so later runs may use a newer version. Remote results are recorded in [validation](docs/validation.md); local success alone does not establish a GitHub Actions result.

## CLI

Run `node cli/main.mjs` without arguments for help. `init-config` writes a draft that must be edited, `check-config` normalizes and validates the edited rules, `compare` creates a self-contained run directory, and `resolve` replays reviewed decisions from its snapshots.

Exit status precedence is 2 for input/configuration/I/O error, 3 for incomplete computation, 1 for a complete run with outstanding differences or review, and 0 for a complete run without issues. A command can produce reports while correctly returning 1 for outstanding issues or 3 for incomplete computation.

For a manual run from the checkout root, create a fresh writable output directory in the same shell before running the commands below:

```sh
SMOKE_DIR="$(mktemp -d)"
export SMOKE_DIR
```

The automated `scripts/readme-smoke.mjs` runner creates and sets its own fresh directory. It extracts and runs the nine exact command lines below from a fresh Git checkout. `@expect` comments state each command's accepted exit status. The helper edits the generated draft using the example's authored rules; both resolve commands exercise cumulative replay, and the last command checks that the final report remains available.

<!-- README-SMOKE:START -->
```sh
npm run build # @expect: 0
node cli/main.mjs init-config examples/orders/left.csv examples/orders/right.csv --out "$SMOKE_DIR/draft.json" # @expect: 0
node scripts/prepare-readme-smoke.mjs "$SMOKE_DIR/draft.json" "$SMOKE_DIR/rules.json" # @expect: 0
node cli/main.mjs check-config "$SMOKE_DIR/rules.json" # @expect: 0
node cli/main.mjs compare examples/orders/left.csv examples/orders/right.csv --config "$SMOKE_DIR/rules.json" --out "$SMOKE_DIR/run" # @expect: 1
cp examples/orders/reviewed.csv "$SMOKE_DIR/reviewed.csv" # @expect: 0
node cli/main.mjs resolve "$SMOKE_DIR/run" --decisions "$SMOKE_DIR/reviewed.csv" --out "$SMOKE_DIR/reviewed-run" # @expect: 1
node cli/main.mjs resolve "$SMOKE_DIR/reviewed-run" --decisions "$SMOKE_DIR/reviewed-run/decisions.csv" --out "$SMOKE_DIR/replayed-run" # @expect: 1
node scripts/check-readme-smoke-output.mjs "$SMOKE_DIR/replayed-run" # @expect: 0
```
<!-- README-SMOKE:END -->

## Example workflow

For complete example inputs, rules, decisions, and expected outcomes, see [orders](examples/orders/README.md), [migration](examples/migration/README.md), and [catalog](examples/catalog/README.md). Their end-to-end gate is `npm run test:workflows`.

## Scope and evidence

The current implementation reads and writes CSV; it does not read XLSX. No real workflow, user study, time saving, or population matching accuracy has been validated. The competitor comparison is based on published documentation, not local benchmark runs. The October 2026 official page evidence and its limits are recorded in [the dated source note](docs/evidence/official-requirements-2026-10-01.md). The repository documents delivered code and verification separately from contest eligibility, registration, acceptance, or adoption.

See [the specification](docs/spec.md), [configuration reference](docs/configuration.md), [review workflow](docs/review-workflow.md), [architecture](docs/architecture.md), [acceptance matrix](docs/acceptance-matrix.md), [validation record](docs/validation.md), [limitations](docs/limitations.md), [dependency audit](docs/dependency-audit.md), and [project proposal](docs/project-proposal.md).

## License

[MIT](LICENSE)
