# Provider 与 Agent 设计

本文档定义本次迭代的 Provider/Agent 方案,目标是支撑:

- 全局可配置的 Provider 列表与模型列表
- 全局可配置的 Agent 列表
- 消息级别选择 agent,并在 run 固化解析结果
- Worker 按 run 拉取解析后的执行配置(ExecutionProfile)

## 设计目标

- Provider 与 Agent 解耦
  - Provider 负责模型渠道与模型参数
  - Agent 负责角色提示词、工具集合、权限策略
- API 负责解析,Worker 负责执行
  - Worker 不处理复杂合并规则
  - Worker 每次 run 拉取 ExecutionProfile
- secrets 边界清晰
  - 对外 settings 接口返回脱敏 apiKey
  - 仅 internal 接口返回明文 apiKey

## Settings 结构

本次迭代建议新增两个 settings key:

- `agent_providers_v1`
- `agent_agents_v1`

## agent_providers_v1

- `default`
  - `providerId`
  - `modelId`
- `providers`: 列表
  - `id`
  - `name`
  - `npm`
    - 本次迭代固定 `@ai-sdk/openai`
  - `options`
    - `baseURL`: 必填,是否包含 `/v1` 由用户负责
    - `apiKey`: 明文存储于 settings(个人项目阶段)
  - `models`: 列表
    - `id`
    - `name`
    - `options`
      - 可选字段: `reasoningEffort` `textVerbosity` `reasoningSummary` `include` `maxOutputTokens`

约束:

- `providers[].id` 全局唯一
- 每个 provider 下 `models[].id` 唯一
- 不做 gpt-5 前缀校验
- 若 `maxOutputTokens` 未设置,运行时必须忽略该参数(不写默认值)

## agent_agents_v1

- `default`
  - `agentId`
- `agents`: 列表
  - `id`
  - `name`
  - `prompt`
  - `tools`
    - 本次迭代工具范围: `bash` `read` `write`
  - `permissions`
    - 工具/路径权限策略
  - `defaultModel` 可选
    - `providerId`
    - `modelId`

说明:

- `defaultModel` 允许为空
- 为空时沿用 `agent_providers_v1.default`

## Provider 解析规则

给定一次 run,API 按以下顺序解析执行配置:

- 先确定 `agentId`
  - 优先使用消息请求显式传入的 `agentId`
  - 否则使用 `agent_agents_v1.default.agentId`
- 再确定模型
  - 若该 agent 配置了 `defaultModel`,优先使用
  - 否则使用 `agent_providers_v1.default`
- 最终生成 `ExecutionProfile`
  - `agent`
  - `provider`
  - `model`

解析失败策略:

- 任一关键引用不存在(agent/provider/model),run 直接失败并返回配置错误

## 消息与 run 的固化策略

消息请求支持可选字段:

- `agentId`

API 在创建 run 时,必须将解析结果固化到 `run.created` payload:

- `agentId`
- `providerId`
- `modelId`

作用:

- 保证重放一致性
- 便于定位运行时到底使用了哪套配置

## Internal ExecutionProfile 接口

Worker 每次 run 开始前调用 internal 接口拉取解析结果。

- 路由建议: `POST /api/internal/agent/execution-profile`
- 鉴权: `x-awb-agent-internal-token`
- 请求体
  - `workspaceId`
  - `sessionId`
  - `runId`
- 返回
  - `agent`
    - `id` `name` `prompt` `tools` `permissions`
  - `provider`
    - `id` `npm` `options.baseURL` `options.apiKey`
  - `model`
    - `id` `options`

说明:

- internal 返回明文 apiKey
- 对外 settings 接口不返回明文 apiKey

## 对外 Settings 接口

建议新增:

- `GET /api/settings/agent/providers`
- `PUT /api/settings/agent/providers`
- `GET /api/settings/agent/agents`
- `PUT /api/settings/agent/agents`

apiKey 脱敏展示规则:

- 返回 `hasApiKey`
- 返回 `apiKeyMasked`
- 不返回明文 `apiKey`

更新语义:

- `apiKey` 未传: 保持原值
- `apiKey` 传空字符串或 null: 清空
- `apiKey` 传非空字符串: 覆盖

## Provider Adapter 约定

本次仅实现 `@ai-sdk/openai`。

- SDK: `createOpenAI({ apiKey, baseURL })`
- 模型获取: `sdk.responses(modelId)`
  - 强制走 OpenAI `/v1/responses`

后续扩展方式:

- 增加 npm -> adapter 注册表
- 新增渠道只需补 adapter,无需修改 run 主循环

## 与 subtask 的关系

当后续启用 subtask 工具时:

- subtask 可显式传 `agentId`
- 未显式传入时继承父 run 的 `agentId`
- 子 run 继续按本文解析规则确定 provider/model
