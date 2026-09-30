# 验证记录

本文件只记录实际验证。Tasks 7–8 和完整产品验收尚未完成。

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

独立审查指出稀疏单边分量的全表标记初始化和线性成员判断存在二次工作量；10000/30000 单边分别约 0.77/6.94 秒。该观察是待修复的性能证据，不是支持容量承诺；Task 7 将修复并重新测量。人工回导、CLI、完整演示与远端 CI 尚未验收。

## Task 5

实现提交 `5281187566dff5eefefeddaa8433520b582056e6`，接续[独立审查](evidence/task5-review.md) PASS（Claude Code 配置路由 DeepSeek-flash；Astra 因额度中断未给出结论）。控制器隔离副本 check/test82/npm8/Python240 均 exit0；另200组累计重排、重复、状态、字段与退出码独立断言通过。生产101×101预算受限案例全量人工处置后仍 incomplete/exit3/unresolved0。源码归档于 `tests/decisions-oracle.test.mjs`。

`summary.key_issue_count` 保留所有键诊断，包括信息性 `no_key_configured` 和 `key_not_found`。这两个代码不单独阻止完全人工复核且无其他问题的运行退出0；重复/缺失/无效键异常、内容差异、无对应和结构问题仍触发退出1。计算历史不完整仍优先退出3。运行目录指纹、文件事务与CLI是Task6，不能由核心复核测试替代。

## Task 6

初版 `ed0eeba` 的82MoonBit/43Node门禁通过，但[独立审查](evidence/task6-review.md)复现七项文件保护、I/O、回导及显示缺陷。因此初版未验收。修复提交 `4304f75c8fafbde63e2a6be8d88cbfa4a116bea9` 补充先红后绿的回归测试，82MoonBit/53Node通过，七项均在[独立定向复审](evidence/task6-rereview.md)确认修复。

当前CLI已实现四个命令及11个输出文件，快照不依赖原路径，规范化配置和输入SHA/大小/引擎版本/run_id均校验，累计决定可二次回导。不能提供原子不覆盖文件发布的文件系统，init-config明确退出2，不使用会覆盖文件的rename回退。CPU/内存规模、三个完整示例及远端CI仍待后续验证。

## 独立库消费早期检查

`python3 scripts/check-library-consumer.py` 在 `3ae6245` 的归档代码与独立模块工作区中通过84/84（核心82+外部2）。它不使用Node文件宿主；这不是Mooncakes发布证明。当前官方工具链临时验证记录将随最终CI证据归档，用户全局工具链未改动。
