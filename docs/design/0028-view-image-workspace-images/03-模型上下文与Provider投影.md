# PromptContext、Provider 投影与压缩

## 唯一数据流与 Run 资格

- **实施前基线（设计时）**：API 的 `ModelContextResolver.resolve()` 已从 `agent_tool_execution` 读取 `origin_run_id`、`structured_result_json`，但 `RuntimeTranscriptProjector` 当时只看 preview/error。**已实现的投影要求**：在 resolver → 投影器 → PromptContext 窄契约中传递严格验证后的 image_ref 与 originRunId，不把任意 structured JSON 透给模型。写回、读取与压缩须使用相同的 Run 判定：`execution.originRunId === requestedRunId` 且 Workspace、Session、callPart 与 completed assistant 可验证。仅当 requestedRunId 存在且授权为当前的目标 Run 时发媒体；只请求 Session 的 `getMessagesContext()`（`triggerMessageId:null`）一律只输出路径文字。
- 上传图片是另一条链：API read-side 从 `agent_message_part.attachment_id` 经 FK 对应 `agent_attachment.id`，再核对 Workspace、附件 MIME/filename 及系统生成的 storage_key 安全格式；用该可信 key 统一构造 `.awb/agent/attachments/<storage_key>`。**当前 Run** 的 trigger user message 的内部 `attachment_ref` 应由 API 显式附 `path`（保留 `workspaceId,attachmentId,mediaType,filename`），Worker 按当前 Run 的 Workspace 根绑定校验 path 与 ID／MIME 并安全读取，转换为 `{type:"file",data:Uint8Array,mediaType,filename}`；其他 Run 的同一用户历史只取同源 path 作[文字占位](./01-需求与业务契约.md)。缺少新规范 key 的旧历史图片不生成虚假的 path、不导致读取崩溃；缺少 path 的当前 Run 图片必须本地失败。**不要从上传 filename 拼 path、不要改写 user message 的 triggerMessageId，也不要误把工具 `image_ref.path` 当上传附件 ID。**
- **实施前基线（设计时，缺口已实现）**：`packages/shared/src/internal-contracts/agent-api-read.ts` 的 `AgentApiPromptAttachmentRefPartSchema` 当时只有 ID/MIME/filename 等而没有 path，`apps/api/src/modules/agent/read-side/model-context-resolver.ts` 的 image attachments 亦没有 key/path，`apps/agent-worker/src/runtime/agentAttachmentStorage.ts` 只打开 dataDir 的 `by_workspace` 目录。API 查询／PromptContext schema／Worker 物化器现须共同保持显式 path 链路；Worker 不访问 DB、不在旧 dataDir 猜文件，也不单纯信任 SDK user filename，否则新上传图片在触发 Run／恢复后均会丢失媒体。Web 预览仍由 API 按 session 可见 image part 与 attachment ID 授权打开同一新 Workspace 文件，不开放 `.awb` 静态路由。
- 新工具执行 `completed + view_image + 合法 image_ref + 同一 Run` 才能投影为媒体；另一个 Run 的同一 toolCall 必须保留文字 tool-result（路径占位），不可自动再附图。`failed/cancelled/unknown` 沿现有错误语义走，不根据残留结构化路径显示图片。旧 `visual_analyze` 的历史文本结果可读但新工具清单不可用。
- 工具结果逻辑类型：`{type:"text",value:string} | {type:"error-text",value:string} | {type:"image_ref",path:string} | nonEmptyFlatArray<text|image_ref>`。错误文本不得出现在数组中；图片单项合法。持久写回当前 `view_image` 只有一张图片；这一定义确保其它投影类型能够表达多图工具结果，**并发多个 view_image 仍是多个 toolCallId，不是把它们合并成一个工具调用**。输入非法、未配对 callId、未知工具或非法结构化结果明确拒绝，不能将媒体对象 `JSON.stringify` 成普通文本。

## 同轮多工具结果的投影算法

- Worker 目前并行执行工具（`apps/agent-worker/src/runtime/runner.ts` 的 pending tool 并发执行路径），而模型再次调用前要求 `context.pendingTools.length === 0`；`apps/api/src/modules/agent/read-side/runtime-transcript-projector.ts` 依 assistant call part `position` 排列工具结果。新方案固定**调用位置顺序**而非工具完成时间；每个 `toolCallId` 必须恰好得到对应工具结果，混合成功、失败、非图片工具不例外。
- 普通 PromptContext 项先由 API 构建 provider-neutral assistant/tool 轮次（同一 assistant 的所有 tool-call 和 tool-result；如果跨 assistant 轮次，不能把不相邻的结果混成一个新的 user 消息）。Worker 先让既有 Provider conversation-state adapter 使用原始可见消息 ordinal 恢复 reasoning，再剔除无内容占位 assistant，**最后**做图像物化与 Chat 降级；否则 Moonshot/DeepSeek 的 replay `visibleIndex` 与 DeepSeek SDK 的 last-user 边界可能移位。
- **OpenAI Responses / Anthropic**：对同 Run 每个成功 `view_image`，原 callId 的结果独立映射 AI SDK `output: {type:"content",value:[{type:"media",data:<内存中Base64>,mediaType}]}`，可在同一 `value` 数组中按原顺序放 text+media。单图单项 media 合法，不强行加成功文字。失败 callId 仍为 `error-text`；本轮如有其他文字工具，保留其正常结果。已安装 SDK 分别把它们序列化为 OpenAI `function_call_output` 中 `input_image`，及 Anthropic 对应 `tool_result` 的 image block。
- **OpenAI-compatible / Moonshot / DeepSeek**：SDK 不支持原生多模态 tool output（对 `content` 输出执行 `JSON.stringify`）。逐个 callId 生成**纯文本** tool result：成功项注明工具名、callId、path，其他项沿用原文本或错误文本；**先完整输出本轮所有 callId 的 tool 消息**；若至少一个成功图片，紧接其后**仅追加一条** user message，按 assistant call part 位置用 `text label → file part` 交织列出每张图片的 callId 与 Workspace 相对路径，再进入下一 assistant/user 轮次。失败项不出图片；全部失败不追加 user。不能把 A 的图错配 B，也不能在 A 的 tool 应答与 B 的 tool 应答之间插入 user 消息：Chat API 需要先答完本轮 tool calls。

```text
assistant: tool-call A=view_image(pathA), B=view_image(pathB), C=read(pathC)
tool:      A completed: pathA; B failed: unsupported media; C completed: text result
user:      [Image for toolCallId=A, path=pathA], {type:"file", data:bytesA, mediaType:"image/png", filename:"..."}
```

- 对 A/B 均成功的同轮调用，Chat 的一条 user message 应有两组 `text label + file part`；对原生媒体 Provider 则各 `toolCallId` 有自己的媒体工具结果。标签只含安全相对路径／callId，不含图片字节、原始 SDK JSON、私有绝对路径。所有 Provider 的模型输入图片均须来自同轮请求安全读取的文件内容，不从旧 preview 猜测。

## 读取时序、预算和失败边界

- **实施前基线（设计时，已改造）**：`apps/agent-worker/src/runtime/runner.ts` 的 `runModelStep()` 当时在**重试循环之外**执行 `materializePromptAttachments()` 并构造含 `messages` 的 `requestBase`，失败后复用同一 requestBase 自动重试。旧流程会重发先前图片字节，**不符合本需求**；此处所述不是当前请求时序。
- **已实现的目标时序**：先调用一次 conversation-state adapter 的 `prepareInvocation()` 计算 reasoning metadata／原始可见序号，保存 provider-neutral 的不可变输入；不要让任何 attempt 原地修改它。进入每个 attempt 时（首次及每次远端失败后重试），在调用 Provider 之前，按当次 Workspace/Run 身份重新安全打开**全部**用户触发图和本 Run 工具图，重验每张签名、MIME、单图 10 MiB 限额及**当次合计 20 MiB**；随后才构造该 attempt 独立的新 `ModelMessage[]` 与 `requestBase`，执行 Chat 降级或原生媒体投影。不得从上一 attempt 复制 `Uint8Array`／Base64／包含媒体的 requestBase，也不能二次执行 reasoning 恢复使 ordinal 变化。真正的 Provider attempt 才进入原有请求重试分支。
- **失败分类边界**：图片打开、身份校验、MIME、预算、结构化 path 不变量等**本地准备错误**必须位于 Provider 自动重试 `try/catch` 外，或由明确本地错误类型在该 catch 最先判别、立即抛出而不进入 `retryCount`／backoff；不中途退化成文本并声称已看图。一次远端报错后的下一 attempt 开始前，如文件被删除，下一次模型请求不得调用；若被合法覆盖则下一次使用新字节，旧字节不会重发；新上传用户图亦完全遵循相同规则。用户下一 Run 仅见路径文字。远端不支持图片等**Provider 请求错误**仍按已有自动重试／终态，绝不新加图片错误码分类。
- 工具执行时单图非法只使该 tool 失败，其余结果保持应答；如果其余成功项在后续 attempt 累计超过预算，则**整个 attempt 在请求前本地失败**，不丢弃超额项后还告诉模型所有图片都已查看。SDK `maxRetries:0`，由 Runner 独立控制重试。Moonshot／DeepSeek 达到上限后可能仍按**已有**安全终态分类，不为图片新增特例。
- 不可把含 Base64 的最终 `ModelMessage` 保存到运行日志、调试 artifact、API 结果或 DB：**实施前基线（设计时）**的 `apps/agent-worker/src/runtime/runner.ts` 将 `requestBase` 送入 `writeAssistantDebugRecord`；含媒体时须保证调试序列化仅显示类型、callId、路径／MIME／字节大小之类元数据，不得 dump 图片内容或靠 log level 关闭日志规避问题。仅在进程内调用 SDK 时暂存 bytes/Base64。

## 压缩、恢复与其他读取面

- **实施前基线（设计时，缺口已实现）**：`apps/agent-worker/src/runtime/compaction/primary-materializer.ts` 和 `tool-execution-result.ts` 当时有独立的用户图历史占位与工具 preview-only 投影；`packages/shared/src/internal-contracts/agent-api-read.ts` 的 `AgentApiContextToolExecutionSchema` 当时只带 preview/error，`AgentApiResolvedContextBlockSchema.attachments` 也只含 partId、attachmentId、MIME、filename。现通过窄契约传入可信的 view_image imageRef／originRunId 以及 API 按本 Workspace 附件表校验得到的可选相对路径（旧记录为 null），由 `apps/api/src/modules/agent/agent.composition.ts` 的 `toCompactionSourceResponse()` 从 resolver 单一快照传入，不携带无限制 structuredResult、artifact 路径或字节。普通 PromptContext 和压缩 source 均从相同结构化权威路径派生，不从可截断 preview 解析。
- **工具图压缩裁决**：不在 retained tail 的 `view_image` 结果图片块写成带 callId／相对 path、明确未附图的**纯文字占位**，供 summary prefix 文本摘要输入使用；不读字节、不因该图片块太大而要求用户重发。保留尾部／实际请求确需该图时，且仅 `originRunId === 当前Run`，才安全重新读取并按媒体预算物化；源文件不存在而又必须物化时本地失败，不能假装模型看过图。其他无法维持保留段合法性、callId 配对或当前业务状态的不变量，以**一般可诊断本地失败**处理，不冒充用户图重发终态。
- `apps/agent-worker/src/runtime/compaction/planner.ts` 现有 `containsTriggerMedia`／`media_requires_resend(triggerMessageId)` 是**原用户触发图**专用；保持触发消息查找与既有 user 媒体保留／重发逻辑，不能把工具图片块设为 `containsTriggerMedia`、不能把工具块 ID 填作 `triggerMessageId`。`primary-materializer`／`summary-input-materializer`／`estimator-v1`／`planner` 应支持工具图片保留媒体与 prefix 文字占位的两种表达及预算；tool-only 图片块超保留尾部预算时可转为 prefix 路径事实并继续摘要，若规划器因其他不可保证的不变量不能合法保留，则返回一般本地失败，而非 `media_requires_resend`。
- Worker 重启后从 DB 路径重新建本 Run 工具结果；重复 ToolExecution 写回保留现有 terminal replay 幂等／Run fence，不复制图片到任何独立存储。仅 Session 消息历史阅读与跨 Run prompt 禁止用 path 自动取图；它们可展示 path 但没有媒体权限。

## SDK 实现证据（非对远端型号能力的保证）

- `apps/agent-worker/src/runtime/runner.ts` 的 `createLanguageModel()`：OpenAI `responses()`，OpenAI-compatible `chatModel()`，Moonshot `chatModel()`，DeepSeek `chat()`，Anthropic 官方模型。
- 当前项目安装的 `node_modules/@ai-sdk/openai/dist/index.mjs` 的 Responses `case "content"` 将 tool 媒体转为 `input_image`；`node_modules/@ai-sdk/anthropic/dist/index.mjs` 将 tool 媒体转为 `tool_result` 的 image；`node_modules/@ai-sdk/openai-compatible/dist/index.mjs` 与 `node_modules/@ai-sdk/deepseek/dist/index.mjs` 的 tool converter 对 `output.type === "content"` 执行 `JSON.stringify(output.value)`；Moonshot SDK 使用 OpenAI-compatible Chat converter。升级 SDK 时这批负例必须重测。
