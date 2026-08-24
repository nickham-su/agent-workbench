# 开发实施、代码审查、发布与回滚

返回 [README](./README.md)。本文件将设计转化为可执行任务和合并门槛。任务按依赖顺序排列，建议以小提交实施；本设计本身不要求或授权任何 Git 操作。

## 实施任务拆分

| 阶段 | 改动文件/符号 | 产出 | 完成判定 |
|---|---|---|---|
| API 上下文 | 新增 `agent-run-context.ts`、API runtime 类型 | 唯一 helper 和 API 内部必有数组合同 | helper 单测、类型检查通过。 |
| 全入口接入 | `agent.routes.ts` 三处 + `agent.module.ts` 恢复 | 四个 API enqueue 入口统一传必有字段 | 搜索全部 `runtime.enqueueRun(` 后无遗漏。 |
| Worker 入队边界 | `server.ts`、`EnqueuePayload`、`QueuedRun` | JSON 可选字段归一化为内部必有数组 | 旧 payload 可入队；恶意元素被过滤。 |
| Tool 类型传播 | `tools/types.ts`、Runner、Builtin Provider | `QueuedRunContext`、`NestedRunContext`、ToolContext、read、subtask 都有数组 | 类型检查能发现任一构造遗漏。 |
| 文件探测 | `fileTools.ts` / `runReadTool` | 宽口径 symlink、安全、限并发、可取消 probe 与固定错误提示 | fileTools 测试矩阵通过。 |
| Runner 失败/取消回归 | `runner.tool-output.test.ts`、`runner.cancel.test.ts` | 非取消失败仍写 failed；取消不写伪 failed | 输出与 cancelled 状态机测试通过。 |
| 全量验证 | typecheck、相关单测/集成测试、手工情景 | 可发布变更 | 满足 [验收标准](./06-testing-acceptance.md)。 |

## 逐步实施步骤

### API 唯一 helper 与内部必填合同

- 新增 `apps/api/src/modules/agent/agent-run-context.ts`，只供 Agent 模块内部 imports 使用；不得扩展 `AgentService` 公共 API。
- 实现 `getAgentWorkspaceRunContext(ctx, workspaceId): AgentWorkspaceRunContext | null`：用 workspace store 的 `getWorkspace` 和 `listWorkspaceRepos`，返回 `{ workspacePath, workspaceRepoDirNames }`。
- helper 只取/过滤/去重 `WorkspaceRepoRecord.dirName`；不读取、返回或序列化 `path`；无 workspace 返回 `null`。
- 定义 API 运行时类型，使 `AgentRuntimePort.enqueueRun`、`RuntimeQueuedRun`、`WorkerQueuedRun` 全部要求 `workspaceRepoDirNames: string[]`，不能是 optional。
- 验证：故意在测试/临时类型 fixture 中遗漏字段应触发 TypeScript 错误；helper 测试覆盖空 repo 与异常名称。

### 四个入口和恢复

- 修改 `agent.routes.ts` 的 `handleCompactRequest`、用户消息路由、内部 Agent 消息入口：均调用唯一 helper，不保留各自 `getWorkspace` + 自行拼数组逻辑。
- 修改 `agent.module.ts` 的 `enqueueRecoveringRuns`：每次恢复重新调用 helper，绝不使用 Run 历史快照。
- 将 helper 返回对象中的 `workspacePath` 与必有数组完整传给 `runtime.enqueueRun`。
- 验证：搜索所有 `runtime.enqueueRun(`；四处都由 TypeScript 必有字段约束覆盖；workspace 无 repo 时仍显式传 `[]`。

### Worker JSON 边界和类型传播

- 扩展 `EnqueuePayload`：只有此 IPC 类型使用 `workspaceRepoDirNames?: string[]`。
- 在 Worker 私有、无文件系统依赖的 `workspaceRepoDirNames.ts` 实现安全名称校验和归一化；`server.ts` 与 `fileTools.ts` 复用它。`server.ts` 对旧 payload 缺失/非数组归一化为 `[]`；API 因部署边界保留独立校验并同步规则。
- 更新 `QueuedRun` 为必有数组。
- 更新 `apps/agent-worker/src/runtime/tools/types.ts` 中的 `QueuedRunContext`、`NestedRunContext`；`ToolExecutionContext` 通过 `run: QueuedRunContext` 与 `processNestedRun(NestedRunContext, ...)` 自然传播，不新增可选旁路。
- 在 `runner.ts` 的 ToolExecutionContext 构造和 `processNestedRunWithController` 调用链中，让类型自然匹配；不得 `as` 强转或 `?? []` 掩盖遗漏。
- 验证：新 Worker 收旧 body 为 202 和内部 `[]`；任何内部 run/context 构造漏字段都会类型失败。

### read 与 nested subtask 传播

- `BuiltinToolProvider` 的 read 分支将必有 `ctx.run.workspaceRepoDirNames` 原样传给 `runReadTool`。
- `BuiltinToolProvider` 的 `ctx.processNestedRun(...)` 参数增加 `workspaceRepoDirNames: [...ctx.run.workspaceRepoDirNames]`。
- 不改 `apiClient.ts` 的 `startSubtaskRun` 响应；repo 名称不从 response 获取，只继承 parent run。
- 验证：read Provider 不添加默认值、不扫描；nested 子数组内容相同、引用不同，三种 subtask mode 均覆盖。

### 文件探测与取消

- 将 `runReadTool` 参数定义为必有 `workspaceRepoDirNames: readonly string[]`；所有直接测试显式传数组。
- 保持既有根路径校验和根 `lstat` 顺序，只为 root `lstat` 添加最小 `try/catch`；仅 `ENOENT`/`ENOTDIR` 调 probe。
- probe 对 repo 根先 `lstat` + realpath containment，拒绝 repo 根本身是 symlink；对最终候选同样 `lstat` + containment，拒绝最终候选本身是 symlink。
- 不逐段 `lstat` 中间路径组件。中间 symlink 只要最终 candidate realpath 仍在 workspace 内即允许提示；重试完整 read 时按现有检查决定是否可读。
- 使用最大并发 8 工作池，最大输入 100，输出前 UTF-8 字节序排序并最多显示 10；不递归、不 `readdir`、不读候选内容。
- abort 时停止派发新 probe，忽略已完成/后续候选，不追加提示，抛回 root 原始错误；probe 内部错误不得覆盖 root 错误。
- 验证：根路径成功、非缺失错误、候选命中、repo 根 symlink、最终 symlink、中间 workspace 内/外 symlink、probe 异常与取消均独立通过。

### Runner 回归、测试和手工验证

- 验证 signal 未取消时，含提示错误仍由既有 `executeTool` 写入 failed `output.error`、`output.text`，且无 result。
- 验证 signal 已 abort 或产生 abort-like error 时，`executeTool` / `executeToolSafely` 不写伪 failed tool item；`processRun` 按既有 `finishOnce("cancelled")` 结束 run。
- 先完成 fileTools、API helper、Provider/nested、Runner 失败和 Runner 取消测试，再运行类型检查与 Worker 集成测试。
- 使用两个真实 repo workspace 完成 [手工验收](./06-testing-acceptance.md#手工验收情景)。

## 代码审查清单

### 行为、错误与取消合同

- 根路径仍是唯一第一次读取目标；候选命中没有自动读取、自动重试、成功返回或自动选择。
- 仅 root `lstat` 的 `ENOENT`、`ENOTDIR` 触发 probe；未通过错误文本匹配触发。
- 原始错误消息是扩展错误消息的完整前缀；候选文案、`/`、UTF-8 排序、10 条上限和余量文本符合合同。
- 零候选、非触发错误与非法路径保持既有行为。
- signal abort 后停止派发新 probe、不追加提示、probe 错误不覆盖 root 错误。
- 非取消失败仍是 `failed`；取消不写伪 failed，由既有 `cancelled` 流程收尾；无伪成功 result。

### 类型、数据流与兼容

- `workspaceRepoDirNames` **只**在 server 入站 JSON / `EnqueuePayload` 可选。
- `AgentRuntimePort.enqueueRun`、`RuntimeQueuedRun`、`WorkerQueuedRun`、`QueuedRun`、`QueuedRunContext`、`NestedRunContext`、`runReadTool` 参数均为必有数组；没有 `?? []`、类型断言或 optional 旁路掩盖遗漏。
- `ToolExecutionContext` 通过必有 `run` 和 `processNestedRun` 完整传播。
- compact、普通消息、内部消息、启动恢复四处均只用 `agent-run-context.ts` helper。
- helper 只从 `getWorkspace` / `listWorkspaceRepos` 返回 `workspacePath + dirName[]`；不扩展 `AgentService`，不传 repo 绝对路径。
- nested subtask 复制 parent 数组；`startSubtaskRun` response 未新增 repo 字段。
- 新 Worker 对旧 JSON 缺字段归一化 `[]`；新 API 必传字段。
- 不修改 Run/Session/context item 数据库 schema，也不修改 shared tool output schema。

### 安全、symlink与性能

- 没有递归搜索、`readdir`、`.git` 扫描或全 workspace 遍历。
- 恶意 repo 名称在 API helper 和 Worker server 两层均不能造成路径逃逸。
- repo 根与最终候选本身为 symlink 时不提示；中间 symlink 不逐段拒绝，必须由最终 realpath containment 决定是否可提示。
- probe 使用 `lstat`；repo 根和最终候选均执行 containment；完整 read 重试仍执行既有检查。
- 不写文件、不加敏感绝对路径日志、不在新增提示中暴露绝对路径。
- 并发不超过 8，输入名称不超过 100，输出候选不超过 10。

### 可维护性与测试

- API helper、server 归一化、probe、错误格式化职责单一；复杂文件系统逻辑不在 route/Provider。
- Worker repo 名称规则、稳定去重和输入上限只有一个无 FS 的私有 helper；不得在 server 与 probe 中重复实现。
- 常量（100、8、10、固定标题）有命名和边界测试。
- 测试包含内部必填类型防遗漏、四入口、nested 继承、宽口径 symlink、fileTools 取消、Runner 取消、旧 payload 兼容与正常失败回归。

## 发布策略

该变更无数据库迁移、无 shared schema 变更、无外部 HTTP API 改动。可先发布新 Worker：面对旧 API 缺字段自动降级；再发布新 API 开始传递字段。反向顺序时旧 Worker 忽略未知 JSON 字段，功能仅失去提示，不影响 run。

不增加 feature flag：该逻辑只在既有失败后提供诊断，已经具备自然兼容降级；flag 会增加四入口、恢复和版本组合复杂度。

## 回滚方案

- 回滚 Worker 探测或字段消费后，新 API 发送的未知 JSON 字段会被旧 Worker 忽略，`read` 恢复原失败行为。
- 停止 API 发送字段后，新 Worker 收到 `[]` 并自动降级。
- 无数据库/文件修改或不可逆迁移，无数据回滚步骤。
- 如发现安全误报或取消竞争，优先回滚 Worker probe；不得通过放宽既有路径校验作为临时修复。
