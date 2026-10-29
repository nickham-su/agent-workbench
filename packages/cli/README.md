# AWB CLI

独立的 Node.js HTTP 客户端（运行要求 Node.js 22+，本仓库使用 Node.js 24 开发与验证），不读取 API 数据库，也不依赖 Worker 注入身份。提供分层命令帮助、安全登录、工作区/Agent发现、主会话发送和主/子会话消息查询；默认可读文本，`--json` 返回机器可读结果。支持固定一次 Run 的有限跟随、主会话取消及手动压缩；支持工作区文件和目录 ZIP 的流式无覆盖下载。

## 本地安装

在仓库根目录执行：

```bash
npm run build -w packages/shared
npm run build -w packages/cli
npm link -w packages/cli
awb --help
```

`npm link` 使用当前 npm 全局 prefix。请先确认该目录可写；遇到 `EACCES`／`EPERM` 时选择用户可写的 prefix，并把其 `bin` 加入 PATH，不要求或自动执行 sudo。link 指向当前 checkout 的 `dist/cli.cjs`，源码修改后需要重新构建。

安装程序和登录是两件事：不同主机、容器、系统用户或 HOME 应分别登录，不会自动共享凭证。

## 使用

```bash
awb --help
awb login --help
awb session list --help
awb login --url http://127.0.0.1:4310
awb session list --workspace workspace-id --updated-within 24h
awb workspace list --json
awb agent list -w workspace-id
awb session list -w workspace-id --updated-within 7d --status idle
awb session show -w workspace-id -s session-id --json
awb session status -w workspace-id -s session-id
awb session send -w workspace-id --prompt '请检查项目' --json
awb session send -w workspace-id -s session-id -a agent-id --prompt-file ./request.txt
awb session send -w workspace-id --image ./diagram.png
awb session messages -w workspace-id -s session-id -n 1 --json
awb session messages -w workspace-id -s session-id --after message-id
awb session send -w workspace-id --prompt '请检查项目' -f --follow-timeout 10m --json
awb session messages -w workspace-id -s session-id -n 1 -f
awb session cancel -w workspace-id -s session-id
awb session compact -w workspace-id -s session-id -f
awb file download -w workspace-id --path reports --output ./reports.zip --json
```

开启认证时，`login` 默认从终端隐藏读取 token；非交互环境可用安全输入提供方通过管道配合 `--token-stdin`。不要把 token 放进命令参数、任务文本、日志或 shell 历史。关闭认证时，无需终端或 token，初始化不读取 stdin。

- URL 只接受 HTTP(S) origin，不支持代理子路径、用户口令、query 或 fragment。
- Workspace 和最近更新时间窗口必须显式提供；窗口为正整数 `s/m/h/d`，最多90天。
- 列表仅查主会话（包含 Fork 主会话），默认 `kind=primary`。`--kind primary` 是弃用兼容写法；`--kind subtask/all` 本地退出2且不联网，属于有意收缩旧CLI行为。已知子会话仍可用 show/status读取，不改原API。
- 列表的 `--status` 为 `idle/running/all`，缺省 `all`；`session status` 返回当前忙闲状态 `idle/running`。
- `-w/--workspace`、`-s/--session` 同义；同一单值参数不能重复，包括短长别名。ID不猜UUID，但禁止空白边界和控制字符，路径段拒绝字面点段。
- `--json`、`--timeout` 可放在根、组或动作位置；单请求完整body时限默认30s，范围1s..24h，所有请求零自动重试。所有层级 `--help/-h` 都离线且无副作用。
- 每条展示本 Session 的创建时间和最近更新时间（UTC ISO）；Fork 展示自身创建时间。窗口仍仅按更新时间筛选，创建时间不参与筛选、排序或计数。
- 计数是本 Session 原生累计 completed user／assistant，不是窗口内增量，不包含 Fork 继承历史，不读取正文。
- 查询只展示数量，不自动排除名称或低计数会话。

连接配置位于 `~/.config/awb/config.json`，仅保存一个服务器地址及 Cookie，不保存登录 token；POSIX目录0700、文件0600。同一系统用户、HOME和文件系统的终端及Worker可以共用配置。有效续签会在业务输出前原子保存；401仅提示重新登录，不自动交互或重试。

### 发送与消息快照

正常输出直接展示结果和标识，帮助说明用途、参数及必要操作规则。`agent list` 列出当前工作区的可选 Agent；`send/compact` 默认返回受理信息，使用 `-f` 等待执行结果。实际失败时输出已确认原因、操作阶段及已知身份。

- `send` 仅主会话可写，省略 `-s` 时创建一次再发送一次。默认 Agent 始终为当前工作区可用 user 列表第一个，包括继续已有会话；显式 `-a` 须在列表中。首个 Agent 配置错误不换第二个。
- `--prompt`、`--prompt-file`、`--stdin` 最多一个；只有 `--stdin` 读取标准输入到 EOF，TTY 拒绝。至少有非空白文本或有效图片，可发送纯图。提示词 UTF-8 允许移除开头一个 BOM，文件必须为可读普通文件（显式本地软链到普通文件可用），文本源最多 1 MiB。
- 图片按实际签名支持 PNG/JPEG/WebP，最多 4 张、单张 10 MiB、总计 20 MiB；重复文件累计。上传使用预检时持有的字节，仅带 basename 和检测 MIME，不重读原路径。
- 纯文本最终 JSON 体最多 1 MiB，有图片的 multipart payload JSON 最多 64 KiB；按序列化 UTF-8 字节检查，创建前完成最终检查。multipart boundary 由 Fetch 生成。
- `send` 默认受理后返回 `workspaceId/sessionId/agentId/messageId/runId/clientRequestId/sessionCreated/accepted/deduplicated`，使用 `-f` 等待执行结果。创建失败、超时或响应丢失立即失败且不发送，可能遗留空会话；创建后发送失败不重建。所有请求零自动重试，不排队、不切 Agent、不取消/删除远端资源。
- 已受理后续签保存失败仍退出 7，错误保留已确认身份和 `effect=accepted`；发送断线为结果未知，不应自动重发。无法证明原 Agent 的意外去重响应明确失败，不伪造 Agent 身份。
- `messages` 支持主/子会话，`--after` 与 `-n/--last` 恰选一个；`-n` 为无前导零的正安全整数。after 锚点可为普通、工具或压缩消息，必须在当前可见分支，排除锚点本身；找不到不会退化为全历史。
- 普通消息只投影 user/assistant 的 text/image，过滤纯工具、纯推理、system/runtime/compaction 和 superseded。按 depth 正序，正文完整；`-n 1` 返回最近一条普通消息。非跟随查询保留消息当时的 `streaming/completed/failed/cancelled` 状态。
- 消息 JSON data 含 `selection/items/count/complete:true` 及工作区/会话 ID；完整分页成功后才一次输出，失败不输出半个成功列表。human 正文保留正常换行但转义终端控制字符，JSON 保留业务原文。`-f` 使用下述有限跟随规则，不等待未来 Run。

API 与 CLI 应同步升级，默认 Docker 镜像会一起构建发布。创建时间是响应必填字段；包含条目的新旧版本响应可能因严格字段校验退出6，未提供兼容模式。本地仅更新源码后需重新构建 API、shared 与CLI产物。

## Docker 安装

镜像构建时生成 CommonJS单文件。运行程序是 `/opt/awb-cli/cli.cjs`，全局入口是 `/usr/local/bin/awb`；两者可由 `dev` 用户执行。程序不放在 `/home/dev`，避免持久化home卷遮蔽程序或遗留旧版本。配置仍在用户HOME，重建镜像无需清除该卷。

在容器内置终端登录后，Worker的 `bash -lc` 应能通过PATH发现 `awb` 并读取同一用户缓存。宿主机登录不等于容器已登录。

## 构建与测试

```bash
npm run build
npm run typecheck
npm test -w packages/cli
# 真实 Worker 门禁需先有 shared、CLI 和 Worker 构建产物。
npm run test:integration:worker -w apps/api
```

CLI测试会把单个产物复制到项目临时隔离目录，在新Node进程中清除 `NODE_OPTIONS/NODE_PATH`，并禁止非Node builtin模块解析，实际运行所有层级 help/version，并通过本地 HTTP 实际执行登录、multipart 图片发送和流式下载。这验证依赖闭包，但项目内隔离不冒称独立容器验收。

当前开发环境未提供Docker／Podman。Docker安装定义可静态检查，实际镜像构建、dev用户PATH、挂载home卷及重建后缓存保留，仍需在具备Docker的环境执行。测试中的PTY和真实API-managed Worker验证宿主环境共享缓存，不替代Docker或Web终端人工验收。

## 输出和退出码

业务结果只写stdout，诊断只写stderr。正常成功输出保持完整背压；仅最终失败诊断采用内部固定250ms的best-effort预算，stderr满或不读时可能截断/缺失，但不会改变原退出码或递归诊断。非零退出时不会让stdout/stderr残留阻止退出，调用方必须检查进程退出码。非跟随 `--json` 成功恰好一个 `{schemaVersion:1,ok:true,command,data}` 对象；跟随使用 metadata/message/terminal JSONL，已输出的事件不会因后续失败撤回。非跟随失败stdout空，所有失败的诊断在stderr可写时为一个 `{schemaVersion:1,ok:false,error}` 对象，error包含category/code/message/phase/effect/context/help。登录结果不含Cookie/token/配置路径，发现只投影必要字段。人类元信息转义终端控制字符，JSON解析后保持业务原文。

退出码：0查询/登录成功（busy也可成功查询），2参数／输入错误，3缓存读取／结构错误，4认证失败，5网络或完整body传输失败，6HTTP／响应契约错误，7缓存或下载本地持久化失败，141输出管道关闭。跟随退出码8为Run失败、9为Run取消、10为整体超时、130/143为SIGINT/SIGTERM，详见[设计契约](../../docs/design/awb-cli-agent/02-cli-contract.md)。

正常查询以 `查询结束：已输出 N 个 Session。` 结尾。通过工具链采集较大结果时，结合超限标识和结束标记判断是否完整；预览、artifact及bash仍使用各自的现有限额，CLI保持显式查询方式。

## 有限跟随与会话控制

- `send/messages/compact` 支持 `-f/--follow`；`--follow-timeout` 仅与 `-f` 同用，正整数 `s/m/h/d`、`1s..90d`，默认整体不限。每个请求仍受 `--timeout`（默认30s）限制，失败零自动重试。
- send 固定受理的 Run，compact 固定本次压缩 Run；messages 先预取历史再捕获活动 Run，之后不切换目标。Run 终态后仍会补读排干，再退出，不等待下一任务。`--after/-n` 只约束初始历史，不限制随后目标 Run 的普通消息。
- messages 捕获 idle 时只做一次有界收尾，不永久等待未来任务。可信来源只取初始 head 本身：user 的 `originRunId` 可能为 null，不能跳过新 user 去猜旧 Run。未知来源而范围稳定的 user-only／继承／空历史可成功；初始化期间有无法证明归属的追加则 `OBSERVATION_INCOMPLETE/6`，可由调用者重新读取，不会自动重试。
- JSON 跟随输出 JSONL，顺序为 metadata、零到多条 message upsert、唯一 terminal。按 `message.id` 和 `updatedRevision` 取最高版本完整替换，不能拼接正文。human 模式 streaming 只输出一次“生成中”，终结正文完整显示一次。推理、工具事件与压缩消息不输出。
- terminal 的 `complete` 表示消息范围是否读完，和 Run 是否成功独立：`run_completed/0`、`run_failed/8`、`run_cancelled/9` 均可 `complete=true`；`no_active_run/0` 表示查询捕获时没有活动Run。观察失败时 `complete=false`，认证4、传输或单请求超时5、契约/分支失效6、本地续签保存7、整体监听超时10优先于已知 Run 结果。
- SIGINT/SIGTERM 分别130/143、stdout EPIPE为141，只停止本地请求/监听，绝不自动调用 cancel。stdout关闭或SIGKILL无法保证terminal，调用方须同时检查进程退出码。
- `session cancel` 仅允许主会话，取消服务端处理请求时的当前执行及其活动后代，不回滚已写文件、不删除历史。正常输出“取消请求已处理”及返回的会话状态；空闲会话同样按实际状态展示。
- `session compact` 仅空闲主会话，默认首个 user Agent，不公开 `-a`；busy冲突不排队。默认只返回受理，`-f` 从 Run 终态区分完成、无需压缩/无进展/尾部过大/需重发媒体和失败；空会话保留 `AGENT_COMPACTION_EMPTY` 错误。压缩不删除原始历史或工作区文件。
- 每次发送/压缩使用独立随机请求 ID，不跨调用恢复。无法证明原 Agent 的意外去重会保留可信身份并失败，不假造成功或把去重当成无需压缩。


## 文件与目录下载

- `awb file download -w <ID> --path <相对路径> --output <本地文件>`；`.` 显式表示整个工作区。目录由服务器生成 ZIP，不需要 CLI 安装压缩工具，输出仍指定一个文件。
- 远端路径仅接受 `/` 分隔的相对路径，拒绝绝对路径、盘符、UNC、反斜杠、控制字符、`..` 分段及起始 `-`/`:`；不预解码 `%2e%2e`。本地输出父目录必须已存在，不自动创建目录树，不信任 Content-Disposition 作为路径。
- 默认拒绝覆盖文件、目录或 dangling symlink。完整响应流写入同目录随机独占 `0600` 临时文件，按背压写入并验证 Content-Length（如有），sync/close 后以 hard link 原子无覆盖发布；目标并发出现则失败，不使用可能覆盖的 rename/copy 降级。文件系统不支持可靠发布时 `PUBLISH_UNSUPPORTED/7`。
- 成功只输出 summary：`workspaceId/path/output/format/bytes/published`，JSON 仍为单对象；二进制从不进入 stdout。HTTP 错误页、截断、超时、写盘或发布失败不发布半成品。失败只清理本次临时文件；发布后清理或输出失败仍保留完整目标，并在错误 context 中标记 `published=true`。不要因非零退出码就假定目标不存在。
- SIGINT/SIGTERM/EPIPE 仅停止本地传输／输出。SIGKILL/掉电可能遗留随机临时文件，CLI 不自动扫描删除其他调用的遗留文件。
- 现有服务器目录规则保持：源文件合计最多 100 MiB，遇 `.git` 或扫描到软链整次失败，空目录不保留。服务端路径校验与源目录变化等技术边界见[独立安全事项及已知功能限制](../../docs/design/awb-cli-agent/06-decisions-and-references.md#独立安全事项)。

## 本次实施与验证

详见[实施与验收追踪](../../docs/design/awb-cli-agent/07-implementation-and-validation.md)。Node24 测试、Node22 构建目标与 Node22 实机验证是不同证据；未提供的 Node22/Docker 环境不冒称已验。公开 API smoke 使用项目内隔离数据库／工作区／HOME、真实 TCP 和受控本地 Provider，绝不读取实际部署配置或运行数据。
