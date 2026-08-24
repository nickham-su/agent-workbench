# Web client 行为

本方案假设:

- 一个 workspace 页面可打开多个 client 窗口
- 多个 client 可指向同一个 session

## currentSessionId

- currentSessionId 由 client 在前端保存
- 服务端不维护 currentSessionId
- 所有请求必须显式带 sessionId

## session 创建

- currentSessionId 为空时
  - 用户发送第一条消息
  - client 先调用 session.create 获取 sessionId
  - 再追加 user.message.created 事件

## /new

- client 发起 session.create
- 切换 currentSessionId
- UI 展示新会话

## /session

- client 拉取 session 列表投影
- 选择 sessionId 切换

## fork

- client 选择从某条消息位置 fork
  - 服务端创建新 session,并写入 `session.fork_base` 作为首个 timeline 事件
  - `session.fork_base` 引用来源会话与锚点事件
- 或完整 fork 当前 session

## cancel

- UI 提供 session 级 cancel
- 语义
  - 取消当前执行
  - 逻辑删除后续不可达分支

## revert

- UI 允许选择某条历史 user message 作为锚点
- revert 后
  - session head 移动到锚点
  - 后续事件成为不可达分支

## SSE 订阅

- client 建议订阅 workspace scope
  - 允许在 UI 内同时看到多个 session 的更新
- 若仅展示单 session
  - 订阅 sessionId 过滤

断线重连

- 保存 cursor(eventId)
- 重连时带 cursor 补拉
