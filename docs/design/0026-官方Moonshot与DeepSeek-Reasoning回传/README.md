# 官方 Moonshot/Kimi 与 DeepSeek Reasoning 多轮回传

> 状态：待开发；本文是实现、代码审查、自动化测试、发布前联调与验收的共同契约。
>
> 范围：新增官方 `@ai-sdk/moonshotai` 与 `@ai-sdk/deepseek` Provider，并让其 reasoning 在下一次同一兼容对话调用中重新发送给模型。
>
> 前提：现有 OpenAI Responses 的 `ProviderConversationStateAdapter` 与 `providerReplay` side-channel 是基线。本设计扩展该抽象，不重写消息系统、数据库或 Runner 状态机。

## 快速结论

```text
模型流式返回 reasoning
  → Worker 将 text / reasoning / tool_call 全部保存为 Assistant Part 并附 provenance
  → API 在 protected PromptContext 中推导 Assistant provenance 和回放边界
  → Adapter 只恢复历史尾部连续兼容段的 reasoning
  → Runner 用官方 SDK 发送标准 ModelMessage
  → 官方 SDK 生成 Provider 所需 reasoning 请求字段
```

以下规则不可突破：

- Moonshot **必须**使用官方 `@ai-sdk/moonshotai`，不得通过 `@ai-sdk/openai-compatible` 实现或回退；DeepSeek **必须**使用官方 `@ai-sdk/deepseek`。
- 新 Provider 的 Agent 主调用和 Worker single-call 固定开启思考；thinking、`reasoningHistory`、`reasoningEffort` 是 reserved keys，不向用户提供开关或覆盖路径。
- capability 的 `buildProviderOptions()` 是 reserved fixedOptions 的唯一来源；shared `mergeReasoningProviderOptions(rawNamespacePayload, fixedOptions)` 是唯一的清理与 fixed-last 浅合并语义。Adapter 在 `prepareInvocation()` 中应用该逻辑、完整保留结果，并同时处理 replay 与 attemptContext。
- `PreparedProviderInvocation.providerOptions` 始终是当前 Provider namespace 的**内部 prepared payload**，可同时有合法非 reserved options 和 fixed options，例如 `{ parallelToolCalls: true, thinking: ..., reasoningHistory: ... }`。Runner 不修改或丢弃其中任何内部 option，只按 `providerOptionsKeyByNpm()` 包装一次，禁止双重 namespace。
- 非 reserved 的合法 namespace options 仍允许用户配置：共享 sanitizer 只接受 JSON plain object，并清理危险键和顶层 reserved keys。
- 只有 Worker 单一静态精确模型能力表中、已经完成 Spike 与官方端点验收的模型可调用。未列入模型必须在网络请求前失败，不能降级普通调用。
- 通用 `RuntimeTranscriptProjector` 不携带 reasoning；reasoning 只经内部 `providerReplay` side-channel 到目标 Adapter。
- 不跨 Provider、Provider 配置实例、实际模型、协议版本或 provenance/legacy 缺口恢复 reasoning。
- recovery continuation 只允许恢复相同 Run 与相同 immutable identity 的既有 streaming Assistant；无法证明已有 Part provenance 安全时，必须 replacement 或 fail closed。
- 默认不新增数据库字段；只有 Spike 证明标准 AI SDK 事件无法表达必要状态时，才可提出条件升级设计并另行评审。

## 文档导航

| 文档 | 用途 |
|---|---|
| [01-需求与产品契约.md](./01-需求与产品契约.md) | 背景、术语、严格支持范围、产品规则与非目标 |
| [02-现状证据与架构.md](./02-现状证据与架构.md) | 当前代码事实、相关文档关系、目标调用链与职责边界 |
| [03-契约数据与回放算法.md](./03-契约数据与回放算法.md) | replay union、provenance、PromptContext、连续兼容段、attempt/hook 设计 |
| [04-Provider接入与调用生命周期.md](./04-Provider接入与调用生命周期.md) | 能力表、工厂、reserved keys、固定 payload、Adapter/Runner/Single-call 生命周期 |
| [05-边界失败安全与兼容.md](./05-边界失败安全与兼容.md) | reasoning-only、工具时序、Retry、Fork/Revert、Compaction、legacy、隐私边界 |
| [06-Spike测试与验收.md](./06-Spike测试与验收.md) | Spike 门槛、测试分层、发布前联调、可执行验收标准 |
| [07-实施计划与审查清单.md](./07-实施计划与审查清单.md) | 阶段任务、实施步骤、完成定义、审查与回滚清单 |

## 文档约定

- **必须（MUST）**：实现、测试和审查均不可放宽；不满足即不可验收。
- **应（SHOULD）**：默认要求。偏离时必须记录原因、影响、替代保护和新增证据。
- **Spike 门槛**：尚未由锁定 SDK 与官方端点共同验证的事实。未通过前不得写入正式支持表或宣称可用。
- “实际模型”是 `providerModelId` 非空时的 trim 后值，否则为模型 `id`。
- `assistantOrdinal` 是当前 provider-neutral `messages` 数组中 Assistant message 的索引；名称是现有契约，不在本期重命名，也不能解释为“第几个 Assistant”。

## 与既有设计的关系

- [0019 OpenAI Responses 加密 Reasoning 回放](../0019-OpenAI-Responses加密Reasoning回放/01-OpenAI-Responses加密Reasoning回放核查.md) 是已实现的 OpenAI 基线；其 encrypted content、item ID、raw terminal event 和专属校验继续保留。
- [0022 Provider 对话状态适配器](../0022-Provider对话状态适配器/README.md) 已完成 OpenAI Adapter 提取；其中未实施的 DeepSeek Compatible、模型级 `protocolAdapter`、thinking 用户配置和协议快照预留与本设计冲突，不得照搬。
- 本目录覆盖 0022 中与 Moonshot/DeepSeek 新 Provider 冲突的未实施预留，但不改变既有 OpenAI envelope JSON 或 OpenAI replay 算法。

## 交付定义

交付不是“能创建 SDK 实例”，而是同时满足：

- 精确模型能力表有真实 Spike/官方端点证据；
- 同 Provider/config/model 多轮 replay、工具子轮、下一 User turn、Retry replacement、Fork/Revert、Compaction 和切换边界闭环通过；
- reasoning-only Assistant 只在协议允许、非空 reasoning、identity 一致且 metadata final flush 成功时完成；
- Agent/single-call 对相同输入产生相同清理与 fixed-last 合并 payload；recovery continuation 不会混入不同 identity 的既有 Part；
- OpenAI Responses 回归通过；
- 只对 Worker 能力表中精确 verified 模型发布支持说明。
