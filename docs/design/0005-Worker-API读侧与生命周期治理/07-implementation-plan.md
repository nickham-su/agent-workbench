# 开发任务拆分与详细实施步骤

## 全局节奏

固定节奏：

```text
调研/冻结
  → 小批实现
  → 单元/集成测试
  → 独立代码审查
  → 修复
  → 独立复审
  → 暂存该批
  → 下一批
```

原则：

- 每批开始前复核 [02-product-contract.md](./02-product-contract.md) 和 [05-code-map.md](./05-code-map.md)；
- 发现真实代码与文档不一致，暂停编码并更新设计/测试证据；
- 不把多个生命周期问题混在 read-side contract 迁移批次中；
- 每一批只修改授权文件和必要测试；
- 不创建 commit、不推送远程；暂存必须由用户明确允许时执行。

## P0：冻结基线

### 任务

- 记录三 read-side endpoint 的实际 request/response/status；
- 核对 Worker 三个方法的真实调用点；
- 核对 `runPromptStaticCache` key/TTL/失效；
- 核对当前鉴权顺序与 400/401/404；
- 记录 append/update、cancel/recover、subtask lineage、archive rollback 的现状；
- 补充缺失的冻结测试，但不得先改生产逻辑。

### 完成条件

- 代码地图行号已复核；
- 每项现状都有源码或测试证据；
- 正常 Context create 完整 response 已有测试；
- late append 的实际现状已单独记录；
- archive snapshots 的真实字段已确认。

### 审查边界

P0 不修改生产实现，不单独暂存；基线审查通过后才进入 P1。

## P1：Shared read-side contract

### 任务文件

```text
packages/shared/src/internal-contracts/agent-api-read.ts
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/tests/internal-contracts.test.ts
```

### 实施步骤

1. 为三个 endpoint 增加 method/path registry；
2. 定义 request schema/type；
3. 定义 stable response schema/type；
4. 明确 dynamic content/options/args 的宽松边界；
5. 添加 export smoke、正例和负例。

P1 只处理三个 read-side endpoint。不得修改 `agent-api-context.ts`、Context create success response 或 late no-op schema；这些 1D 改动全部留在 P3。

### 禁止

- 不修改 shared public contracts 的业务含义；
- 不迁移 archive/plugins/git-env/mcp-settings；
- 不新增 workspace、通配 exports、错误框架；
- 不把动态 response 全部变成 `Any`。

### 审查与暂存

审查重点是 export 唯一性、schema 稳定外壳、动态边界和 1B compatibility。通过复审后才暂存 P1。

## P2：API Route 与 Worker Client 迁移

### API 任务

修改：

```text
apps/api/src/modules/agent/agent.routes.ts
```

步骤：

1. 三个 Route body 改用 shared request schema；
2. response 200 改用 shared success schema；
3. ErrorResponse status 映射保持；
4. handler 继续调用原 Service 方法；
5. 复核鉴权顺序、unknown fields、Fastify serializer 行为。

### Worker 任务

修改：

```text
apps/agent-worker/src/runtime/apiClient.ts
```

步骤：

1. 引入 shared endpoint/schema/type；
2. 将三个直接 fetch 改为统一 `request()`；
3. 接入 strict/warn success validation；
4. 将 diagnostics 限定为 endpoint/路径/类型摘要；
5. 增加 method/path/body/strict/warn/non-2xx 测试；
6. 运行 runner 主链回归；
7. 新增真实 API-managed Worker read-side recorder/断言，覆盖 execution-profile、prompt-context、messages-context。当前 `agent.worker.integration.test.ts` 的四条真实 Worker 写回主链证据不构成这三项 read-side 证据。

### 审查与暂存

P2 必须证明业务 Service 未被重构，cache、prompt/messages 内容、敏感 response 字段没有无授权改变。独立审查/复审通过后才暂存 1C。

## P3：Late append/update fence

### 任务文件

```text
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.routes.ts
packages/shared/src/internal-contracts/agent-api-context.ts
apps/agent-worker/src/runtime/apiClient.ts
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

1. 在 Store/Service 中确定可原子执行的 run/session/item 状态检查；
2. 在 append 实际写入前检查 run terminal/cancelled、activeRunId 和归属；
3. late append 不创建 item、不推进 head、不产生标题等副作用；
4. 在 `agent-api-context.ts` 中实施 1D 对 1B Context create success contract 的受控扩展：normal `{ok:true,item:AgentContextItemRecord}`；late no-op 固定 `{ok:true,item:null,ignored:true}`；
5. 同一 P3 批次同步迁移 Route、Worker Client typed response 和测试；
6. 正常 create 仍返回完整 record，且不得出现 `ignored`；
7. update 增加 item/run/session/workspace 归属检查和终态单向约束；
8. 保留 apply_patch artifact 与既有 terminal update 真实行为；
9. 增加 transaction/race 测试，证明不是只在 Route 层判断。

### 关键停止条件

如果无法在现有 DB 操作边界内实现“检查与 append”一致，停止 P3，不使用内存锁猜测解决；先补 Store helper 或更新设计。

### 审查重点

- no-op response 不得伪造 item；
- 正常/late response schema 可区分；
- 不得把所有 append conflict 误当 late ignored；
- terminal update 不得逆转；
- 既有 head conflict 与 1B 合同不回归。

## P4：Recover/cancel fence

### 任务文件

```text
apps/api/src/modules/agent/agent.module.ts
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.integration.test.ts
```

### 实施步骤

1. 保留现有 recover scan；
2. 为每个 candidate 在 enqueue 前重新读取 run/session/run-state；
3. 只对仍 in-flight、归属匹配且 session 仍允许执行的 run 调用 enqueue；
4. skip cancel/terminal candidate；
5. 保持 recover enqueue failure 不阻塞启动；
6. cancel 继续先 DB 后 runtime；
7. 增加可控 race 测试与 runtime cancel failure 测试。

### 不得承诺

- 已发出 enqueue 被强制停止；
- 完整 nested runtime recovery；
- lease/epoch/durable event。

## P5：Subtask lineage 与 orphan

### 任务文件

```text
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.store.ts
apps/api/src/modules/agent/agent.module.ts
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
```

### 实施步骤

1. 核对 run 表 parent 字段与现有查询；
2. 让 child cascade/recovery/diagnostic 查询以 `parentRunId + parentToolItemId` 为准；
3. 保留 `subtaskSessionId` 回填用于展示，不将其作为唯一条件；
4. 实现启动 orphan scanner，只枚举 `>1h`、head=null、无 run、无 context item 的空壳 suspect；
5. 对 suspect 输出诊断；非-suspect 不属于 scanner 的诊断输出范围；
6. 仅对 suspect 中 `>24h`、双 forkedFrom 非空、删除前仍空壳的对象自动删除；
7. 在 start 失败/unique race 分支保存本次新建 session id，做局部二次确认和补偿；
8. existing reuse 不能进入新建 session 补偿路径；
9. 单个扫描异常不得阻塞启动。

### 审查重点

- 自动删除条件是否足够保守；
- 是否可能删除 future existing reuse session；
- 是否误把 forkedFrom 字段当 parent lineage；
- 是否引入高频全量扫描或隐式后台任务。

## P6：Archive pending reconciliation

### 任务文件

```text
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.module.ts
apps/api/src/infra/fs/paths.ts（仅在需要安全路径 helper 时）
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
```

### 实施步骤

1. 复核 `appendArchiveLines()` snapshots；
2. 定义 sidecar 相对路径和 versioned record；
3. 仅在 rollback skipped 时 tmp+rename 写 sidecar；
4. 启动时 best-effort 扫描；
5. 同 session clear/compact 前 best-effort reconcile；
6. 仅对恰有一个 snapshot 的 sidecar，在 currentSize 精确等于 expectedSize 时 truncate；
7. 多文件 sidecar 只 warning 并保留，不做自动 truncate；
8. 单文件尺寸不符/缺失/记录不完整时保留 sidecar；
9. 单文件 truncate 成功后删除 sidecar；
10. 写 sidecar/reconcile 失败不影响 DB 主流程；
11. 用窄测试 seam 覆盖 rollback skipped、size mismatch 和 sidecar 写失败。

### 审查重点

- 是否改变 archive 文件格式；
- 是否扩大 DB transaction；
- 是否存在无尺寸检查 truncate；
- 是否错误自动处理多文件 sidecar；
- 是否日志泄露 archive 内容或绝对路径；
- 是否把 sidecar 失败升级成主请求失败。

## P7：最终集成与验收

### 执行

- 根 build/typecheck；
- Shared tests；
- API agent integration/context contract/worker integration；
- Worker apiClient/runner/prefork tests；
- `git diff --check`；
- 真实 API-managed Worker 主链手测；
- recovery/cancel/subtask/archive 受控场景手测。

### 最终审查

必须由全新审查视角对照本目录全部文件和当前实现检查：

- 范围是否越界；
- response/status/schema 是否一致；
- race/no-op/lineage/orphan/sidecar 证据是否真实；
- 文档是否仍与实现相符。

通过后才能由用户决定是否暂存/提交。

## 批次回滚

- 1C shared/Route/Client/test 必须作为整体回滚；
- P3 response schema 与 Service fence 必须整体回滚，不能只撤掉 DB fence；
- P4/P5/P6 可按功能批次回滚，但保留已有 1B 行为；
- orphan 自动删除可以先关闭而保留 suspect 诊断；
- sidecar reconcile 可以停止但不得批量删除 pending records；
- 发现合同根本错误时停止后续批，修复并重新审查/复审。
