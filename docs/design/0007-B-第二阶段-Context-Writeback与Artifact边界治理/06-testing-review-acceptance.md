# 测试、审查、回滚与验收

## 总体原则

- 先冻结行为证据，再移动结构；
- application 单测不能替代真实 SQLite fence/CAS；
- Route/Shared/Worker client/API-managed Worker 证据必须保留；
- race 使用 transaction hook、受控顺序或同步 seam，不以不确定 sleep 作为唯一证据；
- 测试不得打印 internal token、完整 tool args/result、artifact JSON、绝对敏感路径或用户内容；
- 测试迁移前后必须核对用例、断言和副作用，不能以删测试换取通过；
- archive/compaction 测试不因同文件而自动进入本阶段。

## 测试分层

### Shared contract tests

权威文件：

```text
packages/shared/tests/internal-contracts.test.ts
```

最低证据：

- endpoint registry 的 create/update method/path；
- path builder 正整数校验；
- create request/output schema；
- create normal response；
- create `{ item:null, ignored:true }`；
- 非法混合 response 被拒绝；
- update request/response；
- aggregate export 不漂移。

结构治理默认不修改 Shared tests 的预期。如果测试必须变化，先判断是否触发合同停止条件。

### Persistence behavior tests

必须使用真实 SQLite，覆盖：

- append 同 transaction 内 session/workspace/run/active-run fence；
- `prevId` / head CAS；
- ordinary conflict 与 late ignored 区分；
- missing run 不进入 ignored；
- append ignored 不新增 item、不推进 head、不 touch 非预期状态；
- update item/session/workspace/run ownership；
- terminal item unchanged；
- terminal/switched run unchanged；
- final update fence 在竞态下权威；
- 状态不从 terminal 回退；
- persistence result union 与 application 映射一致。

不得使用 fake Store 代替上述证据。

### Domain use-case tests

围绕 Context Writeback application 验证：

- create Store 结果到 response/error 的映射；
- conflict warning 的有限字段；
- apply_patch completed-on-create 拒绝；
- todolist title 只在成功 append/update 后调用；
- update 初步 fence 的早返回；
- update final fence 的 unchanged 映射；
- artifact collaborator 的触发条件与调用顺序；
- artifact 失败后仍继续 slim DB update；
- facade 参数、返回值、同步/异步错误透传。

可 stub 窄 capability 验证应用编排，但每条关键 Store 规则必须另有 SQLite 测试。

### Route integration tests

使用真实 Fastify app，覆盖：

- internal token 与 schema 行为；
- create/update method/path；
- params/body schema；
- normal/ignored/update response shape；
- `400/401/404/409` 当前 status/body；
- Route 只连接 facade，不复制 fence/ownership/artifact 判断。

### Artifact tests

需要同时有 capability 级安全测试和 API/Query 集成测试。

最低证据：

- apply_patch completed：full result 写 artifact，DB result 瘦身，Query 可读；
- artifact 文件缺失、非普通文件、no-follow 读取失败或 JSON 损坏返回既有 404；
- root containment、symlink、realpath、普通文件和 no-follow 规则；
- realpath/containment/symlink 失败的当前 API status/body 有 characterization，迁移前后保持一致；
- 写失败/路径失败保留当前 best-effort 行为；
- 初步 fence unchanged 不写 artifact；
- final fence unchanged 时的当前文件副作用事实有 characterization；
- 日志不输出 artifact payload 或 tool 内容。

P0 已由 `updateContextItemFromWorker()` 的明确生成代码和定向集成测试确认 write 属于 API writeback 主链。因此 write completed/failed/cancelled、args/result、artifact 与 Query 都是本阶段最低验收矩阵；其 completed-only split/write 规则不得被 apply_patch 的规则覆盖。

### API-managed Worker

权威文件：

```text
apps/api/src/modules/agent/agent.worker.integration.test.ts
```

必须保留真实 Worker 进程、HTTP/internal RPC 和写回顺序证据：

```text
context create
  → run-state
  → context update
  → run-complete
```

关键顺序：

```text
run-state < context update < run-complete
```

该测试专属的端口、socket、pid-file、LLM HTTP stub 不纳入公共 testkit。

### Worker client tests

权威文件：

```text
apps/agent-worker/src/runtime/apiClient.test.ts
```

最低证据：

- create/update Shared endpoint；
- update path builder；
- complete record；
- late ignored create；
- create `409` → `ApiConflictError`；
- update 非 2xx 仍为普通 request error；
- strict/warn schema mismatch；
- warning 脱敏。

### Worker runtime regression

本阶段不修改 Runner，但 P6 至少运行与 context writeback/tool output 相关回归，证明 API 结构变化未破坏：

- context create/update 调用；
- tool output；
- auto-compaction 相邻顺序；
- run completion 前 update。

实际文件在 P0 复核后记录。

## 核心测试文件与归属

### `context-item-contract.test.ts`

它是本阶段核心，但当前同时包含：

- context writeback；
- compaction；
- archive rollback；
- pending sidecar fault。

本阶段处理方式：

- P0 建立精确 writeback 用例索引；
- P1/P3/P4 可将纯 writeback 用例迁到领域文件；
- archive/compaction 用例继续留在原文件或后续阶段；
- 不为拆文件而复制测试长期双跑；
- 不要求阶段完成时清空原文件。

### `agent.integration.test.ts`

保留 artifact 与真实 Context Query/FS/SQLite 证据。可以迁移局部能力测试，但复杂 UI artifact 链路若留在综合文件更能保护真实边界，应记录理由而非强拆。

## 0007-A testkit 使用门禁

已冻结公共面：

```text
createAgentTestFixture()
resolveAgentApiTestRepoRoot()
createTestWorkspace()
createTestRepository()
injectJson()
createFakeAgentRuntime()
```

本阶段默认：

- 复用，不扩张；
- session/run/context builder 优先作为 writeback 测试私有 helper；
- 真实 SQLite 和 Fastify 不替换为 fake；
- Worker 专属进程资源不抽入公共面。

只有同时满足以下条件才允许公共扩展：

- 两个以上独立测试文件以相同语义需要；
- 无法通过显式 Store 调用和私有 helper 清晰表达；
- 不改变既有默认语义/资源所有权/fake runtime 合同；
- 更新 0007-A testkit 设计与回归；
- 独立审查、修复、复审通过后才恢复当前批次。

若修改公共导出、fixture 生命周期、默认语义、teardown、fake runtime 或生产 seam，必须暂停并重新执行 0007-A 的相关门禁。

## 推荐运行命令

具体脚本以 P0 复核为准，当前最低参考：

### Shared

```bash
cd packages/shared
npx tsx --test tests/internal-contracts.test.ts
npm run typecheck
```

### API

必须从 `apps/api` cwd：

```bash
cd apps/api
npx tsc --noEmit --pretty false
npx tsx --test src/modules/agent/context-item-contract.test.ts
npx tsx --test src/modules/agent/agent.worker.integration.test.ts
```

artifact 场景可运行 `agent.integration.test.ts` 完整文件，或在 P0 确认 Node test runner 的可靠过滤方式后运行精确子集；不得用不稳定过滤遗漏证据。

### Worker

```bash
cd apps/agent-worker
npx tsx --test src/runtime/apiClient.test.ts
npm run typecheck
```

P6 根据影响补充 runner/tool-output 相关测试。

### 根目录

```bash
npm run build
npm run typecheck
git diff --check
```

## CWD、资源与日志

- API fixture 从 `apps/api` 执行；
- 临时目录位于仓库 `.tmp-tests`；
- teardown 必须关闭 app/DB/进程并删除目录；
- 预期 fault 日志需在实施记录中说明；
- 不得因测试输出包含完整 artifact/tool 内容而接受通过；
- 每批先完整记录 Git 状态，所有非本阶段 staged/worktree 变更均不得修改或改变 index 状态。

## 每批独立审查清单

### 范围

- 是否混入 lifecycle/cancel/recovery/subtask/archive；
- 是否修改 Shared/DB schema/文件格式/UI；
- 是否扩大 testkit 或全局 fault seam；
- 是否触碰任何非本阶段 staged/worktree 变更。

### 行为

- create ignored 与 update unchanged 是否仍不同；
- missing run 是否仍 404；
- head conflict 是否仍 409；
- terminal/switch late writeback 是否不污染 DB；
- title/artifact 副作用是否只在既有分支发生；
- artifact 顺序和失败政策是否保持。

### 架构

- facade 是否只委派；
- application 是否依赖窄 capability；
- Store 原子边界是否弱化；
- Query 是否依赖 Writeback；
- artifact capability 是否过度通用；
- 是否存在新旧双实现。

### 测试

- 是否保留 SQLite/Route/API-managed Worker；
- 测试迁移是否等价；
- archive/compaction 证据是否误删；
- 是否用 fake Store、sleep、`any` 或屏蔽错误换取绿色；
- 实施记录是否包含 cwd、命令、结果和缺口。

## UI 手工验收

本阶段涉及 UI artifact 展示，P6 默认至少评估或执行：

- apply_patch 完成后 UI 可拉取并展示 artifact；
- write 完成后 UI 可拉取 artifact，DB/context 仍显示 slim result；
- artifact 文件缺失时 UI/API 保持现有 404/降级；
- cancel/failed write 的参数展示不回归；
- 普通消息/工具写回无可见变化。

若代码只移动内部结构且完整 API artifact 集成测试足以证明行为，可以申请豁免，但必须在 `09` 写出理由并由独立审查接受。

## 阶段最终全面审查

P6 后必须由未参与实现的新审查视角对照：

- 0004/0005 写回合同与 lifecycle fence；
- 0006 Context Writeback/Artifact 目标边界；
- 本方案全部不变量、排除项和停止条件；
- 最终代码、Store transaction、测试索引和 git diff。

若发现方案与实现差异：

- 行为/边界缺口必须补代码并复审；
- 实现更合理且不改变基线时，可以更新文档，记录证据和理由；
- 不得仅以测试绿色宣告完成。

## 完成验收

- P0-P6 记录完整；
- 两个 facade 仅委派；
- Store 原子能力未弱化；
- artifact capability 边界和 Query/Writeback 方向定稿；
- Shared/API/Worker/SQLite/artifact 各层证据通过；
- UI 验收完成或豁免通过；
- 每批独立审查和复审通过；
- 阶段最终全面审查和最终复审通过；
- 未混入排除项，且所有非本阶段 staged/worktree/untracked 变更保持原状。
