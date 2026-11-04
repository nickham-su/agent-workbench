# 后端、生命周期与无损迁移

## 创建与继承的唯一权威

### 存储落点

- 现状生产 Session 插入集中在 `createMessageSession()` 和 `forkMessageSession()`；stable／historical Fork 复用前者，resolved／public Fork 走后者。代码定位见[证据清单](07-code-map.md)。
- 在这两处现有 SQLite 事务中写 Session、初始 RunState、初始 TabState；Tab 插入失败必须使整个创建失败，不得先返回 Session 再补写。
- 使用窄存储函数计算最终 visibility 与初始 visible，不建通用创建框架。所有新建路径传入真实执行父／内容来源标识；无父、无来源的独立创建使用 listed，定时执行使用快照预期。
- 在同事务读取 parent/source，核对其真实 Workspace；内部调用的父身份还须沿用父 Run、工具调用绑定校验。客户端不能通过省略、伪造 `forkedFromSessionId` 决定策略。

### 最终可见性

```text
new.visibility = unlisted，若满足任一：
  创建意图明确要求 unlisted
  真实执行父 visibility 为 unlisted
  真实内容来源 visibility 为 unlisted
否则为 listed
```

- 内部独立定时执行的创建意图来自持久化执行快照，不来自当前任务配置或调用者任意参数。
- 没有 source 指针的摘要／无边界降级仍带上策略所需的真实执行父，不为继承隐藏而伪造历史血缘。
- 新建 primary 的初始 Tab visible 按最终 visibility 计算；subtask 初始始终关闭。
- 无来源 Session、跨 Workspace、来源图损坏等仍按原有来源验证失败；不得为了隐藏继承放松来源边界。

### 必须覆盖的创建族

| 创建族 | visibility 判定依据 | 特殊检查 |
| --- | --- | --- |
| 普通独立 primary | 未显式隐藏则 listed | 现有 create API 不新增隐藏配置 |
| 公开 Fork／CLI Fork | 请求意图＋真实来源 | 保留 primary、选点和历史稳定性规则 |
| 子任务 new | 真实执行父 | fork 指针为空／无消息也必须继承 |
| 默认 resolved Fork | 真实执行父及实际来源 | 保留既有运行中 Fork 契约 |
| 显式 stable source Fork | 执行父 OR 内容来源 | 两者可不同，存储端口不能漏传父 |
| 摘要／无边界降级 | 执行父及真实内容来源 | 不从缺失血缘字段推断 listed |
| 定时 new_session | 执行快照预期 | 新快照 unlisted，旧缺省 listed |
| 定时 historical Fork | 快照预期＋真实来源 | 固定锚点，expected ID 和来源身份匹配 |

### 复用与并发捷径

- 不修改既有目标 visibility。隐藏父复用 listed subtask 明确 409，listed 父复用 known unlisted 合法。
- 检查点覆盖 `mode=existing` 物化、`findChildByParentToolExecution()` 直接返回、唯一键竞争 winner、预分配 ID 命中已有 Session。
- 将可见性检查纳入既有父／来源／目标绑定校验路径，不仅在 INSERT 前检查。现有 `SqliteSubtaskRunQuery` 的独立投影必须增加 visibility。
- 对新发送及激活，权威检查在对应现有同步事务的写副作用之前；查询到失败不能再插入 user message、Run、去重记录、工具激活状态或 enqueue。
- 竞争 loser 可按既有机制补偿自己尚未使用的新会话，但不得删除 winner 或修改目标属性；补偿删除须同步清理 Tab。
- 已有 child Run 返回路径也必须核对目标 visibility；返回不合规历史结果不能作为绕过规则的办法。由于 visibility 不可变，合法已受理的新模型任务不会随时间变成不合规。

## 发现、事件与内部使用

### 查询落点

- Continuable、活动查询、recent 在 SQL 候选中加 listed 条件，排序、游标、limit+1、total、聚合计数均基于同一过滤集合。
- 活动查询继续验证候选 RunState，不能用新 inner join 将损坏行静默排除；不能只在返回数组上过滤。
- tabs 改为真实 Session 同 Workspace JOIN TabState 且 visible=1；先验证该工作区真实 Session 的状态完整性，避免损坏被 JOIN 掩盖。items 与 openedSessionIds 在一个一致性读事务生成。
- 独立 Tab 状态接口使用同一投影实现；不保留 kind 默认算法，不返回关闭隐藏 ID。
- 旧 `listMessageSessions()`／`service.listSessions()` 需逐调用点分类：对外枚举应过滤 listed；内部生命周期／清理扫描不能共用已过滤列表。保持显式命名／窄入口，不机械给所有 Session SELECT 加过滤。
- 按 ID 获取 Session、消息链、状态、归档搜索、send 与控制操作保留；不得通过通用 getSession 的隐藏 404 阻断调用者。

### 完成 SSE

- 内部生命周期完成发布和 event hub 不过滤，收敛、父子完成和恢复继续运行。
- 在全局 SSE 导出边界读取事件对应真实 Session，仅 listed 导出；unlisted 被用户打开 Tab 也仍不导出。
- 找不到 Session、跨 Workspace 或查询失败时该条不导出，不能回退“默认 listed”；固定诊断不得带正文、原始 SQL、凭证或无界重复日志。
- 不改变事件格式和 listed 完成事件顺序。SSE 客户端断开、过滤判断失败不能回滚已完成 Run。
- 定向前端状态轮询和 CLI follow 仍按 ID 工作；定时任务原本通过 reconcile 更新状态，不改成依赖全局通知。

## Tab 实际状态生命周期

- 所有新建均原子初始化；开闭 PUT 在既有 Workspace mutation／删除围栏内 UPDATE，不根据 kind 删除记录。
- 幂等重用只确认 Session 身份，**不检查或重置用户后续 visible**。隐藏会话已经打开后，任务创建恢复仍应成功。
- 子任务创建失败补偿、空子任务回收：仅在 Session 安全删除成功时，同事务删除对应 TabState；如果 Session 不满足删除条件，必须保留状态。
- Workspace 删除保持既有 drain／删除事务，最终 workspace 外键级联清除 TabState。
- Tab 表属于基础域，既有 Agent 域重建不自动清理它。明确 Agent 域清空／重建路径需在其受控事务清理相关 TabState，避免遗留 ID 复活；本次 v23 升级绝不调用该路径。
- 展示不变量错误局限 Tab 接口；通用 Session 查询、运行恢复及 Analytics 不 JOIN Tab 表，不以 UI 状态损坏为由漏掉活跃任务。

## 定时执行与升级恢复

### 新声明执行

- `snapshot(task)` 在声明事务写内部 `sessionVisibility:'unlisted'`；两种模式、manual／scheduled 使用同一策略，无公开配置。
- 创建与 Fork 端口传递预期 visibility；预分配 ID 匹配加入它，既有 title、head、root、revision、fork 来源要求全部保留。
- Run 激活事务的 `expectedHistoricalFork`／预分配 new_session 预期也加入 visibility，防止创建与发送间的身份冲突。不要把 visible 加入预期。
- 当前 Run 激活先查请求去重，已有请求可以早返回；新的可见性检查不能误要求已运行 Session 仍 pristine。已有受理路径只验证稳定身份（Workspace、Session、预期 visibility、请求→Run），继续 reconcile，不二次发送。

### 旧快照兼容

| 状态 | 处理 |
| --- | --- |
| 旧快照无标记、合法路径再次调用 execute 且尚无 Session | 按旧 listed 创建，不改成 unlisted；不因此新增启动自动重发 |
| 旧快照无标记、合法路径再次调用 execute、Session 已建但 Run 未受理 | 按 listed 匹配原 pristine 身份，保留用户已改的 Tab visible |
| 旧／新执行已有 Run 或请求去重 | 核对稳定身份后沿用原 runID reconcile，不重新创建／发送 |
| 预期与真实 visibility 不同、无受理证据 | 沿用 SESSION_ID_CONFLICT 和 session_id_conflict，不能强改属性 |
| 已有受理证据但身份／Run 链冲突 | 保留当前 unresolved／活跃互斥语义并诊断，不误释放为终态、不再次发送 |
| 新快照为 unlisted、尚无 Session | 创建 unlisted，默认 Tab 关闭 |

- 保留当前启动恢复：starting 且无 runID、无请求受理证据、也不处于 unresolved 的执行，收敛为 `failed_to_start/startup_interrupted_before_run`，不是自动重新发送。旧属性兼容覆盖已有 execute 重入与身份匹配，不新增重试协议。
- 非法快照须在 active 扫描的单执行边界隔离，诊断后继续处理其他合法执行，不释放该执行可能占用的互斥位；不能让一条坏 JSON 中断全部任务收敛。
- `execute()` 的 dedup 早返回、`reconcile()` 的原 Run 校验以及启动恢复入口都要覆盖，不仅修改两个创建分支。
- 旧数据所有 Session 在迁移时成为 listed，因此旧来源隐藏继承不存在冲突；不得把历史 JSON 缺省解释为当前新策略。
- `sessionAvailable` 继续由真实 clientRequest→Run 关联证明，不能只检查 Session ID 是否存在。skipped 保持无 Session，ID 冲突不开放导航。
- 用户后续从 Tab 发送新 Run 不改变原执行行绑定；隐藏子任务也通过既有定向入口查看。

## v23 → v24 无损增量迁移

### 当前事实及升级策略

- 当前 `AGENT_SCHEMA_VERSION=23`，分类器严格检查表集合、列名及其顺序和语义；`hasExactColumns()` 是逐位置比较，不是只检查列集合。合法旧白名单版本落入 `rebuildable`。
- 只将常量改为 24 会让 23 不在白名单而拒绝；若只把 23 加入旧白名单而无独立分支，则会重建。**两者都不是本次迁移方案。**
- 增加独立 `upgradeable-v23` 分类，冻结完整合法 v23 结构／语义验证，并让 `assertAgentSchemaSupported()` 接受可无损升级状态。不能用目标 v24 的列序去验证 v23，也不能只凭版本数字接受损坏库。
- 本功能支持从完整 v23 原地无损升级及新建 v24。更早版本既有重建策略不作为本次“无损”承诺，不新增版本进入重建白名单；发布前必须明确源版本。

### 单一写事务内的步骤

- 在任何本次 DDL／数据改动前取得写保留锁（沿用 SQLite immediate 事务能力），重新读取版本并核验结构。外部启动预检查只是提示，不是事务内事实。
- 若另一个新进程已升级到合法 v24，按 current 路径结束；若仍为完整 v23 才继续。锁竞争失败按基础设施错误处理，不转 rebuildable。
- 保存原版本、cleanup 标记和所有 Agent 业务数据；使用 `ALTER TABLE agent_session ADD COLUMN visibility TEXT NOT NULL DEFAULT 'listed' CHECK (visibility IN ('listed','unlisted'))` 在原列末尾追加字段，旧 Session 全部 listed。
- 新建 v24 DDL 和 `TARGET_AGENT_TABLE_COLUMNS.agent_session` 同样把 visibility 放在原 `updated_at` 后，保证新建库与升级库具有相同规范列序；不得插在 kind 旁、放宽逐位置校验或重建表来规避差异。
- 以真实 Session 为驱动计算旧有效 Tab 语义：primary 仅同归属 visible=0 为关闭，否则打开；subtask 仅同归属 visible=1 为打开，否则关闭。
- 在同事务规范化 TabState：移除旧 orphan／跨 Workspace 状态，给每个真实 Session 写一条实际 visible；不能复活旧无效覆盖。保留有效覆盖 updated_at，其他回填使用 Session created_at。
- 同步目标 schema 有序列数组／约束／语义探针；探针内部样例 Session 若需要状态，也必须符合新模型，不得因探针回退而重建真实数据。
- 验证目标结构、visibility 的列属性及枚举约束、真实 Session 与 TabState 一一对应、归属、外键、原业务数据／历史引用保留。除已有数据取值外，必须证明 `NOT NULL`、默认 listed 和枚举 `CHECK` 确实生效；在现有受控探针环境中验证缺省写入及 null／非法值拒绝，不向真实业务表遗留测试行。
- 最后更新版本为 24，`file_cleanup_pending` 原值不变，版本元数据更新时间可变。任何步骤失败整事务回滚，最终只能为完整 v23 或完整 v24，不能留下半迁移。
- 不改写历史执行快照、不重置执行状态，不删除图片或生成新的清理任务，不关闭 foreign_keys 绕过校验。
- “不触发清理”指本增量迁移不调用清理、不把 pending 从 0 置 1。现有 `openDb()` 在 pending 原本为 1 时仍会执行既有清理续作并可能清除标记，这是原机制，不得声称整个启动绝不清理。迁移函数保留 0／1 的测试与 openDb 的既有 pending 续作测试分开；正常 pending=0 升级必须证明没有文件清理调用。

### 启动和维护边界

- v24 正常运行时不做每次全库修复。Tab 缺行通过相关展示接口诊断，不在通用启动结构校验中把 UI 数据异常升级为“所有执行不可恢复”。
- 重复启动不重写 visible，不改变用户开闭；并发新进程第二次事务核验后跳过已完成迁移。
- 对新建 v24 库与真实 v23 升级库分别检查有序列名、类型、非空、默认值和约束语义，规范结构必须一致；两者 close/reopen 后均分类为 current，第二次启动不得迁移、重建或回填。
- 部署必须停掉旧 API、调度及读取数据库的旧相关进程，再整体升级。旧代码遇 v24 在启动时拒绝，但已打开的旧连接不会自动停机，因此不支持混跑。
- 升级前停机备份数据库及配套数据；回退使用同一时点备份和旧代码。不得手改 schema 版本或删除 visibility 列假装兼容。
- 不新增通用迁移平台。本次专用升级函数和真实 v23 夹具足够，但必须通过[迁移验收组](06-acceptance.md)。
