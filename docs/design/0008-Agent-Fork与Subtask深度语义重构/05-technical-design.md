# 技术方案

## 改动原则

- 改动 write-side 权威规则，不在 prompt/read-side 打补丁。
- 先建立专用 application 入口，再收紧 contract，避免内部 subtask fork 被公共规则误伤。
- copied item、archive、prefork、guard、幂等和取消行为保持。
- 不新增 schema，不回填历史数据。
- 所有 public/internal contract 收紧必须有 HTTP 级测试，不只做 TypeScript 类型修改。

## Primary Ordinary Run 写入

### `sendMessage()`

当前：

```ts
const lineage = this.resolveRunLineageForSession(session);
createRunRecord(db, {
  subtaskDepth: lineage.subtaskDepth,
  parentRunId: lineage.parentRunId,
  parentToolItemId: lineage.parentToolItemId
});
```

目标：

```ts
createRunRecord(db, {
  // ...
  subtaskDepth: 0,
  parentRunId: null,
  parentToolItemId: null,
  // ...
});
```

`sendMessage()` 已在入口拒绝 `session.kind === "subtask"`，因此在通过该校验后可以直接应用 primary 不变量。

建议额外保留防御性断言或专用 helper，例如：

```ts
private primaryRunLineage() {
  return {
    subtaskDepth: 0,
    parentRunId: null,
    parentToolItemId: null
  } as const;
}
```

是否引入 helper 取决于项目风格；不得保留 DB 查询来决定值。

### `compactSession()`

同样写：

```ts
subtaskDepth: 0,
parentRunId: null,
parentToolItemId: null
```

`compactSession()` 已拒绝 subtask session。必须与 `sendMessage()` 同批修改和测试。

### Internal Run Trigger

`POST /api/internal/agent/runs/trigger` 委派 `sendMessage()`，无需单独写 depth，但必须补/保留测试证明它没有旁路。

### 删除旧 Helper

`resolveRunLineageForSession()` 当前仅被 `sendMessage()` 和 `compactSession()` 调用。两处改完后应删除该 helper 及不再需要的 store imports：

- `getLatestRunRecordBySession` 如果没有其他用途；
- `getTranscriptItemById` 需确认其他用途后再处理，不能盲删。

不得保留未调用 dead code 作为“兼容 fallback”。

## Session 创建职责拆分

### Public Primary Create

将 public create 与通用 internal create 的 Route 调用收敛到 primary-only service 入口。该入口只创建无 fork metadata 的新 primary：

```ts
createPrimarySession(params: {
  workspaceId: string;
  title?: string;
})
```

内部固定：

```ts
kind: "primary"
```

`createPrimarySession()` 不接受 `forkedFromSessionId/forkedFromItemId`。fork target 不是 generic primary create：它由 `forkPrimarySession()` 调用私有 materializer，固定 target kind 和 fork metadata。

### Generic Internal Primary Create

`POST /api/internal/agent/sessions/create` 使用同一个 `createPrimarySession()`。它是插件触发的用户主会话创建，不是 subtask 创建。

### Private Subtask Create

`startSubtaskRunFromWorker()` 的 `new/fork` 分支使用与 public fork 共用的私有 session materializer 或其 subtask wrapper，固定：

```ts
kind: "subtask"
```

不得复用 public request type。

### `createSession()` 的处理选择

实现必须形成以下单向调用结构：

```text
public/internal create Route
  → createPrimarySession(workspaceId,title)
  → private materializer(kind=primary, fork metadata=null)

public fork application / internal subtask application
  → private materializer(explicit kind + application-owned metadata)
  → createAgentSession store
```

私有 materializer 的函数名可以是 `materializeSessionInternal()`、重命名后的 private `createSession()` 或其他项目风格名称；函数名可调整，但调用方向与职责边界不得变化。不接受让 Route 调用 materializer，不接受让 `createPrimarySession()` 接收 fork metadata，也不接受继续让 Route 调用 `createSession(body)` 并传入 request `kind`。

## Fork 与 Context Clone 拆分

### 提取复制原语

从当前 `forkSession()` 提取以下逻辑：

- source transcript 读取；
- target index/boundary 的基础存在性校验；
- `visible_only` / `with_archive` 内容选择；
- archived source item 集合；
- target session 创建；
- context item clone；
- safe terminal status 规整；
- cloned ID map；
- archiveAt 映射；
- archive sidecar 写入；
- sidecar 失败时删除 target session/archive dir；
- 返回创建的 session。

原语必须继续写：

```ts
runId: null,
turnId: null,
step: null
```

### Public `forkPrimarySession()`

入口流程：

```text
读取 source session
  → 不存在：404
  → kind != primary：400 + 稳定错误码
读取 boundary item
  → 必须属于 source session
  → 必须 user/assistant
调用 clone primitive
  → target kind 固定 primary
  → fork metadata 指向 source/boundary
返回 primary session
```

public request 不再包含 `kind`，也不再包含 `allowAnyKindBoundary` 一类内部开关。

### Internal `createForkedSubtaskSessionInternal()`

由 `startSubtaskRunFromWorker()` 的 `mode="fork"` 调用：

```text
resolveSubtaskForkBoundaryItemId()
  → private internal boundary 已解析
调用 clone primitive
  → target kind 固定 subtask
  → 允许内部已验证的 boundary
继续在 startSubtask 事务中插入 summary/guard/prompt
创建真实 child Run
```

实现必须逐项遵守 [`04-target-architecture-and-entities.md`](./04-target-architecture-and-entities.md) 的 Internal Subtask Session 真值表，尤其保留以下路径：

- `new`：metadata=`parentSessionId/parentToolItemId`，不 clone，不写 guard，顺序为 prompt；
- `fork + shouldUsePreforkSummary`：metadata=`parentSessionId/parentToolItemId`，不 clone，顺序为 summary→guard→prompt；
- `fork + no summary + boundary`：metadata=`parentSessionId/forkBoundaryItemId`，clone `visible_only`，顺序为 cloned transcript→guard→prompt；
- `fork + no summary + null boundary`：metadata 双空，不 clone，顺序为 guard→prompt；
- `existing`：复用并保留既有 metadata，不 clone，不写 summary/guard，在既有 head 后追加 prompt。

所有非幂等复用的成功分支都创建本次 child Run，depth 为当前 parent+1，parent字段指向当前 parent/tool；幂等命中在进入分支前直接返回，不创建任何新实体。拆分不能把 summary、null boundary 或 existing 路径强制塞进 clone primitive，也不能借重构统一改写 metadata。

上文使用的函数名只是实现建议；允许改名，不允许改变 public fork 与 internal subtask fork 的分离调用方向，不允许让 clone primitive计算depth或决定产品权限。

### 事务与失败回滚

当前 `forkSession()` 在 archive sidecar 写失败时删除 session 和 archive dir；`startSubtaskRunFromWorker()` 在后续 child Run 事务失败时，如果创建了 session，会清理 created session。

重构必须保持两层回滚：

- clone primitive 自己负责 clone/archive 写入的原子性补偿；
- subtask start 负责 session 创建成功后、child Run 写入失败的补偿。

不得出现已创建的 orphan subtask session。

## Shared Contract 收紧

### Create Schemas

修改：

- `AgentCreateSessionRequestSchema`；
- `AgentInternalCreateSessionRequestSchema`。

移除 `kind`，显式 `{ additionalProperties: false }`。

对应 Route body 类型不再声明 kind。

### Fork Schema

`AgentForkSessionRequestSchema` 移除 `kind`，显式 `{ additionalProperties: false }`。

`AgentForkSessionRequest` 随 schema 自动收窄；Web API 函数无需改调用行为，但 TypeScript 会防止新调用方传 kind。

### Unknown Field 行为

本方案选定“双层约束”而非依赖 Fastify 默认 Ajv 行为：

- Shared TypeBox schema 移除字段并声明 `additionalProperties: false`，用于类型/OpenAPI contract；
- 三个受影响 Route 使用 endpoint-local `preValidation` allowlist guard，在 schema validation 可能 strip 字段之前检查原始已解析 body keys；
- allowlist guard 对任意未声明 key 返回 `400` 和稳定通用错误码，例如 `AGENT_REQUEST_UNKNOWN_FIELD`；实际错误码命名可按现有错误规范调整，但三个 endpoint 必须一致；
- 不修改全局 Fastify/Ajv 配置，避免扩大到其他模块。

P0 必须先在真实 `createApp()` HTTP 测试中固定当前 Fastify + TypeBox 行为，并证明 `preValidation` 能观察到 schema validation 前的原始 key。P2 才允许落地 selected mechanism。对应 HTTP 测试必须覆盖：

- 请求携带 `kind="subtask"`；
- 请求携带 `kind="primary"`；
- 其他未知字段。

目标是统一返回 `400`，不得 strip 后继续成功。若实测表明 endpoint-local `preValidation` 无法在当前 Fastify 生命周期中可靠看到原始 key，或会被全局行为绕过，必须暂停 P2 并回到设计选择其他局部拒绝机制；不得退化为静默 strip，也不得未经评审修改全局 Ajv 配置。

## Public Source Kind 错误

建议为公开 fork 新增领域错误码：

```text
AGENT_FORK_SOURCE_KIND_INVALID
```

推荐状态：`400`。

错误条件：source session 存在，但 `kind !== "primary"`。

不要复用：

- `AGENT_SUBTASK_KIND_MISMATCH`，它属于 internal subtask existing；
- `AGENT_FORK_ITEM_KIND_INVALID`，它表示 boundary item kind；
- `404 source session not found`。

## Existing Subtask 模式实现

保留当前分支校验：

- `sessionId` required；
- session exists；
- workspace matches；
- `kind === "subtask"`；
- run-state idle；
- same parent/tool 幂等时 session 必须匹配。

调整测试数据构造：

- 正常 existing 流程优先先通过 internal `new`/`fork` 成功创建 subtask session，再用新 parent/tool 进行 existing；
- 专门测试 missing/foreign/primary/running 时，可使用 testkit/store 明确构造；
- 删除通过 `POST /api/agent/sessions { kind: "subtask" }` 的构造方式。

生产逻辑中 existing child depth 继续使用当前 `childDepth`，不读取 existing session latest Run。

## Prompt / Read-side 切点

### 保持不变

`PromptStaticAssembler.assemble()` 保持：

```ts
const canExposeSubtask =
  input.run.subtaskDepth != null
  && input.run.subtaskDepth < maxDepth;
```

以下内容不修改：

- baseline tools；
- Agent profile tools 合并；
- subtask description agent list；
- run prompt static cache；
- Worker tool registry；
- pending tools snapshot。

### 需要补测试但不改生产逻辑

增加跨层证据：

- 新 ordinary primary Run 的 prompt context 包含 `subtask`，前提是 Agent 启用且 max depth >= 1；
- depth=max 的真实 child Run 仍不包含；
- unknown historical Run 仍不包含。

这样证明修复来自 write-side，read-side 安全规则没有漂移。

## 设置文案

更新 `apps/web/src/shared/i18n/locales/zh-CN.ts` 及英文对应文案属于本方案实施范围，因为产品语义发生明确变化。

目标文案需要表达：

- 可写 primary session 的 ordinary Run 是第 0 层；
- 普通 fork 创建新的 primary 执行根，仍为第 0 层；
- 只有 subtask tool 调用增加层级。

本设计文档任务不修改该代码；开发阶段实施。

## Store 与 Schema

不修改：

- `agent_session` schema；
- `agent_context_item` schema；
- `agent_run` schema；
- `createAgentSession()` store 的显式 kind 参数；
- `createRunRecord()` 的 nullable type；
- existing indexes。

理由是 store 需要支持两种合法实体和历史数据读取。应用层负责保证新写入组合。

## 日志与诊断

本次不需要新增包含 transcript/prompt 的日志。

可以记录轻量错误上下文：

- public fork source session id/kind；
- rejected generic create/fork unknown field 由endpoint-local guard返回固定错误；日志只记录endpoint和field name，不记录body value；
- clone/archive rollback 继续沿现有日志风格。

不得打印：

- prompt 内容；
- copied transcript；
- token；
- tool args 中的用户敏感内容。

## 代码删除与清理

完成后应检查：

- `resolveRunLineageForSession()` 删除；
- `allowAnyKindBoundary` 不再存在于公开/共享函数签名；
- Route body 中不再声明 `kind`；
- tests 不再把公开 create/fork 当 subtask fixture factory；
- ordinary primary Run 不再写 source `parentRunId`；
- 无多余 imports/dead helpers。
