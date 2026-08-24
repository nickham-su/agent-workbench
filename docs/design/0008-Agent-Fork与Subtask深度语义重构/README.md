# Agent Fork 与 Subtask 深度语义重构

> 状态：P0-P5 已实施；实际回归证据、已知 Worker 全量枚举例外与最终验收口径见[实施与验收记录](./10-implementation-record.md)。
> 适用范围：Agent session 创建、普通 fork、primary Run 创建、内部 subtask session 创建与深度治理。
> 上位结构依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)。
> 已完成前置迭代：[`../0007-A-第一阶段-基线与Read-side-Prompt结构治理/`](../0007-A-第一阶段-基线与Read-side-Prompt结构治理/)；本方案基于其完成后的最新代码结构编写。

## 快速结论

当前实现把“上下文分支来源”和“subtask 执行父子关系”混合在一起：普通 primary session 创建 Run 时，会通过 `resolveRunLineageForSession()` 读取 fork source item 的 `runId`，再继承 source Run 的 `subtaskDepth`。第一次 fork 时通常可以解析；第二次从 copied item 再 fork 时，由于 copied item 正确地保存为 `runId = null`，新 Run 的 `subtaskDepth` 会变成 `null`，`PromptStaticAssembler` 随后从模型工具列表中过滤 `subtask`。

本方案不修补 copied item，也不新增 session 级 depth，而是重新建立以下业务和数据不变量：

- 所有用户可写的 `primary` session 都是独立执行根；其普通 Run，包括消息发送和 compact，固定为 `subtaskDepth = 0`。
- 公开 fork 只允许 `primary -> primary`；它只复制上下文并记录分支来源，不继承 subtask 执行深度。
- `subtask` session 只允许由内部 subtask start 流程创建，继续保持用户只读。
- copied context item 继续保持 `runId = null`；`runId` 只表达当前 session 中真实的执行归属。
- `parentRunId` 与 `parentToolItemId` 只表达真实 `subtask` 工具调用建立的父子 Run 关系。
- 公开 primary fork 与内部 subtask context clone 必须拆分；不得直接在现有 `forkSession()` 上增加 primary-only 限制，否则会破坏内部 `session.mode = "fork"`。
- `PromptStaticAssembler` 的工具过滤规则保持不变；修复点是上游 Run 写入语义，不是 read-side / prompt 投影逻辑。

## 目标状态

```text
用户创建 primary session
  → primary ordinary Run
  → depth = 0, parentRunId = null, parentToolItemId = null

primary session A
  → 公开 fork，复制上下文
  → primary session B
  → B 的 ordinary Run 仍为 depth = 0

primary/subtask parent Run，depth = N
  → 模型调用 subtask 工具
  → 内部 startSubtask
  → subtask child Run，depth = N + 1
  → parentRunId / parentToolItemId 指向真实父 Run 和真实 tool item
```

## 规范性边界

以下内容是实现、审查和验收的硬约束：

- `primary` ordinary Run 不得查询 fork source item 或历史 Run 来决定 depth。
- 公开 create/fork 入口不得创建 `subtask` session。
- 通用 internal create session 入口也不得作为 subtask 创建后门；真正 subtask session 只能由 subtask start 领域流程创建。
- 公开 fork 的 source session 必须为 `primary`，目标 session 必须为 `primary`。
- 内部 subtask `new`、`fork`、`existing` 模式继续保留；其中 `existing` 只能引用先前由内部 subtask 流程创建的 `subtask` session。
- 不得把 source `runId` 写入 copied item。
- 不得通过把 `null` depth 粗暴改成 `0` 的方式保留 `resolveRunLineageForSession()`；该 helper 对 ordinary primary Run 的职责必须被移除。
- `createPrimarySession()` 只用于无 fork metadata 的 public/internal primary create；public fork和internal subtask由各自application经private materializer创建target session。
- internal subtask各模式的`forked_from_*`、clone、summary/guard/prompt顺序以实体设计真值表为准，不得在实现中自行统一或省略。
- 不新增数据库列，不批量重写历史 Run。
- 已启动 Run 的 prompt/tools 快照不热更新；修复在部署后的新 Run 生效。

## 文档结构

| 文件 | 职责 |
|---|---|
| [01-background-and-current-state.md](./01-background-and-current-state.md) | 需求背景、故障链路、现状证据与根因 |
| [02-product-semantics-and-boundaries.md](./02-product-semantics-and-boundaries.md) | 业务定义、产品行为、会话与 Run 边界、兼容性语义 |
| [03-decisions-and-tradeoffs.md](./03-decisions-and-tradeoffs.md) | 关键决策、备选方案、取舍原因与不可采用方案 |
| [04-target-architecture-and-entities.md](./04-target-architecture-and-entities.md) | 目标职责、实体语义、契约变化与调用关系 |
| [05-technical-design.md](./05-technical-design.md) | 函数拆分、写入规则、API 收紧、existing 模式与 prompt 切点 |
| [06-implementation-plan.md](./06-implementation-plan.md) | 开发任务拆分、详细实施步骤、批次门禁与回滚点 |
| [07-testing-review-acceptance.md](./07-testing-review-acceptance.md) | 测试矩阵、验收标准、代码审查清单与发布验证 |
| [08-risks-compatibility-and-non-goals.md](./08-risks-compatibility-and-non-goals.md) | 风险、兼容性影响、非目标、停止条件与后续方向 |
| [09-code-map.md](./09-code-map.md) | 最新代码路径、函数、调用链、测试与候选改动面 |
| [10-implementation-record.md](./10-implementation-record.md) | P0-P5 实施摘要、实际执行的回归证据、Worker 全量枚举例外与最终验收口径 |

## 规范性用语

- “必须”表示开发、代码审查和验收共同遵守的要求。
- “不得”表示不允许以临时兼容、测试便利或最小改动为理由绕过。
- 文中的候选私有函数名用于明确职责；实现时可以按项目命名风格微调，但职责边界和调用方向不得改变。
- 如果实施时发现最新代码与本文证据不一致，必须先更新代码地图和设计影响，再继续开发，不得按过期行号机械修改。

## 完成定义

本方案只有在以下条件全部成立时才算完成：

- ordinary primary Run 的所有生产创建入口统一写入 depth `0` 和双空 parent 字段；
- 二次、多次 fork copied user/assistant item 后，新的 primary Run 仍能在配置允许时看到 `subtask`；
- 公开及通用 internal create/fork 均无法创建 `subtask` session；
- 内部 subtask `new`、`fork`、`existing`、prefork summary、幂等、深度限制和取消链路没有回归；
- copied item 仍为 `runId = null`；
- `PromptStaticAssembler` 的深度过滤语义未被放宽；
- Shared/API/Web/Worker 相关测试和必要手工验收通过；
- 独立代码审查确认不存在新的 subtask 创建后门或 primary depth 推导旁路。
