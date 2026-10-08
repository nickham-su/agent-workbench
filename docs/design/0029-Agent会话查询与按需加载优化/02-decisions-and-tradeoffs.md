# 关键决策与取舍

## 决策冻结表

| 决策 | 原因 | 不采用的方式 |
|---|---|---|
| 分阶段开发，最终同步停机上线 | 先减少单目标全量刷新，再改变集合语义，便于定位回归 | 为旧客户端维持双契约或在线灰度兼容 |
| 新增返回完整 record 的单 GET | 一次查询完成校验与 Tab 所需元数据加载 | 布尔校验后再次查详情；借 run-state/timeline 旁路 |
| 定时任务直接发意图，Agent 统一查询 | 去掉两侧重复查询并统一错误处理 | 定时任务先查列表，Agent 再查列表或目标 |
| Fork 沿事件链上送完整 record | 后端已经提供数据，额外查询没有必要 | 丢弃 record 只传 ID 后全量刷新 |
| timeline title-only携发起token，共用持久本地读/mutation水位 | 保护record收敛清除后仍需拒绝旧timeline，正文规则独立 | 无token裸record事件；标题拒绝时连正文一起丢弃 |
| 列表 scope 必选且判别式返回 | 业务查询明确，测试能区分 tabs 与候选页 | 缺省全量，或一个任意过滤器让调用方猜语义 |
| tabs 是真实读事务 snapshot | records 和覆盖必须来自同一数据库视图 | 将 Promise.all 双 GET 称为“原子” |
| tabs 不分页，默认可见规则不变 | 不能为了省流量丢失应恢复的 Tab | 任意前 N 条、只读 openedSubtaskSessionIds、自动关闭旧 primary |
| continuable 后端筛选+keyset分页 | 减少传输，避免 offset 随翻页增长，稳定并列排序 | 全量传输后前端过滤/slice |
| 完整 record 复用，不拆候选摘要实体 | 现有只有 11 个元数据字段；降低契约与加载组合成本 | 此次增加多种实体投影与转换链 |
| JS 等价 trim DB 函数 | 保持标题筛选语义，覆盖 Unicode 空白 | 默认认定 SQLite trim 等价，或改用手动标题规范化 |
| 不透明版本化 cursor，无签名 | 自用只读分页，不承载授权；严格参数校验足够 | 将 cursor 当权限、信任 cursor 内 workspace、为了分页建立会话快照服务 |
| cache 与查询结果分离 | partial 缺失不能当删除 | 用 tabs/picker 数组替换“全量权威集合”并剪枝 |
| 保留隐藏历史提醒，不后台全量清理 | 不丢用户状态，不为清理重新拉全量 | unknown 历史状态一律删除，或启动额外全量对账 |
| 已有索引先测后改 | 数据量与选择率决定收益，通信变小不保证数据库更快 | 无证据增加 kind/head/title 索引 |
| snapshot捕获intentSeq＋confirmationEpoch＋发起时未决集合 | snapshot前已发出的PUT也会在期间完成，intentSeq可能不变 | 只保护snapshot后新意图或提交时pending |
| 可见性订阅恰好一次；任何较新意图都superseded旧seq | 简单、可判断、无需跨seq迁移等待；来源提交只能属于原意图 | 同向意图静默继承旧等待，导致无限等待或错误提交 |
| 窄GET/PUT15秒，UI等待30秒 | 实际axios无全局timeout；有限UI等待不等于终止真实队列 | 修改全局timeout影响长请求；watchdog清掉真实inFlight |
| picker最多2次完整GET/30秒核实 | 受保护cache不是完整资格证明；一次补查后可显式retry | 以旧head＋新title判资格，持续事件使单选择无限补查 |
| 取消有界补偿，不保证失败后隐藏 | 已发请求可能提交；旧workspace不再补偿；当前可显式核实 | 宣称abort必然撤销、失败无限retry、切workspace后继续旧补偿 |

## 为什么不复用现成单目标接口

- `run-state` 校验归属，但还读取状态及附加指标，不返回完整 Tab 元数据。
- `timeline` 返回 session，也查询消息、工具执行和分页，哪怕 limit=1 仍不是纯元数据查询。
- `model-overrides` 读取模型配置，且 subtask 返回冲突，不能作为通用会话校验。
- 定时任务 `validate-source` 验证历史消息可 Fork，需要 messageId，不等价于目标会话读取。
- Tab PUT 会写状态，不可借 mutation 当只读校验。

单 GET 只读 `agent_session` 和必要的 workspace 存在性；不得偷偷查询上述附加内容。

## 为什么 tabs 与 continuable 不能合并为一个结果

- 已关闭 primary 不恢复为 Tab，但仍需要出现在候选中。
- 已打开 subtask 必须恢复为 Tab，但永远不是继续会话候选。
- tabState 是默认值例外，缺省 primary 可见，不是完整打开集合。
- 两者生命周期不同：tabs 是初始化关键数据，picker 是按需页数据；共享数组会让分页重试、空结果误影响主界面。

统一路径便于复用路由与元数据映射；必须以 scope 判别返回，禁止复用同一响应处理器的全量替换分支。

## 为什么不使用 updatedAt 或 revision 防回滚

现有手动标题测试明确要求标题更新不改变 `updatedAt`；会话 `revision` 属于消息图的演进，不是全部元数据写入的统一版本。仅按这两个字段比较无法识别迟到的旧标题。

因此保留并扩展现有前端成功mutation保护：target/snapshot/timeline标题均捕获发起readOrder和mutationEpoch。保留每目标接受水位及mutation水位，成功GET清保护record不清水位；过期timeline拒绝且零dirty，完整GET被保护则不是核实成功。保护只对本客户端动作负责，不宣称检测所有外部并发。

完整GET与title-only采用同一acceptedReadOrder门槛，保守整体拒绝较早完整record，避免拼接新title/旧head；直接以typed accepted full outcome及不可变record/token形成证明，不另存acceptedFullReadOrder，不把后续title-only cache变成picker证明。细节与typed结果见状态机文档。

## 实施细化决策

- picker提交只因本地mutationEpoch变化或实际资格字段(kind/head/JS trimmed title)改变而拒绝；相同标题的新timeline只推进读水位，不阻断已核实的选择。这避免慢PUT期间被无害读取误拒绝，来源/工作区/最后意图保护不变。
- 不维护没有消费者的acceptedFullReadOrder；typed accepted完整结果和不可变选择证明足以区分完整读取与title-only，减少重复可变状态。
- 当前sessionCache中的完整record直接承担保护副本；已删除全量刷新后不再维护无消费者的第二份titleMutationCache完整record映射。mutationEpoch/acceptedReadOrder负责拒绝迟到读，拒绝时完整保留当前cache，不混合字段。
- visibility receipt快速no-op只用已知confirmed（snapshot/PUT或刚创建默认状态），未知目标即使primary默认可见也发送打开PUT。metadata GET不包含覆盖，不能证明新出现目标没有被别的客户端关闭；以UI默认值代替确认会让来源过早消失。

## 流量收益与限制

设工作区总会话数量为 N、需恢复数量为 V、一次候选页上限为 L：

- 阶段一：单目标查询从传输 N 个 record 变为 1 个；Fork 不需查询；初始化暂时仍传 N 个。
- 阶段二：初始化传 V 个 record 加有效 Tab 覆盖 ID；弹窗一次最多 L 个 record。
- Tab 覆盖本身也可能随已关闭 primary 数量增长，本次不限制、不丢弃该覆盖集合，不能承诺初始化总字节数只随 V 增长。
- 若全部 primary 默认可见，则 V 可能等于 N，初始化元数据不能缩减。这是保留产品规则的必要成本。
- 保留的历史提醒数据依旧占 localStorage，不为减少存储而擅自丢弃。
- DB 函数筛选仍可能扫描不少不合格记录；返回数量受限不等于 SQL 扫描量受限。

不填未经实测的压缩率、耗时提升或内存收益。按验收文档建立可重复的数据集和记录方式。

## 数据与升级取舍

- 不新增 Session/Tab 持久化实体，不变更会话图、不清空 Agent 域。
- 注册 SQLite 函数是连接级行为，不是持久化数据迁移。
- 如有证据增加普通索引，必须走既有 schema 支持路径；不能触发 Agent schema fail-closed 或 destructive upgrade。
- localStorage 原提醒键和时间字段保留；只修改读写合并语义，允许未知隐藏 ID 暂时存在。
- 不提供自动“清理不存在的全部历史提醒”功能。真正目标 404 只影响本次目标 UI，默认不删除其持久提醒；后续取到有效 record 可以恢复。

## 原有设计保留项

沿用 0023 的 Tab PUT 单飞、最后意图补偿、失败回滚和 workspace 生命周期隔离。PUT 404 仍是该次 mutation 失败，不发 GET、不全量重初始化、不推断 Session 删除。只有本次新增元数据 GET 的当前、未失效 `SESSION_NOT_FOUND` 能触发目标级不可用处理。

同一 workspace 的初始化重试不使已有 PUT 队列回调失效。单目标 GET、snapshot 与 picker 的错误不得重置 controller 或影响其他 Session 队列。

取消补偿失败/timeout仍保留最近明确confirmed/default和uncertainCommit，不宣称后端未提交。用户显式关闭或阶段二主动重载tabs核实可以收敛；这不是失败自动重初始化兜底。原onMutationError签名保留，UI订阅终态独立且去重，不用status union替代error参数。
