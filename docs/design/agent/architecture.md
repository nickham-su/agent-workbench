# 总体架构

## 组件

## Web

- 维护 client 状态
  - currentSessionId 可为空
  - 为空时首次发送消息会触发创建 session
- 订阅 SSE 事件流
  - 按 workspaceId + 可选 sessionId 过滤
  - 保存 cursor,断线补拉
- UI 只消费 projection 与事件
  - 不直接理解底层执行细节

## API(Fastify)

- 提供控制面与查询面
  - 写入事件(EventStore append)
  - 读取投影(Projections query)
  - SSE 订阅与补拉
- timeline 单写入点
  - 所有 timeline 事件只能由 API 写入 DB
  - API 负责 CAS(headEventId)校验、更新 head、更新投影
- 启动并监管 Worker 子进程
  - 建立 IPC 双向通道
  - 将 Worker 的实时事件 fan-out 到 SSE 订阅者
  - 将关键控制(例如 cancel)通过 IPC 低延迟推送给 Worker
- 解析执行配置(ExecutionProfile)
  - 基于 Provider/Agent settings 与 run 上下文解析最终模型配置
  - 通过 internal 接口返回给 Worker

## Worker(子进程)

- 事件循环调度器(Scheduler)
  - 从 EventStore 与投影读取状态
  - 决定下一步 effect(调用 LLM、执行工具、等待审批)
  - 通过 IPC 向 API 发起 append.timeline 请求
- 工具执行器(ToolExecutor)
  - 内置工具(read/write/bash)
  - MCP tools(后续)
- 投影更新器(Projector)
  - 将新事件增量应用到 projection 表

说明:

- v1 推荐投影更新由 API 在 append 事务内完成
- Worker 可仅负责“产生事件请求”与“执行副作用”

## DB(SQLite)

- EventStore
  - 事件追加写入,不可变
  - 支持按 session 链表头重建可见历史
- Projections
  - 可重建的读模型
  - 支持 UI 查询、prompt 构建、transcript 重建

## 文件系统(workspace/.agent-workbench/)

- artifacts
  - 保存被截断的大文本完整内容
  - 直接使用文件路径作为引用
- history transcript
  - 从 projection 重建
  - primary/subtask 分目录

## 数据流

## prompt

- Web -> API
  - 发送用户输入,API 追加事件(例如 user.message.created)
  - 返回 sessionId 与可选 runId
- API -> Worker
  - IPC 发送 worker.wakeup,提示有新事件
- Worker
  - run 启动前调用 internal ExecutionProfile 接口
  - 解析得到: prompt、tools、permissions、provider/model
  - 通过 Scheduler 发现需要运行
  - 调用 LLM,生成 ModelTurnCommitted 事件
  - 若包含 ToolRequested,执行工具产生 ToolCompleted/ToolFailed
  - 工具完成后再次调用 LLM 生成收尾文本
- Worker 产生的 timeline 事件通过 IPC 交给 API 追加,Worker 不直接写 DB
- Worker -> API
  - IPC 发送 append.timeline / append.realtime
  - API 成功落库后再 fan-out 到 SSE
- Web
  - SSE 接收事件并刷新 UI
  - 断线时通过 cursor 补拉

## cancel

- Web -> API
  - API 追加 control 事件(例如 control.session.cancel.requested)
  - API 追加 session.head.moved(control),将 head 回退到 anchor
  - API 通过 IPC 立即通知 Worker cancel(sessionId)
- Worker
  - Abort 当前 session 的执行
  - 追加 run.cancelled 等事件
  - 投影更新后,UI 反映为已停止

## revert 与 fork

- revert
  - API 追加 control.session.revert.requested
  - API 追加 session.head.moved(control),将 head 回退到目标锚点

- fork
  - API 追加 control.session.fork.requested
  - API 创建新 session,并在新 session 上写入首个 timeline 事件 session.fork_base

## 可靠性与实时性

- 可靠性
  - 真相在 EventStore
  - 投影可重建
  - SSE 可补拉
- 实时性
  - Worker 通过 IPC 推送事件给 API
  - cancel 通过 IPC 低延迟触发 abort

- 降级
  - API append 不可用时,Worker 暂停推进副作用,避免“执行了但未落账”
