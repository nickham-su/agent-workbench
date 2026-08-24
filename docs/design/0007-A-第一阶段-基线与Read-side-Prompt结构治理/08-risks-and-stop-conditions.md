# 风险、停止条件与回退原则

## 主要风险

### 1A testkit 变成长期独立工程

**表现：** 持续增加万能 builder、领域 fault hook 和跨模块 mock，但没有对应生产职责域迁移。

**控制：**

- 1A 设为时间受限前置使能；
- 只提取 1B 和后续共同需要的最小交集；
- P2 复审后冻结 testkit 公共面；
- 后续扩展必须附属于具体职责域批次并记录理由。
- 当前领域私有 helper 不进入公共面；
- 触及公共导出、默认语义、生命周期、资源所有权、fake runtime 合同或生产 seam 时，必须回到 1A 重新审查。

### testkit 隐藏真实边界

**表现：** fake Store 绕过真实 SQL，helper 自动创建业务状态，Route 测试变成直接调用 service，teardown 掩盖 socket/进程泄漏。

**控制：**

- persistence/query 证据使用真实 SQLite；
- Route 证据使用真实 Fastify app；
- API↔Worker 保留真实链路；
- builder 默认显式、可覆盖；
- fake runtime 只替代 runtime port，不替代 DB 或 prompt 内容；
- 清理失败可观测。

### Read-side 结构迁移造成模型输入漂移

**表现：** prompt 顺序、reasoning 过滤、locale、tools/pendingTools、skill roots、compaction snippet、dynamic content 或截断策略发生变化。

**控制：**

- P0 建立 characterization evidence；
- profile/messages 先后分批迁移；
- prompt/cache 单独批次；
- 比较 response shape、关键字段、顺序和 cache 调用；
- 保留真实 API-managed Worker 和 Runner regression。

### cache 语义漂移

**表现：** key、TTL、Promise reuse、访问续期、terminal clear 或 static/dynamic 划分发生变化。

**控制：**

- 迁移前记录真实调用点；
- cache 由单一组件维护；
- Run Lifecycle 只通过窄 invalidation 能力触发清理；
- 不在 1B 改 cache 策略；
- 任何必须改变 cache 语义的需求暂停并另立设计。

### Facade 与新组件双实现

**表现：** `AgentService` 保留旧 prompt/cache 逻辑，新组件又实现一份；测试分别覆盖两条路径。

**控制：**

- 每个 P4/P5 用例迁移后旧方法只委派；
- 代码审查检查旧 helper/import/cache 状态；
- 不使用长期 feature flag 双路径；
- 回滚时临时恢复单一旧权威，恢复后清理新路径。

### 依赖反转和全能组件

**表现：** Read-side 依赖完整 `AgentService`、Run Lifecycle 或 runtime；为拆分建立通用 service locator/repository/event bus。

**控制：**

- 新组件采用窄 query/reader/cache/logger 依赖；
- 不允许 Read-side 调用 enqueue/cancel/writeback；
- 只在存在替换、测试或依赖方向收益时建立 port；
- 阶段审查检查 import 图和构造参数。

### Shared contract 范围漂移

**表现：** 为方便新组件而修改 `agent-api-read.ts`、新增 endpoint、迁移 archive read 或把 dynamic payload 过度 schema 化。

**控制：**

- Shared contract 文件设为 1B 默认只读边界；
- 任何合同差异触发停止；
- 归档工具、Plugin/MCP/Git、writeback 等另立阶段/设计。

### 测试迁移降低证据

**表现：** 为拆文件删除跨域用例、复制测试长期双跑、改成过度 mock、丢失 API↔Worker 证据。

**控制：**

- 迁移前后核对用例归属、断言和关键覆盖；
- 综合文件保留未迁移用例；
- 迁移完成后删除旧副本或记录明确理由；
- 至少保留 Shared、Route、domain、API↔Worker、Worker runtime 各层必要证据。

## 停止条件

出现以下任一情况，立即暂停当前批次，不用猜测性补丁继续推进：

- P0 无法证明当前 prompt/cache/contract 行为；
- 真实代码与 0005/本阶段基线冲突且未完成设计更新；
- testkit 必须修改生产合同、schema、DB 或全局 `AppContext` 才能工作；
- testkit 只能通过 fake SQLite/HTTP/Worker 才能通过；
- 新组件必须接收完整 `AgentService`/`AppContext` 且无法通过窄 adapter 收敛；
- Read-side 依赖 writeback、run lifecycle 或 runtime 才能完成本阶段目标；
- 迁移要求修改 Shared contract 或 archive/read；
- cache、prompt/messages/profile 任一行为无法证明等价；
- 发现 Route 承担业务组装或产生第二套 status/错误判断；
- 需要同时修改 Worker Runner 主控制流；
- 为通过测试必须删除关键断言、扩大 `any`、屏蔽错误或引入不确定 sleep；
- 出现双实现却没有清晰权威路径和删除条件。

## 回退原则

### 1A

- 优先只回退 testkit 和已迁移测试；
- 恢复原 fixture 不影响生产代码；
- 基线记录保留；
- 重新收敛最小能力后再开始。

### 1B

- 以每个 read-side 用例为回退单元；
- 保留 `AgentService` 兼容入口；
- 回退时恢复原实现为唯一权威，不保留两套生产逻辑长期并行；
- 不回退或修改 1B 之外的 writeback/lifecycle/archive/subtask；
- 若发现合同或模型输入变化，先恢复旧实现，再更新设计和测试证据。

## 后续阶段交界

本阶段完成后，明确留下给后续方案的事项：

- Context Writeback：只接收本阶段已经收窄的 read-side/query 依赖，不反向吸收 prompt 规则；
- Run Lifecycle：通过窄 cache invalidation 能力调用 read-side cache 清理，不依赖完整 prompt service；
- Session/Routes/Module：最终确定 Context Query、Artifact、facade 和 route 位置；
- Compaction/Archive：处理 archive read/write、sidecar 和 fault seam，不因 1B 的 compaction snippet 读取而吸收 archive 主职责；
- Worker：保留现有 API client/Runner 边界，未来另行评估深拆。

## 方案偏差处理

实施中若发现更合理的结构方案：

- 可以调整候选组件名、文件组织或 adapter 形态；
- 不得静默改变 0005/0006 或本阶段不变量；
- 必须记录新证据、影响、替代方案和回滚方式；
- 若超出本阶段范围，应暂停并另出阶段设计，而不是扩大当前批次。
