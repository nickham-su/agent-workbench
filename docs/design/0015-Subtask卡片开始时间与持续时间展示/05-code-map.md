# 代码地图与现状证据

> 本文件行号基于设计编写时的仓库状态。实施前必须用 `rg`/IDE 复核；行号漂移不改变规范性语义。如果代码职责已变化，必须先更新本文和影响分析。

## 端到端代码链路

```text
Web AgentClientPane
  → getAgentContextItems / getAgentContextItem
  → public agent routes
  → Agent service facade
  → ContextQueryApplication
  → SqliteContextQueryStore
  → agent.store transcript + child run query
  → Shared AgentContextItemRecord schema response
  → Web DisplayItem
  → subtask card
```

## Shared 契约

### Context item

文件：

- `packages/shared/src/contracts/agent.ts:134-150`

当前字段包括：

- `id`；
- `workspaceId`；
- `sessionId`；
- `runId`；
- `kind/status/output`；
- `createdAt/updatedAt`。

候选改动：

- 新增 `AgentSubtaskRunSummarySchema` 和 type；
- 给 `AgentContextItemRecordSchema` 增加 optional `subtaskRun`；
- 保持 `createdAt/updatedAt` 原语义不变。

### Context item 列表响应

- `packages/shared/src/contracts/agent.ts:152-159`

`items` 直接使用 `AgentContextItemRecordSchema`，契约扩展会自动覆盖列表。

### Internal context-items tail 响应

- `packages/shared/src/contracts/agent.ts:379-398`

关键事实：

- `AgentSessionContextItemsTailRequestSchema.tailLimit` 是整数 `1..500`；
- `AgentSessionContextItemsTailResponseSchema.items` 直接使用 `AgentContextItemRecordSchema`；
- 因此新增 `subtaskRun` 同时影响 internal plugin tail 消费者，不能只验证 public Web 路径。

### Public context-items 查询上限

- `packages/shared/src/contracts/agent.ts:481-488`

public `tailLimit` 与 `limit` 都是数值 `1..500`；`afterId` 没有 response item 数量上限。

### 现有 session run 摘要先例

- `packages/shared/src/contracts/agent.ts:169-195`
- `packages/shared/src/contracts/agent.ts:197-228`

现有：

- `activeRun.startedAt`；
- `lastRun.startedAt/endedAt/durationMs`。

本需求应复用命名与 duration 语义，但不得复用 session-level `lastRun` 作为卡片关联数据。

## 数据库与 Store

### `agent_run` 表

- `apps/api/src/infra/db/schema.ts:189-203`

关键列：

```text
run_id
workspace_id
session_id
parent_run_id
parent_tool_item_id
status
created_at
updated_at
```

本期不改 schema。

### parent tool 唯一索引

- `apps/api/src/infra/db/schema.ts:288-294`

当前索引：

```sql
create unique index idx_agent_run_parent_tool_unique
on agent_run(parent_run_id, parent_tool_item_id)
where parent_tool_item_id is not null
```

实施前必须确认索引仍存在且 migration/ensure 逻辑正常。

### run 创建

- `apps/api/src/modules/agent/agent.store.ts:1812-1876`

证据：

- `createdAt = params.createdAt`；
- 初始 `updatedAt = params.createdAt`。

### 精确 child run 单条查询

- `apps/api/src/modules/agent/agent.store.ts:1912-1942`

当前 `findSubtaskRunByParentTool()` 已按：

```text
workspace_id
parent_run_id
parent_tool_item_id
```

查询并返回 `createdAt/updatedAt`。

候选改动：

- 保留该函数给 subtask lineage/reuse；
- 新增 `SubtaskRunProjectionRecord` 最小投影及批量查询函数，只返回 runId、parent key、status、createdAt、updatedAt；
- 不循环调用该函数实现列表投影。
- 批量结果按 parent key 分组；重复命中不得覆盖，必须交由 query application 执行 fail-open 和一次性诊断。

### run 状态更新

- `apps/api/src/modules/agent/agent.store.ts:2107-2115`

`updateRunRecordStatus()` 同时更新 `status` 和 `updated_at`。

### recovery 失败写入

- `apps/api/src/modules/agent/agent.store.ts:2118-2129`

只把 `running` run 更新为 `failed`，`updated_at` 是恢复判定时间。

这说明失败持续时间是墙钟近似值，不是精确崩溃时刻。

## Subtask 激活与 lineage

### 类型

- `apps/api/src/modules/agent/subtask/subtask-ports.ts:18-33`

`SubtaskRunRecord` 已包含：

- parent fields；
- status；
- createdAt/updatedAt。

该类型属于 subtask application 端口。query 模块不得为本需求依赖其完整字段，应使用技术设计中的最小 `SubtaskRunProjectionRecord`。

### 激活写入

- `apps/api/src/modules/agent/subtask/subtask-application.ts:284-321`

关键证据：

```ts
parentRunId: parentRun.runId,
parentToolItemId: anchor.id,
createdAt: clock.nowMs()
```

### 唯一冲突 reuse

- `apps/api/src/modules/agent/subtask/subtask-application.ts:337-349`

唯一冲突后按相同 parent key 找 winner，支持“一张父工具卡片一个 child run”的幂等语义。

## Run lifecycle

### child run 创建

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:191-205`

child run 以 `running` 和激活时间创建。

### 运行期间 `updatedAt`

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:320-356`

run 仍 active 时，状态写回可更新 `updatedAt`。因此 running 不能用 `updatedAt - createdAt` 作为最终持续时间。

### 终态写入与冻结

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:360-389`

关键证据：

- 读取当前 run；
- 已终态时直接返回 false；
- 未终态时写入 terminal status 和 `updatedAt`；
- cancelled 同时收敛非终态 context items。

实施前必须搜索所有 `updateRunRecordStatus`/直接 `agent_run` UPDATE，确认不存在终态后的普通更新旁路。

### Worker 终态时间来源

- `apps/agent-worker/src/runtime/runner.ts:2622-2643`

Worker `finishOnce()` 调用 `completeRun` 时传当前时间。该位置是语义证据，本期原则上不改。

## Query read side

### Query port

- `apps/api/src/modules/agent/query/context-query-ports.ts:19-31`

当前没有 parent tools 批量 child run 查询能力。

候选改动：

- 增加 `listSubtaskRunProjectionsByParentTools()` 或职责等价名称；
- 冲突诊断在 query application 请求作用域完成，不在 store 静默覆盖。

### SQLite query store

- `apps/api/src/modules/agent/query/sqlite-query-stores.ts:20-37`

当前把 transcript/run 查询委托给 `agent.store`。

候选改动：

- 导入并转发新的批量 store 方法。

### Context list application

- `apps/api/src/modules/agent/query/context-query-application.ts:18-68`

当前四种读取路径：

- tail；
- before；
- after；
- full transcript。

当前直接返回 `items`。候选改动是在 window 决定之后、response 返回之前统一 enrich。

`ContextQueryApplicationDependencies.logger` 当前仅有 `warn`；固定冲突合同要求扩展结构化 `error` 能力或等价 diagnostics port。

### Context single item application

- `apps/api/src/modules/agent/query/context-query-application.ts:71-75`

当前直接返回 transcript item。候选改动必须复用列表相同 projector。

### 现有 lastRun duration 公式

- `apps/api/src/modules/agent/query/context-query-application.ts:90-142`

其中 `:118-125` 已使用：

```ts
Math.max(0, updatedAt - createdAt)
```

该公式是本设计 run 时间语义的现有生产先例。

## Public routes

### 列表

- `apps/api/src/modules/agent/routes/agent-public.routes.ts:302-334`

响应 schema：`AgentContextItemsResponseSchema`。

### 单项

- `apps/api/src/modules/agent/routes/agent-public.routes.ts:336-352`

响应 schema：`AgentContextItemRecordSchema`。

候选改动：通常不需要改 route；共享 schema 和 service 返回扩展后自动生效。实施时必须验证 Fastify 序列化没有剥离新字段。

### Internal tail route

- `apps/api/src/modules/agent/routes/agent-status-sse.routes.ts:145-183`

关键事实：

- route 是 `POST /api/internal/agent/sessions/context-items-tail`；
- response schema 是 `AgentSessionContextItemsTailResponseSchema`；
- handler 调用同一个 `service.getContextItems(sessionId, { tailLimit })`；
- 无需另写 projector，但必须验证 schema 序列化、fail-open 冲突语义和插件消费者兼容。

相关 integration 基线：

- `apps/api/src/modules/agent/integration/agent-peripheral-status.integration.test.ts:487-592`

### Session run-state

- `apps/api/src/modules/agent/routes/agent-public.routes.ts:390-403`

这是按 session 查询的 endpoint。本需求不得让父卡片逐个调用它。

## Context item 存储读取

### 单项 SQL

- `apps/api/src/modules/agent/agent.store.ts:1283-1313`

这里读取 parent item 的 `created_at/updated_at`。这些字段不用于 child run 时间。

### Transcript 入口

- `apps/api/src/modules/agent/agent.store.ts:1269-1275`

列表方法返回持久化 context item。`subtaskRun` 应在 query application 派生，不应侵入通用持久化 mapper。

### Store 容量 guard

- `apps/api/src/modules/agent/agent.store.ts:1277-1281`
- `apps/api/src/modules/agent/agent.store.ts:1343-1369`

`normalizeListLimit()` fallback 为 100、clamp 为 `1..1000`，只用于 tail/before store window。它不是 public/internal API 上限；full transcript 与 after window 不受该 clamp 约束。

## Web API

- `apps/web/src/shared/api/api.ts:1119-1144`：context item 列表；
- `apps/web/src/shared/api/api.ts:1147-1154`：单项；
- `apps/web/src/shared/api/api.ts:1156-1163`：session run-state。

候选改动：

- 列表/单项函数通常无需改 URL 或函数签名，shared type 扩展后自动获得字段；
- 不增加基于 child session 的请求。

## Web 卡片与映射

### 卡片模板

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:161-203`

候选改动：

- 新增时间行；
- 图标 helper 输入改为 effective child-first status；
- 不改变 click/copy/error 行。

### `DisplayItem`

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:821-844`

候选改动：

- 新增 `subtaskRun?: AgentSubtaskRunSummary`；
- 或额外新增格式化 text 字段，但不得丢失原始 summary status。

### 现有 duration formatter

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1434-1457`

当前同时用于 running header 与 lastRun duration。若抽取到 helper，必须保证 header 回归。

### subtask 映射

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1526-1542`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1649-1679`

当前：

- 从 result/text 提取 `subtaskSessionId`；
- 从 args 提取描述、模式、Agent；
- 使用 parent item status；
- 不保留 parent item 时间。

候选改动仅透传 API `subtaskRun`；不得从 parent 时间自行构造。

### 卡片识别和图标

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1948-1950`：`isSubtaskCard`；
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1983-2002`：状态 icon/spin/class。

候选改动：

- 增加 effective status helper；
- icon/spin/class 必须使用同一结果。

### 本地 item 替换和变化检测

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2462-2470`：整体替换；
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2477-2485`：变化比较。

候选改动：

- `hasItemChanged()` 纳入 `subtaskRun`；
- 不依赖 parent item `updatedAt` 反映 child run 更新。

### 列表与单项刷新

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2545-2578`：full/tail/after；
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2581-2602`：非终态单项；
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2604-2613`：terminal settle tail；
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2620-2631`：轮询调度。

必须验证 child terminal 摘要可以通过这些现有路径到达，不增加逐卡片永久轮询。

### Web 实际分页值

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:854-856`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2227-2230`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2545-2567`

`INITIAL_TAIL_LIMIT = 100`、`HISTORY_PAGE_LIMIT = 100`。性能测试覆盖该实际值，但不得把 100 当成 API 上限。

## Web i18n

- `apps/web/src/shared/i18n/locales/zh-CN.ts:332-338`
- `apps/web/src/shared/i18n/locales/en-US.ts:334-340`

新增：

- `subtaskStartedAt`；
- `subtaskDuration`。

## 测试落点

### Shared

当前 shared package没有专门 agent context item schema test。可：

- 在 `packages/shared/tests/` 增加契约测试；
- 或在 API `context-item-contract.test.ts` 扩展序列化/校验覆盖。

实施时需确认根测试命令如何执行 `packages/shared/tests`；如果没有现成 script，至少通过 targeted `tsx --test` 和 shared build/typecheck。

### API Query

- `apps/api/src/modules/agent/query/context-query-application.test.ts`

优先覆盖：

- projector；
- 列表/单项；
- running/terminal/缺失；
- store 批量调用次数。

### API Contract/Integration

- `apps/api/src/modules/agent/context-item-contract.test.ts`
- `apps/api/src/modules/agent/integration/agent-read-context.integration.test.ts`
- `apps/api/src/modules/agent/integration/agent-subtask-lineage.integration.test.ts`
- `apps/api/src/modules/agent/integration/agent-subtask-routes.integration.test.ts`
- `apps/api/src/modules/agent/integration/agent-run-cancel.integration.test.ts`
- `apps/api/src/modules/agent/integration/agent-startup-recovery.integration.test.ts`
- `apps/api/src/modules/agent/integration/agent-peripheral-status.integration.test.ts`（internal tail）

按职责选择最小集合，不应把所有场景塞进一个超大测试文件。

冲突 fail-open 可由 query store mock 返回重复记录稳定构造；不得为制造异常破坏真实唯一索引。集成层至少验证 public/internal 正常摘要不被 schema 剥离。

### Web

现有相关小型测试：

- `apps/web/src/features/workspace/tools/agent/subtaskSessionId.test.ts`

建议新增：

- `subtaskRunDisplay.ts`；
- `subtaskRunDisplay.test.ts`。

如果 Web test script 继续显式列文件，需把新测试加入：

- `apps/web/package.json:10`

Vue 模板行为可通过抽纯函数测试加必要组件/手工验收覆盖；如果项目当前没有 Vue component test 基础设施，不应为本需求引入大型框架。

## 授权文件清单

预期生产改动：

```text
packages/shared/src/contracts/agent.ts
apps/api/src/modules/agent/agent.store.ts
apps/api/src/modules/agent/query/context-query-ports.ts
apps/api/src/modules/agent/query/sqlite-query-stores.ts
apps/api/src/modules/agent/query/context-query-application.ts
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
apps/web/src/shared/i18n/locales/zh-CN.ts
apps/web/src/shared/i18n/locales/en-US.ts
可选：apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.ts
```

预期测试改动按 [06-testing-acceptance.md](./06-testing-acceptance.md)。

原则上不应修改：

```text
apps/api/src/infra/db/schema.ts
apps/api/src/modules/agent/subtask/subtask-application.ts
apps/api/src/modules/agent/lifecycle/* 生产写路径
apps/agent-worker/src/runtime/runner.ts
apps/web/src/shared/api/api.ts URL/请求数量
```

上列“不应修改”文件可以在测试或代码地图复核中读取；若必须改生产逻辑，触发设计暂停。
