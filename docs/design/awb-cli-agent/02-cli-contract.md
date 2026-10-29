# CLI 契约

## 命令树

```text
awb [--json] [--timeout <duration>] <group> <action> [options]
awb login --url <origin> [--token-stdin]
awb workspace list
awb agent list -w <workspace>
awb session list -w <workspace> --updated-within <duration> [--status idle|running|all] [--kind primary]
awb session show -w <workspace> -s <session>
awb session send -w <workspace> [-s <session>] [-a <agent>]
    [--prompt <text> | --prompt-file <local-file> | --stdin]
    [--image <local-file> ...] [-f] [--follow-timeout <duration>]
awb session messages -w <workspace> -s <session>
    (--after <message> | -n <count>) [-f] [--follow-timeout <duration>]
awb session status -w <workspace> -s <session>
awb session cancel -w <workspace> -s <session>
awb session compact -w <workspace> -s <session> [-f] [--follow-timeout <duration>]
awb file download -w <workspace> --path <remote-relative-path> --output <local-file>
```

- 本文件是新增 CLI 命令、参数及输出的唯一规范；命令树不代表新增同名后端接口。
- `session list` 默认只查主会话；`--kind primary` 是已弃用兼容写法，`--kind subtask/all` 本地退出 2、不联网、明确提示迁移，不忽略、不扩展 legacy、不改 API；这是本期有意收缩CLI行为，见[已定裁决](06-decisions-and-references.md#cli兼容性裁决)。
- `compact` 不额外暴露 Agent 选择参数；内部按发送同一默认规则选首个 user Agent，显式传给后端，便于保持选择与输出一致。
- 不提供位置参数；未知命令、额外位置参数或选项组合均报用法错误。

## 通用参数与解析

| 参数 | 规则 |
|---|---|
| `-w, --workspace <ID>` | 除工作区列表和登录外所有资源命令必填；不从 cwd、环境变量或上次操作猜测 |
| `-s, --session <ID>` | 会话对象 ID；仅 send 可省略 |
| `-a, --agent <ID>` | 仅 send；省略选择工作区 user 列表第一个 |
| `-f, --follow` | 仅 send/messages/compact；消息级监听 |
| `-n, --last <N>` | 仅 messages；匹配 `^[1-9][0-9]*$`，范围 `1..Number.MAX_SAFE_INTEGER`；不接受 0、前导零、负数、小数、科学计数法或前导加号 |
| `--after <ID>` | 仅 messages；排除锚点自身，与 `--last` 恰选一 |
| `--kind <kind>` | 仅 session list；兼容值只有 primary，可省略；subtask/all及其他值本地退出2，不联网；具体帮助标注弃用/迁移 |
| `--json` | 根级全局选项；允许放在根、组或具体命令参数位置，效果相同；同一调用只出现一次 |
| `--timeout <duration>` | 根级全局选项，位置同上；单次 HTTP 请求完整响应的总时限，默认 `30s`，范围 `1s..24h` |
| `--follow-timeout <duration>` | 仅与 `-f` 同用；整体监听时限，默认无整体上限，显式范围 `1s..90d`；不影响后台运行 |
| `-h, --help` | 所有层级等价，见帮助规则 |
| `--version` | 保留现有根级版本查看 |

- 时长语法沿用现有正整数 `s/m/h/d`，不同选项分别检查上界；不接受空白、`1.5h`、`0s`、`1h30m` 或数值溢出。
- 除可重复 `--image` 外，单值与布尔参数重复均拒绝；短/长别名算同一参数，不能以 `-w X --workspace Y` 覆盖。解析器必须识别选项值边界，不得把提示词值里的 `--workspace` 当成真实重复选项；`--prompt=...` 可承载以连字符开头的文本。
- ID 是不透明标识，不猜 UUID 格式；必须非空、不全空白、无首尾空白、无控制字符；路径段ID还必须拒绝字面 `.` 和 `..`，本地退出2，不得依赖 encodeURIComponent 处理URL点段。资源归属由API最终判断，不自动更换工作区。
- 路径段ID从原始值一次 `encodeURIComponent`，查询用 `URLSearchParams`，不能先解码再编码。原值 `%2e%2e` 必须变成 `%252e%252e`，`/ ? #` 均作为ID数据编码，不转成路由/查询/fragment结构。
- 构建最终URL后必须验证其 origin、无fragment及 pathname 与按静态路由模板和编码ID组成的预期路径完全一致；同源和 `/api/` 前缀本身不足以证明路径结构未被归一化。失败不发请求。
- `--json` 下不输出颜色、进度转圈或调试日志。默认人类文本同样禁止无界轮询日志；元信息（ID、名称、标题、用途、文件名、输出路径等）复用现有 escapeDisplayText，在一条可见行内显示，不能让用户内容发送终端控制序列。
- 人类消息正文显示时先将正常CRLF换行转为LF，再按LF分行，对各行复用escapeDisplayText，最后以LF拼回；保留正常换行，独立CR、ESC及其他控制字符转为可见转义，不输出可执行ANSI。此规则只作用于人类渲染，不截断正文；JSON/JSONL解析后的业务文本保持原字符（含换行/ESC），不得套用人类显示转义。
- 所有只读和有副作用 HTTP 请求的自动重试次数均为零；HTTP 错误、401、断线均不触发重新登录。

## 帮助与渐进披露

| 调用 | 应展示 | 不应展示/执行 |
|---|---|---|
| `awb`、`awb -h`、`awb --help` | 用途、组列表、一段最短工作流、如何查看下层帮助 | 所有命令参数平铺；读缓存/网络 |
| `awb session`、`awb session -h` | 本组动作及一句话用途 | 执行业务动作；展开登录参数 |
| `awb session send -h` | 必填/默认/互斥参数、主会话限制、自动创建失败规则、`-f` 退出规则及纯图例子 | 读 stdin/图片/配置，验证必填资源 |
| 其他具体命令帮助 | 对应参数与例子、重要限制、退出码帮助入口 | 请求服务或写文件 |

- 帮助路径对已知命令优先于必填、参数值和业务校验；例如 `awb session send --help --image /not-present` 必须正常显示帮助、不读该文件。
- 未知命令不伪装为已知命令帮助；显示安全的用法错误，不回显未知词原值。
- 帮助固定为人类文本；即使带 `--json` 也如此，退出 0。不能让 JSON 输出选项阻碍离线帮助。
- 用法错误只输出短原因及准确的 `awb <group> <action> --help`，不倾倒整份帮助，不回显原始 argv。

## 各命令业务契约

### 发现

- `workspace list` 输出 `{id,name}`；`name` 映射后端 `title`。按 `name` Unicode 码点顺序、相同名称按 ID 码点顺序，避免依赖区域设置。空列表成功，不输出 repo URL 或绝对路径。
- `agent list` 输出 `{id,name,summary}`，保留服务端配置顺序，不按名称重新排序；空列表成功。
- 发送/压缩时空 Agent 列表属于无法发起操作，退出 6；必须在自动创建前终止。

### 会话列表、详情与状态

- `session list` 强制请求 `kind=primary`，状态默认 `all`，窗口必填且最大 90d；不加标题、低计数、标签页显隐等额外过滤；保持后端排序及现有计数意义。
- `session show` 输出公开会话元信息：`id/workspaceId/title/kind/forkedFromSessionId/forkedFromMessageId/headMessageId/contextRootMessageId/revision/createdAt/updatedAt`；不将 Fork 来源解释成调用父关系。
- `session status` 只输出 `{workspaceId,sessionId,status}`。成功读取 `idle` 和 `running` 均退出 0，不推断执行成功。
- 列表时间使用 UTC ISO 人类展示，JSON 保留契约毫秒时间戳；不是本地时区模糊字符串。

### 发送输入

- `--prompt`、`--prompt-file`、`--stdin` 最多一个；`--image` 可重复，顺序保留；至少有 trim 后非空文本或一张有效图片。
- 仅 `--stdin` 读取标准输入，直到 EOF；TTY 下拒绝 `--stdin` 并提示用 `--prompt` 或管道，避免无人值守挂起。没有该选项时不读 stdin。
- 提示词文件与 stdin 必须是有效 UTF-8，允许并移除开头一个 UTF-8 BOM，非法编码拒绝，不替换乱码。文件必须可读普通文件，目录/设备/FIFO 拒绝；本地符号链接到普通文件可读取，以用户显式选择的本地文件为准，不将该能力误称远端路径访问。
- 文本源读取上限为 1 MiB UTF-8；文本-only JSON 实际序列化请求体也必须不超过当前 Fastify 默认 1 MiB。带图片时 `payload` 实际 JSON UTF-8 不超过现有 64 KiB。均在创建前检查；这不是修改后端限额。
- 图片支持 PNG/JPEG/WebP，最多 4 张，单张非空且不超过 10 MiB，总计不超过 20 MiB。检查实际字节签名，不信扩展名；同一个文件重复输入按多张累计。通过预检后持有本次读取的字节再发送，防止预检后本地源文件变化。
- multipart 使用一个 `payload` JSON 字段及按顺序的 `images` 文件字段，MIME 用检测结果；只发送本地 basename，不发送绝对路径。纯图不伪造文字。
- 本地输入错误退出 2，发生在配置加载和任何创建/发送之前。stdin 读取/文件读取失败不打印原始异常、提示词内容或完整本地路径。
- 显式 Agent 必须出现在此次可用 user 列表；未指定则取首个，随后显式传给发送，不能让列表与服务端默认选择之间发生静默换 Agent。
- 成功输出受理信息：`workspaceId/sessionId/agentId/messageId/runId/clientRequestId/sessionCreated/accepted/deduplicated`。`accepted=true` 不表示后台成功。
- 本次不提供用户可设置的 `--request-id`，每次新调用生成新请求 ID，不跨调用恢复自动创建链。请求 ID 和去重细节见技术文档。

### 消息计数与投影

本次固定“用户可见普通消息”，不能由开发者按数组长度自行解释：

| 消息内容 | 计入普通消息 N | 输出 |
|---|---|---|
| `user`，含文本或图片 | 是 | 所有 text/image 部分 |
| `assistant`，至少一个非空白 text 或 image 部分 | 是 | 所有 text/image 部分，保留原顺序 |
| assistant 仅 reasoning、tool_call 或空白 text | 否 | 不输出工具输入或推理内容；后续出现可见内容后才纳入 |
| system/runtime/compaction | 否 | 不混入普通消息；压缩结果由终态表示 |
| `superseded` 消息 | 否 | 不作为当前分支有效回答；跟随已输出消息被替换时按改链规则处理 |
| `toolExecutions` | 否 | 本次不提供工具详情事件输出 |

- 普通消息 DTO：`id/type/status/originSessionId/originRunId/previousMessageId/depth/updatedRevision/createdAt/updatedAt/parts`。parts 严格投影为 text `{type,text}` 或 image `{type,attachmentId,mediaType,filename}`，按原position排序；不含 reasoning、tool_call、工具输入、结构化工具结果或内部路径。
- 图片只输出 `attachmentId/mediaType/filename` 元信息，不把二进制或服务器存储路径塞进消息；图片资源下载不在本次范围。
- 普通消息状态包含 `streaming/completed/failed/cancelled`，不能把 streaming 标成完整回答。过滤后的普通消息在当前展示链按 depth 正序，不按时间戳重新排序。
- `-n` 在当前可见分支按上述规则取最后 N 条；不足 N 返回全部。`--after` 锚点必须属于当前工作区/会话当前可见分支；未知、跨 session/workspace 或已离开分支的锚点失败，不退化成全部历史。
- 非跟随模式返回一次快照，包括当时已存在的 streaming 内容及状态；该快照不是未来最终答案。
- 非跟随完整列表在准备完毕后一次发布；分页失败不得打印半个成功列表。跟随可渐进输出，完整性由 terminal 判定。

### 取消与压缩

- `cancel` 先查详情，子会话在本地拒绝，不发取消 POST。主会话调用现有取消接口；空闲时按 API 返回成功展示当前状态，不伪造一个已取消的 Run。
- 取消成功输出 `{workspaceId,sessionId,requested:true,status}`，status 来自返回 runState；不承诺外部进程已经同步停止，不输出不存在的取消目标 runId。
- `compact` 先查主会话/空闲与可用 Agent，生成与发送不共用的请求 ID；后端最终处理冲突。只读预查不能消除并发竞争。
- 默认输出压缩受理信息及 `scheduled/skippedReason`，不得将 `scheduled=true` 翻译为“排在运行任务后面”。空会话 400/`AGENT_COMPACTION_EMPTY` 明确失败，不能改成无 Run 的虚假受理成功。
- 去重响应 `scheduled=false/skippedReason=deduplicated` 表示沿用旧执行，不是“无需压缩”；如果有可信同请求身份则 `-f` 跟随原 Run。
- `compaction_not_needed/no_progress/oversized_tail/media_requires_resend` 等完成码清晰展示未改变原因，完成状态退出 0；failed 状态仍退出 8，不因 code 字面含 compact 而改成成功。

### 下载

- `--path` 是远端工作区相对路径，必须显式非空；`.` 明确表示整个工作区。`--output` 是本地文件目标，下载目录也指定 ZIP 文件目标；本地父目录须已存在，不自动创建目录树。
- CLI 拒绝 POSIX/Windows/UNC 绝对路径、驱动器前缀、控制字符、任意 `..` 分段，以及后端现有不接受的起始 `-`/`:`。远端只接受 `/` 分隔；不做 percent-decode 或默默折叠危险路径。URLSearchParams 仅编码一次，`%2e%2e` 不被客户端预解码成 `..`。
- 后端已有 `.git` 禁止规则保持，CLI 可提前同样拒绝该分段，但不能以“已检查无软链”作保证。
- `--output` 不接受目录、已存在文件或符号链接；不得提供自动覆盖。Content-Disposition 仅作响应信息，不作为本地路径来源。
- 成功 summary：`workspaceId/path/output/format/bytes/published`；`format=file|zip`，`published=true` 仅在完整接收且无覆盖发布完成后成立。stdout 不输出二进制。
- 下载失败、截断、超时、中断、HTTP 错误或本地发布冲突不输出成功摘要；临时文件与清理见技术设计。下载时目录变化不保证快照一致性。

## 跟随契约

- 对 send/compact：成功受理后先输出 metadata，再读取消息；即使 Run 极快结束也不可省略 metadata 或最终排干。
- 对 messages：以首次成功读取 run-state 的瞬间选择目标 Run，之后不换目标；初次snapshot只预取历史边界。有活动Run按固定Run跟随；无活动Run先metadata（runId=null），然后执行技术设计规定的有界收尾，不能直接把首快照作为完整成功结果。
- 无活动Run收尾固定首快照历史，扩展来源K0只能由初始head H0本身的原生originSessionId与非空originRunId确定，不得向前找旧Run。发送user的originRunId实际为null，completed状态不证明Run归属；禁止按消息ID、内容、时间戳推断或新增反查API。K0已知时，一次终态确认后刷新并有限分页，补齐该Run追加的最终消息，重新应用原--after/-n；不能只刷新旧ID，也不跟后来Run。
- K0未知本身不构成失败：一次收尾读取后head及原选中范围稳定、消息均已终结时正常成功，包括user-only、纯继承历史和空session。若H0之后出现无法证明与初始head关系的追加，必须OBSERVATION_INCOMPLETE/6、observation_failed/complete=false；不能跨过nullable user认领旧Run后把新回答丢弃，也不能将所有追加归入旧Run。初始选中streaming仍须逐个按可证明的原生来源Run确认终态；无法证明完整即失败，不永久等待。
- 只有该范围可证明完整、所选普通消息均非streaming时，才输出历史和no_active_run/complete=true并退出0。所需streaming来源无法定位、不能证明已知Run终态或范围完整时，输出observation_failed/complete=false、退出6；传输/认证失败仍保留既有错误码且complete=false。不轮询等待未来Run，不采用静默期；已完整的idle历史有界读取后立即返回，正常非跟随-n1读取不变，调用模型可在观察失败后重新读取。
- metadata 至少含 `workspaceId/sessionId/runId`；send/compact 含本次显式选择的 `agentId`。messages 无公开可靠 Agent 信息时省略 agentId，不能把当前首个 Agent 当成正在执行的 Agent。
- 整体 follow 时限从 send/compact 收到有效受理响应、或 messages 成功捕获 run-state 时开始，包含后续历史准备/排干，不包含之前本地输入与创建/发送HTTP耗时；这些HTTP各受单请求时限约束。
- JSONL 对消息做完整投影的 `message` upsert：同一 id 的更高 revision 替换已有值，不做文字拼接；初次历史为 `source=history`，随后为 `source=follow`，同一 id 在两阶段重复只能是明确 upsert。
- 人类模式：历史中的已终结消息立即打印正文；streaming 消息先仅打印一次“生成中”标识，不反复打印部分正文，终结时完整打印一次正文。后续新消息同样如此。不得以 TTY 覆盖/ANSI 光标能力作为非交互环境前提。
- 输出过的普通消息在最终分支不可恢复或被 superseded 时，以观察失败结束，不能输出 complete=true。未输出的纯工具/推理行不算丢失普通消息。
- Run 终态后必须补读并校验目标消息已终结、历史/增量无缺页，随后仅一次 terminal。无活动Run初始化的有界收尾同样必须验证最终内容，不允许仅留下生成中标识却complete=true；新Run不得变成本次跟随目标。

## JSON、JSONL 与诊断

### 非跟随

成功 stdout 恰好一个 JSON 对象加换行：

```json
{"schemaVersion":1,"ok":true,"command":"session status","data":{"workspaceId":"w","sessionId":"s","status":"idle"}}
```

- 列表 data 为 `{items:[...],count:N,...必要请求回显}`；messages 另含 `selection` 和 `complete:true`，状态不代表未来不更新。
- show/data 为会话投影；send/compact/data 为受理投影；download/data 为发布 summary；login/data 只含连接初始化/认证模式结果，不含 token/Cookie/配置文件路径。
- 失败 stdout 不输出成功 JSON；stderr 恰好一个结构化 error 对象加换行。已发生副作用的已知标识必须在 error context 中保存，不能因为没有 stdout 成功对象而被隐藏。

### 跟随

stdout 为独立可解析 JSONL，顺序为 metadata、零个或多个 message upsert、一个 terminal：

```jsonl
{"schemaVersion":1,"type":"metadata","command":"session send","workspaceId":"w","sessionId":"s","agentId":"a","runId":"r","clientRequestId":"request","accepted":true}
{"schemaVersion":1,"type":"message","op":"upsert","source":"follow","message":{"id":"m","type":"assistant","status":"completed","originRunId":"r","updatedRevision":9,"parts":[{"type":"text","text":"完成"}]}}
{"schemaVersion":1,"type":"terminal","workspaceId":"w","sessionId":"s","runId":"r","outcome":"run_completed","runStatus":"completed","resultCode":"run_completed","complete":true,"exitCode":0}
```

- 示例 message 为简写，实际消息字段遵循 DTO，不得据示例省略实体身份/顺序字段。
- `outcome` 固定为 `run_completed/run_failed/run_cancelled/no_active_run/observation_failed/interrupted`；`runStatus/resultCode` 在未确认终态时为 null，不能猜测。
- `complete=true` 只表示本次定义范围的历史/目标 Run 最终消息已完整读完；Run 失败或取消仍可 complete=true，并使用非零退出码。
- 监听错误后，若 stdout 可写，terminal 使用 observation_failed/interrupted、complete=false，并在 stderr 输出结构化错误；不能因为已有 metadata 就退出 0。
- SIGKILL/EPIPE 无法保证输出 terminal，调用方必须同时检查进程退出码与 terminal；stdout 关闭时停止读请求，不继续刷日志，不发取消。

### 错误模型

结构化错误固定外壳：

```json
{"schemaVersion":1,"ok":false,"error":{"category":"NETWORK","code":"TRANSPORT_FAILED","message":"请求失败，服务端结果未知。","phase":"send","effect":"unknown","context":{"workspaceId":"w","sessionId":"s","clientRequestId":"request"},"help":"awb session send --help"}}
```

- `phase` 使用 `parse/input/config/discover/create/send/history/follow/status/cancel/compact/download/publish`；`effect` 使用 `not_applicable/not_sent/rejected/accepted/unknown`。
- 仅本地校验或确定尚未 dispatch 才为 not_sent；明确的前置 API 拒绝为 rejected；完整有效受理响应为 accepted；副作用请求发出后超时/断线/5xx/响应无效均保守为 unknown，不能提示“没有执行，可放心重试”。
- context 只含必要、验证过的标识/请求 ID 和必要的本地发布状态，不含输入正文、图片、Cookie、原始错误响应或异常堆栈。创建响应丢失不伪造 sessionID；发送失败保留已知 sessionID。
- 默认人类错误使用同一分类和语义，简短解释 effect，附对应 help；不把未知结果掩盖成普通参数失败。

本地错误分类与稳定 code 固定如下；HTTP status 可作为 error 的可选 `httpStatus`，白名单服务端码作为可选 `serviceCode`，不能覆盖本地 code：

| 退出码 | category | 本地 code |
|---|---|---|
| 2 | USAGE | INPUT_INVALID |
| 3 | CONFIG | CONFIG_INVALID |
| 4 | AUTH | AUTH_REQUIRED |
| 5 | NETWORK | TRANSPORT_FAILED / REQUEST_TIMEOUT |
| 6 | RESPONSE | HTTP_REJECTED / RESPONSE_INVALID / NO_AVAILABLE_AGENT / AGENT_UNAVAILABLE / ANCHOR_NOT_FOUND / TIMELINE_CHANGED / OBSERVATION_INCOMPLETE |
| 7 | PERSISTENCE | COOKIE_SAVE_FAILED / LOCAL_IO_FAILED / OUTPUT_EXISTS / PUBLISH_UNSUPPORTED |
| 8 | RUN_FAILED | RUN_FAILED |
| 9 | RUN_CANCELLED | RUN_CANCELLED |
| 10 | FOLLOW_TIMEOUT | FOLLOW_TIMEOUT |
| 130、143 | INTERRUPTED | INTERRUPTED |
| 141 | OUTPUT | OUTPUT_CLOSED |

- `serviceCode` 只允许当前公开契约/本地显式登记的业务码，例如 AGENT_COMPACTION_EMPTY、AGENT_WORKER_UNAVAILABLE、AGENT_SUBTASK_READONLY、SESSION_RUNNING；不得因为字符串符合大写格式就回显。Run 的 resultCode 另按 shared 公开终态注册表验证。
- 输出阶段的异常若无法确认更细的类别，使用安全的 RESPONSE_INVALID/6，不透传异常；已发布下载文件的状态和已受理副作用不能因此被改写。

## 退出码

| 码 | 意义 |
|---|---|
| 0 | 查询/下载/登录成功，或发送/压缩已受理；跟随时为完成态或 no_active_run。idle、受理、压缩未改变均不等价于正常任务成功回答 |
| 2 | 参数、本地输入或 CLI 主/子操作边界错误 |
| 3 | 本地连接配置读取/结构错误，保留现有分类 |
| 4 | 认证失败，401；不自动登录 |
| 5 | 网络、响应体传输或单请求超时；副作用可能结果未知 |
| 6 | HTTP 业务拒绝/契约异常，包括 404、409 busy、503、未知锚点、不可恢复改链；保留现有 RESPONSE 大类 |
| 7 | Cookie 保存或本地下载临时/发布持久化失败；保留 PERSISTENCE 分类 |
| 8 | 跟随确认目标 Run failed |
| 9 | 跟随确认目标 Run cancelled |
| 10 | 显式整体 follow 时限耗尽，后台结果未确认；不是取消 |
| 130 | SIGINT 结束本次调用，不取消后台 |
| 141 | stdout EPIPE，输出不完整，不取消后台 |
| 143 | SIGTERM 结束本次调用，不取消后台 |

- 如果终态已知但最后补读失败，优先返回观察失败码，而不是 0/8/9；终态与消息完整性分别表达。
- HTTP 错误时只回显白名单业务 code 与本地消息，不透传任意 response.message/code。部分旧路径没有 code，需结合 status 和操作阶段。
- Cookie 续签保存失败不得报告业务成功；若副作用已由有效响应确认，effect=accepted、保留已知标识，提示仅本地保存失败，不建议重发业务请求。
