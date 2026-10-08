# 背景、目标、范围与关键决策

## 需求背景

AI Agent 工具的每个 Session Tab 底部包含：

- Agent 选择器；
- Agent 旁的模型选择/展示入口；
- 点击模型入口后打开“修改 Agent 模型”弹窗。

用户在该位置进行操作时，天然形成的产品预期是“当前会话使用哪个模型”。但现状保存逻辑会修改目标 Agent 的全局 `defaultModel`，导致：

- 当前 Session 的局部操作改变全局默认；
- 其他 Session 后续使用同一 Agent 时受到影响；
- UI 位置表达的是 Session 上下文，数据作用域却是全局，产品语义不一致；
- 用户无法清晰区分“本会话临时选择”和“系统级 Agent 默认配置”。

本设计将工具 Tab 的模型修改收敛为 Session-Agent 范围的主模型覆盖，并保留 Settings 页中的 Agent 全局默认模型作为继承层。

## 当前问题

### 当前保存会修改全局设置

现有前端 `AgentClientPane.vue` 中：

```text
onOpenAgentModelModal()
  → getAgentProvidersSettings()
  → getAgentSettings()
  → 使用 AgentItem.defaultModel 初始化

onSaveAgentModel()
  → getAgentSettings()
  → 替换目标 Agent.defaultModel
  → updateAgentSettings()
  → PUT /settings/agent/agents
```

后端 `updateAgentSettings()` 最终写入全局 `settings` 表的 `agent_agents_v1`。该数据没有 `sessionId` 维度。

### 当前模型展示只有全局视角

`AgentToolView.refreshAgents()` 调用 `listWorkspaceAvailableAgents()`，将 `agent.resolvedModel` 写入所有 Session 共用的 `agentOptions`。`AgentClientPane.effectiveModelLabel` 再从当前 Agent option 中取模型名。

因此当前展示链路：

```text
全局/Workspace available agent resolvedModel
  → 全部 Session 共用 agentOptions
  → 当前模型标签
```

新增覆盖后，如果继续沿用该链路，会出现“UI 显示全局默认，但服务端实际运行覆盖模型”的错误。因此展示状态必须引入 Session 维度。

### 当前执行链路适合在 Run 创建前注入覆盖

普通消息当前由服务端解析 Agent 默认模型，再把最终 `agentId/providerId/modelId` 写入 `agent_run`。Worker 随后按 Run 快照恢复执行配置。

这意味着无需让 Worker 动态查询 Session 配置，只需把覆盖解析加入“新 Run 创建前”的服务端链路即可。

## 目标

本期必须实现：

- 工具 Tab 中修改模型只影响当前 `(sessionId, agentId)`；
- 不修改 Agent 全局 `defaultModel`；
- 弹窗增加“重置为默认模型”，删除覆盖并恢复继承；
- 覆盖配置后端持久化，刷新后可回显；
- UI 展示当前 Session + Agent 的有效主模型及来源；
- 保存/重置成功后创建的新 Run 使用新配置；
- 已创建、排队和运行中的 Run 保持原快照；
- 草稿 Session 点击模型入口时先创建真实 Session；
- 全局默认、Provider、Model 失效时有明确且可诊断的错误；
- 旧 Session 无覆盖记录时无迁移成本地继续继承全局默认。

## 业务成功标准

- 用户可以在 Session A 为 Agent X 选择模型 M1，而 Session B 的 Agent X 仍使用其自身覆盖或全局默认；
- 用户刷新页面后，Session A + Agent X 仍显示 M1 和“本会话覆盖”；
- 用户重置后，覆盖记录消失，UI 显示当前 Agent 全局默认；
- 下一条新消息的 Run 与 UI 显示一致；
- 全局 Settings 中 Agent X 的 `defaultModel` 未因上述操作改变。

## 范围

### 本期范围

- Primary Session 的 Agent 主模型覆盖；
- `(sessionId, agentId)` 级持久化；
- 覆盖 GET/PUT/DELETE API；
- 工具 Tab 模型标签、弹窗、保存、重置和刷新回显；
- 草稿转真实 Session 后编辑；
- 普通用户消息新 Run 的服务端模型解析和 Run 快照；
- 手动压缩 Run 的**主模型快照**按当前 Session 覆盖解析，但摘要模型仍遵守现有独立 compaction 策略；
- 失效状态、API 错误、加载和并发边界；
- 数据库初始化兼容、自动测试、手工验收和审查门禁。

### 非目标

以下内容明确不做，不得在开发中隐式扩展：

- 不修改 Settings 页全局 Agent 默认模型能力；
- 不给 Session 增加单一 `modelId` 字段；
- 不覆盖 vision model；
- 不覆盖或重定义全局 `AgentRuntimeSettings.compactionModel`；
- 不覆盖超时、重试、自动压缩阈值等 runtime 配置；
- 不让前端在发送消息 body 中指定权威 provider/model；
- 不让 Worker 在每次模型请求时动态查询 Session override；
- 不改变已创建、排队、运行中或历史 Run；
- 不支持运行中模型切换；
- 不复制 Fork 来源 Session 的覆盖；
- 不让 Subtask Session 继承父 Session 覆盖；
- 不在 Subtask Session 提供模型编辑；
- 不新增服务端 `selectedAgentId` 持久化；
- 不承诺跨浏览器、跨设备恢复当前选中 Agent；
- 首版不增加 revision/ETag/乐观锁；
- 不增加配置历史、审计日志、批量复制覆盖或“一键设为全局默认”。

## 核心业务逻辑

### 配置作用域

```text
Workspace
  └─ Session
      ├─ Agent A → Override A 或 Agent A defaultModel
      └─ Agent B → Override B 或 Agent B defaultModel
```

覆盖键必须是：

```text
(sessionId, agentId)
```

因为同一个 Session 可切换多个 Agent；一个 Session 单模型字段无法表达每个 Agent 的独立选择。

### 主模型优先级

配置优先级固定为：

```text
已有 Run 快照
  > Session-Agent 覆盖
  > Agent 全局 defaultModel
```

应用方式：

- 读取已有 Run：必须使用 Run 中固化的 provider/model；
- 创建新 Run：查询 Session-Agent 覆盖；有覆盖则使用覆盖，无覆盖则使用全局默认；
- Worker：只消费 Run 快照；
- UI：读取当前 Session-Agent 的有效状态，必须与创建新 Run 的服务端解析规则一致。

### 生效边界

```text
PUT/DELETE 成功返回
  → 后续新 Run 必须使用操作后的配置
```

提交尚未返回时，不承诺并发创建的新 Run 使用新配置。为收窄同一前端竞态，Web 在保存/重置期间必须禁用当前 Session 发送。

### 重置语义

“重置为默认模型”严格等同于：

```text
DELETE (sessionId, agentId) override
```

重置不是：

- 把默认值复制到 Session；
- 恢复最后使用模型；
- 选择任意可用模型；
- 修改全局默认。

删除后，后续有效模型动态继承当前 Agent 的 `defaultModel`。因此全局默认后续变化时，无覆盖 Session 会跟随变化。

## 关键决策与取舍

### 采用独立 Session-Agent 覆盖表

**决策：**使用独立表，不放入全局 `settings` JSON，也不直接扩展 `agent_session` 单模型字段。

**原因：**

- 数据作用域与实体关系清晰；
- `(sessionId, agentId)` 唯一性可由数据库保证；
- Session 删除可级联清理；
- 不必每次重写全部 Agent 设置 JSON；
- 便于按 Session 批量读取并刷新回显；
- 不把局部运行选择混入系统级 Settings 领域。

### 创建 Run 时快照，不动态切换

**决策：**覆盖仅影响保存/重置成功后创建的新 Run。

**原因：**

- 复用现有 `agent_run.provider_id/model_id`；
- 保持排队、恢复、重试和 Worker 执行一致性；
- 避免同一 Run 中途切换模型；
- 实现和测试成本低于 Worker 动态配置订阅；
- 用户需求未要求立即改变运行中执行。

### 服务端解析，前端不传模型权威值

**决策：**消息请求仍只传 `agentId`；provider/model 由服务端按 Session 配置解析。

**原因：**

- 防止前端绕过 Session、Workspace、Agent enablement 和 Provider 校验；
- 普通消息、手动压缩等入口可共享一致规则；
- UI 状态不成为执行事实源；
- 避免刷新或多窗口导致请求值与数据库状态漂移。

### UI 读取有效状态，而非仅原始覆盖

**决策：**API 返回 override、effectiveModel、source、status 等有效状态；UI 不自行拼接猜测。

**原因：**

- 无覆盖时仍需展示全局默认；
- 覆盖/默认可能因 Provider、Model、凭据变化而失效；
- UI 展示必须与服务端 Run 创建解析一致；
- PUT/DELETE 后可直接以响应更新 UI，减少二次请求竞态。

### 不覆盖 vision 和 compaction 模型

**决策：**Session-Agent override 只替换 execution profile 的主 `provider/model`。

**原因：**

- vision 和 compaction 已有独立 runtime 配置语义；
- compaction 未配置时自然回退当前 Run 主模型，因此覆盖可间接影响回退结果，无需改变独立优先级；
- 强制覆盖会扩大产品含义和回归范围；
- 手动/自动压缩应继续共享现有 compaction 选择逻辑。

### Fork 与 Subtask 不继承

**决策：**新建/Fork/Subtask Session 初始均无 override；Subtask 不可编辑。

**原因：**

- 当前 Session 创建/克隆链路没有覆盖复制机制；
- “会话自治、无记录即继承全局默认”最简单且可预测；
- 隐式继承会引入父配置后续变化、复制时点和子任务 Agent 映射问题；
- Subtask 当前只读，不适合作为首版编辑面。

### Agent 选择继续使用 localStorage

**决策：**不新增服务端 `selectedAgentId`。

**原因：**

- 本需求核心是模型覆盖，不是 UI 选中状态跨设备同步；
- 当前同浏览器刷新已可恢复选择；
- 即使 Agent 选择丢失，用户重新选择 Agent 后仍可从服务端读取其覆盖；
- 避免把 Session 运行配置和浏览器 UI 偏好混为一体。

### 首版多窗口 last-write-wins

**决策：**不加 revision；同一键以数据库最后提交写入为准。

**原因：**

- 配置是小粒度可重试操作；
- 单页面通过 loading 和发送禁用收窄竞态；
- 乐观锁会增加契约、冲突 UI 和测试成本；
- 若后续出现真实多人协作需求，再引入 revision。

## 暂停条件

实施中发现以下任一情况必须暂停并更新设计，不得自行猜测：

- 新 Run 除普通消息、手动压缩、Subtask 外还有会绕过统一 profile 解析的生产入口；
- Worker 存在不读取 Run 快照、而重新使用 Agent 默认模型的主模型请求路径；
- Session 删除无法触发外键级联或部署环境未启用所需 SQLite 外键语义；
- Provider/model 可用性校验在 Settings 与 Agent 领域存在互相矛盾的标准；
- 草稿 Session 转换时组件生命周期导致无法可靠取得真实 Session ID，且现有 `ensureSessionCreated()` 返回值不能作为操作依据；
- API 路由没有可用的 Workspace 归属校验上下文，导致接口设计无法防止跨 Workspace 写入。