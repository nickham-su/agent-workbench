# 代码地图与候选改动面

> 行号基于方案调研时的当前代码，仅用于定位证据。实施时以符号搜索和最新代码为准。

## 核心生产文件

| 文件 | 当前关键职责 | 本阶段预期 |
|---|---|---|
| `apps/api/src/modules/agent/agent.composition.ts` | P4 composition root；先从 `AppContext` 派生窄 `AgentCompositionEnvironment`，再由 `createArchiveCompactionAssembly()`、`createLifecycleSessionSubtaskAssembly()`、`createReadQueryWritebackAssembly()` 分阶段创建 application/adapter，最后创建薄 facade、local runtime 最小 port、startup coordinator | 不存在持有完整 `AppContext` 的 composition/service class 或单一 giant capability bag；生产返回面仅含 facade、runtime port、coordinator；`testOnly` 仅暴露单个稳定 collaborator 引用，服务必要白盒 wiring/cache 断言 |
| `apps/api/src/modules/agent/agent.service.ts` | P5 清理后的 capability 注入薄 facade；所有保留 public 方法原样转发 | 不构造领域对象、不直连 Store/filesystem；不通过 giant class `Pick` 获得能力；不保存或暴露 `AppContext` |
| `apps/api/src/modules/agent/agent.routes.ts` | P3 顶层 route 聚合入口 | 仅注册 public、worker、peripheral、status/SSE 四类 route group |
| `apps/api/src/modules/agent/agent.module.ts` | P4 composition、runtime/process、routes、startup trigger | 仅 composition/process/trigger；不直接查询 Store；调用 startup coordinator |
| `apps/api/src/modules/agent/agent.store.ts` | 全域 DB helper 与原子 transaction | 本阶段不全拆；由命名 adapters 使用 |
| `apps/api/src/modules/agent/agent.runtime.ts` | local execution runtime | 已依赖 `LocalAgentRuntimeExecutionPort` 最小读/写/lifecycle/session-query 能力，行为不变 |
| `apps/api/src/modules/agent/agent.runtime-port.ts` | runtime enqueue/cancel/execution ports | 定义并承载 `LocalAgentRuntimeExecutionPort` 窄类型，不改语义 |
| `apps/api/src/modules/agent/archive/sqlite-archive-startup-session-query.ts` | P4 命名 SQLite archive startup session query adapter | 唯一由 adapter 调用既有 `listAgentSessionsForArchiveReconcile` Store helper |
| `apps/api/src/modules/agent/startup/agent-startup-coordinator.ts` | P4 startup 顺序协调器 | 仅协调 orphan/archive/run use-case 与 pre-listen/onListen 分界；不含 DB/Store/fs/path 或领域策略 |
| `apps/api/src/modules/agent/session/session-interaction-application.ts` | P1 Session list/create/public fork/send/revert 与窄 subtask materialization owner | 已实施；不得吸收 Lifecycle cancel、P2 Query 或 artifact I/O |
| `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts` | P1 命名 SQLite session/fork/revert persistence adapter | 已实施；保留 fork archive append/补偿与 Store 原子 helper 调用 |
| `apps/api/src/modules/agent/routes/agent-route-auth.ts` | P3 internal token/plugin caller transport 校验 | token 显式注入；不读取 `service.getContext()` |
| `apps/api/src/modules/agent/routes/agent-route-types.ts` | P3 分组最小 facade/transport capability 类型 | route group 不依赖 Store、`AppContext` 或 filesystem |
| `apps/api/src/modules/agent/routes/agent-public.routes.ts` | P3 UI/public routes | 保持 session、context、artifact、run-state 与 command transport 合同 |
| `apps/api/src/modules/agent/routes/agent-worker.routes.ts` | P3 Worker internal routes | Shared registry 端点继续使用 `AgentApiEndpoints` |
| `apps/api/src/modules/agent/routes/agent-peripheral.routes.ts` | P3 Peripheral internal routes | recent sessions/workspaces 仅透传 schema parse 结果；默认、kind fallback、clamp 归 `PeripheralAgentQueryApplication` |
| `apps/api/src/modules/agent/routes/agent-status-sse.routes.ts` | P3 status/tail/SSE routes；`status-summary`、`context-items-tail` 当前与 SSE 同文件 | 可接受的文件归组偏离：status/tail 仍归 `ContextQueryApplication`，transport guard、generic bridge 与 SSE lifecycle 均未漂移，无需改代码 |

## `AgentService` 关键符号

| 符号 | 当前位置 | 当前判断 | 目标 |
|---|---:|---|---|
| `listSessions()` | `agent.service.ts` | Session owner | 纯委派 Session application capability |
| `listRecentSessions()` | `agent.service.ts` | Peripheral query owner | 纯委派 `PeripheralAgentQueryApplication` capability |
| `getSession()` | `agent.service.ts` | 通用 query/Local runtime | facade 纯委派；local runtime 由 composition 提供更窄 execution port |
| `listRecentWorkspaces()` | `agent.service.ts` | Peripheral query owner | 纯委派 `PeripheralAgentQueryApplication` capability |
| `getWorkspace()` | `agent.service.ts` | route/内部兼容 | 当前为 capability 委派；后续按调用方条件评估 |
| `createPrimarySession()` | 1470 | Session owner | 委派 Session application |
| `forkPrimarySession()` | 1514 | Session/Fork owner | 委派 Session application |
| `resolveSubtaskSessionForStart()` 等 | 1530 起 | Subtask materialization wiring | 迁入窄 materializer/composition，不回退 0008 |
| `sendMessage()` | 1775 | Session command owner + lifecycle 调用 | 委派 Session application |
| `getContextItems()` | 1829 | Context Query owner | 委派 `ContextQueryApplication` |
| `compactSession()` | 1902 | 已委派 manual application | 保持纯 facade或 route最小 capability |
| `getContextItem()` | 1915 | Context Query owner | 委派 `ContextQueryApplication` |
| `get*UiArtifact()` | 1923/1933 | Context Query authorization owner | 委派 `ContextQueryApplication` |
| `getRunState()` | 1943 | Context Query projection owner | 委派 `ContextQueryApplication` |
| `getSessionStatusSummary()` | 2050 | Session/run projection owner | 委派 `ContextQueryApplication` |
| `revertSession()` | 2128 | Session owner，route补 runtime cancel | 迁入 Session application并包含 sequencing |
| `cancelSessionWithRuntime()` | Lifecycle facade | public cancel route 的运行时协作入口 | 保留；`RunLifecycleApplication` 仍为 cancel 领域 owner |
| startup methods | 2187 起 | Lifecycle facade | coordinator 依赖窄 startup capability |
| writeback/lifecycle/subtask methods | 2198 起 | 多为纯 facade | 保持薄委派或由 route capability 直接组装 |
| `getRunFinalText()` | 2290 | Peripheral query owner | 委派 `PeripheralAgentQueryApplication` |
| single-call profile | 2327 | Read-side 辅助 | 迁入 Read-side application或保持纯 facade |
| MCP/plugin/channel | 2360/2683 | Peripheral facade edge | 外围 adapter/薄 facade |

## Session 与 lifecycle 证据文件

| 文件 | 关键内容 |
|---|---|
| `lifecycle/run-lifecycle-application.ts:21-75` | startUserRun activation → run context → enqueue → failure settlement |
| `lifecycle/run-lifecycle-ports.ts` | StartUserRun、runtime、persistence 等能力类型 |
| `lifecycle/sqlite-run-lifecycle-persistence.ts:88-156` | user activation 单 SQLite transaction |
| `agent.store.ts:1487-1520` | `moveSessionHead` expected-head CAS、reachability、touch |
| `0008-Agent-Fork与Subtask深度语义重构/` | primary fork/subtask materialization/depth/lineage 权威语义 |
| `0007-E.../` | fork archive、fault seam、Archive 边界 |
| `agent.runtime.ts:33-40` | 本地 cancel 同步移除内存队列，无抛错路径 |
| `agent.worker-client.ts:148-159` | 远端 cancel 内部 catch 并 warning，不向调用方抛错 |

## P5 清理结论

已删除 `AgentService`/facade 的过渡入口：

- `getContext()`；
- `failRunOnEnqueueFailure()`；
- `cancelSession()`、`cancelSessionCascade()`；
- `getContextItemById()`；
- `getLatestTerminalAssistantTextByRunId()`、`getLatestCompletedAssistantTextByRunId()`。
- `reconcileArchivePendingForSessionBestEffort()`。

迁移证据：enqueue-failure、cancel-wins 与 recovery fence 测试改为直接调用 `SqliteRunLifecyclePersistence` 的原子 owner API；archive pending reconcile contract 测试改为直接调用 `ArchiveStorage.reconcilePendingBestEffort()`；其余同名 `agent.store.ts` helper 仍由合法内部 owner 或直接 persistence 测试使用，并非 facade 残留。

保留 `cancelSessionWithRuntime()`：它是 public cancel 对运行时 best-effort 协作入口。archive reconcile 的实际生产 owner 为 `ArchiveStorage`、`CompactionArchiveApplication` 和 startup coordinator；不再通过 `AgentService` facade 暴露。

## Context Query / Artifact 文件

| 文件 | 关键内容 |
|---|---|
| `query/context-query-application.ts` | P2 context list/item/tail、artifact visible-path authorization、run-state/status summary owner |
| `query/peripheral-agent-query-application.ts` | P2 recent sessions/workspaces、run final text、available agents owner |
| `query/context-query-ports.ts`、`query/peripheral-agent-query-ports.ts`、`query/sqlite-query-stores.ts` | P2 命名只读 query port、窄 Available Agent collaborator 与 SQLite adapter |
| `artifact/ui-artifact-capability.ts:11-76` | 固定 artifact port 与安全 I/O |
| `artifact/safe-file-io.ts` | no-follow、realpath 与目录安全 helper |
| `writeback/context-writeback-application.ts:143-217` | artifact split/write 时机与日志 |
| `agent.store.ts` transcript/window/run query helpers | Query persistence 候选 |
| `packages/shared/src/contracts/agent.ts` | public/status/recent schema |
| `agent.service.ts` | P4 capability-based facade；不再构造 P1/P2/lifecycle/subtask 等 application；`getSession()` 保持兼容转发 |
| `agent.routes.ts` | P3 纯聚合入口；各 group 继续通过最小 facade capability 调用既有 application owner |

## Route 端点与调用方

### Public

`routes/agent-public.routes.ts`：session list/create/fork、context/artifact/run-state、message/compact/clear/revert/cancel。

### Worker internal

`routes/agent-worker.routes.ts`：Subtask、Context Writeback、Run Lifecycle、Compaction、Read-side；Shared registry endpoints 继续引用 `AgentApiEndpoints`。

同组包含 archive search/read 与 single-call model profile。

### Peripheral internal

- `routes/agent-peripheral.routes.ts`：MCP/plugin tools、recent/workspace/final-text/agents 与外围 operational routes；
- recent/workspace/final-text/agents 的 owner 为 `PeripheralAgentQueryApplication`；
- status/tail 的 owner 为 `ContextQueryApplication`，其 transport route 位于 status/SSE 分组；
- create/trigger：目标 owner 为 `SessionInteractionApplication`；
- channel 与 Plugin/MCP 继续归外围 operational adapter；
- Feishu 调用证据：`plugins/feishu/src/index.ts:583-611,793,930-1076`。

### SSE

`routes/agent-status-sse.routes.ts` 保持 SSE transport 生命周期；event hub 实现在 `run-completed-events.ts`。

## Module / process / startup 文件

| 文件 | 关键内容 |
|---|---|
| `agent.composition.ts` | `createAgentCompositionEnvironment()` 只在 root 层绑定 `AppContext`；三个命名 assembly stage 分别装配 archive/compaction、lifecycle/session/subtask、read/query/writeback；四个 facade capability builder 按 Session/Query/Lifecycle/Worker owner 分组；`createAgentComposition()` 只输出 facade、local execution port、startup coordinator 与 `testOnly` 窄 collaborator 引用，不输出完整 capabilities、concrete wiring 或 dependency bag |
| `agent.module.ts` | 创建 event hub/composition，选择 local 或 remote runtime，维护 Plugin Host/Worker manager 生命周期，注册 route 与触发 startup；不 import `agent.store.ts` |
| `archive/archive-startup-reconcile-application.ts` | Archive startup use-case |
| `archive/sqlite-archive-startup-session-query.ts` | `ArchiveStartupSessionQuery` 的命名 SQLite adapter；封装 archive startup session listing Store helper |
| `startup/agent-startup-coordinator.ts` | `runPreListen()` 顺序执行 orphan cleanup、archive reconcile、fail mode run startup；recover mode 仅注册 `onListen` hook |
| `subtask/subtask-application.ts` | orphan cleanup use-case |
| `lifecycle/run-lifecycle-application.ts` | fail/recover startup use-case |
| `agent.worker-client.ts` / `agent.worker-manager.ts` | remote runtime/process |
| `agent.plugin-host-client.ts` / `agent.plugin-host-manager.ts` | peripheral process |
| `startup/agent-startup-coordinator.test.ts` | startup 顺序、cleanup/archive warning 隔离、recover 的 `onListen` 时机 |
| `subtask/subtask-wiring.test.ts` | lifecycle/subtask wiring 和 local runtime 最小 execution port 结构证据 |

## 现有关键测试

| 测试 | 覆盖 |
|---|---|
| `session-routes-module-p0-baseline.test.ts` | P0-P4：既有行为基线；P3 route structure 与 P4 facade/composition/module/startup/archive adapter import 方向护栏 |
| `agent.integration.test.ts` | public/internal routes、Context Query、Peripheral Agent Query、Artifact、SSE 等大范围行为 |
| `run-lifecycle-baseline.api.test.ts` | internal trigger 与 lifecycle 基线 |
| `agent.worker-client.test.ts` | remote enqueue/cancel response 校验、cancel best-effort warning |
| `startup/agent-startup-coordinator.test.ts` | P4 startup 顺序、warning 隔离、fail pre-listen 与 recover onListen 协调 |
| `subtask/subtask-wiring.test.ts` | lifecycle/subtask wiring 和 local runtime 最小 execution port |
| `run-lifecycle.persistence.test.ts` / `run-lifecycle.persistence.test.ts` | activation/cancel/failure persistence |
| `agent.service.facade.test.ts` | 现有 read-side/writeback facade 委派 |
| `context-item-contract.test.ts` | context/fork/archive/clear 等合同 |
| `writeback.api.test.ts` | API writeback |
| `artifact/*.test.ts`（按实际文件） | artifact safe I/O/wiring |
| `archive/*.test.ts` / `compaction/*.test.ts` | archive/compaction/fork 协作 |
| `subtask/*.test.ts` | subtask materialization/lineage/orphan/wiring |
| `agent.worker.integration.test.ts` | API↔Worker 主链 |
| `plugins/feishu` tests | Peripheral internal 调用兼容 |

### P0 已复核的既有集成证据

- `agent.integration.test.ts:1819`：SSE content-type 与 run-complete event chunk；
- `agent.integration.test.ts:7430,7508,7558`：revert running、non-terminal、idle successful rollback；
- `agent.integration.test.ts:7867-8113`：status summary projection、token、`HttpError` 型验证失败；
- `agent.integration.test.ts:8201-8309`：context tail 和 plugin header/body `pluginId` 鉴权顺序；
- `agent.integration.test.ts:9415,9766,9850,9971,10113,10333,10406`：artifact visible item、缺失、symlink safe I/O、apply_patch/write artifact；
- `read-side.api.test.ts:98-191`：internal read-side token/body/missing/workspace mismatch 合同。

P0 的 status-summary unexpected-error generic bridge 另由 `session-routes-module-p0-baseline.test.ts` 直接注入未知错误验证；避免只因正常集成路径未触发而遗漏 `500 SESSION_STATUS_SUMMARY_FAILED`。

## 已新增的阶段文件

名称可调整：

```text
apps/api/src/modules/agent/session/
  session-interaction-application.ts
  session-interaction-ports.ts
  sqlite-session-persistence.ts
  session-interaction-application.test.ts

apps/api/src/modules/agent/query/
  context-query-application.ts
  context-query-ports.ts
  sqlite-context-query.ts
  peripheral-agent-query-application.ts
  peripheral-agent-query-ports.ts
  available-agent-query.ts
  context-query-application.test.ts
  peripheral-agent-query-application.test.ts

apps/api/src/modules/agent/routes/
  agent-route-auth.ts
  agent-route-types.ts
  agent-public.routes.ts
  agent-worker.routes.ts
  agent-peripheral.routes.ts
  agent-status-sse.routes.ts

apps/api/src/modules/agent/startup/
  agent-startup-coordinator.ts
  agent-startup-coordinator.test.ts

apps/api/src/modules/agent/archive/
  sqlite-archive-startup-session-query.ts

apps/api/src/modules/agent/agent.composition.ts
```

## 跨域 import 验收

允许：

- `sqlite-*` adapter → `agent.store.ts`；
- application → 窄 port/types；
- route → application/facade capability；
- startup coordinator → startup capability。

必须清理：

- `agent.routes*` → Store/AppContext/filesystem；
- `agent.module.ts` → `agent.store.ts`：P4 已清理；
- `agent.service.ts` → Store/workspace Store/filesystem：P4 已清理；
- Context Query → Writeback；
- Context Query ↔ 完整 Peripheral Agent Query application；
- Peripheral Agent Query → 完整 Context Query application；
- Session application → Lifecycle concrete persistence；
- Peripheral route → core concrete private state。
