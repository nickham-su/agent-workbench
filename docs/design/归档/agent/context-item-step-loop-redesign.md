# Agent Context Item + Step-loop 改造方案

## 背景与目标

- 当前 agent 运行时以事件列表为中心,前端轮询全量 conversation,流式体验和性能都不理想.
- 本次改造采用 `context_item` 作为主数据模型,直接维护可消费的上下文项.
- worker 改为 `step-loop` 执行器,实现“assistant 先流式可读,工具后置执行”.
- 工具调用采用 AI SDK native tools 协议,不绑定 OpenAI 专有机制.
- 不考虑兼容性,按新模型直接重构.
- 本期不实现自动压缩/裁剪,先跑通完整链路.

## 关键决策

- 数据模型由“事件推导上下文”改为“上下文项直存”.
- 允许部分字段更新,但仅限非终态记录.
- assistant 流式输出实时更新同一条 context item.
- 工具调用在 step 文本完成后再解析和执行.
- 工具执行采用“先全部记录,再逐条执行并更新状态”.
- 用户不再直接调用 `/bash /read /write`,工具仅供 AI 使用.
- 前端保留轮询机制,但不再轮询全量列表.
- 调试日志按 context item 归档,assistant/tool 分目录,文件名仅用 item id.

## 范围与非目标

## 范围

- API/Worker/Web 全链路改造到 context item 模型.
- step-loop + streaming 输出 + tool 后置执行.
- 权限中断流程(`awaiting_permission -> approve/deny -> resume`).
- fork/revert/cancel 在新模型下可用.
- 调试日志体系改造.

## 非目标

- 不做旧接口和旧事件模型兼容.
- 不做上下文裁剪、token 压缩、自动摘要.
- 不做工具并行执行第一版实现.

## 数据模型

## 主表: agent_context_item

- 记录语义: 每条记录代表一条上下文项.
- 主键: `id` 使用 SQLite 自增整型(`AUTOINCREMENT`).
- 关系字段: `workspace_id`, `session_id`, `run_id`, `turn_id`, `step`, `prev_id`.
- 类型字段: `kind`.
  - `user`
  - `assistant`
  - `tool`
  - `system`
- 状态字段: `status`.
  - `streaming`
  - `queued`
  - `running`
  - `awaiting_permission`
  - `completed`
  - `failed`
  - `denied`
  - `cancelled`
- 输出字段: `output`(JSON,单字段).
- 时间字段: `created_at`, `updated_at`.

## output 建议形态

- user: `{ type: "user_text", text: string }`
- assistant: `{ type: "assistant_text", text: string }`
- tool: `{ type: "tool", toolName: string, args?: object, result?: unknown, error?: string }`
- system: `{ type: "system_text", text: string }`

## 可更新规则

- 仅允许更新非终态记录.
- assistant 可更新字段: `output.text`, `status`, `updated_at`.
- tool 可更新字段: `status`, `output.result`, `output.error`, `updated_at`.
- 到达终态后冻结,后续更新必须失败.

## 运行控制数据

- 保留 `agent_session_run_state`,扩展字段:
  - `active_run_id`
  - `active_assistant_item_id`
  - `status`(`idle|running|waiting_permission|failed|completed|cancelled`)
  - `updated_at`

## Worker step-loop

## 主流程

- user 发送消息后,先创建 `user` context item.
- 启动 run,进入 step-loop.
- 每个 step:
  - 构建 prompt context(messages + tools).
  - 调用 `streamText`.
  - 创建一条 `assistant` item,`status=streaming`.
  - 流式增量持续更新该条 `assistant.output.text`.
  - step 结束后,从模型结果提取 tool calls.
  - 若无 tool calls: assistant 标记 `completed`,run 可结束.
  - 若有 tool calls:
    - 先为每个调用创建 `tool` item(`queued`,写入 args).
    - 再逐条执行并更新状态.
    - 工具结果进入上下文,进入下一 step.

## 多工具与混合输出

- 同一步支持“文本 + 多个工具调用”.
- assistant 文本先流出,用户可尽早阅读.
- 工具项在 step 完成后统一建档,再逐条执行.

## 重复调用保护与最大步数

- 仅保留两个硬保护参数:
  - `AWB_AGENT_LOOP_MAX_STEPS`
  - `AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD`
- 其他限制不做硬约束.

## 工具协议与执行

## 模型侧工具定义

- 使用 AI SDK native tools.
- 工具定义包含 `name`, `description`, `input schema`, `execute`.

## 执行顺序

- 先记录 tool item(queued),再执行,最后更新结果.
- 状态流转:
  - `queued -> running -> completed`
  - `queued|running -> failed`
  - `running -> awaiting_permission -> running -> completed|denied`

## 权限中断

- 命中权限检查时:
  - tool item 置 `awaiting_permission`.
  - run state 置 `waiting_permission`.
- 用户 `approve` 后从当前工具继续.
- 用户 `deny` 后写 `denied` 并继续下一 step.

## API 改造

## 前端查询接口

- `GET /api/agent/sessions/:sessionId/context-items`
  - 支持 `afterId` 增量拉取.
- `GET /api/agent/sessions/:sessionId/context-items/:itemId`
  - 查询单条 item(用于最后一条流式和任意非终态项刷新).
- `GET /api/agent/sessions/:sessionId/run-state`
  - 返回 active run 与非终态信息.

## worker internal 接口

- `POST /api/internal/agent/prompt-context`
  - 返回当前 run 可见上下文消息和工具定义.
- `POST /api/internal/agent/context-items`
  - 创建 context item.
- `PATCH /api/internal/agent/context-items/:itemId`
  - 更新单条非终态 item.
- `POST /api/internal/agent/run/:runId/*`
  - run 状态收尾接口(completed/failed/cancelled).

## 前端轮询策略

- 首次进入 session: 拉一次全量 context items.
- 运行中:
  - 轮询 `run-state`.
  - 轮询最后一条流式 assistant item(`active_assistant_item_id`).
  - 轮询所有非终态 tool items.
- 追加式渲染,不重拉整表.

## 调试日志

- 仅开关 `AWB_AGENT_DEBUG_DUMP`.
- 默认目录:
  - `<workspace>/.debug/agent_context_item_logs/assistant/`
  - `<workspace>/.debug/agent_context_item_logs/tool/`
- 文件名仅使用 item id:
  - `assistant/<id>.log`
  - `tool/<id>.log`
- 日志内容:
  - assistant: 请求参数,流式响应累计,解析出的 tool calls,状态.
  - tool: args,状态流转,权限动作,执行结果或错误.

## fork/revert/cancel

- fork: 基于当前可见链复制上下文项到新 session(按既定 fork 语义).
- revert: 移动 session head 到目标 item,并 cancel active run.
- cancel: 终止 active run,将活跃非终态项置 `cancelled` 或停止更新.

## 残留逻辑清理要求

- 删除旧的 `/bash /read /write` 用户显式分流逻辑.
- 删除旧的“以 event 列表推导 context”路径.
- 删除旧 conversation 全量轮询依赖和对应前端解析分支.
- 删除旧 ai-calls 调试目录与命名方案.
- 清理不再使用的事件类型与转换器,避免双轨并存.
- 清理旧 schema/contract 导出,只保留 context item 主路径.

## 实施阶段

## 阶段A: 存储与接口切换

- 落地 `agent_context_item` 表与基础查询.
- 前端改为消费 context items.
- run_state 对接 active item 字段.

## 阶段B: worker streaming + step-loop

- 接入 `streamText`.
- assistant 流式更新单条 item.
- 接入 loop 主流程与步进状态.

## 阶段C: native tools + 权限流程

- 接入工具注册与解析.
- 跑通“先建后执”工具流程.
- 跑通 awaiting_permission/approve/deny.

## 阶段D: 清理与联调

- 清理旧逻辑和旧调试路径.
- 联调 fork/revert/cancel.
- 完成端到端验收.

## 验收标准

- assistant 文本可流式早读.
- 同一步多工具调用时,工具项先可见再逐条执行.
- 权限中断可暂停并恢复.
- 前端不再全量轮询 conversation.
- UI item id 与日志文件可直接一一对应.
- 旧残留逻辑清理完成,运行链路仅剩新主路径.
