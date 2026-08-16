# Subtask 最大嵌套深度设计

> 状态：已定稿，作为开发、代码审查和验收依据。
> 范围：Agent runtime 的 `maxSubtaskDepth` 全局配置与 subtask 嵌套运行限制。
> 目标版本：在当前 `agent-workbench` 代码基线上实施。

## 文档导航

- [产品方案与边界](./product-and-boundaries.md)：需求背景、术语、不变量、产品行为、非目标与取舍。
- [技术设计](./technical-design.md)：配置、数据模型、算法、时序、模式边界、错误、迁移与代码落点。
- [实施计划与验证](./implementation-and-verification.md)：任务拆分、实施步骤、测试矩阵、验收标准、审查清单与排查回滚。
- [现有代码引用](./code-reference.md)：实施前必须核对的当前代码入口、函数、类型和测试位置。

## 一页结论

- 新增实例全局 runtime setting：`maxSubtaskDepth`。
  - 默认值：`1`。
  - 合法范围：整数 `1` 到 `5`，包含边界。
  - `0` 为非法值；本期不提供“关闭 subtask”的配置语义。
- 根运行（独立 primary session 的首个 run）深度固定为 `0`。
- subtask child run 的深度固定为 `parentRun.subtaskDepth + 1`。
- subtask 可嵌套；可用性不再由 `session.kind` 决定，而由当前 run 的深度和实时配置决定。
- 仅在 `agent_run` 增加可空字段：
  - `subtask_depth`
  - `parent_run_id`
  - `parent_tool_item_id`
- 旧 run 不回填。`subtask_depth = NULL` 表示深度未知；该 run 可以继续普通运行，但不能创建 subtask，也不会向模型暴露 `subtask` 工具。
- 不增加 invocation/reservation 表，不增加 lease、stale takeover、恢复状态机或多进程复杂恢复。
- 使用 partial unique index 对同一 `(parent_run_id, parent_tool_item_id)` 轻量去重；已创建的 child run 被直接复用。
- start 成功响应带内部 `reused` 标识：新 child 为 `false`；同一 invocation 命中 existing child 为 `true`。复用 running child 时 worker 只轮询其 status 至 terminal，绝不重复执行或接管该 child。
- compaction run 继承该 session 当前/最近有效 run 的深度；它不增加深度，两个 parent 字段均为 `NULL`，且不属于 subtask invocation。
- UI 只在 `/settings/agent/runtime` 展示配置输入和说明；不展示任何 session/run 的当前深度。

## 规范优先级

本目录中的文件共同构成规范。若出现表述冲突，按以下优先级理解：

- 本文件中的“一页结论”和 `product-and-boundaries.md` 的不变量优先。
- `technical-design.md` 定义可执行的后端、数据库与运行时行为。
- `implementation-and-verification.md` 定义实现顺序、验收断言和审查标准。
- `code-reference.md` 是当前代码基线的导航，不改变上述行为约束。

实施中发现当前代码与本文档前提不一致时，先更新设计并评审，再开始实现；不得以隐式降级方式改变已定稿的行为。
