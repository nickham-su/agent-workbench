# 产品方案与边界

## 需求背景

`subtask` 会创建并运行子任务。现有实现将所有 `kind="subtask"` 会话中的 `subtask` 工具直接隐藏，因此能够避免递归，但也完全禁止了合法的多层委派。

产品需要在保留递归成本边界的前提下支持嵌套：主任务可以创建子任务，子任务在未达到配置上限时也可以继续创建子任务。限制必须由后端强制执行，避免仅靠提示词或前端工具可见性造成递归失控、运行错误或成本放大。

本项目主要面向个人使用和 Docker Compose 部署。本设计优先选择可维护、低实现成本的行为；不针对极低概率的多进程竞争和崩溃恢复引入复杂状态机。

## 术语

| 术语 | 精确定义 |
|---|---|
| runtime setting | 存在 `settings` 表的 `agent_runtime_v1` JSON 内、对整个实例生效的设置。 |
| root run | 独立创建的 primary session 的首个 run，深度为 `0`。 |
| run depth | `agent_run.subtask_depth`。非负整数表示已知深度；`NULL` 表示未知深度。 |
| parent run | 创建本次 subtask tool item 的 run。它写入 child run 的 `parent_run_id`。 |
| subtask invocation | 某个 `parent_run_id + parent_tool_item_id` 对应的一次逻辑 subtask 调用。本期不建独立实体。 |
| child run | 由 `subtask` tool item 启动的 run；无论 session mode 是 `new`、`fork` 还是 `existing`，均是 child run。 |
| 普通 fork | 用户经 UI fork session 的行为；它不是 `subtask` tool invocation。 |
| unknown | `subtask_depth = NULL`。表示旧数据或 fork 来源不能确定，绝不等价于 `0`。 |

## 配置定义

```text
键名：maxSubtaskDepth
类型：整数
默认值：1
合法范围：1..5（包含边界）
作用域：实例全局 runtime setting
```

`0`、负数、小数、非数值和大于 `5` 的输入全部非法。产品不设计“完全关闭 subtask”的设置；需要调整能力时，用户只能选择 `1` 至 `5`。

## 不变量

以下规则是实现、审查和验收的强制条件：

- 独立 primary session 的首个 run 必须写入 `subtask_depth = 0`。
- child run 的深度必须等于本次 `parent run` 深度加 `1`，不得由模型、worker 请求参数或 child session 历史决定。
- `parentRun.subtaskDepth = NULL` 时，任何 subtask start 必须返回 `409 AGENT_SUBTASK_DEPTH_UNKNOWN`，且不得创建 child session 或 child run。
- `parentRun.subtaskDepth + 1 > maxSubtaskDepth` 时，任何 subtask start 必须返回 `409 AGENT_SUBTASK_MAX_DEPTH_EXCEEDED`，且不得创建 child session 或 child run。
- 当且仅当当前 run 深度已知且 `currentDepth < maxSubtaskDepth` 时，模型 prompt 中包含 `subtask` 工具。
- 工具可见性是体验优化；内部 `/subtask/start` 后端校验始终是最终限制。
- 同一 `(parent_run_id, parent_tool_item_id)` 已有 child run 时，必须直接复用它；不得因重试创建第二个 child run。
- 深度判断仅依赖 run 字段，不能递归推断 session 的 `forked_from_*` 字段。
- `session.kind === "subtask"` 继续禁止用户侧发送消息；嵌套仅允许 worker 在 subtask run 内部调用 `subtask`。
- start 成功响应必须包含内部 `reused` 布尔值；复用 child run 时 worker 不得重复执行该 run。

## 深度业务逻辑

### 根运行与同会话继续

| 场景 | 新 run 深度 | 父字段 |
|---|---:|---|
| 新建独立 primary session 的第一条用户消息 | `0` | 两个父字段均为 `NULL` |
| 已知深度 primary session 的后续用户消息 | 继承该 session 最近一次 run 的深度 | 继承语义不构成 subtask invocation；父字段保持 `NULL` |
| 最近一次 run 深度为 `NULL` 或不存在可用来源的旧 session | `NULL` | 两个父字段均为 `NULL` |

“最近一次 run”必须按该 session 的实际 run 创建时间/顺序查询，而不是按 context item 的复制内容推断。

### Subtask 嵌套

```text
root run depth 0
  -> child depth 1
    -> child depth 2
      -> ...
```

当 `maxSubtaskDepth = 1`：depth 0 可以创建 depth 1；depth 1 不可以继续创建 child。

当 `maxSubtaskDepth = 5`：最多允许创建 depth 5；depth 5 不可以继续创建 child。

同一 parent run 创建多个 sibling 时，每个 sibling 的深度相同，均为 `parentDepth + 1`。本期不限制 sibling 数量或并发数。

### Compaction run

用户触发上下文压缩时，`compactSession()` 创建的 compaction run 不属于 subtask invocation，也不增加深度：

- 读取该 session 当前/最近有效 run 的 `subtask_depth`；已知 N 时 compaction run 写 N，unknown 或没有可用 run 时写 `NULL`。
- `parent_run_id` 和 `parent_tool_item_id` 始终写 `NULL`。
- 压缩不会使 unknown 历史会话变成 root，也不会令已知会话改变 depth。

“最近有效 run”按 `created_at DESC, run_id DESC` 确定。此规则与普通同会话继续一致，避免压缩改变会话后续 subtask 能力。

### `new`、`fork`、`existing`

| mode | child session 行为 | child run 深度和父链 |
|---|---|---|
| `new` | 创建新的 subtask session。 | 永远按本次 parent run：`parentDepth + 1`，写入 parent run/tool item。 |
| `fork` | 创建带父上下文的 subtask session；可以走 prefork summary、无 boundary 或 context fork 分支。 | 三条分支的 run lineage 完全相同；context 来源不参与深度计算。 |
| `existing` | 复用已有 subtask session，并在其中创建新 run。 | 不读取、不修改 existing session 的历史深度或来源；仍按本次 parent run 计算。 |

因此，一个 existing session 可以被不同深度的调用复用；每个 run 自己保存本次调用的深度。

### 普通 UI fork

普通 fork 不增加深度。fork 后首次创建 run 时：

- 从新 session 的 `forked_from_session_id + forked_from_item_id` 找到**源 session 的原始 context item**。
- 读取该原始 item 的 `runId`，再读取来源 run 的 `subtask_depth`。
- 来源 run 存在且深度已知：新 run 继承该深度，`parent_run_id` 写来源 run ID，`parent_tool_item_id` 为 `NULL`。
- 来源 run 存在但来源深度为 `NULL`：新 run 写入 `NULL`，`parent_run_id` 写来源 run ID，`parent_tool_item_id` 为 `NULL`。
- 原始 item 的 `runId` 为 `NULL` 或来源 run 不存在：新 run 写入 `NULL`，两个父字段均为 `NULL`。

`forkSession()` 复制到 child session 的 context item 会清空 `runId`、`turnId`、`step`。不得从复制后的 item 反向推导来源深度；必须从 `forked_from_*` 指向的源 item 查找。

## 用户可见产品方案

### Runtime 设置页

在 `/settings/agent/runtime` 增加一个整数输入：

```text
标签：Subtask 最大嵌套深度
范围：1–5
默认：1
```

说明文案必须表达以下完整语义：

> 限制 subtask 调用链的最大嵌套层级。独立主会话的首个 run 为第 0 层。设为 1 时，仅允许主 run 创建第一层 subtask；该设置只限制嵌套深度，不限制同层子任务数量、并发数或 token 消耗。

UI 不展示：当前深度、session 标签、父 run、调用链图、unknown 状态或迁移状态。

### 错误体验

后端沿用现有 `{ message, code }` 错误和 worker 文本错误传播，不新增结构化 worker/UI 错误对象。必须使用下列错误：

| code | HTTP | 确定含义 | 持久化行为 |
|---|---:|---|---|
| `AGENT_MAX_SUBTASK_DEPTH_INVALID` | 400 | `maxSubtaskDepth` 不是整数 `1..5`。 | 不写入请求值；保留原有 runtime setting。 |

subtask start 必须使用下列错误：

| code | HTTP | 确定含义 | 文本消息要求 |
|---|---:|---|---|
| `AGENT_SUBTASK_DEPTH_UNKNOWN` | 409 | parent run 的深度为 `NULL`。 | 表示当前调用链深度无法确定。 |
| `AGENT_SUBTASK_MAX_DEPTH_EXCEEDED` | 409 | 计算得到的 child depth 超过当前配置。 | 表示已达到最大嵌套深度。 |

这两类错误都不应自动重试。同一 tool item 如果已创建 child run，优先复用 existing child，不重新触发深度校验。

### 同一 invocation 的幂等复用

start 命中同一 `(parent_run_id, parent_tool_item_id)` 的已有 child run 时，响应返回 `reused=true`：

- child 为 `completed`、`failed` 或 `cancelled`：worker 不重新执行，直接读取并复用已有 status/result。
- child 为 `running`：worker 不重新执行，也不创建 child；它轮询已有 child status，直到 terminal，再按对应 terminal 结果处理。
- 新建 child：返回 `reused=false`，worker 执行一次 `processNestedRun()`。

该等待只服务于同一 invocation 的轻量幂等复用。它不创建 reservation 表、不接管 child run、不增加 lease/stale/recovery 状态机，也不改变 sibling、并发或预算边界。

## 动态配置语义

- 每个**尚未创建 child run**的 subtask start 使用请求时读取到的最新 `maxSubtaskDepth`。
- 已有 child run 的同一 `(parentRunId, parentToolItemId)` 直接复用，配置随后下调不影响该 run。
- 已开始的 run 不热更新 prompt 的工具列表；运行开始后改变设置不会撤回该 run 已拿到的 tools。
- 新启动的 run 使用启动时读取的最新设置决定工具可见性。

## 非目标

本期明确不做以下内容：

- 配置值 `0` 或关闭 subtask 的产品语义。
- 横向 sibling 数量、并发数、token、预算、总调用次数或总运行时间限制。
- `agent_session` 深度字段、`forked_from_run_id` 字段或 invocation/reservation 表。
- lease、stale takeover、`recovery_blocked`、child run 接管、orphan 自动修复或多进程恢复设计。
- 历史 run 深度回填、历史 lineage 重建，或让历史会话获得完整嵌套功能。
- 当前 depth 的 UI 展示或调用链可视化。
- worker/API 的新结构化错误协议和专用 UI 错误组件。
- 放开用户直接向 `kind="subtask"` session 发送消息。

## 关键取舍

| 决策 | 选择 | 原因和接受的代价 |
|---|---|---|
| 历史数据 | 不回填，`NULL` fail-closed。 | 显著降低迁移和推导复杂度；旧会话不能继续派生 subtask 时，用户新建会话即可。 |
| 幂等 | child run 表唯一索引 + 查询复用。 | 覆盖常见网络重试；进程恰在 session 创建与 run 创建之间退出时可能留下空 child session，接受该低概率残留。 |
| 并发恢复 | 不建 reservation 状态机。 | 项目以个人 Docker Compose 使用为主，复杂恢复的维护成本高于收益。 |
| 工具控制 | prompt 隐藏 + API 强校验。 | 兼顾模型体验和不可绕过的服务端限制。 |
| 普通 fork | 从源 item 的 runId 最低成本继承。 | 不修改 fork API 或 session schema；无法追溯时明确变为 unknown。 |
