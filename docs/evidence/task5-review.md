# Task 5 接续独立审查

审查执行：Claude Code，实际配置模型路由 DeepSeek-flash。原 Astra 审查因 Codex 额度被中断，没有给出通过结论。以下为接续审查报告，不归属于 Astra。

## 结论: **PASS** (Task5 规格与质量)

审查提交 `5281187566dff5eefefeddaa8433520b582056e6`(base `6e10546`),HEAD 与目标 SHA 一致,工作树干净,未修改任何 tracked 文件(临时探针写在被忽略的 `_build/` 下并已删除)。

### 实际执行的检查
- 通读 `decisions.mbt` / `model.mbt` / `report.mbt` / `engine.mbt` / `exact.mbt` / `decisions_wbtest.mbt`,以及 spec §7–8、plan 全局/JSON/Task5、task-5 brief/preflight/report。
- 大 diff 定位:`assignment_goldens_wbtest.mbt` 经「去空白+去格式化尾逗号」归一后与 base **逐字节相同**,确认纯格式化,无语义改动。
- `moon test --target js` → **82/82**;`node --test tests/*.test.mjs` → **8/8**(与报告一致,仅作锚点)。
- 通过已编译 bridge 独立探针(A–T),覆盖全部绑定语义:
  - 同 action/endpoints 不同 reason → `conflicting_decisions`(A);exact 锁对 accept/left_unmatched/right_unmatched 全部生效(B/C1/C2);非候选 reject 允许(D);共享右端点冲突(E);低于阈值且空 reason → `manual_override_needs_reason`,给理由后 `override=true`(F1/F2);达标候选空 reason 且 `override=false`、exit0(G);`key_not_found` 经 accept 处置后 exit0(H);`duplicate_key` 持续 exit1、`key_issue_count=2`(I);空白 action + 占位 ID 被忽略(J);非规范/越界/多余端点/未知 action 全部拒绝(K/L/M);双侧守恒与状态正确(N);决定重排 JSON 一致(O);已处置端点候选 `suggested=false`(P);unmatched exit1(Q/R);`invalid_value` 在人审配对后保留(S);接受非 suggested 竞争候选无需 override(T)。

未发现功能性规格违背:原子校验、全量累计重放、exact 锁、批量冲突、覆盖需理由不伪造评分、字段重算、`incomplete` 历史保留且 exit3、`key_not_found`/`no_key_configured` 不单独触发 exit1、真异常持续,均与绑定语义一致。brief 明确列出的 9 个必测用例全部存在。

### 发现(均为 Low,不阻断)
1. **[Low] 缺少回归用例:exact 锁仅测了 `reject`**(`decisions_wbtest.mbt:161`)。accept/left/right_unmatched 的锁定(`decisions.mbt:348`)仅由我的探针 B/C 证实,无单测。
2. **[Low] 缺少「同 action/端点上不同 reason 整批报错」单测**(规则在 `decisions.mbt:361-368`),仅探针 A 验证。
3. **[Low] 缺少非规范/越界/错误侧 ID 与多余端点用例**(`decisions.mbt:14-72,102-159`),仅探针 K/L/M 验证。
4. **[Low] 缺少 `invalid_value` 人审保留、`score>0 低于阈值` override、非 suggested 竞争候选接受 三例**(preflight 矩阵要求),仅探针 S/F2/T 验证。
5. **[Low] 最高风险的未测不变量:budget `incomplete` 且所有行被人审处置后仍 exit3、unresolved=0**(plan 第67行 / preflight 矩阵)。现有用例 `decisions_wbtest.mbt:368` 只处置 2 行中的 1 行。代码 `decisions.mbt:556` 的 `status=="incomplete" → 3` 保证该行为,故为测试覆盖缺口而非缺陷。
6. **[Low] 文档缺口:信息性诊断的区分未落入用户文档**。`key_not_found`/`no_key_configured` 计入 `summary.key_issue_count`(`report.mbt:103-115,266`)但被排除于 exit1(`decisions.mbt:547-552`);brief 要求「Document distinction」,目前仅 plan/acceptance-matrix/report 提及。
7. **[Info] `docs/acceptance-matrix.md` 的 H01–H05/S07/B06 仍为 pending**,依赖 Task6 的 `cli.test.mjs`,属后续任务,不计入 Task5。

### 残留未验证范围
- Task6 host 侧:指纹/engine 版本校验、错误→exit2 映射、CLI 文件事务(明确不在本提交承诺内)。
- 默认预算下无法廉价触发「全部行处置的 incomplete」场景,该项仅由代码阅读 + 部分用例推断。
- 未运行 `moon info`(会写 tracked `.mbti`);但 `.mbti` 已在提交中更新且 `moon check/test` 通过。
- 真实工作流数据、性能预算、XLSX 兼容性未验证(报告已如实标注)。

无被阻断的必需检查。

## 控制器补充验证

在 exact `5281187566dff5eefefeddaa8433520b582056e6` 的隔离 archive 中，check/test82/npm8/Python240 均 exit0。另以独立 Node 断言运行 200 组累计重排/重复决定、记录状态、字段结果和退出码案例，全部通过。使用生产预算的101×101全合格候选案例，人工接受全部101对后实测 `computation.status=incomplete`、`exit_code=3`、`unresolved_count=0`，双方 paired101/unprocessed0。该检查补足上文 Low5 的执行证据，后续回归测试已归档。其余 Low 测试与用户文档补充交最终验收处理。
