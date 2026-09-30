# Task 1 scoped independent re-review

日期：2026-09-30。审查者：GPT-6-Astra。最终审查提交：`2d05f5e80d8cdd37495b97e4f3580201d9f8b45b`。

初始修复提交为 `cc3d0421c19ac8c2b407477371d5633fab8c837a`；复审指出 NyaCSV 探针矩阵仍缺空表头等明确证据后，控制者在 `2d05f5e` 仅补充探针和审计文档，产品代码未变。本次读取原审查、修复 diff、实际源码、实施证据、依赖审计、探针、spec 和计划 Task 1；未修改产品代码。

**Spec verdict: PASS（仅 Task 1）。Quality verdict: PASS（仅本次修复范围）。** I1–I7 与 M1–M3 的原问题均已处理；未发现新的 Critical/Important 缺陷。`compare` / `resolve` 的显式 unsupported 行为仍符合本阶段约定，不评判尚未实现的 Tasks 2–8。

## 逐项结论

| 原编号 | 状态 | 修复与独立核验 |
| --- | --- | --- |
| I1 | ADDRESSED | `csv.mbt:27–119` 在字符数组展开前检查 64 MiB 文本预算，在扩张字段/记录数组前检查 256 列、100000 数据记录、65536 UTF-8 字节单元格预算。桥接实测 256/257 列、100000/100001 记录（有/无末尾换行）分别接受/拒绝；ASCII、é、😀 的精确字节边界与超一字节同样正确。文件总预算以代码检查和同一计数函数的小预算边界测试核验，未进行 64 MiB 整体压力试验。 |
| I2 | ADDRESSED | `config.mbt:323–360` 区分缺失和已提供错误类型。分别为 abs_tol、rel_tol、both_missing 提供 number、boolean、null、array、object，共 15 个桥接输入，全部返回 invalid_config；缺失仍由现有规范化测试验证默认值。 |
| I3 | ADDRESSED | `config.mbt:391–403` 拒绝无关非默认容差。独立覆盖 text 的 abs/rel/days、date 的 abs/rel、decimal 的 days，共六种拒绝路径。 |
| I4 | ADDRESSED | `config.mbt:135–157` 在 to_int 前检查整数及 0..2147483647 范围。2147483648、4294967296、-1、0.5 均拒绝；2147483647 原样返回，没有静默饱和。 |
| I5 | ADDRESSED | 额外的 identity-only 映射禁令已移除。compare:false、key:[id]、左右显式值映射的桥接配置成功，映射在规范化结果中保留。实际键转换执行属于后续任务，本次不据此宣称已完成。 |
| I6 | ADDRESSED | `config.mbt:105–132` 检查数字总数与小数位数。对 abs_tol 和 rel_tol 分别验证 64/65 位、18/19 位小数、+0.01/-0.01，接受/拒绝符合契约。 |
| I7 | ADDRESSED | 精确依赖身份为 moonbit-community/NyaCSV@0.3.3；核对隔离项目声明和下载包元数据，两者版本一致。独立重跑已存档的八项探针全部通过；包 API 和下载源码支持“无结构化错误/源位置接口、未拒绝未闭合引号”的审计结论。明确记录了自写严格解析器的选择依据，不把 GitHub 参照提交冒充发行包提交。 |
| M1 | ADDRESSED | `tests/bridge.test.mjs:94–106` 已删除无法观察前导零的断言和错误命名，并真正断言错误字段 note。MoonBit 原有测试直接验证 001 保留。 |
| M2 | ADDRESSED | 语法错误返回已知表头名或 column_N。独立验证未引用字段非法引号、未闭合引号、表头关闭引号后杂字符；含多行引用字段后的下条错误返回 record:3、field:note。错误 record 按 CSV 逻辑记录计数且表头为 1；后续 L1/R1 按数据记录计数、不含表头，二者不能直接混用。 |
| M3 | ADDRESSED | `config.mbt:699–719` 将候选 blocking 缺省值物化为 []。桥接深度比较确认省略与显式 [] 的规范化结果一致，再次 check_config 结果不变。 |

## 实际执行证据

- 产品树：`moon build cmd/bridge --target js` exit 0；`moon test --target js` exit 0，23/23。逐项读取了新增测试的断言，而非仅采用测试计数。
- 直接导入 `_build/js/debug/build/cmd/bridge/bridge.js` 的 `invoke_bridge`，使用 Node strict assert 检查上述配置、预算和位置路径，共 **58 个独立请求通过断言**。这些断言验证 ok/code、规范化值、配置深度等价或 record/field，不将 init_config 成功误称为已检查不可见的数据内容。
- NyaCSV 隔离目录 `/private/tmp/moonreconcile-nyacsv.LWq90V`：`moon check --target js` exit 0、无诊断；`moon test --target js` exit 0，8/8。`cmp` 确认运行的测试文件与最终提交的 `docs/probes/nyacsv_contract_wbtest.mbt` 相同。
- 新增三项 NyaCSV 探针覆盖空表头、引用多行后的数据记录数、末尾分隔符；其余五项覆盖未闭合引号、非引用字段非法引号、引用 CRLF/末尾空字段、重复表头、空白行。对照库接受非法输入的断言是行为观察，不是本项目接受这些输入。
- `git diff --check` exit 0。控制者报告的产品 `moon check` 与 `npm test` 结果未在本次重复运行；独立桥接请求与 MoonBit 测试构成本次自己的执行证据。

## 剩余边界

没有待修复的 Critical/Important 项。一个非阻塞测试维护建议：把本次已复现的“引用字段含换行后，下条非法记录仍为 record:3/field:note”固化为常驻回归测试，避免未来把诊断编号与数据记录 ID 混用。

本结论不证明原始文件字节 UTF-8 解码（后续 Node 适配层）、任意恶意 JSON/超大输入的宿主稳定性、声明预算下的性能规模、后续算法、远端 CI 或赛事验收。历史红灯基线仍只是实施者报告，本次没有伪造或重建该历史。
