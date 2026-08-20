# 分阶段治理路线图

## 路线图定位

本文件只定义中期演进顺序、阶段目标和准入条件，不是具体施工单。阶段数量、名称、具体文件和提交批次必须在每个阶段启动前重新设计。

总体原则：

```text
先低风险、边界稳定的结构治理
  → 再高一致性、跨域编排治理
  → 再入口/装配收尾
  → 最后评估 Worker 时序敏感部分
```

testkit 起步是前置使能，不是长期独立治理主线；完成最小准备后，测试治理随每个职责域阶段同步推进。

## 路线总览

| 治理阶段 | 高层目标 | 主要收益 | 关键前提 |
|---|---|---|---|
| 前置使能：基线与 testkit 起步 | 冻结证据，建立最小公共 fixture/fake | 降低后续迁移成本，不形成独立长期测试工程 | 现有测试稳定、fixture 行为已确认 |
| Read-side / Prompt | 提取 profile、prompt、messages、cache 边界 | 风险较低，建立职责域模式 | 0005 read-side/cache 测试完整 |
| Context Writeback | 显式化 append/update fence 与 artifact 边界 | 隔离关键写回一致性 | Store 原子 helper 保持 |
| Run Lifecycle | 收敛 run-state、cancel、recovery、enqueue failure | 明确 DB/runtime 边界 | cancel/recovery 竞态测试稳定 |
| Subtask | 收敛 prefork/start/reuse/lineage/orphan | durable lineage 可发现 | run lifecycle 能力边界清晰 |
| Compaction / Archive | 收敛 DB+文件协调、sidecar 和故障 seam | 降低最复杂文件副作用耦合 | 归档故障测试与 seam 已准备 |
| Session/Routes/Module 收尾 | 整理 UI query、facade、route、startup 装配 | 完成 API 结构闭环 | 前述职责域已稳定 |
| Worker 结构评估 | 决定 runner/builtin 可安全治理范围 | 降低 Worker 认知成本 | API 和端到端测试护栏稳定 |

该顺序允许调整。例如，最小 archive fault seam 可能要在 compaction 阶段之前先提取；但不得把多个高风险阶段合并成一次性重写，也不得让测试重组脱离对应生产职责域长期推进。

## 过渡期决策收口

| 边界 | 过渡期默认口径 | 最晚定稿阶段 |
|---|---|---|
| `sendMessage()` | facade 保持兼容入口；Session / Interaction 拥有用户命令与跨域入口，Run Lifecycle 拥有 run 状态和 runtime 规则 | 跨域接口和事务边界在 Run Lifecycle 阶段；最终 facade/route 位置在 Session / Routes / Module 收尾阶段 |
| Context Query | 承担 context list/item/tail 与 UI artifact 应用读取，不依赖 Writeback | 最终模块/facade/route 归属在 Session / Routes / Module 收尾阶段 |
| Artifact | Writeback 决定生成/写入时机；Query 负责读取用例；共享 artifact capability 负责安全路径和文件 I/O | 读写与安全路径接口在 Context Writeback 阶段 |
| `AgentService` facade | 只做兼容转发和少量显式跨域协调，不新增领域规则 | Session / Routes / Module 收尾阶段 |
| Plugin / MCP / Git environment | 暂留外围适配层或 facade 边缘，核心阶段不扩大耦合 | 如需长期独立架构，另立专项；核心收尾只定 route 分组和薄转发位置 |

## 基线与测试基础设施起步

### 目标

- 记录现有关键测试命令和 cwd 约束；
- 建立 Agent 专属测试 fixture 最小核心；
- 统一临时 dataDir、DB、`AppContext`、workspace 的创建/清理；
- 提供受控 fake runtime；
- 保留真实 `createApp()` 与 API↔Worker 集成路径。

### 边界

这一阶段不得大范围重写生产代码，不追求一次性抽象全部测试 helper。只提取多个后续阶段共同需要且语义明确的基础能力，并在最小能力可用后结束前置使能。

后续 fixture、fake、fault seam 和测试文件迁移必须绑定到对应职责域阶段，不得以 testkit 完善为由形成长期独立路线。

### 退出条件

- 新 testkit 不隐藏关键 DB/HTTP 行为；
- 现有测试迁移后行为等价；
- fixture 可按职责域扩展；
- teardown、cwd、临时文件清理稳定。

## Read-side / Prompt 治理

### 目标

建立第一套职责域组件和 facade 委派模式，覆盖：

- execution profile；
- prompt context；
- messages context；
- prompt static cache；
- prompt/tool/skill projection collaborators。

### 选择它优先的原因

- 0005 已有 Shared contract 和 runtime response validation；
- 主要是读取和组装，事务风险低于 writeback/archive；
- 可验证新依赖注入、facade、测试分层是否合适；
- 不需要扩大 Shared contract 范围。

### 阶段方案必须冻结

- cache key/TTL/reuse/invalidation；
- static/dynamic prompt 划分；
- messages 顺序与截断基线；
- workspace/settings/plugin/skills 输入；
- 敏感字段日志边界；
- 本地 fallback runtime 的调用兼容。

## Context Writeback 治理

### 目标

建立 context writeback coordinator 和原子 persistence capability，覆盖：

- create/update；
- late fence；
- ownership 验证；
- head CAS；
- artifact 副作用；
- normal/ignored/conflict/not-found 语义。

### 实施约束

- Store fence 不得变为 service 先读后写；
- 不能与 run lifecycle 业务重设计混批；
- 必须保留 Shared context contract；
- 相关 contract tests 应迁移到明确领域文件。

### 退出条件

- writeback 权威规则不再散落；
- facade 只转发；
- 竞态和 artifact 回归有独立测试；
- 普通 conflict 与 late ignored 继续严格区分。

## Run Lifecycle 治理

### 目标

收敛：

- run record/run-state；
- enqueue failure；
- complete/update；
- cancel cascade；
- DB 收敛后的 runtime cancel；
- startup recovery；
- cache terminal invalidation。

### 重点决策

阶段方案必须定稿：

- `sendMessage()` 中 Session / Interaction 与 Run Lifecycle 的显式协作接口、事务边界和错误归属；
- startup recovery 是否由独立 recovery coordinator 表达；
- runtime port 类型从 service 解耦的迁移方式；
- cancel child query 与 subtask lineage capability 的依赖方向；
- module 只触发还是仍保留部分启动编排。

该阶段不得把 `sendMessage()` 的核心责任分界继续后移；只有最终 facade、目录和 route 位置可以留到收尾阶段。

### 退出条件

- `cancel wins` 规则有单一权威实现；
- recovery enqueue 最终 DB fence 不在 module 中重复；
- runtime best-effort 与 DB transaction 边界清楚；
- API-managed Worker 与本地 fallback 路径均通过回归。

## Subtask 治理

### 目标

收敛：

- prefork plan；
- start/reuse/unique race；
- parent/child durable lineage；
- result/status；
- local compensation；
- orphan scan。

### 前提

- run lifecycle 提供明确的创建/启动/取消能力；
- session persistence 与 lineage persistence 边界可用；
- existing reuse 的产品语义已通过测试冻结。

### 退出条件

- `parentRunId + parentToolItemId` 的权威查询集中；
- `subtaskSessionId` 不被误用为唯一 durable lineage；
- orphan scanner 与局部补偿不共享错误删除路径；
- 单 candidate 失败不影响启动。

## Compaction / Archive 治理

### 目标

将当前混合的 DB、文件、rollback、sidecar 和 fault seam 编排收敛为明确职责域。

### 重点决策

- manual compact、Worker compact、clear 是否由同一 coordinator 暴露不同 use-case；
- archive storage 和 sidecar storage 的能力边界；
- summary append 与 archive 标记的 DB 原子能力；
- `AgentTestFaults` 如何迁移为组件级受控 hook；
- startup 和 per-session reconcile 的调用入口。

### 实施约束

- 不改变 archive 格式；
- 不扩为全局事务或 staging/outbox；
- 不恢复多文件 sidecar 自动 truncate；
- 不顺手统一 `archive/search` / `archive/read` Shared contract；
- 不顺手吸收或重写 Plugin / MCP / Git environment 外围 internal 能力。

### 退出条件

- 文件副作用顺序可读、可测；
- fault seam 不再无约束扩张全局 context；
- single/multi-file reconcile 边界保持；
- archive 测试可独立定位。

## Session、Routes 与 Module 收尾

### 目标

在核心职责域稳定后处理：

- 定稿 Session / Interaction 的最终模块边界；
- 定稿 Context Query 的模块、facade 和 public route 归属；
- 确认 Artifact 遵守已冻结的读写与安全路径能力边界；
- `AgentService` facade 的最终保留范围；
- route 按 UI 用户用例、Worker internal contract/职责域、外围 internal 入口三类主导规则分组；
- startup coordinator 与 composition root；
- 清理跨域直接 Store import；
- 删除已无调用的过渡 helper。

### 为什么后置

如果先拆 routes 或 module，而领域 use-case 尚未建立，只会把同一大 service 调用分散到更多文件。入口结构应跟随稳定的应用边界，而不是先行制造目录。

### 退出条件

- module 主要负责装配和触发；
- routes 不包含业务编排；
- facade 是明确薄层或已有经评审的退出方案；
- `sendMessage()`、Context Query 和 Artifact 不再存在未决责任分界；
- Plugin / MCP / Git environment 位于明确外围 route/adapter 边界，未被核心阶段吸收；
- 新功能有清晰归属准则。

## Worker 结构治理评估

### 进入条件

只有以下条件基本满足时才建议启动：

- API lifecycle、writeback、read-side 职责边界稳定；
- API↔Worker 主链集成测试稳定；
- cancel、auto-compact、streaming、tool output 测试能独立运行；
- 有清晰的 Worker 时序图和最小能力面调研；
- API 侧没有同时进行高风险 lifecycle 迁移。

### 候选方向

- 提取 run finalization/writeback coordinator；
- 明确 auto-compaction 输入输出与状态转换；
- 收紧 `ToolExecutionContext`；
- 按工具域提取 builtin executor；
- 保持工具名、schema、调用顺序和模型循环不变。

### 不默认包含

- Runner 状态机重写；
- transport framework；
- 完整 nested recovery；
- 工具协议全量统一。

## 阶段性方案模板要求

每个后续阶段方案至少包含：

### 背景与目标

- 对应本蓝图哪个职责域；
- 当前真实问题和证据；
- 本阶段完成后获得什么结构能力。

### 基线与不变量

- 相关 0005 或既有合同；
- 状态、事务、cache、文件、错误语义；
- 当前测试证据。

### 精确范围

- 纳入文件、方法、调用链；
- 明确排除项；
- 是否涉及 Shared/API/Worker/UI。

### 目标设计

- 组件与依赖；
- facade/兼容入口；
- Store 原子能力；
- 测试结构；
- 迁移后的代码地图。

### 分批实施

具体阶段仍必须执行：

```text
实现
  → 测试
  → 独立审查
  → 修复
  → 独立复审
  → 经用户授权后处理 Git 阶段动作
  → 下一批
```

阶段方案需要把生产代码和测试迁移拆成可独立验证、可回滚的小批次。

### 完成与回滚

- 自动验证矩阵；
- 手工验收（如涉及 UI/运行时）；
- architecture checks；
- 回滚边界；
- 与本蓝图差异。

## 跨阶段约束

- 不同时深拆 API lifecycle 与 Worker runner 主时序；
- 不在结构阶段混入协议、数据、文件格式重构；
- 不允许 testkit 成为新的全局杂物层；
- 不允许 facade 永久吸收新业务逻辑；
- 不允许为拆分而复制权威规则；
- 每阶段结束需更新本目录的代码地图或状态说明，保持蓝图与现实一致。

## 总体完成定义

本蓝图不要求一次性全部完成。中期治理可认为达到主要目标，需要满足：

- API Agent 的核心职责域在代码中可发现；
- `AgentService` 不再是主要规则容器；
- `agent.store.ts` 不再继续无边界聚合；
- module/routes 的职责明显收窄；
- 测试按领域组织且存在稳定 testkit；
- 0005 语义和真实 API↔Worker 主链无回归；
- Worker 是否继续治理已有基于证据的独立决定。
