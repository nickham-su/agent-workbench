# 现状代码引用与改造地图

> 本文记录设计编写时的代码事实。实施前必须重新搜索并更新行号；函数名和调用关系是主要依据。

## Web：Agent 与模型入口

### Agent 选择和模型按钮

文件：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

关键位置：

- Agent 选择器和模型按钮：约 `432-451`；
- 模型弹窗模板：约 `570-610`；
- `effectiveAgentId`：约 `1394-1400`；
- `currentAgentOption` / `effectiveModelLabel`：约 `1402-1410`；
- `onOpenAgentModelModal()`：约 `3324` 起；
- `onSaveAgentModel()`：约 `3352-3407`；
- 普通消息发送和草稿 Session 确保创建：约 `3525-3567`。

当前模型标签：

```text
AgentClientPane.effectiveModelLabel
  → currentAgentOption.resolvedModel
  → AgentToolView.agentOptions
  → listWorkspaceAvailableAgents().agents[].resolvedModel
```

问题：`agentOptions` 被所有 Session 共用，没有 Session override 维度。

当前模型保存：

```text
onSaveAgentModel()
  → getAgentSettings()
  → 遍历全部 agents
  → 替换目标 Agent.defaultModel
  → updateAgentSettings(payload)
```

授权改造：

- 模型标签改为读取当前 `sessionId + effectiveAgentId` effective state；
- 弹窗保存调用 Session PUT；
- 增加 DELETE 重置；
- 删除该弹窗对 `getAgentSettings()/updateAgentSettings()` 的保存依赖；
- Provider/Model 列表仍可复用现有 providers settings 加载，但不得通过它决定 Session 生效状态；
- 保存/重置 pending 接入发送禁用。

禁止改造：

- 不删除 Settings 页面所需 `updateAgentSettings()`；
- 不给发送 body 增加 providerId/modelId。

## Web：Session Tab、Agent 选择持久化与草稿转换

文件：

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

### 受控 Agent 选择

关键位置：

- 向 Pane 传入 Session/Agent：约 `43-64`；
- `AGENT_PICK_STORAGE_PREFIX`：约 `154-158`；
- `selectedAgentBySession`：约 `169`；
- localStorage restore：约 `333-350`；
- `persistAgentPick()`：约 `391-397`；
- `setSessionAgent()`：约 `430-433`；
- `refreshAgents()`：约 `435-445`。

当前存储 key：

```text
agent-workbench.workspace.agent.pickBySession.v1.<workspaceId>
```

当前事实：

- Session → Agent ID 整张 map 存在 localStorage；
- 同浏览器/同 origin/同 workspace 刷新可恢复；
- 不写服务端，不跨浏览器；
- `effectiveAgentId` 在旧 Agent 不可用时回退首个可用 Agent。

授权改造：

- 保持上述机制；
- 增加独立 `sessionAgentModelStates` 服务端缓存；
- 加载/释放缓存与 Session Tab 生命周期对齐；
- 不把模型覆盖写入 localStorage。

### 草稿 Session 转真实 Session

关键位置：

- `newDraftSessionId()`：约 `404-410`；
- `ensureSessionCreated(sessionId)`：约 `551-590`；
- 普通发送调用 `props.ensureSession()`：`AgentClientPane.vue` 约 `3525-3531`。

`ensureSessionCreated()` 当前行为：

- 查找 draft；
- 使用 `draftCreatePromises` 去重；
- 调用 `createAgentSession()`；
- 从 `draftSessions` 移除；
- 加入 `serverSessions`；
- 把 `selectedAgentBySession[draftId]` 迁移到真实 ID；
- 迁移 active key/tab 编号等状态；
- 返回真实 `created.id`。

授权改造：

- 模型按钮在 draft 上复用该函数；
- 新增 pending modal intent，兼容 Pane 因 Tab key 变化重建；
- 任何覆盖 API 只接收真实 ID；
- 创建成功后取消弹窗不删除 Session。

## Web API

文件：

- `apps/web/src/shared/api/api.ts`

当前全局设置更新：

```ts
updateAgentSettings(body)
  → PUT /settings/agent/agents
```

位置约 `1090-1096`。

授权新增：

```text
getAgentSessionModelOverrides(sessionId, workspaceId)
updateAgentSessionModelOverride(sessionId, agentId, body)
resetAgentSessionModelOverride(sessionId, agentId, workspaceId)
```

工具 Tab 不再用全局更新 API 保存模型。

## Shared 契约

### 消息请求

文件：

- `packages/shared/src/contracts/agent.ts`

关键位置：约 `459-470`。

当前公共字段：

```ts
workspaceId
clientRequestId
agentId?
uiLocale?
```

文本请求另含 `text`。当前不含 provider/model，必须保持。

### 全局 Agent resolved model/source

文件：

- `packages/shared/src/contracts/settings.ts`

关键符号：

- `AgentDefaultModelSchema`；
- `AgentResolvedModelSourceSchema`；
- `AgentResolvedModelSchema`；
- `AgentWorkspaceAvailableItemSchema`。

当前 `AgentResolvedModelSourceSchema` 只允许：

```text
agent_default
```

它用于全局/Workspace available agent 视图，不足以表达 Session override。建议在 `agent.ts` 新增 Session 专用来源与状态契约，避免直接扩大旧字段后让所有消费者误解。

## API：全局 Agent 设置现状

### 路由

文件：

- `apps/api/src/modules/settings/settings.routes.ts`

当前入口：

```text
PUT /api/settings/agent/agents
  → updateAgentSettings(ctx, log, body)
```

### 服务

文件：

- `apps/api/src/modules/settings/settings.service.ts`

关键符号：

- `AGENT_SETTINGS_KEY = "agent_agents_v1"`：约 `56`；
- `getAgentSettingsStored()`：约 `1207` 起；
- `updateAgentSettings()`：约 `1821-1897`；
- `resolveExecutionProfile()`：约 `1962-2058`。

当前保存最终：

```ts
setSettingJson(ctx.db, AGENT_SETTINGS_KEY, {
  agents: normalizedAgents
}, updatedAt);
```

新方案要求：

- 保留该全局能力；
- 工具 Tab 不调用；
- Session override 不写该 key。

## 数据库：Session 与 Run

文件：

- `apps/api/src/infra/db/schema.ts`

### 全局 settings

约 `88-92`：

```sql
settings (
  key text primary key,
  value_json text not null,
  updated_at integer not null
)
```

没有 Session 维度，证明当前 Agent Settings 是全局事实。

### agent_session

约 `94-115`：

```sql
agent_session (
  id,
  workspace_id,
  title,
  kind,
  created_at,
  updated_at,
  forked_from_session_id,
  forked_from_item_id
)
```

当前无模型字段。本方案新增独立子表，不在这里增加单模型列。

### agent_run

在同文件后部定义，关键字段：

```text
run_id
workspace_id
session_id
agent_id
provider_id
model_id
status
created_at
updated_at
```

它已经具备主模型快照，是“新 Run 生效、已有 Run 不变”的基础。

## Store：Session、Fork 与 Run 快照

文件：

- `apps/api/src/modules/agent/agent.store.ts`

关键符号：

- `createAgentSession()`：约 `846-905`；
- `cloneSession()` 相关逻辑；
- `createRunRecord()`：约 `1813-1877`。

`createAgentSession()` 当前只保存 Session 基础字段，没有覆盖或继承参数。

`createRunRecord()` 明确写入：

```text
agent_id
provider_id
model_id
```

授权改造：

- 新增 override CRUD；
- 不给 `cloneSession()` 增加复制覆盖逻辑；
- 保持 Run snapshot 写入。

## API：Session 公共路由

文件：

- `apps/api/src/modules/agent/routes/agent-public.routes.ts`

当前邻近入口：

- `GET /api/agent/sessions/:sessionId/run-state`：约 `392-411`；
- `POST /api/agent/sessions/:sessionId/messages`：约 `413-470`；
- Session context、fork、compact 等路由位于同文件。

授权改造：

- 在 Session 路由中注册 model-overrides GET/PUT/DELETE；
- Shared schema 化 params/query/body/response；
- 委派 Agent service/application，不在 route 内访问 DB/Settings。

## 普通消息 Run 创建链路

### 路由

```text
POST /api/agent/sessions/:sessionId/messages
  → dependencies.service.sendMessage(...)
```

文件：

- `apps/api/src/modules/agent/routes/agent-public.routes.ts`，约 `431-446` 后进入 handler。

### Application

文件：

- `apps/api/src/modules/agent/session/session-interaction-application.ts`

关键逻辑约 `46-86`：

```text
getSession(sessionId)
  → 验证 primary/active run
  → profileReader.resolveUser({ workspaceId, requestedAgentId })
  → lifecycleStarter.startUserRun({ agentId, providerId, modelId })
```

当前缺口：`resolveUser` 未接收 `sessionId`。

### Composition

文件：

- `apps/api/src/modules/agent/agent.composition.ts`

关键位置：约 `1413-1425`。

当前：

```ts
resolveUser({ workspaceId, requestedAgentId }) {
  resolveExecutionProfile({
    surface: "user",
    requestedAgentId,
    workspaceEnablement
  })
}
```

授权改造：

- 端口增加 sessionId；
- 在新 Run 路径读取 override；
- 返回最终 profile；
- 不改变 Subtask reader 的继承语义。

### Lifecycle 与 Store

文件：

- `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`
- `apps/api/src/modules/agent/agent.store.ts`

链路：

```text
startUserRun()
  → activateUserRun/createRunRecord()
  → agent_run snapshot
```

## Execution Profile 解析

文件：

- `apps/api/src/modules/settings/settings.service.ts`

函数：

- `resolveExecutionProfile()`，约 `1962-2058`。

当前输入：

```ts
surface
requestedAgentId?
workspaceEnablement?
agentIdFromRun?
providerIdFromRun?
modelIdFromRun?
```

当前主模型：

```text
run provider/model（若有）
  > Agent defaultModel
```

当前实现分别解析 providerId 和 modelId。新增覆盖时必须重构为完整 pair 候选，目标：

```text
run snapshot pair
  > session override pair
  > agent default pair
```

同一函数还解析：

- vision：全局 runtime vision 或主模型 fallback；
- compaction：全局 runtime compaction；

本方案只修改主模型候选，不能改变这两段独立逻辑。

## Worker 读取已有 Run

文件：

- `apps/api/src/modules/agent/read-side/execution-profile-resolver.ts`
- `apps/api/src/modules/agent/read-side/read-side-application.ts`
- `apps/api/src/modules/agent/routes/agent-worker.routes.ts`
- `apps/agent-worker/src/runtime/apiClient.ts`
- `apps/agent-worker/src/runtime/runner.ts`

调用链：

```text
Worker 请求 run execution profile
  → API load agent_run
  → resolveExecutionProfile({
       agentIdFromRun,
       providerIdFromRun,
       modelIdFromRun
     })
  → Worker runner 使用 profile.provider/model
```

授权改造：

- 保持 Run 快照绝对优先；
- 不在 Worker route/resolver 中追加 Session override 查询；
- 若来源对外暴露，标为 `run_snapshot`。

## 手动压缩与自动压缩

### 手动压缩 API/Application

文件：

- `apps/api/src/modules/agent/compaction/manual-compaction-application.ts`
- `apps/api/src/modules/agent/agent.composition.ts`

调用链：

```text
ManualCompactionApplication.schedule()
  → resolveProfile({ workspaceId, requestedAgentId })
  → createRunRecord(... main provider/model ...)
  → enqueueRun(inputText="__awb_compact__")
```

当前缺口：resolveProfile 未接收 sessionId。目标是让手动压缩 Run 主模型按 Session override 解析。

### Worker 压缩模型

文件：

- `apps/agent-worker/src/runtime/runner.ts`

关键符号：

- `MANUAL_COMPACT_SENTINEL = "__awb_compact__"`：约 `75`；
- `selectCompactionModel()`：约 `1787-1812`；
- 压缩 summary 执行：约 `1838-1889`。

现有选择：

```text
profile.compaction（全局 runtime compaction，可用且适配）
  > profile.provider/model（当前 Run 主模型）
```

禁止改动：Session 主模型覆盖不能覆盖 `profile.compaction`。

## Fork 链路

### Web

文件：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

`forkAgentSession()` 调用约 `3015-3025`。

### API/Application/Store

文件：

- `apps/api/src/modules/agent/session/session-interaction-application.ts`
- `apps/api/src/modules/agent/agent.store.ts`

链路：

```text
fork
  → SessionInteractionApplication.forkSession()
  → store.cloneSession()
  → createAgentSession(targetKind="primary")
```

当前没有覆盖复制。目标保持不复制。

## Subtask 链路

文件：

- `apps/api/src/modules/agent/subtask/subtask-application.ts`
- `apps/api/src/modules/agent/agent.composition.ts`

当前 resolver 约 `1433-1458`：

```text
surface = subtask
requestedAgentId
workspaceEnablement
→ Agent global defaultModel
```

当前事实：

- 没有 parentSession override 参数；
- Subtask Session 通过 `createAgentSession()` 创建；
- 普通消息和手动压缩对 `session.kind === "subtask"` 返回 `AGENT_SUBTASK_READONLY`。

目标保持：

- 不继承父覆盖；
- 不开放编辑；
- 子任务 Run 继续按自身 requested Agent 全局默认快照。

## 模型来源诊断注意点

文件：

- `apps/api/src/modules/agent/agent.composition.ts`

`getSingleCallModelProfileForRun()` 约 `1980-2010`：

- 从 `agent_run` 读取 provider/model；
- 调用 `resolveExecutionProfile()` 重建；
- 当前返回 source 可能固定为 `agent_default`。

新增来源后必须检查所有 `source` 消费者：

```text
agent_default       配置层默认来源
session_override    配置层会话覆盖来源
run_snapshot        已创建 Run 的执行来源
runtime_vision      独立 vision 来源
runtime_compaction  独立 compaction 来源
```

不得仅为满足类型而把 Session/Run 来源继续伪装成 `agent_default`。

## 预计修改文件地图

### 必改

```text
packages/shared/src/contracts/agent.ts
apps/api/src/infra/db/schema.ts
apps/api/src/modules/agent/agent.store.ts 或新增 Store
apps/api/src/modules/agent/routes/agent-public.routes.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/session/session-interaction-application.ts
apps/api/src/modules/agent/compaction/manual-compaction-application.ts
apps/api/src/modules/settings/settings.service.ts
apps/web/src/shared/api/api.ts
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
相关 i18n 文件
相关 tests
```

### 可选新增

```text
apps/api/src/modules/agent/session/session-agent-model-application.ts
apps/api/src/modules/agent/session/session-agent-model-ports.ts
apps/web/src/features/workspace/tools/agent/useAgentSessionModelOverrides.ts
```

### 原则上不改

```text
AgentSendMessageRequest 的 provider/model 字段（不得新增）
Worker 每请求动态配置读取（不得新增）
Subtask parent override 继承逻辑（不得新增）
Fork clone override 逻辑（不得新增）
全局 runtime vision/compaction 优先级
全局 Settings Agent 编辑功能
服务端 selectedAgentId 持久化
```
