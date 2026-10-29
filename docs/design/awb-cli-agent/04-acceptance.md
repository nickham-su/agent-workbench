# 验收标准与测试矩阵

## 验收原则

- 下表是待执行标准，不是已通过记录。必须保存实际命令、环境、退出码、请求计数及断言摘要；不得复用旧项目测试数字当作本次证据。
- 契约以[CLI 契约](02-cli-contract.md)为准；技术算法可调整，但不能减少本矩阵承诺。测试不得只断言包含某个字符串。
- 默认用受控 HTTP fixture 和可注入时钟/文件系统故障验证，不访问真实凭证、不依赖付费模型、不向真实工作区写测试数据。真实 smoke 使用用户授权的隔离工作区。
- 每个副作用故障用例必须断言创建/发送/取消/压缩请求次数；特别断言没有隐藏重试、自动换 Agent、删除会话或监听中断后的取消。
- 安全相关测试只在项目内隔离夹具中构造，不读取工作区外真实文件，不打印 fixture 以外用户数据。

## 帮助、解析与兼容

| 标识 | 场景与输入 | 必须结果 |
|---|---|---|
| `A-HELP-LAYERS` | 根、每个组、每个动作分别 `--help/-h`，以及裸根/裸组 | 退出0；分层内容正确；配置工厂、HTTP、本地输入读取调用均为0 |
| `A-HELP-PRIORITY` | send 带 help、缺必填项、无效图片路径/负数参数；stdin 注入一个永不结束的流 | 仍显示对应帮助，不读文件/stdin、不等待 EOF、不做业务校验 |
| `A-HELP-JSON` | 帮助配合 --json | 人类帮助、退出0，不尝试 JSON 业务输出 |
| `A-HELP-ERROR` | 未知命令/选项、额外位置参数、参数缺值 | 退出2、stdout空、短诊断+正确帮助入口，不回显恶意/机密 argv |
| `A-PARSE-ALIASES` | `-w` 与 --workspace；`-n` 与 --last；--json 放根/组/动作位置 | 同义调用请求完全等价；同一参数两种别名同时出现报2；--image例外可重复 |
| `A-PARSE-VALUES` | prompt 内容含 `--workspace` 字样，或 `--prompt=--workspace` | 文本作为值处理，不被重复选项扫描器误识别 |
| `A-PARSE-ID` | 空/全白/首尾空白/控制字符 ID | 本地非法值退出2、不联网；不引入UUID限制 |
| `A-PARSE-ID-DOT` | 作为路径段的workspace/session/message ID为字面`.`或`..` | 本地退出2、HTTP为0；不能交给new URL后被归一化成别的路由 |
| `A-PARSE-ID-ENCODING` | 原值`%2e%2e`、包含`/`/`?`/`#`或`a/../b`的ID；构建后URL路径不符 | `%2e%2e`编码为`%252e%252e`；分隔符是编码后ID数据，不双解码；最终pathname等于预期编码路由，否则请求为0，不只检查origin/API前缀 |
| `A-COMPAT-KIND` | 不传kind、--kind primary、--kind subtask/all、其他非法值 | 前两者等价请求primary；primary帮助标记弃用；subtask/all本地退出2、HTTP为0并明确迁移，不能忽略/legacy扩展；README声明本期有意收缩，不改API |

## 发现与主会话查询

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-DISCOVER-WORKSPACE` | 工作区同名/空标题、顺序不同、空数组 | 稳定码点排序；只输出id/name；空集合成功；不泄漏repo URL/路径/凭证字段 |
| `A-DISCOVER-AGENT` | 多个Agent、order与名字排序相反 | 保留配置顺序；仅id/name/summary；发送默认首个，不沿用会话上次Agent |
| `A-DISCOVER-NONE` | 无可用user Agent | agent list成功空数组；send/compact失败，创建/发送/压缩POST均为0 |
| `A-DISCOVER-BAD-FIRST` | 首Agent模型错误、第二个正常；或列表后首Agent被禁用 | 失败，不改用第二个，不重新发现后重发；无自动修配置 |
| `A-SESSIONS-WINDOW` | `1s`、`90d`；缺值、0、负数、小数、复合单位、溢出、超90d | 合法值正确换算；非法退出2且不联网 |
| `A-SESSIONS-SCOPE` | 主/子/Fork主会话/隐藏标签/零消息会话混合 | 列表请求kind=primary；Fork主会话包含；不按标签/标题/低计数附加过滤 |
| `A-SESSIONS-STATUS` | all/idle/running | 筛选与请求回显一致，非法状态不联网；时间按updatedAt，非createdAt |
| `A-SESSIONS-VALIDATION` | 响应身份错、总数错、重复ID、时间超窗口、类型错 | 退出6，不发布部分成功列表；保留原严格验证能力 |
| `A-SESSIONS-SHOW` | 90天外已知主/子ID；跨工作区/404 | 主子详情均可读；不附加窗口；错误不换工作区、不猜父关系 |

## 输入、发送与未知结果

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-SEND-INPUT-MODES` | 纯prompt、prompt-file、stdin、纯图、混合 | 五类均支持；只有--stdin读stdin；三种文本来源互斥；文本与图片都无有效内容则2 |
| `A-SEND-UTF8` | UTF-8中文、单BOM、非法序列、文本目录/FIFO/设备、stdin TTY | 正确解码或拒绝；不得挂起、替换乱码、打印原文或读取目录；错误发生在创建前 |
| `A-SEND-TEXT-LIMIT` | JSON体正好1MiB与超限、multipart payload正好64KiB与超限、Unicode转义膨胀 | 按最终UTF-8序列化字节判断；超限不创建；不只判断字符串长度 |
| `A-SEND-IMAGE-LIMIT` | 1/4/5张；10MiB及+1；总20MiB及+1；重复同文件 | 边界符合现有后端；重复按多张计数；超限创建请求0 |
| `A-SEND-IMAGE-SIGNATURE` | PNG/JPEG/WebP签名、扩展名不符、SVG/空文件、源预检后被修改 | 按字节签名；不支持拒绝；发送的是已预检字节；上传不含本地绝对路径 |
| `A-SEND-MULTIPART` | 纯图/混合图片请求 | payload恰一个、images有序、boundary正确、纯图不伪造prompt；服务端仍可独立拒绝损坏图片 |
| `A-SEND-EXISTING` | 已有主session | 不创建；显式Agent即传该Agent；受理输出标识一致，不-f立即结束 |
| `A-SEND-SUBTASK` | 已有子session | CLI拒绝，发送POST为0，不收紧API本身 |
| `A-SEND-BUSY` | 预查空闲但发送时409；显式busy | 退出6，不排队、不重试、不重建、不切Agent |
| `A-SEND-CREATE` | 未传session，创建和发送成功 | 创建1次、发送1次，顺序正确，sessionCreated=true；先完成输入与Agent预检 |
| `A-UNKNOWN-CREATE` | 创建服务端成功但响应断开/超时/无效JSON/5xx | 调用失败，effect=unknown，不重试、不继续发送，不伪造sessionID；接受空会话 |
| `A-UNKNOWN-REJECT` | 创建明确401/404/输入拒绝 | 对应退出码，effect=rejected，不发送；不声称所有失败都结果未知 |
| `A-UNKNOWN-SEND` | 创建成功，发送返回409或响应丢失 | 不再创建；错误保留已知sessionID；409确认拒绝，断线/超时为unknown；取消POST为0 |
| `A-UNKNOWN-PERSIST` | 创建/发送有效成功后Cookie续签保存失败 | 退出7，不发后续副作用；effect=accepted，保留已确认标识，不提示重发即可解决 |
| `A-SEND-REQUEST-ID` | 两次新调用、send与compact交替 | 每次随机新ID，不跨操作复用；不提供整链exactly-once承诺；未知结果不自动补发 |
| `A-SEND-DEDUP-IDENTITY` | 意外dedup响应且无法证明原Agent | 不伪造实际Agent，不切Agent、不重发；按响应不一致失败并保留可信session/run标识 |

## 消息选择与输出

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-MESSAGES-EXCLUSIVE` | 无选择、两个选择、-n0/负数/小数/溢出 | 退出2，不联网；--after与-n恰选一 |
| `A-MESSAGES-PROJECTION` | user纯图、assistant文本/纯工具/纯推理/空白、system/runtime/compaction、工具数组 | 严格按契约计数；不泄漏推理/工具输入；图片元信息可见；压缩不挤占-n1 |
| `A-MESSAGES-AFTER` | 锚点是普通/压缩/工具调用assistant；之后有消息/无消息 | 锚点排除，筛选后的记录正序；无后续成功空数组 |
| `A-MESSAGES-BAD-ANCHOR` | 不存在、另一workspace/session、旧分支锚点 | 失败，不返回全部历史或部分成功列表；不泄漏跨资源归属 |
| `A-MESSAGES-PAGES` | 超过100/500原始消息，普通消息稀疏，N大于一页 | 按原始游标翻页，普通消息不足继续取；不把单页当全部；不足N返回全部 |
| `A-MESSAGES-CURSOR` | hasMore但无游标、游标重复、页ID重复/身份错、404 | 退出6，不死循环、不输出虚假complete |
| `A-MESSAGES-STREAMING` | 非-f读取正在生成的消息；后来变成文本可见 | 明确streaming状态；不把部分正文标成最终回答；可见性按采样时投影 |
| `A-MESSAGES-LAST` | 稳定完成、失败/取消、最后只有用户消息 | -n1返回最近普通消息，不伪造成功结果；最近消息与Run成功区分 |
| `A-MESSAGES-SUBTASK` | 已知子session、Fork继承历史 | 可读；沿当前展示链读取；保留originSessionId/originRunId，不当作本次新产出 |
| `A-MESSAGES-LONG` | 超过3000字符普通消息 | 完整正文不按工具预览限额截断；非-f分页失败无半个成功列表 |

## 跟随与竞态

| 标识 | 场景/注入时机 | 必须结果 |
|---|---|---|
| `A-FOLLOW-METADATA` | send/messages/compact各自-f | metadata先于任何消息，标识正确；messages不知道实际Agent则省略，不以首Agent代替 |
| `A-FOLLOW-FAST` | send在首轮Timeline读取前完成，目标消息超尾页 | 仍补页找本次user锚点，输出全部目标普通消息，再terminal；不只打印最后一条 |
| `A-FOLLOW-NO-RUN` | 稳定完整历史，messages捕获idle | 按有界收尾后输出历史，no_active_run/complete=true/0、runId=null；状态不轮询，已知来源Run各查一次、收尾snapshot一次加有限页，不等待未来任务 |
| `A-FOLLOW-IDLE-EMPTY` | 首snapshot和收尾snapshot均为空，使用-n | metadata后无message，no_active_run/complete=true/0；Run状态查询为0，收尾snapshot为1，不等待未来消息 |
| `A-FOLLOW-IDLE-USER-STABLE` | H0为completed user，originSessionId为当前session、originRunId=null；收尾head/选择不变 | K0未知但按选择正常成功，no_active_run/complete=true/0；-n1输出该user，--after排除锚点自身；不猜Run、不查询旧Run |
| `A-FOLLOW-IDLE-INHERITED-STABLE` | 全部历史来自父session，head assistant的originRunId非空但originSessionId不同；收尾head/选择稳定且消息终结 | K0未知，仍输出所选继承历史并complete=true/0；不把父Run当当前Run、不查询其状态 |
| `A-FOLLOW-IDLE-COMPLETED` | 首snapshot的R1消息streaming；在run-state捕获前R1正常完成 | 先metadata；查R1终态后刷新正文，输出最终内容一次，不只留生成中；完整才no_active_run/0，无cancel/新目标 |
| `A-FOLLOW-IDLE-APPEND-SOURCED` | H0本身为assistant（分别覆盖已completed可见文本/tool-only），originSessionId为当前session、originRunId=R1；R1随后追加最终assistant并结束；追加超过尾页 | 仅从H0确定K0=R1，不依赖streaming提示；一次终态查询、收尾snapshot补页至H0，-n1重算得到新最终回答，--after覆盖同Run应选追加；不能只刷新旧ID |
| `A-FOLLOW-IDLE-APPEND-USER` | H0为completed user且originRunId=null、尚无assistant；R1完成后捕获idle，收尾出现originRunId=R1的最终assistant | K0保持未知；OBSERVATION_INCOMPLETE/6、observation_failed/complete=false，不能按user ID模式/文本/时间推断R1，也不能丢弃追加后输出旧user假成功 |
| `A-FOLLOW-IDLE-OLD-RUN-BARRIER` | R0已完成assistant后，新user为H0且originRunId=null；R1在首snapshot与run-state之间完成，收尾追加R1回答 | 必须显式失败6/complete=false；R0/R1状态查询均为0，不向前找R0作K0、不把R1当后来任务排除后complete=true；无message成功输出，详见下述载荷 |
| `A-FOLLOW-IDLE-NEXT` | H0为可信R1来源；捕获idle后R2启动，收尾/分页继续追加 | 仅来源可证明的其他Run记录可按原规则排除；若出现R2的nullable user则OBSERVATION_INCOMPLETE/6、complete=false，不猜归属。不查询R2的Run状态、不跟随/等待R2、不让分页新head扩大边界 |
| `A-FOLLOW-IDLE-UNKNOWN` | 所选streaming来源不能定位；K0未知且H0之后出现追加；初始空链但收尾出现新链 | OBSERVATION_INCOMPLETE/6、observation_failed、complete=false；追加即使自带Run ID也不能证明其与未知H0的关系，不伪造成功历史；仅K0未知且范围稳定不得无条件失败 |
| `A-FOLLOW-IDLE-INCOMPLETE` | idle后指定已知Run仍running、归属/终态不合法，或收尾选中消息仍streaming/新增记录来源不明 | 退出6/complete=false，不轮询等终态，不把旧生成中当完整结果；R1后继/R2之后又出现R1也显式失败，不能跳过冲突记录 |
| `A-FOLLOW-IDLE-READ-FAIL` | 一次终态/收尾/必要分页失败，H0/after锚点被回退移除 | 传输5/认证4或契约不一致6；锚点/改链为TIMELINE_CHANGED/6；均observation_failed、complete=false，无成功历史/0；不重试、无未来Run监听 |
| `A-FOLLOW-INIT-RACE` | 首snapshot与run-state之间完成，或捕获到明确活动Run | idle走上述单一路径；活动Run仍固定捕获ID，不能用“并发不承诺”跳过正常完成收尾 |
| `A-FOLLOW-SWITCH` | 目标终结后马上启动另一个Run | 继续查询原Run；最后排干过滤originRunId，之后Run消息不进入follow |
| `A-FOLLOW-UPDATES` | 同消息多次revision、重复同revision、parts新增/替换 | JSONL upsert取最高revision；不拼接重复正文；人类仅生成中标识及终结完整正文一次 |
| `A-FOLLOW-TOOLS` | assistant仅工具/推理后出现普通文本 | 之前不计普通消息，出现文本后纳入；不输出工具事件流或推理 |
| `A-FOLLOW-RESET` | 自动压缩导致root变化，reset尾页不足100/500；分页期间消息更新 | 重建并补页，保留固定锚点，最后内容不漏不重；不提前推进revision |
| `A-FOLLOW-BRANCH` | 网页回退/替换移出已输出消息或锚点 | 退出6/TIMELINE_CHANGED、complete=false；不接新分支装作完成 |
| `A-FOLLOW-DRAIN` | Run先终态、最后消息在终态前落库；随后补读失败 | 必须终态后再读；成功排干才complete=true；补读失败优先观察失败码 |
| `A-FOLLOW-TERMINALS` | completed/failed/cancelled | 分别0/8/9；每次恰一个terminal；Run失败仍可消息complete=true，不把两者混为一谈 |
| `A-FOLLOW-INVARIANT` | 指定Run404/409、不合法终态码、终态却目标streaming | 失败而非成功结束；不改跟活动Run，不无限静默等待 |
| `A-FOLLOW-NETWORK` | 轮询超时、断线、401 | 立刻结束、无失败请求重试；末尾complete=false（stdout可写时），保留目标标识 |
| `A-FOLLOW-DEADLINE` | --follow-timeout到期、请求时限先到期、大于Node单timer上限时长 | 按整体/单请求分别10/5；无timer溢出；不取消后台 |
| `A-FOLLOW-SIGNALS` | SIGINT/SIGTERM/EPIPE发生于发送后、跟随中、终态排干中 | 130/143/141；清理本地轮询/handler；取消POST为0；stdout损坏不能承诺terminal |

### idle来源边界的明确载荷

- 下列为受控HTTP fixture的关键消息载荷，不是新增API；公共工厂按现有schema补齐workspaceId、replacesMessageId、updatedRevision、时间与part的id/position等字段，禁止替用例补非空originRunId或从消息ID推断来源。当前workspace/session为w/s，列表均按链正序。
- 每个snapshot用表中head设置session.headMessageId，messages按表中ID展开以下记录，hasMore=false、nextBeforeMessageId=null；其余session字段保持合法一致。两次snapshot之间run-state固定status=idle、activeRunId=null，指定Run状态GET设置为意外请求即测试失败。

```json
[
  {"id":"u-only","previousMessageId":null,"depth":0,"type":"user","status":"completed","originSessionId":"s","originRunId":null,"parts":[{"type":"text","text":"只有输入"}]},
  {"id":"u0","previousMessageId":null,"depth":0,"type":"user","status":"completed","originSessionId":"s","originRunId":null,"parts":[{"type":"text","text":"旧输入"}]},
  {"id":"a0","previousMessageId":"u0","depth":1,"type":"assistant","status":"completed","originSessionId":"s","originRunId":"r0","parts":[{"type":"text","text":"旧回答"}]},
  {"id":"u1","previousMessageId":"a0","depth":2,"type":"user","status":"completed","originSessionId":"s","originRunId":null,"parts":[{"type":"text","text":"新输入"}]},
  {"id":"a1","previousMessageId":"u1","depth":3,"type":"assistant","status":"completed","originSessionId":"s","originRunId":"r1","parts":[{"type":"text","text":"新回答"}]},
  {"id":"u-parent","previousMessageId":null,"depth":0,"type":"user","status":"completed","originSessionId":"parent","originRunId":null,"parts":[{"type":"text","text":"继承输入"}]},
  {"id":"a-parent","previousMessageId":"u-parent","depth":1,"type":"assistant","status":"completed","originSessionId":"parent","originRunId":"r-parent","parts":[{"type":"text","text":"继承回答"}]}
]
```

| 验收用例/选择 | 首snapshot：head；messages | 收尾snapshot：head；messages | 必须断言 |
|---|---|---|---|
| `A-FOLLOW-IDLE-USER-STABLE`，-n1 | u-only；[u-only] | u-only；[u-only] | K0未知；message只有u-only/正文“只有输入”，随后no_active_run/complete=true/0；指定Run查询0 |
| `A-FOLLOW-IDLE-USER-STABLE`，--after u-only | u-only；[u-only] | u-only；[u-only] | K0未知；message为空、complete=true/0，不把锚点本身输出；指定Run查询0 |
| `A-FOLLOW-IDLE-INHERITED-STABLE`，-n1 | a-parent；[u-parent,a-parent] | a-parent；[u-parent,a-parent] | message为a-parent/正文“继承回答”，保留originSessionId=parent、originRunId=r-parent；complete=true/0，父Run查询0 |
| `A-FOLLOW-IDLE-EMPTY`，-n1 | null；[] | null；[] | 无message，no_active_run/complete=true/0，指定Run查询0 |
| `A-FOLLOW-IDLE-OLD-RUN-BARRIER`，-n1 | u1；[u0,a0,u1] | a1；[u0,a0,u1,a1] | K0始终未知；OBSERVATION_INCOMPLETE/6、observation_failed/complete=false，R0/R1查询0；stdout只有metadata和失败terminal，不得输出u1并宣称完整 |

- 上表成功项都须断言snapshot恰好两次（首读与一次收尾）、run-state一次、无轮询等待和任何写请求；失败项也不得重试。各项分别验证human与JSONL，JSONL解析后断言消息ID、正文、来源、terminal顺序和完整性，不只匹配提示语。
- `A-FOLLOW-IDLE-APPEND-USER`另用无旧Run的最小链验证：首读仅一个previousMessageId=null的nullable user，收尾追加来源为R1的assistant，仍必须失败；不能因为没有旧Run才碰巧避开错误。nullable user分别使用不关联的ID与r1-user重跑（同步所有链指针），后者也不得被解析为Run来源。
- `A-FOLLOW-IDLE-COMPLETED`及有来源追加用例须使用真实非空原生来源字段；初始选中streaming逐个证明终态，归属不能证明则失败。未知K0时，所选streaming已收尾也不能为H0之后的新增记录补出可信归属。
- 非跟随回归以已完成链[u0,a0,u1,a1]直接执行-n1，正常返回a1/“新回答”，不读取run-state或Run状态；调用模型在-f观察失败后可这样重新读取，CLI不自动重试。

## 状态、取消与压缩

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-CONTROL-STATUS` | 主/子session的idle/running | 仅忙闲投影、退出0；不要求lastRun/失败原因，idle不被表述为任务成功 |
| `A-CONTROL-CANCEL-TYPE` | 子session取消、跨工作区、404 | 子会话在CLI拒绝且POST0；其余按API失败；不改原API路由限制 |
| `A-CONTROL-CANCEL-TREE` | 主Run带活动子/孙Run，已完成子Run | 当前树活动后代级联；已完成不变；工作区已写文件不回滚 |
| `A-CONTROL-CANCEL-RACE` | 预查后旧Run结束、新Run开始；根已idle | 文案承认处理时当前执行；不声称expectedRunId保护；idle不扫描历史孤儿关系 |
| `A-COMPACT-TYPE-BUSY` | 子session、busy；预查idle但POST409 | CLI/后端双重边界符合现状，不排队、不重试、不变更API |
| `A-COMPACT-EMPTY` | 空主session | 400/AGENT_COMPACTION_EMPTY明确失败，不假造runId或无必要成功 |
| `A-COMPACT-ACCEPT` | 默认提交与-f | 默认受理即退出；-f固定Run终结；scheduled不是排队；原历史仍可读、文件不变 |
| `A-COMPACT-SKIP` | not_needed/no_progress/oversized_tail/media_requires_resend | 按completed码清楚说明未改变原因、退出0；不要求请求响应立即给skip |
| `A-COMPACT-FAIL` | pending_tools/provider_unavailable/failed | 按Run failed退出8；HTTP503仍6；不与完成skip混淆 |
| `A-COMPACT-DEDUP` | 可证明同请求的dedup响应 | scheduled=false表示旧执行；不是无需压缩；跟随原Run，request ID不与send共用 |

## 下载与本地发布

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-DOWNLOAD-PATH` | 缺w/path/output，绝对/UNC/盘符、..分段、控制字符、反斜杠 | 退出2，不发下载；合法相对路径编码一次；`.`明确根，不猜远端绝对路径 |
| `A-DOWNLOAD-TYPES` | 文件、含普通文件目录、空目录 | 文件字节一致、目录ZIP可解；空目录不保留是现状，不伪造空目录项；stdout只有summary |
| `A-DOWNLOAD-LIMITS` | 目录源文件累计100MiB及+1、含.git、扫描遇软链 | 保持现有边界/报错，不新增跳过规则、不收紧API、不声称CLI修复软链风险 |
| `A-DOWNLOAD-EXISTING` | 既有文件、目录、dangling symlink、预查后目标被创建 | 拒覆盖；对方内容/链接不变；本次temp清理；没有unlink目标或覆盖rename |
| `A-DOWNLOAD-HEADERS` | 非2xx JSON/HTML、302带Cookie、恶意Content-Disposition | 不发布错误页、不跟随跳转、不信header本地路径；Cookie不泄漏到其他origin |
| `A-DOWNLOAD-TRUNCATE` | body中途断开、超时、长度不符、写盘失败、取消 | 无成功summary、无半成品目标；仅清理本次temp；网络/持久化/信号码准确 |
| `A-DOWNLOAD-PUBLISH` | link原子发布成功、EEXIST、文件系统不支持、发布后清理失败 | 成功前完整flush；不支持则失败不危险降级；已发布文件不得因后续错误被删除，context说明published |
| `A-DOWNLOAD-SIZE` | 大文件及ZIP无Content-Length | 流式背压，不整包response.text/buffer；有长度必校验；无长度正常EOF才发布 |
| `A-DOWNLOAD-INTERRUPT` | SIGINT/SIGTERM/EPIPE，或SIGKILL | 可处理信号清理本次temp；SIGKILL遗留不称成功，不自动删其他进程temp |
| `A-DOWNLOAD-SOURCE-CHANGE` | 下载中源目录变化 | 不承诺快照一致，不把服务器规则/变化伪装成CLI已完整保留目录结构 |

## 输出、鉴权与发布回归

| 标识 | 场景 | 必须结果 |
|---|---|---|
| `A-OUTPUT-JSON` | 每个命令非-f成功/失败 | 成功单JSON，失败stderr单JSON；stdout不混日志/诊断/二进制；help例外固定文本 |
| `A-OUTPUT-JSONL` | 成功、Run失败、监听失败、中断 | metadata/message upsert/terminal字段和顺序可解析；以退出码及complete判定，不只看末尾文字 |
| `A-OUTPUT-SAFE` | API错误body/code、异常stack、argv注入带测试机密 | 白名单code+本地文案，测试机密不出现在stdout/stderr；业务消息正文本身不被过度脱敏截断 |
| `A-OUTPUT-TERMINAL-SAFE` | 名称/标题/用途/文件名含换行和ESC；正文含LF、CRLF、独立CR、ESC ANSI、其他C0/C1和反斜杠；同数据分别human/json/jsonl | human元信息escapeDisplayText单行，正文保留正常换行并转义控制符，stdout无可执行ESC/ANSI；不截断。JSON/JSONL解析后的原文字符完全一致，不被人类转义双重污染 |
| `A-SECURITY-LOGIN` | 现有隐藏token、--token-stdin、auth关闭、401 | 登录输入与缓存行为不退化；token不进argv/配置/日志；auth关闭不读stdin |
| `A-SECURITY-COOKIE` | 合法续签、错误Cookie、缓存保存失败、重定向 | 保留原同源/先保存再成功输出/原错误优先；不转发Cookie、不自动登录重试 |
| `A-SECURITY-INTERNAL` | 静态搜索与请求捕获 | 无数据库读取、internal token、内部事件/执行配置请求；不要求Worker身份 |
| `A-REGRESSION-BUNDLE` | 构建产物在隔离HOME/cwd下运行所有help | 单文件闭包、Node22目标、无运行时仓库依赖；原安装/login/session list门禁按明确兼容变更更新 |
| `A-REGRESSION-API` | 对比开发变更范围并跑必要门禁 | 无API/shared/Worker产品改动；不能为CLI收紧现有业务约束 |

## 测试层次与完成证据

### CLI 单元与受控集成

- 参数/帮助/DTO/投影/错误映射用单元测试；网络、Cookie、multipart、响应流用本地 HTTP server；跟随竞态用可控 revision/run-status 序列和可注入时钟，避免睡眠碰运气。
- 文件发布故障注入 link/unlink/write/sync/close 失败，断言只操作本次拥有的临时路径。
- SIGINT、EPIPE、stdin EOF、构建闭包使用真实子进程测试，不仅调用 runCli 函数。
- 所有夹具和HOME落在项目内测试临时目录，清理只处理测试创建路径。

### 真实公开 API smoke

- 在授权隔离工作区验证发现→自动建会话发送→忙闲→跟随→读取-n1→取消带深层子任务→压缩→下载。
- 验证图片-only和工具-only转文本、多页消息、极快结束/立刻启动下一Run；不要求真实模型每次稳定生成特定文本，可用受控Provider fixture。
- 仅CLI测试不能替代真实API的路径/契约兼容；真实API测试也不能替代确定性的竞态故障注入。
- 若环境无Docker、Node22或真实Worker，明确标注未验；不能把Node24进程或静态Docker检查当作对应环境通过。

### 审查门禁

- 所有 `R-*` 都有对应测试/证据；上述边界失败场景不能被“非目标”随意移除。
- 兼容裁决已落实，帮助、README、测试一致；没有重复业务规则或隐式扩大范围。
- 产品代码只落CLI及测试/说明；下载独立安全问题没有被宣称已修复。
- 构建、类型检查、CLI测试通过；信号、网络unknown、最后消息排干、无覆盖下载有实际测试结果。
- 独立审查者关闭必改项后方可进入实现验收；本文件自身不是通过证据。
