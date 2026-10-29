# 技术设计

## 实施边界

- 实现薄 HTTP 客户端，不导入 API service、不读取 SQLite、不调用内部 SSE/Worker 控制面。
- 只调整 CLI 源码、测试和使用说明；新增模块以明确状态边界为依据，不为形式分层造通用框架。
- 复用 shared 的公开契约/类型，但不能因复用类型而把服务端整个配置响应原样打印；不增加 shared/API/Worker 契约。
- 继续发布 Node 22+ CommonJS 单文件；新增依赖如确有必要须证明打包闭包，不引入重型归档库到 CLI，目录 ZIP 由服务器生成。

## 公开 API 复用清单

路径中的 `W/S/R/M` 分别表示经结构校验、一次编码的 workspace/session/run/message ID，查询统一携带工作区。

- 路径段ID拒绝字面 `.`/`..`，不限制为UUID；从原始值一次encodeURIComponent（不预解码），再用静态路由模板组装预期pathname。构建URL后逐项验证origin、pathname与预期编码路径完全一致、fragment为空，查询字段按URLSearchParams精确生成。`%2e%2e`作为ID变成`%252e%252e`，`/ ? #`成为`%2F/%3F/%23`数据；不能仅靠同源和API前缀检查证明路由未变。

| CLI | API | 组合与裁剪 |
|---|---|---|
| workspace list | `GET /api/workspaces` | `title→name`，仅必要字段；客户端稳定排序 |
| agent list/选择 | `GET /api/workspaces/W/agents/available?surface=user` | 保留返回顺序，只投影 id/name/summary |
| session list | `GET /api/agent/sessions/query?workspaceId=W&updatedWithinSeconds=…&kind=primary&status=…` | 沿用现有窗口与完整 DTO 验证，不借用 tabs/continuable |
| session show/类型预查 | `GET /api/agent/sessions/S?workspaceId=W` | 主/子元信息，核验 workspace/id |
| 自动创建 | `POST /api/agent/sessions`，body `{workspaceId}` | 一次创建，不自动重试 |
| send 文本 | `POST /api/agent/sessions/S/messages` | JSON `{workspaceId,clientRequestId,agentId,text}` |
| send 图片 | 同上 | multipart：payload JSON + images；纯图 text 可为空 |
| messages/跟随 | `GET /api/agent/sessions/S/timeline?workspaceId=W&mode=…` | snapshot/before/delta，普通消息投影与目标 Run 过滤 |
| 锚点校验/必要重取 | `GET /api/agent/sessions/S/messages/M?workspaceId=W` | 当前可见链详情，不是任意旧分支读取 |
| status/消息跟随目标捕获 | `GET /api/agent/sessions/S/run-state?workspaceId=W` | CLI 状态输出仅忙闲；内部保留 activeRunId |
| 跟随终态 | `GET /api/agent/sessions/S/runs/R?workspaceId=W` | 仅 CLI 内部使用，验证 run 归属及状态/结果码 |
| cancel | `POST /api/agent/sessions/S/cancel`，body `{workspaceId}` | CLI 预查主会话；不改变 API 对子会话的原支持 |
| compact | `POST /api/agent/sessions/S/compact` | `{workspaceId,clientRequestId,agentId}`；不传旧 updatedAt 充当 Run 条件 |
| file download | `GET /api/workspaces/W/files/download?path=…` | 文件流/ZIP，沿用后端限制，本地无覆盖保存 |

- 发送响应是 `sessionId/messageId/runId/deduplicated`，没有 agentId；CLI 先解析并显式传 Agent，所以正常新请求的 agentId 来自同一请求身份，而不是事后重新查询默认 Agent。
- 后端 Timeline 普通 text parts 是完整文本；3000 字符限制主要用于工具预览，不得拿工具预览当完整消息正文。
- 未发现公开可重放 Agent SSE；无需新增，固定 Run 轮询足以覆盖本方案常规追加/压缩语义。
- API 详情、状态、Timeline 都有工作区归属校验；CLI 仍校验响应身份，不能把一个形似正确的 JSON 当成任意资源成功。

## 内存实体与输出边界

无需新增持久化数据库。建议以简单 TypeScript 类型表达下列状态；名字可按代码现状调整，语义不可省略。

| 实体 | 必要字段/职责 |
|---|---|
| `CommandContext` | 命令名、输出模式、已加载连接、AbortSignal、单请求时限、可选整体截止时刻、当前 phase |
| `OperationIdentity` | workspaceId、已确认 sessionId、显式选定 agentId、每次调用新生成 clientRequestId、受理后 messageId/runId；不得从不完整响应猜字段 |
| `PreparedInput` | UTF-8 文本、已读取图片字节/检测 MIME/安全 basename、最终 payload 字节长度；在创建前完成 |
| `HistoryFrame` | 首个 snapshot 的 head/root/revision、普通消息选择条件、固定历史边界、向前游标、按 id 合并的消息；不等同服务器跨请求事务快照 |
| `FollowCursor` | 固定 targetRunId、已完整处理的 session revision、knownHead/knownRoot、起始分支锚点、已输出消息 id→revision、待终结消息 |
| `IdleFinalization` | 固定初始head H0及其原始来源字段、仅由H0本身确定的K0（known(runId)或unknown）、初始选中ID/锚点、选中streaming消息与K0组成的已知来源集合K、终态证明、一次收尾head H1及有效边界；不向前寻找K0、不轮询新Run |
| `ObservationResult` | Run 已知终态和消息完整性分开记录；不能因查到 completed 就跳过最后读取 |
| `DownloadAttempt` | 本次随机临时名、已打开句柄、接收字节数、目标路径、published 标记；清理只操作本次临时资源 |

- 整个原始 Agent 配置响应、Cookie、图片字节都不得进入日志/输出对象。
- 不创建跨调用请求历史文件；进程结束后不承诺恢复同一监听游标。调用者可重新用消息命令查询，但不是 token 事件重放。
- 非跟随列表可先内存聚合再输出；必须处理背压，不得静默截断。实现如需限制本地资源，应显式失败并记录未完整，不能改成只返回前 N 条。
- 人类元信息复用session-list-output.ts的escapeDisplayText；正文按契约保留换行后逐行转义控制字符，尤其ESC不能直接送终端。渲染只消费消息投影，不原地修改DTO，JSON/JSONL保持原文语义，防止显示安全处理污染业务数据。

## 输入准备与 Agent 选择

### 本地准备

- 解析帮助路径后立即返回；普通命令先语法校验，再读取显式本地输入，随后加载连接。help 不进入输入读取分支。
- 提示词文件用 fatal UTF-8 解码；stdin 同样有明确 EOF 和大小上限。不要复用登录 token 输入函数去隐藏读取普通提示词。
- 图片在创建前读入有界 buffer，按检测签名/MIME/单张/累计字节验证。不得到上传时重新读取可能变动的源路径；总量上限 20 MiB 可接受一次调用内存持有。
- 请求 ID、workspace/Agent 字段已知后序列化 payload，检查文本-only JSON 1 MiB、multipart payload 64 KiB。不得只按 JS `string.length` 计算 UTF-8 字节。
- 仅签名预检，不承诺完整图像解码有效；服务端最终校验失败仍按真实 API 错误处理，不建第二个 session。

### 默认 Agent

- 获取本次工作区 user 列表，保留服务端 order；显式 ID 也必须在列表中。
- 没有 Agent 则退出，不创建。首个 Agent 模型坏不自动选第二个。
- 固定所选 ID 并显式提交；列表读取后配置变更造成禁用/删除时失败，不重新发现并更换选择。
- 可用性不是模型健康检查，不请求执行配置或 Provider 密钥。已有 session 的模型覆盖由现有后端解析，不新增切换模型选项。

## 自动创建与发送流程

```text
本地输入/参数预检
  → 加载连接、发现并固定 Agent
  → 已有 session：读取详情并检查主类型
    无 session：一次 POST 创建，验证并记录新 sessionID
  → 一次 POST 发送（JSON 或 multipart）
  → 验证受理身份并保存续签 Cookie
  → 无 -f：输出受理，结束
    有 -f：先 metadata，再进入固定 Run 跟随
```

- 创建出错/超时/响应无效：不重试、不发送、不猜 sessionID。effect 依据响应证据为 rejected 或 unknown；可能有空 session 是已接受取舍。
- 创建有效成功后发送出错：错误保留 sessionID，不重建，不自动取消/删除该 session。
- 发送发出但超时/断线：可能已经运行，effect=unknown；不能输出 runId=null 并声称“没有启动”。
- 完整受理响应后若 Cookie 保存失败：停止后续写/跟随并报持久化失败，但 effect=accepted，错误中保留已知 session/message/run/request ID。不得建议通过重新发送解决 Cookie 问题。
- 后端返回 `deduplicated=true` 时，只有本地能证明同一请求身份才可回显对应 Agent；本次无用户自设请求 ID、无自动重试，正常不会走跨调用去重恢复。遇到无法证明身份的意外去重响应应报响应不一致、保留可靠 session/run ID，不伪造实际 Agent，也不改 API 补字段作为前置依赖。
- Request ID 使用随机 UUID 等高碰撞抗性方式生成，每次新发送/压缩各生成一个，不能用时间戳、sessionID 或 prompt hash 替代。
- 后端去重键是 workspace+session+clientRequestId，发送与压缩共用该空间；严禁跨操作复用。既有去重只是保留防护，不意味着创建链幂等或模型重新调用会自动去重。

## 普通消息分页

### 当前可见分支读取

- `snapshot` 获取尾页，默认本次 CLI 请求 `limit=100`。服务端最大 500；不将其当 CLI 总消息上限。
- 记录首个返回的 head/root/revision，形成历史框架。该 head 是历史链边界；后续追加不得使 `-n` 的初始选择偷偷滑向下一次执行。
- `before` 用返回的 `nextBeforeMessageId` 向前读取，游标对应当前页最早原始消息，不是筛选后最早普通消息；否则会漏掉工具/压缩行之间的普通消息。
- 先合并原始消息再按契约投影。N 不足继续分页；after 必须找到锚点并排除它；到链首仍未找到则失败，不能输出部分列表。
- 校验游标必须单调向前、页内 ID 唯一、相同 ID revision 不回退、资源身份一致；`hasMore=true` 却没有可前进游标时失败，防止无限循环。
- 初始 head 为 null 时：`-n` 返回空；after 锚点不可能存在，返回锚点失败。
- 分页跨 HTTP 不是数据库冻结快照；文本状态可能继续变化。保证链边界及显式消息状态，不宣称某毫秒的不可变内容快照。
- 分页中 head 继续追加且原锚点仍为祖先，可以继续；原锚点/after 游标被回退或替换移出可见链则显式 `TIMELINE_CHANGED`，不混合两条分支。

### 增量游标

- delta 携带已完整处理的 `sinceRevision`、`knownHeadMessageId` 和 root 前提。
- root 非空传 `knownContextRootMessageId`；已知为 null 传 `knownContextRootIsNull=true`，两者不能同时传。
- 本地 `messageId→max(updatedRevision)` 合并更新，不能只记录“最后打印的 ID”。parts 更新也必须触发最终完整投影，不能把同一消息新文本直接重复 append。
- 只有在成功处理整个响应及其重建要求后才推进 cursor；向前翻页时看到更大 session revision 不能直接覆盖初始 R，避免漏掉分页期间已读消息的更新。
- 当前有效 delta 实现可能返回超过 limit 的所有更新；不能根据请求 limit 假设响应最多 100 条或丢掉多余条目。

## `-f` 固定 Run 与终态排干

### 初始化边界

- send：目标来自发送响应，已知本次 user messageID 为锚点。第一次轮询前 Run 已完成也必须向前补页找到该锚点，收集目标 Run 全部普通消息。
- compact：目标来自压缩响应；记录压缩前详情 head 作为历史锚点。只输出目标 Run 普通消息（通常没有）；压缩消息不计数，终态码负责说明结果。
- messages：先取得首个 snapshot 的历史 head/revision（只预取，不输出），再读取一次 run-state，以这次成功读取时的 activeRunId 固定目标，然后完成历史选择并输出 metadata/历史。先预取边界是为了不把随后新 Run 的消息纳入初始历史。
- messages捕获idle时进入下述唯一有界收尾路径：初始历史暂不输出，不得用“不是事务快照”放过正常完成竞态。只有初始head本身能证明原生来源Run时，才能将该Run的最终追加扩入历史边界；来源未知时按稳定历史/证据不足分支处理。
- metadata 始终先于任何消息输出。messages无活动目标时runId保持null；只有有界收尾证明范围完整才输出历史并no_active_run终结，不能寻找/等待新任务填充runId。
- 有目标时保留初始 R，历史分页完毕后从 R 做 delta，补上初始化期间产生的目标 Run 消息及选中历史消息更新；同 ID/revision 不重复输出。

### 无活动 Run 的有界收尾

这是messages首次run-state返回idle时的单一处理路径；不是自动重试或永久跟随。metadata先输出，历史正文缓冲到证明完整后再输出。

- **固定初始范围**：保留首snapshot的head H0、H0本身原始来源字段、完整原始页与原--after/-n条件；必要时有限分页完成H0前缀内的历史选择，记录初始选中ID及锚点。分页只服务于历史选择和后续范围校验，不用于寻找K0。
- **只信任初始head来源**：仅当H0本身的originSessionId等于当前session且originRunId非空、资源身份可证明时，K0=known(该runId)，例如有真实来源字段的assistant/tool-only head。H0为空、user的originRunId=null、来源无法证明或属于继承历史时，K0=unknown；unknown不是“没有Run”。不得跨过H0去找更老的非空Run，也不得在收尾时给K0补值；消息ID模式、正文、时间戳均不能用于推断。
- **固定已知来源**：K为已知K0（若有）加初始选中streaming普通消息可证明的原生来源Run；逐一核验workspace/session。选中streaming来源无法定位、属于继承来源或归属不能证明时，直接OBSERVATION_INCOMPLETE/6。K中的旧历史Run不能反过来替代未知K0；已终结的user或继承消息来源未知本身不是失败条件。
- **一次确认终态**：对K中每个Run各查一次公开指定Run状态，必须已完全terminal（completed/failed/cancelled均可）；仍running、无效归属/终态或无法证明时失败，不轮询等它结束、不改查后来activeRun。网络/认证故障沿原5/4分类，仍complete=false。
- **一次收尾读取**：在K中全部Run终态确认之后再请求一次snapshot（K为空也照常读一次），固定其head H1；按H1向前有限分页，必须找回H0及原选择所需前缀/after锚点。后续页的更新head不扩大本次H1；不睡眠、不反复刷新等安静期。
- **K0已知时补齐追加**：检查H0之后至H1（不含H0、含H1）的全部原始记录，必须跨页合并后按链正序（旧到新）检查，不得把从尾页向前取页的顺序当作链正序，也不能只更新旧message。将连续属于K0（同originSessionId、originRunId）的后继记录纳入有效边界；遇到明确其他Run即停止扩入，不将其任何消息作为目标/历史尾部。之后若又出现K0或任何新增记录来源不明，无法证明范围，退出6；不能把另一Run的originRunId=null user当作已证明的其他Run跳过。
- **K0未知时只接受稳定范围**：只有H1=H0、原选中ID/锚点在同一可见链上且重新选择的范围稳定、最终消息均已终结时，才允许成功；正常parts/revision更新按收尾完整内容输出。稳定user-only、纯继承历史、空session均可成功，不因为K0未知无条件失败。若H0之后出现追加，即使追加记录自己带非空originRunId，也无法证明它与H0未知来源的关系，必须OBSERVATION_INCOMPLETE/6，不能猜作“后来Run”丢弃后成功或全部归到更老Run；H0为空而H1非空同样失败。
- **重新选择与校验**：K0已知时，有效head为最后一个纳入的同Run后继，无追加则H0；K0未知且范围稳定时，有效head仍为H0，按原条件重选的ID序列必须与初始选中一致，否则证据不足退出6。在有效边界内使用本次收尾snapshot/分页的最新完整parts，重新应用原--after/-n，确保最终所选普通消息均已终结。有可信head来源时，-n1可改选同Run新追加的最终assistant，--after覆盖该Run全部应选追加；不能只刷新原选中ID。
- **有界结束**：范围可证明完整时才输出选中历史，terminal为no_active_run/complete=true、runId=null、退出0；来源Run终态只用于消息完整性，不把它变成新跟随目标，也不把该历史查询的0解释成Run成功。锚点/分支失效用TIMELINE_CHANGED/6，其余证据不足或最终仍streaming用OBSERVATION_INCOMPLETE/6，均observation_failed、complete=false；传输/认证失败沿既有码。

来源事实：主会话发送user、子任务初始user均持久化为originRunId=null；Run通过triggerMessageId关联输入，但当前公开接口不提供从输入反查Run。不能把completed user误当作已知Run来源；见[来源事实与源码](06-decisions-and-references.md#发送消息状态跟随)。

请求量由初始有限历史、固定K各一次状态、一次收尾snapshot及所需有限前缀页决定，不随新任务持续追加增长。稳定完整的idle历史有界读完立即返回；可信head来源的同Run追加必须收齐，未知head来源的真实初始化竞态则显式失败，不能输出旧user并complete=true。来源可证明的另一Run可按上述规则排除，但不选为目标、不等终态；证据不足时不能假定追加属于后来Run。仅-f的这类观察竞态会失败，正常已完成历史的-n1读取不受影响；调用模型可重新读取，CLI自身不重试。

### 正常轮询

- 轮询间隔默认 1000ms，单循环串行处理消息增量和指定 Run 状态；不重叠发送多个轮询，不并发更新 Cookie 配置。
- follow 新增部分仅接受 `originRunId===targetRunId`；初始历史输出可包含以前 Run/继承消息，但后续别的 Run 新消息不得混入。
- 初始历史选中ID的后续revision更新仍须合并（例如初始化时旧Run最后一条仍streaming、捕获时已进入新Run），这属于已选历史的upsert，不是纳入其他Run的新消息；不能让其永久停留在生成中标识。
- 指定 Run 查询即使 session 已变 idle 或运行另一个 Run，仍查原 ID，不替换为 activeRunId。
- 查询结果码不在公开注册表、资源归属不一致、Run 404/终态不变量409均失败；不能将“查不到”当成成功结束。
- 正常运行时不对工具数组或 reasoning 输出事件；纯工具 assistant 进入可见文本后才产生普通消息 upsert。

### Timeline reset 与分支恢复

- `timelineReset=true` 表示响应是尾部快照而不是完整增量；丢弃旧 cursor 假设，以该响应重建，必要时向前分页回到固定历史/Run 锚点。
- 自动/手动压缩会改变 context root，但 previous 链保留旧历史；不能以 root 改变为由只保留尾页或跳过压缩前消息。
- 重建后以 ID+revision 合并投影，补齐未输出的目标消息；确认原锚点与已输出目标普通消息仍在当前可见链。
- 若既有锚点不可见、已输出普通消息被替换/superseded、分页返回 cursor not found，且当前公开接口不能恢复原链，退出 `TIMELINE_CHANGED`/6、complete=false；不要静默接到新分支，也不要求新增服务端事件日志。
- 第一次观察前已退出当前分支的瞬时内容无法被现有 API 证明，不能承诺保存每个 token/重试片段；保证的是本次范围内当前可见消息的最终状态与内容。

### 终态排干

```text
指定 Run 仍 running → 继续轮询
指定 Run completed/failed/cancelled
  → 在该终态确认之后再请求 Timeline 增量/必要重建补页
  → 目标消息合并、过滤后完整输出，确认目标可见消息不再 streaming
  → 输出一次 terminal，并按终态/观察完整性返回退出码
```

- 公开 Run 只有完全收敛后才暴露终态，尚有 terminal intent 的中间阶段仍返回 running，因此终态后补读有数据落库依据，但不能省略。
- 目标消息仍 streaming、分页无法排干或补读失败时，不输出 complete=true，也不只根据 Run completed 返回 0。
- 终态期间新 Run 可启动；补页按已固定锚点和 originRunId 过滤，不能把其消息当目标最后回答。
- 用单次补读/所需分页结束本次跟随，不等待 session 再次 idle 或某段静默时间。

## 压缩与取消流程

### 压缩

- 查详情核验主类型，查状态核验 idle；发现 busy 时不提交，服务端仍可能在 POST 时返回409，均不排队。
- 选首个 user Agent，显式提交，不暴露模型设置；生成新请求 ID。
- 空会话错误保留后端400语义；`scheduled=true` 是已启动手动 Run，不是排队；`deduplicated` 是旧执行重用。
- 默认只展示受理，无法提前知道是否真正压缩；`-f` 按 Run 结果说明 completed、无需压缩、无进展、尾部过大、需重发媒体或失败。
- 不改自动压缩流程；自动压缩属于正常 Run 内部步骤，不另开 CLI Run。

### 取消

- 查详情检查主类型后提交一次取消，不以只读预查替代服务端归属/并发控制。
- API 取消的是处理时的当前 Run，沿活动子 Run 关系递归；根已 idle 时不扫描历史关系寻找异常孤儿任务。
- 预查与 POST 之间 Run 可能切换，没有 expectedRunId，帮助/结果不得声称取消某个此前看到的旧 Run。
- 持久化取消及 best-effort 停运行沿用现有后端，不为了 CLI 改 API，也不增加 CLI 轮询取消全部完成的暗含承诺。

## HTTP、鉴权与故障

- 继续复用配置中的一个 API origin 与 Cookie；每个 URL 必须同源且在 `/api/` 下，重定向 manual，不能把 Cookie 转发到 Location。
- HTTP 模式分 JSON、multipart 和二进制流；不能让 `JSON.stringify(FormData)` 或 `response.text()` 处理图片/下载。multipart boundary 交给 Fetch/FormData 生成，不手写错误 Content-Type。
- 单请求 timeout 从 dispatch 到响应体完整读取/落临时文件结束，期间保持 AbortController；整体 follow 截止检查使用绝对时间，当前请求时限取剩余整体时长与请求时限的较小值，避免大时长 setTimeout 溢出。
- 所有请求自动重试上限为零，包括 GET；网络失败即停止观察，调用方可重新查询。周期轮询不是对失败请求的隐藏重试。
- 401退出4，不自动输入 token；403/404/409/413/503依 status 与安全 code 映射为6；网络/体中断5。未知异常使用本地安全文案，不透传 message/stack。
- 保持响应 Cookie 仅接受合法同源续签、续签保存成功后才发布该次成功输出；HTTP主错误优先保留原分类，续签保存错误作为安全的次级诊断，不改成另一次业务成功。
- 对完整有效的副作用受理 body，可先提取验证后的身份供失败上下文，即使随后 Cookie 保存失败也不能遗失已创建 session/run。不能因“未输出业务结果”就说业务未执行。
- 连接中断、超时、SIGINT、SIGTERM、EPIPE 都只 abort 本地请求/计时器/输出，不调用 cancel、不删除远端 session。处理信号后停止新轮询并移除事件监听，避免同进程测试互相污染。
- stdout 写入需要 backpressure 和错误监听；EPIPE 不可无限 stderr 循环，无法写 terminal 时以进程码表明输出不完整。

## 下载的无覆盖发布

### 请求与现有限制

- CLI 对远端 path 做契约中的词法检查，服务器继续决定真实文件访问；本地路径只用于用户显式选择的输入/输出。
- 后端按工作区根解释相对路径，首段匹配已登记 repo 时映射到该 repo；不接收数据库中的服务端绝对路径作为参数。
- 保留目录累计源文件100MiB、`.git`与扫描软链整体失败、空目录不保留的规则。CLI 不增加通用目录列举、压缩上传或内部 artifact 下载。
- 接受文件 `application/octet-stream` 或目录 `application/zip`；非2xx先按JSON/安全HTTP错误处理，不能把错误页发布成用户文件。Content-Length 如存在须验证实际字节数；不承诺目录下载内容是文件系统快照。

### 本地保存算法

- 预查输出父目录存在且为可访问目录，目标不存在（包含 dangling symlink）；该预查只是早失败，不能防并发覆盖。
- 在目标同目录创建随机名称临时文件，`open(...,'wx',0600)`，记录本次拥有的路径/句柄；不使用可预测固定 `.part`，不复用已有文件。
- 流式写入临时文件，计数和单请求超时覆盖整个 body；流异常、写异常、长度不符、中断均关闭句柄，仅删除本次临时文件，不发布目标。
- 正常结束后 flush/sync 并关闭临时文件，再以同文件系统 `link(temp,target)` 等原子 no-clobber 操作发布。单纯 rename 会覆盖，不可用；若当前平台/文件系统不支持原子无覆盖发布，则失败，不降级到覆盖 rename 或暴露半成品的直接 copy。
- `EEXIST` 表示目标被并发创建，失败并保持对方文件原样；只清理本次 temp。不得先 unlink target 再发布。
- 发布成功后移除本次 temp，输出成功 summary。发布后清理/输出失败不能删除已发布的完整目标；错误 context 必须说明 published=true，避免调用方误判文件不存在。
- 进程被 SIGKILL/主机掉电无法保证临时清理；随机临时名不算成功产物，不自动扫描/删除其他调用遗留文件。
- ZIP 无 Content-Length 时，以正常 HTTP 流完成作为传输完整依据；不新增自制归档修复器。服务器故障销毁流必须报失败；源目录变化、空目录丢失属于已说明的后端行为，不被误称为 CLI 传输截断。

## 独立安全事项

下载现有实现包含校验与重新按路径打开分离、repo 实际根边界的条件风险。CLI 不能观察或阻止服务端路径替换，不得以词法过滤作为已修复证明。

本次不为 CLI 修改该 API、不削弱已有检查、不提供绕过入口；独立风险见[决策与风险](06-decisions-and-references.md#独立安全事项)。若测试偶遇越界迹象，应停止相关用例并报告，不读取或记录外部文件内容。
