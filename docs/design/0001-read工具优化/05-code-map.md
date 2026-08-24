# 代码地图与基线核对

返回 [README](./README.md)。本文件列出当前实现相关的稳定文件和符号。最终审查和后续维护时必须在当前分支搜索符号并核对职责；不要仅依赖历史行号，因为重构会导致行号漂移。

## Worker：文件读取、类型传播与错误输出

| 路径 | 符号/区域 | 当前职责 | 本期改动责任 |
|---|---|---|---|
| `apps/agent-worker/src/runtime/fileTools.ts` | `ensureSafeRelativePath` | 校验非空、非绝对、无 NUL/CR/LF 的相对路径。 | 复用；不得放宽。 |
| 同上 | `resolveWithinWorkspace` | 将相对路径解析到 workspace 并检查 containment。 | 复用到根路径、repo 根和候选。 |
| 同上 | `ensureRealPathInsideWorkspace` | realpath 后确认路径不逃逸 workspace。 | 对 repo 根和候选复用；中间 symlink 是否可接受由此决定。 |
| `apps/agent-worker/src/runtime/workspaceRepoDirNames.ts` | `isSafeWorkspaceRepoDirName` / `normalizeWorkspaceRepoDirNames` | Worker 私有、无文件系统依赖的 repo 目录名安全校验、稳定去重和 100 项上限。 | 由 `server.ts` 和 `fileTools.ts` 复用；API 因部署边界保留独立校验并同步规则。 |
| 同上 | `runReadTool` | `read` 的路径检查、`lstat`、最终 symlink 拒绝、目录/文本读取入口。 | 已加入**必有** repo 名称参数、缺失类错误捕获、限并发定点探测、取消检查与错误提示。 |
| `apps/agent-worker/src/runtime/tools/types.ts` | `QueuedRunContext` | Provider 可见的当前 run 上下文。 | 已加入必有 `workspaceRepoDirNames: string[]`。 |
| 同上 | `NestedRunContext` | `processNestedRun` 的子 run 参数。 | 已加入必有 `workspaceRepoDirNames: string[]`。 |
| 同上 | `ToolExecutionContext` | Provider 执行上下文，包含 `run` 与 `processNestedRun`。 | 通过上述必有类型传播字段；未增加可选旁路字段。 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | `BuiltinToolProvider.execute` 的 `case "read"` | 解析 `read` 参数并调用 `runReadTool`。 | 仅透传 `ctx.run.workspaceRepoDirNames`。 |
| 同上 | 内建 `subtask` 的 `ctx.processNestedRun(...)` 构造处 | API 启动子任务后构造 Worker 内 nested run。 | 复制 parent 的名称数组；不得从响应或磁盘重取。 |
| `apps/agent-worker/src/runtime/apiClient.ts` | `AgentApiClient.startSubtaskRun` | 调用 `/api/internal/agent/subtask/start`，响应含 `sessionId`、`runId`、`workspacePath`、`agentName`、`reused`。 | 不改响应 schema；不得新增 repo 字段。 |
| `apps/agent-worker/src/runtime/runner.ts` | `QueuedRun` | Worker 内部排队执行对象。 | 已加入必有 `workspaceRepoDirNames: string[]`。 |
| 同上 | `EnqueuePayload` | Worker HTTP enqueue JSON 的显式类型。 | **唯一可选类型边界**：已加入 `workspaceRepoDirNames?: string[]`。 |
| 同上 | `processNestedRunWithController` / 创建 `ToolExecutionContext` | 执行 nested run 并把 run 交给工具。 | 类型必须自然携带必有数组；取消继续沿用现有 controller 逻辑。 |
| 同上 | `executeTool` / `executeToolSafely` / `processRun` | 写失败工具结果，或在 abort 时结束 run。 | 不改失败格式；验证 abort 不写伪 `failed`，而由既有 `cancelled` 流程收尾。 |
| 同上 | `buildToolText` 及 `executeTool` / `executeToolSafely` 错误路径 | `output.error` 保存原始错误字符串；失败 `output.text` 由 `buildToolText` 生成，格式为 `tool: read\nstatus: failed\n\n<错误内容>`。 | 沿用既有错误输出合同；不引入 XML 风格的错误包装标签。 |
| `apps/agent-worker/src/server.ts` | `POST /internal/runs/enqueue` / `normalizeWorkspaceRepoDirNames` | 手写校验 JSON 后调用 `runner.enqueueRun`。 | 唯一 JSON 入站边界：缺失字段变 `[]`，其余安全校验、去重和上限复用 Worker 私有 helper。 |

## API：workspace repo 与 run 入队

| 路径 | 符号/区域 | 当前职责 | 本期改动责任 |
|---|---|---|---|
| `apps/api/src/modules/workspaces/workspace.store.ts` | `WorkspaceRepoRecord` | 包含 `workspaceId`、`repoId`、`dirName`、`path`。 | 不改 schema；只使用 `dirName`。 |
| 同上 | `getWorkspace` / `listWorkspaceRepos` | 查询 workspace；后者按 `rowid asc` 返回 repo。 | `agent-run-context.ts` 的唯一数据来源。 |
| `apps/api/src/modules/agent/agent-run-context.ts` | `getAgentWorkspaceRunContext` / `AgentWorkspaceRunContext` | 模块内共享 helper。 | 使用 `AppContext + workspaceId` 返回 `workspacePath + 必有 dirName[]` 或 `null`；未扩展 `AgentService`。 |
| `apps/api/src/modules/agent/agent.runtime-port.ts` | `AgentRuntimePort.enqueueRun` | API 对运行时实现的抽象。 | 参数改为含必有 `workspaceRepoDirNames: string[]` 的运行时类型。 |
| `apps/api/src/modules/agent/agent.runtime.ts` | `RuntimeQueuedRun` / `enqueueRun` | 内存回退运行时队列。 | 字段必有，不得丢失。 |
| `apps/api/src/modules/agent/agent.worker-client.ts` | `WorkerQueuedRun` / `enqueueRun` | 将 run JSON POST 到 Worker。 | 字段必有并序列化。 |
| `apps/api/src/modules/agent/agent.routes.ts` | `handleCompactRequest` | compact run 入队。 | 调用唯一 helper。 |
| 同上 | 用户发送消息路由 | 普通消息 run 入队。 | 调用唯一 helper。 |
| 同上 | 内部 Agent 消息入口 | 内部消息 run 入队。 | 调用唯一 helper。 |
| `apps/api/src/modules/agent/agent.module.ts` | `enqueueRecoveringRuns` | 启动时重新调度未完成 run。 | 调用唯一 helper，以当前 workspace 映射构造字段。 |

## 共享合同与不改动区域

| 路径 | 符号 | 结论 |
|---|---|---|
| `packages/shared/src/contracts/agent.ts` | `AgentToolOutputSchema` | 本期不改。既有 `text?: string`、`error?: string` 足以承载错误诊断。 |
| `apps/api/src/modules/agent/agent.store.ts` | tool output 错误文本持久化/错误码推断 | 本期不改。扩展后的错误字符串沿用既有存储路径。 |
| `apps/api/src/modules/files/*` | UI/API 文件读取服务 | 不在 Agent `read` 调用链中，不可作为实现落点。 |

## 推荐测试落点

| 路径 | 覆盖范围 |
|---|---|
| `apps/agent-worker/src/runtime/fileTools.test.ts` | 已覆盖单/多/零候选、`ENOTDIR`、目录候选、真实 `runReadTool` 执行路径中仅 `ENOENT` / `ENOTDIR` 触发的错误码门控、repo 根/最终候选及中间 symlink、UTF-8 排序、显示上限、部分/全部 probe 异常、TOCTOU 和取消停止派发。 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.read.test.ts` | 已覆盖 read 透传必有数组，以及 `new`、`existing`、`fork` 三种 subtask mode 经 `processNestedRun` 复制 parent 数组。 |
| `apps/agent-worker/src/runtime/runner.tool-output.test.ts` | 已通过真实 `runReadTool` 调用覆盖非取消失败仍为 `failed`；`output.error` 保存错误字符串，`output.text` 以 `tool: read` / `status: failed` 头部和错误正文呈现候选提示，且没有 `result`。 |
| `apps/agent-worker/src/runtime/runner.cancel.test.ts` | probe/工具执行期间 abort 后不写伪 `failed` tool output，run 沿既有流程为 `cancelled`。 |
| `apps/api/src/modules/agent/agent-run-context.test.ts` | 已覆盖 helper 对 workspace、登记 `dirName`、非法名称、稳定去重与空数组的合同。 |
| `apps/api/src/modules/agent/agent.worker-client.test.ts` | 已覆盖新 API enqueue JSON 始终发送 `workspaceRepoDirNames`，且只发送 repo `dirName`。 |
| `apps/agent-worker/src/server.test.ts` | 已覆盖旧 payload 缺字段降级、HTTP enqueue 后的归一化结果、非法名称过滤、稳定去重与 100 条上限。 |

## 基线核对步骤

实施者在编码前和 reviewer 在审查前必须执行只读检索：

```bash
rg -n -S \
  "runReadTool|ensureSafeRelativePath|resolveWithinWorkspace|workspaceRepoDirNames|EnqueuePayload|QueuedRun|QueuedRunContext|NestedRunContext|ToolExecutionContext|enqueueRun\\(|listWorkspaceRepos|startSubtaskRun|processNestedRun" \
  apps packages
```

然后核对：

- `read` 从 Provider 到 `runReadTool` 的唯一实际调用路径；
- `workspaceRepoDirNames` 的 optional 边界只在 `EnqueuePayload` / server JSON；
- 所有 API `runtime.enqueueRun` 调用点，而不是只核对公开 send-message；
- `QueuedRunContext`、`NestedRunContext` 与 `ToolExecutionContext` 是否完整传播；
- nested subtask 是否绕过 Worker HTTP enqueue，并是否只从 parent 继承数组；
- `startSubtaskRun` 的响应字段未被不必要扩展；
- `listWorkspaceRepos` 的排序和返回字段；
- Runner 对工具异常、`signal.aborted`、`output.error`、`output.text` 和 run `cancelled` 的真实写入位置；
- shared schema 是否仍含有字符串错误字段。

若基线演进导致符号移动，必须按职责迁移本设计，不得通过遗漏恢复路径、内存 runtime、Tool 类型或 nested subtask 来“适配”新代码。
