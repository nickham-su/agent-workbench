# Agent 消息模型重构

> 状态：详细设计基线
> 目标：用 `Message + Part + ToolExecution` 替换当前扁平 `ContextItem` 模型，并统一 Fork、回退、压缩、归档与模型请求重建语义。
> 适用范围：`apps/api`、`apps/agent-worker`、`apps/web`、`packages/shared`、SQLite 持久化与内部 Worker 契约。
> 约束：本方案为破坏性数据升级方案；不迁移旧 Agent 消息、旧归档日志和旧 ContextItem 会话数据。

## 快速结论

当前扁平 ContextItem 已经能在请求模型前临时拼出：

```text
assistant(text + tool-call[])
tool(tool-result[])
```

但这种层级关系没有持久化，调用与结果关系依赖 `runId + turnId + step + 相邻位置` 推断。本方案将直接持久化领域模型：

```text
Session
  └─ headMessageId
  └─ contextRootMessageId
  └─ revision

Message（共享、单父、终态不可变）
  └─ Part[]
      ├─ TextPart
      ├─ ReasoningPart
      ├─ ImagePart
      └─ ToolCallPart
          └─ ToolExecution
```

 Fork、回退、压缩、归档查询与模型请求都由这组关系投影生成，不再依赖扁平相邻推断。

## 决策摘要

| 主题 | 决策 |
|---|---|
| 权威模型 | `Message + Part + ToolExecution` |
| ToolResult | 不建模为独立 Message，也不建 `tool_call_return` Part |
| ToolExecution 关联 | `ToolExecution.callPartId` 唯一关联 `ToolCallPart.id` |
| Reasoning | 完整保存、前端展示、永不回传、不压缩、不进 FTS |
| 模型异常 | 所有模型异常持续退避重试；错误通过现有运行提示暴露给用户；用户可终止 |
| 自动重试 | 无有效输出时保留空 Assistant 重试；已产生部分输出时 `superseded` 旧尝试并用 `replacesMessageId` 创建新尝试 |
| Worker 崩溃 | 自动恢复运行：空 Assistant 重试，有内容 Assistant 作废重建，queued 工具执行，running 工具转 unknown |
| 工具未知结果 | `unknown` 不是重新执行状态，而是终态工具结果，由模型判断 |
| Fork | 不复制历史 Message/Part/ToolExecution；只创建新 Session 指针 |
| 回退 | 只移动当前 Session Head；不撤销工作区副作用 |
| 压缩 | 只修改当前 Session `contextRootMessageId`；不修改共享 Message |
| 归档 | 删除文件归档与 `rg`；改为 SQLite `archive_read` + FTS5 `trigram archive_search` |
| Clear | 完整移除 |
| 旧数据 | 升级时清理旧 Agent 消息/归档数据，不迁移 |
| GC | 本期不做共享 Message 垃圾回收 |

## 文档导航

| 文件 | 用途 |
|---|---|
| [01-background-and-current-state.md](./01-background-and-current-state.md) | 需求背景、现状、问题与改造收益 |
| [02-product-contract-and-decisions.md](./02-product-contract-and-decisions.md) | 产品承诺、边界、关键取舍与决策冻结 |
| [03-domain-model-and-state-machines.md](./03-domain-model-and-state-machines.md) | 实体、状态机、关键不变量与边界行为 |
| [04-technical-design.md](./04-technical-design.md) | 数据表、事务、并发、API、SQL、运行流程、恢复提示与升级方案 |
| [05-code-map-and-migration-map.md](./05-code-map-and-migration-map.md) | 当前代码地图、改造点与任务拆分依据 |
| [06-testing-and-acceptance.md](./06-testing-and-acceptance.md) | 测试矩阵、验收标准、升级与回滚检查 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 分阶段实施步骤、开发任务拆分与检查清单 |

## 升级口径

- 代码部署前或首次启动时直接删除旧 Agent 消息、运行、归档和 ContextItem 相关数据。
- 部署脚本必须在以下两种策略中明确选择一种并写入迁移说明：仅清理 Agent 历史数据；或重置整个 `.data` 后重建。不得隐式混用。
- 不做双写，不做 Legacy Adapter，不做历史会话只读兼容。

## 验收提醒

- 文档中的运行状态由 `session_run_state` 权威管理，不归 Session 表重复保存。
- 归档 FTS 不保存 `session_id`，必须与指定 Session 的归档祖先链求交。
- 工具结果本期沿用 `AgentToolOutput` 的最小迁移规则，不重新设计模型投影。
- 用户终止时 streaming Assistant 一律 `cancelled`；`superseded` 只用于自动重试替代。
- Compaction 中间摘要不落库，成功后直接创建 completed Compaction Message 并切换 Head/contextRoot。
- ImagePart 直接通过 Part 表关联附件，一图一个 Part。
- archive cursor 不绑定 revision，只在 `contextRoot` 变化后失效。
