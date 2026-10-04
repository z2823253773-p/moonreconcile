# MoonReconcile 季度本地工作台设计

日期：2026-10-04。状态：待实现规格；当前已交付能力仍以 README 与现有验证记录为准。本文件不证明 XLSX 支持、真实用户收益、赛事资格或新版本通过测试。

### 实施前接口裁决（2026-10-04，优先于下文同名旧表述）

- CSV 校验失败沿用核心 record：含表头的逻辑记录 1 基编号；Preview/Cell 的 record 是数据记录 1 基编号。界面明确区分，不改核心错误。
- Job.kind 补齐 example、branch。summary 返回原 Result 的 structure；issues 集合精确映射 Result.key_issues，计算问题由 computation.issues 展示。分页 items 为 `{source_index,item}`，index 始终是原数组下标，原引擎对象不变。
- 配额由父进程每 250ms 异步监管 owned 用量，child 写入时仍精确计数；同步 bridge 不能依赖自身 timer。上传与任务共用预留账本。reset 在上传或 child 活跃时均 409，close 等写入终止再清理，generation 拒绝旧回调。监管间隔不保证磁盘瞬时零超量。
- IPC result 只是候选；child 退出后才准备发布。hash/quota/head 等异步校验后，最终 running/generation/head 检查、注册表/head 更新与 succeeded 转换须在无 await 的提交段完成。取消/超时/超限共用禁止发布门闩；exit 后才清 staging；提交后取消幂等。
- review 的父动作按完整 action/left_id/right_id/reason 元组检查子集，不能用易碰撞分隔符编码。UI 应取得全部 applied 分页才能构建累计 CSV。恢复重新注册 imports/config、生成本地基线并保留动作；branch 总用原快照/config 重跑 compare 清空决定，不复制已复核 baseline 的报告。
- 核心 inspect 预算按完整 envelope 的 UTF-8 JSON（含转义）计算；HTTP 再按最终 job envelope 预算。初始 import/preview 发布前可缩减完整行并更新 next_offset/has_more；一行或 headers 无法容纳则失败且不注册半导入。succeeded output 必须始终可轮询，不到 GET 时才发现溢出。大型表单配置也经资产文件上传，保留 64MiB 通道。
- CLI exit2 的机器错误从 reportFailure 的 JSON行取得，warning 行单独过滤；禁止解析人类摘要。ErrorDTO 保留稳定字段并移除内部路径/堆栈。包桥显式路径优先，再 runtime/bridge.js，再开发路径，解析保持惰性且 bridgeModulePath 同步；坏包不回退。

这些是实施接口澄清，不是测试通过或产品完成证据。

## 1. 产品方向与分阶段交付

把 MoonReconcile 扩展为“两个导出表的本地对账工作台”：浏览器选文件，明确设置列、类型、主键和规则，查看差异与候选，积累人工决定，保存可恢复、可用 CLI 重放的报告包。中文优先，数据只在本机服务处理并暂存到本机；启动后没有外网请求、账号或云端存储。

目标用户是核对两个系统导出表的运营人员、迁移验收人员以及维护两版公开数据的整理人员。第一批验证只证明免写 JSON 的流程能够完成，不声称节省多少时间或提高匹配准确率。三组合成示例不是客户数据；OurAirports 是已有来源记录的公开快照。医疗及其它敏感原始数据不得进入示例、远端仓库或外网 AI。

| 阶段 | 独立交付 | 验收边界 |
| --- | --- | --- |
| A | 完整本地 CSV 工作台 | 导入、完整校验预览、全规则表单、比较、解释、四种决定、累计回导、ZIP 导出恢复；真实浏览器闭环 |
| C（与 A 同批） | 预编译运行包 | 已安装 Node.js 22+ 的用户在干净目录离线启动，不要求 MoonBit、npm 安装或开发浏览器 |
| B（紧接下一子计划） | 受限 XLSX 导入 | 独立保值与恶意输入探针通过后才开放入口；混合 CSV/XLSX，追溯原件与转换依据 |

A+C 的实施计划为 `docs/superpowers/plans/2026-10-04-local-workbench.md`。B 另写计划，不将假 XLSX 入口或宽松转换作为 A 的替代品。暂不扩展拆单合单、跨表关联、公式重算、云协作、AI 猜规则或批量自动接受建议。

## 2. 不变的核心合同

- Node.js >=22；工作台 `app_version = "0.2.0"`、`api_version = 1`；引擎 `engine_version = "0.1.0"`、Config v1、manifest v1 和现有四个 op 的请求/结果/退出语义不变。
- 只新增纯查看 op `inspect_csv`。业务解析、转换、匹配、评分、决定授权仍由 MoonBit 完成；UI/Node 不再实现 CSV parser、金额算法或冲突解决。
- 源 CSV：每侧原始字节 <=64 MiB、数据逻辑记录 <=100000、列 <=256、单格 UTF-8 <=64 KiB。决定：原始 <=128 MiB/400000 数据逻辑记录；非空 action 去重前 <=100000，规范 CSV <=64 MiB。宿主保护与这些引擎预算分别显示。
- `complete` 只说明计算完整。退出 0/1/3 都有有效 Result；退出 2 不发布结果。人工确认无对应仍是业务差异；accept 只确认对应；人工覆盖不能清除 incomplete。精确键配对锁定。
- 不默认猜类型、主键、trim、missing、容差或值映射。同名列只是草稿；所有类型明确选择，候选分数不是概率，建议默认不勾选。
- 不修改 manifest v1 字段集；工作台元信息放在 `run/` 外。每次成功生成不可变 `revision_id`，不能以 resolve 沿用的 `run_id` 标识复核版本。
- 源数据不上传外网；无无证客户收益声明。依赖及工具链实测、自动测试、浏览器操作、离线包、远端 CI、用户使用和赛事结果分别记录。

## 3. 用户流程

### 选择数据

两侧选择或拖入 CSV。显示纯文本文件名、收到的字节数、SHA256、完整验证的行列数、完整表头与默认前 20 行。“预览 N 行，已完整校验 M 行”须区分采样与校验。CSV 使用现有 fatal UTF-8 合同；非法引号、重复/空表头、宽度错误等整批拒绝，展示侧、逻辑记录号、字段与修正提示。分页不把所有记录插入 DOM。

“载入示例”包括 orders、migration、catalog、OurAirports，走相同的资产、导入、配置、运行路径；来源标签显式显示。空白开始可手工构造 orders 的等价规则。左右交换、新文件或配置编辑将结果标记“旧版本”，不再允许向其应用当前草稿决定；旧报告保留可导出。交换须明确确认重置两侧关联、规则和待应用决定。

### 设置核对规则

表单可完整表达 Config v1，导入/导出无需 JSON 编辑。顶层：schema_version=1，draft 状态，fields、key、ignore_left/right、candidates。每个字段：name、left、right、type、compare、trim_ascii、lower_ascii、left_values、right_values、missing、both_missing、abs_tol、rel_tol、days_tol；容差始终字符串，日期容差是 0..2147483647 整数。即使某类型当前不允许非默认容差，折叠面板也显示保存的值和错误，不静默清零。

值映射是可增删的键/值行（用 Map 或无原型对象，支持 `__proto__` 等纯数据键）；missing 是逐项字符串行，允许空字符串。候选表单包括 fields 的 field/metric/weight、threshold 和 blocking 的 OR-of-AND 分组；metric 为 exact/edit/decimal/date，weight 与 threshold 为 1..10000。key、忽略列和 blocking 有显式编辑器。未映射列单列展示，不自动忽略。删改映射不会自动删除 key/candidate/blocking 引用；保留并定位失效引用，要求修正。

导入配置先由 check_config 校验，成功后表单以引擎规范化配置为唯一状态源；所有已知字段均可见并可编辑，未知字段由核心拒绝。校验通过给出类型、主键、忽略列、转换及候选概要，用户再启动。大型配置走原始资产上传与文件流下载，不因 1 MiB 编排限额失去现有 64 MiB 配置兼容性；界面字段列表分页，每页最多 50 个映射。UI 的编辑状态与已校验 config_asset_id 明确分离。

### 查看与复核

计算展示阶段和取消按钮，不编造百分比。汇总分别展示 computation、两侧 paired/unmatched/pending_review/unprocessed、equal/equivalent_by_rule/different/invalid_value、键/结构诊断与忽略列。数值均取 Result，不从 DOM 重算。

字段差异可按状态/逻辑字段/记录 ID 筛选、分页；详情保留 raw/transformed/canonical、rules、difference、tolerance、explanation。候选可按左右 ID/是否 suggested 筛选，展示所有竞争候选、field_scores 和 diagnostics。记录原值按格查看，显示截断标签与“完整值”按钮；禁止把截断文本当作业务输入。

四种动作 accept/reject/left_unmatched/right_unmatched 使用原 ID，reason 提供文本框；候选外 accept 必须 reason。精确配对只读。动作进入待应用区，可移除尚未应用动作，已有动作只读。点击应用时将已应用动作与新增动作按 action,left_id,right_id,reason 输出累计 CSV（用现有 renderCsv），交 resolve 整批校验。失败保留父版本、待应用动作和定位错误；成功产生新 revision，清空本批草稿。首版不撤销已应用动作，允许从原始比较显式创建新分支。

累计决定 CSV 可上传、校验并应用；模板空 action 行和已有动作按核心合同处理。子进程 resolve 成功后，宿主核对父 Result.decisions 中每个 action/left_id/right_id/reason 元组均存在于新 Result.decisions；缺失或变更为 noncumulative_decisions，不发布，防止回导文件意外删除已应用决定。这只是追加协议核对，决定解析和冲突仍由核心负责。导出决定可回导产生相同 report.json。对当前 revision 的乐观锁避免两次并发应用；决定绑定该分支，不带到新输入/规则。

### 导出和恢复

提供 report.json、summary.md、decisions.csv 与完整 ZIP。恢复 ZIP 验证结构、哈希、版本，然后以包内快照/config/累计决定调用 CLI 重放；只有重放报告与包内 report.json 字节一致才发布恢复 revision。恢复不信任 UI 缓存或自称完整的旧 report。不自动载入待应用动作；导出前提示还有未应用决定，包只包含已应用状态。

## 4. inspect_csv 精确协议

保留现有 `invoke(request_json : String) -> String` / JS `invoke_bridge(string) -> string`；所有失败沿用 `{ok:false,error:{code,message,phase,side,record,field}}`。

分页请求只有 `{op:"inspect_csv",csv:string,side:"left"|"right",offset:integer,limit:integer}`；offset>=0，limit=1..100。完整单格请求只有 `{op:"inspect_csv",csv:string,side:"left"|"right",cell:{record:integer,column:string}}`；record 是数据逻辑记录序号（1..row_count），column 是完整表头。cell 与 offset/limit 互斥，未知请求属性拒绝为 invalid_request。每次先调用现有完整 parse_csv，再返回预览；表头不截断。

分页成功：`{ok:true,preview:{side,headers:string[],row_count,column_count,offset,limit,rows:[{record,cells:[{column,value,utf8_bytes,truncated}]}],next_offset,has_more}}`。cells 按表头顺序，value 最多 256 码点，utf8_bytes 是未截断格的字节数。最多返回 limit 条完整行；在 UTF-8 JSON 总预算 2097152 字节内顺序添加行（先预算再生成大 JSON），next_offset=offset+rows.length，has_more=next_offset<row_count。offset>=row_count 时空 rows、next_offset=offset、has_more=false。预算不能容纳表头或一条完整预览行时返回 preview_limit_exceeded；不拆半行，不返回成功但零行且 has_more=true。UI 解释宿主显示限制并提供减少页数/CLI 指引。

单格成功：`{ok:true,cell:{side,record,column,value,utf8_bytes,truncated:false}}`，value 保留完整字符串（仍受原 64 KiB 格预算）。不存在的记录或列为 invalid_request，不把空字符串当不存在。page 和 cell 都不改变任何比较值。逻辑数据行含引号内换行时不误报物理行号。

## 5. 本机服务、注册表和任务协议

原生 Node HTTP + 原生 HTML/CSS/ESM；worker 子进程调用现有 `run(argv,runtime)` 与 bridge。子进程从服务器注册表取得内部路径，argv 是数组，shell=false；不解析 CLI 人类摘要获得结果，读取自己分配的 staging/run/report.json。静态前端无第三方 CDN/字体/分析。

会话仅一个，服务器生成 randomBytes(32) 会话令牌，ID 用 randomUUID。注册表记录资产、导入、job、revision，不接收磁盘路径/URL。公开 DTO 不包含文件路径、令牌或内容日志：

- Asset `{asset_id,kind:"csv"|"config"|"decisions"|"run",name,bytes,sha256}`；只有完整落盘和哈希完成才注册，kind=xlsx 首批 422 unsupported_format。
- Import `{import_id,asset_id,side,format:"csv",status:"ready",headers,row_count,column_count,sha256}`；失败只留 job.error，不注册半导入。
- Job `{job_id,kind:"import"|"preview"|"cell"|"draft"|"check"|"compare"|"review"|"restore"|"bundle",state:"running"|"cancelling"|"succeeded"|"failed"|"cancelled",phase:"reading"|"validating"|"comparing"|"resolving"|"packing"|"restoring"|"publishing",output:null|object,error:null|ErrorDTO}`。创建即 running，无排队；有活跃 job 时新任务 409 job_busy。终态不可变；失败/取消不带成功 output。
- Revision `{revision_id,parent_revision_id:null|string,baseline_revision_id,run_id,report_sha256,decisions_sha256,left_import_id,right_import_id,config_asset_id,exit_code:0|1|3}`；基线 baseline_revision_id 指自己。review 成功以父版本为 parent，但 resolve 从基线快照重放累计决定。每个基线分支保存 head_revision_id，review 只接受当前 head；旧版本仍可只读导出。
- ErrorDTO `{code,message,phase,side:null|"left"|"right"|"decisions",record:null|integer,field:null|string}`，保留核心稳定码；宿主错误不得冒充 computation incomplete。

工作台 HTTP v1：成功 `{ok:true,...}`；拒绝 `{ok:false,error:ErrorDTO}`。创建 job 返回 202 `{ok:true,job_id}`。状态错误 409，非法体/ID形状400，身份401，Host/Origin403，不存在404，角色字节限额413，不支持格式422；任务内错误通过 GET job 的 failed/error 表示。

| 路由 | 精确输入及输出 |
| --- | --- |
| GET /api/capabilities | `{ok:true,app_version,api_version,engine_version,formats:["csv"],limits}`；B 才加入 xlsx/profile |
| POST /api/assets?kind=csv\|config\|decisions\|run | application/octet-stream 原始正文；X-Filename 为 encodeURIComponent 的显示名，解码后<=255码点；不解析 multipart；返回 `{ok:true,asset:Asset}` |
| POST /api/imports | `{asset_id,side}`；job.output=`{import:Import,preview:Preview}`；第一预览offset0/limit20 |
| POST /api/imports/:id/preview | `{offset,limit}`；job.output=`{preview:Preview}`（同步 parser 只在 child） |
| POST /api/imports/:id/cell | `{record,column}`；job.output=`{cell:Cell}` |
| POST /api/config/draft | `{left_import_id,right_import_id}`；job.output=`{config_asset_id,draft:true}`，调用 init_config |
| POST /api/config/check | `{left_import_id,right_import_id,config}` 或 config_asset_id，二者恰有一个；job.output=`{config_asset_id,draft:false}`，调用 check_config |
| GET /api/configs/:asset_id/export | 仅 kind=config，下载原/规范配置文件流，最大64 MiB；不把文件流当分页JSON |
| POST /api/examples/:name | name=orders/migration/catalog/ourairports；同一job串行复用import/check处理；output=`{left_import_id,right_import_id,config_asset_id,source_label}`；无写死Result |
| POST /api/runs | `{left_import_id,right_import_id,config_asset_id}`；只接受已验证并绑定同对import的配置资产；job.output=`{revision:Revision}` |
| POST /api/runs/:id/reviews | `{base_revision,decisions_asset_id}`；base_revision须等于路由id及当前分支head；累计决定资产，不修改父run；job.output=`{revision:Revision}` |
| POST /api/runs/:id/branch | `{}`；从 baseline 比较结果建立新基线分支，清除已应用决定须显式UI确认；job.output=`{revision:Revision}` |
| GET /api/jobs/:id | `{ok:true,job:Job}`；不含内部路径 |
| DELETE /api/jobs/:id | running→cancelling，终态幂等；返回 job；最终取消以worker退出、staging清理后cancelled为准 |
| GET /api/runs/:id/summary | `{ok:true,revision,computation,summary}`（Result 中原对象） |
| GET /api/runs/:id/:collection?offset=0&limit=20 | collection=fields/candidates/records/issues/pairs/decisions；额外白名单filters：fields=status,field,left_id,right_id；candidates=left_id,right_id,suggested；records=side,status；其它无filter。返回 `{ok:true,items,total,offset,next_offset,has_more}`；顺序沿Result，过滤只选择，不重算 |
| GET /api/runs/:id/items/:collection/:index/export | collection同上、index是未过滤原数组0基下标；文件流下载完整JSON证据，绕开显示预算；分页items附`source_index`与原值DTO分开，不修改引擎对象 |
| POST /api/runs/:id/cell | `{side,record,column}`；调用该revision快照inspect_csv；job.output=`{cell:Cell}` |
| GET /api/runs/:id/export?kind=report\|summary\|decisions | 仅分别 report.json/summary.md/decisions.csv 文件流 |
| POST /api/runs/:id/bundle | `{}`；job.output=`{bundle_asset_id}`，child打包 |
| GET /api/bundles/:asset_id/export | 仅kind=run且服务器创建的完成bundle；ZIP文件流 |
| POST /api/restores | `{asset_id}`；只接受kind=run；job.output=`{revision:Revision}` |
| POST /api/sessions/reset | `{confirm:true}`；有活跃任务409，清理仅本会话owned workspace，重新生成注册表与workspace，令牌继续有效 |

JSON 编排 <=1048576 字节；普通 API JSON 响应 <=2097152 字节，分页 limit<=100、offset>=0。超预算自动少返回完整 item，若单 item 仍过大返回 response_limit_exceeded，并给原 source_index 的文件导出入口；summary 过大同样显式报错并引导下载report。下载文件流不受显示JSON预算，但受会话磁盘及角色限额。所有查询和body严格白名单，禁止未知属性、prototype污染和静态路径回退到磁盘目录。

## 6. localhost 安全、取消与资源

仅 listen(127.0.0.1,0)，不开放LAN/可配置host。Host必须精确`127.0.0.1:<实际端口>`；不采信Forwarded/X-Forwarded-*。启动URL为`http://127.0.0.1:<port>/#token=<32随机字节hex>`，UI读取后立即history.replaceState清除fragment，令牌只存在内存。所有 /api 请求（含GET）使用Authorization: Bearer；没有换取令牌接口。

所有POST/DELETE：若有Origin，必须精确等于本次http origin；无Origin仅允许有正确令牌的非浏览器调用（Sec-Fetch-Site存在且不是same-origin则拒绝）。GET也拒绝错误Origin/Sec-Fetch-Site；CORS不开放。仅静态白名单文件可匿名读取，静态页不可获得令牌。无token401；错误Host或跨站403；错误都no-store。

CSP：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`。另发X-Content-Type-Options:nosniff、Referrer-Policy:no-referrer。禁止内联脚本、eval、innerHTML拼接用户值、用户HTML和外链资源。API/报告Cache-Control:no-store。日志只记录job类别、状态和耗时，不记录正文、字段值、令牌或用户文件名。

默认OS临时目录创建workspace，目录0700，子进程umask077，文件0600。ownership标记含随机owner_id；清理前核对realpath、根目录、标记及注册的本服务路径，拒绝符号链接；从不覆盖/删除用户原件。正常退出清理本会话暂存并打印是否已有可恢复包；异常退出残留由启动说明指导清理，不能自动扫描删其它会话。

首版宿主保护：总会话磁盘1073741824字节（所有asset、runs、bundle、staging计入），最多64 assets、64 imports、32 revisions、256 jobs元数据；同时最多1上传和1 child job。上传60秒、job180秒；空闲会话30分钟仅提示，不自动删除用户工作。run ZIP原始<=256 MiB、实际解压总量<=1 GiB、entry<=32；独立宿主限额不保证最大核心输入吞吐。新任务先预留可计算输入/复制预算，worker每250ms检查实际owned目录字节，超限杀worker并删本任务staging；发布前再核对总字节；超限不能发布部分结果。

上传边读边计数，不相信Content-Length，超限/超时/断连取消并删除未注册文件。worker 使用fork(process.execPath对应的Node子进程入口)，独立IPC；每任务最多一个worker，所有同步engine和ZIP处理在worker。取消发SIGTERM，1000ms后仍存活则SIGKILL；父进程只在exit后清理staging，丢弃迟到message。取消、timeout、quota均无新revision，旧有效结果保留；主HTTP健康查询应可响应。服务器退出取消worker再清理owned workspace。

## 7. 报告包与恢复合同

A 的ZIP只含12个文件（不生成目录entry）：`workbench.json` 与 `run/manifest.json`、`run/input/left.csv`、`run/input/right.csv`、`run/config.json`、`run/report.json`、`run/pairs.csv`、`run/fields.csv`、`run/candidates.csv`、`run/decisions.csv`、`run/unresolved.csv`、`run/summary.md`。标准run的11文件不变。

workbench.json严格schema：`{schema_version:1,app_version:"0.2.0",engine_version:"0.1.0",revision:{revision_id,parent_revision_id,baseline_revision_id,run_id,report_sha256,decisions_sha256},files:[{path,bytes,sha256}]}`；files只列11个run文件，路径完全匹配白名单、每个恰一次；revision作为历史参考，恢复生成新的本机会话IDs，不信任旧parent去查磁盘。workbench.json<=1 MiB；bytes非负安全整数、sha256小写64hex。无待应用状态或本机路径（CLI provenance中已有路径视为run内容，不追加开发者路径）。

使用yazl3.3.1写包、yauzl3.4.0读包，先锁package-lock/integrity并实测探针；不手写ZIP。忽略压缩包声明大小不足以防守，流实际字节重复计数。拒绝未知/重复entry、目录entry、绝对路径、反斜杠、..、NUL、大小写/Unicode归一别名、符号链接/非普通文件、加密、损坏/截断流；不原样解压路径，只把匹配entry流写到服务器分配的文件名。哈希验证后还须CLI resolve重放包内累计决定，report.json字节比对；未复核包亦可用空action模板resolve。恢复失败整批不变。CSV的原始字节快照即追溯来源；B 才增加import/材料和独立profile，不能向manifest v1加字段。

## 8. B 的明确预留与探针门禁

首批capabilities只声明csv。导入注册表预留format与独立adapter字段，但不接受未实现ImportSpec；新增xlsx须更新严格HTTP schema与版本化profile。B评估yauzl+固定版本XML解析器受限OOXML读取；具体XML依赖版本、锁文件与安全配置须在B计划中实测，不把库文档当本地证明。

XLSX每侧只选择一张可见普通worksheet，不默认第一张。ImportSpec v1：sheet_id（绑定工作簿hash）、header_row、column_start、column_end、last_row、各列mode=stored_text/decimal_lexeme/excel_date/zero_padded_identifier、formula_policy="reject"。明确确认范围/列模式；不只信dimension。表头非空唯一文本，范围内空行保留，隐藏/筛选行包含并告警，范围外有值单元格计数展示。

shared/inline/rich文本保留文字与空白；空格为空字符串；数字<v>保留字面量，科学计数仅纯字符串有界展开，禁止先转Number/舍入。00123文本原样保留；数字123+00000仅显式zero_padded_identifier补零并存证。excel_date依据date1904，只支持整日，1900序列60和小数时间拒绝。布尔转TRUE/FALSE文本。公式（有/无缓存）、错误值、动态/共享公式、选区合并格、XLS/XLSB/XLSM、宏/ActiveX/OLE、外部数据关系、加密或非worksheet均拒绝并定位，不执行公式/外部链接。

包扩展为原run/+import/manifest.json+原left/right.xlsx；映射普通矩形可用header_row公式，非线性才row-map.json。导入清单存adapter/profile/schema、原件与规范CSV的bytes/hash、选项、worksheet关系/名称、行映射、告警和转换计数。原值栏写“导入后的原值”，可查看存储值→导入值依据；恢复重转CSV必须hash一致。

B守卫：压缩<=64 MiB、entries<=2048、实际解压<=256 MiB、单XML<=64 MiB、深度<=64、格<=64 KiB、实际行列沿核心限额；拒绝DTD/自定义实体、重复坐标、异常shared索引、恶意稀疏范围。真实Excel/LibreOffice保存的合成样本由Python zipfile+ElementTree独立oracle对照；包括前导零、长数字、指数、日期1900/1904、空白/Unicode/隐藏行，以及公式/合并/穿越/损坏ZIP/实体攻击。所有探针通过才合入真实XLSX入口；失败则先修正，不扩兼容承诺。

## 9. 运行包与验收

预编译包内带bridge ESM、cli/、workbench/、四组必要示例、固定生产依赖、package-lock、LICENSE/第三方许可证和START-HERE.md；node workbench/start.mjs一条命令启动，提示打开URL。不自动调用shell打开浏览器。无MoonBit、Python或npm安装的运行要求；开发Playwright不随生产包。打包时加载bridge路径显式注入，不能依赖开发_build路径。正常用户运行不用网络；安装构建属于开发阶段。

验收必须包含：空白表单构造orders规则、L3 left_unmatched、字段差异保留、累计回导、报告/ZIP保存恢复与CLI报告逐字节一致；catalog否决最高分L1/R2、accept L1/R1、right_unmatched R2；候选外手工对应reason、精确配对锁定、冲突整批拒绝；incomplete复核后仍退出3；畸形CSV/超限/取消/跨站/错误token与Host；长中文/HTML字符串安全显示、键盘和窄窗口；干净目录Node22离线包闭环。

证据表记录最终SHA、真实命令/退出码、用例、截图路径和未验证项。截图不能替代真实浏览器操作；本地测试不能冒充远端CI。邀请有权使用数据的真实用户完成样本，记录规模、原流程、阻塞和无法表达的规则；尚无用户时写“样例流程已验收，实际收益待验证”。若主要需求是拆合、复杂公式或关联，应重新界定用户合同。
