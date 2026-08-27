# 关键决策、取舍与暂停条件

## 决策总表

| 编号 | 决策 | 本轮规范 |
|---|---|---|
| D-1 | 问题边界 | 只治理 Worker → API 控制面 RPC 无限 pending |
| D-2 | 实现入口 | timeout/retry/diagnostics 集中在 `AgentApiClient.request()` |
| D-3 | 方法绑定 | 每个 public client 方法必须显式选择命名 policy，不设隐式无限等待默认值 |
| D-4 | 读类策略 | 15s，最多 retry 1 次，固定退避 300ms |
| D-5 | 普通写策略 | 15s，0 次自动 retry |
| D-6 | subtask start | 15s，最多 retry 1 次，依赖 parent tool 幂等/复用语义 |
| D-7 | run complete | 5s，最多 retry 1 次，依赖终态幂等；保留 runner 现有 fallback |
| D-8 | retry 原因 | 仅 timeout、network、502、503、504 |
| D-9 | HTTP/body 分类 | 已知非 2xx status 优先；502/503/504 可 retry，其他 status 不 retry；错误 body 失败/挂起不改变 status 分类 |
| D-10 | timeout 生命周期 | 覆盖 fetch、响应头、body 消费与 JSON 解析完成前的整个 attempt |
| D-11 | 工具循环 | 不整体 retry `executePendingTools`、tool batch 或 run while |
| D-12 | 工具执行 | plugin/MCP 实际执行、archive、git-env、工具本体全部排除 |
| D-13 | 取消 | 一期 helper 不接收 outer signal，不保证取消阻止 retry；只保证无真实取消时 timeout 不误判为 cancelled |
| D-14 | 配置 | `loadWorkerEnv()` 是唯一默认值权威；Compose 只透传；两个值均为正整数且不允许 `0` |
| D-15 | 错误与日志安全 | diagnostics 与向上抛出的 error message/字段都只含安全元数据 |
| D-16 | 产品承诺 | 执行有界、槽位可释放、日志可诊断；不承诺消除所有 stale running |
| D-17 | 架构范围 | 不引入通用 RPC 框架、watchdog、lease、数据库迁移或状态机重构 |

## 请求分类与策略矩阵

| `AgentApiClient` 方法 | 类别 | Policy | timeout | retry | 安全依据/原因 |
|---|---|---|---:|---:|---|
| `getExecutionProfile` | 控制面读 | `controlRead` | 15s | 1 | 幂等读取 |
| `getPromptContext` | 控制面读 | `controlRead` | 15s | 1 | 幂等读取；主循环高嫌疑点 |
| `getMessagesContext` | 控制面读 | `controlRead` | 15s | 1 | 幂等组装，不写 context item |
| `getSubtaskPreforkPlan` | 控制面读 | `controlRead` | 15s | 1 | 幂等规划读取 |
| `getSubtaskStatus` | 控制面读 | `controlRead` | 15s | 1 | 幂等状态查询 |
| `getSubtaskResult` | 控制面读 | `controlRead` | 15s | 1 | 幂等结果查询 |
| `getAgentMcpSettings` | 控制面读 | `controlRead` | 15s | 1 | API `getAgentMcpSettings()` 配置快照读取，不连接/执行 MCP server |
| `getPluginRuntimeSnapshots` | 控制面读 | `controlRead` | 15s | 1 | API `listPluginRuntimeSnapshots()` 快照读取，不执行 plugin tool |
| `listPluginTools` | 控制面读 | `controlRead` | 15s | 1 | plugin-host `listTools` 只读发现，已有 4s 下游 timeout，不调用 execute |
| `createContextItem` | 普通控制面写 | `controlWrite` | 15s | 0 | response 丢失时重复 create 有副作用 |
| `updateContextItem` | 普通控制面写 | `controlWrite` | 15s | 0 | 状态写回；不依赖隐式幂等重试 |
| `updateRunState` | 普通控制面写 | `controlWrite` | 15s | 0 | 状态竞争风险 |
| `compactContext` | 普通控制面写 | `controlWrite` | 15s | 0 | compaction 有持久化副作用 |
| `startSubtaskRun` | 特殊写 | `subtaskStart` | 15s | 1 | parent tool 唯一性、existing reuse、winner 回查 |
| `completeRun` | 特殊写 | `runComplete` | 5s | 1 | terminal no-op、event 只在首次有效收敛发布 |
| `executePluginTool` | 工具实际执行 | `toolExecution`/保持现状 | 本轮不加 | 0 | 合法长执行且有副作用，明确排除 |
| `archiveSearch` | 工具执行 | 保持现状 | 本轮不加 | 0 | 工具读取边界，明确排除 |
| `archiveRead` | 工具执行 | 保持现状 | 本轮不加 | 0 | 工具读取边界，明确排除 |
| `prepareGitEnvForBash` | bash 辅助 | 保持现状 | 沿用自身参数 | 0 | lease/命令边界不同 |
| `cleanupGitEnvLease` | bash 辅助 | 保持现状 | 本轮不加 | 0 | 清理语义不同，不自动重试 |

`AgentApiClient` 当前还可能承载未来新增方法。新增方法不得自动继承 `controlRead`；开发必须在代码审查中给出分类、安全依据和测试。

以上三项外围读取的分类是本文已复核并冻结的开发基线，不是留给 P0 自由选择的建议。P0 只确认相应调用仍与代码地图一致；若实施前代码已发生实质变化，必须暂停并更新本文，而不是在实现中临场重分类。

## 取舍说明

### 集中在 `AgentApiClient.request()`

所有高嫌疑控制面调用都汇聚到该 helper。在单点实现可以：

- 统一 timeout 生命周期；
- 统一 retry 判定；
- 统一日志脱敏；
- 避免在 `runner.ts`、builtin provider、registry 中重复实现；
- 保持现有工具循环和生命周期 catch 不变。

但“集中实现”不等于“所有方法同策略”。public 方法必须显式传 policy，否则未来新增有副作用方法可能被错误重试。

### 不给整个工具循环重试

工具循环包含不可重入副作用：

- `bash` 可能重复执行命令；
- `write`/`apply_patch` 可能重复写文件；
- `subtask` 可能重复创建或等待 child；
- plugin/MCP 可能调用外部系统。

整体 retry 无法区分“工具未执行”与“工具已执行但响应丢失”。本轮只重试经过逐项证明安全的 RPC。

### 读类最多重试一次

一次 retry 足以吸收短暂网络/API 抖动，同时将最坏等待控制在约 30.3 秒。两次 retry 会将单点等待推高到约 45.6 秒，并放大 API 故障期请求量，不符合最小修复。

### 普通写不自动重试

请求 timeout 后存在提交不确定性：

```text
服务端可能未收到
服务端可能正在执行
服务端可能已提交但响应丢失
```

在没有 request idempotency key 或明确幂等合同前，自动 retry 普通写的风险高于收益。

### `startSubtaskRun` 例外

API 在创建前以 `workspaceId + parentRunId + parentToolItemId` 查询 existing child；唯一竞争后回查 winner；reused response 返回原 child identity。因此相同请求语义可安全做一次 retry。

该决策依赖现有业务合同，不是因为所有 POST 都可重试。

### `completeRun` 例外

API persistence 对已 terminal run 返回 no-op，application 只在首次有效完成时清 cache 并发布 event。因此首次成功但响应丢失后的第二次提交不会重复改变终态或发布事件。

保留 runner 现有 fallback 的原因：它不仅是网络 retry，也负责在不同异常路径尝试提交目标终态。client-level retry 和 runner-level fallback 语义不同，不在本轮合并重构。

代价是最坏可能有四次网络 attempt，约 20.6 秒。该上限必须测试和记录，不得再增加额外 retry 层。

### HTTP 500 不重试

HTTP 500 更可能代表确定性服务端缺陷或事务错误；自动重试可能重复放大副作用。只有网关/临时不可用语义明确的 502/503/504 纳入 retry。

### 已知 HTTP status 优先于错误 body

收到非 `2xx` 响应头后，status 已是确定协议结果。错误 body 只用于在同一 timeout 内完成消费并被丢弃，不再参与错误 message 或 retry 分类，也不做 JSON 解析。因此：

- `502/503/504` 的 body 读取立即失败或一直挂到 timer 触发，仍按对应 HTTP reason retry；
- 其他非 `2xx` status 的 body 读取失败或挂起，仍按该不可重试 status 立即结束 attempt 且不发下一 attempt；
- 只有响应头前没有已知非 `2xx` status，或 `2xx` success body 挂起，timer 才产生 `timeout` retry reason。

这避免错误 body 的可读性改变请求的 retry 语义，也避免将明确的 4xx/500 因 body 慢而伪装成 timeout retry。

### Timeout 使用自有错误类型

原生 fetch timeout 通常表现为 `AbortError`，而 runner 当前会把 abort-like error 视为用户取消。如果直接上抛，会把 RPC timeout 错误记为 cancelled。因此必须转换成不含 abort 语义的项目自有 timeout 错误。

### 一期不透传 outer signal

全量透传 run `AbortSignal` 会修改多个 public 方法和调用层，扩大最小修复范围。接受的代价是：用户取消后，一个已发出的内部 RPC 最迟等待到自身 timeout，而不是立即中断。

更严格地说，`AgentApiClient.request()` 在一期看不到执行期间发生的用户取消，所以一个 retry-eligible attempt 失败后仍可能等待 300ms 并发出第二个 attempt。单次 attempt 最迟在 policy timeout 内结束，整个 public RPC 调用仍按 policy 的最大 attempts 有界；只有 request 返回/抛错后，runner 才观察 outer signal。无真实用户取消时，timeout 不得误判为 cancelled。取消立即阻断 retry 的更强合同后置。

### 配置不允许 0

`0` 若代表禁用 timeout，会重新引入无限 pending，与本轮目标冲突。非法值必须在 worker 启动时失败，不得静默回退为无限等待。

### 不承诺自动清除 stale running

如果 API 完全不可达，`completeRun` 最终也会失败。timeout 能保证 Worker Promise 返回和槽位释放，但不能在无 API/DB 通道时收敛持久化状态。解决该问题需要在线 lease/watchdog，不属于本轮。

## 已接受风险

- 用户取消不能立即中断已发出的 Worker → API 请求；
- 用户取消可能无法阻止尚未开始的第二个 attempt，因为一期 retry helper 不接收 outer signal；
- timeout 发生时服务端是否已提交普通写可能未知；
- `completeRun` 全部 attempt 失败后数据库可能残留 running；
- API 在故障窗口内可能收到读类重复请求；
- `startSubtaskRun` retry 强依赖现有 parent tool 唯一/复用语义；
- 15 秒可能对极端慢 API 造成误失败，先以可配置项和日志观察；
- 同步 JSON 解析一旦阻塞事件循环，AbortController 不能抢占；本轮不做 response 体积治理；
- 工具本体、worker crash/OOM 仍可产生相似症状。

## 不采用的方案

- 给整个 run/工具循环包一个总 timeout 后整体重跑；
- 所有 `POST` 一律不 retry，放弃 `startSubtaskRun/completeRun` 的已有幂等收益；
- 所有 Worker → API 方法一律 15 秒；
- 所有内部 RPC 一律 retry；
- 将 HTTP 500 纳入自动 retry；
- 用 `Promise.race()` 只返回 timeout、但不 abort 底层 fetch；
- 收到响应头后立即清 timeout；
- 直接将原生 `AbortError` 上抛；
- 使用错误文本模糊匹配区分所有网络/业务错误；
- 在日志打印 body 以方便排障；
- 用本轮顺手实现 worker watchdog/lease；
- 复用模型 timeout 配置作为内部 RPC timeout；
- 允许 timeout 配置为 0。

## 实施前必须暂停的冲突

遇到以下任一情况，停止当前批次并更新设计/测试：

- `AgentApiClient.request()` 已被其他分支改造，本文调用结构不再成立；
- 某个纳入方法实际执行了未记录的外部副作用；
- `startSubtaskRun` 不再以 parent tool identity 去重，或 retry 可能创建第二个 child；
- `completeRunFromWorker` 不再 terminal-idempotent，或重复调用会重复发布 event；
- runner 的 terminal fallback 次数已变化；
- runner 的 abort-like 判定已变化，timeout 错误仍可能被视为 cancelled；
- Docker Compose 配置传播方式已变化；
- 15s/5s 与生产环境已冻结的外部 SLA 冲突；
- 测试无法确定性模拟 body hang、timeout 或响应丢失，只能依靠长时间 sleep；
- 为实现本方案必须修改数据库 schema 或工具业务逻辑。

## 开发中必须请示或重新评审的情况

- 希望新增 retry 次数或修改 300ms 退避；
- 希望将其他 endpoint 纳入 `controlRead/controlWrite`；
- 希望对 `executePluginTool` 或 archive/git-env 套 policy；
- 希望透传 outer signal 并改变取消语义；
- 希望在 timeout 后将 run 直接标 cancelled；
- 希望删除 runner 现有 fallback；
- 希望对普通写自动 retry。
