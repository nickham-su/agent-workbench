# 投影与读模型

## 总览

当前 Agent 链路以 `context_item` 作为主读模型来源,不再依赖 event timeline 重建 conversation。

读侧核心目标:

- 支持前端增量轮询与流式显示
- 支持 worker step-loop 的 prompt 构建
- 保证 head 可回退、可分支、可恢复

## 核心表与语义

### agent_context_item

- 存储 user/assistant/tool/system 上下文项
- 关键字段:
  - `id` 自增 item id
  - `session_id` 会话归属
  - `run_id`/`turn_id`/`step` 运行期定位
  - `prev_id` 链式可见关系
  - `kind`/`status`/`output_json`
- 语义:
  - `prev_id` 与 head 共同定义当前可见分支
  - assistant/tool 非终态记录允许更新,终态冻结

### agent_session_head

- 记录每个 session 当前 `head_item_id`
- 用于 append CAS 与可见链裁剪
- revert/cancel 会移动 head

### agent_session_run_state

- 记录会话运行状态
- 关键字段:
  - `status` (`idle|running|waiting_permission`)
  - `active_run_id`
  - `active_assistant_item_id`
  - `waiting_tool_item_id`
  - `applied_item_id`

### agent_run

- 记录 run 生命周期与模型解析结果
- 关键字段:
  - `run_id`、`session_id`、`trigger_item_id`
  - `agent_id`、`provider_id`、`model_id`
  - `status` (`queued|running|waiting_permission|completed|failed|cancelled`)

## 查询视图

### session items

- `GET /context-items`
- 首次全量拉取可见链,后续使用 `afterId` 增量
- 返回:
  - `headItemId` 用于前端链路一致性校验
  - `appliedItemId` 用于同步进度展示

### single item

- `GET /context-items/:itemId`
- 用于刷新流式 assistant item 与非终态 tool item

### run state

- `GET /run-state`
- 返回活跃 run 与非终态 item 索引
- 前端轮询该接口驱动刷新节奏

## prompt 视图

`POST /api/internal/agent/prompt-context` 返回 worker 可消费的运行上下文:

- `messages`: 当前可见 user/assistant/tool 归一化消息
- `tools`: 当前 agent 的工具清单与 input schema
- `pendingTools`: 本 run 下待处理 tool items
- `headItemId`: 当前会话 head

该视图由 context items 直接构建,不依赖独立 conversation projection。

## 一致性策略

- append 时用 `prev_id == head_item_id` 做 CAS
- append 成功后事务内更新 head 与 run-state
- run 完成仅在 `activeRunId` 匹配时回收为 idle,避免迟到回调覆盖新 run
- 前端增量合并时若检测到 head 回退或链路不连续,强制全量重拉

## v1 非目标

- 不做 event store 回放重建
- 不做旧 event/conversation 模型兼容迁移
- 不做客户端事件流回放,以 API 轮询为主
