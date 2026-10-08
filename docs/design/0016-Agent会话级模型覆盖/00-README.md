# Agent 会话级模型覆盖

> 状态：规范性详细设计基线，待独立审查与实施。
> 范围：将 AI Agent 工具 Tab 中“修改 Agent 模型”从修改全局 `AgentItem.defaultModel`，调整为修改当前 `(sessionId, agentId)` 的主模型覆盖配置。
> 生效边界：配置 API 的 PUT/DELETE 成功返回后创建的新 Run；已创建、排队和运行中的 Run 不受影响。

## 快速结论

本方案新增一个服务端持久化的会话级覆盖层：

```text
(sessionId, agentId)
  → providerId + modelId
```

创建新 Run 时的主模型优先级固定为：

```text
已有 Run 的 provider/model 快照
  > session + agent override
  > AgentItem.defaultModel
```

产品语义固定如下：

- 模型选择器展示当前 Session 下当前 Agent 的**有效主模型**，不能继续只展示全局 `resolvedModel`；
- 保存只写当前 `(sessionId, agentId)` 覆盖，不修改全局 Agent 设置；
- “重置为默认模型”删除覆盖记录，使后续新 Run 重新继承当前全局 `defaultModel`；
- 覆盖持久化到后端，页面刷新后重新加载并回显；
- 当前选中 Agent 继续由现有 `localStorage` 恢复，不新增服务端 `selectedAgentId`；
- 草稿 Session 必须先创建真实 Session，再打开模型弹窗；
- Worker 不动态读取覆盖，继续使用 `agent_run.provider_id/model_id` 快照；
- 本期只覆盖 Agent 主模型，不覆盖 vision model、compaction model 或其他 runtime 设置；
- Fork Session、Subtask Session 不继承父 Session 的覆盖；Subtask Session 不提供编辑入口。

## 规范性边界

以下内容是开发、代码审查和验收的硬约束：

- 覆盖唯一键必须是 `(sessionId, agentId)`，不得退化为 Session 单模型字段。
- 覆盖记录必须存储于 Agent Session 领域数据，不得写入全局 `settings.agent_agents_v1` JSON。
- 前端发送消息请求不得把 `providerId/modelId` 作为权威执行参数；服务端必须按持久化配置解析。
- 服务端必须在创建新 Run 前解析最终主模型，并将其写入 `agent_run`。
- Worker 对已有 Run 必须优先使用 Run 快照，不得在模型请求前重新读取 Session 覆盖。
- PUT/DELETE 成功返回是配置生效边界；提交未完成时不承诺并发创建的新 Run 使用新配置。
- 保存或重置期间，当前 Session 的发送入口必须禁用，避免同一前端产生可见竞态。
- 删除覆盖后若全局默认不可用，删除仍成功，但 UI 和后续 Run 创建必须明确报告默认模型不可用；不得静默改用其他模型。
- 覆盖模型后续失效时，不得静默回退全局默认；必须保留覆盖事实并报告不可用。
- 全局默认变化时：无覆盖的 Session 跟随新默认；有覆盖的 Session 保持覆盖；删除覆盖后继承删除时刻的当前全局默认。
- UI 显示的模型来源必须区分 `session_override` 与 `agent_default`；Run 诊断需要来源时必须使用 `run_snapshot`，不得把所有来源继续标成 `agent_default`。
- 不修改当前独立的全局 `AgentRuntimeSettings.compactionModel` 和 vision model 优先级。
- 不实现运行中切换、不复制 Fork 覆盖、不继承 Subtask 覆盖、不提供 Subtask 编辑、不新增跨浏览器 Agent 选择恢复。

## 推荐最小实现

新增持久化表：

```sql
create table if not exists agent_session_agent_model_override (
  session_id text not null,
  agent_id text not null,
  provider_id text not null,
  model_id text not null,
  updated_at integer not null,
  primary key (session_id, agent_id),
  foreign key (session_id) references agent_session(id) on delete cascade
);
```

新增公共接口：

```text
GET    /api/agent/sessions/:sessionId/model-overrides
PUT    /api/agent/sessions/:sessionId/agents/:agentId/model-override
DELETE /api/agent/sessions/:sessionId/agents/:agentId/model-override
```

- GET 返回该 Session 下可回显的覆盖与有效模型状态；
- PUT/DELETE 返回操作后的有效模型状态，不使用空 `204`；
- PUT/DELETE body 必须携带 `workspaceId`，并由服务端校验 Session 归属；
- 首版多窗口并发采用数据库提交顺序的 last-write-wins，不新增 revision。

## 文档结构与阅读顺序

| 文件 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、现状、目标、范围、非目标、关键决策与取舍 |
| [02-product-and-business.md](./02-product-and-business.md) | 业务规则、UI 合同、交互流程、状态矩阵和边界场景 |
| [03-technical-design.md](./03-technical-design.md) | 实体、数据库、契约、接口、优先级、前后端与 Worker 链路 |
| [04-implementation-plan.md](./04-implementation-plan.md) | 开发任务拆分、详细步骤、依赖顺序、门禁和回滚策略 |
| [05-validation-checklist.md](./05-validation-checklist.md) | 测试矩阵、验收标准、开发核对清单和代码审查清单 |
| [06-code-reference.md](./06-code-reference.md) | 当前代码事实、关键文件、函数和调用链地图 |

建议阅读顺序：

```text
00-README
  → 01-overview
  → 02-product-and-business
  → 03-technical-design
  → 06-code-reference
  → 04-implementation-plan
  → 05-validation-checklist
```

## 规范性用语

- “必须”：实现、代码审查、测试和验收均不得偏离。
- “不得”：禁止通过临时兼容、前端猜测或静默降级绕过。
- “建议”：命名和组织可按仓库风格微调，但不得改变冻结语义。
- 代码行号基于文档编写时仓库状态；实施前必须复核。路径与函数名是主要依据，行号仅辅助定位。

## 完成定义

只有同时满足以下条件，需求才算完成：

- Session-Agent 覆盖已服务端持久化并有数据库级唯一键；
- 工具 Tab 不再调用全局 `updateAgentSettings()` 修改模型；
- 保存、重置、刷新回显和草稿 Session 流程符合产品合同；
- UI 有效模型与服务端实际创建 Run 的模型一致；
- 新 Run 使用覆盖或默认并将结果固化到 `agent_run`；
- 已有 Run 和运行中的 Worker 不被新配置影响；
- vision/compaction runtime 配置、Fork/Subtask 边界未被扩大；
- Shared、API Store/Application/Routes、Web 和 Worker/API 集成测试通过；
- [05-validation-checklist.md](./05-validation-checklist.md) 中阻断级验收项全部通过；
- 独立代码审查通过；审查问题修复后完成独立复审。