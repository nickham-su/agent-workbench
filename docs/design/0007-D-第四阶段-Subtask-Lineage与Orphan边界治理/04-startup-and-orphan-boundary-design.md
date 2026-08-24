# Startup 与 Orphan 边界设计

## 设计目标

将 startup orphan scan 从 `AgentService` 内部规则迁入 Subtask 职责域，同时保持当前保守政策：

- scanner 只处理既定空壳 suspect；
- suspect 不等于可删除；
- 删除必须满足更老 age、fork lineage 与最终 DB 二次确认；
- 单 candidate 失败不阻塞后续 candidate；
- 整个 orphan use-case 失败不阻塞 archive reconcile、Lifecycle startup 或 Worker start；
- module 只负责触发与顶层进程编排。

本阶段不建立“所有 startup 任务的领域总管”，也不改变当前 archive/Lifecycle 的 startup 责任。

## 当前启动事实

当前 `registerAgentModule()` 大致顺序：

```text
construct service/runtime/process managers
  → optional plugin host start
  → register routes
  → service.scanAndCleanupSubtaskOrphansBestEffort()
  → service.reconcileAllArchivePendingBestEffort()
  → lifecycle fail-before-listen 或注册 recover-onListen hook
  → workerManager.start()（worker-enabled）
```

当前有两层 failure isolation：

- orphan use-case 内每个 candidate 的 try/catch；
- module 对整个 scan 的 try/catch。

迁移时必须保持“orphan failure 不阻塞启动”，但不要求保留完全相同的 logger 文案或双层 catch 形态；最终异常边界必须可测试且不吞掉进程级致命错误之外的业务信息。

## Candidate 与 deletion policy

### Suspect candidate

当前 candidate query 的规范性条件：

```text
session.kind = subtask
session.createdAt < now - 1 hour
session head 为空
不存在该 session 的 run
不存在该 session 的 context item
```

query 返回：

- workspaceId；
- sessionId；
- createdAt；
- forkedFromSessionId；
- forkedFromItemId。

### Retain policy

candidate 满足以下任一情况必须保留并 warning：

- 未老于 `now - 24 hours`；
- `forkedFromSessionId` 为空；
- `forkedFromItemId` 为空。

这意味着 scanner 不会自动删除所有空 subtask session。尤其 fork null-boundary 创建的双空 origin session，即使长期为空，也不属于当前自动删除范围。本阶段不得借结构迁移扩大范围。

### Final delete fence

eligible candidate 删除时必须在数据库中再次确认：

- workspace/session 匹配；
- `kind=subtask`；
- createdAt 仍老于 delete threshold；
- fork lineage 双字段仍存在；
- 没有非空 head；
- 没有 run；
- 没有 context item。

删除返回 false/0 表示 candidate 在扫描后发生变化或已不存在，应记录 skipped，而不是报错或强制重试。

## 目标 startup use-case

```ts
type CleanupSubtaskOrphansOnStartupCommand = {
  now?: number; // 仅受控测试可覆盖，生产使用 clock
};

type CleanupSubtaskOrphansOnStartupResult = {
  scanned: number;
  retained: number;
  deleted: number;
  skippedAfterRecheck: number;
  failed: number;
};
```

result 主要用于测试、诊断或 debug；module 不必消费。不得把 candidate ids 全量输出到普通日志或 API response。

推荐 application 逻辑：

```text
now = command.now ?? clock.nowMs()
suspectBefore = now - 1h
deleteBefore = now - 24h
candidates = orphanPersistence.listSuspects({ olderThan: suspectBefore })

for candidate:
  try:
    if age/lineage 不满足:
      warn retained
      continue
    deleted = orphanPersistence.deleteSuspectIfStillEligible({
      workspaceId,
      sessionId,
      olderThan: deleteBefore
    })
    warn deleted/skipped
  catch:
    warn candidate failed
    continue

return summary
```

## Persistence 边界

```ts
type SubtaskOrphanPersistence = {
  listSuspects(input: { olderThan: number }): SubtaskOrphanCandidate[];
  deleteSuspectIfStillEligible(input: {
    workspaceId: string;
    sessionId: string;
    olderThan: number;
  }): boolean;
};
```

`deleteSuspectIfStillEligible()` 的公开语义固定包含 fork lineage 双字段检查；application/persistence port 不得暴露 `requireForkLineage` 或等价安全开关。SQLite orphan adapter 必须直接将该条件固化到 SQL，调用者没有关闭入口。

### 与 local compensation 的分离

local compensation 候选能力：

```ts
deleteNewSessionIfStillEmpty({ workspaceId, sessionId }): boolean
```

orphan 能力：

```ts
deleteSuspectIfStillEligible({ workspaceId, sessionId, olderThan }): boolean
```

它们可以在同一个 SQLite adapter 内共享私有 SQL fragment：

```text
kind=subtask + no head + no run + no item
```

该 fragment/prepared statement builder 仅限 adapter 内部私有实现，不得导出给 application、facade、module 或 Lifecycle。orphan 方法在私有原语之上额外固定 age 与 fork lineage。不得继续暴露：

```ts
deleteEmptySubtaskSessionIfStillEmpty({
  olderThan?: number,
  requireForkLineage?: boolean
})
```

作为两种用例都可任意配置的公共 port，也不得换名后继续暴露同类可选安全开关。

## Module 目标边界

候选 wiring：

```ts
const subtaskApplication = service.get... // 实际由 composition root 构造

try {
  subtaskApplication.cleanupOrphansOnStartup();
} catch (err) {
  app.log.warn({ err }, "subtask orphan startup scan failed");
}
```

过渡期可以继续通过 facade：

```ts
service.cleanupSubtaskOrphansOnStartup()
```

但 facade 方法必须只转发。module 不得出现：

- `1h/24h` 常量；
- candidate 遍历；
- lineage 判定；
- Store delete；
- per-candidate catch；
- orphan policy 与 archive/recovery 条件交织。

## Startup coordinator 决策

`0006` 允许：

- module 分别触发不同域 startup use-case；或
- 一个不含领域规则的 startup coordinator 调用多个 use-case。

本阶段选择最小方案：

- 只迁移 Subtask orphan use-case；
- module 继续分别触发 Subtask、Archive 与 Lifecycle；
- 不新增通用 coordinator；
- Session/Routes/Module 收尾阶段再根据实际调用面决定是否合并触发层。

理由：

- archive reconcile 尚未治理；
- lifecycle fail/recover 已有不同 listen 时序；
- 现在抽象通用 coordinator 会提前绑定未稳定职责域。

## 启动顺序与语义

本阶段默认保持现有相对顺序：

```text
routes registered
  → subtask orphan startup use-case
  → archive reconcile
  → lifecycle fail/recover setup
  → worker start
```

结构迁移不应无意改变：

- orphan 在 Worker start 前运行；
- orphan failure 不阻塞 archive/lifecycle/worker；
- fail recovery mode 在 listen 前清理；
- recover mode 的实际 enqueue 仍在 onListen；
- Worker start / onListen 的既有时序由 `0007-C` 冻结。

如果 P0 发现真实 hook/process 顺序与上述描述不一致，先更新基线再设计 wiring，不得按文档推测修改。

## 日志与敏感信息

允许记录：

- workspaceId；
- sessionId；
- deleted/skipped/retained；
- error object；
- 聚合计数。

不得记录：

- prompt/description；
- context item 内容；
- tool args/result；
- archive 内容；
- token 或绝对敏感路径。

保留 warning 级别是当前行为。若实现希望将正常 retained/skipped 下调 debug，必须在 P0 统计现实噪声并经审查定稿；不得在纯结构迁移中直接改变可观察日志政策。

## 并发与竞态

### Candidate 扫描后被使用

session 在 candidate query 后可能被写入 head、item 或 run。final delete SQL 必须使删除失败，不能靠 application 先读后删。

### 与 local start 并发

- start 如果已写入任何 seed/run/head，orphan delete 应被 final fence 拒绝；
- 若 start 仅 materialize 了新 session 且尚无内容，是否可能被 24h scanner 命中取决于 createdAt，不会在正常新建时发生；
- 不引入跨进程锁。

### 多实例/重复 scan

本阶段不承诺多 API 实例协调。条件 delete 使重复扫描至多一个成功，其他返回 skipped。不要为此引入 lease。

## 测试要求

真实 SQLite persistence tests 至少覆盖：

- 1h 内不成为 candidate；
- 1h 后但 24h 内 retain；
- 24h 后但无 fork lineage retain；
- eligible 空壳删除；
- delete 前新增 head/run/item 时跳过；
- 非 subtask 不删除；
- 已删除 candidate 返回 skipped；
- 单 candidate delete 抛错时后续 candidate 继续；
- 整个 list query 抛错时 module warning 且后续 startup 流程继续；
- local compensation 不要求 age/lineage，但仅由本次 createdSessionId 驱动。

wiring/structure tests 至少证明：

- module 不 import orphan Store helpers；
- module 不包含 age/delete policy；
- production wiring 使用 clock，不传测试时序 hook；
- Archive/Lifecycle use-case 未被吸入 Subtask application。

## 与后续阶段的边界

- Compaction / Archive 阶段负责 archive reconcile 迁移；
- Session/Routes/Module 收尾阶段决定是否建立统一 startup coordinator；
- 本阶段完成后，module 仍可能分别触发多个 use-case，这是有意的过渡状态，不是遗漏。
