# clear(清空)功能与边界 marker 落地

## 背景

- 在同一个 session 内,用户可能会开始一个全新的任务。
- 新任务通常需要更干净的 prompt 上下文,避免旧任务的细节污染模型输出。
- 但相比新建 session,继续在同一 session 内推进新任务有优势:
  - 历史决策仍可被模型通过归档工具回忆
  - UI transcript 保留完整时间线,便于审计与回溯

当前系统已具备:

- 归档机制: 通过 `archiveAt` 将旧 items 从 prompt 中移除,但仍在 transcript 可见。
- 归档检索工具: `archive_search`/`archive_read` 可读取 session 归档日志。
- 边界 marker 信号: system item 的 `boundary_reason` 非空会触发前端 full refresh,解决 delta 无法感知旧 items 批量 `archiveAt` 变化的问题。

clear(清空)的目标是在保持上述机制一致性的前提下,提供一个明确的“新任务开始”切换动作。

## 目标

- 用户在当前 session 中主动触发 clear 后:
  - 将 clear 之前的可见窗口 items 归档,使模型上下文变得干净
  - 在 transcript 中插入一条 system 边界 marker,提示“已开始新任务,历史已归档”
  - 模型仍可通过归档工具回忆历史决策
- 复用统一的边界 marker 识别规则:
  - `kind=system` 且 `boundary_reason` 非空即为边界
  - 不依赖枚举值,减少联动修改

## 非目标

- 不在本设计中实现 fork 的细节(该能力已在前置步骤落地)。
- 不在本设计中定义跨 session 的清理/合并策略。

## 核心概念

### 模型可见窗口

- prompt 构建仍以 `archiveAt == null` 作为模型可见条件。
- clear 的本质是将“当前可见窗口”整体归档,并留下一个新的边界 marker 作为新的可见起点。

### 边界 marker

- 边界 marker 是一条 system context item。
- 约束:
  - 仅 system item 允许写入 `boundary_reason`
  - `boundary_reason` 非空即表示该 item 是边界 marker
- clear 会插入新的边界 marker,用于:
  - 触发前端 full refresh,同步旧 items 的 `archiveAt` 批量变化
  - 为后续 fork(with_archive)提供“最近边界”的锚点(当 fork 点处于 archived 区域时)

## 业务逻辑

### 入口与权限

- 仅允许 primary session 执行 clear。
- subtask session 只读,不允许 clear。

### 与运行态(run state)的关系

- 推荐约束: 仅允许在 session run-state 为 idle 时执行 clear。
- 若存在 active run 或可见窗口内存在非终态 items(queued/running/streaming/awaiting_permission):
  - clear 返回错误,提示用户先 cancel 或等待运行完成
  - 取舍原因: 避免“把进行中的 item 归档隐藏”导致 UI 与运行态难以理解,也避免归档日志与最终输出顺序混乱

### clear 的归档范围

- clear 只归档当前可见窗口 items,即 `archiveAt == null` 的 items。
- 说明:
  - 已经归档过的 items(`archiveAt != null`)不需要重复归档,归档工具已经可检索
  - clear 的目标是得到干净的 prompt 窗口,因此对可见窗口做一次性归档即可

### clear 的输出

- 插入一条新的 system item 作为边界 marker:
  - `kind=system`
  - `boundary_reason`: 非空文本,建议为 `"clear"`
  - `archiveAt`: 必须为 null(该 marker 需要进入 prompt)
  - `output.text`: 简短提示,建议包含:
    - 已开始新任务
    - 历史已归档
    - 需要回忆可使用 `archive_search`/`archive_read`

## 存储与一致性

### 归档工具一致性不变量

- 对任意 session:
  - 若存在 `archiveAt != null` 的 items,则该 session 的归档目录必须存在且包含对应归档内容
  - 否则会出现 DB 表示已归档,但归档工具查不到内容的时间线不一致

### 写入顺序与失败处理

clear 需要同时修改 DB(设置 archiveAt,插入 marker)与写文件(追加归档日志),两者无法原子提交。

建议采用与 compaction 相同的两阶段写入策略:

- 阶段 1: 写归档文件
  - 读取可见窗口 items 作为待归档集合
  - 将待归档 items 转为 archive 行,按旧到新顺序追加到归档文件
  - 记录 append snapshot(用于 DB 阶段失败后的 best-effort 回滚)
- 阶段 2: DB 事务
  - 校验 head 未变化(防止并发冲突)
  - 批量设置待归档 items 的 `archiveAt`
  - 插入 system 边界 marker,并将 head 指向该 marker
  - 将 run-state 设置为 idle,更新 appliedItemId
- 若 DB 阶段失败:
  - 使用 append snapshot 进行 best-effort 的归档文件回滚
  - 返回冲突或错误,前端应刷新 transcript

说明:

- 该策略倾向于保证“归档工具与 DB 状态一致”,并复用现有 compaction 的成熟实现路径。

## API 设计建议

- 新增接口: `POST /api/agent/sessions/:sessionId/clear`
- request body:
  - `workspaceId: string`
  - `reason?: string` (可选,用于审计与 UI 展示,不进入模型 prompt)
  - `clientRequestId?: string` (可选,用于去重,与 sendMessage/compact 的模式一致)
- response:
  - `sessionId`
  - `headItemId` (新的 marker item id)

错误码建议:

- `AGENT_SUBTASK_READONLY`: subtask session 不允许 clear
- `AGENT_CLEAR_NOT_IDLE`: session 非 idle 或存在非终态 items
- `conflict_head:*`: head 冲突,提示前端 full refresh 后重试

## 前端交互建议

- 提供显式入口(避免自动误判“新任务开始”):
  - slash command `/clear`
  - 或按钮: Start new task
- 执行 clear 前弹出确认:
  - 说明 clear 会归档当前可见窗口,并插入新任务 marker
  - 说明历史可通过归档工具回忆
- 执行 clear 后:
  - 依赖边界 marker 的 `boundary_reason` 非空触发 full refresh,确保旧 items 的 archived 状态同步
  - 或直接主动 full refresh 作为兜底

## 与 fork/压缩的关系

- clear 插入的边界 marker 与 compaction summary 使用同一识别规则(系统消息 + boundary_reason 非空)。
- fork(with_archive)在 fork 点处于 archived 区域时会向过去寻找最近边界 marker,因此 clear marker 会自然成为新的边界锚点。
- clear 与 compaction 的差异:
  - compaction: 归档一段旧上下文,保留摘要(system marker)
  - clear: 归档当前全部可见窗口,保留一个“新任务开始”的 marker(更强的切换)

## 验证要点

- clear 后 prompt-context:
  - 仅包含新插入的 system marker(以及全局提示词),不包含 clear 前的 user/assistant/tool
- clear 后 transcript:
  - clear 前的 items 仍可见,但 `archiveAt != null`
  - 新 marker 的 `archiveAt == null` 且 `boundaryReason` 非空
- clear 后归档工具:
  - `archive_search`/`archive_read` 能命中 clear 前的内容
- UI 同步:
  - 无需手动刷新页面,归档状态应在 marker 出现后自动同步(依赖 full refresh)
