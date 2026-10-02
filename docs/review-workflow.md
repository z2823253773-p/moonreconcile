# 人工复核流程

创建日期：2026-09-30

状态：**首版复核合同。** 命令和输出对应当前源码；限制及外部验证缺口列在最后一节。CLI 运行时需要 Node.js，不需要 Python。

相关文档：[架构说明](architecture.md)、[配置参考](configuration.md)、[实施计划](plans/2026-09-30-table-reconcile.md)。

复核的核心思想：**程序只给出建议和差异，绝不替人做决定**。所有身份确认都由人写进 `decisions.csv`，引擎整批校验后原子应用。

## 1. 四条命令

`node cli/main.mjs` 不带参数会打印用法（实测输出，逐字抄录）：

```
usage:
  reconcile init-config LEFT RIGHT --out CONFIG
  reconcile check-config CONFIG
  reconcile compare LEFT RIGHT --config CONFIG --out RUN
  reconcile resolve RUN --decisions CSV --out REVIEWED
```

以 `node cli/main.mjs` 调用时，把上面的 `reconcile` 换成 `node cli/main.mjs` 即可：

| 命令 | 实际调用 | 作用 |
| --- | --- | --- |
| `init-config` | `node cli/main.mjs init-config LEFT RIGHT --out CONFIG` | 由左右 CSV 的表头生成**草稿**配置模板；不推断类型、主键或转换 |
| `check-config` | `node cli/main.mjs check-config CONFIG` | 校验配置并把规范化结果打印到 stdout；不写文件 |
| `compare` | `node cli/main.mjs compare LEFT RIGHT --config CONFIG --out RUN` | 执行对账，产出 run 目录 |
| `resolve` | `node cli/main.mjs resolve RUN --decisions CSV --out REVIEWED` | 读回人工决定，重新计算并产出新的 run 目录 |

参数规则（[`parseArguments`](../cli/main.mjs)）：

- 命令必须在白名单内，否则报 `unknown command '<cmd>'` 并附用法。
- 每个命令的操作数个数固定（`init-config`/`compare` 两个，`check-config`/`resolve` 一个），多给少给都报错。
- 选项必须在白名单内（`--out`、`--config`、`--decisions`），未知选项报 `unknown option <opt> for '<cmd>'`。
- 同一个选项不能重复出现；选项后面必须紧跟值，且值不能以 `--` 开头。
- 必需的选项一个都不能少（漏掉报 `missing required option --out`）。
- **没有 `--help`、`-h` 或 `--version`**，也没有短选项。

## 2. run 目录与 decisions.csv 模板

`compare` 产出的 run 目录包含 11 个文件（详见[架构说明](architecture.md)）。复核直接相关的是：

| 文件 | 复核中的用途 |
| --- | --- |
| `input/left.csv`、`input/right.csv` | 不可变的原始输入快照 |
| `config.json` | 规范化后的配置，本次运行实际生效的规则 |
| `decisions.csv` | **待编辑的决定表模板** |
| `report.json` | 完整结果，含 `records`、`pairs`、`fields`、`candidates`、`decisions`、`key_issues` |
| `candidates.csv` | 候选与建议，`suggested` 列标出被选中者 |
| `unresolved.csv` | 只列 `pending_review` 与 `unprocessed` 的记录 |
| `summary.md` | 人读摘要 |
| `manifest.json` | 快照指纹，`resolve` 校验用（不要手改） |

### 模板格式

`decisions.csv` 的表头**必须恰好**是：

```
action,left_id,right_id,reason
```

[`renderDecisionsCsv`](../cli/render.mjs) 按以下规则生成模板，它是一张**累计**决定表：

1. 先输出该 run 已经应用过的决定（首次 `compare` 时为空）。
2. 再为每个 `suggested: true` 的候选输出一行，`action` 与 `reason` 留空，左右 ID 已填好 —— **模板绝不预填 `accept`**，建议只是一个待填写的机会。
3. 最后为每个 `pending_review` 或 `unprocessed` 记录输出一行，只在对应侧填 ID，另一侧留空。

同一行内容去重；已经被某条决定处置过的记录不会再次出现。

实测 `examples/orders`（无候选，3 条左、2 条右，两条精确配对，L3 待复核）：

```csv
action,left_id,right_id,reason
,L3,,
```

实测 `examples/catalog`（有候选，L1/R2 得分 10000 被建议，L1/R1 得分 8000 为竞争候选）：

```csv
action,left_id,right_id,reason
,L1,R2,
,L1,,
,,R1,
,,R2,
```

### 空 action 的含义

`action` 为空的行会被**跳过**，表示「这一项还没复核」。因此一张原封不动复制回来的模板等于「没有任何决定」，重放结果与不传决定一致。

### ID 形式

- 左侧是 `L` 加正整数字面量，右侧是 `R` 加正整数字面量，编号对应数据逻辑记录序号（从 1 开始，与 `report.json` 的 `records` 一致）。
- 必须用**规范**十进制：`L1` 合法，`L01`、`L+1`、`L 1`、`L`、`L1.0` 都被拒绝（`record ID must use canonical positive decimal notation` 或 `must contain a positive canonical integer`）。
- 前缀必须与侧别一致：在 `left_id` 位置写 `R1` 会报 `record ID must use the LN form`。
- 引用不存在的记录（例如只有 3 条左记录却写 `L9`）报 `decision has an invalid action shape or references a nonexistent record`。

## 3. 四种 action

校验逻辑在 [`decisions.mbt`](../decisions.mbt) 的 `parse_decisions` 与 `apply_decisions`。

| action | `left_id` | `right_id` | `reason` | 含义 |
| --- | --- | --- | --- | --- |
| `accept` | **必需** | **必需** | 候选达标时可空；否则必需 | 人工确认这两条记录对应 |
| `reject` | **必需** | **必需** | 可空 | 明确否决这一对，该对不再作为建议 |
| `left_unmatched` | **必需** | **必须为空** | 可选 | 确认这条左记录确实没有对应 |
| `right_unmatched` | **必须为空** | **必需** | 可选 | 确认这条右记录确实没有对应 |

实测表头或形状错误的报错：

| 输入 | 报错 |
| --- | --- |
| 表头写成 `action,left,right,why` | `invalid_decision_schema`：`decision CSV header must be exactly action,left_id,right_id,reason` |
| `left_unmatched` 同时填了 `right_id` | `left_unmatched requires only left_id` |
| `right_unmatched` 同时填了 `left_id` | `right_unmatched requires only right_id` |
| `accept` 缺一个 ID | `accept requires both left_id and right_id` |
| 未知 action（如 `delete`） | `invalid_decision_action`：`unknown decision action 'delete'` |

`reason` 只在一种情况下强制：**`accept` 一对不在阈值合格候选之内的记录**。此时 `reason` 去除 ASCII 空白后不能为空，否则报 `manual_override_needs_reason`（`accepting a pair without a threshold-qualified score requires a nonblank reason`）。满足条件时该配对的 `override` 记为 `true`，在 `pairs.csv` 的 `override` 列可见。

实测：把 `examples/catalog` 的阈值临时提到 9000（L1/R1 的 8000 分因此不达标），

```
accept,L1,R1,            → manual_override_needs_reason，退出 2
accept,L1,R1,manual decision → 成功，pairs.csv 中 override=true
```

`reject` 不要求 reason（实测空 reason 的 `reject` 正常工作）。

## 4. 冲突规则：整批原子拒绝

引擎**先校验全集，再改变任何状态**。任何一条决定非法，整个批次被拒绝，该次 `resolve` 退出 2 且不产出 run —— 不会出现「部分决定生效」的中间状态。

### 相互矛盾

| 冲突 | 报错信息 |
| --- | --- |
| 同一对既 `accept` 又 `reject` | `the same pair cannot be both accepted and rejected` |
| 两个 `accept` 共用同一个端点 | `accepted pairs cannot share a record endpoint` |
| `accept` 的端点又被 `left_unmatched`/`right_unmatched` | `an accepted endpoint cannot also be confirmed unmatched` |
| 同一 action 与同一对端点却是不同 reason | `the same action and endpoints have different reasons` |

以上错误码统一为 `conflicting_decisions`，`phase` 为 `decisions`，`record` 字段给出**决定 CSV 中数据行的序号**（从 1 开始，不含表头），便于定位。

实测：

```
$ node cli/main.mjs resolve <catalog-run> --decisions conflict.csv --out /tmp/o1
{"ok":false,"error":{"code":"conflicting_decisions",
 "message":"the same pair cannot be both accepted and rejected",
 "phase":"decisions","side":null,"record":2,"field":null}}
```

### 精确键配对被锁定

已经是 `exact_key` 配对的端点**不能被人工决定改动**，包括不能被推翻成 `reject`，也不能被 `left_unmatched`/`right_unmatched` 单独确认无对应：

```
{"ok":false,"error":{"code":"locked_exact_pair",
 "message":"exact-key paired endpoints cannot be changed by review decisions",
 "phase":"decisions","side":null,"record":1,"field":null}}
```

这条约束意味着：要否定一个精确键配对，当前版本没有 CLI 入口，只能修改配置或输入。这是设计上的取舍 —— 精确唯一键的对应被视为事实，人工复核只处理剩余的模糊部分。

### 完全重复的行是幂等的

两行完全相同的决定（action、两个 ID、reason 都相同）会被去重，只应用一次，不报错。实测：

```csv
action,left_id,right_id,reason
reject,L1,R2,same
reject,L1,R2,same
```

应用后 `report.json` 的 `decisions` 只有一条。

## 5. `resolve` 的快照指纹校验

`resolve` 的输入**只有 RUN 目录和决定 CSV**（外加 `--out`）。它不读取原始左右 CSV，也不读取原始配置文件。取而代之的是对 run 目录做一整套完整性校验，全部在调用引擎**之前**完成（[`commandResolve`](../cli/main.mjs)）：

| 顺序 | 校验 | 失败错误码 |
| --- | --- | --- |
| 1 | `manifest.json` 存在且是 JSON 对象 | `io_error` / `invalid_manifest` |
| 2 | 必需字段齐全：`schema_version`、`run_id`、`engine_version`、左右 `*_sha256`/`*_bytes`、`config_sha256`/`config_bytes`、`provenance` | `invalid_manifest` |
| 3 | 没有未声明的字段（只允许附加 `created`、`parent_run_id`、`decisions_sha256`） | `invalid_manifest` |
| 4 | `schema_version` 恰为 1；`engine_version` 等于宿主支持的版本 | `invalid_manifest` / `unsupported_engine_version` |
| 5 | `run_id`、左右 SHA、配置 SHA 都是小写 64 位十六进制；字节数是非负安全整数 | `invalid_manifest` |
| 6 | `input/left.csv`、`input/right.csv` 的**实际字节数与 SHA-256** 与清单一致 | `fingerprint_mismatch` |
| 7 | `config.json` 的字节数与 SHA-256 与清单一致 | `config_digest_mismatch` |
| 8 | `config.json` 的内容等于规范化配置的规范 JSON 形式 | `invalid_manifest` |
| 9 | 用清单中的四项重算 `run_id`，必须等于清单里的 `run_id` | `run_id_mismatch` |
| 10 | 把 `config.json` 交给引擎后，引擎规范化回来的配置与快照逐字节一致 | `config_digest_mismatch` |

实测：

```
# 篡改 input/left.csv 的字节
{"ok":false,"error":{"code":"fingerprint_mismatch",
 "message":"immutable snapshot input/left.csv does not match the manifest fingerprint",
 "phase":"manifest","side":null,"record":null,"field":null}}

# 把目录指向一个只放了左右 CSV 的普通目录（缺少 manifest.json）
{"ok":false,"error":{"code":"io_error",
 "message":"cannot read <dir>/manifest.json: ENOENT: no such file or directory, open '<dir>/manifest.json'",
 "phase":"manifest", ...}}
```

指纹是**过期材料的识别手段，不是抗恶意篡改的认证**。谁都能同时改快照和清单让它们自洽（第 9 步只能保证 `run_id` 与清单内的哈希自洽）。它保证的是「这份 run 没有被无意改过」。

## 6. 关键：`resolve` 只接受 RUN 目录

这是复核流程可长期使用的根本原因：**run 目录自带左右输入的逐字节快照**，`resolve` 永远从快照重建基线，从不回读原始文件。因此**原始左右 CSV 和原始配置文件被删除或改名后，复核依然可以进行**。

实测（复制 `examples/orders` 到临时目录，跑完 `compare` 后删掉全部原始文件）：

```
# 1) 用临时副本做 compare
$ node cli/main.mjs compare <tmp>/orig/left.csv <tmp>/orig/right.csv \
      --config <tmp>/orig/rules.json --out <tmp>/snap-run
run: <tmp>/snap-run
run_id: cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638
exit: 1

# 2) 删除 left.csv、right.csv、rules.json、reviewed.csv
originals remaining: []

# 3) 仍然可以复核
$ node cli/main.mjs resolve <tmp>/snap-run --decisions <tmp>/from-template.csv --out <tmp>/snap-reviewed
run: <tmp>/snap-reviewed
run_id: cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638
exit: 1
```

注意第 3 步的 `run_id` 与第 1 步完全相同：`run_id` 由快照内容推导，与文件路径无关（推导方式见[架构说明](architecture.md)第 8 节）。`manifest.json` 的 `provenance` 字符串里记录了当时的路径，但那只用于追溯，不参与任何读取。

三点实用建议：

1. `decisions.csv` 可以直接从 run 目录复制出来编辑，也可以直接就地编辑后把路径传给 `--decisions`。**不要把决定表写到 run 目录里**（`--out` 不允许指向或落进源 run，见下）。
2. `--out` 不能是源 run 本身，也不能位于源 run 之内（报 `output_conflict`）。目的是让源快照始终只读。
3. `--out` 指向的目录必须**不存在或为空**，不能是符号链接。重复运行时请换一个新目录或先清空。

### 累计重放

复核产出的 `decisions.csv` 包含了**之前所有已应用的决定**加上本次新填的行。删掉已填的行再重放，结果会不一样。正确做法是把复核产出的 `decisions.csv` 原样喂回去，构成可无限追加的链条：

```sh
# 第一次复核
node cli/main.mjs resolve /tmp/orders-run --decisions examples/orders/reviewed.csv --out /tmp/orders-reviewed
# 把复核产出的累计决定表再喂回同一个基线，得到语义完全一致的结果
node cli/main.mjs resolve /tmp/orders-run --decisions /tmp/orders-reviewed/decisions.csv --out /tmp/orders-replayed
```

实测两次的 `report.json` **逐字节相同**，且第二次的 `run_id` 仍是父 run 的 `run_id`（因为基线相同）。

## 7. 退出码

| 退出码 | 含义 | 是否产出 run 目录 |
| --- | --- | --- |
| `0` | 计算完整（`computation.status = "complete"`），且无任何待处理差异 | 是 |
| `1` | 计算完整，但报告里仍有实质问题（见下） | 是 |
| `2` | **致命错误**：配置/输入/决定非法、文件或磁盘 I/O 失败、清单或指纹校验失败、参数错误 | 否 |
| `3` | 计算**不完整**（预算受限），无论人工覆盖了多少行 | 是 |

优先级是 **2 > 3 > 1 > 0**：退出 2 是「没有结果」的失败，不会产出 run；在有结果的运行里，退出 3 会**覆盖**退出 1。

进入退出码 `1` 的条件（[`exact.mbt`](../exact.mbt) 与 [`decisions.mbt`](../decisions.mbt)）：

- 仍有 `pending_review` 或 `unprocessed` 记录；
- 存在人工确认的无对应记录（`left_unmatched`/`right_unmatched`）—— **人工确认的缺失仍然是业务差异，不会被从报告里抹掉**；
- 任何配对的字段比较出现 `different` 或 `invalid_value`；
- 存在 `duplicate_key` 或 `invalid_or_missing_key` 键异常；
- 存在既未映射也未忽略的列（`unmapped_column`）。

注意两条容易误解的地方：

- **`no_key_configured` 和 `key_not_found` 是信息性诊断，它们本身不阻止退出 0。** 一个没有配置 `key`、左右表完全一致的单行对账会退出 0。
- `summary.key_issue_count` 仍会保留全部键诊断。重复键、无效键或缺失键异常只要没有被明确处理，仍然是实质问题并触发退出 1；只有前述两种信息性诊断不会单独触发退出 1。
- 退出码 `2` 不是引擎算出来的，而是宿主的致命结果。引擎内部在「缺失已声明列」时会给出一个 `exit_code: 2` 的 incomplete 结果，但宿主只读响应的 `ok` 字段，看到 `ok:false` 就直接退出 2，不写 run 目录。

### 人为覆盖不会追认算法完成

这是复核流程中最重要的一条语义：**如果原始候选阶段因为预算限制而不完整，那么即使人工决定覆盖了每一行，`computation.status` 仍然是 `incomplete`，退出码仍然是 3。**

实测（101×101 密集候选，超出「每个连通分量每侧上限 100」的固定预算）：

```
# compare：分量超限，不完整
exit: 3

# resolve：人工逐条 accept 全部 101 对
exit: 3
computation.status = incomplete
exit_code = 3
unresolved_count = 0
pairs = 101
issues = candidate_component_limit_exceeded
```

即 101 对全部配对、待复核记录归零，退出码依然是 3，因为 `summary.md` 的 "Computation coverage" 一节要如实说明算法没跑完。**人工覆盖率不能倒推证明算法完成**，这是刻意的设计，让报告不会因为复核而显得比实际更可靠。

## 8. 完整流程示例：`examples/orders`

数据全部为**合成**，不对应任何真实业务。左右表按 `order_id`/`external_ref` 对应。

`examples/orders/left.csv`：

```csv
order_id,status,amount,day
A,paid,100.00,2026-09-01
B,pending,10,2026-09-02
C,paid,5,2026-09-03
```

`examples/orders/right.csv`：

```csv
external_ref,state,total,settled_on
A,已支付,100.01,2026-09-01
B,paid,11,2026-09-03
```

配置见 [`examples/orders/rules.json`](../examples/orders/rules.json)（内容在[配置参考](configuration.md)第 9 节逐行解释）。

### 第 1 步（可选）：生成草稿配置

```sh
node cli/main.mjs init-config examples/orders/left.csv examples/orders/right.csv --out /tmp/orders-draft.json
```

输出 `config: /tmp/orders-draft.json`，退出 0。草稿里 `draft: true`，每个字段 `type: null`，`key: []`，且只在表头完全同名时给出 `left`/`right` 映射 —— 本例左右列名全部不同，因此所有右侧来源都是 `null`。这份草稿**不能直接用于 `compare`**，必须人工编辑类型、映射和键。

### 第 2 步：校验配置

```sh
node cli/main.mjs check-config examples/orders/rules.json
```

退出 0，把规范化配置打印到 stdout（键按字典序、默认值补齐、`draft` 为 `false`）。它不写任何文件。

### 第 3 步：`compare`

```sh
node cli/main.mjs compare examples/orders/left.csv examples/orders/right.csv \
  --config examples/orders/rules.json --out /tmp/orders-run
```

stdout：

```
run: /tmp/orders-run
run_id: cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638
exit: 1
```

进程退出 1。原因：L3 待复核，且已配对记录的字段里有实质差异。

`/tmp/orders-run/pairs.csv`（精确键配对两条）：

```csv
left_id,right_id,source,reason,override
L1,R1,exact_key,unique_canonical_key,false
L2,R2,exact_key,unique_canonical_key,false
```

`/tmp/orders-run/fields.csv` 的 6 条字段比较（`evidence` 与 `rules` 列此处略）：

| left_id | right_id | field | type | left_raw | right_raw | status | difference | tolerance | explanation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | R1 | status | text | paid | 已支付 | equivalent_by_rule | | | values_equal_after_configured_transforms |
| L1 | R1 | amount | decimal | 100.00 | 100.01 | equivalent_by_rule | -0.01 | 0.02 | decimal_difference_within_tolerance |
| L1 | R1 | day | date | 2026-09-01 | 2026-09-01 | equal | 0 | 0 | raw_values_equal |
| L2 | R2 | status | text | pending | paid | different | | | canonical_values_differ |
| L2 | R2 | amount | decimal | 10 | 11 | different | -1 | 0.02 | decimal_difference_exceeds_tolerance |
| L2 | R2 | day | date | 2026-09-02 | 2026-09-03 | different | -1 | 0 | date_difference_exceeds_day_tolerance |

`unresolved.csv`：

```csv
side,id,record,status,reason
left,L3,3,pending_review,review_required
```

`decisions.csv`（待编辑的模板，注意只有一行且 action 为空）：

```csv
action,left_id,right_id,reason
,L3,,
```

`summary.md` 的关键几节：

```
- computation status: complete
- unresolved records: 1
- candidates: 0
- exit code: 1

## Record accounting

| side | total | paired | unmatched | pending_review | unprocessed |
| --- | --- | --- | --- | --- | --- |
| left | 3 | 2 | 0 | 1 | 0 |
| right | 2 | 2 | 0 | 0 | 0 |

## Field comparison

| status | count |
| --- | --- |
| equal | 1 |
| equivalent_by_rule | 2 |
| different | 3 |
| invalid_value | 0 |
```

### 第 4 步：填写决定

`examples/orders/reviewed.csv` 的内容：

```csv
action,left_id,right_id,reason
left_unmatched,L3,,source-system audit confirms missing sync
```

即：确认 L3 这条左记录确实没有对应。字段差异（L2/R2 的 status、amount、day）**不通过决定表处理** —— 决定只改变记录层的对应关系，字段差异始终如实保留在报告里。

### 第 5 步：`resolve`

```sh
node cli/main.mjs resolve /tmp/orders-run --decisions examples/orders/reviewed.csv --out /tmp/orders-reviewed
```

stdout：

```
run: /tmp/orders-reviewed
run_id: cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638
exit: 1
```

`run_id` 与第 3 步相同（基线快照相同）；区别体现在清单新增的两个字段：

```json
"parent_run_id": "cf7e91fa29eb995c333d467227231a134bd299d2a3521c4688bf0ac0471f9638",
"decisions_sha256": "b79c118a83d2302f0f99e20a7208f56e46ce093560d8960965e801b9bbbb11af",
"provenance": "resolve /tmp/orders-run with decisions <decisions 路径>"
```

复核后的 `decisions.csv` 保留了已应用的决定：

```csv
action,left_id,right_id,reason
left_unmatched,L3,,source-system audit confirms missing sync
```

复核后的 `unresolved.csv` 只剩表头（没有待复核记录了）。退出码仍是 1，因为 L3 被人工确认为缺失 —— 这是业务差异，不因被确认而消失，`summary.md` 明确写着「Human confirmed unmatched records remain business differences and are not removed from this report.」

### 第 6 步：重放验证

```sh
node cli/main.mjs resolve /tmp/orders-run --decisions /tmp/orders-reviewed/decisions.csv --out /tmp/orders-replayed
```

产出与第 5 步**语义完全一致**（实测两次 `report.json` 逐字节相同）。这正是复核链条可以无限追加的原因：把上一轮的累计决定表原样传下去，结果稳定。

### 有候选的流程：`examples/catalog`

`examples/catalog` 演示了候选与建议如何被人工推翻。左右供应商 ID 不同且不参与评分；`brand` 做分块；`name` 的编辑相似度阈值 8000。`compare` 产出两个候选：

| left_id | right_id | score | suggested |
| --- | --- | --- | --- |
| L1 | R1 | 8000 | false |
| L1 | R2 | 10000 | true |

唯一被建议的是得分更高的 L1/R2（名称完全相同），但它是**错的**。人工决定表 [`examples/catalog/reviewed.csv`](../examples/catalog/reviewed.csv)：

```csv
action,left_id,right_id,reason
reject,L1,R2,synthetic truth says this same-name decoy is a different product
accept,L1,R1,synthetic truth confirms the near-name catalog match
right_unmatched,,R2,synthetic truth marks the decoy unmatched
```

复核结果：唯一配对 `L1,R1`（`source: human_review`），右侧 R2 确认为无对应，一个字段比较为 `different`，退出 1。这个例子刻意说明：**高分数与唯一的分配结果都不是身份证明**，建议必须由人接受或否决。

## 9. 常见错误速查

| 现象 | 错误码 | 退出 |
| --- | --- | --- |
| 决定表表头写错 | `invalid_decision_schema` | 2 |
| 未知 action | `invalid_decision_action` | 2 |
| ID 形式不合法或非规范写法 | `invalid_decision` | 2 |
| 引用了不存在的记录 | `invalid_decision` | 2 |
| 同一对既接受又拒绝 | `conflicting_decisions` | 2 |
| 两条接受共用端点 | `conflicting_decisions` | 2 |
| 同一 action/端点的 reason 不一致 | `conflicting_decisions` | 2 |
| 试图改动精确键配对端点 | `locked_exact_pair` | 2 |
| 候选外接受但 reason 为空 | `manual_override_needs_reason` | 2 |
| 快照字节与清单不符 | `fingerprint_mismatch` | 2 |
| 配置快照与清单不符 | `config_digest_mismatch` | 2 |
| 清单 `run_id` 与重算不符 | `run_id_mismatch` | 2 |
| 清单结构或字段非法 | `invalid_manifest` | 2 |
| 引擎版本与宿主不一致 | `unsupported_engine_version` | 2 |
| `--out` 已存在、非空、是符号链接、或落进源 run | `output_conflict` | 2 |
| 参数错误 | `invalid_arguments` | 2 |

## 10. 未实现 / 未验证

- **没有局部回退**：一次 `resolve` 要么整批生效，要么整批拒绝。不支持「部分应用」或「跳过坏行继续」。
- **无法推翻精确键配对**：`locked_exact_pair` 没有配置层的绕过开关。
- **没有交互式复核界面**：复核全靠手工编辑 CSV；没有 diff 视图、批量操作或校验器。
- **没有多人并发或锁**：两个 `resolve` 同时写同一个 `--out` 靠目录事务保证不会写出半成品，但没有协调机制。
- **`resolve` 不能直接读原始 CSV**：这是设计约束而非缺陷，但意味着没有 `compare` 产出的 run 目录就无法复核。
- 本文的退出码表与错误码表覆盖了源码中出现的分支和实测案例，**但没有穷举所有宿主 I/O 失败路径**（例如写盘过程中断、磁盘写满的具体表现）；这些分支未逐一实测。
- 三个示例的数据全部为**合成**；本文不声称任何真实用户、准确率或性能数据。
