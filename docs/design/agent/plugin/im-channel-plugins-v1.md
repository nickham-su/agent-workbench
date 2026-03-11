# IM 对接插件（channels + services）方案 v1

Status: draft

> 本文面向工程落地，描述如何在 **agent-workbench 已落地的本地工具插件体系**基础上，扩展出 **IM 对接插件能力**（`channels + services`），以支持飞书机器人私聊/群聊与 Agent Session 的绑定与对话。
>
> 约束：本文只描述设计与落地路径，不包含代码变更。

---

## 1. 现状对齐：本地工具插件已落地（不推翻整体原则）

### 1.1 已落地的关键能力

当前仓库已经实现并上线了“本地工具插件（tools）”的完整闭环：

- shared：插件 contracts、settings 扩展（manifest / diagnostics / snapshot / agent 侧 pluginTools）
- API：插件治理（扫描目录、manifest 校验、config schema 校验、enabled 管理、runtime snapshot 下发）
- worker：插件工具加载与执行（PluginRuntimeManager + LocalPluginToolProvider 进入 ToolRegistry）
- web：插件启用开关与工具选择（全局 enable/disable、agent profile 选择 pluginTools）

这套体系是 IM 插件 v1 的基础，IM 扩展必须：

- 复用现有插件目录与治理策略（强治理、manifest 必填、配置校验、diagnostics）
- 不破坏现有 builtin/MCP/tool plugin 的工具执行链路
- 只新增 channels/services 的能力与运行时，不改变 tools 已有对外行为

### 1.2 已落地的关键模块（代码位置）

> 下面列出“工具插件”现状的主要代码入口，便于后续扩展时定位复用点。

| 层 | 能力 | 关键模块 | 路径 |
|---|---|---|---|
| shared | 插件契约 | `PluginManifestSchema`, `PluginRuntimeSnapshotSchema`, `AgentPluginSettingsSchema`, `PluginCapabilitySchema` | `packages/shared/src/contracts/plugin.ts` |
| shared | agent 配置 | `AgentItemSchema.pluginTools`（agent 按工具启用） | `packages/shared/src/contracts/settings.ts` |
| API | 插件治理 | 扫描 `<dataDir>/plugins/*`、校验 manifest/entry、校验 config、生成 runtime snapshot | `apps/api/src/modules/plugins/plugin.service.ts` |
| API | 插件 routes | `GET/PUT /api/settings/agent/plugins`、`GET /runtime-snapshots` | `apps/api/src/modules/plugins/plugin.routes.ts` |
| API→worker | 内部快照 | `POST /api/internal/agent/plugins/runtime-snapshots` | `apps/api/src/modules/agent/agent.routes.ts` |
| worker | 插件运行时 | `PluginRuntimeManager`（当前以 tools 为主） | `apps/agent-worker/src/runtime/plugins/runtimeManager.ts` |
| worker | 工具接入 | `LocalPluginToolProvider` | `apps/agent-worker/src/runtime/tools/providers/local-plugin.ts` |
| worker | 工具统一注册 | `ToolRegistry` | `apps/agent-worker/src/runtime/tools/registry.ts` |

### 1.3 重要现状约束：工具插件 canonical name 体系

当前已落地的 plugin tool canonical name 使用 **provider-safe 单一命名体系**：

- `plugin_<pluginId>_<toolShortName>`
- shared 正则：`PluginToolCanonicalNameSchema`

见：`packages/shared/src/contracts/plugin.ts`。

IM 插件方案在描述 “channel/service 的唯一标识” 时，需要与该策略保持一致（避免引入冒号命名导致跨 provider 不一致）。

---

## 2. IM 插件 v1 目标与范围

### 2.1 目标（已确认需求）

以“飞书机器人”作为 v1 首个 IM 渠道落地案例：

- 支持飞书机器人对接，**私聊 + 群聊** 收发文本
- 支持将“飞书会话（chat）”与 `agent-workbench` 的 `agent session` 绑定
- 支持先选 session，再选 agent，然后对话
- 支持群聊多人场景下的“消息聚合”输入模型

### 2.2 命令集（已确认）

命令均在飞书消息文本中触发，命令解析按行首开始：

- `/ss`
  - 无参：跨 **所有 workspace** 列最近更新的 10 个 session（`title + id + workspace 标识`）
    - workspace 标识默认格式（执行前默认推荐）：
      - 展示名：优先使用 `workspace.title`，若为空则回退 `workspace.dirName`
      - 并附加 `workspaceId`（建议括号附上）
      - 示例：`agent-workbench (w_abc123)`
  - `/ss <sessionId|index>`：绑定/覆盖当前飞书会话到 session
    - 若切换到新的 session：清空当前会话的 agent 选择（必须重新 `/a`）
- `/a`
  - 无参：列当前 session 所在 workspace 可选 agent 列表（支持序号）
  - `/a <agentId|index>`：选择 agent
- `/st`
  - 展示汇总状态（运行中/已运行时长/activeRunId/最近一次总 tokens/上下文窗口 tokens 与占比/runNoticeText 等）
- `/h`
  - 帮助

### 2.3 普通消息投递规则（已确认）

普通消息（非命令）在进入模型前必须满足：

1) 已绑定 session（否则提示先 `/ss`）
2) 已选择 agent（否则提示先 `/a`）
3) session 当前 `runState.status === idle`
   - 若 `running`：**沿用 web 规则**，拒绝创建 run，并返回更详细的状态摘要（同 `/st`）

### 2.4 群聊规则（已确认 + 分期）

- 多人群（>2 人）需要 `@机器人` 才处理普通消息（减少误触发）
- 双人群免 `@`：作为可配置优化
  - 建议实现阶段：v1.5（见落地计划），v1 先按“群聊默认需要 @”

### 2.5 多人群 @ 触发时的消息聚合（已确认）

在多人群中，当有人 `@机器人` 触发对话时：

- 支持将“上次水位后未投递的群消息”聚合为 **单条 user 消息**发送给模型
- 不要求飞书消息与模型 messages 一一对应
- 聚合时为每条消息增加用户名前缀，并用分隔符分隔

群聚合窗口默认值与截断策略（执行前默认推荐）：

- 默认值：
  - `maxMessages = 50`
  - `maxChars = 8000`
- 截断策略：
  1) 超过 `maxMessages` 时：优先丢弃更早的消息（保留更接近触发点的上下文）。
  2) 若在满足 `maxMessages` 后仍超过 `maxChars`：对“最早保留的一条消息”进行尾部截断。
  3) 发生丢弃/截断时：在聚合文本顶部增加提示行，例如：
     - `（提示：已省略更早的群消息，或部分内容已截断）`
- 文本格式：
  - 每条消息：`senderName: text`
  - 分隔符：使用单独一行 `---`

> 注意：聚合能力要求下沉到宿主 `ChannelRuntime`（见 5.3），插件仅负责提交 inbound。

### 2.6 插件配置（已确认）

飞书插件配置至少包含：

- `appId`
- `appSecret`（敏感字段，必须脱敏/不回显）

---

## 3. 总体架构：在 tools 插件基础上扩展 channels + services

### 3.1 插件能力模型（capability container）

插件依旧是一个 capability 容器：

- `tools`：模型工具（已落地）
- `channels`：IM 通道能力（本方案新增）
- `services`：后台服务能力（本方案新增）
- `hooks`：本期不落地，但保留扩展位

> v1 IM 只实现 `channels/services` 的宿主运行时，不改变 `tools` 的对外行为。

### 3.2 进程职责边界（推荐）

- API：治理 + IM 运行时（channels/services） + 对 worker 的 tool RPC 入口
- worker：模型推理与主循环，工具执行通过“tool RPC provider”调用（见 5.1）

> 这是一项关键优化：**单一权威加载点**，避免 API/worker 双端重复 import 同一个插件包。

---

## 4. 本次必须纳入的优化点（已确认）

> 以下 6 点为本次必须做的优化，原因是：若后置，会导致 IM 插件实现复杂化、泄密风险、或重复触发 run 的稳定性问题。

### 4.1 单一权威加载点（避免 API/worker 双端重复 import 插件包）

#### 问题

当前工具插件实现由 worker import 插件包并执行 tools。若未来同一插件包同时提供 `tools + channels + services`（例如飞书既要 IM，又要日程工具），则会出现：

- API 为 channels/services 需要 import 插件包
- worker 为 tools 也需要 import 插件包

这会违反“单一事实来源”，引入双端加载副作用、配置漂移与诊断复杂度。

#### 推荐落地方式（v1 推荐）

引入 **Plugin Host（权威加载点）**，由 API（或其子进程）负责：

1) 统一 import 插件包入口
2) 解析并校验 runtime definition（tools/channels/services）
3) 运行 channels/services
4) 对外提供工具执行 RPC，供 worker 调用

Plugin Host 运行形态（执行前默认推荐）：

- 推荐：由 API 进程管理的独立子进程作为 Plugin Host（例如 `agent-plugin-host`），API internal routes 作为代理/门面。
- API 与 plugin-host 通信方式：
  - 默认推荐：unix domain socket（便于权限隔离、热重启与故障诊断）
  - 备选：`child_process.fork()` 的 IPC message channel
- worker 侧约束：仅调用 API internal routes（见第 7 节 Tool RPC），不直接连接 plugin-host。

理由：

- 隔离插件代码，避免阻塞 Fastify event loop（插件可能进行网络 IO / CPU 密集操作）。
- plugin-host 崩溃可由 API 自动重启，降低“插件问题影响主服务”的风险。
- worker 仅依赖 API internal routes，有利于统一鉴权、审计与错误归一化。

worker 不再 import 插件包，仅通过 RPC：

- 列出工具定义（含 schema）
- 执行工具

> 这相当于把“本地工具插件”改造成一个“本地 RPC 工具源”，与 MCP 的思想一致，但运行于本地受控进程。

#### 与现有已落地 tools 插件兼容的迁移路径

- 迁移前：worker 本地执行 plugin tools（现状）
- 迁移后：worker 改为 `RemotePluginToolProvider`（或类似）
  - `listTools()`：从 API/Plugin Host 获取（快照或实时查询）
  - `execute()`：调用 API/Plugin Host 的 internal tool-exec route

此迁移不改变：

- 工具输出契约（text 必填，raw 可选）
- ToolRegistry 的统一抽象（provider 化）
- 插件治理（manifest/config/diagnostics）

仅改变：

- plugin tools 的执行地点（从 worker 本地执行 -> plugin host 执行）

> 说明：由于该变更较大，建议通过 feature flag 或分阶段切换，确保可回滚。

### 4.2 `/st` 状态摘要由 API 聚合提供（避免 IM 插件复制 web 逻辑）

#### 问题

web 端展示的 run 状态信息来自多处：

- `GET /api/agent/sessions/:sessionId/run-state` 返回 runState（含 lastResponseTotalTokens/runNoticeText 等）
- “已运行时长”在 web 端是通过最近 user message 时间估算
- “上下文窗口 tokens”来自 agent/model 配置

如果 IM 插件自行拼装，会导致：

- IM 端逻辑与 web 端重复且易漂移
- 缺乏稳定、可测试的状态摘要输出

#### 推荐落地方式

在 API 新增一个**内部聚合方法/接口**（可先 internal-only）：

- `getSessionStatusSummary(sessionId, selectedAgentId?) -> summary`

summary 至少包含：

- session：`workspaceId/title/sessionId`
- agent：`selectedAgentId` + 展示名
- runState：`status/activeRunId/runNoticeText/lastResponseTotalTokens/updatedAt`
- running elapsed：
  - 推荐从 `agent_run.created_at`（activeRunId 对应记录）计算（现有 DB 已有 `agent_run` 表）
- contextWindowTokens：
  - 推荐通过复用现有 profile 解析逻辑（`resolveExecutionProfile`）得到 model 的 `contextWindowTokens`
- ratio：`lastResponseTotalTokens / contextWindowTokens`

IM 插件命令 `/st` 与 running 冲突提示，都直接复用该摘要。

### 4.3 群消息聚合能力下沉到宿主 ChannelRuntime

#### 问题

“多人群 @ 触发时聚合消息”若由插件自行实现，会导致：

- 每个渠道插件重复实现缓冲/水位/窗口/拼装
- 难以统一幂等与去重策略
- 难以统一审计日志与治理

#### 推荐落地方式

由宿主 `ChannelRuntime` 提供以下能力：

- `ingestInboundMessage(...)`：将 inbound 写入宿主 buffer（DB）并做去重
- `buildAggregatedUserPrompt(...)`：按 conversation 水位 + 窗口限制构造单条 user message
- `advanceWatermark(...)`：在成功触发 run 后推进水位

插件只负责：

- 将飞书 inbound 标准化后提交给 `ChannelRuntime`
- 不负责自行存储“未投递消息列表”

### 4.4 插件 config 敏感字段脱敏/不回显 + 更新策略

#### 问题

飞书 `appSecret` 是敏感信息。当前 plugin settings API 会返回 `config` 给 web，若不处理会泄露。

#### 推荐落地方式

- manifest 增加 `secrets` 或 `uiHints.sensitiveKeys`（任一方式即可）声明哪些 config key 为敏感
- API 在 `getAgentPluginSettings` 与 `runtime snapshots` 输出中：
  - 对敏感字段进行脱敏（例如返回 `"***"` 或 `{ masked: true }`）
  - 不回显真实 secret
- 更新策略：
  - `PUT /api/settings/agent/plugins` 时，若敏感字段为空字符串或缺省：表示“不修改 secret”
  - 只有显式提供非空新值才覆盖

> 说明：该策略应复用 provider apiKeyMasked 的经验（见 web provider settings 对 apiKey 的 mask 处理），避免重复造轮子。

### 4.5 绑定与操作权限：至少 allowlist

#### 问题

`/ss` 跨所有 workspace 列 session，并允许绑定到任意 session。若不做权限限制，会导致：

- 任意能对机器人发消息的人都能绑定/操作 session

#### 推荐落地方式（最小）

在飞书插件 config 中加入 allowlist：

- `allowedSenderOpenIds: string[]`

规则：

- `/ss`、`/a`、普通消息触发（包括 @ 触发）均要求 sender 在 allowlist 内
- 不在 allowlist 的 sender：
  - 命令返回“无权限”
  - 普通消息直接忽略或返回简短拒绝（建议忽略以减少群刷屏）

> 说明：v1 只做 allowlist，不引入完整 workspace 权限系统；后续可扩展到“允许绑定哪些 workspace/session”。

### 4.6 幂等与去重下沉：外部 message_id 去重、命令幂等

#### 问题

IM 平台事件可能重复投递。若重复触发，会导致：

- 重复创建 run
- 重复发送回复
- 群聚合水位混乱

#### 推荐落地方式

在宿主 `ChannelRuntime` 实现统一的：

- inbound 去重：`(pluginId, conversationKey, externalMessageId)` 唯一
- 命令幂等：
  - 对 `/ss <...>`、`/a <...>` 维护幂等键（例如 `commandKey + payloadHash`）
  - 防止同一条消息重复执行“绑定/选 agent”并造成噪声

同时复用 agent 现有的 run dedup 机制：

- `agent_client_request` 已支持 `clientRequestId` 去重（见 `agent.service.ts#sendMessage`）
- IM 触发 run 时应为每个外部 message_id 生成稳定的 `clientRequestId`，从而在 agent 层进一步去重

---

## 5. 新增模块清单与职责边界

> 本节描述在现有工具插件体系基础上，需要新增的 shared/API/worker 模块。

### 5.1 worker 侧：RemotePluginToolProvider（替代本地 import）

新增：

- `RemotePluginToolProvider`（或 `ApiPluginToolProvider`）
  - 实现 `ToolProvider` 接口
  - `listTools()`：从 API/Plugin Host 获取工具定义（含 inputSchema/description）
  - `execute()`：通过 internal route 调用 tool RPC

worker 侧不再：

- import 插件包
- 解析插件 definition

> 说明：该变更是实现“单一权威加载点”的核心。

### 5.2 API 侧：Plugin Host + Channel/Service Runtime

新增建议模块（命名可按项目习惯微调）：

- `ApiPluginHost`：权威加载点
  - import 插件包
  - 校验 definition 与 manifest 一致性
  - 注册 capabilities
  - 提供 tool RPC 执行

- `ChannelRegistry`
  - 注册/管理 channels

- `ServiceRegistry`
  - 启动/停止/状态管理

- `ChannelRuntime`
  - 绑定/权限/幂等/去重
  - inbound buffer
  - 聚合 prompt
  - run 触发

- `ReplyDispatcher`
  - v1 采用 reply job 轮询/派发
  - （本期不做 lastForwardedItemId 水位）

### 5.3 shared 侧：扩展 contracts（channels/services 元信息 + secret hints）

当前 shared 中 `channels/services` 仅 `{name}`，建议扩展为：

- channel manifest item：
  - `name`, `kind`, `runtimeTarget`, `transport`, `supportsDirect`, `supportsGroup`, `replyMode`, `dependencies`
- service manifest item：
  - `name`, `kind`, `runtimeTarget`, `autostart`, `dependencies`

并新增可选字段：

- `secrets` / `uiHints.sensitiveKeys`（用于脱敏策略）

---

## 6. 核心数据模型（DB）

### 6.1 conversation binding（飞书会话 -> session + agent）

表：`channel_conversation_binding`

核心字段建议：

- `plugin_id`（例如 `feishu`）
- `channel_name`（例如 `im`）
- `account_id`（例如 `default`）
- `conversation_key`（建议：`feishu_<accountId>_chat_<chatId>`，避免冒号）
- `chat_id`
- `chat_type`（direct/group）
- `workspace_id`（从绑定的 session 推导并固化）
- `session_id`
- `selected_agent_id`（nullable）
- `group_mode`（optional：paired/multi）
- `watermark_external_message_id`（群聚合水位）
- `updated_at/created_at`

规则：

- 一个 `conversation_key` 只能绑定一个 session
- `/ss` 覆盖 session 时：清空 `selected_agent_id`

### 6.2 inbound buffer（用于群聚合）

表：`channel_inbound_message`

字段建议：

- `plugin_id/channel_name/account_id/conversation_key`
- `external_message_id`（唯一去重键的一部分）
- `sender_id`（open_id）
- `sender_name`
- `mentioned_bot`（boolean）
- `text`
- `created_at_external`
- `created_at_local`

用途：

- 支撑“上次水位后未投递消息”的聚合

### 6.3 reply job（本期使用，水位暂不做）

表：`channel_reply_job`

字段建议：

- `plugin_id/channel_name/account_id/conversation_key`
- `workspace_id/session_id/run_id`
- `status`（pending/sent/failed）
- `error_text`（可选）
- `created_at/updated_at`

用途：

- IM 触发 run 后，后台派发最终 assistant 文本回飞书

> 本次明确不做：`lastForwardedItemId` 回复派发水位。测试出现重复发送问题后再补。

---

## 7. 关键内部接口（建议）

> 以下为建议的内部 service 方法/内部 route。可先 internal-only，不必对 web 暴露。

### 7.0 与现有 internal routes 的一致性说明

本方案新增 internal routes **必须对齐现状约定**：

- 路径统一挂在：`/api/internal/agent/...`
- 鉴权统一使用 header：`x-awb-agent-internal-token`
  - 参考：`apps/api/src/modules/agent/agent.routes.ts#assertInternalToken`
- 调用端（worker/内部服务）统一走 `AgentApiClient.request` 风格：
  - 以 `POST + JSON body` 为主（即便是“查询”）
  - 参考：`apps/agent-worker/src/runtime/apiClient.ts`，例如：
    - `POST /api/internal/agent/plugins/runtime-snapshots`（body 为 `{}`）
    - `POST /api/internal/agent/mcp-settings`（body 为 `{}`）

错误返回风格对齐 `HttpError`：

- API 抛出：`new HttpError(statusCode, message, code?)`（见 `apps/api/src/app/errors.ts`）
- 由 `apps/api/src/app/createApp.ts` 统一转换为：`{ message: string, code?: string }`

---

### 7.1 Tool RPC（单一权威加载点）

> 背景：本方案要求“单一权威加载点”，即 **插件包的 import/校验/执行由 API 侧 Plugin Host 统一负责**。
> worker 不再 import 插件包，而是通过 internal routes RPC 调用插件工具。

#### 7.1.1 `POST /api/internal/agent/plugins/tools/list`

用途：

- worker 获取 plugin tools 的模型可见定义（`description + inputSchema + outputMode + riskLevel`）
- 返回 `updatedAt` 用于 worker 内存缓存（减少每 turn 拉取）

请求（JSON body）：

```json
{
  "toolNames": ["plugin_debug-tools_echo_inspect"],
  "includeAll": false
}
```

约定：

- `toolNames` 可选：若不传，则默认返回所有可用 plugin tools。
- `includeAll` 可选：默认 `false`。
- 建议 worker 传入当前 `ExecutionProfile.agent.pluginTools`（从而只列 agent 允许的工具；payload 更小）。

响应（200）：

```json
{
  "updatedAt": 1710000000000,
  "tools": [
    {
      "toolName": "plugin_debug-tools_echo_inspect",
      "pluginId": "debug-tools",
      "shortName": "echo_inspect",
      "description": "回显输入参数并输出调试摘要",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "message": { "type": "string" }
        }
      },
      "outputMode": "text+raw",
      "riskLevel": "low"
    }
  ]
}
```

字段约束：

- `toolName` 必须为 canonical name（现状规则）：`plugin_<pluginId>_<toolShortName>`
- `inputSchema` 必须为 JSON object（worker 侧可直接用于 `ai` SDK `jsonSchema(...)`）

缓存建议：

- worker 缓存 `{ updatedAt, tools[] }`
- 当 `POST /api/internal/agent/plugins/runtime-snapshots` 的 `updatedAt` 或本接口的 `updatedAt` 变化时刷新

错误约定：

- 401：internal token 无效
- 500：Plugin Host 异常
  - `{ message, code?: "PLUGIN_TOOL_LIST_FAILED" }`

#### 7.1.2 `POST /api/internal/agent/plugins/tools/execute`

用途：

- worker 执行 plugin tool 时，通过该 RPC 由 API Plugin Host 执行并返回 `{ text, raw? }`

请求（JSON body）：

```json
{
  "toolName": "plugin_debug-tools_echo_inspect",
  "args": {
    "message": "hello"
  },
  "ctx": {
    "workspaceId": "w_xxx",
    "sessionId": "sess_xxx",
    "runId": "run_xxx",
    "turnId": "turn_xxx"
  }
}
```

说明：

- `ctx` 为最小执行上下文（用于审计/日志/未来扩展）；`runId/turnId` 可选。
- 在 worker 场景下，建议尽可能传入 `workspaceId/sessionId/runId/turnId` 以便定位问题。

响应（200）：

```json
{
  "text": "tool: plugin_debug-tools_echo_inspect\nstatus: completed\n...",
  "raw": {
    "receivedArgs": { "message": "hello" }
  }
}
```

错误与状态码约定（沿用 `HttpError` 风格，返回 `{ message, code }`）：

- 401：`Unauthorized`
- 404：tool 不存在或 plugin 未 ready
  - `code`：`PLUGIN_TOOL_NOT_FOUND` / `PLUGIN_NOT_READY`
- 409：tool 不允许执行（plugin disabled / tool 不在 agent 允许列表）
  - `code`：`PLUGIN_TOOL_DISABLED`
- 400：参数不合法（args 不符合 schema / 缺少字段）
  - `code`：`PLUGIN_TOOL_ARGS_INVALID`
- 500：执行异常
  - `code`：`PLUGIN_TOOL_EXECUTION_FAILED`

> worker 侧应将上述错误归一化为 tool item 的失败输出（文本化），与现有工具一致。

---

### 7.2 `/st` 状态摘要（聚合）

目标：

- IM 插件不复制 web 的分散计算逻辑
- 由 API 提供一个“可直接渲染为 `/st` 文本”的状态摘要数据源
- running 冲突时也复用同一份摘要数据

#### 7.2.1 推荐 endpoint：`POST /api/internal/agent/sessions/status-summary`

请求（JSON body）：

```json
{
  "sessionId": "sess_00mm...",
  "agentId": "coding-main"
}
```

说明：

- `agentId` 可选：
  - 若 IM conversation 已选定 agent，则传入
  - 若未选 agent，则可不传（此时 `contextWindowTokens/contextTokenRatio` 可为 null）

响应（200）：

```json
{
  "updatedAt": 1710000000000,
  "session": {
    "id": "sess_00mm...",
    "workspaceId": "w_xxx",
    "title": "飞书测试会话",
    "kind": "primary",
    "updatedAt": 1710000000000
  },
  "agent": {
    "id": "coding-main",
    "name": "Coding Main"
  },
  "runState": {
    "sessionId": "sess_00mm...",
    "status": "running",
    "activeRunId": "run_xxx",
    "activeAssistantItemId": 123,
    "lastResponseTotalTokens": 18240,
    "terminalStatus": null,
    "runNoticeText": "...",
    "updatedAt": 1710000000000
  },
  "startedAt": 1710000000000,
  "elapsedMs": 42000,
  "contextWindowTokens": 128000,
  "contextTokenRatio": 0.143
}
```

字段来源建议：

- `runState`：复用现有 `AgentService.getRunState`（`/api/agent/sessions/:sessionId/run-state` 的内部实现）
- `startedAt/elapsedMs`：建议通过 `agent_run.created_at`（activeRunId 对应记录）计算，避免 web 侧估算漂移
- `contextWindowTokens`：建议复用 execution profile 解析逻辑得到（模型配置）
- `agent`：推荐复用现有设置接口 `GET /api/settings/agent/agents`（`AgentSettingsView`）的同源数据，并沿用 web 端过滤规则（`scope === "user" || scope === "both"`）
- `contextTokenRatio`：`lastResponseTotalTokens / contextWindowTokens`（任一缺失则为 null）

错误约定：

- 401：internal token 无效
- 404：session 不存在
  - `code`：`SESSION_NOT_FOUND`
- 500：聚合失败
  - `code`：`SESSION_STATUS_SUMMARY_FAILED`

---

### 7.3 inbound ingest / group aggregate / run trigger（ChannelRuntime 内部方法）

> v1 推荐这些能力下沉到宿主 `ChannelRuntime`，以保证多 IM 渠道实现一致。未来如需拆进子进程或跨进程，可再 HTTP 化为 `/api/internal/agent/channels/...`。

#### 7.3.1 `ingestInboundMessage`

```ts
type IngestInboundMessageInput = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  chatType: "direct" | "group";
  chatId: string;
  externalMessageId: string;
  createdAtExternalMs?: number;
  sender: { id: string; displayName?: string };
  mentionedBot?: boolean;
  text: string;
};

type IngestInboundMessageResult =
  | { ok: true; deduplicated: boolean }
  | { ok: false; errorCode: "NOT_ALLOWED" | "PAYLOAD_INVALID"; message: string };

function ingestInboundMessage(input: IngestInboundMessageInput): Promise<IngestInboundMessageResult>;
```

规则：

- allowlist 校验（4.5）
- external_message_id 去重（4.6）
- 写入 `channel_inbound_message`

#### 7.3.2 `buildAggregatedUserPrompt`

```ts
type BuildAggregatedUserPromptInput = {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  upperBoundExternalMessageId: string;
  maxMessages: number;
  maxChars: number;
};

type BuildAggregatedUserPromptResult = {
  text: string;
  consumedExternalMessageId: string;
};

function buildAggregatedUserPrompt(input: BuildAggregatedUserPromptInput): Promise<BuildAggregatedUserPromptResult>;
```

规则：

- 从 `channel_conversation_binding.watermark_external_message_id`（若为空则从最早）开始聚合
- 只聚合到 `upperBoundExternalMessageId`（通常为本次 @ 触发消息）
- 限制 `maxMessages/maxChars`
  - 执行前默认推荐：`maxMessages = 50`，`maxChars = 8000`
  - 超过 `maxMessages`：优先丢弃更早的消息
  - 若在满足 `maxMessages` 后仍超过 `maxChars`：对最早保留消息进行尾部截断
  - 发生丢弃/截断时：在顶部加入提示行 `（提示：已省略更早的群消息，或部分内容已截断）`
- 每条消息格式：`senderName: text`
- 用分隔符隔开（单独一行 `---`）

#### 7.3.3 `advanceWatermark`

```ts
function advanceWatermark(input: {
  pluginId: string;
  channelName: string;
  accountId: string;
  conversationKey: string;
  watermarkExternalMessageId: string;
}): Promise<void>;
```

规则：

- 仅在成功触发 run（并创建 reply job）后推进 watermark
- 推进到本次聚合上界（通常为触发 message_id）

#### 7.3.4 `tryAppendUserMessageAndStartRun`

```ts
type TryAppendUserMessageAndStartRunInput = {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  text: string;
  clientRequestId: string;
};

type TryAppendUserMessageAndStartRunResult =
  | { ok: true; runId: string }
  | { ok: false; errorCode: "SESSION_RUNNING" | "SESSION_NOT_FOUND" | "AGENT_NOT_SELECTED"; message: string };

function tryAppendUserMessageAndStartRun(input: TryAppendUserMessageAndStartRunInput): Promise<TryAppendUserMessageAndStartRunResult>;
```

规则：

- 必须沿用 `AgentService.sendMessage` 的冲突与 dedup 语义：
  - running 时拒绝（409 类语义）
  - `clientRequestId` 用于幂等
- 成功后由宿主 enqueue worker

> 说明：IM 触发 run 时建议使用稳定的 `clientRequestId = im_<plugin>_<conversationKey>_<externalMessageId>`。

---

## 8. 飞书端到端流程

### 8.1 命令流程：/ss

#### /ss（无参）

1) 校验 sender 是否在 allowlist
2) 查询所有 workspace 下最近更新的 10 个 session（按 updated_at desc）
3) 返回：`index + title + sessionId + workspace 标识`
   - workspace 标识默认格式（同 2.2）：
     - `workspace.title`（为空则回退 `workspace.dirName`）
     - 并附加 `workspaceId`

#### /ss <sessionId|index>

1) 校验 allowlist
2) 解析 sessionId（若为 index，则从最近列表映射）
3) 校验 session 存在，取 workspaceId/title
4) 更新 conversation binding：
   - 若 sessionId 变化：更新 sessionId/workspaceId，并清空 selectedAgentId
5) 回复：绑定成功 + 提示 `/a`

### 8.2 命令流程：/a

#### /a（无参）

1) 校验 allowlist
2) 若未绑定 session：提示先 `/ss`
3) 从绑定的 workspaceId 取得可选 agent 列表
   - agent 列表来源与排序（执行前默认推荐，保持与 web 一致）：
     - 数据来源：复用 `GET /api/settings/agent/agents`（`AgentSettingsView`）
     - 过滤规则：仅允许 `scope` 为 `user` 或 `both`
     - 排序规则：先按 `order` 升序，再按 `name` 升序
4) 返回：`index + agentId + agentName` + 当前已选 agent（若有）

#### /a <agentId|index>

1) 校验 allowlist
2) 校验已绑定 session
3) 校验 agent 在该 workspace 可用
4) 保存 selectedAgentId
5) 回复：选择成功

### 8.3 命令流程：/st

1) 校验 allowlist
2) 若未绑定 session：提示先 `/ss`
3) 调用 `getSessionStatusSummary(sessionId, selectedAgentId?)`
4) 返回汇总状态文本

### 8.4 普通消息流程（私聊/群聊）

1) 写入 inbound buffer：`ingestInboundMessage`
2) 若为命令：走命令逻辑
3) 若为普通消息：
   - 校验 allowlist
   - 校验已绑定 session
   - 校验已选 agent
   - 校验群聊触发规则（@ 或 paired-group 优化）
4) 若 session running：
   - 不创建 run
   - 返回 `/st` 同类摘要
5) 若 session idle：
   - 生成 `clientRequestId = im_<plugin>_<conversationKey>_<externalMessageId>`
   - 构造 user text：
     - 私聊：直接使用该消息
     - 多人群 @：调用 `buildAggregatedUserPrompt`
   - 调用 `tryAppendUserMessageAndStartRun`
   - 创建 reply job
   - （多人群 @ 且 run 成功触发后）推进 watermark

### 8.5 群聚合流程（多人群 @ 触发）

1) 每条 inbound 消息都先 ingest 并持久化
2) 当检测到“多人群 + @机器人 + 普通消息触发”时：
   - 以当前触发 message_id 作为聚合上界
   - 从 watermark 后收集到该 message_id 的消息，构造聚合文本
3) 将聚合文本作为单条 user message 投递给模型

> v1 不依赖拉取飞书历史消息 API；仅聚合“机器人已接收到并写入 buffer 的消息”。后续如需补齐离线历史，可在 service 层引入 history fetch 作为增强。

---

## 9. 安全与治理

### 9.1 目录/manifest/entry 安全复用现有

复用现有插件治理：

- 插件根目录：`<dataDir>/plugins`（见 `apps/api/src/infra/fs/paths.ts#pluginsRoot`）
- manifest 文件：`agent-workbench.plugin.json`
- entry 路径必须在插件根目录内（含 realpath 防软链逃逸）
- entry 扩展名限制：`.js/.mjs/.cjs`

### 9.2 secret 脱敏

- `appSecret` 必须：
  - settings/runtime snapshot 输出脱敏
  - 更新时留空不改

### 9.3 allowlist

- `/ss`、`/a`、普通消息触发、`/st` 均校验 allowlist

### 9.4 日志与审计（建议）

- 记录 inbound/outbound 基本事件（不记录 secret）
- 对拒绝原因（未绑定/未选 agent/running/无权限）做结构化日志

---

## 10. 本次明确不做

- 回复派发水位：`lastForwardedItemId`（测试发现重复发送再补）
- artifact 通用协议（本次不做）

---

## 11. 分阶段落地计划（可回滚、可验证）

> 目标：先跑通飞书 IM MVP，再逐步增强；每阶段都有可验证点并可回滚。

### Phase 0：梳理与契约扩展（shared）

- 扩展 shared plugin contracts：
  - channels/services manifest item 增强
  - secrets/uiHints 支持
  - runtime snapshot 增强（channels/services 状态）
- 验证：类型检查 + API 插件治理测试通过

回滚点：不影响现有 tools 插件链路；新字段均 optional。

### Phase 1：Plugin Host（单一权威加载点）

- 引入 Plugin Host（API 或其子进程）
- worker 增加 RemotePluginToolProvider，通过 tool RPC 调用
- 验证：现有本地工具插件仍可用（与当前行为一致）

回滚点：保留旧的 LocalPluginToolProvider 路径作为 fallback。

### Phase 2：/st 状态摘要聚合

- 新增 API 内部聚合方法/接口：`getSessionStatusSummary`
- 验证：web 与 IM 输出关键字段一致

回滚点：IM 临时降级为 run-state 原始输出（不建议长期）。

### Phase 3：ChannelRuntime + 数据模型

- 增加 DB 表：conversation binding / inbound buffer / reply job
- ChannelRuntime 实现：
  - allowlist
  - dedupe
  - bind session + choose agent
  - build aggregate prompt
  - tryAppendUserMessageAndStartRun

验证：
- `/ss` 列表正确（跨 workspace）
- `/ss` 绑定行为正确（切换 session 清空 agent）
- `/a` 列 agent/选择 agent 正常
- running 冲突正确拒绝

### Phase 4：飞书 IM 插件（channels + services）

- service：飞书 websocket gateway
- channel：命令解析 + 普通消息处理 + reply job 派发

验证：
- 私聊收发
- 群聊收发（默认需要 @）
- 多人群 @ 聚合

### Phase 5（v1.5）：双人群免 @ 优化

- 增加群成员数判断策略（缓存/查询）
- paired-group 可配置

---

## 12. 与现有 tools 插件体系的兼容点/差异点（简述）

### 兼容点

- 复用插件治理：目录扫描、manifest/config 校验、diagnostics、enable/disable
- 复用插件 contracts：`capabilities` 机制不变
- 复用 ToolRegistry 的 provider 抽象：仅替换 plugin tool provider 的实现方式（本地执行 -> RPC 执行）

### 差异点

- tools：仍遵循 `text` 必填、`raw` 可选，模型只消费 text
- channels/services：不受 tool 输出契约约束，运行在宿主（API/Plugin Host）侧
- IM 的核心逻辑（绑定/权限/去重/聚合/触发 run）下沉到宿主 `ChannelRuntime`，插件仅负责渠道适配与事件接入
