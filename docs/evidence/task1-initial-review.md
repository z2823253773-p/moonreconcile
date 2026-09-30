# Task 1 independent spec and quality review

日期：2026-09-30。审查者：用户指定的 GPT-6-Astra 质量/验收审查者。

审查提交：`b4be7965ee58a93c7e8b98dad05545ed667b6c0b`（开始审查时工作树干净）。范围仅为 Task 1，依据 `docs/spec.md`、实施计划的 Global Constraints、JSON protocol v1 与 Task 1、任务 brief/report/review.diff，并核对实际源码。未修改产品代码；仅新增本报告。没有检查或宣称远端 CI、真实用户、性能规模或赛事验收结果。公开推送信息由控制者报告，本审查未重新验证远端。

**Spec verdict: NEEDS CHANGES。** 桥接和基本语法路径成立，但严格配置、输入预算契约存在可复现违例；必需的 NyaCSV 对照探针未完成。

**Quality verdict: NEEDS CHANGES。** 状态机和纯 MoonBit / Node 边界清晰，可作为修复基础；现有测试无法阻止静默配置改变和预算失守，不应将其作为通过 Task 1 的充分证据。

`compare` / `resolve` 返回 `unsupported_operation` 符合本任务阶段约定，不是本次缺陷。Task 2–8 的字段运算、候选分配、决策、CLI、报告等未实现，不作为 Task 1 不通过的理由。

## Critical

无已证实 Critical 问题。未执行可能使宿主耗尽内存的超大输入压力测试。

## Important

### I1. CSV 完全缺少已锁定的输入预算校验

位置：`csv.mbt:8–26,176–222`，特别是 `input.to_array()`、无条件 `rows.push` 与最终 `Ok`。依据：spec §4、§6.4；计划 Global Constraints 及 protocol 的固定引擎预算。

通过公开 `invoke` 的 `init_config` 路径，以下输入均返回 `ok:true`：

- 257 个不同表头，超过 256 列；
- `id\n` + `1\n` 重复 100001 次，超过 100000 条数据逻辑记录；
- `id\n` + `x` 重复 65537 次 + 换行，超过单元格 65536 个原始 UTF-8 字节。

预算不是后续候选计算的功能；Task 1 当前就解析并分配这些输入。超限应返回结构化输入错误而非成功，且应在继续扩张对应数组前检查。源码同样没有 64 MiB 文件/文本预算检查；此项为静态检查结论，没有进行 >64 MiB 分配试验。宿主将来做原始文件字节检查，不能代替可复用核心对行/列/单元格的保护。UTF-8 字节数应按字节而非字符计数。

### I2. 已提供但类型错误的配置被当作“未提供”并静默默认

位置：`config.mbt:16–20,304–335`。

`json_string` 将缺失和非字符串都转换为 `None`，随后 `None` 分支默认。实测 `abs_tol:4` → `"0"`、`rel_tol:true` → `"0"`、`both_missing:null` → `"equal"`，全部 `ok:true`。数组/对象等非字符串也存在同一路径。

这违反 protocol 的“reject ... malformed settings”，并改变用户声明的规则。应只在字段真正缺失时默认，存在但类型错误一律 `invalid_config`。这是配置验证问题，不需要等 Task 2 运算实现。

### I3. 类型无关的非默认容差全部被接受

位置：`config.mbt:314–343,377–392`。

实测以下配置均 `ok:true`：文本字段 `abs_tol:"1"` 或 `days_tol:3`；日期字段 `abs_tol:"1"`；十进制字段 `days_tol:1`。计划 `docs/plans/2026-09-30-table-reconcile.md:90` 明确要求文本的全部容差、日期的十进制容差、十进制的天数容差只能为默认值，非默认项必须拒绝。否则 `check_config` 会确认一种后续引擎不应执行的规则。

### I4. 整数转换静默饱和，规范化输出改变日期容差

位置：`config.mbt:124–135`，调用处 `336–343`。

日期字段 `days_tol:2147483648` 和 `days_tol:4294967296` 均通过，规范化为 `2147483647`。当前工具链的 `number.to_int()` 是饱和转换；这里只比较 floor 和转换后的非负性，没有转换前的可表示范围检查。应在转换前拒绝超出支持范围的数值，不能返回另一个整数。

特别区分：本次也测试了超大 `schema_version` 和 candidate weight/threshold；它们在现有后续范围检查中被拒绝，没有复现绕过为 1 的整数回绕。缺陷是日期容差静默改变，不是声称所有整数边界失效。

### I5. 合法的 identity-only 字段被错误禁止使用显式值映射

位置：`config.mbt:365–373`。

例如字段 `{name:"id",left:"id",right:"id",type:"text",compare:false,left_values:{A:"B"}}`，配合 `key:["id"]`，返回 `identity-only fields cannot declare content value maps`。

计划 protocol 明确允许 `compare:false`，且转换顺序与键规则都允许按声明的值映射得到规范化身份；spec §5.1/§6.1 没有“映射只能用于内容比较”的限制。左右系统以不同状态/标识别名参与匹配是有效配置。这个额外限制阻断该能力。应允许该配置，确保之后身份处理也使用同一显式转换链；不要为了绕过校验而要求用户打开不需要的内容比较。

### I6. 十进制容差校验没有执行声明的位数/小数位边界

位置：`config.mbt:105–120,314–335`。

在十进制字段中，`abs_tol:"111...111"`（65 位）及 `rel_tol:"0.1111111111111111111"`（19 位小数）均 `ok:true`。Global Constraints / spec §5.2 规定十进制输入最多 64 位数字、18 位小数；当前函数只做字符和小数点位置校验。

这是输入配置数值的契约，和后续“中间运算不截断、可超过输入位数”的要求不同。应复用受限输入十进制解析契约并给出结构化配置错误，同时保留将来中间计算的无限精确扩展。不要在后续执行时才发现已通过 `check_config` 的容差不可用。

### I7. Task 1 的 NyaCSV 依赖探针验收项仍未完成

位置：`docs/dependency-audit.md:62–76`；计划 `docs/plans/2026-09-30-table-reconcile.md:117`。

审计文档坦诚写明没有包版本、源码、逐项输入行为证据，仅报告 `moon add nyacsv` 未取得依赖。它能证明“未验证并选用了自写解析器”，不能证明要求的“先实际评估再固定依赖/替代方案”已经完成。

这是证据门槛缺口，不是 NyaCSV 不合适的结论，也不是要求立即替换现有状态机。补齐可重现的精确包身份/版本、命令和指定输入探针；若协调者决定接受明确的计划豁免，应记录其依据并保持该项未验证，不把失败下载当作行为评估完成。本审查没有重试下载，也没有验证历史网络失败原因。

## Minor

### M1. Node 的“preserves leading zeros”断言并未观察前导零

位置：`tests/bridge.test.mjs:94–112`，特别是 105–112。

该用例只断言返回字段名是 `code`；`init_config` 根本不返回数据行。即使 parser 把 `001` 错误转为 `1`，这个 Node 用例也会通过。MoonBit 的 `csv_wbtest.mbt:2–8` 确实直接断言 `table.rows[0][0] == "001"`，所以不能说项目完全没有前导零覆盖。建议改正 Node 用例名称/注释，不必为了此测试扩大产品 API。

### M2. 可精确定位的 CSV 语法错误缺少字段位置

位置：`csv.mbt:83–91,140–148,158–166`。

例如 `id,note\n1,bad"quote\n` 返回 `invalid_csv`、left、record 2，但 `field:null`。解析器已经知道当前列索引，spec §4 要求输入错误定位到文件、逻辑记录和字段。可在已知表头时返回字段名，否则返回列标识。对于文件级错误 field 为 null 合理。

另外当前错误 record 将表头算作逻辑记录 1，白盒测试固定了这种语义；计划未来数据 ID 的编号不含表头。两者应明确写出区别并测试含换行字段后的错误，不应让未来 L/R 记录引用直接误用当前错误编号。本次不把这种诊断编号差异直接判定为已实现记录 ID 错误。

### M3. 候选配置默认值没有规范化

位置：`config.mbt:591–592,643–676`。

`candidates` 允许省略 `blocking`，但 normalize 直接回传原对象。因此省略 blocking 和显式 `blocking:[]` 的同义配置规范化结果不同。当前还没有报告指纹功能，不声称已导致实际指纹错误；但该行为与“canonical normalized defaults”目标不一致。建议明确默认为 all-pairs 时输出 `blocking:[]`，并补充规范化幂等性/默认值等价测试。

## 实际验证与测试覆盖意义

在被审 HEAD 上重新执行：

| 命令 | 本次结果 | 能证明的范围 |
| --- | --- | --- |
| `moon check --target js` | exit 0，无诊断 | 当前 JS 目标类型/编译检查 |
| `moon test --target js` | exit 0，11 passed / 0 failed | 5 个 CSV 白盒与 6 个配置/草稿白盒测试 |
| `npm test` | exit 0，6 passed / 0 failed | JS 产物可构建并由 Node 导入；几个公开协议路径 |
| `node tests/js_api_probe.mjs` | exit 0 | `invoke_bridge` 实际 String → String 导出成立 |
| `git diff --check` | exit 0 | 检查时没有 diff 空白错误；不是业务验收 |

11 个 MoonBit 用例覆盖：引号 LF 换行单记录且保留 `001`；CRLF 记录分隔及尾空字段；未引用字段中非法引号；重复/空表头；简单行宽错误编号；左来源重复映射；顶层/字段未知属性；draft 拒绝；不猜类型/键的草稿；部分默认值规范化。测试均有实际断言，不是空测试。

6 个 Node 用例包含重复覆盖及导出边界验证。`no request may crash the host process` 实际只测试 7 个很短的输入，不证明任意请求不会崩溃；本次未声称已经复现进程崩溃。它没有覆盖大输入、嵌套/巨大 JSON 的资源边界。

本次额外探针确认：错误 closing quote、未闭合 quote 被拒绝；双引号转义和 quoted CRLF 输入被接受；单列空白数据记录被接受而两列空白记录被拒绝；初始 BOM 被识别；未知 candidate-field 属性被拒绝。公开 init 路径的成功只能验证“接受该输入”，不能直接证明返回未暴露的数据值原样保留。需要在白盒层补充分隔、BOM、转义、quoted CRLF、空白记录、末尾记录分隔符的精确结果断言。

未知/未完成的证据：原始 UTF-8 字节的严格解码没有当前可调用适配层，String → String 桥不能证明它；按架构应由后续 Node 文件适配层的 fatal UTF-8 解码验证。本次不拿未实现 Task 6 的文件适配器单独判 Task 1 失败。历史红灯基线没有独立存档，本次没有修改实现或伪造重建历史红灯。

## 可复现核心脚本

在本仓库根目录先 `moon build cmd/bridge --target js`，再执行下列脚本。脚本不写产品文件；输出中列出的异常均为本次实测结果。为避免无谓资源压力，没有 >64 MiB 样本。

```sh
node --input-type=module <<'JS'
import {invoke_bridge as invoke} from './_build/js/debug/build/cmd/bridge/bridge.js';
const call = request => JSON.parse(invoke(JSON.stringify(request)));
const base = (type='text', extra={}) => ({
  schema_version:1,
  fields:[{name:'id',left:'id',right:'id',type,...extra}],
});
const cases = [
  ['wrong abs type', base('decimal',{abs_tol:4})],
  ['wrong rel type', base('decimal',{rel_tol:true})],
  ['wrong missing policy type', base('text',{both_missing:null})],
  ['text decimal tolerance', base('text',{abs_tol:'1'})],
  ['date decimal tolerance', base('date',{abs_tol:'1'})],
  ['decimal date tolerance', base('decimal',{days_tol:1})],
  ['integer saturation', base('date',{days_tol:2147483648})],
  ['65-digit tolerance', base('decimal',{abs_tol:'1'.repeat(65)})],
  ['19-fraction tolerance', base('decimal',{rel_tol:'0.'+'1'.repeat(19)})],
  ['identity map', {...base('text',{compare:false,left_values:{A:'B'}}),key:['id']}],
  ['candidate default', {...base(),candidates:{
    fields:[{field:'id',metric:'exact',weight:1}],threshold:1,
  }}],
];
for(const [name,config] of cases)
  console.log(name, JSON.stringify(call({op:'check_config',config})));
for(const [name,left_csv] of [
  ['257 columns',Array.from({length:257},(_,i)=>`c${i}`).join(',')+'\n'],
  ['100001 data records','id\n'+'1\n'.repeat(100001)],
  ['65537-byte cell','id\n'+'x'.repeat(65537)+'\n'],
  ['syntax field locator','id,note\n1,bad"quote\n'],
]) {
  const r=call({op:'init_config',left_csv,right_csv:'id\n1\n'});
  console.log(name, JSON.stringify(r.ok?{ok:true,fieldCount:r.config.fields.length}:r));
}
JS
```

## 修复后复审门槛

I1–I6 应补充有意义的拒绝/接受边界回归测试并修复，I7 补齐探针或明确记录批准的计划调整。保留已通过的基本桥接与 parser 行为。重点检查：预算阈值恰好可接受/超过即错误（含多字节字符）、缺失与错误类型区别、类型容差约束、Int 可表示范围、identity-only 映射的合法性、规范化幂等。届时重新运行 MoonBit + Node 测试并进行针对性独立复现，方可重判 Task 1；不要求以实现后续任务来弥补本任务缺陷。
