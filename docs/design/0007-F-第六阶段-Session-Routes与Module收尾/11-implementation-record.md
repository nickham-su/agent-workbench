# 阶段实施记录

> 状态：方案与 P0-P5 已完成实现、验证及对应独立审查/复审，并已通过未参与实现的新审查员全面终审；本阶段已完成。
> 调研基线：调研开始前分支为 `v1.1...origin/v1.1 [ahead 4]`，且工作区干净；方案阶段未执行 Git 写操作。

## 记录规则

- 长期现状和不变量更新 `02-baseline-and-evidence.md`；
- Session 设计更新 `03-session-interaction-design.md`；
- Query/Artifact 设计更新 `04-context-query-and-artifact-design.md`；
- route/module 设计更新 `05`、`06`；
- 实际路径/符号更新 `10-code-map.md`；
- 实际命令、cwd、结果、耗时、预期日志、审查结论和实现偏差记录在本文件；
- 不记录 token、用户正文、prompt、artifact/archive 内容或敏感绝对路径；
- 每批第一项记录 Git status/diff 边界；
- 未执行并看到结果的命令不得标记通过；
- 未实施的设计不得写成已完成事实；
- 不处理、回滚或暂存用户未知变更；
- 未经授权不 push、不改写 Git 历史。

## 当前批次状态

| 批次 | 实现 | 实现者测试 | 独立审查 | 修复 | 独立复审 | Git 阶段动作 |
|---|---|---|---|---|---|---|
| 只读调研 | 已完成 | 证据/符号/调用方检索完成 | 已纳入方案独立审查 | 已按审查补充 runtime/owner 证据 | 通过：证据与边界一致 | 否 |
| 方案初稿 | 已完成 | 文件清单、相对链接与 `git diff --check` 静态检查通过 | 初审未通过：H1/H2/M1/L1 | 已完成文档修订 | 通过：修订项全部关闭 | 否 |
| P0 行为与结构基线 | 已完成测试/文档冻结；未做生产迁移 | 定向集、扩展回归、typecheck 通过 | 通过：无阻断问题 | 无需修复 | 通过：审查结论确认 | 否（本子任务无 Git 写权限） |
| P1 Session / Interaction | 已完成实现；未迁移 P2+ | 定向回归、`agent.integration`、typecheck 通过 | 通过：无阻断问题 | 无需修复 | 无修复项，无需复审 | 否（本子任务无 Git 写权限） |
| P2 Context Query / Peripheral Agent Query / Artifact | 已完成实现；未迁移 P3+ | P2 定向回归、`agent.integration`、typecheck 通过 | 通过：无阻断问题 | 无需修复 | 无修复项，无需复审 | 否（未执行 Git 写操作） |
| P3 Route 分组 | 已完成实现；未迁移 P4+ | route architecture、Peripheral Query、`agent.integration`、typecheck 通过 | 初审发现 M1 | M1 已修复 | 通过：M1 已关闭，无阻断问题 | 否（未执行 Git 写操作） |
| P4 Module / Startup / Facade | 已完成定向深拆；未进入 P5 | 最少回归、typecheck、diff hygiene 通过 | 初审及第一次修复复审均指出 H1/M1 | 已按方案 A 深拆 composition，并收窄 test-only 探针 | 通过：H1/M1 已关闭，无阻断问题 | 否（未执行 Git 写操作） |
| P5 清理 / 全量回归 / 终审 | 已完成清理与阶段验收 | Shared/Worker/Feishu/Web、API 全量（按 cwd 约定分段）及 root build/typecheck 通过 | 初审发现 M1/L1 | 已删除无生产调用的 archive reconcile facade，并补齐实施文件记录 | 通过：M1/L1 已关闭；新审查员全面终审通过 | 否（未执行 Git 写操作） |

## 方案调研证据

已只读检查：

- `0006` 目标架构、roadmap、风险与定稿点；
- `AgentService` 方法/owner/Store imports；
- `agent.routes.ts` 全端点与 Feishu 调用方；
- `agent.module.ts` composition/startup/process lifecycle；
- lifecycle activation transaction；
- revert head CAS；
- `AgentRuntime.cancelSession()` 本地同步队列移除行为；
- `AgentWorkerClient.cancelSession()` 远端吞错并 warning 行为；
- artifact write/read/safe I/O；
- startup wiring test；
- `0007-E` 与 `0008` 的已冻结衔接边界。

## 独立审查问题修订记录

- H1：外围只读入口 owner 已唯一化：Context Query 拥有 context list/item/tail、run-state、artifact read、status summary；Peripheral Agent Query 拥有 recent sessions/workspaces、run final text、available agents。
- H2：revert cancel 已按当前代码事实定稿为 DB 后 best-effort；application 必须 defensive catch + warn，成功 HTTP 语义不变，不再留作 P0 待定项。
- M1：错误映射统一为 application 可直接抛 `HttpError`；route 仅保留已冻结 generic/transport bridge。
- L1：所有“工作区干净”表述均限定为调研开始前/起草前的历史基线，不表述为当前永久事实。

修订后不存在待实施阶段自行选择的 owner、revert cancel 或错误映射分支；独立复审只需验证文档一致性与证据充分性。

## P0 实施记录

### P0 基线冻结（HEAD `5203c82`）

- Git 边界：只读复核显示分支为 `v1.1...origin/v1.1 [ahead 4]`；`0007-F` 的 12 份方案文档已在暂存区，是开始 P0 前既有状态；本批仅新增未暂存的 `apps/api/src/modules/agent/session-routes-module-p0-baseline.test.ts`，未执行 add/commit/reset/checkout 等 Git 写操作。
- 实施文件：新增 P0 测试；更新本文件、`02-baseline-and-evidence.md`、`10-code-map.md`。未修改生产代码、Shared contract、DB schema 或 archive/file 格式。
- route/service inventory：已在 `02` 落盘 31 个字面 URL、12 个 Shared registry endpoint、各自 auth/caller/current surface/目标分组，以及 `AgentService` public surface 的当前 owner 分类。
- 新增 characterization：send 的验证顺序/dedup/running/profile/conflict/raw-trim；Context Query 的 full/after/tail/before、mixed pagination、head rollback fence、hidden branch item；revert 的 invalid/archived/non-terminal/running/head conflict 与 DB 后 runtime 顺序；status summary 的 `HttpError`/unknown-error bridge；runtime/module 的 cancel 与启动顺序源码护栏。
- 复用证据：SSE、plugin header/body auth、artifact safe I/O、run/status fallback 和既有 revert API 行为由 `10-code-map.md` 所列集成测试保留；P0 新测试补足此前没有独立覆盖的 Context 窗口、status generic bridge 和当前结构例外。
- 定向测试（cwd `apps/api`）：
  ```bash
  npx tsx --test src/modules/agent/session-routes-module-p0-baseline.test.ts
  ```
  结果：6/6 通过。
- 扩展回归（cwd `apps/api`）：`session-routes-module-p0-baseline.test.ts`、`run-lifecycle-baseline.api.test.ts`、`agent.worker-client.test.ts`、`subtask/subtask-wiring.test.ts`、`read-side.api.test.ts`、`agent.integration.test.ts` 组合执行退出码为 0。
- 类型检查（cwd `apps/api`）：`npm run typecheck` 通过。
- diff hygiene：`git diff --check` 与 `git diff --cached --check` 均通过；未执行 Git 写操作。
- 与方案差异及理由：方案文字曾将“defensive catch 后成功 HTTP”表述为当前观察语义。P0 注入会 reject runtime 后确认：当前 route 没有 catch，DB 已提交但 HTTP 为 500；成功仅由本地不抛错和远端吞错的现有实现保证。已在 `02` 按代码事实更正，未改变 P1 的 defensive catch 目标。
- 独立审查：通过，无阻断问题；确认基线测试和文档以代码事实为准，未提前实施 P1+。
- 独立复审：通过；无需修复项。
- 下一批门禁：已满足，可开始 P1。

## P1 实施记录

### P1 Session / Interaction（HEAD `5203c82`）

- Git 边界：沿用 P0 的暂存方案文档和未暂存工作区变更；未执行 add/commit/reset/checkout 等 Git 写操作。
- 实施文件：新增 `session/session-interaction-application.ts`、`session/session-interaction-ports.ts`、`session/sqlite-session-interaction-store.ts` 及 fake-port 单测；`AgentService` 改为构造并纯委派 Session application；revert route 改为单次 application 调用。
- 责任迁移：Session application 拥有 list/create primary、public fork、send 和 revert；Subtask 仅经既有 `resolveForStart` 窄 materializer 协作。`cancel` 继续直接归 Run Lifecycle，P2 Context/Artifact/Peripheral Query 未迁移。
- 行为保持：send 保留既有 validation order、非权威 dedup/idle fast path、profile resolve、trimmed `text` 与原始 `inputText`；Lifecycle 仍唯一拥有 activation transaction、enqueue 与 failure settlement。fork 沿用 Store 原子 clone、archive append、失败删除 session/archive 的既有时序。
- revert：head CAS/reachability、idle/non-terminal/archived 验证保留在命名 store/application；成功 DB move 后 application 调用 runtime cancel，并 catch/restricted warn，未来 runtime reject 不再将成功 revert 改为 5xx。
- 测试：新增 fake-port application 测试和 Session facade delegate 测试；P0/P1 route characterization 更新为 reject runtime 返回 200 且已提交 head 保持。
- 定向与回归：P1 application、P0 baseline、facade、Lifecycle baseline/persistence、Subtask wiring、Worker client、Context contract、Archive storage/wiring、Compaction application 组合通过；`agent.integration.test.ts` 组合通过；远端 Worker 集成测试 `apps/api/src/modules/agent/agent.worker.integration.test.ts` 3/3 通过；`npm run typecheck` 通过。
- diff hygiene：`git diff --check` 与 `git diff --cached --check` 通过；未执行 Git 写操作。
- 独立审查：通过，无阻断问题。
- 下一批门禁：已满足，可进入下一批。

## P2 实施记录

### P2 Context Query / Peripheral Agent Query / Artifact read（HEAD `5203c82`）

- Git 边界：P0/P1 边界由主会话暂存；本批只新增/修改工作区文件，未执行 add/commit/reset/checkout 等 Git 写操作。
- 实施文件：新增 `query/context-query-application.ts`、`query/peripheral-agent-query-application.ts`、各自 ports、命名 SQLite query stores 及 fake-port 单测；更新 `AgentService`、`agent.routes.ts`、facade/architecture 测试、本文件和代码地图。
- 责任迁移：`ContextQueryApplication` 唯一拥有 context list/item/tail、visible-transcript artifact read authorization、public run-state 和 status summary；`PeripheralAgentQueryApplication` 唯一拥有 recent sessions/workspaces、run final text 与 available agents。两个 application 不互持；status summary 仅通过窄 `AvailableAgentQuery` 解析 display name。
- 行为保持：pagination mode/head rollback fence、visible-path item/artifact 404、artifact tool kind/name/toolCallId 校验、safe-file-I/O capability、run/status fallback/warning、recent clamp、final-text projection、agents workspace/surface/enablement/order 均保留。`UiArtifactCapability` 未扩展，Writeback 未被 Query 引用或修改。
- route/facade：`AgentService` P2 入口均为纯委派；P3 前 route 继续经 facade 调用。`agents/list` 的 workspace/surface/enablement/order 已迁至 Peripheral application；status summary unknown-error 的 `500 SESSION_STATUS_SUMMARY_FAILED` bridge 与 tail 的 plugin transport guard 保留在 route。
- 未触碰范围：未修改 URL、Shared contract、HTTP status/error code、DB schema；未做 P3 route 分组、token 注入或删除 `getContext()`；未做 P4 module/startup 收口；未迁移 local runtime 所需 `getSession()`。
- 定向与回归（cwd `apps/api`）：`query/context-query-application.test.ts`、`query/peripheral-agent-query-application.test.ts`、`session-routes-module-p0-baseline.test.ts`、`agent.service.facade.test.ts`、`writeback/context-writeback-application.test.ts`、`agent.integration.test.ts` 组合通过；`npm run typecheck` 通过。
- diff hygiene：`git diff --check` 与 `git diff --cached --check` 通过；未执行 Git 写操作。
- 独立审查：通过，无阻断问题。
- 修复：无需修复。
- 独立复审：无修复项，无需复审。
- 下一批门禁：已满足，可进入下一批。

## P3 实施记录

### P3 Route 分组与外围收边（HEAD `5203c82`）

- Git 边界：P0/P1/P2 边界由主会话暂存；本批仅新增/修改工作区文件，未执行 add/commit/reset/checkout 等 Git 写操作。
- 实施文件：新增 `routes/agent-route-auth.ts`、`routes/agent-route-types.ts`、`routes/agent-public.routes.ts`、`routes/agent-worker.routes.ts`、`routes/agent-peripheral.routes.ts`、`routes/agent-status-sse.routes.ts`；更新顶层 `agent.routes.ts`、`agent.module.ts`、route architecture/wiring 测试及代码地图。
- 路由结构：`registerAgentRoutes` 已成为纯聚合入口，依次注册 UI/public、Worker internal、Peripheral internal、Status/SSE 四个分组。各组接收最小 facade/transport capability；route 文件不 import Store、`AppContext`、`node:fs` 或 `node:path`。
- 鉴权与 owner：internal token 由 `agent.module.ts` 显式传入 route 聚合入口，`assertInternalToken` 不再读取 `service.getContext()`。status summary/context tail 继续经 facade 到 `ContextQueryApplication`；recent/workspaces/final-text/agents 继续经 facade 到 `PeripheralAgentQueryApplication`；SSE 仅保持 transport 生命周期；Worker core Shared registry endpoints 继续引用 `AgentApiEndpoints`。
- 行为保持：机械迁移既有注册和 handler，未修改 URL、method、schema、HTTP status、错误码、body-key guard、鉴权顺序或冻结的 transport bridge；`SESSION_STATUS_SUMMARY_FAILED` 未知错误 bridge、plugin caller guard 与 SSE event chunk 语义保留。
- 未触碰范围：未做 P4/P5；未做 composition factory、startup coordinator、module Store import 清理、`AgentService.getContext()` 删除或 facade 构造改造；未修改 Shared contract、DB schema、artifact capability 或 route 级领域错误翻译。
- 定向与回归（cwd `apps/api`）：`npx tsx --test src/modules/agent/session-routes-module-p0-baseline.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts` 8/8 通过；`npx tsx --test src/modules/agent/agent.integration.test.ts` 通过；`npm run typecheck` 通过。
- 架构测试修正：将禁止 route 中真实 `getContext()` 调用的正则收紧为 `\.getContext\(\)`，避免将合法的 `getContextItems()` facade 调用误判为违规。
- 独立审查问题 M1：`routes/agent-peripheral.routes.ts` 的 recent sessions/workspaces handler 曾保留 `limit` 默认、kind 归一化逻辑，未完全退化为 transport。
- M1 修复：route 现在只在鉴权后将 schema parse 的 `req.body`/`req.query` 单次传入 facade；`limit` 默认、clamp 与 kind fallback 仅保留在 `PeripheralAgentQueryApplication`。application/facade capability 的 `limit` 参数调整为可选，以保留缺省请求的既有行为。
- L1 清理：移除 peripheral route 机械拆分遗留的未使用 Shared/internal-contract imports；无行为变化。
- 修复验证（cwd `apps/api`）：`npx tsx --test src/modules/agent/query/peripheral-agent-query-application.test.ts` 2/2 通过；`npx tsx --test src/modules/agent/session-routes-module-p0-baseline.test.ts` 6/6 通过；`npx tsx --test src/modules/agent/agent.integration.test.ts` 通过；`npm run typecheck` 通过。
- diff hygiene/最终只读检查：`git diff --check`、`git diff --cached --check` 通过；规则归属搜索确认默认、kind fallback、clamp 仅在 `PeripheralAgentQueryApplication`。
- 独立复审：通过。确认 recent sessions/workspaces route 仅保留鉴权、schema parse 与单次 facade 调用；默认 limit、clamp 与 kind fallback 仅位于 `PeripheralAgentQueryApplication`，且 P3 其他 route/owner/transport 边界未回归。
- 下一批门禁：已满足，可进入 P4。

## P4 实施记录

### P4 Composition、Facade 与 Startup（未执行 Git 写操作）

- Git 边界：开始 P4 时工作区已包含 P0-P3 的暂存/未暂存改动；本批仅继续修改工作区文件，未执行 `add`、`commit`、`reset`、`checkout`、`rebase` 或其他 Git 写操作，也未处理既有变更。
- 实施文件：新增 `agent.composition.ts`、`archive/sqlite-archive-startup-session-query.ts`、`startup/agent-startup-coordinator.ts` 与其单测；更新 `agent.service.ts`、`agent.module.ts`、`agent.runtime.ts`/runtime port 接线、P4 facade/wiring/architecture/integration 回归测试，以及本代码地图和实施记录。
- composition / facade：`createAgentComposition()` 将原 `AgentService` constructor 内的 application、adapter 与协作对象装配迁出。root 先由 `createAgentCompositionEnvironment()` 从 `AppContext` 派生窄环境，再通过 archive/compaction、lifecycle/session/subtask、read/query/writeback 三个命名 assembly stage 构造职责对象，并由 Session、Query、Lifecycle、Worker 四组 capability builder 组装薄 facade 能力；不存在持有完整 `AppContext` 的 giant composition/service class 或单一 giant capability bag。`AgentService` 只接收分组 capabilities 并原样转发 public 方法，不再 import Store、workspace Store、filesystem 或保存 `AppContext`。为遵守 P4 范围，`getContext()` 保留为兼容 capability forwarding，未提前进入 P5 删除工作。
- local runtime：composition 直接组装仅含 prompt 获取、context item append/update、run state update/complete 与 session query 的 `LocalAgentRuntimeExecutionPort`；local `AgentRuntime` 不再依赖 facade private state 或完整 application registry。
- archive startup：新增 `ArchiveStartupSessionQuery` 与 `SqliteArchiveStartupSessionQuery`。命名 SQLite adapter 内部使用既有 `listAgentSessionsForArchiveReconcile` helper；`agent.module.ts` 不再直接 import `agent.store.ts` 或 archive startup listing helper。
- startup 协调：新增 `AgentStartupCoordinator`，仅协调既有 use-case。`runPreListen()` 保持 orphan cleanup → archive reconcile → fail mode run startup 的顺序，并对 cleanup/archive failure 仅 warning 后继续；recover mode 只由 `registerRecoverOnListen()` 注册 `onListen` hook。coordinator 不 import DB、Store、filesystem 或 path，也不复制 orphan/archive/run 领域规则。
- module / process 生命周期：`registerAgentModule()` 仅创建 event hub/composition、选择 remote client 或 local runtime、启动 Plugin Host 并注册 close hook、注册 grouped routes、触发 startup coordinator、启动 Worker manager 并注册 close hook。Plugin Host 在 routes 前启动、Worker manager 在 startup hook 配置后启动的既有顺序保持。
- 未触碰范围：未修改 Shared contract、URL、schema、HTTP status、错误码、DB schema；未进入 P5，未删除 `getContext()`，未做过渡 helper 大清理或最终终审。
- 定向验证（cwd `apps/api`）：`npm run typecheck && npx tsx --test src/modules/agent/agent.service.facade.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/subtask/subtask-wiring.test.ts src/modules/agent/startup/agent-startup-coordinator.test.ts src/modules/agent/archive/archive-startup-reconcile-application.test.ts src/modules/agent/session-routes-module-p0-baseline.test.ts` 通过（21/21）。
- 关键集成（cwd `apps/api`）：`npm run typecheck && npx tsx --test src/modules/agent/agent.integration.test.ts` 通过；`npx tsx --test src/modules/agent/agent.worker.integration.test.ts src/modules/agent/agent.worker-client.test.ts src/modules/agent/agent.worker-manager.test.ts` 通过（12/12）；`npx tsx --test src/modules/agent/run-lifecycle.persistence.test.ts src/modules/agent/context-item-contract.test.ts` 通过。
- 结构只读核对：`agent.service.ts` 未命中 Store/workspace Store/fs/path/AppContext/application 构造；`agent.module.ts` 未再 import `agent.store.ts`；archive listing helper 仅由命名 SQLite adapter 持有；直接 `new AgentService(...)` 仅在 composition factory 与 facade unit test。
- 初审结论：发现 H1/M1，具体问题与后续修复见下节；当时未满足进入 P5 的门禁。

### P4 独立审查 H1/M1 修复（未执行 Git 写操作）

- 审查结论：P4 初审发现 H1：`AgentApplicationComposition` 是持有完整 `AppContext`、Store/filesystem 依赖与大量业务/兼容方法的 giant class；M1：`createAgentComposition()` 返回完整 `capabilities` 与 concrete `wiring`，内部实现过度暴露。
- 第一次修复后的复审补充：仅删除 `AgentApplicationComposition` 不足；`createFacadeCapabilities()` 及其单一大 capability 对象仍被认定为 giant lexical registry/object bag，且 `testProbe` 的 dependency-bag getter 暴露过深。
- H1 定向深拆：删除 `createFacadeCapabilities()`。root 先通过 `createAgentCompositionEnvironment()` 从 `AppContext` 派生窄环境；`createAgentApplications()` 只汇总三个命名 stage：`createArchiveCompactionAssembly()`、`createLifecycleSessionSubtaskAssembly()`、`createReadQueryWritebackAssembly()`。各 stage 仅接收自身显式输入/窄回调并返回该职责的 application/adapter；Session、Query、Lifecycle、Worker facade capability 再由四个 owner 分组 builder 组合。不存在持有完整 `AppContext` 的 giant class，也不存在单一大 capability bag 作为实现中心。
- M1 定向深拆：root 仍仅返回 `service`、`localRuntimeExecution`、`startupCoordinator` 与 `testOnly`，不返回完整 capabilities 或 concrete wiring。`testOnly` 删除 `getRunLifecycleDependencies()` / `getSubtaskDependencies()` 等 dependency-bag getter，改为仅暴露 lifecycle persistence、active-child query、subtask lineage persistence、child-run activator 和 prompt static cache 五个单 collaborator 引用；生产路径不消费 `testOnly`。
- 回归护栏：P4 architecture test 断言存在三个命名 assembly stage 和四个 facade capability builder，禁止 giant class、giant-class `Pick`、旧 `createFacadeCapabilities()`、`testProbe`、dependency-bag getter、root `wiring` 或顶层 capabilities 返回；Lifecycle/Subtask wiring tests 仅检查所需 collaborator identity/能力。
- 本轮验证（cwd `apps/api`）：逐项执行 `agent.service.facade`、Lifecycle/Subtask wiring、startup coordinator、`agent.integration`、context-item contract、run lifecycle persistence、subtask lineage persistence、P4 architecture 九个最少测试文件，均通过；`npm run typecheck` 通过。仓库根目录 `git diff --check` 与 `git diff --cached --check` 通过。测试中的预期 fault-injection error/warn 日志不表示失败。
- 未触碰范围：未删除 `getContext()`；未进入 P5 或进行过渡 helper 大清理；未修改 Shared contract、URL、schema、HTTP status、错误码、DB schema；startup coordinator、archive adapter、local runtime 最小 port、Plugin Host/Worker 生命周期语义保持。
- 独立复审：通过。确认旧 giant class、旧 giant lexical capability bag 与 dependency-bag getter 均已移除；当前窄 environment、三个 assembly stage、四组 facade capability builder 与五个单 collaborator `testOnly` 引用满足 P4 收边要求，且 facade/runtime/startup/module 边界未回归。
- 下一批门禁：已满足，可进入 P5。

## P5 实施记录

### P5 清理、全量回归与阶段验收（未执行 Git 写操作）

- Git 边界：P0-P4 既有变更已由主会话暂存；本批只修改工作区，未执行 `add`、`commit`、`reset`、`checkout`、`rebase`、`push` 或任何其他 Git 写操作，亦未处理既有未知改动。
- 实施文件：更新 `agent.composition.ts`、`agent.service.ts`、`run-lifecycle.persistence.test.ts`、`agent.integration.test.ts`、`context-item-contract.test.ts`、`session-routes-module-p0-baseline.test.ts`、`archive/archive-wiring.test.ts`、本代码地图与本实施记录；未修改 Shared contract、URL、schema、HTTP status、错误码、DB schema、artifact 文件格式或安全语义。
- 已删除项与证据：全局调用检索后删除 facade 的 `getContext()`、`failRunOnEnqueueFailure()`、`cancelSession()`、`cancelSessionCascade()`、`getContextItemById()`、latest terminal/completed text helpers、`reconcileArchivePendingForSessionBestEffort()`。enqueue-failure、cancel-wins 与 recovery fence 测试已迁移为直接验证 `SqliteRunLifecyclePersistence` 原子 owner；archive pending reconcile contract 测试已迁移为直接验证 `ArchiveStorage` adapter；P5 architecture 护栏断言上述 facade 名称不再存在。
- 保留项与理由：保留 `cancelSessionWithRuntime()`，它是 public cancel route 与 runtime best-effort 协作所需入口。archive reconcile 仍由 `ArchiveStorage`、`CompactionArchiveApplication` 和 startup coordinator 各自在所属边界使用，不再通过 `AgentService` facade 暴露。`RunLifecycleApplication.cancelSession*()` 和 `agent.store.ts` 同名 query helper 仍是其所属 owner 的实现，不属于 facade 残留。
- P5 独立审查 M1 修复：审查确认 `reconcileArchivePendingForSessionBestEffort()` 无生产调用、仅被 contract 测试使用；已删除 facade 与 capability 组装，测试迁移到真实 `ArchiveStorage` adapter。L1 修复：已将 `archive/archive-wiring.test.ts` 补入实施文件清单。
- 定向验证（cwd `apps/api`）：`npm run typecheck` 通过；`npx tsx --test src/modules/agent/run-lifecycle.persistence.test.ts src/modules/agent/session-routes-module-p0-baseline.test.ts` 为 11/11 通过；`npx tsx --test src/modules/agent/agent.integration.test.ts` 为 165/165 通过。测试中的预期 fault-injection/runtime error 日志不表示失败。
- 已完成全量验证：`packages/shared` 的 `npx tsx --test tests/*.test.ts && npm run typecheck` 为 29/29 通过；`apps/agent-worker` 的全量 `npx tsx --test src/**/*.test.ts` 与 `npm run typecheck` 通过；`plugins/feishu` 的 `npm test && npm run typecheck` 为 11/11 通过；`apps/web` 的 `npm test && npm run typecheck` 为 24/24 通过。
- API 全量执行说明：测试目录存在既有 cwd 约定冲突，故按约定分段运行：在 `apps/api` 执行除 `plugin.service.test.ts` 外的全部测试为 334/334 通过；在仓库根目录执行 `npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` 为 8/8 通过。合计 342/342 通过。首次在单一 cwd 下运行的 `ENOENT` / repo-root 解析失败均为该相对路径约定导致，已由分段正确 cwd 回归覆盖。
- Root 验收：仓库根目录 `npm run build && npm run typecheck` 通过；构建仅出现既有 Browserslist 数据过期和大 chunk warning，不影响退出状态。
- 差异卫生：本批已执行 `git diff --check`、`git diff --cached --check` 并通过；`git status --short --branch` 显示分支仍为 `v1.1...origin/v1.1 [ahead 4]`，且 P0-P4 暂存改动与本批工作区改动并存，未发现本批主动产生的无关文件。
- 独立审查：初审发现 M1：无生产调用的 `reconcileArchivePendingForSessionBestEffort()` facade 不应继续保留；L1：实施文件清单漏记 `archive/archive-wiring.test.ts`。上述问题均已修复。
- 独立复审：通过。确认 archive reconcile facade 与 capability 残留已删除、测试迁移到真实 `ArchiveStorage` owner、文档保留理由与实施文件清单已修正，且未引入其他回归或越界修改。
- 下一批门禁：P5 已完成，可进入最终新审查员全面终审。

## 实施记录模板

每批实施时追加：

```text
### Pn 日期/提交基线

- Git 边界：
- 实施文件：
- 关键行为/结构变化：
- 未触碰范围：
- 定向测试（cwd / command / result）：
- 回归测试：
- 预期 warning/log：
- 独立审查结论：
- 修复：
- 独立复审结论：
- 与方案差异及理由：
- 删除项与删除证据：
- 下一批门禁：
```

## 最终验收记录

- 全量测试与 build/typecheck：已完成。Shared 为 29/29 通过；API 按既有 cwd 约定分段执行，合计 342/342 通过；Agent Worker 全量测试通过；Feishu 为 11/11 通过；Web 为 24/24 通过；各项目 typecheck 与仓库根目录 `npm run build && npm run typecheck` 均通过。
- diff hygiene：`git diff --check` 与 `git diff --cached --check` 已执行并通过。
- unknown changes audit：`git status --short --branch` 已复核，分支为 `v1.1...origin/v1.1 [ahead 4]`；P0-P4 暂存改动与 P5 工作区改动并存，未发现本批主动产生的无关文件，未处理、回滚或暂存未知变更。
- P5 独立审查与复审：初审发现 M1/L1；修复后独立复审通过，无剩余阻断问题。
- 未参与实现的新审查员全面终审：通过。终审复核了方案文档、Session/Query owner、route 分组、薄 facade、composition/startup 边界、结构护栏、typecheck、定向测试与 API integration，未发现必须补齐的代码差距。
- 最终可接受差异：`status-summary` 与 `context-items-tail` 当前位于 `agent-status-sse.routes.ts`，与 SSE route group 同文件，而非设计稿中按 Peripheral Context Query 物理归组。两者仍只调用 `ContextQueryApplication` owner，plugin transport guard、status generic `500 SESSION_STATUS_SUMMARY_FAILED` bridge 与 SSE transport lifecycle 均未漂移，因此接受该文件归组差异，不要求修改代码。
- 其他方案差距：未发现需要补齐代码的差距。
- 可维护性结论：当前 owner、facade、route、module 与 startup 边界清晰，未发现必须处理的可维护性问题；`agent.composition.ts` 文件体量仍较大，可作为后续非阻断优化项。
- 阶段结论：`0007-F` 已完成。
