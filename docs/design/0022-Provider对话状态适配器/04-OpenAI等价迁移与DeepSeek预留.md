# OpenAI 等价迁移与 DeepSeek 预留

## Phase A：OpenAI 行为等价迁移

Phase A 的唯一目标是将现有 OpenAI Responses replay 的协议逻辑迁入 `OpenAIResponsesConversationStateAdapter`。它是重构，不是功能变更。

### 必须保持的请求行为

- 官方 `@ai-sdk/openai` 继续使用 `sdk.responses(providerModelId)`。
- OpenAI Compatible 继续使用 `chatModel(providerModelId)`；Anthropic 保持既有路径。
- 每次请求继续发送完整有效 transcript；不得引入 `previous_response_id`、conversation 引用链或增量 tool-result 请求。
- OpenAI Adapter 必须强制：

```ts
{
  store: false,
  include: ["reasoning.encrypted_content"],
}
```

- 既有合法 `include` 值保留并去重。
- `previousResponseId`、其下划线/连字符变体、`conversation`、`reasoningContext` 及其变体必须过滤。
- `includeRawChunks: true` 继续只在官方 OpenAI Responses 路径开启。
- Provider 配置 ID 与最终模型 ID 不匹配时，任何旧 replay 必须跳过。
- Phase A 继续维持现有顺序：replay 注入 → 附件物化 → 工具发现；不得为了 DeepSeek 重排。

### OpenAI 状态采集与回放

Adapter 必须保留以下职责：

| 事件/数据 | 必须行为 |
|---|---|
| reasoning start/delta/end | 将原生 item ID、加密内容（如已有）、summary segment 身份转换为 reasoning metadata update |
| text | 保存 OpenAI text item identity 和 `phase`，便于完整 transcript 回放 |
| tool-call | 保存 function-call item identity，并严格匹配 AI SDK toolCallId |
| `response.completed` raw event | 补齐 final-only `encrypted_content`，可 fan-out 到同一原生 item 的多个本地 reasoning part |
| response failed/incomplete | 记录 TerminalProtocol failure，禁止当前 Attempt 成功提交 |
| finish reason unknown | 记录 TerminalProtocol failure，禁止当前 Attempt 成功提交 |

Runner 仍创建普通 Part 并决定 `position`；Adapter 仅识别协议 metadata。

### 多 reasoning Part 的等价要求

一条 Responses 输出可能包含多个 reasoning Part。以下必须支持：

- 多个不同原生 reasoning item；
- 同一原生 item 的多个 summary segment；
- 同一 stream part 的多次 delta 累加；
- reasoning、text、tool-call 的单调交错顺序；
- 多个本地 summary segment 对应同一 item 时，从 terminal event 取得的 encrypted content 向全部对应 Part 补齐；
- 下一轮回放时以 `position`、`assistantOrdinal`、`visibleIndex` 恢复顺序；同 item 多 segment 的聚合语义保持不变。

不得将多个 reasoning item 合并成一个普通文本 Part，也不得丢失 text/function 的原生 identity。

### metadata-only 与空内容

- reasoning 可见文本为空但存在 replay metadata 时，必须可创建和持久化。
- terminal 事件只补 metadata、不追加文本时，必须允许 metadata-only 更新。
- 空 Assistant 若仅包含可回放 reasoning metadata，完成后必须保留为 replay-only Assistant；不兼容 Adapter 物化时不得保留无意义空 Assistant。
- 所有 metadata-only 更新必须在成功提交前 flush 并被 Store 接受。

### OpenAI 终态门禁与 retry 等价性

对官方 OpenAI Responses，以下任一情况必须阻止当前 Attempt 的 `completeAssistant`：

- 流结束前未见明确 `response.completed`；
- 见到 `response.failed` 或 `response.incomplete`；
- AI SDK finish reason 为 `unknown`；
- raw terminal metadata 处理或 flush 失败；
- Adapter `finalizeAttempt()` 返回失败。

这些规则在迁移后必须保留，即使普通 text 已被流式写入也不能提交为 completed。

关于 retry，Phase A 的要求是**保持当前 Runner 的既有语义**：上述缺 completed、failed/incomplete、unknown 必须继续按当前错误路径交给 Runner 的既有 retry/replacement 策略处理；不得在 Adapter 提取时将其变成不可重试，也不得把它们误分类为网络错误。无论是否重试，失败 Attempt 绝不可完成，且新的 Attempt 不得继承旧协议状态。

### 已知限制必须原样记录

Phase A 不得借重构悄悄改变以下现有边界，除非新增独立需求、测试和审查：

| 限制 | 当前行为 | Phase A 要求 |
|---|---|---|
| 终态独有 reasoning item | 若 item 只出现在 `response.completed`，此前没有可映射 reasoning stream part，则不会凭终态新建展示 Part | 保持现状；不得假称已支持 |
| 乱序回补旧 Part | 已切到后续 Part 后，旧 reasoning/text Part 再有 delta 会触发不变量错误 | 保持 fail closed；不得重排已持久化位置 |
| 真实 OpenAI 联调 | 当前依据 SDK mock fetch/SSE 验证 | 不宣称已做真实服务验证 |

这些限制要在测试中固定并在后续协议兼容工作中单独处理。

## Phase C：DeepSeek Thinking experimental 接入

### 状态与适用 API

- 状态：**experimental**。未经 Phase D 真实 DeepSeek 服务联调，不得标记 stable 或作为稳定兼容承诺。
- 适用范围：`@ai-sdk/openai-compatible` 的 DeepSeek Chat Completions Thinking 路径，且模型级 `protocolAdapter` 明确为 `deepseek-chat-thinking`。
- 核查日期：**2026-03-12**。
- 资料：
  - [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
  - [创建对话补全](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)
  - [工具调用](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)
  - [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api)

本方案针对 Chat Completions Thinking，不将 DeepSeek Responses API 与 OpenAI Responses encrypted replay 混为同一协议。

### 已核实的官方规则与资料冲突

Thinking 文档说明：

- 思考模式中 `reasoning_content` 与 `content` 同级，流式 delta 会返回 reasoning 内容。
- 请求携带 `tools` 时，历史轮次 `reasoning_content` 必须完整回传；未正确回传可能返回 `400`。
- 请求不携带 `tools` 时，无需回传；传入时服务端可能忽略且不拼接进上下文。
- 思考模式不支持 `temperature`、`presence_penalty`、`frequency_penalty`；为兼容旧软件，服务端可能不报错但不生效。
- `top_p` 仅在思考模式生效；官方页给出的有效范围为 `0.95–1.0`，低于 `0.95` 服务端按 `0.95` 处理；非思考模式固定为 `1.0`，传入值忽略。
- OpenAI 格式的 `reasoning_effort` 规范值为 `low`、`high`、`max`；思考模式默认开启且默认 `high`。官方映射中 `minimal`/`medium`/`xhigh`/`ultra` 是输入兼容别名，分别映射为 `low`/`high`/`high`/`max`，不应作为持久化规范值。

官方资料另有关于“新用户问题后删除此前思维链”的表述，与“携带 tools 时历史轮次 reasoning 均应回传”的表述可能存在 Turn 边界解释差异。第一版不以猜测解决冲突，采用本设计已经裁决的 experimental scope，并以 Phase D 真实服务验证为硬门禁。

### 模型级配置与参数 schema

`protocolAdapter` 位于最终 Provider Model 的 `options` 中：

```ts
type ProtocolAdapter = "default" | "deepseek-chat-thinking";

type DeepSeekThinkingProtocolOptions = {
  thinking: { type: "enabled" };
  reasoningEffort?: "low" | "high" | "max";
};
```

最终字段名可与 DeepSeek HTTP 字段的 `reasoning_effort` 做明确映射，但 schema 必须：

- 只允许 `deepseek-chat-thinking` 使用该对象；
- 只允许 `@ai-sdk/openai-compatible + deepseek-chat-thinking`；
- `thinking.type` 固定为 `enabled`，不允许通用用户 options 覆盖；
- `reasoningEffort` 的保存规范值仅允许 `low`、`high`、`max`，缺失规范化为 `high`；Factory 最终只发送这三个值。
- 历史/导入配置若出现官方兼容别名，保存时必须规范化：`minimal → low`、`medium → high`、`xhigh → high`、`ultra → max`；无法映射的值拒绝保存。读取旧值后必须在下一次成功保存时写为规范值。
- 不得透传任意字符串，也不得把 `medium` 当作新的规范内部值；选择该 schema 是为了与 2026-03-12 核查到的官方 OpenAI 格式规范值和映射表一致。
- 保存时默认 `protocolAdapter` 省略，读取时补为 `default`；
- settings 保存拒绝 npm/协议/参数非法组合；Worker 和 `ProviderModelFactory` 再次防御；
- Session 模型覆盖使用最终解析模型的字段。

### Thinking 参数准备策略

DeepSeek Thinking 的请求准备规则固定如下：

| 字段 | 规则 |
|---|---|
| `thinking` | 只能由模型级协议配置生成；强制 `{ type: "enabled" }`，优先于通用用户字段 |
| `reasoning_effort` | 只能由协议白名单 `reasoningEffort` 映射；协议值优先，不允许 `providerOptionsByKey` 偷渡任意值 |
| `temperature` | 请求准备时移除；产生不含原值的结构化诊断 `removedUnsupportedSetting: "temperature"` |
| `presencePenalty` | 请求准备时移除；产生不含原值的结构化诊断 |
| `frequencyPenalty` | 请求准备时移除；产生不含原值的结构化诊断 |
| `topP` | 仅接受有限数值且必须在 `0.95 <= topP <= 1.0`；超出范围在 settings 保存/最终 profile 校验时拒绝，不得静默夹紧；合法值映射到 HTTP `top_p` |

当前通用 settings schema 对 `topP` 仅要求 number，因此 Phase C 必须在 protocol-specific schema 和 Worker 防御层增加上述范围验证。服务端会夹紧低值不是本地静默夹紧的理由：本地拒绝可避免配置与实际行为不一致。

### 唯一 HTTP 注入路径

在创建模型前，Runner 必须从最终 `ExecutionProfile.model.options.protocolAdapter` 解析协议，交给受限 `ProviderModelFactory`：

```text
最终 ExecutionProfile
→ 解析模型级 protocolAdapter
→ ProviderModelFactory
→ openai-compatible DeepSeek model + 受控 transformRequestBody
→ streamText()
```

- Factory 为 `@ai-sdk/openai-compatible + deepseek-chat-thinking` 安装 `transformRequestBody`，将白名单 thinking/reasoning_effort 和已验证 top_p 写入最终 Chat Completions HTTP body，并移除不支持字段。
- 该 Factory 不接受 Adapter 任意替换 model/baseURL 的请求；Adapter 仅提供历史 messages/state 与有限 directive。
- 如果当前 AI SDK providerOptions 被证明可可靠生成完全等价的 body，可替换 transform；但必须保留真实 SDK + mock fetch 对最终 body 的回归断言。
- shared single-call/compaction 不经此 Factory 特化分支，默认不得启用 DeepSeek Thinking。

### 第一版状态与回放 payload

DeepSeek `reasoning_content` 是明文，第一版作为可见 reasoning 保存到现有 reasoning Part.`text`。私有 Envelope 仅记录协议匹配及 `contentSource: "reasoning-part-text-v1"` 等必要 metadata；不重复保存原文。

稳定接入的硬前提是：真实 AI SDK + mock SSE 测试必须证明同一个 response 的全部 `reasoning-delta` 按 stream part 规则拼接后的 Part.`text`，与完整 DeepSeek `reasoning_content` 字节级一致；不得是摘要、改写或截断。

- 如果不能证明，Phase C 必须停止，另立“独立私有状态实体/私有锚点”设计；不得静默降级为回放可见摘要或部分文本。
- 本方案不提供隐藏 DeepSeek reasoning 的半实现；未来隐藏属于独立产品和数据模型变更。
- Phase C 同时必须把 Assistant Message 协议快照纳入目标 schema，并完成 `completion: "complete-v1"` terminal metadata 闭环；仅扩展 Envelope 不足以满足完整性保证。
- 快照、terminal finish allowlist、EOF/unknown/error/abort/timeout 失败语义见 [08-PhaseC协议快照与完整性闭环.md](./08-PhaseC协议快照与完整性闭环.md)。

### DeepSeek 回放 scope 与 toolsDisposition

唯一暂行 scope：ModelContext Resolver 当前有效上下文中，最后一条 User 消息之后、当前请求之前的全部兼容 Assistant reasoning Parts。

- 首轮没有回放。
- 工具循环后续请求回放上述全部 reasoning；Provider ID、最终模型、协议必须匹配。
- 新 User 消息切断旧 reasoning 回放；compaction 后仍服从 ModelContext Resolver，retained tail 中满足 scope 的 reasoning 可回放，resolver 外旧历史不补回。
- 本次请求是否回放还取决于 `toolsDisposition`：
  - `"present-non-empty"`：最终 streamText 请求实际发送非空 tools，按 scope 回放。
  - `"omitted"`：最终请求省略 tools（空工具集合也必须归此类），不得注入 DeepSeek reasoning。
- 该 disposition 必须由与同一次 `streamText` 请求共享的最终 toolSet 快照推导，mock HTTP body 必须验证其与最终 `tools` 字段一致。

### DeepSeek Attempt 与完整性

- DeepSeek Attempt 必须将流式 reasoning 拼接、Part 关联、完成性标记和 Envelope update 作为同一协议状态处理。
- reasoning delta 可以即时更新可见 Part.`text`，但不得即时写 DeepSeek replay Envelope；`reasoning-end` 不代表 response 完整。
- 仅观察到 allowlist 中的 `stop` 或 `tool-calls` finish reason 后，Attempt 才能为本 Attempt 的 reasoning Parts 生成 `contentSource: "reasoning-part-text-v1"` 与 `completion: "complete-v1"` metadata-only update。
- EOF 无 finish、`unknown`、`length`、`content-filter`、error、abort、timeout 或取消均为 TerminalProtocol 失败；不得 complete，且不得产生 `complete-v1`。
- 所有 terminal metadata update 必须强制 flush 成功后才可 `finalizeAttempt()`/`completeAssistant()`；flush 或兼容性失败阻止完成。
- completed Assistant 才能成为 DeepSeek state source。
- 流中断、abort、timeout、flush/complete/replacement 失败、failed/cancelled/superseded Assistant 均不得生成可回放 state。
- 在必需 scope 内，任何 snapshot 匹配 DeepSeek 的 `missing-required-metadata`、`missing-reasoning-text`、`incomplete-reasoning-text`、可识别的 schema/版本损坏必须在请求前 fail closed；不得悄悄丢掉一段 reasoning 后继续请求。

### Phase D 升级门禁

Phase D 必须用真实服务验证：工具循环回放、无 tools 行为、新 User scope、Provider/模型切换和缺失 reasoning 的服务端表现。

真实结果若否定本章 scope 或参数假设，必须同步修改 Adapter、Factory、fixtures、验收标准和本文档，随后重新审查。完成前 DeepSeek 保持 experimental。

## 产品 UI 与 API 文档交付

Phase C 不是纯 Worker 协议改动，必须同步交付模型设置界面与 API 文档：

- 模型表单只在 `@ai-sdk/openai-compatible` 模型上提供 `deepseek-chat-thinking` 选项；其他 npm 组合在 API 保存时拒绝，并在 UI 显示明确非法组合提示。
- 选择该 experimental 选项时，表单必须展示不可弱化的警告：**“实验性：Provider 返回的完整 reasoning 会保存并显示在此 Agent 会话中。”** 不得使用“私有”“隐藏”或“不会保存推理”等误导措辞。
- 表单提供规范 `reasoningEffort` 的 `low`/`high`/`max` 选择，默认 `high`；历史兼容别名在读取后可显示规范结果，下一次保存必须规范化。
- API/OpenAPI 或设置接口说明必须标注 experimental、npm 限制、可见 reasoning、参数删除与 `topP` 范围；不得仅在前端提示。
- UI、settings service、shared schema 和集成测试必须覆盖：历史默认配置、别名规范化、非法 npm/协议组合、警告文案、Session 最终模型覆盖与保存后重新读取。
