# 后续建议（不属于本轮实施范围）

> 本文件只记录本轮明确排除、但调研确认存在价值的后续方向。任何方向都需要独立范围、设计、测试和审查，不得以“顺手优化”混入本轮。

## Read-side 后续批次

### Archive read-side

`archive/search` 与 `archive/read` 是工具读取接口，具有 offset、lineCount、maxChars、文件系统稳定性和 noArchive 语义。本轮只处理 compaction rollback sidecar，不统一这两个接口的 shared contract。后续若迁移，必须单独冻结：

- beforePos/lineCount/maxChars 边界；
- 搜索结果排序与 pos 语义；
- 文件缺失/空 archive；
- sensitive archive 内容的日志边界；
- response body size 与分页策略。

### Plugin/MCP/Git read-side

`plugins/*`、`mcp-settings`、`git-env/*` 的 payload 和生命周期分别涉及动态 plugin host、MCP config、git lease。后续应按业务域拆批，不能复制三主链接口的 schema 假设。

## 生命周期后续治理

### 执行线性化

如果 DB fence 仍无法满足实际需求，可单独评估：

- run generation/epoch；
- cancel fence token；
- lease/heartbeat；
- durable lineage event；
- recovery reconciliation；
- Worker 写回携带 generation。

进入条件是出现可复现的“runtime 继续执行造成实际数据或资源问题”，而不是仅有理论 race。

### 完整 nested recovery

当前 Worker 重启后不恢复内存中的 nested parent/child mapping。后续若需要完整恢复，必须先定义：

- runtime tree 的 durable 表示；
- parent/child enqueue 顺序；
- cancel propagation；
- child 已 terminal/parent 已 cancel 的 reconciliation；
- 防重复 enqueue 的 identity/lease。

不得把当前 DB active run 独立 enqueue 描述成完整 nested recovery。

### Subtask orphan 深度治理

本轮只治理空壳 session。若发现有 run/item 的 orphan，需要单独设计：

- orphan 标记而非删除；
- parent lineage repair；
- 用户可见性；
- existing reuse 安全；
- session/run 归档策略。

### Archive 强一致性

sidecar 只能处理 snapshot 尺寸仍可证明安全的回滚。若需要处理文件已被外部追加、部分写入或跨进程并发，应单独评估：

- staging；
- content-addressed archive；
- 可重放操作日志；
- outbox；
- 文件与 DB 的 reconciliation 状态表。

不得在本轮直接扩大事务边界或改变 archive 格式。

## 错误与响应治理

后续可评估：

- 非 2xx response 的结构化 `code/message` 解析；
- 哪些错误码可供 Worker 分支；
- conflict retry 的预算与取消语义；
- strict 模式长期稳定后删除 warn 配置；
- 敏感字段统一日志脱敏工具。

这些事项必须与本轮 raw-body/error 基线分开，不能为了 read-side contract 迁移而顺手重做。

## 工程结构治理

在 read-side 和 lifecycle 稳定后，再基于依赖方向评估：

- `AgentService` 按 run/context/subtask/recovery 拆分；
- shared contract 规模是否需要独立 workspace；
- Worker/Plugin Host transport/process lifecycle 是否存在稳定重复；
- 测试 fixture、fake runtime、clock/seam 是否需要公共测试层。

## 非建议项

以下不因本轮改造自动进入下一阶段：

- 全局统一 body limit；
- 全量 tool result 深 schema；
- 所有 endpoint 版本化；
- 全仓错误 envelope；
- 所有 transport 的 timeout/retry；
- 数据库结构重建；
- 全部模块机械拆文件。
