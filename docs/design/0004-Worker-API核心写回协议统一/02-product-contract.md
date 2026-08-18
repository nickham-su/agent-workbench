# 产品与 HTTP 合同

## 通用边界

### 请求处理顺序与鉴权

纳入 endpoint 当前均遵循：

```text
Fastify request schema validation
  -> route handler 内 assertInternalToken()
  -> AgentService
```

- schema 不合法时 handler 不执行；无效 token + 无效 body 返回 `400` body validation error。
- schema 合法但 token 无效时按当前 token 断言返回 `401`。
- 1B 不改变顺序、不前移 token、不重写全局错误 body。

### 未知字段

| schema 情况 | 当前 Fastify/AJV 行为 | 本期要求 |
|---|---|---|
| 未设 `additionalProperties: false` | 未知字段校验通过并保留在 `req.body` | 按现状建模，不全局收紧 |
| 设 `additionalProperties: false` | 在 `removeAdditional: true` 下未知字段被剥离，请求继续 | 不误写为必然 `400` |
| `subtask.start.preforkMeta` | 已是 strict object，未知字段被剥离 | 保持行为 |
| `subtask.start.session` union members | `new`/`fork` member 对额外字段宽松；`existing.sessionId` 仍为必填 | 保持 `new`/`fork` 宽松，使额外 `sessionId` 继续由 Service 处理；同时保留 `existing.sessionId` 必填约束 |

除另行说明外，HTTP 成功 response 的 schema 应精确表达稳定形状，例如 `ok: Type.Literal(true)`。

## Run 状态

### `POST /api/internal/agent/run-state`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`status:"idle"|"running"`、`activeRunId:string|null`、`activeAssistantItemId:number|null`、optional `lastResponseTotalTokens:number|null`、optional `runNoticeText:string|null`、optional `updatedAt:number` |
| params | 无 |
| success | `200 { "ok": true }` |
| 正常语义 | 对当前 active run 更新 session run-state；保留既有 Store/Service 的状态收敛与事件行为 |
| token/schema | schema-first，再在 handler 内 token 断言 |

以下 ignored 情形都必须直接成功返回，不新增 `applied` 字段、不改为 `404/409`，默认不记录 warning：

| 编号 | ignored 条件 |
|---|---|
| RS-1 | request `activeRunId` 与 session 当前 activeRunId 不同 |
| RS-2 | active run 归属的 workspace 或 session 不匹配 |
| RS-3 | active run 已 terminal |

因此 `200 { ok: true }` 只表示 API 已接受并按规则处理写回，**不表示一定修改数据库**。

### `POST /api/internal/agent/run-complete`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`runId:string`、`status:"completed"|"failed"|"cancelled"`、optional `updatedAt:number` |
| params | 无 |
| success | `200 { "ok": true }` |
| 正常语义 | 收敛 run record 与 session run-state，保留当前 completion 事件和业务层 fallback 行为 |
| token/schema | schema-first，再在 handler 内 token 断言 |

以下 ignored 情形保持 `200 { ok: true }`：

| 编号 | ignored 条件 |
|---|---|
| RC-1 | run 不存在 |
| RC-2 | run 的 workspace 或 session 与请求不匹配 |
| RC-3 | run 已 terminal |

本期不把 completion ignored 改为 `404`、`409` 或携带 `applied:false`。

## Context item

### `POST /api/internal/agent/context-items`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`runId:string|null`、`turnId:string|null`、`step:number|null`、`prevId:number|null`、`kind:"user"|"assistant"|"tool"|"system"`、context item status、`output:AgentContextItemOutput`、optional `createdAt:number` |
| params | 无 |
| success | `200 { ok: true, item: AgentContextItemRecordSchema }` |
| Worker 消费 | Worker 仍仅消费 `response.item.id`；完整返回是稳定协议与 runtime validation 的依据 |
| token/schema | schema-first，再在 handler 内 token 断言 |

`output` 必须直接使用公共 `AgentContextItemOutputSchema`：

- 当前合法 Worker output（`user_text`、`assistant_text`、`tool`、`system_text`，含 builtin、canonical MCP、canonical plugin tool 名及宽松 `args/result`）完全兼容。
- 原 Route `Type.Any()` 接受任意非法 JSON 不是兼容承诺；例如非法 tool name 可在 Store 回读后触发 success response serializer `500`。
- 本期有意将该非法内部输入前移为边界 validation `4xx`。这是唯一明确的 request acceptance 收紧，必须有回归测试；不得表述为“完全无行为变化”。
- schema 未声明的 output 内字段可能被 Store normalize 或选择性持久化，稳定合同只保证 schema 声明字段，不保证未知字段回显。

`prevId` 与 session 当前 head 不一致时：

```text
HTTP 409
code: conflict_head:<currentHeadItemId|null>
```

Worker 对此 endpoint 使用 `conflictAsError: true`：`409` 转为 `ApiConflictError("context conflict")`，Runner 按当前行为停止 run，不自动重试。

### `PATCH /api/internal/agent/context-items/:itemId`

| 项目 | 合同 |
|---|---|
| params | `itemId:number>=1` |
| request body | optional context item status、optional `output:AgentContextItemOutput`、optional `updatedAt:number`；当前 update 不携带 workspace/session |
| success | `200 { ok: true, item: AgentContextItemRecordSchema }` |
| Worker 消费 | 仍只需 `item.id` |
| token/schema | schema-first，再在 handler 内 token 断言 |

此接口没有 head CAS conflict。若目标 item 已 terminal：

```text
200
返回原 item
不写 DB
```

这是 ignored，不是 conflict。调用前的 Service/artifact 流程可能已写入文件，Store 才判定 terminal ignored；所以不能承诺“terminal update 完全无副作用”。

## Context compaction

### `POST /api/internal/agent/context/compact`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`runId:string`、`expectedHeadItemId:number|null`、`summaryText:string` |
| params | 无 |
| success | `200 { compacted:boolean, summaryItemId:number|null, archivedCount:number }` |
| token/schema | schema-first，再在 handler 内 token 断言 |
| Worker 行为 | `conflictAsError: true`；任意 `409` 转 `ApiConflictError("context conflict")`，不 retry |

存在两种都合法、必须保留的 head conflict response：

| 路径 | HTTP body | 副作用事实 |
|---|---|---|
| Service 前置检查 | `409 { "message": "session head conflict" }`，无 `code` | 尚未写 archive 文件，未进入 Store transaction |
| Store transaction 二次 CAS | `409 { "message": "session head conflict", "code": "conflict_head:<currentHeadItemId|null>" }` | archive 可能已追加；随后 best-effort rollback |

两条 `409` 都保证 summary/context archive/head 的**数据库状态不提交**。但 archive 文件、DB transaction、run-state 不是全局事务：回滚可能 skipped，可能留下 warning 或文件残留。本期不统一两条 error body、不新增 retry，也不重构文件/DB 原子性。

## Subtask 生命周期

### 共同行为

四个接口都验证 workspace/session/run 归属及其既有业务不变量；它们不使用 `conflictAsError`。即使 API 返回 `409`，Worker 当前也得到普通 Error（详见“非 2xx”），不是 `ApiConflictError`，不按 error code 自动分支或重试。

### `POST /api/internal/agent/subtask/prefork-plan`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`parentSessionId:string`、`parentRunId:string`、`parentToolItemId:number>=1`、`agentId:string`、optional `thresholdPct:number` |
| params | 无 |
| success | `200`，返回是否 `shouldPrefork` 及当前 prefork planning 所需数据 |
| 语义 | 只读规划；按 parent run-state token 使用量和 child context window 决定是否应预 fork |

`thresholdPct` Service 归一范围为 `50..99`，缺失默认 `95`；Worker fork 模式固定传 `95`。后续摘要失败时 Worker 吞掉该失败并降级正常 fork，prefork 失败不得阻断 `start`。

### `POST /api/internal/agent/subtask/start`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId`、`parentSessionId`、`parentRunId`、`parentToolItemId>=1`、`description`、`prompt`、`agentId`、`session:{mode:"new"}|{mode:"existing",sessionId:string}|{mode:"fork"}`、optional `preforkSummaryText`、optional `preforkMeta:{thresholdPct,parentLastResponseTotalTokens,childContextWindowTokens}` |
| params | 无 |
| success | `200 { sessionId, runId, workspacePath, agentName, reused }` |
| 唯一 identity | `(parentRunId, parentToolItemId)`，由 `idx_agent_run_parent_tool_unique` 约束 |

`reused:true` 表示已返回同一 child run identity；并发同一 key 的两个 start 应都可 `200`，一方 `reused:false`、一方 `reused:true`，并返回相同 child run/session，且仅有一个 child run。它**不**表示整个请求无副作用：`new/fork` 的 `createSession()`/`forkSession()` 可能在主 transaction 前执行；后续 profile/workspace/prompt/transaction 错误或 unique race 可留下未关联 session。

模式规则：

- `new`、`fork` member 未设 strict；额外携带 `sessionId` 仍匹配 union，进入 handler/Service 后返回 `400 AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED`。
- `existing` member 将非空 `sessionId` 声明为必填。普通 HTTP 请求缺少该字段时不匹配 union，在 Fastify schema validation 阶段直接返回 `400`，不进入 handler/Service，也不返回 `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED`。
- `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED` 保留为 Service 的稳定防御性业务判断（例如绕过普通 Route schema 的直接调用）；它不是当前 HTTP Route 对“existing 缺 sessionId”输入的可达响应。
- `start.session` 的 `new`/`fork` member 必须继续宽松，不能 strict 化后将 `AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED` 改为 validation error；`existing.sessionId` 的必填约束同样必须保持。
- `preforkMeta` strict object 的未知字段在当前 AJV 下被剥离，不是 `400`。

### `POST /api/internal/agent/subtask/result`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`runId:string` |
| success | `200 { "resultText": string }` |
| 语义 | 读取最后一个非空 assistant text，否则 system text，否则空字符串 |

running run 可返回 partial text；failed/cancelled terminal run 也可能有 partial assistant text。它不是 ignored 操作。

### `POST /api/internal/agent/subtask/status`

| 项目 | 合同 |
|---|---|
| request body | `workspaceId:string`、`sessionId:string`、`runId:string` |
| success | `200 { "status": "running" | "completed" | "failed" | "cancelled" }` |
| 语义 | 直接读取 run record |

`result/status` 不验证调用者是不是该 child 的 parent，只验证 workspace/session/run 归属。

## Subtask 稳定业务错误码

以下 code 是 API/测试合同；Worker 当前不结构化消费它们。准确 HTTP status 必须以现有 `AgentService` 抛出点的冻结测试为准，已确认分类如下。

| 类别 | code | 当前 HTTP status |
|---|---|---|
| anchor/agent | `AGENT_SUBTASK_ANCHOR_RUN_MISMATCH` | 400 |
| anchor/agent | `AGENT_SUBTASK_ANCHOR_INVALID` | 400 |
| anchor/agent | `AGENT_SUBTASK_AGENT_REQUIRED` | 400 |
| anchor/agent | `AGENT_DISABLED_IN_WORKSPACE` | 400 |
| prefork | `AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID` | 400 |
| start | `AGENT_SUBTASK_DESCRIPTION_REQUIRED` | 400 |
| start | `AGENT_SUBTASK_PREFORK_NOT_ALLOWED` | 400 |
| start | `AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG` | 400 |
| start | `AGENT_SUBTASK_PREFORK_META_INVALID` | 400 |
| start | `AGENT_SUBTASK_PREFORK_META_MISMATCH` | 400 |
| start | `AGENT_SUBTASK_EXISTING_SESSION_MISMATCH` | 409 |
| start | `AGENT_SUBTASK_DEPTH_UNKNOWN` | 409 |
| start | `AGENT_SUBTASK_MAX_DEPTH_EXCEEDED` | 409 |
| start（Service 防御性路径） | `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED` | 400；普通 HTTP Route 的 existing 缺 `sessionId` 不可达此处，先返回 schema validation 400 |
| start | `AGENT_SUBTASK_SESSION_NOT_FOUND` | 404 |
| start | `AGENT_SUBTASK_WORKSPACE_MISMATCH` | 400 |
| start | `AGENT_SUBTASK_KIND_MISMATCH` | 400 |
| start | `AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED` | 400 |
| start | `AGENT_SUBTASK_SESSION_MODE_INVALID` | 400 |
| start | `AGENT_SUBTASK_SESSION_RUNNING` | 409 |
| start | `AGENT_SUBTASK_PROMPT_REQUIRED` | 400 |
| start | `AGENT_SUBTASK_FORK_BOUNDARY_INVALID` | 400 |

已确认 `AGENT_SUBTASK_SESSION_NOT_FOUND` 的当前 HTTP status 为 `404`；各 endpoint 的既有业务 `404` 继续使用 API 当前 `{ message, code }` error body。shared 不得为这些错误虚构统一 envelope。实施前仅需复核行号是否漂移，而非重新假设该合同。

## 端点 status 总表

| endpoint | success | 当前声明/业务错误 status |
|---|---|---|
| run-state | 200 | 400（schema）、401（token）；Service ignored 仍为 200 |
| run-complete | 200 | 400（schema）、401（token）；Service ignored 仍为 200 |
| context-items POST | 200 | 400（schema/业务）、401、404、409（head conflict） |
| context-items PATCH | 200 | 400（params/body schema）、401、404；terminal ignored 为 200 |
| context/compact | 200 | 400、401、404、409（两种合法 body） |
| subtask/prefork-plan | 200 | 400、401、404 |
| subtask/start | 200 | 400、401、404、409（稳定 code 见上表） |
| subtask/result | 200 | 400、401、404 |
| subtask/status | 200 | 400、401、404 |

Route 成功 schema 与实际 `200` body 必须同步迁移；错误 response 继续沿用当前 API error schema/body，不受 Worker success strict/warn 校验。

## 非 2xx 与成功响应校验

`AgentApiClient.request()` 当前尝试解析 `{ message, code }`，但在同一 `try` 内抛出的结构化 Error 被自身 `catch` 捕获。因此非 `2xx` 最终错误文本为：

```text
request failed: <HTTP status> <raw response body>
```

本期必须保持该实际行为：不修复 parser，不校验 error body schema，不依据 code 分支。Context create/compact 的 `409` 是唯一现有 `conflictAsError:true` 特例；subtask `409` 仍为上述普通 raw-body Error。

成功响应则由 Worker 进行 runtime schema validation：

- `strict`（默认）：2xx JSON body 不符合 schema，本次调用失败。
- `warn`：仅当 **HTTP 2xx + JSON 可解析 + 成功 schema 不匹配** 时，记录 endpoint 与 schema 错误摘要的 warning 后继续。
- `warn` 不绕过 non-2xx、409、401、网络错误、timeout、JSON parse failure 或业务 conflict。
