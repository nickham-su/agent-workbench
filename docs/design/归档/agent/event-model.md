# 事件模型(EventStore)

本方案将 session 的可见历史建模为单向链表。每个 timeline 事件都有 prevId 指向该 session 可见分支上的前一个事件。

## 事件分层: timeline / realtime / control

为同时满足可回放、低延迟、以及控制命令审计,事件分为三类 lane:

- timeline
  - 参与 session 链表(prevId/headEventId)
  - 影响 projection、prompt context、transcript
  - 需要 CAS 并发控制

- realtime
  - 不参与链表
  - 用于 UI 流式体验(assistant delta、工具进度)
  - 默认不进入 projection/transcript

- control
  - 不参与链表
  - 记录“控制意图与结果”(cancel/revert/fork 请求、执行结果)
  - 可审计,但不直接进入 prompt context

## 核心字段

- eventId
  - DB 自增整数,用于 SSE cursor
- id
  - 稳定事件 id,建议单调 ULID
- workspaceId
- sessionId
- lane
  - timeline | realtime | control
- prevId
  - 仅 timeline 事件需要
  - 指向当前 session 的 headEventId
- type
- schemaVersion
- correlationId 可选
- causationId 可选
- createdAt
- payload

## headEventId(仅 timeline)

- session 的可见分支由 headEventId 定义
- append timeline 时必须满足 prevId=headEventId
- 写入成功后 headEventId 更新为新事件 id

写入点硬约束:

- timeline 事件只能由 API 写入 DB
- Worker 仅通过 IPC 请求 API append.timeline

## fork/revert/cancel 语义(修正版)

## fork

- fork 本身是 control 事件:
  - control.session.fork.requested
- API 创建新 session 后,在新 session 上追加首个 timeline 事件:
  - session.fork_base(prevId=null)
  - payload 引用 fromSessionId/fromEventId

说明:

- timeline 不允许跨 session 的 prev 引用
- 通过 fork_base 保留来源关系,同时保持单 session 单链结构

## revert

- revert 本身是 control 事件:
  - control.session.revert.requested
- 执行结果是 head 移动:
  - session.head.moved(control 事件)
  - headEventId 设置为 toEventId

## cancel

- cancel 本身是 control 事件:
  - control.session.cancel.requested(anchorEventId)
- Worker 收到 cancel 后立即 abort
- 执行结果同样通过 head 移动表达“丢弃后续输入”:
  - session.head.moved(control 事件)
  - headEventId 设置为 anchorEventId

说明:

- cancel/revert 不再作为 timeline 事件
- 避免“先追加再回退导致事件不可达”的语义冲突

## 因果链(correlation/causation)

prevId 只表示链表位置,不表示因果。因果使用:

- correlationId
  - 串联同一 run 或同一触发链路
- causationId
  - 直接上游事件 id(单值)

典型示例:

- user.message.created(id=A)
- model.turn.committed(id=B, causationId=A)
- tool.requested(id=C1, causationId=B)
- tool.requested(id=C2, causationId=B)
- tool.completed(id=D1, causationId=C1)
- tool.completed(id=D2, causationId=C2)
- model.turn.committed(id=E, causationId=D2 或 B)

## lane 白名单规则

避免重放不一致,按规则分配 lane:

- 必须 timeline:
  - user.message.*
  - run.*
  - model.turn.*
  - tool.requested/running/completed/failed
  - permission.asked/resolved

- 只能 realtime:
  - realtime.assistant.delta
  - realtime.tool.progress

- 只能 control:
  - control.session.cancel.requested
  - control.session.revert.requested
  - control.session.fork.requested
  - session.head.moved

## 超长文本与 artifact

对所有非 assistant 文本字段,事件 payload 不直接存 full text。

- 使用 TextPayload:
  - preview
  - truncated
  - artifactPath(直接文件路径)
  - bytes/lines 可选

详见 `truncation.md`、`tools.md` 与 `transcript.md`。
