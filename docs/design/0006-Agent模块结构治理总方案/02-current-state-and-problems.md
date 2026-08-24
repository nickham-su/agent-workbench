# 当前现状与问题地图

## 调研口径

本初稿基于当前源码静态调研和 0005 已完成设计/验收事实。文件规模只用于识别维护热点，不用于推导“超过多少行必须拆分”的规则。

调研时关键规模：

| 文件 | 约行数 | 当前角色 |
|---|---:|---|
| `apps/api/src/modules/agent/agent.service.ts` | 4970 | Agent 主业务编排中心，同时包含大量 helper |
| `apps/api/src/modules/agent/agent.store.ts` | 2209 | session/context/run/subtask/archive 等持久化能力集合 |
| `apps/api/src/modules/agent/agent.routes.ts` | 1259 | UI、internal Worker、Plugin/MCP、SSE 等路由入口 |
| `apps/api/src/modules/agent/agent.integration.test.ts` | 11573 | 157 个左右的跨域集成测试 |
| `apps/api/src/modules/agent/context-item-contract.test.ts` | 1078 | context writeback 与 archive 故障相关合同测试 |
| `apps/agent-worker/src/runtime/runner.ts` | 2718 | Worker 队列、模型、工具、压缩、写回与取消主控制流 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | 875 | 内建工具定义与执行分派 |
| `apps/agent-worker/src/runtime/apiClient.ts` | 362 | Worker → API internal client 与响应验证 |

## 当前模块关系

### API 入口与装配

`apps/api/src/modules/agent/agent.module.ts` 当前承担：

- 创建 `AgentService`；
- 创建本地 `AgentRuntime` 或连接 API-managed Worker；
- 创建 Worker manager/client；
- 创建 Plugin Host manager/client；
- 注册 Agent routes；
- 执行 startup recovery；
- 执行 orphan scan 和 archive pending reconcile 等启动期 best-effort 治理。

其中 `enqueueRecoveringRuns()` 和 `cancelRuntimeSessionsAfterDbConvergence()` 已包含业务一致性规则，不只是纯依赖装配。这使 module 同时承担 composition root 和启动期 lifecycle coordinator 两种职责。

### Routes

`apps/api/src/modules/agent/agent.routes.ts` 同时注册：

- 面向 UI 的 session、context、control、artifact 接口；
- Worker internal read/write 接口；
- subtask internal 接口；
- archive、MCP、Plugin、Git environment 相关 internal 接口；
- SSE / status 等运行状态入口。

Routes 大多遵循 schema、鉴权、调用 service 的模式，但入口类型繁多。若继续集中扩张，route 文件会越来越难按业务域定位，且容易把不同合同稳定性混为一体。

### AgentService

`apps/api/src/modules/agent/agent.service.ts` 的公开方法可按当前职责归类如下。

#### Session 与交互

- `listSessions()`；
- `listRecentSessions()`；
- `getSession()`；
- `createSession()`；
- `forkSession()`；
- `sendMessage()`；
- `revertSession()`；
- `clearSession()`。

#### Context 查询与 UI artifact

- `getContextItems()`；
- `getContextItem()`；
- `getContextItemById()`；
- `getApplyPatchUiArtifact()`；
- `getWriteUiArtifact()`。

#### Run 状态与生命周期

- `getRunState()`；
- `getSessionStatusSummary()`；
- `failRunOnEnqueueFailure()`；
- `cancelSession()`；
- `cancelSessionCascade()`；
- `updateRunStateFromWorker()`；
- `completeRunFromWorker()`。

#### Worker context writeback

- `appendContextItemFromWorker()`；
- `updateContextItemFromWorker()`。

#### Read-side / prompt

- `getExecutionProfileForRun()`；
- `getPromptContextForRun()`；
- `getMessagesContext()`；
- `buildPromptMessagesForSession()`；
- run prompt static cache 管理及 prompt/skill/tool 投影 helper。

#### Compaction / archive

- `compactSession()`；
- `compactContextFromWorker()`；
- `archiveSearchFromWorker()`；
- `archiveReadFromWorker()`；
- `reconcileArchivePendingForSessionBestEffort()`；
- `reconcileAllArchivePendingBestEffort()`。

#### Subtask

- `getSubtaskPreforkPlanFromWorker()`；
- `startSubtaskRunFromWorker()`；
- `getSubtaskRunResultFromWorker()`；
- `getSubtaskStatusFromWorker()`；
- `scanAndCleanupSubtaskOrphansBestEffort()`。

除这些公开用例外，文件前部还有大量与 archive、安全路径、prompt、tool output、skills、settings 等相关 helper。结果是一个类同时协调：

- DB 与事务；
- archive/artifact/tmp 文件；
- workspace store/service；
- settings 和 plugin service；
- prompt template 与工具投影；
- internal contract 类型；
- lifecycle fence、CAS 和终态规则。

问题不在于这些依赖单独存在，而在于它们缺少按职责域归属和最小能力面。

### AgentStore

`apps/api/src/modules/agent/agent.store.ts` 当前按函数集合提供多个持久化子域：

- session 创建、读取、最近列表、fork/head；
- context item append/update/query/transcript；
- run record 与 run-state；
- request dedup；
- compaction/archive 标记与摘要写入；
- subtask parent lineage、child 查询、orphan candidate 与删除；
- startup recovery 和 in-flight 收敛。

Store 已不只是简单 CRUD，其中包含关键一致性政策，例如：

- `appendContextItemWithRunFence()`；
- `getContextItemForWorkerUpdate()`；
- `updateContextItemWithRunFence()`；
- `appendSystemSummaryAndArchiveItems()`；
- `deleteEmptySubtaskSessionIfStillEmpty()`；
- `setRunStateIdleIfActiveRunMatches()`。

因此后续拆分不得把这些能力退化为“service 先读、再调用普通 update”的非原子流程。事务、fence、CAS 和删除前二次确认必须继续由持久化边界保证。

### Runtime 与 Worker

API 侧：

- `agent.runtime-port.ts` 定义 `enqueueRun()` / `cancelSession()`；
- `agent.runtime.ts` 是 Worker 关闭时的本地回退实现；
- `agent.worker-client.ts` / `agent.worker-manager.ts` 负责 Worker IPC 与进程；
- Plugin Host 也有独立 client/manager 路径。

当前 `AgentRuntimePort` 的 `AgentRuntimeRun` 类型从 `agent.service.ts` 导入 `AgentQueuedRun`，表明 runtime port 仍反向依赖 service 内部类型。`AgentRuntime` 本地回退实现也直接调用多个 `AgentService` 方法。后续治理需要逐步把运行输入合同和最小回调能力从大 service 中解耦，但不应在第一阶段重写 runtime 行为。

Worker 侧：

- `apiClient.ts` 已复用核心 Shared internal contracts；
- `runner.ts` 同时承担队列、模型、流式写回、工具执行、取消和 auto-compact；
- `builtin.ts` 是多类内建工具的分派中心；
- 文件和 apply patch 的重实现已有单独文件，是按能力提取的正向先例。

Worker 的大文件是真实维护热点，但其控制流时序敏感，当前适合作为后续专门阶段，而非 API 首轮治理的并行深拆对象。

## Shared contract 现状

当前公开入口为：

```text
@agent-workbench/shared/internal-contracts/agent-api
```

内部按以下文件组织：

```text
agent-api.ts
agent-api-run.ts
agent-api-context.ts
agent-api-subtask.ts
agent-api-read.ts
```

已经统一：

- run-state / complete；
- context create/update；
- compact；
- subtask prefork/start/result/status；
- execution profile / prompt context / messages context。

仍未纳入核心 Shared contract 的 `archive/search`、`archive/read`、Plugin/MCP/Git environment 等接口属于既有范围控制，不应被描述为当前结构治理的缺陷。

## 测试现状

### 大型综合测试

`apps/api/src/modules/agent/agent.integration.test.ts` 同时覆盖多个职责域，并直接使用：

- HTTP app；
- `AgentService`；
- `AgentRuntime`；
- startup recovery helper；
- 多个 store 函数；
- Worker/Plugin Host 相关 seam。

它提供了重要的端到端回归证据，但同时充当 HTTP 集成、service 编排、store 语义和 startup lifecycle 测试，导致失败定位与局部维护成本上升。

### Fixture 重复

`agent.integration.test.ts` 与 `context-item-contract.test.ts` 等测试均存在相似 setup：

- 临时 `dataDir`；
- SQLite 初始化；
- `AppContext` 构造；
- `createApp()`；
- workspace/session/run/context 数据准备；
- teardown。

缺少稳定的 Agent testkit 会使每次新领域拆分继续复制 setup 或跨层导入。

### Fault seam

`apps/api/src/app/context.ts` 中的 `AgentTestFaults` 当前包含：

- `archiveWrite`；
- `archiveRollback`；
- `archiveSidecar`。

这些 seam 为 0005 的 archive 故障测试提供了必要控制点，但其位于全局生产 `AppContext`。如果所有领域继续向这里追加测试开关，会使生产上下文承担无边界测试接口。未来应把故障 seam 约束在对应组件依赖中，并明确 production default。

## 主要问题地图

| 问题 | 表现 | 影响 |
|---|---|---|
| 职责聚合 | `AgentService` 同时负责 prompt、writeback、lifecycle、subtask、archive | 局部改动需要理解跨域规则，审查范围扩大 |
| 持久化边界聚合 | `agent.store.ts` 同时包含多个子域和关键事务政策 | 新函数难以判断归属，容易绕开原子 helper |
| 入口聚合 | routes 混合 UI/internal/plugin/MCP 等合同 | 合同稳定性与鉴权语义不易按域定位 |
| 装配与业务混合 | module 同时做 composition root 与 recovery/orphan/reconcile | 启动期用例难独立测试和复用 |
| 类型反向依赖 | runtime port 从 service 导入 run 类型 | port 边界不独立，阻碍渐进拆分 |
| 测试职责混合 | 大测试文件跨 HTTP/service/store/runtime | 失败定位、迁移和审查成本高 |
| Fixture 重复 | 多文件重复构造 DB/AppContext/workspace | setup 漂移、清理错误和维护重复 |
| Test seam 扩张风险 | `agentTestFaults` 位于全局 context | 生产类型与测试控制逐渐耦合 |
| 高风险目标并存 | Worker runner/builtin 同样偏大 | 若同时深拆 API 与 Worker，回归定位困难 |

## 已有正向基础

总体治理不是从零开始，当前已有可以延续的正向模式：

- Shared internal contracts 已按 run/context/subtask/read 子域分文件并保持唯一公开入口；
- prompt tool projectors 已从主 service 中提取；
- `AgentRuntimePort` 已存在最小控制面雏形；
- Worker manager/client 与 Plugin Host manager/client 已与业务 service 分文件；
- Store 已为关键 fence 提供原子 helper；
- 0005 已提供明确的不变语义和测试基线；
- 文件工具与 apply patch 在 Worker 中已经部分按能力独立。

后续应扩展这些成熟模式，而不是引入完全不同的架构体系。

## 当前判断

- API Agent 职责域治理是最高收益方向；
- 测试治理必须与结构治理同步设计；
- Shared contract 以稳定和复用为主，不追求全量统一；
- Worker 深拆后置，但蓝图中应保留观察和准入条件；
- transport/process 通用抽象缺少充分语义等价证据，当前只能作为评估项；
- 重型线性化机制没有真实问题触发，不属于结构治理默认路径。
