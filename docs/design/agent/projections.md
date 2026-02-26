# 投影(Projections)

投影是从 EventStore 重建的读模型,用于:

- Web UI 查询与渲染
- Scheduler 构建 prompt
- history transcript 重建

投影不是权威数据,可随时从 EventStore 重建。

约束:

- projection 默认只消费 timeline 事件
- realtime 事件用于低延迟 UI,默认不进入 projection/transcript

## 投影更新方式

- 增量更新
  - v1 由 API 在 timeline append 事务内更新最小投影
  - ConversationView/PromptContextView 可按需重建
- 全量重建
  - 提供 rebuild 操作,从 headEventId 回溯该 session 分支的可见事件

版本一致性建议:

- 每个投影记录 `appliedEventId`
- API 返回投影时附带该值
- UI 若发现 `appliedEventId < 最新已接收 eventId`,显示“同步中”并短轮询刷新

## 推荐投影集合

## workspace_sessions_index

- 用途
  - 列出 workspace 下的 session
  - 显示 title、更新时间、kind(primary/subtask)
- 来源
  - session.created
  - session.fork_base
  - user.message.created
  - model.turn.committed

## session_head

- 用途
  - 存储 session 的当前 headEventId
  - 作为 append 并发控制的依据
- 来源
  - 每次 append 新事件时更新
  - revert/fork 会将 head 移动到历史事件

## session_conversation_view

- 用途
  - UI 以“消息视图”渲染对话
- 形式
  - 将事件组装为 MessageView 列表
  - 模型 turn、工具调用、权限请求都映射为 UI 卡片

说明:

- 本方案不强制复刻 opencode 的 message/part 表结构
- 但建议保持 tool 状态机字段与 opencode 接近,便于复用经验

## session_run_state

- 用途
  - UI 展示 busy/idle/waiting_approval
  - cancel/retry 状态判断
- 来源
  - run.*
  - permission.*

## session_prompt_context_view

- 用途
  - Scheduler 构建 LLM 输入
- 形式
  - 将可见事件编码为模型消息列表
  - 包含:
    - user 输入
    - assistant 文本
    - tool request/result
    - subtask 结果
  - 控制:
    - 仅使用 preview 或按需 read artifact
    - 遵循 compaction anchor

## compaction_anchor

- 用途
  - 控制上下文窗口
- 来源
  - session.compaction.applied

## 事件补拉与投影一致性

- SSE 以 eventId 作为 cursor
- 投影以事件 id(ULID)与 eventId 都可关联
- UI 收到事件后可以:
  - 直接应用事件到本地 UI 状态
  - 或触发一次拉取投影(简单实现)

建议策略:

- v1 以“拉投影”为主,事件只作为刷新触发
- 后续再做客户端增量应用,减少 API 查询压力
