# 背景、现状与方案总览

## 需求背景

AI Agent 会话历史中的 `subtask` 卡片目前可以展示：

- 子任务描述；
- Agent 名称或 ID；
- `new`、`fork`、`existing` 模式；
- 子任务 session ID；
- 状态图标；
- 工具错误文本。

用户可以打开 child session 查看详情，但在父会话历史中无法直接回答：

- 这个子任务何时开始；
- 已终止的子任务持续了多久；
- 失败或取消前经历了多长时间。

本需求在不改变 subtask 执行状态机的前提下，为卡片补充稳定、可审计且不会在 `existing` 模式下串台的时间信息。

## 现状调研

### 卡片直接由父 context item 渲染

`AgentClientPane.vue` 遍历父会话 `AgentContextItemRecord[]`，识别 `kind = tool`、`toolName = subtask` 的 item，并直接渲染卡片。当前模板位于：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:161-203`

当前本地 `DisplayItem` 没有时间或 child run 字段：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:821-844`

subtask 分支只从父工具消息的 args/result 中整理描述、模式、Agent 和 child session ID，并沿用父 item 状态：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1649-1679`

### 父 item 已有时间，但语义不正确

共享契约 `AgentContextItemRecordSchema` 已包含：

```ts
createdAt: number;
updatedAt: number;
```

位置：

- `packages/shared/src/contracts/agent.ts:134-150`

这些字段来自 `agent_context_item.created_at/updated_at`，见：

- `apps/api/src/modules/agent/agent.store.ts:1283-1313`

它们表达的是父工具消息项自身的创建与更新，不是 child run 的激活与终止。父工具消息可能在 child run 激活前后更新，也可能因为工具结果写回、取消处理或其他 item 生命周期动作改变。因此本需求不得直接使用它们。

### child run 已有正确的时间和父子关联

`agent_run` 已持久化：

- `parent_run_id`；
- `parent_tool_item_id`；
- `status`；
- `created_at`；
- `updated_at`。

位置：

- `apps/api/src/infra/db/schema.ts:189-203`

父工具与 child run 之间已有唯一索引：

- `apps/api/src/infra/db/schema.ts:288-294`

现有单条查询已经用以下条件找 child run：

```sql
where workspace_id = @workspaceId
  and parent_run_id = @parentRunId
  and parent_tool_item_id = @parentToolItemId
```

位置：

- `apps/api/src/modules/agent/agent.store.ts:1912-1942`

subtask 激活时，父 Run 与父工具 item 被明确写入 child run，`createdAt` 使用 API 时钟：

- `apps/api/src/modules/agent/subtask/subtask-application.ts:305-321`

### run 时间语义已有现成先例

run 创建时，`updatedAt` 初始化为 `createdAt`：

- `apps/api/src/modules/agent/agent.store.ts:1812-1876`

运行期间，run 状态写回可以继续更新 `updatedAt`；终态提交会把 `completed/failed/cancelled` 与终态时间一起写入：

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:320-389`

终态写入前存在终态保护，已终态 run 的重复完成回调返回 false，不再沿正常路径更新：

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:360-365`

现有 session `run-state.lastRun` 已采用：

```ts
startedAt: run.createdAt,
endedAt: run.updatedAt,
durationMs: Math.max(0, run.updatedAt - run.createdAt)
```

位置：

- `apps/api/src/modules/agent/query/context-query-application.ts:118-125`
- `packages/shared/src/contracts/agent.ts:185-195`

本需求复用同一 run 时间口径，但必须按父卡片精确取对应 child run，不能直接复用 session 的 `lastRun`。

## 核心问题

系统中至少有三类对象都可能拥有 `createdAt/updatedAt`：

| 对象 | 语义 | 是否用于本需求 |
|---|---|---|
| 父 `AgentContextItemRecord` | 父工具消息项生命周期 | 不得使用 |
| child `AgentSessionRecord` | 子会话容器生命周期 | 不得使用 |
| child `agent_run` | 当前父工具调用所激活的一次执行 | 必须使用 |

如果不冻结数据归属，开发很容易做出“字段存在即可相减”的错误实现，尤其在 `session.mode = "existing"` 时会把同一 child session 的其他 run 显示到当前卡片。

## 业务逻辑

### 开始时间

- 业务含义：child run 被 API 激活并持久化为 `running` 的时间。
- 数据来源：child `agent_run.createdAt`。
- 展示条件：`subtaskRun` 存在且 `startedAt` 为有效正数。
- 展示范围：running 与所有终态都展示。

### 结束时间

- 业务含义：API 持久化 child run 终态的时间。
- 数据来源：终态 child `agent_run.updatedAt`。
- 本期不直接在 UI 展示“结束时间”，但通过 `endedAt` 保留清晰契约与可测试性。
- `running` 时必须为 `null`。

### 持续时间

- 业务含义：从 child run 激活落库到终态落库的墙钟时长。
- 计算规则：`Math.max(0, updatedAt - createdAt)`。
- 展示条件：child run 状态为 `completed`、`failed` 或 `cancelled`。
- `running` 时必须为 `null`，不得用最新 `updatedAt` 计算“最终持续时间”。

### 状态

- 卡片时间与状态必须来自同一 child run 摘要。
- 摘要存在时，状态图标使用 `subtaskRun.status`。
- 摘要缺失时，退回当前父工具 item `status`，以保持兼容。
- 父工具 `toolError` 仍按现有规则展示；不得因为 child run completed 而隐藏父工具写回错误。

## `existing` 模式为何必须精确关联

`session.mode = "existing"` 允许多个不同父工具调用依次复用同一个 subtask session。示例：

```text
父卡片 A → child session S / child run R1
父卡片 B → child session S / child run R2
```

如果卡片 A 打开时按 session S 查询 `lastRun`，在 R2 完成后 A 也可能错误显示 R2 的时间。正确关系必须是：

```text
卡片 A(item.runId, item.id) → R1(parent_run_id, parent_tool_item_id)
卡片 B(item.runId, item.id) → R2(parent_run_id, parent_tool_item_id)
```

因此 `subtaskSessionId` 只用于打开 child session，不用于卡片 run 时间关联。

## 目标

### 产品目标

- 用户在父会话历史中能看到每个可关联 subtask 的开始时间；
- 用户能看到 completed、failed、cancelled 子任务的持续时间；
- 时间信息在刷新、分页和再次打开历史时保持稳定；
- `existing` 模式下每张卡片始终显示自己对应 run 的时间。

### 技术目标

- 由 API 读侧统一解释底层 run 字段，前端只消费产品语义字段；
- 列表和单项读取复用同一投影函数；
- 列表使用批量 child run 查询，避免 N+1；
- public context-items 与 internal `context-items-tail` 共享同一 context item 契约和投影语义；
- 兼容没有 child run 关联的旧历史项；
- 不新增持久化事实源。

### 审查目标

代码审查必须能回答：

- 摘要是否来自精确 child run；
- running/terminal 不变量是否由契约和代码共同保证；
- 列表是否批量查询；
- 单项刷新是否保留摘要；
- copied item、旧数据和缺失关系是否安全降级；
- UI 是否只在终态显示持续时间；
- 状态图标是否按 child 优先、parent fallback。
- 重复 parent key 是否按唯一 fail-open 合同处理，而不是任选、抛错或静默覆盖。

## 本期范围

```text
Shared public contract
  → context item 增加可选 subtaskRun 摘要
  → public list/single 与 internal tail 共同受影响
API store/query read side
  → 批量/单条精确关联 child run
  → 统一投影列表与单项结果
Web display projection
  → 保留 subtaskRun
  → 格式化开始时间与持续时间
  → child 状态优先
Tests / i18n
```

## 非目标

- 不新增 `ended_at`、`duration_ms` 等数据库列；
- 不修改 `agent_run` 生命周期或终态幂等逻辑；
- 不修改 subtask new/fork/existing 的创建语义；
- 不实现运行中动态持续时间；
- 不展示结束时间；
- 不提供模型纯推理耗时、工具耗时拆分、排队耗时拆分；
- 不为每张卡片增加独立 API 请求或 WebSocket/SSE 订阅；
- 不回填或修复无法关联 child run 的历史数据；
- 不追溯 fork source 给 copied item 恢复 `runId`；
- 不改变卡片点击打开 child session 的逻辑；
- 不借此重构整个 `AgentClientPane.vue`。

## 端到端方案

```text
public context-items / context-items/:itemId / internal context-items-tail
  → 读取父 context item
  → 找出有效 subtask parent key：
       workspaceId
       parentRunId = item.runId
       parentToolItemId = item.id
  → 批量或单条读取 child agent_run
  → parent key 重复命中时省略该 key 摘要并记录一次 error 诊断
  → 生成 subtaskRun 产品摘要
  → 返回共享契约
  → Web 映射到 DisplayItem
  → startedAt 格式化为本地开始时间
  → terminal durationMs 格式化为持续时间
  → 状态图标优先使用 child status
```

## 一致性说明

`subtaskRun` 是请求时派生快照，不要求与数据库更新具备跨表事务快照级强一致。允许一次轮询短暂读到 running，下一次读到 terminal；不允许同一次响应生成违反状态不变量的字段组合。

同一 parent key 命中多条 child runs 时采用 fail-open：受影响 item 不带 `subtaskRun`，同一响应中的其他 items 正常返回，接口保持成功；API 每请求每冲突 key 记录一次 `error` 级结构化诊断，固定 `diagnosticCode = "AGENT_SUBTASK_RUN_PARENT_CONFLICT"`。这是运行时可用性合同，不代表可以容忍数据损坏；测试、预发布或灰度发现该诊断必须阻断发布或继续放量。

## 分页与容量基线

必须区分三个层次：

- public `AgentContextItemsQuerySchema`：`tailLimit` 与 `limit` 数值范围均为 `1..500`；
- internal `AgentSessionContextItemsTailRequestSchema`：`tailLimit` 为整数 `1..500`；
- 当前 Web：`INITIAL_TAIL_LIMIT = 100`、`HISTORY_PAGE_LIMIT = 100`；
- Store `normalizeListLimit()`：内部防御性使用 fallback `100` 并 clamp 到 `1..1000`，不构成 public/internal API 对外承诺。

此外：

- public `afterId` 没有对应 response item 数量上限，可能返回超过 500 个增量 items；
- 无参数 full transcript 可返回整个 transcript，也可能超过 500/1000；
- 因此 child run 批量查询不得以“单页最多 500”或“最多 1000”为算法前提；JSON1 可以单查询承载，分块方案则必须按明确 batch size 计算 `ceil(uniqueParentKeys / batchSize)` 次查询，禁止逐卡片查询。

当前 Web 对父工具非终态 item 会主动调用单项接口刷新：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2581-2602`

因此列表和单项接口必须都投影 `subtaskRun`。如果只改列表，后续单项刷新会用不含摘要的 item 覆盖本地数据，造成时间字段闪失或永久丢失。

## 实施前必须复核

- `agent_run` 终态后是否仍有新的正常写入路径；
- parent tool 唯一索引是否仍存在；
- `findSubtaskRunByParentTool` 的过滤条件是否仍与 lineage 语义一致；
- `AgentContextItemRecordSchema` 的序列化兼容行为；
- `AgentSessionContextItemsTailResponseSchema` 是否仍直接复用 `AgentContextItemRecordSchema`；
- public/internal 查询上限、Web 100 条配置和 Store 1000 clamp 是否仍与本文一致；
- context-items 所有分页路径和单项路径是否仍经过 `ContextQueryApplication`；
- Web 非终态刷新是否仍会用单项结果整体替换 item；
- 代码路径与行号是否漂移。

任一关键前提不成立时，必须更新设计并重新评审后再实施。
