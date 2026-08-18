# 技术设计

## 目标目录与 exports

新增源文件：

```text
packages/shared/src/internal-contracts/
  endpoints.ts
  errors.ts
  agent-worker.ts
```

`packages/shared/package.json` 已使用 `exports`（当前 `:8-20`），应增加三个显式子路径：

```text
./internal-contracts/endpoints
./internal-contracts/errors
./internal-contracts/agent-worker
```

每个子路径的 `types` 指向对应 `dist/internal-contracts/*.d.ts`，`default` 指向对应 `.js`。不使用通配符，不从 `src` 路径绕过 package exports，不从根 `.` 导出 internal contracts。

现有 `packages/shared/tsconfig.json:1-18` 的 `rootDir: src`、`outDir: dist`、declaration 输出会生成对应文件；修改后必须验证 shared build 后 API/Worker 的 typecheck 和运行时解析。TypeBox 的 schema 对象本身不执行校验，Worker Server 必须在运行时调用项目选定的 TypeBox validator；不能把 TypeScript 类型断言当作 request validation。当前依赖已提供 `@sinclair/typebox/value` 的 `Value.Check`/`Value.Errors`，第一选择是直接使用它，不新增验证依赖。

## `endpoints.ts`

集中定义当前真实路径和 method，示意：

```ts
export const AgentWorkerEndpoints = {
  health: { method: "GET", path: "/internal/health" },
  enqueueRun: { method: "POST", path: "/internal/runs/enqueue" },
  cancelSession: { method: "POST", path: "/internal/runs/cancel-session" }
} as const;
```

该文件不负责 HTTP server、fetch、socket、重试或错误转换。API Client 和 Worker Server 都引用它。

## `errors.ts`

定义最小可复用错误形状：

```ts
export type InternalErrorPayload = {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
  requestId?: string;
};
```

第一阶段至少提供请求非法、未鉴权和内部处理失败所需的稳定 code 常量。不要把 `HttpError`、Fastify error handler 或 Worker 业务错误类放进 shared。

Worker Server 仍可在边界把现有错误转换成当前 status；API Client 仍可把 enqueue 失败映射为现有 503。共享错误类型不应迫使全局错误系统重写。

## `agent-worker.ts` schema 边界

### 基础成功响应

```ts
const WorkerOkResponseSchema = Type.Object({
  ok: Type.Literal(true)
});
```

导出 endpoint 语义明确的 response schema 或类型别名。不要加入 protocol version、service name 或 data 字段。

### Health

- request：GET 无 body；如项目实现需要，可定义空 request 类型，但不伪造 JSON body。
- response：`{ ok: true }`。

### Enqueue request

核心字段用严格 schema：

```text
workspaceId: string
sessionId: string
runId: string
workspacePath: string
inputText: string | null | 缺失
```

`workspaceRepoDirNames` 必须保留宽松输入边界，建议在 schema 中使用 `Type.Optional(Type.Unknown())` 或等效允许缺失/任意 JSON 的定义；然后继续调用现有 `normalizeWorkspaceRepoDirNames`。schema 不得直接要求 `string[]`。

该设计不是放弃安全：路径名清洗、去重、路径片段过滤和数量限制仍由现有归一化函数执行；schema 只负责不改变既有兼容语义地保护核心字段。

### Enqueue response

```text
HTTP 202
{ ok: true }
```

### Cancel request

```text
sessionId: string
```

### Cancel response

```text
HTTP 202
{ ok: true }
```

## 请求校验

Worker Server 当前在 `apps/agent-worker/src/server.ts` 中解析 JSON。迁移时应把 `unknown` JSON 先交给共享 schema 校验，再把校验后的结构传给现有归一化和 Runner 调用。优先复用 TypeBox 已有的运行时校验能力；若当前依赖暴露方式不适合 Worker，允许在 `packages/shared` 内提供一个极薄的 schema-check 辅助函数，但不得引入第二套业务 schema 或大型 RPC 框架。校验失败应在内部日志或诊断信息中保留可诊断的字段错误；对既有 HTTP endpoint 仍遵守 message-only body 合同。

请求校验失败：

- JSON 已成功解析但 enqueue/cancel 字段结构非法：返回当前 400 message-only body。
- malformed JSON：`JSON.parse` 失败继续由外层 catch 处理，返回当前 500 message-only body；本次不改为 400。
- 两类错误都不调用 Runner。
- 不改变成功响应或业务处理。
- 鉴权仍在 schema 校验前执行。

不要把 schema 校验复制到 `AgentRunner` 或 API Service；业务层继续处理已经过边界处理的数据。`Value.Errors` 的字段路径应进入内部日志或可诊断的错误 message，但不应把完整输入 payload 写入日志。

## 响应校验

API Client 当前在 `apps/api/src/modules/agent/agent.worker-client.ts` 中同时支持 Unix Socket 和 fetch。迁移时保持两种传输方式的路径、header、timeout 和 status 判断一致；将成功 body 解析为 JSON，并在关键 response 上执行 schema 校验。

### strict

- response 不是合法 `{ ok: true }` 时视为本次调用失败。
- enqueue 沿用现有日志和 `HttpError(503, "agent worker unavailable")` 映射。
- cancel 沿用 warning/best-effort 语义。

### warn

- response schema 失败时输出带 endpoint 的结构化 warning。
- 继续沿用当前调用返回语义。
- 仅放宽 response schema 失败；非 2xx、超时、鉴权失败、JSON 无法解析等仍按原错误流程处理，除非实现明确将其归类为 response validation failure。

对于 `health`，实际消费者是 `AgentWorkerProcessManager.waitUntilReady()`（`agent.worker-manager.ts:175-217`），不是 `AgentWorkerClient`。因此 1A 的最终决策是：Worker Manager ready probe 仍只以 2xx status 判定 ready，不解析或校验 health body，不接入 strict/warn，也不改变 Socket/fetch 的 timeout、等待和 retry/restart 语义。本次只统一 health path 常量，并可在独立 Worker Server/schema 测试中校验成功 body `{ ok: true }`。这样可以避免为了 health body 校验扩大 Manager 改造风险。

## 配置

在 `apps/api/src/config/env.ts` 的 `Env` 和 `loadEnv` 中增加：

```text
internalRpcResponseValidation: "strict" | "warn"
```

读取 `AWB_INTERNAL_RPC_RESPONSE_VALIDATION`：

- 未设置：`strict`。
- `strict`/`warn`：接受。
- 其他值：抛出明确配置错误。

该值由 API 注入 AgentWorkerClient；不注入 Worker，不写数据库，不进入 Settings。

配置是临时迁移保险丝，稳定后删除，不应扩展为通用 feature flag。

## 错误处理

本次不引入 `ok/data/error` envelope。Worker 当前错误 status 和 HTTP body 继续保持现状：401/400/404/500 为 message-only 兼容形式，malformed JSON 仍为 500。`errors.ts` 的 `code`、`message` 只作为内部错误模型、日志字段和未来可安全新增路径使用，不把 code 写入本次既有 HTTP error body。API Client 的 enqueue/cancel 对外转换逻辑保持不变。

## 传输不变性

不得修改：

- Unix Socket 优先逻辑
- TCP/HTTP fallback
- `x-awb-agent-internal-token` header
- request timeout
- Worker concurrency
- Worker restart/backoff/circuit breaker
- Worker 启停顺序
- `AgentRuntimePort` 的业务接口

## 兼容迁移伪流程

```text
shared build
  -> 导出 internal schema/path
  -> Worker Server 鉴权
  -> parse unknown JSON with shared request schema
  -> preserve normalizeWorkspaceRepoDirNames
  -> call existing Runner
  -> return existing status/body

API Worker Client
  -> use shared endpoint path
  -> send unchanged payload/header/timeout
  -> check existing status
  -> parse critical success body with shared response schema
  -> map errors with existing enqueue/cancel semantics
```
