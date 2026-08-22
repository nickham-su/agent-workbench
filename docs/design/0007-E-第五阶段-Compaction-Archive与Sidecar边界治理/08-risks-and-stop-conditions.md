# 风险、非目标与停止条件

## Archive append 中途失败被误判为已补偿

### 风险

append helper 可能在部分 chunk 已写入后抛错，而 compact/clear 调用方尚未取得 snapshots。若结构迁移直接宣称“所有文件失败都有 rollback/sidecar”，会掩盖真实部分写入窗口。

### 控制

- P0 建立真实临时文件 characterization；
- 区分 append failure 与 DB-after-append failure；
- 文档明确 sidecar 当前不覆盖前者；
- 仅在可持有 snapshots 且 exact-size 可证明时考虑最小补偿；
- 不扩张为 staging/outbox/multi-file自动恢复。

### 停止条件

若实现需要改变 archive 格式、引入持久操作日志或扩大 sidecar 自动恢复才能处理 append failure，停止并另立 Archive 强一致性方案。

## DB 原子 transaction 被弱化

### 风险

把 summary插入、archive标记、head move、session touch拆成多次 application CRUD，会引入部分提交、head竞态和无法正确补偿的文件/DB分歧。

### 控制

- 保留命名 persistence capability；
- expected-head final check在transaction内；
- 真实 SQLite rollback/conflict tests；
- 审查 SQL，而非只看 application fake。

### 停止条件

若 adapter无法保留 `appendSystemSummaryAndArchiveItems()` 的单transaction语义，停止 P2/P3，不得先迁上层后补原子性。

## 文件与 DB 顺序被隐藏或反转

### 风险

- DB先提交、文件后写，失败时产生 DB 指向不存在archive；
- 泛化 helper隐藏append/rollback/sidecar顺序；
- conflict映射先于rollback，遗漏补偿。

### 控制

- application按顺序显式编排；
- 顺序测试和fault hook；
- conflict只在补偿后映射；
- architecture review逐分支检查。

### 停止条件

任何生产路径改变为 DB-first，或原DB错误可能被rollback/sidecar错误替代，必须停止并修正。

## Sidecar 范围扩大

### 风险

将 pending sidecar变为通用archive事务日志，或在append失败、正常成功时写入，会改变恢复语义并产生误truncate风险。注意：当前 clear 的 post-commit idle 写仍在其 catch 内；若该失败后的 rollback 因 size mismatch skipped，sidecar 会按既有 `DB failure + rollback skipped` 路径产生。这是当前事实，不得误写成所有 post-commit 失败都不写 sidecar。

### 控制

- 固定产生条件：DB failure + rollback skipped；
- record operation保持compaction/clear/fork既有语义；
- 写入条件application tests；
- 结构审计所有sidecar call sites。

### 停止条件

如需将sidecar用于append中途失败、DB已提交或任意I/O失败，必须单独设计，不得混入本阶段。

## Multi-file 自动 truncate

### 风险

认为每个snapshot size都匹配即可批量truncate，会忽略跨文件部分恢复、执行中断和外部写入的组合风险。

### 控制

- snapshots长度必须恰为1；
- multi-file tests断言保留sidecar；
- 搜索所有truncate调用；
- 文档/代码双审查。

### 停止条件

任何 multi-file 自动truncate路径出现即停止该批；不得以测试方便或“看起来安全”为由接受。

## Path、symlink 与文件安全回退

### 风险

storage提取时以字符串拼接简化路径校验，导致sidecar fileKey越界、symlink跟随或snippet/archive读取逃逸root。

### 控制

- 复用既有path helper与realpath/no-follow规则；
- opaque fileKey；
- traversal/symlink tests；
- public port不接受任意绝对path。

### 停止条件

若新capability必须暴露任意filePath给application，或无法证明路径位于当前session archive root，停止并重新设计接口。

## Process-local lock 被夸大

### 风险

迁移后把 `runSessionOperationExclusive()` 命名为全局lock/lease，进而删除exact-size fence或宣称多实例安全。

### 控制

- 类型/文档命名明确 process-local；
- 不在storage内隐藏全局锁；
- 测试说明证明范围；
- 保留size fence。

### 停止条件

若需求要求多API实例或共享dataDir强一致性，当前方案不成立，应另立跨进程协调设计。

## Post-commit run-state 失败被错误回滚

### 风险

compact token cleanup 或 clear idle 写入发生在核心 DB transaction 后，但现有 catch 边界不同。重构若把它们统一处理，可能误让 compact 进入 archive rollback，或误让 clear 丢失既有 rollback/sidecar 分支，造成 DB marker 与文件副作用偏离已冻结现状。

### 控制

- P0 characterization；
- application区分 DB apply failure、compact token cleanup failure 与 clear idle failure；
- real SQLite tests断言：compact token cleanup 不 rollback；clear idle failure 在 exact-size 时 rollback，在 rollback skipped 时写 clear sidecar；
- 不擅自并入核心transaction。

### 停止条件

若迁移无法区分提交前/提交后错误及 compact/clear 的既有 catch 边界，停止 P3。不得用统一 catch 包裹所有步骤并执行同一补偿。

## Manual compact 与 Lifecycle 责任混淆

### 风险

manual compact sequencing 继续留在 route、Archive application复制enqueue failure/run terminal规则，或把manual compact scheduling与actual archive apply合成一个长事务。

### 控制

- manual run transaction独立命名；
- application统一拥有schedule → runtime enqueue → Lifecycle failure bridge sequencing；
- RuntimeControl与Lifecycle仍通过窄能力执行各自规则，route只保留transport；
- Worker sentinel和complete/fail保持；
- route无orchestration的结构审查。

### 停止条件

若必须修改 Lifecycle SQL、Worker sentinel或local runtime等价执行才能迁移，停止并拆分方案。

## Worker Runner 主控制流漂移

### 风险

为“完整治理Compaction”顺手重写threshold、model fallback、retry、abort、one-shot summary或循环。

### 控制

- Worker生产代码原则上不改；
- runner.auto-compact tests作为硬护栏；
- diff审计；
- Worker结构治理后置。

### 停止条件

任何非必要Runner主控制流修改均从本阶段移除；若API边界无法在不改Runner情况下落地，停止讨论。

## Archive search/read 合同偷带统一

### 风险

实现迁移时顺手加入Shared schema/endpoint、改变错误envelope或分页，扩大Worker/API合同范围。

### 控制

- 只迁实现归属；
- Shared diff审计；
- route/api client/builtin回归；
- 冻结beforePos/pos/noArchive/maxChars。

### 停止条件

若实现需要改变path/body/response或新增Shared contract，停止并另立 archive read-side协议方案。

## Snippet 依赖循环或提示漂移

### 风险

Archive coordinator调用Read-side组装prompt，或Read-side依赖write application；迁移还可能改变locale、插入顺序、cache miss降级。

### 控制

- 窄 `ArchiveExcerptReader`；
- cache capability独立；
- locale/order/cache failure tests；
- dependency/wiring审计。

### 停止条件

若任一方向需要注入完整peer application/service，停止并重新切分数据reader与prompt projection。

## Fault hook 变成生产开关

### 风险

- hook进入业务branch；
- 生产可通过配置启用破坏性fault；
- hook context包含archive正文；
- 继续挂在AppContext并扩张字段。
- fork-with-archive尚未迁入窄hook时就删除现有fault字段，导致测试seam断裂或被迫回退到全局开关。

### 控制

- 生产no-op；
- 只在test composition注入；
- hook只抛错/制造外部变化；
- context只含ids/size/fileKey；
- wiring test禁止application读取AgentTestFaults。
- fork-with-archive等append调用方完成窄hook接线；未完成前只允许composition-root过渡mapping。

### 停止条件

若hook影响业务决策、暴露用户内容，或实现试图在仍有append调用方依赖旧fault seam时直接删除字段，停止 P1/P2并缩窄/补齐接线。

## Facade 新旧双权威

### 风险

新application建立后，`AgentService`仍保留可调用的archive helper和compact/clear规则，形成双路径。

### 控制

- 每批明确切换点；
- P3/P4同批删除旧production path；
- wiring tests；
- P5搜索清理。

### 停止条件

不得让双生产权威跨批长期存在。切换无法原子完成时回滚该批。

## Startup 阻塞或顺序漂移

### 风险

archive candidate失败中断全扫描，整体失败阻止Lifecycle/Worker，或Archive启动顺序越过Subtask/Lifecycle。

### 控制

- candidate isolation；
- module top-level isolation；
- startup order wiring test；
- module只触发。

### 停止条件

如archive reconcile错误导致app注册/listen失败或改变既有relative order，回滚 P4。

## 测试失真

### 风险

fake fs自动返回snapshots、fake DB自动冲突，使顺序测试绿色但真实文件/SQLite约束未覆盖。

### 控制

- storage真实临时文件；
- persistence真实SQLite；
- fake只测编排；
- 保留HTTP/Worker主链；
- fault hook受控。

### 停止条件

关键fs/SQLite evidence未建立时，P2-P4不得标记完成。

## 日志与隐私

### 风险

warning输出summary、archive line、search query命中或prompt。

### 控制

- 只记录ids、operation、fileKey、size、count、status、err；
- review logger fields；
- 测试不打印archive正文。

### 停止条件

任何新日志包含用户正文或凭据即必须修复后再继续。

## 性能与启动风险

可能增加：

- archive文件重复枚举/read/stat；
- per-session reconcile重复调用；
- snippet cache miss重复扫描；
- startup为所有session创建过多对象/log；
- search/read重复读取同一文件。

控制：

- 保持既有调用次数基线；
- storage提取不默认加预扫描；
- 不为抽象重复读取；
- 必要时定向性能/调用次数测试，但不做全量性能优化。

## 明确非目标

- archive/DB强事务；
- staging/outbox/content-addressed archive；
- multi-file自动reconcile；
- 跨进程lock/lease；
- archive格式迁移；
- DB schema重建；
- archive search/read Shared统一；
- Worker runner重构；
- public fork/revert产品重构；
- UI redesign；
- Plugin/MCP/Git environment治理；
- Session/Routes/Module最终收尾。
