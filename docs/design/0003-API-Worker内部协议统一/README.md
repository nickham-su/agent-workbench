# API ↔ Worker 内部协议统一（1A）

> 状态：设计初稿，面向开发、代码审查与验收。
> 范围：仅统一 API 到 Agent Worker 的控制面协议，不改变现有业务行为。
> 本方案以当前代码为基线；路径与行号用于检索，开发前应以当前工作区代码复核。

## 快速结论

本次只处理以下三个现有 endpoint：

```text
GET  /internal/health
POST /internal/runs/enqueue
POST /internal/runs/cancel-session
```

实施方式：

- 不新增 `packages/shared-contracts` workspace。
- 在 `packages/shared/src/internal-contracts/` 新增 `endpoints.ts`、`errors.ts`、`agent-worker.ts`。
- 在 `packages/shared/package.json` 增加三个显式 `exports` 子路径。
- API 与 Worker 通过子路径导入；不从 `@agent-workbench/shared` 根入口导出内部协议。
- 保留 endpoint、HTTP method、字段名、可选性、`null` 语义、HTTP status 和业务流程。
- Worker Server 校验请求；API Worker Client 只校验 enqueue/cancel 关键成功响应。Worker Manager 的 health ready probe 仍只按 2xx status 判定 ready。
- 成功响应保持 `{ ok: true }`，enqueue/cancel 保持 `202`，health 保持当前成功状态。
- 在 shared 中定义轻量内部错误模型 `code`/`message`，但不改现有 401/400/404/500 message-only HTTP body；不引入全局 `ok/data/error` envelope。
- 临时响应校验开关 `AWB_INTERNAL_RPC_RESPONSE_VALIDATION=strict|warn`，默认 `strict`，只影响 API Worker Client 的 enqueue/cancel response validation。

## 阅读路径

| 文档 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、目标、业务链路、范围与非目标 |
| [02-product-contract.md](./02-product-contract.md) | 当前协议、兼容语义与产品行为合同 |
| [03-decisions.md](./03-decisions.md) | 关键决策、取舍和不采用的方案 |
| [04-technical-design.md](./04-technical-design.md) | 目录、exports、schema、校验、错误与迁移设计 |
| [05-code-map.md](./05-code-map.md) | 代码地图、准确路径、符号和调用关系 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 自动测试、真实场景、回滚和验收标准 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 开发任务拆分与逐步实施 |
| [08-follow-up-recommendations.md](./08-follow-up-recommendations.md) | 1B、Plugin Host、独立契约包和 RPC 基础设施后续建议 |

## 规范性约定

- “必须”表示开发和验收要求。
- “保持现状”表示以实施前实际代码和测试为准，不按未来设计推测。
- 发生冲突时，本目录中更具体的产品合同和技术边界优先于泛化建议。
- 本次设计不授权顺便修改 1B、Plugin Host、工具全量协议、Agent 状态机或进程管理器。

## 关键不变量

- Worker endpoint 的路径和 method 不变。
- malformed JSON 仍由 Worker Server 的 `JSON.parse` 异常进入外层 catch，返回当前 `500` message-only body；本次不改为 `400`。
- JSON 结构合法但字段不符合 schema 的 enqueue/cancel request 返回当前 `400` 语义。
- enqueue 的 `workspaceRepoDirNames` 仍由现有 `normalizeWorkspaceRepoDirNames` 兼容、清洗、去重和限量。
- enqueue/cancel 成功响应仍为 `{ ok: true }`，HTTP status 仍为 `202`。
- Worker Manager health ready probe 仍只以 `2xx` status 判定 ready；本次不解析 health body、不改变 Socket/fetch 的 timeout/retry 语义。
- cancel 仍保持当前 best-effort 语义；失败不改变现有上层处理。
- response validation 的 `warn` 模式不绕过 request validation、鉴权、HTTP status 或业务逻辑。
- 本次改造完成后，不应要求用户改变现有 Web 操作流程。
