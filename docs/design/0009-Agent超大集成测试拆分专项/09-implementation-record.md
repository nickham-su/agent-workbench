# 实施记录

> 状态：专项已完成。P0-P5 实施、测试、批次独立审查/复审均已闭环，P5 已由主会话暂存；未参与 P0-P5 实施及批次审查的新审查员已完成全面独立终审并通过，达到完成定义，无 H/M 问题，无必须补代码差距。专项只修改测试/testkit、迁移期间测试脚本和本专项文档，未修改生产代码。

## 记录规则

- 每批第一项记录 `git status --short --branch`、HEAD 和 diff 边界；
- 不处理、恢复或覆盖用户未知变更；
- 只记录实际执行并看到的命令、cwd、结果、耗时和日志；
- 预期 warning 必须说明，不能把进程日志或已知 warning 误判为失败；
- 不记录 token、prompt 正文、artifact/archive 内容或敏感绝对路径；
- 每个迁移测试记录原标题、原行号、新路径和断言核对；
- 旧测试块删除必须记录新位置通过证据；
- 每批记录独立审查、修复和复审结论；
- 阶段完成后记录未参与 P0-P5 的新审查员终审结论；
- 未经用户授权不得 `git add`、commit、push 或改写历史。

## 当前状态

| 批次 | 实现 | 实现者测试 | 独立审查 | 修复 | 独立复审 | Git 阶段动作 |
|---|---|---|---|---|---|---|
| 只读调研 | 已完成：文件/fixture/helper/165 标题盘点 | 静态证据核对完成 | 已纳入独立文档审查 | 无修订项 | 通过：无 H/M/L 问题 | 否 |
| 方案文档 | 已完成 | Markdown 链接、165 项映射、文件清单与 diff hygiene 自检通过 | 通过：无 H/M/L 问题 | 无修订项 | 无修订项，无需复审 | 否 |
| P0 | 已完成：窄 fixture、1 个探针迁移、runner/资源实测 | 定向、旧+新组合、typecheck、diff check 通过 | 通过：未参与实现的独立代码审查员审查，无 H/M/L 问题 | 无修复项 | 无需复审 | 已由主会话暂存 |
| P1 | 已完成：22 项迁移、旧副本删除、资源/唯一性核对 | 定向、组合、testkit、API/root typecheck、diff check 通过 | 通过：未参与实现的独立代码审查员审查，无 H/M/L 问题 | 无修复项 | 无需复审 | 已由主会话暂存 |
| P2 | 已完成：42 项迁移、窄 Subtask helper、旧副本删除、资源/唯一性核对 | 四文件定向、相关 subtask/route 回归、组合、API/root typecheck、diff check 通过 | 通过：未参与实现的独立代码审查员审查，无 H/M/L 问题 | 无修复项 | 无需复审 | 已由主会话暂存 |
| P3 | 已完成：36 项迁移、窄 writeback helper、旧副本删除、资源/唯一性核对 | 三文件定向、67 项相关回归、组合、API/root typecheck、diff check 通过 | 通过：未参与实现的独立代码审查员审查，无 H/M/L 问题 | 无修复项 | 无需复审 | 已由主会话暂存 |
| P4 | 已完成：64 项迁移、窄 pre-app fixture helper、旧副本删除、资源/唯一性核对 | 五文件定向、51 项相关回归、迁移期组合、API/root typecheck 通过 | 通过：未参与实现的独立代码审查员审查，无 H/M/L 问题 | 无修复项 | 无需复审 | 已由主会话暂存 |
| P5 | 已完成：旧文件删除、脚本收窄、165 项唯一核对与实现侧总验收 | new integration `165/165`、API 全量 `334/334`、worker/plugin/web 回归、API/root typecheck、root build、资源/diff check 通过 | 通过：未参与实现的独立审查员审查；无 H/M 问题，1 个 L1 文档问题 | L1 已修复：README 文档结构表的 `09` 描述已改为实施记录与验收日志 | 通过：同一审查员复审 L1 修复 | 已由主会话暂存 |
| 全面独立终审 | 已完成：达到完成定义 | 不适用；引用 P5 已记录的验证证据 | 通过：未参与 P0-P5 实施及批次审查的新审查员；无 H/M 问题、无必须补代码差距 | 无必须修复项 | 不适用 | 已完成 |

## 方案阶段已确认基线

- 当前目标文件：`apps/api/src/modules/agent/agent.integration.test.ts`；
- 文件约 `11,915` 行；
- 顶层 `test(...)` 为 `165`；
- 当前 `apps/api/package.json`：

  ```text
  test:integration = tsx --test src/modules/agent/agent.integration.test.ts
  ```

- 现有基础 testkit：`apps/api/src/modules/agent/testkit/agent-testkit.ts`；
- 当前生产 Agent 模块治理已完成并停止；
- Worker 结构评估未启动且不属于本专项；
- 方案阶段未修改生产代码、测试代码或 `apps/api/package.json`；
- 方案阶段时 P0-P5 尚未实施。

## 独立文档审查结论

- 结论：通过；
- 问题分级：无 H/M/L 问题；
- 修订项：无；
- 阶段门禁：方案可进入 P0。

## P0 记录：基线与 runner 实测

### Git 与源码基线

```text
分支/HEAD：v1.1...origin/v1.1 / 0e78725 feat(agent): implement phase 6 session routes and module governance
工作区状态：P0 开始时 0009 文档目录已在暂存区；视为用户既有变更，不处理、不恢复、不改写暂存区。
旧文件行数：11,915
顶层 test 数：165
清单差异：无；迁移后旧文件 164 + 新文件 1 = 165，标题唯一数 165，重复标题 0。
```

### 旧 integration 基线

```text
cwd：apps/api
命令：npm run test:integration（P0 脚本修改前）
结果：通过
pass/fail/skip/cancel：165 / 0 / 0 / 0
耗时：runner duration_ms 39301.563313；wall clock 约 39s
既有 warning：一次 agent runtime run failed / The database connection is not open 的 error log；TAP 仍为 165/165 通过。本专项不修改生产行为，仅记录。
.tmp-tests 遗留：agent-it-* 运行前 0、运行后 0
process/socket/SSE 清理观察：该全量基线含 Plugin Host 与 SSE 测试；命令成功退出且 .tmp-tests 无 fixture 目录残留。P1 仍需对特殊资源拆分后单独复验。
```

### 多文件 runner 实验

```text
候选命令 A：npx tsx --test src/modules/agent/integration/agent-settings-profile.integration.test.ts src/modules/agent/testkit/agent-testkit.test.ts
结果/发现文件/测试数/耗时：两个文件均被发现；6/6 通过；runner duration_ms 1305.248991；fixture 目录前/后均为 0。
并发观察：默认多文件 wall clock 约 1s。

候选命令 B：npx tsx --test --test-concurrency=1 src/modules/agent/integration/agent-settings-profile.integration.test.ts src/modules/agent/testkit/agent-testkit.test.ts
结果/发现文件/测试数/耗时：6/6 通过；runner duration_ms 2172.810121。
并发观察：显式串行明显更慢；默认 runner 对独立文件存在文件级并发。未观察到 SQLite/临时目录/app 冲突。

glob 组合：npx tsx --test src/modules/agent/integration/*.test.ts src/modules/agent/agent.integration.test.ts
结果：shell glob 正常展开；旧 164 + 新 1 共 165/165 通过；runner duration_ms 39700.910724，wall clock 约 40s；相关 fixture 目录前/后均为 0。

冻结迁移期间命令：tsx --test src/modules/agent/integration/*.test.ts src/modules/agent/agent.integration.test.ts
理由：实测稳定发现新文件和尚未迁移的旧文件，保持全量覆盖连续；默认并发的耗时优于显式串行。
package script：已更新为上述迁移期间命令；P5 删除旧文件后必须收窄为只发现新目录。
```

### Fixture/testkit 实施

```text
新增：apps/api/src/modules/agent/testkit/agent-integration-testkit.ts
新增：apps/api/src/modules/agent/integration/agent-settings-profile.integration.test.ts
修改：apps/api/src/modules/agent/agent.integration.test.ts（删除已迁移探针）；apps/api/package.json；0009 文档。
最小 options：repoRoot、agentWorkerConcurrency；其余 Plugin Host/fault/global-prompt/route-probe/领域行为均未进入通用 fixture。
teardown 方式：探针以 test context 的 t.after(async () => fixture.dispose()) 显式释放；底层 dispose 已幂等。
全局 fixture 是否消除：新文件没有 Set/WeakMap/共享 DB/app；旧综合文件的历史全局 fixture 仅保留给未迁移的 164 个测试，P5 删除旧文件时消除。
初始化失败：默认初始化失败时先尝试 dispose；若 cleanup 也失败则以 AggregateError 保留原始 cause 和 cleanup failure。
探针测试标题/原行/新路径：GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel / 1651 / integration/agent-settings-profile.integration.test.ts。
断言核对：保留 providers 与 agents 配置请求、两项 200 状态断言、default/custom 两组完整 resolvedModel 深度断言；测试标题未改。
```

### 审查闭环

```text
独立审查员：未参与 P0 实现的独立代码审查员。
结论：通过；无 H/M/L 问题。
修复：无修复项。
复审结论：无需复审（无修复项）。
进入 P1 门禁：P0 审查门禁通过。
```

## P1 记录：特殊资源与 Settings/Profile

### 迁移与边界

```text
迁移文件：
- integration/agent-plugin-host.integration.test.ts：1 项
- integration/agent-startup-recovery.integration.test.ts：6 项
- integration/agent-events-sse.integration.test.ts：1 项
- integration/agent-settings-profile.integration.test.ts：P0 探针 1 项 + P1 Settings/Profile 14 项，共 15 项

P1 迁移标题数：22（不将 P0 resolved-model 探针计入 P1）。
旧副本删除：按标题从 agent.integration.test.ts 删除上述 22 个块；删除后旧 142 + 新目录 23 = 165，唯一标题 165，重复 0。
生产代码：无改动。
```

### 特殊资源与 teardown

```text
Plugin Host：局部 fixture 创建独立 dataDir、mock Feishu plugin 与 socket；finally 关闭 app、DB 并删除 dataDir。定向 1/1 通过，未见 fixture 目录残留。
Startup/recovery：startup fail 与 archive sidecar 保留手工 DB/app 构造；cancel race/runtime fake/direct composition 仅保留在本文件。普通 session 场景使用 P0 窄 fixture，并由 t.after(dispose) 释放。定向 6/6 通过。
SSE：局部拥有 AbortController、reader/body cancel 与 ssePromise catch teardown；fixture 由 t.after(dispose) 释放。定向 1/1 通过。
Settings/Profile：复用窄 fixture、createPrimarySession/sendAgentMessage；subtask session/profile 与 mock fetch 保持文件局部。定向 15/15 通过，远程模型列表场景不访问真实外网。
```

### 实测命令与结果

```text
cwd：apps/api
npx tsx --test src/modules/agent/integration/agent-plugin-host.integration.test.ts
结果：1/1 通过；duration_ms 5717.498063。

npx tsx --test src/modules/agent/integration/agent-startup-recovery.integration.test.ts
结果：6/6 通过；duration_ms 2323.377203。

npx tsx --test src/modules/agent/integration/agent-events-sse.integration.test.ts
结果：1/1 通过；duration_ms 1185.462023。

npx tsx --test src/modules/agent/integration/agent-settings-profile.integration.test.ts
结果：15/15 通过；duration_ms 8717.198511。日志中仍有既有 agent runtime run failed / The database connection is not open warning；不影响 TAP，通过且未修改生产行为。

npm run test:integration
结果：旧 142 + 新 23 = 165/165 通过；fail/cancel/skip 0/0/0；duration_ms 35343.162351。

npx tsx --test src/modules/agent/testkit/agent-testkit.test.ts
结果：5/5 通过；duration_ms 1585.763799。

npm run typecheck（apps/api）与根 npm run typecheck：通过。
git diff --check 与 git diff --cached --check：通过。
.tmp-tests 中 agent-it-*、agent-integration-*、agent-plugin-host-integration-*、agent-startup-*、agent-testkit-*：运行后均无残留目录。
```

### 审查闭环与 P2 门禁

```text
独立审查员：未参与 P1 实现的独立代码审查员。
结论：通过；无 H/M/L 问题。
修复：无修复项。
复审结论：无需复审（无修复项）。
P1 实施与验证门禁：通过；未发现生产代码依赖、测试顺序依赖、资源冲突或 testkit 膨胀。
进入 P2 的审查门禁：P1 审查门禁通过。
回滚边界：四个 P1 目标文件与旧文件对应 22 个测试块可按文件/标题回滚；不回滚 P0 通用 fixture，除非有证据证明其设计错误。
```

## P2 记录：Subtask 与 Session Routes

### 迁移与 helper 边界

```text
迁移文件：
- integration/agent-subtask-lineage.integration.test.ts：10 项
- integration/agent-subtask-routes.integration.test.ts：7 项
- integration/agent-subtask-prefork-result.integration.test.ts：14 项
- integration/agent-session-routes.integration.test.ts：11 项
- integration/subtask.helpers.ts：只供上述四个文件使用的窄领域 helper

P2 迁移标题数：42。
旧副本删除：按 05 清单标题从 agent.integration.test.ts 删除 42 个块；删除后旧 100 + 新目录 65 = 165，唯一标题 165，重复 0。
生产代码：无改动。
```

### 语义与清理

```text
Lineage：保留 SQLite 弱类型 fail-closed、normal continuation、orphan、new-shell compensation、existing reuse、partial unique 与 classifier 断言。
Routes：保留 anchor/service error、auth/schema、depth/mode、session union、trigger/create/fork/run-state 合同。两个 P0 schema probe 在 session-routes 文件局部 appFactory 中、app.ready 前注册，未进入通用 fixture。
Prefork/result：保留 summary/guard/prompt 顺序、prefork meta/threshold、description 截断、locale 回退、assistant/system/empty partial-output fallback。
Fixture：普通测试使用 createP2Fixture(t) 的 t.after(dispose)；已显式传入 fixture 的 context/writeback helper 不依赖旧 fixtureByApp。P2 helper 不进入 agent-integration-testkit。
资源：全量退出后曾短暂观察到 fixture 目录；后续诊断与延迟复查均自行清空，无持久 agent-it-*、agent-integration-*、agent-session-routes-probe-* 或 agent-testkit-* 残留。
```

### 实测命令与结果

```text
cwd：apps/api
npx tsx --test src/modules/agent/integration/agent-subtask-lineage.integration.test.ts
结果：10/10 通过；helper 收敛后复跑 duration_ms 5883.072907。包含注入 subtask failure 的既有 error log，TAP 通过。

npx tsx --test src/modules/agent/integration/agent-subtask-routes.integration.test.ts
结果：7/7 通过；helper 收敛后复跑 duration_ms 4621.944741。

npx tsx --test src/modules/agent/integration/agent-subtask-prefork-result.integration.test.ts
结果：14/14 通过；helper 收敛后复跑 duration_ms 8167.842608。

npx tsx --test src/modules/agent/integration/agent-session-routes.integration.test.ts
结果：11/11 通过；helper 收敛后复跑 duration_ms 4800.815499。仍可见既有 agent runtime run failed / The database connection is not open warning；不影响 TAP，未修改生产行为。

npx tsx --test src/modules/agent/subtask/subtask-application.test.ts src/modules/agent/subtask/subtask-activation.persistence.test.ts src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts src/modules/agent/session-routes-module-p0-baseline.test.ts
结果：26/26 通过；helper 收敛后复跑 duration_ms 2603.167409。

npm run test:integration
结果：旧 100 + 新 65 = 165/165 通过；fail/cancel/skip 0/0/0；helper 收敛后复跑 duration_ms 28708.913149。

npm run typecheck（apps/api）与根 npm run typecheck：通过。
git diff --check 与 git diff --cached --check：通过。
```

### 审查闭环与 P3 门禁

```text
独立审查员：未参与 P2 实现的独立代码审查员。
结论：通过；无 H/M/L 问题。
修复：无修复项。
复审结论：无需复审（无修复项）。
P2 实施与验证门禁：通过；未发现生产代码依赖、测试顺序依赖、持久资源冲突或通用 testkit 膨胀。
进入 P3 的审查门禁：P0-P2 审查门禁通过。
Git 阶段动作：P0-P2 已由主会话暂存。本会话未执行 Git 写操作。
回滚边界：四个 P2 目标文件、subtask.helpers.ts 与旧文件对应 42 个测试块可按领域文件回滚；不得同时重写 Subtask 生产 application 或 persistence。
```

## P3 记录：Read Context、Run Cancel、Session Control

```text
迁移文件：
- agent-read-context.integration.test.ts：16 项；
- agent-run-cancel.integration.test.ts：6 项；
- agent-session-control.integration.test.ts：14 项；
- context-writeback.helpers.ts：P3 窄 helper。
迁移测试标题数：36。
显式 fixture helper：context-writeback.helpers.ts 导出 createP3Fixture、session/message、context item create/update 与 run-state update；writeback helper 均显式接收 fixture，不进入 agent-integration-testkit。
旧 fixtureByApp 是否仍存在：P3 新文件与 helper 均不依赖；旧综合文件中的历史残留仅服务 P4 尚未迁移测试。
concurrency:false 保留位置：agent-run-cancel.integration.test.ts 中“agent cancel 会基于当前 active run 的 subtask 结果精确级联取消活动 child，且不误取消历史 fork child”。
Read/reasoning 覆盖：messages-context、prompt-context、context-items、assistant reasoning 的 create/read/update，以及 failed assistant、boundary reason。
Cancel/cascade 覆盖：hidden chain 收敛、terminal dirty data 不误改写、active child cascade。
Clear/revert/compact 覆盖：compact、clear、revert、workspace cleanup 与 clear 并发归档不重复。
每测试 fixture：createP3Fixture(t) 注册 t.after(dispose)，无跨文件全局 Set/WeakMap。

定向命令与结果（cwd：apps/api）：
npx tsx --test src/modules/agent/integration/agent-read-context.integration.test.ts
结果：16/16 通过；duration_ms 10274.192836。

npx tsx --test src/modules/agent/integration/agent-run-cancel.integration.test.ts
结果：6/6 通过；duration_ms 5674.379684。

npx tsx --test src/modules/agent/integration/agent-session-control.integration.test.ts
结果：14/14 通过；duration_ms 6449.18301。

相关 lifecycle/writeback/session 回归：
npx tsx --test src/modules/agent/agent-run-context.test.ts src/modules/agent/context-item-contract.test.ts src/modules/agent/writeback.api.test.ts src/modules/agent/writeback/context-writeback-application.test.ts src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/run-lifecycle.persistence.test.ts src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts src/modules/agent/query/context-query-application.test.ts src/modules/agent/read-side/messages-context-projector.test.ts src/modules/agent/read-side/prompt-context-projector.test.ts src/modules/agent/session/session-interaction-application.test.ts
结果：67/67 通过；duration_ms 8386.581029。存在既有 injected token cleanup failure、injected compaction Store failure 日志，TAP 通过，未修改生产行为。

npm run test:integration
结果：旧 64 + 新 101 = 165/165 通过；fail/cancel/skip/todo 均为 0；duration_ms 23172.369581。

npm run typecheck（apps/api）与根 npm run typecheck：通过。
git diff --check 与 git diff --cached --check：通过。
标题唯一性：旧 64 + 新 101 = 165；unique 165，duplicates 0；P3 清单 36 项均恰有一个副本。
资源复查：全量结束后延迟 5 秒检查，未发现 agent-it-*、agent-integration-*、agent-session-routes-probe-* 或 agent-testkit-* 目录残留。

独立审查员：未参与 P3 实现的独立代码审查员。
独立审查问题：无 H/M/L 问题。
修复：无修复项。
复审：无需复审（无修复项）。
删除的旧测试块：从 agent.integration.test.ts 删除 P3 对应 36 项；删除后旧 64 + 新 101 = 165，重复 0。
Git 阶段动作：P0-P3 已由主会话暂存。本会话未执行 Git 写操作。
回滚点：三个 P3 目标文件、context-writeback.helpers.ts 与旧综合文件对应 36 个测试块作为同一小批回滚；不得修改生产代码，也不得长期混用旧 fixtureByApp 与新显式 helper。
```

## P4 记录：Prompt、Peripheral、Archive、Artifact、Global/Workspace

```text
迁移文件：agent-prompt-context.integration.test.ts（17 项）、agent-peripheral-status.integration.test.ts（18 项）、agent-archive-compaction.integration.test.ts（6 项）、agent-artifact-tool-output.integration.test.ts（11 项）、agent-global-prompts-workspace.integration.test.ts（12 项）；另有 p4-fixture.helpers.ts。
迁移测试标题数：64。
fixture helper：createP4Fixture(t, options?) 普通场景复用 createAgentIntegrationFixture；仅 agentTestFaults.archiveWrite 与 global prompts 预置/修复需要局部 pre-app 初始化，不进入通用 integration testkit。
Prompt/tool/locale 覆盖：locale/runtime constraints、tool description/schema、structured tool-call/result、apply_patch patchText、todolist 截断与空白 goal、subtask 工具可见性，以及 uiLocale 回退链。
Peripheral auth/status/tail 覆盖：internal final-text、run-state notice/terminal/idle、status-summary、allowlist、internal auth/plugin id 与 context-items-tail。
Archive/compaction 覆盖：compaction、archive search/read、snippet 注入/即时重建、zh-CN 文案、v2 边界、snippet 窗口与 archive rollback；rollback 子 fixture 显式使用自身 fixture。
Artifact/path/symlink 覆盖：completed-only artifact、missing 404、workspace artifact 路径越界 symlink、slim result、cancel/failed 完整 content、string result 原义与 legacy output/resultFormat 兼容。
Global/workspace/skills 覆盖：global prompts 配置兼容/归一化、expandOnSelect、global/workspace/agent 拼接顺序、根 AGENTS.md、32KB 截断、skills 摘要/同 run 缓存、repo symlink/路径失配安全跳过与 startup seed 修复。
每测试资源：每个测试独立 fixture 并注册幂等 dispose；Prompt、Archive、Artifact 的文件系统副作用仍局部管理，未向通用 testkit 注入领域逻辑。

定向命令与结果（cwd：apps/api）：
npx tsx --test src/modules/agent/integration/agent-prompt-context.integration.test.ts
结果：17/17 通过；duration_ms 8564.245174。
npx tsx --test src/modules/agent/integration/agent-peripheral-status.integration.test.ts
结果：18/18 通过；duration_ms 9717.056133。
npx tsx --test src/modules/agent/integration/agent-archive-compaction.integration.test.ts
结果：6/6 通过；duration_ms 5704.380645。
npx tsx --test src/modules/agent/integration/agent-artifact-tool-output.integration.test.ts
结果：11/11 通过；duration_ms 6429.892813。
npx tsx --test src/modules/agent/integration/agent-global-prompts-workspace.integration.test.ts
结果：12/12 通过；duration_ms 6403.381271。

相关回归：archive、compaction、prompt、query、read-side、writeback 等 17 个既有测试文件共 51/51 通过；duration_ms 2559.920873。
npm run test:integration：TAP 166/166 通过，fail/cancel/skip/todo 均为 0；duration_ms 22597.484928。活动测试标题为旧 0 + 新 165 = 165，unique 165、duplicates 0；额外的 1 是脚本显式载入无活动测试旧文件产生的文件级 subtest。
npm run typecheck（apps/api）与根 npm run typecheck：通过。
git diff --check 与 git diff --cached --check：P4 代码迁移完成后及本轮文档更新后均已通过。
资源复查：全量结束后延迟 5 秒检查，未发现 agent-it-*、agent-integration-*、agent-session-routes-probe-* 或 agent-testkit-* 目录残留。
删除的旧测试块：从 agent.integration.test.ts 删除 P4 对应 64 项；旧文件现仅保留 imports/helpers、无活动测试，整个旧文件按 P5 决策删除。
独立审查员：未参与 P4 实现的独立审查员。
独立审查问题：无 H/M/L 问题。
修复：无修复项。
复审：无需复审（无修复项）。
Git 阶段动作：P0-P4 已由主会话暂存。本会话未执行 Git 写操作。
回滚点：五个 P4 目标文件、p4-fixture.helpers.ts 与旧综合文件对应 64 个测试块按语义小批回滚；不得修改生产代码，不得把 P4 领域逻辑扩张进通用 testkit。
```

## P5 记录：清理与总验收

```text
旧综合文件：apps/api/src/modules/agent/agent.integration.test.ts 已删除；未保留 cross-domain smoke。
最终 integration 文件：16 个 *.integration.test.ts，测试数依次为 1、6、1、10、7、14、11、14、16、6、15、17、18、6、11、12，共 165 项。
实际 helper 文件：subtask.helpers.ts（241 行）、context-writeback.helpers.ts（184 行）、p4-fixture.helpers.ts（135 行）；agent-integration-testkit.ts 为 136 行基础 fixture。审阅结果：通用 testkit 仅含 ready fixture、默认 settings/allowlist 和稳定 session/message helper，领域流程仍为局部/窄 helper，未发现需局部修复的明显可维护性问题。
最终脚本：test:integration = tsx --test src/modules/agent/integration/*.test.ts。
方案差异：无业务测试改名、遗漏或重复；P4 迁移期的空旧文件 subtest 在 P5 删除旧文件后消除。

机器清单核对：以 HEAD 旧综合文件 165 个标题为基线，新目录活动标题 165、unique 165、missing 0、extra 0、duplicates 0；旧文件不存在。生产代码 diff 名单为空。

新 integration 全量（cwd：apps/api）：npm run test:integration；165/165 通过，fail/cancel/skip/todo 均为 0；duration_ms 21666.417237。
API 全量（cwd：apps/api）：npx tsx --test $(find src -path '*/.data/*' -prune -o -name '*.test.ts' ! -path 'src/modules/plugins/plugin.service.test.ts' -print | sort)；334/334 通过；duration_ms 26873.44707。
API typecheck（cwd：apps/api）：npm run typecheck；通过；外层耗时 2993 ms。
worker integration（cwd：apps/api）：npm run test:integration:worker；3/3 通过；duration_ms 7104.926429。
Feishu 回归（cwd：仓库根）：npm test -w plugins/feishu；11/11 通过；duration_ms 139.628175。
Web 回归（cwd：仓库根）：npm test -w apps/web；24/24 通过；duration_ms 170.641178。
root build（cwd：仓库根）：npm run build；通过；外层耗时 35144 ms。预期 warning：Browserslist 数据过期、部分 Web chunk 超过 500 kB；构建成功，未扩张本专项范围。
root typecheck（cwd：仓库根）：npm run typecheck；通过；外层耗时 11541 ms。
资源遗留检查：全量后延迟 5 秒，agent-it-*、agent-integration-*、agent-session-routes-probe-*、agent-testkit-* 均无残留。
git diff --check / git diff --cached --check：本轮文档更新后已通过。
Git 阶段动作：P0-P5 已由主会话暂存。本会话未执行 Git 写操作。
回滚点：恢复旧综合文件、迁移期脚本和新 integration 文件会重新引入已消除的空文件 subtest，不建议；若需回滚，应作为完整测试结构回滚并重新执行唯一性与全量验证。
```

### P5 审查闭环

```text
独立审查员：未参与 P5 实施的独立审查员。
问题：通过；无 H/M 问题，1 个 L1 文档问题：README 文档结构表仍将 09-implementation-record.md 描述为“待实施记录模板”。
修复：已将 README 对 09 的描述修复为“实施记录与验收日志；只记录实际执行并看到的结果”。
复审：通过；同一审查员已复审 L1 修复。
```

## 全面独立终审记录

终审员未参与 P0-P5 实施及批次审查。

```text
审查范围：P0-P5 实施、165 项唯一归属、测试/验证证据、fixture/testkit 边界、生产代码 diff、批次审查与 P5 L1 修复闭环。
165 项唯一归属结论：通过；新目录 165、唯一 165、遗漏/额外/重复均为 0，旧综合文件已删除。
覆盖是否下降：无；标题与核心主链均已保留。
特殊主链是否保留：是；特殊主链继续局部 fixture/pre-app/direct seam，不硬塞通用 testkit；internal final-text 归 Peripheral Status。
fixture/testkit 是否可维护：通过；无必须补代码差距。L1：createSession/sendMessage 小幅重复于 integration testkit、context-writeback helper、subtask helper；L2：默认 providers/agents 初始化在 integration testkit 与 P4 特殊 fixture 有近似重复。两项均不在本专项补代码：复制面有限、helper 职责/fixture 类型及 pre-app/ready 生命周期不同，立即统一会扩大共享 testkit 耦合并可能削弱显式前置状态；未来相关调用约定或 bootstrap 变化时再需求驱动收敛。
runner/并发/teardown 是否有实测证据：是；引用 P0-P5 已记录的 runner、全量、资源与 teardown 结果。
生产代码是否零改动：是。
与方案差异及接受理由：未保留 cross-domain smoke；P4 过渡期的空旧文件 subtest 随 P5 删除旧文件消除；最大文件 agent-subtask-prefork-result.integration.test.ts 为 1433 行，低于关注阈值。上述差异可接受。
验证证据：引用 P5 已实际执行并记录的 new integration、API 全量、API/root typecheck、root build、worker/plugin/web 回归、资源与 diff 检查；终审员未单独执行 root build，不将其记为终审执行。
阻断问题：无。
最终结论：通过；达到完成定义，无 H/M 问题，无必须补代码差距，专项完成。
```

## Git 阶段动作模板

只有用户明确授权后才填写：

```text
授权内容：
执行命令：
diff check：
提交：
push：默认否
历史改写：默认否
最终 status：
```
