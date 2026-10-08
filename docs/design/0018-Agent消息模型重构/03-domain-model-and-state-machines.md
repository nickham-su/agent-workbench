# 领域模型与状态机

## 领域模型总览

```text
Workspace
  └─ AgentSession
       ├─ headMessageId
       ├─ contextRootMessageId
       └─ revision

  └─ Session Run State（由 session_run_state 权威管理）
       ├─ status
       ├─ activeRunId
       ├─ runNoticeText
       ├─ nonTerminalMessageIds
       └─ nonTerminalToolExecutionIds

Message Graph（Workspace 级共享）
  └─ Message
       ├─ previousMessageId
       ├─ replacesMessageId
       └─ Part[]
            ├─ TextPart
            ├─ ReasoningPart
            ├─ ImagePart
            └─ ToolCallPart
                 └─ ToolExecution
```

Session 不重复保存运行状态。`headMessageId`、`contextRootMessageId`、`revision` 属于 Session 分支状态；`status/activeRunId/runNoticeText/nonTerminal...` 属于 Run State。

## Session

### 字段

```ts
type AgentSession = {
  id: string;
  workspaceId: string;

  headMessageId: string | null;
  contextRootMessageId: string | null;
  revision: number;

  forkedFromSessionId: string | null;
  forkedFromMessageId: string | null;

  createdAt: number;
  updatedAt: number;
};
```

### 边界定义

- `headMessageId`：当前分支末端。
- `contextRootMessageId`：正常模型请求可见的最早 Message。
- 归档范围：

```text
Message Graph 根节点 ～ contextRootMessageId.previousMessageId
```

- 模型可见范围：

```text
contextRootMessageId ～ headMessageId
```

### Session 不变量

- `contextRootMessageId` 必须是 `headMessageId` 的祖先或自身。
- 归档范围与模型范围都由祖先链推出，不依赖 Message 自身字段。
- Fork、回退、压缩、append 都必须通过 `expectedHeadMessageId + expectedRevision` CAS。
- Session 硬删除不删除共享 Message、Part、ToolExecution、FTS 条目或附件。
- Session 删除后，其来源引用通过 `originSessionId ON DELETE SET NULL` 或弱引用方式保留为空。
- Workspace 删除是显式级联清理入口，必须显式删除 Workspace 下 Message、Part、ToolExecution、FTS 条目、附件、Session 与 Run State 私有数据。

## Run State

Run State 继续由演进后的 `session_run_state` 权威管理，不复制到 Session 表。

### 字段

```ts
type AgentSessionRunState = {
  workspaceId: string;
  sessionId: string;

  status: "idle" | "running";
  activeRunId: string | null;

  runNoticeText: string;
  retryCount: number;
  nextRetryAt: number | null;

  activeAssistantMessageId: string | null;
  nonTerminalMessageIds: string[];
  nonTerminalToolExecutionIds: string[];

  updatedAt: number;
};
```

### 字段语义

- `status/activeRunId`：当前会话运行状态。
- `runNoticeText`：模型错误、自动重试、恢复、未知工具等用户可见提示。
- `retryCount/nextRetryAt`：模型自动重试状态；Worker 重启后计数可重置为 0，不依赖全局连续计数。
- `activeAssistantMessageId`：当前 streaming Assistant，用于恢复和写入围栏。
- `nonTerminalMessageIds/nonTerminalToolExecutionIds`：增量刷新与恢复扫描入口。
- Run 相关记录仍保留 `runId`，recover、重复 recovery、enqueue 均按 `runId` 幂等。

## Message

### 字段

```ts
type AgentMessage = {
  id: string;
  workspaceId: string;

  previousMessageId: string | null;
  replacesMessageId: string | null;
  depth: number;

  type: "user" | "assistant" | "system" | "compaction" | "runtime";

  status:
    | "streaming"
    | "completed"
    | "failed"
    | "cancelled"
    | "superseded";

  originSessionId: string | null;
  originRunId: string | null;

  updatedRevision: number;
  createdAt: number;
  updatedAt: number;
};
```

### 字段语义

- `previousMessageId`：正常对话时间线、模型上下文、Fork、回退。
- `replacesMessageId`：自动重试替代关系，不参与正常上下文重建。
- `depth`：根为 0，子节点为父节点 `depth + 1`；只用于排序和预检。
- `originSessionId`：记录消息创建来源；不代表消息所有权；允许为空并支持 Session 删除后置空。
- `originRunId`：用于流式写入围栏和恢复诊断；允许为空并支持 Run 删除后置空。

### Message 不变量

- Message 只有一个 `previousMessageId`。
- Message 可以有多个后继，形成共享分叉图。
- 从任意 Session Head 向前回溯仍是一条线性链。
- Message 在 `streaming` 阶段允许更新；进入任何终态后冻结。
- `depth` 不能用于证明祖先关系。
- `superseded` 不在正常 `previousMessageId` 时间线上。
- `replacesMessageId` 目标必须与被替代消息有相同 `previousMessageId`，该约束由应用事务保证。

### 终态语义

| status | 语义 |
|---|---|
| `completed` | 正常对话事实，可进入模型请求、压缩输入、FTS |
| `failed` | 可能仍在正常链上，但默认被模型请求、压缩、FTS 排除 |
| `cancelled` | 默认被模型请求、压缩、FTS 排除 |
| `superseded` | 被替代的旧尝试，不在正常链上，仅审计与 UI 展示 |

## Part

Part 保存当前实际支持的内容类型：

```ts
type AgentPart =
  | TextPart
  | ReasoningPart
  | ImagePart
  | ToolCallPart;
```

### TextPart

```ts
type TextPart = {
  id: string;
  messageId: string;
  position: number;
  type: "text";
  text: string;
  updatedRevision: number;
};
```

- Assistant TextPart 在 streaming 阶段允许更新。
- User/System/Compaction TextPart 创建后保持稳定。
- TextPart 参与 archive_read 与 archive_search。

### ReasoningPart

```ts
type ReasoningPart = {
  id: string;
  messageId: string;
  position: number;
  type: "reasoning";
  text: string;
  updatedRevision: number;
};
```

权威规则：

- 完整保存；
- 实时前端展示；
- 不进入后续模型请求；
- 不进入压缩摘要；
- 不进入 FTS；
- 不通过 archive 工具返回。

### ImagePart

```ts
type ImagePart = {
  id: string;
  messageId: string;
  position: number;
  type: "image";
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
};
```

- 图片二进制不写入 Message Part 表。
- 图片按附件资源保存。
- 历史图片不重新发送给 Provider，请求重建时投影为明确占位说明。
- 只有本次 Run 的触发 User Message 中的图片参与当前请求物化。

### ToolCallPart

```ts
type ToolCallPart = {
  id: string;
  messageId: string;
  position: number;
  type: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
  providerToolCallId: string | null;
};
```

- `input` 是模型声明的规范化调用输入。
- `providerToolCallId` 仅做协议映射。
- ToolCall 与 ToolExecution 的关联主键是 `ToolCallPart.id`。

## ToolExecution

```ts
type ToolExecution = {
  id: string;
  callPartId: string;

  originSessionId: string | null;
  originRunId: string | null;

  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown";

  resultPreview: string | null;
  resultTruncated: boolean;
  resultArtifactPath: string | null;
  structuredResult: unknown | null;
  error: string | null;

  updatedRevision: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};
```

### 关联约束

- `callPartId` 唯一。
- `callPartId` 必须指向同 Workspace 下 `type = 'tool_call'` 的 Part；该约束由应用事务保证。
- 跨 Workspace 关联必须拒绝。
- Fork 后历史 ToolExecution 允许被多个 Session 读取，不复制、不重新执行。
- `originSessionId/originRunId` 仅用于来源和恢复，不代表当前可见性；允许为空并支持来源删除后置空。

### 状态语义

| status | 含义 |
|---|---|
| `queued` | 工具绝对尚未执行 |
| `running` | 工具调用可能已经开始，副作用可能已经发生 |
| `completed` | 成功终态 |
| `failed` | 明确失败终态 |
| `cancelled` | 被策略或取消流程明确取消 |
| `unknown` | 无法确认是否执行或是否产生副作用 |

### 关键不变量

- `queued → running` 必须在实际调用工具之前原子写入。
- `queued` 可自动恢复执行。
- `running` 崩溃后只能转为 `unknown`，不能自动重跑。
- `unknown` 是终态，不阻塞下一轮模型请求。
- ToolExecution 终态后不可覆盖。
- 历史 ToolExecution 在 Fork、回退、重试中均不会重新执行。

### 本期工具结果字段口径

本期承认 `resultPreview` 是多数普通工具的持久化权威结果投影及模型结果来源；详情接口只返回实际已保存的 `structuredResult / resultPreview / artifact` 信息，不宣称完整。

本期沿用当前 `AgentToolOutput` 语义，最小迁移到 ToolExecution：

- 所有工具保存格式化 `resultPreview/error`；
- 仅 `apply_patch`、`todolist`、`subtask`、`write`、`scratchpad` 保存 `structuredResult`；
- 工具结果文本超过 8,000 字符时保存 3,000 字符预览；
- 超长正文写入 workspace artifact，最大 200,000 字符；
- `subtask` 继续沿用不截断特例；
- artifact 路径基于 `toolExecutionId`；
- artifact 成功而数据库提交失败时，允许残留文件存在；后续同 execution 幂等重写，不承诺绝对不可覆盖；
- artifact 写入失败后保留当前降级行为；
- 超过 200,000 字符后的内容丢失是本期接受取舍，不承诺完整；
- 模型 tool result 由单一 Runtime Transcript Projector 确定性生成，每个 completed Assistant 的每个 ToolCallPart 恰好一个结果信封，不回写 `ToolExecution` 权威字段；
- `unknown`：固定不确定说明，可附可靠 preview，但不作为成功；
- `cancelled`：有 error 优先 error，否则有可靠 preview 用 preview，皆无固定说明“工具调用在执行前被取消，未执行”；
- `failed`：error 优先，其次可靠 preview，皆无固定内部失败说明；
- `completed`：使用 resultPreview，为空时用固定空成功结果说明，不视为不变量错误，不导致 Turn 失败；
- 不自动读取 artifact；
- `structuredResult` 不参与本期模型投影，仅供专用 API / UI；
- `subtask` 是 resultPreview 不截断特例，进入模型的是格式化 resultPreview，不是任意 structured 对象。

## Assistant 自动重试状态机

### 未产生有效输出

```text
streaming(empty)
  → 模型错误
  → 更新 runNoticeText
  → 退避
  → 继续请求
```

### 已产生部分输出

```text
streaming(partial)
  → 模型错误
  → 旧 Message.status = superseded
  → 创建新 Message(status=streaming, replacesMessageId=old)
  → Session Head 切换到新 Message
  → 更新 runNoticeText
  → 继续请求
```

### 重试链约束

- 每次替代必须在同一 SQLite 事务中完成。
- 旧尝试的 ToolCall 不执行。
- 正常上下文只沿 `previousMessageId` 构建。
- UI 若要展示旧尝试，从当前消息沿 `replacesMessageId` 查询。
- 重试错误提示不写入 TextPart，避免污染对话、压缩和 FTS。
- 所有模型错误持续退避重试；用户终止后停止重试，并把当前 streaming Assistant 收敛为 `cancelled`。
- 退避计数只要求同一运行过程内递增；Worker 重启后可重置为 0。

## Compaction 摘要状态机

- Compaction 中间摘要只在 Worker 内存中累积，不提前写 streaming Compaction Message。
- 摘要成功后，在同一 CAS 事务中直接创建 `completed` Compaction Message，并设置：
  - `previousMessageId = oldHead`
  - Session `headMessageId/contextRootMessageId` 切换到 Compaction Message
  - revision 递增
- 摘要失败不改变 Head 或 Context Root。
- Compaction Provider 错误与正常 Assistant 一样持续退避重试。
- 不引入额外 `ModelAttempt`。
- Compaction 中间摘要不为了“模型输出完整保存”而落库；该承诺只针对正常 Assistant 输出。
- 600 秒定义为单次摘要 Provider 请求超时，超时继续退避重试。
- 8 块为输入硬限制，超过则压缩失败。
- 用户终止 / SQLite 不变量失败 / 输入分块硬限制是压缩失败边界。

## Fork 状态机

```text
源 Session idle
  ↓
校验目标在当前模型可见祖先链
  ↓
校验目标终态且工具全部终态
  ↓
创建 child Session
  ↓
child.head = target
child.contextRoot = source.contextRoot
  ↓
source.revision / child.revision 独立维护
```

fork 后两个 Session 分别 append 新 Message，自然分叉。

## 回退状态机

```text
Session idle
  ↓
校验目标是当前 Head 的祖先
  ↓
校验目标位于 contextRoot ～ head
  ↓
CAS 更新 headMessageId = target
  ↓
revision += 1
```

回退不修改、不删除、不复制 Message，也不撤销工具副作用。

## 压缩状态机

```text
待压缩范围全部终态
  ↓
生成摘要（Worker 内存中间摘要）
  ↓
成功后在同一事务直接创建 completed Compaction Message
  ↓
CAS 更新当前 Session:
  head = summary
  contextRoot = summary
  revision += 1
```

压缩不修改旧 Message。若摘要生成失败，不改变 Head 或 Context Root。

## 归档状态机

归档不是 Message 自身状态，而是由 Session 的 `contextRootMessageId` 推出的范围：

```text
根节点 → contextRoot 之前：archive_read/search 范围
contextRoot → head：模型请求范围
```

同一 Message 在不同 Session 中可以分别处于归档或正常上下文。

## FTS 状态机

- Message 未 completed：不写 FTS；
- Message completed：在同一事务中一次性写入符合条件的 TextPart；
- `failed/cancelled/superseded`：不写 FTS；
- Reasoning、ToolCall、Image、ToolExecution、Runtime：不写 FTS；
- FTS 采用 `agent_text_part_fts_map(part_id PRIMARY KEY, fts_rowid UNIQUE) + FTS rowid` 的全局唯一方案；
- FTS 表不保存 `session_id`；
- FTS 是可重建派生索引，不是消息权威数据；
- FTS 查询必须与指定 Session 的归档祖先链求交。

## Run 恢复与终止闭环

### 恢复入口

Worker/API 启动时演进现有 startup recovery：

- 扫描 `session_run_state.status = running` 或存在未完成 non-terminal 对象的 Run；
- 按 `runId` 幂等 recover；
- 重复 recovery、重复 enqueue 均按 `runId` 去重；
- 恢复成功后继续当前 Run，不重复创建新 Run。

### 恢复规则

- 空 streaming Assistant：继续重试；
- 有内容 streaming Assistant：作废并创建替代 Assistant；
- `queued` ToolExecution：重新执行；
- `running` ToolExecution：转为 `unknown`；
- 其他终态保持不变；
- 恢复后更新 `runNoticeText` 说明已自动恢复。

### 终止收敛

用户终止时，根据当前阶段收敛：

- 模型退避等待中：停止后续请求；
- 请求进行中：中止请求；
- streaming Assistant（有无部分输出）一律 `cancelled`；
- `superseded` 仅用于已创建替代消息的自动重试；
- `queued → cancelled`、`running → unknown`；
- Run 记录 → `cancelled`；
- `session_run_state → idle`，并清空 activeRun/activeAssistant/retry/nextRetry/nonterminal；
- `runNoticeText` 固定改为用户终止说明；
- 提交后旧写回由 fence 拒绝。

## runNoticeText 规则

- 模型错误自动重试时更新 `runNoticeText`，包含最新错误、已重试次数、下次重试时间；
- 成功收到有效输出后清除模型重试提示；
- Worker 重启恢复后可重置或改写恢复提示；
- 错误提示不写入 Assistant TextPart；
- 用户终止时固定写入用户终止说明。
