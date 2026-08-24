# 测试、审查、回滚与验收

## 总体原则

- 先冻结行为证据，再移动结构；
- application/fake runtime 测试不能替代真实 SQLite transaction/CAS；
- Route/Shared/API-managed Worker/local fallback/Worker runtime 证据必须保留；
- cancel/recovery race 使用 barrier、hook 或受控顺序，不以不确定 sleep 作为唯一证据；
- 测试不得打印 token、input text、prompt/messages、完整 tool args/result 或敏感绝对路径；
- 测试迁移前后必须核对测试名、断言和副作用，不以删测试换取通过；
- Subtask/Archive 测试不因共享 `agent.integration.test.ts` 自动进入本阶段；
- Public enqueue failure 在 P0 未冻结前，不得以“合理预期”编写目标断言覆盖当前事实。
- startup fail cache invalidation 在 P0 未完成证据门禁前，不得写成必需行为或既有行为；测试必须先回答 cache 生命周期和可观察性。
- 验收采用“行为与竞态测试 + 结构与依赖审计”双轨；任一轨未通过都不能完成批次或阶段。

## 测试分层

## Shared contract tests

权威文件：

```text
packages/shared/tests/internal-contracts.test.ts
```

最低证据：

- Agent Worker enqueue/cancel endpoint method/path/schema；
- API update-run-state/complete-run endpoint method/path/schema；
- public/internal send request/response 当前 schema；
- response aggregate exports 不漂移；
- strict/warn validation 的既有边界。

本阶段默认不改 Shared contract。若 tests 预期必须改变，先触发停止并确认是否超出结构治理。

## Persistence behavior tests

必须使用真实 SQLite，覆盖：

### Activation

- user item + first-message title + dedup + run record + run-state 在同一 transaction；
- transaction 任一步失败全部回滚；
- run-state 非 idle conflict；
- dedup 命中不创建第二个 item/run；
- head/dedup 并发冲突映射保持；
- run record metadata、primary depth 与 parent 字段保持；
- appliedItemId/head/title/timestamps 保持。

### Enqueue failure

- 只有 matching in-flight run 可转 failed；
- terminal/cancelled run 不被覆盖；
- activeRunId 不匹配时不回收当前 run-state；
- matching active run 按 P0 决策回收 idle；
- cache invalidation 只针对实际终止 run；
- user item/dedup 的保留/处理符合 P0 事实。

### State/complete

- active-run switch 拒绝 late state；
- ownership mismatch/terminal run no-op；
- run-state notice/token 缺省与显式值；
- complete terminal single-settlement；
- cancelled complete 只收敛该 run 非终态 items；
- activeRunId matching 才 idle；
-旧 run complete 不回收新 active run state。

### Cancel

- root + current active child 在一个 transaction 收敛；
- hidden chain items/related runs；
- terminal run 不改写；
- tool cancelled output 与非 tool output 差异；
- history child 不被级联；
- transaction 失败无部分 DB cancel；
- 返回 runtime targets 与实际收敛 target 一致。

### Recovery

- candidate 条件；
- final DB fence；
- `failRunRecordIfInFlight()`；
- `setRunStateIdleIfActiveRunMatches()`；
- `setRunStateIdleIfNoActiveRun()`；
- active run 已切换时 fail recovery 不回收；
- dirty state 条件回收；
- notice append 条件。

不得使用 fake Store 替代上述证据。

### P1 已建立的最小独立入口

| 文件 | 证据层级 | 当前覆盖 | 边界 |
|---|---|---|---|
| `run-lifecycle-baseline.api.test.ts` | 真实 SQLite + Route/Service + fake runtime | Public/internal send enqueue 异常后的 durable user item/dedup、条件 failed/idle 收敛、dedup retry 不重 enqueue | 不证明生产 `createApp()` 的精确 error HTTP 外观 |
| `run-lifecycle.persistence.test.ts` | 真实 SQLite + Service/module helper | enqueue-failure 不 idle switched active run；cancel wins；recovery final fence | fake runtime 仅观察 recovery 是否 enqueue |
| `agent.integration.test.ts` | 全应用集成 | startup fail/recover、enqueue-after-cancel、runtime cancel warning、state/complete/cascade 等 | 保持权威跨域护栏，不为目录归属迁移 |
| `agent.worker.integration.test.ts` / `agent.worker-client.test.ts` | API-managed Worker / transport | Worker send 主链、endpoint 与 response-validation | 保持真实 transport/worker 路径 |

P1 不新增 fake Store、不扩张 `AgentTestFaults`，也不迁移或删除既有集成断言。

### P2 已建立的骨架/wiring 入口

| 文件 | 当前覆盖 | 明确不覆盖 |
|---|---|---|
| `lifecycle/run-lifecycle-application.test.ts` | P3 start/settlement；P4 worker state 时间戳、有效 complete 的 cache/event、DB-first cascade 与 runtime all-settled warning；P5 final eligibility recheck、enqueue failure isolation、fail-mode 独立步骤/CAS notice/dirty-state | 不替代真实 SQLite/CAS 证据 |
| `lifecycle/run-lifecycle-wiring.test.ts` | 真实 `AgentService` 构造 Lifecycle；直接调用并断言 reader、child query、clock、id 及 persistence adapter 形状 | 不调用 cache/event/logger adapter |

P4 同时在 `run-lifecycle.persistence.test.ts` 增加真实 SQLite 的 old-run complete fence：旧 run 只终态化自身，不会 idle 已切换的新 active run。

P5 复用真实 SQLite recovery final-fence 测试，并将其入口改为 `AgentService.recoverRunsOnStartup()` facade：final check 前 cancel 不 enqueue。`agent.integration.test.ts` 继续覆盖 final-fence cancel wins、enqueue 后 cancel 的 DB 收敛，以及单 candidate enqueue failure 不阻断后续 candidate。

startup fail 的 prompt-cache 行为仍按既定 P0 决策边界：本批未新增或删除显式 invalidation，验收不得将其概括为所有 terminal 路径的统一 cache 规则。

## Domain use-case tests

围绕唯一 `RunLifecycleApplication` 的各 use-cases 验证：

### Send/activation

- Session/Interaction 到 Lifecycle 的 command/result 映射；
- deduplicated 不调用 runtime；
- activated 构造正确 runtime payload；
- workspace run context missing 的当前错误映射；
- enqueue success 返回当前 response；
- enqueue failure 调用 conditional settlement 后透传当前错误；
- facade 参数、返回和异步错误透传。

### State/complete

- no-op guard 不触发 cache/event；
- terminal settlement 触发一次 cache invalidation；
- event 只在实际 complete 后发布；
- event payload/status/time 保持；
- cache/event failure 政策符合 P0 决策。

### Cancel

- DB settlement 完成后才调用 runtime；
- 所有 target 都尝试；
- runtime failure 只 warning；
- 一个 target failure 不阻止其他 target；
- DB failure 时不调用 runtime；
- response 不受 runtime failure 影响；
- warning 只包含有限 identity。

### Recovery

- initial check 与 final check 均执行；
- before-final-check cancel 不 enqueue；
- final check 后 enqueue 发出时不承诺撤回；
- runtime context/trigger text 恢复；
-单 candidate enqueue failure 继续；
- fail mode 各步骤 failure isolation；
- dirty session 单项失败继续；
- startup hook 不泄漏领域规则到 module。

可 stub 窄 runtime/cache/event/reader 验证应用编排，但 persistence 规则必须另有 SQLite 测试。

## Route integration tests

使用真实 Fastify app，覆盖：

- Public message method/path/schema/`201`/`400/404/409`；
- Public/internal send enqueue failure 的 route-level failure、durable user item/dedup、conditional failed/idle settlement 与 dedup retry；如需断言生产 `createApp()` 精确 error HTTP status/body，必须另用真实应用装配 characterization；
- internal trigger token/schema/status；
- internal update-run-state/complete token/schema/`{ok:true}`；
- Public cancel schema/status/response；
- cancel runtime failure 不改变 HTTP success；
- Route 只连接 facade/application，不读取 Store/context 或拼 runtime sequence；
- SSE run-complete event 主链保持。

Route 测试不重复所有 DB组合，但至少保留每类入口的代表性成功、错误和 auth 证据。

## Startup integration tests

必须覆盖：

- fail mode listen 前收敛；
- recover mode `onListen` enqueue；
- cancel-before-final-check；
- cancel-after-enqueue-dispatched；
- candidate enqueue failure isolation；
- workspace/run/session/state mismatch skip；
- trigger item text 缺失/非 user_text；
- dirty `running + activeRunId=null`；
- notice append conflict/失败 best-effort；
- startup fail cache 按 P0 决策验证：若显式 invalidation，覆盖实际状态变化/no-op/失败政策；若无需显式调用，覆盖 cache 生命周期前提并加入结构审计；
- module 仍执行 orphan/archive hooks，但 lifecycle 测试不声称治理其内部规则；
- API-managed Worker process/startup 时序无回归。

## API-managed Worker integration

权威文件候选：

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

最低证据：

- send message 后 Worker 收到 enqueue；
- Worker 读取 prompt/messages/profile；
- context create/update；
- update run-state；
- complete run；
- cancel transport 与最终 DB state；
- terminal/late Worker 写回不污染新 run；
- response validation 不漂移。

不得被全 fake client 替代。

## Local fallback runtime tests

至少覆盖：

- 收窄依赖后能够 enqueue、执行、writeback、complete；
- runId 去重；
- 同 session 串行；
- queued run cancel 被移除；
- running run 当前不强停的事实有 characterization；
- cancelled DB 后 late local writeback 被 0007-B/Lifecycle fence 收敛；
- runtime error 仍追加当前 system notice并 complete failed。

本阶段不要求新增 running abort。

## Worker runtime/client tests

继续执行：

```text
apps/api/src/modules/agent/agent.worker-client.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/runner.cancel.test.ts
apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts
```

验证：

- Worker enqueue/cancel endpoint 与 validation；
- API client state/complete calls；
- AbortController/nested cancel；
- cancelled complete retry/terminal 保持；
- adapter 抛错/吞错策略按 P0 决策；
- 不因 API 结构治理重写 Worker Runner 主控制流。

## 关键竞态矩阵

| 竞态 | 必须保持的结果 |
|---|---|
| activation transaction 中途失败 | user item/dedup/run/run-state 不部分落库 |
| enqueue failure vs cancel | cancelled 不被 failed 覆盖；cancel wins |
| enqueue failure vs complete | terminal complete 不被 failed 覆盖 |
| old state writeback vs new active run | old state no-op，不覆盖新 active run |
| complete old run vs new active run | old run可按既有规则终态，但不 idle 新 run-state |
| cancel vs Worker state | DB cancel/terminal guard 权威 |
| recovery before final check vs cancel | 不 enqueue |
| recovery after enqueue dispatched vs cancel | 不承诺强停，DB/writeback fence 最终收敛 |
| runtime cancel single target failure | 其他 target 继续，HTTP/DB success 保持 |
| repeated complete | terminal no-op，不重复 event/cache副作用 |

## P0 特别 characterization

必须新增或明确已有证据：

- Public `/messages` runtime enqueue 抛错；
- 相同 `clientRequestId` 的 retry；
- DB user item/dedup/run/run-state 快照；
- internal trigger/compact 对比；
- `AgentWorkerClient.cancelSession()` transport failure 的 caller 可观察结果；
- local fallback running cancel；
- startup fail cache 实例生命周期、同进程可观察路径与是否需要显式 invalidation。

这些测试在 P0 只记录当前事实。若当前事实明显不满足 0006 不变量，必须暂停并将行为修复作为显式设计决策，不得静默改断言。

## 回归命令候选

实际命令以 package scripts 与 cwd 为准，P0/P6 记录精确结果。

### Shared

```bash
cd packages/shared
npx tsx --test tests/internal-contracts.test.ts
npm run typecheck
```

### API

```bash
cd apps/api
npx tsx --test src/modules/agent/run-lifecycle-baseline.api.test.ts src/modules/agent/run-lifecycle.persistence.test.ts
npx tsx --test src/modules/agent/agent.integration.test.ts
npx tsx --test src/modules/agent/agent.worker.integration.test.ts
npx tsx --test src/modules/agent/agent.worker-client.test.ts
npx tsx --test src/modules/agent/agent.service.facade.test.ts
npx tsx --test src/modules/agent/lifecycle/run-lifecycle-application.test.ts src/modules/agent/lifecycle/run-lifecycle-wiring.test.ts
npx tsc --noEmit --pretty false
```

文件不存在时不得照抄执行；它们是候选结构，需随实施更新。

后续 P2-P5 可按最终职责目录新增 application/recovery 测试，但不得删除以上 P1 入口或用 fake Store 取代真实 SQLite 证据。

### Worker

```bash
cd apps/agent-worker
npx tsx --test src/runtime/apiClient.test.ts
npx tsx --test src/runtime/runner.cancel.test.ts
npx tsx --test src/runtime/provider-subtask-cancel.test.ts
npm run typecheck
```

### Repository

```bash
npm run build
npm run typecheck
git diff --check
git diff --cached --check
```

不得执行 `git add/commit/push/reset/checkout`，除非主会话获得用户明确授权并按批次精确操作。

## 结构与依赖审计

结构验收不能只通过测试间接推断，必须执行并记录以下审计：

| 审计面 | 通过条件 | 建议证据 |
|---|---|---|
| Send transaction owner | `AtomicRunActivationPersistence` 是唯一 transaction callback；只有 `startUserRun()` 直接调用 | `rg` 调用点、关键实现人工复核、SQLite transaction test 对照 |
| Runtime context/enqueue owner | Route/facade/Interaction 不获取 run context 或直接 enqueue；Lifecycle 唯一编排 | `rg getAgentWorkspaceRunContext/service.getContext/runtime.enqueueRun` + call-site 分类 |
| Enqueue failure owner | 正常 run-start failure settlement 只有 Lifecycle 权威；recover 特有 warning/continue 明确隔离 | helper/call-site 清单、错误流审计 |
| HTTP error owner | application/use-case 产生业务错误，facade 透传，Route/全局 handler 只序列化 | Route diff、代表性 Route tests、错误映射表复核 |
| Cancel DB/runtime boundary | DB settlement 与 runtime best-effort 不在 Route 分拆 | Route/Lifecycle imports 与调用顺序审计 |
| Recovery/module boundary | Module 无 candidate/CAS/settlement Store imports；startup hook 仅触发 use-case | `agent.module.ts` import/call审计 |
| Runtime decoupling | runtime port 不从 Service 导入类型；local runtime 不持有完整 Service | import graph/`rg agent.service` |
| Child query direction | Lifecycle 只依赖窄 active child query capability | constructor/import审计 |
| Cache/event authority | complete/cancel/enqueue failure 及 P0 定稿的 startup fail 规则无双实现、无遗漏调用点 | invalidator/publisher call-site 清单 |
| Legacy cleanup | 无旧 Route helper、module recovery helper、legacy callback、无调用 adapter | P6 残留检索及逐项分类 |

审计输出必须记录在 `09-implementation-record.md`，至少包含：

- 检索命令或分析方法；
- 命中列表；
- 每个命中的合法/待清理分类；
- 修复后的复查结果；
- 审查者结论。

## 独立审查重点

每批至少检查：

### P0/P1

- 当前事实与目标设计是否分开；
- Public enqueue failure 是否真实证明；
- 测试是否隐藏 transaction/runtime；
- 是否误删 Subtask/Archive 证据；
- 工作区保护。

### P2

- dependency direction；
- runtime port 是否不从 Service 导入类型；
- application 构造是否无业务副作用，且未形成长期 callback 壳层；
- application 是否窄依赖；
- persistence 是否保留原子/条件能力；
- 是否出现双权威。

### P3

- activation transaction；
- dedup/transaction/runtime context/enqueue/HTTP error ownership是否符合权威表；
- enqueue failure conditional settlement；
- Route 是否仍拼装；
- HTTP/Worker/local fallback 回归。

### P4

- `cancel wins`；
- DB-before-runtime；
- state/complete terminal guards；
- child query 精确性；
- cache/event时机；
- Worker adapter warning边界。

### P5

- final DB fence；
- fail/recover 差异；
- failure isolation；
- module 只触发；
- orphan/archive 未混入；
- startup process时序；
- startup fail cache 是否严格落地 P0 决策且文档无相反口径。

### P6

- 旧 helper/Store direct calls 残留；
- facade/application 双实现；
- 结构与依赖审计清单全部关闭；
- 完整回归；
- UI 验收/豁免；
- 0006/0007-C 符合度；
- staged/worktree 精确性。

## UI 手工验收

阶段完成时至少评估：

- 新建 session 发送首条消息，title/run-state 正常；
- 多轮消息与 dedup/retry；
- 流式输出与 terminal；
- 取消当前运行；
- 取消后立即新运行，旧输出不覆盖；
- runtime/Worker 不可用时 UI 状态不永久卡 running；
- 页面刷新与多 session 切换；
- subtask active child cancel；
- local fallback（若可配置）。

纯内部批次可豁免部分 UI，但阶段完成必须有书面理由和自动证据。

## 验收清单

### 结构审计

- Lifecycle application/capabilities 已落地；
- `sendMessage()` 跨域接口、transaction/runtime context/enqueue/failure/HTTP 错误归属符合权威表；
- Route 不拼 send enqueue/cancel runtime；
- Module 不实现 recovery 领域规则；
- runtime port/local fallback 不依赖完整 Service；
- active child query 是窄 dependency；
- P6 结构审计的命中、分类、修复和复查均有记录。

### 行为

- activation 原子性与 dedup 保持；
- enqueue failure 按 P0 决策且 `cancel wins`；
- state/complete terminal guards 保持；
- cancel DB-first/runtime best-effort；
- recovery final fence/failure isolation 保持；
- cache/event 保持；startup fail cache 严格按 P0 决策验收，不预设结论；
- Shared/HTTP/Worker/UI 无无授权变化。

### 证据

- 真实 SQLite transaction/CAS；
- domain use-case/fake runtime；
- Route/auth/schema/status；
- startup race；
- API-managed Worker；
- local fallback；
- Worker runtime cancel；
- build/typecheck/diff check；
- 结构与依赖审计记录；
- 独立审查、修复、复审、最终新视角审查记录完整。
