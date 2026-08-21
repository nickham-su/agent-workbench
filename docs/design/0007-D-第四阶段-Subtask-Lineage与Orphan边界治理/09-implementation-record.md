# 阶段实施记录

> 状态：P0-P6 已全部完成；未参与实现的新审查员已完成全面独立终审，结论为通过，无必须补代码的问题，本阶段完成。
> 方案起草基线：分支 `v1.1...origin/v1.1 [ahead 2]`，HEAD `3c40dab feat(agent): implement phase 3 run lifecycle governance`；起草前工作区无未提交变更。
> P0 范围：仅更新基线/代码地图/记录/状态文档；未修改生产代码、Shared contract、DB schema 或 Worker。未新增测试，因为现有真实 SQLite/API/Worker/Shared characterization 已覆盖 P0 可证明的当前事实。
> P1 范围：只新增独立 SQLite persistence/wiring tests 与测试地图/记录；未修改生产代码、Shared contract、DB schema、Worker 或 production wiring。
> P2 范围：新增 application/ports/named lineage adapter 并进行 AgentService composition；不迁移 prefork/start/result/status/orphan 生产规则，不修改 route/module/Worker/Shared/DB schema。
> P3 范围：迁移 prefork/start/reuse/race/child activation/local compensation；不迁移 result/status 或 orphan startup，不修改 Shared/Worker 合同或 DB schema。
> P4 范围：迁移 result/status ownership 与 projection，并收口 local/orphan delete capability 与 SQLite adapter 边界；不迁移 orphan startup policy、循环或 module 触发，不修改 Shared/Worker 合同或 DB schema。
> P5 范围：迁移 orphan startup use-case、1h/24h policy、candidate isolation/logger 与 summary；module/service 仅保留触发/转发及顶层 failure isolation，不引入通用 startup coordinator，不修改 Shared/Worker 合同或 DB schema。
> P6 范围：完成结构审计、完整回归与文档整理；未修改 Shared/Worker/UI 合同、schema 或无关模块。其后新审查员全面独立终审已完成并通过，本阶段据此完成。

## 记录规则

- 长期行为事实更新 `02-baseline-and-evidence.md`；
- application/ports/Lifecycle协作更新 `03-subtask-domain-design.md`；
- orphan/startup更新 `04-startup-and-orphan-boundary-design.md`；
- 路径/符号更新 `07-code-map.md`；
- 实际命令、cwd、结果、耗时、预期日志、审查和偏差记录在本文件；
- 不记录 prompt、description、tool args/result、token、用户内容或敏感绝对路径；
- 每批第一项完整记录 `git status --short --branch`；
- 未执行并看到结果的命令不得标记通过；
- 未实施设计不得写成已完成事实；
- 非本阶段变更不得处理、暂存或回滚。

## 当前批次状态

| 批次 | 实现 | 实现者测试 | 独立审查 | 修复 | 独立复审 | Git阶段动作 |
|---|---|---|---|---|---|---|
| 方案初稿 | 已完成 | 文档静态检查通过 | 已收到 M1-M3/L1 | 已完成本轮文档修订 | 待独立复审 | 否 |
| P0 行为基线 | 已完成 | 通过（定向 Shared/API/Worker + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P1 测试地基 | 已完成 | 通过（独立 SQLite/wiring + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P2 application/ports骨架 | 已完成 | 通过（Subtask contract/persistence/wiring + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P3 prefork/start/race/activation/compensation | 已完成 | 通过（Subtask fake/SQLite/wiring、API integration、Worker回归 + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P4 result/status/删除adapter收口 | 已完成 | 通过（Subtask fake/SQLite/wiring、API integration + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P5 orphan/startup | 已完成 | 通过（Subtask fake/SQLite/wiring + API integration + API typecheck） | 已通过（既有） | 按审查完成 | 已通过（既有） | 由父会话处理 |
| P6 收尾/回归/终审 | 已完成 | 通过（完整矩阵、根 build/typecheck、diff hygiene） | 已通过（新审查员全面独立终审） | 无需修复 | 不适用（终审无必须修复项） | 由父会话处理；本次文档收口未执行 Git 写操作 |

## 方案起草记录

### 输入文档

- `0006-Agent模块结构治理总方案`：target architecture、roadmap、risks/decisions；
- `0007-C`：Run Lifecycle application/ports/persistence、startup边界与文档模板；
- `0008-Agent-Fork与Subtask深度语义重构`：已实施的 Fork/depth/session/lineage语义、测试矩阵和历史代码地图。

### 只读代码证据

- Shared Subtask contract/endpoint registry/tests；
- Worker API client、BuiltinToolProvider subtask主链、prefork/reuse/cancel/tool-output tests；
- API routes、module；
- `AgentService` 的 parent anchor、prefork、session resolution、start、result/status、compensation、orphan；
- `agent.store.ts` 的 parent-tool query、child query、candidate/delete；
- DB partial unique index；
- Lifecycle `ActiveSubtaskChildQuery` 与 SQLite persistence结构；
- API integration中的 Subtask/lineage/orphan证据。

### 起草时确认的当前事实

- Shared四个 Subtask endpoint稳定；
- Worker生成可选 prefork summary，API重新验证 meta；
- start预查与race均以 `(parentRunId,parentToolItemId)` 为权威；
- partial unique index是最终仲裁；
- child activation当前在一个 transaction写 seed/run/state；
- API不enqueue child，Worker负责 nested execution；
- existing不进入本次新建compensation；
- 当前部分transaction失败路径会经嵌套catch对同一`createdSessionId`重复尝试best-effort cleanup；这是实现细节而非产品语义；
- local与orphan当前共用参数化删除helper；
- orphan保持1h suspect、24h+fork lineage删除、final empty recheck、candidate isolation；
- Lifecycle cancel只依赖durable child query；
- `subtaskSessionId` 为展示/提示，不是durable lineage。

### 方案核心选择

- 建立单一 Subtask application；
- 推荐 Lifecycle-owned nested child activator，但不复用 `startUserRun()`；
- Subtask通过窄 activator协作，Lifecycle通过窄 child query协作；
- local compensation与start failure在P3同批迁移；P4只做result/status与删除adapter边界收口；
- orphan公开port不暴露`requireForkLineage`，安全条件固化在adapter；
- 不扩张`AgentRuntime`、worker-disabled wiring或local fallback nested execution；
- module分别触发域startup use-case，不提前建立通用startup coordinator；
- P0-P6小批推进，P3/P5不得合并。

### 待独立审查重点

- Lifecycle-owned activator是否是最小且一致的责任归属；
- session materializer/clone port是否会掩盖Archive边界；
- unique race的compensation/winner lookup顺序描述是否与当前实现和测试完全一致；
- P0是否准确识别重复cleanup路径，P3收敛为单入口时是否语义等价；
- result projection是否应与 lineage persistence同adapter或单独query capability；
- local/orphan SQL原语是否严格只在SQLite adapter内部私有共享；
- local fallback结构审计能否充分证明无误接线，而无需新增虚假行为测试；
- module保持当前startup顺序是否需要更强结构测试；
- P0/P1的并发race测试是否可确定性实现。

### 方案初稿静态检查

实际执行：

```bash
find "docs/design/0007-D-第四阶段-Subtask-Lineage与Orphan边界治理" -maxdepth 1 -type f
git status --short --branch
git diff --check
rg -n "已实施|已完成|待独立审查|未开始|subtaskSessionId|parentRunId|parentToolItemId|P0|P6" \
  "docs/design/0007-D-第四阶段-Subtask-Lineage与Orphan边界治理"
```

结果：10 份目标文档齐全；仅本方案目录为 untracked；`git diff --check` 通过；状态/术语搜索未发现把 P0-P6 候选设计写成已实施事实。该检查不替代独立方案审查。

### 独立审查 M1-M3/L1 修订

- M1：明确 local compensation 属于 `startSubtask()` failure semantics，P3 与 prefork/start/reuse/race/activation 同批迁移；P4 只迁 result/status，并收口 local/orphan capability 命名、adapter 导出边界和旧通用 helper；
- M2：`deleteSuspectIfStillEligible()` 公开 port 移除 `requireForkLineage`，fork lineage 固化于 SQLite orphan adapter；共享 SQL 只允许作为 adapter 内部私有原语；
- M3：增加结构门禁，禁止 `AgentRuntime`、worker-disabled wiring、local runtime execution port 和 `SubtaskApplication` runtime依赖扩张；本阶段不为local fallback补nested-subtask execution；
- L1：基线补充当前嵌套 catch 对同一 `createdSessionId` 可能重复 best-effort cleanup；将其定义为待P0核实的实现形态，而非产品语义。

本轮只修改方案文档；P0-P6仍未开始。修订后需由独立审查员复核批次边界、port安全条件和local fallback结构门禁。

## P0 实施记录

### Git边界

```text
命令：git -C agent-workbench status --short --branch；git -C agent-workbench diff --cached --stat；git -C agent-workbench diff --stat
cwd：/data/workspaces/agent-workbench
输出摘要：v1.1...origin/v1.1 [ahead 2]；0007-D 十份方案文档已在 index，worktree 起始时无额外改动。
未知变更：无。P0 只修改了已有 staged 方案目录中的 README、02、07、09；未执行 git add/commit/reset/checkout。
保护结论：未触碰 0007-D 目录外文件，未做 Git 写操作。
```

### 行为基线

```text
Shared：四个 endpoint、request/response schema、new/fork/existing union、prefork meta、reused 与稳定 error code 已由 shared contract test 和 Worker client response schema 冻结。
prefork：仅 fork 请求 plan；shouldPrefork=false 继续 start；summary 空/普通错误降级；abort 中止；start 重算 meta。
anchor：session/run/tool 的 workspace/session/run/kind/toolName 层层验证；AnchorRunMismatch/AnchorInvalid 等既有业务错误不变。
mode真值表：new / fork summary / fork boundary / fork no-boundary / existing 的 metadata、clone、summary→guard→prompt 或 guard→prompt 顺序已记录于 02。
reuse：预查命中直接 reused；Worker reused=true 只 polling/result，不调用 processNestedRun；reused=false 才 nested execute。
unique race：partial unique 为最终仲裁；当前精确顺序为 inner cleanup → target classifier → find winner → reused；无法在当前同步单进程实现下诚实构造双连接可控 interleave，P1 必补真实 SQLite harness。
activation transaction：summary/guard/prompt、child run、running state 同一 SQLite transaction；session materialization 与 idle check 在其外。
result/status：session/run ownership 后返回 status；result 选择 assistant→system→empty，failed/cancelled partial text 保留。
compensation：existing createdSessionId=null；仅本次新建可补偿；inner/outer catch 对部分失败路径双次 best-effort cleanup；final fence 防误删已有内容；原错误优先。
orphan：1h suspect、24h+双 fork lineage 删除、final empty fence；顶层 list 错误由 module 隔离，candidate error 逐条隔离。
startup顺序：routes 后 orphan → archive reconcile → fail/recover → worker start；不代表应合并 startup use-case。
local fallback：AgentRuntime/LocalAgentRuntimeExecutionPort 无 Subtask API 或 nested execution；只有 API-managed Worker 路径支持 processNestedRun。
```

### 测试命令

| 命令 | cwd | 结果 | 备注 |
|---|---|---|---|
| `npm run build -w packages/shared && (cd packages/shared && npx tsx --test tests/internal-contracts.test.ts)` | 仓库根 | 通过 | Shared endpoint/schema/error code 回归。 |
| `npm run test:integration -w apps/api` | 仓库根 | 通过 | API integration，覆盖 anchor/mode/lineage/cancel/orphan/compensation/result/status。 |
| `npx tsx --test src/runtime/apiClient.test.ts src/runtime/provider-subtask-cancel.test.ts src/runtime/tools/providers/builtin.prefork.test.ts` | `apps/agent-worker` | 通过 | Worker validation、prefork 降级/abort、reuse polling/nested 边界。 |
| `npm run typecheck -w apps/api` | 仓库根 | 通过 | P0 文档/测试范围的 API 类型检查。 |
| `git diff --check` | 仓库根 | 通过 | 文档差异无空白错误。 |

未执行：P0 不应提前创建 P1 application/persistence/wiring test 骨架；未执行全量 build/typecheck，留给 P6。

### P0 未决项与进入审查提醒

```text
必须提醒审查员：P0 没有双独立 SQLite connection 的确定性 start race 证据；这是诚实保留给 P1 的门禁，不得被视为 P0 偷换为已证明。
必须提醒审查员：当前 unique conflict 的 cleanup 发生在 winner lookup 之前；内层命中 winner 时会直接 return reused，outer catch 不执行。
必须提醒审查员：local compensation 和 orphan 仍共用旧 helper，属于 P3/P4/P5 后续结构迁移目标，不是 P0 漏改。
必须提醒审查员：local fallback 无 nested Subtask 是结构事实，不应要求本批补功能。
```

## P1 实施记录

### 批次范围

```text
完成：新增 subtask-lineage.persistence.test.ts 与 subtask-wiring.test.ts；更新 README、06、07、09。
生产文件：无。
明确排除：SubtaskApplication、ports、SQLite production adapter、facade/routes/module/Lifecycle production装配、Shared/Worker/DB schema；不删除既有 integration tests。
```

### 测试证据与边界

```text
真实 SQLite：find child by parent tool、cancel child query 的真实 parent subtask-tool join、partial unique index、目标 classifier、local empty-shell fence、orphan candidate/final delete fence、result/status ownership 与按run projection。
wiring：Lifecycle 当前仅获 ActiveSubtaskChildQuery；P2 前 AgentService 仍为现有Subtask权威；LocalAgentRuntimeExecutionPort 没有Subtask/nested成员。
保留集成：agent.integration.test.ts 的 anchor、mode、activation transaction、conflict-reuse、compensation、route 证据未迁移或删除。
```

### 已知缺口与处理理由

```text
没有新增 application fake-port 测试：P2 前没有真实 SubtaskApplication；为测试而抽取生产 seam 会提前进入P2并制造双权威。P2 落地真实application后，必须用显式fake ports覆盖顺序、plan/meta、mode、conflict winner re-query、compensation和candidate isolation。
没有确定性双独立SQLite连接交错race harness：本批真实证明partial unique和目标constraint classifier，且保留既有 conflict-reuse 集成证据；但不把它表述成双start race证明。P2/P3前必须决定可维护的可控交错方式或以真实SQLite多连接测试补强。
anchor ownership/tool validation 与 activation transaction 已由保留的API integration真实链路覆盖，本批没有复制为store测试，因为它们当前仍与AgentService orchestration绑定；P2/P3抽取persistence/application后必须将其迁入对应独立层。
```

### 验证

| 命令 | cwd | 结果 | 备注 |
|---|---|---|---|
| `npx tsx --test src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts` | `apps/api` | 通过，6 tests | P1 独立真实 SQLite 与 wiring 证据。 |
| `npm run typecheck` | `apps/api` | 通过 | API TypeScript 无错误。 |

### 进入独立审查提醒

```text
审查应确认本批没有因“测试地基”提前创建production SubtaskApplication/ports/adapter或改动行为。
审查应拒绝将real partial unique + classifier误写为确定性双connection start race。
审查应确认P1的P2前wiring断言没有把不存在的SubtaskApplication当作已完成结构。
```

## P2 实施记录

### 批次范围

```text
生产：新增 SubtaskApplication、subtask-ports 和 SqliteSubtaskLineagePersistence；AgentService 构造并持有 application，Lifecycle 改为只接收来自该 adapter 的 ActiveSubtaskChildQuery。
测试：新增 subtask-application.test.ts，更新 subtask-wiring.test.ts。
文档：更新 README、06、07、09。
明确排除：不迁移 prefork/start/reuse/race/activation/result/status/local compensation/orphan；不改 route/module/Worker/Shared/DB schema/AgentRuntime；不创建 no-op nested activator。
```

### 实施摘要

```text
SubtaskApplication 只保存 SubtaskApplicationDependencies，P2 不公开产品用例，因而不能与旧 AgentService 形成可调用双权威。
ports 明确 anchor/lineage、session materializer、profile/settings、workspace/run-state、future nested activator、result query、local compensation、orphan、clock/id/logger 的后续真实调用面。
SqliteSubtaskLineagePersistence 是同一命名实例：application 获得 findChildByParentTool，Lifecycle 获得 ActiveSubtaskChildQuery；后者不获得其余 Subtask capabilities。
childRunActivator 在 P2 显式为 null：接口已被类型化但没有生产 fallback 或 Lifecycle application 注入。P3 必须先提供真实 atomic child activation adapter，再迁移完整 start 主链。
```

### P2 验证

| 命令 | cwd | 结果 | 备注 |
|---|---|---|---|
| `npx tsx --test src/modules/agent/subtask/subtask-application.test.ts src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts` | `apps/api` | 通过，8 tests | P2 composition、adapter/wiring及保留 P1 SQLite 证据。 |
| `npm run typecheck` | `apps/api` | 通过 | API TypeScript 无错误。 |

### 已知缺口与进入审查提醒

```text
P2 没有也不得让 facade 调用 application：application 尚无用例方法，旧AgentService仍是唯一可调用产品权威。审查不得误将“已创建application”认定为P3迁移完成。
P2 adapter暂时委托既有Store SQL；P3迁移start后仍须消除该主链对Store helper的直接调用，P4/P5再按删除/query边界继续收口。
没有确定性双SQLite connection race harness；仍是P3前门禁。没有application fake行为测试；P3迁移首个真实用例时随用例添加，不能延后。
```

## P0 记录模板

### Git边界

```text
命令：
cwd：
输出摘要：
未知变更：
保护结论：
```

### 行为基线

```text
prefork：
anchor：
mode真值表：
reuse：
unique race：
activation transaction：
result/status：
compensation：
orphan：
startup顺序：
local fallback：
```

### 测试命令

```text
命令：
cwd：
结果：
耗时：
预期日志：
失败/缺口：
```

### 审查

```text
审查员/session：
问题：
修复：
复审：
门禁结论：
```

## P1-P6 通用记录模板

### 批次范围

```text
目标：
生产文件：
测试文件：
文档：
明确排除：
```

### 实施摘要

```text
完成：
未完成：
与方案差异：
差异理由：
```

### 验证

| 命令 | cwd | 结果 | 备注 |
|---|---|---|---|
|  |  |  |  |

### 结构审计

```text
facade：
routes/module：
lineage单一权威：
activation transaction：
Lifecycle/Subtask依赖：
delete policy分离：
Worker/Shared边界：
```

### 独立审查与复审

```text
初审结论：
高优先级：
中优先级：
低优先级：
修复：
复审结论：
Git阶段动作授权：
```

## 最终验收记录模板

### 完整回归

| 范围 | 命令 | 结果 |
|---|---|---|
| Shared |  |  |
| API domain |  |  |
| API full |  |  |
| Plugin fixture |  |  |
| Worker |  |  |
| Web/Plugin |  |  |
| Root build/typecheck |  |  |
| diff checks |  |  |

### 最终独立审查

```text
新审查员/session：
审查边界（staged/worktree/both）：
方案完成度：
行为结论：
结构结论：
方案差异：
遗留问题：
是否通过：
```

### 阶段结论

```text
P0-P6：
Shared/API/Worker产品语义：
lineage/race：
activation：
compensation/orphan：
startup：
Git状态：
是否可进入Compaction/Archive阶段：
```

## P3 实施记录

### 责任迁移

- `SubtaskApplication` 已接管 prefork plan、start 输入/metadata 校验、existing child 快速复用、depth 限制、fork boundary、session materialization 协调、profile/workspace 读取、seed plan、unique-conflict winner re-query，以及本次新建 session 的单一 best-effort local compensation。
- `AgentService.getSubtaskPreforkPlanFromWorker()` 与 `startSubtaskRunFromWorker()` 已成为仅转发 application 的兼容 facade；旧 start transaction、winner projection 与嵌套 catch cleanup 已同批删除。
- `SqliteRunLifecyclePersistence` 实现窄 `SubtaskChildRunActivator.activate()`：一个 SQLite transaction 内执行最终 idle check、按 seed 顺序追加 context items、仅 prompt 附加 child `runId`、创建含 lineage/depth 的 child run，并更新 active run-state；不调用 `startUserRun()` 或 runtime enqueue，也不含 mode/reuse/compensation 规则。
- `SqliteSubtaskLineagePersistence` 现在是 target parent-tool unique classifier 的权威实现；`AgentService` 仅为既有测试兼容 re-export 该函数。
- 截至 P3 完成时，result/status query 与 orphan startup policy/trigger 均仍在 Service；P4 已迁移前者，P5 仍保留后者。

### P3 测试与结果

| 命令 | cwd | 结果 |
|---|---|---|
| `npx tsx --test src/modules/agent/subtask/subtask-activation.persistence.test.ts src/modules/agent/subtask/subtask-application.test.ts src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts` | `apps/api` | 通过，14 tests |
| `npx tsx --test src/modules/agent/agent.integration.test.ts` | `apps/api` | 通过（既有 fault-injection 预期 error 日志不影响结果） |
| `npm run typecheck` | `apps/api` | 通过 |
| `npx tsx --test src/runtime/apiClient.test.ts src/runtime/provider-subtask-cancel.test.ts src/runtime/tools/providers/builtin.prefork.test.ts src/runtime/runner.tool-output.test.ts` | `apps/agent-worker` | 通过 |
| `git diff --check` | 仓库根 | 通过 |

### P3 已知缺口

- 仍未实现双独立 SQLite connection 的可控交错 harness，因此不能声称已有确定性双 start race 证明。
- 本批以真实 SQLite partial unique、目标 classifier、application fake-port 的 loser cleanup → winner re-query 顺序，以及 API integration 的 conflict/reuse 行为共同覆盖；该组合不替代双连接并发证据。后续阶段若建立可控 harness，必须新增而不是追认已覆盖。
- P3 将旧的双 best-effort cleanup 实现形态收敛为 application 的单一 best-effort入口；existing session 不传入 `createdSessionId`，winner 与原始错误均不会被 cleanup 异常覆盖。真实 API integration 和 fake-port tests 覆盖该产品语义。

## P4 实施记录

### 责任迁移

- `SubtaskApplication.getResult()` / `getStatus()` 接管 workspace/session/run ownership 检查、durable run status，以及 assistant-first、system-fallback、empty result projection；failed/cancelled 的 partial result 保持可读。
- `AgentService.getSubtaskRunResultFromWorker()` 与 `getSubtaskRunStatusFromWorker()` 均为仅转发 application 的兼容 facade，不再保留 result/status 领域实现。
- 新增 `SqliteSubtaskRunQuery`，以 `findSession()`、`findRunInSession()`、`listVisibleItemsByRun()` 承担 ownership-fenced read；run-visible-items 在 adapter 按请求 run 过滤。
- 新增 `SqliteSubtaskMaintenancePersistence`：P3 的 local compensation 仅使用 `deleteNewSessionIfStillEmpty()`；P5 前仍由 Service 承载的 orphan policy 仅使用 `listSuspects()` / `deleteSuspectIfStillEligible()`。共享 empty-session final-fence SQL 是 adapter 私有实现，公开 capability 不含可关闭 fork-lineage/age 条件的参数。
- 旧 `agent.store.ts` 参数化 orphan list/delete helper 已删除；`SubtaskApplication` 不注入 orphan capability。P5 的 1h/24h policy、候选循环、单条失败隔离以及 startup/module 触发保持在 `AgentService`，本批未迁移。

### P4 测试与结果

| 命令 | cwd | 结果 |
|---|---|---|
| `npx tsc --noEmit --pretty false -p tsconfig.json` | `apps/api` | 通过 |
| `npx tsx --test src/modules/agent/subtask/subtask-application.test.ts src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts` | `apps/api` | 通过，15 tests |
| `npx tsx --test src/modules/agent/agent.integration.test.ts` | `apps/api` | 通过（既有 fault-injection 预期 error 日志不影响结果） |
| `git diff --check`、`git diff --cached --check` | 仓库根 | 通过 |

### P4 已知缺口与进入审查提醒

- P4 未触及 Shared/Worker 外观，因此未额外运行 Worker 回归；API integration 已覆盖四个 internal Subtask route 的既有跨层行为。
- 截至 P4 完成时，orphan policy/循环/startup trigger 仍有意保留在 Service/module；P5 已迁移该 use-case，审查不得将此历史说明误读为当前双业务权威。
- 双独立 SQLite connection 的确定性交错 start-race harness 仍不存在；本批未改变该已知限制。

## P5 实施记录

### 责任迁移

- `SubtaskApplication.cleanupOrphansOnStartup()` 接管 injected clock 下的 1h suspect / 24h delete policy、candidate 遍历、fork-lineage eligibility、per-candidate error isolation、warning 与 `scanned/retained/deleted/skippedAfterRecheck/failed` summary。
- `SqliteSubtaskMaintenancePersistence` 继续作为唯一 orphan persistence：candidate query 与包含 age、fork lineage、empty-session final fence 的条件 delete 语义未扩大。
- `AgentService.cleanupSubtaskOrphansOnStartup()` 是仅转发 application 的兼容 facade；旧 `scanAndCleanupSubtaskOrphansBestEffort()` 与 Service 中的 orphan persistence 字段/策略已删除。
- `agent.module.ts` 在 routes 注册后、archive reconcile 前经 facade 触发，并保留整个 use-case 的顶层 try/catch；archive、Lifecycle 与 Worker 的各自业务及相对顺序未改，也未引入通用 startup coordinator。

### P5 测试与结果

| 命令 | cwd | 结果 |
|---|---|---|
| `npx tsc --noEmit --pretty false -p tsconfig.json` | `apps/api` | 通过 |
| `npx tsx --test src/modules/agent/subtask/subtask-application.test.ts src/modules/agent/subtask/subtask-lineage.persistence.test.ts src/modules/agent/subtask/subtask-wiring.test.ts` | `apps/api` | 通过，18 tests |
| `npx tsx --test src/modules/agent/agent.integration.test.ts` | `apps/api` | 通过（既有 fault-injection 预期 error 日志不影响结果） |
| `git diff --check`、`git diff --cached --check` | 仓库根 | 通过 |

### P5 已知缺口与进入审查提醒

- Application fake 明确证明 list 查询异常会向启动调用者上抛；wiring 静态断言确认 module 的顶层 try/catch 保持不变。未新增仅用于注入 startup list failure 的生产 fault hook，避免扩大非产品测试面。
- P5 未触及 Shared/Worker 外观；Worker 回归留给 P6 完整矩阵。双独立 SQLite connection 的确定性交错 start-race harness 仍不存在。

## P6 实施记录

### 结构审计

- `AgentService` 的 prefork/start/result/status/orphan startup 对外方法均为 `SubtaskApplication` 的薄 facade；module 只在顶层 `try/catch` 触发 orphan startup，且顺序仍为 routes → orphan → archive reconcile → Lifecycle setup → worker start。
- `SubtaskApplication` 未依赖 `AppContext`、Fastify、`RuntimeControlPort`、runtime enqueue、完整 Lifecycle application、`AgentService` 或 `AgentRuntime`；Lifecycle 继续只依赖 `ActiveSubtaskChildQuery`。
- `agent.store.ts` 没有被 application 直接引用；Store 的底层 SQL 仅经 named SQLite lineage/run-query/maintenance adapter 使用。`requireForkLineage` 仅保留在 maintenance adapter 私有 final-fence 实现。
- `AgentRuntime`、worker-disabled wiring 与 `LocalAgentRuntimeExecutionPort` 均未扩张为 Subtask/nested execution capability。unique classifier 位于 `SqliteSubtaskLineagePersistence` 邻近 persistence adapter。
- `AgentService` 仍在 composition 中以 private narrow callbacks 提供 parent-anchor、session materializer 与 internal fork-boundary resolution；这不会把 `AppContext`/Store 暴露给 application，也没有新增第二套 facade 规则。因这些 callbacks 复用 public primary fork 的 clone primitive，终审确认其为当前可接受的 composition bridge 取舍，无需为本阶段形式化拆出独立 adapter。

### 完整回归

| 命令 | cwd | 结果 |
|---|---|---|
| `npx tsx --test tests/*.test.ts && npm run typecheck` | `packages/shared` | 通过，29 tests |
| `npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print \| sort) && npm run typecheck` | `apps/api` | 通过 |
| `npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | 仓库根 | 通过，8 tests |
| `npx tsx --test $(find src -name '*.test.ts' -print \| sort) && npm run typecheck` | `apps/agent-worker` | 通过 |
| `npm run test && npm run typecheck` | `plugins/feishu` | 通过，11 tests |
| `npm run test && npm run typecheck` | `apps/web` | 通过，24 tests |
| `npm run build` | 仓库根 | 通过；仅 Web bundler 的 Browserslist 数据陈旧与大 chunk 建议警告 |
| `npm run typecheck` | 仓库根 | 通过 |
| `git diff --check && git diff --cached --check` | 仓库根 | 通过 |

### 新审查员全面独立终审结论

- 未参与实现的新审查员已对方案文档、combined staged/worktree diff、生产代码、测试与文档一致性完成全面独立终审，结论为通过；未发现必须补代码的高、中优先级问题，也未发现明显降低可维护性的问题。
- 双独立 SQLite connection 的确定性交错 start-race harness 仍不存在；真实 SQLite 已证明 partial unique 与 classifier，application/integration 已证明 compensation、winner re-query 与 conflict/reuse，但这些证据不能替代确定性交错 harness。终审确认该缺口为非阻断后续增强项，应继续诚实保留。
- `AgentService` 的 private narrow callbacks 经终审评估为可接受的 composition bridge：application 未获得 `AppContext`、完整 Store 或完整 service，继续强拆可能增加文件与重复逻辑，当前无需补代码。
- P0 冻结的旧 inner/outer catch 双次 cleanup 形态已在 P3 收敛为单一 local compensation 入口；existing session 排除、loser 补偿后 winner re-query、cleanup failure 不覆盖 winner/原错误等语义保持，终审认定该实现比旧形态更合理。
- P6 未发现需要修复的、由 0007-D 引入的构建、类型或完整回归问题；本次仅更新阶段文档状态，未修改生产或测试代码，未执行任何 Git 写操作。
- 基于上述终审结论，0007-D 阶段完成。
