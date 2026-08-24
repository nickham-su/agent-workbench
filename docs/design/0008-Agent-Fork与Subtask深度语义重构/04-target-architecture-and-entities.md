# 目标架构、实体与契约设计

## 目标职责划分

```text
Public / Generic Session API
  create primary
  fork primary -> primary
          │
          ▼
Primary Session Application Rules
  validate primary source
  create primary target
  create ordinary primary Run(depth=0)
          │
          ▼
Shared Private Context Clone Primitive
  select transcript window
  clone items with runId=null
  preserve archive behavior
  rollback partial session/archive on failure

Worker subtask tool
  /api/internal/agent/subtask/start
          │
          ▼
Subtask Application Rules
  validate parent Run + subtask tool anchor
  enforce max depth
  new / fork / existing session handling
  create child Run(depth=parent+1, real parent fields)
          │
          ├── new: create internal subtask session
          ├── fork: use private context clone primitive
          └── existing: reuse internal subtask session
```

## 职责边界

### Public/Generic Session Application

负责：

- 创建 primary session；
- 公开 primary fork；
- 验证公开 fork source kind 与 boundary；
- 普通 primary Run 写入不变量；
- 对外返回稳定错误。

不负责：

- subtask child depth；
- subtask parent anchor；
- subtask session 创建；
- prefork summary 或 fork guard；
- 根据 fork 来源推导 Run lineage。

### Subtask Application

负责：

- parent session/Run/tool anchor 校验；
- child depth 与 max depth；
- subtask agent/profile；
- session `new/fork/existing`；
- 幂等复用；
- fork guard、prefork summary；
- child Run parent fields。

不负责：

- 公开 primary fork 权限；
- ordinary primary Run depth；
- 用户 session create contract。

### Context Clone Primitive

负责：

- 根据调用方已确认的 source、boundary 和 mode 选择内容；
- clone context item 内容及 archive 状态；
- copied item 写 `runId/turnId/step = null`；
- 更新 new session head；
- archive sidecar 写入和失败回滚；
- 返回 target session 和必要 cloned ID map。

不负责：

- 决定 source/target kind 是否允许；
- 创建 Run；
- 计算 depth；
- 写 parent Run 字段；
- 选择公开或内部 boundary 产品规则。

## 实体语义

### `agent_session`

现有核心字段：

```text
id
workspace_id
kind
forked_from_session_id
forked_from_item_id
```

目标语义：

| 字段 | 语义 |
|---|---|
| `kind=primary` | 用户可写的独立执行根 |
| `kind=subtask` | 内部 subtask 执行载体，用户只读 |
| `forked_from_session_id` | 创建该 session 的来源 session；具体锚点规则由创建模式决定 |
| `forked_from_item_id` | 来源 session 中的 context clone boundary 或 subtask tool anchor；具体规则见下方真值表 |

`forked_from_*` 不表示：

- Run parent；
- subtask depth；
- 级联取消关系；
- tool call 幂等 key。

这两个字段是 session origin metadata，不是统一意义上的“实际复制边界”。公开 primary fork 和普通 internal subtask fork 会记录真实 clone boundary；internal subtask `new` 与 prefork summary 路径会记录触发本次 subtask 的 tool anchor；空 boundary fork 按既有语义保持双空。调用方不得脱离创建模式单独解释 `forked_from_item_id`。

以下规则具有规范性：实现不得为了“统一字段含义”而擅自把所有 subtask 分支都改成 parent tool anchor、全部改成 clone boundary，或清空已有的 origin metadata。若未来要统一该字段语义，必须另立数据迁移与兼容方案。

本次不增加 session depth 字段。

### `agent_context_item`

关键字段：

```text
session_id
run_id
prev_id
kind
archive_at
```

目标语义：

- `run_id != null`：该 item 由该 session 中对应实际 Run 产生或归属该 Run；
- `run_id = null`：该 item 不属于当前 session 的真实 Run，例如 copied history、guard、summary；
- copied item 必须继续 `run_id = null`；
- 本次不增加 origin/provenance 字段。

### `agent_run`

关键字段：

```text
session_id
subtask_depth
parent_run_id
parent_tool_item_id
```

目标不变量：

| Run 分类 | `subtask_depth` | `parent_run_id` | `parent_tool_item_id` |
|---|---:|---|---|
| ordinary primary message | `0` | `null` | `null` |
| ordinary primary compact | `0` | `null` | `null` |
| subtask child | `parent + 1` | 真实 parent Run | 真实 subtask tool item |
| 历史旧数据 | 可保留旧值 | 可保留旧值 | 可保留旧值 |

新生产代码不得创建其他组合。

### Parent 字段的完整性

真实 subtask child 应满足：

```text
parent_run_id != null
parent_tool_item_id != null
```

且 parent tool 必须：

- workspace 与 parent Run 一致；
- session 与 parent Run 一致；
- `run_id = parent_run_id`；
- `kind = tool`；
- `tool_name = subtask`。

现有 `findSubtaskRunByParentTool()` 和唯一索引继续用于幂等；`listSubtaskChildSessionIdsByRunId()` 已通过真实 parent tool join 排除普通伪 parent。实施后停止新增普通伪 parent，使字段语义更干净。

本次不要求数据库层新增 CHECK/foreign key，因为：

- SQLite 现有迁移策略与历史脏数据兼容需要额外设计；
- 当前应用层已有严格 anchor 校验；
- 本阶段目标是修正生产写入和 contract。

可将更强 DB constraint 作为后续独立治理，不得混入本次。

## Session 创建能力设计

为避免 generic `createSession(kind?)` 继续泄漏权限，目标应用层必须区分“无 fork metadata 的 primary create”和“带内部元数据的实体落盘”。本方案选定以下唯一边界：

- `createPrimarySession()` 只服务公开 create 与通用 internal create，只接受 `workspaceId/title`，不得接受 `forkedFrom*`；
- public primary fork、internal subtask `new/fork` 不调用 `createPrimarySession()`，而是由各自 application 编排调用私有 session materializer；
- 私有 materializer 可以接受显式 `kind` 与已经由上层决定的 `forkedFrom*`，但不得被 Route 直接调用。

职责接口示意：

```ts
createPrimarySession(params: {
  workspaceId: string;
  title?: string;
}): AgentSessionRecord

materializeSessionInternal(params: {
  workspaceId: string;
  title: string;
  kind: "primary" | "subtask";
  forkedFromSessionId?: string | null;
  forkedFromItemId?: number | null;
}): AgentSessionRecord
```

`forkPrimarySession()` 只能通过私有 materializer 固定创建 `kind="primary"` 并写 public fork metadata；`startSubtaskRunFromWorker()` 只能通过私有 materializer 固定创建 `kind="subtask"` 并按真值表写 metadata。底层 `createAgentSession()` store 仍接受显式 kind，因为 persistence 需要写两类实体；权限隔离发生在 application/service 层，而不是把 store 改成 primary-only。

如果保留一个私有通用创建 helper，也必须：

- 不对 Route 公开；
- `kind` 由上层专用函数常量传入；
- 公开 Route 无法把请求中的 kind 透传。

上述函数名允许按项目风格调整，但调用方向和职责边界不得变化：Route → primary application；public fork/subtask application → private materializer → store。不得以命名微调为由让 `createPrimarySession()` 重新接收 fork metadata，或让 Route 直接调用 materializer。

## Fork/Clone 能力设计

候选职责：

```ts
forkPrimarySession(request: PublicPrimaryForkRequest): Promise<AgentSessionRecord>

createForkedSubtaskSessionInternal(input: InternalSubtaskForkInput): Promise<AgentSessionRecord>

cloneContextIntoNewSession(input: {
  fromSession: AgentSessionRecord;
  fromItemId: number;
  mode: "visible_only" | "with_archive";
  target: {
    title: string;
    kind: "primary" | "subtask";
    forkedFromSessionId?: string | null;
    forkedFromItemId?: number | null;
  };
  boundaryPolicy: "public-user-assistant" | "internal-resolved";
}): Promise<AgentSessionRecord>
```

实现不必使用 `boundaryPolicy` 字符串；重点是公开 boundary 校验不能继续由一个可绕过的 `allowAnyKindBoundary?: boolean` 暴露给公共函数调用方。内部 override 应只存在于 private subtask path。

函数名和参数形态可以微调，但固定调用方向为：公开 Route → public primary fork application → private clone/materializer；internal subtask start → private subtask fork application → private clone/materializer。public primary fork application 与 internal subtask fork application 不得互相调用。

## Internal Subtask Session 真值表

下表冻结 `startSubtaskRunFromWorker()` 在未命中既有 `(parentRunId,parentToolItemId)` 幂等 child 的情况下，各分支的 session origin metadata、context 组成和 Run 创建规则。若已命中幂等 child，则在进入这些分支前直接返回 reused response，不创建 session、item 或 Run。

| `session.mode` | 附加条件 | target session | `forked_from_session_id` | `forked_from_item_id` | clone transcript | child prompt 前的顺序 | child Run |
|---|---|---|---|---:|---|---|---|
| `new` | 合法请求 | 新建 `subtask` | `parentSessionId` | `parentToolItemId` | 否 | `prompt` | 成功事务中创建，depth=`parent+1`，写真实 parent 双字段 |
| `fork` | `shouldUsePreforkSummary=true`，无论 boundary 是否为空 | 新建 `subtask` | `parentSessionId` | `parentToolItemId` | 否 | `summary → guard → prompt` | 成功事务中创建，规则同上 |
| `fork` | 无 summary，`forkBoundaryItemId != null` | 新建 `subtask` | `parentSessionId` | `forkBoundaryItemId` | 是，`visible_only` 到 boundary | `cloned transcript → guard → prompt` | 成功事务中创建，规则同上 |
| `fork` | 无 summary，`forkBoundaryItemId == null` | 新建 `subtask` | `null` | `null` | 否 | `guard → prompt` | 成功事务中创建，规则同上 |
| `existing` | 合法且 idle 的既有 subtask session | 复用，不新建 | 保持既有值，不改写 | 保持既有值，不改写 | 否 | 在既有 head 后追加 `prompt`，不写 summary/guard | 成功事务中创建新 child Run，depth 仍取本次 `parent+1` |

真值表补充约束：

- `preforkSummaryText` 只允许 `mode="fork"`，因此 `new/existing` 不存在 summary 分支；
- 所有 `fork` 分支都写 guard，包括 summary 路径和空 boundary 路径；
- summary、guard、copied transcript 都不是 child Run 产物，相关新增 item 的 `runId` 为 `null`；prompt user item 的 `runId` 为本次 child Run；
- 任一新建 session 分支在 child item/Run 事务失败时必须按现有补偿规则清理；
- `existing` 不修改 session origin metadata，也不把本次 parent/tool 覆盖进去；
- `forkBoundaryItemId == null` 的双空 metadata 是本次冻结的兼容行为，不得自行改成 parent tool anchor。

## Public Contract 变化

### `AgentCreateSessionRequestSchema`

目标：

```ts
Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
)
```

注意当前 schema 没有显式 `additionalProperties: false`。本次必须显式设为 false，并在三个受影响 Route 增加 endpoint-local `preValidation` 字段 allowlist；P0 先用真实 `createApp()` 证明该 hook 能在 schema validation/strip 前观察原始 key，P2 再实施。若证据不成立，必须暂停并回到设计，不得接受静默 strip 或修改全局 Ajv。

### `AgentInternalCreateSessionRequestSchema`

与公开 create 一样移除 `kind`，显式 `additionalProperties: false`。

### `AgentForkSessionRequestSchema`

目标：

```ts
Type.Object(
  {
    fromSessionId: Type.String({ minLength: 1 }),
    fromItemId: Type.Number({ minimum: 1 }),
    mode: Type.Union([
      Type.Literal("with_archive"),
      Type.Literal("visible_only")
    ]),
    title: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
)
```

移除 `kind`，并应用同一 endpoint-local unknown-field拒绝机制和HTTP验收标准。

### 保持不变的 Shared Contract

- `AgentSessionKindSchema`；
- `AgentSessionRecordSchema.kind`；
- context item `runId` 可空；
- `AgentApiSubtaskSessionSchema` 的 `new/existing/fork`；
- `AgentApiSubtaskStartRequest/Response`；
- `AgentSubtaskErrorCode` 中现有错误。

可以在 public fork source kind 校验中新增稳定错误码；如新增，需同步 shared/route tests，不应塞入 internal subtask error code 集合，因为它属于 public fork domain。

## Prompt / Read-side 关系

最近迭代已经把 static tool projection 提取到：

```text
PromptContextProjector
  → PromptStaticAssembler
  → run.subtaskDepth + maxSubtaskDepth
  → tools snapshot
```

目标架构中：

- write-side 创建正确 Run；
- read-side 读取该 Run；
- prompt assembler 按统一规则投影工具；
- Worker 只看到 API 下发的工具快照。

本次不应把 primary/session 类型判断加入 `PromptStaticAssembler`。否则会形成两个 depth 权威源：

```text
run.subtaskDepth
session.kind
```

唯一权威仍是 `agent_run.subtask_depth`；write-side 保证 primary ordinary Run 写 `0`。

## 内部 Subtask Existing 生命周期

目标流程：

```text
第一次 subtask(new/fork)
  → 内部创建 subtask session S
  → 创建 child Run R1

后续 subtask(existing, S)
  → 校验 S.kind=subtask、workspace、idle
  → 校验本次 parent/tool anchor
  → childDepth = 本次 parent depth + 1
  → 在 S 创建新 child Run R2
```

不从 R1 继承 depth，不要求 S 存 session depth。

## 历史兼容模型

应用读取历史数据时继续允许：

- `AgentRunRecord.subtaskDepth: number | null`；
- `parentRunId` 单独非空的旧普通 fork Run；
- copied item `runId = null`。

新写入应通过测试保证不再产生这些 ordinary primary 异常组合。

不建议此时把 store type 改成非空 depth，因为历史数据和异常 Run 仍需安全读取；强类型收紧应在有正式数据迁移之后独立进行。
