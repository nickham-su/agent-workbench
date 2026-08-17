# apply_patch: 仅保留 unified diff，并增强错误提示 (v1)

Status: draft

## 背景

当前 `apply_patch` 的实现处于“对外只宣传 unified diff、但内部仍保留 legacy parser”的过渡状态。

现状代码中：

- `apps/agent-worker/src/runtime/applyPatch.ts`
  - 仍保留 legacy patch 语法相关常量与解析逻辑：
    - `*** Begin Patch`
    - `*** Update File:`
    - `*** Add File:`
    - `*** Delete File:`
    - `*** Move to:`
  - `parseAnyPatchText()` 会在 unified diff parser 与 legacy parser 之间做分流。
- `apps/agent-worker/src/runtime/applyPatchUpdate.ts`
  - 在上下文不匹配时，只返回“expected lines”，但不返回目标文件附近的实际内容。

这导致两个问题：

1. **语法错误提示不够直接**
   - 当调用方误用了 legacy patch 方言时，失败信息可能表现为底层 hunk 解析错误，例如：
     - `Invalid line in update hunk ...`
   - 这类提示无法清楚表达“问题根因是 patch 方言错误，而不是 hunk 内容本身有问题”。

2. **上下文不匹配时，诊断信息不足**
   - 当前报错通常只包含：
     - 文件路径
     - hunk header（部分场景）
     - expected lines
   - 但不会告诉调用方：
     - 实际搜索从哪里开始
     - 目标文件附近的真实内容是什么
     - 是否存在看起来接近的候选位置
   - 这会迫使调用方额外调用 `read` / `sed` 再定位问题。

本方案目标是：

- **彻底移除 legacy parser，只保留 unified diff 一套语法体系**
- **把错误提示优化为“自然语言、可直接指导下一步行动”的形式**

## 目标

- 运行时只接受 **git unified diff(文本)**。
- 删除 legacy parser 及其相关常量、分支与测试，降低维护成本。
- 在检测到 legacy patch 方言时，直接报出明确、自然语言的格式提示。
- 在上下文不匹配时，错误信息中增加：
  - 搜索起始行
  - 期望块(expected block)
  - 附近真实内容(nearby actual lines)
  - 重新生成 patch 的建议
- 保持现有安全边界、两阶段 verify/apply 流程、artifact 输出协议不变。

## 非目标

- 不引入结构化错误码；错误提示主要面向大语言模型与人工阅读，自然语言足够清晰即可。
- 不支持 legacy patch 输入的自动转换。
- 不做更激进的 fuzzy apply / offset apply；仍以“安全、可诊断、可控”为优先。
- 不改变 `apply_patch` 的成功输出结构。

## 设计结论

### 1. 输入语法唯一化：只支持 unified diff

`apply_patch.patchText` 在运行时只接受 unified diff。

具体语义：

- 支持：
  - `diff --git ...`
  - `---` / `+++`
  - `@@ ... @@`
  - `rename from` / `rename to`
  - `/dev/null`
  - 常见可忽略元信息（如 `index` / `new file mode` / `deleted file mode` / `\ No newline at end of file`）
- 不支持：
  - legacy patch 方言（`*** Begin Patch` 等）
  - binary patch
  - submodule
  - 其它超出当前 unified diff 子集的高级特性

### 2. 检测到 legacy patch 时，直接给清晰提示

当输入文本明显呈现 legacy patch 风格时，不再尝试走 legacy parser，也不再把错误暴露成底层 hunk 解析失败。

而是直接报出明确提示，例如：

> apply_patch only supports git unified diff.  
> Detected legacy patch format like `*** Begin Patch` / `*** Update File:`.  
> Please rewrite the patch using unified diff lines such as:  
> `diff --git a/<path> b/<path>`  
> `--- a/<path>`  
> `+++ b/<path>`  
> `@@ -old,+new @@`

该提示的核心要求：

- 首句明确“只支持 unified diff”
- 明确指出“检测到了 legacy patch 风格”
- 给出最小可仿写示例

### 3. 上下文不匹配时，返回附近真实内容

当 unified diff 解析成功，但在 verify/apply 阶段找不到 `oldLines` 对应片段时，错误提示应从当前的：

> Failed to find expected lines in <filePath> ...

增强为至少包含以下信息：

- 文件路径
- hunk header（若存在）
- 搜索起始行
- 期望块(expected block)
- 附近真实内容(nearby actual lines)
- 重新生成 patch 或增加上下文的建议

推荐错误格式：

```text
Failed to find expected lines in apps/api/src/foo.ts
Hunk: @@ -120,7 +120,9 @@
Search started from line 118.

Expected block:
const x = 1;
const y = 2;

Nearby actual lines:
116| const x = 1
117| const z = 2
118| const y = 3
119| ...

Tip: re-read the target file and regenerate the patch with more accurate context, or increase unified diff context lines (for example: git diff -U5).
```

## 现有实现定位

### `apps/agent-worker/src/runtime/applyPatch.ts`

当前相关实现：

- legacy parser:
  - `parsePatchText()`
  - `parseOneHunk()`
  - `parseUpdateFileChunk()`
- unified diff parser:
  - `parseUnifiedDiffPatchText()`
- 分流入口：
  - `parseAnyPatchText()`

当前问题点：

- `parseAnyPatchText()` 仅通过首行是否等于 `*** Begin Patch` 决定是否走 legacy parser。
- 这意味着：
  - 某些 legacy patch 变体无法被明确识别
  - 错误可能落入更底层，变成不够友好的 hunk 报错
- 文件中仍残留大量 legacy 常量与逻辑，增加维护负担。

### `apps/agent-worker/src/runtime/applyPatchUpdate.ts`

当前相关实现：

- `computeReplacements()`
- `seekSequence()`
- mismatch 报错：
  - `Failed to find expected lines in ...`

当前问题点：

- 报错只包含 expected lines
- 不包含搜索起始位置与附近实际内容
- 需要额外 read 文件才能定位

## 详细改造方案

## A. 删除 legacy parser

### 删除范围

从 `apps/agent-worker/src/runtime/applyPatch.ts` 中删除：

- 常量：
  - `BEGIN_PATCH_MARKER`
  - `ADD_FILE_MARKER`
  - `DELETE_FILE_MARKER`
  - `UPDATE_FILE_MARKER`
  - `MOVE_TO_MARKER`
  - `EOF_MARKER`
  - `CHANGE_CONTEXT_MARKER`
  - `EMPTY_CHANGE_CONTEXT_MARKER`
- 函数：
  - `parsePatchText()`
  - `checkPatchBoundariesLenient()`
  - `checkPatchBoundariesStrict()`
  - `parseOneHunk()`
  - `parseUpdateFileChunk()`
- `parseAnyPatchText()` 中对 legacy parser 的分流逻辑

保留：

- `END_PATCH_MARKER`
  - 仅用于兼容“unified diff 尾部多余一行 `*** End Patch`”的宽容处理
- `stripTrailingEndPatchMarkerForUnifiedDiff()`
  - 继续保留该宽容逻辑

### 入口策略

将 `parseAnyPatchText()` 改造成：

1. 空输入 -> 直接报错
2. 先执行“方言探测”
3. 如果检测到 legacy patch -> 直接报清晰提示
4. 否则统一按 unified diff 解析

推荐新增函数：

- `detectPatchDialect(input)`
  - 返回：`"legacy" | "unified" | "unknown"`

推荐探测规则：

- 识别为 `legacy` 的信号：
  - 首个非空行是 `*** Begin Patch`
  - 或首个非空行以 `*** Update File:` / `*** Add File:` / `*** Delete File:` 开头
- 识别为 `unified` 的信号：
  - 首个非空行以 `diff --git ` / `--- ` / `rename from ` / `rename to ` 开头
- 其它情况为 `unknown`

### legacy 报错文案

建议固定为一段高信噪比文本，不依赖下层 parser：

```text
apply_patch only supports git unified diff.
Detected legacy patch format like '*** Begin Patch' / '*** Update File:'.
Please rewrite the patch using unified diff lines such as:
diff --git a/<path> b/<path>
--- a/<path>
+++ b/<path>
@@ -old,+new @@
```

如果希望更中文化，也可以在末尾追加一行：

- `请改用 git diff / unified diff 常见格式重新生成补丁。`

## B. 增强上下文不匹配的错误提示

### 目标

在 `apps/agent-worker/src/runtime/applyPatchUpdate.ts` 中，所有“找不到上下文/找不到 expected lines”的报错，都应尽量附带定位信息。

### 建议新增辅助函数

#### 1) `buildNearbyContextExcerpt(...)`

职责：

- 从 `originalLines` 中截取一段附近真实内容
- 带 1-based 行号输出

建议输入：

- `originalLines: string[]`
- `startLineIndex: number`
- `maxLines?: number`
- `beforeLines?: number`

建议输出示例：

```text
116| const x = 1
117| const z = 2
118| const y = 3
119| export {}
```

建议默认值：

- `beforeLines = 3`
- `maxLines = 12`

#### 2) `findAnchorCandidateLineIndexes(...)`

职责：

- 在 expected block 无法精确匹配时，尝试找几个“看起来最接近”的候选位置
- 供错误提示使用，不参与自动 patch 应用

建议策略：

- 从 `pattern(oldLines)` 中选一个 anchor line：
  - 第一个非空、trim 后非空的行
- 对目标文件逐行做轻量归一化比较：
  - `trim()`
  - `normalizePunctuation(...)`
- 返回前 1~3 个命中位置

用途：

- 若找到了候选位置，则在错误中优先展示候选窗口
- 若没找到候选位置，则退回展示 `lineIndex` 附近窗口

### 具体报错增强点

#### 1) `chunk.changeContext` 未命中

当前：

- `Failed to find context '...' in <filePath>`

建议改成：

```text
Failed to find context '<context>' in <filePath>
Hunk: @@ ... @@
Search started from line X.

Nearby actual lines:
...

Tip: re-read the target file and regenerate the patch with more accurate context, or increase unified diff context lines (for example: git diff -U5).
```

#### 2) `oldLines` 未命中

当前：

- `Failed to find expected lines in <filePath> ...`

建议改成：

```text
Failed to find expected lines in <filePath>
Hunk: @@ ... @@
Search started from line X.

Expected block:
...

Nearby actual lines:
...

Tip: re-read the target file and regenerate the patch with more accurate context, or increase unified diff context lines (for example: git diff -U5).
```

### 关键注意事项

- “附近真实内容”必须做行数与字符数控制，避免错误消息过长。
- 候选窗口只作为诊断信息，不参与自动模糊应用，避免引入不可控副作用。
- 保留现有 `sourceHunkHeader`，以便错误提示包含原始 `@@ ... @@`。

## C. 保持 runner 层包装方式不变

`apps/agent-worker/src/runtime/runner.ts` 当前会把 prepare 阶段异常包装为：

- `apply_patch verification failed: <message>`

这层包装可以保留。

本方案只要求被包装进去的底层 message 更清晰。

因此无需改动：

- `runner.ts` 的错误包装协议

只需确保 `applyPatch.ts` / `applyPatchUpdate.ts` 抛出的 message 已经足够好。

## 测试方案

## A. 删除/调整 legacy 相关测试

文件：`apps/agent-worker/src/runtime/applyPatch.test.ts`

当前若仍有针对 legacy parser 的测试，应按以下策略处理：

- 删除“legacy patch 语法仍可成功应用”的测试
- 保留“unified diff 尾部多余 `*** End Patch` 仍可宽容”的测试
- 保留“context 行中出现 ` *** End Patch` 不应被错误剥离”的测试

## B. 新增格式识别测试

建议新增：

### 用例 1：`*** Begin Patch` 直接报 unified diff 提示

输入：

- 一个典型 legacy patch 文本

断言错误消息包含：

- `only supports git unified diff`
- `Detected legacy patch format`
- `*** Begin Patch`

### 用例 2：`*** Update File:` 开头的变体也能识别为 legacy

输入：

- 不带 `*** Begin Patch`，但首个非空行为 `*** Update File: ...`

断言错误消息包含：

- `only supports git unified diff`
- `Detected legacy patch format`

## C. 新增上下文不匹配诊断测试

建议新增：

### 用例 3：expected lines 未命中时包含 nearby actual lines

断言错误消息包含：

- `Failed to find expected lines in`
- `Search started from line`
- `Expected block:`
- `Nearby actual lines:`
- `Tip: re-read the target file`

### 用例 4：changeContext 未命中时也包含 nearby actual lines

断言错误消息包含：

- `Failed to find context`
- `Search started from line`
- `Nearby actual lines:`

## D. 保持原有 unified diff 成功用例继续通过

必须确保以下现有能力不回归：

- 单文件单 hunk
- 单文件多个 hunk
- 多文件
- add file
- delete file
- rename-only
- rename + modify
- old-style unified diff（仅 `---/+++`，无 `diff --git`）
- 尾部多余 bare `*** End Patch` 宽容

## 实施步骤建议

### 第一步：删 legacy parser，保留 unified diff 单一路径

- 新增 `detectPatchDialect()`
- 改造 `parseAnyPatchText()`
- 删除 legacy parser 代码与未使用常量
- 跑 `applyPatch.test.ts`

### 第二步：增强 mismatch 报错

- 在 `applyPatchUpdate.ts` 中新增 excerpt/candidate 辅助函数
- 改造 `computeReplacements()` 的两类失败报错
- 补齐新测试

### 第三步：同步工具说明（如有需要）

虽然当前工具描述已以 unified diff 为主，但建议再检查：

- `apps/api/src/modules/agent/agent.service.ts`
  - `toolDescription("apply_patch")`
  - `toolArgsSchema("apply_patch")`

确认提示词中不再保留任何可能暗示 legacy patch 可用的内容。

## 预期收益

- 对外语法体系彻底单一，减少维护与心智负担。
- legacy patch 误用时，能第一时间得到正确方向的反馈。
- context mismatch 时，模型无需额外读文件即可获得更高质量的诊断信息。
- 后续迭代 unified diff 支持子集时，代码路径更短、更稳定。

## 相关文档

- `./apply-patch-git-diff-v1.md`
- `./tools.md`
- `./tool-output-text-unification-and-artifacts.md`
