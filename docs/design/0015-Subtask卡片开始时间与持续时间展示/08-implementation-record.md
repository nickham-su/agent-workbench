# 实施、审查与验收记录

> 状态：实施完成；阶段一、阶段二均已完成独立审查与复审。本记录基于当前工作区实现和本次实际验证结果编写；正式合并/发布前仍应复核 Git 暂存内容与本记录的命令结果。
>
> 对应设计基线：[README.md](./README.md)、[06-testing-acceptance.md](./06-testing-acceptance.md)、[07-implementation-plan.md](./07-implementation-plan.md)。

## 实施结论

本期已实现：在父会话历史中的 `subtask` 工具卡片上，基于精确关联的 child `agent_run` 展示开始时间；当 child run 处于 `completed`、`failed` 或 `cancelled` 时，展示从 run 激活落库到终态落库的墙钟持续时间。

实现仍遵守以下边界：

- 时间事实源是 child `agent_run`，不是父 `agent_context_item`；
- parent/child 精确关联使用 `workspaceId + item.runId + item.id`；
- 不使用 child session 的 `lastRun` 或 session ID 推测卡片关联；
- running 只展示 `startedAt`，不使用 run 的 `updatedAt` 伪造最终持续时间；
- terminal duration 仅使用 API 投影的 `durationMs`，Web 不重新计算；
- 无关联、旧历史、copied item 或非法 child run 时间安全省略时间行；
- 不新增数据库字段、迁移、前端逐卡片请求或逐卡片 timer。

## 实际改动文件

### Shared 契约与测试

| 文件 | 实际改动 |
|---|---|
| `packages/shared/src/contracts/agent.ts` | 新增 terminal status、可判别 `AgentSubtaskRunSummarySchema` / type，并为 `AgentContextItemRecordSchema` 增加 optional `subtaskRun`。running 强制 `endedAt/durationMs = null`；terminal 强制正 `startedAt/endedAt` 与非负 `durationMs`。 |
| `packages/shared/tests/agent-image-message.test.ts` | 覆盖 running/terminal 合法与非法组合、旧 item 兼容，以及 public list / public single item / internal tail 三类 schema 的 optional 字段兼容性。 |

### API 读侧投影与测试

| 文件 | 实际改动 |
|---|---|
| `apps/api/src/modules/agent/query/context-query-read-model.ts` | 新增 read-side 最小实体 `SubtaskParentKey` 与 `SubtaskRunProjectionRecord`，避免 query application 依赖完整 store record。 |
| `apps/api/src/modules/agent/agent.store.ts` | 新增 JSON1 批量查询 `listSubtaskRunProjectionsByParentTools()`；按 workspace 与 parent key 精确关联，空输入短路，保留原始 `parentRunId`，不做逐卡片查询。 |
| `apps/api/src/modules/agent/query/context-query-ports.ts` | 为 query store 增加批量投影读取端口和 error 诊断能力。 |
| `apps/api/src/modules/agent/query/sqlite-query-stores.ts` | 将批量读取接入 SQLite query store。 |
| `apps/api/src/modules/agent/query/context-query-application.ts` | 实现统一 enrich：覆盖 full/tail/before/after 列表与单项读取；运行中/终态摘要投影；`Math.max(0, endedAt - startedAt)`；重复 child run 的 fail-open 与固定诊断。 |
| `apps/api/src/modules/agent/agent.composition.ts` | 注入 query application 所需的结构化 error logger。 |
| `apps/api/src/modules/agent/agent.store-subtask-run-projection.test.ts` | 直接验证 JSON1 批量查询的空输入、去重、部分命中、双维 key、workspace 隔离、原值关联、500 与 1001 key 集合。 |
| `apps/api/src/modules/agent/query/context-query-application.test.ts` | 覆盖 list/single、running、冲突 fail-open、无 subtask 时 0 次 child 查询、`runId = null`/空白时不查询不投影、`updatedAt < createdAt` 与 `updatedAt = createdAt` 时 duration 归零，以及大于 public page 上限的批量读取。 |
| `apps/api/src/modules/agent/integration/agent-read-context.integration.test.ts` | 覆盖 exact child run、missing/copy、existing R1/R2、public conflict fail-open、cancelled、full/before/after/single 摘要一致性。 |
| `apps/api/src/modules/agent/integration/agent-peripheral-status.integration.test.ts` | 覆盖 internal `context-items-tail` 的 `subtaskRun` 序列化。 |

### Web 展示与测试

| 文件 | 实际改动 |
|---|---|
| `apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.ts` | 新增纯展示/刷新 helper：开始时间以浏览器本地时区判断今天（今天 `HH:mm`、非今天 `MM-DD HH:mm`），无效时区安全省略、无效 `now` 按非今天展示；以及持续时间格式、child-first effective status、摘要透传、摘要变更检测、单项 item 整体替换。 |
| `apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.test.ts` | 覆盖今天/非今天、跨午夜、时区与夏令时、月日时分补零、非法值/时区/now 降级、状态优先级、API item 到 DisplayItem 的透传、running→terminal、仅 duration 改变与 upsert 保留摘要。 |
| `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` | 消费 `item.subtaskRun`；卡片在 Agent/模式与 session ID 之间显示开始时间，terminal 显示持续时间；icon/class/spin 使用同一 child-first status；刷新检测比较摘要。 |
| `apps/web/src/shared/i18n/locales/zh-CN.ts` | 增加“开始时间”“持续时间”文案。 |
| `apps/web/src/shared/i18n/locales/en-US.ts` | 增加“Started”“Duration”文案。 |
| `apps/web/package.json` | 将新增 Web helper test 加入显式 test script。 |

## 实际差异与决策

| 设计项 | 实际情况 | 决策与原因 |
|---|---|---|
| 批量查询实现 | 使用 SQLite JSON1 单参数 `json_each`，未实现分块 fallback。 | 当前运行环境和真实 store 测试已验证 JSON1 可用。单查询避免 N+1 与 SQLite 变量上限；若未来替换 SQLite 构建/驱动，需在对应变更中确认 JSON1 仍可用，或另行评审分块 fallback。 |
| Web 映射/刷新测试 | 将部分 `AgentClientPane.vue` 内联逻辑抽为轻量纯 helper。 | 没有引入组件测试框架；纯 helper 被生产代码直接复用，可验证映射、变更检测和 upsert 关键路径，符合最小维护成本。 |
| Web 手工 UI 验收 | 本次未启动浏览器进行逐项手工操作。 | 自动测试、API 集成、Web typecheck/build 已覆盖数据链与纯展示决策；发布前仍需按下方手工矩阵完成浏览器验收，不能用本记录替代。 |
| API 全量 integration | 全量命令未全绿，存在 3 个独立 prefork 文案断言失败。 | 失败均位于未改动的 `agent-subtask-prefork-result.integration.test.ts`，与本期 Shared/API read-side/Web 变更无调用关系；定向的 read/cancel/recovery/lineage 测试均通过。本期不越界修改该既有 subtask-prefork 行为；发布前应单独修复或豁免该基线失败。 |

未改变：run lifecycle 写路径、`agent_run` schema、parent tool unique index、subtask session 创建/复用语义、父工具消息自身时间语义。

## 查询次数与性能证据

### 自动化证据

| 场景 | 证据 | 结果 |
|---|---|---|
| 无 subtask parent 的 list/single | `context-query-application.test.ts` | `listSubtaskRunProjectionsByParentTools` 调用次数为 0。 |
| 有 subtask parent 的 full transcript | `context-query-application.test.ts` | 1001 个 parent key 一次传入 store，child batch query 调用次数为 1。 |
| Store public/internal 规模 | `agent.store-subtask-run-projection.test.ts` | 500 keys 与 1001 keys 都返回正确结果；JSON1 单参数方案没有 SQLite placeholder 上限问题。 |
| 多卡片/精确关联 | `agent-read-context.integration.test.ts` | existing 同 session 的 R1/R2 分别投影到各自 parent card，不按 session latest run 读取。 |
| Web 请求与 timer | `AgentClientPane.vue` 代码审查、`subtaskRunDisplay.test.ts` | 不新增 API 调用入口、per-card polling 或 timer；现有 list/single 刷新仅整体替换带摘要的 item。 |

本期未建立正式 benchmark。浏览器网络面板和 100 条真实 tail 响应表现属于发布前手工验收项。

## 实际测试与验证结果

以下命令在本次实施中实际执行并通过：

```bash
# Shared
cd packages/shared
npm run build
npm run typecheck
npx tsx --test tests/agent-image-message.test.ts

# API 定向：读侧投影、容量、context、internal tail、cancel/recovery、subtask lineage
cd apps/api
npx tsx --test \
  src/modules/agent/query/context-query-application.test.ts \
  src/modules/agent/agent.store-subtask-run-projection.test.ts \
  src/modules/agent/integration/agent-read-context.integration.test.ts \
  src/modules/agent/integration/agent-peripheral-status.integration.test.ts \
  src/modules/agent/integration/agent-run-cancel.integration.test.ts \
  src/modules/agent/integration/agent-startup-recovery.integration.test.ts \
  src/modules/agent/integration/agent-subtask-lineage.integration.test.ts
npm run typecheck
npm run build

# Web
cd apps/web
npm test
npm run typecheck
npm run build

# 全仓
cd ../..
npm run typecheck
npm run build

git diff --cached --check
git diff --check
```

结果：上述命令均成功退出。后续开始时间格式调整已重新运行 `npm test -w apps/web`、`npm run typecheck -w apps/web`、`npm run build -w apps/web`、`git diff --check` 与 `git diff --cached --check`，均成功退出；其测试覆盖今天/非今天、跨午夜、时区与夏令时、月日时分补零、无效 startedAt/timeZone/now。Web build 仅报告既有 Browserslist 数据过期和较大 chunk 警告，未影响构建成功。

### API 全量 integration 基线结果

执行过：

```bash
cd apps/api
npm run test:integration
```

结果：175 个测试中 172 个通过、3 个失败。失败均稳定复现于未修改文件 `src/modules/agent/integration/agent-subtask-prefork-result.integration.test.ts`：

- `agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示`；
- `subtask start with preforkSummaryText should inject summary->guard->prompt without copying parent history`；
- `agent subtask fork 对父 run 非法 locale 做归一化回退，避免继续传播非法值`。

三项都是子任务 fork/prefork guard 文案包含关系的断言，未涉及 `subtaskRun`、context-items read-side projection、Shared schema 或 Web 卡片。单独重跑同一文件仍是相同 3 项失败、其余 11 项通过，说明不是本期并发测试导致。本期按最小范围原则不修改无关 prefork 行为；此全量基线失败必须在发布门禁中单独处理。

## 阶段审查与复审

### 阶段一：Shared/API 读侧

首轮独立审查提出：

- 缺 existing 同一 child session 的 R1/R2 绑定证据；
- 缺 store JSON1 批量查询直接测试；
- 缺 public/internal wrapper schema 验证；
- query read type 耦合 store implementation；
- 缺 conflict fail-open route 证据；
- 后续复审补充缺 cancelled 与 before/after 路径证据。

处理：全部修复并增加自动测试。独立复审结论：通过。

### 阶段二：Web 展示

首轮独立审查提出：

- 缺 API item → DisplayItem、摘要变更检测、单项替换的纯逻辑测试；
- 非法 `durationMs` 可能留下只有标签没有数值的时间行。

处理：抽取并由生产代码复用 `subtaskRunDisplay` helper，增加 mapping/change/upsert tests；以格式化结果非空为 duration 行的渲染条件。独立复审结论：通过。

## 最终验收口径

验收时必须使用以下表述：

> 对能够通过父 Run 和父工具 item 精确关联 child run 的 subtask 卡片，展示 run 激活落库的开始时间，并在 completed、failed、cancelled 后展示到终态落库的墙钟持续时间；旧数据或无关联卡片安全降级。

不得表述为模型纯执行耗时、Provider 耗时或外部执行器精确结束时间。

## 发布前手工验收与门禁

尚需在真实浏览器/预发布环境完成并留存证据：

- new subtask 的 running → completed；
- failed 与 cancelled 的终态时间和 child-first icon；
- running 与 terminal 时刷新浏览器、single item refresh、settle poll；
- existing 同一 child session 的两张卡片；
- 旧历史、missing child 与 fork copied item；
- tail/before/after 历史读取、窄宽度换行；
- 中英文文案、卡片点击与 session ID 复制；
- 浏览器网络面板确认不存在逐卡片请求；
- 100 条 tail 的代表性响应表现；
- 预发布/灰度日志中不存在 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`。

任何出现 `AGENT_SUBTASK_RUN_PARENT_CONFLICT` 的测试、预发布或灰度环境都必须阻断发布/继续放量；运行时读侧会 fail-open（只省略冲突卡片摘要），不应因一张卡片损坏阻断整个历史响应。

此外，当前 API 全量 integration 的 3 个 prefork 基线失败未关闭前，不应宣称 API 全量 integration 通过；应先由相应维护者修复或按发布流程完成明确豁免。

## 已知限制与后续项

- `updatedAt` 是后端收到 terminal 事件并持久化的近似终态时间；若未来出现终态后仍正常更新 `agent_run.updatedAt` 的写路径，必须重新评审本期 duration 语义，并考虑不可变 `endedAt`。
- JSON1 是当前批量查询实现前提；迁移 SQLite driver/build 时必须验证该能力。
- conflict 诊断的“阻断放量”需要预发布/灰度监控流程实际承接；应用代码只负责固定 error 诊断与 fail-open 响应。
- 本期没有引入组件 E2E/截图测试；模板级浏览器行为依赖发布前手工矩阵。
- API 全量 integration 目前有 3 个不属于本期改动面的 prefork 基线失败，详见本记录的测试结果与发布门禁。

## 回滚

本期没有数据库迁移。若上线后出现明显 context-items 性能下降、时间串 run、摘要在单项刷新中丢失、schema 兼容问题或持续 conflict 诊断，应将 Shared/API/Web 本期变更作为同一批次回滚，恢复不含 `subtaskRun` 的读侧和卡片；不得只回滚其中一侧。
