# 会话 fork 两种模式(包含归档/不包含归档)

## 背景

- 当前会话的模型可见窗口由 `archive_at`/`archiveAt` 控制: `archiveAt == null` 的 items 会进入 prompt,`archiveAt != null` 的 items 不进入 prompt,但仍会出现在 transcript(UI 可见)。
- 上下文压缩(compaction)与未来的“清空”(clear)都会导致一批旧 items 的 `archiveAt` 被批量更新。
- 为了让前端在增量拉取(delta)时可靠感知“发生了边界变化,需要全量刷新”,系统会插入一条 system 边界 marker item,并在其元数据字段 `boundary_reason` 写入非空文本。

当前 fork 功能存在以下限制/问题:

- fork 仅支持从“未归档(可见窗口)”消息发起。被归档的历史消息无法作为分叉点。
- 用户希望用 fork 来尝试不同方案,分支是否长期使用不确定,但每个分支需要完整的历史可追溯(尤其是归档可检索)。
- subtask 需要轻量快速的“继承上下文”,不希望 fork 时引入归档文件写入与大量历史复制。

因此需要将 fork 语义拆分为两种模式,分别服务用户 fork 与 subtask fork。

## 目标

- 提供两种 fork 模式:
  - 包含归档(with_archive): 复制完整历史(transcript),并立即生成新会话的归档文件与 `archiveAt` 标记,保证新会话的归档工具可用且内容自洽。
  - 不包含归档(visible_only): 仅复制模型可见窗口(未归档 items),不写归档文件,用于 subtask。
- 允许用户从已归档消息发起 fork(仅限 with_archive 模式)。
- 保持模型可见窗口逻辑不变: 继续以 `archiveAt` 作为 prompt 过滤条件。

## 非目标

- 不在本设计中实现“清空”(clear)功能,仅要求 fork 设计能与 clear 的边界 marker 兼容。
- 不做历史数据兼容/迁移(未上线场景)。

## 关键约束与不变量

- `boundary_reason` 只允许 system item 写入,其存在的核心目的为“通知前端全量刷新”,并可作为边界 marker 的通用识别信号。
- 归档工具不变量:
  - 只要某个会话中存在 `archiveAt != null` 的 items,就必须保证该会话的归档目录中存在对应内容(至少包含这些 archived items 的归档行),否则 `archive_search/archive_read` 的结果会与 DB 状态不一致。
- 子任务(subtask)会话是只读的,subtask fork 需要尽可能轻量,避免写归档造成额外 I/O 与复杂回滚。

## 模式定义

### visible_only(不包含归档)

- 行为:
  - 仅复制源会话的可见窗口 items(`archiveAt == null`)
  - 新会话不写归档文件
  - 新会话内所有 items 的 `archiveAt` 均为 `null`
- 允许的 fork 点:
  - 只能从源会话可见窗口内的 user/assistant 消息发起
- 适用场景:
  - subtask 的 mode=fork(继承当前上下文,用于在子会话中执行任务)

### with_archive(包含归档)

- 行为:
  - 复制源会话从起点到 fork 点的完整 transcript(包含 archived items)
  - 在新会话内重建 `archiveAt` 切窗,并立即写入新会话归档目录
  - 新会话的归档工具应立即可用
- 允许的 fork 点:
  - 允许从源会话 transcript 中任意 user/assistant 消息发起(包括 `archiveAt != null` 的消息)
- 适用场景:
  - 用户主动 fork(用于尝试不同方案,分支可能长期使用)

## 边界 marker 与切窗策略(仅对 with_archive)

### 边界识别

- 边界 marker 判定:
  - `kind == system`
  - `boundary_reason` 非空

说明:

- 本规则不依赖枚举值,未来 compaction/clear 均可复用。

### 切窗计算

fork 的新会话 head 截止到 fork 点(包含 fork 点)后,在该链上计算“新会话的可见窗口起点”。

- 从 fork 点向过去(沿 prev 链)回溯,找到最近的边界 marker item。
- 若找到边界 marker:
  - 将该 marker 及其之后直到 fork 点的 items 设为可见(`archiveAt = null`)
  - marker 之前的 items 设为归档(`archiveAt = <ts>`)
- 若未找到边界 marker:
  - 认为该 fork 点之前没有可用边界,则不进行切窗,全部解档(`archiveAt = null`)

取舍说明:

- 该策略保证“fork 后有一个相对干净的可见窗口”(从最近边界开始)。
- 若 fork 点位于首次 compaction 之前的历史深处,则可能找不到边界 marker,会导致窗口较大。此时用户仍可在 fork 会话中再次执行 compaction/clear 来收敛窗口。

## 归档文件生成(仅对 with_archive)

### 为什么不能直接复制源会话归档文件

- 归档文件行包含 `item=<id>` 等信息,新会话 clone 后 item id 会变化。
- 直接复制源会话归档文件会导致 `item=<id>` 指向错误,并破坏“归档可检索”与排查体验。

因此 with_archive fork 必须为新会话重新生成归档文件。

### 写入内容

- 在新会话内,凡是 `archiveAt != null` 的 items,都需要写入归档目录。
- 写入行内容使用现有归档行格式(包含新会话的 item id)。
- 写入顺序按会话时间从旧到新(保证 `pos` 从旧到新单调增长的直觉)。

### 写入时机与回滚

- 推荐顺序:
  - 先 clone 并在 DB 中更新新会话 items 的 `archiveAt`
  - 再根据更新后的 items 列表生成归档行并 append 写入新会话归档目录
  - 若写文件失败,应回滚/删除新会话或将其标记为失败状态(避免产生“DB 显示已归档但文件为空”的不一致)

实现上可复用已有 compaction 的“文件写入快照 + best-effort rollback”模式。

## API 与内部调用约定

### 对外 fork API

- `POST /api/agent/sessions/fork`
- 新增参数:
  - `mode: "with_archive" | "visible_only"`

约定:

- Web UI 发起 fork 默认使用 `mode="with_archive"`
- 仅在需要轻量继承上下文的内部场景使用 `mode="visible_only"`

### subtask fork

- subtask 工具中 `session.mode="fork"` 的行为应使用 `visible_only` 语义。
- 原因:
  - subtask session 只读,且通常生命周期短
  - 写归档会放大 I/O 与一致性回滚成本

## 前端交互调整

- 主会话(primary)中:
  - fork 操作对 user/assistant 消息不再受 `archiveAt == null` 限制,允许从 archived 消息 fork
  - revert 仍可保持对 archived 消息的限制(避免 DB head 回退与归档工具读取产生时间线不一致)
- 子会话(subtask)中:
  - 继续隐藏 fork/revert 控制(保持只读语义)

## 关键决策与原因

- 拆分 fork 模式而非单一模式
  - 用户 fork 需要“历史完整 + 归档可检索 + 一致性”,适合一次性重建归档
  - subtask fork 需要“快速轻量”,只复制可见窗口即可
- 用 `boundary_reason` 非空作为边界 marker
  - 避免枚举扩张导致多处联动修改
  - 与 compaction/clear 等未来边界事件兼容
- 允许从 archived 消息 fork(仅 with_archive)
  - 满足“从历史决策点分叉尝试不同方案”的核心需求

## 验证要点

- visible_only:
  - fork 会话只包含源会话可见窗口的消息
  - 新会话归档目录为空,且 UI/模型侧不提供归档工具(可选)
- with_archive:
  - fork 会话 transcript 包含完整历史(含 archived)
  - fork 会话存在归档文件,且 `archive_search/read` 能命中被归档的历史
  - fork 会话的模型可见窗口从最近边界 marker 开始(若存在),不包含更早 archived items
