# 后续治理建议

本文内容均为本轮明确后置项，不属于一期完成条件。开发不得因为“顺手”将其混入控制面 RPC 最小修复。

## Worker 在线 Lease / Watchdog

### 问题

本轮可以让 Worker Promise 有界返回，但以下场景仍可能留下 stale `running`：

- `completeRun` 时 API 完全不可达；
- worker 子进程 crash/OOM kill；
- worker 被 process manager 重启，但 API 主进程未重启；
- 工具本体或事件循环卡死，未进入控制面 RPC timeout。

### 建议方向

后续独立设计：

- run execution lease；
- worker instance identity；
- heartbeat/progress timestamp；
- API 周期扫描过期 lease；
- 终态收敛与 late write fence；
- nested subtask tree 的父子回收语义；
- worker restart 后的在线 reconciliation。

必须先设计状态机和 race，不应仅按 `updatedAt` 超时直接 fail。

## Outer AbortSignal 合并

### 问题

一期不透传 run signal，所以用户取消后，一个正在进行的 Worker → API 请求可能继续等待到自身 timeout。

### 建议方向

以下条目是完成 outer signal 透传与合并后的未来合同，不是一期实现要求或验收断言：

- `AgentApiClient.request()` 接受 optional outer signal；
- 使用 `AbortSignal.any()` 或兼容 helper 合并 outer signal 与 timeout signal；
- 明确 abort cause；
- 用户取消优先于 timeout；
- retry sleep 可取消；
- 取消后不得发下一 attempt；
- 调用点分批迁移，避免一次改遍所有 provider/manager。

需要独立测试取消/timeout 同时发生的确定性顺序。

## 工具级 Timeout 策略

### 问题

plugin/MCP、bash、文件系统或外部进程可能合法长执行，也可能 hang，不能套控制面 15 秒。

### 建议方向

按工具能力分类：

- `bash`：已有/增强命令 timeout、进程组终止；
- plugin/MCP：provider/server 级 timeout 与 cancel；
- `subtask`：总 deadline 与 status 单次 RPC 分离；
- 文件工具：只对特殊文件系统 I/O 建立诊断，不默认短 timeout；
- `apply_patch`：保护原子性与 repair attempt；
- 工具状态写回：明确“执行成功但结果写回未知”的恢复语义。

不得通过整体重跑 tool batch 解决。

## Response 体积与解析保护

AbortController 不能抢占已经开始的同步 JSON 解析。若未来控制面 response 体积持续增长，应独立治理：

- body size limit；
- Content-Length 预检；
- streaming/capped reader；
- prompt/context contract 的体积指标；
- 超大 response 诊断与拒绝语义。

该治理可能影响业务合同，不应混入 timeout 最小修复。

## 通用 Internal RPC 基础设施

当 API → Worker、Worker → API、Plugin Host 多条链路都需要统一治理时，再评估：

- shared policy/error/diagnostic primitives；
- request id/trace id；
- retry budget；
- metrics；
- circuit breaker；
- per-endpoint SLA。

本轮不抽象的原因是当前仅一个 client 入口，提前平台化会扩大改动和审查面。

## Metrics 与可观测性

在日志稳定后，可增加：

- `agent_internal_rpc_attempt_total`；
- `agent_internal_rpc_timeout_total`；
- `agent_internal_rpc_retry_total`；
- `agent_internal_rpc_duration_ms`；
- endpoint/policy/reason 低基数字段；
- worker restart count；
- stale running age distribution。

指标不得包含 session/run/workspace 高基数标识或敏感 payload。

## Timeout 默认值校准

一期默认 15s/5s 是保守最小修复。上线后应基于日志/metrics 评估：

- endpoint p95/p99；
- retry recovered 比例；
- false timeout；
- completeRun 失败率；
- API 故障期放大量。

调整默认值必须走配置/产品合同评审，不得让运维用 `0` 关闭保护。

## Stale Running 运维工具

在 watchdog 完成前，可独立设计受控诊断/人工处理：

- 列出长期 running run；
- 展示 activeRunId、最后 item/status、worker restart evidence；
- 人工 fail/cancel 前二次确认；
- 不直接删除 run/context；
- 保留审计记录。

该工具不得作为本轮验收依赖。

## Worker Crash / OOM 诊断

建议后续增加：

- worker exit code/signal 的结构化日志；
- process manager restart attempt/ready event；
- worker pid/instance id；
- 容器 OOMKilled / cgroup memory evidence 指引；
- 关键内存指标；
- crash 前 active run 摘要（不含 prompt/payload）。

目标是区分：

```text
RPC timeout
工具 hang
worker exit/OOM
API/container restart
```

本轮新增 RPC diagnostics 后，如果复现时没有对应 timeout/retry 日志，应优先进入该诊断方向。
