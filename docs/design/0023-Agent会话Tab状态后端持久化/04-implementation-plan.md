# 开发任务拆分与实施步骤

## 实施原则

- 先建立共享契约与后端持久化边界，再接入前端；任何阶段不得短暂将 UI 字段塞入 `agent_session`。
- 每个阶段完成后执行对应最小自检，再进入下一阶段。
- 前端切换持久化来源时必须整体替换 opened/closed 的读写路径，不能让 localStorage 与后端状态并存为双权威。
- 在前端行为接入前先完成纯状态逻辑测试，尤其验证单 Session 单飞、未知提交补偿与初始化门控。

## 任务一：共享契约与 API 类型

### 涉及文件

```text
packages/shared/src/contracts/workspaces.ts
packages/shared/src/index.ts
```

### 实施内容

- 新增 GET 响应 `WorkspaceAgentTabStateSchema`，只包含 `workspaceId`、`closedSessionIds`、`openedSubtaskSessionIds`。
- 新增 PUT body `UpdateWorkspaceAgentSessionTabVisibilityRequestSchema`，设置 `{ additionalProperties: false }`。
- 新增路径参数 `WorkspaceAgentSessionTabStateParamsSchema`。
- 新增 PUT 精简响应 `WorkspaceAgentSessionTabVisibilityMutationSchema`，只包含 `workspaceId`、`sessionId`、`visible`。
- 不在 GET/PUT 公共契约中加入 `updatedAt`；数据库时间仅作诊断。
- 导出 schema 与 TypeScript 类型。

### 产物与完成定义

- 前后端不再通过手写匿名对象约定 Tab 状态。
- GET 完整状态和 PUT 单 Session mutation 响应的职责清晰、类型可用。
- 共享包构建成功。

### 审查关注点

- `visible` 必须为 boolean，不接受数字、字符串或可选字段。
- TypeBox 保留 `additionalProperties: false`，但它不是未知字段拒绝的唯一运行时保障。
- PUT 响应必须是单 Session 精简结果，不能错误设计为全量集合覆盖。

## 任务二：基础数据库 schema 与 Store

### 涉及文件

```text
apps/api/src/infra/db/schema.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts  # 新增
apps/api/src/infra/db/schema.test.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.test.ts  # 新增
```

### 实施内容

- 在 `createBaseSchema()` 增加 `workspace_session_tab_state`、check 约束、复合主键和 Workspace cascade 外键。
- 不增加 `(workspace_id, updated_at)` 索引；当前按 Workspace 读取由复合主键支持，GET 不以时间排序/增量读取。
- 不改 `AGENT_SCHEMA_VERSION`、`AGENT_DOMAIN_TABLES`、`TARGET_AGENT_TABLES`、`TARGET_AGENT_TABLE_COLUMNS`。
- Store 提供下列窄操作：
  - 查询一个 Session 在指定 Workspace 下的 `kind`。
  - 列出通过 join 过滤后的有效覆盖。
  - upsert 覆盖。
  - 删除覆盖。
  - 专用 Workspace existence 查询，供服务构造稳定 `WORKSPACE_NOT_FOUND`。
- Store SQL 参数化，禁止拼接 `workspaceId` 或 `sessionId`。

### 产物与完成定义

- 已存在 SQLite 数据库下启动后会创建基础表。
- 该表不会被 Agent schema 分类为 Agent 域对象。
- 删除 Workspace 时状态自动清理。
- Agent Session 不存在时表行不会影响有效读取。

### 审查关注点

- 表名必须是 `workspace_session_tab_state`，不能以 `agent_` 开头。
- 只允许 Workspace FK `on delete cascade`；禁止为 `session_id` 建 FK。
- `visible` 必须有 `check (visible in (0, 1))`。
- 查询必须 join `agent_session` 并以 `workspace_id` 同时关联，不得只 join Session ID。

## 任务三：Workspace Service 与 HTTP Routes

### 涉及文件

```text
apps/api/src/modules/workspaces/workspace.service.ts
apps/api/src/modules/workspaces/workspaces.routes.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.test.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.integration.test.ts  # 新增或等价扩展
```

### 实施内容

- 在 Workspace service 实现读状态和单 Session `visible` 设值。
- 使用专用窄 Workspace 查询/helper 构造 `WORKSPACE_NOT_FOUND`，不改变公共 `getWorkspaceById()` 的既有错误响应。
- GET 前验证 Workspace 存在；返回有效关闭主会话 ID 和已打开子任务 ID。
- PUT 用 `workspaceLifecycleCoordinator.withMutation(workspaceId, ...)` 包裹。
- PUT 内部在同一个 SQLite transaction 中完成：Workspace 存在校验、Session 归属与 kind 查询、规范化 upsert/delete、构造精简响应。
- 在 `workspaces.routes.ts` 内为本接口新增局部窄 `preValidation` helper，直接检查原始 body 的 keys。除 `visible` 外任何字段都返回 `400 WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`；不得导入 Agent route 的私有 helper。
- Route 使用 TypeBox schema，并在 OpenAPI tags 中使用 `workspaces`。
- PUT 对未知/跨 Workspace Session 返回稳定的 `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`；不要泄露该 Session 是否存在于其他 Workspace。

### 产物与完成定义

- GET 空状态返回两个空数组。
- PUT 重复调用具有幂等状态语义。
- Workspace 删除 intent 生效时，PUT 不会穿透写入。
- 现有 `/api/*` 鉴权自动生效。
- 错误码稳定且可由路由集成测试断言：`WORKSPACE_NOT_FOUND`、`AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`、`WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`、既有 `WORKSPACE_DELETING`。

### 审查关注点

- API 必须在 Workspace routes，不放进 `agent-public.routes.ts`。
- 读 API 不因悬空/无意义行而报错或返回无效 ID。
- PUT 不允许整组数组覆盖、不能仅用 Session ID 校验。
- 未知字段拒绝不能只依赖 TypeBox，必须有局部 `preValidation` 原始 key 检查。
- 不因这个纯 DB mutation 引入文件锁、Git 锁、tmux 锁或 SSE。

## 任务四：前端 API、状态 helper 与单元测试

### 涉及文件

```text
apps/web/src/shared/api/api.ts
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts  # 新增
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.test.ts  # 新增
```

### 实施内容

- 增加 GET 与 PUT API 包装，复用既有请求与错误处理基础设施。
- 将默认值推导、覆盖应用、单 Session 单飞队列、intent 序号、Workspace 生命周期有效性和草稿真实 ID 转交提取到纯 TypeScript helper。
- helper 不直接访问 Vue ref、DOM、`localStorage` 或全局 `message`；错误展示、当前 context 和网络函数由 View 注入。
- 同一 Session 必须使用统一对象结构：`confirmed?: boolean`、`nextIntentSeq: number`、`desired?: { visible, intentSeq }`、`inFlight?: { visible, intentSeq }`；可额外加入错误提示去重字段，但不得使用平铺的 target/intentSeq 状态字段。
- 在途请求后有较新 intent 时，无论旧请求成功或失败，都必须排队发送一次最新意图；不可因值等于 `confirmed` 跳过。
- 最后 intent 请求失败且其间无更晚 intent 时，清理 pending、回滚到 confirmed/default、仅提示一次；禁止无限自动重试。
- PUT 回调只校验 `workspaceGeneration`、`workspaceId`、`disposed`；不得用同 Workspace 的 `initializationAttemptId` 废弃或阻塞写队列。
- PUT 404 与其他最终 mutation 失败相同：只回滚并提示对应 Session，禁止自动 GET、完整初始化或影响其他 Session。

### 产物与完成定义

- 纯测试可以无组件挂载地证明 click intent 的排队、合并、网络未知提交补偿、最终失败回滚、Workspace 生命周期失效忽略和草稿转交。
- 单个 Session 任意连续操作后，队列最多只有一个在途请求。
- 任意旧回调不能覆盖该 Session 更新后的 desired。
- PUT 404 不会请求 GET、递增 `initializationAttemptId`、改变初始化门控或干扰另一 Session 的在途队列。

### 审查关注点

- 不可将每次点击直接映射为独立 `void PUT`。
- 不可只用 mutation version 解决并发。
- 不可用 `desired === confirmed` 优化跳过在途请求后的补偿 PUT。
- 不可保留分离的目标值、意图序号或布尔在途标记等平铺核心状态；必须使用统一对象结构。
- 不可把 PUT 404 当成初始化失败或隐式完整刷新信号。
- 不可将完整 GET/PUT 响应整体覆盖仍有 pending 的其他 Session。

## 任务五：AgentToolView 初始化门控与交互接入

### 涉及文件

```text
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts  # 新增
apps/web/scripts/run-component-tests.mjs
apps/web/src/shared/api/api.ts
```

### 实施内容

- 新增 `initializationStatus = loading | ready | error` 模板门控。
- `loading/error` 期间不渲染普通 Tabs、普通空态或新建 Tab 按钮；error 显示错误与显式重试入口。
- Workspace watcher 对每轮完整初始化并行加载 Session list、Tab state、Agent options，将双关键响应暂存并在 `workspaceGeneration + initializationAttemptId` 有效后同步提交。
- 只有关键双读都成功后，依次 prune、active fallback、Tab 编号、status store、必要时创建本地草稿，最后切为 `ready`。
- Agent options 失败不阻塞 Tab 初始化。
- 已 ready 的 KeepAlive 工具再次激活不读取；初始化 `error` 时再次激活可启动完整重试；页面刷新、组件重新挂载、切换 Workspace、显式重试也启动完整读取。
- `workspaceGeneration` 只隔离 Workspace 生命周期与 PUT；同 Workspace 的 error 态初始化重试只递增 `initializationAttemptId`，PUT 回调不得检查后者。
- 替换 `closedSessionIds` / `openedSubtaskSessionIds` 的持久化来源为 helper 派生状态。
- 删除 opened/closed 的 key 常量、key 函数、persist 函数、恢复函数分支和调用点；保留 activeKey、Agent 暂选及其 localStorage 逻辑。
- 关闭已有 Session、打开子任务、重开父会话和 fork 后显示 Session 均通过 `requestVisibility()` 进入单飞队列。
- 草稿关闭保持本地；创建中草稿关闭要在拿到真实 Session ID 后转交为真实 Session 的关闭 intent。
- PUT 失败时根据 helper 仅回滚对应 Session 并显示现有 UI 轻提示；404 不触发 GET、完整初始化、草稿创建或其他 Session 状态变化。服务端 Session 删除等事实仅在下一次规定的完整初始化双读中收敛。
- 将新 `AgentToolView.component.test.ts` 加入 `run-component-tests.mjs` 的固定 `tests` 数组，确保 `npm run test -w apps/web` 会执行它。

### 产物与完成定义

- Session list 慢/快、Tab state 慢/快都不会在 ready 前造成普通主会话、新建入口或空态闪烁。
- 关键 GET 失败显示 error 门控，不创建草稿；显式重试或失败后的激活才重试。
- 普通 KeepAlive 激活不产生额外 GET。
- ready 状态下 PUT 404 不产生 GET 或完整初始化，不改变 `initializationStatus`，不影响另一 Session 的写入队列。
- 用户点击后的 UI 立即可见，失败可解释、可恢复，恢复的非 active Tab 不抢焦点。
- 新组件测试实际由 `npm run test -w apps/web` 执行。

### 审查关注点

- 不得保留 opened/closed localStorage 作为 fallback 或双写副本。
- Tab state GET 失败不能静默显示默认主会话。
- Workspace 切换/卸载后旧异步回调不能修改新的 reactive 状态或弹出错误。
- 关闭最后一个可见 Session 后的失败回滚不得丢弃用户草稿内容，且恢复 Tab 只在 activeKey 无效时 fallback。

## 任务六：集成验证、回归与文档核对

### 涉及文件

- 仅测试文件、组件测试脚本及本文档明确列出的实现文件；不应牵连 Agent 运行、SSE、终端或 Dock 实现。

### 实施内容

- 运行共享包构建、API/Web 类型检查和全部相关测试。
- 使用浏览器或 API fixture 验证不同 profile/设备的完整初始化恢复。
- 对照 `05-review-and-acceptance.md` 完成验收记录。
- 复核 OpenAPI 中 GET/PUT schema、稳定错误码和 tags。

### 产物与完成定义

- 所有自动测试、类型检查与手工验收通过。
- 审查清单没有未解释的偏差。
- 不存在为“方便实现”而新增的实时同步、Session UI 字段、session FK、updatedAt API 字段或时间索引。

## 准确自检命令

在仓库根目录执行：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test -w apps/api
npm run test -w apps/web
npm run typecheck
```

命令依据当前脚本：

- `apps/api` 的 `test` 会执行 `verify-test-gate`、unit、integration、worker 三组测试。
- `apps/web` 的 `test` 会发现所有非 `.component.test.ts` 的 `src/**/*.test.ts`，然后执行 `scripts/run-component-tests.mjs` 固定列表。
- 因此新增 `AgentToolView.component.test.ts` 必须加入该固定列表；仅创建文件不足以获得测试覆盖。

## 预计变更文件总表

### 必改

```text
packages/shared/src/contracts/workspaces.ts
packages/shared/src/index.ts
apps/api/src/infra/db/schema.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts
apps/api/src/modules/workspaces/workspace.service.ts
apps/api/src/modules/workspaces/workspaces.routes.ts
apps/web/src/shared/api/api.ts
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/scripts/run-component-tests.mjs
```

### 应新增或扩展测试

```text
apps/api/src/infra/db/schema.test.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.store.test.ts
apps/api/src/modules/workspaces/workspace-session-tab-state.integration.test.ts
apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.test.ts
apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts
```

### 明确不应修改

```text
apps/api/src/modules/agent/agent-message.store.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/routes/agent-public.routes.ts
apps/api/src/modules/agent/routes/agent-status-sse.routes.ts
apps/web/src/features/workspace/views/WorkspaceLayout.vue
```

若实际代码组织要求最小的只读 import，须在审查中说明；不得借本需求重构 Agent 运行链路或 Dock 布局。
