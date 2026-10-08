# Agent 图片消息能力

> 状态：设计定稿，待实施。
> 适用范围：Agent 主会话输入框粘贴 PNG/JPEG/WebP 图片、发送时上传、原始 Run 多模态输入、历史消息附件回显与按需预览。
> 基线：本文档以当前仓库源码为依据；代码位置以**文件路径 + 符号/职责**为准，行号只用于辅助检索，不构成实现依赖。

## 文档目的

本目录是一套可直接用于开发、独立代码审查和验收的规范。它解决的核心问题是：用户需要把截图、报错界面、设计稿或其他图片与文字一起交给当前 Agent 分析，同时不应在粘贴阶段产生无效上传，也不应让历史会话列表自动下载图片或让旧图片在后续 Run 中反复进入模型请求。

本方案把“历史可回显”和“模型当前可见”明确分离：附件作为消息数据被持久化并可在前端按需预览；图片二进制只提供给创建该图片消息的原始 Run，后续 Run 只看到原文字与固定占位。

## 快速结论

- 用户在输入框中粘贴图片时，图片只保存在浏览器内存中，不上传；发送前可移除，页面刷新后丢失未发送图片属于 V1 接受行为。
- 含图片消息继续使用 `POST /api/agent/sessions/:sessionId/messages`，但请求为 `multipart/form-data`；纯文本消息继续使用现有 `application/json` 契约。
- JSON 请求继续要求 `text` 非空；multipart payload 允许 `text` 缺失或为空，但 multipart 请求必须包含 1 至 4 张合法图片。两种传输格式进入应用层后，必须在唯一业务校验处执行“非空文字或至少一张合法图片”，防止内部调用绕过路由约束。
- 历史消息列表只显示图片 icon 与数量，不创建 `<img>`、不请求二进制、不使用 Tooltip。点击后打开预览 Modal，再逐张请求 Blob。
- 预览 Modal 必须显示：`图片仅在发送该消息时提供给模型，后续对话不会自动重新附带。如需模型再次查看，请重新发送图片。`
- V1 不配置或预判模型视觉能力；由 Provider 决定是否接受图片。消息已被接受后，Provider 失败不得删除用户消息或附件。
- 图片二进制只进入 `agent_run.trigger_item_id` 对应的原始 Run。`ReadSideRun`、`PromptContextProjector` 与消息构建链路必须显式传递 `triggerItemId`，不得通过“最后一条消息”等隐式规则推断。
- 后续 Run 中，历史带图 user 消息投影为原文字加固定英文占位：`[This user message included N image attachment(s). Their image contents are not included in this run.]`；仅图片历史消息只保留占位。
- 在一个正在执行的原始 Run 内，每个实际模型 step 与同一 Run 内部自动重试始终使用同一 trigger item 附件集合；这条无条件规则不包含启动恢复。启动时，只有 `agentStartupRecoveryMode=recover` 且现有恢复流程继续同一 `runId`，才通过 `triggerItemId` 重新取得相同附件集合；`agentStartupRecoveryMode=fail` 必须按现有失败语义结束，且不得构建附件 Prompt、调用 Worker storage 或读取附件文件。
- 附件写入 `AWB_DATA_DIR` 派生的独立目录，不写入 Workspace。V1 的硬前提是 API 和 Worker 共享同一个持久化 `AWB_DATA_DIR`。
- API 是附件元数据、关系和 Prompt 授权投影的唯一事实来源。API→Worker 内部合同只传 `workspaceId` 上下文与 `attachmentId/mediaType/filename` 引用，不传 `storageKey`、绝对路径、Base64 或图片 bytes。
- Worker 不查 SQLite、不调用内部附件 HTTP；可注入 `attachmentStorage` 使用 `dataDir`、统一安全路径 helper 和 `storageKey === attachmentId` 规则定位，并只负责路径、普通文件、symlink/越界、大小及媒体类型完整性校验。
- 附件引用物化或本地文件读取失败属于本地确定性、不可重试错误：不得调用 `streamText()`，不得进入模型请求自动重试，必须直接走现有 Assistant/Run failed 收尾；不得静默丢弃 part。
- `agent_attachment` 与 `agent_context_item_attachment` 是附件与消息关联的唯一事实来源；不得在 `output_json` 中重复保存附件 ID 列表。
- 旧 `user_text` 完整兼容；新的纯文本消息仍写 `user_text`；只有带图片消息使用 `user_message` 公共投影。
- V1 白名单固定为 PNG、JPEG、WebP；最多 4 张；单张最多 10 MiB；总计最多 20 MiB；服务端必须校验文件签名并拒绝 SVG。
- V1 不解析像素和边长、不新增请求指纹、不建设专用跨 Provider 视觉错误知识库、不建设复杂 GC/状态机/ref_count。
- V1 沿用现有 `clientRequestId` 语义：同 key 返回第一次结果；前端新发送使用新 ID，网络重试复用原 ID。相同 ID 内容一致性不校验是明确接受的限制。

## 阅读路径

| 文档 | 用途 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、业务目标、用户流程、范围、非目标、术语与当前基线 |
| [02-product-contract.md](./02-product-contract.md) | 粘贴、移除、发送、错误、历史回显、预览和仅图片消息的外部行为合同 |
| [03-decisions.md](./03-decisions.md) | 关键决策、替代方案、指挥官意图对齐、取舍、已接受限制与风险 |
| [04-technical-design.md](./04-technical-design.md) | 架构、时序、multipart、事务、存储、Prompt、Worker、清理和安全设计 |
| [05-entity-and-code-map.md](./05-entity-and-code-map.md) | Shared 契约、DB 实体、内部类型、代码地图和预计改动文件 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、失败注入、验收标准、安全检查和代码审查清单 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 依赖顺序、实施批次、详细步骤、验证命令、完成定义和回滚点 |

## 规范性用语

- “必须”对应 `MUST`，是开发、代码审查和验收的强制要求。
- “不得”对应 `MUST NOT`，违反即视为方案未实现。
- “应该”对应 `SHOULD`，只有本文已经说明的兼容或平台原因才可偏离，并必须在代码审查中解释。
- “可以”对应 `MAY`，是不改变外部合同与技术不变量的实现自由。
- “当前实现”描述文档编写时的源码事实；“目标设计”描述开发完成后必须达到的状态。

发生冲突时，按以下优先级解释：

- 用户已经确认的产品行为与本 README 的核心不变量；
- [02-product-contract.md](./02-product-contract.md) 的外部行为合同；
- [04-technical-design.md](./04-technical-design.md) 的技术不变量、事务和安全边界；
- [06-testing-acceptance.md](./06-testing-acceptance.md) 的可验证标准；
- [03-decisions.md](./03-decisions.md) 的动机、限制与风险说明；
- [07-implementation-plan.md](./07-implementation-plan.md) 的实施顺序。

任何实现若需要突破产品合同或技术不变量，必须先更新本设计并重新评审，不得以实现方便为由隐式改变边界。

## 核心不变量

- 粘贴阶段不得产生附件上传请求。
- 含图片消息只能在用户点击发送时上传；发送前移除不得产生后端调用。
- 纯文本 JSON 请求的既有 `text` 必填契约不得被削弱。
- 应用层不得感知 Fastify multipart part 或流对象；HTTP 路由必须先规范化输入。
- Multipart 传输只用于带图消息；即使 `payload.text` 非空，没有 `images` 文件 part 的 multipart 请求也必须拒绝，纯文本必须走 JSON。
- 路由不得依赖 `payload` 与 `images` part 的出现顺序。
- 只有 `triggerItemId` 对应的用户消息可以在该 Run 的 Prompt 中产生附件引用；其他带图用户消息必须降级为固定占位。
- 历史占位、Archive 和 Compaction 文本不得包含文件名、附件 ID、哈希、存储键或物理路径。
- Compaction 模型不得接收图片二进制或附件引用。
- 附件元数据与消息关系的唯一事实来源必须是关系表；公共输出中的附件列表必须由关系查询投影。
- Worker 不得查询 SQLite 或调用内部附件 HTTP；只有 API Prompt 投影确认的 trigger item 才能产生附件引用，Worker 不自行执行数据库授权。
- 公共附件内容接口未通过现有主 API 认证时必须由全局 guard 返回 401；通过认证后，附件不存在、无关联、Workspace/Session 关系不匹配或物理文件缺失必须统一返回 404。
- 附件不得写入 Workspace，不得通过公共 API 暴露裸文件路径或永久公开 URL。
- 浏览器历史列表初次渲染不得请求图片内容；说明文案只允许出现在图片预览中，不得给列表入口增加 Tooltip。
- Provider 失败、Worker 模型调用失败、用户取消或后续会话操作不得删除已接受消息的附件。
- Fork 必须在复制 Context Item 的同一事务内复制附件关系；二进制共享且不可变。
- Clear、Compaction、Archive、Revert 不得删除附件。
- V1 不得擅自增加模型视觉能力配置、历史图片自动重放、缩略图、像素解析、请求指纹或复杂附件生命周期框架。
