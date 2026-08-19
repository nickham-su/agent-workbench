# 代码地图与调用链

> 行号是调研基线，实施前必须复核；符号名比行号更重要。发现定位漂移或行为差异时，暂停当前批次并更新本文与测试证据。

## Shared contracts

| 文件 | 符号/区域 | 本轮用途 |
|---|---|---|
| `packages/shared/src/internal-contracts/agent-api.ts` | `AgentApiEndpoints`、re-export | 继续作为唯一公开聚合入口；新增三 read-side endpoint |
| `packages/shared/src/internal-contracts/agent-api-run.ts` | run schema | 复用既有组织方式，作为 read-side schema 风格参考 |
| `packages/shared/src/internal-contracts/agent-api-context.ts` | context record/output schema | 复用 message/status/tool 等公共定义，不能破坏 1B create/update response |
| `packages/shared/package.json` | `./internal-contracts/agent-api` export | 本轮通常无需新公开路径；若增量 export 必须保持唯一入口 |

## API routes

| 文件 | 定位 | 本轮工作 |
|---|---|---|
| `apps/api/src/modules/agent/agent.routes.ts` | `/api/internal/agent/prompt-context`，约 1120 行 | 替换匿名 body/response schema 为 shared schema；保持 400/401/404 与 handler |
| 同上 | `/api/internal/agent/messages-context`，约 1180 行 | shared schema；保持 appendMessage/session-bound |
| 同上 | `/api/internal/agent/execution-profile`，约 1223 行 | shared schema；保持 run-bound、敏感返回和错误语义 |
| 同上 | Context create 约 650-670 行 | 1D late append response/fence 入口；正常 response 必须与 1B 一致 |
| 同上 | Context update 约 950-985 行 | 1D update 归属和终态 fence 入口 |
| 同上 | cancel 约 447-468 行 | 保持 DB cascade 后 runtime cancel 的顺序 |
| 同上 | subtask start 约 560-610 行 | 现有 lineage/create 入口，需配合局部 orphan 补偿 |

## API service

| 文件 | 符号/定位 | 本轮工作 |
|---|---|---|
| `apps/api/src/modules/agent/agent.service.ts` | `runPromptStaticCache`，约 1926 行 | 只核对并冻结，不改变 cache key/TTL/失效 |
| 同上 | `getExecutionProfileForRun()`，约 3748 行 | 保持 run/session/workspace 检查和 profile 组装；拆出 shared response type |
| 同上 | `getMessagesContext()`，约 4381 行 | 保持 session-bound、locale fallback、appendMessage |
| 同上 | `getPromptContextForRun()`，约 4464 行 | 保持 cache、prompt/messages/tools 业务逻辑；返回 shared response type |
| 同上 | `cancelSessionCascade()`，约 2893 行 | 保持 DB transaction；改 child 查找依据时使用 durable lineage |
| 同上 | `appendContextItemFromWorker()`，约 2918 行 | 增加 late append DB fence/no-op 分支；保留 apply_patch 与 todolist 逻辑 |
| 同上 | `updateContextItemFromWorker()`，约 2969 行 | 增加 item/run/session/workspace/terminal 状态检查 |
| 同上 | `startSubtaskRunFromWorker()`，约 3367 行 | 记录本次新建 session；失败/unique race 局部补偿；保留 existing reuse 语义 |
| 同上 | archive compaction/clear 约 3828-4030 行 | 在 rollback skipped 时写 sidecar；保留现有 archive/DB 顺序 |
| 同上 | `appendArchiveLines()`/`rollbackArchiveLinesBestEffort()` 约 1262/1332 行 | 复用 before/expected size；新增 sidecar/reconcile helper，不改 archive 格式 |

## API module/recovery

| 文件 | 符号/定位 | 本轮工作 |
|---|---|---|
| `apps/api/src/modules/agent/agent.module.ts` | `enqueueRecoveringRuns()`，约 28 行 | enqueue 前最终 DB 检查；保持 recover 失败不阻塞启动 |
| 同上 | startup recovery 注册区，约 220-240 行 | 增加 orphan/archive pending 扫描入口，必须 best-effort 且不阻塞启动 |
| `apps/api/src/modules/agent/agent.runtime.ts` | Worker runtime port 调用约 70-130 行 | 核对迟到 append/update 的实际调用顺序，不重构 runtime |
| `apps/api/src/modules/agent/agent.worker-manager.ts` | `buildAgentWorkerSpawnEnv()`、Manager | read-side validation 配置沿用 1B；不改进程生命周期 |

## Worker client/runner

| 文件 | 符号/定位 | 本轮工作 |
|---|---|---|
| `apps/agent-worker/src/runtime/apiClient.ts` | `getExecutionProfile()` 约 324 行 | 改用 shared endpoint/schema/request helper |
| 同上 | `getPromptContext()` 约 341 行 | 同上；保留 typed PromptContext 消费 |
| 同上 | `getMessagesContext()` 约 357 行 | 同上；保留 appendMessage |
| 同上 | `request()` helper，文件前部 | 复用 1B strict/warn；收紧 diagnostics，禁止 payload/secret/标识符 |
| `apps/agent-worker/src/runtime/runner.ts` | messages-context 约 1672 行 | compaction one-shot system 调用链 |
| 同上 | execution-profile 约 2471 行 | 主运行 profile 获取 |
| 同上 | prompt-context 约 2493 行 | 主运行 prompt 获取 |
| 同上 | subtask result/header 约 220-330 行 | `subtaskSessionId` 呈现/快速定位，不作为权威 lineage |

## 测试地图

| 文件 | 现有证据 | 本轮新增重点 |
|---|---|---|
| `apps/api/src/modules/agent/agent.integration.test.ts` | 三 read-side 大量行为测试、recovery/cancel/subtask/archive | shared route schema、鉴权顺序、late fence、recover/cancel race、orphan、sidecar |
| `apps/api/src/modules/agent/agent.worker.integration.test.ts` | 当前主要证明 run-state、context create/update、run-complete 四条真实 Worker 写回主链 | 本轮新增 recorder/断言，真实覆盖 execution-profile、prompt-context、messages-context 的 Worker → API 调用；未新增前不得声称已有 read-side 真实 Worker 证据 |
| `apps/api/src/modules/agent/context-item-contract.test.ts` | Context contract/compaction | late no-op response、terminal update、archive rollback/sidecar |
| `apps/agent-worker/src/runtime/apiClient.test.ts` | 1B client response validation | 三 read-side method/path/schema、strict/warn、敏感日志 |
| `apps/agent-worker/src/runtime/runner.auto-compact.test.ts` | messages-context/compaction | read-side response 消费不回归 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.prefork.test.ts` | prefork messages-context | 动态 schema 与 response 消费 |
| `apps/api/src/modules/agent/agent.worker-manager.test.ts` | response validation env | 配置传播不回归 |

## 代码边界

不应在本轮修改：

- Plugin Host client/server；
- archive search/read endpoint schema；
- git-env lease 实现；
- MCP settings 业务；
- AI provider 业务解析；
- DB schema migration；
- Worker process restart/backoff policy。
