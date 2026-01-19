# Workspace 全局文件浏览器(口径B)设计方案

## 需求背景

- 当前 Workspace 的 File Explorer + Editor 仅支持"当前选中 repo"(currentTarget)范围内的文件浏览与编辑.
  - 前端 File Explorer 以 `target: GitTarget | null` 作为可用性开关,未选择 repo 时仅展示占位.
  - 后端 files API 以 repo worktree 作为 root,所有路径均为 repo 相对路径,无法访问 workspace 根目录.
- 在 Multi-Repo Workspace 场景下,用户希望:
  - 不依赖"选择 repo"即可浏览 workspace 内全部文件.
  - 能在 workspace 根目录直接新建/编辑文件(例如脚本,说明文档,临时笔记,配置等).
- 同时必须保持 workspace 内 repo 目录的结构稳定:
  - 不允许在 File Explorer 中删除或重命名顶层 repo 目录(避免破坏 workspaceRepo 记录与磁盘路径的一致性).
  - 不允许跨域 rename(避免把文件从 workspace 根移动进 repo 或从 repo 移出到 workspace 根,以及不同 repo 之间移动).

## 目标与非目标

### 目标

- File Explorer 的根视角提升为 workspace 根目录(口径B).
  - 根节点 title 使用 `workspace.dirName`.
  - tree node 的 key 与 tabs 的 path 统一使用 workspace 相对路径.
- 允许在 workspace 根目录直接新建/编辑/删除/重命名普通文件与目录.
- 保护顶层 repo 目录:
  - 禁止删除顶层 repo 目录.
  - 禁止重命名顶层 repo 目录.
- 禁止跨域 rename:
  - 禁止 workspace 根 <-> repo 子树之间的 rename.
  - 禁止 repoA <-> repoB 之间的 rename.
- 兼容现有 `files.openAt` 调用链,尽量避免一次性改动 Search/Terminal 等工具.

### 非目标(本阶段不做)

- 不在本阶段把 Search 工具改为 workspace 全局搜索(仍保留"当前 repo"搜索).
- 不改变 CodeReview/Git 等现有接口的 `target: GitTarget` 语义.
- 不引入返回值型 tool call(仍维持 event-only call).
- 不做文件系统监听与自动刷新(依旧按需 list + 手动 refresh).

## 现状调研(关键约束来源)

- shared 契约层:
  - files 请求体都要求 `target: GitTarget`,且 `GitTarget` 当前仅包含 `kind: "workspaceRepo"` 分支.
  - 结论: 若要支持 workspace 根目录文件访问,需要新增契约或扩展 target union.
- 后端 files 模块:
  - 通过 `target.workspaceId + target.dirName` 定位 workspaceRepo,并以 `wsRepo.path` 作为 root 做路径校验与文件操作.
  - 结论: 现有 `/api/files/*` 天然是 repo scoped.
- 前端 WorkspaceLayout:
  - `files` 工具 props 目前包含 `target: currentTarget`,因此工具会被"当前 repo 选择"牵制.

## 关键决策与取舍(已确认)

### 采用独立的 workspace files API,不扩展 GitTarget

- 选择
  - 新增 workspace 级文件 API,以 `workspaceId` 为主键,以 workspace 根目录为 root.
  - File Explorer 工具改为调用 workspace files API.
  - 继续保留 repo scoped 的 `/api/files/*`,供 Git/CodeReview/现有工具复用.
- 原因
  - 避免扩展 `GitTarget` 后引发大量 TS 收窄与分支处理改动.
  - 避免把"文件访问目标"与"Git 目标"绑定在同一个 union 中,降低耦合与未来演进成本.

### 顶层 repo 目录保护由后端强制兜底,前端仅做 UI 禁用

- 选择
  - 后端对 delete/rename 等破坏性操作做强校验,拒绝对顶层 repo 根目录的操作.
  - 前端对对应节点的右键菜单项做禁用,减少误操作.
- 原因
  - 前端禁用只能提升体验,无法作为安全边界.
  - workspaceRepo 记录与 worktree 目录强绑定,目录变更会引入大量一致性问题.

### 禁止跨域 rename,以简化一致性与锁策略

- 选择
  - rename(from,to) 要求 from/to 必须位于同一域:
    - 同一 repo 子树内.
    - 或 workspace 根的"非 repo 子树"区域内.
  - 否则拒绝.
- 原因
  - 跨域 rename 会引入锁选择不一致,以及"移动语义"与 git worktree 的边界不清晰.
  - 在 UI/产品上,跨域移动并非必须能力,后续如确需支持可单独设计.

## 范围定义与术语

- workspace 根目录:
  - 服务端数据库记录的 `ws.path`,且应等于 `workspaceRoot(AWB_DATA_DIR, ws.dirName)`.
- 顶层 repo 目录:
  - workspace 根目录下,名为某个 workspaceRepo.dirName 的一级目录.
- workspace 相对路径(workspaceRelPath):
  - 相对于 workspace 根目录的相对路径.
  - 例:
    - `README.md`
    - `scripts/dev.sh`
    - `repoA/src/index.ts`
- repo 相对路径(repoRelPath):
  - 相对于某个 repo worktree 根目录(`wsRepo.path`)的相对路径.
  - 例:
    - `src/index.ts`

## 总体技术方案

### 后端: 新增 workspace files API,并按路径分发

- 新增路由组:
  - `POST /api/workspaces/:workspaceId/files/list`
  - `POST /api/workspaces/:workspaceId/files/stat`
  - `POST /api/workspaces/:workspaceId/files/read-text`
  - `POST /api/workspaces/:workspaceId/files/write-text`
  - `POST /api/workspaces/:workspaceId/files/create`
  - `POST /api/workspaces/:workspaceId/files/mkdir`
  - `POST /api/workspaces/:workspaceId/files/rename`
  - `POST /api/workspaces/:workspaceId/files/delete`
  - `POST /api/workspaces/:workspaceId/files/search`(可选,本期可先不实现,为后续全局搜索预留)
- 每个请求体均使用 workspace 相对路径字段:
  - list: `dir`
  - stat/read/write/create/mkdir/delete: `path`
  - rename: `from`, `to`
- 服务端处理流程:
  - 根据 `workspaceId` 找到 workspace 记录,校验 `ws.path` 与期望路径一致.
  - 拉取该 workspace 下的 workspaceRepo 列表,得到顶层 repo dirName 集合.
  - 对给定 workspaceRelPath:
    - 若第一级目录命中某个 repo dirName,则进入 repo 子树分支:
      - 对顶层 repo 根目录的 delete/rename 直接拒绝.
      - 对 repo 内部路径,将 workspaceRelPath 剥离前缀得到 repoRelPath,并复用现有 repo files 逻辑.
    - 否则进入 workspace 根分支:
      - root 为 `ws.path`,按 workspaceRelPath 执行文件操作.

### 前端: File Explorer 视角改为 workspace 根

- WorkspaceLayout 不再向 `files` 工具传 `target: currentTarget`,仅传 `workspaceId`.
- File Explorer:
  - 根节点 title 使用 `workspace.dirName`.
  - tree 与 tabs 的 path 统一使用 workspaceRelPath.
  - 所有文件 API 调用改为 workspace files API.
  - 顶层 repo 根节点禁用 rename/delete.
- `files.openAt` 兼容:
  - 统一规范为 workspaceRelPath.
  - 兼容旧调用: 若收到的 path 不包含 repo 前缀,且 envelope.targetAtCall 存在,则自动补 `targetAtCall.dirName/`.

## 后端详细设计

### Workspace 根路径校验

- 对所有 workspace files API,在读取 workspace 后执行:
  - `expectedRoot = workspaceRoot(ctx.dataDir, ws.dirName)`
  - 若 `path.resolve(ws.path) !== path.resolve(expectedRoot)`,则拒绝并返回 409.
- 原因
  - 避免 workspace.path 被异常篡改导致越界访问.
  - 与 attach/detach 的防护策略保持一致.

### 路径规范与安全校验(与现有 files 模块对齐)

- workspaceRelPath/dir/from/to 均要求:
  - 必须为相对路径,禁止绝对路径.
  - 禁止包含 `..` 段.
  - 禁止包含 NUL/换行符.
  - 禁止以 `-` 或 `:` 开头.
  - resolve 后必须落在 root 目录下.
  - `lstat` 拒绝软链.
  - `realpath` 二次校验仍在 root 目录下.
- denylist 段:
  - 默认 denylist: `.git`
  - 任意路径段命中 denylist:
    - list 时不返回该项.
    - stat/read 返回业务态 `unsafe_path`.
    - write/create/mkdir/rename/delete 返回 400/409(按现有风格选择).

### 顶层 repo 目录保护规则

- 定义 `protectedRoots = Set<dirName>`(workspace 下所有 repo 的顶层目录名).
- 判定:
  - `isProtectedRoot(path) = path === dirName`(仅当 workspaceRelPath 恰好为一级目录名).
- 规则:
  - delete:
    - 若 `isProtectedRoot(path)` 则拒绝.
  - rename:
    - 若 `isProtectedRoot(from)` 或 `isProtectedRoot(to)` 则拒绝.
  - list/stat/read/write/create/mkdir:
    - 不额外做保护,因为这类操作要么是只读,要么作用于 repo 子树内部或其他 workspace 文件.
    - 当用户尝试在 workspace 根创建与 repo 同名的文件/目录时,通常会因已存在而返回冲突,无需特殊文案.

### 禁止跨域 rename 的判定

- 定义域(domain):
  - 若 workspaceRelPath 的第一级目录属于 `protectedRoots`,则 domain 为 `{ kind: "repo", dirName }`.
  - 否则 domain 为 `{ kind: "workspaceRoot" }`.
- 规则:
  - rename(from,to) 要求 domain(from) 与 domain(to) 完全一致,否则拒绝.
  - 对 `{ kind: "repo" }` 域:
    - 进一步要求 from/to 不等于顶层根目录本身(由保护规则兜底).
    - 将 `dirName/` 前缀剥离得到 repoRelPath,并在 repo root 下执行 rename.
  - 对 `{ kind: "workspaceRoot" }` 域:
    - 直接在 workspace root 下执行 rename.

### 锁策略

- repo 域操作:
  - 复用现有 `withWorkspaceRepoLock({ workspaceId, dirName })`,确保与 Git 操作互斥.
- workspaceRoot 域操作:
  - 建议新增 `withWorkspaceLock({ workspaceId })`:
    - 限制 workspace 根文件写入(rename/delete/create/mkdir/write)的并发,降低竞态导致的异常.
    - list/read/stat/search 可不强制加锁(按需权衡).
- 原因
  - repo 域必须与 git 共享锁,避免"边写文件边 git checkout/pull"产生不可预期状态.
  - workspaceRoot 文件与 git 逻辑相对独立,但加一把粗粒度锁能简化错误处理.

### 契约与错误码约定(建议)

- 复用现有 files 响应结构,仅把 path 语义升级为 workspaceRelPath.
- 典型返回策略:
  - 400:
    - workspaceId 不合法.
    - dir/path/from/to 非法(绝对路径,包含 ..,NUL,换行,以 -/: 开头等).
    - 命中 denylist 且该接口不适合业务态返回(例如 write/create/mkdir/rename/delete).
  - 404:
    - workspace 不存在.
    - 目标文件/目录不存在(读写/删除/重命名的源路径).
  - 409:
    - 写入冲突(与现有 expected/hash 语义一致).
    - create/mkdir/rename 目标已存在.
    - 保护规则触发(删除或重命名顶层 repo 目录).

## 前端详细设计

### props 与上下文

- WorkspaceLayout:
  - `files` 工具 props 改为 `{ workspaceId, toolId }`.
  - `targetAtCall` 仍由 host envelope 提供,用于兼容 openAt 的旧语义.
- File Explorer:
  - 启动时加载 workspace detail,获得 `workspace.dirName` 与 repo 列表(用于保护规则与 UI 呈现).
  - 根节点 title 使用 workspace.dirName.

### 路径显示与复制

- 统一以 workspaceRelPath 为主:
  - 右键菜单保留 `copyPath`(复制 workspaceRelPath).
  - 可保留 `copyName`.
  - 是否保留 `copyRepoPath` 取决于交互需求:
    - 若保留,仅在节点位于 repo 域时启用,复制 repoRelPath.
    - 若不保留,则只提供一种"复制路径",减少歧义.

### 顶层 repo 目录节点的交互限制

- 对顶层 repo 根节点:
  - 禁用 rename/delete.
  - newFile/newFolder 是否允许:
    - 允许(在 repo 内创建),但实际会落到 repo 域 API.
- 对 workspace 根节点:
  - 允许 newFile/newFolder,落到 workspaceRoot 域 API.

### `files.openAt` 兼容策略

- 收到 call 时:
  - 若 path 的第一级目录命中 workspace 的 repo dirName,视为 workspaceRelPath.
  - 否则若 envelope.targetAtCall 存在,将 path 视为 repoRelPath 并补全为 `dirName/path`.
  - 否则拒绝处理(缺少必要上下文,避免错误打开).
- 迁移期收益:
  - Search/Terminal 仍可继续发送 repoRelPath,不要求一次性全量改造.

## 取舍原因与演进方向

### 为什么不直接把 GitTarget 扩展为 workspaceRoot

- 扩展 GitTarget 会触发全仓 `target.dirName` 的收窄处理,改动面大且回归风险高.
- files 与 git 的 target 语义并不完全一致,合并到一个 union 会提高耦合度.
- 独立 workspace files API 更容易演进:
  - 未来可引入权限分级(只读/读写).
  - 可引入更细的审计或限制策略.

### 与后续能力的关系

- workspace 全局搜索:
  - 可在本方案的 `/api/workspaces/:workspaceId/files/search` 基础上实现.
  - 需要额外注意 `.git` 在多 repo 下为嵌套目录,建议强制 exclude `**/.git/**`.
- 终端点击 `repo/path:line`:
  - 有了 workspaceRelPath 语义后,终端可放开"其他 repo dirName 过滤",直接打开对应文件.
  - 但仍建议保留后端 stat 校验,避免误识别跳转.

## 验收标准(建议)

- 不选择 repo 时,File Explorer 仍可正常浏览 workspace 根目录并打开文件.
- 在 workspace 根目录:
  - 可新建文件/文件夹,可编辑并保存.
  - 可重命名与删除普通文件/文件夹.
- 顶层 repo 目录:
  - 无法被删除.
  - 无法被重命名.
- rename:
  - 同一 repo 内的 rename 可用.
  - workspace 根的 rename 可用.
  - 任意跨域 rename 会被拒绝.
- `files.openAt`:
  - 从 Search/Terminal 触发的 repoRelPath 仍可打开(通过 targetAtCall 补全).
  - 直接传 workspaceRelPath(包含 repo 前缀)也可打开.

