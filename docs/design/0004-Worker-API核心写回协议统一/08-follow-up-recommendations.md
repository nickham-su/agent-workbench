# 后续建议（不属于 1B 实施范围）

> 本文件记录 1B 调研暴露但本期明确不处理的治理项。它们不得被作为“顺手优化”混入九 endpoint 原子迁移；任何一项都需要独立范围、风险评估、设计、测试和审查。

## 协议扩展的建议顺序

建议在 1B 稳定后，按收益/风险重新评估，而不是自动开工：

```text
Worker → API read-side 协议
  -> Plugin Host 协议
  -> shared contracts 独立 workspace 评估
  -> RPC / Process Manager 基础设施评估
  -> Agent 模块拆分
```

每步的前提是前一协议在真实主力工作流中稳定，且能证明重复定义或维护成本已超过本地 incremental 修改成本。

## Worker → API read-side

候选接口包括：

```text
execution-profile
prompt-context
messages-context
archive/*
plugins/*
git-env/*
mcp-settings
```

建议沿用 1B 的先冻结后迁移方法，但要单独评估读取缓存、分页/截断、archive 文件访问、plugin/MCP 动态 payload 以及敏感输出日志。不要因为 1B 已有 `agent-api` 聚合入口，就默认将所有 read-side 一次性纳入；可按稳定业务域继续内部拆分，但应先审视唯一公开入口是否仍合适。

## Plugin Host 与进程/RPC 基础设施

当前 Agent Worker、Plugin Host 可能在 Server、Client、进程管理、socket/fetch、日志、错误处理上存在重复。后续可评估：

- 是否可抽出不携带 Agent/Plugin 业务语义的 transport/process lifecycle 小层。
- socket 与 TCP fallback、health/readiness、restart/backoff/circuit breaker 的契约是否可逐步统一。
- Plugin Host 的双运行路径、插件工具 registry 和动态协议是否有独立兼容测试。

前提是不能反向污染已稳定的 1A/1B schema。不要在未明确性能、故障恢复和启动顺序收益前建设“通用 RPC 框架”。

## 独立 contracts workspace

`packages/shared` 内部子路径是当前最低成本方案。只有满足以下信号时才重新评估 `packages/shared-contracts`：

- contracts 被多个不应依赖完整 shared runtime 的进程/发布物使用；
- shared 的构建、依赖体积或 release 边界已成为实际问题；
- 已有稳定的 contracts ownership、版本策略和跨包兼容需求。

届时需要单独决定 semver、exports、TypeBox runtime 依赖、构建图、迁移期兼容和发布顺序；不能机械搬迁。

## 生命周期一致性与恢复治理

### recover/cancel 线性化

1B 保持 API DB metadata 驱动的 cancel cascade，但未消除：

- recover enqueue 与 cancel 交错，可能 enqueue 已 DB-cancelled 的 run；
- terminal run 仍可能在 head 条件满足时迟到 append context item；
- subtask start 成功到 parent tool item 写入 `subtaskSessionId` 之间，cascade 暂时找不到 child；
- Worker 重启不恢复 nested mapping，单独 Worker-level cancel parent 不能递归 child。

后续应先定义期望一致性等级（例如 DB 收敛优先还是执行线性化优先），再考虑 durable lineage event、lease/epoch、cancel fence、recovery reconciliation 或 enqueue 前二次 DB 检查。不能在 1B 以局部锁或 retry 猜测性修复。

### Subtask orphan session 清理与事务边界

`new/fork` session 在 start 主 transaction 前创建，后续失败/unique race 可能遗留 session。未来可评估补偿清理、pending reservation、事务重排或显式 orphan 标记，但每种方案都会影响并发、可恢复性、审计和用户可见 session，因此必须独立设计。

### Archive 文件与数据库原子性

Compaction 中 archive 追加、DB transaction、run-state 并非全局事务，rollback 是 best-effort。未来可评估 outbox、可重放文件操作、内容寻址、transactional staging 或 orphan scanner；不要在协议统一期间改变 archive 格式/存储或假设文件系统事务。

## 错误模型与响应验证

Worker `AgentApiClient` 非 2xx parser 当前无法保留结构化 `message/code`。后续可独立修复为明确的 error class/payload parsing，并决定：

- 哪些 API error code 是稳定、可供 Worker 分支的合同；
- 哪些冲突可 retry，retry 预算与取消语义为何；
- 如何避免记录敏感 payload；
- 是否逐步引入一致 error envelope。

这必须与 1B 的 raw-body 兼容基线分开。也应在成功响应 schema 稳定后评估删除 `AWB_INTERNAL_RPC_RESPONSE_VALIDATION=warn`；删除前必须证明 strict 在主力与恢复流程中持续稳定。

## Agent 模块与测试架构

`agent.routes.ts`、`agent.service.ts`、`agent.store.ts` 和 `AgentApiClient` 仍是高耦合热点。后续可以围绕已稳定的 run/context/subtask 域做文件拆分，但不得仅按文件大小机械切割；应先建立依赖方向、事务所有权、错误边界和测试 fixture 边界。

可以改善的测试治理包括：

- 将 shared contracts export/schema smoke test 常态化；
- 用表驱动方式覆盖 endpoint response validation，同时保留 high-value 业务集成测试；
- 为 recover/cancel race 建立确定性 fake runtime/clock，而不是用不稳定并发 sleep；
- 建立对日志中敏感字段的回归保护。

## 非建议项

以下不因 1B 而自动变为下一步：全局统一 body limit、全量 tool result 深 schema、所有 HTTP endpoint 版本化、全仓错误 envelope、所有 transport timeout/retry、数据库 schema 重建。它们只有在可量化问题、明确目标和独立设计出现后才应评估。
