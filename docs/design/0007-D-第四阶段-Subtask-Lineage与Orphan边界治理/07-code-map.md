# 代码地图与候选改动面

> 路径和符号基于 HEAD `3c40dab` 的方案起草基线；P0 已按符号复核。行号会变化，后续实施前仍必须重新搜索。
>
> P0-P5 已实施：P3 已切换 prefork/start facade 并由 Lifecycle SQLite persistence 提供窄 child activator；P4 已切换 result/status facade 至 `SubtaskApplication` / `SqliteSubtaskRunQuery` 并新增 SQLite maintenance adapter；P5 已切换 orphan startup facade 至 `SubtaskApplication`。P6 已完成实现者结构审计与完整回归，阶段终审仍待新审查员。

## 端到端调用链

```text
Worker BuiltinToolProvider.execute("subtask")
  → AgentApiClient.getSubtaskPreforkPlan/startSubtaskRun/getSubtaskStatus/getSubtaskResult
  → Shared AgentApiEndpoints + TypeBox schemas
  → apps/api agent.routes internal Subtask endpoints
  → AgentService Subtask facade
  → SubtaskApplication
  → named SQLite persistence + narrow session materializer/clone + Lifecycle run transaction
  → response
  → Worker processNestedRun 或 reuse polling
  → Worker state/complete 写回 RunLifecycleApplication
```

目标：只将 API 侧 application/persistence/startup 结构化；Shared 和 Worker 主链保持。

### P0 固定执行边界

```text
API start 成功返回 child run
  → reused=false：Worker BuiltinToolProvider 调用 ctx.processNestedRun(...)
  → reused=true：Worker 轮询 status，terminal 后读取 result

API 不调用 runtime.enqueueRun() 以执行 child；worker-disabled AgentRuntime 也无 nested-subtask execution。
```

## Shared contract

### `packages/shared/src/internal-contracts/agent-api-subtask.ts`

当前：

- `AgentApiSubtaskSessionSchema`；
- prefork plan request/response；
- start request/response；
- result/status request/response；
- `AgentSubtaskErrorCode`。

目标：无生产变更。Subtask application 可在边界使用这些类型，但内部 port 不应完全由 DTO 驱动。

### `packages/shared/src/internal-contracts/agent-api.ts`

当前注册四个 endpoint：

- `getSubtaskPreforkPlan`；
- `startSubtask`；
- `getSubtaskResult`；
- `getSubtaskStatus`。

目标：不变。

### `packages/shared/tests/internal-contracts.test.ts`

保持 endpoint/schema/error code contract tests。

## API Route

### `apps/api/src/modules/agent/agent.routes.ts`

当前四个 internal routes 约位于 Subtask endpoint group：

- Shared method/path/schema；
- internal token；
- 调用 `AgentService` 四个方法。

目标：保持薄转发。本阶段不拆 route 文件，不新增 Store/application sequencing。

## AgentService 与 Subtask composition 边界

### `resolveSubtaskParentContext()`

作为 `parentAnchorReader` 的窄 composition adapter，负责 parent session/run/tool anchor ownership 与 `toolName` 校验；application 仅依赖该 port，不获得 `AppContext` 或 Store。

### `getSubtaskPreforkPlanFromWorker()`

当前：兼容 facade，直接转发 `SubtaskApplication.getPreforkPlan()`。

### `startSubtaskRunFromWorker()`

兼容 facade，直接转发 `SubtaskApplication.startSubtask()`；start 编排、unique arbitration、local compensation 与 activation plan 位于 application/窄 persistence capability，activation 交由窄 Lifecycle capability。

### `resolveSubtaskSessionForStart()`

作为 private `sessionMaterializer` composition adapter，负责 `new/fork/existing` 的 session materialization、origin metadata 与 clone/summary 分支，并返回 `createdSessionId`；不吸收 public primary fork。

### `createSubtaskSessionInternal()` / `cloneForkedSubtaskSessionInternal()` / `cloneContextIntoNewSession()`

当前：`0008` 已拆开的 internal materialization/clone primitive。

目标：保留产品语义；通过窄 port 暴露给 Subtask application。是否最终移入 Session domain 留给后续收尾，不在本阶段大搬迁 archive clone 主体。

### `resolveSubtaskForkBoundaryItemId()`

作为 private `sessionMaterializer` 的 fork boundary resolution；不得与 public fork boundary 合并。

### `toReusedSubtaskStartResponse()`

已在 P3 迁入 `SubtaskApplication`，保留历史/已删除 agent 的 `agentId` fallback。

### `getSubtaskRunResultFromWorker()` / `getSubtaskRunStatusFromWorker()`

当前：兼容 facade，分别转发 `SubtaskApplication.getResult()` / `getStatus()`。

P4：ownership-fenced run/session query 位于 `SqliteSubtaskRunQuery`；application 保留 durable status 及 assistant-first/system-fallback/empty result projection。

### `scanAndCleanupSubtaskOrphansBestEffort()`

已在 P5 删除；其 1h/24h policy、lineage eligibility、candidate loop、delete outcome logging 与 summary 已迁入 `SubtaskApplication.cleanupOrphansOnStartup()`。

`AgentService.cleanupSubtaskOrphansOnStartup()` 是仅转发 facade；`agent.module.ts` 的 routes 注册后顶层 try/catch 只触发该 facade，随后保持 archive reconcile、Lifecycle setup 与 Worker start 的既有相对顺序。

`CleanupSubtaskOrphansOnStartupResult` 仅用于测试/诊断，包含 scanned、retained、deleted、skippedAfterRecheck、failed 聚合计数；不作为 API response 输出候选 ids。

### `isSubtaskParentToolUniqueConstraintError()`

当前从 `agent.service.ts` 导出并被 integration test直接引用。

已在 P3 迁入 `SqliteSubtaskLineagePersistence`；`AgentService` 仅 re-export 以兼容既有集成测试。

P0 证据：函数只接受 SQLite `SQLITE_CONSTRAINT_UNIQUE`，且 message 同时含 `agent_run.parent_run_id` 与 `agent_run.parent_tool_item_id`。实际 start 控制流是 inner cleanup → classifier → durable winner re-query；P1 必须补真实 SQLite 双 connection race harness。

## Agent Store 当前能力

### `findSubtaskRunByParentTool()`

当前：被 P2 `SqliteSubtaskLineagePersistence.findChildByParentTool()` 包装为命名 lineage capability；旧 start 仍直接使用 Store helper，P3 才同批切换完整 start/race 主链。

目标：P3 后仅通过 named adapter 使用该 SQL。

### `listSubtaskChildSessionIdsByRunId()`

当前：P2 `SqliteSubtaskLineagePersistence` 以 `ActiveSubtaskChildQuery` 提供给 Lifecycle；Lifecycle 只接收此窄接口，未获得 anchor/session/orphan 能力。

### `SqliteSubtaskRunQuery`

P4：实现 `findSession()`、`findRunInSession()` 与 `listVisibleItemsByRun()`；只为 result/status 暴露 workspace/session/run ownership-fenced read。

### `SqliteSubtaskMaintenancePersistence`

P4：实现 local `deleteNewSessionIfStillEmpty()` 与 orphan `listSuspects()` / `deleteSuspectIfStillEligible()`。共享 final-fence SQL 仅为 adapter 私有实现；公开调用方不能传入 fork-lineage 安全开关。

## P2 production composition

```text
apps/api/src/modules/agent/subtask/
  subtask-application.ts
  subtask-ports.ts
  sqlite-subtask-lineage-persistence.ts
```

- `SubtaskApplication` 公开 prefork/start/result/status/orphan startup 用例；`SubtaskApplicationDependencies` 含其实际需要的 anchor/lineage、materializer、profile/settings、workspace/run state、run query、local compensation、orphan persistence、clock/id/logger；
- `SubtaskChildRunActivator` 已由 Lifecycle SQLite persistence 实现并注入，不注入完整 `RunLifecycleApplication`；
- `AgentService` 的四个 Subtask facade 均转发 application，未保留第二套领域实现。

当前：真实 parent tool join，供 Lifecycle cancel cascade。

P0 证据：join 同时以 child 的 parent fields 和 parent tool 的 workspace/session/run/kind/tool_name 限定；没有读取 `tool_result_json` 或 `subtaskSessionId`。

目标：由同一 named lineage adapter 实现 `ActiveSubtaskChildQuery`；Lifecycle 只接收该窄接口。

### `listEmptySubtaskOrphanCandidates()`

已在 P4 删除 Store 公共入口；`SqliteSubtaskMaintenancePersistence.listSuspects()` 为 P5 保留的 orphan candidate capability。

### `deleteEmptySubtaskSessionIfStillEmpty()`

已在 P4 删除 Store 公共入口。SQLite maintenance adapter 分离为：

- `deleteNewSessionIfStillEmpty()`；
- `deleteSuspectIfStillEligible()`。

后者固定包含 age、fork lineage 与 empty-session 最终确认，不接受 `requireForkLineage` 参数；可共享 SQL 仅为 adapter 私有实现。

### Run/context/session 基础函数

当前 start 直接使用：

- `getAgentSession`；
- `getRunRecord`；
- `getContextItemById`；
- `getRunState`；
- `appendContextItem`；
- `createRunRecord`；
- `updateRunState`；
- visible transcript query。

目标：application 不直接任意 import；由 anchor/query/activation/session ports 包装。底层 Store 函数可暂留，后续按职责逐步迁出。

## Lifecycle

### `apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts`

当前已有：

```ts
ActiveSubtaskChildQuery.listByParentRun(...)
```

目标候选新增：

```ts
SubtaskChildRunActivator.activate(...)
```

或等价窄 capability。不能将 Shared Subtask request 直接加入 `AtomicLifecyclePersistence`；Lifecycle 输入应是已由 Subtask 决定的 activation plan。

### `run-lifecycle-application.ts`

当前拥有 user activation、state/complete、cancel、startup fail/recover。

目标：可以暴露/持有 nested activation capability，但不拥有 mode/prefork/reuse/orphan。若实现选择独立 activator class，也必须归 Lifecycle persistence责任面并保持窄依赖。

### `sqlite-run-lifecycle-persistence.ts`

当前是完整 Lifecycle SQLite adapter。

候选：

- 新增 `activateSubtaskChildRun()`；或
- 新建 `sqlite-subtask-child-run-activator.ts`，复用 lifecycle-owned run-state invariant。

最终选择需以 P0/P2 transaction审查为准，避免再次形成不完整 named adapter。

## Module

### `apps/api/src/modules/agent/agent.module.ts`

当前：routes 后直接调用 `service.scanAndCleanupSubtaskOrphansBestEffort()`，再 archive reconcile/lifecycle startup/worker start。

目标：只触发 Subtask startup use-case，保持相对顺序与顶层 warning isolation；不含 policy/Store。

P0 固定顺序：

```text
service/runtime 构造 → optional plugin host → routes
  → orphan scan（module outer warning）
  → archive reconcile（module outer warning）
  → fail/recover hook → worker manager start（仅 worker-enabled）
```

orphan list-query 顶层错误由 module catch；单 candidate delete 错误由 `AgentService` 内层 catch。P5 module 只能触发 use-case，不能持有 1h/24h、fork lineage 或 delete fence 规则。

## Local fallback 结构边界

### `apps/api/src/modules/agent/agent.runtime.ts`

当前：worker-disabled local runtime 使用既有 read/writeback/lifecycle最小能力，不承载 Worker Subtask builtin/internal API/nested execution。

目标：无生产改动；不得新增 Subtask API/port、`SubtaskApplication` 或 nested child activator依赖。

### `apps/api/src/modules/agent/agent.module.ts` worker-disabled 分支

当前：构造 `AgentRuntime` 时注入 prompt context、context writeback、run state/complete与session读取等既有能力。

P0 结论：该分支没有 `AgentApiClient`、`BuiltinToolProvider`、`processNestedRun()`、Subtask-specific runtime port、未来 `SubtaskApplication` 或 nested activator。local fallback 因此不支持 nested-subtask execution；P1/P2 应以 wiring test 防止这个边界被误接线。

目标：注入集合不因本阶段扩张；Subtask application只装配给internal API/facade与startup orphan use-case，不接入local runtime。

## Worker

### `apps/agent-worker/src/runtime/apiClient.ts`

当前四个 Shared Subtask client 方法。

目标：不变。

### `apps/agent-worker/src/runtime/tools/providers/builtin.ts`

当前 `case "subtask"`：

- parse args；
- fork prefork plan/summary；
- start；
- update tool session hint；
- new nested execution；
- reused polling；
- result/error。

目标：不深拆，不改变时序。原则上无生产修改。

### `apps/agent-worker/src/runtime/runner.ts`

当前负责 nested run、tool output/cancelled规整等主控制流。

目标：不改结构；只回归相关测试。

## Database schema

### `apps/api/src/infra/db/schema.ts`

当前 partial unique index：

```text
idx_agent_run_parent_tool_unique
```

目标：不变。P1 persistence tests 将其作为最终 race arbitration 证据。

## Subtask 测试目录

```text
apps/api/src/modules/agent/subtask/
  subtask-application.test.ts
  subtask-lineage.persistence.test.ts
  subtask-wiring.test.ts
```

P1/P2 测试职责：

- `subtask-lineage.persistence.test.ts` 使用真实 SQLite fixture 验证 lineage 查询、partial unique/classifier、cancel child join、local/orphan final delete fence 和 result/status projection；
- `subtask-application.test.ts` 证明 P2 application 尚是无 product use-case 的 composition boundary；
- `subtask-wiring.test.ts` 证明共享的 named lineage adapter、Lifecycle 的 child-query-only 依赖、application 的窄端口集以及 local fallback 无 Subtask capability。

P3 必须将 application fake-port 的行为/顺序测试加入此目录，并将首个完整用例从 facade 切换到 application；P2 不提前迁移。

可选拆分：

```text
sqlite-subtask-query-persistence.ts
sqlite-subtask-orphan-persistence.ts
```

避免为每个查询建立类；拆分依据是 transaction、删除政策与消费者能力面。

## 当前测试地图

### API

`apps/api/src/modules/agent/agent.integration.test.ts` 当前包含大量 Subtask 用例，关键搜索词：

```text
subtask
orphan
parent tool
unique
prefork
existing
cancel
partial
```

P0 应建立测试名到规则的精确索引，实施后再决定哪些保留大集成、哪些迁入独立文件。

### Worker

```text
apps/agent-worker/src/runtime/tools/providers/builtin.prefork.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
apps/agent-worker/src/runtime/tools/providers/builtin.read.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

### Shared

```text
packages/shared/tests/internal-contracts.test.ts
```

### Lifecycle 关联

```text
apps/api/src/modules/agent/run-lifecycle.persistence.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts
```

需补充 nested activator 与 child query 的交叉证据，但不得把全部 Subtask application tests 放入 Lifecycle 文件。

## 结构搜索建议

实施/审查时至少运行：

```bash
rg -n "resolveSubtask|startSubtaskRunFromWorker|getSubtask.*FromWorker" apps/api/src/modules/agent
rg -n "findSubtaskRunByParentTool|listSubtaskChildSessionIdsByRunId" apps/api/src/modules/agent
rg -n "deleteEmptySubtaskSessionIfStillEmpty|listEmptySubtaskOrphanCandidates" apps/api/src/modules/agent # P4 后仅允许测试中的负向断言命中
rg -n "subtaskSessionId" apps/api/src/modules/agent apps/agent-worker/src
rg -n "AppContext|Fastify" apps/api/src/modules/agent/subtask
rg -n "enqueueRun" apps/api/src/modules/agent/subtask apps/api/src/modules/agent/lifecycle
rg -n "Subtask|subtask" apps/api/src/modules/agent/agent.runtime.ts apps/api/src/modules/agent/agent.runtime-port.ts
rg -n "SubtaskApplication|SubtaskChildRunActivator" apps/api/src/modules/agent/agent.module.ts
rg -n "requireForkLineage" apps/api/src/modules/agent/subtask apps/api/src/modules/agent/agent.module.ts
```

期望：

- 旧 facade private规则无生产命中；
- lineage SQL 只有 named adapter权威；
- `subtaskSessionId` 不进入 lineage SQL；
- Subtask application无 AppContext/Fastify；
- nested activation无 enqueue；
- `AgentRuntime`/local execution port无新增Subtask能力，worker-disabled wiring无新增Subtask注入；
- `requireForkLineage` 不出现在application/公开port；
- local/orphan共享SQL若存在，只在SQLite adapter私有实现中。
