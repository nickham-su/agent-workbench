# 自然语言输出契约

## 输出分层

- REQ-NATURAL：stdout 只写业务结果、正文和监听收尾；stderr 写参数／操作诊断及有界的网络重试提示。
- 不输出 JSON/JSONL 包装，不承诺任意中文文案永久可被脚本解析；固定业务值仍保留原值，避免把 `idle/running`、resultCode、错误码翻译成不可诊断的自由描述。
- 任务身份在头部；消息 ID 是正文输出结束后的终结凭据，位于消息尾部。
- 不把 assistant 草稿当最终答案。完成消息与 Run 结束是两个独立事件。
- 保持现有背压和终端控制字符防护，不因输出面向自然语言就直接写入原始控制序列。

实现入口：[output.ts：writeSuccess / writeFailure / writeText / displayBody](../../../packages/cli/src/output.ts)、[errors.ts：errorDiagnostic](../../../packages/cli/src/errors.ts)。

## 任务头部

示例为建议的固定结构，文本细节可统一，但下列语义不得省略：

```text
请求已受理，正在执行。
Session ID：session-example
Run ID：run-example
用户消息 ID：user-message-example
```

- `send -f` 可保留触发请求的用户消息 ID，但必须明确命名为“用户消息 ID”，不能与当前 assistant ID 混用。
- `messages -f` 只展示捕获的 Session／Run；不把 run-state 中的 `activeAssistantMessageId`、`nonTerminalMessageIds` 展开为头部字段。
- `compact -f` 显示压缩受理和 Run 身份，不暗示一定有普通 assistant 正文。
- 没有活动 Run 时明确说明执行一次历史收尾；不显示虚构 Run、不等待未来任务。
- 不使用原 `Object.entries(identity)` 无差别打印所有键；身份字段按命令显式白名单展示。

## 消息结构与 ID 时机

### 流式 assistant

```text
助手回复（生成中）：
正在检查项目……检查完成，发现两个问题。

—— 本条回复已完成 ——
消息 ID：assistant-message-example
```

- 正文可分多次 write，但不因每次更新主动加换行，不重复消息标题。
- 只有读取到 `completed/failed/cancelled`、验证最终正文与已有内容兼容、正文及必要分隔符写入完成后，才能写尾部状态和消息 ID。
- 状态尾分别为“本条回复已完成／本条回复失败／本条回复已取消”；失败或取消的部分正文不得贴“完成答案”标签。
- footer 之后相同终态／revision 再次读到不得重复输出；若真正终态消息内容后来改变，按不变量错误停止，不悄悄追加或重写已发布正文。
- 写正文失败时不得继续写该 ID。footer 写入失败也不得通过后续错误上下文补发 ID。
- 消息刚被发现时已经终结，也采用正文在前、状态和 ID 在后的顺序，不需要伪造“生成中”。

### 历史消息、user 与非 follow 快照

- 已终结的 user/assistant 历史按链顺序完整输出一次，角色在头部，状态和消息 ID 在正文后；不逐版本重放历史。
- `messages` 非 follow 遇到仍在 streaming 的 assistant 时显示当前快照及“仍在生成”，不显示该未终结消息 ID；快照读取完成不等于消息终结。
- 非 follow 快照结束必须局部 flush 所读版本的全部规范字符：尾部 CR 输出反斜杠加 r，孤立高代理输出 U+FFFD。该 flush 不改变业务 streaming 状态、不封口服务端 Part、不授予消息 ID 展示资格；follow 则继续暂存，等待后继字符／Part 或消息终态。
- 用户图片和文本保留原 Part 顺序。图片只显示 attachmentId、mediaType、filename，不下载、不打印字节／Base64／额外 URL。
- 可见性保持 [messages.ts：projectMessage](../../../packages/cli/src/messages.ts) 的规则；没有可见内容的助手消息不额外打印空标题／空 ID，隐藏内容不计普通消息数。
- snapshot 结束标记与普通消息数量仍保留，不把“快照完整”改成“任务最终答案完整”。

### 草稿作废

```text
—— 上一段草稿已作废，正在重试 ——
助手回复（生成中）：
这是新的尝试内容……
```

- 只有同 Run 合法替换已被证明才使用此文案；不显示旧／新草稿 ID，不展示完整替换链。
- 已显示的正文不能撤回，作废标记是输出历史的一部分；不得清屏、回退光标或把新正文直接接在旧句子后。
- 多次已被观察到的重试分别标记；一次轮询漏掉多次中间替换时，对此前实际展示的旧草稿标记一次即可，不虚构中间正文。
- 没有输出过可见内容或消息标题的隐藏空草稿不制造无意义的作废段落；其内部替换验证仍必须执行。

## 草稿 ID 的可见性策略

REQ-ID 不只是改变模板位置，还必须关闭旁路。

| 来源 | 允许输出 | 禁止输出 |
| --- | --- | --- |
| 任务头 | Session、Run、明确命名的触发用户消息身份 | 当前 assistant 草稿 ID、非终结消息数组 |
| 消息正文前 | 角色、生成状态 | 当前消息 ID |
| 消息 footer | 本条已终结且正文已写完的 ID、真实状态 | 作废消息 ID、未写完正文的 ID |
| 替换提示／重试提示 | 可读原因与状态 | from/to ID、proof 中间数据、activeAssistantMessageId |
| 参数／分支／网络错误上下文 | Workspace、Session、Run、必要请求身份 | 尚未发布的 assistant messageId、partId、以 previous/replaces 等别名带出的草稿 ID |
| 任务收尾 | Run 结果、完整性、退出码 | 续读位置、恢复命令、游标及未终结消息 ID |

- FollowOutput 必须维护“正文已成功写完且 footer 已成功发布的消息身份集合”，而不是因为进入 `message()` 就认为 ID 可以公开。
- 诊断以结构化白名单重新渲染。follow 中默认不打印通用 `messageId`；触发用户消息可显式重命名，已发布终态 ID 也不需要在错误中重复。
- 证明、分页 cursor、显式 `--after` 参数都可以内部保留，但不得直接 spread 到日志。即使参数由调用者提供，也不在不必要的错误中回显草稿 ID。
- 不扫描／篡改用户正文里自然出现的任意字符串；限制的是 CLI 自己产生的标识字段，不承诺识别正文中用户主动输入的 ID。
- 设计前的 [FollowOutput.metadata / error](../../../packages/cli/src/follow-output.ts) 和 [withErrorDetails](../../../packages/cli/src/errors.ts) 会聚合 identity/context，实施已逐入口改用白名单；后续审查仍须覆盖这些入口，不只检查正常成功输出。

## 任务收尾与完整性

| 观察结果 | stdout 必须表达 | 退出码 |
| --- | --- | --- |
| Run completed，补读成功 | 执行成功，消息已完整读取；保留具体 resultCode | 0 |
| Run failed，补读成功 | 执行失败，但消息已完整读取；保留具体 resultCode | 8 |
| Run cancelled，补读成功 | 执行已取消，消息已完整读取 | 9 |
| 无活动 Run，有界收尾成功 | 查询时没有活动任务，历史读取完整 | 0 |
| 已知 Run 终态，最后读取仍失败 | 保留已知 Run 状态及 resultCode，明确消息读取不完整 | 以本地观察错误为准 |
| FinalDrain 第二 pass 关闭后仍无法证明范围完整 | 保留已知 r1 状态/resultCode，消息读取不完整；不等待或输出 r2 | 6，OBSERVATION_INCOMPLETE |
| SIGINT／SIGTERM | 监听已中断／终止，输出可能不完整；后台执行未因此取消 | 130／143 |
| 整体监听超时 | 监听时限耗尽，输出可能不完整；不自动取消后台任务 | 10 |
| stdout EPIPE | 不保证还能写入收尾 | 141 |

- 正常只有一个任务收尾；已有业务输出不因后续失败撤回。已知终态后的结构收尾固定最多两个 pass，每 pass 最多一个关闭 delta；单纯 r2 追加／更新且相关范围有效不使用第二 pass。
- failed/cancelled 不自动再追加一个格式化错误对象；保留当前通过返回码结束业务 Run 的方式。
- 初始读取或受理尚未成功、任务头尚未开始时，不伪造完整 terminal；stderr 和退出码仍是结果依据。
- SIGKILL、管道关闭、stderr 不可写等情况下不能保证收尾存在。CLI 成功写出也不能证明外层工具未截断或实时转发。

现状终态登记：[agent.ts：AGENT_TERMINAL_CODE_REGISTRY](../../../packages/shared/src/contracts/agent.ts)；客户端校验：[run-status.ts](../../../packages/cli/src/run-status.ts)。

## 诊断与副作用

- 文本诊断保留 `code`；有 `serviceCode` 时同时显示；保留 `phase/effect` 及安全上下文，不只给笼统“失败，请重试”。
- `effect=accepted`、`unknown`、`rejected`、`not_sent`、`not_applicable` 保持既有语义，不因格式删除而丢失已受理证据。
- 文件下载后 `published=true` 必须可见，即使随后清理、续签或输出失败；不能因非零退出码暗示目标未创建。
- 不输出请求 URL、Cookie、token、原始异常／错误响应正文、模型私有 replay、内部鉴权信息。
- 网络重试提示每个逻辑请求最多一条开始提示和一条恢复提示；最终耗尽使用正常最终诊断，不逐秒倒计时、不逐次刷堆栈。提示失败不得覆盖主错误或造成无界阻塞，沿用现有诊断 best-effort 的 250ms 预算及不可写后停止诊断的原则。
- 正文 stdout 的正常背压不能被该诊断预算截断；SIGINT／EPIPE 等由生命周期立即接管。
- 不输出任何“建议续读位置”、恢复命令、续读游标或等价的自动建议。

## 内容兼容与模板约束

- 保持 [displayBody](../../../packages/cli/src/output.ts) 的 CRLF 归一化和 [escapeDisplayText](../../../packages/cli/src/session-list-output.ts) 的反斜杠／控制字符处理；增量与快照采用同一字符规范，但分别使用业务封口与本次快照结束的 flush 边界。局部 flush 不是消息终态。
- 业务正文、文件名和名称不允许注入 ANSI／回车重绘；模板与正文分隔明确，但不承诺自然语言内容是可认证的机器事件协议。
- 正常运行不输出每次 poll 的 revision、内部游标、证明路径、尝试计数列表等调试数据。
