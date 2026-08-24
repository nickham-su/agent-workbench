# 背景、目标与范围

## 背景

`0007-A` 至 `0007-D` 已依次建立 Read-side、Context Writeback、Run Lifecycle 与 Subtask 的职责域模式。当前 Compaction / Archive 仍是 API Agent 模块内最集中的 DB 与文件副作用编排：

- manual compact 的校验、dedup、run 创建与 Worker enqueue 前状态；
- Worker compact 的 ownership/head 校验、archive append、summary/archive DB transaction 与 token 清理；
- clear 的 idle/empty/boundary/non-terminal 校验、archive append、clear marker 与 run-state idle；
- archive append snapshot、best-effort rollback、pending sidecar 写入与 reconcile；
- startup 和每次同 session 操作前的 reconcile；
- archive search/read 文件实现；
- compaction snippet 的归档摘录、cache 与 prompt 注入；
- 通过全局 `AppContext.agentTestFaults` 注入的 archive 故障 seam。

现有行为已具备较多 API、SQLite、Worker 和 Shared 测试。现实问题不是缺少 compact/clear/archive 功能，而是文件系统、DB、补偿、read-side 与 startup 规则仍集中于 `AgentService`，原子边界和依赖方向不易单独定位。

## 为什么现在治理

- `0007-A` 已建立 Read-side / Prompt application，可承接 snippet 注入侧的既有责任；
- `0007-C` 已建立 Run Lifecycle application，可继续拥有 enqueue failure 与 run terminal/state 收敛；
- `0007-D` 已完成 Subtask/orphan startup 边界，Archive 可以在不同时迁移其他高风险职责域的前提下单独治理；
- `0006` 已将 Compaction / Archive 明确排在 Session/Routes/Module 收尾之前；
- 当前 `appendSystemSummaryAndArchiveItems()` 已提供可保留的 SQLite 原子能力，适合按业务边界迁移而非重写；
- 当前 sidecar 策略已是保守、有限的补偿模型，应在结构治理中显式冻结而不是扩大；
- `AgentTestFaults` 仍挂载于完整 `AppContext`，若继续扩张 fault 场景会加重全局上下文耦合。

## 阶段目标

### 建立可发现的 Compaction / Archive application

候选入口包括：

- `scheduleManualCompact()`，并在同一 use-case 内编排 runtime enqueue 与 enqueue-failure Lifecycle bridge；
- `applyWorkerCompaction()`；
- `clearSession()`；
- `reconcilePendingForSessionBestEffort()`；
- `reconcilePendingOnStartup()`；
- archive search/read 的薄应用入口或 read capability。

最终类名可以贴合项目风格，但必须形成明确职责域，不得把相同编排改名后继续留在 facade private helpers。

manual compact 的 orchestration owner 在本阶段定稿为 application/use-case：route 只保留 transport/auth/schema/status；RuntimeControl 仍执行 enqueue，Run Lifecycle 仍执行 enqueue failure 的 DB 收敛，但两者由 application 通过窄 bridge 协调。

### 显式化文件与 DB 顺序

本阶段冻结：

```text
append archive lines and capture snapshots
  → apply SQLite summary/archive transaction
  → DB failure: rollback snapshots best-effort
  → rollback skipped: write pending sidecar best-effort
  → preserve original DB error
```

application 必须可读地表达这一顺序；storage/persistence 可以封装原子步骤，但不得把跨文件与 DB 的补偿窗口伪装成全局事务。

### 保持核心 SQLite 原子能力

`appendSystemSummaryAndArchiveItems()` 当前在一个 transaction 中完成：

- expected head 对比；
- completed system summary 插入；
- old visible items `archive_at` 标记；
- session head 移动到 summary；
- session touch。

迁移后可改名或封装，但不得拆成多次普通 CRUD，也不得弱化 `AgentConflictError` 与 expected-head CAS。

### 收口 Archive storage 与 fault seam

- 统一 archive path、文件枚举、分卷、append、snapshot、rollback、sidecar 与 reconcile；
- search/read/excerpt 可复用同一只读 filesystem capability；
- fault hook 只由 Archive storage 接收，生产默认 no-op；
- application/facade 不读取 `AppContext.agentTestFaults`；
- fork-with-archive 如复用 append primitive，只复用 storage 能力，不吸收其产品编排；
- 只有 fork-with-archive 等全部 append primitive 调用方完成窄 hook 接线后，相关 `AppContext` archive fault 字段才允许删除；此前由 composition root 保留过渡映射。

### 定稿 snippet 跨域边界

- Archive 拥有 archive 文件和 `itemId → archive position/line` 摘录读取；
- Read-side / Prompt 拥有 boundary marker 检测、prompt 注入时机、本地化模板和降级；
- snippet cache 可作为 Read-side collaborator，或由窄 cache capability 承载；
- Read-side 不依赖 Compaction application，Archive 不组装完整 prompt。

### 建立可定位测试

- application tests 验证 append/DB/rollback/sidecar 编排和错误优先级；
- 真实 SQLite tests 验证 CAS、transaction、archive mark 与 rollback；
- 真实临时文件 tests 验证分卷、snapshot、exact-size、multi-file 保守策略和 path 安全；
- fault hook tests 覆盖 write/rollback/sidecar seam；
- wiring tests 验证 facade/module/read-side 依赖方向；
- 保留 API integration、API↔Worker、Worker auto-compact 与 Shared contract 证据。

## 精确纳入范围

### API 生产代码

- `apps/api/src/modules/agent/agent.service.ts` 中 compact、clear、archive append/rollback/sidecar/reconcile/search/read/snippet helper；
- `apps/api/src/modules/agent/agent.store.ts` 中 `appendSystemSummaryAndArchiveItems()` 与 startup reconcile session enumeration；
- `apps/api/src/modules/agent/agent.routes.ts` 的 manual compact、clear、internal compact、archive search/read 入口；复核当前 enqueue sequencing，并将 manual compact sequencing 迁出 route，使其只做 transport；
- `apps/api/src/modules/agent/agent.module.ts` 的 archive startup trigger；
- `apps/api/src/app/context.ts` 的 `AgentTestFaults` archive fault 注入形态；
- `apps/api/src/modules/agent/read-side/` 与 compaction snippet 的窄协作边界；
- 必要的 lifecycle capability 复用，仅限 manual compact enqueue failure 和既有 run-state ownership，不重做 Lifecycle。

### Worker 与 Shared

- `apps/agent-worker/src/runtime/runner.ts` 与 `runner.auto-compact.test.ts` 作为不改控制流的行为护栏；
- `apps/agent-worker/src/runtime/apiClient.ts` 的 compact Shared contract 与 archive search/read 字面量合同；
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts` 的 archive tool 参数语义；
- `packages/shared/src/internal-contracts/agent-api-context.ts` 与 Shared tests，原则上只复核、不改 compact contract。

### 测试

- `apps/api/src/modules/agent/context-item-contract.test.ts`；
- `apps/api/src/modules/agent/agent.integration.test.ts`；
- 新建 Archive storage/application/persistence/wiring 测试文件；
- `apps/agent-worker/src/runtime/runner.auto-compact.test.ts`；
- `apps/agent-worker/src/runtime/apiClient.test.ts` 与必要 builtin tool tests；
- `packages/shared/tests/internal-contracts.test.ts`。

## 明确排除

### 产品与协议

- 不改变 manual compact、auto compact、Worker compact、clear 的请求、响应、错误码和用户可见提示；
- 不改变 compact Shared endpoint/schema 或 response validation；
- 不统一 archive search/read Shared contract；
- 不改变 archive tool 参数、`beforePos`、排序、`noArchive`、snippet/regex 或截断语义；
- 不改变 UI 行为。

### 文件与数据模型

- 不改变 archive 路径、文件名、分卷、line 格式、CR/LF 转义或 `pos`；
- 不改变 DB schema 或历史 archive/context 数据；
- 不新增 archive operation/outbox/staging 表；
- 不引入全局事务、两阶段提交或 content-addressed archive；
- 不扩大自动 reconcile 到 multi-file sidecar；
- 不把 size mismatch 当成可安全 truncate。

### Worker 与其他职责域

- 不重写 Worker Runner 主循环、auto-compaction 模型选择、retry、abort 或 manual compact sentinel；
- 不把 manual compact 改为本地 fallback 等价执行；Worker disabled 语义保持；
- 不重做 Session/Interaction、Run Lifecycle、Subtask、Context Writeback；
- 不重做 public fork/revert；
- 不治理 Plugin / MCP / Git environment；
- 不提前做 routes/module 总体拆分。

## 与既有阶段的衔接

### 与 Read-side / Prompt

继续保持：

- Read-side 决定 prompt message 投影和 compaction snippet 注入；
- Archive 提供只读 excerpt，不回写 run/context 状态；
- static prompt cache 和其他 read-side cache 语义不因 Archive 迁移而改变。

### 与 Run Lifecycle

继续保持：

- manual compact run 的 enqueue failure 由 Lifecycle 收敛；
- manual compact application 通过窄 Runtime/Lifecycle bridge 编排 enqueue 与失败收敛，route 不再拥有该 sequencing；
- Worker compact 后续 complete/fail 仍由 Worker/Lifecycle 主链完成；
- 本阶段不复制 run terminal、cancel、recovery 或 enqueue failure 规则；
- compact token usage 清理和 clear idle 写入必须先冻结现状，不能为了结构整齐未经验证地扩大 transaction。

### 与 Subtask / startup

继续保持 module 当前相对顺序：

```text
routes
  → subtask orphan startup
  → archive pending startup reconcile
  → lifecycle fail/recover hook
  → worker manager start
```

Archive startup use-case 可以显式化，但不得吸收 Subtask orphan 或 Lifecycle recovery 的领域规则。

### 与 `0005` 后续建议

本阶段只做现有保守补偿的结构治理。若要处理：

- 外部追加后的强修复；
- append 部分写入的通用恢复；
- 跨进程共享 dataDir；
- staging/outbox/operation log/reconciliation table；

必须另立 Archive 强一致性方案，不得以本阶段 storage 提取为由顺手落地。

## 术语

| 术语 | 本阶段含义 |
|---|---|
| archive snapshot | 单次 append 触达文件的 `filePath/beforeSize/expectedSize` 记录 |
| rollback skipped | 文件当前 size 不等于 snapshot expectedSize，因无法证明安全而不 truncate |
| pending sidecar | rollback skipped 后写入的 `.pending-reconcile.json` 保守补偿记录 |
| exact-size reconcile | 仅当单文件当前 size 精确等于 expectedSize 时 truncate 到 beforeSize |
| compaction boundary | `boundaryReason="compaction"` 的 completed system summary item |
| clear boundary | `boundaryReason="clear"` 的 completed system marker |
| manual compact | API 创建特殊 run，由 Worker 通过 `__awb_compact__` sentinel 执行 one-shot compact |
| Worker compact apply | Worker 提交 summary，API 执行 archive append 与 DB apply |
| process-local serialization | `runSessionOperationExclusive()` 对同一 API 进程内 session 操作的串行化，不是分布式锁 |

## 成功后的结构收益

- 文件副作用、DB 原子能力与补偿策略可以独立定位和审查；
- fault seam 不再扩张完整 `AppContext`；
- compact/clear 新需求有明确 application 归属；
- archive search/read 的实现可以复用安全 filesystem capability，而不迫使协议统一；
- Read-side 只依赖归档摘录，不与写入 coordinator 形成反向依赖；
- Session/Routes/Module 收尾阶段不必再同时承受 Archive 主体迁移。
