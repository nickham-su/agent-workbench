# 技术方案与实体设计

## 总体架构

```text
Global Agent Settings
  AgentItem.defaultModel
            │ fallback
            ▼
agent_session_agent_model_override
  (session_id, agent_id) → provider_id, model_id
            │
            ▼
SessionAgentModelResolver
  校验 session / workspace / agent / provider / model / credential
            │
            ├─ GET/PUT/DELETE → AgentSessionAgentModelState → Web 回显
            │
            └─ create new Run → resolved provider/model
                                   │
                                   ▼
                           agent_run snapshot
                                   │
                                   ▼
                         Worker ExecutionProfile
```

本方案必须保持单一解析语义：UI effective state 与新 Run 模型解析必须复用同一领域 helper 或同一组严格一致的校验函数，不能各自实现一套优先级。

## 持久化实体

### 表定义

在 `apps/api/src/infra/db/schema.ts` 的 SQLite 初始化脚本中新增：

```sql
create table if not exists agent_session_agent_model_override (
  session_id text not null,
  agent_id text not null,
  provider_id text not null,
  model_id text not null,
  updated_at integer not null,
  primary key (session_id, agent_id),
  foreign key (session_id)
    references agent_session(id)
    on delete cascade
);

create index if not exists idx_agent_session_model_override_agent
  on agent_session_agent_model_override(agent_id);
```

### 字段语义

| 字段 | 语义 | 约束 |
|---|---|---|
| `session_id` | 覆盖所属真实服务端 Session | 非空，外键级联删除 |
| `agent_id` | 被覆盖的 Agent 稳定 ID | 非空，与 session 组成主键 |
| `provider_id` | 主模型 Provider ID | 非空，不保存凭据 |
| `model_id` | 主模型 Model ID | 非空 |
| `updated_at` | 最后成功 PUT 的服务端毫秒时间戳 | 非空，有限正整数 |

### 不冗余 workspace_id

首版表中不保存 `workspace_id`。理由：

- `agent_session.id` 是主键，Session 归属由 `agent_session.workspace_id` 唯一确定；
- 冗余字段会增加 workspace 与 session 不一致风险；
- 所有读写必须先加载 Session 并校验请求 workspace；
- 查询规模按单 Session，使用主键前缀已足够。

如果实施时项目数据库规范强制所有 Agent 子表冗余 `workspace_id`，必须同时增加一致性约束或在同一事务内从 Session 派生，不能信任客户端重复字段；否则遵循本设计不冗余。

### 不为 Agent、Provider、Model 建外键

这些对象当前来自全局 Settings JSON，不是独立关系表，无法建立数据库外键。完整性由应用层校验：

- PUT 时强校验；
- GET/Run 创建时重新校验，处理后续配置失效；
- 不因后续失效自动删除覆盖事实。

### 数据生命周期

| 事件 | 覆盖记录行为 |
|---|---|
| 新建 Primary Session | 无记录，继承全局默认 |
| PUT 覆盖 | UPSERT 当前键 |
| DELETE/重置 | 删除当前键 |
| 删除 Session | 外键级联删除全部覆盖 |
| Fork Session | 不复制 |
| 创建 Subtask Session | 不复制 |
| Agent/Provider/Model 被删除 | 记录保留，读取时标记 invalid |
| Agent 后续恢复/模型重新可用 | 记录重新按当前配置校验并可能恢复 ready |

旧数据库不需要数据回填：无记录即继承默认。

## Store 设计

建议在 Agent Store 或独立 Session Model Override Store 中提供：

```ts
type SessionAgentModelOverrideRecord = {
  sessionId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  updatedAt: number;
};

getSessionAgentModelOverride(db, {
  sessionId,
  agentId
}): SessionAgentModelOverrideRecord | null;

listSessionAgentModelOverrides(db, {
  sessionId
}): SessionAgentModelOverrideRecord[];

upsertSessionAgentModelOverride(db, record): void;

deleteSessionAgentModelOverride(db, {
  sessionId,
  agentId
}): boolean;
```

约束：

- Store 不做 Provider/Model 业务校验；
- `upsert` 使用单条 `insert ... on conflict(session_id, agent_id) do update`；
- `updatedAt` 由服务端时钟生成；
- `delete` 返回是否实际删除，Application 对外仍保持幂等；
- 列表按全局 Agent 顺序投影，不依赖数据库默认顺序；
- Store 测试必须验证 Session 删除级联清理。

## 领域读模型

### 共享契约

在 `packages/shared/src/contracts/agent.ts` 中新增独立契约，不复用只表达全局默认的 `AgentResolvedModelSourceSchema`。

推荐定义：

```ts
export const AgentSessionModelSourceSchema = Type.Union([
  Type.Literal("session_override"),
  Type.Literal("agent_default")
]);

export const AgentSessionModelStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("invalid"),
  Type.Literal("missing")
]);

export const AgentSessionModelRefSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
}, { additionalProperties: false });

export const AgentSessionModelOverrideSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  updatedAt: Type.Number({ exclusiveMinimum: 0 })
}, { additionalProperties: false });

export const AgentSessionEffectiveModelSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  providerName: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  modelName: Type.String({ minLength: 1 }),
  contextWindowTokens: Type.Number({ minimum: 1 })
}, { additionalProperties: false });

export const AgentSessionAgentModelStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  agentName: Type.String({ minLength: 1 }),
  editable: Type.Boolean(),
  agentDefaultModel: Type.Union([AgentSessionModelRefSchema, Type.Null()]),
  override: Type.Union([AgentSessionModelOverrideSchema, Type.Null()]),
  effectiveModel: Type.Union([AgentSessionEffectiveModelSchema, Type.Null()]),
  source: AgentSessionModelSourceSchema,
  status: AgentSessionModelStatusSchema,
  reasonCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  message: Type.Union([Type.String({ minLength: 1 }), Type.Null()])
}, { additionalProperties: false });
```

响应：

```ts
export const AgentSessionModelOverridesResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  items: Type.Array(AgentSessionAgentModelStateSchema)
}, { additionalProperties: false });
```

请求：

```ts
export const UpdateAgentSessionModelOverrideRequestSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
```

GET/DELETE query：

```ts
export const AgentSessionModelWorkspaceQuerySchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 })
}, { additionalProperties: false });
```

### 状态不变量

- `override !== null` → `source = session_override`；
- `override === null` → `source = agent_default`；
- `source` 只表示当前选择或应尝试解析的配置层，不表示该层必然存在、有效或可执行；
- `status = ready` → `effectiveModel !== null` 且 `reasonCode/message = null`；
- `status = invalid|missing` → `reasonCode !== null`；
- 是否允许创建新 Run 必须由 `status = ready` 决定，不得只判断 `source`；
- `editable = true` 仅表示 Session 为 Primary 且 Agent 当前允许 user surface、对 workspace 启用；
- Subtask 不通过本 API 投影可编辑状态；前端不请求；
- API 不返回 API key、base URL 等敏感 Provider 配置。

### 来源字段使用准则

来源枚举必须按使用面隔离，不能为了复用类型把不同生命周期的来源混入同一字段：

| 使用面 | 允许来源 | 语义 |
|---|---|---|
| Session 模型状态 GET/PUT/DELETE | `session_override`、`agent_default` | 当前 Session 配置层；不包含 Run 生命周期 |
| 新 Run 创建前的内部解析结果 | `session_override`、`agent_default` | 本次新 Run 快照写入前采用的配置层 |
| 已创建 Run 的执行与诊断 | `run_snapshot` | provider/model 已来自 `agent_run`，不得再声称是当前 Session 配置 |
| Vision profile | 保持现有 `runtime_vision`、`agent_default_fallback` 等独立来源 | 不进入 Session 主模型来源枚举 |
| Compaction profile | 保持现有 `runtime_compaction` 及主模型 fallback 语义 | 不进入 Session 主模型来源枚举 |

硬约束：

- `AgentSessionModelSourceSchema` 只能包含 `session_override | agent_default`，不得加入 `run_snapshot`、vision 或 compaction 来源；
- Run 诊断或执行 profile 读取 `agent_run.provider_id/model_id` 时，来源必须是 `run_snapshot`；
- `source = agent_default` 只说明“没有 override，当前进入默认配置层”，不保证 Agent、`defaultModel`、Provider、Model 或凭据可解析；
- 所有 UI、API 消费者、自动测试和验收必须结合 `status/reasonCode` 判断可用性；只检查 `source` 的实现不通过代码审查；
- vision/compaction 的来源、优先级和 fallback 继续使用现有独立字段，不得映射为 `session_override` 或 `agent_default`。

### 标准 JSON 示例

以下示例是接口、前端状态映射和契约测试的标准基线。实际 ID、名称和时间可变化，字段组合与语义不得变化。

#### 无 override，默认模型可用

```json
{
  "sessionId": "sess_001",
  "agentId": "agent_coder",
  "agentName": "Coder",
  "editable": true,
  "agentDefaultModel": {
    "providerId": "provider_openai",
    "modelId": "gpt-4.1"
  },
  "override": null,
  "effectiveModel": {
    "providerId": "provider_openai",
    "providerName": "OpenAI",
    "modelId": "gpt-4.1",
    "modelName": "GPT-4.1",
    "contextWindowTokens": 1048576
  },
  "source": "agent_default",
  "status": "ready",
  "reasonCode": null,
  "message": null
}
```

#### override 可用

```json
{
  "sessionId": "sess_001",
  "agentId": "agent_coder",
  "agentName": "Coder",
  "editable": true,
  "agentDefaultModel": {
    "providerId": "provider_openai",
    "modelId": "gpt-4.1"
  },
  "override": {
    "providerId": "provider_anthropic",
    "modelId": "claude-sonnet-4",
    "updatedAt": 1735689600000
  },
  "effectiveModel": {
    "providerId": "provider_anthropic",
    "providerName": "Anthropic",
    "modelId": "claude-sonnet-4",
    "modelName": "Claude Sonnet 4",
    "contextWindowTokens": 200000
  },
  "source": "session_override",
  "status": "ready",
  "reasonCode": null,
  "message": null
}
```

#### override 已失效

```json
{
  "sessionId": "sess_001",
  "agentId": "agent_coder",
  "agentName": "Coder",
  "editable": true,
  "agentDefaultModel": {
    "providerId": "provider_openai",
    "modelId": "gpt-4.1"
  },
  "override": {
    "providerId": "provider_anthropic",
    "modelId": "claude-sonnet-4",
    "updatedAt": 1735689600000
  },
  "effectiveModel": null,
  "source": "session_override",
  "status": "invalid",
  "reasonCode": "AGENT_MODEL_NOT_FOUND",
  "message": "本会话覆盖模型不可用"
}
```

该状态不得回退 `agentDefaultModel` 创建 Run；用户必须更新覆盖或执行重置。

#### DELETE 后默认层缺失

```json
{
  "sessionId": "sess_001",
  "agentId": "agent_removed",
  "agentName": "agent_removed",
  "editable": false,
  "agentDefaultModel": null,
  "override": null,
  "effectiveModel": null,
  "source": "agent_default",
  "status": "missing",
  "reasonCode": "AGENT_NOT_FOUND",
  "message": "覆盖已删除，但 Agent 或默认模型不存在"
}
```

此例中 `source = agent_default` 仅表示 DELETE 后已无 override，解析器应进入默认配置层；`status = missing` 和 `reasonCode = AGENT_NOT_FOUND` 才是“不可创建新 Run”的判定依据。实现和验收不得把该响应误解为存在可用默认模型。

## API 设计

### GET Session 模型状态

```http
GET /api/agent/sessions/:sessionId/model-overrides?workspaceId=:workspaceId
```

响应 `200 AgentSessionModelOverridesResponse`。

投影集合固定为：

- 当前 Workspace 对 user surface 可用的所有 Agent；
- 加上该 Session 中存在持久化 override、但当前 Agent 已删除/禁用/不允许 user 的键，后者 `editable=false` 且状态为 invalid。

这样既支持所有 Agent 切换后的即时回显，也不会静默隐藏孤立覆盖。Web 的 Agent 选择器仍只展示当前可用 Agent。

若 override 指向的 Agent 已不存在，投影中的 `agentName` 固定回退为 `agentId`，`agentDefaultModel = null`、`effectiveModel = null`、`editable = false`，并返回稳定的 Agent 不存在原因码。不得因为展示名称不可解析而丢弃该覆盖事实。

GET 处理：

- 加载 Session；
- 校验 `session.workspaceId === query.workspaceId`；
- 要求 `session.kind = primary`，否则返回不可编辑错误；
- 列出 Session 覆盖；
- 读取当前 Agent/Provider/runtime/Workspace enablement 配置；
- 对 Agent 集合逐个投影状态，不因单个 Agent invalid 使整个 GET 失败；
- 返回稳定排序结果。

### PUT 设置覆盖

```http
PUT /api/agent/sessions/:sessionId/agents/:agentId/model-override
Content-Type: application/json

{
  "workspaceId": "ws_xxx",
  "providerId": "provider_xxx",
  "modelId": "model_xxx"
}
```

响应：`200 AgentSessionAgentModelState`，必须是写入后的状态。

校验顺序：

- Session 存在且归属 workspace；
- Session 必须为 Primary；
- Agent 存在；
- Agent scope 允许 `user`；
- Agent 对 Workspace 启用；
- Provider 存在；
- Model 属于该 Provider；
- Provider 必要凭据已配置；
- 在事务中 UPSERT；
- 重新投影并返回 `session_override/ready`。

PUT 不允许保存 invalid 覆盖。后续因全局配置变化而失效则由读侧报告。

### DELETE 重置覆盖

```http
DELETE /api/agent/sessions/:sessionId/agents/:agentId/model-override?workspaceId=:workspaceId
```

响应：`200 AgentSessionAgentModelState`，不返回空 `204`。

处理规则：

- Session 存在且归属 workspace；
- Session 必须为 Primary；
- 删除键，记录不存在也视为成功；
- 不要求旧 override 当前有效；
- 不要求 Agent 当前启用，保证孤立覆盖可清理；
- 返回删除后的 `agent_default` 状态；若 Agent 已不存在或默认不可用，则返回 invalid/missing 状态而不是回滚删除。

Agent 已不存在时，DELETE 响应仍使用路径中的 `agentId`，`agentName` 回退为该 ID。`source = agent_default` 表示“覆盖已删除、当前进入默认继承层”，不保证该层能够解析；`status = missing` 与 `reasonCode` 才明确表示默认层无法解析 Agent。实现、UI 与验收不得只检查 `source`，也不得把该状态展示为“默认模型可用”或放开新 Run。

当当前 Workspace 对该 Primary Session 没有任何可用 user Agent，GET 可以返回 `items = []`。Web 必须隐藏模型入口，并继续使用现有 Agent 不可用逻辑阻止发送；孤立 override 的不可编辑投影不能被当作可选 Agent。

### HTTP 与错误合同

| 条件 | 状态码 | 约束 |
|---|---:|---|
| 成功 GET/PUT/DELETE | 200 | 返回 schema 化状态 |
| body/query/schema 非法 | 400 | Fastify/shared schema 拒绝 |
| Session 不存在/不属于 workspace | 遵循现有隐藏归属策略，推荐 404 | 不泄漏跨 Workspace Session |
| Subtask/非 Primary | 409 或现有领域习惯的 400 | 稳定错误码 `AGENT_SESSION_MODEL_OVERRIDE_NOT_EDITABLE` |
| Agent/scope/enablement/provider/model/credential 无效 | 400 | 复用现有稳定错误码 |
| 同 Session 正在执行 | 不阻止配置写入 | 只影响后续新 Run |

## 领域服务与解析器

### 推荐端口

建议在 Agent 模块增加统一领域服务，而不是在 Route、Web DTO 和 Run 创建路径分别拼接：

```ts
type ResolveSessionAgentModelInput = {
  workspaceId: string;
  sessionId: string;
  requestedAgentId?: string | null;
  surface: "user";
  purpose: "read_state" | "create_run";
};

type ResolvedNewRunProfile = {
  agentId: string;
  providerId: string;
  modelId: string;
  modelSource: "session_override" | "agent_default";
};
```

职责：

- 加载并校验 Session；
- 通过现有规则解析最终 Agent；
- 按最终 Agent ID 查询 override；
- 把 override 作为完整 provider/model 对交给 execution profile 解析；
- 返回有效状态或抛出领域错误；
- 为 API read state 生成不抛单项 invalid 的投影。

### 模型候选必须原子化

现有 `resolveExecutionProfile()` 分别从数组选择 providerId 和 modelId。引入覆盖时不得允许“Provider 来自覆盖、Model 来自默认”的混合候选。

推荐把模型候选表达为完整对象：

```ts
type ExecutionModelCandidate =
  | {
      source: "run_snapshot";
      providerId: string;
      modelId: string;
    }
  | {
      source: "session_override";
      providerId: string;
      modelId: string;
    }
  | null;
```

解析规则：

```text
如果存在完整 run snapshot
  → 使用 run snapshot
否则如果存在完整 session override
  → 使用 session override
否则
  → 使用完整 Agent defaultModel
```

任一来源出现半对字段都视为数据损坏/配置缺失，不得与下一层拼接。

### 现有 resolveExecutionProfile 改造

逻辑优先级应变为：

```ts
const selectedModel = runSnapshot
  ?? sessionOverride
  ?? agent.defaultModel;
```

随后统一执行：

- Provider 查找；
- Model 归属查找；
- API Key 校验；
- vision profile 现有解析；
- compaction profile 现有解析。

注意：

- `sessionOverride` 只替换返回 profile 的主 `provider/model`；
- vision 和 compaction 继续走现有 runtime 配置；
- Worker 按 Run 查询 profile 时只传 `runSnapshot`，不传 Session override；
- Subtask 创建 profile 时不传父 Session override。

## 新 Run 链路

### 普通消息

目标调用链：

```text
AgentClientPane.send()
  → POST /sessions/:sessionId/messages { workspaceId, agentId, ... }
  → SessionInteractionApplication.sendMessage()
  → profileReader.resolveUser({ workspaceId, sessionId, requestedAgentId })
  → SessionAgentModelResolver
  → override ?? agent.defaultModel
  → startUserRun({ agentId, providerId, modelId })
  → createRunRecord()
  → agent_run snapshot
  → Worker getExecutionProfile(runId)
  → run_snapshot
```

必须修改 `profileReader.resolveUser` 端口，让 `sessionId` 成为必填输入。当前只传 `workspaceId/requestedAgentId` 的实现不足以读取覆盖。

### 手动压缩

目标调用链：

```text
ManualCompactionApplication.schedule()
  → resolveProfile({ workspaceId, sessionId, requestedAgentId })
  → SessionAgentModelResolver
  → createRunRecord(main provider/model snapshot)
  → Worker receives __awb_compact__
  → selectCompactionModel()
      runtime.compactionModel 优先
      否则 run main model
```

必须给手动压缩的 `resolveProfile` 端口增加 `sessionId`。但不得把 Session override 直接覆盖 `profile.compaction`。

### Subtask

保持：

```text
SubtaskApplication.startSubtask()
  → resolveExecutionProfile(surface=subtask, requestedAgentId)
  → Agent global defaultModel
  → child agent_run snapshot
```

不得传 parentSessionId 用于覆盖查询，不复制父覆盖。

### 已有 Run / Worker

保持：

```text
getExecutionProfile(runId)
  → load agent_run.agent_id/provider_id/model_id
  → resolveExecutionProfile(runSnapshot)
  → Worker profile
```

若存在来源字段，必须标记 `run_snapshot`。当前 `getSingleCallModelProfileForRun()` 中固定 `source: "agent_default"` 的实现需纳入审查，避免诊断误导。

## 前端状态设计

### 状态分层

建议在 `AgentToolView.vue` 或提取的 composable 中维护：

```ts
type SessionAgentModelStateMap = Record<
  string, // sessionId
  Record<string, AgentSessionAgentModelState> // agentId
>;
```

与现有状态分工：

| 状态 | 来源 | 是否服务端事实 |
|---|---|---|
| `selectedAgentBySession` | localStorage | 否，UI 偏好 |
| `agentOptions` | Workspace available Agents API | 全局/Workspace Agent 可用性 |
| `sessionAgentModelStates` | 新 GET/PUT/DELETE API | 是，Session 模型状态 |
| 当前 Run 模型 | `agent_run` / execution profile | 是，Run 快照 |

### 加载策略

最低要求：

- Session 激活或 Pane 首次挂载时加载该 Session 的 model states；
- 切换 Agent 时读取 map，不存在则刷新当前 Session；
- PUT/DELETE 直接用响应替换对应 state；
- 全局 Agent 设置被其他 UI 更新后，调用既有 `refreshAgents()` 并刷新当前可见 Session states；
- 页面刷新不能先长期显示错误的全局标签；加载期间显示 skeleton/“加载中”，不能把 global label 当最终值闪现。

允许优化：

- 多个可见 Session 并发 GET；
- 按 `sessionId` 去重 pending 请求；
- 仅缓存当前页面生命周期，不把覆盖复制到 localStorage；
- Session 关闭时释放缓存，重新打开再 GET。

### 模型标签计算

推荐：

```ts
const modelState = sessionAgentModelStates[sessionId]?.[effectiveAgentId];
const effectiveModelLabel =
  modelState?.status === "ready"
    ? modelState.effectiveModel?.modelName ?? ""
    : modelState?.message ?? "";
```

不得继续只使用：

```ts
currentAgentOption.value?.resolvedModel
```

`agentOptions.resolvedModel` 只可作为无 Session state 时的短时 skeleton 辅助，不得作为保存后/刷新后的最终显示事实。

### 草稿转换

`ensureSessionCreated(draftId)` 返回真实 ID 后，需要迁移或重新加载模型 state：

- draft 不应有任何服务端 model state；
- 不创建 `draftId` override 缓存；
- 真实 Session 初始无 override，应显示全局默认；
- 通过 pending modal intent 处理 Pane 重建；
- 不把模型选择先暂存到 draft 再迁移。

## 事务与并发语义

### PUT/DELETE 线性化点

- PUT：UPSERT 事务提交；
- DELETE：DELETE 事务提交；
- 新 Run：服务端读取覆盖并确定 profile 的时点。

承诺：

- 请求在 PUT/DELETE 响应后才开始解析，必须看到新状态；
- 与配置提交重叠的新 Run 取决于覆盖读取先后；
- 已解析 profile 的 Run 不因后续配置提交而改变。

### Run 创建一致性

解析 profile 后到 `createRunRecord()` 之间即使覆盖又改变，本次 Run 仍使用已解析值。这是 Run 快照语义，不是竞态缺陷。

无需把配置读取与 Run 插入放在同一长事务，只需保证：

- 读取来自已提交数据；
- 解析结果完整传给生命周期；
- Run 插入不重新回退全局默认；
- Worker 不重算 Session override。

## 兼容与迁移

### 数据库

- 使用 `create table if not exists`，旧库启动自动创建；
- 不回填旧 Session；
- 无覆盖记录完全兼容原行为；
- 回滚业务代码前若保留新表，不影响旧版本读取；
- 回滚时不得执行破坏性 drop table。

### API 与 Shared

- 新增独立端点，不改变现有消息 body；
- `AgentSendMessageRequestSchema` 保持不含 provider/model；
- 现有 `/settings/agent/agents` 继续供 Settings 页使用；
- 工具 Tab 删除对 `updateAgentSettings()` 的依赖，不删除全局 API；
- 新 shared 字段/响应均为新端点使用，不破坏旧客户端。

### 前端

- localStorage key 和选中 Agent 恢复保持兼容；
- 旧 localStorage 中失效 Agent ID 继续由现有有效 Agent 回退规则处理；
- 不把 session model states 写入 localStorage，避免旧缓存覆盖服务端事实。

## 可观测性与安全

建议结构化记录：

- PUT/DELETE 成功：`workspaceId/sessionId/agentId/providerId/modelId/action`，不记录 API key；
- 模型解析失败：来源、reasonCode、Session/Agent/Run ID；
- 孤立 override：GET 投影时可 debug/warn，但避免每次轮询刷屏；
- 不在错误消息中输出 Provider 密钥、完整配置 JSON 或用户消息内容。

代码审查必须确认：

- workspace 归属由服务端 Session 记录校验；
- 路径中的 agentId 与 body 不重复，避免不一致；
- modelId 必须在 provider.models 内；
- 前端不可通过修改请求 body 绕过 Agent scope/enablement；
- DELETE 可清理 stale override，但不能跨 Session/Workspace。
