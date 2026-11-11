# 测试计划与验收标准

本文保留设计阶段验收清单；下文“本次文档编写没有运行”指设计编写时点。实施后的S7执行记录、分层覆盖与尚未完成的人工验收见[实现与验收](08-implementation-and-acceptance.md)，不将计划自动视为通过。

## 验收方式

- 每项验收记录关联需求、代码／测试文件、断言及执行结果；不能只提供截图或“接口200”。
- 用可控假provider捕获**实际发送给模型的消息及附件输入**；用工具闸门、事务提交闸门、RPC丢回包和假时钟建立确定性交错，不靠sleep碰运气。
- 必须证明当前Run ID不变、下一次合法模型请求含新消息、工具call/result完整；正式数据库里出现user仅是必要条件。
- 受理202不作为Agent处理完成证据；文件已存在不作为图片真正进入模型的证据。
- 所有本次新增测试必须进入默认测试脚本；本次文档编写没有运行下列测试，不能标为已通过。

## A-ACCEPT：受理与空闲启动

对应R-ACCEPT、D-PERSIST。

| 场景／操作 | 必须断言 |
| --- | --- |
| idle发送文本 | 返回稳定receipt；随后仅一个交互Run和一个trigger user；receipt关联一致 |
| 工具执行期间发送 | 接口不因busy拒绝；receipt queued，正式head/revision此刻不因入队变化 |
| 模型streaming期间发送 | 原请求数组不变；queued可见；当前响应不被强制中断 |
| Worker暂不可用 | 合法受理可成功持久化；推进失败有状态／暂停，不丢receipt，不伪造执行成功 |
| paused发送 | queued和N增加，仍paused，不自动启动 |
| 纯图片发送 | text可空，有合法附件，仍正常受理 |
| 同Session两个首次发送并发 | sequence唯一递增，只激活一个Run，FIFO不倒置 |
| 非交互Run占用Session | Web可排队但不吸入该Run，正常收敛后创建独立交互Run |

## A-BOUNDARY：同Run与工具轮次

对应R-INJECT、D-BOUNDARY。

- provider第一次返回A/B/C工具；执行A后入队，阻塞B或C。断言工具未全部闭合前receipt一直queued，模型第二次请求尚未发生。
- 释放所有工具后，断言模型第二次请求顺序为Assistant calls → 全部tool results → 新user，receipt injected，前后runId相同。
- 分别覆盖串行、并行批次、工具合法失败结果、多个混合批次；不能只测试单工具。
- 长bash／subtask期间能受理，但不抢占，不跳过剩余工具。
- 存在orphaned running工具／缺失结果时不注入，按现有错误语义收敛并暂停。
- 一次边界有超过8条收件，只吸收FIFO前缀不超过8；随后实际调用模型，不能无限循环清空队列。
- 候选取快照后新消息入队，新消息不挤入这次注入；queueVersion更新但旧head不被伪造改变。
- 最大步数、重复工具限制已达时，不先注入一批再以新消息重置计数。

证据：provider调用次数、实际请求payload、runId、receipt序列、message链及各tool execution终态。

## A-FINISH：正常结束竞争

对应D-FINISH。

| 交错 | 必须断言 |
| --- | --- |
| 消息先入队，纯文本完成事务后提交 | 当前Assistant完成但Run不terminal；continue，同Run下一模型请求含新消息 |
| 正常finish事务先提交，随后入队 | 旧意图保持completed；新收件等待旧Run收敛后进入下一Run |
| complete回包丢失后又入队 | 重试返回原finish，不改成continue；新消息后续推进 |
| continue回包丢失后队列被取消 | 重试仍continue；下次prepare原子finish，不产生无新输入额外模型调用 |
| continue后停止／预算到达 | 不再吸收，按cancelled／failed收敛，未注入保留且paused |
| 合法无可见文本响应达到现有阈值时入队 | 走相同原子裁决，无悬挂，不遗漏纯文本之外分支；如官方OpenAI合法replay-only。真正无文本／reasoning／tool／合法replay的空流沿用既有provider失败语义，不得为清队列伪造正常完成 |
| reasoning-only合法完成 | 保留provider原语义，同时按队列决定continue/finish |
| terminal intent已提交后取消 | 不选择冲突终态，不改变先前持久tuple |

## A-IDEMPOTENCY：受理与注入去重

- 同requestId／同payload反复POST：只有一个receipt、一个sequence，回包当前状态正确。
- 注入后／取消后重复原POST：不新建receipt，不再排队；已取消仍cancelled。
- 同requestId不同文本、图片顺序／字节／文件名、显式身份字段：409，无额外文件业务引用。
- multipart重试tempId/attachmentId变化但原始内容相同：视为同payload，不替换已受理附件。
- 达到容量后重试既有请求：返回原结果，不误报容量满。
- 与旧agent_client_request同键碰撞：明确冲突，无第二Run／消息。
- inject提交后丢回包：相同operationId重试返回原message IDs；不吸收新到达的下一批。
- 同operationId异参数：409；过期Run只能重放已提交结果，不能产生新的注入。
- queueVersion递增和receipt转换同事务，无“消息已注入但N还包含它”的服务端快照。

## A-COUNT：输入框上方数量——硬验收

对应R-COUNT、D-SNAPSHOT。

| 操作 | 必须看到的结果 |
| --- | --- |
| 初始N=0 | 输入框上方没有数量提示 |
| 服务端受理1条但工具未完成 | 输入框上方显示“有 1 条消息等待处理” |
| 连续受理3条 | 显示3，FIFO列表3条 |
| 其中1条注入 | 显示2，不等待整个Run完成 |
| 再取消1条 | 显示1，取消项不计数 |
| 最后一条注入／取消 | 提示隐藏 |
| 停止时仍有2条 | 显示2并另示暂停原因；不降为0 |
| 暂停后再发送1条 | 显示3，仍暂停 |
| 草稿、上传中、HTTP尚未确认 | 不加入服务端N；不能前端自增假计数 |
| 受理回包丢失但轮询已发现 | 按requestId合并，只计一次，确认后正确清理对应草稿 |
| 正式消息revision不变但另一端入队 | 下一次queue轮询发现N变化 |
| 刷新／重连／切回标签页 | 从服务端恢复准确N，不依赖本地缓存递增 |
| 网络中断 | 保留最近可信N并提示同步异常，不伪置0 |

位置需要组件断言和一次人工／端到端检查；仅状态单元测试不能证明文字在输入框上方。

## A-MULTICLIENT：乱序与多端

- 双标签页同时发送、取消：N与items最终一致，sequence唯一。
- 先收到version=12再收到version=11：UI不倒退；相同version内容不一致应诊断，不靠到达时间覆盖。
- Session A请求迟回时已切到B：A快照不能污染B提示或草稿。
- 第一份草稿提交后继续编辑，稍后旧请求确认：新草稿不被清空。
- 已注入receipt的旧queued回包不能让该项重新出现。
- 等待注入消息数不被Run registry当成多个Run；一个Run吸收多条仍只登记一个执行。
- idle/N=0另一标签页发送，在3秒低频周期加请求时间内可见；running／pending／paused在800ms周期加请求时间内可见。隐藏页恢复立即刷新。

## A-STOP / A-PROFILE：控制与身份

- 停止与激活并发两种提交顺序均验证：无停止后新激活遗漏；若激活先成功，新Run进入取消流程。
- 停止与inject并发：inject先提交的消息保留历史；stop先提交则后续inject失败，queued仍计数。
- stop重复operationId不能取消后来用户显式继续创建的新Run。
- resume携带旧queueVersion：409，不解除另一端新暂停；同operationId重试只重放原结果。
- Run尚terminal-intent未收敛时resume返回draining，不创建第二Run；即使DB已terminal，H5屏障pending/unknown仍必须拒绝。
- queued为空且无未确认输入时stop/resume不创建空Run；有未确认输入时显式resume创建续接Run但不新建user；paused后单纯发送不恢复。
- 运行中显式不同Agent：409不入队；省略沿用当前Run。
- 无Run但有queued时另一标签页改默认／显式选择不同Agent：不改旧身份；显式冲突拒绝。
- 配置被删除／禁用或模型不支持待处理图片：暂停profile_unavailable，不自动换模型。
- 错误、预算耗尽、启动恢复失败后，队列不自动执行；已注入不自动回queued。

## A-CONTROL-RACES：安全优先Stop（M3）

| 确定性交错 | 必须断言 |
| --- | --- |
| resume先提交创建续接Run，后全新Stop提交 | 两操作成功；最终paused，事务当时有效Run被取消，不产生双Run |
| resume仅恢复queued，尚未激活时全新Stop | 两操作成功；后续dispatcher不能越过暂停激活 |
| Stop先提交，再旧版本resume／abandon | 后者409版本冲突，无新Run／放弃，queued和确认历史不变 |
| Stop屏障解除→用户刷新并新resume→旧Stop同ID重试 | 原停止结果可重放且附当前快照，但不增版本、不暂停、不再次发送runtime cancel |
| 相同场景改成全新Stop ID | 属新停止，成功暂停并取消当时有效Run，与旧重试区别可测 |
| 无Run或已经paused时全新Stop | 持久paused，每个新操作递增queueVersion；相同ID重试不增版本 |
| inject先提交→Stop | injected正式历史和确认状态不倒退；当前执行停止 |
| Stop先提交→inject | control／fence拒绝注入，queued保留 |
| 正常finish intent先提交→Stop | completed tuple保持，仅暂停后续，不能另写cancelled |
| Stop已提交cancel intent→迟到正常完成 | fence／终态唯一性阻止覆盖，不能改为completed |
| Assistant完成并continue→Stop | 已确认输入保持confirmed，当前Run可取消，后续准备／注入受暂停和fence保护；已开始请求仅尽力中断 |

用事务闸门和runtime取消调用计数验证；不能只断言最后UI显示暂停。既有handoff互斥不作为退出证明；必须断言持久停止屏障与精确quiescent，未知runtime／旧Run未收敛时不提前恢复。

## A-STOP-BARRIER：持久停止与精确目标（H5）

用DB事务闸门、物理enqueue闸门、Runner finally／nested／工具闸门、RPC丢响应及可信实例假件验证；记录固定targets/hash、实际取消runId、持久证据与工具lease，不能只断言DB状态或接口200。

| 确定性交错／边界 | 必须断言 |
| --- | --- |
| Stop已DB terminal/converge，旧Runner仍running，handoff已释放 | stop.pending；当前版本resume/abandon及旧强制／历史入口409，绝不创建新Run |
| 精确RPC已收但响应丢失／客户端超时 | unknown可见，不作void成功；后台同ID/实例/targets重试，公开旧Stop重试不主动发取消 |
| 精确RPC安装tombstone，MCP一直未返回 | pending，不能用目标暂不存在／health健康伪造quiescent |
| 未绑定Run准备enqueue时Stop先关闭 | binding CAS失败，没有物理发送；无目标Stop仍有记录、暂停版本与关闭证明 |
| 绑定提交、enqueue尚未发送或已在途时Stop | 固定目标含该UUID；旧请求晚到被tombstone或有效Run admission拒绝，无漏运行 |
| enqueue在外await校验→精确停止确认→校验回包迟到 | 登记前重查tombstone，不能在quiescent后复活queued/controller |
| 当前根Run已换代／idle，旧child仅DB running且从未bind/enqueue | 保持当前树取消权威；旧unbound child／孙不被取消、不被关admission或暂停；先创建根子孙后正常converge根结束构造fixture |
| 旧child确已bound且DB completed但runtime未退 | 合并原实例及runId为固定target；阻止历史修改，正常completed意图不被覆盖 |
| 超过32个长期unknown与后续可确认Stop并存 | 游标轮转到后续operation；同Session单轮最多一组、原组退避且不改变固定请求 |
| fallback ready但API尚未listen | Run保持running、queued工具不变、admission关闭；真实listen后统一恢复并开放；testkit等待同一生产恢复屏障 |
| fallback drain超期／context迟到 | 有界返回且保留unknown、不造退出证据；迟到任务不得写历史，不能在DB关闭后退休写回 |
| root+DB terminal但仍执行的nested+queued派生Run | authority cascade全部入固定目标；nested即使不在activeRunIds也精确abort/等待finally；后建child被父fence挡住 |
| 新Stop S1、再新Stop S2，同root旧目标未退 | 两独立记录／版本；S2复制目标，S1 RPC确认只解S1，S2仍阻塞；旧响应不扩集合或覆盖S2 |
| 目标分属不同实例／部分组已确认 | 只确认匹配组；其他pending/unknown时整个barrier不能解除 |
| 所有目标quiescent后重新查询 | 全部相关Session版本同步更新，stop.quiescent但mode仍paused；不自动推进queued |
| 屏障未解时拿最新版本resume；解后拿旧版本resume | 前者409 STOP_PENDING/UNKNOWN；后者409 VERSION_CONFLICT；刷新新版本后才可显式恢复 |
| 屏障解除并显式resume新Run→旧精确cancel迟到／重复 | 只命中旧固定runId/tombstone，不abort新controller、不移除新queued、不重选Session当前Run |
| 旧实例A请求投到新实例B／旧A确认晚于新Stop | B零取消并返回实例冲突；A证据仅匹配原barrier，不清新Stop |
| Manager握有精确ChildProcess真实exit | 先持久UUID+进程身份退出凭证，才确认该实例目标；工具unknown/lease不变 |
| API恢复旧未retired admission但此前无Stop | 补建一次持久恢复Stop／固定目标，重试不重复建；未知阻止resume，不只标DB failed |
| API重启，旧exit未落盘，新Worker ready／PID不存在 | 保持unknown与暂停；不得凭新generation/健康/analytics推断退出，其他无屏障Session不被全局阻断 |
| 同实例可重新握手／离线排他维护 | 仅原UUID精确重试可收敛；严格校验原身份形状与值、维护ID／观察者／排他核验和时间；离线真实退出凭证后逐barrier解除，无在线强制忽略，不凭PID消失 |
| fallback回显阻塞在finally，DB已terminal | 同持久屏障pending，按runId清本地queue；finally后精确确认；新API UUID不清旧unknown |
| Git processStopConfirmed=false而Runner finally已结束 | 可确认Runner quiescent，但Git未知／lease／Workspace删除保护原样保留；不解锁、不标工具停止成功 |
| bash逃逸进程／remote-plugin不支持abort | 不声称回滚或全部进程退出；受跟踪Runner还没finally就不解屏障 |
| 无Run／已paused新Stop及公开旧Stop重试 | 新操作仍记barrier并增版本；旧重试只返回稳定受理结果及当前快照，不能假称runtimeStopped |
| Workspace删除／关机与未确认停止交错 | 不清未知证据、不释放lease；关闭顺序先admission／推进、再停止及证据任务、最后DB，无晚写 |

- 真实SQLite执行03新增DDL，检查跨Workspace／Session／实例的target FK拒绝、非法NULL证据拒绝、复合父键与索引、pending/unknown不能当quiescent；foreign_key_check无行。kind=stop、绑定不可改、集合hash、状态单调性由应用事务测试补足，不能假称CHECK能验证完整证据。
- 真实RPC schema验证实例UUID、重复targets、非法hash、不同参数同ID、timeout与认证失败；旧idle:boolean和吞错void都不能作为证明。响应乱序不能把quiescent退回pending，错误proofId／实例／hash不能解除。等待预算变化只改变单次等待，固定targets变化才幂等冲突；terminal/paused/删除围栏下仍可读取可信绑定并停止，防调解自锁。
- 所有入口参数化覆盖root及target Session：resume/abandon、自动推进、旧messages/runs/trigger、scheduled、nested、revert/fork/manual_compaction及历史修改；安全只读、受理queued、取消queued和Stop仍可用。CAS旧版本冲突优先保持M3/M4。
- Web验证“停止确认中／停止状态未知”、N=0仍显示、N仍仅queued、刷新／重连／多端不消失；仅可查询等待，无force-resume；解除后按钮按paused及工具保护恢复，不自动启动。

## A-ABANDON-SCHEMA：公开hash与全量对象（M4）

- 真实公开TypeBox schema接受且仅接受workspaceId、operationId、expectedQueueVersion、expectedUnconfirmedInputSetHash、confirmIrreversible=true；合法非空快照请求能放弃完整集合。
- 附加expectedReceiptIds、receiptIds、expectedInputReceiptIds或其他ID字段一律400；不能只在应用层忽略后当成功。必须包含Fastify真实HTTP注入测试，防默认AJV removeAdditional把未知字段擦掉后放行；直接schema单测不能替代。Stop附带expectedQueueVersion同样400。
- 缺字段、confirmIrreversible=false、非法／非小写64位hash、非安全整数版本400，无副作用。
- canonical golden使用至少两条未确认输入，按04固定version/scope/inputs字段、正式链顺序、UTF-8及key排序生成；同快照查询和写事务重算相同hash，空集snapshot为NULL。
- 使用当前正确queueVersion但旧集合hash（服务端仍有非空未确认集合）返回409 AGENT_UNCONFIRMED_SET_CONFLICT；使用旧版本优先409 AGENT_QUEUE_VERSION_CONFLICT，无任何部分放弃。
- 仅对合法集合子集计算的hash、其他Session／Workspace的hash、顺序被改写的hash均冲突；服务端不接受客户端对象选择。
- 同成功operationId重试仍重放原全量结果及当前快照，不因现在集合为空再次执行；不同参数同ID按既有幂等冲突处理。

## A-IMAGE / A-COMPACTION：真实输入与保护

- 初始图片、运行中后插图片、纯图片、文本+多图片均捕获实际provider输入，验证不是只有路径占位。
- 附件格式、数量、单张与合计大小沿用现有限制；跨Workspace、伪造attachmentId、软链替换拒绝。
- 新消息注入后，模型完成前触发自动压缩：原文与必要附件仍在下一次实际模型输入，不被摘要或裁剪。
- 旧前缀可以压缩，边界必须完整，不切断tool call/result；压缩与注入CAS冲突重新准备。
- 队首放不下时不跳过后续消息，未注入的队首保留queued并暂停；取消后，若原未确认输入已可安全处理或已放弃，显式继续可推进后续；不承诺取消一条能修复所有预算故障。
- API只做输入／图片／容量和身份检查；trigger原子注入后由Worker保守准备，超限时保持injected和未确认保护、暂停，N可为0；显式继续／放弃均可恢复，不能永久卡死。
- provider错误／结果未知不标记confirmed_at；后续显式交互在新Run读取未确认历史输入时仍保留真实图片，不重复激活旧Run。
- Worker仅实际合法模型完成才确认source=worker_model；fallback回显完成才确认source=local_fallback；不能伪造模型请求成功。绑定和来源均需证据。
- 队列取消、放弃、重复上传、receipt正文清理、fork与Workspace逻辑删除均不自动unlink已发布Workspace附件，留存记账不释放。

## A-LIMIT / A-HISTORY / A-SECURITY

- queued达到100条，或64MiB pending容量，新增受理429；并发请求不能越限。注入／取消释放额度，重试旧request仍成功。
- 文本64KiB边界按UTF-8字节测中英文，超过413；图片仍按既有限额。
- 多Session扫描不被一个繁忙Session垄断；一个故障Session暂停，不busy-loop。
- 有queued／未确认已注入输入时revert和手动压缩明确冲突，受控放弃后解除保护；运行中限制不降低。清理queued不等于删除已注入历史。
- fork不复制queued、控制暂停、操作／去重记录；包含未确认已注入收件的分叉边界409，选择其之前的合法边界可成功，正式历史和共享附件仍完整。unlisted切换不丢队列。
- Workspace删除先封准入再排空Run；删除中POST／resume／inject拒绝，重启后继续删除不会恢复执行。
- 内部RPC缺token拒绝；旧Run、另一Session／Workspace receipt和伪造输入绑定拒绝。
- 日志与错误无正文、图片内容、凭据、内部token、私有绝对路径或原始provider错误泄漏。

## A-RECOVERY：崩溃点矩阵

| 崩溃／响应丢失位置 | 重启／重试后的权威结果 |
| --- | --- |
| 附件temp完成，尚未受理提交 | 无receipt；temp可安全回收；同request可重试 |
| 文件发布成功，DB回滚／未提交 | 无receipt；独立reservation保留，可能发布则retained计额，不自动unlink |
| 受理提交成功，202丢失 | 一个queued receipt；查询／同ID重试返回原记录 |
| 激活事务提交前 | receipt仍queued，无半个Run／半条user |
| 激活提交后、Worker enqueue前 | 唯一Run及admission；物理发送前必须已绑定，关闭CAS或精确tombstone覆盖旧enqueue；重启无退出证据则unknown阻塞 |
| Worker enqueue成功但回包丢失 | 不生成第二Run；现有未知受理对账仍有效 |
| inject事务提交前 | 全批保持queued，正式head无部分前缀写入 |
| inject提交后、回包丢失 | 全批injected；同operation重试不重复；崩溃恢复不自动重放工具 |
| 输入绑定持久后、provider尚未完成 | 未确认保护保留；恢复失败暂停；停止屏障解除后N=0可显式续接／放弃 |
| 模型完成裁决提交后、回包丢失 | 原continue/finish稳定重放，不重选相反终态 |
| stop提交后、精确RPC前／回包丢失 | 固定目标／admission关闭／barrier持久，pending/unknown；DB terminal不解除，恢复不执行queued，禁止resume |
| resume提交后、响应丢失并再次stop | 原resume重试不解除新stop；当前快照为paused |
| 取消提交后、诊断更新前 | cancelled持久，不执行；已发布文件和额度保留，未发布temp安全清理 |
| Workspace删除意图持久后 | 准入／推进封闭，停止屏障和工具lease未满足则等待，不得提前清理证据或引用 |

每个“提交前／提交后”用事务hook控制，断言数据库和文件引用，而不是只杀进程观察表面状态。

## A-COMPAT / A-MIGRATION

- 旧send及内部trigger仍201、必有messageId/runId；队列占用和暂停时明确409，不悄悄返回新receipt结构。
- scheduled、subtask、manual_compaction无interactive标志，不吸入Web消息；独立Run身份、历史fork和快照语义保持。
- 本地fallback仅回显，确认source=local_fallback；受理、计数、停止、恢复及continue/finish一致；API onListen恢复前不推进，不宣称完整工具／模型能力。
- 从当前schema及既有支持版本升级：Session、消息图、附件、client_request、Run与unlisted数据数量／内容一致，默认交互标志0。
- 未知schema明确拒绝，不因新增表签名错误进入破坏性rebuild。
- 升级事务中断可以重试；FK检查通过；Workspace删除顺序覆盖所有新表，不误删其他Workspace。

## A-RECOVER-EXIT：N=0也能恢复原Session（H1）

以下成功路径均以前述停止屏障已解除（或可证明没有需等待的旧runtime）、DB收敛及既有工具安全条件满足为前提；H5未知状态不允许靠H1恢复出口绕过。

| 场景 | 必须断言 |
| --- | --- |
| trigger注入后预算准备失败，N=0 | UI仍展示未确认输入；显式resume新建续接Run，旧user数量不增、trigger引用既有user，原注入Run不改 |
| Worker启动失败，旧Run恢复failed | paused持久，原Session可继续或放弃，不要求另建Session |
| 未确认输入+queued并存 | resume优先原输入历史，queued保持FIFO和共同身份；不能queued另起Run绕过 |
| 同resume操作回包丢失 | 返回同一续接runId，无重复user／Run，enqueue使用同Run对账 |
| 旧Run尚有效或terminal-intent待收敛 | resume和abandon均409，无新Run、无状态修改 |
| 全部输入已confirmed／abandoned、N=0 | resume仅解除暂停，不重新触发旧输入 |
| 全量abandon | 输入state=abandoned、历史保留、N不变、继续paused；未确认数归零，不能误标confirmed |
| 旧模型被删除／窗口配置无效／留存额度已满 | 不能继续时仍可放弃；放弃不依赖模型和新增额度 |
| 放弃后再resume queued | 旧输入从实际provider消息、图片、replay和压缩source都排除，queued正常推进 |
| confirmed对象／选择部分对象 | confirmed不在全集；空集409，无部分接口；ID数组400，部分集合hash或旧版本409 |
| resume/abandon同预期版本竞争 | 首个成功后另一个409，不能误套到新Stop |
| resume/abandon成功后全新Stop | 两者均可成功，最终paused(user_stop)，取消当时有效Run（如有），不复活abandoned |
| Stop成功后旧版本resume/abandon | 409 AGENT_QUEUE_VERSION_CONFLICT，无恢复／放弃副作用 |
| abandoned历史fork | 新会话有效模型投影仍排除该消息，不因未复制receipt调度记录而复活 |

续接不回放旧tool executions；捕获执行调用记录证明不是重复启动旧Run。新模型自主提出新工具不属于“exactly-once”保证。

## A-BINDING-RETRY：输入绑定贯穿Assistant身份（H2）

- 创建Assistant、binding、input IDs同事务；提交回包丢失重试得到相同binding。
- 普通模型失败重试触发现有replaceAssistantForRetry：旧superseded、新active；相同snapshot／集合原子继承，合法新完成才能确认。
- 替换事务前失败保持旧active；替换提交后丢回包重试不创建第三Assistant。
- 旧Assistant迟到完成、旧fence、同替换请求异输入hash均不确认任何receipt。
- recovery replace和resume分别覆盖；实际context相同可以claim，不同必须走现有replace重新绑定，不能在旧Assistant上静默换集合。
- 两条Moonshot/DeepSeek recovery替换路径、普通provider resume路径都验证；不能只测试新建Assistant。
- complete提交未知原操作重放稳定；provider失败／取消始终unconfirmed，合法工具／纯文本完成均confirmed且source正确。
- 图片普通retry使用冻结buffer；recovery同inode字节变更也必须摘要校验失败并暂停，不能以旧binding确认新内容。

## A-BUDGET：Worker保守公式与超限（H3）

- golden fixtures独立算出W、R、B、M、P、Tcall/Tresult、I、E和C，验证与queue-input-estimator-v1完全一致；不是只测“有估算值”。
- W缺失／非正／非有限、R非正或R>=W必须budget_configuration_invalid；不得用1或128k兜底。
- 无显式输出值时R=min(4096,max(1,floor(W/4)))且真实模型请求发送R；aiSdk覆盖顶层兼容值，边界E+R等于C可提交、大1拒绝。
- 添加system、动态工具schema、长description、tool result、opaque replay都增加B；encryptedContent不能只按占位计费。
- 图片每次出现按8192，预算、primary-materializer、主projection及compaction source真实图片集合一致；abandoned不在任一集合。
- 0..8前缀评估有界，最终真实请求使用所选冻结toolSet；预算后不得重新发现另一组工具。
- 一个准备周期最多一次旧前缀压缩重算；未确认硬保护覆盖原固定尾部planner，不丢原文／附件。
- provider明确context-too-large时不走无限自动retry，failed+paused，未确认保留，可走A-RECOVER-EXIT。
- 估算低于窗口但provider仍超限是允许的可诊断失败，不能把“启发式不绝对保证”当作丢队首、先确认或摘要新消息的理由。

## A-RETENTION：安全保留、预留与1GiB（H4）

| 交错／边界 | 必须断言 |
| --- | --- |
| 发布前reservation提交，尚未publishing | 已占额度；确定无发布者／未尝试才释放；不盲目unlinkWorkspace |
| publishing持久后进程退出 | retained(outcome_unknown)，计额，不自动重发该intent |
| 文件发布后receipt事务回滚 | reservation仍在且计额，无Workspace unlink |
| receipt提交后回包丢失 | 同request查询原receipt，不重新发布，不重复扣额 |
| 反复上传—取消／放弃 | pending额度释放但留存额度单调积累，最终1GiB阻止新发布，不能无限增长 |
| 两个并发预留将越1GiB | 最多一个成功，另507且没有发布 |
| 重复request不同temp ID | 复用同intent或明确未知409，不产生新文件／新额度行 |
| 同UID替换路径／inode变化 | 不复用不安全文件、不unlink，保留额度并安全诊断 |
| Workspace逻辑删除及重启 | 账本仍存在、仍计额；不承诺物理文件全回收 |
| 507 | 文本仍可受理，图片草稿保留；错误只安全字节／ID，无路径和内容 |
| 未发布temp清理 | 沿现有安全临时文件原语，不将此保证套到Workspace已发布文件 |
| 离线维护 | 无在线自动释放API；排他停机／身份／引用／审计不满足时不能减额，已发布释放保留维护记录和发布幂等墓碑 |

1GiB只约束本功能新发布原文件字节，不测试为全磁盘配额，也不声称覆盖历史附件或工具自产文件。

## A-SCOPE-DDL：真实复合FK（M1）

- 在SQLite启用foreign_keys，执行迁移生成的真实DDL并插入control/receipt/attachment/Run/binding全链，不能只断言SQL字符串。
- 父键UNIQUE覆盖每个复合FK的确切列和顺序；控制行的(workspace_id,session_id)必须真实存在唯一键。
- 错Workspace、错Session、跨receipt附件、错Run和确认Assistant都被约束／事务拒绝；confirmation_state=NULL携带确认时间也拒绝，避免SQLite CHECK的NULL旁路。
- PRAGMA foreign_key_check无记录；新表清理顺序和binding自引用解除后删除成功。
- 升级分类器recognize新schema，非破坏保留数据；publication账本不加入Workspace级联及Agent域rebuild清单。

## A-FALLBACK：确认来源与双启动屏障（M2）

- 本地回显完成事务source=local_fallback，worker实际模型完成source=worker_model；fallback没有provider请求也不虚构一条。
- fallback纯图片／多图片回显数量与安全文件名，不出现[object Object]，不声称模型看过图；不执行Worker工具／token预算，仍按统一有效输入策略和安全附件限制。
- fallback连续入队／continue/finish、停止、N=0未确认恢复及放弃语义一致，无需模拟工具执行。
- Worker ready前和恢复屏障未结束前均不推进；fallback API onListen恢复未结束前也不推进。
- 两路径关闭先停admission、扫描和注入，再精确停止runtime／Worker并持久证据或未知，最后DB；假时钟验证关闭后没有晚到SQLite／RPC操作。

## 现有测试基础与新增归属

| 位置 | 复用与补充 |
| --- | --- |
| `apps/api/src/modules/agent/run-lifecycle.persistence.test.ts` | 原子激活、fence、终态与停止 |
| `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts` | enqueue未知结果、恢复、暂停 |
| `apps/api/src/modules/agent/agent.worker.integration.test.ts` | API到Worker同Run注入集成 |
| `apps/api/src/modules/agent/read-side/runtime-transcript-projector.test.ts` | 多user真实图片与完整tool结果 |
| `apps/api/src/modules/agent/read-side/model-context-resolver.test.ts` | 上下文边界、保护与快照 |
| `apps/agent-worker/src/runtime/runner.stop-condition.test.ts` | 不重置预算与空响应完成 |
| `apps/agent-worker/src/runtime/runner.provider-terminal.test.ts` | 正常裁决、binding替换与terminal replay |
| `apps/agent-worker/src/runtime/runner.cancel.test.ts` | 固定目标、nested/tombstone、迟到enqueue/cancel、finally证据与提交竞争 |
| `apps/agent-worker/src/runtime/runner.auto-compact.test.ts` | 未确认硬保护、primary materializer及新保守公式 |
| `apps/agent-worker/src/runtime/runner.orphaned-tools.test.ts` | 不完整工具禁止注入 |
| `apps/api/src/modules/agent/attachments/agent-attachment-storage.test.ts` | 安全temp／发布、Workspace拒绝unlink及留存账本 |
| `apps/api/src/modules/agent/attachments/agent-workspace-attachment-storage.test.ts` | Workspace附件路径与引用 |
| `apps/api/src/infra/db/schema.test.ts`及既有migration测试 | 非破坏升级与签名 |
| `apps/api/src/infra/db/workspace-agent-data-cleanup.test.ts` | 新表清理顺序和隔离 |
| `apps/api/src/modules/workspaces/workspace-deletion-restart.integration.test.ts` | 删除意图与重启 |
| Web `agentPendingRunRegistration.test.ts`、`agentTimelineRefreshScheduler.test.ts`、`agentImageAttachments.test.ts` | 不伪造Run、独立轮询、图片发送 |

新增队列store／应用、Worker消息注入、Web queue状态／组件测试文件可以按职责命名，但必须落入现有测试发现和API gate分类。测试命令见[实施文档](05-implementation-plan.md#最小自检与回归命令)。

## 审查与交付门槛

- R-*、D-*均有对应自动测试或明确人工验收证据，特别是A-COUNT和同Run实际输入证据。
- 不允许以“后续再做”绕过停止／终态并发、持久幂等、图片、压缩保护、恢复或删除边界。
- 未通过的行为不得标记完成；已知限制与非目标必须和本目录一致。
- 无业务代码之外的重构混入，无敏感数据、无外部服务依赖、无破坏性迁移。
