# Workspace 绑定/解绑 Repo(Attach/Detach) 技术方案

## 需求背景

- 当前系统支持全局 Repo 的新增/删除,并支持创建 Workspace 时一次性选择多个 Repo.
- 但对已存在的 Workspace,无法在不重建 Workspace 的情况下增加绑定或解绑某个 Repo.
- 多仓 Workspace 的日常使用中,经常会出现:
  - 在同一工作上下文中临时加入一个关联仓库(例如 shared-lib, docs, infra).
  - 不再需要某个仓库时希望从 Workspace 中移除,减少噪音与资源占用.

## 现状调研与约束

- 全局 Repo 增删已实现:
  - 后端: `POST /api/repos`, `DELETE /api/repos/:repoId`(见 `apps/api/src/modules/repos/repos.routes.ts`)
  - Repo 删除时若仍被任何 Workspace 引用会 409 拒绝(依赖 `workspace_repos`,见 `apps/api/src/modules/repos/repo.service.ts:137`)
- Workspace 与 Repo 的绑定关系由 `workspace_repos` 表表达,且 Workspace 创建时落库:
  - DB schema: `apps/api/src/infra/db/schema.ts`
  - Workspace 创建流程: `apps/api/src/modules/workspaces/workspace.service.ts`
- Workspace 目录模型:
  - `AWB_DATA_DIR/workspaces/<workspaceDirName>/<dirName>`(每个绑定的 repo 对应一个子目录)
  - 路径拼接统一由 `apps/api/src/infra/fs/paths.ts` 提供
- Git target 模型基于 `workspaceId + dirName`:
  - 共享契约: `packages/shared/src/contracts/git.ts` 中 `WorkspaceRepoTarget`
  - 前端 Workspace 页通过 `dirName` 切换当前 repo(见 `apps/web/src/features/workspace/views/WorkspaceLayout.vue`)
- 当前实现的 Workspace "准备 repo"使用 clone-from-mirror 策略,并未使用 git worktree:
  - mirror 更新: `apps/api/src/infra/git/mirror.ts`
  - clone: `apps/api/src/infra/git/clone.ts`

## 目标

- 对已存在的 Workspace 支持:
  - 绑定 Repo(attach): 在 Workspace 下增加一个 repo 子目录,并在 DB 中新增关联记录.
  - 解绑 Repo(detach): 从 Workspace 下移除一个 repo 子目录,并删除关联记录.
- 绑定/解绑完成后前端可立刻拿到最新的 `WorkspaceDetail`,并刷新 UI 状态.
- 保持现有目录结构与 git target 语义不变,避免影响 files/git/terminals 的既有接口与逻辑.

## 非目标(本期不做)

- 不引入 git worktree 方案替换现有 clone 模型(仅在后续优化中讨论).
- 不做跨窗口/跨进程的实时同步推送(多窗口情况下依赖前端刷新与局部自愈).
- 不做"解绑 repo 时自动迁移或保存未提交改动"等复杂迁移能力.

## 术语

- Repo: 全局仓库记录,包含 url, mirrorPath, credentialId 等(表 `repos`).
- Workspace: 一个工作容器,包含 title, dirName, path 等(表 `workspaces`).
- Workspace Repo: 一个 Workspace 中绑定的某个 Repo,对应:
  - DB: `workspace_repos` 的一行记录
  - FS: Workspace 根目录下的一个子目录(使用 `dirName`)
  - API target: `{ kind: "workspaceRepo", workspaceId, dirName }`

## 关键决策(已确认)

- 解绑限制: 若该 Workspace 存在 active terminals,则 409 拒绝解绑.
  - 目的: 避免终端 cwd 指向待删除目录导致的差体验与不可控状态.
- 凭证策略: attach 一个不同凭证的 repo 时,自动降级(关闭 workspace 的 terminal credential 开关).
  - 目的: 保持 attach 易用性,由系统做最小化降级,避免阻塞用户流程.
- 最小集合: 不允许解绑最后一个 repo(Workspace 至少保留 1 个 repo).
  - 目的: 保持 Workspace 的语义完整性,避免产生"空 Workspace"带来的边界处理成本.
- 前端一致性: 接受多窗口下的非实时同步,以刷新/自愈为主.

## 数据模型与目录结构

### DB 表

- `workspaces`
  - `id`, `dir_name`, `title`, `path`, `terminal_credential_id`, `updated_at` 等
- `workspace_repos`
  - `workspace_id`, `repo_id`, `dir_name`, `path` 等
  - 主键: `(workspace_id, repo_id)`
  - 同一 workspace 内 `dir_name` 唯一(见 `idx_workspace_repos_workspace_dir`)

### FS 目录

- `AWB_DATA_DIR/workspaces/<workspaceDirName>/`
  - `<dirName>/` 对应一个绑定的 repo 的工作目录
- 约束:
  - 删除目录前必须做强校验,避免 DB 脏数据导致越界 `rm -rf`

## 接口设计(建议)

### Workspace 内绑定 repo

- `POST /api/workspaces/:workspaceId/repos`
- request body:
  - `repoId: string`
  - `branch?: string`(可选; 不传则使用 mirror 推断默认分支)
- response:
  - `200 WorkspaceDetail`

### Workspace 内解绑 repo

- `DELETE /api/workspaces/:workspaceId/repos/:repoId`
- response:
  - `200 WorkspaceDetail`

### 状态码与错误码策略

- 400
  - `INVALID_INPUT`: 参数缺失/格式错误
  - `REPO_BRANCH_NOT_FOUND`: 指定 branch 不存在(若支持 branch 参数)
- 404
  - `WORKSPACE_NOT_FOUND`
  - `REPO_NOT_FOUND`
  - `WORKSPACE_REPO_NOT_FOUND`: workspace 未绑定该 repoId
- 409
  - `WORKSPACE_HAS_ACTIVE_TERMINALS`: 存在 active terminals,拒绝解绑
  - `WORKSPACE_LAST_REPO`: 解绑将导致 workspace repo 数为 0,拒绝解绑
  - `WORKSPACE_REPO_ALREADY_EXISTS`: 重复绑定同一 repoId
  - `WORKSPACE_REPO_PATH_INVALID`: 解绑时 path 校验失败,拒绝删除目录
  - `WORKSPACE_PREPARE_REPO_FAILED`: 准备目录(mirror/clone)失败(复用现有错误语义)

说明:
- 本项目风格倾向于使用 409 表达"当前状态不允许该操作"(例如 repo syncing,被引用等),与现有行为对齐.

## 后端实现方案

### 路由与契约

- `packages/shared`
  - 新增共享契约:
    - `AttachWorkspaceRepoRequestSchema`
    - (可选) `DetachWorkspaceRepoResponseSchema`(若不复用 WorkspaceDetail)
- `apps/api`
  - 在 `apps/api/src/modules/workspaces/workspaces.routes.ts` 注册:
    - `POST /api/workspaces/:workspaceId/repos`
    - `DELETE /api/workspaces/:workspaceId/repos/:repoId`
  - route schema 直接复用 shared contract,保证 OpenAPI 一致性.

### store 增补

为避免在 service 层手写 SQL,建议在 `apps/api/src/modules/workspaces/workspace.store.ts` 增加:
- `getWorkspaceRepoByRepoId(db, workspaceId, repoId)`
- `deleteWorkspaceRepoByRepoId(db, workspaceId, repoId)`
- (可选) `touchWorkspaceUpdatedAt(db, workspaceId, updatedAt)`

### attach 业务流程(高层)

- 校验 workspace 存在
- 校验 repo 存在
- 判重:
  - 若已绑定同 repoId,返回 409 `WORKSPACE_REPO_ALREADY_EXISTS`
- 选择 `dirName`:
  - 复用 Workspace 创建时的 `pickDirName`,基于 repo url 生成,并保证在该 workspace 内唯一
- 准备目录:
  - 目标路径: `workspaceRepoDirPath(ctx.dataDir, ws.dirName, dirName)`
  - 对 repo 加 `withRepoLock(repoId)` 互斥(进程内),避免 mirror 同步并发
  - 使用 repo 绑定的 credential 准备 git env,更新 mirror 到最新,并校验目标分支存在
  - 使用 `cloneFromMirror` 创建工作目录
- 写 DB(建议事务):
  - 插入 `workspace_repos`
  - 若 workspace 当前启用 terminal credential:
    - 重新计算是否仍可用
    - 若不可用,将 `terminal_credential_id` 置 null,实现自动降级
  - 更新 workspace `updated_at`(可选但推荐,保证列表排序与"最近更新"一致)
- 返回最新 `WorkspaceDetail`

### detach 业务流程(高层)

- 校验 workspace 存在
- 查找要解绑的 workspace repo 记录:
  - 不存在则 404 `WORKSPACE_REPO_NOT_FOUND`
- 最小集合校验:
  - 若当前 workspace 仅有 1 个 repo,则 409 `WORKSPACE_LAST_REPO`
- 活跃终端校验:
  - 若 active terminals 数量 > 0,则 409 `WORKSPACE_HAS_ACTIVE_TERMINALS`
- 并发互斥:
  - 对 `(workspaceId, dirName)` 加 `withWorkspaceRepoLock`,避免与 files/git 操作并发
- 路径强校验 + 删除目录:
  - expectedPath = `workspaceRepoDirPath(ctx.dataDir, ws.dirName, dirName)`
  - 必须满足 `resolve(record.path) === resolve(expectedPath)`,否则 409 `WORKSPACE_REPO_PATH_INVALID`
  - `rmrf(expectedPath)`
- 删除 DB 关联记录:
  - `deleteWorkspaceRepoByRepoId`
  - 更新 workspace `updated_at`(可选但推荐)
- 返回最新 `WorkspaceDetail`

### 并发与一致性策略

- repo 级互斥:
  - 使用 `withRepoLock(repoId)` 串行化 mirror fetch 与 clone,避免同一 mirrorPath 被并发写.
  - 该锁为进程内锁,满足当前单进程服务的约束.
- workspaceRepo 级互斥:
  - 使用 `withWorkspaceRepoLock({ workspaceId, dirName })` 串行化对同一 workspace repo 目录的敏感操作(主要是 detach).
  - 该锁同样为进程内锁,与当前架构一致.
- 文件系统与 DB 的一致性:
  - attach: "先 FS 后 DB",DB 失败则回滚删除目录
  - detach: "先 FS 后 DB",FS 失败则不删 DB 记录(保持可重试与可排障)

### terminal credential 自动降级细节

- workspace 的 `useTerminalCredential` 实际来源于 `terminal_credential_id` 是否为 null(见 `apps/api/src/modules/workspaces/workspace.service.ts`)
- attach 后若发现:
  - workspace 原本启用 terminal credential
  - 新的 repo 引入不兼容 credentialId(不满足"所有非空 credentialId 相同")
- 则执行降级:
  - 将 workspace 的 `terminal_credential_id` 置 null
  - 不 retroactive 修改已存在 tmux session 的环境变量(与现有 update 语义一致)

## 前端实现方案

### API 封装

在 `apps/web/src/shared/api/api.ts` 增加:
- `attachWorkspaceRepo(workspaceId, body)`
- `detachWorkspaceRepo(workspaceId, repoId)`

### UI 入口与交互

- Workspaces 列表页入口:
  - 每个 workspace 列表项增加"添加仓库"与"移除仓库"按钮
  - 两个操作均通过弹窗选择目标 repo 并确认
- 操作完成后:
  - 使用接口返回的 `WorkspaceDetail` 刷新列表页
  - Workspace 页在下次刷新时,若当前 repo 已被移除,会自动回退到第一个可用 repo
- 自动降级提示:
  - attach 前后对比 `useTerminalCredential` 变化
  - 若从 true 变为 false,toast 提示"已自动关闭终端凭证"

### 多窗口一致性

- 多窗口同时打开同一 workspace 时:
  - 不保证实时同步
  - 以"操作后刷新"与"遇到 404/409 时提示用户刷新"为主

## 安全与边界

- 删除目录前必须做 expectedPath 校验,避免越界删除.
- `dirName` 必须由后端生成并保证不包含危险片段,不允许前端传入任意 path.
- 解绑时拒绝在 active terminals 存在的情况下执行,降低不可控风险.

## 取舍与替代方案(简述)

- 方案: 通过重建 Workspace 来实现 repo 集合变化
  - 问题: 需要迁移未提交改动与终端状态,风险与成本高
- 方案: 迁移到 git worktree 模型后再支持增删
  - 问题: 属于存量行为改变,并引入 worktree 的分支占用限制,不适合作为本需求的最短路径
- 本方案选择:
  - 在现有 clone-from-mirror 模型上补齐 attach/detach,复用现有基础设施,改动面最小

## 最小自检清单(实现完成后)

- attach:
  - 能成功把 repo 加入 workspace,并在 UI 中出现
  - attach 重复 repoId 返回 409
  - attach 后 workspace `useTerminalCredential` 可能自动降级且提示正确
- detach:
  - 有 active terminals 时返回 409
  - 解绑最后一个 repo 返回 409
  - 成功解绑后目录被删除,DB 关联记录被删除,UI repo 列表更新
  - Workspace 页在下次刷新时,若当前 repo 已被移除,会自动回退到第一个可用 repo
- 安全:
  - path 校验触发时能阻止越界删除并返回 409
