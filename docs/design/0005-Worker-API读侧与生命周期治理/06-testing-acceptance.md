# 测试、代码审查与验收

## 总体规则

- 每批先核对当前代码与本文基线，再冻结现状测试，再实施；不得用删除断言、扩大 `any`、改变 status 或跳过失败来“通过”。
- 1C 与 1D 分批审查。每批完成后必须由独立审查视角检查源码、测试、文档和范围；发现问题先修复，再独立复审；复审通过后才允许暂存该批。
- 测试不得输出 internal token、apiKey、完整 prompt/messages、tool args/result、archive 内容。
- 所有 race 测试优先使用可控 seam、transaction hook、fake runtime 或受控顺序，不使用无确定性 sleep 作为唯一证据。
- 行为断言应覆盖 DB 状态、副作用和 response shape，而不是只断言 HTTP status。

## Shared read-side contract 矩阵

| 场景 | 必须断言 |
|---|---|
| endpoint registry | 三个 endpoint method/path 与 Route 实际地址一致 |
| request schema | workspace/session/run 非空；messages appendMessage 的 role/content 边界 |
| execution profile response | resolved/agent/provider/model/runtime/vision/compaction 稳定外壳 |
| prompt response | head/system/messages/tools/pendingTools/token/locale/external roots 稳定外壳 |
| messages response | head/system/messages 稳定外壳；动态 content 可通过 |
| dynamic payload | content/inputSchema/args/options 不被过度深 schema 拒绝 |
| invalid response | strict 失败；warn 仅对 2xx+JSON+schema mismatch 继续 |
| export | `@agent-workbench/shared/internal-contracts/agent-api` 可导入；不需要深路径 |

## Read-side API Route/Service 测试

### 鉴权与 status

至少覆盖一个代表性 read-side endpoint，并对三接口表驱动覆盖：

- 无效 token + 非法 body 返回 `401`，而非 `400`；
- 合法 token + 非法 body 返回 `400`，Service 不执行；
- session 不存在返回当前 `404`；
- execution-profile/prompt-context run 不存在或归属不匹配返回 `404`；
- messages-context 不需要 runId；
- workspace mismatch 保持当前代码既有 status/body 语义；
- terminal run 不产生新的 read-side 特殊 status。

### Prompt context

保留并回归：

- tools/pendingTools 输出；
- reasoning 不进入 prompt messages；
- locale fallback；
- compaction snippet；
- static prompt 同 run cache 行为；
- external skill root 稳定字段。

至少增加或确认一项 cache 行为证据：同一 run 的 static promise/cache 仍复用，且协议迁移没有改变失效时机。

### Messages context

覆盖：

- appendMessage 只追加到响应，不写入 context item；
- active/session/global locale fallback；
- 完整 write 内容等动态 message content 不被截断；
- session-bound request 不需要 runId。

### Execution profile

覆盖：

- run 固定的 agent/provider/model；
- runtime settings/vision/compaction 下发；
- provider options 中当前 Worker 所需字段仍存在；
- response schema mismatch 不在 warning 中打印 secret 或 payload。

## Read-side Worker Client 测试

`apps/agent-worker/src/runtime/apiClient.test.ts` 至少覆盖：

| 场景 | strict | warn |
|---|---|---|
| 2xx + 合法 JSON + 合法 schema | 返回 typed body | 返回 typed body、无 warning |
| 2xx + 合法 JSON + schema mismatch | 抛错 | 继续返回 body、记录有限 warning |
| 2xx + 非 JSON | 抛错 | 抛错 |
| 401/404/500 | raw-body Error | raw-body Error |
| 网络失败/timeout | 抛错 | 抛错 |

### 真实 Worker read-side 集成证据

当前 `agent.worker.integration.test.ts` 主要证明四条真实 Worker 写回主链：`run-state`、context create、context update、`run-complete`。它不是现成的三 read-side 真实 Worker 覆盖证据。

P2 或 P7 必须在该文件新增受控 recorder/断言，证明 API-managed 的真实 Worker 至少发起一次：

```text
POST /api/internal/agent/execution-profile
POST /api/internal/agent/prompt-context
POST /api/internal/agent/messages-context
```

断言必须包含 method/path、最小 request 身份字段和每个调用的成功 response 消费；没有该新增证据时，验收只能声称 API integration、Worker Client 与 runner 测试覆盖，不能声称真实 Worker read-side 已验证。

每个 read-side 方法必须断言：

- method 来自 shared endpoint；
- URL 来自 shared endpoint；
- request body 完整匹配 shared type；
- response schema 与方法绑定；
- warning 不含 token、apiKey、prompt/messages、args/result、run/session 标识。

## Late append/update 测试

### Normal create baseline

继续证明正常 append：

- `200`；
- response `ok: true`；
- `item` 是完整 `AgentContextItemRecord`；
- session head 与 DB item 正常更新。

### Late append

必须构造以下场景：

- run 已 `completed`；
- run 已 `failed`；
- run 已 `cancelled`；
- session activeRunId 已切换到另一个 run；
- cancel transaction 已将 context/run-state 收敛但 Worker 迟到提交。

断言：

- 不新增 context item；
- 不改变 session head；
- 不改变 terminal run 状态；
- 不产生 todolist/session title 等新副作用；
- response 固定为 typed no-op `{ok:true,item:null,ignored:true}`；
- 正常 create 仍返回完整 record，且不得出现 `ignored`；
- 不允许用裸 `{ok:true}`、虚构 item 或其他未声明 response 掩盖 no-op 合同。

### Update

覆盖：

- item/run/session/workspace 归属不一致时拒绝；
- terminal item 的既有 ignored/terminal 行为保持；
- update 不逆转 terminal/cancelled；
- update 不创建 item；
- apply_patch artifact 既有副作用路径仍由测试覆盖；
- 迟到 update 不推进 session head 或 run-state。

## Recover/cancel 测试

### Cancel wins

使用 fake runtime 或可控 enqueue seam 构造：

1. recovery 扫描出 in-flight run；
2. 在 enqueue 前执行 cancel DB transaction；
3. 最终检查发现 run 已 terminal/cancelled；
4. 断言不调用 `runtime.enqueueRun()`。

另测：

- enqueue 已发出后再 cancel，DB 仍保持 cancel；
- runtime cancel 失败只 warning；
- late Worker write 被 fence 忽略；
- recover enqueue 失败不阻塞 recover 模式启动。

不得声称已发出的 enqueue 被强制停止，也不得声称完成完整 nested recovery。

## Lineage/orphan 测试

### Lineage

构造：

- child run 已有 `parentRunId`/`parentToolItemId`；
- parent tool output 尚未写入 `subtaskSessionId`；
- parent cancel/recovery 查询仍能找到 child；
- 历史 fork child 不因同 parent tool 误被取消。

断言 child 的 workspace、parent run 和 parent tool item 均精确匹配。

### Orphan suspect

表驱动覆盖：

| 条件 | 结果 |
|---|---|
| subtask、无 run、无 item、head=null、>1h | suspect 诊断 |
| 同上但 <1h | 非 suspect；不进入 scanner 诊断输出 |
| 有 run | 非 suspect；不进入 scanner 诊断输出 |
| 有 context item | 非 suspect；不进入 scanner 诊断输出 |
| head 非 null | 非 suspect；不进入 scanner 诊断输出 |
| suspect 但任一 forkedFrom 缺失 | retained 诊断，不删 |
| 双 forkedFrom 非空、>24h、删除前仍为空壳 | 允许自动删除 |
| 删除前出现 run/item/head | 放弃删除 |

还要验证：

- 启动扫描 best-effort，单个坏记录不阻塞启动；
- start 失败局部补偿只触及本次新建 session；
- existing reuse session 不被局部补偿删除；
- 不执行高频全量扫描。

## Archive sidecar 测试

至少建立窄测试 seam，覆盖：

1. rollback 全部成功：不生成 pending sidecar；
2. rollback skipped：生成 sidecar，字段完整且不含 archive 内容；
3. sidecar tmp+rename 写失败：只 warning，主流程继续；
4. 启动 reconcile，单文件 sidecar 的 currentSize 等于 expectedSize：truncate 到 beforeSize，成功后删除 sidecar；
5. 多文件 sidecar：不自动 truncate、不删除 sidecar，记录 warning；
6. 单文件尺寸不匹配：不 truncate、不删除 sidecar；
7. 文件缺失：不破坏处理，保留 sidecar；
8. sidecar 不完整/非法 JSON：保留或移入明确诊断路径，不影响启动；
9. 同 session 下一次 clear/compact 前触发 reconcile；
10. 日志不含 archive 内容、summary、prompt、messages、tool 数据或完整绝对路径。

不得把“rollback skipped 后文件一定无残留”作为验收条件。

## 代码审查清单

### 1C

- [ ] 三个 read-side endpoint 只有一个 shared method/path/schema 来源；
- [ ] Route 没有重复匿名 response contract；
- [ ] Client 没有三条硬编码 URL；
- [ ] strict/warn 不放宽 non-2xx、parse、网络或业务错误；
- [ ] 动态 payload 没被无意深 schema；
- [ ] cache、截断、locale、prompt 业务逻辑未变；
- [ ] warning 不泄露敏感字段。

### 1D

- [ ] fence 在 DB 写入边界而不是只在 Route 内存判断；
- [ ] late append 不创建 item；
- [ ] 正常 create 与 late no-op response 可区分且有 schema；
- [ ] update 归属和终态规则完整；
- [ ] cancel wins 有最终 DB 检查证据；
- [ ] lineage 不依赖 subtaskSessionId 回填；
- [ ] orphan scanner 只枚举空壳 suspect，自动删除条件保守且二次确认；
- [ ] sidecar 只处理 rollback skipped；仅单文件尺寸匹配时自动 reconcile，多文件和尺寸不匹配不破坏；
- [ ] 未引入排除项。

## 完成定义

建议执行并记录实际可用命令：

```bash
npm run build
npm run typecheck
npx tsx --test packages/shared/tests/*.test.ts
cd apps/api && npx tsx --test src/modules/agent/agent.integration.test.ts src/modules/agent/agent.worker.integration.test.ts src/modules/agent/context-item-contract.test.ts
cd apps/agent-worker && npx tsx --test src/runtime/apiClient.test.ts src/runtime/runner.auto-compact.test.ts src/runtime/tools/providers/builtin.prefork.test.ts
```

完成必须同时满足：

- shared build/export、API/Worker typecheck 通过；
- 1C 三接口 contract、Route、Client、validation 测试通过；
- 1D 四类治理测试通过；
- 相关既有主链测试无回归；
- 每批独立审查、修复、复审结论已记录；
- `git diff --check` 通过；
- 未修改非目标模块，未创建未审查的生产旁支。

## 回滚策略

- 1C 回滚单位：read-side shared contract + API Route + Worker Client + tests 一起回滚；不能只回滚 schema 或只回滚 Client。
- 1D late fence 回滚单位：Store/Service/Route response schema/Client/tests 一起回滚；若回滚会重新允许终态污染，必须先停止 Worker/API 混合部署。
- orphan scanner 可独立关闭自动删除，仅保留 suspect 诊断；删除逻辑必须有 feature/config seam 或小范围回退点。
- archive sidecar 可关闭 reconcile，但保留既有 best-effort rollback；sidecar 文件不得被无证据批量删除。
- 任一批次发现 response/状态机根本合同错误，停止后续批次，回退或修正该批，重新审查/复审。
