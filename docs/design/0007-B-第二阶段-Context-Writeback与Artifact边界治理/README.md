# 第二阶段：Context Writeback 与 Artifact 边界治理

> 状态：方案审查/复审已通过；P0/P1 已完成审查、修复、复审并精确暂存；P2/P3/P4/P5 已完成审查/复审；P6 已实施且完整自动回归通过，待阶段最终全面审查与最终复审。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)；前置阶段：[`../0007-A-第一阶段-基线与Read-side-Prompt结构治理/`](../0007-A-第一阶段-基线与Read-side-Prompt结构治理/) 已完成并以提交 `0f57bfe` 落盘。
> 行为基线：[`../0004-Worker-API核心写回协议统一/`](../0004-Worker-API核心写回协议统一/) 与 [`../0005-Worker-API读侧与生命周期治理/`](../0005-Worker-API读侧与生命周期治理/) 已冻结的 Worker 写回合同、late fence、冲突和收敛语义。
> P6 开始时 Git 快照：`v1.1...origin/v1.1`；已有阶段改动及其 index 状态由主会话保护和处理，本批未执行 Git 写操作。P6 仅完成残留审计、测试归属记录与完整回归，不改变产品行为。

## 快速结论

本阶段承接 0007-A 已建立的“职责域组件 + `AgentService` 兼容 facade + 真实边界测试”模式，治理 API 侧 Worker context item 写回：

```text
Worker AgentApiClient
  → Shared context contract
  → internal Route
  → AgentService facade
  → Context Writeback application/coordinator
  → 原子 persistence capability
  → SQLite
  → 必要的 artifact capability
```

阶段目标不是重写 context 产品语义，而是让以下规则拥有单一、可审查的权威边界：

- context item create / append；
- context item update；
- session、workspace、run、item ownership；
- late append / update fence；
- session head CAS 与普通 conflict；
- terminal item 的状态收敛；
- `apply_patch` artifact 生成、写入时机与安全文件 I/O；
- 已由 P0 确认的 `write` artifact：同属 API update writeback 主链，但其 completed/failed/cancelled 语义与 `apply_patch` 不同；
- normal / ignored / unchanged / conflict / not-found 的严格区分。

## 阶段组成

```text
P0  写侧基线冻结
P1  最小写回测试地基与证据索引
P2  Writeback 骨架与窄依赖
P3  Create / append 迁移
P4  Update / 状态收敛迁移
P5  Artifact capability 与 apply_patch/write 边界
P6  收尾、完整回归与最终审查
```

每批必须独立实施、测试、审查、修复、复审和回滚。不得把 P3-P5 合成一次性重写，也不得借本阶段提前进入 Run Lifecycle。

## 本阶段纳入

- Shared contract、Worker client、Route、Service、Store 的 writeback 调用链与基线记录；
- `AgentService.appendContextItemFromWorker()`；
- `AgentService.updateContextItemFromWorker()`；
- Store 原子能力：
  - `appendContextItemWithRunFence()`；
  - `getContextItemForWorkerUpdate()`；
  - `updateContextItemWithRunFence()`；
- create 的 head CAS、冲突映射和 late ignored；
- update 的 ownership、terminal/late unchanged 与最终事务内二次 fence；
- `apply_patch` artifact 的结果瘦身、写入时机、安全路径和 best-effort 失败行为；
- `write` completed artifact 的结果瘦身、写入时机、安全路径和 best-effort 失败行为，以及 failed/cancelled 保持完整 args/result 的既有差异；
- Context Query 与 Writeback 共享 artifact capability 的依赖方向；
- `AgentService` 兼容 facade 委派；
- writeback 领域测试、真实 SQLite 事务证据、Route 证据、API-managed Worker 写回顺序证据；
- Shared/API/Worker 的必要构建、类型检查和回归。

## 明确排除

本阶段不得顺手纳入：

- Run Lifecycle、cancel、recovery、enqueue failure 或 run-state 规则重设计；
- Subtask、lineage、orphan；
- Compaction、archive、pending sidecar 或 archive fault seam；
- Shared context contract 的 method/path/schema/response 扩张；
- Worker `runner.ts` 主控制流或 builtin tool 执行体系深拆；
- Route 全面拆分或 `AgentService` 全量拆分；
- Context Query 最终模块/route 归属定稿；
- 数据库 schema、artifact 文件格式、UI 行为或产品状态机变化；
- generation、epoch、lease、outbox 等重型线性化机制。

## 强制不变基线

### Create / append

- 正常 create：`200 { ok: true, item: AgentContextItemRecord }`；
- late create：`200 { ok: true, item: null, ignored: true }`；
- run 不存在仍为 `404 run not found`，不得误判为 ignored；
- 普通 session head conflict 仍为 `409 session head conflict`；
- ignored 不创建 item、不推进 head、不更新 session title、不污染 run state。

### Update

- late / terminal / active-run switched update 返回 unchanged stored item；
- update response 不增加 `ignored` 分支；
- item 不存在或 ownership 不一致继续保持当前 `404` 语义；
- terminal item 不得被迟到 update 写回非终态；
- update 不产生新 item，不跨 run/session/workspace。

### Persistence 与 artifact

- Store fence/CAS 不得退化为 application/service 层先读后写；
- terminal、cancelled 或 active run 已切换后的迟到写回不得污染 DB；
- `getContextItemForWorkerUpdate()` 的初步 fence 与 `updateContextItemWithRunFence()` 的最终事务 fence 均属于当前行为；
- 已由 P0 确认纳入本阶段的 artifact，其既有路径、格式、写入/瘦身/最终 DB fence 顺序和失败行为默认保持；
- Context Query 与 Writeback 可以依赖同一安全 artifact capability，但 Query 不得依赖 Writeback，Writeback 也不得吸收 UI 查询用例。

## 必须暂停的发现

若实施需要以下任一变化，必须停止当前批次并更新设计、基线和验收，而不是继续以结构迁移名义处理：

- 修改 Shared schema、endpoint method/path 或 Worker success response validation；
- 改变 `404 / 409 / ignored / unchanged` 任一语义；
- 将 Store 原子 fence/CAS 拆成多次普通读写；
- 改变 artifact 文件写入与最终 DB fence 的顺序；
- 改变 artifact 写失败、路径失败或孤儿文件的处理政策；
- 修改 cancel、terminal run、active run 或 recovery 的业务规则；
- 修改 context item 状态转换政策、DB schema、artifact 文件格式或 UI 行为；
- 必须使用 fake Store 才能证明 writeback；
- 必须扩大 0007-A testkit 公共合同但无法证明为本阶段最低必需。

## 文档结构

| 文件 | 内容 |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | 背景、目标、阶段关系、范围、非目标和完成定义 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 当前调用链、合同、错误、事务、artifact 与测试基线 |
| [03-writeback-domain-design.md](./03-writeback-domain-design.md) | Writeback application、原子 persistence capability、facade 与依赖方向 |
| [04-artifact-boundary-design.md](./04-artifact-boundary-design.md) | artifact 写入/读取责任、安全 I/O、顺序与迁移约束 |
| [05-implementation-plan.md](./05-implementation-plan.md) | P0-P6 分批步骤、门禁、回滚和暂存节奏 |
| [06-testing-review-acceptance.md](./06-testing-review-acceptance.md) | 测试矩阵、审查、回归、UI 评估与验收标准 |
| [07-code-map.md](./07-code-map.md) | 关键文件、符号、调用链、测试和候选改动面 |
| [08-risks-and-stop-conditions.md](./08-risks-and-stop-conditions.md) | 风险、停止条件、回退原则与后续交界 |
| [09-implementation-record.md](./09-implementation-record.md) | P0-P6 命令、结果、审查、偏差与状态记录模板 |

## 规范性约定

- “必须”表示设计、实现、测试和审查共同遵守；“不得”表示禁止混入。
- 候选组件名只表达职责，不冻结最终类名、文件名或目录深度。
- 当前事实以实施时源码、测试和完整 `git status --short --branch` 为准；发现与本方案不一致时先更新证据，并保护所有非本阶段变更。
- 每批遵循：实施前复核 → 小批实现 → 定向测试与必要回归 → 独立审查 → 修复 → 独立复审 → 用户明确允许后暂存 → 下一批。

## 完成定义

本阶段只有在以下条件同时满足时完成：

- create/update 的 writeback 权威规则进入明确职责边界；
- `AgentService` 两个 writeback 公开入口仅保留兼容委派；
- Store 原子 fence、head CAS 和事务边界未弱化；
- normal、ignored、unchanged、conflict、not-found 继续严格区分；
- `apply_patch`/`write` artifact 写入时机与共享安全 I/O capability 的边界已定稿，且 Query 不依赖 Writeback；
- `context-item-contract.test.ts` 中本域证据已迁移或建立清晰索引，archive/compaction 场景未被混入；
- Shared、Route、真实 SQLite、API-managed Worker、Worker client 各层证据完整；
- build/typecheck/相关测试通过，UI artifact 验收已执行或有经审查的豁免理由；
- P0-P6 均完成独立审查和复审；
- 排除项未被混入，方案偏差已有证据和决策记录。
