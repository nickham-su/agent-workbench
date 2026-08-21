# 当前基线与证据

> 本文件记录 P0 已冻结的当前事实。除明确标注“目标”或“待后续批次验证”的内容外，不把候选设计写成现状。
>
> P0 未改生产代码、Shared contract 或 DB schema；以下事实来自 HEAD `3c40dab` 的只读审计、既有真实 SQLite/API/Worker/Shared tests 与 P0 定向回归。P1+ 的 application、ports、adapter 或 wiring 候选设计均尚未实施。

## 当前主调用链

```text
Worker BuiltinToolProvider.execute("subtask")
  ├─ fork mode: AgentApiClient.getSubtaskPreforkPlan()
  │    └─ POST /api/internal/agent/subtask/prefork-plan
  ├─ 可选 one-shot prefork summary（Worker 内）
  ├─ AgentApiClient.startSubtaskRun()
  │    └─ POST /api/internal/agent/subtask/start
  │         → AgentService.startSubtaskRunFromWorker()
  │         → agent.store.ts / session materialization / clone / transaction
  ├─ reused=false: Worker ctx.processNestedRun(...)
  ├─ reused=true: Worker polling getSubtaskStatus()
  └─ terminal: Worker getSubtaskResult()
```

Shared contract 位于：

```text
packages/shared/src/internal-contracts/agent-api-subtask.ts
packages/shared/src/internal-contracts/agent-api.ts
```

四个 endpoint 已由 Shared registry、TypeBox schema 与 Worker response validation 共同约束。本阶段不修改这些合同。

### Shared 与 Worker 合同冻结

| 用例 | Shared endpoint | Worker response schema | 稳定错误归属 |
|---|---|---|---|
| prefork plan | `getSubtaskPreforkPlan` / `POST /api/internal/agent/subtask/prefork-plan` | `AgentApiSubtaskPreforkPlanResponseSchema` | `AgentSubtaskErrorCode` + 通用 HTTP mapping |
| start | `startSubtask` / `POST /api/internal/agent/subtask/start` | `AgentApiSubtaskStartResponseSchema` | `AgentSubtaskErrorCode` + 通用 HTTP mapping |
| result | `getSubtaskResult` / `POST /api/internal/agent/subtask/result` | `AgentApiSubtaskResultResponseSchema` | session/run ownership 的既有 HTTP mapping |
| status | `getSubtaskStatus` / `POST /api/internal/agent/subtask/status` | `AgentApiSubtaskStatusResponseSchema` | session/run ownership 的既有 HTTP mapping |

- `packages/shared/tests/internal-contracts.test.ts` 覆盖 endpoint method/path、TypeBox schema、`new/fork/existing` union、prefork meta、`reused` 与稳定 Subtask error codes；
- `apps/agent-worker/src/runtime/apiClient.ts` 的四个方法均通过 `postInternal(..., responseSchema)` 验证响应；`apiClient.test.ts` 覆盖 strict/warn response-validation 边界；
- API route 继续使用 Shared endpoint registry 的 method/path/schema 并校验 internal token；本阶段不改变 schema、error code 或 Worker client contract。

## Prefork plan 当前行为

API `AgentService.getSubtaskPreforkPlanFromWorker()` 当前：

- 首先校验 parent session、parent run 与 parent tool anchor；
- `agentId` trim 后不能为空；
- `thresholdPct` 缺省为 `95`，输入经 number/floor 后必须位于 `50..99`；
- 以 `surface="subtask"` 和 workspace enablement 解析 child execution profile；
- `childContextWindowTokens = max(1, floor(profile.model.contextWindowTokens))`；
- `thresholdTokens = max(1, floor(childContextWindowTokens * thresholdPct / 100))`；
- 从 parent session 当前 run-state 读取 `lastResponseTotalTokens`；
- token 不存在时 `shouldPrefork=false`；存在且达到 threshold 时为 true。

Worker 当前只在 `session.mode="fork"` 时请求 plan：

- `shouldPrefork=false` 时不生成 summary，仍继续 start；
- `shouldPrefork=true` 时通过 messages-context 加一次 one-shot summary prompt；
- summary 为空或普通错误时降级为无 summary 的 fork；
- abort 继续向上传播并中止本次工具执行；
- 成功 summary 将 `preforkSummaryText` 与 `preforkMeta` 传给 start。

API start 会重新计算当前 prefork plan 并核对 meta，避免只信任 Worker 提供的派生值。

## Parent anchor 当前不变量

`resolveSubtaskParentContext()` 当前逐层验证：

- parent session 存在且 workspace 一致；
- parent run 存在，属于该 workspace/session；
- anchor context item 存在，属于该 workspace/session；
- anchor `kind=tool`；
- `anchor.runId === parentRunId`；
- `anchor.output.type=tool` 且 `toolName=subtask`。

`parentRun.uiLocale` 被归一化后传给 child run。anchor 错误继续使用现有 HTTP 与 `AgentSubtaskErrorCode` 映射。本阶段不得弱化为只校验 sessionId 或 tool output 中的 session hint。

## Start 输入与模式校验

当前 start 先冻结以下输入规则：

- description trim 后截断至 50 字符，结果不能为空；
- prompt trim 后不能为空；
- agentId 不能为空；
- `new/fork` 不允许显式 sessionId；
- prefork summary/meta 仅允许用于 fork；
- summary 最大 100000 字符；
- meta 必须伴随非空 summary；
- meta 必须匹配 API 重新计算的 plan；
- mode 仅允许 `new/fork/existing`；
- existing 必须提供 sessionId，该 session 必须存在、workspace 匹配且 `kind=subtask`。

Shared schema 已限制 session union，但 service 仍承担稳定业务错误语义。

## Durable lineage 与 reuse

### 权威字段

child run 的权威关系位于 `agent_run`：

```text
parent_run_id
parent_tool_item_id
```

数据库存在 partial unique index：

```sql
create unique index idx_agent_run_parent_tool_unique
on agent_run(parent_run_id, parent_tool_item_id)
where parent_tool_item_id is not null
```

`findSubtaskRunByParentTool()` 以 workspace、parent run、parent tool 查询 child run。start 在创建任何新 session 之前先查询：

- 命中时直接返回 `{ reused: true }`；
- existing 请求若指定了不同 sessionId，返回稳定 conflict；
- 历史 agent 已被删除时，reuse response 使用 stored agentId 作为 agentName fallback，不使幂等 retry 失败。

### Unique race

当前 race 处理不是先读结果的唯一保证。若两个请求预查均未命中：

- 两者可分别 materialize 新 session；
- child activation transaction 最终由 partial unique index 仲裁；
- 捕获的错误只有在明确命中 `idx_agent_run_parent_tool_unique` 或对应两字段 unique message 时才视为目标 race；
- 失败方重新调用 `findSubtaskRunByParentTool()`；
- 若查到 child，则返回 reused；
- 失败方本次创建的空壳 session按条件补偿；
- 若错误并非目标 unique constraint，或 race 后仍查不到 child，则原错误继续抛出。

P0 结论：已有真实 SQLite partial-unique 与目标 classifier 证据，但没有双独立 DB connection 的确定性并发交错测试。现有实现的唯一 race 次序是「事务失败 → 先 best-effort 删除本次 `createdSessionId` 空壳 → 目标 unique classifier → `findSubtaskRunByParentTool()` 查 winner → 返回 reused；查不到 winner 或非目标错误则保留原错误」。这项双连接竞态证据留待 P1，P2/P3 不得把它误写成已证明。

## Session mode 当前真值表

| mode/分支 | session 来源 | origin metadata | clone | start seed items |
|---|---|---|---|---|
| `new` | 新建 internal subtask session | parent session + parent tool item | 否 | prompt |
| `fork` + prefork summary | 新建 internal subtask session | parent session + parent tool item | 否 | summary → guard → prompt |
| `fork` + boundary | clone parent visible context 到新 subtask session | parent session + clone boundary | 是，copied item `runId=null` | guard → prompt |
| `fork` + no boundary | 新建 internal subtask session | 双空 | 否 | guard → prompt |
| `existing` | 使用已有 subtask session | 保持已有 metadata | 否 | prompt |

所有 fork 分支均写 guard。public primary fork 与 internal subtask fork 已在 `0008` 中分开，本阶段不得合并回一个 public 可绕过入口。

## Depth 与 profile 当前行为

- 预查未命中后才检查 parent depth；
- parent `subtaskDepth=null` 返回 `DepthUnknown`；
- child depth 固定为 `parentDepth + 1`；
- 超过 runtime `maxSubtaskDepth` 返回 `MaxDepthExceeded`；
- child profile 以 `surface="subtask"`、requested agent 与 workspace enablement 解析；
- child run 写入 resolved agent/provider/model、parent uiLocale、child depth 与真实 parent fields。

`0008` 已冻结 ordinary primary Run 固定 depth 0、双空 parent。本阶段只治理真实 child path，不重新讨论普通 Run lineage。

## Child activation 当前事务

当前 `startSubtaskRunFromWorker()` 在 session materialization 之后检查该 child session run-state 必须 idle，然后解析 profile/workspace，生成 prompt item 与 run ID。

随后单个 SQLite transaction 按顺序执行：

```text
prefork summary（可选，runId=null）
  → fork guard（fork mode，runId=null）
  → prompt user item（runId=childRunId）
  → createRunRecord(
       subtaskDepth=parent+1,
       parentRunId=真实 parent,
       parentToolItemId=真实 anchor
     )
  → updateRunState(
       status=running,
       activeRunId=childRunId,
       appliedItemId=promptItemId
     )
```

关键事实：

- session materialization/clone 不在该 activation transaction 中；因此失败时需要局部补偿；
- child session 的 idle 检查当前发生在 transaction 之前，transaction 内没有再次条件确认；P0 将其冻结为当前竞态事实。后续目标设计若增加 transaction 内 final check，必须保持既有 `SessionRunning` 产品规则，而不是新增“允许并发启动”的产品语义；
- seed items、child run 与 run-state 在同一 transaction 中，不能拆成 application 多次普通 CRUD；
- API 不 enqueue child；transaction 成功后只返回 workspacePath/agentName/sessionId/runId；
- Worker 根据 `reused` 决定执行 nested run 或轮询 existing run。

## Worker nested execution 当前行为

`BuiltinToolProvider` 当前：

- start response `reused=false` 时更新 parent tool item 的 session hint，然后调用 `ctx.processNestedRun()`；
- nested run 输入复制 parent 的 `workspaceRepoDirNames`；
- `reused=true` 时不调用 `processNestedRun()`，而是轮询 status；
- terminal child 直接读取 result；
- running reuse 按间隔轮询；
- parent abort 后不额外 complete child cancelled；
- failed/cancelled child 的 partial result 仍可进入 tool output/error 路径。

本阶段 API 结构迁移不得改变以上 Worker 时序。

## Result / Status 当前行为

两个查询均：

- 验证 session 存在；
- 验证 workspace 一致；
- 验证 run 存在且属于该 workspace/session。

status 直接映射 durable run record status。

result 从该 run 的 visible items 倒序选择：

- 最后一个非空 assistant text；
- 否则最后一个非空 system text；
- 否则空字符串。

因此 failed/cancelled child 可以返回已有 partial text。本阶段不引入新的 result storage 或终态语义。

## `subtaskSessionId` 当前边界

该值出现在 Worker result、tool item output、工具文本 header 和 cancelled 后 existing 提示中。它帮助：

- UI/模型看到 child session；
- Worker 继续轮询或读取结果；
- 用户/模型在提示中复用 existing session。

它不用于：

- DB unique arbitration；
- parent/child run 权威关系；
- Lifecycle cancel cascade 的唯一查询；
- orphan eligibility。

Lifecycle 可能解析该展示值来规整 cancelled tool output，但 durable child target 来自 run/tool lineage query。此差异必须持续写入测试与审查清单。

## Cancel child query 当前事实

`listSubtaskChildSessionIdsByRunId()` 通过 child run 与真实 parent tool join 查询：

- child `parent_run_id = parentRunId`；
- parent tool id 等于 child `parent_tool_item_id`；
- parent tool workspace/session/run 与输入一致；
- parent item `kind=tool` 且 `tool_name=subtask`。

结果按 child created/runId 排序并去重 sessionId。`RunLifecycleApplication` 通过 `ActiveSubtaskChildQuery.listByParentRun()` 使用它，不依赖完整 Subtask service。

## Local compensation 当前行为

`resolveSubtaskSessionForStart()` 返回 `createdSessionId`：

- `new/fork` 本次创建 session 时为新 id；
- `existing` 为 `null`。

后续 session-running、profile、workspace、transaction 等失败时：

- 只有 `createdSessionId` 非空才尝试 `deleteEmptySubtaskSessionIfStillEmpty()`；
- existing session 不进入删除路径；
- clone/prefork session 若已有 item/head/run，条件删除返回 0；
- unique race 失败方也先补偿自己的新空壳，再返回 winner reused response；更精确地说，inner catch 先 cleanup，再执行目标 unique classifier 与 winner lookup；lookup 命中时直接返回，因此不进入 outer catch。

当前实现具有嵌套的 transaction catch 与外层 start catch。部分 transaction 失败路径会先在内层 catch 对同一 `createdSessionId` 做一次 empty-session cleanup，错误继续抛出后又在外层 catch 再做一次 best-effort cleanup。由于删除带空状态条件且第一次成功后第二次返回 0，这通常表现为幂等重复尝试。

若为非目标 unique 错误、或目标 unique 冲突后仍查不到 winner，inner cleanup 后继续抛原错误，outer catch 再执行一次同参数 best-effort cleanup。final fence 同时要求 `kind=subtask`、可选 age/fork 条件、无非空 head、无 run、无 context item；clone/prefork target 一旦已有 copied/summary/guard item 不会被误删。

这类“同一失败路径尝试两次 cleanup”是当前控制流实现细节，不是产品语义要求。产品语义只要求：仅补偿本次创建且仍为空的 session、existing/winner/已有内容 session 不得误删、补偿不得覆盖原始错误。P0 必须记录各失败点的真实调用次数与结果，再决定 P3 迁移时保留嵌套形态，还是收敛为单一 best-effort cleanup 入口；不得在基线文档中预先把任一实现形态写成已冻结产品行为。

删除失败不得覆盖原始 start 错误；当前 helper 返回 changes，正常的 0 changes 由调用者忽略。

## Orphan scan 当前行为

`AgentService.scanAndCleanupSubtaskOrphansBestEffort(now)` 当前：

- suspect threshold：`now - 1 hour`；
- delete threshold：`now - 24 hours`；
- candidate 只包含 `kind=subtask`、老于 suspect、无非空 head、无 run、无 context item 的 session；
- 少于 24 小时或缺少 `forkedFromSessionId/forkedFromItemId` 的 candidate 只 warning 并保留；
- eligible candidate 调用条件删除，并要求 olderThan 和 fork lineage；
- SQL transaction 在 delete 时再次确认 kind、age、fork lineage、无 head、无 run、无 item；
- delete recheck 失败只记录 skipped；
- 单 candidate 异常 warning 后继续下一个；
- module 顶层再以 try/catch 隔离整个 scan。

当前 module 顺序是：routes 注册后执行 orphan scan，再执行 archive reconcile，再配置 lifecycle fail/recover，最后在 worker-enabled 时启动 Worker。此顺序是当前事实，不代表本阶段要把三个 startup use-case 合并。

## Startup 与 local fallback 当前边界

`registerAgentModule()` 当前顺序为：

```text
构造 AgentService
  → worker-enabled: AgentWorkerClient + WorkerProcessManager
    或 worker-disabled: AgentRuntime(LocalAgentRuntimeExecutionPort)
  → 可选 Plugin Host 启动
  → registerAgentRoutes(...)
  → subtask orphan startup scan（外层 warning 隔离）
  → archive pending reconcile（外层 warning 隔离）
  → startup fail/recover hook
```

- orphan list-query 顶层失败由 module outer catch 记录 `subtask orphan startup scan failed`，不会阻断 archive reconcile/fail-recover；candidate delete failure 由 service 内层 warning 隔离；
- `AgentRuntime` 仅接收 `LocalAgentRuntimeExecutionPort`：prompt context、context append/update、run state、complete 与 session query；该 port 没有 Subtask start/prefork/result/status 或 nested execution 成员；
- worker-disabled wiring 只把上述 local execution callbacks 从 `AgentService` 注入 `AgentRuntime`；没有构造 `AgentApiClient`、`BuiltinToolProvider`、`processNestedRun()` 或 Subtask-specific runtime port；
- 因而当前 local fallback **不支持 nested-subtask execution**。Subtask 的 API-managed start + Worker `processNestedRun()` 仅存在于 worker-enabled Worker 路径；本阶段后续不得为追求对称而补一套未定义的本地 nested runtime。

## 当前结构问题

- `AgentService` 同时持有 Subtask application、session materialization、lineage persistence 编排和 startup orphan policy；
- `agent.store.ts` 暴露跨域函数集合，lineage 与两类删除政策不可从文件/类型边界发现；
- child activation 与普通 Lifecycle activation 各自写 run/run-state，不同语义合理，但共同 run-state 不变量缺少显式协作合同；
- local compensation 与 orphan cleanup 共用同一公开删除 helper，容易在后续扩大参数时混淆政策；
- Subtask 证据大量集中在大型 `agent.integration.test.ts`，定位和结构审计成本高；
- module 直接调用 facade 方法，尚无 Subtask startup use-case/wiring 证据。

## 当前测试证据索引

### Shared

- endpoint registry 的四个 Subtask path/method；
- session union、prefork meta、start response；
- stable Subtask error code 集合。

### API integration

现有大集成文件覆盖的主题包括：

- run lineage 与 parent tool 查询；
- cancel cascade 不依赖 `subtaskSessionId`；
- conservative orphan scanner 与单 candidate isolation；
- start failure 仅补偿本次新建空壳，不删除 existing；
- parent tool partial unique index 与错误识别；
- anchor validation；
- `new/fork/existing`、depth、幂等、prefork metadata 与 item 顺序；
- result/status 与 failed partial text；
- active child 精确 cancel，不误取消历史 child；
- prompt depth 工具可见性与 workspace enablement。

### Worker

- `builtin.prefork.test.ts`：plan、summary、meta、降级、abort；
- `provider-subtask-cancel.test.ts`：reuse polling、terminal result、parent abort；
- `runner.tool-output.test.ts`：tool output 与 session hint；
- `builtin.read.test.ts`：nested run workspace repository inputs；
- `apiClient.test.ts`：Shared endpoint 与 response validation。

## P0/P1 必须补强或确认的证据

- P0 已通过既有 integration/Worker/Shared tests 与符号审计冻结 endpoint/schema/error code、prefork summary 降级/abort、anchor errors、mode 真值表、activation transaction、Worker nested/reuse、partial result/status、cancel durable child query、compensation、orphan final fence/candidate isolation、module顺序与 local fallback 无 nested-subtask 边界；
- P0 已确认 target unique conflict 的准确控制流和 cleanup/winner 优先级，但尚未建立双独立 SQLite connection 的确定性并发交错 harness；P1 必须在真实 `openDb()`/schema 下补足「最终单 child、loser reused、无多余空壳」证据；
- P0 未新增 fake store，也未为制造 race 改动生产 seam；当前 synchronous SQLite transaction 与单进程 request path 无可控 interleave seam，不能用 monkey-patch 或伪造 store 将「同连接预置冲突」误称为双 start race；
- session-running/profile/workspace/transaction 的 compensation 矩阵中，已有 API integration 直接证明 transaction failure 的 created-vs-existing 分界；其余失败点的完整 fixture 矩阵留给 P1 persistence/application test 地基，而非在 P0 引入新 production test hook；
- P1/P2 应新增明确 wiring test，防止 future `SubtaskApplication` 或 nested activator 注入 worker-disabled 分支；P6 全量 Worker 回归时必须复核 `0008` 所述历史测试例外是否仍存在。
