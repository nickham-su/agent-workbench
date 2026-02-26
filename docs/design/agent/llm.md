# LLM 集成

本文档描述 Worker 如何调用 LLM,以及如何将模型输出转换为事件。

## 输入: 从投影构建模型消息

- 使用 SessionPromptContextView
- 包含:
  - user 输入
  - assistant 历史
  - tool request/result
  - subtask 结果

对大文本:

- 默认注入 preview
- 对“当前触发本 run 的 user 输入”,若 token 预算允许,优先注入 full text
- 超预算时回退为 preview + artifactPath
- 通过 artifactPath 提示模型按需调用 read 获取完整内容

说明:

- 模型比用户更依赖中间细节
- 但上下文窗口有限,因此采用“默认 preview + 按需 read full”的策略

## 工具定义: toolset snapshot

- 每次 turn 开始时获取 ToolRegistry 快照
- tool 定义包含:
  - name
  - description
  - JSON Schema

兼容目标:

- tool schema 形状尽量对齐 opencode
- subtask 工具名例外

## 输出: turn committed

模型输出被归一化为一次 turn 的结果:

- assistantText
- toolRequests[]

并写入 timeline 事件:

- model.turn.started
- model.turn.committed

说明:

- 不依赖“最后一个事件类型”判断结束
- 若 toolRequests 非空,必须先执行工具

## 流式输出(realtime)

为了 UI 流式体验,可选支持 delta 事件:

- realtime.assistant.delta

约束:

- realtime 不进入 projection/transcript
- timeline 最终仍需写入完整 assistantText

## tool calling 解析

不同 provider 的 tool calling 输出格式不同。

建议在 Worker 内实现统一解析层:

- 解析出 toolName/toolCallId/args
- 对非法 toolName:
  - 产出 tool.failed 或提示模型纠正

容错建议(参考 opencode):

- toolName 大小写修复
- 未知工具路由到 invalid

## 上下文溢出

- 若 provider 返回 context overflow:
  - 追加 run.failed(retryable)
  - 或触发 compaction 流程(后续增强)

v1 建议:

- 先失败终止并提示用户触发 compaction
