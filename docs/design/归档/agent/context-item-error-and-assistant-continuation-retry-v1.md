# Context Item 通用错误字段与 Assistant 续写重试方案(v1)

本方案聚焦两件事:

1. 将 `agent_context_item` 的错误信息从“混入文本/工具私有字段”升级为 **context item 通用能力**。
2. 在此基础上,为 assistant 引入 **部分文本输出后失败的续写式重试**。

本文为定稿方案,已按当前评审结论收敛。项目尚未上线,因此本方案优先追求模型语义正确、后续可维护,接受适度的 schema/API 演进。

## 背景

当前实现中,context item 的错误模型不统一:

- tool item 支持 `output.error`,并会落到 `tool_result_json.error`
- assistant item 没有结构化 error,失败原因会直接拼进 `output.text`
- Worker 在 assistant 失败收敛时会写入:
  - `text + "\n\n[run] failed after ..."`
  - 或仅 `"[run] ..."`

现状带来几个问题:

- **语义混乱**: 错误是 item 的状态结果,却被编码成 assistant 正文文本的一部分。
- **模型污染**: 若未来将 failed assistant 纳入后续 prompt 以支持续写,`[run] ...` 会干扰模型生成。
- **数据模型不一致**: tool 有结构化 error,assistant 没有。
- **展示/归档不干净**: 复制、归档、subtask result 等会把错误提示当正文处理。

同时,当前模型请求自动重试仅支持“首包前失败”:

- `apps/agent-worker/src/runtime/runner.ts` 中,一旦请求产生可见输出(`text-delta`/有效 `tool-call`),就不再自动重试。
- 这对避免重复文本/重复工具副作用是安全的,但会让“已输出部分文本后中断”的场景直接失败。

本方案希望在不破坏副作用安全边界的前提下,允许 **纯文本场景** 在部分输出后继续生成。

## 目标

- 将错误信息升级为 `context item` 的通用结构化能力,不再依赖正文文本承载错误。
- assistant/tool 在持久化层使用统一错误字段。
- API 对外继续通过 `output.error` 暴露 assistant/tool 的错误,降低前端消费成本。
- assistant 失败时保留已成功输出的文本前缀,错误单独记录。
- 允许“最近一次、纯文本、已产生部分输出后失败”的 assistant 参与后续 prompt,实现续写式重试。
- 不新增新的错误通知 item;item 自身失败由 item 自身承载。
- archive 中保留失败状态,但不记录 assistant error message。

## 非目标

- 不尝试实现 provider 级“真正断点续传”。本方案是“新请求基于前缀继续生成”,不是恢复原始 response。
- 不支持出现 tool-call 后的自动续写重试。
- 不清洗历史旧数据中已混入正文的 `[run] ...` 文本。
- 不为续写重试新增独立配置项;首版复用现有 `modelRequestMaxRetries`。
- 不额外生成 continuation instruction;首版仅依赖历史 messages。
- 不新增独立错误表、错误事件流或专门的错误日志查询接口。

## 关键决策(已确认)

### 1. error 提升为 context item 通用能力

采用 **item 级统一错误模型**:

- DB 层新增 item 通用错误列
- assistant/tool 统一映射到该层能力
- API 层继续以 `output.error` 形式透出

说明:

- 这是“底层统一,接口兼容”的设计。
- 对前端和现有契约而言,assistant 与 tool 都通过 `output.error` 消费。
- 对持久化层而言,error 不再是 tool 私有能力。

### 2. DB 新增字段为 `error_message + error_code`

在 `agent_context_item` 新增:

- `error_message text`
- `error_code text`

不引入 `error_json`,避免首版范围过大。

### 3. API 继续通过 `output.error` 暴露错误

- `assistant_text` 增加可选字段 `error?: string`
- `tool` 保持 `error?: string`
- 对外查询 `AgentContextItemRecord.output.error`
- 不新增 `item.error` 顶层字段

### 4. tool 这次一起切到底层统一 error 列

- tool 的 error 不再以 `tool_result_json.error` 为主存储来源
- `tool_result_json` 可继续保留少量结构化 meta,但 error 主来源迁移到 item 通用列

### 5. 仅允许“最近一次 failed assistant”参与续写 prompt

并且必须同时满足:

- `kind === "assistant"`
- `output.type === "assistant_text"`
- `status === "failed"`
- `output.text.trim().length > 0`
- 该 assistant 所属 turn **没有任何 tool-call/tool item**
- 仅取最近一次,更早的 failed assistant 不进入 prompt

### 6. 只要 partial text 后失败,都允许续写重试

本方案接受“文本仅供用户阅读,不承担流程逻辑”的前提。

因此在满足“纯文本回合”约束时:

- 只要 assistant 已有部分文本输出,随后失败
- 不区分 timeout/network/provider/stream 细类
- 均允许进入续写式重试流程

说明:

- 这是偏激进的产品决策,目标是尽可能减少中途断流给用户造成的失败感。
- 风险通过“禁止 tool-call 场景续写”和“只续写最近一次 failed assistant”控制。

### 7. 续写重试次数复用 `modelRequestMaxRetries`

不新增 `modelContinuationMaxRetries`。

复用语义为:

- `modelRequestMaxRetries` 同时覆盖
  - 首包前失败重试
  - 纯文本 partial-output 后的续写重试

### 8. 续写时不额外加 continuation instruction

首版仅通过历史 messages 实现续写:

- 把最近一次 failed assistant 的文本前缀放入 messages
- 不追加专门的“请从这里继续生成” system instruction

接受的已知结果:

- 可能出现少量重复或轻微改写
- 但实现更简单,更贴近当前 prompt 组装方式

### 9. UI 展示方式

failed assistant 继续按普通 assistant 展示:

- 正文展示 `output.text`
- 下方附 error 文本(`output.error`)
- 卡片保持 failed tone

### 10. 历史旧数据不清洗

- 旧数据中混入正文的 `[run] ...` 视为历史遗留
- 不做回填脚本
- 新写入数据按新模型执行

### 11. assistant item 失败时不再额外生成 `[run] ...` system item

- item 自身失败: 仅写入当前 item 的 `status=failed + output.error`
- run/runtime 级故障: 仍可使用 `[run] ...` system item,因为其语义是运行层通知,不属于某个具体 item 的结果

### 12. subtask 结果策略

- subtask 的最后一个 assistant 若为纯文本 partial-output 失败,也走相同续写重试逻辑
- 若超过重试次数仍失败:
  - `resultText` 返回 partial text
  - 上层通过 run status 判断 subtask 失败
  - `resultText` 不拼入 error 文本

### 13. archive 保留失败状态,不保留 assistant error message

- archive line 中允许体现 `status=failed`
- assistant 正文仍只归档 `output.text`
- 不把 `error_message` 拼入 archive 正文

## 数据模型

## agent_context_item 新增字段

在 `agent_context_item` 增加:

- `error_message text`
- `error_code text`

约束:

- 四种 kind 都允许为空值
- 当 item 进入终态且存在错误语义时,可写入 error
- 无错误时必须为 `null`

### 字段语义

- `error_message`
  - 面向 UI/日志的人类可读错误文本
  - 例如 `model idle timeout after 30000ms`
- `error_code`
  - 面向程序判断的稳定代码
  - 首版可先覆盖主要场景,允许部分写 `null`

建议首版 code 枚举(非强制一次补齐):

- `MODEL_REQUEST_FAILED`
- `MODEL_IDLE_TIMEOUT`
- `MODEL_TOTAL_TIMEOUT`
- `MODEL_STREAM_FAILED`
- `TOOL_FAILED`
- `TOOL_PERMISSION_DENIED`
- `ITEM_CANCELLED`

## Shared Contract 与 API 形状

### assistant output

将 assistant output 从:

```ts
{
  type: "assistant_text",
  text: string,
  reasoning?: { text: string }
}
```

扩展为:

```ts
{
  type: "assistant_text",
  text: string,
  reasoning?: { text: string },
  error?: string
}
```

### tool output

保持现有形状:

```ts
{
  type: "tool",
  ...,
  error?: string
}
```

### 映射原则

- DB 中 `error_message/error_code` 是统一事实来源
- API 读取时:
  - assistant -> `output.error = error_message`
  - tool -> `output.error = error_message`
- API 写入时允许 assistant/tool 都传 `output.error`,Store 统一映射到 item 级 error 列

## Store 层改造

## 写入规则

### user/system

- `output_text <- output.text`
- `error_message <- null`
- `error_code <- null`

### assistant

- `output_text <- output.text`
- `assistant_reasoning_text <- output.reasoning?.text ?? null`
- `error_message <- output.error ?? null`
- `error_code <- 由调用侧显式给定或根据状态/错误类型推导`

### tool

- `output_text <- output.text`
- `tool_call_json` 继续保存调用信息
- `tool_result_json` 继续保存必要 meta/resultFormat/result 等
- `error_message <- output.error ?? null`
- `error_code <- 由调用侧显式给定或根据失败类型推导`
- `tool_result_json.error` 不再作为主来源;如保留,仅作过渡兼容读取

## 读取规则

### assistant

返回:

```ts
{
  type: "assistant_text",
  text: row.outputText,
  ...(row.assistantReasoningText ? { reasoning: { text: row.assistantReasoningText } } : {}),
  ...(row.errorMessage ? { error: row.errorMessage } : {})
}
```

### tool

返回:

```ts
{
  type: "tool",
  ...,
  ...(row.errorMessage ? { error: row.errorMessage } : {})
}
```

兼容读取原则:

- 若 `error_message` 为空,但旧数据 `tool_result_json.error` 存在,仍可回退读取旧值
- assistant 不做旧 `[run] ...` 文本拆分

## Worker 改造

## assistant 失败收敛

当前 assistant 失败会把 `[run] ...` 拼进正文。新方案改为:

- `status = "failed"`
- `output.text = 已成功产出的正文前缀`
- `output.reasoning = 已成功产出的 reasoning(若有)`
- `output.error = 最终错误信息`

即:

```ts
{
  type: "assistant_text",
  text,
  ...(reasoningText ? { reasoning: { text: reasoningText } } : {}),
  error: finalMessage
}
```

不再生成:

- `text + "\n\n[run] ..."`
- 也不再额外补一条 assistant 对应的 `[run] ...` system item

## tool 失败收敛

tool 仍通过 `output.error` 返回错误,但底层映射到 item 统一 error 列。

## retry 行为调整

### 当前行为

- 首包前失败: 可按 `modelRequestMaxRetries` 重试
- 产生可见输出后失败: 直接终止

### 新行为

分两类处理:

#### 1. 首包前失败

保持现有行为:

- 可直接重试
- 不创建新的 assistant item
- 仍在同一 item 内完成

#### 2. 已有 partial text 后失败

当同时满足以下条件时,允许续写式重试:

- 当前 assistant 已产生非空 `text`
- 未产生有效 tool-call
- 失败后该 turn 未创建任何 tool item
- `retryCount < modelRequestMaxRetries`

行为:

- 当前 assistant item 先收敛为 `failed`
- 下一次尝试重新构建 prompt-context
- prompt-context 仅将“最近一次 failed assistant 的 text”纳入历史消息
- 继续生成新的 assistant item

说明:

- 这是“基于前缀的新请求继续”,不是对原请求的真正续传
- 因此允许少量重复或改写

### 为什么 partial-output 续写采用“新 assistant item”

原因:

- 当前 item 已被用户看到且已进入 failed 终态,保留它更利于调试与 UI 回放
- 使用新 assistant item 更符合“新的模型请求尝试”这一事实
- 避免在同一 item 上继续流式写入,导致一次 item 同时表达多次请求语义

### 与 `modelRequestMaxRetries` 的关系

- 不新增新配置
- `modelRequestMaxRetries` 既控制首包前重试,也控制 partial-output 后的续写重试
- 计数维度沿用“本次模型 step 的失败重试总次数”

## Prompt 构建规则

## 当前 completed assistant 规则

保持不变:

- `status === completed` 的 assistant 进入常规历史 messages

## 新增 failed assistant 注入规则

在构建 `messages` 时,额外允许 **最近一次** failed assistant 注入,但仅限:

- `kind === assistant`
- `output.type === assistant_text`
- `status === failed`
- `output.text.trim().length > 0`
- 该 assistant 所属 turn 不存在任何 tool item

注入方式:

```ts
{ role: "assistant", content: item.output.text }
```

注意:

- 不注入 `output.error`
- 不注入任何 continuation instruction
- 不注入更早的 failed assistant

### 为什么只取最近一次

- 避免上下文累积多个失败残片
- 让续写语义更清晰: 仅继续“刚刚中断的那一段”
- 降低模型重复与漂移风险

### 为什么禁止 tool-call 场景注入

即使本次评审接受“所有 partial text 后失败都可续写”,也仅限 **纯文本场景**。

原因:

- 一旦出现 tool-call,这次响应就不再只是展示文本,而是潜在流程节点
- 自动续写可能导致重复工具调用,与“文本不影响流程逻辑”的前提冲突

## API / Service 改造点

### `getPromptContextForRun`

需要从“只收 completed assistant”改为:

- completed assistant: 正常纳入
- 最近一次符合条件的 failed assistant: 额外纳入
- 其他 failed assistant: 继续过滤

### `getSubtaskRunResultFromWorker`

调整为:

- 优先返回最后一个 assistant item 的 `output.text`
- 若该 assistant 为 failed 且仍有 partial text,返回 partial text
- 不把 `output.error` 拼入 `resultText`
- subtask 成败仍以 run status 判断

### `getContextItems`

返回的 transcript item 应包含 assistant/tool 的 `output.error`

## UI 方案

### assistant 展示

failed assistant 卡片展示:

- 正文: `output.text`
- reasoning: 如有则照常展示
- error: 卡片下方单独一行展示 `output.error`
- tone: 维持 failed/error 视觉风格

示意:

- 主体仍是 assistant message
- 底部附:
  - `Error: model total timeout after 60000ms`

### tool 展示

tool 现有 `output.error` 展示逻辑继续保留,只是底层数据来源切到 item 统一 error 列。

### 复制/引用/导出

- assistant 文本复制仅复制 `output.text`
- `output.error` 不并入正文复制结果

## archive 方案

`buildArchiveLine(item)` 的 assistant 处理规则调整为:

- 正文仍只使用 `output.text`
- 保留 `status=failed` 元信息
- 不把 `error_message` 拼入正文

效果:

- archive 仍然能表达“这条 assistant 最终失败了”
- 但不会把失败原因污染到归档正文中

## 历史兼容

### 旧数据

- 不迁移
- 不解析旧 assistant 文本尾部的 `[run] ...`
- 历史记录保持原样显示

### 读取兼容

- tool: 若新列为空,允许从旧 `tool_result_json.error` 回退读取
- assistant: 不对旧数据做拆分兜底

## 为什么不采用其他方案

### 不继续把 error 写进 assistant.text

原因:

- 会污染 prompt
- 会污染 subtask `resultText`
- 会污染 archive 与复制结果
- 错误不是正文的一部分

### 不新增 `item.error` 顶层 API 字段

原因:

- 现有 tool 已使用 `output.error`
- 继续使用 `output.error` 兼容成本最低
- 首版重点在于语义和存储层拉正,不必额外改变前端消费层级

### 不新增 continuation instruction

原因:

- 首版选择最小实现面
- 当前决策已接受少量重复/不精确续写
- 后续若观察到重复率偏高,可在兼容前提下增加 instruction

### 不为 item 失败额外创建 system item

原因:

- item 自身已能表达失败结果
- 再追加 system item 会造成重复通知与语义分裂
- system item 更适合 run/runtime 级通知

## 风险与接受项

### 1. 续写不精确

接受:

- 少量重复
- 轻微改写
- 语气衔接不完全自然

前提:

- 这些文本仅供用户阅读
- 不作为流程逻辑输入

### 2. 复用同一重试配置导致调优不够精细

接受:

- 首版不区分“首包前重试”和“partial-output 续写重试”
- 若后续反馈表明需要细化,再拆分配置

### 3. 所有 partial-output 失败都尝试续写

接受:

- 这是一项偏激进决策
- 风险由“最近一次 failed assistant + 禁止 tool-call 场景”控制

## 实施顺序

### Phase 1: 数据模型与展示拉正

1. DB schema: 新增 `error_message/error_code`
2. Shared Contract: `assistant_text.error?`
3. Store: assistant/tool 统一读写 error 列
4. Worker: assistant 失败不再拼接 `[run] ...` 到正文
5. Web UI: assistant 下方展示 error
6. archive: assistant 仅归档正文,保留 failed status
7. subtask result: 只返回正文 text,不混入 error

### Phase 2: prompt 支持 failed assistant 续写

1. `getPromptContextForRun` 识别最近一次可续写 failed assistant
2. 增加“仅最近一次 + 无 tool item”的筛选逻辑
3. Worker 在 partial-output 失败后走新 assistant item 的续写请求路径
4. 复用 `modelRequestMaxRetries` 计数与上限

## 验证点

### 数据与接口

- assistant failed item 的 `output.text` 不含 `[run] ...`
- assistant failed item 的 `output.error` 有值
- tool failed item 的 `output.error` 仍可正确返回
- DB 中 assistant/tool 的 `error_message/error_code` 正确写入

### UI

- failed assistant 正文仍可见
- 下方单独展示 error
- 复制正文不包含 error

### prompt

- 普通 failed assistant 不进入 prompt
- 仅最近一次、无 tool item、非空 text 的 failed assistant 进入 prompt
- 注入内容仅为 `output.text`

### retry

- 首包前失败仍按原逻辑重试
- partial-output 失败后若满足条件,会新建 assistant item 继续生成
- 超过 `modelRequestMaxRetries` 后终止

### subtask

- subtask partial-output 失败可续写重试
- 超过次数后 `resultText` 返回 partial text,run status 为 failed

## 结论

本方案将 error 从“混入正文/工具私有字段”升级为 `context item` 的统一能力,并以最小的 API 变更(`output.error`)支撑 assistant/tool 一致化。

在此基础上,通过“仅最近一次 failed assistant + 纯文本回合 + 复用现有重试配置”的策略,为 assistant 引入可接受风险下的续写式重试能力。

该方案符合当前项目阶段:

- 项目未上线,适合一次性拉正模型边界
- 改动范围可控,不需要引入新表/新配置/新指令层
- 能显著改善中途断流时的用户体验,同时避免将错误继续污染后续 prompt
