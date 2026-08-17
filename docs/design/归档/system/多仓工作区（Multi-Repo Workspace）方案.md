# 多仓工作区（Multi-Repo Workspace）方案

## 背景

- 现实项目常按架构分层、前后端分工、基础设施/业务拆分为多个仓库（multi-repo）
- 当 AI Agent 仅在单仓内工作时
  - 上下文信息不完整，容易遗漏跨仓约束（契约、接口、配置、文档）
  - 同一需求需要在多个仓库重复描述与执行，协作成本高
- 现有产品形态以「Workspace = 单 repo」为核心假设（契约、DB、路径、UI 工具都绑定单 repo）

## 目标

- 支持「Workspace = 多个 repo 的集合」，在同一工作区内并行开发多个仓库
- 让用户在 Workspace 根目录下直接看到各 repo 目录，便于理解与操作
- 保持操作边界清晰
  - 前端不直接传入任意路径
  - 后端只允许在 `AWB_DATA_DIR` 派生目录内执行文件/Git 操作
- API 设计更通用，便于未来产品形态继续演进

## 非目标（当前版本不做，但设计需要兼容）

- Workspace 内动态添加/移除 repo（未来会做）
  - 当前版本仅支持创建时选择 repo 集合
  - 设计需避免与未来增删 repo 能力冲突（数据结构与接口形态预留）
- 全局展示「Workspace 下所有 repo 的分支/脏状态」并高频刷新
  - 当前交互模型以「当前选中 repo」为主，不做全量状态聚合

## 关键决策与取舍

### Workspace 落地方式：mirror + 本地 clone（完全独立拷贝）

- 选择
  - Repo 仍维护 mirror（用于加速与降网络依赖）
  - Workspace 内每个 repo 使用「从 mirror 进行本地 clone」生成独立工作目录
- 取舍逻辑
  - 不使用 worktree
    - worktree 对依赖体积（如 `node_modules`）几乎不省空间
    - 引入分支占用限制与更复杂的元数据一致性问题，增加出错概率
  - 选择“完全独立拷贝”
    - 避免 shared/alternates 等机制导致 mirror 维护/清理影响 workspace 可用性
    - 牺牲少量磁盘空间，换稳定性与故障隔离

### repo 身份：以用户输入的 url 字符串为准

- 选择
  - 不对 url 做协议/用户名/host 大小写等归一化
  - url 不同即视为不同 repo（即使指向同一远端）
- 取舍逻辑
  - 不替用户做“是否相同 repo”的判断，保证可预期性
  - 代价是可能出现多个目录指向同一远端的情况，属于用户主动选择

### Workspace 根目录目录结构：平铺 repo 目录

- 选择
  - `${AWB_DATA_DIR}/workspaces/<workspaceDirName>/<dirName>`
  - 不引入额外 `repos/` 目录层级
- 取舍逻辑
  - Workspace 根目录更直观，可直接看到 repo 目录
  - 当前 Workspace 根目录没有其他功能目录，增加一层意义不大

### Workspace 根目录名（workspaceDirName）：短且稳定，ID 与目录解耦

- 目标
  - 磁盘目录尽量短，便于在 Terminal/文件管理器中输入
  - workspace 的逻辑 ID（`workspaceId`）继续保持全局唯一与稳定（用于 API/DB/日志）
- 选择
  - 新增 `workspaces.dir_name`（`workspaceDirName`），作为 workspace 根目录名
  - `workspace.path` 固化为 `${AWB_DATA_DIR}/workspaces/${workspaceDirName}`，后端一律以 DB 中的 `workspace.path` 为准
  - 目录名生成策略（创建时生成一次，后续不随 title 变更）
    - 不拼 title，直接使用 `w_<rand>`（极短且避免暴露语义）
    - `rand`：短随机串（建议 base64url/base32/base58 等安全字符集），用于冲突消解
  - 约束
    - `unique(dir_name)`
- 取舍逻辑
  - 避免把完整 `workspaceId` 拼进目录导致路径过长
  - ID 与目录解耦后，未来即使更换 ID 规则/展示规则，也不影响落盘结构

### 目录名（dirName）：可读优先，冲突加 hash，不要求可逆

- 选择
  - 默认使用 `repoName`（从 url 解析的最后一段，去 `.git`）
  - 若同一 workspace 下发生冲突，使用 `repoName_<hash8>`
  - `hash8` 直接对用户输入的 url（trim 后原文）计算
  - 目录名安全化规则
    - 将 `repoName` 中除 `[A-Za-z0-9._-]` 之外的字符统一替换为 `_`
- 取舍逻辑
  - 保持目录短、可读、易输入
  - 避免 url 参与目录名导致字符集/长度问题

### Git 接口通用化：引入 target 抽象（而非暴露 path）

- 选择
  - Git 能力接口统一基于 `target`，由后端解析为可操作目录与上下文
  - 最小 target 形态（与多仓工作区匹配）
    - `target: { kind: "workspaceRepo", workspaceId, dirName }`
- 取舍逻辑
  - 接口语义更稳定：未来业务形态变化时，只需新增/调整 target 解析
  - 保持安全边界：前端不能传任意 path
  - 保持工作台能力：后端仍可基于解析结果做权限、策略、错误提示等治理

### Git identity：只关联 repo，与 workspace 无关

- 选择
  - identity 的设置与读取按 repo 工作目录生效
  - workspace 不提供额外的 identity 聚合状态

### Git 状态与分支“真相”：不存 DB，按需查询

- 选择
  - 不在 DB 存每个 repo 的当前分支/脏状态
  - 通过单独的 `git/status` 接口按需查询（基于当前 target）
- 取舍逻辑
  - 当前交互以单一 repo 视角为主，不存在高频全量刷新需求
  - 仅需前端做轻量缓存/去抖即可控制重复请求

### CodeReview Push/Pull：仅作用于当前选中 repo

- 选择
  - Workspace 内全局选择当前 repo
  - CodeReview 的 Push/Pull 只针对当前 repo
- 取舍逻辑
  - 避免“一键对所有 repo 操作”造成误操作与复杂反馈
  - 保持极简交互与低学习成本

## 数据落盘与路径

- 数据根目录：`AWB_DATA_DIR`（后端对其 `path.resolve` 成绝对路径）
- repo mirror
  - `${AWB_DATA_DIR}/repos/<repoId>/mirror.git`
- workspace 根目录
  - `${AWB_DATA_DIR}/workspaces/<workspaceDirName>/`
- workspace repo 目录
  - `${AWB_DATA_DIR}/workspaces/<workspaceDirName>/<dirName>/`

## 数据模型（建议）

### workspaces

- `id`
- `dir_name`（workspace 根目录名，唯一）
- `path`（workspace 根目录）
- `title`（用户可编辑，列表页展示标题）
- `created_at`、`updated_at`
- 预留
  - 未来如果引入 workspace 级别设置，可在此表扩展（当前不做）

### workspace_repos（新增）

- `workspace_id`
- `repo_id`
- `dir_name`（同一 workspace 内唯一）
- `path`（repo 工作目录绝对路径：`${workspace.path}/${dir_name}`）
- `created_at`、`updated_at`
- 约束建议
  - `unique(workspace_id, dir_name)`
  - `unique(workspace_id, repo_id)`

### repos（沿用）

- `id`
- `url`（唯一）
- `mirror_path`
- `sync_status`、`sync_error`、`last_sync_at`
- 建议新增
  - `default_branch`（用于 workspace 创建时默认 checkout）

## Workspace 标题（列表展示）

- `title` 字段用于 workspace 列表展示
- 默认标题生成策略（创建时）
  - 使用所有 repo 的 `repoName` 按用户选择顺序拼接
  - 过长时做截断
    - 展示前若干 repoName，其余用 `+N` 或 `…` 表示（以 UI 约束为准）
- 用户可在 workspace 详情/设置中编辑标题

## 创建 Workspace（当前版本交互）

- 仅支持选择已有 repo（repoId）
- 不选择分支
  - 使用 repo 的 `default_branch`
  - 若 `default_branch` 不可确定，提示用户先 sync repo
- 目录名生成
  - 以 `repoName` 为基准安全化生成 `dirName`
  - 冲突则 `repoName_<hash8>`
  - `dirName` 固化存入 `workspace_repos`
- 落盘与 clone
  - 从 mirror 生成独立拷贝到 `${workspace.path}/${dirName}`
  - 任一 repo 失败则回滚已创建目录（best-effort），避免半成品 workspace

## Git 能力接口（target 版）

### target 解析（后端内部）

- `resolveTarget(target)` 返回
  - `rootPath`（Git 操作目录）
  - `workspaceId`、`repoId`（用于业务上下文与日志）
  - 可选 `policy`（未来用于权限/功能开关）

### 典型接口

- `POST /api/git/status`
  - 入参：`{ target }`
  - 返回最小集
    - `head`: `branch | null`、`detached`、`sha`
  - 可选返回
    - `upstream`、`ahead/behind`（用于 push/pull UX）
    - `dirty`（staged/unstaged/untracked 统计）
- `POST /api/git/changes`
  - 入参（body）：`{ target, mode: "staged" | "unstaged" }`
- `POST /api/git/file-compare`
  - 入参（body）：`{ target, mode, path, oldPath? }`
- 写操作接口（stage/unstage/commit/push/pull）
  - 全部迁移为 target 版（不再依赖 workspaceId 的单 repo 假设）

## 前端方案（Workspace 页面）

### 全局当前 repo 状态

- Workspace 页面提供全局控件用于选择当前 repo
- 选择器状态
  - 记忆上次选择（localStorage）
  - localStorage 无记录时默认选择第一个 repo
    - `repos[]` 的顺序尽量保持创建 workspace 时的 repoIds 顺序，便于“第一个 repo”符合用户直觉
- 全局状态通过注入上下文提供给工具（与 Dock Host API 解耦）
  - `repos[]`
  - `currentRepoKey = dirName`
  - `currentRepo`
  - `currentTarget`
  - `setCurrentRepo(dirName)`
  - `statusByDirName`（来自 `git/status`，仅内存缓存）

### 工具如何消费全局状态

- Terminal
  - 不依赖当前 repo
  - 默认 cwd 为 workspace 根目录
- CodeReview
  - 强依赖当前 repo（`currentTarget`）
  - repo 切换时触发自身刷新（changes/file-compare/status 等由工具自行决定时机）
  - Push/Pull 按钮仅作用于当前 repo
- 新工具
  - 自行决定是否依赖全局 repo 状态，从而复用同一套逻辑

## 推送失败的兜底策略（后续能力，建议纳入设计）

- 默认兜底
  - 推送到远端备份分支（不改写历史，优先“保住代码”）
- 用户确认后可选
  - `--force-with-lease` 的可控强推
- 取舍逻辑
  - 默认方案降低误伤协作风险
  - 强推仅在用户明确确认下提供，并尽量保证可恢复性

## 改造范围（后端/前端/共享契约）

### 后端（apps/api）

- DB schema
  - `workspaces` 从单 repo 绑定调整为 workspace 元数据（新增 `title`）
  - 新增 `workspace_repos`
  - `repos` 增加 `default_branch`（或等价字段）
- Workspace 模块
  - 创建/查询/删除逻辑调整为多 repo
  - 创建仅支持已有 repoId 列表
- Git 模块
  - 引入 `target` 与 `resolveTarget`
  - 全量迁移为 target 版接口
  - 增加 `git/status`
- 路径生成
  - 增加 workspace root 与 repo dirName 相关路径函数

### 前端（apps/web）

- WorkspaceLayout
  - 增加全局 repo 选择器与注入的 workspace 上下文
  - `currentTarget` 作为 CodeReview 等工具的统一输入
- CodeReview 工具
  - 按 target 工作
  - Push/Pull 只作用于当前 repo
- API client
  - 新增/迁移为 target 版调用

### 共享契约（packages/shared）

- Workspace 相关 schema
  - `WorkspaceDetail` 改为包含 `repos[]`（含 `dirName`、url 等）
  - workspace 创建请求改为 `{ repoIds: string[] }`（或等价结构）
- Git 相关 schema
  - 引入 `Target` 类型（含 `kind`）
  - changes/file-compare/status 等接口参数改为携带 target

## 与未来“增删 repo”能力的兼容点（设计预留）

- `workspace_repos` 作为独立关联表，天然支持增删
- `dirName` 规则与唯一约束保证未来新增 repo 时不会破坏现有目录结构
- 前端全局选择器在 repo 列表变化时需要定义回退逻辑
  - 当前 repo 被删除时自动切换到第一个 repo（或上一次有效选择）
- Git 接口以 target 为核心
  - 新增 repo 后只需提供新的 `dirName` 即可立即复用所有能力
