# 关键决策、取舍与风险

## 决策摘要

| 决策 | 冻结结论 |
|---|---|
| 时间事实源 | child `agent_run` |
| 关联键 | `workspaceId + parentRunId(item.runId) + parentToolItemId(item.id)` |
| 开始时间 | `childRun.createdAt` |
| 结束时间 | terminal `childRun.updatedAt` |
| 持续时间 | terminal `Math.max(0, updatedAt - createdAt)` |
| running 持续时间 | 本期不展示；不得使用 `updatedAt - createdAt` |
| API 形态 | context item 可选 `subtaskRun` 读侧摘要 |
| 列表读取 | 后端批量投影，禁止 N+1 |
| 单项读取 | 与列表复用同一投影逻辑 |
| 重复 parent key | fail-open：省略冲突摘要、接口成功、每请求每 key 一次 error 诊断；发现即阻断发布/放量 |
| 状态图标 | child status 优先，parent item status 降级 |
| 数据库 | 不新增字段、不回填历史 |
| 前端请求 | 不增加逐卡片请求，不按 session `lastRun` 猜测 |

## 时间事实源必须是 child run

### 决策

使用 child `agent_run.createdAt/updatedAt`，不使用父 context item 或 child session 的时间。

### 原因

- `agent_run` 表示一次真实执行；
- 它已有明确 parent lineage；
- run lifecycle 已在终态时写 `updatedAt`；
- 现有 `run-state.lastRun` 已采用相同 duration 公式；
- session 可以被复用，消息项和 session 都不是“一次执行”的正确实体。

### 取舍

接受 `createdAt` 包含激活后调度/初始化时间，接受 `updatedAt` 是后端终态落库近似时间。产品只称“开始时间/持续时间”，不称模型耗时。

## 精确关联 parent tool，不按 child session 猜测

### 决策

关联必须使用：

```text
workspaceId       = parent item.workspaceId
parentRunId       = parent item.runId
parentToolItemId  = parent item.id
```

### 原因

- `session.mode = "existing"` 下，同一 child session 可以有多个 runs；
- session `lastRun` 会随后续执行变化，无法稳定代表旧卡片；
- `parent_run_id + parent_tool_item_id` 由 subtask 激活时写入；
- 数据库有 partial unique index 维护一张父工具卡片最多一个 child run。

### 取舍

对 `item.runId = null` 或缺失 lineage 的历史卡片不显示时间，优先正确性而非“尽量填满”。

## 由 API 返回产品摘要，不让 Web 解释底层字段

### 决策

在 `AgentContextItemRecord` 增加可选 `subtaskRun`，字段使用产品语义名称：

- `startedAt`；
- `endedAt`；
- `durationMs`。

不得只返回 child `createdAt/updatedAt` 让前端自行判断状态和计算。

### 原因

- API 是 run lifecycle 语义的权威边界；
- running 的 `updatedAt` 不是结束时间；
- 终态集合和 `Math.max(0, ...)` 不应散落到多个客户端；
- 可判别摘要可以让契约直接约束 running 与 terminal 不变量；
- 与现有 session `lastRun` 命名一致。

### 取舍

context item response 增加一个派生字段，响应体略增大，但只对 subtask item存在，且避免新增 endpoint 和额外请求。

## 使用可判别联合，冻结空值不变量

### 决策

推荐共享契约使用 `Type.Union`：

时间正值约束由 schema 直接表达：`startedAt` 和 terminal `endedAt` 使用 `exclusiveMinimum: 0`；projector 的有限正数校验是第二道防线，不是 schema 的替代品。

```ts
running => endedAt: null, durationMs: null
terminal => endedAt: number, durationMs: non-negative number
```

`subtaskRun` 本身为 optional，不建议再返回显式 `null`。

### 原因

- 编译期和运行时 schema 都能防止非法组合；
- 前端 `durationMs != null` 即可安全判断终态展示；
- 避免 `status = running` 却带“最终持续时间”；
- optional 足以表达“不适用/不可关联”，不需要同时支持 omitted 与 null 两套缺失语义。

### 取舍

schema 稍长，但减少后续实现歧义。若 TypeBox/现有类型推导导致不可接受的复杂度，可退化为单对象 schema，但必须补 refine-equivalent 单元测试并保持完全相同的不变量；该退化需在代码审查中明确说明。

## 列表与单项必须统一投影

### 决策

抽取同一 read-side projector/enricher，供：

- `getContextItems()`；
- `getContextItem()`；

共同使用。

### 原因

Web 在运行期间会逐个读取非终态 item，并整体替换本地记录。仅列表返回摘要会被单项结果覆盖。

### 取舍

需要扩展 `ContextQueryStore` 并调整 `ContextQueryApplication`，而不是只在 route handler 上临时拼接。这样职责更清晰、测试更稳定。

共享 `AgentContextItemRecordSchema` 还被 `AgentSessionContextItemsTailResponseSchema` 复用，因此 internal `context-items-tail` 必须与 public list/single 一起验证；不得只审查浏览器路径。

## 重复 parent key 固定采用 fail-open

### 决策

同一 parent key 命中多条 child runs 时：

- 该 key 的 `subtaskRun` 省略；
- 其他 items 正常投影；
- public list/single 与 internal tail 继续成功；
- 每请求每冲突 key 记录一次 `logger.error`；
- 固定诊断码为 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；
- 不允许任选、按时间排序取一条、抛出整个接口错误或静默省略。

### 原因

- 单张时间增强异常不应使整段会话历史不可用；
- internal tail 可能被插件消费，fail-close 会扩大故障面；
- 唯一索引正常时冲突不应发生，因此 error 诊断足以把它提升为数据完整性事件；
- 固定门禁保证 fail-open 不会演变成长期容忍损坏数据。

### 发布门禁

自动测试、预发布或灰度出现该诊断必须阻断发布或继续放量。生产已部署实例保持 fail-open 服务，但必须按数据完整性事件调查。冲突处理未满足“省略 + 单次 error + 固定诊断码”任一项，均不得验收。

## 后端列表批量查询，禁止 N+1

### 决策

一页 context items 先提取唯一 parent keys，再通过一个或受限分块的 SQL 查询读取所有关联 child runs。

### 原因

- Web 当前初始 tail 明确传入 100，向上分页 limit 也为 100；
- public `tailLimit/limit` 最大 500，internal tail 最大 500；
- Store 的 1000 clamp 只是内部 guard；
- `afterId` 与无参数 full transcript 的实际返回数量可以超过 500/1000；
- 逐 item 调 `findSubtaskRunByParentTool` 会产生 N+1；
- 前端逐卡片请求会进一步放大网络、loading 和一致性问题；
- API 已掌握整个页面 item 集合，最适合批量投影。

### 查询策略

推荐使用 SQLite JSON1：把 parent key 数组作为一个 JSON 参数，通过 `json_each` 展开，再 join `agent_run`。当前项目已基于 SQLite；实施前必须验证运行环境 JSON1 可用。

允许的备选：受限分块的参数化 OR/VALUES 查询。必须满足：

- 查询次数为 `ceil(uniqueParentKeys / batchSize)`，batch size 是显式常量；
- 不按卡片一条 SQL；
- 不拼接未转义值；
- 覆盖 SQLite 参数上限；
- 覆盖 public 500 上限与超过 1000 keys 的 full/after 场景。

如果 JSON1 不可用且无法设计安全的受限批量查询，必须暂停并更新技术设计，不得回退 N+1。

## 不新增数据库字段

### 决策

不新增 `ended_at`、`duration_ms`，不把摘要写入 context item。

### 原因

- 现有 run 时间足以满足产品近似口径；
- 新字段会引入双写、一致性、迁移和历史回填问题；
- 摘要可以请求时确定性生成；
- 当前终态写入路径有终态保护。

### 暂停条件

实施前如果发现：

- 终态 run 会被正常业务持续更新；
- `updatedAt` 被后台维护任务复用为“最后触碰时间”；
- 需要审计级精确结束时间；

则本决策失效，必须评审独立不可变 `endedAt`。

## 状态图标 child 优先，视觉错误边框保持 parent 语义

### 决策

- 图标状态：`subtaskRun.status ?? item.status`；
- parent `toolError` 和现有 `tone` 保持父工具消息语义；
- 本期不因 child failed 自动把整个卡片设为父工具错误 tone。

### 原因

child run 状态最能表达子任务执行结果，但 parent tool error 可能表达结果读取/写回等不同故障。把两者完全合并会丢失诊断信息。

### 取舍

可能出现 child completed 图标与 parent error 文本同时存在。这不是矛盾：表示 child 执行完成，但父工具协议链路发生错误。产品文档和测试必须允许该组合。

## 开始时间使用浏览器本地绝对时间

### 决策

- epoch milliseconds 由 API 返回；
- Web 用浏览器本地时区判断今天：今天格式化为 `HH:mm`，非今天格式化为 `MM-DD HH:mm`；
- 不由 API 返回格式化字符串；
- 无效时区/开始时间安全返回空字符串；无效 `now` 时按非今天格式展示；
- 不使用相对时间。

### 原因

- 时区属于用户展示层；
- epoch 易测试、易排序、无 locale 耦合；
- 绝对时间适合历史审查；
- 避免服务端 locale 与浏览器 locale 不一致。

### 取舍

不同用户在不同时区看到不同本地时间，但代表同一 epoch；这是预期行为。

## 旧数据保守缺省，不猜测、不回填

### 决策

找不到精确 child run 时省略摘要，不显示占位时间。

### 原因

- 猜错时间比不显示更具误导性；
- 按 session、文本、`prevId` 或 fork source 推断都会破坏 lineage 语义；
- 数据回填需要单独的数据治理方案和审计证据。

### 取舍

一部分旧卡片不会获得新时间信息。这是有意的兼容边界，不是实现缺陷。

## 本期不显示 running 动态持续时间

### 决策

running 只显示开始时间。

### 原因

- 用户明确要求终态展示持续时间；
- 动态计时需要 timer 生命周期、可见性、性能和多卡片刷新设计；
- 当前已有 session header timer，但直接扩展到所有卡片会扩大范围；
- 不影响本期核心价值。

### 后续约束

未来如果增加 running 时长：

```ts
elapsedMs = Math.max(0, Date.now() - startedAt)
```

不得使用 run `updatedAt`。

## 投影是快照，接受最终一致刷新

### 决策

context item 与 child run 分两步读取时，允许同一次请求观察到某一时刻的 running 或 terminal 快照，不引入跨表读事务。

### 原因

- 产品允许亚秒级轮询后更新；
- 投影只读，不影响状态机；
- 强行扩大事务边界会增加锁和复杂度。

### 不变量

即使 child 在读取期间转终态，单个摘要内部仍必须一致：

- 读取到 running → null/null；
- 读取到 terminal → number/number。

## 不采用方案

### 直接使用 parent item 时间

不采用。消息生命周期与 child run 生命周期不是同一实体。

### 使用 child session `lastRun`

不采用。`existing` 模式会让旧卡片串到后续 run。

### 前端按 `subtaskSessionId` 逐卡片请求

不采用。存在 N+1、loading、错误隔离和串 run 风险。

### 把时间写入 `tool.output.result`

不采用。会形成重复事实源；running 到 terminal 还需额外改写父消息，扩大写路径。

### 新增独立 `/subtask-card-runs` 接口

本期不采用。现有 context-items 已是卡片 read model，扩展可选摘要更小且能随分页返回。

### 数据库新增 `ended_at/duration_ms`

本期不采用。现有数据语义足够，迁移和双写收益不匹配。

### 对旧历史按文本或 session 回填

不采用。无法证明准确性，尤其 existing 和 copied context。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 行号/代码结构漂移 | 实施误改 | 基线复核阶段复核代码地图 |
| 批量查询退化 N+1 | 历史页面性能下降 | store API 与查询次数测试 |
| 重复 parent key 被任选或静默覆盖 | 错误时间且数据损坏被掩盖 | fail-open 固定诊断合同 + 发布门禁 |
| 单项接口未投影 | 运行中卡片字段闪失 | 统一 projector + 集成测试 |
| `existing` 按 session 猜测 | 旧卡片时间串台 | parent key 精确关联测试 |
| copied item `runId=null` 被错误追溯 | 执行归属混乱 | 明确省略 + fork 测试 |
| terminal `updatedAt` 将来可变 | 历史持续时间漂移 | 实施前写路径复核；命中则暂停 |
| 时间格式受测试机器时区影响 | 测试不稳定 | 纯函数/seam/显式时区测试 |
| child status 与 parent error 并存 | UI 被误判矛盾 | 冻结优先级与错误展示合同 |
| 非法时间值进入 Web | NaN/错误显示 | API 保守省略 + Web 防御校验 |
| TypeBox 联合类型使用困难 | 实现绕开不变量 | 允许受审查的等价退化，但必须补测试 |

## 发布暂停条件

出现以下任一情况必须暂停对应批次：

- 无法证明终态 run 的 `updatedAt` 在正常路径中冻结；
- parent tool 唯一索引不存在或可产生多 child runs；
- 实现无法对冲突 key 执行“省略摘要 + 每请求每 key 一次 error 诊断”；
- 测试、预发布或灰度出现 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；
- 批量查询只能通过逐条 SQL/逐卡片 HTTP 实现；
- 列表和单项接口无法共享相同投影；
- shared schema 无法表达或测试 running/terminal 不变量；
- Web 必须按 child session `lastRun` 才能实现；
- 发现公开 context item 字段扩展会破坏已有响应验证且没有兼容方案；
- internal tail schema/route/消费者影响无法验证；
- existing 多次复用或 fork copied item 的测试无法构造和验证；
- 实施者需要修改 run lifecycle、subtask start 或数据库 schema 才能继续。

暂停后必须更新本目录中的决策、技术设计、代码地图和验收标准，并重新独立评审。
