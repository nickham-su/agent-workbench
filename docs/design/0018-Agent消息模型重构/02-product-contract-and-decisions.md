# 产品合同与关键决策

## 产品语义承诺

- 一条 Assistant Message 可以在一次模型响应中同时包含 Text、Reasoning 和多个 ToolCall。
- ToolCall 与工具执行结果是一一对应的，关联通过 `ToolExecution.callPartId` 表示。
- Reasoning 只用于前端展示，不进入后续模型请求，不进入压缩摘要，不进入归档全文索引。
- Fork 只创建新的对话分支，不复制历史消息，也不恢复或撤销工作区文件状态。
- 消息回退只改变对话上下文，不撤销工具副作用。
- 压缩后模型常规上下文从新的 Compaction Message 开始；历史消息仍可通过归档查询访问。
- 模型请求失败会自动持续重试，错误会通过当前会话运行提示展示给用户。
- 工具执行状态不确定时，结果会如实提交给模型，由模型判断下一步行动。

## 明确不做的能力

- 不做 Provider 原始 HTTP/SSE 事件落库。
- 不做 `ModelInvocation` / `ModelAttempt` 实体。
- 不做 `providerMetadata` / `provider_data` Part。
- 不做 Provider 能力框架。
- 不做 `tool_result` Message。
- 不做 `tool_call_return` Part。
- 不做 `historyRootMessageId`。
- 不把 ArchiveBatch 作为核心依赖。
- 不增加 Run 暂停状态、`blocked`、`waiting_retry`。
- 不做共享 Message 自动 GC。
- 不做旧历史数据迁移和兼容读取。
- 不做工具结果模型投影的大规模重构。

## 关键决策

### Provider 原始输出如何保存

不保存 HTTP/SSE 原始字节，也不复制一份抽象原始响应实体。
权威保存方式是：

- Assistant Message 直接保存当前已支持的有效输出 Part；
- Part 保留原始顺序；
- 模型有效输出完整保存，不截断；
- 流式期间持续更新 Message/Part；
- 请求结束后 Message 进入终态并冻结。

这说明“原始返回完整保存”特指当前已支持的消息类型，而不是为未来 Provider 协议预留通用事件存储。

### 模型错误如何处理

任何模型调用错误一律持续退避重试，不根据错误码判断永久失败。包括：

- 超时、断流、限流、5xx；
- 凭证错误；
- 模型不存在；
- 请求格式错误；
- 其他 Provider 返回错误。

失败信息通过当前运行提示机制展示，用户可随时终止。Runtime 不主动因为模型错误让 Turn 失败。

### 自动重试与部分输出

- 未产生任何有效输出时：保留当前空 streaming Assistant Message，退避后继续。
- 已产生任何 Text、Reasoning 或 ToolCall 时：将旧 Assistant 标记为 `superseded`，创建新的 streaming Assistant，并用 `replacesMessageId` 关联。
- `superseded` 消息保留完整部分输出，但不进入正常上下文、压缩摘要或 FTS。
- 被替代消息中的 ToolCall 不执行。

### 工具调用何时创建 ToolExecution

流式期间只保存 ToolCallPart，不执行工具。
Assistant 成功进入 `completed` 时，在同一事务中为所有 ToolCallPart 创建 `ToolExecution(status=queued)`。

这样保证作废 Assistant 中的 ToolCall 不会已经修改工作区。

### 工具 unknown 语义

工具状态必须遵守：

- `queued`：确定尚未执行，可自动执行；
- `running`：工具调用可能已开始；
- `unknown`：运行时无法确定工具是否已经执行，是终态结果状态。

Worker 中断后遗留的 `running` 一律转为 `unknown`。`unknown` 不重新执行，而是作为工具结果提交给模型，让模型决定检查状态、重试或换路径。

### Tool Result 投影规则

每个 completed Assistant 中的每个 ToolCallPart 恰好生成一个合法结果信封，由单一 Runtime Transcript Projector 确定性生成，不回写 `ToolExecution` 权威字段：

- `unknown`：固定不确定说明，明确可能已执行/有副作用，可附可靠 `resultPreview`，不得表述为成功；
- `cancelled`：有 `error` 优先 `error`，否则有可靠 `resultPreview` 用 `resultPreview`，皆无固定说明“工具调用在执行前被取消，未执行”；
- `failed`：`error` 优先，其次可靠 `resultPreview`，皆无固定内部失败说明；
- `completed`：使用 `resultPreview`，为空时用固定空成功结果说明，不视为不变量错误，不导致 Turn 失败；
- 不自动读取 artifact；
- `structuredResult` 不参与本期模型投影，仅供专用 API / UI；
- `subtask` 是 `resultPreview` 不截断特例，进入模型的是格式化 `resultPreview`，不是任意 structured 对象。

### ToolExecution 与 ToolCall 的关系

- `ToolCallPart.id` 是 Runtime 内部稳定 ID；
- `ToolExecution.callPartId` 唯一；
- 一个 ToolCallPart 最多对应一个 ToolExecution；
- Provider `toolCallId` 只做协议映射，不作为关联主键；
- 历史 ToolExecution 永远不在新分支中重新执行。

### 共享 Message 图

- Message 是 Workspace 内共享的单父节点；
- Message 不再归属于某个 Session；
- Session 只保存 Head、Context Root 和 Revision；
- Fork 只创建新 Session 指针；
- 回退只移动当前 Session Head；
- `depth` 只用于排序和预检，不用于证明祖先关系；
- 祖先关系必须沿 `previousMessageId` 验证。

### Fork 与回退的限制

- Fork/回退只允许从当前模型可见祖先链中选择目标；
- 目标必须是终态 User 或 Assistant Message；
- 目标 Assistant 的 ToolExecution 必须全部终态；
- Session 不能存在未收敛的非终态 Message 或 ToolExecution；
- 不撤销文件修改、命令执行或子任务等副作用。

### 压缩语义

压缩不修改任何旧 Message，只创建新的 Compaction Message，并把当前 Session 的 `contextRootMessageId` 和 `headMessageId` 移到该消息。
压缩前必须确保待压缩范围内的 Message 与 ToolExecution 全部终态。

### 归档查询语义

归档工具只查询高价值 TextPart：

- User Text
- completed Assistant Text
- System Text
- Compaction Text

明确排除：

- Reasoning
- Image
- ToolCall
- ToolExecution
- Runtime Message
- failed / cancelled / superseded Assistant

### 工具结果策略

本期沿用当前规则：

- 8,000 字符以下直接保存；
- 超过阈值保存 3,000 字符预览；
- 超长正文保存到 workspace artifact，最大 200,000 字符；
- `subtask` 继续沿用不截断特例；
- 工具 artifact 路径改为基于 `toolExecutionId`；
- artifact 写入失败后保留当前降级行为。

该规则控制 SQLite 体积，不破坏工具摘要可用性，也不需要本期重新设计模型结果投影。

### 前端增量刷新

继续使用轮询：

- Session 维护 `revision`；
- Message、ToolExecution 维护 `updatedRevision`；
- 增量查询使用 `sinceRevision`；
- 以下场景返回 `timelineReset`：
  - 自动重试替代；
  - 消息回退；
  - 压缩；
  - 其他非追加式 Head 变化。

## 决策冻结表

| 决策 | 权威规则 |
|---|---|
| ToolResult 是否独立建模 | 不建 Message/Part，只存 ToolExecution |
| 消息是否属于 Session | 不属于，仅由祖先链和 Session 指针定义可见性 |
| 归档是否写 Message 字段 | 不写，归档范围由 Session `contextRootMessageId` 推出 |
| FTS 何时写入 | Message 进入 completed 时一次性写入 |
| 模型错误是否结束 Turn | 不结束，持续退避重试并暴露错误提示 |
| 工具 unknown 是否自动重跑 | 不重跑，交给模型 |
| Fork 是否复制历史 | 不复制 |
| 回退是否删除或修改消息 | 不删除、不修改 |
| Clear 是否保留 | 完整移除 |
| 旧数据是否迁移 | 不迁移，升级时清理 |
