# 技术方案

## Shared read-side contract

继续扩展：

```text
packages/shared/src/internal-contracts/agent-api.ts
```

必须新增内部文件：

```text
packages/shared/src/internal-contracts/agent-api-read.ts
```

`agent-api.ts` 继续是唯一公开聚合入口，导出：

- `AgentApiEndpoints` 中的三个 read-side endpoint；
- request/response TypeBox schema；
- `Static<>` 类型；
- 必要的稳定动态外壳 schema。

不新增 wildcard export，不从 shared 根入口导出，不引入新的 workspace。

### Endpoint registry

必须保持当前 registry 风格：

```ts
getExecutionProfile: {
  method: "POST",
  path: "/api/internal/agent/execution-profile"
}
getPromptContext: {
  method: "POST",
  path: "/api/internal/agent/prompt-context"
}
getMessagesContext: {
  method: "POST",
  path: "/api/internal/agent/messages-context"
}
```

Route 不再复制 method/path；Worker 不再拼接三条硬编码 URL。

### Schema 分层

建立稳定外壳 schema：

- `AgentApiReadContextRequestSchema`：workspace/session/run；
- `AgentApiMessagesContextRequestSchema`：workspace/session/appendMessage；
- `AgentApiExecutionProfileResponseSchema`；
- `AgentApiPromptContextResponseSchema`；
- `AgentApiMessagesContextResponseSchema`。

可复用现有 shared contracts 中的：

- locale schema；
- context item status；
- provider npm；
- builtin/dynamic tool name；
- public prompt/message 稳定枚举。

动态位置使用 `Type.Any()` 或明确的 `Record` 边界，但不得将整个 response 降级为 `Type.Any()`。

## API Route 迁移

`agent.routes.ts` 三个 route 只保留：

- shared body schema；
- shared success response schema；
- 现有 `ErrorResponseSchema` 状态映射；
- `assertInternalToken()` 防御性检查；
- 现有 Service 调用。

不得移动全局鉴权 hook，不得在 Route 重写业务组装，不得改变 status/error 语义。

## Worker Client 迁移

`apps/agent-worker/src/runtime/apiClient.ts` 的三个方法改为复用统一 `request()` helper：

- endpoint registry method/path；
- typed body；
- response schema；
- `responseEndpoint` 用于有限诊断；
- strict/warn 行为沿用 1B。

### 敏感诊断

response validation diagnostics 只能由有限字段路径和类型摘要组成。`request()` helper 或专用 logger 必须在输出前过滤：

```text
response body
apiKey
prompt/messages
args/result
runId/sessionId
```

不能以“测试 logger 未打印”为唯一保证；实现应在日志构造点不传入完整 payload。

## Read-side cache 与体积

`getPromptContextForRun()` 的 `runPromptStaticCache` 原样保留：

- key 仍按当前 runId；
- TTL、Promise reuse、失效调用不变；
- static prompt 与动态 transcript 的划分不变。

本轮不为三个接口增加 page/limit/maxChars/truncate/compress 参数或统一 body limit。

## Lifecycle fence 数据边界

### Append

在 `AgentService.appendContextItemFromWorker()` 进入实际 `appendContextItem()` 前，增加一个与 DB 写入一致的状态判断。必须检查：

- session 存在、workspace 匹配；
- request run 存在且 workspace/session 匹配；
- run 当前状态不是 terminal/cancelled；
- session/run-state 未显示该 run 已被取消或替换；
- 必须在 Store 事务或等价的原子 DB helper 内完成状态检查与 append，避免先读后写竞态。

late no-op 必须返回 02 中冻结的明确 response，不创建 item，不推进 head。不要在 Route 层用内存判断替代 DB 边界。

### Update

`updateContextItemFromWorker()` 必须先加载 current item，再校验 item 所属 run/session/workspace。允许的 update 只限既有终态收敛；不得：

- 用错误 run 更新 item；
- 让 terminal/cancelled 状态变回非终态；
- 通过 update 产生新 item；
- 在 session 已切换 active run 后把旧 run 写活。

apply_patch artifact 的既有处理顺序和副作用需继续由测试覆盖，不能因为 fence 直接删除既有 artifact 逻辑。

## Recover/cancel fence

### Recover

在 `agent.module.ts` 的 `enqueueRecoveringRuns()` 中：

1. 启动扫描得到候选；
2. 读取 session/run 当前 DB 状态；
3. 准备 inputText/runContext；
4. **在 `runtime.enqueueRun()` 前再次读取/检查 DB**；
5. 仅当 run 仍 in-flight、session activeRunId/状态仍匹配时 enqueue；
6. enqueue 失败继续保持 recover 模式不阻塞启动，并记录有限 warning。

检查与 enqueue 之间仍可能存在微小 race，本轮接受该风险；已经发出的执行由写回 fence 收敛。

### Cancel

保持当前顺序：

1. `cancelSessionCascade()` 在 DB transaction 中收敛 root/child；
2. Route 调用 runtime cancel；
3. runtime 失败只 warning，不回滚 DB。

child 查询必须使用 durable parent lineage，不只读取 parent tool output 的 `subtaskSessionId`。

## Subtask lineage 与 orphan

### Lineage 查询

run record 的以下字段是权威：

```text
parentRunId
parentToolItemId
```

新增/调整查询时必须保证 workspace 与 parent identity 一并校验。`subtaskSessionId` 只能作为展示或快速定位，不作为 cascade 的唯一依据。

### Orphan scanner

必须通过 AgentService/Store helper 查询：

```text
kind=subtask
createdAt < now-1h
headItemId is null
not exists run(sessionId)
not exists context item(sessionId)
```

先输出 suspect 诊断；自动删除前额外要求两个 `forkedFrom*` 非空、createdAt 超过 24h，并在同一删除事务/原子步骤前二次读取空壳条件。删除应限制在当前 data model 已确认安全的 session 删除能力内，不级联删除有内容实体。

启动扫描只处理历史候选。start 局部补偿只携带本次创建的 sessionId，失败/unique race 后重新确认为空壳再清理；不得把 reuse session 当作新建 session。

## Archive sidecar

### 现有 snapshot

当前 `appendArchiveLines()` 已生成：

```text
filePath
beforeSize
expectedSize
```

`rollbackArchiveLinesBestEffort()` 已在 `stat.size === expectedSize` 时 truncate 到 beforeSize；尺寸不符会 skipped。

### Sidecar record

sidecar record 必须为：

```ts
{
  version: 1,
  operation: "compaction" | "clear",
  workspaceId: string,
  sessionId: string,
  runId?: string,
  createdAt: number,
  snapshots: Array<{
    fileKey: string,
    beforeSize: number,
    expectedSize: number
  }>
}
```

`fileKey` 必须是受控 dataDir 相对标识，日志不得展开为完整绝对路径。写入流程：

1. 构造最小 JSON；
2. 写入同目录临时文件；
3. `rename` 成 pending sidecar；
4. 任一步失败只记录 warning，不影响主操作结果。

### Reconcile

触发：

- 服务启动；
- 同 session 下一次 clear/compact 之前。

处理：

1. 读取并校验 sidecar；
2. 解析每个受控目标文件；
3. stat 当前大小；
4. 所有目标都满足 `currentSize === expectedSize` 时才执行 truncate；
5. 任一不匹配、缺失或 sidecar 不完整，整条记录保留，不做破坏性操作；
6. 全部成功后删除 sidecar。

必须避免“部分文件回滚、部分文件跳过”导致新的不一致。日志只记录 operation、workspace/session/run 标识、数量、errno/mismatch 摘要，不记录 archive 内容或敏感 payload。

## 数据关系

```text
workspace
  └─ session
      ├─ runState(activeRunId)
      ├─ contextItem(headItemId, runId)
      └─ run(runId, parentRunId, parentToolItemId)
             └─ child run/session 通过 parentRunId + parentToolItemId 关联
```

关键约束：

- run.workspaceId == session.workspaceId；
- run.sessionId == contextItem.sessionId；
- child.parentRunId 指向 parent run；
- child.parentToolItemId 指向 parent context item，且该 item.runId == parentRunId；
- session.headItemId 是 context 链状态，不是 orphan 删除的唯一依据；
- activeRunId 只表示当前运行指针，不能取代 durable parent lineage。
