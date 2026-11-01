# 同 Run head 替换证明：shared/API 最小增量

## 必要性与设计前基线

- REQ-REPLACE 要求跨轮询连续自动重试仍能跟随同一 Run，不能仅在恰好看见每个中间尝试时成立。
- [Worker：replaceAssistantForRetry](../../../apps/agent-worker/src/runtime/runner.ts) 调用 `replaceStreamingAssistant`，然后换用 newMessageId 并清空 orderedParts。
- [store：replaceStreamingAssistant](../../../apps/api/src/modules/agent/agent-message.store.ts) 在事务中校验 fence、当前 head、streaming 状态和来源，将旧行改为 superseded，新行保持相同 previous/depth，`replacesMessageId` 指向直接旧行，并移动 head。
- [read-side：SqliteMessageQuery.getTimeline / getMessage](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts) 仅返回当前展示链。`A → B → C` 中 A/B 不再可见，普通消息详情不能取回 B。
- 设计前的 [AgentTimelineDeltaResponseSchema](../../../packages/shared/src/contracts/agent-message.ts) 无替换摘要，且 `additionalProperties:false`；没有 schema 增量时临时添加字段可能被响应序列化丢弃。
- 因而本项是新发现并已批准的必要支撑，不是既有能力；不修改 Worker 写入语义，不新增数据库记录或任意旧消息查询入口。

## 选定契约

### 请求

- 复用 `GET /api/agent/sessions/:sessionId/timeline` 的已有参数：`workspaceId`、`mode=delta`、`sinceRevision`、`knownHeadMessageId`、已知 root 参数、limit。
- 不新增任意历史消息 ID 列表／查询接口。snapshot/before 普通调用不要求也不生成证明。
- 只有有效 delta 请求明确携带 knownHead 且存在合法后继关系时才可能返回摘要；knownHead 不存在、仍可见、sinceRevision 无效或不存在可证关系时省略该字段。
- delta 因 head/root 变化返回 `timelineReset=true` 时，仍可同时提供证明；证明与新的尾部 snapshot 属于同一响应视图。

### 响应的可选字段

建议在共享契约中定义严格对象 `AgentHeadReplacementProofSchema` 并导出其类型，作为 `headReplacement?: AgentHeadReplacementProof`：

| 字段 | 类型／范围 | 含义 |
| --- | --- | --- |
| `workspaceId` | 非空 ID | 本次请求工作区 |
| `sessionId` | 非空 ID | 当前展示链所属 Session |
| `runId` | 非空 ID | 所有替换节点共同的原生 Run |
| `fromMessageId` | 非空 ID | 请求的 knownHead，不是任意旧行 |
| `toMessageId` | 非空且不同于 from | 当前可见同槽位后继，不一定是 session.head |
| `previousMessageId` | ID 或 null | 所有替换节点共同的前一消息 |
| `depth` | 非负整数 | 所有节点共同深度 |
| `fromSupersededRevision` | 非负整数 | from 被合法替换的 revision，必须大于请求 sinceRevision |
| `toUpdatedRevision` | 非负整数 | 候选在本响应视图中的 updatedRevision |
| `toStatus` | streaming/completed/failed/cancelled | 候选当前状态；superseded 不可作为可见候选 |
| `replacementCount` | 整数 1..256 | 本次服务端验证的替换边数，不是 CLI 网络重试数 |
| `atRevision` | 非负整数 | 必须等于本响应 session.revision |

- 对象为常量字段数量，无中间 ID 数组、正文、reasoning、工具输入、结果、私有 replay、URL 或鉴权字段。
- `toStatus/toUpdatedRevision` 允许候选不在尾页时先保留已认证身份头，再通过正常可见链分页取得正文；不得将该头当成正文已读取或 ID 可公开。
- 缺省用“字段不存在”，不同时定义 null／empty／另一套错误摘要。
- Fastify 路由直接复用更新后的共享 schema；保留原 timeline/session/messages/toolExecutions/分页字段含义。入口：[agent-public.routes.ts](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts)。

## 服务端算法

### 同一一致性读视图

- 将 `getTimeline` 中 requireSession、reset 判断、当前链页、Part、execution 及证明查询放入同一个同步只读事务／快照，返回后结束事务。
- 可以使用 better-sqlite3 现有事务能力，不在事务内 await，不持有事务跨 HTTP 分页，也不引入新锁服务。
- 不能先读 session.revision，退出快照后再查替换链；否则 atRevision 只是标签而非事实。

### 找到旧槽位的当前可见候选

- 在当前授权 Workspace/Session 下处理请求；按 from ID 读取最小 Message 行，不读取 Part。
- from 必须 workspace 相同、type=assistant、status=superseded、originSessionId 等于请求 session、originRunId 非空。
- 在该 Session 的当前展示链中查找相同 depth 和 previousMessageId 的可见 assistant 候选。可复用展示链 CTE，在越过所需深度后停止，不查询其他 Session 的链。
- 不能只检查最终 session.head。例如当前链为 `P → C → D → E`，旧 A/B 位于 C 的槽位，候选必须是 C，而不是 E。
- 候选必须同 Workspace、原生 Session、Run，且为 streaming/completed/failed/cancelled；找不到唯一合法候选或候选等于 from 就不出具证明。
- 相同 depth／previous／Run 只是定位候选，绝不是证明结论。

### 反向验证 replaces 链

- 从候选开始沿 `replacesMessageId` 反向走，目标精确为请求 knownHead。
- 每个节点只读取身份、来源、结构、状态和 revision；使用 visited 集合发现循环；最多跨越 256 条替换边。
- 每条边 child→parent 必须满足：
  - child.replacesMessageId 精确等于 parent.id；两者 ID 不相同。
  - 两者 workspace、originSessionId、originRunId、type=assistant、depth、previousMessageId 全部一致，且与本请求／候选一致。
  - parent.status=superseded；除最终可见候选外，经过的 child 也必须 superseded。
  - 所有 revision 非负且不超过本响应 session.revision。
  - parent.updatedRevision 表示其 superseded revision。若 child 也已 superseded，则 child.updatedRevision 必须严格大于 parent.updatedRevision；对最终可见 child，其 updatedRevision 必须大于等于 parent.updatedRevision。
- 成功到达 from 后，还要求 from.updatedRevision 大于请求 sinceRevision、候选 updatedRevision 大于等于 from.updatedRevision，并输出摘要。
- 断链、循环、跨范围、非法状态、previous/depth 不一致、revision 不合法或走完 256 边仍未到 from：省略证明，不抛出泄露内部图信息的异常。
- 恰好 256 边可成功，第 257 边不能再读取以“试试看”；最多读取候选及 256 个前驱的必要头信息。不得以无界 CTE 返回完整替换链。
- 该限制是防损坏读侧资源上限；[settings.ts](../../../packages/shared/src/contracts/settings.ts) 当前模型重试次数上限 100 并不替代防御校验，也不是反过来把 CLI 整个 Run 限为 256 次。

### 失败行为与隔离

- 不满足证明条件时仍按既有 timeline 规则返回合法 delta/reset 响应，`headReplacement` 缺省；客户端无法解释旧草稿丢失时以观察不完整失败。
- 不返回具体损坏链、候选私有信息或“旧 ID 存在于别的 Session”等探测结果。
- 不改变普通 getMessage 的可见链限制，旧草稿仍为 404。
- 不通过 HTTP 500 表示普通“无证明”；真正系统故障仍沿既有安全错误处理，CLI 也不把 500 自动重试。

## 客户端二次验证

客户端收到摘要不等于无条件豁免链规则，必须同时验证：

- 先校验摘要 schema、请求 from、workspace/session、atRevision 等响应绑定。只有需要据此豁免本地受保护草稿时，才进入下列目标 Run／streaming 缓存资格校验。
- API 不知道 CLI 固定的目标 Run。若全局 head 已是后续 Run 的未选择／未输出后缀，其合法摘要不能误判为“服务端返回错误 Run”；不应用该摘要豁免目标范围。已知 r1 终态后只按 FinalDrain 的两个 pass 核实相关范围，不能为该后缀无限 reset 重建，也不能借此忽略目标草稿丢失。
- from 等于该次请求的 knownHead，workspace/session 匹配，atRevision 等于同响应 session.revision。
- sinceRevision < fromSupersededRevision <= toUpdatedRevision <= atRevision；replacementCount 在 1..256，from/to 不相同。
- 本地 committed 或 stage 缓存的 from 确实是该请求观察过的 head、目标 Run 原生 assistant、当时 streaming，且 raw.updatedRevision <= sinceRevision。
- idle 有界关闭时，“目标来源”仅指关闭前已核准且已验证终态的 sourceRunId；不得因为收到摘要才猜测来源或转为监听另一 Run。
- from 未成为 final、未发布 footer ID，不属于显式 after 或其他硬保护历史；仅自动 initial head／last streaming 槽位可以转换。
- 本地 from 的 depth/previous/来源与摘要完全一致；只同 Run 不够。
- to 的摘要头与本响应中的对应消息一致；若不在尾页，必须通过可见分页取得并在关闭 delta 后核对其最新版本／后继证明，不能把未读正文标为 complete。已进入 FinalDrain 后，若关闭读才发现还需分页取得候选，只能使用剩余的第二 pass；第二 pass 再不充分即 incomplete，不发第三次关闭读。
- 证明不得用于豁免第二个受保护消息的消失，也不能代替硬历史保留、完整 previous 链、root/reset、消息 Part 与目标范围校验；未选择／未输出的 r2 后缀不因未获得目标例外就一律失败。

分类规则：

| 情况 | 处理 |
| --- | --- |
| 合法摘要、from 为可变目标草稿 | 将该槽位映射到 to；旧展示段作废，继续固定 Run |
| 用于目标替换例外的摘要字段／来源／revision／缓存不匹配，或响应绑定本身非法 | RESPONSE_INVALID/6，complete=false |
| 无摘要且旧草稿仍应保留却消失 | TIMELINE_CHANGED/6，complete=false |
| 显式 after 恰为 from | 仍按锚点失效停止，不改写用户选择 |
| from 已输出终态 ID | 严格失败，不撤销或重新映射已发布消息 |

所有失败诊断均不得显示 from/to 草稿 ID。

## 跨轮询、跨页与 reset

- A→B→C 在一次轮询之间发生：API 一次验证两条边，返回 from=A、to=C、count=2；B 不下发。
- 若原 head A 消失导致 reset，证明与 reset 尾页一起返回；客户端先确认唯一可变槽位例外，再补齐其他保护前缀。
- 若 C 后续已有大量 D/E 等完成消息、C 不在 limit 尾页，API 仍定位 C 并给摘要；客户端分页直到 C 及所需保护边界，不能只处理最新 head。
- before 页不生成替换摘要，不能把分页页头的新 revision 当 delta watermark；在分页移动时按[状态机](03-follow-state-and-rendering.md)作关闭 delta。已知 r1 终态时，每 pass 从自己的固定起始 head/revision 向前读，最多一个关闭 delta，不把后来 r2 新追加纳入必读范围。
- 运行期重建间 C 又变为 F，可通过下一次携带已观察 head 的 delta 证明；非目标后缀持续变化时先让出查询固定 r1 状态。已知终态后，新的证明／页 cursor 恢复／root reset 都服从 FinalDrain 同一两 pass 预算：BUILD 需要新定位则转本 pass 唯一 CHECK，必要时只启动第二 pass；不得在 CHECK 后补页再关闭或重置预算。
- 关闭 delta 的非目标追加／更新不要求重建；reset 响应自身足够证明相关范围时也可直接结束。只有必须重新定位才消耗第二 pass；第二次关闭仍不充分时 OBSERVATION_INCOMPLETE/6、complete=false，保留 r1 已知结果。
- 若保护前缀也被回滚，哪怕目标草稿确有合法替换，整轮仍失败。

## 无新实体与兼容性

- 不新增表／迁移、Worker 方法、配置项、鉴权、订阅或 proof 缓存服务；读取已有 Message graph 即可。
- 更新共享 export、API 响应 schema、CLI parseTimeline 类型与校验。必要类型通常由 [shared/src/index.ts](../../../packages/shared/src/index.ts) 既有消息契约导出链覆盖，实施时核查。
- API 可选字段对旧调用者不强制；新 CLI 对旧 API 无证据时安全失败，不以相似结构猜测继续。
- 不改变 getTimeline 已有 knownHead/root reset 含义；证明是对 reset 原因的受限解释，不是禁用 reset。
