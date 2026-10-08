# 代码地图与改造映射

## 当前关键代码地图

### 共享契约

- `packages/shared/src/contracts/agent.ts`
  - ContextItem 类型与 output 联合：`:36-119`
  - `activeAssistantItemId` 等旧 Run 状态字段：`:300` 附近
- `packages/shared/src/internal-contracts/agent-api-read.ts`
  - 当前 provider 风格 `PromptMessage`：`:118-181`

这些文件需要整体迁移到 Message/Part/ToolExecution 契约。

### API 持久化

- `apps/api/src/infra/db/schema.ts`
  - `agent_context_item`：`:150-176`
  - `agent_context_item_attachment`：`:190-198`
- `apps/api/src/modules/agent/agent.store.ts`
  - ContextItem append/update fence：`:1115-1191`
  - transcript 与分页：`:1330-1483`
  - compaction/archive/head 更新：`:1524-1663`
- `apps/api/src/modules/agent/agent.composition.ts`
  - `buildArchiveLine()`：`:853-877`
  - prompt 重建与工具聚合：`:2085-2359`

这些是当前扁平模型和旧归档逻辑的权威实现点，需要整体替换。

### API Session / Fork / Compaction / Archive

- `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts`
  - fork 复制历史：`:79-173`
- `apps/api/src/modules/agent/compaction/compaction-archive-application.ts`
  - 当前压缩与 clear：`:24-139`
- `apps/api/src/modules/agent/archive/archive-storage.ts`
  - 文件归档滚动与补偿
- `apps/api/src/modules/agent/archive/archive-read-storage.ts`
  - `rg` 搜索与文件读取

这些模块在新模型下被替换或删除。

### Worker

- `apps/agent-worker/src/runtime/runner.ts`
  - 工具结果截断常量：`:56-65`
  - `finalizeToolText()`：`:533-628`
  - 工具执行与写回：`:1305-1460`
  - 模型流 chunk 处理：`:2319-2361`
  - 每轮获取 Prompt Context 与 pending tool 主循环：`:2747-2829`
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`
  - `archive_search` / `archive_read` 工具参数与调用

Worker 是模型流、工具执行、重试和恢复的主要改造面。

### 前端

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
  - `DisplayItem` 扁平结构：`:927-951`
  - 刷新、分页、非终态轮询：`:2630-2741`
- `apps/web/src/features/workspace/tools/agent/AgentApplyPatchCard.vue`
- `apps/web/src/features/workspace/tools/agent/AgentWriteCard.vue`
  - 当前 artifact API 基于 Tool ContextItem ID

前端需要从扁平 Item 视图迁移到 Message View + ToolExecution View。

## 主要改造映射

| 当前能力 | 目标实现 | 主要影响 |
|---|---|---|
| ContextItem output | Message + Part + ToolExecution | shared、schema、store、runner、前端 |
| Prompt 重建 | Runtime Transcript Projection | `agent.composition.ts`、read-side projector |
| Tool ContextItem | ToolCallPart + ToolExecution | runner、store、前端工具卡片 |
| Fork 复制历史 | Session 指针共享祖先 | session interaction store/application |
| 回退移动 Item Head | 移动 Message Head | session interaction store/application |
| 压缩写 `archiveAt` | Session `contextRootMessageId` 前移 | compaction application/store |
| 文件归档 + rg | SQLite `archive_read` + FTS5 `archive_search` | archive 模块整体替换 |
| 前端 Item 轮询 | revision + updatedRevision + timelineReset | AgentClientPane 与 API contracts |
| Clear | 移除 | routes、worker、web、shared |
| 子任务父 Tool Item 关联 | 父 ToolExecution 关联 | subtask schema/application/query |

## 建议模块边界

### API

- `message-persistence`
  - Message/Part/ToolExecution append/update/query
  - CAS、fence、revision
- `conversation-query`
  - UI conversation projection
  - timeline delta
- `transcript-projection`
  - Provider-neutral transcript
  - ToolResult 合成
- `session-interaction`
  - Fork / Revert
- `compaction`
  - Compaction Message 生成与 Session 边界更新
- `archive-query`
  - archive_read / archive_search
- `subtask-lineage`
  - parent ToolExecution 关联

### Worker

- `runner` 保留主循环，但内部拆出：
  - 模型流写入
  - 重试替代
  - 工具执行状态机
  - 崩溃恢复
- `apiClient` 改为调用 Message/ToolExecution 新内部接口

### Web

- 从 `DisplayItem[]` 迁移到：
  - `ConversationMessageView[]`
  - 内联 ToolCallView
  - 非终态 Message/ToolExecution 轮询

## 工具 artifact 迁移点

当前 `finalizeToolText()` 生成：

- `text`
- `textTruncated`
- `textArtifactPath`

新模型迁移到 ToolExecution 后：

- `resultPreview`
- `resultTruncated`
- `resultArtifactPath`

路径从当前基于 provider `toolCallId` 改为基于 `toolExecutionId`，避免共享图和重试场景下冲突。

## 代码移除清单

- 旧 `agent_context_item` 读写与投影实现
- 旧 `agent_context_item_attachment`
- 文件归档、`rg`、archive pending reconcile
- clear 全链路
- 旧 `buildArchiveLine()` 及其依赖
- 旧 `buildPromptMessagesForSession()` 中的相邻 Item 推断

## 新增实现清单

- Message / Part / ToolExecution schema 与 store
- Session revision / timeline delta
- Fork / Revert 新实现
- Compaction 新实现
- FTS5 trigram 索引维护
- archive_read / archive_search SQL 实现
- Worker 自动重试替代与恢复
- 前端 Conversation View
