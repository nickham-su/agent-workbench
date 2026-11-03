# 前端与 CLI 方案

## 前端状态分工

| 数据 | 权威来源 | 禁止的推断 |
| --- | --- | --- |
| Session 元信息及 visibility | 按 ID 响应／受保护元信息缓存 | GET 读到会话就自动显示 Tab |
| 已打开集合 | tabs 完整快照中的 openedSessionIds | 从 kind 或 listed 推断打开 |
| 单次开闭确认 | PUT 成功响应 | 请求超时就断言未提交 |
| 本地用户意图 | single-flight 控制器 desired／inFlight | 旧快照覆盖较新意图 |
| 草稿展示 | 本地草稿状态 | 给未持久化草稿写服务端 TabState |

- `scope=continuable` 继续服务“选择会话”；`scope=tabs` 恢复已打开界面，是不同用途。
- 兼容数组只供旧 API 消费者使用；新前端不得根据 `closedSessionIds`／`openedSubtaskSessionIds` 合成 kind 或开闭默认。
- 元信息与开闭状态分别缓存；未知开闭可以暂不展示，但必须是“尚未确认”，不能记成服务器已关闭。
- 全局状态 Store 只登记实际展示／用户打开意图所需的会话，不能为了状态查询把所有隐藏会话加入普通展示集合。

## Tab 初始化与完整快照

### 响应校验

- 校验 scope、Workspace、openedSessionIds 的唯一有效 ID、items 的完整 Session（含 visibility）及两者集合相等。
- items 保持服务器顺序；openedSessionIds 的稳定排序不替代会话顺序。
- 失败进入现有初始化失败／重试体验，不能把非法响应当空快照显示“无会话”。
- 独立状态接口没有元信息，不根据 ID 数组猜测 kind；需要元信息时按 ID 加载或使用 tabs 原子快照。

### 合并算法

- 发请求前捕获既有 metadata read 快照和 Tab visibility 快照，包括 intentSeq、confirmationEpoch、pending；沿用 Workspace generation、请求 attempt 和 dispose 检查。
- 响应仅安装当前 Workspace／当前请求上下文，迟到旧 Workspace 响应不更新本地或持久 active key。
- 对请求采集后没有新意图／确认的会话，按完整 opened 集合协调 Tab 成员及已知状态；未列出的已知成员可确认为该快照时刻不打开，但不能当作 Session 已删除。
- 请求采集后新增的会话缓存、草稿转真实 Session、进行中请求、较新确认均受保护。新学到的 ID 不得因旧快照遗漏而被写成 confirmed=false。
- 保护的会话保留 desired／confirmed 及成员资格；不能只保护布尔值却从 visibleSessionIds 删除，使界面仍然闪退。
- 快照不清空通用 Session 缓存；部分缓存、单条 GET 或活动查询更不能用作完整 Tab 集合。
- 这保留现有本地并发保护，不新增跨客户端实时同步。另一客户端稍后提交的变更要等重新读取才可见，沿用当前 Workspace 共享状态模型。

## 显式打开与关闭

### 普通按 ID 打开

继续复用任务按钮 `host.call('agent', openSession)` → Workspace 打开意图 → AgentToolView：

- 按 ID 读取最新完整元信息；沿用来源 Workspace、意图顺序和 abort 保护。
- GET 成功不因 unlisted 拒绝，也不把它加入选择会话候选。
- 注册显式 `visible=true` 意图，普通 Tab 乐观显示并激活，等待 PUT 提交确认。
- PUT 明确失败按现有 receipt 回退到仍可见的来源／此前 Tab；不先关闭来源。读取失败不创建假 Tab，状态错误提供可诊断提示。本地回退不是服务器状态证明，超时／unknown 仍按下述不确定契约处理。
- 打开提交确认后刷新由 openedSessionIds 恢复；关闭写 `visible=false`，不会删除状态行，也不更改 visibility。只有服务端关闭已确认，且之后没有其他打开写入，才保证刷新不再出现，不能以本地消失或请求已发出代替确认。
- 切 Workspace、连续打开不同目标、关闭组件时，旧意图和迟到确认不得激活错误目标。
- 在有效上下文内，开闭失败应提示并沿用现有回退／后续读取协调；unknown 不宣称已开或已关，不自动重复创建 Session，也不新增后台补偿。上下文失效后不向新界面提示旧错误或派发补偿；失效前已发出的请求仍可能提交，后续有效读取以实际状态为准。

### 状态控制器改造

- 删除 `defaultAgentSessionTabVisibility(kind)` 作为持久会话 fallback；是否打开仅为 desired、confirmed 或完整快照成员。
- 保留 `nextIntentSeq`、confirmationEpoch、uncertainCommit、single-flight 队列及较新意图保护。
- 同一 Session 的开→关→开继续串行合并，旧请求失败不得推翻后续意图。mutation 响应身份不匹配视为失败，不能确认错误会话。
- 超时可能已提交：沿用 uncertainCommit 语义，后续有效完整快照或明确新意图协调，不猜测默认值或偷偷删除记录；不得把未确认关闭写成 confirmed=false，也不得保证该会话刷新后已关闭。
- 关闭仅影响展示。运行中隐藏会话可正常关闭，任务继续；状态轮询／未读／提示按当前显示规则处理。

### 草稿转真实 Session

- 草稿只在本地展示，不进入 Tab PUT 队列。
- 创建真实 Session 的响应不携带独立 TabState 事实，因此不能用“它是 primary”安装 confirmed=true。
- 只有创建响应所属 generation／Workspace／组件上下文仍有效时，才迁移草稿、登记真实 Session，并将当时草稿 visible 显式提交到正常队列；即使常见情况下等于服务器初始值，也不走按 kind 跳过确认的分支。
- 不绕过 `isResponseWritable()` 或控制器的上下文保护；不增加跨组件后台补偿。创建响应前已切 Workspace 或组件销毁时，只沿用原返回行为，不迁移／登记／激活该 Session、不提交新的关闭意图、不污染新界面。

| 情况 | 必须行为 | 刷新保证 |
| --- | --- | --- |
| 创建成功，响应上下文有效，开闭尚未确认 | 迁移真实 ID 并显式提交当前草稿意图；本地展示不代表服务端状态 | 服务器已持久化初始状态；普通 listed primary 初始为1，不能仅因创建中关闭草稿就保证不再出现 |
| 创建中关闭草稿，随后关闭 PUT 成功确认 | 记录实际 visible=false，保留 generation／receipt 和迟到快照保护 | 无后续打开写入时，刷新不再出现 |
| 关闭 PUT 明确失败或结果 unknown | 有效上下文提示失败／未确认并按现有机制协调；不重复创建，不声称关闭已持久化 | 明确失败按真实已存状态加载；unknown 可能已提交或未提交，以后续有效读取为准，允许重新出现 |
| 创建响应返回时上下文已失效 | 不迁移新 Session、不登记到新 Workspace、不提交新的关闭意图，也不发后台补偿 | 已创建 Session 保持实际已存状态，普通 listed primary 的初始 visible=1 可能在后续加载显示；这是本期明确限制 |

- 创建失败仍按原流程提示／处理；不能把关闭 PUT 失败当成创建失败而再次创建。创建已成功但上下文失效也不撤销已落库 Session。
- 失效前已发出的 PUT 不保证被撤销；旧回调不得更新新界面或追加补偿。较早快照、重复响应、快速切换和普通开闭采用相同确认／unknown 边界，验收见 ACC-WEB-DRAFT 系列。

## 定时任务页面

- 不增加可见性开关或独立查看面板。既有最近执行、历史行“查看 Session”沿用普通 Tab 流程。
- 按该执行 sessionID 打开，保留 sessionAvailable 校验。预分配 ID 和 unrelated Session 不构成可导航资格。
- 原执行状态始终按 execution.runId／去重关联展示；普通 Tab 后续产生其他 Run 不覆盖原执行结果。
- 来源“查看上下文”继续按源 Session ID 打开，不拒绝 unlisted。当前入口并不定位固定历史 messageID，本次不新增定位能力，不宣称已具备锚点定位。
- 页面现有 30 秒列表／历史刷新不被描述为实时流；打开 Agent Tab 后使用已有定向时间线／状态刷新，不改全局 SSE。
- 删除任务提示继续明确“执行历史删除，已有 Session 和 Run 保留”。

## CLI

### 参数与请求

```bash
awb session fork -w <workspaceID> -s <sessionID>
awb session fork -w <workspaceID> -s <sessionID> --unlisted
```

- `--unlisted` 为布尔 flag，不接受值；离线 help 可用。保留必填 -w/-s 和多余参数拒绝。
- 未指定 flag 时省略请求 visibility；指定时发送 `visibility:'unlisted'`。来源隐藏即使未指定也继承隐藏。
- 源读取仍校验 Workspace、ID、primary、非空 head；GET 后仅一次 Fork POST，不查消息列表或 run-state 选点。
- 不加 title、messageID 或 follow 参数，不扩展此命令为自动总结。

### 响应与输出

- 更新 `sessionRecord()` 手动投影及校验，visibility 必须是合法枚举；响应缺失／错误不得默认为 listed。
- 原新 ID、primary、来源会话及 fromMessageId/head 身份检查全部保留。
- 校验最终 visibility：显式隐藏或已读来源隐藏时必须返回 unlisted；来源 listed 且未要求隐藏时返回 listed。后端来源属性不可变，因此无 GET→POST 可见性漂移。
- 成功自然语言输出保留新 Session、Workspace、来源和 Fork 消息，并增加“会话可见性：listed／unlisted”，便于自动调用者确认实际结果。
- 隐藏不妨碍 `session show/send/messages/status` 和 follow；普通 session list 始终不返回隐藏，即使它已打开 Tab。

### 错误及受理证据

- 保留 `phase=fork`、effect 和新 Session 身份合并机制；本地拒绝 not_sent、服务器拒绝 rejected、POST 结果不明 unknown、响应确认后本地保存／stdout 失败 accepted。
- 结果不明不能自动重试创建；成功后输出失败也不能退回“未发送”。
- 空会话、运行中不稳定历史、待执行工具、compaction 边界等由现有后端决定；新 flag 不改变其 HTTP／CLI 错误类别。
- 帮助和 README 说明 unlisted 不是权限隔离、不自动删除、不隔离工作区，且可以被已知 ID 主动打开 Tab。
