# Route 分组目标设计

## 分组原则

最终 route 结构按调用方和责任主导规则分组：

- UI/public：按用户用例与核心职责域；
- Worker internal：按 Shared contract 与已建立职责域；
- Peripheral internal：Plugin/MCP/Channel 与 Feishu 等外围 adapter；
- Status/SSE：独立承载事件流 transport 生命周期。

不得按 HTTP method、鉴权方式、URL 都含 `/internal/agent` 或文件行数机械分组。

## 建议文件结构

文件名可以微调，以下职责边界必须保持：

```text
routes/
  agent-public-session.routes.ts
  agent-public-context.routes.ts
  agent-public-control.routes.ts
  worker-read-side.routes.ts
  worker-writeback.routes.ts
  worker-lifecycle.routes.ts
  worker-subtask.routes.ts
  worker-compaction-archive.routes.ts
  peripheral-agent.routes.ts
  peripheral-plugin.routes.ts
  agent-status-sse.routes.ts
  agent-route-auth.ts
  register-agent-routes.ts
```

可合并相邻小文件，但每个注册函数必须只接收所需最小能力。例如 SSE 组不应接收 Session application，Worker writeback 组不应接收 plugin host。

## 端点归属真值表

### UI / public

| 端点 | 目标调用能力 |
|---|---|
| `GET /api/agent/sessions` | SessionInteraction.list |
| `POST /api/agent/sessions` | SessionInteraction.createPrimary |
| `POST /api/agent/sessions/fork` | SessionInteraction.forkPrimary |
| `GET .../context-items` | ContextQuery.listContextItems |
| `GET .../context-items/:itemId` | ContextQuery.getContextItem |
| `GET .../apply-patch-artifact` | ContextQuery.readApplyPatchArtifact |
| `GET .../write-artifact` | ContextQuery.readWriteArtifact |
| `GET .../run-state` | ContextQuery.getRunState |
| `POST .../messages` | SessionInteraction.sendMessage |
| `POST .../compact` | ManualCompactionApplication |
| `POST .../clear` | CompactionArchiveApplication |
| `POST .../revert` | SessionInteraction.revert |
| `POST .../cancel` | RunLifecycleApplication.cancelSession |

### Worker internal contract

继续优先使用 `AgentApiEndpoints` method/path/schema/type：

| 组 | 端点/能力 |
|---|---|
| Read-side | execution profile、messages context、prompt context |
| Context Writeback | create/update context item |
| Run Lifecycle | update run state、complete run |
| Subtask | prefork/start/result/status |
| Compaction/Archive | compact context、archive search/read；manual internal compact 可放该组 |

`single-call-model-profile` 当前不是 Shared registry endpoint，但语义属于 Worker/read-side 辅助入口，应放 read-side internal group；本阶段不强行统一 contract。

### Peripheral internal

| 子组 | 端点 | 唯一 application owner |
|---|---|---|
| Plugin/MCP operational | mcp settings、plugin runtime snapshots、plugin tools list/execute、channel allowlist | 既有外围 adapter/facade edge |
| Feishu/IM Session command | primary session create、run trigger | `SessionInteractionApplication` |
| Feishu/IM Context query | session status summary、context tail | `ContextQueryApplication` |
| Feishu/IM Peripheral query | recent sessions、recent workspaces、run final text、agents list | `PeripheralAgentQueryApplication` |

分组规则：

- route 文件按外围调用方聚合不改变 application owner；
- context tail 是 transcript tail query，必须调用 `ContextQueryApplication`；
- status summary 是 session/run projection，必须调用 `ContextQueryApplication`；
- recent sessions/workspaces、run final text、available agents 必须调用 `PeripheralAgentQueryApplication`；
- `PeripheralAgentQueryApplication` 不得通过持有完整 `ContextQueryApplication` 代转 status/tail；
- 外围 route/adapter 不得拿到核心组件 private state 或完整 `AppContext`。

### Status / SSE

- `GET /api/internal/agent/events/sse` 独立注册；
- route 负责 internal token、response headers、hijack、heartbeat、subscribe/unsubscribe 和 socket close cleanup；
- event hub 是 transport dependency，SSE route 不含 run completion 业务规则；
- `toSseEventChunk` 保持既有 event id/type/data 格式。

## Route handler 允许与禁止

### 错误映射总规则

- application 可以直接抛 `HttpError`，并拥有业务错误的 status/message/code 映射；
- route 默认只做 schema、auth、params/body/query parse 和 success status；
- route 只保留已冻结的 generic bridge，例如 status summary 将非 `HttpError` 的未知错误映射为 `500 SESSION_STATUS_SUMMARY_FAILED`；
- plugin host unavailable、archive read/search 现有 transport bridge 继续按既有 endpoint 语义保留；
- 不引入“route 统一翻译 domain error”的新层，也不允许同层级错误一部分由 application、一部分由 route 随意映射。

### 允许

- method/path/schema/tags；
- body/query/params 类型收窄；
- preValidation 与 body-key 白名单；
- internal token、plugin caller/header-body identity 校验；
- success HTTP status 与已冻结 generic/transport bridge；
- SSE transport 管理；
- public/internal 两个 endpoint 复用同一纯 transport handler。

### 禁止

- Store/DB 查询；
- workspace/session/run 状态判断；
- profile/settings/enablement 解析；
- dedup、CAS、archive/revert/cancel sequencing；
- 文件系统访问；
- route 先后调用多个 domain operation 拼装业务用例；
- 通过 facade `getContext()` 获取完整上下文。

## 鉴权与依赖注入

当前 `assertInternalToken(req, service)` 间接调用 `service.getContext()`。目标改为：

- composition root 将 `internalToken` 或窄 `assertInternalRequest` capability 注入 route registry；
- token 不写入日志或文档；
- plugin caller 校验保留 header/body transport 语义；
- 普通 application 不接收 Fastify request/header。

## Route 注册入口

保留一个顶层 `registerAgentRoutes(app, capabilities)` 作为聚合注册函数是可接受的，但它只能：

- 依次调用各分组注册函数；
- 传递各组最小能力；
- 不注册具体业务 handler，不持有局部领域 helper。

`agent.module.ts` 只调用该聚合入口，不直接逐条注册路由。

## 兼容性约束

- 所有 URL/method 不变；
- schema 与 response status map 不变；
- Shared registry endpoint 继续由 Shared method/path/schema/type 驱动；
- `201`/`200` 返回码不变；
- internal token 和 plugin id 错误顺序不变；
- application `HttpError` 原样传播；status summary generic 500 bridge、plugin host unavailable 503、archive 400 bridge 保持；
- SSE heartbeat 周期、headers、event chunk 和 close cleanup 保持。

## Route 架构测试

至少新增或更新源码结构测试，证明：

- 分组 route 文件不 import `agent.store.ts`、`AppContext`、`fs`、`path`；
- public route 不出现 `runtime.cancelSession` 等跨域 sequencing；
- `agents/list` route 不出现 `getWorkspaceEnabledAgentIds`、`listAvailableAgentsForSurface`；
- status/tail route 只调用 `ContextQueryApplication`，recent/workspaces/final-text/agents route 只调用 `PeripheralAgentQueryApplication`；
- route 除冻结 generic/transport bridge 外不包含业务错误翻译；
- Worker 核心 routes 仍引用 `AgentApiEndpoints`；
- SSE route 是唯一订阅 `runCompletedEventHub` 的 route group；
- 顶层 register 文件只聚合注册，不包含业务判断。
