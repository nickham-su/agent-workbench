# SDK Spike 与分阶段本地验收记录

> **现行产品决策（覆盖下方历史阶段中的“准入/发布阻断”表述）**：Moonshot/DeepSeek 已取消精确模型能力表。用户可填写任意 Provider 模型ID；Agent 与 shared single-call 均按 Provider 向 SDK 提交固定 enabled thinking policy，Moonshot 同时请求 preserved history；SDK 对旧非思考模型可 warning 并省略不支持字段后发请求，无本地模型 ID 准入。下文保留当时的本地测试结果与尚未执行官方端点的事实；历史的“未获准入/发布阻断”现在仅表示**不能宣称该具体模型已获官方端点兼容性验证**，不再表示用户不得调用。SDK 对 K2.6/K2.7/未知 Kimi ID、DeepSeek V4/旧模型/别名的历史 reasoning 映射不同，允许请求不等于保证全部 replay 语义。

> **模型发现更新**：下方历史阶段中“模型候选仅使用已配置模型”“官方 `/models` 尚未接入”的陈述仅描述当时状态；现已按两家公开 API 文档接入远端模型查询。API 失败回退已配置模型，但两家 Web 静默隐藏失败候选与警告，保留任意 ID 手动输入。详见本文件末尾的独立验收记录。

## 历史阶段记录（旧准入条款已被上文决策取代）

> 状态：**已完成本地 SDK mock、SQLite→protected PromptContext→SDK 以及 Fastify HTTP→受保护 Worker API→内置只读工具→ToolExecution→下一次 SDK mock 请求闭环；未完成官方端点验收，未进行具体模型官方端点兼容性验收。** 不得把本地模拟请求结果当成官方服务兼容保证。获得真实联调证据后，可更新 [06 的兼容性记录](./06-Spike测试与验收.md)，不改变调用权限。

## 版本、命令与范围

在 Worker 和 shared 两个 workspace 分别精确固定：

| 包 | 安装版本 | 说明 |
|---|---|---|
| `@ai-sdk/moonshotai` | `0.0.26` | 对应 AI SDK 5 的 `ai-v5` 历史发布版本 |
| `@ai-sdk/deepseek` | `1.0.57` | 对应 AI SDK 5 的 `ai-v5` 历史发布版本 |
| `ai` | `5.0.260`（当前解析） | 不升级 major |
| `@ai-sdk/provider` / `@ai-sdk/provider-utils` | `2.0.4` / `3.0.37` | 与固定版本的依赖一致 |
| `@ai-sdk/openai-compatible` | `1.0.54`（传递依赖） | Moonshot SDK **内部**依赖；项目接入必须直接使用官方 `createMoonshotAI`，不得以 generic Compatible 工厂代替 |

安装时 npm registry 的 `@ai-sdk/moonshotai@ai-v5` / `@ai-sdk/deepseek@ai-v5` 已分别指向更新的 `0.0.28` / `1.0.59`，其传递依赖也升级为 `provider 2.0.5`。为避免随时间变化的标签升级和混用 provider 版本，本次**固定历史可兼容版本**，并由根目录 `package-lock.json` 记录。未来更新须重跑本测试、版本对照与官方端点验收。

```bash
npx tsx --test apps/agent-worker/src/runtime/providers/reasoning-providers.sdk.spike.test.ts
npm run typecheck -w apps/agent-worker
npm run typecheck -w packages/shared
```

新增的 SDK 契约测试使用各官方 SDK 的注入式 mock fetch 和模拟 Chat Completions SSE；不调用真实模型，测试固定 fixture 与 API key 仅为程序内虚构值，不含用户数据。阶段一当时 **17/17 测试通过**，Worker 和 shared 类型检查通过；后续追加旧模型用例后，该 SDK Spike 文件当前定向实测为 **19/19 通过**。模型 `deepseek-chat` 用作旧模型 SDK serializer 对照，不代表该模型获得官方端点兼容性验证；下文提及的所有其他模型也仅是 *SDK 层行为* 的样例。

## mock 已证明的行为

- **工厂与 namespace**：Moonshot 使用 `createMoonshotAI({...}).chatModel(id)`，Provider Options 键是 `moonshotai`；DeepSeek 使用 `createDeepSeek({...}).chat(id)`，键是 `deepseek`。DeepSeek 无 `.chatModel()`，不得直接套用 Moonshot 工厂选择器。SDK 接收标准 AI SDK Assistant reasoning part，并为相应 Assistant 请求消息序列化 `reasoning_content`，工具调用和工具结果的 ID 保持一致。
- **Moonshot URL/模型策略**：锁定 SDK 的默认请求 URL 是 `https://api.moonshot.ai/v1/chat/completions`（`index.js` 中默认 base URL 含 `/v1`，不会再自动补 `/v1`）。`kimi-k2.6` 使用内部 `{ thinking: { type: 'enabled' }, reasoningHistory: 'preserved' }` 时，wire body 是 `thinking: { type: 'enabled', keep: 'all' }`。`kimi-k2.7-code` 和 `kimi-k2.7-code-highspeed` 在相同内部 options 下，wire body 为 `thinking: { type: 'enabled' }`，Assistant 历史仍带 `reasoning_content`；**未证明官方端点接受此 K2.7 参数**。不要发送 disabled 参数。
- **DeepSeek URL/模型策略**：默认请求 URL 是 `https://api.deepseek.com/chat/completions`（默认 base URL **不含** `/v1`；传入自定义 baseURL 时 SDK 只追加 `/chat/completions`）。内部 `{ thinking: { type: 'enabled' } }` 映射到同名 wire 字段。锁定 SDK 的源码用 `modelId.includes('deepseek-v4') || modelId.startsWith('deepseek-flash') || modelId.startsWith('deepseek-pro')` 决定旧 User turn 前的 reasoning 是否保留：mock 中 `deepseek-v4-pro`/`deepseek-v4-flash` 保留，`deepseek-chat` 跨新 User turn 不保留（当前工具续轮仍保留）。这是 SDK 分支证据，**不是前缀家族的官方验证或产品准入规则**。别名若不匹配该 SDK 分支，可能丢掉先前 User turn 之前的 reasoning；模型可调用不代表历史实际回传。
- **DeepSeek V4 无 reasoning Part 的 Assistant**：SDK 仍在 wire body 写 `reasoning_content: ''`。这不等于真实响应携带了空 reasoning，也不能由此伪造 `AgentReasoningPart` 或可信 replay provenance。mock SSE 的 `reasoning_content: ''` 与完全缺失该字段都不产生 `reasoning-delta`；如果官方工具续轮要求区分这两种状态，必须走 [06 的条件升级](./06-Spike测试与验收.md)，不得靠虚构文本处理。
- **流式转换和用量**：两种 SDK 的 mock SSE 均输出标准 `reasoning-delta` / `text-delta` / `tool-call`，`usage.prompt_tokens`/`completion_tokens` 映射到 AI SDK `usage.inputTokens`/`outputTokens`。DeepSeek mock 的 `prompt_cache_hit_tokens: 2` 明确映射为 `usage.cachedInputTokens: 2`；Moonshot 锁定 SDK 源码支持 `cached_tokens` 或 `prompt_tokens_details.cached_tokens`，尚未通过 mock 测试。缺失的 usage 不得猜测。多 reasoning block 可拼接进入 wire 历史 `reasoning_content`；在 mock `reasoning → text → reasoning` 中 Moonshot 连续使用同一个 reasoning start/end 段，DeepSeek 关闭并重新开启但复用 `reasoning-0` ID；Runner 不能假定一次流中每个 reasoning-start 都有唯一 ID。
- **Analytics 范围**：新增 Provider 走现有 Runner 主调用按 Attempt 发 `model_invoked`/`model_finished` 的通用逻辑。Moonshot 阶段已用测试子类与官方 SDK mock 验证主调用成功 usage、重试失败/成功的每次 Attempt 信号配对；这**不是官方端点或数据库 Analytics 全链验收**。现有 Runner 的 `cacheInputForStep()` 只为 OpenAI/Anthropic 确认可比较的缓存输入分母；对于 DeepSeek，即使 SDK mock 读到 `cachedInputTokens: 2`，也不能由此声称 `cacheComparable` 或缓存命中率有效。统计事件的 `modelId` 是本地模型 ID；replay 比较的必须是实际发送的 `providerModelId`（非空）或本地 ID。当前 single-call/compaction 不经过该模型统计发射点，本功能不单独为两个 Provider 改变统计口径。

## 历史 SDK/设置模型列表的边界（现已更新，参见末尾）

两个官方 SDK 的 chat factory 当时只证明了 `/chat/completions` 请求路径；该阶段 mock **未验证官方 GET `/models` 端点、返回 shape 或鉴权**。当时 `apps/api/src/modules/settings/settings.service.ts` 的模型列表逻辑首先通过 npm **allowlist 拒绝** Moonshot/DeepSeek，因此不会向它们发出列表请求，接着走 configured-model fallback。当时若只扩 allowlist 而未修改其后的头部判断，新 Provider 会误落入 Anthropic 的 `x-api-key` + `anthropic-version` 分支。彼时 URL 规则会将不以 `/v1` 结尾的 baseURL 拼成 `${baseURL}/v1/models`；DeepSeek 默认地址能否使用此规则尚未验证。**以上均为接入前的历史状态，不代表当前实现**；参见末尾的增量验证。不要把 SDK 能发 Chat 请求误读为模型目录的真实官方端点验收。

待验证的官方文档链接候选（仅 UI 链接，不作为 API 支持证据）：[Moonshot Provider](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai)、[DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)。

## 尚未通过的门槛与后续动作

开发前 Spike 的运行环境未注入 `MOONSHOT_API_KEY` 和 `DEEPSEEK_API_KEY`。未读取 `.env.local`，未进行真实端点请求，（当时仍计划维护精确模型能力表，现已取消）。后续阶段需要验证：

1. 在被授权的测试环境通过官方端点检验**精确实际模型 ID**和固定 thinking 参数，尤其 K2.7 Code 的 wire thinking 形状以及 DeepSeek V4 的可用精确 ID；失败则记录模型兼容性限制，修正可控错误。
2. 真实流的空/缺失 reasoning、连续多 tool call、下一 User turn 的历史 replay、跨 Provider/provider-neutral 历史、官方 `400` 边界；mock 不能代替服务端验收。
3. 第一版 Web 当时只手工配置模型且使用 configured-model fallback；当时尚未接入远端发现。现已增加 mock 验证（见末尾），真实账号目录仍待授权环境验收。
4. Moonshot 阶段通过 Runner + 官方 SDK mock 的 provenance flush、工具子轮/下一请求、Retry/reasoning-only 和 Attempt Analytics 分层测试；第五阶段补充真实 SQLite 投影闭环，见下文。真实官方端点仍待验收。
5. DeepSeek 阶段使用锁定 SDK mock 验证 V4 模型跨 User turn 保留历史 reasoning、旧模型序列化差异、两次工具子轮 Assistant reasoning 的顺序与 call/result ID、固定 thinking、Runner 流式 Part provenance/续轮与每 Attempt Analytics；第五阶段补充真实 SQLite 投影闭环，见下文。测试能力仅在注入的测试 Runner/Registry 中提供，生产精确模型表仍为空。

**当时的历史结论：没有正式 verified 条目。现行实现不使用该表；未完成真实端点验收不能宣称具体模型正式支持完整多轮 reasoning，但不妨碍用户自行调用。** 是否增加一次全功能授权联调取决于用户可安全提供的测试环境，不得用 mock 假冒发布证据。

## 阶段五：真实 SQLite / PromptContext 与回归验收

- `apps/api/tests/reasoning-provider-db.integration.test.ts` 以真实 SQLite、API message store 和 read-side projector 配合 Worker Runner 与官方 SDK，向**本地** mock SSE 服务发送请求。该阶段曾用测试子类跳过旧准入；现行测试使用生产 Runner/Registry，自定义 ID 可直接进入 SDK mock。两个 Provider 各测普通、reasoning-only、多 block、工具成功续轮、两种失败边界、端点切换及四种旧数据场景，合计 **22/22** 通过。
- 第一轮 SDK 流产生 Assistant Part → `flushStreamingParts()` 在 SQLite 保存 provenance → `completeAssistantWithExecutions()` 原子提交 → `ModelContextResolver` / `projectModelContextToPrompt(...includeReplayOnlyAssistants: true)` 产出受保护来源 → 下一 User turn 的第二轮 Runner 与 SDK 请求均带回第一轮非空 `reasoning_content`。reasoning-only 的空 Assistant 只用于内部定位。第三轮验证 legacy reasoning-only 占位形成硬边界，最终 SDK 请求不含此前非空 reasoning 或空占位；DeepSeek V4 SDK 对普通无 reasoning 的 Assistant 仍可能填空串 `reasoning_content: ''`，此处只断言不泄漏非空历史。
- 同一 SSE mock 故意在连续响应以及**同一个 Assistant 的 reasoning→text→reasoning 内**复用 stream ID；新 Chat Adapter 为每个实际 block 分配独立本地 Part ID，并仅将当前 SDK ID 映射到该 block，OpenAI Responses 的 item ID 路径不改。两种 Provider 的真实 SQLite 中三个 Part 类型、独立 ID、分段文本及下一请求 reasoning 顺序均已检查。测试还检查 Fork、Revert、Compaction retained tail 和 recovery 的安全替换/失败边界。
- 工具成功场景使用真实 tool-call Part 与 `completeAssistantWithExecutions()`：提交前为 streaming 且无执行记录，单次 store 事务后为 completed 且 queued execution 可见；真实 `updateToolExecution()` 写回 running→completed，read-side 投影工具结果，再经 SDK 下一次请求核对 reasoning、call/result ID 及 user→assistant→tool 顺序，另检查后续 User turn。finalize 拒绝或最后流式 flush 失败时（重试预算为 2），不会再次发起网络请求，SQLite 中 Assistant 仍 streaming、queued execution 为零；Analytics 只有一次 invoked/一次 failed finished（本地失败 `failureKind=other`），缺失 usage 时 inputTokens 仍为 null。最终强制 flush 在 finalize 成功后执行，OpenAI terminal replay 仍随成功 Attempt 持久化。这里的工具结果是测试写入 store，**没有实际执行本机工具，也不经 Fastify HTTP**。
- OpenAI Responses 的远端失败/缺失 terminal 仍按原有 provider 失败路径重试并隔离旧 Attempt（其 finalize hook 报告三种远端终态代码）；其他本地 finalize 校验异常和 Moonshot/DeepSeek 协议失败不可重试，避免把原有 OpenAI raw/replay/terminal 语义当成本地错误改写。
- 两种 Provider 的端点切换测试保持配置 ID 和实际模型不变，只改变 baseURL：旧 replay 的端点信息仅存 SHA-256 摘要、不包含 URL；新端点请求不携带旧 reasoning，切回旧端点也不会跨中间不兼容 Assistant 捞取历史。shared 严格校验新 Chat envelope 中的摘要，旧 OpenAI envelope JSON 不变。设置模型列表失败时日志不再含原 URL/不可信异常消息，含 userinfo/query/fragment 的注入测试通过；当时 Web 提示新 Provider 模型仅手工配置和 configured-model fallback（现已更新）。
- 旧 Chat 无摘要兼容读：在真实 SQLite 中将 Assistant 已持久化的 v1 Part metadata 模拟为升级前的封闭旧格式，再由新版 `ModelContextResolver` 读取。Moonshot/DeepSeek 的 reasoning、text、tool_call 旧 Part 均不给可信 provenance；可见 text/tool call/result 保持顺序，SDK 不带旧 reasoning。reasoning-only 空 Assistant 留在受保护 PromptContext 定位边界但不发 SDK；旧 Assistant 前后新 Chat 连续段不跨旧边界恢复。损坏 JSON、未知版本、额外字段的 SQLite 读取明确失败，不发下一次 SDK 请求；新 Chat v1 及 OpenAI JSON 回归照旧。
- Runner 单测令 Moonshot `finalizeAttempt()` **直接抛普通 Error**、重试预算为 2：只一次模型请求、一次 failed Analytics、无 completed Assistant/queued execution；OpenAI remote terminal retry/replacement 原有测试保留并通过。
- 分层测试另覆盖多次工具请求、retry/replacement、空 text/空 reasoning、模型/Provider 切换、OpenAI 回归、Analytics 每网络 Attempt 配对与未知 usage；阶段六只覆盖单次只读工具成功闭环，**未以单个 SQLite+HTTP+真实工具执行测试覆盖所有这些场景**。当前 single-call/compaction 不发主调用 Analytics 信号；没有凭空引入统计表、缓存可比较性或未知 usage。

**尚未完成的兼容性证据**：若要声明具体模型支持完整 reasoning，请在用户授权的隔离环境按 06 验收官方端点、固定思考、工具多子轮、下一 User turn 和失败边界。在测试环境以安全方式注入凭证，不在聊天中发送 API key；当前无 verified 表，用户调用不受官方联调前置限制。

实际执行命令与结果（先构建 shared，再做依赖它的测试）：

```text
npm run build -w packages/shared                    → 通过（本轮）
npm run typecheck -w packages/shared                 → 通过（本轮）
npm run typecheck -w apps/agent-worker               → 通过（本轮）
npm run typecheck -w apps/api                        → 通过（本轮）
npm run typecheck -w apps/web                        → 通过（本轮）
cd apps/api && npx tsx --test tests/reasoning-provider-db.integration.test.ts → 22/22 通过（本轮）
npm run test -w apps/agent-worker                   → 582/582 通过（本轮，含 OpenAI 回归与 finalize 抛错）
npm run test -w packages/shared                    → 99/99 通过（本轮）
npm run test:integration -w apps/api                → 253/253 通过（本轮，耗时约 153 秒）
npm run test:unit -w apps/api                       → 全部通过（本轮）
npm run test:integration:worker -w apps/api         → 19/19 通过（本轮）
npm run test -w apps/web                            → 并行启动时超时；独立重跑 2/2 通过（本轮）
npm run build                                       → 通过（本轮；Vite 非阻塞 chunk 大小警告）
```

此前阶段五执行的较广泛回归（本轮未重跑，不作为本轮结果）：

```text
npm run typecheck                                   → 通过（shared、Worker、API、plugin-feishu、Web）
npm run test -w packages/shared                    → 98/98 通过
npm run test -w apps/api                            → unit/integration/worker 三组通过；最终 worker 组 19/19
npm run test -w apps/web                            → 通过；输出含非阻塞 Browserslist 版本警告
npm run build                                       → 通过；Vite 报非阻塞 chunk 大小警告
```

## 阶段六：M3 本地 HTTP 与真实工具执行闭环

- `apps/api/tests/reasoning-provider-http-tool.integration.test.ts` 为 Moonshot `kimi-k2.6` 和 DeepSeek `deepseek-v4-pro` 各跑一轮真实 Fastify HTTP 内部路由、SQLite 和本地 Chat Completions SSE mock。测试中的 Runner **在测试进程运行，不是 API-managed Worker 子进程**；当前测试使用生产 Runner/Registry（仅终态失败案例为注入故障），不经过模型白名单。
- 无内部 token 的 PromptContext HTTP 请求返回 401；合法请求由 `AgentApiClient` 通过真实 HTTP 路由发往受保护 Worker API。第一轮 SDK mock 返回非空 reasoning、文本和 `read` tool call；Runner 的内置只读 `read` 实际读取临时 workspace 内的 fixture 文件。断言提交前 Assistant 仍 streaming、无 ToolExecution，提交后 Assistant completed 与 queued execution 同时可见；Runner 将真实执行结果写回 completed，第二次 SDK mock 请求包含原 reasoning、工具调用/结果 ID、结果内容与正确角色顺序。**与阶段五直接写 store 的模拟工具结果不同。**
- 真实 HTTP 首次暴露 Fastify Ajv 对嵌套 `anyOf` 分支移除 Chat replay `protocolVersion` 的问题，导致合法 flush 返回 400。内部传输 schema 改为不修改 replay 字段的形状；授权之后再以原有严格 TypeBox union 校验 Part 与 replay，store 仍在落库前校验。测试同时验证匹配的正常 Chat envelope 可落库、有效 tool-call envelope 错配 text Part 时 HTTP 返回 400；旧 OpenAI 路径保持既有回归测试。
- 阶段六补充同一路由的未认证 `flushAssistantParts` 测试：返回 401 且 SQLite Part 数量不变；随后使用认证的真实 HTTP 客户端写入合成旧 OpenAI Responses reasoning replay，落库后解析比对 `itemId`、`summaryIndex` 和 `encryptedContent` 完整往返。测试失败信息不输出加密字段。
- 本测试**不是官方端点兼容或真实 Worker 子进程验收**，不证明官方模型 ID 可用、真实服务对 reasoning/固定 thinking 的接受情况，也不证明自定义模型的官方端点兼容性。

本阶段变更后的自测（本地 mock，不访问官方端点）：

```text
npm run test -w packages/shared → 99/99 通过（含严格 flush 契约回归）
npm run typecheck → 通过（shared、Worker、API、plugin-feishu、Web）
npm run test:integration:worker -w apps/api → 19/19 通过（含真实子进程 OpenAI 回归）
补充 L1 后：
npm run typecheck -w apps/api → 通过
cd apps/api && ../../node_modules/.bin/tsx --test tests/reasoning-provider-http-tool.integration.test.ts → 3/3 通过
cd apps/api && ../../node_modules/.bin/tsx --test tests/reasoning-provider-http-tool.integration.test.ts tests/reasoning-provider-db.integration.test.ts → 25/25 通过
```

**未执行官方 Moonshot/DeepSeek 端点调用**；未读取 `.env.local`，未生成官方验收日期，不表示任何模型已经官方验收；要公开承诺具体模型的完整兼容性，仍应按 06 完成固定思考、工具多子轮与异构历史的官方服务联调；官方 `/models` 路径/鉴权、空字段协议和实际计费等不可用本地 mock 替代。

## 决策变更后的本地复验

取消旧表后，生产 Runner/Registry 与 shared single-call 均通过本地 SDK mock 发起请求（包含 Moonshot 和 DeepSeek 自定义模型 ID）；数据库与 HTTP 工具集成测试也不再覆盖模型准入。本轮定向复验：shared single-call 12/12、Worker Adapter/Runner/安全摘要 28/28、API 数据库与 HTTP 工具 25/25；shared 构建及 shared/Worker/API/Web 类型检查通过。测试证明请求路径、固定参数与本地回放/工具状态，不代表真实官方模型接受自定义别名或保证不同 SDK serializer 的 reasoning 行为。官方端点调用仍未执行。

### 旧非思考模型与 SDK 省略规则的补充 mock 证据

锁定的 `@ai-sdk/moonshotai@0.0.26` 注入式 SDK fetch/SSE 测试对 `moonshot-v1-8k` 和 `moonshot-v1-32k` 提交相同固定 `{ thinking: { type: "enabled" }, reasoningHistory: "preserved" }`。两者均发出真实 SDK mock 请求，并在请求体中省略 `thinking` 与 `reasoningHistory`，同时报告相应 `unsupported-setting` warnings；本地模拟的纯 text SSE 可正常读取。shared single-call 的 generate/stream 也验证了旧 ID 固定 policy 经 SDK 省略不支持字段后仍可请求。这证明 **SDK 自行适配而非项目按模型 ID 阻断或主动关闭思考重试**，也不证明官方服务端接受这些 ID、存在思考或支持 reasoning/history。原 K2.6 (`thinking.keep=all`) 和 K2.7 (enabled、无 K2.6 专用 keep) SDK 测试仍通过；对未知 Kimi 自定义 ID，锁定 SDK 的 `unknown` 分支保留 requested thinking 但会 warning 并省略不支持的 preserved history（shared 自定义 ID mock 验证请求体，不代表服务端具备历史回传）。DeepSeek 旧 ID/别名跨 User turn 过滤见前述分支与 `deepseek-chat` 对照测试。该 SDK Spike 本地 19/19 通过，未调用官方端点。

## 官方模型目录查询：独立增量

公开 API 文档：[Kimi 模型列表](https://platform.kimi.com/docs/api/list-models) 与 [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models) 均给出 Bearer 鉴权和 `data[].id`。API 设置服务现在按配置地址向 Moonshot 发 `/v1/models`、向 DeepSeek 发 `/models`；若 DeepSeek 配置含 `/v1` 或自定义网关前缀，保留该路径并添加 `/models`。列表与已配置的实际 `providerModelId` 去重合并，刷新继续遵守原缓存语义；401/异常响应/超时/不安全 URL/重定向时 API 安全 fallback，前端仍可自由输入任意模型 ID。

此处仅验证了代码在本地 mock HTTP 下构造的请求、响应解析和失败回退；**未使用用户凭证调用官方模型目录，无法据此宣称特定账号可见的模型或自定义网关一定提供该接口**。模型发现失败不限制模型调用，Chat SDK 的 reasoning 协议验收与此功能独立。

本次增量自测（不访问真实官方账号）：

```text
npm run build -w packages/shared                                  → 通过
npm run typecheck -w apps/api                                      → 通过
npm run typecheck -w apps/web                                      → 通过
tsx --test apps/api/src/modules/settings/settings.tools.test.ts    → 6/6 通过（本地 mock fetch）
npm run test:unit -w apps/api                                      → 通过（所有单测组）
npm run test -w apps/web                                           → 通过（含设置面板说明断言）
```

本地 mock 可验证客户端选用的 URL/鉴权、列表解析和异常回退；**不能代替官方端点对具体 Key、地区、网关和模型可见性的真实验收**。

### Moonshot/DeepSeek Web 静默失败展示（后续产品决策）

API `fallback` 仍返回已配置的实际模型 ID，供其它路径使用；两家设置页在 `source=fallback`、携带警告的缓存、未知 warning 或请求抛错时，**既不显示下拉候选，也不显示任何失败提示**。`rebuildProviderModelIdOptions()` 在此状态下不会将搜索词或编辑值重新加入候选；输入框仍保留已保存的模型 ID，并允许直接输入完整 ID 后保存。成功查询（包括无警告的缓存）继续呈现远端与已配置 ID 的并集；其它 Provider 沿用原行为。不修改模型目录 URL、鉴权和服务端缓存语义。

本阶段本地组件测试使用模拟 API 响应验证两家成功、fallback、缓存 fallback、未知 warning、请求抛错、已有值及手填保存；不是官方端点验收。实际复验：`AgentProvidersSettingsPanel.component.test.ts` **2/2**、API `settings.tools.test.ts` **6/6**、`npm run typecheck -w apps/api`、`npm run typecheck -w apps/web`、`npm run test -w apps/web` 均通过。
