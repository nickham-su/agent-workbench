# Compaction / Clear Application 设计

## 设计目标

建立明确的 application/use-case 层，使 manual compact、Worker compact apply、clear 与 reconcile sequencing 不再由 facade 直接拼装，同时保持：

- compact/clear 产品语义不变；
- Shared compact contract 不变；
- Worker Runner 不变；
- archive append → DB apply → rollback → sidecar 顺序不变；
- summary/archive SQLite transaction 不变；
- Lifecycle 继续拥有 enqueue failure 与 run terminal/state 规则；
- process-local session serialization 的能力边界不被夸大。

## 目标依赖方向

```text
Public/Internal Routes
  → AgentService compatibility facade
  → CompactionArchiveApplication
      ├─ Session/Context query capability
      ├─ ManualCompactSchedulerPersistence
      ├─ CompactionArchivePersistence
      ├─ ArchiveWriteStorage
      ├─ ArchiveMaintenanceStorage
      ├─ SessionOperationSerializer
      ├─ ExecutionProfileReader
      ├─ RunState capability
      ├─ Clock / IdGenerator / Logger
      └─ existing error mapper

CompactionArchiveApplication.scheduleManualCompact()
  → RuntimeControl.enqueueRun(__awb_compact__)
  → enqueue error: RunLifecycleApplication.failRunAfterEnqueueFailure()

Worker
  → Shared compact endpoint
  → applyWorkerCompaction()
```

默认禁止：

```text
Application → Fastify request/reply
Application → full AppContext
Application → node:fs/path
ArchiveStorage → DB
Route → Store + archive storage 自行拼 compact/clear
Read-side → CompactionArchiveApplication
CompactionArchiveApplication → Worker Runner concrete implementation
```

## 候选 use-case

以下 `ReconcileResult` / `ArchiveStartupSummary` 是目标设计占位类型；当前 reconcile helper 实际返回 boolean，startup 当前没有 summary 对象。

```ts
scheduleManualCompact(command): Promise<AgentCompactSessionResponse>
applyWorkerCompaction(command): Promise<AgentApiCompactContextResponse>
clearSession(command): Promise<AgentControlResult>
reconcilePendingForSessionBestEffort(command): Promise<ReconcileResult>
reconcilePendingOnStartup(command?): Promise<ArchiveStartupSummary>
archiveSearch(query): Promise<{ text: string; noArchive?: boolean }>
archiveRead(query): Promise<{ text: string; noArchive?: boolean }>
```

search/read 可以由独立 read facade 暴露，不要求全部塞进单一 class。关键是写入 coordinator 与 read capability 不反向依赖。

## 权威责任表

| 规则 | 权威 owner | 说明 |
|---|---|---|
| manual compact session/workspace/subtask/worker/dedup/idle 校验 | application + query/persistence | 保持既有错误码 |
| manual compact run/dedup/run-state transaction | named persistence capability | 不拆为普通 CRUD |
| manual compact 跨域 sequencing | Compaction application/use-case | 统一拥有 schedule → enqueue → failure bridge，route 只做 transport |
| runtime enqueue / enqueue failure DB 收敛 | RuntimeControl / Run Lifecycle | application 通过窄 bridge 调用，不复制实现规则 |
| Worker compact ownership/head/summary/visible 校验 | Compaction application | 最终 head CAS仍在 persistence |
| archive 文件 append/rollback/sidecar | Archive storage | application 显式编排步骤顺序；不承诺 snapshots 的新排序契约 |
| summary/archive/head transaction | CompactionArchivePersistence | 核心 SQLite 原子能力 |
| compact token cleanup | existing run-state capability | 当前为 DB apply 后步骤，先冻结 |
| clear idle/empty/boundary/non-terminal | Compaction application | 错误码不变 |
| clear summary 文案 | clear use-case collaborator | locale/reason 语义保持 |
| clear post-commit idle state | existing run-state capability | 当前为 DB apply 后步骤，先冻结 |
| per-session serialization | application collaborator | 仅进程内 |
| startup reconcile candidate iteration | Archive startup use-case | 单 session failure isolation |

## Manual compact 设计

本阶段完成口径明确要求：manual compact 的校验、调度 transaction、runtime enqueue 与 enqueue failure Lifecycle bridge 由同一显式 application/use-case 编排。RuntimeControl 仍执行 enqueue，Run Lifecycle 仍拥有失败后的 DB 收敛规则，但 route 不再是 orchestration owner。

### 应用流程

```text
serialize(sessionId)
  → reconcile pending best-effort
  → load/validate session
  → require primary + workspace match + Worker enabled
  → normalize/require clientRequestId
  → dedup lookup
      → hit: return existing run, scheduled=false
  → require idle
  → require head/context and not-only-boundary
  → resolve user execution profile
  → create manual compact run atomically
  → runtime.enqueueRun(__awb_compact__)
      → success: return scheduled=true
      → failure: Lifecycle failRunAfterEnqueueFailure()
                 throw original enqueue error
```

### Manual compact persistence

当前 transaction：

- run record；
- client request dedup；
- running run-state + notice。

应封装为命名能力，例如：

```ts
createManualCompactRun(command): ManualCompactRunCreated
```

它不是 `appendSystemSummaryAndArchiveItems()`，也不应与 Worker apply transaction 合并。manual scheduling 与 actual compaction 之间存在 Worker enqueue/执行边界。

### Runtime / Lifecycle bridge 边界

目标 use-case 明确编排：

```text
scheduleManualCompact()
  → create/dedup manual compact run
  → if newly scheduled, runtime.enqueueRun(__awb_compact__)
  → enqueue error: Lifecycle failRunAfterEnqueueFailure()
  → preserve original enqueue error
```

该 application 不得：

- 复制 Lifecycle SQL；
- 改 sentinel；
- 改 runtime payload；
- 让 worker-disabled local runtime新增 compact 执行语义；
- 改 dedup response。

最终目录与 facade 形态仍可由 Session/Routes/Module 收尾阶段定稿，但 orchestration owner 不再后置：本阶段必须归 application/use-case。

## Worker compact apply 设计

### 应用流程

```text
serialize(sessionId)
  → reconcile pending best-effort
  → validate session/workspace/run ownership
  → early expected-head check
  → require non-empty summary
  → load visible items
  → if empty/non-terminal: compacted=false
  → build archive lines
  → archiveStorage.appendLines()
  → persistence.appendSummaryAndArchiveItems()
      → success: post-commit token cleanup if active run still matches
      → DB failure:
          archiveStorage.rollbackBestEffort()
          if skipped: writePendingBestEffort(operation=compaction)
          map head conflict
          throw original DB error
  → return compacted=true
```

### 错误优先级

- append 失败：不进入 DB apply；传播 append error；P0 冻结部分写入状态；
- DB 失败：rollback/sidecar 是补偿；始终保留原 DB error；
- rollback 失败/skip：记录并写 sidecar，不替换 DB error；
- sidecar 写失败：warning，不替换 DB error；
- `AgentConflictError`：在补偿后映射既有 409；
- post-commit token cleanup 失败：按 P0 冻结的现有行为处理，不能回滚已经提交的 archive/summary。

### `compacted:false`

`compacted:false` 是既有正常响应，不是 conflict/error：

- visible 为空；
- visible 含不可归档非终态 item。

迁移后不得用异常替代，也不得先写 archive。

## Clear 设计

### 应用流程

```text
serialize(sessionId)
  → reconcile pending best-effort
  → validate session/workspace/primary
  → require idle
  → load visible
  → reject empty
  → reject only boundary marker
  → reject non-terminal
  → build clear summary
  → archiveStorage.appendLines()
  → persistence.appendSummaryAndArchiveItems(boundaryReason=clear, runId=null)
      → success: post-commit setRunStateIdle()
      → DB failure:
          rollbackBestEffort()
          if skipped: writePendingBestEffort(operation=clear)
          map conflict
          throw original DB error
  → return refreshed session/runState
```

### Clear summary

继续保持：

- locale 归一；
- reason trim 和最大 200 字符；
- zh-CN/en-US 模板；
- clear marker 提示未来可使用 archive tools；
- `boundaryReason="clear"`。

文案 helper 可迁入 clear collaborator，但不应进入 Archive storage。

## 核心 persistence capability

候选接口：

```ts
interface CompactionArchivePersistence {
  appendSummaryAndArchiveItems(command): {
    summaryItemId: number;
    archivedCount: number;
  };
}
```

### 必须保持的 transaction

```text
expected head final check
  + insert completed system summary
  + mark selected items archive_at
  + move head
  + touch session
```

### 必须保持的输入

- workspaceId/sessionId；
- runId nullable；
- expectedHeadItemId nullable；
- summaryText；
- boundaryReason；
- summaryCreatedAt/archiveAt；
- archiveItemIds。

### 不允许的拆法

```text
application read head
  → insert summary
  → loop update archive items
  → set head
  → touch session
```

前置 head check 不能替代 transaction 内 final CAS。

## Post-commit run-state 步骤

### Worker compact token cleanup

当前只有 activeRunId 仍等于 request runId 时才清空 token。迁移后必须保持：

- 不清理别的 active run；
- status、activeRunId、activeAssistantItemId 延续当前值；
- updatedAt/appliedItemId 更新方式不漂移；
- DB apply 已提交后，不尝试用 archive rollback 回滚成功 compact。

### Clear idle state

当前 clear 在 DB apply 后调用 `setRunStateIdle()`。P0 要确认：

- clear 前 run-state 已要求 idle，这次写入还更新了哪些字段/时间；
- 失败会如何暴露；
- 是否有已存在 characterization。

只有新证据证明可安全并入 persistence transaction，且不会复制 Lifecycle/state 规则时，才可提出设计变更；默认保持顺序。

## Per-session reconcile 与 serialization

三个写入用例在业务校验前先 reconcile。目标 application 应继续：

- 将 reconcile 放在同 session serialization 内；
- 当前 boolean helper 的 warning 位于 helper 内；迁移后无论继续 boolean 或采用目标结构化结果，都保持 best-effort、不因普通 reconcile `false` 阻断业务；
- 不让 storage 自己获取 process lock；
- 不因 reconcile 失败跳过必要业务校验；
- 不宣称跨实例安全。

## Facade 与 route

### `AgentService`

目标保留薄方法：

- `compactSession()` → application；
- `compactContextFromWorker()` → application；
- `clearSession()` → application；
- `archiveSearchFromWorker()` / `archiveReadFromWorker()` → Archive read capability；
- `reconcileAllArchivePendingBestEffort()` → startup use-case。

不得保留 file fs helper、sidecar policy 或 DB/file error sequencing 的第二权威。

### Route

- compact/clear/internal compact route 继续做 transport/auth/schema/status；
- manual compact route 只解析请求并调用 application/use-case，不再执行 schedule/enqueue/enqueue-failure sequencing；
- route 不 import Store/ArchiveStorage；
- archive search/read route contract 不改；
- 本阶段不拆 route 文件。

## 结构验收

- application 不获得完整 `AppContext`；
- manual compact application 统一拥有调度与 Runtime/Lifecycle bridge orchestration；
- compact/clear 共享补偿 primitive，但保留各自校验和 operation；
- manual scheduling transaction 与 archive apply transaction 可分别定位；
- `AgentConflictError` 只在 rollback/sidecar 后映射；
- post-commit 状态失败不触发错误 archive rollback；
- Lifecycle 规则未复制；
- Worker Runner 未修改主控制流；
- facade 不保留旧业务 helper 可被第二路径调用。
