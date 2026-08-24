# 分批实施计划

## 固定实施节奏

每批遵循：

```text
Git/行为基线复核
  → 小批实现
  → 定向测试 + 必要回归
  → 未参与本批实现的独立审查
  → 修复
  → 独立复审
  → 记录实施证据
  → 下一批
```

阶段全部批次完成后，必须由未参与实现的新审查员做全面独立终审。未获得用户授权不得 push 或改写 Git 历史。

## 批次总览

| 批次 | 目标 | 主要范围 |
|---|---|---|
| P0 | 冻结入口行为与结构基线 | route/method inventory、send/revert/query/startup characterization、architecture tests |
| P1 | Session / Interaction application | create/fork/send/revert owner 迁移，保持 lifecycle/fork 原子边界 |
| P2 | Context Query、Peripheral Agent Query 与 Artifact read | 两个只读 application 的唯一 owner、pagination/item/run/status/artifact/peripheral projection 迁移 |
| P3 | Route 分组与外围收边 | 四类 route group、agents/list 迁出、窄鉴权依赖 |
| P4 | Composition、facade 与 startup | application factory、薄 facade、startup coordinator、module Store 清理 |
| P5 | 过渡 helper 清理与阶段验收 | 无调用 helper、跨域 import、全量回归、文档与终审 |

## P0：行为与结构基线冻结

### 实施步骤

- 记录 `git status --short --branch`、HEAD、diff/cached diff；
- 建立完整 route inventory，记录 method/path/schema/auth/caller/目标分组；
- 建立 `AgentService` public method inventory，标记 owner/facade/test-only/候选删除；
- 新增或补强 `sendMessage` characterization：
  - missing session；
  - subtask read-only；
  - workspace mismatch；
  - empty text；
  - dedup；
  - running；
  - profile error；
  - activation conflict；
  - enqueue failure；
  - raw/trim text 区分；
- 新增 revert characterization：idle/non-terminal/archive/invalid target/head conflict、DB 后 runtime cancel 顺序，以及 defensive catch 下成功 HTTP 语义保持；
- 记录 runtime 事实：本地 cancel 同步无抛错路径，远端 cancel 内部吞错并 warning；该事实不作为待定决策；
- 冻结 Context Query 三种分页、head moved、artifact visible-path authorization、run/status warning fallback；
- 冻结 internal plugin header/body auth、两个 Query application 的唯一 owner、application `HttpError` 与 status generic 500 bridge、SSE transport；
- 冻结 module startup 与 Worker/Plugin Host start/stop 顺序；
- 新增 architecture test skeleton，先反映当前例外而不是提前断言目标已完成。

### 验证点

- 仅增加测试/文档，无产品行为改动；
- lifecycle SQLite transaction 与 fork/archive 现有测试通过；
- route inventory 覆盖全部显式 URL 和 `AgentApiEndpoints`；
- 每项预期 warning/日志有说明，避免误判失败。

### 独立审查点

- 是否遗漏 public/internal/外围 endpoint；
- 是否把现状愿望写成既有事实；
- revert 的本地/远端 runtime 现状证据、defensive catch 和成功 HTTP 语义是否一致；
- send validation/error order 是否完整；
- startup 时机是否包括 pre-listen/onListen/process manager。

### 进入 P1 门禁

上述行为基线和 route/service inventory 经独立复审通过。

## P1：Session / Interaction application

### 实施步骤

- 定义最小 Session query/persistence、clock/id、profile reader、lifecycle start、runtime cancel、fork/archive collaborator；
- 创建 `SessionInteractionApplication` fake-port 单元测试；
- 迁移 list/create primary；
- 迁移 public fork，复用 `0008` 的 primary/subtask materialization 边界和 `0007-E` archive/fault seam；
- 迁移 `sendMessage` 前置语义并调用现有 lifecycle application；
- 迁移 revert，新增 DB move capability 包装；DB 成功后调用 runtime cancel，并 defensive catch + warn，保持成功 HTTP 语义；
- 将 `AgentService` 同名方法改为纯委派；
- 保持 public/internal primary create、trigger 仍调用同一 application entry；
- 保持 Subtask 只依赖窄 session materializer，不依赖 public command surface。

### 验证点

- fake-port 单测证明 owner、参数和副作用顺序；
- lifecycle persistence 真 SQLite 测试证明 transaction 未拆；
- fork/subtask/archive 集成与 fault 测试通过；
- revert runtime failure 不回滚 DB、不改变成功响应；
- facade delegate test 覆盖 Session application。

### 独立审查点

- Session application 是否复制 lifecycle 状态规则；
- fast path 是否仍非权威；
- send error order、raw/trim 文本是否漂移；
- public fork 与 internal subtask clone 是否误合并；
- revert CAS/reachability 和 runtime 顺序是否保持。

### 删除条件

P1 不删除旧 helper，除非同名实现已完全成为 facade 且调用检索、测试均证明无私有旧路径。

## P2：Context Query、Peripheral Agent Query 与 Artifact read

### 实施步骤

- 定义 `ContextQueryApplication` 与命名 query ports；
- 定义 `PeripheralAgentQueryApplication` 与窄 `AvailableAgentQuery` collaborator；
- 为 transcript modes/head fence 建 fake/SQLite query tests；
- 迁移 item visible-path query；
- 迁移 apply_patch/write artifact authorization，复用现有 `UiArtifactCapabilityPort`；
- 迁移 public run-state projection；
- 将 context tail 与 status summary 迁入 `ContextQueryApplication`；status summary 只通过窄 `AvailableAgentQuery` 获取 display name；
- 将 recent sessions、recent workspaces、run final text、available agents 迁入 `PeripheralAgentQueryApplication`；
- 禁止 `PeripheralAgentQueryApplication` 持有完整 `ContextQueryApplication`；
- 将 `AgentService` query 方法改为纯委派；
- 建立依赖方向测试：Context Query 不 import Writeback、两个 Query application 不互持完整 application、route 不接触 filesystem。

### 验证点

- pagination、head moved、item visibility、artifact 404 全量保持；
- artifact safe I/O 测试与 writeback artifact test 通过；
- run-state/status summary token/elapsed/fallback 保持；
- Feishu 所需 recent/status/tail/agents/final-text API integration 通过；
- status/tail 只由 Context Query 提供；recent/workspaces/final-text/agents 只由 Peripheral Agent Query 提供；
- 两个 Query application 均无 mutation。

### 独立审查点

- Query 是否错误地并入 Session 或 Writeback；
- artifact authorization 是否被下放成仅凭 toolCallId 读文件；
- status/tail 与 recent/workspaces/final-text/agents 的 owner 是否存在交叉或转发；
- profile/settings 读取失败策略是否保持；
- recent limit/kind 是否漂移；application `HttpError` 与 status generic 500 bridge 是否符合统一规则。

### 删除条件

- facade 中不再保留 query 领域实现；
- 全局 item id helper 不得替代 visible transcript authorization；
- 仅生产无调用、测试已迁移的 query compatibility helper可列入 P5 删除。

## P3：Route 分组与外围收边

### 实施步骤

- 建立 route auth/transport helpers，注入 internal token，不再调用 `service.getContext()`；
- 按 UI/public、Worker internal、Peripheral internal、Status/SSE 创建分组注册函数；
- 迁移 route，逐项对照 P0 inventory 保持 schema/status/auth；
- revert handler 改为单次 Session application 调用；
- status/tail 改为单次 `ContextQueryApplication` 调用；
- recent/workspaces/final-text/agents 改为单次 `PeripheralAgentQueryApplication` 调用；
- 保持 plugin host unavailable、archive error、status generic error 等 transport bridge；
- 除已冻结 generic/transport bridge 外，route 不新增 domain error 映射；
- 顶层 `registerAgentRoutes` 仅聚合分组；
- 更新 route architecture tests。

### 验证点

- 完整 endpoint inventory 与实际注册一一对应，无漏注册/重复注册；
- Shared Worker endpoints 仍引用 registry；
- SSE headers/heartbeat/chunk/cleanup 保持；
- Plugin/Feishu/API integration 通过；
- route 文件不 import Store/AppContext/fs/path。

### 独立审查点

- 是否只是拆文件但仍把业务规则留在 handler；
- route group 是否按责任而非 internal 前缀机械拆；
- peripheral endpoint 是否误吸入核心 domain；
- status/tail 与 recent/workspaces/final-text/agents 是否调用各自唯一 owner；
- application `HttpError` 是否被 route 重复翻译；
- 鉴权错误顺序和 body-key guard 是否保持。

### 删除条件

所有 route 已迁出旧文件且 inventory/集成测试通过后，才可删除旧单体注册实现；顶层聚合入口可保留。

## P4：Composition、Facade 与 Startup

### 实施步骤

- 建立 composition factory 或在 module 构造 Session/Query/既有 applications；
- 将 `AgentService` constructor 改为接收 application capabilities，不再构造领域对象；
- 建立 local runtime 最小 execution port；
- 建立 `ArchiveStartupSessionQuery` SQLite adapter；
- 建立 `AgentStartupCoordinator` 及 fake-port 单测；
- module 改为构造、route 注册、startup 触发和进程生命周期；
- 保持 Plugin Host 与 Worker manager 的 start/close hook；
- 更新 startup wiring tests。

### 验证点

- module/facade 不 import `agent.store.ts`；
- coordinator 无 DB/fs/domain rule；
- orphan → archive → run 顺序保持；
- fail pre-listen / recover onListen 保持；
- local/remote runtime 主链、Worker process、Plugin Host integration 通过。

### 独立审查点

- composition factory 是否变成新的 all-purpose service；
- facade 是否真正纯委派；
- coordinator 是否复制领域失败策略；
- start/stop 时机、hook 注册顺序是否漂移。

### 删除条件

- `AgentService` 不再保存/暴露完整 `AppContext` 后删除 `getContext()`；
- module 具备 archive startup adapter 后删除 Store import；
- startup 原有内联 try/catch 在 coordinator 测试通过后删除。

## P5：清理、全量回归与终审

### 候选清理项

- `AgentService.getContext()`：必须删除；
- `failRunOnEnqueueFailure()`：仅旧 persistence tests 使用，测试改直接验证 Lifecycle 后删除；
- `cancelSession()` / `cancelSessionCascade()`：仅兼容测试使用时，迁移后删除；
- `getContextItemById()`、latest terminal/completed text facade helper：生产无调用且测试迁移后删除；
- facade 中遗留的 Store import/private helper；
- 旧 route 文件/注册分支；
- module 内联 startup wiring；
- 已无调用的过渡 type/import/comment。

`reconcileArchivePendingForSessionBestEffort()` 等 local runtime/Worker 协作入口只有在全局调用检索和端口迁移证明无使用后才能删除，不预设必须删除。

### 全量验证

- Shared tests/typecheck；
- API 全量测试、plugin service 单独测试、typecheck；
- Worker 全量测试/typecheck；
- Feishu plugin test/typecheck；
- Web test/typecheck；
- root build/typecheck；
- `git diff --check`、未知变更审计、敏感信息检查。

### 最终审查

- 先由本批独立审查员审查清理与回归证据；
- 修复并独立复审；
- 再由未参与 P0-P5 实施的新审查员按本方案做全面终审；
- 差异如更合理可保留，但必须在实施记录中写明与方案差异、证据和理由。
