# 调度器(Scheduler)与事件循环

Scheduler 是 Worker 内的核心模块。它以事件为输入,以副作用(effect)为输出,并将执行结果再次写为事件。

## 运行模型

- 观察
  - 读取 session 的 headEventId 与必要投影
- 决策
  - 判断当前是否需要:
    - 调用 LLM
    - 执行工具
    - 等待权限
    - 结束 run
- 执行
  - 调用对应 executor
- 记录
  - 将结果写为事件
  - 更新投影

关键一致性约束:

- 任何副作用执行前,必须先成功写入对应的 `*.requested` timeline 事件
- 副作用执行完成后,必须写入 `*.completed` 或 `*.failed` timeline 事件
- 若 API append 不可用,调度器必须暂停推进(进入 degraded),避免“副作用已发生但无事件记录”

## turn 模型

一次 LLM 调用产生一个 turn。

- model.turn.started
- model.turn.committed
  - payload 包含:
    - assistantText(可为空,可流式)
    - toolRequests(可为 0..N)

说明:

- timeline 层应至少写入最终的 assistantText
- realtime 层可选写入 delta 事件用于 UI 流式,不参与 headEventId 链表

约束:

- 当 toolRequests 非空时,必须先执行完所有工具请求,才可进入下一次 LLM 调用

## 工具批处理

当一个 turn 产生多个 toolRequests:

- 依次或并发执行工具
  - v1 建议串行执行,减少并发副作用
- 每个 toolRequest 产生:
  - tool.requested
  - tool.running
  - tool.completed 或 tool.failed

执行顺序(强约束):

- append tool.requested 成功
- append tool.running 成功(可选,但建议保留)
- 执行工具副作用
- append tool.completed/tool.failed 成功

工具全部进入终态后:

- Scheduler 再次调用 LLM
- 将工具结果注入 prompt context view

## 结束条件

run 的结束不依赖“事件队列最后一条是什么类型”。

结束条件建议:

- 当前 turn 的 toolRequests 为空
- 当前不存在 pending tool
- 当前不存在 waiting_approval
- 当前不存在显式的 auto-continue 事件

满足结束条件时:

- Worker 追加 run.completed

说明:

- run.completed 必须由 runtime 写入,不依赖 LLM 产出

## 错误与重试

典型错误:

- LLM API 错误
- 工具执行错误
- 上下文溢出

建议事件:

- run.failed
  - payload: error, retryable, attempt

可选事件:

- run.retry.scheduled
  - payload: backoffMs, reason

v1 建议:

- 只做失败终止
- 后续再引入可重试策略

## cancel 与 abort

cancel 由 API 追加 `control.session.cancel.requested` 事件并通过 IPC 通知 Worker。

Worker 行为:

- 立刻对该 session 的 AbortController abort
- 当前执行中的 executor 必须协作取消
- 追加 run.cancelled 事件

## cancel 丢弃后续输入(逻辑删除)

v1 语义要求:

- cancel 不仅停止当前执行,还会丢弃之后发送的用户输入

在事件溯源下,丢弃通过 headEventId 回退实现:

- API 在 control.session.cancel.requested payload 中携带 anchorEventId
- API 追加 `session.head.moved`(control),并将 session 的 headEventId 回退到 anchorEventId
- 后续输入事件成为不可达分支,不进入 projection/transcript

## revert

- revert 由 API 追加 `control.session.revert.requested`
- API 再追加 `session.head.moved`(reason=revert),将 head 移到目标锚点
- Scheduler 在下一轮观察到 head 变化后基于新可见链继续运行

## headEventId 与并发

append 新事件必须满足:

- prevId 等于当前 headEventId

否则:

- 发生并发写冲突
- 写入方应读取最新 headEventId 后重试
