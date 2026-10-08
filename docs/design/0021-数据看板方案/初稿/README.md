# 数据看板方案

## 文档目的

本目录定义 Agent Workbench 数据看板的可实施设计。它同时是：

- 开发的功能、数据和接口合同；
- 代码审查的通过标准；
- 自动化测试、集成测试和人工验收的依据；
- 指标口径与迁移行为的权威参考。

本方案尚未实现。文中“必须”“不得”均为实施约束，不表示当前代码已经满足。

## 设计目标

- 向本地使用者展示工作情况，辅助复盘 Agent、工具、Git 与会话使用。
- 统计系统运行质量，辅助优化 Provider、模型、工具和 Worker 的可靠性。
- 支持回看数月历史；历史准确性不得依赖扫描全部业务表或读取过期聚合。
- 不上传遥测，不采集用户代码和交互正文，不把工作量指标包装为用户绩效评分。

## 本期范围

### 包含

- 模型：Provider/Model 维度的请求、状态、Token、缓存、请求时长和超时。
- Agent：顶层用户任务时长、Workspace 时长、Run 分布、主/子任务、当前 queued/running。
- 工具：仅按工具名的调用、状态和时长。
- 用户行为：按 Workspace 的用户消息和新建会话。
- Git：全局当前可达提交历史的提交和变更规模。
- Worker：异常退出与自动重启尝试、成功、失败。
- 独立长期 Analytics 事实、UTC 十分钟聚合、准确查询回退、Dashboard API 与 Workbench 内看板页。

### 不包含

- 模型或工具按 Workspace 筛选、分组或归因。
- 并行时间杠杆率、Worker 槽位利用率、终端使用时长。
- Agent 对 Git 变更的归因、当前未提交变更统计、用户绩效评分。
- 账户体系、多租户、跨用户对比、外部遥测。
- Prompt、回复正文、Reasoning、工具参数/结果、终端内容、Git Diff、Commit Message、文件路径、凭证的采集或展示。
- 泛化事件平台、时序数据库、消息队列或 OpenTelemetry 集群。

## 已裁决的关键决策

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| 长期数据源 | 独立 Analytics 原始事实为权威 | `AGENT_DOMAIN_TABLES` 可被破坏性重建，不能承载数月统计历史 |
| 聚合 | UTC 十分钟桶仅为缓存 | 可删除重建；查询准确性不能依赖过期、缺失、Dirty 或开放桶 |
| Dirty | 聚合事实变更与适用 Dirty 标记可靠关联；Execution 不建 Dirty | `execution` 仅原始状态/coverage；顶层 user 时长变化统一标 `agent_duration`，避免无投影的伪 Dirty |
| Agent 时长 | 仅 `run_kind='user' AND parent_run_id IS NULL` 的可靠 Execution | 父任务等待子任务时已经覆盖该时段，统计子任务会重复 |
| Run 实时状态 | 查询 Execution，不用 `agent_run.status` | 现有 Run 在真正入队/开始前已标记 `running` |
| 模型与工具维度 | 模型仅 Provider/Model；工具仅工具名 | 本期不支持它们的 Workspace 维度，避免暗示错误归因 |
| 模型交付 | Worker 私有 SQLite 两阶段 Delivery Outbox，API 主库 Fact 为权威 | 单写者 fence 后，原子预留 prepared、reserved finish、reservation 实体、Gap 槽位和 64 KiB；每 Attempt 占四容量单位，promotion/handoff Gap 互斥，已准入 Attempt 不因逻辑满额丢 finish |
| 工具时长 | 仅 `duration_completed_at-started_at` | rebuild/recovery 的状态收敛时间绝不伪装为真实工具时长 |
| Git 集合 | 领取 `next_generation` 的当前可达原子切换 | 支持未 push Commit；失败 generation 不复用，rebase/amend 后旧 SHA 不参与当前看板 |
| Coverage | 九域 Domain State；Git 历史 coverage 读 Repo current Scan | 各域回填能力不同；agent duration 引用 execution，Git State 仅 job freshness，coverage 不能在 Repo State 冗余 |
| Delivery Gap / Incident | Gap、永久交付 incident、未修复历史损失均为 model domain 全局健康诊断 | delivery 以认证 `delivery_event_id` 幂等；historical loss 只由未修复 `confirmed_missing` incident 查询；均不属于请求/聚合/范围筛选 |
| 页面壳 | `/dashboard` 复用 `WorkbenchPage/WorkbenchLayout` | 保持现有顶层导航、认证和布局一致，不引入孤立页面 |

## 阅读顺序

- [需求与产品合同](./01-需求与产品合同.md)：范围、页面与产品承诺。
- [指标口径](./02-指标口径.md)：指标的唯一计算定义、分母、状态、`null` 与 coverage。
- [数据与实体设计](./03-数据与实体设计.md)：事实、聚合、约束、索引、回填和留存。
- [采集与运行生命周期](./04-采集与运行生命周期.md)：事务、Execution handshake、模型、Worker 采集。
- [聚合与查询算法](./05-聚合与查询算法.md)：Dirty lease、可用桶、趋势、时区和准确回退。
- [Git 采集方案](./06-Git采集方案.md)：source 快照、generation、当前可达集合与覆盖。
- [API 与前端方案](./07-API与前端方案.md)：TypeBox、对外/内部接口、Workbench Dashboard tab。
- [边界、安全与恢复](./08-边界安全与恢复.md)：故障、重建、隐私、并发与受控枚举。
- [验收与测试](./09-验收与测试.md)：验收矩阵和必测边界。
- [实施计划](./10-实施计划.md)：按依赖关系分段实现、审查门槛和自检。

## 术语

| 术语 | 定义 |
| --- | --- |
| 业务 Run | `agent_run` 中由用户任务、手动压缩或子任务产生的持久化 Run；一个 Run 只计一次 Run 数。 |
| Execution | 一个业务 Run 的一次实际运行尝试；崩溃恢复后同一 Run 可以有多个 Execution。 |
| 模型 Attempt | 一次进入 `streamTextFn` / SDK Provider 调用边界的调用；`started_at` 不承诺网络送达。仅成功晋级 `provider_invoked` 后才形成 Fact；同步 throw 也属于 Attempt。 |
| Fact | 长期保留、可重建聚合的最小 Analytics 数据，不含敏感正文。 |
| Delivery Outbox | Worker 私有 SQLite 的短期可靠交付日志；必须先取得单写者 owner/fence。每个 Attempt 先有 prepared begin、reserved finish、reservation 实体和唯一 Gap/字节 reservation；只有 provider_invoked begin/pending finish 可交付；不属于主库 Fact，不可用于 Dashboard 或聚合。 |
| Delivery Gap | 模型交付边界不确定的内部安全诊断；不计请求、不含敏感内容。未解析数是全局健康诊断并使模型 coverage 降级，可信 Fact 可按状态机解析。 |
| Delivery Incident | API 对永久 `409/422` 交付失败记录的无敏感主库诊断；以 `delivery_event_id` 幂等，必须先返回 incidentId 才允许本地 quarantine。`confirmed_missing` 仅在可信 Fact 重建绑定该 incident 后才修复 historical loss，不能宣称历史完整。 |
| Dirty Bucket | 已知其聚合投影可能失效、必须重算的领域桶与维度；`execution` 不存在此类桶，Agent 时长只使用 `agent_duration`。 |
| 可用桶 | 已封闭、存在聚合行、没有 Dirty、未处于 rebuild 覆盖范围的桶。 |
| 顶层用户任务 | `run_kind='user' AND parent_run_id IS NULL` 的 Run；它是 Agent 总时长与主任务数唯一口径。 |
| 当前 generation | 某 Repo 指针明确指定的一次完整成功 Git scan；只有其 membership 参与 Git 看板。 |
| Domain State | `model|run|execution|agent_duration|tool|message|session|worker|git` 的采集/回填/作业状态权威；Git 历史 coverage 例外地只读 current Scan。 |

## 当前代码依据

实施前若相关模块继续重构，必须重新核对符号，不得机械依赖旧行号：

- Agent 域版本、破坏性重建和业务表：`apps/api/src/infra/db/schema.ts` 的 `AGENT_SCHEMA_VERSION`、`AGENT_DOMAIN_TABLES`、`clearAndDropAgentDomain()`。
- Run 类型：`packages/shared/src/contracts/agent.ts` 的 `AgentRunKindSchema`。
- handoff、终态与恢复：`apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`。
- Run 创建与父子 fence：`apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`。
- 本地回退队列：`apps/api/src/modules/agent/agent.runtime.ts` 的 `AgentRuntime`。
- Worker 队列、nested 子任务、模型 Attempt：`apps/agent-worker/src/runtime/runner.ts` 的 `startRun()`、`processNestedRunWithController()`、`runModelStep()`。
- Worker spawn/exit/restart/ready：`apps/api/src/modules/agent/agent.worker-manager.ts` 的 `AgentWorkerProcessManager`。
- 数据目录路径派生：`apps/api/src/infra/fs/paths.ts`；Worker Outbox 必须新增或复用同一体系的 `analyticsWorkerDeliveryOutboxPath(dataDir)`。
- Git Mirror、工作树和 Commit：`apps/api/src/infra/git/mirror.ts`、`apps/api/src/infra/git/clone.ts`、`apps/api/src/modules/git/git.service.ts`。
- 轻量定时任务模式：`apps/api/src/modules/git-env/git-env.janitor.ts` 的 `startGitEnvJanitor()`。
- Workbench 页面与路由：`apps/web/src/app/router/index.ts` 及 Workbench feature。
