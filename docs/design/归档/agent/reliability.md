# 可靠性与故障策略

## 目标

- 不出现“副作用已发生但事件未落账”
- 多 client 并发写不导致 session 链分叉
- API/Worker/SSE 断连后可恢复一致状态

## 强约束

- timeline 单写入点
  - 仅 API 可写 timeline
  - Worker 仅通过 append.timeline 请求 API

- 副作用落账顺序
  - 先 append `*.requested`
  - 再执行副作用
  - 最后 append `*.completed|*.failed`

- API 不可用降级
  - Worker 暂停推进新副作用
  - 防止执行结果无法记录

## 并发冲突策略

- 所有 timeline append 走 CAS(prevId=headEventId)
- 冲突返回 conflictHeadEventId
- Worker 收到冲突后:
  - 重新读取 head 与 runState
  - 重新决策后重试或放弃

## 断线补偿

- SSE 使用 eventId cursor
- 客户端重连时补拉 cursor 之后事件
- realtime 事件可丢失(仅影响观感),timeline 保证可补

## Worker 进程韧性

- API 作为 Worker supervisor
  - 启动后先做健康探测,再允许业务投递
  - 停机时优雅停止 Worker,避免僵尸进程
- 异常退出自动恢复
  - 指数退避 + 抖动,避免抖动风暴
  - 连续失败过多触发短时熔断,防止无限重启
- 观测性
  - 输出重启次数、退避延迟、熔断触发日志
  - 结合 pid 文件可快速定位“是否已换代重启”

## 控制命令一致性

- cancel/revert/fork 使用 control 事件记录意图
- head 变化通过 session.head.moved(control)记录结果
- cancel 同时触发 IPC abort,确保低延迟停止

## 投影一致性

- 每个投影包含 appliedEventId
- UI 若发现 appliedEventId 落后于已接收事件,显示“同步中”并重拉投影

## 清理与容量

- timeline 默认长期保留
- realtime/control 建议短期保留(例如 7-30 天)
- 不可达分支与 artifact 建议引入 GC:
  - 优先按审计窗口保留
  - 再做可达性清理
