# 代码地图与候选改动面

> 路径和符号基于 HEAD `0806aae` 的方案起草基线。行号会变化，P0 与每批实施前必须重新搜索。
>
> P0-P5 实施、facade/store/module 残留与依赖方向审计及新审查员全面独立终审均已完成；终审结论通过。本文记录阶段最终代码地图。

## 端到端调用链

### Manual compact

```text
public/internal compact route
  → AgentService.compactSession()
  → session lock → ManualCompactionApplication.schedule()
  → reconcile → run/dedup/run-state transaction → runtime.enqueueRun(__awb_compact__)
  → enqueue failure → RunLifecycleApplication failure bridge
  → Worker AgentRunner manual sentinel
  → one-shot summary
  → AgentApiClient.compactContext()
  → internal compact route → AgentService.compactContextFromWorker()
  → session lock → CompactionArchiveApplication.applyWorkerCompaction()
```

### Auto compact

```text
Worker AgentRunner normal model loop
  → shouldAutoCompact()
  → select/generate compaction summary
  → AgentApiClient.compactContext()
  → internal compact route
  → AgentService facade/session lock → CompactionArchiveApplication
  → reconcile → archive append → named SQLite transaction
  → Worker resumes loop / run finalization
```

### Clear

```text
public clear route
  → AgentService.clearSession() facade/session lock
  → CompactionArchiveApplication.clearSession()
  → reconcile → archive append → summary/archive DB transaction
  → setRunStateIdle
```

### Reconcile

```text
module startup
  → ArchiveStartupReconcileApplication.reconcileAllPendingBestEffort()

manual compact / Worker compact / clear
  → runSessionOperationExclusive()
  → CompactionArchiveApplication.reconcilePendingForSessionBestEffort()
  → Worker compact/clear use-case
```

### Archive read / snippet

```text
internal archive route → AgentService facade → ArchiveReadApplication → ArchiveReadStorage
prompt Read-side facade → CompactionSnippetCache + ArchiveStorage.findExcerptByItemIds()
```

P4 新增：`compaction/manual-compaction-application.ts`、`archive/archive-read-application.ts`、`archive/archive-read-storage.ts`、`archive/compaction-snippet-cache.ts` 与 `archive/archive-startup-reconcile-application.ts`。`ArchiveStorage` 与 `SqliteCompactionArchivePersistence` 继续分别拥有文件和单事务边界。

## Shared contract

### `packages/shared/src/internal-contracts/agent-api-context.ts`

当前：

- `AgentApiCompactContextRequestSchema`；
- `AgentApiCompactContextResponseSchema`。

目标：原则上无生产变更。application可在boundary使用Shared DTO，内部port不必完全由transport类型驱动。

### `packages/shared/src/internal-contracts/agent-api.ts`

当前注册 `compactContext` endpoint。

目标：保持。

### `packages/shared/tests/internal-contracts.test.ts`

当前静态可见覆盖 compact endpoint/schema/bare success。

目标：保持，不新增archive search/read Shared合同。

## API context 与 composition

### `apps/api/src/app/context.ts`

当前：

- `AgentTestFaults.archiveWrite`；
- `archiveRollback`；
- `archiveSidecar`；
- `AppContext.agentTestFaults`。

最终状态：`agent.module.ts` 是唯一 legacy archive fault mapping 点，使用 `archiveFaultHookFromLegacyTestFaults(ctx.agentTestFaults)` 构造 `ArchiveStorage`。`AgentService` 不直接读取 archive fault。`AppContext.agentTestFaults` 尚未删除，是因为 fork-with-archive 仍复用 legacy `archiveWrite.failAfterChunks`，其删除条件尚未满足；当前通过 operation metadata 等价接线并在 composition root 隔离，属于终审接受的非阻断取舍。

## API Route

### `apps/api/src/modules/agent/agent.routes.ts`

当前入口：

- public compact；
- internal compact session；
- public clear；
- Shared internal context compact；
- literal internal archive search/read；
- `handleCompactRequest()`执行schedule + runtime enqueue + Lifecycle failure facade。

目标：

- 保持transport/auth/schema/status；
- compact/clear/internal compact薄转发；
- manual compact route只调用显式application/use-case，不再执行schedule、runtime enqueue或enqueue-failure sequencing；
- 不import Store/ArchiveStorage；
- search/read path/body/response不变；
- 本阶段不拆route文件。

## API Module

### `apps/api/src/modules/agent/agent.module.ts`

P2 当前：

- 构造 `ArchiveStorage`、`SqliteCompactionArchivePersistence` 与 composition-root fault hook；
- 将它们注入 `AgentService`；
- 注册routes；
- 触发Subtask orphan；
- await Archive reconcile；
- 配置Lifecycle fail/recover；
- 启动Worker。

后续目标：

- 迁入 explicit Archive application/startup use-case；
- module只触发Archive startup use-case并顶层隔离；
- 保持relative order；
- 不读sidecar/fs/store policy；
- 不强制建立全能startup coordinator。

## `AgentService` 当前核心符号

### Archive constants/helpers

P2 当前：

- `ArchiveStorage`（`archive/archive-storage.ts`）：append/snapshot、rollback、pending sidecar、reconcile、excerpt；
- `SqliteCompactionArchivePersistence`（`archive/sqlite-compaction-archive-persistence.ts`）：named SQLite transaction adapter；
- `archive/archive-fault-hook.ts`：metadata-only hook 与 composition-root legacy mapping；
- `archive/*.test.ts`：直接针对真实 adapter 的文件、SQLite 与 wiring 测试；
- `buildArchiveLine()`；
- search/read formatting helpers。

P2 已删除 `appendArchiveLines()`、sidecar/reconcile/rollback helpers 及 `__archiveTestSupport`；`AgentService` 通过 injected adapter 维持既有调用顺序。search/read endpoint 实现仍暂留 facade，留待 P4。

### Snippet helpers

当前：

- `buildCompactionSnippetMessageText()`；
- `readCompactionSnippetCacheBestEffort()`；
- `writeCompactionSnippetCacheBestEffort()`；
- `buildCompactionSnippetExcerptLines()`；
- `buildPromptMessagesForSession()`内的compaction boundary逻辑。

目标：

- message/render/insertion留Read-side；
- cache迁窄capability；
- P2 已将 item-id excerpt 迁入 `ArchiveStorage`；
- cache与 facade snippet 组装仍留 P4。

### Reconcile facade

当前：

- `reconcileArchivePendingForSessionBestEffort()`；
- `reconcileAllArchivePendingBestEffort()`。
- per-session helper返回boolean，invalid/size mismatch/I/O等warning由helper内部直接记录；
- startup循环没有结构化结果或summary对象。

P2 当前：per-session reconcile 已委托 `ArchiveStorage.reconcilePendingBestEffort()`；startup 循环和结构化 result/summary 的 owner 仍留 P3/P4。

### Manual compact

当前：

- `compactSession()`；
- `runSessionOperationExclusive()`；
- profile/dedup/session/run-state Store调用；
- `failRunOnEnqueueFailure()`兼容Lifecycle facade。

目标：

- validation/scheduling/runtime enqueue/enqueue-failure bridge sequencing统一迁application/use-case；
- run/dedup/state迁named persistence；
- serializer作为窄collaborator；
- application通过RuntimeControl与Lifecycle窄capability协作；route只保留transport；
- 最终目录/facade形态可后置，但orchestration owner在本阶段定稿。

### Worker compact apply

当前：

- `compactContextFromWorker()`；
- ownership/head/summary/visible校验；
- append/DB/rollback/sidecar；
- post-commit token cleanup。

P0 characterization：`context-item-contract.test.ts` 用真实 SQLite trigger 使 token cleanup 的 run-state upsert 失败，证明 summary/archive transaction 已提交、HTTP 返回 `500`，且该提交后错误不进入 archive rollback/sidecar 路径。

P2 当前：底层 append/transaction/rollback/sidecar 已委托 extracted adapter；校验、try/catch、错误映射与 token cleanup 仍由 `compactContextFromWorker()` 拥有，P3 再迁移。

### Clear

当前：

- `clearSession()`；
- `buildClearSummaryText()`；
- validation/append/DB/rollback/sidecar；
- post-commit `setRunStateIdle()`。

P0 characterization：同一测试文件用真实 SQLite trigger 使 `setRunStateIdle()` upsert 失败。该写入仍位于 `clearSession()` 的 `try` 内：clear marker/archive transaction 已提交、HTTP 返回 `500`，随后进入 catch。snapshot exact-size 时 archive append 会被 truncate 回 append 前且无 sidecar；rollback 前有外部追加时，archive 保留并写 `operation="clear"` sidecar。

P2 当前：底层 append/transaction/rollback/sidecar 已委托 extracted adapter；clear 校验、summary 文案、try/catch 与 idle state 顺序仍由 `clearSession()` 拥有，P3 再迁移。

### Archive tools

当前：

- `archiveSearchFromWorker()`；
- `archiveReadFromWorker()`。

P2 当前：仍由 `AgentService` 实现；不改 transport contract，P4 再迁 Archive read capability。

## API Store

### `apps/api/src/modules/agent/agent.store.ts`

当前关键符号：

- `appendSystemSummaryAndArchiveItems()`（由 `SqliteCompactionArchivePersistence` 委托，transaction 本体暂留 store）；
- `listAgentSessionsForArchiveReconcile()`；
- manual compact使用的run/dedup/state基础函数。

目标候选：

```text
apps/api/src/modules/agent/compaction/compaction-archive-ports.ts
apps/api/src/modules/agent/compaction/compaction-archive-application.ts
apps/api/src/modules/agent/compaction/sqlite-compaction-archive-persistence.ts
apps/api/src/modules/agent/archive/archive-storage.ts
apps/api/src/modules/agent/archive/archive-read-storage.ts
apps/api/src/modules/agent/archive/archive-maintenance.ts
```

最终目录/文件名不冻结。规则：

- summary/archive transaction由named persistence承载；
- session candidate query窄化；
- 不按表机械repository化；
- Store原导出可在迁移期由adapter调用，P5清理无调用旧入口。

## Read-side

### `apps/api/src/modules/agent/read-side/`

当前已有：

- `ReadSideApplication`；
- read-side ports/persistence/assemblers。

方案起草时compaction snippet主逻辑仍在 `AgentService.buildPromptMessagesForSession()` 路径。P0需确认Read-side现有组装桥接的实际调用点。

目标：

- Read-side通过`ArchiveExcerptReader`和`CompactionSnippetCache`；
- 不依赖Compaction write application；
- prompt/template/locale/insertion留Read-side。

## Filesystem paths

### `apps/api/src/infra/fs/paths.ts`

当前关键path helper：

- session archive directory；
- pending sidecar path；
- compaction snippet path；
- tmp root。

目标：继续复用安全path policy；不改变目录结构。是否将path调用封装在adapter内由P2决定。

## Worker

### `apps/agent-worker/src/runtime/runner.ts`

当前关键符号：

- `shouldAutoCompact()`；
- `selectCompactionModel()`；
- summary generation/retry；
- `compactContext()`；
- manual sentinel `__awb_compact__`；
- normal loop auto compact。

目标：生产控制流不变，仅做必要type/import适配。

### `apps/agent-worker/src/runtime/apiClient.ts`

当前：

- `compactContext()`使用Shared endpoint/schema；
- `archiveSearch()`/`archiveRead()`使用字面量path和局部类型。

目标：全部保持合同；不顺手Shared统一。

### `apps/agent-worker/src/runtime/tools/providers/builtin.ts`

当前archive tool参数验证与API调用。

目标：不改工具名/schema/参数/行为。

## 当前测试文件

### Shared

```text
packages/shared/tests/internal-contracts.test.ts
```

### API

```text
apps/api/src/modules/agent/archive/archive-storage.test.ts
apps/api/src/modules/agent/archive/compaction-archive.persistence.test.ts
apps/api/src/modules/agent/archive/archive-wiring.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/read-side/*.test.ts
apps/api/src/modules/agent/subtask/subtask-wiring.test.ts  # 含startup顺序现有结构证据，后续可迁专属wiring
```

### Worker

```text
apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/tools/providers/*.test.ts
```

P0 已新增（仍位于既有 `context-item-contract.test.ts`，未提前创建 P1 storage/application test 文件）：

- compact token cleanup post-commit failure；
- clear idle-state post-commit failure；
- sidecar write/rename fault 后 tmp 文件清理断言（既有用例补充确认）。

P0 已复核、P2 已保持的关键定位：

- `ArchiveStorage.appendLines()` 的 fork `archiveWrite.failAfterChunks` fault 在抛错前不会把 `snapshots` 返回给调用方；当前仍只有 fork-with-archive 注入该 legacy fault，compact/clear 未接入；
- `ArchiveStorage.rollbackBestEffort()` 仅处理 append 已正常返回后的 DB failure snapshots，并按逆序 exact-size truncate；
- `ArchiveStorage.reconcilePendingBestEffort()` 仍是 boolean + storage-owned warning，startup 不产生结构化 summary；
- `toArchivePos(fileSeq, lineNo)` 固定为 `(fileSeq - 1) * 100 + lineNo`；search newest-first 且 `beforePos` 排除 `>=` 位置，read 收集后以 old→new 投影；
- snippet cache key 是 compaction summary item id；cache miss 以 transcript 全局最大 `archiveAt` 的 batch item ids 反查摘录，多个可见 compaction boundary 当前共享这一 fallback batch；
- `archiveWrite.failAfterChunks` 被 fork-with-archive 复用，故 `AppContext` fault 面不能在 P2/P3 提前删除。

## P2 extracted adapter 测试与接线

```text
archive-storage.test.ts：真实 `ArchiveStorage` 的 append / snapshot / exact-size rollback / sidecar / reconcile / half-line / excerpt / fault 证据。
compaction-archive.persistence.test.ts：真实 `SqliteCompactionArchivePersistence` 的 summary + archive mark + expected-head CAS + head move + session touch + transaction rollback。
archive-wiring.test.ts：P2 composition root 的 fault mapping、storage/persistence 注入，以及 facade 不再直读 archive fault 的结构约束。
```

P2 已删除 `__archiveTestSupport`；这些测试直接依赖 extracted adapter。production compact/clear/fork/reconcile 仅做底层内部切换，未迁移业务 main orchestration owner；search/read endpoint 留 P4。

## P0 搜索入口

```bash
rg -n "compactSession|compactContextFromWorker|clearSession" apps/api/src/modules/agent
rg -n "appendArchiveLines|rollbackArchiveLines|PendingSidecar|reconcileArchive" apps/api/src/modules/agent
rg -n "appendSystemSummaryAndArchiveItems|listAgentSessionsForArchiveReconcile" apps/api/src/modules/agent
rg -n "agentTestFaults|AgentTestFaults" apps/api/src
rg -n "archiveSearchFromWorker|archiveReadFromWorker|buildCompactionSnippet" apps/api/src/modules/agent
rg -n "__awb_compact__|shouldAutoCompact|compactContext" apps/agent-worker/src/runtime
rg -n "archive/search|archive/read" packages/shared apps/api apps/agent-worker
```

## 最终结构审计

阶段收口及全面独立终审已确认：

- `AgentService`不直接import/使用archive fs/path sidecar helper；
- archive storage不importDB/service/route；
- persistence不importfs/path；
- application不接收完整AppContext；
- Read-side不接收write application；
- module不解析sidecar；
- Archive 生产逻辑不直接读取 `AppContext.agentTestFaults`；字段因 fork-with-archive 删除条件未满足而保留在 composition-root 过渡映射中；
- Shared无archive search/read新增；
- Worker Runner主控制流diff无非必要变化；
- truncate调用只存在于exact-size rollback/reconcile受控路径。
