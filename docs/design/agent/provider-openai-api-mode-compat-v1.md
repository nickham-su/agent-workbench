# OpenAI 协议 Provider API 模式兼容方案(v1)

## 背景与目标

当前 Agent Provider 在 `@ai-sdk/openai` 分支固定走 `responses` 构造，默认命中 `/v1/responses`。在接入“OpenAI 协议兼容”厂商时，部分厂商仅提供 `/v1/chat/completions`，导致无法直接复用现有 Provider 配置。

本方案目标：

1. 在不破坏现有默认行为的前提下，支持 OpenAI Provider 在 `responses` 与 `chat/completions` 两种模式间切换。
2. 将影响范围限定在 OpenAI Provider，不改变 Anthropic 及未来其他 Provider 的既有行为。
3. 以最小改动完成前后端配置、运行时取值与请求分支闭环。

---

## 现状摘要

- OpenAI 模型构造目前固定为 `sdk.responses(modelId)`。
  - `packages/shared/src/llm/single-call.ts`
  - `apps/agent-worker/src/runtime/runner.ts`
- Provider 配置目前只有 `baseURL` 和 `apiKey`，没有接口模式字段。
  - `packages/shared/src/contracts/settings.ts`
- Settings 页 Provider 交互当前未暴露接口模式配置。
  - `apps/web/src/features/settings/components/AgentProvidersSettingsPanel.vue`

---

## 设计原则

1. **Provider 作用域隔离**：接口模式字段放在 `provider.options`，仅对 OpenAI provider 生效。
2. **默认值保持兼容**：OpenAI 未显式配置时默认 `responses`，保证历史配置无感。
3. **单点分支**：模型实例构造分支集中在 `createLanguageModel`（含 shared/worker 两处），避免业务层散落特判。
4. **可扩展但不过度设计**：v1 只做 OpenAI 的两种模式；不引入跨 Provider 的复杂协商或自动探测。

---

## 数据存储方案

### 配置字段

在 Provider options 增加可选字段：

- `apiMode?: "responses" | "chatCompletions"`

建议语义：

- `responses`：走 `/v1/responses`
- `chatCompletions`：走 `/v1/chat/completions`

### Schema 变更

文件：`packages/shared/src/contracts/settings.ts`

- 扩展 `AgentProviderOptionsInputSchema`：新增可选 `apiMode`。
- 扩展对应 view schema（若存在独立 view schema）并同步导出类型。

### 服务端读写规范化

文件：`apps/api/src/modules/settings/settings.service.ts`

新增规范化函数（命名可调整）：

- `normalizeOpenAiApiModeStored(raw): "responses" | "chatCompletions"`
- `normalizeOpenAiApiModeInput(raw): "responses" | "chatCompletions"`

规则：

1. 当 `provider.npm === "@ai-sdk/openai"` 时：
   - 读取：非法值回退 `responses`
   - 写入：仅允许 `responses/chatCompletions`（缺省写入 `responses` 或不写入并在读取时默认）
2. 当 `provider.npm !== "@ai-sdk/openai"` 时：
   - 忽略 `apiMode`（不参与运行时逻辑）

> 推荐“读取兜底默认 + 写入允许缺省”的组合，减少迁移成本。

---

## UI 交互方案

文件：`apps/web/src/features/settings/components/AgentProvidersSettingsPanel.vue`

### 交互规则

1. Provider 编辑弹窗中，新增字段 **API 模式**。
2. 仅当 `npm === "@ai-sdk/openai"` 时显示该字段；其他 npm 隐藏。
3. 默认值为 `responses`。
4. 保存时写入 `provider.options.apiMode`。

### 文案建议

- 标签：`API 模式`
- 选项：
  - `Responses API (v1/responses)`
  - `Chat Completions API (v1/chat/completions)`
- 提示：
  - “仅 OpenAI 协议 Provider 生效；若兼容厂商不支持 responses，请切换为 chat/completions。”

---

## 模型请求时的数据获取与处理逻辑

### 运行时取值

- 来源：`ExecutionProfile.provider.options.apiMode`
- 兜底：OpenAI provider 且该字段为空时，按 `responses` 处理。

### 请求分支

#### 1) 单次调用链路（压缩摘要等）
文件：`packages/shared/src/llm/single-call.ts`

现状：

- OpenAI 分支固定 `sdk.responses(providerModelId)`

改造后：

- OpenAI 分支读取 `apiMode`
  - `chatCompletions` -> `sdk.chat(providerModelId)`（以实际 SDK API 为准）
  - 其他 -> `sdk.responses(providerModelId)`

#### 2) 主会话链路（Agent Worker）
文件：`apps/agent-worker/src/runtime/runner.ts`

现状：

- OpenAI 分支固定 `sdk.responses(providerModelId)`

改造后：

- 同 single-call 逻辑，按 `apiMode` 分支构造 model。

### 保持不变

- Anthropic 分支保持现有路径。
- runtimeOptions 的 `aiSdk/providerOptionsByKey` 逻辑保持不变。

---

## 影响面与兼容性

### 对其他 Provider 的影响控制

- 字段是 OpenAI 范围内解释；非 OpenAI 不读取、不生效。
- 默认值策略保证历史 Provider（包括 Anthropic）行为不变。
- 代码分支改动仅位于 OpenAI model 构造点，不改通用消息组装逻辑。

### 兼容性结论

- **向后兼容**：现有配置无需迁移即可继续工作。
- **向前扩展**：可为未来 OpenAI-compatible 厂商按 provider 粒度切换 API 模式。

---

## 实施步骤（建议）

1. **契约与类型**
   - 改 `settings.ts`，补 `apiMode` 类型。
2. **后端服务读写**
   - 改 `settings.service.ts`，补规范化与默认逻辑。
3. **运行时消费**
   - 改 `single-call.ts` 与 `runner.ts` 的 OpenAI 分支。
4. **前端配置页**
   - Provider 弹窗新增 API 模式控件与持久化。
5. **测试与回归**
   - 覆盖默认值、配置读写、请求分支与端到端基础路径。

---

## 测试建议

### 单元测试

1. `settings.service`：
   - OpenAI + 空 `apiMode` -> 读取为 `responses`
   - OpenAI + 非法值 -> 回退/报错符合预期
   - Anthropic + `apiMode` -> 不影响最终运行时行为
2. `single-call` / `runner`：
   - OpenAI + `responses` 命中 `sdk.responses`
   - OpenAI + `chatCompletions` 命中 `sdk.chat`
   - Anthropic 路径不变

### 集成回归

- OpenAI 官方（responses）正常对话
- OpenAI-compatible（仅 chat/completions）正常对话
- 工具调用流程（有工具定义时）不回归
- 压缩摘要（single-call）不回归

---

## 风险与应对

1. **SDK 方法名差异风险**
   - 风险：`@ai-sdk/openai` 不同版本的 chat 构造 API 命名可能不同。
   - 应对：实现前确认当前锁定版本导出；必要时增加一层适配封装。

2. **兼容厂商字段差异**
   - 风险：部分厂商在 usage / tools 兼容上不完整。
   - 应对：保持 providerOptions 扩展能力，结合回归用例逐项验证。

3. **双位置实现漂移风险**
   - 风险：`single-call.ts` 与 `runner.ts` 后续行为不一致。
   - 应对：后续可抽取共享工厂函数（v2 优化），v1 先保持最小改动落地。

---

## 可选后续（非 v1 范围）

- 将 OpenAI/Anthropic 模型构造抽到共享 `provider-model-factory`，消除重复。
- 引入 Provider capability 描述（如 `supportsResponses`、`supportsChatCompletions`），用于 UI 动态约束与运行时校验。
- 增加 `auto` 模式（先 responses，失败特征匹配后降级 chat/completions）。

---

## 验收标准

1. 未配置 `apiMode` 的现有 OpenAI provider 行为不变。
2. 新配置 `apiMode=chatCompletions` 时，可成功接入仅支持 `/chat/completions` 的兼容厂商。
3. Anthropic provider 行为与测试结果不变化。
4. 前端设置页仅在 OpenAI provider 下显示 API 模式配置项。
