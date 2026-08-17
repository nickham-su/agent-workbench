# Local Tool Plugins v1

Status: draft

## 背景

当前 `agent-workbench` 的工具体系主要由以下几部分组成:

- shared 层定义工具名与 settings/schema 契约
- API 负责为模型组装工具定义与 prompt context
- worker 负责把工具注册给模型并执行工具
- 少数工具还额外带有 prompt projector、结构化持久化、UI 富展示逻辑

现状的问题是:

- 新增一个内置工具通常需要同时修改 shared / API / worker 多处
- 工具定义与工具执行分散在不同进程中,存在事实来源分裂的问题
- 当前只有 MCP 具备较完整的动态接入能力,本地 JS/TS 插件包没有正式机制
- 未来除了扩展更多工具,还需要对接 IM,插件系统不能把后续的 channels/hooks/services 能力堵死

因此需要一套正式的本地插件方案,先解决工具插件,同时为后续 channel/hook/service 能力预留架构空间。

## 目标

- 支持在本地运行目录下通过 JS/TS 插件包动态加入工具
- 通过强治理方式管理插件发现、启用、配置、诊断与兼容性
- 统一工具定义与执行链路,降低新增工具的改造面
- 保持现有 builtin tools 与 MCP tools 可并存,最终纳入统一的工具注册中心
- 保证模型侧消费仍以文本为主,避免把插件工具的结构化数据直接塞进 prompt
- v1 只实现 tools,但插件模型本身必须兼容未来的 channels/hooks/services

## 非目标

v1 不做以下内容:

- 远程插件仓库
- 自动安装 npm 依赖
- 热重载
- UI 插件
- 通用 hook 落地
- 后台 service 落地
- channel/IM capability 落地
- artifact 通用协议
- 不受信任代码的沙箱/容器隔离

说明:

- 以上能力不是长期否定,而是本期不实现。
- 设计层必须允许后续补上 channels/hooks/services,避免推翻 v1 工具插件底座。

## 总体原则

### 强治理

- 插件发现不等于启用
- manifest 必填
- 配置必须通过 schema 校验
- 插件与工具命名必须稳定、可追踪、可冲突检测
- manifest 与运行时导出必须做一致性校验
- 所有插件都要有 diagnostics 与明确状态

### worker 为工具事实来源

- API 不执行插件代码
- worker 加载插件代码并产出最终可执行工具集合
- prompt 中实际使用的工具定义以 worker 侧 registry 快照为准

### 模型只消费文本

- 插件工具必须输出 `text`
- 插件工具可以可选输出 `raw`
- prompt 回灌只使用 `text`
- `raw` 仅作为宿主内部可选结构化结果,不默认进 prompt,也不默认落库

### 先统一内置工具,再引入外部插件

- v1 的第一步是把 builtin / MCP / local plugin 都纳入统一的 `ToolRegistry`
- 插件包只是新的工具来源,不应该复制一套独立调度逻辑

## 总体架构与职责分层

## Shared

职责:

- 定义插件 manifest 契约
- 定义 settings / runtime snapshot / diagnostics 等共享 schema
- 定义 canonical tool name 规范
- 定义 plugin-sdk 面向插件作者的稳定类型边界

建议新增/承载内容:

- `PluginManifest`
- `PluginRuntimeSnapshot`
- `PluginDiagnostics`
- `AgentPluginSettings`
- `plugin_<pluginId>_<toolName>` 命名规则

## API

职责:

- 扫描插件目录
- 读取并校验 manifest
- 管理全局插件启用状态与插件配置
- 提供 diagnostics 与运行时快照查询
- 供 web 展示插件状态与配置
- 向 worker 下发插件运行时快照

不负责:

- 不执行插件入口代码
- 不直接决定插件真实导出的工具集合

## Worker

职责:

- 根据 API 下发的插件快照加载启用插件
- 执行 manifest/runtime 一致性校验
- 通过 `PluginRuntimeManager` 创建插件运行时实例
- 把插件工具注册到 `ToolRegistry`
- 统一执行 builtin / MCP / plugin tools
- 负责模型可见工具快照、执行分发、错误归一化、文本化输出

## Web

职责:

- 展示插件列表、状态、diagnostics、配置表单
- 管理全局 enable/disable
- 为 agent 选择启用哪些插件工具
- 展示插件工具来源与 canonical name

说明:

- v1 的 web 只需要管理与展示,不需要理解插件代码细节。
- 插件工具 UI 默认按普通 tool card 展示文本输出即可。

## 运行目录与插件目录约定

固定目录:

```text
<runtimeRoot>/plugins/
```

示例:

```text
./plugins/debug-tools/
./plugins/acme-jira/
```

说明:

- `runtimeRoot` 指 agent-workbench 运行根目录
- API 与 worker 必须共享同一 `runtimeRoot` 认知
- v1 不支持 workspace 级独立插件目录,也不引入 `.awb/plugins/` 层级

建议的插件包结构:

```text
plugins/<plugin-id>/
  package.json
  agent-workbench.plugin.json
  dist/index.js
  src/index.ts
```

说明:

- 正式支持 `.js/.mjs/.cjs` 入口
- `.ts` 入口仅作为开发友好支持,不作为生产运行保证
- 官方文档应建议插件先构建为 JS 后再使用

## 插件发现与启用模型

### 发现

API 启动或刷新时扫描:

```text
<runtimeRoot>/plugins/*
```

发现规则:

- 每个子目录若存在 `agent-workbench.plugin.json`,则视为候选插件
- 仅支持目录型插件包,不支持散落的单文件脚本

### 启用

一个插件最终可用,必须同时满足:

1. 目录被发现
2. manifest 校验通过
3. 插件全局 `enabled=true`
4. 插件配置通过 `configSchema` 校验
5. worker 成功加载插件入口
6. 运行时导出的插件定义与 manifest 一致
7. 当前 agent 在 `pluginTools` 中启用了目标工具

### 启用粒度

- 全局: 按插件启用
- agent: 按工具启用

理由:

- 全局 enable/disable 适合治理、安全与兼容控制
- agent 按工具启用适合精细化能力配置

## 强治理策略

## manifest

每个插件必须携带 manifest:

```text
agent-workbench.plugin.json
```

manifest 用于:

- 在不执行代码的前提下发现插件
- 展示插件元信息
- 校验配置 schema
- 进行版本兼容与能力声明检查
- 提供运行时导出的一致性基线

## enable / disable

- 插件被发现后默认可为 `disabled`
- worker 只加载已启用插件
- 禁用插件后,新 run 不应再暴露其工具

## config schema

- 插件全局配置以插件为单位存储
- 配置写入前必须通过 manifest 中声明的 `configSchema` 校验
- v1 不做 per-agent plugin config

## diagnostics

建议为每个插件维护稳定状态与诊断信息:

- `discovered`
- `disabled`
- `invalid_manifest`
- `incompatible`
- `config_invalid`
- `load_failed`
- `manifest_mismatch`
- `ready`

diagnostics 至少应包含:

- code
- severity
- message
- source(`discovery` / `manifest` / `config` / `runtime`)
- 可选 details

## manifest/runtime 一致性

v1 建议强校验:

- runtime `meta.id` 必须等于 manifest `id`
- runtime `meta.version` 必须等于 manifest `version`
- runtime 导出的工具集合必须是 manifest `tools[]` 的子集
- runtime 不允许注册 manifest 未声明工具
- manifest 声明但 runtime 未导出的工具允许存在,但应产生 warning

## 插件能力模型

v1 仅实现 `tools`,但插件模型本身必须是能力容器,而不是仅仅“工具数组”。

建议的能力集合:

- `tools`
- `channels`
- `hooks`
- `services`

v1 行为:

- `tools`: 实现
- `channels`: 预留类型与 manifest 字段,不落地执行
- `hooks`: 预留类型与 manifest 字段,不落地执行
- `services`: 预留类型与 manifest 字段,不落地执行

原因:

- 后续对接 IM 应走 `channel capability`,而不是工具插件
- 短期内也可能需要 hook 与后台服务,当前底座不能把后路堵死

## 为什么 IM 未来应走 channel capability

IM 对接的核心问题不是“模型多了一个工具”,而是:

- 如何接收入站消息
- 如何做 webhook 或 websocket 连接
- 如何把外部消息映射到 agent session
- 如何把 agent 回复重新发送回平台
- 如何维护账号、路由、连接状态与重连逻辑

这些能力明显超出 tool execute 的边界,更适合建模为 `channel capability`。

因此:

- 工具插件解决“agent 能做什么”
- channel 插件解决“谁能和 agent 对话,以及 agent 如何回复”

v1 不实现 channels,但插件系统必须允许未来自然加入 `ChannelRegistry`、HTTP route 注册和后台服务生命周期。

## 工具输出契约

插件工具输出采用 MCP 风格:

- `text`: 必填
- `raw`: 可选

约束:

- `text` 是面向模型与人类阅读的主要输出
- prompt 仅消费 `text`
- `raw` 必须是 JSON-serializable 数据
- `raw` 默认不进入 prompt
- `raw` 默认不落库
- 工具失败时允许抛异常,由宿主统一转成失败状态与错误文本

设计理由:

- 与当前 `agent-workbench` 工具输出主链路一致: 模型消费文本
- 允许未来在少数场景下保留结构化结果给 UI/调试/服务端逻辑使用
- 避免把结构化 payload 直接暴露给 prompt,造成 token 浪费与隐私/膨胀问题

说明:

- v1 不定义插件 artifact 协议
- 若插件输出文本很大,可复用宿主现有文本截断策略,但不扩展新的插件专属 artifact 契约

## canonical name

插件工具统一使用 canonical name:

```text
plugin_<pluginId>_<toolName>
```

示例:

```text
plugin_debug-tools_echo_inspect
plugin_acme-jira_search_issues
```

原因:

- 避免与 builtin / MCP tool 冲突
- 便于审计、追踪与 UI 分类展示
- 便于做 agent 级精细启用与 diagnostics

## v1 范围

v1 明确包含:

- 本地目录型插件包
- manifest 发现与 schema 校验
- 全局 enable/disable
- 插件全局配置
- agent 按工具启用插件工具
- worker 加载插件代码
- 插件工具注册与执行
- `text` 必填 / `raw` 可选 输出链路
- diagnostics 与 runtime snapshot
- JS 入口正式支持

v1 明确不做:

- artifact 协议
- channel capability 落地
- hook capability 落地
- service capability 落地
- 热重载
- 插件仓库/安装器
- 不受信任插件隔离

## 样板插件

建议使用如下样板插件验证 v1 全链路:

- 插件 ID: `debug-tools`
- 工具名: `plugin_debug-tools_echo_inspect`

用途:

- 验证插件目录扫描
- 验证 manifest 校验
- 验证 enable/disable
- 验证 agent 级工具启用
- 验证 worker 加载与 runtime 一致性检查
- 验证工具执行、文本回灌、raw 处理与异常处理

推荐行为:

- 输入简单 JSON 参数
- 输出稳定、可读的 `text`
- 可选输出可序列化的 `raw`
- 可通过测试参数触发异常分支与长文本分支

## 推荐迁移路径

### Phase 1: ToolRegistry 中心化

目标:

- 将 builtin / MCP / plugin tools 纳入统一 registry
- 摘除 `runner.ts` 中硬编码的工具执行分发

建议动作:

- 引入 `ToolRegistry`
- 将现有 builtin 工具封装为 `BuiltinToolProvider`
- 将 MCP 封装为 `McpToolProvider`

### Phase 2: API 插件治理层

目标:

- 完成插件目录扫描、manifest 校验、插件配置与 diagnostics 管理

建议动作:

- 新增 `plugins` 模块
- 提供插件列表与 runtime snapshot 内部接口
- 为 web 提供管理视图所需的控制/查询接口

### Phase 3: worker 插件运行时

目标:

- 引入 `PluginRuntimeManager`
- 支持加载本地插件并把工具注册进 `ToolRegistry`

建议动作:

- 先仅支持 tools capability
- 保持 plugin runtime 与 tool registry 解耦,为未来 channels/hooks/services 预留空间

### Phase 4: 样板插件与回归测试

目标:

- 用 `debug-tools / echo_inspect` 打通全链路
- 验证 builtin/MCP 不回归

## 测试建议

### 单元测试

建议覆盖:

- 插件目录扫描
- manifest schema 校验
- `entry` 路径安全校验
- canonical name 生成
- 配置 schema 校验
- manifest/runtime 一致性检查
- raw JSON-serializable 校验
- diagnostics 归类

### 集成测试

建议覆盖:

1. 插件被发现但未启用
2. 插件启用后出现在插件列表中
3. agent 未启用该工具时模型不可见
4. agent 启用该工具后 worker 能加载并执行
5. 插件返回 `text` 时 prompt 链路正常
6. 插件返回 `raw` 时默认不进 prompt、不落库
7. 插件抛异常时 tool item 正确失败并记录错误文本
8. manifest 与 runtime 不一致时插件进入 `manifest_mismatch`

### 回归测试

必须确保:

- builtin tools 行为不变
- MCP tools 行为不变
- pending tool 执行恢复逻辑不被破坏
- 现有 tool result text 主链路不回归

## 与现有实现的衔接建议

结合当前仓库结构,建议后续按以下方向演进:

- shared: 新增插件相关 contracts,并扩展 agent settings 支持 `pluginTools`
- API: 新增 `plugins` 模块,负责扫描、配置、diagnostics 与 runtime snapshot
- worker: 新增 `PluginRuntimeManager` 与 `LocalPluginToolProvider`,并将 `runner.ts` 的硬编码执行分发收敛到 `ToolRegistry`
- web: 增加插件管理页与 agent 工具选择入口

## 总结

本方案的核心是:

- 用强治理方式引入本地 JS/TS 插件包
- 以 `ToolRegistry` 为统一工具事实来源
- 让插件工具输出遵循 `text` 必填、`raw` 可选 的契约
- v1 只实现 tools,但在模型、manifest、runtime 和诊断层面保留 channels/hooks/services 的演进空间

这使得 agent-workbench 可以先稳定完成工具插件化,同时不阻断后续 IM/channel 能力的自然扩展。
