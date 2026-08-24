# Context Item 存储字段拆分方案(v2)

本方案只聚焦 DB 表字段调整与代码可行性约束,不包含上下文管理、历史搜索、投影文件生成等功能设计。

## 背景

- 当前 `agent_context_item.output_json` 承载所有类型消息(user/assistant/tool/system)的全部信息。
- 读取侧(UI 展示、prompt-context 组装、调试)需要频繁 `JSON.parse` 才能判断语义,并且 tool 的 result 可能较大,会拖累 DB 体积与读写性能。
- 权限审批流目前通过 tool item 的 `output.approved` 字段传递,与“消息内容”耦合较强。

## 目标

- 将 `output_json` 拆分为更直接的列,降低读写复杂度,并为后续“历史消息投影(一行一条 item)”打基础。
- 统一所有 kind 的“可读文本通路”:新增 `output_text`,tool 的输出也存 `output_text`,保证模型总能看到 tool 输出。
- tool 的结构化数据分为两类:
  - `tool_call_json`: 工具名、toolCallId、args,以及审批状态(approved)都放这里。
  - `tool_result_json`: 只保存工具执行状态与少量补充(meta/error),不在 DB 中保存结构化 result。
- 增加 `tool_name` 冗余列,便于查询、渲染分流与减少 JSON.parse。

## 非目标

- 不设计或实现 transcript/投影文件的生成与增量维护。
- 不实现历史搜索(无论是 rg/子串/FTS/语义检索)。
- 不引入 artifact 系统与截断策略(后续再补)。

## 数据模型

### 主表: agent_context_item

保留现有链表与运行字段:

- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `workspace_id` TEXT NOT NULL
- `session_id` TEXT NOT NULL
- `run_id` TEXT
- `turn_id` TEXT
- `step` INTEGER
- `prev_id` INTEGER
- `kind` TEXT NOT NULL 取值: `user|assistant|tool|system`
- `status` TEXT NOT NULL 取值沿用现有: `streaming|queued|running|awaiting_permission|completed|failed|denied|cancelled`
- `created_at` INTEGER NOT NULL
- `updated_at` INTEGER NOT NULL

新增/替换列:

- 文本列(四种 kind 通用)
  - `output_text` TEXT NOT NULL DEFAULT ''
  - `output_text_truncated` INTEGER NOT NULL DEFAULT 0
  - `output_text_artifact_path` TEXT NULL
- tool 专用列
  - `tool_name` TEXT NULL
  - `tool_call_id` TEXT NULL
  - `tool_call_json` TEXT NULL
  - `tool_result_json` TEXT NULL

说明:

- `output_text_*` 先按预留字段加入,当前不实现截断与 artifact,因此 `output_text_truncated/output_text_artifact_path` 在 v2 初期可以恒为默认值。
- `tool_name` 为冗余列,内容应与 `tool_call_json.toolName` 保持一致。

### tool_call_json 形状(建议)

该字段用于保存“工具调用意图与参数”,并承载审批状态。

```json
{
  "toolName": "bash",
  "toolCallId": "turn_x_call_1",
  "args": { "command": "rg -n ...", "workdir": "." },
  "approval": { "approved": true }
}
```

约束:

- `approval.approved` 仅当触发审批时使用,未审批或不需要审批时可以省略该对象。
- `apply_patch.patchText` 按既定结论内联存入 `args.patchText`。

### tool_result_json 形状(建议)

该字段只保存状态与少量补充信息,不保存结构化 result。

```json
{
  "status": "completed",
  "error": null,
  "meta": { "exitCode": 0, "timedOut": false }
}
```

约束:

- `status` 建议与 `agent_context_item.status` 保持一致(或可省略 `status`,仅存 `error/meta`)。
- 不存 `result` 对象,避免 DB 重复保存。

## 写入与更新规则

### kind=user|assistant|system

- `output_text` 保存对应文本。
- tool 相关列(`tool_name/tool_call_id/tool_call_json/tool_result_json`)必须为空。
- assistant 流式时仅更新 `output_text` 与 `status`(保持现有“非终态可更新,终态冻结”规则)。

### kind=tool

- 创建 tool item(queued/awaiting_permission)时必须写入:
  - `tool_name`
  - `tool_call_id`
  - `tool_call_json`(至少包含 toolName/toolCallId/args)
- 工具执行完成后必须写入:
  - `status` -> terminal
  - `output_text` -> 给模型消费的工具输出文本(可为短文本)
  - `tool_result_json` -> 状态补充(meta/error)

注意:

- 由于 `tool_result_json` 不保存结构化 result,所有依赖结构化 result 的 UI 展示与 prompt 投影逻辑需要调整或降级为文本。

## 审批流改造要点(可行性关键)

现状依赖 `output.approved` 来让 worker 判断是否已批准并继续执行。该字段将被移除,替代方案:

- 批准时:
  - 保持 `status` 从 `awaiting_permission` 回到 `queued`
  - 更新 `tool_call_json.approval.approved = true`
- 拒绝时:
  - `status` 变为 `denied`
  - `tool_result_json.error = "permission denied"`

worker 侧:

- 从 prompt-context 的 `pendingTools` 中继续接收 `approved` 布尔值,但该值不再来自 item.output.approved,而是由 API 从 `tool_call_json.approval.approved` 推导。
- 这样可以避免为审批单独引入新表,同时也符合“审批状态放在 tool_call_json”这一决策。

## prompt-context 组装影响(可行性结论)

现状 API `getPromptContextForRun` 依赖 `item.output.type` 来构建 messages。改造后数据来源变更如下:

- user: message content 来自 `output_text`
- assistant: message content 来自 `output_text`
- system: system prompt 仍按现有方式拼接(与本方案无关)
- tool-call: 来自 `tool_call_json`(必要时通过现有 projector 对 args 做摘要/保留策略)
- tool-result: 来自 `output_text`(主要内容) + `tool_result_json.error`(失败补充)

由于 `tool_result_json` 不保存结构化 result,tool-result 消息可以统一使用文本或 JSON 包裹文本,无需依赖 per-tool 的结构化 projector。

## UI 渲染影响(可行性结论)

现状前端依赖 `item.output.type` 与 `item.output.result/args` 来生成 rich tool card(如 apply_patch/todolist)。采用本方案后:

- UI 需要从以下字段渲染:
  - user/assistant/system: `output_text`
  - tool: `tool_name + tool_call_json(args 摘要)` 作为调用文本,执行结果可选择展示 `output_text` 的短预览
- rich tool card 可能需要降级为通用 tool 行(除非前端仍能从 `tool_call_json.args` 解析出需要的信息,例如 apply_patch 的 patchText/文件列表等)。

## 代码改造范围评估(仅结论)

按当前代码结构,表字段拆分是可以实现的,但必须同步改造以下模块的数据映射:

- DB schema 初始化与索引(`apps/api/src/infra/db/schema.ts`)
- Store 层读写(append/update/read)从 `output_json` 改为新列(`apps/api/src/modules/agent/agent.store.ts`)
- Service 层 prompt-context 组装(`apps/api/src/modules/agent/agent.service.ts`)
- Worker internal API 调用的 payload 形状(可选择兼容层或一次性升级)(`apps/agent-worker/src/runtime/apiClient.ts` + `apps/agent-worker/src/runtime/runner.ts`)
- Web UI 对 `AgentContextItemRecord` 的渲染逻辑(`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`)
- Shared contracts: `AgentContextItemOutput` 将不再与 DB 存储一一对应,需新增 v2 record 形状或提供兼容层(`packages/shared/src/contracts/agent.ts`)

## 风险与规避

- 审批流断裂风险
  - 规避: 将批准状态明确落在 `tool_call_json.approval.approved`,并由 API 计算 `pendingTools[].approved` 给 worker。
- tool rich card 信息丢失
  - 规避: 允许 UI 降级为通用 tool 行,或在必要时从 `tool_call_json.args` 推导展示字段。
- output_text 过大导致 DB 膨胀
  - 规避: 本 v2 仅完成字段拆分,后续再引入截断与 artifact(已预留字段)。

## 验证点(建议)

- 基础链路
  - user 发送消息 -> 生成 user item(output_text)
  - worker 生成 assistant item(output_text streaming->completed)
  - tool queued->completed 后 `output_text` 有值,且下一 step prompt 能看到 tool 输出
- 审批链路
  - tool awaiting_permission -> approve 后 tool_call_json.approval.approved=true,worker 可继续执行
  - deny 后 status=denied,tool_result_json.error=permission denied
