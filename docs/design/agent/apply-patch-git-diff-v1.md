# apply_patch: 统一采用 git unified diff 语法 (v1)

Status: draft

## 背景

`apply_patch` 是 Agent Workbench 用于对 workspace 中文本文件进行批量变更的工具。

现状(legacy)中 `apply_patch` 使用自定义 patch 协议(例如 `*** Begin Patch` / `*** Update File:` / `@@` chunk)，与开发者最常见的 `git diff`/unified diff 心智模型不一致，导致：

- 使用者(包括模型)经常直接粘贴 unified diff 而失败。
- 同一文件多段修改在 legacy 协议中需要重复 `*** Update File:`，与 unified diff 的“一个文件多个 `@@ ... @@` hunk”不一致，心智负担较高。

本方案目标是：**对外只提供一套语法体系：git unified diff(文本) 的常用子集**，以显著降低使用者心智负担；同时尽量复用现有的安全校验、两阶段执行(verify/apply)、以及 UI artifact 产出链路。

## 目标

- 对外(工具描述/参数描述/示例)只介绍 `git unified diff` 语法，不再要求用户学习自定义 patch 协议。
- 支持常见文本变更场景：
  - 多文件 diff
  - 单文件多个 `@@` hunk
  - 新增/删除/修改文本文件
  - rename/move(含 rename-only 与 rename+修改)
- 保持现有安全边界：
  - 路径必须为 workspace 内相对路径
  - 拒绝 symlink 路径/越界路径
  - verify 全通过后再 apply，避免部分写入
- 保持 apply_patch 的 UI artifact(before/after/summary/files) 输出语义不变(前端无需因语法切换而改动展示协议)。

## 非目标

- 不支持二进制补丁与高级 git patch 特性：
  - `GIT binary patch`
  - submodule diff
  - file mode/权限位变更
  - copy from/to 等高级元数据
- 不保证与 `git apply` 完全一致的 fuzz/offset 行为(本方案优先可控与可诊断)。

## 范围与兼容性决策

### 输入语法(对外)

`apply_patch.patchText` 仅接受 **git unified diff(文本)**，以降低心智负担。

为了避免长期维护两套语法体系带来的成本，本方案建议：

- 对外说明、示例、错误提示均以 unified diff 为准。
- 代码层面：将 legacy 协议视为历史实现，后续可选择删除 legacy parser，或仅保留为内部兼容(不对外宣传)。

> 注：是否保留 legacy parser 属于实现细节/迁移策略。本方案文档仅定义“对外语法”与支持范围。

### 支持子集(推荐第一期必须支持)

- 修改文件：
  - 识别 `--- a/<path>` 与 `+++ b/<path>`
  - 识别一个文件内多个 `@@ -a,b +c,d @@` hunks
  - 识别 hunk 行前缀：
    - `' '` context
    - `'+'` add
    - `'-'` delete
- 新增文件：`--- /dev/null` + `+++ b/<path>`
- 删除文件：`--- a/<path>` + `+++ /dev/null`
- 重命名/移动：
  - `rename from <old>` / `rename to <new>`
  - 支持 rename-only(无 `@@` hunks)
  - 支持 rename + 内容变更(含 hunks)
- 允许出现并忽略的常见元信息(不影响内容应用)：
  - `diff --git ...`
  - `index ...`
  - `new file mode ...` / `deleted file mode ...`
  - `\ No newline at end of file`

### 关键约束(降低意外与保证可控)

- 新增文件不允许覆盖已存在路径。
  - 若 diff 表示新增文件，但目标路径已存在：直接报错。
  - 目的：避免“new file”语义被误用为覆盖写入，从而产生高风险副作用。
- 仅处理文本文件。
  - 遇到 `GIT binary patch`：直接报错并提示改用 `write` 或提供文本。

## 内部实现策略(复用现有分层)

### 现有分层(保持不变)

- `prepare` 阶段：解析 + 安全校验 + 推导变更结果(before/after) + 生成 operations。
- `apply` 阶段：在 verify 全通过后落盘，避免部分写入。

### 解析层替换为 unified diff

实现上建议新增/替换为 `parseUnifiedDiffPatchText(patchText)`，输出仍为内部 hunks 列表(逻辑等价于现有 `Hunk[]`)：

- `AddFileHunk`：表示新增文件
- `DeleteFileHunk`：表示删除文件
- `UpdateFileHunk`：表示修改文件，包含 `chunks: UpdateFileChunk[]`
  - 一个 unified diff 的 `@@ ... @@` hunk 映射为一个 `UpdateFileChunk`
  - hunk 内的 `' '`/`'+'`/`'-'` 行用于构造 `oldLines/newLines`

重命名建议映射为：

- rename-only：生成专用的 move 操作(无需伪造空 chunk)
- rename + 修改：使用 `UpdateFileHunk { path: oldPath, movePath: newPath, chunks }`

### 失败与可修复错误提示

为降低使用者心智负担，失败信息应尽量可操作：

- 指出失败文件路径与 hunk header(`@@ -a,b +c,d @@`)
- 指出失败原因分类：上下文不匹配/文件不存在/路径不安全/不支持 binary/submodule
- 给出修复建议：
  - 基于当前 workspace 重新生成 diff
  - 增加上下文行数(例如 `git diff -U5`)
  - 拆分 patch(单文件/更小 hunk)

## 工具介绍提示词(新版)

本节定义对外公开的工具描述与参数描述(作为系统提示词的一部分)，确保使用者只需掌握 unified diff。

### tool description: apply_patch

建议文案(可直接用于 API tool description):

- 用 git unified diff(文本) 批量修改工作区文件。
- 支持: 修改/新增/删除文本文件；多文件 diff；单文件多个 @@ hunk；rename/move(含 rename-only)。
- 不支持: 二进制补丁(GIT binary patch)、submodule、symlink/越界路径、新增文件覆盖已存在文件。
- 失败提示: 若应用失败(上下文不匹配),请基于当前工作区重新生成 diff,或增加上下文行数(例如 git diff -U5)。

最小示例:

```diff
diff --git a/src/foo.txt b/src/foo.txt
index 1111111..2222222 100644
--- a/src/foo.txt
+++ b/src/foo.txt
@@ -1,1 +1,1 @@
-old
+new
```

### input schema: apply_patch.patchText

建议文案(用于 patchText 的 schema description):

- `patchText` 是 git unified diff(文本) 字符串。
- 支持的语法子集: `diff --git`/`---`/`+++`/`@@` hunks, 行前缀 `' '`/`'+'`/`'-'`，新增/删除文件(/dev/null)，rename from/to。
- 限制: 仅文本；拒绝 binary/submodule；路径必须在 workspace 内且拒绝 symlink；新增文件不覆盖已存在路径。

## 测试与验收建议(概要)

- unified diff:
  - 单文件单 hunk
  - 单文件多 hunk
  - 多文件
  - add file
  - delete file
  - rename-only
  - rename + modify
- 失败路径:
  - 新增文件但目标已存在
  - 上下文不匹配
  - binary patch
  - 越界路径
  - symlink 路径

## 相关文档

- apply_patch UI artifacts 与稳定 artifact 路径: `./apply-patch-ui-artifacts-and-stable-artifact-paths.md`
- apply_patch prompt projector 方案(legacy): `./apply-patch-prompt-projector-plan.md`
