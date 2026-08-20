# 阶段实施记录

> 状态：P0-P6 已实现并完成实现者测试、批次级独立审查/复审闭环；新审查视角的阶段最终全面审查及最终复审均已通过。当前 Git index/worktree 仍为累计阶段变更，尚未提交或推送。
> 用途：为 P0-P6 提供稳定的运行结果、门禁、审查和偏差索引。本文件不替代长期设计基线、代码地图或自动测试。

## 记录规则

- 长期有效的行为事实更新 `02-baseline-and-evidence.md`；
- 路径、符号和调用链更新 `07-code-map.md`；
- 可执行行为证据落到对应 Shared/API/Worker 测试；
- 本文件只记录命令、cwd、结果摘要、测试索引、审查结论和方案偏差索引；
- 不复制 token、apiKey、完整 prompt/messages、tool args/result、archive 内容或敏感绝对路径；
- 每个批次开始前先复核最近一次门禁记录；每次重新进入 1A 都追加新的复审记录，不覆盖历史事实。

## 当前实际状态与 Git 口径

批次级审查/复审结论与阶段级最终全面审查不是同一事项：前者验证单一批次是否可关闭，后者须在 P6 后以新审查视角检查全阶段与 `0005`、`0006`、本方案的一致性。

| 批次 | 实现与实现者测试 | 批次级独立审查 | 修复 | 批次级独立复审 | 暂存状态 |
|---|---|---|---|---|---|
| P0 | 已完成 | 初审发现 H1/H2/M1/L1 问题 | 已修复 H1/H2/M1/L1 | 通过 | 可能包含在累计 index，不能作为本批证明 |
| P1 | 已完成 | 初审发现初始化失败清理不够鲁棒 | 已修复清理顺序、原始错误保留及自验证 | 通过 | 同上 |
| P2 | 已完成 | 初审发现组合回归结果记录不准确 | 已更正为 `166 passed, 0 failed` | 通过 | 同上 |
| P3 | 已完成 | 初审通过 | 不适用 | 不适用（初审通过） | 同上 |
| P4 | 已完成 | 初审发现命令结果对应与 ownership 表述不够精确 | 已拆分命令记录并澄清 application/legacy 边界 | 通过 | 同上 |
| P5 | 已完成 | 初审通过 | 不适用 | 不适用（初审通过） | 同上 |
| P6 | 已完成 | 本轮发现 Git 当前状态、facade 直接委派证据及 ownership 文档表述需补齐 | 已补充 facade 委派测试，并修正文档记录 | 通过 | 当前为累计阶段变更；存在 staged/worktree 变更及未跟踪 facade 测试，以 `git status --short` 为准 |

当前状态（本轮验证后）：已有 P0-P6 的累计 staged 变更；本轮新增未暂存的 `apps/api/src/modules/agent/agent.service.facade.test.ts`，并继续修改部分已 staged 阶段文档，故当前同时存在 staged 与 unstaged 变更，部分文档显示 `MM`。本轮不执行 `git add`。

历史背景：此前后续批次曾继续修改与累计 index 相同的 `agent.service.ts`、`agent.integration.test.ts` 和阶段文档路径，因此 `git status` 在当时可能显示 staged + unstaged（`MM`）混合状态。这一历史情况不能划分可靠批次边界，也不能证明审查、复审或按批暂存已经完成。后续如获明确暂存授权，必须先分别复核 `git diff --cached`、`git diff` 与 `git status --short`。

## P0 基线索引

### 文档更新

| 项目 | 权威位置 | 状态/摘要 |
|---|---|---|
| contract / HTTP /错误基线 | `02-baseline-and-evidence.md` | 已复核：三个 `POST` Shared endpoint，以及无效 token + 无效 body 返回 `401`、有效 token + 无效 body 返回 `400` 的可观察行为；messages 为 session-bound，profile/prompt 为 run-bound。 |
| prompt/cache/messages/profile 基线 | `02-baseline-and-evidence.md` | 已复核：runId cache key、30 分钟 TTL、promise reuse/访问续期、lifecycle terminal clear、static/dynamic 分界、locale/appendMessage/reasoning 边界。 |
| 路径、符号、调用链 | `07-code-map.md` | 已复核：Service 三入口、cache/clear、Shared → Route → Service → Worker client/Runner 映射以及 fixture 重复/专属边界。 |

### 自动测试证据索引

| 行为 | 测试文件 / 用例 | 状态 |
|---|---|---|
| Shared read-side contract | `packages/shared/tests/internal-contracts.test.ts`：`agent-api endpoint registry contains all twelve method/path definitions`；`agent-api aggregate export exposes read-side schemas with stable shells and dynamic payloads`；`agent-api read-side schemas reject invalid stable fields without constraining dynamic payloads` | 已执行，通过（14/14）。 |
| Route 鉴权/请求/资源错误行为 | `apps/api/src/modules/agent/read-side.api.test.ts`：`read-side internal routes preserve token, body validation, and missing-resource responses` | 已执行；P2 从 `agent.integration.test.ts` 的原基线用例迁移，等价迁移说明见“代表性迁移”和 `06-testing-review-acceptance.md`。 |
| Execution profile 归属与输出 | `agent.integration.test.ts`：`agent runtime settings 可通过 execution-profile 下发`；`openai provider apiMode 会在 settings 与 execution-profile/single-call profile 中透传`；`subtask session 的 execution-profile 按 subtask surface 校验`；`run 创建后若 agent scope 改为不允许, execution-profile 会返回明确错误` | 已执行，包含在通过的 158/158 API 集成用例中。 |
| Read-side 只读边界 | `agent.integration.test.ts`：`read-side execution-profile 与 prompt-context 不修改已有 run、session 或 context`；`agent messages-context 返回完整 messages 且支持 appendMessage` | 已执行：前者逐项比较两个 run-bound endpoint 前后的 session、run、run state、transcript；后者断言 appendMessage 后 transcript 与 run state 不变。 |
| Messages 顺序、reasoning 过滤、appendMessage 不落库与 locale | `agent.integration.test.ts`：`agent messages-context 返回完整 messages 且支持 appendMessage`；`assistant reasoning 不应进入 prompt-context`；三个 `agent messages-context ... uiLocale ...` 回退用例 | 已执行，包含在通过的 158/158 API 集成用例中。 |
| Prompt cache key/reuse/clear | `agent.integration.test.ts`：`prompt-context reuses one run static promise and clears it when the run reaches a terminal status` | 已执行，包含在通过的 158/158 API 集成用例中。 |
| Prompt 动态 payload | `agent.integration.test.ts`：prompt locale、depth/subtask tool、compaction snippet、structured tool-call/tool-result、global/workspace/agent prompt 与 skill cache 用例 | 已执行，包含在通过的 158/158 API 集成用例中。 |
| Worker client Shared contract / strict-warn | `apps/agent-worker/src/runtime/apiClient.test.ts`：三个 `read-side methods ...` 用例 | 已执行，通过（20/20）。 |
| Route / API-managed Worker 主链及顺序 | `apps/api/src/modules/agent/agent.worker.integration.test.ts`：`worker 模式: 手动压缩经真实 API-managed Worker 获取三项 read-side context` | 已执行，通过（3/3）；断言 execution profile → prompt context → messages context。 |
| Runner messages context / compaction 输入 | `apps/agent-worker/src/runtime/runner.auto-compact.test.ts`：`generateCompactionSummary 透传 messages-context.system 到单次调用`；`generateCompactionSummary 使用 messages-context 追加压缩提示词` | 已执行，通过（22/22）。 |

### 运行结果

| 日期 | 批次 | cwd | 命令 | 结果摘要 | 失败/Artifact 定位 |
|---|---|---|---|---|---|
| 2026-04-01 | P0 | `packages/shared` | `npx tsx --test tests/internal-contracts.test.ts` | 14 passed, 0 failed（约 0.26s） | - |
| 2026-04-01 | P0 | `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts` | 158 passed, 0 failed（复跑约 36.4s）；测试预期的 fault-injection error 日志不影响退出码 | - |
| 2026-04-01 | P0 | `apps/api` | `npx tsx --test src/modules/agent/agent.worker.integration.test.ts` | 3 passed, 0 failed（约 8.2s） | - |
| 2026-04-01 | P0 | `apps/agent-worker` | `npx tsx --test src/runtime/apiClient.test.ts` | 20 passed, 0 failed（约 0.40s） | - |
| 2026-04-01 | P0 | `apps/agent-worker` | `npx tsx --test src/runtime/runner.auto-compact.test.ts` | 22 passed, 0 failed（约 0.37s） | - |

### P0 门禁结论

- 实现与测试：已完成。P0 允许范围内的静态事实、可执行 read-side contract/Route/Worker 证据、正确 cwd 和 fixture 差异均已记录；本批未移动生产逻辑，未提取 testkit，未改变 Shared/HTTP contract。
- 批次级独立审查：初审发现 H1/H2/M1/L1 问题。
- 修复与批次级独立复审：H1/H2/M1/L1 已修复，复审通过。
- 阶段级关系：该批次结论不替代 P6 后的最终全面审查或最终复审。
- 未覆盖点：本批没有单独运行 `context-item-contract.test.ts`，因为它不是 read-side 回归且会混入 writeback/archive；仅将其 fixture 与综合/Worker fixture 做静态对比。P1 必须在实现最小公共 fixture 后，以代表性迁移补足其生命周期/清理等价证据。
- P1 最小公共交集：仅候选临时 dataDir、SQLite、基础 `AppContext`、可选 `createApp()`、workspace/repository 基础准备及有明确所有权的 teardown；HTTP LLM stub、端口、Worker 子进程/socket/pid-file、跨域 builder 与 fault injection 仍为文件专属。公共导出和默认语义尚未冻结。
- 运行矩阵取舍：初次 P0 执行过 `runner.tool-output.test.ts`（32/32 通过），但其断言的是工具输出、并发分段和 artifact 行为，不能直接证明本批 read-side contract、cache 或 Runner 对 API context 的消费；为避免让无关通过结果充当 P0 证据，已从正式 P0 运行矩阵移除。它仍是后续完整 Worker 回归矩阵的一部分，见 `06-testing-review-acceptance.md`。
- 进入 P1：可以在本批独立审查通过后开始；进入 P3：不可以，仍须完成 P1、P2、1A 审查与复审门禁。

## 1A Testkit 冻结记录

### 公共面

| 能力/导出 | 默认语义 | 资源所有权/teardown | 复用证据 |
|---|---|---|---|
| `createAgentTestFixture()` | 真实 SQLite、基础 `AppContext`、`withApp: false`、concurrency `2`；默认从 `apps/api` cwd 定位 repoRoot | 调用方 `afterEach` 调用幂等 `dispose()`；按 app → DB → dataDir 清理。初始化失败也尽力清理全部资源：构建失败保留为 `AggregateError.cause`，清理失败附在 `errors` | lifecycle 与 initialization-failure cleanup 用例 |
| `resolveAgentApiTestRepoRoot()` | 验证从 `apps/api` cwd 上溯的 repoRoot；其他 cwd 要求显式 `repoRoot` | 不持有资源 | fixture 创建路径与 cwd 诊断 |
| `createTestWorkspace()` | 显式可覆盖 workspace 字段；只创建目录与 SQLite workspace | 目录属于 fixture dataDir | workspace/repository persistence 用例 |
| `createTestRepository()` | 显式传 workspace；只创建 repo、关联和工作区目录，不 init git | 目录与 SQLite 行属于 fixture | workspace/repository persistence 用例 |
| `injectJson()` | 调用方显式传 method/URL/payload/token；不自动断言 | 不持有 app 或 fixture | real Fastify inject 用例 |
| `createFakeAgentRuntime()` | 记录 enqueue/cancel、可选 hook、受控失败；不模拟队列 | 无外部资源 | fake runtime 用例 |

### 明确保留为领域私有的 helper

| Helper/用途 | 所在测试文件 | 不进入公共面的理由 |
|---|---|---|
| Worker 子进程、socket、端口、pid-file、HTTP LLM stub | `agent.worker.integration.test.ts` | 真实 API-managed Worker 专属边界；抽取会隐藏进程/网络生命周期。 |
| Plugin Host setup、archive/context fault injection、SSE reader | `agent.integration.test.ts` / `context-item-contract.test.ts` | 后续领域专属，且会扩大 `AppContext.agentTestFaults` 或公共生命周期。 |
| session/run/profile/prompt/messages builders | 当前领域测试 | 尚无两个独立文件的同语义复用证据；P1 不为 P2/P3 预建。 |
| `configureReadSideDefaults()`、`createRun()`、read-side fixture set | `read-side.api.test.ts` | 只服务 read-side Route 场景；把 settings/session/run 业务准备加入公共面会形成万能 builder。 |
| repo-record helper 与非法目录数据 | `agent-run-context.test.ts` | 仅服务 workspace run-context 的持久化边界，不是 read-side/prompt 共用输入。 |

### 代表性迁移

| 原用例 | 新位置 | 等价证据 |
|---|---|---|
| `agent.integration.test.ts`：`read-side internal routes freeze token priority, body validation, and current not-found statuses` | `agent/read-side.api.test.ts` | 迁移后仍断言三个 Route 的 `401/400/404`、workspace mismatch body、messages 不需 runId、profile/prompt success response 外壳与 dynamic arrays；真实 `createApp`/SQLite 未被 fake。 |
| `agent-run-context.test.ts` 手工临时 dataDir/SQLite/afterEach cleanup | 同文件改用 `createAgentTestFixture()`/`dispose()` | 原 3 个 missing workspace / 空 repo / 安全目录排序过滤断言保留；临时目录、DB 与清理转为 testkit 所有权。 |
| P1 fixture 生命周期自验证 | `agent/testkit/agent-testkit.test.ts` | 真实 SQLite/dataDir、显式 app inject、DB 记录、初始化失败清理与 fake runtime 合同均有独立断言。 |

### P1 运行结果

| 日期 | cwd | 命令 | 结果摘要 |
|---|---|---|---|
| 2026-04-01 | `apps/api` | `npx tsc --noEmit --pretty false` | 通过。 |
| 2026-04-01 | `apps/api` | `npx tsx --test src/modules/agent/testkit/agent-testkit.test.ts` | 审查修复后复跑：5 passed, 0 failed（约 0.88s）；覆盖初始化失败、DB close 再失败时仍删除 dataDir，且原始构建失败保留为 cause。 |
| 2026-04-01 | `apps/api` | `npx tsx --test src/modules/agent/testkit/agent-testkit.test.ts src/modules/agent/agent.integration.test.ts` | 162 passed, 0 failed；既有预期 fault-injection 日志不影响退出码。 |
| 2026-04-01 | 仓库根 | `git diff --check` | 通过。 |
| 2026-04-01 | `apps/api` | `npx tsc --noEmit --pretty false && npx tsx --test src/modules/agent/read-side.api.test.ts src/modules/agent/agent-run-context.test.ts src/modules/agent/testkit/agent-testkit.test.ts` | 9 passed, 0 failed。 |
| 2026-04-01 | `apps/api` | `npx tsx --test src/modules/agent/agent.integration.test.ts src/modules/agent/read-side.api.test.ts src/modules/agent/agent-run-context.test.ts src/modules/agent/testkit/agent-testkit.test.ts` | 166 passed, 0 failed；既有预期 fault-injection 日志不影响退出码。 |

- P1-P2 范围结论：只新增/使用 testkit 和迁移测试，并同步设计/代码地图/记录；未修改 Shared contract、`AgentService`、`Runner`、生产 `AppContext` 或数据库 schema。
- 1A 冻结结论：公共导出、默认值、资源所有权、teardown 和 fake runtime 合同以本表及 `03-testkit-foundation-design.md` 为准；P2 后停止独立扩张。任何 P3-P6 变更按 1A 重新进入门禁处理。
- 1A 门禁结论：P0、P1、P2 初审问题均已修复并复审通过。因此 1A 的批次级门禁记录已闭环；这不替代阶段级最终全面审查。

### 1A 审查门禁

- P0 独立审查与修复：初审发现 H1/H2/M1/L1 问题，均已修复。
- P0 独立复审：通过。
- P1 独立审查与修复：初审发现 fixture 初始化失败清理问题，已修复。
- P1 独立复审：通过。
- P2 独立审查与修复：初审发现组合回归结果记录错误，已修正。
- P2 独立复审：通过。
- 暂存：未按 1A 单独暂存；当前 index/worktree 为累计混合状态，不能作为 1A 门禁证据。
- 后续实施状态：P3 及后续批次已实施；其批次级结论见下表。阶段级最终全面审查仍待 P6 复审完成后进行。

## P3-P6 批次记录

每批追加以下内容：

### 批次：P3 Read-side / Prompt 骨架与依赖边界（2026-04-01）

- 设计复核范围：仅 `ReadSideApplication`、run static cache invalidation capability、`AgentService` facade 装配；未开始 P4/P5 业务迁移。
- 改动摘要：三 public facade 入口委派到 application；application 仅以窄 callback 委派回 private legacy 业务实现。cache invalidator 仅封装既有 Map delete callback，terminal lifecycle clear 调用点保持不变。
- 依赖边界：application/invalidation 不持有完整 `AgentService`/`AppContext`，不调用 runtime，不依赖 Store、writeback、archive、subtask 或 lifecycle service；`tool-projectors/` 未复制或修改。
- testkit 需求分类：无新增公共 testkit 需求；P3 单测直接构造骨架依赖，未触及 1A 冻结边界。
- 必选测试索引：`read-side/read-side-application.test.ts`（三 use-case 仅委派）；`prompt/run-prompt-static-cache.test.ts`（仅显式 clear 转发）；`read-side.api.test.ts`（Route/read-side contract 回归）；`agent.integration.test.ts`（现有 prompt cache/lifecycle 与 read-side 综合证据）。
- 命令与 cwd：`apps/api`：`npx tsc --noEmit --pretty false && npx tsx --test src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts src/modules/agent/read-side.api.test.ts`；`npx tsx --test src/modules/agent/agent.integration.test.ts src/modules/agent/read-side.api.test.ts src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts`；仓库根：`git diff --check`。
- 结果摘要：定向 3 passed, 0 failed；合并回归命令退出码 0（既有 fault-injection 日志为预期）；typecheck 与 diff check 通过。
- 批次级独立审查：初审通过。
- 修复与批次级独立复审：不适用（初审通过）。
- 暂存与后续实施：未按 P3 单独暂存；后续批次已实施。该事实与批次初审通过分别记录，不替代阶段级最终全面审查。

### 批次：P4 Execution Profile 与 Messages Context（2026-04-01）

- 设计复核范围：仅迁移 execution-profile 和 messages-context；不迁移 prompt-context、static prompt/cache 或与其共享的非纯行为 helper。
- 新权威实现：`ReadSideApplication` 以 session/run query callback 集中处理 execution-profile/messages-context 的既有 400/404 归属错误；`ExecutionProfileResolver` 负责 profile/runtime response 组装；`MessagesContextProjector` 负责 messages、active-run locale、one-shot system 与 response-only append 投影。`AgentService.getExecutionProfileForRun()` 与 `getMessagesContext()` 均为纯 facade 委派。
- P5 暂留边界：`getPromptContextForRunLegacy()` 仍经 application 直接转发，并继续自行完成 prompt-context 的 ownership validation；`runPromptStaticCache` 的读写/TTL/reuse、static/dynamic composition，以及仍被 prompt legacy 使用的 `buildPromptMessagesForSession()`、`resolveUiLocaleForSessionContext()` 也暂留。没有改动 `prompt/tool-projectors/`。
- 不变量核对：未改 Shared schema、Route、Worker `AgentApiClient`/`runner.ts`、transcript DB 查询/window/pagination、writeback、lifecycle、archive、subtask 或 testkit 公共面。Route/Shared/Worker 回归保持 status/body、动态 response 与 API-managed Worker read-side 链路。
- 测试索引：`read-side/read-side-application.test.ts`（session/workspace/run HTTP 错误与委派）；`read-side/execution-profile-resolver.test.ts`（surface/identity/profile runtime）；`read-side/messages-context-projector.test.ts`（动态输入、locale、append response-only）；`read-side.api.test.ts`、`agent.integration.test.ts`（真实 Route/SQLite 与现有 characterization）；`agent.worker.integration.test.ts`、`packages/shared/tests/internal-contracts.test.ts`、`apps/agent-worker/src/runtime/apiClient.test.ts`（跨边界回归）。
- 命令与结果（`apps/api`，类型检查）：`npx tsc --noEmit --pretty false`；通过。
- 命令与结果（`apps/api`，P4 窄领域测试）：`npx tsx --test src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts`；`5 passed, 0 failed`。
- 命令与结果（`apps/api`，API 综合回归）：`npx tsx --test src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side.api.test.ts src/modules/agent/agent.integration.test.ts`；退出码 `0`。既有 fault-injection error 日志为预期测试输出。
- 命令与结果（`apps/api`，API-managed Worker）：`npx tsx --test src/modules/agent/agent.worker.integration.test.ts`；`3 passed, 0 failed`。
- 命令与结果（`packages/shared`，Shared contract）：`npx tsx --test tests/internal-contracts.test.ts`；`14 passed, 0 failed`。
- 命令与结果（`apps/agent-worker`，Worker ApiClient）：`npx tsx --test src/runtime/apiClient.test.ts`；`20 passed, 0 failed`。
- 命令与结果（仓库根，差异检查）：`git diff --check`；通过。
- 批次级独立审查：初审发现命令/结果摘要与 ownership 表述问题。
- 修复：已将窄领域测试与 API 综合回归拆分记录，并澄清 execution-profile/messages-context 已集中至 application、prompt-context 当时仍由 legacy 校验。
- 批次级独立复审：通过。
- 暂存与后续实施：未按 P4 单独暂存；后续批次已实施。该事实不替代阶段级最终全面审查。

### 批次：P5 Static Prompt、Cache 与 Prompt Context（2026-04-01）

- 设计复核范围：仅迁移 static prompt assembler、run-scoped static cache 与 prompt-context static/dynamic composition；未改 Shared schema、Route、Worker Runner、transcript SQL/window/pagination、writeback、lifecycle、archive、subtask 或 testkit 公共面。
- 新权威实现：`ReadSideApplication` 现统一完成 prompt-context 的 session/workspace/run 校验与既有 400/404 映射；`PromptStaticAssembler` 负责静态 settings/instructions/skills/external roots/tools；`RunPromptStaticCache` 负责 runId key、30 分钟 access-based TTL、Promise reuse 与 storage；`PromptContextProjector` 负责 static/dynamic response 组合。`AgentService.getPromptContextForRun()` 仅委派，`getPromptContextForRunLegacy()` 已删除。
- 语义核对：cache key、TTL、Promise reuse、每次 access 续期和 terminal clear 均保持；terminal 时机仍在既有 lifecycle 调用点。projector 在每次请求（包括 cache hit）先解析 run 固定 profile，再读取动态 run state/locale，保持原 profile validation 顺序；static cache 不存 transcript、run state 或 pending tools。message/tool/skill/locale/compaction 的既有底层 helper 以窄 callback 复用，未复制 `prompt/tool-projectors/`。
- 日志核对：新增 P5 assembler/cache/projector 不写 `console` 或 logger payload；已有受控 filesystem skill/instruction 失败日志未扩展为完整 prompt/messages、tool args/result 或 secret 输出。
- 测试索引：`prompt/prompt-static-assembler.test.ts`（静态输入、external skills 排序、工具可见性）；`prompt/run-prompt-static-cache.test.ts`（run key、TTL、reuse、access expiry、clear）；`read-side/prompt-context-projector.test.ts`（每次 profile validation、cache/static+dynamic locale/messages/pendingTools 组合）；`agent.integration.test.ts`（既有真实 SQLite prompt/cache/input/skill/locale/只读 characterization）；`read-side.api.test.ts`、`agent.worker.integration.test.ts`、Shared contract 与 Worker client/runner tests（跨边界回归）。
- 命令与结果（`apps/api`，类型与定向领域/Route）：`npx tsc --noEmit --pretty false && npx tsx --test src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side/prompt-context-projector.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts src/modules/agent/prompt/prompt-static-assembler.test.ts src/modules/agent/read-side.api.test.ts`；通过，`10 passed, 0 failed`。
- 命令与结果（`apps/api`，综合 API 回归）：`npx tsx --test src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side/prompt-context-projector.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts src/modules/agent/prompt/prompt-static-assembler.test.ts src/modules/agent/read-side.api.test.ts src/modules/agent/agent.integration.test.ts`；退出码 `0`，既有 fault-injection error 日志为预期测试输出。
- 命令与结果（`apps/api`，API-managed Worker）：`npx tsx --test src/modules/agent/agent.worker.integration.test.ts`；`3 passed, 0 failed`。
- 命令与结果（`packages/shared`）：`npx tsx --test tests/internal-contracts.test.ts && npx tsc --noEmit --pretty false`；Shared contract `14 passed, 0 failed`，typecheck 通过。
- 命令与结果（`apps/agent-worker`）：`npx tsx --test src/runtime/apiClient.test.ts src/runtime/runner.auto-compact.test.ts src/runtime/runner.tool-output.test.ts && npx tsc --noEmit --pretty false`；通过，包含 ApiClient、auto-compact、tool-output 与 typecheck。
- 命令与结果（仓库根）：`git diff --check`；通过。
- 批次级独立审查：初审通过。
- 修复与批次级独立复审：不适用（初审通过）。
- 暂存与后续实施：未按 P5 单独暂存；后续批次已实施。该事实不替代阶段级最终全面审查。

### 批次：P6 领域测试、装配收尾与阶段回归（2026-04-01）

- 实现者自检：确认三个 `AgentService` read-side public entry 均只委派 `ReadSideApplication`；`ReadSideApplication` 是三个 use case 的校验入口：execution-profile 校验 session/workspace ownership 后校验 run，messages-context 仅校验 session/workspace ownership，prompt-context 在 session/workspace ownership 后通过窄 callback 确认 workspace 存在再校验 run。`ExecutionProfileResolver`、`MessagesContextProjector`、`PromptStaticAssembler`、`RunPromptStaticCache`、`PromptContextProjector` 不接收完整 `AgentService`/`AppContext`/runtime enqueue-cancel；Route 和 `agent.module.ts` 不承载 prompt 规则。
- 删除项：已删除无调用的 `RunPromptStatic` 类型与 `readWorkspaceAgentsInstructions()`；确认 `getPromptContextForRunLegacy()`、execution-profile/messages legacy、cache Map `.set/.delete` 直写均不存在。
- 保留项与理由：`buildPromptMessagesForSession()`、`resolveUiLocaleForSessionContext()`、受控 instruction/skill readers 与 `prompt/tool-projectors/` 仍作为窄底层 callback，因为它们承载 transcript/compaction、locale fallback、文件安全读取或动态工具投影；不构成第二套 use-case authority。
- 领域测试决定：保留 `agent.integration.test.ts` 中需要真实 Fastify/SQLite/workspace filesystem/settings/lifecycle 联动的 prompt/read-side characterization（compaction snippet、AGENTS.md/skills、安全路径、locale、tool messages、terminal cache clear）；不扩大冻结 testkit，也不以 mock Store 替代该边界。局部 application/resolver/projector/assembler/cache 规则已有独立领域测试。
- UI 验收：本阶段未改 UI、Shared contract、Route 或 Worker 调用顺序；以 Route、API-managed Worker、Shared、Worker client/runner 和 characterization 回归替代，手工 UI 验收暂予豁免；若独立审查发现兼容风险则重新开启。
- 命令与结果（仓库根）：`npm run build`；通过（Shared、Agent Worker、API、Feishu plugin、Web production build）。Web 构建仅输出既有 Browserslist 数据过期和 chunk size warning，退出码为 `0`。`npm run typecheck`；通过（Shared build、Agent Worker、API、Feishu plugin、Web typecheck）。
- 命令与结果（`apps/api`）：`npx tsc --noEmit --pretty false`；通过。`npx tsx --test src/modules/agent/testkit/agent-testkit.test.ts src/modules/agent/agent-run-context.test.ts src/modules/agent/read-side.api.test.ts src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side/prompt-context-projector.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts src/modules/agent/prompt/prompt-static-assembler.test.ts src/modules/agent/agent.integration.test.ts src/modules/agent/agent.worker.integration.test.ts`；退出码 `0`（既有 fault-injection error 日志为预期测试输出）。
- 命令与结果（`packages/shared`）：`npm run build && npx tsx --test tests/internal-contracts.test.ts && npm run typecheck`；通过，Shared contract `14 passed, 0 failed`。
- 命令与结果（`apps/agent-worker`）：`npm run build && npx tsx --test src/runtime/apiClient.test.ts src/runtime/runner.auto-compact.test.ts src/runtime/runner.tool-output.test.ts && npm run typecheck`；通过。
- 命令与结果（仓库根）：`git diff --check`；通过。
- 最终全面审查后补齐：新增 `agent.service.facade.test.ts`，直接验证三个 facade 对 `ReadSideApplication` 的参数、返回值及同步/异步错误均只作透传；同步修正 Git 当前状态与历史 mixed 状态的界限，以及三个 use case 的 ownership/workspace 校验归属。
- 命令与结果（`apps/api`，最终审查补齐）：`npx tsc --noEmit --pretty false`；通过。`npx tsx --test src/modules/agent/agent.service.facade.test.ts src/modules/agent/read-side/read-side-application.test.ts src/modules/agent/read-side/execution-profile-resolver.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side/prompt-context-projector.test.ts src/modules/agent/prompt/run-prompt-static-cache.test.ts src/modules/agent/prompt/prompt-static-assembler.test.ts`；`11 passed, 0 failed`。
- 批次级独立审查：本轮发现 Git 当前状态、facade 直接委派证据及 ownership 文档表述需补齐。
- 修复：已完成最小补齐并通过定向验证。
- 批次级独立复审：通过。
- 暂存与后续：未新建 commit、未推送。当前 index/worktree 为累计阶段变更；后续如何整理暂存、提交或推送由用户决定。

## 重新进入 1A 的记录

当 P3-P6 修改 testkit 公共导出、默认语义、fixture 生命周期、资源所有权、fake runtime 合同或生产 seam 时，在此追加：

- 触发批次与原因；
- 冻结边界变化；
- 更新的设计/测试；
- 重新执行的 1A 测试矩阵；
- 独立审查、修复和复审结论；
- 恢复 1B 的批准状态。

## 方案偏差索引

| 批次 | 新证据 | 与设计差异 | 文档更新位置 | 决策状态 |
|---|---|---|---|---|
| P6 | 保留真实 `agent.integration.test.ts` characterization，同时以领域测试覆盖可隔离规则；新增 facade 直接委派证据 | 未为继续拆测而扩大冻结 testkit；复杂 Fastify/SQLite/filesystem/settings/lifecycle 场景继续保留综合证据 | P6 记录、`04-read-side-prompt-design.md`、`06-testing-review-acceptance.md`、`07-code-map.md` | 批次复审通过；阶段最终全面审查与最终复审通过 |

## 阶段最终验收

- 批次级记录：P0、P1、P2、P4 初审问题修复后复审通过；P3、P5 初审通过；P6 补齐后批次复审通过。
- 1A 门禁：P0-P2 批次级审查/复审已闭环。
- 1B 必选测试矩阵：P6 实现者回归及最终审查补齐的 facade/read-side/prompt 定向验证均已通过。
- build/typecheck/diff：根级 `npm run build`、根级 `npm run typecheck`、各要求 workspace build/test/typecheck 与 `git diff --check` 已通过。
- UI 验收或豁免理由：本阶段未改 UI、Shared contract、Route 或 Worker 调用顺序，以真实 Route/API-managed Worker/Worker client-runner 与 characterization 回归替代；独立审查发现风险时重新开启手工验收。
- 阶段级新审查视角全面审查：已完成并通过；审查确认 facade 直接委派证据、Git 状态口径和 ownership/workspace 归属记录已补齐。
- 阶段级最终复审：已完成并通过。
- 与 0005/0006/本方案的差异：保留真实 integration characterization 而不为拆测扩张 testkit；阶段最终审查确认该差异可接受。
- 提交状态：当前仅保留 index/worktree 中的累计阶段变更，未创建 commit、未推送；后续提交决策由用户负责。
