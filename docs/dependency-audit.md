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

## 3. NyaCSV 0.3.3（独立临时项目实测）

**结论：该版本提供有用的引号/换行解析，但不能单独满足本项目的严格拒绝与诊断契约。** 本项目没有将它加入正式依赖，自写解析器的取舍由以下可复现探针支撑。这是输入行为结论，不是对其通用 CSV 库质量的评价。

2026-09-30 在 `/private/tmp` 的隔离 MoonBit 项目执行 `moon add moonbit-community/NyaCSV@0.3.3`，成功下载包；`moon.mod` 锁定 0.3.3。临时项目 `moon.pkg` 使用 `import { "moonbit-community/NyaCSV" @csv, }`。将 [探针函数](probes/nyacsv_probe.mbt)、[8 项输入测试](probes/nyacsv_contract_wbtest.mbt) 与 [探针依赖声明](probes/moon.pkg.txt) 放入该项目根包（将 `moon.pkg.txt` 命名为 `moon.pkg`），运行 `moon check --target js` 与 `moon test --target js`：前者 exit 0、无诊断，后者 **8 passed, 0 failed**。探针文件留在本仓库便于重放，但不参与产品构建。

| 输入 | NyaCSV 0.3.3 实测结果 | 本项目契约 |
| --- | --- | --- |
| 未闭合的引用字段 `1,"bad` | 返回数据行，值为 `bad` | 拒绝非法语法 |
| 非引用字段内嵌 `bad"quote` | 返回字段原文 | 拒绝非法引号 |
| 引号内 CRLF、末尾空字段 | 保留 CRLF 和空字段 | 同样需要保留 |
| 重复表头 `id,id` | 返回两个同名表头 | 拒绝重复表头 |
| 空表头 `,id` | 返回一个空列名 | 拒绝空表头 |
| 引号内换行后的第二条记录 | 正确返回两条数据行，但 API 不返回原始逻辑记录号 | 错误需定位到逻辑记录 |
| 末尾单个换行 | 没有额外数据记录 | 同样不添加记录 |
| 空白物理行 | 默认跳过 | 本项目需按显式行宽规则处理 |

包公开 API `CSV::parse_string(String, options?) -> CSV` 没有错误返回值，也没有逐行源位置/逻辑记录号诊断接口。源码中的 `parse` 结束后也不检查 `in_quotes`。因此若复用它，还需另写严格解析/定位逻辑；维护两套解析路径反而容易不一致。正式代码选择单套 MoonBit 严格状态机。源码定位：[NyaCSV 仓库](https://github.com/moonbit-community/NyaCSV/blob/d59f2e2aef192aeaac8187f5c5cc0926a12e5a84/parser.mbt)；该 GitHub HEAD 仅是调研时的源码参照，**不冒充 Mooncakes 0.3.3 下载包的同一提交**。运行测试才是本节版本行为的主要证据。

## 4. 运行时依赖

除 MoonBit 核心库与 Node.js 内置模块外，`package.json` **无任何第三方依赖**：

- 测试使用 Node 内置 `node:test` + `node:assert`，无测试框架依赖。
- 无 `dependencies` / `devDependencies` 字段。
- 因此当前不存在第三方许可证传染或供应链风险面。

## 5. 许可证

本仓库：[LICENSE](../LICENSE)，MIT。

工具链为 MoonBit 官方发行版，其许可证随官方发行版提供，本仓库未重新分发其源码。
