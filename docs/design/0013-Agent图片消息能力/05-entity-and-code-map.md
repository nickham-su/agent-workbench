# 实体设计与代码地图

返回 [README](./README.md)。本文件定义 Shared contract、数据库实体、内部类型、路径实体、代码引用和预计改动范围。

## Shared 公共契约

### 发送字段复用

在 `packages/shared/src/contracts/agent.ts` 中抽取公共字段，示意：

```ts
const AgentSendMessageCommonFields = {
  workspaceId: Type.String({ minLength: 1 }),
  clientRequestId: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  uiLocale: Type.Optional(AgentUiLocaleSchema)
};
```

现有 JSON schema 继续为：

```ts
export const AgentSendMessageRequestSchema = Type.Object({
  ...AgentSendMessageCommonFields,
  text: Type.String({ minLength: 1 })
}, { additionalProperties: false });
```

新增 multipart payload schema：

```ts
export const AgentSendMessageMultipartPayloadSchema = Type.Object({
  ...AgentSendMessageCommonFields,
  text: Type.Optional(Type.String())
}, { additionalProperties: false });
```

注意：

- multipart 文件不进入 TypeBox payload；路由负责文件 part；
- Shared schema 是 payload 字段规则唯一权威；
- 业务层统一规范化 `text ?? ""`；
- JSON schema 不得变成可选文本。

### 附件公共输出

目标 Shared contract 必须增加与下列结构等价的 schema；导出符号名按现有命名习惯确定：

```ts
export const AgentMessageImageAttachmentSchema = Type.Object({
  attachmentId: Type.String({ minLength: 1 }),
  kind: Type.Literal("image"),
  filename: Type.String(),
  mediaType: Type.Union([
    Type.Literal("image/png"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/webp")
  ]),
  size: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 })
}, { additionalProperties: false });

export const AgentUserMessageOutputSchema = Type.Object({
  type: Type.Literal("user_message"),
  text: Type.String(),
  attachments: Type.Array(AgentMessageImageAttachmentSchema, { minItems: 1, maxItems: 4 })
}, { additionalProperties: false });
```

`AgentContextItemOutputSchema` 加入 `AgentUserMessageOutputSchema`。旧 `AgentUserTextOutputSchema` 保留。

公共 `attachments` 是 read projection，不是 `output_json` 持久化来源。

## 内部规范化类型

以下类型必须位于 Agent route/intake/application 的窄端口中，而不是 Shared 公共 API；名称可按现有分层调整：

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

应用端口进一步应只传已持久化准备就绪的 attachment inputs，不传 HTTP stream。

### 生命周期端口

当前 `SessionLifecycleStarter.startUserRun()`、`StartUserRunCommand`、`UserRunActivationInput` 只有 `text/inputText`。目标应增加附件数组：

```ts
type UserRunImageInput = {
  attachmentId: string;
  storageKey: string;
  filename: string;
  mediaType: AgentImageMediaType;
  byteSize: number;
  position: number;
};
```

- `text` 使用 trim 后持久化语义；
- `inputText` 保留原始输入文本供 enqueue/现有行为；
- 图片只进入 activation persistence；无需把附件列表加入 `AgentWorkerEnqueueRequest`，Worker 通过 Prompt Context 获取引用。

## 数据库实体

### `agent_attachment`

目标表结构固定为：

```sql
create table if not exists agent_attachment (
  id text primary key,
  workspace_id text not null,
  storage_key text not null,
  filename text not null check (length(filename) between 1 and 255),
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  created_at integer not null,
  unique (workspace_id, storage_key),
  foreign key (workspace_id) references workspaces(id) on delete restrict
);
```

不变量：

- `id` 是外部/内部引用标识；
- `storage_key` 只供受控存储实现使用，不进入公共 projection；
- `media_type` 和 `byte_size` 同时由应用校验与数据库 CHECK 保护；
- `byte_size` 必须在 `1..10 MiB`；
- 文件名是 1 至 255 个 Unicode code point 的清理后展示名，不参与路径；
- 附件归属 Workspace，不直接归属 Session，因为 Fork 会跨 Session 共享。

必须创建 Workspace 查询索引：

```sql
create index if not exists idx_agent_attachment_workspace_created
on agent_attachment(workspace_id, created_at);
```

### `agent_context_item_attachment`

```sql
create table if not exists agent_context_item_attachment (
  context_item_id integer not null,
  attachment_id text not null,
  position integer not null check (position between 0 and 3),
  primary key (context_item_id, attachment_id),
  unique (context_item_id, position),
  foreign key (context_item_id)
    references agent_context_item(id)
    on delete cascade,
  foreign key (attachment_id)
    references agent_attachment(id)
    on delete restrict
);
```

不变量：

- 一条图片消息最多 4 行；
- `position` 从 0 开始连续递增；
- 一个 attachment 在同一 message 中只出现一次；
- 多个 Context Item 可以引用同一个 attachment；
- Archive 状态不影响 relation；
- 关系表是引用事实来源。

必须索引：

```sql
create index if not exists idx_agent_context_item_attachment_attachment
on agent_context_item_attachment(attachment_id);
```

不得重复建立仅含 `context_item_id` 的索引；复合主键已经覆盖该查询前缀。

### 不修改 `agent_client_request`

V1 不新增 `request_fingerprint` 或版本列。现有主键与字段保持不变。

### 不修改 `agent_run` schema

`trigger_item_id` 已存在。需要修改 Run 查询投影，使 `ReadSideRun` 获取该字段，不需要 DB migration。

## Context Item 存储与投影

当前 `agent.store.ts` 的 `encodeStoredColumns()` 将非 tool output 写入拆分列，`output_json` 固定 `{}`；`mapFromStoredColumns()` 对 user 固定返回 `user_text`。

目标修改：

- user 文字继续存 `output_text`；
- `appendContextItem()` 不接收或编码 attachment IDs；
- 写入关系由 lifecycle persistence 在获得新 item ID 后完成；
- 读取 Context Item 时查询附件关系；
- 关系为空返回 `user_text`；
- 关系非空返回 `user_message`；
- 所有返回 `AgentContextItemRecord` 的查询必须使用同一 hydration helper，避免类型不一致；
- `parseLegacyOutput()` 只承担历史兼容，不作为新图片消息事实来源。

必须提供与下列能力等价的窄 helper/port；具体符号名按现有 Store 命名习惯调整：

```ts
listContextItemImageAttachments(db, contextItemId)
hydrateContextItemAttachments(db, item)
insertContextItemAttachmentRelations(db, input)
cloneContextItemAttachmentRelations(db, oldItemId, newItemId)
```

如批量列表出现 N+1，必须使用一次按 item ID 集合查询并分组，不得逐消息查询。会话历史默认 100 条分页，附件投影应该批量 hydration。

## Prompt 内部契约

### Content part

在 `packages/shared/src/internal-contracts/agent-api-read.ts` 中新增：

```ts
const AgentApiPromptAttachmentRefPartSchema = Type.Object({
  type: Type.Literal("attachment_ref"),
  workspaceId: Type.String({ minLength: 1 }),
  attachmentId: Type.String({ minLength: 1 }),
  mediaType: AgentImageMediaTypeSchema,
  filename: Type.String()
}, { additionalProperties: false });
```

现有 `AgentApiPromptMessageSchema.content: Type.Any()` 需要至少对 user content 收紧为：

- string；或
- text part + attachment ref part 数组。

Assistant/tool 现有 tool-call/tool-result 结构也必须继续通过响应校验。实现可以定义完整角色区分 union，不能只给 user 新增一个宽泛 Any 分支。

### `ReadSideRun`

目标：

```ts
type ReadSideRun = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  triggerItemId: number | null;
  agentId: string;
  providerId: string;
  modelId: string;
  subtaskDepth: number | null;
};
```

如果 DB 运行记录保证用户 run 非空，可内部保持 number；read-side 为兼容恢复/旧数据可以用 null，并采用安全占位策略。

### Prompt build input

```ts
type BuildPromptMessagesInput = {
  workspaceId: string;
  sessionId: string;
  triggerItemId: number | null;
  compactionSnippetUiLocale: AgentUiLocale | null;
};
```

`PromptContextProjector` 传当前 run 的 trigger；`MessagesContextProjector` 传 null。

## Worker 类型与存储

### Worker Env

`apps/agent-worker/src/config/env.ts` 的 `WorkerEnv` 增加：

```ts
dataDir: string;
```

从 `AWB_DATA_DIR` 读取，必须：

- 非空；
- `path.resolve()` 规范化；
- 与 API 当前 `dataDir` 约定一致；
- 在 `env.test.ts` 覆盖缺省/显式值。

API `agent.worker-manager.ts` 已继承 parent env；仍应在 spawn env 测试中确认 `AWB_DATA_DIR` 被保留，不需要新增附件绝对路径变量。

### Storage

必须新增可注入的 Worker attachment storage 端口及本地实现：

```text
apps/agent-worker/src/runtime/agentAttachmentStorage.ts
apps/agent-worker/src/runtime/agentAttachmentStorage.test.ts
```

接口：

```ts
export type AgentAttachmentStorage = {
  read(input: {
    workspaceId: string;
    attachmentId: string;
    mediaType: AgentImageMediaType;
  }): Promise<{
    bytes: Uint8Array;
    mediaType: AgentImageMediaType;
  }>;
};
```

V1 已裁决为**不允许** API Prompt contract 或 Worker storage 端口传 `storageKey`。API 是附件元数据、关系和 Prompt 授权投影的唯一事实来源；只有 API 根据关系表、Run 与 `triggerItemId` 生成的引用才能到达 Worker。Worker 不查 SQLite、不调用内部附件 HTTP，也不自行执行数据库授权。

Worker 只能收到 `workspaceId + attachmentId + mediaType`；`filename` 由 Runner 从 Prompt ref 取出，仅用于 Provider file part。Storage 按固定 `storageKey === attachmentId` 规则，使用 `dataDir` 与统一安全路径 helper 受控定位；API 写入时必须强制二者相等。`expectedByteSize` 不进入 Prompt contract，Worker 必须以 `stat` 结果独立执行 `1..10 MiB` 校验，并重新检测文件签名与 mediaType 一致性。

这样满足：

- 内部 Prompt 只传 attachment 引用；
- 不需要 Worker 直连 SQLite；
- 不需要 Worker 调用内部附件 HTTP；
- 不传绝对路径或 storageKey；
- V1 文件定位可由共享 dataDir 完成。

未来 storageKey 与 attachmentId 解耦或对象存储时，必须另行更新设计；内部附件读取 API/元数据查询都不属于 V1，当前实现不得预留双路径运行分支。

### Runner 物化

必须新增与下列能力等价的纯函数/协作者；符号名可按现有命名习惯调整：

```ts
materializePromptMessageAttachments(messages, storage)
```

输出 AI SDK 可接受的 messages，保留 string/text/tool-call/tool-result，替换 attachment ref 为 file part。任一引用物化或读取失败必须在调用 `streamText()` 前抛出本地确定性、不可重试错误；不得丢 part，不得进入模型请求自动重试。V1 不要求公共专用 error code，但内部错误类别和日志必须可诊断且不泄露绝对路径。

## 路径和文件名实体

### Attachment ID

使用 `newId("att")`，当前工具生成 `att_<uuid>`。路径 helper 必须再次校验固定安全模式，例如：

```text
^att_[A-Za-z0-9-]+$
```

不得只因 ID 来自 DB 就跳过路径校验。

### 展示文件名

清理规则必须固定：

- 只保留 basename；
- 删除 NUL、CR、LF 和其他控制字符；
- trim；
- 空值按检测格式生成 `pasted-image.<ext>`；
- 最大 255 个 Unicode code point，超出截断并保留安全扩展名；
- 不用于物理路径；
- 不进入历史 Prompt/Archive 占位。

## 代码地图

本节列出的 helper、composable 和模块拆分只服务图片消息 V1 的职责隔离与可测试性。实现不得把它们抽象为通用附件平台、媒体处理管道、跨业务模块框架或可插拔资产系统；其他业务模块不得为复用本功能而被迫迁移。

### 前端

| 当前路径/符号 | 当前职责 | 目标改造 |
|---|---|---|
| `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` `<a-textarea>` | 文本输入 | 增加 `@paste` |
| 同文件 `DisplayItem` | 历史展示 View Model | 增加图片附件元数据 |
| 同文件 `displayItems` | Context Item→View Model | 支持 `user_message` |
| 同文件 `onSend()` | JSON 文本发送与命令分流 | 待发送图片、multipart 分支、attempt ID、清理边界 |
| 同文件现有 `<a-modal>` 模式 | 设置/上下文等弹窗 | 新增图片预览 Modal，不加列表 Tooltip |
| `apps/web/src/shared/api/api.ts` `sendAgentMessage()` | JSON 消息 | 保留 |
| 同文件 `uploadWorkspaceFiles()` | FormData 参考 | 参考但不复用业务 |
| 同文件 `downloadWorkspacePath()` | Blob 参考 | 新增 attachment Blob 方法 |
| `agentInputCandidates.ts` / slash helper | 命令识别 | 仅增加本功能所需的带图控制命令阻止测试，不扩展为附件命令框架 |

剪贴板提取、限制校验、FormData 构造和 Blob registry 必须拆到同 feature 下的可单测 helper/composable，`AgentClientPane.vue` 只保留编排；这些单元只服务 Agent 图片消息，不得提升为通用附件平台、媒体管道或跨模块框架。

### Shared

| 路径 | 改造 |
|---|---|
| `packages/shared/src/contracts/agent.ts` | multipart payload、image attachment、`user_message` union |
| `packages/shared/src/index.ts` | 导出新公共类型/schema |
| `packages/shared/src/internal-contracts/agent-api-read.ts` | attachment ref 和明确 Prompt content schema |
| 相关 shared tests | schema 合法/非法矩阵 |

### API 路由与附件模块

| 路径 | 改造 |
|---|---|
| `apps/api/src/modules/agent/routes/agent-public.routes.ts` | JSON/multipart 分流；新增 content GET 或注册附件路由 |
| 新增 `apps/api/src/modules/agent/attachments/*` 或同职责窄模块 | 仅承载 Agent 图片消息 intake、storage paths、签名检测、query/read、temp cleanup；不得泛化为全局附件/媒体模块 |
| `apps/api/src/app/createApp.ts` | 不改全局宽限；测试/文档确认路由级限制 |
| `apps/api/src/modules/workspaces/workspace-files.routes.ts` | 只作为 multipart 流式范式参考 |

### Session/Lifecycle

| 路径/符号 | 改造 |
|---|---|
| `session/session-interaction-application.ts::sendMessage` | 接收 normalized input；单一“文字或图片”校验；保持快速去重 |
| `session/session-interaction-ports.ts::SessionLifecycleStarter` | 增加图片输入 |
| `lifecycle/run-lifecycle-ports.ts` | 扩展 command/activation 类型；不把图片塞 enqueue contract |
| `lifecycle/run-lifecycle-application.ts::startUserRun` | 传递附件；区分提交后 enqueue 失败，不回滚附件 |
| `lifecycle/sqlite-run-lifecycle-persistence.ts::activateUserRun` | 单事务写附件、关系、消息、Run；仅图片标题仍为新会话 |

### Store/DB

| 路径/符号 | 改造 |
|---|---|
| `apps/api/src/infra/db/schema.ts` | 新表、FK、唯一约束、索引 |
| `apps/api/src/modules/agent/agent.store.ts` | 批量 attachment hydration、user output 类型、关系 CRUD/query |
| `parseLegacyOutput()` | 保持旧数据兼容，不承担新附件事实 |
| `encodeStoredColumns()/mapFromStoredColumns()` | user message 文字拆列 + 关系投影 |

### Read-side/Prompt

| 路径/符号 | 改造 |
|---|---|
| `read-side/read-side-application.ts::ReadSideRun` | 加 `triggerItemId` |
| `read-side/prompt-context-projector.ts` | buildMessages 显式传 trigger |
| `read-side/messages-context-projector.ts` | buildMessages 传 null/文本模式 |
| `agent.composition.ts::buildPromptMessagesForSession` | `user_message`、attachment ref、历史占位 |
| `agent.composition.ts::buildArchiveLine` | 图片消息安全占位 |
| `agent.composition.ts` compaction tail filter | 把图片 user message 纳入文本摘录 |
| Run 查询 adapter/composition | 从 `agent_run.trigger_item_id` 填充 ReadSideRun |

### Worker

| 路径/符号 | 改造 |
|---|---|
| `apps/agent-worker/src/config/env.ts` | dataDir |
| `apps/agent-worker/src/main.ts` | 构造 attachmentStorage 并注入 Runner |
| `apps/agent-worker/src/runtime/runner.ts` | Run 进入正常模型执行后在 streamText 前物化，并按每个实际 step 重读；启动附件读取服从 recovery mode |
| `apps/agent-worker/src/runtime/apiClient.ts` | 响应 schema 自动获得 attachment ref 类型；无新 bytes API |
| 新增 `runtime/agentAttachmentStorage.ts` 或同职责文件 | 仅承载 Agent 图片消息的共享 dataDir 安全读取；不查 DB、不调用内部附件 HTTP |
| `runtime/tools/providers/builtin.ts::visual_analyze` | 只作 file part 与安全读取经验参考，不直接复用 Workspace 路径逻辑 |

### 生命周期

| 路径/符号 | 改造 |
|---|---|
| `session/sqlite-session-interaction-store.ts::cloneSession` | 同事务复制关系 |
| `compaction/compaction-archive-application.ts` | 依赖更新后的安全 Archive 文本；不删除附件 |
| `session/session-interaction-application.ts::revert` | 无附件删除；补测试 |
| `workspaces/workspace.service.ts::deleteWorkspace` | 事务删 attachment 记录，提交后删附件目录 |

## 预计新增测试文件

实现必须新增等价覆盖的测试文件；若文件名调整，验证命令必须同步更新：

```text
packages/shared/tests/agent-image-message.test.ts
apps/api/src/modules/agent/attachments/agent-attachment-intake.test.ts
apps/api/src/modules/agent/attachments/agent-attachment-storage.test.ts
apps/api/src/modules/agent/integration/agent-image-message.integration.test.ts
apps/agent-worker/src/runtime/agentAttachmentStorage.test.ts
apps/agent-worker/src/runtime/runner.image-message.test.ts
apps/web/src/features/workspace/tools/agent/agentImageAttachments.test.ts
```

具体测试可合入已有文件，但必须保持职责可定位，并覆盖 [06-testing-acceptance.md](./06-testing-acceptance.md) 的矩阵。
