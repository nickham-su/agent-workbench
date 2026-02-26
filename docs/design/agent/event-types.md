# 事件类型与 payload 约定

本文档定义 v1 事件类型清单。事件分为三条 lane:

- timeline: 参与 session 链表(prevId/headEventId),进入 projection/transcript/prompt
- realtime: 不参与链表,用于低延迟 UI
- control: 不参与链表,用于记录控制意图与控制结果

约定:

- timeline 事件必须携带 prevId
- realtime/control 事件不得更新 headEventId
- 所有事件必须携带 workspaceId/sessionId

## 通用字段

所有事件 payload 之外,Envelope 字段见 `event-model.md` 与 `storage.md`。

payload 内常用结构:

- TextPayload
  - preview
  - truncated
  - artifactPath

## session.*(timeline)

## session.created

- lane: timeline
- payload
  - title
  - kind: primary|subtask
  - createdBy: client|system

## session.fork_base

- lane: timeline
- payload
  - fromSessionId
  - fromEventId
  - kind: primary|subtask

说明:

- fork 不跨 session 复用 prev 链
- 新 session 首个 timeline 事件使用 session.fork_base(prevId=null)

## user.*

## user.message.created

- lane: timeline
- payload
  - messageId
  - clientRequestId
  - text: TextPayload
  - parts: 可选(文件引用等)
  - agent: 可选
  - model: 可选

语义:

- user 超长输入必须经过截断,full content 写 artifact

## run.*

run 事件用于明确执行区间与 UI 状态。runId 用于 correlation。

## run.created

- lane: timeline
- payload
  - runId
  - triggerMessageId

## run.started

- lane: timeline
- payload
  - runId
  - startedAt

## run.waiting_approval

- lane: timeline
- payload
  - runId
  - requestId

## run.completed

- lane: timeline
- payload
  - runId
  - finishedAt
  - tokens
    - input
    - output
    - total

## run.failed

- lane: timeline
- payload
  - runId
  - error
  - retryable

## run.cancelled

- lane: timeline
- payload
  - runId
  - reason

## model.*

## model.turn.started

- lane: timeline
- payload
  - runId
  - turnId
  - model

## model.turn.committed

- lane: timeline
- payload
  - runId
  - turnId
  - assistantText: string
  - toolRequests: array
    - toolCallId
    - toolName
    - args
    - raw 可选(原始工具调用文本)

说明:

- toolRequests 非空则必须执行完后进入下一次 turn

## tool.*

## tool.requested

- lane: timeline
- payload
  - runId
  - turnId
  - toolCallId
  - toolName
  - args
  - summary

## tool.running

- lane: timeline
- payload
  - runId
  - toolCallId
  - startedAt

## tool.completed

- lane: timeline
- payload
  - runId
  - toolCallId
  - finishedAt
  - output: TextPayload
  - summary
  - metadata 可选

## tool.failed

- lane: timeline
- payload
  - runId
  - toolCallId
  - finishedAt
  - error
  - output: TextPayload 可选
  - summary

## permission.*

## permission.asked

- lane: timeline
- payload
  - requestId
  - runId
  - toolName
  - permissionKey
  - patterns
  - metadata

## permission.resolved

- lane: timeline
- payload
  - requestId
  - runId
  - decision: allow_once|allow_always|deny

## realtime.*

## realtime.assistant.delta

- lane: realtime
- payload
  - runId
  - turnId
  - delta

## realtime.tool.progress

- lane: realtime
- payload
  - runId
  - toolCallId
  - chunk

## control.*

control 事件不进入 session 链表,用于审计和控制执行。

## control.session.fork.requested

- lane: control
- payload
  - fromSessionId
  - fromEventId
  - newSessionKind: primary|subtask

## control.session.revert.requested

- lane: control
- payload
  - toEventId
  - reason

## control.session.cancel.requested

- lane: control
- payload
  - scope: session
  - cancelMode: discard_to_anchor
  - anchorEventId

## session.head.moved

- lane: control
- payload
  - fromHeadEventId
  - toHeadEventId
  - reason: revert|cancel|fork_init|admin
