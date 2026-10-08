# 背景与范围

## 需求背景

Agent Session 支持从一条历史 User 或 Assistant message 创建新的 Fork Session。Fork 用于保留已经验证的任务背景，在某个稳定对话节点上开始新的分支，而不修改原 Session。

Session 长度增长后，系统会通过 compaction 追加摘要消息，并将当前 Session 的上下文起点移动到该摘要。压缩前的原始 message、part 和 tool execution 仍被保留在同一 Workspace 的消息图中，但当前 Fork 规则将它们排除为目标：只要 target 位于来源 Session 当前 `contextRootMessageId` 之前，Fork 就失败。

这会限制一个合理的使用方式：用户在后续对话中压缩了 Session，仍希望从之前已经验证过的某个步骤开启一条独立分支。该分支应获得该步骤当时有效的对话上下文，而不应受来源 Session 在该步骤之后发生的压缩影响。

## 用户目标

用户能够：

- 在当前 Agent 时间线中，对来源 Session 物理消息链上的历史 User/Assistant message 使用 Fork。
- 从压缩前消息 Fork 后，继续看到该 target 所在历史时点可用的文本/摘要上下文。
- 在新的独立 primary Session 中继续发送消息和运行 Agent。
- 保持原 Session 和新 Fork Session 的后续对话、压缩与 Revert 相互隔离。

用户不要求：

- 以确定性方式重放过去的终端、Git、文件或外部服务操作。
- 从单独 tool call、tool result、reasoning part、图片 part 或 compaction summary 精确 Fork。
- 对历史 Fork 额外确认或看到风险提示。
- 将历史 Fork 与未来定时任务、自动化或 worktree 隔离一并实现。

## 端到端业务逻辑

```text
用户在来源 Session 时间线选择一条历史消息
  → 前端判断该消息可 Fork
  → POST /api/agent/sessions/fork
  → 后端在 SQLite transaction 中校验来源稳定性与 target
  → 后端依据 target 的祖先链解析历史有效 context root
  → 新建 primary Session 与 idle session_run_state
  → 前端刷新 Session 列表并打开新 Session
  → 用户可在新 Session 继续发送消息
  → 既有 RunLifecycle 创建 Run 并由 Worker 执行
```

Fork 只创建 Session 分支，不会立即创建 Agent Run；后续 `sendMessage()` 才走现有的消息与 Run 启动链路。

## 本轮范围

### 后端

- 放开 `contextRootMessageId` 之前、仍在来源当前物理祖先链上的合法 Fork target。
- 将 `forkMessageSession()` 创建的所有消息图 clone child（公开 primary 与内部 subtask）的 `contextRootMessageId` 统一改为按 target 历史位置计算；内部 `boundaryPolicy` 仅负责 target 解析。
- 保留现有 SQLite transaction、session head/revision fence、idle 校验、message/tool execution 稳定性校验。
- 保持内部 subtask 的 `allowSourceWithActiveRun`、internal-resolved boundary、guard→prompt、prefork summary、lineage、locale/depth 和工具限制。
- 保留 Revert 的压缩边界限制。
- 补全历史 Fork、多次 compaction、retained tail 和异常消息图的测试。

### 前端

- 让压缩前、合法的历史 User/Assistant message 显示 Fork 操作。
- 保持压缩前 User message 不显示 Revert。
- 拆开 Fork 与 Revert 的操作资格和显示控制。
- 为每条 message 建立唯一操作锚点，覆盖无 part、多 part 与最小 part position 非 `0` 的情况。
- 保持现有 Fork API 调用、成功后的 Session 列表刷新与新 tab 激活行为。
- 不增加确认、提示、toast 文案或新的设置项。

## 成功标准

功能完成后，下列结果必须同时成立：

- 从压缩前 target Fork 成功，创建出的 Session root 位于 target 的祖先链上。
- 从多次压缩历史 target Fork 时，使用 target 之前最近的 compaction，而非来源当前或更晚的 compaction。
- 未经历 compaction 的 Fork 使用 `null` root 并保留 target 之前的完整物理前缀。
- 当前有效范围内 Fork 的行为也统一按 target 时点计算，避免 `source.contextRootMessageId === null` 时仅保留 target 的隐式特例。
- 历史 Fork 不会放开 Revert，不会降低来源 idle、同 Workspace、物理祖先、终态和工具执行稳定性限制。
- 历史消息在 UI 中可 Fork，但 Revert 不可见；不出现新增确认或警告交互。
- Fork 后 source 与 child 任意一方继续对话、压缩或 Revert，均不修改另一方的 Session 指针。
- 公开 primary 与内部 subtask 对同一 target 使用相同 target-time root；二者既有的上游 target 解析和运行许可差异保持不变。
- transaction 可确认的消息图损坏 rollback 并返回服务端 `500`；仅 Resolver hydrate 后可发现的 retained 结构损坏继续 fail-close，不构建部分 prompt。

## 非目标与范围保护

本需求不能以“历史 Fork”名义改变以下已有边界：

- Agent 只能操作受当前 Workspace 管理的资源；Fork target 必须属于同一 Workspace。
- 公开 Fork 只能从 primary Session 创建 primary Session。
- 公开 Fork 的来源 Session 必须处于稳定 idle 状态。
- 运行中的消息、运行中的工具执行、非法物理链和数据损坏必须 fail-close。
- source 的模型 override 不会被 child 继承，child 后续 Run 仍按当前 profile 解析流程决定 Agent/provider/model。
