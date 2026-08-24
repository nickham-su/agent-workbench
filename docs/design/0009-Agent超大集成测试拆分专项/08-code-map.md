# 代码地图

## 当前核心文件

| 路径 | 当前职责 | 本专项动作 |
|---|---|---|
| `apps/api/src/modules/agent/agent.integration.test.ts` | 已删除 | 不保留 cross-domain smoke；`165` 项均由 `integration/` 语义文件承载 |
| `apps/api/src/modules/agent/integration/agent-plugin-host.integration.test.ts` | P1 已迁移的 Plugin Host service reconcile | 局部 mock plugin、socket/process lifecycle 与 finally dispose；不进入通用 testkit |
| `apps/api/src/modules/agent/integration/agent-startup-recovery.integration.test.ts` | P1 已迁移的 startup/recovery/cancel race | 局部 direct composition、runtime fake 与手工 DB/app seam；其余普通场景复用窄 fixture |
| `apps/api/src/modules/agent/integration/agent-events-sse.integration.test.ts` | P1 已迁移的 SSE run-complete | 局部 reader/body/AbortController teardown |
| `apps/api/src/modules/agent/integration/agent-settings-profile.integration.test.ts` | P0 探针与 P1 的 Settings/Profile，共 `15` 项 | 复用窄 fixture；局部 subtask session/profile 与 mock fetch seam |
| `apps/api/src/modules/agent/integration/agent-subtask-lineage.integration.test.ts` | P2 已迁移的 lineage/orphan/reuse/partial unique，共 `10` 项 | P2 窄 helper + 真实 SQLite；注入失败日志为既有断言场景 |
| `apps/api/src/modules/agent/integration/agent-subtask-routes.integration.test.ts` | P2 已迁移的 subtask route contract，共 `7` 项 | depth/mode/auth/schema 与 direct service 错误断言 |
| `apps/api/src/modules/agent/integration/agent-subtask-prefork-result.integration.test.ts` | P2 已迁移的 prefork/result/partial output，共 `14` 项 | summary/meta/threshold、locale、partial-result 链 |
| `apps/api/src/modules/agent/integration/agent-session-routes.integration.test.ts` | P2 已迁移的 trigger/create/fork/run-route contract，共 `11` 项 | schema/preValidation probe 在局部 appFactory 的 ready 前注册 |
| `apps/api/src/modules/agent/integration/subtask.helpers.ts` | P2 专用窄领域 helper | 显式 fixture 所有权、Subtask session/anchor/start、context/writeback；direct service、prompt/profile 与轮询保持文件局部，不进入通用 testkit |
| `apps/api/src/modules/agent/integration/agent-read-context.integration.test.ts` | P3 已迁移的 messages/context/reasoning，共 `16` 项 | 局部 read-side、prompt-context 请求与 context 查询 helper；显式 fixture |
| `apps/api/src/modules/agent/integration/agent-run-cancel.integration.test.ts` | P3 已迁移的 cancel settlement/cascade，共 `6` 项 | lifecycle/run-state 局部查询与 polling；child cascade 保留 `{ concurrency: false }` |
| `apps/api/src/modules/agent/integration/agent-session-control.integration.test.ts` | P3 已迁移的 compact/clear/revert/workspace cleanup，共 `14` 项 | archive/compaction 请求、run-state polling 与 subtask-session 专属 helper 均保持局部 |
| `apps/api/src/modules/agent/integration/context-writeback.helpers.ts` | P3 专用窄 writeback helper | 显式 fixture 的 session/message、context item create/update 与 run-state update；不依赖 `fixtureByApp`，不进入通用 testkit |
| `apps/api/src/modules/agent/integration/agent-prompt-context.integration.test.ts` | P4 已迁移的 locale/runtime constraints/tool messages/todolist，共 `17` 项 | prompt section 与 internal 请求 helper 就近保留；保留 tool schema 和 locale 回退断言 |
| `apps/api/src/modules/agent/integration/agent-peripheral-status.integration.test.ts` | P4 已迁移的 status/allowlist/tail/final-text，共 `18` 项 | internal auth、plugin identity、run-state 查询均保持局部 |
| `apps/api/src/modules/agent/integration/agent-archive-compaction.integration.test.ts` | P4 已迁移的 archive/search/read/compaction，共 `6` 项 | snippet、v2 边界与 rollback 主链；内层 rollback fixture 显式绑定自身前置 |
| `apps/api/src/modules/agent/integration/agent-artifact-tool-output.integration.test.ts` | P4 已迁移的 artifact/tool-output，共 `11` 项 | artifact missing、path/symlink、slim/legacy output 断言及局部文件系统资源管理 |
| `apps/api/src/modules/agent/integration/agent-global-prompts-workspace.integration.test.ts` | P4 已迁移的 global prompts/AGENTS.md/skills/workspace，共 `12` 项 | global settings、repo path safety、AGENTS.md 与 skills cache 主链 |
| `apps/api/src/modules/agent/integration/p4-fixture.helpers.ts` | P4 专用窄 fixture helper | 普通场景复用 integration fixture；仅处理 archive fault 与 global prompts 的 pre-app 前置，不承载领域流程且不进入通用 testkit |
| `apps/api/src/modules/agent/testkit/agent-testkit.ts` | 通用真实 SQLite/AppContext/Fastify fixture、workspace/repo、inject、runtime fake | 作为基础；只做最小必要扩展 |
| `apps/api/src/modules/agent/testkit/agent-integration-testkit.ts` | P0 窄 integration fixture：ready app、默认 workspace/settings/allowlist | 后续只增加多文件稳定复用的基础初始化 |
| `apps/api/package.json` | P0 后 `test:integration` 运行新目录 glob 与剩余旧综合文件 | P5 删除旧文件后收窄为只运行新目录 |
| `apps/api/src/modules/agent/agent.worker.integration.test.ts` | Worker integration 专项测试 | 不修改；仅按需回归 |

## 旧综合文件中的关键符号

### Fixture 与清理

| 符号 | 原位置 | 迁移方向 |
|---|---:|---|
| `Fixture` | `63` | 候选 `AgentIntegrationFixture`，基于 `AgentTestFixture` |
| `fixtures` | `74` | 删除；禁止跨文件全局集合 |
| `fixtureByApp` | `75` | 历史残留；P4 后旧文件已无活动测试，P5 删除旧文件时移除 |
| `createFixture()` | `81` | `createAgentIntegrationFixture()` 候选 |
| `configureAgentDefaults()` | `1259` | 稳定默认初始化，候选 integration testkit |
| `closeFixture()` | `1947` | 用现有幂等 `dispose()` 替代 |
| 顶层 `afterEach()` | `1955` | 每测试 `t.after()` 或局部 finally；P0 实测 |

### 通用候选 helper

| 符号 | 原位置 | 目标 |
|---|---:|---|
| `createSession()` | `1961` | integration testkit 的稳定 public helper |
| `sendMessage()` | `1992` | integration testkit 的稳定 public helper |
| `getRunState()` | `2906` | lifecycle/status 窄 helper或就近保留 |

### Subtask helper

| 符号 | 原位置 | 目标 |
|---|---:|---|
| `createSubtaskSessionForTest()` | `1971` | Subtask 窄 helper |
| `createSubtaskAnchor()` | `2006` | Subtask 窄 helper |
| `startSubtaskForAnchor()` | `2060` | Subtask 窄 helper |
| `createDirectAgentComposition()` | `2091` | Startup/Subtask 文件局部 |
| `createDirectAgentService()` | `2121` | Startup/Subtask 文件局部 |
| `assertDirectSubtaskStartError()` | `2125` | Subtask route 文件局部 |

### Read / Writeback / Lifecycle helper

| 符号 | 原位置 | 目标 |
|---|---:|---|
| `getMessagesContextInternal()` | `2919` | Read-context helper |
| `waitRunIdle()` | `2946` | async lifecycle/SSE 局部 helper |
| `getContextItems()` | `2956` | Read-context helper |
| `getContextItem()` | `2974` | Read-context helper |
| `createContextItemInternal()` | `2980` | `context-writeback.helpers.ts` 中显式 fixture 的 writeback 窄 helper |
| `updateContextItemInternal()` | `3064` | `context-writeback.helpers.ts` 中显式 fixture 的 writeback 窄 helper |
| `updateRunStateInternal()` | `3086` | `context-writeback.helpers.ts` 中显式 fixture 的 writeback 窄 helper |

### Prompt / Archive helper

| 符号 | 原位置 | 目标 |
|---|---:|---|
| `extractPromptSection()` | `2892` | Prompt 文件本地 |
| `getPromptContextInternal()` | `3372` | Prompt 文件本地 |
| `compactContextInternal()` | `3449` | Archive/Compaction 文件本地 |
| `archiveSearchInternal()` | `3476` | Archive 文件本地 |
| `archiveReadInternal()` | `3509` | Archive 文件本地 |

## 目标测试文件代码地图

| 目标路径 | 主调用链 | 关键特殊依赖 |
|---|---|---|
| `integration/agent-plugin-host.integration.test.ts` | Plugin Host service reconcile | process、socket、mock plugin、wait/finally |
| `integration/agent-startup-recovery.integration.test.ts` | startup fail/recover/cancel race | direct composition、runtime fake、SQLite |
| `integration/agent-events-sse.integration.test.ts` | SSE run-complete | stream reader、AbortController、teardown |
| `integration/agent-subtask-lineage.integration.test.ts` | lineage/orphan/reuse/constraints | Store seam、SQLite persistence |
| `integration/agent-subtask-routes.integration.test.ts` | Subtask HTTP contract | token/schema probes、internal routes |
| `integration/agent-subtask-prefork-result.integration.test.ts` | prefork/result | context/writeback、prompt、result fallback |
| `integration/agent-session-routes.integration.test.ts` | create/fork/trigger | public/internal routes、schema/auth |
| `integration/agent-session-control.integration.test.ts` | compact/clear/revert | archive side effects、concurrency |
| `integration/agent-read-context.integration.test.ts` | messages/context/reasoning | context query/writeback、locale fallback |
| `integration/agent-run-cancel.integration.test.ts` | cancel settlement/cascade | lifecycle、Subtask lineage、`concurrency:false` |
| `integration/agent-settings-profile.integration.test.ts` | settings/provider/profile | settings store/routes、provider model seam |
| `integration/agent-prompt-context.integration.test.ts` | locale/tools/messages/todolist | prompt route、tool schemas、title update |
| `integration/agent-peripheral-status.integration.test.ts` | status/tail/allowlist/agents/final-text | internal auth、plugin identity |
| `integration/agent-archive-compaction.integration.test.ts` | archive/compaction | filesystem sidecar/snippet/search/read |
| `integration/agent-artifact-tool-output.integration.test.ts` | artifact/tool output | symlink/path safety、legacy data |
| `integration/agent-global-prompts-workspace.integration.test.ts` | global/workspace/skills | AGENTS.md、repo path、skills cache |

## 候选 testkit 文件

| 候选路径 | 允许职责 | 禁止职责 |
|---|---|---|
| `testkit/agent-integration-testkit.ts` | ready app fixture、默认 workspace/settings/allowlist、session/message helper | Subtask、Archive、Prompt、Artifact 领域流程 |
| `integration/subtask.helpers.ts` | P2 的 Subtask anchor/session/start、显式 context/writeback 复用 | direct service、prompt/profile、轮询、普通 Prompt/Archive helper、跨领域状态机或通用 testkit 职责 |
| `integration/context-writeback.helpers.ts` | P3 已创建：显式 fixture 的 session/message、create/update item/run-state | 隐式全局 map、万能状态机、read/prompt/polling/direct-composition 等文件局部能力 |
| `integration/p4-fixture.helpers.ts` | P4 已创建：仅 archive write fault、global prompts pre-app 前置；普通场景委托 integration fixture | Prompt/Archive/Artifact/Global 领域断言、通用文件服务、跨领域状态机或通用 testkit 职责 |

候选 helper 文件只有在存在真实多文件复用时才创建；否则就近保留更清晰。

## 现有相关测试

以下测试继续保留，用于补充 application、persistence、wiring 或 contract 覆盖，不因本专项删除：

```text
apps/api/src/modules/agent/read-side.api.test.ts
apps/api/src/modules/agent/writeback.api.test.ts
apps/api/src/modules/agent/run-lifecycle-baseline.api.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
apps/api/src/modules/agent/session-routes-module-p0-baseline.test.ts
apps/api/src/modules/agent/subtask/*.test.ts
apps/api/src/modules/agent/archive/*.test.ts
apps/api/src/modules/agent/query/*.test.ts
apps/api/src/modules/agent/startup/*.test.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

本专项不以“已有相似测试”为理由删除旧综合文件中的跨域主链。

## 当前和目标调用关系

### 当前

```text
integration/*.test.ts
  └─ 16 semantic files / 165 active tests
```

### 目标

```text
agent-testkit.ts
  └─ agent-integration-testkit.ts
       ├─ integration test file A
       ├─ integration test file B
       └─ ...

narrow domain helper
   └─ only the related integration files

package test:integration
  └─ tsx --test src/modules/agent/integration/*.test.ts
```

依赖方向必须保持单向：测试文件依赖 testkit/helper，testkit 不反向 import 测试文件，也不成为生产代码依赖。

## 实施后更新要求

P5 已更新本代码地图：

- 实际目标文件为上表 `16` 个 integration 测试文件，总计 `165` 项；
- 保留 `subtask.helpers.ts`、`context-writeback.helpers.ts` 与 `p4-fixture.helpers.ts` 三个窄领域 helper；通用 `agent-integration-testkit.ts` 为 `136` 行基础 fixture；
- `test:integration` 最终命令为 `tsx --test src/modules/agent/integration/*.test.ts`；
- 未保留 cross-domain smoke，旧综合文件已删除；
- 与初始方案的差异仅是 P4 过渡期的空旧文件 subtest 在 P5 随旧文件删除一并消除；
- Plugin Host、SSE、Archive/Artifact 等特殊资源继续由每测试 fixture `dispose()` 及局部 `finally`/teardown 管理；P5 延迟资源复查无残留。

## 终审维护结论

- `createSession` / `sendMessage` 在 integration testkit、context-writeback helper 与 subtask helper 存在小幅重复，默认 providers/agents 初始化也在 integration testkit 与 P4 特殊 fixture 有近似重复；两项均为非阻断观察，本专项不补代码。
- 原因是复制面有限，且 helper 职责、fixture 类型与 pre-app/ready 生命周期不同；立即统一会扩大共享 testkit 耦合，并可能削弱显式前置状态。
- 未来相关调用约定或 bootstrap 发生变更时，再需求驱动收敛。
- `internal final-text` 的实际归属为 `agent-peripheral-status.integration.test.ts`；特殊主链继续局部 fixture/pre-app/direct seam，不硬塞通用 testkit。
- 最大文件 `agent-subtask-prefork-result.integration.test.ts` 为 `1433` 行，低于本专项关注阈值。
