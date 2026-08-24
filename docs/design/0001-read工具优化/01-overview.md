# 背景、目标与边界

返回 [README](./README.md)。

## 需求背景

Agent Workbench 的一个 workspace 可以包含多个 repo。现有内建 `read` 工具以 workspace 根目录为唯一相对路径根：

```text
<workspacePath>/<filePath>
```

但模型通常依据单仓库项目结构产生调用，例如：

```json
{ "filePath": "apps/api/src/modules/files/files.service.ts" }
```

如果真实文件位于：

```text
<workspacePath>/agent-workbench/apps/api/src/modules/files/files.service.ts
```

当前调用会读取：

```text
<workspacePath>/apps/api/src/modules/files/files.service.ts
```

并因 `ENOENT` 失败。失败信息没有告诉模型：同一相对路径在已挂载 repo 下实际可用。模型往往继续猜测路径、重复失败，或错误判断代码不存在。

## 问题案例

假设 workspace 中登记了如下 repo：

```text
agent-workbench/
service-template/
```

模型调用：

```json
{ "filePath": "src/main.ts" }
```

现有结果：

```text
ENOENT: no such file or directory, lstat '<workspace>/src/main.ts'
```

目标结果仍然失败，但应为：

```text
ENOENT: no such file or directory, lstat '<workspace>/src/main.ts'

Path exists in registered workspace repo(s). Retry read with one of:
- agent-workbench/src/main.ts
```

若 `service-template/src/main.ts` 也存在，两个候选均提示，不自动选择。

## 目标

- 在不改变 `read` 路径语义的前提下，降低多 repo workspace 中因漏写 repo 前缀导致的重复失败。
- 只为已通过现有路径校验的相对路径提供确定、可操作、可复制的候选。
- 让模型在下一次调用中显式传入 `<repoDirName>/<原始路径>`。
- 保留既有工具失败状态、错误类型和 Runner 输出通道，避免扩大协议改动。
- 使实现具备明确安全边界、稳定输出和可测试的兼容降级行为。

## 非目标

本期明确不做以下事项：

- 不将 workspace 根目录改为某个 repo 根目录。
- 不自动补全 repo 前缀后重试或返回文件内容。
- 不递归扫描 workspace、搜索文件树或查找 `.git`。
- 不把 workspace 中任意一级目录视为 repo。
- 不提供模糊匹配、大小写纠正、路径相似度搜索或文件名搜索。
- 不改变 `read` 对绝对路径、越界路径、NUL、换行、symlink 和二进制文件的既有拒绝语义。
- 不修改 `AgentToolOutputSchema`，不新增结构化 diagnostics 字段。
- 不把 repo 列表写入 Run、Session 或 context item 的持久化记录。
- 不调整前端展示、模型提示词或 workspace 文件浏览器的路径语义。

## 术语

| 术语 | 定义 |
|---|---|
| workspace 根目录 | 本次 Agent run 的 `workspacePath`，所有 `read` 相对路径的原始解析根。 |
| 登记 repo | `workspace_repos` 表中属于当前 workspace 的记录；只有这些记录的 `dirName` 可参与候选探测。 |
| repo 目录名 | `WorkspaceRepoRecord.dirName`，位于 workspace 根目录下的安全逻辑目录段，如 `agent-workbench`。 |
| 原始路径 | 调用方传入并经 `ensureSafeRelativePath` 通过的 `filePath`。 |
| 根路径 | `<workspacePath>/<原始路径>`，即既有 `read` 的实际目标。 |
| 候选路径 | `<workspacePath>/<repoDirName>/<原始路径>`；面向模型输出时仅显示 `<repoDirName>/<原始路径>`。 |
| 缺失类错误 | 根路径初始 `lstat` 产生的 `ENOENT` 或 `ENOTDIR`。 |
| 定点探测 | 对每个登记 repo 的单一候选路径执行一次受限 `lstat`，不遍历目录树。 |

## 不可突破的范围边界

以下条件必须同时满足，才允许进入候选探测：

- `filePath` 是合法相对路径，并已经通过当前 `read` 的路径安全校验；
- 根路径初始 `lstat` 失败，且 `error.code` 精确为 `ENOENT` 或 `ENOTDIR`；
- repo 名称来自本次 run 接收到的已登记 repo `dirName` 列表；
- 每个候选通过 workspace 内路径包含关系校验；
- repo 根本身和最终候选本身均不是符号链接；
- 若中间路径组件是符号链接，最终候选的 realpath 仍必须位于 workspace 内；不逐段拒绝中间组件。

任一条件不满足时，必须维持当前行为：直接抛出原错误或原校验错误，且不添加候选提示。

详细行为见 [02-product-contract.md](./02-product-contract.md)，安全与算法见 [04-technical-design.md](./04-technical-design.md)。
