# 技术方案与实体设计

## 总体结构

```text
SQLite agent_context_item + agent_run
          ↓
agent.store 批量读取 parent-key 对应 child runs
          ↓
ContextQueryStore
          ↓
ContextQueryApplication 统一投影
          ↓
AgentContextItemRecord.subtaskRun?
          ↓
Web AgentContextItemRecord[]
          ↓
displayItems / DisplayItem
          ↓
subtask 卡片开始时间、持续时间、effective status
```

## 实体语义

### ParentSubtaskItem

不是新增持久化实体，是满足以下条件的父 context item：

```ts
item.kind === "tool"
item.output.type === "tool"
item.output.toolName === "subtask"
item.runId !== null
```

关联键：

```ts
type SubtaskParentKey = {
  parentRunId: string;
  parentToolItemId: number;
};
```

`workspaceId` 由 query session 统一提供，但 store 查询必须同时按 workspace 过滤。

### SubtaskRunProjectionRecord

query read-side 从现有 `agent_run` 读取的最小投影实体；它不同于 subtask application 端口中的完整 `SubtaskRunRecord`，不携带本需求无关的 session、agent 或模型字段。

```ts
type SubtaskRunProjectionRecord = {
  runId: string;
  parentRunId: string;
  parentToolItemId: number;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};
```

### AgentSubtaskRunSummary

新增公共读模型。推荐 TypeScript 形态：

```ts
export type AgentSubtaskRunSummary =
  | {
      runId: string;
      status: "running";
      startedAt: number;
      endedAt: null;
      durationMs: null;
    }
  | {
      runId: string;
      status: "completed" | "failed" | "cancelled";
      startedAt: number;
      endedAt: number;
      durationMs: number;
    };
```

约束：

- `startedAt > 0`，shared schema 用 `exclusiveMinimum: 0` 直接约束，projector 同时校验有限正数；
- `endedAt` 仅终态为正数，shared schema 同样用 `exclusiveMinimum: 0`；
- `durationMs >= 0`；
- `durationMs = Math.max(0, endedAt - startedAt)`；
- 不包含 `sessionId`，避免前端误用它重新关联；现有卡片已从 tool result 提取 `subtaskSessionId`；
- 不暴露 parent key，父 item 本身已经携带关联上下文；
- 不暴露原始 `updatedAt`，避免 running 被误解释。

## Shared 契约设计

文件：

- `packages/shared/src/contracts/agent.ts`

建议新增：

```ts
export const AgentSubtaskRunTerminalStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);

export const AgentSubtaskRunSummarySchema = Type.Union([
  Type.Object(
    {
      runId: Type.String({ minLength: 1 }),
      status: Type.Literal("running"),
      startedAt: Type.Number({ exclusiveMinimum: 0 }),
      endedAt: Type.Null(),
      durationMs: Type.Null()
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      runId: Type.String({ minLength: 1 }),
      status: AgentSubtaskRunTerminalStatusSchema,
      startedAt: Type.Number({ exclusiveMinimum: 0 }),
      endedAt: Type.Number({ exclusiveMinimum: 0 }),
      durationMs: Type.Number({ minimum: 0 })
    },
    { additionalProperties: false }
  )
]);
```

然后扩展：

```ts
export const AgentContextItemRecordSchema = Type.Object({
  // existing fields
  subtaskRun: Type.Optional(AgentSubtaskRunSummarySchema)
});
```

兼容规则：

- 字段 optional；旧服务端/旧历史可以缺失；
- 非 subtask item 必须省略；
- 未关联 child run 的 subtask item 必须省略；
- 不返回 `subtaskRun: null`；
- 新客户端必须容忍缺失；
- public list/single 分别复用 `AgentContextItemsResponseSchema` 与 `AgentContextItemRecordSchema`；
- internal `AgentSessionContextItemsTailResponseSchema.items` 也直接复用 `AgentContextItemRecordSchema`，会同步携带摘要；
- 无需新增 endpoint，但三种响应的序列化和消费者兼容都必须验证。

如果共享契约已有可复用 terminal status schema，可复用，但不得把 session `idle` 或 context item `queued/streaming` 引入 child run status。

## API Store 设计

### 现有能力

现有 `findSubtaskRunByParentTool()` 支持单键查询：

- `apps/api/src/modules/agent/agent.store.ts:1912-1942`

保留该能力供 subtask application 幂等/reuse 使用。本需求不应改变其生产语义。

### 新增批量 read-side 方法

建议新增独立 read-side 方法，命名可按项目风格调整：

```ts
listSubtaskRunProjectionsByParentTools(
  db: Db,
  input: {
    workspaceId: string;
    parents: SubtaskParentKey[];
  }
): SubtaskRunProjectionRecord[];
```

输入规范化：

- `workspaceId` 必须非空；
- `parentRunId` 使用 `trim()` 仅判断是否为全空白；
- 通过合法性判断后，关联键、去重键、JSON/SQL 查询参数都必须保留父 item 的 `item.runId` 原值，不得使用 trim 后的值；
- `parentToolItemId` 必须为正整数；
- 对 `(parentRunId, parentToolItemId)` 去重；
- 空 parents 直接返回空数组，不执行 SQL；
- 不得假设输入最多 500 或 1000：public `tailLimit/limit` 上限 500，internal `tailLimit` 上限 500，Web 当前使用 100，但 public `afterId` 和无参数 full transcript 可以返回更大集合；
- Store `normalizeListLimit()` 的 1000 clamp 只保护 tail/before，不限制 full/after；
- JSON1 可使用单参数；其他参数化方案必须显式分块并考虑 SQLite 参数限制。

### 推荐 SQL

推荐 JSON1 单参数批量方案：

```sql
with requested as (
  select
    json_extract(value, '$.parentRunId') as parentRunId,
    cast(json_extract(value, '$.parentToolItemId') as integer) as parentToolItemId
  from json_each(@parentsJson)
)
select
  child.run_id as runId,
  child.parent_run_id as parentRunId,
  child.parent_tool_item_id as parentToolItemId,
  child.status,
  child.created_at as createdAt,
  child.updated_at as updatedAt
from requested
inner join agent_run child
  on child.parent_run_id = requested.parentRunId
 and child.parent_tool_item_id = requested.parentToolItemId
where child.workspace_id = @workspaceId
```

安全与正确性：

- JSON 由 `JSON.stringify` 产生，不手写 SQL 值；
- workspace 过滤不能省略；
- 不按 child session ID 查询；
- 不使用 `order by updated_at desc limit 1`；
- partial unique index正常时保证唯一，但运行时仍检测重复；
- 冲突 key 固定 fail-open：该 key 不进入投影 map，同响应其他 key 保留；不得抛整个接口、任选或静默覆盖；
- 每请求每冲突 key 记录一次 `logger.error`，固定 `diagnosticCode = "AGENT_SUBTASK_RUN_PARENT_CONFLICT"`，包含 workspaceId、parent key、排序 runIds 与 matchCount；
- store 返回原始最小记录数组，由 application 在请求作用域分组和去重日志。

如果 JSON1 不可用，使用参数化分块查询。batch size 必须是显式常量，查询次数必须为 `ceil(uniqueParentKeys / batchSize)`；不得逐卡片查询。测试至少覆盖 500 keys 和超过 1000 keys 的 full/after 输入。

### Store port

扩展 `ContextQueryStore`：

```ts
listSubtaskRunProjectionsByParentTools(input: {
  workspaceId: string;
  parents: SubtaskParentKey[];
}): SubtaskRunProjectionRecord[];
```

文件：

- `apps/api/src/modules/agent/query/context-query-ports.ts:19-31`
- `apps/api/src/modules/agent/query/sqlite-query-stores.ts:20-37`

## API 投影设计

### 纯转换函数

建议在 query application 或相邻专用模块中建立纯函数：

```ts
function toSubtaskRunSummary(
  run: SubtaskRunProjectionRecord
): AgentSubtaskRunSummary | null {
  const startedAt = Number(run.createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;

  if (run.status === "running") {
    return {
      runId: run.runId,
      status: "running",
      startedAt,
      endedAt: null,
      durationMs: null
    };
  }

  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "cancelled"
  ) return null;

  const endedAt = Number(run.updatedAt);
  if (!Number.isFinite(endedAt) || endedAt <= 0) return null;

  return {
    runId: run.runId,
    status: run.status,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt)
  };
}
```

### Item 识别

```ts
function toParentKey(item: AgentContextItemRecord): SubtaskParentKey | null {
  if (item.kind !== "tool") return null;
  if (item.output.type !== "tool") return null;
  if (item.output.toolName !== "subtask") return null;
  if (typeof item.runId !== "string" || !item.runId.trim()) return null;
  if (!Number.isInteger(item.id) || item.id <= 0) return null;
  return { parentRunId: item.runId, parentToolItemId: item.id };
}
```

不得：

- 从 `item.output.result.subtaskSessionId` 关联；
- 从 `item.output.text` 解析 run/session；
- 从 `prevId`、fork metadata 或原 session 回溯；
- 对非 subtask tool item 添加摘要。

### 批量 enrich

建议纯入口：

```ts
private enrichSubtaskRuns(
  workspaceId: string,
  items: AgentContextItemRecord[]
): AgentContextItemRecord[];
```

步骤：

- 收集并去重 parent keys；
- 空集合直接返回原 items 或浅拷贝；
- store 批量读取 `SubtaskRunProjectionRecord[]`；
- 以 `parentRunId + parentToolItemId` 分组，不使用覆盖式 map；
- 单条分组进入可投影 map；
- 多条分组进入 conflict set，不选择任何 run；
- 每个 conflict key 在本请求记录一次固定 error 诊断；
- 对每个符合条件 item 生成 summary；
- item key 位于 conflict set 时省略 `subtaskRun`；
- summary 有效才返回 `{ ...item, subtaskRun: summary }`；
- 其他 item 保持原结构；
- 不修改持久化对象，不把字段写入 store。

`ContextQueryApplicationDependencies.logger` 当前只有 `warn`；实施需扩展为结构化 `error(bindings, message)`，或注入职责等价的 diagnostics port。不得使用 `console.error`，不得在分块 store 循环中重复打印。

固定日志示意：

```ts
logger.error({
  diagnosticCode: "AGENT_SUBTASK_RUN_PARENT_CONFLICT",
  workspaceId,
  parentRunId,
  parentToolItemId,
  runIds: [...runIds].sort(),
  matchCount: runIds.length
}, "multiple subtask runs matched one parent tool");
```

### 列表接口

`ContextQueryApplication.getContextItems()` 当前在读取 window 后直接返回 `items`：

- `apps/api/src/modules/agent/query/context-query-application.ts:18-68`

修改为：

```ts
const projectedItems = this.enrichSubtaskRuns(session.workspaceId, items);
return { ... , items: projectedItems };
```

必须覆盖：

- tail；
- before；
- after；
- full transcript。
- internal tail route 通过同一 `service.getContextItems(sessionId, { tailLimit })` 自动复用投影。

### 单项接口

`getContextItem()` 当前直接返回 store item：

- `apps/api/src/modules/agent/query/context-query-application.ts:71-75`

修改为复用同一批量方法：

```ts
return this.enrichSubtaskRuns(session.workspaceId, [item])[0]!;
```

单项使用批量入口是有意设计，用来消除两套映射分支。单项一次 SQL 是正常的，不属于列表 N+1。

单项冲突时仍 fail-open：返回 parent item、省略 `subtaskRun`、记录一次固定 error；不得让 public single 成为不同的 fail-close 分支。

### Artifact 方法影响

`getApplyPatchUiArtifact()` 与 `getWriteUiArtifact()` 当前通过 `getContextItem()` 获取 item。扩展字段不会改变它们的工具断言，但必须补回归，确认额外投影没有影响非 subtask artifact 读取。

## 数据流与时序

### child 尚未建立到 running

```text
parent tool item 已可见
  → context-items：无 subtaskRun
  → Web：父状态图标，无时间行

child activation 写 agent_run(createdAt, running)
  → 下一次列表/单项读取
  → subtaskRun.running(startedAt, null, null)
  → Web：child running 图标 + 开始时间
```

### running 到 terminal

```text
worker/取消/recovery 提交 terminal(updatedAt)
  → agent_run status/updatedAt 更新
  → context-items 读侧生成 terminal summary
  → Web 单项或列表刷新整体替换 item
  → child terminal 图标 + 开始时间 + 持续时间
```

父 tool item 的 terminal 写回与 child run terminal 写入可能存在短暂先后差异。状态图标 child 优先可以更准确反映 child；没有摘要时仍保留父状态。

## 前端设计

### DisplayItem

在 `AgentClientPane.vue` 的 `DisplayItem` 中增加：

```ts
subtaskRun?: AgentSubtaskRunSummary;
```

优先直接从 shared 导入类型，不在 Web 重复声明结构。

位置：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:821-844`

### 映射

subtask 分支透传：

```ts
...(item.subtaskRun ? { subtaskRun: item.subtaskRun } : {})
```

不得从 parent `item.createdAt/updatedAt` 生成该字段。

位置：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1649-1679`

### Effective status

建议抽纯函数：

```ts
function subtaskDisplayStatus(item: DisplayItem) {
  return item.subtaskRun?.status ?? item.status;
}
```

模板的 icon、class、spin 都使用同一个结果，防止不同属性采用不同状态来源。

现有 icon helpers 接受 context item status，其中包括 queued/streaming。实现可以：

- 让 helper 继续接受现有联合，child status 是其子集；或
- 定义局部 display status 联合。

不得把 child `running` 映射为 `streaming` 或 queued。

### 开始时间格式化

建议抽纯函数到可测试模块，例如：

- `apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.ts`

职责：

```ts
formatSubtaskStartedAt(startedAt: number, options?): string
formatElapsedDuration(ms: number): string
resolveSubtaskDisplayStatus(...): ...
```

如果为了最小改动保留在 Vue 文件内，必须提供可测试 seam；不得只依赖手工验收。

开始时间算法必须将 `startedAt` 和注入的/当前的 `now` 使用同一浏览器本地时区转换后比较日期，并生成：

```text
今天：HH:mm
非今天：MM-DD HH:mm
```

需对非有限、`<=0`、无效时区返回空字符串；无效 `now` 无法判定今天时按非今天格式展示；不显示年份、秒或毫秒；模板在空字符串时不显示时间行。实现须捕获 `Intl.DateTimeFormat` 对无效时区抛出的 `RangeError`。测试 seam 必须可注入 `timeZone` 和 `now`，不得依赖 CI 默认时区或当前日期。

### 持续时间

复用现有 `formatElapsedDuration()` 语义。若抽到新模块，session header 与 subtask 卡片应共同使用，避免两套格式漂移；抽取不得改变当前 header 输出。

### 模板

推荐：

```vue
<div
  v-if="item.subtaskRun && formatSubtaskStartedAt(item.subtaskRun.startedAt)"
  class="pt-0.5 text-[color:var(--text-secondary)] flex flex-wrap items-center gap-x-3 gap-y-0.5"
>
  <span>
    {{ t("agent.client.subtaskStartedAt") }}:
    {{ formatSubtaskStartedAt(item.subtaskRun.startedAt) }}
  </span>
  <span v-if="item.subtaskRun.durationMs != null">
    {{ t("agent.client.subtaskDuration") }}:
    {{ formatElapsedDuration(item.subtaskRun.durationMs) }}
  </span>
</div>
```

避免在模板中多次格式化可通过 DisplayItem 预计算 `subtaskStartedAtText/subtaskDurationText`，两种方式均可；但原始 `subtaskRun` 必须保留用于状态。

### i18n

新增：

```ts
// zh-CN.ts
subtaskStartedAt: "开始时间",
subtaskDuration: "持续时间",

// en-US.ts
subtaskStartedAt: "Started",
subtaskDuration: "Duration",
```

位置基线：

- `apps/web/src/shared/i18n/locales/zh-CN.ts:332-338`
- `apps/web/src/shared/i18n/locales/en-US.ts:334-340`

## 刷新与变化检测

当前 `upsertItem()` 会整体替换 item：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2462-2470`

当前 `hasItemChanged()` 只比较 parent item 的 `updatedAt/status/archive/output`：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2477-2485`

child run 更新不会必然改变 parent item `updatedAt`。因此必须把 `subtaskRun` 纳入变化检测，例如：

```ts
if (JSON.stringify(current.subtaskRun) !== JSON.stringify(latest.subtaskRun)) return true;
```

即使 `upsertItem()` 无条件替换，变化检测仍影响滚动稳定行为和 UI 更新判定，不能遗漏。

轮询终止边界：

- child running 时，父 subtask tool item通常仍为非终态，因此会进入单项轮询；
- child terminal 与父工具 terminal 写回之间的 settle poll 提供短暂补拉；
- 本期不新增永久轮询；
- 必须通过集成/前端测试证明最终 terminal 摘要能到达卡片。

如果真实时序证明 parent item 可能先 terminal 且后续 child terminal 永远不会触发现有任何一次列表/单项刷新，必须暂停并评审刷新触发方案，不得偷偷增加每卡片定时器。

## 性能与容量

- `subtaskRun` 只附加于 subtask tool item；
- public `tailLimit/limit` schema 上限均为 500；
- internal tail `tailLimit` schema 上限为 500；
- Web `INITIAL_TAIL_LIMIT` 与 `HISTORY_PAGE_LIMIT` 均为 100；
- Store tail/before guard clamp 到 1000，但不是接口容量合同；
- public `afterId` 与 full transcript 可能超过 500/1000 items；
- 批量查询输入先去重；
- JSON1 时查询次数为 0 或 1；分块时为 `ceil(uniqueParentKeys / batchSize)`；
- 不为非 subtask 页面执行 child run 查询；
- 不增加 Web 请求数；
- 不为 running 卡片增加 timer；
- SQL 应利用 `idx_agent_run_parent_tool_unique` 的 leading columns；
- 性能测试至少覆盖 Web 100、public/internal 500，以及 full/after 超过 1000 unique parent keys。

## 安全与隐私

新增摘要只包含：

- run ID；
- run 状态；
- 时间数值；

不包含 prompt、tool args/result、模型输出、工作区路径或凭据。不得在投影失败日志中打印 item output 或子任务 prompt。

## 错误处理

- 无关联：正常缺省，不报 404/500；
- 单个 run 时间非法：省略该摘要，不影响整个 transcript；
- store 查询失败：沿用 context-items 整体请求失败语义，不返回部分伪造数据；
- 重复 parent key：严格 fail-open，冲突 item 省略摘要、其他 item 正常、接口成功、每请求每 key 一次固定 error 诊断；
- 测试、预发布或灰度出现该诊断时阻断发布/放量，但运行时不得改成 fail-close；
- Web 收到不合法字段：共享 schema 正常应拦截；Web 仍防御性不显示，不回退 parent item 时间。

## 授权改动边界

允许修改：

```text
packages/shared/src/contracts/agent.ts
apps/api/src/modules/agent/agent.store.ts
apps/api/src/modules/agent/query/context-query-ports.ts
apps/api/src/modules/agent/query/sqlite-query-stores.ts
apps/api/src/modules/agent/query/context-query-application.ts
相关 shared/API 测试
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
可选的新 Web 纯 helper/test
apps/web/src/shared/i18n/locales/zh-CN.ts
apps/web/src/shared/i18n/locales/en-US.ts
apps/web/package.json（仅当新增测试需纳入当前显式 test 列表）
```

原则上不得修改：

```text
agent_run schema/migrations
subtask start/application 生产逻辑
run lifecycle 写路径
agent-worker runner/API client
context item 写回协议
child session run-state endpoint
卡片打开 child session 行为
```

若实施需要越界，必须先更新设计并重新审查。
