# 分批实施计划

## 固定实施节奏

每批遵循：

```text
实施前复核
  → 小批实现
  → 定向测试 + 必要回归
  → 独立审查
  → 修复
  → 独立复审
  → 经用户授权后处理 Git 阶段动作
  → 下一批
```

不得一次性迁移 prefork/start/result/orphan。P0 未冻结 unique race、compensation 与 nested execution 前不得定稿 activation port；P2 骨架未通过不得迁移 start；P3 必须将 start 主链和 local compensation 同批切换；P4 未完成删除 capability 命名/adapter 收口不得迁移 orphan；P5 未通过不得从 module/facade 删除旧 startup path。

## 批次总览

| 批次 | 目标 | 主要范围 |
|---|---|---|
| P0 | 冻结 Subtask/Lineage/Orphan 基线 | characterization、调用链、事务/时序，无产品改动 |
| P1 | 独立测试地基与 persistence 证据 | application/persistence/wiring 测试骨架 |
| P2 | application/ports/adapter 骨架 | SubtaskApplication、窄 ports、SQLite adapter、装配 |
| P3 | prefork/start/reuse/race/activation/compensation | 主写链、start failure语义与 Lifecycle 窄协作同批迁移 |
| P4 | result/status 与删除 adapter 收口 | query 迁移、local/orphan capability 命名与旧通用 helper 清理 |
| P5 | orphan startup use-case | orphan policy/persistence、module trigger |
| P6 | 清理、完整回归与最终审查 | facade/store 残留、文档、全量验证 |

## P0：行为与竞态基线冻结

### 任务

- 记录 `git status --short --branch`、HEAD 与未知变更边界；
- 复核 Shared 四个 endpoint/schema/error code 与 Worker response validation；
- 逐行记录 prefork plan 与 Worker summary 降级/abort；
- 逐行记录 anchor validation 和业务错误映射；
- 建立 `new/fork/existing` 真值表：metadata、clone、summary/guard/prompt 顺序；
- 记录 start 的 pre-check、session materialization、activation transaction、return/Worker execution 边界；
- 冻结 `(parentRunId,parentToolItemId)` 预查、partial unique、error classifier、race 再查询；
- 证明 reuse 不重复 materialize/activate/execute；
- 证明 existing session 不进入 local compensation；
- 记录嵌套 catch 对同一 `createdSessionId` 的实际 cleanup 调用次数，区分产品语义与实现形态；
- 记录 result/status ownership 与 partial result 选择；
- 证明 cancel child query 不依赖 `subtaskSessionId`；
- 记录 orphan candidate、1h/24h、fork lineage、final fence、failure isolation；
- 复核 module startup 顺序；
- 明确 local fallback 的 Subtask 支持现状；
- 记录 `AgentRuntime` 构造依赖、worker-disabled wiring 与 local execution port 当前形态，作为禁止扩张的结构基线；
- 建立现有测试逐用例索引与命令/cwd。

### P0 必答问题

- 双 start race 是否已有确定性真实 SQLite 证据；
- target unique conflict 后 compensation 与 winner lookup 的实际顺序；
- session-running/profile/workspace/transaction 各失败点的补偿结果；
- 哪些失败路径当前发生重复 cleanup；P3 是否可收敛为单一 best-effort入口而保持产品语义；
- cloned/prefork session 已有 item 时为何不会被误删；
- child activation 是否完整单事务，session idle final check 位于何处；
- Lifecycle nested activator 需要哪些最小输入，是否能避免完整 `AppContext`；
- result 查询是否严格限定 run 的 visible items；
- orphan list query 顶层失败与 candidate 失败各自如何隔离；
- Worker start、orphan、archive reconcile、fail/recover hook 的真实时序；
- 当前日志噪声是否需要保持 warning；
- 0008 记录的历史测试例外是否仍存在。

### 交付

- 更新 `02-baseline-and-evidence.md` 和 `07-code-map.md`；
- 必要 characterization tests；
- `09` 中记录命令、结果和未决项；
- activation 与 deletion transaction boundary 图。

### 门禁

若不能证明 unique race、existing compensation、重复 cleanup现状、child activation transaction、Worker nested execution、local fallback非支持边界或 orphan final fence，停止进入 P2/P3，先补基线。

## P1：测试地基与 persistence 证据

### 建议新增

```text
apps/api/src/modules/agent/subtask/subtask-application.test.ts
apps/api/src/modules/agent/subtask/subtask-lineage.persistence.test.ts
apps/api/src/modules/agent/subtask/subtask-wiring.test.ts
```

可按项目实际拆分 query/orphan persistence tests，但不得只把大 integration tests 复制改名。

### 真实 SQLite 证据

- anchor ownership/tool validation；
- find child by parent tool；
- child query 只返回真实 parent tool lineage；
- partial unique index 与目标 constraint classifier；
- 确定性 race/conflict-reuse；
- seed items + child run + run-state 原子提交/回滚；
- local empty-shell delete fence；
- orphan candidate 与 final delete fence；
- result/status ownership 与 projection。

### Application fake 规则

fake 只用于观察：

- 调用顺序；
- plan/meta；
- mode 分支；
- conflict 后 re-query；
- compensation 是否被调用；
- candidate failure isolation。

不得用 fake persistence 替代 unique index、transaction、final delete fence 的 SQLite 证据。

### 门禁

- 新测试能在 `apps/api` 独立执行；
- fake 默认值显式；
- 不隐藏 transaction；
- 原有 API/Worker 强集成仍保留。

## P2：Subtask application 与窄依赖骨架

### 生产骨架

候选新增：

```text
apps/api/src/modules/agent/subtask/subtask-application.ts
apps/api/src/modules/agent/subtask/subtask-ports.ts
apps/api/src/modules/agent/subtask/sqlite-subtask-lineage-persistence.ts
```

根据职责可拆 orphan/query adapter，但不强制对象泛滥。

### 建立 ports

至少明确：

- lineage/anchor persistence；
- `ActiveSubtaskChildQuery` adapter；
- session materializer/clone；
- profile/settings reader；
- workspace/run-state reader；
- nested child activator；
- result/status query；
- local compensation persistence；
- orphan persistence；
- clock/id/logger。

### 装配原则

- `AgentService` 构造 application 并保留 facade；
- application 不接收完整 `AppContext`；
- Lifecycle 只接收 child query；
- Subtask 只接收 nested activator，不接收完整 Lifecycle application；
- 不为 `AgentRuntime`、worker-disabled module分支或 local runtime execution port 新增 Subtask依赖；
- P2 可暂时让 facade 方法仍走旧实现，但不得形成两个生产权威同时可调用；建议先用 wiring test 冻结迁移开关/委派计划。

### 门禁

- typecheck；
- application contract tests；
- wiring/依赖方向审计；
- 无 Route/module 行为变化；
- port 方法都对应真实后续调用，不建立空转接口。

## P3：Prefork、Start、Reuse、Unique Race、Activation 与 Local Compensation

### 迁移 prefork

- parent anchor 通过 lineage capability；
- threshold/profile/run-state 通过窄 reader；
- 保持默认 95、50..99、floor、meta revalidation；
- facade 只转发。

### 迁移 start

按设计顺序迁移：

- input normalization/error；
- existing child pre-query；
- depth/max depth；
- fork boundary；
- session materialization；
- profile/workspace；
- seed plan；
- nested activation；
- unique conflict 分类/re-query；
- start failure local compensation；
- response。

### 建立 Lifecycle 协作

推荐扩展 lifecycle ports/application 或 SQLite persistence，提供不 enqueue 的 `SubtaskChildRunActivator`。必须保持：

- transaction 内 idle final check；
- seed 顺序；
- runId attachment；
- child lineage/depth；
- run-state active run；
- 全部回滚。

不得：

- 调用 `startUserRun()`；
- enqueue API runtime；
- 把 session mode/summary/guard 逻辑放入 Lifecycle；
- 让 activator处理 unique reuse或 local compensation。

### 同批迁移 local compensation

local compensation 是 `startSubtask()` 失败语义的一部分，P3 必须完成：

- application 只基于本次 `createdSessionId` 调用 `deleteNewSessionIfStillEmpty()`；
- existing session、race winner 与已有 head/item/run 的 session 不得删除；
- target unique loser在返回 winner reused前完成本次空壳的条件补偿；
- compensation error不覆盖 winner或原始 start error；
- P0若确认当前嵌套 catch会重复调用cleanup，P3允许收敛成单一 best-effort入口，但必须以行为/持久化测试证明语义等价；
- start旧实现与compensation旧调用点同批删除，不得留到P4形成双权威。

### Worker 边界

生产 Worker 原则上不改。仅在测试或类型因 API 内部重构需要时做最小调整；Shared payload 与 `processNestedRun()` 时序必须不变。

### 定向验证

- application/persistence/wiring；
- API Subtask integration 子集；
- Worker prefork、cancel/reuse、tool output；
- Shared contract；
- API typecheck；
- 结构审计 `AgentRuntime` 构造参数和 local execution port无变化；
- 结构审计 worker-disabled wiring未注入 `SubtaskApplication`；
- 搜索 Subtask application无 `RuntimeControlPort`、`enqueueRun` 或 runtime依赖。

### 门禁

- facade 中不再保留 prefork/start规则；
- route 不新增业务；
- race 最终单 child；
- loser 无空壳；
- local compensation production path已随start迁移，旧facade/catch补偿逻辑已删除；
- new child 仍由 Worker nested execute；
- reused child不重复执行；
- `AgentRuntime`/worker-disabled wiring/local execution port未扩张。

## P4：Result、Status 与删除 Capability/Adapter 收口

### 迁移 query

- ownership 由 query persistence 集中；
- status 返回 durable run status；
- result assistant-first/system-fallback/empty；
- partial failed/cancelled result 保持；
- facade 只转发。

### 收口删除 capability 命名与 adapter 边界

P3 已完成 local compensation 业务迁移。P4 只做结构收口：

- 确认 application只看到 `deleteNewSessionIfStillEmpty()`；
- 定义 orphan公开port为 `deleteSuspectIfStillEligible({ workspaceId, sessionId, olderThan })`；
- orphan port不暴露 `requireForkLineage` 或等价安全开关；
- fork lineage、age、empty-session条件固化在 SQLite orphan adapter；
- 如共享 SQL fragment/prepared statement builder，仅允许作为 adapter内部私有原语，不导出；
- 删除/私有化旧参数化 `deleteEmptySubtaskSessionIfStillEmpty()` application入口。

### Store 清理

- 通用 `deleteEmptySubtaskSessionIfStillEmpty()` 不再作为 application 公共入口；
- 只可在 SQLite adapter 内保留私有 SQL primitive；
- 暂不迁移 orphan，直至 P4 复审通过。

### 门禁

- local compensation业务已在P3完成且无第二生产路径；
- local 与 orphan 公开能力已分开，orphan安全条件不可由调用者关闭；
- query/persistence tests 通过；
- facade helper 删除；
- 旧 integration 行为无回归。

## P5：Orphan Scan 与 Startup 边界

### 迁移 orphan use-case

- 1h/24h 常量进入 Subtask application/domain config；
- candidate query/delete fence进入 orphan persistence；
- per-candidate isolation进入 application；
- logger 使用窄 port；
- 返回可测试 summary（如实现采用）。

### Module 调整

- module 只调用 facade/application startup use-case；
- 保持顶层 failure isolation；
- 不改变 archive/Lifecycle/Worker 相对顺序；
- 不建立通用 startup coordinator。

### 门禁

- module 无 Store orphan imports、age/policy；
- candidate 失败继续；
- top-level scan 失败不阻塞后续 startup；
- final DB fence 的真实 SQLite 测试通过；
- 不扩大删除范围。

## P6：收尾、完整回归与最终审查

### 结构清理

- `AgentService` Subtask facade 仅转发；
- 删除已迁移 private helpers/imports；
- unique classifier 移至 adapter 邻近位置；
- `agent.store.ts` 不再作为新 application 的任意 import 面；
- Lifecycle/Subtask 不互相注入完整 service；
- module/routes保持薄层；
- `AgentRuntime` 未新增 Subtask API/port；
- worker-disabled wiring和local runtime execution port未变化；
- `SubtaskApplication` 不依赖 RuntimeControl/runtime enqueue；
- 更新代码地图和实施记录。

### 完整验证

至少执行：

```bash
cd packages/shared
npx tsx --test tests/*.test.ts
npm run typecheck

cd apps/api
npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print | sort)
npm run typecheck

cd <repository-root>
npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts

cd apps/agent-worker
npx tsx --test $(find src -name '*.test.ts' -print | sort)
npm run typecheck

cd plugins/feishu
npm run test
npm run typecheck

cd apps/web
npm run test
npm run typecheck

cd <repository-root>
npm run build
npm run typecheck
git diff --check
git diff --cached --check
```

如命令/cwd 已变化，以仓库脚本为准更新 `09`，不得复制历史结果。

### 最终流程

- 实现者完整回归；
- 独立审查；
- 修复与定向验证；
- 独立复审；
- 新审查员从方案、代码、测试、文档和 Git 边界做全面终审；
- 只有通过后才宣告阶段完成。

## 回滚原则

- 每批独立提交/暂存边界；
- application 骨架可在未切 production path 前整体回滚；
- P3 若 activation或local compensation迁移失败，回滚整批，不能保留start failure双权威；
- P4 删除 adapter/导出边界与 P5 orphan切换必须连同调用方回滚；P4不承担新的compensation业务切换；
- 不通过 schema/data migration 回滚，因为本阶段禁止 schema 变更；
- 不改变 Shared/Worker contract，因此协议回滚不应成为必要步骤。
