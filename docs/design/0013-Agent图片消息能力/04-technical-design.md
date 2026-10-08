# 技术设计

返回 [README](./README.md)。本文件定义目标架构、组件职责、请求时序、multipart 解析、事务、附件存储、Prompt 投影、Worker 物化、历史预览、生命周期和安全实现。

## 总体架构

```text
Browser / AgentClientPane
  ├─ pendingImages: File[]（本地内存）
  ├─ JSON send（纯文本）
  ├─ multipart send（payload + images*）
  └─ Blob preview（点击后逐张）
             │
             ▼
Main API
  ├─ public message route
  │    ├─ JSON schema
  │    └─ multipart stream parser + temp files
  ├─ NormalizedAgentUserMessageInput
  ├─ SessionInteractionApplication
  ├─ RunLifecycleApplication
  ├─ SQLite activation transaction
  │    ├─ agent_context_item
  │    ├─ agent_attachment
  │    ├─ agent_context_item_attachment
  │    ├─ agent_client_request
  │    └─ agent_run(trigger_item_id)
  ├─ public attachment content route
  └─ PromptContextProjector(triggerItemId)
             │ attachment_ref
             ▼
Agent Worker（共享 AWB_DATA_DIR）
  ├─ attachmentStorage.read(workspaceId, attachmentId)
  ├─ attachment_ref -> AI SDK file part
  └─ streamText({ messages })
             │
             ▼
Provider / Model
```

## 组件职责

| 组件 | 必须承担 | 明确不得承担 |
|---|---|---|
| `AgentClientPane` | Clipboard 提取、本地待发送状态、移除、发送分支、列表入口、Modal Blob 生命周期 | 粘贴时上传、模型能力判断、拼接物理路径、列表自动加载图片 |
| Web API client | JSON/multipart 请求、Blob 内容请求、统一错误转换 | 请求指纹、业务校验权威、永久图片 URL |
| Public route | Content-Type 分流、Shared schema 校验、multipart 流式限制、temp 管理、规范化输入 | Session/Run 业务规则、把 multipart 流传入应用层 |
| Attachment upload service | 受控 temp/final 路径、流式计数、签名检测、文件元数据 | 创建 Run、推断模型能力 |
| Session application | Session/Workspace/Profile/幂等前置业务校验、调用生命周期 | 文件流解析、物理路径拼接 |
| Lifecycle persistence | 单事务激活消息、附件记录、关系、幂等、Run | Provider 调用、文件删除 |
| API attachment query/storage | 元数据与关系唯一事实、公共内容授权、受控写入/读取 | 向 Worker 暴露 storageKey 或绝对路径 |
| Prompt projector | 使用 `triggerItemId` 选择 attachment ref 或历史占位 | 读取图片 bytes、隐式推断当前消息 |
| Worker attachmentStorage | 使用 dataDir、统一安全路径 helper 与 `storageKey === attachmentId` 规则定位，校验物理文件完整性 | 查询 SQLite、调用内部附件 HTTP、自行执行数据库授权、接收 storageKey/path/bytes |
| Worker runner | Run 进入正常模型执行后按每个实际 step 物化 refs、构造 file parts，并按 recovery mode 执行条件化启动恢复与确定性失败收尾 | 持久化附件状态、在 `fail` 启动模式读取附件、静默忽略读取失败、对本地读取失败调用 Provider 或进入模型重试 |

## 目录布局

目标目录必须从 `AWB_DATA_DIR` 派生，不得写死 `/data`：

```text
<AWB_DATA_DIR>/agent/attachments/
  ├─ temp/
  │    └─ <upload-temp-id>.part
  └─ by_workspace/
       └─ <workspaceId>/
            └─ <storageKey>
```

约束：

- `attachmentId` 使用服务端 `newId("att")` 或等价安全 ID；
- V1 固定 `storageKey === attachmentId`；二者均由服务端生成，浏览器不得提供；
- 用户文件名只保存为展示元数据，不参与路径；
- Workspace ID 和 storage key 必须经过安全段校验；
- 所有 resolve 后路径必须位于附件根目录内；
- final 文件不可变，不得覆盖现有文件；
- temp 与 final 在同一 dataDir 文件系统内，便于使用排他 rename/move；
- temp 与 final 文件必须以不宽于 `0600` 的权限创建；目录必须以不宽于 `0700` 的权限创建。若目录已存在，不得主动放宽既有权限。

API 与 Worker 必须复用本功能范围内的统一安全路径 helper；名称可以按现有命名习惯调整，但不得在多个模块各自实现不同的路径规则：

```ts
agentAttachmentsRoot(dataDir)
agentAttachmentTempDir(dataDir)
agentAttachmentWorkspaceDir(dataDir, workspaceId)
agentAttachmentFilePath(dataDir, workspaceId, storageKey)
```

API 写入/公共读取可以从权威元数据取得 `storageKey`；Worker 不查询 DB，而将 Prompt 中受 API 构造的 `workspaceId + attachmentId` 交给注入的 storage，并按 V1 固定的 `storageKey === attachmentId` 规则调用同一安全路径 helper。Prompt 中不存在路径或 storageKey。

## 前端状态与事件

### 类型

```ts
type PendingImage = {
  localId: string;
  file: File;
  filename: string;
  declaredMediaType: string;
  size: number;
};

type ImageAttachmentView = {
  attachmentId: string;
  kind: "image";
  filename: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
};
```

### Paste 处理

`onInputPaste(event)` 必须：

- 从 `clipboardData.items` 获取 `kind === "file"` 的图片；
- 对不提供 items 的环境回退到 `clipboardData.files`；
- 对图片项调用 `getAsFile()`，忽略返回 null 的项；
- 只在发现图片时把图片加入状态；
- 不对纯文本粘贴调用 `preventDefault()`；
- 同时包含文本与图片时，不得阻止默认文本粘贴；
- 前端镜像执行最多 4 张、单张 10 MiB、总 20 MiB；超限图片不加入，并给出明确提示；
- 文件名为空时生成稳定展示名，如 `pasted-image-1.png`；
- 不依据文件名决定服务端 mediaType。

### 发送尝试与幂等 ID

当前 `onSend()` 每次调用都会创建新 ID。目标前端必须实现“发送尝试与草稿内容绑定”的外部行为。下列类型只是等价实现示例，`PendingSendAttempt`、`draftRevision` 的类型名、字段名和内部数据结构均不构成强制合同：

```ts
type PendingSendAttempt = {
  clientRequestId: string;
  draftRevision: number;
};
```

必须满足的行为：

- 每次全新的用户发送生成新的 `clientRequestId`；
- 网络中断、超时或 5xx 等服务端接受状态不确定时，只要文字、图片集合和图片顺序未变化，网络重试必须复用原 ID 与原文件集合；
- 文字变化、粘贴/移除图片或图片顺序变化后，旧发送尝试不得用于新内容，下一次发送必须生成新 ID；
- 成功或 deduplicated 成功后清除该发送尝试和草稿；
- 不把 request fingerprint 发送给服务端。

### Slash 命令

在 `onSend()` 解析 `/compact`、`/clear` 前检查 `pendingImages`：若非空，阻止控制命令并保留草稿。Prompt command 文本展开必须先完成，再构造 multipart payload。

## Multipart 解析设计

消息路由只接受 `application/json` 与 `multipart/form-data`。其他 Content-Type 必须在进入业务应用前返回 415；非法或缺失 multipart boundary 返回 400，并走统一 temp 清理。

### 路由级限制

当前 `createApp.ts` 全局 multipart 限制是 2 GiB 和 1,000,000 parts。Agent 路由必须自行实施：

```text
最大允许 part 数：5（1 payload + 最多 4 images）
最大图片数：4
单图最大读取字节：10 MiB
总图片最大读取字节：20 MiB
payload 最大 UTF-8 字节：64 KiB
```

未知字段也计入 part 数，并立即标记请求非法；在抛错前必须消费/销毁当前 part 流并进入统一 temp 清理。

### 不依赖 part 顺序

解析状态：

```ts
type MultipartParseState = {
  payloadRaw: string | null;
  images: StagedImage[];
  totalBytes: number;
  tempPaths: string[];
  invalidReason: Error | null;
};
```

处理策略：

- `payload` 可以出现在文件前、中、后；
- 普通字段只允许 `payload`；重复时标记错误；
- 文件字段只允许 `images`；
- 每个图片流立即写入独立 temp，同时统计字节并保留签名前缀；
- 一旦单图、总量或 part 数超限，终止写入并清理所有 temp；
- 遍历结束后再统一检查 payload 是否存在、解析 JSON、执行 TypeBox 校验；
- 遍历结束后必须确认 `images.length` 为 1 至 4；0 张图片的 multipart 请求一律拒绝，即使 payload 文本非空；
- 不因为 payload 后到而把文件全部读入内存；
- 不因为前面已发现错误而遗留未消费 request stream；实现必须安全结束/销毁请求并清理。

### 签名检测

服务端实际类型检测必须使用文件前缀：

- PNG：`89 50 4E 47 0D 0A 1A 0A`；
- JPEG：`FF D8 FF`；
- WebP：字节 `0..3` 为 `RIFF` 且 `8..11` 为 `WEBP`。

空文件、前缀不足或不匹配必须拒绝。声明 MIME 只可用于诊断，不能覆盖检测结果。

### Temp 生命周期

所有退出路径必须经过统一 `finally` 或资源管理器：

- 成功激活并把文件移动到 final：移除对应 temp ownership；
- deduplicated：删除本次全部 temp；
- 校验失败：删除全部 temp；
- DB 事务失败：删除 temp，并补偿删除已移动 final；
- 请求中止：删除已创建 temp；
- 进程崩溃：由启动时超期 temp 清理处理。

## 规范化输入

路由必须输出与下列字段等价的规范化结构；具体类型所在文件可按现有端口分层调整：

```ts
type NormalizedUploadedImage = {
  attachmentId: string;
  storageKey: string;
  tempPath: string;
  filename: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  position: number;
};

type NormalizedAgentUserMessageInput = {
  workspaceId: string;
  text: string;
  clientRequestId: string;
  requestedAgentId?: string;
  uiLocale?: AgentUiLocale;
  images: NormalizedUploadedImage[];
};
```

HTTP 层负责 staged image 生成和清理 ownership；应用层只看已校验元数据。为了让 DB 事务与 final 文件协调，route/application 必须通过一个窄的 attachment intake service 或等价端口协作，不得在路由 handler 中散落文件提交逻辑：

```text
stage multipart
  -> normalize payload
  -> SessionInteractionApplication 校验/解析 profile
  -> Lifecycle starter 激活
```

文件 move 与 DB 无法原子提交，见下一节补偿顺序。

## 事务与文件提交

### 固定激活顺序

```text
staged temp files complete
  -> Session/Workspace/Profile/业务校验
  -> 现有 clientRequestId 快速去重
      -> 命中：删除 temp，返回第一次结果
  -> 把 temp 以排他方式移动到 final
  -> SQLite transaction:
       再次权威去重
       检查 session idle
       insert agent_attachment
       append user context item
       insert agent_context_item_attachment(position)
       update first-message session title
       insert agent_client_request
       insert agent_run(trigger_item_id)
       update run state
  -> commit
  -> enqueue Worker
```

权威去重必须仍在 SQLite transaction 内执行，保留现有并发安全。

### 并发去重补偿

可能发生两个相同 key 请求都通过快速检查并移动各自 final 文件，只有一个事务先提交。后进入事务的请求命中 dedup 后必须：

- 不插入附件或关系；
- 返回第一次 `messageItemId/runId`；
- 删除本请求移动出的全部 final 文件；
- 不删除第一次请求的附件。

文件 ownership 必须由 attachment intake 协作者持有；`activateUserRun()` 返回 `deduplicated` 或抛错后，调用方根据该 ownership 删除本请求已经移动到 final 的文件。Lifecycle persistence 只返回业务结果，不接收物理路径，也不删除文件。

### DB 失败

如果 final 文件已移动但 transaction 抛错：

- transaction 自动回滚 DB；
- 调用方必须 best-effort 删除本次 final 文件；
- 删除失败记录安全日志，不暴露路径给用户；
- V1 接受进程崩溃窗口产生少量无记录 final 文件，Workspace 删除时统一清理。

### Enqueue 失败

现有 `RunLifecycleApplication.startUserRun()` 在 enqueue 失败时把 Run 标为 failed/idle 并重新抛错。附件和用户 Context Item 已提交，必须保留。不得因为 HTTP 返回错误而执行 attachment rollback。

## Context Item 与公共投影

带图消息的持久化文字仍写入 Context Item 的 `output_text` 拆分列。存储映射必须能从“该 user item 是否存在附件关系”判断公共输出类型：

- 无关系：`{ type: "user_text", text }`；
- 有关系：`{ type: "user_message", text, attachments }`。

`attachments` 来自 relation join，按 `position` 排序。`output_json` 保持 `{}` 兼容路径，不保存附件列表。

这要求读取单项、列表、transcript、visible item、SSE/worker 写回涉及的 Context Item mapper 都使用同一附件投影权威，避免某些 API 返回 `user_text`、另一些返回 `user_message`。

## Prompt 投影设计

### Run 关联传递

当前链路缺口必须补齐：

```text
getAgentRun(runId)
  -> ReadSideRun.triggerItemId
  -> ReadSideApplication.projectPromptContext(run)
  -> PromptContextProjector.getPromptContextForRun()
  -> buildMessages({ triggerItemId })
  -> buildPromptMessagesForSession({ triggerItemId })
```

`ReadSideRun.triggerItemId` 对用户 Run 必须为正整数；如果历史脏数据/其他 run 模式出现 null，则所有图片消息必须安全降级为占位，不得猜测。

### Prompt part

API 内部定义：

```ts
type PromptAttachmentRefPart = {
  type: "attachment_ref";
  attachmentId: string;
  workspaceId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
};
```

`workspaceId` 是受 API 构造的内部字段，用于 Worker storage scope 校验；不来自浏览器。`filename` 只供 Provider file part 展示，不用于 Prompt 占位或路径。

目标 user Prompt content：

```ts
type UserPromptContent = string | Array<
  | { type: "text"; text: string }
  | PromptAttachmentRefPart
>;
```

Internal TypeBox contract 必须把现有 text/tool-call/tool-result 与 attachment ref 组合成明确 schema，不得只依赖 `Type.Any()` 接纳任意附件形态。现有 AI SDK tool parts 的合同必须保持兼容。

### 原始 Run

```text
item.kind=user
item has attachment relations
item.id === triggerItemId
```

则：

- 文本非空：首 part 为原文；
- 文本为空：首 part 为仅图片固定提示；
- 其后按 position 输出 attachment refs；
- 每个 step 调用同一构建逻辑，得到同一引用集合。

### 后续 Run 与无 Run 的 Messages Context

任何不满足 `item.id === triggerItemId` 的带图 user item，输出：

```text
<original text if any>

[This user message included N image attachment(s). Their image contents are not included in this run.]
```

`MessagesContextProjector` 用于 compaction/one-shot 文本上下文，没有当前 trigger item。其调用 `buildPromptMessagesForSession()` 时必须传 `triggerItemId: null`，使所有图片降级为占位。Compaction 模型因此永远不接收图片。

### Archive

`buildArchiveLine()` 必须支持 `user_message`，并使用与历史占位同等安全的文本表达。Archive 行仍保留现有 item 元数据前缀，但正文不得包含附件文件名、ID、hash、storage key 或路径。

Compaction snippet 的 user 过滤条件也必须把带图消息视为 user 文本；仅图片消息因为占位非空，必须能进入可归档行和尾部摘录。

## Worker 附件物化

### 可注入 storage

Worker Env 增加 `dataDir`，从 `AWB_DATA_DIR` 解析；API spawn Worker 时已继承父环境，但配置必须显式建模和测试。V1 Worker 不查询 SQLite，也不调用内部附件 HTTP。

Worker 必须注入与下列能力等价的存储端口：

```ts
type AgentAttachmentStorage = {
  read(input: {
    workspaceId: string;
    attachmentId: string;
    mediaType: string;
  }): Promise<{
    bytes: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>;
};
```

实现必须：

- 只接受 API Prompt 投影生成的 `workspaceId + attachmentId + mediaType`；`filename` 仅在 Runner 构造 Provider part 时使用；
- 使用 `dataDir`、统一安全路径 helper 与 `storageKey === attachmentId` 规则定位；
- 不接受 storageKey、绝对路径、Base64 或 bytes 输入；
- 不查询 SQLite，不调用内部附件 HTTP，不自行检查 Context Item/Session/Workspace 数据库关系；
- 校验 attachment ID 安全格式；
- 根据 workspace scope 定位附件；
- 确认目标为普通文件；
- 进行 realpath containment 或 no-symlink 等价保护；
- 检查实际 stat 大小位于 `1..10 MiB`；
- 不跟随越界 symlink；
- 重新检测 PNG/JPEG/WebP 文件签名，实际 mediaType 与引用不一致时失败；
- 返回 bytes，不修改文件。

鉴权归属固定在 API：只有 API 通过关系表、Run 和 `triggerItemId` 投影出的 trigger item 才能产生 attachment ref。Worker 只消费该引用并校验物理文件完整性，不建立第二套授权模型。

### 消息转换

在 `runner.ts` 构造 `requestBase` 之前：

```text
context.messages
  -> materializePromptAttachments()
  -> attachment_ref 替换为 { type: "file", data, mediaType, filename }
  -> streamText()
```

- API 返回的原始 context 对象不应被原地永久修改，避免后续逻辑复用时混入 bytes；
- 一次模型调用内可复用物化结果；
- Run 已进入正常模型执行时，下一实际 step 重新获取 Prompt Context 并重新读取；
- 任一引用物化、路径校验或本地读取失败属于本地确定性、不可重试错误；
- 失败时不得调用 `streamText()`，不得进入模型请求自动重试，必须直接走现有 Assistant/Run failed 收尾；
- 不得丢掉该 part 后继续调用 Provider；
- V1 不要求新增公共专用 error code，但内部错误/日志必须能区分非法引用、路径越界、文件缺失、非普通文件、大小非法、签名/mediaType 不匹配和读取失败；
- 日志只记录 attachmentId、错误类别及必要的非敏感大小信息，不记录绝对路径、bytes、Base64 或完整消息。

### 启动恢复

前述“下一 step 重新读取”和“同一 Run 内部自动重试复用同一附件集合”只适用于已经进入正常模型执行的 Run，不构成启动时无条件读取附件的要求。图片附件启动恢复语义必须服从现有 `agentStartupRecoveryMode`：

- `recover`：仅当现有 `recoverRunsOnStartup()` 流程确认候选仍可恢复并继续 enqueue 同一 `runId` 时，该 Run 的 Prompt 才通过已持久化 `triggerItemId` 重新投影出相同附件集合；进入模型执行后，每个实际 step 按正常规则重新读取；
- `fail`：现有 `failRunsOnStartup()` 流程直接按失败语义结束未完成 Run，不获取图片 Prompt Context、不调用 Worker storage、不读取附件文件；
- 除 `recover` 条件成立外，启动流程不得投影 attachment refs、物化附件或读取附件文件；
- 图片功能不得把 `fail` 模式变成恢复，也不得为恢复另建附件快照。

## 历史附件内容读取

公共接口固定为 `GET /api/agent/attachments/:attachmentId/content`。

### 鉴权查询

公共读取接口按 attachmentId 执行：

```sql
agent_attachment
  join agent_context_item_attachment
  join agent_context_item
  join agent_session
```

必须证明：

- 未通过现有主 API 认证的请求在进入附件 route handler 前由全局 auth guard 返回 401；
- attachment 存在；
- 至少有一个关系指向有效 Agent Context Item；
- Context Item workspace/session 与附件 workspace 一致；
- 不通过 path/query 选择 Workspace。

当前产品是单实例全局认证，不额外引入多用户 ACL。但关系验证仍是文件边界，不得省略。

状态码边界固定：全局认证失败为 401；请求已通过认证后，attachment 不存在、无关系、Workspace/Session 关系不匹配、物理文件缺失或物理文件不满足安全读取条件统一返回 404。附件 route handler 不得把认证失败改写为 404，也不得把已认证后的存在性差异拆成不同状态码。

### 响应

固定：

```http
Content-Type: <persisted allowlisted media type>
Content-Disposition: inline
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

必须在成功 stat 后返回准确的 `Content-Length`，并使用 `fs.createReadStream()` 或等价流式响应；V1 不要求 Range。

物理文件缺失、非普通文件、越界或关系不存在统一返回 404；内部记录安全日志。

## Fork、Clear、Compaction、Revert

### Fork

`cloneSession()` 已在事务中建立 `clonedIdMap`。追加步骤：

```text
append new context item
  -> clonedIdMap old->new
  -> query old item relations
  -> insert relations for new item with same attachmentId/position
```

必须在同一 SQLite transaction。Archive 写入失败后删除新 Session 时，relation 通过 Context Item FK cascade 删除；attachment 仍被源 item 引用，不删除。

### Clear / Compaction / Archive

- 只标记 `archive_at` 并写文本；
- 不删除 Context Item 或 relation；
- 不删除附件；
- `buildArchiveLine()` 使用安全占位；
- Compaction Messages Context 传 `triggerItemId: null`。

### Revert

只移动 head；不删 Context Item、关系或附件。后续新 Run 中历史图片仍为占位。

## Workspace 删除与轻量清理

### Workspace 删除

现有事务顺序需扩展：

```text
delete agent_client_request
  -> delete agent_session (Context Item/relation cascade)
  -> delete agent_attachment where workspace_id=?
  -> delete workspace repos
  -> delete workspace
```

`agent_attachment.workspace_id` 使用 restrict 时必须显式删除。事务提交后：

- best-effort 删除 Workspace 目录；
- best-effort 删除 Agent Archive 目录；
- best-effort 删除 `agent/attachments/by_workspace/<workspaceId>`；
- 每个路径都必须验证位于 `AWB_DATA_DIR`；
- 删除失败记录 warning，不恢复已提交 DB。

### Temp 清理

V1 使用固定 24 小时宽限期。API 每次启动时执行一次清理；不得为此增加常驻 timer：

- 只扫描附件 temp 目录第一层；
- 只删除普通文件；
- 文件 mtime 超过 24 小时；
- 不跟随 symlink；
- 单个删除失败 warning 后继续；
- 不扫描或删除 final 文件；
- 不建立常驻 timer 或状态机。

## 安全边界

### 上传

- 路由级限制优先于全局宽松 multipart 配置；
- 流式写入，不把完整 request 收入内存；
- 文件签名决定实际格式；
- 原始文件名只能展示，清理控制字符和长度；
- 拒绝未知字段、重复 payload、0 字节和 SVG；
- temp/final 文件名完全由服务端生成；
- 所有失败路径清理 temp。

### 存储与读取

- 只在 `AWB_DATA_DIR` 派生目录；
- 不通过用户输入拼路径；
- final 不可变、排他创建；
- Worker/API 都做 containment；
- 公共接口不暴露 path、storageKey；
- 响应 `nosniff`、`private, no-store`；
- 日志不得记录图片内容或完整 multipart payload。

### Prompt

- attachment ref 只由 API read side 生成；
- 只有 trigger item 产生 ref；
- 历史/Archive/Compaction 不包含不可信文件元数据；
- Worker 必须在 Provider 调用前完成 ref 物化；
- Provider 错误不得泄露物理路径。

## 可观测性

V1 日志可以记录：

- workspaceId、sessionId、runId、messageItemId；
- attachmentId；
- 实际 mediaType、byteSize；
- 上传拒绝原因枚举；
- temp/final 补偿删除失败；
- Worker 读取失败类别；
- 预览 404/读取失败。

不得记录：

- 图片 bytes、Base64、data URL；
- 完整用户 Prompt；
- 完整原始文件名；
- storage absolute path；
- Provider 完整请求体。
