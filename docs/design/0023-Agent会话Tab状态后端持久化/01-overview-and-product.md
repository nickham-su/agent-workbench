# 背景、产品语义与关键决策

## 需求背景

当前 Agent 会话 Tab 的显示状态属于浏览器 `localStorage`：

- 已关闭 Session 集合的 key 前缀为 `agent-workbench.workspace.agent.closedSessions`。
- 已打开子任务集合的 key 前缀为 `agent-workbench.workspace.agent.openedSubtaskSessions`。
- 两者均按 `workspaceId` 组装 key，见 `AgentToolView.vue` 的 `CLOSED_SESSION_STORAGE_PREFIX`、`OPENED_SUBTASK_SESSION_STORAGE_PREFIX`、`closedSessionStorageKey()` 和 `openedSubtaskSessionStorageKey()`。

这使同一浏览器 profile 可以在刷新后恢复展示偏好，但不同浏览器、不同 profile、不同设备无法共享。用户希望访问同一 agent-workbench 服务实例时，在同一 Workspace 中获得一致的会话显示/关闭状态。

## 用户价值

- 开发者切换设备后无需重新逐个关闭历史主会话或重新打开关心的子任务。
- Tab 的“关闭”语义从纯浏览器临时偏好提升为 Workspace 共享工作台偏好，同时不改变 Agent 会话、运行和消息数据。
- 方案保持个人自托管产品的简单性：每个工具实例新一轮完整初始化只读取一次，不建设实时协同系统。

## 范围

### 本次实现

- 将**已有后端 Agent Session** 的可见性覆盖保存到后端 SQLite。
- 以 Workspace 为边界，在每个 `AgentToolView` 的新一轮完整初始化中读取一次状态。
- 用户打开或关闭已有 Session 时，前端立即更新，并异步调用后端持久化。
- 主会话与子任务沿用既有默认展示规则。
- 支持在页面刷新、组件重新挂载或切换到某 Workspace 后恢复共享状态。

### 明确不做

- 不做实时同步、周期轮询、SSE、WebSocket、浏览器 `storage` 事件同步或服务器事件广播。
- 已成功初始化的 KeepAlive Agent 工具在最小化、切换工具后再次激活时不重新读取共享状态。
- 不同步当前激活 Tab（`activeKey`）、Tab 顺序/编号、Dock 布局、工具最小化、草稿、草稿输入、Agent 暂选偏好或提示已读状态。
- 不迁移、不上传旧版 `localStorage` 的 closed/opened 集合；不主动删除这些旧 key。
- 不增加 Session 删除能力，不改变 Agent run 的取消能力，也不把关闭 Tab 解释为关闭业务会话。
- 不在 `agent_session` 或共享 `AgentSessionRecord` 上增加 UI 可见性字段。

## 术语

| 术语 | 定义 |
|---|---|
| Workspace | 一个工作区，是共享显示偏好的隔离边界。|
| 主会话 / primary | 用户创建的常规 Agent Session；无覆盖时默认显示。|
| 子任务 / subtask | 从 Agent 工作流产生的子任务 Session；无覆盖时默认隐藏。|
| 可见性覆盖 | 表中针对一个已有 Session 的 `visible` 记录，仅表示与默认规则不同的用户意图。|
| 关闭 Tab | 隐藏该 Session 的展示入口；不取消、删除或终止任何 Agent 业务状态。|
| 打开子任务 | 将默认隐藏的子任务显式显示为 Tab。|
| 草稿 | 尚未通过 `POST /api/agent/sessions` 创建为后端 Session 的前端本地 Tab。|
| 新一轮完整初始化 | 页面刷新、组件重新挂载、切换进入 Workspace、显式重试，或上次初始化失败后 KeepAlive 再次激活时执行的关键双读流程。已 ready 的 KeepAlive 工具再次激活不属于新一轮初始化。|
| 明确确认 | 浏览器收到与请求一致的 HTTP 2xx 响应；网络失败不构成“服务端未写入”的确认。|

## 当前行为

### 当前显示规则

`AgentToolView.vue` 中的 `visibleSessions` 目前将 `serverSessions` 与 `draftSessions` 合并，再按下列规则过滤：

- ID 位于 `closedSessionIds` 的任何 Session 都不显示。
- `kind === "subtask"` 的 Session 只有位于 `openedSubtaskSessionIds` 时显示。
- 其他 Session，即主会话，默认显示。

当前规则的锚点是 `AgentToolView.vue` 中的 `visibleSessions`，约第 292–315 行。

### 当前关闭与重开

- `closeSessionTab(sessionId)` 仅更新 `closedSessionIds`、本地缓存、Tab 编号、激活项与草稿；不调用 API，约第 1008–1035 行。
- `onOpenSubtask(sessionId)` 将 ID 写入 `openedSubtaskSessionIds`，移除关闭标记后激活 Tab，约第 1049–1061 行。
- `activateParentSessionTab(sessionId)` 移除关闭标记并激活主会话，约第 1063–1071 行。
- 当前列表来自 `GET /api/agent/sessions?workspaceId=...`；Session 列表 API 不携带 UI 可见性字段。

因此，关闭运行中的 Tab 不会取消运行；另一设备也不会看到关闭结果。

## 目标行为与业务规则

### 默认可见性

| Session 类型 | 没有后端覆盖时 | 有效覆盖的含义 |
|---|---|---|
| `primary` | 显示 | `visible=false` 表示关闭；`visible=true` 没有业务价值，必须删除覆盖。|
| `subtask` | 隐藏 | `visible=true` 表示打开；`visible=false` 没有业务价值，必须删除覆盖。|

默认值由 Session 的 `kind` 推导，不能在创建 Session 时写入默认行，也不能由客户端自行臆测后永久化。

### 关闭与打开的不可变语义

- 关闭已有主会话：共享地隐藏该主会话；不会取消 Agent run、删除消息、删除 Session、删除模型覆盖或影响终端。
- 打开已有主会话：共享地恢复显示；本质是删除其关闭覆盖。
- 打开子任务：共享地显示子任务；本质是写入 `visible=true` 覆盖。
- 关闭已打开子任务：共享地恢复默认隐藏；本质是删除其覆盖。
- 关闭草稿：只影响本地草稿；草稿没有后端身份，禁止写入状态表和调用状态 API。

### 跨设备可见时机

- 设备 B 在以下时机完成**新一轮完整初始化**后，读取当时服务端的共享状态：页面刷新、组件重新挂载、切换进入该 Workspace、显式重试，或上一次初始化失败后其 KeepAlive 工具再次激活。
- 已 ready 的设备 B 仅最小化 Agent 工具、切换到其他工具后再切回时，不重新读取；设备 A 的后续改变不会即时反映。
- 两端后来同时操作同一 Session 时，服务端按完成的串行写入决定最终值；每个客户端的单飞补偿队列保证其本地最后点击不会因网络逆序或旧响应丢失而被服务端遗留值覆盖。
- 单次 PUT 失败（包括 Session 已不存在或不属于 Workspace 的 404）不是“重新读取”的产品触发条件：只回滚并提示对应 Tab；服务端事实在下一次规定的新一轮完整初始化中收敛。

## 关键决策与取舍

### 选择独立 Workspace 状态表，不改 `agent_session`

选择 `workspace_session_tab_state` 独立基础域表，原因：

- Tab 可见性是 UI 工作台偏好，不是业务 Session 生命周期字段。
- `agent_session` 属于严格版本化的 Agent 域；把 UI 状态加入该域会增加 schema 重建、数据清理和语义误用风险。
- 当前 `AgentSessionRecordSchema` 只包含 Session 的业务字段，位于 `packages/shared/src/contracts/agent.ts` 的约第 89–102 行；不应强迫所有 Agent API 消费者接受 UI 字段。

### 选择单 Session 设值 API，不覆盖整组数组

- `PUT .../:sessionId { visible }` 是原子、幂等的意图设定。
- 若一次性 PUT `closedSessionIds` / `openedSubtaskSessionIds` 全数组，设备 A 与 B 对不同 Session 的写入可能互相覆盖。
- 单 Session 写入使不同 Session 可以独立并发，且同 Session 的最终值可按服务器串行顺序解释。

### 不做实时通道

- 用户明确几乎不跨端同时使用。
- 新一轮完整初始化读取一次即可满足跨设备切换。
- SSE/WebSocket 会带来订阅鉴权、断线、顺序、事件丢失和前端合并复杂度，当前无实际收益。

### 不迁移旧 localStorage

- 各设备旧值可能冲突，无法定义无争议的迁移权威来源。
- 新功能以服务端状态和默认规则为准，部署后行为一致、可解释。
- 停止读写旧 key 即可；不主动清除不影响功能，避免额外的浏览器迁移状态机。

### 选择 `workspace_session_tab_state` 表名

该名称以 `workspace_` 开头，而不是 `agent_`。这是硬性约束：`schema.ts` 的 `listAgentSchemaObjects()` 会把所有 `agent_%` 表与 `session_run_state` 认定为 Agent 域对象。若新基础表使用 `agent_` 前缀，会导致严格 Agent schema 分类把它视为未知对象，可能拒绝启动或触发错误的升级路径。

### 不对外暴露 `updated_at`

表中保留 `updated_at` 供诊断，但 GET/PUT 不返回 `updatedAt`：删除覆盖会删除行，时间无法作为 Workspace 的单调版本；本需求又没有增量同步或响应排序需求。将它暴露给前端只会制造错误的并发控制暗示。
