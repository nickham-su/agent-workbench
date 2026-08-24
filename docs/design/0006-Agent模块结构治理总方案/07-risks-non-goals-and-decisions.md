# 风险、非目标与关键决策

## 决策总表

| 决策 | 当前结论 | 理由 |
|---|---|---|
| 文档层级 | 总体治理蓝图，不是单轮实施方案 | 保持中期方向稳定，具体施工独立冻结 |
| 拆分依据 | 按职责域、状态不变量和依赖方向 | 文件行数不能代表业务边界 |
| 行为基线 | 0005 已冻结语义默认不变 | 防止结构治理偷带 lifecycle/contract 变化 |
| 迁移策略 | 渐进迁移，初期保留 `AgentService` facade | 降低 routes/runtime/tests 同时改造风险 |
| `sendMessage()` 过渡口径 | Session / Interaction 拥有用户命令和跨域入口；Run Lifecycle 拥有 run 状态与 runtime 规则 | 保持用户用例与生命周期不变量分离，同时不破坏事务 |
| Context Query / Artifact | Query 负责应用读取；Writeback 负责生成/写入时机；共享 artifact 能力负责安全文件 I/O | 固定 read/write 方向，最终目录可后定 |
| Store 方向 | 按原子一致性能力拆分，不按表机械 repository 化 | 保留事务、fence、CAS 和二次确认 |
| 测试治理 | 最小 testkit 前置使能，之后与生产职责域同步推进 | 测试是迁移护栏，不是长期独立重构主线 |
| 首要治理对象 | API Agent service/store/routes/module/tests | 当前收益最高、边界已有稳定基础 |
| Shared contract | 继续作为稳定边界，不追求全量统一 | 核心主链已收敛，外围接口收益有限 |
| 外围 internal 能力 | Plugin / MCP / Git environment 暂留外围适配层或 facade 边缘 | 核心阶段不扩大耦合，深度治理单独立项 |
| Route 分组 | UI 按用户用例；Worker internal 按 contract/职责域；外围入口单独成组 | 入口结构表达合同和业务边界 |
| Archive tool read-side | `archive/search` / `archive/read` 协议统一后置 | 调用面窄、语义独立、非当前热点 |
| Worker 深拆 | API 边界稳定后单独评估 | runner/builtin 时序和工具行为风险高 |
| Transport 抽象 | 当前只调研，不落地通用层 | Worker/Plugin Host 仅表面重复，语义未证明等价 |
| 重型线性化 | 无真实问题触发时不引入 | 复杂度和跨层成本高于当前收益 |
| 最终文件结构 | 本蓝图不冻结 | 避免初稿过早承诺实现细节 |

## 主要风险

## 机械拆分风险

### 表现

- 把一个大类拆成多个类，但都接收完整 `AppContext`；
- 组件之间互相调用或共享大量内部状态；
- 新增大量“Manager/Helper”却没有权威边界；
- 规则在 facade 和新组件重复。

### 控制

- 阶段设计先写职责、不变量和依赖；
- 审查依赖方向和跨域调用；
- 不以行数下降作为完成标准；
- 要求每条关键规则有唯一归属。

## 行为漂移风险

### 表现

- prompt cache 被无意改变；
- late ignored 与 conflict 混淆；
- cancel/runtime 顺序变化；
- lineage 查询改回 `subtaskSessionId`；
- archive sidecar 自动处理范围扩大。

### 控制

- 0005 作为阶段设计强制引用；
- 迁移前建立行为 characterization tests；
- 生产移动与测试迁移同批；
- 独立审查对照不变量，而非只看测试绿色。

## 事务边界弱化风险

### 表现

- Store 原子 helper 被拆成多次 service 调用；
- 先读后写引入新竞态；
- cancel cascade 或 orphan delete 不再二次确认；
- DB 与文件顺序被隐藏在通用 helper 中。

### 控制

- persistence capability 按原子业务操作命名；
- 使用真实 SQLite 竞态/边界测试；
- 阶段方案绘制 transaction boundary；
- 审查 SQL/事务与文件副作用顺序。

## Facade 永久膨胀风险

### 表现

`AgentService` 虽然开始委派，但所有新业务仍先写进 facade，最终形成新旧双层大类。

### 控制

- facade 不新增领域 helper；
- 新功能必须先确定职责域；
- 每阶段记录 facade 方法清单；
- API 收尾阶段决定保留薄 facade 或转为 use-case registry。

## 循环依赖风险

### 表现

- run lifecycle 依赖 subtask，subtask 又依赖完整 run lifecycle；
- read-side/cache invalidation 与 complete 相互引用；
- session interaction 与 run creation 双向调用。

### 控制

- 上移跨域协调；
- 提取最小能力接口；
- cache 通过 invalidation port；
- durable child query 作为 persistence capability；
- 禁止直接注入完整 peer service 形成互调。
- `sendMessage()` 按已冻结过渡口径由 Session / Interaction 调用显式 lifecycle 能力，不允许双方互相持有完整 service。

## 测试抽象失真风险

### 表现

- fake store 绕过真实 fence；
- testkit 自动创建过多状态；
- 大测试文件拆分后删除跨层证据；
- fault hook 变成生产逻辑开关。

### 控制

- persistence 测试使用真实 SQLite；
- testkit 默认值显式；
- 保留 route 和 API↔Worker 主链；
- fault hook 组件级、生产默认关闭；
- 迁移前后核对关键用例和断言。

## 长期迁移风险

### 表现

- 多个职责域只完成一半；
- facade、新旧 Store、测试双路径长期并存；
- 后续业务继续落入旧路径。

### 控制

- 每阶段必须独立完成一个可见边界；
- 阶段方案定义删除条件；
- 不同时开启过多未完成迁移；
- 更新代码地图和状态；
- 对过渡适配设立后续清理入口。

## 过度抽象风险

### 表现

- 为每个函数建立 interface/class；
- 引入通用 repository、event bus、service locator；
- Worker/Plugin Host 被迫使用同一生命周期框架。

### 控制

- 只有存在替换、测试或依赖方向收益时提取 port；
- 优先复用项目现有函数/类风格；
- transport 抽象需先证明稳定重复；
- 不把理论架构纯洁性置于可维护性之上。

## 性能与启动风险

结构迁移可能无意增加：

- DB 重复查询；
- prompt/settings/plugin 重复读取；
- startup scan 重复；
- 文件 stat/read 次数；
- cache 失效频率。

阶段方案需要对热点调用链做前后比较。总体治理不要求性能优化，但不得造成明显退化。

## 非目标

当前总体治理明确不承诺：

- Agent 新产品能力；
- UI redesign；
- 状态机全面形式化；
- 完整 nested runtime recovery；
- runtime 强制停止保证；
- archive 与 DB 全局强事务；
- 所有 orphan 自动修复；
- 所有 internal endpoint 共享协议；
- 所有 dynamic payload 深 schema；
- Worker/Plugin Host 通用 RPC；
- 全局依赖注入框架；
- 全仓 repository 模式；
- 数据库 schema 重建；
- 文件格式迁移；
- 全量性能优化。

## 后置方向及触发条件

## `archive/search` / `archive/read` Shared contract

触发条件之一：

- 调用方增加；
- API/Worker 字段发生真实漂移；
- 新增分页、体积或错误语义；
- 测试维护成本显著上升。

未触发时保持现状。

## Worker 主控制流治理

触发条件：

- API 侧职责域和 lifecycle 测试稳定；
- runner 改动频率/回归成本持续上升；
- 已完成时序图与依赖调研；
- 可以按“不改控制流”先提取清晰能力。

## Transport/process 通用抽象

触发条件：

- Worker 与 Plugin Host 的启动、连接、错误、重试、shutdown、测试 seam 经过专门对比；
- 重复是语义重复而非代码形似；
- 抽象不要求弱化各自故障模型。

## 重型执行线性化

触发条件：

- 出现可复现的 runtime 迟到执行造成真实数据、资源或用户体验问题；
- DB fence 不能提供可接受收敛；
- 已定义跨 API/Worker/DB 的代际或 lease 语义；
- 有故障恢复与迁移方案。

## Shared 独立 workspace

触发条件：

- internal contracts 规模、发布边界、构建依赖或多仓复用出现现实压力；
- 现有 `packages/shared` 子路径无法保持可维护边界。

当前规模不足以支持该改造。

## 已冻结过渡口径与后续定稿点

### `sendMessage()` 与 Session / Interaction

过渡期权威口径：

- `AgentService` 继续暴露兼容入口；
- Session / Interaction 拥有用户命令语义、session/workspace 前置校验、client request dedup 和跨域入口；
- Run Lifecycle 拥有 run 创建、run-state、enqueue、enqueue failure、cancel 和 recovery 规则；
- Session / Interaction 通过显式 lifecycle 能力完成协作，不得由 Route 拼装，也不得弱化现有事务原子性。

Run Lifecycle 阶段必须定稿具体协作接口、事务边界和错误归属。Session / Routes / Module 收尾阶段只保留最终 facade、目录和 route 位置的定稿，不再讨论核心责任分界。

### Context query/artifact 的归属

过渡期权威口径：

- Context Query 负责 context list/item/tail 与 UI artifact 的应用读取；
- Context Writeback 负责 Worker mutation 以及 artifact 生成/写入时机；
- 共享 artifact capability/adapter 负责安全路径与文件 I/O；
- Query 不得依赖 Writeback，Route 不得直接读取文件系统。

Context Writeback 阶段必须定稿 artifact 能力接口；Session / Routes / Module 收尾阶段必须定稿 Context Query 最终是独立模块还是 Session read model 子模块，以及其 facade/route 位置。

### Startup coordinator 的粒度

startup recovery、orphan scan、archive reconcile 属于不同职责域。候选：

- 一个 startup coordinator 调用多个 use-case；
- module 分别触发每个域 startup hook。

初稿倾向显式 startup coordinator，但要求其不包含领域规则。

### Store 拆分形态

候选：

- 保持函数式 API，按文件/导出域拆分；
- 引入能力对象；
- 混合方式：关键事务能力对象 + 查询函数。

初稿不强制对象化，优先保持项目风格和最小改动。

### Facade 的长期形态

候选：

- 保留薄 `AgentService`；
- routes 注入多个 use-case；
- 提供结构化 `AgentApplication` 能力集合。

应在核心域迁移后基于实际调用面决定，并在 Session / Routes / Module 收尾阶段定稿。无论选择哪种形式，过渡期已冻结的职责边界不得回退。

## 决策变更规则

后续若要改变本文件的关键决策，阶段方案必须说明：

- 新证据；
- 不改变会造成的现实问题；
- 替代方案；
- 对 0005、数据、协议、测试和回滚的影响；
- 是否需要先更新总体蓝图。

未经说明的实现偏离应在审查中视为问题，而不是默认接受。
