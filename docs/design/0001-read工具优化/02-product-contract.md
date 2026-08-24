# 产品行为与错误合同

返回 [README](./README.md)。本文件定义可观察行为，是开发、审查和验收的主合同。

## 输入

`read` 继续使用既有入参：

```ts
{
  filePath: string;
  offset?: number;
  limit?: number;
}
```

本设计新增的 `workspaceRepoDirNames` 是运行时上下文，不是模型可传入参数，不会出现在 `read` 工具 schema 或工具描述中。

## 触发判定

按下列顺序处理，顺序不可调整：

- 先执行既有的 `ensureSafeRelativePath(filePath)` 和 `resolveWithinWorkspace(workspacePath, safePath)`。
- 对根路径执行既有的 `fs.lstat(fullPath)`。
- 仅当该次 `lstat` 抛出的错误对象 `code` 为 `ENOENT` 或 `ENOTDIR` 时，开始候选探测。
- 其他错误，例如 `EACCES`、`EPERM`、`EIO`、AbortError，必须立即按原样向上抛出；不得探测。
- Worker server 入站 JSON 中字段缺失时归一化为 `[]`；此后 API、Worker 内部和 `runReadTool` 的字段均为必有数组。数组为空时必须按原始缺失错误失败；不得生成空提示。

不得以错误字符串（例如 `no such file or directory`）作为触发条件；必须基于 `error.code`。

## 候选探测行为

对每个登记 repo 目录名构造：

```text
candidateAbsolute = resolveWithinWorkspace(workspacePath, join(repoDirName, safePath))
candidateDisplay = posix-style(repoDirName + "/" + safePath)
```

候选有效的定义：

- repo 根的 `lstat` 成功、repo 根本身不是符号链接，且其 realpath 位于 workspace 内；
- `fs.lstat(candidateAbsolute)` 成功，且最终候选本身不是符号链接；
- `candidateAbsolute` 的 realpath 位于 workspace 内；
- 中间路径组件不逐段 `lstat`；它们可以是符号链接，但最终 realpath containment 必须通过；
- 候选可以是常规文件或目录；不在本阶段读取内容，也不要求其一定是文本文件。

未取消时，单个候选探测中的 `ENOENT`、`ENOTDIR`、`EACCES`、`EPERM`、`EIO`、realpath 失败或其他内部异常都只表示该候选不可用于提示；必须忽略该候选，并继续其他候选。若 signal 已 abort，则停止派发新的 probe，并按本文件的“取消合同”处理。**任何 probe 错误都不得覆盖根路径的原始错误。**

## 单、多个和零候选

| 情况 | `read` 状态 | 错误文本 | 后续动作 |
|---|---|---|---|
| 一个候选 | `failed` | 原错误 + 一个候选重试路径 | 模型应使用该完整相对路径重新调用 `read`。 |
| 多个候选 | `failed` | 原错误 + 按稳定顺序的多个候选 | 模型必须显式选择一个路径；工具不得替模型选择。 |
| 零个候选 | `failed` | 仅原错误 | 无额外搜索、无额外诊断。 |
| 非缺失类根错误 | `failed` | 仅原错误 | 不探测。 |
| 非法/越界/绝对路径 | `failed` | 仅既有校验错误 | 不探测。 |

## 错误文案合同

候选命中时，抛出的 `Error.message` 必须以原始根路径错误消息为**不变前缀**，随后追加两个换行和以下英文正文：

```text
Path exists in registered workspace repo(s). Retry read with one of:
- <repoDirName>/<safePath>
- <repoDirName>/<safePath>
```

精确规则：

- 提示标题固定为 `Path exists in registered workspace repo(s). Retry read with one of:`。
- 每个候选独占一行，以 `- ` 开头。
- 显示路径一律使用 `/` 作为分隔符，即使 Worker 运行在 Windows；不得显示 workspace 绝对路径。
- 候选不足或等于上限时，标题之后只输出候选行。
- 命中数超过上限时，在候选行之后追加：

  ```text
  - ... and <N> more candidate(s) not shown
  ```

- 标点、大小写、换行均视为工具错误文本合同；测试应进行精确或等价的稳定断言。
- 不命中时不得追加标题、空列表、计数或“未找到”文本。

示例：

```text
ENOENT: no such file or directory, lstat '/data/workspaces/ws-1/apps/api/src/main.ts'

Path exists in registered workspace repo(s). Retry read with one of:
- agent-workbench/apps/api/src/main.ts
```

这里的绝对路径只可能存在于 Node 原始错误前缀中，属于既有行为；新增提示部分绝不引入绝对路径。

## 排序、去重与上限

为保证同一次工作区状态下输出稳定，实现必须：

- 在 API 侧按 `listWorkspaceRepos()` 既有的 `rowid asc` 顺序获取 repo；该函数已明确以创建/挂载顺序稳定返回。
- 在 Worker server 归一化时保留第一次出现的顺序并按完全相同的字符串去重。
- 在 `runReadTool` 输出前按 `candidateDisplay` 的 UTF-8 字节序升序排序（Node 实现使用 `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`）；这是最终错误文本的唯一排序规则，不能依赖数据库顺序、运行时 locale 或 `lstat` 完成顺序。
- 最多显示 **10** 个候选；总命中数用于计算 `... and N more ...` 行。

并行探测允许改变完成顺序，但不得改变最终显示顺序。

## 兼容与降级

| 场景 | 必须行为 |
|---|---|
| 新 API + 新 Worker | 传递 repo 名称并提供候选提示。 |
| 旧 API + 新 Worker | `workspaceRepoDirNames` 缺失时归一化为空数组；保持原 `read` 失败行为。 |
| 新 API + 旧 Worker | 旧 Worker 忽略未知 JSON 字段；保持原 `read` 失败行为。 |
| workspace 没有登记 repo | 传递空数组；保持原行为。 |
| repo 在 run 期间删除、权限变化或文件被替换 | 提示基于探测瞬间；重试仍可能失败；不得将探测结果当作读取保证。 |

该功能是诊断增强，不属于成功回退路径。`status` 必须仍为 `failed`，`output.result` 不得写入候选内容；既有 Runner 将扩展后的错误字符串写入 `output.error` 和失败工具文本。

## 取消合同

若 `signal` 在候选探测期间 abort，工作池必须停止派发新的 probe；已启动的 probe 结果不形成候选提示。`runReadTool` 必须抛回根路径原始错误，probe/abort 错误不得替换它。

Runner 的既有行为决定最终状态：当 signal 已 aborted 或错误为 abort-like 时，`executeTool` / `executeToolSafely` 不得写入 `failed` 工具结果；`processRun` 以既有 cancelled 流程结束 run。因此，候选探测功能不得新增或竞争写入 `failed` / `cancelled` 状态。
