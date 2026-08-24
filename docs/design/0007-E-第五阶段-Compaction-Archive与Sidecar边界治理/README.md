# 第五阶段：Compaction / Archive / Sidecar 边界治理

> 状态：P0-P5 均已完成；未参与实施的新审查员已完成全面独立终审，结论为通过；无必须补代码项，阶段已完成验收收口。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)；直接前置阶段：[`../0007-D-第四阶段-Subtask-Lineage与Orphan边界治理/`](../0007-D-第四阶段-Subtask-Lineage与Orphan边界治理/) 已完成并提交。
> 历史约束：[`../0005-Worker-API读侧与生命周期治理/08-follow-up-recommendations.md`](../0005-Worker-API读侧与生命周期治理/08-follow-up-recommendations.md) 已明确 Archive 强一致性、archive read-side contract 等后续方向不得顺手混入既有阶段。
> 方案起草基线：HEAD `0806aae feat(agent): implement phase 4 subtask governance`，分支 `v1.1...origin/v1.1 [ahead 3]`；起草前工作区无未提交变更。

## 快速结论

本阶段不重新设计压缩或归档产品行为，而是把 API 侧当前集中在 `AgentService` 与 `agent.store.ts` 中的以下规则收敛为可发现、可测试、依赖方向清楚的职责域：

```text
manual compact
  → ManualCompactionApplication
      └─ scheduling + runtime enqueue + enqueue-failure Lifecycle bridge

Worker compact / clear / per-session reconcile
  → CompactionArchiveApplication
      ├─ Worker compaction apply
      ├─ clear
      ├─ per-session pending reconcile
      └─ archive/DB/rollback/sidecar sequencing

startup pending reconcile
  → ArchiveStartupReconcileApplication

  → CompactionArchivePersistence
      └─ summary + archive mark + head CAS/move + session touch
  → ArchiveStorage
      ├─ append with snapshots
      ├─ rollback best-effort
      ├─ pending sidecar write/reconcile
      └─ excerpt lookup for Read-side snippet
  → ArchiveReadStorage
      └─ search/read implementation

Read-side / Prompt
  → 继续拥有 snippet 注入时机与本地化文案
  → 通过窄 Archive excerpt/cache collaborator 读取归档摘录
```

终审保留的差异均为非阻断说明：

- 低优先级文档精度问题可后续继续微调，不影响本阶段验收结论；
- `ArchiveReadStorage` 的复杂 read/search 语义更多依赖既有 API integration 护栏，而不是全部下沉为独立 adapter 单测；该覆盖结构属于可接受差异，不构成阻断；
- `AppContext.agentTestFaults` 尚未删除，是因为 fork-with-archive 对 archive append fault seam 的删除条件尚未满足；生产 Archive 逻辑已通过 composition-root 窄映射隔离，保留字段是可接受取舍，不构成阻断。

核心失败顺序保持：

```text
archive append
  → SQLite transaction
  → DB failure 时按 snapshot best-effort rollback
  → rollback skipped 时写 pending sidecar
```

`appendSystemSummaryAndArchiveItems()` 所表达的单 SQLite transaction 是本阶段必须保持的核心原子 persistence boundary；不得拆成 application 层的多次普通 CRUD。

## 阶段目标

- 建立明确的 Compaction / Archive application，承接 manual compact 的调度、runtime enqueue 与 enqueue-failure 跨域 sequencing，以及 Worker compact apply、clear 与 archive reconcile 用例；route 只保留 transport/auth/schema/status；
- 建立 Archive filesystem capability，集中 append、snapshot、rollback、pending sidecar、search/read 与 excerpt 查询；
- 将 `appendSystemSummaryAndArchiveItems()` 封装为命名明确的 Compaction / Archive persistence capability，保持 head CAS 和单事务；
- 将 `AgentTestFaults` 的 archive fault 从完整 `AppContext` 迁移为组件级受控 hook，生产默认 no-op；
- 只有 fork-with-archive 等仍复用 archive append primitive 的路径也完成窄 hook 接线后，才删除 `AppContext.agentTestFaults` 的相关 archive 字段；此前只允许在 composition root 保留过渡映射；
- 明确 Archive 与 Read-side 在 compaction snippet 上的协作：Archive 提供归档摘录，Read-side 决定 prompt 注入与本地化；
- 让 `AgentService` 成为过渡期兼容 facade，不再承载 archive 文件副作用、sidecar 或 compact/clear 领域规则；
- 让 module 只触发 archive startup use-case，并保留与 Subtask orphan、Lifecycle startup 的既有相对顺序和顶层隔离；
- 建立独立 application、真实 SQLite、真实临时文件、fault hook、wiring 与 API↔Worker 回归证据。

## 明确不做

- 不改变 archive 目录、8 位 `.log` 文件名、每文件 100 行、archive line 或 `pos` 格式；
- 不引入文件与 DB 的全局事务、staging、outbox、事件日志或 reconciliation 状态表；
- 不恢复多文件 pending sidecar 自动 truncate；
- 不改变 single-file exact-size reconcile 条件；
- 不统一 `archive/search` / `archive/read` Shared contract，不改 method/path/body/response；
- 不重写 Worker Runner、自动压缩模型选择、retry/abort 或 manual compact sentinel；
- 不改变 manual compact dedup/run/enqueue failure、Worker compact `compacted:false`、clear 错误码或边界 marker 语义；
- 不重做 public fork/revert 或 fork-with-archive 产品补偿；
- 不提前做 Session / Routes / Module 总体收尾，也不治理 Plugin / MCP / Git environment。

## 核心设计决策

- **文件副作用顺序显式可读**：application 明确表达 append → DB apply → rollback → sidecar，不把顺序隐藏在泛化 transaction helper 中。
- **DB 原子边界不弱化**：summary item、archive mark、expected-head CAS、head move、session touch 保持单一 SQLite transaction。
- **sidecar 是保守补偿记录**：仅在 DB 失败且 rollback 因尺寸不再可证明而 skipped 时产生；不是通用 WAL 或事务日志。
- **只自动处理可证明安全的单文件记录**：多文件、路径非法、结构非法、size mismatch 均保留 sidecar并 warning。
- **fault seam 组件化**：Archive storage 接收窄 fault hook；application、facade 与完整 `AppContext` 不直接读取 archive fault。
- **manual compact 编排由 application 拥有**：application 负责调度、runtime enqueue 与 enqueue-failure bridge sequencing；runtime 与 Lifecycle 仍分别执行 enqueue 和失败收敛，但 route 不再承担业务编排。
- **Archive read 实现归域，协议治理后置**：search/read 可迁入 Archive read capability，但 Worker client、route 和 payload 维持原状。
- **snippet 协作不反转依赖**：Read-side 不依赖 Compaction application；只依赖窄 Archive excerpt/cache capability。
- **提交后状态写入不伪装成同一事务**：Worker compact 的 token usage 清理与 clear 的 `setRunStateIdle()` 当前位于 archive/summary DB transaction 之后；方案先冻结并测试，不擅自扩大事务。
- **进程内锁不夸大**：session operation lock 只提供单 API 进程内串行，不宣称跨进程或多实例线性化。

## 分批路线

| 批次 | 目标                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0   | 已完成：冻结 manual/Worker compact、clear、archive/sidecar/reconcile/snippet 当前行为与故障基线                                                                                                                           |
| P1   | 已完成：建立独立 Archive storage、sidecar、fault hook、SQLite persistence 与 wiring 测试地基；未切换 production 主链。search/read endpoint、`maxChars` 与 `noArchive` 仍主要由既有 API integration / Worker 测试护栏覆盖 |
| P2   | 已完成：提取 Archive write/maintenance/excerpt 与 Compaction/Archive persistence adapter；search/read endpoint 主实现仍留 P4                                                                                             |
| P3   | 已完成：迁移 Worker compact apply、clear 与 per-session reconcile 编排                                                                                                                                                    |
| P4   | 已完成：迁移 manual compact、snippet 协作、archive search/read 实现归属与 startup reconcile                                                                                                                               |
| P5   | 已完成：facade/store/module 结构审计、完整回归、文档收口及新审查员全面独立终审；终审结论通过                                                                                                                              |

## 文档导航

| 文件                                                                                     | 内容                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [01-overview-and-scope.md](./01-overview-and-scope.md)                                   | 背景、目标、范围、非目标与跨阶段衔接                                             |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md)                             | 当前真实调用链、DB/文件顺序、sidecar、fault、snippet 与测试证据                  |
| [03-archive-storage-and-sidecar-design.md](./03-archive-storage-and-sidecar-design.md)   | Archive storage、snapshot、rollback、sidecar、fault hook 与 read capability 设计 |
| [04-compaction-clear-application-design.md](./04-compaction-clear-application-design.md) | manual compact、Worker compact、clear、persistence 与 Lifecycle 协作设计         |
| [05-snippet-readside-and-startup-design.md](./05-snippet-readside-and-startup-design.md) | snippet 跨域边界、archive read 实现归属与 startup 触发设计                       |
| [06-implementation-plan.md](./06-implementation-plan.md)                                 | P0-P5 分批步骤、门禁和回滚点                                                     |
| [07-testing-review-acceptance.md](./07-testing-review-acceptance.md)                     | 测试矩阵、结构审计、独立审查与验收标准                                           |
| [08-risks-and-stop-conditions.md](./08-risks-and-stop-conditions.md)                     | 风险、非目标、停止条件与回滚边界                                                 |
| [09-code-map.md](./09-code-map.md)                                                       | 当前与候选目标代码地图、符号和测试入口                                           |
| [10-implementation-record.md](./10-implementation-record.md)                             | 实施命令、结果、审查、偏差和批次状态模板                                         |

## 完成定义

本阶段只有在以下条件全部成立时才算完成：

- manual compact、Worker compact apply、clear、per-session/startup reconcile 的权威规则不再散落于 `AgentService`；
- manual compact 的 schedule → runtime enqueue → enqueue failure Lifecycle bridge 已由显式 application/use-case 统一编排，route 只保留 transport；
- append → DB → rollback → sidecar 的顺序在 application/storage 边界中显式可审查；
- `appendSystemSummaryAndArchiveItems()` 的原子语义未被拆散，并有真实 SQLite rollback/conflict 证据；
- archive 格式、分卷、`pos`、半行过滤、search/read 和 snippet 行为未漂移；
- sidecar 仍只在 rollback skipped 时产生，且仅单文件 exact-size 自动 reconcile；
- Archive 生产逻辑不再通过完整 `AppContext` 读取 fault；只有所有复用 archive append primitive 的路径均完成窄 hook 接线后，相关 `AppContext` archive fault 字段才允许删除，否则保留 composition-root 过渡映射；
- archive append 中途失败的行为已被 characterization 明确；若本阶段只补证据而不改变策略，文档需如实记录；
- Worker auto/manual compact 控制流、模型选择、retry、abort、sentinel 和 Shared compact contract 保持；
- compact token 清理与 clear idle 写入的提交后语义有明确测试，未被未经验证地并入核心 transaction；
- module 只触发显式 archive startup use-case，不持有 sidecar 文件或 reconcile 规则；
- Shared、API、Worker、类型检查、构建和 diff hygiene 通过；
- 每批完成独立审查和复审，阶段末由未参与实现的新审查员做全面独立审查。
