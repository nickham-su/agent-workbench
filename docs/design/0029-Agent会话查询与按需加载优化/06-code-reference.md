# 源码引用与影响范围

## 引用约定

以下路径相对项目根 `agent-workbench/`；行号是方案编写时的现状定位，开发后以函数/符号定位为准。下方历史基线表保留用于追踪改造来源，不表示旧符号仍存在；当前实现以“当前实现定位”和 08 为准。不能根据路径含 `/sessions` 就把 POST、timeline 或 internal API 误判为本次列表 GET。

## 当前实现定位（阶段二）

优先按以下符号定位，旧行号不再表示当前实现。

| 文件 | 当前符号 / 状态 |
|---|---|
| `packages/shared/src/contracts/agent.ts` | `AgentTabsSnapshotResponseSchema`、`AgentContinuablePageResponseSchema`、`AgentSessionListResponseSchema` |
| `apps/api/src/infra/db/agent-query-functions.ts`、`db.ts` | `registerAgentQueryFunctions`；生产 `openDb` 注册 JS trim |
| `apps/api/src/modules/agent/read-side/session-list-query.ts` | `parseSessionListQuery`、`decodeSessionCursor`、`encodeSessionCursor` |
| 同目录 `sqlite-session-query.ts` | `SqliteSessionQuery.listSessions` / `getSession`、三个 SQL 常量；真实读事务 |
| `apps/api/src/modules/agent/agent.composition.ts`、`agent.service.ts` | 窄 query capability `listSessionRecords`；旧内部 `listSessions` 不作为公开无 scope 分支 |
| `apps/api/src/modules/agent/routes/agent-public.routes.ts`、`agent-route-types.ts` | `GET /api/agent/sessions` 必选 scope，raw URL 参数校验 |
| `apps/web/src/shared/api/api.ts` | `getAgentTabsSnapshot`、`getAgentContinuableSessions`；移除 `listAgentSessions` 和无人消费的 Tab GET wrapper |
| `apps/web/src/features/workspace/tools/agent/AgentToolView.vue` | `isSessionTabVisible`统一渲染/编号；`onDeactivated`关闭picker；`cancelPickerSelection`独立补偿receipt；snapshot/cache/成员与页分离 |
| 同目录 `agentSessionTabVisibilityState.ts` | `isSnapshotProtected`、`applyInitializationSnapshot`；只传snapshot成员；`invalidateContext`统一释放sessions/writeStates/receipts与内部epoch |
| 同目录 `useAgentSessionStatusStore.ts` | `persistIndicators` / `restoreIndicators` / `pruneEntries`；workspaceGeneration＋entry身份保护refreshSessionNow/settings及迟到音频回调，保留unknown历史提醒 |
| 同目录 `agentSessionTargetLoader.ts`、`agentSessionTitle.ts` | 完整 record 协议检查、阶段一目标加载与 title-only 保护；删除 obsolete 全量合并 helper |
| `apps/api/scripts/benchmark-agent-session-queries.ts` | 合成性能基准；复用独立 `session-list-query.testkit.ts`，不导入测试文件 |

测试：`session-list-query.test.ts`、`sqlite-session-list-query.test.ts`、`agent-session-metadata.integration.test.ts`、`agent-session-title.integration.test.ts`、`AgentToolView.component.test.ts`、`agentSessionTabVisibilityState.test.ts`、`agentSessionTitle.test.ts`。组件runner登记新增 `useAgentSessionStatusStore.component.test.ts`；扩展ToolView和controller实际边界测试。

已删除：`agentSessionRefreshCoordination.ts`、其 `.test.ts`、`agentSessionRefreshTimeline.test.ts`。对应全量刷新方案不再存在，不是跳过仍有效的测试。

## 历史基线：Web 直接调用与交互

| 文件/当前行号 | 符号或内容 | 本次用途 |
|---|---|---|
| `apps/web/src/shared/api/api.ts:1058-1066` | listAgentSessions | 现状workspace参数、裸数组；阶段二改scope契约及明确wrapper |
| 同上 `1069-1091` | getWorkspaceAgentTabState / setWorkspaceAgentSessionTabVisibility | 初始化移除独立GET；PUT保留并窄配置15秒timeout |
| 同上 `137,171-184` | axios.create / toApiError | 实例无timeout，转换只保留response data.code；窄wrapper必须先识别Axios timeout，不改全局 |
| 同上 `1153-1170` | getAgentTimeline | options仅signal，保持timeline传输/HTTP响应契约，不误加metadata 15秒 |
| `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:772-849` | refreshSessions | 列表刷新、全量保护及补刷新；阶段一移除单目标消费者，阶段二取消生产全量路径 |
| 同上 `1214-1247` | initializeWorkspace | 现状Promise.all双GET和共同提交；不是后端一致性事务 |
| 同上 `1260-1299` | retryInitialization / workspace watcher | 重试和workspaceGeneration清理 |
| 同上 `1303-1326` | openSessionRequest watcher | 外部意图等待ready后全量刷新；改target load |
| 同上 `1329-1342` | onActivated | 正常KeepAlive不重读；error态重试 |
| 同上 `1036-1044` | onSessionForked | 仅ID事件后refreshSessions；改完整record局部upsert |
| 同上 `1047-1059` | onOpenSubtask | 本地未加载时全量刷新；改target load |
| 同上 `1072-1110` | onOpenParent | 本地目标乐观激活并全量核实/未加载先全量查；来源关闭时序需改 |
| 同上 `995-1015` | requestSessionVisibility / closeSessionTab | 先从serverSessions找record；关闭仅隐藏 |
| 同上 `860-875` | onSessionMetadataUpdated / requestSessionTitleSync | timeline现为裸record合并title；改发起token门禁、水位保留，过期标题零dirty |
| 同上 `1359-1388` | 自动标题完成watch | idle后全量刷新及失败恢复；改目标级事件消费与失败停止 |
| 同上 `576-596,927-941` | 标题成功/创建成功的局部更新 | 已有完整record更新材料，保留并共用upsert保护 |
| 同上 `471-475` | canChooseSessionFrom | 现状按钮依赖本地primary存在；阶段二改为草稿条件 |
| 同上 `1147-1177` | openChooseSessionModal | 当前候选资格/排序，无API查询；迁至后端分页 |
| 同上 `97-121` | chooseSessionItems的a-list | 最大360px滚动容器，不是分页 |
| `apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.vue:317-320` | openSession | 当前列表存在性预校验；改为直接host打开意图 |
| 同上 `75,89,134` | 查看Session/上下文入口 | execution保留sessionAvailable；来源上下文单独入口 |
| `apps/web/src/features/workspace/views/WorkspaceLayout.vue:743-747,1010-1012` | host agent openSession中转 / openSessionRequest | 保留意图中转与sequence，需要验证workspace/连续操作隔离 |

方案编写时的三处列表函数调用位于 AgentToolView `786、1226` 和 ScheduledTasksToolView `318`。弹窗不是第四处直接调用。

## 历史基线：缓存、可见性与提醒

| 文件/当前行号 | 符号或现状 | 需要改写的假设 |
|---|---|---|
| `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:322-343` | allSessions / visibleSessions | 当前serverSessions+drafts再按controller过滤；目标cache不再完整，需独立可见成员集合 |
| 同上 `358-406` | reconcileTabNoMap相关 | 为可见会话分配编号；保留已有编号业务 |
| 同上 `713-717` | refreshVisibleSessionModelStates | 仅可见primary加载模型，不能因picker页批量加载 |
| 同上 `768-770` | refreshTabVisibilitySessions | 对全量列表pruneSettledStates；阶段二删除该缺失剪枝调用 |
| 同上 `1345-1354` | statusStore.syncSessions watcher | 以serverSessions作为registered全集；改已知metadata集合 |
| `apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts:30-50,54-55,87-112` | SessionWriteState / options / snapshot | 新增本地confirmationEpoch/uncertainCommit；snapshot捕获发起时未决集合，既保护之前PUT也保护之后动作 |
| 同上 `132-146,166-174` | requestVisibility / ensureState | 现为boolean接受/notify/pump，未提供结果订阅；需atomic注册的WithResult窄入口，保留普通入口 |
| 同上 `178-224` | pump | 真实HTTP、匹配确认、较新意图补偿、最终onMutationError；添加epoch与一次结算控制点，UIwatchdog不清真实inFlight |
| `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:301-319` | provide statusStore / controller options | 按既有provide方式加入metadata read context；onMutationError现为二参，不改为status union |
| `apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts:117-126` | pruneSettledStates | 当前列表缺失删除确认状态，不能用于partial结果 |
| `apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts:72-74` | storageKey | 原workspace分组key保留 |
| 同上 `177-211` | persistIndicators / restoreIndicators | 当前只持久registered entries；改保留未知ID的合并写入 |
| 同上 `261-279` | pruneEntries | 当前删除缺失entry/提醒；改运行态与持久数据分离 |
| 同上 `417-440` | 可见/活动会话poll安排 | 不把保存未知提醒变成全历史轮询 |
| 同上 `475-509` | syncSessions | registered替换＋ready剪枝；语义需改 |
| `apps/web/src/features/workspace/tools/agent/agentSessionTitle.ts:46-110` | mergeStaleProtectedSessionList / mergeTimelineSessionTitle | 复用本地mutation保护；timeline title-only，不把partial缺失按原全量规则处理 |
| `apps/web/src/features/workspace/tools/agent/agentForkSessionAction.ts:3-16` | runAgentSessionForkAction | 当前Promise<{id}>/onForked(string)丢弃其余字段；改完整record |
| `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:594,600,1132-1142` | forked / session-metadata-updated事件类型、onFork | Fork完整record；metadata事件改TimelineMetadataEvent(session+readToken)，同步父handler与组件fixture |
| 同上 `863-905,949-959` | loadTimeline / scheduler入口 | 真正GET在884，紧邻调用前从父context捕获token；先沿原scope/epoch/sequence接受正文，再独立title-only事件，不在响应时捕获 |
| 同上 `461-467,695,1864-1881` | agentTimelineController requestScope、workspace/session切换 | 正文隔离规则保留，不用metadata拒绝结果抹掉正文/轮询 |
| `apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts:70,615-624` | InjectionKey / use/install helper | 参考窄上下文注入形态；拟新增agentSessionMetadataReadContext.ts目前不存在，需测试提供同一实例 |

## API 与数据库

| 文件/当前行号 | 符号或内容 | 设计关联 |
|---|---|---|
| `packages/shared/src/contracts/agent.ts:123-136` | AgentSessionRecordSchema | 11字段完整metadata，不额外拆summary |
| `packages/shared/src/contracts/workspaces.ts:40-44` | WorkspaceAgentTabStateSchema | closed/opened例外集合 |
| `apps/api/src/modules/agent/routes/agent-public.routes.ts:340-356` | GET列表route | 现状workspace必选/裸数组；改scope与response union |
| 同上 `446-475,505-527` | 创建/手动标题/Fork routes | 已返回完整record，可直接局部更新 |
| 同上 `360-380,531-560,666-682` | run-state/timeline/model-overrides GET | 不能借重接口代替轻量metadata查询 |
| `apps/api/src/modules/agent/agent.service.ts:14-23` | listSessions / getSession facade | 新窄只读方法沿现有能力注入；不要误改内部getSession语义 |
| `apps/api/src/modules/agent/agent.composition.ts:2031-2043,3257-3259` | listSessions / getSession(sessionId) / runtime narrow getSession | 现有内部getSession按ID供其他运行时使用，不等于带workspace鉴权的公开GET |
| `apps/api/src/modules/agent/session/session-interaction-application.ts:21-23,342-344` | listSessions / assertWorkspace | 现状验证workspace存在；目标read-side沿用只读生命周期 |
| `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts:29-31` | getSession / listSessions | 委派agent-message.store，现状全量 |
| `apps/api/src/modules/agent/agent-message.store.ts:210,401-408` | sessionRow / getMessageSession / getMessageSessionById / listMessageSessions | 可复用workspace+ID元数据SQL映射；列表现状无LIMIT |
| 同上 `388-396,821-835` | 创建默认head / revert head | head null不代表历史消息不存在；不能改资格为message count |
| 同上 `1767-1778` | updateAutoMessageSessionTitle / setManualMessageSessionTitle | 自动标题改updatedAt；手动标题不改updatedAt，revision不是标题版本 |
| `apps/api/src/modules/agent/read-side/sqlite-message-query.ts:368-377` | requireSession | 已有workspace+ID归属校验模式，跨workspace404 |
| `apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts:38-58` | listEffectiveWorkspaceSessionTabStateOverrides | join同时验证ID与workspace、忽略无意义覆盖；snapshot复用规则 |
| `apps/api/src/modules/workspaces/workspace.service.ts:212-248` | getWorkspaceAgentTabState / setWorkspaceAgentSessionTabVisibility | GET只读存在性、PUT生命周期门禁与归属；不盲目删service |
| `apps/api/src/modules/workspaces/workspaces.routes.ts:76-91` | Tab state GET / PUT | PUT保留，GET按其他消费者与测试用途决定保留 |
| `apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts:57-68` | toScheduledExecution.sessionAvailable | 更强的request/Run归属判断，必须保留 |
| 同上 `283-307,311-334` | listScheduledTasks / listExecutions分页 | 可参考limit+1/keyset形态，不复用其签名/重启失效语义 |
| `apps/api/src/infra/db/db.ts:9-35` | openDb | better-sqlite3连接、WAL、schema初始化；向服务暴露前注册函数 |
| `apps/api/src/infra/db/schema.ts:314-320,800-817` | Tab覆盖表 / agent_session及workspace_updated索引 | 默认无表迁移，先测现有索引 |
| 同上 `491,719-735,1110-1129` | schema对象识别 / strict分类 / additive analytics indexes | 不能为普通索引提高Agent schema版本导致历史重建 |
| `apps/api/src/app/auth.ts:7-12,21-51` | registerAuthGuards | 沿用Web cookie鉴权，不绕过/不用internal权限 |

## 测试影响与建议新增覆盖

| 现有位置 | 现有用途/改造要求 |
|---|---|
| `apps/web/src/features/workspace/tools/agent/AgentToolView.component.test.ts:115-116,194-253` | 初始化双读、外部跳转全量刷新；阶段二改single snapshot＋target，matcher必须区分scope/ID，不能所有包含sessions的GET返回数组 |
| 同上 `265-392` 及后续 | 初始化失败/重试、workspace切换、KeepAlive/可见性场景；保留门控并扩并发 |
| `agentForkSessionAction.test.ts`（同目录） | 当前ID事件；改record传递和无额外GET |
| `agentSessionTitle.test.ts:92-114`（同目录） | title-only和保护纯函数；新增目标GET、snapshot的保护和dirty收敛测试 |
| `agentSessionRefreshCoordination.test.ts` / `agentSessionRefreshTimeline.test.ts`（同目录） | 当前全量刷新协调抽象；替换或删除过时测试，不保留全量runtime实现只为通过测试 |
| `agentSessionTabVisibilityState.test.ts:44-54`（同目录） | 现有harness以deferred控制request、二参onMutationError；新增一次订阅、同向superseded、snapshot前在途open/close与超时回滚 |
| `AgentClientPane.component.test.ts`（同目录） | Fork/timeline事件和scope隔离，与helper类型同步 |
| `apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.component.test.ts:22-54,102-114` | 执行状态和按钮门禁；新增直接host意图、无预校验网络、来源入口 |
| `AgentClientPane.component.test.ts` / `AgentToolView.component.test.ts`（Agent目录） | 增加T发起→manual→新GET清保护→T返回，事件context/token与正文接受独立；不能只测纯title helper |
| 本次拟新增/扩展loader、picker、API wrapper测试 | 控制计时器验证15秒实际timeout、30秒UI deadline、2次GET上限、槽位/订阅清理；fake XHR须实现timeout事件而非靠sleep |
| `apps/api/src/modules/agent/integration/agent-session-title.integration.test.ts:112,140,162,214,242,289,306,318,325,386,406` | 旧无scope列表GET验证标题；单record核实转新target GET，真正列表语义转指定scope |
| `apps/api/src/modules/agent/agent.service.facade.test.ts:140-155` | 旧listSessions委派；同步新窄查询能力与参数 |
| `apps/api/src/modules/agent/session/session-interaction-application.test.ts:52-54` | Store mock契约，调整scope职责影响 |
| `apps/api/src/modules/workspaces/workspace-session-tab-state.integration.test.ts` | 原GET/PUT及OpenAPI契约；PUT不变，保留GET不影响初始化减少请求 |
| `apps/api/src/infra/db/schema.test.ts` | 新/旧库、严格schema升级；函数fixture和可选索引数据保留 |

建议新增窄 target loader/metadata保护/picker状态机/status store持久合并测试，以及后端session查询集成测试。当前未发现 `useAgentSessionStatusStore.test.ts` 同名文件，不把建议新增写成已有。

全项目复核搜索关键符号 `listAgentSessions`、`getWorkspaceAgentTabState`、`refreshSessions`、`/api/agent/sessions?workspaceId=`；区分GET和POST。此轮静态检索未发现 worker/packages/scripts 中其他生产GET列表客户端，但开发修改时仍需重新检索，不以本表替代最终调用扫描。

## 可执行验证入口

以下是现有 package scripts，实际执行属于开发/验收阶段，本次文档编写未运行产品测试：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm test -w apps/web
npm run typecheck
npm test
```

新增后端测试需满足 `apps/api/scripts/verify-test-gate.mjs` 的既有测试门禁；不要只在本地直接跑一个新文件却漏入标准测试集。根级typecheck/test涉及其他workspace，是最终回归而非替代本次矩阵的定向验证。
