# 系统提示词(Global + Workspace)方案(v1)

本文档定义 agent-workbench 的系统提示词(system prompt)能力,分为 Global(全局)与 Workspace(工作区)两部分.本方案不实现 read 的目录级提示词(不做向上查找或按目录叠加).

## 背景与现状

- 当前模型调用只接受一个 `system` 字符串,由 API 的 prompt-context 提供.
- 现状 `system` 等于 agent profile 的 `prompt`,即 `profile.agent.prompt`.
- Worker 侧不关心 system 的来源,只负责把 `system` 与 `messages` 传给 ai-sdk.

## 目标

- 增加 Global 系统提示词库(前端显示为"提示词库")
  - 不依赖文件,在 Settings 中维护.
  - 以列表形式管理: 每条包含 title + prompt.
  - Global 提示词不自动注入所有请求,而是与 agent profile 关联.
- 增加 Workspace 系统提示词
  - 采用 `AGENTS.md` 模式.
  - 文件仅支持放置在 workspace 根目录.
  - 自动读取并添加到模型请求的 `system`.
  - `AGENTS.md` 缺失时忽略.
  - 对 `AGENTS.md` 内容做 32KB 截断,防止异常文件导致 system 过大.
- 拼接顺序固定
  - Global -> Workspace -> Agent.

## 非目标

- 不做目录级规则(例如 repo 子目录或任意子目录的 `AGENTS.md`).
- 不解析 `AGENTS.md` 内的 include 语法(例如 `@file`,`include`,或 JSON 结构),只按纯文本处理.
- 不引入总 system 长度上限(除 workspace `AGENTS.md` 的 32KB 截断).
- 不做 session 级别覆盖(例如同一个 agent 在不同 session 选择不同的 Global 提示词组合).

## 设计概览

### 系统提示词生成

- system prompt 最终是一段字符串 `system: string`.
- system 由多个来源拼接而成,每个来源以可读的分隔标记包裹,便于排障.
- 拼接顺序:
  - Global prompt entries(按全局列表顺序过滤出 agent 选中的条目)
  - Workspace `AGENTS.md`(若存在)
  - Agent profile `prompt`

### Global prompt 的顺序(方案A)

- agent profile 仅保存一个“选择集合”(`selectedGlobalPromptIds`).
- 生成 system 时,遍历 Global prompt 列表本身的顺序,命中则拼接.
- 由此保证:
  - 无需在 agent UI 中提供排序功能.
  - system 拼接顺序稳定且可预测.

## 数据模型

### Settings: Global prompt 列表

- 新增 settings key(示例): `agent_global_prompts_v1`.
- 结构(建议):
  - `updatedAt: number`
  - `items: Array<{ id: string; title: string; prompt: string; createdAt: number; updatedAt: number }>`
- 约束(建议,用于前端与保存接口校验):
  - `title` 必填,长度上限 20.
  - `prompt` 可为空,为空则跳过注入.
  - `prompt` 建议做字节上限校验(例如 32KB),防止误粘贴导致 settings 过大.

### Agent profile: 选择的 Global prompt

- 扩展 AgentItem(示例字段名):
  - `globalPromptIds: string[]` (多选,无序;实际注入按 Global 列表顺序)
- 兼容性:
  - 旧数据缺失该字段时,normalize 为 `[]`.
  - 引用不存在的 id 时,运行时忽略.

## API 设计

### Settings API

- 新增 endpoints(示例):
  - `GET /api/settings/agent/global-prompts`
  - `PUT /api/settings/agent/global-prompts`
- 行为:
  - `GET` 返回完整列表.
  - `PUT` 覆盖更新列表(服务端负责 normalize,去重 id,基础字段校验).

### prompt-context 注入点

- system 拼接在 API 构建 prompt-context 时完成.
- 生成 system 的输入:
  - workspaceId(用于定位 workspace 根目录)
  - 当前 run 固化后的 agentId(用于获取 agent profile 与其 globalPromptIds)
  - settings 中的 Global prompt 列表
  - workspace 根目录下的 `AGENTS.md` 内容(若存在)
- 输出:
  - `system: string` 为最终拼接结果.

## Workspace `AGENTS.md` 读取与截断

### 文件位置

- 路径固定为 workspace 根目录下 `AGENTS.md`.
- 不扫描 repo 子目录.

### 读取策略

- 若文件不存在(ENOENT),返回空,不影响 system.
- 若文件不是普通文件(例如目录/软链/设备文件),忽略.
- 若读取失败(权限/IO 错误),忽略并记录日志,不让 run 失败.

### 截断策略

- 最大读取: 32KB(以 UTF-8 bytes 计).
- 若超过 32KB:
  - system 中仅注入前 32KB.
  - 追加一条明确提示,例如:
    - `[workspace AGENTS.md truncated: first 32KB]`
- 建议实现时避免 UTF-8 半字符截断:
  - 以 Buffer 读取前 N bytes.
  - 解码失败时用替换字符策略或回退为更保守的截断方式.

## system 拼接格式(建议)

system 由多个 section 组成,section 之间以空行分隔.

- Global section:
  - `## Global Prompt: <title>`
  - `<prompt>`
- Workspace section:
  - `## Workspace Instructions: AGENTS.md`
  - `<content or truncated content>`
- Agent section:
  - `## Agent Prompt: <agent.name>`
  - `<agent.prompt>`

说明:

- Global/Agent 的 prompt 若为纯空白,跳过该 section.
- Workspace `AGENTS.md` 若为空白,也可跳过.

## 前端 UI 方案

### Settings: 提示词库 Tab

- 新增一个 Settings tab 页,用于管理 Global prompt 列表(前端显示为"提示词库").
- 列表展示:
  - title
  - prompt 预览(可折叠)
  - 操作: 新建/编辑/删除
- 编辑弹窗/侧栏表单:
  - title 输入
  - prompt 多行文本
  - 保存时做长度校验(例如 prompt <= 32KB).

### Agent Profiles: 选择 Global prompts

- 在 agent profile 编辑表单中增加多选控件,用于选择 Global prompt 条目.
- 不提供排序 UI.
- 文案提示:
  - 注入顺序由 Global prompt 列表的顺序决定.

## 兼容性与演进

- 兼容已有行为:
  - 当 agent 未选择 Global prompts 且 workspace 无 `AGENTS.md` 时,system 等于原来的 `agent.prompt`.
- 与 opencode 的差异:
  - 仅支持 workspace 根目录 `AGENTS.md`.
  - 不做目录级向上查找.
  - 不解析 `AGENTS.md` 的 include 语法.

## 风险与对策

- Workspace `AGENTS.md` 过大或异常
  - 32KB 截断 + 忽略非普通文件 + 读取失败忽略.
- 多来源提示词冲突
  - 固定拼接顺序(Global -> Workspace -> Agent).
  - 通过 section header 提高可解释性.
- 性能
  - 每次 prompt-context 构建可能读取一次 `AGENTS.md`.
  - v1 可直接读取;若后续需要优化,可按 mtime 做简单缓存.

## 验证计划

- 单元测试/集成测试(建议最小集合):
  - Global 多选: 注入顺序遵循 Global 列表顺序(方案A).
  - Workspace `AGENTS.md` 不存在时不注入.
  - Workspace `AGENTS.md` 超过 32KB 时截断并追加提示.
  - 旧 agent settings 不包含 `globalPromptIds` 时可正常运行(缺省为 `[]`).

- 手工验证:
  - Settings 中新增/编辑/删除 Global prompt 后,agent profile 选择生效.
  - 在 workspace 根目录添加 `AGENTS.md`,发起一次 run,确认 system 中包含该内容.
