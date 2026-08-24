# 技术设计

返回 [README](./README.md)。本文件定义工具内部实现方式、helper 职责、数据流与逐类替换规则。

## 总体架构

不新增跨工具错误层。每个工具在最接近错误语义的位置选择展示路径：

```text
read safePath ──> root lstat(fullPath)
                   └─ ENOENT / ENOTDIR ──> buildReadRootPathError(error, safePath)
                                             └─ appendRepoPathHint(normalizedError, candidates)

apply_patch relative hunk path + fullPath
  ├─ fullPath：lstat/read/write/realpath/containment
  └─ relative path：所有已知对外错误、classification failedFiles、formatted details
```

Runner 无代码改动。

## 私有结构与实体设计

本方案不新增公共实体。只允许以下私有结构：

### read 错误格式化 helper

建议在 `fileTools.ts` 内新增：

```ts
function buildReadRootPathError(error: unknown, safePath: string): Error
```

职责：

- 读取 `NodeJS.ErrnoException.code`；
- 仅接受 `ENOENT`、`ENOTDIR`，其他错误应由调用方绕过；
- 生成固定错误消息，目标路径原样使用 `safePath`；
- 可在新 `Error` 上保留 `code`，便于单测和未来内部判断；
- 不解析、替换或包含原始 `error.message`；
- 不执行 repo probe，不负责候选拼接。

### apply_patch 路径上下文

无需新增公共 class。优先复用现有：

- `ResolvedOperation.path`：目标相对路径；
- `ResolvedOperation.fromPath`：move 源相对路径；
- `ApplyPatchSnapshot.path`：快照相对路径；
- prepare 局部变量 `relativePath`、`fromPath`、`toPath`、`movePath`。

对仅收到绝对路径的私有 helper，应扩展参数为对象，显式携带展示路径，示例：

```ts
async function verifyExistingRegularFile(params: {
  workspaceRealPath: string;
  fullPath: string;
  displayPath: string;
  label: "delete" | "move" | "update";
})
```

```ts
async function ensureWritableParent(params: {
  workspacePath: string;
  workspaceRealPath: string;
  fullPath: string;
  displayPath: string;
})
```

命名可按代码风格调整，但必须做到：执行路径与展示路径在类型/参数层分离，不允许 helper 默认展示 `fullPath`。

## read 实现设计

### 调用顺序

`runReadToolInternal` 顺序保持：

- `ensureSafeRelativePath(params.filePath)` 得到 `safePath`；
- `resolveWithinWorkspace(params.workspacePath, safePath)` 得到 `fullPath`；
- `fs.lstat(fullPath)`；
- catch 后先以 `isMissingRootPathError(rootError)` 判断；
- 非缺失错误原样抛出；
- 缺失错误立即生成 `displayError = buildReadRootPathError(rootError, safePath)`；
- repo probe 仍使用 `safePath` 和原 `signal`；
- 无候选或 abort 时抛 `displayError`；
- 有候选时调用 `appendRepoPathHint(displayError, matches)`。

不得在无候选分支重新抛 `rootError`，否则绝对路径仍会出现。

### 错误模板

```ts
switch (error.code) {
  case "ENOENT":
    return errorWithCode("ENOENT", `ENOENT: no such file or directory, path: ${safePath}`);
  case "ENOTDIR":
    return errorWithCode("ENOTDIR", `ENOTDIR: not a directory, path: ${safePath}`);
  default:
    // 不应由调用方传入；防御性返回通用、无 fullPath 的错误，或抛内部断言。
}
```

具体 helper 名称可调整；固定外部模板必须符合产品合同。

### 与 repo hint 的关系

`appendRepoPathHint` 可继续接收 `unknown`，但调用者必须传规范化后的 `displayError`。如果为职责清晰而改为接收 `Error` 也可接受。候选列表逻辑不得修改。

### 非缺失错误

以下代码语义保持：

```ts
if (!isMissingRootPathError(rootError)) throw rootError;
```

本设计不要求对其做任何替换。

## apply_patch 实现设计

### 原则

- 绝对字段保留，继续用于 I/O 与安全校验；
- 主问题直接修复：当前以最终目标、源、目标或 snapshot 的 `fullPath` 等绝对字段构造的对外错误，必须在生成点改用相对字段；
- 工具内补强覆盖：父组件遍历中由 `currentPath` 派生的错误也在首期内相对化，但必须单独标记和测试，不与主问题直接翻转混同；
- 已有相对字段时不得调用 `path.relative` 从 `fullPath` 反推；只有父组件补强可在 containment 已确认后，从临时 `currentPath` 派生相对组件展示路径；
- 任何错误 formatter / classifier 接收的 message 必须在进入 formatter / classifier 前已经使用相对路径；
- `classifyApplyPatchFailureMessage`、`extractFailedFilesFromMessage`、`formatApplyPatchFailureTextFromMessage` 保留分类、提取和组织职责，不承担绝对转相对；
- 不在 formatter / classifier 中加入 workspace 字符串替换、`path.relative` 或其他清洗逻辑。

以下 snapshot、virtual state、regular-file、prepare、context mismatch 和 apply 阶段错误属于主问题直接修复；parent directory validation 属于工具内补强覆盖。

### snapshot validation

修改 `buildSnapshotMismatchMessage`：

```ts
function buildSnapshotMismatchMessage(params: {
  reason: string;
  path: string;
  details: string[];
})
```

删除 `fullPath` 参数和 `Path:` 行。三个 mismatch 分支继续传 `snapshot.path`。

修改 `readCurrentFileStateForValidation`，使其接收：

```ts
{ fullPath: string; displayPath: string }
```

目录和 symlink 错误使用 `displayPath`。`fs.readFile` 的低频原始异常首期可透传。

### virtual file state

`readVirtualFileState` 已同时接收 `relativePath` 与 `fullPath`，直接把：

```text
Path is a directory: params.fullPath
symlink path is not allowed: params.fullPath
```

改为 `params.relativePath`。缓存 key、lstat、realpath、readFile 继续使用 `fullPath`。

### parent directory validation（工具内补强覆盖）

`ensureParentDirectorySafe` 遍历父目录组件时目前产生 `currentPath` 绝对路径。该错误来源于遍历中间组件后临时派生的路径，不是最终 `fullPath` 文案的直接替换。首期仍必须在错误分支计算当前组件的 workspace 相对展示路径，作为工具内补强覆盖。

建议：

```ts
const currentDisplayPath = toWorkspaceRelativeDisplayPath(
  params.workspaceRealPath,
  currentPath
);
```

该 helper 仅在已经通过 lexical containment、且 `currentPath` 从 `workspaceRealPath` 逐段构造后使用；返回值必须拒绝空值、绝对结果和 `..` 逃逸。分隔符使用 `/`，以便 patch 路径可直接复用。

错误改为：

```text
symlink path is not allowed: <currentDisplayPath>
Path is not a directory: <currentDisplayPath>
```

`path is outside workspace` 不增加路径，保持现有通用文案。

### regular file validation

`verifyExistingRegularFile` 增加 `displayPath`：

- 缺失：`Failed to read file to <label>: <displayPath>`；
- 目录：`Path is a directory: <displayPath>`；
- symlink：`symlink path is not allowed: <displayPath>`；
- realpath containment 仍使用 `fullPath`。

调用映射：

- move source：`displayPath = operation.fromPath`；
- delete source：`displayPath = operation.path`。

### prepare 阶段显式错误

逐项替换：

| 当前绝对变量 | 相对替代 |
|---|---|
| add 已存在 `${fullPath}` | `${relativePath}` |
| delete 缺失 `${fullPath}` | `${relativePath}` |
| delete 无 hunk `${fullPath}` | `${relativePath}` |
| move source 缺失 `${fromFullPath}` | `${fromPath}` |
| move target 已存在 `${toFullPath}` | `${toPath}` |
| update 缺失 `${fullPath}` | `${relativePath}` |
| rename+modify 目标已存在 `${moveFullPath}` | `${movePath}` |

### context mismatch

所有 `deriveNewContentFromChunks` 调用的 `filePath` 必须传展示相对路径：

| 场景 | 参数值 |
|---|---|
| delete hunk 内容校验 | `relativePath` |
| update | `relativePath` |
| rename + modify | `relativePath`（源路径） |

`applyPatchUpdate.ts` 无需改变算法；如为语义清晰，可将参数名从 `filePath` 重命名为 `displayPath`，但这不是外部 API。若重命名，测试与所有调用必须同步。

### apply 阶段显式错误

`ensureWritableParent` 必须接收 operation 相对路径。随后：

| operation | 错误路径 |
|---|---|
| add | `operation.path` |
| update | `operation.path` |
| move 写目标 | `operation.path` |
| move 校验源 | `operation.fromPath` |
| delete 校验源 | `operation.path` |

catch 中已识别错误必须重建为相对路径：

```text
add target already exists: <operation.path>
MISSING_PARENT_DIR: add failed for <operation.path>
IO_RETRYABLE: add failed for <operation.path> (<code>)
MISSING_PARENT_DIR: update failed for <operation.path>
IO_RETRYABLE: update failed for <operation.path> (<code>)
move target already exists: <operation.path>
MISSING_PARENT_DIR: move failed for <operation.path>
IO_RETRYABLE: move failed for <operation.path> (<code>)
```

未匹配错误码的 `throw err` 保持不变。

### 错误分类与格式化

`classifyApplyPatchFailureMessage`、`extractFailedFilesFromMessage`、`formatApplyPatchFailureTextFromMessage` 的架构不变，也不得新增路径重写职责。源错误必须先在具体错误生成点相对化；进入这一层后：

- `failedFiles` 自然提取相对路径；
- `Details` 自然复制相对路径；
- formatter / classifier 不做二次清洗，也不得接收 workspacePath 以辅助替换；
- 测试 fixture 中的绝对示例必须改为相对示例，以免把旧行为继续定义为合同。

对 `Path is a directory` / `Path is not a directory` 是否加入 `extractFailedFilesFromMessage` 不属于本需求；若顺手新增，必须独立测试，不得改变 failure code。

## write 实现设计

生产代码不改。首期不得为 `runWriteTool` 新增 catch、错误码映射、错误重写或包装 helper；出现此类改动应视为超范围，除非先同步修订并批准本设计。仅验证：

- `safePath` / `fullPath` 分离继续存在；
- 成功文本使用 `safePath`；
- 绝对路径输入在 `fs.mkdir` / `fs.writeFile` 前失败；
- 不新增 Runner 兜底。

## 路径展示规则

### 分隔符

- `read safePath` 保留调用者通过校验后的原字符串；
- `apply_patch` hunk 相对路径使用解析器产生的既有路径字符串；
- 仅对从中间绝对组件计算的展示路径统一转为 `/`。

### read 展示格式

- 路径输入已经拒绝 NUL、换行、回车；
- 首期不新增引号或分隔符转义逻辑；`read` 使用 `path: ${safePath}` 的无引号模板，路径片段原样保留 `safePath`；
- `apply_patch` 既有非引号模板保持不加引号，避免不必要的错误分类正则变化。

### 安全与 containment

展示路径绝不参与文件系统操作和安全判定。所有既有：

- lexical containment；
- realpath containment；
- symlink 拒绝；
- parent directory 创建与校验；

必须继续使用内部绝对路径。

## 可维护性约束

- helper 保持文件私有，除已有测试导出惯例外不扩展公共 API；
- 不允许创建一个跨 `read/write/apply_patch` 的通用正则 sanitizer；
- 不允许在 Runner 获取 `workspacePath` 后做文本 replace；
- 新增主动路径错误时，代码审查必须要求同时传 execution path 和 display path；
- `rg` 搜索 `${fullPath}` 等只能用于发现候选，不能机械替换所有执行字段。

## 性能与并发

本方案仅改变错误构造和少量参数传递：

- 不新增文件系统调用；
- 不改变 repo probe 并发；
- 不改变 patch prepare/apply 原子性；
- 中间组件展示路径计算为纯字符串操作，复杂度与路径深度线性，且只在错误分支执行。
