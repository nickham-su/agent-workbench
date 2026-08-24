# 第六阶段：Session / Routes / Module 收尾

> 状态：方案与 P0-P5 已完成实现、验证及独立审查/复审，并已通过未参与实现的新审查员全面终审；本阶段已完成。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)。
> 已完成前置阶段：[`../0007-A-第一阶段-基线与Read-side-Prompt结构治理/`](../0007-A-第一阶段-基线与Read-side-Prompt结构治理/)、[`../0007-B-第二阶段-Context-Writeback与Artifact边界治理/`](../0007-B-第二阶段-Context-Writeback与Artifact边界治理/)、[`../0007-C-第三阶段-Run-Lifecycle与Cancel-Recovery边界治理/`](../0007-C-第三阶段-Run-Lifecycle与Cancel-Recovery边界治理/)、[`../0007-D-第四阶段-Subtask-Lineage与Orphan边界治理/`](../0007-D-第四阶段-Subtask-Lineage与Orphan边界治理/)、[`../0007-E-第五阶段-Compaction-Archive与Sidecar边界治理/`](../0007-E-第五阶段-Compaction-Archive与Sidecar边界治理/) 均已完成。
> 相关既有语义方案：[`../0008-Agent-Fork与Subtask深度语义重构/`](../0008-Agent-Fork与Subtask深度语义重构/) 已完成；本阶段只迁移其已冻结的 Session/Fork/Subtask 边界，不重新讨论产品语义。
> 调研基线：调研开始前分支为 `v1.1...origin/v1.1 [ahead 4]`，且工作区干净；方案阶段未执行 Git 写操作。

## 快速结论

本阶段是 `0006` API Agent 结构治理路线的收尾阶段，不增加 Agent 产品能力，也不重写已有职责域。目标是把仍集中在 `AgentService`、单体 `agent.routes.ts` 和 `agent.module.ts` 中的入口所有权、路由分组和装配职责定稿为以下结构：

```text
UI / public routes
  ├─ Session / Interaction Application
  │    ├─ list/create/fork
  │    ├─ send message
  │    └─ revert（含 DB 成功后的 runtime cancel best-effort）
  ├─ Context Query Application
  │    ├─ transcript list/item/tail
  │    ├─ run-state / status read model
  │    └─ UI artifact read authorization
  ├─ 已有 Manual Compaction / Clear / Cancel application entry
  └─ 仅做 schema、parse、status 与调用

Worker internal contract routes
  ├─ Read-side
  ├─ Context Writeback
  ├─ Run Lifecycle
  ├─ Subtask
  └─ Compaction / Archive

Peripheral internal routes
  ├─ Plugin / MCP / Channel operational endpoints
  ├─ ContextQueryApplication
  │    ├─ context tail
  │    └─ session status summary
  ├─ PeripheralAgentQueryApplication
  │    └─ recent sessions/workspaces、run final text、available agents
  └─ SessionInteractionApplication：primary create / run trigger

Status / SSE routes
  └─ SSE transport 生命周期与事件订阅

Agent composition root
  ├─ 构造 application / persistence / external adapters
  ├─ 构造薄 AgentService 兼容 facade
  ├─ 注册分组 routes
  ├─ 启停 Worker / Plugin Host 进程
  └─ 调用无领域规则的 AgentStartupCoordinator
```

## 已定稿决策

- **Context Query 最终独立为 application**，不作为 Session read model 的内部子模块。`ContextQueryApplication` 唯一拥有 context list/item/tail、public run-state、UI artifact read authorization 和 session status summary；调用方位于外围 internal route 不改变 context tail/status summary 的核心 owner。
- **外围只读入口另有唯一 owner**。`PeripheralAgentQueryApplication` 唯一拥有 recent sessions、recent workspaces、run final text 和 available agents；它不得通过持有完整 `ContextQueryApplication` 做杂糅式转发。
- **长期保留薄 `AgentService` facade**。不选择 routes 直接注入大量 use-case，也不新增具有二次路由语义的 `AgentApplication` registry。facade 仅保留兼容入口和纯委派，不持有领域规则、完整 `AppContext` 暴露或底层 Store 调用。
- **新增轻量 `AgentStartupCoordinator`**。它只按既有顺序触发 Subtask orphan cleanup、Archive pending reconcile、Run startup recovery/fail；不得查询 DB、访问文件、拥有扫描条件或复制领域错误策略。
- **Route 按责任分组而不是按 URL 前缀或行数机械拆分**：UI/public、Worker internal contract、外围 internal、status/SSE。外围 internal 不得被吸收到核心职责域。
- **`sendMessage` 的用户命令语义属于 Session / Interaction；run activation 与 runtime enqueue 属于 Run Lifecycle。** Lifecycle 的单 SQLite transaction 不得拆分。
- **`revert` 属于 Session / Interaction。** head CAS/move 的原子 persistence 保持；本地 `AgentRuntime.cancelSession()` 同步移除内存队列且无抛错路径，远端 `AgentWorkerClient.cancelSession()` 内部吞错并记录 warning，因此当前观察到的语义是 DB 成功后的 runtime cancel 为 best-effort，不改变成功 revert 的 HTTP 语义。迁入 application 后仍必须 defensive catch + warn，防止未来 runtime 实现变化。
- **`cancel` 仍属于 Run Lifecycle。** Session route 只调用 lifecycle application entry，不在 Session application 复制 cancel cascade 或 DB-first 规则。
- **UI artifact read 属于 Context Query；artifact 安全路径与文件 I/O 属于共享窄 capability；artifact 写入时机仍属于 Context Writeback。**
- **错误映射延续当前项目风格。** application 可以直接抛 `HttpError`；route 默认只做 schema/auth/parse/success status，只保留 status summary 通用 500 等已冻结 generic bridge，不采用 domain error 由 route 统一翻译的混合口径。

## 文档结构

| 文件 | 职责 |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | 背景、目标、范围、非目标、完成定义 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 当前真实问题、调用链、代码证据与不变量 |
| [03-session-interaction-design.md](./03-session-interaction-design.md) | Session/Interaction、send/revert/cancel/fork 的 owner 与协作边界 |
| [04-context-query-and-artifact-design.md](./04-context-query-and-artifact-design.md) | Context Query 定稿、查询实体、Artifact 读写安全边界 |
| [05-route-grouping-design.md](./05-route-grouping-design.md) | route 分组、端点归属、最小依赖和 transport 规则 |
| [06-module-startup-composition-design.md](./06-module-startup-composition-design.md) | facade、composition root、startup coordinator 与进程生命周期 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 开发任务拆分、详细步骤、门禁、删除条件与回滚点 |
| [08-testing-review-acceptance.md](./08-testing-review-acceptance.md) | 测试矩阵、独立审查点、代码审查与验收标准 |
| [09-risks-stop-conditions-and-non-goals.md](./09-risks-stop-conditions-and-non-goals.md) | 风险、停止条件、兼容性与排除项 |
| [10-code-map.md](./10-code-map.md) | 生产文件、关键方法、调用方、测试与候选改动面 |
| [11-implementation-record.md](./11-implementation-record.md) | 实施批次、验证、独立审查/复审与最终验收记录 |

## 规范性用语

- “必须”是开发、代码审查和验收共同遵守的硬约束。
- “不得”表示不能以拆文件、减少行数、兼容旧测试或暂时省事为理由绕过。
- 文中的候选文件名、类名可以按项目风格微调，但职责归属、依赖方向、事务和副作用顺序不得改变。
- 如果实施时发现最新代码与本文证据不一致，必须先更新代码地图和设计影响，再继续开发，不得按旧行号机械迁移。

## 完成定义

只有以下条件全部满足，本阶段才算完成：

- Session / Interaction、Context Query 与 Peripheral Agent Query 均有显式 application owner；
- context tail/status summary 只归 `ContextQueryApplication`，recent/workspaces/final-text/available-agents 只归 `PeripheralAgentQueryApplication`；
- `sendMessage()`、`revert`、`cancel`、artifact read 不再存在未决责任分界；
- `AgentService` 只做薄委派，不再直接访问 Store、文件系统或向 route 暴露完整 `AppContext`；
- routes 已按四类责任分组，普通 handler 不包含业务编排；
- `agent.module.ts` 主要负责构造、注册、进程生命周期和 startup coordinator 触发；
- startup 顺序、fail/recover 时机、Worker/Plugin Host 生命周期未漂移；
- 核心 persistence adapter 可以继续依赖 `agent.store.ts` 的原子能力，但 route/module/facade 不得跨域直连 Store；
- URL、HTTP schema/status/error code、Shared internal contracts、DB schema、Artifact 格式与安全行为保持；
- 定向测试、API/Worker/Shared/Plugin/Web 回归、根 build/typecheck 和 diff hygiene 通过；
- 实施者外的独立审查与复审通过，最终由未参与实现的新审查员完成全面终审。
