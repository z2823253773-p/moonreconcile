# MoonReconcile 验收矩阵

创建日期：2026-09-30。依据：[规格](spec.md)、[实施计划](plans/2026-09-30-table-reconcile.md)。

**本表是验收清单，不是已通过报告。所有初始结果均为 `pending`。** 下列“证据位置”是计划归档位置，除本表引用的规格/计划外，不代表文件或测试已经存在。实现时可调整实际文件名，但必须保留验收 ID，并填写实际测试名、执行命令、退出码、结果摘要、提交 SHA 及证据路径。不得仅因实现文件存在就将项目改为通过。

状态取值：`pending`（未验证）、`pass`（有完整证据）、`fail`（已验证不符合）、`blocked`（列出明确外部阻碍）。真实需求、XLSX 和赛事结果可单独保留未验证状态，不能伪装成已完成的软件验收；阻碍首版功能合同的问题必须列为交付阻塞。

## 1. 规格章节与产品闭环

| ID | 规格 | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- | --- |
| S01 | §1、§4 | 导入→规则→对应→解释→人工回导→最终报告六阶段均可由公开命令重现 | `tests/cli.test.mjs`；`docs/validation.md` | pending |
| S02 | §2 | 竞品对照区分文档证据、实测和未知；不声称未经核查的生态空白 | `docs/dependency-audit.md`；`docs/validation.md` | pending |
| S03 | §3 | orders、migration、catalog 各有完整输入、规则、决定及预期结果；显著标注合成 | `examples/orders/`；`examples/migration/`；`examples/catalog/` | pending |
| S04 | §4 | 严格导入、映射、记录对应、字段解释、人工处理、全部导出都有测试 | 本表 I/C/E/M/H/O 项及 `docs/validation.md` | pending |
| S05 | §5 | 文本/标识符、十进制、日期、缺失值均符合明示语义 | `rules_wbtest.mbt`；`decimal_wbtest.mbt`；`date_wbtest.mbt` | pending |
| S06 | §6 | 唯一键自动对应、候选评分、部分分配、分层预算各有独立测试 | `exact_wbtest.mbt`；`candidates_wbtest.mbt`；`assignment_wbtest.mbt` | pending |
| S07 | §7 | 快照、指纹、四种决定、冲突原子性、累计重放、人工覆盖全部验证 | `decisions_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| S08 | §8 | 记录/字段状态、退出码、输出清单和 MoonBit/宿主边界符合合同 | `report_wbtest.mbt`；`tests/cli.test.mjs`；`docs/architecture.md` | pending |
| S09 | §9 | 首版边界对外说明明确；无实现外功能或 XLSX 能力承诺 | `README.md`；`docs/limitations.md` | pending |
| S10 | §10 | 实测、独立对照、需求缺口和继续投入条件分别记录 | `docs/validation.md`；`docs/limitations.md` | pending |
| S11 | §11 | 当前赛事日期/要求有来源；公开交付不写成审核通过 | `docs/project-proposal.md`；发布说明中的当前官方链接与核查日期 | pending |
| S12 | §12 | 依赖实际版本、源码/文档/运行证据层级和许可证可追溯 | `docs/dependency-audit.md`；`moon.mod`；`LICENSE` | pending |

## 2. 输入、配置和字段规则

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| I01 | UTF-8 解码失败返回输入错误；只允许起始 BOM；原始字节快照保留 | `tests/cli.test.mjs`；`csv_wbtest.mbt` | pending |
| I02 | 引号内逗号/换行、双引号转义、CRLF、末尾空字段准确保留；末尾记录分隔不增加数据行 | `csv_wbtest.mbt` | pending |
| I03 | 未闭引号、非法引号、重复/空标题、行宽不符拒绝并定位侧/逻辑记录/字段 | `csv_wbtest.mbt` | pending |
| I04 | 记录 ID 为 L1/R1 起始的数据逻辑记录号；含换行单元格不改变编号 | `csv_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| C01 | 缺少来源列、重复逻辑名/来源映射、未知字段/属性、错误类型配置拒绝 | `config_wbtest.mbt`；`exact_wbtest.mbt` | pending |
| C02 | 列顺序变化不改变显式映射；忽略列列入报告；未映射列触发结构问题 | `exact_wbtest.mbt`；`examples/migration/` | pending |
| C03 | init-config 生成草稿，不猜主键/类型；未完成草稿不通过 check-config | `config_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| C04 | 身份字段和比较字段独立；无剩余记录无需候选字段；启用候选时必须有有效字段 | `config_wbtest.mbt`；`exact_wbtest.mbt` | pending |
| F01 | 文本默认逐值比较，001 不等于 1；ASCII 转换只能显式执行 | `rules_wbtest.mbt` | pending |
| F02 | 每侧有限值映射只执行一次，不递归；原值、转换结果、规则名称可追溯 | `rules_wbtest.mbt`；`report_wbtest.mbt` | pending |
| F03 | 十进制正负号、0、末尾零、64位/18位小数边界精确；越界及科学计数/货币符号拒绝 | `decimal_wbtest.mbt` | pending |
| F04 | abs/rel 容差非负；精确等于阈值可接受，超出不可；内部乘法/减法不截断或转浮点 | `decimal_wbtest.mbt`；独立 golden cases | pending |
| F05 | 100.00 与 100 输出规则等价；保存带符号差值和实际阈值 | `rules_wbtest.mbt` | pending |
| F06 | 严格 YYYY-MM-DD、2000/1900 闰年、月日边界、跨年天数和非负容差正确 | `date_wbtest.mbt` | pending |
| F07 | 缺失标记显式；0 不等于缺失；双方缺失 equal/issue 生效；单方缺失为差异 | `rules_wbtest.mbt` | pending |
| F08 | 无效类型输出 invalid_value；相同无效原值也不能记 equal；不退回文本规则 | `rules_wbtest.mbt` | pending |
| F09 | 解释只陈述原值/变化/触发规则，不生成未经证实业务根因 | `report_wbtest.mbt`；示例报告人工检查记录 | pending |

## 3. 对应、候选、分配与资源

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| E01 | 仅左右各唯一、有效非缺失非空的规范化键自动对应；重复键不取第一条 | `exact_wbtest.mbt` | pending |
| E02 | 组合键编码不受分隔符碰撞影响；缺失/空/无效键诊断并保留待处理记录 | `exact_wbtest.mbt` | pending |
| E03 | 不设键时全部进入剩余；单边记录不会自动判定无对应 | `exact_wbtest.mbt` | pending |
| M01 | 无分组允许预算内全配对；同组 AND、多组 OR、候选并集去重；缺失分组记录不消失 | `candidates_wbtest.mbt` | pending |
| M02 | 编辑距离按 Unicode 码点；评分 floor 公式、1..10000 权重/阈值、固定分母正确 | `candidates_wbtest.mbt` | pending |
| M03 | 空/缺失身份字段得0分；类型无效候选没有有效总分；解释和入口保留 | `candidates_wbtest.mbt` | pending |
| M04 | 阈值不合格边不能分配；展示所选建议及双方竞争；建议不自动转 paired | `assignment_wbtest.mbt`；`report_wbtest.mbt` | pending |
| M05 | Hungarian 与独立穷举小图最大权部分匹配一致，含贪心失败、同分、无边、不等侧规模 | `assignment_wbtest.mbt`；`tests/oracle.test.mjs`（如采用） | pending |
| M06 | 输出顺序可复现；同分稳定不宣称身份确定或全局最优解唯一 | `candidates_wbtest.mbt`；`docs/limitations.md` | pending |
| B01 | 每文件64 MiB、100000逻辑行、256列、每格64 KiB边界与超界有测试，不截断继续 | `csv_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| B02 | 候选100000对去重预算超出时整个候选阶段停止，保留精确配对并标 incomplete | `candidates_wbtest.mbt` | pending |
| B03 | 阈值合格图分量每侧100行边界；超界分量 unprocessed，其他分量仍处理 | `assignment_wbtest.mbt`；`candidates_wbtest.mbt` | pending |
| B04 | 512码点、20000000累计DP单元边界；预估安全；不能删除昂贵边后伪造完整图 | `candidates_wbtest.mbt` | pending |
| B05 | 权重累加、距离成本、分配数值无整数溢出；资源问题定位阶段与范围 | `candidates_wbtest.mbt`；`assignment_wbtest.mbt` | pending |
| B06 | 人工处理预算受限记录不改写原候选计算历史，仍 incomplete/退出3 | `decisions_wbtest.mbt`；`tests/cli.test.mjs` | pending |

## 4. 人工决定、文件完整性和输出

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| H01 | accept/reject/left_unmatched/right_unmatched 语义分别正确；空白决定仍待复核 | `decisions_wbtest.mbt` | pending |
| H02 | ID存在、端点占用、接受/拒绝、接受/无对应冲突整批拒绝，无局部状态应用 | `decisions_wbtest.mbt` | pending |
| H03 | 完全重复决定去重；决定重排与重复累计回导语义幂等 | `decisions_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| H04 | 候选外接受需要理由并标人工覆盖，不伪造评分；exact_key 端点锁定 | `decisions_wbtest.mbt` | pending |
| H05 | 拒绝候选不确认整行无对应；人工接受后仍按规则比较全部内容字段 | `decisions_wbtest.mbt`；`report_wbtest.mbt` | pending |
| P01 | 快照字节SHA-256、规范化配置指纹、引擎版本和run_id均校验，不仅信任report.json | `tests/cli.test.mjs` | pending |
| P02 | 快照/配置/版本/运行标识被改动时 resolve 拒绝；原路径文件删除不妨碍复核 | `tests/cli.test.mjs` | pending |
| P03 | 原始输入不修改；输出目录非空拒绝；写入先暂存成功后发布；失败无伪成功运行 | `tests/cli.test.mjs`；故障注入记录 | pending |
| P04 | 写快照前磁盘检查、磁盘/权限/I/O失败正确退出2，清理仅限工具创建临时目录 | `tests/cli.test.mjs`；故障注入记录 | pending |
| O01 | 四类记录互斥，左右总数分别守恒；paired来源仅exact_key/human_review | `report_wbtest.mbt`；各工作流断言 | pending |
| O02 | equal/equivalent_by_rule/different/invalid_value 可追溯原记录及规则 | `report_wbtest.mbt` | pending |
| O03 | complete表示计算覆盖，不表示复核完成；待复核不展示全部完成；无对应仍计业务差异 | `report_wbtest.mbt`；Markdown人工检查记录 | pending |
| O04 | manifest.json、input/left.csv、input/right.csv、config.json、report.json全部生成且相互一致 | `tests/cli.test.mjs` | pending |
| O05 | pairs.csv、fields.csv、candidates.csv、decisions.csv、unresolved.csv、summary.md齐全，转义保留内容 | `tests/cli.test.mjs` | pending |
| O06 | 决策模板不预填accept；所有未解决记录可定位；时间戳不参与语义等价比较 | `tests/cli.test.mjs` | pending |
| O07 | 退出码0/1/2/3分别覆盖，优先级2>3>1>0；仅规则等价不触发1 | `tests/cli.test.mjs`；`report_wbtest.mbt` | pending |

## 5. 命令、实测和公开交付

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| Q01 | init-config LEFT RIGHT --out CONFIG：草稿可读且不覆盖原输入 | `tests/cli.test.mjs` | pending |
| Q02 | check-config CONFIG：正确配置通过，内部错误定位；不谎称验证真实列/唯一键 | `tests/cli.test.mjs` | pending |
| Q03 | compare LEFT RIGHT --config CONFIG --out RUN：快照和六阶段前半段可运行 | `tests/cli.test.mjs`；`examples/` | pending |
| Q04 | resolve RUN --decisions CSV --out REVIEWED：累积决定生成最终结果，支持独立新目录 | `tests/cli.test.mjs`；`examples/` | pending |
| V01 | 三个合成业务流程均从公开命令跑到底，结果有精确期望，含未解决/差异而非只测无差异 | `examples/`；工作流测试日志 | pending |
| V02 | 1000/10000行精确核对实测记录机器、版本、耗时、输出大小、退出码及内存可得性 | `scripts/benchmark.mjs`；`docs/validation.md` | pending |
| V03 | 稀疏/稠密候选及超预算案例实测；整表行数与候选分量规模分别报告 | `scripts/benchmark.mjs`；`docs/validation.md` | pending |
| V04 | 精确关联+业务规则基线及有标注合成真值的候选评价；不以配对增多证明准确性改善 | `docs/validation.md` | pending |
| V05 | 至少一个真实流程的来源、步骤、规模、规则、误配代价及当前基线；目前明确缺失 | `docs/limitations.md`；经许可脱敏的需求记录 | pending |
| V06 | 实际CSV无损导出能力已验证，或需要XLSX时单独立项；目前未验证 | `docs/limitations.md`；真实工作流输入检查记录 | pending |
| D01 | MoonBit承载算法与报告数据，Node仅适配；第三方依赖实际版本及选择理由可查 | `docs/architecture.md`；`docs/dependency-audit.md`；源码审查 | pending |
| D02 | README安装/构建/运行/复核可由干净检出复跑；核心库独立于CLI可调用 | `README.md`；外部消费/干净检出日志 | pending |
| D03 | OSI许可证、使用边界、配置说明、复核说明、策划书完整且无夸大 | `LICENSE`；`README.md`；`docs/` | pending |
| D04 | 核心/CLI/oracle/工作流本地门禁通过，保存命令、退出码、版本和精确SHA | `docs/validation.md`；测试日志 | pending |
| D05 | 独立审查发现与修复记录闭环；未解决功能缺陷未被标为交付通过 | `docs/validation.md`；审查问题与回归测试记录 | pending |
| D06 | 公开载荷无凭据、个人/临床原始数据、旧项目内容、临时依赖缓存；合成来源显著 | 跟踪文件清单审查；`.gitignore`；`examples/` | pending |
| D07 | 测试提交实际推送至公开GitHub；远端HEAD与本地SHA一致；README可见 | GitHub仓库/API证据；发布SHA记录 | pending |
| D08 | Ubuntu/macOS远端CI在交付SHA实际完成；失败/未运行状态如实记录 | `.github/workflows/ci.yml`；真实Actions run链接 | pending |
| D09 | 最终交付仓库地址、策划书、确切验证范围和剩余风险；不等同赛事通过或Mooncakes发布 | 最终交付记录；`docs/validation.md` | pending |

## 6. 证据更新格式与验收判断

每次更新使用如下记录，避免将预期输出当作实际证据：

```text
验收ID：
状态：pending / pass / fail / blocked
提交SHA：
日期与环境：
实际命令：
退出码：
实际结果与断言：
证据路径或远端URL：
未覆盖范围/失败原因：
```

软件交付需要 S01、S03–S09 及对应的 I/C/F/E/M/B/H/P/O/Q/V01–V04/D 门禁有实际证据；竞品事实、依赖和赛事表述也必须准确。V05 的真实需求与 V06 的 CSV/XLSX 适配风险必须在最终交付中单独明确，不能勾为完成。若真实输入后来要求 XLSX，当前 CSV 实现不能冒充那个真实场景已交付。

`pending` 不等于失败，但也不等于成功。资源受限测试的预期正确结果可以是退出3；有待复核的演示预期正确结果可以是退出1。验收依据是契约行为符合预期，不能以“所有命令退出0”替代。
