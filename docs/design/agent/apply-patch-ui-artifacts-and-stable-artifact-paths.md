# apply_patch UI artifacts 与稳定 artifact 路径

Status: draft

## 背景与问题

- 系统有两类 artifact:
  - workspace artifacts: 写入 workspace 目录内,供模型通过 read/bash 等工具二次读取或检索(内容快照).
  - service UI artifacts: 写入服务运行目录(AWB_DATA_DIR 派生目录),供前端按需拉取并渲染富 UI(例如 apply_patch diff).

- 会话支持 fork.
  - fork 会克隆 `agent_context_item.output` 到新 session,但 itemId 会重新分配.
  - 因此,任何将 artifact 身份绑定到 sessionId 或 itemId 的路径设计,都会导致 fork 后难以复用或需要复制,并且未来清理策略也更难设计.

- apply_patch 现状将 before/after diff payload 存在 DB 的结构化 `result.files[].before/after` 中.
  - 直接后果:
    - `/context-items` 返回体积大,列表滚动与渲染明显卡顿.
    - 前端默认 mount Monaco diff,性能与内存开销随历史增长.
    - prompt/归档需要额外投影与特判以避免过大 payload.

本项目尚未上线.

- 本方案不考虑兼容旧数据,目标是一步到位切换到新结构.
- 审批阶段不需要 diff 预览.

## 目标

- artifact 路径与 key 在 fork 后稳定.
  - workspace artifacts 与 service UI artifacts 都不包含 sessionId.
- apply_patch 的 before/after 不再进入 DB.
  - DB 只保留 apply_patch 的轻量 summary 与文件元数据.
- 前端列表渲染优化.
  - 默认不渲染 Monaco diff.
  - 用户展开或点击文件时按需拉取 service UI artifact 并渲染 diff.
- 不改变 append-only 的 item 事件模型与调度状态机.

## 非目标

- 不讨论 artifacts 的清理策略与生命周期(后续再做).
- 不对其他工具引入 UI artifacts(本次只覆盖 apply_patch).

## 核心决策

### key 统一使用 toolCallId

- 两类 artifact 的主 key 统一使用 `toolCallId`.
- 理由:
  - toolCallId 与 ai-sdk 的 tool-call/tool-result 关联一致.
  - fork 会克隆 tool item 的 `output.toolCallId`,因此新 session 可复用同一份 artifact.
- 约束:
  - 对于会写 artifact 的 tool item,必须携带 `toolCallId`.
  - 如果 toolCallId 缺失,视为 bug:
    - 不写 artifact.
    - 记录 warn.
    - 不应将已成功执行的 tool 标记为 failed(避免副作用与状态不一致).

### apply_patch UI artifacts 单文件

- service UI artifact 采用单文件 JSON.
- 审批阶段不需要 diff,因此不区分 preview/final,只保存 completed 产物.

## 路径约定

### workspace artifacts(给模型查,在 workspace 内)

- 相对 workspace 的路径:
  - `.awb/agent/artifacts/by_tool_call/<toolName>/<toolCallIdSegment>.txt`

说明:

- `<toolCallIdSegment>` 经过安全清洗:
  - 仅允许 `[A-Za-z0-9._-]`,其他字符替换为 `_`.
  - 最大长度建议 120,超长截断.
- `<toolName>` 使用 tool 名称作为分桶,便于排障与后续配额.

### service UI artifacts(仅 apply_patch,在 dataDir 内)

- 绝对路径(由 dataDir 计算):
  - `<dataDir>/tmp/agent/ui-artifacts/apply_patch/<workspaceIdSegment>/<toolCallIdSegment>.json`

说明:

- `<workspaceIdSegment>` 与 `<toolCallIdSegment>` 均需安全清洗(规则同上).
- 该目录位于 `tmpRoot(dataDir)` 下,未来清理策略可以优先从 tmpRoot 入手.

## 数据结构约定

### DB 中 apply_patch 的 result(瘦身结构)

apply_patch tool item 在 DB 中保留结构化 `result`,但必须是轻量形态:

- `result.text: string`
- `result.summary: { fileCount: number; additions: number; deletions: number }`
- `result.files: Array<{ type: "add"|"update"|"delete"|"move"; path: string; fromPath?: string; additions: number; deletions: number }>`

强约束:

- `result.files[]` 禁止包含 `before/after`.

### service UI artifact JSON 结构

单文件 JSON,建议 shape:

```json
{
  "schemaVersion": 1,
  "toolName": "apply_patch",
  "workspaceId": "ws_xxx",
  "toolCallId": "call_xxx",
  "createdAt": 1710000000000,
  "summary": { "fileCount": 3, "additions": 42, "deletions": 10 },
  "files": [
    {
      "type": "update",
      "path": "src/a.ts",
      "fromPath": null,
      "additions": 1,
      "deletions": 0,
      "before": "...",
      "after": "..."
    }
  ]
}
```

约束:

- 只包含 UI 渲染 diff 所需字段.
- `before/after` 必须是 UTF-8 文本.
- 文件过大时允许截断,但必须显式写入截断标记字段(例如 `truncated: true`),避免 UI 误判.

## 后端实现方案

### 写入时机与位置

- 写入逻辑应在 API 侧实现(因为 API 拥有 dataDir,worker 进程默认不持有 dataDir).
- 触发时机:
  - 当 API 接收到 worker 对 apply_patch tool item 的 update 且 status 进入 `completed` 时.

### 写入流程(概念)

- 输入: worker 回写的 tool item output,其中 `output.result.files[]` 仍包含 `before/after`(来自 worker 的 apply_patch 结果).
- 处理:
  - 从 `output.result` 提取 summary + files(before/after).
  - 生成并写入 service UI artifact 文件.
  - 生成瘦身版 `output.result`(移除 before/after).
  - 将瘦身版 output 写入 DB.

注意:

- 写 service artifact 失败时的降级策略:
  - tool 本身已经成功执行,DB 记录不应标 failed.
  - 建议:
    - 保持 tool status=completed.
    - `output.text` 仍写摘要.
    - `output.result` 写轻量 summary(无 before/after).
    - 日志记录 error,UI 展示 "diff unavailable".

### 拉取接口

新增 endpoint(建议):

- `GET /api/agent/sessions/:sessionId/context-items/:itemId/apply-patch-artifact`

服务端校验:

- item 存在且属于 sessionId.
- item.kind=tool 且 item.output.toolName=apply_patch.
- item.output.toolCallId 存在.

返回:

- 200: artifact JSON.
- 404:
  - item 不存在
  - 或 artifact 文件不存在/不可读

安全约束:

- service artifact 路径必须落在 `tmpRoot(dataDir)` 下.
- 必须拒绝 path traversal.
- 读取时必须拒绝 symlink(目录与目标).

## 前端实现方案

### 列表渲染策略

- apply_patch tool item 在列表中默认只展示:
  - tool 调用行(工具名 + args 简要)
  - summary(文件数,additions,deletions)
  - 文件列表(不含 before/after)
- 默认不 mount `MonacoDiffViewer`.

补充结论:

- 不做“联动关闭”(不强制同一时刻只允许 0/1 个 apply_patch item 或文件处于展开态).
  - 理由: 关闭其他展开项可能导致当前行位置变化/跳出屏幕,用户体验不可接受.
  - 依赖: 虚拟列表保证可视区域外的行不会长期占用 DOM.

### 按需加载 diff

- 在 apply_patch 卡片内提供交互:
  - 点击某个文件行(按文件选中与展开)
- 触发后:
  - 调用后端 artifact 拉取接口.
  - 拉取成功后,仅对用户选择的文件 mount `MonacoDiffViewer`.
  - 允许在同一 card 内缓存 artifact 内容,避免重复请求.

展开状态与缓存(建议):

- 展开状态应以 `toolCallId` 作为 key 存在父组件/Store 中,避免因虚拟列表 unmount/remount 丢失状态.
- artifact 内容缓存也建议按 `toolCallId` 缓存(而不是按 itemId),便于 fork 后复用与避免重复拉取.

为何不默认渲染 Monaco:

- 虚拟列表只减少屏幕外的渲染,无法降低屏幕内 Monaco 的初始化与 diff 计算成本.
- 默认渲染 Monaco 会导致滚动过程中频繁 unmount/remount,反复初始化编辑器,体验更差.

### 失败降级

- 当 artifact 不存在或拉取失败:
  - UI 显示轻提示(例如 "diff unavailable").
  - 仍可展示 summary 与文件列表.

## 性能与容量控制(本次仅约定)

- 后端响应体:
  - context-items 不再携带 before/after,显著减小.
- 前端:
  - Monaco diff 仅在用户交互后渲染.
  - 对大量文件的 patch,建议默认只渲染用户选中的单个文件 diff.

单层滚动条(避免双层纵向滚动):

- 目标: 会话列表使用外层滚动,Monaco 不出现独立的纵向滚动条.
- 实现注意:
  - 当前 `MonacoDiffViewer` 组件在 `maxHeight` 未传入时会使用默认上限(会引入内部滚动条).
  - 需要调整组件行为,使“不传 maxHeight”时不做高度上限 clamp(等价于 max=Infinity),让 diff 高度随内容增长.
  - 仍需配合“仅渲染选中单文件 diff”控制单次渲染体量,避免超长 diff 把列表撑到不可用.

## 测试与验收

### 后端验收

- apply_patch completed 后:
  - DB 中 result.files 不包含 before/after.
  - service UI artifact 文件存在且可读.
  - 拉取接口返回 200 并包含 before/after.

### 前端验收

- 列表加载与滚动不卡顿(相较原实现有明显改善).
- apply_patch 卡片默认不渲染 diff.
- 展开后可以加载并展示 diff.

## 开发落点(便于后续编码定位)

- 后端:
  - `apps/api/src/infra/fs/paths.ts`: 增加 service UI artifact 路径拼接函数.
  - `apps/api/src/modules/agent/agent.routes.ts`: 增加拉取接口.
  - `apps/api/src/modules/agent/agent.service.ts`: 在 worker update apply_patch tool item 时写入 artifact 并瘦身 output.

- worker:
  - `apps/agent-worker/src/runtime/runner.ts`: workspace artifact 路径改为 by_tool_call(使用 toolCallId).

- 前端:
  - `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`: apply_patch display model 改为轻量结构,不再依赖 before/after.
  - `apps/web/src/features/workspace/tools/agent/AgentApplyPatchCard.vue`: 支持按需拉取 artifact 并渲染 diff.
