# Agent Session 终态提醒策略调整(v1)

本文档描述 Agent Web 前端在 session 维度上的终态提醒策略调整方案。

目标是在保留现有共享 `AgentSessionStatusStore` 架构的前提下，收敛主 session 与子任务 session 在以下能力上的差异化行为：

- 终态提示音
- Tab 未查看终态红点
- 运行态 icon（`running` / `waiting_permission`）

本文档是对既有文档 `agent-session-status-store-and-tab-indicators-v1.md` 的增量补充与策略收敛；如两者有冲突，以本文档为准。

---

## 背景

当前实现中：

- 提示音在 session 的 `runState.status` 从非 `idle` 回到 `idle` 时统一触发
- 红点与提示音共享同一套“进入终态”的判定语义
- store 仅按 `sessionId` 管理状态，不区分 `primary` / `subtask`

因此当前行为存在两个问题：

1. 主 session 在用户主动 `cancel` 时也会播放提示音
2. 子任务 session 也会参与红点与提示音逻辑

而产品期望是：

- 主 session：
  - `completed` / `failed`：参与提示音与红点逻辑
  - 当前 active session：播放提示音，但不显示红点（视为已查看）
  - `cancelled`：不播放提示音，也不显示红点
- 子任务 session：
  - 不播放提示音
  - 不显示红点
  - 仍保留 `running` / `waiting_permission` icon

---

## 目标

本次调整目标：

- 主 session 仅在 `completed` / `failed` 时触发终态提醒
- 主 session 在 `cancelled` 时不触发终态提醒
- 子任务 session 完全不参与终态提醒（提示音 + 红点）
- 子任务 session 仍然保留运行态 icon 能力
- 保持现有共享 store 架构，不把 subtask 从 store 中剔除
- 尽量避免数据库 schema 迁移

---

## 非目标

本次不做：

- 不改变 `AgentClientPane.vue` 的 context-items 拉取与滚动逻辑
- 不为 subtask 单独新增一套 session status store
- 不移除 subtask 的 tab 运行态 icon
- 不引入成功/失败不同音效
- 不在本次方案中重构整个 session list 接口

---

## 需求矩阵

### 主 session (`kind = primary`)

| 场景 | running/waiting icon | 提示音 | 红点 |
| --- | --- | --- | --- |
| 运行中 / 等待权限 | 是 | 否 | 否 |
| `completed` 结束，当前 tab 为 active | 否 | 是 | 否 |
| `completed` 结束，当前 tab 非 active | 否 | 是 | 是 |
| `failed` 结束，当前 tab 为 active | 否 | 是 | 否 |
| `failed` 结束，当前 tab 非 active | 否 | 是 | 是 |
| `cancelled` 结束，当前 tab 为 active | 否 | 否 | 否 |
| `cancelled` 结束，当前 tab 非 active | 否 | 否 | 否 |

### 子任务 session (`kind = subtask`)

| 场景 | running/waiting icon | 提示音 | 红点 |
| --- | --- | --- | --- |
| 运行中 / 等待权限 | 是 | 否 | 否 |
| 任意终态（`completed` / `failed` / `cancelled`） | 否 | 否 | 否 |

---

## 现状分析

### 1. 现有提示音逻辑只识别“进入 idle”，不识别“为何进入 idle”

当前 `useAgentSessionStatusStore.ts` 中，提示音触发点是：

- `prev !== "idle" && next.status === "idle"`

该逻辑只能判断“会话进入终态”，不能判断本次终态是：

- `completed`
- `failed`
- `cancelled`

因此 `cancelled` 也会被当成普通终态统一播音。

### 2. 现有 store 不识别 session kind

当前共享 store：

- 能按 `sessionId` 维护 runState、运行态 icon、红点、提示音
- 但不知道该 session 是 `primary` 还是 `subtask`

因此无法表达：

- primary 允许终态提醒
- subtask 禁用终态提醒

### 3. subtask 不能直接从 store 中移除

`AgentClientPane.vue` 当前通过共享 store 读取自身 `runState`。

如果简单把 subtask 从：

- `registeredSessionIds`
- `visibleSessionIds`

中过滤掉，会带来副作用：

- subtask pane 的 `runState` 不再可靠刷新
- subtask tab 的运行态 icon 也可能丢失

因此本次方案必须遵循：

- **subtask 继续进入 store**，用于 runState 与运行态 icon
- **subtask 仅禁用终态提醒副作用**（提示音 + 红点）

### 4. 当前 active tab 不显示红点的逻辑已满足主 session 需求

现有 `shouldShowDot(...)` 已有规则：

- 当前 active session 不显示红点

这与产品要求一致，应保留。

---

## 方案总览

本次采用两项核心调整：

1. 在前端共享 store 中引入“会话提醒策略（session cue policy）”
2. 在 `AgentSessionRunState` 接口中补充“最近一次终态结果（last terminal status）”字段

其中：

- 会话提醒策略解决 `primary` / `subtask` 差异
- 最近一次终态结果解决 `completed` / `failed` / `cancelled` 差异

### 结论

- **不需要把 subtask 从 store 中移除**
- **不建议仅靠本地 cancel 意图抑制提示音**
- **本方案不要求新增数据库表字段**；优先从 `agent_run` 推导最近一次终态结果并拼入 `getRunState()` 返回值

---

## 详细设计

## 一、共享 store 增加 session 元信息与提醒策略

### 新增目标

共享 store 不再只知道 `sessionId`，还需要知道该 session 的提醒策略。

建议在 store 内为每个 session 维护元信息：

```ts
type SessionCuePolicy = {
  kind: "primary" | "subtask";
  terminalSoundEnabled: boolean;
  terminalDotEnabled: boolean;
};
```

推荐默认映射：

- `primary`
  - `terminalSoundEnabled = true`
  - `terminalDotEnabled = true`
- `subtask`
  - `terminalSoundEnabled = false`
  - `terminalDotEnabled = false`

### `AgentToolView.vue` 调整

当前 `statusStore.syncSessions(...)` 只同步：

- `activeSessionId`
- `visibleSessionIds`
- `registeredSessionIds`

建议扩展为同步 session 元信息，例如：

```ts
syncSessions({
  activeSessionId,
  visibleSessionIds,
  sessions: serverSessions.map((item) => ({
    id: item.id,
    kind: item.kind
  }))
})
```

或等价的 `sessionMetaById` 结构。

要求：

- draft session 仍不参与终态提醒
- server session（含 subtask）均进入 store
- store 根据 `kind` 生成提醒策略

### store 中的使用规则

#### 运行态 icon

运行态 icon 逻辑保持按 `runState.status` 驱动：

- `running` -> loading icon
- `waiting_permission` -> question/warning icon

**不受 `terminalSoundEnabled` / `terminalDotEnabled` 影响。**

即：

- subtask 仍可显示运行态 icon

#### 红点

红点显示前增加策略判断：

- 若 `terminalDotEnabled === false`，直接不显示

#### 提示音

提示音播放前增加策略判断：

- 若 `terminalSoundEnabled === false`，直接不播放

---

## 二、`AgentSessionRunState` 增加最近终态结果字段

### 目标

前端需要区分本次从非 `idle` 回到 `idle` 的原因。

建议在对外返回的 `AgentSessionRunState` 中增加字段：

```ts
lastTerminalStatus: "completed" | "failed" | "cancelled" | null;
```

命名选择 `lastTerminalStatus`，而不是 `terminalStatus`，原因：

- 当 session 当前处于 `running` / `waiting_permission` 时，该字段仍可能保留上一次终态值
- `lastTerminalStatus` 更能表达“最近一次终态结果”的语义

### 为什么不新增 `agent_session_run_state` 表字段

本方案优先采用：

- `agent_session_run_state` 继续承载“当前运行状态”
- `agent_run` 继续承载“每次 run 的终态结果”
- API 层在 `getRunState(sessionId)` 时查询最近一次 terminal run，并将其拼入返回值

优点：

- 无需数据库迁移
- 与现有数据模型职责一致
- 改动集中在 API 组装层与前端消费层

### 服务端组装建议

在 `apps/api/src/modules/agent/agent.service.ts` 的 `getRunState(sessionId)` 中：

1. 继续读取 `agent_session_run_state`
2. 继续计算 `nonTerminalItemIds`
3. 额外查询当前 session 最近一次 terminal run 的 `status`
4. 将其作为 `lastTerminalStatus` 返回

建议查询范围仅包含：

- `completed`
- `failed`
- `cancelled`

不引入 `denied`，因为当前 run record 终态以 `agent_run.status` 为准。

### 推荐查询规则

按当前 session 的 run 记录，取最近一次 terminal run：

- `where session_id = ? and status in ('completed', 'failed', 'cancelled')`
- 按 `updated_at desc` 取 1 条

返回：

- 若存在 terminal run：返回其 `status`
- 若不存在：返回 `null`

---

## 三、终态提醒判定逻辑调整

### 核心原则

终态提醒不再等价于“进入 idle”，而应改为：

> 进入 idle 且本 session 的最近终态结果属于“允许提醒的终态”

建议新增 helper：

```ts
function isRemindableTerminal(params: {
  kind: "primary" | "subtask";
  lastTerminalStatus: "completed" | "failed" | "cancelled" | null;
})
```

规则：

- `subtask` -> `false`
- `primary + completed` -> `true`
- `primary + failed` -> `true`
- `primary + cancelled` -> `false`
- `null` -> `false`

### 提示音规则

在 `onRunStateTransition(...)` 中，当：

- `prev !== 'idle'`
- `next.status === 'idle'`

时：

1. 先读取该 session 的 cue policy
2. 再读取 `next.lastTerminalStatus`
3. 仅当 `isRemindableTerminal(...) === true` 时：
   - 更新终态提醒时间戳
   - active session 也播放提示音
   - 调用 `playTerminalSound(...)`

因此：

- primary completed / failed：播放
- primary cancelled：不播放
- subtask 任意终态：不播放

### 红点规则

红点语义调整为：

> 有“未查看的、允许提醒的终态”

即：

- primary completed / failed：可产生红点
- primary cancelled：不产生红点
- subtask 任意终态：不产生红点

同时继续保留：

- active session 不显示红点
- 切换到该 tab 后视为已查看
- 红点状态可持久化

### 对 `lastTerminalAt` / `lastSeenTerminalAt` 的影响

建议：

- 仅对“允许提醒的终态”写入 `lastTerminalAt`
- 即仅 primary 的 `completed` / `failed` 写入
- `cancelled` 与 subtask 终态不写入 `lastTerminalAt`

原因：

- 避免 `cancelled` 被持久化为未查看提醒
- 避免 subtask 生成无意义的持久化红点状态
- 保持持久化数据与 UI 语义一致

这样可直接满足：

- primary cancelled 不显示红点
- subtask 不显示红点

---

## 四、持久化策略调整

现有持久化结构可保留：

```ts
type PersistedSessionIndicator = {
  lastTerminalAt: number | null;
  lastSeenTerminalAt: number | null;
};
```

但其语义需要收紧为：

- 仅持久化“允许提醒的终态”
- 即仅 primary 的 completed / failed

### 持久化要求

- subtask session 可存在于 `registeredSessionIds`
- 但不应产生持久化红点记录
- primary session 的 cancelled 不应写入新的 `lastTerminalAt`

### 对旧数据的兼容

由于历史版本可能已给 subtask 或 cancelled 终态写入过 `lastTerminalAt`，本方案建议在 store 恢复或 prune 时做一次轻量清理：

- 若 session kind 为 `subtask`，清空其 persisted indicator
- 若当前 session 最近终态为 `cancelled`，不再延续旧的未查看红点语义

此清理可采用 best-effort，无需一次性强制迁移。

---

## 五、前端文件改动建议

### 1. `apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts`

主要改动：

- 为每个 session 增加 `SessionCuePolicy`
- `syncSessions(...)` 支持同步 session kind / meta
- `shouldShowDot(...)` 增加 cue policy 判断
- `playTerminalSound(...)` 前增加 cue policy 判断
- `onRunStateTransition(...)` 改为基于 `lastTerminalStatus` 判定是否属于 remindable terminal
- 仅对 remindable terminal 更新 `lastTerminalAt`
- 持久化/恢复逻辑过滤 subtask 与 cancelled 终态残留数据

### 2. `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

主要改动：

- `syncSessions(...)` 时传入 session 元信息（至少 `id + kind`）
- 继续把所有 server sessions（含 subtask）注册到 store
- 不改变现有 tab 上运行态 icon 的消费方式

### 3. `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

预计无需大改。

原因：

- pane 继续从 store 读取 `runState`
- subtask pane 的运行态展示仍可依赖共享 store
- 本次策略变化主要集中在终态副作用，而非 pane 本体

---

## 六、共享契约与 API 改动建议

### 1. `packages/shared/src/contracts/agent.ts`

为 `AgentSessionRunStateSchema` 增加：

```ts
lastTerminalStatus: Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Null()
])
```

### 2. `apps/api/src/modules/agent/agent.service.ts`

在 `getRunState(sessionId)` 返回值中拼入：

- `lastTerminalStatus`

### 3. `apps/api/src/modules/agent/agent.store.ts`

建议新增辅助查询，例如：

```ts
getLatestTerminalRunStatus(db, workspaceId, sessionId)
```

注意：

- 本方案不要求给 `agent_session_run_state` 表加字段
- 本方案不要求修改 `agent_run` 表结构

---

## 为什么没有硬卡点

本次需求不存在硬 blocker，原因如下：

1. **subtask 仍可继续复用共享 store**
   - 无需拆 store
   - 无需重写 pane 逻辑

2. **运行态 icon 与终态提醒天然可分离**
   - icon 由当前 `runState.status` 决定
   - 红点/提示音是终态副作用，可独立加策略判断

3. **系统已有 run 终态信息来源**
   - `agent_run.status` 已区分 `completed` / `failed` / `cancelled`
   - 不必依赖本地“取消意图”猜测

4. **不要求数据库 schema migration**
   - 可通过 API 聚合层补充 `lastTerminalStatus`

因此主要工作量集中在：

- 共享契约扩展
- API 聚合补字段
- 前端 store 引入 session cue policy

---

## 验证矩阵

### 主 session

1. primary session 正常完成，当前 tab 为 active
   - 播放提示音
   - 不显示红点

2. primary session 正常完成，当前 tab 非 active
   - 播放提示音
   - 显示红点

3. primary session 失败结束，当前 tab 为 active
   - 播放提示音
   - 不显示红点

4. primary session 失败结束，当前 tab 非 active
   - 播放提示音
   - 显示红点

5. primary session 用户取消，当前 tab 为 active
   - 不播放提示音
   - 不显示红点

6. primary session 用户取消，当前 tab 非 active
   - 不播放提示音
   - 不显示红点

### 子任务 session

7. subtask session 运行中
   - 显示 running icon
   - 不显示红点
   - 不播放提示音

8. subtask session 等待权限
   - 显示 waiting_permission icon
   - 不显示红点
   - 不播放提示音

9. subtask session 正常完成
   - 不显示红点
   - 不播放提示音

10. subtask session 失败结束
   - 不显示红点
   - 不播放提示音

11. subtask session 被取消
   - 不显示红点
   - 不播放提示音

### 持久化 / 交互

12. primary session 非 active 时 completed 产生红点，切换到该 tab 后红点消失
13. 刷新页面后，primary completed / failed 的未查看红点仍可恢复
14. 刷新页面后，subtask 不应恢复出红点
15. 历史上由 cancelled 残留的红点不应继续长期存在

---

## 推荐落地顺序

### 第一阶段：补语义

- 共享契约增加 `lastTerminalStatus`
- API `getRunState()` 返回 `lastTerminalStatus`

### 第二阶段：补策略

- store 支持 session kind / cue policy
- 红点 / 提示音逻辑按策略与终态结果共同判定

### 第三阶段：补验证

- 前端 store 单测 / 交互测试
- 关键手工回归验证主 session 与 subtask 场景

---

## 最终决策

本次方案采用以下最终决策：

1. 主 session：
   - `completed` / `failed` 触发提示音与红点
   - active tab 播放提示音但不显示红点
   - `cancelled` 不播放提示音，也不显示红点

2. 子任务 session：
   - 不参与终态提示音
   - 不参与红点
   - 保留 `running` / `waiting_permission` icon

3. 实现方式：
   - session 继续统一接入共享 `AgentSessionStatusStore`
   - store 增加 session cue policy
   - API 为 `AgentSessionRunState` 补充 `lastTerminalStatus`
   - `lastTerminalStatus` 优先从 `agent_run` 聚合推导，不新增表字段
