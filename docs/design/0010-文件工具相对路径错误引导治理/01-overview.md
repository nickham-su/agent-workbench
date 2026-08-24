# 背景、问题与范围

返回 [README](./README.md)。本文件解释为什么需要治理、首期解决什么，以及明确不解决什么。

## 需求背景

Agent Worker 的 `read`、`write`、`apply_patch` 均以 workspace 内相对路径作为模型可提交的路径形态。现有实现为执行文件系统操作，会把相对路径解析为内部绝对 `fullPath`。该内部表示本身正确，但部分失败路径把它写回工具错误：

- `read` 对根目标执行 `fs.lstat(fullPath)`，缺失时直接保留 Node 原始 `ENOENT` / `ENOTDIR` 错误；
- `apply_patch` 多处手工拼接 `${fullPath}`、`${fromFullPath}`、`${toFullPath}`，或把绝对路径传给下游 mismatch 文案生成器；
- Runner 将 `err.message` 原样写入失败工具项，模型下一轮可直接看到这些绝对路径。

模型通常会把工具错误中的具体路径视为系统推荐的修复输入。于是形成以下业务失败链路：

```text
read({ filePath: "src/a.ts" })
  -> ENOENT: ... lstat '/data/workspaces/ws/src/a.ts'
  -> 模型复制 '/data/workspaces/ws/src/a.ts'
  -> read({ filePath: "/data/workspaces/ws/src/a.ts" })
  -> absolute path is not allowed
```

第二次失败并非文件状态变化，而是第一次错误给出了不符合工具输入合同的路径。问题本质是**错误信息与工具可调用接口的语义不一致**。

## 业务影响

- 浪费工具调用轮次和上下文窗口；
- 模型可能在多个文件工具间重复使用绝对路径，扩大错误引导；
- repo hint 已经提供正确相对候选时，原始绝对路径前缀仍可能与候选竞争，降低提示有效性；
- `apply_patch` 的错误格式化会把源错误复制到 `Details`，并可能从中提取 `Failed files`，使绝对路径重复出现；
- 用户看到模型连续以绝对路径重试，降低对 Agent 自纠错能力的信任。

## 当前基线

### 相对路径输入合同

`fileTools.ts` 和 `applyPatch.ts` 各自的 `ensureSafeRelativePath` 都拒绝绝对路径，并通过 `resolveWithinWorkspace` 拒绝 workspace 外路径。该安全与调用合同不变。

### read 根错误

`runReadToolInternal` 先得到 `safePath` 与 `fullPath`，随后对 `fullPath` 执行根 `lstat`。当错误码为 `ENOENT` / `ENOTDIR` 时：

- 无 repo 候选：直接 `throw rootError`；
- 有 repo 候选：`appendRepoPathHint(rootError, matches)` 保留原错误全文作为前缀。

当前测试还显式断言错误包含 `workspacePath`，这正是本方案需要翻转的基线。

### apply_patch 显式错误

`applyPatch.ts` 的内部数据结构通常同时拥有相对字段和绝对字段：

- `ResolvedOperation.path` 与 `ResolvedOperation.fullPath`；
- move 操作的 `fromPath` 与 `fromFullPath`；
- `ApplyPatchSnapshot.path` 与 `ApplyPatchSnapshot.fullPath`；
- prepare 阶段局部变量 `relativePath` 与 `fullPath`。

因此多数显式绝对路径错误不是缺少相对信息，而是展示层错误地选择了内部字段。

### write 基线

`runWriteTool` 会递归创建父目录并写入目标，目标不存在是正常创建流程。成功返回已经使用 `safePath`。其潜在绝对路径主要来自未包装的低频底层文件系统异常，而非现有显式错误文案。

## 目标

- 让首期覆盖的错误中出现的文件路径可直接作为同一工具下一轮的相对路径输入；
- 没有可靠相对路径时，不展示路径，而不是展示内部绝对路径；
- 修复 `read` 的高频根缺失错误和 repo hint 前缀；
- 修复 `apply_patch` 中显式、已知、会进入分类/格式化结果的绝对路径来源；
- 保持所有成功行为、安全校验、状态语义和 Runner 写回流程不变；
- 用单元测试与 Runner 输出回归测试锁定模型实际可见结果。

## 首期范围

### 纳入范围

- `read` 根 `lstat` 的 `ENOENT`、`ENOTDIR` 错误路径规范化；
- `read` repo hint 与规范化根错误拼接；
- `apply_patch` prepare、snapshot validation、apply 阶段的显式 `fullPath` 错误；
- `apply_patch` 父目录遍历中由 `currentPath` 派生的 symlink / 非目录组件错误相对化；该项是工具内补强覆盖，不与前一项的现有显式主问题混为同一层级；
- `apply_patch` context mismatch 的展示路径输入；
- `apply_patch` 错误分类 `failedFiles` 和格式化 `details` 在上述错误改完后的相对路径结果；
- 相关工具单测和 Runner 可见输出回归测试；
- `write` 成功行为与绝对路径输入拒绝的回归保护。

### 明确不纳入范围

- Runner 或工具框架层统一路径 sanitizer；
- 通用“绝对路径脱敏”能力或安全审计功能；
- 对任意异常字符串做正则猜测和全局替换；
- 包装 `read` 的所有非缺失根错误；
- 包装 `write` 的低频 `mkdir`、`realpath`、`writeFile` 原始异常；
- 为 `runWriteTool` 新增 catch、错误重写或错误包装 helper；除非先同步修订并重新批准本设计；
- 包装 `apply_patch` 所有未识别的底层 `throw err`；
- 修改 tool schema、工具描述、API/Worker 协议、数据库实体或 shared output schema；
- 改变 repo probe、自动读取、自动修复、自动重试、patch repair 或成功/失败状态。

## 首期完成度定义

首期不是“扫描整个工具错误文本后保证零绝对路径”。完成的定义是：

- 文档列出的 `read` 高频根错误全部满足相对路径合同；
- 文档列出的 `apply_patch` 主问题显式路径错误全部改用相对字段或删除冗余路径行；
- 文档列出的 `apply_patch` 父组件补强场景全部显示相对组件路径；
- 新增测试覆盖这些分支并断言 workspace 绝对路径不进入模型可见文本；
- 低频、未分类的原始底层异常即使仍可能带绝对路径，也不阻塞首期验收。

## 术语

| 术语 | 定义 |
|---|---|
| `safePath` / `relativePath` | 已通过工具相对路径格式校验、可用于下一轮同类工具调用的 workspace 相对路径。 |
| `fullPath` | 工具内部由 `workspacePath` 与相对路径解析出的绝对文件系统路径，仅供执行和 containment 校验。 |
| 可重试路径 | 模型可直接复制到工具参数或 patch header 中的相对路径。 |
| 显式路径错误 | 工具代码主动构造、并在错误文案中插入某个路径字段的错误。 |
| 原始底层异常 | Node 文件系统 API 产生、工具未分类或未重新构造的异常。 |
| 工具内兜底 | 在具体工具函数或其私有 helper 内规范化已知错误；不跨越到 Runner。 |

## 成功示例

### read 无候选

```text
ENOENT: no such file or directory, path: src/a.ts
```

### read 有候选

```text
ENOENT: no such file or directory, path: src/a.ts

Path exists in registered workspace repo(s). Retry read with one of:
- agent-workbench/src/a.ts
```

### apply_patch 冲突

```text
add target already exists: src/a.ts
```

### apply_patch snapshot mismatch

```text
prepare/apply snapshot mismatch: content changed after prepare
Failed file: src/a.ts
Expected: prepared content snapshot to match at apply time.
Actual: file content changed after prepare.
Hint: re-run apply_patch after re-reading the latest workspace files.
```

以上错误均不把内部 workspace 绝对路径作为重试引导。
