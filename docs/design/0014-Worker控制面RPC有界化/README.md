# Worker 控制面 RPC 有界化

> 状态：详细设计基线，已按独立审查报告修订，面向开发实施、独立代码审查、自动测试、手工验收和后续维护。
> 范围：对 Agent Worker → API 的控制面内部 RPC 增加端到端 timeout、受控 retry 和有限 diagnostics，消除该边界的无限 pending。
> 前提：现有 Worker 主循环、工具执行、Provider 模型超时、run lifecycle、subtask lineage 和 API → Worker 协议均保持现状；本文只在明确列出的 Worker → API 请求边界内做最小修复。

## 快速结论

本轮只解决一个问题：

```text
Worker → API 控制面请求可能永久 pending
  → processRun 无法进入现有 catch/finally
  → run/session 长期保持 running
  → Worker 并发槽无法释放
  → UI 持续 loading，Provider 侧没有新请求
```

最小修复固定为：

```text
控制面 RPC 显式选择策略
  → 端到端 timeout
  → 仅安全请求有限 retry
  → 异常路径有限 diagnostics
  → 最终失败进入现有 runner catch / finishOnce
```

不得改成：

```text
整个工具循环超时后整体重跑
整个 pending tools 批次失败后整体重跑
对所有内部 RPC 或所有工具一刀切 15 秒
通过 watchdog/lease 顺手解决所有 stale running
```

## 冻结策略摘要

| 请求类别 | 单次 timeout | 自动重试 | 固定退避 |
|---|---:|---:|---:|
| 读类控制面 RPC | 15 秒 | 最多 1 次 | 300ms |
| 普通写类控制面 RPC | 15 秒 | 0 次 | 不适用 |
| `startSubtaskRun` | 15 秒 | 最多 1 次 | 300ms |
| `completeRun` | 5 秒 | 最多 1 次 | 300ms |

只允许在以下失败上重试：

- timeout；
- 网络连接/传输错误；
- HTTP `502`、`503`、`504`。

分类优先级冻结为：一旦已收到非 `2xx` HTTP status，status 是该 attempt 的权威分类；错误 body 只在同一 timeout 内读取并丢弃，不参与分类，也不解析 JSON。已知 `502/503/504` 时，即使错误 body 读取失败或挂到 timer 触发，仍分别按 `http_502/http_503/http_504` 判定 retry；其他已知非 `2xx` status 即使 body 读取失败或挂起也不得 retry。只有未取得非 `2xx` status，或 `2xx` success body 挂起到 timer 触发时，才按 `timeout` 分类。

以下失败不得重试；其中“JSON 读取或解析错误”只指 `2xx` success body：

- HTTP `4xx`，包括 `409`；
- HTTP `500`；
- 其他非 `502/503/504` 的非 `2xx` status；
- `2xx` success body 读取失败或 JSON 解析错误；
- response schema mismatch；
- `ApiConflictError`；
- 其他确定性业务错误。

## 本轮纳入

### 读类控制面

- `getExecutionProfile`；
- `getPromptContext`；
- `getMessagesContext`；
- `getSubtaskPreforkPlan`；
- `getSubtaskStatus`；
- `getSubtaskResult`；
- `getAgentMcpSettings`；
- `getPluginRuntimeSnapshots`；
- `listPluginTools`。

上述三项外围读取已按当前代码冻结为控制面读：MCP settings 和 plugin runtime snapshots 只读取 API 侧配置/快照；`listPluginTools` 只调用 plugin-host 的只读工具发现接口，不执行工具。`executePluginTool` 仍明确排除。实施前只需确认代码未偏离该基线，不允许开发自行重分类。

### 写类控制面

- `createContextItem`；
- `updateContextItem`；
- `updateRunState`；
- `compactContext`；
- `startSubtaskRun`；
- `completeRun`。

`startSubtaskRun` 和 `completeRun` 是特殊可重试写；其安全依据和约束见 [03-decisions.md](./03-decisions.md) 与 [04-technical-design.md](./04-technical-design.md)。

## 明确排除

以下事项不得作为顺手优化混入本轮：

- 整个工具循环、`executePendingTools()` 或工具批次的整体重试；
- plugin/MCP 实际工具执行的统一 timeout；
- `executePluginTool` 的控制面策略套用；
- `archiveSearch`、`archiveRead`；
- `prepareGitEnvForBash`、`cleanupGitEnvLease`；
- `read`、`write`、`apply_patch`、`bash` 等工具本体 hang；
- 文件系统、FUSE、网络盘、子进程或 shell 命令的通用 timeout；
- Provider 模型 timeout/retry 语义变更；
- API → Worker timeout 语义变更；
- worker crash、OOM kill、worker 自动重启后的 stale running 回收；
- run heartbeat、lease、watchdog、在线 recovery；
- 数据库 schema 或 run 状态机重构；
- 通用 RPC 框架、全局 retry 中间件、熔断器或 outbox。

## 产品承诺边界

一期必须承诺：

- 纳入范围的控制面 RPC 不再无限 pending；
- 单次执行等待时间有明确上限；
- 最终失败可以进入现有异常收敛链，Worker 执行 Promise 有机会结束；
- Worker 并发槽不再因该类无限等待永久占用；
- 日志能够回答 endpoint、attempt、timeout、耗时、重试原因与最终结果。

一期不得承诺：

- 所有 stale `running` 都会自动变为 `idle/failed`；
- `completeRun` 在 API 完全不可达时仍能保证数据库收敛；
- 工具本体永不 hang；
- worker 子进程退出后旧 run 自动回收；
- 用户取消可以在一期内立即中断任意正在进行的 Worker → API 请求。
- 用户取消后本次 `AgentApiClient.request()` 一定停止 retry；一期 helper 不接收 outer signal，实际取消可能在当前 attempt、300ms 退避和第二个 attempt 之后才被 runner 观察。
- 全面治理上游 raw error logging；但本轮必须保证从 `AgentApiClient.request()` 逃逸的错误对象 message/字段本身已经是安全元数据级，因此现有上游日志即使打印 error 也不得泄漏 request/response payload。

## 阅读路径

| 文件 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、现象、根因、端到端链路、目标、范围和非目标 |
| [02-product-contract.md](./02-product-contract.md) | 用户可观察行为、故障合同、运维合同、取消与超时优先级 |
| [03-decisions.md](./03-decisions.md) | 冻结决策、请求策略矩阵、取舍、风险、不采用方案和暂停条件 |
| [04-technical-design.md](./04-technical-design.md) | 策略/错误实体、端到端 timeout、retry、日志、配置与调用链设计 |
| [05-code-map.md](./05-code-map.md) | 现有代码引用、关键类/函数、调用路径和授权改动边界 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、代码审查清单、验收、回归和回滚标准 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 开发任务拆分、详细实施步骤、独立审查与复审门禁 |
| [08-follow-up-recommendations.md](./08-follow-up-recommendations.md) | 工具级 timeout、worker lease/watchdog 等明确后置项 |

## 规范性约定

- “必须”表示开发、审查和验收要求；“不得”表示禁止范围；“保持现状”表示以实施前实际代码与冻结测试为准。
- 本目录中的策略矩阵是规范性合同。开发不得自行扩大或缩小 endpoint 范围、timeout、重试次数、重试条件。
- 本目录是设计基线，不是生产代码。代码路径与行号均为调研定位，实施前必须复核。
- 如果实施前代码与本文基线不一致，必须暂停对应批次，更新代码地图、决策、测试证据后再编码。
- 若发现某个被标记为“可重试”的写请求不再具备本文冻结的幂等条件，必须取消其自动重试并重新评审，不得凭经验继续实现。

## 完成定义

本轮只有在以下条件同时满足时才算完成：

- 每个纳入范围的 `AgentApiClient` 方法显式绑定命名策略；
- timeout 覆盖建连、响应头、body 读取和 JSON 解析的完整生命周期；
- retry 次数、条件和退避与本文一致；
- 已知非 `2xx` status 与 body 问题的分类优先级和本文一致；
- 普通写、工具执行和排除项未被误重试或误套 timeout；
- timeout、retry、recovered、failed 日志以及向上抛出的 error message/字段满足敏感信息约束；
- timeout 默认值只在 Worker `loadWorkerEnv()` 定义，Compose 仅透传变量，不建立第二套默认；
- 配置可在源码启动与 Docker Compose 部署中生效；
- 单元测试、必要集成测试、typecheck/build 和相关 runner/subtask/lifecycle 回归通过；
- 代码经过独立审查，问题修复后完成独立复审；
- 验收结论准确表述为“控制面执行有界”，不得夸大为“消除所有 stale running”。
