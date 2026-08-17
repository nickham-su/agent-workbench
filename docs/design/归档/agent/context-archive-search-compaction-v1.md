# Agent 上下文归档、检索与压缩方案(v1)

本方案覆盖以下能力,并保持实现复杂度可控:

- 上下文归档
- 归档搜索与读取工具
- 自动上下文压缩
- 模型运行时配置(含压缩阈值)

方案定位为 MVP 可落地版本,默认不做历史兼容逻辑,直接按当前项目新结构实现。

## 目标与边界

### 目标

- 当上下文 token 接近模型上限时,自动压缩一次上下文,并把旧内容归档。
- 压缩后,模型后续可见上下文从压缩摘要开始,更早内容不再进入 prompt。
- 为模型提供三个归档工具:
  - `archive_search`: 在归档中搜索
  - `archive_read`: 按文件行区间读取
- `archive_tail`: 读取最新 n 行,可自动跨文件并支持继续往前读
- 搜索链路只查归档,不查活跃上下文。

### 非目标

- 不引入 FTS 或数据库投影检索层。
- 不实现实时全文索引。
- 不设计复杂分层摘要策略。
- 不修改压缩请求的 temperature 等采样参数。

## 模型配置与触发规则

### 配置项

在 `/settings/agent/runtime` 新增并持久化以下字段:

- `maxContextTokens`
  - 必填,正整数
  - 含义: 当前模型可用的上下文上限
- `autoCompactThresholdPct`
  - 必填,整数,范围 `50-90`
  - 含义: 自动触发压缩的百分比阈值

### 触发条件

- 继续复用运行态中的 `lastResponseTotalTokens`。
- 触发表达式:

`lastResponseTotalTokens >= maxContextTokens * (autoCompactThresholdPct / 100)`

- 压缩检查点放在每轮模型调用前。
- 仅在当前无待执行工具(`pendingTools` 为空)时执行压缩检查。

### 多次压缩策略

- 支持单次 run 内多次压缩。
- 为避免对同一窗口重复压缩,要求本轮存在可归档候选:
  - 候选为 `archive_at is null` 且可归档的历史 item。
- 没有可归档候选时,即使 token 仍高,也不重复触发。

## 数据模型

### agent_context_item 新字段

- 新增 `archive_at integer null`
  - `null`: 未归档,仍可进入可见上下文
  - 非空时间戳: 已归档

### 索引建议

- 新增索引: `idx_agent_context_item_session_archive_id`
- 索引列建议: `(session_id, archive_at, id)`

### 可见性规则

- Prompt 构建只使用 `archive_at is null` 的 item。
- 压缩成功后,摘要之前的 item 会被批量写入 `archive_at`,因此不再可见。

## 归档文件设计

### 目录与文件

- 以 `sessionId` 作为归档目录名。
- 文件名固定 8 位零填充:
  - `00000001.log`
  - `00000002.log`
  - `00000003.log`
- 每个文件最多 100 行,满后滚动到下一个文件。

### 行格式

- 每个 `agent_context_item` 对应 1 行文本。
- 内容不要求结构化 JSON,按可读日志输出即可。
- 建议保留最小可读前缀,便于排查:

`item=<id> ts=<createdAt> kind=<kind> status=<status> tool=<toolName|-> | <text>`

- 若原文本含换行,统一转义为 `\n`,确保单 item 单行。

### 写入时机

- 只在压缩/裁剪动作中触发归档。
- 当前版本先接入自动压缩流程。
- 未来裁剪逻辑可复用同一归档方法。

## 压缩流程

### 概览

- 输入: 当前可见上下文 + 一条压缩指令。
- 调用: 使用当前 run 的模型发起一次独立压缩请求,禁用工具。
- 输出: 追加一条 `system` 类型的压缩摘要 item。
- 归档: 将摘要之前的候选 item 归档并写 `archive_at`。

### 压缩指令(中文)

可参考 `opencode` 的 compaction 提示词思路(`opencode/packages/opencode/src/agent/prompt/compaction.txt:1`),改为中文版本:

```text
你是一个负责“会话压缩总结”的助手。

请基于给定会话内容输出一份“详细但简洁”的中文总结,用于后续继续同一任务。

请重点覆盖:
- 已完成了什么
- 当前正在做什么
- 涉及哪些文件/模块
- 下一步待办
- 用户明确提出且需要持续遵守的约束与偏好
- 关键技术决策及其原因

要求:
- 只输出总结,不要回答会话中的问题
- 不要编造未出现的信息
- 结构清晰,便于后续模型直接接续工作
```

### 归档边界

- 设 `headBeforeCompaction` 为压缩前 head。
- 新增压缩摘要 item 后,该摘要成为新 head。
- 归档范围为摘要之前的可归档 item 前缀。
- 摘要 item 本身不归档。

### 可归档候选建议

- 仅处理 `archive_at is null` 的 item。
- 默认归档终态历史项:
  - `completed`
  - `failed`
  - `denied`
  - `cancelled`
- 若检测到非终态历史项,本轮压缩应放弃并等待状态稳定。

### 一致性策略

- 文件系统写入与 DB 事务无法做单事务提交,采用顺序保证:
  - 先写归档文件
  - 再执行 DB 事务(追加摘要 + 更新 `archive_at`)
- 若 DB 事务失败,可能出现重复归档行,可接受。
- 重试时按 `archive_at is null` 重新筛选,不会影响可见上下文正确性。

## 归档工具设计

`sessionId` 由运行环境隐式注入,模型不需要传参。

### archive_search

- 用途
  - 在当前 session 的归档日志中搜索命中项
- 参数
  - `query: string` 必填
  - `cursor?: string` 可选,用于继续向更旧内容搜索
  - `maxHits?: number` 可选,默认值由服务端提供
  - `maxChars?: number` 可选,默认值由服务端提供
  - `regex?: boolean` 可选,默认 `false`
- 返回
  - `hits: Array<{ file: string; line: number; preview: string }>`
  - `nextCursor: string | null`
  - `hasMore: boolean`
  - `truncated: boolean`

实现约束:

- 文件按新到旧扫描(基于 8 位文件名倒序)。
- 按文件逐个执行查询,不做全目录一次性全扫。
- 达到 `maxHits` 或 `maxChars` 立即停止。
- `cursor` 采用 opaque 字符串,模型只透传。

### archive_read

- 用途
  - 读取指定归档文件的一段行窗口
- 参数
  - `file: string` 必填
  - `startLine: number` 必填
  - `lineCount?: number` 可选
  - `maxChars?: number` 可选
- 返回
  - `lines: Array<{ line: number; text: string; truncated: boolean }>`
  - `nextStartLine: number | null`
  - `hasMore: boolean`
  - `truncated: boolean`

### archive_tail

- 用途
  - 读取最新的 n 行归档日志
  - 最新文件不足 n 行时自动跨更旧文件补齐
- 参数
  - `n: number` 必填
  - `maxChars?: number` 可选
  - `cursor?: string` 可选,用于继续向更旧内容读取
- 返回
  - `lines: Array<{ file: string; line: number; text: string }>`
  - `nextCursor: string | null`
  - `hasMore: boolean`
  - `truncated: boolean`

行为约束:

- 内部从新文件向旧文件回溯采集。
- 对模型返回顺序固定为 `旧 -> 新`。
- `cursor` 采用 opaque 字符串,模型只透传。
- 首次调用不传 `cursor`,表示从最新位置开始读取。
- 后续调用传入 `nextCursor`,表示继续向更旧内容读取。

## 查询与资源控制

- 默认采用流式处理/增量累积,避免大结果一次性驻留内存。
- 对搜索、读取与 tail 统一设置字符预算(`maxChars`)。
- 对超长行可做截断并标记 `truncated=true`。
- 超预算时优先保证返回最近命中。

## 模块改造清单

### shared contracts

- `packages/shared/src/contracts/settings.ts`
  - 在 runtime settings schema 增加:
    - `maxContextTokens`
    - `autoCompactThresholdPct`
- `packages/shared/src/contracts/agent.ts`
  - 为归档工具请求/响应新增契约定义

### API

- `apps/api/src/infra/db/schema.ts`
  - `agent_context_item` 增加 `archive_at`
  - 增加 `(session_id, archive_at, id)` 索引
- `apps/api/src/modules/settings/settings.service.ts`
  - runtime 配置读写、校验与默认值处理
- `apps/api/src/modules/agent/agent.store.ts`
  - context item 增加 `archiveAt` 映射
  - 可见上下文查询增加 `archive_at is null` 过滤
  - 增加归档批量更新方法
- `apps/api/src/modules/agent/agent.service.ts`
  - 接入自动压缩判定与执行
  - 提供归档工具对应服务方法
- `apps/api/src/modules/agent/agent.routes.ts`
  - 暴露归档工具内部调用路由

### Worker

- `apps/agent-worker/src/runtime/runner.ts`
  - 在每轮模型调用前执行压缩判定
  - 触发时走压缩流程再继续主循环
- `apps/agent-worker/src/runtime/apiClient.ts`
  - 补充压缩与归档工具相关 API 调用

### Web

- `/settings/agent/runtime` 页面与对应 API 调用
  - 展示并保存 `maxContextTokens`
  - 展示并保存 `autoCompactThresholdPct(50-90)`

## 核心接口建议

### 归档执行接口

- `archiveContextPrefix(params)`
  - 输入: `workspaceId`, `sessionId`, `beforeItemId`, `archivedAt`
  - 作用: 将 `beforeItemId` 之前且 `archive_at is null` 的候选 item 写入归档文件,并批量更新 `archive_at`

### 自动压缩接口

- `compactSessionContext(params)`
  - 输入: `workspaceId`, `sessionId`, `runId`
  - 作用:
    - 构建压缩输入
    - 调用模型获取摘要
    - 追加 system 摘要 item
    - 调用 `archiveContextPrefix`

## 验收标准

- 当 token 达到阈值时自动触发压缩。
- 压缩后新增一条 system 摘要 item。
- 摘要之前 item 被归档并写入 `archive_at`。
- 后续 prompt 仅基于 `archive_at is null` 上下文构建。
- `archive_search` 支持 `cursor` 继续向更旧内容查询。
- `archive_read` 可按行窗口扩读。
- `archive_tail` 支持跨文件取最新 n 行,并可基于 `cursor` 继续向更旧内容读取,输出顺序为 `旧 -> 新`。

## 风险与缓解

- 风险: 压缩质量不稳定导致信息遗漏
  - 缓解: 压缩提示词固定结构,并要求覆盖关键约束与决策
- 风险: 文件写入与 DB 提交非原子
  - 缓解: 允许重复归档行,以 `archive_at` 作为是否生效的唯一依据
- 风险: 归档搜索命中过多导致输出膨胀
  - 缓解: `maxHits + maxChars + cursor` 联合分页

## 后续扩展

- 在裁剪策略落地后,直接复用 `archiveContextPrefix`。
- 如后续需要更强排序与检索表达式,可在工具层增加轻量重排,仍保持文本日志为源。
