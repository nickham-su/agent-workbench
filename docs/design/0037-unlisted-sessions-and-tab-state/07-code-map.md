# 当前代码证据与影响入口

## 使用说明

- 以下均为编写时实际读取的当前源码事实，不代表新功能已经实现。行号在后续实施中可能移动，应同时按符号定位。
- 代码链接相对本目录指向仓库内文件；影响结论以本目录其他权威设计为准。
- 当前不存在 visibility、全量 Tab 实际状态或定时输出隐藏策略；不能引用设计字段证明既有行为。

## 数据、契约与启动

| 当前事实 | 代码证据 | 本次影响 |
| --- | --- | --- |
| kind 仅 primary／subtask | [agent-primitives.ts:5](../../../packages/shared/src/contracts/agent-primitives.ts#L5) | 不增第三种执行角色 |
| Session 响应没有 visibility | [agent.ts:124](../../../packages/shared/src/contracts/agent.ts#L124) | 新增必填枚举及所有投影 |
| Fork 消息 ID 必填，title 是 API 可选字段 | [agent.ts:382](../../../packages/shared/src/contracts/agent.ts#L382) | 新增可选 visibility，不改选点契约 |
| 内部 Session 契约重导出公共契约 | [agent-api-session.ts:7](../../../packages/shared/src/internal-contracts/agent-api-session.ts#L7) | 同步构建内部消费者 |
| Tab 响应仅 closed／openedSubtask 数组 | [workspaces.ts:40](../../../packages/shared/src/contracts/workspaces.ts#L40) | 新增 openedSessionIds 权威投影 |
| Tab 表只有 Workspace 外键，visible 限 0／1 | [schema.ts:338](../../../apps/api/src/infra/db/schema.ts#L338) | 复用表，生命周期补齐状态清理 |
| 当前 schema 版本为23，目标列数组有序，hasExactColumns 逐位置比较 | [schema.ts:8](../../../apps/api/src/infra/db/schema.ts#L8)、[有序列数组:572](../../../apps/api/src/infra/db/schema.ts#L572)、[比较:606](../../../apps/api/src/infra/db/schema.ts#L606) | visibility 在 updated_at 后追加，新建 DDL／TARGET 数组／升级结果一致 |
| 合法旧白名单版本返回 rebuildable | [schema.ts:816](../../../apps/api/src/infra/db/schema.ts#L816) | 禁止将23直接纳入该分支 |
| rebuild 关闭外键并重建 Agent 域 | [schema.ts:869](../../../apps/api/src/infra/db/schema.ts#L869) | 无损迁移不得调用 |
| Agent Session 原末列为 updated_at，没有 visibility | [schema.ts:898](../../../apps/api/src/infra/db/schema.ts#L898) | 原末尾追加，验证 NOT NULL／默认／CHECK，不只检查当前值 |
| init 当前会根据分类选择重建 | [schema.ts:1226](../../../apps/api/src/infra/db/schema.ts#L1226) | 专用迁移必须在这里接入 |
| openDb 先 assert 再 init，原 pending 决定文件清理 | [db.ts:17](../../../apps/api/src/infra/db/db.ts#L17) | 分类需允许安全升级；区分新增清理与既有续作 |
| 清理会处理旧归档／工具产物目录 | [agent-destructive-upgrade-files.ts:58](../../../apps/api/src/infra/db/agent-destructive-upgrade-files.ts#L58) | 正常 pending=0 升级不能触发；不弱化原安全路径 |

## Session 创建、派生、复用与删除

| 当前入口／事实 | 代码证据 | 必须处理 |
| --- | --- | --- |
| SessionRow／toSession／sessionRow 有独立投影 | [agent-message.store.ts:153](../../../apps/api/src/modules/agent/agent-message.store.ts#L153)、[toSession:182](../../../apps/api/src/modules/agent/agent-message.store.ts#L182)、[sessionRow:212](../../../apps/api/src/modules/agent/agent-message.store.ts#L212) | visibility 不能只加 schema 不加读取 |
| 普通创建事务插入 Session＋RunState | [createMessageSession:391](../../../apps/api/src/modules/agent/agent-message.store.ts#L391) | 同事务初始 Tab、隐藏策略 |
| 公开／resolved Fork 事务直接插入 | [forkMessageSession:959](../../../apps/api/src/modules/agent/agent-message.store.ts#L959) | 另一生产 SQL 落点，不能遗漏 |
| 内部稳定 Fork 读取来源并复用普通创建 | [forkStableSourceSession:1006](../../../apps/api/src/modules/agent/agent-message.store.ts#L1006) | 显式内容来源与执行父都传递 |
| 历史来源不依赖当前 head，验证归属及图 | [historicalForkAnchor:1046](../../../apps/api/src/modules/agent/agent-message.store.ts#L1046) | 保留固定锚点，不禁隐藏来源 |
| 历史 Fork expected-ID 匹配后直接返回 | [forkHistoricalMessageSession:1116](../../../apps/api/src/modules/agent/agent-message.store.ts#L1116) | 比较 visibility，不重置 visible |
| 普通预分配创建有 matching 及竞争重查 | [session-interaction-application.ts:31](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L31) | 同步身份字段与回放行为 |
| 公开 Fork 固定生成 primary | [session-interaction-application.ts:134](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L134) | 保留角色，增加可见性意图 |
| 子任务 existing 只校验存在、Workspace、kind | [物化:277](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L277) | 补 hidden→listed 复用拒绝 |
| 子任务 new、显式源 Fork、摘要／无边界及 resolved 分支 | [new:290](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L290)、[显式源:300](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L300)、[降级:321](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L321)、[resolved:333](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L333) | 每条路径传递真实策略身份 |
| Store 包装已有同 Db 嵌套事务 | [sqlite-session-interaction-store.ts:33](../../../apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts#L33) | 可用既有同步事务，不需跨服务协调 |
| child Run 已有结果可绕过物化直接返回 | [subtask-application.ts:199](../../../apps/api/src/modules/agent/subtask/subtask-application.ts#L199) | 不能只改物化入口 |
| 并发 winner 再绑定来源并重用 | [subtask-application.ts:342](../../../apps/api/src/modules/agent/subtask/subtask-application.ts#L342) | 同步复用判定，无 loser 越界删除 |
| existing 校验使用独立 RunQuery Session 投影 | [ensureExistingSessionMatches:486](../../../apps/api/src/modules/agent/subtask/subtask-application.ts#L486)、[sqlite-subtask-run-query.ts:25](../../../apps/api/src/modules/agent/subtask/sqlite-subtask-run-query.ts#L25) | 增 visibility，覆盖快捷返回 |
| 创建失败补偿及空子任务删除各有安全围栏 | [maintenance:22](../../../apps/api/src/modules/agent/subtask/sqlite-subtask-maintenance-persistence.ts#L22)、[回收:124](../../../apps/api/src/modules/agent/subtask/sqlite-subtask-maintenance-persistence.ts#L124) | 成功删除时原子清理 Tab；共享消息不删 |
| 工作区最终事务删除 Agent 数据及 Workspace | [workspace.service.ts:692](../../../apps/api/src/modules/workspaces/workspace.service.ts#L692) | 保留 drain 与原子边界，Tab 外键级联 |

## 读取、展示状态与事件

| 当前事实 | 代码证据 | 本次影响 |
| --- | --- | --- |
| tabs 默认 primary，continuable 单独条件 | [sqlite-session-query.ts:12](../../../apps/api/src/modules/agent/read-side/sqlite-session-query.ts#L12) | tabs 改查实际状态；continuable 过滤 listed |
| 按 ID 获取只校验归属／存在 | [sqlite-session-query.ts:30](../../../apps/api/src/modules/agent/read-side/sqlite-session-query.ts#L30) | 保留，不因隐藏404 |
| tabs 同时返回 items 和覆盖数组 | [sqlite-session-query.ts:39](../../../apps/api/src/modules/agent/read-side/sqlite-session-query.ts#L39) | 同事务生成 opened 集合与兼容投影 |
| 活动查询候选、状态验证及计数分离 | [候选:12](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts#L12)、[验证:51](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts#L51)、[计数:76](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts#L76) | 同一 listed 条件，不隐藏损坏状态 |
| 跨 Workspace recent 直接排序 limit | [recent:1802](../../../apps/api/src/modules/agent/agent-message.store.ts#L1802)、[路由:125](../../../apps/api/src/modules/agent/routes/agent-peripheral.routes.ts#L125) | 排序取限额前过滤 |
| 旧整个 Workspace 列表仍存在 | [listMessageSessions:409](../../../apps/api/src/modules/agent/agent-message.store.ts#L409)、[应用包装:21](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L21) | 分类调用者，不能伤内部扫描 |
| Tab Store 仅接受 primary关／subtask开覆盖 | [workspace-session-tab-state.store.ts:38](../../../apps/api/src/modules/workspaces/workspace-session-tab-state.store.ts#L38) | 去除按 kind 有效性过滤 |
| Tab 服务按 kind 保存或删除 | [workspace.service.ts:224](../../../apps/api/src/modules/workspaces/workspace.service.ts#L224)、[写:234](../../../apps/api/src/modules/workspaces/workspace.service.ts#L234) | 全量实际 UPDATE，缺行诊断 |
| 独立 Tab GET／PUT 有既有路由 | [workspaces.routes.ts:75](../../../apps/api/src/modules/workspaces/workspaces.routes.ts#L75) | 补 opened 字段及500响应 |
| Fork 有 schema 及额外字段白名单 | [agent-public.routes.ts:555](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L555)、[白名单:5](../../../apps/api/src/modules/agent/routes/agent-route-auth.ts#L5) | 两处同步接受 visibility |
| 内部完成发布到 event hub | [agent.composition.ts:1496](../../../apps/api/src/modules/agent/agent.composition.ts#L1496) | 不在此过滤 |
| 全局 SSE 目前全部转发 | [agent-status-sse.routes.ts:72](../../../apps/api/src/modules/agent/routes/agent-status-sse.routes.ts#L72) | 只在导出边界过滤 |
| Analytics 自行扫描 Session 事实 | [business-collector.ts:88](../../../apps/api/src/modules/analytics/business-collector.ts#L88) | 真实消耗保留，不增加隐藏过滤 |

## 定时任务及激活身份

| 当前事实 | 代码证据 | 本次影响 |
| --- | --- | --- |
| 两种 triggerMode，任务请求无 visibility | [scheduled-tasks.ts:21](../../../packages/shared/src/contracts/scheduled-tasks.ts#L21) | 不新增用户配置 |
| 内部快照类型及 JSON 读取 | [store:15](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts#L15)、[解析:53](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts#L53) | 内部兼容标记及严格解析 |
| sessionAvailable 由请求到 Run 链证明 | [store:57](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts#L57) | 不退化为 exists(Session) |
| 声明事务写不可变快照与预分配 ID | [store:170](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts#L170) | 固定写新标记 |
| reconcile 原 Run 及未知受理 | [service:142](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.service.ts#L142) | 稳定身份校验，不误改历史结果 |
| execute 先 dedup 早返回，再两创建分支 | [service:201](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.service.ts#L201) | 新旧预期与所有捷径覆盖 |
| 激活事务去重先于 pristine 身份检查 | [sqlite-run-lifecycle-persistence.ts:78](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L78) | 正常重放不要求原 head／revision |
| expected historical／title 是内部输入 | [run-lifecycle-ports.ts:128](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts#L128) | 扩展预期 visibility，不加入 visible |
| 启动无受理 starting 收敛为 interrupted-before-run | [service:296](../../../apps/api/src/modules/scheduled-tasks/scheduled-task.service.ts#L296) | 保留，不新增自动重发 |

## 前端与 CLI

| 当前事实 | 代码证据 | 本次影响 |
| --- | --- | --- |
| 前端 Tab 默认仅看 primary | [controller:69](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L69) | 去默认 fallback |
| 快照按旧数组构造 kind 和确认 | [controller:114](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L114) | 统一 opened，保留 epoch 保护 |
| 草稿转换可能按 kind 跳过 PUT | [controller:226](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L226) | 有效上下文内显式提交转换时意图，未确认不保证已关闭 |
| 创建响应上下文失效时直接返回，不迁移草稿 | [AgentToolView:1019](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.vue#L1019) | 保留保护，无新关闭意图／跨组件补偿；初始状态可能后续显示 |
| 控制器拒绝失效上下文的新请求 | [controller:156](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L156) | 不为草稿关闭绕过 generation，失效后不派发补偿 |
| PUT 回调在失效上下文不更新 UI／补偿，未确认标记不确定 | [controller:283](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L283)、[未确认:291](../../../apps/web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.ts#L291) | 提示限有效上下文，unknown 由后续读取协调，不宣称未提交 |
| 定向 GET 校验并写入元信息缓存 | [target loader:25](../../../apps/web/src/features/workspace/tools/agent/agentSessionTargetLoader.ts#L25)、[提交:65](../../../apps/web/src/features/workspace/tools/agent/agentSessionTargetLoader.ts#L65) | 元信息不等于打开，不拒绝 hidden |
| 外部打开普通 Tab 并等 PUT receipt | [AgentToolView:1183](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.vue#L1183) | 复用原链，无专用 viewer |
| 完整快照有缓存／新意图保护 | [AgentToolView:1463](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.vue#L1463) | 同时保护状态与成员资格 |
| 初始化使用 tabs 快照 | [AgentToolView:1503](../../../apps/web/src/features/workspace/tools/agent/AgentToolView.vue#L1503) | required opened 校验 |
| API 分开调用 tabs 和 continuable | [api.ts:1194](../../../apps/web/src/shared/api/api.ts#L1194) | 不混淆发现与恢复 |
| 状态轮询按可见／活动会话 | [status store:438](../../../apps/web/src/features/workspace/tools/agent/useAgentSessionStatusStore.ts#L438) | 显式打开后正常参与 |
| 任务现有导航和30秒刷新 | [任务入口:81](../../../apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.vue#L81)、[openSession:324](../../../apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.vue#L324)、[刷新:331](../../../apps/web/src/features/workspace/tools/scheduled-tasks/ScheduledTasksToolView.vue#L331) | 直接复用，不宣称实时任务列表 |
| Workspace 路由转发打开意图 | [WorkspaceLayout:584](../../../apps/web/src/features/workspace/views/WorkspaceLayout.vue#L584) | 保留 Workspace 上下文 |
| CLI fork 已读取 head 后单 POST | [fork.ts:9](../../../packages/cli/src/fork.ts#L9) | 加 flag／visibility，不改选点 |
| CLI 命令注册及离线 help | [program.ts:119](../../../packages/cli/src/program.ts#L119) | 添加布尔 flag 与说明 |
| CLI Session 手工校验／投影 | [agent-api.ts:146](../../../packages/cli/src/agent-api.ts#L146) | 新枚举校验、输出和响应身份 |

## 审查时的反向清单

- 不得仅改前端 chooser、只过滤 items、在 limit 后过滤、只改 Session 主投影或只在新建时检查复用策略。
- 不得将 hidden 统一404、将所有 Tab 接口过滤 listed、将显式打开转为 listed、把 hidden primary 塞入 openedSubtask 数组。
- 不得保留按 kind 永久默认 fallback、PUT 删除记录、幂等恢复重新初始化 visible。
- 不得让 UI 展示 JOIN 影响 Run 恢复／取消／Analytics，不在内部完成发布处丢掉隐藏事件。
- 不得为了减少迁移代码重建历史、重写旧执行为新策略、误把无 Run 启动恢复变成重新发送。
- 不得把本地草稿关闭等同于服务器关闭确认，不得为“不复活”绕过失效上下文或引入后台补偿。
- 不得把 hasExactColumns 当集合比较，将 visibility 插到 kind 旁，或只凭数据合法就认为 NOT NULL／默认／枚举约束存在。
