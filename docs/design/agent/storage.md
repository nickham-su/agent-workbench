# 存储设计(DB + 文件)

本方案的权威数据是 EventStore。所有业务状态通过投影表提供查询。

## EventStore 表

建议表名: `agent_event`

- 字段
  - event_id: INTEGER PRIMARY KEY AUTOINCREMENT
  - id: TEXT NOT NULL
  - workspace_id: TEXT NOT NULL
  - session_id: TEXT NOT NULL
  - lane: TEXT NOT NULL
    - "timeline" | "realtime" | "control"
  - prev_id: TEXT NULL
    - 仅 timeline 事件使用
  - type: TEXT NOT NULL
  - schema_version: INTEGER NOT NULL
  - correlation_id: TEXT NULL
  - causation_id: TEXT NULL
  - created_at: INTEGER NOT NULL
  - payload_json: TEXT NOT NULL

- 约束
  - UNIQUE(id)
  - timeline 事件的 prev_id 必须满足:
    - prev_id 为空时表示首事件
    - prev_id 非空时必须指向同 session 的某个 timeline 事件

- 索引
  - (workspace_id, event_id)
  - (workspace_id, session_id, event_id)
  - (session_id, lane, prev_id)
  - (workspace_id, lane, event_id)

说明:

- event_id 用于 SSE cursor
- id(ULID)用于跨表引用、headEventId
- control/realtime 事件可按保留期清理,timeline 事件默认长期保留

## session head 投影

建议表名: `agent_session_head`

- 字段
  - workspace_id
  - session_id
  - head_event_id: TEXT NULL
  - updated_at

说明:

- head_event_id 只指向 timeline 事件
- append timeline 事件必须做 CAS:
  - 读取 head_event_id
  - 写新事件(prev_id=head)
  - 更新 head_event_id=新事件 id

写入点约束:

- timeline 事件 append 与 head 更新由 API 独占
- Worker 不直接写 DB timeline

revert/cancel/fork:

- revert/cancel 会将 head_event_id 移动到历史事件
- 移动 head 同样需要 CAS,避免覆盖并发写

## 其他投影表

根据 UI 与 Scheduler 需求,建议至少具备:

- `agent_session_index`
  - session 列表(title,kind,updated_at)

- `agent_session_message_view`
  - 消息视图数据
  - 可以存为 JSON,便于一次性返回 UI

- `agent_session_run_state`
  - idle/busy/waiting_approval
  - 当前 runId,当前 turnId

- `agent_permission_state`
  - 待审批项与已决策项

投影表是否拆得很细可后续调整。

## 文件存储

## artifact

- 路径
  - workspace/.agent-workbench/internal/artifacts/<ulid>.txt
- 用途
  - 保存被截断的大文本 full content
- 访问
  - 通过 read 工具读取
  - read 必须校验路径边界

## transcript

- 路径
  - workspace/.agent-workbench/history/primary/<sessionId>.md
  - workspace/.agent-workbench/history/subtask/<sessionId>.md
- 来源
  - 从 projection 重建
- 搜索
  - 仅搜 primary 目录

## 回收与清理(GC)

建议逐步引入:

- 分支回收
  - 对长期不可达分支事件做归档或清理
  - 前提是超出审计保留期

- artifact 回收
  - 清理不再被“可达 timeline 事件”引用的 artifact 文件
  - 或按时间窗口清理

- realtime/control 清理
  - 默认保留较短窗口(例如 7-30 天)
