# 背景、问题与方案总览

## 需求背景

Agent Workbench 的 Agent 执行由 API 与 Agent Worker 协作完成：

```text
浏览器
  → API 激活 run，并将 run/session 状态持久化为 running
  → API 将 run enqueue 给 agent-worker
  → agent-worker 通过 Worker → API 内部 RPC 获取配置/上下文、写回 item/run 状态
  → agent-worker 调用 Provider 或执行工具
  → agent-worker 通过 completeRun 收敛终态
```

Docker 默认部署中，容器主进程启动 API；API 通过 `AgentWorkerProcessManager` 拉起独立 `agent-worker` 子进程。worker 意外退出时，API 会自动重启 worker，但 worker 子进程重启本身不会触发 API startup recovery。

用户已多次观察到以下故障组合：

- session 状态长期保持 `running`；
- session tab 的 loading 图标持续旋转；
- 前端刷新后现象仍存在；
- Provider 请求日志没有新请求；
- 模型请求 timeout/retry 没有触发；
- 多次在子任务执行中发现，但不能证明只发生于子任务；
- 最近一次最后可见工具是 `write`，并显示 `[xxx bytes]`。

`write(path)[xxx bytes]` 由前端 `AgentWriteCard` 根据 context item 的 completed result 渲染。该证据说明 `write` 本体已经返回，并且包含 `bytesWritten` 的完成结果已经被 API 持久化并被前端读取。故障更可能发生在工具完成后的下一轮控制面推进，例如 `getPromptContext`、run-state 更新、子任务 status/result 查询，而不是 `write` 本体。

## 现状根因

### `running` 在 Provider 请求前已持久化

主 run 与 child run 在 activation 阶段即写入：

```text
agent run record.status = running
session run-state.status = running
```

该状态表示 run 已激活，不表示：

- Provider 请求已经发出；
- worker 协程仍在推进；
- 当前 await 一定会结束；
- 系统存在在线 watchdog。

终态依赖 worker 主动调用 `completeRun()`。因此，只要 worker 卡在某个 Promise 上且没有执行终态提交，数据库就会持续返回 `running`，前端刷新也只会再次读取同一个持久化状态。

### 现有 catch 无法处理无限 pending

`AgentRunner` 已有：

- 单工具执行异常捕获；
- `processRun()` 外层异常捕获；
- `finishOnce()` / `tryFinishOnce()` 终态提交；
- `startRun().finally()` 中的并发槽释放。

这些机制只能处理 Promise reject 或正常 settle，不能处理 Promise 永久 pending：

```text
await 永久不返回
  → 不进入 catch
  → 不进入 finishOnce
  → processRun 不 settle
  → finally 不执行
  → activeCount 不释放
```

### Worker → API 统一请求入口缺少 timeout/retry

`apps/agent-worker/src/runtime/apiClient.ts` 的 `AgentApiClient.request()` 当前使用裸 `fetch()`：

- 未传 `AbortSignal`；
- 未设置请求 timeout；
- 未设置 retry；
- `response.text()` / `response.json()` 也在同一无界等待链中。

所以以下任一阶段异常悬挂都可能无限等待：

```text
连接建立
等待响应头
读取响应 body
JSON 解析所依赖的完整 body 消费
```

### 模型 timeout 与本问题不在同一边界

模型 idle/total timeout 在 `runModelStep()` 内部围绕 `streamText()` 建立。只有执行进入 Provider 模型请求后，该机制才生效。

若执行停在：

- `getExecutionProfile`；
- `getPromptContext`；
- `updateContextItem`；
- `updateRunState`；
- `getSubtaskStatus`；
- `getSubtaskResult`；

则不会产生 Provider 请求，也不会触发模型 timeout/retry。因此本方案不修改模型 timeout 语义。

## 高概率故障链路

### 工具完成后的上下文读取挂起

```text
模型产生 write tool call
  → Worker 将 tool item 写为 running
  → runWriteTool 写文件并返回 bytesWritten
  → Worker 将 completed result 写回 API
  → 前端显示 write(path)[xxx bytes]
  → Worker 进入下一轮 while
  → await getPromptContext()
  → Worker → API fetch 永久 pending
  → Provider 无新请求
  → run/session 持续 running
```

### 子任务控制面挂起

```text
父任务执行 subtask
  → startSubtaskRun 激活 child run 为 running
  → 新 child 递归 processNestedRun，或 reused child 进入 status polling
  → child 的控制面 RPC 或父级 status/result RPC 永久 pending
  → child 不结束
  → 父任务同步等待 child
  → 父子任务都可能持续 running
```

子任务不是根因的唯一入口，但它增加了 prefork/start/status/result 等 RPC，并让父任务同步依赖 child 完成，因此更容易放大故障。

## Worker 退出与本方案的关系

worker 子进程意外退出也可以留下 stale `running`：

```text
worker 在 completeRun 前退出
  → API 数据库保留 running
  → AgentWorkerProcessManager 自动重启 worker
  → 后续新消息可由新 worker 正常执行
```

因此，“再次发送消息仍可执行”不能排除 worker 曾退出。但本方案不处理 worker crash/OOM：

- worker exit 有明确的 process manager 日志；
- worker restart 不调用 API startup recovery；
- 旧 run 在线回收需要 lease/watchdog/reconciliation；
- 这些属于后续治理，而非本次控制面 RPC 最小修复。

上线后若再次出现故障且没有任何 internal RPC timeout/retry 日志，应降低控制面 RPC 根因优先级，转查 worker exit、工具本体或事件循环/文件系统阻塞。

## 目标

### 功能目标

- 使纳入范围的 Worker → API 控制面 RPC 在明确时间上限内成功或失败；
- 将永久 pending 转换为可被现有 catch 处理的明确错误；
- 对可安全重试的短暂故障进行一次有限恢复；
- 保证最终失败后 `processRun()` 有机会结束并释放 Worker 并发槽；
- 保持正常请求、工具行为、Provider 行为和业务状态机不变。

### 诊断目标

异常日志必须能回答：

- 哪个 endpoint；
- 哪种策略；
- 当前第几次 attempt；
- 单次 timeout；
- 单次/总耗时；
- 失败原因分类；
- 是否重试；
- 重试后恢复还是最终失败。

### 安全目标

- 不在 diagnostics 或从 `AgentApiClient.request()` 逃逸的 error message/字段中包含请求 body、响应 body、prompt/context、tool args/result、token、凭据或内部鉴权信息，使现有上游 raw error log 打印该错误时仍保持安全；
- 不通过整体重试重复执行有副作用工具；
- 在 outer run signal 未实际 aborted 时，不将 timeout 错误误判为用户取消；
- 明确接受一期 helper 无法观察执行期间的用户取消，因此不承诺取消会阻止当前 attempt、300ms 退避或第二个 attempt。

## 范围

本期只改 Worker 客户端的控制面请求边界：

```text
AgentApiClient public method
  → 命名 RpcPolicy
  → AgentApiClient.request()
  → timeout/retry/diagnostics
  → 现有 API endpoint
```

请求逐项分类见 [03-decisions.md](./03-decisions.md)。

## 非目标

- 不修改工具循环或模型循环的业务结构；
- 不重跑整个 pending tool batch；
- 不为工具本体定义统一 timeout；
- 不修改模型 timeout/retry；
- 不修改 API → Worker timeout；
- 不实现 worker crash/OOM 检测和 run 在线回收；
- 不建立 heartbeat/lease/watchdog；
- 不保证 `completeRun` 在 API 完全不可达时成功；
- 不修改前端状态映射。

## 端到端方案

```text
AgentApiClient 方法显式选择策略
  → request 创建“请求级” AbortController
  → 启动单次 attempt timer
  → fetch + body 消费在同一 timer 下完成
  → 已知非 2xx status 优先于错误 body 读取结果决定分类
  → 2xx body/解析/校验错误按冻结规则处理
  → timeout/网络/502/503/504 按 policy 判定是否 retry
  → retry 前等待 300ms
  → helper 不接收 outer signal；执行期间发生的取消不保证阻止 retry，request 返回后由 runner 观察 signal
  → 最终失败抛出稳定错误
  → runner 现有 catch 尝试 completeRun(failed/cancelled)
  → Promise settle 后 startRun.finally 释放槽位
```

取消与 timeout 的精确合同见 [02-product-contract.md](./02-product-contract.md)。

## 成功标准

方案成功不是“再也不存在 running”，而是：

```text
纳入范围的控制面 RPC 不再永久等待
  + 可安全短暂故障至多重试一次
  + 最终失败可诊断
  + Worker execution slot 可有界释放
```

如果 `completeRun` 也无法访问 API，数据库仍可能残留 `running`。该残留是明确接受的一期边界，不能据此判定 timeout 实现无效，也不能将 watchdog 偷渡进本批次。
