# 现状基线、业务逻辑与证据

## 调研结论总表

| 责任面 | 当前真实 owner | 主要问题 | 本阶段目标 owner |
|---|---|---|---|
| Session list/create/fork | `AgentService` 直接读写 Store | facade 仍是领域 owner | `SessionInteractionApplication` |
| send message | `AgentService` 前置规则 + `RunLifecycleApplication` activation/enqueue | owner 跨层但尚无显式 Session application | Session application 调 lifecycle capability |
| Context Query | `AgentService` 直接查询 Store、聚合 transcript/run/status | context list/item/tail、run-state、artifact、status 规则散在 facade | `ContextQueryApplication` |
| Peripheral Agent Query | `AgentService` 直接查询 recent/workspace/run/settings | recent sessions/workspaces、final text、available agents 无独立 owner | `PeripheralAgentQueryApplication` |
| Artifact read | `AgentService` 授权 + `UiArtifactCapability` I/O | read use-case 未显式归属 | Context Query + 共享 artifact capability |
| revert | `AgentService` DB 规则 + route runtime cancel | route 持有跨域 sequencing | Session application |
| cancel | `RunLifecycleApplication` | route 已较薄 | 继续归 Lifecycle |
| routes | 单体 `registerAgentRoutes` | 四类入口混排，个别 handler 有业务规则 | 分组注册函数 |
| startup | module 分别触发三个域 | module 直连 Store，顺序靠代码排列 | 无规则 startup coordinator |
| facade | 构造中心、真实 owner、兼容入口混合 | 完整 `AppContext` 泄露、Store 直连 | 薄兼容 facade |

## P0 实施补充：入口与方法清单（代码事实）

以下清单在 P0 实施时按 `agent.routes.ts` 和 `agent.service.ts` 的实际符号复核。它描述当前混排结构，不是 P1+ 已完成的目标结构。

### Route inventory

| 当前分组 | method / path 或注册表 | 鉴权与主要调用方 | 当前调用面 | 目标分组 |
|---|---|---|---|---|
| UI/public session | `GET/POST /api/agent/sessions`、`POST /api/agent/sessions/fork` | 无 internal token；Web | `listSessions`、`createPrimarySession`、`forkPrimarySession` | UI/public |
| UI/public context/query | `GET /api/agent/sessions/:sessionId/context-items`、`/:itemId`、artifact 两端点、`/run-state` | 无 internal token；Web | context/item/artifact/run-state query | UI/public |
| UI/public commands | `POST .../messages`、`/compact`、`/clear`、`/revert`、`/cancel` | 无 internal token；Web | Session、manual compact、clear、route revert cancel、Lifecycle cancel | UI/public |
| Worker/operational RPC | `POST /mcp-settings`、`/plugins/runtime-snapshots`、`/plugins/tools/list`、`/plugins/tools/execute`（均在 `/api/internal/agent`） | internal token；Worker/Plugin Host | MCP/plugin facade 与 Plugin Host transport bridge | Worker contract / operational |
| Peripheral internal | `/sessions/recent`、`/workspaces/list`、`/channels/allowlist/check`、`/sessions/create`、`/runs/trigger`、`/runs/:runId/final-text`、`/agents/list`（均在 `/api/internal/agent`） | internal token；Feishu 等插件 | recent/workspace/channel/session/run/agent 混合 | Peripheral internal |
| Status/SSE | `GET /events/sse`、`POST /sessions/status-summary`、`POST /sessions/context-items-tail`（均在 `/api/internal/agent`） | internal token；tail 另校验 header/body `pluginId` | event hub、status projection、context tail | Status/SSE |
| Archive/read-side internal | `POST /archive/search`、`/archive/read`、`/single-call-model-profile`（均在 `/api/internal/agent`） | internal token；Worker | Archive Read / Read-side facade | Worker contract |
| Shared Worker registry | `AgentApiEndpoints` 的 12 个 endpoint：subtask 4 个、context item create/update、run-state/complete、compact、prompt/messages/execution profile | internal token；agent-worker；method/path 由 Shared registry 定义 | Subtask、Writeback、Lifecycle、Compaction、Read-side | Worker contract |

显式字面量 URL 共 31 个，另有 12 个 `AgentApiEndpoints` 注册绑定。每项 route 都有 Fastify schema；P0 不改变 schema、auth、调用方或 HTTP 状态。

### `AgentService` public method inventory

| 当前 owner / 分类 | 方法（P0 观察到的 public surface） | P1+ 方向 |
|---|---|---|
| 完整上下文与 startup | `getContext`、archive reconcile、orphan cleanup、run recover/fail startup | 删除上下文泄露；startup 经窄 coordinator/capability |
| Session / Interaction 当前 owner | `listSessions`、`getSession`、`getWorkspace`、`createPrimarySession`、`forkPrimarySession`、`sendMessage`、`revertSession` | `SessionInteractionApplication`，facade 仅委派 |
| Context Query 当前 owner | `getContextItems`、`getContextItem`、两个 UI artifact read、`getRunState`、`getSessionStatusSummary`、全局 item/latest-text helpers | `ContextQueryApplication`；无生产调用 helper 仅在 P5 按证据删除 |
| Peripheral Query 当前 owner | `listRecentSessions`、`listRecentWorkspaces`、`getRunFinalText` | `PeripheralAgentQueryApplication` |
| 已委派/兼容 facade | compact、enqueue failure/cancel、worker writeback/run-state/complete、subtask、read-side、worker compact/clear/archive、MCP/plugin/channel helpers | 保持窄委派；仅在无调用且测试迁移后删除 compatibility helper |

其中 `sendMessage` 的 activation conflict 真实 code 为 `conflict_head:<currentHead>`，不是文档推测式常量；P0 测试以 `conflict_head:99` 冻结。

## `AgentService` 当前职责

### 已经是薄 facade 的能力

- Read-side：`getExecutionProfileForRun()`、`getMessagesContext()`、`getPromptContextForRun()` 委派 `ReadSideApplication`；见 `agent.service.ts:2303-2305,2661-2681`。
- Writeback：`appendContextItemFromWorker()`、`updateContextItemFromWorker()` 委派 `ContextWritebackApplication`；见 `agent.service.ts:2198-2204`。
- Lifecycle：worker run state/complete、cancel with runtime、startup recovery/fail 委派 `RunLifecycleApplication`；见 `agent.service.ts:2179-2213`。
- Subtask：prefork/start/result/status 委派 `SubtaskApplication`；见 `agent.service.ts:2250-2288`。
- Compaction/Archive：manual compact、worker compact/clear/reconcile、archive search/read 已委派对应 application；见 `agent.service.ts:1437-1439,1902-1907,2368-2380,2669-2677`。

### 仍是真正 owner 的能力

- Session list/get/create/fork：`agent.service.ts:1447-1773`；
- `sendMessage()`：`agent.service.ts:1775-1826`；
- Context pagination/item/artifact：`agent.service.ts:1829-1940`；
- run-state/status projection：`agent.service.ts:1943-2114`；
- revert：`agent.service.ts:2128-2169`；
- recent sessions/workspaces、run final text、single-call profile、available agent 相关查询；
- 多个既有 application 的构造和闭包 wiring：`agent.service.ts` 构造器区域。

### 完整上下文泄露

`AgentService.getContext()` 直接返回 `AppContext`（`agent.service.ts:1433-1435`）。当前 route 用它：

- `assertInternalToken()` 读取 internal token；
- `/api/internal/agent/agents/list` 读取 workspace enablement 与 settings。

这是本阶段必须删除的结构泄露。鉴权依赖应在 route 注册时注入窄 token/assertion；available-agent 查询必须迁入 `PeripheralAgentQueryApplication`。

## `sendMessage()` 当前完整业务链

```text
public messages / internal runs trigger route
  → AgentService.sendMessage
    → session exists
    → primary-only（subtask read-only）
    → workspace matches
    → trim text and reject empty
    → non-authoritative client-request dedup fast path
    → non-authoritative idle fast path
    → resolve user execution profile
    → RunLifecycleApplication.startUserRun
      → SqliteRunLifecyclePersistence.activateUserRun [single transaction]
      → WorkspaceRunContextReader
      → runtime.enqueueRun
      → enqueue failure settlement if current
```

### 必须保持的验证顺序

`agent.service.ts:1775-1809` 当前顺序是：session not found → subtask read-only → workspace mismatch → empty text → dedup → running → profile resolve。结构迁移不得无意改变先返回哪个错误。

### 非权威 fast path 与权威 transaction

- facade 当前在 transaction 前做 dedup/idle fast path，是为了保持用户可见验证顺序；
- `SqliteRunLifecyclePersistence.activateUserRun()` 在单 SQLite transaction 中再次检查 dedup 与 idle，并完成：append user item、首消息标题、dedup row、run record、run state；见 `lifecycle/sqlite-run-lifecycle-persistence.ts:88-156`；
- `RunLifecycleApplication.startUserRun()` commit 后读取 run context 并 enqueue；enqueue 失败后条件性收敛；见 `lifecycle/run-lifecycle-application.ts:21-75`。

本阶段只把 facade 前置部分迁入 Session application。不得让 Session application自行 append item、create run 或 update run state。

### 输入文本双语义

- `text` 传 trim 后文本，写入 user context item；
- `inputText` 传原始请求文本，进入 runtime enqueue。

这一区分必须保持，除非另立产品协议变更。

## Session/Fork 当前业务链

- `createPrimarySession()` 验证 workspace、生成 `sess` id、默认标题并创建 primary session；见 `agent.service.ts:1470-1511`。
- `forkPrimarySession()` 只允许 primary source，之后进入 context clone；见 `agent.service.ts:1514-1527`。
- clone 同时处理 public primary fork 和 internal subtask materialization；`0008` 已冻结二者的 kind、boundary、depth/lineage 语义。本阶段只能迁移现有规则和窄能力接口，不得重新合并其产品语义。
- `with_archive` fork 的 archive append、DB clone、失败补偿及 legacy fork-only fault seam 顺序已经由 `0007-E` 冻结，本阶段不得改动。

## Context Query 当前业务逻辑

### Transcript pagination

`getContextItems()`（`agent.service.ts:1829-1900`）支持：

- 全量 visible transcript；
- `afterId` window；
- `tailLimit` tail window；
- `beforeId + limit` before window；
- `expectedHeadItemId` 防止 head 回退后沿旧链分页；
- 三种分页模式互斥，冲突返回 `AGENT_CONTEXT_ITEMS_QUERY_INVALID`；
- head 回退返回 `409 AGENT_CONTEXT_ITEMS_HEAD_MOVED`；
- response 保持 `headItemId`、`appliedItemId` 和可选 `hasMoreBefore`。

### Item 与 Artifact read authorization

`getContextItem()` 不是按全局 item id 读取，而是先解析 session，再限定在当前 transcript path；随后 `getApplyPatchUiArtifact()` / `getWriteUiArtifact()` 校验：

- item kind 为 tool；
- output type 为 tool；
- toolName 匹配；
- `toolCallId` 非空；
- 最后调用 `UiArtifactCapability` 读取。

因此 artifact read authorization 必须属于 Query application，不能下放给只知道 `workspaceId + toolCallId` 的 filesystem capability。

### Run/status projection

`getRunState()`（`agent.service.ts:1943-2048`）聚合：

- durable run state；
- latest terminal run；
- active run 归属校验与 warning；
- execution profile 的 context window；
- elapsed 与 token ratio。

`getSessionStatusSummary()`（`agent.service.ts:2050-2114`）进一步组合 session、runState、selected agent display name。它是只读 projection，不应混入 Session command 或 Lifecycle mutation。

## Artifact 写侧与安全 I/O 基线

- Context Writeback 在 tool terminal update 时拆分 slim result 与完整 artifact，并调用 `UiArtifactCapability.writeApplyPatch/writeWrite`；失败只记录日志，随后 DB 保存 slim output；见 `writeback/context-writeback-application.ts:143-217`。
- `UiArtifactCapability` 是固定 apply_patch/write artifact 的窄能力，不是通用文件系统。它负责 tmp root containment、safe dir、realpath、no-follow read/write、regular-file 检查和 JSON 解析；见 `artifact/ui-artifact-capability.ts:11-76`。
- Query 不得依赖 Writeback；二者共同依赖 artifact capability port。

## Route 当前混排与业务泄漏

`agent.routes.ts` 当前单文件注册以下内容：

- public session/context/control；
- Shared Worker read/write/lifecycle/subtask/compaction routes；
- archive search/read 和 single-call profile；
- Plugin Host RPC、MCP settings、Channel allowlist；
- Feishu 使用的 recent/workspace/create/trigger/final-text/agents/status/tail；
- SSE。

明确的 route 业务泄漏：

- revert handler 在 `service.revertSession()` 后直接 `runtime.cancelSession()`；见 `agent.routes.ts:416-432`；
- agents/list handler 自行 trim/validate workspaceId、查 workspace、限制 surface、读取 workspace enablement、列出并排序 agents；见 `agent.routes.ts:825-853`；
- `getContext()` 使 route 可以任意读取完整 `AppContext`。

`handleCompactRequest()` 仅复用 public/internal transport handler，并调用已有 manual compact application，属于可接受的局部 transport 去重。

## Revert 后 runtime cancel 的当前观察语义

当前 revert route 在 DB head move 成功并取得结果后执行 `await runtime.cancelSession(sessionId)`；见 `agent.routes.ts:416-432`。两种生产 runtime 的行为均不会把 cancel failure 暴露给 HTTP 调用方：

- 本地 `AgentRuntime.cancelSession()` 只同步遍历并移除内存队列元素，没有异步 I/O 或显式抛错路径；见 `agent.runtime.ts:33-40`；
- 远端 `AgentWorkerClient.cancelSession()` 捕获 worker 请求错误，记录 warning 后正常返回；见 `agent.worker-client.ts:148-159`。

因此本阶段必须保持的观察到的语义是：

```text
revert DB commit
  → runtime cancel best-effort
  → cancel 底层失败不改变成功 revert 的 HTTP 成功语义
```

**P0 代码事实差异：**当前 route 本身没有 defensive catch。向测试注入一个会 reject 的通用 runtime 时，DB head 已提交，但 route 会把 rejection 暴露为 HTTP 500。当前成功 HTTP 语义仅由两种已有 runtime 的“不抛错/吞错”实现保证。

迁入 `SessionInteractionApplication` 后必须在 application 边界 defensive catch + warn。该 catch 是 P1 的既定目标，用于让未来 runtime 实现抛错时也保持成功 HTTP 语义；不得把它误写为 P0 已实现事实。

## Module 与 startup 基线

`agent.module.ts:19-125` 当前：

- 构造 event hub、ArchiveStorage、compaction persistence、AgentService；
- 根据配置构造 remote Worker client 或 local runtime；
- 启动/停止 Plugin Host；
- 注册全部 routes；
- 顺序触发 orphan cleanup、archive pending reconcile、run startup fail/recover；
- 启动/停止 Worker manager。

已知不变量：

- orphan cleanup 必须在 archive reconcile 前；已有 `subtask/subtask-wiring.test.ts:86-101` 结构测试；
- fail 模式在 listen 前做 DB 清理；recover 模式注册 `onListen` 后 enqueue；
- Plugin Host 当前在 routes 注册前启动；Worker manager 当前在 startup hook 设置后启动；
- module 直接 import `listAgentSessionsForArchiveReconcile`，属于本阶段应移入 archive startup query adapter 的 Store 泄漏。

## Store 直连残留

生产代码直接 import `agent.store.ts` 的主要位置：

- `agent.service.ts`：本阶段主要清理对象；
- `agent.module.ts`：本阶段必须清理；
- `lifecycle/sqlite-run-lifecycle-persistence.ts`、`subtask/sqlite-*`、`archive/sqlite-compaction-archive-persistence.ts`：命名 persistence/query adapter，合理保留。

验收原则是“route/module/facade 不直连 Store，职责域通过命名 adapter 使用”，不是机械地让整个目录零 import。
