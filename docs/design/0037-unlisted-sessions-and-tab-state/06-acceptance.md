# 验收矩阵与审查标准

## 执行和证据规则

- 本表为必须覆盖的场景，不代表已有测试实现。实现阶段逐项记录测试路径／测试名、命令和结果。
- 存储、迁移、事务及 HTTP 必须使用真实 SQLite／Fastify 集成证据；mock 仅用于网络、输出、时序和故障注入。
- 负向场景比较执行前后 Session、TabState、Run、Message、clientRequest 及 enqueue 次数。只断言报错不足以证明无副作用。
- 对“无副作用”允许的例外仅为既有失败诊断和安全删除本请求未使用临时子会话；不能修改原目标、父历史、已受理 Run 或失败互斥位。
- 夹具使用无敏感内容的固定 ID／文本／附件；不使用真实用户提示词或凭证。

## 最小夹具

| 夹具 | 内容 |
| --- | --- |
| FIX-SESSION | 两个 Workspace；listed／unlisted primary，listed／unlisted subtask；完整 RunState 和 TabState；共享父历史 Fork |
| FIX-HISTORY | terminal user／assistant、streaming、completed assistant 带 queued／running 工具、compaction root、空 head、Revert 后脱链边界 |
| FIX-TAB | 已开／已关两种状态，未知前端缓存，草稿，以及可控制 GET／PUT 返回顺序的请求队列 |
| FIX-SCHEDULE | 两种 triggerMode×manual／scheduled；新标记／旧缺省快照；仅预分配、已建 Session、已有 dedup／Run、冲突 Run 链、skipped |
| FIX-V23 | 独立真实 v23 DDL；primary／subtask 与有效开闭覆盖、无记录和旧无效覆盖；两个 Workspace；共享消息链、compaction、图片附件、Run／工具／clientRequest、任务与旧执行 JSON |
| FIX-UPGRADE | FIX-V23 的合法 pending=0／1 两版，损坏结构版，可在每个迁移写步骤抛错的测试边界，两个真实 SQLite 连接 |

## ACC-CREATE：创建和身份（REQ-VIS、REQ-TAB）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-CREATE-DEFAULT | 新建 listed primary／两种 subtask | 每 Session 恰一条 TabState；primary=1，subtask=0；Workspace 匹配 |
| ACC-CREATE-HIDDEN | 显式隐藏 Fork | 201，真实 visibility=unlisted、visible=0；源 Session／Run 不变 |
| ACC-CREATE-ATOMIC | 在 Tab 插入、RunState 插入或事务提交前注入失败 | 三者无半成品，原历史不变，HTTP 按既有 500／基础设施语义失败 |
| ACC-CREATE-REPLAY | 预分配 ID 创建后用户开／关 Tab，再重入 | 合法 pristine 身份复用成功，visible 与用户修改一致；不新增状态行 |
| ACC-CREATE-CONFLICT | 相同预分配 ID，visibility 与预期相反 | 409 SESSION_ID_CONFLICT，不修改目标、不发消息、不 enqueue |
| ACC-CREATE-PROJECTION | 读取全部公开／内部 Session 投影 | visibility 完整且合法，独立 subtask 查询和 CLI 手动投影不丢字段 |

## ACC-DERIVE：派生与复用（REQ-VIS）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-DERIVE-MATRIX | parent／source listed、unlisted 四组合；显式隐藏两值 | 只要任一隐藏，新会话隐藏；均 listed 且未要求隐藏才 listed |
| ACC-DERIVE-PUBLIC | hidden 来源普通 Fork，省略或显式请求 listed | 仍为 unlisted，无提升入口 |
| ACC-DERIVE-PATHS | new、resolved、stable 显式来源、摘要、无边界降级 | 逐路径符合继承；无血缘指针也不丢真实父策略 |
| ACC-DERIVE-SOURCE | 来源缺失／跨 Workspace／图损坏 | 沿用原 400／404／409 映射，不产生会话／Tab／Run，不泄露内部图详情 |
| ACC-DERIVE-EXISTING | hidden 父复用 listed subtask | 409 SUBTASK_SESSION_VISIBILITY_MISMATCH；原目标、消息、Run、dedup、队列不变 |
| ACC-DERIVE-SHORTCUT | 已有 child Run 直接返回和竞争 winner 复用 | 同样检查真实 visibility；不合规不能绕过；合法幂等只返回原结果 |
| ACC-DERIVE-REVERSE | listed 父复用 known hidden subtask | 允许，目标保持 hidden，visible 不被重置 |
| ACC-DERIVE-RACE | 两个启动争同一父工具调用 | 最多一个有效 child Run；loser 只补偿自身安全会话及 Tab，不删 winner／父历史 |

## ACC-DISCOVER：发现与定向读取（REQ-DISCOVER）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-DISCOVER-CHOOSER | hidden 排在 listed 前，查询 continuable 的多页 | 隐藏不占名额，游标／has-more 正确，满足条件的 listed 无遗漏／重复 |
| ACC-DISCOVER-ACTIVITY | kind primary／subtask／all × status idle／running／all | items、total 和原生消息计数均不含 hidden；既有计数定义不改 |
| ACC-DISCOVER-RECENT | 多 Workspace，hidden 最新，limit 小于数据量 | recent 先过滤后取限额，无隐藏 ID／标题 |
| ACC-DISCOVER-OPENED | 显式打开 hidden 后重复普通查询 | 普通查询仍不含它；tabs 包含它 |
| ACC-DISCOVER-DIRECT | known hidden 的元信息、消息、status、send、follow、既有控制 | 通过原有鉴权和状态校验后正常；不因 visibility=unlisted 返回 404／403 |
| ACC-DISCOVER-WORKSPACE | 相同 known ID 配错误 Workspace | 仍按既有 404／错误契约拒绝；隐藏不是跨归属通行证 |
| ACC-DISCOVER-CORRUPT | listed 候选缺 RunState | 保留原 stateInvalid 错误，不因新 JOIN 静默丢弃；内部扫描不被过滤 |

## ACC-EVENT：完成通知（REQ-DISCOVER、REQ-SCOPE）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-EVENT-LISTED | listed 运行完成 | 内部完成及原 SSE 事件格式、一次导出行为不变 |
| ACC-EVENT-HIDDEN | hidden 完成，分别打开／关闭 Tab | 内部完成／event hub 可观察，所有全局 SSE 订阅者均无该事件；Tab 开闭不影响过滤 |
| ACC-EVENT-FAILURE | 导出判断查询失败／真实 Session 不存在 | 该条不导出、固定诊断；Run 仍完成，后续正常 listed 事件可继续 |
| ACC-EVENT-DIRECT | 过滤全局 SSE 后 CLI follow／任务 reconcile | 两者仍观察正确终态，不依赖全局事件 |

## ACC-TAB：实际持久化状态（REQ-TAB）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-TAB-UPDATE | listed／unlisted primary、subtask 逐一反复开关 | UPDATE 实际布尔值；行不删除，kind／visibility 不变，刷新结果一致 |
| ACC-TAB-SNAPSHOT | GET tabs 和独立状态接口 | opened 集合相同；tabs items ID 集合等于 opened，包含已打开 hidden |
| ACC-TAB-COMPAT | 同时读取新旧状态字段 | 兼容字段严格按实体文档投影；关闭 hidden ID 不被数组泄露 |
| ACC-TAB-MISSING | 删除某真实 Session 的 Tab 行，再 GET／PUT | 500 AGENT_TAB_STATE_INVALID，无自动补行或 kind fallback；按 ID 非 Tab 读及已有执行恢复仍可用 |
| ACC-TAB-OWNERSHIP | 错 Workspace PUT、orphan／跨归属状态夹具 | 404 或相应不变量诊断，不更新其他 Workspace；错误响应不含私有数据 |
| ACC-TAB-DELETE | 安全子任务补偿／回收、条件不满足、删除中注入失败 | 成功时 Session＋Tab 同时删除；未删 Session 时状态保留；失败整体回滚 |
| ACC-TAB-WORKSPACE | 工作区删除及受控 Agent 域清空 | 相关 Tab 不残留，既有删除围栏／drain 不变；v23 增量从未调用 Agent 清空 |
| ACC-TAB-RUN | running Session 开／关 | 不新增／取消 Run，不修改业务状态；同值 PUT 成功且幂等 |

## ACC-WEB：界面与时序（REQ-TAB、REQ-SCHEDULE）

| 场景 | 可控步骤 | 必须结果与断言 |
| --- | --- | --- |
| ACC-WEB-FLOW | hidden 创建→任务查看且打开确认→刷新→关闭确认→刷新 | 初始不出现；普通 Tab 打开；刷新保留；无后续打开写入时，关闭确认后不出现；chooser 始终无它 |
| ACC-WEB-SNAPSHOT | 请求快照后完成 open／close PUT，再返回旧快照 | 较新确认和成员资格均保留，不能只保护值却隐藏 Tab |
| ACC-WEB-PENDING | 快照返回时仍有 desired／inFlight，随后最后请求确认 | 不覆盖用户意图，单飞队列继续，确认后与最后意图一致；未确认不提前宣称已持久化 |
| ACC-WEB-NEWCACHE | 快照发出后新增按 ID 缓存／真实创建响应 | 旧快照遗漏不安装 confirmed=false、不删除会话；未知不是默认开／关 |
| ACC-WEB-FAST | 同一目标开→关→开，调换失败返回时序 | 最后意图胜出，旧失败不回退新确认；每目标 single-flight |
| ACC-WEB-TIMEOUT | 普通开／关 PUT 的服务端提交前、提交后分别丢失响应 | 有效上下文提示未确认，保留 uncertainCommit；不声称已打开／关闭，后续完整读取按真实状态协调；不重复创建／增加补偿请求 |
| ACC-WEB-CONTEXT | A→B Workspace，A 的 GET／PUT 后到；连续打开两个目标；销毁组件 | A 不污染 B、不激活旧目标、不关闭新来源；失效后无新意图／补偿／旧错误提示，不撤销或猜测失效前请求的提交结果 |
| ACC-WEB-DRAFT | 延迟普通 listed primary 创建响应；有效上下文中草稿显隐两态转真实 ID，先挂起 PUT | 无草稿服务端行；创建真实 Session 恰一次；转换提交相应 visible；创建成功但 PUT 尚未确认时不宣称服务器已关闭，初始状态仍可为1 |
| ACC-WEB-DRAFT-CLOSE | 创建中关闭草稿，创建返回时上下文有效，关闭 PUT 成功，再返回更早快照并刷新 | 只提交真实 ID 的 visible=false，确认和成员保护有效；无后续打开写入时刷新不出现，不重新创建 Session |
| ACC-WEB-DRAFT-FAILURE | 创建中关闭草稿，创建成功后关闭 PUT 明确拒绝且未提交，再加载 Tab | 有效上下文提示关闭失败，不宣称持久化 false；只创建一次，读取仍可显示初始 visible=1；不自动重复创建或后台补偿 |
| ACC-WEB-DRAFT-UNKNOWN | 创建成功后关闭 PUT 在服务端提交前／后分别超时，再作有效读取 | 提示未确认，不安装虚假关闭确认；两种真实状态分别协调为开／关，允许未提交时刷新出现；仅原创建及原 PUT，无新增创建／后台补偿 |
| ACC-WEB-DRAFT-INVALIDATED | 创建中关闭草稿，创建响应前分别切 Workspace／销毁组件；另测关闭 PUT 发出后失效 | 前者真实 Session 初始 visible=1 保留且可在后续加载显示；无草稿迁移／新 Session 登记激活／关闭 PUT／补偿／旧界面提示。后者已发 PUT 可提交但旧回调不更新新上下文、不再发补偿 |
| ACC-WEB-INVALID | 非法 opened 集合／items 不一致／缺 visibility | 初始化失败而非空列表；mutation 身份不符不得确认 |
| ACC-WEB-SHARED | 客户端一打开 hidden，客户端二重新加载 | 二按共享状态显示；不承诺浏览器私有，visibility 仍 hidden |
| ACC-WEB-INTERACTION | 在 hidden 普通 Tab 查看、发送、工具详情、关闭运行中 Tab | 既有交互可用；关闭不取消，提示／轮询按当前显式可见规则 |

## ACC-SCHEDULE：两模式及恢复（REQ-SCHEDULE）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-SCHEDULE-MODES | new_session／fork_message × manual／scheduled | 新声明快照含内部标记，执行会话 hidden、Tab=0；无用户配置／新任务配置列 |
| ACC-SCHEDULE-ANCHOR | 来源新增／Revert 后执行固定历史锚点 | 保留既有 historical anchor 规则，不变成 GET 最新；listed／known hidden 来源都允许 |
| ACC-SCHEDULE-OLD | 旧缺省快照合法重入 execute，分别无 Session／已有 pristine Session | 使用 listed 预期，保留已有 Tab 修改；不误报 visibility 冲突，不新增启动重发 |
| ACC-SCHEDULE-DEDUP | 旧／新执行已有 Run／dedup，运行后 Session 非 pristine | 仅验证稳定身份并 reconcile，enqueue／message 不增加，结果绑定原 runID |
| ACC-SCHEDULE-ID | 预分配 ID 被相反 visibility 或 unrelated Session 占用 | 无受理时 session_id_conflict，不能更改目标，sessionAvailable=false |
| ACC-SCHEDULE-UNKNOWN | 入队未知、dedup 查询失败、Run 引用冲突 | 保留现有 unresolved／互斥，不误认失败释放，不重发 |
| ACC-SCHEDULE-STARTUP | starting 无 runID、无受理且非 unresolved，启动恢复 | 沿用 startup_interrupted_before_run；有受理按原机制收敛，不自动重发 |
| ACC-SCHEDULE-BADSNAPSHOT | 标记 null／listed／非法类型，非法 JSON；另有正常活跃执行 | 无 dispatch、固定错误且无快照泄露；坏执行不被猜为终态，其他执行仍可收敛 |
| ACC-SCHEDULE-NAV | skipped、仅预分配、启动失败无受理、已受理失败／运行／完成 | 按真实 sessionAvailable 控制入口；预分配不等于可打开，每历史行打开自己的会话 |
| ACC-SCHEDULE-LATER | 用户在执行会话继续普通对话产生新 Run | 原执行状态不跟随最新 Run，历史结果不变 |
| ACC-SCHEDULE-DELETE | 删除任务 | 现有任务／执行历史删除语义不变，Session／Run／Tab 保留，不新增 TTL |

## ACC-CLI：命令与受理（REQ-CLI）

| 场景 | 操作 | 必须结果与断言 |
| --- | --- | --- |
| ACC-CLI-FLAG | 有／无 --unlisted，来源 listed／hidden | 请求字段和继承结果正确；输出新 ID、边界及最终 visibility |
| ACC-CLI-HELP | 离线 help、缺参、多余参数、flag 带值 | help 无联网；错误沿用参数退出码且不发请求；不暴露 messageID／title |
| ACC-CLI-HEAD | GET 后追加／Revert，空 head、subtask、streaming、工具未完、compaction | 仍用已读 head；原 400／409 等拒绝不回退、不等待、不重试，空／非 primary 本地不发 POST |
| ACC-CLI-UNKNOWN | POST 已受理但网络失败，或响应身份／visibility 错误 | 只一次 POST；保留 unknown，不伪装未发送或重试创建 |
| ACC-CLI-ACCEPTED | 成功响应后保存或 stdout 失败 | 保留 accepted、新 Session ID 和边界，不能用源 ID 覆盖 |
| ACC-CLI-DIRECT | 普通 list 与 known hidden 的 show/send/messages/status/follow | list 隐藏；直接操作合法，原自然语言和输出完整性规则不变 |

## ACC-MIGRATE：无损升级（REQ-MIGRATE）

| 场景 | 最小证据 | 必须结果与断言 |
| --- | --- | --- |
| ACC-MIGRATE-REAL | FIX-V23 经真实 openDb 升级 | 版本24、历史可读，消息共享关系、附件／Run／工具／dedup／任务旧 JSON 保留，旧 Session listed |
| ACC-MIGRATE-STRUCTURE | 同时构造全新 v24 与真实 v23 升级库，读取 PRAGMA 列属性并运行受控语义探针 | 有序列名、类型、非空、默认值及约束语义一致；visibility 都在原 updated_at 后；缺省为 listed，null／非法枚举拒绝，不仅核对现有数据值 |
| ACC-MIGRATE-REOPEN | 两种合法库分别 close/reopen，重复启动并监视迁移／重建／回填调用 | 均分类为 current，不重复迁移／重建／回填；Tab 修改和历史保留，不以放宽逐位置校验或重建表通过 |
| ACC-MIGRATE-TABS | 四类 kind／旧有效覆盖、无记录、无效／跨归属／orphan | 原有效开闭结果不变，每真实 Session 一行；无 orphan／归属错误复活 |
| ACC-MIGRATE-ROLLBACK | DDL、回填、校验、版本更新各边界注入失败 | 完整 v23 可再次打开；无新列／半回填，业务数据及版本／cleanup 标记原样 |
| ACC-MIGRATE-VERSION | 单改版本／损坏列／相同列名但列序错误／缺 NOT NULL、默认或枚举 CHECK／FTS／非法目标结构 | 即使当前值全合法也 fail closed，不落入 rebuild，不调用清理，不修改用户数据 |
| ACC-MIGRATE-REPEAT | v24 启动后用户改变 Tab，再重复启动 | 不重新回填或初始化，visible 保持用户值 |
| ACC-MIGRATE-CONCURRENT | 两个真实新连接同时尝试迁移 | 一个提交，另一个重验 current；锁超时仅基础设施失败，无重建／重复初始化 |
| ACC-MIGRATE-PENDING | schema 迁移层 pending=0／1；openDb pending=0 | 迁移不改原标记；正常升级无文件清理调用；原 pending=1 的旧清理续作另测，不误称全启动绝不清理 |
| ACC-MIGRATE-NEW | 全新空数据目录 | 直接合法 v24；后续所有创建都有实际 Tab 行 |
| ACC-MIGRATE-OLDPROCESS | 旧版本启动读 v24；部署演练 | 旧启动拒绝；文档明确已打开旧进程不会自动停止，必须停机整体升级 |
| ACC-MIGRATE-UIBOUNDARY | v24 人为缺 Tab 行但 Session／Run 完整 | 展示接口诊断；非 Tab Session 读和原恢复可执行，不用数据损坏触发重建 |
| ACC-MIGRATE-BACKUP | 隔离备份／回退演练 | 使用同时间点 DB＋数据；不手改版本号，不覆盖真实库演练 |

## ACC-REGRESSION：原行为和范围（REQ-SCOPE）

| 场景 | 必须保持 |
| --- | --- |
| ACC-REGRESSION-LISTED | listed 普通创建、标题、选择会话、发送、取消、Fork、messages/follow 的原语义及错误不变 |
| ACC-REGRESSION-INTERNAL | hidden 的内部恢复、取消、父子完成、生命周期扫描不遗漏；不弱化 Worker/API token 和路径边界 |
| ACC-REGRESSION-ANALYTICS | hidden 的真实会话／Run／token 成本仍可统计，不用 Tab join 排除后台事实 |
| ACC-REGRESSION-NONGOALS | 无 ACL、自动删除、文件复制隔离、visibility 提升、定时开关、专用 viewer 或新增依赖 |

## 需求到验收闭环

| 需求 | 验收组 | 主要验证层 |
| --- | --- | --- |
| REQ-VIS | ACC-CREATE、ACC-DERIVE、ACC-CLI-FLAG | SQLite、子任务集成、CLI HTTP 注入 |
| REQ-DISCOVER | ACC-DISCOVER、ACC-EVENT、ACC-TAB-COMPAT | SQL 查询、Fastify、SSE 消费者 |
| REQ-TAB | ACC-TAB、ACC-WEB（含 DRAFT 确认／失败／unknown／失效上下文）、ACC-MIGRATE-TABS | 真实存储、可控组件时序及无副作用断言、浏览器联动 |
| REQ-SCHEDULE | ACC-SCHEDULE、ACC-WEB-FLOW | 声明／激活／恢复、任务页与普通 Tab |
| REQ-CLI | ACC-CLI | 命令解析、构建产物 help、HTTP／输出证据 |
| REQ-MIGRATE | ACC-MIGRATE（含 STRUCTURE／REOPEN） | 新建与真实升级库规范结构对比、重开 current、事务故障、双连接及部署演练 |
| REQ-SCOPE | ACC-REGRESSION 及全组负向断言 | 全量门禁、源码审查、变更范围检查 |

- 任何必须项未通过，结论为未验收；不得以“未来支持”“理论不会发生”关闭场景。
- 测试路径和执行命令见[实施计划](05-implementation-plan.md)；实现时可增加测试文件，但不能减少本矩阵的可观察要求。
