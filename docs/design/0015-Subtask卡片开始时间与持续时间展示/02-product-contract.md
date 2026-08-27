# 产品合同与用户可观察行为

## 产品承诺

本期向用户承诺：

- 对能精确关联 child run 的 subtask 卡片展示开始时间；
- child run 完成、失败或取消后展示从激活到终态落库的持续时间；
- 状态图标与时间优先来自同一个 child run；
- 缺少可靠关联时保持当前卡片信息，不展示猜测时间；
- 同一历史卡片在刷新、分页和再次打开后显示同一个关联 run 的稳定时间。

本期不承诺：

- Provider 请求发出的精确时刻；
- Provider、工具或外部执行器实际停止的精确时刻；
- 排队、模型、工具、网络等阶段耗时拆分；
- running 卡片的实时秒表；
- 无 child run 记录的旧历史自动补齐；
- parent tool item 与 child run 跨表读取的强事务快照。

## 产品文案

### 中文

新增文案固定为：

- `开始时间`
- `持续时间`

### 英文

新增文案固定为：

- `Started`
- `Duration`

不得使用：

- “模型开始时间”；
- “推理开始时间”；
- “模型耗时”；
- “推理耗时”；
- “精确结束时间”。

这些文案会错误扩大当前数据语义。

## 卡片布局

建议在现有 Agent/模式行之后、Session ID 行之前增加时间行：

```text
子任务：<description>                         <status icon>
Agent：<agent>    模式：<mode>
开始时间：14:23（今天示例）    持续时间：1min 12s
Session ID：<session id>                      <copy>
Error: <tool error，仅存在时>
```

规则：

- running：时间行只显示开始时间；
- terminal：同一行显示开始时间和持续时间；
- 没有 `subtaskRun`：整行不渲染，不显示 `-`、`未知` 或 `0s`；
- 有合法 `subtaskRun`：开始时间不得省略；
- terminal 的合法摘要：持续时间不得省略；
- 小屏宽度不足时允许自然换行，不得截断关键数值；
- 保持现有卡片点击、复制 Session ID、错误文本和颜色语义。

## 时间格式

### 开始时间

- 输入：epoch milliseconds `startedAt`；
- 时区：浏览器本地时区；
- 如果在该时区中属于今天：`HH:mm`；
- 如果不属于今天：`MM-DD HH:mm`；
- 使用 24 小时制和补零；不显示年份、秒和毫秒；
- 不显示相对时间，例如“3 分钟前”；
- 不依赖接口返回格式化字符串。

选择绝对本地时间的原因：

- 会话历史需要再次打开时保持可理解；
- 相对时间随时间变化，难以验收和截图比对；
- 当前契约只有 epoch milliseconds，浏览器最适合处理用户本地时区。

“今天”的判定和格式化必须使用同一浏览器本地时区。无效时区或无效 `startedAt` 时安全返回空字符串；无效 `now` 无法判断今天时，安全按非今天格式展示。实现可使用本地辅助函数或 `Intl.DateTimeFormat`，但输出必须满足上述产品格式。测试不得依赖执行机器默认时区或当前日期，应通过注入 `now` 与显式时区 seam 实现稳定断言。

### 持续时间

持续时间沿用当前 `formatElapsedDuration(ms)` 的展示风格：

- `< 60s`：`12s`；
- `< 1h`：`3min 8s`；
- `>= 1h`：`2h 5min 9s`。

现有实现位于：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1434-1446`

规范补充：

- 计算使用毫秒，展示向下取整到秒；
- `durationMs = 0` 合法，显示 `0s`；
- API 已保证非负，前端仍应拒绝非有限或负值；
- 本期不做 i18n 单位改造，保持现有 header 计时风格；如果实施者决定同步国际化单位，必须作为独立变更并补回归，不得改变本需求范围。

## 状态与展示矩阵

| `subtaskRun` | 开始时间 | 持续时间 | 状态图标来源 | 说明 |
|---|---|---|---|---|
| 缺失 | 不展示 | 不展示 | parent item | 兼容/降级 |
| `running` | 展示 | 不展示 | child `running` | 不显示最新心跳差值 |
| `completed` | 展示 | 展示 | child `completed` | 正常结束 |
| `failed` | 展示 | 展示 | child `failed` | 失败前墙钟时长 |
| `cancelled` | 展示 | 展示 | child `cancelled` | 取消落库前墙钟时长 |

## 状态优先级合同

前端计算卡片可视状态时必须使用：

```ts
const effectiveSubtaskStatus = item.subtaskRun?.status ?? item.status;
```

约束：

- `subtaskRun` 存在时，不得因 parent item 尚为 `running` 而覆盖 child terminal 状态；
- `subtaskRun` 缺失时，必须保留现有 parent item 状态图标；
- parent `toolError` 的展示独立于 effective status；即使 child status 为 `completed`，父工具结果写回发生错误时仍显示错误文本；
- 卡片边框/`tone` 当前来自 parent item 失败状态，本期保持现状，避免把 child 执行失败与 parent 工具协议错误混为一种视觉错误；若产品要让 child failed 同时改变边框，需另行决策。

## 降级与兼容合同

### 旧历史数据

以下任一情况视为没有可靠摘要：

- 父 item `runId = null`；
- 找不到 `(workspaceId, parentRunId, parentToolItemId)` 对应 child run；
- 数据库历史来自旧版本，尚未建立 lineage 字段；
- 父 item 不是 `tool/subtask`；
- child run 记录字段无法通过产品摘要校验。

行为：

- API 省略 `subtaskRun`；
- Web 不显示时间行；
- Web 使用 parent item 状态；
- 卡片其他信息与点击能力保持现状；
- 不记录逐 item warn，避免旧数据导致日志洪泛；允许聚合 debug/metric，但不属于本期要求。

### child run 尚未建立

父工具 item 可能先以 queued/running 形式出现，child run 尚未激活。

行为：

- 首次读取可以没有 `subtaskRun`；
- 不显示开始时间；
- 使用 parent item 状态；
- 后续列表或单项刷新发现 child run 后，时间行出现；
- 不用 parent item `createdAt` 暂代开始时间。

### running

行为：

- 展示开始时间；
- 不展示持续时间；
- 不显示 `0s`、`进行中`持续时长或 `updatedAt - startedAt`；
- 本期不启动额外 timer。

### completed / failed / cancelled

行为：

- 都展示开始时间与持续时间；
- 失败和取消不是“无结果”，持续时间仍有业务价值；
- `endedAt` 只在契约中提供，本期卡片不展示；
- cancelled 的持续时间含取消请求到终态落库的收敛时间，不承诺底层执行器恰好在该时刻停止。

### `existing` 重复复用

行为：

- 每张父卡片按自己的 parent key 绑定一个 child run；
- 同一个 `subtaskSessionId` 可出现在多张卡片上，时间可以不同；
- child session 后续发生新 run，不得改变旧卡片的时间；
- 不调用 child session `run-state.lastRun` 补摘要。

### fork copied item

项目语义要求 copied context item 的 `runId` 保持 `null`。对于 copied subtask 卡片：

- 不追溯原始 source item；
- 不尝试用 `prevId`、输出文本或 Session ID 恢复 child run；
- 不展示时间；
- 继续显示已复制的卡片内容。

这一边界避免把“当前 session 中真实执行归属”与“复制来的历史上下文”混淆。

### 分页、增量和单项刷新

以下路径必须得到相同投影规则：

- 首次 tail load；
- `beforeId` 向上分页；
- `afterId` 增量读取；
- 无参数全 transcript；
- `GET context-items/:itemId` 单项读取。
- `POST /api/internal/agent/sessions/context-items-tail` internal tail 读取。

Web 单项刷新会整体替换本地 item：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2462-2470`
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:2591-2602`

因此单项接口缺失投影属于验收阻断问题。

## 异常数据合同

API 生成摘要时必须采取保守策略：

- `createdAt` 非有限数或 `<= 0`：省略摘要；
- terminal `updatedAt` 非有限数或 `<= 0`：省略摘要；
- terminal `updatedAt < createdAt`：仍返回摘要，`durationMs = 0`，用于兼容时钟异常；
- running：无论数据库 `updatedAt` 为何，`endedAt = null`、`durationMs = null`；
- 未知 run status：省略摘要，不扩大共享契约；
- `startedAt` 与 terminal `endedAt` 的 public schema 都必须拒绝 `0` 和负数；projector 仍必须在构造前校验有限正数。

### 重复 child run 命中的唯一合同

同一 `(workspaceId, parentRunId, parentToolItemId)` 命中多条 child runs 时固定采用 fail-open，不允许其他分支：

- 不选择最新、最早或任意一条；
- 省略该 parent key 对应 item 的 `subtaskRun`；
- 同一响应中的其他 items 正常投影；
- public list、public single item 与 internal tail 都保持成功响应；
- 同一请求内每个冲突 parent key 只记录一次 `error` 级结构化诊断；
- 固定 `diagnosticCode = "AGENT_SUBTASK_RUN_PARENT_CONFLICT"`；
- 日志至少包含 `workspaceId`、`parentRunId`、`parentToolItemId`、排序后的 `runIds` 与 `matchCount`，不得包含 prompt、args、result 或输出文本。

取舍原因：历史消息可用性高于单张异常卡片的时间增强；fail-close 会因为一个损坏 key 阻断整个会话历史甚至 internal plugin tail。与此同时，静默省略会掩盖 lineage 数据损坏，因此必须使用 error 诊断和发布门禁补足。

发布合同：

- 已部署运行时发现冲突时继续提供不含该摘要的历史响应；
- 自动测试、预发布或灰度发现该诊断时，必须阻断发布或继续放量；
- 冲突未定位并修复前，不得把“接口仍返回 200”解释为验收通过；
- 不得通过删除冲突检测或降低日志级别解除门禁。

## 可访问性与交互

- 时间信息为普通文本，不只通过颜色表达；
- 状态图标保留现有视觉与旋转行为；
- 新增文本不得抢占卡片点击事件；
- 不新增 tooltip 才能看到的唯一信息；
- 复制 Session ID 按钮行为保持不变；
- 中英文文案都必须存在，缺失翻译不得以 key 原文上线。

## 产品验收示例

### running

```text
子任务：调研接口语义                         [旋转]
Agent：Researcher    模式：新会话
开始时间：14:23
Session ID：session_xxx
```

### completed

```text
子任务：调研接口语义                         [完成]
Agent：Researcher    模式：新会话
开始时间：14:23    持续时间：1min 12s
Session ID：session_xxx
```

### failed

```text
子任务：调研接口语义                         [失败]
Agent：Researcher    模式：继承上下文
开始时间：03-12 14:23（非今天示例）    持续时间：8s
Session ID：session_xxx
Error: <父工具错误，若有>
```

### 无可靠关联

```text
子任务：旧历史任务                            [父 item 状态]
Agent：Researcher    模式：续用会话
Session ID：session_xxx
```

不得增加虚假的：

```text
开始时间：-
持续时间：0s
```
