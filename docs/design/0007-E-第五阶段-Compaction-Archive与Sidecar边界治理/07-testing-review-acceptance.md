# 测试、审查与验收标准

## 验收原则

本阶段不是只验证 compact/clear endpoint 成功，而要同时证明：

- 产品、协议、archive 格式未漂移；
- 文件与 DB 副作用顺序可读、可测；
- summary/archive transaction 未弱化；
- rollback/sidecar 保守策略未扩大；
- append 中途失败的真实状态已明确；
- fault seam 已组件化；
- Read-side/snippet 与 Archive 依赖方向正确；
- facade/module 已收窄；
- Worker Runner 主控制流未改变。

验收采用双轨：

```text
行为/故障/SQLite/真实文件测试
  +
结构/依赖/权威边界审计
```

测试全绿不能替代副作用顺序审查；类/文件拆分也不能替代真实 fs 与 SQLite 证据。

## 测试层次

### Shared contract

继续覆盖：

- `compactContext` method/path；
- request/response schema；
- bare success response；
- strict/warn response validation。

本阶段不应新增 archive search/read Shared contract。若实现要求改 Shared archive tool合同，应视为越界并停止评审。

### Archive storage tests

使用真实临时 dataDir 验证：

- 8 位文件名过滤和 sequence 排序；
- 100 行分卷；
- existing last file 续写；
- empty append；
- payload尾换行；
- snapshot before/expected size；
- 跨卷 snapshots 保持当前首次触达/追加顺序，不要求新增显式排序契约；
- 无尾换行半行过滤；
- archive line 转义与 tool-call-only assistant过滤；
- exact-size rollback；
- external append/size mismatch skipped；
- 多文件逆序 rollback；
- stat/truncate错误的best-effort结果；
- sidecar tmp+rename；
- 当前 reconcile helper 的 boolean 返回与 helper 内 warning；若目标 adapter 改为结构化结果，另测结果映射与单一日志责任；
- invalid JSON/version/workspace/session/fileKey；
- single-file exact-size reconcile；
- multi-file sidecar 保留；
- path traversal/symlink/no-follow；
- search/read/excerpt/pos/maxChars/noArchive。

P1 已建立的独立入口：

```text
archive/archive-storage.test.ts                 # 真实 ArchiveStorage：append/snapshot/rollback/sidecar/reconcile/fault/half-line/按 itemId 的 excerpt
archive/compaction-archive.persistence.test.ts  # 真实 SqliteCompactionArchivePersistence：summary/archive/head transaction、CAS、rollback
archive/archive-wiring.test.ts                  # P2 composition root fault mapping 与 extracted adapter 接线
```

P2 已删除 P1 的 `__archiveTestSupport`；上述定向测试直接依赖真实 extracted adapter。`ArchiveStorage` 不依赖 DB 或 `AgentService`，而 `SqliteCompactionArchivePersistence` 不依赖 filesystem。P2 没有独立迁移 `archiveSearchFromWorker()` / `archiveReadFromWorker()` 或其 `maxChars`、`noArchive` endpoint 语义；它们仍主要依赖既有 API integration 与 Worker 测试护栏，主实现留待 P4。

因此，上方 Archive storage tests 的完整矩阵仍是阶段目标测试清单，不应被解读为 P2 已新增独立 search/read endpoint 覆盖；P2 已落地的精确范围以本节三个测试文件及实施记录为准。

### Fault hook tests

显式注入 hook 验证：

- append chunk fault；
- rollback 前外部 append；
- pending write fault；
- pending rename fault；
- 生产 no-op；
- hook context 不包含 archive正文；
- fault 不改变业务错误优先级。

P2 已在 composition root 将 legacy `AgentTestFaults` 等价映射为 metadata-only `ArchiveFaultHook`；`AgentService` 不再直接读取 archive fault。为保持 P0 已冻结事实，legacy `archiveWrite.failAfterChunks` 仅在 fork-with-archive append 操作触发；rollback 和 sidecar hook 覆盖原有 compact/clear 路径。`AppContext` 的 legacy 字段仍保留，直到所有复用 append primitive 的路径均完成窄 hook 接线后再评估删除。

### SQLite persistence tests

使用真实 SQLite 验证 `appendSummaryAndArchiveItems()`：

- expected-head success；
- stale head conflict；
- summary item字段/boundary/runId；
- 指定 old items archive_at；
- 非目标/已归档 item不被错误变更；
- head move；
- session touch；
- 注入 transaction 中途失败后的全量 rollback；
- 返回 archivedCount；
- manual compact run/dedup/run-state transaction（若单独提取）。

fake DB 不能替代这些证据。

### Application tests

使用显式 fake ports 验证：

- per-session reconcile 位于业务校验前；
- empty/non-terminal 不触发 append；
- append → DB 的顺序；
- DB failure → rollback → optional sidecar → original error；
- conflict 在补偿后映射；
- full rollback 不写 sidecar；
- skipped rollback写sidecar；
- sidecar failure不掩盖原错；
- DB success 后 token cleanup/idle；
- compact token cleanup post-commit failure不触发rollback；
- clear idle-state post-commit failure仍进入clear catch，必须分别覆盖 exact-size rollback 与 size-mismatch sidecar；
- manual dedup fast return不创建/enqueue；新调度由application执行runtime enqueue；enqueue失败由application调用Lifecycle bridge后保留原错误；
- clear错误与locale/reason；
- startup candidate isolation；若目标设计引入结构化startup summary，再覆盖其计数。当前代码没有该summary对象。

fake ports 只证明编排，不证明 fs safety 或 DB transaction。

P3 已新增 `compaction/compaction-archive-application.test.ts`，以 fake ports 覆盖：reconcile 在校验前、empty/non-terminal 的 `compacted:false`、append → DB、DB failure 后 rollback 再映射 conflict、rollback skipped 后 sidecar、compact token cleanup failure 不补偿，以及 clear idle write failure 仍进入 rollback/clear sidecar 分支。真实 fs/SQLite 能力继续由 P1/P2 adapter 测试证明；P3 同时运行 context-item characterization 与既有 API integration 保护实际 facade/module 行为。

本批未新增独立的 clear/compact real fs+SQLite coordinator 测试或专门的并发测试，不得误记为已覆盖。新审查员全面独立终审接受现有 adapter、application 与 integration 组合证据；后续可按低优先级补强，但不构成本阶段阻断。

P4 已新增 manual compact fake-port 测试（reconcile → activation → sentinel enqueue、dedup 无 enqueue、enqueue failure → Lifecycle bridge）、archive read application 参数/ownership 测试及 startup candidate isolation 测试。已有 API integration 覆盖 public/internal manual compact、archive search/read 的分页/`pos`/`beforePos`/`noArchive` 与 snippet cache/locale/order；本批运行完整 integration 作为行为回归。

### API integration

继续覆盖：

- public/internal manual compact；
- Worker disabled；
- dedup；
- application-owned enqueue 与 enqueue failure Lifecycle bridge收敛；
- internal compact ownership/head/summary/response；
- clear success/error/concurrency；
- archive file/marker/head结果；
- DB failure rollback/sidecar；
- per-session和startup reconcile；
- archive search/read；
- compaction snippet cache hit/miss/locale/order；
  -真实 `createApp()` module wiring。

### Worker tests

保持并运行：

- auto compact threshold；
- compaction model selection；
- candidate context-limit fallback；
- one-shot summary；
- retry/abort/conflict；
- `compacted:false`；
- manual `__awb_compact__` sentinel；
- API client compact schema；
- archive builtin 参数和调用。

除测试适配外，Worker 生产 diff 应接近零；任何主控制流修改必须解释为何未越界。

### Wiring/structure tests

验证：

- `AgentService` compact/clear/archive/reconcile 方法是薄 facade；
- manual compact route 只保留transport，schedule/enqueue/failure orchestration位于application/use-case；
- Compaction application不读取完整 AppContext；
- Archive storage不依赖DB/Route/Service；
- persistence不依赖fs；
- Read-side只依赖excerpt/cache，不依赖write application；
- module只触发startup use-case；
- startup相对顺序保持；
- fork-with-archive等append调用方完成窄hook接线后，`AppContext`才不再暴露archive fault；未全部迁移时只能存在明确composition-root过渡mapping与删除条件；
- Shared registry无archive search/read；
- multi-file auto truncate path不存在。

## 已知缺口的验收方式

### Append 中途失败

阶段不能以“测试未报错”回避。必须明确：

- 现有行为；
- 新增的 characterization；
- 是否实施最小安全补偿；
- 若未修，为什么符合本阶段非目标；
- 对 fork/compact/clear各自影响。

不允许将 staging/outbox/multi-file reconcile作为默认修复。

### Process-local lock

测试可证明同一 app实例同 session操作串行，但必须在文档写明：

- 未证明多API实例；
- 未证明外部文件写者；
- 未证明共享dataDir跨进程；
- exact-size fence仍不可删除。

### Post-commit run-state

必须分别覆盖：

- compact DB成功后 token cleanup失败；
- clear DB成功后 idle写入失败。

必须区分当前 catch 边界：

- compact token cleanup 位于 archive DB failure catch 外，迁移后不得新增 archive rollback；
- clear idle 写仍位于 clear 的 `try` 内，迁移前现状会触发 archive rollback；exact-size 时 truncate 回 append 前，size mismatch 时保留文件并写 clear sidecar。

验收重点是迁移未改变现状和错误优先级，不要求本阶段把它们纳入全局事务。若要消除 clear 的 DB marker 与 archive 文件不对称窗口，必须作为 P3 的独立设计决策，而不是测试迁移时顺手修改。

## 独立审查重点

每批审查至少回答：

- manual compact orchestration是否真正离开route，并由application通过Runtime/Lifecycle窄bridge完成；
- 哪一层拥有 append/DB/rollback/sidecar 顺序；
- DB final head fence是否仍在同一transaction；
- sidecar产生范围是否扩大；
- multi-file是否出现任何自动truncate；
- append failure是否被夸大为已恢复；
- fault hook是否仍穿透AppContext；
- post-commit state是否错误触发archive rollback；
- archive search/read合同是否偷偷变化；
- snippet是否形成Read-side ↔ Archive write循环；
- module是否持有领域规则；
- Worker Runner是否被顺手重写。

## 审查流程

每批：

```text
实现者测试
  → 独立审查
  → 必须问题修复
  → 独立复审
```

阶段末：

- 由未参与实现的新审查员全面独立终审；
- 对照 `0006`、本目录不变量、实际 diff 和测试证据；
- 如实现与方案不同但更合理，必须记录差异、证据、风险和为何不改变语义；
- 如存在明显可维护性问题，不因测试绿色而接受。

## 结构审计搜索建议

```bash
rg -n "appendArchiveLines|rollbackArchive|PendingSidecar|reconcileArchive|agentTestFaults" apps/api/src
rg -n "appendSystemSummaryAndArchiveItems" apps/api/src
rg -n "archive/search|archive/read" packages/shared apps/agent-worker apps/api
rg -n "node:fs|node:path|agentArchive" apps/api/src/modules/agent/<new-domain>
rg -n "AppContext|AgentService|Fastify" apps/api/src/modules/agent/<new-domain>
rg -n "truncate" apps/api/src/modules/agent
rg -n "__awb_compact__|shouldAutoCompact|generateCompactionSummary" apps/agent-worker/src/runtime
```

命令路径按实际目录调整。

## P5 实施与终审状态

- 已实际运行 Shared（29）、API（314，plugin service 独立 8）、Worker（259）、Feishu（11）与 Web（24）测试，并完成各自 typecheck；
- 已实际运行根 `npm run build` 与 `npm run typecheck`；
- 已实际运行 `git diff --check` 与 `git diff --cached --check`；
- API 全量首次暴露既有 Subtask startup 结构测试与 P4 module 显式 archive startup use-case 不一致；已将断言校准为允许窄 candidate 装配、禁止 module 承载 policy，随后 API 全量重跑通过；
- Web build 仅输出既有 Browserslist 数据过期和大 chunk 建议，命令退出码为 `0`，不属于本阶段代码失败；
- 未参与实施的新审查员已完成全面独立终审，结论为通过；无必须补代码项。

终审保留以下非阻断说明：

- 非阻断的低优先级文档精度问题可后续再微调；
- `ArchiveReadStorage` 的复杂 read/search 语义更多依赖 API integration 护栏，而不是全部由独立 adapter 单测覆盖；该差异可接受，不构成阻断；
- `AppContext.agentTestFaults` 尚未删除，是因为 fork-with-archive 的窄 hook 删除条件未满足；当前 composition-root 过渡映射保持生产边界隔离，该取舍可接受，不构成阻断。

## 完成验收清单

### 行为

- manual compact request/dedup/run/enqueue行为不变，orchestration owner已从route收口到application；
- Worker auto/manual compact行为不变；
- compacted:false与conflict不变；
- clear错误/marker/locale不变；
- archive格式/pos/search/read/snippet不变；
- startup/per-session reconcile语义不变。

### 一致性

- append/DB/rollback/sidecar顺序明确；
- summary/archive transaction原子；
- original DB error优先；
- sidecar仅rollback skipped产生；
- single-file exact-size only；
- post-commit state不错误回滚已提交archive。

### 结构

- facade薄；
- manual compact route无业务sequencing；
- storage/persistence分离；
- fault hook窄；
- Read-side依赖方向正确；
- module薄；
- Shared archive read合同未新增；
- Worker主控制流未改。

### 工程

- 独立领域测试可定位；
- Shared/API/Worker回归通过；
- 其他 workspace必要回归通过；
- build/typecheck/diff hygiene通过；
- 文档与代码地图为实际终态；
- 新审查员全面终审通过。
