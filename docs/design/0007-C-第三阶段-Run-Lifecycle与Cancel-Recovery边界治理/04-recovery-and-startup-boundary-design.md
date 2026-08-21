# Recovery 与 Startup 边界设计

## 定位

0006 已冻结：

```text
Run Lifecycle 拥有 startup recovery candidate 与 enqueue 前最终 DB fence
Module 只做依赖构造、route 注册、startup hook 触发和进程生命周期
可选跨域 startup coordinator 只能调用多个职责域 use-case，不得包含领域规则
```

当前 `agent.module.ts` 同时包含 lifecycle recovery、subtask orphan scan、archive pending reconcile 和进程装配。本阶段只迁移 Run Lifecycle recovery 领域规则，不提前吸收 orphan/archive。

## 当前启动时序

```text
registerAgentModule()
  → construct AgentService
  → choose AgentWorkerClient or local AgentRuntime
  → construct optional Plugin Host manager/client
  → register routes
  → subtask orphan scan
  → archive pending reconcile
  → choose startup-recovery mode
      fail mode: synchronously call service.failRunsOnStartup() before listen
      recover mode: register app.onListen hook; do not recover yet
  → if API-managed Worker is enabled, await workerManager.start()
  → register worker onClose stop hook
  → Fastify starts listening
  → invoke registered onListen hooks
      recover mode: await service.recoverRunsOnStartup({ runtime })
```

`onListen` 的**注册**与 recovery 的**执行**必须区分：recover hook 在 `workerManager.start()` 前注册，但仅在 Fastify 实际开始监听后执行。worker-enabled 场景中，模块注册会先 await `workerManager.start()`；因此正常进入 `onListen` 时 worker 已完成启动。若 worker 启动失败，模块注册失败，监听和 recover hook 都不会发生。

以上仅描述模块内的控制流与 await 边界；不把它表述为跨进程 API 回调 readiness 的额外保证。

## 目标结构

```text
Agent Module / Lifecycle startup hook
  ├─ construct dependencies
  ├─ register routes
  ├─ invoke Run Lifecycle recovery use-case
  ├─ invoke subtask/archive hooks（仍归各自现状/后续阶段）
  └─ manage Worker/Plugin Host process lifecycle

RunLifecycleApplication
  ├─ failRunsOnStartup()
  └─ recoverRunsOnStartup()
      ├─ LifecycleRecoveryPersistence
      ├─ RuntimeControlPort
      ├─ WorkspaceRunContextReader
      ├─ TriggerInputReader
      ├─ PromptCacheInvalidator
      ├─ clock
      └─ logger
```

可以选择：

- module 分别通过薄 startup hooks 调用 lifecycle/subtask/archive use-cases；或
- 后续引入一个极薄的跨域 `AgentStartupCoordinator`，只按顺序调用多个 application use-cases。

本阶段默认前者，不要求创建 coordinator。强制要求是：candidate、final fence、DB terminal 收敛全部属于 `RunLifecycleApplication` 的 recovery use-cases，不在 module/startup hook 中实现。

## Recovery use-case 责任

负责：

- 根据配置执行 fail 或 recover use-case；
- list/filter candidate；
- enqueue 前 final DB fence；
- trigger input 与 workspace runtime context 读取；
- recover enqueue failure 隔离；
- fail mode 的 context/run/run-state/notice 收敛，以及按 P0 决策处理 cache；
- dirty in-flight session 回收；
- 有限、脱敏日志。

不得：

- 构造 Fastify routes；
- 管理 Worker/Plugin Host 进程；
- 执行 Subtask orphan 或 Archive reconcile；
- 依赖完整 `AgentService`/`AppContext`；
- 将单 candidate 失败抛成启动失败；
- 修改 Shared/DB schema 或引入 lease/generation。

## Recover mode

## Candidate 查询

当前 `listRecoverableRuns()` 返回 run-state 为 running 且 `active_run_id` 非空的行，并 left join run trigger item。该列表只是初始候选，不是 enqueue 权威。

目标 persistence capability 至少表达：

```text
listRecoverableRunCandidates()
getRecoverableRunForEnqueue(candidateIdentity)
```

或一个可重复调用的等价条件查询。最终条件必须同时成立：

- session 存在且 workspace 匹配；
- run record 存在；
- run status 为 running；
- run workspace/session 匹配；
- session run-state 为 running；
- `activeRunId === candidate.runId`。

不得只依赖初始 list 结果，也不得在 application 用多个无事务普通读后直接假设状态稳定。

## Enqueue 前最终 DB fence

目标顺序：

```text
list candidate
  → initial eligibility check
  → read runtime context / trigger input
  → optional controlled test hook
  → final DB eligibility check
  → runtime.enqueueRun()
```

final check 是 `cancel wins` 的关键边界：

- final check 前 cancel：不得 enqueue；
- final check 后 enqueue 调用已发出：不承诺强停；
- enqueue 后发生 cancel：DB cancelled 与 Writeback/Lifecycle fences 保证最终收敛。

本阶段不得把 final check 删除、合并为初始查询，或用缓存结果替代。

如果实现需要更强的“check 与 enqueue 原子性”，必须停止。DB 与外部 runtime 之间当前没有分布式事务；0006 明确接受 DB fence 收敛，不在本阶段引入 outbox/lease。

## Runtime payload 恢复

Recover 需要：

- run identity/metadata；
- workspace path/repository names；
- trigger user text（若 trigger item 存在且为 user_text）。

这些应通过窄 reader 获取，不得通过 `service.getContext()` 暴露完整上下文。缺少 workspace run context 当前为 skip，不应擅自改成启动失败；P0 需确认日志/可观察行为。

## Enqueue failure isolation

保持：

```text
for each candidate
  try enqueue
  catch → warn limited identity → continue
```

Recover mode 的 enqueue failure 当前不立即将 DB run 置 failed。它只跳过并继续启动；该差异与正常新 run 的 enqueue failure 必须在方案和测试中明确，不得机械统一。

原因：startup recover 的既有目标是 best-effort 恢复且不阻塞启动。若要改变为 fail terminal，需要单独行为设计与用户授权。

## Fail mode

### 目标收敛

对于每个 recoverable candidate，保持以下独立、best-effort 步骤：

```text
fail non-terminal context items for run
  → fail run record if still running
  → reset run-state idle only if activeRunId still matches
  → invalidate prompt cache when run actually became terminal
  → append system notice only when current run-state was reclaimed and meaningful changes occurred
```

当前实现把各步骤分别 try/catch，而不是一个全量 transaction。P0 必须冻结这一失败隔离政策；结构迁移不得自动改为“一步失败全回滚”或无条件 transaction。

### 条件能力

必须保留：

- `failRunRecordIfInFlight()`：只更新 running；
- `setRunStateIdleIfActiveRunMatches()`：status running + activeRunId CAS；
- context item 只处理 `streaming/queued/running`；
- active run 已切换时不回收新 run state；
- terminal/missing run 不被重写。

### Notice

当前 notice 为 best-effort，并只在：

- run-state 本次确实回收；且
- context item 或 run record 本次有变化

时尝试追加。`AgentConflictError` 被忽略，其他错误 warning。

本阶段保持文本、触发条件、item kind/status/boundary/output 不变。不将 notice 迁入 Context Writeback application，因为它是 startup recovery 的领域副作用；但写入可以依赖窄 context append persistence capability。

### Dirty run-state

当前额外扫描：

```text
status=running && activeRunId=null
```

并使用 `setRunStateIdleIfNoActiveRun()` 条件回收。保持单 session 失败不阻塞其他项。

## Prompt cache invalidation

该问题是 **P0 待证据确认的独立决策门禁**，不是本方案已经决定“必须清理”或“无需清理”。当前只读事实仅为：startup fail 实现中未见显式 `clearRunPromptStaticCache()` 调用。

P0 必须确认并记录：

- fail recovery 是否通过其他路径清 cache；
- startup fail 执行时使用的 cache 实例是否必然为空，生命周期起止点在哪里；
- 是否存在同进程测试、重复注册、手动调用或未来装配方式使 stale cache 可观察；
- 若需要显式 invalidation，是否仅在 `failRunRecordIfInFlight()` 实际发生 `running → failed` 时按 runId 触发；
- 若无需显式 invalidation，证据、适用前提和防止未来装配改变前提的结构审计项；
- cache failure 是否可能影响 startup best-effort，以及对应测试/日志政策。

P0 未通过该门禁前：

- P2 不得把 cache invalidator 作为 recovery 必选调用写死；
- P5 不得新增、删除或声称保持 startup fail cache 行为；
- 验收不得以“所有 terminal 路径必然清 cache”概括 startup fail。

## Startup hook 时机

### Fail mode

保持在 listen 前完成 DB cleanup，避免外部请求进入后观察到旧 in-flight 状态。当前 Module 直接同步调用薄 facade：

```text
service.failRunsOnStartup()
```

该 use-case 自身保证 best-effort，不应因单 candidate 错误拒绝模块启动。

### Recover mode

保持 `onListen` 触发，避免在 API 尚未监听时恢复 Worker 主链。当前 Module 先注册：

```text
app.addHook("onListen", async () => {
  await service.recoverRunsOnStartup({ runtime })
})
```

随后（仅 worker-enabled）在模块注册阶段 `await workerManager.start()`。所以 hook 注册早于 worker start，而 hook 执行晚于成功的 worker start 和 Fastify listen；不得将“已注册 hook”误写成“已开始 recovery”，也不得移动 recovery 到 listen 前。

### Module 边界

迁移后 `agent.module.ts` 可以保留：

```text
if recoveryMode === fail:
  service.failRunsOnStartup()           // before listen
else:
  app.addHook("onListen", () => service.recoverRunsOnStartup({ runtime }))
await workerManager.start()             // only when worker-enabled; hook executes later on listen
```

但不得保留：

- Store imports for lifecycle candidate/CAS；
- trigger item/active run 判定；
- enqueue per-candidate loop；
- fail context/run/state；
- startup notice 构造。

## Startup coordinator 决策

本阶段选择：

- 不创建统管所有域的 startup coordinator；
- 暴露薄 `RunLifecycleStartupHook`，它只调用 `RunLifecycleApplication` recovery use-cases，由 module 触发；
- 若为测试/装配需要创建 coordinator，它只能按已定义顺序调用：
  - lifecycle recovery；
  - subtask orphan hook；
  - archive reconcile hook；
- coordinator 不得导入 Store、读写 DB 或处理 candidate；
- orphan/archive 的内部迁移仍留后续阶段。

这满足 0006“module 只触发”目标，同时避免本阶段建立新的全能 startup service。

## 测试 seam

现有 `enqueueRecoveringRuns(..., options.beforeFinalCheck)` 提供 final-fence race 构造。迁移时可：

- 保留为 recovery use-case 的受控测试 seam；或
- 使用 fake runtime/受控 persistence barrier 表达相同时序。

要求：

- seam 仅服务 recovery final-check 竞态；
- 不进入 Shared/生产合同；
- 生产默认无行为；
- 不扩张 `AppContext.agentTestFaults`；
- 不用 sleep 作为唯一 race 证据；
- 不允许任意访问内部 DB 状态。

## Logging 边界

允许记录：

```text
workspaceId
sessionId
runId
candidate count
error object
```

不得记录：

```text
internal token
inputText
prompt/messages
完整 context output/tool args/result
workspace 敏感绝对路径
```

单 candidate warn 与最终汇总日志应保持可诊断但不过量。

## 完成条件

- `agent.module.ts` 不再导入 lifecycle Store candidate/CAS/settlement 函数；
- recover candidate 与 final DB fence 有单一权威；
- fail/recover 两种模式由 `RunLifecycleApplication` 的明确 use-cases 表达；
- final check 前 cancel 仍不 enqueue；
- enqueue 发出后 cancel 仍由 DB/writeback fence 收敛；
- 单 candidate failure 不阻塞后续或启动；
- fail mode 的条件更新、notice 与 dirty state 行为保持；
- module 仅选择 hook 时机并调用 use-case；
- recovery 不依赖完整 `AgentService`/`AppContext`；
- startup fail cache invalidation 已按 P0 证据形成明确“需要/不需要”的决策、测试和结构审计结论；
- startup 与 API-managed Worker/local fallback 回归通过。
