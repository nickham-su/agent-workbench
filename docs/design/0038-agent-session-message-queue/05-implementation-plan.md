# 开发任务与详细实施步骤

## 当前实施状态（2026-11-10，S8后H2增量）

S8五项修复已获复审Resolved；新增H2容量拒绝高阻断的最小增量修复与验证见文末及08第12节。仅H2需交父任务复用原existing审查会话复审，以下S7／S8状态保留为历史记录。

### S7作者记录

主助理已确认S1～S6完成阶段独立审查并暂存，Web／生产消息队列已经启用；S7作者自测完成：原八组5786例通过，追加BROWSER-1最小生产修复后Web1293例与两轮真实Chromium A-COUNT通过；尚待本阶段独立代码审查及最终全面对照方案审查。下文代码地图、各阶段“未运行”“待复审”等表述保留其历史时点，不是当前总状态。最终命令、覆盖与未执行的人工验收统一见[实现与验收](08-implementation-and-acceptance.md)，本阶段记录见文末。

## 已核验代码地图

路径均相对仓库根，链接从本设计目录定位；行号反映编写时现状，新增符号不声称已实现。

| 现有代码 | 已核实行为／本次修改点 |
| --- | --- |
| [agent.worker-client.ts:169](../../../apps/api/src/modules/agent/agent.worker-client.ts#L169) | cancelSession吞传输／超时，不能作为停止成功；新增精确RPC有类型pending/unknown |
| [runner.ts:1841](../../../apps/agent-worker/src/runtime/runner.ts#L1841) | Session级取消当前controller并清queue，迟到可伤新Run；新协议固定runId+tombstone |
| [runner.ts:1873](../../../apps/agent-worker/src/runtime/runner.ts#L1873) | 旧cancelSessionAndWait只等bookkeeping；新增nested覆盖和精确finally证据 |
| [agent.worker-manager.ts:48](../../../apps/api/src/modules/agent/agent.worker-manager.ts#L48) | ChildLifetime为内存生命周期原语，不是持久运行身份；窄扩展可信UUID／退出证据 |
| [agent.worker-manager.ts:237](../../../apps/api/src/modules/agent/agent.worker-manager.ts#L237) | 现有spawn有analytics UUID，不能直接当停止身份；新增专用实例握手及持久登记 |
| [agent.worker-manager.ts:279](../../../apps/api/src/modules/agent/agent.worker-manager.ts#L279) | 精确ChildProcess exit回调可作真实退出观察；新增先持久证据再解除屏障 |
| [analytics.routes.ts:30](../../../apps/api/src/modules/analytics/analytics.routes.ts#L30) | 已有路由级Value.Check校验，避免默认AJV静默移除额外字段；新Stop/Abandon沿用方式实现严格body，不全局改AJV |
| [session-interaction-application.ts:172](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L172) | sendMessage在197行运行中409；新增独立acceptUserMessage，不直接删除旧语义 |
| [session-interaction-application.ts:229](../../../apps/api/src/modules/agent/session/session-interaction-application.ts#L229) | revert运行中限制；补queued和未确认输入冲突 |
| [sqlite-run-lifecycle-persistence.ts:78](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L78) | 权威激活事务再次校验idle；扩展队列触发激活 |
| [sqlite-run-lifecycle-persistence.ts:137](../../../apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts#L137) | attachment登记及user/Run写入；拆出可复用权威原语，不复制整套规则 |
| [run-lifecycle-application.ts:120](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts#L120) | enqueue未知结果与对账；新队列激活复用稳定Run |
| [run-lifecycle-application.ts:164](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts#L164) | 附件prepare及失败诊断；本次不得把Workspace removeFinal当作可安全GC |
| [run-lifecycle-application.ts:361](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts#L361) | 先DB terminal/converge再runtime cancel；短时handoff不足以证明退出，必须同事务停止屏障 |
| [run-lifecycle-application.ts:415](../../../apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts#L415) | 启动恢复把未完成Run标失败，不是工具checkpoint续跑 |
| [agent-message.store.ts:230](../../../apps/api/src/modules/agent/agent-message.store.ts#L230) | head/revision与Run fence；队列注入必须遵守 |
| [agent-message.store.ts:883](../../../apps/api/src/modules/agent/agent-message.store.ts#L883) | 压缩提交CAS；加入未确认输入保护边界 |
| [agent-message.store.ts:1718](../../../apps/api/src/modules/agent/agent-message.store.ts#L1718) | completeTerminalAssistantWithIntent同事务完成Assistant和terminal intent；交互Run新增裁决，不破坏旧replay |
| [runtime-transcript-projector.ts:103](../../../apps/api/src/modules/agent/read-side/runtime-transcript-projector.ts#L103) | 图片只对triggerMessageId真实投影；改为可信Run输入集合 |
| [runtime-transcript-projector.ts:141](../../../apps/api/src/modules/agent/read-side/runtime-transcript-projector.ts#L141) | 工具调用与结果按完整轮次投影 |
| [model-context-resolver.ts:973](../../../apps/api/src/modules/agent/read-side/model-context-resolver.ts#L973) | 未闭合工具Assistant作为截断边界；队列不能绕过 |
| [runner.ts:1437](../../../apps/agent-worker/src/runtime/runner.ts#L1437) | 工具批次；连续可并发工具分组，非所有工具均并发 |
| [runner.ts:2378](../../../apps/agent-worker/src/runtime/runner.ts#L2378) | Promise.allSettled等待批次；executePendingTools执行全部批次 |
| [runner.ts:3584](../../../apps/agent-worker/src/runtime/runner.ts#L3584) | 无工具完成条件、终态重试与未知提交处理 |
| [runner.ts:3859](../../../apps/agent-worker/src/runtime/runner.ts#L3859) | 每轮重读PromptContext；自然安全准备接入点 |
| [runner.ts:3891](../../../apps/agent-worker/src/runtime/runner.ts#L3891) | 自动压缩；协调先压缩旧前缀再注入 |
| [runner.ts:3932](../../../apps/agent-worker/src/runtime/runner.ts#L3932) | 最大步数停止；不能因新消息重置 |
| [runner.ts:3955](../../../apps/agent-worker/src/runtime/runner.ts#L3955) | terminal intent后只收敛；不能再continue |
| [agent.runtime.ts:80](../../../apps/api/src/modules/agent/agent.runtime.ts#L80) | 本地fallback仅回显，不是完整模型工具执行；需要最小协议适配 |
| [agent.module.ts:50](../../../apps/api/src/modules/agent/agent.module.ts#L50) | Worker ready恢复顺序；新增推进器放在恢复后 |
| [agent.module.ts:100](../../../apps/api/src/modules/agent/agent.module.ts#L100) | 路由和服务生命周期组合点，参考定时任务但不复用其业务语义 |
| [agent-public.routes.ts:765](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts#L765) | 旧JSON/multipart发送及临时文件清理；新增receipt路由 |
| [agent-worker.routes.ts:239](../../../apps/api/src/modules/agent/routes/agent-worker.routes.ts#L239) | 旧terminal内部RPC及token校验；新增交互RPC须同等保护 |
| [agent-peripheral.routes.ts:200](../../../apps/api/src/modules/agent/routes/agent-peripheral.routes.ts#L200) | 插件强制触发旧sendMessage；保持原runId响应 |
| [agent-attachment-limits.ts:3](../../../apps/api/src/modules/agent/attachments/agent-attachment-limits.ts#L3) | 既有4张／10MiB／20MiB限制 |
| [agent-attachment-storage.ts:280](../../../apps/api/src/modules/agent/attachments/agent-attachment-storage.ts#L280) | 可信附件发布；扩大业务引用识别，不绕过安全目录 |
| [agent.ts:367](../../../packages/shared/src/contracts/agent.ts#L367) | 旧响应必有messageId/runId；新增独立收件响应 |
| [api.ts:1350](../../../apps/web/src/shared/api/api.ts#L1350) | Web JSON/multipart API client迁移 |
| [AgentClientPane.vue:975](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue#L975) | 现有运行中800ms轮询；新增队列独立快照 |
| [AgentClientPane.vue:1083](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue#L1083) | timeline按消息revision拉delta；不能承担queue计数 |
| [AgentClientPane.vue:1643](../../../apps/web/src/features/workspace/tools/agent/AgentClientPane.vue#L1643) | 发送成功登记Run；区分receipt受理与实际Run |
| [schema.ts:965](../../../apps/api/src/infra/db/schema.ts#L965) | Session消息head/root/revision，无收件实体 |
| [schema.ts:1127](../../../apps/api/src/infra/db/schema.ts#L1127) | client_request只能表示已激活message/run，不适合queued |
| [schema.ts:876](../../../apps/api/src/infra/db/schema.ts#L876) | schema分类器；显式非破坏迁移是必做项 |
| [workspace.service.ts:601](../../../apps/api/src/modules/workspaces/workspace.service.ts#L601) | Workspace删除准入、持久意图、fence及排空 |
| [workspace-agent-data-cleanup.ts:9](../../../apps/api/src/infra/db/workspace-agent-data-cleanup.ts#L9) | 数据清理FK顺序；加入新队列表与附件引用 |
| [agent-message.store.ts:765](../../../apps/api/src/modules/agent/agent-message.store.ts#L765) | replaceStreamingAssistant换ID；同事务继承输入绑定、阻止旧确认 |
| [runner.ts:2765](../../../apps/agent-worker/src/runtime/runner.ts#L2765) | recovery replace/resume需校验实际输入快照 |
| [runner.ts:3085](../../../apps/agent-worker/src/runtime/runner.ts#L3085) | 普通provider retry替换Assistant，不得丢绑定 |
| [runner.ts:2528](../../../apps/agent-worker/src/runtime/runner.ts#L2528) | 自动压缩使用lastResponseTotalTokens，并非当前完整预算 |
| [runner.ts:2707](../../../apps/agent-worker/src/runtime/runner.ts#L2707) | 动态工具在Worker发现，API无工具影子 |
| [runner.ts:1007](../../../apps/agent-worker/src/runtime/runner.ts#L1007) | maxOutputTokens读取aiSdk后兼容顶层；本次需显式缺省输出预留 |
| [estimator-v1.ts:165](../../../apps/agent-worker/src/runtime/compaction/estimator-v1.ts#L165) | 字节/3+固定成本+10%，图片1024；不是精确完整公式 |
| [planner.ts:81](../../../apps/agent-worker/src/runtime/compaction/planner.ts#L81) | 现状固定保留尾部；新增未确认硬保护 |
| [primary-materializer.ts:89](../../../apps/agent-worker/src/runtime/compaction/primary-materializer.ts#L89) | trigger-only图片分支，必须与主投影／source同源改造 |
| [settings.ts:36](../../../packages/shared/src/contracts/settings.ts#L36)及[settings.ts:62](../../../packages/shared/src/contracts/settings.ts#L62) | maxOutputTokens可选、contextWindowTokens必填正整数；新增预算不得猜窗口 |
| [agent-attachment-storage.ts:374](../../../apps/api/src/modules/agent/attachments/agent-attachment-storage.ts#L374) | Workspace removeFinal明确拒绝unlink，不存在安全自动GC保证 |
| [agent.module.ts:126](../../../apps/api/src/modules/agent/agent.module.ts#L126) | fallback恢复在API onListen；新推进器须等待此屏障 |

本次未在docs、apps、packages下发现局部AGENTS；遵循仓库根AGENTS。未读取本地敏感配置，未运行测试。

## 实施策略

- schema/协议先兼容增加，Web最后切换；所有边界闭合前不让新流量创建交互Run。
- 原业务规则保持唯一实现。fallback通过相同服务端原语，不建第二套队列／重试框架。
- 设计第四轮独立复审已通过，H1～H5、M1～M4均Resolved；历史轮次与最终结论见[审查记录](07-review-record.md)。实施按依赖执行：P-INPUT → P-LOOP → P-RECOVER，三者整体闭合后才启用Web新入口，不机械按章节顺序开放功能。

## P-CONTRACT：契约、schema与约束

前置：文档复审通过。

- 新增receipt/control/operation、确认字段与来源、abandoned、Run输入关联及Assistant binding/集合。
- 增加03的runtime_instance/run_runtime_admission/stop_barrier/stop_target、作用域FK／索引／证据字段；Run创建至物理enqueue前的绑定CAS可执行，未知旧协议运行不得伪装成未执行。
- 按实体DDL建立全部复合父键／FK；运行真实插入、scope mismatch、NULL约束及foreign_key_check。
- publication_intent进入DataDir基础schema，不被Workspace级联或Agent域重建清除；版本与canonical分类器同步。
- 显式非破坏升级保留历史、旧client_request、可见性；旧Run标志0，不伪造确认或历史留存额度。

验证：shared build/typecheck、真实SQLite DDL、升级中断与未知schema拒绝。完成条件：不存在foreign key mismatch，老数据不丢。

S1实现记录：schema由25增量升级到26；23／24依次无损升级，旧Run的interactive_queue_enabled=0且不伪造admission。新增Text主键显式NOT NULL、队列序列／版本限制为安全整数，防SQLite的NULL／REAL旁路。独立publication/runtime表不参与Agent域重建；S1仅交付契约和实体，尚未注册路由、启动推进或切换Web。

## P-RETAIN：发布预留与安全保留

前置：P-CONTRACT。

- 实现DataDir 1GiB独立SUM额度、整个请求原子reservation和发布前持久publishing CAS。
- 复用安全temp与发布器；receipt事务失败不回滚reservation，不unlink已发布Workspace文件。
- 同request复用intent；未知不重新发布、额度保留；只有证明未发布才释放，已发布仅离线排他维护可对账。
- 新增安全留存查询、507/409诊断和已取消／放弃／逻辑删除记账，禁止用pendingBytes释放留存额度。
- 不实现危险删除工具；离线维护状态／审计可表达，原意图墓碑不能删。

验证：并发额度、发布前／中／后崩溃、回滚、重传、取消循环、same-UID替换、逻辑删除。完成条件：没有自动Workspace unlink，未知仍计额且总额不超1GiB。

### S2实施接入记录

- `attachments/agent-attachment-publication.store.ts`实现整个请求的独立预留、发布前CAS、原始文件身份与SHA-256关联、恢复与安全额度快照。权威上限复用S1共享常量`AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES`，不另设重复常量。
- `AgentAttachmentPublicationService.publishAndCommit(request, commit)`在Workspace mutation围栏内准备／发布，`commit`必须同步创建真实receipt及附件关联并返回`{ receiptId, value }`；原始reservation与publishing均在该业务事务之前独立提交，失败不删除Workspace文件。若已受理，回调收到`existingReceiptId`并只读返回原收件；已取消收件也不重建引用。
- 新请求使用`stageAgentImageUpload`新增的`byteSha256`；相同请求的新随机temp／attachment ID不替换既有发布身份。publisher的可选`expectedContent`只增强新路径，旧调用保持兼容；按固定fd校验摘要，不能以同inode代替同内容。
- `getRetention/getRequestStatus`只给后续服务复用，未注册公共路由。`recoverPreviousPublishers`需在新API生命周期准入前调用；旧reserved可由持久CAS证明未发布，旧publishing仅转未知留存，不重发。
- 原始temp在关闭publisher后沿用安全私有清理；逻辑Workspace清理只标记独立账本留存。无在线离线释放修改接口；人工排他维护与审计墓碑仍按03约束，状态／审计读取可表达。

## P-STOP-BARRIER：固定目标、运行身份与停止确认（H5）

前置：P-CONTRACT；新Stop／旧取消入口开放前必须完成，不以全Worker重启替代。

- Manager每次spawn专用UUID、持久starting/ready握手；ChildLifetime精确exit见证落盘，fallback每次API实例UUID。退出证据丢失保留unknown，不读analytics快照或私有epoch猜测。启动恢复对旧未retired admission补建尚无覆盖的固定目标恢复Stop，不以DB失败替代停止证据。
- 所有root/nested/queued派生和旧入口创建Run时写admission；实际enqueue前事务绑定可信实例，并校验父Run、祖先／目标Session屏障；Stop先关闭与enqueue先绑定两方向均无遗漏。
- Stop事务按权威cascade及未retired admission收集固定目标，写独立operation/barrier/targets、暂停版本和DB终态；新Stop复制同root未解除目标，不改变旧集合。target Session也暂停和围栏，不只root。
- 共享包新增04精确RPC；Worker runId级registry覆盖nested，先安装实例内永久tombstone再精确移除／abort／等待finally；本地登记与取消串行，无异步校验后迟到注册漏洞。禁止Session级重选／清全queue。
- 实现pending/unknown/quiescent及严格证据幂等、实例不匹配零取消；超时／连接失败显式unknown。API后台有界调解只重试原operation+实例+targets，公开旧Stop只重放。
- 匹配证据逐目标／逐barrier事务解除，更新所有受影响Session可见版本，仍paused；新resume/abandon及旧强制／历史入口共用事务围栏，不允许只做前端禁用。
- fallback按runId清队列／等finally；Worker ready与API onListen恢复旧屏障，关闭先停admission／推进、持久未知／退出证据，再停调解与DB。
- 保留Git processStopConfirmed=false的lease/unknown和删除保护，不追杀逃逸进程或回收不支持abort的远端工具；离线退出证据路径写明排他和核验，禁止在线force-resume。

验证：执行A-STOP-BARRIER全部确定性交错，特别DB terminal但Runner未退、丢响应／超时、迟到cancel/enqueue、nested、实例换代与重启未知、fallback和Git lease。完成条件：屏障未解绝不新执行，解后仍暂停，旧取消永不作用新Run，未知不伪成功。


### S3实际实施记录（2026-11-10）

**范围**：P-STOP-BARRIER的生产接入、恢复、精确停止、历史围栏与验证；保留S1/S2，不开放P-ACCEPT的receipt/resume公共路由，不切换Web／飞书／IM。未执行Git命令、暂存或提交，不安装依赖。

#### 实现与接口

- `AgentRuntimeControlStore`是持久admission／固定Stop集合／屏障证据的唯一事务实现。Run创建事务登记unbound；物理enqueue前绑定可信ready实例；nested返回Worker前绑定父实例，reused终态子Run不重新绑定。父Run、祖先admission、删除围栏及root／target屏障均检查。
- `listCurrentRunScopesForStop`复用既有当前根Run及parentRunId子树权威，供旧取消选择与Stop共用。只关闭该当前树的unbound；额外合并根lineage中**已绑定且未retired**的旧执行，以及同root原未解除targets。历史child仅DB running、从未bind/enqueue，不被当作旧runtime执行，也不被误取消或暂停。取消事务固定runId，不再通过历史Session反扫全部Run。
- Stop单事务完成admission关闭、operation/barrier/targets、Session暂停／queueVersion和既有终态intent/converge。事务外发布已收敛事件；正常completed意图不被覆盖。纯unbound关闭后在同事务退休，稳定结果`notAdmittedRuns`保留从未发送的证明，永久不可重开。旧operationId仅稳定重放，不重新选目标、不主动发送取消。
- shared的`AgentRunStopRegistry`覆盖root／nested／queued，使用精确token交接及实例寿命永久tombstone。异步admission之后、登记之前重新同步检查；queued→active不覆盖其他注册。精确RPC先验证实例、可信binding、完整固定集合hash，再安装tombstone／精确abort并等待真实finally。hash使用逐字段原值UTF-8字节序排序，不能使用拼接分隔符排序。
- Manager每次spawn生成独立runtime UUID及spawnNonce，持久starting及父进程观察时刻；认证握手校验UUID／协议后才ready。原ChildProcess的真实exit回调持久证明，owner／nonce／PID／spawn时间必须匹配。失败握手不开放恢复／admission；退出证明落盘失败不能作成功。fallback独立UUID，只有真实drain完成才写local_shutdown。
- **设计小幅调整**见03：在线使用UUID＋spawnNonce＋PID／实际spawn观测时刻＋原ChildProcess句柄，不新增/proc读取或原生依赖；OS boot ID／process start identity只作为离线可记录的增强证据，不假称生产采集。API重启缺原退出证明持续unknown，不用新ready、PID消失或Analytics推断。offline_exit严格校验originalProcessIdentity的形状及值，要求maintenanceId、observer、exclusiveMaintenance、verification与观察时间；仅供排他维护的内部事务复用，没有在线force-resume／退出证明HTTP入口。
- 启动遵循原生产生命周期：pre-listen不执行全局runtime恢复、不收敛现存Run／queued工具且admission关闭；fallback在真实onListen恢复，Worker在可信ready后恢复。testkit显式listen loopback并等待同一生产恢复屏障，观察器本身不能提前启动恢复；需要固定回调端口的fixture由调用方显式listen。
- 调解采用单API内存游标，按不可变operation键轮转，每轮最多32项／1秒、每root Session至多一实例组，组间轮转，500ms～30秒有界指数退避；首页长期unknown不会饿死后续operation。重启丢失游标只重排尝试，不改变持久集合。RPC单次等待100ms，网络请求有额外有限传输预算。
- 关闭先停admission／scheduler，持久Stop后fallback最多drain 1秒，超时持久unknown、不造退出凭证；tombstone阻止迟到context写历史，生命周期关闭后retirement callback不晚写DB。Worker正常完成后的异步retire仅更新admission元数据，不承担历史／工具写回，未retired反而保守阻止遗漏旧执行。
- 围栏覆盖Run创建／启动／激活、父子创建、revert、moveHead、普通／stable／historical fork及手动标题。历史CAS先校验旧版本冲突，再检查屏障，均在同事务写入前完成。保留安全只读、fenced终态收敛及幂等写回；未机械围栏appendMessage或内部工具写回。
- Workspace清理拒绝未解除barrier／未退休bound admission，按FK顺序清理队列实体，保留独立runtime实例与S2 publication账本。Git真实fixture已跑到`processStopConfirmed=false`、ToolExecution unknown、unconfirmed filesystem lease及`REPO_GIT_BUSY`断言；Runner quiescent不清Git未知／lease或删除保护。

后续阶段可复用：`store.stop`／`control.stopSession`、`assertSessionRuntimeUnblocked`、稳定`RuntimeStopRecord`及DB barrier/target快照；受理结果不能与当前屏障状态混为一体。

#### 回归处置

- 保留CLI“取消当前树，不取消历史unbound child”的原保护断言，修复目标收集回归；新增历史child确实bound且DB已completed但runtime未退的确定性用例。
- idle-root fixture改为先建立running根／子／孙，再通过正常terminal intent＋converge结束根；保留原历史子孙不被取消的断言，没有放宽父admission检查。
- 保留原pre-listen保护断言，并新增listen之前不能物理绑定／发送、listen之后恢复Run／queued工具并开放新执行的验证；不为inject改变生产恢复时序。
- 已知`context-writeback-application.test.ts`遗漏`modelRequestError:null`的旧期望保留S7处理，不修改该断言。它是最终API unit唯一失败，不是本阶段新增回归。
- 全量integration的默认高并发运行曾触发Analytics冷路径耗时断言（2232ms超过2000ms）；未修改断言或扩大产品范围，单文件10/10通过，最终同一全量测试集合以`--test-concurrency=4`重跑567/567通过。

#### 最终自测（本次代码最终状态）

所有命令均设置仓库内`TMPDIR=<repo>/.tmp-tests`及`TSX_DISABLE_CACHE=1`；以下按流水线顺序执行，没有shared clean build与依赖dist的测试并行。

| 验证 | 命令／范围 | 确切结果 | 日志（仓库内） |
| --- | --- | --- | --- |
| shared构建 | `npm run build -w packages/shared` | 通过 | `.tmp-tests/s3-final-shared-build.log` |
| 核心确定性交错／协议／生命周期 | API cwd下`tsx --test`：runtime-control、runtime-stop-registry、worker-client、worker-manager.lifecycle、startup-recovery integration | 66/66 | `.tmp-tests/s3-final-core.log` |
| Worker全测 | `npm run test -w apps/agent-worker` | 1312/1312 | `.tmp-tests/s3-final-worker-all.log` |
| 全局类型检查 | `npm run typecheck`（含shared重建、CLI／Worker／API／Feishu／Web） | 全部通过 | `.tmp-tests/s3-final-global-typecheck.log` |
| API gate | API cwd：`node scripts/verify-test-gate.mjs` | 通过 | `.tmp-tests/s3-final-api-gate.log` |
| API unit主集合 | API cwd：`npm run test:unit` | 1876项，1875通过，唯一失败为上述S7旧期望；exit=1如实保留 | `.tmp-tests/s3-final-api-unit.log` |
| API unit的根cwd集合 | 仓库根：`tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | 8/8；主集合遇已知失败会提前结束，故显式补跑 | `.tmp-tests/s3-final-root-plugin-unit.log` |
| API全量integration | 与`run-tests.mjs integration`相同文件集合，API cwd：`tsx --test --test-concurrency=4 <全部integration文件，排除独立managed Worker文件>` | 567/567；CLI保护断言、pre-listen／listen、历史fork、subtask、Workspace清理／重启均通过 | `.tmp-tests/s3-final-api-integration.log` |
| 真实API-managed Worker全量integration | API cwd：`node scripts/run-tests.mjs worker` | 20/20；真实Worker进程／工具第二轮模型／调度／压缩链路 | `.tmp-tests/s3-final-managed-worker.log` |

结论：S3实现与必要回归修复已完成，可交独立审查；不表示S4～S7或整个消息队列功能已交付。唯一保留项是父任务明确安排S7的旧unit断言漂移，未以改旧保护断言掩盖取消／启动回归。

#### S3确切变更文件清单

下列路径相对仓库根；包含生产代码、受本阶段真实listen生命周期影响的测试装配及设计记录，不包含dist、临时日志或S1/S2独立成果。

```text
apps/agent-worker/src/config/env.ts
apps/agent-worker/src/main.ts
apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/runner.stop.test.ts
apps/agent-worker/src/runtime/runner.ts
apps/agent-worker/src/server.test.ts
apps/agent-worker/src/server.ts
apps/api/src/infra/db/workspace-agent-data-cleanup.ts
apps/api/src/modules/agent/agent-message.store.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/agent.module.ts
apps/api/src/modules/agent/agent.runtime.ts
apps/api/src/modules/agent/agent.worker-client.test.ts
apps/api/src/modules/agent/agent.worker-client.ts
apps/api/src/modules/agent/agent.worker-manager.lifecycle.test.ts
apps/api/src/modules/agent/agent.worker-manager.ts
apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts
apps/api/src/modules/agent/integration/agent-cli-head-replacement.integration.test.ts
apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts
apps/api/src/modules/agent/integration/agent-events-sse.integration.test.ts
apps/api/src/modules/agent/integration/agent-hidden-events-sse.integration.test.ts
apps/api/src/modules/agent/integration/agent-session-activity-query.integration.test.ts
apps/api/src/modules/agent/integration/agent-startup-recovery.integration.test.ts
apps/api/src/modules/agent/integration/agent-subtask-source-worker.integration.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts
apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts
apps/api/src/modules/agent/runtime-control.test.ts
apps/api/src/modules/agent/runtime-control/runtime-control.routes.ts
apps/api/src/modules/agent/runtime-control/runtime-control.service.ts
apps/api/src/modules/agent/runtime-control/runtime-control.store.ts
apps/api/src/modules/agent/runtime-stop-registry.test.ts
apps/api/src/modules/agent/startup/agent-runtime-readiness.ts
apps/api/src/modules/agent/subtask/subtask-wiring.test.ts
apps/api/src/modules/agent/testkit/agent-integration-testkit.ts
apps/api/src/modules/agent/testkit/agent-testkit.ts
apps/api/src/modules/workspaces/workspace-media.routes.integration.test.ts
apps/api/tests/agent-tab-client.integration.test.ts
apps/api/tests/reasoning-provider-http-tool.integration.test.ts
docs/design/0038-agent-session-message-queue/03-architecture-and-data-model.md
docs/design/0038-agent-session-message-queue/05-implementation-plan.md
docs/design/0038-agent-session-message-queue/06-testing-and-acceptance.md
packages/shared/package.json
packages/shared/src/internal-contracts/agent-api-queue.ts
packages/shared/src/internal-contracts/agent-worker.ts
packages/shared/src/internal-contracts/endpoints.ts
packages/shared/src/node/agent-run-stop.ts
```

#### S3首轮独立审查修复记录（2026-11-10，H1／M1）

**审查处置**：首轮独立审查**不通过**，H1／P1与M1／P2均选择Fix。上文“最终自测”及当时可审查结论属于**首轮提交基线**，不代表本轮修复后的验证；以下单独记录本轮结果。保留S1／S2，不开放S4 receipt／resume公共路由，不切换Web／飞书／IM；未执行Git命令、不安装依赖。

**H1／P1：pump二次admission异常丢失Runner**

- 原因：第一次enqueue admission成功后，pump的第二次查询抛错落在`processRun`外，最终清除controller／registry并留下永久tombstone，但DB仍running且retire不能成功。
- 修复：控制面查询没有明确结果时持续保留activeCount、精确registry token和controller，按100ms起步、最大5000ms的指数退避重试；等待次数不设终止上限，但每次退避有上限，直到明确允许／拒绝或精确Stop。异常不会被解释成权威拒绝，不计入Provider重试；仅首次记录固定安全warning。
- 在途admission查询使用可abort的等待包装。Stop可结束tracked promise并执行真实finally；底层迟到只读查询的成功／失败已有handler承接，不能进入业务执行或写回。最终执行前再次同步检查signal／tombstone。
- `pending → quiescent`不是只改预期：确定性测试先保持原查询未返回，再Stop，断言activeCount=0、registry.size=0且Session controller已移除，证明tracked promise确已退出。随后在**同一Session**启动后继Run，在旧查询迟到允许／抛错两种情况下验证旧Run重入被拒、旧Stop proof稳定、后继controller身份不变且未abort、后继registration仍为1并能正常完成。原“工具忽略abort时保持pending直到真实finally”的保护测试保留并通过。
- 真实SQLite＋真实Worker Runner覆盖恢复执行、退避中Stop、恢复后明确拒绝三种交错；终态幂等、迟到enqueue拒绝，不再出现DB running而Runner已丢失且永久拒绝的状态。额外验证连续异常的退避为100／200／400／800／1600／3200／5000／5000／5000ms，期间始终tracked。

**M1／P2：runtime recovery已收敛Run被原lifecycle扫描漏掉**

- 原因：runtime-control在Stop事务内直接调用store convergence，原startup lifecycle之后只扫描running Run，导致真实transition的完成事件和prompt cache清理都遗漏。
- 修复：`settleClosedRuns`返回真实convergence result及Run scope／时间；`recoverUnretired`在每个独立Stop事务提交后立即回调，service将结果交给composition绑定的`RunLifecycleApplication.publishCommittedTerminalConvergence`。该入口仅对transitioned复用原唯一`publishTerminalConvergence`，不建立平行事件／缓存规则，不改变原convergence入口的兼容语义。
- normal service Stop也在提交后调用同一入口；operation replay不重新发布。exit／proof路径仅更新实例、屏障和admission元数据，不新增终态事件规则。拒绝在调用者外层事务内执行service Stop／recover，避免把savepoint完成误当提交。
- 验证SQLite回滚无发布、外层事务拒绝、前一个candidate提交后的发布不因后一个candidate失败而丢失；修复后重试仅发布余下transition，重复recover不再发布或清缓存。
- 新增真实同API managed Worker重启集成：保持原API、DB、lifecycle与SSE连接，给待恢复Run绑定原ready UUID，令实际Worker进程退出，经过原ChildProcess exit、自动重启、认证身份握手和生产onReady恢复；观测包装均调用原实现，不替换恢复逻辑。source模式从项目内Worker PID文件选择实际Worker，而不是只杀tsx launcher。
- 该集成证明recovery的transitioned完成事件**1次**、prompt cache清理**1次**，原SSE连接收到同一eventId；回调时`db.inTransaction=false`且Run已terminal。捕获同一生产runtime-control实例再次recover两次，并执行既有startup recovery，额外事件／清理均**0次**。同一装配继续验证normal Stop、Stop重放及后续public cancel不双发，exit／proof reconciliation不另发终态事件。

**本轮确切修改文件（相对仓库根，共11个）**：

```text
apps/agent-worker/src/runtime/runner.ts
apps/agent-worker/src/runtime/runner.stop.test.ts
apps/api/src/modules/agent/runtime-control/runtime-control.store.ts
apps/api/src/modules/agent/runtime-control/runtime-control.service.ts
apps/api/src/modules/agent/runtime-control.test.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/agent.module.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
docs/design/0038-agent-session-message-queue/05-implementation-plan.md
```

**本轮实际验证**：所有测试设置仓库内`TMPDIR=<repo>/.tmp-tests`、`TSX_DISABLE_CACHE=1`。本轮未改shared源码，无shared clean build与依赖dist的测试并行；以下不是重用上文历史日志。

| 验证 | 命令／范围 | 本轮结果 | 日志（仓库内） |
| --- | --- | --- | --- |
| Worker Stop确定性交错 | 根cwd：`tsx --test apps/agent-worker/src/runtime/runner.stop.test.ts` | 9/9 | `.tmp-tests/s3-review-runner-stop-final.log` |
| 核心协议／交错／生命周期／启动 | API cwd：`tsx --test`：runtime-control、runtime-stop-registry、worker-client、worker-manager.lifecycle、runtime-ready、startup-coordinator、run-lifecycle-application、startup-recovery integration | 106/106 | `.tmp-tests/s3-review-core-final.log` |
| 真实重启定向回归 | API cwd：`tsx --test --test-name-pattern='same live API' src/modules/agent/agent.worker.integration.test.ts` | 1/1；亦由下方全量managed Worker集合再次覆盖 | `.tmp-tests/s3-review-worker-restart-3.log` |
| API类型检查 | `npm run typecheck -w apps/api` | 通过 | `.tmp-tests/s3-review-api-typecheck-final.log` |
| Worker类型检查 | `npm run typecheck -w apps/agent-worker` | 通过 | `.tmp-tests/s3-review-worker-typecheck-final.log` |
| Worker全测 | `npm run test -w apps/agent-worker` | 1316/1316 | `.tmp-tests/s3-review-worker-all.log` |
| API gate | API cwd：`node scripts/verify-test-gate.mjs` | 通过 | `.tmp-tests/s3-review-api-gate.log` |
| API unit主集合 | API cwd：`npm run test:unit` | 1883项，1882通过；唯一失败仍为S7旧期望，exit=1如实保留 | `.tmp-tests/s3-review-api-unit.log` |
| API unit根cwd集合 | 根cwd：`tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | 8/8；主集合已知失败会提前退出，故显式补跑 | `.tmp-tests/s3-review-root-plugin-unit.log` |
| API全量integration | API cwd：与`run-tests.mjs integration`相同文件集合，`tsx --test --test-concurrency=4`，排除独立managed Worker文件 | 567/567；含CLI cancel树／历史负对照、pre-listen／listen、runtime与Workspace保护 | `.tmp-tests/s3-review-api-integration.log` |
| API-managed Worker全量integration | API cwd：`node scripts/run-tests.mjs worker` | 21/21；包含新增同API真实重启回归 | `.tmp-tests/s3-review-managed-worker.log` |

**验证过程说明**：最初Worker定向测试出现旧`pending`预期与真实`quiescent`差异，已按上述registry／后继Run证据解决而非仅改断言。最初新增SQLite测试的适配器误用同步enqueue，未走生产HTTP入口的首次admission，造成等待闸门不释放；已改为调用真实`enqueueRunAdmitted`并完成全量回归。真实重启测试最初只结束tsx launcher导致身份不匹配，已改为实际Worker崩溃路径，保留身份校验和原exit证明，未修改Manager生产逻辑。

**未处理项**：`context-writeback-application.test.ts`旧期望遗漏`modelRequestError: null`，按父任务安排保留S7；本轮未改该断言，也未降低任何旧停止／启动／CLI保护断言。

**复审交接**：H1／M1修复与上述必要验证完成，可提交原独立审查会话`sess_00mwanuefh00009c4272cba95d`使用existing续审；本记录不是独立复审通过结论，不表示S4～S7或整个消息队列交付。

## P-ACCEPT：受理、取消与控制

前置：P-RETAIN及P-STOP-BARRIER。

- 新receipt应用服务／路由，校验访问、删除围栏、身份及pending容量，不在API假装精确token预检。
- 收件hash去重与新旧命名空间冲突、FIFO序号、queueVersion同事务。
- 新查询／详情／受控图片／cancel/stop；DB-first暂停、固定目标和停止屏障同事务；稳定受理结果与当前stop快照分离。
- Stop body无expectedQueueVersion，路由级同schema校验拒绝多余字段；全新operationId按当前执行持久暂停；旧ID只重放不重复runtime cancel。resume/abandon才做版本CAS，保留正常终态与fence；handoff只短时互斥，持久停止证据才可解除屏障。
- 补旧入口queued/paused检查；设置新共享响应和安全错误枚举。

验证：每个202有receipt，busy受理，pause不复活，取消／注入竞争，未知受理查询。完成条件：响应不伪造runId，控制/计数准确。

## P-DISPATCH：普通激活、故障与双运行时屏障

前置：P-ACCEPT。

- 普通激活先事务检查无停止屏障并登记／绑定admission，原子注入trigger并建唯一交互Run；复用enqueue未知状态对账，不新建第二Run。
- 后台只自动推进active且无未确认正式输入的queued；失败恢复暂停。
- Worker ready路径先恢复删除围栏／DB旧Run及停止屏障，再启动调解／无屏障推进；fallback API onListen同样等待本地屏障恢复。新实例不能清旧未知，精确exit证明与旧实例绑定。
- 两路径onClose先停admission／推进／注入，再有界精确停止runtime/Worker并持久证据或unknown，最后DB；不遗漏fallback无workerManager分支。

验证：双发送／双扫描、enqueue丢回包、两路径恢复与关闭闸门。完成条件：没有旧Run重叠或屏障前激活。


### S4实际实施记录（2026-11-10）

**范围**：仅P-ACCEPT＋P-DISPATCH，新增持久receipt收件／查询／取消／Stop及空闲队列激活；复用S1～S3。没有生产注册新路由、启动dispatcher或切换Web，`agent.module.ts`仍不调用新factory；S5输入准备、确认、续接／放弃、fork与压缩有效输入策略尚未实现。以下为开发自测记录，不替代独立审查。未执行Git命令、暂存、提交或安装依赖。

#### 权威实现与边界

- `AgentMessageQueueService`只受理当前Workspace的primary Session；访问／删除围栏先于重放。busy、paused及Worker暂不可用不妨碍合法收件；queued不改正式head/revision。原始文本、显式Agent／locale、有序图片文件名／格式／字节摘要组成指纹，不含随机temp／attachment ID；同scope同ID异指纹409，旧执行命名空间碰撞409，去重早于容量检查，cancelled／injected重放不复活。
- `AgentMessageQueueStore`在S2 publication callback的真实同步SQLite事务中创建receipt及附件关联，分配FIFO sequence并更新独立queueVersion；容量复用shared的100条／64MiB，文本UTF-8 64KiB。配置优先固定为可注入交互Run→当前可见祖先未确认输入→queued队首→现有默认解析；混合身份fail closed并暂停，不以UI默认覆盖已受理身份。
- 查询提供queued计数／字节、当前正式祖先未确认集合及停止屏障聚合。Stop直接复用S3 `stopSession`；新operation才触发一次调解，旧operation只返回稳定受理记录与当前snapshot，不重新选择／取消后继Run。Stop、cancel和重放均不伪称runtime已经退出。
- 取消仅转换queued，清正文与receipt附件关联、保留去重墓碑，并在同事务调用S2 `retainReceipt`；已注入409。已发布文件不在线unlink，pendingBytes减少不等于1GiB publication留存额度减少。受控图片需receipt关联、Workspace根一致、pinned安全句柄及长度／SHA-256校验，读后再次授权；响应不暴露storageKey／路径，设置no-store／nosniff。
- `SqliteRunLifecyclePersistence.activateQueuedUserRun`在immediate事务内复查scope、active控制、FIFO队首、无未确认输入、停止屏障及无当前／draining执行。**DB terminal但S3 runtime admission仍bound／closed未retired，也不能激活新Run**。消息、Run、旧client request执行去重、receipt状态、Run输入关联、unbound admission及queueVersion同事务；调用同一private普通用户激活实现，不复制消息图／Run创建流程。
- `RunLifecycleApplication.startQueuedUserRun`复用`enqueueActivatedRunOrReconcile`和S3 admission绑定；enqueue未知只对同runId对账，receipt重放不重新enqueue。失败／停止保留queued、已注入未确认不自动重放；合法旧Run正常完成且真正drain后纯queued可推进。非正常终态只暂停已有active控制行，已暂停原因不被泛化覆盖。
- `AgentMessageQueueDispatcher`按Session ID游标分页轮转、单实例single-flight、默认每轮32个Session；扫描异常被处理且连续故障只发一次安全诊断，后续继续扫描。profile错误暂停profile_unavailable，身份不变量错误暂停invariant_violation，其余未知故障暂停recovery_required，不能将数据库／handoff错误伪称配置失效。
- 旧强制激活、scheduled／manual compaction新Run仍是原协议，新增queued／paused围栏，不改为收件；revert／moveHead保护queued及正式祖先未确认输入。fork选定历史和完整有效输入策略由S5补齐，不能在S5前启用生产队列。

#### S5／S6窄接入接口

`createAgentComposition(...).createMessageQueue(runtimeControl)`返回休眠assembly：`service`、`dispatcher`、`openAfterRuntimeRecovery()`、`close(timeoutMs?)`。factory复用同composition的现有Lifecycle、Session Agent/model默认解析和`environment.resolveExecutionProfile`；固定provider/model通过modelOverride重新检查配置、凭证及Workspace enablement，不只相信receipt里的ID。当前模型配置已无独立vision能力字段，不复活已退役vision配置；收件静态图片限制／签名与可信发布仍执行，实际模型媒体输入准备由S5接续。

- factory本身不恢复、不开放收件、不启动timer、不注册route。S6只创建一个API生命周期所属实例，在可信Worker ready／fallback **真实onListen** 原恢复屏障之后调用`openAfterRuntimeRecovery()`：恢复旧publisher→开放收件→启动dispatcher；不能搬到onReady为inject偷跑恢复。
- S6测试／生产在适当全局认证边界内显式调用`registerAgentMessageQueueRoutes`。S4隔离HTTP fixture已经验证JSON与multipart共享schema、严格拒绝额外字段、全局认证、OpenAPI以及resume／abandon 404；未提供假成功接口。
- 关闭先`assembly.close()`封receipt准入与扫描；有界等待在途publication收件及扫描。返回false是尚未settle诊断，**不是可以关闭DB或认为runtime退出的证明**。调用方须先排空HTTP、等待这些工作settle，再按S3精确停止／真实退出或unknown顺序关闭runtime和DB；不能丢弃在途任务后关库。S5还需在同顺序关闭注入准入（已由下方S5记录所列共享关闭闸门补齐；完整生产HTTP／runtime排空仍由S6装配验证）。
- S4不伪造输入确认，因此隔离dispatcher产生的receipt会保持unconfirmed，不能据此宣称已发送给模型或Agent已处理。S5补实际输入绑定／确认后才能与S6整体启用。

#### 合理差异与回归处置

- 为避免双份multipart解析，从旧公共route提取`agent-message-multipart.ts`，参数化payload schema；旧协议和附件限制不变，新增byteSha256供receipt指纹。Fastify multipart的JSON body实际为null／undefined，route compiler只跳过该空体，JSON／cancel／Stop handler仍严格Value.Check；真实HTTP测试发现并覆盖此差异。未知staging错误统一安全503，不把底层私有路径作为400文本返回。
- 旧`agent-startup-recovery.integration.test.ts`原先在pre-listen失败并被恢复暂停的同一Session继续旧send并期望201。S4禁止旧入口越过paused，这是预期行为变化：保留全部启动屏障／Run／工具收敛断言，新增该Session409／无额外Run断言，再用新建干净Session验证onListen后真正开放准入仍201；没有删除保护断言或放宽恢复语义。
- 保留父任务安排S7的唯一已知unit断言漂移：`writeback/context-writeback-application.test.ts`旧期望缺`modelRequestError: null`，本阶段未改；不得宣称API全量unit全绿。

#### 确切文件清单（相对仓库根）

新增生产文件：

- `apps/api/src/modules/agent/attachments/agent-message-multipart.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.guard.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.store.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.service.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.dispatcher.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.routes.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.ts`

新增测试／fixture：

- `apps/api/src/modules/agent/message-queue/message-queue.testkit.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.dispatcher.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.integration.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.integration.test.ts`

修改既有文件：

- `apps/api/src/modules/agent/agent.composition.ts`
- `apps/api/src/modules/agent/agent-message.store.ts`
- `apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts`
- `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`
- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`
- `apps/api/src/modules/agent/routes/agent-public.routes.ts`
- `apps/api/src/modules/agent/integration/agent-startup-recovery.integration.test.ts`
- 本文件`docs/design/0038-agent-session-message-queue/05-implementation-plan.md`

#### 验证命令与结果

所有测试的TMPDIR均指向仓库`.tmp-tests`，设置`TSX_DISABLE_CACHE=1`；shared clean build结束后才运行依赖dist的测试。新测试按既有`*.test.ts`／`*.integration.test.ts`自动发现，无隐藏执行目录。

- 仓库根`npm run build -w packages/shared`：通过。
- 仓库根`npm run typecheck`：通过（内部先build shared，再检查CLI／Worker／API／飞书／Web）；最终日志`.tmp-tests/s4-typecheck-release.log`。
- `apps/api`下`node scripts/verify-test-gate.mjs`：通过，日志`.tmp-tests/s4-api-gate-release.log`。首次误从仓库根执行gate找不到相对路径，已按正确cwd重跑，不作为代码故障。
- `apps/api`下`tsx --test src/modules/agent/message-queue/*.test.ts src/modules/agent/integration/agent-startup-recovery.integration.test.ts src/modules/agent/integration/agent-message-attachments.integration.test.ts`：**58/58通过**，含38项S4新测试与旧附件HTTP／启动恢复必要回归；日志`.tmp-tests/s4-targeted-final.log`。
- `apps/api`下`npm run test:integration:worker`：**21/21通过**；日志`.tmp-tests/s4-api-worker-final.log`。
- `apps/api`下`npm run test:integration`：最终**576/576通过**，日志`.tmp-tests/s4-api-integration-release.log`。首轮574/575，仅命中上述旧启动测试的预期语义变化；加强断言并使用干净Session验证准入后，全量复跑通过。
- `apps/api`下`npm run test:unit`：最终**1911/1912通过，1项失败**，日志`.tmp-tests/s4-api-unit-release.log`。唯一失败仍为父任务已知的`context-writeback-application.test.ts`缺`modelRequestError: null`期望，未新增失败、未修改该断言；新S4 unit全部通过。

**交付状态**：S4代码、真实SQLite／隔离HTTP／必要兼容测试和接入说明已完成，可由父任务安排独立代码审查。未自行暂存；独立审查通过前不得声称S4验收通过，更不代表S5～S7或整个功能已交付。


## P-RECOVER：继续已有输入与不可逆放弃

前置：P-DISPATCH及P-INPUT的有效上下文策略。

- 新增独立续接激活原语：引用旧trigger user、关联全部未确认输入，不创建user，不改originRun。
- resume先检查停止屏障已解除、DB收敛和既有工具安全，再优先未确认输入，其次queued，否则仅解暂停；固定身份／fence／操作去重及版本一致。
- 新abandon-unconfirmed只接expectedQueueVersion+expectedUnconfirmedInputSetHash+显式确认，不接ID数组；服务端按04 canonical重算全集，body additionalProperties=false且路由级不变更输入校验，HTTP额外字段400而非被擦除；终态abandoned、保持paused，queued不动。
- 统一主上下文／压缩／provider replay排除；timeline保留“未处理，已放弃”，附件记账不释放。
- confirmed不能放弃；旧Run未完全收敛不能恢复或放弃；同operationId重放不影响后来新控制。

验证：N=0失败trigger、超预算、启动失败、queued并存、重复resume；resume后新Stop均成功最终暂停、Stop前旧版本resume/abandon冲突、旧Stop重试无副作用；公开schema拒绝多余ID字段、旧hash冲突及全量canonical golden。完成条件：原Session始终有受控恢复出口，无重复user和旧工具自动重放。

## P-LOOP：安全注入与正常终态

前置：P-DISPATCH，与P-INPUT共同完成后启用。

- prepare/inject保持token、run fence、head/revision、FIFO和完整tool结果。
- 每边界最多8条且有限快照；普通trigger允许Worker准备失败后保留unconfirmed。
- 正常complete统一确认与continue/finish，同事务持久裁决，覆盖纯文本／reasoning／空响应阈值。
- continue后队列全取消原子finish；取消／错误／预算不复活，不重置原执行限制。

验证：实际provider输入、同runId、整轮工具闭合、terminal replay和未知结果。完成条件：无tool call/result拆分，无终态反转。

## P-INPUT：绑定重试、保守预算与压缩保护

前置：P-CONTRACT/P-ACCEPT，与P-LOOP协同。

- createStreaming绑定输入快照；普通retry replace事务继承，recovery replace/resume验证实际context；superseded完成不得确认。
- worker_model实际合法完成确认；fallback只回显完成确认source=local_fallback，不生成虚假模型成功。
- 实现唯一queue-input-estimator-v1公式、有效W、显式R缺省、canonical请求、实际动态工具／系统／图片／replay成本；不引入精确tokenizer或API工具影子。
- 0..8候选的工具/预算冻结与实际请求同份；一次旧前缀压缩后重算，不无限压缩重试。
- 修主projector、primary-materializer、compaction source、官方provider replay所有trigger-only／abandoned路径；unconfirmed前缀硬保护。
- provider明确context-too-large有限失败暂停，未确认保持；额外queued预算前置，trigger晚失败由P-RECOVER处理。

验证：公式golden、缺W/R、不同工具schema、真实图片、encrypted replay、retry换ID/丢回包、recovery上下文变化、超限恢复。完成条件：无假精确预算，无输入确认漏绑，无新消息静默摘要。

### S5实际实施记录（2026-11-10，首轮审查未通过，修订待复审）

**范围与状态**：实现P-INPUT＋P-LOOP＋P-RECOVER的后端闭环，复用S1实体／契约、S2附件发布与留存、S3生命周期／admission／停止屏障和S4受理／FIFO。以下是开发自测与交接记录，**不是独立审查通过或S5验收通过结论**。没有修改Web、飞书或IM，没有在生产注册公共队列路由、调用休眠factory或启动dispatcher；没有执行Git命令、暂存、提交或自行安装依赖；managed suite仍沿用既有隔离目录的CLI离线链接测试。

#### 权威实现与不变量

- `AgentInteractiveInputService`的prepare在异步读取真实PromptContext之后，以SQLite immediate事务核验Run、head/revision、当前Assistant和完整工具轮次；每次固定最多8条FIFO候选和稳定preparationSnapshotHash。inject验证持久prepare、身份、FIFO前缀和head/revision，同事务追加正式user、关联当前Run／receipt／旧request去重并更新queueVersion，不另建Run。operation重放保留原结果，不能吸收后来收件，仍受Workspace删除／访问围栏保护。
- Assistant创建与可信input binding同事务。普通模型retry继承同一集合、hash和原输入revision，旧binding变为superseded；迟到旧完成不能确认。只有合法模型完成／明确本地回显完成的事务确认receipt，HTTP发送、失败、取消、未知结果不确认。
- 正常非工具Assistant由complete-or-continue原子完成、确认输入、检查queued并持久原continue/finish；包含reasoning-only与原空响应阈值分支。finish后新入队不翻转旧意图；continue后候选全取消由下一prepare原子finish，不额外调用模型。
- Worker只在整轮工具处理闭合后准备输入。针对0..8前缀发现实际动态工具、投影provider replay、打开并校验真实图片，再按`queue-input-estimator-v1`选择最长可容纳前缀；冻结system/messages/tools/runtime options/provider投影及图片buffer用于实际请求和普通retry。R明确写入请求；图片按每次真实出现计费，附件SHA-256与字节数匹配，不能以同inode代替同内容。
- canonical JSON按Unicode码点排序对象key并保留数组序；拒绝非JSON、循环、稀疏／扩展数组。预算tools只含实际name/description/inputSchema，不把Worker的source标记混入公式。官方replay已注入最终消息，预算不再重复计只供调试的PromptContext副本；不透明字符串原字节计入B，新增测试断言增加1000字节恰好增加1000的B。
- 一个准备周期最多一次旧前缀压缩；取消／head或FIFO变化最多3次有界重准备，不跳队、不无限清空queued。prepare/inject由Runner持有固定operation重试；client的idempotentControlWrite刻意不自行重试，让Runner AbortSignal继续拥有取消权。三个新控制响应即使配置warn也强制严格校验。prepare可能提交finish或complete结果未知时只收敛既有持久意图，不另猜failed/cancelled。
- recovery重新预算实际输入。只对**尚无持久Parts**的continuation返回可复用binding元数据；普通provider同集合／同hash认领并沿用原输入revision，变化或已有Parts则原子replace/rebind。认领事务还会重查Parts，阻止读取空上下文后旧flush迟到的竞态。Moonshot／DeepSeek保留既有不能拼接未知partial replay的替换路径。resume/recovery replace响应丢失重放原身份，不另生成第三个Assistant。
- 主上下文、runtime projector和primary-materializer共用有效输入规则：当前Run／unconfirmed图片是真实引用，abandoned不进入有效上下文。fork按授权祖先消息ID读取同Workspace来源状态，不能因未复制调度记录复活abandoned。planner在固定尾部外保留最早unconfirmed硬边界；无法保留则不可压缩，API commit再做最后一道保护。
- `AgentQueueRecoveryStore`提供独立续接激活：版本CAS、所有停止屏障、DB收敛、物理retirement和既有工具安全检查后，引用最早原user，关联全部unconfirmed，复用Lifecycle物理enqueue后半段，不插第二份user／不改旧originRun。queued-only只解暂停交普通FIFO；两者空只解暂停。旧resume重放不能解除后来Stop。
- abandon只接受版本、完整集合hash和显式不可逆确认；服务端重算全集，同事务全量abandoned＋paused(inputs_abandoned)＋操作结果，queued不动。不依赖旧profile解析，不释放已发布附件记账，不提供部分ID放弃接口。隔离HTTP验证额外ID字段400而非静默擦除。
- Local fallback使用相同prepare/inject/binding/complete裁决，同Run继续，完成source严格为local_fallback。图片内容仅回显附件描述，明确不执行模型识图，不输出`[object Object]`或虚构provider成功；保留原步数限制、停止和Analytics/finally语义。

#### 与S4及S6的接入关系

- S4关于“resume/abandon尚未注册／404”的记录是当时基线；S5在**可选注册函数和隔离HTTP fixture**中补齐真实恢复实现，合法调用走共享schema，畸形／额外字段400。生产`agent-public.routes.ts`／`agent.module.ts`仍未启用该函数，不能把隔离路由可用误写为生产已上线。
- Worker内部prepare/inject/complete-interactive已完整注册，沿用现有内部token与scope／Run fence，不接受公共请求选择确认来源。
- S6仍须只装配一个API生命周期所属queue assembly；可信Worker ready／fallback真实onListen的既有恢复屏障结束后恢复publication、开放受理并启动dispatcher。不能为了注入把恢复搬到onReady。S5补齐assembly.close同步封收件及注入闸门，然后等待收件／扫描；异步prepare在context返回后重验闸门，关闭后不再进入SQLite事务。composition.dispose同样封闸，延迟初始化不能重新开放，complete仍保留终态写回能力。S6调用方仍必须先排空HTTP和在途context任务，再按S3精确停止及真实退出／unknown顺序排空内部写回，最后关DB；不能把assembly等待超时、封注入闸门或DB terminal当退出证据。
- 前端等待数量、未确认恢复提示、abandoned标识、多端轮询及生产公共路由／dispatcher启用均属S6；本阶段没有借后端测试改前端行为。

#### 新增证据与必要旧回归

| 证据 | 自动断言 | 文件 |
| --- | --- | --- |
| A-BOUNDARY | 真实API-managed Worker首轮两个bash，分别阻塞completed writeback；第二个结果前仍queued且只有一次provider请求；释放后同runId的第二请求包含全部function_call_output→新user及真实PNG data URI，R=4096 | `apps/api/src/modules/agent/agent.worker.integration.test.ts` |
| A-FINISH／A-IDEMPOTENCY | FIFO最多8、快照后新到不挤入、inject精确重放；旧finish不受后来入队影响；continue全取消prepare finish；Stop/inject两个事务顺序均不反转历史 | `apps/api/src/modules/agent/message-queue/interactive-input.test.ts` |
| A-BINDING-RETRY | 创建回滚、绑定revision/set CAS、superseded迟到、普通retry冻结工具／buffer、recovery claim／replace、Moonshot／DeepSeek路径及响应丢失 | 上述API测试及`apps/agent-worker/src/runtime/runner.interactive-input.test.ts` |
| A-BUDGET | 精确公式golden／边界、W/R非法、Unicode数值key、真实图片次数、动态schema与opaque原字节、队首超限只压缩一次、provider明确context limit不模型retry | `queue-input-budget.test.ts`、`runner.interactive-input.test.ts` |
| A-RECOVER-EXIT／A-CONTROL-RACES | 生命周期真实admission/enqueue、全部未确认与最早trigger、无重复user、同version竞争、pending/unknown阻塞、旧resume/abandon不覆盖新Stop、profile移除可放弃及附件仍计额 | `interactive-input.test.ts` |
| A-INPUT／A-HISTORY | unconfirmed早于固定尾部也不可摘要，abandoned不进保留或summary prefix，非trigger保护图片保持真实，API commit不能跨最早保护输入，fork不复活abandoned | `compaction/planner.test.ts`、`compaction/primary-materializer.test.ts`及上述API测试 |
| A-FALLBACK／HTTP | 真实本地回显continue/finish、source=local_fallback、图片回显语义；恢复HTTP严格400及queued-only不造空Run；内部RPC失响应精确重放与warn也严格校验 | `interactive-input.test.ts`、`message-queue.integration.test.ts`、`apiClient.test.ts` |

这里只记录已执行自动证据，不将本阶段未改的A-COUNT／Web人工验收、整套功能验收或独立代码审查标为通过。新增API／Worker测试均落入现有默认发现脚本；API gate没有新增隐藏目录。

#### S5文件清单（相对仓库根）

新增生产文件：

- `packages/shared/src/agent-input-policy.ts`
- `apps/api/src/modules/agent/message-queue/interactive-input-binding.store.ts`
- `apps/api/src/modules/agent/message-queue/interactive-input.service.ts`
- `apps/api/src/modules/agent/message-queue/queue-recovery.store.ts`
- `apps/agent-worker/src/runtime/queue-input-budget.ts`

修改生产文件：

- `packages/shared/src/internal-contracts/agent-input-binding.ts`
- `packages/shared/src/internal-contracts/agent-api-read.ts`
- `packages/shared/src/internal-contracts/agent-api-queue.ts`
- `packages/shared/src/internal-contracts/agent-api-message.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/modules/agent/agent-message.store.ts`
- `apps/api/src/modules/agent/agent.composition.ts`
- `apps/api/src/modules/agent/agent.service.ts`
- `apps/api/src/modules/agent/agent.runtime.ts`
- `apps/api/src/modules/agent/agent.runtime-port.ts`
- `apps/api/src/modules/agent/routes/agent-route-types.ts`
- `apps/api/src/modules/agent/routes/agent-worker.routes.ts`
- `apps/api/src/modules/agent/lifecycle/run-lifecycle-ports.ts`
- `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`
- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.service.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.routes.ts`
- `apps/api/src/modules/agent/read-side/model-context-resolver.ts`
- `apps/api/src/modules/agent/read-side/runtime-transcript-projector.ts`
- `apps/api/src/modules/agent/read-side/prompt-context-projector.ts`
- `apps/agent-worker/src/runtime/apiClient.ts`
- `apps/agent-worker/src/runtime/runner.ts`
- `apps/agent-worker/src/runtime/compaction/planner.ts`
- `apps/agent-worker/src/runtime/compaction/primary-materializer.ts`

新增或修改测试／记录：

- `apps/api/src/modules/agent/message-queue/interactive-input.test.ts`（新增）
- `apps/agent-worker/src/runtime/queue-input-budget.test.ts`（新增）
- `apps/agent-worker/src/runtime/runner.interactive-input.test.ts`（新增）
- `apps/api/src/modules/agent/agent.worker.integration.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.testkit.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.integration.test.ts`
- `apps/api/src/modules/agent/read-side/runtime-transcript-projector.test.ts`
- `apps/agent-worker/src/runtime/apiClient.test.ts`
- `apps/agent-worker/src/runtime/compaction/planner.test.ts`
- `apps/agent-worker/src/runtime/compaction/primary-materializer.test.ts`
- 本文件`docs/design/0038-agent-session-message-queue/05-implementation-plan.md`

#### S5最终自测与交接状态

以下保留S5首轮送审前代码状态的实际结果；首轮审查H1/M1/M2未通过后的修订及新结果见下方专节。各命令均使用仓库`.tmp-tests`作为TMPDIR并禁用tsx缓存；API脚本在`apps/api` cwd运行。共享源码更新后先完成shared build，再运行依赖dist的测试；最终全局类型检查再次顺序重建shared，没有与依赖dist的测试并行。

| 命令／范围 | 实际结果 | 本地日志 |
| --- | --- | --- |
| 根目录`npm run typecheck`（含shared build、CLI、Worker、API、飞书、Web兼容检查） | 通过 | `.tmp-tests/s5-global-types-final.log` |
| `npm run typecheck -w apps/api`（最后API关闭／认领保护修改后） | 通过 | `.tmp-tests/s5-api-types-final.log` |
| `npm run test -w apps/agent-worker`（独立全量复跑） | **1344/1344通过** | `.tmp-tests/s5-worker-isolated.log` |
| API `npm run test:unit` | **1932/1933通过，1项指定旧失败**，进程exit=1 | `.tmp-tests/s5-api-unit-final.log` |
| API `npm run test:integration` | **580/580通过** | `.tmp-tests/s5-api-integration-final.log` |
| API `npm run test:integration:worker` | **22/22通过**，含真实双工具＋文本＋图片同Run证据 | `.tmp-tests/s5-managed-final.log` |
| 根cwd显式`tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | **8/8通过**；unit前段exit=1使脚本后段未执行，已独立补跑 | `.tmp-tests/s5-plugin-final.log` |
| API gate `node scripts/verify-test-gate.mjs` | 通过 | `.tmp-tests/s5-api-gate-final.log` |
| API interactive-input定向 | **21/21通过**（亦包含于最终unit集合） | `.tmp-tests/s5-api-interactive-final.log` |
| API queue assembly定向 | **4/4通过**，含cold/warm/disposed三个关闭路径（亦包含于最终integration） | `.tmp-tests/s5-close-assembly-final.log` |
| Worker apiClient定向 | **76/76通过**（亦包含于最终Worker集合） | `.tmp-tests/s5-client-final.log` |

失败处置与复跑说明：

1. 两处新增managed fixture／chunks类型错误已修；三RPC加入完整policy期望。client的控制写策略不自动retry，Runner保持原request／operationID并拥有取消权，测试没有修改产品策略来迎合错误假设。
2. opt-in恢复HTTP旧404期望按S5实现改为严格400，新增合法queued-only恢复断言，生产公共入口仍404。用户图片安全错误由共享权威发出，对应旧regex同步到真实文案，不削弱拒绝断言。恢复后Stop测试先等待明确reconcile完成再取queueVersion，不用sleep猜交错。
3. 最初API integration被120秒工具超时中断，pending promise取消不是业务通过证据；随后足额时限完整复跑通过。最终四组同时回归时，Worker既有fixture的100ms abort先于请求到服务端，`beforeHeaders.attempts.length`为0而非1；已定位到`apiClient.test.ts:211`，没有放宽timeout或隐藏失败。该文件单独76/76、Worker独立全量1344/1344均通过。原失败日志`.tmp-tests/s5-worker-release.log`保留供复核。
4. **唯一未修复项**：`apps/api/src/modules/agent/writeback/context-writeback-application.test.ts`中`Message cancellation converges queued ToolExecution through ToolExecution convergence`的旧完整对象期望漏了`modelRequestError: null`。最终unit确认只此1项失败，按父任务明确安排留给S7；本阶段不修改该断言，不宣称API全绿。
5. 收尾时补齐空Parts metadata＋认领事务双重保护、Stop/inject两个顺序、关闭后prepare／inject闸门和终态完成排空，并在这些API修改后重新运行完整unit、integration、managed、API及全局typecheck，以上最终结果不是只沿用修改前日志。

交主助理独立审查的重点：输入绑定与确认事务、真实预算／冻结请求一致性、同快照空Parts认领／非空或变化替换、幂等未知完成不能改tuple、resume／abandon复用S3物理退出屏障，以及S6必须先封共享闸门再排空HTTP／runtime／DB。上述首轮自测结束后，独立审查实际复现H1/M1/M2并判定不通过；不可将这些自测结果当作审查通过。最新修订见下节，S5仍未宣告通过。本阶段自动测试不替代06完整验收矩阵；A-COUNT、Web、多端交互和生产启动／关闭整合仍留给S6及后续验收。

### S5首轮审查修订：H1／M1／M2（2026-11-10，待原会话复审）

原独立审查会话：`sess_00mwaw8qu2000096d3d5644376`。首轮结论**不通过**；H1/M1/M2均已实际复现，不按假设性问题搁置。三项处置均为Fix，本节是开发者修订及自测证据，不代替审查者的Resolved判定，不改写07中的设计静态审查结论。

#### H1：未知控制结果不能使无terminal intent的Run退出跟踪

- 原因：prepare／complete的wrapper知道无效响应可能已经提交，但immutable-operation重试分类不接受`InternalRpcInvalidResponseError`，使已提交prepare／continue掉进只对terminal intent收敛的外层return，running Run因提前finally变为无人跟踪、retire=false并被tombstone拒绝重入。
- 修改`apps/agent-worker/src/runtime/runner.ts`的`retryIdempotentControlWrite`，只在具有固定幂等键的控制操作中将invalid response与network／timeout等未知结果统一保守重放。operationId和完整请求仍由调用方在循环外冻结，不重新prepare、不重新生成Assistant／operation、不选failed／cancelled猜测tuple。
- 该循环**没有有限次数／终态十秒预算的耗尽出口**：退避间隔100、200、400、800、1600、3200ms，之后上限5秒。首次未知之后的其他控制错误也不能证明原操作未提交，继续持有同Run的controller与Stop注册、重放同请求；初次明确拒绝仍走原有有界CAS重准备／失败路径。每个未知操作只记录一次安全告警。
- RPC等待本身可被当前AbortSignal分离，中断后晚到响应只完成原transport promise，不能再驱动Runner。Stop先前已提交的可信终态仍由已有converge endpoint收敛；不通过猜终态或释放跟踪绕过未知。模型重试、工具预算、step和repeatedToolCounter均不因控制重放递增。
- Worker定向新增invalid prepare、invalid continue／finish、12次连续未知（含network／invalid与其间明确HTTP拒绝）恢复、精确Stop中断in-flight／晚continue不复活；退避上限和同请求身份有直接断言。原“sleep返回false模拟重试耗尽”的测试改为真实AbortController取消，不能用不真实的有限sleep窗口隐藏悬挂。
- 真实API-managed Worker新增6项：提交普通prepare后损坏首回包、提交continue后损坏首回包、提交finish后到新queued仍重放原finish、连续8次交替schema／JSON无效回包超过普通终态窗口后恢复、未知continue／finish的in-flight回包分别与Stop交错。真实SQLite事务先成功，再由test-only onSend gate损坏响应；没有复制业务判定。
- 持续未知时实测`Run=running`、activeAssistant=null、queued=1，但**Worker activeCount=1**且没有retire调用，重复enqueue仍接受同Run；控制面恢复后只生成1个Run并完成，全部retire响应=true。Stop交错在旧回包释放前已真实quiescent；晚到回包不追加模型请求／不消费queued，已提交finish的completed意图不被Stop改成cancelled。

#### M1：恢复重放返回稳定原动作＋当前快照

- 修改`apps/api/src/modules/agent/message-queue/queue-recovery.store.ts`的replay，在同一个SQLite immediate事务里校验scope／operation种类／原request hash、读取原持久结果和当前queue snapshot。只替换响应queue，不修改原action／runId／abandonedReceiptIds，不重跑恢复激活／放弃，也不更新缓存动作。
- service的resume前置replay与store内resume／abandon重放都复用该实现。旧expectedQueueVersion仅在原请求完全匹配的重放中有效，不借此解除后来Stop、创建新admission或再次发布控制RPC。
- 更新原本错误地deepEqual整个旧queue的测试；新增resume后真实绑定确认再重放，和resume／abandon隔离HTTP在新Stop、后续入队、取消后逐次重放。断言返回最新version／paused(user_stop)／pending数，同时原动作稳定，operation数、enqueue数、Stop发送数、实际queue状态都不因重放变化。

#### M2：空集合与过期集合hash使用共享错误码

- abandon在既有版本／停止／runtime安全检查后分别判断：当前无unconfirmed返回409 `AGENT_NO_UNCONFIRMED_INPUT`；非空但hash过期返回409 `AGENT_UNCONFIRMED_SET_CONFLICT`。移除拼错的`AGENT_QUEUE_UNCONFIRMED_SET_CONFLICT`，没有新增重复码。
- 两个错误码用现有shared导出的`AgentQueueErrorCode`静态约束，不维护API影子枚举，也不修改shared公共契约语义。隔离HTTP直接验证返回code满足`AgentQueueErrorCodeSchema`、错误体满足`ErrorResponseSchema`，并检查失败无状态变化。
- 同时覆盖额外receiptIds、confirmIrreversible=false、坏hash的严格400，不能靠AJV删字段后变成合法放弃；合法全量放弃与稳定IDs重放也经真实HTTP通过。

#### 本轮实际改动范围

仅修改以下7个既有文件，没有新增生产依赖、schema／DB表、公共生产路由或S6装配：

- `apps/agent-worker/src/runtime/runner.ts`
- `apps/agent-worker/src/runtime/runner.interactive-input.test.ts`
- `apps/api/src/modules/agent/message-queue/queue-recovery.store.ts`
- `apps/api/src/modules/agent/message-queue/interactive-input.test.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.integration.test.ts`
- `apps/api/src/modules/agent/agent.worker.integration.test.ts`
- 本文件`docs/design/0038-agent-session-message-queue/05-implementation-plan.md`

managed fixture只增加提交后的响应gate及观测点：多次纯文本provider响应的message ID改为每请求唯一，避免原固定stub ID制造与本问题无关的SQLite主键碰撞；私有快照观测沿用实际Unix socket／TCP选择，duplicate enqueue携带可信runtimeInstanceId。上述均为测试装配修正，不更改产品控制协议或放宽断言／超时。

#### 本轮最终验证与复审状态

最终代码的完整回归已完成。所有命令均设置仓库`.tmp-tests`为TMPDIR并禁用tsx缓存；API集合在`apps/api` cwd执行，根cwd plugin单独补跑。全局typecheck顺序重建shared，结束后才启动后续依赖dist的测试。

| 命令／范围 | 确切结果 | 本地日志 |
| --- | --- | --- |
| 根目录`npm run typecheck` | **通过**；含shared build、CLI、Worker、API、飞书和Web兼容检查 | `.tmp-tests/s5-r1-global-types.log` |
| `npm run test -w apps/agent-worker` | **1349/1349通过**，cancelled=0 | `.tmp-tests/s5-r1-worker-full.log` |
| API `npm run test:unit` | **1933/1934通过，1项指定旧失败**，exit=1、cancelled=0 | `.tmp-tests/s5-r1-api-unit-full.log` |
| API `npm run test:integration` | **584/584通过**，cancelled=0 | `.tmp-tests/s5-r1-api-integration-full.log` |
| API `npm run test:integration:worker` | **28/28通过**，含6项本轮H1真实进程／SQLite／RPC证据，cancelled=0 | `.tmp-tests/s5-r1-managed-full.log` |
| 根cwd `tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | **8/8通过**；unit前段失败导致脚本后段未运行，已显式补跑 | `.tmp-tests/s5-r1-plugin.log` |
| API `node scripts/verify-test-gate.mjs` | **通过**；本轮测试均由既有脚本发现 | `.tmp-tests/s5-r1-api-gate.log` |
| Worker interactive-input定向 | **21/21通过**（亦包含在Worker全量） | `.tmp-tests/s5-r1-worker-focused.log` |
| API interactive-input＋queue HTTP定向 | **35/35通过**（亦分别包含在API unit／integration） | `.tmp-tests/s5-r1-api-focused.log` |
| API-managed H1定向 | **6/6通过**（亦包含在managed全量） | `.tmp-tests/s5-r1-managed-focused.log` |

本轮普通失败的处置：修正新增测试的unknown返回值／binding policy literal类型错误；修正managed fixture的Unix socket观测、可信实例字段和跨请求唯一provider message ID后重新定向、完整managed复跑通过。没有为通过测试放宽控制重试、协议校验、状态断言或测试时限。最终managed日志中的Stop后enqueue 409为预期负对照，非suite失败。 旧取消回归中的late terminal-intent conflict日志在修订前`.tmp-tests/s5-managed-final.log`和`.tmp-tests/s5-managed-release.log`也存在，对应用例本轮仍通过；未将该日志误计为新增失败，也未扩展本轮修复范围。

唯一未修复项仍是`apps/api/src/modules/agent/writeback/context-writeback-application.test.ts`的`Message cancellation converges queued ToolExecution through ToolExecution convergence`，旧期望缺少`modelRequestError: null`；完整unit确认仅此1项，按用户／父任务安排留S7，不修改该断言、不宣称unit全绿。

**当前交接：H1／M1／M2已实施Fix并完成上述验证，可交原审查会话`sess_00mwaw8qu2000096d3d5644376`复审；尚未取得复审结论，不宣告S5通过。** 没有执行Git、暂存或提交，没有修改S6／Web、启用生产公共队列入口或dispatcher；全部临时产物留在仓库`.tmp-tests`。不将本轮回归绿灯替代06完整验收矩阵或S6生产生命周期整合验收。

## P-WEB：数量、恢复与留存成本

前置：P-LOOP/P-INPUT/P-RECOVER协议就绪。

- 新receipt发送、稳定requestId、草稿版本、超时查询和去重；不把每条queued登记新Run。
- 输入框上方N提示0隐藏；独立未确认恢复提示N=0仍可见。
- 队列查看／取消、停止、继续、不可逆放弃全部确认弹窗，hash／版本冲突刷新。
- 独立停止确认中／停止状态未知提示，N=0也显示；禁继续／放弃／历史修改，可查询／等待，不做force-resume。解除仍paused，工具lease提示独立。
- confirmed来源与abandoned历史标识、留存额度错误与安全保留说明，不泄露路径。
- queueVersion包括确认/放弃；800/3000ms、乱序、多端、刷新与会话切换。

验证：组件位置、N更新、fallback数量和来源、恢复双出口、图片507保留草稿。完成条件：N与恢复数量不混淆，无假模型成功。

## P-REGRESSION：集成与上线门槛

前置：所有以上阶段。

- 执行全部[验收矩阵](06-testing-and-acceptance.md)，特别H1～H5/M1～M4新增用例，已Resolved的设计不得回归。
- 老入口／scheduled/subtask/manual_compaction/unlisted、Workspace删除及数据升级不退化。
- 新测试纳入默认脚本／API gate；不靠真实密钥完成确定性验收。
- 输出需求—决策—测试—证据清单；文档复审通过不代表业务测试已通过。

## 最小自检与回归命令

仓库根执行；本次文档修订未运行产品测试。

```bash
npm run build -w packages/shared
npm run typecheck
npm run typecheck -w apps/api
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/web
npm run test -w apps/web
npm run test -w apps/agent-worker
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
```

API全量脚本还执行test gate；新增测试不得不被发现。不安装外部队列，不读取或打印本地凭据。


## S6 实际实施记录（2026-11-10，作者自测完成，交父任务独立审查）

本阶段只实现 P-WEB 和生产启用，不修改飞书／IM。未执行任何 Git 命令，未暂存、提交或安装依赖。以下是实际开发与自测记录，不代表独立代码审查或 S7 最终验收通过。

### 生产启用与关闭顺序

- `agent.module.ts` 在 Worker manager 启动前创建唯一生命周期所属 queue assembly，并注册公共 receipt／queue／恢复／留存路由。保留应用级认证以及公共队列的非修改式 TypeBox 校验，额外 Stop／恢复字段不被 AJV 静默移除。
- Worker 仍在可信 ready 恢复链（恢复 Run／删除／终端、reconcile Stop）之后开放 runtime admission，再调用 `openAfterRuntimeRecovery()` 恢复 publication、开放收件并启动 dispatcher；fallback 仍只在真实 `onListen` 执行该步骤。没有为 `app.inject` 提前恢复或启动本地队列。关闭开始后迟到的 ready／onListen 不再重新开放 admission。
- committed terminal convergence、Worker runtime retirement、fallback retirement 和 Worker exit 均可唤醒 dispatcher，保留原 500ms 公平扫描兜底。DB terminal 本身不被当作 runtime 已退出。
- Fastify 排空在途 HTTP 后，关闭 hook 同步封收件、内部注入、扫描及 runtime admission，取消 completed 订阅并停止定时任务，然后等待首轮收件／扫描排空、精确停止 Run、排空本地执行、再次等待尚未 settle 的 publisher／scanner，最后关闭 runtime control／Worker manager、记录真实本地退出并 dispose composition。
- `close(false)` 和本地 `drain(false)` 绝不被忽略或当作完成：记录一次不含私有内容的等待诊断，以 5 秒等待窗口继续等到真实 settle，再释放后续资源。本地不配合取消的 context 读取会延长关闭，而不会在仍可能写回时声称关闭完成；DB 所有者仅能在 `app.close()` 成功后关闭 DB。没有新增 DB close hook或把 unknown 当退出证明。

### Web 行为与最小展示契约

- 普通文本／图片改走 receipt，运行中可继续补充消息。只有服务端实际 injected receipt 的真实 Run 才登记 pending Run；queued receipt 不造 Run，不改正式历史。manual compact 仍走原独立协议，存在队列／暂停／未确认／停止屏障时禁止提交。
- 输入框上方显示中文 **“有 N 条消息等待处理”**，N 只取服务端 queued；N=0 隐藏，paused 仍计。HTTP 未知／上传／本地草稿不加入 N。独立显示未确认正式输入 K，K>0 且 N=0 仍有恢复入口。
- 独立 `useAgentMessageQueue` 持有队列版本、作用域隔离、800ms／3000ms 轮询、可见性恢复立即查询和断网最后可信快照。低版本、旧 Session 和旧 Workspace 回包不能覆盖当前快照。HTTP wrapper 校验成功响应；畸形成功响应按结果未知处理，而不分配新请求 ID。
- 未知发送保留原 request ID、不可变提交副本及 File 引用，可按原 ID 查询或重试。仅在明确确认该提交后清理其图片；草稿按 composer 实例身份＋提交 revision 清理，不能清掉等待期间新编辑的文字，或组件重建后的新草稿。未知副本仅保留在页面内存，不向浏览器持久存储写入私有文本／图片。
- 轻量 FIFO 面板支持查看原文／图片和取消，不能编辑 queued。Stop 不带版本，未知时重放稳定 operationId；服务器 pending／unknown 以及本地 Stop 结果未知时阻断恢复与历史修改，但允许收件和取消 queued。quiescent 不自动解除 paused。
- resume／abandon 必须确认；使用确认时的服务端 queueVersion／全集 hash。abandon 明确携带 `confirmIrreversible: true`，不携带客户端 receipt ID 数组，不支持部分放弃或 force。未知控制操作保留原 body／operationId 重放，冲突后刷新。
- snapshot 最小兼容扩展只读 `inputIdentity`，来自同一个 `fixedIdentity()` 权威实现，覆盖 queued=0、unconfirmed=0 但 interactive Run 仍运行的情形；前端据此锁定 Agent/provider/model，不猜当前运行身份。timeline 批量查询 receipt，只读可选 `inputReceipt` 区分 unconfirmed／abandoned／worker_model／local_fallback；队列版本变化时结构刷新以更新无需 message revision 变化的确认徽标。local_fallback 文案明确仅本地回显，不冒称模型成功或识图。
- 507 保留草稿并提示停止服务后离线维护；不展示服务端路径，也不暗示取消／放弃会释放图片留存额度。

### 实际文件清单（相对仓库根）

新增：

- `apps/api/src/modules/agent/message-queue/message-queue.production.integration.test.ts`
- `apps/web/src/shared/api/agentMessageQueueApi.ts`
- `apps/web/src/features/workspace/tools/agent/useAgentMessageQueue.ts`
- `apps/web/src/features/workspace/tools/agent/AgentMessageQueuePanel.vue`
- `apps/web/src/features/workspace/tools/agent/AgentMessageQueue.component.test.ts`

修改：

- `packages/shared/src/contracts/agent-queue.ts`
- `packages/shared/src/contracts/agent-message.ts`
- `packages/shared/tests/agent-queue.test.ts`
- `packages/shared/tests/internal-contracts.test.ts`
- `apps/api/src/modules/agent/agent.module.ts`
- `apps/api/src/modules/agent/runtime-control/runtime-control.routes.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.store.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.routes.ts`
- `apps/api/src/modules/agent/message-queue/message-queue.assembly.integration.test.ts`
- `apps/api/src/modules/agent/message-queue/interactive-input.test.ts`
- `apps/api/src/modules/agent/read-side/sqlite-message-query.ts`
- `apps/web/src/shared/api/api.ts`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts`
- `apps/web/src/shared/i18n/locales/zh-CN.ts`
- `apps/web/src/shared/i18n/locales/en-US.ts`
- `apps/web/scripts/run-component-tests.mjs`
- `apps/web/scripts/run-component-tests.test.mjs`
- 本实施记录。

### 自测命令与结果

测试统一在仓库内 `.tmp-tests` 隔离，使用 `TMPDIR="$PWD/.tmp-tests"`（从仓库根导出）及 `TSX_DISABLE_CACHE=1`，未读敏感配置、未安装依赖。最后完整类型检查先完成 shared build，再执行依赖 shared/dist 的验证。

| 验证 | 实际命令／cwd | 结果与证据日志（仓库 `.tmp-tests`） |
| --- | --- | --- |
| 完整类型检查及 shared 构建 | 根 `npm run typecheck` | 全 workspace 通过；`s6-typecheck-last.log` |
| Shared clean build＋契约 | 根 `npm run test -w packages/shared` | 144/144；`s6-shared-final.log` |
| Web 默认发现＋组件名单 | 根 `npm run test -w apps/web -- --concurrency=1` | 1272/1272；31 个组件文件全部执行，无跳过；`s6-web-last.log` |
| 队列 API 定向 | `apps/api` 下 `../../node_modules/.bin/tsx --test src/modules/agent/message-queue/*.test.ts` | 72/72；`s6-api-queue-last.log` |
| API integration | 根 `npm run test:integration -w apps/api` | 588/588；`s6-api-integration-final.log` |
| API-managed Worker | 根 `npm run test:integration:worker -w apps/api` | 28/28；`s6-managed-worker-final.log`；包含整轮两个工具闭合、同 Run 和真实图片 provider 输入的既有回归 |
| Worker 全量 | 根 `npm run test -w apps/agent-worker` | 独立重跑 1349/1349；`s6-worker-rerun.log` |
| API unit | 根 `npm run test:unit -w apps/api` | 1933/1934；唯一失败仍为下述既有测试漂移；`s6-api-unit-final.log` |
| 根 cwd plugin | 根 `./node_modules/.bin/tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | 8/8；`s6-root-plugin.log`；因 unit 脚本遇失败提前退出，显式补跑 |
| API gate | `apps/api` 下 `node scripts/verify-test-gate.mjs` | 通过；`s6-api-gate-final.log` |

新增直接证据：生产 pre-listen 503／真实 listen 后 202、认证 401、不移除 Stop 额外字段、生产 dispatcher 本地回显确认及 timeline source、close(false)／drain(false) 二次等待；Web N/K 分离、N 的位置及暂停行为、无假 Run、原 ID／图片字节重试、旧响应隔离、轮询节奏、离线保留、确认时 CAS／hash、停止屏障、权威身份锁定、新编辑草稿与重建 composer 保护；Shared 确认 metadata 的严格 state/source 配对与拒绝客户端写入。

### 验证过程中的处置与限制

- **保留给 S7，未修改**：`apps/api/src/modules/agent/writeback/context-writeback-application.test.ts` 的完整对象期望缺少既有 `modelRequestError: null`。这是父任务已明确保留的唯一 API unit 旧漂移，不声称 API unit 全绿。
- **Fix（断言漂移）**：Shared 全量首次执行发现 `internal-contracts.test.ts` 的 endpoint 白名单漏掉 S3 已有 `retireRuntimeAdmission`；仅补齐预期，无协议或 S3 行为修改。补齐后 Shared 144/144。
- 前期并行运行多个大套件的 120 秒预算不足；这些中断不计通过。Worker 首次高负载运行另出现原 100ms 测试服务器接收计数时序失败（1348/1349），没有修改 Worker 代码或放宽测试，独立重跑原全量 1349/1349。
- 早期一次准备阶段将根 typecheck（内部 clean shared build）与依赖 shared/dist 的 API 测试并行，触发 `ERR_MODULE_NOT_FOUND`；该次结果废弃。后续完整 typecheck／Shared build 完成后再启动依赖测试，最终日志如上，不将装配竞态当业务失败。
- 未进行真实浏览器双标签／断网人工验收，没有执行 Git、没有独立审查或最终验收结论；交父任务审查并在 S7 处理保留项。队列与未知提交在浏览器页面完整刷新后仅保留服务端已持久状态；本阶段不向浏览器磁盘保存私有草稿与 File。

## S6 首轮审查修复记录（2026-11-10，H1／M1／M2／L1）

对应独立首轮审查会话 `sess_00mwb0f3k80000cdb795d57606`。四项均处置为 **Fix**；以下为作者修复和回归证据，不替代原审查会话的独立复审结论。保留 S1～S5 的协议、事务和安全边界，不包含飞书／IM，不执行 Git、暂存或提交。

### H1：真实 Session 的响应式提交交接

- `useAgentMessageQueue.ts` 将单次读取、按旧 draft scope 保存的 unknown Map 改为按提交中的真实 `workspaceId/sessionId` 发布的响应式内存交接。交接保留完整原提交、`clientRequestId`、文字、图片 File，以及 sending／unknown／明确拒收／accepted 阶段；只允许同一提交对象的结果结束其交接，迟到结果不能删除后来的提交。
- `AgentClientPane.vue` 的新 Pane 即使先挂载，也会同步观察后发布的交接。仅未编辑的新编辑器自动接管；已有新草稿时保留独立提交副本，不覆盖新文字和图片。确认 receipt 后只清理原 composer 或已接管草稿的对应 revision，并仅移除该提交的图片 ID。显式恢复的确认窗口也核验 scope、revision、图片集合及当前提交，防止覆盖弹窗期间的新编辑。
- `AgentMessageQueuePanel.vue` 展示保留提交及图片文件名、507／明确拒收提示、恢复和原提交重试；sending 阶段禁止重复重试。中英文提示同步补齐。未延迟 draft Pane 卸载，未使用浏览器永久明文存储。
- `AgentToolView.component.test.ts` 使用**真实父视图＋真实 Pane＋Axios XHR transport**，验证真实创建 Session → draft 被卸载 → 新 Pane 挂载 → 已卸载旧 Pane 才发 receipt → late timeout／507。五个分支覆盖原 ID 查询、原 ID 重试、507 重试，以及新 Pane 在交接发布前编辑后遇到 timeout／507；验证文字、File 引用、原 ID 和仅一次逻辑接收，确认时不清新草稿。测试 mounted hook 仅模拟新 Pane 的用户编辑，不阻止或延迟生产卸载。

### M1：可重开的临时扫描准入及激活临界检查

- `message-queue.dispatcher.ts` 增加可重开 `suspendRuntimeDispatch/resumeRuntimeDispatch`；临时挂起不封持久收件、不使用永久 `close()`。生产 assembly 初始关闭扫描，完整可信恢复后首次开放收件并启动扫描，后续 ready 只重新开放扫描并唤醒。
- timer、`scanOnce()`、direct `dispatchSession()` 共用同一准入；dispatch 捕获 admission epoch，将同一 assertion 经 `RunLifecycleApplication.startQueuedUserRun` 和 persistence port 传入 SQLite activation 事务，在入口及写 Run 前复验。挂起后即使已恢复，旧 epoch 的在途操作仍不得激活，不把临时拒绝误写成 paused/recovery_required。
- `agent.module.ts` 的实际 Worker starting／当前 Worker exit 回调同步挂起 dispatcher、关闭 runtime admission；可信 ready 完整恢复后再重开。恢复 epoch 防止旧 ready 在新 starting／exit 之后迟到重开；关闭后的 ready 直接返回，不能重开 assembly。
- dispatcher 反例覆盖停机窗口持久收件为 queued／active／N=1、head 不变、无 Run／物理发送 0、ready 后恰好激活一次，以及 await 在途旧 epoch、事务入口竞态、close 后不可 reopen。
- `message-queue.production.integration.test.ts` 通过真实模块装配和实际 Worker 回调验证 starting／exit 两个窗口及旧 ready 恢复竞态；只替换进程／传输边界，公共 HTTP、SQLite、receipt service、dispatcher、lifecycle 均为真实生产实现。真实 managedWorker 的独立 assembly fixture 在已取得真实 Worker identity 后显式开放新增扫描闸门，不启动第二个后台 scanner；不放松业务断言。

### M2：所有 Agent 选择入口统一检查身份锁

- `AgentClientPane.vue` 的 select 更新与 `onCycleAgent()` 均经过锁检查，`queueIdentityLocked` 或模型变更锁生效时不 emit。
- `AgentClientPane.component.test.ts` 为新增反例注册真实 Ant TextArea，从实际 DOM `textarea` 派发 Tab／Shift+Tab，并人工触发 select 更新验证非 UI 入口同样拒绝；锁定期间父选择不变、不 emit，解锁后仍显示原选择，随后正常 Tab 才 emit 下一 Agent。

### L1：同 queueVersion 的安全冲突诊断

- 比较范围明确限定为版本管辖字段：`mode/pauseCode/pendingCount/pendingBytes/pendingIdentity/unconfirmedInputCount/unconfirmedInputSetHash/recoveryIdentity`、公开 Stop 聚合的 `stop.state/unresolvedOperationCount/unresolvedTargetCount/code`，以及 FIFO item 的 `id/clientRequestId/sequence/createdAt/updatedAt/status/messageId/runId/confirmationState/confirmationSource/textPreview/attachmentCount`。
- scope IDs 单独验证，不进入诊断内容。`inputIdentity` 来自运行中 Run，不参与版本冲突比较；内部 proof／evidence／时间等未进入公开 snapshot 的证据也不比较。**首轮作者记录将公开 Stop 状态／计数／code 归为非版本字段是错误的，已按本次复审纠正**：这些公开聚合字段受 queueVersion 管辖。只按四个显式字段投影比较 Stop，不 stringify 整个 stop 对象，避免属性顺序或非公开扩展形状造成误报。
- 同版本且上述字段不一致时保留原可信快照，记录 `AGENT_QUEUE_SAME_VERSION_CONFLICT`，每 scope/version 最多一条安全 warning；日志只有错误码和数字 queueVersion，不打印 scope、身份、正文、文件或 hash。更高版本可正常接收。
- `AgentMessageQueue.component.test.ts` 验证可信快照不被覆盖、诊断限次及固定安全载荷，覆盖同版本 Stop pending→unknown／quiescent、各计数、code 冲突和高版本合法变化；仅 inputIdentity／未影响公开 snapshot 的内部证据变化不误报。原轮询测试在改变版本管辖状态时递增 fixture queueVersion，不放松冲突 guard。

### 本轮文件边界

- Web：`useAgentMessageQueue.ts`、`AgentClientPane.vue`、`AgentMessageQueuePanel.vue`、三个既有 component test 文件，以及 `shared/i18n/locales/{zh-CN,en-US}.ts`。
- API：`agent.module.ts`、queue dispatcher／assembly、lifecycle application／ports／SQLite persistence 的窄准入参数；既有 dispatcher／assembly／production 测试及 `agent.worker.integration.test.ts` 的独立 assembly fixture。
- Shared 本轮无新增协议修改；不改 S1～S5 的 Stop、注入、确认、恢复语义，不改已明确交给 S7 的既有 writeback 断言漂移。

### 本轮回归证据

所有测试临时数据均位于仓库 `.tmp-tests`；从仓库根导出 `TMPDIR="$PWD/.tmp-tests" TSX_DISABLE_CACHE=1`。完整 typecheck 内的 shared clean build 与依赖 dist 的测试严格串行。下表日志均在 `.tmp-tests`。

| 验证 | 实际命令／cwd | 结果及日志 |
| --- | --- | --- |
| 全 workspace 类型检查及 shared build | 根 `npm run typecheck` | 通过；`s6-r1-typecheck-final.log` |
| Web 全量 | 根 `npm run test -w apps/web -- --concurrency=1` | **1280/1280**；31 个组件文件，0 skipped；`s6-r1-web-final.log` |
| Queue API 全量定向 | `apps/api` 下 `../../node_modules/.bin/tsx --test src/modules/agent/message-queue/*.test.ts` | **78/78**；`s6-r1-queue-api-final.log` |
| Shared | 根 `npm run test -w packages/shared` | **144/144**；`s6-r1-shared-final.log` |
| API unit | 根 `npm run test:unit -w apps/api` | **1937/1938**，仅既有 writeback 对象期望缺少 `modelRequestError: null`；`s6-r1-api-unit-final.log` |
| API-managed Worker | 根 `npm run test:integration:worker -w apps/api` | **28/28**；`s6-r1-managed-worker-final.log` |
| 根 cwd plugin | 根 `./node_modules/.bin/tsx --test apps/api/src/modules/plugins/plugin.service.test.ts` | **8/8**；`s6-r1-root-plugin-final.log` |
| API gate | `apps/api` 下 `node scripts/verify-test-gate.mjs` | 通过；`s6-r1-api-gate-final.log` |
| API integration 全量（有界并发） | `apps/api` 下显式选择同一 61 个 integration 文件，`tsx --test --test-concurrency=2` | **590/590**，0 cancelled／skipped；`s6-r1-api-integration-bounded-final.log` |

最终有界并发命令（仅限制测试并发，不修改或跳过断言）：

```bash
# 仓库根导出 TMPDIR／TSX_DISABLE_CACHE 后进入 apps/api
mapfile -t tests < <(find src tests -type f -name '*.integration.test.ts' \
  ! -path '*/agent.worker.integration.test.ts' | sort)
../../node_modules/.bin/tsx --test --test-concurrency=2 "${tests[@]}"
```

### 回归过程的处置与剩余限制

- **已修正 fixture 准入设置**：managedWorker 首跑 21/28，七个既有队列用例使用独立 dormant assembly，仅手工开放了收件而未开放本轮新增的扫描闸门，故 `activated` 为 null。两处共享 fixture 在取得真实 Worker identity 并 `runtime.ready()` 后显式 `resumeRuntimeDispatch()`，保持手动 dispatcher 测试无第二个后台 scanner；完整重跑 28/28。未改变业务断言或放宽超时。
- **测试负载敏感而非业务回归**：默认 API integration 全量两次为 589/590，唯一失败都是 Analytics 冷启动耗时断言（2095ms／2055ms，原要求小于 2000ms）；涉及队列新增生产用例均通过。该原文件隔离重跑 10/10。进一步对相同 61 个全量文件限制并发为 2，最终 **590/590**；没有改 Analytics 代码、断言或超时。
- 一次全量 `--test-concurrency=1` 回归触及 900 秒工具预算被终止（555 pass，5 cancelled／未运行，不算完成）；保留 `s6-r1-api-integration-serial.log`。最终有界并发 2 的全量在约 470 秒完成，结果如上，不将中断当作通过。
- **WontFix，保留给 S7**：`apps/api/src/modules/agent/writeback/context-writeback-application.test.ts` 的既有完整对象期望缺少 `modelRequestError: null`，按父任务明确边界不修改；API unit 非全绿已明确记录，其余 1937 条通过。
- 本轮未执行浏览器双标签／断网人工验收；以真实 Vue 生命周期／真实 textarea、API 生产装配、SQLite 和 managedWorker 自动化覆盖所述反例。未读敏感配置、未安装依赖、未执行 Git；未向浏览器磁盘写私有草稿和 File。页面完整刷新仍只保证服务端已经持久接收的内容，内存中的未接收草稿不承诺跨刷新保存。
- H1／M1／M2／L1 作者修复及要求回归已完成，**可交回原独立审查会话复审**；这里不预判复审通过，也不宣称 S6 或整体 S7 验收完成。

## S6 复审后 L1 定点修复（2026-11-10，待原 existing 会话复审）

复审反馈：H1／M1／M2 已 Resolved；L1 因错误排除公开 Stop 聚合仍 Open，总体未通过。本次只修改 `useAgentMessageQueue.ts`、`AgentMessageQueue.component.test.ts` 和本说明三个文件，不变更已通过的交接、调度、身份选择或后端语义，不执行 Git、暂存或提交。

### 公开 Stop 的版本权威核实

核实方式为只读追踪现有后端实现，并对照 review 已提供的真实 DB 轨迹；本次没有新跑或修改 API／DB 测试，不把 review 的证据冒充本次执行结果。

- `message-queue/message-queue.store.ts` 的 `snapshot()` 从 barrier／target 行投影公开 Stop：`state` 是所有相关 barrier 的聚合；`unresolvedOperationCount` 是未 quiescent 的 operation 数；`unresolvedTargetCount` 是这些 operation 未 quiescent 的 target 总数；`code` 取选中未完成 barrier 的 `last_error_code`，pending 的空 code 回退为 `stop_requested`，quiescent／none 为 null。内部 proof／evidence 内容和时间字段不进入该公开投影。
- `runtime-control/runtime-control.store.ts` 的 `acceptStop()` 在同一事务内对涉及的 Session 调用 `pause()` 推进 `queue_version`，再建立 barrier／target；因此新增 operation、target 及首次 pending／quiescent 聚合不会在旧版本下出现。
- `confirmStopGroup()`、`markGroupUnknown()` 和 `confirmExitedInstance()` 的 target 更新均进入 `aggregate()`。它比较 `targetStateSignature()`（`run_id/state/last_error_code`）及 barrier 原状态；发生 target 签名或聚合状态变化时，在同一事务内对 root 和所有 target Session 推进 `queue_version`。因此 target 完成引起的计数变化，即使聚合仍 pending，也有版本推进；pending→unknown／quiescent 也有版本推进。
- 当前 `aggregate()` 按聚合状态维护 barrier code：unknown 为 `runtime_exit_unproven`，其他状态为 null；再由公开 snapshot 的 pending fallback 得到 `stop_requested`。公开 code 的这些变化伴随上述状态／版本推进，不存在另一个独立改公开 code 却不推进版本的生产写入口。内部 target 错误码变化也计入 target 签名，可能额外推进版本；这并不意味着要比较未公开的内部证据。
- review 的真实 DB 轨迹 `v3 pending/1 operation/1 target → v4 unknown/1/1 → v5 quiescent/0/0` 与上述实现一致。故四个公开聚合字段必须都纳入同版本比较；仅 `inputIdentity` 及真正未改变公开 snapshot 的内部证据仍不比较。

### 最小修正及反例

- 比较函数仅增加显式有序投影 `[stop.state, stop.unresolvedOperationCount, stop.unresolvedTargetCount, stop.code]`；不 serialize 整个 stop，也不更改已有可信快照保留、scope 隔离、安全限次日志或高版本接收规则。
- 删除原先“同版本改变公开 Stop 也无诊断”的错误正例，新增七个同版本冲突分支：pending→unknown、pending→quiescent、仅 state、仅 operation count、仅 target count、仅 code、code→null。每个分支验证保留原快照、固定安全诊断一次，并验证同一变化在更高版本下可接受。
- 增加合法 `v3 pending → v4 unknown → v5 quiescent` 正例。另以模拟服务端独立保留内部 proof 元数据、仅返回公开 snapshot 的查询验证：proof／时间变化而公开 Stop 不变时不误报，inputIdentity 同版本变化合法，Stop 属性构造顺序不同也不误报。此用例验证 Web 公开投影比较边界，不冒充真实后端 proof 测试。

### 本次定向验证

从仓库根设置 `TMPDIR="$PWD/.tmp-tests" TSX_DISABLE_CACHE=1`；未重建 shared、未运行全 API 磁盘测试。组件命令在 `apps/web` 执行：

```bash
NODE_OPTIONS="--import=$PWD/scripts/component-test-dom.mjs" \
  ../../node_modules/.bin/vite-node --config vite.component-test.config.ts \
  src/features/workspace/tools/agent/<组件名>.component.test.ts
```

| 验证 | 结果 | 仓库 `.tmp-tests` 日志 |
| --- | --- | --- |
| 新反例在旧实现上的执行 | 22 条中 7 条 Stop 冲突用例失败，确认复现漏诊断 | `s6-l1-stop-before.log` |
| AgentMessageQueue 定向组件 | **22/22** | `s6-l1-stop-AgentMessageQueue.log` |
| AgentClientPane 定向组件 | **66/66** | `s6-l1-stop-AgentClientPane.log` |
| AgentToolView 定向组件 | **129/129** | `s6-l1-stop-AgentToolView.log` |
| 根 `npm run typecheck -w apps/web` | **通过** | `s6-l1-stop-web-typecheck.log` |

三个组件合计 **217/217**，0 failed／cancelled／skipped。本次作者修复与定向自测完成，可交原 existing 审查会话 `sess_00mwb0f3k80000cdb795d57606` 复审 L1；不提前宣称 L1 Resolved 或总体通过。其余既有测试记录和交给 S7 的旧 writeback 断言漂移不变。

## S7 实际实施与回归记录（2026-11-10，作者自测完成，待独立审查）

### 范围与处置

- 复核06全部A组、默认测试发现与S1～S6接入结果；完整追踪见新增[08实现与验收](08-implementation-and-acceptance.md)。07仅标注历史时点，不修改原设计审查结论。
- Fix：旧writeback取消用例的完整run state严格期望缺3个既有字段，补`runNoticeText`、`modelRequestError`、`retryCount`，不改生产返回、不放宽断言；定向2/2、API全unit通过。
- 补齐真实受管Worker的串行／并行／混合／合法失败工具整轮边界；原1例扩4例，净增3例，捕获第二次实际请求中的文字／PNG、完整call/result、同Run与确认来源。
- 新增Runner 5例：reasoning-only及合法replay-only阈值的continue/finish、真正空流不确认。使用默认OpenAI adapter校验原生metadata和completed终态，保留真正空流的旧失败语义；06作相应术语澄清，不删验收。
- 追加真实浏览器发现BROWSER-1后，经明确授权仅修改生产Web队列的两个watcher为多primitive sources，补5条生产同形回归。未改API生产代码、正式package／lock或默认测试脚本；未执行Git操作或读取敏感配置。固定Playwright 1.56.1与Chromium仅在`.tmp-tests/browser-e2e`隔离安装，新增可选harness；修复阶段复用既有工具，没有重装，详见08第9节。

### 第1轮最终命令与结果（BROWSER-1修复前）

仓库根设置`TMPDIR="$PWD/.tmp-tests" TSX_DISABLE_CACHE=1`。完整build、typecheck、Shared clean-build依序执行；Shared清建不与消费dist的测试并行。新增测试完成后又完整build、typecheck及Worker全量。API使用原默认完整脚本，不采用手工并发替代；Web默认组件并发2。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过，所有workspace |
| `npm run typecheck` | 通过，所有workspace |
| `npm test -w packages/shared` | 144/144 |
| `npm test -w apps/web` | 1288/1288，含runner自测22、非组件493、31组件文件共773 |
| `npm test -w apps/agent-worker` | 1354/1354，含新增5例 |
| `npm run test:unit -w apps/api` | API cwd 1938/1938，随后repo-root cwd插件8/8 |
| `npm run test:integration -w apps/api` | 590/590，默认文件集合与并发 |
| `npm run test:integration:worker -w apps/api` | 31/31，含扩展后的4种工具轮次 |
| `npm test -w packages/cli` | 421/421 |
| `npm test -w plugins/feishu` | 12/12 |
| API cwd：`node scripts/verify-test-gate.mjs` | 退出0 |

八组全量测试合计5786例，fail／cancelled／skipped均0；定向重复执行不重复累计。日志与补测开发中的SQL列名、无效空流fixture失败及修正过程，详见08第3节。未删用例、改timeout或放宽断言换全绿。

### 交付与限制

- 第1轮八组全量回归5786例通过。追加BROWSER-1已最小修复，修复后Web全量1293/1293、Web typecheck、完整样式Web重建、harness严格类型检查、Worker定向4/4，以及两个全新fixture真实Chromium完整A-COUNT均通过。未重复全部八组，也不累加重复测试为新的全量总数。S7作者自测完成，可交独立审查；本阶段未暂存／提交，不预先宣称独立或最终全面审查通过。
- 本地假provider捕获真实受管Worker请求，不等于真实外部模型联调；A-COUNT一次真实E2E门槛已由两轮全新fixture关闭，双标签／断网人工验收仍未执行。最终证据为`.tmp-tests/browser-e2e/evidence/agent-queue-jhm3Wc/`与`agent-queue-YeKJDS/`，两轮13项断言及cleanup均通过；证据／复跑命令／失败历史见08第9节，全部11个S7正式文件见第10节。
- SQLite迁移使用隔离fixture，不是升级真实用户数据；崩溃矩阵使用事务、RPC、runtime闸门的分层证据，不冒充每个点均做实机断电实验。

## S8：最终全面审查后的补齐修复（2026-11-10）

S7完成后最终全面独立审查**未通过**，发现H1／M1／M2／L1／L2。以下均按父任务明确裁决作Fix；本节不将S7历史自测等同于最终审查通过，也不覆盖此前失败记录。

| 编号 | 最小修复与取舍 | 证据 |
| --- | --- | --- |
| H1 | 固定Run／runtime实例、有界预留＋pending retirement、去重退避、普通／nested／fallback与shutdown drain；仍以Manager原实例真实exit作为独立收敛证明，不移除admission fence | Shared通知器、Worker真实finally、fallback、真实managed Worker三种故障；原实例exit不影响后继实例 |
| M1 | 新恢复操作在事务中CAS优先于Stop／profile，激活前重复CAS；旧成功操作仍优先重放原动作＋fresh queue | 真实Fastify HTTP：旧版本＋Stop pending、旧版本＋失效profile，均409 VERSION_CONFLICT且无新Run／状态修改 |
| M2 | 不加表、不改26；持久最小元数据＋每Run一个16MiB／全API128MiB冻结slot；严格prepare／finish／expired union，singleflight、COMMIT后发布及安全释放 | 回包丢失／cache丢失／finish重放／注入重放／异步旧准备／rollback／Stop／64KiB system与附件路径不入账本／真实128MiB容量边界 |
| L1 | 使用确认时快照展示全量对象数，明确不可逆、后续模型不读、保留历史、不撤销工具副作用、留存额度不返还 | 真实Pane的Modal确认文本与count参数、确认后集合变化保持原hash/version、晚Session确认隔离；HTTP集合冲突回归 |
| L2 | pending与unknown分别展示，unknown提供连接诊断与离线排他维护指引；不加force-resume；N独立 | 真实队列组件两态，quiescent后仍paused且N不变 |

源码与协议解释见03／04的S8追加节；构建、全量命令、浏览器证据、开发失败及限制统一追加在08。S8作者交付后仍须父任务复用最终全面独立审查会话进行复审，不自行宣称已通过。


## H2：明确容量拒绝的最小闭合修复

原五项审查问题已Resolved。本次仅处理新增H2（Fix）：容量503被视作未知写入，实证同operation连续8次而0提交／cache0，只有Abort退出。

1. Shared严格union增加持久`rejected`与两种reason，公共暂停原因增加准确诊断码。
2. API先重放旧裁决，在安全边界事务内持久容量拒绝；16／128MiB及1024在途名额均闭合，不覆盖旧slot／墓碑，COMMIT失败无假成功。
3. Worker在权威响应返回后（未知catch之外）进入既有failed＋paused；fallback同步处理；不改退休、Stop、输入确认及恢复语义。
4. 新增严格契约、单条／总额／在途名额、旧prepare／finish重放、回滚、stale head、真实fallback及managed Worker→AgentApiClient→输入服务＋SSE／网络unknown／显式resume与abandon回归。
5. 实际命令、开发失败处置和结果追加至08。交回父任务复用原existing全面审查会话；作者自测不等于独立全面通过。
