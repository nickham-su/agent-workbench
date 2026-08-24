# 当前代码地图

> P0 于 2026-04-01 已复核本文件中的 read-side 关键符号、Shared/Route/Worker 调用链和 API fixture 边界。路径/候选组件不是最终目录承诺。

> 本文件记录阶段方案初稿时的静态定位。实施前必须复核符号、规模和调用者；路径/候选组件不是最终目录承诺。

## 上位设计与行为基线

```text
docs/design/0006-Agent模块结构治理总方案/
docs/design/0005-Worker-API读侧与生命周期治理/
```

优先阅读：

- `0006/03-governance-principles-and-scope.md`；
- `0006/04-target-architecture.md`；
- `0006/05-roadmap-and-staging.md`；
- `0006/06-testing-and-validation.md`；
- `0005/03-decisions.md`；
- `0005/04-technical-design.md`；
- `0005/06-testing-acceptance.md`。

## API Agent 主体

### AgentService

```text
apps/api/src/modules/agent/agent.service.ts
```

初稿规模：约 4970 行。

本阶段关键公开方法：

```text
getExecutionProfileForRun()
getPromptContextForRun()
getMessagesContext()
getSingleCallModelProfileForRun()   # 相邻 profile helper，迁移前复核调用面
```

### P0 历史定位（实施前）

P0 以下定位用于冻结迁移前的实现与依赖方向；P6 后的当前权威链见“P3-P6 Read-side / Prompt 最终职责链”，不应将此表中的 `AgentService` 旧职责误读为当前实现。

| 符号/区域 | 迁移前职责 | 关键直接依赖或调用方 |
|---|---|---|
| `getExecutionProfileForRun()`（约 4028） | session/run 归属校验、`resolveExecutionProfile()` 与 runtime 输出组装 | Route execution-profile handler；`getAgentSession`、`getRunRecord`、workspace enablement、runtime settings |
| `getMessagesContext()`（约 4691） | session/workspace 校验、transcript 投影、locale fallback、one-shot system 和 response-only `appendMessage` | Route messages-context handler；`buildPromptMessagesForSession()`、run state、最近 run locale |
| `getPromptContextForRun()`（约 4774） | session/workspace/run 校验、profile、static cache、static+dynamic prompt 合成 | Route prompt-context handler；profile/settings、workspace/skills/files、tool projectors、context/run queries |
| `runPromptStaticCache`（约 2120；使用约 4800） | `Map<runId, { expiresAt, promise }>`；30 分钟 TTL、promise reuse 与访问续期 | `getPromptContextForRun()`；由 `clearRunPromptStaticCache()` 生命周期调用删除 |
| `clearRunPromptStaticCache()`（约 2134） | 删除单一 run 的 static cache | 失败、取消、完成等 run lifecycle 路径；P5 不能把 cache 生命周期反向交给 prompt query 触发 |
| `buildPromptMessagesForSession()` | transcript 与结构化 tool message 投影 | `getMessagesContext()` 和 prompt context 的动态 message 组合；不写 context/head/archive |
| `resolveUiLocaleForSessionContext()` | active run → session latest run → global latest run 的 locale fallback | messages context 与 prompt context；非法 locale 归一化为 locale-neutral fallback |

迁移前，三公开方法共享完整 `AppContext` 和 `AgentService` 内部 helper；这是 P3-P5 的结构热点，不代表 P0 可以提前移动任何生产代码。

相关内部/文件级职责：

- `runPromptStaticCache` 及清理、续期；
- profile/settings 解析；
- prompt template 和 system prompt；
- workspace/Agent instructions；
- top-level skills 与 external roots；
- transcript/messages projection；
- locale fallback；
- tool definitions 与 pending tools；
- compaction snippet；
- 日志与敏感字段边界。

实施关注：

- 精确定位 cache 创建、访问、terminal clear 调用；
- 区分 static 与 dynamic 输入；
- 识别哪些 helper 已经是纯函数、哪些需要 AppContext adapter；
- 确认三个 facade 方法迁移后没有旧实现残留。

本阶段不得迁移的相邻方法：

```text
appendContextItemFromWorker()
updateContextItemFromWorker()
updateRunStateFromWorker()
completeRunFromWorker()
compactContextFromWorker()
archiveSearchFromWorker()
archiveReadFromWorker()
subtask methods
```

### Routes

```text
apps/api/src/modules/agent/agent.routes.ts
```

当前三个 read-side route 已使用：

- `AgentApiEndpoints`；
- Shared request/response schema；
- `assertInternalToken()`；
- `AgentService` 三个 read-side 方法。

1B 原则上只保持/验证这些 handler；Route 全面拆分留到 0006 收尾阶段。

P0 调用链（Route 未额外拼装业务规则）：

```text
AgentApiEndpoints + TypeBox schemas (packages/shared)
  ├─ POST /execution-profile → agent.routes.ts → AgentService.getExecutionProfileForRun()
  ├─ POST /prompt-context   → agent.routes.ts → AgentService.getPromptContextForRun()
  └─ POST /messages-context → agent.routes.ts → AgentService.getMessagesContext()

AgentApiClient (apps/agent-worker) → 同一 AgentApiEndpoints + response schemas
runner.ts → getExecutionProfile() → getPromptContext() → getMessagesContext()
```

### Module / Composition Root

```text
apps/api/src/modules/agent/agent.module.ts
```

本阶段只纳入：

- 构造 Read-side / Prompt 组件；
- 注入 `AgentService` facade；
- 保持 local runtime 与 Worker runtime 装配。

不纳入 startup recovery、orphan scan、archive reconcile 的结构治理。

## P1-P2 Agent testkit 与代表性迁移

```text
apps/api/src/modules/agent/testkit/agent-testkit.ts
apps/api/src/modules/agent/testkit/agent-testkit.test.ts
```

P1 的 testkit 只依赖现有测试基础设施与被测 API 模块，生产模块不反向导入它。代码路径为：

```text
createAgentTestFixture()
  → resolveAgentApiTestRepoRoot()（默认从 apps/api cwd 上溯；其他 cwd 显式 repoRoot）
  → .tmp-tests/ 下 mkdtemp + openDb()
  → 基础 AppContext
  → 可选 createApp() + app.ready()
  → fixture.dispose(): app.close() → db.close() → rmrf(dataDir)

createTestWorkspace()/createTestRepository()
  → workspace/repo/workspace_repo store 写入 + 可见目录

injectJson() → 调用方提供的 Fastify inject
createFakeAgentRuntime() → AgentRuntimePort 的 enqueue/cancel 记录与受控失败
```

P2 调用位置：

```text
agent/read-side.api.test.ts
  → createAgentTestFixture({ withApp: true }) + createTestWorkspace() + injectJson()
  → 私有 configureReadSideDefaults()/createRun()

agent/agent-run-context.test.ts
  → createAgentTestFixture() + fixture.dispose()
  → 保留该文件的 repo-record helper
```

它不纳入 Worker integration 的端口、子进程、socket、HTTP LLM stub、pid-file 或 Plugin Host，也不导出 session/run/prompt/archive builder。P2 后公共面冻结；后续修改必须遵守 1A 重新进入门禁。

## P3-P6 Read-side / Prompt 最终职责链

```text
apps/api/src/modules/agent/read-side/read-side-application.ts
apps/api/src/modules/agent/read-side/execution-profile-resolver.ts
apps/api/src/modules/agent/read-side/messages-context-projector.ts
apps/api/src/modules/agent/read-side/prompt-context-projector.ts
apps/api/src/modules/agent/read-side/read-side-application.test.ts
apps/api/src/modules/agent/read-side/execution-profile-resolver.test.ts
apps/api/src/modules/agent/read-side/messages-context-projector.test.ts
apps/api/src/modules/agent/read-side/prompt-context-projector.test.ts
apps/api/src/modules/agent/prompt/prompt-static-assembler.ts
apps/api/src/modules/agent/prompt/prompt-static-assembler.test.ts
apps/api/src/modules/agent/prompt/run-prompt-static-cache.ts
apps/api/src/modules/agent/prompt/run-prompt-static-cache.test.ts
```

当前依赖方向：

```text
Agent Routes → AgentService public facade
  → ReadSideApplication
      ├─ findSession/findRun callbacks → existing agent.store queries
      ├─ ExecutionProfileResolver
      │   → profile/runtime callbacks → AgentService private settings wrappers
      ├─ MessagesContextProjector
      │   → messages/run-state/locale/system callbacks → AgentService private helpers
      └─ PromptContextProjector
          ├─ RunPromptStaticCache → PromptStaticAssembler
          └─ dynamic messages/run-state/locale/visible-item callbacks

existing terminal lifecycle call site
  → AgentService.clearRunPromptStaticCache()
  → RunPromptStaticCacheInvalidator.clear()
  → RunPromptStaticCache.clear(runId)
```

P6 后 application 负责三个 read-side use case 的归属校验和既有 `HttpError` 400/404 映射；三个 `AgentService` public entry 均为 facade 委派。`PromptStaticAssembler`、`RunPromptStaticCache` 和 `PromptContextProjector` 是 prompt-context 的单一权威链；`getPromptContextForRunLegacy()`、无调用的 `RunPromptStatic` 类型和 `readWorkspaceAgentsInstructions()` 均已删除。assembler/projector 不接收完整 `AgentService`、完整 `AppContext`、Store 或 runtime enqueue/cancel，也没有反向依赖 lifecycle/writeback/archive/subtask。`buildPromptMessagesForSession()` 与 locale helper 暂留 Service 作为窄底层 callback；`prompt/tool-projectors/` 保持原路径、原调用方和原实现。

### Store / Query

```text
apps/api/src/modules/agent/agent.store.ts
```

本阶段只消费现有 session/run/context 查询能力。原则上不进行 Store 全面拆分，不改事务/fence。若为 read-side 提取窄 query capability，只允许包装现有查询，不改变 SQL、排序、窗口或状态语义。

## Prompt 子结构

```text
apps/api/src/modules/agent/prompt/
apps/api/src/modules/agent/prompt/tool-projectors/
```

当前已存在：

```text
prompt/tool-projectors/apply-patch.ts
prompt/tool-projectors/default.ts
prompt/tool-projectors/index.ts
prompt/tool-projectors/types.ts
prompt/tool-projectors/write.ts
```

这是本阶段复用的职责提取先例。需要复核：

- projectors 的输入类型和调用点；
- 是否依赖 service 文件级类型；
- default/apply-patch/write 的 dynamic schema/content 边界；
- 新 prompt 组件是否能复用而非复制。

候选新增职责位置仅作示意：

```text
agent/read-side/*
agent/prompt/*
agent/test-support/*
```

最终路径需遵循项目现有命名和阶段 P0/P3 调研结论。

## Workspace / Settings / Plugin / Filesystem 依赖

### Workspace

```text
apps/api/src/modules/workspaces/workspace.store.ts
apps/api/src/modules/workspaces/workspace.service.ts
```

Read-side / Prompt 当前读取 workspace、instruction、external skill roots。1B 通过最小 reader/adapter 使用，不重构 Workspace 模块。

### Settings / Agent profile

```text
apps/api/src/modules/settings/
```

需要复核 agent/provider/model/runtime/vision/compaction/locale 的真实 resolver 和调用者。1B 不改变 profile 选择或 settings schema。

### Plugin

Read-side 可能读取 plugin tool snapshot/projection。1B 只注入窄读取能力，不治理 Plugin Host、RPC、manager/client 或外围 internal routes。

### Filesystem / paths

```text
apps/api/src/infra/fs/paths.ts
```

本阶段相关读取可能包括 instruction、skill、compaction snippet。必须保持受控路径和既有缺失/读取错误行为；不纳入 archive/artifact 写入治理。

## Shared Contracts

```text
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/src/internal-contracts/agent-api-read.ts
packages/shared/tests/internal-contracts.test.ts
```

本阶段作为稳定边界使用。重点符号：

```text
AgentApiEndpoints.getExecutionProfile
AgentApiEndpoints.getPromptContext
AgentApiEndpoints.getMessagesContext
AgentApiExecutionProfile*Schema / type
AgentApiPromptContext*Schema / type
AgentApiMessagesContext*Schema / type
```

原则上不修改合同文件；任何 contract 变化触发停止和独立设计。

## Worker

### Client

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

关键方法：

```text
getExecutionProfile()
getPromptContext()
getMessagesContext()
request()
formatSafeResponseSchemaErrorPath()
```

1B 只做回归验证；不改变 strict/warn、error mapping 或敏感诊断。

### Runner

```text
apps/agent-worker/src/runtime/runner.ts
apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
```

需要保留 profile/prompt/messages 调用顺序和 auto-compaction/model input 行为。本阶段不迁移 Runner 控制流。

P0 的真实 Worker 集成测试在 API server 侧记录到同一顺序；`messages-context` 不携带 `runId`，其余两个 endpoint 均保持 run-bound。

## API 测试

### Read-side Route 基线（P2 后的当前位置）

`apps/api/src/modules/agent/read-side.api.test.ts` 中的 `read-side internal routes preserve token, body validation, and missing-resource responses` 是 Route 鉴权/请求/资源错误行为的当前权威基线。它由 P2 从 `agent.integration.test.ts` 的同类用例迁移而来；迁移等价证据见 `06-testing-review-acceptance.md` 与 `09-implementation-record.md`。

### 综合集成

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

初稿规模：约 11573 行。当前包含：

- 重复的 dataDir/DB/AppContext/createApp/workspace/repo setup；
- read-side/prompt/profile/locale/settings/plugin 相关用例；
- lifecycle/subtask/archive 等本阶段外用例。

1A 只提取公共最小 fixture；1B 只迁移本域测试，不一次性切割全文件。

### API-managed Worker

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

保留真实 Worker 管理和内部主链证据。其专用进程/socket/setup 不因 1A 强行通用化。

### Context 合同

```text
apps/api/src/modules/agent/context-item-contract.test.ts
```

其 fixture 与综合测试有公共部分，但业务用例主要属于 Context Writeback/Archive。1A 可复用生命周期公共部分；1B 不迁移其合同逻辑。

### P0 fixture 重复与差异

| 测试文件 | 与其他 API Agent 测试重复的基础能力 | 必须保留为当前文件专属的能力 |
|---|---|---|
| `agent.integration.test.ts` | 临时 dataDir、SQLite `openDb()`、`AppContext`、`createApp()`、workspace/repo、fixture 集合与 `afterEach` teardown | 大量跨域数据 builder、fault injection、plugin 服务组合；不应由首批 testkit 全部吸收。 |
| `context-item-contract.test.ts` | 临时 dataDir、SQLite、`AppContext`、`createApp()`、workspace、internal token、`afterEach` 关闭 app/DB 并删除目录 | context/compact handler body 记录和 writeback/archive 断言，属于后续职责域。 |
| `agent.worker.integration.test.ts` | 临时 dataDir、SQLite、`AppContext`、`createApp()`、workspace/repo、teardown | HTTP LLM stub、随机端口、Worker 子进程、socket/pid-file 和进程终止；P1 不得抽为通用 fixture。 |

三个文件的 API fixture 通过 `process.cwd()` 推导仓库根和 `.tmp-tests` 根，相关 API 测试统一从 `apps/api` 执行。P1 只可从表中的重复基础能力形成最小候选公共交集；具体导出、所有权和默认值仍须在 P1/P2 通过实现与审查后冻结。

## 1A 候选 Testkit 能力

以下名称只是能力盘点示意，不表示都要落为公开 helper：

```text
createAgentTestFixture(options)
createWorkspaceFixture(options)
createSessionFixture(options)
createRunFixture(options)
createFakeAgentRuntime(options)
closeAgentTestFixture(fixture)
```

实施默认优先更少、更组合式的底层 helper，例如一个明确拥有 dataDir/DB/app 生命周期的 fixture，加少量显式数据准备函数。准入规则：

- 已有两个以上独立测试文件或已批准批次需要相同语义时，才考虑公共导出；
- 仅服务 read-side profile/prompt/messages 局部测试的 builder 留在领域测试文件附近；
- session/run 可由现有 Store 函数组合且没有明显重复时，不建立额外高层 builder；
- 公共面一旦在 P2 冻结，后续修改按 1A → 1B 门禁重新审查。

## 实施前推荐定位命令

```bash
rg -n "runPromptStaticCache|getExecutionProfileForRun|getPromptContextForRun|getMessagesContext" \
  apps/api/src/modules/agent

rg -n "getExecutionProfile|getPromptContext|getMessagesContext" \
  apps/agent-worker/src/runtime packages/shared/src/internal-contracts

rg -n "createFixture|createApp\\(ctx\\)|mkdtemp|dataDir|AppContext|afterEach" \
  apps/api/src/modules/agent/*.test.ts

rg -n "prompt-context|messages-context|execution-profile|locale|pendingTools|externalSkillRoots" \
  apps/api/src/modules/agent/*.test.ts
```

这些命令只用于复核入口；最终证据应结合源码和运行结果。
