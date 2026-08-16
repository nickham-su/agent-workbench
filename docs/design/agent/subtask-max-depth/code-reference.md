# 现有代码引用

本文档记录设计实施前必须核对的当前代码入口。行号仅辅助定位；实现和审查必须以“路径 + 类型/函数名”为准。

## Runtime settings

| 路径 | 类型/函数或位置 | 当前职责 | 本设计改动 |
|---|---|---|---|
| `packages/shared/src/contracts/settings.ts` | `AgentRuntimeSettingsSchema`、`UpdateAgentRuntimeSettingsRequestSchema` | 前后端共享 runtime 设置契约。 | 增加 `maxSubtaskDepth`，范围 1–5。 |
| `apps/api/src/modules/settings/settings.routes.ts` | `GET/PUT /api/settings/agent/runtime` | 暴露现有 runtime settings API。 | 路由不变，响应/body 自动采用扩展 schema。 |
| `apps/api/src/modules/settings/settings.service.ts` | `AGENT_RUNTIME_SETTINGS_KEY`、`getAgentRuntimeSettingsStored()`、`getAgentRuntimeSettings()`、`updateAgentRuntimeSettings()` | 读取、规范化、存储 `agent_runtime_v1`。 | 增加默认 1、stored 容错与 update 严格校验。 |
| `apps/api/src/infra/db/schema.ts` | `settings` 表 | JSON setting 的通用存储。 | 无 schema 改动。 |
| `apps/web/src/features/settings/views/SettingsTab.vue` | `agent/runtime` tab | Runtime settings 面板入口。 | 不新增路由。 |
| `apps/web/src/features/settings/components/AgentRuntimeSettingsPanel.vue` | form state、`mapFromSettings()`、`save()` | Runtime 设置表单。 | 增加数字输入、映射、保存 payload。 |
| `apps/web/src/shared/i18n/locales/zh-CN.ts`、`en-US.ts` | `settings.agentRuntime` | Runtime 设置文案。 | 增加标签和完整帮助文案。 |
| `apps/web/src/shared/api/api.ts` | `getAgentRuntimeSettings()`、`updateAgentRuntimeSettings()` | Web API 封装。 | 函数签名不变，共享类型自动扩展。 |

## 数据库和 run store

| 路径 | 类型/函数或位置 | 当前职责 | 本设计改动 |
|---|---|---|---|
| `apps/api/src/infra/db/schema.ts` | `initSchema()`、`ensureColumn()`、`agent_run` DDL、index 区域 | 新库建表和旧库 SQLite 升级。 | 添加三列、partial unique index、parent run index；不新增迁移框架。 |
| `apps/api/src/modules/agent/agent.store.ts` | `AgentRunRecord` | run 读取模型。 | 增加 nullable depth 和 parent 字段。 |
| 同上 | `createRunRecord()` | 创建 `agent_run`。 | INSERT 和 params 写入 lineage。 |
| 同上 | `getRunRecord()` | 获取单个 run。 | SELECT/映射三列。 |
| 同上 | 新增 `findSubtaskRunByParentTool()`、最新 run 查询 helper | 当前缺少按 parent tool 查询和统一最新 run helper。 | 支持幂等和普通继续/fork 深度决定。 |

## Session、普通 fork 与普通 run

| 路径 | 类型/函数或位置 | 当前职责 | 本设计改动 |
|---|---|---|---|
| `packages/shared/src/contracts/agent.ts` | `AgentSessionRecordSchema` | session 中已有 `forkedFromSessionId` / `forkedFromItemId`。 | 不新增 `forkedFromRunId` 或 depth 字段。 |
| 同上 | `AgentContextItemRecordSchema` | item 暴露可空 `runId`。 | 普通 fork 首 run 通过源原始 item 的 `runId` 追溯。 |
| 同上 | `AgentForkSessionRequestSchema` | fork 请求含 `fromSessionId`、`fromItemId`。 | 不增加 `fromRunId`。 |
| `apps/api/src/modules/agent/agent.service.ts` | `createSession()` | 创建 session。 | 无新增 session 字段。 |
| 同上 | `forkSession()` | 创建 fork session 和复制 context。 | 保持现有 fork 字段；首 run 时从源 item 解析 lineage。 |
| 同上 | `sendMessage()` | 用户写 message、创建普通 run。 | 计算 root/继承/普通 fork 的 run depth；继续拒绝 subtask session 写入。 |
| 同上 | `compactSession()` | 用户触发上下文压缩、创建 compaction run。 | 继承 session 最近有效 run 的 depth；两个 parent 字段为 `NULL`，不增加深度。 |
| `apps/api/src/modules/agent/agent.routes.ts` | `POST /api/agent/sessions`、`POST /api/agent/sessions/fork` | session API。 | 请求与返回契约保持不变。 |
| `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` | `onForkFromMessage()` | UI 发起 fork。 | 不改请求参数。 |

## Subtask、prompt 和 worker

| 路径 | 类型/函数或位置 | 当前职责 | 本设计改动 |
|---|---|---|---|
| `apps/api/src/modules/agent/agent.routes.ts` | `POST /api/internal/agent/subtask/start` | Internal subtask start API。 | 保持请求 shape；成功 response 增加内部 `reused` 布尔值，并继续声明 409。 |
| `apps/api/src/modules/agent/agent.service.ts` | `resolveSubtaskParentContext()` | 校验 parent session/run/tool anchor。 | 作为幂等和深度检查前置步骤。 |
| 同上 | `startSubtaskRunFromWorker()` | new/fork/existing session 和 child run 创建。 | 先复用、再配置/深度检查；写 child run lineage；处理 unique 冲突。 |
| 同上 | `resolveSubtaskForkBoundaryItemId()` | 解析 fork context boundary。 | 继续只决定 context，不参与 depth。 |
| 同上 | `getPromptContextForRun()` | 构造 prompt 的静态 system/tools。 | 用 run depth + runtime settings 替代 `session.kind` 的 subtask 过滤。 |
| 同上 | `sendMessage()` | 发现 `kind="subtask"` 时返回 `AGENT_SUBTASK_READONLY`。 | 保持此限制。 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | `parseSubtaskArgs()`、`case "subtask"` | 解析并启动 nested run。 | 不传 depth；按 `reused` 避免重复执行已有 child run。 |
| `apps/agent-worker/src/runtime/apiClient.ts` | `startSubtaskRun()`、`getSubtaskStatus()`、`getSubtaskResult()`、`request()` | 调 start/status/result API；将 `{message, code}` 转文本错误。 | 成功 response 增加 `reused`；复用 running child 时轮询已有 status 至 terminal；不引入结构化 Error。 |
| `apps/agent-worker/src/runtime/runner.ts` | `processNestedRun()`、工具错误输出 | 执行 nested run 和输出异常。 | 保持文本错误显示深度 code。 |
| `apps/api/src/app/createApp.ts` | 全局 error handler | `HttpError` 转 `{message, code}`。 | 无框架改动，新增两个 409 由其自然传播。 |

## 现有设计文档的关系

| 文档 | 关系 |
|---|---|
| `docs/design/agent/subtask-recursion-guard-v1.md` | 本设计替换其中“所有 `kind=subtask` 永久隐藏 subtask 工具”的规则。fork guard system message 仍保留；仅工具过滤条件改为 run depth。 |
| `docs/design/agent/subtask-prefork-compaction.md` | 保持 prefork summary 行为。它只影响 fork session/context；所有 fork 分支都按本设计写相同 child run depth。 |

## 测试入口

| 层级 | 建议文件 | 覆盖重点 |
|---|---|---|
| Web settings | `apps/web/src/features/settings/components/agentRuntimeSettings.test.ts` | 默认映射、1/5 输入和保存 payload。 |
| API integration | `apps/api/src/modules/agent/agent.integration.test.ts` | settings、run depth、compaction run、new/fork/existing、fork、错误、幂等和 unique 冲突复查。 |
| Worker integration | `apps/api/src/modules/agent/agent.worker.integration.test.ts` | prompt tool 可见性、嵌套启动和错误文本。 |
| Worker provider | `apps/agent-worker/src/runtime/provider-subtask-cancel.test.ts` | 新增或扩展 provider 测试：`reused=false` 启动 child；`reused=true` 的 terminal child 不重复执行；running child 轮询至 terminal。 |
| Worker runner | `apps/agent-worker/src/runtime/runner.cancel.test.ts` | 验证 reused-running 等待期间父 `AbortSignal` 中止时不再执行 child，并沿用既有取消传播。 |
