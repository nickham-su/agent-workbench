# Worker → API 核心写回协议统一（1B）

> 状态：详细设计，面向开发、独立代码审查、自动/手动验收与后续接手。
> 范围：统一 Agent Worker 写回 API 的核心 run、context 与 subtask 生命周期协议；以当前实现为基线，除明确列出的非法内部输入收紧外，不改变既有业务行为。
> 前提：1A（API → Agent Worker 控制面协议统一）已完成；本方案不重新设计 1A。

## 快速结论

本次纳入九个既有 Worker → API endpoint，并固定按四个业务批次迁移：

```text
P1-1  POST /api/internal/agent/run-state
      POST /api/internal/agent/run-complete

P1-2  POST  /api/internal/agent/context-items
      PATCH /api/internal/agent/context-items/:itemId

P1-3  POST /api/internal/agent/context/compact

P1-4  POST /api/internal/agent/subtask/prefork-plan
      POST /api/internal/agent/subtask/start
      POST /api/internal/agent/subtask/result
      POST /api/internal/agent/subtask/status
```

实施方式：

- 在现有 `packages/shared/src/internal-contracts/` 内新增 `agent-api.ts` 聚合入口，以及内部的 `agent-api-run.ts`、`agent-api-context.ts`、`agent-api-subtask.ts`。
- `@agent-workbench/shared/internal-contracts/agent-api` 是 **唯一新增公开子路径**；三个领域文件只供该聚合入口内部使用，不加入 package exports。
- API Route 与 Worker `AgentApiClient` 必须使用同一 endpoint 定义、TypeBox schema 和类型；Route 不再复制等价匿名 HTTP 类型。
- 原子迁移：每一批同时修改 shared、API Route、Worker Client 和对应测试；完成独立审查、修复、复审并暂存后，才进入下一批。
- 复用公共 `AgentContextItemOutputSchema` 与 `AgentContextItemRecordSchema`，不新建 compatibility schema，也不默认修改 `packages/shared/src/contracts/*`。
- `AWB_INTERNAL_RPC_RESPONSE_VALIDATION=strict|warn` 从 1A 扩展到 Worker → API 成功响应校验。默认 `strict`；`warn` 仅允许绕过“2xx、JSON 可解析、但成功响应 schema 不匹配”。
- 不增加版本号、长期双协议兼容、通用 retry/timeout、事务重构或新的 RPC 基础设施。

## 阅读路径

| 文档 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、目标、端到端链路、范围与非目标 |
| [02-product-contract.md](./02-product-contract.md) | 九个 endpoint 的产品/HTTP 合同、状态与边界语义 |
| [03-decisions.md](./03-decisions.md) | 已冻结决策、取舍、暂停条件 |
| [04-technical-design.md](./04-technical-design.md) | 目录、exports、schema、Route/Client/config 迁移设计 |
| [05-code-map.md](./05-code-map.md) | 文件、符号、行号、事务与副作用地图 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 自动测试矩阵、审查清单、手测与完成定义 |
| [07-implementation-plan.md](./07-implementation-plan.md) | P0/P1/P2 分批实施、审查、暂存与回滚边界 |
| [08-follow-up-recommendations.md](./08-follow-up-recommendations.md) | 与本期隔离的后续治理建议 |

## 规范性约定

- “必须”表示实现、审查和验收要求；“保持现状”表示以实施前代码与冻结测试为准。
- 本目录中更具体的产品合同和技术边界优先于泛化建议。
- 行号用于定位调研基线；实施前应复核当前工作区，发现行为差异必须暂停该批次并更新设计/测试证据后再继续。
- `200 { ok: true }` 在本协议中表示请求被接受并按当前规则处理，**不**天然表示发生数据库变更。
- 本期不授权顺手修复已记录的并发、恢复、文件副作用、错误解析或事务问题。

## 核心不变量

- 请求当前真实顺序保持为：**Fastify schema validation → handler 内 `assertInternalToken()` → Service**。无效 token 与无效 body 同时出现时返回 schema `400`，不是 `401`；1B 不将鉴权前移。
- TypeBox `Type.Object` 未声明 `additionalProperties: false` 时，未知字段通过校验并保留；设置 `false` 时，当前 AJV `removeAdditional: true` 会剥离未知字段而非必然 `400`。
- `run-state`、`run-complete` 的既有 ignored 分支继续返回 `200 { ok: true }`。
- Context create 的 head 冲突仍为 `409`；terminal item update 仍为 `200` 返回原 item，且可能在 Store 判定 ignored 前已经有 artifact 文件副作用。
- Compaction 保留两种合法 `409` body；archive 文件、数据库和 run-state 不构成全局单一事务，rollback 仅 best-effort。
- Context output 将从 Route 的 `Type.Any()` 收紧为公共合法 output schema。这是有意拒绝非法内部 payload、避免成功响应序列化潜在 `500` 的边界修复；兼容承诺只覆盖当前合法 Worker output。
- `reused: true` 只保证 subtask child run identity 被重用；不保证整个 start 请求没有创建 session 等前置副作用。
- Worker 重启后不恢复内存 nested parent-child mapping；API public cancel 的主要级联依据是数据库 metadata，本期不承诺 recover/cancel 完全线性化。
