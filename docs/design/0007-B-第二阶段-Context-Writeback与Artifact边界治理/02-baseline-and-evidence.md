# 当前基线与证据

## 基线口径

本阶段以 P0 实际复核的源码与测试结果为权威。精确命令、cwd、测试数量、耗时和工作区快照记录在 `09-implementation-record.md`。

上位约束：

- `0004` 已统一 Worker → API context create/update Shared contract；
- `0005` 已冻结 late append/update fence、normal/ignored、head conflict 与 DB 收敛语义；
- `0006` 要求 Context Writeback 使用原子 persistence capability，并在本阶段定稿 artifact 读写责任边界；
- `0007-A` 已完成 read-side/prompt 治理和最小 testkit，提交为 `0f57bfe`。

当前分支状态：

```text
v1.1...origin/v1.1
```

当前检查时，index 中只有本方案目录十个新增文档；这只是方案文件进入 index 的事实，不表示 P0/P1 已通过或已按批次结论暂存。工作树未暂存续改为 `apps/api/src/modules/agent/agent.integration.test.ts`、本目录的 `README.md`、`02-baseline-and-evidence.md`、`07-code-map.md`、`09-implementation-record.md`；未跟踪的本阶段 P1 测试为 `apps/api/src/modules/agent/writeback.api.test.ts`。当前没有非本阶段 staged/worktree/untracked 变更。P0 启动时的历史快照与当时命令仍保留在 `09-implementation-record.md`。

因此当前状态不是后续批次的静态假设。每批必须先完整记录 Git 状态；任何非本阶段产生的 staged/worktree 变更都必须保持内容与 index 状态原样。

## Shared context contract

权威入口：

```text
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/src/internal-contracts/agent-api-context.ts
```

### Create

```text
POST /api/internal/agent/context-items
```

请求稳定字段：

```text
workspaceId
sessionId
runId
turnId
step
prevId
kind
status
output
createdAt?
```

成功响应为可判别联合。normal 分支为：

```text
{ ok: true, item: AgentContextItemRecord }
```

其中 `item` 必须为完整 `AgentContextItemRecord`；late no-op 分支固定为：

```json
{"ok":true,"item":null,"ignored":true}
```

不得接受：

- `{ "ok": true }`；
- `{ "ok": true, "item": null }`；
- normal item 同时携带 `ignored: true`；
- `ignored: false`。

### Update

```text
PATCH /api/internal/agent/context-items/:itemId
```

请求体：

```text
status?
output?
updatedAt?
```

成功 response 外壳：

```text
{ ok: true, item: AgentContextItemRecord }
```

Route 将 service 返回的 item 包装为 `{ ok: true, item }`；Worker client 对外返回 `item` 本身。update 没有 ignored response 分支。

### 合同不变量

- `AgentApiEndpoints` method/path 不变；
- `buildAgentApiContextItemPath()` 继续只接受正整数；
- create/update output 复用公共 `AgentContextItemOutputSchema`；
- success response 继续做 strict/warn runtime validation；
- validation warning 不打印 token、prompt、messages、args、result、run/session 标识等敏感 payload。

## Route 基线

```text
apps/api/src/modules/agent/agent.routes.ts
```

### Create Route

- 使用 Shared endpoint 和 body/response schema；
- success 声明 `200`，错误声明 `400/401/404/409`；
- handler 只做 token 防御性检查、读取 body、调用 `appendContextItemFromWorker()`；
- Route 不判断 late fence、head 或 run 状态。

### Update Route

- 使用 Shared method/path、params/body/response schema，并由 `buildAgentApiContextItemPath()` 提供 Worker 侧具体路径构造；
- success 声明 `200`，错误声明 `400/401/404`；
- handler 调用 `updateContextItemFromWorker()`，再包装 `{ ok: true, item }`；
- Route 不做 item ownership、terminal 或 artifact 规则。

本阶段不得将 writeback 规则上移到 Route，也不进行 Route 全面拆分。

## Worker client 基线

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

当前行为：

- `createContextItem()` 使用 Shared method/path/schema；
- normal create 返回 `{ ok: true, item }`；
- late create 接受 `{ ok: true, item: null, ignored: true }`；
- create 的 `409` 映射为 `ApiConflictError`；
- `updateContextItem()` 使用 Shared path builder；
- update 返回完整 item；
- update 非 2xx 保持普通 request error，不映射为 create conflict；
- strict/warn response validation 与脱敏诊断保持。

## API Service 基线

```text
apps/api/src/modules/agent/agent.service.ts
```

### `appendContextItemFromWorker()`

当前顺序：

```text
apply_patch completed-on-create 禁止检查
  → createdAt default
  → appendContextItemWithRunFence()
  → Store result 映射
  → 成功 item 的 todolist title side effect
  → normal response
```

#### apply_patch create 禁止规则

当 create 同时满足：

- `kind === "tool"`；
- `status === "completed"`；
- output 是 `apply_patch`；
- output 拥有 `result`；

返回：

```text
400 apply_patch completed tool item must be updated, not appended
```

原因是 before/after 必须走 update 路径写入 UI artifact，再以 slim result 入库。

#### Store 结果映射

| Store 结果 | Service/HTTP 语义 |
|---|---|
| `appended` | `{ ok: true, item }` |
| `ignored` | `{ ok: true, item: null, ignored: true }` |
| `missing-session` | `404 session not found` |
| `missing-run` | `404 run not found` |
| `workspace-mismatch` / `run-mismatch` | `400 workspaceId mismatch` |
| `AgentConflictError` | warning + `409 session head conflict` |

#### title side effect

成功 append 的 item 为 completed `todolist` tool 且 result 中存在有效 goal 时，更新 session title。ignored、missing、mismatch、conflict 不得触发该副作用。

### `updateContextItemFromWorker()`

当前顺序：

```text
getContextItemForWorkerUpdate() 初步 fence
  → missing/ownership/unchanged 映射
  → 根据 current + request 计算 next status/output
  → apply_patch artifact 尝试与 result 瘦身
  → updateContextItemWithRunFence() 最终事务 fence
  → missing/ownership/unchanged 映射
  → 成功 todolist title side effect
  → 返回 item
```

#### 初步 fence

| 结果 | Service 语义 |
|---|---|
| `missing` | `404 context item not found` |
| `ownership-mismatch` | `404 context item ownership mismatch` |
| `unchanged` | 立即返回 stored item，不做 artifact 或 DB update |
| `updated` | 继续编排 |

#### 最终 fence

artifact 准备之后，必须再次调用 `updateContextItemWithRunFence()`；其 `unchanged` 仍返回 stored item。这一二次事务 fence 是防止初步检查与最终写入之间状态变化的现有边界。

#### title side effect

仅最终 DB update 成功并返回 completed `todolist` item 后更新 title；最终 fence unchanged 不触发。

## Store 原子能力基线

```text
apps/api/src/modules/agent/agent.store.ts
```

### `appendContextItemWithRunFence()`

单一 SQLite transaction 内完成：

- session 存在；
- workspace ownership；
- request run 存在；
- run 的 workspace/session ownership；
- run 为 running；
- session run-state 的 `activeRunId` 仍匹配；
- 调用 `appendContextItemInTransaction()`；
- 由 append 内部执行 `prevId`/head CAS、insert、head 推进、session touch。

普通 stale `prevId` 由 `AgentConflictError` 表达，不转成 ignored。

### `getContextItemForWorkerUpdate()`

单一 transaction 内读取并判断：

- item 是否存在；
- item 的 session/workspace 关系；
- item.runId 对应 run 的 ownership；
- run 是否仍 running 且 active；
- item 是否已经 terminal。

输出：`updated / unchanged / missing / ownership-mismatch`。

### `updateContextItemWithRunFence()`

单一 transaction 内再次执行上述 fence；只有仍为 `updated` 时才调用 `updateContextItem()`。`updateContextItem()` 自身也保护 terminal row，不允许终态回退。

### 强制约束

阶段结构迁移不得把这些能力拆成 application 层多次普通查询与普通 update。若需要改变 transaction、SQL 或结果 union，必须暂停并单独设计。

## Late writeback 行为矩阵

| 场景 | Create | Update |
|---|---|---|
| run terminal/cancelled | `200 ignored`，不新增 item | `200` 返回 unchanged stored item |
| activeRunId 已切换 | `200 ignored` | `200` 返回 unchanged stored item |
| run 不存在 | `404 run not found` | item/run ownership 异常保持当前 `404` |
| session 不存在 | `404 session not found` | item 缺失/ownership 路径的当前 `404` |
| workspace/run ownership 错 | create 当前 `400 workspaceId mismatch` | update 当前 `404 context item ownership mismatch` |
| stale prevId/head | `409 session head conflict` | 不适用 |
| item 已 terminal | 不适用 | unchanged stored item |

`ignored`、`unchanged`、`not-found`、`conflict` 不得合并为统一 no-op。

## Artifact 基线摘要

### 已确认：apply_patch

当前源码明确显示 completed `apply_patch` update 会：

- 通过 `splitApplyPatchResult()` 从 full tool result 拆分 `slim + artifact`；
- 根据 workspaceId/toolCallId 构造 `tmp/agent/ui-artifacts/...` 路径；
- 校验目标目录位于 `tmpRoot`；
- 安全创建目录并验证 realpath；
- 使用 `O_NOFOLLOW` 风格写文件；
- 写失败只记录日志，仍继续以 slim result 执行最终 DB update；
- artifact 写入发生在最终 `updateContextItemWithRunFence()` 之前。

### 已确认：write

P0 直接复核 `AgentService.updateContextItemFromWorker()`：在初步 fence 通过后，终态 `write` 进入同一 API update writeback 主链。其规则必须与 `apply_patch` 区分：

- `completed`：`splitWriteResult()` 拆出 slim/完整 artifact，使用 `writeUiArtifactPath()` best-effort 写入 JSON，随后以 slim result 调用最终 Store fence；完整 args 保留；
- `failed` / `cancelled`：只进入终态识别，不 split、不写 artifact、不替换 result，保留完整 args/content 的既有语义；
- Query 读取点是 `getWriteUiArtifact()`，其缺失与越界-symlink 行为由真实 API characterization 覆盖；
- 写入与 `apply_patch` 一样发生在最终 `updateContextItemWithRunFence()` 前，失败不改变 Worker update 成功或 slim DB update 的既有政策。

因此 write 纳入 P5，但只允许机械等价迁移上述差异化行为。

详细边界见 `04-artifact-boundary-design.md`。

## 测试基线

### 核心合同与 SQLite 证据

```text
apps/api/src/modules/agent/context-item-contract.test.ts
```

当前本域代表性用例：

- `Context create/update return complete records and accept shared output variants`；
- `Context create/update reject invalid output before response serialization and preserve token priority`；
- `Context create preserves head conflict and terminal update returns the unchanged stored item`；
- `Context create rejects a missing run without appending or returning ignored`；
- `Context create late fences terminal runs without changing context, title, or run state`；
- `Context create late fences a run after activeRunId switches at the Store boundary`；
- `Store append fence is authoritative within its transaction`；
- `Context update late fences terminal and switched runs without changing the stored item`；
- `Context update rejects an item whose run ownership is inconsistent`。

同文件还包含 compaction/archive/sidecar 场景；本阶段不得把这些场景误迁入 Writeback 域。

### Artifact 证据

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

当前代表性用例包括：

- apply_patch artifact 写入、瘦身、读取与缺失 404；
- `write completed 后保留完整 args、瘦身 result 并支持 artifact 拉取`；
- `write artifact 文件缺失时返回 404`；
- `write 在 cancel 终态会保留完整 args.content`；
- `write 在 failed 终态会保留完整 args.content`；
- P0 新增：`artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400`，同时覆盖 apply_patch/write Query 的实际状态与 `Invalid path` body。

P0 必须建立精确测试索引，不得只记录文件名。

### API-managed Worker

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

现有真实链路记录 internal RPC，并断言：

```text
context create
run-state
context update
run-complete
```

其中必须保持：

```text
run-state < context update < run-complete
```

### Worker client

```text
apps/agent-worker/src/runtime/apiClient.test.ts
```

覆盖 Shared endpoint、normal/ignored、update record、409 映射、strict/warn 与 path builder。

### Shared

```text
packages/shared/tests/internal-contracts.test.ts
```

覆盖 endpoint registry、create normal/ignored union、update response、output schema 和 path builder。

## CWD 与临时资源约束

`context-item-contract.test.ts` 当前通过：

```ts
path.resolve(process.cwd(), "../..")
```

推导 repo root，并写入 `<repoRoot>/.tmp-tests/context-contract-*`。因此 API 测试必须从：

```bash
cd apps/api
```

执行。P0 必须记录实际命令、结果、耗时和清理行为，不能从仓库根运行后误判回归。

## P0 必须补证的待确认项

P0 已确认 write 主链、completed/failed/cancelled 矩阵、缺失 404 和越界 symlink 的 `400 Invalid path`。以下仍需在引入受控顺序或机械等价 collaborator 后补足可执行证据：

- artifact 已写出但最终 Store fence 返回 unchanged 时，文件是否遗留，以及该遗留是否为当前接受行为；
- artifact 路径/写失败后 slim result 是否仍按当前方式落 DB；
- 目标消失等其他 realpath 失败的实际 status/body；
- update 初步 fence 与最终 fence 之间的可控竞态测试是否已足够；
- `context-item-contract.test.ts` 是否适合复用 0007-A testkit，还是保留私有 fixture 更能表达 archive fault 差异；
- `todolist` title side effect 在 create/update 的完整成功与 no-op 分支矩阵。
