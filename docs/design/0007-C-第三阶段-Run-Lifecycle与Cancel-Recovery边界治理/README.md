# 第三阶段：Run Lifecycle 与 Cancel/Recovery 边界治理

> 状态：P0-P5 已完成复审并暂存；P6 已完成实现者收尾、完整自动回归与结构审计，具备进入未参与本阶段实现的新审查员全面独立审查的条件。独立终审尚未执行。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)；前置阶段：[`../0007-A-第一阶段-基线与Read-side-Prompt结构治理/`](../0007-A-第一阶段-基线与Read-side-Prompt结构治理/) 与 [`../0007-B-第二阶段-Context-Writeback与Artifact边界治理/`](../0007-B-第二阶段-Context-Writeback与Artifact边界治理/) 已完成。
> 当前实现基线提交：`04499bb feat(agent): implement phase 2 context writeback governance`；方案起草时分支为 `v1.1...origin/v1.1 [ahead 1]`，无既有未提交变更。

> P0/P3 结论：P0 冻结的原始 Public enqueue failure 基线是 durable activation 后不返回 `201`，且同一 `clientRequestId` retry 不重 enqueue；P3 将该 failure 收敛迁入 Lifecycle。当前 Public/internal send 均在 enqueue 异常后保留 user item/dedup、将目标 run 条件置为 `failed`，仅在仍为 active run 时置 idle；同一 request retry 仍返回 deduplicated result、不重 enqueue。生产 `createApp()` 的精确 error HTTP 外观仍未由 characterization 冻结。

> P1 测试地基：保留 `agent.integration.test.ts`、API-managed Worker 与 Worker client 的强集成护栏；新增真实 SQLite 的 `run-lifecycle.persistence.test.ts`，独立定位 enqueue-failure active-run switch、cancel wins 与 recovery final fence。fake runtime 仅用于 recovery 的 enqueue 观察，不替代持久化证据。

> P2-P6 application：唯一 `RunLifecycleApplication` 已拥有 `startUserRun()`、worker state/complete、cancel 与 startup fail/recover use-case；`AgentRuntimeRun` 与 local fallback execution port 都不从 `AgentService` 导入或持有完整 Service。runtime 以一次性 command 输入传给 use-case，而非构造期 callback；recovery 保留 candidate 初检、读取 context/input 后的 final DB fence、单 candidate enqueue failure isolation 与 cancel wins；fail 保留 context/run/state CAS/notice/dirty-state 的独立 best-effort 收敛。P5/P6 未新增或改变 startup fail prompt-cache invalidation 行为，仍遵循既定决策边界。

## 快速结论

本阶段承接 0007-A/0007-B 已建立的“职责域 application/capability + `AgentService` 兼容 facade + 真实边界测试”模式，治理 API 侧 Run Lifecycle：

```text
Session / Interaction 用户命令
  → 显式 Run Lifecycle 协作接口
  → user item + dedup + run record + run-state 原子激活
  → runtime enqueue
  → Worker/local runtime state & complete writeback
  → terminal DB/cache 收敛

Cancel
  → durable root/child 查询与 DB transaction 收敛
  → DB 成功后 runtime cancel best-effort

Startup
  → module/startup hook 触发
  → recovery use-case
  → candidate / final DB fence / enqueue 或 fail 收敛
```

阶段目标不是重写运行状态机，而是让以下规则拥有单一、可审查的权威边界：

- `sendMessage()` 中 Session / Interaction 与 Run Lifecycle 的显式协作；
- user item、client request dedup、run record、run-state 的既有原子事务；
- runtime enqueue 与 enqueue failure；
- Worker `updateRunState` / `completeRun` 写回；
- root/active-child cancel cascade；
- DB 收敛后的 runtime cancel best-effort；
- startup recovery 的 `fail` / `recover` 模式；
- recovery candidate 与 enqueue 前最终 DB fence；
- terminal run 的 prompt static cache invalidation；
- module 只负责构造、注册、触发和进程生命周期，不重复 lifecycle 领域规则。

## 阶段组成

```text
P0  生命周期行为与竞态基线冻结
P1  最小 Lifecycle 测试地基与证据索引
P2  Run Lifecycle application 骨架与窄依赖
P3  sendMessage 跨域协作、原子激活与 enqueue failure
P4  Worker state/complete、cancel cascade 与 runtime best-effort（已完成实现者验证）
P5  Startup recovery 与 module 启动边界（已完成实现者验证）
P6  收尾、完整回归与最终审查
```

每批必须独立实施、测试、审查、修复、复审和回滚。不得将 P3-P5 合成一次性重写，也不得借本阶段提前治理 Subtask、Compaction/Archive 或 Worker Runner 主控制流。

## 本阶段纳入

- Public/internal send message 到 run 启动的调用链；
- `AgentService.sendMessage()` 的跨域责任分界；
- user item + title + dedup + run record + run-state 的既有事务原子性；
- `failRunOnEnqueueFailure()` 及各入口的 enqueue failure 归属；
- `updateRunStateFromWorker()`；
- `completeRunFromWorker()`；
- `cancelSession()` / `cancelSessionCascade()`；
- active subtask child session 的窄 durable query 依赖；
- DB transaction 之后的 runtime cancel best-effort；
- `agent.runtime-port.ts` 类型与完整 `AgentService` 的解耦方向；
- `AgentRuntime` 本地 fallback 所需窄能力；
- `enqueueRecoveringRuns()`、startup fail 收敛及最终 DB fence；
- terminal prompt static cache invalidation；
- run-completed event 的既有发布语义；
- Shared/API/Worker/local fallback/startup 的必要回归与 UI 验收评估。

## 明确排除

本阶段不得顺手纳入：

- Subtask prefork、start/reuse/unique race、result/status、orphan 主体治理；
- durable lineage 模型或 DB schema 重设计；
- Compaction/Archive/sidecar 主体迁移；
- Session / Interaction 的全部 query、fork、revert、clear 重构；
- Route、Module、`AgentService` 的最终目录与长期 facade 形态定稿；
- Worker Runner/provider/builtin 主控制流深拆；
- Shared endpoint/schema/response 扩张；
- DB schema、状态枚举、产品状态机、UI 行为变化；
- generation、epoch、lease、outbox 或跨进程强停承诺。

## 强制不变基线

### `sendMessage()` 与原子激活

- Session / Interaction 继续拥有用户命令语义、session/workspace/subtask 前置校验、文本规范化、client request dedup 与跨域入口；
- Run Lifecycle 拥有 run 创建、run-state、enqueue 与 enqueue failure 规则；
- Route 不得继续拼装持久化后 enqueue 的业务流程；
- user context item、首条消息 title、dedup、run record、run-state 的既有单事务原子性不得拆散；
- deduplicated 请求不得再次 enqueue；
- Public message enqueue failure 的当前行为必须在 P0 通过 characterization 明确后，才允许定稿迁移策略。

### Cancel / complete

- DB 收敛优先；
- `cancel wins`；
- runtime cancel 失败不回滚 DB，只记录有限 warning；
- root cancel 只沿当前 active run 的 durable child lineage 级联，不误取消历史 child；
- terminal run 不被 cancel 或晚到 Worker 状态写回改写；
- cancelled complete 继续收敛对应 run 的非终态 context item；
- complete 只有在当前 `activeRunId` 仍匹配时才回收 run-state；
- complete、cancel、enqueue failure 等已确认的同进程终态路径必须按既有规则使相关 prompt static cache 失效。
- startup fail 的 cache invalidation 不属于已冻结事实；是否需要显式 invalidation、触发条件与验证方式必须在 P0 以进程内 cache 生命周期证据定稿，未通过门禁前不得写入 P5 实现假设。

### Recovery

- `recover` 模式 enqueue 前保留最终 DB fence；
- final fence 前发生 cancel 时不得 enqueue；
- enqueue 已发出后不承诺 runtime 强停，由 DB/writeback fence 保证最终收敛；
- 单 candidate enqueue 失败不阻塞其他 candidate 或服务启动；
- `fail` 模式保持条件更新/CAS 与 best-effort notice；
- `running + activeRunId=null` 脏状态继续被保守回收；
- recovery 领域规则不得继续由 `agent.module.ts` 重复实现。

## 必须暂停的发现

若实施需要以下任一变化，必须停止当前批次并更新设计、基线和验收：

- 修改 Shared endpoint、schema、status/body 或 Worker response validation；
- 拆散 user item/dedup/run/run-state 原子事务；
- 改变 dedup、session running conflict、workspace mismatch 等现有错误语义；
- 将 enqueue failure 收敛改成可覆盖 terminal/cancelled/新 active run 的无条件写；
- 改变 `cancel wins`、DB-first 或 runtime best-effort 政策；
- 改变 cancel child lineage 的产品语义；
- 删除 recovery enqueue 前最终 DB fence；
- 将 recovery 单 candidate 失败升级为启动失败；
- 改变 terminal run、context item、run-state 或 cache invalidation 语义；
- 修改 DB schema、状态枚举、UI 或 Worker Runner 主控制流；
- 必须依赖 fake Store 才能证明事务/CAS；
- 必须扩大全局 fault seam 或引入重型线性化机制。

## 文档结构

| 文件 | 内容 |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | 背景、目标、阶段关系、范围、非目标和完成定义 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 当前调用链、事务、状态、cancel/recovery、runtime 与测试证据 |
| [03-run-lifecycle-domain-design.md](./03-run-lifecycle-domain-design.md) | Lifecycle application、send 协作、state/complete/cancel 与依赖方向 |
| [04-recovery-and-startup-boundary-design.md](./04-recovery-and-startup-boundary-design.md) | recovery candidate/fence、fail/recover、startup/module 边界 |
| [05-implementation-plan.md](./05-implementation-plan.md) | P0-P6 分批步骤、门禁、回滚和实施节奏 |
| [06-testing-review-acceptance.md](./06-testing-review-acceptance.md) | 测试矩阵、审查、回归、UI 评估与验收标准 |
| [07-code-map.md](./07-code-map.md) | 关键文件、符号、调用链、测试和候选改动面 |
| [08-risks-and-stop-conditions.md](./08-risks-and-stop-conditions.md) | 风险、停止条件、回退原则与后续交界 |
| [09-implementation-record.md](./09-implementation-record.md) | P0-P6 命令、结果、审查、偏差与状态记录模板 |

## 规范性约定

- “当前事实”只表示只读调研从源码或既有测试中观察到，不表示本阶段已重新运行验证；运行证据必须在 P0/P1 写入 `09`。
- “目标设计”表示实施约束，不得冒充当前实现。
- `Run Lifecycle application` 表示本职责域唯一应用边界；`use-case` 表示该 application 暴露的具体操作，例如 start、cancel、complete、recovery。
- `startup hook` 表示 Module 调用 application recovery use-case 的薄触发适配，不包含 candidate、fence 或 DB 收敛规则。
- `coordinator` 只保留给未来可能存在的跨职责域启动顺序器；本阶段不以该词指代 Lifecycle 领域实现，也不要求创建该组件。
- `capability` / `port` 表示 application 的窄依赖。候选组件名不冻结最终类名、函数式/对象式形态或目录深度。
- 每批遵循：实施前复核 → 小批实现 → 定向测试与必要回归 → 独立审查 → 修复 → 独立复审 → 用户明确允许后暂存 → 下一批。

验收采用双轨制：

```text
行为与竞态测试
  +
结构与依赖审计
```

测试通过不能替代 import、调用点、事务权威和旧 helper 残留审计；结构看似正确也不能替代 SQLite、Route、Worker 与 startup 行为证据。

## 完成定义

本阶段只有在以下条件同时满足时完成：

- `sendMessage()` 的 Session / Interaction 与 Lifecycle 协作接口、事务边界和错误归属已定稿；
- Route 不再编排 send enqueue 或 cancel runtime 时序；
- user item/dedup/run/run-state 原子事务未弱化；
- enqueue failure 具有单一、条件化、可测试的收敛规则；
- `cancel wins`、terminal guard、active-run guard 与已由 P0 定稿的 cache invalidation 规则有单一权威实现；
- runtime cancel 明确发生在 DB transaction 成功后，失败不回滚 DB；
- recovery candidate、final DB fence 与 fail/recover 收敛不再散落于 module；
- Module 只构造、注册、触发 startup hooks 和管理进程生命周期；
- API-managed Worker 与本地 fallback 均通过必要回归；
- Shared、Route、真实 SQLite、Lifecycle use-case、startup、Worker runtime 证据完整；
- 结构审计确认 Route/Module/Facade/Runtime/Store 依赖方向、单一权威和旧 helper 残留均符合方案；
- P0-P6 均完成独立审查和复审；
- 排除项未被混入，所有方案偏差已有证据和决策记录。
