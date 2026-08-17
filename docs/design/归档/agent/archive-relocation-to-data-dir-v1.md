# 归档文件迁移到服务数据目录(AWB_DATA_DIR)

Status: draft

## 背景

- 当前归档文件落在 workspace 目录内,路径形态为 `<workspace>/.awb/agent/archive/<sessionId>/00000001.log`.
- 系统已经提供完善的归档查询工具 `archive_search`/`archive_read`,它们通过服务端读取归档日志并返回纯文本,不依赖模型直接访问归档文件.
- workspace 目录的语义是“用户工作目录/代码工作区”.将系统归档落在 workspace 内会带来:
  - 工作区污染: `.awb/` 之外的系统文件仍可能被用户误解为项目文件.
  - 生命周期不清晰: workspace 删除时会被一并删除,但“归档作为系统审计数据”的语义更接近服务数据.
  - 多 workspace 的归档分布在各自工作目录,排障与运维不聚合.

本方案将归档文件迁移到服务运行目录(数据目录 `AWB_DATA_DIR` 派生目录)中,类似 apply_patch UI artifact 已采用的 dataDir 落盘方式(见 `apps/api/src/infra/fs/paths.ts`).

## 目标

- 归档文件不再写入 workspace 目录.
- 归档文件落在 `AWB_DATA_DIR` 下的稳定路径,便于运维与清理策略设计.
- 不改变对外行为:
  - 归档工具 `archive_search`/`archive_read` 的参数与输出格式不变.
  - DB 中 `archiveAt` 等字段语义不变.
- 不做旧数据兼容(未上线,允许一次性切换).

## 非目标

- 不设计归档清理/配额/压缩策略(仍按现有滚动分片策略写入).
- 不引入额外索引(FTS/向量检索).
- 不调整归档行格式与 pos 规则(仍为每文件固定 100 行,由工具侧计算 pos).

## 关键决策

- 路径方案: 方案A(长期保存,不走 tmp)
- 兼容策略: 不兼容旧数据

## 新路径约定(方案A)

### 目录结构

- 归档根目录(绝对路径):
  - `<dataDir>/agent/archive/`
- 单会话归档目录:
  - `<dataDir>/agent/archive/<workspaceIdSegment>/<sessionIdSegment>/`
- 归档文件:
  - `<dataDir>/agent/archive/<workspaceIdSegment>/<sessionIdSegment>/00000001.log`
  - 后续滚动: `00000002.log`, ...

说明:

- `<workspaceIdSegment>`/`<sessionIdSegment>` 使用与 apply_patch UI artifact 相同的安全清洗规则:
  - 仅允许 `[A-Za-z0-9._-]`,其他字符替换为 `_`.
  - 最大长度建议 120,超长截断.
- 归档路径由服务端内部计算,不允许客户端传入任意 path.

### 与现有实现的对齐点

- 现有归档实现位于 API 侧 `apps/api/src/modules/agent/agent.service.ts`:
  - 写入: clear/compaction/fork(with_archive)
  - 读取: archive_search/archive_read
- 现有“服务端内部文件路径”统一在 `apps/api/src/infra/fs/paths.ts` 维护,本方案应把归档路径计算也迁入该文件,避免在业务模块中手写路径.

## 实现方案

### paths.ts 增加归档路径 helper

在 `apps/api/src/infra/fs/paths.ts` 新增(命名仅建议):

- `agentArchiveRoot(dataDir: string)`
  - 返回 `<dataDir>/agent/archive`
- `agentArchiveSessionDir(dataDir: string, workspaceId: string, sessionId: string)`
  - 返回 `<dataDir>/agent/archive/<workspaceIdSegment>/<sessionIdSegment>`

其中 `workspaceId`/`sessionId` 必须做 safePathSegment 清洗,规则与 `applyPatchUiArtifactPath`/`writeUiArtifactPath` 一致.

### agent.service.ts 改造要点

将所有基于 workspacePath 的归档路径计算替换为 dataDir 计算,核心变化:

- 原 `archiveSessionDir(workspacePath, sessionId)` 改为 `agentArchiveSessionDir(dataDir, workspaceId, sessionId)`.
- 写入 `appendArchiveLines`:
  - 入参从 `{ workspacePath, sessionId }` 调整为 `{ dataDir, workspaceId, sessionId }` 或直接传入 `dirPath`.
  - `fs.mkdir(dirPath, { recursive: true })` 创建目录.
- 读取/搜索 `archiveSearchFromWorker`/`archiveReadFromWorker`:
  - `dirPath` 使用新 helper.
- 归档工具启用条件 `hasArchiveFiles`:
  - 从检查 workspace 下归档文件改为检查 dataDir 下归档文件.
- fork(with_archive) 失败回滚:
  - 删除归档目录时使用新 helper 计算路径.

### workspace 删除时的归档清理

迁移后归档不再位于 workspace 目录,因此 workspace 删除需要额外清理:

- 在 `apps/api/src/modules/workspaces/workspace.service.ts` 的 `deleteWorkspace(...)` 中:
  - 在删除 workspace 目录与删除 DB 记录的流程中,增加对 `<dataDir>/agent/archive/<workspaceIdSegment>/` 的递归删除.
  - 删除前必须做边界校验(路径必须落在 `path.resolve(dataDir)` 内),避免越界递归删除.

建议策略:

- 归档清理失败时的行为需要明确:
  - 推荐: 若归档目录删除失败,仍允许 workspace 删除继续完成(避免卡住主流程),同时记录 warn.
  - 理由: 归档属于附属数据,且 workspace 已删时,留存归档并不会破坏 DB 一致性.

### 安全与一致性约束

本方案不改变归档一致性不变量,只改变落盘位置:

- 不变量: 只要 session 存在 `archiveAt != null` 的 items,就必须保证归档工具可读取到对应归档内容.
- 写入顺序: 仍沿用现有“两阶段写入 + best-effort 回滚”策略:
  - 阶段1写文件,阶段2写 DB,DB 失败则尝试回滚文件.

路径安全:

- 路径由服务端内部构造,不接受客户端输入.
- 仍建议对归档根目录与会话目录在创建/读取时做基本的 lstat 校验:
  - 拒绝 symlink 目录(避免被引导到 dataDir 外)
  - 目录不存在视为无归档

## 测例更新

需要更新 `apps/api/src/modules/agent/agent.integration.test.ts` 中对归档文件路径的断言:

- 原本断言 `<workspacePath>/.awb/agent/archive/...` 的用例,改为断言 `<dataDir>/agent/archive/<workspaceId>/<sessionId>/...`.
- 测试中应尽量复用 `apps/api/src/infra/fs/paths.ts` 的新 helper 来构造预期路径,避免测试与实现路径规则漂移.

## 验证路径

建议最小验证覆盖以下场景(可由现有集成测试提供,并补充手动验证):

- clear:
  - clear 后旧消息 `archiveAt` 置位,且归档文件在 dataDir 下创建并包含旧对话行
  - prompt-context 不包含已归档内容,但系统 marker 提示可用 `archive_search`/`archive_read`
- compaction:
  - compaction 后归档文件存在
  - `archive_search`/`archive_read` 可命中归档内容
- fork(with_archive):
  - 新会话归档目录正确生成在 dataDir 下
  - 失败分支能清理新会话归档目录(避免脏数据)
- 工具启用条件:
  - 当 session 有 archived items 且 dataDir 下存在归档文件时,`archive_search`/`archive_read` 对模型可用

## 迁移与回滚策略(未上线场景)

- 不做旧数据兼容:
  - 切换后仅写入/读取新路径.
  - 旧 workspace 内的 `.awb/agent/archive` 不再被读取.
- 回滚(仅开发期):
  - 若需要临时回退,恢复旧路径实现即可.
  - 由于未上线且不需要兼容,不提供双写或自动迁移脚本.

## 后续可扩展点

- 将归档根目录纳入统一的“服务数据清理”策略(例如按 workspace 或按时间清理).
- 若未来上线后需要无缝升级,可引入读时 fallback:
  - 新路径不存在时尝试读取旧 workspace 路径(仅作为升级窗口期的临时兼容).
