# API 设计

API 的职责是:

- 写入 EventStore
- 读取 Projections
- 提供 SSE 订阅与断线补拉
- 管理 Worker 子进程与 IPC
- 管理 Provider/Agent 全局 settings

关键硬约束:

- timeline 事件的 DB 写入由 API 独占
  - Worker 只能通过 IPC 请求 append.timeline
- control 事件同样由 API 写入

## 写事件(Append)

原则:

- 所有外部动作都必须转换为事件
  - 发送消息
  - /new
  - fork
  - revert
  - cancel
  - 权限决策

补充:

- 消息请求可携带 `agentId`
- API 在 `run.created` 中固化本次解析结果:
  - `agentId`
  - `providerId`
  - `modelId`

并发控制(CAS):

- timeline 事件 append 必须携带 prevId
- API 必须基于投影 `agent_session_head.head_event_id` 做 CAS:
  - 仅当 prevId 等于当前 head_event_id 时允许写入
  - 写入成功后更新 head_event_id 为新事件 id
- 不一致则返回冲突
  - 返回当前 head_event_id,供 client 重试

control 事件:

- control 事件不需要 prevId
- 但若 control 会移动 head(例如 revert/cancel),必须在事务内对 head 做 CAS 更新

补充:

- API 也负责接收 Worker 的 append.timeline 请求并执行同样的 CAS

append 事务边界(推荐):

- timeline append 成功事务内完成:
  - 写 event
  - 更新 session_head
  - 更新最小投影
  - 生成 SSE 待发送记录

失败处理:

- 事务任一步失败则整体回滚
- 不允许出现“写了 event 但没更新 head/投影”的半状态

幂等:

- 对用户提交的 prompt,要求 clientRequestId
- API 需要保证相同 clientRequestId 不重复产生新的 timeline 事件链
  - 可通过投影记录已处理的 clientRequestId
  - 或在 append 时写入一个去重索引表

## SSE 订阅

- 订阅参数:
  - workspaceId
  - sessionId 可选
  - cursor(eventId) 可选

- 行为:
  - 建立连接时先补拉 cursor 之后的 events
  - 进入实时推送模式

实时推送来源:

- Worker IPC event.append
- API 也可直接推送自身追加的事件

说明:

- SSE 推送既包含 timeline 事件,也可包含 realtime 事件
- UI 可仅将 timeline 事件作为“状态刷新触发器”,realtime 事件用于流式效果

## Provider/Agent Settings 接口

对外接口:

- `GET /api/settings/agent/providers`
- `PUT /api/settings/agent/providers`
- `GET /api/settings/agent/agents`
- `PUT /api/settings/agent/agents`

约束:

- provider/models 使用列表结构
- default 必须显式配置
- `baseURL` 必填,是否包含 `/v1` 由用户自行负责

apiKey 返回策略:

- 对外 `GET` 不返回明文
- 返回 `hasApiKey` 与 `apiKeyMasked`

apiKey 更新语义:

- 未传: 保持原值
- 传空字符串或 null: 清空
- 传非空字符串: 覆盖

## Internal ExecutionProfile 接口

Worker 每次 run 开始前调用 internal 接口:

- `POST /api/internal/agent/execution-profile`
- 鉴权: `x-awb-agent-internal-token`

请求:

- `workspaceId`
- `sessionId`
- `runId`

返回:

- `agent`
  - `id` `name` `prompt` `tools` `permissions`
- `provider`
  - `id` `npm` `options.baseURL` `options.apiKey`
- `model`
  - `id` `options`

说明:

- internal 返回明文 `apiKey`,仅供 Worker 使用

## v1 投影策略(推荐)

为了降低实现复杂度,v1 推荐:

- API 在 append timeline 事务内更新最小投影:
  - session_head
  - session_index
  - run_state

- ConversationView 与 PromptContextView 可先按需重建:
  - 请求时从 headEventId 回溯 timeline 链表并 reducer
  - 后续再演进为增量物化投影

## 查询投影

API 主要提供:

- workspace sessions list
- session conversation view
- session run state
- session prompt context view(供调试)

v1 建议:

- UI 收到 SSE 事件后触发拉取投影刷新

## Worker 管理

- API 启动 Worker 子进程
- IPC 双向:
  - API -> Worker: wakeup,cancel
  - Worker -> API: append.timeline,append.realtime,log,ready

降级策略:

- 若 API 到 Worker IPC 中断:
  - API 标记 worker_unhealthy
  - 前端显示执行降级提示

- 若 Worker 到 API append.timeline 失败:
  - Worker 必须暂停推进(不继续执行副作用)
  - 直到 append 恢复

## 断线与重启

- API 重启
  - Worker 可重启或保留
  - SSE 客户端通过 cursor 补拉
