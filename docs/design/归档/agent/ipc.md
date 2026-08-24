# API <-> Worker IPC 协议(单写入点)

本方案的关键硬约束:

- timeline 事件只能由 API 写入 DB
- Worker 不直接写 DB timeline,只通过 IPC 向 API 发起 append 请求

目的:

- 降低并发与竞态复杂度
- 统一 CAS(headEventId)与投影更新逻辑
- 保证多 client 场景下 session 链表不分叉

## 通道与连接

- Worker 由 API 启动为子进程
- IPC 使用同一条双向通道
- 高频 realtime 事件可走 IPC 直接推送

## 消息封装

建议统一 JSON envelope:

```ts
type IpcEnvelope = {
  type: string;
  requestId?: string;
  ts: number;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
};
```

## Worker -> API

## append.timeline

- 用途
  - 请求 API 追加一条 timeline 事件

- 必填字段
  - requestId
  - workspaceId
  - sessionId

- payload 建议
  - prevId: string | null
  - id: string(ULID)
  - type
  - schemaVersion
  - correlationId 可选
  - causationId 可选
  - createdAt
  - eventPayload

约束:

- API 必须对 prevId 做 CAS 校验并更新 headEventId
- API 必须在同一事务内完成:
  - 写 event
  - 更新 head
  - 更新最小投影

## append.realtime

- 用途
  - 推送 realtime 事件(assistant delta, tool progress)

- 说明
  - realtime 不参与 headEventId
  - API 可直接 SSE fan-out
  - 是否落库可选(短期保留)

## worker.log

- 用途
  - 调试与观测

## API -> Worker

## append.result

- 用途
  - 回应 append.timeline 的结果

- payload 建议
  - ok: boolean
  - eventId?: number(自增 cursor)
  - headEventId?: string(写入成功后的 head)
  - conflictHeadEventId?: string(409 冲突时返回)
  - error?: string

Worker 行为约束:

- 若收到 conflictHeadEventId:
  - Worker 必须重新读取该 session 的最新状态(至少 headEventId + runState)
  - 重新判断 effect 是否仍成立
  - 用新的 prevId 重新 append 或放弃

## worker.wakeup

- 用途
  - 提示 Worker 有新输入/新权限决策/新 head 变化

## session.cancel

- 用途
  - 低延迟 cancel

- payload
  - sessionId

Worker 行为:

- 立刻 abort 该 session 当前执行
- 停止产生新的 effect
- 后续收尾事件仍通过 append.timeline 写入

## 可靠性说明

- IPC 丢失不影响最终一致性
  - timeline 真相在 DB
  - SSE 可用 cursor 补拉
- IPC 的作用是低延迟
  - delta 流式展示
  - cancel 立即生效
