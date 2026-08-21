# Subtask 职责域设计

## 设计目标

建立一个可发现的 Subtask application，使 transport/facade 不再承载 anchor、mode、lineage、race、result/status、compensation 或 orphan 规则，同时保持：

- Shared contract 不变；
- DB schema 与 partial unique index 不变；
- `0008` 的 Fork/depth/session 语义不变；
- `0007-C` 的 Lifecycle cancel/state/complete/recovery 规则不变；
- Worker nested execution 模型不变。

## 目标依赖方向

```text
Internal Subtask Routes
  → AgentService compatibility facade
  → SubtaskApplication
      ├─ ParentAnchorReader / LineagePersistence
      ├─ SubtaskSessionMaterializer
      ├─ SubtaskExecutionProfileReader
      ├─ SubtaskChildRunActivator
      ├─ SubtaskResultReader
      ├─ LocalCompensationPersistence
      ├─ OrphanPersistence
      ├─ WorkspaceReader
      ├─ Clock / IdGenerator / Logger
      └─ existing error classifiers

RunLifecycleApplication
  → ActiveSubtaskChildQuery
  → same named SQLite lineage adapter

Worker
  → Shared Subtask API
  → receives child run
  → processNestedRun() or reuse polling
```

默认禁止：

```text
SubtaskApplication → Route/Fastify request
SubtaskApplication → full RunLifecycleApplication
RunLifecycleApplication → full SubtaskApplication/AgentService
Route → Store/session clone/lifecycle persistence
Module → orphan candidate/delete rules
Persistence adapter → Worker runtime
```

## `SubtaskApplication` 候选用例

```ts
getPreforkPlan(request: AgentApiSubtaskPreforkPlanRequest): AgentApiSubtaskPreforkPlanResponse

startSubtask(request: AgentApiSubtaskStartRequest): Promise<AgentApiSubtaskStartResponse>

getResult(request: AgentApiSubtaskResultRequest): AgentApiSubtaskResultResponse

getStatus(request: AgentApiSubtaskStatusRequest): AgentApiSubtaskStatusResponse

cleanupOrphansOnStartup(command?: { now?: number }): SubtaskOrphanScanSummary
```

Shared DTO 可以作为边界输入输出；领域内部应尽快转换为明确 command/value object，不让 transport union 驱动所有 persistence 方法。

## 权威责任表

| 规则 | 权威 owner | 说明 |
|---|---|---|
| parent session/run/tool anchor | Subtask application + lineage persistence | 保持 ownership/toolName/runId 校验 |
| prefork threshold/profile/meta | Subtask application | Worker 生成 summary，API 重新验证 plan |
| session mode 与 metadata | Subtask application + session materializer | 保持 `0008` 真值表 |
| copied item ownership | session clone capability | copied item 仍 `runId/turnId/step=null` |
| child depth/max depth | Subtask application | child=`parent+1` |
| durable reuse key | lineage persistence | `(parentRunId,parentToolItemId)` |
| race final arbitration | SQLite partial unique index | application 只识别目标 constraint 并再查询 |
| seed item 顺序 | Subtask application 生成 activation plan | summary/guard/prompt 顺序不变 |
| seed items + child run + run-state transaction | Lifecycle-owned child activator | 不 enqueue runtime |
| nested execution / reuse polling | Worker | `processNestedRun()` 模型不变 |
| result/status projection | Subtask application + query persistence | 不引入新存储 |
| local compensation policy | Subtask application | 仅本次创建 session |
| orphan policy | Subtask application startup use-case | suspect/eligibility/failure isolation |
| final empty delete fence | named SQLite persistence | local 与 orphan 暴露不同能力 |
| cancel cascade | Run Lifecycle | 通过 durable child query，不用 session hint |

## Ports 与 persistence capability

名称为候选，职责和依赖方向是规范性的。

### Parent anchor 与 lineage

```ts
type SubtaskParentAnchor = {
  parentSession: AgentSessionRecord;
  parentRun: AgentRunRecord;
  parentUiLocale: AgentUiLocale | null;
  anchor: AgentContextItemRecord;
};

type SubtaskLineagePersistence = {
  resolveParentAnchor(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentToolItemId: number;
  }): SubtaskParentAnchorResult;

  findChildByParentTool(input: {
    workspaceId: string;
    parentRunId: string;
    parentToolItemId: number;
  }): AgentRunRecord | null;
};

type ActiveSubtaskChildQuery = {
  listByParentRun(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): string[];
};
```

可以由同一个 `SqliteSubtaskLineagePersistence` 实现多个窄接口，但消费者只接收所需能力。不得让 Lifecycle 获得 anchor/session mode/orphan 能力。

anchor persistence 可以返回结构化 missing/mismatch/invalid 结果，由 application 映射现有 `HttpError`；也可以保持适配层 helper 抛稳定领域错误。P2 必须根据项目既有错误风格选定一种，不得同时保留两套权威映射。

### Session materialization 与 clone

```ts
type SubtaskSessionMaterializer = {
  resolveForStart(input: {
    workspaceId: string;
    parentSessionId: string;
    parentToolItemId: number;
    mode: "new" | "fork" | "existing";
    requestedSessionId: string | null;
    title: string;
    forkBoundaryItemId: number | null;
    usePreforkSummary: boolean;
  }): Promise<{
    session: AgentSessionRecord;
    createdSessionId: string | null;
  }>;
};
```

该 port 允许复用 `0008` 已建立的 private materializer/clone primitive，但：

- 不对 Route 公开；
- 不拥有 child depth/lineage/run-state；
- public primary fork application 与 Subtask application 不互调；
- internal fork 的 origin metadata 和 copied-item ownership 不变；
- clone archive 行为仍属于现有 Session/Archive 交界，本阶段只通过窄 capability 协作，不吸收 Archive 主体。

### Profile、workspace 与 settings

```ts
type SubtaskExecutionProfileReader = {
  resolve(input: { workspaceId: string; requestedAgentId: string }): {
    agentId: string;
    agentName: string;
    providerId: string;
    modelId: string;
    contextWindowTokens: number;
  };
  getMaxDepth(): number;
};

type SubtaskWorkspaceReader = {
  get(workspaceId: string): { path: string } | null;
};

type ParentRunStateReader = {
  get(workspaceId: string, sessionId: string): {
    status: string;
    lastResponseTotalTokens: number | null;
  };
};
```

实现可组合已有 settings/read-side helpers，但不得把完整 `AppContext` 传入 application。

### Nested child activation

推荐由 Lifecycle 责任面提供窄 capability：

```ts
type SubtaskChildRunActivator = {
  activate(input: SubtaskChildActivationInput): SubtaskChildActivationResult;
};

type SubtaskChildActivationInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  parentRunId: string;
  parentToolItemId: number;
  subtaskDepth: number;
  agentId: string;
  providerId: string;
  modelId: string;
  uiLocale: AgentUiLocale | null;
  createdAt: number;
  seedItems: Array<
    | { kind: "system"; text: string; attachToRun: false }
    | { kind: "user"; text: string; attachToRun: true }
  >;
};

type SubtaskChildActivationResult =
  | { kind: "activated"; promptItemId: number }
  | { kind: "session-running" };
```

规范性要求：

- activator 在 transaction 内重新检查 session run-state idle；这是把当前 transaction 外的 `SessionRunning` 校验下沉为最终 DB 约束，不改变“running session 不可再次启动”的产品规则；
- 按输入顺序 append seed items；
- `attachToRun=false` 写 `runId=null`，prompt 写 child runId；
- 创建 child run 时固定真实 parent 双字段和 depth；
- run-state running 的 `appliedItemId` 指向 prompt item；
- 任一步失败整个 transaction 回滚；
- 不执行 runtime enqueue，不读取 workspace path，不调用 Worker；
- 不实现 reuse/unique conflict policy，目标 unique error交给 Subtask application 分类并重查；
- 不承担 session materialization 或补偿。
- 不向 `AgentRuntime` 或 worker-disabled wiring 暴露该 capability；它仅服务 API-managed Worker 经 internal Subtask API 发起的 child activation。

### 为什么不直接使用 `startUserRun()`

`startUserRun()` 包含 user command dedup、first-message title、runtime context 与 enqueue/failure settlement；Subtask child 的 seed items、parent lineage、existing reuse 和 Worker nested execution均不同。强行复用会混淆语义或引入错误 enqueue。

### 为什么 activator 推荐归 Lifecycle

run record 与 run-state activation 是 Lifecycle 已确立的权威责任。让 Subtask 自己长期保有另一份 SQLite transaction，会形成结构双落点。通过窄 nested activation capability 可以共享 run-state 不变量，又不把 Subtask 模式决策推入 Lifecycle。

若 P0/P2 证明现有事务或依赖不能安全归入 Lifecycle，允许采用临时 `AtomicSubtaskStartPersistence`，但必须：

- 在方案实施记录中说明证据；
- 保持同一 transaction；
- 明确其只实现 Subtask activation，不复制 complete/cancel/recovery；
- 在 P6 结构审查中记录与推荐设计的差异；
- 不以迁移困难为由把整段继续留在 facade。

### Result / Status query

```ts
type SubtaskRunQuery = {
  getOwnedRun(input: { workspaceId: string; sessionId: string; runId: string }): OwnedRunResult;
  getVisibleResultText(input: { workspaceId: string; sessionId: string; runId: string }): string;
};
```

ownership 与 result projection 应集中，不要求按表建立 repository。result 继续 assistant-first、system-fallback、empty-last。

### 分离删除能力

批次归属固定如下：

- local compensation 是 `startSubtask()` 失败语义的一部分，production path、调用条件、race winner处理与错误优先级必须在 P3 与 start 主链同批迁移；
- P4 不再迁移 compensation 业务语义，只迁移 result/status，并完成 local/orphan 删除 capability 的命名、adapter 导出边界和旧通用 helper 清理。

```ts
type SubtaskLocalCompensationPersistence = {
  deleteNewSessionIfStillEmpty(input: {
    workspaceId: string;
    sessionId: string;
  }): boolean;
};

type SubtaskOrphanPersistence = {
  listSuspects(input: { olderThan: number }): SubtaskOrphanCandidate[];
  deleteSuspectIfStillEligible(input: {
    workspaceId: string;
    sessionId: string;
    olderThan: number;
  }): boolean;
};
```

`deleteSuspectIfStillEligible()` 的语义固定包含 fork lineage 双字段检查。application/公开 port 不得传入 `requireForkLineage` 或任何可关闭该约束的开关。两个方法可以在同一个 SQLite adapter 内调用私有 prepared statement builder/SQL fragment，但该原语只能是 adapter 内部实现细节，不得导出给 application、facade、module 或其他 domain。

## Start application 顺序

```text
resolve parent anchor
  → normalize/validate description, prompt, agent, mode, prefork
  → find durable child by parent tool
      └─ found: validate existing-session hint if present; return reused
  → validate parent depth / max depth
  → resolve fork boundary and session mode
  → materialize or reuse child session
  → resolve profile + workspace
  → build ordered seed item plan
  → nested child activator transaction
      ├─ session idle final check
      ├─ append seeds
      ├─ create child run with lineage
      └─ set run-state running
  → return reused=false

on failure after materialization:
  → if createdSessionId != null, local compensation best-effort
  → if target unique conflict:
       find durable winner
       if winner found: return reused
  → otherwise rethrow original error
```

### Race 与补偿顺序

P3 必须把 local compensation 与 start/reuse/unique race 同批切换。目标 unique conflict 后，对 loser 本次创建 session 做条件补偿，再返回 winner。实现必须确保：

- winner session 永不由 loser 补偿；
- existing session 永不补偿；
- compensation error 不覆盖可返回的 winner 或原始业务错误，但必须受控记录；
- race 后仍查不到 winner 时不得伪造 reused。

P0 必须冻结当前 compensation 与 conflict 先后顺序，并区分产品语义与当前嵌套 catch 可能产生的重复 cleanup 调用。P3 可以将重复尝试收敛为单一 best-effort cleanup 入口，只要上述语义和 final empty fence 保持并有测试证明；不得把 compensation 延后到 P4，造成 start 主链与失败语义分批双权威。

## Facade 与 Route

过渡期 `AgentService` 保留同名兼容方法：

```ts
getSubtaskPreforkPlanFromWorker(params) {
  return this.subtaskApplication.getPreforkPlan(params);
}
```

其余 start/result/status 同样只转发。不得保留 private anchor/mode/race/orphan helper。

Route 保持：

- Shared endpoint/schema；
- internal token；
- body 类型转换；
- 调用 facade；
- 当前 response/error schema。

本阶段不提前拆 `agent.routes.ts` 文件；最终 route 分组留给 Session/Routes/Module 收尾。

## Error ownership

- Shared/Fastify 负责 schema shape；
- Subtask application 负责稳定业务错误码和 400/404/409 分类；
- persistence 返回明确 conflict/not-found/mismatch，不拼 HTTP response；
- target unique constraint classifier 应迁入 SQLite lineage/activation adapter附近，不长期导出自 facade；
- Worker 继续按 HTTP error 传播，不新增协议字段。

## Cache、event 与 runtime

- Subtask start 当前不直接触发 prompt static cache；新 child 的 prompt 首次读取按 runId 自然建立 cache；
- child terminal cache/event 继续由 `RunLifecycleApplication.completeRunFromWorker()` 处理；
- start 不发布 run-completed event；
- Subtask application 不接收 RuntimeControlPort；
- Subtask application 不调用 runtime enqueue，也不向 `AgentRuntime` 注册 Subtask API/port；
- worker-disabled wiring 保持 `AgentRuntime` 当前 read/writeback/lifecycle 最小依赖集合，不新增 Subtask dependency；
- API local fallback 不新增 nested-subtask execution 支持；当前 Subtask 工具主链属于 API-managed Worker，P0 只需明确并通过结构审计保护既有非等价边界。

验收不要求为 local fallback 构造一套虚假的 Subtask 行为测试。必须通过 production wiring/依赖搜索证明：`AgentRuntime` 构造参数、`LocalAgentRuntimeExecutionPort`（或当前等价接口）和 worker-disabled module 分支均未扩张。

## 候选文件结构

```text
apps/api/src/modules/agent/subtask/
  subtask-application.ts
  subtask-ports.ts
  sqlite-subtask-lineage-persistence.ts
  subtask-application.test.ts
  subtask-lineage.persistence.test.ts
  subtask-wiring.test.ts
```

允许按实现拆成 `sqlite-subtask-persistence.ts` 或将 query/cleanup adapter分文件。判断标准是业务能力可发现、事务清楚和依赖窄，不是文件数量。
