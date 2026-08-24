# 产品语义与业务边界

## 产品概念定义

### Primary Session

`primary` session 是用户可写、可持续对话、可 compact、可公开 fork 的独立执行根。

必须满足：

- 用户普通消息可以在该 session 中创建 Run；
- compact 可以在该 session 中创建 Run；
- 所有 ordinary Run 的 `subtaskDepth` 固定为 `0`；
- ordinary Run 的 `parentRunId` 和 `parentToolItemId` 固定为 `null`；
- 是否由其他 primary session fork 而来，不改变执行根语义；
- `forkedFromSessionId` 和 `forkedFromItemId` 只用于记录上下文分支来源。

### Subtask Session

`subtask` session 是内部 subtask 执行载体，不是用户可写主会话。

必须满足：

- 只能由内部 `startSubtaskRunFromWorker()` 领域流程创建或复用；
- 普通消息、compact、clear 等用户写操作继续返回 `AGENT_SUBTASK_READONLY`；
- Run depth 由当前真实 parent Run 计算，而不是由 session 历史或 fork source item 推导；
- `new`、`fork`、`existing` 三种内部模式继续保留；
- session 本身不拥有固定 depth，depth 始终属于具体 `agent_run`。

最后一条对 `existing` 模式尤其重要：同一个 subtask session 可以承载后续继续执行的 Run；每个新 Run 的 depth 都按本次 parent Run 的 depth `+1` 计算，不继承该 session 最近 Run 的 depth。

### Ordinary Primary Run

ordinary primary Run 是通过 primary session 的用户侧/通用触发入口创建的 Run。目前生产创建入口包括：

- `AgentService.sendMessage()`；
- `AgentService.compactSession()`；
- `POST /api/internal/agent/runs/trigger`，其内部委派 `sendMessage()`，不是独立写入路径。

当前生产代码中 `createRunRecord()` 的业务调用只有：

- ordinary message Run；
- compact Run；
- internal subtask child Run。

未来新增 primary Run 入口时，也必须复用同一个 primary Run 不变量，不得重新引入 lineage 推导。

### Subtask Child Run

subtask child Run 只能由合法的 `subtask` tool item 触发。

必须满足：

- parent session、parent Run、tool item 的 workspace/session/run ownership 全部匹配；
- tool item 的 `toolName` 必须是 `subtask`；
- `childDepth = parentRun.subtaskDepth + 1`；
- `childDepth <= maxSubtaskDepth`；
- `parentRunId = parentRun.runId`；
- `parentToolItemId = subtask tool item id`；
- 同一 `(parentRunId, parentToolItemId)` 保持现有幂等语义。

## Fork 的产品定义

### 公开 Primary Fork

公开 fork 的定义是：

> 从一个 primary session 的指定 user/assistant 边界复制上下文，创建另一个独立、用户可写的 primary session。

公开 fork 不是：

- subtask 调用；
- Run parent-child 关系；
- subtask depth 的延续；
- source Run 的继续执行；
- copied item 的执行 ownership 转移。

公开 fork 必须遵守：

| 维度 | 规则 |
|---|---|
| source session | 必须为 `primary` |
| target session | 固定为 `primary` |
| boundary | 保持现有公开规则，只允许 user/assistant |
| mode | 保留 `visible_only` 与 `with_archive` |
| copied item `runId` | 固定为 `null` |
| target ordinary Run depth | 固定为 `0` |
| target ordinary Run parent | 双空 |
| fork metadata | 继续保存 `forkedFromSessionId/forkedFromItemId` |

### 内部 Subtask Fork

内部 subtask 的 `session.mode = "fork"` 定义是：

> 为 child subtask session 复制 parent 上下文，以便 child Run 获得必要历史；它仍是一次真实 subtask 调用，Run depth 必须由 parent Run `+1`。

内部 subtask fork 与公开 fork共享“复制上下文”能力，但不共享外层产品规则：

- target 是 `subtask`；
- boundary 可以由内部 `resolveSubtaskForkBoundaryItemId()` 解析；
- 可以允许内部需要的非公开边界类型；
- 继续插入 fork guard system message；
- prefork summary 行为保持；
- child Run 写真实 parent 字段。

内部 subtask session 的 origin metadata 和 context 规则不是实现自由度，必须遵循以下业务真值：

| 模式/路径 | `forked_from_session_id` | `forked_from_item_id` | context 顺序 |
|---|---|---:|---|
| `new` | parent session | parent subtask tool item | prompt |
| `fork` + prefork summary | parent session | parent subtask tool item | summary → guard → prompt |
| `fork` + clone boundary | parent session | 实际 clone boundary item | cloned transcript → guard → prompt |
| `fork` + 空 boundary | `null` | `null` | guard → prompt |
| `existing` | 保持既有值 | 保持既有值 | existing head → prompt |

除幂等命中直接复用既有 child 外，以上每个成功分支都创建本次 child Run，并按本次 parent depth `+1` 写真实 parent Run/tool字段。完整条件、是否clone和item ownership见 [`04-target-architecture-and-entities.md`](./04-target-architecture-and-entities.md) 的真值表。

因此不得简单给现有 `forkSession()` 加 primary-only 校验。必须先拆出私有 context clone 原语，再分别提供公开 primary fork 和内部 subtask fork 编排。

## 最大嵌套深度的精确定义

`maxSubtaskDepth` 只限制真实 subtask tool 调用链。

当配置为 `2` 时：

| Run 类型 | Depth | 是否可继续看到 `subtask` |
|---|---:|---:|
| primary ordinary Run | 0 | 是 |
| 第一层 subtask child Run | 1 | 是 |
| 第二层 subtask child Run | 2 | 否 |

工具是否暴露继续由：

```ts
run.subtaskDepth != null && run.subtaskDepth < maxSubtaskDepth
```

决定；创建 child 时继续用：

```ts
childDepth = parentDepth + 1
childDepth <= maxSubtaskDepth
```

公开 primary fork 创建新的执行根，所以 target ordinary Run 从 `0` 开始。这是产品定义，不是绕过最大深度：

- 公开 fork 不能从 subtask session 发起；
- subtask session 保持只读；
- 真实 subtask child 只能通过内部 start 创建；
- primary 与 subtask 的创建入口由服务端强制隔离。

## `existing` Subtask 模式边界

`session.mode = "existing"` 保留，不在本次删除。

它的用途是：

- 继续或复用一个已经由内部 subtask 流程创建的只读 subtask session；
- 支持现有取消后继续提示和内部工作流；
- 保留现有幂等、session running、workspace、kind 校验。

它不得用于：

- 引用公开 create 手工构造的 subtask session；
- 把 primary session 转成 subtask；
- 绕过 parent tool anchor 校验；
- 继承 existing session 最近 Run 的 depth。

本次调用创建的新 child Run 仍使用：

```text
本次 parent Run depth + 1
```

生产上可被 `existing` 引用的 session 必须来自先前成功的内部 subtask `new` 或 `fork` 创建流程。测试中如果需要构造损坏、跨 workspace、running 等异常记录，可以使用 testkit/store fixture，但不得保留公开 API 创建 subtask 的生产后门。

## 公开和通用 Internal API 边界

### 公开创建 Session

`POST /api/agent/sessions` 只创建 primary session。

目标契约：

```ts
{
  workspaceId: string;
  title?: string;
}
```

`kind` 从请求契约移除。请求携带 `kind` 应作为不合法额外字段返回 `400`，不得静默把 `subtask` 降级为 primary。

### 通用 Internal 创建 Session

`POST /api/internal/agent/sessions/create` 仍服务于插件等通用 primary session 创建，但同样只创建 primary。

目标契约与公开 create 一致，不再接受 `kind`。当前 Feishu plugin 未传 `kind`，因此内置调用不受影响。

“internal”不等于“subtask domain”。只有 `/api/internal/agent/subtask/start` 才能创建 subtask session。

### 公开 Fork

`POST /api/agent/sessions/fork` 的请求中移除 `kind`，服务端额外验证 source session 为 primary，target 固定为 primary。

请求携带 `kind` 应返回 schema validation `400`。source 是 subtask 时应返回稳定业务错误，例如：

```text
400 AGENT_FORK_SOURCE_KIND_INVALID
```

具体错误文本可遵循现有项目风格，但错误码必须由测试冻结，不能仅依赖 UI 不展示按钮。

### 响应契约

以下内容保持不变：

- `AgentSessionKindSchema` 仍包含 `primary | subtask`；
- `AgentSessionRecordSchema.kind` 保持，因为列表、详情和内部结果仍需表示 subtask；
- fork/create 成功响应仍返回 `AgentSessionRecord`；
- internal subtask start request/response contract 保持。

## 历史数据与发布后行为

本次不做数据库回填，不修改历史 Run。

历史 primary session 可能存在：

- `subtaskDepth = null`；
- 非零 `subtaskDepth`；
- 普通 fork Run 的 `parentRunId` 指向 source Run；
- copied item 的 `runId = null`。

发布后规则：

- 历史记录保持原样，继续可读；
- primary session 下一次新 ordinary Run 固定写 depth `0` 和双空 parent；
- 旧 Run 的 prompt/tools 快照不热更新；
- 当前活动 Run 必须结束或取消，随后发起新 Run 才能看到新规则；
- 不要求用户重新 fork 或新建 session；有问题的既有 primary session 可以通过下一次新 Run 自愈；
- copied item 不做回填，仍为 `runId = null`。

## UI 产品行为

当前 Web 创建和 fork 请求都没有发送 `kind`：

- `AgentToolView.vue` 创建 session 只发送 workspace 和 title；
- `AgentClientPane.vue` fork 只发送 source、item 和 mode。

因此内置 Web 的正常操作流程无需增加新交互。

设置页“Subtask 最大嵌套深度”帮助文案应明确：

- 所有可写 primary session，包括普通 fork 结果，其 ordinary Run 都是第 `0` 层；
- 只有 `subtask` 工具调用会增加层级；
- 最大深度不限制同层数量、fork 数量或 primary session 数量。

## 明确不允许的解释

实施和审查不得接受以下模糊解释：

- “primary 一般是 depth 0，但某些 fork 可以继承”：不允许。
- “internal create 可以为了测试继续创建 subtask”：不允许。
- “copied item 没有 runId 是数据丢失”：错误。
- “unknown depth 时 prompt 层默认当 0”：不允许。
- “普通 fork 的 sourceRun 可以写入 parentRunId 作为追踪”：不允许；已有 `forked_from_*`。
- “existing session 自带固定 depth”：错误；depth 属于 Run。
