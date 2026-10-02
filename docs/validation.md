# 验证记录

本文件只记录实际验证。Tasks 1–7 已各有本地实测记录；Task 8 的文档和 CI 配置已提交，但远端 CI 执行与完整产品验收尚未完成。

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

The primary-documentation competitor audit does not establish local competitor execution or comparative benefit. No real customer data or adjudicated real-world truth set was available. Independent review identified the fixture-gate gaps documented above; the fix round is pending re-review.

## Task 8 configuration

提交 `a0f9310` 增加架构、配置、复核流程和 README，并加入 Ubuntu 24.04 与 macOS 15 的 GitHub Actions 矩阵。随后修订工作流以使用 `actions/checkout@v6`、`actions/setup-node@v6`、`actions/setup-python@v6`、Node 22、Python 3.12 和官方 Unix 安装脚本的 `latest` 路径；历史可下载工具链固定版本未被验证，因此没有伪造固定 pin。工作流会记录安装脚本 SHA、MoonBit 版本、Node/Python 版本、提交 SHA 和 runner 平台。当前仅完成本地等价门禁，尚无远端 Actions run URL 或成功结论。

README 的公开命令和三组示例已在无构建缓存的 `git archive` 检出中复跑通过；独立库消费在本地新鲜 git clone 中通过 84/84。库消费脚本需要正常 checkout 的 `.git` 历史来确定 SHA，因此纯归档目录不作为该脚本的测试环境。这些本地结果不替代两种远端 runner 的验证。真实流程、XLSX、竞品运行和赛事审核仍为未验证事项。
