# Workspace 共享 Editor 工具与右上固定编辑区方案（v1）

Status: draft

## 背景

- 当前 Workspace 页面已有多个工具会直接或间接展示文件内容:
  - `files`：目录树 + tabs + Monaco 编辑器 + 文件管理
  - `codeReview`：文件列表 + 内嵌 diff
  - `terminal`：识别 `path:line` 后跳转到 `files`
  - `search`：命中项点击后跳转到 `files`
  - `agent`：`write` / `apply_patch` 卡片内嵌 Monaco 预览与 diff
- 现状存在几个结构性问题:
  - 文件展示能力分散在多个工具中,职责边界不清晰
  - 工具之间相互调用时,容易发生“切走当前视图”或“内容被另一个工具覆盖”的交互问题
  - `files` 工具过重,同时承担“文件系统管理”和“内容编辑器”两类职责
  - Agent 消息流中内嵌 Monaco,使消息区变重,也不利于统一的文件查看体验
- 当前仓库前端已经具备两项关键基础:
  - Workspace 工具注册 + 三分区 dock 布局 + 工具间 `host.call(...)` 调用机制
  - 共享 Monaco 组件:
    - `apps/web/src/shared/components/MonacoCodeViewer.vue`
    - `apps/web/src/shared/components/MonacoDiffViewer.vue`

本项目尚未上线。

- 本方案不考虑兼容旧布局、旧持久化数据或旧交互约束。
- 可以直接重定义 Workspace 的区域语义与工具职责。

## 目标

- 在 Workspace 内新增一个共享 `editor` 工具,作为唯一的内容查看与编辑承载区。
- 重新定义 Workspace 的三分区语义:
  - 左上：导航/列表工具区
  - 右上：Editor 编辑区（固定且独占）
  - 下方：过程工具区
- 去掉右侧工具栏,右上不再允许普通工具驻留。
- 统一其他工具的“打开内容”行为:
  - `files` 打开文件 -> `editor`
  - `search` 命中跳转 -> `editor`
  - `terminal` 路径点击 -> `editor`
  - `codeReview` 查看 diff -> `editor`
  - `agent` 的 `write` / `apply_patch` 结果预览 -> `editor`
- 保留 `files` 工具的文件系统管理职责:
  - 新建文件/目录
  - 重命名
  - 删除
  - 上传
  - 下载
- 当 `editor` 没有任何打开 tab 时,右上区域自动收起,将空间让给其他工具。
- 当任意工具再次调用 `editor` 时,右上区域自动恢复并显示目标内容。

## 非目标

- 不在本方案中引入新的后端文件协议或重做现有 workspace files API。
- 不在本方案中实现多窗口协作编辑、文件系统实时监听、多人冲突协作。
- 不实现 VS Code 式复杂工作台（分组编辑器、多列编辑器、多 diff 同屏）。
- 不要求把 Monaco 编辑能力抽象为“完全通用的共享 Vue 组件”。
  - 本方案的“共享”核心是共享 `editor` 工具与统一调用协议。
  - 只读预览 / diff 继续复用现有共享组件。
  - 可编辑文件 tab 可先由 `editor` 工具内部直接管理 Monaco 实例。
- 不做兼容旧的 `files.openAt` 对外协议。
  - 最终代码以 `editor.*` 协议为准。
  - 开发过程中的临时适配可存在,但合入前应清理。

## 已确认的产品决策

### 布局决策

- Workspace 保留三分区:
  - `leftTop`
  - `rightTop`
  - `leftBottom`
- 其中 `rightTop` 固定为 `editor` 专属区域。
- 右侧工具栏整体删除。
- 其他所有工具仅允许位于:
  - `leftTop`
  - `leftBottom`
- `editor` 无 tab 时自动最小化/收起,使右上区域不占空间。
- 任意工具调用 `editor` 时,自动恢复右上区域并显示目标内容。

### 工具职责决策

- `files`
  - 保留目录树与文件管理动作
  - 不再展示文件内容
  - 不再持有编辑器 tabs / Monaco model / 保存逻辑
- `editor`
  - 统一承载文件编辑、只读预览、diff 展示
  - 支持多 tab
- `codeReview`
  - 只保留变更文件列表与 Git 操作
  - 文件内容与 diff 转交 `editor`
- `search`
  - 仅展示搜索结果,点击后转交 `editor`
- `terminal`
  - 保持终端能力,点击路径后转交 `editor`
- `agent`
  - `write` / `apply_patch` 卡片只保留摘要与操作入口
  - 实际预览/diff 转交 `editor`

### 交互决策

- `editor` 支持多 tab。
- 关闭最后一个 tab 时,`editor` 自动收起。
- 编辑型 tab 若存在未保存修改,关闭时需二次确认。
- 只读预览 tab / diff tab 关闭时无需确认。
- `codeReview` 点击文件默认在 `editor` 中打开 diff,而不是普通文件视图。
- `files` 保留文件管理动作,这些动作成功后需要与 `editor` 做状态同步。

## 术语与区域语义

### 区域语义

- `leftTop`
  - 导航/列表工具区
  - 典型工具: `files` / `search` / `codeReview`
- `rightTop`
  - 内容查看与编辑区
  - 仅允许 `editor`
- `leftBottom`
  - 过程/会话工具区
  - 典型工具: `terminal` / `agent`

### 工具类型分层

- 导航类工具
  - 用户在其中“选择目标”
  - 如文件节点、搜索命中、变更文件列表
- 内容类工具
  - 用户在其中“查看或编辑目标”
  - 本方案中唯一内容类工具为 `editor`
- 过程类工具
  - 用户在其中“执行动作或观察过程”
  - 如 `terminal`、`agent`

## 整体交互模型

### 核心原则

- “选择什么”与“看什么/改什么”分离。
- 其他工具不再内嵌文件内容承载区。
- 所有内容查看都指向固定的右上 `editor`。
- `editor` 是 Workspace 内的统一内容出口。

### 典型流程

#### Files -> Editor

- 用户在 `files` 中点击/双击文件
- `files` 保持在左上
- `editor` 在右上打开对应文件 tab
- 若 `editor` 当前收起,自动展开

#### Search -> Editor

- 用户在 `search` 中点击命中块
- `editor` 打开对应文件并跳转到命中行/高亮范围
- `search` 结果列表保持不变

#### Terminal -> Editor

- 用户在终端中点击 `path:line`
- `terminal` 保持在下方
- `editor` 在右上打开文件并跳转行号

#### CodeReview -> Editor

- 用户在代码审查列表中点击文件
- `codeReview` 仍停留在左上
- `editor` 打开 diff tab

#### Agent -> Editor

- 用户在 Agent 消息流中点击 `write` / `apply_patch` 摘要项
- `agent` 保持在下方
- `editor` 打开预览或 diff tab

### 体验收益

- 调用方工具不会因为打开内容而被覆盖。
- 左上/下方工具可以稳定保留上下文。
- 右上始终承载“当前查看内容”,心智一致。
- 无文件打开时,右上可自动收起,避免长期占空间。

## 方案总览

## 1. Workspace 布局调整

### 1.1 ToolId 与工具注册

当前 `ToolId` 为:

```ts
"codeReview" | "terminal" | "files" | "search" | "agent"
```

调整为:

```ts
"codeReview" | "terminal" | "files" | "search" | "agent" | "editor"
```

对应位置调整:

- `apps/web/src/features/workspace/types.ts`
- `apps/web/src/features/workspace/views/WorkspaceLayout.vue`

### 1.2 工具允许区域

最终建议:

- `editor`
  - `defaultArea: "rightTop"`
  - `allowedAreas: ["rightTop"]`
- `files`
  - `allowedAreas: ["leftTop", "leftBottom"]`
- `search`
  - `allowedAreas: ["leftTop", "leftBottom"]`
- `codeReview`
  - `allowedAreas: ["leftTop", "leftBottom"]`
- `terminal`
  - `allowedAreas: ["leftTop", "leftBottom"]`
- `agent`
  - `allowedAreas: ["leftTop", "leftBottom"]`

说明:

- 非 `editor` 工具彻底禁止进入 `rightTop`。
- 不再需要保留“普通工具也可移到右上”的兼容逻辑。

### 1.3 工具栏调整

- 删除 `WorkspaceDock.vue` 中右侧工具栏 DOM 与相关 props:
  - `rightToolbarToolIds`
- `WorkspaceLayout.vue` 中删除:
  - `rightToolbarToolIds` 计算
  - 右侧 icon 工具切换相关传参
- `rightTop` 仍保留作为布局区域,但不再有 toolbar 概念。
- `editor` 的显示由:
  - 工具调用自动唤起
  - 有无 tab 自动决定是否收起

### 1.4 右上区域收起/恢复规则

- `editor` 工具默认可处于 minimized 状态。
- 当 `editor` 没有任何 tab 时:
  - 自动调用 `host.minimizeTool("editor")`
  - 右上区域隐藏
  - 左上独占上方区域宽度
- 当任意工具调用 `editor` 时:
  - Workspace 通过现有 `call` 揭示策略自动取消最小化
  - 右上区域恢复
- 左右分割比例继续沿用现有本地存储逻辑。
  - `editor` 收起后不清除比例
  - 再次打开时恢复到上次比例

### 1.5 Header 与红点

- 右侧工具栏删除后,`editor` 不再需要 toolbar icon 红点。
- `files` 原先“未保存文件红点”语义应迁移给 `editor` 内部 tab 标记,而不是继续挂在 `files` 上。
- 本方案中:
  - `files` 不再承载“未保存编辑”的工具级红点
  - `editor` 的 dirty 状态仅通过 tab UI 表达
- `codeReview` 等仍可保留已有红点机制（如果左侧/下方有工具栏入口）。

## 2. Editor 工具设计

### 2.1 目标能力

`editor` 提供三类能力:

- 文件编辑
  - 基于 workspace 相对路径打开文件
  - 支持跳行与高亮
  - 支持保存/冲突处理
- 文件预览（只读）
  - 基于文件路径预览
  - 或直接预览一段文本
- diff 视图
  - 对比 `original` / `modified`
  - 支持 path/title/language 等辅助信息

### 2.2 推荐目录结构

新增目录:

- `apps/web/src/features/workspace/tools/editor/EditorToolView.vue`
- `apps/web/src/features/workspace/tools/editor/EditorTabs.vue`
- `apps/web/src/features/workspace/tools/editor/runtime.ts`
- `apps/web/src/features/workspace/tools/editor/store.ts`
- `apps/web/src/features/workspace/tools/editor/types.ts`

可选抽离（按实现需要决定）:

- `apps/web/src/features/workspace/tools/editor/fileModel.ts`
- `apps/web/src/features/workspace/tools/editor/path.ts`
- `apps/web/src/features/workspace/tools/editor/openAt.ts`

### 2.3 Tab 模型

建议统一建模:

```ts
type EditorTab = FileEditorTab | PreviewEditorTab | DiffEditorTab;

type EditorTabBase = {
  key: string;
  title: string;
  kind: "file" | "preview" | "diff";
  activeLabel?: string;
};

type FileEditorTab = EditorTabBase & {
  kind: "file";
  path: string;
  language?: string;
  previewable: boolean;
  reason?: "too_large" | "binary" | "decode_failed" | "unsafe_path" | "missing";
  version?: FileVersion;
  model?: monaco.editor.ITextModel;
  savedContent: string;
  dirty: boolean;
  saving: boolean;
  pendingSave: boolean;
  conflictOpen?: boolean;
  error?: string;
  openAt?: {
    line?: number;
    column?: number;
    reveal?: "center" | "top";
    highlight?:
      | { kind: "none" }
      | { kind: "line" }
      | { kind: "range"; startCol: number; endCol: number };
  };
};

type PreviewEditorTab = EditorTabBase & {
  kind: "preview";
  path?: string;
  text: string;
  language?: string;
  readOnly: true;
  source?: string;
};

type DiffEditorTab = EditorTabBase & {
  kind: "diff";
  path?: string;
  original: string;
  modified: string;
  language?: string;
  source?: string;
  readOnly: true;
};
```

### 2.4 key 规则

建议统一 key 策略:

- 文件编辑 tab:
  - `file:${path}`
- 文件只读预览 tab:
  - 若有 path: `preview:path:${path}`
  - 若无 path: 使用调用方传入的 `tabKey`
- diff tab:
  - 优先使用调用方传入的 `tabKey`
  - 否则退化为 `diff:${path ?? title}`

理由:

- 文件 tab 应天然复用,避免同一路径重复打开多个编辑 tab。
- diff/preview 由不同来源触发时,是否复用应交给调用方决定。
- 例如:
  - `codeReview` 同一路径可复用一个 diff tab
  - `agent` 的不同 `toolCallId` 应产生不同 diff tab

### 2.5 文件编辑实现策略

建议将当前 `files` 中与 Monaco 编辑相关的能力迁移到 `editor`:

- 打开文件 -> 读取 workspace 文件内容
- 创建 model
- dirty 计算
- `Ctrl/Cmd+S` 保存
- reload
- 409 冲突处理
- `openAt` 高亮 / reveal
- 非 previewable 文件兜底展示

对应现有逻辑主要来源于:

- `apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.vue`
- `apps/web/src/features/workspace/tools/file-explorer/types.ts`

建议迁移方式:

- 先整体复制可复用逻辑到 `editor`
- 再从 `files` 中删除 tabs/editor/save 相关代码
- 最后按需抽公共 util

不建议一开始就过度抽象成“通用可编辑 Monaco 组件”,避免把迁移复杂度与抽象复杂度叠加。

### 2.6 关闭策略

- 关闭 file tab:
  - 若 `dirty === true`,弹窗确认
  - 若确认关闭,销毁 model/disposable
- 关闭 preview/diff tab:
  - 直接关闭
- 关闭最后一个 tab:
  - 清空 activeTab
  - 触发 `host.minimizeTool("editor")`

### 2.7 保存策略

沿用当前 workspace 文件编辑行为:

- `Ctrl/Cmd+S`
- 可选保留 blur 自动保存（建议从现有逻辑迁移后再决定是否继续暴露）
- 冲突时继续复用当前 409 弹窗语义:
  - 重新加载
  - 强制覆盖

建议:

- v1 先保留 `Ctrl/Cmd+S` 与显式保存按钮
- blur 自动保存可保留,但应在迁移完成后做一次专项回归
- 若迁移期风险较高,可先临时关闭 blur 自动保存,待 editor 稳定后再恢复

## 3. Editor 调用协议

### 3.1 协议命名

不再使用 `files.openAt` 作为统一文件展示协议。

新增 `editor.*` 系列 call:

- `editor.openFile`
- `editor.openPreview`
- `editor.openDiff`

### 3.2 editor.openFile

用途:

- 打开一个 workspace 相对路径文件
- 可编辑或只读
- 可选跳转行号/高亮范围

建议 payload:

```ts
{
  path: string;
  line?: number;
  column?: number;
  reveal?: "center" | "top";
  highlight?:
    | { kind: "none" }
    | { kind: "line" }
    | { kind: "range"; startCol: number; endCol: number };
  mode?: "edit" | "preview";
  targetDirName?: string;
  title?: string;
}
```

说明:

- `path` 为 workspace 相对路径。
- `mode` 默认 `edit`。
- `targetDirName` 作为路径上下文保留,便于未来扩展或处理 repo 语义。
- `line`/`highlight` 兼容当前 search/terminal 的行为。

### 3.3 editor.openPreview

用途:

- 只读预览一段文本或一个文件
- 适合 Agent、日志片段、write 新文件内容等场景

建议 payload:

```ts
{
  path?: string;
  text?: string;
  language?: string;
  title?: string;
  tabKey?: string;
}
```

约束:

- `path` 与 `text` 至少存在一个。
- 若提供 `path` 且未提供 `text`,则 `editor` 自行读取文件并以只读模式展示。
- 若提供 `text`,则直接展示调用方给出的文本。

### 3.4 editor.openDiff

用途:

- 打开 diff 视图
- 适合 codeReview、agent write/apply_patch 场景

建议 payload:

```ts
{
  original: string;
  modified: string;
  path?: string;
  language?: string;
  title?: string;
  tabKey?: string;
  source?: string;
}
```

说明:

- 文本直接走内存 payload,不要求由 `editor` 再次请求后端。
- `tabKey` 用于调用方控制“复用同一 diff tab”还是“创建新 diff tab”。

### 3.5 协议设计原则

- `call` 依旧是 event-only,不做返回值。
- 打开内容属于“用户意图驱动的揭示操作”,应使用 `host.call(...)`。
- 被动同步（如 rename/delete 后让 editor 内部修正 tab）不应强制揭示 editor,应走非 reveal 机制。

## 4. 被动同步机制（Files <-> Editor）

`files` 保留文件管理动作后,需要与 `editor` 进行状态同步,但这些同步不应每次都把右上区域拉出来。

因此建议区分两类通道:

### 4.1 reveal 型调用：继续使用 call

适用于:

- 用户明确要打开文件/预览/diff
- 需要把 `editor` 拉到前台

使用:

- `host.call("editor", { type: "editor.openFile", ... })`
- `host.call("editor", { type: "editor.openDiff", ... })`

### 4.2 passive 型同步：使用 tool event

适用于:

- 文件被重命名
- 文件被删除
- 文件上传完成
- 文件创建完成但并不要求一定拉出 editor

建议定义事件:

- `editor.fsRenamed`
- `editor.fsDeleted`
- `editor.fsCreated`
- `editor.fsUploaded`

事件 payload 建议:

```ts
// editor.fsRenamed
{ from: string; to: string }

// editor.fsDeleted
{ path: string }

// editor.fsCreated
{ path: string }

// editor.fsUploaded
{ paths: string[] }
```

使用方式:

- `files` 操作成功后通过 `host.emitToolEvent("editor", event)` 通知 editor
- `editor` 在 view/runtime 中消费并更新自身 store
- 该过程不触发 reveal

### 4.3 同步规则

- rename 文件:
  - 若 `editor` 已打开对应 file tab,更新 `path`、`title`、tab key 与 model URI（必要时重建 model）
- rename 目录:
  - 批量更新其子树内所有 file tab 的路径
  - preview/diff tab 若仅带 path 元信息,同步 title/path 即可
- delete 文件:
  - 若 tab 已打开,直接关闭
- delete 目录:
  - 关闭其子树下所有 file/preview/diff tab
- create/upload:
  - 默认不自动打开
  - 若创建动作是“用户明确希望立即编辑”,则 `files` 在成功后应主动调用 `editor.openFile`

## 5. 各工具迁移方案

## 5.1 Files 工具

### 保留能力

- 目录树展示
- 新建文件/目录
- 重命名
- 删除
- 上传/下载
- 刷新目录

### 移除能力

- tabs
- Monaco 编辑器
- 文件内容区
- save/reload/conflict 逻辑
- `files.openAt` runtime

### 交互变化

- 点击/双击文件节点:
  - 直接 `host.call("editor", { type: "editor.openFile", ... })`
- 新建文件成功:
  - 默认自动打开 editor 文件 tab
- 重命名/删除/上传成功:
  - 通过 passive event 通知 `editor`

### 重构收益

- `FileExplorerToolView.vue` 将从“树 + 编辑器大组件”收敛为“纯文件管理器”。
- 代码体量与维护复杂度明显下降。

## 5.2 Search 工具

当前:

- 调用 `files.openAt`

调整为:

- 调用 `editor.openFile`

映射规则:

- `path` 保持原样
- `line` / `highlight` / `reveal` 继续透传

预期结果:

- `search` 保持在左上或下方
- `editor` 在右上打开命中文件并高亮

## 5.3 Terminal 工具

当前:

- 点击 `path:line` 后最终调用 `files.openAt`

调整为:

- 保留现有路径解析、workspace 级 stat 校验、fallback 逻辑
- 仅将最终揭示动作改为 `editor.openFile`

优点:

- 终端保持在下方,不被文件打开动作覆盖
- 用户可以一边看终端输出,一边在右上查看对应文件

## 5.4 CodeReview 工具

### 调整前

- 左侧/上方为文件列表
- 右侧/下方内嵌 `MonacoDiffViewer`

### 调整后

- 仅保留文件列表、stage/unstage、discard、commit、push/pull 等 Git 行为
- 去掉内嵌 diff 面板
- 点击文件时调用 `editor.openDiff`

### diff 数据来源

`CodeReviewPanel.vue` 当前已经具备构建 compare 数据的能力,可继续复用:

- `compare.base.content`
- `compare.current.content`
- `compare.path`
- `compareLanguage`

点击时发送:

```ts
host.call("editor", {
  type: "editor.openDiff",
  payload: {
    original: compare.base.content,
    modified: compare.current.content,
    path: compare.path,
    language: compareLanguage,
    title: compare.path,
    tabKey: `codeReview:${compare.path}`,
    source: "codeReview"
  }
});
```

### UI 结果

- `codeReview` 从双栏结构变回单一列表型工具
- 复杂 diff 交由固定右上 `editor` 展示

## 5.5 Agent 工具

### write

当前:

- `AgentWriteCard.vue` 展开后内嵌 `MonacoCodeViewer` / `MonacoDiffViewer`

调整为:

- 卡片仅保留摘要、错误信息与“打开预览/打开 diff”入口
- 如果是新文件且 only-after:
  - 调 `editor.openPreview`
- 如果 before/after 都存在且可渲染 diff:
  - 调 `editor.openDiff`

### apply_patch

当前:

- `AgentApplyPatchCard.vue` 展开后逐文件内嵌 `MonacoDiffViewer`

调整为:

- 卡片仅保留文件列表摘要
- 点击某个文件时直接在 `editor` 打开该文件 diff
- `tabKey` 建议使用:
  - `agent:applyPatch:${toolCallId}:${path}`

### 好处

- Agent 消息列表明显变轻
- 虚拟列表测量压力降低
- 所有文件相关查看体验统一到右上 `editor`

## 6. WorkspaceLayout / Dock 具体改造点

### 6.1 WorkspaceLayout.vue

重点修改:

- `TOOL_IDS` 增加 `editor`
- `tools` 注册表增加 `editor`
- 删除右侧工具栏相关计算与传参
- 非 `editor` 工具的 `allowedAreas` 去掉 `rightTop`
- `toolViewProps("editor")` 增加 editor 所需 props
- `openTool/callFrom` 保持现有 reveal 机制
- `activeToolIdByArea.rightTop` 仅服务于 `editor`

建议约束:

- 初始状态 `toolMinimized.editor = true`
- `rightTop` 若无可见工具则为空
- `editor` 调用自动展开,关闭最后一个 tab 自动再次最小化

### 6.2 WorkspaceDock.vue

重点修改:

- 删除右侧 icon 栏 DOM
- 仍保留上方左右两列布局容器
- `rightTop` 仅渲染实际可见的 `editor` 视图
- 当右上无内容时,左上占满整行

### 6.3 host / runtime 机制

- 现有 `host.callFrom(...)` 机制可以直接复用
- 现有 `emitToolEvent + runtime.onEvent + 队列 flush` 机制可用于 passive 同步
- 不需要为了本方案重新发明新总线

## 7. Editor Store / Runtime 设计

### 7.1 store 职责

- 持有 tabs 列表与 activeTab
- 管理 file tab 对应 Monaco model 生命周期
- 维护 dirty / saving / error / version
- 处理 close / closeOthers / closeAll
- 提供 `hasTabs`、`hasDirtyTabs` 等派生状态

### 7.2 runtime 职责

- 接收 `editor.*` call 并更新 store
- 接收 passive event 并同步 tabs
- 控制在“无 tab”时自动触发收起
- 在 reveal 时确保 editor 准备好处理 openFile/openDiff

### 7.3 view 职责

- 渲染 tab 栏与主体区域
- file tab:
  - 绑定 Monaco standalone editor
- preview tab:
  - 复用 `MonacoCodeViewer`
- diff tab:
  - 复用 `MonacoDiffViewer`
- 关闭 tab 时按 tab 类型决定是否确认

### 7.4 editor 自收起机制

推荐实现:

- `EditorToolView.vue` 监听 `store.tabs.length`
- 当从 `>0` 变为 `0` 时调用 `host.minimizeTool("editor")`
- 不要求 Workspace 额外理解 `editor.hasTabs` 业务语义

理由:

- 复用现有“工具最小化 -> 区域收起”机制
- 改动最小
- 不需要新增 layout 与 tool 之间的反向状态通道

## 8. 是否需要后端改动

### 8.1 必要后端改动

本方案 v1 原则上**不需要新增后端接口**。

原因:

- 文件读取/写入/创建/删除/重命名/上传/下载,`files` 已经在使用现有 workspace files API
- `editor` 只需复用这些 API
- `codeReview` 当前已经能拿到 diff 比较文本
- `agent` 当前已有 artifact 拉取逻辑
- `terminal` 当前已有 workspace 级 stat 校验逻辑

### 8.2 可选后续优化

后续如果 `editor.openPreview` 需要按路径懒加载、或 `codeReview` 想按需请求 patch 文本,可再补接口。但不属于本期阻塞项。

## 9. 实施顺序（推荐）

### 阶段 1：布局与 editor 骨架落地

目标:

- 建立固定右上编辑区的骨架

任务:

- 新增 `editor` tool 注册
- 删除右侧工具栏
- 限制工具 allowedAreas
- 新建 `editor` 基础视图、tabs、空 store/runtime
- 验证:
  - `editor` 可被 `host.call()` 拉起
  - `editor` 无 tab 时可自动收起

### 阶段 2：先接入只读预览与 diff

目标:

- 先统一“展示能力”,再迁移“编辑能力”

任务:

- 实现 `editor.openPreview`
- 实现 `editor.openDiff`
- 接入:
  - `agent.write`
  - `agent.apply_patch`
  - `codeReview`
- 验证:
  - Agent/CodeReview 不再内嵌 Monaco
  - 右上 editor 可稳定打开预览/diff

### 阶段 3：接入 search / terminal

任务:

- `search` 从 `files.openAt` 改到 `editor.openFile`
- `terminal` 从 `files.openAt` 改到 `editor.openFile`
- 验证:
  - 命中高亮、跳行、reveal 行为与当前一致

### 阶段 4：迁移文件编辑能力

任务:

- 将当前 `files` 中的 tabs、model、save、conflict、reload 逻辑迁入 `editor`
- `editor.openFile(mode=edit)` 正式支持文件编辑
- `files` 删除右侧内容区,仅保留树与文件管理动作
- 新建文件成功后自动在 `editor` 中打开

这是整个方案中改动最大的一步,应独立验证。

### 阶段 5：补齐 Files <-> Editor 被动同步

任务:

- rename/delete/upload/create 的 editor 同步
- 目录 rename / delete 对已打开 tabs 的批量影响处理
- 关闭最后 tab 自动收起的交互打磨

### 阶段 6：清理旧逻辑

任务:

- 删除 `files.openAt` 相关 runtime/store 逻辑
- 删除 `files` 中不再需要的 Monaco 代码
- 删除 Agent / CodeReview 中遗留的内嵌预览逻辑
- 清理无用文案、i18n key、注释与 dead code

## 10. 涉及文件清单（建议）

### 10.1 必改文件

- `apps/web/src/features/workspace/types.ts`
- `apps/web/src/features/workspace/views/WorkspaceLayout.vue`
- `apps/web/src/features/workspace/components/WorkspaceDock.vue`
- `apps/web/src/features/workspace/host.ts`（若仅复用现有 API,可能无需改动）

### 10.2 新增 editor 文件

- `apps/web/src/features/workspace/tools/editor/EditorToolView.vue`
- `apps/web/src/features/workspace/tools/editor/EditorTabs.vue`
- `apps/web/src/features/workspace/tools/editor/runtime.ts`
- `apps/web/src/features/workspace/tools/editor/store.ts`
- `apps/web/src/features/workspace/tools/editor/types.ts`

### 10.3 需要迁移/精简的现有工具

- `apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.vue`
- `apps/web/src/features/workspace/tools/file-explorer/runtime.ts`
- `apps/web/src/features/workspace/tools/file-explorer/types.ts`
- `apps/web/src/features/workspace/tools/search/SearchToolView.vue`
- `apps/web/src/features/workspace/tools/terminal/TerminalView.vue`
- `apps/web/src/features/workspace/tools/code-review/CodeReviewPanel.vue`
- `apps/web/src/features/workspace/tools/agent/AgentWriteCard.vue`
- `apps/web/src/features/workspace/tools/agent/AgentApplyPatchCard.vue`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`（若需调整卡片交互与 props）

### 10.4 可复用共享组件

- `apps/web/src/shared/components/MonacoCodeViewer.vue`
- `apps/web/src/shared/components/MonacoDiffViewer.vue`

### 10.5 可能需要补的文案/i18n

- `apps/web/src/shared/i18n/locales/zh-CN.ts`
- `apps/web/src/shared/i18n/locales/en-US.ts`

## 11. 风险与取舍

### 11.1 最大风险：文件编辑逻辑迁移

原因:

- 当前 `files` 编辑能力与目录树深度耦合
- 包含 model 生命周期、dirty、保存、冲突、reload 等多种状态

策略:

- 分阶段迁移
- 先统一 preview/diff,后迁 edit
- 迁移前尽量保留现有保存行为与边界,减少同时变更多个变量

### 11.2 CodeReview 体验变化

风险:

- codeReview 不再内嵌 diff,用户需要把视线移动到右上

接受理由:

- 这是本方案的核心交互原则：列表与内容分离
- 固定右上 editor 能让整体认知更稳定

### 11.3 editor 无 icon 后的可发现性

风险:

- 右侧工具栏删除后,editor 无独立 toolbar 入口

接受理由:

- editor 主要由其他工具调用拉起
- 一旦有内容打开,其 tab 区会自然形成可见存在感
- 本方案的核心不是“手工打开 editor”,而是“任何内容都在右上展示”

### 11.4 大文本 payload

风险:

- `editor.openDiff` / `editor.openPreview` 可能携带较大文本

取舍:

- `call` 仅在前端内存中传递,不走网络持久化,本期可接受
- 对非常大的内容,调用方仍可采用“点击后先本地/远端拉取 artifact,再发 call”的按需加载策略

## 12. 测试与验证建议

### 12.1 布局行为

- Workspace 初始进入时右上默认收起
- 任意工具调用 editor 时右上展开
- 关闭最后一个 editor tab 时右上收起
- 右上再次展开时左右比例正确恢复
- 左上与下方工具切换不受 editor 打开影响

### 12.2 Files -> Editor

- 点击文件节点可在 editor 打开
- 新建文件后可自动打开到 editor
- rename/delete 后 editor 已打开 tab 同步正确
- 上传完成后 files 刷新正常,editor 不会被无意义拉起

### 12.3 Search / Terminal

- search 命中跳转:
  - 正确打开文件
  - 正确跳到命中行
  - 正确高亮范围
- terminal `path:line` 点击:
  - workspace 路径与 repo fallback 路径都可打开
  - terminal 面板保持不变

### 12.4 CodeReview

- 变更文件点击后在 editor 中打开 diff
- stage/unstage/discard/commit/push/pull 行为不回归
- codeReview 自身不再渲染 diff 面板

### 12.5 Agent

- `write` 卡片不再内嵌 Monaco
- `apply_patch` 卡片不再内嵌 Monaco
- 点击摘要/文件项可在 editor 打开预览/diff
- 长会话下消息列表测量与滚动表现不退化

### 12.6 Editor 编辑能力

- 打开文件、切换 tab、关闭 tab 正常
- dirty 标记正确
- `Ctrl/Cmd+S` 保存正确
- 409 冲突弹窗正确
- 非 previewable 文件兜底展示正确
- 关闭 dirty tab 时确认逻辑正确

## 13. 推荐实现细节与编码原则

- 优先复用现有 `WorkspaceHostApi`、runtime/store/view 三层结构。
- 不为本方案引入新的全局状态管理框架。
- 不过度抽象 Monaco 编辑器封装；先完成 editor 工具落地,再在收尾阶段评估是否有必要抽公共编辑器组件。
- 文件管理相关路径工具函数、tab key 计算、openAt 高亮逻辑可在重构中按需抽离,但不要先抽象后迁移。
- 所有“会改变布局展示”的动作都应走现有 reveal 语义,所有“仅同步内部状态”的动作都不应强行 reveal。

## 14. 最终建议

本方案建议按“先统一展示,再迁移编辑”的顺序推进:

1. 先落地固定右上 editor 与布局调整
2. 先把 Agent / CodeReview / Search / Terminal 全部接到 `editor`
3. 最后把 `files` 中的编辑能力整体迁出

这样可以用最小风险达成最大的体验统一收益。

一旦完成,Workspace 的长期心智模型将稳定为:

- 左上：导航与列表
- 右上：内容与编辑
- 下方：过程与会话

这将为后续继续扩展工具能力提供更清晰、可持续的结构基础。
