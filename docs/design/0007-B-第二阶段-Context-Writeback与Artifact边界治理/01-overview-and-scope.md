# 背景、目标与范围

## 与上位方案的关系

`0006-Agent模块结构治理总方案` 已明确治理顺序：

```text
基线与最小 testkit
  → Read-side / Prompt
  → Context Writeback
  → Run Lifecycle
  → Subtask
  → Compaction / Archive
  → Session / Routes / Module 收尾
  → Worker 结构评估
```

`0007-A` 已完成第一阶段 Read-side / Prompt 治理，并以提交：

```text
0f57bfe feat(agent): implement phase 1 read-side governance
```

落盘。本方案是 0006 下的下一阶段实施设计，不是新的总体蓝图，也不重新设计 0007-A 已冻结的 read-side/prompt 组件。

## 当前仓库前提

P0 启动时已确认：

```text
branch: v1.1
relative to origin/v1.1: 无 ahead/behind 标记
worktree: 仅本方案目录的十个新增文档，均已暂存
```

P0 的 characterization 新增到本阶段测试文件 `agent.integration.test.ts`，未触碰生产逻辑。状态仍可能变化，因此每批开始前必须完整记录 `git status --short --branch`；任何非本阶段产生的 staged/worktree/untracked 变更均视为不可触碰，不得覆盖、清理、暂存、取消暂存或混入阶段操作。

## 为什么现在治理 Context Writeback

Worker context writeback 已有稳定 Shared contract、Route、Worker client、Store fence 和较完整行为测试，但 API 侧应用规则仍主要集中在：

```text
apps/api/src/modules/agent/agent.service.ts
```

当前两条主入口同时编排：

- HTTP/Shared 输入对应的 use-case；
- Store 原子 fence 结果映射；
- ownership/not-found/conflict 错误语义；
- `todolist` 完成后的 session title 副作用；
- 已确认 `apply_patch` 路径的 result 瘦身与 UI artifact 安全写入；
- P0 已确认的 `write` artifact 生成点、completed-only 写入和其余终态差异；
- 初步 update fence 与最终事务内二次 fence。

这些规则可运行且已有测试，但它们与 lifecycle、session、artifact query、archive 等相邻职责共处于大 service 中。后续若直接进入 Run Lifecycle，会增加写回 fence 和生命周期状态规则混批的风险。

因此本阶段先把 Writeback 的应用协调、原子持久化能力和 artifact 边界显式化，为后续 Run Lifecycle 提供稳定接口。

## 当前端到端调用链

### API-managed Worker

```text
Agent Worker Runner
  → AgentApiClient.createContextItem() / updateContextItem()
  → @agent-workbench/shared/internal-contracts/agent-api
  → POST  /api/internal/agent/context-items
    PATCH /api/internal/agent/context-items/:itemId
  → agent.routes.ts
  → AgentService.appendContextItemFromWorker()
    AgentService.updateContextItemFromWorker()
  → Agent Store 原子 writeback helper
  → SQLite
  → apply_patch UI artifact filesystem（已确认的特定 update）
```

### 本地 fallback runtime

`apps/api/src/modules/agent/agent.runtime.ts` 仍直接调用相同 `AgentService` 兼容入口。本阶段保留该调用面，通过 facade 委派维持兼容，不深拆 local runtime。

## 阶段目标

### 结构目标

- 建立明确的 Context Writeback application/coordinator 边界；
- 让 create/update 的错误映射、副作用编排和 response 语义有单一权威实现；
- 让新组件只依赖窄 persistence/artifact/logger/clock 能力，不接收完整 `AgentService` 或完整 `AppContext`；
- 保留 `AgentService` 作为 routes 与本地 runtime 的兼容 facade；
- 明确 Store 原子能力是事务权威，不把它们降级为普通 CRUD；
- 定稿 Writeback、Context Query 与共享 artifact capability 的依赖方向。

### 行为目标

- 不改变 Shared request/response schema、endpoint 或 Worker validation；
- 不改变 create normal / ignored 分支；
- 不改变 update unchanged 返回；
- 不改变 missing、ownership、head conflict 的当前 status/body；
- 不改变 late fence、head CAS、terminal item 收敛；
- 不改变 P0 已确认纳入本阶段的 artifact 路径、文件格式、安全检查、写入顺序或 best-effort 失败政策；
- 不改变 `todolist` 完成后 session title 更新的既有触发条件。

### 验证目标

- 真实 SQLite 证明 Store 事务内 fence 和 CAS；
- 真实 Fastify Route 证明 schema/auth/status/response；
- domain tests 证明 application 结果映射和副作用调用顺序；
- API-managed Worker 证明 create → run-state → update → run-complete 的真实请求顺序未断；
- Worker `AgentApiClient` 证明 endpoint、path builder、response runtime validation 和 conflict 行为；
- Shared tests 证明 normal/ignored union 与 update response 不漂移；
- apply_patch artifact tests 证明写入、瘦身、安全读取和缺失 404；write 仅在 P0 决定纳入后补同等级证据。

## 纳入范围

### Writeback contract 与 transport

- `AgentApiEndpoints.createContextItem`；
- `AgentApiEndpoints.updateContextItem`；
- `AgentApiCreateContextItem*Schema`；
- `AgentApiUpdateContextItem*Schema`；
- Worker `AgentApiClient.createContextItem()` / `updateContextItem()`；
- API Route 到 `AgentService` facade 的连接。

合同文件在本阶段默认只读，只用于基线和回归。

### Application 与 facade

- `appendContextItemFromWorker()`；
- `updateContextItemFromWorker()`；
- Store 结果到 `HttpError`/response 的映射；
- `todolist` title side effect；
- `apply_patch` create 禁止规则；
- apply_patch result 瘦身与 artifact 写入编排；
- `AgentService` 兼容委派和最小装配。

### Persistence

- `appendContextItemWithRunFence()`；
- `getContextItemForWorkerUpdate()`；
- `updateContextItemWithRunFence()`；
- `appendContextItemInTransaction()` 内既有 head CAS、head 推进和 session touch 行为；
- `AgentConflictError` 到 `409` 的既有映射。

本阶段可以收窄导出/依赖边界，但不改变 SQL、事务和业务结果语义，除非先触发停止并另行决策。

### Artifact

- `apply_patch` completed update 的 artifact 与 slim result；
- artifact 路径构造、安全目录创建、realpath 验证、no-follow 文件读写；
- Context Query 的 `getApplyPatchUiArtifact()` 通过共享 capability 读取；
- Writeback 决定生成/写入时机，Query 决定读取用例，能力层只负责安全路径和 I/O。

P0 已确认 `write` artifact 属于 `updateContextItemFromWorker()` 主链：completed 时 split result、best-effort 写 JSON artifact、以 slim result 落库；failed/cancelled 仅进入 terminal 分支，不写 artifact，也不替换为 slim result。其 Query 读取点为 `getWriteUiArtifact()`。因此 P5 必须纳入 write，但不得将它和 completed `apply_patch` 机械等同。

## 明确排除

### 生命周期

不纳入：

- `updateRunStateFromWorker()`；
- `completeRunFromWorker()`；
- `cancelSession()` / cascade；
- startup recovery；
- enqueue failure；
- cache terminal invalidation。

本阶段只消费现有 Store run/session 状态作为 writeback fence 输入，不重新定义 lifecycle。

### 其他职责域

不纳入：

- Subtask、lineage、orphan；
- Compaction/archive/sidecar；
- Session / Interaction 主流程；
- Context Query 最终模块/route 归属；
- Plugin / MCP / Git environment；
- Worker Runner/builtin tools 主控制流。

### 合同、数据和 UI

不纳入：

- Shared contract 扩张；
- DB schema 或迁移；
- artifact 文件格式变化；
- UI 页面或交互变化；
- 全局错误 envelope、retry、timeout；
- 强一致 DB+filesystem 事务、outbox 或后台孤儿清理系统。

## 关键责任边界

```text
Context Writeback application
  负责：
    create/update use-case 编排
    Store 结果映射
    title/artifact 副作用时机
    response 语义

Atomic persistence capability
  负责：
    transaction 内 ownership/run fence
    terminal/active-run 检查
    head CAS
    append/update 原子落库

Artifact capability
  负责：
    受控路径
    目录与 realpath 安全
    no-follow JSON 读写

Context Query
  负责：
    item/session 查询
    UI artifact 读取用例与 404 映射
```

依赖方向必须保持：

```text
Writeback → Artifact capability
Query     → Artifact capability
Query     ↛ Writeback
Writeback ↛ Query application
```

## 完成标准

- create/update 的权威规则不再散落在 facade 和新组件两处；
- `AgentService` 两个入口只做参数、结果和错误透传；
- Store 原子能力仍是竞态敏感规则的唯一权威；
- create ignored 与 update unchanged 的差异有明确代码和测试；
- apply_patch artifact 的生成/写入时机与安全 I/O 责任分离，Query 读取方向清晰；write 已完成纳入或后置决策；
- 真实 SQLite、Route、Worker client、API-managed Worker 和 artifact 测试均保留；
- `context-item-contract.test.ts` 的 writeback 与 archive/compaction 证据可以独立定位；
- 所有偏差、停止决策、审查和回滚记录落入本阶段文档；
- 所有非本阶段 staged/worktree 变更均保持原状。
