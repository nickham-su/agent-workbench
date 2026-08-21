# 当前代码地图

> P0 已复核符号、调用者和测试；路径不是最终目录承诺。

## 上位文档

```text
docs/design/0004-Worker-API核心写回协议统一/
docs/design/0005-Worker-API读侧与生命周期治理/
docs/design/0006-Agent模块结构治理总方案/
docs/design/0007-A-第一阶段-基线与Read-side-Prompt结构治理/
```

当前第一阶段实现提交：

```text
0f57bfe feat(agent): implement phase 1 read-side governance
```

每批实施前以完整 Git 状态建立保护清单；非本阶段 staged/worktree 变更不得触碰。具体当前状态记录在 README、`02` 和 `09`，代码地图不重复固化单一路径。

## Shared contract

### 聚合入口

```text
packages/shared/src/internal-contracts/agent-api.ts
```

关键符号：

```text
AgentApiEndpoints.createContextItem
AgentApiEndpoints.updateContextItem
```

### Context schema

```text
packages/shared/src/internal-contracts/agent-api-context.ts
```

关键符号：

```text
AgentApiContextItemParamsSchema
AgentApiCreateContextItemRequestSchema
AgentApiCreateContextItemResponseSchema
AgentApiUpdateContextItemRequestSchema
AgentApiUpdateContextItemResponseSchema
buildAgentApiContextItemPath()
```

本阶段默认只读；任何修改触发停止。

### Shared tests

```text
packages/shared/tests/internal-contracts.test.ts
```

当前关键用例：

```text
agent-api endpoint registry contains all twelve method/path definitions
agent-api context schemas reuse public output and complete record schemas
agent-api context path builder validates positive integer params
```

## Worker

### Client

```text
apps/agent-worker/src/runtime/apiClient.ts
```

关键方法：

```text
createContextItem()
updateContextItem()
request()
```

需要保持：endpoint registry、path builder、response schema、create conflict mapping、strict/warn 与脱敏诊断。

### Client tests

```text
apps/agent-worker/src/runtime/apiClient.test.ts
```

关键用例：

```text
context create/update use shared contracts and return complete records
context create accepts the late ignored success branch
context create maps 409 to ApiConflictError while update preserves raw non-2xx
context response validation observes strict/warn boundaries and path builder rejects invalid ids
```

### Runner/runtime 调用面

```text
apps/agent-worker/src/runtime/runner.ts
```

P0 仅定位 create/update 调用顺序；本阶段不修改主控制流。

## API Route

```text
apps/api/src/modules/agent/agent.routes.ts
```

关键 Route：

```text
POST  /api/internal/agent/context-items
PATCH /api/internal/agent/context-items/:itemId
```

冻结的是 Shared endpoint 的 method/path/schema，以及 Worker 使用 `buildAgentApiContextItemPath()` 构造 update 路径；具体对象内部属性名不作为规范事实。

当前职责：Shared schema、token 防御性检查、调用 Service、update response 包装。不得承载 writeback 规则。

相邻但排除：

```text
POST /api/internal/agent/run-state
POST /api/internal/agent/run-complete
POST /api/internal/agent/context/compact
subtask routes
archive routes
```

## AgentService

```text
apps/api/src/modules/agent/agent.service.ts
```

### Writeback application

```text
apps/api/src/modules/agent/writeback/context-writeback-application.ts
apps/api/src/modules/agent/artifact/ui-artifact-capability.ts
```

`ContextWritebackApplication` 是 create/append 与 update 的编排权威，接收以下窄依赖：

- `appendWithRunFence()`：直接映射到 Store 原子 append fence；
- `nowMs()`、纯 `formatTodolistTitle()` 与 `updateSessionTitle()`；
- append conflict 的识别与有限 warning callback；
- `inspectForWorkerUpdate()` 与 `updateWithRunFence()`：直接映射到 Store 的初步与最终原子 update fence；
- `UiArtifactCapabilityPort` 与有限 artifact error/warning logger：只在 application 已确定的时机执行 apply_patch/write artifact I/O。

application 持有 completed `apply_patch` create 禁止、createdAt 默认值、Store union/`HttpError` 映射、两次 update fence 映射、成功 completed `todolist` 的 title 触发与 409 映射；不拆开 Store transaction，也不接收 `AppContext`/`AgentService`。两个 `AgentService` 公共 writeback 方法均只保留兼容 facade。

P5 已删除 `prepareUpdateArtifactsLegacy()` 与 callback。application 仍严格按“初步 fence → artifact 尝试/结果 slim → 最终 `updateWithRunFence()`”编排；completed write 才 split/write，failed/cancelled 不 split、不写 artifact。

P6 静态复核确认 `AgentService.appendContextItemFromWorker()` 与 `updateContextItemFromWorker()` 均为单行兼容 facade，只将原参数、返回值和错误透传给 application。

### Writeback 入口

```text
appendContextItemFromWorker()
updateContextItemFromWorker()
```

### Create 当前直接依赖

```text
ContextWritebackApplication.appendContextItemFromWorker()
appendWithRunFence() capability
nowMs() capability
formatTodolistTitle() capability
updateSessionTitle() capability
append conflict warning capability
```

### Update 当前直接依赖

```text
ContextWritebackApplication.updateContextItemFromWorker()
inspectForWorkerUpdate() capability
UiArtifactCapabilityPort
updateWithRunFence() capability
nowMs() capability
formatTodolistTitle() capability
updateSessionTitle() capability
```

### 当前 artifact 能力与 Writeback 结果拆分依赖

```text
apps/api/src/modules/agent/artifact/ui-artifact-capability.ts
UiArtifactCapability
apps/api/src/modules/agent/writeback/ui-artifact-result-split.ts
splitApplyPatchResult()
splitWriteResult()
```

`UiArtifactCapability` 只支持固定 apply_patch/write UI artifact 的 path/payload JSON 读写；不提供通用路径读写接口。

### Context Query / artifact read

```text
getContextItem()
getApplyPatchUiArtifact()
getWriteUiArtifact()
UiArtifactCapability.readApplyPatch()/readWrite()
```

Query 保留 item/tool/toolCallId 校验并直接依赖 artifact capability，明确不依赖 Writeback。

本阶段只定稿共享 artifact capability；Context Query 最终模块/route 归属留给 Session/Routes/Module 收尾。

### 相邻排除区域

```text
updateRunStateFromWorker()
completeRunFromWorker()
cancelSession*()
compactContextFromWorker()
subtask methods
archive methods
read-side/prompt components
```

## Agent Store

```text
apps/api/src/modules/agent/agent.store.ts
```

### 原子 writeback 能力

```text
appendContextItemWithRunFence()
getContextItemForWorkerUpdate()
updateContextItemWithRunFence()
```

### 内部关键函数

```text
appendContextItemInTransaction()
getContextItemForWorkerUpdateInTransaction()
updateContextItem()
getAgentSession()
getRunRecord()
getRunState()
setHead()
touchSession()
```

### 结果类型

```text
AgentFencedAppendResult
AgentFencedUpdateResult
```

### Head conflict

```text
AgentConflictError
```

P0 必须定位 `appendContextItemInTransaction()` 内 `prevId`/head 判断；P3 不得绕过。

## Artifact path 与安全 I/O

### Path

```text
apps/api/src/infra/fs/paths.ts
```

关键符号：

```text
tmpRoot()
applyPatchUiArtifactPath()
```

`writeUiArtifactPath()` 已由 P0 纳入本阶段，且只服务 completed write artifact。

### 受限安全 I/O 原语

```text
apps/api/src/modules/agent/artifact/safe-file-io.ts
```

关键符号：

```text
ensureRealPathUnderRoot()
ensureDirSafeUnderRoot()
writeFileNoFollow()
readFileNoFollow()
```

它们仅提供 containment、目录安全与 no-follow 文件操作；artifact capability 和 compaction snippet cache 共用，后者不依赖 Writeback 或 UI artifact 业务能力。archive/compaction 业务没有迁入 artifact 层。

### Result split 与 payload type

已确认主线需精确定位：

```text
splitApplyPatchResult()
ApplyPatchUiArtifactV1
```

P0 已确认的 write artifact：

```text
splitWriteResult()
WriteUiArtifactV1
```

completed 的 full/slim 和文件格式已冻结；failed/cancelled 不创建 artifact 或 slim result。

## 本地 fallback runtime

```text
apps/api/src/modules/agent/agent.runtime.ts
```

当前直接调用：

```text
service.appendContextItemFromWorker()
service.updateContextItemFromWorker()
```

本阶段依靠 `AgentService` facade 保持兼容，不重构 runtime。

## API-managed Worker

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

关键证据：internal RPC 记录与顺序：

```text
context create
run-state
context update
run-complete
```

保持：

```text
run-state < context update < run-complete
```

专属 Worker 进程/socket/端口/LLM stub 不纳入公共 testkit。

## 核心 API 测试

### Context contract

```text
apps/api/src/modules/agent/context-item-contract.test.ts
```

本域关键用例：

```text
Context create/update return complete records and accept shared output variants
Context create/update reject invalid output before response serialization and preserve token priority
Context create preserves head conflict and terminal update returns the unchanged stored item
Context create rejects a missing run without appending or returning ignored
Context create late fences terminal runs without changing context, title, or run state
Context create late fences a run after activeRunId switches at the Store boundary
Store append fence is authoritative within its transaction
Context update late fences terminal and switched runs without changing the stored item
Context update rejects an item whose run ownership is inconsistent
```

同文件中的 compact/archive/sidecar 用例属于后续阶段，不得误迁。

### Artifact integration

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

关键区域：

```text
apply_patch artifact 写入/瘦身/读取/缺失
write completed/failed/cancelled、artifact 读取和缺失场景
```

P0 已记录精确用例、生产生成点与 API symlink characterization；测试名本身不是唯一纳入证据。P6 保留这些复杂 Fastify/SQLite/filesystem Query 场景在综合文件中，避免为目录归属拆分而削弱 artifact 路径、安全 I/O 与 response 映射的真实边界。

### 0007-A testkit

```text
apps/api/src/modules/agent/testkit/agent-testkit.ts
apps/api/src/modules/agent/testkit/agent-testkit.test.ts
```

冻结公共导出：

```text
createAgentTestFixture()
resolveAgentApiTestRepoRoot()
createTestWorkspace()
createTestRepository()
injectJson()
createFakeAgentRuntime()
```

P1 实施记录：默认复用，不扩张。`context-item-contract.test.ts` 保留私有 fixture，以免把 archive/sidecar fault 的专属资源纳入公共合同；`writeback.api.test.ts` 用现有 testkit 的显式 SQLite/Fastify/workspace 注入能力验证 Route/CAS，不引入 context/run builder。该记录不表示 P0/P1 合并审查门禁已经通过，当前门禁状态以 `09-implementation-record.md` 为准。

## 当前领域目录

```text
apps/api/src/modules/agent/writeback/
  context-writeback-application.ts
  context-writeback-application.test.ts
  ui-artifact-result-split.ts

apps/api/src/modules/agent/artifact/
  safe-file-io.ts
  ui-artifact-capability.ts
```

未新增 persistence adapter：现有 Store 原子能力仍是唯一 transaction 权威，额外 adapter 没有明确收益。

## P0 推荐定位命令

```bash
rg -n "appendContextItemFromWorker|updateContextItemFromWorker" \
  apps/api/src/modules/agent

rg -n "appendContextItemWithRunFence|getContextItemForWorkerUpdate|updateContextItemWithRunFence|AgentConflictError" \
  apps/api/src/modules/agent

rg -n "applyPatchUiArtifactPath|splitApplyPatchResult|writeFileNoFollow|readFileNoFollow" \
  apps/api/src/modules/agent apps/api/src/infra/fs

rg -n "writeUiArtifactPath|splitWriteResult|getWriteUiArtifact" \
  apps/api/src/modules/agent apps/api/src/infra/fs

rg -n "createContextItem|updateContextItem|ignored|session head conflict" \
  packages/shared apps/agent-worker/src/runtime apps/api/src/modules/agent
```

测试从正确 cwd 运行：

```bash
cd apps/api
npx tsx --test src/modules/agent/context-item-contract.test.ts
```
