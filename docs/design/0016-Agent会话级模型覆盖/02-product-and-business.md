# 产品方案、业务规则与交互合同

## 产品概念

### 全局默认模型

Settings 页维护的 `AgentItem.defaultModel`：

- 是 Agent 的系统级默认主模型；
- 供没有 Session 覆盖的所有新 Run 继承；
- 不由 AI Agent 工具 Tab 的“修改 Agent 模型”弹窗修改。

### 本会话覆盖

当前 Primary Session 下，针对当前 Agent 保存的主模型覆盖：

```text
(sessionId, agentId) → providerId + modelId
```

它只影响该 Session 中该 Agent 后续创建的新 Run。

### 有效模型

用户当前看到并将在下一次新 Run 中使用的主模型：

```text
有有效覆盖 → 覆盖模型
无覆盖     → Agent 全局默认模型
```

有效模型的来源只允许：

```text
session_override
agent_default
```

Run 已创建后的诊断来源是 `run_snapshot`，不属于模型弹窗的配置来源。

## UI 结构

### Agent 选择器旁的模型入口

模型入口必须展示：

- 有效模型名称；
- 模型来源标识；
- 加载或不可用状态；
- 可点击打开当前 Session + Agent 的模型弹窗。

推荐文案：

```text
Claude Sonnet 4 · 本会话覆盖
Claude Sonnet 4 · 全局默认
模型不可用 · 本会话覆盖
默认模型不可用 · 全局默认
```

允许在空间不足时只显示模型名、通过 tooltip 展示来源和 Provider，但不得完全隐藏来源信息。

### 当前 Session 没有可用 user Agent

当 Workspace 当前没有任何允许 `user` surface 且已启用的 Agent 时，产品行为固定为：

- Agent 选择器沿用现有“无可用 Agent”空状态；
- Agent 旁的模型入口隐藏，不展示可点击或可编辑的占位模型；
- 不允许打开模型弹窗，也不得因为点击模型区域而创建真实草稿 Session；
- 发送按钮、回车发送和其他消息提交入口继续按现有 Agent 不可用逻辑阻止；
- 不得使用 `localStorage` 中残留的 Agent ID 或 GET 返回的孤立 override 恢复一个不可用 Agent 作为当前 Agent；
- Agent 配置恢复可用并完成 Agent 列表刷新后，模型入口才重新出现，并按当前 Session 状态 API 回显模型。

GET 返回 `items = []` 是该状态的合法服务端结果。孤立 override 可以作为不可编辑状态返回以支持诊断和清理，但不能使模型入口或发送能力重新变为可用。

### 模型弹窗

标题建议保持“修改 Agent 模型”，正文必须明确作用域：

```text
仅修改当前会话中「Agent 名称」的主模型，不影响全局默认和其他会话。
```

弹窗内容必须包含：

- 当前 Agent 名称；
- 全局默认模型；
- 当前有效模型；
- 当前来源：本会话覆盖或全局默认；
- Provider + Model 级联选择器；
- “保存”按钮；
- “重置为默认模型”按钮；
- “取消”按钮；
- 加载、保存、重置和错误状态。

### 按钮状态

| 状态 | 保存 | 重置为默认模型 | 取消 |
|---|---|---|---|
| 正在加载 | 禁用 | 禁用 | 可用 |
| 无覆盖、选中值等于默认 | 可禁用 | 禁用 | 可用 |
| 无覆盖、选中不同模型 | 可用 | 禁用 | 可用 |
| 有覆盖、选中值未变化 | 可禁用 | 可用 | 可用 |
| 有覆盖、选中值变化 | 可用 | 可用 | 可用 |
| 正在保存/重置 | 禁用 | 禁用 | 建议禁用或拦截关闭 |
| 当前为草稿且正在建 Session | 禁用 | 禁用 | 可取消等待后的弹窗意图 |
| Agent/模型状态不可加载 | 禁用 | 仅在确认存在覆盖时可用 | 可用 |
| Subtask Session | 不提供入口 | 不提供入口 | 不适用 |

首版不要求“保存为全局默认”按钮，避免再次混淆作用域。

## 交互流程

### 打开真实 Primary Session 的弹窗

```text
用户点击模型入口
  → 确认 session.kind = primary
  → 取得 effectiveAgentId
  → 请求该 Session 的覆盖状态（或读取已加载缓存）
  → 请求/复用可选 Provider/Model 列表
  → 用 effectiveModel 初始化选择器
  → 打开弹窗
```

硬约束：

- 不得用 `agentOptions.resolvedModel` 直接作为 Session 有效模型事实；
- 允许先展示缓存，但最终必须由 Session effective 状态校正；
- 切换 Agent 后必须切换到该 `(sessionId, agentId)` 的状态。

### 在草稿 Session 打开弹窗

草稿 ID `draft_*` 不是服务端 Session，不允许持久化覆盖。

固定流程：

```text
用户点击模型入口
  → 记录待编辑 Agent 与“打开模型弹窗”意图
  → 调用既有 ensureSessionCreated(draftId)
  → 后端创建真实 Primary Session
  → 父组件把 draft Tab 替换为真实 Session Tab
  → 将选中 Agent 从 draftId 迁移到真实 sessionId
  → 使用真实 sessionId 加载模型状态
  → 打开弹窗
```

行为合同：

- 创建失败：不打开弹窗、不保存临时覆盖，显示错误；
- 创建成功后用户取消弹窗：真实空 Session 保留，不回滚为草稿；
- 同一草稿上的并发创建继续复用现有 `draftCreatePromises` 去重；
- 实现必须使用 `ensureSessionCreated()` 返回的真实 Session ID，不得继续写旧 `props.sessionId`；
- 如果组件因 Tab 替换重建，必须由父组件 pending intent 或等价机制在新 Pane 挂载后完成打开，不能依赖旧组件继续存在。

### 保存覆盖

```text
用户选择 Provider / Model
  → 点击保存
  → 当前弹窗进入 saving
  → 当前 Session 发送入口禁用
  → PUT override
  → 服务端校验并持久化
  → 返回操作后的 effective state
  → 前端更新该 Session + Agent 缓存与模型标签
  → 关闭弹窗
  → 恢复发送
```

成功边界：

```text
PUT 成功返回
  → 后续创建的新 Run 必须使用新覆盖
```

失败行为：

- 保留服务端提交前的已生效展示；
- 弹窗保留用户选择，便于修正或重试；
- 显示可诊断错误；
- 恢复发送；
- 不更新全局 `agentOptions.resolvedModel` 伪装成功。

### 重置为默认模型

```text
存在覆盖
  → 点击重置为默认模型
  → 可使用确认弹窗或明确按钮文案防误触
  → 当前 Session 发送入口禁用
  → DELETE override
  → 服务端删除记录并返回删除后的 effective state
  → UI 显示全局默认或默认不可用
  → 关闭弹窗或保持打开并更新内容
  → 恢复发送
```

重置成功不要求全局默认可用。删除是用户明确意图，默认失效不能阻止删除。

### 刷新回显

固定流程：

```text
页面刷新
  → AgentToolView 从 localStorage 恢复 session → selectedAgentId
  → 加载服务端 Session 列表
  → 加载当前/可见 Session 的 model overrides/effective states
  → 为每个 Session + Agent 计算或直接使用服务端返回的 effective state
  → 模型入口展示覆盖模型或全局默认及来源
```

刷新合同：

- 覆盖配置来自后端，不来自 localStorage；
- 同浏览器可恢复当前 Agent 是现有 UI 行为，不是覆盖持久化条件；
- localStorage 丢失时，可回退首个可用 Agent；用户重新选择有覆盖的 Agent 后必须立即正确回显；
- 不承诺其他浏览器/设备自动恢复“当前选中 Agent”；
- 其他浏览器只要选择对应 Agent，仍应从后端看到相同覆盖。

## 状态模型

推荐前端/接口使用如下读模型：

```ts
type AgentSessionModelState = {
  sessionId: string;
  agentId: string;
  override: {
    providerId: string;
    modelId: string;
    updatedAt: number;
  } | null;
  effectiveModel: {
    providerId: string;
    modelId: string;
    providerName: string;
    modelName: string;
    contextWindowTokens: number;
  } | null;
  source: "session_override" | "agent_default";
  status: "ready" | "invalid" | "missing";
  reasonCode: string | null;
  message: string | null;
};
```

语义：

| status | 说明 | 是否允许创建新 Run |
|---|---|---|
| `ready` | 来源指向的 provider/model 与凭据均可用 | 是 |
| `invalid` | 配置引用存在但 Provider/Model/凭据或 Agent 可用性失效 | 否 |
| `missing` | 来源没有完整 provider/model，例如 Agent 无默认模型 | 否 |

约束：

- `override !== null` 时，`source` 必须为 `session_override`；即使覆盖失效也不能伪装成默认来源；
- 无覆盖时，`source` 必须为 `agent_default`，表示当前应尝试解析 Agent 默认配置层；
- `source` 只表达配置层，不表达该层是否存在、有效或可执行；
- `source = agent_default` 不保证 Agent 存在，也不保证 `defaultModel`、Provider、Model 或凭据可用；
- UI、实现和验收必须结合 `source + status + reasonCode` 判断，不得只根据 `source` 展示“默认模型可用”或放开发送；
- `status !== ready` 时 `effectiveModel` 可以为 null；若 Provider/Model 仍能定位但凭据失效，也允许保留展示信息，但接口 schema 必须统一，不得前后端各自解释；
- `reasonCode` 使用稳定机器码，`message` 供展示；
- 不把 `source` 与可用状态混成一个枚举。

因此，DELETE 后即使 Agent 已不存在，响应仍可为 `source = agent_default`、`status = missing`：前者只说明 override 已删除并进入默认继承层，后者才说明该层无法成功解析；该状态必须阻止新 Run。

## 业务状态矩阵

### 覆盖与默认关系

| 覆盖 | 全局默认 | 展示 | 新 Run |
|---|---|---|---|
| 无 | 有效 | 默认模型、`agent_default/ready` | 使用默认 |
| 有效 | 有效 | 覆盖模型、`session_override/ready` | 使用覆盖 |
| 有效 | 后续变化 | 覆盖不变 | 使用覆盖 |
| 无 | 后续变化 | 显示新默认 | 使用新默认 |
| 失效 | 有效 | 覆盖不可用、`session_override/invalid` | 拒绝，不回退 |
| 无 | 失效/缺失 | 默认不可用 | 拒绝 |
| 有效 | 失效/缺失 | 覆盖有效 | 使用覆盖 |

### 重置结果

| 重置前 | DELETE 结果 | 重置后展示 | 后续新 Run |
|---|---|---|---|
| 有效覆盖 + 有效默认 | 删除成功 | 有效默认 | 默认 |
| 失效覆盖 + 有效默认 | 删除成功 | 有效默认 | 默认 |
| 有效覆盖 + 失效默认 | 删除成功 | 默认不可用 | 拒绝 |
| 无覆盖 | 前端禁用；API 应保持幂等成功 | 当前默认状态 | 按默认状态 |

DELETE 建议幂等：记录不存在时仍返回当前 effective state，不返回 404。这样重试与多窗口操作更稳定。

### 全局配置变化

| 操作 | 无覆盖 Session | 有覆盖 Session |
|---|---|---|
| 修改 Agent defaultModel | 立即反映到下一次刷新/状态加载和后续新 Run | 不影响覆盖 |
| 删除覆盖所引用 Model | 不相关 | 显示覆盖失效，新 Run 拒绝 |
| 删除默认所引用 Model | 显示默认失效，新 Run 拒绝 | 覆盖有效时不受影响 |
| 删除/禁用 Agent | 不允许继续编辑或创建新 Run | 覆盖保留但不可用，按清理策略延迟删除 |
| 删除 Provider 凭据 | 对应来源变 invalid | 对应来源变 invalid |

## 并发与即时性

### 同一页面

保存/重置中：

- 当前 Session 的发送按钮和回车发送必须禁用；
- 不要求阻止其他 Session 发送；
- Agent 切换和再次打开模型弹窗应禁用或等待提交结束；
- 操作成功后先更新展示，再恢复发送。

### 多窗口

首版采用 last-write-wins：

- 两个窗口同时 PUT，数据库最后提交值生效；
- 一个 PUT、一个 DELETE，最后提交动作生效；
- 较早窗口不会自动收到推送；下次刷新、重新打开弹窗或主动重新加载时校正；
- 不提供“配置被他人修改”冲突提示。

### API 与发送并发

仅承诺：

- 配置 API 成功返回后发起的新 Run 使用新状态；
- API 未返回前已进入服务端模型解析的 Run 可以使用旧状态；
- 服务端应在读取覆盖与写入 Run 快照的同一新 Run 创建流程中完成解析，不得等 Worker 启动后再读。

## Fork、Subtask 与压缩边界

### Fork

Fork 创建的新 Primary Session：

- 不复制来源 Session 的任何模型覆盖；
- 当前浏览器是否把选中 Agent 作为 UI 偏好迁移，不得被解释为复制模型覆盖；
- 新 Session 无覆盖时使用全局默认；
- 用户可在新 Session 单独设置覆盖。

### Subtask

- Subtask Session 不继承父 Session 覆盖；
- Subtask 模型仍按 Subtask 自身请求 Agent 的全局默认解析；
- Subtask Session 为只读，本期不展示模型编辑入口；
- 父 Session 覆盖不能改变已创建 Subtask Run；
- 若未来支持 Subtask 覆盖，必须单独设计，不得通过隐式继承实现。

### 手动压缩与自动压缩

模型语义必须区分“Run 主模型”和“压缩摘要模型”：

- 手动压缩会创建一个 Run，其主模型快照应按当前 Primary Session + Agent 覆盖解析；
- Worker 生成压缩摘要时，优先使用全局 `runtime.compactionModel`；
- 未配置、不可用或不适配时，现有逻辑可回退该 Run 主模型；
- 自动压缩在当前 Run 内发生，回退主模型自然是当前 Run 快照；
- 本期不提供 Session 级压缩模型选择，不改变 compaction 优先级。

## 错误提示与恢复

建议稳定错误码：

| 场景 | HTTP | 建议错误码 | UI 行为 |
|---|---:|---|---|
| Session 不存在 | 404 | `AGENT_SESSION_NOT_FOUND` | 关闭弹窗并刷新 Session |
| Workspace 不匹配 | 404 或 403，遵循现有安全习惯 | `AGENT_SESSION_NOT_FOUND` 或统一归属码 | 不泄漏其他 Workspace 数据 |
| Subtask 尝试编辑 | 400/409 | `AGENT_SESSION_MODEL_OVERRIDE_NOT_EDITABLE` | 提示仅支持主会话 |
| Agent 不存在 | 400 | `AGENT_NOT_FOUND` | 刷新 Agent 列表 |
| Agent 未对 Workspace 启用 | 400 | `AGENT_DISABLED_IN_WORKSPACE` | 提示不可用 |
| Agent scope 不允许 user | 400 | `AGENT_SCOPE_NOT_ALLOWED` | 提示不可用 |
| Provider/Model 不存在 | 400 | 复用 Provider/Model 校验码 | 保留弹窗选择并提示 |
| API Key 缺失 | 400 | `AGENT_PROVIDER_API_KEY_MISSING` | 提示修复 Provider |
| 覆盖失效后发消息 | 400 | 对应稳定码 | 不静默回退 |
| 保存网络失败 | 网络错误 | 客户端已有错误结构 | 保留旧生效状态，可重试 |

## 可访问性与文案

- 模型按钮必须有 tooltip/aria label，说明“当前会话模型”；
- 来源不能只依赖颜色，必须有文字；
- saving/resetting 状态必须有 loading；
- 重置按钮使用明确文案“重置为默认模型”，不得使用含糊的“清除”；
- 成功提示应说明作用域，例如“已更新当前会话模型”；
- 不应提示“Agent 默认模型已更新”；
- i18n 至少同步 `zh-CN` 与项目现有其他 locale，避免硬编码中文。
