# 监听状态机、内部实体与增量渲染

## 设计前基线与改造位置

- [follow.ts：Cursor / refresh / emitUpdates / observe](../../../packages/cli/src/follow.ts) 维护 revision、head、root、初始历史和目标 Run，reset 后重读历史；当前 anchor 混用了自动捕获的初始 head 与用户选择语义。
- [messages.ts：parseMessage / HistoryFrame / completeHistory](../../../packages/cli/src/messages.ts) 会丢弃 Part 的 id/position，当前不能直接用于可靠的多 Part 增量验证。
- [follow-output.ts：FollowOutput](../../../packages/cli/src/follow-output.ts) 维护已输出消息，但尚无正文写入进度／草稿作废状态。
- [follow-idle.ts：finalizeIdle](../../../packages/cli/src/follow-idle.ts) 是一次有界 idle 收尾，不应被改成长期监听未来任务。
- 本文定义实现必须保持的内部结构和流程；实际代码由 FollowState、MessageRenderer、FollowReadRetry 分别拥有协调、输出和逻辑读预算，见[实施记录](08-implementation-and-evidence.md)。不新增持久化实体、用户配置或对外输出协议。

## 内部实体

| 实体 | 必要字段／职责 | 不变量 |
| --- | --- | --- |
| FollowTarget | workspaceId、sessionId、固定 runId／runKind、命令种类 | 接受或捕获后不切到下一 Run |
| CommittedCursor | revision、head、root、已验证 HistoryFrame | 只推进到完整消费并验证的响应；网络失败不推进 |
| SelectionBoundary | last/after、explicitAfterId、autoInitialHead、历史槽位 | 显式 after 与自动初始 head 分开建模 |
| ProtectedHistory | 已终结且已输出的消息、显式 after、必要不可变前缀 | 被无关替换／删除必须失败；不能因重试统一清空 |
| MutableHeadSlot | 当前已观察 head 的 id、来源、depth、previous、raw streaming 状态、是否已发布 ID | 只允许目标 Run 尚未终结的 assistant；不是任意 streaming 历史 |
| RebuildStage | 本次重建的 frame、响应 watermark、已验证的槽位转换、待校验分页行 | 未通过完整验证不得修改 committed cursor 或发出新正文／作废提示 |
| MessageRenderState | 消息身份、raw LayoutPart、writtenBody、标题/footer、业务状态、outputMode、pendingTail、localFlushComplete | 业务封口与局部输出 flush 分开；快照 flush 不改变 streaming／ID 资格 |
| ReleasedIdentity | 正文完成且 footer 成功发布的终态身份集合 | 不能用“已读到消息”或“尝试写 footer”替代 |
| FollowReadRetry | 每逻辑只读请求尝试号、固定参数、生命周期引用 | 与后台模型重试独立；不包围整轮观察，不重置 FinalDrain pass |
| FinalDrain | 已知 r1 终态、冻结 SelectionBoundary／ProtectedHistory、passNo、passStart、prefixFence、closeUsed、stage | 首次加一次结构性重建，最多两个 pass；每 pass 最多一个关闭 delta，不追赶 r2 |

### LayoutPart：保留身份，不保留隐藏内容

```ts
type PartIdentity = { id: string; position: number; updatedRevision: number };
type LayoutPart =
  | (PartIdentity & { type: "text"; text: string })
  | (PartIdentity & { type: "image";
      attachmentId: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string }
    )
  | (PartIdentity & { type: "hidden"; kind: "reasoning" | "tool_call" });
```

- 这是建议的最小内部形状，允许与既有类型合并；id/position 必须保留到验证层，不能继续投影后碰运气推断身份。
- 保留隐藏 Part 的身份／类型／位置仅用于封口和顺序验证，不保留 reasoning 文本、工具输入或执行结果，不进入输出模板。
- 原 Part 验证仍校验 messageId、revision、时间、重复 id/position 和已知类型；隐藏内容不输出不代表允许未知类型绕过契约。
- 按 position 升序验证，位置可以因隐藏 Part 出现间隔；同一消息既有 Part 不得删除、重排、改 id／type／position。
- 既有 image 的 attachmentId/mediaType/filename 必须不变；不同 Part 引用同一 attachment 也按各自位置正常显示，不能只按 attachmentId 全局去重。
- Part.updatedRevision 不倒退，且不超过所属消息 updatedRevision；已接受的消息版本不超过已消费响应的 session.revision。分页较新行先暂存，必须经关闭 delta 消费到足够 watermark 后才能提交。

## 目标建立与生命周期

### send／compact

- 副作用受理维持原先单次执行；受理前失败不进入网络重发。
- 固定返回的 Run；受理后开始整体 follow-timeout，初始化 timeline／分页即在该时限内，之后才轮询。
- send 可展示触发用户消息 ID；compact 不伪造普通消息。
- 用于此次 `-f` 准备／观察的只读调用可显式使用读请求策略，但所有 POST 和配置本地写入不属于重试范围。

### messages

- 从进入本地观察初始化起开始整体 follow-timeout，使初始化 snapshot、run-state 和分页退避也受整体限制；这是针对当前 `begin` 在预取之后的明确调整。
- 先预取初始快照再捕获 activeRunId，保留既有初始范围语义。初始快照不是整个后续读取的数据库事务。
- 捕获 active Run 后固定目标；`last/after` 只约束初始历史，不裁剪随后目标 Run 的普通消息。
- 若捕获 idle，执行一次有界收尾过程，不等未来 Run；“一次”指这一过程，不代表只发一个 HTTP 请求。来源只取初始 head 本身或选中 streaming 消息的明确原生来源；不得跳过 user 向更老历史猜 Run。
- 对已知来源 Run 做必要终态验证，再按 FinalDrain 执行携带初始 knownHead／root 的起始 delta、必要分页及有界关闭；初始 delta 就是 OPEN，不能在该预算外另开重建。这里的来源 Run 仅用于有界收尾，不升级为新的活动监听目标。没有可信来源的空历史／非 streaming idle 场景仍沿用单次 H0 关闭检查，不凭空构造目标。
- 若初始 streaming head 在关闭时已被同来源 Run 合法替换，可在证明后用其后继槽位收尾；没有证明、来源不明、来源仍 running、无归属的追加都按 `OBSERVATION_INCOMPLETE` 停止。
- 保留 idle 的 H0 边界：只允许同来源任务已发生的收尾内容，遇到另一 Run 后不再回收原 Run 的更晚内容；空历史关闭后出现新消息不得假装完整成功。
- 内部将“活动观察 runId”与“idle 关闭已核准 sourceRunId”区别记录。后者只允许这次关闭中的证明校验，不启动 running 循环；下文目标来源校验在 idle 关闭时指该事先核准来源，不允许动态发现新 Run。

## 初始历史与锚点

- `--after X` 要求 X 在当前展示链，排除 X 本身；找不到时 `ANCHOR_NOT_FOUND/6`。after 与 last 恰选一，last 计普通可见消息，不计隐藏行。
- 显式 after 是硬保护边界，即使 X 恰好是目标 Run 的 streaming 草稿，被替换后仍失效；不得替用户把 after 改成新消息。
- 自动捕获的 initial head 若是允许替换的目标 streaming assistant，则是可变槽位，不是硬 after；证明后允许 A 槽位映射到 C。
- last 选中的初始 streaming 目标槽位可以随合法替换更新，但已终结／已发布 ID 的历史不能转换。用户消息、继承历史、别的 Run 草稿均不获得替换例外。
- 重建需要的最老边界使用未被替换的稳定前缀；若自动 head 本身可变，先证明并定位新槽位再加载，不对不可见旧 ID 盲目调用 before／detail。

## 主观察循环与结构协调让出点

```text
检查生命周期
  → 读取一次 timeline delta（每请求独立网络重试）
  → 有限步组装／分页；每次非目标后缀结构变化都先让出查询固定 r1
      r1 running：按已证明的当前事实继续，不改查 activeRunId
      r1 已终态：停止普通重建，立即进入 FinalDrain
  → 正常组装完成后输出／提交 cursor，再查询固定 r1
      running：等待 1 秒，再循环
      已终态：进入 FinalDrain，至多两个 pass 后结束
```

- 不把 refresh、readRun、输出包在一个“失败就重跑全部”的 retry 中；已成功 refresh 不因 readRun 请求失败重做。
- 普通协调发生 reset、可变分页 cursor 失效，或 before 页显示 head/root 已被未选择／未输出的非目标后缀改变时，在发下一次重建／分页／关闭读之前，必须让出并查询固定 r1 状态；同一响应中的多种变化合并为一次让出。
- 每个结构协调读响应后都重新检查上述让出条件，不能把整套 reset 循环藏在一次 refresh 内。即使 r2 持续变化，也能在下一次结构响应后发现 r1 已终态。
- 这一步只读 `/runs/r1`，不重新捕获 activeRunId；也受每逻辑请求四次尝试和同一 FollowLifetime 限制。该查询本身耗尽重试则立即结束观察，不继续结构循环。
- 已知 r1 终态后，不再执行普通“若 reset 就再重建”的分支；所有此后结构协调必须走下述唯一 FinalDrain 预算。Run 结果在进入时冻结，不因 r2 执行状态覆盖。
- 输出失败是不可撤回的本地观察错误，不作为网络错误重试；无论 cursor 是否已提交都必须停止。

## delta、reset 与分页的一致性协议

### 共同验证规则

- committed frame 是上一轮已成功验证／输出的事实；读取和重建先进入 RebuildStage。没有验证完成，不提交新 cursor，也不发出作废／正文／ID。
- 单个 API 响应内部必须是同一读视图；不同 HTTP 分页可能来自不同 revision，不能宣称整轮原子。
- before 页仅补前缀，不能直接用其 session.revision 推进 delta watermark。较新页行先暂存，关闭 delta 消费到足够 revision 后才可提交。
- 正常运行中可先证明 A→C，再证明 C→F；每一步从实际观察的 streaming head 出发，只保留必要槽位映射，不积攒无界证明链。已知终态后的证明消费受 FinalDrain 两 pass／每 pass 一次关闭读约束，不能无限串联重建。
- 使用[服务端证明](04-head-replacement-proof.md)只豁免唯一可变目标草稿；不放宽其他 `assertRetained/assertVisible/assertSameRecord`。
- 显式 after、已选择或已输出的其他 Run 历史、已终结并发布 ID 的消息及必要保护前缀统称“受保护相关范围”；其非法变化仍失败。未选择／未输出的 r2 后缀不属于该范围，正常追加／替换不能一律判错。
- 候选 C 不在尾页时必须按可见链找到 C；即使其后已有 D/E，也不能只处理最终 head。旧 A/B 不用普通详情越权读取。
- 新帧在其冻结的有效前缀内 previous 连续、depth 递增、边界对齐、revision 不倒退；业务 complete 不要求追到关闭响应的最新全局 head。
- root 改变依旧需要验证保护范围，不由 head 证明自动授权。只要保护范围失效就失败；若只是当前页不足以重定位范围，按 FinalDrain 剩余 pass 处理，不伪造完整。

### 普通协调的受限分页恢复

- 普通 404、显式 after 丢失、受保护来源变化不做 HTTP 重试。
- 运行期唯一可恢复的失效分页／head 详情是 stage 可变 head 的 `TIMELINE_CURSOR_NOT_FOUND`／`MESSAGE_NOT_FOUND`：先执行上节的固定 r1 状态让出查询。
- r1 仍 running 时，可以发起一次新 delta 事实核查；合法证明才允许新尾页重建，没有证明立即失败。不是重复原 404，也不消耗／重置网络重试预算。
- r1 已终态时，不能在此分支额外读 proof 或循环；直接进入 FinalDrain。已在 FinalDrain 的同类事件按其 BUILD→CHECK 转换处理。

## FinalDrain：固定目标的两 pass 收尾

### 冻结内容与预算

- REQ-FINAL-DRAIN：进入时固定 r1 的 terminal status/resultCode、原始 last/after 选择、显式锚点、硬保护历史、已发布身份和已输出草稿状态。不重新捕获 Run，不因 r2 扩大选择。
- `passNo` 初始为 0；每次进入 OPEN 时先加一。只允许 1、2 两个值，第二个 pass 是唯一一次因结构变化而重新定位，不按页、按 proof 或按 root 重新初始化该计数。
- 每 pass 的 OPEN 读取一次 delta（使用最后已验证 cursor 的 revision/knownHead/root；必要时服务器返回 reset 尾页）。其响应绑定 `passStart={revision,head,root}` 和初始 `prefixFence={head,depth}`。
- 两个 OPEN 都从进入 FinalDrain 时最后完整提交的 cursor 请求；第一 pass 未关闭完整的 revision/frame 不作为第二 pass 起点。允许保留已验证的身份观察事实，但不得将未消费的分页 revision 冒充请求 watermark。
- prefixFence 是槽位边界，不要求旧草稿 ID 永远存在。目标草稿经本响应合法 proof 替换时，只映射同 previous/depth 的后继并保留原深度界限；非目标后缀替换不能授权目标映射。CHECK 若已证明相关范围有效，不因无关旧 fence ID 消失要求全局重建。
- 此后只沿这个冻结前缀向前读取到原选择／硬保护边界，识别并收齐 r1 相关消息。后来追加的 r2 消息、更新和更高 depth 后缀不加入必读集合；r2 消息只可作为可见链导航材料，绝不输出。
- 每个 before cursor 必须按冻结前缀严格向较低 depth 移动，记录 visited 防止回环。页数可随有限历史长度增长，但不得跳回更新的全局 head 来重新追尾。
- 每 pass 只有一个 `closeUsed`：发起 CHECK 的关闭 delta 前置为 true；该逻辑读最多四次 HTTP 尝试仍算这一个关闭读。网络失败、root 变化、proof 消费、页失效均不能清零。
- idle 可信来源已验证终态且需要结构协调时，复用这套局部收尾预算，但保留原 H0／来源边界，不把 sourceRunId 变成新的活动监听目标。

### 可执行转换

| 状态／事件 | 必须执行 | 后继 |
| --- | --- | --- |
| ENTER | 保存已知 r1 结果与冻结边界，passNo=0 | OPEN |
| OPEN | passNo 加一；执行一次起始 delta，记录本 pass 起始 head/root/revision 和 prefixFence | BUILD |
| BUILD，普通有效页 | 只向较低 depth 补冻结前缀；暂存较新行，不追后来追加的 r2 | BUILD，或范围已齐则 CHECK |
| BUILD，单纯 r2 新追加／正文更新 | 忽略非相关后缀，保留本 pass 的前缀和 cursor，不触发新 pass | BUILD／CHECK |
| BUILD，非目标可变 cursor 失效、root／reset 变化使原前缀不能继续定位 | 不发额外恢复 delta、不回到 OPEN，记录需要重定位 | CHECK |
| BUILD，目标草稿确有已验证合法替换 | 仅应用已有同响应证明并补其可见后继；若还需新响应才能重定位，不能无限重建 | BUILD，或需要重定位则 CHECK |
| BUILD，硬保护／显式 after 已证实失效、非法 proof／契约、非法改写 | 立即按相应错误失败，不消耗第二 pass 试图掩盖 | FAIL |
| CHECK | closeUsed=true，至多一次关闭 delta；参数为本 pass 起始 revision/head/root，不使用分页较新 revision 跳过更新 | DECIDE |
| DECIDE，相关范围已完整且保护仍有效 | 合并关闭响应相关更新，验证无目标 streaming，写剩余正文/footer，唯一任务收尾 | DONE |
| DECIDE，只有 r2 新追加／更新，相关范围验证已充分 | 不要求最新 head 对齐，不分页追新后缀，不进入第二 pass | DONE |
| DECIDE，reset／root／r2 替换导致必须重新定位，passNo=1 | 丢弃未提交 stage，保留冻结业务边界及已知 r1 结果；重新建立当前前缀 | OPEN（passNo=2） |
| DECIDE，仍须重定位或不能证明完整，passNo=2 | OBSERVATION_INCOMPLETE/6，complete=false，保留已知 r1 结果；禁止第三 pass／第三次关闭读 | FAIL |
| 任意状态，读请求耗尽／输出失败／信号／整体时限 | 原网络／输出／生命周期错误优先，complete=false，保留 r1 结果 | FAIL |

### CHECK 如何判定，不以全局 head 稳定为前提

- 关闭 delta 以本 pass 起始 watermark 读取全部后续更新；返回 delta 时，将相关消息的最新版本与固定前缀合并、校验身份／Part／状态和保护边界。高于 prefixFence 的非目标追加不扩大必读范围。
- 因 r1 已终态，不能把之后新冒出的 r1 消息或遗留目标 streaming 简单归为 r2 噪声；它们意味着目标范围／终态收敛未被证明，不能 complete=true。
- 关闭响应即使 reset，只要它本身已携带足够可见行、合法目标替换证明和保护边界，可以直接验证成功；不得为格式上的 reset 无条件启动第二 pass。
- reset 尾页不足以定位相关范围，或证明候选还需新分页才取得时，当前 pass 不能在 CHECK 后继续补页／再关闭，而是仅在有剩余预算时进入第二 pass。第二 pass 再有同类不充分即 incomplete。
- r2 proof 只用于确认当前响应绑定及解释非相关后缀，不能豁免 r1 或硬历史。r1 proof 仍要求 from 是实际观察过的 streaming 草稿且未发布 ID。
- CHECK 的 knownHead 固定为本 pass 起始 head；若要用它证明目标替换，必须保有 OPEN 或已验证页中该 head 的真实 raw 记录及观察 revision，满足 raw.updatedRevision <= passStart.revision。只有 session.head 的 ID、不带真实记录的猜测不能取得资格；BUILD 才读到较新 head 也不能据此改 CHECK 参数。
- 开始新 pass 前不得把未通过关闭校验的页 revision、半个 frame 或 footer 提交；已验证的草稿替换身份可保留为内部 stage 事实，但不得拿它改变原显式 after／硬保护。
- DONE 发布的完整性只覆盖被冻结的选择、r1 消息和硬保护范围，不声称消费了最新全局 r2 链。它可提交该范围的渲染结果并立即结束，但不得把未读取的 r2 后缀包装为完整 CommittedCursor，或再进入普通 refresh。
- 这里的有限预算与 HTTP retry 正交：两 pass 不是两次 HTTP 尝试；任一逻辑读可有四次网络尝试，但成功或失败都不能重置 passNo/closeUsed。
- 已知 r1 completed 但第二 pass 仍不完整，必须同时报告“执行成功”这一已知结果和“消息读取不完整”，不能跟随 r2 等待其终结，也不取消任何后台任务。

## 正文前缀与 Part 封口

- 先验证 raw LayoutPart，再决定是否可见；不能让“新版本变成空白／隐藏”绕过已有正文不变量。
- 已有 text 的 raw 字符串必须是新 text 的前缀，不以长度相同／较长替代内容检查。
- 已有后继 Part 的 text 被视为封口，后续只能保持不变；只有最后一个未封口 text 可以追加。新增 Part 的位置必须在已有布局之后。
- image 一旦输出，其元信息不可更改。隐藏 Part 参与布局封口，不产生正文或分隔线。
- 单个消息 revision 增大但规范正文未变时，不写正文、不重复标题／图片／footer。
- 同一消息出现非追加改写、删除、重排或真正终态后继续变正文时，`RESPONSE_INVALID/6` 停止并说明观察不完整；不采用无声重写／尾部重打全文作为恢复手段。

## 规范渲染与跨版本字符安全

### 唯一正文规范

- text 使用现有 `displayBody` 语义：Part 内 `\r\n` 变 `\n`，保留换行，反斜杠和控制字符按 `escapeDisplayText` 转义。
- 可见 Part 之间插入一个 `\n`，与当前 `renderMessage` 的 join 语义一致；不跨 Part 合并 CRLF。
- image 使用当前附件占位格式，对文件名／ID 转义；顺序以 Part position 为准。
- 同一字符规范同时服务完整快照和流式正文，差异只在本次输出何时 flush 暂存；不得实现两套不一致的转义规则。

### 稳定前缀算法

- 每次从本版本累计 raw text 计算可安全发布的规范前缀，与“已成功写出的规范正文”比较后，仅写新增后缀。MessageRenderState 明确区分业务 `businessSealed`、局部 `outputMode=follow/snapshot`、pendingTail 与 localFlushComplete，不能用一个 final 标志兼任这些含义。
- 未封口 text 末尾若是 `\r`，暂存，不立即转义；下一版本若补 `\n`，一次输出规范换行，若补其他字符，则输出转义后的回车再继续。
- 未封口 text 末尾若是高代理项，暂存等待低代理项，避免两次 write 分别变成乱码。对已确定不成对的代理项和终态／Part 封口仍不成对的代理项，按 JS UTF-8 写出等价的 U+FFFD 规范化，保持整体快照和流式一致。
- 业务封口是出现后继布局 Part 或消息进入 completed/failed/cancelled；此时释放尾部暂存。follow 的 streaming 输出继续等待这些业务条件；中断不冒充正常局部完成，也不补发未结束消息 ID。
- 非 follow 快照结束另有局部输出 flush：完整规范化所读 raw 版本，即使消息仍 streaming，也将尾部 CR 写为转义的反斜杠加 r、孤立高代理写为 U+FFFD，再置 localFlushComplete。该 flush 不设置 businessSealed／消息终态／ReleasedIdentity，不显示消息 ID，也不改变服务端状态。
- 快照 writer 本次输出随后结束，不接收同一输出中的未来版本；之后独立调用创建新的渲染状态。字符规范仍相同，只有 follow 稳定前缀与 snapshot_end 的 flush 边界不同。
- 后继可见 Part 的分隔符仅在前一 Part 尾部暂存处理完后写；不得先写分隔符、后补代理项／回车。
- 不允许对每个 raw delta 独立 `displayBody` 后拼接。示例 `"A\r" → "A\r\nB"` 必须等价于一次渲染 `"A\nB"`；`"A\uD83D" → "A\uD83D\uDE00"` 必须只输出一个完整 emoji。
- 如规范前缀不能延伸已写正文，视为渲染／契约错误而非网络故障。背压回调成功后才推进 writtenLength；输出失败立即交生命周期处理。

## 终态、作废和失败的转换

| 当前内部状态 | 事件 | 动作 |
| --- | --- | --- |
| 未展示 | 可见 streaming | 写角色标题及稳定正文，不给 ID |
| active 草稿 | 合法 raw 追加 | 写规范新增后缀 |
| active 草稿 | completed/failed/cancelled | 业务封口、补正文、写真实状态及 ID，转 final |
| snapshot 中 streaming | 本次快照读取结束 | 局部 flush 完整所读版本，业务状态仍 streaming，无消息 ID |
| active 草稿 | 已验证同 Run 替换 | 分隔旧段、标记作废，不给旧 ID，新尝试独立状态 |
| 任意未终结状态 | SIGINT／时限／网络耗尽 | 不发消息 footer ID；任务收尾 complete=false |
| final／硬历史 | 被替换或改变 | 失败停止，不撤销已发 ID、不自动映射 |
| 任意状态 | stdout EPIPE | 退出 141，不保证 terminal，不重试输出、不取消 Run |

## 实施限制

- 不建立持久化重放日志或输出撤销机制；内存状态只保留本命令验证和输出所需数据。
- 原已验证 idle、Fork 来源、compaction、主／子会话访问等测试应迁移而不是删除。
- 整体观察范围和 Part 身份校验失败不得被“流式尽量继续”掩盖；已经显示的草稿保留在输出记录中，并明确作废或不完整。
