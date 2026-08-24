# 冻结决策、取舍与暂停条件

## 范围与组织决策

### 只统一九个核心写回 endpoint

选择 run、context 和 subtask 生命周期九接口，是因为它们共同构成 Worker 对 API 的核心写入闭环，且已有成熟的实际调用与测试基础。execution profile、prompt/messages context 属于 read-side；archive/plugins/git-env/mcp-settings 属于其他协议族，纳入会使迁移无法按业务生命周期验收。

### 固定四批顺序

```text
run-state/run-complete
  -> context-items create/update
  -> context/compact
  -> subtask prefork-plan/start/result/status
```

run 是所有后续生命周期的最小状态底座；context create/update 是 compaction 的直接前置；subtask 涉及身份、reuse、fork、恢复和取消，风险最高，最后处理。不得为了“顺手共享类型”打乱顺序。

### 继续使用现有 shared，新增唯一公开入口

选择：

```text
@agent-workbench/shared/internal-contracts/agent-api
```

作为唯一新增 public export。内部用 `agent-api-run.ts`、`agent-api-context.ts`、`agent-api-subtask.ts` 分领域拆分，再由 `agent-api.ts` re-export。

不选择独立 contracts workspace 或逐领域多个 public subpath，原因是当前仓库内 API 负责启动 Worker，新增 workspace 会引入构建、依赖、发布与迁移成本，而多个外部入口会过早固化内部文件边界。

### 原子迁移，无版本化与长期兼容层

每批必须一起变更 shared schema、API Route、Worker Client 和测试。不同版本 Worker/API 并存不是当前主力单用户工具的目标；不添加 `protocolVersion`、双 schema、兼容 adapter 或可长期保留的 feature flag。

## 行为保留决策

### 保持全局 onRequest 鉴权行为

当前全局 `onRequest` hook 已在 Fastify schema validation 前执行 token 鉴权，依据 `apps/api/src/app/auth.ts:15-28`。因此真实顺序是：

```text
global onRequest token auth -> schema validation -> handler/Service
```

无效 token + 无效 body 当前返回 `401`，这是可观察 HTTP 合同。方案 A 选择保持该行为：不移动鉴权 hook、不将 token 检查移到 `preValidation`，避免扩大 1B 范围，也不改变其他 `/api/internal/*` 路由的错误优先级。handler 内既有 `assertInternalToken()` 可继续作为防御性检查，但不作为通常请求的主要鉴权步骤。本期合同以全局 hook 优先为准。

### 未知字段按 endpoint 的真实现状建模

不制定“request 宽松 / response 严格”的全局口号，也不全局增加 `additionalProperties:false`。默认 object 的未知字段保留；`preforkMeta` 的 strict object 在当前 Fastify/AJV 运行时行为中剥离未知字段；`start.session` 的 `new`/`fork` member 必须继续宽松，确保额外 `sessionId` 仍由 Service 返回 `AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED`。同时保留 `existing.sessionId` 的 schema 必填：其缺失是 Route validation `400`，不是 Service error。

### Run ignored 保持成功确认

RS-1~RS-3、RC-1~RC-3 继续 `200 {ok:true}`，不添加 `applied:false`，不改 `404/409`。这保留 Worker completion/state 上报对迟到、重复和终态写回的容忍性，并避免对 Runner 增加分支。测试和文档而非 warning 日志是 ignored 行为的证据。

### 保留 Context conflict、terminal ignored 和 Compaction 双 409

- Context create 的 head 冲突仍由 `conflict_head:*` 表示，并由 Worker 转 `ApiConflictError`。
- Context update terminal item 返回原 item；不把 ignored 改为 conflict。不得承诺 artifact 无副作用。
- Compaction 的 Service 前置 `409` 无 code，Store CAS `409` 有 `conflict_head:*`；不为表面统一而改错误 body。archive 文件的追加/回滚与 DB transaction 的边界也保持不变。

### Context output 有意收紧非法内部输入

Route `Type.Any()` 并不是兼容承诺。已知非法 tool output 可被接受，随后导致 response serialization `500`。选择直接复用 `AgentContextItemOutputSchema`，使当前合法 Worker output 不变，并把非法 payload 前移为 schema validation `400`。

这是本期唯一明确接受范围改变：只承诺公共 schema 表达的合法 output；动态 `args/result` 保持 `Type.Any()`，不建设全量工具结果精确 schema。审查与测试必须明确证明该改变，而不能将它掩盖为纯重构。

### 严格成功响应、有限 warn

所有九个 endpoint 的关键 success response 在 Worker `AgentApiClient` 使用 TypeBox runtime validation。`strict` 是默认失败安全模式；`warn` 是迁移保险丝，而不是运行时普遍容错：仅 2xx + 可解析 JSON + success schema mismatch 可继续，且须有不含完整敏感 body 的 warning。非 2xx、冲突、鉴权、网络、timeout、JSON 解析失败均不可绕过。

不新增 Worker → API transport timeout/retry；Runner 已有 completion fallback/retry 等业务层特定补偿，不得以 Client 通用 retry 替换。

### 保持非 2xx raw-body parser 现实

尽管当前代码意图读取 `message/code`，其结构化 Error 被同一 `try/catch` 吞掉。Worker 实际只得到 raw response body 文本。1B 不修此缺陷、不为 error body 加 runtime schema、不让 Worker 按 code 做分支。只有 context create/compact 的 `conflictAsError` 保留特殊转换；subtask `409` 不得改为 `ApiConflictError`。

### Subtask reuse 是 identity 幂等，不是副作用幂等

唯一约束保证 `(parentRunId,parentToolItemId)` 只绑定一个 child run。`new/fork` 可能先创建 session，再进入主 transaction。因此错误和 unique race 后都可能遗留 session；不得承诺 start 原子创建全部资源或 `reused:true` 无副作用。本期冻结与暴露该事实，不做 orphan session cleanup/transaction 改造。

### Recover/cancel 只保证主要 DB 级联

恢复不重建 Worker Runner 内存 nested mapping。public cancel 通过 DB 中 parent tool item 的 `subtaskSessionId` 递归发现 child，并在 DB transaction 内收敛 parent/child context、run-state、running run，事务后分别调用 runtime cancel。该机制是主要保障，但不承诺线性化：recover enqueue/cancel 可交错、terminal run 可能迟到 append context、start 成功到写 parent tool metadata 间有窗口。

## 类型与公共 schema 决策

- Route 和 Worker Client 必须引用 shared endpoint/schema/type；Route 不得保留等价匿名 request 类型或以 `as any` 穿透 HTTP 边界。
- Service 是业务层。简单场景可直接使用 shared type；需整形时允许保留业务类型，但必须显式映射，不复制等价 HTTP 类型。
- Runner 不复制 Route request validation；Service 保持既有业务防御与不变量。
- 默认不修改 `packages/shared/src/contracts/*`。本期仅复用已存在且已验证兼容的 `AgentContextItemOutputSchema`、`AgentContextItemRecordSchema`。若发现公共 schema 必须改变，立即暂停相应批次，评估 API/Web/Store 影响、补回归测试，并在审查中单独批准。

## 暂停触发条件

出现任一情况必须停止当前批次，不以类型断言或删测试继续：

- 当前 Route/Client/Service/Store 行为与本目录冻结合同不一致，且无法由现有测试或代码解释。
- 共享 schema 无法表达当前合法 Worker payload，或收紧会影响合法 payload。
- 公共 schema 需要修改而影响范围未评估。
- endpoint status、error body、ignored/conflict 或副作用边界被无意改变。
- strict/warn 需要绕过 non-2xx、parse、network、timeout 或业务 conflict 才能通过测试。
- 后批发现前批合同根本错误。

处理顺序：记录事实 → 更新产品合同/代码地图和基线测试 → 回修受影响前批 → 独立审查、修复、复审、暂存 → 再继续。
