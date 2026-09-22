# API 与前端方案

## 模块与页面壳

建议新增：

```text
apps/api/src/modules/analytics/
packages/shared/src/contracts/analytics.ts
apps/web/src/features/workbench/…dashboard…
```

- 共享契约使用 TypeBox，并从 `packages/shared/src/index.ts` 导出；Fastify 路由直接复用 schema。
- `/dashboard` 复用现有 `WorkbenchPage/WorkbenchLayout`，在 Workbench 导航新增 Dashboard tab/activeKey；**不新增独立无壳 `DashboardPage`**。
- 复用既有认证、布局和导航。当前路由在 `apps/web/src/app/router/index.ts`，实现前需核对 Workbench tab 的实际状态组织。
- Worker/Execution/模型 Attempt 写回是 internal 控制面，不作为公开分析 API。

## 统一查询合同

```ts
{
  from: number,          // UTC Unix ms
  to: number,            // UTC Unix ms, to > from
  timezone: string,      // IANA，例如 Asia/Shanghai
  granularity?: '10m' | 'hour' | 'day' | 'week' | 'month',
  workspaceId?: string,  // 仅 Agent/Run/消息/会话接口允许
  providerId?: string,   // 仅模型接口允许
  modelId?: string       // 仅模型接口允许
}
```

- `from/to` 为安全整数；公开范围最大 366 天。
- `timezone` 必须用 IANA 校验，禁止仅 UTC offset。
- `workspaceId` 只能用于 Agent/Run/消息/会话接口；传到模型、工具、Git、Worker 接口必须 `400 ANALYTICS_FILTER_UNSUPPORTED`。
- `providerId/modelId` 只能用于模型接口；其他接口传入必须拒绝。
- `granularity` 仅趋势接口使用；服务端执行 [聚合与查询算法](./05-聚合与查询算法.md) 的点数、默认和最大限制。

## 公开 API

| 路径 | 允许筛选 | 返回 |
| --- | --- | --- |
| `GET /api/analytics/overview` | 时间；可拆分为 Workspace 适用子卡片 | 各域摘要、domain freshness/coverage |
| `GET /api/analytics/agent` | 时间、Workspace、granularity | 顶层时长、Run、主/子任务、消息、会话、当前 queued/running |
| `GET /api/analytics/models` | 时间、Provider、Model、granularity | Provider/Model 请求、状态、Token、缓存、时长、coverage |
| `GET /api/analytics/tools` | 时间、granularity | 仅工具名维度调用、状态、时长 |
| `GET /api/analytics/git` | 时间、granularity | 全局 Git 趋势、coverage/current generation |
| `GET /api/analytics/worker` | 时间、granularity | Worker 事件趋势 |
| `GET /api/analytics/status` | 无业务筛选 | 各 domain job、Dirty、coverage 状态 |

`overview` 中 Workspace 筛选只影响明确声明为 Workspace 域的子卡片；模型、工具、Git、Worker 仍返回全局数据，并在 schema 中分区表达，避免一个 filter 隐式改变不支持维度。

## 响应与数值合同

```ts
{
  range: { from, to, timezone },
  data: { /* 只含受控聚合 */ },
  freshness: {
    model?: { status, lastSucceededAt, pendingDirtyCount, deliveryGapCount, deliveryIncidentCount, historicalLossCount, coverageDegraded },
    run?: { status, lastSucceededAt, pendingDirtyCount },
    execution?: { status, lastSucceededAt },
    agentDuration?: { status, lastSucceededAt, pendingDirtyCount },
    tool?: { status, lastSucceededAt, pendingDirtyCount },
    message?: { status, lastSucceededAt, pendingDirtyCount },
    session?: { status, lastSucceededAt, pendingDirtyCount },
    git?: { status, lastSucceededAt, pendingDirtyCount },
    worker?: { status, lastSucceededAt, pendingDirtyCount }
  },
  coverage: { // collection/backfill 来自 Domain State；model health counters 来自 Gap/Incident 诊断查询
    model?: { collectionStartedAt, backfillStatus, degraded, deliveryGapCount, deliveryIncidentCount, historicalLossCount },
    run?: { collectionStartedAt, backfilledFrom, backfillBefore, backfillStatus },
    execution?: { collectionStartedAt, backfillStatus },
    agentDuration?: { coverageSource: 'execution', collectionStartedAt: null, backfillStatus: 'not_applicable' },
    worker?: { collectionStartedAt, backfillStatus },
    message?: { collectionStartedAt, backfilledFrom, backfillBefore, backfillStatus },
    session?: { collectionStartedAt, backfilledFrom, backfillBefore, backfillStatus },
    tool?: { collectionStartedAt, backfilledFrom, backfillBefore, backfillStatus },
    git?: {
      repos: GitRepoCoverage[]
    }
  },
  dataIncomplete?: boolean
}
```

- 数量/Token 为整数；时长为毫秒整数；比例为 `[0,1] | null`。
- `null` 不得变成 `0`、`-` 或字段缺失。
- Token/缓存同时返回 reported/comparable count。
- `collectionStartedAt` 是非 Git domain 的统一公开字段名，来自 `analytics_domain_state.collection_started_at`；不得暴露或保留废弃 `analyticsStartedAt` / `startedAt` coverage 字段。
- `agentDuration` 仅有自身 job/rebuild freshness，coverage 固定引用 `execution`，不得构造重复采集起点。
- `execution` 是原始 collection coverage / 实时状态 domain，不存在聚合 Dirty，故 freshness **不得**返回 `pendingDirtyCount`；顶层 Agent 时长投影的 Dirty 仅位于 `agentDuration`。
- 模型 delivery gap 与 delivery incident 都不改变已有指标数值；`deliveryGapCount`、`deliveryIncidentCount` 是 model domain 的**全局 unresolved** 数，`historicalLossCount` 由 incident 查询 `count(resolution='confirmed_missing' AND loss_repaired_at IS NULL)` 得出，三者均不随请求范围、Provider、Model 或趋势粒度变化。它们都是“采集健康诊断”，不是所选范围模型指标。
- `coverageDegraded` 及 `coverage.degraded` 必须等于 `deliveryGapCount>0 || deliveryIncidentCount>0 || historicalLossCount>0`。本地 ACKed Gap 的 24h 清理、本地 quarantined 删除或 incident 的 `confirmed_missing` 都不得把该值错误改回 false；只有同一主库 transaction 以明确 incident ID 写入可信 Fact、Dirty 与 repair generation 后，才可能消除相应 historical loss。
- Git `coverage.repos` 是诊断级 Repo 数组，数值指标仍为所有 current Repo 的全局汇总。Shared public contract 必须以 TypeBox 明确建立判别联合并导出 TS 类型，例如：

```ts
const GitRepoCoverageReadySchema = Type.Object({
  repoId: Type.String(),
  status: Type.Literal('ready'),
  currentGeneration: Type.Integer({ minimum: 1 }),
  coveredFrom: Type.Union([Type.Integer(), Type.Null()]),
  coverageIncomplete: Type.Boolean(),
  coverageReason: GitCoverageReasonSchema,
})
const GitRepoCoverageUnavailableSchema = Type.Object({
  repoId: Type.String(),
  status: Type.Union([Type.Literal('preparing'), Type.Literal('error')]),
  currentGeneration: Type.Null(), coveredFrom: Type.Null(),
  coverageIncomplete: Type.Null(), coverageReason: Type.Null(),
})
const GitRepoCoverageSchema = Type.Union([
  GitRepoCoverageReadySchema, GitRepoCoverageUnavailableSchema,
])
```

前端必须按 `status` 窄化：只在 `ready` 分支读取/展示 current coverage；`preparing/error` 的所有 coverage 字段必须为 null，禁止 generation `0`、`coverageIncomplete=false` 或最近 failed scan 冒充 current coverage。
- 趋势返回后端确定的 `points: Array<{from,to,values}>`；每点独立准确计算，前端不再分桶。
- 聚合不可用且 Fact 回退超预算时，返回 `409 ANALYTICS_DATA_INCOMPLETE`；不得携带伪精确 `data`。普通 stale/freshness 提示不能替代该错误。
- Dashboard API 不返回消息/Run/工具执行详情 ID、Git SHA、路径或任意正文；本期无 drill-down。

## 内部控制面

建议内部接口：

```text
POST /internal/analytics/run-executions/:id/start
POST /internal/analytics/model-calls/begin
POST /internal/analytics/model-calls/:id/finish
POST /internal/analytics/model-delivery-gaps
```

- 使用既有 internal token，默认不暴露在公开 Swagger；若必须出现 OpenAPI，显式标记 internal。
- Execution start 接口只允许 queued→running 条件迁移，返回当前状态与幂等结果；Worker 必须 await 成功才 `processRun`。
- Worker sender 以 POST 逐条投递其私有 Outbox 的标准 DTO。begin、finish、gap 均须在认证 envelope/header 以 `delivery_event_id` 携带稳定、非空、受控格式的传输幂等键；业务 DTO 中的 `event_id` 必须与之相同。API 必须在 body 解析前读取该 ID；sender 只能发送 `provider_invoked` begin 与 `pending` finish，绝不发送 prepared。接口成功响应必须表示 API 主库 Fact/状态与 Dirty 已在同一 transaction 提交，才允许 Worker 标记 ACK。
- begin 与 finish DTO 都必须包含 `model_call_id`、**必填** `execution_id`、`run_id`、`turn_id`、`step`、`attempt_no`、`provider_id`、`model_id`、**非空** `started_at`；API 验证 Analytics Execution 存在且其 `run_id` 完全一致。不得通过可破坏的 Agent 域 FK 校验。
- 模型 finish DTO 必须携带完整不可变身份及同一 started_at；begin 存在时任一不可变字段冲突返回 `409`，begin 缺失时仅完整身份及 Execution 校验皆成功可补建。重复 begin/finish 返回幂等成功，终态不可被改写。
- gap DTO 接收 `gap_id/event_id/model_call_id/execution_id/run_id/turn_id/step/attempt_no/provider_id/model_id/started_at/gap_kind/detected_at`；promotion 两类 `started_at` 必填，prepared ambiguous 允许 null。API 同样校验 Execution/run、以 `gap_id/event_id` 重放幂等，并以 `model_call_id` 强制每 Attempt 至多一个 Gap。只有 gap kind 与全部不可变身份一致时才返回原 Gap；kind 不同或任一身份冲突均是不变量损坏，必须隔离/fail-closed，绝不覆盖或插入第二行。gap 写入时若可信身份一致 Fact 已存在，立即写 resolved；Fact 写入时则在**同一 Fact+Dirty transaction** resolve 既有 gap：promotion 两类要求完整身份（含 started_at）并允许 begin 或完整 finish resolve，prepared ambiguous 仅同 call、既有非时间身份一致的可信 Fact resolve。gap 不创建 Fact、不标 Dirty、不进入公开请求数、聚合或范围/Provider/Model 筛选；公开 API 返回全局 `deliveryGapCount`、`deliveryIncidentCount`、`historicalLossCount` 与由三者派生的 `coverageDegraded`。
- `409` 身份/终态冲突和 `422` 非法 DTO 是永久交付错误：若认证和 `delivery_event_id` 有效，API 必须先以该 ID 在主库可靠 transaction 创建或重放读取无敏感 `analytics_model_delivery_incident`，再返回原 `{ incidentId, code }`；body 无法解析时可写 `model_call_id=null` 的 model-domain incident。相同 ID 重放、包括 response 丢失后的重试，必须返回同一 incidentId 且不重复计数。若 ID 缺失/非法，返回受控协议错误、持续告警并 fail-closed，**不建 incident、也不允许 Worker quarantine**。仅收到有效 `incidentId` 后 Worker 才 quarantine 对应 begin/finish/gap 行；本地删除 quarantine 不 resolve incident。网络、5xx、incident 写入失败和暂时 DB 错误可退避重试。内部 API 重启不改变该规则。
- 受控 incident 维护只能作 `resolution: null → replayed | confirmed_missing` 的一次迁移，且同一 transaction 必须同时写 `resolution/resolved_at`；相同 resolution 重试返回原 `resolved_at`，两个 resolution 不可互相覆盖。`deliveryIncidentCount` 唯一按 `count(*) where resolved_at is null` 查询；`confirmed_missing` 提交后该计数减一且 `historicalLossCount` 加一，`replayed` 仅使前者减一。非法 resolution/resolved_at 组合必须由 DB check/持久层拒绝。`confirmed_missing` 的修复必须指定目标 incident IDs 和稳定 repair generation，且在同一主库 transaction 写 Fact、Dirty、`loss_repaired_at/loss_repair_generation`；同 generation 重试幂等、不同 generation 冲突，禁止按数量恢复健康。前端仅展示聚合后的采集健康诊断，不展示 incident/Gap 详情，也不得把 `confirmed_missing` 当作完整历史。
- DTO 只能接收预定义枚举、IDs、时间、Token 和受控 reason；不得接收正文、工具参数、原始 error 或自由 JSON。它不接受 Worker 的 Outbox 路径、数据库内容或调试日志。

## 前端产品行为

### 导航

- `/dashboard` 进入 `WorkbenchPage`，activeKey 选中 Dashboard tab。
- 保持 `/workspaces`、`/repos`、设置、`/workspaces/:workspaceId` 的现有路由语义。
- Dashboard 为顶层 Workbench 面板，不嵌入单个 Workspace 工具面板。

### 时间与趋势

- 全局范围选择器支持近 24h、7d、30d、90d 和自定义 IANA 时间范围。
- 后端决定默认 `granularity`；前端可选择受限枚举但必须显示后端返回的实际点。
- day/week/month 点以用户时区边界显示；10m/hour 用 UTC 聚合后转换展示，DST 不做前端补桶。

### 状态与空态

| 状态 | 行为 |
| --- | --- |
| `preparing` | 显示初始采集说明，不绘制伪零线 |
| `ready` | 正常展示 |
| `catching_up` | 可展示已准确返回数据，并提示仍有 Dirty；不得自行显示被 API 拒绝范围 |
| `rebuilding` | 显示重建说明；受影响范围若超 Fact 预算显示 dataIncomplete |
| `error` | 显示安全错误码、上次成功时间；不展示内部异常文本 |
| `dataIncomplete` | 明确说明无法在预算内保证准确性，提供缩小范围/稍后重试入口 |

### 文案和图例

- 模型仅 Provider/Model，不提供 Workspace 控件；工具仅工具名，不提供 Workspace 控件。
- 默认模型时长为“已完成请求平均时长”；全终态时长必须注明状态范围。
- Token 展示 coverage；缓存为 `null` 时显示“未提供可比缓存数据”。
- 模型 coverage degraded 时显示“存在未能可靠记录或交付的调用边界”；全局 `deliveryGapCount`、`deliveryIncidentCount` 和 `historicalLossCount` 必须标注为“采集健康诊断（非所选时间范围指标）”，不估算、不补零、不展示 gap/incident 详情。
- Git 标注“当前可达提交历史”和 coverage；全局数字不按 Repo/Workspace 拆分，coverage 只显示总体警告及无敏感 Repo 级诊断明细，不显示 Commit Message、路径或 SHA。
- Worker 仅展示异常退出与自动重启 attempted/succeeded/failed；不展示 `restart_scheduled`。
- Agent 时长不得称“推理时长”“生产率”“时间杠杆”“实际 CPU 时间”。

## 审查要求

- 路由是否复用 `WorkbenchPage/WorkbenchLayout`，而非新建无壳页面？
- 是否严格拒绝模型/工具 Workspace filter？
- 是否让后端返回趋势点及准确性状态，而不是前端二次聚合？
- 是否对每个 API range 使用可用桶/Fact 回退算法，且不返回旧聚合冒充准确数据？
- execution 是否只返回原始 coverage/status，而 `agentDuration` 才拥有时长 Dirty / `pendingDirtyCount`？
- 是否拒绝 prepared delivery，且 begin/finish 的 started_at/身份/Execution-run 一致性均被校验？
- Git 是否按 TypeBox 判别联合返回 Repo coverage，且前端仅在 ready 分支读取 current coverage？
- 是否使用参数化 SQL、认证与受控 schema，且不泄漏详情/敏感字段？
