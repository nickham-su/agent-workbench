# 背景、现状与业务逻辑

## 需求背景

Agent Session 标题用于用户在多个 Session Tab 之间识别任务。当前系统通过自动规则生成标题，适合降低首次使用成本，但用户缺少纠正、稳定命名和长期整理 Session 的能力。

典型问题包括：

- 首条输入可能是背景说明或临时指令，不适合作为长期标题；
- `todolist.goal` 会在运行中更新标题，可能覆盖用户认为更准确的名称；
- 同一任务经过多轮执行后，自动目标名称可能变化，Tab 标题随之跳变；
- 用户无法显式表达“这个标题由我维护，Agent 不要再改”。

本需求增加手动设置入口，并把“手动保存”定义为一次不可逆的标题接管动作。

## 当前实现基线

### Session 创建时的初始标题

- Web 端创建的是本地 draft，初始标题使用 `agent.client.newTitle`：
  - `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:616-629`
- 首次需要真实 Session 时，Web 调用创建接口并传递 draft 标题：
  - `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:645-661`
- 公共创建路由为 `POST /api/agent/sessions`：
  - `apps/api/src/modules/agent/routes/agent-public.routes.ts:336-350`
- 应用层对空标题回退为“新会话”：
  - `apps/api/src/modules/agent/session/session-interaction-application.ts:11-13,190-205`
- 当前创建请求契约允许 `workspaceId` 和可选 `title`：
  - `packages/shared/src/contracts/agent.ts:499-503`

创建时的初始标题不是本需求所说的“首条用户输入自动命名”。真正的首条输入命名发生在消息进入生命周期事务时。

### 首条用户消息自动命名

- 标题格式规则位于：
  - `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:47-52`
- 写入用户 Context item 后，若原 Session head 为 `null`，更新标题：
  - `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:89-125`

现有规则：

- 将连续空白压缩为单个空格并 `trim`；
- 规范化后为空时使用“新会话”；
- 长度不超过 50 时原样使用；
- 超过 50 时取前 49 个 JavaScript UTF-16 code unit 并追加 `…`。

这里的触发条件准确表述为：

> 在用户 Run 激活事务中，如果追加首条用户消息前 `head == null`，尝试自动设置标题。

它不是“每次创建 Session 时”执行，也不是“每次用户发消息”执行。

### `todolist.goal` 自动命名

API 侧会对 `todolist` 结果中的 `goal` 做规范化：

- `apps/api/src/modules/agent/agent.composition.ts:755-760`

成功完成的 `todolist` 有两条写回路径，两者都会尝试更新标题：

- 新建/append 一个已完成的工具 Context item：
  - `apps/api/src/modules/agent/writeback/context-writeback-application.ts:89-96`
- 将已有工具 Context item 更新为 completed：
  - `apps/api/src/modules/agent/writeback/context-writeback-application.ts:112-139`

共同触发条件是：

- Context item `kind === "tool"`；
- Context item `status === "completed"`；
- `output.type === "tool"`；
- `output.toolName === "todolist"`；
- `result.goal` 是规范化后非空的字符串。

`goal` 为空白时不更新；超长时沿用首消息的 50 字符截断规则。

现有测试证据：

- 正常 goal 更新标题：`apps/api/src/modules/agent/integration/agent-prompt-context.integration.test.ts:1179-1182`
- 超长 goal 截断：同文件 `:1184-1255`
- 空白 goal 不更新：同文件 `:1257` 起
- update-to-completed 路径调用标题更新：`apps/api/src/modules/agent/writeback/context-writeback-application.test.ts:333-350`

### 当前覆盖与存储语义

当前标题更新函数没有来源判断：

- `apps/api/src/modules/agent/agent.store.ts:642-650`

它会同时修改：

- `title`；
- `updated_at`。

当前数据库表只有 `title`，没有手动接管标记：

- `apps/api/src/infra/db/schema.ts:94-104`

因此当前实际规则是：

| 来源 | 触发次数 | 是否覆盖当前标题 |
|---|---:|---:|
| 创建请求标题 | 创建时一次 | 写入初始值 |
| 首条用户消息 | `head == null` 时一次 | 是 |
| `todolist.goal` append | 每个符合条件的 completed item | 是 |
| `todolist.goal` update | 每个符合条件的 update-to-completed item | 是 |

即“后写覆盖前写”。

### 前端标题展示与刷新

- Tab 标题模板位于 `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:19-40`。
- `AgentClientPane` 也接收同一个 `session.title`：同文件 `:43-49`。
- 发送消息后，Pane 发出 `session-title-sync-needed`：
  - `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:3630-3646`
- Tool View 等待当前 Run 回到 idle 后刷新 Session 列表：
  - `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:607-613,1036-1055`
- Session 列表刷新后按 `updatedAt` 排序：
  - `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:561-592`

当前没有专用于标题变化的 WebSocket/SSE 推送。手动设置应通过 API 成功响应立即更新当前页面，同时防止早先发起的列表请求把旧标题覆盖回来。

## 目标

- 允许用户在已持久化 Session Tab 上打开标题设置弹窗；
- 弹窗必须回填当前标题；
- 用户成功保存后，标题立即更新；
- 首次手动保存永久关闭该 Session 的自动命名；
- 手动接管后仍允许再次手动修改；
- 自动命名跳过不能影响消息生命周期或 `todolist` 写回成功；
- 标题修改不改变 Session 的活跃时间和排序；
- 保持历史 Session、Fork、primary/subtask 和现有自动命名行为兼容。

## 非目标

本需求不包括：

- 恢复自动命名的开关或 API；
- 根据历史 Context 重新生成标题；
- AI 摘要式标题生成；
- 标题修改历史、撤销、审计日志；
- 多浏览器页面间的实时标题广播；
- draft Session 的持久化标题编辑；
- 对创建接口标题规则的全面重构；
- Unicode grapheme cluster、Emoji 可见字符计数或数据库字符排序重构；
- 删除、归档、拖拽排序、固定 Session 等 Tab 管理功能。

## 术语

| 术语 | 定义 |
|---|---|
| 自动可命名 | `title_manually_set = 0`，首消息和 `todolist.goal` 可按既有规则更新标题 |
| 手动接管 | 用户成功调用手动标题 API 后，`title_manually_set = 1` |
| 永久 | 当前产品合同中无任何恢复为自动可命名的入口；数据库修复不属于业务入口 |
| draft Session | 仅存在于 Web 本地、尚未调用创建 API 的 Session |
| 已持久化 Session | 已存在于 `agent_session` 表、有真实 Session ID 的 primary 或 subtask Session |
| 自动标题事件 | 首条用户消息命名或符合条件的 `todolist.goal` 命名 |

## 业务状态与不变量

```text
创建 / Fork Session
  -> title_manually_set = 0
  -> 自动标题事件可更新 title

用户成功手动保存
  -> 原子写入 title
  -> title_manually_set = 1
  -> 之后自动标题事件永久跳过

用户再次手动保存
  -> 更新 title
  -> title_manually_set 保持 1
```

必须始终成立的不变量：

- 用户提交符合新手动输入规则的标题且请求成功即视为接管，即使规范化后的标题与当前标题相同；
- `title_manually_set = 1` 时，任何自动路径都不能改变标题；
- 手动保存的标题与接管标记必须在同一 SQL 语句中原子更新；
- 自动路径的“是否可写”判断必须在更新 SQL 内完成，不能仅依赖先查后写；
- 自动标题被跳过不构成错误；
- 手动标题 Store SQL 不写 `updated_at`；运行中其他业务路径仍可独立推进该字段；
- 新建和 Fork 出的 Session 均从 `title_manually_set = 0` 开始。
