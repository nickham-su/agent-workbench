# 总体概览

## 背景

Agent 模块已从基础会话与模型运行能力，演进为包含以下能力的核心业务域：

- session 创建、fork、revert、clear、compact；
- message 发送、run 创建与状态维护；
- Worker read-side prompt/messages/profile 读取；
- Worker context item append/update 与终态写回；
- cancel、startup recovery、enqueue failure 收敛；
- subtask prefork、start、reuse、result、lineage、orphan 治理；
- archive 写入、rollback、pending sidecar reconcile；
- apply patch / write UI artifact；
- Plugin、MCP、Git environment 等外围运行能力入口；
- Worker 进程、Plugin Host 进程与 runtime 装配。

这些能力逐步落地后，关键业务规则已经存在，但代码结构尚未充分表达这些边界。API 侧主要由少数文件承担跨域职责：

```text
agent.routes.ts
  → agent.service.ts
      → agent.store.ts
      → workspace/settings/plugin/prompt/filesystem
      → archive/artifact/tmp
  → agent.runtime.ts / Worker client
```

这种结构仍可运行，也有较完整回归测试，但后续每次改动需要同时理解更多无关领域，增加开发、审查和回归定位成本。因此当前治理目标不是重新设计 Agent 产品能力，而是将已经稳定的职责、状态边界和依赖方向显式化。

## 文档定位

本方案是 Agent 模块未来一段时间的总体治理蓝图，用于回答：

- 为什么治理；
- 哪些职责需要建立边界；
- 目标依赖方向是什么；
- 哪些语义必须保持不变；
- 治理按什么高层顺序推进；
- 后续阶段方案必须提供哪些证据。

本方案不替代阶段性实施方案。任何实际治理阶段都必须补充：

- 当时代码基线和工作区状态；
- 精确纳入与排除的函数、路径和调用链；
- 迁移步骤及兼容策略；
- 自动测试、审查、手工验收和回滚边界；
- 是否变更公开或内部合同；
- 与本蓝图的差异及理由。

## 核心问题定义

当前主要矛盾不是单一大文件，而是以下问题叠加：

- 一个 service 同时承载多个状态边界和外部依赖；
- 一个 store 文件同时承载 session、context、run、subtask、archive 等持久化政策；
- routes 同时聚合 UI、internal Worker、Plugin/MCP、SSE 等入口；
- module 装配与 startup recovery 业务编排相互交织；
- 测试以超大综合文件为中心，fixture 与跨层导入重复；
- 测试 fault seam 位于全局 `AppContext`，存在继续扩张风险；
- Worker 主控制流和 builtin tools 同样偏大，但时序敏感，不宜和 API 首轮治理混改。

因此，本方案采用“按职责域治理 + 兼容 facade + 最小 testkit 前置使能 + 测试随职责域同步迁移”的演进方式。Plugin / MCP / Git environment 等外围 internal 能力不并入核心职责域拆分，过渡期默认留在外围适配层或 facade 边缘，避免扩大核心耦合面。

## 治理目标

### 让职责边界可见

目标结构应能直接回答：

- prompt/read-side 规则在哪里；
- context writeback fence 在哪里；
- run/cancel/recovery 规则在哪里；
- subtask durable lineage 和 orphan 规则在哪里；
- compaction/archive 文件与 DB 协调在哪里；
- 哪些是纯查询，哪些会改变持久化状态，哪些会调用 runtime 或文件系统。

### 收窄修改影响面

单一业务域的修改原则上只需要理解：

- 该域的应用服务；
- 该域依赖的持久化能力；
- 该域使用的 port / collaborator；
- 该域专属测试与少量端到端回归。

不得要求开发者默认阅读整个 `AgentService` 和全部综合集成测试才能安全修改一个局部规则。

### 保护已稳定业务语义

结构治理不等于业务重写。0005 已冻结并验收的 read-side、lifecycle、lineage、orphan、archive sidecar 语义必须保持。现有 UI 行为、internal contract、数据记录与 Worker 主链也默认保持。

### 改善测试可维护性

测试治理必须与结构治理同步推进，使测试层次与职责域对应，同时保留关键跨层主链证据。目标不是减少测试数量，而是降低：

- 重复 fixture；
- 跨层 private-like 依赖；
- 单个文件的认知范围；
- 故障注入对全局生产上下文的污染；
- 一个失败导致难以判断所属领域的问题。

### 支持渐进演进

目标架构必须允许分阶段迁移，避免一次性重写。过渡期保留 `AgentService` facade 和现有 route 调用面，内部逐步委派到职责域组件；`sendMessage()`、Context Query 与 Artifact 采用本蓝图定义的过渡期权威边界，最终实现形态由指定后续阶段定稿。

## 治理成功标准

总体治理是否成功，不以“文件变小”作为唯一或主要标准，而以以下结果判断：

- 关键业务规则有清晰归属且无重复权威实现；
- 依赖方向可说明、可审查，跨域调用是显式的；
- DB fence、事务、CAS、文件副作用的边界没有因拆分弱化；
- Routes 主要负责 transport concerns，不重新组装业务规则；
- Store 不再作为无边界的全域函数集合继续扩张；
- 测试按职责域可定位，同时保留 API↔Worker 等真实集成链路；
- 新功能能够判断应落在哪个职责域，无法归属时会触发架构评审；
- Worker 高风险治理与 API 治理分离，避免多个时序敏感改造同时发生；
- 每个阶段都能独立测试、审查、回滚，不依赖一次性完成全蓝图。

## 预期治理对象

### API Agent 核心

```text
apps/api/src/modules/agent/
```

重点包括：

- routes 与模块装配；
- application/domain orchestration；
- store/persistence capability；
- runtime port 与 startup coordinator；
- prompt、context、run、subtask、archive 等职责域；
- Agent 专属测试基础设施。

### 外围 internal 能力

```text
Plugin / MCP / Git environment internal endpoints
```

这些入口当前仍由 Agent 模块暴露，但不属于本轮核心职责域治理的默认吸收对象。治理口径是：

- 当前阶段不扩大它们对核心 Session、Run、Context、Subtask、Archive 组件的依赖；
- 过渡期默认保留在外围适配层或 `AgentService` facade 边缘；
- 核心 route 收尾时可以只做外围入口分组和薄转发，不顺手重写其协议或生命周期；
- 若未来需要独立边界、Shared contract 或进程治理，必须单独立项。

### Shared internal contracts

```text
packages/shared/src/internal-contracts/agent-api*.ts
```

其当前作用是 API 与 Worker 的稳定合同边界。总体治理阶段以保持和复用为主，不把扩大协议覆盖面作为目标。

### Worker

```text
apps/agent-worker/src/runtime/
```

Worker 属于总体治理观察范围，但当前优先级低于 API。只有在 API 职责和测试边界稳定后，才进入专门的 Worker 阶段设计。

## 指导性演进图

```text
当前

Routes ───────────────┐
Module/Recovery ──────┼─> AgentService ─> AgentStore
Local Runtime ────────┘       ├─────────> Filesystem/archive
                              ├─────────> Workspace/settings/plugin
                              └─────────> Prompt/tool projection

目标方向

Transport routes
  ├─ Core Agent routes
  │  └─ Agent facade / use-case entry
       ├─ Session & interaction
       ├─ Read-side & prompt
       ├─ Context writeback
       ├─ Run lifecycle
       ├─ Subtask
       └─ Compaction & archive
             │
             ├─ domain-specific persistence capabilities
             ├─ runtime port / worker client
             ├─ filesystem/archive/artifact ports
             └─ workspace/settings/plugin collaborators
  └─ Peripheral internal routes
       └─ peripheral adapters / facade edge（Plugin / MCP / Git environment）

Module / startup coordinator
  └─ 只负责装配与明确的启动期用例
```

图中的域名是职责边界，不是最终文件名承诺。阶段性设计可基于真实依赖合并或细分，但必须保持权威规则单一、依赖显式和可独立验证。
