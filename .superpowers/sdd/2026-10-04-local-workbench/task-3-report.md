# Task 3 实施报告：完整 CSV 导入与 Config v1 无代码表单

## 交付内容

- 新增 `workbench/public/api.mjs`、`state.mjs`、`dom.mjs`、`app.mjs`、`import-view.mjs`、`config-view.mjs`、`config-model.mjs`、`index.html`、`styles.css`，并通过 `workbench/server.mjs` 固定静态白名单提供页面。
- 导入侧支持文件选择、拖放、四种示例来源、SHA-256/字节/完整校验行列数、表头和分页预览、可调预览页大小、长单元格取回及按含表头逻辑记录号定位错误。交换两侧前确认，并使用已有资产重新导入。
- 表单覆盖 Config v1 的字段、显式类型、比较和规范化开关、键、左右忽略列、映射、缺失标记、双方缺失策略、十进制字符串容差、日期整数容差、候选字段/指标/权重/阈值和 OR-of-AND blocking。映射使用键值行及无原型对象；重复键会显示错误。字段和映射按每页最多 50 项呈现；记录预览默认每页 20 项。
- 配置文件以原始字节上传并先经核心 `check_config`；只有成功后才读取规范配置替换表单。大型规则配置同样使用 64 MiB 文件资产路径。API 令牌只在内存闭包中使用，页面读取后立即清除 URL fragment；请求路径限制在同源。
- 状态在来源或规则更改后标记旧 revision、清空校验资产并清除待应用决定；重新校验绑定当前导入，但旧 revision 保持 stale。只有新比较成功才清除 stale。比较使用真实 job 路由，取消使用 DELETE job。
- 增加只读 `GET /api/imports/:id` 元数据路由，响应为投影的 Import/Asset DTO，不含内部路径；更新设计规格和实施计划记录此补充。

## TDD 与验证证据

- **RED：**先创建测试，再运行 `node --test tests/workbench-config.test.mjs`。运行在 `ERR_MODULE_NOT_FOUND` 处失败，缺失模块正是尚未实现的 `workbench/public/config-model.mjs`。
- **GREEN：**`node --test tests/workbench-config.test.mjs` 通过 8/8。覆盖 Config v1 经核心规范化后的逐字节 JSON round-trip、`__proto__`/数字样式映射键、空 missing、`both_missing=issue`、compare=false、容差字符串、候选与 blocking、重复映射拒绝、未知属性核心拒绝、改类型/删字段保留值和引用、严格整数词法、令牌 fragment 清理、同源 API 路径、stale 状态以及静态白名单和 Import 元数据路由。
- JavaScript 语法检查：对新增七个 `.mjs` 文件和 `workbench/server.mjs` 运行 `node --check`，全部通过。
- `git diff --check` 通过。
- Earlier implementation-stage gate: the prior report recorded 100/100 on an earlier commit. Its original full tool invocation and a persistent stdout log were not retained in this checkout, so that historical command is not reconstructed here and is not evidence for Round 1.
- 全量测试包括 Task 2 的 loopback server/job/host 测试；沙箱默认运行曾因 `listen(127.0.0.1): EPERM` 失败。使用用户已授权的本地 loopback 测试权限重跑后通过。

## 浏览器操作状态

控制器报告在诊断源码下完成过真实 Chrome 空白 orders 流程：通过文件选择器导入两侧 CSV；从 init 草稿的 8 个字段中删除 4 个单侧字段；为剩余 4 个逐项选列及 text/text/decimal/date 类型；设置 order_id 为 compare=false 和主键；设置右侧 status 映射“已支付”到 `paid`；设置 amount `abs_tol` 为字符串 `0.02`；通过核心校验并比较，状态为 complete/exit 1。下载的规范配置用于独立 CLI 比较，report 与浏览器工作台导出逐字节相同，报告 SHA-256 为 `9ad3a7139f11d2abcba4a18a54002b4452302ef04a577e534b45b24ea123af0a`。

控制器还报告 390×844 视口下 84 个可见且启用的控件全部通过 Tab 键访问（84/84）；校验、运行、报告下载三个主按钮的横向边界均在 390px 内。截图为 `browser/task3-orders-390.png` 和 `browser/task3-orders-result.png`，控制器已人工查看。HTML 长单元格安全显示与 stale 旧结果行为仍在诊断。以上浏览器证据都来自提交前诊断源码，不能替代最终 SHA 的复验；源码变更期间不得把这些截图记为提交 SHA 验收证据。

## 文件清单

- `workbench/public/{api,state,dom,app,import-view,config-view,config-model}.mjs`
- `workbench/public/{index.html,styles.css}`
- `workbench/server.mjs`
- `tests/workbench-config.test.mjs`
- `tests/workbench-ui.test.mjs`
- `docs/superpowers/specs/2026-10-04-quarter-workbench-design.md`
- `docs/superpowers/plans/2026-10-04-local-workbench.md`

## 审查修复：Round 1

- 引入共享来源/规则代次；比较只在输入代次未改变时清除 stale。比较期间的旧 revision 仍发布并保持只读 stale。空白草稿、原始配置导入、编辑后校验和示例加载都在最后一次下载文本完成后再次核对来源/规则代次，再发布到界面；来源任务期间的文件拖放会被拒绝。全局 job 会锁住规则编辑，取消和已校验配置、report 下载仍可用。
- 补齐候选评分字段分页；增加/删除候选、字段、映射及替换配置时重置或钳制页码。修复 49→50 映射项时跳到空白页的问题。
- 核心校验成功时展示 Config v1 字段、来源列、类型、比较开关、双方缺失策略、规范化、映射、缺失标记、容差、key/ignore 和候选规则摘要；分别列出每侧未映射且未忽略的表头，不自动忽略。编辑后即时隐藏校验摘要并禁用配置导出，不重建正在输入的字段控件。
- 缺失标记改为逐项输入，可分别编辑、添加和删除；空字符串是独立项目，不再与空数组混淆。清空主键/忽略列文本框得到空数组，仍保留非空引用供用户处理。
- 上传新文件显示其实际文件名并清除当前示例来源总标签；保留另一侧各自准确的来源标签。
- RED：新增 `tests/workbench-ui.test.mjs` 后，候选/映射分页边界、缺失项与 ignore 空数组、未映射列和校验摘要、延迟比较 stale 竞态、规范配置下载等待期间的编辑、文件替换来源标识均按相应旧行为失败；修正夹具后，回归断言基于可观察界面状态验证。
- Focused GREEN：`node --test tests/workbench-ui.test.mjs`，7/7 通过；`git diff --check` 通过。
- 最终完整门禁的实际工具调用命令为 `MOON_HOME='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain' MOONBIT_HOME='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain' PATH="/bin:$PATH" npm test`；build 成功，Node 测试 107/107 通过，退出 0。HTTP server tests 需要绑定 127.0.0.1，因此用已授权的本机 loopback 权限运行。该调用的 stdout 只作为 `functions.exec` 工具返回内容保存，没有另写持久日志文件；返回尾部为 `tests 107 / pass 107 / fail 0 / duration_ms 8520.765625`。
- 环境转录说明：实际命令的 PATH 前缀确为 `/bin`，不是恢复工具链的 `bin` 目录；不能据此声称隔离 SDK `bin` 被放在 PATH 首位。恢复记录给出的可复用隔离配置是 `PATH='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain/bin:<existing PATH>'`，但这不是本次已执行命令，未为修正文案而重跑。
- 修复代码提交为 `3bd65faa0baa5d8469c81341f48121a0ac17b101`。提交后代码工作区曾确认 clean；本次命令转录仅修改此报告，不改产品文件，也不另做提交。
- 最终 SHA 的浏览器重验仍由控制器执行；上一轮 orders/CLI 字节一致、390px 键盘和布局截图属于诊断 SHA，本轮不把它们声明为最终 SHA 验收。

## 审查修复：Round 2

- 根因：check、原始 Config 导入和草稿下载成功后，表单的 `FormModel` 被写入共享 `store.config`；订阅者又把它当 Config v1 转成 `FormModel`，映射行遂变成类似 `0 → [object Object]` 的错误内容。现共享 store 只保存核心返回或下载得到的规范 Config v1；`FormModel` 留在配置表单模块内。不可表示的重复映射编辑保留在本地表单，调用 `state.invalidateRules()` 清除已校验绑定、标记旧结果并递增 source/rule generation；每次此类编辑都会递增，包括已经 dirty 后的后续编辑。该接口是 Task 4 共用状态合同：异步工作以 `generation()` 捕获上下文，任何来源或规则编辑（包括暂不可规范化的表单编辑）都会使旧上下文失效。
- 校验绑定仅在 `config_asset_id` 或 `draft_dirty` 变化时也刷新摘要、未映射列区和导出按钮；stale 提示同步“可运行新比较/需重新校验”状态。配置摘要用 JSON 数组表示 missing 项，因此 `['']` 和 `[]` 清晰可辨。
- RED：共享 canonical-state 回归先按 check、导入和非法映射修复三条成功路径失败，观察到共享 state 中映射行对象替代规范映射对象。修正后，测试再以可观察行为发现并阻止“绑定清除后旧导出仍启用”的问题。
- Focused GREEN：`node --test tests/workbench-ui.test.mjs`，11/11 通过。新增真实 MoonBit 核心 `check_config` 规范化与 compare 覆盖 `__proto__`、`2`/`10` 数字样式键、空 missing 项、成功 raw import、成功草稿、无关字段编辑后重校验、重复映射暂存本地再修复，以及最终核心比较结果。
- Full GREEN：实际执行 `set -o pipefail`，随后执行 `MOON_HOME='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain' MOONBIT_HOME='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain' PATH='/Users/henryz/Desktop/比赛/moonreconcile/.worktrees/quarter-workbench/.superpowers/sdd/2026-10-04-local-workbench/toolchain/bin':"$PATH" npm test 2>&1 | tee /private/tmp/task3-round2-npm-test.log`。隔离 SDK `bin` 在 PATH 首位；build 成功，Node 测试 111/111 通过，退出 0，日志为 `/private/tmp/task3-round2-npm-test.log`，尾部 `tests 111 / pass 111 / fail 0 / duration_ms 8035.636`。`git diff --check` 和两个修改过的 `.mjs` 文件 `node --check` 也通过。
- 本轮最终提交 SHA 的真实浏览器复验仍待控制器执行；本报告不把先前诊断 SHA 截图当作本 SHA 证据。
