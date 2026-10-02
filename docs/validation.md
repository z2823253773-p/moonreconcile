# 验证记录

本文件只记录实际验证。Tasks 1–7 的范围审查与本地记录见下文；Task 8 本地 smoke、格式迁移和门禁记录在末尾。D05/D07/D08/D09 仍由最终独立审查、推送和精确 SHA 远端结果决定。

## Task 1

代码与审查范围见 [独立复审](evidence/task1-rereview.md)。控制器在 `9255ae8` 运行：

- `moon check --target js`：exit 0。
- `moon test --target js`：23/23，exit 0。
- `npm test`：6/6，exit 0。

## Task 2

实现提交 `fd603c2671f1330a73d274a9a6dba8bc7d1ea8f0`；修复提交 `540767c`。
初审复现了畸形 Unicode 日期越界崩溃，修复改为在码点数组上检查长度，并增加直接规范化与字段比较回归。
[实现报告](evidence/task2-implementation.md) 和 [独立审查与复审](evidence/task2-review.md) 保留初始失败与修复证据。

控制器在修复后执行 `moon fmt`、`moon info`、`moon check --target js`、`moon test --target js`、`npm test`、`git diff --check`，全部 exit 0：MoonBit 45/45、Node 6/6。
独立审查在隔离副本验证 100 组 Python Decimal 金标准、100 组 Gregorian 日期差及 Unicode 回归，48/48 通过。
这些验证覆盖字段规则；整表比较、人工回导、文件 CLI、报告、规模和远端 CI 仍待实现与验证。

## Task 3

实现提交 `a505299`，合同修复提交 `17104463288a6cbdced0c1e4efaff78c8d849323`。
[实现报告](evidence/task3-implementation.md)、[修复报告](evidence/task3-fixes.md) 和 [独立审查与复审](evidence/task3-review.md) 记录了初审三个阻塞问题及修复。

独立复审在确切修复提交运行 MoonBit 50/50、Node 8/8，并以 200 组带重复/空键、引用换行、分隔文本和 Unicode 的独立案例核对精确配对、左右计数守恒及重复运行确定性。已验证锁定 JSON 合同、两侧缺失忽略列错误、规范化配置和十进制规范化后的重复键。
该里程碑只覆盖精确对应；候选启用且存在剩余记录时明确返回未实现错误，人工回导及文件 CLI 仍待实现。

## Task 4

实现提交 `4fe8f74d3a416e01c56e2f727fe3dd4454c3c69e`；[实现报告](evidence/task4-implementation.md)、[独立审查](evidence/task4-review.md) PASS。隔离副本 MoonBit 63/63、Node 8/8，9 组独立候选/预算/Unicode/守恒案例通过。

控制器在该提交的独立 archive 加入 Python 穷举的 240 个 0–4 × 0–4 图金标准，`moon fmt`、`moon check --target js` 均 exit 0，`moon test --target js` 64/64。断言部分配对端点互斥、边实际存在及总权重等于穷举最优；金标准见 `tests/fixtures/assignment-oracle.json`，测试见 `assignment_goldens_wbtest.mbt`。

独立审查指出稀疏单边分量的全表标记初始化和线性成员判断存在二次工作量；10000/30000 单边分别约 0.77/6.94 秒。该观察是历史性能证据，不是支持容量承诺；Task 7 已用一次分配的标记和布尔端点集合修复，并按相同驱动重新测量。人工回导、CLI、完整演示与远端 CI 当时尚未验收。

## Task 5

实现提交 `5281187566dff5eefefeddaa8433520b582056e6`，接续[独立审查](evidence/task5-review.md) PASS（Claude Code 配置路由 DeepSeek-flash；Astra 因额度中断未给出结论）。控制器隔离副本 check/test82/npm8/Python240 均 exit0；另200组累计重排、重复、状态、字段与退出码独立断言通过。生产101×101预算受限案例全量人工处置后仍 incomplete/exit3/unresolved0。源码归档于 `tests/decisions-oracle.test.mjs`。

`summary.key_issue_count` 保留所有键诊断，包括信息性 `no_key_configured` 和 `key_not_found`。这两个代码不单独阻止完全人工复核且无其他问题的运行退出0；重复/缺失/无效键异常、内容差异、无对应和结构问题仍触发退出1。计算历史不完整仍优先退出3。运行目录指纹、文件事务与CLI是Task6，不能由核心复核测试替代。

Task 8 补足 Task 5 初审保留的低严重度回归覆盖：`exact_key_locks_all_four_review_actions` 检验 accept/reject/双侧 unmatched 均不能改动精确键端点；`same_action_and_endpoints_with_different_reasons_conflict` 检验冲突理由原子拒绝；`malformed_ids_and_extra_or_missing_endpoints_are_rejected` 检验规范 ID、已不存在端点与 action 端点形状；新增两类 invalid-value / override 及竞争候选接受断言。Task 5 的生产 101×101 全人工处置仍 incomplete/exit 3/unresolved 0 证据已由 `tests/decisions-oracle.test.mjs` 保留。实现没有修改 Task 5 业务算法。

## Task 6

初版 `ed0eeba` 的82MoonBit/43Node门禁通过，但[独立审查](evidence/task6-review.md)复现七项文件保护、I/O、回导及显示缺陷。因此初版未验收。修复提交 `4304f75c8fafbde63e2a6be8d88cbfa4a116bea9` 补充先红后绿的回归测试，82MoonBit/53Node通过，七项均在[独立定向复审](evidence/task6-rereview.md)确认修复。

当前CLI已实现四个命令及11个输出文件，快照不依赖原路径，规范化配置和输入SHA/大小/引擎版本/run_id均校验，累计决定可二次回导。不能提供原子不覆盖文件发布的文件系统，init-config明确退出2，不使用会覆盖文件的rename回退。CPU/内存规模、三个完整示例及远端CI仍待后续验证。

## 独立库消费早期检查

`python3 scripts/check-library-consumer.py` 在 `3ae6245` 的归档代码与独立模块工作区中通过84/84（核心82+外部2）。它不使用Node文件宿主；这不是Mooncakes发布证明。当前官方工具链临时验证记录将随最终CI证据归档，用户全局工具链未改动。

## Task 7

All three examples use synthetic data. `npm run test:workflows` invokes the shipped CLI for compare, resolve, and cumulative-decision replay. It derives expected row IDs from the original CSV bytes, checks complete unique per-side record coverage and summary counts against input rows, asserts exact pair identities from the independent unique-key reference, and verifies fixture-specific states, field values/differences, manual decisions and override flags, duplicate/empty-key diagnostics, and structural anomalies. The reference uses declared status mappings, BigInt decimal comparison, strict calendar dates, and no fuzzy matching.

The workflow gate validates original input snapshots byte-for-byte and checks manifest sizes/digests, normalized configuration semantics, all five CSV headers and values against independent schemas/report fields, cumulative decision and unresolved rows, and explicit computation/accounting/field/structure/review content in Markdown. It also runs five deliberate mutations—missing record, wrong pairs.csv ID, same-length changed snapshot, replaced config.json, and stripped summary.md—and requires each to fail. The catalog truth is hand-authored in `examples/catalog/truth.json`; the sole highest-score suggestion is intentionally false while a true competitor remains visible. Its metrics are synthetic fixture outcomes only.

The original full-matrix measurements remain in `docs/evidence/task7-benchmark.json`. That historical record does not contain the invocation environment or semantic report hashes, so its old before/after semantic-equality statement is not independently established by that file. The focused follow-up [`task7-p3-comparison.json`](evidence/task7-p3-comparison.json) records reproducible baseline/optimized commands, both source SHAs, the shared benchmark-driver SHA-256, environment, input hashes, and report hashes. For sparse 10k and 30k fixtures, both input hashes and report hashes matched exactly; exit codes and candidate counts also matched. Output bytes differ by 26 because manifest provenance includes checkout paths. One run per size confirms same-driver reproducibility and semantic equality; it is not a replacement performance estimate.

The comparison can be reproduced from a clean checkout at the Task7 source root:

```sh
mkdir -p /private/tmp/moonreconcile-task7-before
git archive 5daf04d3102a98d4fb43edb0526c0bc5b0a76dd9 | tar -x -C /private/tmp/moonreconcile-task7-before
(cd /private/tmp/moonreconcile-task7-before && npm run build)
BENCH_ROOT=/private/tmp/moonreconcile-task7-before BENCH_SHA=5daf04d3102a98d4fb43edb0526c0bc5b0a76dd9 BENCH_CASES=sparse-10000,sparse-30000 BENCH_REPEATS=1 BENCH_OUTPUT=/private/tmp/task7-fixwave-baseline.json node scripts/benchmark.mjs
npm run build
BENCH_ROOT="$PWD" BENCH_CASES=sparse-10000,sparse-30000 BENCH_REPEATS=1 BENCH_COMPARE_WITH=/private/tmp/task7-fixwave-baseline.json BENCH_OUTPUT=/private/tmp/task7-fixwave-optimized.json node scripts/benchmark.mjs
```

The baseline build/run commands above were retained as the original comparison invocation. The optimized `npm run build` line is a clean-checkout replay prerequisite added after review; it was not part of the retained historical optimized invocation, whose checkout already had `_build` available. The retained comparison JSON keeps the benchmark-driver hash from that historical run; Task 7 fix round 2 changes the current driver, so a replay will produce new comparison records and hashes.

`BENCH_COMPARE_WITH` requires identical driver bytes, host, Node/Moon versions, generated input hashes, and semantic report hashes. The benchmark now records the effective environment and driver/source identity. Its default output uses a timestamped filename; it refuses to overwrite existing evidence unless explicitly enabled. The historical full matrix is retained unchanged. RSS remains unavailable because `/usr/bin/time -l` emitted no maximum-resident-set line and reported `sysctl kern.clockrate: Operation not permitted`. The configured 100,000-row limit is not a tested capacity claim.

The primary-documentation competitor audit does not establish local competitor execution or comparative benefit. No real customer data or adjudicated real-world truth set was available. Task 7's fixture-gate findings are closed by the archived final scoped re-review, which did not repeat the full suite or remote CI.

## Task 8 configuration

提交 `a0f9310` 增加架构、配置、复核流程和 README，并加入 Ubuntu 24.04 与 macOS 15 的 GitHub Actions 矩阵。2026-10-01 远端只读核查发现，run `36739067019`（`8f8970c`）和 `36734569700`（`a0f9310`）均失败：两个 OS job 在旧工具链格式检查时报 diff/exit 255，后续测试未运行。历史 July 工具链固定版本未证明可下载；Task 8 改用官方 `latest` 并以匹配的官方格式化器迁移源文件，不静默跳过 formatter gate。CI 记录脚本 SHA、已安装 `moon`/`moonc` 版本和二进制哈希、Node/Python 版本、提交 SHA 与 runner 平台。两个历史失败结果不代表最终工作流结果。

README 命令由 `scripts/readme-smoke.mjs` 从本地提交创建的新鲜 Git clone 中抽取并执行；逐命令 exit 1/3 由标注决定。独立库消费脚本需要 `.git` 历史来确定 SHA，因此纯归档目录不作为该脚本的测试环境。这些本地结果不替代两种远端 runner 的验证。真实流程、XLSX、竞品运行和赛事审核仍为未验证事项。

## Task 8 local delivery

本节记录 Task 8 最终代码/文档树上的实际命令、版本、测试数和结果；精确 HEAD 由忽略的 Task 8 交接报告记录，避免在被测试的提交中写入自引用 SHA。CI 使用官方安装器的 `latest`，其真实远端结果必须关联最终 SHA；提交、推送或排队均不等于 CI 通过。

Task 8 本地实现先提交为 `4bd18b5`，README smoke harness 的 scratch 目录修复为 `810dc3c`；修复后重新在提交树上运行全部下列门禁。随后只更新了验证记录和 CI checkout 凭据设置。门禁环境：Darwin 25.4.0 arm64（设备名已为公开报告脱敏）、Node v24.15.0 / npm 11.12.1、Python 3.14.6、Moon `0.1.20260920` / moonc `v0.10.14+7d59c7ec9`。MoonBit 工具位于隔离的 `/private/tmp/moonreconcile-task8-toolchain`，使用进程级 `MOON_HOME`、`MOONBIT_HOME` 和 `PATH`，未改用户全局工具链。`moon` 与 `moonc` SHA-256 分别为 `a0cd1c0014f2ca17089542939ac4ad3c983452c5952ca6140af0fcef258e1967` 与 `8a49fb209d896b8ce72322883aa53a2395a1bdd88d35423ebfd841fc66b8f127`。

| 命令 | 实际结果 |
| --- | --- |
| `moon info` | exit 0；no work to do |
| `moon fmt --check` | exit 0；28 tasks up to date。此前执行官方工具链 `moon fmt`，已提交机械格式迁移；生成 `.mbti` 变化只有尾部空行移除，无 API 声明变化 |
| `moon check --target js` | exit 0 |
| `moon test --target js` | exit 0；88/88 |
| `npm test` | exit 0；构建成功，Node 53/53；附带 200 个独立累计决定/状态/字段/退出码案例及生产预算 101×101 全人工处置仍 incomplete/exit 3/unresolved 0 |
| `python3 scripts/check-assignment-oracle.py` | exit 0；240 个穷举分配 golden 独立核对 |
| `python3 scripts/check-library-consumer.py` | exit 0；90/90（88 个核心 + 2 个外部 consumer）；归档代码来自该提交的 exact HEAD。该脚本实际运行于 Python 3.14.6，不是 CI 的 3.12 |
| `npm run test:workflows` | exit 0；orders/migration/catalog compare→resolve→replay 全通过，七种导出变异均被拒绝 |
| `node scripts/readme-smoke.mjs` | exit 0；从本地提交克隆 checkout，抽取并运行 README 标注的 9 条命令；build/init/edit/check/copy/最终报告检查 exit 0，compare 和两次累计 resolve 按合同 exit 1 |
| `git diff --cached --check` 与 staged payload scan | exit 0；最终清单 35 文件，无大于 1 MB 文件，扫描的个人路径和常见凭据模式均无命中。Task 8 后续 validation-only commit 在交付前还会重新检查 |

README smoke 的初次 clean-clone 运行以 exit 1 失败，原因是 harness 未先创建临时输出父目录，`init-config` 正确返回 I/O exit 2；在 `810dc3c` 加入创建步骤后，同一标记代码块 9/9 命令通过。另一次直接检查发现报告字段与章节名假设错误，修正为实际 `computation.status` 与 `Field comparison` 后通过。

没有在本机执行或声称 Node 22、Python 3.12、Ubuntu/macOS GitHub Actions 最终 run，也没有重跑历史 benchmark。公开远端历史 run `36739067019`（`8f8970c`）与 `36734569700`（`a0f9310`）曾在旧格式检查处失败；最终 Task 8 commit 的远端状态必须另行核验。真实 workflow (V05)、CSV/XLSX 适配 (V06)、广域独立审查 (D05) 与精确 SHA 发布/双平台 CI (D07–D09) 仍待根任务负责人完成。

## 2026-10-03 最终功能门禁与复审

整体独立审查在`c24ff15`发现导出决定模板超过自身读取限额的P2问题和三项文档错误；`0bcf967`集中修复，独立定向复审确认R1–R4全部解决，无新问题。[整体初审](evidence/final-product-review.md)、[修复报告](evidence/final-product-fixes.md)、[最终复审](evidence/final-product-rereview.md)保留失败和修复证据。

根任务在精确`0bcf96753df06a7eeedb74fb30c2db7ac24b2eb7`独立重跑完整门禁，全部exit0：95核心、56Node（含200累计案例及生产101×101）、240分配golden、97独立库消费（核心95+外部2）、三个工作流/七变异、九条新鲜克隆README命令。环境仍是隔离Moon0.1.20260920/moonc0.10.14+7d59c7ec9、Node24.15.0、Python3.14.6。[机器可读命令记录](evidence/final-local-gates-2026-10-03.json)和[完整脱敏输出](evidence/final-local-gates-2026-10-03.txt)。这不是Node22/Python3.12远端验证。

实际50001+50001源表导出的100002行空白模板能原样回导；加入reject后100003行累计模板继续回导，全部原始ID、待复核状态及源快照保留。源表限额不变，模板独立raw/active限额及规范CSV字节证明见修复报告。最大字节/DP/动作应用吞吐尚未实测；所有合成与真实需求缺证边界继续保留。远端证据另行追加。

## 2026-10-03 实际公开交付与远端CI

发布`3c506f15f27c32fc97fa83077292477be3f47b47`，远端提交API一致；默认分支公开，README blob`10fabfa913a0d7c834e9a44c6501d84ca41b9b6e`与本地相同，GitHub提供实际渲染HTML。[双平台CI run37055796591](https://github.com/z2823253773-p/moonreconcile/actions/runs/37055796591)已完成success，两OS每项门禁均通过。[完整结构化结果与版本/二进制哈希](evidence/remote-ci-2026-10-03.json)、[实际日志摘录](evidence/remote-ci-2026-10-03-excerpts.txt)。Moon版本与本地隔离工具一致；Node/Python为实际22/3.12，两平台补丁版本分别记录，不以本机24/3.14结果替代。历史失败run继续保留。这份记录针对实际3c506f1，后续证据文档提交会另核验真实CI，不编造自引用提交结果。
