# Spike、测试与验收

## Spike 是发布与实现前置门槛

官方 SDK 的精确 factory/model selector、空 reasoning 表达、stream 事件、wire 转换、默认 URL、模型列表与官方端点行为尚未由当前仓库证实。Spike 必须使用安装后锁定的真实 SDK、无凭证 mock HTTP/SSE 与官方端点最小联调共同确认。网页文档只是输入，不替代测试证据。

| Provider | 参考资料 |
|---|---|
| Moonshot | [Kimi Thinking 模型指南](https://platform.kimi.com/docs/guide/use-thinking-models)、[AI SDK Moonshot Provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai) |
| DeepSeek | [DeepSeek Thinking Mode](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)、[AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek) |

官方端点联调使用人工配置的测试凭证；日志、fixture、提交、截图和验收记录不得含凭证、用户 reasoning、用户代码、完整 body 或 tool output。

## Spike 输出与能力表准入

每个 Provider/精确实际模型组合必须产出：

- 解析出的 package、`ai`、peer/transitive provider 版本及 lockfile 记录；
- factory、chat model selector、options namespace、模型 ID serializer 分支的类型/源码证据；
- 官方默认 Base URL、SDK 的 `/v1` 拼接规则、模型列表 endpoint/认证/返回 shape；
- 模型列表不可用时的 configured-model fallback 行为和 Web 官方文档链接；
- fixed internal payload 的 mock request 证据；
- stream → Part/provenance → PromptContext → 下一请求的闭环证据；
- 工具多子轮、下一 User turn、空/缺失/多 block reasoning、异构切换的结果；
- 官方端点最小联调日期、无敏感摘要和失败条件。

结论只有两种：

- **准入**：将精确实际模型 ID、锁定 SDK 版本、payload 映射和联调证据写入 Worker 静态能力表及下面发布记录；
- **不准入/阻塞**：该模型不得用于新 Provider Agent 或 Worker single-call。必要状态无法表达时停止常规实现，另起条件升级设计。

不得存在“SDK 识别”“可配置”“普通调用但不 replay”的中间发布状态。

### 发布记录

此表在 Spike 前必须保持无伪造条目；Spike 后按能力表逐项填写。

| Provider | 精确实际模型 ID | 锁定 SDK 版本 | 固定内部 payload | SDK mock | 官方端点 | 日期 |
|---|---|---|---|---|---|---|
| Moonshot | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 |
| DeepSeek | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 | 待 Spike 填写 |

## 必做 SDK Spike

### 通用转换与基础接入

| 验证项 | 通过条件 | 不通过动作 |
|---|---|---|
| 官方工厂 | `createMoonshotAI`/`createDeepSeek` 与 chat model selector 类型正确并可发 mock 请求 | 修正 factory；禁止 `any` 或 Compatible 绕过 |
| URL/model list | 默认 URL、`/v1`、模型列表与 configured-model fallback 有测试/记录 | 不设置未验证默认值；阻塞相关设置体验发布 |
| 内部 payload | Adapter `prepareInvocation()` 完整保留 shared merge 的内部 prepared payload；Runner 仅原样包一次 namespace | 修复边界；禁止双重 namespace 或 Runner 修改/丢弃 option |
| options 合并 | capability 生成 fixedOptions，shared merge fixed-last；合法 non-reserved option 保留，reserved/危险键移除；主调用与 single-call 相同 | 修复为唯一 shared sanitizer/merge；除此之外的合并实现均不合法 |
| 固定思考 | reserved user 值无法改变 capability fixedOptions 生成的 wire payload；主调用与 Worker single-call 均固定开启 | 修复 capability 或 shared merge 应用路径 |
| reasoning 回放 | 标准 Assistant reasoning Part 被 SDK 序列化为目标字段 | 不手写 HTTP body；查明版本/能力限制 |
| stream | reasoning/text/tool chunks、空 text、空/缺失 reasoning、多 block 可观察且顺序明确 | 需要额外状态时走条件升级 |
| 工具 | tool call/result ID 与消息顺序在下一请求保持 | 该模型不准入 |
| 模型 ID | 精确 ID 进入预期 SDK 分支；别名有独立证据 | 别名不准入 |

### Moonshot

候选 `kimi-k2.6`、`kimi-k2.7-code` 仅是待验证对象，不是支持承诺。

对 K2.6，mock request 必须验证 fixed internal payload 经 Runner 一次包装与 SDK 变换后具备 preserved-history 语义，预期可观察到：

```json
{
  "thinking": {
    "type": "enabled",
    "keep": "all"
  }
}
```

下一轮 Assistant message 必须含历史 reasoning 与可见内容，概念上等价于：

```json
{
  "role": "assistant",
  "reasoning_content": "fixture reasoning",
  "content": "fixture visible text"
}
```

K2.7 Code 必须独立验证 explicit enabled/preserved 参数是否允许及其合法固定 payload；不能把 K2.6 映射推广到所有 Moonshot 模型。

### DeepSeek

DeepSeek mock 与官方端点必须验证：

```json
{
  "role": "assistant",
  "reasoning_content": "fixture reasoning",
  "content": "fixture text",
  "tool_calls": []
}
```

断言语义字段、Assistant 顺序和 ID 关联，不要求 JSON 字段物理顺序。带 tools 的多子轮和下一 User turn 都是准入硬门槛。SDK 的 V4/flash/pro 前缀判断只能用作 Spike 线索，不能替代精确能力表条目。

## 自动化测试分层

### Shared、settings 与 Provider 基础

覆盖：

- replay union 对 Moonshot/DeepSeek 有效/无效样本、unknown fields/version/protocolVersion、OpenAI 回归；
- `AgentProviderNpmSchema`、内部 flush/PromptContext schema 与新 `tool_call` item；
- shared 唯一 pure sanitizer/merge 的精确规范化：顶层 `trim → 去 '_'/'-' → lowercase`，只命中三种 reserved key；嵌套普通 option 的同名键不删除；
- 只接受 JSON plain object；`__proto__`、`prototype`、`constructor` 和嵌套危险对象键被清理/拒绝，非 plain object 不透传；
- 合法非 reserved top-level option 保留；用户 nested `thinking` 顶层对象整体清除；fixed payload 最后浅覆盖且不被用户修改；
- capability `buildProviderOptions()` 只生成 fixedOptions；Agent Adapter 的 `prepareInvocation()` 调用/使用 shared merge、完整保留 prepared payload，Runner 只原样包装一次；只有 fixed-last 实现合法；
- API settings 保存、Worker 运行时、Web generic JSON/Options 都复用同一 shared 常量/函数；Web 是 UX，API/Worker 是行为权威；
- Agent 主调用与 Worker single-call 对同一 raw payload/fixedOptions 得到相同最终内部 payload；
- 官方默认 Base URL、`/v1`、model list、configured-model fallback、文档链接的 descriptor/行为测试；
- shared single-call 只有获得 Worker 内部能力 policy 才能调用新 Provider，且其 payload 固定开启思考、无 history replay。

### API read-side

扩展 `apps/api/src/modules/agent/read-side/model-context-resolver.test.ts`、`runtime-transcript-projector.test.ts` 等现有测试，覆盖：

- 通用 transcript 仍不携带 reasoning；
- `assistantOrdinal` 与 provider-neutral `messages` index 一致，不按 Assistant 计数解释；
- 所有 text/reasoning/tool_call（含空 text）有一致 metadata 时才得到 provenance；任一缺失、冲突、损坏、未知版本均为 null；
- 有原始 reasoning 且无可见内容的 completed Assistant，无论 metadata 正常、缺失、损坏或 unknown，均保留边界占位/source；
- `visibleIndex` 不因 empty text 消耗，source 多 block 顺序按 Part.position；
- pending/failed/cancelled/superseded Assistant 不产生 source；
- Fork/Revert、Compaction retained tail 不泄漏其他分支或摘要外 reasoning；新 Provider descriptor 不被 primary projection 识别为 OpenAI anchor。

### Adapter、Runner 与 API/Worker 闭环

不得只手工构造理想 replay JSON。至少一组测试必须走：

```text
mock SDK SSE
→ Runner 创建 text/reasoning/tool Part 与 hook metadata
→ flush/store
→ ModelContextResolver / protected PromptContext
→ Adapter 恢复 messages
→ 下一次 mock request body
```

必须覆盖：

- 仅精确能力表项能进入新 Provider Agent/Worker single-call；未命中 preflight 无网络、无 streaming Assistant、无 ToolExecution；
- capability 先生成 fixedOptions，Adapter `prepareInvocation()` 调用/使用 shared merge 并完整保留内部 prepared payload；最终请求只出现一层 `moonshotai`/`deepseek`；明确否定双重 namespace；
- API/Web/Worker 用户 reserved 值均不能覆盖固定 payload；
- 合法非 reserved option（例如 `parallelToolCalls`）保留在 prepared payload；reserved 整键不深合并、危险键清除、Agent/single-call payload 相同；Runner 不修改或丢弃内部 option；
- 除 shared `{ ...sanitizedUserOptions, ...fixedOptions }` fixed-last 浅合并外，任何 Runner 合并、capability 直接返回最终 payload 或丢弃全部用户 options 的实现都必须被拒绝；
- 所有 Adapter（含 OpenAI）返回 mandatory context，Runner 调用 `createAttempt(context)`；retry 是新 Attempt，工具子轮/下一请求重新 prepare；
- text-start 无 delta 仍有空 text provenance，且最终 SDK 不含空 text；
- Moonshot/DeepSeek reasoning-only 成功、空 reasoning、缺失 provenance、冲突 provenance、final metadata 未 flush；只在允许条件完成；
- API 边界占位被新 Adapter 删除，最终 SDK 不含非法空 Assistant；
- hook 异常在 flush/complete 前终止、无 retry、无完成、无工具；
- recovery continuation：同 Run/same identity 成功续接；identity 不匹配、existing metadata 缺失/损坏/冲突、position 或 Part ID 冲突 fail closed；identical metadata 幂等；失败后无 completed Assistant、无 ToolExecution、无 PromptContext replay source；
- 无法证明安全 continuation 时，验证安全 replacement 不混入旧 Part；若不具备该保证，验证直接 fail closed、无网络续接猜测；
- `finalizeAttempt` 失败与 final flush 失败均不调用原子完成接口；成功时 Assistant completion 与 queued ToolExecution 在同一事务可见，工具仅在之后执行；
- DeepSeek `reasoning + tool call + tool result` 多子轮、下一 User turn、Tool ID；
- Provider/config/model/legacy 边界、Moonshot → DeepSeek → Moonshot、Retry replacement、Fork/Revert、Compaction；
- OpenAI replay parser/normalizer/Adapter/Runner 全量回归。

## 发布前官方端点验收

每个能力表精确项必须通过下表，才可写入发布记录：

| 场景 | Moonshot | DeepSeek | 证据 |
|---|---:|---:|---|
| fixed thinking/内部 payload | 必须 | 必须 | 无敏感请求摘要与行为结果 |
| 普通多轮 reasoning | 必须 | 必须 | 下一请求/回答合法 |
| reasoning-only、空、缺失、多 block | 必须 | 必须 | 与 Spike 结论一致，无伪造/空消息 |
| 单次与多次工具子轮 | 必须 | 必须 | reasoning、call/result ID、顺序合法 |
| 下一 User turn | 必须 | 必须 | 连续兼容段保留 |
| Provider/model/config 切换 | 必须 | 必须 | 旧 reasoning 未发送，端点接受性已记录 |
| Fork/Revert/Compaction | 必须 | 必须 | 仅当前有效 retained history |

## 合入验收与命令

代码审查必须能据此确认：无 Compatible 路径、无未验证降级、无用户 thinking 覆盖、无双 namespace、无非法空 Assistant、无半提交工具状态、无 OpenAI 回归、无 reasoning/凭证日志泄露。

建议执行：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm test -w packages/shared
npm test -w apps/agent-worker
npm test -w apps/api
```

若 settings/Web 有改动，还必须执行：

```bash
npm run typecheck -w apps/web
npm test -w apps/web
```
