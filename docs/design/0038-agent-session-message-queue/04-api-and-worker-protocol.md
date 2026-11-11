# API、共享契约与Worker协议

## 新旧契约隔离

本节新路径／schema均为本次设计，不是现有实现。使用TypeBox唯一契约并复用Fastify schema／OpenAPI。

| 入口 | 本次语义 |
| --- | --- |
| 新Web JSON／multipart | 新receipt202，可能无正式messageId/runId |
| 旧公开messages、内部runs/trigger、CLI／插件 | 保持201和旧AgentSendMessageResponse；busy、queued或paused409，不能越过队列 |
| scheduled／subtask／manual_compaction | 不吸收交互收件，保持原身份／快照；补队列占用冲突 |
| 新交互Run | interactive_queue_enabled=1，走新准备／裁决／确认协议 |

不把旧schema的runId全局改可空；新增AgentAcceptUserMessageResponseSchema。旧cancel保持旧公开形状，但内部生成停止operation并走同一持久屏障／精确适配，不能继续向已开放新协议的runtime发送Session级取消；旧ok不代表runtime已停。新Web改用带operationId的stop。

## 公共形状

```ts
// 本次设计示意，最终TypeBox必须表达同样约束。
type Identity = { agentId: string; providerId: string; modelId: string };
type StopDiagnosticCode = "stop_requested" | "runner_not_quiescent"
  | "transport_timeout" | "transport_unavailable" | "invalid_stop_response"
  | "runtime_instance_mismatch" | "runtime_exit_unproven" | "runtime_identity_unverified";
type Receipt = {
  id: string; clientRequestId: string; sequence: number;
  status: "queued" | "injected" | "cancelled";
  messageId: string | null; runId: string | null;
  confirmationState: "unconfirmed" | "confirmed" | "abandoned" | null;
  confirmationSource: "worker_model" | "local_fallback" | null;
  createdAt: number; updatedAt: number;
};
type QueueSnapshot = {
  workspaceId: string; sessionId: string; queueVersion: number;
  mode: "active" | "paused"; pauseCode: QueuePauseCode | null;
  pendingCount: number; pendingBytes: number; pendingIdentity: Identity | null;
  unconfirmedInputCount: number;
  unconfirmedInputSetHash: string | null;
  recoveryIdentity: Identity | null;
  stop: {
    state: "none" | "pending" | "unknown" | "quiescent";
    unresolvedOperationCount: number; unresolvedTargetCount: number;
    code: StopDiagnosticCode | null; // 安全枚举，不含进程路径／PID
  };
  items: Array<Receipt & { textPreview: string; attachmentCount: number }>;
};
type AcceptResult = { receipt: Receipt; deduplicated: boolean; queue: QueueSnapshot };
```

- items只有queued，最多100条，sequence排序，长度等于pendingCount；预览最多256个Unicode字符。
- unconfirmedInputCount统计有效正式祖先链中injected+unconfirmed，不混入N；unconfirmedInputSetHash按下述唯一canonical规则服务端计算，空集NULL，前端原样回传而非自行选择对象。
- confirmationState/source必须一致：仅confirmed有来源，queued/cancelled均NULL；injected始终有正式message/run关联，abandoned也不清空。
- stop按当前Session作为root或target涉及的全部屏障聚合：任一unknown优先unknown，否则有未解除项为pending；有停止历史且全部解除为quiescent，无记录为none。两个count只统计未解除屏障／其中未确认target记录（跨Stop不按runId去重），不混入pendingCount。quiescent只证明受跟踪Runner，不证明工具副作用已回收。code按该优先状态下最早(created_at,operationId)屏障的安全诊断码确定；首次pending用stop_requested，none/quiescent为NULL，不能因读时钟变化破坏同版本快照。
- queueVersion在入队／注入／取消／控制／确认／放弃及可见stop状态变化同事务递增。操作重放的稳定结果与当前快照分开，不能返回历史版本冒充当前。
- receipt及queue同读快照；低版本／逆状态回包不让UI退回queued。timeline增加只读收件确认标识，正式历史中的abandoned仍可见。

### 未确认集合hash的唯一canonical规则

- 服务端在同一可信快照中选择当前有效正式祖先链内全部status=injected且confirmation_state=unconfirmed收件，按正式链从旧到新排列；不按客户端时间／ID字典序重排，不允许重复receipt。
- 内部canonical对象固定为下列形状，inputs数组只在服务端用于计算hash，不是公开请求字段：

```ts
{
  version: "agent-unconfirmed-input-set-v1",
  workspaceId, sessionId,
  inputs: [{ receiptId, messageId, agentId, providerId, modelId }]
}
```

- 对象key按共享canonical序列化的字典序排序，数组保序；使用紧凑JSON、标准JSON字符串转义、不额外转义非ASCII、保留ID原值且不做Unicode／大小写规范化，再取UTF-8字节的SHA-256小写64位十六进制。
- snapshot的count等于inputs长度；非空时返回该hash，空时返回NULL。确认／放弃改变集合时queueVersion也同步递增；queued单独变化即使hash未变，仍受control版本保护。
- abandon在同一写事务内重新构建该完整对象，先核验expectedQueueVersion，再检查无有效Run及非空集合，再比对expectedUnconfirmedInputSetHash；任一步失败都不部分放弃。静态读取后再写的双步骤不能代替此裁决。

## 公共受理与查询

前缀 `/api/agent/sessions/:sessionId`，全部校验认证、workspaceId、Session归属／kind和删除围栏。

| 方法路径 | 请求 | 成功 |
| --- | --- | --- |
| POST `/receipts` | 原有JSON字段；或payload+images multipart | 202 AcceptResult，持久受理不等Worker |
| GET `/message-queue` | query workspaceId | 200 QueueSnapshot |
| GET `/receipts/by-request` | query workspaceId、clientRequestId | 200 receipt+queue；不存在404 |
| GET `/receipts/:receiptId` | query workspaceId | 200原文／正式消息映射／附件描述／确认状态 |
| GET `/receipts/:receiptId/attachments/:attachmentId/content` | query workspaceId | 受控图片；真实关联与可信文件校验，无关联404 |
| POST `/receipts/:receiptId/cancel` | workspaceId | 200 receipt+queue，injected409 |

- 同requestId同payload返回同receipt的当前状态，已cancelled不复活；异payload409。
- 指纹包含原始文本、显式Agent/locale和图片字节／顺序／文件名／格式，不含随机tempId或服务端默认解析结果。
- receipt成功后即使发布账本关联补写丢回包，先查receipt，不重复发布。
- 图片发布前先独立持久预留额度；507／409 publication uncertain均明确受理是否可查询，客户端同ID确认，不换ID盲发。
- API只校验现有输入／图片限制、本次容量／留存预算和可解析身份；不声称已做模型token适配。

## 控制与恢复API

- Stop/Abandon的严格body必须在真实HTTP路径拒绝额外字段，而不是擦除后接受。采用路由级validatorCompiler对同一共享TypeBox schema做不修改输入的校验（参照既有analytics的Value.Check方式）；不能依赖Fastify默认AJV removeAdditional，也不全局改变旧路由的校验行为。OpenAPI仍直接复用同一schema。

### Stop

`POST /message-queue/stop`：workspaceId、operationId。

- Stop不携带、不校验expectedQueueVersion；schema仅workspaceId/operationId并additionalProperties=false。全新operationId表示新停止，按03原子关闭admission、固定cascade目标、持久barrier和paused(user_stop)+DB-first终态／取消；handoff可保留但不是退出证明。首次提交后唤醒精确停止调解器，不调用旧Session级吞错cancelSession。
- resume先成功、随后全新Stop成功是合法时序，最终Stop暂停并取消当时有效Run；无Run仍暂停。已有正常terminal intent则只暂停，不把completed改cancelled。
- Stop先成功，携带此前版本的resume/abandon必须409；同一Stop operationId重试只重放原结果及当前queue，不再修改控制或取消用户后来恢复的新Run。
- Stop/inject/finish的fence与终态唯一性保持，完整交错按D-STOP验收；不能把安全优先误写成覆写已提交正常终态。

200返回`{ stopOperation: { operationId, acceptedQueueVersion, targetCount }, queue: QueueSnapshot }`。stopOperation是持久稳定“已记录停止操作”结果，不含runtimeStopped=true；queue是响应时可信当前快照，可能pending/unknown，只有已持久匹配证据才可quiescent。无目标也持久operation与原子关闭证明。相同ID重试不唤醒或重新执行取消，只返回原stopOperation和当前queue；后台独立重试原精确目标。新Stop独立记录，同root复制旧未解除目标并合并当前cascade；任何旧确认不得清新记录。

### Resume

`POST /message-queue/resume`：workspaceId、operationId、expectedQueueVersion。

200返回：

```ts
{
  action: "continued_unconfirmed" | "dispatch_queued" | "unpaused_only";
  runId: string | null; // continued_unconfirmed必须真实非NULL
  queue: QueueSnapshot;
}
```

- 新操作先做预期版本CAS，再检查所有相关stop屏障；pending/unknown分别409 AGENT_SESSION_STOP_PENDING/AGENT_SESSION_STOP_UNKNOWN。屏障清除后仍须旧Run DB完全terminal、既有工具安全检查；terminal-intent待收敛409 draining。已成功旧操作只读重放，不重新激活。
- 有unconfirmed时独立激活新交互续接Run：引用既有trigger user，纳入全部未确认输入，无新增user；同事务保存控制CAS、Run fence/输入关联及operation结果。queued等待安全边界。
- 无unconfirmed有queued恢复普通推进；都无则仅解除暂停。
- 身份按D-PROFILE且集合一致，配置／静态输入／图片／发布记账校验通过；不要求重新预留已发布文件，也不声称API精确预算。
- Worker enqueue未知结果沿用同runId对账。重试先重放原操作，不重新根据新队列选择另一动作。

### Abandon

`POST /message-queue/abandon-unconfirmed`请求：

```ts
{
  workspaceId: string; operationId: string; expectedQueueVersion: number;
  expectedUnconfirmedInputSetHash: string;
  confirmIrreversible: true;
}
```

- 公开TypeBox body schema设置additionalProperties=false：workspaceId/operationId为非空字符串，expectedQueueVersion为非负安全整数，expectedUnconfirmedInputSetHash匹配^[0-9a-f]{64}$，confirmIrreversible为Literal(true)。不定义expectedReceiptIds、receiptIds或其他ID数组；多余字段400。
- 先版本CAS，再要求所有相关停止屏障已解除、无有效Run且Workspace可写；服务端按本节canonical规则重算全部集合，版本／hash精确匹配，否则409。前端不能用任何数组指定部分放弃。
- 同事务标abandoned、paused(inputs_abandoned)、queueVersion和稳定操作结果。
- 200返回abandonedReceiptIds、queue；不修改queued、不创建Run、不删历史／已发布文件。
- 放弃不要求旧模型配置／token窗口仍有效，也不要求新增留存额度，避免配置故障堵死出口。
- 集合已为空且不是已成功操作的重放时409 `AGENT_NO_UNCONFIRMED_INPUT`。confirmed对象不能放弃；不存在任意IDs的部分放弃接口。
- resume/abandon进行expectedQueueVersion CAS；Stop不带版本但每个全新Stop递增控制版本。仅resume与abandon同旧版本竞争为一成功一冲突；resume后全新Stop可再次成功并最终暂停。旧operation重放只返回原动作及当前快照，无新副作用。

## 精确停止内部RPC与admission（H5）

本节为新增契约，不把旧cancelSessionAndWait的idle:boolean改名当实现。共享包新增专用端点`POST /internal/agent-worker/stop-runs-and-wait`，API→Worker沿用现有internal token／可信Manager通道；Worker不得接受公开客户端选目标或伪造实例。fallback调用同等本地接口。

```ts
type StopRunsRequest = {
  workspaceId: string; rootSessionId: string; operationId: string;
  runtimeInstanceId: string;
  targets: Array<{ sessionId: string; runId: string }>;
  targetsHash: string; timeoutMs: number;
};
type StopRunsResponse = {
  workspaceId: string; rootSessionId: string; operationId: string;
  runtimeInstanceId: string; targetsHash: string;
  state: "quiescent" | "pending" | "unknown";
  proofId: string | null; code: StopDiagnosticCode | null;
};
```

- 严格TypeBox请求／响应schema：ID非空、实例UUID、hash小写64位、targets非空无重复、timeoutMs为1～10000安全整数，仅为单次等待预算，不参与逻辑幂等hash。认证和scope检查后，先核对本进程握手UUID；不匹配返回409 AGENT_RUNTIME_INSTANCE_MISMATCH且零取消、零当前实例tombstone，不悄悄转给新实例。
- hash唯一规则：沿用本章canonical JSON／UTF-8／SHA-256规则，内部对象为`{version:"agent-stop-target-set-v1", workspaceId, rootSessionId, operationId, targets:[{sessionId,runId,runtimeInstanceId}]}`；targets按(runtimeInstanceId,sessionId,runId)各原值UTF-8字节序升序、禁止重复。barrier保存全量hash；RPC仅选原实例分组，加回该实例UUID后算分组hash，重试不重新选集合。无runtime目标的barrier也计算空数组hash，但不发空RPC。
- 同(workspaceId,rootSessionId,operationId,runtimeInstanceId)同固定参数重试只作用同一集合；异targets/hash返回409 AGENT_STOP_OPERATION_CONFLICT；等待预算可调整，不改变固定取消对象。pending/unknown允许重新观察，不把第一次未完成结果永久缓存；quiescent可重放，因为tombstone直到实例退出一直保留。
- Worker先核验hash与可信admission来源，再在本地串行临界区为**全部固定runId**安装tombstone；即使目标暂不存在也必须安装。原admission已closed是合法停止对象，不因DB terminal就跳过；未知／不匹配绑定不能发quiescent。
- 同一临界区按runId移除queued项、标记登记中的enqueue不可进入、定位root/nested精确controller并abort。新增runId级registry覆盖nested，不按Session查“当前controller”，不按Session清queue，不只遍历activeRunIds。pump、nested登记及迟到enqueue必须先核对预期实例、tombstone与有效Run admission；已经在外等待的校验回包在登记前再检查，不留await窗口。
- 全部目标已无queued/running/controller/nested、在途登记及可调度／写回任务才返回quiescent，proofId非NULL且code=NULL；证据关联上述全部身份及hash。tombstone已装但尚有Runner／MCP等未finally，deadline到返回pending、proofId=NULL、code=runner_not_quiescent；不能用目标一瞬不存在当安全。
- 网络／超时／响应校验失败由API适配为unknown（例如transport_timeout/transport_unavailable/invalid_stop_response），不吞异常为void成功。Worker自身无法确证时可返回unknown，proofId=NULL。200只是结构合法，不是退出证明；202或旧idle、health都不能解除屏障。
- 新增受保护Worker→API契约`checkRuntimeAdmission`，注册到现有AgentApiEndpoints：请求workspaceId/sessionId/runId/runtimeInstanceId，200返回`{bindingMatches:boolean, admitted:boolean}`；bindingMatches精确核对该tuple的持久绑定（可含closed/retired），admitted仅在bound、有效Run、控制／祖先屏障和删除围栏均允许时true。admitted=false／认证／连接异常均不登记enqueue，不能离线猜允许；停止RPC要求bindingMatches=true而非admitted=true，closed仍可被精确停止但不可enqueue。可信绑定读取不因DB terminal、paused或删除围栏隐藏已有绑定，避免调解被自己的屏障堵住；认证和scope校验仍必须。与tombstone登记临界区配合，关闭校验回包迟到窗口。
- Manager握手新增runtimeInstanceId和stopProtocolVersion="agent-stop-runs-v1"，不支持或不匹配该版本不得开放新协议admission；enqueue新增预期实例UUID及持久admission身份；实例替换时拒绝旧UUID，不把旧Run重绑当前实例。API在任何物理enqueue前按03事务绑定；closed admission不得新发送，已在途请求依赖本地tombstone／有效Run fence。所有root/nested/旧强制入口都遵守，不以interactive_queue_enabled跳过。
- 接收端返回的quiescent必须经API验证原实例通道、operation与分组hash后在事务中保存evidence，聚合全部目标才解除对应barrier；同一原实例真实exit凭证仅由Manager本机回调／受审计离线维护事务持久写入，不提供公开或Worker可调用的exit证明HTTP入口。实例exit事实可由协调器逐条核对新旧屏障的固定实例／集合并保存各自匹配记录，但不能拿旧RPC的operation/hash批量清新屏障。后台有界重试只定位原实例；新实例不可达旧实例则unknown，不用新ready冲掉旧记录。

### 公共围栏、诊断与安全范围

- 对root／target Session所有会创建或变更运行／历史的入口应用同一持久围栏；新resume/abandon按“访问／删除围栏→已成功操作重放→版本CAS→停止屏障→原有Run／集合／工具校验”执行。旧强制入口即使DB idle也409，不用版本字段绕过；纯读、queued受理／取消和Stop允许，匹配的终态／屏障收敛除外。
- 可用现有queue GET持续查询停止状态，不增加在线force-clear接口；UI显示“停止确认中／停止状态未知”，提供重新查询／等待及安全诊断，禁继续／放弃／历史修改。N不包含停止目标数；屏障解除仍paused，工具unknown/lease独立，不能显示“所有工具均停止”。
- 取消协调器负责首次和后续精确请求；公开旧Stop重试只重放。timeout/连接失败诊断要可见，且不能把响应时当前stop状态写进历史stopOperation稳定结果。

## 内部准备／注入

新增共享AgentApiEndpoints注册，所有调用保持internal token、Workspace和Session校验。

- `prepareInteractiveInput`读取可信有效上下文、queued前缀、unconfirmed保护集合及投影版本；Worker在候选虚拟上下文发现实际工具并按queue-input-estimator-v1计算。
- `injectInteractiveInput`请求runId、operationId、expectedHeadMessageId、expectedRevision、连续receipt IDs、准备snapshot hash及estimator版本；正文／附件只从服务端收件读。
- API核验active control、有效Run、身份、完整工具闭合、无streaming、FIFO前缀和head/revision；不假装API能重新计算Worker动态工具预算。
- 最大8条，提交记录原集合和message IDs及Run输入关联。未知commit同operationId同参数重试，不换ID多吸一批。
- 候选取消／head变化重新准备，新操作ID；仅新增尾部不能混入这次快照。
- 预算失败暂停并收敛，未注入队首queued保留；trigger已注入的则unconfirmed保留，由恢复API处理。

## 输入快照绑定：create、replace、resume、complete

新增绑定字段随现有内部请求最小扩展，不建立新retry框架。

| 路径 | 必须实现 |
| --- | --- |
| createStreamingAssistant | 绑定可信inputReceiptIds、effectiveInputPolicy版本、实际输入snapshotHash及输入revision；与创建同事务 |
| replaceStreamingAssistant：retry_same_input | 在现有替换事务继承完全相同绑定，旧superseded／新active；重放验证输入集合相同 |
| replaceStreamingAssistant：recovery_reprepare | 根据本次实际context验证，必要时新Assistant绑定重新准备快照，旧绑定失效，不在旧Assistant上换输入 |
| resumeStreamingAssistant | 只有本次实际snapshot与既有binding相同才claim；不同返回需走既有replace，不静默改绑定 |
| completeAssistantWithExecutions | 当前有效Assistant合法模型响应完成后，原子确认绑定输入source=worker_model |
| completeInteractiveAssistant | 纯文本／空响应正常裁决同事务确认输入，再continue/finish |
| local fallback完成 | 同样绑定和裁决，但source=local_fallback，不生成虚假provider完成 |

- snapshotHash覆盖实际有效输入内容／附件集合／system／冻结工具／replay投影；不含新旧Assistant ID，也不因替换head自身变化而误改输入。inputRevision用于证明准备前输入链，不要求替换后revision等于原值。
- Worker实际provider请求使用该冻结快照；budget和真实请求不得重新发现不同工具。
- superseded旧Assistant的迟到完成、失效run fence或不同binding重放都不能确认。确认与完成事务原子，回包丢失重试不重复改变确认。
- provider错误／取消／结果未知保持unconfirmed；只有实际合法完成才确认，不能仅凭发起HTTP就确认。
- confirmationSource不是公共请求可写字段；服务端按Worker受保护完成入口或fallback专用本地能力端口派生，不能由调用参数把本地回显标为worker_model。

## 正常裁决与确认

`completeInteractiveAssistant`返回decision continue/finish及operationId、当前queue。Assistant完成、输入确认、控制版本、裁决／terminal intent、操作结果同事务。

- finish后仅收敛原tuple；回包丢失原参数重试，不选反向终态。
- continue后先检查取消／预算，再prepare；候选全取消由prepare原子finish，避免无新输入额外模型请求。
- 非交互Run保留旧completeTerminalAssistant严格重放；新协议不降低其安全性。
- 放弃统一有效输入策略必须进入PromptContext、primary-materializer、compaction source及官方provider replay，不能只过滤role=user主数组。

## 错误、暂停与保留诊断

| HTTP/code | 语义 |
| --- | --- |
| 400／401／403／404 | 原校验、认证、访问范围、不存在，不受理 |
| 409 AGENT_QUEUE_AGENT_CONFLICT | 固定身份冲突，不入队 |
| 409 AGENT_REQUEST_PAYLOAD_CONFLICT / AGENT_REQUEST_ID_NAMESPACE_CONFLICT | 同ID异内容／新旧碰撞 |
| 409 AGENT_RECEIPT_ALREADY_INJECTED | 不可取消 |
| 409 AGENT_QUEUE_VERSION_CONFLICT / AGENT_UNCONFIRMED_SET_CONFLICT | 控制或未确认集合过期，刷新 |
| 409 AGENT_SESSION_STOP_PENDING / AGENT_SESSION_STOP_UNKNOWN | DB可已terminal，但Runner停止未确认；只查询／等待，不强制恢复 |
| 409 AGENT_RUNTIME_INSTANCE_MISMATCH / AGENT_STOP_OPERATION_CONFLICT | 内部精确停止实例不匹配／同ID异固定参数；不取消当前实例、不清屏障 |
| 409 AGENT_QUEUE_RUN_DRAINING / AGENT_QUEUE_RUN_ACTIVE | 旧Run未收敛或仍有效，恢复／放弃拒绝 |
| 409 AGENT_NO_UNCONFIRMED_INPUT / AGENT_QUEUE_INPUT_NOT_CONFIRMED | 空放弃集合／历史保护冲突 |
| 409 AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN | 可能已发布，保留额度，不重复发布 |
| 409 AGENT_QUEUE_PAUSED / SESSION_HAS_PENDING_INPUT | 旧入口不能绕队列 |
| 413 AGENT_QUEUE_TEXT_TOO_LARGE | 新Web单文本超限 |
| 429 AGENT_QUEUE_CAPACITY_EXCEEDED | queued条数／字节超限 |
| 507 AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED | 本功能1GiB留存额度满，新图片不发布，文本不受此额度限制 |
| 503／网络中断 | 状态可能未知，查询／同ID重试，不推断一定失败 |

暂停码：user_stop、run_failed、budget_exhausted、recovery_required、profile_unavailable、input_too_large、budget_configuration_invalid、provider_context_too_large、context_preparation_failed、attachment_integrity_failed、invariant_violation、inputs_abandoned。错误仅安全枚举／ID／字节，不回传路径、正文、密钥或原provider异常。

## 发布留存查询

新增 `GET /api/agent/attachment-retention`（沿用现有高权限设置／公开API认证边界，无匿名访问）：200返回limitBytes、chargedBytes、reservedBytes、retainedBytes及scope='agent_web_queue_v1'。不返回其他Workspace路径／正文或按用户建立配额体系。

- UI新图片容量错误可按需查询，说明该值是DataDir本功能留存，不是整个磁盘。
- 本次不提供在线释放／物理删除接口；人工离线维护契约见[技术方案](03-architecture-and-data-model.md#空间耗尽与离线维护)。

## 前端同步

- running／queued／paused／unconfirmed非零或stop为pending/unknown时800ms；完全idle为3000ms，隐藏可停、可见立即全量刷新。
- 同Workspace+Session仅接收更高queueVersion；同版本内容应一致。正式消息确认／放弃标识也由权威数据刷新，不能本地猜。
- N仅pendingCount，unconfirmedInputCount只用于独立恢复提示；N=0不隐藏停止／恢复提示。stop pending/unknown时禁继续和放弃；解除后仍paused且需刷新版本显式操作，工具unknown/lease提示独立保留。
- 超时保留草稿版本与requestId；受理确认只清本次版本；图片507／409不盲发、不删用户文件。
- stop/resume/abandon应用当前快照；操作重放不能让UI倒退。abandon需重新核对当前count/hash并二次确认。
- receipt injected后按messageId衔接timeline，不伪造新Run；续接的新runId登记一次，user历史不增加。
- 切换Session／卸载丢弃旧代际回包；多端不通过localStorage自增数量。断网保留最近可信N并提示异常。

## S8：prepare精确响应union与重放优先级

`AgentApiPrepareInteractiveInputResponseSchema`现为严格union（各分支additionalProperties=false）：

| decision | 响应载荷 | 重放与调用方行为 |
| --- | --- | --- |
| `prepare` | operationId、原冻结context/candidates、inputReceiptIds、preparationSnapshotHash、policy/estimator版本、fresh queue | 同operation回包丢失使用本进程原冻结内容，不重组旧快照 |
| `finish` | operationId、decision、fresh queue，无context/candidates | 持久terminal intent与最小裁决独立重放；缓存丢失／API重启不改变finish |
| `expired` | operationId、decision、fresh queue，无context/candidates | HTTP 200权威地确认“原操作是普通prepare，但冻结内容已释放或进程丢失”；绝不是finish，也不重新执行旧副作用 |

Worker控制写在未知回包之后仍重试原operation，直至得到权威响应；收到expired后才能显式换新operation重新准备，最多沿用现有有限边界重试次数。新准备仍受Run／Stop／head/revision检查；受控失败或Stop不能假确认输入。fallback同样显式处理expired。inject、complete与控制操作重放均返回原动作＋fresh queue，不带历史queue正文。S8当时的容量拒绝为503 `AGENT_PREPARE_CACHE_CAPACITY`，后续H2复审确认该响应导致无限未知重试；现由下节HTTP 200持久rejected裁决替代，不暗中丢弃其他Run的冻结内容。

恢复新操作严格按：权限／scope／删除围栏 → 同operation已有结果重放 → 权威事务expectedQueueVersion CAS → Stop／draining／工具／profile检查。服务层在事务内先CAS后解析profile，激活事务在异步handoff前再次CAS。旧成功操作不因后来的新queueVersion被拒绝；新操作旧版本同时遇到Stop pending或失效profile时，均先返回409 `AGENT_QUEUE_VERSION_CONFLICT`，不得修改状态或创建新Run。

Worker的retireRuntimeAdmission调用仍为固定run／instance的幂等写；一次网络成功与否不承担最终可靠性，由实例内有界通知器退避重试。只有真实finally或可信Manager原实例exit能提供退出事实，不能以retirement丢包为由忽略未retired fence或开放force-resume。


## H2：权威容量拒绝协议（替代容量503）

prepare严格union新增如下分支，合法内部认证请求返回HTTP **200**：

```json
{
  "operationId": "原operationId",
  "decision": "rejected",
  "reason": "snapshot_too_large",
  "queue": "fresh queue snapshot（示意）"
}
```

`reason`仅允许`"snapshot_too_large" | "cache_capacity"`；不允许context、candidates或其他额外字段。reason与裁决一起最小持久化，同operation稳定重放。真实queue仍满足`AgentMessageQueueSnapshotSchema`，上例字符串仅示意。

| 原结果／新结果 | Worker行为 |
| --- | --- |
| unknown → rejected | 已取得权威结果，退出未知循环；经既有失败生命周期failed＋paused，不能再落入“结果未知”catch |
| unknown → committed finish | 沿用原finish和terminal tuple，不改判失败 |
| unknown → prepared | 使用旧冻结内容；释放后expired才可换operation重备 |
| 非权威网络／503／无效响应 | 仍保持原operation重放与Stop屏障，不按次数猜finish／失败 |

Worker和fallback均不调用provider或工具，不确认输入。诊断码为`prepare_snapshot_too_large`与`prepare_cache_capacity`，前者提示缩小上下文，后者提示释放其他Run后由用户显式resume；abandon语义不变。未退休admission或未知Stop仍不得越过。通用503仍可能表示未知写入，不能仅从重试表删错误码绕过此协议。
