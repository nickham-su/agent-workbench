# Provider 接入与调用生命周期

## 依赖与 Provider 基础接入

当前仓库使用 `ai: ^5.0.260`。新增依赖目标为：

```text
@ai-sdk/moonshotai@ai-v5
@ai-sdk/deepseek@ai-v5
```

调研候选曾解析到 Moonshot `0.0.26`、DeepSeek `1.0.57`，但不是可直接写死的保证。安装/Spike 必须记录 lockfile 实际版本、peer/transitive 兼容性、factory 类型、chat model selector、options namespace 和模型 ID 序列化分支；不得为了安装新 Provider 升级 `ai` major。

`apps/agent-worker/package.json` 增加主 Agent 所需依赖。`packages/shared/package.json` 只有在 `packages/shared/src/llm/single-call.ts` 实际导入官方工厂时才增加相同依赖。

### Provider discovery Spike

Provider 基础接入 Spike 必须为每个 Provider 产出并复核：

| 项目 | 必须结论 |
|---|---|
| 官方默认 Base URL | 精确官方 URL、是否/何时自动附加 `/v1`，以及用户自定义 `baseURL` 的覆盖规则 |
| SDK baseURL 语义 | `createMoonshotAI`/`createDeepSeek` 接收的 URL 形状，不能凭经验拼接或重复 `/v1` |
| 模型列表 | 官方模型列表 endpoint、认证方式、返回 shape 与 SDK 是否暴露该能力 |
| 列表失败 | 模型列表不可用、网关不支持或网络失败时，继续使用既有 configured-model fallback；不能阻断已配置 verified 模型运行 |
| Web 文档链接 | 设置页实际显示/跳转的官方文档链接、文案与 Provider 名称 |

这些结论必须形成可测试 Provider descriptor 或等价配置，不得把未验证 URL、endpoint 或 model list 假设写成产品默认值。

## Settings、reserved keys 与能力表

### settings contract

`packages/shared/src/contracts/settings.ts` 的 `AgentProviderNpmSchema` 增加：

```ts
"@ai-sdk/moonshotai"
"@ai-sdk/deepseek"
```

所有 `AgentProviderNpm` 穷尽分支、execution profile、API settings、前端 Provider 选择及测试 fixture 必须同步处理。常规 Provider 形状仍是：

```ts
{
  id,
  name,
  npm,
  options: { baseURL, apiKey },
  models: [{ id, providerModelId?, name, contextWindowTokens, options? }]
}
```

API 保存路径必须调用 shared 的唯一 sanitizer，清理 Moonshot、DeepSeek 模型 generic Provider Options 内的 `thinking`、`reasoningHistory`、`reasoningEffort` reserved keys 和危险键。Web 不显示独立 thinking 控件，并复用同一函数做 generic JSON/Options 提示、校验与提交前清理；这只是 UX，API 保存和 Worker invocation 才是行为权威。历史值在 Worker 运行时同样由该函数清理、下次保存清理。该处理不报冲突错误。

规范化与对象规则详见 [03](./03-契约数据与回放算法.md)：

- 顶层 reserved key 的唯一规范化是 `trim → 删除 '_' 与 '-' → lowercase`；
- 只接受 JSON plain object，至少清理 `__proto__`、`prototype`、`constructor`；
- 只在顶层删除 reserved 整键，不递归删除普通嵌套 option 的同名键；
- Web/API/Worker 禁止分别实现不同的 key matcher 或 sanitizer。

### Worker 单一能力表

新增 Worker 内单一静态模块（建议位于 `apps/agent-worker/src/runtime/providers/`）作为唯一运行时权威。它必须提供：

```ts
type ReasoningProviderModelCapability = Readonly<{
  providerNpm: "@ai-sdk/moonshotai" | "@ai-sdk/deepseek";
  model: string; // 精确实际模型 ID
  protocol: "moonshot-chat" | "deepseek-chat";
  protocolVersion: 1;
  buildProviderOptions(): Readonly<Record<string, unknown>>;
}>;

resolveReasoningProviderModelCapability(profile): ReasoningProviderModelCapability
```

`buildProviderOptions()` 只生成 reserved 参数的**固定 `fixedOptions`**，其形状是 namespace 内部 payload，但它不是含用户 options 的最终 prepared payload：

```ts
// Moonshot 示例；绝不写成 { moonshotai: { ... } }
{ thinking: { type: "enabled" }, reasoningHistory: "preserved" }

// DeepSeek 示例；绝不写成 { deepseek: { ... } }
{ thinking: { type: "enabled" } }
```

K2.7 Code 等模型若 Spike 证明不能接受某个显式字段，能力表用该精确模型项的 fixed payload 表达其合法映射；不得用模型前缀猜测。用户 options 不是 ignored 的整体：其余合法 top-level option 要保留，统一通过：

```ts
// Adapter.prepareInvocation() 中的唯一合并路径。
preparedProviderOptions = mergeReasoningProviderOptions(
  rawNamespacePayload,
  capability.buildProviderOptions(),
);
```

该纯函数先生成 `sanitizedUserOptions`，再做 `{ ...sanitizedUserOptions, ...fixedOptions }`。fixed 最后浅覆盖，reserved 整键不深合并。reserved 参数只能来自 `capability.buildProviderOptions()`；shared merge 是唯一合法合并实现。Adapter 必须在 `prepareInvocation()` 中调用/使用它，完整保留得到的内部 `preparedProviderOptions`，再处理消息 replay 与 immutable `attemptContext`。它通常可同时包含合法 non-reserved option，例如 `{ parallelToolCalls: true, thinking: ..., reasoningHistory: ... }`。

严格规则：

- 新 Provider 的 Agent invocation 在创建 SDK model、streaming Assistant、网络请求和工具输入前必须调用 resolver。
- 未命中精确项必须 preflight 失败；Adapter Registry 不得返回 `null` 让调用退化为普通调用。
- 能力表初始不填伪造 verified 模型。Spike 后才能加入精确 ID，并同步更新 [06](./06-Spike测试与验收.md) 的发布记录。
- Web 不读取、展示或编辑能力状态；不新建 shared capability API。

## 官方 model factory 与 namespace

扩展 `apps/agent-worker/src/runtime/runner.ts` 的：

- `providerOptionsKeyByNpm()`：返回 `moonshotai` 或 `deepseek`；
- `createLanguageModel(profile)`：使用 `createMoonshotAI({ apiKey, baseURL })` 或 `createDeepSeek({ apiKey, baseURL })`，以实际模型 ID 创建官方 chat-completions model。

精确 chat model selector 由锁定 SDK 类型和 mock request 证实；不能用 `any` 掩盖错误。Moonshot 不得经过 `createOpenAICompatible()` 或 `openaiCompatible` namespace；DeepSeek 同样不得走该路径。

Adapter 与 Runner 的 payload 边界固定为：

```ts
const prepared = adapter.prepareInvocation(...);
// 当 sanitizedUserOptions 为空：{ thinking, reasoningHistory } 或 { thinking }。
// 通常还可包含 { parallelToolCalls: true, thinking: ..., reasoningHistory: ... }；
// Runner 不修改、重新合并或丢弃任何内部 option。

requestBase.providerOptions = {
  [providerOptionsKeyByNpm(profile.provider.npm)]: prepared.providerOptions,
};
```

Runner 只原样包装一次，且只有 `Object.keys(prepared.providerOptions).length > 0` 时设置 request options。测试必须断言：

```text
存在 moonshotai.thinking，而不存在 moonshotai.moonshotai
存在 deepseek.thinking，而不存在 deepseek.deepseek
```

## Adapter Registry、context 与最终消息

### Registry

`apps/agent-worker/src/runtime/providers/conversation-state/registry.ts` 保持 OpenAI 优先，并增加官方 Provider Adapter：

```ts
createOpenAIResponsesConversationStateAdapter(profile)
  ?? createMoonshotConversationStateAdapter(profile, capability)
  ?? createDeepSeekConversationStateAdapter(profile, capability)
```

对新 Provider，Runner 先完成能力表 preflight，再把 capability 交给 factory；所以 factory 对合法 profile 必须返回 Adapter。它不承担“未验证模型返回 null”的降级选择。

### type contract

`conversation-state/types.ts` 扩展 protocol union、`PreparedProviderInvocation`、mandatory context、`createAttempt(context)`、part hook 和成功 validation capability，详见 [03](./03-契约数据与回放算法.md)。所有现有/新增 Adapter 均返回 attempt context；OpenAI 的 context 从现有 profile 与 `version: 1` 身份映射构造，不改变 OpenAI replay 算法。

### 完整生命周期

```text
每次 Agent model step：
  Worker capability preflight（新 Provider）
  → capability.buildProviderOptions() 生成 fixedOptions
  → resolve model / Adapter
  → Adapter.prepareInvocation(messages, history, raw namespace payload, fixedOptions)
      内部调用/使用 shared merge，完整保留 preparedProviderOptions，并处理 replay/context
  → 得到 immutable attemptContext
  → attachment materialization / tool definitions / request build
  → Runner 不修改 prepared 内部 option，按 namespace 原样包装一次并请求模型
  → 每次真实请求 createAttempt(context)
  → 流中 materialize Part 后调用 hook
  → finalizeAttempt
  → final flush
  → 原子完成 Assistant + 创建 queued ToolExecution

retry：相同 model step/context、新 Attempt、新 replacement Assistant
工具子轮：重新取 PromptContext、重新 preflight/prepare、新 context/new Attempt
下一次用户调用：重新取 PromptContext、重新 preflight/prepare、新 context/new Attempt
```

有 `recoveryContinuation` 时，在 `createAttempt(context)`、新网络请求或复用 streaming Assistant 前额外执行 [03](./03-契约数据与回放算法.md) 的 identity fence。只有同 Run、同 identity、已有 Part metadata identical 的 continuation 可继续；不能证明时优先走现有安全 replacement，仍不能隔离旧 Part 时 fail closed。不得把 recovery 作为跳过 capability preflight、sanitize/merge 或 Part hook 核验的捷径。

DeepSeek 第一版恢复策略不依赖 `hasTools`，所以无需为了本需求改变当前 `prepareInvocation()` 与 toolSet 构建顺序。只有 Spike 证明需要 active continuation preflight 时，才另行设计最小输入扩展。

## Single-call

`packages/shared/src/llm/single-call.ts` 增加两个官方工厂和 namespace 映射，但 single-call 不接入 Conversation State、Attempt、history replay 或 `providerReplay`。

Worker single-call（含 compaction 等一次性调用）也必须使用同一个 Worker 精确能力表：

- Worker 先 resolve capability；未命中在网络请求前失败。
- capability 先以 `buildProviderOptions()` 生成 fixedOptions；single-call 的 Worker invocation preparation 再以同一个 shared `mergeReasoningProviderOptions(raw, fixedOptions)` 生成并完整保留内部 prepared payload，作为**非持久化、内部调用参数**传给 shared single-call。
- shared single-call 不得从模型 options 自行读取 reserved keys，也不得实现第二套 sanitizer/merge、修改或丢弃该 prepared payload；它只原样消费 Worker 已计算的 payload，并按 namespace 包装一次。
- 若 shared single-call 被其他路径直接调用 Moonshot/DeepSeek 却没有该内部 policy，必须 fail closed，不能默认普通调用。
- single-call 仍只发送当前 one-shot 输入；不恢复、保存或回传历史 reasoning。

这保证 single-call 的默认思考与主调用一致，同时不把多轮协议扩散到 compaction/summary。

## Provider 差异

| 项目 | Moonshot | DeepSeek |
|---|---|---|
| SDK | 官方 Moonshot SDK | 官方 DeepSeek SDK |
| 固定内部 payload | enabled + preserved-history，精确模型映射 | enabled |
| 历史回传 | 恢复 reasoning Part + 官方 `reasoningHistory` 机制 | 恢复 reasoning Part，SDK 生成 `reasoning_content` |
| 工具策略 | 保持 transcript/tool 顺序 | 始终恢复连续兼容 reasoning，不按 `hasTools` 分支 |
| raw chunks | 不需要，除非 Spike 证明必要 | 不需要，除非 Spike 证明必要 |
| 公开支持 | 仅能力表精确项 | 仅能力表精确项 |
