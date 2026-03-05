# write UI artifacts 与 Diff 卡片

Status: draft

## 背景与问题

- `write` 工具当前是确定性兜底能力: 直接将 `args.content` 全量写入 `args.filePath`.
- 当前 UI 对 `write` 的展示仅为工具调用行与文本输出,缺少面向用户的可视化反馈(例如覆盖了哪些内容).
- 当前数据层会持久化 `write` 的 `args.content`.
  - 会导致 `/context-items` 响应体体积随历史 write 增长.
  - 工具调用行可能暴露 content 片段(尽管 UI 有截断,但仍存在泄漏风险).

本项目尚未上线.

- 本方案不考虑兼容旧数据,允许直接切换到新结构.

## 目标

- 将 `write` 的交互优化为富卡片,体验对标 `apply_patch`:
  - 默认不渲染 diff.
  - 用户展开后按需拉取 service UI artifact 并渲染单文件 diff.
- fork 后 artifact 身份稳定复用:
  - key 使用 `toolCallId`.
  - artifact 路径不包含 `sessionId` 或 `itemId`.
- `write` 完成后瘦身 DB 持久化:
  - 不在 DB 中长期保留 `args.content`.
  - `before/after` 不进 DB,仅进入 service UI artifact.
- 审批阶段不需要 diff 预览.

## 非目标

- 不在本方案中实现 artifact 清理策略与生命周期管理.
- 不改变 append-only item 事件模型与调度状态机.
- 不将 `write` 变更为 patch 语义(仍为全量覆盖写入).

## 核心决策

### key 使用 toolCallId

- service UI artifact 的主 key 为 `toolCallId`.
- 理由:
  - toolCallId 与 ai-sdk 的 tool-call/tool-result 关联一致.
  - fork 会克隆 tool item 的 `output.toolCallId`,因此新 session 可复用同一份 artifact.

### completed 后移除 args.content

- `write` 进入终态后,将 `args` 中的 `content` 从 DB 移除,仅保留:
  - `filePath`
  - `contentBytes`
  - `contentPreview` 与 `contentTruncated`
- 理由:
  - 降低 `/context-items` 体积.
  - 降低意外泄漏风险.
  - 完整 after 已可通过 artifact 或 workspace 文件获得.

补充:

- 对 `denied/failed/cancelled` 的 write,也建议同样进行 args 瘦身,避免 DB 长期保存用户拒绝执行或失败的敏感内容.

## 路径约定

### service UI artifacts(write)

- 绝对路径(由 dataDir 计算):
  - `<dataDir>/tmp/agent/ui-artifacts/write/<workspaceIdSegment>/<toolCallIdSegment>.json`

说明:

- `<workspaceIdSegment>` 与 `<toolCallIdSegment>` 均需安全清洗:
  - 仅允许 `[A-Za-z0-9._-]`,其他字符替换为 `_`.
  - 最大长度建议 120,超长截断.
- 路径必须落在 `tmpRoot(dataDir)` 下,读取与写入均需拒绝 symlink 与 path traversal.

## 数据结构约定

### DB 中 write 的 slim result

- tool item 在 DB 中可保留轻量结构化 `result`,供 UI 展示摘要.
- 建议 shape:

```json
{
  "summary": "写入文件 src/a.ts",
  "filePath": "src/a.ts",
  "bytesWritten": 1234,
  "existedBefore": true
}
```

约束:

- 禁止在 DB 的 `output.result` 中保存 `before/after`.
- `output.text` 仍是主文本通路,用于归档与 prompt tool-result.

### service UI artifact JSON 结构

- 单文件 JSON,用于渲染 diff.
- 建议 schema `write_ui_artifact_v1`:

```json
{
  "schemaVersion": 1,
  "toolName": "write",
  "workspaceId": "ws_xxx",
  "toolCallId": "call_xxx",
  "createdAt": 1710000000000,
  "filePath": "src/a.ts",
  "summary": {
    "bytesWritten": 1234,
    "existedBefore": true
  },
  "before": {
    "available": true,
    "text": "...",
    "truncated": false,
    "bytes": 1200
  },
  "after": {
    "available": true,
    "text": "...",
    "truncated": false,
    "bytes": 1234
  }
}
```

约束:

- `before.text/after.text` 必须是 UTF-8 文本.
- 当 `before.available=false` 时必须提供 `before.reason`(字符串),例如 `missing_file`、`non_text`、`too_large`.
- 必须支持截断:
  - `before.truncated/after.truncated` 标记是否截断.
  - `before.bytes/after.bytes` 表示原始字节数(若可计算).

建议的大小上限:

- 以字符或字节控制,避免写入超大 artifact:
  - `AWB_WRITE_UI_ARTIFACT_MAX_BYTES_PER_SIDE`(默认建议 200KB).
  - 超过时仅保存前缀并置 `truncated=true`.

## worker 实现方案

### write 执行时采集 before/after

- 触发点: worker 执行 `write` 工具时.
- before 采集:
  - 若目标文件存在且为 UTF-8 文本且不超过阈值,读取全文或前缀.
  - 若不存在,`before.available=false, reason=missing_file`.
  - 若为 symlink/目录/非文本/过大,`before.available=false` 并写入对应 reason.
- after 采集:
  - 直接使用 `args.content` 作为 after 文本源.
  - 同样按阈值截断写入 artifact.

返回结果:

- worker 对 `output.result` 返回结构化 `write` 结果,至少包含:
  - `filePath`
  - `bytesWritten`
  - `existedBefore`
  - `beforeText` 与 `afterText`(仅用于 API 写 artifact 的输入,不会长期存 DB)
  - `before/after` 的可用性与截断标记

注意:

- 审批阶段不需要 diff,因此 queued/awaiting_permission/running 状态无需计算 before/after.
- 只有 `completed` 才尝试生成 artifact 所需 payload.

## API 实现方案

### completed 时写入 service UI artifact 并瘦身入库

- 触发点: API 接收到 worker 对 tool item 的 update,且该 item:
  - `kind=tool`
  - `output.toolName=write`
  - `status` 进入终态

处理流程:

- 从 worker 回传的 `output.result` 中拆分:
  - `artifact`: 含 before/after 的 UI artifact payload
  - `slimResult`: 轻量 result(不含 before/after)
- 写入 artifact 文件(尽力而为):
  - 成功: UI 可拉取 diff
  - 失败: tool 仍保持终态,仅记录日志,UI 展示 `diff unavailable`
- 将 `output.result` 替换为 `slimResult` 再写入 DB.
- 同步瘦身 `output.args`:
  - 移除 `args.content`,保留 `filePath` 与 `contentBytes/contentPreview`.

### 拉取接口

- 新增 endpoint:
  - `GET /api/agent/sessions/:sessionId/context-items/:itemId/write-artifact`

服务端校验:

- item 存在且属于 sessionId.
- item.kind=tool 且 item.output.toolName=write.
- item.output.toolCallId 存在.
- artifact 路径必须在 `tmpRoot(dataDir)` 下,拒绝 symlink.

返回:

- 200: artifact JSON.
- 404: item 不存在,或 artifact 文件不存在/不可读/校验失败.

## prompt 投影建议

### write tool-call input projector

- 目标: 避免将完整 `args.content` 作为 tool-call input 塞进 prompt messages.
- 做法:
  - 为 `write` 增加 prompt projector,将 tool-call input 投影为:
    - `filePath`
    - `contentBytes`
    - `contentPreview`(短前缀,例如 200-400 chars)
    - `contentTruncated`

补充:

- tool-result 已统一为 `output.text` 的 `text/error-text`,无需额外结构化投影.

## 前端实现方案

### 新增 AgentWriteCard

- 默认展示:
  - `write` 标题
  - `filePath`
  - `bytesWritten`、`existedBefore`
  - 错误提示(若有)
- 用户点击展开 Diff 后:
  - 拉取 write artifact 接口
  - 展示 `MonacoDiffViewer(before.text, after.text)`
  - 若 `before.available=false` 或拉取失败,展示 `diff unavailable` 文案

### 缓存与展开状态

- 缓存 key 使用 `workspaceId:toolCallId`.
- 虚拟列表 unmount/remount 后仍保留:
  - 当前是否展开
  - 已加载的 artifact

### 虚拟列表测量

- 展开/收起 Diff 后触发 `request-measure`,让虚拟列表重新测量行高.
- MonacoDiffViewer 使用 autoHeight,避免内层纵向滚动条.

## 安全与边界

- artifact 文件读写必须:
  - 限定在 `tmpRoot(dataDir)` 之下.
  - 目录与目标文件均拒绝 symlink.
- `before` 读取必须遵循 workspace 边界与安全规则:
  - 相对路径 resolve 后必须在 workspace 根目录内.
  - 拒绝绝对路径与 path traversal.

## 测试与验收

### 后端验收

- write completed 后:
  - DB 中 `output.result` 不包含 before/after.
  - DB 中 `output.args` 不包含 content,仅保留 slim 字段.
  - service UI artifact 文件存在且可读.
  - 拉取接口返回 200 且包含 before/after(或明确 unavailable).
- artifact 文件缺失时返回 404.

### 前端验收

- 会话列表默认滚动性能不受 write 历史影响明显恶化(相比原方案有改善).
- write 卡片默认不渲染 diff.
- 展开后可以加载并展示 diff,失败时显示 `diff unavailable`.

## 开发落点

- worker:
  - `apps/agent-worker/src/runtime/fileTools.ts`: 扩展 write 执行产物,提供 before/after 所需信息.
  - `apps/agent-worker/src/runtime/runner.ts`: write 的 output.text 继续走统一文本通路,completed 时携带结构化 result.

- API:
  - `apps/api/src/infra/fs/paths.ts`: 增加 `writeUiArtifactPath(dataDir, workspaceId, toolCallId)`.
  - `apps/api/src/modules/agent/agent.routes.ts`: 增加 write artifact 拉取接口.
  - `apps/api/src/modules/agent/agent.service.ts`: 在 updateContextItemFromWorker 中写 artifact 并瘦身 result/args.
  - `apps/api/src/modules/agent/prompt/tool-projectors/`: 增加 write 的 tool-call input projector.

- 前端:
  - `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`: 增加 write display model 与卡片渲染分支.
  - `apps/web/src/features/workspace/tools/agent/AgentWriteCard.vue`: 新增组件,按需拉取 artifact 并渲染 diff.
