# 技术设计

## shared 目录与 package exports

新增文件：

```text
packages/shared/src/internal-contracts/
  agent-api.ts                 # 唯一公开聚合入口
  agent-api-run.ts             # 内部：run-state / run-complete
  agent-api-context.ts         # 内部：context item / compact
  agent-api-subtask.ts         # 内部：prefork/start/result/status
```

`agent-api.ts` 只做明确 re-export，统一暴露：endpoint registry、path builder、request/params/response TypeBox schema、`Static<>` 类型、必要的稳定 subtask code 常量。领域文件不得单独加入 `package.json.exports`，也不从 `packages/shared/src/index.ts` 根入口导出。

`packages/shared/package.json` 只增加：

```json
"./internal-contracts/agent-api": {
  "types": "./dist/internal-contracts/agent-api.d.ts",
  "default": "./dist/internal-contracts/agent-api.js"
}
```

保留 1A 的 `endpoints/errors/agent-worker` 子路径。不得使用通配 exports 或从 `src` 深路径绕过 exports。shared build 后必须实际存在 `.js` 和 `.d.ts` 并被 API/Worker typecheck/运行时解析。

## endpoint registry 与 schema 组织

建议将 registry 以单一常量定义，方法固定为字面量：

```ts
export const AgentApiEndpoints = {
  updateRunState: { method: "POST", path: "/api/internal/agent/run-state" },
  completeRun: { method: "POST", path: "/api/internal/agent/run-complete" },
  createContextItem: { method: "POST", path: "/api/internal/agent/context-items" },
  updateContextItem: {
    method: "PATCH",
    path: (itemId: number) => `/api/internal/agent/context-items/${itemId}`
  },
  compactContext: { method: "POST", path: "/api/internal/agent/context/compact" },
  getSubtaskPreforkPlan: { method: "POST", path: "/api/internal/agent/subtask/prefork-plan" },
  startSubtask: { method: "POST", path: "/api/internal/agent/subtask/start" },
  getSubtaskResult: { method: "POST", path: "/api/internal/agent/subtask/result" },
  getSubtaskStatus: { method: "POST", path: "/api/internal/agent/subtask/status" }
} as const;
```

path builder 必须校验/接收已被 route params schema 约束的 `itemId`；不得在 Worker 拼接硬编码 path。共享契约不承担 fetch、Fastify、鉴权、retry、日志或业务错误转换。

每个 endpoint 需成对定义 request/params/success response schema，并导出 `Static` 类型。`OkResponseSchema` 可复用为 `Type.Object({ ok: Type.Literal(true) })`，但 context item response 必须精确为：

```ts
Type.Object({
  ok: Type.Literal(true),
  item: AgentContextItemRecordSchema
})
```

Context compact 成功响应必须精确表达真实形状：

```ts
Type.Object({
  compacted: Type.Boolean(),
  summaryItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
  archivedCount: Type.Number({ minimum: 0 })
})
```

不得误建为 `{ok:true}`。

## schema 细节

### Run

- `run-state`: `workspaceId/sessionId` 非空，`status: idle|running`，`activeRunId` 与 `activeAssistantItemId` 可 null，`lastResponseTotalTokens`、`runNoticeText`、`updatedAt` 保持 optional/null 语义。
- `run-complete`: `workspaceId/sessionId/runId` 非空，`status: completed|failed|cancelled`，`updatedAt` optional。
- 成功响应均是 literal `{ok:true}`。

### Context

- create 字段与 Route 当前一致：`workspaceId`、`sessionId`、`runId|null`、`turnId|null`、`step|null`、`prevId|null`、kind、status、`output`、optional `createdAt`。
- update params 是 `{ itemId: number >= 1 }`；body 仅包含 optional `status`、`output`、`updatedAt`，不为 update 凭空加入 workspace/session。
- create 与 update 的 `output` 都改用 `AgentContextItemOutputSchema`（update 保持 `Type.Optional(...)`）。这使合法 output 得到统一校验；tool `args/result` 的 `Type.Any()` 仍允许动态内容。
- create/update success 包装完整 `AgentContextItemRecordSchema`；Worker 可只返回/消费 `.item.id`，但 Client 必须验证完整 record。

### Compaction

请求必须保持：`workspaceId`、`sessionId`、`runId`、`expectedHeadItemId:number|null`、非空 `summaryText`。成功 response 为 `compacted`、`summaryItemId:number|null`、`archivedCount:number>=0`。不要添加 archive file path、`applied` 或统一 conflict code。

### Subtask

- prefork-plan：`workspaceId`、`parentSessionId`、`parentRunId`、`parentToolItemId>=1`、`agentId`、optional number `thresholdPct`；response 包含 `shouldPrefork`、归一的 integer `thresholdPct 50..99`、`parentLastResponseTotalTokens:number|null`、child window 与 threshold tokens。
- start：精确保留 workspace、parent identity、description、prompt、agentId、`new|existing|fork` session union、optional prefork summary/meta；response 为五字段 identity/reuse record。
- result/status：均接收 `workspaceId/sessionId/runId`；response 分别是 `{resultText}` 与既有 terminal/running status union。
- `preforkMeta` 保持 `additionalProperties:false`；当前 Fastify/AJV 运行时会剥离其未知字段。
- `session` 的 `new`/`fork` member object 不加 strict 属性限制，所以额外 `sessionId` 通过 schema 并由 Service 返回 `AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED`。`existing` member 的 `sessionId` 必须保持 required：缺失时 union 不匹配，Route 在 handler 前返回 schema validation `400`。
- `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED` 仍可作为 Service 防御性 code 共享/测试，但不能被建模为普通 HTTP Route 缺失 `existing.sessionId` 时的 response。

共享 error code 常量只能覆盖已确认的 stable subtask code；不把 `HttpError`、Fastify `ErrorResponseSchema`、`ApiConflictError` 或全局 envelope 放入 shared。API 仍可保留当前 `{message,code}` error body。

## API Route 与 Service 迁移

每批 Route 将 inline TypeBox schema 替换为 shared schema，并用 shared `Static` 类型接收 `req.body`/`req.params`。Route 仍负责：schema 声明、handler 内 `assertInternalToken()`、把协议输入显式映射给 Service、返回现有响应。不得用 `as any` 将 `output` 绕开新 schema。

Service 不必被迫以 HTTP type 为唯一参数类型：

```text
shared HTTP input -> Route 显式映射 -> 既有业务 input / Service
```

只有完全等价且无业务重整时才可直接使用 shared type。Service 的归属校验、CAS、terminal ignored、transaction、artifact、subtask depth 和 session 不变量全部保留；Runner 也不复制 route validation。

Fastify schema-first 顺序必须原样保留。不得将 `assertInternalToken` 移入 hook，或为“更安全”改变无效 token+无效 body 的 status。

## Worker `AgentApiClient` 迁移与成功响应校验

将 `request` 发展为接受共享 endpoint definition 和 success schema 的泛型辅助函数；保持当前 fetch URL、`x-awb-agent-internal-token`、JSON body、无新增 timeout/retry 的 transport 行为。

伪流程：

```text
fetch(endpoint.path, endpoint.method, body)
  -> conflictAsError && status === 409 ? ApiConflictError("context conflict")
  -> !2xx ? 保持当前 raw-body Error 路径
  -> response.json()（失败必定抛错，不可 warn）
  -> Value.Check(successSchema, parsed)
  -> valid：返回 typed body
  -> invalid + strict：抛出 response validation error
  -> invalid + warn：logger.warn(endpoint + Value.Errors 摘要)，返回 parsed as typed body
```

warning 应包含 endpoint/method 和有限 schema error 摘要，不得打印完整 request/response payload、token、prompt 或 tool result。warn 的 `as typed` 仅限通过上述三条件的过渡路径；不应传播为普通业务层 `any`。

保留当前 non-2xx parser 的真实效果：不要在重构时把它意外修好。Subtask 调用不传 `conflictAsError`；只有 context create 与 compact 传入。

## 配置传播

1A 已在 API `loadEnv()` 解析此变量；1B 补全 Worker 侧链路：

```text
API loadEnv()
  -> AppContext.agentWorkerResponseValidation
  -> AgentWorkerProcessManager constructor
  -> child_process spawn env 显式覆盖
     AWB_INTERNAL_RPC_RESPONSE_VALIDATION=<normalized strict|warn>
  -> Worker loadWorkerEnv()
  -> WorkerEnv.responseValidation
  -> new AgentApiClient({ apiOrigin, internalToken, responseValidation, logger })
```

规则：

- API/Worker 独立启动时缺失值默认 `strict`；非法值均 fail-fast，错误信息明确指出变量与允许值。
- API Manager 传给 child 的值必须是 API 已规范化的值，不能依赖 `...process.env` 偶然继承；即使父环境变量为非法原值，也必须被显式覆盖。
- 不进入数据库、Settings、插件配置或公共 feature flag 系统。
- 该配置仍是临时迁移保险丝；后续整体稳定后移除，而不是扩展到 read-side/Plugin Host。

`main.ts` 将 WorkerEnv 的 `responseValidation` 和 logger（当前可用 `console`）传给 `AgentApiClient`。不改变 Worker Manager 健康探针、启动顺序、并发、socket/TCP 优先逻辑、restart/backoff/circuit breaker。

## 迁移不变量与失败处理

- shared build、API 与 Worker typecheck 是每批最低前置检查；schema runtime validation 要使用已有 TypeBox `Value.Check`/`Value.Errors`，不能仅依赖 TypeScript 断言。
- API success response schema 同样应避免把 `ok` 放宽为 boolean，以免 Server serialization 与 Client validation 定义不一致。
- conflict/error response 不接入 success strict/warn。Compaction 两种 `409` 与 subtask code/error body 保持业务层现实。
- 任何公共 schema 修改、合法 Worker output 不通过、Route serializer 与共享 response 不一致、配置传播无法显式覆盖，均触发暂停条件（见 [03-decisions.md](./03-decisions.md)）。
