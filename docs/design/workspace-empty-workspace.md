# 空工作区(不绑定仓库)与允许解绑最后一个仓库的方案

## 需求背景

- 现状下,Workspace 的创建强绑定全局 Repo,且 Workspace 内至少需要保留 1 个 Repo.
- 用户希望支持临时性的工作目录:
  - 不选择仓库也能创建 Workspace(纯目录,用完即弃).
  - 允许解绑最后一个 Repo,使已有 Workspace 可以退化为空 Workspace.
- 约束:
  - Workspace 根目录仍然位于 `AWB_DATA_DIR/workspaces`.
  - 空 Workspace 不做 `git init`,仅作为普通目录.
  - 不修改 Workspace 标题.
  - Workspace 页无 Repo 时隐藏 code-review 工具与 header 中的 Git 功能按钮.
  - 终端凭证(useTerminalCredential)沿用现有逻辑,不额外新增规则与 UI.

## 术语与定义

- 空 Workspace:
  - DB: `workspaces` 有记录,但 `workspace_repos` 中没有对应记录.
  - FS: `AWB_DATA_DIR/workspaces/<workspaceDirName>/` 存在,且没有 repo 子目录(或 repo 子目录被移除后为空目录).
  - UI: 不展示 Repo 相关选择器与 Git 操作,仅保留文件/搜索/终端等与目录相关功能.
- Workspace Repo:
  - DB: `workspace_repos` 一行
  - FS: `AWB_DATA_DIR/workspaces/<workspaceDirName>/<dirName>/` 一个子目录
  - Git target: `{ kind: "workspaceRepo", workspaceId, dirName }`

## 现状调研

### 强绑定点

- 创建 Workspace 时必须选择至少 1 个 repo:
  - 共享契约: `packages/shared/src/contracts/workspaces.ts:39`
  - 后端校验: `apps/api/src/modules/workspaces/workspace.service.ts:144`
  - 前端提交: `apps/web/src/features/workspaces/views/WorkspacesTab.vue:574`
- 解绑最后一个 repo 被禁止:
  - 后端: `apps/api/src/modules/workspaces/workspace.service.ts:495`
  - 前端: `apps/web/src/features/workspaces/views/WorkspacesTab.vue:487`

### 空 Workspace 的底层支持度

- DB 结构天然支持空 Workspace:
  - `workspaces` 与 `workspace_repos` 分表,没有 DB 级别的“至少 1 个 repo”约束.
  - `workspace_repos` 外键仅限制引用完整性,不会强制最小集合.
- 文件能力对空 Workspace 天然可用:
  - 文件域解析规则: 只有当路径首段命中 `repoDirNames` 才认为是 repo 目录,否则按 workspaceRoot 处理.
  - 当 `repoDirNames` 为空时,所有路径自然落到 workspaceRoot(见 `apps/api/src/modules/workspaces/workspace-files.service.ts:279`).
- 终端默认 cwd 对空 Workspace 兼容:
  - 只有单 repo 时会把 cwd 落到 repo 子目录,否则回退到 `ws.path`.
  - repo 数为 0 时,会稳定回退到 `ws.path`(见 `apps/api/src/modules/terminals/terminal.service.ts:45`).
- Git 能力对空 Workspace 不适用(符合预期):
  - `GitTargetSchema` 只支持 `WorkspaceRepoTarget`,不存在 workspaceRoot target(见 `packages/shared/src/contracts/git.ts:16`).
  - 因此空 Workspace 下应隐藏 Git UI,而不是“让 Git 操作对 workspaceRoot 生效”.

## 目标

- 支持创建空 Workspace(不选择 repo):
  - 创建时仅创建 workspaceRoot 目录与 `workspaces` 记录.
  - `WorkspaceDetail.repos` 为空数组.
- 支持解绑最后一个 repo:
  - detach 后允许 `workspace_repos` 变为空.
  - 仍沿用“移除仓库目录”的语义(删除对应工作目录).
- Workspace 页无 repo 时的 UI/交互:
  - 隐藏 repo 下拉选择器.
  - 隐藏 code-review 工具及其带来的 header Git 操作(pull/push).
  - checkout 按钮天然依赖 `currentTarget`(无 repo 时不会显示),保持不变.
- 不修改 Workspace 标题.
- 终端凭证逻辑沿用现状:
  - 空 Workspace 创建请求不应携带 `useTerminalCredential: true`.
  - 若客户端强行传入并触发后端 409,视为与现有“无可用共享凭证”一致的行为.

## 非目标

- 不支持将任意本地目录“导入”为 Workspace.
- 不为 workspaceRoot 引入 GitTarget 或在 workspaceRoot 上执行 git 操作.
- 不改变现有 Repo/Workspace 的目录模型与 clone-from-mirror 策略.
- 不做标题自动更新(例如 repo 清空后自动改名).

## 关键决策与取舍

### 允许空 Workspace 的语义选择

- 选择:
  - 空 Workspace 是一个“目录容器”,用来承载临时文件/脚本/输出物.
- 原因:
  - 与 `workspace-files`/`terminal` 的现有实现天然契合,改动最小.
  - 避免引入“任意目录挂载”的安全边界问题(仍受 `AWB_DATA_DIR` 派生目录约束).

### 允许解绑最后一个 repo

- 选择:
  - 移除后允许 repo 数为 0.
  - 仍保留 “active terminals 存在时禁止 detach” 规则.
- 原因:
  - 满足“脱离仓库绑定,用完即弃”的核心目标.
  - 终端仍可能 cwd 指向 repo 目录,继续保留 active terminals 校验可避免删除时的不可控状态.

### Git UI 的处理方式: 隐藏而非置灰

- 选择:
  - 空 Workspace 下隐藏 code-review 工具与 header 的 Git 操作按钮.
- 原因:
  - Git 契约不存在 workspaceRoot target,置灰并提示也会产生“为什么不能用”的额外解释成本.
  - 隐藏可显著减少误操作与错误弹窗(404/400/409)带来的噪音.

### 与既有设计的关系

- `docs/design/workspace-repo-attach-detach.md` 中曾将“不允许解绑最后一个 repo”作为关键决策.
- 本方案明确反转该决策:
  - detach 最后一个 repo 后 Workspace 允许变为空.
  - 代价是需要在 Workspace 页/Workspaces 列表页补齐空态 UI,并处理 dock 布局持久化的边界.

## 技术方案

### 共享契约与 API

- `CreateWorkspaceRequestSchema` 放开 `repoIds` 最小数量限制:
  - 由 `minItems: 1` 调整为允许空数组(建议仍保留字段为数组,避免出现“字段可选但语义不清”的分支).
  - 对应文件: `packages/shared/src/contracts/workspaces.ts`
- 现有 Workspace 详情结构不变:
  - `WorkspaceDetail.repos` 允许为空数组,前端以空数组表达空 Workspace.

### 接口与错误码(变更点)

- 创建 Workspace
  - `POST /api/workspaces`
  - request body:
    - `repoIds: string[]` 允许为空数组
    - `title?: string`
    - `useTerminalCredential?: boolean`
  - response:
    - `201 WorkspaceDetail`
  - 主要错误:
    - 400: `repoIds` 去重失败等输入错误(与现有保持一致)
    - 409: `useTerminalCredential: true` 但无法解析共享凭证(空 repo 或凭证不一致时均可能触发,沿用现有语义)
- 解绑 Workspace 内的 Repo
  - `DELETE /api/workspaces/:workspaceId/repos/:repoId`
  - response:
    - `200 WorkspaceDetail`
  - 主要错误:
    - 404: workspace 或 workspace-repo 不存在(与现有保持一致)
    - 409: `WORKSPACE_HAS_ACTIVE_TERMINALS`(保留),不再返回 `WORKSPACE_LAST_REPO`

### 后端实现调整

- 创建 Workspace:
  - 当 `repoIds` 为空:
    - 仅生成 `workspaceId` 与 `workspaceDirName`.
    - 创建 workspaceRoot 目录(`ensureDir`).
    - 写入 `workspaces` 表,不写入 `workspace_repos`.
    - `terminalCredentialId` 保持 `null`.
    - title:
      - 若用户传 title 则使用用户 title
      - 否则使用默认 `"workspace"`(与现有 `buildDefaultWorkspaceTitle` 的兜底一致)
  - 当 `repoIds` 非空:
    - 保持现有流程: 更新 mirror,clone,写入 `workspaces + workspace_repos`.
  - 对应文件: `apps/api/src/modules/workspaces/workspace.service.ts`
- 解绑 Repo:
  - 移除“workspace 必须至少包含 1 个 repo”的校验,允许解绑最后一个 repo.
  - 保留:
    - active terminals 校验
    - 删除路径强校验(避免 DB 脏数据越界删除)
  - 对应文件: `apps/api/src/modules/workspaces/workspace.service.ts`
- 兼容性:
  - `workspace-files` 与 `terminal` 对空 repo 天然兼容,无需改变其路由与锁策略.

### 业务逻辑流程(高层)

#### 创建空 Workspace

- 校验参数:
  - 允许 `repoIds.length === 0`
  - 若 `useTerminalCredential: true` 则按现有规则校验共享凭证,空 repo 场景下预期会失败并返回 409
- 分配工作区标识与目录:
  - 生成 `workspaceId`
  - 分配 `workspaceDirName`
  - `workspacePath = AWB_DATA_DIR/workspaces/<workspaceDirName>`
- FS:
  - `ensureDir(workspacePath)`
- DB:
  - 插入 `workspaces`
  - 不插入 `workspace_repos`
- 返回:
  - `WorkspaceDetail` 的 `repos = []`

#### detach 最后一个 Repo

- 前置校验:
  - workspace 存在
  - workspace-repo 存在
  - active terminals 数量为 0(保留现有约束)
- FS:
  - 目录强校验(record.path 与 expectedPath 一致)
  - 删除 repo 子目录
- DB:
  - 删除 `workspace_repos` 对应记录
  - `terminal_credential_id` 维持现有更新逻辑:
    - 若 workspace 原本启用终端凭证,detach 后会按“剩余 repo 的共享凭证”重新计算并在必要时自动清空
- 返回:
  - `WorkspaceDetail` 的 `repos = []`

#### 空 Workspace attach Repo

- 行为保持不变:
  - dirName 分配策略复用现有实现,并对 workspaceRoot 下的同名目录做 `pathExists` 检查与重试.
  - 完成后 Workspace 从 `repos = []` 变为 `repos.length >= 1`,Workspace 页将恢复显示 repo select 与 Git 相关 UI(由前端 `hasRepos` 驱动).

### 前端实现调整

#### Workspaces 列表页

- 创建弹窗:
  - 允许不选择 repo 直接提交(由“必须选择”改为“可选”).
  - 终端凭证 UI 不改(沿用现有可用性计算逻辑),但应确保在 repo 未选择时不会把 `useTerminalCredential` 作为 true 发送出去.
  - 对应文件: `apps/web/src/features/workspaces/views/WorkspacesTab.vue`
- repo 摘要占位:
  - `workspaceRepoSummary(ws)` 在 `ws.repos` 为空时返回占位 `"-"`.
  - 对应文件: `apps/web/src/features/workspaces/views/WorkspacesTab.vue`
- 解绑弹窗:
  - 允许解绑最后一个 repo:
    - 移除 `ws.repos.length <= 1` 的禁用原因与按钮禁用逻辑.
    - 更新 i18n 中与 lastRepo 相关的提示/错误码映射(不再使用).
  - 对应文件:
    - `apps/web/src/features/workspaces/views/WorkspacesTab.vue`
    - `apps/web/src/shared/i18n/locales/zh-CN.ts`

#### Workspace 页

- Header:
  - 当 `workspace.repos.length === 0` 时隐藏 repo 下拉选择器.
  - 对应文件: `apps/web/src/features/workspace/components/WorkspaceHeader.vue`
- 隐藏 code-review 工具与 Git 操作:
  - 空 Workspace 时不渲染/不暴露 code-review 工具:
    - 避免显示工具入口
    - 避免其 headerActions 注入 pull/push
  - 对应文件: `apps/web/src/features/workspace/views/WorkspaceLayout.vue`
- Dock 布局持久化的兼容处理(关键):
  - 由于 dock 布局会持久化 toolId,仅仅隐藏 UI 不够,需要在“工具可用性”变化时清理布局中的不可用 toolId.
  - 建议引入 `enabledToolIds` 概念:
    - `hasRepos = (workspace.repos.length > 0)`
    - `enabledToolIds = hasRepos ? ["files","search","codeReview","terminal"] : ["files","search","terminal"]`
  - 将 `enabledToolIds` 应用于:
    - toolbar 列表构建(避免出现“幽灵工具”入口)
    - activeTool 的回退(若当前激活的是 codeReview,无 repo 时应自动切回 files)
    - KeepAlive include 列表(避免缓存不应存在的工具实例)
  - 目标:
    - 空 Workspace 时 UI 不出现 codeReview,且不会因为历史布局导致布局异常/空白.

## 风险与缓解

### attach repo 时目录同名/冲突

- 现状:
  - dirName 基于 repoUrl 生成,冲突时追加 `hash8(repoUrl)` 后缀,天然区分 host 不同但路径同名的仓库.
  - attach 时还会检查 `pathExists(worktreePath)` 并换名重试.
  - 对应文件: `apps/api/src/modules/workspaces/workspace.service.ts:355`
- 残余风险:
  - 若用户在 API 之外的方式直接在磁盘上创建同名目录,仍可能产生 TOCTOU 的冲突(理论上存在).
- 缓解:
  - 以 `withWorkspaceLock` 串行化所有对同一 workspaceRoot 的敏感操作(attach 与 workspace-files 的 workspaceRoot 写操作均使用该锁,可覆盖 API 内并发).
  - 保留“分配失败返回 409 `WORKSPACE_REPO_DIR_CONFLICT`”作为可理解的兜底.

### 空 Workspace 的 Git 功能误触发

- 风险:
  - 若 UI 未隐藏,用户点击 git 操作会触发各种 4xx,造成噪音.
- 缓解:
  - 空 Workspace 下彻底移除 codeReview 工具与其 headerActions.
  - Header checkout 依赖 `currentTarget`,无 repo 时天然不显示,保持现状即可.

### 终端凭证残留

- 风险:
  - 空 Workspace 不应携带 `terminalCredentialId`,否则会产生“无 repo 却在终端注入凭证”的理解偏差.
- 缓解:
  - 创建空 Workspace 时 `terminalCredentialId` 固定为 null.
  - detach 到空 Workspace 后沿用现有逻辑:
    - 若 workspace 原本启用终端凭证,在 repo 被移除后会自动降级/清空 `terminalCredentialId`
    - 空 Workspace 下终端环境不会注入 repo 凭证

### 文案与清理

- i18n 中不再保留 `WORKSPACE_LAST_REPO` 相关文案,与实现保持一致.

## 迁移与兼容性

- DB schema 不变.
- 旧版客户端:
  - 仍按“必须选择 repo”创建,行为不变.
  - 不会触发空 Workspace 分支.
- 新版客户端:
  - 可创建空 Workspace,并可将已有 Workspace 解绑到空.

## 最小自检建议

- 后端:
  - 创建空 Workspace 后:
    - `GET /api/workspaces/:id` 返回 `repos: []`
    - `workspaces.path` 指向 `AWB_DATA_DIR/workspaces/<dirName>`
  - 从 1 repo detach 到空:
    - repo 子目录被删除
    - `workspace_repos` 记录清空
  - 空 Workspace 下:
    - `files/list`、`files/read-text`、`files/write-text` 可在 workspaceRoot 下正常工作
    - 终端可创建且 cwd 为 workspaceRoot
- 前端:
  - Workspaces 列表页 repo 摘要为空时显示 `"-"`
  - Workspace 页无 repo 时:
    - Header 不显示 repo select
    - Dock/toolbar 不显示 codeReview
    - Header 不显示 pull/push/checkout(checkout 天然不显示)
