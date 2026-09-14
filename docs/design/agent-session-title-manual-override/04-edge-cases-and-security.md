# 边界情况与安全边界

## 标题输入矩阵

错误处理固定分为“路由结构校验”和“应用层业务校验”两阶段。结构非法请求不会进入应用层，也不会查询 Session。

| 场景 | 阶段 | 唯一预期 |
|---|---|---|
| 普通标题 `修复登录问题` | 应用层 | `200`，原样保存并接管 |
| 首尾空白 `  修复登录问题  ` | 应用层 | 保存为 `修复登录问题` 并接管 |
| 连续空格 `修复   登录问题` | 应用层 | 保存为 `修复 登录问题` 并接管 |
| 换行和 Tab `修复\n\t登录问题` | 应用层 | 保存为 `修复 登录问题` 并接管 |
| 原始空字符串 | Schema | `400`，不查询 Session |
| 纯空白字符串 | 应用层 | `400 AGENT_SESSION_TITLE_EMPTY` |
| 规范化后 50 长度 | 应用层 | `200` |
| 规范化后 51 长度 | 应用层 | `400 AGENT_SESSION_TITLE_TOO_LONG`，不得截断或部分保存 |
| 原始长度不超过 1000、含大量可压缩空白、规范化后不超 50 | 应用层 | `200` |
| 原始长度 1001 | Schema | `400`，不查询 Session |
| 非字符串 `null`、数字、对象、数组 | Schema | `400`，不查询 Session |
| 缺少 `title` | Schema | `400`，不查询 Session |
| 缺少 `workspaceId` | Schema | `400`，不查询 Session |
| 未知字段 `mode`、`manual` 等 | 路由白名单 | `400 AGENT_REQUEST_UNKNOWN_FIELD`，不查询 Session |
| 规范化后仍含 C0/C1 控制字符 | 应用层 | `400 AGENT_SESSION_TITLE_INVALID_CHARACTERS` |

结构合法后，应用层顺序固定为：

- 查询 Session，不存在返回 `404 session not found`；
- 校验 Workspace，不匹配返回 `400 workspaceId mismatch`；
- 再执行标题规范化后的 EMPTY、TOO_LONG、INVALID_CHARACTERS 校验。

因此，一个结构合法但业务标题非法的请求，在 Session 不存在时返回 404；一个原始空字符串等结构非法请求则始终在 Schema 阶段返回 400，不进入上述顺序。

### 控制字符规则

为避免 Tab 渲染异常和不可见标题，手动标题在空白压缩后必须拒绝仍存在的 C0/C1 控制字符：

```text
U+0000–U+001F、U+007F–U+009F
```

其中 `\n`、`\r`、`\t` 等会先被空白压缩消除，不会触发最终拒绝。错误 code 固定为 `AGENT_SESSION_TITLE_INVALID_CHARACTERS`。

不对普通标点、路径字符、引号、斜杠、HTML 字符或 Emoji 做额外限制。Vue 默认文本插值会转义 HTML，标题不得通过 `v-html` 渲染。

## 长度和 Unicode 边界

- 计长方式固定为 JavaScript `string.length`；
- 数据库不承担 50 长度校验；应用层是权威；
- 前端使用相同算法提供即时反馈，但不得取代后端；
- 代理对、组合 Emoji 可能占多个长度单位，这是已知行为；
- 自动标题现有 `slice(0, 49)` 可能切开 surrogate pair，本期不得借需求扩展为 Unicode 截断修复；
- 手动标题只做长度拒绝，不切片，因此不会由本功能主动制造半个 surrogate；
- 浏览器/JSON 中本就存在的孤立 surrogate 不作为本期专门治理对象。

## 既有标题不符合新规则

当前创建和 Fork 标题没有统一的手动输入 50 字符限制，因此升级后可能存在超过 50、超过原始请求上限 1000、规范化后为空或含禁止控制字符的既有标题。

固定行为：

- 数据库迁移只增加 `title_manually_set = 0`，不得清洗、截断、替换或重写任何历史标题；
- 弹窗完整回填数据库返回的标题，不得在回填前规范化；
- 输入组件不设置 DOM `maxlength`，包括不得设置 50 或 1000，以避免程序化回填被截断；
- 回填值规范化后超过 50，显示 `AGENT_SESSION_TITLE_TOO_LONG` 对应字段错误并禁止提交；
- 回填值规范化后为空，显示 `AGENT_SESSION_TITLE_EMPTY` 对应字段错误并禁止提交；
- 回填值规范化后含禁止控制字符，显示 `AGENT_SESSION_TITLE_INVALID_CHARACTERS` 对应字段错误并禁止提交；
- 原始值超过 1000 时显示请求原始上限错误并禁止提交；该错误属于前端对 Schema 上限的预检，不调用 API；
- 用户编辑到原始不超过 1000、规范化后 1-50 且不含禁止控制字符后，保存才可调用 API 并完成接管；
- API 不因为标题来自历史数据而放宽任何 Schema 或业务校验；
- 用户取消或关闭弹窗时，不修改标题、不设置 manual 标记。

“保存相同标题也接管”仅适用于当前标题满足上述新手动规则。既有不合法标题不能通过原样保存绕过校验。

## Session 存在性和 Workspace 归属

### Session 不存在

- API 返回 `404`；
- 不创建 Session；
- 不泄露数据库细节；
- 前端保留弹窗并显示错误，用户可取消后刷新列表。

### Workspace 不匹配

- Session 存在但 `body.workspaceId` 与记录不一致时返回 `400 workspaceId mismatch`；
- 不修改标题或标记；
- Store mutation SQL 仍必须包含 `workspace_id` 条件，形成纵深保护；
- 不允许仅按 `sessionId` 更新。

本项目是个人自托管工具，但 Workspace 边界仍是不可降低的安全底线。

### Workspace 不存在

更新标题以 Session 记录为入口：

- 若 Session 不存在，返回 `404 session not found`；
- 若存在，则其外键 Workspace 应存在；
- 不需要额外先查 Workspace 再查 Session，以免引入不必要分支；
- 若实现沿用 `assertWorkspace`，错误优先级必须由测试固定，避免与其他 Session 操作不一致。

推荐固定顺序：先查 Session，再校验其 Workspace 归属。

## Manual 锁边界

### 首次手动修改

必须同时完成：

- 保存规范化标题；
- `title_manually_set = 1`。

不能出现标题已保存但标记未写入，或标记已写入但标题未保存。

### 再次手动修改

- 允许；
- 只要标题合法就更新；
- 标记保持 `1`；
- 不更新 `updated_at`；
- 与当前标题规范化后相同的请求必须由前端发送，服务端幂等成功并确保标记为 `1`。

### 不恢复自动

以下行为均不得把标记改回 `0`：

- 再次手动修改；
- clear/revert/compact/cancel；
- 普通消息发送；
- Agent 运行结束；
- 刷新页面；
- 关闭并重新打开 Tab；
- 服务重启；
- Context head 变化；
- 标题变回“新会话”文本。

只有创建新 Session，包括 Fork，才自然得到新的 `0`。

### 首消息边界

场景：用户通过 API 在空 Session 上先手动改标题，再发送首条消息。

预期：

- 首消息正常写入；
- Run 正常启动；
- lifecycle 仍满足 `head == null` 并尝试自动更新；
- 自动 SQL 因 `title_manually_set = 1` 影响零行；
- 手动标题不变。

不得通过“UI 不允许在 draft 上编辑”忽略服务端这一边界，因为真实空 Session 仍可能由 API 创建。

## `todolist` 两条写回路径

### Append completed 路径

满足 completed todolist 条件且 `goal` 非空时：

- 自动可命名 Session：按现有规则更新标题和 `updated_at`；
- 手动接管 Session：Context item append 成功，标题和 `updated_at` 不因标题更新变化；
- 自动标题更新零行不得改变响应为失败；
- 不得回滚已写入的 Context item。

### Update to completed 路径

已有工具 item 从 queued/running 等状态更新为 completed 时：

- 自动可命名 Session：按现有规则更新标题和 `updated_at`；
- 手动接管 Session：工具 item update 成功，标题不变；
- `update.kind === "unchanged"` 时维持当前提前返回，不重复标题更新；
- artifact 预处理、ownership fence、run fence 错误语义保持不变。

两条路径必须分别测试。只覆盖 append 不足以验收。

### 非目标 `todolist` 结果

以下情况不更新标题，无论是否 manual：

- item 非 completed；
- `kind` 非 tool；
- `output.type` 非 tool；
- `toolName` 非 `todolist`；
- `result` 缺失或非对象；
- `goal` 缺失、非字符串或规范化后为空；
- update 返回 unchanged。

## Fork 边界

| 源 Session | 新 Session 初始标记 | 预期 |
|---|---:|---|
| 自动可命名 | `0` | 可自动命名 |
| 手动接管 | `0` | 仍可自动命名，不继承锁 |

Fork 会复制 Context，但不会复制标题接管状态。原因是新 Session 是新的工作分支，标题生命周期重新开始。

若 Fork 创建时显式提供标题，该标题仍只是新 Session 的初始标题，不视为“通过设置按钮手动接管”；新 Session 标记仍为 `0`。这是与手动标题 API 的重要区别。

## Primary、Subtask 与 Draft

### Primary

- 已持久化后可设置；
- 空 Session、运行中、idle 均可设置；
- 后续首消息和 todolist 受锁约束。

### Subtask

- 已持久化且在 UI 中打开后可设置；
- 后端不因 `kind === "subtask"` 拒绝；
- 不改变其普通消息只读限制；
- 后续 todolist 自动标题必须受锁约束。

### Draft

- 无真实 ID，不显示按钮；
- 不调用更新 API；
- draft 转真实 Session 后才显示按钮；
- 不允许把 draft ID 发送到 API；若恶意发送，按 Session 不存在返回 `404`。

## 运行中与并发边界

### 自动先提交

```text
自动 SQL 成功
-> 手动 SQL 后提交
-> 最终标题为手动标题，标记为 1
```

### 手动先提交

```text
手动 SQL 成功并标记 1
-> 自动 SQL 后提交
-> WHERE 条件不满足
-> 手动标题保持
```

### 两次手动请求

- 不引入版本冲突；
- 数据库实际后提交者获胜；
- 每次响应返回各自提交完成时查询到的 record；
- 单页面弹窗阻止重复点击，但不同页面的竞争按最后写入获胜；
- 不使用 `updatedAt` 作为并发版本，因为手动更新明确不修改它。

### Session 在请求期间消失

当前产品没有常规删除 Session API。如果未来出现并发删除：

- 应用层初查存在但 Store update 为 false 时返回 `404`；
- 不把 false 错判为标题校验失败；
- 前端不得在本地复活远端已删除 Session。

## `updatedAt` 与排序边界

### 手动修改

手动标题 Store SQL 必须断言：

- 数据库 `updated_at` 精确保持旧值；
- `serverSessions` 原位替换，不按响应重新排序；
- Tab 编号和 active Session 不变；
- 不以手动标题 mutation 主动改变 recent session 排序。

API 级验收按运行状态区分：

- idle 且请求期间没有其他业务写入：API 返回的 `updatedAt` 与修改前相同；
- 运行中：只能断言手动标题 SQL 本身不写 `updated_at`，不得断言请求完成时的最终值绝对不变，因为 Context/Run 等并发路径可以推进该字段；
- 若运行中最终排序变化，必须能证明来源是其他既有业务活动，而非手动标题 SQL 或前端主动排序。

当前列表 SQL按 `updated_at desc` 排序：

- `apps/api/src/modules/agent/agent.store.ts:765-787`

recent session 同样按该字段排序：

- `apps/api/src/modules/agent/agent.store.ts:885-912`

### 自动修改

现有自动路径仍更新 `updated_at`。不得在本需求中悄然移除该行为。若 manual 导致自动更新跳过，则自然也不会产生该次自动标题的 `updated_at` 更新。

注意：Context item 自身写入可能通过其他代码触碰 Session 活跃时间；验收“手动锁下 todolist 不更新标题时间”时，应区分 Context 写回自身的时间语义与标题更新函数的副作用，不得凭最终时间未变作不正确假设。测试应隔离或直接验证标题更新 SQL。

## UI 事件与交互边界

### 事件冒泡

设置按钮必须同时处理：

```vue
@mousedown.stop.prevent
@click.stop.prevent
```

验收：

- 点击设置图标不切换 active Tab；
- 不关闭当前或其他 Tab；
- 不触发新增 Session；
- 键盘/辅助技术触发按钮时仍能打开弹窗。

必须使用 `a-button type="text"` 等可聚焦真实按钮包裹图标，并显式设置本地化 `aria-label`。Tooltip 只能作为补充说明，不能替代可访问名称；按钮必须支持 Enter/Space 激活。

### 弹窗回填

- 每次打开都从当前 Session record 完整回填，不规范化、不截断；
- 取消后再次打开不得保留上一次未保存输入；
- 不合法既有标题必须立即展示对应错误并禁用保存，不能在用户不知情时自动修正；
- 如果弹窗打开期间列表刷新了该 Session 标题，不能无提示覆盖用户已编辑文本；保存时以后端最后写入为准；
- Workspace 切换必须关闭弹窗或清空目标，旧请求响应不得写入新 Workspace。

### 保存相同标题

当前标题符合新手动输入规则，且规范化后的输入等于当前标题时：

- 仍发送 API；
- 设置 manual 标记；
- 后续自动标题不得覆盖；
- API 返回后正常关闭弹窗；
- 不改变排序。

只有取消或关闭弹窗不发送 API、不设置 manual 标记。

## 陈旧响应边界

必须覆盖以下时间线：

```text
R1: listAgentSessions 开始
M1: update title 成功，本地写入新标题
R1: 返回旧标题
```

合并要求：

- 如果该 Session 的成功 mutation revision 大于 R1 开始时 revision，且 R1 仍包含该 Session，则保留 M1 API 成功响应的完整本地 record；
- 不采用 R1 中该 Session 的任何字段，尤其不得回退 `title`、`headItemId`、`updatedAt`；
- R1 不含该 Session 时，不保留/复活；
- M1 失败时不能保护未成功值；
- R1 完成后必须去重调度一次 R2；
- M1 后新发起的 R2 可完整采用服务端权威 record，替换临时保留的本地 record；
- R2 失败时继续保留 M1 record，不回退到 R1；清理 R2 自己的 loading 后允许后续刷新重试；
- 若列表请求本来就在 M1 后开始，则可直接完整采用服务端结果，无需保护或额外 R2；
- 多个 Session 的保护彼此独立；
- 切换 Workspace 时 title revision 状态清空。

禁止将 M1 的 `title` 与 R1 的其他字段拼成混合 record，因为 R1 的 `headItemId/updatedAt` 等字段也可能早于 M1 API 响应。

当前 `loadingSessions` 只避免多个列表请求并发，不能消除该时间线。

### Workspace 切换与加载闭环

必须引入 `workspaceGeneration` 或等价请求代次，确保旧 Workspace 请求既不能写入新状态，也不能阻塞新 Workspace 加载。

```text
G1/W1: R1 开始
切换 W2 -> generation 递增为 G2，并立即启动 R2
R1 返回或失败 -> 丢弃，不写 W2，不清理 R2 loading，不恢复 G1 retry
R2 成功 -> 写入 W2 并清理 G2 loading
R2 失败 -> 清理 G2 loading，显示错误；后续激活/刷新能发起 R3
```

固定要求：

- 同 generation 的重复刷新可以被 active token 合并或跳过；
- 旧 generation 的请求不得因全局 `loadingSessions` 阻止新 generation 发起；
- 每个请求在 `finally` 中只能清理自己的 token；
- 旧 generation 的 `session-title-sync-needed` retry baseline 必须丢弃；
- 新 generation 的首次请求失败后不得残留永久 loading，必须可重试；
- 组件卸载后所有响应均不得写入状态。

### 组件卸载闭环

`onBeforeUnmount` 必须：

- 设置 `disposed = true` 并递增 `workspaceGeneration`；
- 关闭标题弹窗并清空编辑 Session ID、输入和字段错误；
- 清空 mutation revision/完整 record 缓存和 retry baseline；
- 使所有已发出的 refresh 和 title mutation 响应在写状态前失效；
- 保证旧 Promise 的 `finally` 只清理自己的 token，不得清理其他 token。

服务端已经成功的标题 mutation 不回滚；这里只禁止响应继续修改已卸载组件的本地状态。

## 安全边界

- API 必须复用公开 Agent 路由与共享 TypeBox Schema；
- 不调用 Worker 内部写回接口；
- 不接受客户端直接设置 `title_manually_set`；
- 不接受 `mode`、`auto`、`manual`、`updatedAt` 等额外控制字段；
- 不在错误或日志中泄露其他 Workspace 的标题；
- 不执行文件、Git、终端或凭证操作；
- 标题只以文本插值渲染，禁止 `v-html`；
- SQL 必须参数化，禁止拼接标题；
- 失败请求不得产生部分写入；
- 自动标题跳过属于预期控制流，不输出高频 warning。

## 可用性与失败恢复

- 网络失败：弹窗保持，允许重试；
- `AGENT_SESSION_TITLE_EMPTY`：展示空标题专用字段错误；
- `AGENT_SESSION_TITLE_TOO_LONG`：展示规范化后超过 50 的专用字段错误；
- `AGENT_SESSION_TITLE_INVALID_CHARACTERS`：展示非法控制字符专用字段错误；
- 其他 Schema `400` 或 Workspace mismatch：显示通用 API 错误，不得错误映射为上述字段错误；
- `404`：提示 Session 不存在，允许关闭后刷新；
- 重复点击：保存按钮 loading/disabled；
- API 成功但前端后续状态更新异常：下一次列表刷新仍可恢复服务端标题；
- 服务重启：数据库标记持久存在，自动路径继续跳过；
- 迁移失败：服务启动应明确失败，不允许在缺列状态下继续运行并失去锁语义。
