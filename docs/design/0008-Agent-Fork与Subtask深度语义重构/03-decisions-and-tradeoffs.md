# 关键决策与方案取舍

## 决策总览

| 决策 | 结论 |
|---|---|
| primary ordinary Run 的 depth | 固定为 `0` |
| 公开 fork 是否继承 depth | 不继承；创建独立 primary 执行根 |
| copied item 是否保留 source `runId` | 不保留，继续为 `null` |
| 是否新增 session depth 快照 | 不新增 |
| `parentRunId/parentToolItemId` 用途 | 仅真实 subtask parent-child |
| prompt 工具过滤是否修改 | 不修改 |
| 公开 create/fork 是否可创建 subtask | 不允许 |
| 通用 internal create 是否可创建 subtask | 不允许 |
| existing subtask 模式 | 保留，只复用内部创建的 subtask session |
| 现有 `forkSession()` 处理 | 拆分职责，不直接加 primary-only 限制 |
| 数据库迁移 | 不需要 schema 变更或回填 |

## 决策：Primary 是独立执行根

### 选择

所有用户可写 primary session 的 ordinary Run 固定：

```text
subtaskDepth = 0
parentRunId = null
parentToolItemId = null
```

### 原因

- primary session 是用户直接操作的执行边界；
- 当前产品只允许用户在 primary session 上继续对话和公开 fork；
- subtask session 已经是只读；
- 最大嵌套深度的业务目的，是限制模型递归调用 subtask，而不是限制用户复制上下文；
- 该定义无需依赖 source item、source Run 或历史记录是否仍存在；
- 二次、多次 fork 的行为稳定且可推导。

### 代价

这会改变当前已有测试所固化的语义：普通 fork 不再继承 source Run depth。该变化属于明确的产品规格修正，不是实现细节兼容。

## 决策：不采用 Session 级 Depth 快照

### 备选方案

在 `agent_session` 增加类似：

```text
fork_base_subtask_depth
```

普通 fork 时保存 source depth，后续 Run 从 session 快照读取。

### 优点

- 可以保持“普通 fork 继承 source depth”的当前行为；
- 不依赖 copied item 的 `runId`；
- 二次 fork 可以继续传递已知 depth。

### 不采用原因

- 继续把用户上下文分支视作 subtask 执行链的延续，产品语义复杂；
- 新增 schema、store 映射、迁移和历史回填；
- 仍需定义 unknown、损坏 lineage 和深度快照的恢复规则；
- session 与 Run 都出现 depth 概念，容易再次混淆；
- 当前产品没有从 subtask session 派生用户可写分支的需求；
- primary 独立执行根更符合现有 UI 和只读约束。

### 何时需要重新考虑

只有未来明确新增以下产品能力时，才应重新设计，而不是恢复本方案之前的隐式继承：

- 用户把 subtask session 提升为可写 primary branch；
- 从任意 subtask item 创建用户可写分支且要求保留安全预算；
- depth 不再只表示工具调用链，而要表示更广义执行 provenance。

这类需求应设计显式的“promote/branch from subtask”领域操作及安全策略。

## 决策：不采用 Runtime 递归 Fallback

### 备选方案

当 fork source item 的 `runId = null` 时，沿 `forkedFromSessionId/forkedFromItemId` 递归向上寻找有效 Run。

### 不采用原因

- 当前 schema 只记录 session 的 fork boundary，不记录每个 copied item 到 source item 的映射；
- 无法可靠知道当前 copied item 对应上游哪个 item；
- archive、visible-only、with-archive、后续新消息会进一步破坏可逆映射；
- 递归依赖历史 source session/Run 长期存在；
- 循环、损坏、旧数据会带来更多 unknown；
- 即使找到 source depth，也仍保留“公开 fork 继承 subtask depth”的错误产品定义。

Fallback 最多可用于离线诊断，不应成为新生产语义。

## 决策：不复制 Source `runId`

### 备选方案

fork copied item 时继续保存 source item 的 `runId`，让二次 fork 可以解析 source Run。

### 不采用原因

`agent_context_item.run_id` 是 execution ownership，不是 provenance。

复制 source `runId` 会导致：

- copied item 的 `sessionId` 与 Run 的 `sessionId` 不一致；
- Worker update fence 可能返回 ownership mismatch；
- 按 `run_id` 查询终态 assistant 文本时混入其他 session 的副本；
- 启动恢复或状态清理按 Run 处理时可能跨 session；
- 同一 Run 的执行输出不再唯一稳定。

如果未来需要 fork provenance，应新增独立 `originSessionId/originItemId` 设计，不得复用 `runId`。本次没有 provenance 产品需求，因此不新增字段。

## 决策：不放宽 Prompt 深度过滤

### 备选方案

在 `PromptStaticAssembler` 中把 `subtaskDepth = null` 当作 `0`，或者只在达到 max 时过滤。

### 不采用原因

- unknown depth 是安全状态，不能猜测；
- API `startSubtaskRunFromWorker()` 仍会对 unknown depth 返回 `DepthUnknown`；
- 模型看到工具但调用必然失败，造成接口不一致；
- 真实损坏或遗留 subtask Run 可能绕过最大深度；
- 当前 prompt 规则是正确的下游投影，错误发生在 ordinary primary Run 写入层。

## 决策：公开 API 和通用 Internal API 均 Primary-only

### 选择

- `POST /api/agent/sessions` 移除 `kind`；
- `POST /api/agent/sessions/fork` 移除 `kind`，并校验 source kind；
- `POST /api/internal/agent/sessions/create` 移除 `kind`；
- `/api/internal/agent/subtask/start` 成为生产上唯一可创建 subtask session 的入口。

### 原因

- 仅依赖 Web UI 限制无法形成系统不变量；
- generic internal endpoint 服务插件，不应自动获得 subtask domain 权限；
- subtask session 创建需要 parent Run、tool anchor、depth、agent scope 和幂等校验；
- 通用 create 绕过这些校验会产生孤儿或伪 subtask session。

### 兼容性取舍

这是请求契约收紧：仓库外客户端如果发送 `kind` 会收到 `400`。不采用静默忽略的原因是：

- 静默忽略 `kind="subtask"` 会让调用方误以为创建成功；
- 旧客户端行为需要明确失败才能被发现；
- TypeBox contract 应把非法请求挡在 Route 入口。

## 决策：保留 Existing Subtask 模式

### 原因

- 当前工具描述和取消结果会提示模型使用 `mode="existing"` 继续；
- Worker、Shared internal contract、API 测试已有该能力；
- existing 模式是内部 subtask 生命周期的一部分，不是当前 bug 根因；
- 删除它会扩大范围并破坏继续/复用语义。

### 收紧

- existing session 必须是 `kind="subtask"`；
- 必须 workspace 匹配且 idle；
- 本次 child Run 仍由当前 parent/tool anchor 创建；
- 测试不得通过公开 create 构造 existing session；应走内部 start 创建或直接用 fixture 构造异常记录。

## 决策：拆分 Fork 编排，复用 Clone 原语

### 当前问题

现有 `forkSession()` 同时承担：

- 公开 primary fork；
- 内部 subtask fork；
- target kind 选择；
- public boundary 校验与 internal override；
- transcript/archive 复制；
- session 创建和失败清理。

直接增加 `fromSession.kind === "primary"`、target primary 固定规则，会破坏 `startSubtaskRunFromWorker()` 当前的 `mode="fork"`。

### 目标

建立以下固定职责；函数名不要求逐字一致，但调用方向与职责边界不得变化：

```text
cloneSessionContextIntoNewSession(...)   // 私有复制原语
forkPrimarySession(...)                  // 公开产品规则
createForkedSubtaskSessionInternal(...)  // 内部 subtask 规则
```

复制原语可以处理 archive 与 clone 事务，但不得决定：

- source/target kind 产品权限；
- child Run depth；
-真实 parent Run 关系；
- subtask guard/prefork 编排。

同理，primary create只能创建无fork metadata的新primary；public fork和internal subtask必须由各自application经private materializer创建session。不得因采用不同函数名而把fork metadata重新放进generic primary create。

## 决策：不修改数据库 Schema

现有字段已经足够表达目标模型：

- `agent_session.kind`：会话角色；
- `agent_session.forked_from_*`：上下文分支来源；
- `agent_context_item.run_id`：执行 ownership；
- `agent_run.subtask_depth`：具体 Run 的 subtask 调用深度；
- `agent_run.parent_*`：真实 subtask parent-child。

问题在写入规则和入口权限，不在字段缺失。

## 决策：历史数据只读保留，新 Run 自愈

不批量修改历史：

- 审计和问题复现仍可看到原记录；
- 避免猜测历史普通 fork 与真实 subtask 数据；
- 新 primary Run 写入规则足以恢复工具可见性；
- Prompt static tools 以 Run 为单位，不需要改旧 Run。

## 不接受的临时修复

代码审查必须拒绝以下实现：

- 仅在 `sourceItem.runId == null` 时返回 depth `0`；
- 保留 `resolveRunLineageForSession()` 并增加更多 fallback；
- 只改 sendMessage，漏掉 compact；
- 只改前端按钮，不改服务端 contract/validation；
- generic internal create 继续接受 subtask；
- 直接在现有 `forkSession()` 上加 primary-only 校验；
- copied item 写 source `runId`；
- `PromptStaticAssembler` 把 unknown 当 `0`；
- 删除 existing 模式以回避测试改造；
- 新增 session depth 列但不先修改本设计决策。
