# API 设计

## 职责

- 维护 `context_item` 主模型,不再依赖 event/conversation 双轨
- 对外提供会话、消息、context-items、run-state、权限决策接口
- 对内提供 worker 回调接口,接收 step-loop 的上下文写入与状态推进
- 管理 worker 子进程与 enqueue/cancel 调度
- 管理 Provider 和 Agent 全局 settings

## 外部接口

### 会话与消息

- `GET /api/agent/sessions`
- `POST /api/agent/sessions`
- `POST /api/agent/sessions/:sessionId/fork`
- `POST /api/agent/sessions/:sessionId/messages`

约束:

- `messages` 写入会先创建 `user` context item,再创建 run 记录并入队 worker
- `clientRequestId` 做幂等去重,相同请求不重复创建 message/run

### 运行控制

- `POST /api/agent/sessions/:sessionId/revert`
- `POST /api/agent/sessions/:sessionId/cancel`
- `POST /api/agent/sessions/:sessionId/tool-permission`

约束:

- revert/cancel 会移动 head 并清理运行态
- `tool-permission` 仅允许处理当前 `waitingToolItemId` 对应的 tool item
- `approve` 后将 tool item 重新置为 `queued`,并恢复 run 为 `running`

### 查询接口

- `GET /api/agent/sessions/:sessionId/context-items`
- `GET /api/agent/sessions/:sessionId/context-items/:itemId`
- `GET /api/agent/sessions/:sessionId/run-state`

约束:

- `context-items` 支持 `afterId` 增量拉取
- 响应返回 `headItemId` 和 `appliedItemId`,用于前端一致性校验
- 前端采用轮询 run-state + 增量 items + 非终态 item 单条刷新

## internal worker 接口

- `POST /api/internal/agent/execution-profile`
- `POST /api/internal/agent/prompt-context`
- `POST /api/internal/agent/context-items`
- `PATCH /api/internal/agent/context-items/:itemId`
- `POST /api/internal/agent/run-state`
- `POST /api/internal/agent/run-complete`

约束:

- internal 接口统一使用 `x-awb-agent-internal-token` 鉴权
- worker 仅通过 internal 接口写入上下文,不直接访问数据库
- `run-complete` 仅在 `activeRunId` 匹配时将 session run-state 置 `idle`,避免迟到回调覆盖新 run

## 一致性与并发控制

### head CAS

- `appendContextItem` 要求 `prevId` 必须等于当前 head
- 写入成功后在同一事务内更新 `session_head.head_item_id`
- 不一致返回冲突,由上层停止推进或重试

### 非终态更新约束

- `updateContextItem` 仅允许更新非终态 item
- tool 权限流转遵循:
  - `queued -> running -> completed`
  - `queued|running -> awaiting_permission -> queued`
  - `awaiting_permission -> denied`

### run-state 约束

- `agent_session_run_state` 保存当前会话运行态
- 字段包含 `activeRunId`、`activeAssistantItemId`、`waitingToolItemId`、`appliedItemId`
- 状态以 `idle|running|waiting_permission` 为主,供前端轮询驱动

## worker 管理

- API 启动时可拉起 worker 子进程
- 支持 unix socket / host:port 两种通信方式
- 支持 run enqueue、session cancel、重启后可恢复 run 入队
- worker 关闭时可降级到 API 内 fallback runtime

## settings 接口

- `GET /api/settings/agent/providers`
- `PUT /api/settings/agent/providers`
- `GET /api/settings/agent/agents`
- `PUT /api/settings/agent/agents`

约束:

- `providers` 与 `agents` 都采用列表 + default 结构
- provider `apiKey` 对外查询不回明文,internal 执行配置可返回明文给 worker
