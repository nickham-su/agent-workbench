# 实施计划与验证

## 实施原则

- 按本文件顺序实施。每一步都应保持可编译、可测试，并避免提前实现非目标功能。
- 不新增 migration 框架、invocation/reservation 表、session depth 字段、worker 结构化错误协议或 depth UI。
- 所有运行时强制规则都必须由 API 服务端执行；prompt 工具过滤不能替代服务端校验。
- 改动完成后，以本文件的验收标准和代码审查清单为准，不以手工观察代替断言。

## 开发任务拆分

| 阶段 | 目标 | 主要文件 |
|---|---|---|
| A | 扩展全局配置契约、服务和设置页。 | `packages/shared/src/contracts/settings.ts`、settings service/routes、Web runtime panel、i18n。 |
| B | 扩展 `agent_run` schema/store，并增加 lineage 查询与轻量唯一索引。 | `apps/api/src/infra/db/schema.ts`、`agent.store.ts`。 |
| C | 让所有 run 创建入口写入或继承 depth。 | `agent.service.ts`。 |
| D | 在 subtask start 增加幂等和硬限制。 | `agent.service.ts`、`agent.routes.ts`。 |
| E | 按 run depth 替换 `session.kind` 工具过滤。 | `agent.service.ts`。 |
| F | 补齐自动化测试、执行检查并按验收标准审查。 | Web/API/worker 测试。 |

## 详细实施步骤

### A. Runtime setting

#### A1. 共享契约

在 `AgentRuntimeSettingsSchema` 添加：

```ts
maxSubtaskDepth: Type.Integer({ minimum: 1, maximum: 5 })
```

在 `UpdateAgentRuntimeSettingsRequestSchema` 添加等价的可选字段。不要接受 `0`，不要把 `0` 映射为关闭或 `1`。

#### A2. 后端设置服务

在 `settings.service.ts`：

- 将 `maxSubtaskDepth` 加入存储类型、读取返回对象、写入 JSON、日志和 API 返回对象。
- 新增存储读取规范化函数：字段缺失、非整数、小于 `1` 或大于 `5` 时返回 `1`。
- 新增更新规范化函数：仅接受整数 `1..5`；其它输入必须抛 `HttpError(400, "maxSubtaskDepth must be an integer between 1 and 5", "AGENT_MAX_SUBTASK_DEPTH_INVALID")`，且不得调用 `setSettingJson()`。
- 保持存储 key `agent_runtime_v1`；不得新建配置表或新 endpoint。

#### A3. 前端

在 `AgentRuntimeSettingsPanel.vue`：

- 新增 `ref<number>(1)`；
- 新增 `a-input-number`，`min=1`、`max=5`、`step=1`、`precision=0`；
- 在 `mapFromSettings()` 回填字段；
- 在 `save()` 的 PUT payload 写入整数值；
- 保持原有 `getAgentRuntimeSettings()` / `updateAgentRuntimeSettings()` API client，不新增独立 Web API。

补充中英文 i18n。说明必须覆盖：root run 是 0 层、范围 1–5、只限制纵向嵌套、不会限制同层数量/并发/token。不要添加当前深度展示。

### B. `agent_run` schema 与 store

#### B1. SQLite schema

在新库 `agent_run` 建表 DDL 和 `initSchema()` 的升级段同时添加：

```sql
subtask_depth integer,
parent_run_id text,
parent_tool_item_id integer
```

字段必须 nullable。不要默认 `0`，不要回填历史数据。

在 schema 的 index 创建区添加：

```sql
create unique index if not exists idx_agent_run_parent_tool_unique
on agent_run(parent_run_id, parent_tool_item_id)
where parent_tool_item_id is not null;
```

可添加 `parent_run_id` 普通索引以服务查询；不应新增 migration manifest 或版本表。

#### B2. Store

扩展 `AgentRunRecord`、`createRunRecord()` 参数和 INSERT、`getRunRecord()` SELECT/映射：

```ts
subtaskDepth: number | null;
parentRunId: string | null;
parentToolItemId: number | null;
```

新增明确命名的查询 helper，例如：

```ts
findSubtaskRunByParentTool(db, {
  parentRunId,
  parentToolItemId
})
```

它必须只返回 `parent_tool_item_id` 非空且精确匹配的一条 child run；不能用 session fork 字段代替。

### C. 普通 run 的深度来源

#### C1. 独立 primary session

`sendMessage()` 的 run 创建逻辑必须先解析 session 的 depth 来源：

- session 没有 `forked_from_session_id` 和 `forked_from_item_id`，且无该 session 既有 run：写 `0` 和两个 `NULL` parent 字段。
- session 已存在 run：读取按最新创建顺序的已有 run；其 `subtaskDepth` 已知时，新 run 继承该值；其值为 `NULL` 时新 run 也写 `NULL`。
- session 是普通 UI fork 且是首次 run：按 C2 处理；来源 run 存在时写 `parentRunId=sourceRun.runId`，`parentToolItemId=NULL`。

不要依据 `session.kind` 给 user run 计算深度。用户侧 subtask session在更早的只读校验处被拒绝。

#### C2. 普通 UI fork 首 run

仅在 fork session 的首个 run：

1. 读取该 session 的 `forkedFromSessionId` 和 `forkedFromItemId`；任一为空则写 `NULL`。
2. 在**源 session**读取 `forkedFromItemId` 的原始 context item。
3. 读取原始 item 的 `runId`；为空时写 `NULL`。
4. 读取该 run；run 不存在或 `subtaskDepth` 为 `NULL` 时写 `NULL`。
5. 否则写来源 `subtaskDepth`。

该普通 fork run 在来源 run 存在时写 `parentRunId=sourceRun.runId`；`parentToolItemId` 始终写 `NULL`。来源 run 不存在时两个字段均写 `NULL`。不把普通 fork 记录为 subtask invocation。

必须新增或复用一个查询“按 session 获取最新 run”的 store helper，并规定顺序为 `created_at desc, run_id desc`；避免用复制 context item 的 runId 推断。

#### C3. Compaction run

`compactSession()` 的 `createRunRecord()` 调用也必须写入三项字段：

- 用 C1 的“按 session 获取最近有效 run” helper 获取 depth。
- 最近有效 run 的 `subtaskDepth` 为已知 N：compaction run 写 `subtaskDepth=N`。
- 最近有效 run 不存在或为 unknown：compaction run 写 `subtaskDepth=NULL`。
- 不论上述任一情况，`parentRunId=NULL`、`parentToolItemId=NULL`。

compaction 不是 subtask invocation，不能增加 depth，不能从 trigger item 或 session kind 推导 depth，也不得被 partial unique index 约束。

### D. Subtask start

改动 `startSubtaskRunFromWorker()`，并保持 `resolveSubtaskParentContext()` 的锚点校验在前。

固定顺序：

```text
校验 parent session/run/tool anchor
  -> 查询既有 child run
  -> 已存在则直接返回它
  -> 读取最新 runtime setting
  -> parent depth unknown 则 409
  -> 计算 childDepth 并检查上限
  -> 解析 new/fork/existing child session
  -> 在既有 prompt/run/run-state 事务中创建 child run
  -> unique 冲突则查询既有 child run 并返回
```

实现要求：

- 查询既有 child 必须发生在读取配置和深度校验之前；已存在 child 的重试不受配置下调影响。
- `parentRun.subtaskDepth === null`：抛 `HttpError(409, "subtask depth cannot be determined for current parent run", "AGENT_SUBTASK_DEPTH_UNKNOWN")`，不创建 session/run。
- `childDepth > runtime.maxSubtaskDepth`：抛 `HttpError(409, "subtask depth exceeds configured maximum", "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED")`，不创建 session/run。
- `new`、`fork`、`existing` 三种 mode 创建 run 时均传入同一组：
  ```ts
  parentRunId: parentRun.runId,
  parentToolItemId: anchor.id,
  subtaskDepth: childDepth
  ```
- `existing` 的目标 session 历史 run、来源、kind 之外的 lineage 均不得参与当前 childDepth 计算。
- `fork` 的 prefork summary / 无 boundary / context fork 路径都适用同一 run 字段。
- unique index 冲突后只允许重新查询并返回已存在 child；不可再创建另一 session/run，也不可引入 reservation 恢复流程。
- child session 已创建但 child run 尚未成功创建而进程退出时，允许留下 orphan session；下次请求由于没有 child run，按最新配置重新进入当前流程。这是接受的非恢复边界。

`/api/internal/agent/subtask/start` 的请求参数保持不变。成功 response 在现有 `sessionId/runId/workspacePath/agentName` 外增加 `reused: boolean`：新建 child run 为 `false`，查询或 unique 冲突后复用已有 child run 为 `true`。这是避免 worker 重复执行已有 run 的最小协调字段，不代表新增 invocation 状态机。

当 `reused=true` 时，worker 不调用 `processNestedRun()`：terminal run 直接复用 status/result；仍为 `running` 的 run 轮询既有 `/subtask/status`，直到 terminal 后再读取 result，并按 completed/failed/cancelled 的既有分支处理。轮询只服务于同一 parent run/tool item 的轻量幂等复用；不得创建新 child、接管 child、写 reservation 或恢复状态。轮询响应父 `AbortSignal`，并使用与 nested run 允许执行时长相同的明确等待上限；超时后以现有“subtask did not reach terminal status”错误结束本次等待，不修改 child run。

### E. 工具可见性

`getPromptContextForRun()` 必须取得当前 `agent_run` 和当前 runtime setting。把现有：

```ts
if (session.kind === "subtask") {
  remove("subtask");
}
```

替换为：

```ts
const canExposeSubtask =
  run.subtaskDepth !== null &&
  run.subtaskDepth < runtime.maxSubtaskDepth;

if (!canExposeSubtask) remove("subtask");
```

要求：

- 该规则不依赖 `session.kind`；已知 depth 的 subtask session 能在未达上限时获得工具。
- unknown run 和达到上限的 run 不包含 `subtask`。
- 若 profile 本来没有启用 `subtask`，不添加它。
- `subtaskDescription` 必须根据过滤后的列表生成。
- static prompt cache 保持现状；配置变动不修改已启动 run 的 tools。

### F. Worker 与用户侧只读边界

不向 `parseSubtaskArgs()`、`startSubtaskRun()` 请求或 worker nested run 参数增加 depth。depth 只由 API 从 parent run 计算。

保持 worker 现有流程和文本错误传播：HTTP 409 会经 `AgentApiClient.request()` 变为包含 code 的 Error 文本，并由 runner 写入现有 tool failure output。不要新增结构化错误类型、`subtaskError` result 字段或专用 UI 组件。

`sendMessage()` 对 `kind="subtask"` 的 `AGENT_SUBTASK_READONLY` 校验必须保留。嵌套仅来自 worker 内部调用，不能通过开放用户消息实现。

## 测试矩阵

### Settings

| 用例 | 断言 |
|---|---|
| 缺失 stored 字段 | GET 返回 `maxSubtaskDepth=1`。 |
| PUT `1`、`5` | 成功持久化并回读相同值。 |
| PUT `0`、`6`、负数、小数、字符串 | HTTP 400，code=`AGENT_MAX_SUBTASK_DEPTH_INVALID`；持久化值不改变。 |
| Web 表单 | 输入限制为 1–5，加载、保存 payload 和回填包含字段。 |

### 深度与工具

| 用例 | 前置 | 断言 |
|---|---|---|
| root 首 run | 新独立 primary session | run depth 为 0，parent 字段为空。 |
| 同会话继续 | 最近 run depth=2 | 新 run depth=2，parent 字段为空。 |
| compaction，已知深度 | 最近有效 run depth=2 | compaction run depth=2，两个 parent 字段为空。 |
| compaction，unknown | 最近有效 run depth=NULL 或不存在 | compaction run depth=NULL，两个 parent 字段为空。 |
| subtask 第一层 | parent depth=0，max=1 | child depth=1，parent 字段精确匹配。 |
| 已达上限 | parent depth=1，max=1 | 409 max-depth；无 child session/run。 |
| 更深嵌套 | parent depth=1，max=2 | child depth=2。 |
| unknown | parent depth=NULL | 409 unknown；无 child session/run。 |
| 可见性 | depth=0/max=1 | tools 含 subtask（若 profile 启用）。 |
| 不可见性 | depth=1/max=1 或 depth=NULL | tools 不含 subtask。 |

### mode、fork 与幂等

| 用例 | 断言 |
|---|---|
| `new` | child run 继承 parent+1。 |
| `fork` + prefork summary | child run 继承 parent+1。 |
| `fork` + 无 boundary | child run 继承 parent+1。 |
| `fork` + context clone | child run 继承 parent+1。 |
| `existing` | 复用 session但新 run 的深度按当前 parent 计算。 |
| 普通 UI fork，源 item 有已知 run | 首 run 继承来源 depth，`parentRunId` 为来源 run，`parentToolItemId` 为空。 |
| 普通 UI fork，源 item runId 为 NULL/不存在/unknown | 首 run depth=NULL，后续不暴露 subtask。 |
| 新 child | start response `reused=false`；worker 调用一次 `processNestedRun()`。 |
| 同一 parent tool item 命中 running child | response `reused=true`；worker 不重复执行该 child，轮询 status 至 terminal。 |
| 同一 parent tool item 命中 completed child | response `reused=true`；worker 不执行 child，直接复用 result。 |
| 同一 parent tool item 命中 failed/cancelled child | response `reused=true`；worker 不执行 child，复用 terminal result 并走现有失败分支。 |
| partial unique index 冲突 | API 复查已有 child 并返回 `reused=true`；run 总数为 1。 |
| 配置下调后的重复请求 | 已存在 child 仍直接复用。 |
| 配置下调后的新 tool item | 按新上限校验并可被拒绝。 |

### 保留回归

- 用户向 `kind="subtask"` session 发送消息仍获得 `AGENT_SUBTASK_READONLY`。
- worker 的 new/fork/existing 正常成功路径仍进入 `processNestedRun()` 并能读取结果。
- 现有 prefork summary 失败时仍按现有逻辑回退；本设计不改变它的触发或摘要策略。

## 可判定验收标准

以下全部成立才可验收：

### 配置和 UI

- GET `/api/settings/agent/runtime` 必然包含 `maxSubtaskDepth`，缺失存储值时为 `1`。
- PUT 只接受整数 `1..5`；`0` 不是合法兼容值。
- `/settings/agent/runtime` 有唯一配置输入和准确说明；页面不展示任何 run/session depth。

### 数据和迁移

- 新数据库的 `agent_run` 有三列和 partial unique index。
- 已存在数据库启动后通过 `ensureColumn()` 获得三列；无需新 migration 框架。
- 旧 run 不被写为 `0`；保留 `NULL`。
- 所有 `createRunRecord()` 调用，包括 `sendMessage()`、`compactSession()`、`startSubtaskRunFromWorker()` 和测试 fixture，都显式提供三项 lineage/depth 参数，或通过统一入口以确定规则补齐。

### 运行时行为

- 只有深度已知且小于配置的 run 能看到 `subtask`；API 对每个 start 重新强校验。
- `new/fork/existing` 的 child run 均按照 parent run 计算，不读取 child session 历史作为依据。
- unknown/超限返回规定的 409 code，且校验失败时没有新 child session 或 child run。
- 相同 parent run/tool item 最终只存在一个 child run；重试返回同一 run。
- start 成功 response 的 `reused` 精确区分新建和复用：新 child 为 `false`，running/completed/failed/cancelled existing child 均为 `true`。
- partial unique index 冲突后 API 必须复查已有 child 并返回 `reused=true`。
- reused running child 时 worker 不重复执行它，而是等待 status 至 terminal；reused terminal child 直接复用已有 result。
- 配置改动不热更新已开始 run 的工具集；已存在 child run 可被重试复用。
- subtask session 仍只读。

### 质量

- 本文测试矩阵全部实现为自动化测试并通过。
- 相关 TypeScript 类型检查、目标应用测试和 lint 按项目现有脚本通过。
- 未引入本设计明确排除的 reservation 表、session depth UI、0 值语义或历史回填。

## 代码审查清单

### 数据与类型

- [ ] schema 新库 DDL 与 `ensureColumn()` 同步添加三列。
- [ ] 仅为 `parent_tool_item_id IS NOT NULL` 创建唯一索引，普通 run 不触发唯一约束。
- [ ] 所有 store SELECT/INSERT、`AgentRunRecord` 和调用点字段一致。
- [ ] `compactSession()` 按 session 最近有效 run 继承 depth，且两个 parent 字段始终为 `NULL`。
- [ ] `NULL` 被当作 unknown，不被 `|| 0`、`?? 0` 或默认值转换为 root。

### 规则与顺序

- [ ] `startSubtaskRunFromWorker()` 先验证 parent anchor，再查已有 child，再读取配置/校验深度。
- [ ] 两个拒绝分支发生在创建/选择 child session 之前。
- [ ] unique 冲突只复查并复用 child run；没有 second-session 或 reservation 逻辑。
- [ ] new/fork/existing 与所有 fork 子路径写入相同 child lineage。
- [ ] 普通 fork 只读取源 session 的原始 item，不读取 child 复制 item；来源 run 存在时仅写 `parentRunId`，`parentToolItemId` 必为 `NULL`。
- [ ] start response 的 `reused` 在新建时为 `false`，查询/unique 冲突复用时为 `true`。
- [ ] reused running child 只轮询 status 至 terminal；不再次 `processNestedRun()`，不接管、不创建 reservation。

### Runtime 与产品边界

- [ ] 工具过滤不再以 `session.kind === "subtask"` 为条件。
- [ ] API 硬校验保留，且 worker 不传可信 depth。
- [ ] 已启动 run 不因设置事件或 cache 失效被热更新。
- [ ] `sendMessage()` 的 subtask read-only 分支未被放开。
- [ ] 前端仅新增 runtime 配置，不展示当前 depth。

### 非目标守卫

- [ ] 没有新增 `agent_session` 字段、invocation/reservation 表、lease/stale/recovery 状态机。
- [ ] 没有历史 depth 回填、孤儿自动修复或多进程恢复方案。
- [ ] 没有把 `0` 接受为合法 runtime setting。
- [ ] 非法设置统一返回 HTTP 400 和 `AGENT_MAX_SUBTASK_DEPTH_INVALID`，并且未写入 settings JSON。

## 风险、排查和回滚

### 接受的风险

| 风险 | 确定行为 | 排查方式 |
|---|---|---|
| child session 创建后、child run 创建前进程退出 | 可能留下无 run 的 subtask session；不自动修复。 | 查询该 session 是否没有 `agent_run`；用户可以忽略或新建会话。 |
| 历史 run 或不可追溯 fork | depth 为 `NULL`，无法继续 subtask。 | 查询 run 的 `subtask_depth`；新建独立 primary session 获得 depth 0。 |
| 同层大量 sibling | 仍可能造成成本增长。 | 本期不由本配置处理；需要时单独设计 fan-out/预算限制。 |
| 已启动 run 配置过期 | 工具列表不变，但 start API 对新 child 仍按最新配置拒绝或允许。 | 核对 start 请求时间的 setting 与 parent depth。 |

### 最小回滚

若上线后需关闭此功能变更而不删除历史数据：

1. 将工具过滤临时恢复为当前 `session.kind === "subtask"` 时隐藏 `subtask` 的旧规则。
2. 保留 `agent_run` 新列和索引，不删除、不回填。
3. 保留 runtime setting 字段；它在旧过滤规则下不再影响工具可见性。
4. 不执行 destructive schema rollback。

该回滚会暂停嵌套 subtask，但保留已有会话和 run 数据可读。
