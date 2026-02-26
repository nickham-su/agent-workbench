# 工具系统(Tools)

本方案将内置工具与 MCP tools 统一为 Tool 协议,并将工具调用作为事件序列运行。

目标:

- 工具定义(schema)尽量对齐 opencode(B 级兼容)
  - tool 名称与参数字段尽量一致
  - tool 状态机字段尽量一致
  - 错误语义尽量一致
- subtask 命名例外
  - opencode: task
  - 本方案: subtask

## Tool 协议

## 定义(Definition)

- name
- description
- inputSchema(JSON Schema)
- permissionKey
  - 用于权限评估

## 调用(Invocation)

- toolCallId
- args(raw)
- argsParsed
- runId/sessionId/workspaceId

## 结果(Result)

- status
  - pending/running/completed/error
- summary
  - 工具自带 summarize/toString 输出
  - 必须包含可再次调用所需关键参数
- output
  - TextPayload
  - preview + artifactPath
- metadata
  - 可选,用于 UI 结构化渲染

## TextPayload 与 artifact

对所有非 assistant 的大文本,统一使用 TextPayload:

- preview: string
- truncated: boolean
- artifactPath: string | null
- bytes/lines 可选

artifactPath 使用直接文件路径:

- workspace/.agent-workbench/internal/artifacts/<ulid>.txt

规则:

- 若内容未超过阈值,artifactPath 为空,preview 为 full
- 若超过阈值,artifactPath 指向 full 内容文件,preview 为截断内容

补充:

- user.message.created.text 必须遵循相同规则
- 任何会写入 EventStore 的非 assistant 文本字段,都不应直接存 full text

阈值建议沿用 opencode 默认:

- maxLines=2000
- maxBytes=50KB

说明:

- 本规则适用于:
  - tool 输出
  - user 超长输入
  - MCP tool 输出

## 工具状态机(对齐 opencode)

tool part 建议字段:

- callId
- tool
- state
  - pending: input + raw
  - running: input + title + metadata + time.start
  - completed: input + output(TextPayload) + title + metadata + time.start/end
  - error: input + error + metadata + time.start/end

注:

- output 的 preview 用于模型上下文与 UI 默认展示
- artifactPath 用于按需获取完整输出(read)

## 内置工具(v1)

## read

- 目的
  - 读取文件或目录
- 行为
  - 受 workspace 路径边界限制
  - 支持 offset/limit

## write

- 目的
  - 创建或覆盖整个文件
- 适用
  - 新文件
  - 明确全量覆盖

## apply_patch

- 目的
  - 基于 patchText 对多个文件执行 add/update/delete/move
- 适用
  - 现有文件的局部修改
  - 需要最小 diff

## bash

- 目的
  - 执行 shell 命令
- v1 约束
  - 允许指定 workdir
  - 强制超时
  - 输出截断并写 artifact
  - 协作取消

## subtask

- 目的
  - 在独立上下文(session)中执行子任务
- 输入建议
  - prompt
  - agent
  - session:
    - new
    - existing(sessionId)
    - fork(fromSessionId, anchorEventId?)
- 输出建议
  - resultText(TextPayload 或短文本)
  - subtaskSessionId
  - subtaskRunId

## 工具注册与快照

- Worker 维护 ToolRegistry
  - 内置工具静态注册
  - MCP tools 动态注册
- 每个 run/turn 开始时获取 toolset snapshot
  - 避免执行中工具列表变化导致不一致

## 工具执行与事件

工具调用由 Scheduler 驱动:

- model.turn.committed 产生 toolRequests
- Scheduler 对每个 toolRequest:
  - 追加 tool.requested
  - ask 权限(必要时追加 permission.asked 并进入等待)
  - 执行工具
  - 追加 tool.completed/tool.failed

强约束:

- 任何工具副作用执行前,必须先成功写入 tool.requested
- 工具完成后必须写入 tool.completed/tool.failed
- 若结束事件写入失败,调度器进入 degraded 并重试落账

## 输出给模型与输出给用户

默认策略:

- 用户
  - UI 默认展示 summary + preview
  - 完整输出可按需读取 artifact
- 模型
  - prompt context 默认注入 preview
  - 若需要完整输出,模型可调用 read 读取 artifactPath

原因:

- 模型需要细节但上下文有限
- UI 需要不刷屏
