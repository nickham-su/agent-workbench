# 前端状态、请求所有权与并发边界

## 职责与最小改造范围

仅在现有 AgentToolView、pane timeline 事件、target loader 和 Tab controller 增加窄控制点，不建设全局元数据同步服务。下文类型为拟新增的本地类型，不是 HTTP 契约，也不是现有回调已支持的类型。

| 状态 | 所有者 | 规则 |
|---|---|---|
| sessionCache | AgentToolView | 已取得的完整records，不宣称覆盖全部历史；partial缺失不删除 |
| snapshotVisibleIds＋本地可见成员 | AgentToolView | snapshot成员与本地有效打开/关闭组合；不能让所有cache primary按默认值显示 |
| Tab confirmed/desired/inFlight | 既有controller | 保留单飞、最后意图补偿；新增confirmationEpoch与窄结果订阅 |
| metadata readOrder/水位/mutationEpoch | AgentToolView局部上下文 | target、snapshot、timeline标题事件共用；保护record清除不清水位 |
| pickerItems/cursor/选择证明 | 弹窗 | 页数据不覆盖cache，不注册为全集；选择证明必须来自实际接受的完整GET |
| persisted提醒/runtime entries | status store | 未加载ID的时间保留；只轮询可见/活动已知会话 |
| unavailable标记 | target loader | 仅当前有效SESSION_NOT_FOUND；网络/401/500/PUT404/partial缺失不产生 |

## 生命周期与时限

### 有效性token

- workspace上下文使用 `{workspaceId,workspaceGeneration,disposed}`；切换/卸载先使旧上下文失效，再清理本地状态。
- 初始化使用 initializationAttemptId；重试不使同workspace的PUT队列回调失效。
- openIntentSeq负责最后打开/来源关闭/激活；用户切换或关闭取代旧意图，流程自身程序激活不能误使自身失效。Fork在实际请求发起时捕获局部激活guard；较新UI意图下完整record可局部加入，但不抢activeTab，旧workspace/pane结果静默。
- pickerGeneration、sourceDraftId、selectionGeneration、pageRequestSeq分别负责页和选择；另外捕获工具活跃代次。真实KeepAlive deactivation关闭picker、失效页/选择/失败重试身份并取消其UI订阅，已经发出的PUT仍沿原队列完成。来源切走、隐藏、开始创建/替换或销毁即失效；再激活不恢复旧picker，也不隐式重读正常snapshot。
- 请求token与inFlight槽位身份绑定。旧finally仅可清自己的槽位，不清新请求；AbortController是优化，不是正确性证明。
- 过期结果不写当前UI、不弹过期告警；已经发出的旧PUT仍可能改变服务端。切换/卸载后不发送旧上下文补偿，重新进入以新snapshot为准。

### 传输timeout和UI deadline

| 范围 | 固定时限 | 终止含义 |
|---|---|---|
| tabs/target/continuable元数据GET | 每次实际请求15秒 | 当前GET失败、token失效、槽位释放；晚响应不能提交 |
| Tab visibility PUT | 每次实际请求15秒 | 当前HTTP尝试终止，但服务端是否提交未知；原队列处理失败/较新意图补偿 |
| picker完整record核实 | 从选择注册起30秒，含等候共享GET/补查 | 终止本次核实，保留草稿，不PUT；显式重试才新选择代次 |
| 某visibility intent的UI确认订阅 | 从intent登记起30秒，包含排队 | 只结算uiTimeout并释放UI等待，不擅自清真实desired/inFlight或伪造确认 |

窄wrapper显式设置 `timeout: 15000`，不改 `axios.create` 全局，不影响发送、stream、timeline长请求。阶段一临时初始化列表和独立Tab状态关键GET也使用15秒，以免双读之一无界等待；最终初始化只剩tabs。Axios timeout在窄wrapper转换前保留可辨识分类，不依赖当前toApiError会保留Axios code：为本次窄请求生成可区分的metadata/visibility timeout错误，其他错误沿原转换。

GET timeout/cancel必须一次结束订阅、失效token、释放槽位；显式retry可发新请求。共享targetGET若仍有其他有效消费者，只取消该UI订阅，不清共享槽位；实际请求仍受自身15秒约束。PUT只有真实响应/传输终止清inFlight，30秒UI watchdog绝不代替这一步。所有deadline使用可控计时器测试，结算后清timer/callback。

没有其他有效GET消费者时，UI取消/核实deadline通过AbortController终止本客户端传输并走同一槽位清理；不能只删slot而留仍有效的旧transport callback。deadline基于本地单调计时，从注册起计算且普通重复点击不重置；到达或超过deadline的结果拒绝，即使timer与response同一轮到达也不能越界提交。

## 元数据读取token、水位与timeline事件

### 本地类型与捕获位置

```ts
type MetadataReadToken = {
  workspaceId: string;
  workspaceGeneration: number;
  sessionId: string;
  readOrder: number;
  mutationEpochAtStart: number;
};
type TimelineMetadataEvent = {
  session: AgentSessionMessageState;
  readToken: MetadataReadToken;
};
type MetadataWatermark = {
  acceptedReadOrder: number;
  mutationEpoch: number;
};
```

- AgentToolView持有workspace内单调readOrder分配器、每Session水位和当前cache完整record保护（不另存第二份无消费者的标题record映射）。workspace生命周期结束才清它们；保护record收敛清除不重置mutationEpoch/acceptedReadOrder。
- 成功手动标题/创建/Fork先upsert，再增加目标mutationEpoch。接受且确实改变标题的timeline也增加该epoch；重复相同标题不增加。读本身不等于本地业务mutation。
- 新增局部 `agentSessionMetadataReadContext.ts` 的InjectionKey/类型/helper；AgentToolView在现有provide statusStore附近提供 `captureReadToken(workspaceId,sessionId)`，pane在现有inject作用域取得。不是公共全局服务。
- pane在 `loadTimeline` 实际调用 `getAgentTimeline` 的前一刻，通过父级capture取得token；不能在响应时才生成，也不能只在refreshTimeline排队时生成。
- `defineEmits` 的session-metadata-updated从裸record改为TimelineMetadataEvent，父级handler与模板事件链同步调整；snapshot/delta/before所有实际timeline读取都捕获同一类token。
- pane仍先按requestScope/timeline scheduler epoch/sequence接受正文和工具详情，再独立发带token的标题事件。父级拒绝标题不撤回正文、不改变轮询epoch。fixture需提供同一窄context；无有效token时不发无保护标题事件，正文仍按原规则渲染。
- snapshot发起统一分配readOrder并捕获当时目标mutationEpoch映射；后来首次出现的目标默认起始epoch=0。targetGET发起捕获自己的token；同一实际GET的消费者共享token，不能各生成伪“更晚”token。

### 保守统一的接受规则

对target完整record、snapshot逐项record、timeline标题，先验证workspace/Session/token归属，再比较：

- `token.readOrder <= acceptedReadOrder`：较早或已消费读，拒绝重合并。
- `token.mutationEpochAtStart !== current mutationEpoch`：发起后有本地保护动作，拒绝读覆盖。即使保护record已清除仍拒绝。
- 两项均通过才接受。完整GET完整替换目标record，更新acceptedReadOrder；timeline只更新title，但同样推进acceptedReadOrder。
- 若timeline接受并改变title，再递增mutationEpoch；已发起但未返回的较早完整GET必须整体拒绝，不允许把其旧head与新title拼起来。需要完整record的消费者只能补一个更晚完整GET。
- acceptedReadOrder是保守共用门槛：新title-only读也可以使旧完整读被拒绝；完整接受证明直接由typed accepted outcome中的不可变record/token产生，不另存acceptedFullReadOrder；title-only永远不产生完整证明。
- 成功的未受保护完整GET可清本目标mutation保护record，但水位/epoch永久保留至workspace结束；不清其他Session保护。
- 过期timeline不合并、不递增epoch、不标dirty、不补查；acceptedReadOrder也不被其推进。正文是否接受独立于此判断。
- 受保护完整GET返回明确“未接受”状态，保留cache；不能当target核实成功。真实当前404也经过相同保护和可见性确认水位检查；较新本地证明后到达的旧404不标unavailable，可按目标补查。
  当前404通过上述门禁后推进acceptedReadOrder以阻止更早snapshot/timeline复活目标，但不产生完整record证明；仅更晚有效完整读取/权威成功record才能清目标unavailable。

必须复现：T开始→manual成功→更晚GET接受、清保护record→T返回。T因read/mutation水位拒绝，手动title不回滚，正文若按timeline规则有效仍更新，零无意义补查。这不承诺识别其他客户端所有并发写入。

## target loader与受保护结果

```ts
type TargetReadFailureClassification =
  | 'sessionNotFound' | 'workspaceNotFound' | 'unauthorized'
  | 'network' | 'transportTimeout' | 'serverError'
  | 'invalidRequest' | 'protocol';
type TargetReadOutcome =
  | { status: 'accepted'; record: AgentSessionRecord; token: MetadataReadToken;
      acceptedMutationEpoch: number }
  | { status: 'protected' | 'supersededRead'; token: MetadataReadToken }
  | { status: 'failed'; error: unknown; classification: TargetReadFailureClassification }
  | { status: 'contextInvalidated' | 'cancelled' | 'verificationTimeout' };
```

这是拟新增loader结果，不代替API response或controller的HTTP Promise。classification映射公开SESSION_NOT_FOUND/WORKSPACE_NOT_FOUND、401、400、network、固定timeout code、5xx与协议错误，分别使用以上字面量；不把错误字符串当状态，不改公开错误code。

- 同workspace同目标最多一个真实GET在途，不同目标可并发。消费者各自持UI token；失效消费者不能激活、关来源、替换/告警。
- 实际targetGET发起时在slot另存visibilityConfirmationEpochAtStart；仅目标404的UI不可用处理比较当前confirmationEpoch，期间有较新确认/回滚事件则保守返回protected并允许目标补查，不让旧404破坏新可见性。此控制点不加进HTTP或timeline token，不把visibility变更当作标题版本；第二次无新事件的404正常终止。
- 外部意图等待初始化ready后target load；失败重试初始化成功再处理仍有效的最后意图。
- 当前完整GET通过保护检查才产生accepted证明；title-only cache、受保护GET后保留的旧cache和picker页都不能产生证明。
- 普通外部打开可乐观展示已知cache，但父会话来源关闭须等有效完整record与本次可见性确认。protected/supersededRead不作为核实成功；补查仍走target单飞，不全量兜底。
- 当前SESSION_NOT_FOUND标目标不可用并按当前意图回退；WORKSPACE_NOT_FOUND不批量判删；401不删目标；网络/timeout/5xx不假装已删除。目标持久提醒始终保留。
- 目标失败的activeKey回退只在仍指向本次乐观目标时执行，优先来源/其他有效可见Tab，不抢用户已切换的activeKey。零可见草稿回退由统一helper负责：初始化ready、有效workspace context、无较新打开意图、无有效待派发外部请求且无正在打开的目标、真实零可见时才创建一个本地草稿。
- 外部请求的sequence尚未消费时就视为待打开；目标打开从GET延续至visibility receipt终态，不能以GET返回提前解除保护。初始化、reload、KeepAlive、目标失败/终止复用同一策略；目标finally必须携带context/intent代次。取消或较新意图不能让旧finally创建草稿。
- 由现有意图/可见性状态变化再次核查统一回退条件（不新增游离skip bool）：当前意图终止后零可见不会留空；UI期限结束但真实PUT仍在途时不伪造隐藏，迟到真实失败造成零可见后仍可收敛。网络/401等失败有origin则保留，不多造草稿。
- 创建/Fork刚成功的完整record直接局部更新，无额外GET；定时任务只发意图，执行sessionAvailable门禁不变。

## 可见性结果订阅：恰好一次

### 类型与既有callback兼容

```ts
type VisibilityIntentOutcome =
  | { status: 'confirmed'; sessionId: string; intentSeq: number }
  | { status: 'failed'; sessionId: string; intentSeq: number; error: unknown }
  | { status: 'superseded' | 'contextInvalidated' | 'uiTimeout' | 'cancelled';
      sessionId: string; intentSeq: number };
type VisibilityIntentReceipt = {
  intentSeq: number;
  previousEffectiveVisibility: boolean;
  result: Promise<VisibilityIntentOutcome>;
  cancel(): void;
};
```

- 现有 `requestVisibility(...) => boolean` 可保留给普通调用方；新增窄 `requestVisibilityWithResult(...) => VisibilityIntentReceipt`，两者共用同一intent登记/pump，不能形成第二队列。
- 现有 `onMutationError(sessionId,error:unknown)` 保持签名且仍只报告最终真实mutation失败；不把上述union塞入error，也不因cancelled/uiTimeout/superseded调用此HTTP错误callback。
- 确认订阅注册、捕获previousEffectiveVisibility、intentSeq递增和desired登记为同一个同步动作，必须先挂订阅再notify/pump。previous取本次登记前当前effective visibility而非几秒前弹窗首屏；无未决/不确定inFlight、uncertainCommit=false且confirmed本已匹配visible时（来自有效snapshot/PUT或刚创建默认状态；仅元数据GET后猜默认值不算确认）可登记后同步no-op确认；callback/Promise不能丢事件。
- 任何较新intent登记，不论同向/反向，都立即把旧seq尚未终结的订阅结算superseded并释放，不迁移到新seq、不等待旧seq未来确认。已终结订阅不能二次结算；快速confirmed之后若又登记新意图，调用方提交前必须检查receipt.intentSeq仍等于controller最新nextIntentSeq。新意图由自身结果确认；旧来源提交终止。
- 每订阅唯一settle函数，终态只能一次；confirmed/failed/contextInvalidated/cancelled/uiTimeout均清timer、resolver/callback及订阅表项。cancel仅释放UI等待，不撤销已发送PUT，不擅自删desired/inFlight。
- 30秒watchdog从登记时计，包含前一PUT排队；uiTimeout停止来源提交，保留来源。picker确认超时按取消规则恢复原隐藏意图（原队列、仍最后intent且同workspace），提示承接同操作对象身份。真实PUT稍后结果仍可按现有队列更新当前controller，但已终结订阅不能再次确认/激活。
- pump中的较新意图/不确定提交补偿保持原规则，不能仅凭desired值等于confirmed省掉必要补偿。注册时快速no-op只适用于完全无未决/不确定写；旧PUT在途时新同向订阅也必须排队，不能早确认。
- workspace切换/卸载结算contextInvalidated，释放UI等待且不发旧补偿/告警。UI主动取消结算cancelled；父级应在等待结果后重新检查source/open token，只有confirmed才提交来源关闭或草稿替换。

补偿提示与原onMutationError在AgentToolView适配层按共享操作对象身份去重；本地intent来源表关联sessionId/intentSeq与同一origin对象，最终callback仍为(sessionId,error)。UI uiTimeout本身不触发原HTTP错误callback；真实请求随后失败时由同操作去重避免再次提示，后续独立用户操作有独立提示资格。

UI终态立即释放订阅callback/timer；为真实HTTP晚终态去重只保留小型origin/已提示标识，不保留UI resolver。相关真实队列终止、该来源被不同操作对象身份的新意图取代或workspace销毁后清对应标识；同操作对象身份的取消补偿承接去重标识，不误清。无效context调用WithResult直接返回contextInvalidated的已结算receipt，不登记intent、不递增当前workspace seq、不分配timer，不取代新workspace的订阅。

## snapshot可见性保护：覆盖发起前未决写

### 本地confirmationEpoch与捕获

在现有SessionWriteState增加本地 `confirmationEpoch` 和 `uncertainCommit`，初始0/false，不持久化、不改PUT协议：

- 有效匹配2xx产生明确确认事件时更新confirmed、清对应不确定性并递增epoch，即使布尔值相同但未决写得到确认也算事件。
- 最终失败/timeout保持最后有效confirmed/default，不伪造后端状态；移除该最终desired引起本地回滚或记录不确定提交时递增epoch。中间失败保留较新desired，按原队列补偿；传输失败引起的未决/不确定状态变化也推进epoch。
- timeout/network/协议等不能证明未提交，uncertainCommit=true；成功有效PUT或允许安装的新snapshot才可消除相应不确定性。UI watchdog不更新confirmed，不代替真实HTTP终态。

snapshot发起捕获每目标 `{intentSeq,confirmationEpoch,wasPending,desired,inFlight,effectiveVisibility}`，以及当时可见成员。不能只记提交时的pending或snapshot之后才产生的意图。

### 提交算法

- 当前attempt/context有效且关键response完整才提交；元数据逐项走共用读水位，不替换cache。
- 仅目标intentSeq、confirmationEpoch均与捕获值一致、发起时没有未决写、提交时也没有desired/inFlight，才安装snapshot confirmed。新出现目标若有本地动作同样跳过；未知覆盖可安装最小id/kind。
- snapshot前已在途PUT随后成功：epoch变化阻止旧snapshot覆盖，pending清空也不影响保护；open加入/保留本地可见成员，close从可见成员排除。
- snapshot前未决写失败/timeout：保留最近明确confirmed/default及不确定性，不采用这份旧snapshot来“确认”结果；按本地回滚后的effective visibility决定成员。失败的open不能被发起时desired=open固化为成功。
- 发起时或提交时仍未决：保留当前controller的effective intent；不制造服务端confirmed。之后成功/失败按队列结果更新成员。
- 成员合并：以snapshot items为基底，对被上述保护的目标使用当前effective visibility；true且有已知record则加入，false则排除。范围包含捕获时未决集合、发起后新意图/创建和确认epoch变化集合，不只是snapshot之后新打开ID。
- 以后显式重新读取、从发起到提交无新写且无未决的新snapshot可核实真实状态、清uncertainCommit。初始化失败/重试不取消已有PUT；KeepAlive正常激活不自动重读。
- partial缺失不删除cache/settled状态/提醒；删除全量pruneSettledStates调用。生命周期结束才清当前controller；目标404仅标不可用，不取消其他队列。

## dirty补查与picker核实的不同预算

### 后台目标同步

- 复用目标单飞与 `{dirtyEpoch,lastFailedEpoch}`。独立mutation/同步事件在GET在途时标dirty，同轮合并一次补查；真正新的事件可触发下一轮。
- read被保护可产生一次目标收敛需要；若已有更晚完整GET覆盖同一epoch不再补查。过期timeline、响应自己、upsert/loading变化和保护清除不产生dirty。
  picker归因的核实需求独立受2次预算限制：R2被保护不能把其自身拒绝伪装成新后台事件发R3。只有另外已登记的独立后台业务事件有自己的补查资格，picker耗尽后不续订它的结果。
- 任一真实GET网络/timeout/401/5xx/protocol失败停止该自动链，同失败epoch不随idle轮询自动重发。显式retry或新独立业务事件才重启；新事件不等于对同失败请求无限重试。
- 自动标题完成事件仅消费一次；run-state时间只识别运行进展，不当元数据版本。失败保持title与retry-needed，活动目标一次非阻塞可重试提示。

### picker完整record核实

- 选择注册保存source/open/selection token、30秒核实deadline、已参与真实targetGET token集合及attemptCount；相同选择的重复点击不新增代次/次数。
- 可订阅尚未完成的共享GET，但只计实际请求token一次。已完成/缓存结果不算本选择核实；无共享在途才发新GET。
- 接受本生命周期内实际通过共同保护检查的完整target record，并保存不可变 `{record,token,acceptedMutationEpoch}` 证明；不得拿保护后cache或timeline title补旧head。
- 首次protected/supersededRead：与loader合并安排一个发起更晚、捕获最新mutationEpoch的新鲜GET，最多一次自动补查；禁止同时由picker和dirty机制各发一次。同一选择最多参与2次真实GET。
- 第二次仍未接受、任次失败、30秒deadline或source失效：释放核实订阅、保留草稿/候选及选择状态，进入可重试失败；不发目标PUT、不替换。不因后台继续同步而再次订阅第三次读。
- 补查head=null/title不合格/kind变化：保持草稿、移除失效候选并提示。只有accepted证明合格才登记visibility确认，重新开始独立30秒确认时限；核实＋确认合计最多60秒，不无限loading。
- visibility确认等待期间若目标mutationEpoch变化，或实际接受的kind/head/JS trimmed title资格字段相对证明发生变化，来源提交也拒绝使用旧证明，不拼接缓存资格；保持草稿并可显式重试，必要时按取消补偿。仅新的acceptedReadOrder（例如相同标题timeline）不使证明失效；未知其他进程更新不提供锁定保证。
- 显式“重试该选择”才新selectionGeneration、清次数并重新GET；不要求用户重开整个弹窗，重复普通点击不能重置预算。

## picker页、提交与取消补偿

- 首屏/更多独立page token，15秒GET；首屏失败非空态，更多失败保留items/cursor。关闭/刷新/source失效先失效token；页去重按ID，页不能修改tabs集合。
- picker保持草稿active，核实证明与visibility confirmed都有效后，在一个同步段中替换草稿、迁移编号、markSeen、激活目标、关闭弹窗；正常成功关闭不触发补偿。
- 取消只取消来源替换/激活提交，先保留来源，释放核实/visibility UI订阅。如果尚未登记目标打开intent，不发PUT；如果intent已登记但被旧PUT阻塞、尚未HTTP发出，也不能只cancel订阅后让queued open将来执行，需按下一条登记恢复原隐藏的较新intent。
- 同workspace有资格补偿：receipt.previousEffectiveVisibility=false、本次打开仍为该目标最后intent、未被更新用户意图取代。登记恢复隐藏的较新intent，取代尚未发出的queued open或排在已发送PUT后，沿原单飞/不确定提交补偿；原本可见目标不补偿。检查与登记同步，防止撤销期间的新意图。
- 补偿也调用原controller的requestVisibilityWithResult，独立最多30秒UI结算、恰好一次释放timer/subscription；不得仅发送boolean intent然后猜测确认。queued open未发出时仍登记false覆盖。补偿成功才确认恢复隐藏。UI取消或期限只结束订阅，不清真实desired/inFlight。
- 选择与补偿共享一个对象身份作为提示归属，不保留无消费者operationId。UI确认超时提示直接包含“打开可能已提交，恢复隐藏尚未确认”；同对象后续失败不重复提示。普通取消在补偿失败/超时才提示。较新目标Tab意图、较新打开意图、工作区失效或工具活跃代次改变后，补偿旧终态静默；正常再激活不能重新使旧提示有效。
- 补偿成功明确恢复隐藏；被较新意图取代只按新意图运行，不宣称恢复原状态，不弹旧选择的过期补偿失败告警。
- 补偿最终失败/15秒传输timeout/30秒UI等待timeout：不宣称撤销成功、不无限自动retry。保留controller最近有效confirmed/default和uncertainCommit，目标可能仍可见；当前workspace一次非阻塞“目标打开可能已提交，恢复隐藏未确认”提示，允许用户显式关闭或稍后主动重载tabs核实。
- 30秒UI timeout仅结束补偿等待，真实队列仍按HTTP终态处理；晚2xx可以更新当前controller，但不恢复已取消草稿提交，不再重复结算。提示与onMutationError按取消操作的共享对象身份去重，最多一次，原callback签名不变。
- workspace切换/卸载后不登记旧补偿，不弹旧提示；此前PUT可能已经提交，未来重新进入以新snapshot为准。不能声称关闭弹窗/abort必然使旧后端没有变化。
- 阶段二主动重载tabs仅是用户显式核实操作，不是PUT失败自动初始化兜底；保留当前UI/cache/草稿/队列，按同样snapshot保护合并，失败只显示该核实失败，不回到首次初始化门控。阶段一尚无scope=tabs时使用显式关闭或重新进入正常初始化核实，不添加失败自动全量GET。

## status store与数据保留

- registered IDs改为已知metadata/运行集合，不证明完整性。picker页不注册，未知kind不猜primary发声音。
- registeredSessionsReady只表示可持久化已知数据，不表示可清未知历史。删除partial缺失引起的prune分支；只轮询可见/活动已知record。
- restore保留原workspace key中的全部有效时间映射；persist从该副本出发覆盖已知entry的lastTerminalAt/lastSeenTerminalAt，不按registered IDs重建丢失未知项的payload。
- 可回收runtime entry/indicatorCache但先保留其时间；真实目标404默认也保留持久提醒。重新GET打开恢复原时间并按原markSeen处理。
- 损坏localStorage原容错保留，不清有效数据；切workspace按原key保存/绑定，旧响应不跨key写。无需全量ID目录或后台删除对账。

## 诊断与错误归属

只记录操作类型、scope、结果分类、耗时/条数；不记录title/正文/cursor/cookie/token/工作区路径。错误归属当前有效操作且去重。关闭/timeout不是后端未提交证据，未确认状态不能展示“已成功撤销”。生产路径没有全量GET或失败自动snapshot补偿。


## 最终全面审查补齐的集合与生命周期规则

- Tab展示与编号统一调用同一个可见性判定：草稿可见覆盖，或服务端可见成员＋非unavailable＋controller effective。编号只回收不再渲染的映射，不剪枝metadata缓存或提醒；保留已有可见编号，释放后的尾部编号可复用。后台Fork只入缓存不入成员时不得占号。
- StatusStore每次run-state读取捕获workspace ID、递增workspaceGeneration与entry对象身份。success/catch/finally均重新验证，A→B→A也不能复活A旧响应，同ID重建entry后的旧finally不能清新inFlight；dispose先失效代次。正常当前后台completion仍可发音和持久化，不用工具隐藏作为全Store静默门禁。
- runtime settings读取与音频play Promise失败回调同样检查生命周期；新workspace不被旧settings.loading阻塞。partial历史提醒继续按原键合并保留，旧响应不能写当前工作区持久化。
- controller.invalidateContext统一结束整个workspace生命周期：一次结算旧receipt、清subscriptions/sessions/writeStates并推进内部contextEpoch，阻止旧同ID PUT回调。仅workspace切换/卸载使用，不用于同workspace初始化重试、工具隐藏或UI watchdog。
