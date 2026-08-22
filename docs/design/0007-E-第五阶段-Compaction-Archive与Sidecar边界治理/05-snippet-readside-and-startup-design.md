# Snippet、Archive Read 与 Startup 边界设计

> 最终实施状态：已落地 `ArchiveReadApplication` / `ArchiveReadStorage`、`CompactionSnippetCache` 与 `ArchiveStartupReconcileApplication`；P0-P5 及新审查员全面独立终审均已完成，终审结论通过。snippet 的 prompt 语义仍由 Read-side facade 保留，archive excerpt 继续为窄数据能力；`ArchiveReadStorage` 的复杂 read/search 语义更多依赖 integration 护栏属于可接受差异，不构成阻断。

## 设计目标

本文件定稿三个容易在结构迁移中形成反向依赖的边界：

- compaction snippet 的 Archive 与 Read-side 协作；
- archive search/read 的实现归属与 transport 合同边界；
- startup archive reconcile 的 use-case 与 module 触发边界。

目标不是把三者塞进同一“大 Archive service”，而是让它们共享安全的 filesystem/read capability，同时保持各自业务 owner。

## Compaction snippet 当前责任拆解

当前 `buildPromptMessagesForSession()` 同时承担：

- 检测 visible compaction boundary marker；
- 读取 transcript 和最新 archiveAt；
- 读取/写入 snippet cache；
- 从 archive 文件按 item ids 反查摘录和 minPos；
- 选择 zh-CN/en-US 模板；
- 将 snippet system message 插入 prompt messages。

目标拆解：

```text
Read-side / Prompt application
  ├─ detect compaction boundary
  ├─ choose archive batch/item ids
  ├─ decide insertion position
  ├─ render localized snippet message
  └─ best-effort degradation

ArchiveExcerptReader
  └─ item ids / archive batch → excerpt lines + minPos

CompactionSnippetCache
  ├─ read best-effort
  └─ write best-effort
```

## 依赖方向

```text
ReadSideApplication
  → ArchiveExcerptReader
  → CompactionSnippetCache
  → prompt templates

ArchiveExcerptReader
  → ArchiveReadStorage

禁止：
ArchiveStorage/Application → ReadSideApplication
ReadSideApplication → CompactionArchiveApplication
ArchiveExcerptReader → prompt templates/full PromptMessage
Route → snippet cache/archive files
```

`ArchiveExcerptReader` 可以作为 Archive read adapter 的窄接口；它只返回数据，不返回最终 prompt message。

## Snippet 行为冻结

迁移后必须保持：

- 仅 completed system `boundaryReason="compaction"` 且 system text 可进入 prompt 时考虑 snippet；
- 无 compaction boundary 时不读取 transcript/archive/snippet cache；
- cache key 继续由 workspace/session/summary item 唯一定位；
- cache 不是权威数据，miss 时可即时重建；
- cache read/write 失败不阻断 prompt；
- excerpt 仅来自与最新 archiveAt 批次匹配的 archived item ids；
- 无 archive item ids、无匹配 archive lines 或 excerpt 为空时不强行注入；
- `minPos` 与 archive tool 提示语义不变；
- zh-CN/en-US 模板行为不变；
- snippet 插入顺序不改变 visible message 的既有投影。

## Snippet cache 归属

snippet cache 位于 tmp，而非 archive 权威目录。阶段设计默认：

- Read-side 拥有“是否使用 cache”和 best-effort 策略；
- 独立 `CompactionSnippetCache` capability 负责 tmp path、安全读取、大小上限、no-follow 与原子写；
- Archive storage 不负责 cache 生命周期；
- terminal/read-side cache invalidation 不因本阶段改变；
- 不将 snippet 写入 archive 文件或 DB。

如果为最小改动暂时由 Archive adapter实现 cache I/O，consumer interface 仍必须独立，且实施记录说明这是装配复用而非责任合并。

P4 实际采用独立 `CompactionSnippetCache`。`AgentService.buildPromptMessagesForSession()` 作为现有 Read-side facade 继续决定 cache 是否读取、miss 时的 archived batch/item-id 选择、locale/template 与插入位置；cache 不读取 archive，`ArchiveStorage.findExcerptByItemIds()` 不生成 prompt message。

## Archive search/read 实现归属

### 当前 transport

```text
BuiltinToolProvider
  → AgentApiClient.archiveSearch/archiveRead
  → literal internal routes
  → AgentService
```

### 目标实现

```text
Internal Archive Routes
  → AgentService thin facade
  → ArchiveReadApplication/ArchiveReadStorage
      ├─ safe file listing
      ├─ complete-line reading
      ├─ search/read projection
      └─ maxChars/noArchive/pos formatting
```

search/read 的 query normalization 可位于 read application；filesystem 与 path policy 位于 storage。

### 本阶段明确排除的合同工作

- 不新增 `AgentApiEndpoints.archiveSearch/archiveRead`；
- 不新增 Shared request/response schema；
- 不改 Worker `AgentApiClient` 字面量 path；
- 不改 builtin tool schema/name；
- 不统一 error envelope；
- 不新增分页 cursor；
- 不改变 body limit。

### 必须冻结的 read 语义

- beforePos 必须大于等于 2；
- maxHits `1..100`；
- lineCount `1..200`；
- maxChars `1000..10000`；
- fixed/regex 与 snippet 模式；
- newest-first 结果；
- `pos` 以完整 archive line 的稳定位置表示；
- beforePos 的 older-than 过滤；
- `noArchive`；
- 字符截断 marker；
- 无尾换行最后半行忽略；
- 非法 regex/参数的既有错误行为。

P4 实际采用 `ArchiveReadApplication` 承接 session ownership、参数范围与 HTTP 映射，`ArchiveReadStorage` 承接 fs/rg 和 projection；`AgentService.archiveSearchFromWorker()` / `archiveReadFromWorker()` 是兼容委托。Shared endpoint、Worker client/builtin、payload 与 response shape 均未改动。

## Startup reconcile 设计

### 当前事实边界

当前 per-session reconcile helper 返回 boolean，并在 helper 内部直接记录 invalid、multi-file、file-key、size mismatch 与 I/O failure 等 warning；startup 循环不接收结构化失败原因，也没有当前 summary 结果对象。

### 目标 use-case

后续候选：

```ts
reconcilePendingOnStartup(command?: { now?: number }): Promise<{
  scanned: number;
  reconciled: number;
  notFound: number;
  invalid: number;
  sizeMismatch: number;
  failed: number;
}>;
```

以上结构化计数属于目标设计，不是当前代码事实。实际 summary 可以简化，甚至只保留可测试计数与日志责任，但 use-case 应拥有：

- session candidate enumeration；
- 逐 session 调用 `reconcilePendingForSessionBestEffort()`；
- 单 candidate failure isolation；
- warning 与可诊断 summary；
- 不读取 sidecar 内容实施额外领域规则。

### Persistence/query 边界

`listAgentSessionsForArchiveReconcile()` 可封装为窄 `ArchiveReconcileCandidateQuery`：

- 只返回 workspaceId/sessionId；
- 顺序保持 createdAt/id；
- 不把完整 session/store 暴露给 startup use-case；
- 不因当前没有 sidecar index 而新增 DB schema。

### Module 边界

module 只负责：

- 构造 Archive storage/application；
- 注册 routes；
- 调用 archive startup use-case；
- 对整个 use-case 做顶层 failure isolation；
- 维持现有相对启动顺序。

module 不得：

- 枚举 sessions；
- 读取/解析 sidecar；
- 判断 single/multi-file；
- stat/truncate 文件；
- 组合 rollback policy；
- 将 Archive、Subtask、Lifecycle startup 合并成全能 service。

P4 实际采用 `ArchiveStartupReconcileApplication`：其窄依赖只有 candidate query、per-session reconcile 与 logger；`agent.module.ts` 只构造并调用 use-case，未读取 sidecar 或编码 rollback policy。

### 相对顺序

本阶段默认保持：

```text
register routes
  → Subtask cleanupOrphansOnStartup()
  → Archive reconcilePendingOnStartup()
  → Lifecycle fail/recover setup
  → Worker manager start
```

若实现在不改变行为的前提下引入显式 startup coordinator，只能做顺序调用和顶层隔离，不得吸收三个域的内部规则。最终统一 composition 形态仍可留到 Session/Routes/Module 收尾。

## Per-session 与 Startup 的关系

当前两者复用同一返回 boolean 的 `reconcilePendingForSessionBestEffort()`，但触发语义不同：

- per-session：compact/clear 前的局部 best-effort 清理，位于 session serialization 内；
- startup：枚举所有 session，单 candidate 失败继续。

不得让 startup 为每个 session调用完整 compact/clear application，也不得让 per-session 操作扫描全部 sessions。

## Failure isolation 与日志

### Snippet

- cache/excerpt failure：默认降级为空 snippet；
- 只记录 ids、错误，不记录 archive 正文；
- 不阻断 prompt context。

### Archive read tools

- 保持既有 HTTP error/noArchive 区分；
- 不记录 query 命中正文；
- rg/fs error 按既有映射，P0 冻结。

### Startup reconcile 目标日志边界

- 单 session failure warning 后继续；
- 整体 use-case error 由 module 顶层 warning；
- warning 不包含 sidecar/archive 内容；
- 当前 invalid/size mismatch warning 位于 helper 内；若目标 adapter 改用结构化结果并上移日志责任，必须避免重复 warning，也不得静默降低诊断性。

## Wiring 验收

- Read-side 只依赖 `ArchiveExcerptReader`/snippet cache，不依赖 write application；
- Archive write application 不依赖 Read-side；
- archive search/read route 不直接使用 fs；
- Shared contract 文件无 archive search/read 新增；
- module 不 import archive path/fs/store policy helper；
- startup relative order 有 wiring test；
- snippet cache/excerpt failure 仍为 best-effort；
- search/read 外部合同与 Worker builtin 行为不变。
