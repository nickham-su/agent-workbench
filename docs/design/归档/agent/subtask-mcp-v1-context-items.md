# Subtask 与 MCP tools 一期方案(context item 版)

## 背景

- 当前 agent 运行时已稳定支持 `bash/read/write` 与 context item 链式上下文.
- 本期目标是引入 `subtask` 与 `MCP tools`,并保持现有前端刷新与消息流体验.
- 本文档以当前实现为准,不采用旧版事件溯源叙事.

## 本期目标

- 支持 `subtask` 工具,并提供 `new/existing/fork` 三种 session 策略.
- 支持 `MCP tools` 接入,含全局配置,连接,工具发现,工具调用.
- MCP 配置在 Settings 页面提供列表管理,新增/编辑使用 JSON 输入框.
- Agent 对 MCP 的可用性按 server 粒度控制.
- `subtask` 与 `MCP tools` 均不走审批流,仅做可见/可用控制.
- 前端支持从主 session 跳转到子 session 新 tab,子 session 纯只读.

## 非目标

- 本期不实现 MCP resources/prompts UI.
- 本期不实现 `subtaskRunId` 对外展示与操作.
- 本期不实现按历史任意 item 选择 fork 锚点.
- 本期不重构现有主会话轮询机制.

## 产品定稿约束

- MCP 配置为全局配置.
- MCP 配置展示为列表.
- MCP 新增/编辑使用 JSON 表单输入.
- Agent 中 MCP 开关按 server 粒度配置.
- `subtask` 与 `MCP` 不触发 permission ask.
- `subtask` 的 fork 语义固定为复制父 session 调用点之前的上下文.
- 若第 5 条 context item 触发 subtask,则 fork 复制 1-4.
- `existing(sessionId)` 允许复用,但服务端需做防呆校验.
- 子 session 新 tab 打开后为纯只读,隐藏输入框与 `revert/fork` 按钮.

## 术语与语义

### Subtask 调用锚点

- 锚点定义为本次 `subtask` tool item 本身.
- `fork` 复制范围为 `anchor.prevId` 及之前全部可见链路.
- `anchor` 本身与其后续内容不复制到子 session.

### 可见/可用

- 可见: 工具定义会出现在模型可调用工具集合中.
- 可用: Worker 执行时允许实际调用.
- 本期 `subtask` 与 `MCP` 的权限模型等价为 "可见即可用".

## 数据模型与共享契约改造

## settings 契约

- 扩展 `packages/shared/src/contracts/settings.ts`.
- 新增 MCP 全局配置 schema,建议结构:
  - `mcp.defaultTimeoutMs` 可选.
  - `mcp.servers` 为数组,每项包含:
    - `id`(server 唯一标识)
    - `enabled`
    - `configJson`(原始 JSON 字符串,用于表单回显)
    - `config`(解析后的结构化对象)
- `config` 支持两类:
  - local: `type=local`, `command`, `environment`, `timeout`
  - remote: `type=remote`, `url`, `headers`, `oauth`, `timeout`
- Agent 配置扩展:
  - `tools` 增加 `subtask`
  - 新增 `mcpServers: string[]`,用于按 server 控制 MCP 可见/可用.

## agent 契约

- 扩展 `packages/shared/src/contracts/agent.ts`.
- `AgentContextToolNameSchema` 从固定枚举改为:
  - 内置: `bash/read/write/subtask`
  - MCP: `mcp_<server>_<tool>`
- `AgentToolOutputSchema.toolName` 同步放开上述类型.
- 输出先保留现有 `result/error` 结构,避免一次性大改.

## API 路由契约

- 更新 `apps/api/src/modules/agent/agent.routes.ts` 内部接口 schema:
  - `/api/internal/agent/prompt-context` 的 `tools[].name`
  - `/api/internal/agent/prompt-context` 的 `pendingTools[].toolName`
  - `/api/internal/agent/execution-profile` 的 `agent.tools`
- 增加 MCP settings 路由:
  - `GET /api/settings/agent/mcp`
  - `PUT /api/settings/agent/mcp`

## Settings 方案(MCP 全局配置)

## 存储与服务

- 在 `settings.service.ts` 增加 MCP settings key,例如 `agent_mcp_v1`.
- 读取时进行 normalize:
  - 去重 `id`
  - 过滤非法 JSON
  - 默认 `enabled=true`
- 写入时进行 validate:
  - JSON 必须为对象
  - 必须包含 `type`
  - `local/remote` 分支字段校验
  - 拒绝包含 `\0/\n/\r` 的危险字符串字段

## 前端页面

- 参考 Agent 配置页实现 MCP 列表区块.
- 列表列建议:
  - `id`
  - `type`
  - `enabled`
  - `状态`(connected/failed/disabled 等)
  - `操作`(编辑/删除)
- 新增与编辑弹窗字段:
  - `server id` 输入框
  - `JSON 配置` 输入框(多行编辑器)
- 提交前前端先做 JSON parse,并展示精确错误位置.

## Agent 能力模型

- `agent.tools` 扩展为 `bash/read/write/subtask`.
- 新增 `agent.mcpServers`:
  - 空数组表示不暴露任何 MCP server
  - 包含 `serverA` 表示允许该 server 下所有 MCP tool
- 运行时构建 prompt tools 时:
  - 内置工具由 `agent.tools` 控制
  - MCP 工具先由全局连接状态发现,再按 `agent.mcpServers` 过滤

## Subtask 工具设计

## 输入参数

- `description: string`
- `prompt: string`
- `agentId: string` 或沿用当前命名 `subagent_type`
- `session`:
  - `mode: "new"`
  - `mode: "existing", sessionId`
  - `mode: "fork"`

## 执行策略

- `new`:
  - 创建 `kind=subtask` session
  - 不复制父上下文
- `existing(sessionId)`:
  - 复用现有 subtask session
  - 服务端校验:
    - session 存在
    - 同 workspace
    - `kind=subtask`
- `fork`:
  - 创建新 `kind=subtask` session
  - 复制父 session 从起点到 `anchor.prevId` 的可见上下文
  - 不复制 `anchor` 和之后 item

## 输出

- 本期仅回传:
  - `subtaskSessionId`
  - `resultText`
- 不处理 `subtaskRunId`.

## 可见性与权限

- 若 agent 未启用 `subtask`,模型不可见该工具.
- 若已启用则可直接执行,不进入 `awaiting_permission`.

## MCP tools 设计

## McpManager

- 在 Worker 侧新增 `McpManager`.
- 职责:
  - 读取全局 MCP 配置
  - 建立 local/remote 连接
  - 缓存 server 状态
  - 拉取工具列表并生成运行时定义
  - 执行 `callTool`

## 工具命名

- 沿用兼容策略: `mcp_<sanitize(server)>_<sanitize(tool)>`.
- sanitize 规则: 仅保留 `[a-zA-Z0-9_-]`,其余替换 `_`.

## 运行时接入

- `AgentService.getPromptContextForRun` 输出 tools 时加入 MCP 结果.
- 仅返回 agent 已授权 server 下的 MCP 工具.
- `runner.ts` 放开 toolName 识别:
  - 内置 `bash/read/write/subtask`
  - 前缀 `mcp_`
- `executeTool` 分支新增 MCP 调用:
  - 路由到 `McpManager.callTool`
  - 返回结果写入现有 tool item `result`

## 审批流

- MCP 不进入审批流.
- 不写入 `approved` 相关状态迁移.
- 保持状态机简化为 `queued -> running -> completed|failed`.

## Agent 服务与 Prompt 构建改造

- `apps/api/src/modules/agent/agent.service.ts`:
  - `toolArgsSchema/toolDescription` 增加 `subtask`
  - 支持动态 MCP tool schema 注入
  - `pendingTools` 与 tool result 聚合逻辑支持新工具名
- `apps/agent-worker/src/runtime/apiClient.ts`:
  - PromptContext 类型放开 toolName
  - tools 列表支持动态工具

## Runner 改造要点

- `normalizeToolName` 从固定枚举改为:
  - 若为内置工具返回内置名
  - 若前缀为 `mcp_` 返回原值
- `recognizedCalls` 不再只过滤 `bash/read/write`.
- `executePendingTools` 支持 `subtask` 与 `mcp_`.
- `executeTool` 增加分支:
  - `subtask`: 调用 API 创建/复用 session 并触发子 run,等待结果
  - `mcp_`: 调用 McpManager
- run 取消时,若存在活动子任务,同步取消子 run.

## 子 session 前端交互

## 打开方式

- 主 session 中 subtask 工具消息提供 "打开子任务" 动作.
- 点击后新建一个 tab,加载 `subtaskSessionId`.

## 只读模式

- 判断 `session.kind === "subtask"` 时启用只读模式.
- 只读模式行为:
  - 隐藏输入框
  - 隐藏发送相关控件
  - 隐藏 `revert/fork` 按钮
  - 禁止提交消息 API 调用
- 刷新与轮询机制完全复用主 session.

## 后端只读兜底

- `sendMessage` 对 `kind=subtask` 返回 400.
- 统一错误码建议: `AGENT_SUBTASK_READONLY`.

## 兼容与迁移

- 老数据中无 `subtask` 与 MCP 字段时:
  - `agent.tools` 默认仍为 `bash/read/write`
  - `agent.mcpServers` 默认 `[]`
  - MCP settings 默认空列表
- 老客户端忽略新字段仍可工作.
- 新客户端读取旧数据应自动补默认值.

## 验收清单

- MCP settings 列表可新增/编辑/删除 server.
- JSON 输入非法时前后端都能给出明确错误.
- MCP 连接后可在模型工具列表中出现 `mcp_*` 工具.
- Agent 仅能看到 `mcpServers` 允许的 server 工具.
- `subtask` 三种模式均可执行.
- `fork` 模式满足 "第 N 条调用,复制 1..N-1".
- `existing(sessionId)` 参数错误会被后端拦截.
- 子 session 新 tab 打开成功,并且纯只读.
- 子 session 轮询与主 session 一致,无手动刷新依赖.

## 开发拆分建议

## shared

- 修改 `contracts/settings.ts`.
- 修改 `contracts/agent.ts`.

## api

- 扩展 settings store/service/routes 的 MCP 配置能力.
- 扩展 agent service/routes 的动态工具与 subtask 校验能力.
- 增加子任务只读兜底.

## agent-worker

- 新增 `runtime/mcpManager.ts`.
- 扩展 `runner.ts` 的工具识别与执行路由.
- 扩展 `apiClient.ts` 的动态工具类型.

## web

- settings 页面新增 MCP 列表与 JSON 编辑弹窗.
- agent 配置页面新增 `subtask` 与 `mcpServers` 控件.
- session tab 支持 subtask 只读视图与跳转.
