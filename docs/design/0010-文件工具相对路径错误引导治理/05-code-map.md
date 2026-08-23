# 代码地图与基线引用

返回 [README](./README.md)。本文件用于开发前核对、实施定位和代码审查。行号仅为当前基线检索提示，最终以符号和职责为准。

## 核心生产代码

### `apps/agent-worker/src/runtime/fileTools.ts`

| 符号/区域 | 当前职责 | 本次要求 |
|---|---|---|
| `ensureSafeRelativePath` | 拒绝空、非法、绝对路径 | 不改变 |
| `resolveWithinWorkspace` | 解析 `fullPath` 并做 lexical containment | 不改变 |
| `isMissingRootPathError` | 以 `code` 判断 `ENOENT` / `ENOTDIR` | 继续作为唯一 read 触发条件 |
| `appendRepoPathHint` | 原错误前缀后追加候选列表 | 改为接收规范化根错误；候选逻辑不变 |
| `runReadToolInternal` | 根 lstat、repo probe、读取文件/目录 | 缺失分支抛相对路径错误，不再抛原始 `rootError` |
| `runWriteTool` | 校验、创建父目录、写入、返回 before/after | 生产代码首期不改，只回归；新增 catch、错误重写或包装 helper 属于超范围 |

当前关键基线：

```ts
const safePath = ensureSafeRelativePath(params.filePath);
const fullPath = resolveWithinWorkspace(params.workspacePath, safePath);
stat = await fs.lstat(fullPath);
```

当前问题分支：

```ts
if (params.signal?.aborted || matches.length === 0) throw rootError;
throw appendRepoPathHint(rootError, matches);
```

实施后两个分支都必须使用规范化 error。

### `apps/agent-worker/src/runtime/applyPatch.ts`

#### 错误格式化与分类

本区域不负责路径重写。纳入范围的源错误必须在进入 formatter / classifier 前已经相对化；若这里新增 workspacePath、`path.relative` 或字符串替换，应判定为分层违规。

| 符号 | 当前职责 | 本次要求 |
|---|---|---|
| `buildApplyPatchFailureText` | 构造最终 verification failed 文本 | 不做路径改写 |
| `formatApplyPatchFailureTextFromMessage` | 分类并复制 details | 不做 workspace 替换；只接收已相对化的纳入范围源错误 |
| `classifyApplyPatchFailureMessage` | 错误码、retryable、hint | 保持分类语义，不做路径转换 |
| `extractFailedFilesFromMessage` | 从源错误提取文件 | fixture 和结果改为相对路径 |
| `buildSnapshotMismatchMessage` | 快照漂移错误 | 删除 `fullPath` 参数和 `Path:` 行 |

#### 快照与文件状态

| 符号 | 当前绝对路径来源 | 本次要求 |
|---|---|---|
| `readCurrentFileStateForValidation` | 目录/symlink 使用 `fullPath` | 增加展示路径参数 |
| `validatePreparedPatchSnapshots` | 调用上者并生成 mismatch | 使用 `snapshot.path` |
| `readVirtualFileState` | 目录/symlink 使用 `params.fullPath` | 使用 `params.relativePath` |
| `writeVirtualFileState` | 仅用 fullPath 作缓存 key | 不改，无对外错误 |

#### 路径校验：主问题直接修复

| 符号 | 当前绝对路径来源 | 本次要求 |
|---|---|---|
| `ensureRealPathInsideWorkspace` | 只抛通用 outside workspace | 不改 |
| `verifyExistingRegularFile` | 缺失/目录/symlink 使用 `fullPath` | 增加 `displayPath` |
| `ensureWritableParent` | 目录/symlink 使用 `fullPath` | 增加 `displayPath` 并向下传递 |

#### 父组件遍历：工具内补强覆盖

| 符号 | 当前绝对路径来源 | 本次要求 |
|---|---|---|
| `ensureParentDirectorySafe` | 遍历中间组件时，symlink / 非目录错误使用临时 `currentPath` | 计算中间组件的 workspace 相对展示路径；作为补强项单独实现和测试，不视为主流程最终 `fullPath` 的直接替换 |

#### prepare 主流程

当前需逐项检查的错误文本：

```text
add target already exists: ${fullPath}
Failed to read file to delete: ${fullPath}
delete patch for non-empty file must include hunks: ${fullPath}
Failed to read file to move: ${fromFullPath}
move target already exists: ${toFullPath}
Failed to read file to update: ${fullPath}
move target already exists: ${moveFullPath}
```

相对字段均在同一分支内已经存在：`relativePath`、`fromPath`、`toPath`、`movePath`。

#### apply 主流程

`ResolvedOperation` 当前结构已同时保存 execution/display 信息：

```ts
type ResolvedOperation =
  | { kind: "add"; path: string; fullPath: string; ... }
  | { kind: "update"; path: string; fullPath: string; ... }
  | { kind: "delete"; path: string; fullPath: string }
  | { kind: "move"; path: string; fromPath: string; fullPath: string; fromFullPath: string; ... };
```

需治理的 catch 文本：

```text
add target already exists: ${operation.fullPath}
MISSING_PARENT_DIR: add failed for ${operation.fullPath}
IO_RETRYABLE: add failed for ${operation.fullPath}
MISSING_PARENT_DIR: update failed for ${operation.fullPath}
IO_RETRYABLE: update failed for ${operation.fullPath}
move target already exists: ${operation.fullPath}
MISSING_PARENT_DIR: move failed for ${operation.fullPath}
IO_RETRYABLE: move failed for ${operation.fullPath}
```

均改用 `operation.path`。move 源校验使用 `operation.fromPath`。

### `apps/agent-worker/src/runtime/applyPatchUpdate.ts`

| 符号 | 当前职责 | 本次要求 |
|---|---|---|
| `deriveNewContentFromChunks` | 从 hunk 推导新内容；`filePath` 只用于 mismatch 文案 | 调用方必须传相对源路径；可选重命名为 `displayPath` |
| `buildSequenceMismatchError` | 生成 `Failed to find expected lines in ...` | 算法和模板可不改，输入必须相对 |

当前 `computeReplacements` 不执行任何文件系统访问，证明这里无需 `fullPath`。

### `apps/agent-worker/src/runtime/runner.ts`

| 符号 | 当前职责 | 本次要求 |
|---|---|---|
| `buildToolErrorText` | 将错误作为 tool text body | 不改 |
| `executeTool` 等 catch 分支 | 取 `err.message` 并写回 item | 不改 |

审查时若发现 Runner 新增 workspace 路径替换或 toolName 特判，应判定为超出设计。

## 测试代码

### `apps/agent-worker/src/runtime/fileTools.test.ts`

当前重点：

- `read 根路径缺失时仍失败并提示单个登记 repo 候选` 当前断言错误包含 `workspacePath`，必须翻转；
- `read repo 探测无候选或非法名称时保持原始错误` 需改为规范化错误；
- `read 对 ENOTDIR 根错误提示 repo 候选` 需断言相对路径；
- repo 排序、上限、symlink、取消、非缺失错误测试继续回归；
- write 已有 before/read 行为测试，可补最小成功输出和绝对输入拒绝断言。

### `apps/agent-worker/src/runtime/applyPatch.test.ts`

当前重点：

- `apply_patch 失败文本模板可稳定生成` 使用 `/tmp/workspace/a.txt` fixture，必须改为 `a.txt` 并断言绝对路径不出现；
- formatter / classifier 测试必须从已相对化的源错误开始，不得把“输入绝对路径后由 formatter 清洗”定义为预期行为；
- snapshot drift 系列测试应增加错误文本相对路径断言；
- 主问题直接修复测试：move 目标存在、context mismatch、新增覆盖、删除无 hunk、最终目标目录/symlink 等场景补 workspacePath 反向断言；
- 工具内补强测试：父组件 symlink、中间非目录组件单独断言相对组件路径；越界行为继续回归；
- 根据 helper 重构补 apply 阶段错误单测。

### `apps/agent-worker/src/runtime/runner.tool-output.test.ts`

`read 的 repo 路径提示错误仍以 failed 工具项持久化且没有 result` 必须验证：

- `output.error` 包含 `src/a.ts` 和 repo 候选；
- `output.error` 不含 `workspacePath`；
- `output.text` 不含 `workspacePath`；
- 状态仍为 failed，且无 result。

如现有 Runner 测试工具链能稳定触发 apply_patch 失败，建议增加一个最终格式化文本回归；若成本明显高，可由 `formatApplyPatchFailureTextFromMessage` 单测与 applyPatch 工具单测组合满足首期验收。

## 关联设计

- `docs/design/0001-read工具优化/`：repo path hint 的候选探测、排序、失败状态和重试语义继续适用；其“原始错误完整保留”条款由本设计覆盖。
- 本设计不修改其他 `0003`—`0009` 的 API/Worker 协议、生命周期或模块结构边界。

## 实施前搜索建议

以下命令用于发现候选点，结果需要人工区分执行路径和展示路径：

```bash
rg -n 'throw new Error|fullPath|fromFullPath|toFullPath|currentPath|deriveNewContentFromChunks' \
  apps/agent-worker/src/runtime/fileTools.ts \
  apps/agent-worker/src/runtime/applyPatch.ts \
  apps/agent-worker/src/runtime/applyPatchUpdate.ts
```

以下命令用于检查主动错误文案是否仍插入绝对变量：

```bash
rg -n 'throw new Error\(`[^`]*\$\{(?:params\.)?(?:fullPath|fromFullPath|toFullPath|currentPath)' \
  apps/agent-worker/src/runtime/applyPatch.ts
```

搜索结果为审查辅助，不替代测试；允许执行逻辑继续大量使用 `fullPath`。
