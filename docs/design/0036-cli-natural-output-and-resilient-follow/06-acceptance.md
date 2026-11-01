# 验收矩阵与审查标准

## 验收原则

- 所有场景均为实现验收要求，不能用“文档已写”替代代码验收；95 项逐项测试和实际命令见[实施与验收证据](08-implementation-and-evidence.md)。
- 单元测试使用受控 HTTP fixture、假时钟和可阻塞 Writable；集成测试覆盖真实 Fastify schema、SQLite 读侧和构建后的 CLI 进程。
- stdout/stderr、退出码、请求序列／次数／参数、正文写入时序均应断言；不能只断言最终包含一段答案。
- 在自动测试中为草稿／proof／part 身份使用可识别的占位 ID，扫描 CLI 自己产生的 stdout/stderr 旁路，避免只测正常模板。
- 文本输出不是机器 JSON 协议，不以逐字翻译所有文案为目标；固定错误码、状态、ID 可见性、结束完整性和副作用语义必须精确。
- 每个实现阶段须执行开发—独立审查—修复—复审，问题关闭后才能进入下一阶段；验证命令见[实施计划](07-implementation-plan.md)。

## 命令与格式：REQ-NATURAL／REQ-SCOPE

| 验收 ID | 场景 | 必须满足 |
| --- | --- | --- |
| ACC-COMMAND-FLAG | 根／组／动作位置传 `--json`，包括与 help 同用 | 参数错误 2，无业务联网／配置副作用，不返回 JSON；未知选项不被 help 静默吞掉 |
| ACC-COMMAND-HELP | 所有层级 help/version，组命令无动作 | 离线、无配置依赖；没有合法 AWB JSON/JSONL 示例；原安全输入说明保留 |
| ACC-COMMAND-LOGIN | 认证开启、关闭、错误凭证、保存失败 | 自然语言，既有退出类别；不输出 token/Cookie；POST 一次 |
| ACC-COMMAND-DISCOVERY | workspace/agent 列表含空集、Unicode、控制字符 | ID／名称／用途／总数正确，排序与安全转义不变 |
| ACC-COMMAND-LIST | session list 的时间、主会话、Fork、累计计数、空结果 | 字段与结束标记保持原业务语义，缺失参数仍本地报错 |
| ACC-COMMAND-SHOW-STATUS | 已知主／子会话，idle/running | 自然语言固定状态；查询 running 仍可退出 0；不新增状态退出码 |
| ACC-COMMAND-SEND | 创建或既有 Session，纯文本／纯图／混合输入 | 受理不等于执行成功；必要受理身份清楚；用户消息 ID 明确命名；无自动重复 POST |
| ACC-COMMAND-MESSAGES | 已终结历史、streaming 快照、隐藏行 | 普通消息按链输出一次；正文后才有终态 ID；streaming 快照无未终结 ID；数量和快照完成不冒充 Run 完成 |
| ACC-COMMAND-CANCEL | running、idle、子会话 | 取消请求处理状态准确；主会话限制不变；不承诺回滚；不重试写请求 |
| ACC-COMMAND-COMPACT | 受理、busy、空会话、各合法终态码 | 保留原约束和具体结果；follow 可没有普通正文；无虚构空助手消息 |
| ACC-COMMAND-DOWNLOAD | 文件／ZIP、目标冲突、截断、发布后清理或输出失败 | 二进制不入 stdout；不覆盖；published 准确；非零退出不误称未创建；无自动下载／发布重试 |
| ACC-SCOPE-JSON | HTTP/schema/config、正文中的 JSON、rg 的 `--json` | 不被移除或误改；内部契约继续有效 |
| ACC-SCOPE-NO-NEW | 命令列表与配置对比 | 无新输出格式／续读参数／恢复服务／鉴权模式／数据库表／推送协议 |

## 增量与字符：REQ-STREAM

| 验收 ID | 输入／时序 | 必须满足 |
| --- | --- | --- |
| ACC-RENDER-APPEND | 同消息 `你好`→`你好，我是`→最终完整文本 | stdout 只有各新增后缀；正文累计等于规范终文一次，终态不重打 |
| ACC-RENDER-NOCHANGE | 相同 revision 重复；仅 revision/时间/隐藏 metadata 变化 | 不重复正文、标题、图片、footer |
| ACC-RENDER-FAST | 首次轮询消息已经 completed | 完整正文一次，真实终态与 ID 一次，不伪造生成过程 |
| ACC-RENDER-MULTI | 多条助手消息、工具往返后新消息、user 历史 | 消息边界清楚，各自进度独立；user 完整输出一次；工具内容不泄露 |
| ACC-RENDER-PARTS | 多 text，text/image/text，重复 attachment 的不同 Part | 按 position，分隔符与快照一致；每个 image Part 一次，不全局误去重 |
| ACC-RENDER-LAYOUT | Part 改 id/type/position、删除／重排、旧 image 改元信息 | 观察失败，不当成合法追加，不打印修订全文掩盖 |
| ACC-RENDER-SEALED | 已有后继（含隐藏 Part）后，早先 text 被追加 | 拒绝；只最后未封口 text 能追加 |
| ACC-RENDER-CRLF | `A\r`→`A\r\nB`，以及 `A\r`→`A\rX` | 前者一次规范换行，后者转义回车；不重复／漏字符、不误判改写 |
| ACC-RENDER-UNICODE | emoji 代理对跨版本、孤立高／低代理、终态仍孤立 | 完整代理对不拆写成乱码；孤立项与整段快照的 U+FFFD 规范一致 |
| ACC-RENDER-SEAL-TAIL | 尾部 CR／高代理后出现下个 Part，或 failed/cancelled | 正确封口暂存后再输出分隔与状态，不把暂存留到另一消息 |
| ACC-RENDER-ESCAPE | 反斜杠、ESC、回车、Tab、CRLF、控制字符跨版本 | 与统一快照渲染一致，无 ANSI／回退，无 raw delta 独立转义造成二次转义 |
| ACC-RENDER-REWRITE | 同 ID raw 非前缀变更、缩短、等长改字、终态后正文变化 | RESPONSE_INVALID/6，complete=false；不重试、不悄悄继续 |
| ACC-RENDER-HIDDEN | reasoning-only、tool-only、空白 assistant、系统/runtime/compaction | 无可见普通正文／空 footer；内部链仍验证 |
| ACC-RENDER-LONG | 长文、数百更新、多页、多 Part | 正常尝试的正文写出总量等于最终规范正文一次；无累计全文放大；不以工具截断冒充 CLI 完整性 |

### 快照局部 flush 与 follow 暂存的成对精确验收

- 下表的 `\r`、`\n`、`\uD83D`、`\uDE00` 表示构造 raw 输入的代码转义，不是已经转义的正文。UTF-8 十六进制仅针对正文片段，排除角色标题、状态、分隔模板与 footer 的字节。
- 两个 snapshot 用例均使用业务仍 streaming 的同一类消息，快照读取完成后无消息 ID，业务状态仍 streaming；随后独立调用不得复用已局部 flush 的 writer。follow 用例每个分支分别建立独立 fixture，不在同一次输出中撤回已写字符。

| 验收 ID | 输入与输出边界 | 必须满足的字符／UTF-8 字节 |
| --- | --- | --- |
| ACC-RENDER-SNAPSHOT-CR | 非 follow 所读版本 raw=`A\r`，本次快照结束 | 正文为 A、反斜杠、r，字节 `41 5c 72`；localFlushComplete=true，但 businessSealed=false，无消息 ID |
| ACC-RENDER-FOLLOW-CR-PAIR | follow 第一版 raw=`A\r`；分支一补 `\nB`；分支二不追加而进入消息终态 | 第一版只输出 A，字节 `41`；分支一累计为 A、LF、B，字节 `41 0a 42`；分支二终态后累计 `41 5c 72`，正文 callback 完成后才可 footer |
| ACC-RENDER-SNAPSHOT-SURROGATE | 非 follow 所读版本 raw=`A\uD83D`，本次快照结束 | 正文为 A、U+FFFD，字节 `41 ef bf bd`；localFlushComplete=true，但 businessSealed=false，无消息 ID |
| ACC-RENDER-FOLLOW-SURROGATE-PAIR | follow 第一版 raw=`A\uD83D`；分支一补 `\uDE00`；分支二不追加而进入消息终态 | 第一版只输出 A，字节 `41`；分支一累计为 A😀，字节 `41 f0 9f 98 80`，不得先写替代字符；分支二终态后累计 `41 ef bf bd`，之后才可 footer |

## 消息 ID：REQ-ID

| 验收 ID | 场景 | 必须满足 |
| --- | --- | --- |
| ACC-ID-BEFORE | 有草稿但未终结，阻塞正文 write callback | 头部、stderr、metadata、active arrays、proof 提示均无草稿 ID |
| ACC-ID-AFTER | 终态已读到，但最后正文仍背压 | callback 成功前无消息 footer ID；正文完成后状态和 ID 才出现 |
| ACC-ID-FAIL-CANCEL | 消息 failed/cancelled | 正文先完成，再真实状态及 ID；不写“成功答案” |
| ACC-ID-INTERRUPT | 草稿生成／退避／正文背压时 SIGINT、SIGTERM 或时限 | 不打印该草稿 ID，不补正文全文；只说明观察不完整／后台未取消 |
| ACC-ID-INVALIDATED | 单次／多次替换，旧草稿曾显示 | 作废标记无旧／新草稿 ID；新终态正文尾可展示新 ID |
| ACC-ID-ERROR | history/detail/after/contract/网络/续签错误携带内部 messageId | stdout/stderr 无尚未发布的 assistant ID／partId／replaces 别名；保留安全 Run 等诊断 |
| ACC-ID-FOOTER-PIPE | footer 写入失败或 EPIPE | 不通过后续上下文补发 ID；退出类别正确，不保证 terminal |
| ACC-ID-NO-RESUME | 正常／失败／中断／无安全历史 | 无建议续读位置、游标字段、恢复命令或等价提示 |

## 服务端证明：REQ-REPLACE

| 验收 ID | 设置 | 必须满足 |
| --- | --- | --- |
| ACC-PROOF-DIRECT | A 被 B 合法替换 | delta/reset 可选摘要字段完整，与 session.revision 绑定 |
| ACC-PROOF-CHAIN | 两次轮询间 A→B→C | 一份常量摘要 from=A/to=C/count=2；不需公开 B，无旧正文 |
| ACC-PROOF-SLOT | P→C→D→E，A/B 在 C 槽位，C 不在尾页 | 找 C 而非最终 head；支持候选 completed；客户端分页取齐 C/D/E |
| ACC-PROOF-BOUND | 恰好 256 边与 257 边 | 256 可证，257 不证；读取步数受限；不改变 Run 后台状态 |
| ACC-PROOF-DAMAGE | 循环、断链、跨 workspace/session/run、type/status 错、previous/depth 错、revision 非法 | 不出具摘要，不泄露图诊断，不用普通无证明情况制造 500 |
| ACC-PROOF-NO-PARAM | 无 knownHead、snapshot/before、knownHead 仍可见、无有效 sinceRevision | 没有摘要；既有读取行为不变 |
| ACC-PROOF-READVIEW | 在 session/消息/证明读取之间模拟并发写入 | 单响应字段来自同一事务视图，atRevision 不贴旧标签；事务不跨网络 |
| ACC-PROOF-SCHEMA | 真实 Fastify 序列化与共享校验 | 摘要不被 additionalProperties:false 丢弃；字段类型、枚举、常量大小严格 |
| ACC-PROOF-ISOLATION | 尝试普通详情读取 A/B、伪造其他 Session knownHead | 不开放不可见详情／跨范围读取；不返回旧 Part 内容 |
| ACC-PROOF-CLIENT | 用于目标草稿例外的摘要身份、revision、count、from 缓存状态逐一篡改 | 客户端拒绝；不能靠相同深度或 Run 猜测；合法非目标摘要不因不满足目标来源资格就被误报 |

## 客户端协调与选择：REQ-REPLACE／REQ-SELECTION

| 验收 ID | 场景 | 必须满足 |
| --- | --- | --- |
| ACC-RECONCILE-AUTO | 自动初始 head／last 选中 A streaming，合法替换 | 不被误当硬 anchor 阻止；旧展示段作废，继续同 Run |
| ACC-RECONCILE-EXPLICIT | 显式 `--after A`，A 后被替换 | 明确锚点失效，不能将用户锚点改为 C；无草稿 ID 回显 |
| ACC-RECONCILE-HISTORY | 另一已输出终态消息／继承历史／用户消息被回滚，同时存在合法 head 证明 | 整体仍失败，不能清空保护集合 |
| ACC-RECONCILE-RESET | head 替换导致 reset、root 改变、超过尾页的前缀 | 只对已证明草稿例外；其他链/root/保护校验完整 |
| ACC-RECONCILE-PAGING | 多页重建间 C→F，page revision 较新 | 不直接推进 watermark；关闭 delta 消费更新后提交，不漏正文；已知终态则受两 pass／每 pass 一次关闭读限制，不能 CHECK 后继续补页再关闭 |
| ACC-RECONCILE-CURSOR | 失效页 cursor 正是可变 head，得到精确 cursor-not-found | 不重试原 404；先让出查询固定 r1，running 时新 delta 有证明才重建；已终态则只进入 FinalDrain，不能额外开恢复循环 |
| ACC-RECONCILE-UNRELATED | 普通 404、硬 after 丢失、受保护的其他来源非法变化 | 不作结构恢复，不重试，不放宽为“反正同 Run” |
| ACC-RECONCILE-MANY | 多轮可证替换以及一轮漏掉多次替换 | 每步从实际已观察 head 出发；不下发/缓存无界证明链，不打印中间 ID |
| ACC-SELECTION-AFTER | A→B→C，after B | 初始只出 C；最后消息 after 返回空；非法锚点报错 |
| ACC-SELECTION-LAST | hidden 穿插、多页 last N | 只计普通消息，顺序和分页界限不变；不能丢真正历史 |
| ACC-SELECTION-FIXED | 目标 r1 结束前后 r2 出现 | 只跟随 r1，初始历史之外不混入 r2，不捕获新目标 |
| ACC-SELECTION-LATER-RETRY | 最终补读时全局 head 已到 r2，r2 草稿替换导致 reset／合法非目标摘要 | 不应用摘要豁免 r1；最多两个 pass 验证 r1 全范围和硬历史保留后可完整结束；不足则明确 incomplete，保留 r1 结果。不跟随 r2，也不因其正常后缀替换一律判错 |
| ACC-SELECTION-IDLE | 空集、user-only、继承、可信来源收尾、初始化中 A 被替换 | 一次有界收尾；可证同来源替换可收尾，无活动任务不永久等待 |
| ACC-SELECTION-IDLE-UNKNOWN | 未知来源 streaming、来源仍 running、空历史变新消息、无法归属追加 | OBSERVATION_INCOMPLETE/6；不向旧历史猜 Run |
| ACC-SELECTION-SUBTASK | 已知子会话 messages/show/status | 原读取能力和来源身份不变，写操作边界不放开 |

## 有界终态收尾：REQ-FINAL-DRAIN／REQ-SELECTION／REQ-LIFETIME

- fixture 分别记录 OPEN、before、CHECK、固定 `/runs/r1` 的逻辑调用和各自 HTTP 尝试；断言 passNo 最大为 2，每 pass 的 CHECK 最多一次，关闭读的失败重试不是新 pass。所有 r2 消息均不属于初始选择／已输出／硬保护范围。
- root 变化成功／不充分场景必须保留原显式 after、已输出终态及必要保护前缀；若已经证实保护被破坏，应按保护错误立即失败，不能用预算耗尽替代该错误。

| 验收 ID | 时序 | 必须满足 |
| --- | --- | --- |
| ACC-FINAL-DRAIN-FIRST-PASS | r1 已终态；OPEN 得到固定前缀，多页正常补齐，CHECK 完整 | 恰好一个 pass、一次关闭读，输出 r1 剩余正文/footer 和唯一完整收尾；不做多余第二 pass |
| ACC-FINAL-DRAIN-APPEND-ONLY | 每个 before 页之间 r2 追加／正文更新；CHECK 又有更高 depth 后缀，但相关范围／硬保护有效 | before cursor 严格向较低 depth；不追新 head／多读 r2；一个 pass、一次关闭读即可完整结束 |
| ACC-FINAL-DRAIN-SECOND-SUCCESS | 第一 pass 分页中 r2 草稿替换／root 变动；CHECK reset 尾页不足以定位 r1。第二 pass 取齐相关前缀，CHECK 只有 r2 追加 | 恰好两个 OPEN、两次关闭逻辑读；第二 pass 从原完整 cursor 请求，范围验证成功后结束，不要求最新全局 head 稳定 |
| ACC-FINAL-DRAIN-SECOND-EXHAUST | 第一 pass 分页间 r2 A→B 且 root 变化，CHECK 尾页缺少相关证据；第二 pass 分页与 CHECK 间 r2 B→C→D 且再次 root 变化，关闭尾页仍不足 | 最大两个 pass、每 pass 一次 CHECK，无第三 OPEN／关闭读／关闭后补页；退出 OBSERVATION_INCOMPLETE/6，complete=false；保留已知 r1 completed/resultCode，不输出／等待 r2 |
| ACC-FINAL-DRAIN-RETRY-BUDGET | 第二 pass 的 CHECK 连续三次 503 后成功；另一分支四次均 503 | 各分支最多四次相同参数尝试，closeUsed 始终 true，passNo 始终 2；成功但仍不足按 incomplete，四次耗尽保留原 HTTP 错误及已知 r1 结果；不得再开 pass |
| ACC-FINAL-DRAIN-PROBE-ESCAPE | 普通 refresh 内 r2 在 reset、before 页与可变 cursor 失效之间持续改变；其中 r1 转终态 | 每个结构响应在下一协调读前让出固定 `/runs/r1`，同一响应多种变化仅查一次；发现终态立即进入两 pass 收尾，无 activeRunId 重捕获。查询耗尽或生命周期终止则立即停止 |
| ACC-FINAL-DRAIN-PAGE-CURSOR | 两个 pass 各有非目标可变 before cursor 精确失效，须重新定位 | 每次直接去本 pass 唯一 CHECK，不重试 404、不额外取恢复 proof；第一 pass 可转第二，第二仍不充分即停止；缺失硬锚点则立即失败 |
| ACC-FINAL-DRAIN-PROTECTED | 正例仅未选择／未输出 r2 后缀合法替换；反例同时有合法目标草稿 proof，但另一已选择／已输出 Run 的硬历史被改写／删除 | 正例不一律报错，按相关证据完整或有界 incomplete；反例立即保护失败，不忽略硬历史，也不使用第二 pass 掩盖 |
| ACC-FINAL-DRAIN-OPEN-FENCE | OPEN 的目标 streaming head 有 raw 来源；BUILD／CHECK 提供合法同槽位最终后继，另有仅 head ID／较新页冒充起始来源的反例 | 合法 proof 只映射同 previous/depth 的 fence，不扩充深度或更改 after；反例不取得豁免资格。不提交半帧／未消费 watermark；关闭后仍缺候选则仅剩余 pass 可分页 |

### 必须固定的时序断言

- 连续变化夹分页／关闭读：`known r1 completed → OPEN1 → before1 → r2 A→B/root1 → CHECK1(reset，范围不足) → OPEN2 → before2 → r2 B→C→D/root2 → CHECK2(reset，范围仍不足) → incomplete/6`。没有第二次 CHECK2、OPEN3 或后续 `/runs/r2`；stdout 保留 r1 成功结果但明确读取不完整。
- 一次重定位后成功：`OPEN1 → before1 → r2 替换 → CHECK1(reset，范围不足) → OPEN2 → 必要 before 页 → r2 追加 → CHECK2(相关范围充分) → complete`。不因最新全局 head 与起始 fence 不同继续追页。
- 正常一 pass：`OPEN1 → 向前补齐固定前缀 → CHECK1(相关范围充分) → complete`；期间任意多次不破坏前缀的 r2 追加／更新都不产生 OPEN2。
- 结构让出：`普通 before/reset/cursor 失效响应 → /runs/r1 → 已终态 → OPEN1`；不得出现“持续协调 r2 → 一直未查 r1”。在途状态查询／退避同样可取消，取消不调用后台 cancel。

## 请求重试：REQ-READ-RETRY

| 验收 ID | 场景 | 必须满足 |
| --- | --- | --- |
| ACC-RETRY-TRANSPORT | 建连失败／body 中断／单请求 timeout，之后成功 | 相同逻辑请求最多四次；1/2/4 秒退避；成功正文只消费一次 |
| ACC-RETRY-HTTP | 429/502/503/504 与 500/501/401/403/404/302 | 只重试白名单；状态错误 body 无效也不扩大白名单 |
| ACC-RETRY-CONTRACT | HTTP200 无效 JSON、错误身份／proof／终态码 | 一次即失败，不以 exitCode6 重试 |
| ACC-RETRY-BUDGET | 每个请求都先失败三次再成功，连续多轮 | 每请求独立四次，不共用 Run 总次数；成功后的新请求预算恢复 |
| ACC-RETRY-PARAMS | delta、run-status、before 页失败 | 路径业务参数和 validator 不变；不改 Run、cursor、watermark、clientRequestId |
| ACC-RETRY-NO-REPLAY | refresh 已成功后 readRun 失败；第三页失败 | 只重试当前步骤，不整轮重放、重打正文或重读前两页 |
| ACC-RETRY-INIT-DRAIN | 初始化、idle 收尾、终态补读暂时失败 | 同样可恢复；终态补读耗尽仍 complete=false，保留已知业务结果 |
| ACC-RETRY-RENEW | 503+续签成功、503+保存失败、200+保存失败 | 成功续签可用于下一尝试；保存失败强制禁止重试，保留主次错误规则 |
| ACC-RETRY-SCOPE | 非 follow 普通查询／messages／download 失败 | 不新增重试；follow 写请求也只发一次 |
| ACC-RETRY-INTERRUPT | 各次退避／在途请求中 SIGINT/SIGTERM/EPIPE/整体时限 | 立即停止，不再发下一次，不调用 cancel；原退出类别 |
| ACC-RETRY-TIMEOUT | 单请求时限与整体监听时限先后触发 | 单请求可重试，整体时限不能重试；每 attempt 新请求时限、整体不重置 |
| ACC-RETRY-OUTPUT | stdout/重试 stderr 失败 | 不当网络错误重试；提示有界、不泄露 URL/凭证/草稿 ID、不逐秒刷日志 |
| ACC-RETRY-FIXED | 响应提供 Retry-After | 仍按约定固定退避，不新增配置和无限等待 |
| ACC-RETRY-ERROR-PRESERVE | before/loadThrough 中 HTTP503 耗尽，或取消／保存失败被包装 | 不被广泛 exitCode6 catch 改成分支错误；原状态、blocked、主次错误与生命周期优先级保留 |

## 生命周期、结果与副作用：REQ-LIFETIME

| 验收 ID | 场景 | 必须满足 |
| --- | --- | --- |
| ACC-LIFETIME-DRAIN | completed/failed/cancelled | Run 终态之后仍有最终 delta；0/8/9 与 complete=true 可组合 |
| ACC-LIFETIME-INCOMPLETE | 已知 completed，但补读网络耗尽／契约错／仍 streaming | complete=false；观察错误优先；保留已知 resultCode |
| ACC-LIFETIME-BACKPRESSURE | stdout 暂停读取、慢 write、长文 | 等 callback，顺序不乱、不提前 ID、不忽略 error，不无界追加写队列 |
| ACC-LIFETIME-PIPE | EPIPE、stdout 已关、SIGKILL | 不保证 terminal；141 或实际信号退出；不自动取消后台 |
| ACC-LIFETIME-STDERR | stderr 永不消费／已关闭／异步报错 | 最终与重试诊断有界；不改变主业务错误，不递归报错、不悬挂进程 |
| ACC-DIAGNOSTIC-FIELDS | code/serviceCode/phase/effect 与安全上下文 | 文本可诊断，无原始异常/URL/Cookie；草稿 ID 仍隐藏 |
| ACC-DIAGNOSTIC-EFFECT | 发送未知受理、已受理后观察失败、发布后失败 | 不建议盲目重发；不丢 accepted/unknown/published 信息 |
| ACC-SCOPE-REGRESSION | 原输入/路径/软链/认证/下载/Worker 安装门禁 | 原安全断言保留；不得为了删除 JSON 简化掉边界测试 |

## 验收证据要求

- 每个验收 ID 对应测试名或可审阅的人工证据，报告记录命令、结果及未执行原因，不用单一“全部通过”替代。
- API 证明至少有 SQLite 单元测试、Fastify 响应契约测试和跨进程 CLI 场景；A→B→C 与 C 后还有多条消息不能只用伪造 CLI fixture 覆盖。
- 流式时序至少通过受控 Writable 或真实进程分块读取证明，不能把最终 stdout 全量字符串相等当成“确实增量”。
- 不对外层模型工具的实时展示或截断作未经验证的承诺；可额外人工检查终端/管道一致，但不替代上述边界。
