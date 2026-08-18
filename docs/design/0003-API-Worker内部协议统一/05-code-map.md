# 代码地图与基线引用

> 行号是本次调研基线的检索辅助；实施前若代码移动，必须以符号和现有测试重新核对，不得按旧行号盲改。

## API 入口与运行时选择

| 文件 | 位置/符号 | 职责 |
|---|---|---|
| `apps/api/src/modules/agent/agent.module.ts` | `registerAgentModule` `:165-237` | 创建 `AgentWorkerClient`、Worker Manager、注册路由和启动/关闭 Worker |
| `apps/api/src/modules/agent/agent.runtime-port.ts` | `AgentRuntimePort` `:9-12` | API 业务层使用的 `enqueueRun`/`cancelSession` 抽象 |
| `apps/api/src/config/env.ts` | `Env`/`loadEnv` `:4-24,46-115` | API 环境变量解析和运行时配置 |

`registerAgentModule` 在 Worker 开启时把 `AgentWorkerClient` 作为 runtime；关闭时使用 API 进程内 `AgentRuntime`。本次只改变 Worker Client 的内部协议引用，不改变 fallback runtime。

## API Worker Client

| 文件 | 位置 | 当前行为 |
|---|---|---|
| `apps/api/src/modules/agent/agent.worker-client.ts` | `AgentWorkerClient` `:8-100` | Unix Socket/TCP 两种 POST 传输、token header、timeout、非 2xx 处理 |
| 同上 | `postBySocket` `:18-55` | Unix Socket 请求和 status 检查 |
| 同上 | `post` `:57-82` | TCP/fetch 请求和 status 检查 |
| 同上 | `enqueueRun` `:84-91` | `/internal/runs/enqueue`，失败映射 503 |
| 同上 | `cancelSession` `:93-99` | `/internal/runs/cancel-session`，失败 warning/best-effort |
| `apps/api/src/modules/agent/agent.worker-client.test.ts` | `:8-59` | enqueue payload 形状回归测试 |

迁移重点是让 `post` 在需要时返回成功 body，并在 Client 侧校验；不能丢掉 socket/fetch 分支的 header、timeout 和错误行为。

## Worker Server

| 文件 | 位置 | 当前行为 |
|---|---|---|
| `apps/agent-worker/src/server.ts` | `createWorkerServer` `:31-139` | HTTP/Socket Server、鉴权、路径分派、JSON 读取和响应 |
| 同上 | `readJsonBody` `:14-22` | 读取 JSON；`JSON.parse` 失败向外抛出，由外层 catch 返回 `500` message-only；当前对 body 不设大小限制，本次不扩展为 RPC 基建改造 |
| 同上 | `:40-43` | `x-awb-agent-internal-token` 校验 |
| 同上 | `:49-52` | `GET /internal/health` 返回 `{ ok: true }` |
| 同上 | `:54-75` | enqueue 字段检查、repo 名称归一化、调用 Runner、返回 `202 { ok: true }` |
| 同上 | `:78-86` | cancel session 字段检查、调用 Runner、返回 `202 { ok: true }` |
| 同上 | `:89-93` | 未知路径和异常返回 |
| `apps/agent-worker/src/server.test.ts` | `:51-145` | enqueue Server 测试、兼容归一化和数量/危险值测试 |

本次允许在 Server 边界接入 TypeBox 校验，但必须保留现有 normalize 函数和 Runner 调用顺序。JSON 已成功解析但字段结构非法时返回 `400` message-only；malformed JSON 仍沿用外层 catch 返回 `500` message-only，不能把两类输入混同。

## Worker Runner 与启动

| 文件 | 位置 | 职责 |
|---|---|---|
| `apps/agent-worker/src/runtime/runner.ts` | `EnqueuePayload` `:2645-2652` | enqueue payload 的当前类型来源 |
| `apps/agent-worker/src/main.ts` | `:10-28` | 创建 API Client、Runner、Worker Server |
| `apps/agent-worker/src/main.ts` | `:40-57` | SIGINT/SIGTERM 关闭 Server |

`EnqueuePayload` 是 Worker 运行时类型，第一阶段应由 shared contract 取代跨边界重复类型；Runner 内部行为不重构。

## Worker Manager

| 文件 | 位置 | 职责 |
|---|---|---|
| `apps/api/src/modules/agent/agent.worker-manager.ts` | `start` `:37-99` | 启动 Worker、注入 env、等待 ready |
| 同上 | `stop` `:101-123` | 终止 Worker |
| 同上 | `waitUntilReady` `:175-217` | Socket/fetch health 探测和 10 秒等待 |

本次只让 health path 来自共享 endpoint；`waitUntilReady` 仍只按 `2xx` status 判定 ready，不解析或校验 body，不接入 strict/warn，也不改变 Socket/fetch 的 timeout、等待、retry/restart 语义。不要顺便提取通用 Process Manager 或改变 ready/restart 语义。

`packages/shared/src/contracts/health.ts` 是公共 health 契约，与本次 Worker 内部 `GET /internal/health` 的 `{ ok: true }` 不是同一契约；本次不复用该文件。Manager health 自动化测试不是本次必做，独立 `{ ok: true }` 校验放在 Worker Server/schema 测试中。

## 现有契约与构建

| 文件 | 位置 | 说明 |
|---|---|---|
| `packages/shared/package.json` | `:8-20` | 已有 `exports`：根、`llm-single-call`、`prompts` |
| `packages/shared/package.json` | `:22-31` | shared build/typecheck 与 TypeBox/AI SDK 依赖 |
| `packages/shared/tsconfig.json` | `:1-18` | `rootDir=src`、`outDir=dist`、声明文件输出 |
| `packages/shared/src/index.ts` | `:1-14` | 现有公共根入口；internal contract 不从此导出 |
| `agent-workbench/package.json` | `:4-14` | workspace、根 build/typecheck 编排 |

## 相关产品/集成代码

| 文件 | 位置 | 关系 |
|---|---|---|
| `apps/api/src/modules/agent/agent.routes.ts` | `:879-895` | 业务路由调用 runtime enqueue，并在失败时回收 run |
| `apps/api/src/modules/agent/agent.routes.ts` | `:409-433` 附近 | 取消流程调用 runtime cancel 并处理 best-effort |
| `apps/api/src/modules/agent/agent.integration.test.ts` | 多处 internal Agent API 测试 | 1A 不应因协议迁移改变对外 Agent 行为 |

## 基线核对命令

```bash
rg -n 'internal/health|internal/runs/enqueue|internal/runs/cancel-session' \
  apps/api/src apps/agent-worker/src
rg -n 'AgentWorkerClient|createWorkerServer|EnqueuePayload|normalizeWorkspaceRepoDirNames' \
  apps/api/src apps/agent-worker/src
npm run build -w packages/shared
npm run typecheck
```
