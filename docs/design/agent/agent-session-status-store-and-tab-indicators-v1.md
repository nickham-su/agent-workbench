# Agent Session Status Store 与 Tab 指示器重构(v1)

本文档描述 Agent Web 前端在会话(session)维度上的运行状态管理重构方案。

目标是将当前分散在 `AgentToolView.vue` 与 `AgentClientPane.vue` 中的会话运行状态、Tab 状态指示、未查看终态红点、终态提示音与 runState 轮询逻辑，收敛到一个共享的 Vue 组合式 API / store 中，由 tabs 与 pane 共同消费，避免重复轮询与状态分叉。

## 背景

当前 Agent 前端存在以下结构特点：

- `AgentToolView.vue` 负责：
  - 渲染多个 session tabs
  - 切换 active tab
  - 管理本地 tab 可见性、关闭状态、tab 编号等
- `AgentClientPane.vue` 负责：
  - 当前 session 的 context-items 拉取与分页
  - 当前 session 的 runState 拉取与轮询
  - 滚动恢复、follow-bottom、回到底部按钮等消息列表视图逻辑

随着 Tab 标签页需要展示更多会话级状态，现有结构出现以下问题：

1. Tab 标签页缺少统一的 session 运行状态来源
   - Tab 需要知道某个 session 是否正在运行、是否在等待权限
   - 但现有 `runState` 主要由 pane 自己维护，inactive pane 并不会稳定持续提供状态

2. 可能产生重复轮询
   - 当前 pane 已有 `getAgentRunState(sessionId)` 的轮询链路
   - 若 Tab 再自行实现状态轮询，会导致同一 session 的状态被多处重复请求

3. “未查看终态”红点需要跨组件共享与持久化
   - 红点显示在 tabs 上
   - 红点消失由“切到该 tab”触发
   - 红点需要持久化，不能只做 pane 局部状态

4. `context-items` 与会话元状态混杂的风险增加
   - 运行状态/Tab 指示属于 workspace 级共享元状态
   - `context-items` / prepend 历史分页 / 滚动锚点则属于 pane 级重视图状态
   - 若不做边界区分，后续容易形成臃肿的“全能 store”

因此需要一次性重构成更清晰的分层：

- 共享 store：管理会话运行元状态
- pane/controller：管理消息列表视图状态

## 目标

本次重构目标：

- 建立一个按 workspace 维度共享的 Agent session status store
- 建立一个统一的终态副作用触发点：
  - “未查看终态”红点
  - 会话终态提示音
  - 二者均由同一份 session 状态迁移语义驱动
- 统一管理每个 session 的 `runState`
- 在 tabs 上展示 session 级状态：
  - `running`：显示 loading icon
  - `waiting_permission`：显示提醒 icon
- 在 tabs 上展示“未查看终态”红点：
  - 红点仅表示“有未查看终态”
  - 不区分 completed / failed / denied / cancelled
  - 当前 active tab 不显示红点
  - 点击该 tab 后红点消失
  - 红点可持久化
- 在会话进入终态时播放提示音：
  - 当前 active tab 的 session 结束时也播放
  - 是否播放由 `/settings/agent/runtime` 中的全局配置项控制，默认开启
- 由共享 store 统一负责 `getAgentRunState(sessionId)` 的调度与轮询
- tabs 与 panes 共享同一份会话状态，避免重复轮询与状态不一致
- 保持现有消息列表视图逻辑（普通 DOM 列表、prepend 锚点恢复、滚动恢复、follow-bottom 等）稳定

## 非目标

本次重构明确不做以下事情：

- 不让共享 store 接管 `context-items` 数组本体
- 不将历史分页 prepend / 锚点恢复 / 滚动恢复 / 文本展开折叠迁入共享 store
- 不修改后端 `AgentSessionRunState` 与 `AgentSessionRecord` 数据结构
- 不新增后端 session list 聚合状态接口
- 不在本次方案中区分终态红点对应的是 completed 还是 failed
- 不在本次方案中引入 session 消息缓存总线/全局 normalized cache
- 不在本次方案中区分“成功提示音”和“失败提示音”，统一使用一个终态提示音资源

## 现状约束

现有共享类型与 API 约束：

### `AgentSessionRunState`
当前 `runState.status` 只有：

- `idle`
- `running`
- `waiting_permission`

即：

- 没有直接的 `completed`
- 没有直接的 `failed`

因此 tabs 上的“未查看终态”不能直接从 `runState.status === 'completed' | 'failed'` 推导，而需要通过状态迁移语义推断。

### `AgentSessionRecord`
当前 session 列表接口不返回会话运行摘要，不包含：

- `runStatus`
- `lastRunResult`
- `hasUnseenTerminal`

因此前端需要自行建立 workspace 级共享状态中心。

## 核心设计

## 分层原则

采用两层结构：

### A. Workspace 级共享 store
建议新增：

- `apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts`

职责：

- 维护每个 session 的 `runState`
- 维护 tab icon 状态
- 维护“未查看终态”红点
- 维护终态提示音触发逻辑
- 持久化红点
- 统一调度 runState 轮询
- 读取并缓存 Agent runtime settings 中与终态提示音相关的开关配置
- 接收 poll hint / immediate refresh 请求
- 向 `AgentToolView` 与 `AgentClientPane` 提供统一状态读取入口

### B. Pane 级 context/controller
仍由 `AgentClientPane.vue` 主导（如后续有需要可再单独抽 composable，但不放入 status store）。

职责：

- `context-items` 拉取
- 增量刷新 / prepend 历史分页
- displayItems 映射
- 滚动锚点恢复
- follow-bottom
- 回到底部按钮
- 纯视图态（文本展开、clamp 状态、scroll state）

## 为什么 store 不接管 `context-items`

原因如下：

1. 职责边界不同
   - `runState/tab/dot` 是轻量的 workspace 级共享元状态
   - `context-items` 是重 UI、重分页、重滚动状态

2. 数据量与复杂度不同
   - `runState` 数据量小，适合持久化与跨组件共享
   - `context-items` 可能很大，且带有复杂分页与 prepend 锚点恢复逻辑

3. 降低重构风险
   - 当前普通 DOM 列表 + 锚点恢复 + KeepAlive 滚动恢复已经稳定
   - 若将 `context-items` 一并上收，容易显著扩大本次重构风险面

4. inactive sessions 不需要长期持有完整消息列表
   - tabs 只关心 session 级元状态，并不需要持有每个 session 的完整消息历史

因此本次重构采用：

- store 管“会话状态”
- pane/controller 管“消息列表视图”

## 总体架构

### `AgentToolView.vue`
作为 store 的拥有者：

- 创建 status store 实例
- 通过 `provide` 向子树共享
- 将 `visibleSessions`、`activeSessionId` 同步给 store
- tab 直接消费 store 中的 icon / dot 状态
- 切换 tab 时调用 `markSessionSeen(sessionId)`

### `AgentClientPane.vue`
作为 store 的消费者：

- 通过 `inject` 获取共享 store
- 当前 session 的 `runState` 改为从 store 读取
- 不再自行维护 `getAgentRunState(sessionId)` 的轮询链路
- 保留 context-items 拉取与滚动视图逻辑
- 在发送消息、工具权限操作等时机向 store 发送 poll hint

## 文件设计

## 新增文件

### `useAgentSessionStatusStore.ts`
建议内容：

- 类型定义
- inject/provide key
- `createAgentSessionStatusStore()`
- `useAgentSessionStatusStore()`
- 内部 scheduler/persistence 逻辑

如果后续类型体积过大，可再拆分，但 v1 建议先保持在一个文件内，降低跳转成本。

## 修改文件

### `AgentToolView.vue`
主要改动：

- 创建并 provide store
- 根据 `visibleSessions` / `effectiveActiveKey` 同步 session 集合与 active session
- tab 模板接入 icon + dot
- 在 tab 切换与程序性切换会话时统一 `markSessionSeen`
- 逐步降低 `sessionPollHints` 作为 pane-runState 驱动的职责，改为主要通过 store 协调

### `AgentClientPane.vue`
主要改动：

- 注入共享 store
- `runState` 来源切换到 store
- 删除本地 runState 轮询链路
- 保留 context-items 刷新链路
- 在需要时直接调用 store 的 `bumpPollHint(sessionId)`

## Store 数据模型

建议采用如下模型：

```ts
type SessionIndicatorIcon = "running" | "waiting_permission" | null;

type SessionStatusEntry = {
  sessionId: string;
  runState: AgentSessionRunState;
  fetchedAt: number;
  inFlight: boolean;
  nextPollAt: number;
  errorRetryAt: number | null;
  warmupRemaining: number;
  lastTerminalAt: number | null;
  lastSeenTerminalAt: number | null;
  prevRunStatus: AgentSessionRunState["status"] | null;
  lastSoundPlayedAt: number | null;
  lastSoundPlayFailedAt: number | null;
  indicatorIcon: SessionIndicatorIcon;
};
```

其中：

- `runState`：最近一次成功获取的服务端运行状态
- `fetchedAt`：最近一次成功拉取时间
- `inFlight`：当前是否有进行中的 runState 请求
- `nextPollAt`：下一次最早轮询时刻
- `errorRetryAt`：错误后的重试时间
- `warmupRemaining`：用于覆盖“服务端状态写入稍晚”的短轮询剩余次数
- `lastTerminalAt`：最近一次终态事件发生时间
- `lastSeenTerminalAt`：用户最后一次查看该终态的时间
- `lastSoundPlayedAt`：最近一次已成功/已尝试触发提示音的终态时间，用于去重
- `lastSoundPlayFailedAt`：最近一次提示音播放失败时间，仅用于调试与诊断
- `prevRunStatus`：上一次 run status，用于识别状态迁移
- `indicatorIcon`：当前 tab 主 icon 种类

Store 全局状态建议为：

```ts
type AgentSessionStatusStoreState = {
  workspaceId: string;
  activeSessionId: string | null;
  registeredSessionIds: Set<string>;
  visibleSessionIds: Set<string>;
  entries: Record<string, SessionStatusEntry>;
};
```

## Tab icon 设计

### 状态到 icon 的映射

- `runState.status === 'running'`
  - icon：`LoadingOutlined`
  - 颜色：蓝色
  - `spin = true`

- `runState.status === 'waiting_permission'`
  - icon：`QuestionCircleOutlined`
  - 颜色：amber
  - 不旋转

- `runState.status === 'idle'`
  - 不显示主 icon

### 为什么 `waiting_permission` 选择 `QuestionCircleOutlined`

原因：

- 语义更接近“等待确认 / 等待处理”
- 与当前项目中 subtask 卡片对 `awaiting_permission` 的展示风格一致
- 不会误导为错误/失败

因此 v1 中明确采用：

- `waiting_permission` → `QuestionCircleOutlined`

### icon 显示优先级

tabs 上只显示一种主 icon：

1. `running`
2. `waiting_permission`
3. 无 icon

红点是独立逻辑，但只在 `idle` 时显示，因此不会出现：

- loading + 红点 同时显示
- waiting icon + 红点 同时显示

## 红点语义设计

### 红点含义

红点表示：

> 该 session 最近一次运行已进入终态，但用户尚未查看。

红点不区分终态类型，不区分：

- completed
- failed
- denied
- cancelled

对于 tabs 来说，这些统一表示为“有未查看终态”。

### 为什么不能直接从 `runState.status` 推导终态

因为 `AgentSessionRunState.status` 只有：

- `idle`
- `running`
- `waiting_permission`

因此“终态”需要通过 run 状态从非 idle 回到 idle 的迁移来判定。

### 终态判定规则

当某个 session 从：

- `running -> idle`
- `waiting_permission -> idle`

就认为产生了一次终态事件。

此时：

- 若该 session 不是当前 active tab：
  - 记录 `lastTerminalAt = now 或 runState.updatedAt`
- 若该 session 是当前 active tab：
  - 直接视为已查看
  - 令 `lastSeenTerminalAt = lastTerminalAt`

### 红点显示条件

推荐语义：

```ts
showDot =
  sessionId !== activeSessionId
  && lastTerminalAt != null
  && (lastSeenTerminalAt == null || lastTerminalAt > lastSeenTerminalAt)
  && runState.status === "idle";
```

### 清红点时机

以下场景统一清除红点：

- 用户点击该 tab
- 程序性切换到该 session：
  - `open-subtask`
  - `open-parent`
  - `forked`
  - `chooseSession`
  - `reopenAllSessions` 后切到某 session
- pane 变为 active 时

统一通过：

- `markSessionSeen(sessionId)`

实现。

### 新一轮运行开始时如何处理旧红点

v1 约定：

- 当 session 从 `idle` 再次进入 `running` 或 `waiting_permission` 时
- 立即清掉旧红点
- 优先显示新的运行状态 icon

原因：

- 当前运行状态的优先级更高
- 避免“旧终态未查看红点”与“新一轮运行 icon”同时存在导致语义混乱

## 终态提示音设计

### 功能目标

当某个 session 从非 idle 回到 idle，即进入终态时，前端播放一段简短提示音。

该能力与红点共享同一套终态判定语义，但属于独立副作用：

- 红点：表示“有未查看终态”
- 提示音：表示“某个 session 刚刚进入终态”

### 当前 active tab 的播放规则

v1 已确认：

- 当前 active tab 的 session 结束时，也播放提示音

原因：

- 用户希望在会话完成/失败时获得统一的听觉反馈
- 提示音不再仅仅代表“后台 tab 完成提醒”，而是“任意 session 进入终态”的统一提示

### 是否区分成功/失败音效

v1 不区分：

- completed / failed / denied / cancelled
- 统一使用同一个终态提示音

### 提示音资源路径

已确认的前端音频文件路径：

- `agent-workbench/apps/web/src/shared/assets/audio/agent-session-terminal.mp3`

实现时建议通过 ESM import 使用该资源，例如：

```ts
import agentSessionTerminalSoundUrl from "@/shared/assets/audio/agent-session-terminal.mp3";
```

原因：

- 走 Vite 资源打包链路，避免手写固定 public URL
- 与当前 `src/shared/*` 公共资源组织方式保持一致
- 便于后续替换音频文件而不影响调用方路径设计

### 播放配置项

提示音能力通过 `/settings/agent/runtime` 中的全局配置项控制。

建议新增字段：

```ts
sessionTerminalSoundEnabled: boolean
```

规则：

- 默认值：`true`
- 作用范围：所有 Agent sessions
- 设置页位置：`/settings/agent/runtime`
- 设置项默认开启

## 持久化设计

### 持久化范围

只持久化红点相关状态，不持久化 icon：

- loading / waiting_permission 是瞬时运行态，刷新后重新拉取 runState 即可
- 红点是 UI 级未查看语义，需要跨刷新保留

### localStorage key

建议：

```ts
agent-workbench.workspace.agent.sessionIndicators.v1.${workspaceId}
```

按 workspace 隔离，避免不同 workspace 间串状态。

### 持久化结构

```ts
type PersistedSessionIndicator = {
  lastTerminalAt: number | null;
  lastSeenTerminalAt: number | null;
};

type PersistedIndicators = Record<string, PersistedSessionIndicator>;
```

### 恢复逻辑

- store 初始化时从 localStorage 恢复
- 当真实 server sessions 刷新后：
  - 保留仍存在的 session 记录
  - prune 已不存在 session 的持久化数据
- draft session 不参与持久化

## Draft Session 处理

当前 Agent 存在 draft session 概念。draft session 在真正创建前没有可查询的服务端 runState。

因此 v1 规则：

- draft session 不进入 runState 轮询
- draft tab 默认无 icon / 无红点
- 当 draft 被替换为真实 sessionId 后，再将真实 session 注册进 store
- 通常不需要将 draft 的红点数据迁移到真实 session

## Store 对外 API 设计

建议 store 对外暴露以下能力。

## 生命周期/同步接口

```ts
bindWorkspace(workspaceId: string): void
dispose(): void
syncSessions(params: {
  visibleSessionIds: string[];
  activeSessionId: string | null;
  registeredSessionIds?: string[];
}): void
```

说明：

- `bindWorkspace`：绑定当前 workspace，并在切换 workspace 时 reset 内部状态
- `dispose`：停止 timer、释放资源
- `syncSessions`：由 `AgentToolView` 持续同步当前可见 session 集合与 active session

其中：

- `visibleSessionIds`：当前 tabs 中真实展示的 session
- `activeSessionId`：当前 active tab
- `registeredSessionIds`：当前 workspace 已知的真实 server session（可选，用于 prune）

## 查询接口

```ts
getEntry(sessionId: string): SessionStatusEntry
getRunState(sessionId: string): ComputedRef<AgentSessionRunState>
getIndicator(sessionId: string): ComputedRef<{
  icon: "running" | "waiting_permission" | null;
  showDot: boolean;
}>
```

## 交互接口

```ts
markSessionSeen(sessionId: string): void
bumpPollHint(sessionId: string, opts?: { warmup?: boolean; immediate?: boolean }): void
refreshSessionNow(sessionId: string): Promise<void>
refreshVisibleSessionsNow(): Promise<void>
```

说明：

- `markSessionSeen`：标记该 session 的终态已查看
- `bumpPollHint`：会话在发消息、权限操作、会话创建成功等场景下，用于唤醒/加速状态观察
- `refreshSessionNow`：立即刷新指定 session 的 runState
- `refreshVisibleSessionsNow`：立即并发刷新所有当前可见 session

## Runtime Settings 接入设计

### 共享 contract 扩展

需要在 `AgentRuntimeSettings` 与 `UpdateAgentRuntimeSettingsRequest` 中新增：

```ts
sessionTerminalSoundEnabled: boolean
```

后端要求：

- GET `/settings/agent/runtime` 返回该字段
- PUT `/settings/agent/runtime` 支持更新该字段
- 对旧数据兼容：若 stored 值缺失，则回退到默认值 `true`

### Settings 页面接入

`AgentRuntimeSettingsPanel.vue` 中新增一个布尔开关项：

- label：会话终态提示音
- help：当会话从运行态进入终态时播放提示音。对所有会话生效。

表单默认值应来自 `getAgentRuntimeSettings()` 返回值；若后端未存储过该字段，则由后端默认值回填为开启。

## 轮询策略设计

## 总原则

- 一个 store，一套 scheduler
- 不为每个 session 各自开长期 timer
- 不允许 pane 再各自独立轮询 `getAgentRunState(sessionId)`

## 轮询优先级

### A. 当前 active session
当状态为：

- `running`
- `waiting_permission`

时，高频轮询。

建议区间：

- `running`：约 `850ms`
- `waiting_permission`：约 `1100ms`

### B. 非 active 但 visible，且非 idle 的 session
中频轮询。

建议区间：

- `2400ms` 左右

这样可保证背景 tab 的 icon/dot 有较好的时效性，而不会造成过高请求密度。

### C. idle session
默认不持续轮询，仅在这些时机立即刷新：

- 新进入 visibleSessions
- 成为 active session
- 收到 poll hint
- workspace 恢复/重新激活
- 草稿 session 替换为真实 session 后

### D. warmup 机制
保留 warmup，用于覆盖“服务端状态写入稍晚”的窗口。

例如在：

- 发消息后
- 工具权限 approve/deny 后
- 某 session 刚创建成功后

调用：

```ts
bumpPollHint(sessionId, { warmup: true, immediate: true })
```

建议默认值：

- 间隔：`420ms`
- 次数：`4`

### E. 错误重试
若 `getAgentRunState(sessionId)` 请求失败：

- 保留上次成功状态
- 不清空当前 icon / dot
- 记录 `errorRetryAt`
- 约 `1600ms` 后重试

避免网络抖动导致 tab 状态闪烁。

## 调度方式

store 内部维护：

- 一个 `setTimeout`
- 根据所有 session 的 `nextPollAt` 计算最近到期时间
- 到期后取出所有 due sessions
- 对 due sessions 的 `getAgentRunState(sessionId)` 进行并发请求

这样既能共享调度器，又能利用并发缩短整体观察延迟。

## 终态提示音触发规则

### 触发条件

当 store 观察到某个 session 发生以下状态迁移时：

- `running -> idle`
- `waiting_permission -> idle`

即认为产生一次终态事件。

若同时满足：

- `sessionTerminalSoundEnabled === true`
- 当前终态事件尚未播放过提示音

则触发提示音播放。

### 与红点的关系

提示音与红点共享“终态事件”判定，但二者独立：

- 当前 active tab：
  - 播放提示音
  - 不显示红点（因为当前已在查看）
- 非当前 active tab：
  - 播放提示音
  - 显示红点（直到用户切入该 tab）

### 去重策略

建议基于 `lastTerminalAt` 去重：

- 若某次终态事件时间点 `terminalAt` 已经小于等于 `lastSoundPlayedAt`
- 则不重复播放

### 自动播放失败处理

浏览器可能因自动播放策略拦截声音播放。v1 约定：播放失败时静默忽略，不影响红点、icon、runState 主逻辑，也不向用户弹出错误提示。

## `AgentToolView.vue` 接入方案

## 作为 store 拥有者

在 `setup` 中：

- 创建 `statusStore`
- `provide(agentSessionStatusStoreKey, statusStore)`

## 同步 sessions

监听以下来源：

- `visibleSessions`
- `effectiveActiveKey`
- `serverSessions`

将最新值同步进 store：

```ts
statusStore.syncSessions({
  visibleSessionIds,
  activeSessionId: effectiveActiveKey || null,
  registeredSessionIds: serverSessions.map((s) => s.id)
})
```

说明：

- `registeredSessionIds` 建议只传真实 server sessions，不含 draft
- `visibleSessionIds` 则包含当前实际 tab 中展示的 sessions（可含 draft，但 store 内部会忽略 draft 的 runState 轮询）

## Tab 模板改造

当前 tab 结构大致为：

```vue
<span class="agent-tab-label">
  <span>{{ tabLabel(session, index) }}</span>
  <CloseOutlined ... />
</span>
```

v1 建议改造为：

```vue
<span class="agent-tab-label">
  <span class="agent-tab-title-wrap">
    <span>{{ tabLabel(session, index) }}</span>

    <component
      v-if="indicator.icon === 'running'"
      :is="LoadingOutlined"
      spin
      class="..."
    />
    <QuestionCircleOutlined
      v-else-if="indicator.icon === 'waiting_permission'"
      class="..."
    />

    <span v-if="indicator.showDot" class="agent-tab-terminal-dot" />
  </span>

  <CloseOutlined ... />
</span>
```

需要新增适度样式，确保：

- icon 与标题垂直居中
- 红点不挤压关闭按钮点击区
- 视觉风格与现有深色主题一致

## Tab 切换与程序性切换

在以下路径中统一调用：

- `onChangeTab(next)`
- `onOpenSubtask(sessionId)`
- `onOpenParent(sessionId)`
- `onSessionForked(sessionId)`
- `chooseSession(targetSessionId)`
- `reopenAllSessions()` 后设置 active session

调用方式：

```ts
statusStore.markSessionSeen(sessionId)
```

确保“成为当前 tab”与“清红点”语义保持一致。

## 关闭 Tab 的处理

关闭 tab 只是本地隐藏，不代表 session 在服务端消失。

因此：

- 不删除其持久化红点数据
- reopen 后红点仍应保留
- 只有当 session 真正从服务端 session list 中消失时，才 prune 持久化记录

## `AgentClientPane.vue` 接入方案

## `runState` 来源切换

当前 pane 内部本地维护 `runState` 与 runState 轮询链路。重构后应改为：

- 注入共享 `statusStore`
- 当前 session 的 `runState` 从 store 读取

例如语义上变成：

```ts
const runState = computed(() => statusStore.getEntry(props.sessionId).runState)
```

同时保留 idle fallback：

- 若 `sessionReady === false`
- 或当前 session 尚未注册到 store

则返回一份 idle 默认值，保证模板与现有依赖 runState 的逻辑稳定。

## 删除本地 runState 轮询链路

应从 `AgentClientPane.vue` 中移除或改写：

- `getAgentRunState(props.sessionId)` 直接调用链
- pane 内 runState polling timer
- pane 内 warmup polling for runState
- `pollHint` 对 runState 的直接驱动逻辑

这些职责改由共享 store 承担。

## 保留 pane 内 context-items 刷新链路

pane 仍负责：

- `getAgentContextItems`
- `refreshVisibleSession`
- `loadEarlierHistoryPage`
- `upsertItem`
- displayItems
- 滚动恢复与 follow-bottom

但其“是否继续刷新内容”的判断要参考共享 `runState`，例如：

- 当前 pane 处于 active
- 且满足任一：
  - `runState.status !== 'idle'`
  - 本地 `items` 中仍有非终态项
  - 刚收到对当前 session 的 refresh hint

## Poll Hint 迁移

既然 store 接管 runState polling，则 `AgentToolView -> AgentClientPane` 之间原本专门为了唤醒 pane-runState 轮询的 `pollHint` 路径应淡出主逻辑。

新的建议是：

- pane 在发消息、approve/deny、切会话等时机
- 直接调用：

```ts
statusStore.bumpPollHint(sessionId, { warmup: true, immediate: true })
```

用于通知 store 对该 session 做立即刷新 + 短轮询。

## Pane Active 时自动 mark seen

在 `props.active` 变为 `true` 时：

```ts
statusStore.markSessionSeen(props.sessionId)
```

确保：

- 当前 tab 无红点
- 切回来立即清除该 tab 的“未查看终态”提示

## Store 与 Pane 的协作关系

Store 负责：

- 会话运行状态元数据
- tab 指示 icon
- 未查看终态红点
- runState 轮询调度
- 终态提示音触发
- 红点持久化

Pane 负责：

- context-items 内容
- 历史分页与锚点恢复
- follow-bottom 与滚动位置
- 文本显示态

二者连接点只有两个：

1. pane 读取共享 `runState`
   - 用于 run notice、运行提示、是否继续刷新内容等

2. pane 向 store 发 poll hint
   - 用于发消息后/权限操作后/会话创建后唤醒 runState 观察

## 状态机

### run 状态机

```txt
idle
  -> running
  -> waiting_permission

running
  -> waiting_permission
  -> idle

waiting_permission
  -> running
  -> idle
```

### UI 指示规则

- `idle`
  - 不显示主 icon
  - 若存在未查看终态且不是 active tab，则显示红点

- `running`
  - 显示 loading icon
  - 清掉旧红点

- `waiting_permission`
  - 显示 question icon
  - 清掉旧红点

### 状态迁移副作用

- `idle -> running / waiting_permission`
  - 清除旧终态红点
  - 更新主 icon

- `running / waiting_permission -> idle`
  - 若当前不是 active：记录 `lastTerminalAt`
  - 若当前是 active：同步更新 `lastSeenTerminalAt`

## 推荐常量

建议在 store 文件内集中定义：

```ts
const ACTIVE_RUNNING_POLL_MS = 850;
const ACTIVE_WAITING_POLL_MS = 1100;
const BACKGROUND_NON_IDLE_POLL_MS = 2400;
const WARMUP_POLL_MS = 420;
const WARMUP_POLL_COUNT = 4;
const ERROR_RETRY_MS = 1600;
```

数值尽量与现有 pane 中运行态观察节奏接近，避免交互体验突变。

## 风险点与规避

### 风险 1：pane 与 store 状态时序短暂错位

规避：

- pane 以共享 `runState` 为准
- context-items 刷新继续保留“若本地仍有非终态项，则短时继续主动拉取”的兜底逻辑

### 风险 2：workspace 切换导致旧状态残留

规避：

- store 提供 `bindWorkspace` / `dispose`
- workspace 变化时：
  - 清理 timer
  - reset entries
  - 重置音频播放实例/引用（若有）
  - 恢复对应 workspace 的持久化 dot 数据
  - 重新同步 sessions

### 风险 3：大量 tab 造成过多 runState 请求

规避：

- 仅对 active + 非 idle session 高频轮询
- 仅对 background visible + 非 idle session 中频轮询
- idle session 默认不做常驻轮询

### 风险 4：draft 与真实 session 的交接

规避：

- draft 不注册到 runState polling
- 真实 session 创建成功后再纳入 store
- active/seen 状态由父层重新同步

## 验证方案

## 交互验证

### running icon

- 当前 tab 运行中时显示 loading
- 切到其他 tab 后，原 tab 仍显示 loading
- 运行结束后，loading 消失

### waiting_permission icon

- 当前 tab 进入等待权限状态时显示提醒 icon
- 切到其他 tab 后，对应 tab 仍显示提醒 icon
- 处理后 icon 消失

### terminal dot

- 背景 tab 从 running/waiting 回到 idle：出现红点
- 当前 active tab 回到 idle：不出现红点
- 点击带红点的 tab：红点消失
- 刷新页面：红点仍在
- 新一轮运行开始：旧红点消失

### terminal sound

- 非当前 tab 从 running/waiting 回到 idle：播放提示音
- 当前 active tab 从 running/waiting 回到 idle：也播放提示音
- 同一终态事件不会重复播放多次
- 关闭提示音设置后：终态不再播放声音
- 浏览器拦截自动播放时：主逻辑不受影响，不报错打断用户

### 其他

- 关闭 tab 再 reopen：红点仍在
- 切换 workspace：红点不串 workspace
- 现有滚动恢复、上下分页、回到底部按钮交互不受影响

## 工程验证

完成改造后统一执行：

- `npm -s run typecheck`
- `npm -s run build`

## 实施顺序

虽然该方案属于“一次性重构”，但实现顺序建议如下，以控制单次提交内的风险：

1. 新建 `useAgentSessionStatusStore.ts`
2. 在 `AgentToolView.vue` 中创建并 provide store
3. tabs 接入 icon / dot 渲染
4. `AgentToolView.vue` 接入 `syncSessions / markSessionSeen`
5. `AgentClientPane.vue` 注入 store
6. 将 pane 的 `runState` 切换到共享 store
7. 删除 pane 内 runState 轮询链路
8. 将 poll hint 迁移到 store
9. 做交互回归与工程验证

## v1 决策总结

本方案在 v1 明确采用以下决策：

- 使用独立的 Vue composable/store 文件，按 workspace 维度管理所有 session 状态
- store 由 `AgentToolView.vue` 创建，并通过 provide/inject 共享给 panes
- store 接管：
  - `runState`
  - tab indicator
  - unseen terminal dot
  - red dot persistence
  - runState polling orchestration
- store 不接管：
  - `context-items`
  - prepend 分页
  - 滚动锚点
  - follow-bottom
- `waiting_permission` 使用 `QuestionCircleOutlined`
- 红点仅表示“有未查看终态”，不区分 completed / failed
- 当 session 开始新一轮运行时，立即清掉旧红点
- 会话终态提示音由共享 store 统一触发
- 当前 active tab 的 session 结束时，也播放提示音
- 终态提示音资源路径为 `@/shared/assets/audio/agent-session-terminal.mp3`
