# 当前实现与代码地图

## 调用链

公开 Fork 的现有调用链如下：

```text
POST /api/agent/sessions/fork
  → SessionInteractionApplication.forkPrimarySession()
  → SqliteSessionInteractionStore.cloneSession()
  → forkMessageSession() 的 SQLite transaction
```

`forkMessageSession()` 是消息图 clone 的权威写入点，不只服务公开 HTTP Fork。内部 subtask 在上游完成自己的 boundary 解析后也会进入该路径；相关编排位于 `apps/api/src/modules/agent/session/session-interaction-application.ts` 的 subtask 创建流程。公开 Fork 与内部 subtask 的 source 稳定性策略不同，但 child root 写入规则必须一致。

| 层级 | 路径 | 职责 |
|---|---|---|
| 共享契约 | `packages/shared/src/contracts/agent.ts` | `AgentForkSessionRequestSchema`、`AgentSessionRecord` 等公开类型 |
| HTTP Route | `apps/api/src/modules/agent/routes/agent-public.routes.ts` | 接收 `POST /api/agent/sessions/fork` 并返回 `201` |
| 应用层 | `apps/api/src/modules/agent/session/session-interaction-application.ts` | 验证来源为 primary、映射领域错误 |
| SQLite 适配 | `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts` | 读取来源最新 head/revision 并调用领域 store |
| 领域写入 | `apps/api/src/modules/agent/agent-message.store.ts` | 稳定性校验、消息图校验、创建 child Session 与 run state |
| 前端 API | `apps/web/src/shared/api/api.ts` | `forkAgentSession()` 请求封装 |
| 前端视图 | `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` | 触发 Fork、等待 mutation、发出 forked 事件 |
| 成功导航 | `apps/web/src/features/workspace/tools/agent/AgentToolView.vue` | 刷新 Session 列表并激活新的 tab |
| 内部 subtask | `apps/api/src/modules/agent/session/session-interaction-application.ts` | 保持 `boundaryPolicy`、internal-resolved、active parent run、guard/prompt 与子任务运行语义；最终复用消息图 clone 写入 |

## 数据关系

```text
agent_session
  ├─ head_message_id ───────────────┐
  ├─ context_root_message_id ───────┤
  ├─ forked_from_session_id         │
  └─ forked_from_message_id         │
                                   ▼
agent_message
  ├─ previous_message_id ───── 物理祖先链
  ├─ retained_from_message_id ─ compaction 保留尾部起点
  ├─ type / status
  └─ workspace_id

agent_message_part / agent_tool_execution
  └─ 关联到历史 message 或其 part；Fork 不复制这些记录
```

Fork 后 source 与 child 共享既有不可变消息图，但分别拥有独立的：

- `headMessageId`；
- `contextRootMessageId`；
- `revision`；
- `session_run_state`；
- 此后追加的消息分支与 compaction。

因此，任一 Session 后续继续对话、压缩或 Revert 都只更新自己的 Session 指针，不会修改另一个 Session。

## Compaction 的现状

相关写入在 `apps/api/src/modules/agent/agent-message.store.ts` 的 compaction commit 路径。

compaction 会：

- 插入一条 `type = compaction`、`status = completed` 的 summary message；
- 让 summary 的 `previous_message_id` 指向压缩前 head；
- 按需要写入 `retained_from_message_id`；
- 更新**被压缩 Session 自己的** `head_message_id` 与 `context_root_message_id` 到 summary。

compaction 不会删除压缩前的：

- `agent_message`；
- `agent_message_part`；
- `agent_tool_execution`；
- provider replay 数据；
- 历史附件引用。

消息图的删除只在 Workspace 清理流程中发生，参考 `apps/api/src/infra/db/workspace-agent-data-cleanup.ts`。因此，压缩前消息仍可作为历史 Fork 的物理节点，但必须由新的 Fork 规则选择合法 root。

## 当前 Fork 的问题

`forkMessageSession()` 位于：

```text
apps/api/src/modules/agent/agent-message.store.ts
```

当前逻辑同时具有两项行为：

- target 位于来源当前 `contextRootMessageId` 之前时，抛出 `FORK_TARGET_BEFORE_CONTEXT_ROOT`；
- 创建 child 时使用：

```text
contextRootMessageId = source.contextRootMessageId ?? targetMessageId
```

前者使压缩前历史 target 无法 Fork。后者在 target 位于当前 root 之前时也不能直接复用：若只删除拒绝校验，child 会指向位于 target 之后的 root，root 不属于 child head 的祖先链。

这不是 API Schema 缺少参数，而是 Fork 领域规则与 child Session root 写入策略共同造成的限制。

## 模型上下文读取

`apps/api/src/modules/agent/read-side/model-context-resolver.ts` 的职责分为两层：

- 从 Session `headMessageId` 沿 `previous_message_id` 读取完整物理祖先链；
- 按 `contextRootMessageId` 选择交给模型的逻辑上下文。

逻辑选择规则：

| root 状态 | 交给模型的历史 |
|---|---|
| `null` | target 前完整物理消息前缀 |
| 普通 message | root 至 head 的消息范围 |
| compaction message | summary、其 retained tail、summary 后至 head 的消息 |

若 root 不在 head 的物理祖先链，或 compaction 的 retained anchor/前驱关系不合法，Resolver 必须抛出 `ModelContextInvariantError` 并 fail-close，不能悄然构建部分上下文。

历史工具/附件投射由 `apps/api/src/modules/agent/read-side/runtime-transcript-projector.ts` 参与：历史工具结果不是完整重放，历史图片不会作为新 Run 的实际 image attachment 再发送给模型。

## 当前前端耦合

完整 display chain 查询和范围标记来自：

```text
apps/api/src/modules/agent/read-side/sqlite-message-query.ts
```

时间线仍展示压缩前消息，但用 `inCurrentOperationRange` 标记当前操作范围；压缩前消息通常标记为 `false`。

前端 `apps/web/src/features/workspace/tools/agent/agentMessageTimeline.ts` 的 `canMutateAgentTimelineMessage()` 目前将：

- `inCurrentOperationRange`；
- 可 Fork 的 User/Assistant 条件与 text-part 展示限制；
- 可 Revert 的 User 条件；

合并成一个判断。`AgentClientPane.vue` 又依赖它显示消息操作，导致压缩前消息既不能 Revert，也不能 Fork。

此外，conversation row 是按 part 渲染的，一条 message 可以没有 part、也可以有 position 不从 `0` 开始的多个 part。操作按钮不能依赖 `row.part?.position === 0`，否则合法无 part Assistant 或首 part position 非 `0` 的消息没有稳定入口，多个 part 又可能重复显示操作。本次必须拆分 Fork/Revert eligibility 与 `AgentMessageActions.vue` 的可见性 props，并为每条 message 显式建模唯一操作锚点，不能只在 UI 中绕过 range 标记。

## 相关测试定位

| 范畴 | 主要文件 |
|---|---|
| 消息图、compaction、Fork、Revert | `apps/api/src/modules/agent/agent-message.store.test.ts` |
| 上下文解析与 retained tail | `apps/api/src/modules/agent/read-side/model-context-resolver.test.ts` |
| Session 应用层 | `apps/api/src/modules/agent/session/session-interaction-application.test.ts` |
| HTTP/Session 集成 | `apps/api/src/modules/agent/integration/agent-session-routes.integration.test.ts` |
| 模型 override / Fork 运行语义 | `apps/api/src/modules/agent/integration/agent-session-model-runtime.integration.test.ts` |
| subtask 血缘与内部 Fork | `apps/api/src/modules/agent/integration/agent-subtask-lineage.integration.test.ts` |
| 前端 eligibility helper | `apps/web/src/features/workspace/tools/agent/agentMessageTimeline.test.ts` |
| 前端操作组件与面板 | `apps/web/src/features/workspace/tools/agent/AgentMessageActions.component.test.ts`、`AgentClientPane.component.test.ts` |
