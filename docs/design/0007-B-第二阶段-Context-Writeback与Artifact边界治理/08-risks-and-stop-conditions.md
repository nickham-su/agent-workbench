# 风险、停止条件与回退原则

## 主要风险

### Store 原子边界被弱化

**表现：** 新 application 分别查询 session、run、run-state、head，再调用普通 append/update。

**后果：** 初步判断与写入之间重新出现竞态，late writeback 可能污染 DB，普通 conflict 可能被误判为 ignored。

**控制：**

- create 必须依赖 `appendContextItemWithRunFence()` 等价原子能力；
- update 最终必须依赖 `updateContextItemWithRunFence()` 等价原子能力；
- persistence 证据使用真实 SQLite；
- 审查 transaction boundary 和 result union；
- 不以 repository 分层纯洁性为理由拆事务。

### ignored、unchanged、not-found、conflict 被统一

**表现：** 使用统一 `{ ok:true }`、null、boolean 或通用 no-op；create/update 共用错误转换后丢失差异。

**后果：** Worker 无法判断 create 是否有 item ID，404/409 产品语义漂移，终态 update response 改变。

**控制：**

- create normal/ignored 保持可判别联合；
- update 继续返回 stored item；
- missing run 单独测试；
- ordinary head conflict 单独测试；
- application result 映射使用显式 union。

### 初步 update fence 被误当最终权威

**表现：** artifact 写入后直接普通 update，不再做最终事务 fence。

**后果：** 初步检查后发生 cancel/terminal/switch 时，旧 Worker 可污染 DB。

**控制：**

- 文档和代码明确两次 fence 的不同目的；
- final fence race 使用可控测试；
- P4 审查检查最终调用仍为原子 capability。

### Artifact 顺序被“顺手优化”

**表现：** 改为 DB 后写文件、失败回滚、临时文件提交、自动删除孤儿，或文件失败改为请求失败。

**后果：** 改变已验收 UI/DB 副作用、错误和重试语义，超出结构治理。

**控制：**

- P0 冻结初步 fence → file → final fence；
- P5 默认机械等价迁移；
- 文件/DB 顺序和失败政策任何改变触发停止；
- 不引入全局事务/outbox。

### Artifact capability 过度通用

**表现：** 接受任意 path、完整 AppContext、archive/compaction 类型，或负责业务日志/status。

**后果：** 建立新的全能 filesystem service，模糊 Query/Writeback/Archive 边界。

**控制：**

- 只允许受限 artifact kind/identity；
- capability 只做安全 I/O；
- archive/compaction 明确排除；
- Writeback/Query 各自保留业务映射。

### Query 反向依赖 Writeback

**表现：** UI artifact 读取调用 Writeback service，或 Writeback 暴露综合读写 service。

**后果：** 读写方向循环，后续 Context Query 无法独立收尾。

**控制：**

```text
Writeback → Artifact capability
Query     → Artifact capability
Query     ↛ Writeback
```

阶段审查检查 import 和构造依赖。

### Facade 与新 application 双实现

**表现：** `AgentService` 保留旧 fence/artifact/title 逻辑，新 application 又实现一份。

**后果：** 规则分叉、测试覆盖两条路径、后续功能继续落入 facade。

**控制：**

- P3/P4/P5 每个用例迁移后立即删除旧权威；
- facade 直接委派测试；
- P6 检索旧 helper/Store 直接调用；
- 不使用长期 feature flag 双路径。

### Title 副作用漂移

**表现：** ignored/unchanged 也更新 title，或 create/update 成功后遗漏。

**后果：** UI session title 与 Worker 写回状态不一致。

**控制：**

- application 单测覆盖 success/no-op/error 矩阵；
- title updater 是窄执行能力，触发规则只在 application；
- 保持 `normalizeTodolistGoal()` 既有语义。

### Testkit 再次扩张为独立工程

**表现：** 新增万能 session/run/context builder、fake Store、writeback fault collection，却与生产迁移无直接需求。

**控制：**

- 默认复用 0007-A frozen public API；
- 当前领域 helper 私有；
- 公共变更必须证明跨文件相同语义；
- 修改公共合同要暂停并重新审查 0007-A 门禁；
- fake Store 永远不能替代 SQLite fence 证据。

### 测试文件拆分损失 archive 证据

**表现：** 从 `context-item-contract.test.ts` 迁出 writeback 时误删 compaction/archive/sidecar fixture 或断言。

**控制：**

- P0 建立逐用例索引；
- 迁移前后比较测试名、断言、结果；
- archive 场景留原文件；
- 不以清空大文件作为完成指标。

### Lifecycle 越界

**表现：** 为解释 terminal/cancelled fence，顺手迁移 run-state、complete、cancel、recovery。

**后果：** 将两个高风险阶段合并，破坏 0006 顺序和回滚性。

**控制：**

- Writeback 只消费现有 run/session 状态；
- lifecycle rule 不进入新 application；
- 发现 lifecycle 缺口时记录为下一阶段输入并停止当前扩大。

### 外部工作区变更被误处理

**表现：** 覆盖、清理、暂存、取消暂存或混入任何非本阶段产生的 staged/worktree 变更。

**控制：**

- 每批先完整记录 `git status --short --branch` 并建立保护清单；
- git add 使用精确路径；
- 不运行全目录格式化/清理；
- 审查确认阶段 diff 只包含本阶段预期文件。

## 强制停止条件

出现以下任一情况，立即停止当前批次并与用户/设计评审讨论：

- 需要修改 Shared endpoint、request/response schema、public export 或 Worker validation；
- 需要改变 create normal/ignored response；
- 需要给 update 增加 ignored 或改变 unchanged item；
- 需要改变 missing、ownership、head conflict 的 status/body；
- 需要把 Store fence/CAS 改为 service/application 先读后写；
- 需要改变 Store transaction、SQL 或 terminal status policy；
- 需要删除初步或最终 update fence；
- 需要改变 artifact 文件写入与 final DB fence 顺序；
- 需要改变 artifact path、JSON 格式、失败政策或自动清理；
- 需要修改 run lifecycle/cancel/recovery/enqueue failure；
- 需要修改 DB schema、文件格式或 UI 行为；
- 需要深拆 Worker Runner 或 builtin tool 控制流；
- 需要使用 fake Store 才能让测试通过；
- 需要扩大 `AppContext.agentTestFaults`；
- 需要修改 0007-A testkit 公共合同但尚未完成重新审查；
- 新组件必须接收完整 `AgentService`/`AppContext` 或形成 Query↔Writeback 循环；
- 为通过测试必须删除关键断言、扩大 `any`、屏蔽错误或使用不确定 sleep；
- 任何操作会改变非本阶段 staged/worktree 变更的内容或 index 状态。

## 回退原则

### P0/P1

- 保留基线文档和新增 characterization；
- 回退 testkit/测试迁移到原 fixture；
- 不影响生产代码。

### P2

- 删除骨架和装配；
- 恢复 `AgentService` 直接实现为唯一权威；
- 不保留无调用 adapter。

### P3

- create 为独立回退单元；
- 恢复旧 create 唯一实现；
- update 保持未动；
- 不改 Shared/Store。

### P4

- update 非 artifact 规则为独立回退单元；
- 恢复旧 update 唯一实现和两次 fence；
- 不留下 application/legacy 双路径。

### P5

- 恢复 service 内 artifact 读写唯一实现；
- 删除共享 capability 或恢复 Query/Writeback 一致调用；
- 不改变已有 artifact 文件；
- 不进行数据迁移或清理。

### P6

- 只回退收尾测试/文档/死代码清理；
- 若最终审查发现行为漂移，优先恢复上一批单一权威实现，再修设计。

## 后续阶段交界

### Run Lifecycle

本阶段完成后，Run Lifecycle 可以依赖稳定的 writeback fence 结果，但不得让 Writeback 反向依赖完整 lifecycle service。cancel/recovery 规则仍由下一阶段定稿。

### Context Query / Session / Routes / Module

本阶段只冻结 Query 与 Writeback 共同依赖 artifact capability。Query 最终模块、facade 和 public route 位置留到收尾阶段。

### Compaction / Archive

不得因共享安全 fs helper 就把 archive/sidecar 纳入本 capability。后续 archive 阶段可复用更底层、经证明通用的安全原语，但必须独立设计。

### Subtask

Subtask 不属于本阶段；相关用户或并发任务变更统一按“外部工作区变更保护”处理，不在各章节重复列举具体目录。

## 方案偏差处理

实施发现更合理结构时：

- 可调整名称、目录、class/函数式形态；
- 必须保持不变量、原子边界和依赖方向；
- 在 `09` 记录证据、替代方案、影响和回滚；
- 超出范围时暂停另立方案，不扩大当前批次。
