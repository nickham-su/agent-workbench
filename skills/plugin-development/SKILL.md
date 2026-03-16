---
name: 插件开发手册
description: 面向 agent-workbench 的通用插件开发操作手册（以 tools 为主，feishu 仅作补充案例）
---

# 插件开发手册（通用主线）

本手册用于指导你在 `agent-workbench` 中开发插件，定位是**开发者操作手册**：

- 以“如何落地一个可运行插件”为主。
- 以 `tools` 能力为主线（最通用、最稳定）。
- `plugins/feishu` 仅作为进阶案例，不作为默认模板。
- 同时补充必要的关键原理，帮助你理解“为什么要这么做”。

---

## 1. 适用范围与能力边界

### 1.1 本手册主要适用

- 想新增一个可被 agent 调用的本地工具插件。
- 想理解插件从“写代码”到“被宿主发现和执行”的完整链路。
- 想基于仓库内现有样例快速起步。

### 1.2 当前插件能力（按契约）

插件契约在 `packages/shared/src/contracts/plugin.ts`，`capabilities` 目前定义为：

- `tools`
- `channels`
- `hooks`
- `services`

但**“可声明”不等于“同等成熟支持”**。在当前仓库实现里：

- `tools`：通用开发主线，支持最完整。
- `channels/services`：存在真实实现（飞书），但属于渠道/服务型能力，复杂度显著更高。
- `hooks`：契约有声明，手册不作为主开发路径。

结论：新插件优先从 `tools` 起步，除非你明确在做渠道/网关类集成。

---

## 2. 快速认知：插件如何被系统消费

先建立一个最小心智模型：

1. API 扫描插件目录并读取 `agent-workbench.plugin.json`（`apps/api/src/modules/plugins/plugin.service.ts`）。
2. API 校验 manifest、entry、configSchema，并生成 runtime snapshots。
3. worker 侧按工具名注册/拉取插件工具（本地 provider 或远程 provider）。
4. 工具调用时，执行插件入口里的 `execute`。

关键点：

- 插件不是“放个脚本就能跑”，而是“manifest + 入口导出 + 宿主治理”的组合。
- 宿主会生成 canonical 工具名：`plugin_<pluginId>_<toolName>`（契约见 `PluginToolCanonicalNameSchema`）。

---

## 3. 开发一个最小工具插件（主示例：debug-tools）

主参考样例：

- `test/fixtures/plugins/debug-tools/agent-workbench.plugin.json`
- `test/fixtures/plugins/debug-tools/dist/index.js`
- `test/fixtures/plugins/debug-tools/README.md`

### 步骤 1：准备目录

运行时插件根目录是：

- 用户插件：`<dataDir>/plugins/<pluginId>/`

路径函数可见：`apps/api/src/infra/fs/paths.ts` 中 `pluginsRoot(dataDir)` / `pluginRoot(dataDir, pluginId)`。

建议目录结构：

```text
<dataDir>/plugins/<pluginId>/
  agent-workbench.plugin.json
  dist/index.js
```

### 步骤 2：编写 manifest

文件名固定：`agent-workbench.plugin.json`。

最小必备字段：

- `schemaVersion: 1`
- `id`
- `name`
- `version`
- `entry`（如 `dist/index.js`）
- `capabilities: ["tools"]`
- `tools`（声明工具列表）

### 步骤 3：实现入口导出

入口文件需导出插件定义对象。宿主按 **`default -> plugin -> moduleExports`** 顺序解析，建议使用 `default export`（见 `runtime/plugins/runtimeManager.ts` 与 `plugin-host/workerCompat/runtimeManager.ts`）。

工具至少包含：

- `name`
- `description`
- `inputSchema`（JSON Schema）
- `execute(args)`

`debug-tools` 的 `echo_inspect` 展示了三个典型分支：

- `ok`：返回稳定文本
- `throw`：主动抛错（验证错误链路）
- `long_text`：长文本输出（验证边界）

### 步骤 4：构建 JS 产物

宿主只接受 `.js/.mjs/.cjs` 入口（见 `plugin.service.ts` 的 `ENTRY_ALLOWED_EXTENSIONS`）。

注意：

- `entry` 指向 `.ts` 会被判为不合法。
- 生产运行不直接执行 TypeScript 入口。

### 步骤 5：启用与验证

插件发现与状态由 API 模块统一管理（`plugin.service.ts` / `plugin.routes.ts`）。

建议验证顺序：

1. 插件是否被发现（runtime snapshot 中有对应 `id`）。
2. 在 settings/config 中把该插件设为启用（`enabled=true`，对应 `agent_plugins_v1` 配置）。
3. 再确认状态为 `ready`（未启用时会出现 `plugin_disabled`，不会进入 ready）。
4. 工具名是否出现在可用列表（canonical name）。
5. `execute` 正常返回 `text`。

最小验证路径可直接用 `debug-tools`：先启用插件，再调用 `plugin_debug-tools_echo_inspect`，分别验证 `ok` 与 `throw` 分支。

---

## 4. manifest / 契约 / 命名 / 返回值约束

### 4.1 ID 与命名约束

契约定义于 `packages/shared/src/contracts/plugin.ts`：

- `PluginIdSchema`：`^[a-z0-9][a-z0-9-]{0,63}$`
- 工具短名 `PluginToolShortNameSchema`：`^[A-Za-z][A-Za-z0-9_-]{0,63}$`
- canonical 名：`plugin_<pluginId>_<toolName>`

你在插件里只写短名，canonical 名由宿主生成和校验。

### 4.2 返回值约束

从契约与运行时实现看（`PluginToolRpcExecuteResponseSchema` 以及 worker runtime 的插件工具执行类型），工具执行结果应满足：

- `text`：必填字符串
- `raw`：可选，且应为 JSON-serializable 数据

实践建议：

- 模型消费主文本放在 `text`。
- 调试/结构化信息放在 `raw`。
- 不要在 `raw` 放函数、循环引用、不可序列化对象。

### 4.3 配置与敏感字段

manifest 可选：

- `configSchema`：配置结构校验（AJV 编译/校验）。
- `uiHints.sensitiveKeys`：声明敏感字段，用于设置展示脱敏。

示例可见 `plugins/feishu/agent-workbench.plugin.json`（如 `appSecret`）。

---

## 5. 构建、放置、发现、调试、排障

### 5.1 构建与放置

1. 在插件工程中完成构建，得到 JS 入口（如 `dist/index.js`）。
2. 把插件目录放到 `<dataDir>/plugins/<pluginId>/`。
3. 确保 manifest `entry` 与实际文件一致。

### 5.2 发现与覆盖规则

当前实现存在两类 roots（见 `plugin.service.ts::resolvePluginRoots`）：

- `user` root：`<dataDir>/plugins`（priority 100）
- `official` root：`<repoRoot>/plugins`（priority 10）

同 ID 同时存在时：**user 覆盖 official**，并产生冲突诊断。

### 5.3 常见失败点（高频）

1. **manifest 无效**：字段缺失、schemaVersion 错误、tools 声明与 capabilities 不一致。
2. **entry 非 JS 扩展**：不是 `.js/.mjs/.cjs`。
3. **entry 越界**：入口真实路径不在插件根内（含软链跳出）。
4. **config 非法**：不满足 `configSchema` 或不可 JSON 序列化。
5. **工具名不合法**：短名不符合字符集。

### 5.4 排障建议

- 先看 runtime snapshots 与 diagnostics（来源分 discovery/manifest/config/runtime/compat）。
- 再验证工具调用链路（list -> execute）。
- 最后才排查业务逻辑（`execute` 内部实现）。

---

## 6. 宿主加载与执行链路（关键原理，精简版）

### 6.1 API 侧治理

- 核心：`apps/api/src/modules/plugins/plugin.service.ts`
- 职责：扫描 roots、解析 manifest、校验 entry/config、输出 runtime snapshots。

### 6.2 worker / plugin-host 执行路径

两条 provider 路径都已存在：

- 本地路径：`LocalPluginToolProvider`
  - 文件：`apps/agent-worker/src/runtime/tools/providers/local-plugin.ts`
- 远程路径：`RemotePluginToolProvider`
  - 文件：`apps/agent-worker/src/runtime/tools/providers/remote-plugin.ts`
  - 经 API internal routes 转发到 plugin-host

internal API 关键路由（`apps/api/src/modules/agent/agent.routes.ts`）：

- `/api/internal/agent/plugins/runtime-snapshots`
- `/api/internal/agent/plugins/tools/list`
- `/api/internal/agent/plugins/tools/execute`

补充：远程工具路径受 `AWB_AGENT_REMOTE_PLUGIN_TOOLS` 开关影响（默认关闭）。

### 6.3 为什么要有这层治理

- 防止随意脚本直接注入运行时。
- 在执行前统一完成格式校验、路径安全校验、配置校验。
- 让插件问题可观测（diagnostics）且可回滚。

---

## 7. 飞书插件案例（补充，不是主线）

参考：

- `plugins/feishu/agent-workbench.plugin.json`
- `plugins/feishu/src/index.ts`
- `apps/api/src/plugin-host/servicesRuntime.ts`

### 7.1 可参考的模式

1. `configSchema + sensitiveKeys` 的配置治理方式。
2. 渠道/服务型插件如何通过内部 API 与宿主通信。
3. 服务生命周期（start/stop）与宿主侧运行管理。

### 7.2 不建议照搬的部分

1. 飞书协议与命令体系（例如 `/ss`、`/a`、`/c` 等）是业务特化。
2. 飞书消息流、会话绑定、发送策略、去重策略是渠道特化实现。
3. `servicesRuntime` 里当前是面向飞书网关的特定逻辑，不等于通用 services 模板。

结论：飞书更像“复杂插件参考样本”；当前最成熟、最稳妥的起步路径仍是 `tools` 插件。

---

## 8. 新插件开发 Checklist

在提交插件前，逐项确认：

1. **结构正确**：目录在 `<dataDir>/plugins/<pluginId>/`，manifest 文件名正确。
2. **契约正确**：`schemaVersion=1`，`id/name/version/entry/capabilities` 完整。
3. **工具声明一致**：manifest `tools[]` 与入口导出 `capabilities.tools[]` 对齐。
4. **命名合法**：pluginId 与 tool short name 满足正则。
5. **入口可执行**：`entry` 指向 JS 产物，且未越出插件根目录。
6. **输出合规**：`execute` 始终返回 `text`，`raw` 可选且可序列化。
7. **启用状态正确**：在 settings/config 中设置 `enabled=true`，否则插件不会进入 `ready`。
8. **配置可校验**：若定义 `configSchema`，在空配置和目标配置下都能通过预期校验。
9. **运行可观测**：能在 runtime snapshots 看到 `ready` 状态与清晰 diagnostics。
10. **异常可诊断**：有基本错误分支（类似 `throw`）与边界分支（类似 `long_text`）测试。
11. **案例定位清晰**：若参考飞书，仅复用通用模式，不复制渠道特有逻辑。

---

## 9. 推荐阅读路径

若你第一次接触该体系，建议按顺序看：

1. `packages/shared/src/contracts/plugin.ts`（先看契约）
2. `test/fixtures/plugins/debug-tools/*`（再看最小示例）
3. `apps/api/src/modules/plugins/plugin.service.ts`（看发现/校验/快照）
4. `apps/agent-worker/src/runtime/tools/providers/local-plugin.ts` 与 `remote-plugin.ts`（看执行入口）
5. `plugins/feishu/*`（最后看进阶案例）

这样能先建立可落地路径，再理解扩展能力，学习成本最低。
