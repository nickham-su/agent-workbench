# Agent Session 标题手动接管设计

> 状态：已实现，待验收。
>
> 适用范围：AI Agent 工具的 Session Tab、Agent 公共 API、Session 应用层与 SQLite 持久化、首消息生命周期和 `todolist` 写回标题更新。
>
> 基线说明：本文档依据编写时的仓库代码整理。代码引用使用“仓库相对路径 + 行号/符号”，行号用于辅助定位；实施时如代码移动，应以符号和职责为准。

## 文档目的

本目录定义 Session 标题手动设置功能的完整产品与工程合同，可直接用于：

- 指导开发拆分和实施；
- 判断代码实现是否符合业务语义；
- 设计单元测试、集成测试和前端交互测试；
- 进行代码审查、发布验收和回滚评估。

## 核心结论

- 当前自动标题来自首条用户消息和成功完成的 `todolist.goal`，后写覆盖前写。
- 已持久化 Session 的 Tab 标题后增加设置按钮，点击后弹窗回填当前标题。
- 用户首次手动保存标题后，该 Session 永久进入“手动接管”状态；后续任何自动命名均不得覆盖。
- 手动接管不可恢复，本期不提供“恢复自动命名”开关、接口或隐式重置路径。
- 用户可以继续手动修改已接管 Session 的标题。
- 手动标题 Store SQL 不写 `agent_session.updated_at`；idle 且无其他写入时排序不变，运行中其他业务路径仍可独立推进活跃时间。
- 现有自动标题路径保持当前 `updated_at` 行为，避免扩大需求范围。
- Fork 创建的是新 Session，必须恢复为可自动命名状态，不继承源 Session 的手动接管标记。
- `primary` 与 `subtask` 已持久化 Session 均可手动设置；draft Session 不显示设置按钮。

## 阅读路径

| 文档 | 用途 |
|---|---|
| [01-overview.md](./01-overview.md) | 需求背景、现状、目标、非目标、术语和业务逻辑 |
| [02-product-decisions.md](./02-product-decisions.md) | 产品方案、关键决策、替代方案与取舍原因 |
| [03-technical-design.md](./03-technical-design.md) | 数据模型、契约、API、应用层、Store、前端、并发和迁移方案 |
| [04-edge-cases-and-security.md](./04-edge-cases-and-security.md) | 完整边界矩阵、错误语义、安全边界和异常恢复 |
| [05-verification-and-acceptance.md](./05-verification-and-acceptance.md) | 测试矩阵、验收标准、建议命令和回归要求 |
| [06-implementation-plan.md](./06-implementation-plan.md) | 开发任务拆分、详细实施步骤、发布、兼容与回滚 |
| [07-code-review-checklist.md](./07-code-review-checklist.md) | 代码审查清单、阻断项和最终交付证据 |

## 规范性约定

本文中的“必须”“不得”“仅”“应”属于实现和验收要求。若章节之间出现歧义，按以下优先级解释：

- [02-product-decisions.md](./02-product-decisions.md) 中“权威业务合同”表的产品与业务合同；
- [04-edge-cases-and-security.md](./04-edge-cases-and-security.md) 的边界与安全合同；
- [03-technical-design.md](./03-technical-design.md) 的工程实现合同；
- [05-verification-and-acceptance.md](./05-verification-and-acceptance.md) 的可验证标准；
- [06-implementation-plan.md](./06-implementation-plan.md) 的实施顺序建议。

## 一句话状态机

```text
自动可命名（title_manually_set = 0）
  -- 用户成功保存标题 -->
手动接管（title_manually_set = 1，永久；仅允许再次手动修改）
```

不存在从“手动接管”回到“自动可命名”的业务路径。
