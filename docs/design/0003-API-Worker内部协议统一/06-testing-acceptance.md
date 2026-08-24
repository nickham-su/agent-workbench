# 测试、验收与回滚

## 测试原则

本次是协议来源统一，不是全面安全重构。测试投入围绕三类高价值风险：

- schema 与当前真实 payload 不一致。
- Worker Server 边界校验改变兼容行为。
- API Client response 校验改变主力 run/cancel 流程。

不追求无限穷举。现有安全清洗和业务状态测试继续保留，不因新增契约而删除或放宽断言。

## Shared schema 测试

建议新增 `packages/shared/tests/internal-contracts.test.ts`，测试纯 schema，不启动进程。

最小用例：

- health response `{ ok: true }` 通过。
- enqueue 完整合法请求通过。
- enqueue 省略 `inputText` 通过。
- enqueue 的 `inputText: null` 通过。
- enqueue 省略 `workspaceRepoDirNames` 通过。
- enqueue 的 `workspaceRepoDirNames` 为 null、非数组或混合数组时，不因 schema 收紧而改变既有兼容入口。
- 缺少 `workspaceId`、`sessionId`、`runId` 或 `workspacePath` 被拒绝。
- cancel 合法 `sessionId` 通过。
- cancel 缺少或错误类型的 `sessionId` 被拒绝。
- enqueue/cancel/health response 缺少或改变 `ok: true` 时被拒绝。
- schema 测试只验证 health response 的 `{ ok: true }` 形状；malformed JSON 的 HTTP 行为由 Worker Server 测试覆盖。


TypeBox schema 不能替代运行时校验；测试必须调用与生产代码相同的 validator。当前依赖已提供 `@sinclair/typebox/value`，优先使用 `Value.Check` 和 `Value.Errors`；不得为 1A 引入新的通用 RPC/校验框架。测试不得只验证 TypeScript 能编译。

## Worker Server 测试

扩展 `apps/agent-worker/src/server.test.ts`：

- 正确 token + health 返回当前成功结果 `{ ok: true }`。
- health schema 测试验证 `{ ok: true }`；不把该 body 校验接入 Worker Manager ready probe。
- 错误 token 仍返回 401，body 保持 message-only。
- malformed JSON 仍返回 500，body 保持 message-only。
- 合法 enqueue 仍返回 202，并将归一化后的 payload 传给 Runner。
- 缺少核心 enqueue 字段仍返回 400，且不调用 Runner。
- `workspaceRepoDirNames` 的缺失、非法项、重复和限量行为与现有测试一致。
- 合法 cancel 仍返回 202，并调用 `cancelSession`。
- 非法 cancel request 返回 400，且不调用 Runner。
- 未知路径仍返回 404，body 保持 message-only。

本次不要求新增 Worker Manager 的 ready probe 自动化测试；Manager 仍只按 2xx status 判定 ready，Socket/fetch 的既有 timeout/retry 行为通过现有测试（如有）或主力场景手工验收覆盖。不要为本次引入 Manager 重构或新的测试架构。

测试应优先复用现有 `createWorkerServer`、`postJson` 和 fake runner，不重写一套 HTTP 测试基础设施。

## API Worker Client 测试

扩展 `apps/api/src/modules/agent/agent.worker-client.test.ts`：

- enqueue 发送字段和当前测试断言完全一致。
- cancel 发送 `{ sessionId }`。
- Worker ready 的 Socket 和 fetch 两条探测都引用共享 health path；两条 ready 分支仍只以 2xx status 判定，不解析 health body。
- enqueue/cancel 的 `{ ok: true }` response 在 strict 模式通过。
- enqueue/cancel response 缺失 `ok` 或 `ok !== true` 在 strict 模式失败。
- warn 模式对 response schema 失败输出明显 warning，并保持约定的继续语义。
- 非 2xx、超时、鉴权失败不因 warn 模式被吞掉。
- enqueue 失败仍映射为现有 503。
- cancel 失败仍记录 warning，不改变 best-effort 行为。

Socket 和 fetch 两种传输方式如果共用同一解析函数，只需分别覆盖连接方式的最小回归；不能只测试 fetch 而遗漏 Unix Socket 主路径。

## 集成与构建验收

按仓库现有脚本执行：

```bash
npm run build -w packages/shared
npm run typecheck
npm run typecheck -w apps/api
npm run typecheck -w apps/agent-worker
```

当前 `apps/agent-worker/package.json` 没有单独的 `test` script，因此运行 Worker 测试时使用仓库已有的 `tsx` 工具直接执行测试文件，或在实施时增加一个仅覆盖现有测试的最小 script；不得把不存在的 script 当作验收已经通过。至少覆盖：

```bash
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
npx tsx --test apps/agent-worker/src/server.test.ts
npx tsx --test packages/shared/tests/internal-contracts.test.ts
```

本次不要求执行与改造无关的全量长时间测试；但不得以删除或放宽既有断言代替通过。

## 真实主力场景验收

由项目使用者在本地完成，自动测试不能代替：

### Health

- 按平时方式启动项目。
- 确认 Worker 启动完成且 API ready 探测成功。
- 若使用 Unix Socket，确认该模式正常；若当前配置使用 TCP，也确认对应模式正常。

### Run

- 从现有 Web UI 发起一个简单 Agent run。
- 确认 run 能进入 Worker。
- 确认 Agent 能完成一个小任务，结果和 UI 展示与改造前一致。
- 若日常使用多仓库 workspace，至少在一个多仓库 workspace 复测。

### Cancel

- 发起一个可以持续一段时间的任务。
- 用现有 UI 或现有取消入口取消 session。
- 确认 Worker 收到取消，任务进入现有取消语义；取消失败时 UI/API 行为没有扩大为新的错误流程。

## 验收标准

### 协议结构

- 三个 endpoint 的 path/method 只由 internal contracts 提供。
- API Client 和 Worker Server 不再为同一 1A request/response 维护重复本地类型。
- internal contracts 通过三个显式 exports 子路径可被 API/Worker 编译和运行时解析。
- shared 根入口未新增 internal contract 导出。

### 行为兼容

- endpoint、HTTP method、字段名、可选性、null 语义和 status 不变。
- enqueue 的 repo 目录名归一化行为不变。
- enqueue 成功仍为 `202 { ok: true }`。
- cancel 成功仍为 `202 { ok: true }`。
- health 成功仍为 `{ ok: true }`，不新增业务字段；Manager 不校验 body，只保持 2xx ready 语义。
- 1A 的 401/400/404/500 HTTP error body 仍为当前 message-only 兼容形式；shared errors 的 code 不要求写入这些既有 body。
- malformed JSON 仍为 500；字段结构非法仍为 400。
- enqueue 失败和 cancel best-effort 处理不变。
- Worker 启停、Socket/TCP 选择、timeout、鉴权和重启逻辑不变。

### 校验与配置

- Worker Server request 边界校验通过。
- API Worker Client 的 enqueue/cancel 关键 response 校验通过。
- 默认 strict；warn 只影响 API Worker Client 的 enqueue/cancel response schema 失败；不影响 health ready probe。
- warn 不绕过 request validation、鉴权、HTTP status 或业务逻辑。
- 非法 response validation 配置无法静默生效。

## 回滚

### 优先降级

发现问题疑似由 response schema 过严导致时，设置：

```text
AWB_INTERNAL_RPC_RESPONSE_VALIDATION=warn
```

重启 API 后复测。该操作不应放宽请求、鉴权或 HTTP status 检查。

### 小批次回滚

若问题仍在，回滚本次 1A 小批次改动：

- internal contract 三个文件。
- shared exports。
- API env 和 Worker Client 改动。
- Worker Server 改动。
- 新增测试和临时配置。

本方案不修改数据库、用户数据、Git 历史、Agent 状态机或 endpoint，因此回滚边界清楚。

## 复审证据

开发完成后应保留：

- 迁移 endpoint 清单。
- 删除的旧类型/旧路径清单。
- typecheck/build/test 输出摘要。
- 真实 health/run/cancel 验收记录。
- 是否使用过 warn；若使用，记录原因和后续处理。
- 未完成事项明确列入 [08-follow-up-recommendations.md](./08-follow-up-recommendations.md)。
