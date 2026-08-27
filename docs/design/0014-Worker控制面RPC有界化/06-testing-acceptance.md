# 测试、代码审查与验收

## 总体规则

- 每批实施前必须复核当前代码、策略矩阵和代码地图；不得用扩大 timeout、删除断言或跳过失败掩盖问题。
- 测试必须使用短 timeout 和可控 server/seam，不等待生产 15 秒或依赖非确定性长 sleep。
- timeout 测试必须清理 socket/timer，测试套件自身不得卡死。
- 不得在测试日志、断言失败或 fixture 中输出真实 internal token、Provider credential、prompt/context/tool payload。
- 每批完成后必须独立代码审查；发现问题先修复，再独立复审；复审通过后才算该批完成。
- 验收结论必须区分“Worker Promise 有界结束”与“数据库 session 一定 idle”。

## 配置测试

`loadWorkerEnv()` 至少覆盖：

| 场景 | 断言 |
|---|---|
| 两变量未设置 | `loadWorkerEnv()` 这一唯一运行时权威返回 `15000` / `5000` |
| 设置合法正整数 | 精确读取 |
| `0` | 启动解析失败，错误包含变量名 |
| 负数 | 失败 |
| 非数字 | 失败 |
| 空字符串 | 按未设置使用默认，需与现有 env 风格一致 |
| 两变量互不影响 | completeRun 不错误使用 15s；普通 RPC 不错误使用 5s |

还需静态/配置证据证明：

- `main.ts` 将两个值传给 `AgentApiClient`；
- `docker-compose.yml` 显式注入两个变量；
- Compose 使用空默认透传，不重复定义 `15000/5000`；
- `.env.example` 与 README 记录的默认值和 `loadWorkerEnv()` 一致，但不参与运行时默认求值。

## 单次 Timeout 测试

### 响应头前挂起

构造 server 收到请求但不返回响应头：

- `controlRead` 在注入 timeout 后 reject；
- 底层 request 被 abort/关闭；
- 错误是 `InternalRpcTimeoutError` 或等价稳定类型；
- error name/message 不被 `isAbortLikeError()` 视为用户取消；
- timeout 日志只含安全元数据。

### 响应头后 body 挂起

server 先发送 `200 + content-type`，再保持 body 未结束：

- timer 不得在 fetch resolve 时清理；
- body 消费达到 timeout 后 reject；
- 证明 timeout 覆盖完整 response body 生命周期；
- server/socket 可在测试结束时清理。

### 错误响应 body 挂起

分类优先级必须表驱动覆盖：

| 响应 | body 行为 | 规范分类 | 读策略 attempts |
|---|---|---|---:|
| 502 | 立即读取失败 | `http_502` | 2 |
| 503 | 一直挂到 timer | `http_503` | 2 |
| 504 | 一直挂到 timer | `http_504` | 2 |
| 400 | 立即读取失败 | 不可重试 HTTP 400 | 1 |
| 409 | 一直挂到 timer | 不可重试 HTTP 409 / `ApiConflictError`（按 endpoint 设置） | 1 |
| 500 | 一直挂到 timer | 不可重试 HTTP 500 | 1 |
| 200 | 一直挂到 timer | `timeout` | 2 |

所有场景的单次 attempt 都受 timeout 约束。已知非 `2xx` status 必须优先于错误 body 失败/timer，错误 body 不解析 JSON、不进入 error message；非 502/503/504 不得因 body hang 改成 timeout retry。

## Retry 矩阵

### 读类控制面

表驱动覆盖至少一个 shared endpoint，并用 public 方法绑定测试覆盖全部方法：

| 首次结果 | 第二次结果 | 预期 attempts | 结果 |
|---|---|---:|---|
| timeout | 200 | 2 | 成功，记录 retry/recovered |
| network error | 200 | 2 | 成功 |
| 502 | 200 | 2 | 成功 |
| 503 | 200 | 2 | 成功 |
| 504 | 200 | 2 | 成功 |
| timeout | timeout | 2 | 最终 timeout error |
| 503 | 503 | 2 | 最终 HTTP error |
| 503 + body hang | 200 | 2 | 首次按 `http_503` retry 后成功 |
| 400 | 任意 | 1 | 立即失败 |
| 400 + body hang | 任意 | 1 | 按 HTTP 400 失败，不改成 timeout retry |
| 401 | 任意 | 1 | 立即失败 |
| 404 | 任意 | 1 | 立即失败 |
| 409 | 任意 | 1 | 立即失败 |
| 500 | 任意 | 1 | 立即失败 |
| 500 + body hang | 任意 | 1 | 按 HTTP 500 失败，不改成 timeout retry |
| malformed JSON | 任意 | 1 | 立即失败 |
| strict schema mismatch | 任意 | 1 | 立即失败 |
| warn schema mismatch | 不适用 | 1 | 返回 parsed body，只记既有 warning |

必须验证 retry 间隔使用 300ms 的生产策略；单测可注入 `sleepFn` 记录参数而不真实等待。

### 普通写

对 `createContextItem/updateContextItem/updateRunState/compactContext` 至少表驱动断言：

- timeout：1 attempt；
- network error：1 attempt；
- 503：1 attempt；
- 不存在自动 retry；
- 外层 runner 是否做其他业务动作由现有逻辑决定，client 不重复写。

### `startSubtaskRun`

Worker client 单测：

- timeout/503 后最多第二次；
- 4xx/500 不 retry；
- 两次 request body 业务语义完全一致；
- 第二次 `reused=true` response 能正常返回。

API 集成测试：

```text
首次请求完成 child 创建和 activation
  → 首次响应在客户端视角丢失或超时
  → 同一 parent/tool 请求重试
  → API 返回 reused=true
```

必须断言：

- 数据库中只有一个 child run；
- `sessionId/runId` 与首次创建相同；
- parent lineage 唯一；
- 不重复 seed prompt/context；
- 新 child 不被执行两次。

如果难以在真实 HTTP 集成层制造响应丢失，可使用 API application + client 可控代理，但必须证明“服务端已提交、客户端未确认”的顺序，不能只测首次 503 未提交。

### `completeRun`

Client 单测：

- 5s policy 独立于 15s policy；
- timeout/503 后最多一次 retry；
- 第二次成功后返回；
- 全失败时最多两个 attempt。

API/lifecycle 集成测试：

```text
首次 completeRun 已提交 terminal + idle + event
  → 响应丢失
  → 第二次 completeRun
```

断言：

- run terminal 不变化；
- session state 保持 idle；
- completed event 只发布一次；
- cache invalidation 不产生有害重复副作用。

Runner 测试：

- client-level 两次 attempt 全失败时，现有 fallback 仍可再次调用 client；
- 完整链路 client 逻辑 attempts 不超过 4；短 timeout 下服务端 handler 实际观测到的请求数可小于该值，但不得超过该值，不能以它反推 client attempt 数；
- 理论/注入时钟总等待符合约 20.6s 上限；测试使用短 timeout；
- 全部失败后 `processRun()` 返回；
- `startRun().finally()` 可释放 `activeCount/runningSessions`；
- outer run signal 未 aborted 时，timeout 不被记为 cancelled；
- 另测执行期间将 outer signal 设为 aborted：一期 client 看不到该变化，不要求它停止当前 attempt、300ms 退避或第二个 attempt；request 返回或抛错后 runner 再按现有逻辑收敛 cancelled，不得把“取消阻止 retry”写成一期断言。

## Policy 绑定测试

必须有一个表驱动或静态可验证测试，覆盖所有 `AgentApiClient` public 方法的 policy 分类。至少断言：

- 所有纳入读方法绑定 `controlRead`；
- `getAgentMcpSettings` 仍是 API 配置快照读取；
- `getPluginRuntimeSnapshots` 仍是 runtime snapshot 读取；
- `listPluginTools` 仍只调用 plugin-host `listTools`，不调用 execute；
- 所有普通写绑定 `controlWrite`；
- `startSubtaskRun` 只绑定 `subtaskStart`；
- `completeRun` 只绑定 `runComplete`；
- `executePluginTool`、archive、git-env 没有被误套 15s control policy；
- 新增 public method 时测试会失败，迫使开发显式分类。

可以通过导出 test-only policy map、注入 request recorder 或构造方法级行为测试实现。不得为了测试暴露生产敏感配置。

## 日志测试

### 事件完整性

覆盖：

- timeout；
- retry；
- recovered；
- final failed；
- 正常首尝试成功无新增日志。

### 字段

必须包含：

- endpoint；
- method；
- policy；
- attempt/attempts；
- timeoutMs 或 delayMs；
- elapsedMs；
- 受控 reason；
- 可选 status。

### 脱敏

构造包含以下哨兵值的 body/response/error：

```text
SECRET_INTERNAL_TOKEN
SECRET_API_KEY
SECRET_PROMPT
SECRET_TOOL_ARGS
SECRET_SESSION_ID
SECRET_RUN_ID
```

断言：

- 所有新增 diagnostics 均不包含哨兵值；
- 最终抛出错误的 `message`、自定义字段、可序列化结构均不包含哨兵值或 response body；
- network/JSON/body 失败不会携带原始 `cause` 或原始异常引用逃逸；
- 模拟上游 `logger.error({err})` / `String(err.message)` 时也不泄漏哨兵值。

## 兼容性回归

### Worker Client 既有合同

保持并运行：

- method/path/body；
- internal token header；
- non-2xx error；
- malformed JSON；
- strict/warn schema validation；
- `ApiConflictError`；
- context/subtask/read-side response typed validation。

### Runner

运行相关测试：

- `runner.cancel.test.ts`；
- terminal/fallback 相关测试；
- pending tools；
- plugin tools registry；
- model retry/timeout；
- nested subtask cancellation。

模型 timeout/retry 断言不得因本轮改变。

### Subtask

运行：

- start/reuse/unique conflict；
- `new/fork/existing`；
- reused polling deadline；
- parent/child cancellation；
- prefork plan/messages context。

### 配置与部署

至少执行：

```bash
npx tsx --test apps/agent-worker/src/runtime/apiClient.test.ts
npx tsx --test apps/agent-worker/src/runtime/runner.cancel.test.ts
npm run test:integration -w apps/api
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm run typecheck
```

`apps/agent-worker/package.json` 当前没有 `test` script，因此 Worker 单测使用根目录可用的 `tsx --test` 直接执行。实施前仍必须复核 package scripts；最终还需运行根 `npm run build` 与相关 Worker/API 测试，不能只运行上述代表性命令。

## 故障注入验收

建议开发环境做以下受控手工验收：

### Prompt context 挂起

- 在测试 seam 让 `/prompt-context` 不结束响应；
- 观察 15s policy（可临时测试配置更短）；
- 只 retry 一次；
- 最终进入 failed 收敛；
- Worker 可继续接受后续 run；
- 日志准确指出 endpoint。

### 工具完成后挂起

- 先完成 `write` 并看到 `[xxx bytes]`；
- 下一次 prompt-context 故障注入；
- 验证不会重复执行 write；
- 验证只重试 prompt-context read；
- 最终 Worker 槽位释放。

### Subtask status 挂起

- reused child status 请求挂起；
- 每次 status RPC 受 15s policy；
- 单次调用只 retry 一次；
- 不创建新 child；
- 父任务最终可失败返回，而非永久等待。

### Complete run 挂起

- 终态 API 不响应；
- 单次 client 最多 2 attempts；
- runner fallback 后总 attempts 不超过 4；
- Worker Promise 最终结束；
- 明确认可数据库可能仍 running。

## 产品验收标准

### 必须满足

- 纳入范围的 RPC 无无限 pending；
- 策略值与矩阵一致；
- retry 不重复执行工具；
- `startSubtaskRun` 不重复 child；
- `completeRun` 不重复 event；
- outer signal 未 aborted 时，timeout 不被视为 cancelled；不验收“取消阻止 retry”这一未实现能力；
- API 完全不可达时 Worker Promise 仍有界结束；
- 后续新 run 能使用释放的并发槽；
- 日志可定位 endpoint/reason/attempt；
- 正常路径用户体验无变化。

### 不作为失败条件

在 `completeRun` 全部失败时：

- 数据库残留 stale running；
- 前端仍显示 loading；

属于一期已声明边界，但必须有 final-failed 日志且 Worker 槽位已释放。后续由 watchdog/lease 方案处理。

## 代码审查清单

### 范围

- 是否只修改授权文件；
- 是否误改 runner/tool/API 状态机；
- 是否把排除 endpoint 纳入 policy；
- 是否引入全局 retry 框架或后台 watchdog。

### Timeout

- controller/timer 是否每 attempt 独立；
- timer 是否覆盖 body/JSON；
- timeout 后是否真的 abort fetch；
- timer 是否总能清理；
- timeout error 是否会被识别为 abort/cancel。

### Retry

- attempts/retries 是否没有 off-by-one；
- 是否仅限五种原因；
- 500/4xx/JSON/schema/conflict 是否不 retry；
- 普通写是否 0 retry；
- body 是否保持相同业务语义；
- 是否存在第二或第三个隐式 retry 层。

### 幂等

- subtask start 的 unique/reuse 依据是否仍成立；
- completeRun terminal/event 依据是否仍成立；
- timeout 响应丢失场景是否有测试，而非只测请求前失败。

### Diagnostics

- 是否只记录安全元数据；
- 是否记录原始 error/body；
- 最终抛出 error message/字段是否同样安全；
- 是否把原始 network/body/JSON error 作为 `cause` 泄漏给上游 logger；
- 正常路径是否日志过量；
- endpoint/policy/attempt/reason 是否足够排障。

### 配置

- 默认值是否一致；
- 0 是否被拒绝；
- Compose 是否显式注入；
- API child env 是否无需重复解析；
- 文档是否同步。

## 暂停验收条件

出现以下情况不得以“基本可用”通过：

- body hang 仍会无限等待；
- timeout 被标 cancelled；
- `executePluginTool` 被 15 秒误杀；
- 普通写发生自动 retry；
- start subtask 可能产生重复 child；
- completeRun 重复发布 event；
- 日志包含敏感 payload；
- Docker 配置无法实际传入容器；
- 只能证明 apiClient 抛错，不能证明 runner Promise/槽位释放；
- 测试依赖真实等待 15 秒且不稳定。

## 回滚标准

本轮无数据库迁移，回滚应只涉及 Worker client/config/docs。回滚验证：

- 还原代码后正常 Agent 路径保持原状；
- 删除 Compose 中新增变量不会影响其他配置；
- 不需要数据回滚；
- 不删除本轮故障日志作为“修复”；
- 若因误失败回滚，保留复现证据并重新评估 timeout 默认值，不直接允许 0。
