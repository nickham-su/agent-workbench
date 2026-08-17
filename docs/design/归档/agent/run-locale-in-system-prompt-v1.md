# 基于 run locale 的系统提示词语言约束方案 (v1)

Status: draft

## 背景

当前 `/settings/basic/general` 页面中的语言配置仅用于前端 UI 国际化：

- 前端通过 `localStorage` 保存当前语言, key 为 `agent-workbench.locale`
- 切换后立即生效,并不会写入服务端 settings
- Agent 的系统提示词(system prompt)则由 API 侧在 `getPromptContextForRun()` 中构造,Worker 再通过 internal API 拉取

这导致一个明显缺口：

- 用户可以在前端选择 UI 语言
- 但 Agent 在回答、reasoning、以及调用 `todolist` 制定计划时,并不会自动遵循该语言

本方案目标是：**保持现有 basic/general 语言设置仍为前端本地设置,同时把“发起本轮 run 的前端语言偏好”透传给后端,并注入系统提示词,从而约束模型本轮输出语言。**

## 目标

- 让 Agent 在每次新 run 中默认遵循当前前端语言设置。
- 将语言要求注入 system prompt,约束：
  - 对用户的回答语言
  - internal reasoning / thought 文本语言
  - `todolist` 工具中 `goal` 与 `todos[].content` 的语言
- 保持 `/settings/basic/general` 现有语义不变：
  - 语言设置仍然是前端本地设置
  - 不提升为服务端全局 settings
- 将语言偏好建模为 **run 级别上下文**,而不是 session 级别状态。
- 对旧 run / 缺失 locale 的场景保持向后兼容。

## 非目标

- 本期不把 basic/general 语言设置改造成服务端全局配置。
- 本期不新增独立的 "Agent Output Language" 设置项。
- 本期不修改历史 transcript 中已有消息的语言。
- 本期不保证所有模型对 reasoning 语言 100% 严格服从(只能通过 system prompt 强约束)。

## 为什么使用 run 级 locale

语言偏好更适合作为 **run 级属性** 而不是 session 级属性：

- 同一个 session 可以跨多轮运行
- 用户可能在不同时间切换 UI 语言
- 不同客户端/浏览器也可能以不同语言发起新 run

因此更合理的语义是：

- `本轮 run 使用什么语言`
- 而不是 `这个 session 永远使用什么语言`

## 方案概览(A2)

### 总体思路

- 前端继续从 `/settings/basic/general` 读取当前 locale
- 在所有会触发新 run 的入口,将 locale 作为 `uiLocale` 透传给 API
- API 在创建 run record 时,将 `uiLocale` 写入 `agent_run`
- Worker 拉取 prompt-context 时,API 根据 run 读取对应 locale
- API 在构造 system prompt 时加入一段“运行时约束”(语言要求 + 当前系统时间/时区)
- 模型据此统一使用对应语言回答、思考与制定计划

### 为什么语言不直接读取前端 localStorage

系统提示词构造发生在 API 侧；Worker 通过 internal API 异步拉取 prompt-context。后端不能直接读取浏览器 localStorage,因此必须在 run 创建时显式透传 locale。

### 为什么不直接放进 session

如果把 locale 放到 session 上,会造成：

- session 长生命周期与语言偏好短生命周期不匹配
- 后续用户切换语言时,新 run 无法自然体现变化

### 为什么不只在内存里临时透传

仅在发送消息请求的内存链路透传 locale,会使后续：

- Worker 重拉 prompt-context
- 运行恢复 / 重试
- 调试排查

都缺少稳定的语言上下文来源。因此建议将 locale 持久化到 `agent_run`。

## 术语与语义

### uiLocale

本方案中的 `uiLocale` 表示：

- 发起本轮 run 的前端当前 UI 语言
- 取值范围: `zh-CN | en-US`
- 用于生成 system prompt 中的语言要求

### 语言要求优先级

推荐优先级如下：

1. 用户在当前对话中的**明确语言要求**
2. 当前 run 的 `uiLocale`
3. 无 locale 时,不附加额外语言约束

换言之：

- `uiLocale` 决定默认语言
- 若用户明确要求切换语言,模型应遵循用户要求

## 分层设计

## 一、前端

### 语言来源

继续复用现有前端 i18n 体系：

- `getStoredLocale()` / 当前运行中的 `locale.value`
- 可选值: `zh-CN` / `en-US`

### 需要透传 locale 的入口

本期至少覆盖所有“会创建新 run”的入口：

- 发送消息: `POST /api/agent/sessions/:sessionId/messages`
- 压缩上下文: `POST /api/agent/sessions/:sessionId/compact`

未来若新增其他会显式创建 run 的入口,也应统一透传 `uiLocale`。

### 前端职责边界

前端只负责：

- 读取当前 locale
- 将 `uiLocale` 随 run 请求发送给 API

前端**不**负责手动拼装“请用中文回答”之类的 prompt 文本,避免污染 transcript 与业务层逻辑。

## 二、API 外部接口

### sendMessage 请求体扩展

现有 body 在 `workspaceId/text/clientRequestId/agentId?` 之外,增加：

- `uiLocale?: "zh-CN" | "en-US"`

### compactSession 请求体扩展

同样增加：

- `uiLocale?: "zh-CN" | "en-US"`

### 归一化策略

服务端对 `uiLocale` 进行 normalize：

- `zh-CN` -> `zh-CN`
- `en-US` -> `en-US`
- 其余非法值 -> `null`

建议：

- locale 无效时不报错,按缺失处理
- 避免因为附加偏好字段导致核心 run 创建失败

## 三、数据模型

### agent_run 扩展

建议在 `agent_run` 表新增列：

- `ui_locale text`

语义：

- 保存本轮 run 的语言偏好
- 可为 `null`

### 为什么放在 agent_run

`agent_run` 当前已经保存本轮运行上下文信息：

- agentId
- providerId
- modelId
- status
- triggerItemId

`ui_locale` 与这些字段同属“run 级上下文”,适合放在同一处。

### 兼容性

老数据中的 run 没有 `ui_locale` 时：

- 读取为 `null`
- 不影响现有逻辑

## 四、API 服务层

### 创建 run 时写入 uiLocale

在以下路径创建 run record 时,将 `uiLocale` 一并写入：

- `sendMessage()`
- `compactSession()`
- 以及其他未来新增的 run 创建路径

### 是否扩展 execution-profile

本期不必须。

原因：

- 语言约束真正需要的是 system prompt
- `getPromptContextForRun()` 已经是构造 system 的天然入口

除非后续有别的运行逻辑也需要 locale,否则可以先不把 locale 暴露到 execution-profile。

## 五、系统提示词组装

### 插入位置: 运行时约束(Runtime constraints)

当前 API 会在 `getPromptContextForRun()` 中调用 `buildSystemPrompt(...)` 构造最终 system。

推荐做法：

- 在 `getPromptContextForRun()` 中,先根据 run 的 `uiLocale` 生成 `languageInstruction`
- 在同一处生成当前系统时间与时区对应的 `runtimeTimeInstruction`
- 再把这两段内容作为新的可选参数传给 `buildSystemPrompt(...)`
- `buildSystemPrompt(...)` 统一负责拼接最终 system 字符串

这样可以保持：

- `buildSystemPrompt(...)` 仍是系统提示词唯一输出点
- locale 与系统时间的运行态决策逻辑留在 `getPromptContextForRun()`

### 为什么系统时间也应放在这里

系统时间与语言要求都属于 **run 级运行时上下文**：

- 不是 agent 的长期人格设定
- 不是 workspace 的长期规则
- 不是用户消息内容
- 而是本轮执行时模型需要知道的动态环境信息

因此建议将两者一起放在 system prompt 的“运行时约束”部分,而不是放到 transcript/user message 中。

其中：

- 语言来自前端透传的 `uiLocale`
- 系统时间与时区由后端在生成 prompt-context 时现算,不依赖前端时钟

### 插入顺序

推荐将语言要求作为“运行时约束”放在 system prompt 靠后位置,优先级高于普通背景说明：

建议整体层次：

- 全局 prompt / global prompts
- workspace instructions / AGENTS.md
- agent profile prompt
- **run 级运行时约束(语言要求 + 当前系统时间/时区)**

### 文案建议

#### 当 uiLocale = zh-CN

建议插入类似段落：

- 语言要求：本轮对话请统一使用简体中文。
- 对用户的回答使用简体中文。
- 内部思考/推理文本使用简体中文。
- 若调用 `todolist`,其中的 `goal` 与 `todos[].content` 必须使用简体中文。
- 代码、命令、路径、接口名、配置键名、报错原文等需要保真的内容可保持原样,不必翻译。
- 若用户明确要求使用其他语言,以用户明确要求为准。
- 当前系统时间：`2026-03-07 14:35:12`
- 当前时区：`Asia/Shanghai`

#### 当 uiLocale = en-US

建议插入类似段落：

- Language requirement: use English consistently for this run.
- Respond to the user in English.
- Use English for internal reasoning/thought text.
- If you call `todolist`, the `goal` and `todos[].content` must also be in English.
- Code, commands, paths, API names, config keys, and original error messages may remain verbatim when needed.
- If the user explicitly asks for another language, follow the user’s explicit instruction.
- Current system time: `2026-03-07 14:35:12`
- Time zone: `Asia/Shanghai`

### 为什么要显式点名 todolist

仅写“请用中文回答/请用英文回答”不足以稳定约束工具参数。

为了提高模型在调用 `todolist` 时的遵循度,建议在语言要求中明确点名：

- `goal`
- `todos[].content`

都应使用对应语言。

### 系统时间的作用与边界

系统时间有助于模型正确理解：

- 今天 / 本周 / 最近
- 日志时间窗口
- 过期时间、调度时间、时间相关文档表述

建议：

- 至少向模型提供“当前系统时间 + 时区”
- 不必写过长解释,保持为简洁、明确的运行时信息即可

不建议：

- 由前端传时间给后端
- 将时间塞进用户消息或系统 context item 中

## 六、对 reasoning 的影响

本项目会持久化并展示 assistant reasoning 文本。系统提示词可以对 reasoning 的语言产生较强影响,但需注意：

- 不同模型对 reasoning 语言的服从程度不完全一致
- 对回答语言的约束通常比对 reasoning 更稳定

因此本方案的预期应为：

- **通过 system prompt 强约束 reasoning 语言**
- 但不将其视为 100% 底层硬保证

## 七、兼容性策略

### 缺失 locale

若 run 未记录 `uiLocale`：

- 不附加语言要求段
- 保持现有 system prompt 逻辑不变

### 非法 locale

若前端传入非法值：

- normalize 失败后视为 `null`
- 不报错
- 不附加语言要求段

### 旧 run / 旧数据

旧 run 没有 `ui_locale` 时：

- prompt context 仍可正常生成
- 不会破坏现有会话与测试

## 八、风险与取舍

### 风险 1: UI 语言与期望回答语言可能不一致

本方案默认将 `/settings/basic/general` 的 UI 语言作为 agent 输出语言。

这意味着存在一种情况：

- 用户想用英文 UI
- 但希望 agent 回答中文

本方案的处理原则是：

- UI 语言仅决定默认语言
- 若用户明确提出使用其他语言,以用户明确要求为准

### 风险 2: 多客户端并发

同一 session 可能被不同客户端以不同语言发起新 run。

本方案对此的语义是明确的：

- 每个 run 只遵循其创建时的 `uiLocale`
- 不强行把语言统一到 session 级别

### 风险 3: 工具输出中存在不可翻译内容

如：

- shell 命令
- 文件路径
- API 名称
- 配置键
- 原始报错

本方案通过 system prompt 中的豁免条款处理：

- 这些内容可保持原样
- 不要求强制翻译

## 八、运行时约束的建议内容

建议在本方案中统一落地以下 run 级信息：

1. `uiLocale` 对应的语言要求
2. 当前系统时间
3. 当前时区

这样可以让 system prompt 中的“运行时约束”形成一个稳定、可扩展的分组,后续如需补充其他运行时环境信息,也有一致的插入位置。

## 九、测试建议

### API 集成测试

重点验证 `getPromptContextForRun()` 返回的 `system` 是否包含预期语言约束。

建议覆盖：

- `uiLocale = zh-CN`
  - `system` 包含简体中文约束
  - 包含对 `todolist` 的中文约束
  - 包含系统时间与时区信息
- `uiLocale = en-US`
  - `system` 包含英文约束
  - 包含对 `todolist` 的英文约束
  - 包含系统时间与时区信息
- `uiLocale` 缺失
  - `system` 中不应出现语言要求段
  - 时间信息可按产品决策选择始终存在或仅在约束块存在时出现；建议明确固定策略
- `uiLocale` 非法
  - 不报错,且 `system` 中不应出现语言要求段

### run 持久化测试

建议验证：

- 创建 run 时,`agent_run.ui_locale` 被正确写入
- 缺失 / 非法值时写入为 `null` 或不写入

### 前端请求测试

若已有相关 API 请求测试,建议补充：

- sendMessage 请求体带上当前 locale
- compactSession 请求体带上当前 locale

## 十、实施顺序建议

### 第一阶段(推荐本期范围)

- 前端 run 入口透传 `uiLocale`
- `agent_run` 增加 `ui_locale`
- `getPromptContextForRun()` 根据 run locale 注入运行时约束(语言要求 + 系统时间/时区)
- 补集成测试

### 第二阶段(可选后续)

若后续发现“UI 语言 ≠ Agent 输出语言”的需求更强,可考虑：

- 单独新增 `Agent Output Language` 设置项
- 或将语言约束从 basic/general 中拆分出来

本期不建议直接做这一步,避免扩大范围。

## 结论

本方案通过 **前端 locale -> run 持久化 -> system prompt 注入** 的链路,在不改变 basic/general 现有产品语义的前提下,让 Agent 在每次新 run 中遵循当前前端语言设置,并获得稳定的时间上下文。

核心收益：

- 保持现有 UI 语言设置机制不变
- 语言偏好成为稳定的 run 级上下文
- 统一约束回答、reasoning 与 `todolist`,并提供当前系统时间/时区
- 对旧数据与缺失 locale 场景保持兼容

因此推荐采用 A2 方案作为本期实现方向。
