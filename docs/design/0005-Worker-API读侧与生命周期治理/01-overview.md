# 背景、现状与目标

## 背景

1A 已统一 API → Worker 控制面协议，1B 已统一 Worker → API 的核心写回协议，覆盖 run state、run completion、context item、compaction 和 subtask 生命周期。当前主链已经具备 shared internal contract、统一 response validation 和分批迁移方法，但 Worker 主运行链路的三个 read-side 接口仍保留独立的 Route/Client 匿名类型和直接 JSON 类型断言。

与此同时，1B 验收确认了几类生命周期边界仍然存在：recovery 与 cancel 交错、terminal run 迟到 context 写回、subtask lineage 回填窗口、空壳 session 残留以及 archive 文件与 DB rollback 的非原子性。本轮将这些问题按风险和改动成本分层治理，不把它们扩大为通用 RPC、状态机或数据库重构。

## 当前 read-side 现状

API Route 已存在：

```text
POST /api/internal/agent/execution-profile
POST /api/internal/agent/prompt-context
POST /api/internal/agent/messages-context
```

Worker `AgentApiClient` 已有对应方法：

```text
getExecutionProfile()
getPromptContext()
getMessagesContext()
```

当前差异：

- Route response schema 直接定义在 `agent.routes.ts`；
- Worker 三个方法使用直接 `fetch()`、`response.json()` 和类型断言；
- 三个接口尚未复用 1B 的 `AgentApiEndpoints`/shared read-side schema/response validation 闭环；
- 业务组装逻辑位于 `AgentService`，不属于本轮重构对象。

## 当前生命周期现状

### Recovery

`agent.module.ts` 提供：

- `recover` 模式：查询 recoverable runs 并调用 `runtime.enqueueRun()`；
- `fail` 模式：将 in-flight context item/run/run-state 收敛为终态。

当前 recover enqueue 与 cancel 之间没有完整的执行世代 fence。已发出的 enqueue 可能在 DB 被 cancel 后短暂继续。

### Cancel

`AgentService.cancelSessionCascade()` 先在 DB transaction 中收敛相关 session/run/context，再由 Route 对返回的 runtime session id 调用 `runtime.cancelSession()`。DB 级级联已经存在，但 runtime 停止与 DB 状态不是全局事务。

### Context 写回

1B 的正常 create response 为：

```json
{
  "ok": true,
  "item": { "...完整 AgentContextItemRecord..." }
}
```

当前 append/update 逻辑还需要增加明确的 terminal/cancelled fence，防止迟到 Worker 在 DB 已收敛后创建新 item 或逆转状态。

### Subtask

当前 run record 已存在 `parentRunId`、`parentToolItemId` 等关系字段，parent tool output 也可能异步回填 `subtaskSessionId`。本方案规定 durable run metadata 是权威 lineage，不能把 parent tool 字段的回填完成作为 child 可发现性的前置条件。

### Archive

Compaction/clear 等操作已经有 archive append snapshot 与 best-effort rollback。已知缺口是 rollback skipped 后只有 warning，没有安全、可重试、可诊断的后续入口。本期只补最小 sidecar reconciliation，不改 archive 格式和事务边界。

## 业务目标

### Read-side 目标

- Worker/API 使用同一套主链路 read-side contract；
- 成功 response 进入统一 runtime validation；
- 继续保持当前 prompt、messages、execution profile 的业务含义；
- 避免 cache、截断、敏感配置和错误状态在迁移中漂移。

### 生命周期目标

- DB terminal/cancelled 状态成为迟到执行的最终约束；
- cancel 在 recover race 中胜出；
- child 可通过 durable lineage 被取消、恢复扫描和诊断逻辑发现；
- 空壳 subtask session 有保守的标记和自动删除边界；
- archive rollback skipped 变得可发现、可安全重试、不可误删或误截断。

## 端到端链路

### Read-side 主链

```text
AgentWorker Runner
  → AgentApiClient.getExecutionProfile()
  → API internal route
  → AgentService.getExecutionProfileForRun()
  → run/session/profile/runtime 数据

AgentWorker Runner
  → AgentApiClient.getPromptContext()
  → API internal route
  → AgentService.getPromptContextForRun()
  → cache + prompt/message/tool 组装

AgentWorker Runner / compaction / prefork
  → AgentApiClient.getMessagesContext()
  → API internal route
  → AgentService.getMessagesContext()
  → session transcript + one-shot system
```

### 生命周期主链

```text
API DB state transition
  → runtime cancel/recover enqueue（best-effort）
  → Worker late read/write
  → DB fence
  → ignored / terminal convergence
```

## 非目标

本轮不追求：

- 已发出 runtime work 的强制线性化终止；
- Worker 重启后的完整 nested runtime graph 恢复；
- 所有内部 endpoint 的协议统一；
- archive 与 SQLite 的全局原子事务；
- 新增全局错误 envelope 或统一 retry/timeout 框架。

## 兼容性原则

- API 与 Worker 同仓库、由 API 管理启动，因此采用原子迁移，不引入长期双协议；
- 1A/1B 已冻结 endpoint、鉴权、strict/warn、正常 Context response 等合同不得被本轮隐式改写；
- 只有本文明确的 lifecycle no-op/fence 语义可以改变迟到写回的实际 DB 副作用。
