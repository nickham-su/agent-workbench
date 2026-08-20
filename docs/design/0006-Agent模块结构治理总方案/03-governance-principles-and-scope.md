# 治理原则与范围边界

## 总体原则

### 按职责域治理，不按文件大小机械拆分

文件体量是维护成本信号，不是架构边界。后续任何阶段不得以“把大文件拆小”为独立完成目标。

职责域划分必须基于：

- 业务规则是否共享同一组状态与不变量；
- 是否需要同一事务、CAS、fence 或文件协调边界；
- 依赖的外部能力是否相近；
- 变更频率与测试证据是否可以独立；
- 是否有明确的输入、输出和错误语义。

允许一个职责域仍有较大文件，也允许多个小文件仍需合并治理。验收关注权威规则归属和依赖方向，而不是平均文件行数。

### 先冻结语义，再移动结构

每个阶段进入编码前必须记录当前行为基线，尤其是：

- public/UI contract；
- Worker internal contract；
- DB 状态转换与事务边界；
- runtime enqueue/cancel 顺序；
- cache 生命周期；
- archive/artifact 文件副作用；
- 错误码、冲突和 no-op 分支；
- 日志敏感信息边界。

如果阶段目标同时需要业务语义变化，必须把语义变化明确列为独立决策和验收项；不得以“重构”名义隐藏行为变化。

### 0005 作为强制不变基线

`docs/design/0005-Worker-API读侧与生命周期治理/` 已冻结语义必须默认保持：

- 三项 Worker 主链 read-side Shared contract；
- prompt cache 行为；
- late append/update fence；
- normal create 与 late ignored response 区分；
- 普通 head conflict `409`；
- DB 收敛优先与 `cancel wins`；
- recover enqueue 前最终 DB fence；
- durable subtask lineage；
- orphan suspect/cleanup 条件；
- archive pending sidecar 单文件自动 reconcile 边界。

若未来真实需求要求修改，必须单独立项，不能与纯结构迁移混批。

### 结构治理与测试治理同步推进

在职责域迁移前，允许先进行一次时间受限的 testkit 前置使能，只建立后续阶段共同需要的最小 fixture、fake runtime、清理和运行约束。该准备阶段不是独立的长期测试治理项目，不负责脱离生产结构重新组织全部测试。

前置使能完成后，测试治理必须随各职责域的生产结构治理同步推进。

每建立一个职责域边界，都必须同步回答：

- 该域的核心行为由哪一层测试证明；
- 原大测试文件中的用例迁移到哪里；
- 是否需要公共 fixture、fake runtime、fault seam；
- 保留哪些跨域/API↔Worker 端到端证据；
- 如何防止 helper 抽象掩盖真实事务或 transport 行为。

不接受“先把生产代码全部拆完，之后再整理测试”的长周期失配，也不接受 testkit 和测试文件重组长期脱离生产职责域独立推进。

### Route 分组服从入口语义

Route 文件和注册函数的分组必须优先表达入口语义，而不是单纯按 HTTP method、鉴权方式或文件行数切分：

- UI/public routes 优先按用户用例和核心职责域组织，例如 session/interaction、context query/control、status/SSE；
- Worker internal routes 优先按 Shared internal contract 与内部职责域组织，例如 read-side、context writeback、run lifecycle、subtask；
- Plugin / MCP / Git environment 等外围 internal 入口单独成组，只通过外围适配层或 facade 边缘连接；
- route 分组不得改变 method/path/schema/auth/status，也不得把跨域业务编排上移到 Route。

### 渐进迁移，保持兼容入口

首批治理可保留 `AgentService` 作为 facade，使 routes、本地 runtime 和既有测试继续使用稳定入口。facade 的职责应逐步收窄为：

- 向后兼容的 use-case 聚合入口；
- 明确委派到职责域组件；
- 不承载新的跨域业务规则；
- 不复制被委派组件的权威逻辑。

facade 不是永久大类合理化工具。每个阶段必须记录其仍保留的方法和退出/保留理由。

### 事务与 fence 优先于“分层纯洁性”

如果某条规则必须在同一 DB 事务中完成，则应保留为单一持久化能力，即使它跨越简单 CRUD 概念。例如：

- append + run fence + head CAS；
- update item + run/session 归属与终态约束；
- cancel cascade DB 收敛；
- summary append + archive 标记；
- orphan 删除前二次确认。

不得为了形式上的 repository/service 分层，把原子操作拆成 service 中的多次独立读写。

### 依赖显式、能力最小

职责域组件不应默认接收完整 `AppContext` 或完整 `AgentService`。阶段性迁移应逐步改为显式依赖：

- 持久化能力；
- clock / id generator；
- runtime port；
- archive/artifact filesystem capability；
- workspace/settings/plugin read capability；
- logger；
- 受限测试 hook。

过渡期允许保留旧构造方式，但不得让新组件继续复制“大上下文对象 + 任意访问”的模式。

### 权威实现单一

同一业务规则只能有一个权威实现。迁移期间 facade 可以转发，但不得同时维护新旧两套 fence、状态判断、prompt 组装或 archive reconcile 逻辑。

若需要短期双路径，阶段方案必须定义：

- 权威路径；
- 兼容路径只做什么；
- 一致性测试；
- 删除条件和最长期限。

### 保持可回滚

治理阶段应尽量满足：

- 数据库 schema 不变；
- HTTP/IPC contract 不变；
- 文件格式不变；
- facade 保留时调用面可快速回退；
- 一个阶段可独立还原而不要求整体蓝图完成。

如某阶段必须进行不可兼容数据或协议迁移，应从结构治理中拆出独立设计。

## 纳入范围

### API Agent 职责域边界

本蓝图纳入：

- session / interaction；
- read-side / prompt；
- context writeback；
- run lifecycle / cancel / recovery；
- subtask / lineage / orphan；
- compaction / archive；
- UI context query / artifact；
- route 分组；
- module/startup 装配；
- Store 持久化能力边界。

### 测试结构

纳入：

- Agent 专属 testkit；
- fixture builder；
- fake runtime / controlled worker seam；
- archive 等受控 fault seam；
- 大测试文件按领域迁移；
- API、service、store、Worker 集成测试的职责分层；
- cwd、临时目录、DB 清理等运行约束。

上述测试结构的前置部分只负责最小使能；测试用例和 fault seam 的领域化迁移仍随对应生产职责域阶段完成。

### 外围 internal 适配边界

Plugin / MCP / Git environment 等外围 internal 能力纳入“边界约束与入口分组”的观察范围，但不纳入核心职责域的默认迁移范围。当前不得扩大其对核心应用组件的耦合，默认暂留外围适配层或 facade 边缘。

若未来需要改变其协议、生命周期、进程协作或长期模块归属，必须单独立项；不得顺手混入 read-side、writeback、run lifecycle、subtask 或 archive 等核心阶段。

### Shared contract 作为稳定边界

纳入对现有 Shared internal contract 的依赖治理和准入规则，但不以扩大接口覆盖面为目标。

### Worker 后续结构评估

纳入 Worker 的问题地图、准入条件和高层方向，但 API 首轮治理不深拆 `runner.ts` 主控制流或 `builtin.ts` 全工具分派。

## 当前优先范围

建议当前优先顺序：

- API read-side / prompt；
- context writeback；
- run lifecycle / recovery / cancel；
- subtask；
- compaction / archive；
- session/query/artifact 与 routes/module 收尾；
- 在上述边界稳定后，再评估 Worker 内部结构。

这只是高层顺序。后续阶段方案可以根据依赖和测试基础调整，但必须说明原因。

## 明确后置

### Archive read-side contract

`archive/search`、`archive/read` 的 Shared 协议统一继续后置，不作为当前优先项。

原因：

- 属于工具读取而非 Worker 主 prompt 链；
- 调用面窄且当前稳定；
- offset、lineCount、maxChars、文件缺失和内容敏感性有独立语义；
- 对当前结构维护热点的收益低于 API 职责域治理。

只有在调用面扩大、协议漂移或真实维护成本出现后，才单独设计。

### Plugin / MCP / Git environment 深度治理

核心治理期间只允许保持现有行为、收窄不必要依赖以及将外围 routes/adapter 明确分组，不进行协议扩张、生命周期重写或通用化抽象。

任何深度治理必须有独立问题证据、范围、合同和测试方案，不能作为 Agent 核心文件拆分的附带工作。

### Worker 深拆

当前不优先深拆：

- `apps/agent-worker/src/runtime/runner.ts` 的模型/流式/取消/工具主时序；
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts` 的完整执行体系。

后续可优先做不改变控制流的结构提取，但必须有独立设计和时序回归。

### Transport/process 通用抽象

Worker 和 Plugin Host 的 manager/client 虽有表面重复，但其生命周期、启动依赖、故障和 shutdown 语义尚未证明等价。当前只允许调研，不建立通用基类或统一 transport 框架。

### 重型线性化机制

不主动引入：

- generation / epoch；
- lease / heartbeat；
- cancel fence token；
- durable event；
- outbox；
- 完整 nested runtime recovery。

进入条件必须是出现可复现的 runtime 继续执行导致真实数据、资源或用户体验问题，且现有 DB fence 无法接受。

## 非目标

本总体蓝图不以以下事项为目标：

- 新增 Agent 产品能力；
- 修改 UI 交互或接口表现；
- 重写 Agent 状态机；
- 全量统一所有 API/Worker 协议；
- shared contracts 独立 workspace；
- 全仓错误 envelope；
- 全仓 retry/timeout；
- 数据库 schema 重建；
- archive 格式更换；
- Plugin Host 体系重写；
- 通过删除测试或扩大 `any` 降低迁移阻力；
- 以目录层级数量、类数量或文件行数作为治理 KPI。

## 阶段变更约束

后续阶段方案必须把改动分类：

| 类别 | 默认规则 |
|---|---|
| 纯结构移动 | 允许，但需证明无行为变化 |
| 内部类型/port 收窄 | 鼓励，需保持调用兼容或原子迁移 |
| Store 原子 helper 迁移 | 允许，事务与 fence 必须保持 |
| Route 文件分组 | 按 UI 用例、Worker internal contract、外围入口三类主导规则组织；method/path/schema/auth/status 不变 |
| 测试迁移 | 允许，不得降低关键回归证据 |
| internal contract 修改 | 默认排除，若需要必须独立冻结 |
| 数据 schema/文件格式修改 | 默认排除 |
| 生命周期语义修改 | 默认排除，必须另立设计 |

## 暂停条件

任何阶段出现以下情况应暂停编码并更新设计：

- 无法说明某条关键规则的唯一权威归属；
- 拆分要求弱化现有事务或 fence；
- 新组件必须任意访问完整 `AppContext` 才能工作，且无法解释；
- 为迁移生产代码需要删除关键集成测试；
- 需要同时修改 API 和 Worker 高风险主控制流才能完成；
- 发现 0005 行为与当前代码已不一致；
- 阶段范围扩展到数据库、协议或文件格式重构；
- facade 和新组件产生双实现且没有明确删除条件。
