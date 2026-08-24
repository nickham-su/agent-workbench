# 测试、审查与验收标准

## 验收原则

本阶段不是只验证四个 endpoint 返回成功，而要同时证明：

- 产品语义未漂移；
- durable lineage 与竞态由单一持久化权威保证；
- child activation transaction 未弱化；
- Worker nested execution 未改变；
- local compensation 与 orphan policy 已结构分离；
- facade/routes/module 已收窄；
- 依赖方向没有形成 Lifecycle ↔ Subtask 循环。

验收采用双轨：

```text
行为/竞态/持久化测试
  +
结构/依赖/权威边界审计
```

测试全绿不能替代结构审计；文件拆分也不能替代真实 SQLite 和 API↔Worker 证据。

## 测试层次

### Shared contract

继续覆盖：

- endpoint method/path；
- request/response schema；
- `new/fork/existing` union；
- prefork meta；
- start response `reused`；
- stable Subtask error codes。

本阶段不应修改期望；若实现要求改 Shared，应视为越界并停止评审。

### Subtask application tests

P2 的 composition-only 骨架已在 P3 由真实 start 用例测试替代；P4 在同一 fake-port 层补充 result/status。application fake 测试只证明 use-case 编排、调用顺序与投影分支，不替代 SQLite ownership/final-fence 证据或 API integration 跨层证据。

使用显式 fake ports 验证：

- anchor → validation → reuse/depth/session/profile/activation 的顺序；
- prefork threshold/meta；
- mode 真值表与 seed plan；
- existing child fast return；
- unique conflict 后 winner re-query；
- P3 start failure compensation 的调用条件、winner/error优先级与一次/重复cleanup收敛结果；
- P4 result/status ownership、durable status、assistant-first/system-fallback/empty projection。

fake 不得自动制造隐藏 session/run 状态；每个 fixture 必须显式声明重要字段。

### SQLite persistence tests

P1 已新增 `apps/api/src/modules/agent/subtask/subtask-lineage.persistence.test.ts`，使用既有 `createAgentTestFixture()` 的真实 `openDb()`/schema，而非 fake store。当前独立覆盖：

- `(parentRunId,parentToolItemId)` 的 child lookup；
- cancel child query 对真实 parent `subtask` tool 的 join（同一 parent run 的非 Subtask tool 不返回 child）；
- partial unique index 的真实冲突，以及目标 SQLite constraint classifier 不误判无关 unique；
- P4 local empty-shell 与 orphan capability 各自的 final delete fence；orphan age/fork-lineage 条件不可由调用者关闭；
- result/status 的 workspace/session ownership 及按请求 run 的 result projection。

`agent.integration.test.ts` 保留 anchor、mode、activation transaction、conflict-reuse、compensation 和 internal route 的跨层回归；它不是独立 SQLite persistence 层的替代。当前仍没有两个独立 SQLite connection 的可控交错 harness：partial unique 与 conflict classifier 已由真实 SQLite 证明，但确定性双 start race 尚未证明。


### P3 已落实的补充证据

- `subtask-application.test.ts` 使用显式 fake ports 覆盖 prefork threshold/meta、fork summary→guard→prompt seed plan、existing child fast return、target unique loser compensation 后 winner re-query，以及无 winner 时保留原错误、existing session 不补偿。
- `subtask-activation.persistence.test.ts` 使用真实 SQLite 验证 Lifecycle-owned activator 的 ordered seed/run/state 单事务、prompt `runId` attachment、lineage/depth、final idle fence和注入 run insert failure 的全量回滚。
- P3 保留 API integration 与 Worker API/prefork/cancel/tool-output 回归，证明 Shared payload 和 Worker nested execution 时序未改变。
- 当前仍没有双独立 SQLite connection 的确定性交错 harness；partial unique/classifier 和 winner re-query 证据不得表述为此类并发证明。

### P4 已落实的补充证据

- `subtask-application.test.ts` 通过显式 `SubtaskRunQuery` fake 覆盖 ownership、durable failed/cancelled status、assistant-first、system-fallback 和 empty result projection。
- `subtask-lineage.persistence.test.ts` 通过真实 SQLite `SqliteSubtaskMaintenancePersistence` 覆盖 local 与 orphan 分离的公开 capability、候选 age、固化 fork lineage 与 final empty-session fence。
- `subtask-wiring.test.ts` 已在 P5 改为断言 application 注入 orphan persistence，而 Service 不再持有该 persistence。

### P5 已落实的补充证据

- `subtask-application.test.ts` 使用显式 orphan persistence fake 覆盖 injected clock、1h suspect / 24h delete policy、fork-lineage retain、summary、per-candidate delete failure isolation 与 list failure 上抛至顶层调用者。
- `subtask-lineage.persistence.test.ts` 使用真实 SQLite 覆盖 primary 不入 orphan candidate、age/fork/empty final fence，以及重复条件 delete 的 skipped 语义。
- `subtask-wiring.test.ts` 静态核验 module 只触发 `cleanupSubtaskOrphansOnStartup()` facade，不含 Store import、candidate/delete 调用或 1h/24h 常量，并保持 orphan 触发早于 archive reconcile。

### P6 实现者结构审计与完整回归

- `AgentService` 的五个对外 Subtask 方法（prefork、start、result、status、orphan startup）均仅转发至 `SubtaskApplication`；module/routes 仍是薄触发层。
- `SubtaskApplication` 仅依赖显式窄 ports；生产 Subtask 文件不依赖 `AppContext`、Fastify、`RuntimeControlPort`、runtime enqueue、完整 `RunLifecycleApplication`、`AgentService` 或 `AgentRuntime`。Lifecycle 继续只持有 `ActiveSubtaskChildQuery`。
- `agent.store.ts` 未成为 application 的直接 import 面：仅命名 SQLite adapter 及测试使用底层 Store helpers。`requireForkLineage` 仍仅存在于 maintenance adapter 的私有 final-fence 实现。
- 已实际运行 P6 方案规定的 Shared、API、Worker、Feishu Plugin、Web 和根级 build/typecheck 矩阵，均通过；根级 Web build 仅输出 Browserslist 数据陈旧与大 chunk 建议警告，未导致失败。

### Wiring/structure tests

P1 已新增 `apps/api/src/modules/agent/subtask/subtask-wiring.test.ts`，冻结当前过渡期边界：

- Lifecycle composition 仅接收并调用 `ActiveSubtaskChildQuery`。
- `LocalAgentRuntimeExecutionPort` 的既有最小成员集合没有 Subtask/nested execution 能力。

P2 当时将其扩展为：

- 同一命名 SQLite lineage adapter 同时实现 application 所需 `findChildByParentTool` 与 Lifecycle 所需 `ActiveSubtaskChildQuery`，Lifecycle 仅看到后者；
- application 只接收显式窄 ports，`childRunActivator` 在 P3 前固定为 `null`，不注入完整 `RunLifecycleApplication`；
- `AgentService` 是兼容产品入口；P3-P5 已依次接通 application 的 prefork/start、result/status 与 orphan 公开用例；
- module、route、worker-disabled/local fallback production wiring 未改动。

验证：

- `AgentService` facade 委派；
- Route 只调 facade/use-case；
- module 只触发 orphan startup；
- Lifecycle 只接收 `ActiveSubtaskChildQuery`；
- Subtask 只接收 nested activator；
- production wiring 不注入完整 `AppContext` 到 application；
- test/timing hooks 不进入生产 wiring；
- `AgentRuntime` 构造参数不新增 Subtask API/port；
- worker-disabled module wiring 不注入 `SubtaskApplication` 或 nested activator；
- local runtime execution port不新增Subtask能力；
- `SubtaskApplication` 不依赖 `RuntimeControlPort`、runtime enqueue或完整 runtime。

### API integration

保留真实 `createApp()`、HTTP/internal token/Shared schema/DB 主链，尤其：

- prefork/start/result/status；
- mode、depth、anchor、workspace、enablement；
- idempotency/race；
- cancel cascade；
- orphan startup；
- result partial text。

不要求把所有旧测试迁出 `agent.integration.test.ts`；迁出后仍必须保留关键跨层证据。

### Worker tests

必须回归：

- prefork plan/summary/meta；
- summary false/empty/error/abort；
- `reused=false` 执行 nested run；
- `reused=true` polling，不重复执行；
- terminal reuse 直接 result；
- parent abort 不额外 complete child；
- child status/result 错误传播；
- tool output `subtaskSessionId` 与 existing 提示；
- workspace repository inputs 复制。

### API↔Worker 主链

如现有测试可运行，至少保留一条真实 API-managed Worker Subtask 主链或等价集成证据。若环境不允许，必须记录原因、替代证据和剩余风险，不能用纯 mock 宣称完全覆盖。

## 行为矩阵

## Parent anchor

| 场景 | 期望 |
|---|---|
| parent session 不存在 | 保持 404 |
| workspace mismatch | 保持 400 |
| parent run 不存在/不归属 | 保持 404 |
| anchor 不存在或非 tool | 保持 invalid anchor |
| anchor.runId 不同 | `AnchorRunMismatch` |
| toolName 非 subtask | `AnchorInvalid` |
| 合法 anchor | 进入后续流程 |

## Prefork

| 场景 | 期望 |
|---|---|
| threshold 缺省 | 95 |
| threshold <50/>99/非数 | stable invalid error |
| parent tokens null | shouldPrefork=false |
| tokens 达阈值 | true |
| Worker plan false | 不 summary，仍 start |
| summary 成功 | text/meta 透传并由 API revalidate |
| summary 空/普通失败 | 降级普通 fork |
| summary abort | 中止，不 start |
| meta 与当前 plan 不符 | `PreforkMetaMismatch` |

## Session mode 与 seed items

| 场景 | 期望 |
|---|---|
| new | 新 subtask session；origin=parent/tool；prompt |
| fork + summary | 新 session；origin=parent/tool；summary→guard→prompt |
| fork + boundary | clone；origin=parent/boundary；guard→prompt；copied runId=null |
| fork + no boundary | 新 session；origin 双空；guard→prompt |
| existing | 必须已有 subtask session；只追加 prompt |
| new/fork 带 sessionId | stable invalid |
| existing 无 sessionId | stable invalid |
| existing primary session | kind mismatch |

## Reuse 与 unique race

| 场景 | 期望 |
|---|---|
| 预查已有 child | reused=true，不 materialize/activate |
| existing hint 与 winner session 不同 | conflict |
| 历史 agent 缺失 | 仍可 reuse，agentName fallback |
| 两个并发 start | 最终一个 child run |
| loser target unique | 重查 winner，返回 reused |
| loser 新空壳 | 条件补偿，不遗留 |
| race 后无 winner | 抛原始错误，不伪造 reused |
| 非目标 unique error | 不误判 parent-tool race |

## Child activation

| 场景 | 期望 |
|---|---|
| child session idle | seed/run/state 一次提交 |
| session running | conflict；无 seed/run 部分写入 |
| seed append 失败 | 全 transaction 回滚 |
| createRun 失败 | seed 回滚 |
| run-state 失败 | seed/run 回滚 |
| summary/guard | runId=null |
| prompt | runId=childRunId |
| run record | parent+1、真实 parent 双字段 |
| success | API 不 enqueue；Worker执行 nested run |

## Result / status

| 场景 | 期望 |
|---|---|
| session/run missing | 保持 404 |
| workspace/session mismatch | 保持 400 |
| assistant text 存在 | 返回最后非空 assistant |
| 无 assistant，有 system | 返回最后非空 system |
| 均无 | 空字符串 |
| failed/cancelled 有 partial | 仍返回 partial |
| status | durable run status |

## Compensation

| 场景 | 期望 |
|---|---|
| new materialize 后失败，仍空 | 删除本次 session |
| fork summary session 后失败且已有 item | final fence拒绝误删 |
| cloned session 有 head/items | 不删除 |
| existing 失败 | 不调用 compensation |
| unique loser | 只删 loser session，不删 winner |
| compensation 失败 | 不覆盖原错误/winner；受控日志 |
| 当前重复 cleanup 形态 | P0记录；P3可收敛为一次调用，但最终DB/错误语义等价 |

## Orphan

| 场景 | 期望 |
|---|---|
| <1h | 不入 candidate |
| >1h <24h | retain + warning |
| >24h 无 fork lineage | retain |
| >24h eligible empty | 删除 |
| final check 前新增 head | skipped |
| final check 前新增 run | skipped |
| final check 前新增 item | skipped |
| primary session | 不删 |
| candidate 删除异常 | 后续 candidate 继续 |
| list query 顶层异常 | module warning，后续 startup 继续 |

## Cancel / lineage

- parent cancel 只通过 durable child query 找 active/current child；
- tool output 缺少或伪造 `subtaskSessionId` 不影响真实 cascade；
- 历史 child 不因当前 active child 查询被误取消；
- cancel wins、late state/complete fence 保持 `0007-C` 行为；
- Subtask start/reuse 不直接调用 runtime cancel。

## Architecture checks

审查者必须用搜索/类型/wiring 证据确认：

- `agent.routes.ts` 不 import Subtask Store helpers；
- `agent.module.ts` 不 import orphan candidate/delete helpers；
- `AgentService` 不再包含 anchor/mode/race/orphan领域实现；
- Subtask application 不接收 `AppContext` 或 Fastify logger/request；
- Lifecycle 不 import `SubtaskApplication`；
- Subtask 不 import完整 `RunLifecycleApplication`；
- nested activator 不调用 runtime enqueue；
- `findSubtaskRunByParentTool`/child query 不在多个 adapter 重复 SQL；
- `subtaskSessionId` 不出现在 lineage SQL where/join；
- local/orphan deletion ports 名称和条件分开；
- orphan application/port 无 `requireForkLineage` 或等价可选安全开关；
- 共享 empty-session SQL 仅存在于 SQLite adapter 私有实现，不从 adapter导出；
- seed/run/state transaction 未拆成 service 先读后写；
- Shared contract 文件无无关变更；
- Worker builtin 主控制流无大拆分；
- `AgentRuntime`、worker-disabled wiring、local runtime execution port未新增 Subtask依赖；
- Subtask目录无 `RuntimeControlPort`/`enqueueRun`/local runtime接线。

## 独立审查清单

### 每批审查

- diff 是否只包含当前批次；
- 当前行为与文档基线一致；
- 关键规则是否只有一个生产权威；
- transaction/fence 是否仍在 SQLite；
- fake 是否绕过真实约束；
- facade 是否新增 helper；
- 日志是否泄露 prompt/tool 内容；
- 文档是否把候选设计误写成完成事实。

### 阶段终审

由未参与实现的新审查员覆盖：

- `0006` Subtask 目标与退出条件；
- `0007-C` Lifecycle 衔接；
- `0008` 仍有效语义；
- P3是否完整拥有start failure local compensation，P4是否仅做query与adapter边界收口；
- 当前 staged/worktree combined diff；
- production/test/docs 一致性；
- 高/中/低优先级问题；
- 方案差异是否应补代码或记录为更合理实现；
- 可维护性与后续 Compaction/Archive 准入。

上述阶段终审已由未参与实现的新审查员完成，结论为通过，无必须补代码的问题。终审继续保留双独立 SQLite connection 确定性交错 start-race harness 的非阻断缺口，并认可 private narrow callbacks 与单一 compensation 入口为可接受的结构取舍；验收标准本身不因此降低。

## 验收命令

实施时以真实 package scripts 为准，最低矩阵：

```bash
cd packages/shared
npx tsx --test tests/*.test.ts
npm run typecheck

cd apps/api
npx tsx --test src/modules/agent/subtask/*.test.ts
npx tsx --test src/modules/agent/agent.integration.test.ts
npm run typecheck

cd apps/agent-worker
npx tsx --test src/runtime/apiClient.test.ts \
  src/runtime/provider-subtask-cancel.test.ts \
  src/runtime/runner.tool-output.test.ts \
  src/runtime/tools/providers/builtin.prefork.test.ts \
  src/runtime/tools/providers/builtin.read.test.ts
npm run typecheck

cd <repository-root>
npm run build
npm run typecheck
git diff --check
git diff --cached --check
```

P6 还必须执行 `05` 中的全仓库矩阵。命令只有实际运行并看到结果后才能写“通过”。

P6 已实际执行的完整矩阵：

| 命令 | cwd | 结果 |
|---|---|---|
| `npx tsx --test tests/*.test.ts && npm run typecheck` | `packages/shared` | 通过，29 tests |
| `npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print \| sort) && npm run typecheck` | `apps/api` | 通过 |
| `npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | 仓库根 | 通过，8 tests |
| `npx tsx --test $(find src -name '*.test.ts' -print \| sort) && npm run typecheck` | `apps/agent-worker` | 通过 |
| `npm run test && npm run typecheck` | `plugins/feishu` | 通过，11 tests |
| `npm run test && npm run typecheck` | `apps/web` | 通过，24 tests |
| `npm run build` | 仓库根 | 通过（仅 Browserslist/大 chunk 建议警告） |
| `npm run typecheck` | 仓库根 | 通过 |
| `git diff --check && git diff --cached --check` | 仓库根 | 通过 |

## 完成验收

### 行为

- 四个 Shared endpoint 行为无漂移；
- mode/prefork/depth/result/status保持；
- Worker nested execution/reuse/abort保持；
- cancel与orphan保持。

### 一致性

- durable lineage 单一；
- unique race 最终单 child；
- activation单事务；
- local/orphan final fence真实有效；
- local compensation在P3与start failure同一生产权威，P4未形成第二迁移路径。

### 结构

- Subtask application可发现；
- facade/routes/module薄；
- ports窄；
- Lifecycle/Subtask无循环；
- Store能力按业务约束命名；
- orphan安全条件固化在adapter且公开port不可关闭；
- local fallback/`AgentRuntime`/worker-disabled wiring没有因本阶段获得Subtask执行能力。

### 文档

- `02/07` 与最终代码一致；
- `09` 记录实际命令、审查、偏差；
- `README` 状态更新；
- 未完成项不写成已完成。
