# Module、Startup 与 Composition Root 目标设计

## `AgentService` 长期形态定稿

### 结论：保留薄 facade

本阶段选择保留薄 `AgentService`，不选择 routes 直接依赖多个 concrete use-case，也不新增具有二次分发语义的 `AgentApplication` registry。

### 选择理由

- local runtime、route、集成测试和部分外部 wiring 已围绕一个稳定 Agent 应用入口形成依赖；
- A-E 已经通过 facade 委派逐步迁移，保留薄层的迁移风险最低；
- facade 可为 public/internal route 与 local runtime 提供兼容方法名，同时隐藏 composition 细节；
- routes 直接注入十余个 application 会让 route 注册参数膨胀，并把 composition 变更扩散到每个 handler；
- registry 若只是一组对象属性，与 facade 相比没有明确替换、测试或契约收益，反而新增术语与间接层。

### 薄 facade 允许的内容

- 持有 application capability；
- 方法参数原样转发并返回结果；
- 为历史方法名做小范围兼容 alias；
- 极少量纯跨域 use-case sequencing 只有在已有 application 无合适 owner 时允许，但本阶段已为 send/revert/query/startup 定稿 owner，原则上不再需要新增。

### 薄 facade 禁止的内容

- 直接 import `agent.store.ts`、`workspace.store.ts` 或 filesystem helper；
- 保存完整 `AppContext` 并向外暴露；
- 解析 Fastify request/header；
- 包含 Session/Query/Lifecycle/Archive 等领域规则；
- 构造所有领域 application；
- 为新功能提供“临时先放这里”的 helper。

### 构造责任迁移

当前 `AgentService` constructor 内装配大量 adapter/application。目标是 composition root 或专用 factory 构造：

```text
createAgentApplications(ctx, logger, eventHub, adapters)
  → sessionInteraction
  → contextQuery
  → readSide
  → writeback
  → lifecycle
  → subtask
  → manualCompaction
  → compactionArchive
  → archiveRead
  → peripheral adapters
  → startup capabilities

new AgentService({ ...publicCompatibilityCapabilities })
```

可以建立 `createAgentComposition()` factory 以控制 `agent.module.ts` 长度，但它只能负责依赖构造，不得拥有运行时业务流程。

## Local runtime 依赖

`AgentRuntime` 当前通过 facade 读取 prompt、写回 context/run 并查询 session。目标：

- 可以继续依赖薄 facade 的最小方法，降低一次性迁移风险；或
- composition root 直接提供 `LocalAgentRuntimeExecutionPort` 对象，从对应 applications 组装。

本方案优先第二种，因为 local runtime 所需能力已经稳定且很窄：

- getPromptContextForRun；
- append/update context item；
- update/complete run；
- getSession query。

无论实现方式，local runtime 不得依赖 concrete `AgentService` class 的 private state，也不得获得完整 application registry。

## `AgentStartupCoordinator` 定稿

### 责任

只协调已有 startup use-case：

```text
runPreListen()
  → Subtask cleanupOrphansOnStartup best-effort
  → Archive reconcileAllPendingBestEffort
  → if mode=fail: RunLifecycle.failRunsOnStartup

registerRecoverOnListen(app, runtime)
  → if mode=recover: onListen → RunLifecycle.recoverRunsOnStartup
```

具体 API 可以按 Fastify hook 管理方式微调，但必须保持 pre-listen/onListen 的既有分界。

### 明确不得拥有

- orphan suspect 条件、TTL、delete recheck；
- archive session listing SQL、sidecar policy、文件 I/O；
- recovery candidate SQL、enqueue final fence、fail/cancel 状态规则；
- 任何 Store/DB/filesystem import；
- Worker/Plugin Host 进程启动；
- 通用任务调度、重试框架或全局 startup registry。

### 错误隔离

- orphan cleanup failure：warn，继续 archive；
- archive reconcile failure：warn，继续 run startup；
- 每个领域内部仍负责单 candidate/session best-effort 隔离；
- coordinator 不吞掉领域已记录的细粒度错误，也不重复大量日志；
- fail/recover 的既有失败策略以 `0007-C` 为准，不在 coordinator 重新定义。

### 顺序不变量

```text
routes registration
  → orphan cleanup
  → archive reconcile
  → fail before listen OR register recover onListen
  → worker manager start
```

Plugin Host 当前在 route registration 前启动且注册 close hook；Worker manager 当前在 startup hook 配置后启动。除非 P0 characterization 证明可以等价调整，否则保持。

## Archive startup query adapter

`agent.module.ts` 不得继续 import `listAgentSessionsForArchiveReconcile`。建议建立：

```ts
interface ArchiveStartupSessionQuery {
  listForReconcile(): Array<{ workspaceId: string; sessionId: string }>;
}
```

SQLite adapter 可以内部调用现有 Store helper；`ArchiveStartupReconcileApplication` 继续只依赖 `listSessions` 与 `reconcilePendingBestEffort`。

## Module 最终职责

`registerAgentModule()` 只负责：

- 创建 event hub；
- 创建 composition/factory；
- 根据配置创建 remote Worker client 或 local runtime；
- 启动 Plugin Host 并注册 close hook；
- 注册 grouped routes；
- 调用 startup coordinator / 注册 onListen；
- 启动 Worker manager并注册 close hook；
- 管理进程级资源生命周期。

module 不得：

- 查询 Store；
- 决定 session/run/archive/subtask 业务条件；
- 直接调用多个 persistence function；
- 拼装 request-level use case；
- 变成新的 all-purpose service。

## Composition 依赖方向

```text
AgentModule
  → create adapters/persistence
  → create domain applications
  → create thin AgentService facade
  → create route capability sets
  → create runtime/process managers
  → create AgentStartupCoordinator

Route → facade/use-case capability
Facade → applications only
Application → named query/persistence/external ports
StartupCoordinator → startup use-case ports only
SQLite adapter → agent.store.ts atomic/query helpers
```

默认禁止：

```text
Route/Module/Facade → agent.store.ts
Application → Fastify
StartupCoordinator → DB/filesystem
Peripheral adapter → concrete core service private state
Domain A ↔ Domain B mutual concrete service injection
```

## Module 验收要点

- `agent.module.ts` 不 import `agent.store.ts`；
- startup coordinator 源码不 import DB/store/fs/path；
- orphan/archive/run startup 顺序有结构与行为测试；
- fail 仍在 listen 前，recover 仍在 onListen；
- local/remote runtime 分支及 concurrency 行为不变；
- Plugin Host 和 Worker manager start/stop hook 回归通过；
- facade 构造不再接收完整 `AppContext`，或至少不保存/暴露它；若为渐进迁移短期仍接收，P5 前必须满足删除条件。
