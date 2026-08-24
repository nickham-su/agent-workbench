# Worker → API 读侧与生命周期治理

> 状态：详细设计初稿，面向开发、独立代码审查、自动测试、手工验收和后续维护。
> 范围：在 1B Worker → API 核心写回协议统一完成后，统一 Worker 主运行链路的 read-side contract，并治理第一批生命周期一致性边界。
> 前提：1A API → Worker 控制面协议统一与 1B Worker → API 核心写回协议统一已经完成并作为现有实现基线。本方案不回改 1A/1B 已冻结合同，除本文明确列出的 lifecycle fence 语义外，不重新设计 Agent 状态机。

## 快速结论

本轮分为两条主线，代码按批次实施：

```text
1C  read-side 主链路协议统一
    execution-profile
    prompt-context
    messages-context

1D  生命周期一致性治理第一期
    DB 收敛优先 + 轻量 DB fence
    late append/update 边界
    cancel wins 与 recover enqueue 前最终 DB 检查
    parentRunId + parentToolItemId 权威 lineage
    orphan subtask session 双级治理
    archive rollback skipped 最小 reconciliation sidecar
```

实施顺序固定为：

```text
冻结基线
  → 1C read-side contract 迁移
  → 1D lifecycle fence 与 recover/cancel
  → subtask lineage/orphan
  → archive reconciliation
```

## 本轮纳入

### Read-side

仅统一以下三个 Worker 主链路接口：

```text
POST /api/internal/agent/execution-profile
POST /api/internal/agent/prompt-context
POST /api/internal/agent/messages-context
```

统一内容包括：

- method/path registry；
- request/response TypeBox schema；
- `Static<>` 类型；
- API Route 与 Worker Client 的 shared contract 复用；
- Worker 成功响应 runtime validation；
- strict/warn 响应校验行为与 1B 保持一致。

### 生命周期

本期处理：

- terminal/cancelled run 的迟到 append/update fence；
- recover/cancel race 的 `cancel wins` 规则；
- recover enqueue 前的最终 DB 检查；
- subtask child 的 durable lineage 查询；
- 仅扫描并诊断超过 1 小时的空壳 subtask suspect，并对其中满足严格条件的对象做保守清理；
- compaction/clear 的 rollback skipped sidecar reconciliation；自动处理仅限单文件 snapshot。

## 明确排除

以下事项不得作为顺手优化混入本轮：

- `archive/search`、`archive/read` 的 read-side contract 统一；
- `plugins/*`；
- `git-env/*`；
- `mcp-settings`；
- Plugin Host 协议；
- shared contracts 独立 workspace；
- RPC/Process Manager 通用抽象；
- Agent 大文件拆分；
- 全局错误 envelope；
- 全量 timeout/retry；
- 数据库 schema 重建；
- 通用 epoch/lease/durable event；
- archive 格式变更；
- 全局事务、重型 staging 或 outbox；
- 完整 nested runtime tree recovery。

## 阅读路径

| 文件 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、现状、目标、端到端链路、范围和非目标 |
| [02-product-contract.md](./02-product-contract.md) | read-side HTTP 合同与 lifecycle 业务语义 |
| [03-decisions.md](./03-decisions.md) | 冻结决策、取舍、风险接受和暂停条件 |
| [04-technical-design.md](./04-technical-design.md) | shared contract、Route/Client、DB fence、scanner、sidecar 技术设计 |
| [05-code-map.md](./05-code-map.md) | 代码文件、符号、调用链、数据关系和调研定位 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、审查清单、验收标准和回滚验证 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 分批任务、实施步骤、审查/复审/暂存边界 |
| [08-follow-up-recommendations.md](./08-follow-up-recommendations.md) | 本轮明确后置的治理建议 |

## 规范性约定

- “必须”表示开发、审查和验收要求；“不得”表示禁止范围；“保持现状”表示以实施前实际代码和冻结测试为准。
- 本目录中的产品合同优先于泛化建议。若实施前代码与本文基线不一致，必须暂停该批次，更新代码地图、合同和测试证据后再编码。
- 本目录是设计基线，不是生产代码。所有行号都是调研时定位，实施前必须复核。
- 1C 只统一三项 read-side 主链，不得把其他内部读取接口误纳入。
- 1D 采用 DB 收敛优先；runtime 行为可以 best-effort，但不能反向污染 DB 终态。
- 正常 Context create 的 1B 成功响应是 `{ok:true,item:AgentContextItemRecord}`。1D 对该成功合同作受控扩展：late append no-op 固定为 `{ok:true,item:null,ignored:true}`。该分支不得伪造 item，也不得返回裸 `{ok:true}`；shared schema、Route、Worker Client typed response 与测试必须同步迁移。

## 与 0004（1B）的关系

- `docs/design/0004-Worker-API核心写回协议统一/` 记录的是 1B 已完成并验收的事实，其中 Context create 的正常成功 response 是完整 record。
- 本目录不否定或回写 0004 的历史事实。`{ok:true,item:null,ignored:true}` 是 1D 批次新增的、只用于 terminal/cancelled late append 的受控 response 分支。
- 正常 create 在 1D 后仍必须返回 0004 所定义的完整 record；只有满足本目录 late append 判定的 no-op 才能返回 `item:null,ignored:true`。

## 完成定义

本轮只有在以下条件同时满足时才算完成：

- 三个 read-side endpoint 的 method/path/request/response contract 已进入唯一 shared 入口；
- API Route、Worker Client、响应校验和测试证据对齐；
- cache、截断、错误状态、敏感字段业务语义未被无授权改变；
- lifecycle fence、cancel wins、lineage、空壳 orphan suspect、archive sidecar 均有实现或明确的批次验收证据；
- 每个实施批次经过独立审查、问题修复、独立复审后才暂存；
- 根 build/typecheck 与相关 Shared/API/Worker 测试通过；
- 未引入排除项中的基础设施或状态机重构。
