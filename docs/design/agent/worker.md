# Worker 设计

Worker 是同机子进程,负责:

- 运行 Scheduler 事件循环
- 执行 LLM 调用
- 执行工具(内置 + MCP tools)
- 追加事件并更新投影
- 通过 IPC 向 API 发送 append.timeline / append.realtime

## IPC 通道

- v1 默认使用 unix socket 作为 API <-> Worker 内部通道
  - 路径默认放在 `AWB_DATA_DIR/agent-worker.sock`
  - 可通过 `AWB_AGENT_WORKER_SOCKET` 显式覆盖
- 仅在明确需要时回退到 loopback host/port
- 所有内部请求都需要 `x-awb-agent-internal-token`

关键硬约束:

- Worker 不直接写入 DB timeline 事件
- Worker 通过 IPC 向 API 发起 append.timeline 请求
- API 负责 CAS(headEventId)、落库与投影更新
- 若 append.timeline 不可用,Worker 必须暂停推进副作用

## 启动流程

- 初始化 ToolRegistry
  - 注册内置工具
  - 初始化 McpManager 并注册 MCP tools
- 初始化 Scheduler
  - 扫描需要继续推进的 session/run

说明:

- v1 投影更新由 API 在 append 事务内完成
- Worker 不承担投影写入职责

## 事件追加与投影更新

约束:

- Worker 侧只生成“事件追加请求”
- append.timeline 必须携带 prevId=headEventId
- 若 API 返回冲突(409):
  - Worker 必须重新读取最新 headEventId 与状态
  - 重新决策后重试或放弃

## Scheduler 主循环

- 选择需要推进的 session
  - 存在未处理的 user.message.created
  - 或存在未完成的 run
  - 或存在待处理 toolRequests
  - 或存在 waiting_approval
- 对每个 session 执行:
  - 若收到 cancel,abort 并写 run.cancelled
  - 若有 pending tool,执行工具
  - 否则调用 LLM 产生新的 model.turn.committed
  - 若 turn 不产生工具且无待处理项,写 run.completed

说明:

- 所有 timeline 事件都通过 append.timeline 交给 API
- realtime delta 可直接 append.realtime 由 API 分发

降级行为:

- append.timeline 连续失败时,Worker 进入 degraded
- degraded 状态下:
  - 不发起新的 LLM 调用
  - 不执行新的工具副作用
  - 仅保持心跳与重试 append 通道

## LLM 执行

- 输入来自 session_prompt_context_view
- 输出写入:
  - model.turn.started
  - assistant 文本(可流式写入事件或缓存合并后写入)
  - model.turn.committed

说明:

- timeline 必须写入最终 assistantText
- realtime 可选写入 delta 事件,用于 UI 流式

## 工具执行

- 统一由 ToolExecutor 执行
- 关键能力:
  - ask 权限
  - 协作取消
  - 输出截断与 artifact 写入
  - 产出 tool.* 事件

强约束:

- tool 副作用执行前必须 append `tool.requested` 成功
- tool 结束后必须 append `tool.completed`/`tool.failed`
- 若结束事件 append 失败,Worker 保持 degraded 并重试,直至落账成功

## cancel 的低延迟处理

- Worker 维护 sessionId -> AbortController 映射
- 收到 API IPC session.cancel:
  - 立刻 abort
  - 写入 run.cancelled 事件(通过 append.timeline)

## 进程自恢复

- API 负责拉起并守护 Worker 子进程
- Worker 异常退出时:
  - 使用指数退避重启(带少量抖动)
  - 每次重启前必须通过内部 health 探活
- 短窗口内连续失败过多时:
  - 进入短暂熔断暂停重启
  - 记录告警日志,等待窗口结束后再恢复尝试
