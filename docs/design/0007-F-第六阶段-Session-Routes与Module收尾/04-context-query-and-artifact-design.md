# Context Query、Peripheral Agent Query 与 Artifact 目标设计

## 最终结论：独立 `ContextQueryApplication`

Context Query 最终不作为 Session read model 的内部子模块，而是与 Session / Interaction 并列的独立 application。

### 选择理由

- 查询对象不仅是 Session metadata，还包括 transcript pagination/head consistency、run-state projection、execution profile 派生 token window、artifact authorization 和 status summary；
- 它有独立的一致性错误语义，例如分页模式互斥与 head moved conflict；
- 它需要组合 session/context/run/workspace/settings 的只读 capability，但不需要 Session command 或 Lifecycle mutation；
- 独立后可强制 `Context Query → query persistence / artifact capability`，禁止 `Context Query → Context Writeback`；
- 如果归入 Session read model，Session 域会同时拥有 create/fork/send/revert、复杂分页、artifact authorization 和 plugin status projection，仍然是新的大 service。

### 未选择方案

| 方案 | 不采用原因 |
|---|---|
| Session read model 内部子模块 | 责任跨度过大，query 规则和 command 重新耦合 |
| 并入 Read-side / Prompt | Worker prompt projection 与 UI transcript/artifact query 的合同、缓存和错误语义不同 |
| 并入 Context Writeback | 违反 read/write 单向依赖，容易让只读入口持有 mutation 能力 |
| route 直接查 Store | transport 承载业务分页、授权与聚合，无法独立测试 |

## 两个只读 application 的唯一 owner

| Application | 唯一拥有的 use case |
|---|---|
| `ContextQueryApplication` | context list/item/tail、public run-state、UI artifact read authorization、session status summary |
| `PeripheralAgentQueryApplication` | recent sessions、recent workspaces、run final text、available agents |

补充约束：

- context tail 虽由 Feishu/外围 internal route 调用，核心规则仍是 transcript tail query，owner 必须是 `ContextQueryApplication`；
- session status summary 的主体是 session/run projection，owner 必须是 `ContextQueryApplication`；
- status summary 如需 agent display name，可依赖窄 `AvailableAgentQuery` collaborator；该 collaborator 只解析 available-agent/display-name 信息，不改变 status summary 的 application owner；
- `PeripheralAgentQueryApplication.listAvailableAgents()` 是 available agents endpoint 的 application owner，也通过窄 `AvailableAgentQuery` collaborator 完成 workspace/surface/enablement/order 规则；
- 两个 application 可以共享底层只读 capability，但 `PeripheralAgentQueryApplication` 不得持有完整 `ContextQueryApplication`，`ContextQueryApplication` 也不得调用完整 `PeripheralAgentQueryApplication`。

## Context Query 能力分层

建议 Context Query application 内按协作职责分为若干私有 collaborator，不要求全部公开成类：

```text
ContextQueryApplication
  ├─ TranscriptQuery
  │    ├─ list windows
  │    ├─ item in visible transcript
  │    └─ head/applied projection
  ├─ RunStateProjection
  │    ├─ active/terminal run
  │    ├─ token window/ratio
  │    └─ elapsed/notice
  ├─ ArtifactReadUseCase
  │    ├─ transcript authorization
  │    └─ UiArtifactCapability.read*
  └─ SessionStatusProjection
       ├─ session/run summary
       └─ AvailableAgentQuery（仅 display name 协作）

PeripheralAgentQueryApplication
  ├─ recent sessions/workspaces
  ├─ run final text
  └─ available agents → AvailableAgentQuery
```

两个 application 均可在内部使用少量私有函数或窄 collaborator，但 application owner 与公开 use-case 集合按上表固定，不得合并成一个笼统 query service。

## 错误映射规则

- `ContextQueryApplication` 与 `PeripheralAgentQueryApplication` 可以直接抛 `HttpError`，并负责查询参数、not-found、conflict、workspace/surface 等业务错误的既有 status/message/code；
- route 默认不翻译 query/domain error，只做 schema/auth/parse/success status；
- `sessions/status-summary` 保留当前 generic bridge：已是 `HttpError` 的错误原样抛出，其他未知错误统一为 `500 SESSION_STATUS_SUMMARY_FAILED`；
- 除已冻结 generic bridge 外，不得新增 route 级 domain error 映射，也不得形成 application/route 各映射一部分同层级错误的混合口径。

## Transcript query 设计

### 输入规范

```ts
type ContextItemsQuery = {
  afterId?: number;
  tailLimit?: number;
  beforeId?: number;
  limit?: number;
  expectedHeadItemId?: number;
};
```

保持当前宽容数值规范化和下列规则：

- `afterId`、`tailLimit`、`beforeId` 中最多一个为有效正数；
- 多模式返回 `400 AGENT_CONTEXT_ITEMS_QUERY_INVALID`；
- `beforeId` 模式默认 `limit = 100`；
- `expectedHeadItemId` 只在 before 模式参与 head 回退保护；
- 允许 head 向前追加，不允许 head 回退后继续沿旧链分页；
- response 继续返回 session id、当前 head、run-state applied item、items 和可选 `hasMoreBefore`。

### Query persistence

应用层可保留模式选择，但各查询必须通过命名 query capability：

- `getSession`；
- `listTranscript`；
- `listAfterWindow`；
- `getTailWindow`；
- `getBeforeWindow`；
- `getRunState`。

这些查询不需要事务对象化，但不得向 route/facade 暴露底层 DB。

## Item query 与 visible-path authorization

`getContextItem(sessionId, itemId)` 必须继续：

- 先验证 session；
- 按 session workspace + session id 查询当前 visible transcript path；
- 不使用全局 `getContextItemById` 直接授权；
- item 不可见、跨 session 或不存在均返回现有 404。

这条规则是 artifact read 和 UI transcript 安全边界。

## Artifact read owner 与能力边界

### Context Query 拥有

- session/item 可见性授权；
- tool kind/output/toolName 校验；
- toolCallId 提取与空值处理；
- 选择 apply_patch 或 write artifact read；
- 对外 404 文案/语义。

### `UiArtifactCapability` 拥有

- 固定 artifact path 计算；
- tmp root containment；
- safe directory、realpath containment；
- no-follow read/write；
- regular-file 检查；
- JSON serialize/parse；
- 非法/不存在/解析失败的现有 not-found 语义。

### Context Writeback 拥有

- 哪些 tool/status 产生 artifact；
- full result 与 slim result 拆分；
- artifact createdAt；
- write failure logging；
- artifact 写入后 DB context update 的既有顺序。

### 明确禁止

- Query import `ContextWritebackApplication`；
- route import `fs`、`path` 或 artifact path helper；
- artifact capability 接收 session/item 并自行做 DB authorization；
- 为“统一”而改变 apply_patch/write artifact JSON 格式或错误语义；
- 将 capability 扩成任意路径读写接口。

## Run-state 与 status projection

### Public run-state

`getRunState(sessionId)` 保持当前 projection：

- session not found 为 404；
- durable state 缺行时仍按 store 默认 idle；
- latest terminal status 只在 state idle 且 timestamp 对齐时展示；
- activeRunId 缺失或归属异常时记录 warning，projection 中 activeRun 为 null；
- context run 优先 active、否则 latest terminal；
- profile resolve 失败按当前策略 warning 并令 `contextWindowTokens = null`；
- elapsed、last token、ratio、notice/applied item 字段保持。

### Session status summary

Feishu 使用的 status summary 虽位于外围 internal route，但 owner 明确为 `ContextQueryApplication`。其主体是 session/run projection；agent display name 通过窄 `AvailableAgentQuery` collaborator 获取。外围 handler 不得直接操作 `AppContext`，也不得改由 `PeripheralAgentQueryApplication` 转发。

`status-summary` 当前 unknown error 到 `500 SESSION_STATUS_SUMMARY_FAILED` 的 generic bridge 必须保持；application 抛出的 `HttpError` 必须原样保留。

## Recent、workspace、final-text 与 available agents

这些入口不是 Worker 核心 internal contract，其唯一 owner 为 `PeripheralAgentQueryApplication`：

- recent sessions/workspaces；
- run final text；
- available agents。

固定规则：

- recent limit/kind clamp、workspace query、final-text found/text projection、available-agent workspace/surface/enablement/order 均由 `PeripheralAgentQueryApplication` 拥有；
- `PeripheralAgentQueryApplication` 不得反向调用完整 `ContextQueryApplication`；
- route 只保留 plugin header/body 一致性、internal token 等 transport authorization；
- `agents/list` 的 workspace exists、surface=user、workspace enablement、sort 迁出 route；
- internal primary create/run trigger 是写侧入口，继续调用 `SessionInteractionApplication`，不属于任何 Query application；
- status summary/context tail 继续调用 `ContextQueryApplication`，不得因位于同一外围 route 文件而改归 `PeripheralAgentQueryApplication`；
- 不把这些 endpoint 加入 Shared Worker endpoint registry，除非另立协议治理阶段。

## 两个 Query application 的验收要点

- `AgentService` 中不再有 pagination、artifact authorization、run/status aggregation 或 peripheral projection 代码；
- Context Query 生产代码不 import Writeback；
- `ContextQueryApplication` 唯一承接 context tail 与 status summary；
- `PeripheralAgentQueryApplication` 唯一承接 recent sessions/workspaces、run final text、available agents，且不持有完整 Context Query；
- route 不直接访问 artifact capability 或文件系统；
- visible transcript authorization 有独立测试；
- public context/artifact/run-state 与 Feishu status/tail 集成测试保持；
- agents/list route 不再读取 workspace/settings/AppContext；
- 两个 Query application 全程只读，不产生 run/context/session mutation。
