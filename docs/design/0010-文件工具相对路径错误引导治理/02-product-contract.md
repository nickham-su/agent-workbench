# 产品行为与错误文本合同

返回 [README](./README.md)。本文件定义模型和用户可观察的行为，是开发、代码审查与验收的主合同。

## 总体合同

### 输入合同保持不变

- `read.filePath`、`write.filePath` 必须是 workspace 内相对路径；
- `apply_patch` 的 diff 文件路径必须是 workspace 内相对路径；
- 绝对路径输入继续失败为 `absolute path is not allowed`；
- `..` 逃逸继续失败为 `path is outside workspace`；
- symlink、目录、二进制和其他既有约束不因本设计放宽。

### 错误路径展示原则

首期纳入范围的错误必须遵守：

- 若展示文件路径，必须展示工具已经掌握的可重试相对路径；
- 已有 `path`、`fromPath`、`toPath`、`relativePath` 等相对字段时必须直接使用，不得从 `fullPath` 反推；唯一例外是父组件补强分支可在已完成 containment 的工具内部，从遍历中的 `currentPath` 安全派生相对组件展示路径；
- move/rename 错误必须选择语义对应的源或目标相对路径；
- 同一错误已有 `Failed file: <relative>` 时，不再输出内部 `Path: <fullPath>`；
- 无可靠相对路径时允许不展示路径；不得退回展示 `fullPath`；
- `apply_patch` formatter / classifier 只分类和组织源错误，不负责把绝对路径重写为相对路径；进入 formatter / classifier 前，纳入范围的源错误必须已经相对化；
- 不要求改写首期明确排除的未分类底层异常。

### 不可接受的错误文案反例

以下反例适用于首期纳入范围的错误：

```text
ENOENT: no such file or directory, path: /data/workspaces/ws/src/a.ts
Path is a directory: /data/workspaces/ws/src/generated
Failed file: src/a.ts
Path: /data/workspaces/ws/src/a.ts
```

将路径替换为 `<workspace>/src/a.ts` 或 `[workspace]/src/a.ts` 也不可接受，因为它们仍不能直接用于工具调用。可接受结果应为 `src/a.ts`，或在没有可靠相对路径时不输出路径。

### 状态合同保持不变

路径文本规范化不改变：

- 工具 `completed` / `failed` / `cancelled` 状态；
- `apply_patch` 的分类码、retryable 判定、repairAttempted 标记；
- `read` 候选命中仍然失败，不自动读取；
- 失败结果仍不产生伪成功 `result`；
- Runner 仍把工具错误原样写入 `output.error` 和失败工具文本。

## read 合同

### 触发范围

`runReadToolInternal` 对根目标 `lstat` 失败后按错误对象的 `code` 处理：

| 根错误 | 路径文本处理 | repo probe | 首期要求 |
|---|---|---|---|
| `ENOENT` | 必须重建为含 `safePath` 的稳定错误 | 是 | 纳入 |
| `ENOTDIR` | 必须重建为含 `safePath` 的稳定错误 | 是 | 纳入 |
| `EACCES`、`EPERM`、`EIO` 等其他错误 | 原样上抛 | 否 | 不做路径改写 |
| abort-like / signal 已取消 | 保持既有取消语义 | 不形成 hint | 不做路径改写 |
| 输入绝对、非法、越界 | 保持既有校验错误 | 否 | 行为不变 |

不得通过错误字符串判断是否缺失；继续使用 `error.code`。

### ENOENT / ENOTDIR 文案

规范化后的根错误必须：

- 保留原错误码；
- 保留足够的操作语义；
- 目标路径使用 `safePath`；
- 不包含 `workspacePath` 或解析后的 `fullPath`；
- 不依赖替换 Node 原始错误字符串中的绝对路径。

首期固定模板：

```text
ENOENT: no such file or directory, path: <safePath>
```

```text
ENOTDIR: not a directory, path: <safePath>
```

首期不新增引号或分隔符转义逻辑。模板不得额外包裹路径，错误中的路径片段必须原样保留 `safePath` 相对路径字符串；`safePath` 已拒绝 NUL、换行和回车。

### repo hint 合同

候选探测、排序、上限、symlink 与取消合同沿用 `0001-read工具优化`，本设计只改变错误前缀：

- 候选命中后仍抛错；
- 规范化根错误作为前缀；
- 后接两个换行和既有固定标题、候选列表；
- 候选路径继续为 workspace 相对路径，并使用 `/` 分隔；
- 不自动选择、不自动重试、不自动读取；
- 无候选时只返回规范化根错误。

示例：

```text
ENOENT: no such file or directory, path: src/a.ts

Path exists in registered workspace repo(s). Retry read with one of:
- repo-a/src/a.ts
```

原 `0001-read工具优化` 中“原始 Node 错误是不变前缀”的合同由本设计覆盖；其候选语义与格式继续有效。

## apply_patch 合同

### 通用规则

`apply_patch` 已有相对路径字段时必须直接用于错误展示，不得对 `fullPath` 做字符串裁剪，也不得依赖 Runner 替换。

| 错误语义 | 必须展示的相对路径 |
|---|---|
| add 目标已存在 | add 的 `path` |
| delete / update 源文件缺失 | 源 `path` |
| delete 非空但无 hunks | delete 的 `path` |
| move / rename 源文件缺失或非法 | `fromPath` |
| move / rename 目标已存在或父目录失败 | `toPath` / operation `path` |
| update context mismatch | 被更新源文件的 `path` |
| snapshot mismatch | snapshot `path` |
| 最终目标、源、目标或 snapshot 为 symlink / 目录 | 对应的已有相对路径字段；属于主问题直接修复 |
| 中间父组件为 symlink / 非目录 | 工具内部安全派生的 workspace 相对组件路径；属于工具内补强覆盖 |
| apply 阶段 add/update/move 写入错误 | operation `path` |
| apply 阶段 delete 校验错误 | operation `path` |

### 覆盖层级

`apply_patch` 首期覆盖分为两层，两层都必须实现和验收，但不得在开发说明中混为同一种现状：

| 层级 | 定义 | 处理要求 |
|---|---|---|
| 主问题直接修复 | 当前错误构造点直接把最终目标、源、目标或 snapshot 的 `fullPath` 等绝对字段插入对外文案 | 必须改用同一语义位置已有的 `path`、`fromPath`、`toPath`、`relativePath`，或删除冗余绝对路径行 |
| 工具内补强覆盖 | `ensureParentDirectorySafe` 遍历中间父组件后，以临时 `currentPath` 构造 symlink / 非目录组件错误 | 首期同样必须相对化，但应标记为父组件补强；其展示路径由工具内部安全地派生为 workspace 相对组件路径 |

### 主问题直接修复的显式错误族

以下现有错误族属于主问题直接修复。其中 `Path is a directory` 和 `symlink path is not allowed` 在本列表中仅指最终目标、源文件、目标文件或 snapshot 对象，不包括下一节的中间父组件分支：

```text
Path is a directory: <path>
symlink path is not allowed: <path>
Failed to read file to delete: <path>
Failed to read file to move: <path>
Failed to read file to update: <path>
delete patch for non-empty file must include hunks: <path>
add target already exists: <path>
move target already exists: <path>
Failed to find expected lines in <path>
MISSING_PARENT_DIR: <operation> failed for <path>
IO_RETRYABLE: <operation> failed for <path> (<code>)
```

其中 `<path>` 必须是相对路径。

### snapshot mismatch

`buildSnapshotMismatchMessage` 必须移除 `fullPath` 展示参数和以下行：

```text
Path: <fullPath>
```

错误保留：

- reason；
- `Failed file: <snapshot.path>`；
- expected / actual 细节；
- 既有重新读取和重试 hint。

### context mismatch

`deriveNewContentFromChunks` 的 `filePath` 参数是**仅用于错误展示的标签**，不是文件系统访问路径。调用方必须传相对路径：

- delete 校验：传 delete `relativePath`；
- update：传 update `relativePath`；
- rename + modify：仍传源 `relativePath`，因为 hunk 匹配的是源内容。

`Failed to find expected lines in ...` 和由 `extractFailedFilesFromMessage` 提取的 `Failed files` 因此都必须是相对路径。

### formatter / classifier 边界

`classifyApplyPatchFailureMessage`、`extractFailedFilesFromMessage`、`formatApplyPatchFailureTextFromMessage` 不得承担路径重写。它们接收的纳入范围源错误必须已经只包含相对路径；随后 `failedFiles` 和 `Details` 自然继承该相对路径。不得通过给 formatter 传绝对路径 fixture、再期待 formatter 清洗的方式实现或测试本需求。

### 工具内补强覆盖：中间父组件错误

父目录遍历中，失败对象可能是目标路径的中间组件。该分支当前以遍历产生的 `currentPath` 形成绝对路径错误；它不是“最终 `fullPath` 文案直接替换”的主问题示例，而是首期明确纳入的工具内补强覆盖项。工具内部 helper 必须得到展示所需上下文，将该组件转换为 workspace 相对路径。

补强项覆盖以下文本族：

```text
symlink path is not allowed: src/generated
Path is not a directory: src/generated
```

不得展示 `workspaceRealPath` 或 `currentPath` 绝对值。

### 低频原始异常边界

以下情况首期允许继续原样上抛：

- `applyPreparedPatch` 中未匹配已知错误码、最终执行 `throw err` 的异常；
- `fs.readFile`、`fs.realpath`、`fs.unlink` 等未显式分类的底层异常；
- 运行时产生、且现有代码没有稳定相对路径错误分支的未知内部异常。

但是，不得以该边界为由保留本文“必须治理的显式错误类别”中的 `fullPath`。

## write 合同

首期明确采用：**不新增 write 错误改写，只做回归保护。**

理由：

- 文件不存在是创建成功路径，不是常见失败；
- 当前成功 `summary`、`content`、`filePath` 已使用 `safePath`；
- 当前显式校验错误不包含 `fullPath`；
- 剩余风险主要是低频底层 I/O 原始异常，全面包装需要定义错误码、保留 cause 与平台差异，超出首期收益目标。

首期必须保证：

- 成功输出继续只出现 `safePath`；
- 绝对路径输入继续在文件系统调用前拒绝；
- symlink 与 workspace containment 行为不变；
- 不为追求路径文本治理改变自动创建父目录的行为。

首期实现不得为 `runWriteTool` 新增 catch、底层错误重写、错误码映射或包装 helper。出现此类代码应在审查中判定为超范围，除非先同步修订本文档并获得方案批准。

后续若观测到稳定、高频、会误导重试的 `write` 错误，再在 `runWriteTool` 内按本设计原则做增量治理，不新增 Runner 层规则。

## 兼容边界

- 不修改工具调用 JSON；
- 不修改 API ↔ Worker 入队协议；
- 不修改数据库或持久化 schema；
- 依赖错误全文的内部测试必须更新；
- 错误分类码与固定提示保持兼容；
- 错误文本中具体路径由绝对变相对是预期的不兼容文本变化；调用方不得依赖绝对路径。

## 非目标

- 不隐藏日志或调试信息中的所有绝对路径；本设计仅约束首期列出的工具错误；
- 不把相对路径自动改写为 repo 候选并成功执行；
- 不让 `apply_patch` 自动修复 patch；
- 不新增错误对象公共结构或机器可读路径字段；
- 不承诺跨平台完全复刻 Node 原始错误措辞；首期固定模板以模型引导稳定性优先。
