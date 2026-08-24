# Testkit 与 Fixture 设计

## 目标

测试拆分不能通过复制旧 `createFixture()` 来完成。目标是建立以下分层：

```text
agent-testkit.ts
  └─ 通用 Agent 测试基础：SQLite / AppContext / Fastify / workspace / repo / inject / runtime fake

agent-integration-testkit.ts（候选）
  └─ 综合 HTTP 集成默认初始化：真实 app、默认 workspace、默认 Agent/provider、allowlist、session/message helper

领域 helper（按需）
  ├─ subtask integration helper
  ├─ context-writeback integration helper
  ├─ archive integration helper
  └─ prompt integration helper
```

核心原则：基础 testkit 负责资源和稳定基础设施，integration testkit 负责多个语义文件共同需要的测试初始化，领域 helper 负责窄调用链。禁止形成新的万能巨型 testkit。

## 现有基础能力

[`agent-testkit.ts`](../../../apps/api/src/modules/agent/testkit/agent-testkit.ts) 已经是本专项的基础，不新建第二套底层 fixture。

其稳定能力包括：

- 解析从 `apps/api` 执行时的仓库根目录；
- 创建唯一临时目录；
- 打开真实 SQLite；
- 构造真实 `AppContext`；
- 可选创建并 ready 真实 Fastify app；
- 创建 workspace 和 repository；
- 显式 internal JSON inject；
- 创建 runtime fake；
- 幂等 `dispose()`，并聚合多个清理异常。

现有 `dispose()` 语义必须保留：

- 重复调用安全；
- 即使 app close 失败，仍继续 DB close 和 dataDir 删除；
- 多个清理失败可诊断；
- fixture 初始化中途失败也尽量完成清理。

## Fixture 所有权

### 每测试独立

每个测试必须独立拥有：

```text
真实 SQLite DB
真实 AppContext
真实 Fastify app（需要 route 时）
唯一 dataDir
唯一 workspace / workspacePath
唯一 worker/plugin-host socket path
```

不得出现：

- 多个测试共享一个 DB；
- 多个文件共享一个 app；
- 跨文件共享全局 `Set<Fixture>`；
- 跨文件共享 `WeakMap<FastifyInstance, Fixture>`；
- 固定临时目录或固定 socket path；
- 测试依赖前一个测试创建的数据。

### 显式 teardown

优先候选模式为每测试注册 teardown：

```ts
test("...", async (t) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => {
    await fixture.dispose();
  });

  // test body
});
```

对 SSE、Plugin Host、stream reader、额外 client/process 等特殊资源，仍应使用局部 `try/finally`，先释放场景资源，再调用 fixture `dispose()`。

P0 必须实测当前 Node/tsx runner 对异步 `t.after()` 的行为。如果结果不稳定，可采用每测试 `try/finally`；无论采用哪种方式，都不得退回跨文件共享单例。

### 不建议的模式

```ts
const fixtures = new Set();
afterEach(() => disposeEverythingAcrossFiles());
```

即使该模式在单文件内可工作，也会隐藏资源归属并增加多文件并发风险。

## `AgentIntegrationFixture` 候选形态

候选扩展类型：

```ts
type AgentIntegrationFixture = AgentTestFixture & {
  app: FastifyInstance;
  workspaceId: string;
  workspacePath: string;
};
```

候选构造器：

```ts
createAgentIntegrationFixture(options?: AgentIntegrationFixtureOptions)
```

P0 可评估的最小选项：

```text
repoRoot
agentWorkerConcurrency
enablePluginHost
enablePluginServices
agentTestFaults
initialGlobalPrompts
app customization / route probe seam
```

这些只是候选，不应一次性全部加入全局 API。纳入通用 options 必须同时满足：

- 原测试确实已有该 seam；
- 至少多个测试文件稳定复用，或它是构造 fixture 前必须提供的配置；
- 选项不包含领域规则；
- 选项不会要求修改生产 `AppContext`；
- 名称表达测试基础设施，而不是某个具体用例。

特别约束：

- `p0SchemaOnlyProbe` / `p0PreValidationProbe` 属于 route contract 场景，优先通过文件本地 `appFactory` 或局部 route 注册实现；
- `agentTestFaults` 只能透传现有测试 seam，不新增生产字段；
- global prompts 预置若仅少数 global prompt 测试使用，应由该领域在 app 创建前通过窄 factory/helper 注入，不默认扩张通用 fixture。

## 默认初始化

旧综合 fixture 在 app ready 后统一执行：

- 默认 Agent/provider/settings 配置；
- 默认 Feishu sender allowlist；
- 默认 workspace 创建。

目标 fixture 应保留等价初始化，但拆成明确步骤：

```text
createAgentTestFixture({ withApp: true, ... })
  → createTestWorkspace(...)
  → configureDefaultAgentSettings(...)
  → configureDefaultChannelAllowlist(...)
  → return AgentIntegrationFixture
```

候选稳定 helper：

- `configureDefaultAgentSettings()`；
- `configureDefaultChannelAllowlist()`；
- `createAgentIntegrationFixture()`；
- `createPrimarySession()`；
- `sendAgentMessage()`。

默认初始化不得悄悄创建 run、context item 或改变 run-state。需要这些副作用的 helper 必须放在领域层并显式命名。

## 通用 integration helper 边界

### 可以进入 `agent-integration-testkit.ts`

| 能力 | 理由 |
|---|---|
| 创建 ready 的真实 app fixture | 几乎所有 HTTP integration 文件需要 |
| 创建默认 workspace | 广泛稳定复用 |
| 配置默认 Agent/provider | 广泛稳定复用，属于基础前置 |
| 配置默认 channel allowlist | 多个外围测试使用，且是旧默认 fixture 行为 |
| create primary session | 稳定 public route helper |
| send message | 稳定 public route helper |
| explicit internal JSON inject | 优先复用已有 `injectJson()`，不重复实现 |

### 不应进入通用 testkit

| 能力 | 目标归属 |
|---|---|
| Subtask anchor/session/start/result | `subtask` 窄 helper |
| Direct composition/service seam | startup/subtask 文件局部 helper |
| Context item create/update + 自动 run-state | context-writeback 窄 helper |
| Prompt section parser | prompt 文件本地 |
| Archive search/read/compact | archive 窄 helper |
| SSE reader/abort | SSE 文件本地 |
| Plugin Host mock plugin/process client | Plugin Host 文件本地 |
| P0 schema/preValidation probes | Session/Subtask route 文件本地 |
| 特定 provider remote model mock | Settings/Profile 文件本地 |

## 领域 helper 设计

### Subtask helper

候选文件：

```text
apps/api/src/modules/agent/integration/subtask-integration.helpers.ts
```

只在至少两个 Subtask 测试文件确实复用时创建。候选能力：

- `createSubtaskSessionForTest(fixture, ...)`；
- `createSubtaskAnchor(fixture, ...)`；
- `startSubtaskForAnchor(fixture, ...)`。

不得加入 Prompt、Archive 或一般 Session helper。

### Context writeback helper

实际文件：

```text
apps/api/src/modules/agent/integration/context-writeback.helpers.ts
```

P3 已落地的窄能力：

- `createP3Fixture(t, ...)`；
- `createSession(app, workspaceId)`、`sendMessage(app, ...)`；
- `createContextItemInternal({ fixture, ... })`；
- `updateContextItemInternal({ fixture, ... })`；
- `updateRunStateInternal({ fixture, ... })`。

必须把旧 helper 的 `app -> fixtureByApp` 隐式查询改为显式 `fixture` 参数。调用者应能从签名看到 DB、workspace、run-state 依赖。

为保持旧测试状态准备等价，`createContextItemInternal()` 保留“若无 run 则临时创建、必要时临时推进 run-state，并在 internal route 调用后恢复”的行为；该副作用应保持局限于这个领域 helper。不得扩展为无说明的通用状态机；若后续调整，应：

- 在函数名或注释中写明副作用；
- 有明确调用者清单；
- 迁移前后测试状态准备等价；
- 审查确认没有改变断言前置条件。

### P4 fixture helper

实际文件：

```text
apps/api/src/modules/agent/integration/p4-fixture.helpers.ts
```

P4 已落地的窄能力：

- `createP4Fixture(t, options?)`；
- 普通场景直接复用 `createAgentIntegrationFixture(...)`；
- 仅在 app ready 前必须注入 `agentTestFaults.archiveWrite` 或预置/修复 global prompts settings 时，走局部预 app 初始化路径。

该文件不承载 Prompt、Archive、Artifact 或 Global/Workspace 的领域断言、请求 helper 或文件系统流程；这些能力仍就近保留在各语义测试文件中。不得将这两类 P4 特殊前置扩张进 `agent-integration-testkit.ts`，也不得把它发展为跨领域状态机。

### Archive helper

只有 Archive/Compaction 与少数 Prompt 测试共同复用时才建立，候选能力：

- compact internal request；
- archive search/read request；
- 明确的 typed result。

Artifact 文件 I/O 不应因此进入 Archive helper。

### Prompt helper

默认就近保留：

- `extractPromptSection()`；
- prompt-context request；
- prompt tool message assertions。

除非两个 Prompt 文件存在稳定复用，否则不新建 prompt utility bag。

## Helper API 质量要求

所有共享 helper 必须满足：

- 入参显式，不通过全局 map 查 fixture；
- 名称反映真实副作用；
- 失败消息包含 route/body 等足够诊断信息，但不输出敏感内容；
- 不复制生产规则；
- 不用 helper 隐藏核心断言；
- 不为了减少测试行数而创建复杂 DSL；
- 不返回 `any`；
- 不持有跨测试可变状态；
- 不启动未由 fixture `dispose()` 或局部 finally 管理的资源。

## 并发与资源隔离

P0 必须实测以下内容：

- 多个新测试文件是否并发执行；
- 同文件测试是否按当前 Node test 默认行为执行；
- `{ concurrency: false }` 在迁移后是否保持；
- 唯一 dataDir 和 socket 是否避免资源冲突；
- Plugin Host 测试是否需要单独命令或 runner concurrency 约束；
- SSE 测试 teardown 是否会留下未完成 reader/body；
- 全部 fixture 是否在失败路径释放；
- 多文件总耗时是否明显高于旧单文件。
- Archive rollback 等测试内部创建第二 fixture 时，所有内部请求/状态前置必须显式绑定该 fixture，不能误用外层 fixture。

只有得到实际结果后，才能冻结 package script。不能在方案中预先认定 glob、shell expansion 或 runner flags 在所有环境都稳定。

## 防止 testkit 再次膨胀

审查应拒绝以下信号：

- `agent-integration-testkit.ts` 开始 import 多个领域 application/store；
- options 不断加入只服务单个测试的开关；
- helper 同时处理 session、run、context、archive 和 subtask 状态；
- 一个 helper 内部按参数选择多个不同业务流程；
- 新测试必须先理解整个 testkit 才能判断前置状态；
- testkit 行数快速接近原本的领域测试文件；
- 为了“复用”把测试核心断言搬入 helper。

触发上述情况时，应将 helper 移回场景文件或拆成窄领域 helper，而不是继续扩张全局层。
