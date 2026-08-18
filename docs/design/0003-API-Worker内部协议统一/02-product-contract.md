# 产品合同与兼容行为

## 协议总览

| Endpoint | 方向 | 当前 method/path | 成功 status | 成功 body |
|---|---|---|---:|---|
| Worker health | API → Worker | `GET /internal/health` | `2xx` | `{ ok: true }` |
| Enqueue | API → Worker | `POST /internal/runs/enqueue` | `202` | `{ ok: true }` |
| Cancel session | API → Worker | `POST /internal/runs/cancel-session` | `202` | `{ ok: true }` |

`health` 的现有调用方主要是 Worker Process Manager；本次不新增业务字段或版本字段。

`packages/shared/src/contracts/health.ts` 是公共 health 契约，与本次 Worker 内部 `GET /internal/health` 的 `{ ok: true }` response 不是同一协议；本次不复用该文件的 schema，避免把公共 API 和 Worker 内部 ready probe 混为一谈。

## Enqueue request 合同

请求字段以 Worker 当前 `EnqueuePayload` 和 Server 兼容逻辑为准：

| 字段 | 当前语义 | 本次要求 |
|---|---|---|
| `workspaceId` | 必须为 string | 保持不变，request schema 校验 |
| `sessionId` | 必须为 string | 保持不变，request schema 校验 |
| `runId` | 必须为 string | 保持不变，request schema 校验 |
| `inputText` | 可缺失；当前 Server 允许 string 或 null | 保持可缺失和 null 兼容语义 |
| `workspacePath` | 必须为 string | 保持不变，request schema 校验 |
| `workspaceRepoDirNames` | 可缺失；当前允许宽松输入后归一化 | 不改为严格 `string[]`，保留现有 normalize 行为 |

### workspaceRepoDirNames 兼容规则

当前 Worker Server 先接收未知输入，再调用 `normalizeWorkspaceRepoDirNames`。现有测试覆盖了缺失、null、非数组、混合非法元素、重复、危险路径片段和数量上限。

本次必须保持：

- 缺失值最终归一化为 `[]`。
- 非数组不会导致协议迁移新增失败。
- 数组中的非法元素继续过滤。
- 重复项、危险路径片段和超量输入继续按现有函数处理。
- 不把 schema 直接收紧为 `Type.Array(Type.String())`。

## Cancel request 合同

```json
{
  "sessionId": "session-id"
}
```

`sessionId` 必须是 string。字段名、缺失字段的 400 行为保持不变。

## 成功响应合同

三个 1A endpoint 当前成功响应均使用：

```json
{
  "ok": true
}
```

本次对三个响应采用小而严格的 schema：

- `ok` 必须存在。
- `ok` 必须是 literal `true`。
- 不凭空增加 `protocolVersion`、`service`、`data` 等字段。
- 不引入 `ok/data/error` 全量 envelope。

未知的额外字段是否保留由 TypeBox 默认配置和当前 JSON 处理方式决定；本次不以额外字段为失败条件，避免无关兼容风险。

## 错误和状态合同

### Worker Server 边界

保持当前主要 status 和 body 语义：

- token 不匹配：`401`
- request 字段不合法：`400`
- 未知路径：`404`
- handler 未捕获异常：`500`

Worker Server 的 1A HTTP error body 继续保持当前 message-only 兼容形式：

| 场景 | HTTP status | 当前兼容 body | 本次处理 |
|---|---:|---|---|
| token 不匹配 | 401 | `{ message: "Unauthorized" }` | 保持，不把 `code` 写入该 body |
| JSON 结构合法但字段非法 | 400 | 当前 endpoint 的 message-only body | 保持，不把 `code` 写入该 body |
| 未知路径 | 404 | `{ message: "Not Found" }` | 保持 |
| handler 或 `JSON.parse` 未捕获异常 | 500 | `{ message: "..." }` | 保持；malformed JSON 仍为 500 |

`packages/shared/src/internal-contracts/errors.ts` 中的 `code`/`message` 只作为内部错误模型、日志字段和未来可安全新增路径使用；不能声称本次已把所有 Worker HTTP error body 统一为 `code/message`。API enqueue/cancel 的对外映射也保持现状。

### malformed JSON

当前 `apps/agent-worker/src/server.ts` 的 `readJsonBody` 直接执行 `JSON.parse`。JSON 文本语法错误会由外层 catch 捕获并返回 `500` message-only body。本次 1A 必须保持这一现状，不把 malformed JSON 改为 `400`。

JSON 能解析但字段结构非法，才由 request schema 边界校验返回 `400`。两者必须在测试和代码审查中明确区分。

### API Worker Client

- enqueue 的网络错误、非 2xx 或严格 response 校验失败，继续按当前方式记录错误并映射为 `HttpError(503, "agent worker unavailable")`。
- cancel 的网络错误、非 2xx 或 response 校验失败，继续按当前 best-effort 方式记录 warning；不改变上层取消流程。
- health 失败继续由 Worker Manager 的 ready 探测逻辑处理，不改变重启和就绪等待策略。

## 校验模式合同

环境变量：

```text
AWB_INTERNAL_RPC_RESPONSE_VALIDATION=strict|warn
```

- 默认 `strict`。
- `strict`：API Worker Client 的 enqueue/cancel response 校验失败按当前调用的失败语义处理。
- `warn`：API Worker Client 的 enqueue/cancel response schema 失败时输出明显 warning 后继续使用现有 response。
- 两种模式都必须执行 request 校验、鉴权、HTTP status 检查和业务逻辑。
- Worker Manager health ready probe 不使用该开关，不解析 health body，仍只按 2xx status 判定 ready。
- 非法配置值应在 API 启动配置解析时被拒绝，而不是静默回退。
- 该配置不进入数据库、Settings UI 或插件配置。

## 用户可见验收

不要求用户学习新操作。验收只需证明：

- 项目启动后 Worker health 正常。
- Web UI 可以按现有方式发起一个 Agent run。
- 一个真实 run 可以进入 Worker 并完成一个简单任务。
- 一个可持续运行的任务可以按现有方式取消。
- 多仓库 workspace 的 repo 目录名兼容行为不受影响。
