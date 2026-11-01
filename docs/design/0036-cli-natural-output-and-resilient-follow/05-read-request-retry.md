# 监听只读请求的有界重试

## 范围与基本预算

REQ-READ-RETRY 只改变 `-f` 监听流程使用的只读调用：

- 初始化阶段的发现／Session 查询、初始 timeline、目标 run-state、历史分页、必要 head 详情校验。
- 正常 delta／固定 Run 状态读取、替换后的可见历史重建。
- idle 有界关闭和 Run 终态补读。
- 仅相应 follow 调用显式传递重试能力；普通 `workspace/agent/session` 非 follow 查询、普通 messages 快照、下载等不因此获得重试。
- 创建 Session、发送消息、cancel、compact、login、配置续签保存、本地文件发布和输出写入都不在重试动作之内。

每个逻辑读请求独立预算：

| 尝试 | 发送前等待 |
| --- | --- |
| 首次 | 无 |
| 第一次重试 | 1 秒 |
| 第二次重试 | 2 秒 |
| 第三次重试 | 4 秒 |

- 总共最多四次尝试；三次退避合计七秒，不是七秒总请求时限。
- 每次仍受 `--timeout` 的完整响应时限控制；默认 30 秒。不含其他开销时，四次均耗尽单请求时限最多约 127 秒，整体 follow-timeout 若更早则优先终止。
- 成功结束该逻辑请求，后续新请求重新拥有自己的预算。不是整个 Run 只能遇到三次网络故障。
- FinalDrain 另有最多两个重建 pass、每 pass 最多一个逻辑关闭 delta 的固定预算。该关闭 delta 的四次 HTTP 尝试仍只算一次关闭读；成功、失败、退避、proof、root 或 cursor 变化都不能重置 passNo/closeUsed。
- 不新增重试参数、环境配置或通用策略框架；固定退避，本次不读取 Retry-After，也不增加随机抖动或并发请求。

设计前基线：[HttpClient.perform](../../../packages/cli/src/http.ts) 每次只发一次请求；[AgentApi.json](../../../packages/cli/src/agent-api.ts) 没有 retry；[observe](../../../packages/cli/src/follow.ts) 任一读取异常直接退出。

## 精确分类

| 错误／结果 | 自动重试 | 预算耗尽／直接停止后的原类别 |
| --- | --- | --- |
| 请求建立失败、网络断开、完整 body 传输中断 | 是 | 5，TRANSPORT_FAILED |
| 单次请求 timeout，包括 body 未读完 | 是 | 5，REQUEST_TIMEOUT |
| HTTP 429 | 是 | 6，HTTP_REJECTED |
| HTTP 502／503／504 | 是 | 6，HTTP_REJECTED |
| HTTP 500 或其他非白名单 HTTP 状态 | 否 | 原 HTTP 类别，通常 6 |
| HTTP 401 | 否 | 4，认证失败 |
| HTTP 403／404、重定向等 | 否 | 原类别，不跟随重定向 |
| 成功 HTTP 的无效 JSON／schema／错误身份／非法终态码 | 否 | 6，RESPONSE_INVALID 等 |
| 证明缺失／无效、分支或显式锚点失效 | 否 | 6，既有契约或分支码 |
| 本地配置加载、Cookie 续签保存失败 | 否 | 3／7，或既有主错误优先级 |
| stdout 写入失败／EPIPE | 否 | 6／141 |
| SIGINT／SIGTERM／外部 abort | 否 | 生命周期映射的 130／143 |
| 整体 follow-timeout | 否 | 10 |
| 后台 Run failed/cancelled | 否 | 业务结果 8／9，不是网络错误 |

- 不以 exitCode 5 或 6 直接判断重试。相同 exitCode 包含取消、契约、本地包装等不同来源。
- HTTP 错误 body 不能改变 status 白名单；允许安全 serviceCode 诊断，但不得依赖原始 body 字符串判断重试。
- 有效 HTTP 503 即使 body 不是 JSON，也按状态分类；HTTP 200 的无效 JSON 则不重试。
- 用于受限结构协调的 `TIMELINE_CURSOR_NOT_FOUND`／`MESSAGE_NOT_FOUND` 可加入现有安全 serviceCode 白名单，便于明确识别；它们仍不是可重试状态。[分页协调](03-follow-state-and-rendering.md) 发起新的事实核查，不允许对原 404 自动再发三次。

## 最小内部分类数据

建议为 CliError 增加只在内部使用、不可进入输出对象的 RetryEvidence：

```ts
type RetryEvidence =
  | { kind: "transport" }
  | { kind: "request_timeout" }
  | { kind: "http_status"; status: number }
  | { kind: "blocked" };
```

- 数据由真正知道来源的边界生成：HttpClient 标记网络／单请求时限，httpStatusError 标记 HTTP status，生命周期和本地持久化标记禁止重试。
- 不把它放入 `ErrorContext`、不 spread 到 stdout/stderr，不存 URL／headers／body／异常 cause。
- `withErrorDetails`、`FollowLifetime.failure` 和 AgentApi 的主次错误包装必须显式保留或覆盖该证据；禁止只修改最终判断却丢失中间复制语义。
- `blocked` 和生命周期中断优先于底层 transport/http status。不能把外部 abort 误当 request_timeout，也不能在取消后再等待一秒。
- 该类型是实现建议的明确安全分类，不是第二套对外错误码；现有 exitCode/code/serviceCode/phase/effect 保持原业务含义。

## 重试边界放在哪里

- 用一个小型、follow 显式启用的逻辑读调用包装器，作用于单次 `AgentApi.json` 逻辑请求。GET／缺省 GET 才允许使用；POST 即使误传策略也必须拒绝重试。
- 普通 `AgentApi` 默认没有此策略。follow 入口构造生命周期后，为该次调用传递受控的只读重试能力；不得直接给所有 HttpClient 请求加 retry。
- 同一次读请求重试复用同一个 route/query、workspace/session/run、sinceRevision、knownHead/root、分页 cursor、limit、validator 和目标身份。
- 不重新选择 Agent，不重新捕获 activeRunId，不生成新 clientRequestId，不把请求改为最新 head 来假装重试成功。
- 经有效续签保存的最新 Cookie 可供下一次尝试使用，这是已有连接续签行为，不是业务参数改变；凭证不进入诊断。
- 每次传输使用新的单请求 AbortController／timeout，整体 FollowLifetime 不重置。
- 不将 refresh/readRun/output/acceptSend 整个函数包成 retry：那会重复成功步骤、可能重发写请求或重复正文。

## 响应处理与 Cookie 续签

当前 [AgentApi.json](../../../packages/cli/src/agent-api.ts) 先判 HTTP／验证成功结果，再处理续签，最后抛主错误或验证错误。本次保持优先级，并补全禁止重试证据：

| 组合 | 要求 |
| --- | --- |
| 成功 HTTP、合法 JSON／身份、续签成功 | 返回一次结果，之后才允许输出／推进 cursor |
| 成功 HTTP、JSON／身份无效、续签成功 | 契约错误，不重试 |
| 成功 HTTP、本地续签保存失败 | 7，不重试，不先发布业务结果 |
| 可重试 HTTP、无续签或保存成功 | 保留 status 证据，允许下一次只读尝试 |
| 可重试 HTTP、续签保存失败 | 维持既有主 HTTP 错误优先级及本地诊断，但证据强制 blocked，不重试 |
| 非白名单 HTTP、续签失败 | 按原主次错误规则终止，不重试 |
| body 在传输中断，尚未构成完整 HttpResult | 网络分类；没有完整验证的业务结果不提交 |

- 尤其防止当前 `new CliError(mainError.exitCode, ..., mainError.details)` 在包装续签失败时被误判为仍可重试的 503。
- 配置保存不是重复 GET 的一部分；其失败不靠重新请求“也许下次能保存”恢复。
- 输出在 read wrapper 外；不能把 writeText 的异常包成 transport 并重复发读请求。

## 游标、正文与已成功步骤

- 网络失败前尚未返回的页面不改变 committed cursor／stage 已确认结果，不推进 sinceRevision。
- 当前逻辑请求第一次失败后，其重试仍请求相同 watermark／分页 cursor。成功后一次消费完整响应，按 revision 与规范正文去重。
- 若 refresh 成功并输出、readRun 失败，只重试 readRun；refresh 不重做。
- 若第三页失败，只重试第三页；已确认前两页不为网络 retry 重发。真实 revision 变化导致的 reset 重建按状态机另行处理，不得借此掩盖错误分类。
- Run 终态已知，最后 delta 失败四次后：complete=false，保留已知 runStatus/resultCode，退出 5 或 6；不能输出完整成功，也不启动新 pass 来绕过网络耗尽。
- 已知终态后的结构性重定位由 FinalDrain 控制：第一 pass 的关闭校验需要重新定位时才允许第二 pass；第二次仍不充分以 OBSERVATION_INCOMPLETE/6 停止，而不是再走 HTTP 重试。普通协调因非目标后缀变化让出查询固定 r1 的逻辑读也使用本节独立请求预算与生命周期。
- 当前 `loadThrough`／`completeHistory` 会把一些 exitCode6 广泛改写为分支变化。实施时必须收窄为真正游标／可见链失效：耗尽后的 HTTP503 等保留 HTTP_REJECTED/status 证据及原阶段，不被误报 TIMELINE_CHANGED，也不能因改写后丢失 blocked／取消证据。

## 取消、背压和诊断

- 每次尝试之前、收到错误之后和退避等待前后检查 FollowLifetime；退避用可取消等待，不直接不可中断地 sleep。
- SIGINT/SIGTERM/EPIPE/整体时限到达立即结束等待和在途本地请求，不耗尽剩余重试，也不发送远端 cancel。
- 正常一轮成功后的轮询等待仍是一秒；退避不再叠加一轮普通 poll 等待。
- 重试提示走 stderr，每逻辑请求首个可恢复失败提示一次，恢复后提示一次；耗尽用最终安全诊断，不按秒刷状态。
- 诊断遵守[输出契约](02-output-contract.md)的有界 best-effort，不泄露草稿 ID、请求 URL 或凭证；诊断不可写不产生新的网络重试。
- stdout 继续等待背压，不因网络重试绕开 write callback；正文写入失败停止本地观察，不能承诺 terminal 一定写出。
