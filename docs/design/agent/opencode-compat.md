# 与 opencode 的兼容目标(B)

目标:

- 内置工具与 MCP tools 的协议尽量对齐 opencode
- 便于参考 opencode 的提示词与工具迭代

本次迭代范围:

- Provider 仅 `@ai-sdk/openai`
- 工具仅 `read/write/bash`
- MCP tools 延后

本项目的主要差异:

- subtask 命名
  - opencode: task
  - 本项目: subtask

## 工具名与参数

建议对齐:

- read
- write
- bash

延后:

- apply_patch
- subtask
- MCP tools

subtask:

- 保留与 opencode task 类似的参数结构
  - description/prompt/agent/model 等
  - session 选择策略扩展为 new/existing/fork

## tool 状态机字段

对齐 opencode 的 tool part state:

- pending
  - input
  - raw

- running
  - input
  - title
  - metadata
  - time.start

- completed
  - input
  - output
  - title
  - metadata
  - time.start/end

- error
  - input
  - error
  - metadata
  - time.start/end

差异点:

- output 使用 TextPayload,支持 artifactPath
- opencode 的 Truncate 会保存 full output 到 data 目录,本项目保存到 workspace 内部目录

## MCP tools 命名

对齐 opencode 的命名策略:

- sanitize server/tool 名
- 拼接为单个工具名

本项目建议:

- mcp_<server>_<tool>

## 行为兼容

- 截断逻辑
  - opencode 有统一 Truncate.output
  - 本项目采用相同阈值与思路,并扩展到 user 超长输入

- 模型循环
  - opencode 基于 session loop
  - 本项目基于事件循环,但 turn 的行为与 tool calling 语义保持一致

- openai provider 行为
  - 对 `@ai-sdk/openai` 使用 `responses(modelId)`
  - 请求路径目标与 opencode 一致(`/v1/responses`)
