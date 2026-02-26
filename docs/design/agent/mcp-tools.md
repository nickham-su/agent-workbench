# MCP tools

本期仅接入 MCP tools:

- listTools
- callTool

不做:

- resources
- prompts

## 目标

- 将 MCP tool 统一适配为 ToolRegistry 的 Tool
- 命名稳定且可避免冲突
- 具备基础的连接管理与刷新

## 配置

建议以 workspace 级配置为主。

- 配置位置建议
  - workspace/.agent-workbench/mcp.json
  - 或 AWB 后端 DB 保存(仍可投影为文件)

配置字段建议:

- serverName
- type
  - stdio
  - http
- command/args/env(针对 stdio)
- url/headers/oauth(针对 http)
- enabled
- timeout

## 连接管理

- Worker 维护 McpManager
  - 启动时读取配置并尝试连接
  - 连接状态写入投影,供 UI 展示
  - 断线重连与错误退避

## 工具发现与注册

- 对每个已连接 server:
  - listTools
  - 将每个 MCP tool 转换为 ToolDefinition

命名规则建议:

- mcp_<serverName>_<toolName>
  - serverName/toolName 做 sanitize,只保留 [a-zA-Z0-9_-]

说明:

- 命名规则与 opencode 接近

## MCP Tool 执行

- ToolExecutor 识别 toolName 前缀 mcp_
- 路由到对应的 MCP client
- 执行 callTool
- 将结果转换为 ToolResult:
  - output 统一为 TextPayload
  - 若结果过大则写 artifact

注意:

- MCP 返回内容可能是结构化片段列表
- v1 可先将其串联为纯文本输出
- 后续可在 metadata 中保留结构化数据供 UI 使用

## 权限

建议最小策略:

- permissionKey: "mcp_tool"
- pattern:
  - <serverName>:<toolName>

说明:

- v1 不做更细粒度权限拆分
- 后续可扩展为 per-tool permissionKey

## 刷新策略

- 启动时刷新
- 接收 MCP tools changed 通知时刷新(若协议支持)
- 提供手动刷新 API

## 与事件循环的关系

- MCP tools 与内置工具在调度器眼里没有区别
  - 由 model.turn.committed 产生 toolRequests
  - Scheduler 执行并产出 tool.* 事件
