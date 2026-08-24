# 阶段实施记录

> 状态：P0-P5 已完成复审并暂存；P6 已完成实现者收尾与最终独立审查。本轮已修复审查发现的 M1、L1、L2，并完成定向复核；未执行 Git 写操作。
> 方案起草时工作区：`v1.1...origin/v1.1 [ahead 1]`，HEAD `04499bb`；起草前无既有未提交变更。方案起草仅新增本方案文档；P0/P1 新增 lifecycle 测试，P2 新增 lifecycle 骨架/测试并修改 `AgentService` 与 runtime type port，未执行 Git 写操作。
> 用途：记录 P0-P6 的命令、cwd、结果、测试索引、审查、偏差和门禁；不替代长期基线、代码地图或自动测试。

## 记录规则

- 长期行为事实更新 `02-baseline-and-evidence.md`；
- Lifecycle 责任与 send/cancel/state/complete 决策更新 `03-run-lifecycle-domain-design.md`；
- recovery/startup 决策更新 `04-recovery-and-startup-boundary-design.md`；
- 路径、符号和调用链更新 `07-code-map.md`；
- 实际命令、cwd、结果、耗时、预期日志、审查和偏差记录在本文件；
- 不记录 token、input text、prompt/messages、完整 tool args/result、用户内容或敏感绝对路径；
- 每批第一项必须完整记录 `git status --short --branch`，逐项标注 staged/worktree/untracked 状态、归属与保护结论；
- 所有非本阶段变更不得修改、清理、暂存、取消暂存或混入批次 diff；
- 只有真实执行并看到结果后才能标记“通过”。

## 当前批次状态

| 批次 | 实现 | 实现者测试 | 独立审查 | 修复 | 独立复审 | 暂存 |
|---|---|---|---|---|---|---|
| 方案初稿 | 已完成 | 文档静态检查已执行 | 初审有中/低项 | 已完成文档修订 | 已通过 | 否 |
| P0 生命周期基线 | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P1 测试地基/索引 | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P2 Lifecycle 骨架 | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P3 send/enqueue failure | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P4 state/complete/cancel | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P5 recovery/startup | 已完成 | 通过 | 已通过 | 已完成 | 已通过 | 是 |
| P6 收尾/回归 | 已完成 | 通过 | 发现 M1、L1、L2 | 已完成 | 本轮定向复核通过 | 否 |

## 方案起草记录

### 只读调研输入

- 0006 target architecture、roadmap、testing、risks/decisions；
- 0007-B 文档结构与已完成实现边界；
- `agent.service.ts` 的 send/enqueue failure/cancel/state/complete；
- `agent.routes.ts` 的 Public/internal send、compact、cancel、Worker routes；
- `agent.module.ts` 的 fail/recover/startup；
- `agent.store.ts` 的 run/run-state/conditional helpers；
- runtime port、Worker adapter、本地 fallback；
- API/Worker integration 与 cancel/recovery 测试索引。

### 只读结论

- `sendMessage()` 的 transaction 原子性必须保留；
- Public message Route 当前直接 enqueue 且未见 failure helper；
- internal trigger/compact 有 enqueue failure compensation；
- cancel 当前 DB-first，runtime failure warning-only；
- recovery final check 当前位于 module；
- Worker client cancel 当前 adapter 内吞错并 warning；
- local fallback cancel 只移除 queued run；
- 以上“当前事实”仍需 P0 运行证据，不在本记录中标记已验证。

### 最新独立初审修订

已处理的审查问题：

- startup fail cache invalidation 统一为 P0 证据决策门禁，移除“已定稿必须清理”的暗示；
- `sendMessage()` 补充权威责任表，固定 activation transaction、runtime context、enqueue failure 与 HTTP error owner；
- 增加 Public/internal trigger/compact/startup recover 的 run-start 入口对照；
- 验收改为行为/竞态测试与结构/依赖审计双轨；
- 统一术语为一个 `RunLifecycleApplication`、多个 use-cases、薄 startup hook；`coordinator` 仅保留为可选跨域顺序器。

本轮方案文档修订已通过后续 P0-P5 实施、独立审查与复审验证；未执行 Git 写操作。

### 方案核心决策

- Session / Interaction 拥有用户命令/校验/dedup/cross-domain entry；
- Lifecycle 拥有 run activation/state/runtime/enqueue failure/cancel/recovery；
- 使用 atomic activation persistence 保持 user item/title/dedup/run/run-state 单 transaction；
- Route 不再拼 send enqueue 或 cancel runtime；
- recovery 迁入唯一 `RunLifecycleApplication` 的显式 use-cases，Module 只通过薄 startup hook 触发；
- 本阶段不创建统一所有域的 startup coordinator；
- active child query 是窄 Subtask dependency；
- runtime port/type 与完整 Service 解耦；
- Worker Runner、本地 running abort、Shared/DB/UI 变化排除。

## P0：生命周期行为与竞态基线冻结

### 工作区快照

```text
## v1.1...origin/v1.1 [ahead 1]
A  docs/design/0007-C-第三阶段-Run-Lifecycle与Cancel-Recovery边界治理/（10 个方案文件）
```

保护结论：上述 10 个方案文件在 P0 开始时已在 index，属于本阶段方案基线；P0 未执行 Git 写操作、未取消暂存或修改无关文件。P0 新增 `apps/api/src/modules/agent/run-lifecycle-baseline.api.test.ts`，以及对本阶段文档的 P0 记录更新，均保持 worktree 未暂存，等待本批次审查后由主会话精确处理。

### 静态证据复核

- Shared：`internal-contracts.test.ts` 14 项通过，未修改 Agent API/Worker endpoint 或 schema；
- send：`AgentService.sendMessage()` 仍在单 SQLite transaction 内写 user item、首条 title、dedup、running run record 和 run-state；Route 在非 dedup 后直接 enqueue；
- enqueue：Public Route 不 catch；internal trigger 与 compact catch 后调用 `failRunOnEnqueueFailure()`；
- state/complete：现有 ownership、terminal、active-run switch guard、terminal cache clear 与 event publish 均位于 Service；集成测试回归通过；
- cancel：Service 先 DB transaction，Route 后 runtime `allSettled`；`AgentWorkerClient.cancelSession()` 在 adapter 内 catch/warn，不向 `allSettled` 抛 transport error；
- recovery：module 的 `enqueueRecoveringRuns()` 保留 enqueue 前 final DB check；`fail` 在 listen 前执行；
- runtime：local fallback 只移除 queued run，API-managed Worker runner 可 abort running nested controller；二者不可视为等价。

### Characterization

- 新增 `run-lifecycle-baseline.api.test.ts`：真实 SQLite + 真实 `AgentService` + 注册的 Public Route + fake runtime。首次 Public enqueue 抛普通 error 时，该最小 Route 装配不返回 `201`，且 activation 已持久化为 user item/dedup/running run/running state；同 `clientRequestId` retry 返回 `201 deduplicated:true`，不再 enqueue、不新增 DB 行。生产 `createApp()` 的精确 error HTTP body/status 未由该测试证明；
- `agent.worker-client.test.ts`：enqueue transport/strict response error 映射 503；cancel adapter 仅 warning 并吞错；
- `agent.worker.integration.test.ts`：API-managed Worker 发送消息主链通过；
- `runner.cancel.test.ts`：API-managed Worker 运行中 cancel 通过 AbortController/complete(cancelled) 收敛；
- `agent.integration.test.ts`：startup fail/recover final fence、enqueue-after-cancel、runtime cancel warning-only、cancelled complete、terminal/active-run guard、child cascade 等既有证据通过；
- startup fail cache：生产 module 先新建 `AgentService`，fail-before-listen 后才接流量；该新实例 cache 无预填充，helper 未显式 clear，因此当前调用时序无需新增 explicit invalidation。适用范围已记录在 `02`。

### 执行命令与结果

| cwd | 命令 | 结果 | 耗时 | 预期日志/备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/run-lifecycle-baseline.api.test.ts` | 通过，1/1 | 约 1.1s | Public failure durable-state/dedup characterization；不证明 production error HTTP 外观 |
| `apps/api` | `npx tsx --test src/modules/agent/agent.worker-client.test.ts && npx tsx --test src/modules/agent/agent.worker.integration.test.ts` | 通过，8/8 + 3/3 | 约 8.2s | Worker client 与 API-managed Worker |
| `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts` | 通过 | 已完成 | 既有 fault-injection error 日志为预期测试输出，不表示失败 |
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 | 已完成 | 无输出 |
| `apps/agent-worker` | `npx tsx --test src/runtime/runner.cancel.test.ts && npm run typecheck` | 通过，10/10 | 已完成 | Worker cancel 与 typecheck |
| `packages/shared` | `npx tsx --test tests/internal-contracts.test.ts && npm run typecheck` | 通过，14/14 | 已完成 | Shared contract 未变更 |
| repository root | `git diff --check && git diff --cached --check` | 通过 | 已完成 | P0 检查时无 whitespace error |

### P0 决策

- Public enqueue failure：P0 冻结为 route-level failure + durable running activation；本批不修复。生产 error HTTP 外观未冻结；P3 必须显式决定是否以条件化 settlement 统一，而非沿用 Route 隐式冒泡；
- dedup retry：冻结为 201 deduplicated result 且绝不重 enqueue；
- conditional failure：现有 internal/compact helper 与 Public 未对齐，且 helper 的 cancel/complete/switch 并发条件化证据仍需 P1/P3 补齐；
- Worker cancel adapter：保留 API-managed adapter 内 warning/swallow 语义；P4 设计 runtime best-effort 时不得假设 Route `allSettled` 能观察其 transport error；
- startup fail cache：当前生产 startup 的新 service、fail-before-listen 前提下无需 explicit invalidation；任何复用 service 的 future restart/recovery 触发重新决策；
- P1 最小范围：将 P0 characterization 与大集成文件中的 lifecycle 证据建立独立索引；真实 SQLite 保留为 persistence/cancel/recovery 证据，fake runtime 仅用于 application/Route 调用顺序和 failure；
- P2 前置：不得依据 P0 改动生产接口；需以 P1 明确的最小测试边界支持 ports/application 骨架。

### P0 门禁

```text
实现者判定通过，待独立代码审查：
Public failure、dedup retry、runtime 差异、state/complete/cancel/recovery 既有护栏与 startup fail cache 适用前提均已有可追溯证据；
未发现要求在 P0 停线讨论的 Shared/DB/UI/Worker Runner 或行为变更。
```

## P1：最小 Lifecycle 测试地基与证据索引

### 变更

- 新增 `apps/api/src/modules/agent/run-lifecycle.persistence.test.ts`，用真实 SQLite、真实 `AgentService` 与现有 `enqueueRecoveringRuns()` 建立独立可定位证据；
- 保留 P0 `run-lifecycle-baseline.api.test.ts` 作为 run-start/enqueue failure 路由层 characterization；
- 未修改 testkit、生产代码、Shared contract 或 Worker；fake runtime 仅观察 recovery 是否 enqueue；
- 保留 `agent.integration.test.ts` 的 startup/cancel/recovery/state/complete 强集成护栏，保留 API-managed Worker/Worker client 回归，不为目录归属迁移既有断言；
- 同步 `README.md`、`06-testing-review-acceptance.md`、`07-code-map.md` 的实际入口和证据分层。

### 测试

| cwd | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/run-lifecycle.persistence.test.ts` | 通过，4/4 | 约 2.3s | P0 route characterization + P1 SQLite |
| `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts` | 通过 | 已完成 | 保留全应用 lifecycle 护栏；既有 fault-injection error log 为预期 |
| `apps/api` | `npx tsx --test src/modules/agent/agent.worker-client.test.ts && npx tsx --test src/modules/agent/agent.worker.integration.test.ts` | 通过，8/8 + 3/3 | 约 8.2s | transport 与真实 API-managed Worker |
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 | 已完成 | 无输出 |
| `packages/shared` | `npx tsx --test tests/internal-contracts.test.ts && npm run typecheck` | 通过，14/14 | 已完成 | Shared contract 未变更 |
| `apps/agent-worker` | `npx tsx --test src/runtime/runner.cancel.test.ts && npm run typecheck` | 通过，10/10 | 已完成 | Worker cancel 与 typecheck |

### 审查/修复/复审

后续独立审查与复审已通过；P1 的真实 SQLite 基线、fake runtime 边界和既有强集成护栏均被保留，未发现需回补 P1 的问题。

### P1 门禁

```text
实现者判定通过，待独立代码审查：
关键 DB 规则均有真实 SQLite 证据；fake runtime 未替代 Store，仅观察 recovery enqueue；
未扩张 testkit/fault seam，未迁移或减少既有 integration/Worker 断言，未进入 P2 生产结构迁移。
```

## P2：Lifecycle application 骨架与窄依赖

### 实现

- 新增 `lifecycle/run-lifecycle-application.ts`，作为唯一 Lifecycle application 的无副作用骨架；P2 未迁移 start/state/complete/cancel/recovery use-case；
- 新增 `lifecycle/run-lifecycle-ports.ts`：`RuntimeControlPort`、独立 `AgentRuntimeRun`、workspace reader、active child query、cache invalidator、completed event publisher、atomic persistence、clock/id/logger；
- `agent.runtime-port.ts` 改为从 lifecycle ports 兼容导出，移除对 `agent.service.ts`/`AgentQueuedRun` 的类型依赖；
- `AgentService` 构造期通过窄闭包装配 workspace context、durable child query、现有 cache invalidator、event hub、SQLite transaction、clock/id/logger；不把 `AgentService`/`AppContext` 传入 application；
- module 选择 API-managed Worker/local runtime 的时序保持不变，故 `runtimeControl` 在 P2 明确为 `null`，不建立 callback 壳层或第二运行权威。

### 测试

| cwd | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/agent.service.facade.test.ts` | 通过，6/6 | 约 0.9s | 骨架无构造副作用；真实 Service 直接验证 reader/child-query/clock/id wiring 与 runtime 未接入；既有 facade 回归。cache/event/transaction/logger 仅完成构造期装配，尚无直接调用断言 |
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 | 已完成 | API typecheck |
| repository root | `git diff --check && git diff --cached --check` | 通过 | 已完成 | 无 whitespace error |

### 审查/修复/复审

- 独立审查指出 wiring 测试未触达 cache/event/transaction/logger，却被文档概括为已覆盖。
- 处置：不为尚未迁移的 P2 骨架调用这些适配器或扩大 private-field 断言；下调测试覆盖表述，仅声明已直接调用的 reader/child-query/clock/id 与 runtime 未接入。
- 同时将私有字段读取集中在 wiring test 的单一 helper，并移除 application skeleton test 中不必要的私有字段窥探。
- 修复后重新运行 P2 定向测试、API typecheck 与 diff/static import 检查。

### P2 门禁

```text
实现者判定通过，待独立代码审查：
Lifecycle 仅持有窄端口且无 Service/AppContext 依赖；runtime port 已消除 Service 类型导入；
未迁移或复制 send/state/complete/cancel/recovery 规则，现有 module/runtime 选择和产品行为不变。
```

## P3：sendMessage、activation 与 enqueue failure

### 实现

- `RunLifecycleApplication.startUserRun()` 成为 Public/internal send 的唯一 activation → workspace context → enqueue → failure settlement 编排；runtime 作为一次性 command 输入传入，不注册长期 callback；
- `AtomicLifecyclePersistence.activateUserRun()` 在一条 SQLite transaction 内完成 authoritative dedup/running 判定、user item、首条 title、dedup、run record、run-state；Service 保留非权威快路径以保持既有前置错误顺序；
- `failRunAfterEnqueueFailureIfCurrent()` 在一条 SQLite transaction 内对 matching in-flight run 置 failed，并仅在 active run 仍匹配时 idle；terminal/mismatch no-op，cache 仅在实际 failed 时清理；
- Public Route 与 internal trigger Route 均只调用 `AgentService.sendMessage(..., runtime)`，不读取 service context 或自行 enqueue/failure settlement；
- `AgentService.failRunOnEnqueueFailure()` 改为 Lifecycle 薄 facade，供 compact 继续复用条件 failure capability。compact 的创建/context/enqueue 调度仍在 Route，明确留待后续领域批次；
- 不改 Shared contract、DB schema、UI 或 Worker runtime；P4/P5 的 state/complete/cancel/recovery 未迁移。

### 行为对照

| 行为 | P0 基线 | 实现后 | 证据 |
|---|---|---|---|
| send success | existing `201` | 保持 | `agent.integration.test.ts`、Worker integration |
| dedup | 不重 enqueue | 保持；Lifecycle transaction authoritative | Lifecycle unit + Route characterization |
| session running conflict | `409` | 保持；transaction 内复核 | Service fast path + activation capability |
| Public enqueue failure | durable running 残留、route failure | durable user/dedup，条件 failed/idle 后 rethrow | P0/P3 Route characterization |
| internal enqueue failure | failed/idle 后 rethrow | 与 Public 共用 Lifecycle settlement | P3 internal Route characterization |
| retry same clientRequestId | deduplicated、不重 enqueue | 保持，failed run 仍按既有 dedup 返回 | Public/internal Route characterization |
| transaction rollback | 单 transaction | 保持同一 activation transaction | persistence adapter 源码复核 + integration |

### 测试

| cwd | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/run-lifecycle.persistence.test.ts && npx tsc --noEmit --pretty false` | 通过，10/10 + typecheck | 约 2.3s | P3 application、Public/internal Route、P1 SQLite race evidence |
| `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts && npx tsx --test src/modules/agent/agent.worker-client.test.ts src/modules/agent/agent.worker.integration.test.ts` | 通过 | 已完成 | local/API-managed Worker 与既有跨域护栏；fault-injection error logs 为预期 |
| repository root | `git diff --check && git diff --cached --check` | 通过 | 已完成 | 无 whitespace error |

### 审查/修复/复审

后续独立审查与复审已通过；P3 activation/enqueue-failure 的单一 application 编排、条件 settlement 与 cache 语义由 Route characterization、真实 SQLite 与 integration 护栏持续覆盖。

### P3 门禁

```text
实现者判定通过，待独立代码审查：
activation 的 authoritative transaction 仅由 Lifecycle 调用；Public/internal Route 无 context/enqueue/failure 编排；
enqueue failure 条件 settlement 保留 cancel wins、active-run fence、user item/dedup 与 retry 不重 enqueue；
compact 仅复用 failure facade，未被误迁入 send use-case。
```

## P4：state/complete/cancel 与 runtime best-effort

### 实现

- `RunLifecycleApplication` 接管 worker state、worker complete、cancel cascade 与 DB-first runtime best-effort use-case；
- 新增 `lifecycle/sqlite-run-lifecycle-persistence.ts`，以命名 persistence capability 承担 cancel/state/complete 的 SQLite transaction 与 guards，不向 Lifecycle 暴露 `AppContext` 或完整 Store；
- `AgentService.cancelSession()`、`cancelSessionCascade()`、`cancelSessionWithRuntime()`、`updateRunStateFromWorker()`、`completeRunFromWorker()` 均为 Lifecycle facade；
- Public cancel Route 仅调用 runtime-aware facade；旧 Route `cancelRuntimeSessionsAfterDbConvergence()` 已删除；
- cancel 在同一 SQLite transaction 内识别并收敛 root/current-active-child，再对该 transaction 产生的 runtime target 使用 `allSettled`；runtime failure 仅 warning，不回滚 DB；
- state/complete 保持 ownership、terminal 与 active-run guard；有效 complete 才清 prompt static cache 并发布 completed event；
- 未修改 Shared contract、DB schema、UI、Subtask 主体或 local runtime 主执行流；P5 recovery/module 未迁移。

### 行为对照

| 行为 | P0 基线 | 实现后 | 证据 |
|---|---|---|---|
| late state vs new run | 既有 integration guard | 保持；P4 仅迁权威 | 既有 `agent.integration.test.ts` |
| terminal state no-op | 既有 integration guard | 保持；无 cache/event 重复副作用 | application + integration |
| complete active match | 既有 state guard | matching active 才 idle | `run-lifecycle.persistence.test.ts` |
| cancelled context settlement | 既有 cancel/complete guard | 保持 tool/non-tool 收敛差异 | 既有 integration |
| root/child cancel | durable lineage cascade | 保持，child query 为窄 capability | application + integration |
| runtime cancel failure | warning-only、DB-first | 保持，所有 target `allSettled` | application + integration |
| terminal cache/event | terminal outcome side effect | 仅有效 complete 触发 | application test |
| local queued/running cancel | local runtime 既有范围 | 未在 P4 改写 | runner/integration 既有护栏 |

### 测试

| cwd | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/run-lifecycle.persistence.test.ts src/modules/agent/agent.integration.test.ts` | 通过 | 已完成 | P4 application、SQLite old-complete fence、cancel/runtime/worker 强集成护栏；既有 fault-injection 日志为预期 |
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/agent.worker-client.test.ts src/modules/agent/agent.worker.integration.test.ts` | 通过，14/14 | 已完成 | wiring、P3 基线、Worker transport/API-managed Worker |
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 | 已完成 | 无输出 |
| repository root | `git diff --check && git diff --cached --check` | 通过 | 已完成 | 未执行 Git 写操作 |

### 审查/修复/复审

后续独立审查与复审已通过；P4 的 DB-first cancel、runtime best-effort、terminal/ownership fence 与有效 complete 的 cache/event 副作用保持由 application、SQLite 和 integration 测试覆盖。

### P4 门禁

```text
实现者判定通过，待独立代码审查：
cancel 的 DB-first/runtime-best-effort 时序由 Lifecycle 唯一编排；Service/Route 无第二套 cancel/state/complete 业务主体；
terminal、ownership、active-run 和 cancel-wins 既有护栏回归通过；P5 recovery/module 与 local runtime 主流程未进入本批。
```

## P5：Recovery 与 startup/module 边界

### 实现

- `RunLifecycleApplication` 新增 `recoverRunsOnStartup()` 与 `failRunsOnStartup()`；`AgentService` 仅保留 startup facade；
- `SqliteRunLifecyclePersistence` 承接 candidate/final eligibility、fail mode context/run/state CAS、notice 与 dirty-state persistence capability；
- recover 依次执行 candidate 初检、workspace/trigger input read、final DB eligibility check、runtime enqueue；单 candidate enqueue 失败仅 warning 并继续；
- fail 保留 context item、run record、run-state 三个独立 best-effort 步骤，以及仅在 state CAS 回收且确有变化时追加 notice；
- 保持 fail-before-listen、recover-onListen 时机；module 仅选模式并触发 facade，移除 lifecycle recovery Store imports/helper；
- P5 未新增、删除或声称统一 startup fail prompt-cache invalidation，保持既定 P0 决策边界；
- orphan scan、archive pending reconcile 与 Worker/Plugin Host 进程生命周期未迁移。

### 行为对照

| 行为 | P0 基线 | 实现后 | 证据 |
|---|---|---|---|
| fail before listen | 模块注册期收敛 | 保持；仅委派 Lifecycle facade | startup fail integration |
| recover onListen | `onListen` 恢复 | 保持；仅委派 Lifecycle facade | module + recovery integration |
| cancel before final check | 不 enqueue | 保持 final DB fence/cancel wins | SQLite + integration |
| cancel after enqueue | DB cancelled 收敛 | 保持 | integration |
| candidate enqueue failure | warning 后继续 | 保持 | application + integration |
| active-run CAS | 仅 matching active run 回收 | 保持 | application + startup fail integration |
| dirty state | running/null 回收 | 保持 | startup fail integration |
| notice best-effort | 条件追加且冲突忽略 | 保持 | application + startup fail integration |

### 测试

| cwd | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/run-lifecycle.persistence.test.ts && npx tsc --noEmit --pretty false` | 14/14 通过；类型检查通过 | 约 2.5s（测试） | P5 application 编排与真实 SQLite final fence |
| `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts && npx tsx --test src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts && npx tsc --noEmit --pretty false` | 165/165 + 3/3 通过；类型检查通过 | 约 40s（integration） | startup fail、final-fence cancel wins、enqueue 后 cancel、failure isolation；fault-injection error 日志为预期 |
| `apps/api` | `npx tsx --test src/modules/agent/agent.worker-client.test.ts src/modules/agent/agent.worker.integration.test.ts` | 11/11 通过 | 约 8.2s | Worker client 与 API-managed Worker 回归 |
| repository root | `git diff --check && git diff --cached --check` | 通过 | 已完成 | whitespace 审计通过；未执行 Git 写操作 |

### 审查/修复/复审

实现者验证已完成；本批尚待独立代码审查、修复（如有）与复审。

### P5 门禁

```text
实现者门禁通过，待独立代码审查：recovery candidate/final fence、failure isolation、cancel wins、fail CAS/notice/dirty-state 与 module 边界均已由定向测试和静态审计覆盖；未进入 P6。
```

## P6：收尾、完整回归、结构审计与最终审查

### 残留审计

在 `apps/api/src/modules/agent` 的生产 TypeScript 文件中，以 `rg` 检索计划列出的 runtime、failure、cancel、recovery、Store helper、`AgentRuntime(service` 与 `service.getContext()` 模式，并人工复核 `agent.module.ts`、`agent.routes.ts`、`agent.runtime.ts`、`RunLifecycleApplication` 与 `SqliteRunLifecyclePersistence`。

结论详见 `07-code-map.md` 的 P6 残留检索表：normal send/recovery 的 enqueue、failure 与 DB/runtime cancel 仅由 Lifecycle 编排；已删除 helper 无命中；Store recovery helper 仅在 persistence adapter 内；compact、revert 和配置/鉴权读取均已分类，未被误认为 normal lifecycle 双权威。

P6 清理项：`AgentRuntime` 从完整 `AgentService` 构造依赖收窄为独立 `LocalAgentRuntimeExecutionPort`；Module 显式提供六个 operation adapter，`AgentRuntime(service, ...)` 已无命中。另修正 plugin debug-tools fixture 的过期 `dist/index.js` 断言为 manifest 实际声明的 `index.js`，不改生产行为。

### 结构与依赖审计

| 审计面 | 方法/命令 | 命中与分类 | 修复 | 复查 | 审查结论 |
|---|---|---|---|---|---|
| Send transaction owner | `rg activateUserRun` + application/persistence 人工复核 | 唯一业务调用在 `startUserRun()`；SQLite capability 由 adapter 实现 | M1：迁移 Service 内联 transaction | 已复查 | 通过 |
| Runtime context/enqueue owner | `rg runtime.enqueueRun/service.getContext` + Route 分类 | normal send/recovery 在 Lifecycle；compact 是有意保留 | 无需 | 已复查 | 通过 |
| Enqueue failure owner | `rg failRunOnEnqueueFailure` | normal send 在 Lifecycle；仅 compact 保留 legacy facade | 无需 | 已复查 | 通过 |
| HTTP error owner | Route/Service/Application 调用链复核 | application 产生 lifecycle 业务结果，facade 透传，Route 序列化；compact 保持原外观 | 无需 | 已复查 | 通过 |
| Cancel DB/runtime boundary | `rg runtime.cancelSession` + Lifecycle 人工复核 | cancel cascade 先 DB transaction 后 `allSettled` best-effort；revert 非 cascade | 无需 | 已复查 | 通过 |
| Recovery/module boundary | Module import/call 复核 | Module 仅装配/触发；candidate/fence/fail settlement 在 Lifecycle/persistence | 无需 | 已复查 | 通过 |
| Runtime decoupling | `rg AgentService/agent.service` in runtime files | local runtime 曾接收完整 Service | `LocalAgentRuntimeExecutionPort` + Module adapter | 无 Service type/import 或完整对象构造 | 通过 |
| Active child query direction | Application constructor/import 复核 | 仅窄 `ActiveSubtaskChildQuery` | 无需 | 已复查 | 通过 |
| Cache/event authority | terminal call-site 复核 | complete/failure/cancel 由 Lifecycle；startup fail 保持 P0 特例 | 无需 | 已复查 | 通过 |
| Legacy cleanup | P6 残留检索 | 旧 Route/module recovery helper 无命中 | 已删除 | 已复查 | 通过 |

审计特别记录：

- startup fail cache 的 P0 决策：新 `AgentService` 实例、fail-before-listen 的唯一生产时序中，无同实例预填且可观察的 cache，因此不新增显式 invalidation；
- 实现严格符合该决策：P5/P6 未新增、删除或泛化 startup fail cache 行为；
- 未发现相反的生产调用点或文档结论；complete/cancel/enqueue-failure 的同进程 cache 规则仍独立存在。

### 完整自动回归

| package/cwd | 命令 | 结果 | 耗时 | warning/备注 |
|---|---|---|---|---|
| shared | `cd packages/shared && npx tsx --test tests/*.test.ts && npm run typecheck` | 29/29 通过 | 约 2.1s（测试） | 无 |
| api | `cd apps/api && npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print \| sort) && npm run typecheck` | 267/267 通过 | 约 39.6s（测试） | fixture 依赖 cwd 的 plugin test 单独从根目录执行 |
| api plugin | `npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts`（仓库根） | 8/8 通过 | 约 0.4s | 修正 fixture 过期 entryPath 断言后通过 |
| worker | `cd apps/agent-worker && npx tsx --test $(find src -name '*.test.ts' -print \| sort) && npm run typecheck` | 全量通过 | 已执行 | 无 |
| plugin/web | 各自 `npm run test && npm run typecheck` | plugin 11/11、web 24/24 通过 | 已执行 | 无 |
| repository | `npm run build && npm run typecheck && git diff --check && git diff --cached --check` | 通过 | 已执行 | web build 仅有既有 Browserslist/chunk-size warning |

### UI 验收或豁免

本轮未启动浏览器/人工 UI 流程，豁免原因是本批仅做 API 侧依赖收窄、fixture 测试断言和文档整理，未修改 Shared contract、DB schema、HTTP/UI 行为或 Worker/local fallback 执行逻辑。

自动证据覆盖了 normal send、state/complete、cancel、recovery final fence、Worker/API-managed Worker、local fallback 强集成及 web unit tests。剩余风险是未以真实浏览器手工重复基本多轮、流式、取消后立即新运行、刷新与 subtask cancel 的端到端视觉/交互验收；该风险交由最终独立审查决定是否补跑。

### 最终新视角审查

最终独立审查已完成，发现并要求处理以下本阶段问题：

| 编号 | 审查发现 | 修复 | 本轮复核 |
|---|---|---|---|
| M1 | `activateUserRun` 与 `failRunAfterEnqueueFailureIfCurrent` 仍作为 `AgentService` 构造器中的内联 SQLite transaction，导致 lifecycle persistence 未完整收口 | `SqliteRunLifecyclePersistence` 改为完整实现 `AtomicLifecyclePersistence`，承接两项 transaction；`AgentService` 仅注入该 adapter | 结构检索确认两个 persistence 方法仅由 adapter 实现；定向 SQLite、baseline、application、wiring 与 facade 测试通过 |
| L1 | 本实施记录未回填最终审查、修复与复审，且遗留未回填占位 | 更新批次状态、各历史占位与本表 | 已检索确认本文件不再含未回填占位或未完成终审标记 |
| L2 | startup/recovery 文档未精确区分 worker start、`onListen` hook 注册和 recovery 执行 | 更新 `04-recovery-and-startup-boundary-design.md` 的时序与 hook 边界 | 已按 `agent.module.ts` 控制流复核：hook 先注册，worker-enabled 时先 await start，recovery 在 listen 后执行 |

本轮定向验证：

| cwd | 命令 | 结果 |
|---|---|---|
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 |
| `apps/api` | `npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/run-lifecycle.persistence.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/agent.service.facade.test.ts` | 21/21 通过 |
| `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts` | 通过；既有 fault-injection 日志为预期 |

复核结论：M1、L1、L2 已修复；本轮未修改 Shared contract、DB schema、UI 或产品行为，也未执行 Git 写操作。仍建议后续变更 activation 的标题生成规则时同步维护 adapter 内同语义的局部纯函数，避免两处标题策略发生漂移。

实现者结论：审查发现已修复，定向验证与结构复核通过；0007-C 的本阶段终审问题已收口。

## 方案偏差记录模板

### 偏差标题

- 原方案：
- 新证据：
- 实际实现：
- 为什么更合理或为何必须改变：
- 行为/合同/事务/依赖影响：
- 测试证据：
- 回滚方式：
- 审查结论：

## 最终完成声明模板

只有所有门禁通过后填写：

```text
0007-C P0-P6 已完成。
Run Lifecycle 的 activation、enqueue failure、state/complete、cancel、runtime best-effort 与 startup recovery 已形成单一权威边界。
Shared/HTTP/DB/Worker/UI 未发生未授权行为变化。
完整回归、独立审查、修复与复审已通过。
```
