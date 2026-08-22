# 分批实施计划

## 固定实施节奏

每批遵循：

```text
实施前复核
  → 小批实现
  → 定向测试 + 必要回归
  → 独立审查
  → 修复
  → 独立复审
  → 经用户授权后处理 Git 阶段动作
  → 下一批
```

不得一次性迁移 storage、Worker compact、clear、manual compact、snippet 与 startup。P0 未冻结 append 中途失败和 post-commit 状态写入前不得定稿错误模型；P1 未建立真实临时文件/fault hook 测试前不得切换 production storage；P2 未证明原子 persistence 与 sidecar policy 不变前不得迁移 compact/clear；P3 未通过不得删除 facade 内旧写入路径；P4 未通过不得从 module/read-side 删除旧 wiring。

## 批次总览

| 批次 | 目标                                     | 主要范围                                                                                    |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| P0   | 行为、顺序与故障基线                     | characterization、调用链、transaction/post-commit、append failure，无产品改动               |
| P1   | Archive 独立测试地基                     | storage/sidecar/fault hook/SQLite/wiring test skeleton                                      |
| P2   | storage 与 persistence 提取              | Archive adapters、CompactionArchivePersistence、composition，不切业务主链或只做等价内部切换 |
| P3   | Worker compact apply 与 clear            | 两条 DB+文件主写链、per-session reconcile、post-commit 状态                                 |
| P4   | manual compact、snippet、read 与 startup | scheduling、Read-side协作、search/read实现归属、startup trigger                             |
| P5   | 清理、完整回归与最终审查                 | facade/store/context/module残留、文档、全量验证                                             |

## P0：行为、顺序与故障基线冻结

### 任务

- 记录 Git 边界、HEAD 与未知变更；
- 建立 manual compact public/internal route、dedup、run transaction、enqueue failure 时序图；
- 建立 Worker auto/manual compact、summary、compact API、complete/fail 时序图；
- 建立 Worker compact 与 clear 的 append → DB → rollback → sidecar 时序图；
- 逐行冻结 `appendSystemSummaryAndArchiveItems()` transaction；
- 冻结 archive 格式、分卷、line 转义、半行与 snapshot 当前首次触达/追加顺序；不得虚构显式排序契约；
- 冻结 rollback 与 sidecar single/multi-file 真值表；
- 冻结 per-session/startup reconcile 调用顺序、当前 boolean 返回、helper 内 warning 与 failure isolation；
- 冻结 `AgentTestFaults` 读取位置和每个 fault 实际覆盖；
- 冻结 archive search/read 与 snippet 行为；
- 建立 compact/clear append 中途失败 characterization；
- 建立 compact token cleanup 和 clear idle post-commit failure characterization；
- 明确 process-local lock 的证明范围；
- 建立现有测试逐用例索引和命令/cwd。

### P0 必答问题

- append 在第一个/跨文件 chunk 后失败时，哪些文件已变化、调用方能否取得 snapshots；
- append failure 是否已有安全补偿；若没有，阶段只补证据还是存在最小安全修复；
- DB 成功、token cleanup 失败时 Worker 是否 retry，retry 如何遇到 head/visible 状态；
- DB 成功、clear idle 写失败时 endpoint 与 run-state 如何表现；
- sidecar tmp write/rename failure 是否遗留 tmp；
- path/symlink/no-follow 安全测试是否覆盖 archive root、sidecar 和 snippet cache；
- search/read 的 `pos` 与 beforePos 跨文件计算方式；
- snippet cache miss 的 archive batch/itemId 选择；
- 结构化 reconcile result/startup summary 是否确有测试和诊断收益；若引入，如何迁移当前 helper 内 warning 责任；
- fork-with-archive 对 append primitive 的 fault/rollback 依赖是否要求同批适配；
- process-local lock 在真实 `createApp()` 多请求中能证明什么。

### 交付

- 更新 `02-baseline-and-evidence.md`、`09-code-map.md`、`10-implementation-record.md`；
- 必要 characterization tests；
- fault hook 最小 API 定稿；
- 不修改生产行为、Shared contract、DB schema 或 Worker 主控制流。

### 门禁

- append 中途失败未知状态不能带入 P2；
- post-commit 状态失败不能被误写成 transaction 内语义；
- multi-file 自动 reconcile 禁止项必须有测试/结构审计入口；
- 通过独立审查和复审。

## P1：Archive 独立测试地基

### 任务

- 新建 Archive storage tests，使用真实临时 dataDir；
- 覆盖 path/filename/list/split/append/rollover/snapshot；
- 覆盖 exact-size rollback、size mismatch skipped、逆序多文件 rollback；
- 覆盖 sidecar tmp+rename、single-file reconcile、multi-file拒绝、invalid/path mismatch；
- 覆盖 search/read/excerpt/half-line/maxChars 基础行为；
- 建立 `ArchiveFaultHook` fake/no-op；
- 新建 Compaction/Archive persistence test，使用真实 SQLite；
- 新建 wiring test skeleton，审计 facade/module/read-side/`AppContext` 边界；
- 现有 integration tests 暂保留，不机械迁移全部 fixture。

### 门禁

- storage tests 不依赖完整 `createApp()`；
- persistence tests 不使用 fake DB；
- fault hook 不通过完整 `AppContext` 访问；
- multi-file 不自动 reconcile；
- P1 只建立测试地基，不切 production main path；
- 独立审查确认测试未隐藏 fs/DB 行为。

## P2：Archive storage 与 persistence 提取

### 任务

- 已建立 `ArchiveStorage`，承载 append/snapshot、rollback、pending sidecar、reconcile 与按 item id 的 excerpt；
- 已建立 `SqliteCompactionArchivePersistence`，以命名 adapter 委托现有单 SQLite transaction；
- 已由 composition root 构造 storage、persistence 与 legacy fault → hook 的等价映射；
- 已让 `AgentService` 的 fork-with-archive、compact、clear、reconcile 与 snippet excerpt 走窄 adapter；不迁移其业务 orchestration owner；
- 已删除 P1 `__archiveTestSupport`，定向测试改为直接依赖真实 extracted adapter；
- 保持 fork-with-archive 最小适配：legacy `archiveWrite.failAfterChunks` 只对原有 fork append 场景生效；不迁移 fork 业务语义；
- archive search/read endpoint 主实现、其协议与 maxChars/noArchive 语义仍留 P4，继续由既有 integration/Worker 回归保护。

### 门禁

- storage 不依赖 DB/service；
- persistence 不依赖 fs；
- core DB transaction 与 conflict mapping tests通过；
- archive format/search/read regression通过；
- `AgentTestFaults` production mapping 若暂时存在，只允许 composition root读取并转成 hook；
- 不形成新旧双 storage 权威跨批长期共存；
- 独立审查和复审通过。

## P3：Worker compact apply、clear 与 per-session reconcile

### 任务

- 建立 `CompactionArchiveApplication` 或等价 use-case；
- 迁移 `applyWorkerCompaction()`；
- 迁移 `clearSession()`；
- 迁移 per-session reconcile preflight；
- 保持 process-local serializer；
- 显式表达 append/DB/rollback/sidecar 顺序；
- 保持 compacted:false、clear errors、clear locale/reason；
- 保持 DB success 后 token cleanup / idle state 顺序；
- facade 切换为薄转发；
- 删除旧 compact/clear file/sidecar sequencing。

### 定向测试

- application fake-port 顺序与错误优先级；
- real fs + SQLite end-to-end coordinator tests；
- compact/clear API contract/integration；
- fault hook write/rollback/sidecar；
- post-commit status characterization；
- 同 session 并发 clear/compact；
- API typecheck。

### 门禁

- DB failure 后必须先补偿再映射 conflict；
- 必须保持 P0 冻结的 post-commit catch 边界：compact token cleanup 不触发 archive rollback；clear idle failure 仍按 exact-size rollback / skipped-sidecar 分支处理；
- facade 无第二业务路径；
- application 不依赖完整 AppContext/fs；
- 未修改 Worker Runner/Shared contract；
- 独立审查和复审通过。

### 本批实施状态

- 已新增 `compaction/compaction-archive-application.ts` 与 `compaction-archive-ports.ts`；application 只接收 session/query、run-state、archive storage、named persistence、clock/logger 与错误映射等窄 capability；
- `AgentService.compactContextFromWorker()` 与 `clearSession()` 已收缩为 process-local session lock 后的 application 委托；per-session reconcile 亦已委托 application；
- compact 的 token cleanup 仍在 persistence catch 外；clear 的 idle write 仍在 catch 内，沿用 exact-size rollback 与 skipped-sidecar；
- DB failure 先 rollback、必要时 sidecar，再映射 conflict；`SqliteCompactionArchivePersistence` 仍委托原单 SQLite transaction；
- manual compact、archive search/read、snippet 和 startup reconcile owner 均未迁移，留待 P4。

## P4：Manual compact、snippet、Archive read 与 startup

### 任务

- 将 manual compact validation/dedup/run transaction、runtime enqueue 与 enqueue-failure bridge 统一迁入显式 application/use-case；
- application 通过 RuntimeControl 与 Run Lifecycle 窄 bridge 完成执行和失败收敛，不复制底层规则；
- route 只保留 transport/auth/schema/status；
- 保持 Worker sentinel；
- 将 archive search/read 实现迁入 read capability；
- 建立 ArchiveExcerptReader 与 CompactionSnippetCache；
- 切换 Read-side snippet 协作，保持 prompt 投影；
- 迁移 startup reconcile use-case与 candidate isolation；
- module 只触发并顶层隔离；
- 保持 startup 相对顺序；
- 只有 fork-with-archive 等所有 archive append primitive 调用方均完成窄 hook 接线后，才删除 `AppContext.AgentTestFaults` archive 字段；否则保留 composition-root 过渡映射并记录删除条件；
- 完成 facade 方法薄化。

### 定向测试

- manual compact public/internal/dedup/worker-disabled/enqueue failure；
- Worker manual sentinel 与 auto compact 回归；
- search/read route + builtin/api client 回归；
- snippet cache hit/miss/failure/locale/order；
- startup wiring/order/candidate isolation；
- manual compact route 无 orchestration 的结构测试；
- AppContext/wiring structural tests。

### 门禁

- archive search/read Shared files无生产变更；
- Read-side 不依赖 write application；
- module 无 sidecar policy；
- manual compact orchestration owner 已收口到 application/use-case；
- Lifecycle 规则未复制；
- Worker 主控制流不变；
- 独立审查和复审通过。

### 本批实施状态

- `ManualCompactionApplication` 已拥有 reconcile、dedup、单事务 run activation、`__awb_compact__` enqueue 与 enqueue-failure Lifecycle bridge；`AgentService` 仅持 session serializer/facade，route 仅转发 transport body 与 runtime；
- `ArchiveReadApplication` 已拥有 session ownership、参数归一化与错误映射，`ArchiveReadStorage` 已拥有 archive filesystem listing、完整行 search/read、`pos`/`beforePos`/截断投影；`AgentService` 保留兼容 facade；
- `CompactionSnippetCache` 已从 `AgentService` 提取为 tmp 安全 I/O capability；prompt read-side 仍拥有 boundary、batch、excerpt、locale/template、注入位置和 best-effort 策略，继续通过 `ArchiveStorage.findExcerptByItemIds()` 取得 excerpt；
- `ArchiveStartupReconcileApplication` 已拥有 candidate enumeration 与单项失败隔离；module 仅构造并触发它，且保持 routes → subtask cleanup → archive reconcile 的现有相对顺序；
- 未修改 Shared、DB schema、Worker/builtin、legacy archiveWrite fork-only hook；P5 实施收尾及新审查员全面独立终审均已完成，终审结论通过。

## P5：收尾、完整回归与全面终审

### 任务

- 搜索 `AgentService` 中 archive fs/sidecar/compact/clear 规则残留；
- 搜索 `agent.store.ts` 中未归域的 compaction/archive能力；
- 搜索 `AppContext.agentTestFaults` archive访问；
- 搜索 Archive application/storage 中完整 AppContext、Route、Worker concrete依赖；
- 审计 multi-file auto truncate、不安全 path、archive format变化；
- 审计 search/read Shared contract未被顺手新增；
- 审计 Worker Runner diff；
- 更新全部方案文档为实际终态；
- 运行 Shared/API/Worker/Plugin/Web/root 完整回归、build/typecheck、diff hygiene；
- 由未参与实现的新审查员做全面独立终审。

### 完整回归建议

```bash
cd packages/shared
npx tsx --test tests/*.test.ts
npm run typecheck

cd apps/api
npx tsx --test $(find src -name '*.test.ts' -not -path '*/modules/plugins/plugin.service.test.ts' -print | sort)
npm run typecheck

cd <repository-root>
npx tsx --test apps/api/src/modules/plugins/plugin.service.test.ts

cd apps/agent-worker
npx tsx --test $(find src -name '*.test.ts' -print | sort)
npm run typecheck

cd plugins/feishu
npm run test
npm run typecheck

cd apps/web
npm run test
npm run typecheck

cd <repository-root>
npm run build
npm run typecheck
git diff --check
git diff --cached --check
```

实际命令必须按当时仓库脚本和 cwd 重新确认。

### 本批实施状态

- 已审计 `AgentService`、`agent.store.ts`、route 与 module：manual/read/compact/clear 均为 application facade 或既有 read-side prompt owner，未发现 archive fs、sidecar、search/read 或 startup 编排回流；保留的 `reconcileArchivePendingForSessionBestEffort()` 与 `failRunOnEnqueueFailure()` 为测试覆盖的兼容 facade，未发现生产调用；
- 已删除 `AgentService` 中无用的 `node:child_process` `spawn` import；
- 已校准既有 Subtask startup wiring 结构测试：module 可以为显式 `ArchiveStartupReconcileApplication` 装配窄 candidate 枚举，但不承载 orphan/sidecar 策略；
- 已审计 archive path、truncate、format、Shared/Worker diff 与 route payload；未发现 multi-file 自动 truncate、不安全路径、Shared archive read 合同或 Worker 主控制流变更；
- Shared、API、Worker、Plugin、Web、root build/typecheck 与 diff hygiene 均已实际通过；未参与实施的新审查员全面独立终审已完成且结论通过。

### 阶段完成门禁

- 所有完成定义满足；
- 无未解释行为差异；
- append 中途失败缺口有如实终态记录；
- 新审查员全面独立终审已通过，无必须补代码项；
- `ArchiveReadStorage` 的复杂 read/search 语义更多依赖 integration 护栏，作为可接受差异保留，不构成阻断；
- `AppContext.agentTestFaults` 因 fork-with-archive 删除条件未满足而保留，作为 composition-root 过渡映射的可接受取舍，不构成阻断；
- 非阻断的低优先级文档精度问题可后续再微调；
- 只有经用户授权才执行暂存/提交；
- 不自动 push，不改写 Git 历史。

## 回滚策略

每批应保持可独立回滚：

- P0/P1 只有文档/测试；
- P2 只有 adapter/persistence/composition，不改变业务语义；
- P3 以 compact/clear facade 切换为原子回滚点；
- P4 按 manual、snippet/read、startup 的独立文件/patch 切分；
- 任一批失败时回滚该批，不保留新旧双生产路径；
- 不通过删除用户 archive/sidecar 或修改 DB 历史“恢复”。
