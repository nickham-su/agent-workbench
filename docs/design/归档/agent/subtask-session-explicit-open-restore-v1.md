# 子任务 Session 显式打开恢复方案(v1)

## 背景

当前 Agent 页签的可见会话集合由前端 `AgentToolView.vue` 基于以下规则计算：

- 从服务端通过 `listAgentSessions(workspaceId)` 拉取当前 workspace 下全部 session
- 前端本地再叠加 `draftSessions`
- 最终以 `closedSessionIds` 作为唯一的本地可见性裁剪条件

即当前语义近似为：

- `visibleSessions = (serverSessions + draftSessions) - closedSessions`

这在主会话(primary session)场景下通常可接受，但在 `subtask session` 场景下会产生一个明显的错误体验：

- 主 session 在运行过程中可以后台创建 subtask session
- 用户未必点击进入该 subtask session
- 但刷新页面后，前端重新拉取全部 session 时，会把这些从未被用户显式打开过的 subtask session 也展示为 tab

用户主观感受是：

- 刷新后“多出了一些 tab”
- 这些 tab 并不是新建空会话，而是已有内容的历史子会话
- 其中相当一部分来自 subtask

## 问题定义

### 当前问题

未被用户显式打开过的 subtask session，在刷新后被自动展示为 tab。

### 根因

当前前端没有记录：

- 某个 subtask session 是否曾被用户显式打开过

因此刷新后只能依据：

- 服务端是否存在该 session
- 本地是否曾显式关闭该 session

来决定是否显示，而无法区分：

- 用户明确打开过的 subtask
- 后台创建但用户从未查看过的 subtask

### 现状代码要点

#### `AgentToolView.vue`

- `serverSessions` 由 `listAgentSessions(props.workspaceId)` 获取
- `allSessions = [...serverSessions, ...draftSessions]`
- `visibleSessions = allSessions.filter((item) => !closedSessionIds[item.id])`

#### `AgentClientPane.vue`

子任务卡片点击会触发：

- `emit("open-subtask", sessionId)`

`AgentToolView.vue` 中对应：

- `onOpenSubtask(sessionId)`
- 该函数会刷新 session 列表、取消 closed 标记、切 active

这说明“用户显式打开子会话”的交互入口已经存在，但其结果未被单独持久化。

## 目标

本方案只解决一个问题：

- 未显式打开过的 subtask session 不应在刷新后自动展示为 tab

同时保持以下原则：

- 不改变当前页面交互形态
- 不重做 tabs 的整体语义
- 不影响 primary session 的现有表现
- 不改动后端 API / 数据结构
- 不引入会话列表入口重构

## 非目标

本方案明确不做以下内容：

- 不将全部 session tabs 重构为 `openedSessionIds` 模型
- 不修改 primary session 的默认恢复逻辑
- 不新增“历史会话列表 / 打开会话”入口
- 不修改 subtask 的后端创建逻辑
- 不改变 `closedSessionIds` 的现有语义
- 不持久化 draft session
- 不做跨浏览器 / 多标签页同步

## 产品定稿约束

本方案按以下约束定稿：

1. 只有用户显式触发“打开子任务”时，才认为某个 subtask session 被打开过
2. “显式打开”在 v1 中仅指点击主会话中的子任务卡片，并触发 `open-subtask`
3. 关闭 subtask tab 后，不移除“曾显式打开过”的记录
4. 刷新后 subtask 是否显示，取决于：
   - 是否曾显式打开过
   - 是否当前未被 `closedSessionIds` 隐藏
5. 历史数据不做迁移；新逻辑启用后，未进入白名单的历史 subtask 一律不自动展示

## 术语

### 显式打开的 subtask session

指用户通过当前前端明确的“打开子任务”交互进入过的 subtask session。

v1 中唯一认定入口：

- `AgentClientPane.vue` 中点击子任务卡片
- 触发 `emit("open-subtask", sessionId)`
- `AgentToolView.vue` 的 `onOpenSubtask(sessionId)` 被调用

### 打开白名单

前端本地持久化的一组 subtask session id，用于表示：

- 这些 subtask session 曾被用户显式打开过
- 因此刷新后允许参与 tabs 可见性计算

## 方案总览

### 设计原则

采用最小改动原则：

- 对 `primary` 保持现状
- 仅对 `subtask` 增加“显式打开白名单”约束

### 核心规则

#### primary session

保持现有逻辑：

- 只要服务端返回该 session
- 且不在 `closedSessionIds` 中
- 即可显示

#### subtask session

新增限制：

- 只有满足“曾被显式打开过”，才允许进入候选列表
- 然后仍继续受 `closedSessionIds` 控制

可表示为：

- `visible primary = primary sessions - closed`
- `visible subtask = subtask sessions ∩ openedSubtaskSessionIds - closed`

最终：

- `visibleSessions = visiblePrimary + visibleSubtask + draftSessions(现有规则)`

## 数据模型

### 新增本地持久化 key

建议新增：

- `agent-workbench.workspace.agent.openedSubtaskSessions.v1.<workspaceId>`

值格式：

- JSON 数组：`string[]`
- 每项为非空 session id

示例：

```json
["sess_abc123", "sess_def456"]
```

### 内存状态

在 `AgentToolView.vue` 中新增：

- `openedSubtaskSessionIds = reactive<Record<string, true>>({})`

或等价结构：

- `ref<Record<string, true>>({})`

v1 建议使用与 `closedSessionIds` 一致的对象字典风格，便于保持代码一致性与最小心智切换。

## 前端行为设计

## 1. 初始化与刷新恢复

### 当前流程

当前 `workspaceId` 变化或页面刷新时：

- 清理本地状态
- `restorePersistedState()`
- `refreshAll()`
- 基于 `visibleSessions` 渲染 tabs

### 新流程

扩展 `restorePersistedState()`：

- 在恢复 `activeKey` / `agentPick` / `closedSessionIds` / `tabNoMap` 的同时
- 额外恢复 `openedSubtaskSessionIds`

刷新完成后计算 `visibleSessions` 时：

- 对 `primary` 不变
- 对 `subtask` 增加白名单过滤

### 效果

- 后台存在但从未点开过的 subtask session，不再因刷新自动出现在 tabs 中
- 曾显式打开过的 subtask session，刷新后仍可恢复显示

## 2. 显式打开子任务

当用户点击子任务卡片时，当前已有流程为：

- `AgentClientPane.vue` -> `emit("open-subtask", sessionId)`
- `AgentToolView.vue` -> `onOpenSubtask(sessionId)`

v1 在此基础上新增：

1. 将 `sessionId` 写入 `openedSubtaskSessionIds`
2. 持久化到 localStorage
3. 再执行现有逻辑：
   - `refreshSessions()`
   - 从 `closedSessionIds` 中移除
   - 切到 active
   - `persistActiveKey(sessionId)`

### 顺序建议

建议顺序：

1. 标记为 openedSubtask
2. 持久化
3. `await refreshSessions()`
4. 清除 closed
5. 切 active

理由：

- 即使刷新请求失败，本地“用户明确打开过”的事实也已经记录
- 后续再次刷新时仍能按预期恢复

## 3. 关闭 subtask tab

当前 `closeSessionTab(sessionId)` 的语义保持不变：

- 写入 `closedSessionIds`
- 持久化 `closedSessions`
- 更新 activeKey / tabNoMap

### 新增约束

关闭时**不移除** `openedSubtaskSessionIds[sessionId]`

### 原因

因为二者语义不同：

- `openedSubtaskSessionIds` 表示“用户曾显式打开过”
- `closedSessionIds` 表示“当前不显示”

若关闭时同时移除 opened 标记，会导致：

- 用户明确打开过的 subtask 一旦关闭
- 就丢失“可恢复资格”
- 语义会不稳定，且与 v1 定稿约束不符

## 4. reopen / close all / reopen all

当前 Agent 页面没有针对 subtask 的独立 reopen 交互，仍沿用现有行为：

- `closedSessionIds` 控制当前是否显示
- `reopenAllSessions()` 清空 closed 标记

### 结果语义

- 对 primary：与现状一致
- 对 subtask：仅那些已在 `openedSubtaskSessionIds` 中的 session 才会因 reopen 而显示
- 从未显式打开过的 subtask，即使 `reopenAllSessions()`，也不会显示

这是符合 v1 目标的：

- `reopen` 只对“曾进入用户工作流的 subtask”生效

## 可见性判定规则

建议将 `visibleSessions` 的判定显式化，避免未来语义漂移。

### 伪代码

```ts
const visibleSessions = computed(() => {
  const list = allSessions.value.filter((item) => {
    if (closedSessionIds[item.id]) return false;

    if (item.kind === "subtask") {
      return !!openedSubtaskSessionIds[item.id];
    }

    return true;
  });

  return sortByTabNoAndCreatedAt(list);
});
```

### 说明

- `draftSessions` 当前类型固定为 `kind: "primary"`，因此不受 subtask 白名单影响
- 现有 tab 排序、编号、activeKey 计算不需要改变

## 持久化设计

## 1. 读取

新增函数：

- `restoreOpenedSubtaskSessionsFromStorage(workspaceId)`

规则：

- key 不存在 -> 空集合
- 非数组 -> 忽略
- 数组中仅保留非空字符串
- 去重

## 2. 写入

新增函数：

- `persistOpenedSubtaskSessions()`

规则：

- 若集合为空，可删除 storage key
- 否则写入有序数组

### 是否需要排序

建议持久化时按字符串排序，获得稳定输出，便于调试。

## 3. workspace 切换

与 `closedSessionIds` 保持一致：

- 切换 workspace 时先清空内存状态
- 再按新 workspaceId 恢复对应集合

## 4. 清理无效 id

建议在 `refreshSessions()` 完成后，对 `openedSubtaskSessionIds` 做一次轻量 prune：

- 若某 id 已不在当前 workspace 的 `serverSessions` 中，移除之
- 然后持久化

### 原因

- 避免 localStorage 长期积累失效 session id
- 与 `closedSessionIds` 当前对不存在 session 的清理策略保持一致

### 注意

仅 prune 不存在的 id；不要因当前未显示就删除 opened 标记。

## 详细改造点

## 修改文件

### `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

#### 新增常量

建议新增：

- `OPENED_SUBTASK_SESSION_STORAGE_PREFIX = "agent-workbench.workspace.agent.openedSubtaskSessions"`

#### 新增状态

- `openedSubtaskSessionIds`

#### 新增函数

- `openedSubtaskSessionStorageKey(workspaceId)`
- `restoreOpenedSubtaskSessionsFromStorage(workspaceId)`
- `persistOpenedSubtaskSessions()`
- `markSubtaskOpened(sessionId)`
- `pruneOpenedSubtaskSessions(presentSessionIds)`

#### 修改现有函数

##### `restorePersistedState()`

新增恢复 `openedSubtaskSessionIds`

##### `onOpenSubtask(sessionId)`

在现有逻辑前增加：

- `markSubtaskOpened(sessionId)`

##### `refreshSessions()`

在拿到最新 `serverSessions` 后，补一段 prune openedSubtask 的逻辑：

- 仅保留当前 workspace 下仍存在的 subtask session id

##### `visibleSessions`

增加对 `subtask` 的白名单过滤

### 不需要修改的文件

#### `AgentClientPane.vue`

除非希望增加注释或文档链接，否则 v1 不要求改动其交互逻辑。

理由：

- 现有 `emit("open-subtask", sessionId)` 已足够表达“显式打开”
- 该语义在 `AgentToolView.vue` 中落地即可

## 兼容性与迁移

## 历史状态迁移

v1 明确不做迁移。

即：

- 老版本中已经存在但从未进入 `openedSubtaskSessionIds` 的 subtask session
- 在新逻辑启用后不会自动出现在 tabs 中

### 原因

1. 项目尚未上线，无历史兼容包袱
2. 该行为正是本方案要修复的问题
3. 若做迁移，容易把历史上被动暴露过的 subtask 继续保留下来，弱化修复效果

## 对现有用户操作的影响

### 不受影响

- primary session 的显示与恢复
- 新建 draft / 发送消息 / ensureSessionCreated
- fork primary session 的显式打开流程
- 关闭 tab 的交互
- tab 排序与编号

### 会变化

- 后台创建但从未点击进入的 subtask session，不再在刷新后自动显示

## 备选方案与取舍

## 方案 A：只过滤所有 subtask，不允许其刷新恢复

### 做法

- `visibleSessions` 中直接过滤掉全部 `kind === "subtask"`
- 用户点开后也不参与 tabs 恢复

### 问题

- 过度修复
- 用户明确打开过的 subtask 也无法恢复
- 破坏现有子任务 tab 的可用性

因此不采用。

## 方案 B：为全部 session 引入 `openedSessionIds`

### 做法

- tabs 完全改为基于 openedSessionIds
- 不再使用“全量 session - closed”模型

### 问题

- 这是更大的 tabs 模型重构
- 会牵涉 primary session 恢复逻辑
- 超出本次“只修 subtask 误打开 bug”的范围

因此不作为 v1。

## 方案 C：后端 list 接口过滤 subtask

### 做法

- 后端 `/agent/sessions` 默认只返回 primary

### 问题

- 用户显式打开过的 subtask 也无法通过现有列表稳定恢复
- 把前端“显示策略”错误转嫁给 API 层
- 会影响其它可能依赖完整 session 列表的前端逻辑

因此不采用。

## 风险与控制

## 风险 1：openedSubtask 与 closedSessions 双状态叠加，语义混淆

### 控制

在代码注释与文档中明确：

- `openedSubtaskSessionIds` = 曾显式打开过
- `closedSessionIds` = 当前是否隐藏

并避免在关闭时同时删除 opened 标记。

## 风险 2：历史 subtask 突然不显示，被误解为“数据丢失”

### 控制

该行为应视为 bug 修复后的正确结果，而不是数据丢失。

若后续需要更强可发现性，可再单独设计会话列表入口；但这不属于 v1 范围。

## 风险 3：服务端返回的同 id session 不是 subtask，白名单脏数据残留

### 控制

- `refreshSessions()` prune 时可结合最新 `serverSessions` 的 `kind` 判定
- 仅保留当前仍存在且 `kind === "subtask"` 的 opened id

## 测试清单

## 核心回归

1. primary session 刷新后行为与现状一致
2. draft session 行为与现状一致
3. tab 编号与排序行为不变
4. `closeSessionTab` 对 primary / subtask 均不破坏 activeKey 切换

## 新增场景

### 场景 1：未打开过的 subtask 不应在刷新后显示

步骤：

1. 主 session 触发 subtask，后端创建子 session
2. 用户不点击子任务卡片
3. 刷新页面

期望：

- 该 subtask session 不显示为 tab

### 场景 2：显式打开过的 subtask 刷新后应恢复

步骤：

1. 主 session 触发 subtask
2. 用户点击子任务卡片打开 subtask
3. 刷新页面

期望：

- 该 subtask session 仍显示为 tab

### 场景 3：显式打开后再关闭，刷新后不应显示

步骤：

1. 用户点击子任务卡片打开 subtask
2. 用户关闭该 subtask tab
3. 刷新页面

期望：

- 因 `closedSessionIds` 生效，该 subtask 不显示
- 但 reopened 后可再次出现

### 场景 4：reopenAll 仅恢复显式打开过的 subtask

步骤：

1. workspace 下存在多个 subtask，其中仅一个被显式打开过
2. 关闭全部可见 tabs 或关闭该 subtask
3. 点击 `reopenAllSessions`

期望：

- primary 按现状恢复
- 仅已在 `openedSubtaskSessionIds` 中的 subtask 被恢复
- 从未显式打开过的 subtask 不出现

### 场景 5：workspace 切换隔离

步骤：

1. 在 workspace A 中打开 subtask A1
2. 切换到 workspace B
3. 再切回 workspace A

期望：

- 仅恢复 A 的 openedSubtask 状态
- 不污染 B

### 场景 6：失效 id 清理

步骤：

1. localStorage 中人为写入不存在的 subtask id
2. 刷新页面并完成 `refreshSessions()`

期望：

- 无效 id 被 prune
- 不影响其它 session 显示

## 实施顺序建议

1. 在 `AgentToolView.vue` 中新增 openedSubtask storage 与恢复/持久化逻辑
2. 接入 `onOpenSubtask(sessionId)` 标记逻辑
3. 修改 `visibleSessions` 的 subtask 过滤规则
4. 在 `refreshSessions()` 中加入 openedSubtask prune
5. 补充前端单测/交互回归验证

## 最终结论

v1 采用最小修复策略：

- 不重构 tabs 模型
- 不改变当前交互形态
- 仅为 `subtask session` 增加“显式打开白名单”约束

通过新增本地持久化的 `openedSubtaskSessionIds`，使刷新恢复时能够区分：

- 用户明确进入过的子会话
- 后台创建但从未查看过的子会话

从而修复“未打开过的子会话刷新后被自动展示”的问题，同时保持现有主会话与 tab 行为稳定。
