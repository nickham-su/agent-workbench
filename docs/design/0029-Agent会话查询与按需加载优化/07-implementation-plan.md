# 开发任务拆分、实施步骤与停机上线

## 实施状态（核心交付与最终全面审查整改）

- 阶段一：已通过父级独立审查；本轮不弱化其目标 GET、读水位、确认 receipt 和取消补偿。
- SCOPE-API、PARTIAL-STATE、PICKER、SNAPSHOT-INIT：已实现并执行相关自动回归。
- BASELINE：仅使用合成样本测量，没有访问真实用户库或收集用户标题。
- GATE-FINAL：既有locale负例和11ms时序测试已修正并通过补充独立审查；最终独立全面代码复审已通过，H1/M1/M2/M3/L1/D5均已闭合（Resolved），无编码阻断。开发者执行的自动根门禁2278/2278、typecheck/build均通过，独立审查员Web及定向执行证据另列于08，不累加为根测试总数。L2非阻断文档术语已修正，待原审查员最后确认。未部署、未真实浏览器人工验收，不等同批准上线。
- RELEASE：未执行实际部署、数据清理或浏览器人工验收。开发子任务不执行Git；父级按用户授权完成阶段暂存，不代表已提交或部署。
- 命令、计数、性能数据、处置说明见 [08](08-implementation-and-verification.md)。

## 开发组织与依赖

任务标签用于追踪，不表示必须串行提交；涉及同一共享契约或状态机的修改必须协调。分阶段门禁通过后再进入下一阶段，最终一次同步部署。

| 任务 | 依赖 | 交付/完成判定 |
|---|---|---|
| BASELINE：调用与数据基线 | 无 | 复核现状引用、统计各场景请求、匿名性能数据、已有库/提醒样本 |
| TARGET-API：单目标GET | BASELINE | route/窄query/store/wrapper与归属、auth、轻量查询测试 |
| TARGET-CLIENT：统一加载与意图 | TARGET-API | 受保护结果typed区分、窄15秒GET、slot释放；所有入口统一、错误与最后意图正确 |
| LOCAL-RECORD：成功响应局部更新 | BASELINE，与TARGET-CLIENT对齐保护函数 | Fork完整事件、创建/标题upsert、无额外查询 |
| READ-WATERMARK：timeline读证明 | TARGET-CLIENT、LOCAL-RECORD | pane实际发起context/token、三路径共用水位、正文独立、清保护不清epoch |
| TARGET-SYNC：目标标题收敛 | TARGET-CLIENT、LOCAL-RECORD、READ-WATERMARK | title-only、mutation保护、dirty单飞、失败停止测试 |
| GATE-STAGE-ONE：阶段一验证 | TARGET-CLIENT、LOCAL-RECORD、READ-WATERMARK、TARGET-SYNC、VISIBILITY-RECEIPT | 全量GET仅初始化；请求预算/竞态/原Tab业务通过 |
| SCOPE-API：双scope与SQL | GATE-STAGE-ONE | shared union、事务snapshot、trim函数、分页/cursor测试 |
| VISIBILITY-RECEIPT：确认订阅 | TARGET-CLIENT | 阶段一交付：原controller窄订阅、一次结算、同向superseded、15秒PUT/30秒UI等待、epoch与有界补偿 |
| PARTIAL-STATE：partial状态改造 | GATE-STAGE-ONE、VISIBILITY-RECEIPT，与SCOPE-API对齐 | 捕获snapshot前未决集合、confirmationEpoch、可见成员、提醒合并 |
| PICKER：按需弹窗 | SCOPE-API、PARTIAL-STATE、TARGET-CLIENT、VISIBILITY-RECEIPT | 完整record证明、最多2GET/30秒核实、独立30秒确认、取消边界与活数据去重 |
| SNAPSHOT-INIT：单snapshot初始化 | SCOPE-API、PARTIAL-STATE | 替换双GET，零可见/失败/重试/KeepAlive回归 |
| GATE-FINAL：最终审查与性能 | 所有阶段二任务 | 禁止调用扫描、验收矩阵、旧库启动、性能报告 |
| RELEASE：停机同步升级 | GATE-FINAL | 配套构建、数据备份验证、上线冒烟、失败恢复预案 |

阶段二中的API与客户端必须在开发验证环境同步运行，不提供旧客户端兼容层。不要把阶段一临时保留的全量初始化当成最终兜底。

## 基线与测试准备

- 读取当前源码复核 `06-code-reference.md` 的符号与调用链，搜索所有运行时和测试引用。
- 列出目标操作、初始化、标题同步、Fork的元数据请求；将运行状态/模型/timeline请求独立计数。
- 构建可控制请求完成顺序的前端fixture；改 matcher 前保留阶段一基线断言。
- fake XHR/窄API fixture支持Axios timeout事件和可控timer；预置15秒传输/30秒UI等待、旧PUT排队、同向覆盖、取消失败和旧timeline晚到的确定性时序。
- 构建匿名SQLite样本覆盖可见性组合、特殊标题、Fork/revert和静态页边界；建立双连接WAL事务测试工具。
- 为现有数据库/提醒状态制作测试副本，不在生产数据上注入大量记录或执行清理；保留用户自行修改，不进行未授权git操作。
- 复核新游标时间/长度边界能覆盖历史数据；异常时先报告，不能以新限制静默隐藏会话。
- 记录基线响应字节和EXPLAIN，所有性能数字注明环境，未测量的项目写“未测”而非估算收益。

## 阶段一详细实施

### 单目标读取能力

- 在shared/API层声明纯metadata返回，不改既有内部 `getSession(sessionId)` 供运行时使用的语义。
- Agent read-side增加明确带workspace的目标读取方法，复用record映射；workspace存在检查和归属读取放在短读事务。
- public route增加 `GET /api/agent/sessions/:sessionId`，参数、401/404 code和schema符合API文档；wrapper正确encode path ID并传workspace。
- target以及阶段一临时列表/Tab状态关键GET配置15秒；可见性PUT窄wrapper也15秒。先识别Axios timeout再toApiError，不能改axios全局或timeline/发送/stream。
- 通过真实查询/窄依赖计数断言不加载消息、工具、状态和模型。
- 添加API/auth/跨workspace/错误测试，并接入标准测试门禁。

### 统一target loader与错误归属

- 把target读取、metadata guarded upsert、打开意图有效性和目标不可用处理抽成窄逻辑，复用既有scope guard。
- 建立workspace/目标级单飞；不同消费者共享读取但各自验证意图。补充旧finally不得清理新token的测试。
- loader返回accepted/protected/supersededRead等明确结果，保护后cache不当核实成功；失败/timeout失效token、释放slot。UI取消只释放自身订阅，有共享消费者时不清其真实GET。
- 改外部openSessionRequest watcher：等待ready后单目标查询；最后意图优先，不全量refresh。
- 改父/子会话入口：本地可乐观打开，但来源关闭需通过目标核实和本次可见性确认门禁；picker同样在确认后才替换草稿，PUT失败保留来源。404回退只影响当前意图。
- 改定时任务openSession：移除listAgentSessions导入/预校验；保留sessionAvailable按钮门禁和来源入口差异。
- 区分真实SESSION_NOT_FOUND、WORKSPACE_NOT_FOUND、401、协议/参数、网络/5xx，不统一提示“已不可用”。

### 可见性receipt与有界来源提交

- 原requestVisibility boolean入口保留；WithResult与它共用intent登记/pump，订阅先于notify/pump注册。所有终态恰好一次并释放callback/timer，较新同/反向intent立即superseded旧等待。
- 无效context立即已结算返回，不登记/推进新workspace队列。origin按共享操作对象身份区分UI resolver与晚HTTP去重标识；同操作补偿承接，独立新意图/真实队列终止/销毁清理；覆盖M1-invalid-context、M1-origin-release与M2-prompt-origin。
- 原onMutationError二参签名保留，仅真实最终失败使用；UIcancel/watchdog/superseded不塞status union进入error。快no-op需明确confirmed匹配（不能用未知primary默认值），且无未决/不确定写，提交前复核receipt intentSeq仍最新。
- confirmationEpoch/uncertainCommit在真实确认/失败回滚处更新，为阶段二snapshot准备；30秒UI watchdog不清真实inFlight，PUT15秒timeout按不确定提交和原补偿规则处理。
- picker来源保留至核实与匹配intent确认；取消先保留来源，有资格才同workspace队列补偿。补偿失败/timeout当前一次非阻塞提示，不保证已隐藏、不无限retry；切workspace/卸载无旧补偿。
- 阶段一提供显式关闭/重新进入核实；阶段二可主动重载tabs合并，不是PUT失败自动重初始化。

### 局部响应与目标标题同步

- Fork helper、props函数类型、defineEmits、回调和父组件统一完整AgentSessionRecord，不丢字段。
- 创建/手动标题/Fork成功进入同一受保护upsert；保留现有草稿创建单飞与workspace隔离。
- AgentToolView提供局部metadata read context；pane loadTimeline在真实getAgentTimeline调用前capture token，defineEmits与父handler改为session+readToken，fixture提供同context。
- target/snapshot/timeline标题使用同acceptedReadOrder和mutationEpoch，完整接受由typed outcome和不可变证明表达，不重复保存acceptedFullReadOrder；GET清保护record不清水位，拒绝旧timeline零dirty，正文/工具渲染epoch独立。
- timeline维持title-only，完整GET被保护不拼字段；T开始→manual→新GET清保护→T返回必须不回滚、正文仍可接受、零无意义补查。
- 自动标题完成消费目标级事件，改为target GET；以本地保护epoch判迟到读，不以数据库revision/updatedAt代替。
- dirty补查、有限事件合并、失败同epoch停止与显式重试按状态机实现；把旧全量R2补刷新改成目标R2。
- 阶段一初始化仍使用现有全量列表与Tab状态；删除/限制所有非初始化的refreshSessions调用，继续会话选择走统一target核实路径。

### 阶段一门禁

- 类型检查、目标API测试、Fork/标题保护/目标打开/原Tab队列测试通过。
- 无新事件的已ready单目标操作最多一个GET；同轮保护收敛最多一个额外目标GET；picker本代最多2个真实GET、30秒核实，重复点击不重置；失败不全量兜底。
- 确认订阅快速no-op/同向覆盖/旧PUT排队/30秒watchdog均恰好一次释放；15秒HTTP失败释放实际slot，UI timeout不破坏队列。
- 正常初始化暂时仍是全量＋独立TabGET；不宣称已经实现初始化缩量。
- 独立审查单目标错误/意图和本地成功保护，再进入阶段二。

## 阶段二详细实施

### scope契约与后端查询

- shared定义响应union；public列表GET必选scope，拒绝非法/未知/重复参数，去掉裸数组响应。
- 引入同事务snapshot编排：同步读取workspace、有效覆盖和可见records，固定updatedAt DESC/id DESC；不能用service Promise.all包装。
- 注册并测试 `agent_trim_title`；所有执行分页SQL的fixture连接调用同一注册helper。
- continuable使用资格SQL后keyset/limit+1，实现版本化base64url cursor校验及绑定；客户端不解析cursor。
- 单目标标题集成测试改用targetGET；真正列表测试明确scope。不要直接把旧全量数组测试套到tabs并误要求隐藏数据仍返回。
- 更新OpenAPI/TypeBox和API测试，验证旧无scope请求400，没有隐含默认全量。

### partial状态语义改造

必须先完成此项，才把Agent初始化接到tabs，避免用局部结果剪枝已有数据。

- cache记录与snapshotVisibleIds/pickerItems分离；cache默认primary不能直接成为可见Tab。
- controller snapshot捕获intentSeq、confirmationEpoch、发起时pending/inFlight/effective intent/成员；提交仅无更晚动作和两端均无未决时安装confirmed。
- 先PUT→再snapshot→PUT完成/失败→snapshot返回的open/close/timeout，成员与确认同时保护；不能pending清空后安装旧snapshot或把失败open当成功。
- tabState中未知ID只安装最小可见性信息，不伪造完整record、不加载模型。
- 删除 `pruneSettledStates(serverSessions)` 等列表缺失剪枝；生命周期清空和目标不可用标记仍有明确路径。
- status store注册改为已知metadata，不再代表全集；持久化从原persisted映射合并已知entries，保留未加载/关闭/目标404的历史提醒。
- 运行状态只轮询可见/活动已知record；候选页不注册，不因为持久状态保留而轮询全部历史。
- 对旧库/旧localStorage副本执行保留测试，检查两个workspace互不污染。禁止清空存储来修复新逻辑。

### 初始化与picker接入

- initializeWorkspace改为一次tabsGET；可选Agent读取仍独立，不与关键snapshot失败互相绑死。
- guarded upsert records，提交snapshot成员/覆盖；错误保持专用门控，成功零可见才创建一个本地草稿。
- 复核KeepAlive/error重试、迟到错误、目标intent等待ready、已有编号和本地可见性队列。
- canChooseSessionFrom只依赖草稿/空对话条件；不依赖cache存在primary，不预取候选计数。
- 弹窗实现首屏、更多、去重、cursor终止、错误重试和刷新代次；不对tabs/cache做结果替换。
- 选择仅使用本生命周期实际接受的完整record证明；首次被保护与loader合并一次新鲜GET，最多2次/30秒；二次仍保护/失败/source失效保留草稿与选择，显式retry才新代次。
- 证明合格才登记visibility订阅，独立30秒；只有confirmed且receipt仍最新、source及metadata证明未过期才同步替换/编号迁移/激活。正常成功关闭不补偿。
- 补偿成功/失败/超时/被新意图覆盖、原本可见目标、workspace切换等全部自动化；主动tabs核实保留当前cache/草稿/queue并guarded合并，失败只提示本操作。
- 删除生产全量refresh/retry和旧封装的剩余调用；Tab状态独立GET如测试或其他确有消费者可保留，Agent初始化不得使用。

## 最终验证与审查

- 按 `05-acceptance-and-review.md` 完成所有硬矩阵与请求预算，不只运行happy path。
- 搜索无scope列表GET、refreshSessions、registered全集剪枝、picker批量注册和ID-only Fork事件；静态零违规与网络断言一起验收。
- 执行定向API/Web测试、共享构建与类型检查，再执行根级回归。新测试纳入标准gate。
- 在匿名样本上记录payload、SQL plan和耗时；仅有索引收益证据时再评估可选索引，并复验严格schema和旧库不重建。
- 独立代码审查逐项使用审查门禁；任何未闭合并发/data-preservation问题都阻止上线。
- 将测试命令/通过摘要、请求计数、数据保留对比、性能报告和非目标限制作为开发交付材料；不含敏感用户数据。

## 停机同步上线与失败恢复

### 上线前

- 确认前后端来自同一通过验收的构建，shared契约一致；不允许只部署Web或只部署API。
- 准备现有版本的配套构建/配置和经过验证的数据备份策略。数据库处于WAL模式，不能在活跃写入时只复制主DB文件；按既有部署方式停止所有写入者或使用一致性备份。
- 备份包含DB、必要应用数据及浏览器提醒状态的可恢复样本；浏览器状态不能上传或在日志打印。无需为了本次升级清空cookie/localStorage。
- 确认本次无破坏性schema升级；可选索引的创建路径已在旧库副本验证。任何意外分类为rebuildable/unsupported须停止处理，不接受“重建后能跑”。

### 停机升级

- 用户确认维护窗口后停止API/Web及共享DB写入者，按部署方式完成一致性备份。
- 同步更新配套前后端，启动API使连接注册函数，再提供新Web资源；要求已有浏览器页面重新加载，旧前端不受支持。
- 验证已有会话/覆盖未丢失，打开父/子/定时关联会话、Fork、标题更新和继续会话分页。
- 验证closed primary不恢复为Tab但可继续，未打开subtask不批量传输，已打开subtask恢复。
- 验证未知历史提醒仍存在，正常KeepAlive和失败提示符合预期，网络没有无scope全量GET。

### 失败恢复

- 停止新写入，保留故障诊断且不打印用户数据；恢复同版本配套前后端，不能混用契约。
- 本次默认无数据格式迁移，普通新增索引无需为回滚清空数据库。根据上线后是否已有新写入选择保留当前数据或在用户确认后恢复备份；恢复备份可能丢失维护后新数据，必须明确影响后再执行。
- 不把自动reset/rebuild schema、删除会话、清空localStorage当成回滚操作。

上述操作属于后续开发/部署执行清单，本文档任务不授权实际停机、修改产品代码、备份项目目录外文件或操作git。
