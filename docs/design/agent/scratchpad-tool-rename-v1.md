# Rename builtin tool `note` -> `scratchpad` (v1)

Status: draft

## 背景与目标

当前系统将 `note` 作为一个**内置工具(builtin tool)** 的 canonical tool name（贯穿 shared contracts / API / agent-worker / web / tests）。

本方案的目标是在项目未上线阶段，将该工具的 canonical name 从 `note` **统一改名**为 `scratchpad`。

目标：

- 统一 canonical tool name：`note` → `scratchpad`
- 保持工具语义不变：仍为“向运行时会话状态写入一段短文本(working memory)”
- 全链路同步：shared / API / worker / web / tests 一次性改完，避免出现“后端允许但 worker 不支持 / UI 不渲染”等不一致

## 非目标

本方案明确“不做兼容”，因此以下不在范围内：

- 不兼容旧 toolName：不再接受或识别 `toolName: "note"`
- 不迁移/保留历史数据（包括历史 session transcript 中 toolName=note 的回放/渲染）
- 不做灰度、双写、alias mapping（如 `note` 作为 `scratchpad` 的别名）
- 不保证旧测试/旧配置可继续工作（需要同步更新）

## 变更范围(模块级)

| 模块 | 影响点 | 说明 |
|---|---|---|
| `packages/shared` | tool name schema | 否则 API / worker / web 的类型校验会直接拒绝 `scratchpad` |
| `apps/api` | tool 白名单、promptContext 下发、schema/description、持久化策略 | 否则 prompt-context tools 列表不一致或校验失败 |
| `apps/agent-worker` | builtin tool 名单、provider 执行分支、tool output text 渲染、实现文件 | 否则 worker 无法执行新工具名或输出不统一 |
| `apps/web` | tool output 特化渲染、字段名、组件命名、i18n | 否则 UI 会把 scratchpad 结果当普通 tool 输出或 label 缺失 |
| tests | integration/unit | 大量断言包含 `"note"`、`note.content`、`Note saved` 等 |

## 关键设计决策

### 1) canonical tool name

- 决策：canonical tool name 统一为 `scratchpad`
- 不做兼容：系统内部任何判断/白名单/枚举不再包含 `note`

证据(当前存在的 note canonical name)：

- API 路由白名单：`apps/api/src/modules/agent/agent.routes.ts` `AgentBuiltinToolNameSchema` 包含 `Type.Literal("note")`
- API baseline tools：`apps/api/src/modules/agent/agent.service.ts` `baselineToolNames` 包含 `"note"`
- Worker builtin tools：`apps/agent-worker/src/runtime/tools/types.ts` `BUILTIN_TOOL_NAMES` 包含 `"note"`
- Web 特化渲染：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` 判断 `item.output.toolName === "note"`

### 2) 是否重命名 worker 实现文件

当前实现文件为：

- `apps/agent-worker/src/runtime/note.ts`（导出 `parseNoteArgs/toNoteResult`）

决策：**重命名实现文件与导出符号**，保持语义一致，避免出现“scratchpad 工具由 note.ts 实现”的概念错位。

建议落地：

- `note.ts` → `scratchpad.ts`
- `parseNoteArgs/toNoteResult` → `parseScratchpadArgs/toScratchpadResult`
- 错误信息：`note.content must be a string` → `scratchpad.content must be a string`

### 3) UI 字段命名：`noteContent` vs `scratchpadContent`

`AgentClientPane.vue` 当前为 note 特化卡片引入了 `DisplayItem.noteContent?: string`，并渲染 `AgentNoteCard`。

决策：项目未上线，选择一次性把 UI 字段也改为 `scratchpadContent`，并将组件重命名为 `AgentScratchpadCard`（可读性更好）。

替代方案(更小改动，但不推荐)：保留 `noteContent` 字段名，仅改 toolName 判断为 `scratchpad`。

## 实施清单（按执行顺序，逐文件）

说明：以下清单以“只改名、不兼容”为前提。每一步都应保持编译可前进；建议先改 shared → API → worker → web → tests。

### 1. Shared contracts（类型/协议）

1) `packages/shared/src/contracts/agent.ts`

- 将 `AgentContextToolNameSchema` 内的 `Type.Literal("note")` 改为 `Type.Literal("scratchpad")`

证据：`agent.ts:18` 命中 `Type.Literal("note")`。

2) `packages/shared/src/contracts/settings.ts`

- 将 `AgentToolNameSchema` 内的 `Type.Literal("note")` 改为 `Type.Literal("scratchpad")`

证据：`settings.ts:203` 命中 `Type.Literal("note")`。

### 2. API（白名单、schema/description、baseline tool、持久化）

3) `apps/api/src/modules/agent/agent.routes.ts`

- `AgentBuiltinToolNameSchema`：`Type.Literal("note")` → `Type.Literal("scratchpad")`

证据：文件顶部 `AgentBuiltinToolNameSchema` 列表包含 `Type.Literal("note")`（约第 43-53 行）。

4) `apps/api/src/modules/agent/agent.service.ts`

4.1 工具参数 schema

- `toolArgsSchema(toolName)`：`if (toolName === "note")` → `if (toolName === "scratchpad")`

证据：`agent.service.ts:183`。

4.2 工具描述

- `toolDescription(toolName)`：`if (toolName === "note")` → `if (toolName === "scratchpad")`
- 描述文本中如果出现 `note` 字样，同步改为 `scratchpad`（保持面向模型的说明一致）

证据：`agent.service.ts:465`。

4.3 baseline tools

- `baselineToolNames = ["read","todolist","archive_search","archive_read","note"]` → 替换为 `"scratchpad"`

证据：`agent.service.ts:4037`。

5) `apps/api/src/modules/agent/agent.store.ts`

- `shouldPersistStructuredResult` 条件中：`toolName === "note"` → `toolName === "scratchpad"`

证据：`agent.store.ts:193`。

6) `apps/api/src/modules/settings/settings.service.ts`

- `normalizeAgentTools()`
  - 注释：`Baseline tools (read/todolist/note/archive_*)` → `.../scratchpad/...`
  - 过滤逻辑：
    - `item !== "note"` → `item !== "scratchpad"`
    - `if (item === "read" || ... || item === "note" || ...) continue;` → 替换为 `scratchpad`

证据：该函数位于 `settings.service.ts` 约 485 行附近，存在 `item !== "note"` 与 `item === "..." || item === "note" ...`。

7) `apps/api/src/modules/agent/agent.integration.test.ts`

- 将测试数据与断言中的 `note` 全部替换为 `scratchpad`
  - `tools: ["bash","read","note",...]` → `..."scratchpad"...`
  - `find((item) => item.name === "note")` → `..."scratchpad"...`
  - 断言 `noteTool` 改名为 `scratchpadTool`（变量名可选，但建议统一）

证据：

- `agent.integration.test.ts:544` tools 数组包含 `"note"`
- `agent.integration.test.ts:572` 查找 `item.name === "note"`

### 3. agent-worker（builtin 名单、provider、runner、实现与测试）

8) `apps/agent-worker/src/runtime/tools/types.ts`

- `BUILTIN_TOOL_NAMES`：`"note"` → `"scratchpad"`

证据：`types.ts:75-85` 列表包含 `"note"`。

9) `apps/agent-worker/src/runtime/tools/providers/builtin.ts`

9.1 baseline 永远启用

- `isToolEnabled()`：`... || toolName === "note"` → `... || toolName === "scratchpad"`

证据：`builtin.ts:117-123`。

9.2 执行分支

- `case "note"` → `case "scratchpad"`
- 并更新调用的 parser/result 函数名（见第 11 步实现文件重命名）

证据：`builtin.ts` 存在 `case "note"`，当前调用 `parseNoteArgs/toNoteResult`。

10) `apps/agent-worker/src/runtime/runner.ts`

- tool output text 特化渲染：`if (params.toolName === "note")` → `..."scratchpad"...`
- 文案：`"Note saved"` / `"Note saved (empty content)"` → `"Scratchpad saved"` / `"Scratchpad saved (empty content)"`

证据：`runner.ts:236-244`。

11) `apps/agent-worker/src/runtime/note.ts` → `scratchpad.ts`

- 重命名文件与导出：
  - `parseNoteArgs` → `parseScratchpadArgs`
  - `toNoteResult` → `toScratchpadResult`
- 错误消息：`note.content must be a string` → `scratchpad.content must be a string`
- 常量名可同步：`NOTE_MAX_CHARS` → `SCRATCHPAD_MAX_CHARS`（可选）

证据：当前 `note.ts` 明确抛错 `note.content must be a string`。

12) worker tests

- `apps/agent-worker/src/runtime/note.test.ts`
  - import 路径与函数名更新
  - 测试名称/断言中的 `note.content` 正则更新为 `scratchpad.content`
- `apps/agent-worker/src/runtime/runner.note-output.test.ts`
  - `toolName: "note"` → `"scratchpad"`
  - 断言 `tool: note`、`Note saved` 改为 scratchpad 对应文本

### 4. Web（渲染分支、字段名、组件、i18n）

13) `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

13.1 toolName 特化分支

- `if (item.output.toolName === "note")` → `..."scratchpad"...`
- `isNoteCard(item)` 内的 `item.toolName === "note"` → `scratchpad`

证据：该文件存在 `item.output.toolName === "note"`（约 1098 行）与 `item.toolName === "note"`（约 1382 行）。

13.2 字段与组件重命名（推荐）

- `DisplayItem.noteContent?: string` → `DisplayItem.scratchpadContent?: string`
- 局部变量 `noteContent` → `scratchpadContent`
- template：
  - `AgentNoteCard` → `AgentScratchpadCard`
  - `:content="item.noteContent || ''"` → `:content="item.scratchpadContent || ''"`

证据：template 中存在 `<AgentNoteCard ... :content="item.noteContent || ''" />`。

14) `apps/web/src/features/workspace/tools/agent/AgentNoteCard.vue`

- 重命名为 `AgentScratchpadCard.vue`（组件内部结构可不变，仅语义改名）
- 同步更新 `AgentClientPane.vue` 的 import

15) i18n

- `apps/web/src/shared/i18n/locales/en-US.ts`
  - `tools: { note: "Note" }` → `tools: { scratchpad: "Scratchpad" }`
- `apps/web/src/shared/i18n/locales/zh-CN.ts`
  - `tools: { note: "Note" }` → `tools: { scratchpad: "Scratchpad" }`（或更符合中文的展示文本）

证据：

- `en-US.ts:938` 存在 `note: "Note"`
- `zh-CN.ts:936` 存在 `note: "Note"`

## 验收清单

### 编译/静态检查

- [ ] `packages/shared` TypeScript 构建通过
- [ ] `apps/api` TypeScript 构建通过
- [ ] `apps/agent-worker` TypeScript 构建通过
- [ ] `apps/web` TypeScript/Vue 构建通过

### 测试

- [ ] `apps/api/src/modules/agent/agent.integration.test.ts` 通过（包含 prompt-context tool schema/description 的断言）
- [ ] `apps/agent-worker/src/runtime/note.test.ts`（重命名后对应测试文件）通过
- [ ] `apps/agent-worker/src/runtime/runner.note-output.test.ts`（重命名后对应测试文件）通过

### 手工验收(建议)

- [ ] 启动完整链路后，在对话中触发 `scratchpad` 工具调用
- [ ] UI 中显示 scratchpad 卡片（不应退化为普通 tool 文本输出）
- [ ] 失败场景（content 非 string）错误信息应包含 `scratchpad.content`，便于定位

## 风险与回滚思路

### 风险

- **Breaking change**：任何仍发送/存储 `toolName: "note"` 的数据将无法被新版本识别。
  - 由于项目未上线，本方案接受此风险。
- UI 字段与组件改名可能带来漏改（例如 `noteContent` / `AgentNoteCard` 的引用点）。
- i18n key 改名后，若仍有地方引用 `tools.note` 会出现缺失或 fallback。

### 回滚思路

项目未上线阶段回滚优先级较低，但仍建议保留明确路径：

1) 若发布后发现问题，最直接回滚是将 canonical name 从 `scratchpad` 改回 `note`，并恢复对应枚举/分支/测试。
2) 若只出现 UI 展示问题，可优先回滚/还原 Web 层字段与组件命名（保持工具名为 scratchpad），将渲染降级为普通 tool 文本输出作为临时止血方案。

## 附：全仓自检搜索关键词(用于收尾)

完成改动后建议全仓确认不再出现以下关键字（可用于 rg 自检）：

- `Type.Literal("note")`
- `toolName === "note"`
- `case "note"`
- `baselineToolNames.*note`
- `BUILTIN_TOOL_NAMES.*note`
- `note.content`
- `AgentNoteCard` / `noteContent`
- i18n: `tools: { ... note: ... }`
