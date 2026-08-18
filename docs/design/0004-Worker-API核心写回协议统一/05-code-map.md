# 代码地图与冻结基线

> 行号来自 1B 调研基线，用于快速检索；实施前必须以当前工作区复核。代码地图描述现状，不授权修改未纳入范围的邻近模块。

## shared

| 文件 | 关键位置 | 现状与 1B 关系 |
|---|---|---|
| `packages/shared/package.json` | exports `:8-35` | 已有 1A 三个 internal subpath；新增且仅新增 `./internal-contracts/agent-api` |
| `packages/shared/src/index.ts` | 全文件 | 根入口不得导出 internal contracts |
| `packages/shared/src/internal-contracts/endpoints.ts` | 全文件 | 1A endpoint 常量；不混入 Worker→API 九接口 |
| `packages/shared/src/internal-contracts/errors.ts` | 全文件 | 已有内部错误模型；仅按需增加已确认 stable code，禁止全局错误系统化 |
| `packages/shared/src/internal-contracts/agent-worker.ts` | 全文件 | 1A schema；与新增 agent-api 分离 |
| `packages/shared/src/contracts/agent.ts` | tool name `:12-28`、item status `:44-52`、output `:54-95`、record `:110-128` 附近 | `AgentContextItemOutputSchema`、tool name、`AgentContextItemRecordSchema` 是 context 协议复用依据 |
| `packages/shared/tests/internal-contracts.test.ts` | 全文件 | 1A shared 测试模式；新增 agent-api schema/export smoke tests 的优先位置 |

公共 output 关键事实：`AgentContextToolNameSchema` 覆盖 builtin、`mcp_...`、plugin canonical name；tool `args`/`result` 是 `Type.Any()`。因此能接收当前合法动态 tool payload，但不承诺任意非法 top-level output。

## API 应用与配置

| 文件 | 关键位置 | 现状与迁移点 |
|---|---|---|
| `apps/api/src/config/env.ts` | `Env :4-25`，`loadEnv :47-123` | 已规范化 `AWB_INTERNAL_RPC_RESPONSE_VALIDATION`，缺失 strict、非法 fail-fast；需确保传进 AppContext/Manager |
| `apps/api/src/config/env.test.ts` | 全文件 | 增加缺失/strict/warn/非法值测试，覆盖 Manager 显式覆盖语义 |
| `apps/api/src/app/context.ts` | AppContext/创建链 | 承接 `agentWorkerResponseValidation` 到 Manager |
| `apps/api/src/main.ts` | 服务创建链 | 核对 env→context→manager 的注入完整性 |
| `apps/api/src/modules/agent/agent.module.ts` | `:174-192` 附近 | 实例化 `AgentWorkerClient` 与 `AgentWorkerProcessManager`；是 API 已归一化 `agentWorkerResponseValidation` 传入 runtime、并在 1B 中继续接入 Manager 的关键接线点 |
| `apps/api/src/app/createApp.ts` | Fastify 创建 `:1-105` 附近 | 只能证明应用未在此处显式自定义 validator/AJV；未知字段的实际剥离/保留行为来自 Fastify/AJV 当前运行时默认与调研 probe，不得归因于本文件配置 |

## API Route

| endpoint | 文件/基线行号 | 当前关键事实 |
|---|---|---|
| prefork-plan | `agent.routes.ts:533-572` | inline body、handler token、response 200/400/401/404 |
| subtask start | `:574-636` | `new`/`fork` member 宽松，`existing.sessionId` 必填，`preforkMeta` strict；existing 缺 sessionId 在 schema 阶段失败，new/fork 额外 sessionId 到 Service 处理 |
| subtask result/status | `:638-695` | body workspace/session/run，读取 response |
| context create | `:697-751` | `output:Type.Any()`、`ok:boolean` wrapper；迁移为 public output 与 literal ok |
| context update | `:1048-1082` 附近 | params itemId，optional output `Type.Any()`，不携带 workspace/session |
| run-state | `:1084-1117` 附近 | status/active fields，`ok:boolean`；保持 ignored 语义由 Service 决定 |
| run-complete | `:1119-1146` 附近 | terminal status，`ok:boolean` |
| compact | `:1148-1184` 附近 | response 是 `compacted/summaryItemId/archivedCount`，不是 ok wrapper |
| token helper | `:72-77` | `assertInternalToken()` 在 handler 内，因此 route schema-first |

所有 handler 当前使用 `req.body as {...}`。迁移目标是 shared `Static` 类型和显式 Service 映射，禁止保留等价手写边界类型。现有 response `ok:boolean` 的收紧为 literal true 必须同步 Route、Client 与测试。

## API Service 与 Store

| 主题 | 文件/基线行号 | 关键行为 |
|---|---|---|
| context create | `agent.service.ts:2907-2968` | prev head mismatch 为 conflict；调用 Store append |
| context update | `:2970-3109` | artifact 流程可能先于 Store terminal ignored |
| run-state | `:3111-3166` | RS-1~RS-3 直接 return |
| run-complete | `:3168-3245` | RC-1~RC-3 直接 return |
| parent anchor | `:3247-3280` | subtask anchor/agent 前置校验 |
| prefork plan | `:3350-3395` | threshold 归一与只读计划 |
| subtask start | `:3398-3725` 附近 | identity reuse、new/existing/fork、Service 防御性 `EXISTING_SESSION_REQUIRED`、session 前置副作用、depth/error code |
| subtask result/status | `:3727-3770` 附近 | partial text 与 run record 读取 |
| compaction | `:3861-3940` 附近 | Service 前置 head check、archive、Store CAS 调用 |
| cancel cascade | `:2878-2905` 附近 | DB metadata 递归 parent/child，事务后 runtime cancel |
| session operation lock | `:1933-1950` 附近 | 会话操作串行化的局部边界 |
| archive append/rollback | `:1251-1343` | 文件副作用与 best-effort rollback |
| conflict mapping | `:116-118` | `AgentConflictError` 到 HTTP error 的现状 |
| context record mapping | `agent.store.ts:462-487` | 记录回读/公共 record 对齐处 |
| context append transaction | `:791-913` | head CAS/append 的 Store transaction |
| update terminal ignored | `:915-971` | terminal 返回原 item、不写 DB |
| compact CAS transaction | `:1245-1384` | 二次 head CAS 与 DB 原子范围 |
| existing child lookup | `:1720-1750` | `(parentRunId,parentToolItemId)` reuse 查询 |
| parent tool child lookup | `:1887-1925` | public cancel 从 parent tool metadata 找 child |
| recoverable query | `:2045-2067` | recover 的 DB 选择范围 |
| run-state row / run row | `:341-367` | Store 状态/record 结构 |
| set/upsert idle | `:1470-1501` | run-state 持久化/收敛 |

数据库 lineage 与唯一约束位于 `apps/api/src/infra/db/schema.ts:167-182` 与 `:271`：`idx_agent_run_parent_tool_unique`。本期依赖该约束，不调整 schema/index。

## Worker

| 文件 | 基线位置 | 关键事实/迁移点 |
|---|---|---|
| `apps/agent-worker/src/config/env.ts` | `:1-43` | 目前没有 responseValidation；需解析 strict/warn，缺失 strict、非法 fail-fast |
| `apps/agent-worker/src/main.ts` | `:10-19` | 目前只传 apiOrigin/internalToken；需传 responseValidation/logger |
| `apps/agent-worker/src/runtime/apiClient.ts` | `:189-214` | 通用 fetch；非2xx parser 的结构化错误被自身 catch 吞掉，最终 raw body Error |
| 同上 | `:216-280` | context/run 当前手写 input/path/response 类型 |
| 同上 | `:335-350` | compact 使用 `conflictAsError:true` |
| 同上 | `:381-438` | subtask 四接口，均未使用 conflictAsError |
| `apps/agent-worker/src/runtime/runner.ts` | 现有 run 写回/compact 调用点 | 不复制 HTTP schema；保持 Runner completion fallback 与停止行为 |
| `runtime/tools/providers/builtin.ts` | prefork/subtask 调用点 | fork 固定 threshold 95；摘要失败降级正常 fork |
| `runtime/provider-subtask-cancel.test.ts` | 全文件 | parent/child cancel 与 provider 视角回归基础 |
| `runtime/runner.cancel.test.ts` | 全文件 | 取消与 run 状态回归 |
| `runtime/runner.tool-output.test.ts` | 全文件 | 合法 context tool output 覆盖基础 |
| `runtime/runner.auto-compact.test.ts` | 全文件 | compact conflict/停止行为基础 |
| `runtime/builtin.prefork.test.ts` | 全文件 | prefork 阈值和失败降级基础 |

## Worker Manager 与恢复

| 文件 | 基线位置 | 关键事实 |
|---|---|---|
| `apps/api/src/modules/agent/agent.worker-manager.ts` | constructor `:24-37`、spawn env `:59-75` 附近 | 当前 `...process.env` 后显式传 Worker 地址/token；1B 将经 module 接线新增/传入规范化 response validation，并在此显式覆盖 child env |
| 同上 | `waitUntilReady :176-218` 附近 | 1A health probe 仍只看 2xx，不接入 1B response validation |
| `apps/api/src/modules/agent/agent.worker.integration.test.ts` | 全文件 | Manager/Worker 启动与 env 传播测试的优先位置 |
| `apps/api/src/modules/agent/agent.integration.test.ts` | 全文件 | API route/service/DB lifecycle 基础测试 |

恢复后 Worker 不恢复 nested mapping；API cancel cascade 依赖 DB metadata。审查 cancel 相关改动时必须确认没有把 DB 级联保障错误替换为仅内存映射。

## 推荐基线核对命令

```bash
rg -n \
  'run-state|run-complete|context-items|context/compact|subtask/prefork-plan|subtask/start|subtask/result|subtask/status' \
  apps/api/src apps/agent-worker/src packages/shared/src

rg -n \
  'assertInternalToken|AgentConflictError|ApiConflictError|conflictAsError|AWB_INTERNAL_RPC_RESPONSE_VALIDATION|additionalProperties|completeRunFromWorker|updateRunStateFromWorker|compactContextFromWorker|startSubtaskRunFromWorker' \
  apps/api/src apps/agent-worker/src packages/shared/src
```
