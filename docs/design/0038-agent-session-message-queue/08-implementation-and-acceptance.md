# 实现与验收记录（S7／S8基线及Esc增量）

> **基线15e2590：工程实现完成，最终全面独立existing复审通过；0038整体实现可交付，H1／H2／M1／M2／L1／L2共6/6关闭、Open 0，无新增问题。** 主助理已明确转述审查结论；独立141定向测试与作者真实managed／browser、最终同源树八组验证分开归档，见第13节及07。第1～12节保留各历史时点的未通过／修复／待审查记录，不代表当前状态；本次不再修改已过审生产／协议／测试语义。

> **当前Esc增量：原会话独立复审通过，H1／M1／L1全部Resolved，3/3关闭、Open 0、无新增问题；作者最终同源树五组4069/4069通过，Chromium19/19。** 第1～13节仅属基线历史，第14～15节保留首审未通过与修复过程；当前最终证据及限制见第16节。不混算旧4056／5827、修后318或reviewer339。

## 1. S7历史状态、范围与证据口径

记录日期：2026-11-10。

- 根据主助理交接，S1～S6已经完成阶段独立代码审查并暂存；生产消息队列与Web交互已接入。本阶段不重新宣称这些审查由S7执行。
- **S7作者自测完成：第1轮八组全量回归5786/5786通过；追加发现的BROWSER-1已按授权最小修复，修复后Web全量1293/1293及两轮全新fixture真实Chromium A-COUNT均通过。待S7独立代码审查、主助理暂存及最终全面对照方案审查。** 本文件不是独立审查报告，不表示最终产品验收通过。
- 只做Web交互收件；飞书／IM队列化仍为非目标。旧send、scheduled、subtask、manual_compaction维持既有契约与运行分类。
- 本阶段生产逻辑仅最小修改Web队列的两个watcher，修复真实浏览器发现的BROWSER-1；其余为严格断言、确定性回归、可选浏览器harness及验收文档。未修改正式package／lock或默认测试运行脚本。经追加授权，仅在`.tmp-tests/browser-e2e`安装固定Playwright与浏览器，未读取敏感配置、执行Git操作或访问真实外部模型。
- “通过”指下列实际命令退出码为0、相应测试无fail/cancelled/skipped。源码测试名索引仅用于核对发现与覆盖，不是执行证据。
- 验收采用分层证据：真实SQLite事务／迁移、Fastify HTTP、真实受管Worker进程＋本地假provider、Worker受控流、组件DOM及追加的真实Chromium。不能把各层通过解释为所有组合均做过端到端联调。

权威设计与原始验收项仍见[需求](01-requirements-and-product.md)、[业务规则](02-business-rules-and-state-machine.md)、[技术与实体](03-architecture-and-data-model.md)、[协议](04-api-and-worker-protocol.md)、[验收矩阵](06-testing-and-acceptance.md)。[07](07-review-record.md)保留设计审查时点历史。

## 2. S7实际变更

| 文件 | 改动与理由 |
| --- | --- |
| [context-writeback-application.test.ts](../../../apps/api/src/modules/agent/writeback/context-writeback-application.test.ts) | 在取消收敛用例的完整run state严格期望中补`runNoticeText: ""`、`modelRequestError: null`、`retryCount: 0`。这些字段在旧v25已经存在；属于既有测试漂移，未改变生产返回或放宽断言。 |
| [agent.worker.integration.test.ts](../../../apps/api/src/modules/agent/agent.worker.integration.test.ts) | 将既有双工具注入用例扩为4个真实Worker参数化场景：串行双read、并行双bash、bash/bash→read→bash/bash混合批次、并行bash后read合法失败。假provider增加工具名／参数配置；按执行ID隔离终态写回闸门，验证所有结果闭合前不注入、不发下一模型请求；闭合后同Run注入文字和真实PNG字节。增加实际请求call/result ID集合、工具顺序、失败结果数量断言。原1例变4例，净增3例。 |
| [runner.interactive-input.test.ts](../../../apps/agent-worker/src/runtime/runner.interactive-input.test.ts) | 新增5例：reasoning-only的continue/finish、官方OpenAI合法replay-only无可见文本达到第6次阈值的continue/finish、真正空流仍失败且不确认输入。使用真实Runner与默认provider adapter解释受控流，不修改生产分支。 |
| [useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts) | 生产范围仅两个watcher改为多primitive sources，避免重复Run快照被误判为scope变化，保留真正Workspace／Session变化的代际隔离。 |
| [AgentMessageQueue.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts) | 增加5个生产同形getter反例：展开节点／取消busy／轮询期限，Stop与resume在途确认，以及Workspace／Session真实切换的晚回包隔离。旧代码3例失败，修复后27/27。 |
| [verify-agent-queue-browser.mts](../../../apps/api/scripts/verify-agent-queue-browser.mts) | 可选真实Chromium＋API＋managed Worker验证，动态加载隔离安装的Playwright，不改默认依赖或测试入口。最终两轮完整A-COUNT通过，详见第9节。 |
| README、05、06、07、本文件 | 区分设计历史、已实施阶段、作者自测与待审查状态；记录覆盖与真实结果。06澄清“合法无可见文本”与无效空流区别，保留原阈值验收，不降低既有provider协议校验。 |

### 新增联合回归的关键断言

受管Worker的4个工具轮次均验证：

1. 首个工具终态写回被闸门阻塞时，另发文字＋图片，得到queued receipt，`pendingCount=1`。
2. 对本轮剩余每个终态写回继续阻塞；所有工具闭合前，queued不变，provider仍只有首个请求。按实际调度规则（bash/subtask并发、read串行），每组bash/bash要求两个不同执行ID的终态回调均进入闸门后才释放前一个，证明真实并行而非串行假覆盖；同一执行的RPC重试不能冒充下一个工具结果。
3. 释放全部结果后，receipt injected且`runId`与原Run相同，确认来源为`worker_model`，整个Session只有一个Run。
4. 第二个真实模型请求包含全部function calls及对应outputs，新user位于全部outputs之后，图片为原PNG的`data:image/png;base64,...`，`max_output_tokens=4096`。
5. 合法工具失败仍有终态output；混合批次不能在前一批结束时提前注入。

Runner新增测试还验证：reasoning-only／合法replay-only调用统一`completeInteractiveAssistant`，选择continue时不能持久finish，选择finish时不走旧收尾路径；真正空流不能借“第6次”伪造合法完成或确认。

## 3. 真实执行记录

### 环境与顺序

所有命令从仓库根执行，API gate例外。统一设置：

```bash
export TMPDIR="$PWD/.tmp-tests"
export TSX_DISABLE_CACHE=1
```

未更改测试超时、删用例或放宽断言。先完整build，再完整typecheck，再Shared clean-build测试；Shared清建期间没有运行消费`shared/dist`的测试。完成新增测试后，又完整build、typecheck并重跑Worker全量；最后加强并行批次闸门断言后，再完整build、typecheck及受管Worker全量。Web默认组件并发2；Worker默认文件并发1；API使用原默认脚本，无手动缩减文件集合或降低并发的重跑。

### 第1轮最终结果（BROWSER-1修复前）

日志路径相对仓库根，均位于被忽略的`.tmp-tests`，仅是本地可复核证据，不纳入版本管理；测试源码与命令是可重现证据。

| 编号 | 实际命令 | 最终结果 | 本地日志 |
| --- | --- | --- | --- |
| B | `npm run build` | 退出0；Shared、CLI、Worker、API、Feishu、Web全部完成 | `.tmp-tests/s7-build-final.log` |
| T | `npm run typecheck` | 退出0；所有workspace通过，包含第1轮新增测试，不含后续BROWSER-1新增5例 | `.tmp-tests/s7-typecheck-final.log` |
| S | `npm test -w packages/shared` | 144/144 | `.tmp-tests/s7-shared.log` |
| W | `npm test -w apps/web` | 1288/1288：runner自测22、非组件493、组件773；31个组件文件全部完成，默认并发2 | `.tmp-tests/s7-web.log` |
| R | `npm test -w apps/agent-worker` | 1354/1354，含新增5例 | `.tmp-tests/s7-worker-final.log` |
| U | `npm run test:unit -w apps/api` | API cwd 1938/1938；脚本后续repo-root cwd插件8/8，合计1946/1946 | `.tmp-tests/s7-api-unit.log` |
| I | `npm run test:integration -w apps/api` | 590/590，默认完整文件集合与并发 | `.tmp-tests/s7-api-integration.log` |
| M | `npm run test:integration:worker -w apps/api` | 31/31，含4种工具轮次；不是前阶段28例结果复用 | `.tmp-tests/s7-managed-worker-final.log` |
| C | `npm test -w packages/cli` | 421/421 | `.tmp-tests/s7-cli.log` |
| F | `npm test -w plugins/feishu` | 12/12；只回归既有插件，不表示IM已队列化 | `.tmp-tests/s7-feishu.log` |
| G | 在`apps/api`执行`node scripts/verify-test-gate.mjs` | 退出0，无输出 | `.tmp-tests/s7-api-gate.log` |

第1轮八组完整测试合计5786例通过；各组fail/cancelled/skipped均为0。此记录在BROWSER-1生产修复之前；修复后按授权重跑Web全量、Web类型检查、Web构建、harness严格检查、Worker定向和两轮真实浏览器，不宣称再次重跑全部八组。修复后的结果见第9节，不将重复测试或两轮E2E累加进5786。

| 定向验证 | 结果 | 日志 |
| --- | --- | --- |
| API cwd：`npx tsx --test src/modules/agent/writeback/context-writeback-application.test.ts` | 2/2，旧严格断言关闭 | `.tmp-tests/s7-writeback.log` |
| API cwd：`npx tsx --test --test-name-pattern='worker 队列: ' src/modules/agent/agent.worker.integration.test.ts` | 4/4 | `.tmp-tests/s7-worker-boundary-final-2.log` |
| repo root：`npx tsx --test apps/agent-worker/src/runtime/runner.interactive-input.test.ts` | 26/26 | `.tmp-tests/s7-interactive-runner-final-2.log` |

### 失败、修正与警告，如实保留

- 受管Worker补测开发时，新增统计SQL先误用了`agent_tool_execution.run_id`，随后误用了`session_id`，4个新场景各报SQLite错误；正确列为`origin_run_id`。仅修测试查询；`s7-worker-boundary.log`及`s7-managed-worker.log`是失败历史，不作为通过证据。修后定向4/4及完整31/31通过。
- 加强并发闸门时发现初版fixture把read误当并发、bash误标串行；混合批次等待导致30秒超时（30 pass／1 cancelled），且RPC重试可能冒充下一工具结果。失败保留在`s7-managed-worker-parallel-fixture-failed.log`，不计通过。按真实调度规则改为bash并行／read串行，并以`toolExecutionId`去重闸门，两个不同执行进入才释放；修后重新定向及全量验证，不靠延长timeout或删断言。
- Runner补测初版用真正空流模拟“合法无可见文本”，两例按既有provider规则失败。随后补入原生OpenAI `reasoning-start` metadata及`response.completed` opaque reasoning，构成协议合法replay-only；另保留真正空流必须失败的用例。`s7-interactive-runner.log`、`s7-interactive-runner-final.log`为调试失败，最终以`final-2`及完整1354/1354为准。没有修改生产校验或删除失败语义验收。
- Web构建有既有大chunk提示，组件工具有Browserslist数据过期提示；不影响退出码，本阶段未升级依赖或改构建拆包。
- 本次默认API integration直接590/590，无需沿用前阶段`--test-concurrency=2`的替代执行；没有取消的命令计为通过。

## 4. 默认测试发现核验

| 层 | 发现机制与实际证据 |
| --- | --- |
| API | [run-tests.mjs](../../../apps/api/scripts/run-tests.mjs)递归发现`src/**/*.test.ts`；unit排除integration，integration还递归`tests`并排除唯一managed Worker文件；worker只执行该文件。新队列单测、HTTP／生产集成和本次新增managed参数场景分别已在U／I／M执行。插件root-cwd阶段在U日志中确实执行了8例。 |
| Web | [run-tests.mjs](../../../apps/web/scripts/run-tests.mjs)递归非组件测试并运行runner自测；[run-component-tests.mjs](../../../apps/web/scripts/run-component-tests.mjs)显式列出`AgentMessageQueue.component.test.ts`、Pane、ToolView等31个文件。runner自测验证31个唯一文件，实际summary为`completed=31, skipped=0, exitCode=0`；不是只手跑队列组件。 |
| Worker | `runtime/*.test.ts`、`runtime/compaction/*.test.ts`等已有glob包含interactive-input、queue-input-budget、stop及所有旧运行／provider／压缩测试；新增5例在完整R日志出现。 |
| Shared／CLI／插件 | 均执行各workspace正式`npm test`入口；Shared包含clean-build，CLI包含pretest build。 |

API gate只检查其列出的基础文件存在，不能单独证明所有新测试已执行；以上以正式脚本与实际测试日志共同确认。

## 5. 实现代码地图与证据索引

路径相对仓库根；测试命令编号对应第3节。

| 索引 | 实现／测试文件 | 所在执行组 |
| --- | --- | --- |
| Q | [message-queue.store.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.store.ts)、[service](../../../apps/api/src/modules/agent/message-queue/message-queue.service.ts)、[routes](../../../apps/api/src/modules/agent/message-queue/message-queue.routes.ts)；同目录`message-queue.test.ts`、`message-queue.integration.test.ts` | U、I |
| D | [dispatcher](../../../apps/api/src/modules/agent/message-queue/message-queue.dispatcher.ts)、[assembly](../../../apps/api/src/modules/agent/message-queue/message-queue.assembly.ts)；同目录`message-queue.dispatcher.test.ts`、`message-queue.assembly.integration.test.ts`、`message-queue.production.integration.test.ts` | U、I |
| X | [interactive-input.service.ts](../../../apps/api/src/modules/agent/message-queue/interactive-input.service.ts)、[binding store](../../../apps/api/src/modules/agent/message-queue/interactive-input-binding.store.ts)、[recovery store](../../../apps/api/src/modules/agent/message-queue/queue-recovery.store.ts)；[interactive-input.test.ts](../../../apps/api/src/modules/agent/message-queue/interactive-input.test.ts) | U |
| H | [runtime-control store](../../../apps/api/src/modules/agent/runtime-control/runtime-control.store.ts)、[service](../../../apps/api/src/modules/agent/runtime-control/runtime-control.service.ts)、[agent.worker-manager.ts](../../../apps/api/src/modules/agent/agent.worker-manager.ts)、[shared stop registry](../../../packages/shared/src/node/agent-run-stop.ts)；`runtime-control.test.ts`、`runtime-stop-registry.test.ts`、Worker `runner.stop.test.ts` | U、R、M |
| P | [publication store](../../../apps/api/src/modules/agent/attachments/agent-attachment-publication.store.ts)、[service](../../../apps/api/src/modules/agent/attachments/agent-attachment-publication.service.ts)及对应`.test.ts`；既有attachment storage与HTTP测试 | U、I |
| DB | [agent-queue-schema.ts](../../../apps/api/src/infra/db/agent-queue-schema.ts)、[schema.ts](../../../apps/api/src/infra/db/schema.ts)；`agent-queue-schema.test.ts`、`schema.test.ts`、`schema-v23-migration.test.ts`、`schema-v24-migration.test.ts`、`schema-v25-migration.test.ts`、`workspace-agent-data-cleanup.test.ts` | U |
| WR | [runner.ts](../../../apps/agent-worker/src/runtime/runner.ts)、[queue-input-budget.ts](../../../apps/agent-worker/src/runtime/queue-input-budget.ts)；`runner.interactive-input.test.ts`、`queue-input-budget.test.ts`、既有cancel／stop-condition／orphaned-tools／provider／streaming／auto-compact测试 | R |
| CP | [planner](../../../apps/agent-worker/src/runtime/compaction/planner.ts)、[primary-materializer](../../../apps/agent-worker/src/runtime/compaction/primary-materializer.ts)及对应测试；API read-side ModelContextResolver、RuntimeTranscriptProjector及replay integration | R、U、I |
| MW | [agent.worker.integration.test.ts](../../../apps/api/src/modules/agent/agent.worker.integration.test.ts)，Fastify＋真实受管Worker＋builtin工具＋本地HTTP假provider | M |
| UI | [useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts)、[AgentMessageQueuePanel.vue](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueuePanel.vue)、[AgentClientPane.vue](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue)、[AgentToolView.vue](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.vue)及对应组件测试 | W |

## 6. R／D／A覆盖追踪

### 需求与业务规则

| 需求 | 业务决策 | 实现与验收证据 |
| --- | --- | --- |
| R-ACCEPT | D-PERSIST、D-IDEMPOTENCY、D-LIMIT | Q／D／P／DB；A-ACCEPT、A-IDEMPOTENCY、A-LIMIT |
| R-INJECT | D-BOUNDARY、D-FINISH | X／WR／MW；A-BOUNDARY、A-FINISH |
| R-COUNT | D-SNAPSHOT | Q／UI；A-COUNT、A-MULTICLIENT；DOM及两轮真实Chromium A-COUNT通过，见第9节 |
| R-CONTROL | D-STOP、D-FAILURE、D-STOP-BARRIER | H／D／X／UI；A-STOP、A-CONTROL-RACES、A-STOP-BARRIER |
| R-IDENTITY | D-PROFILE | Q／D／UI；A-PROFILE；包括无queued时running身份锁及Tab／Shift+Tab |
| R-ATTACHMENT | D-INPUT-PROTECTION | P／CP／WR／MW；A-IMAGE、A-COMPACTION |
| R-RECOVERY | D-RECOVER、D-ABANDON、D-HISTORY | X／H／CP／UI；A-RECOVER-EXIT、A-ABANDON-SCHEMA、A-RECOVERY |
| R-CONFIRM | D-BINDING | X／WR／CP；A-BINDING-RETRY、A-FALLBACK |
| R-RETAIN | D-RETAIN、D-LIMIT | P／DB／UI；A-RETENTION |
| R-COMPAT | D-COMPAT | D／H／MW及既有scheduled/subtask/manual_compaction、CLI、Feishu回归；A-COMPAT、A-MIGRATION |
| R-BOUNDARY | D-BUDGET、D-HISTORY及上述事务／终态规则 | DB／H／X／WR／CP；A-BUDGET、A-SCOPE-DDL、A-HISTORY、A-SECURITY及崩溃矩阵 |

### 全部A组的具体自动化证据

下表中的测试名可在对应索引文件及执行组日志中定位；同一行多文件共同覆盖，不表示仅一个用例证明整组所有交错。

| 验收组 | 代码／测试及关键断言 | 本次证据层级 |
| --- | --- | --- |
| A-ACCEPT | Q `busy receipts persist FIFO without changing formal head/revision, including legacy noninteractive Runs`；D `dual scanners activate one trigger, Run, admission and legacy dedup; receipt stays unconfirmed`；paused仍受理、纯图片multipart、Worker starting/exit仍持久收件 | U、I；MW补工具执行中实际受理 |
| A-BOUNDARY | X `two-tool round remains closed to injection until every result...`、`prepare freezes at most eight FIFO candidates...`；MW本阶段4种整轮工具场景；WR orphaned-tools及stop-condition维持无结果fail-closed、最大步数与重复调用限制，不由新收件重置 | U、R、M；串／并／混合／合法失败有联合证据 |
| A-FINISH | X `continue is durable; cancellation of every candidate makes prepare finish without an extra model request`、`finish replay cannot turn into continue when a message arrives after commit`；WR新增reasoning-only／第6次合法replay-only的continue/finish；MW H1未知完成响应重放、Stop迟到回包 | U、R、M；真正空流仍失败，不虚构确认 |
| A-IDEMPOTENCY | Q `payload fingerprint, request namespace, cancellation tombstones and paused acceptance`、legacy request碰撞；P发布重复上传复用；X inject固定operation及8条前缀重放，不吸后来输入 | U、I、R、M |
| A-COUNT | UI `队列面板：N 只来自服务端 queued，暂停仍计数；N=0 时隐藏且 K 独立显示`；Pane `运行中普通消息使用 receipt，N 位于输入框上方...`；Q快照同事务、网络异常保留可信N | W、U及第9节两轮真实Chromium＋API＋Worker：3→刷新3→UI取消2→同Run有效输入→0隐藏；真实布局与轮询后展开节点均验证 |
| A-MULTICLIENT | UI `低版本与旧 Session 回包不能覆盖新快照，断网保留计数`、同版本公开Stop冲突、800/3000ms轮询、隐藏页恢复、旧确认不清新草稿；Q两SQLite连接及D双扫描；ToolView首次Session响应式交接 | W、U；受控回包／双连接，不冒充浏览器双标签 |
| A-STOP | H Stop事务、固定target、迟到取消；D `replaying a quiescent old Stop never targets a subsequently activated Run`；X Stop/inject两种顺序和queued-only／unpause-only恢复 | U、R、M |
| A-PROFILE | Q `identity stays fixed across default changes, rejects explicit conflict and revalidates configuration`；X profile删除阻止resume但允许abandon；UI运行中身份锁／textarea Tab与Shift+Tab、select均不能绕过 | U、I、W |
| A-CONTROL-RACES | X same-version resume/abandon赢家、旧resume不解除后继Stop；D cancel/activate、Stop旧operation不发新取消；H completed intent不改cancelled、取消先提交后迟到完成受fence约束 | U、I、M |
| A-STOP-BARRIER | H `DB terminal and barrier are atomic...`、`partial groups and new ready incarnation cannot turn old unknown into quiescent`、`rotating bounded scan...more than 32...`、原nonce/PID/spawn观察、offline专用证据；registry `precise stop waits for root/nested finally...`和admission迟回；Git unknown／lease保持 | U、R、M；持久DB＋受控runtime／真实ChildProcess生命周期，非DB终态推定退出 |
| A-ABANDON-SCHEMA | X全量hash/CAS及保留Timeline、fork后不复活；Q HTTP `recovery HTTP never strips extra receipt IDs, hashes, or explicit confirmation fields`、empty-input/stale-set错误码、恢复重放返回当前快照；公开TypeBox与Fastify共同校验 | U、I、S |
| A-IMAGE | P byte SHA-256/inode校验、HTTP改文件拒绝；MW第二次实际请求含原PNG字节；WR冻结图像buffer、同inode字节变更拒绝；CP非trigger的未确认／当前Run图片仍真实 | U、I、R、M |
| A-COMPACTION | X `compaction commit cannot omit or move its retained anchor past the earliest unconfirmed input`；CP `unconfirmed input is a hard retained boundary even before the ordinary fixed tail`、`abandoned inputs are absent from both retained content and summarizer prefix`及primary真实投影；旧auto-compact全量 | U、R、I |
| A-LIMIT | Q UTF-8／100条／64MiB与两连接事务重检；D游标公平轮转；WR有限FIFO前缀、最多一次压缩与有限冲突准备；P独立1GiB不与pendingBytes混用 | U、R |
| A-HISTORY | Q `legacy history cannot overtake pending input`；X abandon保留历史、fork排除；H历史入口同时检查root/target屏障；workspace cleanup／schema删除顺序 | U、I |
| A-SECURITY | Q HTTP全局鉴权、内部RPC验证、错误scope与删除fence；P `same-UID directory symlink replacement cannot publish outside the pinned Workspace target`、路径／inode替换拒绝且不unlink；WR replay/error脱敏；DB真实复合FK | U、I、R、M；仅fixture安全反例，不输出真实凭据 |
| A-RECOVERY | 下节逐崩溃点映射；包括事务回滚、丢回包、精确Stop unknown、enqueue对账、发布保留及删除围栏 | U、I、R、M；不声称每一行均做进程级断电实验 |
| A-COMPAT | D非交互Run不吸收；MW真实scheduled／subtask／manual_compaction／startup recovery；X `real local fallback continues the same Run...local_fallback`；C／F维持旧客户端功能 | U、I、M、C、F |
| A-MIGRATION | DB v23/v24/v25→v26保留历史／旧Run默认非交互、v25 ddl/version注入失败后可重试、未知／损坏schema拒绝且不破坏数据；cleanup保留独立账本／实例证据 | U，真实SQLite迁移fixture，不是生产用户数据库升级 |
| A-RECOVER-EXIT | X `resume requires physical retirement, reuses the earliest original User and associates every unconfirmed receipt`、生命周期resume无重插user、不自动重放旧工具、全量abandon后有效输入排除；H pending/unknown禁止恢复；UI显式确认 | U、I、W |
| A-BINDING-RETRY | X create/binding同事务、替换继承、superseded迟到不能确认；WR普通retry冻结tools/image、recovery同投影claim／变投影replace、Moonshot/DeepSeek替换、完成未知固定operation | U、R、I；实际provider输入保护与原replay回归共同验证 |
| A-BUDGET | WR `queue-input-estimator-v1 golden view counts exact bytes/messages/parts/calls/results/image occurrences`、W/R非法不兜底、aiSdk优先、8192/图片、边界等于可容纳／加1拒绝、opaque不重复计费、context-too-large有限失败；MW实际请求R=4096 | R、M |
| A-RETENTION | P独立预留、两连接1GiB、发布CAS、部分成功／unknown保守计额、回包丢失不重复发布、cancel累积额度、同UID替换不unlink、507文本可继续；DB逻辑删除保留账本 | U、I；离线维护仅验证限制与墓碑，不提供在线自动释放 |
| A-SCOPE-DDL | DB `all queue entities form real scoped FKs and admit the complete valid chain`、cross-Workspace/Session/Run/Assistant拒绝、NULL不能绕过CHECK、unique键与`foreign_key_check`；迁移及清理真实执行 | U，SQLite启用FK，不是仅SQL字符串匹配 |
| A-FALLBACK | X真实local fallback同Run continue与source；D production `public receipts remain sealed before real onListen...`、`production dispatcher executes fallback...`；H关闭超期仍unknown、不晚写；Worker starting/exit扫描epoch闸门 | U、I；fallback不是模型／工具联调 |

### A-RECOVERY逐崩溃点映射

| 06中的崩溃点 | 本次覆盖证据与边界 |
| --- | --- |
| temp完成、尚未受理 | Q HTTP非法multipart清私有staging；P非法source／preflight无发布；无receipt即可同ID重试。 |
| 文件发布后、receipt回滚 | P `receipt failure cannot roll back the published reservation; safe retry reuses its exact file and IDs`及独立连接回滚；Workspace文件不unlink，unknown继续计额。 |
| receipt提交、202丢失 | P `commit succeeded but response was lost...without publication or double charging`；Q by-request/detail；UI未知提交同ID查／重试，不丢File。 |
| 激活提交前 | D `activation transaction rolls back message, Run, input link, dedup, admission and queueVersion together`。 |
| 激活提交后、物理enqueue前 | H binding前Stop、binding后未发送Stop、固定target／admission；D DB-terminal但未退休仍阻塞。由事务与enqueue闸门验证，不假称无证据重启可恢复。 |
| enqueue成功、回包丢失 | D `enqueue unknown keeps the original Run and pauses; lifecycle reconciliation retries only that Run`；H pump transport failure保持tracked、不留DB孤儿。 |
| inject提交前 | X head/revision/input集合冲突及整批事务；queued／正式head不出现部分写入。 |
| inject提交、回包丢失 | X固定operation重放原message IDs、8条前缀冻结；WR取消候选重prepare及RPC重放，不重复吸后来输入。 |
| 绑定持久、provider未完成 | X create/binding同事务、失败仍unconfirmed；WR retry/recovery／图像校验；H retirement前禁止恢复，安全后显式续接或放弃。 |
| 完成裁决提交、回包丢失 | X持久continue/finish；WR无效回包固定operation；MW prepare/continue/finish/persistent_continue未知响应下无孤儿，Stop后迟到响应不复活。 |
| Stop提交、RPC前／丢回包 | H durable target/hash/admission、unknown后台固定ID重试、部分组证明不解除整屏障；registry迟到enqueue/tombstone。 |
| resume提交、回包丢失再Stop | X `service resume uses lifecycle admission...replay cannot undo a later Stop`及HTTP replay当前快照；旧action/run不变、当前paused不被覆盖。 |
| cancel提交、诊断前 | Q持久cancelled墓碑，重复POST仍cancelled；P留存费用不退与文件不unlink。 |
| Workspace删除意图后 | Q scope deleting fence；P reservation/publication/commit准入覆盖；H pending证据及Git lease阻止提前cleanup；DB新表清理不误删独立账本。 |

## 7. 与设计／历史表述的必要对齐

1. **设计通过不等于实施通过**：README原“业务代码尚未实现”已过时；07的原话保留并标记其历史时点。S7不伪造阶段或最终独立审查结论。
2. **无可见文本不等于无效空流**：现有Runner拒绝无文本、无reasoning、无工具、无合法replay的真正空流；06的阈值路径以协议合法replay-only验证。reasoning-only沿用当前provider合法完成语义；Moonshot／DeepSeek仍需真实协议replay验证，不能拿通用reasoning字符串绕过。
3. **控制结果未知不做失败推定**：固定operation已可能提交时持续保留tracked Runner与Stop能力；不是有限重试后丢弃执行者。新增补测未改变该已审查决策。
4. **精确停止只证明固定执行目标退出**：runtime UUID＋spawnNonce＋原ChildProcess exit是可信在线证据；没有新增`/proc`或OS boot ID读取。DB terminal、新ready或PID消失都不能单独证明旧实例退出；quiescent不清工具unknown／Git lease，不承诺撤回外部副作用。
5. **容量与预算仍保守**：pendingCount/pendingBytes与DataDir新增附件1GiB留存额度独立；取消／放弃／逻辑删除不释放已发布额度。版本化模型预算不是精确tokenizer，不保证provider永不拒绝。
6. **Web使用服务端权威而非本地推测**：N只计queued；K、Stop目标数另计。同版本冲突只比较公开版本字段，公开Stop的state/count/code必须比较，`inputIdentity`及内部proof不参与同版本冲突比较，但仍用于身份约束。
7. **接入时序保持双恢复屏障**：Worker starting/exit期间暂停扫描不拒持久收件；可信ready完整恢复后再扫描，epoch挡住await中的旧扫描。fallback在真实onListen恢复前不推进；关闭先封准入再停止、最后DB。

以上是既有实现语义核实与文档时点澄清，不新增产品能力、不删除验收组。

## 8. 未执行项、限制与交付门槛

| 项目 | 当前结论／后续责任 |
| --- | --- |
| 真实外部provider | 未调用；实际HTTP请求捕获使用本地假provider，不能宣称真实厂商网络／认证／限流／多模态端到端已验收。 |
| 浏览器人工／E2E | A-COUNT已由第9节两轮全新fixture真实Chromium＋API＋Worker完整通过；不再是待完成门槛。真实双标签／断网人工验收未做，仍以组件与双连接分层证据覆盖，不冒充全部组合E2E。 |
| 升级既有用户数据 | 只运行隔离SQLite fixture真实迁移／回滚／FK验证，没有读取或升级真实用户数据库。 |
| 全部故障的进程断电实验 | 事务hook、双连接、RPC闸门及真实Worker生命周期共同覆盖；未在每一崩溃行重复kill整套产品。不能把分层测试等同所有实机场景穷举。 |
| 离线附件维护／旧runtime未知清理 | 未提供在线强制释放或force-resume；未知状态保持阻塞与计额。人工排他维护仍需既定身份、引用与证据校验。 |
| S7独立审查 | 尚未执行，由主助理安排；本文件只交付作者自测结果。 |
| 最终全面对照方案审查及Git操作 | 尚未执行，由主助理安排；S7未暂存／提交任何文件，也不覆盖此前暂存成果。 |

结论：**S7作者自测完成；BROWSER-1已最小修复，A-COUNT两轮真实E2E通过，无剩余已知自动化失败。可交S7独立代码审查，但不提前宣称独立审查或最终产品验收通过。**

## 9. BROWSER-1最小生产修复与两轮真实浏览器验收

### 修复决策与范围

主助理已明确授权在S7实现生产最小修复，无需回退S6。BROWSER-1处置为**Fix，作者修复与自测完成，待S7独立审查**，不再是NeedUser或A-COUNT未完成项。

初始真实浏览器发现：刷新后N仍为3，展开列表后原生`details`节点被移除重建，新节点恢复折叠。源码[useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts)的两个watch返回新数组；生产[AgentClientPane.vue](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue)传入的`getScope()`会构造完整对象并读取`runState.value.status`，运行状态对象替换即使各primitive值未变，也触发数组getter回调，清空snapshot、重置generation／busy并拆掉队列节点。

生产仅将两个watch改为多primitive sources：

```ts
watch([() => getScope().workspaceId, () => getScope().sessionId], /* 原作用域回调 */);
watch([() => getScope().active, () => getScope().running], /* 原活跃／运行回调 */);
```

未改变原回调、API或业务规则：真正Workspace／Session变化仍重置代际、snapshot并读取对应未知操作；活跃／运行值实际变化仍刷新或暂停；重复Run快照不清可信N、不重建展开节点、不清在途busy、不取消轮询期限。新增5条生产同形getter回归：

1. 重复running对象更新后保留展开DOM节点、取消busy、原800ms轮询期限，取消成功仍可应用权威快照。
2. 在途Stop未知标记与确认不被误重置。
3. 在途resume未知标记与确认不被误重置。
4. 真正Workspace切换时清理状态，旧轮询／旧操作／旧finally均不能覆盖新scope或清新busy。
5. 同样验证真正Session切换。

新增反例在旧生产代码上27例中3例失败；修复后27/27。最小Vue机制复现与真实浏览器旧失败均保留，不冒充修复后验证。

### 工具与隔离

可选脚本：[verify-agent-queue-browser.mts](../../../apps/api/scripts/verify-agent-queue-browser.mts)。使用已构建Web及Worker、真实Fastify API、独立SQLite、真实受管Worker、真实Chromium布局与**本地假OpenAI provider**；不是厂商联调。浏览器HTTP与WebSocket仅允许loopback，禁用service worker。不导入API `main.ts`、开发Vite配置或整份integration test，不读取`.env.local`。截图只含测试fixture内容，不保存原始HTTP凭证或配置。

固定`playwright@1.56.1`、Chromium headless shell `141.0.7390.37`（build `v1194`，安装器附带FFMPEG `v1011`）。仅在`.tmp-tests/browser-e2e`安装公开工具／浏览器，无正式依赖修改、全局安装或系统依赖安装；本次修复复用既有工具，没有重新安装。默认测试不要求下载浏览器。

以下从仓库根执行，前提是第1轮完整构建生成的shared／Worker dist可用。浏览器安装与执行cwd均为隔离`tools`；Web重建单独在`apps/web` cwd执行，使既有Tailwind相对内容路径正确生效。使用现有`vite.component-test.config.ts`的`envDir:false`、同一Vue插件及alias进行生产build，不经开发配置的`loadEnv`；不修改正式Vite配置。

```bash
set -eu
repo="$PWD"
base="$repo/.tmp-tests/browser-e2e"
mkdir -p "$base"/{tools,home,tmp,cache,config,data,npm-cache,browsers,profiles,downloads,evidence}
: > "$base/user.npmrc"
: > "$base/global.npmrc"
run_isolated() {
  env -i PATH="$PATH" LANG=C.UTF-8 \
    HOME="$base/home" TMPDIR="$base/tmp" \
    XDG_CACHE_HOME="$base/cache" XDG_CONFIG_HOME="$base/config" XDG_DATA_HOME="$base/data" \
    npm_config_cache="$base/npm-cache" \
    npm_config_userconfig="$base/user.npmrc" npm_config_globalconfig="$base/global.npmrc" \
    PLAYWRIGHT_BROWSERS_PATH="$base/browsers" TSX_DISABLE_CACHE=1 "$@"
}
cd "$base/tools"
# 仅首次准备需要以下两条；本次修复已复用既有工具，没有重装。
# run_isolated npm install --prefix "$PWD" --no-save --package-lock=false --ignore-scripts --workspaces=false playwright@1.56.1
# run_isolated node node_modules/playwright/cli.js install chromium-headless-shell
(cd "$repo/apps/web" && run_isolated node "$repo/node_modules/vite/bin/vite.js" build --config vite.component-test.config.ts)
run_isolated node "$repo/node_modules/tsx/dist/cli.mjs" "$repo/apps/api/scripts/verify-agent-queue-browser.mts"
run_isolated node "$repo/node_modules/tsx/dist/cli.mjs" "$repo/apps/api/scripts/verify-agent-queue-browser.mts"
```

每次生成独立DB、业务目录、socket、profile和`evidence/agent-queue-*`；退出前释放工具写回闸门、等待Run收敛，关闭browser／API／DB／本地server并移除业务目录，保留隔离profile与验收证据。browser profiles、downloads、HOME、TMPDIR、XDG及npm缓存／空npmrc均在隔离目录。

### 修复后实际验证结果

下表`evidence/`均相对于`.tmp-tests/browser-e2e/`。本轮未改API生产代码，未重复全部5786；不得将下表Web1293等重复累加为新的八组全量结果。

| 实际命令／证据 | 结果 |
| --- | --- |
| 旧实现运行新增反例；`evidence/watch-before-fix.log` | 24 pass、3 fail、0 cancelled／skipped，确认反例有效；不是通过记录 |
| 队列组件定向；`evidence/watch-after-fix.log` | 27/27，fail／cancelled／skipped均0 |
| 根cwd `npm test -w apps/web`；`evidence/web-tests-after-fix.log` | **1293/1293**：runner自测22、非组件493、组件778；31个组件文件全部完成，默认并发2，fail／cancelled／skipped均0 |
| 根cwd `npm run typecheck -w apps/web`；`evidence/web-typecheck-after-fix.log` | 退出0 |
| 上述隔离环境、Web cwd `node <repo>/node_modules/vite/bin/vite.js build --config vite.component-test.config.ts`；`evidence/web-build-final.log` | 退出0，重建完整Tailwind样式及修复后的Web dist；仅既有Browserslist过期／大chunk警告 |
| 根cwd显式 `node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ES2022 --moduleResolution Bundler --allowSyntheticDefaultImports --types node apps/api/scripts/verify-agent-queue-browser.mts`；`evidence/harness-typecheck-final.log` | 退出0；API tsconfig不含scripts，所以单独严格检查 |
| API cwd `node --import tsx --test --test-name-pattern='worker 队列:' src/modules/agent/agent.worker.integration.test.ts`；`evidence/managed-worker-targeted-after-fix.log` | **4/4**，fail／cancelled／skipped均0 |
| 第一轮最终真实Chromium：`evidence/agent-queue-run-11.log` | 退出0；`evidence/agent-queue-jhm3Wc/result.json`，13项断言全true，cleanup.complete=true |
| 第二轮全新fixture：`evidence/agent-queue-run-12.log` | 退出0；`evidence/agent-queue-YeKJDS/result.json`，13项断言全true，cleanup.complete=true；独立Run、DB、profile及socket |

类型检查、构建及最终E2E命令旁对应`.exit`均为0。未删用例、延长timeout或放宽业务断言换通过。

### 完整A-COUNT与同Run实际输入证据

两轮均真实完成：

1. 初始N=0，计数节点不存在；浏览器Enter发第一条，两个真实bash终态进入闭合前闸门。
2. 浏览器依次发3条排队消息，服务端N=3，真实DOM显示“有 3 条消息等待处理”。校验DOM顺序及`getBoundingClientRect`：label.bottom不超过输入框top，宽高为正；另断言footer的Tailwind `position:relative`与正padding，拒绝缺失构建样式的布局证据。
3. 刷新真实页面后仍N=3，receipt ID集合与FIFO不变、没有重复受理、provider仍仅首请求。
4. 普通点击展开，等待一次真实`/run-state` HTTP回包并让Vue完成渲染，确认同一details仍连接且保持展开；普通点击中间消息的取消按钮，N变2、receipt为cancelled，details仍保持展开。
5. 放开整轮工具结果后，原Run completed，下一真实Worker provider请求只有两条未取消的排队user且在全部完整call／results之后；取消文本不进入该请求。
6. N=0计数节点移除；Session只有一个Run、4个receipt（3 injected、1 cancelled），没有新Run或重复受理。

两轮请求均`requestCount=2`，calls位置`[2,3]`、results位置`[4,5]`、剩余users位置`[6,7]`，call/result ID集合完全对应。两轮网络均loopback，blockedHttp／blockedWebSocket为0。

每个最终证据目录均保留`queued-three.png`、`refreshed-three.png`、`cancelled-two.png`、`completed-zero.png`，以及安全JSON；实际已查看取消后2条截图，布局和展开列表与断言一致。没有force click、直接设置产品状态或API代替UI取消。**A-COUNT要求的一次真实E2E门槛已由两轮独立fixture关闭。**

### 开发失败与中间结果保留

- `agent-queue-run-1.log`：harness receipt SQL误用`run_id`，修为实际`injected_run_id`，未改生产schema。
- `agent-queue-run-2.log`、`run-3.log`：宽泛textarea匹配终端等额外输入，限定为队列后的composer，未改生产UI。
- `run-4.log`至`run-7.log`及`agent-queue-mhJ5ns/`：生产重置现象；旧details `connected=false`、新节点折叠，cleanup完整。`scope-watch-repro.json`保留真实Vue机制复现。
- `run-8.log`及`agent-queue-sQaQyk/`：生产修复后节点已连接且保持展开，但脚本精确按钮名未适配Ant Design双汉字间空格，仍失败。改用语义仍严格的`/^取\s*消$/`角色名，未强制点击。
- `web-typecheck-first.log`：新增fixture的resume响应缺合法action字段及异步断言的TS控制流收窄，修正测试fixture后严格检查通过，未改生产协议。
- `web-build-after-fix.log`：从tools cwd构建时Tailwind找不到相对配置／内容，产物缺布局样式。随后`run-9.log`、`run-10.log`虽然旧断言返回passed，但**不计最终视觉验收**。已改为Web cwd重建，harness增加样式存在断言；最终只采用完整样式重建后的`run-11.log`、`run-12.log`。

上述旧失败与诊断性中间结果都未删除、覆盖成通过；最终权威证据以本节指定的两轮为准。

## 10. S7最终文件清单

共11个正式文件：新增2个、修改9个；不包含被忽略的`.tmp-tests`工具／日志／截图／dist产物。不执行Git操作，本清单仅列本S7明确实施的变更，不推断或处理其他工作区变更。

| 类型 | 文件 | 范围 |
| --- | --- | --- |
| 修改 | [useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts) | 唯一生产逻辑改动：两个watcher |
| 修改 | [AgentMessageQueue.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts) | 5条生产同形scope回归 |
| 修改 | [context-writeback-application.test.ts](../../../apps/api/src/modules/agent/writeback/context-writeback-application.test.ts) | 既有完整run state期望补3字段 |
| 修改 | [agent.worker.integration.test.ts](../../../apps/api/src/modules/agent/agent.worker.integration.test.ts) | 真实工具整轮边界扩为4场景 |
| 修改 | [runner.interactive-input.test.ts](../../../apps/agent-worker/src/runtime/runner.interactive-input.test.ts) | 新增5条无可见文本／空流边界 |
| 新增 | [verify-agent-queue-browser.mts](../../../apps/api/scripts/verify-agent-queue-browser.mts) | 可选真实浏览器／API／Worker harness |
| 修改 | [README.md](README.md) | 当前状态与证据口径 |
| 修改 | [05-implementation-plan.md](05-implementation-plan.md) | S7实施、自测、交付状态 |
| 修改 | [06-testing-and-acceptance.md](06-testing-and-acceptance.md) | 历史时点与合法无可见文本澄清 |
| 修改 | [07-review-record.md](07-review-record.md) | 仅历史时点说明，不伪造代码审查通过 |
| 新增 | [08-implementation-and-acceptance.md](08-implementation-and-acceptance.md) | 实现／R-D-A／分层证据、实际命令、失败历史、两轮E2E及最终清单 |

## 11. S8最终全面审查后修复记录

### 11.1 审查裁决与边界

S7之后，全新全面独立审查发现**H1／M1／M2／L1／L2，结论未通过**。父任务明确裁决五项均Fix；本轮负责实际修复，不承担独立复审，不自行暂存或提交，不将本节自测解释为最终审查通过。前面S7的实现范围、5786与1293结果均保留其历史时点；本节才是S8范围。

- H1：新增窄`AgentRuntimeRetirementNotifier`，1024个活动预留＋pending身份上限，固定Run／instance去重退避；普通、nested、fallback的真实finally接入，Worker shutdown有界drain。只保存／发送四个身份字段，不保留Run正文／路径；不维持已退出controller，不忽略未retired fence。Manager原实例真实exit仍是通知未送达时的独立收敛证明，不能靠DB terminal伪造退出。
- M1：恢复服务的事务预检先CAS后Stop／profile，激活事务再CAS；旧operation成功重放仍在新版本前。HTTP双故障断言无状态修改／无新Run。
- M2：持久最小幂等结果＋每Run单slot的冻结缓存；16MiB／128MiB唯一预算、无TTL淘汰、同op singleflight、COMMIT后发布、安全释放、旧26形状惰性最小化；prepare／finish／expired严格union，Worker与fallback显式处理expired。每次结果附fresh queue，不存完整queue/items／system／候选正文／附件路径。未新增表、未改变schema26、未安装依赖。
- L1：确认快照的全集条数和完整后果告知；真实Pane传入Modal的已翻译文本／count参数断言，集合变化仍携带原hash/version，晚Session确认不发新操作。
- L2：pending／unknown分开展示，安全连接诊断及离线排他维护指引；quiescent后paused仍保留，queued N独立，无force-resume。

### 11.2 正式变更清单（路径相对仓库根）

共30个正式文件；测试临时日志与浏览器工具／证据仅在`.tmp-tests`，不纳入正式交付。

| 分组 | 文件 |
| --- | --- |
| Shared（4） | `packages/shared/package.json`；`packages/shared/src/internal-contracts/agent-api-queue.ts`；新增`packages/shared/src/node/agent-runtime-retirement.ts`；新增`packages/shared/tests/agent-runtime-retirement.test.ts` |
| Worker（4） | `apps/agent-worker/src/main.ts`；`apps/agent-worker/src/runtime/runner.ts`；`runner.stop.test.ts`；`runner.interactive-input.test.ts`（后两者同runtime目录） |
| API运行／装配（5） | `apps/api/src/modules/agent/agent.runtime.ts`；`agent.module.ts`；`agent.composition.ts`；`agent.worker.integration.test.ts`；`runtime-control.test.ts`（均同agent目录） |
| API队列（7） | `apps/api/src/modules/agent/message-queue/queue-recovery.store.ts`；`message-queue.service.ts`；`interactive-input.service.ts`；新增`frozen-prepare-cache.ts`；新增`frozen-prepare-cache.test.ts`；`interactive-input.test.ts`；`message-queue.integration.test.ts`（均同message-queue目录） |
| Web（6） | `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`；`AgentMessageQueuePanel.vue`；`AgentClientPane.component.test.ts`；`AgentMessageQueue.component.test.ts`（后3者同agent目录）；`apps/web/src/shared/i18n/locales/zh-CN.ts`；`en-US.ts` |
| 文档（4） | 本目录`03-architecture-and-data-model.md`、`04-api-and-worker-protocol.md`、`05-implementation-plan.md`、`08-implementation-and-acceptance.md` |

### 11.3 验证方式与故障覆盖

仓库根执行普通命令时设置：

```bash
export TMPDIR="$PWD/.tmp-tests"
export TSX_DISABLE_CACHE=1
npm run build -w packages/shared
npm run typecheck
# 上两者均会完成Shared构建；完成后才能运行依赖dist的测试。
npm test -w packages/shared
npm test -w apps/web
npm test -w apps/agent-worker
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
npm test -w packages/cli
npm test -w plugins/feishu
(cd apps/api && node scripts/verify-test-gate.mjs)
```

- H1新增确定性请求未提交、连续失败恢复、已提交丢回包、容量及shutdown未确认不造证据；Worker真实普通／nested finally与fallback重试；真实受管Worker三场景在finally退出后才新入队，后台dispatcher最终自动执行，仅两次模型请求／两个Run。原实例exit证明不退休后继实例；既有精确Stop全量回归保留。
- M2新增同op singleflight与原冻结内容／fresh queue，64KiB合成system与真实fixture图片路径不重复入`result_json`，cache丢失后普通prepare→expired、finish仍finish、metadata注入及回包丢失重放、迟到inject不释放新slot、无候选真实Assistant绑定释放、旧异步准备无发布权、事务失败不发布缓存、新op与Stop交错、真实16／128MiB边界。Worker在unknown之后收到expired，先换operation再执行一次模型。
- L1／L2沿用HTTP全集CAS与scope断言，并补充中文后果文本、冻结count、晚Session确认、两种停止状态及quiescent仍paused。

### 11.4 开发失败及处置（不删历史）

1. 初轮类型检查暴露prepare union后测试未做分支收窄，以及新增故障fixture的错误参数类型；已修正为显式判别decision和正确RPC错误／HTTP payload类型，没有放宽生产schema。
2. 初轮定向测试中旧断言要求原历史queue，与本阶段fresh queue要求冲突；已保持原稳定动作断言并严格匹配当前权威queue。prepare保持async拒绝语义，关闭准入用例改为先启动合法边界的await，再创建Assistant／关闭。
3. 一轮误把根`typecheck`（会clean build Shared）与依赖dist测试同时运行，导致模块暂缺；该轮无效，随后所有根类型检查与测试分开，顺序重跑通过。
4. 首轮多组并发加120s工具预算造成Worker／API integration／Web／构建被外部SIGTERM，整文件取消不作功能通过或失败结论。未修改测试内timeout／并发默认值，改用足够的工具预算后完整重跑。
5. fallback故障fixture曾直接terminal而未完成Assistant输入确认，使dispatcher正确拒绝带未确认输入的自动续跑；已改为真实Assistant完成确认后再退出，未移除安全检查。
6. managed新增重放fixture曾缺`content-type: application/json`导致415；修正测试请求头后完整34例通过。Web测试mount在未启用真实locale的分支导致文本断言读取key；启用原有带locale的Modal槽位装配后通过。
7. API unit一次既有Git lease用例出现`unreadable`而非`unconfirmed`：其createdAt与expiresAt取两次时钟，偶发跨1ms违反精确TTL校验。定向复现通过后，测试fixture改为同一毫秒基准，仍严格断言安全lease保留，不改生产lease规则。API gate曾在repo根误跑，改为API cwd退出0。

### 11.5 限制与交付条件

- 所有模型请求来自本地假provider／受控流；没有真实外部厂商、真实用户DB升级或人工双标签断网验收。
- 128MiB约束为冻结JSON载荷预算，不承诺整个Node RSS；持久元数据／真实receipt与附件留存仍依原生命周期存在。
- retirement长期不可达或安全状态未知时保持fail-closed及有界背压；shutdown超时不能假成功，须实际退出证据或既有离线排他维护路径收敛。
- S8作者完成后交父任务用原最终全面审查会话复审；本节不是独立复审通过证明。

### 11.6 S8实际执行结果

下表为各完整组最终成功执行（分批运行，不重复累计定向或重复执行）；日志均相对仓库根。全部测试组无fail／cancelled／skipped。最后通知器收紧为仅保存四个身份字段后，再次运行Shared、Worker、API unit、managed Worker和真实浏览器；未再次重复不受影响的其他组。

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `npm run build -w packages/shared` | 退出0；后续根typecheck也顺序完成clean build | `.tmp-tests/s8-shared-build.log` |
| `npm run typecheck` | 全workspaces退出0 | `.tmp-tests/s8-typecheck-complete.log` |
| `npm test -w packages/shared` | 148／148 | `.tmp-tests/s8-shared-complete.log` |
| `npm test -w apps/web` | 1294／1294＝runner22＋非组件493＋31组件文件779 | `.tmp-tests/s8-web-complete.log` |
| `npm test -w apps/agent-worker` | 1357／1357 | `.tmp-tests/s8-worker-complete.log` |
| `npm run test:unit -w apps/api` | API cwd1947／1947＋repo-root插件8／8 | `.tmp-tests/s8-api-unit-last.log` |
| `npm run test:integration -w apps/api` | 592／592 | `.tmp-tests/s8-api-integration-final.log` |
| `npm run test:integration:worker -w apps/api` | 34／34 | `.tmp-tests/s8-managed-complete.log` |
| `npm test -w packages/cli` | 421／421 | `.tmp-tests/s8-cli-test.log` |
| `npm test -w plugins/feishu` | 12／12 | `.tmp-tests/s8-feishu-test.log` |
| API cwd：`node scripts/verify-test-gate.mjs` | 退出0 | `.tmp-tests/s8-api-gate-final.log` |
| `npm run build -w apps/agent-worker` | 退出0 | `.tmp-tests/s8-worker-build-final.log` |
| Web：`node node_modules/vite/bin/vite.js build --config vite.component-test.config.ts`（按第9节隔离环境与正确相对位置） | 退出0，保留既有chunk大小／Browserslist警告，无依赖更新 | `.tmp-tests/s8-web-build-final.log` |

完整八组**5813例**，不加上重复运行及定向验证次数。

真实Chromium使用第9节相同隔离工具和命令，两次全新fixture均13／13断言通过，cleanup.complete=true、failedComponents为空：

| 运行 | 证据目录 | 日志 |
| --- | --- | --- |
| S8第1轮 | `.tmp-tests/browser-e2e/evidence/agent-queue-gFN96x/` | `.tmp-tests/s8-browser.log` |
| 最终身份字段收紧后第2轮 | `.tmp-tests/browser-e2e/evidence/agent-queue-HIfypv/` | `.tmp-tests/s8-browser-complete.log` |

仍是固定Playwright1.56.1／Chromium141.0.7390.37、真实布局＋Fastify＋受管Worker＋本地假provider：3→刷新3→真实点击取消2→同Run工具整轮后的下一请求→0隐藏；不是外部厂商或人工多标签／断网验收。证据含result.json及布局截图，原有失败历史不删除。本阶段不调用Git检查、暂存或提交；交父任务继续独立复审。


## 12. S8复审新增H2：容量拒绝闭合

### 12.1 问题处置与范围

原H1／M1／M2／L1／L2已Resolved。本轮仅处理新增**H2（Fix）**：16MiB system实证同operation重复8次、0已提交prepare、cache0，容量503进入控制写未知循环，外层有限prepare次数无效，只有Abort退出。不得用任意次数失败或从重试表删错误码掩盖未知写语义。

改动限于prepare严格union、两种暂停诊断、冻结缓存容量分类、API最小rejected持久裁决、Worker／fallback既有失败生命周期与定向回归、03／04／05／08文档。无新表、schema仍26、无公共route、无依赖安装、无Git操作／暂存／提交。退休通知器、冻结缓存上限与释放规则、Stop／admission安全fence、单Session单Run、输入确认及工具整轮语义不变。

### 12.2 生产行为及关键证据

- 单条超限`rejected/snapshot_too_large`；总额或1024在途准备名额满`rejected/cache_capacity`。均为严格认证内部HTTP200结果，无context／candidates；仅持久`runId＋operationId＋decision＋reason`，fresh queue不存账本，不占缓存。
- API先重放旧裁决，再在一致权威事务中验证scope／Run／Stop／head及安全工具边界并决定新操作。COMMIT失败无假成功，拒绝不能覆盖旧prepare／finish；旧prepare仅原冻结内容或expired，finish独立持久重放。
- Worker权威rejected在未知catch之外显式处理，unknown→新rejected能退出原operation等待；沿用failed终态＋paused。fallback同样一次失败、不热循环。准确暂停原因`prepare_snapshot_too_large`／`prepare_cache_capacity`，injected仍unconfirmed、queued仍queued。
- API测试覆盖：单条超限首次1次getContext，后续8次同op重放不重组；最小墓碑及重启重放；真实128MiB满额／旧slot不淘汰；旧prepared／finish不改判；拒绝记录已INSERT后由deferred FK触发真实COMMIT失败并回滚、stale head不能mint拒绝；1024在途名额拒绝无上下文组装；fallback两原因真实finally退休、failed／paused、无Assistant／无隐式dispatch。
- managed测试运行**真实Worker进程→AgentApiClient→认证HTTP API→真实输入服务／缓存容量检查／SQLite事务**。仅在测试装配层替换输入服务的getContext以生成16MiB合成system，不替换prepare结果、不手抛容量错误、不伪造API响应。两例分别为首次直接拒绝和网络unknown（首请求在handler前断socket）→原operation新拒绝；1次getContext、单个最小墓碑、HTTP200、cache0、0 provider／Assistant／inject。连接中的真实SSE收到failed事件，Run terminal／failed、Worker tracked active0、真实退休成功、输入保留。已有显式resume纠正上下文后能完成新Run；另一例显式abandon保留queued且不删除User。
- 原未知控制回包、finish／expired／Stop回归随Worker与managed完整组重新通过。

### 12.3 开发失败与处置（不删除历史）

1. 首次类型检查发现暂停码schema使用literals数组而非单个Type.Literal，初次替换未命中；补齐真实权威schema后全量typecheck通过。managed测试literal endpoint数组的includes类型也改为明确比较。
2. 新全局容量fixture以非Run键填缓存，触发生产清理的JSON键验证；改为测试内隔离清理器，仅测真实cache配额行为。fallback fixture缺少既有inject／complete能力，提前失败；补齐拒绝执行的能力替身后，真实拒绝分支／生命周期完整通过，不改生产安全校验。
3. 初尝通过settings存入16MiB agent prompt的managed fixture，Worker admission阶段发生网络错误、未进入prepare，不构成H2验证。最终按已允许的getContext装配测试桥生成同等system，让生产输入服务自己检查容量／持久化拒绝；保留失败日志，不宣称已覆盖“超大agent settings端到端”场景。临时网络诊断已移除，未保留生产日志扩张。
4. 一次错误地并发根typecheck与依赖Shared dist测试，clean build造成`ERR_MODULE_NOT_FOUND`；该轮无效。后续先顺序完成根typecheck／Shared构建，再运行依赖dist测试；最终检查无此并发。
5. 首轮多完整组同时跑时，Worker既有HTTP fixture的100ms Abort在请求抵达server之前触发，attempts0而断言1（`apiClient.test.ts`），不是H2功能断言失败。未修改该既有测试或超时策略，等其他完整组结束后独立重跑**整个Worker组1361／1361通过**，不是只重跑失败用例。

### 12.4 本轮真实命令与结果

统一临时目录为仓库`.tmp-tests`，运行tsx时`TSX_DISABLE_CACHE=1`；完整组工具预算600秒。Shared先构建；根typecheck自身重建Shared，未与最终依赖dist的测试并发。

| 命令 | 本轮有效结果 | 日志 |
| --- | --- | --- |
| `npm run build -w packages/shared` | 退出0；最终根typecheck再次重建通过 | `.tmp-tests/h2-shared-build.log` |
| `npm run typecheck` | 全workspace退出0 | `.tmp-tests/h2-typecheck-final.log` |
| `npm run build -w apps/agent-worker` | 退出0 | `.tmp-tests/h2-worker-build-final.log` |
| `npm test -w packages/shared` | **149／149**，无fail／cancelled／skipped | `.tmp-tests/h2-shared.log` |
| `npm test -w apps/agent-worker`（独立完整重跑） | **1361／1361**，无fail／cancelled／skipped | `.tmp-tests/h2-worker-final.log` |
| `npm run test:unit -w apps/api` | **1954＋8／1954＋8**，无fail／cancelled／skipped | `.tmp-tests/h2-api-unit-final.log` |
| `npm run test:integration -w apps/api` | **592／592**，无fail／cancelled／skipped | `.tmp-tests/h2-api-integration.log` |
| `npm run test:integration:worker -w apps/api` | **36／36**（含H2两例），无fail／cancelled／skipped | `.tmp-tests/h2-managed.log` |
| API cwd：`node scripts/verify-test-gate.mjs` | 退出0 | `.tmp-tests/h2-api-gate-final.log` |
| 最后加强deferred FK COMMIT失败断言后：`npm run typecheck -w apps/api` | 退出0，API unit完整重跑 | `.tmp-tests/h2-api-typecheck-final.log` |
| `tsx --test apps/web/src/features/workspace/tools/agent/{agentRunTerminalPresentation,agentMessageTimeline}.test.ts` | **25／25**，无fail／cancelled／skipped | `.tmp-tests/h2-web-targeted.log` |
| 使用现有`componentCommand`运行`AgentMessageQueue.component.test.ts` | **28／28**，无fail／cancelled／skipped | `.tmp-tests/h2-web-queue-component.log` |

以上本轮五类完整测试集合共**4100例**；不重复加算定向测试，不借用S8的5813作为本轮结果。Web实现未改，本轮仅全typecheck、上述定向测试及队列组件兼容检查；未重跑全Web、CLI／Feishu完整测试、Web build或浏览器，不冒充本轮验收。

### 12.5 交接

H2实现及作者自测完成后交回父任务，复用最终全面独立审查existing会话`sess_00mwb7zygi0000d610282e32ce`。本节不是独立复审通过证明，作者未调用该会话、未自行改变全面审查结论。已有五项Resolved事实保持；未追加无关重构或恢复框架。


## 13. 最终独立全面复审通过与同源树收尾归档

归档日期：2026-11-11。**工程实现完成，最终全面独立审查／原existing复审通过，0038整体实现可交付；工程H1／H2／M1／M2／L1／L2共6/6关闭，Open 0，无新增问题。** 本节为主助理确认最终审查结论后的收尾记录，不再改已通过的生产代码、协议、测试语义；不执行Git／stage／commit，不安装依赖。第1～12节所有未通过、修复和当时待审查结论保留历史。

### 13.1 审查性质与最终关闭依据

设计静态审查、S1～S7逐阶段代码审查、全新全面new审查及原会话existing复审须分开：设计第四轮通过不代表实施；阶段代码审查不替代整体审查；全面new首轮发现五项问题而未通过，S8修复后原五项Resolved但新增H2仍不通过；最终原existing会话`sess_00mwb7zygi0000d610282e32ce`复核H2及全体已关闭项后，主助理明确转述：

> H2 Resolved；0038整体实现可交付；原H1／M1／M2／L1／L2保持Resolved，无新增问题，6/6关闭Open 0。

| 工程问题 | 最终状态 | 关闭证据概要 |
| --- | --- | --- |
| H1 | Resolved | 固定Run＋instance、有界去重退休通知在真实finally收敛；不保留已退出controller，不忽略admission；原实例真实exit仍为独立证明 |
| M1 | Resolved | 新恢复操作权威事务先CAS后Stop／profile，激活再次CAS；旧成功operation先重放原动作＋fresh queue |
| M2 | Resolved | 最小持久元数据、16／128MiB冻结缓存、无TTL淘汰、COMMIT后发布、安全释放；原finish重放与普通prepare／expired区别保持 |
| L1 | Resolved | abandon全集数量／完整不可逆文案，原version／hash与Session隔离，不误确认或删除User |
| L2 | Resolved | Stop pending与unknown区分，安全诊断／离线维护指引；quiescent后仍paused，无force-resume |
| H2 | Resolved | 持久HTTP200 rejected，unknown原op取得权威裁决后failed＋paused，原User仍可resume／abandon；旧prepare／finish不改判，无provider／tools／orphan，Stoplate保持cancelled |

reviewer独立执行**141项定向tests通过**，跨层复核原16MiB／unknown／commitlost／Stoplate反例：1或2次同op受控failed／paused，原User可resume／abandon，无provider／tools／orphan，Stop保持cancelled。该141由主助理转述，未提供新的原始日志路径，不补造；不并入下面作者八组计数。**不称reviewer跑过真实managed Worker或真实browser**；这些由实现方本轮独立记录。完整审查分层见[07最终工程归档](07-review-record.md#最终工程实现与独立全面复审归档)。

### 13.2 同源树与安全执行顺序

本轮开始时对1057个正式源文件／配置保存SHA-256基线（仅项目src／scripts／tests和明确包配置，不读取真实.env或凭据），八组测试及真实browser后逐项相同，生产／协议／测试源树**0差异**。只修改README／07／08三个验收metadata文件；不新定业务规范，不改03／04／05或已审通过测试。

- 基线：`.tmp-tests/final-0038-source-before.json`；验证：`.tmp-tests/final-0038-source-verified.json`。
- 顺序时间账本：`.tmp-tests/final-0038-sequence.log`，2026-11-11 UTC 00:21:11开始构建，00:22:32～00:42:44顺序执行八组，00:43:13～00:44:06隔离Web build／harness类型检查，00:44:21～00:44:31最终browser。
- 普通构建／测试在仓库根设`TMPDIR="$PWD/.tmp-tests"`、`TSX_DISABLE_CACHE=1`。Shared构建及根typecheck的Shared clean build全部完成后才进入依赖dist测试；Shared正式test入口自身pretest clean build也先完成，后续Web／Worker等测试不并发。未运行会加载真实本地配置的开发Vite配置或API main。
- 八组整体按Shared→Web→Worker→API unit（含root-cwd plugin）→API integration→managed Worker→CLI→Feishu顺序执行。API integration仅将文件并发设为2，不改timeout／不删test；本轮没有放宽超时或修改生产／测试来获得通过。
- API integration复用官方脚本的完整递归发现规则，临时runner还在VM拦截官方脚本的待执行参数并逐文件集合相等断言：**61文件，集合完全相同**。记录：`.tmp-tests/final-0038-api-integration.mjs`及`.tmp-tests/final-0038-api-integration-files.json`。未修改正式runner。

可复现的根cwd命令顺序如下；所有临时runner及日志均位于项目内：

```bash
export TMPDIR="$PWD/.tmp-tests"
export TSX_DISABLE_CACHE=1
npm run build -w packages/shared
npm run typecheck
npm run build -w apps/agent-worker
npm run build -w apps/api
npm run build -w packages/cli
npm run build -w plugins/feishu
npm test -w packages/shared
npm test -w apps/web
npm test -w apps/agent-worker
npm run test:unit -w apps/api
node .tmp-tests/final-0038-api-integration.mjs
npm run test:integration:worker -w apps/api
npm test -w packages/cli
npm test -w plugins/feishu
(cd apps/api && node scripts/verify-test-gate.mjs)
```

### 13.3 最终相同源树完整八组实际结果

计数来自本轮完整脚本实际summary，不按预计数硬填；汇总为`.tmp-tests/final-0038-test-results.json`。下表**各组fail／cancelled／skipped均0**，所有入口退出0。

| 完整集合 | 实际通过 | 精确日志 |
| --- | --- | --- |
| Shared正式`npm test` | 149／149 | `.tmp-tests/final-0038-shared.log` |
| Web正式`npm test`（含runner／全部组件） | 1294／1294＝22 runner＋493非组件＋779组件 | `.tmp-tests/final-0038-web.log`；拆分汇总`.tmp-tests/final-0038-web-counts.json` |
| Worker正式`npm test` | 1361／1361 | `.tmp-tests/final-0038-worker.log` |
| API unit正式入口，两cwd均执行 | 1954＋8／1954＋8＝1962；root-cwd plugin 8例在日志末尾 | `.tmp-tests/final-0038-api-unit.log` |
| API integration完整61文件，文件并发2 | 592／592 | `.tmp-tests/final-0038-api-integration.log` |
| managed Worker正式入口 | 36／36，含H2两例与原Stop／finish／expired协议回归 | `.tmp-tests/final-0038-managed-worker.log` |
| CLI正式`npm test`，含pretest build | 421／421 | `.tmp-tests/final-0038-cli.log` |
| Feishu正式`npm test` | 12／12 | `.tmp-tests/final-0038-feishu.log` |
| **本轮八组合计** | **5827／5827；fail 0／cancelled 0／skipped 0** | 不累计重复定向、不加reviewer141、不借用历史5813或H2前轮4100 |

Web组件runner实录`completed=31, skipped=0, exitCode=0, signal=null`。本轮八组均首次完整执行通过，没有用仅补跑失败用例拼成全量结果。日志中受控503／无效回包／WARN属于故障注入测试的预期输出，不是失败summary。

| 构建／门禁 | 结果 | 精确日志 |
| --- | --- | --- |
| Shared build | 退出0 | `.tmp-tests/final-0038-shared-build.log` |
| 根typecheck（全部workspace） | 退出0，完成Shared clean build再进入测试 | `.tmp-tests/final-0038-typecheck.log` |
| Worker build | 退出0 | `.tmp-tests/final-0038-worker-build.log` |
| API build | 退出0 | `.tmp-tests/final-0038-api-build.log` |
| CLI build | 退出0，正式CLI pretest又构建一次 | `.tmp-tests/final-0038-cli-build.log` |
| Feishu build | 退出0 | `.tmp-tests/final-0038-feishu-build.log` |
| API cwd test gate | 退出0（成功时无stdout，日志为空属正常） | `.tmp-tests/final-0038-api-gate.log` |
| 隔离Web生产build，使用`vite.component-test.config.ts` | 退出0，保留既有Browserslist／大chunk警告 | `.tmp-tests/final-0038-web-build.log` |
| 浏览器harness独立strict typecheck | 退出0（成功时无stdout） | `.tmp-tests/final-0038-browser-typecheck.log` |

### 13.4 最终真实Chromium A-COUNT

复用第9节已成功的隔离函数／cwd／构建与运行方式，不安装或重装工具，不升级依赖：`env -i`，HOME／TMPDIR／XDG／npm cache和空npmrc均在`.tmp-tests/browser-e2e`，`PLAYWRIGHT_BROWSERS_PATH`也在该目录；`TSX_DISABLE_CACHE=1`。Web在`apps/web` cwd用现有`envDir:false`配置构建；不执行开发Vite配置`loadEnv`，不导入API main。执行harness的cwd为隔离tools。

本轮实际执行：

```bash
# run_isolated函数与repo/base取值完全沿用第9节；不包含其中注释掉的安装步骤。
(cd "$repo/apps/web" && run_isolated node "$repo/node_modules/vite/bin/vite.js" build --config vite.component-test.config.ts)
run_isolated node "$repo/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ES2022 --module ES2022 --moduleResolution Bundler --allowSyntheticDefaultImports --types node apps/api/scripts/verify-agent-queue-browser.mts
(cd "$base/tools" && run_isolated node "$repo/node_modules/tsx/dist/cli.mjs" "$repo/apps/api/scripts/verify-agent-queue-browser.mts")
```

- 原始日志：`.tmp-tests/final-0038-browser.log`；精确证据目录：**`.tmp-tests/browser-e2e/evidence/agent-queue-k0Sx2m/`**。
- 原始JSON：`result.json`；校验摘要：`.tmp-tests/final-0038-browser-results.json`。
- 既有Playwright **1.56.1**／Chromium **141.0.7390.37**，真实Fastify＋独立SQLite＋受管Worker进程＋真实页面布局；provider仅loopback fake，HTTP／WebSocket仅loopback，blockedHttp=0／blockedWebSocket=0。
- **13／13断言通过**：3条queued→刷新仍3且不重复→真实取消1条后2→完整工具轮次后同Run下一模型请求真实携带其余2条→N=0隐藏；真实Run快照刷新不拆已展开列表，数量位于输入框上方。
- 原始Run `run_00mwbecf6t0000098c1c8877de` completed；单Run、4 receipts（初始＋3 queued），3 injected、1 cancelled；本地provider仅2次请求，call位置2／3、两tool output位置4／5、两个queued User位置6／7，取消文本不进入请求。
- 四张截图：`queued-three.png`、`refreshed-three.png`、`cancelled-two.png`、`completed-zero.png`，均在上述证据目录，已确认存在且非空；首张真实布局也已查看。
- `cleanup.complete=true`、`failedComponents=[]`；browser／API／DB／bridge／provider清理完成，隔离data业务目录残留0；保留原JSON、截图与隔离工具／profile证据。

本次八组／构建／真实browser无failed／cancelled／skipped测试。另有**归档辅助检查错误**：只读JSON检查误用`checks`而非原始`assertions`键；本地Markdown检查未去除Unicode标点而误判旧锚点、表格提取正则跨行而误判清单。均只修正辅助检查，没有改harness、生产／测试或原始result.json；真实13项断言全部true，最终README／07／08的UTF-8、围栏、78个本地链接／锚点及35项清单逐路径核对通过。此处如实记载，不伪造成browser失败或隐瞒为全程命令无错误；harness原始退出0。此前S7／S8／H2失败历史继续保留。

### 13.5 证据限制与最终交接边界

- **实际用户DB升级、真实外部provider、人工多端／多标签／断网验收未执行**；隔离SQLite／fixture迁移不能替代用户现存DB升级，loopback fake provider不能替代厂商联调。
- reviewer的141定向与跨层反例、作者的5827完整测试、作者的真实managed／browser分别归档；不互相冒充，不推论所有故障／组合已穷举。
- 本次没有生产修复、协议或测试语义变化；README／07／08只是最终状态、审查关闭证据、执行计数、精确路径和交接metadata更新，不新增规范。
- 正式文件列表按历史会话账本、S8第11.2节、H2实际写入记录与mtime核对；**未读取Git index，不能用mtime证明文件当前是否已暂存**。下节交精确路径给主助理亲自git diff／暂存；本执行者未Git／stage／commit，未处理未知用户变更。

### 13.6 正式文件精确交接清单

S8原30项＋H2额外3项＋收尾新增涉及README／07两项，共**35个正式文件**，08已在S8清单内不重复计数。本轮收尾实际改动仅其中README／07／08三个metadata文件。机器可读清单`.tmp-tests/final-0038-formal-files.json`和逐行清单`.tmp-tests/final-0038-formal-files.txt`；均为辅助证据而非新增正式交付文件。

| 来源／分组 | 精确路径（相对仓库根） |
| --- | --- |
| S8／Shared | `packages/shared/package.json` |
| S8／Shared | `packages/shared/src/internal-contracts/agent-api-queue.ts` |
| S8／Shared | `packages/shared/src/node/agent-runtime-retirement.ts` |
| S8／Shared | `packages/shared/tests/agent-runtime-retirement.test.ts` |
| S8／Worker | `apps/agent-worker/src/main.ts` |
| S8／Worker | `apps/agent-worker/src/runtime/runner.ts` |
| S8／Worker | `apps/agent-worker/src/runtime/runner.stop.test.ts` |
| S8／Worker | `apps/agent-worker/src/runtime/runner.interactive-input.test.ts` |
| S8／API运行与装配 | `apps/api/src/modules/agent/agent.runtime.ts` |
| S8／API运行与装配 | `apps/api/src/modules/agent/agent.module.ts` |
| S8／API运行与装配 | `apps/api/src/modules/agent/agent.composition.ts` |
| S8／API运行与装配 | `apps/api/src/modules/agent/agent.worker.integration.test.ts` |
| S8／API运行与装配 | `apps/api/src/modules/agent/runtime-control.test.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/queue-recovery.store.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/message-queue.service.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/interactive-input.service.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/frozen-prepare-cache.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/frozen-prepare-cache.test.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/interactive-input.test.ts` |
| S8／API队列 | `apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts` |
| S8／Web | `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` |
| S8／Web | `apps/web/src/features/workspace/tools/agent/AgentMessageQueuePanel.vue` |
| S8／Web | `apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts` |
| S8／Web | `apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts` |
| S8／Web | `apps/web/src/shared/i18n/locales/zh-CN.ts` |
| S8／Web | `apps/web/src/shared/i18n/locales/en-US.ts` |
| S8／文档 | `docs/design/0038-agent-session-message-queue/03-architecture-and-data-model.md` |
| S8／文档 | `docs/design/0038-agent-session-message-queue/04-api-and-worker-protocol.md` |
| S8／文档 | `docs/design/0038-agent-session-message-queue/05-implementation-plan.md` |
| S8／文档 | `docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md` |
| H2额外涉及 | `packages/shared/src/contracts/agent-queue.ts` |
| H2额外涉及 | `packages/shared/tests/agent-queue.test.ts` |
| H2额外涉及 | `apps/agent-worker/src/runtime/queue-input-budget.ts` |
| 收尾新增涉及，仅metadata | `docs/design/0038-agent-session-message-queue/README.md` |
| 收尾新增涉及，仅metadata | `docs/design/0038-agent-session-message-queue/07-review-record.md` |

此前S7另有以下**4个不与上述35项重叠**的正式文件，历史是否已由主助理暂存无法在禁Git约束下判断；完整会话来源并集为39项，不把这些历史项遗漏，也不擅自认定其仍未暂存：

- `apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts`
- `apps/api/src/modules/agent/writeback/context-writeback-application.test.ts`
- `apps/api/scripts/verify-agent-queue-browser.mts`
- `docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md`

mtime还命中`apps/agent-worker/src/runtime/apiClient.ts`：H2调试曾临时加入后完整移除网络诊断，**无预期正式内容变更**，不因mtime把它冒充第40个功能改动。主助理如见该文件diff须自行核对来源，不得因清单而恢复未知变更。S1～S6已暂存的历史成果不据此重置或推断。本轮35项及S7额外4项均应由主助理亲自核对实际diff／index后决定暂存，`.tmp-tests`工具／日志／截图／dist不纳入正式文件。


## 14. Esc清队列／发送统一启动增量（2026-11-11，待独立审查）

### 14.1 用户共识与实施边界

基线已由主助理提交为`15e2590`（`feat(agent): add persistent session message queue and safe run injection`）。本轮作者未执行Git命令，不暂存／提交，不访问真实用户配置／凭证，不修改IM／飞书、Worker整轮工具闭合注入规则、数据库版本或operation kind。

| 增量 | 实现与安全边界 |
| --- | --- |
| Esc先清空、再停止 | 输入框原范围；running queued>0固定目标clear、queued=0独立Stop；非running无操作，IME／repeat／busy忽略，clear0也成功不转Stop |
| 固定clear | `queued-receipt-cancellation.ts`共享单条取消及Web Stop；scope全验后同事务取消仍queued集合，missing／foreign整批404；原集合重试不清后来消息，publication retained／授权撤销／正文清除但不unlink |
| Web Stop | 内部显式clearQueued策略，replay之后、acceptedQueueVersion冻结之前清当前根Session queued；原事务结合暂停／准入关闭／持久屏障，不清targets子树，不改变通用recovery／shutdown默认行为 |
| 迟到请求拒绝 | `queue-stop-generation.ts`对相关持久Stop身份排序hash。新Web冻结snapshot代际；老HTTP在onRequest早于body流捕获，直调service首次await前捕获；最终receipt提交复核。代际不入内容指纹，receipt去重优先 |
| 发送统一启动 | 最终附件publication commit同步事务里复用原恢复权威，组合profile／工具／执行／停止检查、receipt、解除暂停及必要新Run／全部未确认原输入绑定；之后可靠handoff，不事务内await或RPC |
| Web | 删除停止及继续处理按钮，保留abandon／单条cancel／N／pending unknown诊断；unknown clear固定原targets；四态中英文Placeholder；请求拒收保草稿与File，首次draft Session在首次await前发布sending交接 |

### 14.2 作者验证记录

所有最终相关分组共4056项通过，fail／cancelled／skipped均为0；不重复计入定向验证，不计旧版5827。真实Chromium另19项。

| 最终命令／范围 | 结果 | 证据（仓库根目录下） |
| --- | --- | --- |
| `npm run typecheck`（含先构建Shared、CLI／Worker／API／飞书／Web检查） | 通过 | `.tmp-tests/esc-root-typecheck.log` |
| `npm test -w packages/shared` | 150/150 | `.tmp-tests/esc-shared-tests-final.log` |
| `npm run test:unit`，cwd `apps/api` | 1968＋仓库cwd插件8＝1976/1976 | `.tmp-tests/esc-api-unit-final.log` |
| API integration完整61文件、`tsx --test --test-concurrency=2`（见下） | 596/596 | `.tmp-tests/esc-api-integration-complete.log` |
| `npm run test:integration:worker`，cwd `apps/api` | 36/36；managed Worker＋SQLite＋本地假provider | `.tmp-tests/esc-worker-integration-complete.log` |
| `npm test -w apps/web` | 1298/1298，31个组件文件全部执行，skipped0 | `.tmp-tests/esc-web-all-final.log` |
| `node scripts/verify-test-gate.mjs`，cwd `apps/api` | 通过 | `.tmp-tests/esc-api-test-gate.log` |
| `npm run build -w apps/api`、`npm run build -w apps/agent-worker` | 均通过 | `.tmp-tests/esc-api-build-final.log`、`.tmp-tests/esc-worker-build-final.log` |
| browser harness独立strict TypeScript检查 | 通过 | `.tmp-tests/esc-browser-typecheck.log` |
| 隔离Vite component-test config build＋真实Chromium | 19/19，cleanup complete | `.tmp-tests/esc-browser.log`、`.tmp-tests/browser-e2e/evidence/agent-queue-aXFziP/result.json` |

API integration按正式runner相同collect／suffix过滤全部61文件，仅限制并发为2，不遗漏文件、不修改默认测试脚本。可在`apps/api`重现：

```sh
node --input-type=module <<'JS'
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? collect(join(dir, e.name)) :
    e.isFile() && e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []);
}
const files = [...collect('src'), ...collect('tests')].filter(f =>
  f.endsWith('.integration.test.ts') && f !== 'src/modules/agent/agent.worker.integration.test.ts');
execFileSync('../../node_modules/.bin/tsx', ['--test', '--test-concurrency=2', ...files], { stdio: 'inherit' });
JS
```

浏览器采用Playwright1.56.1／Chromium141.0.7390.37，仅loopback fake provider；真实API／SQLite／受管Worker／Web dist，不是外部厂商联调。保留原13项整轮工具闭合注入及N／刷新断言，追加首Esc清空不停、两个running Placeholder、repeat不停止、第二独立Esc停止清空、按钮移除、安全退出后正常发送新Run，共19项。截图`esc-send-after-stop.png`等与result.json同目录；证据确认旧Run cancelled、queued0、cleanup全部完成。

harness类型检查命令（仓库根）：

```sh
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck \
  --target ES2022 --module ES2022 --moduleResolution Bundler \
  --allowSyntheticDefaultImports --types node \
  apps/api/scripts/verify-agent-queue-browser.mts
```

真实用户DB升级、外部provider、人工多端仍未验证；本轮没有声称完成这些验收。

### 14.3 失败与处置、审查关注点

- API首次unit 1963项中3项旧预期与新共识冲突：Web Stop不再保queued；queued-only兼容resume改用异常暂停前提；fallback finally未退休时拒收而不宣称可提前新收件。保持原恢复／安全注入／可靠退休覆盖，不放宽生产检查。
- Web首次全组出现5项首发draft测试失败：fixture缺required stopGeneration，pre-send snapshot被契约拒绝；修正fixture且保留原ID／File跨Pane交接断言。随后完整组必须无skipped才算通过。
- 首次真实浏览器18项后失败来自本地fake provider每轮复用message ID，导致fixture主键冲突；改为逐轮唯一ID，最终19项通过。这不是生产数据库去重缺陷。
- API integration及managed首轮工具240秒上限中断，不能算完整失败／通过。完整integration保持全部61文件，`--test-concurrency=2`重跑，不删用例／放宽时限断言。
- managed旧H1两项queued预期改为cancelled。旧S8退休通知用例在API未取得drained证明时直接新收件不再合法；改为先断言409 execution_not_drained，保持request_lost／continuous_failure／committed_reply_lost三种退休原ID重试，取得证明后收件只启动一次新Run且不重跑旧模型；不放宽执行屏障。
- 成功Chromium日志仍观察到既有`persistRunTerminalIntent`对迟到Worker terminal intent报`terminal intent conflicts with current run state`：源路径在`agent-message.store.ts`未改动，当前状态／tuple不匹配即拒绝的保护仍在；19断言、旧Run cancelled、Stop quiescent及新发送成功均成立。本轮不吞异常、不改终态幂等协议，交独立审查核查诊断等级及既有竞态，不能将该日志隐藏为“无错误日志”。
- 独立reviewer重点：最终receipt事务恢复原子性／失败回滚；legacy HTTP body streaming代际；原requestId及Stop ID重放；clear scope及注入交错；Web-only Stop策略；draft Pane handoff与unknown clear原目标保留；退休通知新拒收测试及上述terminal-intent诊断。

本节14.1～14.4记录首审前作者自测与文件树；独立首审随后未通过，修复及复审状态见第15节，不以本节4056冒充修复后验证。

### 14.4 本轮精确文件清单（37份）

26份已有源码／测试修改、2份新增源码、9份设计文档。临时日志／浏览器工具／DB只在`.tmp-tests`，不属于正式变更。

**已有源码／测试**

- [apps/api/scripts/verify-agent-queue-browser.mts](../../../apps/api/scripts/verify-agent-queue-browser.mts)
- [apps/api/src/modules/agent/agent.worker.integration.test.ts](../../../apps/api/src/modules/agent/agent.worker.integration.test.ts)
- [apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts)
- [apps/api/src/modules/agent/message-queue/interactive-input.test.ts](../../../apps/api/src/modules/agent/message-queue/interactive-input.test.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.assembly.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.assembly.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.dispatcher.test.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.dispatcher.test.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.routes.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.routes.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.service.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.service.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.store.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.store.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.test.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.test.ts)
- [apps/api/src/modules/agent/message-queue/message-queue.testkit.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.testkit.ts)
- [apps/api/src/modules/agent/message-queue/queue-recovery.store.ts](../../../apps/api/src/modules/agent/message-queue/queue-recovery.store.ts)
- [apps/api/src/modules/agent/runtime-control/runtime-control.service.ts](../../../apps/api/src/modules/agent/runtime-control/runtime-control.service.ts)
- [apps/api/src/modules/agent/runtime-control/runtime-control.store.ts](../../../apps/api/src/modules/agent/runtime-control/runtime-control.store.ts)
- [apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/AgentClientPane.vue](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue)
- [apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/AgentMessageQueuePanel.vue](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueuePanel.vue)
- [apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts)
- [apps/web/src/shared/api/agentMessageQueueApi.ts](../../../apps/web/src/shared/api/agentMessageQueueApi.ts)
- [apps/web/src/shared/i18n/locales/en-US.ts](../../../apps/web/src/shared/i18n/locales/en-US.ts)
- [apps/web/src/shared/i18n/locales/zh-CN.ts](../../../apps/web/src/shared/i18n/locales/zh-CN.ts)
- [packages/shared/src/contracts/agent-queue.ts](../../../packages/shared/src/contracts/agent-queue.ts)
- [packages/shared/tests/agent-queue.test.ts](../../../packages/shared/tests/agent-queue.test.ts)

**新增源码**

- [apps/api/src/modules/agent/message-queue/queued-receipt-cancellation.ts](../../../apps/api/src/modules/agent/message-queue/queued-receipt-cancellation.ts)
- [apps/api/src/modules/agent/message-queue/queue-stop-generation.ts](../../../apps/api/src/modules/agent/message-queue/queue-stop-generation.ts)

**九份设计文档**

- [docs/design/0038-agent-session-message-queue/01-requirements-and-product.md](../../../docs/design/0038-agent-session-message-queue/01-requirements-and-product.md)
- [docs/design/0038-agent-session-message-queue/02-business-rules-and-state-machine.md](../../../docs/design/0038-agent-session-message-queue/02-business-rules-and-state-machine.md)
- [docs/design/0038-agent-session-message-queue/03-architecture-and-data-model.md](../../../docs/design/0038-agent-session-message-queue/03-architecture-and-data-model.md)
- [docs/design/0038-agent-session-message-queue/04-api-and-worker-protocol.md](../../../docs/design/0038-agent-session-message-queue/04-api-and-worker-protocol.md)
- [docs/design/0038-agent-session-message-queue/05-implementation-plan.md](../../../docs/design/0038-agent-session-message-queue/05-implementation-plan.md)
- [docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md](../../../docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md)
- [docs/design/0038-agent-session-message-queue/07-review-record.md](../../../docs/design/0038-agent-session-message-queue/07-review-record.md)
- [docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md](../../../docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md)
- [docs/design/0038-agent-session-message-queue/README.md](../../../docs/design/0038-agent-session-message-queue/README.md)


## 15. 独立首审未通过与H1／M1／L1作者修复（待复审）

### 15.1 处置与机制

独立审查会话`sess_00mwbkx46f00006b8334387035`首审未通过。H1高、M1中、L1低均决策Fix，不以reviewer其余373项通过或首审前作者4056项作为关闭依据。此轮只跑相关定向回归／类型检查及必要浏览器，复审通过后再跑最终完整相关回归。

- **H1**：已有Session首个可信snapshot缺失／scope不匹配时，Pane在任何await前拒绝本次发送，仅刷新和加载提示，保留文字／File；不调用ensureSession、不发布sending handoff、不在snapshot返回后自动续发。snapshot到达后必须新的独立用户发送动作。
- `composable.submit`自身要求payload已经冻结stopGeneration，缺少即AGENT_QUEUE_STATE_UNKNOWN；不再从当前snapshot或await GET补值。已开始动作在ensureSession／普通prompt准备await间跨Stop，仍发送原代际，被API最终权威拒绝；重试原副本也不替换代际。
- 真正fresh draft在动作准入时冻结共享`AGENT_QUEUE_INITIAL_STOP_GENERATION`，即SHA-256(JSON.stringify([]))。API在无相关持久Stop时返回相同权威常量，非空仍按原排序集合hash。已有Session不能默用initial；draft没有ensureSession或ensureSession仅返回原ID，不能作为fresh首发证明。
- fresh事实：AgentToolView将本地draft标sessionReady=false；ensureSessionCreated匹配draft后调用createAgentSession POST，API createPrimarySession→createSession分配新Session ID，非draft仅返回原ID。原workspace/session scope检查及创建后的同步sending publication保留；真实父子Pane卸载交接继续支持一键首发。创建响应期间发生Stop时，第一条仍是initial而非后来snapshot代际，明确409；新Pane完整保留原File／草稿，后续独立发送才用当前可信代际成功。
- **M1**：06现行受理表、continue后Stop／预算表、Stop→inject的N断言逐项修正，不仅页首注明优先级。用户Web Stop原子清queued，失败／预算暂停保留旧queued；pending／unknown／未drained拒收，安全的新发送承担恢复。
- **L1**：08仅单个末尾换行；用字节、行尾空白检查替代Git检查，本作者未执行Git命令。
- terminal-intent冲突已由独立reviewer确认是原安全拒绝且保持cancelled，WontFix／风险可接受，不吞异常、不放松终态规则；本次浏览器仍如实保留该日志。

### 15.2 修复后实际验证

| 定向命令／范围 | 结果 | 证据 |
| --- | --- | --- |
| `npm run build -w packages/shared` | 通过 | `.tmp-tests/esc-review-shared-build.log` |
| API cwd：`tsx --test --test-reporter=tap`，message-queue.test.ts、message-queue.integration.test.ts、message-queue.dispatcher.test.ts、message-queue.assembly.integration.test.ts | 69/69 | `.tmp-tests/esc-review-api-targeted.log` |
| Web `runComponentTests`仅AgentClientPane、AgentMessageQueue、AgentToolView三个文件 | 76＋31＋131＝238/238，completed3／skipped0 | `.tmp-tests/esc-review-web-targeted.log` |
| Shared cwd：`tsx --test tests/agent-queue.test.ts` | 11/11 | `.tmp-tests/esc-review-shared-targeted.log` |
| `npm run typecheck -w apps/api`、`npm run typecheck -w apps/web`、`tsc -p packages/shared/tsconfig.json --noEmit` | 均通过 | `.tmp-tests/esc-review-api-typecheck.log`、`.tmp-tests/esc-review-web-typecheck.log`、`.tmp-tests/esc-review-shared-typecheck.log` |
| 按第9节既有隔离环境重建Web并运行真实Chromium harness | 19/19，cleanup complete | `.tmp-tests/esc-review-browser-build.log`、`.tmp-tests/esc-review-browser.log`、`.tmp-tests/browser-e2e/evidence/agent-queue-oQYzPB/result.json` |

合计318项相关定向通过，fail／cancelled／skipped均0；浏览器19项另计。未重跑4056全组，不宣称本轮已独立通过。

新增／强化覆盖：已有Session首次snapshot跨完整Stop不自动发送；scope不匹配不能准入；ensureSession和普通prompt准备await跨Stop保持原代际、拒收保File且后续独立发送成功；composable缺generation即使后来snapshot可用也不补值；fresh正常一键首发／创建响应期间Stop拒收／真实父子Pane与File交接；fresh未创建新ID不提交；fresh创建await期间workspace／session切换不发送旧动作；Shared初始hash与API空历史权威一致。

测试编写中发现并修正测试前提：旧composable测试应由动作显式提供冻结代际，不能再期待composable补取；API新HTTP尝试需把保留File重新stage，旧请求temp在finally清理；新增Pane成功发送的timeline应由fixture即时响应，避免错误等待HTTP超时。最终记录以上完整定向组，不把中途fixture失败／工具超时算通过。

### 15.3 精确文件与复审边界

本次首审修复修改15份既有文件，不新增正式文件，整体增量仍为第14.4节37份。清单和最终同源哈希：`.tmp-tests/esc-review-fix-changed-files.json`、`.tmp-tests/esc-review-fix-source-hashes.json`；原交付哈希保存在`.tmp-tests/esc-review-fix-before.json`。

复审重点为用户动作同步冻结、fresh证明与scope guard、首次snapshot不自动续发、拒收File／Pane交接；事务／handoff／clear协议不另改动。H1／M1／L1状态为作者已修复、待原会话复审，不标独立Resolved。

本次15份文件的完整清单（相对仓库根）：

- [apps/api/src/modules/agent/message-queue/message-queue.test.ts](../../../apps/api/src/modules/agent/message-queue/message-queue.test.ts)
- [apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/AgentClientPane.vue](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue)
- [apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts)
- [apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts](../../../apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts)
- [apps/web/src/shared/i18n/locales/en-US.ts](../../../apps/web/src/shared/i18n/locales/en-US.ts)
- [apps/web/src/shared/i18n/locales/zh-CN.ts](../../../apps/web/src/shared/i18n/locales/zh-CN.ts)
- [packages/shared/src/contracts/agent-queue.ts](../../../packages/shared/src/contracts/agent-queue.ts)
- [packages/shared/tests/agent-queue.test.ts](../../../packages/shared/tests/agent-queue.test.ts)
- [apps/api/src/modules/agent/message-queue/queue-stop-generation.ts](../../../apps/api/src/modules/agent/message-queue/queue-stop-generation.ts)
- [docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md](../../../docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md)
- [docs/design/0038-agent-session-message-queue/07-review-record.md](../../../docs/design/0038-agent-session-message-queue/07-review-record.md)
- [docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md](../../../docs/design/0038-agent-session-message-queue/08-implementation-and-acceptance.md)
- [docs/design/0038-agent-session-message-queue/README.md](../../../docs/design/0038-agent-session-message-queue/README.md)


可复现的定向命令（仓库根执行）：

```sh
(cd apps/api && ../../node_modules/.bin/tsx --test --test-reporter=tap \
  src/modules/agent/message-queue/message-queue.test.ts \
  src/modules/agent/message-queue/message-queue.integration.test.ts \
  src/modules/agent/message-queue/message-queue.dispatcher.test.ts \
  src/modules/agent/message-queue/message-queue.assembly.integration.test.ts)
(cd packages/shared && ../../node_modules/.bin/tsx --test tests/agent-queue.test.ts)
(cd apps/web && node --input-type=module <<'JS'
import { runComponentTests } from './scripts/run-component-tests.mjs';
const result = await runComponentTests({ tests: [
  'src/features/workspace/tools/agent/AgentClientPane.component.test.ts',
  'src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts',
  'src/features/workspace/tools/agent/AgentToolView.component.test.ts'
] });
process.exitCode = result.exitCode;
JS
)
```

## 16. Esc增量最终独立复审通过与同源树归档

### 16.1 独立审查关闭与本次边界

原会话`sess_00mwbkx46f00006b8334387035`复审通过，H1／M1／L1全部Resolved，3/3关闭、Open 0、无新增问题。独立机器证据：`.tmp-tests/review-esc/re-review-summary.json`；主助理已核验summary和关键代际准入代码，确认Git diff空白检查通过。作者未执行Git、不暂存、不提交。

reviewer独立339/339＝API81＋Web238＋Shared11＋crossLayer6＋UI3，fail／cancelled／skipped均0。作者Chromium19仅由reviewer核读，不计reviewer执行；作者318定向和旧4056／5827均不混入下面本轮最终五组。首审未通过与修复历史按时点保留。

本次不改已审通过的生产代码、协议或测试语义；最终只更新本目录README／07／08状态metadata，另修正07两条已失效的文档锚点目标，保留历史文字。源树如需修改应先回报并重新送审；本轮无此类改动。

### 16.2 同源树最终五组实际结果

| 完整相关集合 | 实际通过 | 精确日志（仓库根目录下） |
| --- | --- | --- |
| Shared正式test，先完成clean-build | 151/151 | `.tmp-tests/esc-final-archive/shared.log` |
| API unit正式入口，含root-cwd插件 | 1969＋8＝1977/1977 | `.tmp-tests/esc-final-archive/api-unit.log` |
| 完整61文件API integration，文件并发2 | 596/596 | `.tmp-tests/esc-final-archive/api-integration.log` |
| managed Worker正式入口 | 36/36 | `.tmp-tests/esc-final-archive/managed-worker.log` |
| Web正式test，含完整31组件 | 1309/1309＝22 runner＋493非组件＋794组件 | `.tmp-tests/esc-final-archive/web.log` |
| **本轮五组合计** | **4069/4069，fail 0／cancelled 0／skipped 0** | `.tmp-tests/esc-final-archive/test-counts.json` |

Web组件summary：completed31、skipped0、exitCode0、signal=null。各完整测试组首次完整执行均通过，无失败用例补跑拼接；API integration独占资源执行，并发固定2，managed Worker也单独执行，其后API unit与Web并行。只覆盖本轮要求的五组，不声称重跑基线Worker unit／CLI／飞书三组或全仓八组。

所有入口和构建门禁命令／cwd／退出码／耗时在`.tmp-tests/esc-final-archive/execution.json`及各`*.result.json`。Shared clean-build顺序完成后，root typecheck再次构建Shared；随后API／Worker build通过，依赖dist的API／Web／managed组才运行，未并行清理Shared dist。root typecheck、API／Worker build、API test gate及harness独立strictcheck均退出0，对应同目录`root-typecheck.log`、`api-build.log`、`worker-build.log`、`api-test-gate.log`、`harness-strictcheck.log`。

可复现正式入口（均从仓库根执行；临时日志固定在项目`.tmp-tests`）：

```sh
export TMPDIR="$PWD/.tmp-tests"
export TSX_DISABLE_CACHE=1
export npm_config_cache="$PWD/.tmp-tests/npm-cache"
npm test -w packages/shared
npm run typecheck
npm run build -w apps/api
npm run build -w apps/agent-worker
npm run test:unit -w apps/api
npm run test:integration:worker -w apps/api
npm test -w apps/web
node --input-type=module -e "process.chdir('apps/api'); await import(process.cwd() + '/scripts/verify-test-gate.mjs')"
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ES2022 --moduleResolution Bundler --allowSyntheticDefaultImports --types node apps/api/scripts/verify-agent-queue-browser.mts
```

API integration递归发现与正式runner完全相同，完整路径集合在`.tmp-tests/esc-final-archive/api-integration-files.json`（61项），只将文件并发限制为2。实际Node／tsx参数及API cwd在`api-integration.result.json`；可在仓库根用以下方式重现，不改正式runner：

```sh
node --input-type=module <<'JS'
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const collect = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name);
  return e.isDirectory() ? collect(p) : e.isFile() && e.name.endsWith('.integration.test.ts') ? [p] : [];
});
const files = [...collect('apps/api/src'), ...collect('apps/api/tests')]
  .filter(p => p !== 'apps/api/src/modules/agent/agent.worker.integration.test.ts').sort();
if (files.length !== 61) throw new Error(`Unexpected integration file count: ${files.length}`);
const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=2', ...files.map(p => p.slice('apps/api/'.length))], { cwd: join(root, 'apps/api'), stdio: 'inherit' });
process.exitCode = result.status ?? 1;
JS
```

临时执行器首次误以仓库cwd运行依赖API cwd的test gate，退出1（不是测试或源代码失败）；保留`attempt1-api-test-gate.log`及`auxiliary-attempts.json`，仅改`.tmp-tests`执行器cwd后完整gate退出0。不修改源文件、不伪称所有辅助命令零错误，不将此计入tests失败。五组测试本身fail／cancelled／skipped均0。

### 16.3 哈希、Chromium及37份正式文件

- `.tmp-tests/esc-final-archive/source-before.json`与`source-after.json`：SHA-256覆盖1430份apps／packages／plugins首方源文件、测试、脚本、配置及既有根package／lock／tsconfig／AGENTS文件。具体集合、排除规则和逐文件哈希写入JSON；排除dist、node_modules、临时工具／日志／截图、环境和数据文件、软链。before/after路径集合及哈希完全匹配，不用mtime替代内容核查。
- `.tmp-tests/esc-final-archive/formal-before.json`与`formal-after.json`：相对主助理提供的基线`15e2590`沿用已核实37项正式清单（26 modified＋2 new＋9 documentation），完整逐路径清单及当前SHA-256在后者；数量不变。此次作者没有Git权限，最终相对提交的diff仍由主助理亲自核查；不把测试工具或dist纳正式文件。
- `.tmp-tests/esc-final-archive/source-comparison.json`确认1430份源／配置无变化，37项中只有README／07／08的metadata哈希变化；01～06及全部28份非文档正式文件不变。
- Chromium复用修后`.tmp-tests/browser-e2e/evidence/agent-queue-oQYzPB/result.json`：19个assertions全true、passed=true、cleanup.complete=true。`.tmp-tests/esc-final-archive/browser-source-match.json`记录37份历史修复哈希在归档前全部匹配，其中28份非文档正式文件与浏览器修后源树一致；当前1430份全量源before/after另行完全匹配。历史没有1430份全树哈希，不虚构其已覆盖该历史集合；依据已知28份增量源文件匹配且本轮无源修改，不机械重跑浏览器。
- 机器汇总入口：`.tmp-tests/esc-final-archive/delivery-summary.json`；三文档UTF-8、单个EOF换行、无尾随空白、围栏及全部本地链接／锚点检查在`document-checks.json`。本轮临时脚本、日志、JSON、截图及构建dist均不属37份正式变更。

### 16.4 限制与操作偏差披露

真实用户DB升级、真实外部provider联调、人工多端／多标签／断网验收未执行；真实managed Worker／Chromium使用隔离SQLite与loopback fake provider，不能扩称厂商验收。terminal-intent冲突仍是已独立确认的安全拒绝，维持cancelled，不吞日志、不放松终态规则。

保留此前事实披露：上轮空Node脚本误用仓库外日志重定向，可能创建或截断空日志。本轮严格只在项目内执行，未访问、检查、删除或修正该外部路径；不因该旧偏差阻断本次项目内验证，也不声称已检查或清理。作者无Git／stage／commit，交由主助理最终核查与提交。
