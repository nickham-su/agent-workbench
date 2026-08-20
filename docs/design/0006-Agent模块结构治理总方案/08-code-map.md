# 当前代码地图

> 本文件用于后续阶段调研定位。行数和符号来自总体蓝图初稿时的静态调研，实施前必须重新核对。代码地图描述当前状态，不代表目标文件必须一一对应。

## 设计基线

```text
docs/design/0005-Worker-API读侧与生命周期治理/
```

优先阅读：

- `README.md`：已完成范围与排除项；
- `03-decisions.md`：read-side、lifecycle、lineage、sidecar 决策；
- `04-technical-design.md`：DB fence、recovery、orphan、archive 实现边界；
- `06-testing-acceptance.md`：测试与验收；
- `08-follow-up-recommendations.md`：工程结构治理与明确后置项。

## API Agent 核心

### 模块装配与启动

```text
apps/api/src/modules/agent/agent.module.ts
```

当前职责：

- 构造 `AgentService`；
- 构造本地 runtime 或 Worker runtime 适配；
- 构造 Worker manager/client；
- 构造 Plugin Host manager/client；
- 注册 routes；
- `enqueueRecoveringRuns()`；
- `cancelRuntimeSessionsAfterDbConvergence()`；
- startup orphan scan；
- startup archive pending reconcile。

治理关注：

- composition root 与 lifecycle 业务分离；
- startup coordinator；
- module 不直接聚合大量 Store 函数；
- best-effort 启动任务的错误隔离。

### Routes

```text
apps/api/src/modules/agent/agent.routes.ts
```

调研规模：约 1259 行。

当前入口类型：

- UI session/context/control；
- artifact；
- status/SSE；
- Worker internal run/context/read-side；
- subtask；
- archive；
- MCP/Plugin/Git environment 等外围入口。

治理关注：

- UI/public routes 优先按用户用例和职责域组织；
- Worker internal routes 优先按 Shared internal contract 和内部职责域组织；
- Plugin / MCP / Git environment 等外围 internal 入口单独成组；
- Shared endpoint/schema 复用；
- auth 和 status 映射不漂移；
- route 不做业务编排。

### AgentService

```text
apps/api/src/modules/agent/agent.service.ts
```

调研规模：约 4970 行。

#### Session / interaction

- `listSessions()`；
- `listRecentSessions()`；
- `getSession()`；
- `createSession()`；
- `forkSession()`；
- `sendMessage()`；
- `revertSession()`；
- `clearSession()`。

过渡期权威口径：`sendMessage()` 保持 facade 兼容入口，Session / Interaction 拥有用户命令和跨域入口，Run Lifecycle 拥有 run 状态与 runtime 规则；具体协作接口最晚在 Run Lifecycle 阶段定稿。

#### Context/UI query

- `getContextItems()`；
- `getContextItem()`；
- `getContextItemById()`；
- `getApplyPatchUiArtifact()`；
- `getWriteUiArtifact()`。

过渡期权威口径：Context Query 负责上述应用读取；Context Writeback 负责 artifact 生成/写入时机；共享 artifact 能力负责安全路径和文件 I/O。Context Query 最终模块/route 位置最晚在 Session / Routes / Module 收尾阶段定稿。

#### Run lifecycle

- `failRunOnEnqueueFailure()`；
- `getRunState()`；
- `getSessionStatusSummary()`；
- `cancelSession()`；
- `cancelSessionCascade()`；
- `updateRunStateFromWorker()`；
- `completeRunFromWorker()`。

#### Context writeback

- `appendContextItemFromWorker()`；
- `updateContextItemFromWorker()`。

#### Read-side/prompt

- `getExecutionProfileForRun()`；
- `getPromptContextForRun()`；
- `getMessagesContext()`；
- `buildPromptMessagesForSession()`；
- `runPromptStaticCache` 和清理 helper；
- prompt/skills/tools/settings 相关文件级 helper。

#### Subtask

- `getSubtaskPreforkPlanFromWorker()`；
- `startSubtaskRunFromWorker()`；
- `getSubtaskRunResultFromWorker()`；
- `getSubtaskStatusFromWorker()`；
- `scanAndCleanupSubtaskOrphansBestEffort()`。

#### Compaction/archive

- `compactSession()`；
- `compactContextFromWorker()`；
- `archiveSearchFromWorker()`；
- `archiveReadFromWorker()`；
- `reconcileArchivePendingForSessionBestEffort()`；
- `reconcileAllArchivePendingBestEffort()`。

#### 外围 internal 能力

文件还包含 MCP、Plugin snapshot/RPC、Git environment 等方法。其长期独立架构不在本蓝图的核心阶段定稿，不应混入 API 核心职责域拆分。

过渡期治理口径：

- 不扩大这些方法对核心 Session、Read-side、Writeback、Run Lifecycle、Subtask、Archive 组件的耦合；
- 默认暂留外围适配层或 `AgentService` facade 边缘；
- Routes 收尾时将其作为独立外围 internal 入口组，只做薄转发和必要的依赖收窄；
- 若要改变协议、生命周期、进程协作或长期模块归属，必须单独立项。

### AgentStore

```text
apps/api/src/modules/agent/agent.store.ts
```

调研规模：约 2209 行。

关键能力类别：

#### Session

- session list/get/create；
- head 获取/推进；
- fork 来源；
- recent sessions/workspaces 辅助查询。

#### Context

- `appendContextItem()`；
- `appendContextItemWithRunFence()`；
- `getContextItemForWorkerUpdate()`；
- `updateContextItemWithRunFence()`；
- visible/transcript/tail 查询；
- item 状态批量收敛。

#### Run/run-state

- `createRunRecord()`；
- `getRunRecord()`；
- `getRunState()`；
- `updateRunState()`；
- in-flight/terminal/recovery 查询；
- idle/failure CAS helper。

#### Subtask

- parent tool dedup/reuse；
- durable child lineage；
- orphan candidates；
- 空壳二次确认删除。

#### Compaction/archive DB

- archiveAt 标记；
- summary append；
- compact/clear 的 DB 状态更新。

治理关注：

- 保持 fence/事务/CAS；
- 按 capability 拆导出边界；
- 避免 route/service 跨域任意 import；
- 不按表机械 repository 化。

## API Runtime 与进程

```text
apps/api/src/modules/agent/agent.runtime-port.ts
apps/api/src/modules/agent/agent.runtime.ts
apps/api/src/modules/agent/agent-run-context.ts
apps/api/src/modules/agent/agent.worker-client.ts
apps/api/src/modules/agent/agent.worker-manager.ts
apps/api/src/modules/agent/agent.plugin-host-client.ts
apps/api/src/modules/agent/agent.plugin-host-manager.ts
apps/api/src/modules/agent/run-completed-events.ts
```

当前关注：

- `agent.runtime-port.ts` 从 `agent.service.ts` 导入 `AgentQueuedRun`；
- `agent.runtime.ts` 本地 fallback 直接依赖具体 `AgentService`；
- Worker/Plugin Host client/manager 虽结构相似，但不能据此直接抽象；
- completed event hub 与 subtask result/status 的关系需在阶段调研时复核。

## Prompt 子结构

```text
apps/api/src/modules/agent/prompt/
apps/api/src/modules/agent/prompt/tool-projectors/
```

这是已存在的按能力提取先例。Read-side/Prompt 阶段应复核：

- 哪些 helper 已独立；
- 哪些仍位于 `agent.service.ts` 文件级作用域；
- settings/plugin/skills 输入是否可通过最小 reader capability 获取；
- cache invalidation 如何与 run lifecycle 解耦。

## AppContext 与路径

```text
apps/api/src/app/context.ts
apps/api/src/infra/fs/paths.ts
```

`AppContext.agentTestFaults` 当前包含：

- `archiveWrite`；
- `archiveRollback`；
- `archiveSidecar`。

治理关注：

- 不继续无约束扩张；
- compaction/archive 阶段迁移到组件级受限 hook；
- path helper 继续保证 archive/artifact/tmp 受控路径；
- 日志不得暴露敏感绝对路径和内容。

## Shared internal contracts

```text
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/src/internal-contracts/agent-api-run.ts
packages/shared/src/internal-contracts/agent-api-context.ts
packages/shared/src/internal-contracts/agent-api-subtask.ts
packages/shared/src/internal-contracts/agent-api-read.ts
packages/shared/tests/internal-contracts.test.ts
```

唯一公开入口：

```text
@agent-workbench/shared/internal-contracts/agent-api
```

核心 endpoint registry：

- `updateRunState`；
- `completeRun`；
- `createContextItem`；
- `updateContextItem`；
- `compactContext`；
- `getSubtaskPreforkPlan`；
- `startSubtask`；
- `getSubtaskResult`；
- `getSubtaskStatus`；
- `getExecutionProfile`；
- `getPromptContext`；
- `getMessagesContext`。

当前后置：

- `archive/search`；
- `archive/read`；
- Plugin/MCP/Git environment 等外围协议。

## Worker Agent 核心

### API Client

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

当前职责：

- internal token；
- HTTP request；
- non-2xx 处理；
- conflict 映射；
- Shared endpoint/type/schema；
- success response strict/warn runtime validation；
- 脱敏 diagnostic。

API 结构治理必须保证其调用合同不变。

### Runner

```text
apps/agent-worker/src/runtime/runner.ts
```

调研规模：约 2718 行。

当前职责：

- run queue/concurrency；
- session tree cancel；
- model step/stream；
- tool batch；
- writeback/finalization；
- auto-compaction；
- prompt/messages/profile 调用；
- run completion/error 收敛。

后续治理前必须补充时序图，不得按方法数量直接拆分。

### Builtin tools

```text
apps/agent-worker/src/runtime/tools/providers/builtin.ts
apps/agent-worker/src/runtime/tools/providers/builtin.prefork.test.ts
apps/agent-worker/src/runtime/tools/providers/builtin.scratchpad-toggle.test.ts
```

当前职责：

- 内建工具 schema/definition；
- 文件/bash/apply patch/write；
- subtask；
- archive；
- skill；
- scratchpad/todolist；
- Git environment 等能力分派。

后续方向是按工具域提 executor，而不是改变工具名、schema、结果或执行顺序。

### 已独立的重能力

```text
apps/agent-worker/src/runtime/tools/applyPatch.ts
apps/agent-worker/src/runtime/tools/fileTools.ts
apps/agent-worker/src/runtime/tools/registry.ts
apps/agent-worker/src/runtime/tools/types.ts
```

这些文件可作为“保留 provider 入口、提取具体执行能力”的参考。

## 关键测试

```text
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts

apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

调研规模：

- `agent.integration.test.ts`：约 11573 行，约 157 个测试；
- `context-item-contract.test.ts`：约 1078 行；
- Worker 侧 runner/apiClient 测试已按部分行为分文件。

后续阶段应优先建立 testkit，然后随职责域迁移测试，而不是一次性重排全部用例。

## 建议后续调研命令

阶段设计前可复核：

```bash
wc -l \
  apps/api/src/modules/agent/agent.service.ts \
  apps/api/src/modules/agent/agent.store.ts \
  apps/api/src/modules/agent/agent.routes.ts \
  apps/api/src/modules/agent/agent.integration.test.ts \
  apps/agent-worker/src/runtime/runner.ts \
  apps/agent-worker/src/runtime/tools/providers/builtin.ts
```

```bash
rg -n '^  (private )?(async )?[A-Za-z][A-Za-z0-9_]*\(' \
  apps/api/src/modules/agent/agent.service.ts
```

```bash
rg -n '^export (async )?function ' \
  apps/api/src/modules/agent/agent.store.ts
```

```bash
rg -n 'AgentService|agent\.store|AgentRuntime|AgentApiEndpoints|agentTestFaults' \
  apps/api/src/modules/agent \
  apps/api/src/app/context.ts \
  apps/agent-worker/src/runtime \
  packages/shared/src/internal-contracts
```

命令输出只作为定位。阶段设计还需读取相关实现、测试和 0005 文档，不得只依据搜索结果决定边界。

## 初稿代码地图待复核点

- `sendMessage()` 的显式 lifecycle 能力和事务边界如何实现；核心责任分界不再开放，最晚在 Run Lifecycle 阶段定稿；
- Context Query 最终采用独立模块还是 Session read model 子模块；read/write 与 artifact 安全能力边界不再开放；
- run lifecycle 与 subtask child query 的最小接口；
- local fallback runtime 应依赖哪些最小 application ports；
- startup coordinator 是否统一编排 recovery/orphan/reconcile；
- Plugin/MCP/Git environment 外围适配层是否还存在未识别的核心反向依赖；其深度治理不属于核心阶段；
- Store 拆分采用函数式文件边界还是能力对象；
- archive fault hook 从 `AppContext` 迁移的最小方案。
