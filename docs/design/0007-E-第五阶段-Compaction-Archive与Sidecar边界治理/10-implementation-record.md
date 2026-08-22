# 阶段实施记录

> 状态：P0-P5 的实施、验证与文档收口均已完成；未参与实施的新审查员已完成全面独立终审，结论为通过；无必须补代码项。
> 方案起草基线：分支 `v1.1...origin/v1.1 [ahead 3]`，HEAD `0806aae feat(agent): implement phase 4 subtask governance`；起草前工作区无未提交变更。
> 当前范围：阶段状态收口；残留审计、最小清理、完整验证与全面独立终审均已完成。未修改 Shared contract、DB schema 或 Worker，未执行 Git 写操作。

## 记录规则

- 长期行为事实更新 `02-baseline-and-evidence.md`；
- Archive storage、sidecar、fault hook 更新 `03-archive-storage-and-sidecar-design.md`；
- compact/clear/persistence 更新 `04-compaction-clear-application-design.md`；
- snippet/archive read/startup 更新 `05-snippet-readside-and-startup-design.md`；
- 路径/符号更新 `09-code-map.md`；
- 实际命令、cwd、结果、耗时、预期日志、审查和偏差记录在本文件；
- 不记录 prompt、summary、archive 正文、tool args/result、token、用户内容或敏感绝对路径；
- 每批第一项完整记录 `git status --short --branch`；
- 未执行并看到结果的命令不得标记通过；
- 未实施设计不得写成已完成事实；
- 非本阶段变更不得处理、暂存或回滚。

## 当前批次状态

| 批次                               | 实现   | 实现者测试                                                                               | 独立审查                                                       | 修复   | 独立复审       | Git阶段动作 |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | -------------- | ----------- |
| 方案初稿                           | 已完成 | 文档链接与 `git diff --check` 静态检查通过                                               | 已完成并按意见修订                                             | 已完成 | 已独立复审通过 | 否          |
| P0 行为与故障基线                  | 已完成 | 通过（API context contract + API integration + diff hygiene）                            | 已完成；修正 clear idle failure 的 catch/rollback/sidecar 事实 | 已完成 | 已独立复审通过 | 否          |
| P1 Archive测试地基                 | 已完成 | 通过（Archive storage/persistence/wiring 定向测试 + API typecheck + diff hygiene）       | 全面独立终审通过                                               | 无必须修复 | 不需要       | 否          |
| P2 storage/persistence提取         | 已完成 | 通过（Archive 定向 + context contract + API integration + API typecheck + diff hygiene） | 全面独立终审通过                                               | 无必须修复 | 不需要       | 否          |
| P3 Worker compact/clear迁移        | 已完成 | 通过（P3 fake-port + Archive 定向 + context contract + API integration + typecheck）     | 全面独立终审通过                                               | 无必须修复 | 不需要       | 否          |
| P4 manual/snippet/read/startup迁移 | 已完成 | 通过（P4 fake-port + Archive 定向 + context contract + API integration + typecheck）     | 全面独立终审通过                                               | 无必须修复 | 不需要       | 否          |
| P5 收尾/回归/终审                  | 已完成 | 通过（完整 workspace 回归 + root build/typecheck + diff hygiene）                        | 全面独立终审通过                                               | 无必须修复 | 不需要       | 否          |

## 方案起草记录

### 输入文档

- `docs/design/0006-Agent模块结构治理总方案/04-target-architecture.md`；
- `docs/design/0006-Agent模块结构治理总方案/05-roadmap-and-staging.md`；
- `docs/design/0006-Agent模块结构治理总方案/07-risks-non-goals-and-decisions.md`；
- `docs/design/0005-Worker-API读侧与生命周期治理/08-follow-up-recommendations.md`；
- `docs/design/0007-D-第四阶段-Subtask-Lineage与Orphan边界治理/` 作为阶段文档结构参考。

### 只读代码证据

- `apps/api/src/modules/agent/agent.service.ts`；
- `apps/api/src/modules/agent/agent.store.ts`；
- `apps/api/src/modules/agent/agent.routes.ts`；
- `apps/api/src/modules/agent/agent.module.ts`；
- `apps/api/src/app/context.ts`；
- `apps/agent-worker/src/runtime/runner.ts`；
- `apps/agent-worker/src/runtime/apiClient.ts`；
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`；
- `packages/shared/src/internal-contracts/agent-api-context.ts`；
- 现有 Shared/API/Worker tests。

### 起草时已确认事实

- manual compact 创建特殊 running run，由 route enqueue `__awb_compact__`；
- Worker compact 和 clear 均先 append archive，再执行 summary/archive DB transaction；
- DB failure 后按 snapshot best-effort rollback，skipped 时写 pending sidecar；
- pending reconcile helper 当前返回 boolean，warning 由 helper 内部直接记录，不存在结构化状态结果；
- snapshots 当前更接近首次触达/追加顺序，没有显式 `filePath` 排序契约；
- sidecar 自动 reconcile 只处理单文件 exact-size；
- `appendSystemSummaryAndArchiveItems()` 是现有核心 SQLite 原子能力；
- `AgentTestFaults` 位于完整 `AppContext`，当前 archive fault 读取集中在 `AgentService`；
- archive search/read 未进入 Shared endpoint/schema registry；
- compaction snippet 的 archive excerpt、cache 与 prompt 组装当前仍混在 `AgentService`；
- session operation lock 仅进程内；
- Worker compact token usage 清理与 clear idle 写入位于核心 DB transaction 之后；
- compact/clear 对 archive append 中途失败缺少完整 characterization 闭环，不能写成已有可靠补偿。

### 方案文档静态检查

- 目录包含 README 与 `01`-`10` 共 11 个 Markdown 文件；
- 文档相对链接检查无缺失目标；
- 新目录尚未跟踪，除执行 `git diff --check` 外，另以文本静态脚本检查末尾换行、行尾空白与 fenced code block 配对，结果通过；
- Git 状态只出现本阶段新文档目录，未出现生产代码、测试、Shared、DB 或 Worker 变更；
- 未运行行为测试、typecheck 或 build，因此不将其标记为通过；
- 方案起草当时未声称审查通过；后续独立审查、复审及阶段末全面独立终审结果见本记录后续章节。
- 静态检查只证明文件、链接与 Markdown/diff hygiene，不等于代码事实一致性审查；最终审查结论以后续独立审查记录为准。

### 独立审查修订记录

- H1：将 reconcile 当前事实修正为 boolean 返回 + helper 内 warning；结构化状态/summary仅保留为目标候选；
- H2：定稿 manual compact 的 schedule/enqueue/enqueue-failure sequencing 由 application/use-case拥有，route只保留transport；
- M1：删除 snapshots 按 `filePath` 排序的错误事实，改为首次触达/追加顺序且不提升为契约；
- M2：增加 fault字段删除前提：fork-with-archive等append路径完成窄hook接线前只允许composition-root过渡mapping；
- M3/L1：补强“当前事实 / 目标设计 / P0待验证”标签；其后独立复审已通过。

## P0 记录模板

### Git 边界

```text
命令：`git status --short --branch`、`git diff --stat`、`git diff --cached --stat`
结果：分支 `v1.1...origin/v1.1 [ahead 3]`；阶段方案目录已在暂存区，P0 新增的 test/document 变更未暂存。
未知变更：除用户已暂存的整个 `0007-E` 方案目录和本 P0 明确变更外无其他变更；未处理或回滚用户变更。
```

### 基线命令

```text
Shared：未运行；P0 未改 Shared。
API 定向：`cd apps/api && npx tsx --test src/modules/agent/context-item-contract.test.ts`，通过（全部子测试通过；trigger 注入的两条 `unhandled error` 日志为预期 HTTP 500 characterization）。
API integration：`cd apps/api && npx tsx --test src/modules/agent/agent.integration.test.ts`，通过。
Worker 定向：未运行；P0 未改 Worker，且 Worker auto/manual compact 仅作为既有回归边界。
API typecheck：未运行；仅修改测试与 Markdown，定向测试已覆盖改动的 TypeScript 执行。
```

### 必答结论

- append 中途失败时实际文件状态与错误传播：`failAfterChunks` 在 append helper 写入 chunk 后抛错，调用方拿不到 snapshots；compact/clear 未传该 fault，当前 DB-failure rollback/sidecar 不覆盖该窗口。fork-with-archive 的受控 fault 会转为 `AGENT_FORK_ARCHIVE_FAILED` 并清理 child session/item/archive dir，但不构成 compact/clear 部分写入恢复证明；冻结为已知缺口，不在 P0 改补偿。
- DB transaction 后 token/idle 写入失败语义：真实 SQLite trigger 证明 compact token cleanup / clear idle upsert 均在 summary/archive transaction 后，且均返回保留原 trigger error 的 HTTP `500`。compact token cleanup 位于 catch 外，已提交 archive 保留且不写 sidecar；clear idle 写仍在 `try` 内，DB marker/archiveAt 已提交后会进入 rollback：snapshot exact-size 时 archive truncate 回 append 前且无 sidecar，rollback 前外部追加导致 size mismatch 时 archive 保留并写 `operation="clear"` sidecar。这是 P0 冻结的现有 DB/文件不对称窗口，P3 必须显式审查。
- process-local lock 的覆盖和不覆盖范围：同一 `AgentService` 实例、同 session promise queue 串行；不覆盖多实例、跨进程、共享 dataDir 或外部文件写者，不是文件锁/lease。
- single/multi-file sidecar 真值表：仅 DB failure 后 rollback skipped 写 sidecar；单文件 exact-size 才自动 truncate+remove，multi-file/invalid/path mismatch/I/O failure保留并由 helper warning；write/rename fault 不掩盖原 DB error，受控 tmp 被清理。
- 当前boolean reconcile与目标结构化result的取舍、warning owner：当前 `Promise<boolean>`，helper 直接拥有 warning；结构化 result/startup summary 仅是后续候选，不得同时制造双重日志。
- search/read/snippet 的精确行为索引：`toArchivePos=(fileSeq-1)*100+lineNo`；search newest-first、beforePos 排除 `pos>=beforePos`；read 结果 old→new。snippet cache 用 summary item id，miss 时按 transcript 全局最大 archiveAt 批次反查，多个 compaction boundary 当前共享该 fallback batch；现有 integration 覆盖 format/pos/half-line/search/read/cache miss/locale/order。
- fork-with-archive 对 storage primitive 的复用边界：fork 是当前唯一传 `archiveWrite.failAfterChunks` 的路径，复用 append primitive 与全局 fault seam；P2/P3 前不得删除其 `AppContext` archive fault 接线，届时需迁为窄 hook，仍不迁 fork 产品语义。

### 审查

```text
审查：已完成独立代码审查。
结论：通过。
问题：已修正 clear idle failure 的 catch/rollback/sidecar 事实。
修复：已完成。
复审：已通过。
```

## P1 Archive 独立测试地基记录

### 变更范围

```text
生产文件：agent.service.ts 仅新增 __archiveTestSupport 测试入口；它引用既有 helper，不改变 production caller、调用顺序或所有权。
测试文件：archive/archive-storage.test.ts；archive/compaction-archive.persistence.test.ts；archive/archive-wiring.test.ts；archive/archive-fault-hook.ts（metadata-only fake/no-op vocabulary）。
文档文件：README.md；07-testing-review-acceptance.md；09-code-map.md；10-implementation-record.md。
明确未改：production compact/clear/manual/startup/reconcile 主链、Shared contract、DB schema、Worker 主控制流、现有 AppContext archive fault 读取位置。
```

### 建立的证据

```text
真实临时 dataDir：文件名过滤/排序、100 行分卷、续写 snapshot 及首次触达顺序、chunk failure 已写文件、reverse exact-size rollback、external append skipped、sidecar write/reconcile、multi-file拒绝、invalid fileKey保留、write/rename tmp cleanup、half-line/excerpt/pos。
真实 SQLite：summary 字段、archive_at、expected-head CAS、head move、session touch、非目标 item 不计入 archivedCount、head 写失败时 summary/archive 标记全量 rollback。
wiring：临时测试 seam 显式且窄；metadata-only ArchiveFaultHook/no-op；production 仍保留 P0 冻结的 AppContext fault seam，P2 前不接入新 hook。
```

### 验证

```text
P1 定向测试：cd apps/api && npx tsx --test src/modules/agent/archive/archive-storage.test.ts src/modules/agent/archive/compaction-archive.persistence.test.ts src/modules/agent/archive/archive-wiring.test.ts（通过：13/13）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/archive/archive-storage.test.ts src/modules/agent/archive/compaction-archive.persistence.test.ts src/modules/agent/archive/archive-wiring.test.ts src/modules/agent/context-item-contract.test.ts src/modules/agent/agent.integration.test.ts（通过，退出码 0）。
类型检查：cd apps/api && npm run typecheck（通过）。
diff hygiene：git diff --check、git diff --cached --check（通过）。
未运行：Shared、Worker、全仓构建；P1 未修改其代码或接口，未将其标记为通过。
```

### 审查与限制

```text
审查：阶段末全面独立终审已覆盖。
结论：通过；无必须补代码项。
关键限制：__archiveTestSupport 是 P1 测试过渡入口，不是 production Archive adapter；P2 必须替换或删除，不能成为 application/route/fork 调用面。P1 没有独立覆盖 archive search/read endpoint、maxChars 或 noArchive，它们仍由既有 integration/Worker 护栏主要覆盖。ArchiveFaultHook 只定稿 metadata-only vocabulary/no-op，P1 未改 AgentTestFaults 的生产接线。
```

## P2 storage 与 persistence 提取记录

### 变更范围

```text
生产文件：新增 archive/archive-storage.ts（append/snapshot、rollback、pending sidecar、reconcile、item-id excerpt）；新增 archive/sqlite-compaction-archive-persistence.ts（named SQLite transaction adapter）；agent.module.ts 在 composition root 构造 storage/persistence，并将 legacy AgentTestFaults 等价映射为 ArchiveFaultHook；agent.service.ts 通过 injected adapter 调用底层能力。
测试文件：archive-storage.test.ts 和 compaction-archive.persistence.test.ts 改为直接依赖真实 extracted adapter；archive-wiring.test.ts 改为验证 P2 composition root mapping 与 facade 边界。
文档文件：README.md；06-implementation-plan.md；07-testing-review-acceptance.md；09-code-map.md；10-implementation-record.md。
明确未改：Shared contract、DB schema、Worker 主控制流、compact/clear/manual/startup orchestration owner、archive search/read endpoint 主实现。
```

### 行为与边界

```text
AgentService 仍拥有 compactContextFromWorker()/clearSession() 的校验、try/catch、错误优先级、token cleanup/idle-state 后续写入及 session serializer；P2 仅把 append → persistence → rollback → sidecar 的底层能力替换为 adapter 调用。
archiveSearchFromWorker()/archiveReadFromWorker() 仍留 AgentService，P4 再治理 read owner；P2 仅把 snippet fallback 的 item-id excerpt 转给 ArchiveStorage。
legacy archive fault 仅在 agent.module.ts 映射为 hook。为保持 P0 事实，archiveWrite.failAfterChunks 仅作用于 fork-with-archive append；rollback/sidecar fault 仍保持原 compact/clear 覆盖范围。`AppContext.agentTestFaults` 尚未删除，是因为 fork-with-archive 删除条件未满足；该 composition-root 过渡映射已由终审接受为非阻断取舍。
SqliteCompactionArchivePersistence 暂委托 agent.store.ts 中原有 appendSystemSummaryAndArchiveItems() 单 transaction；本批不重写 transaction 或 schema。
```

### 验证

```text
P2 定向测试：cd apps/api && npx tsx --test src/modules/agent/archive/archive-storage.test.ts src/modules/agent/archive/compaction-archive.persistence.test.ts src/modules/agent/archive/archive-wiring.test.ts（通过：13/13）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/context-item-contract.test.ts（通过）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/agent.integration.test.ts（通过：165/165）。
类型检查：cd apps/api && npm run typecheck（通过）。
diff hygiene：git diff --check（通过）；git diff --cached --check 未运行（本任务禁止 Git 写操作，未产生暂存变更）。
未运行：Shared、Worker、全仓构建；P2 未修改其代码或接口，未将其标记为通过。
```

### 预期日志与审查

```text
context-item-contract.test.ts 中 SQLite trigger 注入的 token cleanup / clear idle 错误日志是 P0 characterization 的预期证据，命令退出码为 0；日志不包含 archive 正文。
agent.integration.test.ts 的既有预期错误日志不代表失败，最终 165/165 通过。
审查：阶段末全面独立终审已覆盖。
结论：通过；无必须补代码项。
重点：ArchiveStorage 是否保持 rollback/sidecar/reconcile 的精确语义；legacy archiveWrite fault 是否仍只影响 fork；P2 是否未迁移 P3/P4 orchestration/read owner；named persistence 是否未拆散 SQLite transaction。
```

## P3 Worker compact apply、clear 与 per-session reconcile 记录

### 变更范围

```text
生产文件：新增 compaction/compaction-archive-application.ts 与 compaction-archive-ports.ts；agent.service.ts 将 compactContextFromWorker()/clearSession() 收缩为 session serializer 后的 application 委托，并将 per-session reconcile 转发给 application。
测试文件：新增 compaction/compaction-archive-application.test.ts。
文档文件：README.md；06-implementation-plan.md；07-testing-review-acceptance.md；09-code-map.md；10-implementation-record.md。
明确未改：agent.module.ts 的 P2 adapter composition、Shared contract、DB schema、Worker 主控制流、manual compact、archive search/read、snippet、startup reconcile owner。
```

### 行为与边界

```text
CompactionArchiveApplication 通过窄 session/query、run-state、ArchiveStorage、SqliteCompactionArchivePersistence、clock/logger 和 conflict mapper capability 拥有 Worker compact apply、clear 及其 per-session reconcile preflight；application 不依赖 AppContext、Fastify 或 node:fs/path。
AgentService 仍只拥有 process-local runSessionOperationExclusive()；compact/clear facade 不再保留第二套 archive/DB/rollback/sidecar sequencing。startup reconcile 仍由 AgentService.reconcileAllArchivePendingBestEffort() 触发，manual compact/search/read/snippet 仍属 P4。
SQLite summary/archive/head CAS 仍通过 SqliteCompactionArchivePersistence 委托 appendSystemSummaryAndArchiveItems() 单 transaction，不在 application 拆为先读后写。
compact token cleanup 保持在 persistence catch 外；clear idle write 保持在 catch 内。两条 DB failure 均先 rollback、skipped 时写相应 sidecar，之后才映射 conflict。legacy archiveWrite hook 接线未改，继续仅对 fork append 生效。
```

### 验证

```text
P3 + Archive 定向：cd apps/api && npx tsx --test src/modules/agent/compaction/compaction-archive-application.test.ts src/modules/agent/archive/archive-storage.test.ts src/modules/agent/archive/compaction-archive.persistence.test.ts src/modules/agent/archive/archive-wiring.test.ts（通过：19/19）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/context-item-contract.test.ts（通过：23/23）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/agent.integration.test.ts（通过：165/165）。
类型检查：cd apps/api && npm run typecheck（通过）。
diff hygiene：git diff --check（通过）；git diff --cached --check 将在最终检查执行。未执行 Git 写操作。
未运行：Shared、Worker、全仓构建；未新增独立 real fs+SQLite coordinator 或并发专测，不将其标记为通过。
```

### 预期日志与审查

```text
context-item-contract.test.ts 的 SQLite trigger 注入 token cleanup / clear idle / compaction persistence 错误日志是 P0 characterization 预期证据，命令退出码为 0；integration 的既有异步错误日志亦不代表失败。
审查：阶段末全面独立终审已覆盖。
结论：通过；无必须补代码项。
重点：application 是否保持 compact 与 clear 不同的 post-commit catch 边界；conflict 是否严格晚于 rollback/optional sidecar；facade 是否确无第二条 sequencing；application 是否未依赖 AppContext/fs；transaction 是否仍为单 SQLite transaction；P4 owner 是否未越界迁入。
```

## P4 manual compact、snippet、read 与 startup 记录

### 变更范围

```text
生产文件：新增 ManualCompactionApplication/ports、ArchiveReadApplication、ArchiveReadStorage、CompactionSnippetCache、ArchiveStartupReconcileApplication；agent.routes.ts 移除 manual enqueue/failure sequencing；agent.service.ts 改为 manual/read facade 并复用 snippet cache；agent.module.ts 只构造并触发 archive startup use-case。
测试文件：新增 manual compaction、archive read application 与 archive startup reconcile application 定向测试。
文档文件：README.md；05/06/07/09/10。
明确未改：Shared contract、DB schema、Worker/builtin/client 主控制流、archive fault composition root 及其 fork-only archiveWrite 语义；P5 已完成实施收尾。
```

### 行为与边界

```text
ManualCompactionApplication 以窄 ports 拥有 reconcile、dedup、activation transaction、__awb_compact__ enqueue 和 enqueue failure → Lifecycle bridge。AgentService 只提供 session serializer/facade，route 不再自行 enqueue。
ArchiveReadApplication 负责 owner/参数/HTTP mapping，ArchiveReadStorage 负责 archive fs/rg/complete-line projection；beforePos/pos/maxChars/noArchive/regex/snippet payload 语义由既有 integration 回归保护。最终等价性复核补回 rg JSON 的 `lines.bytes` base64 解码回退，避免非 text 形式输出时丢失匹配正文。
CompactionSnippetCache 仅负责 tmp 安全 cache I/O。Read-side prompt facade 保持 boundary、batch、locale/template、插入与降级策略；ArchiveStorage 仅提供 excerpt 数据。
ArchiveStartupReconcileApplication 仅枚举窄 candidate、逐个 reconcile、隔离单项失败；module 不读取 sidecar 或组合归档策略，且启动相对顺序保持。
```

### 验证

```text
P4 + Archive 定向：cd apps/api && npx tsx --test src/modules/agent/compaction/compaction-archive-application.test.ts src/modules/agent/compaction/manual-compaction-application.test.ts src/modules/agent/archive/archive-storage.test.ts src/modules/agent/archive/compaction-archive.persistence.test.ts src/modules/agent/archive/archive-wiring.test.ts src/modules/agent/archive/archive-read-application.test.ts src/modules/agent/archive/archive-startup-reconcile-application.test.ts（通过：24/24）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/context-item-contract.test.ts（通过：23/23）。
必要回归：cd apps/api && npx tsx --test src/modules/agent/agent.integration.test.ts（通过：165/165）。
类型检查：cd apps/api && npm run typecheck（通过）。
最后一次 ArchiveReadStorage `lines.bytes` 解码修复后，以上 API 定向、context contract、API integration 与 typecheck 已按相同命令重跑通过。
Worker 回归：cd apps/agent-worker && npx tsx --test $(find src -name '*.test.ts' -print | sort)（通过：259/259）。
diff hygiene：git diff --check、git diff --cached --check（通过）。未执行 Git 写操作。
未运行：Shared 独立测试与全仓 build；本批未改 Shared 代码或合同，不将它们标记为通过。
```

### 审查重点

```text
审查：阶段末全面独立终审已覆盖。
结论：通过；无必须补代码项。
检查 manual 的 run-state response 快照、dedup 和 enqueue failure bridge 是否等价；route 是否没有 enqueue；ArchiveReadStorage 的 rg JSON byte offset/snippet、半行、pos/beforePos/maxChars/noArchive 是否等价；snippet prompt owner 是否仍在 Read-side；module 是否只触发 startup use-case且顺序未变；P4 新对象是否未获取 AppContext/Fastify；legacy archiveWrite 是否仍 fork-only。
```

## P5 收尾、完整回归与全面终审记录

### 变更与结构审计

```text
删除 AgentService 无用的 node:child_process spawn import。
校准 Subtask startup wiring 结构测试：module 可为显式 ArchiveStartupReconcileApplication 装配窄 candidate 枚举，但不得承载 orphan/sidecar policy；routes → subtask cleanup → archive reconcile 相对顺序仍被断言。
审计结论：未发现 archive fs/sidecar/search/read/manual/startup 编排回流 AgentService；未发现 archive store transaction 被拆散；未发现 Shared archive read 合同、DB schema 或 Worker 主控制流变更；未发现 multi-file 自动 truncate、path traversal 扩张或 archive format 漂移。
兼容 facade：reconcileArchivePendingForSessionBestEffort() 与 failRunOnEnqueueFailure() 仅由现有测试调用，分别继续委托 CompactionArchiveApplication 与 RunLifecycleApplication，未保留第二套业务规则。
```

### 完整验证

```text
packages/shared：npx tsx --test tests/*.test.ts && npm run typecheck（通过：29/29）。
apps/api：npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print | sort) && npm run typecheck（通过：314/314）。
repository root：npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts（通过：8/8）。
apps/agent-worker：npx tsx --test $(find src -name '*.test.ts' -print | sort) && npm run typecheck（通过：259/259）。
plugins/feishu：npm run test && npm run typecheck（通过：11/11）。
apps/web：npm run test && npm run typecheck（通过：24/24）。
repository root：npm run build && npm run typecheck（通过）。
repository root：git diff --check && git diff --cached --check（通过）。
API 全量首轮仅因既有 Subtask startup wiring 测试禁止 module 引用 agent.store 而失败；该断言与 P4 显式 ArchiveStartupReconcileApplication 的窄 candidate 装配冲突，校准后重跑通过。Web build 的 Browserslist 数据过期与大 chunk 提示均为退出码 0 的既有告警。
```

### 新审查员全面独立终审

```text
审查范围：对照 0006、本目录不变量、实际 diff 与上述命令结果，全面检查 archive append → DB → rollback → sidecar 失败顺序、compact 与 clear 的 post-commit 差异、manual run/dedup/enqueue failure 语义、ArchiveReadStorage 的 rg bytes/snippet/pos 语义、snippet read-side owner、startup 顺序与 module policy 边界、fork-only archiveWrite hook，以及 Shared/Worker 未变更事实。
结论：通过。
必须补代码项：无。
可接受差异：ArchiveReadStorage 的复杂 read/search 语义更多依赖 API integration 护栏，不构成阻断。
可接受取舍：AppContext.agentTestFaults 尚未删除，因为 fork-with-archive 删除条件未满足；composition-root 过渡映射继续隔离生产 Archive 边界，不构成阻断。
后续建议：非阻断的低优先级文档精度问题可后续再微调。
```

## P1-P5 通用记录模板

### 变更范围

```text
生产文件：
测试文件：
文档文件：
明确未改：
```

### 验证

```text
定向测试：
必要回归：
类型检查：
构建：
diff hygiene：
```

### 预期日志

```text
warning/error：
为何预期：
是否包含敏感正文：
```

### 独立审查

```text
审查员/会话：
结论：
必须修复：
建议项：
差异与理由：
```

### 修复与复审

```text
修复：
复审命令/结论：
```

### Git阶段动作

```text
用户授权：
暂存范围：
提交：
push：禁止自动执行
```

## 允许记录的设计差异

实施可在不改变职责边界与产品语义的前提下调整：

- `CompactionArchiveApplication` 的最终名称和文件拆分；
- Archive storage 使用类、函数集合或混合能力对象；
- search/read 是 application 方法还是直接由 facade 依赖 read capability；
- snippet cache 与 excerpt reader 的最终 collaborator 粒度；
- manual compact scheduling 是否与 Worker apply/clear 位于同一 application 文件。

任何以下差异必须停止并重新评审：

- archive 格式、分卷、`pos`、search/read payload 变化；
- multi-file sidecar 自动 truncate；
- 引入 staging/outbox/global transaction；
- 拆散 `appendSystemSummaryAndArchiveItems()` 的原子语义；
- Worker runner/auto-compact 主控制流重写；
- 将 archive fault 继续扩张到完整 `AppContext`；
- 在fork-with-archive等append路径尚未完成窄hook接线前删除相关AppContext fault字段；
- 将 process-local lock 宣称为跨进程保证。
