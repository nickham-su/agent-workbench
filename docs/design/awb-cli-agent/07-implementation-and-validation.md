# 实施与验收追踪

## 状态与证据边界

- 日期：2026-10-29；运行环境 Node v24.22.1 / Linux。四阶段代码均已接通，阶段一至三已由独立代码审查者通过；**阶段四已由原审查者复审通过，阶段四M1/D1关闭；原全面审查者最终复审通过，全面审查H1/M1/M2/M3/L1与L2全部Resolved，无新增问题，可交付；未验环境及保留风险不变**。
- 原7份设计文档的独立审查通过只代表设计基线；本文件登记实际运行证据，不将其等同于全部目标平台已验收。
- CLI 产品代码只在 `packages/cli`；API 目录仅最小更新既有 CLI 查询集成测试和新增公开 API smoke，未修改 API/shared/Worker 产品逻辑或依赖/lockfile。准确 Git 范围由首席助理暂存前复核；本阶段作者未执行任何 Git。
- 每一条验收标识均在下表登记，共100个不重复标识。`已验` 指下列 Node24 自动化套件中的明确断言，不是每个场景都运行了真实模型；确定性竞态以受控 HTTP 验证，真实公开 API smoke 为补充。组合用例覆盖多行时不重复增加测试数量。

## 分阶段开发与审查

| 阶段 | 覆盖任务 | 作者自测 | 独立代码审查 |
|---|---|---|---|
| 一 | T-BASE / T-HTTP / T-READ | CLI 76/76；既有 API CLI 查询2/2；shared build、CLI typecheck/build通过 | 通过；审查者另跑45项定向测试和CLI类型检查 |
| 二 | T-SEND / T-HISTORY | CLI99/99；阶段二23/23；CLI typecheck/build通过 | 通过；审查者另跑18项定向测试和CLI类型检查 |
| 三 | T-FOLLOW / T-CONTROL | CLI134/134；CLI typecheck/build通过 | 通过；审查者另跑35项定向测试和CLI类型检查 |
| 四 | T-DOWNLOAD / T-DELIVERY | 首审前CLI150/150、API6/6；阶段四M1修复后CLI153/153、CLI typecheck/build通过、相关API6/6通过；此前全仓typecheck和下述构建通过 | 原审查者复审通过；阶段四M1/D1关闭，当次无新增H/M/L；独立验证17项通过、CLI typecheck通过、100个验收ID一致；原全面五项与L2全部Resolved，原全面审查者最终复审通过，无新增问题，可交付 |

## 全面五项修复时执行命令（L2轮命令见后文）

所有命令在仓库根执行。测试日志位于项目内忽略目录 `.tmp-tests/`，没有包含真实登录、模型凭证或运行数据。

```bash
npm run build -w packages/shared
npm run build -w apps/agent-worker
npm run build -w apps/api
npm run build -w plugins/feishu
npm run typecheck
# 全面五项修复时完整门禁（含阶段四M1回归）：
npm run typecheck -w packages/cli
TSX_DISABLE_CACHE=1 npm test -w packages/cli
npm run build -w packages/cli
# 使用项目内隔离HOME/TMPDIR，避免Worker及CLI读取实际HOME：
HOME="$PWD/.tmp-tests/stage4-home" USERPROFILE="$PWD/.tmp-tests/stage4-home" \
TMPDIR="$PWD/.tmp-tests/stage4-home" TSX_DISABLE_CACHE=1 \
node --import tsx --test --test-concurrency=1 \
apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts \
apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts \
apps/api/src/modules/agent/read-side/sqlite-session-activity-query.test.ts \
apps/api/src/modules/agent/read-side/session-activity-query.test.ts \
apps/api/src/modules/agent/integration/agent-session-activity-query.integration.test.ts
```

- 全面五项修复时作者CLI：161项，失败/取消/跳过均0；阶段四M1修复时的153项为此前历史，不累加；含真实SIGINT/SIGTERM/EPIPE/SIGKILL、背压、文件故障与单文件产物调用。
- 全面五项修复时相关API：9项，失败/取消/跳过均0；CLI查询3项（原2项+集合1项）、公开API smoke6项（原4项+取消状态转移2项）。真实API-managed Worker连接本地受控OpenAI Responses Provider，全部数据位于项目内独立fixture；CLI只调用公开API，Worker自身内部调用不等同于CLI越过控制面。
- 全面五项修复时参照测试23项：SQLite activity query 13项、HTTP activity query 6项、纯参数契约4项。与上述API9项合并执行为32/32，失败/取消/跳过0；23项不与9项重复计数，也不再额外累加其中的13项。
- 全面五项修复时 `npm run typecheck`：shared构建及CLI/Worker/API/Feishu/Web全部通过；CLI独立typecheck/build通过。shared/Worker/API/Feishu此前分包构建通过，未冒称本轮重跑这些全部分包构建。
- 全仓 `npm run build` **未执行**：Web Vite配置会主动 `loadEnv(mode, repoRoot, "")` 并读取根 `.env.local`，与本轮禁止读取真实配置冲突；没有为了构建复制/读取该文件。此项不以分包构建冒称全仓build通过。
- 全仓 `npm test` 未执行，避免无关环境/凭证副作用；本次执行全部CLI及受影响API集成，不以全仓类型检查替代业务测试。
- 首审前运行日志：`.tmp-tests/cli-agent-stage4-test.log`、`cli-agent-stage4-api-test.log`、`cli-agent-stage4-typecheck.log`、`cli-agent-stage4-build.log`。阶段四M1修复后CLI日志：`.tmp-tests/cli-agent-stage4-m1-typecheck.log`、`cli-agent-stage4-m1-test.log`、`cli-agent-stage4-m1-build.log`；API复跑日志为`.tmp-tests/cli-agent-stage4-m1-api-test.log`。日志不是版本化交付物，以下测试文件与命令可重现。

- 全面五项修复时作者另以相同esbuild参数执行`write:false`内存构建，当时产物与`packages/cli/dist/cli.cjs`逐字节一致（471473 bytes）；此为修复后作者复核，不冒称独立复审。日志：`.tmp-tests/cli-agent-final-artifact.log`。
- 全面五项修复时作者日志：`.tmp-tests/cli-agent-final-typecheck.log`、`cli-agent-final-typecheck-cli.log`、`cli-agent-final-test.log`、`cli-agent-final-build.log`、`cli-agent-final-api-reference.log`；全部为作者运行，非独立复审结果。

## 公开API smoke的实际覆盖

| 用例 | 实际行为与断言 |
|---|---|
| `A-REGRESSION-API: real managed Worker...` | 真实TCP与构建CLI、独立登录、发现窄投影、自动创建文本发送并跟随、纯图发送、真实read工具-only再转文本、-n1、idle、压缩终态及原历史保留、文件字节与目录ZIP解压、内部入口无身份被拒绝；CLI请求不含内部/设置/事件接口 |
| `A-CONTROL-CANCEL-TREE...` | 只seed初始主/子/孙活动树及已完成子；CLI主取消后用公开状态/Run接口观察所有活动层终态cancelled、已完成子不变；已写文件保留；子会话show/status/messages可读、cancel本地拒绝 |
| `A-DOWNLOAD-LIMITS/TYPES...` | 真实100MiB目录下载、100MiB+1拒绝、.git/扫描软链整体失败、空ZIP无伪造目录项；软链fixture只指向同一项目内fixture，不进行外部边界利用验证 |
| `全面审查M3: real API cancel uses new current Run...` | 在真实CLI metadata预查响应完成后，fixture受控收敛旧Run并建立同Session新Run和新子Run；真实cancel只取消处理时新树，旧Run保持completed、旧树活动子Run保持running；POST仅workspaceId且一次 |
| `全面审查M3: real API idle-root cancel...` | 根idle、历史已完成Run仍关联活动子/孙Run；真实CLI cancel不扩大取消，公开Run/state仍为running。验证公开行为，不以此声称统计了内部SQL扫描次数 |
| `全面审查L1: production CLI includes hidden...` | 真实SQLite/HTTP/CLI查询恰含source、隐藏primary、headless空primary和primary Fork；排除subtask与另一Workspace，Fork继承消息不计为自身原生消息，Fork创建时间取自身 |
| `A-MESSAGES-PAGES/SUBTASK...` | seed525条稀疏真实消息，仅6条普通消息；CLI多页非跟随及idle有限跟随均得到完整正序结果，不输出推理正文 |

极快完成、终态瞬间下一Run、reset/分支变化等精确竞态以CLI受控HTTP套件验证；真实Provider smoke不依赖模型/调度碰巧命中竞态，不能将两种证据混为一谈。

## 100项验收追踪

文件链接均为项目内源码；测试名是实际注册名（动态human/JSON场景以模板显示）。`已验`为实际运行套件中有对应断言，平台边界见末节。

| 验收标识 | 实际测试文件与测试名 | 结果/补充 |
|---|---|---|
| `A-HELP-LAYERS` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-HELP-LAYERS/PRIORITY/JSON: all connected commands help before invalid values and config` | 已验 |
| `A-HELP-PRIORITY` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-HELP-LAYERS/PRIORITY/JSON: all connected commands help before invalid values and config` | 已验 |
| `A-HELP-JSON` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-HELP-LAYERS/PRIORITY/JSON: all connected commands help before invalid values and config` | 已验 |
| `A-HELP-ERROR` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-HELP-ERROR: unknown commands remain errors even with help, and use exact known help path` | 已验 |
| `A-PARSE-ALIASES` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-PARSE-ALIASES: equivalent aliases/global option positions and duplicate rejection before IO` | 已验 |
| `A-PARSE-VALUES` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`grammar scanner consumes text option values rather than finding phantom flags; images may repeat`；`全面审查M1: invalid root timeout precedes stdin/config/HTTP and known help still wins` | 已验；非法根timeout在stdin/config/HTTP之前失败，已知help仍优先 |
| `A-PARSE-ID` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-PARSE-ID/DOT and A-COMPAT-KIND: invalid identifiers/kinds never load config or network` | 已验 |
| `A-PARSE-ID-DOT` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-PARSE-ID/DOT and A-COMPAT-KIND: invalid identifiers/kinds never load config or network` | 已验 |
| `A-PARSE-ID-ENCODING` | [http-boundaries.test.ts](../../../packages/cli/tests/http-boundaries.test.ts)：`A-PARSE-ID-ENCODING: opaque path IDs encode once without normalization or route injection` | 已验 |
| `A-COMPAT-KIND` | [arguments.test.ts](../../../packages/cli/tests/arguments.test.ts)：`A-PARSE-ID/DOT and A-COMPAT-KIND: invalid identifiers/kinds never load config or network` | 已验 |
| `A-DISCOVER-WORKSPACE` | [discovery.test.ts](../../../packages/cli/tests/discovery.test.ts)：`A-DISCOVER-WORKSPACE: stable code-point sorting, narrow projections and empty lists` | 已验 |
| `A-DISCOVER-AGENT` | [discovery.test.ts](../../../packages/cli/tests/discovery.test.ts)：`A-DISCOVER-AGENT: config order, minimal fields, empty success and one shared selection rule` | 已验 |
| `A-DISCOVER-NONE` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-DISCOVER-NONE/BAD-FIRST: no Agent or unavailable explicit ID creates nothing; bad first never switches` | 已验 |
| `A-DISCOVER-BAD-FIRST` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-DISCOVER-NONE/BAD-FIRST: no Agent or unavailable explicit ID creates nothing; bad first never switches` | 已验 |
| `A-SESSIONS-WINDOW` | [session-query.test.ts](../../../packages/cli/tests/session-query.test.ts)：`strict duration converts supported units and exact 90-day boundaries without a client clock` | 已验 |
| `A-SESSIONS-SCOPE` | [agent-cli-session-query.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts)：`全面审查L1: production CLI includes hidden, headless and primary Fork sessions but excludes subtask/foreign workspace`；权威集合SQL：[sqlite-session-activity-query.ts](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts)；后端分层证据见下文“全面审查L1分层证据” | 真实SQLite/HTTP/CLI集合已验；DTO测试仅证明结构校验，不作为SQL集合证据 |
| `A-SESSIONS-STATUS` | [session-query.test.ts](../../../packages/cli/tests/session-query.test.ts)：`DTO accepts empty/all data, boundary timestamps, safe count maxima and every filter pair` | 已验 |
| `A-SESSIONS-VALIDATION` | [session-query.test.ts](../../../packages/cli/tests/session-query.test.ts)：`DTO rejects corrupt items, duplicate IDs, unsafe counts and mismatched filters/boundaries` | 已验 |
| `A-SESSIONS-SHOW` | [discovery.test.ts](../../../packages/cli/tests/discovery.test.ts)：`A-SESSIONS-SHOW: primary/subtask metadata, fork provenance and no window requirement` | 已验 |
| `A-SEND-INPUT-MODES` | [input.test.ts](../../../packages/cli/tests/input.test.ts)：`A-SEND-INPUT-MODES/UTF8: explicit sources, one BOM, fatal decoding, regular files and stdin TTY` | 已验 |
| `A-SEND-UTF8` | [input.test.ts](../../../packages/cli/tests/input.test.ts)：`A-SEND-INPUT-MODES/UTF8: explicit sources, one BOM, fatal decoding, regular files and stdin TTY` | 已验 |
| `A-SEND-TEXT-LIMIT` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-TEXT-LIMIT: exact JSON/multipart payload bytes are sent, +1 creates nothing` | 已验 |
| `A-SEND-IMAGE-LIMIT` | [input.test.ts](../../../packages/cli/tests/input.test.ts)：`A-SEND-IMAGE-LIMIT/SIGNATURE: count, per-image, total bytes, repeated files and detected MIME` | 已验 |
| `A-SEND-IMAGE-SIGNATURE` | [input.test.ts](../../../packages/cli/tests/input.test.ts)：`A-SEND-IMAGE-LIMIT/SIGNATURE: count, per-image, total bytes, repeated files and detected MIME` | 已验 |
| `A-SEND-MULTIPART` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-MULTIPART: real TCP Fetch boundary, pure-image empty text and ordered byte upload` | 已验 |
| `A-SEND-EXISTING` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-EXISTING/SUBTASK/BUSY: primary writes once, explicit Agent verified, child rejected and 409 never queued` | 已验 |
| `A-SEND-SUBTASK` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-EXISTING/SUBTASK/BUSY: primary writes once, explicit Agent verified, child rejected and 409 never queued` | 已验 |
| `A-SEND-BUSY` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-EXISTING/SUBTASK/BUSY: primary writes once, explicit Agent verified, child rejected and 409 never queued` | 已验 |
| `A-SEND-CREATE` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-CREATE/REQUEST-ID: one create then one send, first Agent is fixed and every call has a fresh UUID` | 已验 |
| `A-UNKNOWN-CREATE` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-UNKNOWN-CREATE/SEND: real TCP server accepted side effect then destroyed response; zero automatic retry/cancel` | 已验 |
| `A-UNKNOWN-REJECT` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-UNKNOWN-REJECT/CREATE: rejected vs unknown create; no retry or later send` | 已验 |
| `A-UNKNOWN-SEND` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-UNKNOWN-SEND: create-success/send-409 or invalid ack preserves confirmed session without recreating` | 已验 |
| `A-UNKNOWN-PERSIST` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-UNKNOWN-PERSIST: valid create/send response identity survives Cookie save failure; later writes stop` | 已验 |
| `A-SEND-REQUEST-ID` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-CREATE/REQUEST-ID: one create then one send, first Agent is fixed and every call has a fresh UUID` | 另见control.test.ts中send/compact交替UUID不复用 |
| `A-SEND-DEDUP-IDENTITY` | [send.test.ts](../../../packages/cli/tests/send.test.ts)：`A-SEND-DEDUP-IDENTITY: unexpected dedup preserves trustworthy IDs but never claims actual Agent` | 已验 |
| `A-MESSAGES-EXCLUSIVE` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-EXCLUSIVE: selectors validate strictly before configuration/network` | 已验 |
| `A-MESSAGES-PROJECTION` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-PROJECTION: strict text/image projection, ordinary counting and origin preservation` | 已验 |
| `A-MESSAGES-AFTER` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-AFTER: any current raw type can anchor; exclusion, order and empty suffix` | 已验 |
| `A-MESSAGES-BAD-ANCHOR` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-AFTER: any current raw type can anchor; exclusion, order and empty suffix` | 已验 |
| `A-MESSAGES-PAGES` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-PAGES: over 500 sparse raw rows use raw cursor and never impose a CLI total page cap` | CLI651条fixture及真实API525条稀疏记录已验 |
| `A-MESSAGES-CURSOR` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-CURSOR: malformed, duplicate, looping, wrong-identity or failed pages publish no partial success` | 已验 |
| `A-MESSAGES-STREAMING` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-STREAMING/LAST/SUBTASK/LONG: real TCP snapshots preserve full body, statuses, inheritance and safe human text` | 已验 |
| `A-MESSAGES-LAST` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-STREAMING/LAST/SUBTASK/LONG: real TCP snapshots preserve full body, statuses, inheritance and safe human text` | 已验 |
| `A-MESSAGES-SUBTASK` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-STREAMING/LAST/SUBTASK/LONG: real TCP snapshots preserve full body, statuses, inheritance and safe human text` | 已验 |
| `A-MESSAGES-LONG` | [messages.test.ts](../../../packages/cli/tests/messages.test.ts)：`A-MESSAGES-STREAMING/LAST/SUBTASK/LONG: real TCP snapshots preserve full body, statuses, inheritance and safe human text` | 已验 |
| `A-FOLLOW-METADATA` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-UPDATES/METADATA: revisions are complete JSONL upserts, human prints one marker and final body once` | 已验 |
| `A-FOLLOW-FAST` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-FAST: accepted send anchors through >500 rows before first polling, all target answers emitted` | 已验 |
| `A-FOLLOW-NO-RUN` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-EMPTY/USER-STABLE/INHERITED-STABLE: bounded success; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-EMPTY` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-EMPTY/USER-STABLE/INHERITED-STABLE: bounded success; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-USER-STABLE` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-EMPTY/USER-STABLE/INHERITED-STABLE: bounded success; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-INHERITED-STABLE` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-EMPTY/USER-STABLE/INHERITED-STABLE: bounded success; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-COMPLETED` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-COMPLETED: native streaming source is checked once, final body replaces prefetch` | 已验 |
| `A-FOLLOW-IDLE-APPEND-SOURCED` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-APPEND-SOURCED: completed text/tool-only H0 grows across pages; reselect last and after` | 已验 |
| `A-FOLLOW-IDLE-APPEND-USER` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-APPEND-USER/OLD-RUN-BARRIER: nullable user never claims older or inferred Run; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-OLD-RUN-BARRIER` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-APPEND-USER/OLD-RUN-BARRIER: nullable user never claims older or inferred Run; json=${json}` | 已验 |
| `A-FOLLOW-IDLE-NEXT` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-NEXT/INCOMPLETE: proven other Run excluded, nullable barrier or interleaved original Run fails` | 已验 |
| `A-FOLLOW-IDLE-UNKNOWN` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-UNKNOWN/INCOMPLETE: unknown streaming, still-running source and empty-to-new cannot succeed` | 已验 |
| `A-FOLLOW-IDLE-INCOMPLETE` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-UNKNOWN/INCOMPLETE: unknown streaming, still-running source and empty-to-new cannot succeed` | 已验 |
| `A-FOLLOW-IDLE-READ-FAIL` | [follow-idle.test.ts](../../../packages/cli/tests/follow-idle.test.ts)：`A-FOLLOW-IDLE-READ-FAIL: one-shot source/body failures preserve transport/auth and lost head is timeline change` | 已验 |
| `A-FOLLOW-INIT-RACE` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-INIT-RACE: selected old streaming history updates even when captured target belongs to next Run` | 已验 |
| `A-FOLLOW-SWITCH` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-SWITCH: later nullable user and other Run messages cannot change fixed target or enter follow` | 已验 |
| `A-FOLLOW-UPDATES` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-UPDATES/METADATA: revisions are complete JSONL upserts, human prints one marker and final body once` | 已验 |
| `A-FOLLOW-TOOLS` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-UPDATES/TOOLS: delta may exceed limit, duplicate revisions deduplicate, tool-only becomes ordinary` | 已验 |
| `A-FOLLOW-RESET` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-RESET: compaction root reset tail rebuilds through initial/history anchors and never advances to before revision` | 已验 |
| `A-FOLLOW-BRANCH` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-BRANCH/INVARIANT: reset lost anchor, superseded output, bad terminal and terminal streaming fail explicitly` | 已验 |
| `A-FOLLOW-DRAIN` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-DRAIN/NETWORK: final read failures override known Run terminal and never retry` | 已验 |
| `A-FOLLOW-TERMINALS` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-TERMINALS/DRAIN: completed/failed/cancelled drain after status, complete and result are independent` | 已验 |
| `A-FOLLOW-INVARIANT` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-BRANCH/INVARIANT: reset lost anchor, superseded output, bad terminal and terminal streaming fail explicitly` | 已验 |
| `A-FOLLOW-NETWORK` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-DRAIN/NETWORK: final read failures override known Run terminal and never retry`；[follow-context.test.ts](../../../packages/cli/tests/follow-context.test.ts)：`全面审查M2: delta, refill and final-drain failures retain the captured messages Run in stderr` | 已验；delta/补页/最终排干网络或401错误保留捕获Run |
| `A-FOLLOW-DEADLINE` | [follow-options.test.ts](../../../packages/cli/tests/follow-options.test.ts)：`A-FOLLOW-DEADLINE: 90d deadline uses bounded timers without overflow and cleans handlers` | 已验 |
| `A-FOLLOW-SIGNALS` | [follow-process.test.ts](../../../packages/cli/tests/follow-process.test.ts)：`A-FOLLOW-SIGNALS: real SIGINT/SIGTERM after accepted send and during final drain return 130/143 without cancel`、`全面审查M2: real messages SIGINT/SIGTERM retain captured Run in stderr after stdout is lost`；[failure-output-process.test.ts](../../../packages/cli/tests/failure-output-process.test.ts)：`全面审查H1: unread full stderr cannot prevent deadline/SIGINT/SIGTERM exit while stdout is consumed` | 真实信号/两管道背压及stderr恢复捕获Run已验；不远端cancel |
| `A-CONTROL-STATUS` | [discovery.test.ts](../../../packages/cli/tests/discovery.test.ts)：`A-CONTROL-STATUS: only busy/idle, no activeRunId, runtime notice or success inference` | 已验 |
| `A-CONTROL-CANCEL-TYPE` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-CONTROL-CANCEL-TYPE/RACE: one primary precheck and one cancel, subtask refuses with zero writes` | 已验 |
| `A-CONTROL-CANCEL-TREE` | [agent-cli-agent.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts)：`A-CONTROL-CANCEL-TREE: CLI cancellation reaches active child/grandchild, leaves completed child and files unchanged; child is read-only` | 已验 |
| `A-CONTROL-CANCEL-RACE` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`全面审查M3: stateful cancel targets processing-time Run after precheck, while idle never scans historical orphans`；[agent-cli-agent.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts)：`全面审查M3: real API cancel uses new current Run after CLI precheck, not the completed old tree`、`全面审查M3: real API idle-root cancel never scans or cancels historical active descendants` | 有状态CLI fixture与真实API公开结果已验；处理时当前Run、一次POST且无expectedRunId、idle不扩大取消；非真实Worker调度竞态或SQL扫描计数 |
| `A-COMPACT-TYPE-BUSY` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-TYPE-BUSY/EMPTY: local boundaries and backend conflict never queue or retry` | 已验 |
| `A-COMPACT-EMPTY` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-TYPE-BUSY/EMPTY: local boundaries and backend conflict never queue or retry` | 已验 |
| `A-COMPACT-ACCEPT` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-ACCEPT/SKIP/FAIL: default exits on acceptance, follow uses run result and unchanged history anchor` | 已验 |
| `A-COMPACT-SKIP` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-ACCEPT/SKIP/FAIL: default exits on acceptance, follow uses run result and unchanged history anchor` | 已验 |
| `A-COMPACT-FAIL` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-ACCEPT/SKIP/FAIL: default exits on acceptance, follow uses run result and unchanged history anchor` | 已验 |
| `A-COMPACT-DEDUP` | [control.test.ts](../../../packages/cli/tests/control.test.ts)：`A-COMPACT-DEDUP: fresh request cannot prove earlier Agent; preserve accepted run instead of faking skip success` | 新随机请求无法证明旧Agent身份时明确失败已验；不新增跨调用恢复能力 |
| `A-DOWNLOAD-PATH` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-PATH: lexical paths reject dangerous syntax locally and preserve percent data once` | 已验 |
| `A-DOWNLOAD-TYPES` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-TYPES/SIZE: file and unknown-length ZIP stream into exclusive temp and publish exact bytes` | 受控流+真实API解压及空目录语义已验 |
| `A-DOWNLOAD-LIMITS` | [agent-cli-agent.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts)：`A-DOWNLOAD-LIMITS/TYPES: real API preserves 100 MiB directory limit, .git/symlink rejection and empty ZIP semantics` | 已验 |
| `A-DOWNLOAD-EXISTING` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-EXISTING: files, directories and dangling symlinks are never replaced` | 已验 |
| `A-DOWNLOAD-HEADERS` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-HEADERS: HTTP JSON/HTML, redirect, successful error page and invalid length never publish` | 已验 |
| `A-DOWNLOAD-TRUNCATE` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-TRUNCATE: length mismatch, broken TCP and full-body timeout leave no partial target` | 已验 |
| `A-DOWNLOAD-PUBLISH` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-PUBLISH: flush/close precede link, cleanup failure retains complete published target and context` | 已验 |
| `A-DOWNLOAD-SIZE` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-SIZE: partial writes are drained before reading next chunk and never buffer the entire body` | 已验 |
| `A-DOWNLOAD-INTERRUPT` | [download-process.test.ts](../../../packages/cli/tests/download-process.test.ts)：`A-DOWNLOAD-INTERRUPT: real SIGINT/SIGTERM clean only owned temp and SIGKILL leftovers are never auto-scanned` | 已验 |
| `A-DOWNLOAD-SOURCE-CHANGE` | [download.test.ts](../../../packages/cli/tests/download.test.ts)：`A-DOWNLOAD-SOURCE-CHANGE: streaming EOF is transport completeness, not a source snapshot guarantee` | 受控流模拟源变化已验；无一致性快照承诺，不宣称真实并发源快照 |
| `A-OUTPUT-JSON` | [discovery.test.ts](../../../packages/cli/tests/discovery.test.ts)：`A-OUTPUT-JSON login modes emit one safe result without loading old credentials` | 已验 |
| `A-OUTPUT-JSONL` | [follow.test.ts](../../../packages/cli/tests/follow.test.ts)：`A-FOLLOW-UPDATES/METADATA: revisions are complete JSONL upserts, human prints one marker and final body once` | 已验 |
| `A-OUTPUT-SAFE` | [http.test.ts](../../../packages/cli/tests/http.test.ts)：`HTTP errors retain stable status/code but never dump body or arbitrary code`；[failure-output.test.ts](../../../packages/cli/tests/failure-output.test.ts)：`全面审查H1: final diagnostic has a fixed budget and late callbacks/errors are safe without leaked handlers`、`全面审查H1: runCli returns the original follow timeout despite an unfinished stderr callback` | 已验；仅最终失败诊断250ms best-effort，不覆盖原错误、不递归；正常输出仍背压完整 |
| `A-OUTPUT-TERMINAL-SAFE` | [output.test.ts](../../../packages/cli/tests/output.test.ts)：`A-OUTPUT-TERMINAL-SAFE: normal body newlines survive, controls escape, JSON/JSONL stay original` | 已验 |
| `A-SECURITY-LOGIN` | [login.test.ts](../../../packages/cli/tests/login.test.ts)：`stdin login sends remember true with no old Cookie, stores Cookie only, and origin replacement is explicit` | 已验 |
| `A-SECURITY-COOKIE` | [session-list.test.ts](../../../packages/cli/tests/session-list.test.ts)：`HTTP main errors precede renewal save/attribute errors, keep safe codes, and never clear cached credentials` | 已验 |
| `A-SECURITY-INTERNAL` | [security-boundary.test.ts](../../../packages/cli/tests/security-boundary.test.ts)：`A-SECURITY-INTERNAL/REGRESSION-API: runtime CLI never imports database/API services or requests internal/settings/event endpoints` | 静态禁止项及真实API请求捕获已验 |
| `A-REGRESSION-BUNDLE` | [bundle.test.ts](../../../packages/cli/tests/bundle.test.ts)：`A-REGRESSION-BUNDLE: builtin-only artifact actually logs in, posts multipart and streams a download` | Node24闭包/实际multipart和stream已验；Node22实机未验 |
| `A-REGRESSION-API` | [agent-cli-agent.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts)：`A-REGRESSION-API: real managed Worker and controlled Provider exercise CLI discovery, send/images/follow/history/compact/download` | 已验 |

## 实施差异与决策理由

- 按依赖拆分为4阶段；未完成动作随所属阶段接通，没有假成功占位。最终命令树与02一致。
- 用户本轮明确授权首席助理逐阶段 `git add`，覆盖05原文档阶段的“不授权暂存”；作者/审查者仍不执行Git，不授权commit/reset等。
- 既有API目录CLI查询回归原先期望默认all和subtask成功，与新primary收缩冲突；仅调整CLI测试预期并保留真实认证/计数/续签验证。新增API smoke属于测试例外，不改后端产品。
- 安装定义测试原先按字面 `RUN npm ci` 匹配不支持现有Docker多行RUN；最小改为定位 `npm ci`，仍检查CLI manifest在安装之前，不改Docker安装逻辑。
- 下载复用FollowLifetime的本地信号/输出中止边界，增加download消息类别；不增加第二套进程信号处理，不引入运行依赖。下载HTTP成功流不全量缓存；仅非2xx错误读取最多首8KiB作白名单code解析。
- 原compact去重契约允许“有可信同请求身份时跟随旧Run”；CLI始终新随机ID且无跨调用恢复状态，异常dedup无法证明旧Agent时保留可信Run并失败，而非伪造实际Agent或“无需压缩”。此安全处理已随阶段三通过。
- 受控Provider起初尝试openai-compatible连续两次Run，真实Worker/API遇 `agent_message_part.id` 唯一约束并停留running。首席助理裁决不扩大本次后端产品范围：独立审查的SDK-only复现中，两次不同请求的`text-start.id`均为`txt-0`；静态位置为`node_modules/@ai-sdk/openai-compatible/dist/index.mjs:590-595`。`apps/agent-worker/src/runtime/runner.ts:2845-2846`仅在adapter启用`scopeStreamPartIds`时作用域化；通用compatible未注册该adapter，SQLite part ID为全局主键。CLI每次随机requestId、零重试，不生成assistant part ID；这些证据支持独立既有后端问题，**但未复跑完整SQLite端到端因果实验**。本开发修复轮仅静态核对SDK固定ID与runner作用域条件，SDK-only双请求结论来自独立审查，未冒称本轮重跑。没有修改Worker/API来掩盖问题；最终smoke采用受控OpenAI Responses且使用唯一响应/item ID，文本/图片/工具/压缩通过，**Responses成功不等于compatible通过**。

## 未验环境与保留风险

| 项目 | 当前结论与原因 |
|---|---|
| Node22实机 | 当前仅Node v24.22.1，PATH无node22；esbuild target=node22和builtin-only闭包通过不替代Node22实际执行。未外部下载/安装 |
| Docker/Podman | 当前PATH均无对应命令；镜像构建、dev用户PATH、home卷/重建缓存保留未验；静态安装测试不冒称容器通过 |
| 真实付费/部署Provider | 未使用真实凭证或外网模型；真实Worker+本地受控Provider已验，不保证所有Provider配置可运行 |
| openai-compatible连续执行 | SDK-only双请求固定txt-0、条件作用域与全局主键线索见上节；未复跑完整SQLite因果链。按首席裁决保留为独立既有后端风险；Responses成功不等于compatible通过，不改Worker/API |
| Web完整生产构建/全仓测试 | 因真实.env.local读取与无关测试安全边界未执行；全仓类型检查和本次范围门禁通过 |
| 下载服务端安全 | 既有realpath/软链TOCTOU和repo根信任条件风险继续保留，没有利用实测外部文件，也未称CLI过滤可修复 |
| 文件系统平台 | 当前Linux文件系统hard-link无覆盖真实测试通过，其他不支持平台明确失败；未验证其他OS的实际硬链接能力 |

## 后续审查登记

- 阶段四首审：未通过；仅阶段四M1必改，其余100项验收ID/测试名链接、no-clobber/cleanup/闭包没有新增问题。阶段四M1处置为Fix，首审状态“待修复”；原作者完成修复、CLI门禁及API回归后，已由原审查者复审通过。
- 阶段四复审：原审查者明确通过，阶段四M1/D1均关闭，当次无新增H/M/L。独立验证17项通过：3项lifetime、12项follow、2项补充真实HTTP/内存FS验证；另通过CLI typecheck，确认100个验收ID一致。此为原审查者独立验证结果，不与作者153项套件累加，也不表示最终全面审查已完成。
- 阶段四D1：依据原审查者复审结论关闭。

### 阶段四M1：中止覆盖不得继承被覆盖错误码（已关闭）

- 原因：`FollowLifetime.failure()`更换退出码和message时继承原`details.code`，可能形成130/INTERRUPTED却携带TRANSPORT_FAILED等不一致诊断。
- 最小修复：[follow-lifetime.ts](../../../packages/cli/src/follow-lifetime.ts)覆盖时采用中止原因自身的可选code；缺省继续由唯一的[errors.ts](../../../packages/cli/src/errors.ts)映射，未新增另一套产品映射。原可信phase/effect/context/help不丢失，不改变已受理、unknown或published=true的真实影响。
- 新增[follow-lifetime.test.ts](../../../packages/cli/tests/follow-lifetime.test.ts)三个实际注册用例：`M1: unstopped lifetime preserves the original error and classification`、`M1: stop reason owns exit/category/code while accepted, unknown-effect and published evidence survives`、`M1: real HTTP partial body abort replaces TRANSPORT_FAILED for all four local stop reasons without cancel`。分别验证未中止时不改错误、四种中止原因覆盖与可信上下文保留、真实HTTP部分body中断后的精确exit/category/code及无cancel。
- 必须保持：130/143 → INTERRUPTED/INTERRUPTED，141 → OUTPUT/OUTPUT_CLOSED，10 → FOLLOW_TIMEOUT/FOLLOW_TIMEOUT（箭头后依次为category/code）。稳定code仍只由errors.ts权威映射。
- 同时增强[follow.test.ts](../../../packages/cli/tests/follow.test.ts)轮询错误与整体/单请求超时区分；[follow-process.test.ts](../../../packages/cli/tests/follow-process.test.ts)真实信号、EPIPE、deadline、POST已发但未完整受理的unknown影响；[download-process.test.ts](../../../packages/cli/tests/download-process.test.ts)真实130/143、发布后141及published=true、完整文件保留、无远端cancel；并在[download.test.ts](../../../packages/cli/tests/download.test.ts)既有发布测试中增加“已发布后清理EIO与中止同时发生”的精确分类回归，证明LOCAL_IO_FAILED被覆盖且完整文件和published=true不丢失。
- 回归：CLI typecheck/test/build通过，153/153、失败/取消/跳过0；相关API6/6通过（既有查询2项、新smoke4项，失败/取消/跳过0）。原审查者已复审通过，阶段四M1关闭，阶段四通过。

## 全面审查首审、复审与最终通过

- 全新独立审查会话：`sess_00mvt9zfn00000c8851968a9c8`。首审未通过；独立运行CLI153/153、API6/6、参照13项，并核对内存build与当时dist逐字节一致。这些是首审者提供的历史独立证据，不是修复后的独立复审，也不与作者新门禁累加。
- 首席裁决原五项均Fix；作者当时完成CLI161/161、API9/9、参照23/23（API与参照合并32/32）、全仓typecheck和CLI build后，已由同一原全面审查会话复审通过。
- 原全面复审独立结果：当时CLI161＋API9＋参照23＝**193/193通过**（历史证据），内存build与复审当时dist逐字节一致，100个验收ID证据无缺；全面审查H1/M1/M2/M3/L1全Resolved。这是前轮历史独立结果，不与作者最终门禁或本轮独立定向测试累加，也不冒称该193项覆盖随后新增的L2。
- 新增非阻断L2按裁决完成最小修复与回归后，原全面审查者最终复审通过；**原H1/M1/M2/M3/L1与L2全部Resolved，无新增问题，全面审查最终通过，可交付**。
- 编号命名空间：“全面审查H1/M1/M2/M3/L1”与设计原H1、阶段四M1是不同问题，不互相覆盖结论。

| 全面审查问题 | 处置与实际证据 | 当前状态 |
|---|---|---|
| H1：最终失败诊断背压导致无法退出 | [output.ts](../../../packages/cli/src/output.ts)仅最终诊断固定250ms best-effort，超时销毁失败诊断流，清理timer/handler，迟到callback安全；[cli.ts](../../../packages/cli/src/cli.ts)原非零码同时处理stdout/stderr残留。正常成功输出仍用背压writeText。上述failure-output两个单测、真实子进程stderr预填满且持续不读的deadline/SIGINT/SIGTERM用例通过；stdout仍消费，退出码10/130/143不变且无cancel/递归诊断 | Resolved，原全面审查者复审通过 |
| M1：非法根timeout晚于stdin读取 | [program.ts](../../../packages/cli/src/program.ts)在根preAction唯一解析timeout，位于已知help短路之后、所有业务输入之前，不提前构造ConfigStore。arguments中全面审查M1用例验证0s/25h/非法值均exit2、stdin读0/config0/HTTP0，help仍exit0 | Resolved，原全面审查者复审通过 |
| M2：messages跟随失败丢失已捕获Run | [follow-output.ts](../../../packages/cli/src/follow-output.ts)补充已验证的非null目标Run，不伪造idle Run；withErrorDetails保留底层更精确category/phase/effect/context。follow-context两个用例覆盖delta/补页/最终排干网络和401、精确底层证据与idle；既有follow/真实process增强timeout、SIGINT/SIGTERM、EPIPE的context断言，stdout丢失后stderr仍恢复目标Run | Resolved，原全面审查者复审通过 |
| M3：取消竞态及idle孤儿证据缺口 | CLI有状态fixture及新增真实API两项状态转移通过；fixture在预查响应后受控完成旧Run、开启新Run，真实API只取消当前新树；idle根的历史活动子/孙不取消。结果仅从公开CLI/API断言，POST只有workspaceId、一次且不伪造expectedRunId；无后端产品变更 | Resolved，原全面审查者复审通过 |
| L1：DTO不能证明真实查询集合 | 新增真实SQLite/HTTP/CLI集合断言，链接权威SQL、后端13项及HTTP参照；下节分层说明，不再以DTO结构测试冒称SQL集合测试 | Resolved，原全面审查者复审通过 |

### 全面审查L2：已关闭stderr的重复诊断监听泄漏（Resolved，原全面审查者最终复审通过）

- 最小产品修复仅在[output.ts](../../../packages/cli/src/output.ts)：进入最终失败诊断时记录`closed`，失败销毁路径对进入时已关闭的流显式cleanup，避免等待不会再次出现的close事件；正在closing的流仍保留必要error/close守卫。正常成功输出的writeText与背压路径未改。
- 新增[failure-output.test.ts](../../../packages/cli/tests/failure-output.test.ts)两个实际注册用例：`全面审查L2: repeated diagnostics on fully closed stderr keep zero listeners and the original CLI error`、`全面审查L2: closing stderr retains its late-error guard, including a pending error with closed already true`。验证已完全关闭流连续三轮直接诊断及runCli调用后error/close监听始终0，有限返回原AUTH_REQUIRED/4且原上下文不变；正在closing时保留迟到error守卫；closed已为true但Node尚未发出排队error/close的窗口也受保护。既有H1迟到callback/error及正常输出背压回归保留并通过。
- 作者最终门禁（L2修复轮）：CLI typecheck/test/build通过，**163/163**，失败/取消/跳过0；相关API **9/9**，失败/取消/跳过0。此前原全面复审独立参照23项证据保留，L2修复轮按裁决不重跑无关后端参照，不把它们计入该轮新执行测试；当时未重跑全仓typecheck，最终元信息收尾已补跑通过，见下节。
- L2轮日志：`.tmp-tests/cli-agent-final-l2-typecheck.log`、`cli-agent-final-l2-test.log`、`cli-agent-final-l2-build.log`、`cli-agent-final-l2-api-test.log`。L2修复轮只改output.ts、对应测试及本07记录，未更改其他产品、测试或README，未执行Git。

```bash
npm run typecheck -w packages/cli
TSX_DISABLE_CACHE=1 npm test -w packages/cli
npm run build -w packages/cli
HOME="$PWD/.tmp-tests/stage4-home" USERPROFILE="$PWD/.tmp-tests/stage4-home" \
TMPDIR="$PWD/.tmp-tests/stage4-home" TSX_DISABLE_CACHE=1 \
node --import tsx --test --test-concurrency=1 \
apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts \
apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts
```

### 全面审查最终通过与证据口径

- 原全面审查者最终复审确认：L2关闭流监听器不累积，closing/queued error安全，失败诊断时限与成功背压无回归；原H1/M1/M2/M3/L1与L2全部Resolved，无新增问题，全面审查最终通过，可交付。
- 作者最终执行结果：CLI **163/163**、相关API **9/9**通过，CLI类型检查及构建通过；不是本轮独立定向测试数。
- 前轮独立 **193/193** 为历史证据（当时CLI161＋API9＋参照23），不冒称最终CLI163套件，也不与作者结果或本轮独立结果累加。
- 本轮独立最终复审：定向测试 **19/19** 通过；CLI类型检查通过；内存构建与dist逐字节一致（**471553 bytes**）；**4组help**与**100个验收ID**证据核验通过。以上按各自检查类型记录，不拼接成不存在的最终套件总数。
- 最终元信息收尾实际补跑：仓库根执行 `npm run typecheck` **通过**，覆盖shared构建、CLI、Worker、API、飞书插件和Web类型检查；日志：`.tmp-tests/cli-agent-final-delivery-typecheck.log`。该命令不读取实际`.env`，本轮未修改产品、契约或测试，未执行Git。
- 全面审查通过不扩大平台或安全验证范围：Node22/Docker/非Linux未验、root build因Vite读取环境文件未跑、既有compatible partID及下载安全风险仍按“未验环境与保留风险”节保留。

### 全面审查L1分层证据

- 权威实现：[sqlite-session-activity-query.ts](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.ts)。候选集合按Workspace/更新时间/kind选取，不接入tab可见性；原生消息计数按origin Session聚合。
- 真实SQLite参照：[sqlite-session-activity-query.test.ts](../../../apps/api/src/modules/agent/read-side/sqlite-session-activity-query.test.ts)，全面五项修复时13/13、原全面复审亦通过。实际用例包括`activity query includes both window ends and preserves empty titles/headless sessions`、`activity query applies all nine kind/status combinations without page visibility`、`activity counts do not inherit fork history or shrink after compaction/revert pointers`。该最小fixture不创建可见性表，证明查询不依赖该表，但并非隐藏tab端到端断言。
- 真实HTTP参照：[agent-session-activity-query.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-session-activity-query.integration.test.ts)，全面五项修复时6/6、原全面复审亦通过。其中`activity HTTP returns all 165 records, current state and counts independent of tab visibility`显式插入隐藏tab并对比tabs旧接口，证明activity接口不筛隐藏项；`activity HTTP returns native creation times outside the update window, including a fork's own time`验证Fork自身时间。
- CLI端到端：[agent-cli-session-query.integration.test.ts](../../../apps/api/src/modules/agent/integration/agent-cli-session-query.integration.test.ts)，新增全面审查L1用例显式构造primary Fork（继承source消息）、隐藏primary、headless空primary、subtask及另一Workspace；CLI默认primary集合恰含前四个主会话，消息计数不继承，Fork时间取自身。没有借后端kind=all用例替代primary Fork的CLI断言。
- [session-query.test.ts](../../../packages/cli/tests/session-query.test.ts)只证明CLI DTO结构、时间/计数/过滤回显的校验；[session-activity-query.test.ts](../../../apps/api/src/modules/agent/read-side/session-activity-query.test.ts)4/4只证明后端纯查询参数契约，不作为SQL集合证据。

原全面审查H1/M1/M2/M3/L1与L2全部Resolved，无新增问题；原全面审查者最终复审通过，可交付。所有未验环境及既有保留风险不变。
