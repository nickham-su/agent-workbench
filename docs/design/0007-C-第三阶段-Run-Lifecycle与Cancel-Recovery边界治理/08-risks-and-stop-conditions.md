# 风险、停止条件与回退原则

## 主要风险

## Activation 原子事务被拆散

**表现：** Session/Interaction 先提交 user item/dedup，Lifecycle 再提交 run record/run-state，或 Route 依次调用多个 use-case。

**后果：** 部分落库、session head 与 run 不一致、dedup 指向不存在/未激活 run、并发 send 竞态扩大。

**控制：**

- 使用单一 atomic activation capability；
- 真实 SQLite rollback 测试；
- 审查 transaction callback 和 conflict mapping；
- 不以领域纯洁性为理由拆事务；
- Route 只调用一个跨域入口。

## `sendMessage()` 责任仍被后移

**表现：** 新 Lifecycle 只迁移 cancel/recovery，send 继续由 Service+Route 拼装，计划留到最终收尾。

**后果：** 违反 0006 明确门禁，enqueue failure 与 error ownership 继续分叉。

**控制：**

- P3 必须定稿协作接口、transaction 与错误归属；
- P6 检查 Route 不再读取 context/enqueue；
- 最终收尾只讨论 facade/目录/route 位置。

## Public enqueue failure 被臆测或静默修复

**表现：** 未做 P0 characterization 就直接给 Public Route 增加 helper，或按“应该 503”修改测试。

**后果：** 可能改变 retry/dedup/user item/UI 状态语义，掩盖历史合同。

**控制：**

- P0 必须冻结 HTTP/DB/dedup 事实；
- 决策记录当前事实、目标、迁移影响；
- 行为修复需独立审查；
- 不删除 user item/dedup，除非有明确授权。

## Enqueue failure 覆盖 cancel/terminal

**表现：** enqueue catch 后无条件将 run failed、run-state idle。

**后果：** cancel/complete 被覆盖，`cancel wins` 失效，可能 idle 当前新 run。

**控制：**

- 条件更新 running/in-flight；
- activeRunId matching CAS；
-竞态测试覆盖 cancel/complete/switch；
- result union 明确 no-op 原因；
- 不用 service 先读后写替代条件 SQL。

## Dedup 与 retry 语义破坏

**表现：** enqueue 失败后 dedup 永久返回 failed run且不重试，或 retry 重复 enqueue/创建 run。

**后果：** 用户请求丢失或重复执行。

**控制：**

- P0 对 Public/internal 路径做 retry characterization；
- P3 明确 dedup result 是否携带 schedule state；
- 不扩 Public response schema；
- 必须通过 DB与runtime call count 测试。

## State/complete 先读后写竞态扩大

**表现：** 新 application 分别读取 run/state，再用无条件 update 写入；迁移时删除 terminal/active-run guard。

**后果：** late Worker 状态覆盖 cancel/new run，terminal run 回退 running。

**控制：**

- 保留或增强现有条件能力；
- 真实 SQLite race/条件测试；
- P0 发现可复现缺陷时暂停设计，而非复制或顺手重写；
- 不引入重型 lease/generation。

## Cancel DB/runtime 顺序反转

**表现：** 为快速终止先调用 runtime，再做 DB，或把两者放入同一 try/catch 返回失败。

**后果：** runtime 不可靠导致 DB 仍 running；晚到写回可继续污染；HTTP 行为漂移。

**控制：**

```text
DB transaction success
  → runtime cancel allSettled
  → warning only
  → success response
```

- domain test 断言调用顺序；
- DB failure 断言 runtime 未调用；
- runtime failure 断言 DB/HTTP 不回滚。

## Worker adapter 与 Lifecycle 双重吞错/日志

**表现：** `AgentWorkerClient.cancelSession()` 内 warning+swallow，Lifecycle 又认为 error 可 reject；或两层都 warning。

**后果：** allSettled 证据失真、重复日志、难以定位 transport failure。

**控制：**

- P0 冻结真实 adapter 可观察性；
- P2/P4 只保留一层业务 warning 权威；
- adapter 与 Lifecycle 错误职责写入测试；
- 不改变 cancel HTTP success。

## Cancel child query 吸收 Subtask 主体

**表现：** Lifecycle 依赖完整 Subtask service，或复制 start/reuse/lineage 规则。

**后果：** 形成循环依赖，提前混入下一阶段。

**控制：**

- 只依赖 `ActiveSubtaskChildQuery`；
- durable `parentRunId + parentToolItemId`/现有 run lineage 查询为权威；
- 不使用展示字段代替 lineage；
- Subtask 写入与 orphan 明确排除。

## Terminal cache invalidation 遗漏或误清

**表现：** complete/enqueue failure 等已确认路径迁移后忘记 clear；no-op/old run 清掉新 active run cache；或在 P0 前擅自假设 startup fail 必须/无需显式 invalidation。

**后果：** prompt static cache stale 或不必要重建。

**控制：**

- terminal settlement result 驱动 invalidation；
- 按 runId 精确清理；
- success/no-op矩阵测试；
- 复用 0007-A cache capability；
- P0 以 cache 生命周期证据明确 startup fail 决策、适用前提与审计方式。

## Event 发布重复或时机漂移

**表现：** 重复 complete 发布多次，DB transaction 前发布，或 event failure 回滚 terminal DB。

**后果：** SSE 重复/幽灵完成、调用方状态错误。

**控制：**

- 只有实际 terminal settlement 发布；
- DB 成功后按当前等价时机 publish；
- duplicate terminal no-op 测试；
- event payload contract 不扩张。

## Recovery final fence 被弱化

**表现：** 只使用初始 candidate list；读取 runtime context 后直接 enqueue。

**后果：** final check 前 cancel 仍被 enqueue，破坏 `cancel wins`。

**控制：**

- 初步与最终 eligibility check；
- barrier/hook deterministic race；
- P5 审查 final check 调用位置；
- 不用 sleep 唯一证明。

## Recovery 被误改为强一致

**表现：** 尝试将 DB check 与外部 enqueue 放入“事务”，引入 outbox/lease，或 enqueue 后强制撤回。

**后果：** 大幅扩大架构、协议与故障模型，超出阶段。

**控制：**

- 保持 final DB fence + late writeback 收敛；
- enqueue 已发出不承诺强停；
- 重型线性化触发条件按 0006 后置。

## Fail/recover 模式被统一

**表现：** recover enqueue 失败立即 fail DB，或 fail mode 改成 enqueue；单项失败阻塞启动。

**后果：** 启动策略产品语义变化。

**控制：**

- 两个显式 use-case；
- failure isolation 单独测试；
- 日志与 hook 时机保持；
- 行为变化触发停止。

## Module 变成新的全能 coordinator

**表现：** 只是把 helper 移到 `AgentStartupCoordinator`，仍直接读写 Store并处理 orphan/archive/lifecycle。

**后果：** 结构问题改名未解决。

**控制：**

- coordinator 只调用 use-case；
- module/coordinator 不导入 lifecycle Store；
-各域 startup hook 保持独立；
- P6 import 审计。

## 本地 fallback 被顺手重写

**表现：** 为接口统一改 processRun、输出、并发或增加 AbortController。

**后果：** 引入未覆盖时序变化，混入 Worker治理。

**控制：**

- 只收窄依赖/type；
- characterization queued/running cancel；
- local fallback 独立回归；
- running abort 另立专项。

## Facade 与 application 双权威

**表现：** Service 保留旧 send/cancel/complete/recovery 规则，新 application 又实现一份。

**后果：** 调用路径分叉，修复只落一侧。

**控制：**

- 每个入口迁移后立即删除旧权威；
- facade 委派测试；
- P6 rg 残留；
- 不用长期 feature flag/callback 双路径。

## Testkit 过度扩张

**表现：** 万能 lifecycle fixture、fake Store、全局 race/fault hooks。

**后果：** 掩盖 SQLite/runtime 真实边界，测试工程独立膨胀。

**控制：**

- 优先复用既有 fake runtime；
- 领域 helper 私有；
- 公共扩展需多处真实复用；
- 不扩 `AppContext.agentTestFaults`；
- real SQLite/Worker 证据保留。

## 外部工作区变更被误处理

**表现：** 覆盖、清理、暂存、取消暂存或混入非本阶段变更。

**控制：**

- 每批完整记录 status；
- 精确路径操作；
- 不执行全目录格式化/清理；
- 审查阶段 diff 与 index。

## 强制停止条件

出现以下任一情况，立即停止当前批次并与用户/设计评审讨论：

- 需要修改 Shared method/path/schema/public export 或 Worker validation；
- 需要改变现有 public/internal HTTP status/body 而 P0 未建立事实与批准；
- 需要拆散 user item/title/dedup/run/run-state transaction；
- 需要改变 session running、workspace mismatch、subtask readonly 或 dedup 语义；
- Public enqueue failure 无法确定当前事实；
- enqueue failure 只能通过无条件写实现；
- 需要覆盖 terminal/cancelled/new active run；
- 需要改变 cancel DB-first、`cancel wins` 或 runtime best-effort；
- 需要改变 active child lineage 产品语义；
- 需要让 Lifecycle 依赖完整 Subtask application；
- 需要删除 recovery final DB fence；
- 需要让单 candidate failure 阻塞启动；
- 需要改变 fail/recover 模式含义或 startup hook 时机；
- 需要修改 run/context/run-state 状态枚举或 DB schema；
- 需要改变 prompt cache 或 event contract；
- 需要深拆 Worker Runner/provider/builtin；
- 需要为 local fallback 增加 running abort；
- 需要 generation/lease/outbox/分布式事务；
- 需要 fake Store 才能证明关键行为；
- 需要扩大全局 fault seam；
- 新组件必须接收完整 `AgentService`/`AppContext`；
- 为通过测试必须删除关键断言、使用不确定 sleep、扩大 `any` 或屏蔽错误；
- 任何操作会改变非本阶段 staged/worktree/index 状态。

## 回退原则

### P0/P1

- 保留基线文档与 characterization；
- 回退测试重组/testkit扩展；
- 不影响生产代码。

### P2

- 删除 Lifecycle 骨架/ports/装配；
- 恢复现有 Service/Route/Module 唯一权威；
- 不保留无调用 adapter。

### P3

- 恢复旧 `sendMessage()` transaction 与 Route enqueue；
- 恢复旧 failure helper 调用点；
- 删除 atomic activation adapter；
- state/cancel/recovery 保持未动；
- 不改 Shared/DB schema。

### P4

- state/complete 与 cancel 可独立回退；
- 每个入口恢复 Service/Route 旧唯一实现；
- 恢复 local runtime 旧注入；
- 不留下双日志/双 cache/event；
- 不触碰 Subtask/Worker Runner。

### P5

- 恢复 module 中 recovery 唯一实现；
- 删除新增 recovery use-cases/startup hook；
- 保持 P3/P4 Lifecycle；
- orphan/archive 保持原样。

### P6

- 只回退清理、测试归属和文档更新；
- 若最终审查发现行为漂移，优先恢复上一批已知单一权威，再修订设计。

## 后续阶段交界

### Subtask

本阶段只提供：

- 明确 run activation/start 能力；
- cancel 所需 active child query dependency；
- terminal/cancel/recovery lifecycle 能力。

下一阶段再治理 prefork/start/reuse/lineage/result/orphan。不得把本阶段的 child query 误当成完整 Subtask application。

### Compaction / Archive

本阶段可让 compact 启动复用 Lifecycle enqueue/failure 基础能力，但不迁移 compact/archive/sidecar 主体。后续阶段可依赖稳定 terminal lifecycle。

### Session / Routes / Module 收尾

本阶段定稿核心责任分界；后续只决定：

- `AgentService` 是否保留；
- routes 注入 application 的最终形态；
-目录与模块分组；
- 多域 startup coordinator 是否必要。

不得重新讨论 Session/Interaction 与 Lifecycle 的核心归属。

### Worker 结构评估

只有 API lifecycle 与端到端测试稳定后，才评估 Runner/builtin 主控制流。本阶段不提前改。

## 方案偏差处理

实施发现更合理结构时：

- 可调整名称、目录、class/函数式形态；
- 必须保持不变量、事务、条件更新和依赖方向；
- 在 `09` 记录新证据、替代方案、影响、测试和回滚；
- 行为或范围变化必须暂停并审查；
- 未记录偏差在审查中视为问题。
