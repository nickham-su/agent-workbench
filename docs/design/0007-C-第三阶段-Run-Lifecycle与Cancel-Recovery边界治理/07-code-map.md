# 当前代码地图

> 本地图基于方案起草时只读调研，已由 P0/P1 复核行为和测试入口，并已在 P2 记录实际 Lifecycle 骨架路径；后续 use-case 落点仍以各批实现为准。

## 上位文档与阶段

```text
docs/design/0005-Worker-API读侧与生命周期治理/
docs/design/0006-Agent模块结构治理总方案/
docs/design/0007-A-第一阶段-基线与Read-side-Prompt结构治理/
docs/design/0007-B-第二阶段-Context-Writeback与Artifact边界治理/
```

已完成提交：

```text
0f57bfe feat(agent): implement phase 1 read-side governance
04499bb feat(agent): implement phase 2 context writeback governance
```

## Shared contracts

### API internal contracts

```text
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/src/internal-contracts/agent-api-run.ts
```

P0 已精确索引的关键 endpoint/schemas：

```text
AgentApiEndpoints.updateRunState
AgentApiEndpoints.completeRun
AgentApiRunStateRequestSchema
AgentApiRunCompleteRequestSchema
AgentApiRunStateResponseSchema
AgentApiRunCompleteResponseSchema
```

### Worker contracts

```text
packages/shared/src/internal-contracts/endpoints.ts
```

关键：

```text
AgentWorkerEndpoints.enqueueRun
AgentWorkerEndpoints.cancelSession
AgentWorkerEnqueueRequest/Response
AgentWorkerCancelSessionRequest/Response
```

本阶段默认只读。任何 method/path/schema/export 修改触发停止。

### Shared tests

```text
packages/shared/tests/internal-contracts.test.ts
```

## API Route

```text
apps/api/src/modules/agent/agent.routes.ts
```

### Public message

```text
POST /api/agent/sessions/:sessionId/messages
```

当前关键行为：

- Route 仅调用 `service.sendMessage({ sessionId, body, runtime })` 并发送 `201`；
- `AgentService` 将规范 command 与一次性 runtime 委派给 `RunLifecycleApplication.startUserRun()`；
- Lifecycle 完成 authoritative activation、workspace context、enqueue 与 conditional failure settlement；
- enqueue 异常保持现有 route-level failure 外观；目标 run 条件收敛为 failed，matching active run-state 收敛为 idle。

Route 不读取 `service.getContext()`、不直接 `enqueueRun()`、不自行处理 failure settlement。

### Internal trigger

```text
POST /api/internal/agent/runs/trigger
```

当前关键行为：

- 保留 internal token/auth；
- 与 Public message 共用 `service.sendMessage({ ..., runtime })` / `startUserRun()`；
- Route 不直接 enqueue 或 failure settlement；
- P3 真实 Route 证据确认 enqueue failure、failed/idle settlement 与 dedup retry 行为一致。

### Compact

```text
POST /api/agent/sessions/:sessionId/compact
POST /api/internal/agent/sessions/:sessionId/compact
```

有意差异：`handleCompactRequest()` 仍在 Route 中读取 workspace context、直接 enqueue，并在失败时调用 `service.failRunOnEnqueueFailure()`。

该 facade 已薄委派给 Lifecycle 的 conditional failure capability；但 compact 的 run 创建、context/queue 调度与 response 语义未迁移，仍留待其后续领域批次，不能误写为 P3 Public/internal send 的第二权威实现。

### Cancel

```text
POST /api/agent/sessions/:sessionId/cancel
```

当前：

```text
Route → service.cancelSessionWithRuntime()
  → RunLifecycleApplication.cancelSession()
  → SqliteRunLifecyclePersistence.cancelSessions()
      → 同一 SQLite transaction 内按 durable lineage 遍历 root/current-active-child
      → 同一 transaction 内收敛 item/run/run-state，并返回 runtime targets
  → runtime.cancelSession() allSettled / warning-only
```

Route 不再拼装 DB 与 runtime cancel 时序；runtime failure 不回滚 DB。

### Worker state/complete

```text
AgentApiEndpoints.updateRunState
AgentApiEndpoints.completeRun
```

当前 Route 调用：

```text
service.updateRunStateFromWorker(body)
service.completeRunFromWorker(body)
```

Route 保持 Shared schema/auth/response；Service 方法均薄委派 `RunLifecycleApplication`。

## AgentService

```text
apps/api/src/modules/agent/agent.service.ts
```

### Send/activation

```text
sendMessage()
failRunOnEnqueueFailure()
```

`sendMessage()` 当前混合：

- session/workspace/subtask/text；
- 非权威 dedup/idle 快路径与 profile 解析；
- 向 `RunLifecycleApplication.startUserRun()` 传递规范 command 与一次性 runtime；
- 透传 response/error。

`failRunOnEnqueueFailure()` 当前混合：

- 兼容 compact 等未迁移入口；
- 薄委派 `RunLifecycleApplication.failRunAfterEnqueueFailure()`。

P3 的 atomic activation、workspace run context、enqueue 与 conditional failure settlement 已不在 Service/Route 重复实现。

### Cancel

```text
cancelSession()
cancelSessionCascade()
cancelSessionWithRuntime()
```

P4 后均为 Lifecycle facade；SQLite transaction 由 `lifecycle/sqlite-run-lifecycle-persistence.ts` 的命名 capability 承担。

### Worker lifecycle writeback

```text
updateRunStateFromWorker()
completeRunFromWorker()
```

P4 后均委派 Lifecycle；有效 complete 的 prompt static cache 清理与 completed event publish 仅由 Lifecycle 触发。

### Local runtime currently used service methods

```text
getPromptContextForRun()
appendContextItemFromWorker()
updateContextItemFromWorker()
updateRunStateFromWorker()
completeRunFromWorker()
getSession()
```

P4 不重写 local runtime 主流程；它继续调用 Service facade，完整 Service 解耦留待后续批次。

## Store

```text
apps/api/src/modules/agent/agent.store.ts
```

### Run-state

```text
getRunState()
updateRunState()
setRunStateIdle()
setRunStateIdleIfActiveRunMatches()
setRunStateIdleIfNoActiveRun()
listInFlightSessionsWithoutActiveRunId()
```

### Dedup/activation

```text
findClientRequestDedup()
insertClientRequestDedup()
appendContextItem()
updateAgentSessionTitle()
createRunRecord()
```

P3 后 activation transaction 是 `AtomicLifecyclePersistence.activateUserRun()` 的命名 capability；`AgentService` 仅在构造期将其 SQLite adapter 装配给 `RunLifecycleApplication.startUserRun()`。

它在同一 transaction 内完成 authoritative dedup/idle 复核、user item、首条 title、dedup、run record 与 run-state；Route/Service 不再重复 activation 主体。

### Run record

```text
createRunRecord()
getRunRecord()
updateRunRecordStatus()
failRunRecordIfInFlight()
listRecoverableRuns()
```

### Context/run cancel/recovery persistence helpers

```text
listNonTerminalSessionItemIds()
listNonTerminalSessionItemIdsByRunId()
listNonTerminalRunIdsBySession()
listNonTerminalRunIdsByItemIds()
failNonTerminalContextItemsByRunId()
getLatestSessionItemId()
```

P5 后上述 helper 由 `SqliteRunLifecyclePersistence` 的命名 recovery capability 使用：candidate 初检/final eligibility、fail mode 的 context/run/state CAS、notice 与 dirty-state 回收均不再由 module 编排。

### Durable child query

```text
listSubtaskChildSessionIdsByRunId()
```

P4 后由 `RunLifecycleApplication` 通过 `ActiveSubtaskChildQuery` 窄 capability 传给 SQLite cancel transaction；Subtask 主体未迁移，lineage SQL 仍留在 Store。

## Runtime port与 adapters

### Port

```text
apps/api/src/modules/agent/agent.runtime-port.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts
```

关键：

```text
AgentRuntimeRun
AgentRuntimePort.enqueueRun()
AgentRuntimePort.cancelSession()
```

P2 已将 `AgentRuntimeRun` 定义迁至 `lifecycle/run-lifecycle-ports.ts`，`agent.runtime-port.ts` 仅兼容导出 runtime port 类型；该端口不再从 `agent.service.ts` 导入类型。

## Lifecycle application 骨架

```text
apps/api/src/modules/agent/lifecycle/
├── run-lifecycle-application.ts
├── run-lifecycle-ports.ts
├── run-lifecycle-application.test.ts
└── run-lifecycle-wiring.test.ts
```

P2-P5 已落地的窄端口与 use-case：

- `RuntimeControlPort` / 独立 `AgentRuntimeRun`；
- `WorkspaceRunContextReader`、`ActiveSubtaskChildQuery`；
- `PromptStaticCacheInvalidator`、`RunCompletedEventPublisher`；
- `AtomicLifecyclePersistence`、clock、id generator、logger。
- `RunLifecycleApplication.startUserRun()`：authoritative activation → context → enqueue → conditional failure settlement。
- `RunLifecycleApplication.updateRunStateFromWorker()` / `completeRunFromWorker()`：guarded worker writeback；有效 terminal complete 才触发 cache/event。
- `RunLifecycleApplication.cancelSession()`：同一 SQLite transaction 的 root/current-active-child cascade → runtime `allSettled` best-effort。
- `RunLifecycleApplication.recoverRunsOnStartup()`：candidate 初检 → workspace/trigger read → 受控测试/时序 hook `beforeFinalCheck`（生产 module 不传入）→ final DB eligibility fence → enqueue；单 candidate enqueue failure 仅 warning 并继续。
- `RunLifecycleApplication.failRunsOnStartup()`：独立 best-effort context/run/state CAS/notice 及 dirty-state 回收；不改变 startup fail prompt-cache invalidation 的既定边界。

`AgentService` 在构造期以 Store/cache/event/context 的最小 adapter 装配 application，并以一次性 command 将 runtime 交给 `startUserRun()`、cancel 与 recovery use-case；Public/internal send Route 不再读取 context 或直接 enqueue。`agent.module.ts` 仅选择 fail-before-listen / recover-onListen 时机并触发 facade；orphan/archive 与 Worker/Plugin Host 进程管理保持原边界。

### API-managed Worker adapter

```text
apps/api/src/modules/agent/agent.worker-client.ts
apps/api/src/modules/agent/agent.worker-client.test.ts
```

关键：

```text
enqueueRun()
cancelSession()
postAndValidate()
```

当前 enqueue 抛 503；cancel catch/warn 后不抛。P0 定稿错误边界。

### Local fallback

```text
apps/api/src/modules/agent/agent.runtime.ts
apps/api/src/modules/agent/agent.runtime-port.ts
apps/api/src/modules/agent/agent.module.ts
```

P6 后构造边界：

```text
AgentRuntime.constructor(execution: LocalAgentRuntimeExecutionPort,...)
enqueueRun()
cancelSession()
pump()
startRun()
processRun()
```

Module 仅在 worker disabled 的 local fallback 装配分支传入六个显式 adapter：

```text
getPromptContextForRun
appendContextItemFromWorker
updateContextItemFromWorker
updateRunStateFromWorker
completeRunFromWorker
getSession
```

`AgentRuntime` 因而不导入、不接收也不持有完整 `AgentService`；它只能取得执行所需的 read-side、writeback、lifecycle writeback 与 session-head capability。此项只收窄依赖面，未重写 `processRun()`：队列、按 session 串行/并发 pump、queued cancel 与 Worker writeback 行为均保持不变。`cancelSession()` 仍只移除尚未启动的 queued item，不为正在 `processRun()` 的任务新增 AbortController。

### Worker runtime

```text
apps/agent-worker/src/runtime/runner.ts
apps/agent-worker/src/runtime/runner.cancel.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
```

本阶段只做回归和必要类型同步，不深拆 Runner。

## Run context

```text
apps/api/src/modules/agent/agent-run-context.ts
```

关键：

```text
getAgentWorkspaceRunContext()
```

当前由 `AgentService` 在构造期将 `getAgentWorkspaceRunContext()` 适配为窄 `WorkspaceRunContextReader`；`RunLifecycleApplication.startUserRun()` 与 `recoverRunsOnStartup()` 均仅通过该 reader 获取 runtime 所需的 workspace path/repository directory names。Route 与 module 不读取完整 context 来编排 recovery。

## Read-side / cache

0007-A 已落地的 read-side/prompt application 路径已在 P0 复核。Lifecycle 所需能力：

```text
clearRunPromptStaticCache(runId)
```

目标依赖方向：

```text
Lifecycle → Prompt cache invalidation capability
Read-side ↛ Lifecycle application
```

## Context Writeback

```text
apps/api/src/modules/agent/writeback/context-writeback-application.ts
```

Lifecycle 与 Writeback 的关系：

- Lifecycle 负责 run terminal/cancel/recovery；
- Writeback 通过 Store fence 消费 run/session 状态；
- Lifecycle 不吸收 Worker context create/update；
- Writeback 不依赖完整 Lifecycle service。

本地 fallback 可分别依赖 Read-side、Writeback、Lifecycle 窄能力。

## Run completed events

```text
apps/api/src/modules/agent/run-completed-events.ts
```

关键：

```text
AgentRunCompletedEventHub
publish()
```

Route SSE 与 complete use-case 需保留现有 event contract。

## Module / startup

```text
apps/api/src/modules/agent/agent.module.ts
```

当前 lifecycle symbols：

```text
registerAgentModule()
service.failRunsOnStartup()
service.recoverRunsOnStartup({ runtime })
```

P5 后的 startup 边界：

```text
fail mode: module 注册期、listen 前 → Service facade → RunLifecycleApplication.failRunsOnStartup()
recover mode: onListen → Service facade → RunLifecycleApplication.recoverRunsOnStartup({ runtime })
```

module 不再导入或编排 recovery candidate、final DB fence、context/run/run-state settlement、notice 或 dirty-state Store helper；这些规则位于 Lifecycle application 与 `SqliteRunLifecyclePersistence`。

Module 仍保留：

- service/application/runtime 构造；
- route 注册；
- Worker/Plugin Host process start/stop；
- lifecycle/subtask/archive startup hook 触发。

## Tests

### API integration

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

已定位 lifecycle 测试区域：

```text
startup fail/recover
cancel/recovery races
runtime cancel failure
internal trigger dedup
run-complete SSE
prompt cache terminal invalidation
cancel/cancelled-complete/hidden-chain/terminal/child cascade
run-state notice/recent terminal
```

### API-managed Worker

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

### P0 characterization

```text
apps/api/src/modules/agent/run-lifecycle-baseline.api.test.ts
```

使用真实 SQLite、真实 `AgentService` 和注册的 Public Route；仅以 `createFakeAgentRuntime()` 确定性观察并制造 enqueue failure。冻结：Route failure 不返回 `201`、activation 持久化残留、以及同 `clientRequestId` retry 不再次 enqueue；不证明生产 `createApp()` 的精确 error HTTP 外观。

### P1 SQLite persistence

```text
apps/api/src/modules/agent/run-lifecycle.persistence.test.ts
```

使用真实 SQLite 直接覆盖：enqueue failure 只使目标 run failed 而不 idle switched active run；cancel 后 late enqueue failure 不覆盖 cancelled；recovery final check 观察 cancel 后不 enqueue。`createFakeAgentRuntime()` 只用于 recovery enqueue 观察。

### Facade

```text
apps/api/src/modules/agent/agent.service.facade.test.ts
```

P2 已新增 Lifecycle application/wiring tests，保留 0007-A/B facade tests；P3-P5 再为实际迁移的 facade use-case 补委派证据。

### Testkit

```text
apps/api/src/modules/agent/testkit/agent-testkit.ts
apps/api/src/modules/agent/testkit/agent-testkit.test.ts
```

关键：

```text
createFakeAgentRuntime()
enqueueRunCalls
cancelSessionCalls
configurable errors/hooks（`enqueueRunError`、`cancelSessionError`、`onEnqueueRun`、`onCancelSession`）
```

### Worker client/runtime

```text
apps/api/src/modules/agent/agent.worker-client.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/runner.cancel.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
```

## 候选新增结构

名称不冻结：

```text
apps/api/src/modules/agent/lifecycle/
  run-lifecycle-application.ts
  run-lifecycle-persistence.ts
  run-lifecycle-recovery.ts
  run-lifecycle-ports.ts

apps/api/src/modules/agent/
  run-lifecycle.api.test.ts

apps/api/src/modules/agent/lifecycle/
  run-lifecycle-application.test.ts
  run-lifecycle.persistence.test.ts
  run-lifecycle-recovery.test.ts
```

允许函数式/对象式混合，优先项目现有风格与小改动。

## P6 残留检索

已执行 production-only `rg`（排除 `*.test.ts`）并人工复核调用链；分类如下：

| 模式 | 命中分类与结论 |
|---|---|
| `runtime.enqueueRun(` | `RunLifecycleApplication` 的 normal send/recovery 唯一编排；Route 的 compact 是有意保留的 compaction 路径。无旧 normal send/recovery Route 权威。 |
| `runtime.cancelSession(` | Lifecycle 在 DB settlement 后执行 best-effort cancel；Route 的 revert 仅在 idle/no-nonterminal 前提下清理本地 queue，不是 cancel cascade。 |
| `failRunOnEnqueueFailure(` | 仅 compact legacy 差异使用的 Service facade；normal Public/internal send 已不使用。 |
| `cancelRuntimeSessionsAfterDbConvergence` | 无生产命中，已删除。 |
| `cancelSessionCascade(` | Lifecycle 实现及 `AgentService` 薄 facade；无 Route DB/runtime 分拆编排。 |
| `updateRunStateFromWorker(` / `completeRunFromWorker(` | local runtime、internal Worker Route、Lifecycle persistence 与 Service 薄 facade；terminal/cache/event 规则仍由 Lifecycle 单一权威。 |
| `enqueueRecoveringRuns` / `failRecoveringRuns` | 无生产命中，已删除。 |
| `listRecoverableRuns(` / `setRunStateIdleIfActiveRunMatches(` | 仅 `SqliteRunLifecyclePersistence` 适配 Store capability；无 Module/Route 直接调用。 |
| `AgentRuntime(service` | 无命中；Module 改为显式 `LocalAgentRuntimeExecutionPort` adapter。 |
| `service.getContext()` | internal token 校验、agent settings list 的配置读取，以及 compact 的已知有意差异；Lifecycle normal send/recovery 不读取完整 context。 |

额外人工复核：`AtomicLifecyclePersistence.activateUserRun()` 与 recovery candidate/final fence 只由 `RunLifecycleApplication` 调用；`agent.module.ts` 不导入 lifecycle Store candidate/CAS/settlement helper；active child query 仍为窄 port。

`beforeFinalCheck` 仍仅是 recovery final fence 的受控测试/时序 hook；生产 Module 不传入，不是通用业务扩展点。
