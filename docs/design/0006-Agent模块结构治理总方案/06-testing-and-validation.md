# 测试与验证策略

## 目标

测试治理采用“两步但不分离”的推进方式：

- 先进行一次时间受限的 testkit 前置使能，只建立多阶段共同需要的最小 fixture、fake runtime、清理和运行约束；
- 之后测试用例、fixture 扩展、fault seam 和文件结构必须随对应生产职责域同步迁移。

testkit 起步不是长期独立测试重构项目，不得在脱离生产结构治理的情况下持续扩大抽象面。测试治理的目标不是单纯拆小测试文件，而是建立与职责域对应、同时保留真实集成证据的验证结构。

测试体系需要同时回答：

- 单个职责域规则是否正确；
- 关键 DB 原子边界是否保持；
- route/schema/auth/error 映射是否保持；
- API↔Worker Shared contract 是否一致；
- runtime、文件系统和 startup 时序是否保持；
- UI 可观察行为是否无回归。

## 当前测试基线

初稿调研识别的关键测试包括：

```text
packages/shared/tests/internal-contracts.test.ts

apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts

apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
apps/agent-worker/src/runtime/tools/providers/builtin.prefork.test.ts
apps/agent-worker/src/runtime/tools/providers/builtin.scratchpad-toggle.test.ts
```

0005 已通过的构建、类型检查和测试命令应作为后续阶段的最低回归参考。API 集成测试存在 cwd 约束，阶段方案应优先从 `apps/api` 执行相关 fixture 测试，不能将 cwd 配置问题误判为实现回归。

## 目标测试分层

## Shared contract tests

验证：

- endpoint registry；
- request/response schema；
- public export；
- normal/ignored union；
- stable envelope 和动态 payload 边界。

适用范围：

```text
packages/shared/tests/internal-contracts.test.ts
```

结构治理默认不修改合同；若移动 API 实现却导致 Shared tests 变化，必须解释是否发生了未经批准的合同改变。

## Persistence behavior tests

验证不可被 service mock 掩盖的 DB 规则：

- append/update fence；
- head CAS/conflict；
- ownership；
- terminal 单向收敛；
- cancel cascade DB 收敛；
- recover candidate/final fence；
- subtask lineage 查询；
- orphan 删除前二次确认；
- compaction summary/archive 标记原子行为。

这类测试可直接使用 SQLite fixture 和 persistence capability，不必总是通过 HTTP。但至少保留对应的 route/service 主链测试。

## Domain use-case tests

围绕目标职责域验证应用编排：

- read-side / prompt；
- context writeback；
- run lifecycle；
- subtask；
- compaction/archive；
- session/interaction。

可使用：

- 真实 SQLite；
- fake runtime；
- 受控 clock/id；
- 临时 filesystem；
- 组件级 fault hook。

不得通过过度 mock Store 返回值来替代关键事务行为。

## Route integration tests

验证：

- method/path；
- schema；
- auth/internal token；
- HTTP status/error body；
- route 到 use-case 的连接；
- SSE/streaming transport。

Route 测试不应重复全部领域边界组合，但必须保留每类入口的代表性成功、失败和权限证据。

## API↔Worker integration tests

验证真实 API-managed Worker 链路：

- Shared endpoint 使用；
- runtime response validation；
- prompt/messages/profile 读取；
- context writeback；
- cancel；
- compact；
- subtask（能力可用时）。

这些测试是防止“API 内部测试都通过，但 Worker 主链已断”的关键证据，不得被全 mock client 替代。

## Worker runtime tests

继续验证：

- streaming/tool output；
- auto-compaction；
- provider/subtask cancel；
- builtin tool 行为；
- api client strict/warn 与错误映射。

API 结构治理期间原则上不重写这些测试，只在 port/type 迁移确有需要时做最小同步。

## UI 手工验收

涉及 session/run/status/routes/runtime 的阶段，至少评估以下手工回归是否需要执行：

- 基本多轮对话；
- 流式输出；
- 取消当前运行；
- 取消后立即新运行，旧运行不恢复写回；
- 手动压缩后继续对话；
- 页面刷新和多会话切换；
- subtask；
- artifact 展示。

纯内部 helper 移动不一定每批都做完整 UI 验收，但阶段完成时需说明为什么可豁免。

## Agent testkit 设计原则

testkit 的初始交付只覆盖跨阶段最小公共能力。某个领域专属 builder、fault hook 或断言 helper 应在该领域生产结构进入治理时同步加入，而不是提前预测并一次性建设。

### 建议能力

公共 Agent testkit 可逐步提供：

- 临时目录和 SQLite 生命周期；
- 基础 `AppContext` 构造；
- `createApp()` fixture；
- workspace / repository fixture；
- session / context item / run / run-state builder；
- subtask lineage builder；
- archive/pending sidecar builder；
- fake runtime 与 enqueue/cancel 观测；
- 可控 clock/id；
- 常用 HTTP request helper；
- 统一 teardown。

### 约束

- testkit 只能位于测试目录或明确 test-support 边界；
- 默认值必须可见，避免隐式创建过多业务实体；
- fixture builder 应允许显式覆盖状态；
- 不提供“万能 createEverything()”掩盖场景；
- 不模拟 SQLite 的事务/fence；
- 真实 API/Worker 测试不得完全改成 fake；
- teardown 必须处理 DB、进程、socket、临时文件。
- testkit 不得脱离职责域迁移长期独立演进；无法关联明确生产治理阶段的扩展应暂停并重新评估。

## Fake runtime 与进程 seam

目标 fake runtime 应最小实现：

```text
enqueueRun(run)
cancelSession(sessionId)
```

并记录：

- 调用顺序；
- run/session identity；
- 可配置失败；
- 可控制 enqueue 前后的 hook，用于 recovery/cancel race。

不得直接依赖 `AgentRuntime` 私有队列状态来测试 application lifecycle。真实本地 fallback runtime 仍应有独立集成测试。

Worker/Plugin Host 进程测试 seam 需要按各自生命周期保持，不因表面重复强行统一。

## Fault injection 治理

### 当前问题

`AppContext.agentTestFaults` 已用于 archive write/rollback/sidecar。它证明故障测试价值，但不能成为所有 Agent 领域的全局开关集合。

### 目标方向

在 compaction/archive 阶段，将故障控制迁移为对应组件的受限依赖，例如：

```text
ArchiveFaultHooks（仅测试注入）
  before/after write chunk
  before rollback stat/truncate
  before sidecar write/rename
```

具体 API 由阶段方案决定。要求：

- 生产默认无 hook；
- hook 不进入业务合同；
- 不记录敏感 payload；
- 不允许任意执行生产对象内部状态；
- 仅为可验证的故障点存在。

## 大测试文件迁移策略

`agent.integration.test.ts` 不应一次性按行数切割。建议随职责域生产代码迁移，逐步形成候选文件：

```text
agent-session-interaction.integration.test.ts
agent-read-side.integration.test.ts
agent-context-writeback.integration.test.ts
agent-run-lifecycle.integration.test.ts
agent-subtask.integration.test.ts
agent-compaction-archive.integration.test.ts
agent-routes.integration.test.ts
```

文件名不是强制规范。迁移必须绑定对应生产职责域阶段：

- 相关用例与生产域同批移动；
- 公共 setup 进入 testkit；
- 原综合文件保留尚未迁移的用例；
- 禁止复制同一测试到新旧文件后长期双跑；
- 迁移完成需确认 test count/coverage 没有无意下降。

`context-item-contract.test.ts` 可根据最终职责分为 writeback contract 与 archive fault behavior，但必须避免把 archive 文件故障误归为纯 context DTO 测试。

## 阶段验证矩阵

每个阶段方案应从下表选择并细化：

| 验证层 | 必选条件 | 证据 |
|---|---|---|
| build/typecheck | 所有阶段 | 根或相关 workspace 命令结果 |
| Shared contract | 涉及 internal contract/Route/Client | schema/export tests |
| Persistence | 涉及 DB helper/Store | 真实 SQLite 行为测试 |
| Domain use-case | 新增/迁移职责域组件 | 成功、失败、边界、竞态测试 |
| Route integration | route 或 public entry 变化 | HTTP method/schema/status/auth |
| API↔Worker | 主运行链或 internal endpoint 变化 | 真实 Worker fixture |
| Worker runtime | Worker type/control flow 变化 | runner/apiClient/provider tests |
| Filesystem fault | archive/artifact 变化 | temp filesystem + fault hooks |
| UI manual | 用户可见 session/run/status 行为变化 | 手工验收记录 |
| architecture review | 所有结构阶段 | 依赖方向与双实现检查 |

## 架构验证清单

独立审查除功能测试外，还应检查：

- 新职责域是否获得完整 `AppContext` 而没有必要；
- route 是否直接 import 多个 store 函数；
- facade 是否新增规则而不是委派；
- 是否产生循环依赖或 service locator；
- 同一 fence/cache/lineage/reconcile 是否出现双实现；
- Store 原子 helper 是否被拆成先读后写；
- testkit 是否隐藏了关键状态；
- 是否删除了真实 API↔Worker 证据；
- 是否把后置目标顺手混入；
- 是否更新代码地图和阶段设计差异。

可在结构稳定后评估 lint/import-boundary 工具，但当前不以引入新工具作为前提。首先通过目录、显式 export 和审查建立边界。

## 回归基线

后续阶段至少保留以下 0005 语义回归：

### Read-side

- 三接口 Shared endpoint/schema/type；
- Worker success response strict/warn validation；
- validation warning 脱敏；
- prompt cache 和 prompt/messages 内容不变。

### Writeback

- normal create 返回完整 record；
- late append 返回 `item:null,ignored:true`；
- 不创建 item、不推进 head、不触发副作用；
- non-existent run `404`；
- head conflict `409`；
- update ownership/terminal 单向约束。

### Lifecycle

- cancel DB 收敛优先；
- runtime cancel best-effort；
- recover enqueue 前最终 DB check；
- enqueue failure 不阻塞启动。

### Subtask

- durable lineage；
- existing reuse 安全；
- local compensation 只处理本次新建空壳；
- orphan suspect/cleanup 边界。

### Archive

- rollback skipped 才写 sidecar；
- tmp + rename；
- single-file exact-size reconcile；
- multi-file 保留且不 truncate；
- 单个异常不阻塞启动。

## 测试完成标准

单个治理阶段只有在以下条件满足时才可结束：

- 迁移前关键测试仍存在或有明确替代；
- 新职责域有针对性行为测试；
- 受影响 route/Worker/文件链路有集成证据；
- build/typecheck 与相关测试通过；
- 独立审查确认测试没有因抽象而失真；
- 没有通过删除断言、扩大 `any` 或降低 schema 精度解决迁移问题；
- 测试文件和 fixture 的职责比阶段前更清晰，而不是仅改变路径。
