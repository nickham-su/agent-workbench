# agent 运行环境中 system prompt 拼接方案改造(v1)

本文档基于当前仓库代码现状，定义 agent 运行环境中 `system prompt` 的分段格式改造方案。目标是在不改变“API 侧构建单个 `system: string`、worker 侧透传”的总体架构前提下，调整 section 分隔方式，并新增一个由系统代码内建注入、不可由用户配置的 `output_format_instructions` section。

相关背景文档：
- `docs/design/agent/system-prompts-v1.md`
- `docs/design/agent/global-system-prompt-in-settings-v1.md`
- `docs/design/agent/client-assistant-markdown-renderer-v1.md`
- `docs/design/agent/run-locale-in-system-prompt-v1.md`

---

## 背景与现状

### 运行时调用链

当前 agent 的模型调用只接收单个 `system: string`：

- API 侧在 `AgentService.getPromptContextForRun()` 中构建 prompt context，并调用 `buildSystemPrompt()` 生成最终 `system`
  - `agent-workbench/apps/api/src/modules/agent/agent.service.ts:3384-3409`
- worker 侧不再二次拼接，只透传 `context.system`
  - `agent-workbench/apps/agent-worker/src/runtime/runner.ts:1519-1523`

这意味着，system prompt 的拼接格式、section 顺序与内建约束，均应在 API 侧统一完成。

### 当前 system prompt 的组成

按当前实现，`buildSystemPrompt()` 会将多个来源按顺序拼接，并通过 `sections.join("\n\n")` 生成最终字符串：

- system base：优先取 settings 中保留条目 `global_system_prompt`，否则回退到 `GLOBAL_WORKFLOW_SYSTEM_PROMPT`
- selected global prompts：按全局列表顺序遍历 agent 选中的项
- workspace instructions：workspace 根目录 `AGENTS.md`
- agent prompt：当前 agent profile 的 `prompt`
- runtime constraints：由 `buildRuntimeInstruction()` 生成

相关代码：
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:1642-1677`
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:783-806`
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:1528-1573`

### 当前 section 容器格式

当前非 base section 使用 Markdown 二级标题作为容器，例如：

- `## Global Prompt: <title>`
- `## Workspace Instructions: <displayPath>`
- `## Agent Prompt: <agentName>`
- `## Runtime Constraints`

相关代码：
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:1662`
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:1666`
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:1670`
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:806`

### 当前前端 assistant Markdown 渲染能力

`output_format_instructions` 的设计必须基于前端真实支持范围，而不是抽象想象。

当前 assistant 消息 Markdown 渲染链路：

- assistant 消息正文与 reasoning 使用 `AssistantMarkdownMessage` 渲染
  - `agent-workbench/apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:220-234`
- 解析与净化栈为：
  - `markdown-it`
  - `dompurify`
  - `mermaid`
  - 关键实现位于 `agent-workbench/apps/web/src/features/workspace/tools/agent/AssistantMarkdownMessage.vue`

当前明确支持的结构：

- 标题
- 列表
- 表格
- 引用
- 行内代码
- 代码块
- 链接
- Mermaid fenced code block

当前明确不支持或不应依赖的结构：

- 图片：`markdown.renderer.rules.image = () => ""`，并且 sanitizer 也禁用 `<img>`
- HTML：`markdown-it` 配置 `html: false`
- 任务列表复选框：未接入对应插件
- 数学公式：未接入对应插件或渲染器

相关代码：
- `agent-workbench/apps/web/src/features/workspace/tools/agent/AssistantMarkdownMessage.vue:32-40`
- `agent-workbench/apps/web/src/features/workspace/tools/agent/AssistantMarkdownMessage.vue:57-99`
- `agent-workbench/apps/web/src/features/workspace/tools/agent/AssistantMarkdownMessage.vue:109-120`
- `agent-workbench/apps/web/package.json:18-20`

---

## 问题

### 1) 二级标题作为 section 容器容易与正文 Markdown 结构混淆

当前容器格式把系统拼接结构建立在 `##` 标题上，但外部来源正文本身也可能包含：

- 一级标题 `#`
- 二级标题 `##`
- 更深层级标题
- 其它 Markdown 文档结构

由此会带来几个问题：

- section 边界对人类可读，但对模型来说并不是强边界
- “系统拼接容器标题”与“正文自然标题”使用同一套语法，语义层次混杂
- 当正文本身就是完整 Markdown 文档时，外层继续使用标题包裹，会造成结构噪声

### 2) 当前缺少一个由系统内建、不可配置的输出格式能力说明 section

当前 system prompt 中虽然有：

- system base（可配置保留条目）
- global prompts（用户可配置）
- workspace `AGENTS.md`（工作区文件）
- agent prompt（agent 级配置）
- runtime constraints（运行时动态约束）

但没有一段明确表达“前端输出渲染能力边界”的系统内建 section。

这会导致：

- 模型可能输出前端不稳定支持的格式，如图片、HTML、任务列表、数学公式
- 平台能力约束被错误地下放到用户可配置 prompt 中，不利于一致性与维护
- 输出风格约束与运行时环境约束混在一起，职责边界不清晰

### 3) 输出格式引导需要与产品实际渲染能力保持一致

如果 system prompt 提倡模型使用某些格式，而前端并不支持，则会产生：

- 用户看到的实际渲染效果不一致
- prompt 对模型形成错误激励
- 不同 agent / workspace 之间出现风格漂移

因此，输出格式指令必须由系统代码内建维护，并随前端能力演进同步调整。

---

## 目标

- 不再使用 Markdown 二级标题作为 section 容器。
- 不采用 XML 方案。
- 将 system prompt 的 section 分隔统一改为：**仅使用 Markdown 分割线 + 单行块标签 + 正文**。
- 新增一个不可配置的内建 section：`output_format_instructions`。
- `output_format_instructions` 使用柔性语气，引导模型优先使用 Markdown，并仅描述当前前端稳定支持的结构与边界。
- 明确 `output_format_instructions` 不属于用户可配置内容，不放在 `global_system_prompt`、agent prompt、`AGENTS.md` 中，而是由系统代码内建注入。
- 将“纯文本输出会被当前运行环境视为任务结束”的规则纳入 `runtime_constraints`，并作为本次改造目标之一。
- 明确该规则属于运行环境约束/完成判定协议，而不是输出格式偏好，因此不放入 `output_format_instructions`。
- 固定最终顺序为：
  - `system_base`
  - `global_prompt`
  - `workspace_instructions`
  - `agent_prompt`
  - `output_format_instructions`
  - `runtime_constraints`
- 保持现有架构：仍由 API 侧拼出单个 `system: string`，worker 侧继续透传。

---

## 非目标

- 不改动 worker 侧模型调用协议；worker 仍仅消费 `context.system`。
- 不改变 settings 中 `global_system_prompt` 的保留条目机制。
- 不改变 workspace `AGENTS.md` 的读取路径、读取失败处理与 32KB 截断策略。
- 不改变 agent profile 中 `globalPromptIds` 的选择机制与遍历顺序。
- 不把 `output_format_instructions` 暴露为 Settings、agent 配置或工作区文件中的可编辑内容。
- 不引入 XML、HTML 或其它新的结构化包装语言作为 section 容器。
- 不扩展前端 Markdown 能力范围；本方案只消费当前已存在能力。

---

## 方案概览

### 1) section 分隔格式改造

将当前“二级标题作为容器”的做法改为：

- section 之间使用 Markdown 分割线 `---`
- 每个 section 在正文之前放置一行块标签
- 块标签不使用 Markdown 标题语法，仅使用普通文本标签行

建议格式：

```md
---
[global_prompt] Coding Rules

...正文...
```

说明：

- `---` 负责提供稳定、醒目的块间分隔。
- `[global_prompt] Coding Rules` 这类单行标签负责声明 section 类型与简短元信息。
- 正文保持原样拼接，不要求重写或降级其内部 Markdown 结构。
- 不再要求使用 `#` / `##` 作为外层容器，因此不会与正文标题层级形成直接冲突。

### 2) 新增内建 section: `output_format_instructions`

在 `buildSystemPrompt()` 中新增一个仅由系统代码生成的 section。它的职责是：

- 告知模型回复时优先使用 Markdown 组织内容
- 告知模型当前适合使用的结构
- 告知模型当前不要依赖的格式能力

这段内容不是：

- settings 中的 `global_system_prompt`
- agent profile `prompt`
- workspace `AGENTS.md`

而应是与 `runtime_constraints` 类似、但语义上独立的一段**系统内建 section**。

### 3) 最终顺序固定

最终顺序固定为：

1. `system_base`
2. `global_prompt`
3. `workspace_instructions`
4. `agent_prompt`
5. `output_format_instructions`
6. `runtime_constraints`

该顺序的含义：

- `system_base` 仍作为最上层行为底座
- 用户/项目可配置内容位于中间
- 平台输出格式约束在靠后位置统一收口
- `runtime_constraints` 保持在末尾，继续承载语言、时间、时区，以及“纯文本输出会被视为任务结束”这类运行环境约束/完成判定协议

---

## 详细设计

### section 标签建议

建议使用以下标签名：

- `[system_base]`
- `[global_prompt] <title>`
- `[workspace_instructions] <displayPath>`
- `[agent_prompt] <agentName>`
- `[output_format_instructions]`
- `[runtime_constraints]`

说明：

- 标签名采用英文，是为了在正文中保持简短、稳定、低歧义。
- 标签行仅用于 section 识别，不承担 Markdown 标题语义。
- 标签行与正文之间保留一个空行，便于阅读。

### 拼接模板示例

建议最终 system prompt 形态如下：

```md
[system_base]

# 工作方式与流程(全局)
...

---
[global_prompt] Coding Rules

...global prompt 正文...

---
[workspace_instructions] AGENTS.md

...workspace AGENTS.md 正文...

---
[agent_prompt] 通用助理

...agent prompt 正文...

---
[output_format_instructions]

输出格式要求：
- 回复时优先使用 Markdown，以提升可读性。
- 在合适时优先使用标题、列表、表格、引用、行内代码、代码块和链接。
- 对比信息、参数说明、选项差异等内容，优先使用表格展示。
- 命令、代码、配置、日志片段应优先使用 fenced code block。
- 需要表达流程或关系图时，可使用 Mermaid fenced code block。
- 不要依赖图片、内嵌 HTML、任务列表复选框或数学公式等格式。
- 如果 Markdown 会降低表达清晰度，则直接使用纯文本。

---
[runtime_constraints]

完成判定约束：
- 当前运行环境会将纯文本输出视为任务结束。
- 因此，在任务最终完成之前，每次回复都必须包含工具调用，不能只输出纯文本。
- 只有在确认任务已经完成、无需继续执行时，才能发送纯文本的最终答复。

语言要求：本轮对话请统一使用简体中文。
当前系统时间：2026-03-09 15:43:58
当前时区：UTC
```

说明：

- 第一段 `system_base` 可以不强制在前面额外加 `---`，以保持文档开头简洁；其后各段统一以 `---` 进入下一个 section。
- 若某个可选 section 不存在或为空，则直接跳过，不额外输出空壳 section。
- `runtime_constraints` 仍保留当前动态文本生成方式，但外层标签由 `## Runtime Constraints` 改为 `[runtime_constraints]`，并在其中追加固定的完成判定约束文本。

### `output_format_instructions` 建议文案

该 section 采用柔性语气，不使用“必须”“禁止”这类过强措辞。建议文案如下：

```text
输出格式要求：
- 回复时优先使用 Markdown，以提升可读性。
- 在合适时优先使用标题、列表、表格、引用、行内代码、代码块和链接。
- 对比信息、参数说明、选项差异等内容，优先使用表格展示。
- 命令、代码、配置、日志片段应优先使用 fenced code block。
- 需要表达流程或关系图时，可使用 Mermaid fenced code block。
- 不要依赖图片、内嵌 HTML、任务列表复选框或数学公式等格式。
- 如果 Markdown 会降低表达清晰度，则直接使用纯文本。
```

设计依据：

- 当前 assistant Markdown 渲染能力由 `markdown-it + dompurify + mermaid` 提供。
- 标题、列表、表格、引用、代码块、链接、Mermaid 是当前可稳定使用的结构。
- 图片、HTML、任务列表复选框、数学公式不是当前应鼓励模型依赖的结构。

### `runtime_constraints` 的呈现方式

当前 `buildRuntimeInstruction()` 直接返回：

- `## Runtime Constraints\n${lines.join("\n")}`

本方案建议改为只返回正文内容，并由 `buildSystemPrompt()` 统一包裹 section 标签；或保留 helper，但使其输出改为：

```text
[runtime_constraints]

...正文...
```

此外，`runtime_constraints` 需要明确纳入一条新的固定规则：

```text
完成判定约束：
- 当前运行环境会将纯文本输出视为任务结束。
- 因此，在任务最终完成之前，每次回复都必须包含工具调用，不能只输出纯文本。
- 只有在确认任务已经完成、无需继续执行时，才能发送纯文本的最终答复。
```

这条规则应放在 `runtime_constraints`，而不是 `output_format_instructions`。原因是：

- 它描述的是当前运行环境的完成判定方式与回合控制协议。
- 它约束的是“什么时候可以只输出纯文本”，而不是“输出应优先采用什么展示格式”。
- 若误放入 `output_format_instructions`，会把执行协议与展示偏好混在一起，削弱语义边界。

推荐取舍：

- 若希望 section 格式由 `buildSystemPrompt()` 统一控制，建议让 `buildRuntimeInstruction()` 只关心正文内容。
- 若希望最小改动，也可让 `buildRuntimeInstruction()` 直接产出新的 block 文本，但需要确保整体格式与其它 section 一致，并在其中稳定包含完成判定约束文本。

---

## 关键改动点

### 1) `buildSystemPrompt()` 的 section 模板替换

文件：
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts`

当前逻辑：

- 使用 `## Global Prompt: ...`
- 使用 `## Workspace Instructions: ...`
- 使用 `## Agent Prompt: ...`
- 最终 `sections.join("\n\n")`

建议改造为：

- 引入统一的 section 格式化方式，例如内部 helper：
  - 输入：`kind`、`label`、`body`
  - 输出：`---\n[kind] label\n\nbody`
- `system_base` 作为首段插入
- 其后按固定顺序插入其它 section
- 新增 `output_format_instructions` 的内建 block

### 2) 新增内建 helper / 常量

建议在 API 侧新增一个不可配置 helper，例如：

- `buildOutputFormatInstruction()`

职责：

- 返回固定正文或固定 block
- 内容由代码维护，不从 settings / workspace / agent 配置读取

### 3) `buildRuntimeInstruction()` 输出形态调整

文件：
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:783-806`

建议：

- 去掉当前 `## Runtime Constraints` 标题包装
- 让 runtime constraints 与其它 section 使用同一套 block 分隔格式
- 在 runtime constraints 正文中追加固定的完成判定约束文本，而不是把该规则并入 `output_format_instructions`

### 4) `getPromptContextForRun()` 的组装参数增加内建 section

文件：
- `agent-workbench/apps/api/src/modules/agent/agent.service.ts:3384-3409`

建议：

- 保持当前调用入口不变
- 在 `buildSystemPrompt()` 内部生成 `output_format_instructions`
- 不需要修改 worker 侧传输协议

### 5) worker 侧无需改动

文件：
- `agent-workbench/apps/agent-worker/src/runtime/runner.ts:1519-1523`

原因：

- worker 当前只负责把 `context.system` 作为 `system` 透传给模型
- 本方案只改 `system` 的构建文本，不改协议与调用行为

---

## 兼容性

### 与现有 settings / agent 配置兼容

- `global_system_prompt` 仍然是 system base 的来源之一，不受影响。
- 普通 global prompts 的选择、存储与遍历顺序不变。
- agent profile 的 `prompt` 仍按原样注入，只是外层容器格式改变。
- workspace 根目录 `AGENTS.md` 的读取、忽略与截断策略不变。

### 与已有 prompt 内容兼容

- 正文内容本身不需要迁移或重写。
- 外部 prompt 若包含标题、列表、表格、代码块等 Markdown 结构，可继续原样保留。
- 由于不再使用二级标题作为外层容器，正文中的 Markdown 标题层级与外层 section 标签不再直接冲突。

### 与 worker 调用兼容

- `context.system` 仍然是单个字符串。
- provider 侧无须感知 section 格式变化。
- 完成判定约束仍以 system prompt 文本的一部分下发，不需要修改 worker 侧协议。

---

## 风险与对策

### 1) 仅用 Markdown 分割线和标签行，结构约束弱于 XML

风险：

- 这套格式不是严格结构化协议，边界仍然依赖模型对自然语言和轻量标记的理解。

对策：

- 保持标签名稳定、简短、一致。
- 固定 section 顺序，避免语义漂移。
- 不在标签行中引入多余格式语法。

### 2) 正文中可能自然出现 `---` 或 `[global_prompt]` 之类文本

风险：

- 某些正文也可能包含分割线或类似标签，理论上会降低边界唯一性。

对策：

- 只把 section 标签放在块起始位置，形成稳定模式。
- 控制标签集合固定且数量有限。
- 若后续观测到实际冲突，再评估是否引入更强的包装策略。

### 3) `output_format_instructions` 与用户自定义 prompt 可能存在风格冲突

风险：

- 某些 agent 或 workspace prompt 可能更偏向纯文本交付。

对策：

- 使用柔性语气：`优先使用`、`在合适时`、`不要依赖`。
- 保留“如果 Markdown 会降低表达清晰度，则直接使用纯文本”的降级条款。

### 4) 若遗漏完成判定约束，模型可能过早结束任务

风险：

- 若 `runtime_constraints` 未明确告知“纯文本输出会被视为任务结束”，模型可能在任务中途输出一段普通文本，导致运行环境将该回合判定为结束。

对策：

- 将该规则作为 `runtime_constraints` 的固定组成部分，而不是可选 prompt 文案。
- 在测试中显式校验 `runtime_constraints` 中包含该约束文本。

### 5) 前端 Markdown 能力未来变化，内建文案可能过时

风险：

- 若后续支持图片、任务列表或数学公式，而文案未更新，会形成新的能力偏差。

对策：

- 将 `output_format_instructions` 明确为系统代码内建段落。
- 每次前端 Markdown 能力演进时，同步审视此文档与对应内建文案。

---

## 验证建议

### 单元/集成测试建议

围绕 `buildSystemPrompt()` 增加或更新测试，至少覆盖：

- 当仅有 `system_base` 时，输出不包含旧的 `##` section 容器。
- 当存在多个 selected global prompts 时：
  - 顺序遵循全局列表顺序
  - section 标签形如 `[global_prompt] <title>`
- 当 workspace `AGENTS.md` 存在时：
  - section 标签形如 `[workspace_instructions] AGENTS.md`
   - 超过 32KB 时保留当前截断提示文案
- 当 agent prompt 非空时：
  - section 标签形如 `[agent_prompt] <agentName>`
- 总是注入 `output_format_instructions`
- 总是注入 `runtime_constraints`
- `runtime_constraints` 中稳定包含“纯文本输出会被视为任务结束”的完成判定约束文本
- 最终顺序固定为：
  - `system_base -> global_prompt -> workspace_instructions -> agent_prompt -> output_format_instructions -> runtime_constraints`

### 手工验证建议

- 在 settings 中配置 `global_system_prompt` 与多个普通 global prompt，发起一次 run，检查最终 `context.system`。
- 在 workspace 根目录放置包含标题/表格/代码块的 `AGENTS.md`，确认正文原样注入。
- 配置包含 `#` / `##` 的 agent prompt，确认不再与外层 section 容器冲突。
- 发起一次中文 run 与英文 run，确认 `runtime_constraints` 内容仍随 locale 变化。
- 检查最终 `context.system` 中，完成判定约束位于 `runtime_constraints` 内，而不出现在 `output_format_instructions` 中。
- 在前端验证 assistant 回复中：
  - 表格、代码块、链接、Mermaid 呈现正常
  - 图片、HTML、任务列表复选框、数学公式不被当作受支持格式依赖

### 回归关注点

- 不要误改 worker 侧行为。
- 不要误把 `output_format_instructions` 暴露到用户可配置 settings。
- 不要改变 `AGENTS.md` 的读取错误处理与截断行为。

---

## 结论

本方案在保持当前 system prompt 架构不变的前提下，完成两项关键收敛：

1. 将 section 容器从“Markdown 二级标题”改为“Markdown 分割线 + 单行块标签 + 正文”，降低外层容器与正文标题结构的冲突。
2. 新增系统内建、不可配置的 `output_format_instructions` section，让模型的输出风格与前端真实渲染能力保持一致。
3. 将“纯文本输出会被视为任务结束”的规则显式纳入 `runtime_constraints`，把运行环境完成判定协议与输出格式偏好清晰分离。

该方案改动面集中在 API 侧 `buildSystemPrompt()` 及相关 helper，兼容现有 settings、agent profile、workspace `AGENTS.md` 与 worker 透传逻辑，适合作为一次局部、可验证的 prompt 拼接格式演进。
