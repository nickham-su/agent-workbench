# 测试、审查、回滚与验收

## 总体测试原则

- 1A、1B 分开测试、审查和复审；
- 结构迁移前先保留 characterization evidence，迁移后验证等价行为；
- 关键 DB/HTTP/Worker 边界不能被 testkit 或 mock 隐藏；
- race 不使用无确定性 sleep 作为唯一证据；本阶段不新增 lifecycle race 语义；
- 测试不得输出 internal token、apiKey、完整 prompt/messages、tool args/result 或 archive 内容；
- 测试数量变化必须能解释，不能以删测试换取通过。

## 1A 测试矩阵

| 层级 | 目标 | 最低证据 |
|---|---|---|
| Testkit lifecycle | 临时目录、DB、AppContext、app、teardown | fixture 生命周期测试 |
| SQLite fixture | workspace/repo/session/run 可显式创建 | 真实 SQLite 断言 |
| Fake runtime | enqueue/cancel 记录与受控失败 | 单元/应用编排测试 |
| API route baseline | token/body/status/response 不漂移 | 真实 `createApp()` inject |
| API-managed Worker | 不因 fixture 提取而断链 | 保留现有真实集成测试 |
| CWD/cleanup | 正确 cwd、文件/进程清理 | 命令记录与 teardown 断言 |

1A 不需要新增覆盖所有 read-side 行为的测试；它必须证明 testkit 不会隐藏这些行为。

## 1A → 1B 验证门禁

P3 开始前必须能同时提供：

- `02-baseline-and-evidence.md` 与 `07-code-map.md` 的 P0 更新；
- 对应测试文件中的 characterization/contract 证据；
- `09-implementation-record.md` 中最近一次 P0-P2 命令结果和 1A 复审通过记录；
- 已冻结的 testkit 公共导出、默认值、fixture 生命周期、teardown 和 fake runtime 合同清单。

P3-P6 若只新增当前领域测试私有 helper，随当前批次验证。若修改公共 testkit 合同、默认语义、fixture 生命周期、资源所有权、fake runtime 合同或生产 seam，必须暂停当前批次，重新执行受影响的 1A 测试矩阵并完成独立审查、修复和复审。没有新的 1A 通过记录，不得恢复 1B。

## 1B 测试分层

### Shared contract

```text
packages/shared/tests/internal-contracts.test.ts
```

验证：

- 三个 read-side endpoint registry；
- request/response schema；
- public export；
- dynamic payload 边界；
- strict/warn 所需 response schema。

1B 原则上不修改 Shared contract 测试。若 import 路径调整，断言和通过结果必须保持等价。

### Read-side domain tests

建议在 `apps/api/src/modules/agent/` 测试目录中形成 read-side/prompt 领域测试文件，具体名称由实施方案依据实际迁移量决定。

#### 必须覆盖

| 责任面 | 最低必选证据 |
|---|---|
| Execution profile 归属 | session 不存在、workspace mismatch、run 不存在或归属不匹配，以及成功 profile 的 agent/provider/model/runtime/vision/compaction |
| Messages projection | transcript 顺序、reasoning 过滤、`appendMessage` 只进入响应且不新增 context item |
| Prompt context | static + dynamic 组合、tools/pendingTools、locale、compaction snippet 与 Shared response 外壳 |
| Prompt cache | run key 隔离、同 run Promise/value reuse、terminal invalidation/clear；TTL/访问续期若已有可控 seam，必须直接断言，否则必须由 characterization 证据和运行记录说明 |
| Facade 委派 | 三个 `AgentService` 兼容入口与新权威实现成功/错误 response 等价，且 facade 不保留第二套规则 |
| 只读边界 | execution-profile/prompt/messages 不写 run/context/session，`appendMessage` 不落库 |

上述最低证据可以分布在 domain、persistence 和 Route integration tests，但必须在 `09-implementation-record.md` 建立用例到测试文件的索引，不能只靠综合测试“可能覆盖”。

#### 建议覆盖

- 多种 locale fallback 组合；
- external skill roots、instruction 文件缺失/空内容与多来源组合；
- dynamic tool inputSchema/options/content 的复杂正例；
- 不同 session kind 或 profile surface 的组合；
- settings/plugin 读取失败或空集合的既有退化行为；
- cache TTL 到期和访问续期的可控 clock 边界组合。

需要真实 SQLite 的查询和归属测试使用真实 DB，不用只返回预设对象的 fake Store 替代。

### Route integration

通过真实 Fastify app 验证至少：

- 三 endpoint method/path；
- internal token 顺序；
- 非法 token + 非法 body 的 status 优先级；
- 合法 token + 非法 body 不调用 service；
- session/run 不存在、workspace mismatch 的既有 404/400；
- response schema 和 dynamic content；
- Route 不自行组装 prompt。

### Worker client

```text
apps/agent-worker/src/runtime/apiClient.test.ts
```

保留并回归：

| 响应 | strict | warn |
|---|---|---|
| 2xx + 合法 JSON + 合法 schema | typed body | typed body、无 warning |
| 2xx + schema mismatch | 抛错 | 返回 body、有限 warning |
| 2xx + 非 JSON | 抛错 | 抛错 |
| 401/404/500 | 保持现有 error | 保持现有 error |
| 网络错误/timeout | 抛错 | 抛错 |

1B 不改变 `AgentApiClient` 的合同调用方式；如果只改 API 内部结构，apiClient 只需回归而不应重写。

### Worker runtime / integrated

继续运行：

```text
apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

重点证明：

- Runner 仍按原顺序获取 profile/prompt/messages；
- auto-compact 输入输出未变；
- API-managed Worker read-side 链路可用；
- 本地 fallback runtime 兼容。

### UI 手工验收

若 1B 只做内部结构移动且 API/Worker/UI contract 完全不变，可由阶段审查决定是否缩减，但至少应说明理由。若执行完整验收，覆盖：

- 多轮对话与流式输出；
- 页面刷新和会话切换；
- 手动压缩后继续对话；
- 工具/skill/prompt 生效；
- artifact 读取不受影响。

## 自动验证最低集合

每个阶段批次根据改动范围选取，但 1B 结束至少包括：

```bash
npm run build
npm run typecheck
git diff --check
```

```bash
cd packages/shared
npm run build
npx tsx --test tests/internal-contracts.test.ts
npx tsc --noEmit --pretty false
```

```bash
cd apps/api
npx tsx --test \
  src/modules/agent/agent.integration.test.ts \
  src/modules/agent/agent.worker.integration.test.ts \
  src/modules/agent/<read-side-domain-test>.test.ts
npx tsc --noEmit --pretty false
```

```bash
cd apps/agent-worker
npx tsx --test \
  src/runtime/apiClient.test.ts \
  src/runtime/runner.auto-compact.test.ts \
  src/runtime/runner.tool-output.test.ts
npx tsc --noEmit --pretty false
```

`<read-side-domain-test>` 是阶段实施中确定的实际文件名，不在本方案中预冻结。若 1A 新增 testkit 测试，需加入相应命令。

## 独立审查清单

### 1A 审查

- 是否真的只提取最小公共 fixture；
- 是否隐藏真实 DB/HTTP/进程边界；
- 是否产生生产反向依赖或全局状态；
- 是否有代表性等价迁移；
- 是否已停止 testkit 独立扩张。

### 1B 审查

- Read-side / Prompt 是否有单一权威实现；
- `AgentService` 是否只委派；
- 新组件是否依赖完整 AppContext/AgentService；
- Route 是否承载业务规则；
- Shared contract 是否被无意修改；
- cache、prompt/messages、profile 输出和错误状态是否漂移；
- 是否误触 writeback/lifecycle/archive/subtask/Worker 主控制流；
- 是否保留真实 API↔Worker 证据；
- 是否有双实现、循环依赖、重复 DB/文件读取或日志泄露。

最终阶段审查必须采用新审查视角，并对照：

```text
0006 总体治理蓝图
0005 Worker-API 读侧与生命周期治理
本阶段阶段性实施方案
最终代码地图与测试证据
09-implementation-record.md 中的基线、运行和门禁记录
```

## 回滚策略

### 1A 回滚

- 1A 不修改生产 schema、合同和业务实现；
- 如 testkit 迁移造成失败，优先回退测试支持目录和已迁移测试，恢复原 fixture；
- 不通过修改生产代码迁就 testkit；
- 保留基线记录，重新设计后再进入 1A。

### 1B 回滚

- 每个 read-side 用例批次保持 facade 入口；
- 如果新组件出现行为差异，回退该用例的委派和新组件调用，恢复原 service 权威实现；
- 回滚不得同时触碰后续 writeback/lifecycle 代码；
- 如果合同、cache 或模型输入改变，停止该批，保留失败证据并更新方案；
- 通过删除未完成的新组件和恢复 facade 实现，应能独立回到 1B 前状态。

回滚不是长期双实现许可。若短期回退产生新旧代码并存，必须明确权威路径、清理条件和期限。

## 阶段验收标准

### 1A

- 基线证据完整；
- testkit 最小能力可用且可清理；
- 至少代表性测试等价迁移；
- 真实 SQLite/Fastify/API-managed Worker 证据保留；
- testkit 没有成为长期独立工程；
- 独立审查和复审通过。

### 1B

- 三个 read-side 用例权威实现完成职责收敛；
- `AgentService` 兼容入口稳定；
- Shared contract、Route、Worker client 和 runtime validation 无漂移；
- profile/prompt/messages/cache characterization 与集成证据通过；
- no writeback/lifecycle/archive/subtask/Worker 主控制流混入；
- 构建、类型、定向测试、必要 UI 验收通过；
- 新审查视角全面审查通过；
- 代码地图与文档同步。

## 阶段完成后的交接

完成后应更新：

- 本阶段文档状态和实际差异；
- `0006` 总方案中的路线状态（若项目采用状态记录）；
- Read-side 新职责组件代码地图；
- testkit 能力清单及其冻结边界；
- 下一阶段 Context Writeback 方案的前置输入和未解决依赖。
