# 技术方案

## 总体结构

本轮在 Worker 侧形成以下最小结构：

```text
WorkerEnv
  ├─ internalRpcTimeoutMs
  └─ completeRunTimeoutMs

AgentApiClient
  ├─ 命名 RpcPolicy 常量
  ├─ request(path, options + policy)
  ├─ executeAttempt(...)
  ├─ retry 判定
  ├─ timeout/network/http 错误类型
  └─ 有限 diagnostics

public client methods
  └─ 每个方法显式绑定 policy
```

不新增跨 package 通用 RPC workspace，不修改 shared endpoint contract，不修改 API Route。

## 实体与类型设计

### `InternalRpcPolicy`

建议使用不可变命名策略：

```ts
type InternalRpcPolicyName =
  | "controlRead"
  | "controlWrite"
  | "subtaskStart"
  | "runComplete"
  | "unboundedToolExecution";

type InternalRpcPolicy = Readonly<{
  name: InternalRpcPolicyName;
  timeoutMs: number | null;
  maxRetries: 0 | 1;
  retryDelayMs: number;
}>;
```

规范：

- `controlRead.timeoutMs = internalRpcTimeoutMs`；
- `controlRead.maxRetries = 1`；
- `controlWrite.timeoutMs = internalRpcTimeoutMs`；
- `controlWrite.maxRetries = 0`；
- `subtaskStart.timeoutMs = internalRpcTimeoutMs`；
- `subtaskStart.maxRetries = 1`；
- `runComplete.timeoutMs = completeRunTimeoutMs`；
- `runComplete.maxRetries = 1`；
- `retryDelayMs = 300`；
- 排除方法不得隐式使用 `controlRead`；可继续走明确的 no-timeout/现状路径，或显式标记 `unboundedToolExecution`，具体形式由实现选择，但代码审查必须能看出它被有意排除，而不是遗漏。

不允许由 public 方法传入任意 retry 数字；策略必须集中定义，避免配置和调用点漂移。

### 请求选项

`request()` 的 options 在现有字段上增加命名 policy：

```ts
type InternalRpcRequestOptions = {
  method: "POST" | "PATCH";
  body: unknown;
  policy: InternalRpcPolicy;
  conflictAsError?: boolean;
  responseSchema?: TSchema;
  responseEndpoint?: string;
};
```

每个 public method 必须显式传 `policy`。不得提供一个会导致无限等待的省略默认值。

### 错误类型

必须定义等价于以下合同的受控错误类型；类名可以调整，但字段和安全语义不得弱化：

```ts
class InternalRpcTimeoutError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_TIMEOUT";
  readonly endpoint: string;
  readonly method: "POST" | "PATCH";
  readonly timeoutMs: number;
  readonly attempt: number;
}

class InternalRpcHttpError extends Error {
  readonly code = "AGENT_INTERNAL_RPC_HTTP_ERROR";
  readonly status: number;
  readonly endpoint: string;
  readonly method: "POST" | "PATCH";
}
```

错误安全合同：

- `InternalRpcHttpError.message` 固定为 method、endpoint、status 等安全元数据，不包含 response body、服务端 message/code；
- 原始网络异常只允许在 `request()` catch 内作为局部变量即时分类；从 `request()` 逃逸前必须转换成安全的 `InternalRpcNetworkError` 或等价错误，不得挂载原始 `cause` 或拼接原始 stack/message；
- `2xx` success body 读取失败或 JSON 解析失败必须转换成安全的 `InternalRpcInvalidResponseError` 或等价错误，只包含 method/endpoint/stage；
- 所有从 `request()` 逃逸的自定义错误字段都不得包含 request/response body、服务端 message/code、身份标识、凭据或原始异常引用；该限制用于保护上游现有 `logger.error({err})` / `err.message` 路径。

`InternalRpcTimeoutError` 必须满足：

- `name` 不等于 `AbortError`；
- message 不包含 `abort` / `aborted`；
- runner 的 `isAbortLikeError()` 返回 false；
- message 只含 method、endpoint、attempt、timeout，不含 body/身份字段。

### Retry reason

```ts
type InternalRpcRetryReason =
  | "timeout"
  | "network"
  | "http_502"
  | "http_503"
  | "http_504";
```

`classifyRetryReason(error)` 返回上述枚举或 `null`。不得返回任意服务端 message。

## `AgentApiClient` 构造参数

在现有参数上增加：

```ts
{
  apiOrigin: string;
  internalToken: string;
  responseValidation?: "strict" | "warn";
  internalRpcTimeoutMs: number;
  completeRunTimeoutMs: number;
  logger?: Pick<Console, "warn">;
  // 测试 seam 可选：fetchFn / nowMs / sleepFn
}
```

最小生产实现可继续使用全局 `fetch`、`Date.now`、`setTimeout`。为了测试稳定，建议注入以下 seam 中至少一种：

- `fetchFn`；
- `sleepFn`；
- 极短 timeout 构造参数。

不得为了测试引入通用 dependency injection 框架。

## 配置设计

### `WorkerEnv`

新增：

```ts
internalRpcTimeoutMs: number;
completeRunTimeoutMs: number;
```

`loadWorkerEnv()`：

`loadWorkerEnv()` 是两个默认值的唯一运行时权威：

```text
AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS，默认 15000
AWB_AGENT_COMPLETE_RUN_TIMEOUT_MS，默认 5000
```

两者使用正整数解析：

- `0` 非法；
- 负数非法；
- 非数字非法；
- 非法时 worker 启动失败并给出变量名；
- 不静默改为默认值；
- 本轮不新增 max cap，除非现有 env 风格要求；若实施时决定增加 cap，必须更新本文和测试。

### 配置传播

API 的 worker manager 使用 `{...parentEnv}` 构建 child env，所以容器内变量会自然传给 worker 子进程。但 Docker Compose 只注入 `environment` 中显式列出的变量。因此必须同步：

```text
apps/agent-worker/src/config/env.ts
docker-compose.yml
.env.example
docs/README.zh-CN.md
```

`apps/agent-worker/src/main.ts` 必须把两个配置传给 `AgentApiClient`。

`docker-compose.yml` 必须使用 `${AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS:-}` / `${AWB_AGENT_COMPLETE_RUN_TIMEOUT_MS:-}` 只透传值，不得在 Compose 重复写 `15000/5000`。`.env.example` 可以给出显式示例值，README 可以记录默认值，但二者都不是运行时默认源。

不要求 API `loadEnv()` 新增字段，因为 API 不消费数值，只将父环境继承给 child。若当前项目配置规范要求所有变量都进入 API env schema，API 层也只能透传原始字符串，不得定义、解析或回退另一套默认。

## 单次 Attempt 生命周期

### 分类状态

单次 attempt 必须至少维护 `knownHttpStatus: number | null` 和 `localTimedOut: boolean`。`knownHttpStatus` 一旦记录非 `2xx` status，其分类优先级高于后续错误 body 读取异常和 timer 状态。

建议流程：

```text
attemptStart = now
controller = new AbortController
localTimedOut = false
start timer
  timer:
    localTimedOut = true
    controller.abort()
try
  response = await fetch(url, {signal: controller.signal, ...})

  if !response.ok
    knownHttpStatus = response.status
    try await response.text() // 只消费并丢弃，不 JSON.parse，不用于 message
    catch ignoreBodyFailureForClassification
    if conflictAsError && knownHttpStatus == 409
      throw ApiConflictError("context conflict")
    throw InternalRpcHttpError(knownHttpStatus, safe metadata only)

  try
    parsed = await response.json()
  catch bodyOrJsonError
    if localTimedOut
      throw InternalRpcTimeoutError
    throw InternalRpcInvalidResponseError(method, endpoint, "body-or-json")
  validate schema
  return parsed
catch err
  if knownHttpStatus != null
    if conflictAsError && knownHttpStatus == 409
      throw ApiConflictError("context conflict")
    throw InternalRpcHttpError(knownHttpStatus, safe metadata only)
  else if localTimedOut
    throw InternalRpcTimeoutError
  else if err is controlled HTTP/conflict/invalid-response/schema error
    throw err
  else
    throw InternalRpcNetworkError(safe metadata only)
finally
  clear timer
```

关键要求：

- timer 不能在 `fetch()` resolve 后清理；
- `response.text()` 与 `response.json()` 必须在 timer 生命周期内；
- `localTimedOut` 只用于确认本地 timer 是否触发；一期没有 outer signal，不能由该字段推导用户取消；
- 超时后必须 abort 底层 fetch，不能只用 `Promise.race` 丢弃结果；
- `catch` 的归一化优先级必须固定：
  - `knownHttpStatus != null`：无论错误 body 是立即读取失败还是因 timer 中止，都抛 `InternalRpcHttpError(knownHttpStatus)`；502/503/504 可 retry，其他 status 不 retry；
  - `knownHttpStatus == null && localTimedOut`：抛 `InternalRpcTimeoutError`；
  - `2xx` body 非超时读取/JSON 失败：抛安全的 `InternalRpcInvalidResponseError`，不 retry；
  - 其余 fetch/transport error：转换为安全的 `InternalRpcNetworkError`；既有确定性 typed error 保持自身分类；
- `2xx` response body 挂起到 timer 时，不以 2xx status 做 HTTP retry 分类，必须归类 timeout；
- 非 `2xx` body 只消费以利于连接清理，不解析 JSON、不进入 error message。body hang 由同一 timer abort；status 分类保持不变。

## Retry 循环

建议在 `request()` 内按 attempt 实现：

```ts
for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
  try {
    const result = await executeAttempt(...);
    if (attempt > 1) logRecovered(...);
    return result;
  } catch (error) {
    const reason = classifyRetryReason(error);
    const canRetry = reason != null && attempt <= policy.maxRetries;
    if (!canRetry) {
      logFinalFailure(...);
      throw error;
    }
    logRetry(...);
    await sleep(300);
  }
}
```

要求：

- `maxRetries=1` 表示最多两个 attempt；
- retry 使用同一 path/method/body/headers/schema/conflict 设置；
- 不重新生成业务 payload；
- 每个 attempt 使用新的 AbortController 与 timer；
- 总耗时日志从第一次 attempt 开始累计；
- schema mismatch、JSON error、4xx、500 的 `reason=null`；
- `ApiConflictError` 必须在 typed HTTP retry 判定前保留现有语义。

## HTTP 错误处理兼容性

当前非 2xx 错误可能包含服务端 message/code。本轮有意收紧该内部错误合同：为了保证新增 diagnostics 和上游既有 raw error log 都不泄漏 response body，非 `2xx` body 不再进入向上抛出的 error message/code。

冻结规则：

- `InternalRpcHttpError.message` 固定为 `internal rpc failed: <METHOD> <endpoint> status=<N>` 或等价安全元数据文本；
- 自定义字段只允许 method、endpoint、status、policy/attempt 等安全元数据；
- retry diagnostics 只记录 status/reason，不记录原始 cause；
- `409 + conflictAsError` 仍抛 `ApiConflictError("context conflict")`；
- 所有非 `2xx` body 均不 JSON.parse；
- 502/503/504 即使 body 读取失败或挂起，也按 status 可 retry；
- 其他 status 即使 body 读取失败或挂起，也按 status 不 retry。

如果现有测试精确断言包含服务端 body 的错误文本，实施必须有意识迁移为上述安全合同；不得为了兼容旧文本重新把 body 放入 error message。

## Response validation

保持现状：

- 先成功读取并解析 JSON；
- 有 schema 时执行 `Value.Check`；
- strict：抛 schema validation error；
- warn：记录有限 warning，返回 parsed body。

validation 不参与 retry，因为它表示服务端响应已到达且合同不匹配。

## Policy 绑定设计

### `controlRead`

绑定以下方法：

```text
getExecutionProfile
getPromptContext
getMessagesContext
getSubtaskPreforkPlan
getSubtaskStatus
getSubtaskResult
getAgentMcpSettings
getPluginRuntimeSnapshots
listPluginTools
```

### `controlWrite`

绑定：

```text
createContextItem
updateContextItem
updateRunState
compactContext
```

### `subtaskStart`

只绑定：

```text
startSubtaskRun
```

### `runComplete`

只绑定：

```text
completeRun
```

### 排除方法

保持现状且不得误套策略：

```text
archiveSearch
archiveRead
executePluginTool
prepareGitEnvForBash
cleanupGitEnvLease
```

### 外围读取纳入依据

以下分类已经基于当前代码冻结：

- `getAgentMcpSettings` → API `getAgentMcpSettings()`：配置快照读取，不连接/执行 MCP server；
- `getPluginRuntimeSnapshots` → API `listPluginRuntimeSnapshots()`：runtime snapshot 读取，不执行 plugin tool；
- `listPluginTools` → API/plugin-host `listTools`：只读工具定义发现，下游已有 4 秒 timeout，不调用 `executeTool`。

P0 必须确认调用仍符合上述事实，但不得把该确认写成开发者可自由重分类的选择。如果代码已实质变化，暂停并更新本设计；在更新前不得实现。

## `startSubtaskRun` Retry 设计

API 侧现有链路：

```text
findChildByParentTool(workspaceId, parentRunId, parentToolItemId)
  → existing: ensure request/session matches, return reused
  → missing: materialize/activate child
  → parent tool unique conflict: find winner, return reused
```

Worker retry 要求：

- 原 request 对象语义不变；
- `parentRunId`、`parentToolItemId` 不变；
- prefork summary/meta 不重新生成；
- 首次成功但响应丢失时，第二次返回同 child；
- `reused=true` 后走现有 status polling，不递归重复执行 child。

建议集成测试模拟“服务端完成创建但客户端未收到首个响应”。不能只测试 503 后再次创建，因为那不能证明提交不确定场景的幂等性。

## `completeRun` Retry 与 Runner fallback

API 侧：

```text
run missing/mismatch → no-op false
run already terminal → no-op false
首次有效完成 → update run terminal
                  → active run-state idle
                  → application 清 cache、发布一次 event
```

Worker 侧：

- `finishOnce()` 防止同一时刻并发提交；
- client 内部最多两个 attempt；
- client 最终失败抛 `TerminalStatusSubmitError`；
- `processRun` catch 可能通过 `tryFinishOnce(fallbackStatus)` 再调用一次 client；
- 不在本轮删除或重构该 fallback。

测试必须断言：

- 单次 client 调用最多两个 client 逻辑 attempt；
- runner 完整错误收敛最多四个 client 逻辑 attempt；
- client 逻辑 attempt 指进入 `fetch`、受本地 timer 约束并完成分类的一次调用。短 timeout 可在请求写入完成、服务端 handler 收到请求前 abort，因此 server handler 的可观测请求数只能断言不超过逻辑 attempt 上限，不能反推逻辑 attempt 数；
- 第一次服务端已 terminal 但响应丢失时，后续 retry/fallback 不重复发布 event；
- 全部失败后 `processRun` 最终返回，不永久占槽。

## 取消语义

一期不新增 outer signal 参数。技术实现必须：

- 不把本地 timeout 的原生 `AbortError` 暴露给 runner；
- timeout error 不包含 abort 字样；
- helper 不承诺取消期间停止当前 attempt、300ms sleep 或第二个 attempt；
- 整个 public RPC 调用只按 policy timeout/maxAttempts 保证有界；
- 调用层原有 `signal.aborted` 检查保持，在 request 返回后决定 run cancelled；
- 测试必须在 outer signal 未 aborted 的前提下证明 timeout error 不会仅因底层 controller 被判为 cancelled；
- 不修改 `runner.ts` 的 `isAbortLikeError()` 作为快速规避手段，除非 error normalization 无法满足上述条件且已重新评审范围。

后续 outer signal 合并建议见 `08-follow-up-recommendations.md`。

## Diagnostics 设计

当前 logger 类型为 `Pick<Console, "warn">`。最小实现建议继续只依赖 `warn`，避免扩大 logger 接口：

- timeout：`warn`；
- retry：`warn`；
- recovered：`warn`；
- final failed：`warn`。

若希望 recovered 使用 `info`，必须同步扩展 logger typing 和测试；不属于必须项。

推荐使用结构化键值文本或 logger object，但必须与当前 logger 能力兼容。例如：

```text
[agent-api] retry endpoint=/api/internal/agent/prompt-context method=POST policy=controlRead attempt=2 delayMs=300 reason=timeout
```

错误日志构造函数只能接收安全元数据，不接收 `options.body`、response body 或原始 error object。

## 测试 seam

`apiClient.test.ts` 当前使用本地 HTTP server。建议扩展 helper 支持：

- 永不结束响应；
- 发送 headers 后不结束 body；
- 第一次 503、第二次 200；
- 第一次服务端记录提交但断开/不结束响应；
- 记录 attempt 数量；
- 捕获 warning 字符串。

测试使用 20ms–50ms 注入 timeout，不等待生产 15s/5s。

server cleanup 必须主动销毁未完成 socket，避免 `server.close()` 因 hanging connection 导致测试套件本身卡死。

## 并发与资源清理

- 每次 attempt 的 timer 必须在 `finally` 清理；
- retry 前上一 attempt 的 fetch/body 必须已因 abort/reject 结束；
- 不得留下未处理 Promise rejection；
- 测试必须证明超时后 server/socket 可关闭；
- request body 只序列化一次或每次稳定序列化，不得因 retry 修改对象；
- 正常成功后不得残留 timeout timer 导致进程不能退出。

## 数据库与实体边界

本轮不新增数据库实体、表或字段。相关既有实体只作为 retry 安全依据：

- run record 的 terminal status；
- session run-state 的 `activeRunId/status`；
- subtask run 的 `parentRunId/parentToolItemId`；
- context item 的 terminal fence；
- run completed event 的首次有效发布。

开发不得以本方案为由修改这些实体定义。

## 性能边界

- 首次成功路径只增加 controller/timer 的常数开销；
- 正常路径不输出新增日志；
- retry 仅在受控异常发生；
- 读类最坏两个请求，不引入无限重试；
- 不增加全局后台定时器或扫描任务。
