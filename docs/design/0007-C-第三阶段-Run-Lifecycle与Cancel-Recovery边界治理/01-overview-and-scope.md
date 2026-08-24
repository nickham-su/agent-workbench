# 背景、目标与范围

## 与上位方案的关系

`0006-Agent模块结构治理总方案` 已明确治理顺序：

```text
基线与最小 testkit
  → Read-side / Prompt
  → Context Writeback
  → Run Lifecycle
  → Subtask
  → Compaction / Archive
  → Session / Routes / Module 收尾
  → Worker 结构评估
```

已完成前置阶段：

```text
0007-A：Read-side / Prompt
  0f57bfe feat(agent): implement phase 1 read-side governance

0007-B：Context Writeback / Artifact
  04499bb feat(agent): implement phase 2 context writeback governance
```

本方案是 0006 下的第三阶段实施设计，不是新的总体蓝图。它依赖 0007-A 的 prompt static cache/read-side 边界和 0007-B 的 context writeback fence，但不得反向重写两个已完成阶段。

## 当前仓库前提

方案起草时只读确认：

```text
branch: v1.1
relative to origin/v1.1: ahead 1
HEAD: 04499bb
worktree/index: 无既有未提交变更；本方案将新增文档
```

该快照不是实施阶段的静态假设。P0 及每批开始前必须完整记录 `git status --short --branch`；任何非本阶段 staged/worktree/untracked 变更都视为用户变更，不得覆盖、清理、暂存、取消暂存或混入阶段操作。

## 为什么现在治理 Run Lifecycle

0007-B 已使 Worker context create/update 的 late fence、ownership、terminal 单向收敛和 artifact 边界拥有明确权威。下一步需要收敛与其相邻、但不能混入 Writeback 的 run 生命周期规则。

当前 lifecycle 规则可运行且已有较强集成证据，但分散在：

```text
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.routes.ts
apps/api/src/modules/agent/agent.module.ts
apps/api/src/modules/agent/agent.store.ts
apps/api/src/modules/agent/agent.runtime-port.ts
apps/api/src/modules/agent/agent.runtime.ts
apps/api/src/modules/agent/agent.worker-client.ts
```

主要混杂点：

- `AgentService.sendMessage()` 同时处理用户命令、dedup、user item、run record 和 run-state；
- Public/internal Route 在 service 持久化之后直接构造 runtime payload 并 enqueue；
- Public message route 与 internal trigger/compact route 的 enqueue failure 处理不一致；
- cancel 的 DB 收敛在 Service，runtime best-effort 与 warning 在 Route；
- Worker state/complete、terminal cache invalidation、run-completed event 仍由大 Service 编排；
- startup recovery candidate、最终 DB fence、fail/recover 规则直接位于 `agent.module.ts`；
- `AgentRuntimePort` 的 run 类型从 `agent.service.ts` 导入，本地 fallback `AgentRuntime` 直接依赖完整 `AgentService`。

因此本阶段必须定稿核心责任分界，不能将 `sendMessage()`、cancel 或 recovery 的核心边界继续推迟到最终 Route/Module 收尾阶段。

## 当前高层调用链

### Public message

```text
POST /api/agent/sessions/:sessionId/messages
  → AgentService.sendMessage()
      → session/workspace/subtask/text/dedup/idle/profile
      → 单 transaction：user item + title + dedup + run record + run-state
  → Route 解析 workspace run context
  → runtime.enqueueRun()
```

只读调研确认 Public message route 当前未调用 `failRunOnEnqueueFailure()`；这是 P0 必须补 characterization 的事实缺口，不能仅凭源码推断产品期望。

### Internal trigger / compact

```text
internal trigger 或 compact
  → Service 创建 run/run-state
  → Route runtime.enqueueRun()
  → catch：Service.failRunOnEnqueueFailure()
  → 重新抛出 runtime 错误
```

### Cancel

```text
POST /api/agent/sessions/:sessionId/cancel
  → AgentService.cancelSessionCascade()
      → 单 transaction：收集 active cascade targets
      → context items / run records / run-state / cache 收敛
  → Route Promise.allSettled(runtime.cancelSession(target))
      → rejected 仅 warning
```

### Worker state / complete

```text
Worker / local fallback
  → internal updateRunState / completeRun Route 或 facade
  → AgentService lifecycle methods
  → run record / run-state / context terminal / cache / event
```

### Startup recovery

```text
registerAgentModule()
  → fail mode：listen 前 failRecoveringRuns()
  → recover mode：onListen enqueueRecoveringRuns()
  → module 内 candidate / final fence / enqueue / fail 收敛
```

## 阶段目标

### 结构目标

- 建立唯一的 Run Lifecycle application 边界及其明确 use-cases；
- 让 run activation、enqueue failure、state/complete、cancel、recovery 与各自适用的 cache invalidation 规则有单一权威实现；startup fail cache 规则由 P0 先定稿；
- 定稿 `sendMessage()` 的跨域协作接口、事务边界和错误归属；
- 保留 `AgentService` 兼容 facade，不在本阶段定稿最终 route/facade 位置；
- 让 Lifecycle 只依赖窄 persistence、runtime、run-context、child-query、cache、event、clock/logger 能力；
- 让 module 只负责 composition root、route 注册、startup hook 触发和进程生命周期；
- 从 runtime port/type 和本地 fallback 中移除对完整 `AgentService` 的不必要依赖。

### 行为目标

- 保持现有 Shared request/response schema、HTTP status/body 与 Worker validation；
- 保持 user item/dedup/run/run-state 的事务原子性；
- 保持 dedup 不重复 enqueue；
- 保持 `cancel wins`、DB-first、runtime best-effort；
- 保持 active child 精确 cascade；
- 保持 terminal run、active-run switch 和 late state/complete 的当前 guard；
- 保持 complete/cancel 对 context item 的既有收敛差异；
- 保持 complete/cancel/enqueue failure 等已确认路径的 prompt static cache invalidation 与 run-completed event 时机；startup fail cache 不预设结论；
- 保持 recovery candidate、最终 DB fence、单 candidate 失败隔离和 dirty state 回收。

### 验证目标

- 真实 SQLite 证明 activation transaction、cancel transaction、terminal/CAS 与 recovery final fence；
- lifecycle use-case tests 证明 enqueue failure、runtime best-effort、cache/event 副作用和调用顺序；
- 真实 Fastify Route 证明 schema/auth/status/response 与 route 只做 transport；
- startup tests 证明 fail/recover、cancel race 与 failure isolation；
- API-managed Worker 证明 send → enqueue → writeback → complete/cancel 主链未断；
- 本地 fallback 证明收窄依赖后仍能执行与完成；
- Worker runtime tests 继续证明 abort/cancel 的 transport/runtime 语义；
- UI 手工或经审查的豁免说明覆盖基本对话、流式、取消、刷新与立即新运行。

## 纳入范围

### Session / Interaction 与 activation 协作

纳入：

- `sendMessage()` 的用户命令与 lifecycle 分界；
- session/workspace/subtask/text/dedup/idle/profile 当前顺序的基线；
- user item、首条消息 title、dedup、run record、run-state 的单 transaction；
- run identity、runtime payload 与 workspace run context 的构造边界；
- deduplicated 与 newly scheduled 结果的明确区分；
- Public/internal/compact 入口的 enqueue failure 归属与条件收敛。

本阶段可以引入内部 command/result 类型，但不得改变 public Shared/HTTP DTO。

### Run state / complete

纳入：

- `updateRunStateFromWorker()` 的 active-run、ownership、terminal guard；
- `runNoticeText`、token 与 idle notice 清理的既有映射；
- `completeRunFromWorker()` 的 terminal no-op、run record、cancelled items、run-state idle；
- terminal prompt static cache invalidation；
- run-completed event 发布。

### Cancel

纳入：

- root session validation；
- current active run 对应的 durable child session 查询；
- 单 transaction cancel cascade；
- non-terminal item、related run、active run 与 run-state 收敛；
- DB 成功后 runtime cancel targets；
- runtime cancel `allSettled` 与有限 warning。

### Recovery / startup

纳入：

- `fail` 与 `recover` 两种现有模式；
- recoverable candidate 查询与一致性检查；
- enqueue 前 final DB fence；
- trigger user text 与 workspace run context 读取；
- 单 candidate enqueue failure 隔离；
- fail mode 的 context/run/run-state/notice 收敛；
- `running + activeRunId=null` 脏状态回收；
- module/startup hook 的触发边界。

### Runtime ports

纳入：

- `AgentRuntimePort.enqueueRun()` / `cancelSession()`；
- runtime run DTO 不再从完整 service 类型反向导入；
- 本地 fallback 依赖 prompt query、writeback、state/complete 等窄能力；
- API-managed Worker adapter 的既有 transport/error 语义回归。

## 明确排除

### Subtask 主体

不纳入：

- prefork plan；
- start/reuse/unique race；
- durable lineage 创建/修复；
- result/status use-case；
- local compensation；
- orphan scanner。

Lifecycle 只消费一个窄的 active child query capability。若该 capability 无法在不迁移 Subtask 主体的情况下表达，必须暂停并重新设计依赖方向。

### Compaction / Archive

不纳入：

- compaction use-case 主体迁移；
- archive、rollback、sidecar、reconcile 规则；
- archive fault seam。

compact/其他 run 启动入口只需复用 lifecycle enqueue failure 能力，不得借机重构其领域主体。

### Session / Routes / Module 最终收尾

不纳入：

- Session query/fork/revert/clear 全量拆分；
- Context Query 最终归属；
- `AgentService` 是否长期保留；
- routes 注入多个 use-case 还是结构化 application 集合的最终选择；
- 全部 startup 域统一 coordinator 的最终目录。

本阶段只要求 lifecycle 核心规则离开 Route/Module；最终 facade、目录和 route 分组留到收尾阶段。

### 合同、数据、Worker 与 UI

不纳入：

- Shared endpoint/schema/public export 变化；
- DB schema、migration 或状态枚举变化；
- Worker Runner/provider/builtin 主控制流重写；
- UI 页面、文案或交互变化；
- 跨进程强一致取消、lease、generation、outbox；
- 全局 retry/timeout/error envelope 重设计。

## 关键责任边界

```text
Session / Interaction application
  负责：
    用户命令与 transport-independent 前置语义
    session/workspace/subtask/text 校验
    client request dedup 语义
    跨域入口
    调用显式 Lifecycle activation 能力

Run Lifecycle application
  负责：
    run activation 与 run-state
    runtime enqueue 与 enqueue failure
    Worker state/complete
    cancel DB 收敛与 runtime best-effort
    recovery use-cases
    terminal cache/event 时机

Atomic lifecycle persistence capability
  负责：
    user item + title + dedup + run + run-state 原子激活
    terminal/active-run 条件更新
    cancel transaction
    recovery candidate/CAS/final fence

Runtime control port
  负责：
    enqueue run
    cancel session
    transport/runtime 适配

Startup trigger
  负责：
    选择 fail/recover hook 时机
    调用 lifecycle recovery use-case
    不含 candidate/fence/DB 收敛规则
```

依赖方向必须保持：

```text
Session / Interaction → Run Lifecycle
Run Lifecycle → lifecycle persistence
Run Lifecycle → runtime control port
Run Lifecycle → durable child query capability
Run Lifecycle → prompt cache invalidation / run event port
Module → startup hooks / applications
Route → facade/application transport entry

Route  ↛ Store/runtime sequencing
Module ↛ lifecycle Store 领域规则
Run Lifecycle ↛ 完整 AgentService
Run Lifecycle ↛ Subtask application 主体
```

## `sendMessage()` 协作决策

本阶段采用以下权威分界，不再把最外层 transaction callback 的归属留给 P2/P3 自由选择：

| 环节 | 唯一权威 | 约束与错误归属 |
|---|---|---|
| Public/internal transport | Route | 只负责 schema、auth、调用 facade/应用入口、声明并发送既有 HTTP response；不得读取 Store/context、决定是否 enqueue 或执行补偿 |
| 用户命令前置语义 | Session / Interaction application | 负责 session/workspace/subtask/text 校验、profile 解析输入、client request dedup 的产品语义和 public response 解释；对应 `400/404` 用户命令错误由此产生 |
| run-start 顶层编排 | `RunLifecycleApplication.startUserRun()` use-case | 接收已规范化命令，拥有 activation → runtime context → enqueue → failure settlement 的完整顺序；session running/activation conflict、runtime context 和 enqueue 错误归此 use-case |
| 原子 activation transaction | `AtomicRunActivationPersistence` capability，由 `startUserRun()` 唯一调用 | transaction callback 的唯一实现与调用权威；同一 transaction 内完成 user item、首条 title、dedup authoritative check/insert、run record、run-state，不得由 Session / Interaction 或 Route另开 transaction |
| Runtime context 读取 | `RunLifecycleApplication.startUserRun()` 通过 `WorkspaceRunContextReader` | 只在 `activated` 分支读取；`deduplicated` 分支不得读取或 enqueue；缺失 context 的当前 status/body 由 P0 冻结，之后由 Lifecycle 映射 |
| Runtime enqueue | `RunLifecycleApplication.startUserRun()` 通过 `RuntimeControlPort` | Route 不得调用；enqueue 成功后返回既有 send response |
| Enqueue failure DB 收敛 | Run Lifecycle application + conditional lifecycle persistence | 必须先按 P0 决策收敛，再向上抛出 runtime error；不得覆盖 cancelled/terminal/new active run |
| HTTP 错误外观 | 产生错误的 application/use-case + 兼容 facade 透传；Route/全局 error handler 负责 transport 序列化 | Route 不得把领域错误重新解释为另一业务错误；Public enqueue failure 的精确 status/body 仍是 P0 门禁 |

补充约束：

- Session / Interaction 是 `sendMessage()` 的用户命令入口，但不拥有 activation transaction 或 runtime sequencing；
- authoritative dedup check/result 必须位于原子 activation capability；现有 transaction 外 dedup 查询若保留，只能是非权威快路径，不得决定是否提交或 enqueue；
- `RunLifecycleApplication.startUserRun()` 返回 `deduplicated` 或 `activated-and-enqueued` 对应的既有 `AgentSendMessageResponse` 外观；不扩张 Shared/HTTP schema；
- `AgentService.sendMessage()` 过渡期只做兼容委派，不成为第五个编排层。

## 完成标准

- `sendMessage()` 核心责任分界不再后移；
- Route 不再直接获取 run context 后 enqueue，也不再执行 enqueue failure/cancel best-effort 编排；
- activation transaction 保持原子，dedup 与 conflict 语义保持；
- public/internal/compact 等入口通过同一 Lifecycle enqueue/failure 能力或明确记录的有意差异；
- state/complete/cancel/recovery、P0 已定稿的 cache 规则与 event 规则进入明确职责边界；
- module 中不再存在 recovery candidate/final fence/DB 收敛实现；
- runtime port 与本地 fallback 不依赖完整 `AgentService` 类型/对象；
- 真实 SQLite、Route、startup、API-managed Worker、本地 fallback 和 Worker runtime 测试完整；
- 结构审计确认 transaction owner、runtime context/enqueue owner、HTTP error owner、import 方向和旧权威残留符合上述表格；
- 所有偏差、停止决策、审查和回滚记录进入本阶段文档；
- 所有非本阶段 staged/worktree 变更保持原状。
