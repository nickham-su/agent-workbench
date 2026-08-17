# 关键决策与取舍

返回 [README](./README.md)。本文件的决策均已定稿；开发不得以“实现方便”为由替换为未列出的行为。

## 决策总表

| 主题 | 定稿决策 | 主要理由 |
|---|---|---|
| repo 发现 | 使用 `workspace_repos` 的已登记 repo | 权威、稳定、无需扫描，避免把临时目录当 repo。 |
| 探测方式 | 每 repo 一个候选路径的受限 `lstat` | O(repo 数量)，不递归、不读取内容，成本可控。 |
| 命中后的行为 | 保持失败，仅提示显式重试路径 | 多 repo 同名文件存在歧义；不改变 `read` 语义。 |
| 传递的数据 | 仅传 `dirName[]`，Worker 基于 `workspacePath` 拼接 | 避免把 DB 绝对路径变成 Worker 探测能力。 |
| API helper | 新增模块内 `agent-run-context.ts`，不扩展 `AgentService` | 让 routes/module 复用唯一构造点，同时不扩大 service 公共 API。 |
| optional 边界 | 仅 Worker server JSON / `EnqueuePayload` 可选，其他运行时类型必有 | 兼容旧 API，同时让 TypeScript 强制四入口和上下文传播不遗漏。 |
| symlink | repo 根和最终候选不得是 symlink；中间组件经 realpath 留在 workspace 则可提示 | 与既有 read 安全语义一致，避免逐段 lstat 过度收紧。 |
| 错误承载 | 追加到既有 `Error.message` | 复用 Runner / API / UI 已有字符串失败合同，改动最小。 |
| 触发错误 | 仅 `ENOENT` 与 `ENOTDIR` | 两者说明路径链无法到达；权限和 I/O 错误不应被掩盖。 |
| 候选排序 | 最终显示路径 UTF-8 字节序升序 | 不受 DB 顺序、locale 和并发完成次序影响，便于测试。 |
| 展示上限 | 最多 10 个，额外数显式说明 | 控制模型上下文与错误输出长度。 |
| 取消 | abort 停止派发新 probe，不生成提示；Runner 沿既有 cancelled 流程收尾 | 不把取消竞争写成伪 failed。 |
| 持久化 | 不存入 Run/Session/context item | repo 挂载是 workspace 当前状态；恢复时应重新查询。 |

## 登记 repo，而非扫描 workspace

### 选择

候选 repo 集合必须来自 API 侧 `listWorkspaceRepos(db, workspaceId)` 返回的 `WorkspaceRepoRecord.dirName`。

### 不选择的方案

- 遍历 workspace 一级目录；
- 递归查找 `.git`；
- 以 `readdir` 结果推断 repo；
- 让 Worker 自行扫描磁盘发现 repo。

### 取舍理由

workspace 根目录除 repo 外可能包含系统目录、用户临时目录、缓存、隐藏文件或非 Git 内容。扫描会误报、让延迟随目录规模失控，并赋予 Worker 超出业务模型的目录发现能力。`workspace_repos` 是 workspace 挂载关系的权威数据，使用它将探测范围限制为用户实际挂载的 repo。

## 提示路径，而非自动读取

候选命中后，本次 `read` 必须仍然失败；模型以 `<repoDirName>/<原路径>` 显式重试。

不选择自动读取唯一命中、读取多命中的第一个、隐式 fallback 或成功返回实际文件。原因是调用方请求的是明确路径而非搜索查询；即使唯一命中也可能在 probe 与读取间被删除、替换、拒绝访问或因读取规则失败。显式重试保持确定性与可审计性。

## `dirName`，而非数据库绝对路径

API 的内部运行时对象使用必有字段：

```ts
workspaceRepoDirNames: string[]
```

跨 API/Worker 的 `EnqueuePayload` 仅为兼容旧 API 声明：

```ts
workspaceRepoDirNames?: string[]
```

Worker server 归一化后再次使用必有数组。绝不传递 `workspaceRepoPaths` 或 `WorkspaceRepoRecord.path`。只传目录名可以最小化跨进程文件系统能力、强制 workspace containment、保证错误提示可复制且不新增绝对路径泄露。

API helper 和 Worker server 都过滤非安全单目录段：不传递空、`.`、`..`、绝对、带分隔符或控制字符的名称。异常 DB 记录只被忽略，不阻断既有 run。

## 唯一 API helper，而非扩展 `AgentService`

选择新增：

```text
apps/api/src/modules/agent/agent-run-context.ts
```

其中模块内 helper `getAgentWorkspaceRunContext(ctx, workspaceId)` 使用 `getWorkspace` 与 `listWorkspaceRepos` 返回 `workspacePath + string[]` 或 `null`。`agent.routes.ts` 与 `agent.module.ts` 直接使用它。

不选择向 `AgentService` 新增 `getWorkspaceRuntimeContext` 等公共方法，也不允许四个入口各自查询。前者扩大 service 对外职责与测试面，后者必然造成 compact、内部消息或恢复路径遗漏。独立模块是最小且职责单一的落点。

## 宽口径 symlink 规则

### 选择

- repo 根本身是 symlink：不作为候选；
- 最终候选本身是 symlink：不作为候选；
- 中间路径组件是 symlink：不逐段拒绝；若最终候选经过既有 `ensureRealPathInsideWorkspace` 后仍位于 workspace，可提示。

### 取舍理由

最终候选 symlink 已与当前 `read` 的显式拒绝语义一致；repo 根的 symlink 会使已登记目录名不再是 workspace 内的真实挂载根，因此拒绝。中间组件则是现有 realpath containment 的适用范围：只要最终 realpath 留在 workspace，提示与之后完整 read 的安全语义一致。逐段 `lstat` 会引入比既有 read 更严格、且难以解释的限制。

候选只代表探测瞬间可见。重试完整 `read` 时仍执行当时全部既有校验，提示不保证可读。

## 字符串错误，而非结构化 diagnostics schema

候选提示追加到 `Error.message`。当未取消且工具正常失败时，Runner 通过既有逻辑写入：

```ts
output.error: string
output.text: string
status: "failed"
```

不扩展 `packages/shared/src/contracts/agent.ts` 的 `AgentToolOutputSchema`。当前 Runner、API Store 和前端已消费字符串错误；结构化字段会扩大 shared schema、API、前端、投影与兼容性改动。本期候选只是让模型修正下次路径，不是成功 result。未来多工具均需要机器可读诊断时再单独版本化设计。

## `ENOENT` 与 `ENOTDIR`

仅对根路径初始 `lstat` 的 `error.code` 为下列值时探测：

```ts
ENOENT
ENOTDIR
```

`ENOTDIR` 同样说明路径链无法到达，而 repo 子目录下仍可能有效。`EACCES`、`EPERM` 表示访问受限，`EIO` 等是系统故障；探测会掩盖问题或误导绕过。不得匹配错误字符串。

## 排序、上限与取消

- API 输入保留 `listWorkspaceRepos()` 的业务顺序；Worker server 稳定去重；
- `runReadTool` 对最终显示路径以 `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))` 排序；
- 最多显示 10 条，余量明确告知；
- server 最多归一化 100 个 repo 名称，probe 工作池最大并发 8；
- signal abort 后停止派发新 probe、放弃候选提示，并抛回 root 原始错误；probe 内部错误永不覆盖 root 错误；
- Runner 的 `executeTool` / `executeToolSafely` 在 abort-like error 或 signal aborted 时不写 failed item，由 `processRun` 既有 `finishOnce("cancelled")` 结束 run。

## API / Worker 版本兼容

新 API 的 `AgentRuntimePort.enqueueRun`、`RuntimeQueuedRun` 和 `WorkerQueuedRun` 都必须要求 `workspaceRepoDirNames: string[]`，因此新代码不能遗漏字段。新 Worker 对旧 API JSON body 中缺失字段归一化为 `[]`；旧 Worker 忽略新 JSON 字段。部署版本不一致时只失去诊断提示，不影响 run 或读取的既有失败语义。

## 不落库

repo 名称只作为当前执行辅助上下文，不写入 Run、Session 或 context item：repo attach/detach 是 workspace 当前状态；恢复 run 应依据当前映射重新查询；保存历史目录快照既不提高诊断正确性，也会扩大迁移与一致性成本。
