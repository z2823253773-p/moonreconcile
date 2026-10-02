# MoonReconcile 架构说明

创建日期：2026-09-30

状态：**首版实现已完成。** 文中区分已实现代码、本地验证、远端验证和真实工作流证据。3c506f1的双平台CI已实际通过，见[交付记录](final-delivery.md)；真实工作流适配仍未验证。

本文中所有路径均相对于仓库根目录。权威契约见[实施计划](plans/2026-09-30-table-reconcile.md)的 "Locked interfaces and file map"、"JSON protocol v1" 与 "Config v1" 三节。

## 1. 三层边界总览

| 层 | 语言 | 入口 | 是否接触文件系统 | 职责 |
| --- | --- | --- | --- | --- |
| 引擎（核心） | MoonBit | [`invoke`](../engine.mbt) | 否 | 全部业务语义：CSV 语义、配置校验、转换与类型规则、精确键对应、候选评分、最大权部分匹配、决定校验、结果状态与报告数据 |
| 桥接 | MoonBit → JS | [`cmd/bridge/main.mbt`](../cmd/bridge/main.mbt) 的 `invoke_bridge` | 否 | 只把库函数 `invoke` 导出为 JS 可调用的字符串函数 |
| 宿主适配 | Node.js | [`cli/main.mjs`](../cli/main.mjs) | 是 | UTF-8 字节解码、文件读取、SHA-256、磁盘检查、输出目录事务、参数解析、报告序列化 |

引擎与宿主之间唯一的通信方式是 JSON 字符串：请求进、响应出。宿主不复制、不修补、不重算任何引擎语义。

## 2. MoonBit 核心负责什么

以下能力全部实现在 `.mbt` 文件中，Node 侧没有等价实现：

- **CSV 语义**：严格状态机解析（引号内换行算一条逻辑记录、`""` 转义、未加引号字段中禁止引号、闭引号后只允许分隔符或换行）、表头非空与不重复校验、行宽必须等于表头宽度、逻辑记录编号。
- **输入预算**：源表 64 MiB / 100000 数据记录 / 256 列 / 每格 64 KiB。私有角色预算解析器允许决策模板 128 MiB / 400000 数据记录，仍严格四列标题与同一单元格上限；核心独立限制非空 action 的 100000 行（去重前）及含标题的规范 CSV 64 MiB。超限返回结构化错误，不应用部分决定。
- **配置校验与规范化**：未知属性拒绝、`schema_version` 必须为 1、草稿拒绝、字段名/来源列唯一、`type` 必须显式声明、容差与类型匹配、键引用存在性、忽略列不得同时被映射、候选配置的 metric/字段类型匹配与权重/阈值范围。
- **转换与类型规则**：ASCII 空白裁剪、ASCII 小写、每侧单次有限值映射、显式缺失标记、三种类型（`text`/`decimal`/`date`）的解析与规范化；同时保留原始值、转换后值、规范化值。
- **精确键对应**：把组合键编码为无歧义 JSON 数组字符串索引，只在**两侧都唯一且键可用**时配对；重复键、缺失键、无对应键全部产生诊断而不做「首行优先」匹配。
- **候选评分**：all-pairs 或 OR-of-AND 分块，metric 为 `exact`/`edit`/`decimal`/`date`，加权平均（权重固定分母）得到整数分数；编辑相似度是码点级 Levenshtein。
- **最大权部分匹配**：在阈值过滤后的连通分量上跑匈牙利算法（虚拟未匹配节点 + 低位/非法边禁止），产生一对一「建议」。
- **决定校验**：动作形状、记录存在性、精确键端点锁定、重复去重、矛盾整批拒绝、候选外人工对应必须有非空 reason。
- **结果状态与报告数据**：`complete`/`incomplete` 计算状态、四种记录状态、退出码、键诊断与结构诊断、字段比较状态与解释字符串。

## 3. Node 适配层负责什么

- **UTF-8 字节解码**：[`decodeUtf8Fatal`](../cli/io.mjs) 用 `TextDecoder('utf-8', { fatal: true })`；非法字节报 `invalid_encoding`。文件开头单个 BOM 保留在解码结果中（引擎自己处理前导 BOM），文件中其它位置出现 BOM 直接报错。
- **文件读取**：[`readFileBounded`](../cli/io.mjs) 先 `stat` 再决定是否分配，拒绝 `limit+1` 字节；读取后校验文件既未变小也未变大。
- **SHA-256**：对原始快照字节和规范化配置字节计算小写 64 位十六进制摘要。
- **规范化 JSON 序列化**：[`canonicalJsonStringify`](../cli/io.mjs) 递归按键字典序排序、数组保序、无缩进、UTF-8、结尾恰好一个换行。写成显式函数而不是直接用 `JSON.stringify`，以免整数样式的键（`"10"` 排在 `"2"` 前）被重排。
- **磁盘检查**：`statfs` 预检可用空间（需要 `needed * 2 + 1 MiB`）；平台不支持时降级为「带检查的写入」并发出 warning，而不是直接失败。
- **输出目录事务**：所有产物先写入同级暂存目录，逐个 `writeFile` + `fsync`，再 `syncDirectory`，最后 `rename` 到目标路径。目标目录必须不存在或为空，不得是符号链接，不得与输入文件或只读源 RUN 别名。
- **参数解析**：命令白名单、操作数个数、选项白名单、重复选项、选项缺值一律报 `invalid_arguments`。
- **报告序列化**：[`cli/render.mjs`](../cli/render.mjs) 把引擎返回的 Result 渲染成 CSV / JSON / Markdown。**渲染层不重算任何分数、状态或差异**，所有值都从 Result 复制，嵌套证据以紧凑 JSON 单元输出以免丢信息。

### 边界原则

1. **所有业务语义在 MoonBit。** 宿主遇到引擎拒绝时，把它当作致命的宿主结果处理（退出 2），绝不改写成一次成功的运行。
2. **引擎是纯 JSON 进 / JSON 出，不接触文件系统，不终止宿主进程。** 见 [`engine.mbt`](../engine.mbt) 末尾 `invoke` 的注释。因此引擎可以脱离 Node 独立测试（[`tests/fixtures/library-consumer/`](../tests/fixtures/library-consumer/) 就是一个不经过 Node 文件宿主的消费者）。
3. **宿主不重写算法。** [`cli/bridge.mjs`](../cli/bridge.mjs) 在构建产物缺失或不导出 `invoke_bridge` 时直接报 `bridge_unavailable`，不提供任何降级实现。
4. **引擎版本必须一致。** 宿主把 `result.engine_version` 与 [`ENGINE_VERSION`](../cli/io.mjs)（当前 `0.1.0`）比对，不一致报 `unsupported_engine_version`，以免用改动过的算法静默重放旧快照。

## 4. 模块职责

| 文件 | 职责（读源码归纳） |
| --- | --- |
| [`moonreconcile.mbt`](../moonreconcile.mbt) | 包入口，无逻辑；仅说明公开契约位于 `engine.mbt` |
| [`model.mbt`](../model.mbt) | 数据结构与错误：`EngineError`、`CsvTable`（别名 `Table`）、`ExactPair`、`Decision`、`ReconciliationResult`、`FieldConfig`、`Config`；`engine_error` 与 JSON 包装（`error_to_json`/`success_to_json`） |
| [`config.mbt`](../config.mbt) | `parse_config` 严格校验、`normalize_config` 规范化输出、`draft_field` 与 `build_draft_config` 草稿模板；含 `valid_nonnegative_decimal` 与 `parse_int_json` |
| [`csv.mbt`](../csv.mbt) | 严格 CSV 状态机 `parse_csv` / 私有 `parse_csv_with_budget`、UTF-8 字节预算 `within_utf8_budget`、表头与行宽校验 |
| [`decimal.mbt`](../decimal.mbt) | `ExactDecimal`（BigInt 系数 + 标度）的解析、规范化、对齐、加减乘、比较、绝对值与格式化；**不使用二进制浮点** |
| [`date.mbt`](../date.mbt) | 严格 `YYYY-MM-DD` 解析（长度必须为 10）、闰年判定、格里高利日序号 |
| [`rules.mbt`](../rules.mbt) | `normalize_value`（转换链 + 缺失 + 类型解析）、`compare_field`（状态、差异、阈值、解释）、`ascii_trim`、`ascii_lower` |
| [`exact.mbt`](../exact.mbt) | 组合键 `key_for_row`、键索引、精确配对、结构/键诊断、待处理记录与计数、退出码计算、调用候选阶段（`compare_tables_with_budget` / `compare_tables`） |
| [`candidates.mbt`](../candidates.mbt) | `generate_candidates` / `generate_candidates_with_budget`：配对预检、分块并集、`edit_similarity`（码点 Levenshtein）、连通分量、编辑预算、阈值过滤、分量侧限、调用分配器 |
| [`assignment.mbt`](../assignment.mbt) | `solve_assignment`：匈牙利最大权部分匹配，支持虚拟未匹配节点与禁止边，左右各上限 100 |
| [`decisions.mbt`](../decisions.mbt) | `parse_decisions`（严格表头 `action,left_id,right_id,reason`、ID 形式 `LN`/`RN`）、`apply_decisions`（整批校验、去重、矛盾拒绝、累计重放、人工配对重算字段比较） |
| [`report.mbt`](../report.mbt) | `result_to_json`：记录条目与四种状态、配对、字段、候选、决定、结构、键诊断、汇总、退出码 |
| [`engine.mbt`](../engine.mbt) | `handle_request` 分发四个操作、请求形状校验、`invoke` 唯一对外入口 |

配套的 `*_wbtest.mbt` 是包内白盒测试，不参与产品运行时。

## 5. 数据流

```
用户 / 脚本
   │  argv
   ▼
cli/main.mjs ── parseArguments ──► COMMANDS 白名单
   │                                 │
   │  读文件（readFileBounded）+ decodeUtf8Fatal + sha256Hex
   ▼
cli/bridge.mjs ── loadBridgeInvoke ──► _build/js/debug/build/cmd/bridge/bridge.js
   │                                        │  invoke_bridge(String) -> String
   │                                        ▼
   │                              cmd/bridge/main.mbt → engine.invoke
   │                                        │
   │                              engine.mbt handle_request
   │                                        │  按 op 分发
   │            ┌───────────────────────────┼───────────────────────────┐
   │            ▼                           ▼                           ▼
   │     init_config                   check_config                 compare / resolve
   │     csv.parse_csv ×2              config.parse_config          csv.parse_csv ×2
   │     build_draft_config            normalize_config             config.parse_config
   │                                                                compare_tables
   │                                                                  ├─ rules.compare_field
   │                                                                  ├─ candidates.generate_candidates
   │                                                                  └─ assignment.solve_assignment
   │                                    resolve 额外：
   │                                    parse_decisions + apply_decisions
   │                                        │
   ▼                                        ▼
 JSON 响应 ─────────────────────────── result_to_json → Result
   │
   ├─ cli/io.mjs  requireResult（校验 engine_version）
   ├─ cli/main.mjs runIdFrom + publishRun（暂存 → fsync → rename）
   └─ cli/render.mjs  renderReportJson / render*Csv / renderSummaryMarkdown
   │
   ▼
 run 目录（11 个文件）+ stdout 的 run / run_id / exit 摘要
```

## 6. JSON 协议 v1

请求形状（[`engine.mbt`](../engine.mbt)）：

| op | 请求字段 | 成功响应 |
| --- | --- | --- |
| `init_config` | `left_csv`, `right_csv` | `{"ok":true,"config":Config}`，其中 `draft:true`、各字段 `type:null` |
| `check_config` | `config` | `{"ok":true,"config":Config}`（规范化后的默认值） |
| `compare` | `left_csv`, `right_csv`, `config` | `{"ok":true,"config":Config,"result":Result}` |
| `resolve` | `left_csv`, `right_csv`, `config`, `decisions_csv` | 同上 |

错误一律为：

```json
{"ok":false,"error":{"code":"","message":"","phase":"","side":null,"record":null,"field":null}}
```

`phase` 取值：引擎侧会产生 `request`、`input`、`configuration`、`decisions`；宿主侧会产生 `host`、`manifest`、`output`，以及在缺少引擎自带 `phase` 时回退使用的 `engine`。校验失败不会返回一个「空行的成功结果」。

`compare` 与 `resolve` 在缺失已声明来源列时返回 `ok:false`，但响应里仍附带 `result` 字段（`status:"incomplete"`、`exit_code:2`）；宿主只读 `ok`，因此这种情况退出 2、不产出 run 目录。

### Result 结构（来自 [`report.mbt`](../report.mbt)）

固定包含：`schema_version:1`、`engine_version`、`computation:{status, issues}`、`records`、`pairs`、`fields`、`candidates`、`decisions`、`structure`、`key_issues`、`summary`、`exit_code`。

- 记录 ID 用 `L1`/`R1`，编号是数据逻辑记录序号，从 1 开始；`records` 顺序固定为先左后右。
- `pairs` 条目：`{left_id, right_id, source, reason, override}`，`source` 为 `exact_key` 或 `human_review`。
- `fields` 条目：`{left_id, right_id, field, type, left_raw, right_raw, left_transformed, right_transformed, left_canonical, right_canonical, status, rules, difference, tolerance, explanation}`。十进制有符号差是左减右；日期有符号差是左减右的天数。
- 记录状态只有四种：`paired`、`unmatched`、`pending_review`、`unprocessed`。
- 引擎语义结果中不含时钟或随机 ID。

## 7. run 目录

`compare` 与 `resolve` 产出**同构**的 run 目录。实测 `compare` 后目录内容如下（[`cli/main.mjs`](../cli/main.mjs) 的 `publishRun`）：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 清单：`schema_version`、`run_id`、`engine_version`、两侧 `*_sha256` 与 `*_bytes`、`config_sha256`/`config_bytes`、`provenance`、`created`；复核运行额外有 `parent_run_id`、`decisions_sha256` |
| `input/left.csv` | 左侧原始字节快照（逐字节复制） |
| `input/right.csv` | 右侧原始字节快照 |
| `config.json` | 规范化配置的规范 JSON 字节 |
| `report.json` | 完整 Result |
| `pairs.csv` | 表头 `left_id,right_id,source,reason,override` |
| `fields.csv` | 16 列表头，末列 `evidence` 是嵌套 JSON 单元 |
| `candidates.csv` | 表头 `left_id,right_id,score,component_id,suggested,field_scores,diagnostics,evidence` |
| `decisions.csv` | 可编辑的累计决定表，表头 `action,left_id,right_id,reason` |
| `unresolved.csv` | 表头 `side,id,record,status,reason`，只含 `pending_review` 与 `unprocessed` |
| `summary.md` | Markdown 摘要（覆盖情况、记录核算表、字段比较表、结构与键问题、复核统计） |

共 **11 个文件**。（实施计划的文件清单把 `summary.md` 写在括号外，容易被误读为 10 个；以实际产出为准是 11 个。）

实测清单示例（`examples/orders`）：

```json
{
  "schema_version": 1,
  "run_id": "cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638",
  "engine_version": "0.1.0",
  "left_sha256": "8a7d1f11f81cd1ed71f1a26e0a6b26b160821631dea2c943dde16e5506fe28ec",
  "left_bytes": 96,
  "right_sha256": "e1a163b808cd9e0cccfd1bf7edddb9097af64990d43a9fb435b4921945a1eeca",
  "right_bytes": 87,
  "config_sha256": "5eac4922d1f2683f99eaddc42682306bba92a029133724f2bcd889c7f5afe8db",
  "config_bytes": 1073,
  "provenance": "compare <left 绝对路径> + <right 绝对路径>",
  "created": "2026-09-30T14:38:40.696Z"
}
```

## 8. run_id 的推导方式

定义在 [`cli/main.mjs`](../cli/main.mjs) 的 `runIdFrom`：

```
material = JSON.stringify([engine_version, left_sha256, right_sha256, config_sha256])
run_id   = sha256_hex(utf8(material))
```

要点：

- 四项分别是引擎版本字符串和三个**小写 64 位十六进制** SHA-256 摘要。`JSON.stringify` 作用于字符串数组，因此 `material` 形如 `["0.1.0","<64 hex>","<64 hex>","<64 hex>"]`，无空格。
- `left_sha256` / `right_sha256` 是对**原始文件字节**（含 BOM、引号、换行）取的摘要。
- `config_sha256` 是对**规范化配置的规范 JSON 字节**取的摘要，由宿主对引擎返回的 `response.config` 做 `canonicalJsonStringify` 得到，**不是**用户原始配置文件的摘要。因此同一份业务配置在书写风格不同（键顺序、缩进、默认值省略）时会得到相同的 `run_id`。
- 已实测复核：对 `examples/orders` 的 run 目录重算该公式，结果与 `manifest.json` 中的 `run_id` 完全一致，且 `config.json` 文件的 SHA-256 与 `config_sha256` 一致。
- `resolve` 不重新推导 run_id，而是直接沿用父 run 的 `run_id`，并另加 `parent_run_id` 与 `decisions_sha256`。因此「同一个基线 + 不同决定」的两个复核 run 具有相同的 `run_id`，靠 `decisions_sha256` 与 `provenance` 区分。

## 9. 引擎内的固定预算（非用户可配）

源码中的常量：

| 位置 | 常量 | 值 |
| --- | --- | --- |
| [`exact.mbt`](../exact.mbt) `compare_tables` | `pairs` | 100000 |
| | `edit_cells` | 20000000 |
| | `max_component_side` | 100 |
| | `max_edit_codepoints` | 512 |
| [`csv.mbt`](../csv.mbt) | 源表文本上限 | 67108864 字节（64 MiB） |
| | 单元上限 | 65536 字节（64 KiB） |
| | 列数上限 | 256 |
| | 数据记录上限 | 100000 |
| [`decisions.mbt`](../decisions.mbt) | 原始模板字节 / 数据记录 | 128 MiB / 400000 |
| | 非空 action 数据记录（去重前） | 100000 |
| | 规范有效动作 CSV（含 31 字节标题） | 64 MiB |
| [`decimal.mbt`](../decimal.mbt) | 有效位数 / 标度 | 64 位 / 18 |
| [`assignment.mbt`](../assignment.mbt) | 左右规模上限 | 各 100 |
| [`io.mjs`](../cli/io.mjs) | `DEFAULT_LIMITS.maxInputBytes`（源表/快照/配置/manifest） | 64 MiB |
| | `DEFAULT_LIMITS.maxDecisionBytes`（决策原始文件） | 128 MiB |

规范动作 CSV 字节在 MoonBit 中计入 UTF-8、双引号加倍、必要的包围引号、逗号和 LF；Node 只选择原始角色字节守卫，不复制决定语义。累计导出最多 100000 动作、200000 记录空白和 100000 建议空白，后两类合计最多 4000000 字节，因此满足原始回导预算。空 action 行仍计入原始预算。

计划明确说明「初始固定预算是引擎常量，不是用户可配置的生产选项」；测试可以通过内部入口注入更小的预算，CLI 不暴露覆盖开关。

## 10. 未验证项与仓库注记

- `.github/workflows/ci.yml` 定义 Ubuntu 24.04/macOS 15 门禁。先前公开运行 `36739067019` 与 `36734569700` 均在格式检查失败，未运行其后测试；Task 8 更新格式后仍须对最终 SHA 执行远端复验。
- `cmd/main/main.mbt` 是未被 CLI 使用的模板桩；公开 Node CLI 构建入口使用 `cmd/bridge`。它不参与本产品流程。
- 工作流与基准数字只来自 `examples/` 合成数据和本地机器。仓库没有真实用户数据、准确率或工时节省证据。
- 独立 MoonBit 库消费脚本是开发验收，Python 3.12 仅为该脚本的开发时需求；Node CLI 的运行时不依赖 Python。
