# 背景、现状与根因

## 需求背景

用户在 Agent 工具中从一个 primary session fork 出新会话后，发现模型工具列表中没有 `subtask`。Agent 配置已经启用 `subtask`，`maxSubtaskDepth` 设为 `2`，并且用户反复保存设置、开启新请求后仍无法恢复。

问题具有以下特征：

- fork source 在产品界面上是 primary session；
- source primary session 可能本身也是 fork 结果；
- 从新 fork session 的第一轮开始，模型就声明工具列表中没有 `subtask`；
- 修改 Agent tools 或 runtime depth 设置不能修复该 session；
- 问题与 copied history 所属 Run 的缺失高度相关。

这不是模型误判，也不是 Worker 工具注册失败，而是 API 在构造本次 Run 的静态 prompt tools 时主动过滤了 `subtask`。

## 当前故障链路

```text
primary session A 的真实 item
  item.runId = run_A

A 公开 fork 为 primary session B
  B 中 copied item.runId = null

从 B 中的 copied item 再 fork 为 primary session C
  C 首次发送消息
  → resolveRunLineageForSession(C)
  → 查询 B 中 fork boundary item
  → sourceItem.runId == null
  → C 的 Run.subtaskDepth = null

PromptStaticAssembler
  → canExposeSubtask = depth != null && depth < maxDepth
  → false
  → 从 tools 中移除 subtask
```

后续继续在 C 中发送消息也不会自动恢复。当前 `resolveRunLineageForSession()` 优先读取该 session 最近一次实际 Run；第一次错误写入 `null` 后，后续 Run 会继续继承 `null`。

## 当前代码证据

### 普通消息 Run 继承 lineage

`apps/api/src/modules/agent/agent.service.ts` 的 `sendMessage()` 当前在事务中调用：

```ts
const lineage = this.resolveRunLineageForSession(session);
createRunRecord(this.ctx.db, {
  // ...
  subtaskDepth: lineage.subtaskDepth,
  parentRunId: lineage.parentRunId,
  parentToolItemId: lineage.parentToolItemId,
  // ...
});
```

当前代码位置约为：

- `sendMessage()`：`agent.service.ts:2485-2607`
- lineage 调用及 Run 写入：`agent.service.ts:2567-2582`

### Compact Run 也继承 lineage

`compactSession()` 同样调用 `resolveRunLineageForSession()`：

```ts
const lineage = this.resolveRunLineageForSession(session);
createRunRecord(this.ctx.db, {
  // ...
  subtaskDepth: lineage.subtaskDepth,
  parentRunId: null,
  parentToolItemId: null,
  // ...
});
```

当前代码位置约为：

- `compactSession()`：`agent.service.ts:2682-2789`
- lineage 调用及 Run 写入：`agent.service.ts:2746-2762`

虽然 compact 已经不写 `parentRunId`，但 depth 仍受错误 lineage 影响，因此不能只修 `sendMessage()`。

### Lineage helper 混合了上下文来源与执行父子关系

`resolveRunLineageForSession()` 位于 `agent.service.ts:3593-3646`，当前规则是：

- session 已经有 Run：继承最近 Run 的 `subtaskDepth`；
- 非 fork session 首 Run：depth 为 `0`；
- fork session 首 Run：查询 `forkedFromSessionId + forkedFromItemId` 对应 source item；
- source item 没有 `runId`：depth 为 `null`；
- source item 有 Run：继承 source Run depth，并把 source Run 写为普通 fork Run 的 `parentRunId`。

关键代码：

```ts
if (sourceItem?.runId == null) {
  return {
    subtaskDepth: null,
    parentRunId: null,
    parentToolItemId: null
  };
}

return {
  subtaskDepth: sourceRun.subtaskDepth,
  parentRunId: sourceRun.runId,
  parentToolItemId: null
};
```

这里把两类完全不同的关系合并了：

- `agent_session.forked_from_*` 表示上下文从哪里分支；
- `agent_run.parent_*` 应表示真实 subtask 工具调用建立的执行父子关系。

### Fork copied item 正确地没有 Run ownership

`forkSession()` 当前复制 transcript 时写入：

```ts
const next = appendContextItem(this.ctx.db, {
  workspaceId: fromSession.workspaceId,
  sessionId: newSessionId,
  runId: null,
  turnId: null,
  step: null,
  // ...
});
```

当前相关位置约为 `agent.service.ts:2337-2483` 内的复制事务。

`runId = null` 不是缺陷。copied item 是新 session 的静态历史上下文，不是旧 Run 在新 session 中产生的执行结果。如果复制 source `runId`，会破坏 Run/session ownership、Worker fence、按 Run 查询结果和恢复逻辑。

### Prompt 层按 Run depth 正确过滤工具

最近一次 read-side / prompt 重构后，工具投影已位于：

- `apps/api/src/modules/agent/prompt/prompt-static-assembler.ts`
- `PromptStaticAssembler.assemble()`

当前规则：

```ts
const canExposeSubtask =
  input.run.subtaskDepth != null
  && input.run.subtaskDepth < this.dependencies.getMaxSubtaskDepth();

if (!canExposeSubtask) {
  // filter subtask
}
```

这是正确的安全规则：

- unknown depth 不得继续嵌套；
- 达到最大深度的 Run 不得继续创建 child；
- prompt tools 与 API startSubtask 的深度校验保持一致。

因此本次不得通过放宽 `PromptStaticAssembler` 来掩盖写入错误。

### 真实 Subtask 深度链路本身正确

`startSubtaskRunFromWorker()` 当前在 `agent.service.ts:3702` 附近开始处理内部 subtask start。关键规则位于约 `agent.service.ts:3805-3812`：

```ts
if (parentRun.subtaskDepth == null) {
  throw new HttpError(409, "subtask depth cannot be determined for current parent run", ...);
}
const childDepth = parentRun.subtaskDepth + 1;
if (childDepth > runtime.maxSubtaskDepth) {
  throw new HttpError(409, "subtask depth exceeds configured maximum", ...);
}
```

child Run 写入约位于 `agent.service.ts:3962`：

```ts
subtaskDepth: childDepth,
parentRunId: parentRun.runId,
parentToolItemId: anchor.id
```

这条真实执行关系需要保留。

## 现有公开接口边界不足

### 公开 create 可创建 subtask

当前 `AgentCreateSessionRequestSchema` 允许：

```ts
kind?: "primary" | "subtask"
```

路由 `POST /api/agent/sessions` 直接调用 `service.createSession(body)`。因此服务端并没有固化“subtask session 仅内部创建”的产品约束。

### 公开 fork 可指定目标 kind

当前 `AgentForkSessionRequestSchema` 也允许可选 `kind`。`POST /api/agent/sessions/fork` 直接调用 `forkSession(body)`，而 `forkSession()` 没有要求 source 必须是 primary。

即使当前 Web UI 只在 primary session 上显示 fork，其他客户端仍可以绕过 UI：

- 从 subtask session 调公开 fork；
- 把公开 fork 目标设置为 subtask；
- 通过公开 create 直接创建 subtask。

### 通用 internal create 同样可创建 subtask

`POST /api/internal/agent/sessions/create` 使用 `AgentInternalCreateSessionRequestSchema`，当前也允许 `kind`。该入口用于插件等通用 session 创建，不是 subtask 领域 start 入口，因此也不得保留 subtask 创建后门。

仓库内 Feishu plugin 调用该接口时只发送 workspace 和 title，不携带 `kind`，收紧为 primary-only 不影响当前内置调用。

## 现有测试固化了错误语义

`apps/api/src/modules/agent/agent.integration.test.ts` 当前存在测试：

> `普通 UI fork 首 run 继承来源 depth，来源不明时为 unknown`

该测试明确断言：

- source Run depth 为 `2` 时，普通 fork 首 Run 仍为 `2`；
- source item 无 `runId` 时，普通 fork 首 Run depth 为 `null`；
- 普通 fork Run 可以写 `parentRunId = sourceRunId`。

这条测试不是应保留的兼容基线，而是需要随产品语义重定义一起替换的旧规格。

## 根因归纳

根因不是 copied item 丢失字段，而是模型边界定义错误：

- `runId` 被同时当作执行 ownership 和 fork provenance；
- `parentRunId` 被同时当作真实 subtask parent 和普通 fork 来源；
- primary session 没有被定义为独立执行根；
- UI 限制没有转化成服务端不变量；
- 公开 primary fork 和内部 subtask context clone 复用同一个高层 `forkSession()`，职责不清。

本方案必须修正这些模型问题，而不是只为 `null` 增加 fallback。
