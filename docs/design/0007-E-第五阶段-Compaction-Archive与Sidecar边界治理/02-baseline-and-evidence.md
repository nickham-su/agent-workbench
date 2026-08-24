# 当前基线与证据

> 本文件记录方案起草时通过只读审计确认的当前事实。除明确标注“目标”或“待 P0 验证”的内容外，不把候选设计写成现状。
>
> 当前基线为 HEAD `0806aae`。P0 只新增最小 API characterization tests；未修改生产代码、Shared contract、DB schema 或 Worker 主控制流。
>
> P0 定向验证已运行 `apps/api` 的 `context-item-contract.test.ts` 和 `agent.integration.test.ts`。测试中为表征故障而触发的 SQLite error 日志属于预期；详细命令与结果见 [`10-implementation-record.md`](./10-implementation-record.md)。

## 当前主调用链总览

```text
manual compact
  → public/internal compact route
  → AgentService.compactSession()
  → create special running run + dedup + run-state transaction
  → route runtime.enqueueRun(inputText="__awb_compact__")
  → Worker Runner sentinel branch
  → Worker one-shot summary
  → internal compact endpoint

Worker auto compact
  → Runner threshold/model/retry decision
  → one-shot summary
  → AgentApiClient.compactContext()
  → internal compact endpoint

clear
  → public clear route
  → AgentService.clearSession()
  → archive append + DB apply + idle state

startup/per-session reconcile
  → module startup trigger or compact/clear preflight
  → pending sidecar best-effort reconcile
```

## Manual compact 当前行为

### API 入口

`agent.routes.ts` 的 public/internal compact route 共享 `handleCompactRequest()`：

- 调用 `AgentService.compactSession()`；
- 仅 `scheduled=true` 时解析 workspace run context；
- enqueue runtime，固定 `inputText="__awb_compact__"`；
- enqueue 抛错时调用 `failRunOnEnqueueFailure()`，再保留原 enqueue error。

`failRunOnEnqueueFailure()` 已是 `RunLifecycleApplication.failRunAfterEnqueueFailure()` 的兼容 facade；Archive 阶段不得复制该条件收敛规则。

### `compactSession()` 前置与事务

同 session 通过 `runSessionOperationExclusive()` 在当前 API 进程内串行。方法首先执行 per-session pending reconcile，然后：

- session 必须存在且属于 workspace；
- subtask session 拒绝，错误码 `AGENT_SUBTASK_READONLY`；
- Worker disabled 拒绝，错误码 `AGENT_WORKER_UNAVAILABLE`；
- `clientRequestId` 必填；
- dedup 命中返回已有 run、`scheduled=false`；
- run-state 必须 idle；
- head 必须存在；
- visible 仅一个 boundary marker 时拒绝 `AGENT_COMPACTION_NOT_NEEDED`；
- 解析 user execution profile。

随后一个 SQLite transaction 写入：

- `createRunRecord(status="running")`；
- `insertClientRequestDedup(...)`；
- `updateRunState(status="running", activeRunId, runNoticeText="正在压缩上下文...")`。

该 transaction 属于 manual compact 调度语义，不是 archive summary/apply transaction。两者不得混淆。

### Worker sentinel

Worker Runner 识别 `__awb_compact__`，生成一次 compaction summary 并调用 compact API，之后通过既有 run complete/fail 主链结束 run。本阶段不改变 sentinel、Runner 控制流或终态写回。

## Worker auto compact 当前行为

Runner 当前：

- 按主模型 `contextWindowTokens × autoCompactThresholdPct` 判断阈值；百分比归一到 `50..99`；
- 可选择 compaction model；已有 token 超过候选窗口时使用主模型；
- 候选模型 context-length error 时最多回退主模型一次；
- one-shot summary 使用 messages-context 提供的 system/input；
- 可重试错误受 `modelRequestMaxRetries` 约束；
- `ApiConflictError` 不作为普通 retry；
- `compacted:false` 不是成功 compact；
- 成功后重新进入模型循环并重新读取上下文。

本阶段仅治理 API apply 边界，Worker 行为作为回归护栏。

## Worker compact apply 当前行为

`AgentService.compactContextFromWorker()` 在同 session 进程内锁中：

- 先执行 per-session pending reconcile；
- 校验 session/workspace；
- 校验 run ownership；
- 在文件写入前对比 `session.headItemId` 与 `expectedHeadItemId`；
- trim 后 summary 必须非空；
- visible 为空或存在非终态 item 时返回：

```json
{ "compacted": false, "summaryItemId": null, "archivedCount": 0 }
```

- 将可归档 visible item 格式化为 archive lines；
- append archive 并取得 snapshots；
- 调用 `appendSystemSummaryAndArchiveItems()`；
- DB 失败时 rollback；skipped 时写 operation=`compaction` 的 pending sidecar；
- `AgentConflictError` 映射为既有 409；
- DB 成功后读取 run-state，仅 activeRunId 仍匹配时清空 `lastResponseTotalTokens`；
- 返回 compact response。

### 已知提交后窗口

`lastResponseTotalTokens=null` 的 run-state 更新发生在 summary/archive DB transaction 提交之后。若该更新失败，archive 文件与 summary/archive DB 可能已成功，而 compact endpoint 仍抛错。P0 必须以定向测试冻结真实传播和 Worker 后续行为，方案不得先假设它是同一事务。

## Clear 当前行为

`AgentService.clearSession()` 同样使用进程内 session lock，并先 per-session reconcile：

- session 必须存在、属于 workspace、不是 subtask；
- run-state 必须 idle，否则 `AGENT_CLEAR_NOT_IDLE`；
- visible 为空时 `AGENT_CLEAR_EMPTY`；
- visible 仅一个 boundary marker 时 `AGENT_CLEAR_NOT_NEEDED`；
- 存在非终态 item 时 `AGENT_CLEAR_NOT_IDLE`；
- append archive lines；
- 调用 `appendSystemSummaryAndArchiveItems()`，`runId=null`、`boundaryReason="clear"`；
- DB transaction 成功后再调用 `setRunStateIdle()`；
- 失败时 rollback，skipped 时写 operation=`clear` sidecar；
- 返回刷新后的 session/runState。

### 已知提交后窗口

`setRunStateIdle()` 位于 summary/archive DB transaction 之后。若它失败，archive/summary 已提交的可能性必须在 P0 冻结。本阶段不得仅为结构整齐把它塞入核心 persistence transaction，除非有新证据和独立设计说明。

## Archive append 当前行为

### 格式与分卷

- 目录由 `agentArchiveSessionDir(dataDir, workspaceId, sessionId)` 生成；
- 文件名为 8 位正整数 `.log`；
- 每文件最多 100 条完整 archive line；
- 当前文件达到上限后递增 sequence；
- append payload 总以换行结束；
- 文件读取会忽略没有尾随换行的最后半行；
- assistant 仅有 tool call、没有自然语言文本时不生成 archive line；
- line 内 CR/LF 使用既有转义规则。

### Snapshot

每个单次操作触达的文件只记录一次：

```ts
{
  (filePath, beforeSize, expectedSize);
}
```

每个 append chunk 成功后累加 `expectedSize`。P2 的 `ArchiveStorage` 使用 `Map` 保存首次触达的文件，返回 snapshots 更接近首次触达/追加顺序；代码没有显式按 `filePath` 排序，本阶段不把返回顺序提升为产品契约，P0 已冻结 rollback 语义不依赖未经证明的排序假设。

### 中途失败已知缺口

`ArchiveStorage.appendLines()` 通过 operation-aware hook 支持 legacy `failAfterChunks` fault；当前只由 fork-with-archive 路径以 `operation="fork"` 触发。Worker compact 与 clear 不触发该 legacy fault，也没有在 append 抛错时接收已写 snapshots 的显式补偿结果。

P0 复核实现及 fork-with-archive 集成回归后确认：

- append helper 可能在若干 chunk 已写入后抛错；
- 该异常发生在调用方取得 snapshots 之前；
- compact/clear 的 DB failure rollback 分支不覆盖这种失败。
- fork-with-archive 通过 composition-root mapping 使 `archiveWrite.failAfterChunks` 仅在 `operation="fork"` 的 append hook 生效；现有回归证明错误向上转换为 `AGENT_FORK_ARCHIVE_FAILED`，并清理新 fork session、context item 与 archive 目录；
- 该 fork 证据没有把“已写的跨文件 chunk 及 snapshots”暴露为可断言结果，不能推导 compact/clear 已有中途写入补偿。

因此，P0 将 compact/clear 的 append 中途失败冻结为**已知缺口**，而不是在没有设计的情况下添加补偿：当前 sidecar 只覆盖“append 已成功返回 snapshots 后，DB apply 失败且 rollback skipped”的窗口。为处理部分写入、跨文件或外部追加而引入 staging/outbox/multi-file 自动 reconcile 超出本阶段 P0 和 `0006` 的非目标；是否存在最小安全修复留待后续专门设计与审查，不能误写成当前行为已恢复。

## 核心 SQLite 原子能力

`appendSystemSummaryAndArchiveItems()` 在单 transaction 中：

- 读取当前 head 并与 `expectedHeadItemId` 对比，不一致抛 `AgentConflictError`；
- 插入 completed system summary item，`prev_id=expectedHeadItemId`；
- 对指定 item ids 且 `archive_at is null` 的行写入 `archive_at/updated_at`；
- head 移到新 summary item；
- touch session；
- 返回 `summaryItemId/archivedCount`。

该能力是本阶段 persistence 权威边界。application 层的前置 head 检查只是早期错误；最终竞态 fence 仍在 transaction 内。

## Rollback 当前行为

DB apply 失败后，调用方将 snapshots 传给 `ArchiveStorage.rollbackBestEffort()`：

- 按 snapshot 逆序处理；
- 可运行 `beforeRollback` fault，当前用于模拟外部追加；
- 对每个文件读取当前 size；
- 仅 `current size === expectedSize` 时 truncate 到 `beforeSize`；
- size 不匹配或文件访问失败则 skipped；
- 返回 reverted/skipped 和 skippedSnapshots；
- rollback 本身不抛出以替代原 DB error。

## Pending sidecar 当前行为

### 写入条件

sidecar 只在：

```text
archive append 已完成
  + DB apply 失败
  + rollback 至少一个 snapshot skipped
```

时尝试写入。sidecar write/rename 失败只 warning，不掩盖原 DB error。

### 写入形态

- 路径为当前 session archive 目录下固定 pending 文件；
- 记录 version、operation、workspace/session/run、snapshots 与 createdAt；
- snapshot file path 转成 session 内 fileKey；
- 先写 tmp，再 rename；
- fault 可注入 write 或 rename 失败。

现有 `context-item-contract.test.ts` 对 write fault 与 rename fault 都断言：固定 sidecar 不存在，且以 `.pending-reconcile.json.<id>.tmp` 形式创建的临时文件会被 catch 内 `rm(..., { force: true })` 清理；原 DB error 保持 HTTP `500` 优先级。该证据只覆盖受控 fault 的清理路径，不把进程崩溃或操作系统级中断描述为已恢复。

### 自动 reconcile 当前事实

`ArchiveStorage.reconcilePendingBestEffort()` 当前返回 `Promise<boolean>`，并在 storage 内部直接记录 warning；它没有返回 `not_found / invalid / size_mismatch / reconciled` 等结构化状态。

| 条件                                          | 当前返回与副作用                                  |
| --------------------------------------------- | ------------------------------------------------- |
| sidecar 不存在                                | 返回 `false`，不记录 warning                      |
| sidecar 读取失败（非 `ENOENT`）               | helper 内 warning，返回 `false`                   |
| JSON/结构非法或 workspace/session 不匹配      | helper 内 warning，返回 `false`，保留 sidecar     |
| snapshots 数量不是 1                          | helper 内 warning，返回 `false`，保留 sidecar     |
| fileKey 无法解析到当前 session archive 文件   | helper 内 warning，返回 `false`，保留 sidecar     |
| archive 文件不存在、stat/truncate/remove 失败 | helper 内 warning，返回 `false`，保留 sidecar     |
| current size 不等 expectedSize                | helper 内 warning，返回 `false`，保留 sidecar     |
| 单文件 exact-size                             | truncate 到 beforeSize，删除 sidecar，返回 `true` |

多文件 sidecar 不自动 truncate 是已冻结安全边界，不是待修 bug。

若后续 adapter 引入结构化 reconcile 结果，那属于目标设计，用于改善调用侧诊断，不是对当前 helper 返回值的描述。

## Reconcile 当前入口

### Per-session

以下操作在同 session lock 内先执行 best-effort reconcile：

- `compactSession()`；
- `compactContextFromWorker()`；
- `clearSession()`。

当前 per-session facade 直接返回该 boolean；invalid、size mismatch、I/O failure 等 warning 已由 helper 内部记录。调用方不解析失败原因，也不因返回 `false` 阻断本次 compact/clear。

### Startup

`AgentService.reconcileAllArchivePendingBestEffort()`：

- 通过 `listAgentSessionsForArchiveReconcile()` 按 session 创建顺序枚举所有 session；
- 每个 session 单独 try/catch；
- 单 session 失败 warning 后继续。

`agent.module.ts` 在 routes 注册后依次：

```text
Subtask orphan cleanup
  → Archive pending reconcile
  → Lifecycle fail/recover setup
  → Worker manager start
```

module 对整个 Archive reconcile 还有顶层 try/catch。

## Session operation lock 当前边界

`runSessionOperationExclusive()` 使用当前 `AgentService` 实例内的 promise queue：

- 同一进程、同一 service 实例、同一 session 的 compact/clear 操作串行；
- 不覆盖多 API 进程/实例；
- 不覆盖外部直接写 archive 文件；
- 不构成文件锁或 DB lease；
- sidecar exact-size 检查仍是遇到外部变化时的保守保护。

任何文档或实现不得把它描述为跨进程线性化保证。

## `AgentTestFaults` 当前形态

`AppContext` 暴露：

```ts
archiveWrite?: { failAfterChunks?: number } | null
archiveRollback?: { appendBeforeRollback?: string } | null
archiveSidecar?: { failWrite?: boolean; failRename?: boolean } | null
```

当前 archive fault 的生产读取集中在 `AgentService`，但通过完整 `AppContext` 可达：

- `archiveWrite` 当前用于 fork-with-archive append fault；
- `archiveRollback` 用于 compact/clear DB failure 后、rollback 前模拟外部追加；
- `archiveSidecar` 用于 compact/clear sidecar write/rename failure。

这不是全仓散落的任意开关，但依赖面仍过大。本阶段目标是迁移为 Archive 组件级受控 hook，而不是新增更多 `ctx.agentTestFaults` 字段。由于 fork-with-archive 也依赖 archive append fault，只有该路径与其他复用 append primitive 的路径都完成窄 hook 接线后，相关 `AppContext` archive fault 字段才允许删除；此前只能由 composition root 将既有测试配置映射为窄 hook。

## Archive search/read 当前行为与合同状态

调用链：

```text
Worker builtin archive_search/archive_read
  → AgentApiClient 字面量 POST path
  → API internal route 内联 TypeBox schema
  → AgentService archiveSearchFromWorker/archiveReadFromWorker
  → archive filesystem
```

当前：

- compact endpoint 已进入 Shared internal contract；
- archive search/read 未进入 Shared endpoint/schema registry；
- Worker client 使用字面量 path 和局部 request/response type；
- builtin 对 beforePos、maxHits、lineCount、maxChars、snippet/regex 做参数校验；
- API 提供 noArchive、newest-first、`pos`、字符截断、regex/snippet 等既有语义。

本阶段可以整理文件实现归属，但 Shared contract 统一明确排除。

## Compaction snippet 当前行为

当 visible 中存在 completed compaction boundary marker 时，P0 复核 prompt 路径确认：

- 读取 transcript，并在存在至少一个 compaction boundary 时计算全局最大的 `archiveAt`；
- 对每个 compaction boundary 先尝试读取以 summary item id 为键的 tmp snippet cache；
- cache miss 时按该全局最新 `archiveAt` 的 archived item ids，从 archive 文件反查摘录；当前若可见上下文中存在多个 compaction boundary，它们会共享这一 fallback batch，而不是各自按 summary item 的创建时间选择；
- 生成本地化 snippet system message；
- best-effort 写入 cache；
- cache/read/write 失败不阻断 prompt；
- 无可定位 archive 行时不强行注入。

当前 archive excerpt、cache 和 prompt 组装都在 `AgentService`，但目标责任必须分开：Archive 提供摘录，Read-side 决定注入。

## P0 实测的提交后失败边界

P0 在真实 SQLite fixture 上用临时 trigger 分别使 post-commit run-state upsert 失败。两个 run-state 写入都发生在 summary/archive transaction 之后，但 catch 边界不同：

| 用例                            | 注入点                                                    | HTTP 结果                          | 已提交 DB 状态                                                                                      | archive/sidecar 后果                                                                                                    |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Worker compact                  | token cleanup 将 `last_response_total_tokens` 写为 `null` | `500`，保留原 SQLite trigger error | 原 visible item 已 `archiveAt`、head 已指向 compaction summary、archive file 保留；token 数仍为旧值 | 不 rollback archive、不写 pending sidecar                                                                               |
| clear（snapshot exact-size）    | `setRunStateIdle()` 的 run-state upsert                   | `500`，保留原 SQLite trigger error | 原 visible item 已 `archiveAt`、head 已指向 clear marker                                            | 因 idle 写入仍在 clear 的 `try` 内，进入 catch；archive append 被 truncate 回 append 前（新文件内容为空），不写 sidecar |
| clear（rollback size mismatch） | 同上，且 rollback 前注入外部追加                          | `500`，保留原 SQLite trigger error | 原 visible item 已 `archiveAt`、head 已指向 clear marker                                            | catch 尝试 rollback；exact-size 证明失效后保留 archive 内容，并写入 `operation="clear"` 的单文件 pending sidecar        |

这不是要求把 post-commit 写入并入 summary/archive transaction。P0 冻结的现状是：compact token cleanup 在 archive DB failure catch **之外**；clear idle write 在 catch **之内**，所以会对已提交 DB marker 与可回滚 archive 文件产生不对称状态。该现有一致性窗口不得在 P0 擅自修复；后续 P3 迁移 clear 主写链时必须显式保留或经独立设计改变这条错误顺序，并用真实 fs + SQLite 证据审查。Worker 在收到 compact API 错误后的 retry/终态路径仍由 Worker 既有测试与 P4 回归护栏覆盖，P0 未改变 Worker 控制流。

## 已有测试证据地图

### Shared

`packages/shared/tests/internal-contracts.test.ts` 静态可见覆盖 compact endpoint/schema 与 bare success response。

### API contract/persistence

`apps/api/src/modules/agent/context-item-contract.test.ts` 静态可见覆盖：

- compact success shape 与 token usage 清理；
- P0 新增：compact token cleanup trigger failure 后 summary/archive 已提交、响应为 `500`、token 保持旧值且不 rollback/sidecar；
- P0 修正并补强：clear idle-state trigger failure 后 DB summary/marker 已提交、响应为 `500`，但 exact-size archive append 会 rollback 到 append 前且不写 sidecar；
- P0 新增：clear idle-state failure 若 rollback 前发生外部追加，则 archive 保留、写入 `operation="clear"` pending sidecar；
- empty/non-terminal 的 `compacted:false`；
- stale head conflict；
- DB failure rollback；
- rollback skipped → pending sidecar；
- sidecar write/rename failure 不掩盖原错且不遗留受控 tmp sidecar；
- per-session reconcile 与 single-file exact-size。

### API integration

`apps/api/src/modules/agent/agent.integration.test.ts` 静态可见覆盖：

- startup reconcile；
- manual compact；
- clear；
- archive search/read；
- archive 格式、分卷、pos、半行；
- compaction snippet 与 cache miss 重建。

### Worker

`apps/agent-worker/src/runtime/runner.auto-compact.test.ts` 静态可见覆盖阈值、模型选择/fallback、one-shot summary、retry、conflict、`compacted:false` 与成功后状态行为。

## P0 必须重新验证的缺口

- compact/clear append 中途失败的部分写入状态与错误传播；
- compact token cleanup failure 与 clear idle-state failure 的 API/DB/archive 行为已由 P0 trigger characterization 冻结；clear 的 DB marker 与 archive 文件可出现不对称结果，P3 必须审查其迁移是否保持或以独立设计改变。Worker 是否 retry、是否造成第二次 compact/conflict仍需在 Worker/API 跨层迁移回归中持续观察；
- `archiveWrite` fault 是否应仅迁入 storage hook，且 fork/compact/clear 如何按用例选择注入；
- single/multi-file sidecar、path/symlink/no-follow 安全的真实临时文件证据是否完整；
- process-local lock 与 route/runtime 并发测试能证明什么、不能证明什么；
- search/read/snippet 迁移后应保留的精确测试索引和日志边界。
