# 代码地图与改动边界

> 本文行号为调研定位，实施前必须基于当前分支复核。函数名、类名和业务关系是主要审查依据，不得把行号当成永久合同。

## 部署与进程模型

### `Dockerfile`

关键行为：

- 容器入口为 `tini -- docker-entrypoint.sh`；
- 默认命令启动 `node apps/api/dist/main.js`；
- API 是容器主服务进程，不直接把 worker 作为 Docker service 启动。

与本方案关系：区分容器/API 重启与 worker 子进程单独退出。

### `docker-entrypoint.sh`

关键行为：

- 完成目录可写性准备；
- 最后 `exec "$@"` 启动 API。

本轮不修改。

### `apps/api/src/modules/agent/agent.module.ts`

关键符号：

- `registerAgentModule()`；
- `AgentWorkerClient`；
- `AgentWorkerProcessManager`。

关键行为：

- worker enabled 时创建 API → Worker client；
- 创建 worker process manager；
- route/startup coordinator 注册后启动 worker；
- API close 时停止 worker。

本轮不修改。

### `apps/api/src/modules/agent/agent.worker-manager.ts`

关键符号：

- `buildAgentWorkerSpawnEnv()`；
- `AgentWorkerProcessManager.start()`；
- `handleUnexpectedExit()`；
- `scheduleRestart()`；
- `waitUntilReady()`。

关键行为：

- 使用 `spawn()` 拉起 agent-worker；
- child env 继承 parent env；
- worker 意外退出后指数退避重启；
- 60 秒内多次失败触发短暂 circuit breaker。

与本方案关系：

- 两个新增环境变量进入容器/API process env 后会被 child 继承；
- worker restart 不触发 API startup recovery；
- worker crash/OOM 治理明确排除。

本轮原则上不修改。

## API → Worker 对照边界

### `apps/api/src/modules/agent/agent.worker-client.ts`

关键符号：

- `AgentWorkerClient.postBySocket()`；
- `AgentWorkerClient.post()`；
- `enqueueRun()`；
- `cancelSession()`。

现状：

- Unix socket 使用 `req.setTimeout()`；
- HTTP 使用 `AbortController`；
- enqueue timeout 约 4 秒；
- cancel timeout 约 2.5 秒。

本轮不修改。该文件只作为“API → Worker 已有独立 timeout，不能与 Worker → API 混淆”的对照证据。

## Worker 配置与启动

### `apps/agent-worker/src/config/env.ts`

关键符号：

- `WorkerEnv`；
- `parsePositiveInt()`；
- `loadWorkerEnv()`。

必须修改：

- 新增 `internalRpcTimeoutMs`；
- 新增 `completeRunTimeoutMs`；
- 读取两个新环境变量及默认值；
- 非正整数启动失败；
- 增加配置单元测试，若当前无独立 env test，可新建最小测试文件或在既有 config test 扩展。

不得修改：

- worker host/port/socket 语义；
- internal token；
- response validation；
- concurrency。

### `apps/agent-worker/src/main.ts`

关键符号：

- `loadWorkerEnv(process.env)`；
- `new AgentApiClient(...)`；
- `new AgentRunner(...)`。

必须修改：

- 将两个 timeout 配置传给 `AgentApiClient`。

不得修改：

- MCP manager、attachment storage、runner/server 启动结构；
- shutdown 信号处理。

## Worker → API 核心实现

### `apps/agent-worker/src/runtime/apiClient.ts`

关键符号：

- `ApiConflictError`；
- `AgentApiClient`；
- `AgentApiClient.request()`；
- 所有 public API 方法。

现状：

```text
request()
  → fetch without signal
  → non-2xx response.text
  → success response.json
  → optional TypeBox validation
```

必须修改：

- 增加命名 policy 类型/常量；
- 增加请求级 AbortController 与完整 attempt timeout；
- 增加 typed timeout/http/network/invalid-response error 与冻结分类；
- 增加 retry 循环与 300ms 退避；
- 已知非 2xx status 优先于错误 body 失败/timer；错误 body 不解析、不进入 message；
- 增加安全 diagnostics，并保证最终抛出 error message/字段也只有安全元数据；
- public 方法显式绑定策略；
- 保持 strict/warn 和 `ApiConflictError` 语义。

必须逐项检查的方法：

| 方法 | 处理 |
|---|---|
| `createContextItem` | `controlWrite` |
| `updateContextItem` | `controlWrite` |
| `updateRunState` | `controlWrite` |
| `completeRun` | `runComplete` |
| `getExecutionProfile` | `controlRead` |
| `getPromptContext` | `controlRead` |
| `getMessagesContext` | `controlRead` |
| `compactContext` | `controlWrite` |
| `getSubtaskPreforkPlan` | `controlRead` |
| `startSubtaskRun` | `subtaskStart` |
| `getSubtaskResult` | `controlRead` |
| `getSubtaskStatus` | `controlRead` |
| `getAgentMcpSettings` | `controlRead`；API 配置快照读取，不连接/执行 MCP server |
| `getPluginRuntimeSnapshots` | `controlRead`；API runtime snapshot 读取，不执行 plugin tool |
| `listPluginTools` | `controlRead`；plugin-host `listTools` 只读发现，不调用 execute |
| `executePluginTool` | 明确排除，不得误套 15s |
| `archiveSearch` / `archiveRead` | 明确排除 |
| `prepareGitEnvForBash` / `cleanupGitEnvLease` | 明确排除 |

如果当前文件新增了其他 public 方法，P0 必须分类后才能编码。

### `apps/agent-worker/src/runtime/apiClient.test.ts`

现状覆盖：

- endpoint method/path/body；
- strict/warn response validation；
- 非 2xx；
- malformed JSON；
- context/subtask/read-side 等方法。

必须扩展：

- timeout abort；
- headers 后 body hang；
- 读类 retry 次数；
- 502/503/504 与其他非 2xx 的错误 body 失败/hang 分类优先级；
- 503 → 200 recovered；
- 4xx/409/500 不 retry；
- JSON/schema 不 retry；
- 普通写不 retry；
- `startSubtaskRun` / `completeRun` retry；
- 排除方法不误套 timeout/retry；
- 日志脱敏；
- 最终抛出 error message/字段/cause 安全；
- timer/socket cleanup。

测试 helper 可能需要支持 async handler、hung response 和 socket tracking；只改测试设施，不改变生产业务。

## Runner 与工具链路

### `apps/agent-worker/src/runtime/runner.ts`

关键符号：

- `AgentRunner.startRun()`；
- `processNestedRunWithController()`；
- `executeTool()` / tool writeback；
- `executePendingTools()`；
- `runModelStep()`；
- `processRun()`；
- `finishOnce()` / `tryFinishOnce()`；
- `isAbortLikeError()`。

关键行为：

- `startRun().finally()` 释放 `activeCount/runningSessions`；
- 单工具和 run 外层已有 catch；
- `processRun()` 在 Provider 前调用 execution profile、run state、prompt context；
- pending tool 完成后重新读取 prompt context；
- 模型 timeout 只覆盖 `streamText()`；
- timeout error 如果看起来像 `AbortError` 会被当作 cancelled；
- terminal submission 失败后存在 fallback 路径。

本轮原则上不修改生产逻辑。允许的例外：

- 如果测试证明仅靠 `apiClient` error normalization 无法避免 timeout 被误判为取消，必须暂停并重新评审是否最小修改 `isAbortLikeError()`；不得直接扩大范围。

必须运行相关 runner 回归：

- cancellation；
- terminal submission failure/fallback；
- nested subtask controller；
- pending tools；
- model timeout/retry。

### `apps/agent-worker/src/runtime/tools/providers/builtin.ts`

关键符号：

- `case "write"`；
- `case "subtask"`；
- `getSubtaskPreforkPlan()`；
- `getMessagesContext()`；
- `startSubtaskRun()`；
- `processNestedRun()`；
- `getSubtaskStatus()`；
- `getSubtaskResult()`。

本轮不修改业务流程。策略由 `AgentApiClient` 方法绑定自动生效。

注意：

- `subtask` reused child 自身已有总 polling deadline，但单次 status RPC 当前无 timeout；本方案补的是单次 RPC 有界化；
- 不修改 reused polling 的 300 秒业务上限；
- 不修改 prefork summary 的模型 timeout；
- 不对 `write` 本体加 timeout。

### `apps/agent-worker/src/runtime/fileTools.ts`

关键符号：

- `runWriteTool()`。

现状：

- 校验路径；
- mkdir/realpath/lstat；
- `fs.writeFile()`；
- 返回 `bytesWritten`。

本轮不修改。`write` 显示 `[xxx bytes]` 只作为定位证据，不构成修改该工具的理由。

## API 侧幂等依据

### `apps/api/src/modules/agent/subtask/subtask-application.ts`

关键符号：

- `SubtaskApplication.start()` 或当前等价入口；
- `findChildByParentTool()`；
- `toReusedResponse()`；
- parent tool unique conflict winner 回查；
- `getStatus()` / `getResult()`。

关键依据：

- existing child 按 workspace/parentRun/parentTool 查询；
- existing request 需通过一致性校验；
- 唯一冲突后回查 winner；
- reused response 返回已有 `sessionId/runId`。

本轮不修改 API 业务代码。必须增加或复用集成测试，证明响应丢失后的 client retry 不重复创建 child。

### `apps/api/src/modules/agent/subtask/sqlite-subtask-lineage-persistence.ts`

关键符号：

- parent tool unique conflict 判定；
- durable lineage 查询。

本轮不修改，只作为 `startSubtaskRun` retry 安全依据。若 unique 约束变化，暂停。

### `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`

关键符号：

- `completeRunFromWorker()`。

关键依据：

- missing/mismatch 返回 false；
- terminal run 返回 false；
- 首次有效调用更新 run terminal；
- activeRunId 匹配时将 run-state 设 idle。

本轮不修改。

### `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`

关键符号：

- `completeRunFromWorker()`；
- `recoverRunsOnStartup()`；
- `failRunsOnStartup()`。

关键依据：

- 只有 persistence 首次有效完成时清 cache、发布 completed event；
- startup recovery 只在 API 启动路径执行。

本轮不修改。需要集成证据证明 duplicate complete 不重复 event。

## 前端定位证据

### `apps/web/src/features/workspace/tools/agent/AgentWriteCard.vue`

关键行为：

- 根据 `summary.bytesWritten` 显示 `[xxx bytes]`；
- 标题颜色使用固定 `--text-secondary`，不是 write 状态色。

### `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

关键符号：

- `parseWriteDisplay()`；
- `isWriteCard()`；
- `AgentWriteCard` 渲染；
- session/context item 状态映射。

本轮不修改。当前工作区已存在用户对这些前端文件的未预期修改，开发不得处理、恢复或混入本方案。

## 部署配置文件

### `docker-compose.yml`

必须修改：

```yaml
AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS: ${AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS:-}
AWB_AGENT_COMPLETE_RUN_TIMEOUT_MS: ${AWB_AGENT_COMPLETE_RUN_TIMEOUT_MS:-}
```

Worker `loadWorkerEnv()` 是唯一运行时默认值来源。Compose 必须保持上述空默认透传，不得在这里重复写 `15000/5000`。

### `.env.example`

必须增加变量、示例值和权威默认说明；`.env.example` 不是运行时默认源：

- 必须为正整数毫秒；
- 不允许 0；
- 一项用于控制面 RPC，一项用于 completeRun；
- 不影响 Provider 模型 timeout。

### `docs/README.zh-CN.md`

必须在 Agent 配置表中说明两个变量。若项目维护英文 README，同步更新对应文件；实施前确认实际文件名。

## 授权改动文件

一期预期授权：

```text
apps/agent-worker/src/config/env.ts
apps/agent-worker/src/main.ts
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
必要的 worker env 测试文件
必要的 API subtask/lifecycle integration test
必要的 runner timeout/fallback test
docker-compose.yml
.env.example
docs/README.zh-CN.md
本设计目录（仅发现设计偏差时更新）
```

默认不授权：

```text
apps/agent-worker/src/runtime/runner.ts 生产逻辑
apps/agent-worker/src/runtime/tools/providers/builtin.ts
apps/agent-worker/src/runtime/fileTools.ts
apps/api/src/modules/agent/* 生产逻辑
apps/web/src/**
packages/shared/**
数据库 schema/migration
```

若必须越界，先暂停并更新设计、测试和审查范围。
