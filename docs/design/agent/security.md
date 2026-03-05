# 安全与边界

本设计的安全边界围绕 workspace 展开。

## 路径边界

- 所有文件读写必须限制在 workspace 根目录内
- artifacts 与 history 位于 workspace/.agent-workbench/ 下

规则:

- 拒绝绝对路径或包含 .. 的路径参数
- 解析为 realpath 后再次校验必须在 workspace 内

## 权限模型

- 所有高风险操作必须 ask
- v1 权限粒度建议:
  - read
  - edit(write)
  - bash

后续可扩展:

- apply_patch
- mcp_tool

permission 决策作为事件进入 EventStore:

- permission.asked
- permission.resolved

## 外部目录

- bash 可能访问 workspace 外路径
- v1 建议:
  - 默认禁止 workspace 外路径
  - 若允许,必须通过 permission.ask 明确授权

## 截断与 artifact

- 所有非 assistant 的大文本写入 artifact 文件
- artifactPath 直接暴露给 read,因此必须:
  - artifactPath 必须位于 workspace/.agent-workbench/internal/artifacts
  - read 工具必须校验路径边界

## 取消协作

- Executor 必须支持 AbortSignal
- bash 子进程必须在 abort 时 kill
- 长循环工具必须周期性检查 abort

## 多客户端并发

- append 事件必须带 prevId
- 并发写冲突必须通过重试解决
- 防止不同 client 在同一 session 上写出分叉,headEventId 必须唯一

## Provider 凭据策略(本次迭代)

- 本次迭代允许在 settings 中明文保存 provider `apiKey`(个人项目阶段)
- 对外 settings 接口必须脱敏返回
  - 返回 `hasApiKey` 与 `apiKeyMasked`
  - 不返回明文 `apiKey`
- internal 接口可返回明文 `apiKey`,仅允许 Worker 通过内部 token 调用

后续演进:

- 多用户场景切换到统一密钥托管与加密存储
