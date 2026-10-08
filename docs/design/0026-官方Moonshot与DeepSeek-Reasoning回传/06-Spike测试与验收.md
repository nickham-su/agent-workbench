# Spike、测试与验收

## Spike 是具体模型兼容性证据

锁定版本的 SDK mock 用于验证 factory、stream、wire 转换和默认 URL；官方端点最小联调用于验证具体模型的服务端兼容性，当前尚无官方端点验收。两者均不构成用户模型 ID 的本地调用权限。模型列表已依据公开官方文档接入单独的服务端查询，并通过本地 mock 验证 URL/鉴权/shape；尚未使用真实账号验证可见目录。API 查询失败仍安全回退已配置模型供其它路径使用，Moonshot/DeepSeek 设置页静默隐藏失败候选与警告，不以在线模型发现作为调用前提。

| Provider | 参考资料 |
|---|---|
| Moonshot | [Kimi Thinking 模型指南](https://platform.kimi.com/docs/guide/use-thinking-models)、[AI SDK Moonshot Provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai) |
| DeepSeek | [DeepSeek Thinking Mode](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)、[AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek) |

官方端点联调使用人工配置的测试凭证；日志、fixture、提交、截图和验收记录不得含凭证、用户 reasoning、用户代码、完整 body 或 tool output。

## Spike 输出与兼容性记录

对具体验证过的 Provider/模型组合，记录锁定 SDK 版本及 serializer 分支、默认与自定义 URL 行为、fixed options 的 mock request、stream→Part→PromptContext→下一请求闭环、工具多子轮/下一 User turn、官方端点联调日期和脱敏结论。没有官方证据的自定义 ID **仍允许调用**，但不得宣称具备相同的 reasoning/history 能力。官方端点拒绝时如实失败，不关闭思考重试。

| Provider/实际模型 ID | SDK mock 与锁定版本 | 官方端点兼容性证据 | 已知限制 |
|---|---|---|---|
| Moonshot `kimi-k2.6` / `kimi-k2.7-code` / `moonshot-v1-*` / 自定义 ID | 参见 [08](./08-Spike验证记录.md) 的具体测试范围 | 未执行 | SDK 对 K2.6/K2.7/未知模型映射不同；旧 moonshot-v1 可省略 thinking/history |
| DeepSeek V4/flash/pro / 自定义 ID | 参见 [08](./08-Spike验证记录.md) 的具体测试范围 | 未执行 | SDK 对旧 ID/别名跨 User turn reasoning 处理不同 |

## 必做 SDK Spike

### 通用转换与基础接入

| 验证项 | 通过条件 | 不通过动作 |
|---|---|---|
| 官方工厂 | `createMoonshotAI`/`createDeepSeek` 与 chat model selector 类型正确并可发 mock 请求 | 修正 factory；禁止 `any` 或 Compatible 绕过 |
| URL/model list | Moonshot `.cn`/`.ai` 的 `/v1/models`、DeepSeek 默认 `/models` 与显式 `/v1/models`、自定义网关路径、Bearer 与旧 Anthropic 鉴权、`data[].id` 合并去重及刷新缓存均有 mock 测试 | 401/超时/畸形响应时 API 回退到实际 `providerModelId`；两家 Web 无下拉候选/警告、编辑值和手动输入不受限；真实账号可见目录仍需单独验收 |
| 内部 payload | Adapter `prepareInvocation()` 完整保留 shared merge 的内部 prepared payload；Runner 仅原样包一次 namespace | 修复边界；禁止双重 namespace 或 Runner 修改/丢弃 option |
| options 合并 | shared Provider 策略生成 fixedOptions，shared merge fixed-last；合法 non-reserved option 保留，reserved/危险键移除；主调用与 single-call 相同 | 修复为唯一 shared sanitizer/merge；除此之外的合并实现均不合法 |
| 固定思考请求 | reserved user 值无法覆盖主调用/single-call 交给 SDK 的 fixedOptions；K2.6、K2.7 按 SDK 映射，`moonshot-v1-*` warning 并省略不支持字段但允许请求 | 修复 shared 策略/merge；不得据此按模型 ID 阻断或声称旧模型实际思考 |
| reasoning 回放 | 标准 Assistant reasoning Part 被 SDK 序列化为目标字段 | 不手写 HTTP body；查明版本/能力限制 |
| stream | reasoning/text/tool chunks、空 text、空/缺失 reasoning、多 block 可观察且顺序明确 | 需要额外状态时走条件升级 |
| 工具 | tool call/result ID 与消息顺序在下一请求保持 | 记录该模型兼容性限制并修复可控错误 |
| 模型 ID | 精确 ID 进入预期 SDK 分支；别名有独立证据 | 记录别名差异；不做本地准入 |

### Moonshot

`kimi-k2.6`、`kimi-k2.7-code` 是已观察的 SDK mock 对象，不代表官方端点支持承诺；自定义 ID 仍可请求。

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

K2.7 Code 与未知模型的 SDK 映射及服务端接受性应分别记录；不能把 K2.6 的 `thinking.keep=all` 推广到所有 Moonshot 模型。锁定 SDK 的 `moonshot-v1-*` 旧非思考模型即使项目固定请求 enabled/preserved 也会 warning 并省略不支持的字段后发起请求，不因此人为失败或声称实际启用思考。SDK/API 真报错才沿受控失败路径处理，不关闭 thinking 重试。

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

断言语义字段、Assistant 顺序和 ID 关联，不要求 JSON 字段物理顺序。带 tools 的多子轮和下一 User turn 是具体模型的兼容性检查；SDK 的 V4/flash/pro 前缀判断属于其序列化行为，不是本地准入限制，别名可能无法保留跨 User turn reasoning。

## 自动化测试分层

### Shared、settings 与 Provider 基础

覆盖：

- replay union 对 Moonshot/DeepSeek 有效/无效样本、unknown fields/version/protocolVersion、OpenAI 回归；
- `AgentProviderNpmSchema`、内部 flush/PromptContext schema 与新 `tool_call` item；
- shared 唯一 pure sanitizer/merge 的精确规范化：顶层 `trim → 去 '_'/'-' → lowercase`，只命中三种 reserved key；嵌套普通 option 的同名键不删除；
- 只接受 JSON plain object；`__proto__`、`prototype`、`constructor` 和嵌套危险对象键被清理/拒绝，非 plain object 不透传；
- 合法非 reserved top-level option 保留；用户 nested `thinking` 顶层对象整体清除；fixed payload 最后浅覆盖且不被用户修改；
- shared `reasoningProviderFixedOptions(providerNpm)` 只生成 fixedOptions；Agent Adapter 的 `prepareInvocation()` 调用/使用 shared merge、完整保留 prepared payload，Runner 只原样包装一次；只有 fixed-last 实现合法；
- API settings 保存、Worker 运行时、Web generic JSON/Options 都复用同一 shared 常量/函数；Web 是 UX，API/Worker 是行为权威；
- Agent 主调用与 Worker single-call 对同一 raw payload/fixedOptions 得到相同最终内部 payload；
- 官方默认 Base URL、`/v1`、model list、configured-model fallback、文档链接的 descriptor/行为测试；
- shared single-call 在 generate 与 stream 路径均按 Provider 获取固定参数，自定义实际模型 ID 能进入 SDK mock 请求；检查非空 `providerModelId` trim 优先、否则 fallback 至本地 ID。

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

- Moonshot/DeepSeek 的任意用户填写实际模型 ID 可以通过生产 Runner/Registry 与 shared single-call 发请求；不因缺少本地表项阻断。
- shared Provider 策略生成 fixedOptions，Adapter `prepareInvocation()` 使用唯一 shared merge；最终请求只有一层 namespace；用户 reserved 键不能关闭思考或注入 reasoningEffort。
- 合法非 reserved option（如 `parallelToolCalls`）保留；reserved 整键 fixed-last 浅覆盖、危险键清除；Agent/single-call 策略一致，Runner 不二次合并。
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

## 官方端点兼容性验收（不作为调用门禁）

对计划公开承诺兼容的具体模型，用授权测试凭证逐项记录下表结果；未执行的项目不得标为已验证，但用户仍可调用：

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

代码审查必须能据此确认：无 Compatible 路径、无失败时静默关闭思考的降级、无用户 thinking 覆盖、无双 namespace、无非法空 Assistant、无半提交工具状态、无 OpenAI 回归、无 reasoning/凭证日志泄露。

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
