# 产品与 HTTP 合同

## 规范性约定

- 以下合同描述的是 Worker → API internal route。全局 token 鉴权始终先于 schema validation。
- `execution-profile` 与 `prompt-context` 是 run-bound；`messages-context` 是 session-bound。
- 本轮 read-side 只包含本文件前三个 endpoint。`archive/*`、`plugins/*`、`git-env/*`、`mcp-settings` 不属于本轮 read-side contract。
- 现有 response 中的动态 payload 可保持宽松，但稳定外壳、字段名称、literal/enum/nullability 和错误状态必须被 shared schema 冻结。

## 通用鉴权与错误顺序

```text
全局 onRequest token 鉴权
  → Fastify request schema validation
  → route handler / AgentService
```

### 状态规则

| 条件 | HTTP 语义 |
|---|---|
| token 无效 | `401`，即使 body 也非法 |
| token 合法、body 非法 | `400`，handler/service 不执行 |
| session/run 不存在或 run 归属不匹配 | 继续保持现有 `404` |
| 正常业务成功 | `200` |

本轮不新增 `409`、`422` 或 terminal/stale 专用状态码，不移动鉴权 hook，不重写全局错误 envelope。

## `POST /api/internal/agent/execution-profile`

### Request

```json
{
  "workspaceId": "string, non-empty",
  "sessionId": "string, non-empty",
  "runId": "string, non-empty"
}
```

### 成功 response

保持当前真实 response 的稳定外壳：

```text
resolved
agent
provider
model
runtime
vision
compaction
```

其中：

- `resolved.runId/sessionId/workspaceId/agentId/providerId/modelId` 为非空字符串；
- `agent`、`provider`、`model` 和 `runtime` 的稳定字段必须有 schema；
- `vision`、`compaction` 可为 `null`，非 null 时按当前 provider/model 外壳校验；
- provider/model 的动态 `options` 保持宽松；
- 当前 Worker 所需的 provider options（包括运行所需敏感字段）继续返回，不在本轮移除或改成引用。

### 业务语义

1. 先校验 session 存在并属于 workspace；
2. 再校验 run 存在且同时属于 workspace/session；
3. 根据 run 固定的 agent/provider/model 与 session surface 解析 profile；
4. 返回当前 runtime settings、vision/compaction profile。

run 缺失、run 归属不匹配或 session 不存在保持当前 `404` 语义；workspace mismatch 保持当前实现语义，不在协议迁移中重新定义。

## `POST /api/internal/agent/prompt-context`

### Request

```json
{
  "workspaceId": "string, non-empty",
  "sessionId": "string, non-empty",
  "runId": "string, non-empty"
}
```

### 成功 response 稳定外壳

```text
headItemId
system
messages
 tools
pendingTools
lastResponseTotalTokens
uiLocale
externalSkillRoots
```

稳定规则：

- `headItemId` 为正整数或 `null`；
- `system` 为字符串；
- `messages` 为消息数组，role 限于当前 `system/user/assistant/tool`；
- `tools` 为 `{name, description, inputSchema}` 数组，`inputSchema` 保持动态；
- `pendingTools` 为稳定字段数组，`args` 保持动态；
- `lastResponseTotalTokens` 为非负数字或 `null`；
- `uiLocale` 为当前支持 locale 或 `null`；
- `externalSkillRoots` 的稳定 source/root 字段精确建模，其余按当前可选字段建模。

消息 content、tool schema、pending args 等动态内部不做深度 schema。

### 业务语义

- 这是 run-bound 读取；
- 使用当前 run/session/workspace 归属检查；
- 继续使用 `runPromptStaticCache` 的当前 key、TTL、命中、失效和静态/动态拆分；
- 不因协议迁移改变 prompt 拼装、skills 扫描、locale、工具描述或 reasoning 过滤；
- 不新增分页、截断、`maxChars`、压缩或通用体积保护。

## `POST /api/internal/agent/messages-context`

### Request

```json
{
  "workspaceId": "string, non-empty",
  "sessionId": "string, non-empty",
  "appendMessage": {
    "role": "system | user",
    "content": "non-empty string"
  }
}
```

`appendMessage` 可省略；它是响应构造时追加的 one-shot message，不是 context item 持久化写回。

### 成功 response

```json
{
  "headItemId": "positive integer | null",
  "system": "string",
  "messages": [
    {
      "role": "system | user | assistant | tool",
      "content": "dynamic message content"
    }
  ]
}
```

### 业务语义

- 这是 session-bound 视图；request 不增加 `runId`；
- session 不存在继续 `404`；workspace 不匹配继续当前 `400`；
- 保持 active run/session recent/global recent 的 locale fallback；
- 保持 one-shot system prompt 生成；
- 不为 terminal run 增加特殊返回；
- 不增加分页、截断、压缩或 body limit 语义。

## Lifecycle：late append/update 合同

### 与 1B 基线的关系

- 0004 是 1B 已完成事实的设计基线；其正常 Context create 成功 response 不被本期回写或否定。
- 本节定义的是 1D 对 Context create success response 的受控扩展，且只适用于满足 late append 判定的 no-op。
- shared schema、Route、Worker Client typed response 和测试必须在 P3 一起迁移；P1/P2 不得预先修改 Context create schema。

### 正常 Context create 基线

1B 已冻结正常 create 成功 response：

```json
{
  "ok": true,
  "item": { "...完整 AgentContextItemRecord..." }
}
```

正常 create 仍必须返回完整 record，Worker 依赖 `item.id` 等字段。

### Late append 定义

当 Worker 提交 append 时，API 在同一 DB 操作边界确认目标 run 已为 terminal/cancelled，或该 run 已不再是 session 的有效 active run，此请求属于 late append。

规范要求：

- 不创建新 context item；
- 不推进 session head；
- 不改变 run/session terminal 状态；
- 不产生新的持久化副作用；
- 不把正常 create response 中不存在的虚构 item 返回给 Worker。

### Late append 的 response 策略

late append no-op response 在本方案中已冻结，采用以下唯一合同：

```json
{"ok":true,"item":null,"ignored":true}
```

shared Context create success response 必须表达为可判别的联合：

```text
normal: {ok:true, item:AgentContextItemRecord}
late no-op: {ok:true, item:null, ignored:true}
```

规范要求：

- `ignored` 只允许出现在 `item:null` 的 late no-op 分支，且值必须为 literal `true`；
- 正常 create 不得出现 `ignored`，并继续返回完整 `AgentContextItemRecord`；
- Worker Client 必须返回可区分两分支的 typed response；late no-op 不是网络错误；
- Route response schema、Service 返回值和测试必须与该联合一致；
- 不得返回裸 `{ok:true}`，不得返回虚构 item，不得使用未声明的替代 response。

### Update fence

已有 item update 只有在以下条件全部满足时才允许业务处理：

- item 存在；
- item、run、session、workspace 归属一致；
- update 不试图新增 item；
- update 不将 terminal/cancelled item/run 逆转为活动状态；
- 状态变化属于既有必要终态收敛。

terminal update 的既有返回形状与 artifact 特殊处理必须由冻结测试确认，不得以“无副作用”作无证据承诺。

## Lifecycle：recover/cancel

### Cancel wins

- cancel 已在 DB 收敛为 terminal/cancelled 后，recover 必须跳过；
- recover 扫描得到候选后、`runtime.enqueueRun()` 前必须再次读取 DB；
- 最终检查至少确认 run 仍存在、仍为 in-flight、workspace/session 归属未变、session 仍允许执行；
- 已发出的 runtime 执行可短暂继续，但后续写回服从 late fence。

### Runtime cancel

API 先收敛 DB，再 best-effort 调用 runtime cancel。runtime 调用失败需有有限 warning，但不得回滚 DB cancel，也不得让 recover 重新激活该 run。

## Lifecycle：lineage 与 orphan

### 权威 lineage

```text
parentRunId + parentToolItemId
```

是 child 关联的权威来源。`subtaskSessionId` 仅为 parent tool 的呈现/快速定位字段，未回填不影响 child 的 DB 查询、cancel cascade 或诊断。

### Orphan suspect

同时满足以下条件才进入 suspect：

```text
session.kind = subtask
无 run record
无 context item
headItemId = null
createdAt 早于当前时间 1 小时以上
```

### 自动删除

只有 suspect 且同时满足以下条件，才允许删除：

```text
forkedFromSessionId 非空
forkedFromItemId 非空
createdAt 早于当前时间 24 小时以上
删除前再次确认仍无 run/context item 且 headItemId=null
```

其他情况只记录诊断，不删除。启动扫描和即时补偿都不得删除可能被 existing reuse 使用的非空壳 session。

## Lifecycle：archive reconciliation

只处理 rollback skipped：

- rollback skipped 时写最小 pending sidecar；
- sidecar 使用 tmp + rename best-effort；
- 服务启动、同 session 下一次 clear/compact 前尝试 reconcile；
- 仅当 `currentSize === expectedSize` 时 truncate 到 `beforeSize`；
- 尺寸不符、缺失、记录不完整时保留 sidecar，不做破坏性处理；
- sidecar 写失败只 warning，不影响 DB 或主流程。
