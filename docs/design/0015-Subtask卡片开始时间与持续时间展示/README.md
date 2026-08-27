# Subtask 卡片开始时间与持续时间展示

> 状态：规范性详细设计基线，已按独立审查意见修订，待独立复审与实施。
> 范围：在 AI Agent 会话历史消息列表的 `subtask` 工具卡片上展示 child run 的开始时间，并在 child run 进入终态后展示持续时间。
> 前提：现有 subtask lineage、run lifecycle、会话历史分页/轮询机制与数据库表结构保持现状；本方案只增加读侧投影、共享契约和前端展示。

## 快速结论

本需求必须基于与父 `subtask` 工具消息精确关联的 child `agent_run`，不得把父 `AgentContextItemRecord.createdAt/updatedAt` 或 child session 的 `lastRun` 当作当前卡片的运行时间。

冻结口径如下：

```text
父 subtask 工具消息
  parentRunId      = parent item.runId
  parentToolItemId = parent item.id
          ↓ 精确关联
child agent_run
  startedAt  = childRun.createdAt
  endedAt    = childRun.updatedAt，仅终态存在
  durationMs = max(0, childRun.updatedAt - childRun.createdAt)，仅终态存在
```

前端展示规则如下：

- 拿到 `subtaskRun.startedAt` 时，卡片必须展示“开始时间”；
- child run 为 `completed`、`failed` 或 `cancelled` 时，必须展示“持续时间”；
- child run 为 `running` 时不得展示由 `updatedAt - createdAt` 推导的最终持续时间；
- 本期不要求运行中动态计时；未来如增加，必须使用 `now - startedAt`；
- 状态图标优先使用 child run 状态；没有 `subtaskRun` 时才退回父工具消息状态；
- child run 缺失、旧历史数据、复制上下文中 `runId = null` 的卡片保持当前展示，不显示时间占位符，也不得猜测关联。

## 推荐最小方案

在既有 `context-items` 读侧投影中，为符合条件的 `subtask` item 增加可选摘要：

```ts
subtaskRun?:
  | {
      runId: string;
      status: "running";
      startedAt: number;
      endedAt: null;
      durationMs: null;
    }
  | {
      runId: string;
      status: "completed" | "failed" | "cancelled";
      startedAt: number;
      endedAt: number;
      durationMs: number;
    };
```

`startedAt` 与 terminal `endedAt` 的共享 schema 必须使用正数约束；projector 同时保留有限正数校验作为防御，不允许只依赖口头约定。

方案约束：

- 列表接口与单项接口必须复用同一个投影逻辑；
- 列表投影必须批量读取 child runs，不得逐卡片查询；
- 不新增数据库字段或迁移；
- 不新增前端按卡片查询接口；
- 不按 `subtaskSessionId` 请求 child session `/run-state`；
- 不把底层 `createdAt/updatedAt` 原样暴露给卡片后再由前端解释；
- 不改变 subtask 创建、执行、取消、失败和恢复状态机。
- `AgentContextItemRecordSchema` 的扩展同时影响 public context-items 与 internal `context-items-tail` 响应，两条路径都必须纳入契约审查和验收。
- 同一 parent key 异常命中多条 child runs 时固定采用 fail-open：省略该 key 对应 item 的 `subtaskRun`，接口继续成功，并按每请求每 key 一次记录 `error` 级结构化诊断 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；不得任选一条。

## 规范性边界

以下是开发、代码审查、测试和验收的硬约束：

- `AgentContextItemRecord.createdAt/updatedAt` 表达父消息项自身生命周期，不得作为 child subtask 的开始/结束时间。
- child run 必须通过 `(parentRunId, parentToolItemId)` 精确关联，其中父值分别来自 `item.runId` 与 `item.id`。
- `session.mode = "existing"` 可重复使用同一个 subtask session；不同父卡片可能对应同一 session 内的不同 runs，因此不得使用 child session 的 `lastRun` 猜测。
- 终态 `updatedAt` 只近似表示后端写入 `completed/failed/cancelled` 的时间，不承诺是 Provider 或外部执行器停止的精确时刻。
- `durationMs` 是从 run 激活落库到终态落库的墙钟时长，可能包含调度、初始化、等待、取消收敛和恢复处理；不得宣传为“模型推理耗时”。
- `subtaskRun` 是读侧派生摘要，不得写回 `agent_context_item.output`，不得持久化为重复事实源。
- 对 `runId = null`、关联不存在或数据不满足校验的 item，投影必须缺省；不得追溯 fork source、解析文本或按 session 猜测。
- 列表分页、尾部加载、增量加载和单项轮询返回的同一 item，其 `subtaskRun` 语义必须一致。
- 重复 child run 命中属于数据完整性事件：运行时按上述 fail-open 合同保留历史可用性，但测试、预发布或灰度中出现该诊断必须阻断发布/继续放量，直至唯一性根因修复。
- 公开 `tailLimit/limit` 上限均为 500，internal tail 上限也是 500；当前 Web 两者实际使用 100。Store 的 1000 仅是内部防御性 clamp，不是公开容量合同；无参数 full transcript 与 `afterId` 增量仍可能返回超过 500 个 items，批量实现不得假设固定单页上限。
- 如果实施前发现终态 run 仍会在正常生产路径中被后续更新，必须暂停实施并重新评审是否引入独立 `endedAt`；不得继续沿用本方案假设。

## 文档结构

| 文件 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 需求背景、现状、问题、目标、业务逻辑、范围和端到端方案 |
| [02-product-contract.md](./02-product-contract.md) | 产品展示、用户可观察行为、状态矩阵、降级与兼容合同 |
| [03-decisions.md](./03-decisions.md) | 冻结决策、关键取舍、不采用方案、风险与暂停条件 |
| [04-technical-design.md](./04-technical-design.md) | 契约、实体、关联查询、读侧投影、前端映射、数据流和性能设计 |
| [05-code-map.md](./05-code-map.md) | 当前真实代码路径、关键行号、调用链和授权改动边界 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、代码审查清单、验收标准、回归和回滚标准 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 开发任务拆分、详细实施步骤、批次门禁、独立审查和复审要求 |

## 规范性用语

- “必须”表示开发、独立代码审查、测试和验收都必须满足。
- “不得”表示禁止通过临时兼容、前端猜测或局部捷径绕过。
- “建议”表示实现命名或组织形式可以调整，但不得改变已冻结的语义和边界。
- 本目录中的字段语义、状态矩阵、降级规则和验收标准是规范性合同。
- 代码路径与行号基于文档编写时的仓库状态；实施前必须复核。若代码已漂移，应更新代码地图和影响分析，不得按旧行号机械修改。

## 完成定义

只有以下条件同时成立，本需求才算完成：

- Shared 契约以可判别结构表达 running 与 terminal 摘要的不变量；
- Shared 的 public list、single item 与 internal tail 响应均完成扩展影响验证；
- API 列表、单项和 internal tail 均返回一致的 `subtaskRun` 投影；
- child run 关联严格使用父 item 的 `runId + id`，没有 session-level 猜测；
- 列表读取采用批量、受限查询，没有前端或后端 N+1；
- 重复 parent key 的 fail-open、单次高优先级诊断和发布阻断合同有自动测试；
- 前端在摘要存在时展示开始时间，仅在终态展示持续时间；
- 状态图标优先使用 child run 状态，缺失时按文档降级；
- completed、failed、cancelled、running、缺失关联、旧历史、fork copied item、existing 多次复用、分页和单项刷新均有自动测试或明确手工证据；
- 相关 typecheck、build、API 测试和 Web 测试通过；
- 独立代码审查通过；审查问题修复后完成独立复审；
- 验收结论只承诺“subtask run 墙钟开始时间和终态持续时间”，不得扩大为精确模型执行计时。
