# MoonReconcile

表格对账与差异解释工具。核对来自两个系统或两个时间点的表格，完成
**导入 → 列映射与规则配置 → 记录对应 → 字段差异解释 → 人工复核 → 最终报告导出**。

可复用的 MoonBit 核心（`invoke(request_json) -> String`）+ Node.js 适配层（文件、哈希、CLI）。

## 当前状态

**开发中。Task 1–7 已实现并在本地通过测试、独立审查与端到端运行。**
完整产品验收、多平台 CI 实际执行和赛事审核仍未完成；真实用户采用与性能也尚未验证。

| 能力 | 状态 |
| --- | --- |
| 严格 CSV 解析与表头/行宽校验 | 已实现 |
| 配置解析、校验与规范化输出 | 已实现 |
| `init_config` 生成草稿（不猜类型与主键） | 已实现 |
| `check_config` 规范化配置 | 已实现 |
| 核心字段比较：精确十进制、日期、显式转换与缺失策略 | 已实现 |
| `compare` 精确键对应、结构检查、字段比较 | 已实现；含候选评分、部分分配建议及预算保护 |
| `resolve` 人工复核回导 | 已实现；快照指纹校验及累计重放 |
| CLI 四命令、快照指纹、11 文件导出 | 已实现；7 项初审缺陷修复并独立复审通过 |
| 三个合成演示工作流，各跑通 compare→resolve→重放 | 已实现（`npm run test:workflows`） |
| 确定性基准测试 | 已实现（`npm run benchmark`），结果见 `docs/validation.md` |
| 多平台 CI 配置 | 已提交但**尚未在远端实际运行过** |
| 需求证据、竞品实测、XLSX 入口 | **未验证** |

实现计划：[docs/plans/2026-09-30-table-reconcile.md](docs/plans/2026-09-30-table-reconcile.md)（Task 1–8）。
逐项验收状态见 [docs/acceptance-matrix.md](docs/acceptance-matrix.md)，实际命令与提交见 [docs/validation.md](docs/validation.md)。

**本仓库尚未完成的一件事**：多平台 CI（`.github/workflows/ci.yml`）已写入仓库，但从未在 GitHub Actions 上执行过，因此没有任何远端 CI 通过证据。该工作流的每条命令都已在本机单独实跑通过，但"本机跑通"不等于"CI 跑通"。

### 尚未验证的风险

- **需求证据缺失**：目前没有可复现的真实使用流程、人工耗时或误配成本数据。
- **竞品对照未完成**：[docs/dependency-audit.md](docs/dependency-audit.md) 记录了与 MoonRow、DataComPy、
  Record Linkage Toolkit 的文档对照；尚未进行本地竞品实测。
- **XLSX 未定**：首版只支持 CSV；是否需要 XLSX 入口取决于真实流程，尚未验证。
- 全部演示数据均为**合成**，不代表真实业务数据。

## 构建与测试

需要 [MoonBit](https://www.moonbitlang.com/download/) 工具链与 Node.js >= 22。
实测工具链版本见 [docs/dependency-audit.md](docs/dependency-audit.md)。

```sh
npm run build            # 构建 MoonBit 核心的 JS 产物
moon test --target js    # MoonBit 核心单元测试
npm test                 # 构建 + 宿主集成测试
npm run test:workflows   # 三个合成演示工作流端到端
npm run benchmark        # 确定性规模基准
```

## 用法

四条命令。运行 `node cli/main.mjs` 不带参数即可看到完整用法。

```sh
# 1. 生成待填写的规则草稿：只在表头名称完全一致时建议映射，
#    不推断类型、主键、货币或日期格式。草稿必须先人工编辑。
node cli/main.mjs init-config LEFT.csv RIGHT.csv --out rules.json

# 2. 校验并规范化规则；未编辑的草稿（draft: true）会被拒绝
node cli/main.mjs check-config rules.json

# 3. 对照两份表，产出运行目录（含快照、报告、复核模板）
node cli/main.mjs compare LEFT.csv RIGHT.csv --config rules.json --out run-001

# 4. 回导人工复核决定；重算并累计应用全部决定
node cli/main.mjs resolve run-001 --decisions reviewed.csv --out run-001-reviewed
```

`compare` / `resolve` 的退出码：`2`（校验或 I/O 错误）> `3`（计算未完成）> `1`（完成但有未解决差异）> `0`（完成且无问题）。

`run-001/` 内含左右输入的只读快照与 `manifest.json` 指纹。**`resolve` 只接受运行目录、不接受原始 CSV**，
因此删除原始文件后仍可完成复核。详见 [docs/review-workflow.md](docs/review-workflow.md)。

引擎本身是纯 JSON 进 / JSON 出、不接触文件系统；错误一律返回
`{"ok":false,"error":{"code","message","phase","side","record","field"}}`，不会抛出到宿主进程。
完整协议见实施计划中的 "JSON protocol v1"，分层说明见 [docs/architecture.md](docs/architecture.md)。

### 示例

`examples/{orders,migration,catalog}/` 各含左右输入、规则与复核决定。**全部为合成数据**，
不代表真实业务数据。完整命令见各目录下的 README。

## 仓库结构

```
engine.mbt           invoke 分发（唯一对外契约，4 个操作）
model.mbt            引擎错误与结果数据结构
config.mbt           严格配置解析与规范化
csv.mbt              严格 CSV 状态机解析器（拒绝非法语法并定位记录）
decimal.mbt / date.mbt / rules.mbt    精确十进制、日历日期、字段比较规则
exact.mbt            组合键对应与结构诊断
candidates.mbt / assignment.mbt      候选评分与最大权部分匹配
decisions.mbt / report.mbt           决定校验、累计重放与报告数据
*_wbtest.mbt / *_goldens_wbtest.mbt  包内与金标准测试
cli/                 Node 宿主层：参数、I/O 事务、哈希、渲染
scripts/             构建、工作流、基准、独立 oracle 脚本
cmd/bridge/          MoonBit → JS 导出层
tests/               宿主集成测试与合成工作流夹具
examples/            三个合成演示（orders / migration / catalog）
docs/                规格、计划、验收矩阵、架构、配置、复核、依赖审计、策划书
```

## 文档

- [docs/spec.md](docs/spec.md) — 设计稿 v2（权威规格）
- [docs/plans/2026-09-30-table-reconcile.md](docs/plans/2026-09-30-table-reconcile.md) — 实施计划
- [docs/architecture.md](docs/architecture.md) — 分层架构与数据流
- [docs/configuration.md](docs/configuration.md) — 配置字段与校验规则
- [docs/review-workflow.md](docs/review-workflow.md) — 复核流程与退出码
- [docs/acceptance-matrix.md](docs/acceptance-matrix.md) — 逐项验收状态
- [docs/validation.md](docs/validation.md) — 实际命令、提交与结果
- [docs/limitations.md](docs/limitations.md) — 已知边界与未验证项
- [docs/dependency-audit.md](docs/dependency-audit.md) — 依赖审计与工具链实测版本
- [docs/project-proposal.md](docs/project-proposal.md) — 项目策划书

## 许可证

[MIT](LICENSE)
