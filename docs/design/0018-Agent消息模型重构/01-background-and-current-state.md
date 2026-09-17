# 需求背景与当前现状

## 需求背景

Agent Runtime 的消息模型当前是扁平的。一次模型响应可以同时产生 Text 和多个 ToolCall，但持久化模型没有保存这些层级关系。下一轮请求前，系统需要从扁平记录重新聚合：

```text
assistant item
tool item A
tool item B
        ↓
assistant(text + tool-call A + tool-call B)
tool(tool-result A + tool-result B)
```

用户明确要求：

- 一条 Message 对应多个有序 Part。
- Message 类型由 Runtime 定义，不复用 Provider role。
- Part 支持 Text、ToolCall、Reasoning、图片资源等。
- ToolCall 与工具调用返回一一对应。
- Fork 不复制历史消息。
- 归档搜索改为 SQLite。
- 所有模型异常持续自动重试。
- 工具执行结果不确定时交给模型判断，而不是轻易结束 Turn。

本方案服务于无人值守的长期运行任务，因此恢复策略优先于快速失败。

## 当前实现事实

### 当前消息单元是扁平 ContextItem

共享契约中的消息单元是 `AgentContextItemRecord`，类型只有：

- `user`
- `assistant`
- `tool`
- `system`

证据：

- `packages/shared/src/contracts/agent.ts:36-42`
- `packages/shared/src/contracts/agent.ts:61-119`
- `packages/shared/src/contracts/agent.ts:232-249`

`output` 是互斥联合，而不是 Part 列表。Assistant 的 reasoning 只是一个附属字符串字段。

### 工具调用与结果目前合并保存在 Tool ContextItem

当前 Tool ContextItem 同时保存：

- `toolName`
- 可选 `toolCallId`
- `args`
- `text`
- `result`
- `error`

证据：

- `packages/shared/src/contracts/agent.ts:95-105`
- `apps/api/src/infra/db/schema.ts:150-176`

这意味着工具调用声明与执行结果没有独立领域实体。

### 模型请求重建依赖隐式相邻推断

`buildPromptMessagesForSession()` 会：

- 倒序扫描 Tool Item；
- 回找相同 `runId + turnId + step` 的 Assistant Item；
- 将连续 Tool Item 拼回 assistant 的 `tool-call` Part；
- 将 Tool Item 结果拼成单独 `tool` 消息。

证据：

- `apps/api/src/modules/agent/agent.composition.ts:2085-2359`
- 关联推断：`apps/api/src/modules/agent/agent.composition.ts:2110-2129`
- 多 Part 重建：`:2272-2355`

内部 PromptMessage 契约已经是 provider 风格多 Part 投影：

- `packages/shared/src/internal-contracts/agent-api-read.ts:118-181`

这证明当前已有“临时多 Part 投影”，但持久化没有层级。

### 工具结果截断规则

当前工具展示文本默认规则：

- 直接保存阈值：8,000 字符；
- 超限后预览：3,000 字符；
- workspace artifact 最大值：200,000 字符；
- `subtask` 不截断。

证据：

- `apps/agent-worker/src/runtime/runner.ts:56-65`
- `apps/agent-worker/src/runtime/runner.ts:533-628`

该策略本期沿用，只迁移到 ToolExecution，并更换 artifact 标识。

### 当前 Fork 是完整复制历史前缀

当前 fork 会复制从会话起点到目标 Item 的所有 ContextItem、附件关系，必要时重建归档状态：

- `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts:79-173`

fork 成本与历史长度线性相关，且不符合共享消息图的目标。

### 当前压缩是归档并写摘要边界

压缩流程当前为：

- 追加归档日志；
- 创建 system 摘要 Item；
- 标记旧 Item `archiveAt`；
- 推进 Session Head。

证据：

- `apps/api/src/modules/agent/compaction/compaction-archive-application.ts:24-102`
- `apps/api/src/modules/agent/agent.store.ts:1524-1663`

压缩与归档文件之间需要补偿逻辑，且归档文件不是精确 transcript 数据源。

### 当前归档搜索是文件 + rg

`archive_search` 通过遍历归档日志文件并调用 `rg` 子进程查询；`archive_read` 逐文件读取并按物理行号分页。归档日志由 `buildArchiveLine()` 生成。

证据：

- `apps/api/src/modules/agent/agent.composition.ts:853-877`
- `apps/api/src/modules/agent/archive/archive-read-storage.ts:40-95`

该方案存在文件滚动、并发一致性、查询语义与数据库不一致等问题。

### 前端增量刷新依赖新增 Item 与非终态 Item 轮询

前端当前通过：

- `afterId` 拉取新增 ContextItem；
- 对非终态 Item 单独轮询；
- head 回退或压缩边界触发 full refresh。

证据：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2630-2741`
- `DisplayItem` 扁平结构：`:927-951`

新模型下，Assistant Message 与 ToolExecution 都是可变对象，因此需要 `updatedRevision` 和 `timelineReset`。

## 当前问题

### 消息层级丢失

Assistant 的 Text、Reasoning、ToolCall 不是同一 Message 内的有序 Part；Provider 请求多 Part 是反向推断出来的临时投影。

### 调用与结果关系不可靠

ToolCall 与 ToolResult 依赖相邻位置与运行字段推断；不满足可审计、可精确恢复的一一关联。

### Reasoning 语义受限

Reasoning 不是独立 Part，无法保留与 Text、ToolCall 的原始交错顺序。

### Fork 与回退成本高且语义混乱

Fork 复制整段前缀；回退移动私有 Head。新模型应让二者都基于共享消息图自然实现。

### 压缩状态写在历史记录上

`archiveAt` 是历史 Item 自身属性，不适合共享消息图。

### 归档搜索依赖文件系统

文件归档不可精确查询，且与数据库分属两个存储边界，需要补偿与 reconcile。

## 改造收益

- 持久化真正表达 Message、Part 与 ToolExecution 关系。
- Fork、回退、压缩、归档和模型请求都从同一权威数据投影。
- 前端可按消息视图实时展示，同时保留轻量轮询。
- 模型错误无限退避重试，符合无人值守任务。
- 工具 unknown 结果交给模型判断，避免 Runtime 过度干预。
- 删除归档文件与 `rg`，降低长期维护成本。
