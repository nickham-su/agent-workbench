# Run Lifecycle 领域设计

## 设计目标

把 run activation、runtime enqueue、state/complete、cancel 和 recovery 从 `AgentService`、Route 与 Module 的混合实现中收敛为明确的应用边界，同时保持：

- Shared/HTTP/Worker 调用面不变；
- user item/dedup/run/run-state 原子事务不变；
- DB-first、`cancel wins`、runtime best-effort 不变；
- terminal/active-run/recovery final fence 不变；
- prompt static cache 与 run-completed event 的既有时机不变；
- API-managed Worker 与本地 fallback 均可继续工作；
- `AgentService` 暂时作为兼容 facade。

候选组件名只表达职责，不冻结最终类名或对象/函数式形态。

## 术语约定

本文统一使用：

- `Run Lifecycle application`：本职责域唯一应用边界，候选实现名为 `RunLifecycleApplication`；
- `use-case`：application 暴露的具体操作，例如 `startUserRun()`、`cancelSession()`、`completeRunFromWorker()`、`recoverRunsOnStartup()`；
- `startup hook`：Module 对 recovery use-case 的薄触发适配，只决定调用时机；
- `capability` / `port`：application 的窄依赖，例如 atomic persistence、runtime control、cache invalidation；
- `coordinator`：仅指可能的跨职责域启动顺序器。本阶段不使用该词指代 Lifecycle 领域实现，也不要求创建 coordinator。

后文出现“application”均指 `Run Lifecycle application`；具体动作统一称 use-case。

## 目标调用链

```text
Public/Internal Route
  → AgentService facade 或 Session/Interaction application
      → RunLifecycleApplication
          ├─ startUserRun(command)
          │   └─ activate atomically → read runtime context → enqueue → settle failure
          ├─ updateRunStateFromWorker(input)
          ├─ completeRunFromWorker(input)
          ├─ cancelSession(input)
          ├─ failRunsOnStartup()
          └─ recoverRunsOnStartup()
              ├─ AtomicLifecyclePersistence
              ├─ RuntimeControlPort
              ├─ WorkspaceRunContextReader
              ├─ ActiveSubtaskChildQuery
              ├─ PromptStaticCacheInvalidator
              ├─ RunCompletedEventPublisher
              ├─ clock / id generator
              └─ logger
```

Route 不得继续组合 Store/service/runtime 时序。Module 不得继续实现 recovery candidate/fence/settlement。

## Application 责任

Run Lifecycle application 负责：

- run 创建、激活、状态转换和终态收敛；
- activation 后 runtime enqueue；
- enqueue failure 的条件化 DB 收敛；
- Worker state/complete 输入到 persistence/副作用的映射；
- cancel cascade 的 transaction 与 runtime cancel 顺序；
- startup fail/recover use-cases；
- 已确认终态路径和 P0 定稿后的 startup fail cache invalidation，以及 event 发布时机；
- 有限、脱敏的 runtime/recovery warning。

它不得：

- 自己实现 Session query/fork/revert/clear；
- 拥有 Subtask start/reuse/lineage 写入；
- 修改 Context Writeback fence；
- 修改 Compaction/Archive 主体；
- 接收完整 `AgentService` 或完整 `AppContext`；
- 修改 Shared schema、DB schema 或产品状态枚举；
- 将 Store 条件 SQL 拆成不安全的 application 先读后写。

## `sendMessage()` 跨域协作

### 权威协作表

| 环节 | 唯一权威 | 规范性要求 |
|---|---|---|
| Route/HTTP transport | Route | schema/auth/调用/response 序列化；不读取 Store/context，不决定 enqueue/补偿 |
| 用户命令前置语义 | Session / Interaction application | session/workspace/subtask/text 校验、execution profile 解析、dedup 产品语义；将已规范化 command 交给 Lifecycle |
| run-start 编排 | `RunLifecycleApplication.startUserRun()` | 唯一拥有 activation → runtime context → enqueue → failure settlement 顺序 |
| activation transaction | `AtomicRunActivationPersistence`，由 `startUserRun()` 唯一调用 | 唯一 transaction callback；user item/title/authoritative dedup/run/run-state 同事务 |
| runtime context | `startUserRun()` 通过 `WorkspaceRunContextReader` | 只在 `activated` 分支读取；不得暴露完整 `AppContext` |
| enqueue / failure | `startUserRun()` + `RuntimeControlPort` + conditional persistence | deduplicated 不 enqueue；failure 先条件收敛再抛错；`cancel wins` |
| HTTP error | 产生错误的 application/use-case；facade 透传；Route/全局 handler 序列化 | 前置 `400/404` 归 Interaction；running/activation/runtime 错误归 Lifecycle；Route 不重新解释业务错误 |

Execution profile 由 Session / Interaction 通过 0007-A 已建立的窄 Read-side 能力解析，并把 agent/provider/model/uiLocale 等 execution metadata 作为 command 输入交给 Lifecycle；Lifecycle 不重新获得完整 `AppContext`。

`AgentService.sendMessage()` 在过渡期只做兼容委派：调用 Session / Interaction 入口并透传结果/错误，不持有 transaction、runtime context 或 enqueue failure 规则。

### 原子 activation capability

为保持当前事务，建议引入概念上的：

```text
activateUserRunAtomically(input)
```

它不是通用 repository CRUD，也不是第二个 application use-case；它是由 `startUserRun()` 独占调用的跨域原子 persistence capability，负责在同一 SQLite transaction 中：

```text
re-check / obtain session head as required
  → append completed user item
  → first message title update
  → insert client request dedup
  → create running run record
  → set run-state running + activeRunId
```

建议返回显式结果：

```text
deduplicated(messageItemId, runId)
activated(messageItemId, runId, activation metadata)
conflict / not-found / mismatch（仅保留当前需要的精确语义）
```

注意：

- authoritative dedup check/insert/result 必须在该 transaction 内；现有 transaction 外 dedup 查询若保留只能是非权威快路径；
- 不得将 transaction 拆成 Session 写 user item、Lifecycle 再写 run 的两个提交；
- 不得让 Route 先调用“create run”再调用“enqueue”；
- transaction callback 的实现归属固定为 `AtomicRunActivationPersistence`，调用归属固定为 `RunLifecycleApplication.startUserRun()`；Session / Interaction 不直接调用该 capability；
- capability 承载跨域原子写不等于 title/dedup 产品语义改归 Lifecycle，语义输入仍由 Session / Interaction command 明确提供。

### Runtime context

当前 Route 通过 `service.getContext()` 获取 workspace run context。目标应改为窄能力：

```text
WorkspaceRunContextReader.get(workspaceId)
```

`RunLifecycleApplication.startUserRun()` 在 activation 成功后调用该 reader 获取：

```text
workspacePath
workspaceRepoDirNames
```

缺少 workspace run context 的当前错误语义必须由 P0 冻结。不得暴露完整 `AppContext`。

### Enqueue 与 response

目标流程：

```text
Session/Interaction send command
  → Lifecycle activate
      → deduplicated: 直接返回，不 enqueue
      → activated: runtime.enqueueRun
          → success: 返回当前 201 response
          → failure: conditional DB settlement → 保持当前错误映射
```

Route 只负责 schema、调用和 `201`，不感知 `deduplicated` 后是否 enqueue。Public enqueue failure 的精确 status/body 尚未冻结，必须由 P0 characterization 定稿；定稿后错误由 Lifecycle 产生、facade 透传、Route/全局 handler 序列化。

### Enqueue failure 决策

本方案定稿结构责任，但行为细节受 P0 证据门禁：

- enqueue failure 的收敛必须属于 Lifecycle；
- 必须使用条件更新，不能覆盖已 terminal/cancelled 的 run；
- run-state 只在 `activeRunId` 仍匹配时回收；
- `cancel wins`；
- prompt static cache 在 run 实际转 terminal 时失效；
- trigger user item/dedup 是否保留，以 P0 当前事实为准；默认不删除已提交用户命令；
- 同一 clientRequestId 的 retry 是否重新 enqueue，必须在 P0 决策；不能无意造成永久 dedup 到 failed run 或重复运行；
- Public/internal/compact/subtask 等入口应复用同一基础 failure capability，但各领域是否追加 notice/compensation 由各自阶段决定。

推荐 persistence API 形态：

```text
failRunAfterEnqueueFailureIfCurrent({ workspaceId, sessionId, runId, updatedAt })
  → failed-and-idled
  → run-failed-state-not-current
  → already-terminal
  → missing-or-mismatch
```

具体 union 可简化，但必须可测试地表达条件结果，不使用无信息 boolean 掩盖竞态。

## Runtime control port

### 目标类型

`AgentRuntimePort` 应拥有独立 DTO，不从 `agent.service.ts` 导入类型：

```text
AgentRuntimeRun
  workspaceId
  sessionId
  runId
  inputText?
  workspacePath
  workspaceRepoDirNames
```

Port 只表达：

```text
enqueueRun(run)
cancelSession(sessionId)
```

不扩展为 Worker process manager、health、retry 或 Store 能力。

### Adapter 错误语义

必须明确两层：

- runtime adapter：负责 transport、timeout、Shared response validation；
- Lifecycle：负责 enqueue failure DB 收敛和 cancel best-effort 业务时机。

`AgentWorkerClient.cancelSession()` 当前自行吞错并 warning。P0/P2 必须选择并记录：

- 保持 adapter 内 best-effort，Lifecycle 只保证调用顺序；或
- 让 adapter 抛 transport error，由 Lifecycle 统一 `allSettled + warning`。

选择不得造成 HTTP 行为变化、重复 warning 或 cancel failure 回滚 DB。初稿倾向第二种更清晰的 port 语义，但它是行为可观察变化，必须以 P0 证据和独立审查为前提；未通过则保持现状并文档化 adapter 差异。

## 本地 fallback 依赖收窄

`AgentRuntime` 不应依赖完整 `AgentService`。建议注入一个窄 execution facade：

```text
LocalRunExecutionPorts
  getPromptContextForRun
  appendContextItemFromWorker
  updateContextItemFromWorker
  updateRunStateFromWorker
  completeRunFromWorker
  getSessionHead / getSession（仅当前异常 notice 所需）
```

更进一步可将本地 runtime 只依赖已存在的 Read-side、Writeback、Lifecycle applications。无论形态：

- 不重写 processRun 控制流；
- 不改变本地输出文本；
- 不增加 running abort；
- 不让 Lifecycle 反向依赖本地 runtime 实现；
- API-managed Worker 和 local fallback 共用相同 lifecycle/writeback 权威。

## Worker run-state use-case

### 输入与合同

继续使用现有 Shared：

```text
AgentApiRunStateRequest
```

不创建新的 transport schema。内部可映射为窄 persistence command。

### 目标规则

Lifecycle application 负责：

- 规范化 activeRunId；
- active run switch guard；
- ownership guard；
- terminal run guard；
- notice/token 缺省与显式值语义；
- applied item 计算；
- run-state 与 run record 的写入编排。

Persistence 必须提供足以阻止 late state 覆盖 cancel/terminal 的条件能力。P0 若证明当前 application 先读后写存在可复现竞态，必须暂停结构迁移并设计原子条件更新；不得以“保持结构”等名义复制已知缺陷，也不得无授权引入 lease/generation。

### Response

继续返回：

```json
{ "ok": true }
```

当前 no-op 也不改变 response。不得新增 ignored 字段。

## Complete use-case

### 目标流程

```text
validate run identity/ownership/terminal
  → atomic terminal settlement
      → update run record
      → cancelled: settle this run's non-terminal context items
      → if activeRunId matches: run-state idle
  → invalidate prompt static cache at current equivalent time
  → publish run-completed event at current equivalent time
```

当前实现把 cache invalidation 调用放在 DB transaction callback 中。目标拆分必须先明确它是否可能抛错。默认保持外部可观察结果，不得让 cache/event 失败回滚已完成的 DB terminal settlement，除非 P0 证明当前行为与此不同并经审查决定。

### Persistence result

建议返回：

```text
settled(finalStatus, runStateIdled, contextItemsChanged)
already-terminal
missing-or-mismatch
```

Application 使用结果决定 cache/event；不得发布与实际 terminal settlement 不一致的事件。重复 complete 的 event 是否重复发布，按当前 terminal no-op 保持不发布。

### Cancelled context items

保持：

- 只处理该 run、workspace、session 下的非终态 item；
- tool item 规范化 cancelled output；
- assistant/user/system 保留 output 只改 status；
- 不吸收 0007-B 的普通 Worker item update 规则。

## Cancel use-case

### 目标入口

```text
cancelSession({ workspaceId, sessionId })
  → atomic cancel cascade settlement
  → runtime cancel each returned target, best-effort
  → return current AgentControlResult
```

Facade/Route 不再暴露需要二次拼装的 `{ result, runtimeCancelSessionIds }` 作为 public application boundary；runtime targets 是 Lifecycle 内部结果。

### Active child query

Lifecycle 依赖：

```text
ActiveSubtaskChildQuery.listByParentRun({ workspaceId, sessionId, runId })
```

该 capability：

- 由 durable lineage 查询实现；
- 只返回 cancel 所需 child session identity；
- 不暴露 Subtask start/reuse/result/orphan；
- 不使用 `subtaskSessionId` 展示字段替代 durable lineage；
- 不让 Subtask application 依赖 Lifecycle cancel 实现形成循环。

### Atomic cancellation

cancel use-case 调用的 atomic cancellation persistence capability 必须保持一个 transaction 覆盖：

- root/active child target 确定所需的一致读取；
- 非终态 context item cancelled；
- related in-flight run cancelled；
- active run 必要收敛；
- run-state idle；
- 返回 runtime cancel targets。

Prompt cache 是内存能力，是否在 transaction callback 内调用由 P4 机械迁移证据决定；无论如何 DB 收敛不能被 runtime cancel 失败回滚。

### Runtime best-effort

DB transaction 成功后：

```text
Promise.allSettled(cancelSession(targets))
  → rejected: warn limited identity
  → never mutate DB back
  → return success result
```

不得：

- runtime cancel 先于 DB；
- 一个 child runtime 失败阻止其他 target；
- 将 runtime failure 返回为 cancel HTTP failure；
- 因本地 runtime 不能停止 running task而改变 DB cancelled 状态。

## Cache invalidation

Prompt static cache invalidation 属于 Lifecycle 的 terminal side effect。已由当前实现/上位设计明确纳入的路径至少覆盖：

- normal complete；
- failed complete；
- cancelled complete；
- cancel cascade 的每个相关 run；
- enqueue failure 实际将 run 转 failed。

startup fail 是否需要显式 invalidation **不是已定稿事实**。P0 必须确认进程启动时 cache 实例生命周期、是否存在同进程可观察路径，以及提取后是否需要由“实际 running → failed”结果触发 invalidation；P5 只实施 P0 审查通过的结论。

不得在非 terminal/no-op 分支误清其他 active run cache。Read-side 只提供窄 invalidation capability，不依赖 Lifecycle application；若 P0 决定 startup fail 无需显式 invalidation，也必须记录证据与适用边界。

## Run completed event

Event publisher 是窄 port：

```text
publishRunCompleted({ workspaceId, sessionId, runId, finalStatus, occurredAt })
```

保持当前 `agent.run.completed.v1` payload 与 SSE 行为。本阶段不扩张事件合同，也不为 cancel/recovery 新增事件，除非 P0 证明已有合同要求。

## Facade 迁移

迁移后 `AgentService` 可继续暴露：

```text
sendMessage()
failRunOnEnqueueFailure()（过渡期如仍有调用）
cancelSession()
updateRunStateFromWorker()
completeRunFromWorker()
```

但要求：

- 已迁移入口只做兼容委派；
- 不保留旧 lifecycle 权威逻辑；
- Route 不直接调用 lifecycle Store/runtime helper；
- 本地 fallback 不通过完整 service 获得所有能力；
- 最终 facade/route 注入形态留到 Session/Routes/Module 收尾。

## 关键不变量

- activation 原子性不弱化；
- deduplicated 不 enqueue；
- DB 收敛优先；
- `cancel wins`；
- terminal run 不回退 running；
- active run 已切换时晚到 state/complete 不污染当前 state；
- runtime cancel 失败不回滚 DB；
- enqueue failure 不覆盖 cancel/complete；
- recovery final fence 保留；
- terminal cache invalidation 不遗漏；
- API-managed Worker 与本地 fallback 共用权威规则。
