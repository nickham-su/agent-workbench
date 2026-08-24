# 代码地图与改动面

> 行号基于本方案编写时的最新工作区，仅用于快速定位。实施前应按符号重新搜索，不应依赖固定行号。

## 核心调用链

### Public Primary Create

```text
Web AgentToolView.ensureSessionCreated
  → apps/web/src/shared/api/api.ts:createAgentSession
  → POST /api/agent/sessions
  → apps/api/src/modules/agent/agent.routes.ts
  → AgentService.createSession（当前）
  → agent.store.ts:createAgentSession
```

目标：Route 改为只接收workspace/title的primary-only service入口；该入口不接fork metadata。public fork target由fork application经private materializer创建。

### Generic Internal Primary Create

```text
plugins/feishu/src/index.ts
  → POST /api/internal/agent/sessions/create
  → agent.routes.ts
  → AgentService.createSession（当前）
```

目标：保持插件创建primary；request移除kind；不能创建subtask。

### Public Fork

```text
AgentClientPane.onForkFromMessage
  → api.ts:forkAgentSession
  → POST /api/agent/sessions/fork
  → agent.routes.ts
  → AgentService.forkSession（当前）
  → createAgentSession + appendContextItem + archive sidecar
```

目标：改为 `forkPrimarySession` 或等价入口，source/target primary固定。

### Primary Message Run

```text
POST /api/agent/sessions/:id/messages
  → AgentService.sendMessage
  → resolveRunLineageForSession（当前错误）
  → createRunRecord
  → runtime.enqueueRun
```

目标：移除lineage，写 `0/null/null`。

### Primary Compact Run

```text
POST /api/agent/sessions/:id/compact
  → AgentService.compactSession
  → resolveRunLineageForSession（当前错误）
  → createRunRecord
```

目标：写 `0/null/null`。

### Subtask Tool

```text
Worker BuiltinToolProvider.execute(subtask)
  → AgentApiClient.startSubtaskRun
  → POST /api/internal/agent/subtask/start
  → AgentService.startSubtaskRunFromWorker
  → resolveSubtaskParentContext
  → childDepth = parentDepth + 1
  → new / fork / existing session
  → createRunRecord(real parent fields)
  → Worker processNestedRun
```

目标：保持业务，仅替换内部session create/context clone依赖。

### Prompt Tool Projection

```text
Worker请求prompt context
  → read-side application/projector
  → PromptStaticAssembler.assemble
  → run.subtaskDepth < maxSubtaskDepth
  → tools snapshot
  → Worker BuiltinToolProvider.listTools
  → model request tools
```

目标：生产逻辑不改。

## 文件级代码地图

### `apps/api/src/modules/agent/agent.service.ts`

#### `createSession()`

当前约 `2309-2335`。

当前问题：

- 接受可选kind；
- public/internal/subtask共同复用；
- request可以决定entity kind。

目标：

- public/internal primary专用入口；
- private subtask create；
- 底层共享持久化可以保留。

#### `forkSession()`

当前约 `2337-2483`。

当前职责：

- source/boundary读取；
- public boundary校验；
- visible/archive选择；
- target kind选择；
- item clone；
- archive sidecar和rollback；
- internal通过`allowAnyKindBoundary`复用。

目标：

- 提取clone原语；
- public primary fork专用编排；
- internal subtask fork专用编排；
- 移除public可见kind和internal override泄漏。

函数名可调整，但固定方向是public Route→primary fork application→private clone/materializer，以及internal subtask start→private subtask fork application→private clone/materializer。

关键不变量：clone item `runId:null`。

#### `sendMessage()`

当前约 `2485-2607`。

目标修改：

```text
subtaskDepth: 0
parentRunId: null
parentToolItemId: null
```

保持：read-only/workspace/dedup/run-state/profile/transaction/enqueue合同。

#### `compactSession()`

当前约 `2682-2789`。

目标同上；保持compact业务。

#### `resolveSubtaskParentContext()`

当前约 `3560-3591`。

保持：parent session/Run/tool anchor归属和toolName校验。

#### `resolveRunLineageForSession()`

当前约 `3593-3646`。

目标：删除。其职责不应转移到其他ordinary primary helper。

#### `startSubtaskRunFromWorker()`

当前约 `3702` 起。

关键区域：

- existing child幂等：约`3787-3803`；
- depth校验：约`3805-3812`；
- fork boundary：约`3814-3821`；
- mode分支：约`3824-3884`；
- summary/guard/prompt/Run事务：约`3900-3980`；
- 创建失败清理：后续catch。

目标：

- new/fork用private subtask session能力；
- fork用clone原语；
- existing不变；
- child Run depth/parent不变。

分支metadata必须按真值表冻结：

- new：parent session/tool；
- fork summary：parent session/tool；
- fork clone：parent session/clone boundary；
- fork null boundary：双空；
- existing：保持既有值。

所有fork路径写guard；summary路径顺序为summary→guard→prompt；null boundary为guard→prompt；existing只追加prompt。

#### `resolveSubtaskForkBoundaryItemId()`

保持internal boundary解析；不得拿来做public fork校验。

### `apps/api/src/modules/agent/agent.routes.ts`

#### Public Create

当前约 `201-215`：body含kind，调用`createSession(body)`。

目标：body无kind，primary-only。

#### Public Fork

当前约 `217-242`：body含kind，调用`forkSession(body)`。

目标：body无kind，调用public primary fork。

#### Internal Subtask Routes

约 `getSubtaskPreforkPlan/start/result/status` 路由。

保持contract/path/token校验。

#### Generic Internal Create

当前约 `756-770`：body含kind，调用`createSession(body)`。

目标：body无kind，primary-only。

#### Internal Run Trigger

当前约 `773-819`：委派sendMessage。

保持并以测试证明depth0。

### `apps/api/src/modules/agent/agent.store.ts`

#### Entity映射

- `AgentSessionRow`：约`23-33`；
- `AgentRunRecord`映射：约`350+`；
- `mapSession()`：约`442+`。

原则上不改。

#### `createAgentSession()`

约`736-789`。

保持显式kind，供application专用入口使用。

#### Context Item Append/Fence

约`919+`、`931+`。

保持run/session ownership语义；这是copied item不得复制runId的依据。

#### `createRunRecord()`

约`1703-1768`。

保持nullable type以读取/构造历史异常；production caller规则由service保证。

#### `findSubtaskRunByParentTool()`

约`1803+`。

保持幂等。

#### `listSubtaskChildSessionIdsByRunId()`

约`1971-1995`。

通过parent tool join识别真实child；cancel cascade依赖它。

### `apps/api/src/infra/db/schema.ts`

- `agent_session`：约`94-104`；
- `agent_context_item`：约`139-165`；
- `agent_run`：约`167-182`；
- parent tool unique index：后续index段。

本次不改schema/ensureColumn。

### `packages/shared/src/contracts/agent.ts`

- `AgentSessionKindSchema`：约`9`，保持；
- `AgentSessionRecordSchema`：约`97-108`，保持kind；
- `AgentContextItemRecordSchema.runId`：约`110+`，保持nullable；
- `AgentCreateSessionRequestSchema`：约`376-381`，移除kind；
- `AgentInternalCreateSessionRequestSchema`：约`383-391`，移除kind；
- `AgentForkSessionRequestSchema`：约`485-491`，移除kind。

三个request显式`additionalProperties:false`，三个Route使用endpoint-local `preValidation`字段allowlist；P0必须先用真实`createApp()`证明hook可见原始key，P2以400、service未调用和无数据落盘为验收。不可行时暂停回设计。

### `packages/shared/src/internal-contracts/agent-api-subtask.ts`

- `AgentApiSubtaskSessionSchema`：`new/existing/fork`；
- start request/response；
- `AgentSubtaskErrorCode`。

保持；public fork新错误不应混入subtask错误集合。

### `apps/api/src/modules/agent/prompt/prompt-static-assembler.ts`

`PromptStaticAssembler.assemble()`约`62-123`。

关键规则约`95`：

```ts
input.run.subtaskDepth != null
  && input.run.subtaskDepth < getMaxSubtaskDepth()
```

生产逻辑不改；补回归测试。

### `apps/api/src/modules/agent/read-side/`

- `prompt-context-projector.ts`；
- `read-side-application.ts`；
- execution/messages projectors。

最新迭代后的read-side边界。本次不迁移write-side逻辑到这些模块，也不增加session kind override。

### `apps/agent-worker/src/runtime/tools/providers/builtin.ts`

subtask执行约`600-750`；start payload约`713-724`：

```ts
parentSessionId
parentRunId
parentToolItemId
session: parsed.session
```

保持。

### `apps/agent-worker/src/runtime/apiClient.ts`

`startSubtaskRun()`保持internal contract。

### Web

#### `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

`ensureSessionCreated()`当前只发送workspace/title，兼容contract收紧。

#### `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

`onForkFromMessage()`当前只发送source/item/mode，兼容contract收紧。

#### `apps/web/src/shared/api/api.ts`

`createAgentSession()`和`forkAgentSession()`依赖Shared类型，通常只需编译验证。

#### i18n

`apps/web/src/shared/i18n/locales/zh-CN.ts`及英文对应文件中的`maxSubtaskDepth.help`需要更新产品语义。

### Plugin

`plugins/feishu/src/index.ts`约`793`调用generic internal create，不传kind。需要构建/测试验证。

## 重点测试位置

### `apps/api/src/modules/agent/agent.integration.test.ts`

- 普通Run depth与compact测试：约`2200+`；
- 旧错误规格测试：约`2278-2395`，必须替换；
- subtask start depth/mode/幂等：约`2397+`；
- existing异常场景：约`2098+`、`2428+`；
- prompt工具描述/可见性：约`1400+`、`4000+`；
- subtask fork guard：约`5900+`；
- cancel cascade/orphan：约`4400+`；
- public create subtask fixture：多处，需要系统搜索迁移。

### `apps/api/src/modules/agent/prompt/prompt-static-assembler.test.ts`

保持/补depth工具投影矩阵。

### `apps/api/src/modules/agent/read-side.api.test.ts`

可补真实prompt context工具快照证据。

### `packages/shared/tests/internal-contracts.test.ts`

existing contract保持；增加/调整create/fork public contract测试所在相应Shared测试。

### Worker Tests

- `builtin.prefork.test.ts`；
- `provider-subtask-cancel.test.ts`；
- `apiClient.test.ts`；
- nested/tool output tests。

目标是证明internal contract和nested流程未变。

## 搜索型审查命令

实施后建议搜索：

```bash
rg -n "resolveRunLineageForSession" apps/api/src
rg -n "allowAnyKindBoundary" apps/api/src
rg -n "kind:\s*[\"']subtask[\"']" apps/api/src plugins packages
rg -n "createRunRecord\(" apps/api/src/modules/agent
rg -n "parentRunId:" apps/api/src/modules/agent/agent.service.ts
rg -n "AgentCreateSessionRequestSchema|AgentInternalCreateSessionRequestSchema|AgentForkSessionRequestSchema" packages/shared/src
```

预期：

- 前两个无生产命中；
- `kind:subtask` 生产命中只在private subtask创建；测试fixture可有明确命中；
- `createRunRecord` production调用仍只有message/compact/subtask；
- parentRunId非空写入只在subtask child。
