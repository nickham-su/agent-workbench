# 后端技术方案

## 设计目标

后端必须将 Fork 的上下文根解析收敛为一个可复用、可测试、事务内执行的领域规则：

```text
resolveForkContextRootAtTarget(targetMessageId) → string | null
```

其结果只依赖 target 的物理祖先链，不依赖来源 Session 当前 `contextRootMessageId`。`forkMessageSession()` 是该规则的唯一权威写入点：公开 primary Fork 与内部 subtask Fork 均必须通过它写入 child root。

## 共享 Fork 与上游边界策略

`forkMessageSession()` 的职责是：在既有 source/target 已被上游解析并通过共享消息图校验后，验证图、计算 target-time root，并原子创建 child Session/run state。

它不负责决定内部 subtask 应选哪条消息。调用方的职责边界如下：

| 上游语义 | 责任归属 | 本次要求 |
|---|---|---|
| public `fromMessageId` | 公开 Fork application/route | 保持现有公开参数与 idle 约束 |
| `boundaryPolicy` | 内部 subtask application | 仅解析 target；不得影响 root 算法 |
| internal-resolved boundary | 内部 subtask application | 保持既有 target 选择和稳定性语义 |
| `allowSourceWithActiveRun` | 内部 subtask 调用点 | 保持既有窄特例；公开 Fork 不得使用 |
| guard→prompt、prefork summary | 内部 subtask 编排 | 保持顺序、内容和错误语义 |
| lineage、locale/depth、工具限制 | subtask 领域/运行链路 | 保持现有数据和权限语义 |
| target-time root | `forkMessageSession()` | 对所有消息图 clone 统一计算 |

因此，`boundaryPolicy` 不能传递一个替代 root，也不能让 child 继承 source 当前 root。它只能产出 target；一旦 target 已确定，child root 必须由本设计的算法计算。

## 目标算法

### 输入与前置校验

输入至少包含：

```text
workspaceId
sourceSessionId
sourceHeadMessageId
expectedRevision
targetMessageId
```

在 `forkMessageSession()` 的现有 SQLite transaction 中，必须先完成以下校验：

- 以 `assertCurrent()` 验证 source 的 head/revision。
- 按调用语义验证 source 稳定性：公开 Fork 必须 idle；内部 subtask 保持既有 `allowSourceWithActiveRun` 特例及其更窄的 active-parent 条件，不得扩展到公开调用。
- 以 `isAncestor(source.headMessageId, targetMessageId)` 验证 target 是来源当前物理祖先。
- 验证 target 为 `user` 或 `assistant`，且满足 `messageTerminal()`。
- 验证 Assistant target 不存在 `queued` 或 `running` 的 tool execution。

只有上述校验通过后，才允许解析 child root 并写入 child Session。

### root 解析规则

从 `targetMessageId` 开始，沿 `previous_message_id` 向祖先回溯：

```text
target
  → previous
  → previous
  → ...
```

- 第一个 `type = compaction` 的 message 即为 child `contextRootMessageId`。
- 未找到 compaction 时，child `contextRootMessageId = null`。
- target 是 compaction 时必须在 target 类型校验阶段拒绝，不能作为特殊 root 处理。

推荐伪代码：

```ts
function resolveForkContextRootAtTarget(db, workspaceId, targetMessageId) {
  const ancestors = loadTargetAncestryFromTargetToRoot(db, workspaceId, targetMessageId);
  const nearestCompaction = ancestors.find((message) => message.type === "compaction");
  return nearestCompaction?.id ?? null;
}
```

实现应优先使用单条递归 CTE，从 target 开始向 `previous_message_id` 回溯并取第一个 compaction。该遍历不是只为查找摘要，还必须验证 target 至最近 compaction 或物理起点的完整链：

- 每次递归读取的 message 必须属于 `workspaceId`。
- 遍历必须检测循环；循环、重复节点或超过安全深度上限均是服务端数据不变量错误。
- 找到 compaction 时，该节点必须是 target 的真实祖先；继续保留路径证据以验证 root 合法。
- 未找到 compaction 时，链必须正常以 `previous_message_id = null` 结束；缺行、跨 Workspace 或提前截断不得被视为合法 `null` root。
- 解析出的 root 必须为 `null` 或 target 的物理祖先；不得是 target 后代。

不得通过前端或 `boundaryPolicy` 传入 root，也不得根据来源当前 root 推断历史 root。

### 多次压缩的规范示例

```text
M1 → M2 → C1 → M3 → M4 → C2 → M5
```

| target | child `headMessageId` | child `contextRootMessageId` |
|---|---|---|
| `M1` | `M1` | `null` |
| `M2` | `M2` | `null` |
| `M3` | `M3` | `C1` |
| `M4` | `M4` | `C1` |
| `M5` | `M5` | `C2` |
| `C1` / `C2` | 不创建 | 不适用 |

该表是实现与测试的强制语义。尤其必须保证：来源在 `M4` 后创建 `C2` 时，后来从 `M4` Fork 仍使用 `C1`，绝不能使用 `C2`。

## `forkMessageSession()` 改造

改造位置：

```text
apps/api/src/modules/agent/agent-message.store.ts
```

### 必须替换的逻辑

Fork 路径必须：

- 删除/移除仅针对 Fork 的“target 位于来源当前 root 前”拒绝分支；
- 不再将 `source.contextRootMessageId ?? targetMessageId` 写入 child；
- 调用 `resolveForkContextRootAtTarget()` 并将其结果写为 child root；
- 在插入 child 前显式验证 root 为 `null` 或 target 的祖先；图损坏时按服务端不变量错误处理并回滚 transaction。

### 必须保持的逻辑

不得改变：

- source primary 类型与 child primary 类型的公开 Fork 约束；
- `expectedHeadMessageId`、`expectedRevision` 的 transaction fence；
- `SESSION_NOT_IDLE` 的公开来源稳定性语义，以及内部 `allowSourceWithActiveRun` 的既有窄特例；
- target 必须是 source 当前物理祖先；
- `messageTerminal()` 的既有终态集合；
- Assistant 非终态工具执行的拒绝；
- child 的 `forkedFromSessionId`、`forkedFromMessageId`；
- 新 child `session_run_state` 的初始 idle 状态；
- message、part、tool execution、附件引用不复制的存储模型。
- internal subtask 的 `boundaryPolicy`、internal-resolved boundary、guard→prompt、prefork summary、lineage、locale/depth 与工具限制。

### 事务与失败原子性

root 解析、root 合法性检查、child `agent_session` 插入和 `session_run_state` 插入必须在同一个现有 SQLite transaction 内。

任何异常都必须回滚，不能留下：

- 只创建了 child Session 但没有 run state；
- child root 指向错误 Workspace、target 后代或断链节点；
- 部分复制的历史记录。

不需要也不得为此新增异步补偿、重试、后台 reconcile 或 DB migration。

### 图损坏的错误分层

Fork transaction 能确认的图损坏必须与用户可纠正的领域错误区分：

| 层级 | 例子 | 处理方向 |
|---|---|---|
| 用户/调用领域错误 | target 非祖先、类型/终态非法、Assistant 工具未终态、公开 source busy | 保持现有领域错误及 4xx 映射 |
| 并发冲突 | head/revision fence 失配 | 保持现有 `409` 映射 |
| transaction 可确认的图损坏 | 循环、缺行、跨 Workspace 链、非法 root、无 compaction 却未正常终止 | rollback，不创建 child Session/run state；记录诊断日志；按服务端数据不变量错误返回 `500` |
| Resolver 才能完整发现的损坏 | hydrate retained tail 后才可验证的 retained anchor/predecessor 结构异常 | Resolver `ModelContextInvariantError` fail-close；child 可能已创建，但后续不能启动有效模型上下文 |

写入路径应复用现有、无需完整 hydrate 即可调用的 compaction/retained-tail 结构校验；不得复制 Resolver 的完整材料化逻辑。若异常只能在 Resolver hydrate 时发现，不能在 Fork transaction 中伪造成功上下文或把它误映射为用户 400。

## Resolver 协作边界

`apps/api/src/modules/agent/read-side/model-context-resolver.ts` 已负责按 root 选择逻辑上下文，不应为了实现历史 Fork 重写其 retained-tail 算法。

Fork 改造只保证写入的 child 指针合法：

- root 为 `null` 时，Resolver 从 head 向祖先读取完整前缀；
- root 为 compaction 时，Resolver 使用该 summary、其 `retainedFromMessageId` 规定的尾部、以及 summary 后到 head 的消息；
- 新 Fork 不包含 target 之后的消息或之后创建的 compaction；
- retained tail 的完整 predecessor/anchor 关系若只能在 hydrate 中验证，仍由 Resolver fail-close；写入成功不等于随后 Run 一定可构建有效 prompt。
- root/retained anchor/物理链不合法时，Resolver 保持 `ModelContextInvariantError` fail-close。

不允许以“自动修复”方式静默将非法 root 改成 `null` 或 target；这会掩盖数据错误并改变上下文语义。

## 错误与接口处理

### 保持的错误方向

| 场景 | 预期 |
|---|---|
| source 不存在 | 现有 `404` 映射 |
| source 不是 primary | 现有 source-kind 错误 |
| 公开 Fork source 非 idle 或有不稳定内容 | `SESSION_NOT_IDLE` |
| target 不在物理祖先链、类型非法或不存在 | `FORK_TARGET_INVALID` |
| Assistant 存在 queued/running execution | `FORK_TARGET_HAS_NON_TERMINAL_EXECUTIONS` |
| head/revision 变化 | 现有冲突错误映射 `409` |
| transaction 可确认的 root/图不变量损坏 | 记录诊断日志、rollback、不创建 child，并返回 `500` |
| 仅 Resolver hydrate 可确认的 retained 结构损坏 | child 可已存在；后续 Resolver fail-close，Run 不得获得部分 prompt |

内部 subtask 的 `allowSourceWithActiveRun` 窄特例不适用表中的“公开 Fork source 非 idle”错误条件；它仍按既有 active-parent、boundary 和非终态内容校验决定是否可创建 child。

`FORK_TARGET_BEFORE_CONTEXT_ROOT` 不得再用于 Fork 正常业务判断。`MESSAGE_TARGET_BEFORE_CONTEXT_ROOT` 继续仅服务于移动现有 head 和 Revert 的保护路径。

### 不变的 API 与数据库

以下文件的请求/响应结构不需要变化：

- `packages/shared/src/contracts/agent.ts`
- `apps/api/src/modules/agent/routes/agent-public.routes.ts`
- `apps/web/src/shared/api/api.ts`

本次没有 migration。Schema、FK、清理顺序和 Workspace 删除语义保持现状。

## 后续运行语义

Fork 成功只代表 child Session 已创建。child 后续调用 `sendMessage()` 时，必须继续复用：

```text
SessionInteractionApplication.sendMessage()
  → RunLifecycleApplication.startUserRun()
  → 既有 runtime enqueue / Worker 执行
```

Fork 不继承 source Session 的 model override。child 每次 Run 仍按当前 profile 解析 Agent/provider/model；该行为已有测试，必须保持。
