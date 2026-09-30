# 验证记录

本文件只记录实际验证。Tasks 5–8 和完整产品验收尚未完成。

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
