# 分批实施计划

## 固定实施节奏

每个批次遵循：

```text
实施前复核
  → 小批实现
  → 定向测试 + 必要回归
  → 独立审查
  → 修复
  → 独立复审
  → 用户明确允许后暂存
  → 下一批
```

不得因为方案覆盖 P0-P6 就一次性实施全部内容。P0 未冻结 Public message enqueue failure、cancel adapter 错误语义、startup 时序和 startup fail cache 决策前，不得定稿 P2 的相关 port 或进入 P3/P5；P2 骨架通过前不得迁移 send/cancel/recovery；P4 通过前不得从 module 移除 recovery 规则。

## 批次总览

| 批次 | 目标 | 生产代码范围 |
|---|---|---|
| P0 | 生命周期行为与竞态基线冻结 | 原则上不修改；必要 characterization tests |
| P1 | 最小 Lifecycle 测试地基与证据索引 | 测试代码；仅必要时最小扩展 fake runtime |
| P2 | Lifecycle application 骨架与窄依赖 | application/ports/persistence adapter/装配骨架 |
| P3 | sendMessage 跨域协作与 enqueue failure | Interaction/Lifecycle 协作、activation、Route/facade |
| P4 | state/complete/cancel 与 runtime best-effort | lifecycle application、facade、cancel child query、cache/event |
| P5 | startup recovery 与 module 边界 | Lifecycle recovery use-cases、startup hook、module 装配 |
| P6 | 清理、完整回归与最终审查 | 删除过渡实现、测试归属、文档/代码地图 |

批次可继续拆小；不得合并 P3-P5。

## P0：生命周期行为与竞态基线冻结

### 任务

- 首先完整记录 `git status --short --branch`，逐项标明 staged/worktree/untracked 归属；
- 复核 Public/internal send Route、Shared schema、HTTP status/body；
- 逐行记录 `sendMessage()` 前置语义和 activation transaction；
- 运行或补 characterization 证明 Public message enqueue failure 的 HTTP/DB/dedup 状态；
- 对比 Public/internal/compact/subtask run-start 入口及 `failRunOnEnqueueFailure()` 使用；
- 复核 enqueue failure 与 cancel/complete/active-run switch 的竞态；
- 复核 `AgentRuntimePort`、Worker adapter、local fallback 的 enqueue/cancel 语义；
- 复核 `AgentWorkerClient.cancelSession()` 内部吞错与 Route `allSettled` 的日志边界；
- 逐行记录 state/complete 的 guard、cache/event 时机；
- 逐行记录 cancel target traversal、transaction、runtime 顺序；
- 逐行记录 recover/fail mode、final check、notice、dirty state 与 startup hook 时机；
- 建立现有测试逐用例索引；
- 运行 Shared/API/Worker/local runtime 必要基线；
- 记录 cwd、命令、结果、耗时、预期日志和 teardown。

### P0 必答问题

- Public message enqueue 失败实际 response 与 DB 状态是什么；
- 相同 clientRequestId retry 是否重新 enqueue；
- Public/internal/compact 的 enqueue failure 差异是否有意；
- activation transaction 中 dedup/head/run-state 的最终冲突权威是什么；
- enqueue failure settlement 如何保证不覆盖 cancelled/terminal/new active run；
- Worker client cancel 吞错是否必须保留；
- local fallback queued/running cancel 当前行为；
- updateRunState missing run/terminal/switch 的实际矩阵；
- complete 的 cache/event 时机及异常政策；
- startup fail 是否需要显式 cache invalidation；cache 实例生命周期、可观察路径、触发条件、failure policy 与审计方式分别是什么；
- Worker process start 与 recover `onListen` 的实际时序；
-现有 fake runtime/testkit 是否足够构造 lifecycle race。

### 交付

- 更新 `02-baseline-and-evidence.md`；
- 更新 `07-code-map.md`；
- 必要 characterization tests；
- `09` 的命令、结果、缺口与决策；
- P1/P2 最小需求清单。

### 门禁

以下任一未定稿则停止：

- Public enqueue failure 事实不明确；
- 无法证明 activation 原子性；
- cancel/complete/failure 的竞态规则互相冲突；
- Worker cancel 错误可观察性变化无法判断；
- recovery final check 无确定性测试；
- startup fail cache 无法形成基于证据的“显式 invalidation / 无需 invalidation”决策及适用前提；
- local/API-managed runtime 路径缺少最低回归入口。

## P1：最小 Lifecycle 测试地基与证据索引

### 原则

优先复用 0007-A testkit：

```text
createAgentTestFixture()
createTestWorkspace()
injectJson()
createFakeAgentRuntime()
```

只在 lifecycle 直接需要时扩展：

- enqueue/cancel call order；
- configurable enqueue/cancel failures；
- before/after enqueue barrier；
- explicit run/session builders；
- deterministic clock/id。

不得：

- 引入 fake Store 代替 SQLite；
- 建立万能 lifecycle fixture；
- 扩张 `AppContext.agentTestFaults`；
- 将 archive/subtask 专属 helper 混入；
- 一次性拆空 `agent.integration.test.ts`。

### 建议测试文件

```text
apps/api/src/modules/agent/run-lifecycle.api.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle.persistence.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-recovery.test.ts
```

最终命名按项目风格调整。至少保留现有 integration 文件中的 representative route、startup 与 Worker 主链证据。

### 最低覆盖

- Public/internal send success/dedup/conflict/enqueue failure；
- activation transaction rollback；
- conditional enqueue failure；
- state late/terminal/switch；
- complete/cache/event；
- cancel transaction/runtime failure/child cascade；
- recovery final check/failure isolation/fail mode/dirty state；
- local fallback 与 API-managed Worker 代表性主链。

### 门禁

- 关键 DB 规则有真实 SQLite 证据；
- fake runtime 只测试 application/runtime 调用；
- 新测试可独立定位生命周期失败；
- 测试迁移不减少原断言；
- teardown/cwd 稳定。

## P2：Run Lifecycle application 骨架与窄依赖

### 任务

- 创建唯一 `RunLifecycleApplication` 骨架；
- 其 start/state/complete/cancel/recovery 均为 use-cases，不另建同级 recovery application；本阶段也不创建跨域 startup coordinator；
- 定义独立 `AgentRuntimeRun`/`AgentRuntimePort` 类型，不从 Service 导入；
- 定义窄 persistence capability/adapter；
- 定义 `WorkspaceRunContextReader`；
- 定义 active child query capability；
- 定义 prompt cache invalidation 与 event publisher ports；
- 定义 clock/id/logger 依赖；
- 在 `AgentService` 构造中装配，但不迁移全部行为；
- 为 facade/application 建立最小 wiring tests。
- startup fail cache port 是否为 recovery use-case 必选依赖，严格按 P0 决策表达；不得预先写死。

### 约束

- 新 application 不接收完整 `AgentService`/`AppContext`；
- Store 条件/transaction helper 继续是原子权威；
- 不建立长期 callback 壳层；
- runtime port 不吸收 process manager；
- active child query 不吸收 Subtask 主体；
- recovery 尚未迁移前 module 行为保持唯一权威。

### 门禁

- import 方向清晰且无 Lifecycle ↔ Service 循环；
- 骨架无重复生产规则；
- API-managed Worker/local runtime typecheck；
- facade 可逐批委派；
- 独立审查通过后进入 P3。

## P3：`sendMessage()` 跨域协作、原子激活与 enqueue failure

### 任务

- 建立 Session / Interaction → Lifecycle 显式 activation 接口；
- 保持 session/workspace/subtask/text/dedup 的用户命令语义；
- 将 user item/title/dedup/run/run-state 组织为单一 atomic activation capability；
- 将 workspace run context 读取从 `service.getContext()` 改为窄 reader；
- 将 runtime enqueue 移入 Lifecycle；
- deduplicated 分支由 `startUserRun()` 返回给 Session / Interaction，后者只映射既有 response；两层均不得 enqueue；
- 将 enqueue failure 条件收敛移入 Lifecycle；
- Public/internal send Route 只调用 facade；
- compact/其他现有调用复用基础 failure capability或记录有意差异；
- 删除 Route 中 send enqueue 编排与旧权威逻辑。

### 权威归属

- Session / Interaction：用户命令前置语义与跨域入口；
- `RunLifecycleApplication.startUserRun()`：activation、runtime context、enqueue、failure settlement；
- `AtomicRunActivationPersistence`：唯一 transaction callback；
- Route：schema/auth/调用/HTTP 序列化，不重解释业务错误；
- `AgentService.sendMessage()`：兼容委派。

### 关键门禁

- activation transaction 与当前 SQL/结果等价；
- Public enqueue failure 按 P0 决策实施且有测试；
- enqueue failure 不覆盖 terminal/cancelled/new active run；
- dedup retry 语义明确；
- HTTP status/body 不漂移；
- Route 不读取 service context 组织 runtime payload；
- import/call-site 审计证明 activation capability 只有 `startUserRun()` 调用，runtime context/enqueue/failure 不存在第二权威；
- user item/title/dedup 不因 runtime 失败被无授权删除；
- API-managed Worker 与 local fallback send 主链通过。

### 回滚

- 恢复 Route enqueue 与旧 `sendMessage()` 单一实现；
- 删除 activation application/adapter；
- 不改变 Shared/DB schema；
- 保留 P0/P1 characterization。

## P4：Worker state/complete、cancel cascade 与 runtime best-effort

### 任务

- 迁移 `updateRunStateFromWorker()` 至 Lifecycle；
- 迁移 `completeRunFromWorker()` 与 terminal persistence；
- 迁移 prompt cache invalidation 与 event publisher 时机；
- 迁移 cancel target collection 与 DB transaction；
- 通过 active child query capability 获取 durable child；
- 在 Lifecycle 内完成 DB 后 runtime `allSettled`；
- 定稿 Worker client cancel adapter 抛错/吞错边界；
- Route 只调用一个 cancel use-case；
- `AgentService` 保留薄 facade；
- 收窄本地 `AgentRuntime` 对 service 的依赖，但不重写执行流程。

### 门禁

- terminal/active-run guard 保持；
- cancelled complete 的 item 规则保持；
- cancel transaction 与 child 精确性保持；
- runtime cancel 失败不影响 DB/HTTP；
- terminal run 不被改写；
- cache invalidation 无遗漏/误清；
- duplicate complete 不重复 event；
- Shared/Route/Worker/local runtime 回归通过。

### 回滚

- state/complete 与 cancel 可分两个更小回退单元；
- 每个入口恢复 Service 旧唯一实现；
- Route helper 恢复时不得保留 application 双路径；
- 不触碰 Subtask 主体或 Worker Runner。

## P5：Startup recovery 与 module 启动边界

### 任务

- 在 `RunLifecycleApplication` 中创建 recovery use-cases，并创建薄 startup hook；
- 迁移 recover candidate、初步/final check、runtime payload 恢复；
- 保留 recover enqueue failure isolation；
- 迁移 fail mode context/run/state/notice/dirty state；
- 严格根据 P0 已审查决策处理 startup fail cache invalidation；若结论为无需显式调用，也要落下前提说明、测试和结构审计；
- 用窄 reader/capability 替代 `service.getContext()`；
- module 只选择 fail/recover 时机并调用 hook；
- 删除 module 中 lifecycle Store imports 与 helper；
- 保持 orphan scan/archive reconcile 当前边界；
- 保持 Worker/Plugin Host process lifecycle。

### 门禁

- final DB fence 不在 module 重复；
- cancel-before-final-check 不 enqueue；
- enqueue-after-final-check 竞态仍由 DB/writeback fence 收敛；
-单 candidate failure 不阻塞启动；
- fail mode 条件更新/CAS/notice/dirty state 保持；
- fail before listen、recover onListen 时机保持；
- module 不成为新的 startup application；
- startup/API-managed Worker/local runtime 回归通过；
- startup fail cache 的实现与 P0 决策一致，且无相反口径残留。

### 回滚

- 恢复 module 中 recovery 唯一实现；
- 删除新增 recovery use-cases/startup hook；
- 不影响 P3/P4 已稳定 Lifecycle；
- 不迁移 orphan/archive。

## P6：收尾、完整回归、结构审计与最终审查

### 清理

- 删除旧 Route enqueue/cancel helper 与 module recovery helper；
- 删除 Service lifecycle 双实现/legacy callback；
- 检索 Lifecycle 之外对关键 Store helper 的直接调用；
- 检查 runtime port 不依赖 service 类型；
- 检查 local runtime 不依赖完整 Service；
- 检查 module 不含 lifecycle SQL/Store 编排；
- 更新 `02/07/09` 与测试归属；
- 不为追求文件变小迁移无关测试。

### 结构审计

至少形成逐项可追溯结论：

- Route 不直接调用 `runtime.enqueueRun()` / `runtime.cancelSession()` 组织 lifecycle 时序；
- Route 不通过 `service.getContext()` 获取 runtime context；
- `AtomicRunActivationPersistence` 只有 `RunLifecycleApplication.startUserRun()` 直接调用；
- `AgentService` lifecycle 入口均为薄委派，无 transaction/fence/runtime 编排；
- `agent.module.ts` 不导入 lifecycle Store candidate/CAS/settlement helper；
- runtime port 类型不从 `agent.service.ts` 导入，local runtime 不持有完整 Service；
- active child query 保持窄 capability，不依赖完整 Subtask application；
- terminal/cache/event 规则只有一个生产调用权威，startup fail cache 与 P0 决策一致；
- recovery final fence 不在 Module/Route/facade 重复；
- 旧 helper、legacy callback、无调用 adapter 和双重 warning 逻辑均已分类清理。

审计证据可由 `rg`、import graph、调用点清单和关键文件人工复核共同构成；仅靠测试通过不能关闭结构门禁。

### 完整回归

至少执行：

```text
packages/shared internal contracts + typecheck
apps/api lifecycle/domain/route/startup/integration/worker integration + tsc
apps/agent-worker runtime cancel/api client tests + typecheck
repository build + typecheck
git diff --check
git diff --cached --check（若已有用户授权暂存）
```

精确命令与 cwd 以实际 package scripts 为准，记录在 `09`。

### UI 评估

至少评估：

- 基本多轮对话；
- 流式输出与 terminal；
- 取消当前运行；
- 取消后立即新运行，旧 Worker 不污染新 run；
- 页面刷新与 run-state；
- API-managed Worker 与 local fallback；
- subtask cancel 代表性场景。

无法执行时必须记录豁免理由、自动证据和剩余风险。

### 最终审查

由未参与本阶段逐批实现的新审查视角检查：

- 0006 与本方案符合度；
- 行为等价与竞态安全；
- send/cancel/recovery 单一权威；
- DB/runtime/module 依赖方向；
- 可维护性、测试证据与结构审计证据；
- 是否混入排除项；
- 工作区/index 保护。

发现差距时继续修复与复审；若实现偏离方案但更合理，必须记录证据、理由、影响与回滚。
