# 产品与外部行为合同

返回 [README](./README.md)。本文件定义用户可观察行为、请求合同、错误矩阵、历史回显和预览语义。实现、测试和审查必须以本文件为准。

## 输入区合同

### 图片粘贴

当主 Agent 会话的输入框获得 `paste` 事件时：

- 前端必须从 `ClipboardEvent.clipboardData.items` 和兼容的 `files` 路径提取图片 `File`。
- 支持的前端候选类型必须限制为 PNG、JPEG、WebP；服务端仍是最终权威。
- 图片必须只进入浏览器内存中的待发送状态，不得发起上传、预签名、附件创建或探测请求。
- 普通文本粘贴必须保持现有行为。
- 同一次粘贴同时包含普通文本与图片时，必须保留文本粘贴结果，并加入图片；不得因为处理图片而吞掉文本。
- 页面刷新、关闭工具页或组件卸载后，未发送图片可以丢失；V1 不承诺草稿附件恢复。

### 待发送条目

每张待发送图片必须至少展示：

- 图片 icon；
- 展示文件名；
- 文件大小；
- 移除操作。

发送前不得为待发送条目创建服务端附件 ID。前端可以使用随机或单调本地 `localId` 管理列表，但该 ID 不得进入请求合同。

V1 不要求发送前缩略图或大图预览。若实现者选择生成本地 Blob URL 作为视觉增强，必须在移除、发送成功和组件卸载时释放；该增强不得改变“粘贴时零网络请求”的合同。

### 移除

- 用户点击移除后，图片必须立即从待发送集合删除。
- 移除不得产生后端请求。
- 移除最后一张图片后，如果文字也为空，发送按钮必须不可用。
- 发送请求已经开始后，待发送集合必须冻结，直到该请求结束；用户不得改变正在上传请求的文件集合。

### 发送按钮

发送条件为：

```text
trim(text) 非空，或者 pendingImages.length > 0
```

Subtask 会话继续只读，不得因为图片能力而允许用户发送消息。

## 斜杠命令与 Prompt Command

当前输入框支持 `/compact`、`/clear` 等控制命令，以及可展开为 Prompt 文本的自定义 Prompt Command。V1 必须明确以下行为：

- 如果待发送图片非空，输入 `/compact` 或 `/clear` 不得执行控制命令。
- 前端必须提示用户先移除图片或发送普通图片消息；待发送图片和文字草稿保持不变。
- 该限制防止图片在控制命令成功后被静默丢弃。
- 自定义 Prompt Command 如果会展开为普通 Prompt 文本，可以与图片一起发送；展开后的文本必须进入 multipart `payload.text`。
- 未命中的 `/name` 仍按普通文本处理，可以与图片一起发送。

## 请求合同

### 路径与 Content-Type

统一路径：

```http
POST /api/agent/sessions/:sessionId/messages
```

| Content-Type | 场景 | 合同 |
|---|---|---|
| `application/json` | 没有待发送图片 | 保持现有 `AgentSendMessageRequestSchema`，`text` 必填且非空 |
| `multipart/form-data` | 至少一张待发送图片 | 新增 multipart payload schema，`text` 可选或为空 |

除上述两类外的 Content-Type 必须返回 `415 Unsupported Media Type`，不得创建消息、Run 或附件。缺失/非法 multipart boundary 属于非法 multipart 请求，返回 `400` 并清理已创建 temp。

不得新增 `/messages-with-files` 等第二套发送语义。

### JSON 请求

现有请求保持兼容：

```json
{
  "workspaceId": "workspace-id",
  "text": "请分析这个问题",
  "clientRequestId": "req-id",
  "agentId": "agent-id",
  "uiLocale": "zh-CN"
}
```

- `text` 必须继续由 Shared schema 强制 `minLength: 1`。
- 服务端仍会使用 `trim()` 后的非空文本作为消息语义。
- 不得为了仅图片消息把现有 JSON `text` 改为可选。

### Multipart 请求

表单字段固定为：

| 字段 | 类型 | 数量 | 约束 |
|---|---|---:|---|
| `payload` | 普通字段，内容为 JSON string | 恰好 1 | 必须通过 Shared multipart payload schema |
| `images` | 文件字段 | 1 至 4 | 每个必须是非空合法图片 |

`payload` 示例：

```json
{
  "workspaceId": "workspace-id",
  "text": "请分析这些截图",
  "clientRequestId": "req-id",
  "agentId": "agent-id",
  "uiLocale": "zh-CN"
}
```

合同要求：

- multipart `text` 可以缺失、空字符串或只含空白；应用层统一规范化为字符串。
- 允许仅图片消息。
- 表单 part 顺序不构成合同。服务端不得要求 `payload` 先于 `images`。
- 重复 `payload` 必须拒绝。
- 未知普通字段必须拒绝。
- 除 `images` 外的未知文件字段必须拒绝。
- 0 字节文件必须拒绝。
- 请求结束后没有 `payload` 必须拒绝。
- 请求结束后没有任何 `images` 文件 part 必须拒绝，即使 `payload.text` 非空；纯文本消息必须使用 JSON。
- 存在 `images` part 但没有任何图片通过完整校验时，必须拒绝。
- 浏览器不得手动设置 multipart boundary。

### 统一业务校验

JSON 和 multipart 在路由层必须转换为同一个内部输入：

```ts
NormalizedAgentUserMessageInput
```

唯一业务校验必须执行：

```text
trim(text) 非空，或者 images.length > 0
```

应用层不得接收 Fastify request、multipart part 或 Node stream。

## 图片限制合同

| 限制 | V1 固定值 |
|---|---:|
| 格式 | PNG、JPEG、WebP |
| 数量 | 最多 4 张 |
| 单张大小 | 最多 10 MiB |
| 总大小 | 最多 20 MiB |
| 0 字节 | 拒绝 |
| SVG | 拒绝 |
| 文件签名 | 必须服务端校验 |
| 像素/边长 | V1 不校验 |

- 前端应镜像数量、大小和声明类型限制，用于即时反馈。
- 服务端必须独立计数并流式执行限制，不能相信前端结果。
- 服务端不得只依据文件名扩展名或 multipart `mimetype`。
- JPEG 必须识别标准 SOI 签名；PNG 必须识别完整 PNG 文件签名；WebP 必须同时检查 RIFF 与 WEBP 标记。
- 声明 MIME、扩展名与实际签名不一致时，以实际签名判定；若实际签名不是白名单格式，必须拒绝。
- 服务端检测出的实际 `mediaType` 是持久化和响应的权威值。

## 发送与草稿状态合同

### 服务端接受前失败

包括：

- multipart 格式错误；
- payload schema 错误；
- 未知/重复字段；
- 图片数量、单张大小、总大小超限；
- 文件签名非法；
- Session/Workspace/Agent 校验失败；
- Session 正在运行；
- 数据库激活事务失败；
- 请求未成功返回且服务端没有提交消息。

前端必须：

- 保留文字草稿；
- 保留待发送图片；
- 结束 `sending` 状态；
- 显示错误；
- 允许用户修正后再次发送。

### 消息已接受

当发送 API 返回成功结果时：

- 前端必须清空文字和待发送图片；
- 必须进入现有 follow-bottom 与轮询流程；
- 图片消息必须已经具有持久化附件关系；
- 后续 Provider 结果不影响草稿清理。

### Enqueue 或 Provider 失败

现有生命周期可能在数据库提交后、runtime enqueue 时失败，或者 Worker 已开始后 Provider 失败。目标合同为：

- 用户消息和附件必须保留；
- Run/Assistant 按现有生命周期进入失败状态；
- 不得删除附件或回滚用户 Context Item；
- 前端不得自动恢复已发送草稿；
- 用户通过历史消息确认自己发送的文字和图片；
- V1 沿用现有错误展示，不承诺把所有 Provider 图片错误统一为专用文案。

如果发送 HTTP 请求因 enqueue 失败而返回错误，但消息实际上已提交，前端仍会暂时保留本地草稿。用户以同一 `clientRequestId` 进行网络级重试时必须命中现有去重结果；UI 实现不得在一次全新手动发送中复用旧 ID。

## `clientRequestId` 合同

V1 保持现有幂等语义：

- 每次新的用户发送必须生成新的 `clientRequestId`。
- 同一次请求的网络重试必须复用原 ID 和原始文件集合。
- 同 workspace、session、`clientRequestId` 命中已有记录时，服务端返回第一次的 `messageItemId`、`runId`，并设置 `deduplicated: true`。
- Multipart 去重发生前已经接收的本次临时文件必须删除。
- V1 不计算请求指纹，不验证相同 ID 的文字或图片是否一致。
- 同 key 不同内容仍返回第一次结果是明确接受的限制；前端必须保证正常路径不会错误复用 ID。

成功响应保持：

```ts
{
  sessionId: string;
  messageItemId: number;
  runId: string;
  deduplicated: boolean;
}
```

## 仅图片消息合同

- multipart 请求允许空文字和至少一张合法图片。
- 持久化用户消息文字为规范化后的空字符串。
- 首条仅图片消息的会话标题必须沿用当前空文本回退：`新会话`。
- 不得新增 `图片消息` 等特殊标题。
- 原始 Run 的 user content 必须包含固定文本 part 与图片 parts，避免构造空文本语义。固定文本为：

```text
[The user sent N image attachment(s) without accompanying text.]
```

- 后续 Run 中该历史消息只投影历史固定占位，不再使用上面的原始 Run 提示。

## 原始 Run 与后续 Run 合同

### 原始 Run

唯一权威判断：

```text
contextItem.id === agentRun.triggerItemId
```

如果 trigger item 关联图片：

- 原始文字非空时，先放一个 text part；
- 原始文字为空时，先放仅图片固定 text part；
- 再按 `position` 顺序放全部 attachment refs；
- Worker 按引用读取 bytes 并转换为 AI SDK file parts；
- 不得静默跳过读取失败的图片或丢弃 part。

在一个正在执行的原始 Run 内，每个实际模型 step 与同一 Run 内部自动重试始终使用同一 trigger item 关系集合。V1 可以在每个实际模型 step 重新读取文件，不建立运行级图片 bytes 缓存。这里的“始终”只约束正常执行和同一 Run 内部自动重试，不得解释为所有启动恢复模式都必须读取附件。

启动恢复必须服从现有 `agentStartupRecoveryMode`：

- `recover`：仅当现有启动恢复流程决定继续该 Run 时，才保留同一 `runId`，并通过该 Run 的 `triggerItemId` 重新取得相同附件集合；
- `fail`：按现有 fail-existing-runs 语义把未完成 Run 收尾为失败，不构建图片 Prompt，不调用 Worker storage，也不读取附件文件；
- 除上述 `recover` 条件成立外，启动恢复不得触发附件关系投影、物化或本地读取。

附件引用物化、路径校验或本地文件读取失败属于本地确定性、不可重试错误：

- `streamText()` 不得被调用；
- 不得进入模型请求自动重试；
- 必须直接走现有 Assistant/Run failed 收尾；
- V1 不要求新增公共专用 error code，但日志或内部错误分类必须可诊断，且不得包含绝对路径、bytes 或 Base64。

### 后续 Run

历史带图 user 消息必须投影为同一条 user 消息中的文本，不得另起 system 消息。

固定英文占位：

```text
[This user message included N image attachment(s). Their image contents are not included in this run.]
```

规则：

- 原文字非空：`原文字 + 两个换行 + 占位`；
- 原文字为空：只使用占位；
- `N` 使用关系表中的附件数量；
- 占位不得包含文件名、attachmentId、hash、storage key、路径或动态 Provider 信息；
- 不随 `uiLocale` 改变；
- `MessagesContextProjector` 等没有当前 `triggerItemId` 的文本型上下文投影，所有带图消息都必须使用历史占位，绝不能输出 attachment ref。

## 模型能力与错误合同

- V1 不维护 Provider/模型视觉能力配置。
- 前端不得根据模型 ID 阻止图片发送。
- API 不得发送前调用 Provider 探测能力。
- Provider 不支持图片时可以返回错误。
- V1 不建设跨 Provider 文本匹配知识库，不新增必须稳定识别的图片专用错误码。
- Provider 请求已经开始后的现有有限重试机制保持；本地附件物化/读取失败不属于 Provider 错误，必须在调用 `streamText()` 前终止且不可重试。
- 如果现有 SDK/Provider 暴露明显不可重试的结构化错误，实现可以使用已有通用机制处理，但不得把不可靠文本推断持久化为模型能力事实。

## 历史列表合同

历史带图用户消息默认显示：

```text
[图片 icon] N 张图片
```

必须满足：

- 列表响应只包含附件元数据，不包含 bytes、Base64 或 data URL；
- 初次渲染不创建 `<img>`；
- 初次渲染不请求附件内容接口；
- 图片入口不使用 Tooltip；
- 不因附件数量增加多个 hover 组件；
- 点击入口打开预览 Modal；
- 文字消息原有截断、展开、Fork、Revert 等控制不被破坏。

## 图片预览合同

### 内容接口

V1 公共读取路径固定为：

```http
GET /api/agent/attachments/:attachmentId/content
```

必须：

- 未通过现有主 API 认证时，由全局 auth guard 返回 401；附件路由不得把认证失败改写为 404；
- 通过附件→Context Item→Session→Workspace 关系验证附件属于可访问 Agent 消息；
- 已认证后，attachment 不存在、无 Context Item 关系、Workspace/Session 关系不匹配或物理文件缺失时统一返回 404，不泄露存在性差异；
- 返回服务端检测并持久化的受控 `Content-Type`；
- 返回精确的 `Content-Disposition: inline`，不得在该响应头中回显文件名；
- 返回 `X-Content-Type-Options: nosniff`；
- 返回 `Cache-Control: private, no-store`；
- 不返回真实存储路径；
- 不重定向到公开 URL；
- 不接受 workspace path、storage key 或 filename 作为定位参数。

缓存策略在 V1 固定为 `private, no-store`。即使同一 Modal 生命周期内前端可以复用已取得的 Blob URL，浏览器/代理不得把鉴权图片响应作为可复用缓存资产。未来若有带宽证据，需要改为私有缓存，必须单独评审 ETag、权限和删除语义。

### Modal 行为

- 打开 Modal 后只加载当前图片；默认当前图片为 `position` 最小的一张。
- 用户切换到下一张时才请求该图片。
- Modal 生命周期内可以缓存已加载 Blob，避免来回切换重复请求。
- 关闭 Modal或组件卸载时必须释放全部 Blob URL。
- 单张加载失败必须显示该图片不可用，不得关闭整个历史消息或删除附件入口。
- Modal 必须按消息显示一次说明：

```text
图片仅在发送该消息时提供给模型，后续对话不会自动重新附带。如需模型再次查看，请重新发送图片。
```

- 说明不得放到会话列表 Tooltip。

## 生命周期外部语义

| 操作 | 历史列表 | 模型后续可见性 | 附件物理处理 |
|---|---|---|---|
| Provider 失败 | 保留 icon/数量，可预览 | 后续只占位 | 不删除 |
| Cancel | 保留 | 后续只占位 | 不删除 |
| Clear | 归档历史仍可回显 | 不传图片 | 不删除 |
| Compaction | 归档历史仍可回显 | Summary/Archive 只含文本占位 | 不删除 |
| Archive | 可回显 | 不传图片 | 不删除 |
| Revert | 未删除分支数据仍保留 | 新 Run 中图片只占位 | 不删除 |
| Fork | 新 Session 中复制附件关系 | Fork 后新 Run 中图片只占位 | 共享不可变二进制 |
| Workspace 删除 | Workspace 不再可见 | 不适用 | 显式删记录，best-effort 删目录 |

## 错误矩阵

| 场景 | HTTP/运行结果 | 是否创建消息 | 是否保留前端草稿 | 是否保留附件 |
|---|---|---:|---:|---:|
| JSON 文字为空 | 400 | 否 | 是 | 不适用 |
| 不支持的 Content-Type | 415 | 否 | 是 | 不适用 |
| multipart 缺 payload | 400 | 否 | 是 | 临时文件清理 |
| 重复 payload | 400 | 否 | 是 | 临时文件清理 |
| 未知字段/文件字段 | 400 | 否 | 是 | 临时文件清理 |
| 无文字且无图片 | 400 | 否 | 是 | 不适用 |
| multipart 有文字但无 images part | 400 | 否 | 是 | 不适用 |
| 图片数量超过 4 | 400 | 否 | 是 | 临时文件清理 |
| 单图超过 10 MiB | 400 | 否 | 是 | 临时文件清理 |
| 总量超过 20 MiB | 400 | 否 | 是 | 临时文件清理 |
| 0 字节或签名非法 | 400 | 否 | 是 | 临时文件清理 |
| Workspace/Session 不匹配 | 400/404 | 否 | 是 | 临时文件清理 |
| Session running | 409 | 否 | 是 | 临时文件清理 |
| 相同 clientRequestId 命中 | 201 + deduplicated | 不重复创建 | 成功后清空 | 本次 temp 清理，首次附件保留 |
| DB 事务失败 | 5xx | 否 | 是 | 补偿删除/临时清理 |
| enqueue 失败 | 现有错误 | 已创建 | 是或由去重重试收敛 | 保留 |
| Worker 附件物化/读取失败 | Run failed；本地确定性、不可重试；不调用 streamText | 已创建 | 已清空 | 保留记录，不静默忽略 |
| Provider 不支持图片 | Run failed | 已创建 | 已清空 | 保留 |
| 预览未通过主 API 认证 | 401（全局 guard） | 不适用 | 不适用 | 不修改 |
| 已认证但附件/关系/Workspace/Session 不匹配 | 404 | 已存在与否不泄露 | 不适用 | 不修改 |
| 预览物理文件丢失 | 404 | 是 | 不适用 | 保留元数据供诊断/后续清理 |
