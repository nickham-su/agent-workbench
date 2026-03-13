# Local Tool Plugin Implementation Checklist v1

Status: draft

本文是本地工具插件方案的《实施清单版》。

相关背景文档：

- `docs/design/agent/plugin/local-tool-plugins-v1.md`
- `docs/design/agent/plugin/local-tool-plugin-interfaces-v1.md`

本文不重复完整方案，而是面向开发实施，按阶段拆解目标、文件、关键点、验证方式、风险与回滚点。

---

## 1. 实施前确认项

在开始编码前，先固定以下实现级约束，避免后续返工。

### 1.1 根目录约定

明确：

- `runtimeRoot = dataDir`
- `pluginRoot = <dataDir>/plugins`

理由：

- 当前项目中最稳定、最统一的运行数据根是 `dataDir`
  - `apps/api/src/config/env.ts:loadEnv()` 统一解析 `AWB_DATA_DIR`
  - `apps/api/src/infra/fs/paths.ts` 已将 DB、tmp、archive、worker socket/pid 等运行文件统一挂在 `dataDir` 下
- `repoRoot` 当前更偏向“源码仓库根”，不适合作为插件运行目录
- `workspaceRoot` 是单个 workspace 的边界，不适合作为全局插件目录

建议新增路径 helper：

- API 侧：`apps/api/src/infra/fs/paths.ts`
  - `pluginsRoot(dataDir)`
  - `pluginRoot(dataDir, pluginId)`（可选）

### 1.2 路径计算责任

明确：

- API 统一计算插件目录、扫描结果、插件绝对路径与 entry 绝对路径
- worker 不自行基于 `process.cwd()`、`repoRoot` 或环境变量二次推导插件根目录
- worker 仅消费 API 下发的插件 runtime snapshot

理由：

- 避免 API/worker 路径认知不一致
- 符合“API 负责治理，worker 负责运行”的边界

### 1.3 第一阶段入口策略

第一阶段只支持：

- `.js`
- `.mjs`
- `.cjs`

不实现：

- `.ts` 入口直接加载

说明：

- 文档层保留“TS 开发友好支持”的长期方向
- 实现第一阶段先只支持 JS，有利于尽快跑通 `debug-tools / echo_inspect`
- 后续如有需要，再增加开发模式下的 TS loader 支持

### 1.4 第一阶段范围收口

开始实现前再次确认：

- 只做本地工具插件
- 不做 artifact 协议
- 不做 channel capability 落地
- 不做 hook / service capability 落地
- 不做热重载
- 不做插件仓库或安装器
- `text` 必填，`raw` 可选；prompt 只消费 `text`

---

## 2. 分阶段实施顺序总览

建议实施顺序：

1. Phase 1：`ToolRegistry` 中心化
2. Phase 2：shared contracts / settings 扩展
3. Phase 3：API 插件治理层
4. Phase 4：worker 插件运行时与本地插件加载
5. Phase 5：样板插件 `debug-tools / echo_inspect`
6. Phase 6：web / 管理与最小可见性

建议原则：

- 先做“内置工具 registry 化”，再接插件
- 先打通“无 UI 的最小闭环”，再补管理界面
- 每个 phase 都应可单独验证并可回滚

---

## 3. Phase 1：ToolRegistry 中心化

## 3.1 目标

将当前 worker 中对 builtin / MCP tools 的硬编码分发，收敛到统一 `ToolRegistry`，为本地插件工具接入打基础。

该阶段完成后，即使还没有本地插件，也应该满足：

- `runner.ts` 不再直接维护大段工具执行分支
- builtin tools 与 MCP tools 都经由统一 registry 暴露给模型与执行
- 后续新增 local plugin provider 时不需要再次改造主循环

## 3.2 建议改动文件

### 优先新增

- `apps/agent-worker/src/runtime/tools/types.ts`
- `apps/agent-worker/src/runtime/tools/registry.ts`
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`
- `apps/agent-worker/src/runtime/tools/providers/mcp.ts`

### 重点修改

- `apps/agent-worker/src/runtime/runner.ts`
- `apps/agent-worker/src/runtime/mcpManager.ts`（按需，尽量少改）

### 可复用的现有实现

- `apps/agent-worker/src/runtime/bash.ts`
- `apps/agent-worker/src/runtime/bashTools.ts`
- `apps/agent-worker/src/runtime/fileTools.ts`
- `apps/agent-worker/src/runtime/applyPatch.ts`
- `apps/agent-worker/src/runtime/todolist.ts`

## 3.3 关键实现点

### A. 抽象统一工具定义

建议先落地以下概念：

- `ResolvedToolDefinition`
- `ToolExecutionResult`
- `ToolProvider`
- `ToolRegistry`

参考接口草案：

- `docs/design/agent/plugin/local-tool-plugin-interfaces-v1.md`

### B. 内置工具 provider 化

将以下工具包装为 `BuiltinToolProvider`：

- `bash`
- `read`
- `write`
- `apply_patch`
- `todolist`
- `subtask`
- `archive_search`
- `archive_read`

说明：

- 第一版可以内部仍复用现有执行函数
- 重点是把“定义 + 执行分发入口”搬进 provider，而不是重写工具逻辑

### C. MCP provider 化

将 `McpManager` 包装为 `McpToolProvider`：

- `listTools()` 继续来自 `mcpManager.listTools(...)`
- `execute()` 继续复用 `mcpManager.callTool(...)`

### D. 修改 runner 的注册与执行路径

重点替换 `runner.ts` 中两块硬编码逻辑：

1. 构建模型 `toolSet`
2. `executeTool(...)` 的分发逻辑

目标形态：

- `toolRegistry.listTools(...)`
- `toolRegistry.execute(toolName, args, ctx)`

### E. 保持现有文本主链路不变

该阶段不要碰以下行为语义：

- `buildToolText(...)`
- `buildToolSuccessText(...)`
- `finalizeToolText(...)`
- tool output 回写与 prompt 回灌

## 3.4 验证方式

### 最小验证

1. builtin tools 仍然可被模型看到并正常执行
2. MCP tools 仍可被列出并正常调用
3. `runner.ts` 主循环行为不变
4. tool 文本输出、截断与 artifact 现有行为不回归

### 建议命令/方式

- 跑现有 agent 相关测试（若仓库已有）
- 最小人工验证：
  - 开一个 agent session
  - 触发 `read` / `write` / `todolist`
  - 若本地有 MCP server，再验证一个 MCP tool

## 3.5 风险 / 回滚点

### 风险

- `runner.ts` 过于核心，改动过大容易破坏 pending tool 恢复逻辑
- builtin / MCP tool 的 enabled 逻辑容易在 registry 化过程中丢失
- tool 名称归一化不慎会影响 prompt/context 持久化

### 回滚点

- 保留原 builtin 执行函数，不要在此阶段重写工具内部实现
- registry 化若不稳定，可临时保留 old path behind feature flag 或最小兼容 wrapper

---

## 4. Phase 2：shared contracts / settings 扩展

## 4.1 目标

为插件治理与 agent 选择插件工具建立共享契约，不在 API/worker 各自私有定义。

## 4.2 建议改动文件

### 新增

- `packages/shared/src/contracts/plugin.ts`

### 修改

- `packages/shared/src/contracts/settings.ts`
- `packages/shared/src/contracts/agent.ts`
- 如有统一导出入口，也需补充 shared index/export 文件

## 4.3 关键实现点

### A. 插件相关共享 schema

建议在 `plugin.ts` 中落地：

- `PluginManifestSchema`
- `PluginStateSchema`
- `PluginDiagnosticSchema`
- `PluginRuntimeSnapshotSchema`
- `PluginToolCanonicalNameSchema`

### B. tool canonical name 规则

新增正则/类型：

- `plugin_<pluginId>_<toolName>`

不要在 v1 中把插件工具名塞进内置 tool union；应作为单独命名空间处理。

### C. agent settings 扩展

建议将 agent 侧工具选择拆分/扩展为：

- `builtinTools`
- `mcpServers`
- `pluginTools`

若要兼容现有结构，可考虑过渡策略：

- 保留现有 `tools` 一段时间
- 在 API 层做 normalize / migration

但建议尽量尽早收敛成更清晰的结构。

### D. prompt / context tool name 契约扩展

当前 `packages/shared/src/contracts/agent.ts` 对工具名约束主要覆盖 builtin + `mcp_...`。该阶段需要扩展：

- plugin canonical name schema
- 保持与现有 context item/tool item 存储兼容

## 4.4 验证方式

1. shared 类型构建通过
2. API/worker 对新增契约引用一致
3. 现有 builtin/MCP 数据模型不回归
4. 新增 `pluginTools` 后，旧 agent 配置仍可平滑读取或迁移

## 4.5 风险 / 回滚点

### 风险

- 改 shared contracts 容易牵动 API / web / worker 多端编译
- settings 结构调整可能影响现有设置页面和保存接口

### 回滚点

- 先增量新增 `plugin` contracts，不在同一阶段做大范围 UI 改造
- 若 `tools -> builtinTools` 迁移成本过高，可先保留兼容层，后续再完全切换

---

## 5. Phase 3：API 插件治理层

## 5.1 目标

在 API 侧建立“发现、校验、启用、配置、诊断、快照下发”的治理闭环。

该阶段完成后，即使 worker 还未真正加载插件，也应该能：

- 在 `<dataDir>/plugins` 扫描到候选插件
- 读取并校验 manifest
- 维护 enabled/config/state/diagnostics
- 提供 internal runtime snapshot 给 worker 使用

## 5.2 建议改动文件

### 新增模块

- `apps/api/src/modules/plugins/plugin.service.ts`
- `apps/api/src/modules/plugins/plugin.routes.ts`
- `apps/api/src/modules/plugins/plugin.discovery.ts`
- `apps/api/src/modules/plugins/plugin.schemas.ts`（可选）

### 可能新增/修改的存储位置

- settings service / settings key 定义处
  - `apps/api/src/modules/settings/settings.service.ts`
- 路由注册入口
  - API app/module wiring 相关文件

### 需要补充路径 helper

- `apps/api/src/infra/fs/paths.ts`
  - `pluginsRoot(dataDir)`
  - `pluginRoot(dataDir, pluginId)`（可选）

### 可能复用/参考

- `apps/api/src/config/env.ts`
- `apps/api/src/main.ts`
- `apps/api/src/config/repoRoot.ts`（仅作对比，不作为插件根目录）

## 5.3 关键实现点

### A. 扫描规则

扫描：

```text
<dataDir>/plugins/*
```

判定候选插件目录规则：

- 子目录存在 `agent-workbench.plugin.json`
- 只支持目录型插件包

### B. manifest 校验

需要实现两层校验：

1. JSON Schema 校验
2. 运行时补充校验
   - `entry` 存在
   - `entry` 位于插件根目录内
   - `entry` 后缀仅允许 `.js/.mjs/.cjs`
   - `capabilities` 至少一项
   - 若包含 `tools`，则 `tools[]` 合法且不重复

### C. 插件设置落点

建议新增独立 settings key，例如：

- `agent_plugins_v1`

存储内容至少包括：

- `id`
- `path`
- `enabled`
- `config`

### D. diagnostics / state

建议 API 层产出稳定状态：

- `discovered`
- `disabled`
- `invalid_manifest`
- `incompatible`
- `config_invalid`
- `load_failed`（worker 回写或合并）
- `manifest_mismatch`（worker 回写或合并）
- `ready`

### E. internal runtime snapshot

建议提供内部接口给 worker：

- 插件列表
- manifest
- 插件绝对路径
- entry 绝对路径
- enabled
- config
- diagnostics/state

注意：

- worker 只消费 snapshot，不重复自己扫描目录

## 5.4 验证方式

1. 在 `<dataDir>/plugins/debug-tools` 放一个最小 manifest 后，API 能发现插件
2. 非法 manifest 能进入 `invalid_manifest`
3. 合法 manifest + disabled 状态能被稳定展示
4. config schema 不通过时进入 `config_invalid`
5. internal snapshot 返回路径、状态、manifest、config 信息完整

## 5.5 风险 / 回滚点

### 风险

- settings 持久化结构设计不当，后续迁移困难
- 扫描时若路径校验不足，可能引入越界/软链问题
- 如果把 worker runtime 状态也全堆在 API 静态扫描结果里，状态语义会混乱

### 回滚点

- 先把 API 状态分为“静态治理状态”和“运行时加载状态”两层
- worker 回传状态可以后补，不要第一阶段强耦合

---

## 6. Phase 4：worker 插件运行时与本地插件加载

## 6.1 目标

支持 worker 从 API runtime snapshot 加载本地插件，完成 manifest/runtime 一致性检查，并把插件工具注册进 `ToolRegistry`。

## 6.2 建议改动文件

### 新增

- `apps/agent-worker/src/runtime/plugins/types.ts`
- `apps/agent-worker/src/runtime/plugins/loader.ts`
- `apps/agent-worker/src/runtime/plugins/runtimeManager.ts`
- `apps/agent-worker/src/runtime/tools/providers/local-plugin.ts`

### 修改

- `apps/agent-worker/src/runtime/runner.ts`
- `apps/agent-worker/src/runtime/apiClient.ts`（如需获取插件 snapshot）

## 6.3 关键实现点

### A. PluginRuntimeManager

建议职责：

- 接收 API 下发的插件 snapshots
- 过滤当前真正需要的插件
- 加载插件入口
- 构造 `PluginContext`
- 校验 manifest/runtime 一致性
- 收集 `ToolDefinition`
- 注册给 `LocalPluginToolProvider`

### B. 当前 run 需要哪些插件

建议仅加载满足以下条件的插件：

- 全局 enabled
- state 至少允许尝试加载
- 当前 agent 至少启用了一个该插件工具

避免把所有插件都无脑加载进 worker。

### C. 入口加载策略

第一阶段只支持：

- `.js`
- `.mjs`
- `.cjs`

并要求：

- 默认导出或标准导出能解析为 `PluginDefinition`
- 不做 TS loader

### D. manifest/runtime 一致性校验

至少校验：

- runtime `meta.id === manifest.id`
- runtime `meta.version === manifest.version`
- runtime 导出的工具集合必须是 manifest `tools[]` 的子集
- runtime 不允许注册 manifest 未声明工具
- manifest 声明但 runtime 未导出的工具允许 warning

### E. 插件输出契约约束

在 worker 执行插件工具时校验：

- `text` 必填且为字符串
- `raw` 若存在则必须 JSON-serializable
- 插件抛异常时，由宿主统一转为失败状态

### F. 不要让插件改变 prompt 主链路

保持：

- prompt 只消费 `text`
- `raw` 不进入 prompt
- `raw` 默认不落库

### G. 与未来能力解耦

即使 v1 只实现 tools，也不要把 loader 直接设计成“只返回 tool 数组”。建议保留：

- `PluginDefinition.capabilities`
- `PluginContext`
- `PluginLifecycle`

但当前只消费 `capabilities.tools`

## 6.4 验证方式

1. worker 能加载一个合法本地插件
2. manifest 不匹配时插件进入 `manifest_mismatch`
3. 合法插件工具能注册进 `ToolRegistry`
4. 模型能看到 `plugin_<pluginId>_<toolName>`
5. 工具执行时 `text` 正常回灌 prompt
6. `raw` 不进 prompt、不默认落库
7. 插件抛异常时 tool item 正确标记失败

## 6.5 风险 / 回滚点

### 风险

- loader 与 registry 耦合过深，会堵死未来 hooks/services/channels
- 插件路径与 entry 安全校验不足
- 插件导出格式过于灵活，导致运行时兼容复杂

### 回滚点

- 第一阶段限制导出协议，保持严格而简单
- 若 worker 集成过重，可先只在启动时/每次 run 前做无缓存加载，后续再优化缓存

---

## 7. Phase 5：样板插件 `debug-tools / echo_inspect`

## 7.1 目标

用一个最小、低风险、强可观测的插件，验证工具插件全链路闭环。

## 7.2 建议新增文件

建议直接放在：

```text
<dataDir>/plugins/debug-tools/
```

作为本地运行样板，而不是先放进 monorepo package。

建议结构：

```text
plugins/debug-tools/
  package.json
  agent-workbench.plugin.json
  dist/index.js
```

如需仓库内示例，也可额外放一份文档/fixture，但不建议把它作为生产内置插件耦合进源码。

## 7.3 关键实现点

### manifest

- `id = debug-tools`
- `capabilities = ["tools"]`
- 工具声明：`echo_inspect`

### runtime 导出

- `meta.id = debug-tools`
- `capabilities.tools = [echo_inspect]`

### 工具行为

输入：

- 简单 JSON 参数，例如 `message/tags/includeRaw/mode`

输出：

- `text`：稳定、可读、适合模型消费
- `raw`：可选，返回收到的参数与少量元信息

建议支持测试分支：

- `mode = ok`
- `mode = throw`
- `mode = long_text`

## 7.4 验证方式

1. API 能扫描到 `debug-tools`
2. 全局启用后 worker 能加载
3. agent 选中 `plugin_debug-tools_echo_inspect` 后模型可见
4. 工具执行时 `text` 可在上下文中看到
5. `raw` 存在时不影响 prompt 主链路
6. `throw` 分支能验证失败路径

## 7.5 风险 / 回滚点

### 风险

- 若第一版样板插件做得太复杂，会掩盖插件系统本身的问题

### 回滚点

- 保持样板插件只有一个工具
- 先不接网络、文件写入、外部依赖

---

## 8. Phase 6：web / 管理与最小可见性

> 建议放在 Phase 5 之后。原因：先跑通“无 UI 闭环”更利于快速验证底座；UI 只做最小可见性，不应成为前置阻塞。

## 8.1 目标

为插件治理与 agent 工具选择提供最小管理界面和可见性。

## 8.2 建议改动文件

### web 侧（按现有结构补充）

根据当前 web 实际目录组织增量新增，原则上需要：

- 插件列表页 / 设置页子区域
- agent 设置中的插件工具选择区

### API 侧配套

- `apps/api/src/modules/plugins/plugin.routes.ts`
- settings 相关接口补充

## 8.3 关键实现点

### A. 全局插件管理

最小能力：

- 展示插件列表
- 展示 state/diagnostics
- enable/disable
- 编辑插件 config（可先文本 JSON）

### B. agent 工具选择

最小能力：

- 展示插件工具列表
- 允许 agent 选择 `pluginTools`
- 清楚显示工具来源与 canonical name

### C. 不做富 UI

v1 插件工具结果默认仍按普通 tool card 展示文本，不额外做专属 artifact 或富卡片。

## 8.4 验证方式

1. 在设置页能看到 `debug-tools`
2. 能启用/禁用插件
3. 能为 agent 勾选 `plugin_debug-tools_echo_inspect`
4. 新 run 中工具可见性随设置变化生效

## 8.5 风险 / 回滚点

### 风险

- UI 与 settings 结构变更容易带来历史数据兼容问题
- 如果 UI 先做太多，会反过来拖慢底层实现

### 回滚点

- 先提供最小管理界面即可
- 配置编辑可以先用 JSON 文本区域，后续再做 schema form

---

## 9. 最小里程碑定义

建议按以下里程碑判断“工具插件系统是否基本可用”。

### Milestone A：Registry 底座可用

满足：

- builtin / MCP 已通过 `ToolRegistry`
- `runner.ts` 不再依赖大段硬编码工具分发

说明：

- 到此阶段还没有本地插件，但地基已经可用

### Milestone B：API 治理闭环可用

满足：

- `<dataDir>/plugins` 可扫描
- manifest / config / enabled / diagnostics 可管理
- worker 可拿到插件 runtime snapshot

说明：

- 到此阶段插件治理层已成立，但 worker 还可能未真正执行插件

### Milestone C：本地插件执行闭环可用

满足：

- worker 能加载合法 JS 插件
- manifest/runtime 一致性校验生效
- 插件工具能进入模型 tool list 并被执行
- `text` 回灌 prompt 正常

说明：

- 到此阶段可以认为“工具插件系统基本可用”

### Milestone D：样板插件验证通过

满足：

- `debug-tools / echo_inspect` 跑通全链路
- `throw` / `long_text` 等测试分支也工作正常

说明：

- 到此阶段可开始让真实业务插件接入

### Milestone E：最小管理面可用

满足：

- Web 可查看插件状态
- 可全局启用插件
- 可为 agent 勾选插件工具

说明：

- 到此阶段插件能力对普通使用者可见、可配置

---

## 10. 建议的实现节奏

建议按如下节奏推进：

### Sprint 1

- Phase 1
- Phase 2

目标：打好 registry 与 contracts 基础

### Sprint 2

- Phase 3
- Phase 4

目标：打通 API 治理与 worker 插件加载闭环

### Sprint 3

- Phase 5
- Phase 6

目标：用样板插件验证并提供最小管理能力

---

## 11. 额外注意事项

### 11.1 不要一开始做兼容所有插件导出风格

第一阶段建议严格收敛插件导出协议，避免运行时兼容面太大。

### 11.2 不要让 worker 自己扫描插件目录

目录扫描、manifest 校验、插件路径计算统一放在 API，更符合治理边界。

### 11.3 不要让 `raw` 悄悄进入 prompt 或默认持久化

这是 v1 很容易被“临时方便”破坏的约束，应在实现时明确守住。

### 11.4 不要把 channels/hooks/services 的未来空间做死

v1 虽然不实现这些能力，但：

- `PluginDefinition` 应有 `capabilities`
- `PluginContext` 与 `ToolExecutionContext` 应分层
- worker 内部最好保留 `PluginRuntimeManager` 概念，而不是把 loader 直接耦合到 `ToolRegistry`

---

## 12. 总结

推荐的最小落地路径是：

1. 先把 `runner.ts` 的工具执行链路 registry 化
2. 再补 shared contracts / settings 扩展
3. API 建立 `<dataDir>/plugins` 的治理闭环
4. worker 加载本地 JS 插件并注册工具
5. 用 `debug-tools / echo_inspect` 验证全链路
6. 最后补最小 web 管理与可见性

以此顺序推进，可以在不引入过多一次性复杂度的前提下，把本地工具插件系统稳定落地，并为后续 IM/channel、hooks、services 留出生长空间。
