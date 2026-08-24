# 目标测试结构

## 设计原则

### 按业务调用链，而不是按行数

目标文件应表达主要测试对象和真实主链。禁止以下结构：

```text
agent.integration.part1.test.ts
agent.integration.part2.test.ts
agent.integration.misc.test.ts
```

行数只作为认知负担指标，不作为唯一拆分规则。允许单个高内聚场景文件相对较长，不允许为了压缩行数把同一主链拆成难以追踪的碎片。

### 每个测试唯一归属

原 `165` 个测试必须：

- 保留唯一标题；
- 记录原行号；
- 指定唯一目标文件；
- 迁移后只有一个活动副本；
- 旧副本仅在新副本验证通过后删除；
- 不通过复制形成长期重复覆盖。

### 主断言决定归属

跨域测试按主断言归类，而不是按调用了哪个 helper 归类。例如：

- Prompt 测试即使使用 Settings 初始化，仍归 Prompt；
- Archive compaction 测试即使调用 Context writeback，仍归 Archive/Compaction；
- Subtask result 即使经过 route 和 Store，仍归 Prefork/Result；
- Session clear/revert 即使产生 archive side effect，仍归 Session Control。

### 保留真实边界

拆分不能把集成测试降级成单元测试。以下真实对象按原测试继续使用：

```text
SQLite
AppContext
Fastify app / app.inject
Plugin Host process/socket
SSE stream
filesystem sidecar/artifact/archive
AgentRuntime seam
API internal contract routes
```

## 建议目标目录

```text
apps/api/src/modules/agent/integration/
├── agent-plugin-host.integration.test.ts
├── agent-startup-recovery.integration.test.ts
├── agent-events-sse.integration.test.ts
├── agent-subtask-lineage.integration.test.ts
├── agent-subtask-routes.integration.test.ts
├── agent-subtask-prefork-result.integration.test.ts
├── agent-session-routes.integration.test.ts
├── agent-session-control.integration.test.ts
├── agent-read-context.integration.test.ts
├── agent-run-cancel.integration.test.ts
├── agent-settings-profile.integration.test.ts
├── agent-prompt-context.integration.test.ts
├── agent-peripheral-status.integration.test.ts
├── agent-archive-compaction.integration.test.ts
├── agent-artifact-tool-output.integration.test.ts
└── agent-global-prompts-workspace.integration.test.ts
```

目标为约 `16` 个语义文件。P0 可基于真实 import/helper 耦合小幅调整文件名或合并边界，但必须记录差异和理由；不得退回机械拆分。

## 文件职责

### `agent-plugin-host.integration.test.ts`

覆盖：

- Plugin Host service reconcile；
- mock Feishu plugin；
- process start/stop；
- Unix socket client；
- 特殊等待与 teardown。

该文件必须与普通 app.inject 测试隔离，避免 process/socket 资源语义被通用 fixture 隐藏。

### `agent-startup-recovery.integration.test.ts`

覆盖：

- startup fail mode；
- archive pending reconcile；
- recover enqueue 前 cancel-wins；
- enqueue 后 DB cancelled 终态优先；
- enqueue failure 隔离；
- runtime cancel best-effort。

保留 direct composition/runtime seam 与真实 SQLite 状态断言。

### `agent-events-sse.integration.test.ts`

覆盖：

- SSE 连接；
- `run-complete` 事件 chunk；
- event type/id/data；
- reader/body/abort teardown。

SSE 文件不吸收普通 status query。

### `agent-subtask-lineage.integration.test.ts`

覆盖：

- primary lineage 自愈与重置；
- run lineage 持久化；
- cascade 按 lineage；
- orphan scanner；
- new-shell compensation 与 existing reuse；
- partial unique 与 SQLite 弱类型防线。

### `agent-subtask-routes.integration.test.ts`

覆盖：

- Subtask start route validation；
- depth/mode/idempotency；
- session union；
- auth/schema precedence；
- ignored run 合同；
- endpoint-local P0 schema/preValidation probe。

P0 probe 类型和 route registration helper 应留在此文件或窄 route-contract helper，不进入通用 integration testkit。

### `agent-subtask-prefork-result.integration.test.ts`

覆盖：

- prefork summary/meta validation；
- prefork plan threshold；
- guard/prompt 顺序；
- description 截断；
- result/status terminal fallback；
- partial result；
- workspace agent enablement 对 Subtask 的影响。

### `agent-session-routes.integration.test.ts`

覆盖：

- primary create；
- public fork；
- internal trigger dedup；
- primary compact/fork lineage root；
- run route accepted shape；
- final text 路由可按调用边界在该文件或 Peripheral 文件定稿，但只能有唯一归属。

### `agent-session-control.integration.test.ts`

覆盖：

- compact public/internal transport；
- clear 成功、empty、running、并发；
- revert running、non-terminal、成功 rollback；
- subtask session 的 send/compact/clear read-only；
- workspace 删除 archive 目录清理。

### `agent-read-context.integration.test.ts`

覆盖：

- prompt-context static promise cache；
- send dedup 与 context append；
- read-side 不修改现有状态；
- messages-context 与 locale fallback；
- context items afterId / item read；
- assistant reasoning create/update/read exclusion；
- failed assistant projection；
- boundary reason 过滤。

### `agent-run-cancel.integration.test.ts`

覆盖：

- active item cancellation；
- Subtask tool item cancellation；
- run-complete(cancelled) settlement；
- hidden chain settlement；
- terminal run 不被脏 item 误改；
- parent/child 精确 cascade。

原 `{ concurrency: false }` 必须保留。

### `agent-settings-profile.integration.test.ts`

覆盖：

- maxSubtaskDepth 归一化与运行时设置；
- Agent settings scope/order/tools/globalPromptIds compatibility；
- provider/profile/model resolution；
- compactionModel；
- OpenAI / OpenAI-compatible provider profile；
- execution-profile surface 与 scope；
- provider remote model listing。

如果 OpenAI-compatible 远程模型列表需要特殊网络 mock，应继续保持原 seam，不引入真实外网依赖。

### `agent-prompt-context.integration.test.ts`

覆盖：

- locale 与 runtime constraints；
- tool visibility；
- structured tool-call/tool-result；
- apply_patch prompt representation；
- todolist tool 与 title update；
- compaction snippet 注入可归 Archive 文件；
- global/workspace/skills 静态提示可归专门 global 文件。

该文件关注单次 prompt-context 的消息和工具表达，不承担所有 prompt 来源。

### `agent-peripheral-status.integration.test.ts`

覆盖：

- run-state；
- status summary；
- channel allowlist；
- internal agents/list；
- context-items-tail；
- internal final-text 若按外围调用面归类。

保留 internal token、plugin id/header/body 验证顺序。

### `agent-archive-compaction.integration.test.ts`

覆盖：

- context compaction；
- archive write/search/read；
- compaction snippet 缓存与即时重建；
- locale snippet；
- archive v2 边界；
- snippet 窗口与单行限制。

### `agent-artifact-tool-output.integration.test.ts`

覆盖：

- completed apply_patch 必须经 update；
- apply_patch/write artifact 拉取；
- missing file；
- symlink 越界；
- slim result 与完整 args；
- cancelled/failed write args；
- string tool result；
- legacy / partial migration tool data。

### `agent-global-prompts-workspace.integration.test.ts`

覆盖：

- global prompts settings compatibility；
- selection/expanded prompt；
- prompt 注入顺序；
- workspace `AGENTS.md` 缺失、截断；
- startup seed 修复；
- agent prompt 为空 fallback；
- skills 摘要和同 run cache；
- repo symlink/path mismatch 安全跳过。

## 新增测试归属规则

未来新增测试按以下判断：

| 新需求 | 默认归属 |
|---|---|
| Plugin Host 进程、socket、service reconcile | Plugin Host |
| startup fail/recover、enqueue/cancel race | Startup Recovery |
| SSE 事件与连接生命周期 | Events SSE |
| Subtask lineage/orphan/reuse/约束 | Subtask Lineage |
| Subtask HTTP schema/auth/depth/mode | Subtask Routes |
| prefork plan/summary/result/partial result | Subtask Prefork Result |
| primary create/fork/trigger route contract | Session Routes |
| compact/clear/revert 命令 | Session Control |
| messages-context/context-item/reasoning | Read Context |
| cancel/cascade/settlement | Run Cancel |
| settings/provider/profile/model resolution | Settings Profile |
| prompt 工具消息/locale/runtime constraints | Prompt Context |
| status/tail/allowlist/agents/list/final text | Peripheral Status |
| archive/search/read/compaction snippet | Archive Compaction |
| artifact/path/symlink/tool result persistence | Artifact Tool Output |
| global prompts/AGENTS.md/skills/workspace context | Global Prompts Workspace |

如果一个需求无法按此表唯一归属，应先确认其主断言；不要默认新建 `misc` 文件。

## 文件规模与可读性护栏

不设机械硬上限，但审查应关注：

- 单文件是否只有一个主要调用链；
- AI 是否可在一次分析中读取文件和直接 helper；
- imports 是否跨越过多无关职责域；
- 单文件新增用例是否需要理解其他文件的内部 fixture；
- 是否出现超过约 `1,500-2,000` 行且仍持续增长的混合文件；
- 是否出现新的全局 helper 袋或大规模复制 fixture。

若某文件偏长但高内聚、资源语义特殊且拆开反而降低理解，应允许保留，并在实施记录中说明。
