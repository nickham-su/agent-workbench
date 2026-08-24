# 背景、目标与范围

## 背景

`0007-A`、`0007-B`、`0007-C` 已依次建立 Read-side、Context Writeback 与 Run Lifecycle 的职责域模式。普通用户 Run 的 activation、enqueue、state/complete、cancel 与 recovery 已有明确 application/persistence 边界，但 Subtask 相关规则仍主要集中在 `AgentService`：

- parent session / run / tool anchor 校验；
- prefork plan；
- `new`、`fork`、`existing` session 解析；
- child depth 与 max depth；
- durable lineage 查询与幂等复用；
- unique constraint race 后再查询；
- summary/guard/prompt、child run、run-state 的事务写入；
- result/status；
- start failure 后的空壳补偿；
- startup orphan suspect scan 与保守删除。

这些行为已有较强集成测试和 `0008-Agent-Fork与Subtask深度语义重构` 的语义基础。本阶段的现实问题不是“功能缺失”，而是规则仍难以按职责域定位，且 Subtask 与 Lifecycle、Session clone、startup module、Store 的依赖边界尚未结构化。

## 为什么现在治理

- `0007-C` 已提供稳定的 lifecycle application、SQLite persistence 和 cancel child query port，Subtask 可以依赖窄能力，而无需复制 run-state 规则；
- `0008` 已修正 ordinary primary Run、public fork、internal subtask session 与 depth/parent 字段语义，产品不变量已有测试基础；
- 当前 child activation 仍直接在 `AgentService` transaction 中写 context items、run record 与 run-state，是下一处最重要的跨域事务边界；
- local compensation 与 orphan cleanup 当前共用 `deleteEmptySubtaskSessionIfStillEmpty()`，虽然调用条件不同，但公开能力名称不能表达不同删除政策；
- module 当前直接调用 `service.scanAndCleanupSubtaskOrphansBestEffort()`，启动触发与领域规则尚未分离；
- 按 `0006` 路线图，Subtask 治理必须在 Compaction / Archive 之前完成。

## 阶段目标

### 建立可发现的 Subtask application

候选入口包括：

- `getPreforkPlan()`；
- `startSubtask()`；
- `getResult()`；
- `getStatus()`；
- `cleanupOrphansOnStartup()`。

最终命名可按项目风格调整，但必须形成一个明确职责域，不得继续将规则分散为 facade private helpers。

### 集中 durable lineage

- `(parentRunId, parentToolItemId)` 是唯一权威 lineage/幂等键；
- DB partial unique index 继续作为 race 的最终仲裁；
- cancel cascade 所需 child session 查询继续从 durable run/tool 关系得出；
- `subtaskSessionId` 只作展示、结果字段、提示和快速定位。

### 定稿与 Lifecycle 的协作

- Subtask 决定 parent anchor、session mode、depth、seed item 顺序和 lineage；
- Lifecycle-owned child activation capability 负责一个 transaction 内的 seed items、run record、running run-state；
- 该 activation 不调用 API runtime enqueue；
- Worker 在 API 返回后继续负责 `processNestedRun()`。

### 分离两类删除政策

- local compensation：仅处理本次 `new/fork` 创建、随后 start 失败且仍为空的 session；
- orphan cleanup：仅处理 startup scan 找到的 0005/0008 既定 suspect 范围，并经过 age、fork lineage 和最终空状态二次确认；
- 两者可以共享私有 SQL 构造，但公开 capability、应用入口、日志和测试必须分开。

### 建立可定位测试

- application tests 验证编排和错误映射；
- 真实 SQLite persistence tests 验证 unique race、lineage、transaction 和 delete fence；
- wiring tests 验证 facade/module/Lifecycle 依赖方向；
- 保留 API integration、API↔Worker、Worker provider 与 Shared contract 证据。

## 精确纳入范围

### API 生产代码

- `apps/api/src/modules/agent/agent.service.ts` 中 Subtask 相关方法与 private helpers；
- `apps/api/src/modules/agent/agent.store.ts` 中 lineage、child query、orphan candidate/delete 能力；
- `apps/api/src/modules/agent/agent.routes.ts` 的四个 internal Subtask endpoint，仅做薄转发复核；
- `apps/api/src/modules/agent/agent.module.ts` 的 orphan startup trigger；
- `apps/api/src/modules/agent/lifecycle/` 中 child activation 窄 capability 和既有 `ActiveSubtaskChildQuery` 衔接；
- session materialization/context clone 的窄协作适配，不在本阶段重写 public fork。

### 测试

- `apps/api/src/modules/agent/agent.integration.test.ts` 中现有 Subtask/lineage/orphan 证据；
- 新建 Subtask application/persistence/wiring 测试文件；
- `apps/agent-worker/src/runtime/tools/providers/builtin.prefork.test.ts`；
- `apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts`；
- `apps/agent-worker/src/runtime/runner.tool-output.test.ts`；
- `apps/agent-worker/src/runtime/apiClient.test.ts`；
- `packages/shared/tests/internal-contracts.test.ts`。

### 文档

- 本目录的行为基线、设计、实施计划、测试矩阵、代码地图和实施记录；
- 如实施发现 `0006` 或 `0008` 的长期说明与现实不符，按证据更新对应状态说明，但不得顺手重写历史设计。

## 明确排除

### 产品与协议

- 不新增或删除 Subtask mode；
- 不改变 prefork threshold 默认值、summary 生成行为或错误码；
- 不改变 Shared endpoint method/path/schema；
- 不改变 Worker tool 参数、tool output 文案合同或 polling 行为；
- 不改变 UI 行为。

### 数据与运行模型

- 不改 DB schema、partial unique index或历史 lineage 数据；
- 不新增 session depth、origin provenance、lease 或 generation 字段；
- 不把 `subtaskSessionId` 写成新的权威 DB 关系；
- 不提供完整 nested recovery 或 runtime 强停保证；
- 不把 nested child 加入 API runtime queue。
- 不为 worker-disabled local fallback 新增 Subtask API/port、`AgentRuntime` 依赖或 nested-subtask execution；

### 其他职责域

- 不迁移 Compaction / Archive 主体及 sidecar/reconcile；
- 不定稿 public Session / Routes / Module 最终目录；
- 不深拆 Worker Runner 或 BuiltinToolProvider；
- 不治理 Plugin / MCP / Git environment；
- 不统一 `archive/search` / `archive/read` Shared contract。

## 与 `0007-C` 的衔接

### 继续复用

- `RunLifecycleApplication` 的 state、complete、cancel 和 startup recovery；
- `ActiveSubtaskChildQuery` 的窄依赖方向；
- DB-first、cancel wins、runtime best-effort 与 late writeback fence；
- lifecycle SQLite persistence 的命名能力与测试模式。

### 不得回退

- Subtask application 不得自己实现 complete/cancel/recovery；
- Lifecycle 不得依赖完整 Subtask application 或 facade；
- Route 不得重新读取 Store 后拼装 start/reuse；
- module 不得持有 orphan candidate、age 或 delete fence 规则；
- child start 不得错误调用 `startUserRun()`，因为其 dedup、runtime enqueue 和输入语义不同。
- local fallback 与 API-managed Worker 的既有非等价边界不得因 application 装配而改变。

## 与 `0008` 的关系

### 继续作为硬约束

- ordinary primary Run 固定 `subtaskDepth=0` 且 parent 双空；
- child Run 写 `parent depth + 1` 与真实 parent 双字段；
- public primary fork 与 internal subtask fork 分离；
- copied context item 保持 `runId=null`；
- `new/fork/existing` metadata 与 summary/guard/prompt 顺序；
- existing session 不进入本次新建补偿删除路径；
- public/generic create 不能创建 subtask session。

### 已过时或仅作历史参考

- `0008` 的固定行号和旧代码地图；
- 将普通 user Run 创建仍描述为 `AgentService` 直接写入的部分；
- 将 Subtask 规则长期留在 `AgentService` 的结构状态；
- 当时记录的 Worker 全量测试例外，必须在本阶段重新运行后再形成当前结论；
- `0008` 解决的是 Fork/depth 产品语义，本阶段不得重新打开已冻结的产品决策。

## 术语

| 术语 | 本阶段含义 |
|---|---|
| parent anchor | 属于 parent session/run、`kind=tool`、`toolName=subtask` 的真实 context item |
| durable lineage | child `agent_run.parent_run_id + parent_tool_item_id` 及其真实 parent tool 约束 |
| reuse | 同一 parent tool 已存在 child run 时返回该 run，不重复 materialize/activate/execute |
| unique race | 并发 start 均未命中预查，最终由 partial unique index 仲裁，失败方再查并 reuse |
| local compensation | 本次创建的新空壳 session 在后续 start 失败后的条件删除 |
| orphan suspect | startup 扫描发现的老化、无 head、无 run、无 item 的 subtask session |
| nested activation | 写 seed items、child run 与 running run-state，但不进行 runtime enqueue 的 activation |

## 成功后的结构收益

- 新需求可以明确归属 Subtask、Lifecycle、Session clone 或 Worker，而不是继续落入 `AgentService`；
- lineage 与 deletion policy 可通过命名 capability 和独立测试定位；
- unique race 与 transaction boundary 可单独审查；
- startup orphan 失败不会影响 Lifecycle recovery、Archive reconcile 或 Worker start；
- 下一阶段 Compaction / Archive 治理不必同时承受 Subtask 结构迁移。
