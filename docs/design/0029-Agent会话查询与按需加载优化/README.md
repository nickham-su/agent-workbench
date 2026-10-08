# Agent 会话查询与按需加载优化

## 文档定位

本目录是本次优化的开发、代码审查和验收基准。两个核心阶段及既有测试断言修复均已通过阶段独立审查；最终独立全面代码复审已通过，原审查H1/M1/M2/M3/L1/D5均已闭合（Resolved），无编码阻断。开发者执行的自动根门禁2278/2278、typecheck/build均通过；独立审查员另行执行的Web及定向验证单独记录，不与根测试计数累加。L2非阻断文档术语已修正，待原审查员最后确认。未部署、未真实浏览器人工验收，以上结论不等同批准上线。最新实际命令、计数和复审结论以 `08-implementation-and-verification.md` 最后的整改验证记录为准。文中的历史“现状”以方案编写时基线为准，当前符号定位见 `06-code-reference.md`，“目标”“必须”“禁止”表示开发要求。

项目为自托管、自用部署，可停机同步升级 API 和 Web，不需要旧版本客户端或旧 GET 列表契约兼容。已有会话、消息、Tab 可见性设置、提醒状态必须保留。开发分阶段完成，最终可一次停机上线。

## 阅读导航

| 文件 | 内容 | 主要读者 |
|---|---|---|
| [01-requirements-and-product.md](01-requirements-and-product.md) | 背景、业务规则、交互和范围 | 产品、前后端、验收 |
| [02-decisions-and-tradeoffs.md](02-decisions-and-tradeoffs.md) | 冻结决策、替代方案与取舍 | 设计、代码审查 |
| [03-api-data-and-sql.md](03-api-data-and-sql.md) | API、实体、SQLite 查询与游标 | 后端、契约、测试 |
| [04-client-state-and-concurrency.md](04-client-state-and-concurrency.md) | 缓存、请求所有权、并发、生命周期、错误 | 前端、代码审查 |
| [05-acceptance-and-review.md](05-acceptance-and-review.md) | 可判定测试矩阵、请求预算、性能与审查门禁 | 开发、测试、验收 |
| [06-code-reference.md](06-code-reference.md) | 现状源码、影响范围、测试与相关设计 | 开发、代码审查 |
| [07-implementation-plan.md](07-implementation-plan.md) | 任务依赖、详细实施、验证与停机上线 | 开发、部署 |
| [08-implementation-and-verification.md](08-implementation-and-verification.md) | 本地实现、实测命令与计数、合成性能、未闭合门禁 | 开发、审查、验收 |

## 阶段定义

- 阶段一：新增单会话元数据 GET；统一单目标打开，Fork完整record上送，timeline读水位保护，自动标题只查目标，原Tab controller增加receipt/确认代次/不确定提交。仅初始化保留旧全量列表＋独立Tab状态GET；继续会话候选仍来自本地已加载集合，但选择必须经目标GET核实与visibility确认。
- 阶段二：改造列表接口为 `tabs` / `continuable` 两种 scope；初始化按可见性恢复，候选列表后端筛选、分页；改写依赖全量集合的状态管理。
- 阶段门禁：分别开发、审查、验证。最终状态没有无 scope 的全量 GET，也没有失败后的全量列表兜底。
- 兼容、回滚说明：不保留旧 API 兼容代码。停机恢复旧构建只能配套恢复旧版本前后端；数据保护仍是强制要求，不得借“不需要兼容”清空任何已有业务数据。

## 术语与实体边界

| 术语 | 含义 |
|---|---|
| 会话元数据 / record | `AgentSessionRecord` 的完整 11 个字段，不含消息正文、工具执行、模型覆盖或运行状态 |
| Tab 覆盖 | `closedSessionIds` 和 `openedSubtaskSessionIds`；表达偏离默认值，不是完整已打开 ID 列表 |
| tabs snapshot | 同一个 SQLite 读事务取得的可见会话 records 与有效 Tab 覆盖 |
| target load | 在 Agent 中统一按工作区和会话 ID 查询、合并、验证并打开目标 |
| 会话缓存 | 当前工作区已取得的元数据集合；不宣称覆盖全部历史会话 |
| picker page | 弹窗的一页候选；不能替换会话缓存或推导数据库删除 |
| 本地 mutation 保护代次 | 前端成功写入/权威局部事件的排序信息；不是数据库 `revision` 或 `updatedAt` |
| 当前打开意图 | 最后一次用户要求打开目标的 UI 意图；与 Tab PUT 队列的单会话意图序号分开 |
| 元数据读水位 | target/snapshot/timeline标题共用的本地读取接受顺序；保护record收敛不清水位 |
| confirmationEpoch | Tab确认/真实失败回滚的本地代次，保护snapshot发起前已有的未决写 |
| UI结算 / 传输终止 | UI订阅结算不撤销已发送PUT，也不等于请求的实际终止或后端未提交 |

## 不可弱化的不变量

- 主会话默认可见、子任务默认隐藏；关闭只是隐藏入口，不取消、删除或终止 Session。
- 已关闭但符合资格的主会话仍能通过继续会话弹窗重新打开。
- tabs 缺失、分页未命中、网络失败、401、5xx 都不能证明会话已删除。
- 部分查询结果不能导致隐藏历史会话的 Tab 确认状态或提醒被清理。
- 工作区切换、组件卸载、过期初始化、过期打开意图、过期弹窗请求不能写入当前 UI，也不能显示过期告警；已经发出的PUT仍可能改变旧后端，不能承诺关闭/abort必然撤销提交，旧上下文不再发送补偿。
- 手动标题成功不能被较早的 GET、timeline 或 snapshot 响应覆盖；不以数据库 `revision` 或 `updatedAt` 代替保护。
- 定时任务执行的 `sessionAvailable` 归属门禁不放松；单会话存在不等于属于该次执行。
- snapshot保护发起前和发起后pending/in-flight及真正确认/回滚事件，不只比较intentSeq；不以重新初始化绕开队列。
- tabs 不分页、不截断恢复数量；`continuable` 默认 50、最大 100 条，必须后端先筛选后分页。
- 一致性 snapshot 依赖真实 SQLite 读事务，前端 `Promise.all` 不等价于数据库一致性。
- 窄元数据GET与Tab PUT传输上限15秒，不修改共享axios全局；visibility UI订阅从登记起最多30秒，且恰好结算一次。
- picker只认本选择生命周期实际接受的完整target record，最多2次真实GET/30秒核实，再独立最多30秒可见性确认；受保护cache不等于核实成功。
- 取消优先保留来源；补偿使用原队列的独立30秒确认receipt。失败/超时明确提示打开可能已提交、恢复隐藏未确认；目标可能可见，不无限自动重试。工具隐藏后取消picker页/选择/重试身份与补偿UI订阅，但不终止真实PUT或正常后台完成通知。

## 首轮审查修复追踪

首轮审查修复追踪（详细算法位于状态机，具体时序位于验收文档）：

| 问题 | 最小控制点 | 验收标签 |
|---|---|---|
| H1 | timeline实际发起context token；三路径共用读/mutation水位，清record不清水位，正文独立 | H1-late-timeline-after-convergence / H1-shared-order / H1-context-chain |
| H2 | intentSeq＋confirmationEpoch＋snapshot发起时未决集合；成员与确认同时保护 | H2-open-before-snapshot / H2-close-before-snapshot / H2-failure-before-snapshot / H2-timeout-uncertain |
| M1 | 原controller窄receipt，任何新意图superseded旧等待；一次结算/原callback不变 | M1-same-direction-supersede / M1-reverse-supersede / M1-fast-noop / M1-all-terminal |
| M2 | 来源保留、最后意图有界补偿、失败不承诺隐藏、旧workspace无补偿 | M2-cancel-queued-open / M2-compensation-fails / M2-switch-before-compensation |
| M3 | 15秒窄传输、30秒UI watchdog、真实槽位与UI订阅分离 | M3-GET-slot-timeout / M3-PUT-timeout-queue / M3-UI-queue-watchdog / M3-timeout-scope |
| M4 | 选择完整record证明、最多一次新鲜补查/2GET/30秒核实、独立30秒确认 | M4-fresh-proof-required / M4-second-unaccepted / M4-verification-deadline / M4-confirmation-deadline |

此表是修复索引，不表示独立复审已经通过；开发验收必须运行矩阵而非只阅读索引。

## 与既有设计的关系

- [0023 Agent 会话 Tab 状态后端持久化](../0023-Agent会话Tab状态后端持久化/README.md)：沿用默认可见性、PUT 单飞、最后意图补偿、生命周期隔离；替换双 GET 初始化和全量剪枝假设。
- [0025 定时任务方案](../0025-定时任务方案/00-文档导航.md)：保留执行归属判定和来源业务规则；只调整关联会话的跳转查询路径。
- [0017 手动修改 session 标题方案](../0017-手动修改session标题方案/)：沿用手动标题永久接管和规范化规则；本次候选筛选只做 JS `trim()`，不引入标题空白压缩。

如本目录与旧文档的查询方式描述不同，本目录对本次改动的查询方式具有优先级；旧文档的业务不变量未被明确替换的仍应遵守。发现无法同时满足的约束应提出设计问题，不得自行删除保护规则。
