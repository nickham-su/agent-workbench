# 需求背景与范围

返回 [README](./README.md)。本文件说明业务问题、目标、角色、用户链路、范围边界、术语和当前代码基线。

## 背景

Agent Workbench 当前的主会话发送链路以纯文本为中心：

```text
AgentClientPane textarea
  -> sendAgentMessage(JSON)
  -> POST /api/agent/sessions/:sessionId/messages
  -> SessionInteractionApplication.sendMessage()
  -> RunLifecycleApplication.startUserRun()
  -> SqliteRunLifecyclePersistence.activateUserRun()
  -> user_text Context Item
  -> agent_run.trigger_item_id
  -> Worker 获取 Prompt Context
  -> streamText({ messages })
```

这条链路可以可靠处理代码、命令和自然语言，但用户在开发过程中经常需要提供非文本信息，例如：

- 浏览器或桌面应用的报错截图；
- UI 实现效果与设计稿；
- 布局、颜色、像素错位等视觉问题；
- 无法方便复制的终端、日志或第三方工具界面；
- 多张按顺序对比的截图。

如果只能先把图片写入 Workspace，再要求 Agent 调用 `visual_analyze`，用户需要额外保存文件、选择路径和描述工具调用，且会污染项目目录。用户期望的是聊天输入中的自然动作：粘贴图片、必要时移除、与文字一起发送。

项目已经具备可复用的模型层基础。`apps/agent-worker/src/runtime/tools/providers/builtin.ts` 中的 `visual_analyze` 会读取图片 bytes，并构造 AI SDK `{ type: "file", data, mediaType, filename }` part。这证明当前 SDK 和至少部分 Provider 适配链路可以接收图片。本功能的主要工作不是重新建设视觉调用体系，而是让图片安全、明确地贯穿输入、消息、附件、Prompt 和历史 UI。

## 业务目标

用户应能完成以下闭环：

```text
用户复制一张或多张图片
  -> 在 Agent 输入框粘贴
  -> 图片仅进入浏览器本地待发送状态
  -> 用户可移除不需要的图片
  -> 用户点击发送
  -> 文字与图片一次提交并持久化
  -> 创建该消息的原始 Run 将图片交给当前 Provider
  -> 历史消息显示图片 icon 与数量
  -> 用户点击后逐张懒加载预览
```

业务目标包括：

- 降低把截图交给 Agent 分析的操作成本；
- 避免粘贴但未发送造成的无效上传；
- 保持用户在发送前对待发送图片的控制；
- 保持现有纯文本发送行为和接口兼容；
- 历史会话初次加载不产生图片流量；
- 图片失败不破坏用户消息和会话状态；
- 在当前自托管、单 API/Worker 数据目录模型下选择简单、可维护方案；
- 给开发、独立审查和 QA 提供可执行的边界与标准。

## 用户角色

### AWB 用户

- 在主 Agent 会话输入框粘贴图片；
- 在发送前检查并移除待发送图片；
- 可以发送文字加图片，也可以只发送图片；
- 在历史消息中主动打开图片预览；
- 接受图片只在发送该消息时提供给模型；
- 如需模型再次查看历史图片，需要重新粘贴并发送。

### AI Agent / 当前模型

- 在原始 Run 中按用户粘贴顺序收到文字和全部图片；
- 后续 Run 中只收到历史消息原文和固定图片占位；
- 不获得附件存储路径、附件 ID、哈希或文件名等内部元数据；
- 若当前 Provider 不支持图片，可以失败，但不得导致图片消息被删除。

### 部署者

- 必须保证 API 和 agent-worker 共享同一个持久化 `AWB_DATA_DIR`；
- 接受 V1 Worker 不查询 SQLite、不调用内部附件 HTTP，只通过 dataDir 和固定 `storageKey === attachmentId` 路径规则读取；
- 必须把该数据目录纳入现有备份、权限和容量管理；
- 接受 V1 不支持 API 与 Worker 跨主机且不共享附件存储的部署；
- 可根据实际故障证据决定未来是否引入对象存储或内部附件读取接口。

### 开发与审查人员

- 以 Shared contract、事务边界和 `triggerItemId` 作为权威；
- 不得把附件 ID 列表复制到多个持久化来源；
- 不得为实现方便恢复历史图片自动重放；
- 必须验证列表懒加载、安全读取、失败补偿和旧数据兼容。

## 用户流程

### 粘贴与编辑

```text
ClipboardEvent
  -> 检测 image/* 文件
  -> 前端镜像校验数量/大小/声明类型
  -> PendingImage[]
  -> 显示待发送图片条目
  -> 用户可移除
```

该阶段不调用任何上传或附件 API。普通文本粘贴仍使用浏览器默认行为；如果一次剪贴板事件同时包含图片和可粘贴文本，前端必须保留文本粘贴语义，并把图片加入待发送状态，不得为拦截图片而丢失文本。

### 发送

```text
无待发送图片
  -> 现有 JSON 请求

有待发送图片
  -> FormData(payload + images*)
  -> 同一路径 multipart POST
  -> 路由流式写临时文件并校验
  -> 统一 NormalizedAgentUserMessageInput
  -> 单一业务校验
  -> 事务创建消息、附件关系与 Run
```

### 模型调用

```text
Prompt Context for runId
  -> ReadSideRun.triggerItemId
  -> trigger item 带图：输出 attachment_ref
  -> 其他历史带图消息：输出原文 + 固定占位
  -> Worker attachmentStorage 使用 dataDir + 安全路径 helper 读取
  -> AI SDK file parts
```

API 是附件元数据、关系和 Prompt 授权投影的唯一事实来源；Worker 只消费 API 生成的引用并校验物理文件完整性，不自行查询数据库授权。

### 历史回显

```text
会话消息列表
  -> 公共 read projection 返回附件元数据
  -> 仅显示 icon + N 张图片
  -> 不创建 img，不请求内容
  -> 点击后打开 Modal
  -> 请求当前图片 Blob
  -> URL.createObjectURL()
  -> 切换时按需加载下一张
  -> 关闭时 revokeObjectURL()
```

## 产品范围

### V1 范围内

- 主 Agent 会话输入框粘贴 PNG、JPEG、WebP；
- 一条消息最多 4 张图片；
- 单张最多 10 MiB，总计最多 20 MiB；
- 粘贴后浏览器本地暂存；
- 发送前移除；
- 文字加图片；
- 仅图片消息；
- 发送时 multipart 上传；
- 图片签名服务端校验；
- 独立附件元数据、关系和物理存储；
- 原始 Run 图片输入；
- 后续 Run 固定占位；
- 历史 icon、数量、Modal、Blob 逐张懒加载；
- Fork 关系复制；
- Clear、Compaction、Archive、Revert 后历史预览仍可用；
- Workspace 删除时清理附件记录和目录；
- 请求临时文件与失败补偿清理；
- 旧 `user_text` 和纯文本 JSON 兼容。

### 明确非目标

- 模型视觉能力配置、前端能力图标或发送前能力预判；
- 跨 Provider 视觉错误知识库；
- 自动切换 `visionModel`；
- 历史图片自动进入后续 Run；
- 从历史消息直接“重新附带给模型”；
- 图片上传进度；
- 拖拽上传、文件选择器或移动端相册选择；
- GIF、SVG、PDF、HEIC、BMP、TIFF、视频或音频；
- 图片压缩、转码、裁剪、OCR、EXIF 清理；
- 服务端缩略图；
- 像素和边长解析；
- 全局附件资产库或跨 Workspace 去重；
- 请求指纹和同 `clientRequestId` 内容冲突检测；
- 复杂附件状态机、手工 ref_count 或完整 GC 调度框架；
- 对象存储、跨节点文件同步或 API/Worker 分布式附件读取；
- 永久公开 URL 或无需鉴权的图片地址。

## 已接受的产品边界

- 页面刷新后，未发送图片会丢失；V1 不持久化草稿附件。
- 历史中能预览图片不代表模型在后续 Run 仍能看到图片。
- 当前 Provider 不支持图片时，原始 Run 可以失败；V1 不在发送前阻止。
- 附件物化或本地读取失败属于确定性、不可重试失败，不会调用 Provider。
- 启动时只有 `agentStartupRecoveryMode=recover` 继续同一 Run 才重新取得附件；`fail` 模式结束 Run 且不读取附件。
- Provider 若有比 AWB 更低的图片数量、大小或分辨率限制，仍可能拒绝请求。
- V1 不解析像素与边长。触发未来扩展的条件是出现高分辨率图片导致的真实资源问题、预览问题或稳定 Provider 拒绝证据。
- 相同 `clientRequestId` 重发不同内容仍返回第一次结果；这是既有幂等合同。只有出现真实客户端复用故障证据时才引入请求指纹和 409 冲突。
- V1 只支持 API 与 Worker 共享 `AWB_DATA_DIR` 的部署。

## 当前代码基线

### 前端

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
  - `<a-textarea>` 当前只有键盘、光标和焦点事件，没有 `paste` 图片处理；
  - `DisplayItem` 当前没有附件字段；
  - `displayItems` 只映射 `user_text`；
  - `onSend()` 当前要求 `draft.trim()` 非空，始终调用 JSON `sendAgentMessage()`；
  - 组件已有多个 `<a-modal>`，可以复用现有 Modal 交互模式。
- `apps/web/src/shared/api/api.ts`
  - `sendAgentMessage()` 当前发送 JSON；
  - `uploadWorkspaceFiles()` 展示了 `FormData` 用法；
  - `downloadWorkspacePath()` 展示了 Axios Blob 响应与错误解析方式。

### Shared contract

- `packages/shared/src/contracts/agent.ts`
  - `AgentSendMessageRequestSchema` 要求 `text` 非空，且拒绝额外字段；
  - `AgentContextItemOutputSchema` 只有 `user_text`、`assistant_text`、`tool`、`system_text`；
  - 公共 `AgentContextItemRecord` 尚无图片附件输出。
- `packages/shared/src/internal-contracts/agent-api-read.ts`
  - Prompt message 的 `content` 当前是 `Type.Any()`；目标实现必须为附件引用建立明确、可验证的 content part。

### API 与持久化

- `apps/api/src/app/createApp.ts`
  - 已注册 `@fastify/multipart`；全局限制为单文件 2 GiB、parts 1,000,000，只是宽松基础设施，不是图片业务安全边界。
- `apps/api/src/modules/workspaces/workspace-files.routes.ts`
  - 已使用 `isMultipart()` 与 `for await (const part of multipartReq.parts())` 流式处理上传，可参考协议范式，但其业务规则不能直接复用。
- `apps/api/src/modules/agent/routes/agent-public.routes.ts`
  - `/messages` 当前只声明 JSON body schema。
- `apps/api/src/modules/agent/session/session-interaction-application.ts`
  - 当前强制 `text.trim()` 非空并按现有 key 快速去重。
- `apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts`
  - 激活后 enqueue 失败会把 Run 标记失败并重新抛错；目标实现必须保留已提交用户消息和附件。
- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`
  - 当前事务创建 `user_text`、`agent_client_request`、`agent_run`；`agent_run.trigger_item_id` 已保存用户消息 ID；空文本标题回退已经是 `新会话`。
- `apps/api/src/modules/agent/agent.store.ts`
  - Context Item 当前主要使用拆分列映射，`output_json` 是兼容字段；目标设计不得把附件 ID 列表塞回 `output_json` 作为第二事实来源。
- `apps/api/src/infra/db/schema.ts`
  - 采用 `create table if not exists`、`ensureColumn()` 和 `createIndexIfNotExists()` 的轻量 schema 演进方式。

### Prompt 与 Worker

- `apps/api/src/modules/agent/read-side/read-side-application.ts`
  - `ReadSideRun` 当前不含 `triggerItemId`。
- `apps/api/src/modules/agent/read-side/prompt-context-projector.ts`
  - 已持有当前 run，但 `buildMessages()` 只收到 workspace/session/locale。
- `apps/api/src/modules/agent/agent.composition.ts`
  - `buildPromptMessagesForSession()` 当前只把 `user_text` 映射为字符串；
  - `buildArchiveLine()` 当前只识别 `user_text`；
  - `MessagesContextProjector` 也复用消息构建，需要明确无当前 Run 时带图消息一律使用占位。
- `apps/agent-worker/src/runtime/runner.ts`
  - 当前 Runner 进入正常模型执行后，每个实际模型 step 都重新请求 Prompt Context；启动时是否进入该流程仍由既有 recovery mode 决定；
  - 当前直接把 `context.messages` 传入 `streamText()`。
- `apps/agent-worker/src/config/env.ts`、`main.ts`
  - 当前 Worker Env 没有 `dataDir`，Runner 也没有 attachment storage 依赖；目标设计需要增加可测试的受控读取能力。
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`
  - `visual_analyze` 已实现安全读取 Workspace 图片并生成 AI SDK file parts，可复用 file part 构造经验，但附件存储不应耦合 Workspace 路径。

### 生命周期

- `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts`
  - Fork 会复制 Context Item 并建立 old/new item ID 映射；目标实现必须在同一事务复制附件关系。
- `apps/api/src/modules/agent/compaction/compaction-archive-application.ts`
  - Clear/Compaction 归档 Context Item，不物理删除消息；因此附件必须继续保留供历史预览。
- `apps/api/src/modules/workspaces/workspace.service.ts`
  - Workspace 删除先事务删 DB，再 best-effort 清理目录；附件应遵循同一模式。

## 术语

| 术语 | 含义 |
|---|---|
| Pending image | 已从剪贴板读取、仅存在浏览器内存、尚未发送的图片 `File` |
| 图片消息 | 至少关联一张图片的用户 Context Item |
| 原始 Run | `agent_run.trigger_item_id` 指向该图片消息的 Run |
| 后续 Run | 不是由该图片消息触发，但其历史中包含该消息的其他 Run |
| Attachment ref | API Prompt Context 发给 Worker 的受控附件引用，不含 bytes 或绝对路径 |
| Attachment storage | Worker 可注入的本地读取端口；V1 使用共享 `AWB_DATA_DIR`、统一安全路径 helper 与 `storageKey === attachmentId`，不查 DB、不走 HTTP |
| 历史占位 | 后续 Run 中替代历史图片二进制的固定英文文本 |
| 公共 read projection | API 返回给 Web 的 Context Item 输出，其中附件元数据由关系表查询投影 |
| 临时文件 | multipart 流式接收期间、消息事务提交前的受控文件 |
| 已接受消息 | 用户 Context Item、附件关系、Run 和幂等记录已在事务中提交的消息 |
