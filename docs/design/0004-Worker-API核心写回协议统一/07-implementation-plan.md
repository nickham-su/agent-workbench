# 开发任务拆分与实施步骤

## 全局执行规则

- 每项只覆盖本目录授权的协议边界；不修改业务语义，唯一例外是 P1-2 有意拒绝非法 context output。
- 固定节奏：冻结当前行为 → 实施 → 最小测试 → 独立代码审查 → 修复 → 独立复审 → 暂存该批 → 下一批。
- 后批发现前批合同根本错误时，必须暂停并回修前批；前批重新审查、复审、暂存后才能继续。
- 每批开始前复核 [05-code-map.md](./05-code-map.md) 的行号和 [02-product-contract.md](./02-product-contract.md) 的合同；差异未解释前不得编码。

## P0-0：冻结基线

**文件**：不新增生产实现；补充或确认 `agent.integration.test.ts`、`agent.worker.integration.test.ts`、Worker runner/client 测试的基线证据。

**改动**：记录九接口当前 method/path/body/params/success/status；冻结 schema-first token 顺序、unknown field 行为、RS/RC ignored、context conflict/terminal ignored、compact 双 409、subtask error code/reuse/partial result、recover cancel 主行为。

**禁止改动**：shared exports、Route schema、Client、Service、Store、Manager；不得“边调研边修复”。

**完成条件**：所有事实能由代码或测试解释；Context public output 与现有合法 Worker output 的兼容性有证据；无未处理阻塞矛盾。

**测试**：运行 shared build、API/Worker typecheck 和相关现有集成/runner 测试；添加仅用于冻结的失败回归测试时先确认其对现状通过。

**审查/暂存/回滚**：独立审查基线摘要；本阶段不单独暂存生产改动。发现矛盾即停止，更新设计证据后重新冻结。

## P0-1：建立 shared `agent-api` 合同与唯一 export

**文件**：

```text
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/src/internal-contracts/agent-api-run.ts
packages/shared/src/internal-contracts/agent-api-context.ts
packages/shared/src/internal-contracts/agent-api-subtask.ts
packages/shared/package.json
packages/shared/tests/internal-contracts.test.ts
```

**改动**：定义九 endpoint registry、path builder、request/params/success response schema/type；复用 public context schema；仅新增 `./internal-contracts/agent-api` export；为 stable subtask code 建立最小常量集合。

**禁止改动**：不修改 `contracts/agent.ts`，不改根 index，不新增 workspace/通配 exports，不迁移 Route/Client，不引入 HTTP/error framework。

**完成条件**：shared build 生成可导入 JS/declaration；只存在一个新增公开入口；schema 精确表达 literal ok、context record、compact/subtask response。

**测试**：shared TypeBox 正反例、export smoke、合法 Worker output、非法 tool name、path builder、stable code 常量。

**审查/暂存/回滚**：审查 schema 是否复制真实现状、未过度 strict；复审通过后暂存 shared+tests。回滚必须整体回退，不留下无消费者的 public API。

## P1-1：Run（run-state / run-complete）

**文件**：`agent-api-run.ts`/聚合入口、`agent.routes.ts`、`agent.service.ts`（只在显式映射确有需要时）、`apiClient.ts`、Run/API Client 测试。

**改动**：Route/Client 使用共享 method/path/schema/type；success response 收紧为 literal `{ok:true}`；Client 对两接口做 runtime success validation；保留 Service ignored 分支。

**禁止改动**：不得把 RS/RC 改为 404/409/applied；不得改 run-state machine、completion fallback、events、transaction、timeout/retry 或 token 顺序。

**完成条件**：RS-1~3、RC-1~3 都是 200 literal ok 且 DB 不变；正常写回无回归；strict/warn 可验证。

**测试**：冻结表中全部 Run 场景，Client strict/warn/non2xx，API schema-first token 代表场景。

**审查/暂存/回滚**：审查 ignored 语义和 ok literal；修复后复审、暂存 Run 的 shared/Route/Client/tests 原子集。失败时整体回退该集。

## P1-2：Context（create / update）

**文件**：`agent-api-context.ts`/聚合入口、`agent.routes.ts`、必要的显式 Service 映射、`apiClient.ts`、context/runner/API tests。

**改动**：create/update request output 直接复用 `AgentContextItemOutputSchema`；success 使用 `{ok:true,item:AgentContextItemRecordSchema}`；Client 完整验证 response 但继续只返回 item id 给 Runner。

**禁止改动**：不得把非法任意 `Type.Any` 说成兼容；不得改 Store normalize、artifact、terminal ignored、head CAS、Runner conflict 停止逻辑；不得为 update 新加 workspace/session。

**完成条件**：所有合法 Worker output 可通过；非法 output 在 request validation 失败、不再造成 response serializer 500；create conflict 仍转 `ApiConflictError`；terminal update 仍返回原 item。

**测试**：合法 output 矩阵、非法 tool name、完整 record schema、head conflict、terminal ignored/可能 artifact 副作用、strict/warn。

**审查/暂存/回滚**：审查必须确认“有意收紧”写在代码注释/测试/变更说明中；复审通过后暂存。若合法 output 不兼容，立即停止并回修此批，不以 `as any` 绕过。

## P1-3：Compaction

**文件**：`agent-api-context.ts`/聚合入口、`agent.routes.ts`、`apiClient.ts`、compaction service/store/API/runner tests。

**改动**：共享 compact endpoint/request/精确 success response；Client runtime validation；保持 `conflictAsError:true`。

**禁止改动**：不得把 response 改成 ok wrapper；不得统一两种 409 body/code；不得改 archive 文件格式、rollback、Store transaction、run-state、自动 retry 或 body limit。

**完成条件**：前置检查和 Store CAS 两条 409 都保持；DB 未提交结论成立；文件 rollback 仍 best-effort；Worker 将两者都视作 `ApiConflictError` 且不 retry。

**测试**：正常 compact、两条 409、archive rollback/诊断、Client strict/warn/non2xx、Runner stop 行为。

**审查/暂存/回滚**：重点审查全局原子性误承诺；复审后暂存该批原子集。若 conflict body/副作用意外变化，整体回退并先修基线。

## P1-4：Subtask（prefork-plan / start / result / status）

**文件**：`agent-api-subtask.ts`/聚合入口、`agent.routes.ts`、必要 Service 显式映射、`apiClient.ts`、builtin/runner/API integration tests、可能的 `errors.ts` 最小稳定 code 常量。

**改动**：四接口使用共享 request/response/path/method；Client runtime validation；保留 session union 与 preforkMeta 行为；配置/Client 统一接入至本批所有 success response。

**禁止改动**：不得重构 subtask transaction、session 创建顺序、depth/state machine、unique index、recover/cancel、error parser；不得将 subtask 409 转 `ApiConflictError`、按 code retry 或结构化消费 code。

**完成条件**：prefork 95/default/降级、start identity reuse、全部 stable error code/status、partial result/status、raw-body non2xx 都有证据；`reused:true` 的幂等范围与前置 session 副作用被测试/说明保留。

**测试**：稳定错误码逐项并标明 Route/Service 可达层级；new/fork 额外 `sessionId` 的 Service `AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED` 与 existing 缺 `sessionId` 的 Route schema `400` 分别断言；`AGENT_SUBTASK_EXISTING_SESSION_REQUIRED` 仅以直接 Service 防御性测试覆盖。其余覆盖 preforkMeta unknown-field 剥离、并发/unique 分支、空白 prompt orphan 风险、result/status、subtask 409 普通 Error、parent cancel DB cascade 主行为。

**审查/暂存/回滚**：审查重点为业务错误优先级、identity 非副作用幂等、recover/cancel 非线性化；复审通过后暂存。不要将并发不稳定当作事务重构理由。

## P2：cleanup

**文件**：所有本期已改文件及测试，限定九接口。

**改动**：搜索硬编码 path、重复匿名 HTTP 类型、`ok:boolean`、旧 Client generic response；清理已无调用的局部类型。核对 Manager spawn env、Worker env/main 注入和 shared export。

**禁止改动**：不扩展至 execution-profile/prompt/messages、archive/plugins/git-env/mcp-settings 或任何列明非目标。

**完成条件**：九接口无旧硬编码 path/重复边界 schema；只新增一个 public export；无 `as any` 跨新边界。

**测试**：相关完整自动测试、shared build、API/Worker typecheck。

**审查/暂存/回滚**：独立清理审查；仅暂存清理确实属于本期的改动。发现范围蔓延则撤出该项，不重写相邻模块。

## P2：全面审查与最终手动验收

**文件**：实现与本设计全部文件；不需要新增生产功能。

**改动**：按 [06-testing-acceptance.md](./06-testing-acceptance.md) 运行最终自动/手测，完成全新审查员的端到端审查、问题修复和独立复审。

**禁止改动**：不得为通过验收临时放宽 strict、跳过 warning、删减负例或扩大范围。

**完成条件**：完成定义全部满足；审查结论无阻断/高风险未解决项；保留已知非目标风险记录。

**测试**：完整命令、九接口矩阵、strict/warn、主力 run/compact/subtask/cancel 手测。

**审查/暂存/回滚**：最终审查 → 修复 → 复审 → 暂存最终测试/清理。若最终发现前批根本问题，回到对应 P1 批次重新执行其审查链，不进行“最终阶段热修”。
