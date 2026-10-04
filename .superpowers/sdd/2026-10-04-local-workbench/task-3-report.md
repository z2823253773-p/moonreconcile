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
- 完整 Node 门禁：在隔离工具链环境执行 `MOON_HOME=.../.superpowers/sdd/2026-10-04-local-workbench/toolchain MOONBIT_HOME=.../.superpowers/sdd/2026-10-04-local-workbench/toolchain PATH="/bin:$PATH" npm test`；build 成功，Node 测试 100/100 通过，退出 0。运行时 Node 为 v24.15.0；这不替代后续 Node 22 离线包门禁。
- 全量测试包括 Task 2 的 loopback server/job/host 测试；沙箱默认运行曾因 `listen(127.0.0.1): EPERM` 失败。使用用户已授权的本地 loopback 测试权限重跑后通过。

## 浏览器操作状态

控制器报告在诊断源码下完成过真实 Chrome 空白 orders 流程：通过文件选择器导入两侧 CSV；从 init 草稿的 8 个字段中删除 4 个单侧字段；为剩余 4 个逐项选列及 text/text/decimal/date 类型；设置 order_id 为 compare=false 和主键；设置右侧 status 映射“已支付”到 `paid`；设置 amount `abs_tol` 为字符串 `0.02`；通过核心校验并比较，状态为 complete/exit 1。下载的规范配置用于独立 CLI 比较，report 与浏览器工作台导出逐字节相同，报告 SHA-256 为 `9ad3a7139f11d2abcba4a18a54002b4452302ef04a577e534b45b24ea123af0a`。

控制器还报告 390×844 视口下 84 个可见且启用的控件全部通过 Tab 键访问（84/84）；校验、运行、报告下载三个主按钮的横向边界均在 390px 内。截图为 `browser/task3-orders-390.png` 和 `browser/task3-orders-result.png`，控制器已人工查看。HTML 长单元格安全显示与 stale 旧结果行为仍在诊断。以上浏览器证据都来自提交前诊断源码，不能替代最终 SHA 的复验；源码变更期间不得把这些截图记为提交 SHA 验收证据。

## 文件清单

- `workbench/public/{api,state,dom,app,import-view,config-view,config-model}.mjs`
- `workbench/public/{index.html,styles.css}`
- `workbench/server.mjs`
- `tests/workbench-config.test.mjs`
- `docs/superpowers/specs/2026-10-04-quarter-workbench-design.md`
- `docs/superpowers/plans/2026-10-04-local-workbench.md`
