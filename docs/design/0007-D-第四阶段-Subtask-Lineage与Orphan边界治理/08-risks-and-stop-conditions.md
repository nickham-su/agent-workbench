# 风险、非目标与停止条件

## 高风险点

## Child activation 事务被弱化

### 风险

将 summary/guard/prompt、run record、run-state 拆为 application 多次 CRUD，会出现部分 seed、无 run、run 已有但 state idle 等新空壳/脏状态。

### 控制

- 保持单个 SQLite transaction；
- persistence method 按业务命名；
- 真实 SQLite rollback tests；
- 审查 transaction SQL 和最终 state，而非只看 application test。

### 停止条件

若窄 Lifecycle activator 无法在不扩大依赖的前提下保持原子性，停止 P3，回到设计。不得以“先迁 application、后补 transaction”为过渡。

## Lifecycle 与 Subtask 循环依赖

### 风险

- Subtask 依赖完整 Lifecycle；
- Lifecycle cancel 又依赖完整 Subtask；
- 两者通过 `AgentService` 互调。

### 控制

- Subtask 只依赖 `SubtaskChildRunActivator`；
- Lifecycle 只依赖 `ActiveSubtaskChildQuery`；
- 同一 SQLite adapter 可实现两个接口，但 consumer 注入面分开；
- wiring tests/类型审计。

### 停止条件

若需要任一 domain 注入完整 peer service 才能完成迁移，停止并重新上移/拆窄跨域能力。

## Worker nested execution 被误改

### 风险

把 child activation错误接入 `startUserRun()` 或 runtime enqueue，会导致双执行、reuse 重启、abort/polling 语义变化。

### 控制

- activator 明确“no enqueue”；
- Subtask application不依赖 RuntimeControlPort；
- Worker provider tests 与 API-managed Worker证据；
- 搜索 Subtask目录中的 `enqueueRun`；
- `AgentRuntime`构造参数/local execution port不新增Subtask能力；
- worker-disabled module wiring不注入Subtask application/activator。

### 停止条件

如实现需要修改 Worker主控制流、Shared payload，或需要为local fallback新增nested-subtask execution才能落地API结构，视为方案边界不成立，停止讨论，不得顺手深拆或误接线。

## Unique race 误分类

### 风险

把其他 unique/constraint 错误误判为 parent-tool race，可能吞掉真实数据错误并错误返回 reused。

### 控制

- 只识别 index name 或精确两字段 unique message；
- classifier 与 SQLite adapter邻近；
- negative tests；
- race 后必须查到 durable winner。

### 停止条件

若当前 SQLite driver错误无法稳定区分目标 constraint，需先设计可控错误/result映射；不得捕获所有 `SQLITE_CONSTRAINT`。

## Compensation 误删 existing/winner

### 风险

通用 cleanup 接受任意 sessionId，导致 existing session、race winner 或已有内容的 cloned session被删除。

### 控制

- 只持有本次 `createdSessionId`；
- existing返回 null；
- final empty fence；
- loser/winner身份测试；
- local compensation capability不接受 age/lineage开关；
- local compensation与start failure在P3同批迁移，P4不再出现第二业务切换；
- 当前重复cleanup调用只作为P0实现事实，允许P3在语义等价前提下收敛。

### 停止条件

若实现不能证明 session 是本次创建，禁止调用 compensation。

## Orphan 删除范围扩大

### 风险

结构迁移时把所有空 subtask session 自动删除，或删除缺少 fork lineage/null-boundary session。

### 控制

- 固定 1h suspect、24h delete；
- 固定 fork lineage双字段；
- orphan公开port不暴露 `requireForkLineage` 或等价开关；
- final DB recheck；
- 共享SQL原语只允许在SQLite adapter内部私有存在；
- current integration + new persistence tests；
- 文档/SQL双审查。

### 停止条件

任何删除范围变化、阈值变化或自动修复扩张都必须另立产品/数据方案。本阶段立即停止该改动。

## Anchor/lineage 弱化

### 风险

仅按 `subtaskSessionId`、session metadata 或 tool output寻找 child，破坏 durable parent关系和 cancel。

### 控制

- `(parentRunId,parentToolItemId)` 唯一权威；
- parent tool真实 join；
- tool output伪造/缺失测试；
- SQL审查禁止 session hint where/join。

### 停止条件

若任何主链需要把 `subtaskSessionId` 升格为唯一依据，必须先说明新证据、迁移和历史兼容；否则禁止实施。

## Session clone / Archive 边界外溢

### 风险

为迁移 internal fork而重写 public fork、archive sidecar或 clone rollback，混入下一阶段高风险文件副作用。

### 控制

- 复用 `0008` private clone/materializer；
- Subtask 通过窄 port；
- archive主体不迁移；
- public fork回归。

### 停止条件

如必须改变 archive格式、sidecar政策或 public fork contract，停止并拆独立阶段。

## Facade 双权威

### 风险

application 新增后，旧 `AgentService` private helper仍可被调用，形成新旧两条 start/orphan路径。

### 控制

- 每批明确 production切换点；
- wiring test；
- P3/P5同批删除旧规则；
- P6搜索清理。

### 停止条件

不得让双生产权威跨批长期存在。若切换无法原子完成，回滚该批。

## 测试失真

### 风险

fake persistence直接返回 race/transaction结果，使测试绿但真实 SQLite约束未覆盖。

### 控制

- unique、transaction、delete fence必须真实 DB；
- fake只测编排；
- 保留 HTTP/Worker主链；
- 对照迁移前后测试索引。

### 停止条件

关键 SQLite evidence 未建立时，P3/P5 不得标记完成。

## Startup 阻塞

### 风险

orphan scan 抛错阻塞 archive、Lifecycle或Worker start，或 candidate错误中断全扫描。

### 控制

- application candidate isolation；
- module top-level isolation；
- wiring/startup tests；
- 保持相对时序。

### 停止条件

如迁移后 orphan错误导致 app注册/listen失败，回滚 P5。

## 日志与隐私

### 风险

迁移 logger时输出 prompt、description、tool args/result或 context内容。

### 控制

- 只记录 ids、状态、计数、错误；
- logger窄 port；
- 审查日志字段；
- 测试不打印敏感 fixture。

## 性能风险

可能增加：

- anchor重复查询；
- winner重复查询；
- profile/settings重复读取；
- result多次 transcript扫描；
- startup重复scan。

控制：

- P0画出查询次数；
- application在同一用例复用已解析 parent/profile；
- 不以抽象为由重复读 DB；
- 本阶段不要求优化，但不得明显退化。

## 明确非目标

- 新 Subtask产品能力；
- 新 session mode；
- nested run恢复；
- local fallback nested-subtask execution或AgentRuntime Subtask API；
- 强制 runtime停止；
- lineage DB迁移/check/foreign key；
- `subtaskSessionId` DB权威化；
- orphan全量自动修复；
- 多实例 startup leader election；
- Worker runner状态机重写；
- Shared contract扩张；
- UI redesign；
- Archive/DB全局事务；
- 通用 repository/DI/event bus；
- 全局性能优化。

## 设计偏差处理

若实施发现推荐的 Lifecycle-owned activator 不如独立 atomic Subtask persistence 合理，允许偏差，但必须记录：

- 真实 transaction/依赖证据；
- 为什么推荐方案会增加循环、重复或不必要复杂度；
- 替代能力的唯一权威位置；
- 对 `0006/0007-C` 的影响；
- 测试和后续清理入口；
- 独立审查结论。

不能仅以“改动更少”作为保留 facade transaction 的理由。

## 阶段级阻碍性问题

出现以下任一项，应停止并请求用户决策：

- 必须改变 Shared contract或 Worker payload；
- 必须改变 DB schema/历史数据；
- 必须重写 Worker nested execution；
- 现有产品语义在代码、测试与 `0008` 之间存在无法判定的冲突；
- unique race无法用现有 DB约束安全表达；
- activation无法保持单事务；
- orphan删除范围需要产品重新定义；
- 发现与本阶段重叠的未知用户改动，无法安全隔离；
- 完整回归出现与改动相关且修复方案会扩大到 Compaction/Archive或Worker深拆。

## 每批回滚边界

- P0/P1：仅测试/文档，可独立回滚；
- P2：骨架未切 production path，可整体删除；
- P3：application+activation+local compensation+facade切换必须整体回滚；
- P4：query与删除adapter/导出边界按调用链整体回滚，不承载新的compensation业务切换；
- P5：orphan application+persistence+module wiring整体回滚；
- P6：只清理已无调用代码和文档，不引入新语义。

不允许通过 git history重写、DB迁移或人工数据修补完成本阶段回滚。
