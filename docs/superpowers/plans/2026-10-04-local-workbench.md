# 本地 CSV 工作台与离线运行包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付无需编辑 JSON 的完整 CSV 核对、人工复核、ZIP 恢复工作台，以及仅需 Node.js 22+ 的离线预编译包。

**Architecture:** MoonBit 保持唯一业务语义源，只新增 inspect_csv；原生 Node localhost 服务用可终止子进程调用既有 CLI run 与 bridge。浏览器通过有令牌、严格 schema 的 HTTP v1 操作不透明资产/版本，标准 run 之外保存工作台元信息。

**Tech Stack:** Node.js >=22、MoonBit JS ESM bridge、原生 HTML/CSS/ES modules；yauzl 3.4.0、yazl 3.3.1；@playwright/test 1.63.0（仅开发）。精确依赖固定与本地探针在 Task 5，不阻塞 Task 1。

**Spec:** `docs/superpowers/specs/2026-10-04-quarter-workbench-design.md`。执行者先读该规格、AGENTS.md、docs/configuration.md、docs/review-workflow.md、docs/dependency-audit.md；本计划的 DTO 名均指规格 §4–7 的精确字段。

**交接状态（2026-10-04）：** 规格和六项任务草案已写出，Task 1–6 均未开始。Sol 在收尾时遇到额度限制，未完成交付提交；主控制器仅修正文档文件名与运行包验证表述。下一个对话须先完成跨任务接口预检，建立新的执行台账，再开始 Task 1。以下自检是设计意图，不是实现或测试通过记录。

## Global Constraints

- Node.js >=22；工作台 `app_version = "0.2.0"`、`api_version = 1`；引擎 `engine_version = "0.1.0"`、Config v1、manifest v1 和现有四个 op 的请求/结果/退出语义不变。
- 只新增纯查看 op `inspect_csv`。业务解析、转换、匹配、评分、决定授权仍由 MoonBit 完成；UI/Node 不再实现 CSV parser、金额算法或冲突解决。
- 源 CSV：每侧原始字节 <=64 MiB、数据逻辑记录 <=100000、列 <=256、单格 UTF-8 <=64 KiB。决定：原始 <=128 MiB/400000 数据逻辑记录；非空 action 去重前 <=100000，规范 CSV <=64 MiB。宿主保护与这些引擎预算分别显示。
- `complete` 只说明计算完整。退出 0/1/3 都有有效 Result；退出 2 不发布结果。人工确认无对应仍是业务差异；accept 只确认对应；人工覆盖不能清除 incomplete。精确键配对锁定。
- 不默认猜类型、主键、trim、missing、容差或值映射。同名列只是草稿；所有类型明确选择，候选分数不是概率，建议默认不勾选。
- 不修改 manifest v1 字段集；工作台元信息放在 `run/` 外。每次成功生成不可变 `revision_id`，不能以 resolve 沿用的 `run_id` 标识复核版本。
- 源数据不上传外网；无无证客户收益声明。依赖及工具链实测、自动测试、浏览器操作、离线包、远端 CI、用户使用和赛事结果分别记录。
- 实施只在当前隔离 worktree；不改原 checkout，不推送。构建使用已核对的隔离 MoonBit 工具链，进程级环境注入，不改全局工具链。规划不安装依赖。
- A+C 此计划必须完整交付。B 下一独立计划才接入 XLSX；capabilities 当前只列 csv，xlsx 上传返回422，禁止用占位成功伪装支持。

## Review Focus

- 引号内多行、Unicode/长格与宽表：位置必须是逻辑数据记录；显示截断有标记，完整值可取，JSON预算不产生空的无限下一页（Task 1/2）。
- 配置导入带 `__proto__`、数字样式键、空missing与非当前类型容差：纯数据保留、全部表单可见，导出再导入不丢字段（Task 3）。
- 数据/规则改变、旧revision应用、回导遗漏已应用动作：旧报告保留，禁止错误分支更新和动作丢失（Task 4）。
- 上传断连、worker取消竞态、磁盘满与超时：服务仍响应，迟到结果不发布，只删本任务owned staging（Task 2/5）。
- 恶意ZIP与自洽但伪造的报告：重复/穿越/符号链接/别名/超解压拒绝，恢复必须CLI重放报告字节一致（Task 5）。

---

## 文件与接口边界

| 文件 | 责任/所有者 |
| --- | --- |
| inspect.mbt、engine.mbt、inspect_wbtest.mbt、tests/inspect.test.mjs | Task 1：唯一新增核心查看协议 |
| workbench/contracts.mjs | Task 2：APP_VERSION/API_VERSION/HOST_LIMITS、路由和 DTO校验；后续只扩展已有动作实现，不改字段命名 |
| workbench/session.mjs | Task 2：注册表、owned文件、quota、不可变revision/head；Task 4增加复核发布 |
| workbench/engine-host.mjs、worker.mjs、jobs.mjs | Task 2：同步bridge隔离、CLI运行封装、单worker取消；Task 4增加review/branch；Task 5增加bundle/restore |
| workbench/server.mjs、start.mjs | Task 2：安全HTTP/静态白名单、启动/关闭；Task 3/4/5注册功能路由，复用同一鉴权 |
| workbench/public/api.mjs、state.mjs、dom.mjs、index.html、app.mjs、styles.css | Task 3：通信、页面状态、安全DOM、完整规则流程；Task 4/5扩展页面 |
| workbench/public/import-view.mjs、config-view.mjs、config-model.mjs | Task 3：数据预览及覆盖所有Config字段的表单 |
| workbench/public/result-view.mjs、review-view.mjs、review-model.mjs | Task 4：结果解释与累计决定操作 |
| workbench/archive.mjs、workbench/public/export-view.mjs | Task 5：ZIP白名单与恢复/导出流程 |
| scripts/package-workbench.mjs、scripts/check-workbench-package.mjs | Task 6：可搬迁预编译包及离线门禁 |

所有新增源文件单一责任；尽量不改 cli/main.mjs、cli/io.mjs 的业务/事务。可复用的现有签名：`run(argv: string[], runtime?: {cwd,stdout,stderr,invoke,now,fs,limits,statfs}) -> Promise<number>`（cli/main.mjs）；`loadBridgeInvoke(modulePath?:string) -> Promise<(string)=>string>`（cli/bridge.mjs）；`decodeUtf8Fatal(bytes,options) -> string`、`canonicalJsonStringify(value) -> string`、`sha256Hex(bytes) -> string`（cli/io.mjs）；`renderCsv(header,rows) -> string`（cli/render.mjs）。不得从 stdout 文本提取业务结果。

### Task 1: MoonBit 完整校验、分页预览与单格原值

**Files:** Create `inspect.mbt`、`inspect_wbtest.mbt`、`tests/inspect.test.mjs`；Modify `engine.mbt`（op分派）；更新生成 `.mbti` 仅在 moon info 确实改变时。

**Interfaces:**
- Consumes：`parse_csv(text : String, side : String) -> Result[CsvTable, EngineError]`（csv.mbt）、既有 error_to_json/request_error（model.mbt/engine.mbt）。
- Produces：`handle_inspect_csv(object : Map[String, Json]) -> Json`（inspect.mbt，私有）；既有 invoke/invoke_bridge 增加规格§4两种请求，不新增公共typed业务API。Preview/Cell DTO完全按规格，offset0基、record1基、cell.column完整表头。

- [ ] **Step 1:** 写失败测试：`inspect_preserves_logical_records_and_full_cell` 断言带中文、引号内CRLF的2条数据，offset1返回record2；257码点格预览value256/truncated=true且完整格返回原串；utf8_bytes按原格。
- [ ] **Step 2:** 运行 `npm run build`、`node --test tests/inspect.test.mjs`，确认 unknown_operation/缺失handler导致失败。
- [ ] **Step 3:** 写协议拒绝与预算测试：side非法、offset负数/非整数、limit0/101、cell与分页混用、未知key、缺列/缺record→invalid_request；duplicate header/invalid quote/格65537字节复用原错误；offset超末尾空页。内部小预算测试覆盖少返回完整行、next_offset推进、单行/表头容不下→preview_limit_exceeded；生产JSON<=2097152字节，不能先构造全量大JSON再检查。
- [ ] **Step 4:** 实现handle_inspect_csv复用parse_csv，保持既有四个handler不动；采用旧工具链已验证Json构造/Map/StringView API（docs/dependency-audit.md），不凭新版文档改全仓语言API。
- [ ] **Step 5:** 运行 `moon check --target js`、`moon test --target js`、`moon info`、`moon fmt`、`moon fmt --check`、`npm test`、`npm run test:workflows`、`npm run test:public-data`。记录实际测试数量；四op基线结果与版本不变，检查生成接口diff有且仅有预期变更。
- [ ] **Step 6:** 仅提交本任务文件：`git add inspect.mbt inspect_wbtest.mbt engine.mbt tests/inspect.test.mjs`（如mbti有合理变更单独明确stage）；`git commit -m "feat: add bounded engine CSV inspection"`。交付真实可调用的查看操作，不做空脚手架。

### Task 2: 可运行安全服务、导入/规则/compare API 与取消

**Files:** Create `workbench/contracts.mjs`、`workbench/session.mjs`、`workbench/engine-host.mjs`、`workbench/worker.mjs`、`workbench/jobs.mjs`、`workbench/server.mjs`、`workbench/start.mjs`、`tests/workbench-server.test.mjs`、`tests/workbench-jobs.test.mjs`、`tests/workbench-host.test.mjs`。Task 3前静态首页可为说明页，但本任务API必须真实完成orders import→check→compare。

**Interfaces:**
- Consumes：Task 1 JSON协议与上方现有CLI签名。
- Produces（contracts.mjs）：`APP_VERSION="0.2.0"`、`API_VERSION=1`、`HOST_LIMITS`（规格§6 exact values）；`assertDto(kind:string,value:unknown) -> object`（非法抛ErrorDTO包装错误）。仅测试可注入更低quota/time，产品无提限入口。
- Produces（session.mjs）：`createSession({rootParent?:string,limits?:object}) -> Promise<Session>`；Session方法 `getAsset(id)->AssetEntry`、`getImport(id)->ImportEntry`、`getRevision(id)->RevisionEntry`、`publishRevision({runPath,left_import_id,right_import_id,config_asset_id,parent_revision_id,baseline_revision_id}) -> Promise<Revision>`、`reset()->Promise<void>`、`close()->Promise<void>`。Entry内部含path；HTTP只投影规格DTO，未知ID404。publish先hash/配额核对，更新分支head原子完成。
- Produces（engine-host.mjs）：`callEngine(request:object,invoke:(string)=>string) -> object`（沿用错误envelope）；`executeTask(task:TaskRequest, {invoke,signal?}) -> Promise<TaskOutput>`。TaskRequest=`{kind,payload,paths,bridge_path}`；paths只由注册表构造。已实现kind=import/preview/cell/draft/check/compare/example；后续review/branch/bundle/restore在相同分派新增，未知kind拒绝。
- Produces（jobs.mjs）：`createJobManager({session,workerPath,bridgePath,limits}) -> JobManager`；`start(kind,payload)->Job`、`get(id)->Job`、`cancel(id)->Promise<Job>`、`close()->Promise<void>`。IPC parent→child `{job_id,task}`；child→parent `{job_id,type:"phase",phase}` 或 `{job_id,type:"result",output}` 或 `{job_id,type:"error",error}`；父亲按活跃job校验消息，不把迟到result注册。
- Produces（server.mjs）：`startWorkbench({bridgePath?:string,rootParent?:string,limits?:object}) -> Promise<{origin,token,session,jobs,close:()=>Promise<void>}>`。start.mjs唯一启动入口，打印fragment URL，无自动打开shell命令。规格§5 Task2所属路由全部实现；公开DTO/HTTP状态exact，不接收path/url。

- [ ] **Step 1:** 写host失败测试 `orders_api_report_equals_cli`：同样快照/config调用run与executeTask compare，report.json逐字节相同、exit1；draft仍type=null且不可运行；check成功config绑定左右imports；0/1/3发布有Result、2不发布。配置大于编排上限通过资产文件路径可验证，失败不隐式截断。
- [ ] **Step 2:** 运行 `npm run build`、`node --test tests/workbench-{host,server,jobs}.test.mjs`，确认缺模块/函数失败。
- [ ] **Step 3:** 实现host与注册表/worker：import完整fatal UTF8+inspect，API preview/cell都是job；draft/check输出规范config资产、GETconfigs export文件流；example逐条走相同处理。worker一开始umask077，CLI runtime显式invoke/cwd/stdout/stderr，stdout只capture不用解析。注册资产hash后才能可见，compare读取自己的run/report而非stderr摘要；ErrorDTO去除内部路径栈。
- [ ] **Step 4:** 写并实现安全/资源测试 `requires_exact_host_origin_and_token`、`rejects_stream_over_limit_without_length`、`disconnect_leaves_no_asset`、`cancel_ignores_late_worker_result`、`timeout_and_quota_preserve_previous_revision`、`cleanup_refuses_foreign_or_symlink_root`。断言Host403、跨站403、无令牌401、合法无Origin CLI请求可用，转发头不改变判断；上传和job各限1；60s/180s/1GiB等用降低阈值实测；SIGTERM→1000ms SIGKILL、exit后才清理。计算期间 capabilities响应<1000ms（测试本机基准，非性能保证）。
- [ ] **Step 5:** 实现HTTP路由与stream/body严格schema，含1MiB编排/2MiB显示响应；分页items分开source_index，不把body分散到任意路由。写测试oversize item给完整证据export入口且不返回假成功，宽预览job包装超2MiB明确拒绝/重取更小页；静态固定映射，不提供通配文件服务。CSP、nosniff、no-referrer、no-store按规格。
- [ ] **Step 6:** 运行上述三份tests与 `npm test`；手动 `node workbench/start.mjs`，用测试客户端真实upload/check/compare/取消并检查workspace文件0600目录0700。Task2无bundle/restore路由成功响应，尚未实现的路由404，capabilities仅csv。提交本任务确切文件，message=`feat: add isolated local workbench service`。

### Task 3: 完整 CSV 导入与 Config v1 无代码表单

**Files:** Create `workbench/public/{api,state,dom,app,import-view,config-view,config-model}.mjs`、`workbench/public/index.html`、`workbench/public/styles.css`、`tests/workbench-config.test.mjs`；Modify `workbench/server.mjs`（静态文件白名单）。

**Interfaces:**
- Consumes：Task2 API精确路由；Task1 Preview/Cell DTO。
- Produces（api.mjs）：`createApiClient({origin,token,fetchImpl=fetch}) -> {request(path,{method?,body?}),upload(kind,file),waitJob(job_id,{signal?}),download(path)}`。request返回解析后的成功envelope或抛ErrorDTO；upload原始字节，filename编码；download返回Blob，Authorization从内存加入；token从fragment一次读取立即移除。
- Produces（state.mjs）：`createWorkbenchState() -> Store`；`get()->UiState`、`update(patch)->void`、`subscribe(fn)->()=>void`。UiState=`{left_import_id,right_import_id,config_asset_id,config,draft_dirty,revision,stale,pending_decisions,active_job,error}`（初始null/false/[]）；任何源/规则编辑置stale=true、清空validated config_asset_id，保留revision；新成功compare重置stale=false/pending_decisions=[]。
- Produces（config-model.mjs）：`configToForm(config:object) -> FormModel`、`formToConfig(model:FormModel) -> object`；FormModel的字段名保持Config v1，值映射编辑为`[{key,value}]`、missing=`string[]`、blocking=`string[][]`；编码时无原型对象，绝不Number(abs_tol/rel_tol)。`renderConfigView({root,store,api}) -> ()=>void`、`renderImportView({root,store,api}) -> ()=>void`。dom.mjs只用textContent/createElement/setAttribute安全构建。

- [ ] **Step 1:** 写失败测试 `all_config_v1_properties_round_trip`：orders/catalog加trim/lower、左右映射含`__proto__`/`10`/`2`、missing空串、both_missing=issue、compare=false、三种容差、key/ignore与多blocking；经core check→表单→config→core check canonicalJson逐字节相等。重复mapping键表单报错而不是覆盖；未知配置核心拒绝；改type不清容差、删field不清引用。
- [ ] **Step 2:** 运行 `node --test tests/workbench-config.test.mjs` 确认失败；实现config model和完整表单，所有规格§3字段可访问，advanced折叠不丢值。空白规则有显式类型选择，decimal普通text输入，day/weight/threshold仅严格整数，已验证norm config可下载导入。
- [ ] **Step 3:** 实现APIclient与状态、安全DOM及import view：文件选择/拖放、双方预览分页、sha/完整校验计数、截断完整单格、错误定位、四示例来源标签、左右交换确认。token不进storage/query/log。超过JSON显示预算显示可执行的缩页/文件导出路径，不能称已显示全部证据。
- [ ] **Step 4:** 实现app主步骤与规则摘要/运行按钮：check成功config_asset_id绑定当前两个imports；再次编辑使运行禁用直到check；运行真正compare job，取消按钮用DELETEjob；新文件/规则后旧revision只读而stale=true。界面映射列表50条/页，记录预览20条/页。
- [ ] **Step 5:** `node --test tests/workbench-config.test.mjs` 与Task2测试通过；浏览器实际手动从空白orders选择每列/类型、主键、status映射及amount0.02，不编辑JSON完成compare；记实际操作与截图（正式自动E2E Task5补齐）。键盘能到所有控件且label关联，HTML字符串原样显示。提交Task3文件，message=`feat: add complete CSV import and rules forms`。

### Task 4: 结果解释、四决定累计回导与版本化复核

**Files:** Create `workbench/public/{result-view,review-view,review-model}.mjs`、`tests/workbench-review.test.mjs`、`tests/workbench-result.test.mjs`；Modify `workbench/{contracts,session,engine-host,worker,server}.mjs`、`workbench/public/{state,app}.mjs`、`workbench/public/styles.css`。

**Interfaces:**
- Consumes：Task2 Revision/Job/注册表/API、CLI run resolve、Task3 Store/ApiClient；原Result字段见model.mbt及cli/render.mjs。
- Produces：executeTask增加review/branch；review payload=`{base_revision,decisions_asset_id}`（服务器先验证head），从已登记baseline快照run resolve到新staging；parent Result.decisions元组须全在新Result.decisions，缺失noncumulative_decisions；publishRevision独立revision_id且更新head。
- Produces（review-model.mjs）：`buildCumulativeCsv(applied:Decision[],pending:Decision[]) -> string`，Decision=`{action:"accept"|"reject"|"left_unmatched"|"right_unmatched",left_id:null|string,right_id:null|string,reason:string}`；用renderCsv的等价共享编码（将现有cli/render.mjs作为静态模块精确白名单供应或提取无语义变化的共享renderCsv，选择其一并记录），只serialize不解析CSV/解决冲突。`renderResultView({root,store,api}) -> ()=>void`、`renderReviewView({root,store,api}) -> ()=>void`。
- Produces：规格§5 summary/collections/item export/cell/reviews/branch/report-summary-decisions export完整路由；body/query字段保持规格 exact。summary不推导业务计数，filter/pagination只选择原数组。

- [ ] **Step 1:** 写失败测试 `orders_review_preserves_differences`（L3 unmatched后unresolved0、different3、exit1）、`catalog_can_reject_top_and_accept_competitor`（rejectL1R2、acceptL1R1、right_unmatchedR2，原highest10000建议不默认accept）、`review_revision_is_distinct_but_run_id_stays`（父子ID不同run_id同）。
- [ ] **Step 2:** 运行 `node --test tests/workbench-{review,result}.test.mjs` 确认失败；实现backend review/branch与只读结果/下载路由。严格同head乐观锁，job发布前再验head；旧revision409 stale_revision；解析与授权仅CLI核心；输入错误不发布且旧report hash不变。
- [ ] **Step 3:** 写并实现 `imported_decisions_are_append_only`（遗漏父动作→noncumulative_decisions）、`conflict_batch_has_no_publication`（同对accept+reject）、`locked_exact_pair`、`manual_override_needs_reason`、`incomplete_remains_exit3_after_review`（既有101x101 fixture思路）、`cumulative_export_reimport_equals_report`。结果筛选分页保留全证据及原顺序；HTML/中文长值显示完整格/证据下载；无端点自动解锁。
- [ ] **Step 4:** 实现结果/候选/复核UI：所有Result状态分组、原/转换/规范值与解释；所有竞争候选、null分数与诊断；四动作reason和手工ID选择；待应用可移除、已应用只读；导入累计CSV直接上传交resolve，不前端parse；失败错误保留待应用；修改源/规则禁旧结果应用。新分支显式确认，不称撤销历史。
- [ ] **Step 5:** 运行review/result及Task2/3测试、`npm test`/`npm run test:workflows`；手动浏览器catalog和orders完整操作，下载决定回导后的report逐字节相等。提交确切Task4文件，message=`feat: add versioned review and result evidence`。

### Task 5: 白名单 ZIP 导出恢复与真实浏览器闭环

**Files:** Create `workbench/archive.mjs`、`workbench/public/export-view.mjs`、`tests/workbench-archive.test.mjs`、`tests/e2e/workbench.spec.mjs`、`playwright.config.mjs`、`package-lock.json`；Modify `package.json`、`.gitignore`（node_modules、dist、浏览器报告）、`workbench/{contracts,engine-host,worker,server}.mjs`、`workbench/public/app.mjs`、`workbench/public/styles.css`、`docs/dependency-audit.md`。

**Interfaces:**
- Consumes：Task2 owned staging/quota/Job IPC、Task4 revision与标准run下载；规格§7包schema与12文件白名单。
- Produces（archive.mjs）：`writeRunBundle({runPath,sidecar,destPath,limits}) -> Promise<{bytes,sha256}>`、`readRunBundle({assetPath,stagingPath,limits}) -> Promise<{runPath,sidecar}>`。仅worker调用；read不信任原path，只流到服务器生成路径；恢复接着CLI resolve和report byte compare，成功才publishRevision。
- Produces：executeTask增加bundle/restore；服务器实现POSTbundle、GETbundle export、POSTrestores；bundle_asset_id是注册kind=run文件，restore新revision/history引用按规格，不载入pending。
- Produces（export-view.mjs）：`renderExportView({root,store,api}) -> ()=>void`，待应用提示、三个原报告下载、完整ZIP和ZIP恢复。

- [ ] **Step 1:** 固定npm dependencies `yauzl="3.4.0"`、`yazl="3.3.1"`、devDependency `@playwright/test="1.63.0"`，生成lockfile记录integrity；先审依赖树/许可/实际npm audit报告，区分官方metadata与本地探针，无未处理致命依赖风险才继续；不引入XML/XLSX依赖。追加test:workbench=`node --test tests/workbench-*.test.mjs`、test:workbench:e2e=`playwright test`。开发安装浏览器不进入最终运行包。
- [ ] **Step 2:** 写archive失败测试 `bundle_roundtrip_cli_report_equal` 与恶意fixture：重复entry、../、反斜杠、绝对路径、符号链接、非普通文件、大小写/Unicode别名、未知字段/engine、缺文件、错误hash、伪造大小/超解压、截断流。独立Python zipfile构造危险包（无需安装依赖），不能仅用同一库自造预期；测试用低quota快速走拒绝门禁。
- [ ] **Step 3:** 运行 `node --test tests/workbench-archive.test.mjs` 确认失败；实现流式库调用实际字节计数、精确12文件包与sidecar。恢复read→hash/schema→CLIresolve→原包report bytes compare→publish；自洽哈希但report伪造仍replay_mismatch；取消/超限只清本staging，旧revision可读。
- [ ] **Step 4:** 实现导出/恢复UI与API，同授权fetch Blob下载，下载URL不带token；只暴露规格白名单，不支持任意文件选路径。导出ZIP job可取消，report等原文件流下载不阻塞同步bridge。
- [ ] **Step 5:** 写真正Playwright E2E：orders从空白表单（不用rules.json/内部state）→比较→L3确认→下载累计决定/ZIP→reset→恢复→导入决定→report与CLI字节同；catalog通过表单候选设置→否决最高分/接受竞争候选/无对应；manual override空reason拒绝；精确配对只读；CSV畸形/配置错误有定位；源编辑旧结果禁应用；job取消；HTML安全和键盘/390px窄屏（无主要按钮被遮挡）。断言UI行为和下载内容，不能仅page.goto/截图算E2E。
- [ ] **Step 6:** `npm run test:workbench`、`npm run test:workbench:e2e`、`npm test`、两个已有workflow gates通过；存真实截图/测试结果与未验证项。提交Task5文件，message=`feat: add verified workbench bundles and browser workflows`。

### Task 6: Node22离线预编译分发与最终门禁

**Files:** Create `scripts/package-workbench.mjs`、`scripts/check-workbench-package.mjs`、`docs/workbench.md`、`docs/evidence/workbench-validation-2026-10-04.md`、`tests/workbench-package.test.mjs`；Modify `package.json`、`README.md`、`.github/workflows/ci.yml`、`cli/bridge.mjs`（按下述约束支持独立CLI及工作台的运行包桥定位）、`docs/limitations.md`。

**Interfaces:**
- Consumes：Task1 built bridge、Task2 startWorkbench({bridgePath})、Task5固定生产依赖/可恢复包。
- Produces：`npm run package:workbench`（脚本先检查bridge存在，不在用户运行时build）；输出ignored `dist/moonreconcile-workbench-0.2.0/`与`.zip`。包内 `runtime/bridge.js`、cli/、workbench/、examples/、production node_modules/、package.json+lock、LICENSE/THIRD-PARTY-NOTICES、START-HERE.md；工作台与独立 `node cli/main.mjs` 都必须定位包内 runtime/bridge.js；采用 cli/bridge.mjs 的惰性路径解析统一实现：包内 runtime 存在时选用，否则保持开发构建路径。显式 modulePath 仍优先；模块导入及 --help/--version 不探测磁盘、不构建。预检时核对现有签名，再在此边界内实施；不能只为工作台注入而使独立CLI依赖开发 _build。没有开发机路径/软链/绝对node_modules依赖。
- Produces：`npm run test:workbench:package`=`node scripts/check-workbench-package.mjs`；脚本在干净临时目录解包，以真实Node22 binary启动，PATH只放该Node，另用可验证的网络隔离机制阻止外网但允许loopback（PATH限制不等于网络隔离）；记录机制、限制及外联失败对照。完成upload/import/check/compare/review/ZIP恢复，并用包内独立CLI重放验证report；运行包不能调用moon/npm/python。验证报告记录实际Node版本、桥hash、包hash与最终SHA。

- [ ] **Step 1:** 写失败测试 `package_runs_without_moon_or_install`、`relocated_bridge_equals_checkout`、`package_contains_only_runtime_deps_and_licenses`；断言没有Playwright/browser、开发_build依赖、用户路径/绝对symlink，无npm安装步骤；Node<22启动明确拒绝。先跑 `node --test tests/workbench-package.test.mjs`确认失败。
- [ ] **Step 2:** 实现打包/离线验证，生产依赖从固定lock安装/复制到干净打包目录，不能盲拷含dev node_modules；编译好的bridge一起打包。离线测试使用已可用的Node22或在开发阶段准备它，不能拿Node24冒充Node22门禁；若工具/网络暂不可得，明确该门禁未通过，不声称包已验收。
- [ ] **Step 3:** 完成中文START-HERE/README/workbench文档：一条命令、仅本机处理且暂存、令牌、退出/异常残留owned清理、限额、完整与业务差异区别、Config表单范围、累计决定不可撤销/分支、ZIP重放、仅CSV及B边界。不写“通用Excel”“零依赖”或客户收益；更新运行依赖审计事实。
- [ ] **Step 4:** CI现有Ubuntu/macOS门禁保留，增加workbench unit与真实浏览器/包验证（Node22，离线阶段不联网；浏览器及npm开发安装在之前）。本地执行 `moon check --target js`、`moon test --target js`、`moon info`、`moon fmt --check`、`npm test`、`python3 scripts/check-assignment-oracle.py`、`python3 scripts/check-library-consumer.py`、`npm run test:workflows`、`npm run test:public-data`、`node scripts/readme-smoke.mjs`、三项workbench unit/E2E/package gates。已有成功不替代新增代码完整门禁。
- [ ] **Step 5:** 从最终SHA实际操作离线包浏览器orders/catalog，检查键盘与长中文/窄窗口；记录证据表：命令、版本、SHA、退出码、截图、包hash、未验证远端CI/真实用户/赛事。邀请后续真实用户验证作为待办，禁止编造观察。
- [ ] **Step 6:** 提交Task6精确文件，message=`feat: package offline Node workbench and document evidence`；独立审查整个diff、任务覆盖/接口/安全/重放证据，修复后重跑受影响门禁。没有发布授权不推送；本地完成与远端CI状态分别报告。

## 规格覆盖与交接自检

| 必需能力 | 任务 |
| --- | --- |
| strict parser唯一源、有界预览/完整格、旧四op不变 | 1 |
| Host/Origin/token、子进程取消、上传/磁盘quota、真实CLI报告 | 2 |
| 全Config表单、示例/空白流程、规则版本与源变化 | 3 |
| 分页差异/所有竞争候选、四决定、累计CSV、锁与incomplete | 4 |
| 白名单ZIP、完整恢复重放、真实浏览器闭环 | 5 |
| 预编译Node22离线、可搬迁桥与依赖、最终门禁/证据 | 6 |

接口自检：Preview/Cell→worker.output→ApiClient→view字段一致；revision_id/head与run_id分离；config_asset_id明确对应已验证norm文件；所有同步engine/ZIP操作在child；Result数组不重算、不用display值作为输入；所有task共用同一个鉴权与session注册表；后续Task只增加定义过的kind，不派生第二服务/协议。上述Review Focus各有对应测试，B保持独立未实现。

执行按Task1→6顺序，每项交付验收与局部提交后再进下一项；已授权执行方式由主控制器保持，不在本计划重复请求逐步许可。测试失败不得用刷新快照或删断言掩盖合同变更；修复与证据随任务提交。
