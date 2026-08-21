# 阶段实施记录

> 状态：方案审查/复审已通过；P0/P1 已完成审查、修复、复审并精确暂存；P2/P3/P4/P5 已完成审查/复审；P6 已实施且完整自动回归通过，待阶段最终全面审查与最终复审。
> P6 开始时工作区：`v1.1...origin/v1.1`。已有阶段改动及其 index 状态由主会话保护和处理；本批未执行 Git 写操作。P6 仅完成残留审计、测试归属记录与完整回归，未处理既有暂存边界。0007-A 已由提交 `0f57bfe` 完成。
> 用途：记录 P0-P6 的命令、cwd、结果、测试索引、审查、偏差和门禁；不替代长期基线、代码地图或自动测试。

## 记录规则

- 长期行为事实更新 `02-baseline-and-evidence.md`；
- 路径、符号和调用链更新 `07-code-map.md`；
- artifact 责任/顺序决策更新 `04-artifact-boundary-design.md`；
- 可执行证据落在 Shared/API/Worker 测试；
- 本文件记录实际命令、cwd、结果、耗时、审查和偏差；
- 不记录 token、完整 tool args/result、artifact JSON、用户内容或敏感绝对路径；
- 每批第一项、且 P0 的第一条命令，必须完整记录 `git status --short --branch`，逐项标注 staged/worktree/untracked 状态、归属与保护结论；
- 所有非本阶段变更不得修改、清理、暂存、取消暂存或混入批次 diff。

## 当前批次状态

| 批次 | 实现 | 实现者测试 | 独立审查 | 修复 | 独立复审 | 暂存 |
|---|---|---|---|---|---|---|
| P0 写侧基线冻结 | 已完成 | 通过 | 通过 | 已完成 | 通过 | 已精确暂存 |
| P1 最小写回测试地基/索引 | 已完成 | 通过 | 通过 | 已完成 | 通过 | 已精确暂存 |
| P2 Writeback 骨架 | 已完成 | 通过 | 通过 | 已完成 | 通过 | 由主会话处理 |
| P3 Create/append | 已完成 | 通过 | 通过 | 已完成 | 通过 | 由主会话处理 |
| P4 Update/状态收敛 | 已完成 | 通过 | 通过 | 已完成 | 通过 | 已暂存 |
| P5 Artifact capability | 已完成 | 通过 | 通过 | 已完成 | 通过 | 由主会话处理 |
| P6 收尾/回归 | 已实施 | 通过 | 待本批审查 | 不适用 | 待本批复审 | 否；由主会话处理 |

## P0：写侧基线冻结

### 工作区快照与保护结论

P0 第一条 Git 记录为：

```text
## v1.1...origin/v1.1
A  docs/design/0007-B-第二阶段-Context-Writeback与Artifact边界治理/{README,01..09}.md
```

启动时只有本阶段方案目录的十个文档已暂存；没有未暂存或未跟踪项，也没有外部任务变更。P0 仅新增本阶段 `apps/api/src/modules/agent/agent.integration.test.ts` 的两项 filesystem/API characterization，生产逻辑未修改。该段是 P0 启动时的历史快照；当前边界以文件顶部“当前工作区”为准。文档显示 `AM` 时，含义只是 index 中的方案基线加工作树续改，不代表 P0 已通过、已复审或已按批次结论暂存。

### 静态证据复核结论

- Shared：create 为 normal/ignored union，update 只返回完整 item；path builder 只接受正整数。
- Worker client：create 使用 Shared contract 且 409 映射 `ApiConflictError`；update 使用 path builder，非 2xx 保持普通 request error。
- Route：只做 Shared schema/token/facade 连接，不承载 fence、ownership、artifact 或 lifecycle 判断。
- Create：`apply_patch` completed-on-create 返回 400；append Store 结果保持 ignored/404/400/409 区分；title 只在成功 completed todolist 有有效 goal 时更新。
- Update：初步 `getContextItemForWorkerUpdate()` 负责 missing/ownership/unchanged 早返回；最终 `updateContextItemWithRunFence()` 在 transaction 内二次 fence，unchanged 返回 stored item，title 不触发。
- Store：append 的 session/workspace/run/active-run fence、head CAS、append/head/touch 位于同一 transaction；update 的 ownership/run/terminal fence 在最终 transaction 中再次执行。
- Artifact：apply_patch 和 completed write 都是“初步 fence → artifact 尝试 → slim output → 最终 fence”；安全写失败只记录有限日志并继续 slim update。无全局 DB/filesystem transaction。
- write：已直接确认位于 `AgentService.updateContextItemFromWorker()` 主链。completed 使用 `splitWriteResult()` + `writeUiArtifactPath()`；failed/cancelled 不 split、不写 artifact、不替换 result，仍保留完整 args/content。`getWriteUiArtifact()` 为 Query 读取点。

### 行为证据索引

| 行为 | 测试/证据 | P0 结果 |
|---|---|---|
| Shared create normal/ignored、update record | `packages/shared/tests/internal-contracts.test.ts` | 14 passed |
| Worker client normal/ignored/409/strict-warn | `apps/agent-worker/src/runtime/apiClient.test.ts` | 20 passed |
| Route + SQLite create/update、404/409/ignored/unchanged | `apps/api/src/modules/agent/context-item-contract.test.ts` 的九项 writeback 用例 | 20 passed（同文件另含 archive/compact 用例） |
| API-managed Worker 请求顺序 | `apps/api/src/modules/agent/agent.worker.integration.test.ts` | 3 passed；保持 `run-state < context update < run-complete` |
| apply_patch/write artifact 主链与终态矩阵 | `agent.integration.test.ts` 定向 `apply_patch|write completed|write artifact|write 在 cancel|write 在 failed` | 7 passed |
| Query 缺失 artifact | apply_patch/write 各自“文件缺失时返回 404” | 定向通过 |
| Query 越界 symlink | 新增 `artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400` | apply_patch/write 均为 `400 Invalid path` |
| 写入侧安全目录失败 | 新增 `artifact 写入目录为越界 symlink 时仍以 slim result 完成 update` | write update 仍 200，DB result slim；预期有限 error 日志 |

### 命令与结果

| cwd | 命令 | 结果 | 耗时/说明 |
|---|---|---|---|
| 仓库根 | `git status --short --branch` | 如上工作区快照 | P0 第一条命令 |
| `packages/shared` | `npx tsx --test tests/internal-contracts.test.ts` | 14 passed | 约 230–251 ms |
| `apps/api` | `npx tsx --test src/modules/agent/context-item-contract.test.ts` | 20 passed | 约 6.8 s；必须从该 cwd |
| `apps/api` | `npx tsx --test src/modules/agent/agent.worker.integration.test.ts` | 3 passed | 约 7.1–8.2 s |
| `apps/agent-worker` | `npx tsx --test src/runtime/apiClient.test.ts` | 20 passed | 约 362–365 ms |
| `apps/api` | `npx tsx --test --test-name-pattern='apply_patch|write completed|write artifact|write 在 cancel|write 在 failed' src/modules/agent/agent.integration.test.ts` | 7 passed | 约 4.37 s |
| `apps/api` | `npx tsx --test --test-name-pattern='workspace artifact 目录为越界 symlink|artifact 写入目录为越界 symlink|write completed|write 在 cancel|write 在 failed' src/modules/agent/agent.integration.test.ts` | 5 passed | 约 3.94 s；包含预期安全写失败 error 日志 |
| `apps/api` | `npx tsc --noEmit --pretty false` | 通过 | P0 最小 typecheck |
| 仓库根 | `git diff --check && git diff --cached --check` | 通过 | 已在文档/测试修改前后复核 |

曾尝试以 `/usr/bin/time` 包装命令，但环境不存在该路径；该命令未运行测试，随后均以直接命令复跑并以上述结果为准。

### P0 必答结论与后续证据缺口

- create terminal/switch late 均为 ignored，且既有 SQLite/Route 测试证明不改 context/head/title/run-state；missing run 为 404，普通 head conflict 为 409。
- update late/terminal/switch 返回 unchanged stored item，不产生 ignored；初步 fence 阻止 artifact，最终 transaction fence 仍为权威。
- write 已纳入 P5；completed 才生成 artifact/slim result，failed/cancelled 不生成 artifact、不 slim，完整 args/content 保持。
- Query 缺失 artifact 为 404；workspace artifact 目录越界 symlink 真实 API 为 `400 Invalid path`，这不是可在 P5 顺手改成 404 的空白。
- 写入目录越界 symlink 已证明 best-effort：记录有限错误后仍 200 且 DB 为 slim result。
- 尚无可控 seam 精确复现“artifact 写成功后、最终 fence 变 unchanged”的竞态，也未冻结目标在 `lstat` 后消失等其他 realpath 错误。P0 不扩大 `agentTestFaults`；P1/P5 若无法以窄 collaborator 或受控顺序补证，必须暂停相关迁移。
- 现有私有 fixture 已足以表达 SQLite/Fastify 和 archive fault 差异；P1 默认不扩 0007-A 公共 testkit。

### P0 门禁

**P0 实现者门禁：通过；P0/P1 合并审查门禁：进行中。** Shared、Route、Worker client、Store 原子边界、write 主链、artifact 基本安全/失败政策和测试 cwd 已冻结；没有生产迁移或 P1 testkit 扩张。最终-fence artifact 竞态是 P5 前置 characterization 缺口，已显式保留而非以猜测宣称覆盖。是否通过本轮合并门禁以完成修复后的独立复审结论为准。

### 历史 P0 审查、修复与复审记录

以下为调整为 P0/P1 合并门禁前的历史审查记录，不等同于当前合并门禁已经通过。

### P0 独立审查、修复与复审

- 初审范围：P0 工作树 diff、create ignored/update unchanged 差异、Store transaction/fence、write 主链与 completed/failed/cancelled 差异、Query/写入 symlink characterization、文档状态和 Git 保护清单。
- 初审问题：新增写入侧故障 characterization 临时将 Fastify logger 提升到 `fatal`，但只在成功路径恢复；断言失败时可能污染后续测试的 logger 状态。
- 处置：**Fix**。以 `try/finally` 保证恢复原 logger 等级；不触及生产逻辑或 artifact 行为。
- 复审结果：通过。修复后完整 P0 矩阵重跑通过；未发现 P0 越界、Shared/Store 语义漂移、write 事实错误或文档与实际 Git 状态不一致。

## P1：最小写回测试地基与索引

### 计划记录

- 复用的 0007-A testkit API；
- 领域私有 helper；
- 从 `context-item-contract.test.ts` 迁移/索引的用例；
- archive/compaction 保留理由；
- 是否修改公共 testkit；
- 如修改，重新审查记录和回归结果。

### 门禁

- 真实 SQLite/Route/Worker 证据不得减少；
- fake Store 禁止；
- 公共 testkit 变更未复审通过时不得进入 P2。

### P1 实施与验证

- 不扩展 0007-A 公共 testkit。`context-item-contract.test.ts` 继续使用其私有 fixture，因为同文件的 archive rollback/sidecar fault 资源和断言不属于 Writeback；强制统一会扩大本批范围。
- 新增领域私有 `writeback.api.test.ts`，直接使用 `createAgentTestFixture({ withApp: true })`、`createTestWorkspace()`、`injectJson()` 建立真实 SQLite/Fastify，并用显式 session setup 验证 create Route 与 SQLite head CAS；P1 不把 testkit 改造成 context/run 一站式 builder。
- 后续 Writeback 测试索引：Route/SQLite fence/CAS 继续由 `context-item-contract.test.ts` 的九项纯 writeback 用例承担；artifact 真实 filesystem/Query 由 `agent.integration.test.ts` 承担；API-managed Worker 与 Worker client 分别保留专属 fixture。
- 实现者验证：`apps/api` 下 `npx tsx --test src/modules/agent/writeback.api.test.ts`（1 passed）及 `npx tsc --noEmit --pretty false` 通过；先前 `agent-testkit.test.ts` 与 `read-side.api.test.ts`（6 passed）也通过。不新增 fake Store、fault seam 或公共导出。

### P1 门禁

**P1 实现者结论：通过；P0/P1 合并审查门禁：进行中。** P2 不依赖未定义 helper；本域证据可独立定位，真实 SQLite/Route/Worker 证据未减少。P1 的 `writeback.api.test.ts` 当前仍未跟踪，必须待本轮修复与复审通过后才与对应文档按精确路径暂存。

## P2：Writeback 骨架与窄依赖

### 实施

- 新增 `apps/api/src/modules/agent/writeback/context-writeback-application.ts`，只接收两个 typed delegate：`appendContextItemFromWorkerLegacy` 与 `updateContextItemFromWorkerLegacy`；不接收 `AppContext`、`AgentService`、Store、artifact、clock 或 logger。
- `AgentService` 在构造时装配 application。公开 `appendContextItemFromWorker()` / `updateContextItemFromWorker()` 仅透传参数、结果与错误；Route 和 fallback runtime 调用链未改。
- 原业务体原样保留为 `AgentService` 私有 `legacyAppendContextItemFromWorker()` 与 `legacyUpdateContextItemFromWorker()`，分别是 P2 期间 create/update 规则、Store 原子调用、artifact、title side effect 与错误映射的唯一权威实现；未复制业务判断。
- 本批未引入 persistence adapter、title updater、clock/logger 或 artifact writer 的真实依赖，因为抽取任一能力会迁入 P3/P5 业务规则；P2 的窄依赖仅用于建立可替换组合点。

### 回调删除计划

| 临时 delegate | 当前唯一目标 | 删除批次 | 删除条件 |
|---|---|---|---|
| `appendContextItemFromWorkerLegacy` | `AgentService.legacyAppendContextItemFromWorker()` | P3 | create use-case 成为 application 的唯一权威后删除 delegate 与 legacy 方法 |
| `updateContextItemFromWorkerLegacy` | `AgentService.legacyUpdateContextItemFromWorker()` | P4 | update use-case 成为 application 的唯一权威后删除 delegate 与 legacy 方法 |

P2 不设置 artifact callback；artifact collaborator 仅在 P5 以 capability 形式引入，因此不存在需要保留到 P5 的短期 callback。

### 验证与门禁

- 扩展 `agent.service.facade.test.ts`，覆盖两条 writeback facade 的参数、返回值和错误透传；新增 `writeback/context-writeback-application.test.ts`，覆盖两条临时 delegate 的参数、返回值和错误透传。
- 为避免手工注入 application 的单测遗漏构造装配漂移，复用真实 Fastify/SQLite 的 `writeback.api.test.ts` 作为 P2 接线证据：create Route 覆盖 `Route → 真实 AgentService 构造 → writebackApplication → legacy append → SQLite` 及 CAS；新增 update Route 用例覆盖同一真实路径到 legacy update，并断言 Route 返回与 SQLite 记录都完成更新。该测试不替换私有字段、不依赖白盒 spy，也不复制业务逻辑。
- `apps/api`：`npx tsx --test src/modules/agent/agent.service.facade.test.ts src/modules/agent/writeback/context-writeback-application.test.ts` 通过（6 passed）；`npx tsx --test src/modules/agent/writeback.api.test.ts` 通过（2 passed）；`npx tsc --noEmit --pretty false` 通过。
- 仓库根：`git diff --check` 与 `git diff --cached --check` 通过。
- 当前结论：P2 构造级接线证据已补充且实现者验证通过，待独立审查与复审。

## P3：Create / append 迁移

### 实施

- `ContextWritebackApplication.appendContextItemFromWorker()` 现为 create/append 的唯一编排权威，迁入 completed `apply_patch` 禁止、`createdAt` 默认值、`appendContextItemWithRunFence()` 结果映射、append conflict 409 映射与有限 warning、以及成功 completed `todolist` 的 title 触发。
- application 只接收窄 capability：原子 `appendWithRunFence`、`nowMs`、纯 title 格式化、title 持久化、append conflict 识别/记录；`AgentService` 在构造时绑定这些能力到现有 Store、clock、title Store 与 logger。application 不接收 `AppContext` 或 `AgentService`，也不将 Store fence 拆成先读后写。
- 删除 `AgentService.legacyAppendContextItemFromWorker()` 和临时 `appendContextItemFromWorkerLegacy` delegate；公开 `AgentService.appendContextItemFromWorker()` 保持兼容 facade，只委派给 application。
- update 的 `legacyUpdateContextItemFromWorker()` 与对应 delegate 未改变，仍是 P4 前的唯一 update 权威；本批未触及 artifact、update fence、Route、Shared、Store schema 或 Worker。

### 保持的行为

- late create 仍返回 `{ ok: true, item: null, ignored: true }`，且不触发 title；
- missing run/session 保持 `404 run not found` / `404 session not found`；workspace/run mismatch 保持 `400 workspaceId mismatch`；普通 stale head 保持 warning 和 `409 session head conflict`；
- `appendContextItemWithRunFence()` 仍直接作为原子 Store capability；成功 appended completed `todolist` 才调用 title updater；completed `apply_patch` 仍在调用 Store 前返回 400。

### 验证与门禁

- 重写 `writeback/context-writeback-application.test.ts`，验证 application 对 append fence 输入/clock、成功 title、ignored 无副作用、missing/mismatch/conflict 映射和 warning、apply_patch 禁止的编排；同时验证 update delegate 仍只为 P4 保留。
- `writeback.api.test.ts` 的真实 Fastify/SQLite create 测试改名为 P3 接线证据；其 CAS 断言与现有 update legacy 路径测试一起运行。
- `apps/api`：`npx tsx --test src/modules/agent/writeback/context-writeback-application.test.ts src/modules/agent/writeback.api.test.ts` 通过（7 passed）；`npx tsx --test src/modules/agent/context-item-contract.test.ts` 通过（20 passed，含既有 archive fault 的预期日志）；`npx tsc --noEmit --pretty false` 通过。
- 仓库根：`git diff --check` 与 `git diff --cached --check` 通过；静态检索未发现 `legacyAppendContextItemFromWorker` 或 `appendContextItemFromWorkerLegacy`。
- 当前结论：P3 实现者验证通过，待独立审查与复审。

## P4：Update / 状态收敛迁移

### 实施

- `ContextWritebackApplication.updateContextItemFromWorker()` 现为 update/状态收敛的编排权威：先调用原子 `inspectForWorkerUpdate()`，映射 missing/ownership，unchanged 直接返回 stored item；初步 fence 可更新时，计算保持原语义的 `nextStatus`/`nextOutput`，再执行 artifact collaborator，最后调用原子 `updateWithRunFence()` 并再次映射 missing/ownership/unchanged。
- Store 的初步与最终 fence 直接由 application 的窄 capability 调用；未以普通 CRUD 替代。最终 `unchanged` 直接返回 stored item，不生成 create `ignored` envelope，也不触发 title。terminal/switch-run 的状态收敛仍只由 Store 决定。
- title 触发迁入 application：仅最终成功更新为 completed `todolist` 且有效 goal 时，通过现有窄 title capability 更新。两个 `AgentService` writeback 公共方法现在都只委派给 application。
- `AgentService.legacyUpdateContextItemFromWorker()` 和 `updateContextItemFromWorkerLegacy` 已删除。P4 为保持 P0 artifact 顺序与写入失败政策，暂留唯一私有 `prepareUpdateArtifactsLegacy()`，只承载现有 apply_patch/write artifact 分支和 slim output；application 按“初步 fence → artifact helper → 最终 Store fence”调用。P5 迁入 artifact capability 后必须删除该 helper/callback；不得在 P4 改 path、payload、failure policy、completed/failed/cancelled write 差异或 Query。

### 保持的行为

- missing item 保持 `404 context item not found`；ownership mismatch 保持 `404 context item ownership mismatch`；初步或最终 late/terminal/switched-run fence 保持返回 unchanged stored item；update response 不新增 `ignored`。
- `write` 仍仅在 completed 时 split result/尝试 artifact 写入并保留完整 args；failed/cancelled 不 split、不写 artifact；apply_patch/write artifact 均仍在最终 Store fence 前执行，失败后仍继续 slim DB update。

### 验证与门禁

- 更新 `writeback/context-writeback-application.test.ts`，覆盖初步 fence 后 artifact 再最终 fence 的顺序、初步 missing/ownership/unchanged 的早返回、最终 unchanged 不更新 title，以及成功 completed `todolist` update 的 title 触发。
- `writeback.api.test.ts` 的真实 Fastify/SQLite update 用例改名为 P4 接线证据；与 create Route/SQLite 接线一并运行。补充 terminal item 的真实 PATCH 用例：验证 200 `{ ok: true, item }` 返回既有 stored item、response 不含 `ignored`、以及 SQLite record（含 status/output/updatedAt）未改写。这是 P4 迁移后的 terminal unchanged 接线证据，不替换私有字段或引入新 seam。
- `apps/api`：`npx tsx --test src/modules/agent/writeback/context-writeback-application.test.ts src/modules/agent/writeback.api.test.ts` 通过（11 passed）；`npx tsx --test src/modules/agent/context-item-contract.test.ts` 通过（20 passed，含既有 archive fault 的预期日志）；`npx tsc --noEmit --pretty false` 通过。先前 artifact 定向集成通过（7 passed）。
- 仓库根：`git diff --check` 与 `git diff --cached --check` 通过；静态检索未发现 `legacyUpdateContextItemFromWorker` 或 `updateContextItemFromWorkerLegacy`。
- 当前结论：P4 terminal unchanged 真实接线证据已补充且实现者验证通过，待独立审查与复审。

## P5：Artifact capability 与边界

### 实施

- 新增 `artifact/ui-artifact-capability.ts`：仅承载固定 `apply_patch`/`write` UI artifact 的 path 与 payload JSON 读写；full/slim result split 保持为 `writeback/ui-artifact-result-split.ts` 的 Writeback 专属规则。两者均没有开放任意文件路径或目录的 API，不能作为全局 filesystem service 使用。
- 新增 `artifact/safe-file-io.ts`：机械迁移 `ensureRealPathUnderRoot()`、`ensureDirSafeUnderRoot()`、`writeFileNoFollow()`、`readFileNoFollow()`。它们仍供 compaction snippet cache 使用，但 compaction 不依赖 UI artifact capability 或 Writeback。
- `ContextWritebackApplication` 保留 artifact 的触发时机、tool/status 差异、slim result 替换和 best-effort 日志政策；在初步 update fence 后、最终 Store fence 前调用 capability。completed `apply_patch` 与 completed `write` 继续 split/write；failed/cancelled `write` 继续不 split、不写 artifact、不替换 result。
- `AgentService.getApplyPatchUiArtifact()` / `getWriteUiArtifact()` 保留 item/tool/toolCallId 的既有 404 校验，随后直接调用 capability。Query 不导入或依赖 Writeback。
- 已删除 P4 临时 `prepareUpdateArtifactsLegacy()` 及 application callback；`AgentService` 不再承载 apply_patch/write artifact 编排、payload 类型或 split 函数。

### 保持的行为与竞态证据

- artifact 路径、JSON 格式、Query 的 404 映射、workspace artifact 目录越界 symlink 的 `400 Invalid path`、no-follow 安全检查和写入失败后继续 slim DB update 均保持原样。
- 应用层新增受控证据：`UiArtifactCapabilityPort.writeApplyPatch()` 成功返回后，既有窄 `updateWithRunFence()` capability 返回 `unchanged`；断言 artifact 写在最终 fence 前发生、最终返回 stored item，并且该顺序不被补偿或回滚。该证据复用 P4 已有窄依赖，不扩张 `AppContext.agentTestFaults`，也未引入新的通用测试 seam。
- 真实 SQLite 中人为制造“两次 fence 之间 run terminal/switch”的并发时序仍没有稳定、窄的现有控制点；为遵守不扩张 fault seam 的约束，本批不伪造该端到端竞态。前述应用层受控顺序证据和既有真实 Store/Route unchanged 证据共同冻结迁移前已存在的文件先于最终 fence 的语义；这不改变、也不掩盖该物理竞态的产品行为。

### 验证与门禁

- `apps/api`：`npx tsx --test src/modules/agent/writeback/context-writeback-application.test.ts src/modules/agent/writeback.api.test.ts` 通过（14 passed），包含 apply_patch artifact → slim output → final fence、completed write best-effort、failed write 不 split，以及 artifact 成功后 final unchanged 的受控顺序。
- `apps/api`：`npx tsx --test --test-name-pattern='apply_patch|write completed|write artifact|write 在 cancel|write 在 failed|artifact Query' src/modules/agent/agent.integration.test.ts` 通过（8 passed），覆盖 artifact Query、symlink `400`、write completed/failed/cancelled 差异。
- `apps/api`：`npx tsc --noEmit --pretty false` 通过。仓库根：`git diff --check` 与 `git diff --cached --check` 通过。
- 当前结论：P5 实现者验证通过，待独立审查与复审；未开始 P6。

## P6：收尾、回归与最终审查

### 残留与边界审计

- 静态检索未发现 `legacy` create/update/artifact helper、`prepareUpdateArtifactsLegacy()` 或新旧双实现。`ContextWritebackApplication.prepareUpdateArtifacts()` 是当前唯一的 update artifact 编排私有方法，不是过渡 callback，保留以维持“初步 fence → artifact → 最终 fence”的明确顺序。
- `AgentService.appendContextItemFromWorker()` 与 `updateContextItemFromWorker()` 均为单行 facade；`agent.service.facade.test.ts` 覆盖参数、返回值以及同步/异步错误透传。
- `ContextWritebackApplication` 不导入 `AppContext`、`AgentService` 或 runtime；Route 仍只做 token/schema/facade 连接。Store 的 `appendContextItemWithRunFence()`、`getContextItemForWorkerUpdate()` 与 `updateContextItemWithRunFence()` 仍是唯一原子 transaction 权威，未新增 persistence adapter。
- `UiArtifactCapability` 只接受 workspace/toolCall 标识并读写固定 artifact 文件，`artifact/` 不依赖 `writeback/`；`safe-file-io.ts` 仅机械承接 containment/no-follow 原语，供 artifact 与 compaction snippet cache 共享。

### 测试归属与验收决定

- 保留 `context-item-contract.test.ts` 内 archive/compaction/sidecar 用例：其 fixture 和 fault 资源属相邻领域，未为拆分而改变公共 testkit 或复制测试；本域 writeback 场景已由该文件、writeback application/API 测试共同索引。
- 保留 `agent.integration.test.ts` 内复杂 artifact 场景：它们覆盖真实 Fastify、SQLite、路径、安全 I/O、Query response 与 symlink `400` 的联合边界；为目录归属强拆会降低该链路的回归价值。
- 未执行人工 UI 验收。豁免理由：本批只迁移内部职责；完整 API artifact 集成已覆盖 apply_patch/write 的写入、slim result、Query、缺失和 symlink/status 行为，且没有改动 UI、Shared contract、artifact path 或 payload 格式。该豁免待最终全面审查确认。

### 完整自动回归

- `packages/shared`：`npx tsx --test tests/internal-contracts.test.ts`（14 passed）与 `npm run typecheck` 均通过。
- `apps/api`：`npx tsx --test src/modules/agent/context-item-contract.test.ts src/modules/agent/agent.integration.test.ts src/modules/agent/agent.worker.integration.test.ts src/modules/agent/writeback.api.test.ts src/modules/agent/writeback/context-writeback-application.test.ts src/modules/agent/agent.service.facade.test.ts` 通过；涵盖真实 SQLite、Fastify、artifact Query、API-managed Worker 及 facade/application。运行包含既有 archive fault 的预期日志，但进程以 exit code 0 结束。随后 `npx tsc --noEmit --pretty false` 通过。
- `apps/agent-worker`：`npx tsx --test src/runtime/*.test.ts` 与 `npm run typecheck` 均通过，包含 `apiClient` 和 context writeback/tool output 相邻 runner 回归。
- 仓库根：`npm run build` 与 `npm run typecheck` 均通过；web build 输出既有 Browserslist 过期和 chunk 大小 warning，但无构建失败。`git diff --check` 与 `git diff --cached --check` 均通过。

### 当前结论

P6 实现者收尾与完整自动回归通过；未开始阶段最终全面审查或最终复审，也未执行 Git 暂存、提交、推送。建议下一步由新审查视角进行最终全面审查，并在接受 UI 验收豁免后执行最终复审。

## 方案偏差记录

| 批次 | 偏差 | 证据 | 是否改变行为 | 决策/回滚 |
|---|---|---|---|---|
| - | 暂无 | - | - | - |

## 停止与恢复记录

| 日期/批次 | 停止条件 | 影响 | 决策 | 恢复门禁 |
|---|---|---|---|---|
| - | 暂无 | - | - | - |

## 最终状态模板

阶段完成后更新：

- P0-P6 批次级审查/复审：待完成；
- 阶段最终全面审查：待完成；
- 阶段最终复审：待完成；
- 自动测试：待完成；
- UI 验收/豁免：待完成；
- Git 提交：未创建；
- 远程推送：未执行；
- 非本阶段 staged/worktree 变更：必须保持内容与 index 状态原样。
