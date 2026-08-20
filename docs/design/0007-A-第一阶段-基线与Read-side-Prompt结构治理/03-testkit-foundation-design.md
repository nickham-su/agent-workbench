# 1A：基线与最小 testkit 起步

## 1A 定位

1A 是本阶段的前置使能，不是独立的长期测试工程。它只提供 1B 和后续少数职责域共同需要、语义明确且不会掩盖真实边界的最小测试能力。

```text
现有重复 fixture / 运行约束
  → 最小 Agent testkit
  → 代表性等价迁移
  → 1A 退出
  → 1B Read-side / Prompt
```

1A 不改变生产行为，不重写 Agent 业务代码，不扩大 Shared contract，不提前建设 archive、writeback、lifecycle 或 subtask 专属测试抽象。

## 目标

- 让 API Agent 测试拥有稳定的临时目录、DB、AppContext 和 app 生命周期；
- 让常见 workspace/repository/session/run 准备可显式表达，减少重复 setup；
- 提供可观测但最小的 fake runtime，用于 1B 需要的应用编排边界；
- 保留真实 `createApp()`、Fastify route、SQLite 和 API-managed Worker 链路；
- 为 1B 的 read-side/prompt 测试提供可靠 fixture，而不是继续复制综合测试文件中的局部实现。

## 目标测试支持边界

候选 testkit 目录和命名由实施批次根据仓库现有测试风格决定。本方案只冻结能力边界，不冻结最终路径或 API 名称。下列分类描述的是可能需要的能力，不表示每类都要落为独立、公开 helper。

公共面默认采用以下最小化规则：

- 优先提供更少、可组合的底层生命周期能力，而不是为每种业务场景建立 builder；
- 只有已经被两个以上独立测试文件或后续已批准批次以相同语义复用的能力，才考虑进入 testkit 公共导出；不得以未来可能复用为依据预建公共 API；
- 仅服务 1B 某个领域测试文件的 profile、prompt、messages 数据 builder，默认留在该领域测试旁作为私有 helper；
- 能用显式参数和现有 Store 函数组合完成的场景，不新增更高层包装；
- 公共 helper 的每个默认值、资源所有权和 teardown 责任必须可说明。

在上述约束下，可能需要以下能力：

### 生命周期 fixture

- 临时 `dataDir` 创建；
- SQLite `openDb()` 与关闭；
- 基础 `AppContext` 构造；
- 可选真实 `createApp()`；
- 统一关闭 app、DB、runtime/子进程和删除临时目录；
- 记录 cwd 约束，避免从仓库根目录误运行 API fixture。

### 基础数据 builder

- workspace 与 repository；
- Agent session；
- 可选 run、run-state；
- 为 read-side 准备 agent/provider/model/settings 的最小显式配置；
- 允许调用方覆盖状态、ID、时间和归属；
- 默认不隐式创建与场景无关的 context item、subtask、archive 或 plugin。

### Fake runtime

最小能力面：

```text
enqueueRun(run)
cancelSession(sessionId)
```

至少支持：

- 记录调用顺序和 run/session identity；
- 配置成功或失败；
- 可选 hook 观察 enqueue/cancel；
- 与 API `AgentRuntimePort` 的必要类型兼容；
- 不暴露真实 `AgentRuntime` 私有队列状态。

1B 主要使用 fake runtime 验证应用装配没有错误触发 runtime；不借此模拟 prompt 内容或替代真实 API↔Worker 链路。

### HTTP helper

只提供低层、显式的 request helper：

- method、URL、payload、headers 可见；
- internal token 显式传入；
- 不自动断言所有 status；
- 不自动创建 session/run；
- 支持保留原始 response body 供场景断言。

## 设计约束

### 真实边界不可隐藏

- persistence/fence 相关场景继续使用真实 SQLite；
- Route/schema/auth/status 场景继续通过真实 Fastify app；
- API↔Worker 主链不改成全 fake；
- testkit 不得自动替测试设置 prompt、provider 或 session 状态，除非 builder 参数明确要求；
- teardown 失败必须可诊断，不能静默吞掉进程、socket 或临时文件泄漏。

### 默认值可见

Builder 必须让关键默认值可阅读、可覆盖：

- workspace ID/path；
- session kind/title；
- agent/provider/model；
- locale；
- run status；
- fake runtime 行为。

不得提供一个隐式创建所有实体的 `createEverything()`，不得用隐藏默认值掩盖 prompt/read-side 输入。

### 依赖方向

测试支持代码只能依赖被测模块和基础测试设施，不得让生产代码反向依赖 testkit。生产 `AppContext` 不因为 testkit 需要而扩大为任意测试开关集合。

本阶段不迁移 `AppContext.agentTestFaults`；archive fault seam 属于后续 Compaction / Archive 阶段。

## 1A 实施范围

### 必须完成

- 盘点并记录 `agent.integration.test.ts`、`agent.worker.integration.test.ts`、`context-item-contract.test.ts` 的重复 setup；
- 选取公共交集，不超过 1B 需要的最小能力；
- 将至少一组 API read-side 领域测试和一组 app/fixture 生命周期测试迁移到 testkit；
- 保留迁移前后关键断言，确认测试数量/关键覆盖没有无意减少；
- 证明 testkit 可在正确 cwd 下运行，并能在失败时清理资源。

### 可以保留在原测试文件

- 仅某个后续领域需要的 subtask/archive/fault fixture；
- 需要特殊进程、Plugin Host 或真实 Worker 的测试 setup；
- 迁移后反而隐藏 HTTP/DB 边界的特殊 fixture。

## 1A 禁止项

- 一次性提取所有测试 helper；
- 按行数切割 `agent.integration.test.ts`；
- 创建全局通用 fixture 框架或 service locator；
- 将真实 SQLite、Fastify、Worker 改成 fake；
- 为后续 archive、writeback、lifecycle、subtask 预建完整 builder；
- 扩大 `AppContext.agentTestFaults`；
- 修改生产 API、Shared contract、数据库 schema、文件格式；
- 以删除断言、扩大 `any` 或跳过 flaky 测试换取绿色。

## 1A 退出条件

1A 只有同时满足以下条件才结束：

- 基线记录完成，关键 cwd/fixture/清理事实有源码或测试证据；
- 最小 testkit 能创建并清理临时目录、SQLite、AppContext 和需要的基础 workspace；
- fake runtime 具备最小 enqueue/cancel 观测和受控失败能力；
- 至少一组代表性测试已经使用 testkit 且行为等价；
- 真实 app、SQLite、Route 和 API↔Worker 路径仍有独立证据；
- testkit 没有引入生产依赖、全局状态或隐式业务实体；
- testkit 扩展边界与停止条件已记录；
- 1A 独立审查和复审通过。

达到上述条件后，1A 进入冻结状态。后续对 testkit 的修改必须在 1B 或后续职责域阶段中以具体测试需要为依据，不得继续以“完善基础设施”为独立目标。
