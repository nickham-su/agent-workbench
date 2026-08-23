# 基线与证据

## P0-P5 实测更新

P0 已实际执行多文件 runner 与探针迁移，以下结果替代“尚未执行”的方案阶段假设：

| 项目 | 实测结果 |
|---|---|
| 旧综合文件基线 | `165` tests 全部通过，fail/cancel/skip 均为 `0`，runner `duration_ms 39301.563313`（wall clock 约 `39s`） |
| 基线资源清理 | `.tmp-tests/agent-it-*` 运行前/后均为 `0` |
| 探针单文件 | `agent-settings-profile.integration.test.ts`：`1/1` 通过，runner `duration_ms 1245.884526`，`agent-integration-*` 运行前/后均为 `0` |
| 默认多文件 runner | 探针 + `agent-testkit.test.ts`：`6/6` 通过，runner `duration_ms 1305.248991` |
| 显式串行 runner | 同一组使用 `--test-concurrency=1`：`6/6` 通过，runner `duration_ms 2172.810121` |
| P0 旧+新组合 | 尚未迁移的旧文件 `164` tests + 新探针 `1` test，共 `165/165` 通过；glob 方式 runner `duration_ms 39700.910724`（wall clock 约 `40s`） |
| P1 特殊资源定向 | Plugin Host `1/1`（`5717.498063 ms`）、startup/recovery `6/6`（`2323.377203 ms`）、SSE `1/1`（`1185.462023 ms`）均通过；Plugin Host socket/process、SSE reader/body/abort 均由局部测试 teardown 释放 |
| P1 Settings/Profile 定向 | `15/15`（含 P0 探针，`8717.198511 ms`）通过；provider 模型列表使用 mock `fetch`，不访问真实外网 |
| P1 迁移期全量组合 | 旧文件 `142` tests + 新目录 `23` tests，共 `165/165` 通过；runner `duration_ms 35343.162351`；标题唯一 `165`、重复 `0`、相关 `.tmp-tests` fixture 目录运行后为 `0` |
| P2 四文件定向（helper 收敛后复跑） | lineage `10/10`（`5883.072907 ms`）、routes `7/7`（`4621.944741 ms`）、prefork/result `14/14`（`8167.842608 ms`）、session routes `11/11`（`4800.815499 ms`）均通过 |
| P2 相关回归（helper 收敛后复跑） | `subtask/*.test.ts` 四文件与 `session-routes-module-p0-baseline.test.ts` 共 `26/26` 通过（`2603.167409 ms`） |
| P2 迁移期全量组合（helper 收敛后复跑） | 旧文件 `100` tests + 新目录 `65` tests，共 `165/165` 通过；runner `duration_ms 28708.913149`；标题唯一 `165`、重复 `0` |
| P3 三文件定向 | read-context `16/16`（`10274.192836 ms`）、run-cancel `6/6`（`5674.379684 ms`）、session-control `14/14`（`6449.18301 ms`）均通过；`concurrency:false` 保留在 child cascade 场景 |
| P3 相关回归 | context/writeback/lifecycle/query/read-side/session 共 `67/67` 通过（`8386.581029 ms`）；含既有注入 failure 日志，TAP 通过 |
| P3 迁移期全量组合 | 旧文件 `64` tests + 新目录 `101` tests，共 `165/165` 通过；runner `duration_ms 23172.369581`；标题唯一 `165`、重复 `0` |
| P4 五文件定向 | prompt `17/17`（`8564.245174 ms`）、peripheral/status `18/18`（`9717.056133 ms`）、archive/compaction `6/6`（`5704.380645 ms`）、artifact/tool-output `11/11`（`6429.892813 ms`）、global/workspace `12/12`（`6403.381271 ms`）均通过 |
| P4 相关回归 | archive、compaction、prompt、query、read-side、writeback 等 `17` 个既有测试文件共 `51/51` 通过（`2559.920873 ms`） |
| P4 迁移期全量组合 | 全部 `165` 个活动测试均位于新目录，标题唯一 `165`、重复 `0`；现有脚本仍显式载入无活动测试的旧文件，TAP 因文件级 subtest 报告 `166/166` 通过，runner `duration_ms 22597.484928`；P5 删除旧文件后收窄脚本 |
| P5 新 integration 全量 | 收窄后的 `npm run test:integration`：`165/165` 通过，fail/cancel/skip/todo 均为 `0`，runner `duration_ms 21666.417237` |
| P5 API 全量 | 方案定义的 `find src ... | sort` 测试命令：`334/334` 通过，runner `duration_ms 26873.44707` |
| P5 必要回归与构建 | worker integration `3/3`（`7104.926429 ms`）、Feishu `11/11`（`139.628175 ms`）、Web `24/24`（`170.641178 ms`）通过；API typecheck、root build（外层 `35144 ms`）与 root typecheck（外层 `11541 ms`）通过 |

默认多文件命令的 wall-clock 明显低于显式 `--test-concurrency=1`，说明当前 `tsx --test` 对独立测试文件存在文件级并发；P0 的独立 fixture 没有发生 SQLite、临时目录或 app 资源冲突。P1 已用 Plugin Host/SSE 特例复验，P2 又用 Subtask/session-route 多文件场景复验，P3 再用 context/cancel/session-control 场景复验，P4 再用 archive/artifact/global workspace 的文件系统场景复验，P5 用删除旧文件后的新目录全量、worker integration 与延迟 `5s` 资源复查再次验证，未观察到资源冲突或相关临时目录残留。P4 的 archive rollback 子 fixture 必须显式传入自身 fixture，已据此保持跨 DB 前置状态等价。后续问题仍应按各自特殊资源模型定位，不能据此假定所有场景均可默认并行。

实测 shell glob 命令为：

```bash
cd apps/api
npx tsx --test src/modules/agent/integration/*.test.ts
```

P5 已将 `apps/api/package.json` 的 `test:integration` 冻结为同一新目录命令。旧基线中曾出现一次 `agent runtime run failed` / `The database connection is not open` 的 error log，但 TAP 仍为 `165/165` 通过，且 `.tmp-tests` 无遗留；P0 将其记录为既有测试运行 warning，未修改生产行为。P5 root build 有既有 Browserslist 数据过期及大 chunk 提示，但构建成功，未因此扩张范围。

## 调研方法与事实边界

本文件同时记录方案编写时的只读事实和 P0-P5 已实际执行的结果。除 P0-P5 明确列出的测试/testkit/package script 改动外，以下动作仍未执行：

- 未修改生产代码。

P5 已确认只运行新目录的脚本；P5 独立审查通过，唯一 README L1 已修复且同一审查员复审通过；未参与 P0-P5 实施及批次审查的新审查员全面独立终审通过，专项达到完成定义。

## 文件规模与测试数量

当前综合文件：

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

只读统计结果：

| 指标 | 当前值 |
|---|---:|
| 文件行数 | 约 `11,915` |
| 顶层 `test(...)` | `165` |
| 顶层 `describe(...)` | `0` |
| 显式顶层 helper 函数 | 约 `25` |
| 当前 package script | `tsx --test src/modules/agent/agent.integration.test.ts` |

`apps/api/package.json` 当前事实：

```json
{
  "scripts": {
    "test:integration": "tsx --test src/modules/agent/agent.integration.test.ts",
    "test:integration:worker": "tsx --test src/modules/agent/agent.worker.integration.test.ts"
  }
}
```

`test:integration:worker` 不属于本专项改造范围。

## 当前主题分布

按原测试行号和主要断言调用链粗分，当前文件包含以下主题：

| 主题簇 | 原大致行区间 | 当前测试数 | 说明 |
|---|---:|---:|---|
| Plugin Host / startup / recovery / runtime cancel | `204-800` | `7` | process/socket、startup fail/recover、archive sidecar、cancel race |
| Subtask lineage 与底层约束 | `801-1246` | `10` | lineage、orphan、reuse、partial unique、SQLite 弱类型 |
| Settings / agent surface / prompt 基础 | `1247-1736` | `8` | settings、scratchpad、agent surface、resolved model |
| Internal trigger / final text / SSE | `1737-2141` | `3` | dedup、final text、event stream |
| Subtask / Session routes 与 contract | `2142-3401` | `17` | validation、schema/auth、depth、fork/create、ignored run |
| Read-side / Context / Reasoning | `3402-4212` | `16` | prompt cache、messages/context、pagination、reasoning |
| Run cancel 与 cascade | `4213-4987` | `6` | cancel、context settlement、hidden branch、child cascade |
| Settings/Profile 与 locale prompt | `4988-5732` | `12` | runtime settings、provider/profile、locale constraints |
| Session control | `5733-6093`、`7376-7720` | `14` | compact、clear、revert、subtask read-only、workspace cleanup |
| Subtask prefork/result | `6094-7299`、`8161-8222`、`11719-11783` | `15` | prefork summary/meta、result fallback、partial output |
| Peripheral / status | `7784-8333` | `18` | run-state、status summary、allowlist、agents/list、tail |
| Archive / compaction | `8434-9175` | `6` | archive search/read、snippet、v2 边界 |
| Prompt tool messages | `9176-9755` | `5` | tool-call/result、apply_patch、todolist |
| Artifact / tool output compatibility | `9756-10860` | `11` | artifact path/symlink、write、legacy result |
| Global prompt / workspace / skills / provider | `10861-11915` | `15` | global prompt、AGENTS.md、skills、OpenAI-compatible |

上述分组用于证明内容跨域，不是最终文件映射。最终唯一归属见 [05-migration-map-and-batches.md](./05-migration-map-and-batches.md)。

## 当前 fixture 事实

旧综合文件定义本地 `Fixture`，字段包括：

```text
app
DB
dataDir
workspaceId
workspacePath
internalToken
repoRoot
AppContext
```

`createFixture()` 当前会执行：

- 按 `process.cwd()` 的 `../..` 解析仓库根目录；
- 在 `<repoRoot>/.tmp-tests` 下创建唯一 `agent-it-*` 临时目录；
- 打开真实 SQLite；
- 创建真实 `AppContext`；
- 默认关闭 Agent Worker，并使用 `agentWorkerPort: 0`；
- 可按测试开启 Plugin Host / Plugin Services；
- 使用临时目录下的 Worker / Plugin Host socket；
- 创建真实 Fastify app 并调用 `app.ready()`；
- 创建一个默认 workspace；
- 配置默认 Agent/provider/settings；
- 写入默认 Feishu channel sender allowlist。

当前可选项包括：

```text
agentWorkerConcurrency
agentTestFaults.archiveWrite
enablePluginHost
enablePluginServices
agentGlobalPromptsStored
agentGlobalPromptsUpdatedAt
p0PreValidationProbe
p0SchemaOnlyProbe
```

事实与建议必须区分：

- 上述是旧 fixture 已有能力；
- 新 integration testkit 不应机械复制全部选项；
- P0 应按“是否有多个调用者、是否属于通用 fixture”决定最小扩展；
- P0 schema/preValidation probe 明显是 route contract 领域能力，应就近保留，而不是进入全局 fixture API。

## 当前清理与共享状态

旧综合文件使用：

```ts
const fixtures = new Set<Fixture>();
const fixtureByApp = new WeakMap<FastifyInstance, Fixture>();
```

并在顶层 `afterEach()` 遍历 `fixtures`，执行：

```text
app.close()
DB close
删除 dataDir
```

该模式在单个大文件内提供了兜底清理，但不适合作为跨文件共享单例：

- 多文件并行时，资源所有权不清；
- 一个测试文件的 hook 不应清理另一个文件的 fixture；
- `fixtureByApp` 隐藏了 helper 对 DB、workspace 和 context 的依赖；
- helper 仅接收 `app` 时，调用者难以看到其数据库副作用；
- 进程、socket、SSE reader 等特殊资源不应依赖一个泛化全局集合。

目标设计必须改为每测试自己拥有 fixture，并显式调用幂等 `dispose()`。

## 现有基础 testkit 证据

已有文件：

```text
apps/api/src/modules/agent/testkit/agent-testkit.ts
```

已经提供：

- `resolveAgentApiTestRepoRoot()`；
- `createAgentTestFixture()`：真实 SQLite，可选真实 Fastify app；
- 幂等 `dispose()`：关闭 app、关闭 DB、删除 dataDir，并聚合清理异常；
- `createTestWorkspace()`；
- `createTestRepository()`；
- `injectJson()`；
- `createAgentRuntimeFake()`。

其当前 fixture 默认值已经覆盖旧 fixture 的大部分基础 `AppContext`，包括：

```text
agentWorkerEnabled: false
agentWorkerPort: 0
唯一 worker/plugin-host socket path
agentStartupRecoveryMode: recover
```

但当前 `CreateAgentTestFixtureOptions` 只显式提供：

```text
repoRoot
dataDirPrefix
withApp
appFactory
agentWorkerConcurrency
```

因此建议是“以现有 testkit 为基础做最小扩展”，而不是声称它已支持 Plugin Host、fault seam 或默认 Agent 配置。

## 当前 helper 证据与候选归属

旧综合文件的主要 helper 如下：

| Helper | 原行号 | 当前特点 | 目标建议 |
|---|---:|---|---|
| `sleep` | `77` | 通用等待，但可能掩盖事件同步 | 特殊 process/SSE 文件本地；不默认全局化 |
| `createFixture` | `81` | 真实 App/DB/workspace/default settings | 迁移为窄 integration fixture |
| `configureAgentDefaults` | `1259` | 默认 Agent/provider/settings | 多文件稳定复用，候选进入 integration testkit |
| `closeFixture` | `1947` | 与全局 Set/WeakMap 绑定 | 由 testkit 幂等 `dispose()` 替代 |
| `createSession` | `1961` | 真实 public HTTP 入口 | 候选通用 integration helper |
| `createSubtaskSessionForTest` | `1971` | Store 直写、Subtask 语义 | Subtask 窄 helper |
| `sendMessage` | `1992` | 真实 public HTTP 入口 | 候选通用 integration helper |
| `createSubtaskAnchor` | `2006` | Subtask 跨层场景 | Subtask 窄 helper |
| `startSubtaskForAnchor` | `2060` | Subtask internal contract | Subtask 窄 helper |
| `createDirectAgentComposition` | `2091` | 直接 composition seam | Startup/Subtask 局部 helper |
| `createDirectAgentService` | `2121` | 直接 facade seam | Startup/Subtask 局部 helper |
| `assertDirectSubtaskStartError` | `2125` | Subtask error 断言 | Subtask 文件本地 |
| `extractPromptSection` | `2892` | Prompt 表达解析 | Prompt 文件本地 |
| `getRunState` | `2906` | Public query helper | 可在 lifecycle/status 窄 helper 复用 |
| `getMessagesContextInternal` | `2919` | Read-side internal route | Read-context helper |
| `waitRunIdle` | `2946` | 轮询异步状态 | 仅 async lifecycle/SSE 场景使用 |
| `getContextItems` / `getContextItem` | `2956` / `2974` | Context Query | Read-context helper |
| `createContextItemInternal` | `2980` | 隐含 fixture lookup、run/state 副作用 | 必须显式接收 fixture，窄 writeback helper |
| `updateContextItemInternal` | `3064` | Context Writeback | 窄 writeback helper |
| `updateRunStateInternal` | `3086` | Lifecycle internal route | 窄 lifecycle/writeback helper |
| `getPromptContextInternal` | `3372` | Prompt read-side | Prompt helper |
| `compactContextInternal` | `3449` | Compaction | Archive/Compaction helper |
| `archiveSearchInternal` | `3476` | Archive read route | Archive helper |
| `archiveReadInternal` | `3509` | Archive read route | Archive helper |

核心判断：helper 的提取依据是稳定复用和依赖透明度，而不是“全部移出测试文件”。

## 特殊资源与时序证据

### Plugin Host / process / socket

`plugin-host services reconcile can start/stop feishu gateway` 会：

- 开启 Plugin Host 和 Plugin Services；
- 在临时目录创建 mock Feishu plugin；
- 使用 Unix socket 调用 Plugin Host client；
- 通过等待观察 reconcile start/stop；
- 涉及真实进程与最终关闭。

该测试必须独立成文件，不能与普通 HTTP/SQLite 测试混为一般 fixture 场景。

### SSE

`internal events/sse 返回 run-complete 事件 chunk` 使用 event stream、reader、AbortController，并有显式 reader/body cancel。迁移时必须保留 teardown 顺序和事件内容断言。

### Startup recovery / cancel race

现有测试覆盖：

- fail mode 收敛 in-flight run；
- archive pending sidecar best-effort reconcile；
- enqueue 前最终 DB check 的 cancel-wins；
- enqueue 已发出后的 cancelled 终态优先；
- enqueue failure 记录并继续 candidate；
- runtime cancel failure 只 warning，DB 状态保持收敛。

这些不是可用普通单元测试替代的“重复覆盖”。

### 显式并发语义

`agent cancel 会基于当前 active run 的 subtask 结果精确级联取消活动 child，且不误取消历史 fork child` 当前带有：

```ts
{ concurrency: false }
```

实施必须原样保留。P0 还需检查多文件运行是否引入过去不存在的文件级并发。

## 当前 Git 与阶段边界

方案调研时只读观察到工作区分支为：

```text
v1.1...origin/v1.1
```

文档编写会产生本专项文档变更；不得处理、恢复或覆盖其他未知变更。未经用户授权不得执行 `git add`、`commit`、`push`、`checkout`、`reset` 或历史改写。
