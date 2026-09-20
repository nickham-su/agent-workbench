# 当前代码引用与实施锚点

本文件记录方案形成时的源码事实，供实施前复核。行号是调研版本的大致位置，代码移动后应优先按符号名定位。

## 前端：会话 Tab 当前实现

### `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

| 符号 / 区域 | 约行号 | 当前事实 | 实施关联 |
|---|---:|---|---|
| `ACTIVE_KEY_STORAGE_PREFIX`、`AGENT_PICK_STORAGE_PREFIX` | 228–229 | active Tab 与 Agent 暂选的 localStorage key。 | 保留本地。|
| `CLOSED_SESSION_STORAGE_PREFIX`、`OPENED_SUBTASK_SESSION_STORAGE_PREFIX` | 230–231 | opened/closed 集合的 localStorage key。 | 删除或停止使用。|
| `serverSessions`、`draftSessions`、`activeKey`、`closedSessionIds`、`openedSubtaskSessionIds`、`tabNoMap` | 237–246 | 当前会话、草稿、展示集合和编号状态。 | 用后端覆盖/乐观状态替换 opened/closed 权威来源；其余按边界保留。|
| `visibleSessions` | 292–315 | 主会话默认显示，子任务须显式打开，所有 Session 受关闭集过滤。 | 保持业务规则，改为从状态 helper 派生。|
| `activeKeyStorageKey()`、`agentPickStorageKey()` | 317–327 | 本地设备偏好 key。 | 保留。|
| `closedSessionStorageKey()`、`openedSubtaskSessionStorageKey()` | 329–339 | opened/closed key 组装。 | 移除。|
| `reconcileTabNoMap()` | 341–392 | 按可见 Tab 分配可复用编号。 | 必须在关键双读成功、可见性同步应用后调用。|
| `persistClosedSessions()`、`persistOpenedSubtaskSessions()` | 405–430 | 写入 localStorage。 | 移除。|
| `restorePersistedState()` | 433–481 | 恢复 active、Agent 暂选、opened/closed。 | 保留前两类恢复，删除 opened/closed 分支。|
| `refreshSessions()` | 804–890 | 读取 Session list，处理 title 并发保护，prune 本地集合，分配编号。 | 改为与 Tab state 并行、关键响应暂存，并推迟最终可见性协调。|
| `refreshAll()` | 893–896 | 目前并行 agents + sessions，返回 session 是否成功。 | 扩展/替换为完整初始化协调；Agent options 非关键门槛。|
| `createOneSession()` | 915–942 | 创建内存草稿并激活。 | 只在初始化 ready 后可被普通入口调用；草稿不调用 Tab API。|
| `ensureSessionCreated()` | 944–1005 | 首次发送将草稿替换为真实 Session，并迁移本地状态。 | 增加“创建中已关闭草稿”向真实 ID 转交关闭 intent。|
| `closeSessionTab()` | 1008–1035 | 当前只本地关闭并可能创建草稿。 | 真实 Session 进入单飞 visibility queue；草稿仅本地。|
| `onSessionForked()` | 1037–1047 | fork 后重开/激活 Session。 | 真实 Session 显示意图应写后端。|
| `onOpenSubtask()` | 1049–1061 | 当前打开子任务并持久化本地集合。 | 改为 `visible=true` 单飞写入。|
| `activateParentSessionTab()` | 1063–1071 | 当前重开主会话。 | 改为 `visible=true` 单飞写入。|
| Workspace `watch(() => props.workspaceId, ...)` | 1209–1260 | 重置、恢复 localStorage、刷新后在无可见 Tab 时创建草稿。 | 改为 `loading/ready/error` 门控、`workspaceGeneration` 生命周期隔离和 `initializationAttemptId` 关键双读暂存；仅 ready 同步提交后建草稿。|
| `onActivated()` | 1263–1299 | 未初始化时刷新列表重试；已初始化无可见 Tab 时建草稿。 | 仅 error/未完成完整初始化时触发双读重试；ready 的 KeepAlive 激活不读取。PUT 404 不得走此重试路径。|
| `onMounted()` | 1301–1303 | 再次调用 `restorePersistedState()`。 | 不得再恢复 opened/closed 状态。|
| 状态 store `syncSessions()` watch | 1305–1317 | 向运行状态 store 同步可见/注册 Session。 | 仅在 ready 同步提交后对普通可见 Tab 生效。|

### `apps/web/src/features/workspace/views/WorkspaceLayout.vue`

| 符号 / 区域 | 约行号 | 当前事实 | 边界 |
|---|---:|---|---|
| `DOCK_LAYOUT_STORAGE_KEY_PREFIX` | 397 | Dock 布局 localStorage key。 | 不纳入本需求。|
| `DockLayoutV3` | 400–408 | 包含工具区域、最小化、活跃工具、顺序与比例。 | 不后端化。|
| `dockLayoutStorageKey()` | 410–414 | 按 Workspace 存储布局。 | 保持不变。|

### 前端 API 与路由

| 文件 | 符号 / 约行号 | 当前事实 |
|---|---|---|
| `apps/web/src/shared/api/api.ts` | `listAgentSessions()`，约 1108–1117 | Agent Session 列表请求封装。新增 Workspace Tab GET/PUT 应在 Workspace API 区域按既有模式放置。|
| `apps/web/src/app/router/index.ts` | Workspace 路由约第 20 行 | 路由只有 `workspaceId`，不表达 Session Tab 可见性或激活状态。|

## 后端：Agent Session 与现有 API

### `apps/api/src/modules/agent/routes/agent-public.routes.ts`

| 路由 / 符号 | 约行号 | 当前事实 | 边界 |
|---|---:|---|---|
| `GET /api/agent/sessions` | 319–337 | 以 `workspaceId` 返回全部 `AgentSessionRecord`。 | Session list 仍使用它；不在响应内加入 Tab 状态。|
| `POST /api/agent/sessions` | 424–444 | 创建主会话。 | 草稿首次发送仍走它。|
| model override DELETE | 396–422 | 删除某 Agent 的模型覆盖，不是删除 Session。 | 不可误用为关闭 Tab。|
| cancel 路由 | 约 828 之后 | Session 取消运行是独立路由。 | Tab 关闭禁止调用。|

### `packages/shared/src/contracts/agent.ts`

| 符号 | 约行号 | 当前事实 |
|---|---:|---|
| `AgentSessionRecordSchema` | 89–102 | 包含 Session ID、Workspace、标题、kind、fork 信息、消息指针、revision 和时间；不含 UI visible/closed/tab order。|

### `apps/api/src/modules/agent/agent-message.store.ts`

| 符号 | 约行号 | 当前事实 | 设计结论 |
|---|---:|---|---|
| `getMessageSession(db, workspaceId, sessionId)` | 约 372 | 以 Workspace + Session 查询业务 Session。 | 证明数据模型可联合校验；新 Workspace store 使用更小的本地 SQL，不导入整个 Agent store。|
| `listMessageSessions(db, workspaceId)` | 约 379–380 | 按 Workspace 列 Session。 | GET 状态查询必须同样限定 Workspace。|

## 后端：数据库与生命周期

### `apps/api/src/infra/db/schema.ts`

| 符号 / 区域 | 约行号 | 当前事实 | 实施要求 |
|---|---:|---|---|
| `createBaseSchema(db)` | 237–328 | 建立 Workspace、终端、settings 等基础表；settings 位于约 314–318。 | 新表加入此函数，不加额外 `(workspace_id, updated_at)` 索引。|
| `AGENT_DOMAIN_TABLES` | 330–347 | Agent 域删除/重建对象列表。 | 不加入本表。|
| `TARGET_AGENT_TABLES` / `TARGET_AGENT_TABLE_COLUMNS` | 379–407 | 严格 Agent 目标 schema。 | 不加入本表。|
| `listAgentSchemaObjects()` | 411–417 | 匹配 `agent_%` 或 `session_run_state`。 | 表名不能 `agent_` 开头。|
| `initSchema()` | 1026–1045 | 先分类，再每次创建基础 schema；必要时重建 Agent 域。 | 依赖其 `create table if not exists` 升级行为。|

### Workspace 删除与 mutation gate

| 文件 | 符号 / 约行号 | 当前事实 | 实施要求 |
|---|---|---|---|
| `apps/api/src/modules/workspaces/workspace.service.ts` | `deleteWorkspace()`，851–862 | 文件域清理后，在 SQLite transaction 内删除 Agent 数据、repo、terminal、Workspace。 | Workspace FK cascade 清理本表；加入测试。|
| `apps/api/src/infra/locks/workspace-lifecycle-coordinator.ts` | `withMutation()`，45–49 | 以 admission 串行删除 fence check 与可变副作用。 | PUT 必须使用。|
| `apps/api/src/modules/workspaces/workspaces.routes.ts` | `registerWorkspacesRoutes()`，48 起 | Workspace routes 与 `WorkspaceIdParamsSchema`。 | 新 API 在此注册并实现局部 unknown-field preValidation。|
| `apps/api/src/modules/workspaces/workspace.service.ts` | `updateWorkspaceAgentEnablementSettings()`，1378–1413 | 现有 Workspace mutation 使用 coordinator。 | 参考服务模式；本需求不需要 file/workspace lock。|

## 测试基础设施与实际入口

| 文件 | 符号 / 约行号 | 可复用用途 |
|---|---|---|
| `apps/api/src/infra/db/schema.test.ts` | `createDb()`，14–19 | schema 单测的 SQLite fixture。|
| `apps/api/src/infra/db/schema.test.ts` | `insertWorkspace()`，27–31 | 插入 Workspace fixture。|
| `apps/api/src/infra/db/schema.test.ts` | `insertSession()`，33–37 | 插入 Agent Session fixture。|
| `apps/api/src/infra/db/schema.test.ts` | `snapshotAgentObjects()`，384–401 | 验证基础表没有落入 `agent_%` schema 识别范围。|
| `apps/api/src/modules/workspaces/workspace.service.test.ts` | AppContext fixture，约 80–147 | service 层真实 SQLite 测试模式。|
| `apps/api/src/modules/agent/testkit/agent-testkit.ts` | `createAgentTestFixture()`，153–260 | API/Agent 集成测试 fixture。|
| `apps/api/src/modules/agent/testkit/agent-integration-testkit.ts` | `createTestWorkspace()`，21–67 | Workspace 集成测试创建辅助。|
| `apps/api/scripts/run-tests.mjs` | 8–32 | `npm run test -w apps/api` 按 unit、integration、worker 发现和运行 `src/**/*.test.ts`。|
| `apps/api/scripts/verify-test-gate.mjs` | 3–15 | API test 会先校验既有必需文件；新增 Tab 测试由运行器自动发现，无需修改该 gate。|
| `apps/web/scripts/run-tests.mjs` | 9–25 | `npm run test -w apps/web` 自动发现非 `.component.test.ts` 的 `src/**/*.test.ts`，随后调用组件 runner。|
| `apps/web/scripts/run-component-tests.mjs` | 7–23 | 组件测试采用固定列表；必须把新 `AgentToolView.component.test.ts` 加入 `tests` 数组，否则文件不会执行。|

## 代码引用使用规则

- 实施前先以符号名确认行号仍然有效；本文行号用于定位，不是不可变接口。
- 任何实现若需要偏离本文件列出的“明确不应修改”边界，必须在代码审查中说明为何无法保持既有模块边界，并同步更新设计文档。
- 不得根据本设计引用误以为可以修改现有 Agent 域 schema、内部 SSE 或 Dock 布局；这些对象仅用于说明边界。
