# 测试、代码审查与验收标准

返回 [README](./README.md)。本文件定义必须覆盖的单元、集成、前端、安全、失败注入和兼容矩阵。所有“必须”项通过后，功能才能验收。

## 测试原则

- 测试必须证明边界，而不只证明 happy path。
- 上传限制必须在服务端测试，前端测试不能替代安全测试。
- “原始 Run 见图、后续 Run 占位”必须以 `triggerItemId` 为条件验证，不能只测最后一条消息。
- 物理文件、DB 记录、关系、Run 和前端状态必须分别断言。
- 历史列表懒加载必须用“初次零内容请求”验证，而非仅检查代码中存在 lazy 属性。
- 旧 `user_text`、纯文本 JSON、Fork、Compaction 和 Workspace 删除必须做回归。
- 路径、安全和错误测试不得在日志中输出图片 bytes 或绝对敏感路径。

## Shared contract 测试

### JSON

必须覆盖：

- 合法纯文本请求通过；
- `text` 缺失拒绝；
- `text: ""` 被 `minLength` 拒绝；
- 未知字段因 `additionalProperties: false` 拒绝；
- 既有 response schema 不变。

### Multipart payload

必须覆盖：

- `text` 非空通过；
- `text` 缺失通过 schema；
- `text: ""` 通过 schema；
- `workspaceId/clientRequestId` 缺失拒绝；
- 非法 `uiLocale` 拒绝；
- 未知字段拒绝。

### Context Item output

必须覆盖：

- 旧 `user_text` 通过；
- 带 1 至 4 张合法附件的 `user_message` 通过；
- `attachments` 为空拒绝；
- 非白名单 mediaType 拒绝；
- size 为 0 拒绝；
- 额外字段拒绝。

### Internal Prompt contract

必须覆盖：

- user string content；
- user text parts；
- user text + attachment ref；
- assistant text/tool-call；
- tool-result；
- attachment ref 缺字段、未知 mediaType、额外绝对路径字段时拒绝；
- strict Worker response validation 能接受合法图片 Prompt Context。

## Multipart intake 单元测试

### Part 结构

| 用例 | 结果 |
|---|---|
| payload 在 images 前 | 通过 |
| payload 在 images 后 | 通过 |
| payload 位于两张 image 中间 | 通过 |
| 缺 payload | 400 |
| 重复 payload | 400 |
| 未知普通字段 | 400 |
| 未知文件字段 | 400 |
| 0 张图片且空 text | 400 |
| 0 张图片但 text 非空 | 400；纯文本必须走 JSON |
| 0 字节 image | 400 |
| 超过允许 part 数 | 400 |
| 不支持的 Content-Type | 415 |
| multipart boundary 缺失或非法 | 400 |

所有拒绝用例必须断言 temp 目录无本请求残留。

### 数量和大小

- 1 张合法图片；
- 4 张合法图片；
- 第 5 张触发拒绝；
- 单图恰好 10 MiB 允许；
- 单图超过 10 MiB 拒绝；
- 总量恰好 20 MiB 允许；
- 总量超过 20 MiB 拒绝；
- 流声明小但实际持续超过限制时中途终止；
- 请求中断后清理全部 temp。

MiB 必须按 `1024 * 1024` 计算。

### 签名

- 合法 PNG 签名检测为 `image/png`；
- 合法 JPEG 检测为 `image/jpeg`；
- 合法 WebP 同时包含 RIFF/WEBP 检测为 `image/webp`；
- `.png` 文件名但 JPEG bytes 按 JPEG 持久化或按产品合同接受实际类型；
- 声明 `image/png` 但随机 bytes 拒绝；
- SVG 文本即使声明 `image/png` 拒绝；
- 前缀过短拒绝；
- 文件名含路径、NUL/CRLF/控制字符时清理且不得越界。

### 资源行为

- 大文件流不得整体读入 JS 数组或 Buffer 才判断大小；使用可控 stream fixture 证明在阈值后停止；
- 发现错误后的当前流和其他已创建 temp 被清理；
- 不依赖 multipart part 顺序。

## 数据库与持久化测试

### Schema

- 新表和索引在空数据库创建；
- 旧数据库升级不破坏现有表；
- relation context item FK cascade；
- attachment FK restrict；
- `(context_item_id, position)` 唯一；
- 同 item/attachment 重复关系拒绝；
- attachment storage key 在 workspace 内唯一；
- `media_type`、`byte_size`、`position` 的 CHECK 约束生效；
- `filename` 长度必须为 1 至 255。

### 激活事务

必须断言一次带图发送事务产生：

- 一条 user Context Item；
- 一至四条 `agent_attachment`；
- 同数量 relation，position 连续；
- 一条 `agent_client_request`；
- 一条 `agent_run`；
- `trigger_item_id` 等于该 user item ID；
- Session run state 为 running；
- 首条仅图片消息标题为 `新会话`。

纯文本事务必须仍产生 `user_text` 且不产生附件记录/关系。

### 公共读取投影

- 无关系 user item 返回 `user_text`；
- 有关系 user item 返回 `user_message`；
- 附件按 position 排序；
- 附件列表来自 relation join，而不是 output_json；
- output_json 中没有附件 ID；
- 历史列表批量 hydration 不产生逐 item 查询；可通过 query spy 或实现结构审查证明。

### 事务失败与补偿

失败注入位置：

- 第一个 attachment insert；
- Context Item append；
- relation insert 中途；
- client request insert；
- Run insert；
- run state update。

每个用例必须断言：

- DB transaction 全部回滚；
- 本次 final/temp 文件被 best-effort 删除；
- Session head/title/run state 未半提交；
- 既有历史不受影响。

## 幂等测试

- 相同 `clientRequestId` 首次请求创建消息；
- 第二次相同 key 返回相同 `messageItemId/runId` 和 `deduplicated: true`；
- multipart 重复请求产生的本次 temp/final 文件被清理；
- 并发两个相同 key 只存在一条消息/Run/附件集合；
- 同 key 不同内容仍命中第一次结果，作为已接受 V1 合同写入测试；
- 新的用户发送生成新 ID；
- 前端文字、图片集合或图片顺序变化后，旧 attempt ID 不得用于新内容；
- 网络接受状态不确定且草稿未变时复用 ID。

`PendingSendAttempt`、`draftRevision` 只可作为等价实现示例；测试必须断言上述外部行为，不得把内部类型名、字段名或状态实现写成验收条件。

不得在 V1 测试中期待 request fingerprint 或 409 内容冲突。

## Prompt 与 Read-side 测试

### Trigger 传递

- Run 查询返回 `triggerItemId`；
- `ReadSideRun` 保存该字段；
- `PromptContextProjector` 把该字段传给 `buildMessages`；
- 不得从 Session head 或最后一条消息覆盖该值；
- trigger item 不在可见链或为 null 时，带图消息全部占位。

### 原始 Run

准备至少两条带图历史消息，并让当前 Run 的 trigger 指向较早或非最后一条消息，断言：

- 只有 trigger item 产生 attachment refs；
- 其他图片消息产生历史占位；
- 证明实现没有使用“最后一条带图消息”推断；
- attachment refs 按 position；
- 文本非空时首 part 是原文；
- 仅图片 trigger 使用仅图片固定 text part；
- refs 不含绝对路径、storageKey、hash；
- refs 数量等于关系数量。

### 后续 Run

- 原文 + 两个换行 +固定英文占位；
- 仅图片历史只保留占位；
- `N=1` 仍使用固定 `attachment(s)` 字符串，不做动态单复数模板分支；
- 文件名、ID、hash、path 不出现；
- 占位不随 zh-CN/en-US locale 变化；
- 无附件 user_text 行为不变。

### Messages Context / Compaction

- `MessagesContextProjector` 传 null 模式，所有图片只占位；
- Compaction 输入不含 attachment ref；
- `buildArchiveLine()` 对图片消息生成安全文本；
- Archive 行和 compaction snippet 不含附件元数据；
- 仅图片消息仍是非空可归档 user 行；
- 既有 assistant/tool/system 构建行为不变。

## Worker 测试

### Env 与 storage

- `AWB_DATA_DIR` 被解析为绝对 dataDir；
- API spawn Worker 保留该 env；
- Worker storage 不查询 SQLite；
- Worker storage 不调用内部附件 HTTP；
- storage 输入不含 storageKey、path、bytes 或 Base64；
- storage 使用 dataDir、统一安全路径 helper 和 `storageKey === attachmentId` 规则；
- attachment ID 非安全格式拒绝；
- 正常文件读取成功；
- 文件缺失拒绝；
- 目录拒绝；
- symlink 拒绝；
- realpath 越界拒绝；
- 文件超过 10 MiB 拒绝；
- mediaType 不一致拒绝；
- 测试使用注入 storage，不依赖真实生产 dataDir。

必须证明授权只发生在 API Prompt 投影：非 trigger item 不产生 ref；Worker 只校验路径和物理文件完整性，不读取数据库关系。

### 物化

- attachment ref 转成 AI SDK file part；
- text part、tool-call、tool-result 原样保留；
- 输入 context 不被原地写入 bytes；
- 文件名只作为 Provider filename；
- 任一 attachment 物化、路径校验或读取失败时不调用 `streamText`；
- 失败被标记为本地确定性、不可重试，不进入模型请求自动重试；
- 直接走现有 Assistant/Run failed 收尾；
- 不静默丢弃失败 part；
- 内部错误/日志可区分失败类别且不包含绝对路径；
- bytes/Base64 不进入日志。

### 正常执行 step、同一 Run 内部重试与条件化启动恢复

- 已进入正常执行的同一 Run，其两个模型 step 各自获取相同 attachment refs；
- storage `read()` 在每个实际模型 step 被调用，不使用跨 step bytes 缓存；
- Runner 内部自动重试使用当前 step 已物化的同一附件集合；
- 只有 `agentStartupRecoveryMode=recover` 且候选继续恢复时，才保持同一 `runId`，通过 `triggerItemId` 重新得到相同附件集合；
- `agentStartupRecoveryMode=fail` 时按现有失败语义收尾，Prompt/storage spy 必须证明未读取附件；
- 非 `recover` 或未继续候选 Run 的启动路径，Prompt/storage spy 必须证明没有附件投影、物化或读取；
- 后续新 Run 的 Prompt 没有 refs，因此 storage 不读取历史图。

### Provider 失败

- Provider 拒绝 file part 时 assistant/run 进入现有 failed 状态；
- 用户 Context Item、attachment 和 relation 保留；
- 不要求生成专用视觉错误码；
- 后续纯文本 Run 不携带旧附件 refs。

## 公共附件读取 API 测试

### 授权与关系

- 未通过现有主 API 认证时，全局 auth guard 返回 401，附件 route handler 不执行；
- 合法附件关系可读取；
- 已认证但 attachment 不存在返回 404；
- attachment 存在但无 Context Item 关系返回 404；
- relation 的 Context Item/Session/Workspace 不匹配返回 404；
- 其他 Workspace 的附件不可通过当前 Session/path 参数读取；接口根本不接受 path；
- 非法 attachmentId 返回 404，不暴露物理路径或区分非法格式与不存在；
- 已认证但物理文件缺失返回 404。

### 响应

必须断言：

```text
Content-Type = persisted allowlisted type
Content-Disposition = inline
X-Content-Type-Options = nosniff
Cache-Control = private, no-store
```

还必须验证：

- body 与存储 bytes 一致；
- 不返回 Base64/JSON 包装；
- 不重定向；
- `Content-Length` 等于实际文件字节数；
- `Content-Disposition` 精确为 `inline`，不包含文件名参数；
- 物理文件丢失、目录、symlink/越界返回 404；
- 日志不包含绝对路径到 HTTP 响应。

## Fork、Clear、Compaction、Revert、删除测试

### Fork

- `visible_only` 复制附件关系；
- `with_archive` 复制可见与归档 item 的附件关系；
- old/new Context Item ID 不同；
- attachmentId 相同；
- 物理文件只有一份；
- relation 复制与 Context Item 在同一事务；
- Fork archive 写入失败删除新 Session/关系，但保留源附件与源关系。

### Clear / Compaction / Archive / Revert

- 操作后附件记录、关系和文件仍存在；
- 历史公共投影仍显示附件；
- 内容 API 仍可读取；
- Prompt/Compaction 不传 bytes；
- Revert 后新 Run 仍只占位。

### Workspace 删除

- transaction 删除 relation（cascade）和 attachment records；
- Workspace attachment directory 被 best-effort 删除；
- 路径越界防护测试；
- 目录删除失败只 warning，不恢复 DB；
- 其他 Workspace 附件不受影响。

### Temp 清理

- 24 小时内 temp 不删除；
- 超过 24 小时普通 temp 文件删除；
- symlink/目录不跟随、不递归；
- 单文件删除失败不阻塞其他项；
- final 目录不扫描、不删除。

## 前端测试

可测试逻辑必须拆成纯 helper/composable，并覆盖：

### 粘贴

- 纯文本 paste 不阻止默认行为；
- 单图、多图加入本地状态；
- 同时文本+图片时文本保留；
- 粘贴后无网络调用；
- 数量/单图/总量前端提示；
- 非白名单声明类型不加入；
- 空文件不加入；
- 文件名为空生成展示名。

### 移除与发送

- 移除单张/全部；
- 移除无后端调用；
- 文本空且无图不能发；
- 仅图片可以发；
- 纯文本走 JSON；
- 带图走 multipart；
- FormData 只有一个 payload 和多个 images；
- 不手动设置 Content-Type boundary；
- Prompt command 展开后与图片发送；
- 带图 `/compact`、`/clear` 被阻止且草稿不清空；
- 请求失败前保留草稿；
- 成功/dedup 成功清空；
- 发送期间附件冻结。

### 历史与预览

- `user_message` 映射附件元数据；
- 列表只显示 icon+数量；
- 不创建 Tooltip；
- 初次渲染无 attachment content 请求；
- 点击后打开 Modal，只请求第一张；
- 切换后才请求下一张；
- 已加载 Blob 在 Modal 内复用；
- 关闭/卸载 revoke URL；
- 加载失败显示单图错误；
- Modal 显示准确说明文案；
- 列表中不显示该说明。

## 手工验收场景

在至少一个支持图片的模型和一个不支持/会拒绝图片的模型上执行：

### 支持模型

- 粘贴一张截图并附文字，确认粘贴阶段 Network 无上传；
- 移除并重新粘贴；
- 发送后模型能描述图片；
- 再发“继续”纯文本，确认后端/Worker 日志没有再次读取旧图，模型 Prompt 只有占位；
- 历史列表初次无图片请求；
- 点击预览逐张加载；
- 刷新后历史 icon/数量和预览仍可用。

### 不支持模型

- 发送带图消息；
- 确认消息和附件出现在历史；
- Assistant/Run 显示失败；
- 点击仍能预览；
- 后续发送纯文本不因旧图再次失败。

### 生命周期

- Fork 带图消息，两个会话都可预览；
- Clear/Compact 后归档历史仍可预览；
- Revert 后图片仍存在；
- 删除 Workspace 后附件目录不再存在或失败有 warning，DB 无附件记录。

## 性能与流量验收

- 粘贴图片：0 个附件网络请求；
- 打开 100 条历史消息且包含图片：0 个图片内容请求；
- 点击一条 4 图消息：初始只有 1 个内容请求；
- 切换到第二张后累计 2 个；
- 关闭 Modal 后 Blob URL 释放；
- Multipart 服务端流式处理，内存不随 20 MiB 请求出现多份完整复制；
- Context Item 列表附件 hydration 使用批量查询而不是 N+1。

## 验证命令

开发批次应使用精确测试文件；最终至少执行：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
npm run test -w apps/web
```

仓库完整类型检查：

```bash
npm run typecheck
```

新增的非 package script 测试文件应使用仓库现有 `tsx --test` 方式显式执行，例如：

```bash
npx tsx --test packages/shared/tests/agent-image-message.test.ts
npx tsx --test apps/api/src/modules/agent/attachments/*.test.ts
npx tsx --test apps/agent-worker/src/runtime/agentAttachmentStorage.test.ts
npx tsx --test apps/agent-worker/src/runtime/runner.image-message.test.ts
npx tsx --test apps/web/src/features/workspace/tools/agent/agentImageAttachments.test.ts
```

命令必须以实际新增文件名为准更新，不得声称执行未被 script 覆盖的测试。

## 验收标准

满足以下全部条件才可验收：

- 粘贴阶段无上传，待发送图片可移除；
- JSON 纯文本合同和行为无回归；
- multipart 不依赖 part 顺序，拒绝未知/重复字段并严格限流；
- 服务端签名检测和数量/字节限制生效；
- 仅图片消息可发送且首会话标题为 `新会话`；
- 消息、附件、关系、幂等和 Run 激活无半提交；
- `triggerItemId` 是原始 Run 见图的唯一判定；
- 已进入正常执行的 Run，其每个实际模型 step 与同一 Run 内部重试使用相同 trigger item 附件；只有 recover 模式继续同一 `runId` 时才通过 `triggerItemId` 重取相同集合，fail 模式以及其他未继续恢复的启动路径不读取附件；
- 后续 Run、Messages Context、Archive、Compaction 只使用安全占位；
- 历史列表只显示 icon+数量，无 Tooltip、无自动图片请求；
- Modal 逐张 Blob 懒加载并显示已定说明；
- 公共内容接口未认证由全局 guard 返回 401；已认证后的不存在、无关联、关系不匹配和物理缺失统一 404；
- 公共内容接口成功时按关系验证，返回 `inline + nosniff + private, no-store + Content-Length`；
- Worker 使用共享 dataDir 和固定路径规则，不查 SQLite、不调用内部附件 HTTP、不接受 storageKey/绝对路径；
- 附件物化/读取失败不调用 streamText、不进入模型自动重试，直接 failed 收尾；
- Provider 失败保留消息和附件，后续纯文本不重放旧图；
- Fork 复制关系，Clear/Compaction/Revert 不删附件；
- Workspace 删除和 temp 清理符合合同；
- 无图片 bytes、Base64、存储路径泄露到 DB JSON、Prompt 占位、日志或公共 API 元数据。

## 独立代码审查清单

### 范围与兼容

- 是否只实现 V1 范围，没有顺带引入模型能力、缩略图、历史重放、对象存储或指纹？
- JSON schema 是否仍要求 text？
- 旧 user_text 与纯文本发送测试是否通过？

### 协议

- Multipart payload schema 是否来自 Shared？
- 应用层是否完全不知道 Fastify multipart？
- 是否不依赖 part 顺序？
- 是否拒绝未知/重复/空 part？
- 是否使用路由级限制而不是全局 2 GiB 配置？

### 数据与事务

- 关系表是否是唯一事实来源？
- output_json 是否没有附件 ID 列表？
- 激活事务是否覆盖所有 DB 写入？
- 文件 move 与 DB 失败补偿是否完整？
- 并发 dedup 是否清理输掉请求的文件？

### Prompt

- `triggerItemId` 是否从 Run 查询显式传到底？
- 是否存在“最后一条消息”之类隐式判断？
- Messages Context/Compaction 是否强制 null trigger？
- 占位是否精确固定、不含元数据？

### 文件安全

- 所有路径是否从 dataDir 派生并 containment 校验？
- 文件名是否只用于展示？
- Worker 是否完全不查询 SQLite、不调用内部附件 HTTP，且只消费 API Prompt ref？
- Worker 是否拒绝 symlink/目录/越界/超大文件？
- 本地附件失败是否在 streamText 前终止、标记不可重试并直接 failed 收尾？
- 公共接口是否没有 path/storageKey 参数？
- auth guard 的 401 与已认证后的统一 404 是否分层正确？
- 响应头是否完整？

### 前端

- 粘贴是否零请求？
- 列表是否无 Tooltip 和 img？
- Blob 是否逐张、可释放？
- 带图控制命令是否不会静默丢图？
- 新发送/不确定重试/草稿变化的 clientRequestId 外部行为是否正确，而非依赖某个内部 attempt 类型名？

### 生命周期

- recover/fail 两种 `agentStartupRecoveryMode` 的附件读取行为是否分别符合合同？
- Fork relation 是否同事务复制？
- Clear/Compact/Revert 是否没有删除？
- Workspace 删除顺序与 restrict FK 是否正确？
- temp cleanup 是否不碰 final？
