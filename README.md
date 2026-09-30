# MoonReconcile

表格对账与差异解释工具。核对来自两个系统或两个时间点的表格，完成
**导入 → 列映射与规则配置 → 记录对应 → 字段差异解释 → 人工复核 → 最终报告导出**。

可复用的 MoonBit 核心（`invoke(request_json) -> String`）+ Node.js 适配层（文件、哈希、CLI）。

## 当前状态

**开发中。Task 1–4 的导入、配置、字段规则与精确对应已通过本地测试和独立审查。**
完整产品验收仍未完成；真实用户采用、性能和赛事审核也尚未得到验证。

| 能力 | 状态 |
| --- | --- |
| 严格 CSV 解析与表头/行宽校验 | 已实现 |
| 配置解析、校验与规范化输出 | 已实现 |
| `init_config` 生成草稿（不猜类型与主键） | 已实现 |
| `check_config` 规范化配置 | 已实现 |
| 核心字段比较：精确十进制、日期、显式转换与缺失策略 | 已实现；已接入整表比较 |
| `compare` 精确键对应、结构检查、字段比较 | 已实现；含候选评分、部分分配建议及预算保护 |
| `resolve` 人工复核回导 | **未实现**（返回 `unsupported_operation`） |
| CLI、快照指纹、报告导出 | **未实现** |
| 三个演示工作流、基准测试、CI | **未实现** |

实现计划：[docs/plans/2026-09-30-table-reconcile.md](docs/plans/2026-09-30-table-reconcile.md)（Task 1–8）。
逐项验收状态见 [docs/acceptance-matrix.md](docs/acceptance-matrix.md)，实际命令与提交见 [docs/validation.md](docs/validation.md)。

### 尚未验证的风险

- **需求证据缺失**：目前没有可复现的真实使用流程、人工耗时或误配成本数据。
- **竞品对照未完成**：[docs/dependency-audit.md](docs/dependency-audit.md) 记录了与 MoonRow、DataComPy、
  Record Linkage Toolkit 的文档对照；尚未进行本地竞品实测。
- **XLSX 未定**：首版只支持 CSV；是否需要 XLSX 入口取决于真实流程，尚未验证。
- 全部演示数据均为**合成**，不代表真实业务数据。

## 构建与测试

需要 [MoonBit](https://www.moonbitlang.com/download/) 工具链与 Node.js >= 22。

```sh
moon build cmd/bridge --target js   # 构建 MoonBit 核心的 JS 产物
moon test --target js               # MoonBit 单元测试
npm test                            # 构建 + Node 端 bridge 测试
```

## 用法

引擎是纯 JSON 进 / JSON 出，不接触文件系统。当前可用 `init_config`、`check_config`、含精确键与候选建议的 `compare`：

```js
import { invoke_bridge as invoke } from "./_build/js/debug/build/cmd/bridge/bridge.js";

// 生成待填写的草稿配置：只在表头完全一致时建议映射，不推断类型、主键或转换
JSON.parse(invoke(JSON.stringify({
  op: "init_config",
  left_csv: "id,name\n001,Widget\n",
  right_csv: "id,label\n001,Widget\n",
})));

// 校验并规范化配置；草稿（draft: true）会被拒绝，必须先人工编辑
JSON.parse(invoke(JSON.stringify({
  op: "check_config",
  config: { schema_version: 1, fields: [ /* ... */ ] },
})));
```

错误一律返回 `{"ok":false,"error":{"code","message","phase","side","record","field"}}`，
不会抛出到宿主进程。完整协议见实施计划中的 "JSON protocol v1"。

## 仓库结构

```
engine.mbt          invoke 分发（唯一对外契约）
model.mbt           引擎错误与配置数据结构
config.mbt          严格配置解析与规范化
csv.mbt             严格 CSV 状态机解析器（拒绝非法语法并定位记录）
*_wbtest.mbt        包内测试
cmd/bridge/         MoonBit → JS 导出层
tests/              Node 端契约测试与运行时探针
docs/               规格、实施计划、验收矩阵、依赖审计、策划书
```

## 文档

- [docs/spec.md](docs/spec.md) — 设计稿 v2（权威规格）
- [docs/plans/2026-09-30-table-reconcile.md](docs/plans/2026-09-30-table-reconcile.md) — 实施计划
- [docs/acceptance-matrix.md](docs/acceptance-matrix.md) — 验收矩阵
- [docs/dependency-audit.md](docs/dependency-audit.md) — 依赖审计与工具链实测版本
- [docs/project-proposal.md](docs/project-proposal.md) — 项目策划书

## 许可证

[MIT](LICENSE)
