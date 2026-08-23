# 概览、背景与范围

## 需求背景

`0006-Agent模块结构治理总方案` 把 API Agent 模块治理拆成 Read-side、Context Writeback、Run Lifecycle、Subtask、Compaction/Archive 和最后的 Session/Routes/Module 收尾。前五个职责域已经建立显式 application、persistence capability 或 external adapter，但入口层仍保留以下过渡结构：

- `AgentService` 构造并持有多个职责域对象，同时仍直接拥有 Session CRUD、fork、send message、Context Query、run/status 聚合和外围查询规则；
- `agent.routes.ts` 在一个注册函数内混排 UI/public、Worker internal contract、Plugin/MCP/Channel、Feishu adapter 和 SSE；
- `agent.module.ts` 已是 composition root 雏形，但仍直接 import archive reconcile 的 Store 查询，并分别触发多个 startup use-case；
- route 鉴权依赖 `AgentService.getContext()` 暴露完整 `AppContext`；
- `revert` 的 DB 操作和 runtime cancel 仍由 route 做跨域编排；
- `/api/internal/agent/agents/list` 直接在 route 中读取 workspace、settings 和 enablement 并排序。

这些问题不会直接改变产品行为，但会使后续功能无清晰归属，使 facade、routes 和 module 再次膨胀，并削弱前五阶段已经建立的依赖方向。

## 业务目标

- 用户会话相关命令具有唯一、可发现的 Session / Interaction owner；
- context list/item/tail、public run-state、UI artifact read 和 session status summary 具有唯一的 `ContextQueryApplication` owner；
- recent sessions、recent workspaces、run final text 和 available agents 具有唯一的 `PeripheralAgentQueryApplication` owner；
- route 文件结构能表达调用方和合同边界，而不是只表达“都属于 Agent”；
- module 只负责 composition 和进程生命周期，startup 跨域触发有显式、无规则 coordinator；
- 保留现有 API/Worker/Plugin 业务语义，不把结构治理扩张为协议、数据库或 Worker 重构。

## 产品方案

本阶段不新增 UI 或 API 产品能力。对外行为继续保持：

- public UI 仍通过既有 session、context-item、artifact、run-state、message、compact、clear、revert、cancel URL 使用 Agent；
- Worker 仍使用 `AgentApiEndpoints` 与现有 archive/single-call 等 internal endpoint；
- Feishu 等外围调用方仍使用现有 recent/workspace/session create/trigger/final-text/agents/status/tail/SSE endpoint；
- 所有既有 request/response schema、HTTP status、错误码、token/header 校验与 SSE 格式保持。

产品侧唯一可见目标是“无行为变化”；本阶段收益是后续开发能根据用例直接找到 owner，并能用架构测试防止入口层重新承载业务规则。

## 本阶段纳入范围

### Session / Interaction

- workspace/session 查询与 primary session list/create；
- public primary fork 的 application owner 迁移；
- `sendMessage()` 的用户命令前置校验、非权威 fast path、profile 选择和 lifecycle 调用；
- `revert` 的校验、head CAS/move、结果读取和 runtime cancel sequencing；
- public/internal primary create 与 run trigger 复用同一 application 入口；
- 为 Subtask 提供的 session materialization 能力保持窄 port，不把 Subtask 业务收回 Session。

### Context Query

- context list/item/tail；
- public run-state read model；
- UI apply_patch/write artifact read authorization；
- session status summary；
- context tail 虽由 Feishu/外围 internal route 调用，核心规则仍是 transcript tail query，owner 不随调用方改变；
- status summary 的主体是 session/run projection；如需 agent display name，只依赖窄 `AvailableAgentQuery` collaborator，不调用完整外围 query application。

### Peripheral Agent Query

- recent sessions；
- recent workspaces；
- run final text；
- available agents；
- `PeripheralAgentQueryApplication` 只拥有上述外围 projection/query 规则，不得持有完整 `ContextQueryApplication` 做转发。

### Routes

- 将单体 `registerAgentRoutes` 拆为责任明确的注册组；
- 去除 route 中的业务编排和完整 `AppContext` 访问；
- 保持 Shared registry 对核心 Worker internal route 的唯一合同来源；
- 保持外围 internal route 为独立适配层，不吸入核心职责域。

### Module / Composition / Startup

- 定稿薄 facade；
- 构造 SessionInteraction、ContextQuery、PeripheralAgentQuery 与既有 A-E applications；
- 建立 `AgentStartupCoordinator`；
- 将 archive startup session listing 移入命名 adapter；
- 保持 local/remote runtime、Worker/Plugin Host start/stop 与 Fastify hook 时机。

### 清理

- 删除经调用检索、测试迁移和 typecheck 证明无使用的 facade helper；
- 清理 route/module/facade 对 `agent.store.ts` 的直接 import；
- 删除 `AgentService.getContext()`；
- 更新 facade/wiring/architecture tests 和代码地图。

## 明确排除项与非目标

- 不修改 URL、HTTP method、schema、status code、错误码或 Shared contract；
- 不修改 DB schema，不将 `agent.store.ts` 全量 repository 化；
- 不改变 run activation transaction、dedup、enqueue failure、cancel cascade、recovery 或 writeback fence；
- 不改变 fork、subtask lineage/depth、archive、compaction、sidecar、prompt/read-side 产品语义；
- 不重写 Worker Runner，不引入 Worker/Plugin Host 通用 transport；
- 不把 Plugin/MCP/Channel operational endpoints 深度治理为新领域；
- 不把 `UiArtifactCapability` 扩展为通用文件服务，不改变文件格式或安全策略；
- 不引入全局 DI 框架、service locator、event bus 或通用 route DSL；
- 不以“清零所有 Store import”为目标：命名的 SQLite persistence/query adapter 可继续复用原子 Store helper。

## 系统边界

| 系统/层 | 本阶段动作 | 不得发生 |
|---|---|---|
| Shared | 只复用既有类型与 endpoint registry | 新增/修改核心合同 |
| API Agent | Session、Query、route、module 收尾 | 改产品语义或事务 |
| Worker | 仅回归验证 | 修改 Runner 或调用顺序 |
| Plugin/Feishu | 仅验证现有外围 endpoint | 修改协议或业务交互 |
| Web | 仅验证 public API 兼容 | UI redesign |
| DB/filesystem | 复用既有 capability | schema/格式迁移 |

## 退出标准

- 新需求可以依据“Session command / Context Query / Peripheral Agent Query / 已有 A-E domain / Peripheral operational adapter”得到唯一归属；
- route reviewer 不需要阅读 Store 或领域 SQL 即可确认 handler 只做 transport；
- startup reviewer 能从 coordinator 明确看到顺序，但领域规则仍只存在于对应 application；
- facade 方法清单与保留理由可审计，没有“先放进 AgentService 以后再说”的入口；
- 结构迁移前后的行为测试结果一致。
