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
| 模型列表 | 已按公开官方文档接入：Moonshot 配置 `/v1` 时取 `/v1/models`，未带 `/v1` 时补 `/v1/models`；DeepSeek 在配置地址后直接附加 `/models`（显式 `/v1` 视为网关路径）。均使用 Bearer API Key，读取 `data[].id`；实际账号返回结果仍待持 Key 验证 |
| 列表失败 | API 仍安全回退已配置模型的实际 `providerModelId`（非空优先，否则 `model.id`）供其它路径使用；Moonshot/DeepSeek 设置页在 `fallback`（包括带警告的缓存）或请求异常时静默清空下拉候选且不显示警告，保留编辑值及手动输入；日志不输出原始 URL/凭证/上游正文，不阻断模型运行 |
| Web 文档链接 | 设置页实际显示/跳转的官方文档链接、文案与 Provider 名称 |

模型列表查询是设置页候选功能，不是模型 ID 白名单；成功时官方列表与已配置模型按实际 Provider ID 去重合并，官方列表缺少某 ID 也允许用户手动输入。自定义网关沿用配置的路径前缀，重定向或带 URL 凭证/查询串的发现请求安全回退；两家设置页不渲染回退候选或任何警告。保留现有缓存与 refresh 语义，不改变其它 Provider 提示。独立的本地 mock 证明请求 URL、鉴权、shape 和回退逻辑；不能将它当作真实账号/端点验收。

Moonshot/DeepSeek 的回放身份还须绑定当前 Worker 对配置 baseURL 计算的 SHA-256 摘要；仅保存摘要，不保存原 URL/凭证。未配置 URL 与显式默认 URL 保守视作不同端点。API 的连续兼容段和 Worker 的恢复均在端点摘要变化处截断；OpenAI 既有 envelope 与回放不受此新约束影响。

## Settings、reserved keys 与固定策略

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

### shared Provider 固定策略

`packages/shared/src/llm/reasoning-provider-policy.ts` 的 `reasoningProviderFixedOptions(providerNpm)` 按 Provider npm 返回固定内部 payload，不接受模型 ID、不维护精确准入表。Moonshot 返回 `{ thinking: { type: "enabled" }, reasoningHistory: "preserved" }`，DeepSeek 返回 `{ thinking: { type: "enabled" } }`。Agent Adapter 与 shared single-call 均使用 `mergeReasoningProviderOptions(rawNamespacePayload, fixedOptions)`：先清理用户 reserved/危险键，再 fixed-last 浅合并；合法非 reserved 顶层选项保留。返回值不含 Provider namespace 外壳。

实际模型 ID：非空 `providerModelId.trim()` 优先，否则使用本地 `id`。任何用户填写的模型 ID 都可进入官方 SDK；不存在 Worker/single-call 前置白名单检查。SDK 的模型特定序列化分支仍由 SDK 自行决定：Moonshot K2.6 把 preserved history 转为 `thinking.keep=all`，K2.7/未知 ID 不保证相同映射；`moonshot-v1-*` 旧非思考模型由锁定 SDK warning 并省略不支持的 thinking/history 字段后继续请求；DeepSeek V4/flash/pro 与旧模型/别名对跨 User turn reasoning 的处理可能不同。固定 policy 不是对所有模型的实际思考保证；不得篡改 `reasoning_content` 或承诺所有自定义模型的回传语义等同。

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
  ?? createMoonshotConversationStateAdapter(profile)
  ?? createDeepSeekConversationStateAdapter(profile)
```

对新 Provider，Registry 根据合法 Provider profile 返回 Adapter；既不查询模型准入表，也不接受调用方注入 policy。

### type contract

`conversation-state/types.ts` 扩展 protocol union、`PreparedProviderInvocation`、mandatory context、`createAttempt(context)`、part hook 和成功 validation capability，详见 [03](./03-契约数据与回放算法.md)。所有现有/新增 Adapter 均返回 attempt context；OpenAI 的 context 从现有 profile 与 `version: 1` 身份映射构造，不改变 OpenAI replay 算法。

### 完整生命周期

```text
每次 Agent model step：
  resolve actual model / Adapter
  → shared reasoningProviderFixedOptions(providerNpm) 生成 fixedOptions
  → Adapter.prepareInvocation(messages, history, raw namespace payload)
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
工具子轮：重新取 PromptContext、重新 prepare、新 context/new Attempt
下一次用户调用：重新取 PromptContext、重新 prepare、新 context/new Attempt
```

有 `recoveryContinuation` 时，在 `createAttempt(context)`、新网络请求或复用 streaming Assistant 前额外执行 [03](./03-契约数据与回放算法.md) 的 identity fence。只有同 Run、同 identity、已有 Part metadata identical 的 continuation 可继续；不能证明时优先走现有安全 replacement，仍不能隔离旧 Part 时 fail closed。不得把 recovery 作为跳过 sanitize/merge 或 Part hook 核验的捷径。

DeepSeek 第一版恢复策略不依赖 `hasTools`，所以无需为了本需求改变当前 `prepareInvocation()` 与 toolSet 构建顺序。只有 Spike 证明需要 active continuation preflight 时，才另行设计最小输入扩展。

## Single-call

`packages/shared/src/llm/single-call.ts` 增加两个官方工厂和 namespace 映射，但 single-call 不接入 Conversation State、Attempt、history replay 或 `providerReplay`。

Worker single-call（含 compaction 等一次性调用）及直接调用 shared single-call 都按 Provider npm 获取同一固定 options，调用 shared `mergeReasoningProviderOptions(raw, fixedOptions)`，按 namespace 包装一次。两种调用均使用配置中的实际模型 ID，允许自定义 ID 发往 SDK，不接受用户 `thinking`/`reasoningHistory`/`reasoningEffort` 覆盖；SDK 可能自行省略旧非思考模型不支持的字段并继续请求；只有 SDK/API 实际返回错误时才沿受控失败路径报错，绝不自动关闭 thinking 再重试。single-call 只发送当前 one-shot 输入，不恢复、保存或回传历史 reasoning。

这保证 single-call 的默认思考与主调用一致，同时不把多轮协议扩散到 compaction/summary。

## Provider 差异

| 项目 | Moonshot | DeepSeek |
|---|---|---|
| SDK | 官方 Moonshot SDK | 官方 DeepSeek SDK |
| 固定内部 payload | enabled + preserved-history，SDK 决定具体模型映射 | enabled |
| 历史回传 | 恢复 reasoning Part + 官方 `reasoningHistory` 机制 | 恢复 reasoning Part，SDK 生成 `reasoning_content` |
| 工具策略 | 保持 transcript/tool 顺序 | 始终恢复连续兼容 reasoning，不按 `hasTools` 分支 |
| raw chunks | 不需要，除非 Spike 证明必要 | 不需要，除非 Spike 证明必要 |
| 公开支持 | 任意用户实际模型 ID 可调用；兼容性按证据说明 | 任意用户实际模型 ID 可调用；兼容性按证据说明 |
