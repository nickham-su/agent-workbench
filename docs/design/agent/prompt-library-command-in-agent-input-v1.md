# 提示词库条目新增“指令(command)”配置，并支持 AI Agent 输入框 `/` 指令候选与发送替换（v1）

## 背景与现状

agent-workbench 已有“提示词库（Prompt library）”能力：

- Settings key：`agent_global_prompts_v1`
  - Shared contract：`packages/shared/src/contracts/settings.ts`（`AgentGlobalPromptItemSchema`）
  - API：`apps/api/src/modules/settings/settings.service.ts`（`getAgentGlobalPromptSettings` / `updateAgentGlobalPromptSettings` / `sanitizeAgentGlobalPromptItemsStored`）
  - Web 设置页：`apps/web/src/features/settings/components/AgentGlobalPromptsSettingsPanel.vue`
- 运行时 system prompt 相关保留条目：`global_system_prompt`
  - 设计文档：`docs/design/agent/global-system-prompt-in-settings-v1.md`

前端 AI Agent 输入框当前已具备基础的 `/` slash 候选与命令执行能力：

- UI 组件：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
- Slash 候选与解析：`apps/web/src/features/workspace/tools/agent/agentInputCandidates.ts`
  - `isSlashMode(text)`：`trimStart().startsWith("/")`
  - `buildSlashCommandHint`：对内置命令做前缀匹配候选
  - `resolveSlashCommand`：对“精确命中”的内置命令进行解析
- 当前内置 slash 命令：`/compact`、`/clear`
  - `AgentClientPane.vue` 中 `slashCommands` 定义
  - `onSend()`：优先 `resolveSlashCommand(text, slashCommandMap)`，命中则走 `executeSlashCommand`；否则走 `sendAgentMessage` 发送普通 user message

现状问题：

1. `/` 仅支持少量内置命令，无法让用户把常用提示词（例如“请用表格输出”“按 XXX 格式总结”）以短指令的方式快速复用。
2. 提示词库中的条目只能被 Agent profile 选择后用于 system 拼接（全局提示词注入），无法作为输入框的“快捷输入/片段替换”。
3. 前端 slash 候选、发送链路与内置命令高度绑定，缺少“用户可配置 slash 候选”的数据来源。

本方案在不改变既有内置命令语义的前提下，为提示词库条目新增 `command` 字段，并让 Agent 输入框支持：

- `/` 触发候选匹配（包含内置命令 + 用户配置命令）
- 在发送时将用户输入 `/command` 替换为对应提示词库条目的 `prompt` 内容，作为 user message 发送

> 备注：该能力属于“输入增强/快捷指令”，不改变运行时 system prompt 的拼接策略。

---

## 目标

- 为 `agent_global_prompts_v1.items[]` 增加可选字段 `command`，用于定义 slash 指令名。
- Web 设置页支持配置该字段（创建/编辑时可填）。
- Agent 输入框在 slash 模式下提供 `/command` 候选：
  - 候选包含：内置 `/compact`、`/clear` + 用户配置的 prompt commands。
  - 候选选择后把输入框内容替换为对应 `/command`（与现有 slash 交互保持一致）。
- 发送链路支持替换：当用户发送 `/command` 且该 command 对应提示词库条目时，发送内容改为该条目的 `prompt`。
- 完整的冲突/校验规则：
  - `command` 唯一性
  - 与内置命令冲突
  - 保留项 `global_system_prompt` 不允许设置 command
  - 兼容旧数据（缺失 command 字段）

## 非目标

- 不引入“带参数”的模板指令（如 `/summarize foo=bar`）。v1 仅支持“整条消息 = `/command`”的替换。
- 不新增后端独立“commands 列表”接口；复用现有 `GET /api/settings/agent/global-prompts`。
- 不改变提示词库条目被 Agent profile 选择后注入 system prompt 的行为。
- 不将 prompt command 作为“工具/控制指令”写入事件模型；仍然只是一条 user message 文本替换。
- 不实现跨 workspace 的不同命令集（命令全局生效）。

---

## 用户体验与交互规则

### 1) 设置页（提示词库）

入口：Settings Tab「提示词库」

- 组件：`apps/web/src/features/settings/components/AgentGlobalPromptsSettingsPanel.vue`
- 现状表单字段：`id/title/prompt`

v1 交互新增：

- 在“新增/编辑提示词库条目”的弹窗表单中新增字段：
  - `command`（可选）
  - 形态：单行输入框（或带前缀提示的输入框）
  - 展示文案建议：
    - 标签：`指令(可选)`
    - placeholder：`例如 summarize（将以 /summarize 触发）`
    - help：
      - “仅支持字母/数字/下划线/中划线；不含空格；不需要填写 /；留空则不作为指令。”
      - “若与内置命令或其他条目冲突，将无法保存。”

特殊规则：

- 对保留条目 `id === "global_system_prompt"`：
  - `command` 字段隐藏或禁用（不允许配置）
  - 理由：该条目是 system prompt 底座，不应作为 user message 的快捷替换。

### 2) Agent 输入框 slash 候选

入口：`AgentClientPane.vue` 输入框

触发：沿用现有 slash 模式规则

- `isSlashMode(text)`: `text.trimStart().startsWith("/")`

候选集合：

1. **内置命令候选**：现有 `slashCommands`（`/compact`、`/clear`）
2. **提示词库命令候选**：从 `agent_global_prompts_v1.items` 中筛选出配置了 `command` 的条目

展示规则（与现有候选 UI 对齐）：

- 候选 label：`/<command>`（等价于 `SlashCommandDefinition.usage`）
- 候选 description：提示词库条目的 `title`
  - 备注：当前候选 UI 对 `candidate.kind !== 'slash'` 才显示 `description`，因此建议为 prompt command 引入新的 kind（例如 `kind: "prompt_command"`），用与 mention 类似的展示分支（label + description），而不是复用 `kind: "slash"` 的内置命令渲染。

交互规则：

- 当候选面板可见时：
  - `Enter`：优先选中候选（现状 `pickActiveInputCandidate()`），不会直接发送
  - `Tab`：同上（现状 Tab 在候选可见时 pickActiveInputCandidate）
  - `ArrowUp/ArrowDown`：切换激活候选
  - `Escape`：关闭候选（现状 `inputHintDismissed = true`）

选中后的插入行为：

- 选中 prompt command 候选后，将输入框内容替换为 `/<command>`（可选在尾部补一个空格，但 v1 推荐不补空格，避免误导用户继续输入参数）。

### 3) 发送替换规则

v1 仅在以下条件触发替换：

- 用户发送的文本 `text = draft.value.trim()`
- `text` 满足：`/^\/[A-Za-z0-9][A-Za-z0-9_-]*$/`（即整条消息仅为 `/command`）
- 该 `command` 命中某个提示词库条目（后端校验保证唯一）
- 且未命中任何内置 slash 命令（内置优先）

替换行为：

- 将 `text` 替换为对应条目的 `prompt` 原文（不额外 trim，只保证满足后端 prompt 非空规则）
- 调用现有 `sendAgentMessage(sessionId, { text: replacedText, ... })` 发送

用户可预期性：

- `/compact`、`/clear` 保持原语义（控制命令），不会被提示词库覆盖。
- `/mycmd` 若为 prompt command，则发送时显示为“用户消息文本=提示词内容”（在 UI transcript 中可见）。
  - v1 不做“保留原始输入显示、另存替换来源”的额外事件字段。

---

## 数据模型与配置结构设计

### 1) Settings item 新增字段

现有：

```ts
// packages/shared/src/contracts/settings.ts
export const AgentGlobalPromptItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1, maxLength: 20 }),
  prompt: Type.String()
});
```

v1 扩展：

```ts
type AgentGlobalPromptItem = {
  id: string;
  title: string;
  prompt: string;
  command?: string; // 可选：slash 指令名，不含前缀 '/'
};
```

JSON schema 建议：

- `command`：`Type.Optional(Type.String())`
  - 形状校验放宽（与现有 prompt item 的 schema 风格一致）
  - 具体合法性与冲突校验由 API `updateAgentGlobalPromptSettings` 中执行

### 2) 字段语义

- `command` 为“指令名”，不包含 `/`。
- 对应输入触发文本为 `/${command}`。
- `command` 为空/缺失：该条目不参与输入框候选，不参与替换。

### 3) 保留条目约束

沿用现有保留条目：

- `id === "global_system_prompt"`
- title 固定：`Global System Prompt`

新增约束：

- `global_system_prompt.command` 必须为空/缺失。

---

## 前端方案

### 1) 设置页：提示词库条目配置 `command`

涉及文件：

- `apps/web/src/features/settings/components/AgentGlobalPromptsSettingsPanel.vue`
- i18n：
  - `apps/web/src/shared/i18n/locales/zh-CN.ts`
  - `apps/web/src/shared/i18n/locales/en-US.ts`

改动要点（仅方案描述，不在本任务实现）：

- form state 增加：`formCommand: ref<string>`
- modal 表单新增 `a-form-item`：`command`
- `submit()` 时将 `command` 一并写入 payload：
  - 空字符串应转换为 `undefined`（避免保存大量空字段）
- 对保留条目：隐藏/禁用 command 字段

前端轻量校验（减少无效请求）：

- 非空时匹配：`^[A-Za-z0-9][A-Za-z0-9_-]*$`
- 提示：不需要填写 `/`

### 2) Agent 输入框 slash 候选合并

涉及文件：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
- `apps/web/src/features/workspace/tools/agent/agentInputCandidates.ts`
- API client：`apps/web/src/shared/api/api.ts`（已有 `getAgentGlobalPromptSettings`）

候选数据流建议：

- 在 `AgentClientPane` 挂载或 workspace 切换时，拉取一次 `getAgentGlobalPromptSettings()`，缓存为 `globalPromptItems`。
  - 参考：`AgentProfilesSettingsPanel.vue` 在 refreshDraft 中并发拉取 global prompts。
- 从中派生：`promptCommandItems = items.filter(it => it.command)`

候选展示：

- 当 `slashCommandHint.visible === true`（slash 模式且未完整命中内置命令）：
  - 构造候选列表：
    - 内置 slash candidates（现状）
    - prompt command candidates（新）
  - 统一截断：最多 `MAX_INPUT_CANDIDATES`（现状常量=10）

建议的新候选类型：

```ts
type PromptCommandCandidateItem = {
  id: string; // e.g. `promptcmd:${command}`
  kind: "prompt_command";
  label: `/${command}`;
  description: string; // title
  command: string; // raw command
};

type InputCandidateItem = SlashCandidateItem | MentionCandidateItem | PromptCommandCandidateItem;
```

并在模板渲染中：

- 对 `kind === 'slash'` 走现有内置命令展示
- 对 `kind === 'prompt_command'` 走“label + description”展示分支

选中行为：

- 扩展 `onPickInputCandidate`：
  - `prompt_command`：将 `draft` 设置为 `/${command}`，并清空候选/selection

### 3) 发送链路：替换实现点

涉及文件：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
  - `onSend()` 现状：
    - `resolveSlashCommand(text, slashCommandMap)` -> `executeSlashCommand` 或 `sendAgentMessage`

v1 替换逻辑插入点：

- 保持内置命令优先：
  1. 若 `resolveSlashCommand` 命中：执行内置 command（现状不变）
  2. 否则尝试匹配 prompt command：
     - 解析 `text` 为 `/xxx`
     - 在本地缓存的 `promptCommandMap: Map<string, AgentGlobalPromptItem>` 查找
     - 命中则 `text = item.prompt`
  3. 调用 `sendAgentMessage`

此处无需后端配合：替换发生在前端发送前。

---

## 后端方案

> 后端主要职责：schema/存储兼容 + 更新校验 + sanitize 修复。

涉及文件：

- Shared contract：`packages/shared/src/contracts/settings.ts`
- Settings API：
  - `apps/api/src/modules/settings/settings.routes.ts`
  - `apps/api/src/modules/settings/settings.service.ts`
    - `sanitizeAgentGlobalPromptItemsStored`
    - `getAgentGlobalPromptSettingsStored`
    - `updateAgentGlobalPromptSettings`

### 1) shared schema 更新

- `AgentGlobalPromptItemSchema` 增加可选 `command` 字段。
- `AgentGlobalPromptSettingsSchema`、`UpdateAgentGlobalPromptSettingsRequestSchema` 自动随 item schema 扩展。

### 2) sanitize（读取存量数据）

`sanitizeAgentGlobalPromptItemsStored(itemsRaw, logger?)` 需要：

- 兼容旧数据：`command` 缺失时忽略
- 修复/丢弃非法 command：
  - 非字符串、包含 `\0/\n/\r`、trim 后为空 → 当作未配置
  - 不符合格式（见下文规则）→ 当作未配置并记录 warn
- 对 `global_system_prompt`：
  - 强制清空/忽略 `command`

### 3) update 校验与 normalize

`updateAgentGlobalPromptSettings(ctx, logger, bodyRaw)` 需要：

- 在现有对 `id/title/prompt` 的校验基础上，新增对 `command` 的校验与冲突检查。

兼容策略：

- 仍保持“PUT 覆盖 + 自动补回 global_system_prompt 条目”逻辑（现状：若缺失则 `items.unshift(currentSystemPrompt)`）。

---

## 冲突与校验规则

### 1) command 格式

建议 v1 规则：

- 仅允许：`^[A-Za-z0-9][A-Za-z0-9_-]*$`
- 长度限制：建议 `1..32`（可配置常量，例如 `AGENT_GLOBAL_PROMPT_COMMAND_MAX_LENGTH = 32`）
- 存储为小写（建议）：
  - 前端候选与发送匹配统一按小写
  - 后端保存时 normalize：`command = command.trim().toLowerCase()`

> 说明：当前 `normalizeGlobalPromptId` 对 id 几乎不做字符集限制，因此 command 需要更严格，避免出现空格、斜杠、中文符号等导致 slash 解析歧义。

### 2) 唯一性

- 非空 command 必须全局唯一（跨所有提示词库条目）。
- 唯一性比较按 normalize 后值（trim + lower）。

错误码建议（示例）：

- `AGENT_GLOBAL_PROMPT_COMMAND_DUPLICATE`

### 3) 与内置 slash 命令冲突

- 禁止 command 与内置命令名冲突（normalize 后）：
  - `compact`
  - `clear`
- 原因：`onSend()` 对内置命令优先解析；若允许冲突会造成“候选显示/替换行为”与“执行控制命令”不一致。

错误码建议：

- `AGENT_GLOBAL_PROMPT_COMMAND_CONFLICT_BUILTIN`

### 4) 保留项冲突

- `id === global_system_prompt`：command 必须为空。
- 同时禁止其他条目使用 command：
  - `global_system_prompt`（即 `/global_system_prompt`）——避免与保留 id 概念混淆。

错误码建议：

- `AGENT_GLOBAL_PROMPT_COMMAND_RESERVED`

### 5) prompt 非空

沿用现状强约束（已在后端实现）：

- `normalizeAgentGlobalPromptPromptForUpdate`：`prompt.trim()` 必须非空，否则 `400 AGENT_GLOBAL_PROMPT_REQUIRED`

这意味着：

- 任何配置了 command 的条目，其 prompt 必定非空，替换后不会发送空消息。

---

## 边界情况与风险

1. **命令误触发**
   - 由于 v1 仅在“整条消息 = `/command`”时替换，用户输入“`/command 请继续...`”不会替换。
   - 代价：不支持参数；收益：可预期且不破坏普通对话输入。

2. **候选数量与排序**
   - 现状候选上限 `MAX_INPUT_CANDIDATES = 10`。
   - 若 prompt commands 很多，可能挤占内置命令曝光。
   - 对策：候选排序固定为：内置优先，其次 prompt commands；并对 prompt commands 做前缀过滤。

3. **前后端版本不一致**
   - 新 web 发送 command 字段，但旧 API/shared schema 不认识：
     - 由于 shared contract 同仓，通常随版本一致；但仍建议服务端对未知字段忽略（当前 update 逻辑会显式构造 item，默认会丢弃未知字段，因此需要显式读取并保存 command）。
   - 新 API 返回 command 字段，但旧 web 不使用：
     - 不影响。

4. **存量脏数据**
   - 若 DB 中出现非法 command（例如包含空格或重复），需要 sanitize 修复。

5. **可观察性**
   - v1 不保留“用户原始输入 /command”作为单独字段，替换后在 transcript 中只能看到 prompt 文本。
   - 若需要审计/可解释性，后续可演进为：在 user message metadata 中保存 `sourceCommand`。

---

## 实施步骤

> 本文仅定义实施步骤，不在本任务中落地代码。

1. **Shared contract**
   - 更新 `packages/shared/src/contracts/settings.ts`
     - `AgentGlobalPromptItemSchema` 增加 `command?: string`
   - 更新相关类型导出与下游编译通过。

2. **API**
   - 更新 `apps/api/src/modules/settings/settings.service.ts`
     - `sanitizeAgentGlobalPromptItemsStored` 支持读/修复 command
     - `updateAgentGlobalPromptSettings` 支持写入 command，并增加冲突校验
   - （可选）补充集成测试用例：参考 `apps/api/src/modules/agent/agent.integration.test.ts` 中 global prompts 测试段。

3. **Web 设置页**
   - 更新 `apps/web/src/features/settings/components/AgentGlobalPromptsSettingsPanel.vue`
     - 表单支持 command 字段
     - 前端校验 + i18n 文案

4. **Web 输入框候选与发送替换**
   - 更新 `AgentClientPane.vue`
     - 拉取 global prompts，构建 `promptCommandMap`
     - slash 候选合并展示
     - onSend 增加替换逻辑（内置命令优先）

---

## 验证方案

### 单元/集成测试建议

1. API：更新校验
   - PUT global-prompts：
     - 重复 command → 400（`AGENT_GLOBAL_PROMPT_COMMAND_DUPLICATE`）
     - command = clear/compact → 400（冲突）
     - global_system_prompt 设置 command → 400 或自动清空（按 v1 策略选择其一）

2. API：sanitize
   - 存量 items 中 command 非法/重复：
     - sanitize 后返回不带 command 或丢弃重复 command

3. Web（轻量 E2E / 手工）
   - 在提示词库新增条目：`title=Summarize, command=summarize, prompt=...`
   - 在 Agent 输入框输入 `/sum`：候选出现 `/summarize`，Enter 选中
   - 再次 Enter 发送：实际发送的 user message 文本为 prompt 内容
   - `/clear` 仍执行清空，不会被 prompt command 覆盖

### 手工回归

- 旧数据无 command：不影响设置页展示与发送。
- command 留空：条目不出现在候选。

---

## 待确认项

1. **替换后的 transcript 展示是否需要保留原始 `/command`**（阻塞程度：低）
   - 选项 A（v1 默认）：只显示替换后的 prompt 文本（实现最简单）。
   - 选项 B：在 UI 上仍显示 `/command`，但实际发送给后端的是 prompt（需要为 user message 增加 metadata 字段或在客户端做“双显示”逻辑）。

2. **command 是否允许中文/更宽字符集**（阻塞程度：低）
   - v1 建议仅允许 ASCII（简单、稳定、避免输入法/全角问题）。
   - 若要支持中文，需要重新定义合法字符集、lowercase 规则与匹配策略。

3. **是否允许“`/command` + 空格 + 参数”并做模板替换**（阻塞程度：低）
   - v1 不支持；后续可基于 `{{args}}` 或类似语法扩展。
