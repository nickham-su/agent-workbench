# 投影数据结构约定

本文档定义 API 返回给 Web UI 的投影数据结构,以及 Worker/Scheduler 使用的投影视图。

原则:

- 投影只消费 timeline 事件
- 投影必须可重建
- API 返回的结构应稳定,避免 UI 直接依赖底层事件细节

## WorkspaceSessionsIndex

- 用途
  - workspace 下 session 列表

- 字段建议
  - appliedEventId
  - sessionId
  - title
  - kind: primary|subtask
  - updatedAt
  - headEventId

## SessionRunState

- 用途
  - UI 显示是否 busy
  - Scheduler 决定是否需要推进

- 字段建议
  - appliedEventId
  - sessionId
  - status: idle|running|waiting_approval
  - activeRunId 可选
  - activeTurnId 可选
  - pendingUserMessageIds: array
  - pendingToolCallIds: array
  - lastError 可选

## SessionConversationView

- 用途
  - UI 渲染对话时间线

- 形式建议
  - appliedEventId
  - items: array
    - kind: user|assistant|tool|permission|system
    - id
    - runId
    - createdAt
    - content

建议映射规则:

- user.message.created -> kind=user
- model.turn.committed.assistantText -> kind=assistant
- tool.* -> kind=tool(状态卡片)
- permission.* -> kind=permission

说明:

- realtime 事件不进入该 view
- realtime 仅用于当前正在执行的流式展示层(可叠加在 assistant/tool 卡片上)

## SessionPromptContextView

- 用途
  - Scheduler 构建 LLM 输入

- 字段建议
  - appliedEventId
  - messages: 模型消息列表(可直接喂给 provider)
  - toolDefinitions: 当前 toolset snapshot

构建规则(高层):

- 从 headEventId 回溯可见 timeline 事件
- 只注入:
  - user 输入(TextPayload.preview)
  - assistant 文本
  - tool result(output.preview)
  - 必要的 hint(artifactPath)

注意:

- 上下文截断与 compaction 可后续增强
