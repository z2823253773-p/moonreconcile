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

All three examples are synthetic. `node scripts/workflows.mjs` invokes the shipped CLI through compare, resolve and cumulative-decision replay; it checks semantic JSON assertions, conservation on both sides, all 11 run artifacts, CSV headers and Markdown summary sections. Orders and migration exact pairs, states and field statuses are cross-checked with a fixture-scoped independent JavaScript reference. That reference requires complete unique keys, applies declared right-side status mapping, uses BigInt decimal comparison and strict calendar dates, and does not implement fuzzy suggestions or review.

The catalog truth is hand-authored separately in `examples/catalog/truth.json`. This intentionally adversarial two-candidate case contains one true candidate and one false candidate; the false score-10000 exact-name decoy is the sole suggestion while the true score-8000 competitor remains visible. Review rejects the decoy, accepts the competitor and confirms the other right record unmatched. These are fixture counts only, not an accuracy estimate.

`node scripts/benchmark.mjs` creates deterministic temporary inputs and output runs and measures end-to-end child CLI compare, including CSV parsing and report writing. It excludes build and fixture generation. The retained records list the tested source SHA, OS/CPU, Node/Moon versions, child wall time, candidate counts/density, component size, actual output bytes and CLI exit status. Child RSS is unavailable: macOS `/usr/bin/time -l` did not emit an RSS line and reported `sysctl kern.clockrate: Operation not permitted`. The time wrapper itself returned 1 on macOS despite the CLI publishing its result; the harness extracts and records the CLI exit from its output separately. Task 7 implementation and local gates are complete, but its independent task-review seat did not return a verdict because of the model usage limit; this remains open in the acceptance matrix.

| Workload | Wall time(s) | Candidates | Density E/(remaining L×R) | Max component L×R | Output bytes | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Exact, 1,000/side | 0.126 | 0 | n/a | 0×0 | 1,422,879 | 0 |
| Exact, 10,000/side | 0.343 | 0 | n/a | 0×0 | 14,571,908 | 0 |
| Sparse, 10,000 singleton/side | 0.298 median (3 runs) | 10,000 | 0.0001 | 1×1 | 11,114,434 | 1 |
| Sparse, 30,000 singleton/side | 0.726 median (3 runs) | 30,000 | 0.0000333 | 1×1 | 33,934,434 | 1 |
| Mixed, 9,000 exact + 1,000 candidates/side | 0.361 | 1,000 | 0.001 | 1×1 | 14,813,096 | 1 |
| Dense, 100×100 | 0.234 | 10,000 | 1 | 100×100 | 6,381,282 | 1 |
| Dense, 101×101 | 0.193 | 10,201 | 1 | 101×101 | 6,510,905 | 3, `candidate_component_limit_exceeded` |
| Pair boundary, 1,000×100 | 0.985 | 100,000 | 1 | 1,000×100 | 63,888,301 | 3, `candidate_component_limit_exceeded` |
| Pair overflow, 1,001×100 | 0.127 | 0 retained from 100,100 possible | 0 | 0×0 (generation aborted) | 244,587 | 3, `candidate_pair_budget_exceeded` |

The separate P3 comparison in the JSON retains three observations per size. At 10,000 singleton edges the base median was 607.856 ms and optimized median 297.867 ms; at 30,000 edges, 5,820.024 ms and 726.061 ms. The fixture output sizes differed by 26 bytes because provenance embeds paths under differently named checkouts; candidate counts and semantic reports matched. This is a local observation, not a general complexity guarantee. The configured 100,000 row limit was not tested as capacity.

Competitor review in `docs/dependency-audit.md` is based on primary documentation, not local tool runs. No actual customer data or adjudicated truth set was available.

## Task 8 configuration

提交 `a0f9310` 增加架构、配置、复核流程和 README，并加入 Ubuntu 24.04 与 macOS 15 的 GitHub Actions 矩阵。随后修订工作流以使用 `actions/checkout@v6`、`actions/setup-node@v6`、`actions/setup-python@v6`、Node 22、Python 3.12 和官方 Unix 安装脚本的 `latest` 路径；历史可下载工具链固定版本未被验证，因此没有伪造固定 pin。工作流会记录安装脚本 SHA、MoonBit 版本、Node/Python 版本、提交 SHA 和 runner 平台。当前仅完成本地等价门禁，尚无远端 Actions run URL 或成功结论。

README 的公开命令、三组示例和独立库消费已在当前工作区复跑通过；这不替代干净 GitHub checkout 和两种远端 runner 的验证。真实流程、XLSX、竞品运行和赛事审核仍为未验证事项。
