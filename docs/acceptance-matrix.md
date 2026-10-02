# MoonReconcile 验收矩阵

创建日期：2026-09-30；Task 8 更新：2026-10-02。依据：[规格](spec.md)、[实施计划](plans/2026-09-30-table-reconcile.md)。

**本表是验收清单，不是完整产品已通过报告。** 下列“证据位置”是计划归档位置，除实际写明的证据外，不代表文件或测试已经存在。实现时可调整实际文件名，但必须保留验收 ID，并填写实际测试名、执行命令、退出码、结果摘要、提交 SHA 及证据路径。不得仅因实现文件存在就将项目改为通过。

状态取值：`pending`（未验证）、`pass`（有完整证据）、`fail`（已验证不符合）、`blocked`（列出明确外部阻碍）。真实需求、XLSX 和赛事结果可单独保留未验证状态，不能伪装成已完成的软件验收；阻碍首版功能合同的问题必须列为交付阻塞。

## 已验收里程碑

| ID | 范围 | 实际证据 | 状态 |
| --- | --- | --- | --- |
| T01 | Task 1：严格 CSV 导入、配置校验与 MoonBit/Node 桥接；不含文件 CLI、对应、复核或报告 | `moon check --target js` exit 0；`moon test --target js` 23/23；`npm test` 6/6；[独立复审](evidence/task1-rereview.md) 针对 `2d05f5e` 确认 I1–I7 和 M1–M3 均已修复，后续文档提交未改变引擎源码 | pass |
| T02 | Task 2：精确十进制、严格日期、字段转换/缺失策略与比较证据；不含整表对应或 CLI | 提交 `540767c`：`moon check --target js` exit 0；`moon test --target js` 45/45；`npm test` 6/6；[独立审查与复审](evidence/task2-review.md) 确认 Unicode 日期崩溃已修复，独立副本 48/48（含 100 组 Decimal 与 100 组日期金标准） | pass |
| T03 | Task 3：精确组合键、异常键诊断、结构报告、字段明细、记录计数与 compare 接口；不含候选/决定/CLI | 提交 `1710446`：[独立审查与复审](evidence/task3-review.md) PASS；MoonBit 50/50、Node 8/8，200 组独立配对/守恒/确定性核对通过；JSON 合同、忽略列错误、规范化配置已回归 | pass |

| T04 | Task 4：候选生成、固定分母评分、Unicode 编辑距离、预算保护、最大权重部分建议；不含人工决定/CLI | 提交 `4fe8f74`：[独立审查](evidence/task4-review.md) PASS，63 MoonBit/8 Node/9 独立场景；控制器 240 图穷举对照 64/64。稀疏性能问题记录并交 Task 7 实测 | pass |

| T05 | Task 5：严格决定、原子冲突拒绝、累计重放、人工覆盖和字段重算；不含文件指纹/CLI | 提交 `5281187`：[接续独立审查](evidence/task5-review.md) PASS；隔离82MoonBit/8Node，200组复核断言及生产101×101全量人工处置仍exit3通过 | pass |

| T06 | Task 6：四命令、快照指纹、事务保护及11文件导出；不含完整场景/规模/远端CI | 修复提交 `4304f75`：[独立复审](evidence/task6-rereview.md)确认七项缺陷修复；82MoonBit/53Node，含I/O与目录保护回归 | pass |

| T07 | Task 7：三个合成工作流端到端、确定性基准与规模实测；不含需求证据、竞品实测、XLSX、远端CI | `npm run test:workflows`；`node --test tests/*.test.mjs`；[`task7-original-review.md`](evidence/task7-original-review.md)、[`task7-fix-report.md`](evidence/task7-fix-report.md)、[`task7-final-rereview.md`](evidence/task7-final-rereview.md) | pass（范围审查通过；仅合成工作流与单机测量） |

| U01 | Task 8 文档与交付：架构/配置/复核文档、CI 配置、README 验收路径 | `moon info && moon fmt`；README 标记命令块由 `node scripts/readme-smoke.mjs` 从提交的干净克隆中执行；准确证据见 `docs/validation.md` | 本地交付完成；远端最终 SHA 的 CI 与整体独立审查仍 pending |

## 1. 规格章节与产品闭环

| ID | 规格 | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- | --- |
| S01 | §1、§4 | 导入→规则→对应→解释→人工回导→最终报告六阶段均可由公开命令重现 | `tests/cli.test.mjs`；`docs/validation.md` | pending |
| S02 | §2 | 竞品对照区分文档证据、实测和未知；不声称未经核查的生态空白 | `docs/dependency-audit.md`；`docs/validation.md` | pending |
| S03 | §3 | orders、migration、catalog 各有完整输入、规则、决定及预期结果；显著标注合成 | `examples/orders/`；`examples/migration/`；`examples/catalog/` | pending |
| S04 | §4 | 严格导入、映射、记录对应、字段解释、人工处理、全部导出都有测试 | 本表 I/C/E/M/H/O 项及 `docs/validation.md` | pending |
| S05 | §5 | 文本/标识符、十进制、日期、缺失值均符合明示语义 | `rules_wbtest.mbt`: `text_identifier_keeps_leading_zeroes`, `maximum_input_digits_remain_exact`, `relative_tolerance_boundary_uses_exact_product`, `gregorian_leap_century_validates_2000_and_rejects_1900`, `both_missing_issue_requires_review` | pending |
| S06 | §6 | 唯一键自动对应、候选评分、部分分配、分层预算各有独立测试 | `exact_wbtest.mbt`: `task3_exact_pair_duplicate_missing_structure_and_conservation`; `candidates_wbtest.mbt`: `task4_assignment_max_weight_partial_not_greedy`, `task4_pair_budget_overflow_is_transactional_and_exact_pairs_survive`, `task4_scoring_admission_is_component_atomic_and_budget_remains_for_later_work` | pending |
| S07 | §7 | 快照、指纹、四种决定、冲突原子性、累计重放、人工覆盖全部验证 | `decisions_wbtest.mbt`: `conflicting_batch_is_rejected_atomically`, `noncandidate_accept_requires_reason`, `identical_decision_repeat_is_idempotent`, `resolve_rebuilds_base_and_applies_complete_decision_table`; `tests/cli.test.mjs`: `resolve verifies fingerprints and engine version before invoking the engine` | pending |
| S08 | §8 | 记录/字段状态、退出码、输出清单和 MoonBit/宿主边界符合合同 | `tests/cli.test.mjs`: `every export is consistent with the locked Result`, `exit priority 2 > 3 > 1 > 0 publishes artifacts for 0, 1 and 3`; `docs/architecture.md` | pending |
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
| F02 | 每侧有限值映射只执行一次，不递归；原值、转换结果、规则名称可追溯 | `rules_wbtest.mbt`: `value_mapping_is_a_single_lookup`, `normalization_order_is_trim_lower_map_then_missing`; `tests/cli.test.mjs`: `every export is consistent with the locked Result` | pending |
| F03 | 十进制正负号、0、末尾零、64位/18位小数边界精确；越界及科学计数/货币符号拒绝 | `rules_wbtest.mbt`: `decimal_input_limits_are_enforced_without_rounding`, `positive_sign_and_negative_zero_normalize_exactly`, `scientific_notation_is_invalid_even_when_raw_values_match` | pending |
| F04 | abs/rel 容差非负；精确等于阈值可接受，超出不可；内部乘法/减法不截断或转浮点 | `rules_wbtest.mbt`: `negative_decimal_difference_uses_inclusive_absolute_tolerance`, `relative_product_keeps_precision_beyond_input_limits`, `relative_tolerance_boundary_uses_exact_product` | pending |
| F05 | 100.00 与 100 输出规则等价；保存带符号差值和实际阈值 | `rules_wbtest.mbt` | pending |
| F06 | 严格 YYYY-MM-DD、2000/1900 闰年、月日边界、跨年天数和非负容差正确 | `rules_wbtest.mbt`: `gregorian_leap_century_validates_2000_and_rejects_1900`, `date_day_boundary_and_signed_difference_are_exact`, `unicode_malformed_date_is_invalid_value_not_panic` | pending |
| F07 | 缺失标记显式；0 不等于缺失；双方缺失 equal/issue 生效；单方缺失为差异 | `rules_wbtest.mbt` | pending |
| F08 | 无效类型输出 invalid_value；相同无效原值也不能记 equal；不退回文本规则 | `rules_wbtest.mbt` | pending |
| F09 | 解释只陈述原值/变化/触发规则，不生成未经证实业务根因 | `tests/cli.test.mjs`: `summary renders source headers without activating HTML or Markdown`; `tests/decisions-oracle.test.mjs`; three synthetic workflow expected outputs | pending |

## 3. 对应、候选、分配与资源

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| E01 | 仅左右各唯一、有效非缺失非空的规范化键自动对应；重复键不取第一条 | `exact_wbtest.mbt` | pending |
| E02 | 组合键编码不受分隔符碰撞影响；缺失/空/无效键诊断并保留待处理记录 | `exact_wbtest.mbt` | pending |
| E03 | 不设键时全部进入剩余；单边记录不会自动判定无对应 | `exact_wbtest.mbt` | pending |
| M01 | 无分组允许预算内全配对；同组 AND、多组 OR、候选并集去重；缺失分组记录不消失 | `candidates_wbtest.mbt` | pending |
| M02 | 编辑距离按 Unicode 码点；评分 floor 公式、1..10000 权重/阈值、固定分母正确 | `candidates_wbtest.mbt` | pending |
| M03 | 空/缺失身份字段得0分；类型无效候选没有有效总分；解释和入口保留 | `candidates_wbtest.mbt` | pending |
| M04 | 阈值不合格边不能分配；展示所选建议及双方竞争；建议不自动转 paired | `candidates_wbtest.mbt`: `task4_candidate_all_pairs_fixed_denominator_and_pending_suggestion`, `task4_assignment_leaves_rows_unmatched_and_prefers_total_weight`; Task 5 human-review assertions in `decisions_wbtest.mbt` | pending |
| M05 | Hungarian 与独立穷举小图最大权部分匹配一致，含贪心失败、同分、无边、不等侧规模 | `candidates_wbtest.mbt`: `task4_assignment_max_weight_partial_not_greedy`, `task4_assignment_leaves_rows_unmatched_and_prefers_total_weight`; `assignment_goldens_wbtest.mbt`: `independent_240_assignment_goldens`; `python3 scripts/check-assignment-oracle.py` | pending |
| M06 | 输出顺序可复现；同分稳定不宣称身份确定或全局最优解唯一 | `candidates_wbtest.mbt`；`docs/limitations.md` | pending |
| B01 | 源文件64 MiB、100000数据逻辑行、256列、每格64 KiB边界与超界有测试，不截断继续 | `csv_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| B02 | 候选100000对去重预算超出时整个候选阶段停止，保留精确配对并标 incomplete | `candidates_wbtest.mbt` | pending |
| B03 | 阈值合格图分量每侧100行边界；超界分量 unprocessed，其他分量仍处理 | `candidates_wbtest.mbt`: `task4_qualified_size_limit_is_per_component_and_exact_limit_succeeds`, `task4_qualified_component_limit_does_not_apply_to_pre_score_graph` | pending |
| B04 | 512码点、20000000累计DP单元边界；预估安全；不能删除昂贵边后伪造完整图 | `candidates_wbtest.mbt`: `task4_edit_codepoint_limit_513_marks_whole_component_unprocessed`, `task4_edit_cell_budget_exact_boundary_succeeds_and_one_over_fails` | pending |
| B05 | 权重累加、距离成本、分配数值无整数溢出；资源问题定位阶段与范围 | `candidates_wbtest.mbt`: `task4_256_max_weight_fields_use_wide_aggregate_arithmetic`; `assignment_goldens_wbtest.mbt`: `independent_240_assignment_goldens` | pending |
| B06 | 人工处理预算受限记录不改写原候选计算历史，仍 incomplete/退出3 | `decisions_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| B07 | 决策原始模板128 MiB/400000数据行；非空动作100000行（去重前）/含标题规范CSV64 MiB独立受限；空action仍消耗原始预算，超限原子拒绝 | `decisions_wbtest.mbt`: `decision_raw_rows_and_bytes_count_ignored_blank_actions`, `decision_active_rows_are_bounded_before_dedup_and_ignore_blanks`, `decision_active_canonical_bytes_include_header_unicode_and_csv_escaping`, `decision_production_raw_and_active_row_boundaries_are_separate`; `tests/bridge.test.mjs`: `pure invoke admits decision templates above the source cap and rejects excess active or raw rows atomically` | pending |
| B08 | 合法导出可再次回导；累计动作及新记录/建议空白均在模板预算内，源表上限未放宽 | `tests/cli.test.mjs`: `production 50001 per side templates replay with original IDs and applied history`, `decision raw byte guard uses its own internal limit and preserves source guards`; 闭环上界见 `review-workflow.md` | pending |

## 4. 人工决定、文件完整性和输出

| ID | 验收对象与通过条件 | 证据位置（计划） | 状态 |
| --- | --- | --- | --- |
| H01 | accept/reject/left_unmatched/right_unmatched 语义分别正确；空白决定仍待复核 | `decisions_wbtest.mbt` | pending |
| H02 | ID存在、端点占用、接受/拒绝、接受/无对应冲突整批拒绝，无局部状态应用 | `decisions_wbtest.mbt` | pending |
| H03 | 完全重复决定去重；决定重排与重复累计回导语义幂等 | `decisions_wbtest.mbt`；`tests/cli.test.mjs` | pending |
| H04 | 候选外接受需要理由并标人工覆盖，不伪造评分；exact_key 端点锁定 | `decisions_wbtest.mbt` | pending |
| H05 | 拒绝候选不确认整行无对应；人工接受后仍按规则比较全部内容字段 | `decisions_wbtest.mbt`: `rejecting_candidate_keeps_both_rows_pending`, `human_acceptance_recomputes_and_preserves_field_difference`, `human_acceptance_preserves_identical_invalid_decimal_values` | pending |
| P01 | 快照字节SHA-256、规范化配置指纹、引擎版本和run_id均校验，不仅信任report.json | `tests/cli.test.mjs` | pending |
| P02 | 快照/配置/版本/运行标识被改动时 resolve 拒绝；原路径文件删除不妨碍复核 | `tests/cli.test.mjs` | pending |
| P03 | 原始输入不修改；输出目录非空拒绝；写入先暂存成功后发布；失败无伪成功运行 | `tests/cli.test.mjs`；故障注入记录 | pending |
| P04 | 写快照前磁盘检查、磁盘/权限/I/O失败正确退出2，清理仅限工具创建临时目录 | `tests/cli.test.mjs`；故障注入记录 | pending |
| O01 | 四类记录互斥，左右总数分别守恒；paired来源仅exact_key/human_review | `exact_wbtest.mbt`: `task3_exact_pair_duplicate_missing_structure_and_conservation`; `scripts/workflows.mjs` derives IDs and checks all fixture states; `tests/cli.test.mjs`: `every export is consistent with the locked Result` | pending |
| O02 | equal/equivalent_by_rule/different/invalid_value 可追溯原记录及规则 | `tests/cli.test.mjs`: `every export is consistent with the locked Result`; `tests/decisions-oracle.test.mjs` | pending |
| O03 | complete表示计算覆盖，不表示复核完成；待复核不展示全部完成；无对应仍计业务差异 | `tests/cli.test.mjs`: `summary reports computation coverage separately from unresolved differences`, `unprocessed records stay visible after a fully reviewed incomplete run` | pending |
| O04 | manifest.json、input/left.csv、input/right.csv、config.json、report.json全部生成且相互一致 | `tests/cli.test.mjs` | pending |
| O05 | pairs.csv、fields.csv、candidates.csv、decisions.csv、unresolved.csv、summary.md齐全，转义保留内容 | `tests/cli.test.mjs` | pending |
| O06 | 决策模板不预填accept；所有未解决记录可定位；时间戳不参与语义等价比较 | `tests/cli.test.mjs` | pending |
| O07 | 退出码0/1/2/3分别覆盖，优先级2>3>1>0；仅规则等价不触发1 | `tests/cli.test.mjs`: `exit priority 2 > 3 > 1 > 0 publishes artifacts for 0, 1 and 3`, `a fully reviewed run with no usable key exits zero`; `exact_wbtest.mbt`: `task3_equivalent_only_exit_zero_and_unmapped_column_exit_one` | pending |

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
| V04 | 精确关联+业务规则基线及有标注合成真值的候选评价；不以配对增多证明准确性改善 | `examples/catalog/truth.json`; workflow assertion in `scripts/workflows.mjs`; [`task7-benchmark.json`](evidence/task7-benchmark.json) | pending |
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

## 命名断言索引（Task 8）

下表把每个逐项 ID 家族连到仓库中实际存在的命名断言或准确的可执行验证。它是覆盖索引，不会把单项局部测试扩大解释为整节全部通过。`V05/V06` 为真实需求与格式适配证据缺口；`D05/D07–D09` 由最终独立审查和精确 SHA 的远端结果决定。

| ID | 命名断言 / 可执行证据 |
| --- | --- |
| S01, S03, S04 | `npm run test:workflows` 对 orders/migration/catalog 的 compare→resolve→replay 及完整导出校验；README smoke 明确执行 init/config/compare/两次 resolve/最终报告检查 |
| S02, S09, S10, S11, S12 | 文档核对：`dependency-audit.md` 区分文档与实测；`limitations.md` 记录真实流程/XLSX 未知；`official-requirements-2026-10-01.md` 留存部署页证据及源码日期差异；`LICENSE` 与 `moon.mod` 声明 MIT |
| I01–I04 | `csv_wbtest.mbt`: `quoted_newline_uses_one_record`, `crlf_and_trailing_empty_preserved`, `illegal_quote_rejected`, `duplicate_or_blank_header_rejected`, `unequal_width_reports_record`; `tests/cli.test.mjs`: `invalid UTF-8 is fatal and publishes nothing`, `an initial BOM is accepted and preserved in snapshot bytes and hash`, `double and interior byte-order marks are rejected` |
| C01–C04 | `config_wbtest.mbt`: `duplicate_mapping_rejected`, `unknown_rule_rejected`, `unknown_field_property_rejected`, `draft_config_is_rejected_until_edited`, `init_draft_does_not_infer_key_or_type`, `identity_only_field_accepts_explicit_value_mapping`; `tests/cli.test.mjs`: `init-config output is canonical and round-trips through check-config once edited` |
| F01–F09 | `rules_wbtest.mbt`: `text_identifier_keeps_leading_zeroes`, `value_mapping_is_a_single_lookup`, `maximum_input_digits_remain_exact`, `relative_tolerance_boundary_uses_exact_product`, `decimal_scale_difference_is_equivalent_by_rule`, `same_raw_decimal_with_different_side_maps_is_not_reported_equal`, `gregorian_leap_century_validates_2000_and_rejects_1900`, `both_missing_issue_requires_review`, `identical_invalid_values_are_not_equal`, `unicode_malformed_date_is_invalid_value_not_panic`; user-facing explanatory scope in `review-workflow.md` |
| E01–E03 | `exact_wbtest.mbt`: `task3_exact_pair_duplicate_missing_structure_and_conservation`, `task3_delimiter_key_collision_impossible_and_no_key_pending`, `task3_invalid_typed_and_empty_text_keys_stay_pending` |
| M01–M06 | `candidates_wbtest.mbt`: `task4_candidate_all_pairs_fixed_denominator_and_pending_suggestion`, `task4_blocking_or_and_deduplicates_pairs_and_ignores_missing_keys`, `task4_edit_score_uses_unicode_codepoints_and_invalid_typed_score_is_null`, `task4_assignment_max_weight_partial_not_greedy`, `task4_scoring_admission_is_component_atomic_and_budget_remains_for_later_work`, `task4_assignment_leaves_rows_unmatched_and_prefers_total_weight`; `assignment_goldens_wbtest.mbt`: `independent_240_assignment_goldens` |
| B01–B08 | `csv_wbtest.mbt`: `csv_column_budget_accepts_exact_limit_and_rejects_over_limit`, `csv_record_budget_accepts_exact_limit_and_rejects_over_limit`, `csv_cell_budget_counts_utf8_bytes_and_checks_exact_boundary`, `csv_total_byte_budget_counts_multibyte_utf8_at_boundary`, `csv_private_raw_budget_counts_header_bom_utf8_and_separators`; decision B07/B08 names above; `candidates_wbtest.mbt`: `task4_pair_budget_overflow_is_transactional_and_exact_pairs_survive`, `task4_qualified_size_limit_is_per_component_and_exact_limit_succeeds`, `task4_edit_codepoint_limit_513_marks_whole_component_unprocessed`, `task4_edit_cell_budget_exact_boundary_succeeds_and_one_over_fails`; `decisions_wbtest.mbt`: `resource_limited_manual_pair_keeps_incomplete_history`; `tests/decisions-oracle.test.mjs` includes a production 101×101 fully reviewed incomplete run |
| H01–H05 | `decisions_wbtest.mbt`: `side_unmatched_is_reported_and_exits_one`, `conflicting_batch_is_rejected_atomically`, `identical_decision_repeat_is_idempotent`, `noncandidate_accept_requires_reason`, `rejecting_candidate_keeps_both_rows_pending`, `human_acceptance_recomputes_and_preserves_field_difference`; Task 8 adds `exact_key_locks_all_four_review_actions`, `same_action_and_endpoints_with_different_reasons_conflict`, `malformed_ids_and_extra_or_missing_endpoints_are_rejected`, `human_acceptance_preserves_identical_invalid_decimal_values`, `positive_below_threshold_accept_requires_reason_and_is_override`, `accepting_a_qualified_competing_candidate_is_not_an_override` |
| P01–P04 | `tests/cli.test.mjs`: `resolve verifies fingerprints and engine version before invoking the engine`, `resolve rejects a missing snapshot or manifest`, `output destinations must be absent or empty and never alias inputs`, `a write failure publishes nothing and removes only its own staging`, `a file close failure aborts run publication and retains an earlier write error`, `init-config fails safely when atomic no-replace publication is unavailable` |
| O01–O07 | `tests/cli.test.mjs`: `every export is consistent with the locked Result`, `summary reports computation coverage separately from unresolved differences`, `exit priority 2 > 3 > 1 > 0 publishes artifacts for 0, 1 and 3`; `scripts/workflows.mjs` checks full fixture record coverage, export rows and retained reports |
| Q01–Q04 | `tests/cli.test.mjs`: `init-config output is canonical and round-trips through check-config once edited`, `check-config prints canonical normalized config and rejects drafts`, `end to end compare`, `resolve is reproducible and read-only on the source run`; exact commands are extracted from README by `node scripts/readme-smoke.mjs` |
| V01–V04 | `npm run test:workflows`; `scripts/benchmark.mjs` and retained `task7-benchmark.json`; `examples/catalog/truth.json` plus fixture truth checks; claims and limits in `docs/validation.md` |
| V05–V06 | Pending by design: no licensed real workflow or export inspection exists. Do not mark software tests as substitutes. |
| D01–D04, D06 | Source review of MoonBit/Node boundary, `moon.mod`, `LICENSE`, dependency audit; final local commands in `validation.md`; public tracked payload review and synthetic fixture labels |
| D05, D07–D09 | Pending at implementer handoff: final whole-project review, push/remote HEAD proof, two-OS Actions run for the exact delivery SHA, and final release note. |

## 资源边界证据的实际尺度（最终修复）

- **生产常量解析边界**：源表 100000/100001 数据行、256/257 列、单元格 64 KiB/超限已执行；决策原始模板 400000/400001 行与有效动作 100000/100001 行通过真实常量解析测试。动作数测试使用重复 reject，只证明去重前准入，未执行 100000 动作的应用吞吐测试。
- **生产 CLI 回导回归**：每侧 50001 行无键源表，compare 导出 100002 行空白模板，再空白 resolve、添加 reject、累计 replay，逐项保留 100002 个原始 ID、状态和源快照。它证明跨阶段正确性，不表示最大规模性能。
- **内部小阈值边界**：原始 UTF-8 字节（含 BOM、标题、引号与换行）、有效动作规范字节（31 字节标题、Unicode、逗号、CR/LF、双引号加倍和必要包围引号）、动作数与原始行数的分离；host 的决策/源表角色字节守卫；累计 DP 单元预算分支测试。内部入口未暴露为 CLI 选项。
- **尚未执行**：字面 64 MiB 源表/有效动作、128 MiB 决策原始模板、20000000 DP 单元，以及所有预算同时达到上限的完整 compare→resolve 吞吐/峰值内存。上述边界守卫、闭环上界证明和历史基准不可替代这些最大负载证据。

模板闭环上界为最多 100000 动作、200000 记录空白、100000 建议空白；后两类合法 ID 空白分别最多 11/18 字节，总追加最多 4000000 字节。动作规范 CSV 已含标题且不超过 64 MiB，因此总模板小于 128 MiB、数据行不超过 400000。源文件、快照、manifest/config 字节守卫仍为 64 MiB。最终 SHA 的门禁/发布状态由控制器看到实际结果后单独填写。
