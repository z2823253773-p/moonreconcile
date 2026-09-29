# 依赖审计

创建日期：2026-09-30。对应实施计划 Task 1 的"探针"条目。

**本文件区分三种证据等级，不得混用：**

- **实测**：在本仓库、当前工具链上实际执行命令得到的输出。
- **文档记载**：来自上游 README/文档，未经本地复现。
- **未知**：尚未验证。

## 1. 工具链实测版本

由 `moon version --all` 在本机实际输出：

| 组件 | 版本 |
| --- | --- |
| moon | 0.1.20260713 (75c7e1f 2026-07-13) |
| moonc | v0.10.4+2cc641edf (2026-07-15) |
| moonrun | 0.1.20260713 (75c7e1f 2026-07-13) |
| Node.js | v24.15.0 |
| 目标 | `preferred_target = "js"` |

计划中记录的 `MoonBit 0.1.20260713 / moonc v0.10.4+2cc641edf` 与实际一致。

## 2. MoonBit JS 导出机制（实测）

**结论：`String -> String` 的导出可用，Node 可直接 import 调用，无需宿主包装层。**

探针脚本：[tests/js_api_probe.mjs](../tests/js_api_probe.mjs)，执行方式：

```sh
moon build cmd/bridge --target js
node tests/js_api_probe.mjs
```

实际输出：

```
Node imported and called the MoonBit String -> String export.
Export shape: cmd/bridge/bridge.js -> invoke_bridge
```

要点：

- 产物路径为 `_build/js/debug/build/cmd/bridge/bridge.js`（**不是** `cmd/bridge/main.js`；早期测试写错过这个路径，已修正）。
- 导出符号经名称修饰，但以 `.d.ts` 中声明的 `invoke_bridge` 对外暴露：
  `export { _M0FP415z2823253773_2dp13moonreconcile3cmd6bridge14invoke__bridge as invoke_bridge }`
- 配置见 [cmd/bridge/moon.pkg](../cmd/bridge/moon.pkg)：`pkgtype(kind: "foreign_library")` + `options(link: { "js": { "exports": ["invoke_bridge"], "format": "esm" } })`。
- 因此**不需要**计划里备选的"生成包装器"方案，引擎语义未被宿主重写。

### 实测的 MoonBit 语言约束

这些是修复初始编译错误时逐一探针确认的，影响后续所有 Task：

- `Json::Array(...)` / `Json::True` / `Json::False` **不可作为构造函数使用**，报 `Cannot create values of the read-only type`。必须用 `Json::array(...)` / `Json::boolean(true)` / `Json::boolean(false)` / `Json::null()`。
- 可选参数 `field? : String` 可位置传值，**不能显式传 `None`**；可空参数 `field : String?` **不能自动提升**。两者不可混用，需在函数体内 `match` 解包。
- `Array::index_of` 不存在，用 `Array::search(x) -> Int?`。
- `Map` 迭代写 `for k, v in map`，不是 `for (k, v) in map.to_array()`。
- `Map[String, String]` 转 `Json` 用 `Json::object(m.map(fn(_k, v) { Json::string(v) }))`。
- `StringView::to_string()` 已废弃，改用 `to_owned()`。

## 3. NyaCSV（未知 / 未验证）

**状态：未知。本仓库当前不使用任何 CSV 依赖。**

计划 Task 1 要求"评估 NyaCSV 是否可用于严格解析"。实际执行 `moon add nyacsv` 时，命令在无网络访问的沙箱中挂起，未能取得包或版本信息，探针被终止。

因此：

- **没有**验证过 NyaCSV 在引号内换行、CRLF、引号内转义、重复表头、空表头、末尾空字段、逻辑记录编号、末尾分隔符等输入上的行为。
- **没有**任何版本号、源码或运行证据可引用。
- 本项目的 CSV 解析**未采用 NyaCSV**，而是自行实现严格状态机解析器：[csv.mbt](../csv.mbt)。

自行实现的理由（不依赖未经证实的 NyaCSV 缺陷）：本项目的契约要求"拒绝非法语法并定位到侧/逻辑记录"（见 `csv_wbtest.mbt` 的 `illegal_quote_rejected`、`unequal_width_reports_record`、`duplicate_or_blank_header_rejected`）。这类"严格拒绝"语义与宽松解析器的常见取向相反，需在采用前实测确认。

**待办（阻塞本文件结论，不阻塞当前代码）**：在网络可用环境下重试 `moon add nyacsv`，按上述输入逐项实测，把结论补入本节。在补齐之前，不得声称"NyaCSV 不满足需求"，只能声称"未验证"。

## 4. 运行时依赖

除 MoonBit 核心库与 Node.js 内置模块外，`package.json` **无任何第三方依赖**：

- 测试使用 Node 内置 `node:test` + `node:assert`，无测试框架依赖。
- 无 `dependencies` / `devDependencies` 字段。
- 因此当前不存在第三方许可证传染或供应链风险面。

## 5. 许可证

本仓库：[LICENSE](../LICENSE)，MIT。

工具链为 MoonBit 官方发行版，其许可证随官方发行版提供，本仓库未重新分发其源码。
