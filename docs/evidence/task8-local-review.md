# Archived review evidence

This is the historical review at the exact SHA below. Later fixes and delivery gates have separate evidence; this report alone is not a current completion claim. Full agent logs and private runtime paths are excluded.

# Task 8 independent SPEC + QUALITY review

Date: 2026-10-02. Read-only review of `cf678b4f11252fbc2ee2907395b4cc7e29ec4f19..d30061fc8480c41d57b04b385d4521a7d1cbc609` (four commits). Reviewed HEAD was confirmed before and after inspection; tracked working tree remained clean. This ignored report is the only repository file written by the reviewer. No index/HEAD changes, commits, push, remote mutation, user-global toolchain changes, or subagents.

## Verdict

**SPEC: Needs fixes. QUALITY: Needs fixes.** Two important documentation findings and one minor documentation finding remain. No critical finding and no Task 8 production-algorithm regression found. A narrow documentation correction and focused re-review are sufficient for this scoped gate; repeating historical benchmarks or the full local suites is unnecessary for these fixes.

This is the Task 8 local-diff gate. It does not close the root-owned whole-branch review, final acceptance-matrix closure, publication, remote exact-SHA verification, or final delivery. D05/D07/D08/D09 and V05/V06 correctly remain pending.

## Findings

### R8-1 — Important / P2: exit guidance misstates when human disposition permits exit 0

Location: `docs/review-workflow.md:279-280` (line 280 is newly added; adjacent line 279 is retained in the section Task 8 was explicitly asked to clarify).

The first bullet says an identical single-row comparison without a configured key exits 0, omitting the required human acceptance. In fact, a plain compare leaves both records pending and exits 1. The newly added next bullet says duplicate/invalid/missing-key anomalies remain issues “只要没有被明确处理”, suggesting human disposition can clear those anomaly conditions. They persist in the original diagnostics and force exit 1 even after every record is manually paired and every compared content field is equal. The two sentences undermine the explicit distinction between informational key diagnostics and persistent anomalies required by the October supplement.

**Independently reproduced on exact HEAD:** exported HEAD with `git archive` into a disposable directory, built with the isolated official Moon `0.1.20260920` / moonc `v0.10.14+7d59c7ec9` (`npm run build`, exit 0), then called that archive's generated `invoke_bridge` with the following small inputs. The probe itself exited 0.

Common configuration: schema 1; text fields `id` (`compare:false`) and `value`; no candidate configuration. Both sources use `id,value` headers.

| Input and operation | Actual outcome |
| --- | --- |
| `key:[]`, both CSVs `id,value\nA,same\n`; `compare` | complete, exit 1, paired 0 per side, pending 1 per side, unresolved 2, `no_key_configured` retained |
| Same inputs; `resolve` with `accept,L1,R1,reviewed identity` | complete, exit 0, paired 1 per side, unresolved 0, `no_key_configured` still retained |
| `key:["id"]`, both CSVs `id,value\nA,same\nA,same\n`; `resolve` with `accept,L1,R1,reviewed identity` and `accept,L2,R2,reviewed identity` | complete, exit 1, paired 2 per side, unresolved 0, equal fields 2, four `duplicate_key` diagnostics retained |

The production branch at `decisions.mbt:547-564` explicitly checks the original diagnostics for `duplicate_key` or `invalid_or_missing_key`, irrespective of manual disposition. Existing `a fully reviewed run with no usable key exits zero` also supplies the missing fully-reviewed condition for informational diagnostics.

**Required correction:** say that no-key/key-not-found information alone does not force exit 1 **after complete human disposition, with complete computation and no content/structure/persistent key problems**. Say explicitly that duplicate, invalid, and missing-key anomalies persist after human acceptance; review decisions only establish record correspondence and do not repair source key quality. Do not change the engine to match the erroneous prose. This is a documentation correction supported by existing tests and the focused probe; an extra implementation-mirroring test is not needed.

### R8-2 — Minor / P3: README calls an incomplete result complete

Location: `README.md:38`.

After correctly defining exit 3 as incomplete computation, the same paragraph says “A complete run may therefore correctly return 1 or 3.” Exit 3 must never be presented as complete computation, including after all records were manually disposed. This contradicts the specification, the preceding sentence, and the production 101×101 incomplete-history regression.

**Required correction:** use wording such as “A command can produce reports while correctly returning 1 for outstanding issues or 3 for incomplete computation.” Keep the explicit precedence and do not describe exit 3 as a complete run.

### R8-3 — Important / P2: the public shell example depends on an undocumented scratch directory

Location: `README.md:40-52`, especially the first use at line 45; `scripts/readme-smoke.mjs:10-13,28` supplies this environment only to automated smoke commands.

The marked shell block is the README's concrete CLI acceptance example, but the README never declares or creates `SMOKE_DIR`. A reader copying those commands in an ordinary shell does not get the harness's setup: with the variable unset, `"$SMOKE_DIR/draft.json"` expands to `/draft.json`, and the run directory becomes `/run`. A read-only expansion probe (`env -u SMOKE_DIR bash -c 'printf "%s\n" "$SMOKE_DIR/draft.json" "$SMOKE_DIR/run"'`) produced those two root paths. No attempt was made to write them. On a normal unprivileged machine `init-config` then fails with I/O exit 2 rather than the documented 0, while the automated smoke still passes because it creates and injects its own directory.

**Required correction:** immediately before the marked commands, document a manual setup such as `SMOKE_DIR="$(mktemp -d)"`, explain that the path is a fresh writable output directory, and say the automated runner creates/sets it itself. Keep the nine command lines and explicit expected statuses valid. Do not simply insert an assignment as another current extracted command: the runner starts each command in a separate shell, so an assignment executed alone would not persist into later commands. If setup is moved inside extraction instead, deliberately adjust the runner's shell/environment semantics and verify that focused path.

## Scope and evidence checked

- Read `task-8-brief.md` first, then the October supplement and integration/preflight notes; October requirements override stale September/current-status statements. Read the implementer report and the full 225,215-byte aggregate package, covering all 35 changed-file sections. Mechanical sections were additionally checked across their entire contents by token comparison, preserving quoted strings and comments and normalizing only external whitespace and optional trailing commas. All changed `.mbt`/`.mbti` files except the intended `decisions_wbtest.mbt` additions were identical under that normalization, including all 240 assignment goldens. Export declarations did not change.
- Inspected the six new Task 5 assertions. They exercise all four exact-key lock action shapes; same action/endpoints with conflicting reasons; noncanonical/nonexistent IDs and extra/missing endpoint shapes; identical invalid decimal content after acceptance; positive below-threshold acceptance requiring a reason and `override:true`; and acceptance of a qualified competing candidate with `override:false`. The helper extensions preserve previous defaults. No production decision algorithm was modified.
- Inspected README extraction, clean local clone creation, scratch-directory creation, explicit per-command expected status handling, draft editing, compare, two cumulative resolve commands, and retained-report assertions. The helper uses only Node built-ins; the actual command strings are extracted from the committed README. It does not substitute the workflow gate. Python remains a development-check requirement, not CLI runtime. The smoke's final helper is deliberately a shallow retained-artifact check; broader content/replay assertions remain in the existing workflow/CLI gates, so it must not be cited alone as proof of all export semantics.
- Read the actual engine JSON request/response implementation and the architecture/review/configuration contracts; checked the changed status and boundary descriptions. The two findings above are user-facing semantic inaccuracies, not engine defects.
- Checked acceptance IDs and the added named-assertion index against repository test sources. Referenced names resolve to actual tests (the Q-row uses a shortened prefix of the existing end-to-end test title). Removed fictitious planned filenames have been replaced with actual locations. The matrix retains individual pending statuses and makes clear that family-level links are a coverage index rather than proof of every clause. Root-owned final status closure is intentionally outstanding and is **not** a Task 8 defect.
- Do not turn the matrix index into stronger boundary evidence than the assertions provide. For example, `csv_total_byte_budget_counts_multibyte_utf8_at_boundary` checks the UTF-8 helper at an injected 64-byte boundary; the DP boundary test uses an injected `512*512` budget, and the component boundary test uses a smaller injected side limit. Other production-budget evidence exists (notably the 101×101 incomplete case), but these individual helper tests are not literal end-to-end executions at every public maximum. This review does not independently certify every whole-branch matrix clause.
- Checked CI configuration: Ubuntu 24.04/macOS 15; fail-fast false; Node 22/Python 3.12; read-only contents permission; checkout `persist-credentials:false`; official mutable latest installer; installer digest, installed versions, compiler hashes, source SHA and platform logs; real format check; core, host, workflow, assignment oracle, library consumer, and README smoke steps. The prior July pin is not represented as available. Historical failed runs are disclosed, not rewritten as passing.
- Proposal/one-page description/spec correctly distinguish implemented software, synthetic examples, historical local timing observations, absent real demand/CSV-XLSX validation, documentation-only competitor comparisons, and unproven contest status. The October note records deployed resource hash versus stale main source; the repository does not claim registration or approval. The actual commit history after `f892db5` contains the named October Task 7 evidence fixes and Task 8 work, rather than relabeling September implementation.
- Compared all ten chronological `Ruling` entries in `progress.md` with `docs/evidence/implementation-rulings.md`: all ten decisions are preserved in order with their rationale and cost if wrong. Minor wording cleanup does not change their decisions. Task 7 original-review, fixes, and final scoped-re-review summaries preserve the accepted historical conclusion and its limits.
- Inspected 114 tracked files: maximum file size 77,382 bytes; no symlinks; no matches in the checked personal `personal home paths`, private-key, GitHub-token, and AWS-access-key patterns. No third-party npm dependencies or lockfile were added. This is a scoped scan, not proof that any conceivable secret cannot exist.
- Compared the two sanitized benchmark JSONs field by field with the base. Changes are confined to host/path representations and explicit sanitization notes. Measurements, source identities, input/report hashes, and historical driver hashes are unchanged. Notes honestly say the public placeholders are not verbatim historical argv. Old commits still retain the original host/path metadata; current-tree redaction is **not history erasure**. Final history/publication policy remains with the root owner; no history rewrite was performed or requested here.

## Verification attribution and limits

The implementer report records exact-d30061f local results: 88 core tests, 53 Node tests (including 200 independent cumulative cases and the production 101×101 fully-reviewed incomplete case), 240 assignment goldens, 90 external-consumer tests, three workflows plus seven rejected output mutations, and nine clean-clone README commands. The controller separately reported rerunning this complete gate set at the same exact SHA, all exit 0, with clean tracked state (`root-local-gates.txt` in ignored task scratch). Those full-suite outcomes are attributed to those runs; this reviewer did not rerun them merely to duplicate evidence.

Reviewer-executed checks were the full mechanical-token comparison, named-test reference check, JSON-leaf comparison, scoped payload scan, exact-HEAD disposable build, and the three focused protocol probes documented above. The disposable build/probe used the isolated toolchain and the installed local Node; it does not supply actual Node 22/Python 3.12 or remote two-OS evidence.

Cannot verify or close in this scope:

- Final public push, API/README visibility, remote HEAD equality, or final Actions result on both OS runners for the eventual delivery SHA (D07/D08).
- The root's broad whole-product independent review and exact final matrix closure (D05), or the final delivery statement (D09).
- Real licensed workflow fitness, actual CSV export fidelity/XLSX need, time savings, population-level matching accuracy, or competitive benefit (V05/V06 and product risks).
- Actual registration, organizer acceptance, or permission to count prior code toward the October round. The dated official-source note was audited as repository evidence; this review did not independently refetch mutable contest pages or remote historical runs.
- A new benchmark estimate on the September toolchain. Historical timing observations were not rerun and must remain tied to their recorded source/toolchain.

After R8-1/R8-2/R8-3 are corrected, request a focused review of the documentation diff against these fixed semantics and the manual README setup. Keep all external and whole-branch gates open until their separate evidence exists.
