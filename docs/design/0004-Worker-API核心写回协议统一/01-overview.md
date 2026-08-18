# 背景、目标与范围

## 背景

1A 已将 API 对 Agent Worker 的启动、健康、enqueue、取消控制面收敛到 shared internal contracts。反向的 Worker → API 核心写回仍由 API Route schema、Worker `AgentApiClient` 请求体、Service 业务参数和测试分别表达，覆盖 run 状态、context 历史及 subtask 生命周期。

这种多源定义的风险不是单纯的类型重复：

- Route 接受范围、Worker 实际发送范围和成功响应序列化范围可能不一致；context output 的任意 `Type.Any()` 已可导致“请求接受、回读后成功响应序列化失败”的 `500`。
- 运行中的 ignored、CAS conflict、文件归档副作用、subtask identity reuse 等行为容易被协议迁移误改为更“整齐”但不兼容的 HTTP 语义。
- 1A 已有的响应校验保险丝只覆盖 API → Worker；Worker → API 一旦成功 body 漂移，调用方不能尽早发现。

## 产品目标

- 让九个核心写回 endpoint 的 path、method、request、params、success response 与稳定错误码有一个 shared 的可执行事实来源。
- 保持运行、上下文压缩和子任务主流程的既有可观察业务行为。
- 让 Worker 在关键成功响应不符合预期时，在 `strict` 模式尽早失败，在受限 `warn` 模式显性告警后兼容继续。
- 将边界修复限定为：拒绝不满足公共 context output schema 的非法内部输入，防止其迟到地触发 response serializer `500`。
- 为分批开发、独立审查、回归测试、手动验收与后续模型接手提供可执行依据。

## 端到端业务链路

```text
AgentRunner / builtin subtask tool
  -> AgentApiClient（共享 endpoint + request schema/type）
  -> API Fastify Route（schema validation）
  -> handler assertInternalToken()
  -> AgentService / AgentStore / artifact archive
  -> API success response（共享 response schema）
  -> AgentApiClient runtime response validation
  -> Runner 继续、停止或按既有业务层补偿
```

请求校验和 token 的顺序是当前实现的一部分：Fastify 在进入 handler 前做 schema 校验，而 token 断言位于 handler 内。因此本期不能把文档或实现表述成“鉴权先于 schema”，也不能把鉴权前移到 `preValidation`/`onRequest`。

## 本期范围

| 批次 | endpoint | 业务目的 |
|---|---|---|
| 1B-1 | `run-state`、`run-complete` | 同步 Worker 执行状态、完成结果与 terminal 收敛 |
| 1B-2 | context item create/update | 追加或更新会话上下文 item |
| 1B-3 | context compact | 以 CAS 前提归档并写入摘要/压缩上下文 |
| 1B-4 | subtask prefork-plan/start/result/status | 规划、创建/复用、读取 child 子任务生命周期 |

## 明确非目标

以下项目即使与 Agent 相邻，也不得在 1B 顺手修改：

```text
POST /api/internal/agent/execution-profile
POST /api/internal/agent/prompt-context
POST /api/internal/agent/messages-context
archive/*
plugins/*
git-env/*
mcp-settings

Plugin Host 协议
Worker → API read-side 协议
RPC / Process Manager 抽象
独立 packages/shared-contracts workspace
Agent 大文件拆分
数据库结构、事务边界、状态机重写
统一 body limit
全局错误系统 / 统一 envelope
transport timeout / retry
全量 tool output/result 的精确 schema
```

本期也不增加 `protocolVersion`、长期双协议兼容或数据库迁移。API 与 Worker 同仓库且由 API 负责启动 Worker，原子小批迁移的成本和风险更低。

## 成功标准

- 九个 endpoint 在 shared 中有统一定义，并且只有 `@agent-workbench/shared/internal-contracts/agent-api` 作为新增公开入口。
- 每批的 Route、Worker Client、Service 映射和测试与冻结合同一致；不得仅用 `as any` 绕过边界。
- 合法现有 Worker context output 均通过新 request schema；非法 output 在边界以 validation `4xx` 失败，而不是在成功响应序列化阶段造成 `500`。
- strict/warn 配置从 API 正规化、显式传入 Worker 子进程，并由 Worker `AgentApiClient` 使用。
- 忽略、冲突、文件副作用、subtask reuse/recover 等已知边界有自动测试或明确的手测/风险记录。
- 每批完成冻结测试、独立审查、修复、复审和暂存后才允许推进；最终完成全量审查和主力手测。
