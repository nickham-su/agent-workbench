# 技术架构、数据模型与接口设计

## 架构边界

```text
浏览器 AgentToolView
  ├─ GET Workspace Tab State ───────────────┐
  ├─ GET Agent Sessions ────────────────────┼─> Workspace routes / service / store ─> SQLite
  ├─ GET 可选 Agent ────────────────────────┘
  └─ PUT 单个 Session visible ──────────────> Workspace lifecycle mutation gate ─> SQLite
```

- UI 状态的资源归属是 Workspace，因此 HTTP 路由、服务和 store 位于 `modules/workspaces`。
- Session 的业务运行、消息和创建仍由 `modules/agent` 管理，不迁移、不改写其既有职责。
- API 使用现有 `/api/*` 认证机制；不得引入内部 Worker token 或绕过浏览器认证。
- 后端只有 SQLite 持久化；没有缓存层、事件总线或后台同步任务。

## 数据库设计

### DDL

在 `apps/api/src/infra/db/schema.ts` 的 `createBaseSchema(db)` 中增加：

```sql
create table if not exists workspace_session_tab_state (
  workspace_id text not null,
  session_id text not null,
  visible integer not null check (visible in (0, 1)),
  updated_at integer not null,
  primary key (workspace_id, session_id),
  foreign key (workspace_id) references workspaces(id) on delete cascade
);
```

不增加 `(workspace_id, updated_at)` 额外索引：复合主键 `(workspace_id, session_id)` 已支持本需求的按 Workspace 查询。当前 GET 不按时间排序、分页或增量同步，`updated_at` 不参与查询计划；额外索引没有可验证收益。

### 记录规范化规则

| Session kind | API 请求 | 数据库动作 | 有效记录 |
|---|---|---|---|
| `primary` | `visible=false` | upsert `visible=0` | 关闭主会话。|
| `primary` | `visible=true` | delete | 无记录即默认显示。|
| `subtask` | `visible=true` | upsert `visible=1` | 打开子任务。|
| `subtask` | `visible=false` | delete | 无记录即默认隐藏。|

禁止保留 `primary + visible=1` 和 `subtask + visible=0` 这两类无意义覆盖。写服务必须执行删除而不是写入这些值。

### `updated_at` 的限定语义

- 数据库保留 `updated_at`，用于排障、手工诊断和未来确有需求的内部维护。
- GET 和 PUT 的公共响应均不暴露 `updatedAt`，前端不使用它决定响应顺序、覆盖状态或同步新旧。
- 删除覆盖会移除该行，因而不存在可作为全局或 Workspace 单调版本的可靠时间戳；本需求不引入 revision、ETag 或 `If-Match`。

### 外键与清理策略

#### 必须有 Workspace 外键

`workspace_id` 必须引用 `workspaces(id) on delete cascade`：

- 当前 Workspace 删除最终在 `workspace.service.ts` 的 `deleteWorkspace()` 事务中删除 Workspace 记录。
- Cascade 保证该 UI 表不阻塞删除，也不会留下无 Workspace 的记录。
- 不需另加显式清理步骤，但必须测试 cascade 生效。

#### 禁止对 Session 建外键

`session_id` **不得**引用 `agent_session`：

- Agent 域表会根据版本分类并可整体清空重建；基础 UI 表依赖 Agent 表会把重建流程与 UI 状态耦合。
- `ON DELETE RESTRICT` 可能阻塞未来 Session 删除或 Agent 域清理。
- 即使使用 CASCADE，也会使基础域跨域依赖 Agent 域，增加严格 schema 升级路径的耦合。

读路径使用 join 忽略悬空状态；写路径先校验 Session 当前属于 Workspace。Agent 域重建或未来 Session 删除后留下的悬空行不影响任何可见性结果，MVP 不做专用清理任务。

### 基础 schema 升级约束

- `initSchema()` 每次调用 `createBaseSchema()`；对已存在数据库，`create table if not exists` 会在启动时创建本表。
- 本表是基础域表，绝不能加入 `AGENT_DOMAIN_TABLES`、`TARGET_AGENT_TABLES` 或 Agent schema version。
- 表名不得以 `agent_` 开头。`listAgentSchemaObjects()` 对 `agent_%` 有严格识别；错误命名可能将正常基础表判成未知 Agent schema。
- 该表需在 `schema.test.ts` 中证明：创建成功、Workspace cascade 正常、Agent 域重建后仍保留且不造成 schema 不支持。

## Store、服务与事务

### 文件职责

新建 `apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts`：

- 使用窄 SQL 查询 Session 归属和 kind。
- 读取有效覆盖。
- 对单个 Session 执行 upsert 或 delete。
- 不依赖 Fastify、不处理 HTTP 错误、不执行 lifecycle admission。

在 `apps/api/src/modules/workspaces/workspace.service.ts` 新增服务函数：

```ts
getWorkspaceAgentTabState(ctx, workspaceId)
setWorkspaceAgentSessionTabVisibility(ctx, workspaceId, sessionId, payload)
```

### 读 SQL 与映射

读取必须先确认 Workspace 存在，随后只读取仍有业务语义的覆盖：

```sql
select state.session_id, state.visible, session.kind
from workspace_session_tab_state as state
join agent_session as session
  on session.id = state.session_id
 and session.workspace_id = state.workspace_id
where state.workspace_id = @workspaceId
  and (
    (session.kind = 'primary' and state.visible = 0)
    or (session.kind = 'subtask' and state.visible = 1)
  )
order by state.session_id asc;
```

映射结果：

- `primary + 0` 放入 `closedSessionIds`。
- `subtask + 1` 放入 `openedSubtaskSessionIds`。
- 无有效记录时返回两个空数组。

悬空 `session_id`、跨 Workspace 的 Session 和语义无效的覆盖均不得返回。读 API 不得因为这些历史残留失败。

### 稳定业务错误码与写入事务

本接口不得改变公共 `getWorkspaceById()` 的既有错误语义。新服务使用专用窄查询/helper，以稳定错误码构造 `HttpError`：

| 错误码 | HTTP | 来源与语义 |
|---|---:|---|
| `WORKSPACE_NOT_FOUND` | 404 | GET/PUT 的专用 Workspace existence 查询未命中。|
| `AGENT_SESSION_NOT_FOUND_IN_WORKSPACE` | 404 | PUT 的 `id + workspace_id` 联合查询未命中；不泄露该 ID 是否属于其他 Workspace。|
| `WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD` | 400 | PUT 路由 preValidation 发现原始 body 含 `visible` 之外字段。|
| 现有 `WORKSPACE_DELETING` | 409 | `workspaceLifecycleCoordinator.withMutation()` 的删除 fence 拒绝写入。|

写服务必须执行：

```ts
return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
  return ctx.db.transaction(() => {
    const workspace = requireWorkspaceForAgentTabState(ctx.db, workspaceId);
    const session = findSessionInWorkspace(ctx.db, workspace.id, sessionId);
    if (!session) throw agentSessionNotFoundInWorkspace();

    if (session.kind === 'primary' && !visible) upsertHiddenPrimary(...);
    else if (session.kind === 'subtask' && visible) upsertOpenedSubtask(...);
    else deleteVisibilityOverride(...);

    return { workspaceId: workspace.id, sessionId: session.id, visible };
  })();
});
```

硬性要求：

- `withMutation()` 必须包住 Workspace existence check、Session ownership check 及 DB 写入，避免与 Workspace 删除 intent 产生 check-then-delete 窗口。
- Workspace、Session 归属校验和 upsert/delete 必须处于同一个 SQLite transaction。
- 不要从 Workspace 模块导入大型 Agent composition/service 来校验；新 store 使用精确条件 `where id = ? and workspace_id = ?` 的窄查询。
- `withWorkspaceLock` 不需要引入。该操作无文件系统、Git、tmux 或多步骤异步副作用；额外锁只增加不必要的串行范围。

## 共享契约与 HTTP API

### TypeBox 契约

在 `packages/shared/src/contracts/workspaces.ts` 定义并从 `packages/shared/src/index.ts` 导出：

```ts
export const WorkspaceAgentTabStateSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  closedSessionIds: Type.Array(Type.String({ minLength: 1 })),
  openedSubtaskSessionIds: Type.Array(Type.String({ minLength: 1 }))
});

export const UpdateWorkspaceAgentSessionTabVisibilityRequestSchema = Type.Object(
  { visible: Type.Boolean() },
  { additionalProperties: false }
);

export const WorkspaceAgentSessionTabStateParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 })
});

export const WorkspaceAgentSessionTabVisibilityMutationSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  visible: Type.Boolean()
});
```

`additionalProperties: false` 是 schema/OpenAPI 约束，但**不能单独作为运行时必定返回 400 的保证**。PUT 路由必须在 `preValidation` 对原始 body 执行局部窄检查：仅允许自有 key `visible`，发现任一其他 key 即抛 `HttpError(400, ..., "WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD")`。

为保持最小改动，这个检查实现为 `workspaces.routes.ts` 内仅供本路由使用的 helper，不导入 Agent route 私有 helper，也不为本需求重构通用 HTTP 层。

响应使用精简 mutation 结果，而不是完整集合：

- GET 返回当前有效覆盖的派生集合。
- PUT 仅确认本次 `workspaceId/sessionId/visible`。
- 客户端只可更新对应 `sessionId` 的确认状态，禁止将 PUT 响应或之后的完整 GET 快照整体覆盖仍有 pending 的其他 Session。

### Route 定义

在 `apps/api/src/modules/workspaces/workspaces.routes.ts` 注册：

```text
GET /api/workspaces/:workspaceId/agent-tab-state
PUT /api/workspaces/:workspaceId/agent-tab-state/:sessionId
```

| 接口 | 成功 | 错误语义 |
|---|---|---|
| GET | `200 WorkspaceAgentTabStateSchema` | `404 WORKSPACE_NOT_FOUND`。|
| PUT | `200 WorkspaceAgentSessionTabVisibilityMutationSchema` | `400 WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD` 或 schema body 错误；`404 WORKSPACE_NOT_FOUND` / `AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`；`409 WORKSPACE_DELETING`。|

细则：

- 使用 Fastify route schema，保留 OpenAPI 可见性。
- PUT 的原始 body 附加字段必须由 `preValidation` 拒绝，不能悄悄忽略。
- PUT 是幂等操作：对同一个 Session 重复设同一个 `visible` 得到相同持久化语义。
- API 继承现有 `/api/*` Cookie/Token 鉴权，不为此 API 添加匿名或 internal 特例。

## 前端状态设计

### 初始化模板门控

新增：

```ts
type InitializationStatus = "loading" | "ready" | "error";
const initializationStatus = ref<InitializationStatus>("loading");
```

模板必须按此值分支：

| 状态 | 允许渲染 | 禁止渲染 |
|---|---|---|
| `loading` | 专用加载骨架/加载提示。 | 普通 Tabs、普通空态、新建 Tab 按钮。|
| `error` | 明确错误说明、显式“重试”入口。 | 普通 Tabs、普通空态、新建 Tab 按钮。|
| `ready` | 正常 Tabs、关闭操作、普通新建入口及现有草稿逻辑。 | 初始化错误占位。|

`ready` 前不得向状态 store 同步普通可见 Tab，不得创建草稿。重试入口触发当前 Workspace 的一轮完整初始化；它不是定时轮询。

### 本地状态结构

推荐将可测试逻辑提取到纯 TypeScript helper。每个真实 Session 的状态应至少包含：

```ts
type SessionWriteState = {
  // 最后收到与请求一致的 HTTP 2xx 响应的明确状态；未定义即按 kind 默认值。
  confirmed?: boolean;

  // 仅用户产生真实 Session 打开/关闭意图时递增，整个组件生命周期内单调递增。
  nextIntentSeq: number;

  // 尚未明确完成的最后用户意图。
  desired?: {
    visible: boolean;
    intentSeq: number;
  };

  // 同一 Session 的唯一在途 PUT 快照。
  inFlight?: {
    visible: boolean;
    intentSeq: number;
  };
};
```

可见性计算：

```ts
const defaultVisible = session.kind === "primary";
const visible = state.desired?.visible ?? state.confirmed ?? defaultVisible;
```

`confirmed` 只表示收到与当前 PUT target 一致的明确 HTTP 2xx 响应后的值，不能从超时/网络错误推导服务端未提交。初始化成功时，helper 从 GET 的有效覆盖和 Session kind 默认规则建立初始 confirmed 值。`desired` 保持最后用户意图，直到它被**同序号请求**明确成功确认，或该最后意图请求明确失败且没有更晚意图时才清除。

可在外围增加仅用于“每个最终失败 intent 只提示一次”的字段，但不得替代或改名上述核心字段。

### 初始化协调与 generation 隔离

必须区分两个互不替代的代次：

- `workspaceGeneration`：仅在 Workspace 生命周期切换或组件销毁导致当前 Workspace 上下文失效时变化。所有 PUT 发起时绑定它与 `workspaceId`；PUT 回调只检查 `workspaceGeneration`、`workspaceId`、`disposed`，**不检查初始化尝试 ID**。
- `initializationAttemptId`：仅标识同一 Workspace 的每次关键 GET 初始化尝试，用于丢弃旧的 Session list / Tab state 双读响应。显式重试只会在 `initializationStatus=error` 时发生，不得令已经 ready 的 PUT 队列失效或卡住。

每次新的完整初始化递增 `initializationAttemptId`：

```text
设置 initializationStatus=loading
  ↓
并行发起：Agent options、Session list、GET tab state
  ↓
将关键双响应暂存于本次 generation，不立即各自写入可见性状态
  ↓
确认 Session list 与 Tab state 均成功且 `workspaceGeneration`、`workspaceId`、`initializationAttemptId`、`disposed` 仍有效
  ↓
在同一同步提交段应用两份响应
  ↓
prune 无 Session 的内存覆盖与 write state；active fallback；Tab 编号；status store
  ↓
必要时创建本地草稿；最后设置 initializationStatus=ready
```

严格规则：

- Session list 与 Tab state 是两个关键门槛；Agent options 失败不阻塞 `ready`。
- 任一关键请求失败时，`initializationStatus=error`；不应用半份结果、不按默认规则建草稿、不标记 `sessionsInitialized`。
- 只有双响应都成功后才进行一次最终同步提交。慢响应期间模板保持 `loading`，因此不会先闪现主会话、普通空态或新建按钮。
- Session list / Tab state GET 回调写入前校验 `disposed`、`workspaceGeneration`、`workspaceId`、`initializationAttemptId`；旧初始化尝试或旧 Workspace 响应必须丢弃且不得弹旧错误。
- PUT 回调只校验 `disposed`、`workspaceGeneration` 与 `workspaceId`。同 Workspace 的 error 态初始化重试不得让已存在的 PUT 队列卡住、丢失 finally 清理或被错误丢弃。
- `activeKey` 可从本地恢复，但仅在 ready 提交时根据最终可见集合 fallback；若原 activeKey 指向已关闭/不存在 Tab，不得强行重开。
- 已成功初始化的 KeepAlive 工具在最小化、切换工具、再次 `onActivated()` 时不读取；只有页面刷新、组件重新挂载、Workspace 切换进入、显式重试或上次初始化为 `error` 时启动新一轮完整初始化。
- ready 状态下的 mutation 失败，包括 `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`，不得自动启动 GET、完整初始化或修改 `initializationAttemptId` / `initializationStatus`。它仅按该 Session 的单飞状态机回滚与提示；Session 已删除等服务端事实留给下一次规定的新一轮完整初始化收敛。
- 删除 opened/closed localStorage 恢复以及 `onMounted()` 对其二次恢复，防止旧 localStorage 覆盖后端结果。

## 前端 API 层

在 `apps/web/src/shared/api/api.ts` 增加：

```ts
getWorkspaceAgentTabState(workspaceId): Promise<WorkspaceAgentTabState>
setWorkspaceAgentSessionTabVisibility(
  workspaceId: string,
  sessionId: string,
  visible: boolean
): Promise<WorkspaceAgentSessionTabVisibilityMutation>
```

请求失败应保留现有 API 错误对象/错误码，使 `AgentToolView` 能显示用户可诊断的轻提示；禁止吞掉错误后仅写日志。
