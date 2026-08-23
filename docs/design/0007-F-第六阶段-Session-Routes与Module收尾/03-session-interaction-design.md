# Session / Interaction 目标设计

## 最终职责边界

建立显式 `SessionInteractionApplication`。名称可以微调，但必须拥有以下用户命令语义：

- list/create primary session；
- public primary fork；
- send message；
- revert；
- 为 public 与外围 internal create/trigger 提供同一业务入口；
- 为 Subtask 提供窄 session materialization port，但不拥有 Subtask lineage、child run activation 或 orphan 规则。

它不得拥有：

- run activation transaction 的内部写入；
- cancel cascade/recovery/writeback；
- Context Query 分页与 artifact I/O；
- compaction/archive、prompt/read-side 或 plugin operational 规则；
- 完整 `AppContext` 任意访问。

## 建议能力面

以下是职责示意，不强制逐一建立 interface：

```ts
interface SessionInteractionApplication {
  listPrimarySessions(input: { workspaceId: string }): AgentSessionRecord[];
  createPrimarySession(input: { workspaceId: string; title?: string }): AgentSessionRecord;
  forkPrimarySession(input: AgentForkSessionRequest): Promise<AgentSessionRecord>;
  sendMessage(input: {
    sessionId: string;
    body: AgentSendMessageRequest;
    runtime: AgentRuntimePort;
  }): Promise<AgentSendMessageResponse>;
  revert(input: {
    sessionId: string;
    body: AgentRevertSessionRequest;
    runtime: Pick<AgentRuntimePort, "cancelSession">;
  }): Promise<AgentControlResult>;
}
```

Session persistence/query 应按业务能力命名，可混合函数与对象：

- session/workspace lookup；
- primary session create；
- public fork materialization；
- non-authoritative dedup/idle query；
- atomic `moveHeadIfExpected`；
- read updated session。

不得建立泛化 `SessionRepository.save()` 并把一致性规则放回 application。

## 错误映射规则

本阶段延续当前项目风格，`SessionInteractionApplication` 可以直接抛 `HttpError`：

- application 负责 session/workspace/input/conflict 等业务错误的 HTTP status、message 与既有 error code；
- persistence 可返回结构化 conflict/not-found 结果或抛既有 persistence error，application 负责映射为 `HttpError`；
- route 默认不翻译 domain/persistence error，只做 schema、auth、params/body parse 和 success status；
- 只有既有 endpoint 已冻结的 generic bridge 才可留在 route，Session public/create/fork/send/revert 路由当前不新增 generic bridge；
- 不采用“一部分错误由 application 映射、另一部分相同层级错误由 route 统一映射”的混合规则。

## `sendMessage` owner 与协作

### Session / Interaction 拥有

- session exists；
- subtask session read-only；
- workspaceId matches；
- trim 和 empty text；
- user-facing validation order；
- transaction 前的 non-authoritative dedup/idle fast path；
- user surface execution profile resolve；
- UI locale normalize；
- 调用 lifecycle start capability；
- 将 lifecycle/persistence 暴露的既有 conflict 结果或 `AgentConflictError` 映射为现有 `HttpError` 语义。

### Run Lifecycle 拥有

- authoritative dedup/idle recheck；
- user item、first-message title、client request row、run record、run-state 的单 transaction；
- run id 与 activation timestamp；
- workspace run context 读取；
- runtime enqueue；
- enqueue failure 条件收敛；
- cancel、worker lifecycle writeback、startup recovery。

### 禁止的拆法

```text
Route
  → session validate
  → lifecycle create run
  → route enqueue runtime
```

route 不得拆成多次调用；Session application 也不得绕过 `RunLifecycleApplication.startUserRun()` 直接调用 persistence。

### 时序与错误不变量

```text
session validation
  → non-authoritative fast path
  → profile resolve
  → lifecycle activation transaction
  → workspace run context
  → runtime enqueue
  → failure settlement when enqueue throws
```

- dedup 命中不得重复 resolve profile、创建 run 或 enqueue；
- transaction 内 authoritative check 必须保留，fast path 不能替代它；
- `text` 仍为 trim 后文本，`inputText` 仍为原始 body text；
- activation commit 后 workspace run context 缺失的现有错误与持久状态行为不得被本阶段顺手修改；如实施发现这是现实缺陷，应停止并单独讨论，不得暗中补偿。

## Session create 与 fork

### Primary create

- public create 与外围 internal create 复用同一 application entry；
- 只创建 `primary`；
- workspace 必须存在；
- 默认标题、trim、id/time 语义保持；
- internal request 仍禁止 `kind` 或其他未允许字段，route 的 body-key transport guard 保持。

### Public fork

本阶段继承 `0008` 与 `0007-E`：

- source 必须为 primary，target 必须为 primary；
- public `boundaryPolicy` 与 internal subtask clone 不得混淆；
- copied item 的 run/lineage 语义不变；
- `with_archive` 的 append/DB/compensation/fault seam 顺序不变；
- Session application 可协调 public fork，但 Archive filesystem 和原子 clone persistence 仍是窄依赖；
- internal subtask session materialization 应通过 Subtask 所依赖的窄 capability 暴露，不允许 Subtask 注入完整 Session application 后任意调用 public commands。

## `revert` owner 与协作

### 最终 owner

`revert` 属于 Session / Interaction，因为它是用户对 session head 的命令，并非 Run Lifecycle 状态转换。

### 必须保持的 DB 规则

- session exists；
- workspace matches；
- target 在当前 transcript path；
- archived item immutable；
- run state 为 idle；
- session 无 non-terminal item；
- `moveSessionHead` 在 transaction 内校验 expected head、target 归属与 reachability，并 touch session；
- application 按本文件“错误映射规则”将 conflict/not-found/invalid target 映射为既有 `HttpError`；
- DB 成功后读取 updated session 和 run-state projection。

实现时建议建立命名 persistence capability，例如 `revertHeadIfIdleAndTerminal` 或保持现有 precheck + atomic `moveHeadIfExpected`。无论形态如何，不得把 `moveSessionHead()` 拆为先读后普通 update，也不得弱化 CAS/reachability。

### Runtime cancel 顺序

当前 route 在 DB 成功后调用 `runtime.cancelSession(sessionId)`。虽然前置要求 run-state idle，该调用仍是清理迟到 runtime 的副作用。当前生产实现事实为：

- `AgentRuntime.cancelSession()` 同步移除本地内存队列，没有抛错路径；
- `AgentWorkerClient.cancelSession()` 内部 catch worker 请求错误并记录 warning，不向调用方抛出；
- 因而当前 endpoint 观察到的是 best-effort cancel，底层失败不会把已成功的 revert 改成 5xx。

目标时序：

```text
SessionInteractionApplication.revert
  → DB validation + head CAS/move
  → build result
  → runtime.cancelSession best-effort
  → return DB result
```

规范：

- runtime cancel 必须迁出 route；
- 必须在 DB 成功后调用；
- application 必须 defensive catch runtime cancel 的潜在异常并记录受限 warning；
- runtime cancel 潜在异常不得回滚已提交的 head；
- 必须保持当前 endpoint 成功语义：cancel failure 不得把成功 revert 改成 5xx；
- defensive catch 是防止未来 runtime 实现变化的硬要求，不是待 P0 决定的选项。

## `cancel` 最终边界

- `cancel` 继续由 `RunLifecycleApplication.cancelSession()` 拥有；
- DB-first cancel、root/child cascade、runtime cancel best-effort、`cancel wins` 不变量全部继承 `0007-C`；
- Session application 不包装或复制 cancel 规则；
- public cancel route 可通过薄 facade 或最小 lifecycle capability 调用，仍只做 body/params transport；
- `AgentService.cancelSession()`、`cancelSessionCascade()` 等仅测试使用的兼容 helper，应在测试迁移后按删除条件处理。

## 实体与术语

| 实体/值对象 | 权威语义 |
|---|---|
| Session | workspace 内的交互上下文容器；kind 为 primary/subtask |
| Primary Session | 用户可 create/fork/send/revert 的执行根 |
| Subtask Session | 仅内部 Subtask 流程创建/复用，用户只读 |
| Client Request Dedup | send message 幂等键；authoritative 判断在 lifecycle transaction |
| Session Head | visible transcript 当前 head；revert 通过 CAS 移动 |
| User Run Activation | user item + dedup + run record + run-state 的原子集合 |
| Runtime Port | enqueue/cancel 外部副作用，不拥有 DB 规则 |

## Session application 验收要点

- facade 中不再出现 send/create/fork/revert 的领域实现；
- `sendMessage` 单元测试使用 fake lifecycle capability，证明参数、validation order 与 fast path；
- lifecycle persistence 真 SQLite 测试继续证明单 transaction；
- revert route 源码不再直接调用 runtime；
- public/internal create/trigger 行为一致；
- Subtask session materialization 没有被 public command 暴露；
- fork/archive/subtask 既有集成测试保持。
