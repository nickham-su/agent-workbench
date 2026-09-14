# 技术设计

## 总体数据流

```text
用户点击已持久化 Session Tab 的设置按钮
  -> 弹窗回填当前 session.title
  -> 前端规范化与校验
  -> PUT /api/agent/sessions/:sessionId/title
  -> SessionInteractionApplication 校验 Session 与 Workspace
  -> Store 原子写 title + title_manually_set = 1
  -> 不更新 updated_at
  -> 查询并返回 AgentSessionRecord
  -> Web 原位替换本地 Session
  -> 标记该 Session 的标题 mutation revision
  -> 较早发起的列表响应不得覆盖新 title
```

```text
首消息或 completed todolist 产生自动标题
  -> 既有格式化规则
  -> updateAutoAgentSessionTitle(...)
  -> UPDATE ... WHERE title_manually_set = 0
  -> manual 时 changes = 0，业务正常继续
  -> auto 时更新 title，并保持既有 updated_at 行为
```

## 数据模型

### 表字段

在 `agent_session` 新增内部列：

```sql
title_manually_set integer not null default 0
  check (title_manually_set in (0, 1))
```

完整语义：

| 值 | 含义 |
|---:|---|
| `0` | 自动标题更新仍被允许 |
| `1` | 用户已手动接管，所有自动标题更新永久禁止 |

字段不得为空，不得出现其他整数或文本值。

当前表定义位置：

- `apps/api/src/infra/db/schema.ts:94-104`

旧库升级沿用 `ensureColumn()` 机制，现有示例位于：

- `apps/api/src/infra/db/schema.ts:218-230`

建议同时修改：

- `create table if not exists agent_session` 中的新建库定义；
- `ensureColumn(db, ...)` 的旧库升级路径。

SQLite `ALTER TABLE ... ADD COLUMN` 对该 `CHECK` 的支持必须由迁移测试验证。若项目实际支持的 SQLite 版本不能安全执行该 DDL，应停止实施并修订迁移方案，不得静默移除数据库约束。

### 是否进入共享实体

`title_manually_set` 不加入 `AgentSessionRecordSchema`：

- 当前 Session record 定义：`packages/shared/src/contracts/agent.ts:146-157`
- Store 行映射：`apps/api/src/modules/agent/agent.store.ts:25-35,560-577`

原因是前端无需读取该标记。本功能只增加手动更新请求契约，不改变现有 Session 响应结构。

### 创建与 Fork 默认值

创建 SQL 可依赖数据库默认值，也可以显式写 `0`。建议显式写入以增强可读性和测试可控性：

```sql
insert into agent_session (..., title_manually_set)
values (..., 0)
```

当前创建函数：

- `apps/api/src/modules/agent/agent.store.ts:915-949`

普通创建和 Fork 都经过 `createAgentSession()`：

- 普通创建：`apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts:46-48`
- Fork：同文件 `:115-129`

因此在统一创建函数设为 `0` 即可保证 Fork 不继承源标记。不得将源 Session 的标记加入 `SessionCloneInput`。

## 标题领域规则

必须在 Agent API 领域内建立一个小型权威 helper，消除当前首消息格式化函数在生命周期与 composition 中重复的问题，但不得顺带进行大规模重构。建议路径为 `apps/api/src/modules/agent/session/session-title.ts`。

可采用如下职责：

```ts
export function compactSessionTitleText(value: string): string;
export function toAutomaticSessionTitle(value: string, emptyFallback: string): string;
export function normalizeManualSessionTitle(value: string): string;
```

允许根据项目命名习惯调整函数名，但职责必须明确，并保证：

- 共同的空白压缩实现唯一；
- 首消息空白回退“新会话”；
- `todolist.goal` 空白不更新；
- 自动标题超长截断；
- 手动标题空白、超长或含禁止控制字符时返回明确的校验结果，供应用层映射为 `400`；
- 不改变现有自动标题测试结果。

当前重复位置：

- 生命周期：`apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:47-52`
- composition：`apps/api/src/modules/agent/agent.composition.ts:708-713,755-760`

不得为了“统一”把三类来源的空值和超长策略改成相同。

## Store 设计

### 自动标题更新

将当前宽泛函数：

```ts
updateAgentSessionTitle(db, { sessionId, title, updatedAt })
```

改为语义明确的自动更新函数，例如：

```ts
updateAutoAgentSessionTitle(
  db,
  params: { sessionId: string; title: string; updatedAt: number }
): boolean
```

SQL 必须是单条原子更新：

```sql
update agent_session
set title = @title,
    updated_at = @updatedAt
where id = @sessionId
  and title_manually_set = 0
```

要求：

- 保留自动路径更新 `updated_at` 的当前行为；
- 返回 `changes > 0` 便于测试和诊断；
- `false` 在调用方表示“Session 不存在或已手动接管”，自动写回场景均不得抛错；
- 不得在 SQL 前通过读取标记来替代条件更新；
- 首消息和两条 `todolist` 路径必须统一使用该函数。

### 手动标题更新

新增语义独立的 Store 方法，例如：

```ts
setManualAgentSessionTitle(
  db,
  params: { sessionId: string; workspaceId: string; title: string }
): boolean
```

SQL：

```sql
update agent_session
set title = @title,
    title_manually_set = 1
where id = @sessionId
  and workspace_id = @workspaceId
```

要求：

- 标题和接管标记原子写入；
- 不修改 `updated_at`；
- 即使应用层先校验归属，SQL 仍包含 `workspace_id` 条件；
- 已为 `1` 时仍允许更新标题；
- 返回是否命中记录；
- 更新成功后通过现有 `getAgentSession()` 返回完整 record。

### Session 应用层端口

在 `SessionInteractionStore` 增加窄方法，而不是让应用层直接依赖数据库：

- 当前端口：`apps/api/src/modules/agent/session/session-interaction-ports.ts:38-50`
- SQLite 适配器：`apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts:23-48`

建议签名：

```ts
setManualTitle(input: {
  sessionId: string;
  workspaceId: string;
  title: string;
}): boolean;
```

## 应用层设计

在 `SessionInteractionApplication` 增加：

```ts
updateSessionTitle(params: {
  sessionId: string;
  body: AgentUpdateSessionTitleRequest;
}): AgentSessionRecord
```

请求处理分为两个固定阶段，不能把 Fastify/TypeBox 结构校验与应用层业务校验混为一谈。

路由进入应用层前，Fastify 与显式白名单完成结构校验：

- 缺少 `workspaceId/title`、字段类型错误、原始 `title === ""`、原始 `title.length > 1000` 等 body 结构问题直接返回 `400`，不查询 Session；
- URL 缺少 `:sessionId` 路径段时不会命中该路由，固定返回 `404`；已命中路由的 params 再由 TypeBox 校验；
- 未知字段由 `assertOnlyAllowedBodyKeys` 固定返回 `400 AGENT_REQUEST_UNKNOWN_FIELD`，不依赖 TypeBox 的通用错误格式；
- 只有结构合法请求才进入应用层。

应用层处理顺序固定为：

- 根据 `sessionId` 查询 Session；
- 不存在则 `404 session not found`；
- 比较 Session 的 `workspaceId` 与 body：不匹配则 `400 workspaceId mismatch`；
- 规范化手动标题；
- 规范化后为空、超过 50 或仍含禁止控制字符时返回固定的 `400` 错误 code；
- 调用 Store 原子设置标题和接管标记；
- 若更新未命中，在无并发删除支持的当前系统中仍按 `404` 处理；
- 重新查询并返回 `AgentSessionRecord`；
- 不检查 Session `kind` 和 Run 状态。

当前应用层创建和归属校验模式可参考：

- `apps/api/src/modules/agent/session/session-interaction-application.ts:15-25,46-52`

错误合同固定为：

| 阶段 | 场景 | HTTP | message/code |
|---|---|---:|---|
| 路由匹配 | 缺少 `:sessionId` 路径段 | 404 | Fastify 路由未命中 |
| 结构校验 | body 缺字段、类型错误、原始空字符串、原始超过 1000 | 400 | Fastify/TypeBox 标准校验错误 |
| 路由白名单 | 未知 body 字段 | 400 | `AGENT_REQUEST_UNKNOWN_FIELD` |
| 应用层 | Session 不存在或更新期间消失 | 404 | `session not found` |
| 应用层 | Workspace 不匹配 | 400 | `workspaceId mismatch` |
| 应用层 | 规范化后为空 | 400 | `AGENT_SESSION_TITLE_EMPTY` |
| 应用层 | 规范化后超长 | 400 | `AGENT_SESSION_TITLE_TOO_LONG` |
| 应用层 | 规范化后含禁止控制字符 | 400 | `AGENT_SESSION_TITLE_INVALID_CHARACTERS` |

标题业务错误的三个 code 必须由前端映射到对应 i18n 字段错误；不得把它们合并成一个模糊提示。

## 共享契约与 API

### 请求 Schema

在 `packages/shared/src/contracts/agent.ts` 增加：

```ts
export const AgentUpdateSessionTitleRequestSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 1000 })
  },
  { additionalProperties: false }
);
```

`maxLength: 1000` 是本方案确定的原始载荷防御上限，不代表业务允许 1000。业务的规范化后 50 长度由应用层权威校验。

为什么不能仅在 Schema 中设置 `maxLength: 50`：

- 输入可能含大量可压缩空白；
- 产品合同以规范化后的字符串计长；
- TypeBox Schema 无法表达 `/\s+/g` 压缩后的长度。

原始上限固定为 1000，不得由实现者自行改成其他值；若需调整，应先修订本文档和测试合同。

响应复用 `AgentSessionRecordSchema`，不返回内部标记。

### 路由

新增：

```http
PUT /api/agent/sessions/:sessionId/title
Content-Type: application/json
```

请求：

```json
{
  "workspaceId": "workspace-id",
  "title": "修复登录问题"
}
```

成功：

```http
200 OK
```

Body 为完整 `AgentSessionRecord`。

建议在 Session 列表与创建路由附近注册，位置参考：

- `apps/api/src/modules/agent/routes/agent-public.routes.ts:247-350`

路由 schema 必须声明：

- params `sessionId` 非空；
- body 使用共享 Schema；
- `200`、`400`、`404` 响应；
- OpenAPI tags 为 `agent`。

虽然请求 Schema 已设置 `additionalProperties: false`，仍应沿用当前显式字段白名单机制：

- 当前白名单：`apps/api/src/modules/agent/routes/agent-route-auth.ts:4-5,18-24`

新增例如：

```ts
export const AGENT_SESSION_TITLE_UPDATE_BODY_KEYS = new Set(["workspaceId", "title"]);
```

因此未知字段的唯一合同是 `400 AGENT_REQUEST_UNKNOWN_FIELD`；不得写成“由 Schema 或白名单任一拒绝”。

### Service / Composition 暴露

能力链需要增加 `updateSessionTitle`：

- `AgentService` facade：`apps/api/src/modules/agent/agent.service.ts:15-40` 附近；
- Session capability picker/type：`apps/api/src/modules/agent/agent.composition.ts:1133-1161`；
- 应用函数委托：同文件 `:1803-1836`；
- 最终 capability 返回对象：同文件 `:2462` 附近。

实现必须保持路由只调用 service，不绕过应用层。

## 自动路径改造

### 首消息路径

当前代码在 lifecycle transaction 内获取 head、追加用户 item，并在 `head == null` 时更新标题：

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:89-125`

改造要求：

- 触发条件 `head == null` 不变；
- 标题格式不变；
- 调用原子条件自动更新函数；
- 已手动接管时 `changes = 0`，事务继续提交；
- 不记录 error，不影响 Run 激活；
- 仍使用 `input.createdAt` 更新自动路径的 `updated_at`。

这也覆盖极端但合法的顺序：空 Session 在首消息前通过 API 手动改名。首消息不得覆盖。

### `todolist` append 路径

当前位置：

- `apps/api/src/modules/agent/writeback/context-writeback-application.ts:89-96`

改造要求：

- completed 判断与 title 格式化不变；
- `updateSessionTitle` dependency 改名为体现自动语义；
- 手动接管导致更新零行时，append 仍返回 `{ ok: true, item }`；
- 不改变 conflict、missing session/run、workspace mismatch 行为。

### `todolist` update 路径

当前位置：

- `apps/api/src/modules/agent/writeback/context-writeback-application.ts:112-139`

改造要求与 append 相同，且必须独立测试：

- 仅 update 真正产生 `updated` 且结果为 completed todolist 时尝试；
- `unchanged` 提前返回时不重复写标题；
- 手动接管时 Context item 更新成功，标题保持不变。

### Composition 注入

当前注入位于：

- `apps/api/src/modules/agent/agent.composition.ts:1637-1643`

应注入自动条件更新函数。不要把手动 API 的更新方法复用到 Worker 写回路径。

## 前端设计

### API 客户端

在 `apps/web/src/shared/api/api.ts` 的 Session API 区域增加：

```ts
export async function updateAgentSessionTitle(
  sessionId: string,
  body: AgentUpdateSessionTitleRequest
): Promise<AgentSessionRecord>
```

现有 Session API 位置：

- `apps/web/src/shared/api/api.ts:1102-1158`

必须沿用 `toApiError()`。

### Tab 按钮

当前 Tab 结构：

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:19-40`

在标题文本后、状态图标前增加 `EditOutlined` 或 `SettingOutlined`。必须使用可聚焦的 `a-button type="text"`，不能只给裸图标绑定点击。按钮必须：

```vue
<a-button
  type="text"
  :aria-label="t('agent.actions.setSessionTitle')"
  @mousedown.stop.prevent
  @click.stop.prevent="openTitleModal(session)"
>
  <template #icon><EditOutlined /></template>
</a-button>
```

核心要求是显式本地化 `aria-label`、Enter/Space 可操作，并仅在 `!isDraftSession(session)` 时显示。Tooltip 可保留，但不能替代 `aria-label`。

现有关闭按钮已经使用相同事件阻止模式：

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:33-38`

### 弹窗状态

建议由 `AgentToolView.vue` 管理：

- `titleModalOpen: Ref<boolean>`；
- `titleEditingSessionId: Ref<string>`；
- `titleInput: Ref<string>`；
- `titleSaving: Ref<boolean>`；
- 字段校验状态或错误文本。

打开时按 Session ID 从当前 `serverSessions` 获取 record，回填标题。不要持有可能被列表刷新替换的对象引用作为唯一权威。

既有数据可能由创建/Fork 等旧规则产生，当前创建标题没有统一的 50 字符业务限制。弹窗必须兼容这些历史/既有标题：

- 回填完整 `session.title`，不得先规范化、截断或替换禁止字符；
- 即使标题原始长度超过 1000，也必须完整展示，打开或取消弹窗不修改服务端数据；
- 若回填值规范化后为空、超过 50 或含禁止控制字符，立即显示对应字段错误并禁止保存；
- 用户编辑为合法值后才能调用 API 并完成接管；API 不为历史标题放宽规则；
- “相同标题保存也接管”仅适用于当前标题本身符合新手动输入规则的情况。

输入组件规则固定为：

- 不得使用 `maxlength=50`，否则会在空白压缩前错误截断原始输入；
- 不设置 DOM `maxlength`。原始 1000 上限由显式前端校验和共享 Schema 执行，避免超过 1000 的既有标题在程序化回填时被组件静默截断；
- 字符计数、字段错误和保存可用性按规范化后的 JavaScript `string.length` 计算；
- 原始输入超过 1000 时显示请求上限错误并禁止提交；
- 请求 body 中提交规范化后的标题，而不是原始输入。

保存时：

- 重新确认目标仍存在且不是 draft；
- 规范化输入；
- 输入满足原始不超过 1000、规范化后 1-50 且无禁止控制字符时，无论规范化结果是否等于当前合法标题，都请求 API，使“保存”成为明确的手动接管动作；
- 成功后按 ID 原位替换 `serverSessions` 对应元素；
- 不调用 `.sort()`；
- 如果编辑目标在保存期间被关闭，数据仍可更新，弹窗关闭；
- Workspace 切换或组件卸载时不得把旧 Workspace 响应写入新状态，必须使用下文 `workspaceGeneration` 和请求捕获的 workspace/session ID 校验；
- idle 且无其他业务写入时，响应 `updatedAt` 应与保存前相同；运行中不得用响应时间戳覆盖更新来推断标题 API 修改了 `updatedAt`。

### 陈旧列表响应保护

必须处理：

```text
refreshSessions() 开始，服务端返回前的快照标题为旧值
-> 手动保存成功，本地标题更新
-> 旧 refreshSessions() 后返回
-> 不能用旧标题覆盖本地新标题
```

建议使用按 Session 的 mutation revision：

```ts
let titleMutationRevision = 0;
const titleMutationRevisionBySession = new Map<string, number>();
const titleMutationRecordBySession = new Map<string, AgentSessionRecord>();
let workspaceGeneration = 0;
let disposed = false;
```

刷新发起时记录：

```ts
const requestRevision = titleMutationRevision;
```

手动保存成功后：

```ts
titleMutationRevision += 1;
titleMutationRevisionBySession.set(sessionId, titleMutationRevision);
titleMutationRecordBySession.set(sessionId, responseRecord);
```

刷新返回合并时：

- 若该 Session 的成功 mutation revision 大于 `requestRevision`，且远端列表仍包含该 Session，则暂时保留手动 API 成功响应后的完整 `AgentSessionRecord`，不得采用旧列表中的 `title`、`headItemId`、`updatedAt` 或任何其他字段；
- 如果远端已不存在该 Session，不得为了保留标题而复活已删除记录；
- 保护仅针对成功的手动 mutation，失败请求不得提升 revision；
- 只要本次列表响应触发过完整 record 保护，列表完成后必须调度一次新的列表请求 R2；
- R2 的请求开始 revision 已包含 M1，因此可完整采用服务端返回的权威 record，并结束临时保护；
- R2 调度必须去重，避免多个受保护 Session 或多个完成回调形成刷新风暴；
- R2 失败时保留 M1 API response record，不回退到 R1；R2 清理自己的 loading 后，由后续激活、显式刷新或既有刷新触发器再次获取权威列表；
- 后续任一 mutation 后开始且成功的列表请求都可完整采用服务端 record，并清理已收敛 Session 的临时 record 缓存；
- M1 之后才开始的普通列表请求无需保护，可完整采用服务端结果；
- 新 Workspace 初始化时清理 title revision 状态。

不能只保护 `title`。旧列表响应可能同时携带更旧的 `headItemId`、`updatedAt` 等字段，字段级拼接会构造服务端从未存在过的混合 record。临时保留完整 API record，再由 R2 收敛，是本方案唯一允许的合并策略。

当前 `refreshSessions()` 位置：

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:561-592`

现有全局布尔值 `loadingSessions` 还会产生另一类问题：旧 Workspace 请求未结束时切换 Workspace，新 Workspace 的刷新可能因 `loadingSessions === true` 直接返回，旧请求结束后又因响应过期被丢弃，最终新 Workspace 永不加载。

必须将刷新占用状态按 Workspace 代次隔离，例如用活动请求 token 取代全局互斥：

```ts
type SessionRefreshToken = { generation: number; workspaceId: string };
let activeSessionRefresh: SessionRefreshToken | null = null;
```

固定闭环：

- `props.workspaceId` 变化时先递增 `workspaceGeneration`，清空该 Workspace 相关 Session/UI/revision 状态，并立即为新 generation 触发 `refreshSessions()`；
- Workspace 切换时同步关闭标题弹窗并清空 `titleEditingSessionId/titleInput`；
- `refreshSessions()` 捕获 `{ generation, workspaceId, requestRevision }`；
- 只有“同 generation 已有请求”时才允许复用/跳过；旧 generation 请求不得阻止新 generation 发起；
- 响应返回后，仅当捕获的 generation 和 workspaceId 仍与当前值一致时才能写状态；否则静默丢弃；
- `finally` 只能清理与自己 token 相同的 active 标记，旧请求不得把新请求的 loading 状态清掉；
- 新 generation 请求失败时，清理自己的 active 标记并保留现有错误提示，使用户点击/激活或既有刷新触发器可以重试；
- `session-title-sync-needed` 的失败重试只可恢复到原 generation；若 Workspace 已切换，必须丢弃旧 retry baseline；
- `onActivated`、Workspace watch 或显式重试触发新刷新时，不得因旧 generation 的 Promise/布尔锁被永久短路。

组件卸载闭环固定为：

- `onBeforeUnmount` 先设置 `disposed = true`，并递增 `workspaceGeneration`，使所有已捕获 generation 的 refresh 和 title mutation 响应失效；
- 清空标题弹窗 open 状态、编辑目标、输入和字段错误；
- 清空 title mutation revision/record 缓存和 retry baseline；
- 在途请求无需强制取消，但其 `then/catch/finally` 在写状态前都必须检查 `disposed/generation/token`；
- 旧 Promise 的 `finally` 只能清理与自己完全相同的 token，不得清理后续请求或其他 generation 的 token；
- title mutation 如果已在服务端成功，卸载不会回滚服务端结果，但其响应不得再写入已卸载组件。

完整时间线必须成立：

```text
G1/W1: R1 开始，标记 G1 loading
切换到 W2 -> generation 变为 G2，立即启动 R2，不受 R1 阻止
R1 返回/失败 -> 因 generation 过期丢弃，且不得清理 R2 标记或安排 G1 重试
R2 返回 -> 写入 W2 Session 并清理 G2 loading
R2 失败 -> 清理 G2 loading；后续激活/刷新可重新发起 R3
```

### 文案

中英文 locale 位置：

- `apps/web/src/shared/i18n/locales/zh-CN.ts:288-323` 附近；
- `apps/web/src/shared/i18n/locales/en-US.ts:290-325` 附近。

至少增加：

- 设置按钮共用的本地化 `aria-label`/Tooltip 文案；
- 弹窗标题；
- 输入框 label/placeholder；
- 永久接管说明；
- `AGENT_SESSION_TITLE_EMPTY` 专用字段错误；
- `AGENT_SESSION_TITLE_TOO_LONG` 专用字段错误；
- `AGENT_SESSION_TITLE_INVALID_CHARACTERS` 专用字段错误；
- 保存成功提示（可选，若项目惯例避免成功 toast 可省略）。

前端必须按 API error code 精确映射以上三个字段错误；其他 Schema、Workspace、404 或网络错误沿用通用 API 错误展示，不得误映射成标题长度错误。

## 并发一致性

### 服务端竞争

| 实际提交顺序 | 预期最终状态 |
|---|---|
| 自动更新先，手动更新后 | 手动标题，标记为 `1` |
| 手动更新先，自动更新后 | 自动 SQL 条件不满足，保持手动标题 |
| 两次手动更新 | 后提交成功的合法标题生效，标记保持 `1` |
| manual 下 append todolist | item 写回成功，标题不变 |
| manual 下 update todolist | item 更新成功，标题不变 |

当前个人自托管场景采用最后写入成功的手动请求获胜，不引入 ETag、版本号或 `expectedUpdatedAt` 乐观锁。

### 客户端竞争

- 同一弹窗通过 `titleSaving` 阻止重复提交；
- 不保证两个浏览器页面即时一致；
- 另一页面在下一次 Session 列表刷新后看到新标题；
- 当前页面必须即时更新，并防止旧列表响应回滚；
- 不新增标题 WebSocket/SSE 事件。

## 日志与可诊断性

- 合法的自动跳过不应记录 warning/error，避免运行中的 `todolist` 产生噪声；
- API 非法输入通过结构化 HTTP 错误返回；
- 不在日志中打印完整用户标题，避免无必要传播用户输入；
- 若 Store 更新在应用层校验后仍未命中，可记录不含标题正文的诊断信息，例如 sessionId/workspaceId 和操作类型。
