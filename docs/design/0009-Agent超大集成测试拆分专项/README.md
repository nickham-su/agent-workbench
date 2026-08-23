# Agent 超大集成测试拆分专项

> 状态：专项已完成。P0-P5 的实施、测试、批次独立审查/复审均已闭环，P5 已由主会话暂存。未参与 P0-P5 实施及批次审查的新审查员已完成全面独立终审并通过，达到完成定义；无 H/M 问题，无必须补代码差距。P5 已删除旧综合文件、将 `test:integration` 收窄为新目录，并完成 165 项唯一性、new integration 全量、API 全量、worker/plugin/web 回归、API/root typecheck、root build、资源清理与 diff 核对；未修改生产代码。
> 上位背景：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)。
> 已完成生产结构治理：[`../0007-F-第六阶段-Session-Routes与Module收尾/`](../0007-F-第六阶段-Session-Routes与Module收尾/) 已完成并停止继续改造。
> 独立后续事项：`Worker 结构评估` 尚未启动，不属于本专项范围。

## 快速结论

原 `apps/api/src/modules/agent/agent.integration.test.ts` 约 `11,915` 行，包含 `165` 个顶层 `test(...)`，现已在 P5 删除。`165` 个活动测试均位于 `integration/` 的 `16` 个语义文件，标题唯一、无遗漏或重复；`test:integration` 已收窄为仅运行 `integration/*.test.ts`。

本专项只做测试侧结构治理：

- 按稳定业务调用链将原测试拆分到约 `16` 个语义文件；
- 建立原 `165` 个测试标题、原行号和目标文件的唯一迁移清单；
- 复用现有 [`agent-testkit.ts`](../../../apps/api/src/modules/agent/testkit/agent-testkit.ts)，只做最小扩展；
- 允许新增窄的 `agent-integration-testkit.ts` 和少量领域 helper；
- 将 fixture 所有权改为每测试独立、显式、幂等释放；
- 保留所有关键跨域主链、断言和并发语义；
- 在 P0 实测多文件 runner 发现、并发、资源隔离和耗时后，再冻结最终 `test:integration` 命令。

本专项不追求减少测试覆盖率，不修改生产逻辑，也不借机治理 Worker、Store、composition 或产品行为。

## 目标结构概览

```text
apps/api/src/modules/agent/
├── integration/
│   ├── agent-plugin-host.integration.test.ts
│   ├── agent-startup-recovery.integration.test.ts
│   ├── agent-events-sse.integration.test.ts
│   ├── agent-subtask-lineage.integration.test.ts
│   ├── agent-subtask-routes.integration.test.ts
│   ├── agent-subtask-prefork-result.integration.test.ts
│   ├── agent-session-routes.integration.test.ts
│   ├── agent-session-control.integration.test.ts
│   ├── agent-read-context.integration.test.ts
│   ├── agent-run-cancel.integration.test.ts
│   ├── agent-settings-profile.integration.test.ts
│   ├── agent-prompt-context.integration.test.ts
│   ├── agent-peripheral-status.integration.test.ts
│   ├── agent-archive-compaction.integration.test.ts
│   ├── agent-artifact-tool-output.integration.test.ts
│   └── agent-global-prompts-workspace.integration.test.ts
└── testkit/
    ├── agent-testkit.ts
    ├── agent-integration-testkit.ts      # 候选窄扩展，P0 定稿
    └── ...                               # 仅在确有复用时增加窄领域 helper
```

上述文件名是目标建议，不是按行数机械切割的强制模板。实施时允许小幅调整名称，但不得改变按业务调用链分域、唯一归属和禁止 `part1/part2` 的原则。

## 冻结决策

- **测试覆盖不下降。** 原 `165` 个测试必须全部有唯一新归属，测试标题与核心断言不得丢失或弱化。
- **生产代码零改动。** 若拆分必须修改生产逻辑、合同、数据库、Worker 或运行时行为，立即停止并重新评估。
- **按语义拆分。** 禁止创建 `agent.integration.part1.test.ts`、`part2` 等机械文件。
- **fixture 每测试独立。** 每个测试继续使用真实 SQLite、`AppContext`、Fastify app 和唯一临时目录；禁止跨文件共享全局 fixture 单例。
- **teardown 显式且幂等。** 复用现有 testkit 的 `dispose()` 语义，不复制旧文件中的全局 `Set` / `WeakMap` 清理模式。
- **testkit 保持窄。** 通用 fixture、默认初始化和稳定 HTTP helper 才能进入 integration testkit；Subtask、Archive、Prompt 等领域 helper 应就近保留。
- **关键主链必须保留。** Plugin Host/process/socket、SSE、startup recovery/cancel race、runtime cancel best-effort、Subtask lineage/orphan/reuse、Session clear/revert、Archive/Compaction、Artifact symlink/path、Prompt/Settings/Workspace/Skills 均不得被单元测试替代或删除。
- **并发语义保持。** 既有 `{ concurrency: false }` 等配置必须原样迁移；P0 必须实测多文件并发和资源隔离。
- **脚本后冻结。** `apps/api/package.json` 当前 `test:integration` 仍指向旧文件，最终命令必须在 P0 实测后定稿。
- **分批可回滚。** 旧测试块只有在新位置定向测试、必要回归和独立复审通过后才能删除。

## 实施批次

| 批次 | 目标 | 主要范围 |
|---|---|---|
| P0 | 已完成：冻结基线与验证多文件运行模型 | 165 项清单、runner 发现/并发/耗时、最小 testkit、一个迁移探针；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P1 | 已实施：迁移资源边界清晰的特殊主链 | Plugin Host、startup recovery、SSE、Settings/Profile；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P2 | 已实施：迁移 Subtask 与入口合同 | lineage、routes、prefork/result、session routes；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P3 | 已实施：迁移 Context、Lifecycle 与 Session control | read-context、run-cancel、session control、窄 writeback helper；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P4 | 已实施：迁移 Prompt、Peripheral、Archive 与 Artifact | prompt `17`、status `18`、archive/compaction `6`、artifact/tool-output `11`、global/workspace `12`；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P5 | 已完成：删除旧综合文件并完成实现侧总验收 | 165 项唯一核对、脚本收窄、new integration `165/165`、API 全量 `334/334`、API/root 验证与资源清理通过；独立审查与 L1 复审通过，P5 已由主会话暂存；全面独立终审通过 |

每批固定执行：

```text
实施
  → 定向测试与必要回归
  → 未参与本批实现的独立审查
  → 修复
  → 独立复审
  → 记录证据
  → 下一批
```

阶段全部完成后，已由未参与 P0-P5 实施及批次审查的新审查员完成全面独立终审并通过。

## 文档结构

| 文件 | 职责 |
|---|---|
| [01-background-goals-and-scope.md](./01-background-goals-and-scope.md) | 背景、目标、范围、边界与非目标 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 文件规模、fixture、helper、脚本、特殊资源与现有 testkit 证据 |
| [03-target-test-structure.md](./03-target-test-structure.md) | 目标目录、语义分组和测试归属规则 |
| [04-testkit-and-fixture-design.md](./04-testkit-and-fixture-design.md) | testkit 最小扩展、fixture 所有权、teardown 与领域 helper 规则 |
| [05-migration-map-and-batches.md](./05-migration-map-and-batches.md) | 165 项迁移清单、P0-P5 步骤、门禁和回滚点 |
| [06-testing-review-and-acceptance.md](./06-testing-review-and-acceptance.md) | 验证矩阵、审查清单和完成定义 |
| [07-risks-stop-conditions-and-non-goals.md](./07-risks-stop-conditions-and-non-goals.md) | 风险、停止条件、非目标和兼容性要求 |
| [08-code-map.md](./08-code-map.md) | 当前与目标文件、helper、脚本和调用链代码地图 |
| [09-implementation-record.md](./09-implementation-record.md) | 实施记录与验收日志；只记录实际执行并看到的结果 |

## 完成定义

只有以下条件全部满足，本专项才算完成：

**已达成。** 全面独立终审确认以下条件满足，无 H/M 问题或必须补代码差距。

- 旧 `agent.integration.test.ts` 已删除，或仅保留极少且有明确理由的 cross-domain smoke；
- 原 `165` 个测试均有唯一目标文件，标题与核心断言可追踪且没有覆盖下降；
- 新文件按稳定业务调用链组织，不存在 `part1/part2` 或新的超大杂项文件；
- fixture 每测试独立，SQLite、Fastify、临时目录、socket/process 等资源可明确释放；
- 没有跨文件全局 fixture 单例，也没有新的万能巨型 testkit；
- 所有特殊主链和既有并发语义保留；
- `apps/api/package.json` 的 `test:integration` 已按 P0 实测结论覆盖新目录和迁移期间仍存在的旧文件；P5 在旧文件删除后收窄为新目录；
- API 定向测试、API 全量测试、API typecheck、root build/typecheck 和 `git diff --check` 通过；
- 生产代码与产品行为零改动；
- 每批独立审查/复审通过，最终新审查员全面终审通过。
