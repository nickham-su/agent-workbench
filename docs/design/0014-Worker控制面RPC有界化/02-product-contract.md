# 产品行为与故障合同

## 产品语义

本轮不新增用户设置页面、不新增前端状态、不改变 Agent 对话交互。产品变化体现在异常场景：

### 修复前

```text
控制面 RPC 永久 pending
  → session 长期 running
  → loading 无限旋转
  → Provider 没有请求
  → 模型 timeout/retry 不触发
  → 停止任务成为主要人工恢复手段
```

### 修复后

```text
控制面 RPC 达到单次 timeout
  → 安全请求按合同至多 retry 1 次
  → 恢复：run 继续推进
  → 最终失败：进入现有 run failure 收敛
  → Worker Promise 有界结束并释放槽位
```

如果终态提交本身也失败，UI 仍可能保留 stale `running`。产品验收不得把“所有 UI 均自动停止旋转”作为一期绝对承诺。

## 用户可观察行为

### 正常路径

正常 API 响应在 timeout 内完成时：

- 对话文本、工具卡片、子任务、模型调用顺序保持现状；
- 不增加可见重试文案；
- 不新增通知或 toast；
- 正常请求不输出 timeout/retry 日志；
- 正常请求不会因为本方案重复执行工具或子任务。

### 短暂故障恢复

当读类控制面、`startSubtaskRun` 或 `completeRun` 首次因可重试原因失败，第二次成功时：

- 用户不需要手工刷新或重发消息；
- 执行从原逻辑位置继续；
- 不创建重复 child run；
- 不重复发布 run terminal event；
- 运维日志包含 `retry` 和 `recovered`，但不包含业务 payload。

### 最终失败

达到尝试上限时：

- 请求必须抛出可诊断错误；
- runner 必须沿用现有异常收敛，不新增第二套 run 状态机；
- 若 `completeRun(failed)` 成功，session 应按现有生命周期进入 idle，并记录 last terminal failure；
- 若 `completeRun` 也失败，Worker Promise 仍必须在有限时间内结束；数据库可能保留 stale `running`；
- 不允许因为无法提交终态而让 Worker 再次无限等待。

## 请求策略业务合同

### 读类控制面 RPC

合同：

```text
单次 timeout = 15000ms
最大 attempts = 2
最大 retries = 1
retry delay = 300ms
理论最大等待 ≈ 30300ms + 本地同步开销
```

适用于：

- `getExecutionProfile`；
- `getPromptContext`；
- `getMessagesContext`；
- `getSubtaskPreforkPlan`；
- `getSubtaskStatus`；
- `getSubtaskResult`；
- `getAgentMcpSettings`；
- `getPluginRuntimeSnapshots`；
- `listPluginTools`。

纳入依据冻结为：

- `getAgentMcpSettings` 调用 API 侧 `getAgentMcpSettings()`，只读取 MCP 配置快照，不连接或执行 MCP server；
- `getPluginRuntimeSnapshots` 调用 API 侧 `listPluginRuntimeSnapshots()`，只读取 runtime snapshot；
- `listPluginTools` 经 API 调用 plugin-host `listTools`，只返回工具定义，已有独立 4 秒下游 timeout，不调用 `executeTool`。

这三项是控制面发现/配置读取，按 `controlRead` 实施；`executePluginTool` 是实际工具执行，仍明确排除。实施前复核只用于确认代码未偏离上述基线，不允许开发自行改变分类。

读取成功但 response schema mismatch 时，不得 retry。`warn` 模式保持既有“记录 warning 后返回 parsed body”，`strict` 模式保持抛错；两者都不是传输抖动。

### 普通写类控制面 RPC

合同：

```text
单次 timeout = 15000ms
最大 attempts = 1
最大 retries = 0
```

适用于：

- `createContextItem`；
- `updateContextItem`；
- `updateRunState`；
- `compactContext`。

原因：timeout 只表示客户端未在期限内确认响应，不表示服务端一定未提交。自动重试可能重复副作用或造成状态竞争。

### `startSubtaskRun`

合同：

```text
单次 timeout = 15000ms
最大 attempts = 2
最大 retries = 1
retry delay = 300ms
理论最大等待 ≈ 30300ms + 本地同步开销
```

安全前提：

- 两次 attempt 必须使用同一业务请求语义，不得重新生成 parent/tool identity；
- API 以 `workspaceId + parentRunId + parentToolItemId` 查询 existing child；
- 已存在时返回同一 `sessionId/runId` 且 `reused=true`；
- 唯一约束竞争后回查 winner；
- 如果上述幂等/复用语义在实施前已改变，必须暂停并取消该自动重试决策。

产品含义：首次服务端创建成功但响应丢失时，第二次请求必须复用同一 child，不得产生第二个子任务。

### `completeRun`

合同：

```text
单次 timeout = 5000ms
最大 attempts = 2
最大 retries = 1
retry delay = 300ms
单次 completeRun() 调用理论最大等待 ≈ 10300ms + 本地同步开销
```

API 侧终态语义：

- run 已 terminal 时返回 no-op；
- 不重复改变 terminal 状态；
- 不重复发布 run completed event；
- activeRunId 匹配时由首次有效提交将 session run-state 收敛为 idle。

Worker `processRun()` 现有错误分支可能在一次 `finishOnce/tryFinishOnce` 失败后再执行一次 fallback 终态提交。因此在最坏情况下，完整收敛链可能调用两次 client-level `completeRun()`，每次内部最多两个 attempt：

```text
最大网络 attempts = 4
理论最大等待 ≈ 2 × 10300ms = 20600ms + 本地同步开销
```

该上限是现有 runner fallback 与本方案叠加后的验收边界。开发不得再额外增加第三层 retry。

## 重试判定合同

### 分类优先级

分类必须按以下顺序，后续条件不得覆盖已命中的前置条件：

- 已收到非 `2xx` HTTP status：status 是权威分类；错误 body 只在同一 attempt timeout 内读取并丢弃，不解析 JSON，不进入 error message，也不改变 retry 分类。
  - status 为 `502/503/504`：分别归类为 `http_502/http_503/http_504`；即使错误 body 读取立即失败，或一直挂到 timer 触发，也保持该 HTTP 分类，并按 policy 判断 retry。
  - 其他非 `2xx` status：归类为不可重试 HTTP 失败；即使错误 body 读取失败或挂到 timer 触发，也不得改成 `timeout/network`，不得发下一 attempt。
- 尚未取得非 `2xx` status：
  - request 在响应头前达到 timer，归类 `timeout`；
  - `fetch` 建连/传输失败且本地 timer 未触发，归类 `network`；
  - 已取得 `2xx` status 后 success body 一直未结束并达到 timer，归类 `timeout`；
  - `2xx` success body 非超时读取失败、JSON 解析失败或 schema mismatch，均不可重试。

### 可重试原因

只允许：

| 原因 | 规范分类 |
|---|---|
| 请求达到 policy timeout | `timeout` |
| `fetch` 建连/传输失败，且本地 timer 未触发 | `network` |
| HTTP 502 | `http_502` |
| HTTP 503 | `http_503` |
| HTTP 504 | `http_504` |

一期 `request()` 不接收 outer signal，因此 retry 分类中不存在 `cancelled` reason。用户取消由 request 返回或抛错后的 runner 现有逻辑观察，不得在 client 内假设取消已经阻止 retry。

### 不可重试

| 原因 | 处理 |
|---|---|
| HTTP 400/401/403/404/409 等 4xx | 消费/丢弃 body 后立即失败；body 问题不改变分类 |
| HTTP 500 | 消费/丢弃 body 后立即失败；body 问题不改变分类 |
| 其他非 2xx | 除 502/503/504 外均不 retry；body 问题不改变分类 |
| `ApiConflictError` | 立即失败 |
| `2xx` success body 非超时读取失败 | 立即失败 |
| `2xx` success body JSON 解析错误 | 立即失败 |
| strict schema mismatch | 立即失败 |
| warn schema mismatch | 沿用现状 warning 后返回，不 retry |
| 业务错误 | 立即失败 |

不得用错误消息字符串的模糊匹配决定业务错误是否 retry。实现必须有受控错误类型或受控错误分类函数。

非 `2xx` response body 不再用于构造业务错误 message。向上抛出的 HTTP error message 固定为 method、endpoint、status 等安全元数据；`409 + conflictAsError` 继续使用固定 `ApiConflictError`。这是为保证上游现有 raw error logger 即使打印 error，也不会间接输出服务端 body。

## Timeout 合同

单次 attempt 的 timeout 必须覆盖：

```text
开始发起 fetch
  → DNS/连接建立
  → 等待响应头
  → 读取完整成功或错误响应 body
  → JSON 解析完成
```

规范要求：

- timer 在 attempt 开始前创建；
- 同一 `AbortController.signal` 传给 `fetch`；
- timer 只能在 body 读取与 JSON 解析完成，或 attempt 已失败后清理；
- 收到响应头后不得提前清 timer；
- timeout 必须映射为项目自有 `InternalRpcTimeoutError`，不得把原生 `AbortError` 直接交给 runner；
- 超时错误必须携带有限元数据，但不得携带 request/response body。

说明：`JSON.parse` 是同步计算，AbortController 不能抢占已经进入的 CPU 同步解析；本合同要求 timer 覆盖 body 消费并在解析完成前保持有效，不承诺中断一个已经开始且阻塞事件循环的同步 `JSON.parse`。现有控制面 response 应保持可控体积；若未来出现超大 body CPU 阻塞，应另立体积治理方案。

## 取消与超时优先级

### 一期冻结选择

本次最小修复**不修改所有 `AgentApiClient` 方法签名以透传 run `AbortSignal`**。原因是该改动会扩散到 runner、tool provider、registry、plugin/MCP 管理器等多个调用层，超出最小修复范围。

因此一期合同为：

- 当前 `request()` 的请求级 controller 只负责内部 RPC timeout；
- `AgentApiClient.request()` 不接收 outer run signal，执行期间无法观察用户取消；
- 单次 attempt 最迟在 policy timeout 时结束；整个 public RPC 调用最迟在该 policy 的最大 attempts 与固定退避上限内结束；
- 用户取消不能立即 abort 已发出的 attempt，也不能保证阻止 300ms 退避或第二个 attempt；
- 调用返回或抛错后，runner 按现有 `signal.aborted` 判定用户取消；
- 本轮唯一的取消相关强保证是：当 runner 的 outer signal 实际未 aborted 时，内部 RPC timeout error 不得仅因底层 AbortController 而被误判为 `cancelled`；
- “取消后不发第二个 attempt”“retry sleep 可取消”是 outer signal 合并后的后续合同，不属于一期。

### Timeout 不得冒充取消

当前 runner 的 `isAbortLikeError()` 会把名称/消息包含 abort 的错误视为取消。为避免 timeout 被误记为 `cancelled`：

- `InternalRpcTimeoutError.name` 不得为 `AbortError`；
- 对外 message 不得使用可被 `/\babort(ed)?\b/i` 命中的措辞；
- timeout 必须进入普通失败分支，最终尝试 `completeRun("failed")`；
- 测试必须证明 timeout 不会被 runner 误判为用户取消。

后续若引入 outer signal 合并，优先级必须是：

```text
外层 signal 已 aborted → 用户取消，不 retry
否则本地 timer 触发 → timeout，可按 policy retry
```

该扩展不属于本轮完成条件。

## 运维与日志合同

### 错误对象安全合同

本轮不重构 runner/process manager 等上游现有 raw error log，但必须从源头保证 `AgentApiClient.request()` 向上抛出的错误对象是安全的：

- `message` 只包含 method、endpoint、status、attempt、timeout 等安全元数据；
- 自定义字段不得包含 request/response body、服务端 message/code、身份标识或凭据；
- 原始 network error 只允许作为 `request()` 内部局部变量参与即时分类；从 `request()` 逃逸的错误不得携带原始 `cause`、stack 拼接或可枚举引用，必须转换成安全的 network error；
- `2xx` body 读取/JSON 失败必须转换成安全的 invalid-response error，不得把原始 body 或底层异常原样向上抛；
- response schema error 继续只包含有限 path/type 摘要；
- 上游即使执行 `logger.error({err})` 或拼接 `err.message`，也不得从本轮错误对象中泄漏 payload。

因此本轮验收既检查新增 diagnostics，也检查最终抛出 error 的 message/可枚举字段。更广泛的上游日志治理仍属于后续范围。

### 日志事件

异常路径至少支持以下事件：

```text
[agent-api] timeout
[agent-api] retry
[agent-api] recovered
[agent-api] failed
```

推荐字段：

| 字段 | 说明 |
|---|---|
| `endpoint` | path 或 `responseEndpoint`，不得含 query 中的敏感值 |
| `method` | `POST` / `PATCH` |
| `policy` | 命名策略，例如 `controlRead` |
| `attempt` | 从 1 开始 |
| `attempts` | 最终失败时的总尝试次数 |
| `timeoutMs` | 单次策略值 |
| `delayMs` | retry 固定 300ms |
| `elapsedMs` | 单次或总耗时，字段语义必须固定 |
| `reason` | 受控枚举 |
| `status` | 仅 HTTP 状态码 |

禁止记录：

- request body；
- response body；
- prompt/messages/context；
- tool args/result；
- `internalToken`、API key、Provider credential；
- sessionId/runId/workspaceId；
- 完整错误 payload 或堆栈中的敏感数据。

### 正常日志

正常首尝试成功不记录日志。只有发生过 retry 且后续成功时记录 `recovered`，避免日志过量。

## 配置合同

默认值的唯一权威来源是 `apps/agent-worker/src/config/env.ts` 的 `loadWorkerEnv()`。`docker-compose.yml` 只负责把宿主环境变量透传进容器，必须使用空默认透传，不得重复写 `15000/5000`；`.env.example` 和 README 只记录/示例该权威默认，不参与运行时求值。

新增 Worker 配置：

| 环境变量 | 默认值 | 约束 | 用途 |
|---|---:|---|---|
| `AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS` | `15000` | 正整数，不允许 `0` | 读类和普通写控制面、`startSubtaskRun` 单次 timeout |
| `AWB_AGENT_COMPLETE_RUN_TIMEOUT_MS` | `5000` | 正整数，不允许 `0` | `completeRun` 单次 timeout |

配置传播必须覆盖：

- `apps/agent-worker/src/config/env.ts`；
- `apps/agent-worker/src/main.ts`；
- API worker process 对父进程环境的继承；
- `docker-compose.yml` 显式注入；
- `.env.example`；
- `docs/README.zh-CN.md` 的环境变量说明。

Docker Compose 不会自动把根 `.env` 中未列入 `services.agent-workbench.environment` 的变量放进容器，因此只修改 Worker env parser 不算配置交付完成。

## 兼容合同

- 不修改内部 endpoint method/path/schema；
- 不修改正常 response shape；
- 不修改 strict/warn validation 业务语义；
- 不修改 Provider timeout/retry 配置；
- 不修改 session/run/tool item 状态枚举；
- 不修改前端 loading/颜色映射；
- 不修改 worker concurrency 默认值。
