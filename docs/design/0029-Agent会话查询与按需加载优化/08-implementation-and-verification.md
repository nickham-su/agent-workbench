# 实现与本地验证（含根级门禁补充）

## 交付状态与边界

两个核心阶段与三个既有测试断言修正均已通过阶段独立审查；最终独立全面代码复审已通过，H1/M1/M2/M3/L1/D5均已闭合（Resolved），无编码阻断。开发者执行的自动根门禁2278/2278、typecheck/build均通过；独立审查员另行执行的Web及定向验证单独记录，不与根测试计数累加。L2非阻断文档术语已修正，待原审查员最后确认。未部署、未真实浏览器人工验收，不等同批准上线。历史初次失败与2253条通过记录保留用于追踪，最新结论以文末“最终全面审查整改验证”为准。开发子任务没有执行Git、部署、迁移清理、用户数据访问或浏览器人工验收；父级的阶段暂存独立于这些操作。

## 实现范围与合理调整

### 后端与契约

- 列表只支持 `tabs` / `continuable` 判别式响应，没有无 scope 全量兼容分支。内部已有 `listSessions` 能力仍供内部用途，不对公开列表兜底。
- `tabs` 在同一 deferred SQLite transaction 中检查工作区、读取有效覆盖、读取可见 records。主会话默认可见、子任务默认隐藏，不截断默认主会话数量。
- `continuable` SQL 在 LIMIT 前筛选 primary、非 null head、JS trim 后非空且不为“新会话”；关闭的主会话仍能成为候选。默认 50、最大 100，取 limit+1，以 `updated_at DESC,id COLLATE BINARY DESC` keyset 翻页。
- 生产连接注册确定性 `agent_trim_title`；不使用 SQLite 默认 trim 近似 Unicode。来源共享 head 也可候选。
- 游标为严格 base64url UTF-8 JSON，版本/workspace/scope/limit/时间/ID 绑定，限制长度和字段集合。格式、绑定错误为 `AGENT_SESSION_CURSOR_INVALID`；不可合法生成游标的历史记录报 5xx，不截断 ID 或清理记录。游标不是权限，不签名；SQL 工作区过滤和既有鉴权仍独立执行。
- 无新生产索引、无破坏性 schema 迁移。遗留孤儿/跨 workspace/无意义覆盖只在读取时忽略，不删除。

### 前端

- `serverSessions` 保留变量名，但只表示当前已知完整 record 缓存；新增独立 `visibleServerSessionIds`。分页候选不写入 cache，不注册全历史状态轮询。
- 初始化改为一次 tabs GET。显式“重新核实会话标签”复用 snapshot 提交，不重置 ready UI、草稿或 PUT 队列，不作为错误自动兜底。
- snapshot 以返回 items 构造成员集合，并保护捕获时 pending、当前 pending、intentSeq/confirmationEpoch 已推进的本地目标。**只把实际 snapshot items 传入确认安装**，缓存缺失项不能重置已确认隐藏状态。未知有效覆盖建立最小 `{id,kind}`，不伪造完整 record。
- 提醒沿用旧 storage key；有效未知历史条目在持久化时合并保留，runtime entry 回收不等于删除历史。损坏条目逐项隔离，数组/非法时间不污染其余有效映射。
- 继续弹窗按打开加载首屏，支持更多、刷新、错误重试、非法 cursor 刷新首屏；页级序号、workspace generation、来源身份、AbortController 隔离迟到响应，旧 finally 不清新 loading，ID 去重。
- 候选标题仅是分页展示。阶段一目标 GET 完整证明、最多两次真实 GET/30 秒核实、另 30 秒可见性确认、取消补偿、真实 404 移除和独立失败重试身份不改退。
- 15 秒 timeout 只用于窄 metadata GET 和 Tab PUT；不改变全局 Axios、发送或 timeline 长请求。

### 清理与可维护性

- 删除 obsolete 全量刷新协调实现及其两份测试，删除全量 stale merge helper 和只覆盖该 helper 的旧用例；以 scoped query、snapshot 与真实组件竞态测试替代。
- 旧双 GET 模拟分支已移除，Tab GET 请求预算由实际请求观测计数，而非无人触达的 fixture 计数器。
- fixtures 抽到独立 `session-list-query.testkit.ts`，基准不导入 `.test.ts`，不意外启动 node:test。
- locale 增加明确 reload / refresh / more / cursor / failure 文案。保留后端既有 Tab 状态接口，但删除无人消费的前端 GET wrapper。

## 初次交付验证与实际命令（历史记录，最新根级通过结果见末尾）

命令在项目根执行，除明确标注 cwd 外。shared build 完成后才开始依赖它的验证。

| 命令 / 范围 | 实际结论 |
|---|---|
| `npm run build -w packages/shared` | 通过 |
| `npm run typecheck -w apps/api` / `npm run typecheck -w apps/web` | 通过 |
| `npm run test:unit -w apps/api` | 699 / 699（691 常规 + 8 repository-root） |
| `npm run test:integration -w apps/api` | 最终完整 API 命令中 269 / 269 |
| `npm test -w apps/api` | 987 / 987：unit 699、integration 269、worker integration 19 |
| `npm run test:session-title -w apps/api` | 23 / 23；最终 API integration 亦覆盖此文件 |
| parser + SQLite scoped query 定向 | 7 / 7；包含真实双连接 WAL 快照 |
| metadata integration 最新定向 | 7 / 7 |
| visibility / metadata / target / title helpers 定向 | 49 / 49 |
| ToolView 实组件最新定向 | 54 / 54 |
| `npm test -w apps/web` | 448 / 448（unit/helper 274，原组件 runner 合计 174，含 ToolView 54） |
| `npm run typecheck` | 通过（包含 shared、Worker、API、Feishu、Web） |
| `npm run build` | 通过；Vite 有大 chunk 警告，不属于本轮优化范围 |
| `npm test` | **未通过**：Worker compaction 契约断言失败，退出清理又遇到缺少 `ps`；未将此命令记为通过 |
| `npm test -w apps/agent-worker` | 本次重跑 678 / 680；两条失败详见处置 |
| `npx tsx --test apps/agent-worker/src/runtime/apiClient.test.ts` | 隔离定向重跑 37 / 39，仍为相同两条失败 |
| `npm test -w packages/shared` | 107 / 108；clean-build 通过，compaction 契约断言失败 |
| `npm test -w plugins/feishu` | 12 / 12 |

Web 计数不强行对齐阶段一的 456：删除 obsolete 全量协调/合并测试，同时新增真实 scoped、snapshot、分页、错误及生命周期覆盖，最终执行数为 448，没有 skip。高负载并发回归中的一次 Web 命令达到工具时间上限，随后独立完整重跑通过，以上采用最终完整结果。

组件定向命令（cwd `apps/web`）：

```bash
NODE_OPTIONS="${NODE_OPTIONS:-} --import=./scripts/component-test-dom.mjs" \
  npx vite-node --config vite.component-test.config.ts \
  src/features/workspace/tools/agent/AgentToolView.component.test.ts
```

后端定向命令（cwd `apps/api`）：

```bash
npx tsx --test src/modules/agent/read-side/session-list-query.test.ts \
  src/modules/agent/read-side/sqlite-session-list-query.test.ts
npx tsx --test src/modules/agent/integration/agent-session-metadata.integration.test.ts
```

重要覆盖：0/1/50/51/100/101/153 候选、limit 1/50/100 静态遍历、先过滤后 LIMIT、Unicode trim、同更新时间 Unicode ID 的 BINARY 排序、150 个默认可见 primary、真实两个 WAL 连接并发更改覆盖的一致性、生产 openDb 重开注册与旧 rows 保持、实际 HTTP 多页/绑定/伪造边界限制、错误不是空成功。组件覆盖分页单飞/去重/保留 cursor、刷新/关闭/workspace/来源创建隔离、401/timeout/partial protocol、snapshot 前在途 PUT 成功与失败保护、缓存缺失不重置 settled hidden、未知提醒保留及无全历史轮询。

## 合成性能证据

运行命令（cwd `apps/api`）：

```bash
npx tsx scripts/benchmark-agent-session-queries.ts
```

环境：Node v22.23.3，linux/x64，AMD Ryzen 7 5825U with Radeon Graphics。基准脚本另执行 `tsc --noEmit --strict --esModuleInterop --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck scripts/benchmark-agent-session-queries.ts` 独立类型检查，通过。仅内存 SQLite 合成数据，生产同形的既有 `(workspace_id,updated_at DESC)` 索引与 Tab 复合主键；非完整真实用户库或磁盘基准。每项预热 5 次后测量 40 次，时间包含同步 SQL/查询层读取，不包含 HTTP、JSON 序列化或网络传输。基线是全量 metadata SELECT；scoped 查询包含生产查询层事务与必要覆盖读取，因而不是仅比较 SQL SELECT 的理想化值。

- hidden90：一半 primary、一半 subtask，合计约 90% 隐藏；候选稀疏（约 5%），有效覆盖约 50%。
- allPrimaryVisible：全部 primary 默认可见；约 10% 候选，同更新时间每组 20 条。
- allPrimarySameTime：全部 primary 默认可见，所有 updatedAt 相同，约 10% 候选，覆盖排序临时表压力。
- deepPage：最多第 6 页；只有 100 候选时为第 2 页。没有 nextCursor 的小样本不测深页。

### 返回数与 UTF-8 JSON 字节

所有候选首屏最多 50 条；target 恒定单条。**JSON bytes 不是压缩后的 wire bytes，HTTP/网络压缩未测。**

| 会话数 | 分布 | tabs records | 覆盖 ID 数 | 全量数组 bytes | tabs bytes | 50 候选 bytes | target bytes |
|---|---|---|---|---|---|---|---|
| 1000 | hidden90 | 100 | 500 | 232001 | 33386 | 12181 | 241 |
| 1000 | allPrimaryVisible | 1000 | 0 | 232001 | 232108 | 12327 | 241 |
| 1000 | allPrimarySameTime | 1000 | 0 | 231201 | 231308 | 12276 | 241 |
| 10000 | hidden90 | 1000 | 5000 | 2329801 | 333886 | 12379 | 241 |
| 10000 | allPrimaryVisible | 10000 | 0 | 2329801 | 2329908 | 12379 | 241 |
| 10000 | allPrimarySameTime | 10000 | 0 | 2312001 | 2312108 | 12276 | 241 |

### 查询层耗时：中位数 / P95（ms）

| 会话数 | 分布 | 全量基线 | tabs | 候选首屏 | 较深页 | 单目标 |
|---|---|---|---|---|---|---|
| 1000 | hidden90 | 2.471 / 2.946 | 1.480 / 1.677 | 0.328 / 0.363 | 不适用 | 0.029 / 0.046 |
| 1000 | allPrimaryVisible | 2.568 / 2.793 | 2.917 / 3.839 | 0.316 / 0.382 | 0.333 / 0.419 | 0.027 / 0.036 |
| 1000 | allPrimarySameTime | 2.415 / 2.691 | 2.839 / 3.028 | 0.402 / 0.449 | 0.383 / 0.407 | 0.026 / 0.037 |
| 10000 | hidden90 | 24.330 / 27.518 | 13.735 / 14.896 | 0.763 / 0.816 | 0.360 / 0.403 | 0.029 / 0.036 |
| 10000 | allPrimaryVisible | 24.327 / 25.974 | 27.860 / 29.541 | 0.304 / 0.337 | 0.347 / 0.412 | 0.027 / 0.036 |
| 10000 | allPrimarySameTime | 23.918 / 25.783 | 27.798 / 29.594 | 2.078 / 2.253 | 2.069 / 2.146 | 0.027 / 0.030 |

结论：隐藏场景减少 metadata 数量及 payload，但仍需查询有效覆盖，不能承诺 tabs 常数成本；全部 primary 默认可见时完整恢复全部记录，payload 和耗时不保证下降。全部 updatedAt 同值会增加临时排序成本，不过本合成样本下候选页仍明显小于全量读取。单目标不会随总会话数扩大返回量。当前证据不要求新增生产索引；真实部署容量及磁盘/网络证据仍需上线前评估。

### EXPLAIN QUERY PLAN

基准脚本输出完整 plans；以下为 10,000 条隐藏分布对应访问模式：

```text
tabs:
  SEARCH s USING INDEX idx_agent_session_workspace_updated (workspace_id=?)
  CORRELATED SCALAR SUBQUERY 1
  SEARCH t USING INDEX sqlite_autoindex_workspace_session_tab_state_1 (workspace_id=? AND session_id=?)
  CORRELATED SCALAR SUBQUERY 2
  SEARCH t USING INDEX sqlite_autoindex_workspace_session_tab_state_1 (workspace_id=? AND session_id=?)
  USE TEMP B-TREE FOR LAST TERM OF ORDER BY
continuable:
  SEARCH s USING INDEX idx_agent_session_workspace_updated (workspace_id=?)
  USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

补充基线、目标及较深页计划（同一合成样本）：

```text
fullList:
  SEARCH s USING INDEX idx_agent_session_workspace_updated (workspace_id=?)
target:
  SEARCH agent_session USING INDEX sqlite_autoindex_agent_session_1 (id=?)
deepPage:
  SEARCH s USING INDEX idx_agent_session_workspace_updated (workspace_id=?)
  USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

既有索引不能完全覆盖 BINARY ID 并列排序，计划存在临时 B-tree；本轮没有隐藏该事实或擅自新增索引。

## 历史根级失败与当前处置

| 编号 | 决策 | 事实与原因 |
|---|---|---|
| EXT-COMPACTION-LOCALE | Fix / 已闭合 | 父级核实失败涉及的生产 schema、测试和 Worker 客户端在本次优化之前未改动。合法 `uiLocale` 用于压缩提示词选择，不能删除；补充修复正例覆盖 null、zh-CN、en-US，将 shared 与 Worker 非法样本改为 fr-FR，保留 schema 拒绝断言。 |
| EXT-WORKER-11MS | Fix / 已闭合 | 原测试要求真实 HTTP 在 11 ms 内先返回 503，超时结果却完全符合生产预算。只将该测试改为受控 fetch 与 Node 虚拟计时器：10 ms 未取消、11 ms 取消，实际客户端返回预算为 11 ms 的 InternalRpcTimeoutError，只调用一次 transport。未改生产 RPC 策略。 |
| ENV-PS | WontFix / 接受环境限制 | 历史根 runner 失败退出清理遇到 `spawn ps ENOENT`，外部中断同样可能依赖 ps。不安装系统依赖、不修改 runner；修复测试后根命令正常完整退出 0，无失败清理。此结果不表示缺失 ps 的环境依赖已解决。 |
| MANUAL-RELEASE | 待验收 | 未部署、未访问真实用户数据、未进行浏览器人工验收与真实网络测量，交由父级/用户完成。 |

阶段二范围内发现的 snapshot 缺失项重置 confirmed、损坏提醒条目传播、旧双 GET fixtures 等已修复并回归。两个核心阶段已通过审查，根级自动验证现已通过；最终全面审查与实际 RELEASE 仍不能由本地命令结果代替。


## 阶段二独立审查修复：M1 / L1

### 处置与变更范围

- **M1：Fix**。复现空 tabs snapshot 设置 ready 后、外部 target GET 尚在途时提前创建草稿；补齐较新意图、确认终态与回退收敛。先追加实组件复现，未修实现下 70 条中 14 条失败（其中首次空 snapshot 场景明确观察到 draft=1，应为 0）；没有通过删除或跳过测试规避。
- **L1：Fix**。上方 shared 失败引用已精确改为 `packages/shared/tests/agent-api-read.test.ts`。
- 本次仅修改 `AgentToolView.vue`、`AgentToolView.component.test.ts`、`04-client-state-and-concurrency.md`、本文件。未改 SQL/cache/pagination/controller、shared/Worker 代码或根级失败处置规则，未执行 Git。

### 统一零可见回退策略

`ensureVisibleSessionFallback(context,intent)` 是所有自动草稿回退的唯一策略，初始化/reload/KeepAlive/关闭最后 Tab/目标终态均复用。用户显式新增草稿入口仍直接创建，业务不变。

1. 必须 initialization ready、当前 workspace context 有效、intent 仍为当前代次，且当前真实零可见、未在创建。
2. `openSessionRequest` 有目标且 sequence 尚未被外部 watcher 消费时就是有效待派发打开意图；ready 与 watcher 派发之间不创建草稿。
3. `targetOpeningSessionId` 延续至可见性 receipt 终态，不在 GET 成功时提前清理；失败/终止后由携带 context/intent 的当前 finally 核查回退。旧 finally 不清较新 opening，也不对新 workspace 创建草稿。
4. 观察已有意图/可见性状态变化并再次调用同一 helper，不增加游离 skip bool。取消后、UI 超时但真实 PUT 迟到失败后仍能收敛。UI 超时不清实际 inFlight、不伪造隐藏；仍有效可见则不多造草稿。
5. 有 origin 或其他有效可见 Tab 时不创建草稿；网络/401/404/5xx/timeout 等真终态后若确实零可见，只创建一个可见本地草稿，不 POST 新建后端 Session。

### 实组件验收矩阵

| 实际用例 | 判定结果 |
|---|---|
| 空 snapshot + 有效待派发请求/在途 GET | draft=0，ready 后只发一个 target GET |
| GET 已接受、visibility 未 confirmed | opening 仍为 target，draft=0；confirmed 后只显示 target |
| 空 workspace GET network/401/404/500/timeout | 当前终态后 draft=1、可见且 active，不留空、不 POST |
| network/401 且 origin 可见 | 保留 origin active，draft=0 |
| GET 成功、visibility 失败 | 未确认时 draft=0；真实失败后仅一个草稿 |
| 较新意图 supersede 旧 GET / 旧 PUT | 旧终态不回退；较新成功 draft=0，较新失败才 draft=1 |
| 切 workspace + 旧 GET 终态 | B 的当前意图仍在途时 draft=0；B 自己的成功/失败独立收敛 |
| reload 空 snapshot + target 在途 | 不提前回退；目标成功为唯一 target，目标失败仅一个草稿 |
| 当前打开取消/终止 | 收敛一个草稿；迟到旧 GET 不再创建 |
| KeepAlive 在 GET / visibility 待确认时重激活 | 不造草稿、不增加 GET；确认失败后一个草稿，再激活不重复创建 |
| visibility UI 超时 + 迟到真实 PUT 失败 | UI 超时不清 inFlight、不假装隐藏；真实失败零可见后收敛一个草稿 |

### 本次验证

- ToolView 实组件定向：**72 / 72 通过**（保留原 54 条，新增 18 条）。命令沿用上方 `vite-node` + DOM import。
- `npm run typecheck -w apps/web`：**通过**。
- `npm test -w apps/web`：**466 / 466 通过**（unit/helper 274、组件 runner 合计 192，ToolView 72；新增 18 条，无 skip）。
- 本阶段二修复轮未改 shared/Worker 失败用例，计数保留为当时事实。随后父级完成调查并批准窄测试修正，最新根级通过结果见末尾补充验证。

## 文件交付清单

### 新增（7）

```text
apps/api/src/infra/db/agent-query-functions.ts
apps/api/src/modules/agent/read-side/session-list-query.ts
apps/api/src/modules/agent/read-side/session-list-query.test.ts
apps/api/src/modules/agent/read-side/sqlite-session-list-query.test.ts
apps/api/src/modules/agent/read-side/session-list-query.testkit.ts
apps/api/scripts/benchmark-agent-session-queries.ts
docs/design/0029-Agent会话查询与按需加载优化/08-implementation-and-verification.md
```

### 修改（24）

```text
packages/shared/src/contracts/agent.ts
apps/api/src/infra/db/db.ts
apps/api/src/modules/agent/read-side/sqlite-session-query.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/routes/agent-route-types.ts
apps/api/src/modules/agent/routes/agent-public.routes.ts
apps/api/src/modules/agent/integration/agent-session-metadata.integration.test.ts
apps/api/src/modules/agent/integration/agent-session-title.integration.test.ts
apps/web/src/shared/api/api.ts
apps/web/src/shared/i18n/locales/en-US.ts
apps/web/src/shared/i18n/locales/zh-CN.ts
apps/web/src/features/workspace/tools/agent/agentSessionTargetLoader.ts
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.test.ts
apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts
apps/web/src/features/workspace/tools/agent/agentSessionTitle.ts
apps/web/src/features/workspace/tools/agent/agentSessionTitle.test.ts
docs/design/0029-Agent会话查询与按需加载优化/README.md
docs/design/0029-Agent会话查询与按需加载优化/04-client-state-and-concurrency.md
docs/design/0029-Agent会话查询与按需加载优化/06-code-reference.md
docs/design/0029-Agent会话查询与按需加载优化/07-implementation-plan.md
```

### 删除（3）

```text
apps/web/src/features/workspace/tools/agent/agentSessionRefreshCoordination.ts
apps/web/src/features/workspace/tools/agent/agentSessionRefreshCoordination.test.ts
apps/web/src/features/workspace/tools/agent/agentSessionRefreshTimeline.test.ts
```

此清单是本阶段操作范围记录，不是 Git 状态输出（本轮禁止且未执行 Git）。父级仍须独立核对差异与未知变更。临时日志与性能原始 JSON 在证据录入本文件后清理，仅删除本会话明确创建的文件。

## 根级门禁补充验证（最新结果）

### 修复边界与决策理由

父级只授权本轮修改以下三个文件，未修改生产实现或其他文档：

```text
packages/shared/tests/agent-api-read.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
docs/design/0029-Agent会话查询与按需加载优化/08-implementation-and-verification.md
```

- shared 契约测试保留固定请求、未知字段及消息图字段拒绝断言，新增合法 locale 三值正例；非法 locale 样本改为 `fr-FR`。
- Worker compaction source 测试经真实 HTTP 与实际客户端校验 `null`、`zh-CN`、`en-US` 响应，仍验证固定 endpoint/method/body；`fr-FR` 响应必须产生 `InternalRpcInvalidResponseError` 且 `stage === 'schema'`。
- 只有 `terminal-control 单次 timeout 不得超过内部 RPC 配置` 用例使用测试上下文管理的 `t.mock.method(globalThis,'fetch',...)` 与 `t.mock.timers`。实际 `AgentApiClient` 配置 11 ms、调用请求 99 ms；虚拟时钟推进 10 ms 时 signal 尚未 abort，再推进 1 ms 必须 abort，最终严格为含 `timeoutMs=11` 的 `InternalRpcTimeoutError`。断言 transport 仅一次且日志包含 `policy=terminalControl`、`timeoutMs=11`；不接受“HTTP 或 timeout 任意结果均通过”。mock 随测试上下文恢复，未增加生产 transport/clock 注入参数；其他真实 HTTP 错误分类用例保持不变。
- 测试数量不因上述循环正例或确定性替换增加；没有删除失败用例、跳过测试或放松响应契约。Node MockTimers 实验性警告不是测试失败，也未关闭该警告。

### 命令与实际结果

均在项目根执行，定向 shared 命令另标 cwd。先完成 shared build，再运行依赖 shared 的测试；根级三个命令依次执行，未同时重建 dist。

| 命令 | 实际结果 | 退出码 |
|---|---|---|
| `npm run build -w packages/shared` | 通过 | 0 |
| `npx tsx --test tests/agent-api-read.test.ts`（cwd `packages/shared`） | 1 / 1 | 0 |
| `env -u AWB_TOOL_ERROR_STORE_ENABLED npx tsx --test --test-name-pattern='terminal-control 单次 timeout 不得超过内部 RPC 配置\|Compaction source uses its fixed read endpoint' apps/agent-worker/src/runtime/apiClient.test.ts` | 2 / 2 | 0 |
| `npm test -w packages/shared` | 108 / 108，clean-build 亦通过 | 0 |
| `npm test -w apps/agent-worker` | 680 / 680 | 0 |
| `npm run typecheck` | shared build、Worker/API/Feishu/Web 类型检查完整通过 | 0 |
| `npm test` | 5 个 workspace 完整完成，合计 2253 / 2253 | 0 |
| `npm run build` | shared、Worker、API、Feishu、Web 完整构建通过 | 0 |

根级 `npm test` 按各进程 TAP 汇总验证，不以定向测试或提前终止结果代替：

| workspace | tests / pass | fail / cancelled / skipped |
|---|---:|---:|
| API | 987 / 987（691 常规 unit + 8 repository-root + 269 integration + 19 worker integration） | 0 / 0 / 0 |
| Worker | 680 / 680 | 0 / 0 / 0 |
| Web | 466 / 466（274 unit/helper + 192 组件，含 ToolView 72） | 0 / 0 / 0 |
| shared | 108 / 108 | 0 / 0 / 0 |
| Feishu | 12 / 12 | 0 / 0 / 0 |
| 合计 | **2253 / 2253** | **0 / 0 / 0** |

### 仍不由本地测试证明的事项

- 该阶段记录生成时，两阶段核心代码及补充修复尚待最终独立全面审查；现已通过最终独立全面代码复审，详见文末。该结论来自独立审查，不由本地测试单独证明，也不代表部署完成。
- 未执行真实浏览器人工验收、停机、部署、真实用户数据库操作或网络传输测量；上方合成 SQLite 性能证据原样保留，不转换为真实网络收益承诺。
- 最终 Vite 构建仍提示超过 500 kB 的 chunk，此为既有构建告警，不在本次窄测试修复中扩大范围。
- 环境仍无 `ps`；根命令全成功时没有触发失败清理，不能据此宣称 runner 外部中断/失败清理的环境依赖已解决。未改 runner、node_modules 或安装系统依赖。
- 本轮创建的五份临时日志在完成计数核对和本记录录入后删除，不删除用户或其他会话文件。


## 最终全面审查整改验证（最终独立全面代码复审已通过）

### 已落实整改

- H1：真实KeepAlive隐藏结束picker交互代次，关闭modal并清页/选择/失败retry身份；原同workspace最后intent补偿仍走旧队列，但隐藏时取消补偿UI订阅，late响应不替换草稿、不激活、不告警，正常activate不重读tabs。
- M1：取消补偿使用独立30秒receipt。选择与补偿共享对象提示归属；确认期限或补偿失败明确提示打开可能已提交、恢复隐藏未确认，且同操作一次提示。新Tab意图、新打开意图、工具代次或workspace失效时旧补偿静默。真实PUT不因UI结算被清除。
- M2：展示和编号共同使用isSessionTabVisible；后台缓存Fork、snapshot排除及unavailable记录不占号，已有可见号保留、尾部号复用，不恢复全量剪枝。
- M3：run-state/settings读取捕获workspaceGeneration；run-state同时捕获entry对象身份。成功/失败/finally均检查当前性，音频Promise失败回调亦隔离；正常后台通知和unknown历史提醒仍保留。
- L1：删除无用operationId；controller.invalidateContext收口清subscriptions/sessions/writeStates并推进内部epoch，不用于同workspace初始化重试或deactivation。
- D5：README/07同步核心阶段、根测试和最终独立审查的不同状态，不再把旧根失败当作当前门禁。

### 本轮文件范围

修改ToolView及其组件测试、TabVisibilityState及其测试、StatusStore、双语locale、固定组件runner；新增独立StatusStore组件测试。文档仅同步本目录README、04、05、06、07和本记录。未改后端、公开契约、Worker生产策略、schema/索引或真实业务数据。

### 开发者执行的验证命令与结果

以下命令在全部产品整改与新增测试完成后实际执行。shared先完成构建；Web全量、root typecheck、root test、root build顺序执行，避免shared dist重建与依赖测试并发。各命令退出码均为0。

| 命令/范围 | 实际结果 |
|---|---:|
| `npm run build -w packages/shared` | 通过 |
| ToolView实组件定向 | 87/87 |
| TabVisibilityState定向 | 20/20 |
| 独立StatusStore组件定向 | 9/9 |
| `npm run typecheck -w apps/web` | 通过 |
| `npm test -w apps/web` | 491/491，无skip/cancel/fail |
| `npm run typecheck` | 根级全部workspace通过 |
| `npm test` | 2278/2278，全部workspace退出0 |
| `npm run build` | 根级全部workspace通过 |

根命令实际分项：API 987（691常规unit＋8 repository-root＋269 integration＋19 Worker integration）；Worker 680；Web 491；shared 108；Feishu 12。合计2278，fail/cancelled/skipped均0。Web包含新增25条有效测试：ToolView增加15条、独立StatusStore增加9条、controller增加1条；没有跳过既有用例来降低计数。

本轮代码变化仅前端与测试/文档，后端和合成性能脚本未变；先前性能数据继续作为已复现的合成基准，不宣称本轮重新测过网络或真实用户库。MockTimers实验性告警和Vite大chunk告警不导致门禁失败；环境仍缺ps，没有安装依赖或修改runner，正常全绿未触发失败清理。实际部署、浏览器人工验收及真实历史库审计仍未执行。

本轮7份临时测试日志在记录结果后清理。以上是开发者执行记录；最终独立复审结论与审查员另行执行的验证见下节，不能从根自动门禁结果单独推导。

### 最终独立全面代码复审与L2文档修正

据原审查员最终独立全面复审结果，H1/M1/M2/M3/L1/D5全部Resolved（已闭合），无编码阻断。最终独立全面代码复审已通过；审查员独立执行记录如下：

| 独立审查执行范围 | 结果 |
|---|---:|
| Web全量 | 491/491 |
| API定向 | 16/16 |
| ToolView组件定向 | 87/87 |
| StatusStore组件定向 | 9/9 |
| helpers定向 | 52/52 |
| 类型检查（typechecks） | 通过 |

该表与上节开发者根级执行记录属于不同执行主体和范围；Web全量与其定向测试也存在覆盖重叠，不累加为新的测试总数。自动根门禁仍为开发者实际执行的2278/2278，root typecheck/build通过，不宣称审查员重跑了根级测试或构建。

L2仅为非阻断文档残留：04的补偿提示去重规则已统一为“提示与onMutationError按取消操作的共享对象身份去重”，与实现一致。本次只修正文档并同步README/07/本记录，未改产品代码、未执行Git；不重复根测试，另行核查文档导航与引用。L2文档修正待原审查员最后确认，不重开已通过的全面代码复审。

未部署、未真实浏览器人工验收，最终代码复审和自动门禁通过不等同批准上线；真实用户库及实际网络测量的未执行边界不变。
