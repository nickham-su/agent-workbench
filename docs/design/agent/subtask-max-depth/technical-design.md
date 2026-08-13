# 技术设计

## 总体结构

```text
Settings (`agent_runtime_v1`)
  -> 新 run 的 prompt 工具可见性
  -> `/api/internal/agent/subtask/start` 的服务端硬校验

agent_run
  -> 已知/未知深度
  -> subtask parent lineage
  -> 同一 tool item 的轻量幂等
```

深度的唯一事实来源是 `agent_run.subtask_depth`。session 的 `kind` 不参与深度判断；`forked_from_session_id` 和 `forked_from_item_id` 仅在普通 UI fork 的首个 run 创建时定位来源 run，不能递归推导深度，也不能用于 subtask child 深度计算。

## 配置存储、契约和前端

### 共享契约

在 `packages/shared/src/contracts/settings.ts` 中同步扩展：

```ts
maxSubtaskDepth: Type.Integer({ minimum: 1, maximum: 5 })
```

- `AgentRuntimeSettingsSchema`：字段必填，GET 总是返回合法值。
- `UpdateAgentRuntimeSettingsRequestSchema`：字段可选；出现时必须是整数 `1..5`。
- 不定义 `0` 的含义；schema 必须拒绝 `0`。

### 后端 settings service

在 `apps/api/src/modules/settings/settings.service.ts`：

- `AgentRuntimeSettingsStored` 增加可选 `maxSubtaskDepth`。
- 新增常量 `DEFAULT_MAX_SUBTASK_DEPTH = 1`。
- 新增两类规范化函数，并沿用现有 runtime 字段模式：
  - `normalizeMaxSubtaskDepthFromStored(raw)`：字段缺失、非整数、越界时返回 `1`。此函数只处理旧 JSON 或被破坏的存储值。
  - `normalizeMaxSubtaskDepthForUpdate(raw)`：仅接受整数 `1..5`；否则抛出 `HttpError(400, "maxSubtaskDepth must be an integer between 1 and 5", "AGENT_MAX_SUBTASK_DEPTH_INVALID")`。
- `getAgentRuntimeSettingsStored()`、`getAgentRuntimeSettings()`、`updateAgentRuntimeSettings()` 的读取、持久化、日志和返回对象都必须包含该字段。
- 存储 key 继续为 `agent_runtime_v1`，不增加 settings 表、key 或 migration。

非法更新的固定契约为 HTTP `400`、code `AGENT_MAX_SUBTASK_DEPTH_INVALID`。更新函数必须在任何 `setSettingJson()` 调用之前抛错，因此请求值不得持久化，原有配置值保持不变。

### API 和前端

已有 `GET/PUT /api/settings/agent/runtime` 保持不变，只通过共享 schema 扩展字段。

`AgentRuntimeSettingsPanel.vue` 必须：

- 建立本地 `ref<number>(1)`；
- 在 `mapFromSettings()` 中读取并夹取为 `1..5`；
- 在 `save()` 中提交整数 `1..5`；
- 使用 `a-input-number`，`min=1`、`max=5`、`step=1`、`precision=0`；
- 中英文 locale 各增加标签和帮助文案；
- 不显示当前 run/session 深度、历史 unknown 状态或调用链。

帮助文案的产品含义必须与以下文本等价：

> 限制 subtask 调用链的最大嵌套层级。独立主会话的首个 run 为第 0 层。设为 1 时，仅允许主 run 创建第一层 subtask。仅限制嵌套深度，不限制同层数量、并发数或 token 消耗。

## 数据实体和升级

### `agent_run` 新列

在 `apps/api/src/infra/db/schema.ts` 的新库 `create table agent_run` DDL 和 `initSchema()` 升级路径中增加：

| 列 | SQLite 类型 | 可空性 | 写入规则 |
|---|---|---|---|
| `subtask_depth` | `integer` | 可空 | `0` 或非负整数为已知深度；`NULL` 是 unknown。 |
| `parent_run_id` | `text` | 可空 | child run 的 parent run；普通 UI fork 首 run 也可记录来源 run。 |
| `parent_tool_item_id` | `integer` | 可空 | 仅 subtask invocation 写触发 tool item ID；普通 fork 和普通继续均为 `NULL`。 |

必须使用现有 `ensureColumn()`：

```ts
ensureColumn(db, { table: "agent_run", column: "subtask_depth", ddl: "subtask_depth integer" });
ensureColumn(db, { table: "agent_run", column: "parent_run_id", ddl: "parent_run_id text" });
ensureColumn(db, { table: "agent_run", column: "parent_tool_item_id", ddl: "parent_tool_item_id integer" });
```

不新增 migration runner、版本表、历史回填任务或外键约束。

### 轻量幂等索引

在 schema 初始化已有 index 区域创建：

```sql
create unique index if not exists idx_agent_run_parent_tool_unique
on agent_run(parent_run_id, parent_tool_item_id)
where parent_tool_item_id is not null;
```

索引语义：一个 subtask tool item 至多创建一个 child run。它不作用于 root run、普通继续或普通 UI fork，因为这些记录的 `parent_tool_item_id` 必须为 `NULL`。

建议增加普通索引以支持父链查询和排查：

```sql
create index if not exists idx_agent_run_parent_run_id
on agent_run(parent_run_id);
```

### Store 扩展

在 `apps/api/src/modules/agent/agent.store.ts`：

- `AgentRunRecord` 增加：
  ```ts
  subtaskDepth: number | null;
  parentRunId: string | null;
  parentToolItemId: number | null;
  ```
- `createRunRecord()` 参数、INSERT 列和绑定值均增加三个字段；调用方必须显式传入，不得由 SQL 默认猜测。
- `getRunRecord()` 的 SELECT 和映射包含三个字段。数值规范化规则：仅非负安全整数可作为 depth；其他数据库异常值按 `null` 处理。
- 新增 `findSubtaskRunByParentTool(db, { parentRunId, parentToolItemId })`，按两个字段查询 child run，返回完整 `AgentRunRecord | null`。
- 新增一个“取 session 最近 run”的 store helper，返回按 `created_at DESC, run_id DESC` 排序的最新 run。对空 session 返回 `null`。服务层不得通过复制 context item 推测同会话继承深度。

## 所有 run 的 lineage 写入规则

### 独立 primary session 和普通继续

在 `sendMessage()` 创建 run 的事务中，按以下顺序确定 lineage：

| 条件 | `subtaskDepth` | `parentRunId` | `parentToolItemId` |
|---|---:|---|---|
| session 没有历史 run，且没有普通 fork 来源 | `0` | `NULL` | `NULL` |
| session 已有最近 run，且最近 run depth 为已知 N | `N` | `NULL` | `NULL` |
| session 已有最近 run，但 depth 为 `NULL` | `NULL` | `NULL` | `NULL` |
| session 没有历史 run、但它是普通 UI fork 且来源 run depth 为已知 N | `N` | 来源 run ID | `NULL` |
| session 没有历史 run、普通 UI fork 来源无法确认 | `NULL` | 可确认来源 run ID 时写该 ID；否则 `NULL` | `NULL` |

普通继续的 parent 字段保持 `NULL`，因为它不是一次 subtask 或 fork invocation。普通 UI fork 的首 run 在来源 run 存在时必须写入 `parentRunId`；其 `parentToolItemId` 必须为 `NULL`，因此不触发 subtask unique index。

### 普通 UI fork 的来源解析

仅在 fork session 的**首个 run**解析来源，算法固定为：

```text
session.forkedFromSessionId 和 session.forkedFromItemId 是否都存在？
  否 -> 不存在 fork 来源，按独立会话/最近 run 规则。
  是 -> 从 forkedFromSessionId 的原始 context item 中按 forkedFromItemId 查询。
       原始 item.runId 是否存在？
         否 -> depth = NULL。
         是 -> 查询该 run。
               run 存在且 subtaskDepth 已知 -> 继承该 depth，parentRunId = sourceRun.id。
               run 不存在或 depth = NULL -> depth = NULL；若 run 存在，可保留其 ID 为 parentRunId。
```

`forkSession()` 复制 item 时会把复制项的 `runId` 清空。禁止从 fork 后 child session 的复制 item、标题或 session kind 推断来源深度。

### Compaction run

`AgentService.compactSession()` 也会调用 `createRunRecord()`。compaction run 不是 subtask invocation，也不增加深度；其 lineage 固定如下：

| 条件 | `subtaskDepth` | `parentRunId` | `parentToolItemId` |
|---|---:|---|---|
| session 最近有效 run 的 depth 为已知 N | `N` | `NULL` | `NULL` |
| session 没有可用 run，或最近有效 run 的 depth 为 `NULL` | `NULL` | `NULL` | `NULL` |

“最近有效 run”使用与普通继续相同的 store helper 和确定排序：`created_at DESC, run_id DESC`。compaction 仅整理单一 session 的上下文，不是 parent-to-child 委派，不得使用 `triggerItemId`、当前 head item 或 session kind 推导 depth，也不得写 parent 字段。

这保证：

- 已知 depth 的会话压缩后，后续普通 run 仍继承原来的 depth；
- unknown 历史会话压缩后仍为 unknown，不能因压缩获得 subtask 能力；
- compaction run 不进入 `(parent_run_id, parent_tool_item_id)` partial unique index 的作用范围。

### Subtask child run

`startSubtaskRunFromWorker()` 创建 child run 时必须固定写入：

```ts
subtaskDepth: parentRun.subtaskDepth + 1,
parentRunId: parentRun.runId,
parentToolItemId: parentToolItemId
```

这条规则适用于 `new`、`fork` 和 `existing`，以及 fork 的 prefork summary、无 boundary、context fork 三条内部路径。

## `/subtask/start` 算法和异常分支

实现入口是 `AgentService.startSubtaskRunFromWorker()`。必须按如下顺序执行，顺序本身是行为契约：

```text
1. resolveSubtaskParentContext()
2. findSubtaskRunByParentTool(parentRunId, parentToolItemId)
3. 若已有 child run：返回其 session/run 位置，不再读取配置或重算深度
4. 读取 getAgentRuntimeSettings() 的最新 maxSubtaskDepth
5. 判断 parentRun.subtaskDepth
6. 计算 childDepth 并检查上限
7. 校验参数、解析 execution profile，按 new/fork/existing 选择或创建 child session
8. 使用现有 prompt/run/run-state 事务写 child prompt、child run 和 running state
9. child run INSERT 若遇 partial unique index 约束：重新查询既有 child run 并返回
10. 返回 child session/run
```

### 确定错误行为

| 条件 | HTTP/code | 数据库副作用 |
|---|---|---|
| parent session/run/tool anchor 无效 | 维持现有 400/404 和现有 code | 不创建 child。 |
| 已存在相同 parent run + tool item 的 child run | 200，返回既有 run | 不读取新配置、不创建 child。 |
| `parentRun.subtaskDepth === null` | `409 AGENT_SUBTASK_DEPTH_UNKNOWN` | 不创建 child session/run。 |
| `childDepth > maxSubtaskDepth` | `409 AGENT_SUBTASK_MAX_DEPTH_EXCEEDED` | 不创建 child session/run。 |
| `existing` session 缺失、跨 workspace、非 subtask 或运行中 | 保持现有 400/404/409 | 不创建新 child run。 |
| `new/fork` 已创建 child session，随后 run 创建事务失败 | 传播原错误；可能留空 child session | 不自动修复，不创建 reservation。 |
| partial unique index 冲突 | 重新查询并返回既有 child run | 不创建第二 child run。 |
| unique 冲突后仍查询不到 child run | 传播原始数据库错误 | 不做循环重试或补偿创建。 |

在第 5、6 步，必须明确判断 `null`，不能写 `if (!parentRun.subtaskDepth)`，否则 depth `0` 会被错误当作 unknown。

### 伪代码

```ts
const { parentRun } = resolveSubtaskParentContext(input);
const existing = findSubtaskRunByParentTool(db, {
  parentRunId: input.parentRunId,
  parentToolItemId: input.parentToolItemId
});
if (existing) return toStartResponse(existing);

const { maxSubtaskDepth } = getAgentRuntimeSettings(ctx);
if (parentRun.subtaskDepth === null) {
  throw new HttpError(409, "subtask depth cannot be determined", "AGENT_SUBTASK_DEPTH_UNKNOWN");
}
const childDepth = parentRun.subtaskDepth + 1;
if (childDepth > maxSubtaskDepth) {
  throw new HttpError(409, "subtask depth exceeds configured maximum", "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
}

const childSession = await resolveNewForkOrExistingSession(input);
try {
  return createChildRunInExistingTransaction({ childSession, parentRun, childDepth, input });
} catch (error) {
  if (!isParentToolUniqueConflict(error)) throw error;
  const concurrent = findSubtaskRunByParentTool(db, { ... });
  if (concurrent) return toStartResponse(concurrent);
  throw error;
}
```

`toStartResponse(existing)` 必须从 existing run 的 `sessionId` 读取 session，并重新解析其 workspace path 和 agent display name，保持当前 start API 返回 schema。

## Worker 行为与简单复用边界

第一版继续使用现有 start 响应 schema与文本错误传播：不引入 `ApiRequestError`、`subtaskError` JSON 或专用 UI 组件。`HttpError` 经 API 返回 `{ message, code }`，worker 的 `apiClient.request()` 会将其保留在 Error 文本中。

为避免对已存在 run 再次调用 `processNestedRun()`，start 响应需要增加一个内部字段：

```ts
reused: boolean
```

- 新创建 child run：`reused: false`；worker 按现有流程调用 `processNestedRun()`。
- 找到既有 terminal child run：`reused: true`；worker 不调用 `processNestedRun()`，直接读取 status/result 并复用结果或失败文本。
- 找到既有 `running` child run：`reused: true`；worker 不调用 `processNestedRun()`，避免同一 run 被重复执行。worker 轮询既有 `/subtask/status`，直到 child 进入 terminal，再读取 result 并按 completed/failed/cancelled 的既有分支处理。

轮询只适用于同一 `(parent_run_id, parent_tool_item_id)` 的 `reused=true` 轻量幂等复用，不创建新 run、不修改 child run state、不接管 child，也不增加 reservation、lease、stale takeover 或恢复状态机。轮询必须响应父 `AbortSignal`：父任务取消时立即停止等待并走现有取消路径。

轮询间隔和等待上限必须是明确常量。等待上限与当前 nested run 的允许执行时长一致；若在该时限内 child 仍未 terminal，则以明确的 reused-child wait timeout 错误结束当前 parent tool 等待。child 可能仍在运行，且不会被取消、修改、接管或重复执行；也不创建新 child 或重试 start。

`apps/agent-worker/src/runtime/tools/providers/builtin.ts` 仅需按 `reused` 调整执行分支；请求参数不传 depth，depth 始终由 API 计算。

## Prompt 工具可见性

`getPromptContextForRun()` 当前按 `session.kind === "subtask"` 过滤 `subtask`。该条件必须删除，替换为当前 run + 当前 runtime setting：

```ts
const settings = getAgentRuntimeSettings(this.ctx);
const canUseSubtask =
  run.subtaskDepth !== null &&
  run.subtaskDepth < settings.maxSubtaskDepth;

if (!canUseSubtask) remove("subtask");
```

实现前提：`getPromptContextForRun()` 已以 `params.runId` 查询/校验 run；实现必须在构造 tools 前拿到该 run，并使用其 `subtaskDepth`，不能使用 session kind 或 session 最近 run 代替。

| 当前 run depth | 配置 | prompt 是否含 `subtask` |
|---:|---:|---|
| `NULL` | 任意 | 否 |
| `0` | `1..5` | 是 |
| `N < max` | `1..5` | 是 |
| `N = max` | `1..5` | 否 |

工具可见性在 run 的 prompt static cache 创建时确定。设置变更不清除已经开始 run 的 cache，也不热更新其 tools；新启动 run 读取当时最新设置。后端 `/subtask/start` 仍在每个尚无 child run 的调用中读取最新设置并强制校验。

## 历史兼容、迁移和回滚

### 历史数据

- 只新增 nullable 列，不对历史 `agent_run` 回填。
- 迁移前已存在的 run 三个字段均为 `NULL`，定义为 unknown。
- unknown run 可继续完成普通对话；同会话后续 run 继承 `NULL`。
- unknown run 的 prompt 不含 `subtask`，若 worker 或旧代码仍调用 start，后端返回 `AGENT_SUBTASK_DEPTH_UNKNOWN`。
- 为获得完整嵌套能力，用户创建新的独立 primary session，其首 run 从 `0` 开始。

### 回滚

功能代码回滚后，新增 SQLite 列和索引保留；旧代码忽略它们，通常可继续运行。配置 JSON 中的 `maxSubtaskDepth` 也保留，旧代码忽略未知 key。禁止通过删除列或重建历史数据来回滚。

若上线后观察到异常：

1. 查询 parent run 的 `subtask_depth`、`parent_run_id`、`parent_tool_item_id`；
2. 查询同一 `(parent_run_id, parent_tool_item_id)` 是否已有 child run；
3. 检查 runtime settings 的 `maxSubtaskDepth`；
4. 检查 worker 错误文本是否含两个深度 error code；
5. 对历史 unknown 会话，使用新 primary session 验证，而不是回填历史链。
