# 测试验收标准与代码审查清单

## 验收前置

- 使用同一 agent-workbench 服务实例、同一 SQLite 数据目录的浏览器 profile 或设备进行跨端手工验证。
- 每项涉及后端写入的测试均使用已存在的后端 Agent Session，除非场景明确为草稿。
- 验收期间不得将“关闭 Tab”替换为 Agent cancel 或 Session delete 操作。
- 跨设备状态以目标端完成一轮**新一轮完整初始化**后的 GET 权威结果为准：页面刷新、组件重新挂载、切换进入该 Workspace、显式重试，或上次初始化失败后再次激活会触发；已 ready 的 KeepAlive 工具仅切换/最小化后激活不触发读取。
- 手工判断后端写入成功必须观察 PUT 的 `200` 响应，或通过下一次完整初始化的 GET 权威状态确认；不得以“提示消失”“页面状态稳定”等非协议现象作为通过依据。

## 自动测试矩阵

### 数据库 schema

| 场景 | 操作 | 可观测预期 |
|---|---|---|
| 基础表创建 | 初始化空 DB | 存在 `workspace_session_tab_state`，字段、复合主键、check 和 Workspace FK 正确。|
| `visible` 约束 | 尝试插入 `-1`、`2` 等非法值 | SQLite 拒绝写入。|
| Workspace FK | 尝试写入不存在 Workspace | SQLite 拒绝写入。|
| 无额外时间索引 | 检查 schema 对象 | 不存在 `(workspace_id, updated_at)` 专用索引；复合主键承担本需求查询。|
| Workspace 删除 | 写入状态后删除 Workspace | 状态行自动删除，删除过程不被状态表阻塞。|
| Agent 域重建 | 写入状态，再触发/构造 Agent 域重建 | 状态表仍是基础表，不导致 schema 被判 unsupported；悬空状态不影响后续 GET。|
| Agent schema 分类 | 初始化含本表的 DB | 不因本表出现未知 `agent_%` 对象错误。|

### Store 与 Service

| 场景 | 前置 | 操作 | 预期 |
|---|---|---|---|
| 初始读取 | Workspace 存在、无覆盖 | GET service | 两个空数组。|
| 关闭主会话 | 已有 primary | `visible=false` | 写入 `visible=0`；读到 ID 位于 `closedSessionIds`。|
| 重开主会话 | primary 已关闭 | `visible=true` | 删除行；读不到该 ID，按默认显示。|
| 打开子任务 | 已有 subtask | `visible=true` | 写入 `visible=1`；读到 ID 位于 `openedSubtaskSessionIds`。|
| 关闭子任务 | subtask 已打开 | `visible=false` | 删除行；读不到该 ID，按默认隐藏。|
| 幂等关闭/打开 | 同一有效操作重复 | 连续 PUT | 最终集合不重复，语义不变化。|
| 跨 Workspace | Session 属于另一 Workspace | PUT | `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`，无状态行写入。|
| Session 不存在 | 不存在 Session ID | PUT | `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`，无状态行写入。|
| Workspace 不存在 | 不存在 Workspace ID | GET/PUT service | `404 WORKSPACE_NOT_FOUND`，不改变公共 `getWorkspaceById()` 行为。|
| 悬空行 | 直接构造未关联 Session 的行 | GET | 不返回该 ID，不失败。|
| 无意义行 | 直接构造 primary+1 / subtask+0 | GET | 不返回；后续对应 PUT 规范化为删除或有效覆盖。|
| 删除 fence | 删除 intent 已建立 | PUT | `409 WORKSPACE_DELETING`，不能在删除后的 Workspace 留下可读取状态。|

### Route 集成与契约

| 场景 | 请求 | 预期 |
|---|---|---|
| GET 正常 | `GET /api/workspaces/:workspaceId/agent-tab-state` | `200`，仅含 `workspaceId`、两个 ID 数组。|
| PUT 正常 | `PUT .../:sessionId` body `{ "visible": false }` | `200`，仅返回该 Session 的 `workspaceId/sessionId/visible`。|
| body 附加字段 | body 含 `visible` 以外字段 | `400 WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`，由 route `preValidation` 原始 key 检查触发。|
| 非布尔 visible | `true` 以外类型且不含未知字段 | `400`，由 schema body 校验拒绝。|
| 不存在 Workspace | GET/PUT | `404 WORKSPACE_NOT_FOUND`。|
| 不属于 Workspace Session | PUT | `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`。|
| 鉴权 | 未认证 `/api` 请求 | 保持当前全局认证预期，拒绝访问。|
| OpenAPI | 拉取 `/api/openapi.json` | 两条路由有 `workspaces` tag、请求/响应 schema 和错误响应。|
| 时间字段边界 | GET/PUT 成功响应 | 不包含 `updatedAt` / `updated_at`。|

### 前端纯状态逻辑

测试应覆盖独立 helper，不依赖完整组件 mount：

| 场景 | 预期 |
|---|---|
| 无覆盖主会话 | `effectiveVisibility=true`。|
| 无覆盖子任务 | `effectiveVisibility=false`。|
| 成功关闭主会话 | 乐观隐藏，成功后 confirmed 为 false。|
| 成功打开子任务 | 乐观显示，成功后 confirmed 为 true。|
| close → open，第一请求迟到 | 任意网络完成顺序下，第二请求在第一结束后发送，最终服务端与 UI 都为 open。|
| open → close，第一请求失败 | 新 close intent 不回滚；最终继续发送 close，最终为 closed。|
| **服务端已提交但响应超时** | 初始 confirmed=open；close PUT 在服务端提交后客户端超时；在途出现 open intent，且值等于旧 confirmed。测试必须断言仍发送补偿 PUT open，最终服务端与 UI 为 open。|
| 最后 intent 失败 | 没有更晚 intent 时清除 desired，回退到 confirmed/default，只产生一次错误回调，不自动重试。|
| 补偿请求失败 | 有较新 intent 后发送的补偿 PUT 最终失败且无再更新，回退到最后明确 confirmed/default，只提示一次。|
| PUT 404 隔离 | 一个 Session 的 PUT 返回 `AGENT_SESSION_NOT_FOUND_IN_WORKSPACE` 或 `WORKSPACE_NOT_FOUND`。断言只清除/回滚该 Session 的 `desired/inFlight`，不发 GET、不启动完整初始化、不改变 `initializationStatus` 或 `initializationAttemptId`。|
| PUT 404 不干扰其他队列 | Session A PUT 404 时，Session B 已在途或排队的 intent 继续按其自身队列完成；B 的网络函数、desired/inFlight 与 UI 不被 A 影响。|
| 不同 Session | 可同时各有一条 in-flight 请求，互不阻塞。|
| Workspace 切换 / 组件销毁后的旧 PUT | 旧 PUT 回调不修改 UI、不提示、不继续 pump；新 Workspace/新组件由其自己的状态运行。|
| 页面刷新后的服务端收敛 | 旧组件的 PUT 可能在服务端完成但旧回调已失效；新页面通过自己的 Session list + Tab state GET 收敛，旧 PUT 不自动触发此 GET。|
| 草稿真实 ID 转交 | 创建在途草稿被关闭后，真实 ID 创建成功即生成 `visible=false` 新 intent，草稿 ID 从不进入 API 队列。|
| 初始化协调 | 双关键响应暂存，只有 Session list + Tab state 同 `workspaceGeneration + initializationAttemptId` 成功时生成一次 ready 提交；任一失败进入 error。PUT 回调不受 `initializationAttemptId` 约束。|

### AgentToolView 组件门控与生命周期

新增最小 `AgentToolView.component.test.ts`，且必须被 `apps/web/scripts/run-component-tests.mjs` 固定列表执行。至少覆盖：

| 场景 | 可观测预期 |
|---|---|
| 关键双读中一个慢响应 | 模板只显示 loading；不闪现主会话、普通空态或新建按钮。|
| Tab state GET 失败 | 模板进入 error，存在显式重试入口；不存在普通 Tabs、普通空态或新建按钮。|
| 双读成功 | 同步提交一次后进入 ready；最终 Tabs/草稿仅按合并状态出现一次。|
| Agent options 失败 | 双读成功时仍进入 ready。|
| KeepAlive 已 ready 再激活 | 不增加 Tab state GET / Session list GET。|
| KeepAlive error 再激活 | 启动一轮完整关键双读重试。|
| PUT 失败回滚焦点 | 恢复的旧 Tab 非当前 activeKey 时不抢焦点；仅当前 activeKey 无效/不可见才 fallback。|
| ready 状态 PUT 404 | 不进入 error/loading，不显示初始化重试入口，不增加关键 GET；仅显示对应 mutation 错误。|
| Workspace 切换 / 卸载 | 旧响应不修改新 Workspace 的模板或显示过期错误。|

## 手工跨设备验收

### 共享关闭主会话

- 设备 A 进入 Workspace，确认有一个已存在主会话，关闭其 Tab，并在浏览器 Network 面板确认对应 PUT 返回 `200`，或在 A 触发下一轮完整初始化后确认 GET 权威结果包含该 ID。
- 设备 B 使用同一服务实例进入同一 Workspace，页面刷新、组件重新挂载或切换进入该 Workspace，使其完成一轮完整初始化。
- 预期：该主会话不显示；其消息和后端 Session 仍存在；若 A 上运行中的 Agent 未完成，运行不被关闭 Tab 取消。

### 共享打开与关闭子任务

- 设备 A 打开一个默认隐藏的子任务，并确认 PUT `visible=true` 返回 `200` 或下一轮 GET 权威结果包含该 ID。
- 设备 B 通过新一轮完整初始化读取状态。
- 预期：子任务显示。
- 在 A 关闭该子任务并按同样方式确认状态后，让 B 通过页面刷新、重新挂载或切换 Workspace 启动新一轮完整初始化。
- 预期：子任务恢复默认隐藏。

### 非实时边界

- 设备 B 已完成 ready 初始化后，设备 A 关闭一个 Tab 并确认 PUT `200`。
- 预期：B 当前已 ready 的 KeepAlive 页面不要求立即变化；B 只有在规定的新一轮完整初始化触发后才按服务端 GET 结果变化。

### 本地状态不共享

- 在设备 A 激活某个 Tab、改变 Dock 布局或选择临时 Agent。
- 设备 B 启动新一轮完整初始化。
- 预期：仅会话可见性共享；激活 Tab、布局、暂选 Agent 不被 A 覆盖。

## 可执行验收清单

以下条目全部为通过条件：

- 主会话无覆盖时始终默认显示；子任务无覆盖时始终默认隐藏。
- 关闭/打开 Session 后，目标设备在新一轮完整初始化的 GET 结果与后端状态一致。
- 对同 Session 的快速反向点击不会因请求逆序使服务端停在旧意图。
- 在“旧请求服务端已提交、响应超时，期间相反新意图值等于旧 confirmed”的情况下，仍发送补偿 PUT，服务端和 UI 收敛到最后意图。
- 对不同 Session 的操作不会被单个 Session 的网络延迟阻塞。
- Tab state GET 失败不会静默显示默认 Session、不会建立草稿、不会渲染普通空态/新建入口，也不会标为 ready。
- PUT 最终失败会回滚当前最后 intent 并提示；旧请求失败不会回滚或提示较新的 intent；没有无限自动重试。
- PUT 404 只回滚对应 Session，不触发 GET 或完整初始化，不改变 `initializationStatus` / `initializationAttemptId`，不影响草稿、activeKey 或另一 Session 的在途/排队队列。
- 页面刷新或组件重挂载后，旧 PUT 回调不写 UI；新组件只在自身的新一轮完整初始化 GET 中收敛服务端可能已提交的结果。
- 失败回滚后，若当前 activeKey 仍是可见有效 Tab 则保持；恢复的旧 Tab 不抢焦点；仅 activeKey 无效时 fallback。
- 草稿不请求 Tab API；创建中关闭草稿不会丢失关闭意图。
- Session 跨 Workspace 操作被拒绝且无数据写入。
- Workspace 删除不会被状态表阻塞，删除后不存在可读状态。
- Agent 域重建不受状态表 FK 或 `agent_` 表分类影响。
- PUT 附加字段固定返回 `WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`，而非依赖 schema 行为不确定地接受或拒绝。
- GET/PUT 不暴露 `updatedAt`；无多余时间索引。
- 没有新增实时同步、轮询、SSE、WebSocket、Session UI 字段或 Session FK。
- 旧 opened/closed `localStorage` key 不再参与读写，也不会覆盖后端结果。
- 新增 helper 测试和 `AgentToolView.component.test.ts` 均由下面的实际测试命令执行。

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

当前脚本事实：

- `npm run test -w apps/api` 依次执行 test gate、unit、integration 和 worker。
- `npm run test -w apps/web` 会运行所有非 `.component.test.ts` 的 `src/**/*.test.ts`，随后执行 `scripts/run-component-tests.mjs`。
- `run-component-tests.mjs` 维护组件测试固定列表；新增 `AgentToolView.component.test.ts` 未加入列表即视为验收失败。

## 代码审查清单

### 模型与持久化

- [ ] 表名为 `workspace_session_tab_state`，不以 `agent_` 开头。
- [ ] 表处于 `createBaseSchema()`，未加入 Agent schema version、表白名单或 Agent domain 删除列表。
- [ ] `workspace_id` 有 `workspaces(id) on delete cascade` 外键。
- [ ] `session_id` 没有指向 `agent_session` 的外键。
- [ ] `visible` 有 0/1 check，主键为 `(workspace_id, session_id)`。
- [ ] 没有未证明必要性的 `(workspace_id, updated_at)` 时间索引。
- [ ] `updated_at` 没有出现在公共 GET/PUT 契约或前端顺序判断中。
- [ ] 写路径只保存偏离默认值；无意义覆盖通过 delete 消除。
- [ ] 读取 join `agent_session` 且 join 包含 workspace 条件，过滤悬空与无意义行。

### 后端 API 与生命周期

- [ ] 契约在 `contracts/workspaces.ts` 并由 shared 入口导出。
- [ ] 路由在 Workspace 模块，具有完整 Fastify/OpenAPI schema。
- [ ] PUT body 保留 `additionalProperties: false`，且 route `preValidation` 以原始 key 检查拒绝未知字段并返回 `WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`。
- [ ] 本接口以专用窄 helper 返回 `WORKSPACE_NOT_FOUND`，未改变公共 `getWorkspaceById()` 行为。
- [ ] PUT 的 Workspace 校验、Session 归属校验和写入位于同一 SQLite transaction。
- [ ] PUT 使用 `workspaceLifecycleCoordinator.withMutation()`，不会绕过删除 fence。
- [ ] Session 不属于 Workspace 时返回不泄露跨 Workspace 存在性的 `AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`。
- [ ] PUT 返回单 Session 结果，前端未将其误作全量状态快照。
- [ ] 没有新增实时事件、循环重试或不必要锁。

### 前端状态与交互

- [ ] opened/closed 不再从 localStorage 恢复、持久化或作为 fallback。
- [ ] activeKey、Agent 暂选和 Dock 等本地状态未被意外后端化。
- [ ] 有 `loading | ready | error` 初始化门控；loading/error 不渲染普通 Tabs、普通空态或新建按钮，error 有显式重试。
- [ ] 初始化暂存并等待 Session list 与 Tab state 同 generation 成功后一次提交；Agent options 失败不阻塞。
- [ ] 已 ready KeepAlive 再激活不读取；error 再激活重试完整关键双读。
- [ ] 每个 Session 的核心状态严格为 `confirmed?: boolean`、`nextIntentSeq: number`、`desired?: { visible, intentSeq }`、`inFlight?: { visible, intentSeq }`；没有相互竞争的平铺 target/intentSeq 字段。
- [ ] 同 Session 使用单飞 + `desired.intentSeq` 最新意图合并；不是并行 fire-and-forget PUT，也不只是 mutation version。
- [ ] 在途请求后有较新 intent 时，无论旧请求成功或失败、无论新值是否等于 confirmed，都会发送补偿 PUT。
- [ ] 最后 intent 失败才回滚并提示；旧失败不会破坏新意图或产生过期错误；不无限自动重试。
- [ ] GET 使用 `workspaceGeneration + initializationAttemptId`，PUT 只使用 `workspaceGeneration + workspaceId + disposed`；同 Workspace 初始化重试不会卡住 PUT 队列。
- [ ] PUT 404 与其他最终 mutation 失败一致，只回滚/提示对应 Session；不自动 GET、不启动完整初始化、不改变 initialization 状态或影响其他 Session。
- [ ] 草稿不写后端；创建中关闭草稿会向真实 ID 转交关闭 intent。
- [ ] 回滚恢复的非 active Tab 不抢焦点；仅 activeKey 无效时 fallback。
- [ ] 关闭 Tab 仍不调用 cancel、delete 或终端相关接口。

### 测试

- [ ] 数据库、service/store、route、纯前端状态逻辑和 `AgentToolView.component.test.ts` 均已新增。
- [ ] `AgentToolView.component.test.ts` 已加入 `run-component-tests.mjs` 固定列表。
- [ ] 自动测试含服务端提交但客户端超时、请求逆序、PUT 404 无 GET/初始化和无跨 Session 干扰、最终失败、Workspace 切换、页面刷新、草稿创建竞态、初始化门控和删除 cascade。
- [ ] 手工双设备/双 profile 验收验证“规定初始化读取而非实时同步”。
- [ ] 共享包构建、API 与 Web 类型检查及两个 workspace 的测试命令均通过。
