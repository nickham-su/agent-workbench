# 当前基线与证据

## 基线口径

本文件记录方案起草时的只读源码与既有测试索引，不表示本阶段已重新运行验证。P0 必须以实际源码、测试结果和 Git 快照复核；精确命令、cwd、数量、耗时与预期日志记录在 `09-implementation-record.md`。

上位约束：

- P0 已使用真实 SQLite、真实 `AgentService` 和注册的 Public Route 重新验证 Public enqueue failure / dedup；未修改生产代码。精确命令与结果记录在 `09-implementation-record.md`；
- 除明确标记为 P0/P3 验证结果的条目外，本文件其余“当前”描述仍可能仅来自静态调研或既有测试索引；
- `0005` 已冻结 cancel/recovery、prompt cache 与 API-managed Worker 的关键行为；
- `0006` 要求本阶段定稿 `sendMessage()` 协作、runtime port、cancel child query 和 startup/module 边界；
- `0007-A` 已建立 Read-side / Prompt application 与 prompt static cache 边界；
- `0007-B` 已建立 Context Writeback application、Store fence 与 Artifact capability；
- 当前实现提交为 `04499bb`。

方案起草时 Git 状态：

```text
## v1.1...origin/v1.1 [ahead 1]
```

当时无既有未提交变更；本方案文档创建后工作区将出现本目录未跟踪文件。每批实施前必须重新记录完整状态。

## `sendMessage()` 当前基线

### Public Route

文件：

```text
apps/api/src/modules/agent/agent.routes.ts
```

当前流程：

```text
POST /api/agent/sessions/:sessionId/messages
  → service.sendMessage()
  → if !deduplicated
      → getAgentWorkspaceRunContext(service.getContext(), workspaceId)
      → runtime.enqueueRun(...)
  → 201 response
```

只读确认：

- Route 声明 `201` 与 `400/404/409`；
- 非 dedup 时由 Route 读取完整 service context 解析 workspace run context；
- Public Route 的 `runtime.enqueueRun()` 当前没有 catch，也没有调用 `failRunOnEnqueueFailure()`；
- enqueue 抛错后的 DB 残留和 dedup retry 已由下文 P0 characterization 验证；生产 `createApp()` 的精确 HTTP status/body 未由该 characterization 验证。

### Internal trigger Route

内部 trigger 使用相同 `service.sendMessage()`，但 enqueue 包在 `try/catch` 中：

```text
runtime.enqueueRun()
  → catch
  → service.failRunOnEnqueueFailure()
  → rethrow
```

该 Route 声明 `201/400/401/404/409`。runtime adapter 可抛 `HttpError(503, "agent worker unavailable")`；实际 response schema/error 映射与测试证据需在 P0 复核。

### 已确认 run-start 入口对照

| 入口 | 当前 durable activation owner | 当前 runtime context / enqueue owner | 当前 enqueue failure | 本阶段目标 |
|---|---|---|---|---|
| Public `POST /api/agent/sessions/:sessionId/messages` | `RunLifecycleApplication.startUserRun()`（由 `AgentService` facade 调用） | Lifecycle | enqueue 异常后条件 failed/idle settlement → rethrow；P3 真实 Route 证据保留 user item/dedup 且 retry 不重 enqueue | 已完成；精确 production HTTP body/status 仍未 characterization |
| Internal `POST /api/internal/agent/runs/trigger` | `RunLifecycleApplication.startUserRun()`（由 `AgentService` facade 调用） | Lifecycle | 与 Public 共用相同 settlement；P3 真实 Route 证据确认 dedup retry 不重 enqueue | 已完成；保留 auth 与既有 HTTP 外观 |
| Public/Internal compact | `AgentService.compactSession()` | Route `handleCompactRequest()` | catch → `AgentService.failRunOnEnqueueFailure()` → Lifecycle conditional settlement → rethrow | compact 主体/调度仍归后续领域；P3 仅复用基础 failure capability |
| Startup recover | Module/recovery helpers 选择既有 run | Module `enqueueRecoveringRuns()` | warning 并继续，不做正常新 run 的 failure settlement | Run Lifecycle recovery use-case；保留 recover 特有 failure isolation，不与正常 start 机械统一 |

该表只列只读调研已确认的直接 runtime enqueue 入口。若 P0 发现新的 run-start caller，必须补入表格后再确定复用方式；不得据名称推测 Subtask 等入口。

### Service 前置语义

`AgentService.sendMessage()` 当前按以下顺序处理：

- session 不存在：`404 session not found`；
- subtask session：`400 subtask session is read-only`，code `AGENT_SUBTASK_READONLY`；
- workspace mismatch：`400 workspaceId mismatch`；
- trim 后空文本：`400 text is required`；
- client request dedup 命中：返回旧 `messageItemId/runId` 与 `deduplicated:true`；
- run-state 非 idle：`409 session is running`；
- 解析 user execution profile；
- 生成 time/run ID；
- 执行原子 transaction。

### 原子 transaction

当前同一 SQLite transaction 内完成：

```text
read current session head
  → append completed user context item
  → first user message: update session title
  → insert client request dedup
  → create running run record
  → update run-state to running + activeRunId
```

transaction 中的主要输入/结果：

- user item：`runId` 指向新 run，`prevId` 为当前 head；
- dedup：`workspaceId + sessionId + clientRequestId → messageItemId + runId`；
- run record：保存 agent/provider/model/uiLocale，primary depth 为 `0`，parent 字段为空；
- run-state：`running`、`activeRunId`、`activeAssistantItemId:null`、空 notice、`appliedItemId=user item`。

`AgentConflictError` 当前映射为既有 HTTP conflict。P0 必须验证并冻结并发 dedup/head conflict 的真实结果，不能仅依赖前置查询。

## Enqueue failure 当前基线

### 现有 helper

`AgentService.failRunOnEnqueueFailure()` 当前：

- 读取 run；
- run 不存在、workspace/session 不匹配或已 terminal 时 no-op；
- 否则无条件将该 run 更新为 `failed`；
- 清理该 run 的 prompt static cache；
- 读取 run-state；
- 仅当 `state.activeRunId === runId` 时将 run-state 设为 idle。

该 helper 当前没有显式 SQLite transaction 包裹 run record、cache 和 run-state 收敛，也不处理 trigger user item。它被 compact/internal trigger 等 Route 使用，但 Public message route 未使用。

### 必须由 P0 回答

- Public message enqueue 失败时实际返回什么 HTTP status/body；
- DB 中 user item、dedup、run record、run-state 的实际状态；
- retry 相同 `clientRequestId` 后返回 dedup，是否会再次 enqueue；
- internal trigger/compact 的 failure helper 在 cancel/complete/active-run switch 竞态下是否保持 `cancel wins`；
- enqueue 失败是否应保留 user item/dedup 并只终止 run，还是需要其他显式行为；
- 所有 run-start 入口是否应共享同一 conditional failure capability，哪些差异属于对应领域。

### P0 验证结果：Public message enqueue failure 与 dedup retry

`run-lifecycle-baseline.api.test.ts` 使用真实 SQLite、真实 `AgentService`、注册的 Public Route 和仅用于观察/确定性抛错的 fake runtime，得到以下冻结事实：

| 场景 | HTTP | runtime | SQLite / retry 结果 |
|---|---|---|---|
| 首次 Public `POST /messages` 的 `enqueueRun()` 抛普通 `Error` | 最小 Route 装配中不返回 `201`；生产 `createApp()` 精确 body/status 未由本测试证明 | 恰好调用一次 enqueue，异常从 Route 冒泡 | completed user item、client-request dedup、`running` run record 与 `running + activeRunId` run-state 均已持久化；run 未经 failure helper 收敛，仍为 `running` |
| 相同 `clientRequestId` retry | `201`，响应为原 `sessionId/messageItemId/runId` 且 `deduplicated:true` | 不再次 enqueue | 不新增 user item/run，原 run 与 activeRunId 仍保持 `running` |

因此，Public Route 与 internal trigger/compact 的 enqueue failure 持久化收敛当前确实不同：前者没有补偿，后两者调用 `failRunOnEnqueueFailure()`。P0 只冻结事实，不将其判定为本批次必须修复的产品缺陷；P3 必须明确决定是否统一并为选择补充条件化竞态证据。P3 前不得用重构悄然改变本表已经证明的持久化或 dedup retry 行为；生产 error HTTP 外观应在需要变更该外观时通过真实应用装配单独 characterization。

### P6 收口分类

- Public/internal normal user send 已由 `RunLifecycleApplication.startUserRun()` 统一 activation、runtime context、enqueue 与 failure settlement；
- compact 是有意保留的独立 compaction run-start 路径：其 `compactSession()`、context 读取、enqueue 及 failure settlement 保持既有语义，不在本阶段被吸收入 Lifecycle；
- `revert` 仅在 session 已 idle 且无非终态 item 时，best-effort 清除 runtime queue；它不是 root/child cancel cascade，不承担 DB-first cancel 领域编排；
- internal token 校验及 agents list 的 `service.getContext()` 是配置/鉴权读取，不是 runtime context/lifecycle 编排；
- P6 未改变上述 compact/revert/config 路径的产品行为。

## Runtime port 与 adapter 基线

### Port

```text
apps/api/src/modules/agent/agent.runtime-port.ts
```

方案起草/P0 时的旧基线：

```text
AgentRuntimePort
  enqueueRun(run)
  cancelSession(sessionId)
```

当时 `AgentRuntimeRun` 从 `agent.service.ts` 导入 `AgentQueuedRun`，形成 runtime port type → full service 文件的反向类型依赖。该问题已在 P2 通过将 run type 移至 lifecycle port 消除。

P6 后当前实现额外定义 `LocalAgentRuntimeExecutionPort`。它不从 `AgentService` 取类型，且只声明 local fallback 实际所需的 prompt context、context item append/update、worker state/complete writeback 与 session-head read operation；它不替代 API-managed Worker 使用的 `AgentRuntimePort`。

### P0 验证结果：API-managed Worker 与 local fallback

- API-managed Worker：`AgentWorkerClient.enqueueRun()` 将 transport/非 2xx/严格响应校验异常映射为 `HttpError(503, "agent worker unavailable")` 并抛出；`cancelSession()` 捕获相同类别异常、记录 warning 后返回成功。因此 Route 外层的 `Promise.allSettled()` 不能从 `AgentWorkerClient.cancelSession()` 观察 transport failure。
- local fallback：`AgentRuntime.cancelSession()` 只从内存 `queue` 删除匹配 session 的尚未启动任务；不会为已在 `processRun()` 的任务创建或触发 AbortController。本地 runtime 的 `enqueueRun()` 入队后由 `pump()` 按并发度启动。
- API-managed Worker runner：现有 `runner.cancel.test.ts` 证明 worker session cancel 会 abort 当前 nested controller，且 cancelled complete 保持原终态重试。因此 API-managed Worker 与 local fallback 的“运行中 cancel”能力不等价；P2-P6 均未假定二者语义相同或为 local fallback 新增强停。

相关回归在 P0 已重新运行：Worker client 8 项、API-managed Worker 3 项、Worker cancel 10 项，均通过。

### P6 收口：local fallback execution port

`AgentRuntime` 已不再导入或接收完整 `AgentService`。它改为注入 `LocalAgentRuntimeExecutionPort`，只依赖 prompt context、context item append/update、worker state/complete writeback 与 session-head read capability。

`agent.module.ts` 在 worker disabled 的 local fallback 分支以显式 adapter 提供六项 operation：

```text
getPromptContextForRun / appendContextItemFromWorker / updateContextItemFromWorker
updateRunStateFromWorker / completeRunFromWorker / getSession
```

因此 local runtime 不能获得 Route、startup、配置或其他无关 Service 能力；API-managed Worker 仍只通过 `AgentRuntimePort` 接入。

此项仅收窄类型与依赖方向；不改变 local fallback 的队列、并发、queued cancel 或 Worker writeback 行为。`AgentRuntime(service, ...)` 的旧构造调用已不存在，运行中任务也未新增强停能力。

## State / complete / cancel / recovery 的 P0 线性化索引

- `updateRunStateFromWorker()`：run 不存在/归属不匹配/终态、或 session `activeRunId` 已切换时忽略晚到 state；仅合法 active running run 可更新 state 与 run record。
- `completeRunFromWorker()`：terminal run no-op；仅 `activeRunId === runId` 时回收 idle；cancelled complete 收敛该 run 的非终态 context items；完成后清理 prompt static cache 并发布 run-completed event。现有 API integration 覆盖 cancelled complete、terminal guard、hidden chain、active-run switch 与状态展示。
- `cancelSessionCascade()`：先在单 SQLite transaction 内遍历 root/current-active-child 并收敛 context/run/run-state，再由 Route 调用 runtime cancel；runtime failure 仅 warning，不回滚 DB。现有 API integration 重新通过了 cancel/recovery final-fence、enqueue-after-cancel、runtime cancel failure 与精确 child cascade 证据。
- recovery：`enqueueRecoveringRuns()` 在初步候选校验与 enqueue 之间重新读取 session/run/run-state；final check 前 cancel 不 enqueue，enqueue 已发出后由 DB/writeback fence 收敛，单 candidate enqueue failure 只 warning 并继续。相关集成测试在 P0 重新通过。

## Startup fail cache invalidation：P0 决策

当前生产 startup `fail` 路径先在 `registerAgentModule()` 创建新的 `AgentService`，再在 listen 前调用 `failRecoveringRuns(service, ...)`。`AgentService` 的 prompt static cache 是该 service 实例新建的私有字段；`failRecoveringRuns()` 本身未调用显式 cache invalidator。对于这个唯一生产 startup 调用时序，P0 的结论是：**无需新增显式 cache invalidation**，因为没有同一 service 实例中预先填充且可观察的 cache。

该结论的适用前提仅限 module startup 的新 `AgentService` 实例和当前 fail-before-listen 时序；若未来引入复用 service 实例的 restart/recovery，或将 fail use-case 暴露为可在已服务进程中调用的操作，必须重新评估并补显式 invalidation。P5 不得把本结论泛化为所有 terminal path；现有 enqueue failure/cancel/complete 的同进程 cache 清理规则继续保留。

### API-managed Worker adapter

```text
apps/api/src/modules/agent/agent.worker-client.ts
```

- `enqueueRun()` 调用 Shared Worker endpoint；失败记录 error 并抛 `HttpError(503, "agent worker unavailable")`；
- `cancelSession()` 调用 Shared Worker endpoint；catch 后在 adapter 内记录 warning，当前不重新抛出。

这意味着 Route 外层 `Promise.allSettled()` 在 API-managed Worker transport 失败时可能观察为 fulfilled，而 warning 已由 adapter 记录。P0 必须核对既有测试究竟使用 fake rejecting runtime 证明 application 语义，还是覆盖真实 adapter；迁移不得无意重复日志或改变错误可观察性。

### 本地 fallback

```text
apps/api/src/modules/agent/agent.runtime.ts
```

方案起草/P0 时的旧基线中，`AgentRuntime` 直接接收完整 `AgentService`；该构造依赖已在 P6 被 `LocalAgentRuntimeExecutionPort` 注入替代。

P6 后当前 `AgentRuntime`：

- 构造函数只接收 `LocalAgentRuntimeExecutionPort`，不导入、不接收也不持有完整 `AgentService`；
- Module 在 worker disabled 的 local fallback 分支以 prompt context、context item append/update、worker state/complete writeback 与 session-head read 六项显式 adapter 装配该 port；
- `enqueueRun()` 去重 runId、入内存队列并 pump；
- 同一 session 不并行运行；
- `cancelSession()` 只移除尚在 queue 中的 matching session run；
- 已开始执行的本地 run 没有 AbortController 强停；
- `processRun()` 通过该窄 port 调用 prompt query、context writeback、run-state update、run complete 与 session-head read。

P6 仅收窄依赖面；“本地 cancel 只移除 queued run”的行为保持不变。不得为与 API-managed Worker 表面一致而顺手引入本地运行中 abort。

## Worker state writeback 基线

### Route / contract

Shared internal endpoints：

```text
AgentApiEndpoints.updateRunState
AgentApiEndpoints.completeRun
```

Route 当前只做 internal token、Shared schema、调用 facade 并返回 `{ ok:true }`。合同默认只读。

### `updateRunStateFromWorker()`

当前规则：

- 读取当前 session run-state；
- 将空白 `activeRunId` 规范化为 null；
- 若当前已有其他 active run，晚到 active run 状态 no-op；
- active run record 存在时，workspace/session 不匹配 no-op；
- active run 已 terminal 时 no-op；
- 更新 run-state，包括 status、active assistant、token、notice；
- idle 且未显式传 notice 时清空 notice；
- activeRunId 非空时将对应 run record 更新为 `running`。

待 P0 核验：

- activeRunId 指向不存在 run record 时当前仍是否更新 run-state；
- run-state 与 run record 两次写是否需要保持当前非 transaction 行为；
- late status 与 cancel/complete 的竞态证据是否足够；
- 何种字段缺省与显式 null 的差异已被测试覆盖。

## Complete 与 terminal 基线

`completeRunFromWorker()` 当前：

- run 不存在、ownership 不匹配：no-op；
- run 已 terminal：no-op；
- transaction 内：
  - 更新 run record 为 `completed/failed/cancelled`；
  - 清理 prompt static cache；
  - 若 cancelled，收敛该 run 下非终态 context item；
  - tool item 使用 `toTerminalCancelledOutput()`，其他 item 保持 output 只改 status；
  - 仅当当前 `activeRunId === runId` 时将 run-state 设为 idle；
- transaction 后发布 `agent.run.completed.v1` event。

既有测试索引包括：

- prompt static promise 在 terminal 后清理；
- `run-complete(cancelled)` 收敛对应 run context items；
- run-state 最近终态结果；
- SSE run-complete event。

P0 需确认 transaction 内 cache clear 只是内存副作用还是可抛操作，以及 event 发布失败政策；迁移默认机械保持时机和结果。

## Cancel baseline

### Durable child traversal

`collectActiveCascadeCancelSessionIds()` 当前：

- 从 root session 广度遍历；
- session 必须属于 workspace；
- 仅当当前 run-state 为 running 且有 activeRunId 时查询 child；
- child 查询使用 `listSubtaskChildSessionIdsByRunId(workspaceId, sessionId, runId)`；
- child 必须同 workspace 且其 run-state 仍 running + activeRunId；
- visited 防循环；
- 返回 root 在前的有序 session IDs。

这体现 cancel 只消费 durable active-child query，不拥有 Subtask start/reuse/lineage 主体。

### DB transaction

`cancelSessionCascade()` 当前：

- root session 不存在：404；
- workspace mismatch：400；
- 在一个 DB transaction 中收集 cascade targets，并逐 session 收敛；
- 单 session 收敛：
  - 找出非终态 session items；
  - 找出 session/这些 items 关联的非终态 run IDs；
  - 将 items 标为 cancelled；tool output 做 cancelled 规范化；
  - run-state 设为 idle；
  - related run 和必要的 active run 标为 cancelled；
  - 清理相关 run prompt static cache；
- transaction 后返回 updated session/run-state 和 runtime cancel targets。

### Runtime best-effort

Public cancel Route 当前在 DB transaction 完成后调用：

```text
Promise.allSettled(runtime.cancelSession(each target))
```

rejected 只记录包含 root/target sessionId 的有限 warning，不改变成功 response。

既有测试索引包括：

- runtime cancel failure 只 warning，DB 保持收敛；
- cancel 保留消息、活跃项 cancelled；
- subtask tool cancelled output 保留 reuse 提示；
- hidden chain 非终态 items 与相关 run 收敛；
- terminal run 不被改写 cancelled；
- current active run 的 child 精确 cascade，不误取消历史 child。

## Startup recovery baseline

### 当前位置

```text
apps/api/src/modules/agent/agent.module.ts
```

module 同时承担：

- service/runtime/worker/plugin host 构造；
- route 注册；
- subtask orphan scan；
- archive pending reconcile；
- fail/recover lifecycle 领域编排；
- Worker/Plugin Host 进程生命周期。

### Recover mode

`enqueueRecoveringRuns()` 当前：

- `listRecoverableRuns()` 列出 `run-state=running && activeRunId != null`；
- 初步检查 session、run record、workspace/session、run.status=running、run-state activeRunId；
- 获取 workspace run context；
- 从 trigger user item恢复 input text；
- 运行测试用 `beforeFinalCheck` seam；
- 再次执行同一 DB check；
- 通过后 enqueue；
- 单 candidate enqueue 失败只 warning，继续下一项。

既有竞态证据索引：

- final DB check 前 cancel，cancel wins；
- enqueue 已发出后 cancel，DB cancelled 为最终权威；
- 一个 candidate enqueue 失败不阻塞后续 candidate。

### Fail mode

startup fail 当前 best-effort 逐步骤处理每个 candidate：

- fail non-terminal context items by runId；
- `failRunRecordIfInFlight()`：仅 running → failed；
- `setRunStateIdleIfActiveRunMatches()`：active run CAS；
- 只有本次确实回收 state 且 context/run 有变化时，best-effort 追加 system notice；
- 单项异常记录 warning 并继续；
- 额外处理 `running + activeRunId=null` 的脏 session；
- 外层意外错误记录 error，不阻塞模块注册。

fail mode 当前在 listen 前执行；recover mode 通过 `onListen` hook 执行。

### Startup fail cache 证据缺口

只读源码中未见 startup fail 显式调用 prompt static cache invalidation；但进程启动时内存 cache 是否天然为空、测试是否存在同进程调用路径、提取后是否改变生命周期，尚未由运行证据确认。因此当前唯一事实是“未见显式调用”，不能写成“已清理”或“必须新增清理”。

P0 必须将该问题作为独立决策门禁：记录 cache 实例生命周期、可观察场景、是否需要显式 invalidation、若需要则由哪个 recovery result 触发，以及保持/新增行为的回归证据。P5 只能实施 P0 已批准的结论。

## Persistence conditional capabilities

当前 Store 已提供可复用的条件能力：

```text
getRunState()
updateRunState()
setRunStateIdle()
createRunRecord()
getRunRecord()
updateRunRecordStatus()
failRunRecordIfInFlight()
setRunStateIdleIfActiveRunMatches()
setRunStateIdleIfNoActiveRun()
listRecoverableRuns()
failNonTerminalContextItemsByRunId()
```

其中后四项体现 recovery 的条件更新/CAS。目标结构可以保持函数式 API、引入窄 capability adapter 或混合方式；不得为抽象而把条件 SQL 退化为 application 先读后写。

## 当前测试证据索引

### API integration

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

已定位的相关测试名：

- `agent startup recovery mode=fail 会终止 in-flight run 并回收 run-state`
- `recover 在 enqueue 前最终 DB check 中让 cancel wins`
- `recover enqueue 已发出后 cancel 仍以 DB cancelled 状态为准`
- `recover enqueue failure 只记录并继续处理后续 candidate`
- `runtime cancel 失败仅 warning，DB cancel 保持收敛`
- `internal runs/trigger 支持 clientRequestId 去重`
- `internal events/sse 返回 run-complete 事件 chunk`
- `prompt-context reuses one run static promise and clears it when the run reaches a terminal status`
- cancel/cancelled-complete/hidden-chain/terminal-run/child-cascade 系列
- run-state notice 与最近终态系列

### API-managed Worker

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

已有真实 Worker send 主链测试；P0/P1 需建立 lifecycle 具体用例索引，包括 cancel 和 complete 是否已有端到端证据。

### Runtime/client

```text
apps/api/src/modules/agent/agent.worker-client.test.ts
apps/api/src/modules/agent/testkit/agent-testkit.test.ts
apps/agent-worker/src/runtime/runner.cancel.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
```

已知 fake runtime 支持 enqueue/cancel 调用记录和可配置失败。不得以 fake runtime 替代 SQLite transaction/CAS 或真实 Worker 主链。

## 当前证据缺口

P0/P1 至少补齐或明确索引：

- Public message enqueue failure 的 HTTP/DB/dedup 行为；
- send activation 原子 transaction 的直接 SQLite 证据；
- enqueue failure 与 concurrent cancel/complete/active-run switch 的条件收敛；
- updateRunState 的 missing run、terminal、switch、notice/token 缺省矩阵；
- complete 的 event/cache 时机和异常政策；
- API-managed Worker 的 lifecycle cancel/complete 主链；
- 本地 fallback queued cancel 与 running cancel 的现状；
-真实 `AgentWorkerClient.cancelSession()` 吞错与 application best-effort 日志边界；
- module 中 recovery 与 orphan/archive startup 证据的清晰归属。
