# 业务规则、状态机与关键决策

## D-PERSIST：受理、注入、确认分离

- receipt状态：queued→injected或cancelled；已注入不撤回、不倒退。
- injected的confirmation_state：unconfirmed→confirmed或abandoned，终态不可逆。
- queued不进正式消息链；injected同事务创建user和Run关联。
- confirmed表示输入完成合法确认，来源必须是worker_model或local_fallback；不等于目标完成或工具副作用exactly-once。
- abandoned是显式不可逆排除：历史仍在，UI标明“未处理，已放弃”；不是cancelled，不伪造confirmed。
- 暂停是Session控制状态，不为每条收件增加paused状态。

## D-BOUNDARY：整轮安全边界和FIFO

- 可吸收Run必须为user且interactive_queue_enabled=1；定时任务、CLI／插件强制触发、subtask／手动压缩不自动改语义。
- 同一模型响应全部tool calls必须有合法终态结果；不能在并行／串行批次之间插user，不能中断模型或长工具。
- 按服务端sequence FIFO，不跳队首；每边界最多8条，且只取当次准备看到的连续前缀。
- 额外queued先按Worker保守公式预算，后事务注入；不循环清空队列饿死模型。
- 普通空闲Run激活原子注入1条trigger；API不承诺精确token预算。Worker准备失败可保留injected+unconfirmed，必须有D-RECOVER/D-ABANDON出口。
- 已有未确认正式输入时，后台不能靠后续queued新建Run绕过它，必须通过新的正常发送承接恢复（兼容resume API仍保留）。
- injection保持head/revision CAS、有效Run fence、无streaming／未闭合工具检查。

## D-ESC-CLEAR：固定目标清空与发送代际

- Esc按最近可信queued快照分流，repeat／IME／busy忽略；状态缺失不猜测为空。清空0条不变成Stop。
- clear请求固定当前快照全部receipt IDs（上限100且unique），仅取消该集合仍queued项。已注入／已取消跳过；missing或foreign目标整批404回滚。重复请求效果幂等，cancelledCount只描述本次变化，不伪称持久动作重放。
- Web Stop复用同一个批量取消权威，并在原Stop事务replay检查之后、acceptedQueueVersion冻结之前选取本Session queued；通用nested／shutdown／recovery Stop不默认继承清空策略。
- stopGeneration为相关持久Stop barrier的(rootSessionId,operationId)排序集合SHA-256，退出证明变化不改代际，新Stop改代际。新Web在真实发送冻结并重试原值，最终receipt事务再核对；变化明确409 AGENT_QUEUE_STOP_GENERATION_CHANGED。
- Stop代际不纳入正文／图片去重指纹；原clientRequestId先重放原receipt，不能因重试解除暂停或再激活。旧API未提供代际时，route在onRequest、早于body/multipart解析捕获；service直调在首次await前捕获。
- 用户停止期间不允许queued；异常失败暂停仍可保留之前queued，只有新发送安全通过后解除暂停，不自动重放旧工具。

## D-FINISH：正常结束原子裁决

- 工具响应正常完成后再进入安全准备；无工具达到正常结束条件时，完成Assistant、确认绑定输入、continue/finish裁决与必要terminal intent同事务。
- 可推进且queued非空则continue，否则finish；纯文本、reasoning-only合法完成、空响应阈值均覆盖。
- 已提交finish之后的消息下一Run；同操作重试原裁决不变。
- continue后候选全被取消，下一prepare原子finish，不生成无新输入的额外模型调用。
- 取消／错误／预算终止优先，不能被queued复活。步数／重复工具计数不因新消息重置。
- 旧superseded Assistant不能确认输入；只有当前有效绑定的合法完成事务能确认，见D-BINDING。

## D-PROFILE：执行身份唯一

受理使用以下优先级：

- 当前可注入交互Run身份；
- 否则当前有效祖先链未确认输入共同身份；
- 否则队首queued固定身份；
- 否则按现有默认规则解析新身份。

所有待处理／未确认集合必须同Agent/provider/model ID；冲突暂停invariant_violation，不能混吸。显式不同agentId请求409且不入队；省略接受固定身份。默认切换不改已受理身份，配置失效暂停而非降级。放弃全部未确认后若queued仍在，身份仍由queued固定；取消queued后才可选择新身份。

## D-STOP / D-FAILURE：控制与恢复屏障

| 事件 | 行为 |
| --- | --- |
| 运行中受理 | 创建queued，保持当前active Run |
| Web停止 | 同事务paused(user_stop)、取消当前Session全部queued、关闭admission并冻结屏障，之后runtime cancel |
| 暂停后新发送 | 安全检查及停止代际复核后，同事务入队＋active／必要续接Run；pending/unknown/未drained拒收 |
| 错误／预算／不安全恢复 | 持久暂停，旧输入保留，不自动重放 |
| 正常收敛且只有queued | active可推进下一Run |
| 旧Run terminal-intent尚未收敛 | 不能激活、续接或放弃 |

- stop与激活同控制事务串行：stop先则不能激活，激活先则被取消。
- Stop安全优先：新Stop只带workspaceId/operationId，不带expectedQueueVersion；以该事务提交时的当前执行为目标，持久暂停。无Run也暂停；有已持久正常terminal intent时只暂停后续推进，不改其completed终态。
- 只有新resume/abandon携带expectedQueueVersion并执行CAS；不能泛称stop/resume/abandon“先提交者胜”。新Stop不因另一操作更新版本而被拒绝。
- 同一Stop operationId重试先重放既有结果，不再设置暂停／取消运行时，因此不会停止用户后来新resume的执行。用户下一次有效Esc Stop必须生成新operationId。每个全新Stop即使没有Run或已paused也推进queueVersion；Web批量取消同事务还可能推进版本；同ID重放不递增。

| 提交顺序 | 唯一结果 |
| --- | --- |
| resume成功→全新Stop | 两者均可成功；Stop最终paused并取消事务当时有效Run（若有） |
| abandon成功→全新Stop | 两者均可成功；abandoned历史保留，最终paused(user_stop)，不复活输入 |
| Stop→携带Stop前版本的resume/abandon | Stop成功，后者409 AGENT_QUEUE_VERSION_CONFLICT，无副作用 |
| Stop→刷新新版本后显式resume | 停止屏障已解除、旧Run DB收敛且其余检查通过后可恢复；不是旧请求自动恢复 |
| resume与abandon同预期版本竞争 | 首次成功者推进版本；另一新操作409，不按Stop例外处理 |
| 旧Stop已成功且屏障解除→新resume→旧Stop同ID重试 | 仅重放旧结果并附当前快照，不改变当前执行／暂停状态 |
| inject→全新Stop | 已注入历史保留，Stop取消当前执行；不把injected改回queued |
| Stop→inject | control暂停／Run fence阻止注入，Web Stop将queued取消 |
| 正常finish已持久→全新Stop | 保留原completed tuple，只暂停后续推进，不写cancelled冲突意图 |
| Stop已持久取消→正常完成尝试 | 完成写入受fence/终态重放保护，不覆盖cancelled；已合法完成历史保持 |

既有runtimeHandoffCoordinator只在回调存活时互斥，不能证明旧runtime退出。Stop改用D-STOP-BARRIER的持久屏障和固定Run精确cancel-and-wait；旧公开操作重放不发送取消，后台只重试原固定目标。DB已terminal或handoff已释放均不允许越过屏障resume。
- 当前没有checkpoint自动续跑：启动恢复失败的Run和其Session暂停；N可能为0但仍有未确认正式输入，UI不能假装无事发生。
- 系统错误收敛不能覆盖已有暂停原因；例如budget或provider超限先设具体原因，随后generic failed保持该原因，迟到失败不得覆盖用户stop。用户新stop可明确设user_stop，恢复只有显式新发送（或兼容新resume）在安全检查后可清除。

## D-STOP-BARRIER：Runner退出证据与停止屏障（H5）

- Stop事务固定根及权威cascade相关Run的(sessionId,runId,runtimeInstanceId)，同时关闭admission、持久停止记录／目标／屏障及DB暂停／终态；不能只取DB active或Worker activeRunIds。实例绑定和enqueue的原子顺序以03为准，未绑定且可证明从未发送的Run原子关闭，不漏在途enqueue。
- Worker／fallback先安装实例生命周期内保留的runId tombstone，再精确取消并等待root/nested finally；不按Session重选controller，不清同Session后来Run。新Worker UUID不匹配旧请求时零取消。
- pending表示目标尚未退出，unknown表示无法确认；仅本屏障、原实例和固定targets匹配的quiescent，或可信原实例真实exit证据可解除。DB terminal、取消受理、health、新ready或PID不存在均非证明。
- 屏障期间root及目标Session的resume/abandon、自动推进及所有运行／历史修改旧入口拒绝；允许只读、取消queued、Stop及严格匹配的收敛；新收件在停止屏障期间拒绝。具体入口清单和删除保护见03，不是只禁Web按钮。
- 每个新Stop独立记录并复制旧未解除目标，目标固定不事后扩大；所有相关记录均解除才不再阻塞。旧确认只更新旧记录，解除不自动active；仍需正常发送（或兼容新版本resume），不后台自动恢复。
- 公开旧Stop重试仅重放受理结果与当前快照；后台可有界重试同operationId+实例+targets以收敛首次未知，两者不混为“旧重试又停止当前Run”。
- API重启丢失原实例退出证据保持unknown暂停；可诊断／等待／查询，仅离线排他维护按03可信退出核验留证，不提供在线force-resume，也不重启整个Worker处理单Session Stop。
- 保证只到受跟踪Runner退出及旧取消不伤新Run。Git processStopConfirmed=false的unknown/lease、Workspace删除保护、逃逸进程及远端副作用不因屏障解除而清除；MCP未返回且Runner仍running仍pending。

## D-RECOVER：发送承接恢复，不重插user

用户正常发送新消息（兼容resume API仍可调用），所有相关停止屏障已解除、旧Run DB终态完全收敛且访问、Workspace、配置、静态输入／发布额度及既有工具安全检查通过后：

| 当前输入 | 行为 |
| --- | --- |
| 有未确认正式输入，queued可有可无 | 最终收件事务内创建新交互Run；trigger引用最早未确认既有user，纳入全部未确认可信输入；不新建user／不重写原注入Run |
| 无未确认输入，有queued | active后按FIFO普通激活 |
| 发送前都没有 | 新receipt入队后恢复active，普通dispatcher激活队首；兼容resume空队列时仅解除暂停 |

- 发送续接使用独立Run fence，与receipt提交同事务；clientRequestId先去重，再验证Stop代际和原恢复安全，重试不重复激活。兼容resume仍使用原control CAS和operationId，原动作至多创建一个续接Run。
- queued不抢在未确认历史之前注入；续接实际模型输入先保留原历史顺序，再在安全边界追加queued。
- 原附件已计额且可信可读即可复用；留存总额已满不阻止无新增发布的续接，不能重复预留旧文件。
- 不恢复旧Run，不重新执行旧工具；已有结果作为历史上下文。合法模型调用仍可能决定新工具动作，不承诺无任何新副作用。
- Worker预算／配置仍可能拒绝，失败再次暂停而不后台无限重试。confirmed／abandoned输入不能单独触发空队列续接。

## D-ABANDON：放弃全部未确认输入

- 仅所有相关停止屏障已解除、无有效Run且旧终态已收敛时允许；请求仅含workspaceId、operationId、expectedQueueVersion、expectedUnconfirmedInputSetHash及confirmIrreversible=true，不含预期ID数组。hash canonical权威定义见04协议，服务端事务内重算全部集合。
- 对象唯一：当前有效祖先链中全部injected+unconfirmed收件，不支持选部分；服务端重新计算集合，空集不创建状态变更（幂等旧操作仍重放）。
- 同事务标abandoned、paused(inputs_abandoned)、增版本并持久操作结果；queued原样保留，不自动启动。
- 已有任何合法完成Assistant确认的输入不可放弃；不删除历史、不取消已注入消息、不撤销工具副作用。
- abandoned从主模型上下文、primary-materializer、compaction source及provider私有replay统一排除，解除原文／附件保护；timeline可见且带标识。
- 附件安全保留和幂等墓碑不删除；放弃后处理queued必须正常发送（或兼容新resume）。版本变动包括输入确认，避免用旧确认集合误放弃。

## D-BINDING：Assistant创建、替换与恢复

- 可信输入快照绑定Assistant，而非只在创建时随手插关联。
- 普通retry的replace事务原子继承同一快照和集合；旧binding superseded，新binding active；旧完成回包不得确认。
- recovery replace/resume按本次实际PromptContext校验；同集合／同投影可复用，不同则既有replace路径绑定实际新快照，不能静默改原Assistant。
- replace／resume／complete响应丢失同参数重试；验证snapshot及输入集，不能新建第三次替换或提前释放保护。
- worker_model必须实际合法模型完成；local_fallback按本地回显完成事务确认，绝不虚构provider调用。

## D-BUDGET / D-INPUT-PROTECTION

- 完整公式、输出预留与输入来源以[实体技术文档](03-architecture-and-data-model.md#预算新增-queue-input-estimator-v1)为唯一权威。
- 现有自动压缩看lastResponseTotalTokens；旧estimator是启发式，不具完整动态工具／系统提示预算。新增Worker保守版本，不引入精确tokenizer或API工具影子。
- W必须来自有效配置；不知道窗口或输出预留非法就暂停budget_configuration_invalid。
- 未确认输入原文／附件不压缩、不裁剪、不降级；旧前缀可按完整轮次压缩一次并重新估算。
- provider明确context-too-large时停止本次自动重试，收敛并暂停provider_context_too_large；通过新发送／放弃恢复，不跳队首、不提前确认。
- 所有模型／预算／压缩／replay的有效输入集合与媒体策略同源，修复primary-materializer等trigger-only分支。

## D-IDEMPOTENCY：收件、控制与操作

- 收件键(workspaceId,sessionId,clientRequestId)，hash覆盖原始文本、显式身份/locale、图片顺序／文件名／类型／字节摘要，不含随机temp／attachment ID。
- 同ID同内容返回原receipt当前状态，同ID异内容409；先做访问／删除围栏再重放。
- 与旧agent_client_request碰撞409，不能产生第二次执行。
- 注入、续接、放弃、stop/resume和正常裁决都用持久operationId；结果未知同ID重试，不能换ID猜测。
- 取消queued天然幂等；与注入并发按先提交者决定，injected取消409。

## D-HISTORY：历史与删除

- 运行中禁止revert保持；有queued／未确认正式输入时revert和手动压缩409，需先处理、取消或受控放弃。abandoned解除保护，但消息不被物理删除。
- fork只复制正式历史，不复制queued、暂停／操作／去重；包含未确认输入的选定历史409，选择更早合法边界可fork。abandoned状态必须随有效历史投影被识别，不能fork后又进入模型上下文。
- listed/unlisted不等于删除；subtask只读不变。当前未发现独立Session删除入口，不虚构。
- Workspace删除先围栏／排空／逻辑清理；发布留存账本不级联、已发布文件不承诺物理删除。

## D-RETAIN：发布前持久预留，已发布安全保留

- 现有Workspace附件unlink明确不安全，本次不实现GC；只清理已证明未发布的temp。
- 发布前独立持久reservation，计实际文件字节；receipt受理事务回滚不能抹掉记账。
- 同DataDir本功能留存上限1GiB；未知／取消／已注入／放弃／逻辑删除不自动减额。重复request不能重复发布或绕过额度。
- 发布结果未知保留额度并诊断；空间满507，不自动删用户文件。离线排他维护后人工对账是唯一已发布减额出口，具体规则见技术文档。

## D-LIMIT：有界常量与公平性

| 本次新增常量 | 值 |
| --- | --- |
| AGENT_QUEUE_MAX_PENDING_COUNT | 100 |
| AGENT_QUEUE_MAX_PENDING_BYTES | 64 MiB（queued文本与图片） |
| AGENT_QUEUE_MAX_TEXT_BYTES | 64 KiB UTF-8 |
| AGENT_QUEUE_MAX_INJECT_BATCH | 8 |
| AGENT_QUEUE_ATTACHMENT_RETAINED_MAX_BYTES | 1 GiB（独立DataDir账本） |

现有4张／单张10MiB／合计20MiB图片限制继续生效。取消／注入释放pending额度但不释放发布留存额度。shared同源常量；并发检查与修改同事务；扫描按Session轮转，每轮每Session最多激活1次，故障暂停不busy-loop。

## D-SNAPSHOT / D-COMPAT

queueVersion覆盖queued变化、控制、确认和放弃；N只统计queued，未确认正式输入不混入N，另显示恢复提示。新Web收件与旧强制启动契约隔离，见[接口](04-api-and-worker-protocol.md)。
