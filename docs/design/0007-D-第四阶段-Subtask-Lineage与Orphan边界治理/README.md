# 第四阶段：Subtask / Lineage / Orphan 边界治理

> 状态：P0-P6 已全部完成；未参与实现的新审查员已完成全面独立终审，结论为通过，无必须补代码的问题，本阶段完成。仍缺少双独立 SQLite connection 的确定性交错 start-race harness，但终审确认其为非阻断测试增强项；其余可接受结构取舍与实现差异记录于 [`09-implementation-record.md`](./09-implementation-record.md)。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)；直接前置阶段：[`../0007-C-第三阶段-Run-Lifecycle与Cancel-Recovery边界治理/`](../0007-C-第三阶段-Run-Lifecycle与Cancel-Recovery边界治理/) 已完成并提交。
> 语义基线：[`../0008-Agent-Fork与Subtask深度语义重构/`](../0008-Agent-Fork与Subtask深度语义重构/) 已实施的 Fork、depth、session mode 与 lineage 语义继续有效；其旧代码行号和“Subtask 规则长期位于 `AgentService`”的结构描述不再作为目标状态。
> 方案起草基线：HEAD `3c40dab feat(agent): implement phase 3 run lifecycle governance`，分支 `v1.1...origin/v1.1 [ahead 2]`；起草前工作区无未提交变更。

## 快速结论

本阶段不重新设计 Subtask 产品行为，而是把 API 侧当前集中在 `AgentService` 与 `agent.store.ts` 中的以下规则收敛为可发现、可测试、依赖方向清楚的职责域：

```text
Worker subtask tool
  → Shared internal subtask contract
  → SubtaskApplication
      ├─ prefork plan
      ├─ parent anchor validation
      ├─ new / fork / existing session resolution
      ├─ durable lineage reuse / unique-race arbitration
      ├─ child activation plan
      ├─ result / status
      ├─ local empty-shell compensation
      └─ startup orphan scan
  → narrow persistence / session / lifecycle / maintenance capabilities

Subtask child execution
  → 仍由 Worker processNestedRun(...) 驱动
  → 不改为 API runtime enqueue

Run Lifecycle
  ← 继续依赖 durable child query 做 cancel cascade
  ← 不反向依赖完整 SubtaskApplication
```

权威关系继续是：

```text
(parentRunId, parentToolItemId)
```

`subtaskSessionId` 只用于展示、结果携带、继续执行提示或快速定位，不得成为 durable lineage、幂等或 cancel cascade 的唯一依据。

## 阶段目标

- 建立单一 `SubtaskApplication` 或等价职责域入口，承接 prefork、start、result、status 与 orphan startup use-case；
- 将 parent anchor、durable lineage、unique race、result/status 查询表达为窄 persistence capability；
- 将本次新建失败的局部补偿与 startup orphan 删除表达为不同的业务能力和调用路径；
- 定稿 Subtask 与 Run Lifecycle 的 child activation 协作边界，保持 seed context item、child run record、run-state 的既有单事务原子性；
- 保持 Worker 负责 prefork summary 生成、nested execution、reuse polling 与结果读取的现有模型；
- 保持 `AgentService` 为过渡期兼容 facade，不再承载 Subtask 领域规则；
- 让 module 只触发 orphan startup use-case，不持有 suspect、age、lineage 或 delete fence 规则；
- 建立独立 Subtask application、真实 SQLite persistence、wiring 与 API↔Worker 回归证据。

## 明确不做

- 不改变 Shared Subtask endpoint、schema、错误码或 Worker client 合同；
- 不改变数据库 schema、唯一索引或历史数据；
- 不重写 Worker `BuiltinToolProvider`、Runner 或 `processNestedRun()` 主时序；
- 不把 child Run 改为 API runtime enqueue；
- 不为 worker-disabled local fallback 新增 Subtask API/port 或 nested-subtask execution；`AgentRuntime` 与 worker-disabled wiring 保持现状；
- 不改变 `new`、`fork`、`existing`、prefork summary、depth 或 result/status 产品语义；
- 不扩展 orphan scanner 为通用异常 session 自动修复器；
- 不把 Compaction / Archive 主体、public Session/Routes/Module 最终收尾或 Worker 深拆混入本阶段；
- 不引入 lease、epoch、outbox、分布式锁或新的全局事务机制。

## 核心设计决策

- **Subtask 拥有用例语义**：anchor、profile、session mode、depth、reuse、lineage conflict、seed plan、result/status、补偿与 orphan policy。
- **Lifecycle 拥有 run activation 不变量**：推荐新增窄 `SubtaskChildRunActivator` 或等价 capability，在一个 SQLite transaction 中写入有序 seed items、child run record 与 running run-state；该能力不 enqueue runtime。
- **Worker 拥有 nested execution**：API 成功返回新 child run 后，仍由 Worker 调用 `processNestedRun()`；reused child 不重复执行。
- **Lineage 查询集中**：`find by parent tool` 与 cancel 所需 `list child sessions by parent run` 由同一命名 lineage persistence adapter 提供，但暴露不同窄接口。
- **删除路径分离**：P4 中 local compensation 只见 `deleteNewSessionIfStillEmpty()`；P5 使用的 orphan capability 只见 `listSuspects()` / `deleteSuspectIfStillEligible()`。两者共享的 final-fence SQL 仅在 SQLite maintenance adapter 内部私有；公开 port 不暴露 `requireForkLineage` 等可关闭安全条件。
- **启动边界保持薄**：P5 中 `SubtaskApplication.cleanupOrphansOnStartup()` 拥有 1h/24h policy、候选循环、逐条失败隔离、warning 与 summary；module 保持 routes → orphan → archive → Lifecycle → Worker 的既有顺序，并只保留整个 use-case 的顶层 failure isolation。
- **启动边界保持薄**：本阶段不强制建立通用 startup coordinator；module 可直接触发 Subtask startup use-case，未来由 Session/Routes/Module 收尾阶段决定统一 composition 形态。

## 分批路线

| 批次 | 目标 |
|---|---|
| P0 | 冻结 Subtask / Lineage / Orphan 当前行为与竞态基线 |
| P1 | 建立独立测试地基与真实 SQLite persistence 证据 |
| P2 | 建立 Subtask application、ports、persistence adapter 与 wiring 骨架 |
| P3 | 迁移 prefork、start/reuse/unique race、child activation 与 start failure local compensation |
| P4 | 迁移 result/status，并完成 local/orphan 删除能力的命名与 adapter 边界收口 |
| P5 | 迁移 orphan scan 与 startup 触发边界 |
| P6 | 完成 facade/store 结构审计与完整回归；随后由新审查员执行全面终审 |

## 文档导航

| 文件 | 内容 |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | 背景、目标、范围、非目标与跨阶段衔接 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 当前真实行为、调用链、事务、lineage、补偿、orphan 与测试证据 |
| [03-subtask-domain-design.md](./03-subtask-domain-design.md) | 目标职责域、ports、persistence、Lifecycle 协作和事务设计 |
| [04-startup-and-orphan-boundary-design.md](./04-startup-and-orphan-boundary-design.md) | orphan policy、删除 fence、failure isolation 与 module/startup 边界 |
| [05-implementation-plan.md](./05-implementation-plan.md) | P0-P6 分批实施步骤、门禁与回滚点 |
| [06-testing-review-acceptance.md](./06-testing-review-acceptance.md) | 测试矩阵、结构审计、独立审查与验收标准 |
| [07-code-map.md](./07-code-map.md) | 当前与候选目标代码地图、符号和测试入口 |
| [08-risks-and-stop-conditions.md](./08-risks-and-stop-conditions.md) | 风险、非目标、停止条件与回滚边界 |
| [09-implementation-record.md](./09-implementation-record.md) | 实施期命令、结果、审查、偏差和批次状态记录模板 |

## 完成定义

本阶段只有在以下条件全部成立时才算完成：

- prefork/start/result/status/orphan 的权威规则不再散落于 `AgentService`；
- `(parentRunId, parentToolItemId)` 的幂等、race 与 child 查询集中且有真实 SQLite 证据；
- `subtaskSessionId` 未被提升为 durable lineage；
- child activation 保持现有事务原子性且不复制 Lifecycle run-state 规则；
- Worker nested execution、reuse polling、abort 和 result 行为不变；
- existing session 永不进入本次新建补偿删除范围；
- local compensation 与 orphan cleanup 具有不同的公开业务能力、测试和日志语义；
- `AgentRuntime` 未新增 Subtask API/port，worker-disabled wiring 未变化，`SubtaskApplication` 不依赖 RuntimeControl/runtime enqueue；
- orphan scanner 保持 suspect 1 小时、保守删除 24 小时、fork lineage、空 session 二次确认与单 candidate 隔离；
- Run Lifecycle cancel cascade 继续通过窄 durable child query 工作，不形成循环依赖；
- module 只触发 startup use-case，不持有 orphan 领域规则；
- Shared、API、Worker、类型检查、构建和 diff hygiene 通过；
- 每批完成独立审查和复审，阶段末由未参与实现的新审查员做全面独立审查。

P6 已完成前述结构审计、测试、构建、类型检查与 diff hygiene；未参与实现的新审查员随后完成了全面独立终审并给出“通过”结论，未发现必须补代码的问题。本阶段现已完成；确定性交错 start-race harness 的缺口继续作为非阻断后续增强项保留，不得将其误写为已完成。
