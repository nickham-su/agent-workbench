# Tool Output Text Unification And Artifacts

Status: draft

## 术语

- item: 指 `agent_context_item` 的一行记录,语义上是一次事件(user/assistant/system/tool).
- prompt message: 指组装给模型的 `messages[]` 成员(role=system/user/assistant/tool),是对 items 的投影视图.
- transcript/archive line: 指归档文件中的一行文本,用于检索与回忆.
- artifact: 指存放在磁盘上的全文或大 payload,通过路径或引用与某个 item 关联.

## 背景

- 系统的 `agent_context_item` 被设计为 append-only(只允许追加,非终态允许 update),这是执行调度稳定性的基石.
- 现状中,tool item 的结果存在两条通路:
  - `output_text`: 目前通常由 `output.result` JSON stringify 得到,可读性不稳定,且可能很大.
  - 结构化 `output.result`: 对部分工具(例如 `apply_patch`, `todolist`, `subtask`)被 UI 渲染/被 prompt 投影依赖.
- 模型侧的 prompt messages 是事件序列的投影视图,与 UI/归档的事件视图天然不 1:1.
  - `assistant` item 本身只存自然语言文本,tool-call 的参数与状态必须从后续 `tool` items 回填.

## 问题

- UI/归档/模型这三类消费场景对“内容”都更友好于文本.
  - UI: 默认文本展示最稳,但少数场景需要富卡片(例如 apply_patch diff).
  - 归档: 文本最适合检索与回忆.
  - 模型: tool-result 作为上下文输入,文本可读性更好,结构化结果经常浪费 token.
- 现状存在大量 tool 特判:
  - prompt 侧为了避免 `apply_patch` 的大 payload,引入了 result projector 生成摘要.
  - UI 侧为 apply_patch/todolist/subtask 解析结构化 result 以渲染卡片.
  - 归档侧默认 stringify 结构化 result,会把 before/after 等大字段写入归档,噪声与体积都大.

## 目标

- 统一“内容通路”为文本:
  - `agent_context_item.output_text` 成为 tool 结果在 UI/归档/模型三种场景的主要内容来源.
  - tool 结构化数据退化为“元数据”(调度所需 + 少量 UI 所需),不承载结果正文.
- 建立输出截断与 artifact 机制:
  - 大输出不进入 DB 全文,`output_text` 保存可读摘要或截断内容.
  - 全文落盘到 artifact,并通过 `output_text_artifact_path` 提供可追溯指针.
- 减少 prompt 侧的 tool 专用投影逻辑:
  - `apply_patch` 的 tool-result 不再在 prompt 侧生成摘要,直接使用 tool item 的 `output_text`.

## 范围与阶段

本方案建议按阶段落地,避免一次性改动影响执行调度稳定性.

- 阶段 A(本次改造关注):
  - 模型 tool-result 输入统一改为文本(`text`/`error-text`).
  - 归档输出改为优先使用 `output_text`.
  - `apply_patch` tool-result 不再依赖 prompt projector 生成摘要.
  - `todolist` tool-result 输出降级为摘要.
  - 引入 workspace artifact 目录约定,并实现读类工具的大输出截断与落盘.
- 阶段 B(后续迭代):
  - `apply_patch` diff payload 从 DB/上下文结果迁移到 service artifact.
  - 前端列表渲染优化: apply_patch 卡片按需拉取 service artifact 并渲染 diff.

## 非目标

- 不改变 append-only 与调度状态机设计.
- 不在本次改造中实现前端“按需拉取 UI artifact 并异步渲染 apply_patch diff”的交互与列表优化.
- 不追求让事件 item 与模型 messages 1:1 对应.

## 关键决策与取舍

### 执行调度稳定优先

- 保持 tool item 一次调用一条记录,独立状态(queued/awaiting_permission/running/terminal).
- 不尝试把连续 tool 调用合并为一条记录(会使状态机表达复杂且破坏可观测性).

### 模型 messages 的 tool-result 统一使用文本

- `ai@5.x` 要求 `role: "tool"` 的 `content` 为 `tool-result` parts,其中 `output` 必须为带 `type` 的对象.
- 约定:
  - 成功: `output: { type: "text", value: <output_text> }`
  - 失败: `output: { type: "error-text", value: <error message> }`

补充:

- tool-result 仍然必须与 tool-call 通过 `toolCallId` 关联.
- 即使 tool-result 的正文变为极短摘要(例如 todolist),也必须返回一个 tool-result part 以闭合 tool-call.

### 读类工具结果长期保存: 以 artifact 为准

- `output_text` 用于 prompt 的首选输入(通常是截断/摘要).
- 全文落盘到 workspace 内 artifact,模型需要时可用 `read` 或 `bash rg` 再取.
- 这样可避免将潜在过时的资源内容长期塞进上下文,同时保留可追溯性.

补充:

- workspace 内的 `.awb/` 目录视为系统元数据目录.
  - 写入 `.awb/` 不属于用户代码修改,不受 agent permissions 的 allowWrite 约束.
  - 但必须确保不会写出 `.awb/` 目录边界.

### 服务自己查的文件 vs 给模型查的文件

- 给模型查的文件(可通过工具 read/bash 访问)应在 workspace 内.
- 服务内部用途(UI 富展示,调试 payload 等)应在服务运行目录(数据目录)内,不污染 workspace.

### todolist 的 output_text 只保留摘要

- UI 使用结构化数据渲染任务列表.
- 模型侧 tool-call input 已包含 todos,tool-result 再回显完整列表属于 token 浪费.
- 归档侧无需保留易过时的完整列表.

## 数据模型与字段语义

### agent_context_item

- `output_text`: 所有 kind 通用的可读文本通路.
  - tool: 保存 tool 执行结果的文本(或摘要/截断后的文本).
- `output_text_truncated`:
  - `0`: `output_text` 为完整文本或无需认为被截断.
  - `1`: `output_text` 为截断/摘要,完整内容在 artifact.
- `output_text_artifact_path`:
  - 当 `output_text_truncated=1` 时,提供全文 artifact 的路径(相对 workspace 的相对路径,或可解析的逻辑路径).
- `tool_call_json`:
  - 保存 tool-call 意图与参数(例如 args),以及审批标记.
- `tool_result_json`:
  - 保存少量元信息与错误信息.
  - 本次方向中不再依赖其保存结构化 result.

### AgentToolOutput 的扩展(建议)

为了让同一个 tool item 同时满足:

- UI 仍可使用结构化 `result` 渲染富卡片(例如 todolist/apply_patch)
- 模型/归档统一使用文本 `output_text`

需要在 tool output 中引入一条独立的文本字段,避免 `output_text` 被迫从 `result` stringify 得出.

建议将共享契约的 tool output 扩展为:

- `text?: string`(可选)
  - 语义: tool 结果的“可读文本通路”,用于 `output_text`.
  - 优先级: 当存在 `text` 时,写库与 prompt/归档应优先使用它.
  - `result` 仍可保留为结构化 payload,仅供 UI/内部逻辑使用.

注意:

- 这不会改变 append-only 语义,只是扩充 `output` 的 shape.
- 这是为阶段 A 服务的关键前置,否则 apply_patch/todolist 无法同时保留结构化 UI payload 与文本化模型输入.

## Artifact 目录约定

### Workspace artifacts(给模型查)

- 目录根: `<workspace>/.awb/agent/artifacts/<sessionId>/`
- 目录用途:
  - 保存 tool 输出全文(或大段内容)的副本.
  - 供模型通过 read/bash 再次读取或检索.
- 文件命名建议:
  - `<itemId>.<toolName>.txt` 或 `<itemId>.txt`

建议细化:

- 为了便于按时间顺序浏览,建议对 `itemId` 做固定宽度补零:
  - `<itemIdPadded> = String(itemId).padStart(8, "0")`
  - 文件名: `<itemIdPadded>.<toolName>.txt`
- 同一 itemId 只写入一次,避免并发覆盖.
- `output_text_artifact_path` 建议存储 workspace 相对路径,例如:
  - `.awb/agent/artifacts/<sessionId>/00001234.read.txt`

安全约束:

- artifact 路径必须是 workspace 相对路径,且必须落在 `.awb/agent/artifacts/<sessionId>/` 下.
- 必须拒绝:
  - 绝对路径
  - 包含 `..` 段
  - 包含 `\0`/换行符
- 写入时必须以 workspace 根目录为基准 resolve,并做边界校验(避免 path traversal).
- read/bash 工具访问 artifact 文件时,应复用相同的路径安全规则.

### 截断阈值与文本预算(建议)

建议引入以下常量(可通过 env 覆盖,避免硬编码):

- `AWB_TOOL_OUTPUT_TEXT_MAX_CHARS`:
  - `output_text` 的最大字符数(默认建议 8_000).
  - 目的: 控制 prompt token 与 DB 体积.
- `AWB_TOOL_OUTPUT_TEXT_PREVIEW_CHARS`:
  - 当截断时保留的正文 preview 长度(默认建议 3_000).
- `AWB_TOOL_ARTIFACT_MAX_CHARS`:
  - 写入 artifact 的最大字符数(默认建议 200_000).
  - 目的: 避免意外把超大二进制/长输出写爆磁盘.

约束:

- 所有工具输出都应先做 UTF-8 文本化,并清理 `\0` 字符.
- 当超过 `AWB_TOOL_ARTIFACT_MAX_CHARS` 时:
  - artifact 只写入前缀并在末尾追加明确标记(例如 `[truncated]`).
  - `output_text_truncated` 仍应置为 1.

### Service artifacts(服务内部用途,例如 UI diff payload)

- 落在服务数据目录下的某个稳定子目录(例如 `AWB_DATA_DIR/agent/artifacts/...`).
- 不通过 read/bash 暴露给模型.
- 本次仅定义约定,不实现前端拉取与渲染(阶段 B 再做).

建议的引用方式:

- tool item 的 `tool_result_json.meta` 存储 `uiArtifactId`(而不是绝对路径).
- 后续提供内部 API: `GET /api/agent/ui-artifacts/:id` 供前端按需拉取.

## 工具级输出策略

本节定义 tool item 的 `output_text` 应该如何组织.

### 通用文本协议(建议)


`output_text` 建议采用 "头部 key: value + 空行 + 正文" 的格式.

- 头部固定字段(建议每行一个字段,字段名小写,便于 rg 搜索):
  - `tool: <toolName>`
  - `status: <completed|failed|...>`
  - `artifact: <workspace-relative-path>`(可选,仅当有全文 artifact 时)
  - `note: <short hint>`(可选)
- 空行
- 正文:
  - 成功: 人类可读摘要或 preview.
  - 失败: 可留空,失败信息用 `error-text` 输出.

推荐标记:

- 当正文为 preview 时,末尾追加单行标记:
  - `[truncated]`

### tool-specific 头部字段(建议)

在通用头部字段之外,允许少量 tool-specific 字段,但必须满足:

- 不依赖结构化解析即可读懂.
- 字段数量尽量少,避免重复 args.
- 字段名保持稳定,便于 rg 搜索.

建议字段:

- read:
  - `source: <filePath>`
  - `range: <offset>-<offset+limit-1>`(可选)
- bash:
  - `command: <command>`(建议截断)
  - `exit_code: <n>`
  - `timed_out: <true|false>`(可选)
- apply_patch:
  - `files: <n>`
  - `additions: <n>`(可选)
  - `deletions: <n>`(可选)
- todolist:
  - `total: <n>`
  - `pending/in_progress/completed/cancelled: <n>`(可选)
- subtask:
  - `subtask_session_id: <id>`

失败场景:
- `output_text` 应为短错误说明(可包含关键参数摘要,但不要复制全部 args).
- prompt 侧用 `error-text` 输出.

补充:

- 对于失败场景,建议 `output_text` 也写入一段可读错误摘要,便于 UI/归档阅读.
  - 但模型侧仍用 `error-text` 作为 tool-result.

### read/bash 等读类工具


- `output_text`:
  - 默认存短摘要 + 少量 preview.
  - 当输出超过 `AWB_TOOL_OUTPUT_TEXT_MAX_CHARS`:
    - 设置 `output_text_truncated=1`.
    - 全文写入 workspace artifact.
    - 头部写入 `artifact:`.
- artifact 内容建议包含:
  - 与 `output_text` 相同的头部字段(便于独立阅读).
  - 全文正文.
- 模型侧:
  - tool-result 直接使用 `output_text`.
  - 模型需要全文时,可用 read/bash 读取 artifact.

建议约束:

- 对 read 工具:
  - `output_text` 的正文 preview 不必包含全部返回,可以只保留前若干行,其余依赖 artifact.
  - 头部应包含 `source:`,让模型优先考虑直接 read 原始资源(更准确),artifact 作为快照备用.
- 对 bash 工具:
  - 头部应包含 exit_code 等关键信息.
  - stdout/stderr 建议合并为一段可读正文,过大则落 artifact.

### apply_patch

- `output_text`:
  - 成功时存简洁摘要,例如 "Success. Updated the following files:\nA ...\nM ...".
  - 不在 `output_text` 中包含 before/after diff payload.
- 模型侧:
  - tool-result 直接使用 `output_text`.
  - 不再在 prompt 侧对 result 做摘要投影.
- UI 侧:
  - 本次不实现 "前端拉取 service artifact 并渲染 diff".
  - 阶段 A 允许 UI 继续依赖结构化 `result` 进行卡片渲染.
- service artifact(规划):
  - diff payload 未来改为存服务数据目录,tool item 仅保存引用.

注意:

- 即使阶段 A 仍保留结构化 `result` 供 UI 使用,模型与归档也必须只消费 `output_text`.
  - 这要求 tool output 同时提供 `text` 与 `result`.

### todolist

- `output_text`:
  - 仅存摘要,例如 "Todo list updated: total=10" 或 "已设置 10 项任务".
  - 不存完整 todos 列表.
- 模型侧:
  - tool-call input 已携带 todos,tool-result 不重复输出.
- UI 侧:
  - 继续使用结构化 todos 渲染.

建议摘要包含最少量的状态信息,便于归档检索:

- `Todo list updated: total=<n>`
- 可选追加: `pending=<n> in_progress=<n> completed=<n> cancelled=<n>`

额外约束:

- tool-result 的 `output_text` 不应重复完整 todos.
- UI 与调度仍可使用结构化 `result`/`args`.

### subtask(参考)

- `output_text`:
  - 建议存摘要(包含 subtaskSessionId 与简短结果概述),必要时截断并落 workspace artifact.
- UI:
  - 入口卡片依赖 subtaskSessionId,不依赖结果全文.

## Prompt 组装逻辑调整(概念)

- tool-call part:
  - 继续从 tool item 的 args 投影为 `input`.
  - `apply_patch` 维持保留 `patchText` 原文在 tool-call input 中.
- tool-result part:
  - 统一使用 tool item 的 `output_text`.
  - 不再解析结构化 `result` 以生成摘要.

建议细化为:

- tool-result output:
  - completed: `{ type: "text", value: <output_text> }`
  - failed/denied/cancelled: `{ type: "error-text", value: <error> }`

并建议 prompt 侧彻底避免 stringify 结构化 `result`.

补充:

- 由于 tool-call input 已携带 args,tool-result 的正文应优先承载“执行结果/反馈”,而不是重复参数.
- 对写操作类工具(例如 apply_patch/write):
  - tool-call 表达意图.
  - tool-result 只需表达执行状态与摘要.
- 对读操作类工具(例如 read/bash/archive_read/archive_search):
  - tool-call 表达资源/查询.
  - tool-result 用文本表达结果,并在需要时给出 artifact 指针.

## 归档输出调整(概念)

- 归档写入优先使用 `output_text`.
- 当 `output_text_truncated=1` 时,归档中保留 artifact 指针,而不写入全文.
- 归档不再 stringify 结构化 tool result.

建议归档行中固定包含:

- `item=<id> ts=<ms> kind=<kind> status=<status> tool=<toolName>`
- `artifact=<path>`(当存在时)

并建议:

- 归档的 tool 行只记录摘要与指针,不记录可过时的大段资源内容.
- 对于读类工具,归档中保留 `source:` 更有价值.

## 兼容性与迁移

- 现有历史记录可能仍包含结构化 `output.result` 并通过 stringify 落入 `output_text`.
- 新写入的 tool item 应遵循本方案,逐步减少对结构化 result 的依赖.
- `apply_patch` 等工具的 prompt projector 可先保留但逐步降级为 no-op,最终删除.

建议迁移顺序:

- 先扩展契约与写入逻辑,让 tool item 能同时写入 `text` 与 `result`.
- 再改 prompt 与归档消费路径,优先使用 `text`.
- 最后逐步削减 UI 对结构化 payload 的依赖,并在阶段 B 引入 service artifact.

## 风险与缓解

- UI 体验下降风险:
  - apply_patch diff 富展示暂时无法从 artifact 拉取,需要后续前端优化补齐.
  - 缓解: 保持 `output_text` 摘要可读,并保留现有结构化路径直至前端就绪.
- Artifact 生命周期与磁盘增长:
  - 需要后续引入清理策略(按 session 删除/按容量上限淘汰/按 archive_at 清理等).
- 模型重复读取成本:
  - 读类工具改为 "摘要 + 指针" 后,模型可能触发二次 read/bash.
  - 缓解: 头部字段清晰,让模型只在必要时读取全文.

## 后续工作(不在本次实现范围)

- 前端列表渲染与富卡片的异步拉取机制(尤其 apply_patch diff).
- service artifact 的 HTTP API 或内部读取方式(供前端拉取).
- artifact 清理与配额策略.

## 可能的实现落点(便于后续编码)

本节不作为强约束,用于快速定位改动点.

- 共享契约:
  - `packages/shared/src/contracts/agent.ts`: 为 tool output 增加 `text?: string`.
- DB 写入映射:
  - `apps/api/src/modules/agent/agent.store.ts`: tool 的 `output_text` 优先取 `output.text`,其次再回退 stringify `result`.
- prompt 组装:
  - `apps/api/src/modules/agent/agent.service.ts`: tool-result 的 `output` 由 `json` 改为 `text`,并优先使用 tool 的 `output.text`(或 `output_text`).
  - 同时移除/禁用 `apply_patch` 的 result projector.
- 归档:
  - `apps/api/src/modules/agent/agent.service.ts`: `buildArchiveLine` 优先使用 `output.text`.
- 读类工具 artifact:
  - `apps/agent-worker/src/runtime/runner.ts` 以及各 tool 实现: 当输出过大时写入 workspace `.awb/agent/artifacts/...` 并返回 `text` 作为摘要.

## 示例

本节给出建议的 `output_text` 示例,用于对齐实现与评审.

### read(截断 + artifact)

```text
tool: read
status: completed
source: src/app.ts
range: 1-200
artifact: .awb/agent/artifacts/ses_x/00001234.read.txt

1: import ...
2: ...

[truncated]
```

### bash(截断 + artifact)

```text
tool: bash
status: completed
command: rg -n "agent_context_item" -S .
exit_code: 0
artifact: .awb/agent/artifacts/ses_x/00001235.bash.txt

agent-workbench/apps/api/src/infra/db/schema.ts:140: create table if not exists agent_context_item (

[truncated]
```

### apply_patch(摘要)

```text
tool: apply_patch
status: completed
files: 3
additions: 42
deletions: 10

Success. Updated the following files:
A src/new.ts
M src/app.ts
D src/old.ts
```

### todolist(仅摘要)

```text
tool: todolist
status: completed
total: 7
pending: 5
in_progress: 1
completed: 1

Todo list updated.
```

### subtask(摘要)

```text
tool: subtask
status: completed
subtask_session_id: ses_sub_123

Subtask finished successfully.
```
