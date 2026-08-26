# 开发任务拆分与实施计划

返回 [README](./README.md)。本文件定义有依赖关系的实施顺序、详细步骤、每批验证、完成定义、审查重点和回滚点。

## 实施原则

- 按小步、可验证、可回滚实施；Shared/DB/安全原语先于 UI happy path。
- 每批必须完成对应测试和独立审查，阻塞问题修复并复审后才能进入下一批。
- 不同时引入模型能力配置、历史图片重放、缩略图、对象存储、请求指纹、像素解析或复杂 GC。
- 不修改现有全局 multipart 2 GiB 配置来替代 Agent 路由级限制。
- 不把附件写入 Workspace，不把绝对路径放进 API/Worker contract。
- helper、composable 和模块拆分只服务 Agent 图片消息 V1 的职责隔离与可测试性；不得抽象为通用附件平台、媒体处理管道、跨模块框架或可插拔资产系统。
- Worker 读取路径唯一：不查 SQLite、不调用内部附件 HTTP，只使用 dataDir、统一安全路径 helper 与 `storageKey === attachmentId` 规则。
- 如果实施发现本文核心合同无法满足，必须暂停并更新设计，不得在代码中静默改变产品语义。
- 当前工作区可能存在其他改动；实施时必须只修改本功能必要文件，不得恢复或覆盖用户修改。

## 任务依赖图

```text
基线冻结
  -> Shared 公共/内部契约
  -> DB schema + 附件关系 Store
  -> API 附件路径/签名/temp intake
  -> Session/Lifecycle 原子激活 + 幂等补偿
  -> Read-side triggerItemId + Prompt/Archive 占位
  -> Worker attachmentStorage + Prompt 物化
  -> 公共附件读取 API
  -> Fork/Workspace 删除/temp 清理
  -> Web 粘贴/发送/历史/预览
  -> 全链路集成、安全、手工验收
```

## 开发前基线复核

### 必查符号

```text
packages/shared/src/contracts/agent.ts:
  AgentSendMessageRequestSchema
  AgentContextItemOutputSchema

packages/shared/src/internal-contracts/agent-api-read.ts:
  AgentApiPromptMessageSchema

apps/api/src/app/createApp.ts:
  multipart plugin limits

apps/api/src/modules/agent/routes/agent-public.routes.ts:
  POST /api/agent/sessions/:sessionId/messages

apps/api/src/modules/agent/session/session-interaction-application.ts:
  sendMessage

apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts:
  startUserRun

apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:
  activateUserRun
  toSessionTitleFromFirstMessage

apps/api/src/modules/agent/agent.store.ts:
  encodeStoredColumns
  mapFromStoredColumns
  appendContextItem
  getSessionVisibleItems / transcript/list readers

apps/api/src/modules/agent/read-side/read-side-application.ts:
  ReadSideRun

apps/api/src/modules/agent/read-side/prompt-context-projector.ts:
  buildMessages

apps/api/src/modules/agent/agent.composition.ts:
  buildPromptMessagesForSession
  buildArchiveLine

apps/agent-worker/src/config/env.ts:
  WorkerEnv / loadWorkerEnv

apps/agent-worker/src/main.ts:
  AgentRunner construction

apps/agent-worker/src/runtime/runner.ts:
  getPromptContext loop
  requestBase / streamText

apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:
  textarea
  DisplayItem
  displayItems
  onSend

apps/web/src/shared/api/api.ts:
  sendAgentMessage
  uploadWorkspaceFiles
  downloadWorkspacePath
```

### 操作

- 运行 Shared/API/Worker/Web 当前 typecheck/build；
- 运行 Agent session route、prompt context、archive/compaction、fork、workspace delete、Worker runner 和 Web agent input 现有测试；
- 记录已有失败并证明与本功能无关；
- 确认 `@fastify/multipart` 版本和 `part.file.truncated` 等 API 行为；
- 确认当前 API/Worker 启动时共享相同 `AWB_DATA_DIR`；
- 确认默认 Docker/本地开发路径的权限允许创建附件目录。

### 完成定义

- 基线命令通过，或已有失败已记录；
- 代码地图按符号复核；
- 尚未修改生产行为。

### 回滚点

本批只允许新增冻结测试或记录；可单独回退。

## 实施批次：Shared 契约

### 目标

建立 JSON/multipart payload、公共附件输出和内部 attachment ref 的唯一权威类型。

### 任务

- 抽取发送公共字段；
- 保留现有 JSON `text` 必填；
- 新增 multipart payload schema；
- 新增图片 media type schema；
- 新增公共 attachment view；
- 新增 `user_message` output 并加入 union；
- 新增内部 attachment ref part；
- 把 Prompt message schema 收紧到当前合法角色/content 结构；
- 更新 exports；
- 增加表驱动 contract 测试。

### 验证

```bash
npm run build -w packages/shared
npm run typecheck -w packages/shared
npx tsx --test packages/shared/tests/agent-image-message.test.ts
```

实际测试文件名变化时更新命令。

### 审查重点

- JSON text 是否仍必填；
- multipart 是否允许空 text 但没有把“至少有图片”错误塞进 schema；
- attachment ref 是否不含 path/storageKey/bytes；
- assistant/tool 现有 Prompt content 是否未被误拒绝；
- additionalProperties 是否严格。

### 完成定义

- 合同矩阵通过；
- API/Web/Worker 可导入新类型；
- 尚未改变发送路由。

### 回滚点

整体回退新 schema/export/test，不留下消费者。

## 实施批次：DB Schema 与附件关系 Store

### 目标

建立附件元数据和消息关系的唯一事实来源，以及批量公共投影。

### 任务

- 在 `schema.ts` 新建两张表和索引；
- 增加 attachment insert/query/delete helpers；
- 增加 relation insert/list/clone helpers；
- 实现按 Context Item ID 集合批量加载并分组；
- 修改 Context Item mapper：关系为空 `user_text`，非空 `user_message`；
- 保证 `output_json` 不保存附件列表；
- 覆盖单项、列表、transcript、visible/history 分页的统一 hydration；
- 增加 schema/FK/唯一约束/store 测试。

### 验证

```bash
npm run typecheck -w apps/api
npx tsx --test \
  apps/api/src/modules/agent/context-item-contract.test.ts \
  apps/api/src/modules/agent/run-lifecycle.persistence.test.ts
```

并执行新增附件 Store 测试。

### 审查重点

- relation 是否唯一事实；
- FK 删除语义是否符合设计；
- 是否出现 N+1；
- 旧 user_text 是否不需要迁移；
- Fork 所需 clone helper 是否可在现有 transaction 使用。

### 完成定义

- 空数据库和旧数据库初始化通过；
- 纯文本现有测试通过；
- 构造 relation 后公共输出正确。

### 回滚点

尚未在生产路径创建数据时，可回退表消费者；新增空表保留无行为影响，也可随 schema 回退。

## 实施批次：附件路径、签名与 Multipart Intake

### 目标

先建立独立于业务应用的安全文件接收能力。

### 任务

- 新增 dataDir 附件路径 helpers；
- 实现安全 ID/路径 containment；
- 实现展示文件名清理；
- 实现 PNG/JPEG/WebP 签名检测；
- 实现 temp 文件排他创建与 final move；
- 实现路由级最多 5 parts、4 图、10/20 MiB 和 payload 64 KiB；
- 允许任意 part 顺序；
- 拒绝没有 images part 的 multipart 请求，即使 payload text 非空；
- 拒绝重复/未知字段、0 字节和 SVG；
- 建立统一 cleanup ownership；
- 实现启动时 24h 超期 temp 轻量清理纯函数/服务；
- 增加流式、请求中止和路径攻击测试。

### 验证

```bash
npm run typecheck -w apps/api
npx tsx --test apps/api/src/modules/agent/attachments/*.test.ts
```

### 审查重点

- 是否错误依赖全局 2 GiB limits；
- 是否整体 Buffer 图片；
- 是否依赖 payload 先到；
- 是否所有错误路径清理；
- 是否用用户文件名拼路径；
- temp cleanup 是否可能进入 final 目录或跟随 symlink。

### 完成定义

- intake 可独立产生规范化 staged images；
- 尚未接入 Agent 发送；
- 攻击/限制矩阵通过。

### 回滚点

删除独立附件 intake/path 模块及测试，不影响现有路由。

## 实施批次：发送路由与生命周期原子激活

### 目标

把 JSON 和 multipart 统一到应用层，并原子创建消息/附件关系/Run。

### 任务

- `/messages` 路由按 Content-Type 分流；
- 非 JSON/multipart 返回 415，非法 multipart boundary 返回 400；
- JSON 使用现有 schema；multipart 使用 intake + payload schema；
- 构造 `NormalizedAgentUserMessageInput`；
- 修改 `SessionInteractionApplication.sendMessage()` 的唯一业务校验；
- 扩展 Session/Lifecycle ports；
- 快速 dedup 命中时清理 temp；
- final move 后调用 activation；
- 在 `activateUserRun()` 同事务插 attachment、Context Item、relations、dedup、Run/state；
- 纯文本仍写 `user_text`；带图写文字拆列 + relation；
- 仅图片标题使用现有 `新会话` 回退；
- 并发 transaction dedup 时清理输掉请求 final；
- DB 异常补偿文件；
- enqueue 失败不删除已提交附件；
- OpenAPI 至少准确保留 JSON 合同；multipart 文档表达如果 Fastify schema 有限制，必须在路由描述和测试中明确，不得伪造 body schema。

### 验证

```bash
npm run typecheck -w apps/api
npm run test:integration -w apps/api
npx tsx --test \
  apps/api/src/modules/agent/lifecycle/run-lifecycle-application.test.ts \
  apps/api/src/modules/agent/run-lifecycle.persistence.test.ts \
  apps/api/src/modules/agent/integration/agent-image-message.integration.test.ts
```

### 审查重点

- 应用层是否看到 Fastify/stream；
- DB 是否单事务；
- 文件与 DB 补偿是否区分 pre/post commit；
- enqueue 失败是否错误回滚附件；
- 现有 clientRequestId 行为是否保持；
- 仅图片、Slash command 边界是否符合合同。

### 完成定义

- HTTP 可创建带图消息和 Run；
- Provider 尚未看到图片也可以，但 DB/文件/接口行为完整；
- JSON 回归通过。

### 回滚点

可先禁用/回退 multipart 路由分支；已写入图片数据前不得发布。若已存在数据，回退前必须保留新表读取兼容。

## 实施批次：Read-side、Prompt 与 Archive

### 目标

建立 `triggerItemId` 唯一判断和安全历史文本化。

### 任务

- Run query/read model 加 `triggerItemId`；
- `ReadSideRun` 加字段；
- `PromptContextProjector.buildMessages` 显式传 trigger；
- `MessagesContextProjector` 使用 null trigger；
- `buildPromptMessagesForSession()` 支持 `user_message`；
- 原始 Run 输出 text + attachment refs；
- 后续 Run 输出固定占位；
- 仅图片两种提示按合同实现；
- `buildArchiveLine()` 支持图片消息；
- compaction tail user filter 支持 `user_message`；
- 确保 Compaction 输入无 refs；
- 增加两条带图消息、trigger 非最后一条的对抗测试。

### 验证

```bash
npm run typecheck -w apps/api
npx tsx --test \
  apps/api/src/modules/agent/read-side/prompt-context-projector.test.ts \
  apps/api/src/modules/agent/read-side/read-side-application.test.ts
npm run test:integration -w apps/api
```

### 审查重点

- 是否有任何隐式“最新消息”判断；
- null trigger 是否 fail-safe 占位；
- 占位是否精确、不含元数据；
- Messages Context/Compaction 是否无 refs；
- 现有 tool-call/tool-result Prompt 是否回归。

### 完成定义

- API Prompt Context 能准确返回 refs/占位；
- Archive/Compaction 合同通过；
- 尚未调用 Provider file part 也可独立验收。

### 回滚点

回退新 Prompt 分支会使图片消息无法运行，不得在已开放 UI 后回退；发布前可与 Worker 批次原子上线。

## 实施批次：Worker Storage 与多模态物化

### 目标

安全把 attachment refs 转换为 AI SDK file parts。

### 任务

- Worker Env 增加 dataDir；
- 新增 `AgentAttachmentStorage` 接口和本地实现；
- storage 只接受 API Prompt 的 workspaceId/attachmentId/mediaType 引用，不接收 storageKey/path/bytes；
- 明确禁止 Worker 查询 SQLite 或调用内部附件 HTTP；
- 使用统一安全路径 helper 与 `storageKey === attachmentId` 规则定位；
- 安全路径、普通文件、symlink/realpath、大小、签名和媒体类型校验；
- `main.ts` 注入 storage；
- Runner 构造 requestBase 前物化 Prompt；
- 不原地污染 context；
- 物化/读取失败标记为本地确定性、不可重试，不调用 `streamText`，不进入模型请求自动重试，直接走现有 failed 收尾；
- 对已经进入正常执行的 Run，每个实际模型 step 重新读取；
- 同一 Run 内部自动重试使用同一步已物化的相同附件集合；
- 只有 `agentStartupRecoveryMode=recover` 且现有恢复流程继续候选 Run 时，才以同一 `runId` 和 `triggerItemId` 重新获取相同 refs；
- `agentStartupRecoveryMode=fail` 时按现有失败语义结束且不读取附件；
- 非 `recover` 或未继续候选 Run 的启动路径不得投影 refs、调用 storage 或读取附件；
- 补充 Worker Env/storage/runner 测试。

### 验证

```bash
npm run typecheck -w apps/agent-worker
npx tsx --test \
  apps/agent-worker/src/config/env.test.ts \
  apps/agent-worker/src/runtime/agentAttachmentStorage.test.ts \
  apps/agent-worker/src/runtime/runner.image-message.test.ts
npm run test:integration:worker -w apps/api
```

### 审查重点

- Prompt 是否没有绝对路径/bytes；
- storage 是否可注入；
- Worker 是否完全不查 SQLite、不调用内部附件 HTTP；
- 是否误用 Workspace path；
- Run 进入正常模型执行后，是否按每个实际 step 重读且无泄漏缓存；
- 本地附件失败是否在 streamText 前停止且不进入模型重试；
- recover/fail 两种启动模式是否分别符合附件读取合同；
- 日志是否无 bytes/Base64/path；
- Provider 失败是否保持现有生命周期。

### 完成定义

- 支持视觉的 Provider 能收到正确 file parts；
- 不支持 Provider 失败但消息/附件保留；
- 后续 Run 不读取历史图片。

### 回滚点

API Prompt ref 与 Worker 必须同步上线/回滚，不能只部署一侧。

## 实施批次：公共预览读取 API

### 目标

提供受控、按关系授权的 Blob 内容读取。

### 任务

- 新增 `GET /api/agent/attachments/:attachmentId/content`；
- 保持全局 auth guard 先于 route handler：未认证返回 401；
- 关系 join 验证；
- 已认证后的 attachment 不存在、无关联、Workspace/Session 关系不匹配和物理文件缺失统一返回 404；
- 安全文件读取/stream；
- `Content-Type`、精确 `Content-Disposition: inline`、nosniff、`private, no-store`、准确 `Content-Length`；
- 统一 404；
- 不接受 path/storageKey；
- 增加 auth、越界、symlink、缺失和响应头测试。

### 验证

```bash
npm run typecheck -w apps/api
npx tsx --test apps/api/src/modules/agent/attachments/*.test.ts
```

### 审查重点

- 是否严格区分全局认证 401 与已认证后的统一 404；
- 关系是否完整；
- 是否可能枚举无关系附件；
- 是否泄露路径；
- Cache-Control 是否明确；
- 是否错误提供公开 URL。

### 完成定义

- 合法 Blob 可读取；
- 非法关系和物理异常安全失败；
- 还未接前端也可用 API 测试验收。

### 回滚点

删除公共 GET 路由不影响消息模型调用，但前端预览必须同步隐藏。

## 实施批次：Fork、Workspace 删除与 Temp 清理接线

### 目标

补齐现有生命周期中的附件一致性。

### 任务

- `cloneSession()` transaction 内复制 relation；
- Fork archive 补偿测试；
- Clear/Compaction/Revert 加“不删除”回归；
- Workspace 删除 transaction 显式删 attachment records；
- 提交后 best-effort 删除 workspace attachment dir；
- API 启动/现有维护入口执行一次 24h temp cleanup；
- 增加路径和失败注入测试。

### 验证

```bash
npm run typecheck -w apps/api
npm run test:integration -w apps/api
npx tsx --test apps/api/src/modules/workspaces/workspace.service.test.ts
```

### 审查重点

- Fork relation 是否同事务；
- 删除顺序是否满足 restrict FK；
- 是否误删被其他 Fork 引用的附件；
- temp cleanup 是否不碰 final；
- Workspace 路径 containment 是否与现有模式一致。

### 完成定义

- 全部生命周期矩阵通过；
- 没有复杂 GC/ref_count/状态机。

### 回滚点

Fork/删除接线必须与表结构消费者一起保留；发布后不能回退到忽略关系的旧 Fork。

## 实施批次：Web 输入、发送、历史与预览

### 目标

交付完整用户交互，保持列表轻量。

### 任务

- 新增 `pendingImages`，并用任意等价内部实现满足发送尝试与草稿内容绑定；`draftRevision/pendingAttempt` 仅是示例命名；
- textarea 增加 paste；
- 图片提取和前端镜像限制；
- 待发送条目和移除；
- 发送条件修改；
- 有图 multipart，无图 JSON；
- 带图 `/compact`、`/clear` 阻止；
- Prompt command 展开后 multipart；
- 发送前失败保留、成功清空；
- `DisplayItem` 和 mapping 支持 attachments；
- 列表 icon+数量，不使用 Tooltip、不创建 img；
- 新增 Modal、逐张 Blob、URL registry、关闭释放；
- Modal 显示精确说明文案；
- 增加 i18n 文案和纯逻辑测试。

### 验证

```bash
npm run typecheck -w apps/web
npm run test -w apps/web
npx tsx --test apps/web/src/features/workspace/tools/agent/agentImageAttachments.test.ts
```

### 审查重点

- paste 是否零请求；
- 文本+图片 paste 是否不丢文本；
- 列表是否无 Tooltip；
- 初次是否零内容请求；
- Blob 是否释放；
- 新发送生成新 ID、不确定网络重试复用原 ID、草稿变化使旧 ID 不可用于新内容的外部行为是否正确；
- 控制命令是否不丢图片。

### 完成定义

- 产品合同所有交互可手工完成；
- 前端测试和 typecheck 通过；
- 无未授权图片自动加载。

### 回滚点

UI 可以用 feature 分支整体回退，但已存在图片历史时旧 Web 不认识 `user_message`。因此发布后回滚 Web 必须保留最低限度 `user_message` 文本兼容或同步回滚数据/API，不得直接部署完全旧版本。

## 最终集成、独立审查与验收

### 自动验证

```bash
npm run build -w packages/shared
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
npm run test -w apps/web
npm run typecheck
```

并显式执行所有新增 `tsx --test` 文件。

### 手工验证

按 [06-testing-acceptance.md](./06-testing-acceptance.md) 的支持模型、不支持模型、Fork、Clear/Compaction、预览、Workspace 删除场景执行。

### 独立审查

审查者不得参与主要实现，至少检查：

- Product contract 全部 MUST/MUST NOT；
- 路径与 multipart 安全；
- DB/文件事务补偿；
- triggerItemId 唯一判断；
- 列表零图片请求和无 Tooltip；
- Worker refs 物化；
- Fork/删除一致性；
- 非目标未被擅自引入。

阻塞问题修复后必须由同一独立审查角色复审，直到通过。

### 最终完成定义

- 自动测试与手工验收全部通过；
- 独立审查无阻塞问题；
- OpenAPI/接口文档可用；
- 设计与实现没有未记录偏差；
- 日志、DB、Prompt 和 HTTP 响应无图片内容或路径泄露；
- 发布与回滚说明覆盖 Shared/API/Worker/Web 同步版本要求。
