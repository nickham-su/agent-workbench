> 当前Esc增量（15e2590之后）独立首审未通过；H1／M1／L1作者修复并完成定向验证，待原审查会话复审。本文此前阶段通过结论仅属基线／设计历史；本轮状态见末尾增量小节及08第14节。

# 文档审查与修订记录

## 记录性质与设计审查当时状态

本文件保留设计审查历史；下文设计审查各节中的“当前状态”“尚未实现”“未运行产品测试”均指该轮设计审查时点，不代表后续实施现状。**当前工程实现完成，最终全面独立existing复审通过，0038整体实现可交付，六项问题6/6关闭、Open 0，无新增问题**；分层审查来源与证据见文末。设计静态通过与最终工程审查通过来自不同审查层次，不互相冒充。最终同源树验证见[实现与验收第13节](08-implementation-and-acceptance.md#13-最终独立全面复审通过与同源树收尾归档)。

- 首轮独立审查会话：`sess_00mwa7yq1o00009ed4112ea980`。
- 首轮结论：**不通过**，H1～H4、M1～M2均为阻断问题。
- 审查者遵守只读职责，没有创建报告；本文件由文档编写者根据主助理转述的实际审查结果及主助理裁决补录，不冒充审查者输出。
- 首次复审结论：**总体仍不通过**；H1～H4、M1～M2全部Resolved，新增中等级M3/M4。该结论由主助理转述实际独立复审，不伪造审查者新报告。
- 第三轮复审：M3/M4已Resolved，H1～H4/M1～M2保持Resolved；总体仍不通过，新增高优先级H5。此为主助理转述实际结论，不补造审查者报告或验证结果。
- 当前状态：**第四轮独立复审通过；H5 Resolved，H1～H4、M1～M4均Resolved，无新增阻断问题**。仅为设计文档静态审查结论；业务代码尚未实现，未运行产品测试、真实迁移或真实模型/工具联调。
- 初稿历史行号仅用于说明发现位置；修订后以文档标题／决策／任务／验收ID定位，不把旧行号当作现版坐标。

## 首轮问题与主助理裁决

| 问题 | 级别 | 首轮发现 | 主助理裁决 |
| --- | --- | --- | --- |
| H1 | 高 | 未确认输入受保护且不能revert／压缩；trigger已注入、N=0时resume不启动，原Session永久卡死 | 增加显式续接旧输入的新Run路径，以及全量不可逆abandon出口；不重插user、不伪造确认、不自动重放工具 |
| H2 | 高 | 输入绑定只覆盖create，provider retry和recovery replace/resume换Assistant ID后漏绑定 | 在既有替换事务继承同快照；恢复按实际上下文验证；旧superseded不可确认，重放验证集合 |
| H3 | 高 | 将现有lastResponseTotalTokens／estimator／固定尾部planner误称精确完整预算，漏动态工具和materializer媒体分支 | Worker新增唯一版本化保守公式，真实系统／工具／replay／图片同源；API不维护工具影子、不猜窗口；明确context-too-large暂停与恢复 |
| H4 | 高 | 假设现有安全GC可unlink已发布Workspace附件，忽略同UID替换安全拒绝 | 安全保留；发布前独立持久reservation与DataDir本功能1GiB留存额度；未知／取消／逻辑删除不自动释放，离线维护人工对账 |
| M1 | 中 | receipt复合FK的control父键缺UNIQUE，可能foreign key mismatch | 写实全部父键／复合FK／清理顺序，补真实SQLite插入、scope mismatch、foreign_key_check和升级测试 |
| M2 | 中 | fallback没有provider却被当作模型消费；只写worker-ready，漏fallback API onListen屏障 | 统一confirmed及worker_model/local_fallback来源，来源由可信入口派生；两运行时分别恢复、推进及关闭 |

## 修订映射

### H1：两条恢复出口闭合

- 产品：[R-RECOVERY与停止／继续／放弃](01-requirements-and-product.md#esc停止与发送统一启动)，N=0仍有独立恢复提示。
- 规则：[D-RECOVER](02-business-rules-and-state-machine.md#d-recover发送承接恢复不重插user)、[D-ABANDON](02-business-rules-and-state-machine.md#d-abandon放弃全部未确认输入)。
- 技术：[独立续接与abandon事务](03-architecture-and-data-model.md#受控恢复两个闭合出口)，新增Run输入关联与confirmation_state；trigger引用既有user。
- 协议：[控制与恢复API](04-api-and-worker-protocol.md#控制与恢复api)，resume operationId去重，abandon全量集合hash+CAS+不可逆确认。
- 实施：P-RECOVER；验收：A-RECOVER-EXIT及A-STOP。
- 补充封闭：abandon不依赖失效模型／窗口或剩余发布额度；与queued并存不自动执行，所有主／压缩／replay路径排除abandoned，fork不能复活。

### H2：替换／恢复输入绑定

- 规则：D-BINDING。
- 技术：[输入快照绑定](03-architecture-and-data-model.md#模型fallback输入快照绑定)，binding状态active/superseded/confirmed，replace事务继承或recovery重准备。
- 协议：[create/replace/resume/complete](04-api-and-worker-protocol.md#输入快照绑定createreplaceresumecomplete)。
- 实施：P-INPUT；验收：A-BINDING-RETRY，涵盖替换前后崩溃／丢回包、实际context变化、迟到旧完成。
- 已核验代码：runner约2765、3085行，agent-message.store约765行；没有引入新的重试框架。

### H3：保守估算及全部输入路径

- 规则：D-BUDGET/D-INPUT-PROTECTION。
- 技术：[queue-input-estimator-v1唯一公式](03-architecture-and-data-model.md#预算新增-queue-input-estimator-v1)，包含W/R缺省及错误、B/M/P/tool/image开销、90%窗口与25%估算余量。
- 协议：Worker准备／注入、冻结输入绑定和provider_context_too_large暂停。
- 实施：P-INPUT；验收：A-BUDGET及A-IMAGE/A-COMPACTION。
- 已核验：runner:2528自动触发、2707动态工具、1007输出设置；estimator-v1:165、planner:81、primary-materializer:89的实际局限。
- 文档不承诺绝不超限；trigger晚失败由H1恢复，不再假称API精确预检。

### H4：安全保留及有界发布

- 产品：R-RETAIN，明确空间成本和不自动物理删除。
- 规则：D-RETAIN/D-LIMIT；技术：[发布留存账本](03-architecture-and-data-model.md#附件发布留存安全优先不自动unlink)。
- 新增独立publication_intent，发布前先提交reservation；业务事务回滚不能抹账，发布未知仍计额，同request不能重复发布。
- 发布留存1GiB独立于queued 64MiB；取消／abandon／已注入／逻辑删除不释放。released_unpublished仅确证从未发布；已发布减额仅离线排他维护并留审计。
- 协议：507留存容量、409发布未知、安全查询；没有在线危险删除／减额API。
- 实施：P-RETAIN；验收：A-RETENTION及崩溃矩阵。
- 已核验agent-attachment-storage:374～386明确拒绝Workspace unlink，所有旧自动GC承诺已删除。

### M1：复合键与删除顺序

- [实体DDL](03-architecture-and-data-model.md#实体与键)列出Session／附件／Run／Message父键、control UNIQUE和receipt作用域FK，关联表各自键和级联策略明确。
- confirmation CHECK用COALESCE防SQLite NULL旁路；清理先解绑所有新引用，再改老origin字段。
- publication账本无Workspace FK，不进入Agent域重建／逻辑删除级联。
- 实施：P-CONTRACT；验收：A-SCOPE-DDL及A-MIGRATION。

### M2：确认来源与两条生命周期

- 术语改为输入确认，字段confirmed_at/confirmation_state/confirmation_source；不使用first_model_completed_at伪称fallback模型完成。
- worker_model仅合法模型完成，local_fallback仅回显完成；来源由受保护运行时入口派生。
- 技术：[生命周期、删除与迁移](03-architecture-and-data-model.md#生命周期删除与迁移)分别规定Worker ready与fallback API onListen恢复屏障、推进及关闭顺序。
- 实施：P-DISPATCH/P-INPUT/P-WEB；验收：A-FALLBACK。

## 首次复审与其后M3/M4修订

| 问题 | 级别／首次复审状态 | 主助理裁决 | 本轮修订状态 |
| --- | --- | --- | --- |
| H1～H4 | 高，全部Resolved | 保持恢复、绑定、保守预算及安全留存设计 | 不重开、不推翻 |
| M1～M2 | 中，全部Resolved | 保持FK、确认来源与双运行时屏障 | 不重开、不推翻 |
| M3 | 中，首次复审新增 | Stop安全优先不带版本；只有resume/abandon版本CAS；区分新Stop与旧ID重试 | 第三轮复审Resolved |
| M4 | 中，首次复审新增 | 公开请求仅版本+集合hash，不增加ID数组；服务端全量canonical与严格schema | 第三轮复审Resolved |

首次复审还独立确认：8份文档82链接可用；6组SQL在启用FK的内存SQLite执行，非法scope/确认状态拒绝，foreign_key_check无行。此为文档验证，不等于产品测试通过。

### M3修订位置与交错

- 原问题：Stop公开body没有预期版本，却把Stop/resume/abandon竞争统一描述为“先提交者胜、另一方版本冲突”，无法指导实现和验收。

- 产品01“停止”：新Stop可覆盖刚成功的继续，旧Stop重试不能再次停止新执行。
- 规则02 D-STOP/D-FAILURE：明确10类交错；resume后新Stop双方成功、Stop后旧版本resume/abandon冲突，新Stop无Run也递增版本并暂停。
- 技术03“放弃全部当前未确认输入”：仅resume/abandon执行CAS，Stop共用事务但不带预期版本；保留inject/finish fence和正常终态唯一性。
- 协议04 Stop/Resume/Abandon：Stop仅workspaceId/operationId；相同ID只重放，新的停止动作新ID；不得把completed intent改cancelled。
- 实施05 P-ACCEPT/P-RECOVER；验收06 A-CONTROL-RACES和A-RECOVER-EXIT，覆盖旧重试、新停止、无Run、注入与正常完成。
- 该轮曾复核既有runtimeHandoffCoordinator并沿用短时互斥；第三轮H5进一步确认该互斥不是runtime退出证明，现补持久屏障与精确目标，M3的新Stop／旧重放语义保持。

### M4修订位置与canonical

- 原问题：技术事务要求客户端提供完整预期ID集合，公开协议却只列版本和hash，合法请求形状与全量对象选择矛盾。

- 产品01、规则02及技术03删除预期ID数组要求，统一公开expectedQueueVersion+expectedUnconfirmedInputSetHash，服务端决定全量对象。
- 协议04“未确认集合hash的唯一canonical规则”：固定版本tag/scope/inputs字段、正式链顺序、key排序／UTF-8／SHA-256小写64位，空集NULL；快照和事务重算同一实现。
- Abandon公开schema additionalProperties=false，不接受任何多余ID字段；版本先检查，服务端非空全集再比对hash。已复核默认AJV移除额外字段的既有风险，要求沿用路由级不变更输入的TypeBox校验，不全局改配置，并增加真实HTTP拒绝测试。
- 实施05 P-RECOVER；验收06 A-ABANDON-SCHEMA：合法schema、额外ID字段400、旧版本409、当前版本+旧hash409、部分／跨scope hash拒绝、幂等重放。

## 第三轮复审新增H5：DB终态不等于Runner退出

### 事实、裁决与状态

- 第三轮新增高优先级H5，当时总体不通过；完成修订后，第四轮独立复审确认H5 Resolved。
- 主助理补充BugFinder调研并亲核关键代码：cancelSessionCascade先DB终态／收敛再runtime取消；worker-client.cancelSession吞传输／超时；handoff仅回调互斥；Runner Session级取消可迟到误伤新Run；旧cancelSessionAndWait仅bookkeeping空，nested也不全在activeRunIds，均不是精确退出证明。编写者只复核相应代码片段，不伪称独立调研或产品验证。
- 接受主助理窄裁决：持久停止屏障+固定Run集合精确cancel-and-wait，专用可信runtime UUID及admission，先tombstone再abort/等待finally。公开旧Stop重放与后台原目标重试分责，不重启整个Worker处理单Session，不引入通用协调／全工具回收框架。
- 本轮具体选择：每个新Stop独立记录，同root复制旧未解除目标；所有相关屏障并集阻塞，旧证据不清新记录。unbound关闭只有原子证明从未发送才无需RPC；物理enqueue前绑定必须已提交。证据丢失保持unknown，仅可信原实例真实退出的离线排他核验可作为运维退路，无在线force-resume。

### H5修复映射

| 文档／位置 | 修复内容 | 验收关联 |
| --- | --- | --- |
| 01 停止／继续／放弃 | 停止确认中／未知、N=0仍提示、等待／查询、禁强制忽略、工具未知独立 | A-STOP-BARRIER UI |
| 02 D-STOP-BARRIER | DB与Runner分离、目标／实例、允许入口、恢复条件及工具边界 | A-STOP-BARRIER |
| 03 持久停止屏障与精确运行身份 | 4表DDL/FK/索引、可信UUID/退出证据、admission、cascade、独立Stop、调解、fallback、离线退路 | A-STOP-BARRIER SQL/并发/生命周期 |
| 04 精确停止内部RPC与admission／Stop快照 | 固定请求hash、响应pending/unknown/quiescent、错误幂等、旧公开重放与后台重试、实例拒绝 | A-STOP-BARRIER RPC |
| 05 P-STOP-BARRIER及代码地图 | 实施依赖、真实现状差距、双运行时恢复／关闭和上线门槛 | A-STOP-BARRIER 全集 |
| 06 A-STOP-BARRIER | DB已terminal仍running、丢包/超时、迟到cancel/enqueue、nested、换代/重启未知、fallback、Git lease | H5自动验收要求 |
| README | 当前结论／权威导航／追踪；已Resolved项保持 | 交付门槛 |

### 本轮验证性质

- 仅目标目录文档变更，未改代码、未Git、未读敏感配置；本节不宣称真实产品／迁移／模型测试通过。
- 本轮静态自检：8份文档、89个本地链接（59个代码行号、15个标题锚点）有效，围栏配对、无有序列表；H5所需实体／协议与M3/M4保护文本检查通过。
- 本轮文档DDL自检：7组SQL片段在最小父表stub的内存SQLite、foreign_keys=ON执行；新增4表含跨Session目标及两Stop全链插入，跨scope／错实例／NULL证据等7项非法写入拒绝；旧确认不改新屏障、控制仍paused、显式清理顺序、独立实例实体保留、foreign_key_check无行。只验证文档约束，不证明真实runtime退出或产品迁移通过。
- 此前六组SQL及82/83链接属于历史结果；H5修订轮未运行产品测试、未真实模型或工具联调，最终文档审查结论见下节。

## 修订者自检

- 只修改本目录文档，未执行Git，未修改业务代码，未读取敏感配置。
- 首轮修订已重新核验六项涉及的实际代码及设置字段；源文件证据纳入实施代码地图。
- 首轮修订对文档中的六组SQL片段，在Python隔离内存SQLite配最小现有父表执行，启用foreign_keys：关联全链合法插入、四类非法写入拒绝（NULL确认及control/attachment/binding作用域）、清理顺序、独立留存账本保留和foreign_key_check检查通过。这只是**文档DDL验证，不是产品迁移／业务测试通过**。
- 上一轮静态自检通过：8份文档、82个本地链接（含标题锚点与代码行号）、代码围栏配对、无有序列表；正文已统一confirmed术语。该自检不代表独立复审通过。
- M3/M4修订轮静态自检：8份文档、83个本地链接（含53个代码行号及15个标题锚点）有效；围栏配对、无有序列表，M3/M4文本一致性检查通过。该修订轮未改DDL且未重跑SQL；该检查不是独立复审。
- 未运行产品测试或真实模型联调；容量常量、保守公式及运行时改造仍需实施阶段自动化验收。

## 第四轮独立复审最终结论

以下根据主助理转述的第四轮独立复审结果补录，不冒充编写者独立审查或产品测试结果。

> 通过：H5 Resolved；H1～H4、M1～M4均Resolved，无新增阻断问题。本结论仅表示设计文档静态审查通过；业务代码尚未实现，未运行产品测试、真实迁移或真实模型/工具联调。

### 最终复审证据摘要

- 独立确认8份文档、89个本地链接、59个代码行号、15个标题锚点。
- 独立内存SQLite启用FK执行7组SQL：新增四表、两Stop四条跨Session目标、8类非法写入拒绝、清理顺序及独立实例记录留存验证通过，foreign_key_check无行。此结果与上文修订者自检分开记录，不等于真实迁移或业务测试通过。

### 审查关闭依据

- admission发送前持久绑定；Stop同事务关闭固定root/nested集合；精确取消先安装tombstone。
- unknown屏障阻止恢复、旧证据不清新Stop、可信实例退出证明闭合；fallback与Git lease边界明确，N不混入停止目标数。


## 最终工程实现与独立全面复审归档

记录日期：2026-11-11。以下依据主助理明确转述的独立审查结果补录，不冒充归档者亲自执行独立审查，也不补造审查报告或未提供的测试日志。

> H2 Resolved；0038整体实现可交付；原H1／M1／M2／L1／L2保持Resolved，无新增问题，6/6关闭，Open 0。

### 审查层次与时间顺序

| 层次 | 结论与权威边界 |
| --- | --- |
| 设计静态审查 | 上述第四轮复审通过，仅关闭设计阶段H1～H5／M1～M4；问题编号属于设计审查作用域，不与下面工程问题混计 |
| S1～S7逐阶段代码审查 | 逐阶段实施和审查属于阶段证据，不能单独推出整体可交付；S1～S6已由主助理确认，S7历史送审前自测／待审查文字按当时状态保留，最终实现由下述全面审查覆盖，不补造各阶段未提供的会话或测试次数 |
| 全新全面new审查 | 以完整设计与实现为对象，首轮发现工程H1／M1／M2／L1／L2，结论未通过；S8修复及原会话复审后五项Resolved，但新增容量拒绝H2，整体仍未通过 |
| 原会话existing最终复审 | 在同一全面审查会话`sess_00mwb7zygi0000d610282e32ce`核验H2及既有已关闭项：H2 Resolved，五项保持Resolved，无新增问题，六项全部关闭，整体实现可交付 |
| 本次收尾验证 | 已获最终审查通过后，由实现方复跑同一生产／协议／测试源树完整八组、隔离build和真实浏览器；不是新一轮代码修改，也不替代或扩大reviewer的证据范围。实际命令／计数／限制见08第13节 |

### 六项关闭证据摘要

| 工程问题 | 最终状态 | 关闭依据摘要 |
| --- | --- | --- |
| H1 | Resolved | 普通／nested／fallback真实finally的固定Run＋instance退休通知，1024个活动预留＋pending身份上限、去重退避、shutdown drain；不保留已退出controller，不把DB terminal当退出，不越过未retired admission |
| M1 | Resolved | 新恢复操作在权威事务内先queueVersion CAS后Stop／profile；异步激活再次CAS；旧成功operation保持原动作＋fresh queue，无新增Run／错误副作用 |
| M2 | Resolved | DB仅持久最小幂等元数据；每Run冻结slot、16MiB／128MiB上限，无TTL偷淘汰；COMMIT后发布、安全释放、singleflight；旧finish独立重放，普通prepare内容丢失只expired |
| L1 | Resolved | abandon展示未确认全集数量与完整不可逆后果，携原version／hash；晚Session确认不误发操作、不静默删除／确认原User |
| L2 | Resolved | Stop pending／unknown明确分开，安全诊断与离线排他维护指引；quiescent后仍paused，queued数量独立，没有force-resume |
| H2 | Resolved | 持久HTTP200 rejected，两reason稳定同op重放；unknown取得权威拒绝后退出等待并failed＋paused，不覆盖既有prepare／finish，不误确认输入；原User可显式resume／abandon，无provider／tools／orphan，Stop迟到路径保持cancelled |

### 独立验证与限制

- 主助理确认reviewer独立执行**141项定向tests通过**，并跨层复核原16MiB／unknown／commitlost／Stoplate反例：1或2次同operation受控收敛failed／paused，原User可resume／abandon，无provider／tools／orphan；Stop仍为cancelled。
- 141是独立审查定向集合，不并入作者完整八组计数，也不将其描述为reviewer跑过真实managed Worker进程或真实browser；这两类真实环境证据由实现方另列。
- 不宣称实际用户DB升级、真实外部provider、人工多端／多标签协作与断网验收完成。历史内存DDL／fixture迁移、loopback fake provider、受控RPC、组件与真实Chromium各有证据边界。
- 本次仅README／07／08的状态、审查与验收metadata归档，无新规范／业务语义变化，无Git／stage／commit；最终暂存由主助理亲自核查diff后执行。

## Esc增量审查状态

> 本节及下一节保留首审时点历史；当前已复审通过，最终结论见文末“Esc增量最终独立复审通过”。

基线`15e2590`的最终通过结论仅覆盖该提交。本轮是新用户共识引起的交互与控制语义变化：固定ID clear、Stop原子清队列、持久Stop代际、发送统一启动及按钮／Placeholder改造。首审前作者4056项相关分组及Chromium19项通过仍不等于独立通过；本轮首审已执行且未通过，H1／M1／L1作者修复后待原会话复审，不提前关闭任何新问题。具体证据在08增量记录。


## Esc增量独立首审未通过及修复（待复审）

独立审查会话：`sess_00mwbkx46f00006b8334387035`。首审未通过，reviewer其余373项定向通过（API136／Web227／Shared10），7个额外场景中5个保护成立、2个复现同一H1。373与旧4056仅属首审／先前作者证据，不替代修复后验证。

| 编号 | 优先级／处置 | 作者修复，尚待reviewer确认 |
| --- | --- | --- |
| H1 | 高／Fix | 已有Session无scope匹配可信snapshot时不开始发送，不调用ensureSession，不发布sending副本；只刷新／提示且保留草稿File。同步冻结动作准入代际，composable缺字段直接拒绝，删除全部异步补取／替换。真正fresh draft创建路径在动作开始冻结共享INITIAL_STOP_GENERATION；ensureSession返回原ID不提交，保留父子Pane交接与scope检查 |
| M1 | 中／Fix | 06现行受理表、continue停止／预算表及Stop/inject断言改为新规则；明确用户Web Stop清queued，失败／预算暂停保留旧queued，并由安全的新发送恢复，不只依赖页首覆盖声明 |
| L1 | 低／Fix | 08仅保留单个末尾换行；以字节／空白检查验证，不执行Git |

fresh事实核查：生产AgentToolView仅对本地draft传sessionReady=false；ensureSessionCreated先匹配draft，随后调用createAgentSession POST创建primary，API SessionInteractionApplication.createSession分配全新ID。非draft只返回原ID，Pane不在该分支使用initial；消失draft返回原ID也被fresh guard拒绝。已有workspace/session请求scope保护继续保留，真实创建引起的旧Pane卸载仍通过原同步sending publication交接，不为修H1牺牲正常首发。

terminal-intent冲突由reviewer独立确认是既有安全拒绝且维持cancelled，本轮WontFix：不吞错、不放松终态规则，风险可接受，不作为新增未修复缺陷。H1／M1／L1仅作者已修复，不标独立Resolved；当前待原审查会话复审。修复后实际命令与计数见08后续记录。

## Esc增量最终独立复审通过

原审查会话`sess_00mwbkx46f00006b8334387035`明确复审通过；主助理已亲自核验`.tmp-tests/review-esc/re-review-summary.json`及关键代际准入代码，并确认Git diff空白检查通过。作者不冒充执行该Git核查，本轮未执行Git。

| 本轮问题 | 最终独立状态 |
| --- | --- |
| H1：发送代际晚绑定 | Resolved |
| M1：06现行验收表冲突 | Resolved |
| L1：08末尾空行 | Resolved |

- 本轮3/3关闭，Open 0，无新增问题；不与基线或设计审查的同名编号混计。首审未通过和修复过程保留在上文。
- reviewer独立339/339：API81＋Web238＋Shared11＋crossLayer6＋UI3；fail／cancelled／skipped均0。reviewer仅核读作者Chromium19项，未独立重跑，浏览器不计入339。
- 作者最终同源树五组4069/4069：Shared151、API unit1977（含root-cwd插件8）、完整61文件API integration596（并发2）、managed Worker36、Web1309（完整31组件）；fail／cancelled／skipped均0。另有root typecheck、API／Worker build、API test gate及harness strictcheck通过。命令及机器证据见[08最终归档](08-implementation-and-acceptance.md#16-esc增量最终独立复审通过与同源树归档)。
- 作者Chromium沿用修后`agent-queue-oQYzPB/result.json`，19/19且cleanup完成；本轮28份非文档正式文件匹配当时修复哈希，当前1430份源文件／配置before/after一致，不机械复跑浏览器。
- 本次只修改README／07／08状态metadata及07两个失效本地锚点；不修改生产／协议／测试语义。仅验证本轮相关五组，不扩称全仓八组；真实用户DB升级、外部provider联调、人工多端／断网验收不在结论范围。临时gate首次cwd错误及旧外部重定向偏差在08如实归档。
