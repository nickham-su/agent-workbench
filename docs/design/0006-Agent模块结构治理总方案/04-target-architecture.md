# 目标结构与依赖方向

## 目标不是固定目录模板

本文件定义目标职责域、依赖规则和演进约束，不冻结最终类名、文件名或目录深度。后续阶段性设计必须以真实调用链验证域边界，可以合并或细分，但需记录与本蓝图的差异。

文中 `RuntimeControl`、`ArchiveStorage`、`ArtifactStorage`、`WorkspaceAgentConfigReader`、各类 `* capability` / `* coordinator` 等名称只用于示意职责面和依赖方向，不是正式接口或类型命名承诺。阶段方案可以在不改变职责边界、权威规则和依赖方向的前提下调整术语并贴合项目既有风格。

## 目标分层

建议将 API Agent 模块逐步表达为以下层次：

```text
Transport / Route
  ↓
Application facade / Use-case entry
  ↓
Domain-oriented coordinators
  ↓
Persistence capabilities + external ports
  ↓
DB / filesystem / Worker / Plugin / workspace services
```

### Transport / Route

职责：

- HTTP method/path；
- request/response schema；
- auth/token；
- params/body/query 解析；
- HTTP status 与已冻结错误映射；
- 调用 use-case entry；
- SSE transport 管理。

不得承载：

- prompt 组装；
- DB 状态判断；
- late writeback fence；
- cancel cascade；
- archive rollback/reconcile；
- subtask reuse/lineage 决策。

Route 分组采用以下主导规则：

- UI/public routes 优先按用户用例和核心职责域组织，例如 session/interaction、context query/control、status/SSE；
- Worker internal routes 优先按 Shared internal contract 和内部职责域组织，例如 internal read-side、context writeback、run lifecycle、subtask；
- Plugin / MCP / Git environment 等外围 internal 入口必须单独成组，通过外围适配层或 facade 边缘连接；
- Shared endpoint registry 继续作为核心 Worker internal route 的合同来源。

具体文件数量和名称由阶段方案决定，但不得只按 method、鉴权方式或行数机械分组。

### Application facade / Use-case entry

本蓝图中的“过渡期”从首个职责域结构治理阶段开始，到 Session / Routes / Module 收尾阶段完成为止。

过渡期由 `AgentService` 承担兼容 facade：

- 保持 routes、本地 runtime 和既有调用方稳定；
- 将方法委派到职责域组件；
- 做少量跨域 use-case sequencing；
- 不再新增底层 helper 或新的领域规则。

长期可选择：

- 保留较薄 `AgentService` 作为公开应用入口；或
- routes 直接依赖职责域 use-case 集合。

该选择不在总体蓝图中冻结，需根据迁移后调用面和测试成本决定。

### Domain-oriented coordinators

建议目标职责域如下。

## Session 与交互域

### 核心职责

- session list/get/create；
- primary/subtask kind 基本约束；
- fork/revert；
- send message 的用户交互入口；
- client request dedup；
- session head 与用户操作的应用级编排。

### 关键依赖

- session/context/run persistence capabilities；
- run lifecycle application capability；
- workspace read capability；
- clock/id generator。

### 过渡期权威边界

总方案默认：

- `sendMessage()` 继续由 `AgentService` facade 暴露兼容入口；
- Session / Interaction 责任面拥有用户命令语义，包括 session/workspace 前置校验、client request dedup 和跨域用例入口；
- Run Lifecycle 责任面拥有 run 创建、run-state、enqueue、enqueue failure、cancel 和 recovery 规则；
- Session / Interaction 通过一个显式 lifecycle 能力调用 Run Lifecycle，不得复制 run 状态规则，也不得由 Route 拆成多次调用；
- 当前涉及 user item、run record、run-state 的事务原子性必须保持，不能为了分域改成非原子调用。

Run Lifecycle 阶段必须定稿 `sendMessage()` 的跨域协作接口、事务边界和错误归属。Session / Routes / Module 收尾阶段必须定稿其最终 facade、模块和 route 位置。最终类名和文件名在此之前不冻结。

## Read-side 与 Prompt 域

### 核心职责

- execution profile；
- prompt context；
- messages context；
- prompt messages 构建；
- system prompt、skills、tool projection；
- run prompt static cache 生命周期；
- compaction snippet 的只读投影。

### 关键依赖

- context/run/session 查询 capability；
- workspace/settings/plugin read capability；
- prompt templates；
- skills/instruction file reader；
- clock/cache；
- Shared read-side contract 类型。

### 不变量

- 0005 prompt cache 行为保持；
- stable envelope/dynamic payload 边界保持；
- 不把 archive tool read-side 协议顺手并入；
- read-side 不执行 run 状态写入。

### 建议内部结构

可进一步区分：

- profile resolver；
- static prompt assembler/cache；
- transcript/message projector；
- skill/tool projection collaborators。

这些可作为同一职责域内组件，不要求全部成为公开 service。

## Context Writeback 域

### 核心职责

- Worker context create/update；
- item/run/session/workspace 归属验证；
- late append/update fence；
- head CAS；
- normal/ignored response；
- apply_patch / write artifact 相关副作用顺序；
- context item 状态单向收敛。

### 关键依赖

- 原子 context writeback persistence capability；
- artifact writer/reader；
- logger；
- clock；
- Shared context contract。

### 不变量

- terminal/cancelled/active run 已切换后的迟到写回不得污染 DB；
- run 不存在仍为 `404`，不得误判 ignored；
- 普通 head conflict 仍为 `409`；
- update 不得跨 run/session/workspace；
- artifact 既有行为和顺序必须保留。

### 持久化边界

该域必须依赖类似“append with run fence”“update with run fence”的原子能力，而不是获得多个普通 CRUD 后自行拼装竞态敏感流程。

## Run Lifecycle 域

### 核心职责

- run record / run-state 的创建和终态收敛；
- enqueue failure；
- cancel root/child cascade；
- runtime cancel best-effort；
- startup recovery candidate 与 enqueue 前最终 DB fence；
- complete/update state writeback；
- terminal 时相关 cache 清理触发。

### 关键依赖

- run/session/context lifecycle persistence capability；
- runtime control port；
- durable subtask child query；
- read-side cache invalidation capability；
- clock/logger。

### 不变量

- DB 收敛优先；
- `cancel wins`；
- runtime cancel 失败不回滚 DB；
- recovery enqueue 失败不阻塞其他 candidate 或启动；
- 已发出的 enqueue 不承诺强停，由 DB/writeback fence 收敛。

### Startup coordinator

`agent.module.ts` 中的 startup recovery、orphan scan、archive reconcile 建议逐步迁移到显式 startup coordinator/use-case，而 module 只做：

- 构造依赖；
- 注册 routes；
- 调用启动期任务；
- 管理进程生命周期。

startup coordinator 可调用多个职责域，但不得成为新的全能 service。

## Subtask 域

### 核心职责

- prefork plan；
- start / reuse / unique race；
- parent tool 与 child run durable lineage；
- result/status；
- cancel cascade 所需 child 查询能力；
- 局部空壳补偿；
- orphan suspect scan 与保守删除。

### 关键依赖

- session/run/context lineage persistence capability；
- session fork/create capability；
- run lifecycle/start capability；
- clock/logger。

### 不变量

- `parentRunId + parentToolItemId` 是权威 lineage；
- `subtaskSessionId` 仅展示或快速定位；
- existing reuse session 不进入本次新建补偿删除路径；
- orphan scanner 只处理 0005 冻结的 suspect 范围；
- 单个 orphan 失败不阻塞启动。

## Compaction 与 Archive 域

### 核心职责

- manual compact；
- Worker compact；
- clear 相关 archive 编排；
- archive append snapshot；
- rollback best-effort；
- pending sidecar 写入与 reconcile；
- compaction snippet 写入/读取边界；
- archive search/read 的现有工具实现归属。

### 关键依赖

- context/session compact persistence capability；
- archive filesystem capability；
- pending sidecar store；
- summary/model input collaborator；
- clock/logger；
- 受限 fault injection hook。

### 不变量

- 文件与 DB 操作顺序必须由阶段方案冻结；
- sidecar 仅在 rollback skipped 时产生；
- 单文件且尺寸精确匹配才自动 truncate；
- 多文件 sidecar 不自动 reconcile；
- 不改变 archive 文件格式。

### 协议边界

`archive/search` / `archive/read` 可以作为该域内部现有能力继续存在，但其 Shared contract 统一不属于当前优先目标。

## Context Query 与 Artifact 责任面

### 过渡期权威边界

总方案默认：

- Context Query 负责 UI context list/item/tail 和 apply patch/write artifact 的应用读取用例；
- Context Writeback 负责 Worker context mutation 以及 artifact 生成与写入时机；
- 安全路径校验和 artifact 文件 I/O 由两者共同依赖的 artifact capability/adapter 承载；
- Context Query 不得反向依赖 Context Writeback，Route 不得直接访问 artifact 文件系统；
- read-only query 不得混入 run/context 状态变更。

Context Writeback 阶段必须定稿 artifact 写入、读取和安全路径能力的接口边界。Session / Routes / Module 收尾阶段必须定稿 Context Query 的最终模块、facade 和 public route 归属。最终是独立目录还是 Session read model 的内部子模块，可以留到该收尾阶段决定。

## 外围 Internal 适配层

Plugin / MCP / Git environment 等入口当前默认位于外围 internal route group，并由外围适配层或 `AgentService` facade 边缘转发到既有能力。核心职责域阶段：

- 不把这些入口吸收到 Session、Read-side、Writeback、Run Lifecycle、Subtask 或 Archive coordinator；
- 不扩大外围能力对核心职责域对象的依赖；
- 只允许为 route 分组、薄转发或去除不必要耦合做最小结构调整；
- 不修改其协议、进程生命周期或 transport 抽象。

未来若要确定独立模块、Shared contract 或进程治理，必须单独立项。Read-side 中为 prompt 组装读取 plugin 配置/工具快照的 collaborator，不等同于这些外围 operational internal endpoints，二者不得因名称相近而合并。

## Persistence capabilities

### 目标

把 `agent.store.ts` 从全域函数集合逐步演进为按一致性边界可发现的持久化能力，同时避免过度 repository 化。

候选能力组：

- session persistence；
- context query persistence；
- context writeback persistence；
- run lifecycle persistence；
- subtask lineage persistence；
- compaction/archive persistence。

### 规则

- 同一 DB transaction 中必须完成的操作留在同一能力；
- 查询 helper 可被多个域复用，但应避免跨域任意 import；
- 命名应表达业务约束，例如 `appendWithRunFence`，不得退化为泛化 `save()`；
- persistence 层可以抛出明确 conflict/not-found 结果，应用层负责映射业务/HTTP 语义；
- 不强制为每张表建立 repository；
- 初期可先拆文件和导出边界，是否引入对象实例由阶段方案决定。

## External ports 与 collaborators

建议逐步建立最小能力面：

```text
RuntimeControl
  enqueueRun
  cancelSession

ArchiveStorage
  append
  rollbackBestEffort
  reconcilePending
  search/read（现状能力，非协议治理）

ArtifactStorage
  write/read apply-patch artifact
  write/read file artifact

WorkspaceAgentConfigReader
  workspace/repo
  agent/settings/plugin/tool/skill prompt inputs

Clock / IdGenerator / Logger
```

以上名称均是职责面示意。阶段方案可以改用项目既有术语或函数式 capability，只要不扩大依赖、改变权威规则或弱化测试替换边界。

不要求一次性把所有函数接口化。只有在职责域迁移、测试替身或依赖方向确有收益时提取，避免为抽象而抽象。

## Shared contract 的目标位置

Shared internal contracts 继续作为 API Route 与 Worker Client 的共同稳定边界：

```text
packages/shared/src/internal-contracts/agent-api.ts
  ├─ agent-api-run.ts
  ├─ agent-api-context.ts
  ├─ agent-api-subtask.ts
  └─ agent-api-read.ts
```

治理要求：

- 保持唯一公开入口；
- 核心 internal route 继续复用 method/path/schema/type；
- 目标职责域可依赖合同类型，但领域内部不得完全由 transport DTO 驱动；
- 新增 Shared endpoint 需满足主链、复用面或漂移风险等准入条件；
- 不为追求整齐而迁移所有外围 endpoint。

## 依赖方向规则

### 允许

```text
Route → facade/use-case
Facade → domain coordinators
Domain coordinator → persistence capability / external port
Startup coordinator → 多个显式 startup use-case
Local runtime → 最小 read/writeback/lifecycle application ports
Worker client → Shared internal contracts
Peripheral internal route → peripheral adapter / facade edge
```

### 默认禁止

```text
Store → Service/Route
Domain coordinator → Route/Fastify request
Read-side → Writeback coordinator
Worker internal implementation → API service concrete class
新职责域 → 完整 AppContext 任意访问
Route → 多个 Store 函数自行拼业务事务
Peripheral internal adapter → 核心职责域具体实现或内部状态
测试 fixture → 依赖大量 private-like module state
```

### 跨域协调

跨域用例不可避免，例如 send message、cancel cascade、subtask start、compact。协调必须位于明确的 application use-case/coordinator，且每条底层不变量仍由对应持久化或领域能力保证。

不得通过双向依赖解决协调问题。若两个域形成循环，优先：

- 提取更小的能力接口；
- 将协调上移到 application use-case；
- 重新评估职责是否实际上属于同一域。

## 目标装配关系

```text
AgentModule / composition root
  ├─ construct persistence capabilities
  ├─ construct external adapters
  ├─ construct domain coordinators
  ├─ construct Agent facade
  ├─ register grouped routes
  ├─ start worker/plugin processes
  └─ invoke startup coordinator
```

Module 不应读取大量 store 函数并自行实现业务规则。启动期 DB fence 应由 run lifecycle/recovery use-case 提供，module 只触发。

## 过渡策略

### Facade-first

初期：

```text
Route → AgentService facade → 新职责域组件
```

中期：

- 新逻辑只进入职责域组件；
- facade 方法保持薄转发；
- tests 逐步按职责域调用公开 use-case，同时保留 route 级主链测试。

后期选择：

- 保留薄 facade；或
- routes 按职责域注入 use-case 集合。

### Store-first 约束

生产 service 拆分前，必须确认对应原子 Store 能力是否可被安全移动或封装。若 persistence 边界不清，优先先定义能力，不急于移动上层方法。

### Tests-with-code

每迁移一个职责域，相关测试和 fixture 同步迁移，不允许生产代码已经分域而测试继续永久依赖旧大 service 内部实现。
