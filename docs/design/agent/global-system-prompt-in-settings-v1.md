# 全局系统提示词纳入“提示词库”管理方案(v1)

本文档在既有“系统提示词(Global + Workspace)方案(v1)”基础上，进一步将当前硬编码的全局系统提示词(`GLOBAL_WORKFLOW_SYSTEM_PROMPT`)纳入 Settings 的“提示词库”(global prompts)中管理。

目标是让用户/开发者无需改代码即可调优系统提示词，同时确保系统始终存在一个有效的“底座 system prompt”，避免误删/置空导致 agent 不可用。

相关背景文档：
- `docs/design/agent/system-prompts-v1.md`

---

## 背景与现状

- agent 的模型调用只接收单个 `system: string`。
- 当前 `system` 在 API 侧构建(参见 `AgentService.getPromptContextForRun()`)，worker 侧仅透传。
- 当前实现中存在硬编码常量：`GLOBAL_WORKFLOW_SYSTEM_PROMPT`，其内容会被无条件 prepend 到最终 `system`。
- “提示词库”(Settings: `agent_global_prompts_v1`)已支持维护多条 global prompt，并由 agent profile 的 `globalPromptIds` 选择性注入。

问题：
- 硬编码全局系统提示词不利于调优；每次修改需要改代码并发布。
- 若系统底座迁入提示词库，必须保证该条目不可删除且始终非空。
- 若普通 global prompt 允许为空，也会形成无实际作用的干扰信息，不利于设置页管理与理解。

---

## 目标

- 将全局系统提示词作为提示词库中的一个“保留条目”(reserved item)管理。
- 系统启动时自动初始化/修复该保留条目，确保始终存在且非空。
- 在生成最终 `system` 时，优先使用该保留条目内容作为“system 底座”。
- 防止该保留条目被删除，防止其 `prompt` 被更新为空。
- 将“所有 global prompt 的 `prompt` 必填且非空”作为统一规则执行。
- 不改变既有的拼接大顺序：底座 -> global prompts -> workspace AGENTS.md -> agent prompt。

---

## 非目标

- 不引入 session 级别覆盖或 per-run 的 system prompt 覆盖。
- 不改变 workspace `AGENTS.md` 的读取策略(仍仅支持 workspace 根目录，32KB 截断)。
- 不引入新的 settings key；继续复用 `agent_global_prompts_v1`。
- 不改变 agent profile 的 `globalPromptIds` 机制；仍按全局列表顺序决定可选 global prompt 的注入顺序。

---

## 设计概览

### 1) 保留条目定义

在 settings key `agent_global_prompts_v1` 的 `items` 中，约定一个保留 id：

- `id = "global_system_prompt"`
- `title = "Global System Prompt"`

该条目规则：
- **必须存在**：无论用户如何配置，系统应保证该条目存在。
- **不可删除**：通过 API 更新 settings 时，不允许用户删除该条目。
- **prompt 必须非空**：该条目的 `prompt.trim().length > 0`，否则拒绝更新或自动修复。
- **title 固定**：若脏数据中该条目 title 缺失、非法或不一致，修复时统一改回 `Global System Prompt`。

### 2) 所有 global prompt 的通用约束

对提示词库中所有条目统一施加以下规则：

- `title` 必填，保持既有长度限制(<= 20)。
- `prompt` 必填，且 `prompt.trim().length > 0`。
- `prompt` 继续受既有 32KB 字节上限限制。
- `id` 必须唯一。

含义：
- 不再允许创建“空 prompt 占位条目”。
- 不再允许通过提交空字符串/全空白字符串来“临时禁用”某条 global prompt；若需要禁用，应删除该普通条目或取消 agent 对该条目的选择。

### 3) 启动时初始化/修复(Seeding)

在 API 启动阶段、对外 `listen` 之前执行一次初始化动作。

固定挂点：
- `apps/api/src/app/createApp.ts`
- 在 `registerSettingsModule(app, ctx)` 之后、`registerAgentModule(app, ctx)` 之前调用

初始化/修复逻辑：

1. 读取 settings `agent_global_prompts_v1`。
2. 若 settings 不存在：创建 settings，并写入 `items`，至少包含 `global_system_prompt`。
3. 若 settings 存在：对 `items` 做一次规范化修复。

建议的修复策略：
- 若缺少 `global_system_prompt`：补写该条目。
- 若存在多个 `global_system_prompt`：保留一个，删除重复项，并记录 warn。
- 若 `global_system_prompt.title` 非法或不等于 `Global System Prompt`：修正为固定 title，并记录 warn。
- 若 `global_system_prompt.prompt` 为空/全空白/超过 32KB：将其恢复为内置默认值，并记录 warn。
- 对普通条目：
  - 若 `id` 重复：按既有 normalize 策略仅保留一个有效项，并记录 warn。
  - 若 `title` 非法或 `prompt` 为空/全空白或超过 32KB：视为无效条目，启动修复时直接丢弃，并记录 warn。

内置默认值来源：
- 保留现有常量 `GLOBAL_WORKFLOW_SYSTEM_PROMPT` 作为“seed/restore 的 source of truth”。

> 备注：当前内置默认值字节数约 4.2KB，小于 global prompt 既有 32KB 限制。

### 4) 运行时 system prompt 的拼接

最终 `system: string` 的拼接顺序调整为：

1. **系统底座**：优先使用 settings 中 `global_system_prompt` 条目的 `prompt` 作为第一段；若因异常读取不到，则 fallback 到 `GLOBAL_WORKFLOW_SYSTEM_PROMPT`。
2. **Global prompts(可选)**：按 global prompts 列表顺序遍历，注入 agent profile 选中的条目(跳过 `global_system_prompt`，避免重复注入)。
3. **Workspace `AGENTS.md`(可选)**
4. **Agent profile `prompt`(可选)**

说明：
- 运行时不依赖 `global_system_prompt` 在 `items` 数组中的位置；始终按 id 单独读取该条目作为底座。
- UI 可以将该条目固定置顶展示，但后端拼接逻辑不依赖 UI 展示顺序。

### 5) 更新校验与“不可删除”策略

Settings 更新接口为 PUT 覆盖：`PUT /api/settings/agent/global-prompts`。

为实现“不可删除”，采用下述策略：

- 对于 incoming items **缺少** `global_system_prompt`：
  - 服务端在保存前**自动补回**该条目(优先补回当前已存储版本；若存储也缺失，则用默认常量生成)。
  - 即：删除操作无效，最终保存结果仍包含该条目。
- 对于 incoming items 中任一条目的 `prompt` 为空/全空白：
  - 服务端返回 `400` 拒绝，并给出明确 error code。
- 对于 incoming items 中 `global_system_prompt.title` 不合法或不等于固定 title：
  - 服务端可直接归一化为 `Global System Prompt` 后保存；也可返回 400。
  - v1 推荐：**服务端归一化保存**，减少无意义的客户端失败。

此策略的取舍：
- 优点：兼容旧客户端/测试用例(即便没传保留条目也不至于硬失败)，且能强制“不可删除”。
- 缺点：PUT 的语义从“完全覆盖”变为“覆盖 + 修复约束”。但这与系统可用性目标一致。

---

## 数据模型与协议

### Settings Key

- key: `agent_global_prompts_v1`

### Schema(形状保持不变，语义收紧)

保持现有 schema 形状：

```ts
type AgentGlobalPromptItem = {
  id: string;
  title: string; // <= 20
  prompt: string;
};

type AgentGlobalPromptSettings = {
  items: AgentGlobalPromptItem[];
  updatedAt: number;
};
```

语义约束增强：
- 所有条目：`prompt.trim().length > 0`
- 保留条目：
  - `id === "global_system_prompt"`
  - `title === "Global System Prompt"`

说明：
- shared contract 的 JSON schema 可以继续保持 `Type.String()` 级别的形状定义；真正的“非空/固定 title”约束由服务端 normalize + 校验实现。

---

## API 行为

### GET /api/settings/agent/global-prompts

- 返回的 `items` 必须包含 `global_system_prompt`。
- 返回数据中的所有条目 `prompt` 都应为非空字符串。
- 若读取到存量脏数据，推荐在启动期先修复，避免 GET 暴露非法状态。

### PUT /api/settings/agent/global-prompts

- incoming items 允许不包含 `global_system_prompt`，但服务端会补回。
- incoming items 中任一条目若 `prompt` 为空/全空白：400。
- incoming items 中若出现重复 id：400 或按既有规则去重；v1 推荐保持既有“重复 id 报错”行为。

建议新增/使用的错误码(示例)：
- `AGENT_GLOBAL_PROMPT_EMPTY`
- `AGENT_GLOBAL_SYSTEM_PROMPT_EMPTY`
- `AGENT_GLOBAL_PROMPT_DUPLICATE`

---

## 前端 UI 方案

在“提示词库”页面(`AgentGlobalPromptsSettingsPanel`)中对保留条目做特殊处理：

- 对 `id === global_system_prompt`：隐藏/禁用删除按钮。
- 将该条目固定置顶显示，便于用户理解其“底座 prompt”身份。
- prompt 文本框仍可编辑，用于调优。
- 所有条目的 prompt 输入框都视为必填；前端提交前可做 `trim().length > 0` 校验，减少无效请求。
- 可选：提供“恢复默认值”按钮，将 `global_system_prompt.prompt` 重置为内置默认常量(通过 PUT 更新完成)。

说明文案建议：
- `global_system_prompt` 会作为 system prompt 的第一段注入，影响所有 agent 的行为。
- 提示词库中的每一项都必须填写有效 prompt；空提示词不会被允许保存。

---

## 兼容性

- 对于新安装/空 DB：启动 seed 会写入 `global_system_prompt`，使系统具备可运行的默认 system prompt。
- 对于旧数据：
  - 若原有 `agent_global_prompts_v1` 不存在或不包含保留条目，启动 seed 会补齐。
  - 若保留条目 prompt 被误置空/损坏，启动 seed 会修复(并记录 warn)。
  - 若普通条目 prompt 为空/全空白，启动修复会将其视为无效条目并移除(并记录 warn)。
- 对于运行时行为：
  - 默认情况下，注入内容与原 `GLOBAL_WORKFLOW_SYSTEM_PROMPT` 保持一致，因此用户无感。

---

## 风险与对策

1) **多实例并发写入(竞态)**
- seed 属于启动期动作，建议在对外 listen 之前执行，并尽量做到“仅在缺失/损坏时写回”。

2) **系统 prompt 过大导致上下文占用**
- global prompts 已有 32KB 上限；保留条目同样受此限制。
- UI/文档中提示：修改全局系统提示词可能显著占用上下文窗口。

3) **重复注入**
- 若 agent profile 的 `globalPromptIds` 包含 `global_system_prompt`，运行时应在“可选 global prompts 注入”阶段跳过该 id，避免重复注入。

4) **旧数据中的空普通 prompt 条目**
- 由于 v1 将“所有 prompt 必填”作为新规则，启动修复需清理历史空条目，避免 GET 返回脏数据、UI 出现干扰项。

---

## 落地改动点(代码级)

> 仅列出关键文件与职责，具体实现以最小改动为原则。

- API
  - `apps/api/src/app/createApp.ts`：在 `registerSettingsModule` 之后、`registerAgentModule` 之前增加启动期 seed 调用。
  - `apps/api/src/modules/settings/settings.service.ts`：
    - 提供 `ensureAgentGlobalSystemPromptSeeded`(或同名)方法，供启动时调用。
    - 扩展读取/normalize 逻辑：修复/清理脏数据，保证返回结果不含空 prompt。
    - 扩展 `updateAgentGlobalPromptSettings`：对 `global_system_prompt` 做不可删除处理；对所有条目做 prompt 非空校验。
  - `apps/api/src/modules/agent/agent.service.ts`：
    - `buildSystemPrompt`：系统底座从 settings 的 `global_system_prompt` 获取；fallback 常量；并跳过重复注入。

- Web
  - `apps/web/src/features/settings/components/AgentGlobalPromptsSettingsPanel.vue`：
    - 对保留条目禁用删除并固定置顶展示。
    - 所有 prompt 输入做必填校验。
    - 可选：增加“恢复默认值”。

---

## 测试计划

- 集成测试(建议新增/调整)：
  1. 启动/初始化后，GET global-prompts 返回包含 `global_system_prompt`，且 title 为 `Global System Prompt`、prompt 非空。
  2. PUT global-prompts 即使不传 `global_system_prompt`，服务端仍会补回。
  3. PUT global-prompts 任意普通条目 prompt 为空：400。
  4. PUT global-prompts 传入 `global_system_prompt` 但 prompt 为空：400。
  5. 启动时若存在空普通 prompt 条目，修复后 GET 不再返回该条目。
  6. prompt-context 的 system 拼接：
     - `global_system_prompt` 内容位于最前。
     - 可选 global prompts 在其后，且顺序遵循列表顺序。
     - 若 agent 选中了 `global_system_prompt`，最终 system 中仅出现一次(去重)。

- 手工验证：
  - 在提示词库中修改 `global_system_prompt`，新发起 run 后 system 立即生效。
  - 尝试删除该条目：UI 不提供删除入口；即便通过 API 发起删除，服务端仍会保留。
  - 尝试创建或保存空 prompt 的普通条目：前端应拦截；若绕过前端直接调 API，后端返回 400。
