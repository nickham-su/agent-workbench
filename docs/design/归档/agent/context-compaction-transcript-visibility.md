# Context Compaction Transcript Visibility (UI vs Prompt)

## 背景

agent-workbench 在长会话中会进行上下文压缩(compaction),以限制 prompt 上下文长度.

当前实现使用 `agent_context_item.archive_at` 标记被归档的 items,并在读取“可见 items”时直接过滤 `archive_at != null` 的记录.

这导致一个不符合预期的行为:

- 压缩后,旧消息在 Web UI 中不可查看.

我们希望调整为:

- Web UI 仍可查看归档消息(作为会话历史的一部分).
- 提交给模型时,仅从最新的压缩总结(system summary)开始可见(归档消息不进入 prompt).

## 目标

- UI transcript 仍展示归档消息,不因 `archive_at` 被置位而消失.
- prompt-context 构建仍只包含“未归档”消息,保持压缩对上下文窗口的效果.
- 归档消息在 UI 中禁止 fork/revert.
- compaction 完成后,前端可以可靠触发一次全量刷新(full refresh),同步旧消息的 `archiveAt` 状态变更.
- 不引入额外的 marker 消息(除了 compaction 本身已有的 summary system item).
- 保持 compaction 为单阶段原子提交,避免 begin/finish 两阶段一致性与回滚复杂度.

## 非目标

- 不实现手动 `/compact` 指令(本设计仅改造可见性与 UI 同步机制).
- 不改造归档落盘格式与 archive 工具(archive_search/archive_read 等).
- 不允许对归档消息 fork/revert(如未来要支持,需要另立设计).

## 核心思路

将“UI 可见”和“prompt 可见”解耦:

- `archive_at != null` 的 item 语义调整为: 不进入 prompt,但仍属于会话历史,UI 可展示.
- prompt 构建仅使用未归档 items.

为解决“归档发生在旧 items 上,前端增量拉取看不到状态变化”的问题,新增元数据字段 `purpose`:

- compaction summary 那条 system item 写入 `purpose = "compaction_summary"`.
- 前端在增量拉取(delta)中看到该 purpose 时,触发一次全量刷新,从服务端重新拉取整条 transcript,以同步旧 items 的 `archiveAt` 更新.

## 数据模型变更

### 新增列: agent_context_item.purpose

- 表: `agent_context_item`
- 列: `purpose text` (nullable)
- 默认: null
- 取值约定:
  - `compaction_summary`: 由 compaction 插入的 system summary item

说明:

- `purpose` 是 item 元数据,不属于 output payload.
- 后续如需要扩展(例如 tool marker, UI-only marker),可继续在该字段上定义新的字符串值.

### 归档字段继续沿用

- `archive_at` 继续作为归档标记.
- 不删除归档消息,仅改变 UI 读取策略.

## 共享契约变更(packages/shared)

为让前端感知归档状态与 purpose,扩展 `AgentContextItemRecord`:

- 新增字段 `archiveAt: number | null`
- 新增字段 `purpose: string | null`

约束建议:

- `purpose` 初期可用 `string | null` 放宽,后续可逐步收紧为枚举.

## 后端读取与路由改造

### 拆分两类视图

新增两个概念层的读取函数(命名仅示例,以实现为准):

- Transcript 视图(UI 用)
  - 从 session head 往前遍历链表.
  - 不过滤 `archive_at`.
  - 返回当前分支的完整历史(包含 archived 与非 archived).

- Prompt 视图(模型用)
  - 从 session head 往前遍历链表.
  - 过滤 `archive_at != null`.
  - 返回仅用于 prompt 的活动区间.

实现注意:

- 避免继续复用现有 `getSessionVisibleItems()` 同时服务 UI 与 prompt.
- UI 接口应该返回 transcript 视图,而 prompt-context 继续使用 prompt 视图.

### API 行为调整

- `GET /api/agent/sessions/:sessionId/context-items`
  - 返回 transcript 视图(包含 archived).

- `GET /api/agent/sessions/:sessionId/context-items/:itemId`
  - 允许读取 archived item.
  - 需要保证 item 在当前 session 的 head 链上可达(reachable),避免越权读取.

### fork/revert 限制

归档消息不允许 fork/revert,需要双层防护:

- 前端 UI 根据 `archiveAt != null` 禁用/隐藏操作.
- 后端在 fork/revert 入口处也要拒绝归档目标,返回 400(建议提供稳定错误码,便于前端提示).

## compaction 写入改造

compaction 本身已有“插入 system summary + 归档旧 items + 更新 head”的事务性操作.

在插入 summary item 时额外写入:

- `purpose = "compaction_summary"`

保持不变:

- 旧 items 通过 `archive_at` 归档.
- summary 内容仍由模型生成并写入 `system_text`.

## 前端改造(Web)

### 展示方式

选择展示方式 A:

- transcript 平铺显示所有消息(含 archived).

### 禁用归档消息 fork/revert

- 当 `msg.archiveAt != null` 时:
  - 对 user/assistant 消息隐藏或禁用 fork/revert 按钮.
  - 可选: 增加一个轻量视觉标记(例如 Archived tag),但不是本期硬要求.

### compaction 后触发全量刷新

问题:

- compaction 归档的是旧 items,它们 id 不变,仅 `archiveAt/updatedAt` 变更.
- 前端当前增量刷新使用 `afterId` 拉取新 id,无法拿到旧 items 的状态更新.

方案:

- 前端在 delta items 中检测 `purpose === "compaction_summary"`.
- 一旦检测到,立即触发一次 full refresh(`getAgentContextItems(sessionId)`),以同步旧 items 的 `archiveAt`.

实现建议:

- 增加本地 guard,避免同一条 summary 重复触发 full refresh(例如记录最近一次处理过的 summary id).

### 压缩进行中提示

- 使用 runState 的 `runNoticeText` 展示“正在压缩上下文...”等提示.
- 不新增 UI-only 消息,避免污染 transcript.

## 兼容性与迁移

- 新增列 `purpose` 通过增量迁移(ensureColumn)完成.
- 历史 compaction summary 不带 purpose:
  - 前端不会基于历史 summary 自动触发 full refresh.
  - 但只要从本改造版本开始,新发生的 compaction 会写入 purpose,即可稳定工作.

## 风险与缓解

- 性能: transcript 平铺会话在极长历史时可能较慢.
  - 本期先保持现状返回全量列表,后续可考虑分页或虚拟列表.

- 一致性: UI 与 prompt 视图拆分后,需要避免误用 prompt 视图去驱动 UI.
  - 建议通过函数命名与代码结构强约束.

## 验证清单

后端测试(建议覆盖):

- compaction 后 `context-items` 返回包含 archived items,并携带 `archiveAt`.
- compaction summary item 返回 `purpose = "compaction_summary"`.
- `prompt-context` 不包含 archived items,且包含 compaction summary.
- 对 archived item 发起 fork/revert 被后端拒绝.

前端手测:

- 压缩前后,旧消息仍可见.
- 归档消息 fork/revert 按钮不可用.
- 压缩发生后无需刷新页面,旧消息的 archived 状态能自动同步(依赖 purpose 触发 full refresh).
