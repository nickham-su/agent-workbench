# 测试、独立审查与验收标准

## 测试策略

本阶段以“不改行为的结构迁移”为目标，测试必须同时覆盖：

- application owner 与最小 port；
- SQLite 原子/竞态边界；
- route 合同和 transport 错误；
- local/remote API↔Worker 主链；
- Plugin/Feishu 外围调用；
- 源码依赖方向与无残留。

不得只依赖大集成测试绿色，也不得用 fake persistence 替代 lifecycle/revert/fork 的真实 SQLite 证据。

## 错误映射验收规则

- application 可以直接抛 `HttpError`，测试应直接断言其既有 status/message/code；
- route 默认只验证 schema/auth/parse/success status，不建立 domain error translation test matrix；
- status summary 的已知 `HttpError` 必须原样传播，未知错误必须由既有 generic bridge 转为 `500 SESSION_STATUS_SUMMARY_FAILED`；
- plugin host unavailable、archive 等既有 transport bridge 继续按 endpoint 现状测试；
- 审查不得接受同层级错误在 application 和 route 间随机分摊映射。

## Session / Interaction 测试矩阵

| 用例 | 关键断言 |
|---|---|
| list/create | workspace 404、primary kind、默认/trim title、返回 record |
| public/internal create | 同一 application entry；extra key/kind transport guard 保持 |
| public fork | primary-only、boundary、visible/archive mode、补偿和 fault seam 保持 |
| send missing/subtask/mismatch/empty | status/error code 与验证顺序保持 |
| send dedup | 不 resolve profile、不 activation、不 enqueue |
| send running | 409；transaction 内仍二次权威检查 |
| send activation | 单 transaction 动作集合与 first title 保持 |
| send enqueue failure | 条件性 fail/idle settlement，不污染新 run |
| send text | context item 为 trim text，runtime input 为原始 text |
| revert invalid/archive/running/non-terminal | 既有 400/409/code 保持 |
| revert head conflict | CAS conflict 保持，不覆盖新 head |
| revert runtime failure | 当前本地无抛错/远端内部吞错事实有证据；application defensive catch 模拟未来 runtime 抛错时，DB 已提交、HTTP 仍成功、warning 可诊断 |
| cancel | 继续使用 Lifecycle，DB-first/cascade/runtime best-effort 保持 |

## Context Query / Peripheral Agent Query / Artifact 测试矩阵

| 用例 | 关键断言 |
|---|---|
| context full/after/tail/before | items、head、applied、hasMoreBefore 保持 |
| mixed pagination | `400 AGENT_CONTEXT_ITEMS_QUERY_INVALID` |
| head forward | before 分页允许 |
| head rollback | `409 AGENT_CONTEXT_ITEMS_HEAD_MOVED` |
| item visible path | 跨 session/不可见/global id 不可绕过授权 |
| apply_patch/write artifact | tool kind/name/call id 校验后读取 |
| artifact path/symlink/no-follow | 既有 safe-file-io 语义保持 |
| malformed/missing artifact | 既有 404 语义 |
| writeback artifact | split、write timing、log、slim DB output 保持 |
| run-state | active/terminal、elapsed/token/ratio、warning fallback 保持 |
| status summary（Context Query） | selected agent/displayName、`HttpError` 原样传播、generic 500 bridge 保持 |
| context tail（Context Query） | transcript tail 规则与 token/header/body pluginId/sessionId 顺序保持 |
| recent/workspace/final text/agents（Peripheral Agent Query） | clamp、not found、sort、surface=user 保持 |
| owner isolation | Peripheral Agent Query 不持有完整 Context Query；status/tail 不经 Peripheral Agent Query 转发 |

## Route 测试矩阵

- 对 P0 inventory 中每个 endpoint 至少保留一项 route registration/contract 证据；
- public/internal compact 共用 application 但各自 auth/status 保持；
- Worker Shared endpoints method/path/schema 保持；
- Plugin Host unavailable 仍为 503；
- archive search/read invalid result 仍映射既有 400；
- application `HttpError` 除冻结 bridge 外不被 route 二次映射；
- status/tail route 与 recent/workspaces/final-text/agents route 分别调用唯一 owner；
- SSE：headers、connected chunk、heartbeat、event id/type/data、close unsubscribe；
- 分组后无重复 route、无遗漏 route；
- route source 不含 Store/AppContext/filesystem/业务 sequencing。

## Module / Startup 测试矩阵

| 场景 | 关键断言 |
|---|---|
| startup order | orphan cleanup 在 archive reconcile 前，之后才配置 run startup |
| orphan failure | warning，archive/run startup 继续 |
| archive failure | warning，run startup 继续 |
| fail mode | listen 前 DB fail 收敛 |
| recover mode | onListen 才 recover/enqueue |
| local runtime | 使用最小 read/write/lifecycle/session query port |
| remote worker | client/manager 配置、start/stop 保持 |
| plugin host | enabled 时 start，onClose stop；unavailable route 语义保持 |
| composition | module/facade/coordinator 无 Store 直连 |

## 独立审查要求

每批独立审查员必须未参与该批实现，并按以下维度给出明确结论：

- 责任 owner 是否唯一；
- 事务、CAS、文件、runtime 副作用顺序是否保持；
- route 是否只做 transport；
- facade 是否纯委派；
- startup coordinator 是否无领域规则；
- 是否存在跨域 concrete service 互调或完整 `AppContext` 泄露；
- 测试是否覆盖真实 SQLite/route/process 边界；
- 是否触碰非目标或无关改动。

审查不通过时必须修复并由独立审查员复审。阶段终审必须由未参与 P0-P5 的新审查员完成。

## 代码审查清单

### Session / Interaction

- `sendMessage` 的验证顺序与 fast path 没有变化；
- authoritative activation 仍由 Lifecycle 单 transaction 完成；
- Session application 没有 create/update run-state；
- primary fork 与 internal subtask materialization 没有混淆；
- revert 的 head move 仍有 expected-head CAS 与 reachability；
- revert runtime cancel 位于 application、DB 后，并 defensive catch + warn；
- 当前本地/远端 runtime 不把 cancel failure 暴露为 5xx，未来 runtime 抛错也不得改变成功 revert HTTP 语义；
- cancel 仍属于 Lifecycle。

### Context Query / Artifact

- Context Query 独立于 Session command 与 Writeback；
- Context Query 唯一拥有 context list/item/tail、public run-state、artifact read、status summary；
- Peripheral Agent Query 唯一拥有 recent sessions/workspaces、run final text、available agents；
- 两个 application 不互持完整 application，不做杂糅式转发；
- item/artifact 授权基于 visible transcript；
- artifact capability 仍窄且保留安全 I/O；
- Query 没有 mutation；
- run/status projection fallback 和日志不过量；
- agents/status/tail 业务规则均不在 route，且分别位于已定稿 owner。

### Routes

- 分组符合 UI / Worker contract / Peripheral / SSE；
- handler 只做 parse/auth/status/SSE；
- application `HttpError` 原样传播，只有冻结 generic/transport bridge 留在 route；
- Shared registry 未被手写 path 替代；
- 没有 Store/AppContext/fs/path import；
- 没有 route 级多 application sequencing；
- URL/schema/status/error 保持。

### Module / Facade / Startup

- facade 只委派，不构造/实现领域规则；
- module 只 composition/trigger/process lifecycle；
- startup coordinator 不含 DB/fs/领域条件；
- startup 顺序与 pre-listen/onListen 保持；
- process start/stop hook 保持；
- 命名 SQLite adapters 可继续调用 Store 原子 helper。

### 清理与可维护性

- 无死 helper、旧 route 双路径或 unused import；
- 没有为了接口纯洁性建立大量一函数 interface；
- 没有新 Manager/Helper 接收完整 `AppContext`；
- 新功能归属规则已写入 README/代码地图；
- 文档与实现差异已记录。

## 阶段验收标准

### 结构验收

- `AgentService` 不直接 import Store、workspace Store 或 filesystem；
- `AgentService.getContext()` 不存在；
- `agent.module.ts` 不直接 import Store；
- route 分组文件不直接 import Store/AppContext/fs/path；
- `ContextQueryApplication`、`PeripheralAgentQueryApplication`、`SessionInteractionApplication`、`AgentStartupCoordinator` 可独立测试；
- local runtime 依赖最小 application port。

### 行为验收

- public、Worker、Feishu/Plugin 调用行为无漂移；
- send、revert、cancel、artifact、startup 核心不变量全部通过；
- Shared contract、DB schema、file format 无变化；
- 无新增未记录错误码或 HTTP status。

### 质量验收

- 定向和全量测试通过；
- root build/typecheck 通过；
- `git diff --check` 通过；
- 无敏感信息、无无关变更；
- 每批独立审查/复审与最终新审查员终审通过；
- `11-implementation-record.md` 记录实际命令、结果、偏差和最终结论。
