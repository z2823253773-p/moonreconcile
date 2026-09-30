# 配置参考（Config v1）

创建日期：2026-09-30

状态：**开发中。** 本文的每条规则都对应 [`config.mbt`](../config.mbt) 中的实际校验分支；文中所有错误信息与实测输出一致。未实现的选项在末尾列出。

相关文档：[架构说明](architecture.md)、[复核流程](review-workflow.md)、[实施计划](plans/2026-09-30-table-reconcile.md)（"Config v1" 为权威契约）。

## 0. 首要原则：程序不猜

MoonReconcile 不会自动推断任何业务语义：

- **不猜类型**：`init-config` 生成的草稿里每个字段的 `type` 都是 `null`，`check_config` 会直接拒绝。类型必须由人显式写成 `text`、`decimal` 或 `date`。
- **不猜货币**：没有货币概念，也没有隐式汇率或精度补齐；十进制按精确十进制运算。
- **不猜日期格式**：只接受严格 `YYYY-MM-DD`（长度恰好 10 个字符）。
- **不猜主键**：`init-config` 生成的 `key` 是空数组；不配置 `key` 时不会做任何自动配对，全部记录保持待复核。
- **不做 Unicode 规范化**：只提供 `trim_ascii` 与 `lower_ascii`，作用范围仅限 ASCII 空白与 `A-Z`。全角/半角、重音、连字等一律不归一。
- **不推断列映射**：草稿只在左右表头**完全同名**时才建议来源列，其余留空，且草稿本身不可执行。
- **不自动决定业务是否通过**：程序只标记差异与未解决项，是否接受由人写入决定表。

## 1. 配置 schema

```json
{
  "schema_version": 1,
  "draft": false,
  "fields": [ /* 至少一个字段映射 */ ],
  "key": [],
  "ignore_left": [],
  "ignore_right": [],
  "candidates": null
}
```

| 顶层键 | 类型 | 是否必需 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `schema_version` | 整数 | **必需** | 无 | 必须恰好等于 `1`；缺失、非整数或其它值一律拒绝 |
| `draft` | 布尔 | 可选 | 无 | 出现且为 `true` 时拒绝（草稿必须先编辑）；`false` 或省略则通过 |
| `fields` | 对象数组 | **必需** | 无 | 至少一项，且每项必须是对象 |
| `key` | 字符串数组 | 可选 | `[]` | 每一项必须是一个已映射的逻辑字段名 |
| `ignore_left` | 字符串数组 | 可选 | `[]` | 显式声明「已知但不参与对账」的左侧原始列名 |
| `ignore_right` | 字符串数组 | 可选 | `[]` | 同上，右侧 |
| `candidates` | 对象或 `null` | 可选 | `null` | 候选生成与建议配置 |

顶层出现任何未列出的键都会被拒绝（`unknown property '<key>' in config`）。字段对象与 `candidates` 对象同样拒绝未知键。

## 2. 字段属性

| 属性 | 类型 | 必需 | 默认 | 语义 |
| --- | --- | --- | --- | --- |
| `name` | 字符串 | **必需** | 无 | 逻辑字段名。必须非空白；在同一份配置内唯一。`key` 与 `candidates` 都通过它引用 |
| `left` | 字符串 | **必需** | 无 | 左侧来源列名。必须非空；同一左侧列只能映射一次 |
| `right` | 字符串 | **必需** | 无 | 右侧来源列名。必须非空；同一右侧列只能映射一次 |
| `type` | 字符串 | **必需** | 无 | 只能是 `text`、`decimal`、`date`。缺失或 `null` 会被拒绝，**没有默认类型** |
| `compare` | 布尔 | 可选 | `true` | 为 `false` 时该字段仅作为身份/键使用，不产生字段比较结果 |
| `trim_ascii` | 布尔 | 可选 | `false` | 裁剪首尾 ASCII 空白（空格、`\t`、`\n`、`\r`、`\f`、`\v`） |
| `lower_ascii` | 布尔 | 可选 | `false` | 把 `A-Z` 转为小写；不影响非 ASCII 字符 |
| `left_values` | 字符串→字符串对象 | 可选 | `{}` | 左侧单次有限值映射表 |
| `right_values` | 字符串→字符串对象 | 可选 | `{}` | 右侧单次有限值映射表 |
| `missing` | 字符串数组 | 可选 | `[]` | 缺失标记集合，在转换之后比对 |
| `both_missing` | 字符串 | 可选 | `"equal"` | 只能是 `equal` 或 `issue` |
| `abs_tol` | 十进制字符串 | 可选 | `"0"` | 绝对容差，非负十进制字面量 |
| `rel_tol` | 十进制字符串 | 可选 | `"0"` | 相对容差，非负十进制字面量 |
| `days_tol` | 非负整数 | 可选 | `0` | 日期天数容差 |

关于字符串形式的容差：`abs_tol`/`rel_tol` 必须是**字符串**，不能写成 JSON 数字。`1e-3` 这类科学计数法会被拒绝（`abs_tol must be a nonnegative decimal string`），允许的形式是普通十进制字面量，例如 `"0.02"`、`"0"`、`"+1.5"`。这是为了避免二进制浮点进入比较过程。

`both_missing` 没有第三个取值，写成 `"maybe"` 之类会被拒绝。

## 3. 转换执行顺序

[`rules.mbt`](../rules.mbt) 的 `normalize_value` 按固定顺序执行，顺序不可调换：

```
原始值
  → 1. trim_ascii       （若开启）裁剪 ASCII 空白，记入 rules: "trim_ascii"
  → 2. lower_ascii      （若开启）ASCII 转小写，记入 "lower_ascii"
  → 3. 单次值映射        （按侧取 left_values 或 right_values，用当前已转换的值查表）
                        命中则整体替换并记入 "value_map"
  → 4. missing 检查      （用转换后的值比对 missing 集合；命中则记入 "missing_marker"，
                        判定为 missing 并立即返回，不做类型解析）
  → 5. 类型解析          text / decimal / date，记入 "<type>_canonicalization"
```

三条关键细节：

1. **映射只查一次，且不链式。** 命中后得到的值不会再次查表，因此不存在 A→B→C 的连锁映射。
2. **映射发生在 missing 检查之前。** 所以 `missing` 里的标记应当写「转换和映射之后」的形态。例如右侧 `已支付` 映射为 `paid`，若要把它当作缺失标记，应在 `missing` 里写 `paid` 而不是 `已支付`。
3. **原始值、转换后值、规范化值三者都保留。** `fields.csv` 中分别对应 `left_raw`/`right_raw`、`left_transformed`/`right_transformed`、`left_canonical`/`right_canonical`。原始值从不被改写，前导零（`001`）会原样保留。

## 4. 三种类型的语义

### `text`

- 规范化值等于转换后的值。
- 相等判定：两侧规范化值相同。若原始字符串也相同则为 `equal`（解释 `raw_values_equal`），否则为 `equivalent_by_rule`（解释 `values_equal_after_configured_transforms`）。
- 因此 `001` 与 `1` 在 `text` 下是 `different`，这正是「不猜类型」的体现：需要数值语义时必须显式声明 `decimal`。
- 不允许使用任何非默认容差：`abs_tol`、`rel_tol` 必须为 `"0"`，`days_tol` 必须为 `0`。

### `decimal`

- 用 BigInt 系数加标度表示，解析规则：可选正负号、至少一位整数位、可选的 `.` 加至少一位小数位；有效位数上限 64，标度上限 18。**不接受**科学计数法、空格、千分位、货币符号。前导 `+` 与 `-0` 会被规范化。
- 规范化后去掉尾部零：`100.00` → `100`。
- 差异 `difference` 是**左侧减右侧**的有符号十进制字符串。
- 阈值 `threshold = max(abs_tol, rel_tol × max(|左|, |右|))`。
- 当 `|difference| ≤ threshold` 时为 `equivalent_by_rule`（解释 `decimal_difference_within_tolerance`），阈内且原始字符串完全相同则为 `equal`；否则 `different`（解释 `decimal_difference_exceeds_tolerance`）。
- 任一侧解析失败 → `invalid_value`（解释 `value_does_not_match_declared_type`）。
- 举例：`abs_tol = "0.02"` 时，`100.00` 与 `100.01` 的差异为 `-0.01`，阈值为 `0.02`，判定等价；`10` 与 `11` 的差异为 `-1`，判定不同。
- 不允许使用 `days_tol`（必须为 `0`）。

### `date`

- 只接受严格 `YYYY-MM-DD`：长度恰好 10，第 5 与第 8 个字符必须是 `-`，其余必须是数字，月份 1–12，日必须在该月实际天数内（含闰年规则：能被 4 整除，且不被 100 整除或能被 400 整除）。
- 输入按字符形状原样成为规范化值，内部另算格里高利日序号用于求差。
- 差异 `difference` 是**左侧减右侧的天数**（整数字符串）；阈值 `threshold` 等于 `days_tol`。
- 当 `|difference| ≤ days_tol` 时为等价（解释 `date_difference_within_day_tolerance`）；否则 `different`。
- 举例：`days_tol` 为默认 `0` 时，`2026-09-02` 与 `2026-09-03` 的差异为 `-1`，判定不同。
- 不允许使用 `abs_tol`/`rel_tol`（必须为 `"0"`）。

### 缺失与无效的优先级

[`rules.mbt`](../rules.mbt) 的 `compare_field` 判定顺序为：

| 条件 | `status` | `explanation` |
| --- | --- | --- |
| 任一侧类型解析失败 | `invalid_value` | `value_does_not_match_declared_type` |
| 两侧都是缺失标记，且 `both_missing = "issue"` | `different` | `both_missing_requires_review` |
| 两侧都是缺失标记，`both_missing = "equal"`，原始字符串相同 | `equal` | `both_values_missing` |
| 两侧都是缺失标记，`both_missing = "equal"`，原始字符串不同 | `equivalent_by_rule` | `both_values_missing_by_policy` |
| 只有一侧是缺失标记 | `different` | `one_value_missing` |
| 以上都不是，进入类型规则 | 见上 | 见上 |

注意「无效」优先于「缺失」：若左侧解析失败、右侧是缺失标记，结果是 `invalid_value` 而不是「一侧缺失」。空白文本本身不是缺失，除非它被显式写进 `missing`；缺失/无效值在候选中恒得 0 分。

## 5. `key`

- 默认空数组。空 `key` 时不做精确配对，全部记录保持待复核，并产生一条 `no_key_configured` 诊断（信息性；单独出现且无其它问题时进程仍退出 0）。
- 每一项必须是一个已映射的字段名，否则拒绝（`key references an unknown field: <name>`）。
- 键值按字段声明顺序编码为 **JSON 数组字符串**，绝不用分隔符拼接，因此不存在分隔符碰撞。
- 一个记录只有在它的每个键分量都**有效、非缺失、且（文本类型时）非空**时才有可用键。文本键为空串即使在 `missing` 未声明时也不可用 —— 这会产生 `invalid_or_missing_key` 诊断，记录保留待复核。
- 只有当左右两侧的键**各自唯一**时才配对。任一侧出现重复键，则该键对应的记录全部不配对，并产生 `duplicate_key` 诊断，不做「首行优先」匹配。

## 6. `ignore_left` / `ignore_right`

- 用原始列名声明「已经知晓、但明确不参与对账」的列。
- 被忽略的列不得同时出现在任何字段的 `left`/`right` 映射里，否则拒绝（`ignored left column is also mapped`）。
- 已忽略但表中不存在的列会产生 `missing_ignored_column` 诊断；这会**中止比较**并返回错误（见第 8 节退出码）。
- 既未映射也未忽略的列会产生 `unmapped_column` 诊断，并使退出码为 1。

## 7. `candidates` 候选配置

```json
"candidates": {
  "fields": [{"field": "name", "metric": "edit", "weight": 1}],
  "threshold": 8000,
  "blocking": [["brand"]]
}
```

| 键 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `fields` | 对象数组 | **必需** | 非空。每一项是 `{field, metric, weight}`，三个键都必填 |
| `fields[].field` | 字符串 | **必需** | 必须引用一个已映射的逻辑字段名 |
| `fields[].metric` | 字符串 | **必需** | `exact` / `edit` / `decimal` / `date`，且必须与所引用字段的 `type` 匹配 |
| `fields[].weight` | 整数 | **必需** | 1 到 10000 |
| `threshold` | 整数 | **必需** | 1 到 10000。候选得分达到该值才进入分配阶段 |
| `blocking` | 数组的数组 | 可选 | 字段名列表的 OR-of-AND；省略时规范化为 `[]` |

metric 与字段类型的匹配要求：

| metric | 允许的字段 `type` | 取值 |
| --- | --- | --- |
| `exact` | `text` | 规范化值相同得 10000，否则 0 |
| `edit` | `text` | 码点级 Levenshtein 相似度，`(maxlen - 距离) × 10000 / maxlen` |
| `decimal` | `decimal` | 字段自身容差内得 10000，否则 0 |
| `date` | `date` | 字段自身 `days_tol` 内得 10000，否则 0 |

- 候选总分 = `Σ(weight × score) / Σ(weight)`，权重构成固定分母，取整数部分。
- 任一侧的类型解析失败会使该字段分为 `null`，整个候选的 `score` 也为 `null`（不是 0）。
- 同一逻辑字段不能在 `fields` 里出现两次。
- `blocking` 的语义是「字段名列表的 OR-of-AND」：外层数组之间取并集，内层数组内所有字段必须同时相等才算分到同一块。省略或空外层数组表示 all-pairs（全部左右组合）。内层空数组会被拒绝。
- 分块只减少候选对的数量，不是身份证明；分块可以把真实对应排除在外。
- `blocking` 中引用的字段值若无效、缺失或转换后为空，该记录不会参与该分块，会产生 `candidate_blocking_uncovered` 诊断并保持待复核。
- **候选分数不是概率，也不是置信度。** 得分高只表示按配置的度量相似，一对一「建议」仍需人工接受。

## 8. 会被拒绝的配置

以下全部由 [`config.mbt`](../config.mbt) 拒绝，错误码统一为 `invalid_config`，`phase` 为 `configuration`。括号内是实测的 `message`。

**结构类**

| 触发条件 | 信息 |
| --- | --- |
| 顶层不是 JSON 对象 | `config must be a JSON object` |
| `schema_version` 缺失或非整数 | `schema_version must be an integer` |
| `schema_version` 不等于 1 | `schema_version must equal 1` |
| `draft` 为 `true` | `draft config must be edited before checking` |
| `draft` 不是布尔 | `draft must be a boolean` |
| `fields` 缺失或不是数组 | `fields must be an array` |
| `fields` 为空数组 | `at least one field mapping is required` |
| `fields` 的某项不是对象 | `each fields entry must be an object` |
| 出现未声明的顶层键 | `unknown property '<key>' in config` |

**字段类**

| 触发条件 | 信息 |
| --- | --- |
| 字段对象出现未声明的键 | `unknown property '<key>' in field` |
| `name` 缺失或全为空白 | `field name must be a nonblank string` |
| `left` 缺失或为空串 | `left source column must be a nonempty string` |
| `right` 缺失或为空串 | `right source column must be a nonempty string` |
| `type` 缺失、为 `null` 或不在三者之内 | `field type must be text, decimal, or date` |
| 逻辑字段名重复 | `duplicate logical field name: <name>` |
| 同一个左侧来源列被映射两次 | `left source column is mapped more than once: <column>` |
| 同一个右侧来源列被映射两次 | `right source column is mapped more than once: <column>` |
| `compare` / `trim_ascii` / `lower_ascii` 不是布尔 | `compare must be a boolean` 等 |
| `left_values` / `right_values` 不是对象 | `<name> must be an object of string values` |
| 映射表的值不是字符串 | `<name> values must be strings` |
| `missing` 不是数组，或含非字符串 | `missing must be an array of strings` / `missing must contain only strings` |
| `both_missing` 不是 `equal` 或 `issue` | `both_missing must be equal or issue` |
| `both_missing` 不是字符串 | `both_missing must be a string` |
| `abs_tol` / `rel_tol` 不是字符串 | `abs_tol must be a string` |
| `abs_tol` / `rel_tol` 不是非负十进制（含负数、科学计数法、`"."`） | `abs_tol must be a nonnegative decimal string` |
| `days_tol` 不是整数或在 `0..2147483647` 之外 | `days_tol must be an integer` / `days_tol is outside the supported integer range` |
| **与类型无关的容差被设为非默认值**（`text` 用了 `abs_tol`/`rel_tol`/`days_tol`；`date` 用了 `abs_tol`/`rel_tol`；`decimal` 用了 `days_tol`） | `field type cannot use a nondefault irrelevant tolerance` |

最后一条是刻意的：与其静默忽略一个不生效的选项，不如直接拒绝，以免用户误以为它起了作用。

**`key` 与忽略列类**

| 触发条件 | 信息 |
| --- | --- |
| `key` 不是字符串数组 | `key must be an array of strings` |
| `key` 引用了未知字段 | `key references an unknown field: <name>` |
| `ignore_left` / `ignore_right` 不是字符串数组 | `<name> must be an array of strings` |
| 被忽略的左侧列同时被映射 | `ignored left column is also mapped: <column>` |
| 被忽略的右侧列同时被映射 | `ignored right column is also mapped: <column>` |

**候选类**

| 触发条件 | 信息 |
| --- | --- |
| `candidates` 既不是 `null` 也不是对象 | `candidates must be null or an object` |
| `candidates` 出现未声明的键 | `unknown property '<key>' in candidates` |
| `candidates.fields` 缺失、不是数组或为空 | `candidate fields must be a nonempty array` |
| `candidate fields` 的某项不是对象 | `candidate field entries must be objects` |
| 候选项出现未声明的键 | `unknown property '<key>' in candidate field` |
| `field` 缺失或引用了未映射的字段 | `candidate field must reference a mapped field` |
| `metric` 缺失或不是字符串 | `candidate metric must be a string` |
| `metric` 不在四种之内 | `unknown candidate metric: <metric>` |
| `metric` 与字段类型不匹配（`exact`/`edit` 用于非 `text`；`decimal` 用于非 `decimal`；`date` 用于非 `date`） | `exact and edit metrics require text fields` / `decimal metric requires a decimal field` / `date metric requires a date field` |
| `weight` 缺失、非整数或不在 `1..10000` | `candidate weight must be between 1 and 10000` |
| 同一字段在候选配置中重复出现 | `candidate field is repeated: <name>` |
| `threshold` 缺失、非整数或不在 `1..10000` | `candidate threshold must be between 1 and 10000` |
| `blocking` 不是数组 | `blocking must be an array` |
| `blocking` 的内层为空数组或含非字符串 | `blocking must contain nonempty arrays of field names` |
| `blocking` 引用了未映射的字段 | `blocking fields must reference mapped field names` |

**运行期（不是配置拒绝，但同属「不猜」的后果）**

| 触发条件 | 结果 |
| --- | --- |
| 已声明的来源列在表中不存在 | 报 `missing_mandatory_column`，`phase: configuration`，退出 2，不产出 run |
| 已忽略的列在表中不存在 | 报 `missing_ignored_column`，退出 2，不产出 run |
| `key` 为空 | 产生 `no_key_configured` 诊断；全部记录待复核 |
| 存在既未映射也未忽略的列 | 产生 `unmapped_column` 诊断；退出码 1 |

实测示例（错误码与信息均为真实输出）：

```
$ node cli/main.mjs compare examples/orders/left.csv examples/orders/right.csv \
      --config bad.json --out /tmp/x
{"ok":false,"error":{"code":"missing_mandatory_column",
 "message":"configured source column is absent: 'nonexistent' on right",
 "phase":"configuration","side":"right","record":null,"field":"nonexistent"}}
```

## 9. 完整可用示例

下面是仓库中实际可运行的 [`examples/orders/rules.json`](../examples/orders/rules.json) 的原始内容（单行）：

```json
{"schema_version":1,"fields":[{"name":"order_id","left":"order_id","right":"external_ref","type":"text","compare":false},{"name":"status","left":"status","right":"state","type":"text","right_values":{"已支付":"paid"}},{"name":"amount","left":"amount","right":"total","type":"decimal","abs_tol":"0.02"},{"name":"day","left":"day","right":"settled_on","type":"date"}],"key":["order_id"]}
```

等价的可读形式，并附上省略时实际生效的默认值：

```json
{
  "schema_version": 1,
  "fields": [
    {
      "name": "order_id",
      "left": "order_id",
      "right": "external_ref",
      "type": "text",
      "compare": false
    },
    {
      "name": "status",
      "left": "status",
      "right": "state",
      "type": "text",
      "right_values": { "已支付": "paid" }
    },
    {
      "name": "amount",
      "left": "amount",
      "right": "total",
      "type": "decimal",
      "abs_tol": "0.02"
    },
    {
      "name": "day",
      "left": "day",
      "right": "settled_on",
      "type": "date"
    }
  ],
  "key": ["order_id"],
  "ignore_left": [],
  "ignore_right": [],
  "candidates": null
}
```

这份配置的读法：

- `order_id` 是身份字段，`compare:false`，因此只用于按 `order_id`/`external_ref` 配对，不产生字段比较行；它同时是唯一的键。
- `status` 只声明了右侧映射 `已支付` → `paid`；左侧没有映射（左右索引不对称是允许的，这里左侧不需要转换）。
- `amount` 是十进制，绝对容差 `0.02`。
- `day` 是日期，未写 `days_tol`，取默认 `0`，即要求天数完全一致。
- 没有 `candidates`，因此不做候选评分；剩余记录全部待人工复核。

`check-config` 会把它规范化后原样回显（键按字典序、补全默认值）：

```sh
node cli/main.mjs check-config examples/orders/rules.json
```

规范化输出中 `draft` 为 `false`，`candidates` 为 `null`，每个字段都补齐了 `abs_tol`、`rel_tol`、`both_missing`、`days_tol`、`left_values`、`lower_ascii`、`missing`、`right_values`、`trim_ascii` 等默认值。若 `candidates` 是对象，规范化时还会补上 `"blocking": []`。

## 10. 未实现 / 未验证

- **没有 XLSX 入口**，目前只接受 UTF-8 CSV。是否需要 XLSX 尚未验证。
- **没有类型自动推断、货币识别、日期格式推断、主键推断或 Unicode 规范化**，这是设计边界而非疏漏，将来也不打算隐式加入。
- **没有拆单/合单**：多笔付款对一张订单、一行对多行的场景不处理。
- **没有远程数据源、数据库连接、多人协作、公式重算或任意时区**支持；日期不含时间与时区概念。
- 固定预算是引擎常量，**CLI 不提供**用户可调的预算覆盖开关。
- 本文的示例数据全部为**合成**数据，不对应任何真实业务；文中不提供准确率或性能数字。
