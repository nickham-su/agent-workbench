# Agent 模块结构治理总方案

> 状态：总体治理蓝图初稿，待评审。
> 定位：面向未来一段时间的 Agent 模块结构治理上位设计，不是单轮实施方案。
> 适用方式：后续每个阶段性治理方案必须以本目录为依据，进一步冻结该阶段的范围、代码改动、测试、审查、回滚与验收细节。

## 快速结论

当前 Agent 主链功能与关键生命周期语义已经形成较完整的实现，但 API 侧职责持续聚合于少数大文件，测试也集中为跨域综合回归集。后续治理应围绕“让稳定业务边界在代码结构中可见”展开，而不是围绕文件行数做机械拆分。

总体方向：

```text
先冻结现有行为与依赖证据
  → 完成最小 testkit 前置使能
  → 建立 API Agent 职责域边界
  → 保留兼容 facade，渐进迁移调用面
  → 每个职责域同步迁移生产结构、持久化边界与测试
  → 在 API 边界稳定后评估 Worker 内部结构治理
  → 仅在真实问题触发时评估更重基础设施
```

优先治理对象：

- `apps/api/src/modules/agent/agent.service.ts` 的跨域业务编排；
- `apps/api/src/modules/agent/agent.store.ts` 的多持久化子域聚合；
- `apps/api/src/modules/agent/agent.routes.ts` 的多类入口聚合；
- `apps/api/src/modules/agent/agent.integration.test.ts` 等大型跨域测试与重复 fixture；
- `AppContext.agentTestFaults` 等测试 seam 的归属与扩张边界。

当前不优先落地：

- `archive/search`、`archive/read` 的 Shared 协议统一；
- `apps/agent-worker/src/runtime/runner.ts` 主控制流深拆；
- Worker / Plugin Host transport 与 process manager 通用抽象；
- generation、epoch、lease、heartbeat、durable event、outbox 等重型线性化机制；
- shared contracts 独立 workspace、全局错误 envelope、数据库结构重建。

## 文档层级

本目录只定义：

- 中期治理目标；
- 现状问题地图；
- 职责域与依赖方向；
- 治理原则和范围边界；
- 高层阶段路线；
- 测试、验证、风险与决策基线。

本目录不直接定义：

- 某一批具体修改哪些函数或文件；
- 某一批提交如何划分；
- 某个目标职责域的最终类名和文件名；
- 每阶段的完整施工步骤、精确回滚命令或验收用例清单。

这些内容必须在后续阶段性设计中补充。总体蓝图和阶段性方案的关系如下：

```text
0006 总体治理蓝图
  ├─ 前置使能：基线与最小 testkit 起步
  ├─ 阶段方案：API read-side / prompt 结构治理
  ├─ 阶段方案：context writeback 结构治理
  ├─ 阶段方案：run lifecycle / recovery / cancel 结构治理
  ├─ 阶段方案：subtask / lineage / orphan 结构治理
  ├─ 阶段方案：compaction / archive 结构治理
  ├─ 收尾方案：session / query / routes / module
  │    └─ 每个职责域阶段同步推进对应测试治理
  └─ 后续评估：Worker 内部结构治理
```

阶段名称和边界允许根据届时代码现状调整，但不得绕开本蓝图的依赖原则和行为基线。

## 过渡期权威口径

“过渡期”从首个职责域结构治理阶段开始，到 Session / Routes / Module 收尾阶段完成为止。过渡期允许最终类名和目录继续演进，但以下边界默认成立：

- `AgentService` 继续作为兼容入口，负责转发和少量显式跨域用例编排，不再成为新增领域规则的落点；
- `sendMessage()` 的用户命令入口属于 Session / Interaction 责任面，run 创建、run-state、enqueue、cancel 与 recovery 规则属于 Run Lifecycle 责任面；前者通过明确能力调用后者，不得由 Route 拼装；
- `sendMessage()` 的具体事务接口与两个责任面的协作合同，最晚必须在 Run Lifecycle 阶段定稿；最终 facade/目录形态最晚在 Session / Routes / Module 收尾阶段定稿；
- Context Query 默认承担读取 context list/item/tail 与 UI artifact 的应用查询；Context Writeback 承担 Worker 写回以及 artifact 生成/写入时机；安全路径和文件 I/O 由共享的 artifact 能力承载，Query 不得反向依赖 Writeback；
- artifact 读写责任分界最晚在 Context Writeback 阶段定稿，Context Query 的最终模块和 route 归属最晚在 Session / Routes / Module 收尾阶段定稿；
- Plugin / MCP / Git environment 等外围 internal 能力暂留外围适配层或 facade 边缘，不得在核心职责域阶段扩大其耦合面；未来治理必须单独立项。

testkit 起步是时间受限的前置使能，不是与生产结构治理长期并行的独立工程。完成最小 fixture、fake runtime 和清理能力后，测试治理必须随各职责域阶段同步推进。

## 不变基线

`docs/design/0005-Worker-API读侧与生命周期治理/` 已完成并验收的语义是本轮及后续结构治理的强制基线，包括但不限于：

- Worker 主链 read-side 的 Shared contract 入口与三项接口范围；
- prompt static cache 的 key、TTL、Promise reuse、访问续期、终态清理和 static/dynamic 划分；
- late append/update fence 及 normal/ignored response 区分；
- 普通 head conflict 继续返回 `409`；
- DB 收敛优先、`cancel wins`、recover enqueue 前最终 DB 检查；
- `parentRunId + parentToolItemId` 是 durable lineage；
- orphan scanner 的严格 suspect 与自动删除边界；
- archive pending sidecar 只对单文件精确尺寸匹配自动 reconcile，多文件只 warning 并保留。

结构治理可以移动代码、缩小依赖、调整内部装配和拆分测试，但不得在同一治理批次中无授权改变上述语义。

## 阅读路径

| 文件 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、定位、治理目标、成功标准与文档使用方式 |
| [02-current-state-and-problems.md](./02-current-state-and-problems.md) | 当前职责、依赖、规模、测试与维护问题地图 |
| [03-governance-principles-and-scope.md](./03-governance-principles-and-scope.md) | 治理原则、纳入范围、边界、非目标与变更约束 |
| [04-target-architecture.md](./04-target-architecture.md) | 目标职责域、分层、依赖方向、facade 与 Store 边界 |
| [05-roadmap-and-staging.md](./05-roadmap-and-staging.md) | 中期高层路线、阶段准入和阶段性方案要求 |
| [06-testing-and-validation.md](./06-testing-and-validation.md) | 测试结构目标、回归基线、验证策略与证据要求 |
| [07-risks-non-goals-and-decisions.md](./07-risks-non-goals-and-decisions.md) | 关键决策、风险、非目标、触发条件和待确认项 |
| [08-code-map.md](./08-code-map.md) | 当前关键代码、职责热点、契约入口与后续调研索引 |

## 规范性约定

- “必须”表示后续阶段性设计、开发、测试和审查共同遵守的要求；“不得”表示禁止作为顺手修改混入；“建议”表示优先路径，但允许阶段方案基于新证据调整。
- 本目录描述的是职责域和依赖方向，不承诺最终目录、类名或文件数量。
- 文件行数只作为维护热点证据，不作为拆分依据或验收指标。
- 后续阶段方案若与本蓝图冲突，必须先说明新证据、影响和替代决策，并更新本蓝图；不得静默偏离。
- 代码地图中的规模和符号是初稿调研时证据，实施前必须重新核对。

## 初稿重点评审问题

- API Agent 的目标职责域划分是否符合未来业务演进方向；
- 上述过渡期权威口径和各项最晚定稿阶段是否合适；
- `AgentService` 作为过渡 facade 的退出条件是否足够清晰；
- Store 是按同样职责域拆分，还是优先建立更少、更稳定的持久化能力组；
- `agent.module.ts` 中 startup recovery 编排最终应归属 run lifecycle 还是独立 startup coordinator；
- 外围 internal 适配层的现有耦合是否还有遗漏。
