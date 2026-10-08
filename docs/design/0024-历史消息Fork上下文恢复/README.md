# 历史消息 Fork 上下文恢复

> 状态：详细设计，面向开发、代码审查、自动测试与验收。
>
> 范围：允许从已压缩 Agent Session 的压缩前历史消息创建新的 Fork Session；压缩前 Revert 继续禁止。
>
> 设计原则：以 Fork target 所在历史时点为准恢复有效上下文，不以来源 Session 当前的压缩边界决定新 Session 的上下文。

## 快速结论

当前 compaction 会追加一条摘要消息并移动来源 Session 的 `headMessageId` 与 `contextRootMessageId`，但不会删除压缩前的消息图。当前 Fork 仍会拒绝 `contextRootMessageId` 之前的 target，且创建新 Session 时直接使用来源当前 root；因此不能从压缩前历史安全分叉。

本设计将所有 Fork 统一为以下语义：

```text
source 当前物理祖先链
  → 校验 target 是可 Fork 的稳定消息
  → 从 target 沿 previous_message_id 向祖先查找最近 compaction
  → 得到 target 时点的 context root
  → 创建新的 Fork child Session：
      headMessageId = target
      contextRootMessageId = 最近 compaction 或 null
```

上述语义由 `apps/api/src/modules/agent/agent-message.store.ts` 的 `forkMessageSession()` 统一实现，适用于公开 primary Fork 与所有基于消息图 clone 的内部 Fork（包括 subtask）。调用方的 `boundaryPolicy` 只负责在进入该权威写入路径前解析 target，不得改变 child 的 target-time root 计算。

该改造不复制历史 message、part 或 tool execution，不变更数据库结构和公开 HTTP 合同；Fork 后的模型配置解析、消息发送、Run 生命周期与前端成功导航均复用现有路径。

## 已冻结的产品决策

- 压缩前、仍在来源 Session 当前物理祖先链上的合法 User/Assistant message 可以 Fork。
- 压缩前 Fork 不增加确认框、提示、警告 toast 或额外 i18n 文案。
- 只放开 Fork；压缩前 Revert 继续拒绝。
- 所有基于消息图 clone 的 Fork 均按 target 所在历史时点计算上下文 root；不再直接继承来源 Session 的当前 root。
- 公开 Fork 的来源 Session 仍必须 idle，现有 head/revision 事务防护、Workspace 边界和稳定性校验保持不变。
- 内部 subtask 保持既有 `allowSourceWithActiveRun` 特例和 `boundaryPolicy` 的 target 解析职责；不得因本次统一 root 语义而改变 active parent run、internal-resolved boundary、guard→prompt、prefork summary、lineage、locale/depth 或工具限制。
- 产品口语中的“已完成”指现有技术上的终态：`completed`、`failed`、`cancelled`、`superseded`。本次保持 `messageTerminal()` 的兼容语义，不收紧为仅 `completed`。
- Fork 不继承来源 Session 的模型 override；本次不改变该现状。
- 本功能恢复的是历史对话文本与摘要上下文，不是 Workspace、Git、工具、网络、外部服务或模型运行状态的确定性回放。

## 明确排除

不得将以下内容混入本轮：

- 定时任务、任务模板、任务调度或后台自动执行；本能力可作为其前置基础，但本次只改通用 Fork。
- Revert 到当前 `contextRootMessageId` 之前的历史消息。
- 数据库 migration、公开 API 参数或响应字段变更。
- 复制或重写历史 message、message part、tool execution、附件或 provider replay 数据。
- 调整 internal subtask 的 target 选择、boundary policy、运行权限、lineage、locale/depth、工具限制或 guard/prompt 协议。
- 来源 Session 模型 override 的继承。
- Fork 前 token 预估、自动压缩、额外确认/提示、自动重试或新的错误通知策略。
- archive 专用 Fork UI、跨 Workspace Fork、从 tool call/result/reasoning part 精确 Fork。

## 阅读路径

| 文件 | 用途 |
|---|---|
| [01-background-and-scope.md](./01-background-and-scope.md) | 需求背景、用户价值、范围和端到端业务逻辑 |
| [02-product-contract-and-decisions.md](./02-product-contract-and-decisions.md) | 产品合同、冻结决策、兼容性取舍和非目标 |
| [03-current-state-and-code-map.md](./03-current-state-and-code-map.md) | 当前实现、数据关系、调用链和代码定位 |
| [04-backend-technical-design.md](./04-backend-technical-design.md) | 上下文 root 算法、事务、错误边界和后端改造 |
| [05-frontend-interaction-design.md](./05-frontend-interaction-design.md) | 时间线操作资格拆分与既有交互保持 |
| [06-edge-cases-and-invariants.md](./06-edge-cases-and-invariants.md) | 完整边界矩阵、数据不变量和运行时限制 |
| [07-testing-and-acceptance.md](./07-testing-and-acceptance.md) | 测试矩阵、验收标准和最小自检 |
| [08-implementation-plan-and-review-checklist.md](./08-implementation-plan-and-review-checklist.md) | 开发任务拆分、实施步骤、审查与复审清单 |

## 规范性约定

- “必须”表示开发、审查和验收的强制要求；“不得”表示禁止范围；“保持现状”表示以实施前冻结的代码语义和测试为准。
- 本目录中的文件共同构成一个设计合同；发生冲突时，以 [02-product-contract-and-decisions.md](./02-product-contract-and-decisions.md) 的冻结决策为准。
- 文档中的代码路径用于定位实现职责，不要求在同一文件中完成所有改动；但不得借本需求进行无关重构。
