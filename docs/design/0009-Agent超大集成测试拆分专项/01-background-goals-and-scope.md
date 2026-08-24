# 背景、目标与范围

## 背景

此前 [`0006-Agent模块结构治理总方案`](../0006-Agent模块结构治理总方案/) 及其阶段方案已完成 API Agent 生产模块的职责收口。最终的 [`0007-F-第六阶段-Session-Routes与Module收尾`](../0007-F-第六阶段-Session-Routes与Module收尾/) 明确了 Session、Query、Lifecycle、Subtask、Archive、Routes、Facade 与 Startup 的边界，并已完成实现、回归与独立终审。

该生产结构治理到此停止。本专项不是 `0007-F` 的补代码阶段，也不是继续追求生产架构纯洁性。

当前独立存在的维护性问题是：

```text
apps/api/src/modules/agent/agent.integration.test.ts
```

该文件约 `11,915` 行，包含 `165` 个顶层测试。大量不同业务调用链、资源生命周期和测试辅助能力集中在同一物理文件中，使后续局部功能开发面临以下真实成本：

- 人类或 AI 为理解一个局部场景，需要检索和读取大量无关测试；
- 新测试缺少明确归属，容易继续堆入综合文件；
- fixture、Store seam、HTTP helper 与领域 helper 的边界不清；
- 失败定位需要在跨越多个职责域的单文件中搜索；
- 超大输入占用 AI 上下文，降低分析、比对和修改精度；
- 测试拆分前无法清楚判断哪些场景具有特殊进程、socket、SSE 或并发约束。

## 专项目标

本专项完成后，应获得以下测试结构能力：

- 开发者可根据业务调用链直接找到对应集成测试文件；
- AI 可只读取目标领域文件和窄 helper，而不必加载约一万两千行综合测试；
- 新功能测试有明确归属规则，不再默认追加到统一大文件；
- fixture 的创建、所有权和释放方式可在每个测试模块中直接理解；
- 跨层真实主链继续保留，不因拆文件而退化为仅靠 mock 的单元测试；
- 原测试标题、断言、并发与资源语义可审计、可追踪；
- 测试命令能够稳定发现新目录，并保持可接受的并发与执行耗时。

## 本专项纳入范围

### 测试文件分域

- 盘点原 `165` 个测试标题、原行号和主断言所属调用链；
- 按 Plugin Host、Startup Recovery、SSE、Subtask、Session、Context、Run Cancel、Settings、Prompt、Peripheral、Archive、Artifact 等语义分组；
- 创建约 `16` 个可独立理解的 integration test 文件；
- 旧测试块在新位置验证通过后逐批删除；
- 最终删除旧综合文件，或仅保留极少且理由明确的 cross-domain smoke。

### 测试辅助能力

- 复用现有 [`agent-testkit.ts`](../../../apps/api/src/modules/agent/testkit/agent-testkit.ts)；
- 最小扩展真实 App fixture 所需的既有选项；
- 可新增窄 `agent-integration-testkit.ts`；
- 提取稳定通用能力，如默认 Agent 配置、默认 allowlist、create session、send message；
- 将 Subtask、Context writeback、Archive、Prompt 等领域 helper 就近保留或放入窄领域 helper 文件；
- 消除旧综合文件依赖的跨文件全局 fixture `Set` / `WeakMap` 模式。

### 测试运行与脚本

- 在 P0 实测 `tsx --test` 多文件发现方式；
- 记录多文件运行时的并发、资源隔离、输出与耗时；
- 保留显式 `{ concurrency: false }` 等既有语义；
- P0 结论通过后，再将 `apps/api/package.json` 的 `test:integration` 改为指向新目录；
- P5 执行 API 全量测试、typecheck、root build/typecheck 与 diff hygiene。

### 文档与审查

- 维护 `165` 项唯一迁移清单；
- 每批记录迁移、测试、审查、修复和复审证据；
- 最终由未参与 P0-P5 的新审查员完成全面独立终审。

## 系统边界

| 系统或层 | 本专项允许动作 | 明确禁止 |
|---|---|---|
| API Agent 生产代码 | 无；只作为测试对象 | 修改 application、route、runtime、Store、composition、module |
| API Agent 测试 | 分域、迁移、helper 收口、fixture 明确化 | 删除主链、降低断言、改产品预期 |
| `apps/api/package.json` | P0 后仅更新 `test:integration` 发现命令 | 修改生产启动、build 或依赖版本 |
| Shared | 仅作为现有测试依赖 | 修改合同、schema、类型或 prompt 产品定义 |
| Worker | 仅运行既有回归 | Worker 结构评估或 Runner 修改 |
| Plugin Host / Feishu | 保留现有真实测试主链 | 修改进程协议、socket 或业务逻辑 |
| DB / filesystem | 每测试继续使用真实 SQLite 和临时目录 | schema、迁移、文件格式或路径安全语义改造 |
| Web / Plugin | 只在最终回归中验证需要的兼容性 | UI 或插件功能改造 |

## 明确排除项

- 不继续拆分或重构 `agent.store.ts`；
- 不继续拆分或重构 `agent.composition.ts`；
- 不重新设计 `AgentService`、routes、module 或 startup；
- 不启动 Worker 结构评估；
- 不优化模型超时、取消、重试或工具执行机制；
- 不修改 URL、HTTP schema/status/error code、Shared internal contract；
- 不修改 DB schema、Archive/Artifact 格式或文件安全策略；
- 不因已有单元测试而删除真实 SQLite/HTTP/process/SSE 主链；
- 不把全部 helper 收拢到新的全局 test utility；
- 不以固定行数为唯一拆分依据；
- 不进行与测试迁移无关的格式化、重命名或生产代码清理。

## 与其他任务的边界

### 与已完成 Agent 模块治理的关系

- `0007-F` 已完成，不重新打开生产职责边界；
- 本专项复用 `0007-F` 已建立的领域 owner，作为测试分组依据；
- 如果测试迁移暴露生产代码维护性问题，只记录为独立候选，不在本专项处理；
- 生产文件出现任何 diff 都应视为超出范围，除非用户另行批准新的任务。

### 与 Worker 结构评估的关系

- Worker 结构评估尚未启动；
- 本专项只保留当前 API↔Worker、recovery、cancel 等已有测试证据；
- 不分析或重写 Worker Runner；
- 不以测试拆分为理由改变 API↔Worker 时序或 internal contract。

## 目标与非目标的判断规则

以下变化属于目标：

- 测试移动到语义明确的新文件；
- imports 随测试移动而收窄；
- fixture helper 改为显式接收 fixture；
- 重复且稳定的测试初始化进入窄 testkit；
- `test:integration` 根据 P0 实测结果更新发现路径。

以下变化不属于目标：

- 修改测试断言以适配新实现；
- 修改生产实现以让拆分后的测试通过；
- 将慢集成主链替换为 fake-port 单元测试；
- 为了减少文件数量而重新合并无关调用链；
- 为了减少行数而建立语义不明的 `part1/part2` 文件。

## 退出标准

- 开发者可以通过功能类型直接定位到一个或少数相关 integration 文件；
- 原 `165` 个测试标题、原行号和新位置可一一核对；
- 每个新文件的 fixture 与 helper 依赖在文件顶部或窄 testkit 中可发现；
- 特殊 process/socket/SSE/cancel race 主链没有被普通 HTTP 测试淹没；
- 旧综合文件不再是新增测试的默认入口；
- 全量验证证明拆分没有降低覆盖或改变产品行为。
