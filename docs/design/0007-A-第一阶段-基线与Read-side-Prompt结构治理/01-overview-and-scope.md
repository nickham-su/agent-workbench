# 背景、目标与范围

## 与 0006 总方案的关系

`0006-Agent模块结构治理总方案` 定义中期治理蓝图：按职责域建立边界、保持 0005 语义、测试与生产结构同步推进。本文件是其第一阶段的实施方案，负责把蓝图中的“最小 testkit 前置使能”和“Read-side / Prompt 治理”落成可分批执行的设计。

本阶段不是新的总蓝图，也不提前决定后续 Context Writeback、Run Lifecycle、Subtask、Compaction / Archive 或 Session / Routes / Module 收尾阶段的最终结构。后续阶段若需要改变本阶段的结构假设，必须引用新证据并说明与 0006 的差异。

## 阶段组成与顺序

本阶段包含两个相互依赖但不能混批的子阶段：

```text
1A 基线与最小 testkit 起步
  → 独立测试与架构审查
  → 1A 复审通过
  → 1B Read-side / Prompt 结构治理
  → 独立测试与架构审查
  → 1B 复审通过
```

### 1A 的作用

1A 是 1B 的前置使能，解决后续迁移所需的最小公共验证能力：

- 现状证据可重复获取；
- 测试 fixture 生命周期一致；
- fake runtime 可以表达 read-side 主链测试所需的最小运行边界；
- 失败时能区分 testkit、生产结构和真实集成链路的问题。

1A 不以整理全部测试为目标。它达到最小退出条件后必须结束，之后公共能力只能随职责域治理的真实需要扩展。

### 1B 的作用

1B 是 0006 下第一轮正式生产结构治理，使用 1A 的测试地基，把 API 侧已稳定的 Read-side / Prompt 规则从 `AgentService` 的跨域聚合中提取为清晰的内部职责边界，同时保留兼容 facade、Shared contract、Route 和 Worker 调用面。

## 背景问题

当前 API Agent 的主要编排集中在：

```text
apps/api/src/modules/agent/agent.service.ts
```

该文件约 4970 行，同时包含 session、run、context writeback、subtask、compaction/archive、artifact、read-side/prompt 和外围能力。Read-side 相关逻辑集中在 service 的后半部分，但其依赖横跨：

- session/run/context 查询；
- workspace、settings、plugin 配置读取；
- prompt templates、skills、tool projection；
- 文件系统中的 instruction / compaction snippet；
- `runPromptStaticCache`；
- Shared read-side response 类型。

已有正向先例：

```text
apps/api/src/modules/agent/prompt/tool-projectors/
```

该目录已经按能力提取 tool projection，说明本阶段可以沿用“职责面 + 小能力组件”的渐进方式，而不必重写整个 prompt 系统。

测试方面，当前主要证据集中在：

- `apps/api/src/modules/agent/agent.integration.test.ts`：大型跨域集成测试；
- `apps/api/src/modules/agent/agent.worker.integration.test.ts`：真实 API-managed Worker 主链；
- `apps/api/src/modules/agent/context-item-contract.test.ts`：Context 合同与部分 archive 故障；
- `apps/agent-worker/src/runtime/apiClient.test.ts`：Worker client schema/error；
- `apps/agent-worker/src/runtime/runner.auto-compact.test.ts`：Worker prompt/context/auto-compact 调用替身。

1A 处理公共 fixture 的最小重复，1B 只迁移与 Read-side / Prompt 直接相关的测试，不在本阶段重组所有跨域用例。

`agent.integration.test.ts` 允许继续保留 lifecycle、writeback、subtask、archive、外围能力及尚不适合迁移的跨域集成用例。本阶段完成不以清空或彻底拆除该综合测试文件为条件。

## 阶段目标

### 结构目标

- 建立第一套可复用的职责域提取模式；
- 让 execution profile、prompt context、messages context 和 prompt cache 的权威规则有明确归属；
- 使 `AgentService` 只保留兼容入口和必要委派，不再新增 read-side 领域规则；
- 让 Read-side / Prompt 组件依赖最小、显式，不接收完整 `AppContext` 或完整 `AgentService` 作为新设计默认。

### 行为目标

- 不改变已完成的 0005 read-side contract；
- 不改变 prompt cache 及模型输入语义；
- 不改变 API/Worker 的鉴权、错误、路径和 response shape；
- 不改变本地 fallback 与 API-managed Worker 的调用行为。

### 验证目标

- 用 1A testkit 支撑 1B 的领域测试和必要集成测试；
- 真实 SQLite 仍验证 read-side 归属和 workspace/session/run 校验；
- Shared schema、API Route、Worker client、Worker runtime 证据保持完整；
- 迁移后能按职责域定位失败，而不是依赖完整综合测试理解所有行为。

## 本阶段范围

### 1A 纳入

- 本阶段代码地图与调用证据复核；
- read-side/prompt 相关测试命令、cwd、临时目录、DB 和服务清理基线；
- 最小 Agent testkit：临时数据目录、SQLite/AppContext/createApp、workspace/repository、session/run 基础 builder、fake runtime、teardown；
- 代表性测试的等价迁移和运行验证。

### 1B 纳入

- API read-side application service：execution profile、prompt context、messages context；
- prompt messages 组装、system prompt、locale、skills、tool/pending tool projection、compaction snippet 读取；
- prompt static cache 的显式归属或内部 collaborator；
- `AgentService` 兼容委派；
- 与上述路径直接相关的 API Route / Worker Client 类型调用保持和测试；
- read-side/prompt 测试按职责域迁移。

## 非目标

本阶段明确不做：

- 修改 `packages/shared/src/internal-contracts/agent-api*.ts` 的合同范围或字段语义；0005 已完成的 Shared contract 只作为输入边界；
- 新增 archive/search/read endpoint contract；
- Context Writeback 的 append/update/fence/artifact 生成逻辑；
- `sendMessage()`、run-state、cancel、recovery、enqueue failure 和 runtime lifecycle；
- subtask lineage/orphan；
- compaction/archive DB+文件协调和 sidecar；
- Route 全面按职责域拆分；本阶段只允许为 read-side 委派所需的最小装配调整；
- `AgentService` 全量拆分；
- Worker `runner.ts`、builtin provider、Plugin Host 或 transport/process manager 深拆；
- UI 交互、数据库 schema、文件格式、全局错误 envelope、全局 retry/timeout。

## 完成标准

本阶段完成不是看文件减少了多少行，而是看：

- 1A testkit 的边界小而稳定，且已被 1B 的真实测试使用；
- 1B 的 read-side/prompt 规则有唯一权威归属；
- 新组件没有复制旧 service 的 prompt/cache 逻辑；
- `AgentService` 不再成为新增 read-side 逻辑的默认落点；
- 关键 DB/文件读取、合同、缓存和 Worker 链路证据不减少；
- 迁移可以独立回滚，不需要回滚后续阶段；
- 所有批次经过测试、独立审查和复审。
