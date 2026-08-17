# 技术设计

返回 [README](./README.md)。本文件规定运行时数据流、唯一类型边界、探测算法、安全限制与取消合同。

## 当前调用链与目标数据流

```text
API 路由 / 启动恢复
  -> getAgentWorkspaceRunContext(ctx, workspaceId)
  -> AgentRuntimePort.enqueueRun(必有 workspaceRepoDirNames)
  -> AgentWorkerClient JSON 或内存 AgentRuntime
  -> POST /internal/runs/enqueue
  -> Worker server 校验与归一化
  -> EnqueuePayload（外部 JSON 可选）/ QueuedRun（内部必有）
  -> ToolExecutionContext.run: QueuedRunContext（必有）
  -> BuiltinToolProvider.execute("read")
  -> runReadTool(必有 workspaceRepoDirNames)
  -> 根路径 lstat 失败后的 repo 定点 lstat
  -> throw 原错误或“原错误 + 候选提示”
  -> Runner 既有错误/取消分支
  -> context item: failed output.error / output.text，或 cancelled（不写伪失败）
```

`workspaceRepoDirNames` 是本次执行的运行时上下文：API 依据当前 `workspace_repos` 查询并计算；Worker 仅消费目录名；它不得进入 Run、Session 或 context item 的持久化记录。

## 唯一的 optional / required 边界

以下边界是本方案的强制类型设计，不得用 `?`、默认值或 `as string[]` 在其他层绕开。

| 层级 | 类型/位置 | `workspaceRepoDirNames` | 原因 |
|---|---|---|---|
| Worker HTTP 入站 JSON | `POST /internal/runs/enqueue` body | **可缺失** | 新 Worker 必须兼容旧 API 未发送字段的 payload。 |
| Worker IPC 声明 | `EnqueuePayload`（`runner.ts`） | `workspaceRepoDirNames?: string[]` | 这是上表 JSON 的 TypeScript 表达。 |
| API 运行时抽象 | `AgentRuntimePort.enqueueRun` 参数 | **必有** `string[]` | 编译器必须强制四个 API enqueue 入口构造字段。 |
| API 内存队列 | `RuntimeQueuedRun` | **必有** `string[]` | 回退 runtime 不得丢失上下文。 |
| API Worker client | `WorkerQueuedRun` | **必有** `string[]` | JSON 发送方必须总是发送数组（可为空）。 |
| Worker 入队后 | `QueuedRun`（`runner.ts`） | **必有** `string[]` | server 已归一化；后续代码不处理 `undefined`。 |
| Tool 类型 | `QueuedRunContext`（`tools/types.ts`） | **必有** `string[]` | `ToolExecutionContext.run` 必须携带字段到所有 Provider。 |
| Nested run 类型 | `NestedRunContext`（`tools/types.ts`） | **必有** `string[]` | Worker 内部 subtask 不经 HTTP 也不得丢失字段。 |
| 工具执行上下文 | `ToolExecutionContext`（`tools/types.ts`） | 通过必有 `run: QueuedRunContext` 间接必有 | 避免为同一上下文增加第二个可漂移字段。 |
| 文件工具 | `runReadTool` 参数 | **必有** `readonly string[]` | 只有 server 入站 JSON / `EnqueuePayload` 可选；文件工具不得成为第二个可选边界。 |

因此，API 的运行时入队模型应定义为一个必有字段的交集类型，例如：

```ts
export type AgentRuntimeRun = AgentQueuedRun & {
  inputText?: string;
  workspacePath: string;
  workspaceRepoDirNames: string[];
};
```

`AgentRuntimePort.enqueueRun(run: AgentRuntimeRun)`、`RuntimeQueuedRun` 与 `WorkerQueuedRun` 均使用该必有合同。`AgentQueuedRun` 若仍是持久化/最小身份类型，可不承担该字段；不得把 optional 字段重新放入其运行时扩展类型。

## API 侧：唯一的运行时上下文 helper

### 固定落点

必须新增模块内文件：

```text
apps/api/src/modules/agent/agent-run-context.ts
```

该文件是唯一允许构造 repo 路径探测运行时上下文的 API helper 落点。它可以在 Agent 模块内部导出给 `agent.routes.ts` 和 `agent.module.ts` 使用，但不得经公共模块 barrel 暴露，也不得扩展 `AgentService` 公共 API。

### 接口与输入输出

固定使用如下语义（命名可以按项目约定微调，但输入、输出与空值合同不得改变）：

```ts
export type AgentWorkspaceRunContext = {
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

export function getAgentWorkspaceRunContext(
  ctx: AppContext,
  workspaceId: string
): AgentWorkspaceRunContext | null;
```

实现必须：

- 用 workspace store 的 `getWorkspace(ctx.db, workspaceId)` 查询 workspace；未找到时返回 `null`，由 routes/module 保持各自既有的 404/跳过恢复语义；
- 用 `listWorkspaceRepos(ctx.db, workspaceId)` 作为唯一 repo 来源；
- 只读取 `WorkspaceRepoRecord.dirName`，绝不读取或返回 `WorkspaceRepoRecord.path`；
- 按 `listWorkspaceRepos()` 的 `rowid asc` 返回顺序处理，过滤非法名称，稳定去重，返回数组（可为空）；
- 不访问文件系统、不创建目录、不落库、不抛出“repo 不存在”错误；repo 目录的实际状态由 Worker 只读探测处理。

安全目录段规则：名称非空、去除首尾空白后不变、不含 `/`、`\\`、NUL、CR、LF，不等于 `.` 或 `..`，且不是绝对路径。正常数据库数据必须满足；损坏/异常记录只被排除，不得使既有 run 无法入队。

### 四个 API enqueue 入口

以下四处必须调用同一个 `getAgentWorkspaceRunContext`，并把其返回的两个字段完整展开或显式传入 `enqueueRun`：

| 入口 | 当前责任 | 实施要求 |
|---|---|---|
| `agent.routes.ts` 的 `handleCompactRequest` | compact run 入队 | 取得 context；`null` 时沿用 workspace 404；入队对象含必有数组。 |
| `agent.routes.ts` 的用户发送消息路由 | 普通用户消息 run 入队 | 与 compact 使用同一 helper，不能保留旧的单独 `getWorkspace` 分支。 |
| `agent.routes.ts` 的内部 Agent 消息入口 | 内部触发消息 run 入队 | 与公开入口一致，不能遗漏。 |
| `agent.module.ts` 的 `enqueueRecoveringRuns` | 启动恢复 run | 以当前 `workspaceId` 重新调用 helper；`null` 时沿用既有跳过/失败处理，不读取历史 Run 快照。 |

API 内部字段是必有的，因此这四处若遗漏 `workspaceRepoDirNames`，TypeScript 必须报错。这是“内部必填类型防遗漏”的主要保证。

## Worker server：唯一兼容归一化边界

`POST /internal/runs/enqueue` body 是不可信 JSON。仅在这里允许缺失字段。

`EnqueuePayload` 新增：

```ts
workspaceRepoDirNames?: string[];
```

`server.ts` 必须提供局部纯函数或等价逻辑：

```ts
normalizeWorkspaceRepoDirNames(value: unknown): string[]
```

规则：

- `undefined`、`null` 或非数组返回 `[]`；不得返回 400，以兼容旧 API；
- 仅保留满足安全目录段规则的 string 元素；
- 稳定去重，保留第一次出现；
- 最多保留 **100** 个名称，超出部分忽略；
- 数组嵌套、对象、数字、空字符串、含分隔符或控制字符的值均忽略；
- 不访问文件系统；
- 归一化结果以必有 `workspaceRepoDirNames: string[]` 传给 `runner.enqueueRun()`。

`QueuedRun`、`QueuedRunContext` 和 `NestedRunContext` 均不得再出现 optional 字段或 `?? []` 的补救代码。

## Tool 类型传播与 nested subtask

`apps/agent-worker/src/runtime/tools/types.ts` 必须同步修改：

```ts
type QueuedRunContext = {
  // 既有字段
  workspaceRepoDirNames: string[];
};

type NestedRunContext = {
  // 既有字段
  workspaceRepoDirNames: string[];
};

type ToolExecutionContext = {
  run: QueuedRunContext;
  processNestedRun: (run: NestedRunContext, signal: AbortSignal) => Promise<void>;
  // 其余字段不变
};
```

`runner.ts` 在创建 `ToolExecutionContext` 时以 `QueuedRun` 填充 `run`，类型必须自然兼容；不得在 Provider 层自行引入默认空数组。

Worker 内建 `subtask` 在 `BuiltinToolProvider` 内调用 `ctx.apiClient.startSubtaskRun(...)` 后，通过 `ctx.processNestedRun(...)` 构造 nested run。必须新增：

```ts
workspaceRepoDirNames: [...ctx.run.workspaceRepoDirNames]
```

数组必须复制而不是复用引用。该规则对 `new`、`existing`、`fork` 三种 mode 一致。

`apps/agent-worker/src/runtime/apiClient.ts` 的 `startSubtaskRun` 当前响应只包含 `sessionId`、`runId`、`workspacePath`、`agentName`、`reused`。本期**不得**为该响应新增 repo 字段；nested run 的名称只从 parent run 继承，避免扩展 API 响应与重新查询的分叉。

## Provider 透传

`BuiltinToolProvider.execute` 的 `case "read"` 只透传：

```ts
return await runReadTool({
  workspacePath: ctx.run.workspacePath,
  workspaceRepoDirNames: ctx.run.workspaceRepoDirNames,
  filePath,
  offset,
  limit,
  signal: ctx.signal
});
```

Provider 不得扫描 repo、不捕获改写文件错误、不选择候选，也不得对数组使用 `?? []`。

## `runReadTool` 接口与算法

### 接口

```ts
export async function runReadTool(params: {
  workspacePath: string;
  workspaceRepoDirNames: readonly string[];
  filePath: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
})
```

这是必有数组：直接单元测试也必须显式传 `[]` 或测试数据，不能以可选参数隐藏调用遗漏。

### 根路径与探测伪代码

```ts
const safePath = ensureSafeRelativePath(params.filePath);
const fullPath = resolveWithinWorkspace(params.workspacePath, safePath);

let stat;
try {
  stat = await fs.lstat(fullPath);
} catch (rootError) {
  if (!isMissingPathError(rootError)) throw rootError;

  const matches = await probeRegisteredRepoCandidates({
    workspacePath: params.workspacePath,
    repoDirNames: params.workspaceRepoDirNames,
    safePath,
    signal: params.signal
  });

  if (params.signal?.aborted || matches.length === 0) throw rootError;
  throw appendRepoPathHint(rootError, matches);
}

// 后续既有 symlink / realpath / directory / text-read 分支保持不变。
```

`isMissingPathError` 只在 `error.code` 精确为 `ENOENT` 或 `ENOTDIR` 时返回 true；不得解析 `message`。

### 候选与 symlink 最终规则

对每个合法 repo 名称构造：

```text
repoRoot = resolveWithinWorkspace(workspacePath, repoDirName)
candidate = resolveWithinWorkspace(workspacePath, join(repoDirName, safePath))
display = repoDirName + "/" + safePath  // 以 / 格式化
```

候选有效必须同时满足：

- `lstat(repoRoot)` 成功且 repo 根**本身**不是 symlink；
- `ensureRealPathInsideWorkspace(workspacePath, repoRoot)` 成功；
- `lstat(candidate)` 成功且最终候选**本身**不是 symlink；
- `ensureRealPathInsideWorkspace(workspacePath, candidate)` 成功；
- 候选可为常规文件或目录；探测不读取内容，也不要求为文本。

**中间路径组件规则（最终定稿）**：不逐段 `lstat`，也不因为候选路径的中间目录是 symlink 而直接排除。若 `candidate` 经现有 `ensureRealPathInsideWorkspace` 的 realpath containment 校验后仍在 workspace 内，则允许提示。这与现有 `read` 的安全语义一致：最终路径本身为 symlink 会被拒绝；中间组件是否为 symlink 由 realpath containment 处理。

模型按提示重试完整 `read` 时，仍必须经过当时的既有 `lstat`、最终 symlink 拒绝、realpath containment、目录/文本和权限检查；候选提示不保证可读，也不放宽任何安全检查。

### 探测、错误与取消

候选探测使用 `lstat`，不使用 `stat`；输入名称再次按安全目录段规则过滤、去重。每个候选的 `ENOENT`、`ENOTDIR`、`EACCES`、`EPERM`、`EIO`、realpath 失败或其他内部异常均只视为不命中并继续。**任何 probe 错误都不得覆盖 root `lstat` 的原始错误。**

使用最大并发 **8** 的工作池；Worker server 最多输入 100 个 repo 名称，因此最多进行 100 个候选探测，且不递归、不调用 `readdir`、不读内容。工作池收到 `signal.aborted` 后必须停止派发新的 probe；已开始的 `lstat` 自然完成。取消期间不追加候选提示，`runReadTool` 抛回 root 原始错误。

Runner 当前事实合同如下：`executeTool` / `executeToolSafely` 在 signal 已 aborted 或错误为 abort-like 时不写 `status: "failed"` tool item；`processRun` 观察到外层 signal 后以既有 `finishOnce("cancelled")` 结束 run。因此 probe 在取消期间不得生成或覆盖伪失败结果。文件工具不负责写 cancelled 状态，只负责不将 probe 结果转成提示；Runner 继续是取消状态的唯一写入方。

### 错误提示

仅在 signal 未取消且候选非空时，调用 `appendRepoPathHint`：

- 原始 `rootError.message` 必须为扩展错误消息完整前缀；
- 按 [产品错误文案合同](./02-product-contract.md#error文案合同) 追加固定文本；
- 显示路径以 `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))` 排序后截断；
- 返回新的 `Error`，不伪造 Node error 的 `code` 或 `path` 属性。

## 为什么不改 shared schema、也不落库

`AgentToolOutputSchema` 已有字符串 `error` 和 `text`，Runner 的失败路径也只消费异常字符串。本期候选是错误诊断，不是成功 result 或持久化业务实体。扩展 shared schema 或写库会扩大跨端兼容、迁移和前端改动面，且不提高模型重试能力。

完整取舍见 [03-decisions.md](./03-decisions.md)。
