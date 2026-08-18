# 背景、目标与范围

## 背景

`agent-workbench` 的 Agent 执行链路由 API 协调、Agent Worker 执行。当前 Worker 通过本地 HTTP 或 Unix Socket 接收 API 请求，API 侧在 `AgentWorkerClient` 中手写路径和请求体，Worker Server 再自行解析 JSON 并做局部字段检查。

这种方式当前可以工作，但同一协议由多个位置分别表达，后续修改字段或 endpoint 时容易出现“编译通过、运行时才发现不一致”的问题。项目主要用户只有一人，且它是主力开发工具，因此本次改造的首要约束是保持现有运行逻辑和使用习惯，不进行大范围架构重构。

## 目标

- 建立 API ↔ Worker 1A 控制面协议的唯一 schema/type 来源。
- 统一 endpoint 常量，消除 API Client 和 Worker Server 的裸路径重复。
- 在 Worker 入站边界校验请求，在 API Client 侧仅校验 enqueue/cancel 的关键成功响应；health 的 Manager ready probe 不解析 body。
- 在 shared 中定义轻量内部错误模型的 `code`、`message` 字段，用于内部诊断，不改既有 HTTP error body。
- 保留当前 endpoint、字段、兼容输入、status、错误处理和业务流程。
- 用小规模自动测试与一次主力场景手测验证收益，避免无限扩大测试投入。

## 业务链路

### Worker 启动与健康检查

```text
API registerAgentModule
  -> AgentWorkerProcessManager.start()
  -> 启动 apps/agent-worker/src/main.ts
  -> createWorkerServer()
  -> manager 通过 /internal/health 等待 Worker ready
```

Worker Manager 当前同时支持 Unix Socket 和 TCP/HTTP 探测；本次只统一 health path 常量，ready 仍按 `2xx` status 判定，不解析 health body，不改变探测方式、超时、重启和 circuit breaker。`{ ok: true }` 只在独立 Worker Server/schema 测试中验证。

### Agent run 入队

```text
Web/API 业务请求
  -> AgentRuntimePort.enqueueRun()
  -> AgentWorkerClient.enqueueRun()
  -> POST /internal/runs/enqueue
  -> Worker Server 校验并调用 AgentRunner.enqueueRun()
  -> 返回 202 { ok: true }
```

API 的 Agent Service 在入队失败时会回收 run 状态并继续使用现有错误映射；本次不改变该流程。

### Session 取消

```text
API 取消逻辑
  -> AgentRuntimePort.cancelSession()
  -> AgentWorkerClient.cancelSession()
  -> POST /internal/runs/cancel-session
  -> Worker Server 校验并调用 AgentRunner.cancelSession()
  -> 返回 202 { ok: true }
```

当前 cancel 是 best-effort：API Client 失败时记录 warning，不把失败重新抛到主取消流程。本次保持该语义。

## 实施范围

### 纳入范围

- `GET /internal/health`
- `POST /internal/runs/enqueue`
- `POST /internal/runs/cancel-session`
- `packages/shared/src/internal-contracts/{endpoints.ts,errors.ts,agent-worker.ts}`
- `packages/shared/package.json` 的显式子路径 exports
- API Worker Client 的协议引用和关键 response 校验
- Worker Server 的 request schema 校验
- 1A 的最小契约、Server、Client 测试
- API env 中临时 response validation 模式

### 明确不纳入

- Worker → API 的 run state、completion、failure、context append（后续 1B）
- Plugin Host 和插件协议
- MCP、内建工具、Plugin Tool 的全量 schema
- Agent Runner、Agent Service、Agent Store 的职责拆分
- HTTP/RPC Server/Client 公共基建抽象
- Worker/Plugin Host Process Manager 抽象
- 数据库、session/run 状态机、对外 API 和 Web UI 行为改动
- 新增 `packages/shared-contracts` workspace
- 全仓 `any` 清理或全量错误处理重构

## 成功标准

本次改造完成后，API 和 Worker 对 1A 的协议定义来自相同文件；用户可以按现有方式启动 Worker、发起 Agent run 和取消 session；现有相关测试通过；没有因 schema 校验引入新的产品流程或数据迁移要求。
