# 开发任务拆分与实施计划

## 实施原则

- 先建立数据库和 Store 不变量，再接入应用层/API，最后开发 UI；
- 每一步保持可测试，避免把 schema、自动写回、API 和 UI 一次性混改；
- 自动标题与手动标题使用不同名称的 Store 方法，防止调用方误用；
- 不修改与标题功能无关的 Session 生命周期、排序、WebSocket 或 Worker 协议；
- 不扩散内部 `title_manually_set` 到共享 Session record；
- 实施期间如发现当前代码与本文基线不同，应先更新设计或说明差异，不得静默改变产品合同。

## 任务拆分

| 任务 | 主要产物 | 前置依赖 |
|---|---|---|
| 数据库迁移 | `title_manually_set` 新列、新旧库测试 | 无 |
| Store 原子操作 | 自动条件更新、手动原子设置 | 数据库列 |
| 自动路径接入 | 首消息、todolist append/update | Store 自动操作 |
| 共享请求契约 | update title request schema/type | 无 |
| 应用层能力 | 校验、归属、Store 调用、返回 record | 契约、Store |
| 路由与 Service | PUT API、白名单、OpenAPI | 应用层 |
| Web API 客户端 | 请求封装 | 共享契约、路由 |
| Tab 与弹窗 | 设置入口、回填、保存 | Web API |
| 陈旧响应防护 | revision 合并 | UI 状态 |
| 回归与验收 | 自动化测试、手工记录 | 全部实现 |

## 详细实施步骤

### 数据库 schema

修改 `apps/api/src/infra/db/schema.ts`：

- 在新建 `agent_session` DDL 中加入：

```sql
title_manually_set integer not null default 0
  check (title_manually_set in (0, 1))
```

- 在 `ensureColumn()` 区域增加旧库升级；
- 添加或扩展 schema migration 测试；
- 验证重复初始化幂等；
- 验证历史行默认 `0`。

完成条件：新库、旧库、重复启动测试全部通过。

### Store API 分离

修改 `apps/api/src/modules/agent/agent.store.ts`：

- 将现有 `updateAgentSessionTitle` 收窄/重命名为自动标题更新；
- SQL 增加 `title_manually_set = 0`；
- 保留 `updated_at = @updatedAt`；
- 返回 `changes > 0`；
- 新增手动标题设置函数，原子设置 title 和标记，不更新 `updated_at`；
- 创建 Session 时显式写入 `title_manually_set = 0`；
- 不修改 `AgentSessionRow`、`mapSession()` 或共享响应结构。

新增 Store 测试，先证明数据库不变量，再修改调用方。

### 自动标题调用方

修改首消息路径：

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts`
- 保留 `head == null` 和格式化规则；
- 改调自动条件更新函数；
- 忽略 false，不抛错。

修改 todolist 两条路径：

- `apps/api/src/modules/agent/writeback/context-writeback-application.ts`
- dependency 从宽泛 `updateSessionTitle` 改为 `updateAutoSessionTitle` 等明确名称；
- append/update 调用条件不变；
- false/void 均不得影响工具写回成功。

修改装配：

- `apps/api/src/modules/agent/agent.composition.ts:1637-1643` 附近；
- 注入自动 Store 操作。

扩展测试：

- `apps/api/src/modules/agent/writeback/context-writeback-application.test.ts`
- lifecycle 相关测试；
- `apps/api/src/modules/agent/integration/agent-prompt-context.integration.test.ts`

完成条件：auto 既有用例不变，manual 下三条自动路径均跳过且主流程成功。

### 标题规范化

在 Agent 领域内建立或复用 helper：

- 共同空白压缩；
- 自动截断规则保持；
- 手动空白、长度和控制字符校验，并固定返回 `AGENT_SESSION_TITLE_EMPTY`、`AGENT_SESSION_TITLE_TOO_LONG`、`AGENT_SESSION_TITLE_INVALID_CHARACTERS` 三类结果。

实施时避免两种风险：

- 为去重而改变首消息/goal 现有行为；
- 在路由和前端各自发明不同规则。

helper 应有纯函数测试，覆盖 1、50、51、空白、换行、Emoji/代理对计长认知。

### 共享契约

修改 `packages/shared/src/contracts/agent.ts`：

- 新增 `AgentUpdateSessionTitleRequestSchema`；
- 新增对应 TypeScript type；
- `additionalProperties: false`；
- 原始字符串固定 `minLength: 1, maxLength: 1000`；
- 不修改 `AgentSessionRecordSchema`。

如 `packages/shared/src/index.ts` 不是自动导出该文件，则确认并补充公开导出。当前契约入口约定为该文件/共享 index，实施时以现有导出方式为准。

运行：

```bash
npm run build -w packages/shared
npm run typecheck
```

### Session 应用层与 Store 端口

修改：

- `apps/api/src/modules/agent/session/session-interaction-ports.ts`
- `apps/api/src/modules/agent/session/sqlite-session-interaction-store.ts`
- `apps/api/src/modules/agent/session/session-interaction-application.ts`

步骤：

- 端口增加 `setManualTitle`；
- SQLite adapter 委托手动 Store 函数；
- Application 增加公开方法；
- 明确 Fastify/Schema 结构校验先于应用层，结构非法请求不进入 Application；
- Application 内固定“Session 存在性 → Workspace 归属 → 规范化标题业务校验”顺序；
- 更新后重新查询 record；
- 不读取 run-state；
- 不限制 `kind`；
- 不传 `updatedAt` 给手动 Store。

扩展 `session-interaction-application.test.ts`，使用窄 fake store 验证调用次序和错误语义。

### Service、Composition 与路由

修改：

- `apps/api/src/modules/agent/agent.composition.ts`
- `apps/api/src/modules/agent/agent.service.ts`
- `apps/api/src/modules/agent/routes/agent-route-auth.ts`
- `apps/api/src/modules/agent/routes/agent-public.routes.ts`

步骤：

- Session capability 加入 `updateSessionTitle`；
- Service facade 委托；
- 路由字段白名单只允许 `workspaceId/title`；
- 注册 `PUT /api/agent/sessions/:sessionId/title`；
- 复用共享 body Schema 和 record response Schema；
- 未知字段固定由 `assertOnlyAllowedBodyKeys` 返回 `400 AGENT_REQUEST_UNKNOWN_FIELD`；
- 缺字段、类型错误、原始空字符串、原始超过 1000 固定由 Schema 返回 400；
- 声明 400/404；
- 路由只负责解包，不重复业务校验。

完成后验证 `/api/openapi.json` 和 `/api/docs`。

### Web API 客户端

修改 `apps/web/src/shared/api/api.ts`：

- 导入共享请求 type；
- 增加 `updateAgentSessionTitle()`；
- 返回完整 record；
- 沿用 `toApiError()`。

不得让组件直接使用底层 `client.put`。

### Web Tab 与弹窗

修改 `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`：

- 导入编辑/设置图标和 API；
- Tab 标题后增加按钮；
- 仅真实 Session 展示；
- 使用可聚焦的 `a-button type="text"`，显式本地化 `aria-label`，Tooltip 不作为可访问名称；
- 支持 Enter/Space 键盘操作；
- 同时阻止 mousedown/click；
- 增加弹窗与表单状态；
- 打开时完整回填当前标题，不预先规范化、截断或替换；
- 显示永久接管说明；
- 前端规范化并做 1-50 校验；
- 不设置 DOM `maxlength`，避免超过 50/1000 的既有标题在程序化回填时静默截断；
- 显式校验原始输入不超过 1000；
- 字段计数和错误以规范化后的 JavaScript `string.length` 为准；
- API 提交规范化后的标题；
- 既有标题不合法时显示对应错误并禁用保存，用户编辑合法后才能提交；
- 当前标题合法时，即使规范化后与当前标题相同，也调用 API 完成手动接管；
- 保存中禁用；
- 成功后原位替换；
- 失败保留输入；
- Workspace 变化或组件卸载时关闭并清空弹窗目标、输入和错误。

注意当前 `visibleSessions` 使用稳定 Tab 编号排序：

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:218-234`

手动成功不得重建编号，也不得把 record prepend 后再 sort。

### i18n

修改：

- `apps/web/src/shared/i18n/locales/zh-CN.ts`
- `apps/web/src/shared/i18n/locales/en-US.ts`

文案必须表达“保存后永久停止自动更新”，不得使用暗示可恢复的“当前关闭自动更新”等措辞。必须分别增加：

- `AGENT_SESSION_TITLE_EMPTY` 对应字段错误；
- `AGENT_SESSION_TITLE_TOO_LONG` 对应字段错误；
- `AGENT_SESSION_TITLE_INVALID_CHARACTERS` 对应字段错误；
- 原始输入超过 1000 的前端预检错误；
- 设置按钮 `aria-label`/Tooltip 文案；
- 弹窗标题、输入提示和永久接管说明。

### 陈旧响应保护

改造 `refreshSessions()`：

- 增加 `workspaceGeneration` 和按 generation/workspace 标识的 active request token；
- 请求发出前捕获全局 title mutation revision；
- 保存成功后记录该 Session revision 和完整 API response record；
- 列表返回时按 ID 合并；
- 对请求开始后成功手动 mutation 的 Session，若远端仍包含该 Session，完整保留 API response record，不采用旧列表的任何字段；
- 远端缺失时不复活；
- 若本次列表使用过完整 record 保护，完成后去重调度一次 R2；
- R2 在 mutation 后开始并完整采用服务端权威 record；
- R2 失败时保留 API response record，释放自己的 loading，等待后续刷新重试；
- mutation 后开始的成功请求收敛后清理对应临时 record 缓存；
- 明确禁止将本地 title 与旧列表的 `headItemId/updatedAt` 等字段拼接；
- Workspace 改变时先递增 generation、清理旧 revision/UI 状态，并立即启动新 Workspace 请求；
- 旧 generation 请求不能被全局 `loadingSessions` 用来阻止新 generation 请求；
- 响应只在 generation 与 workspaceId 都匹配时写入；
- `finally` 只能清理自己的 active token；
- 旧 generation 的标题同步 retry baseline 必须丢弃；
- 新 generation 请求失败后必须清理 loading，使激活/显式刷新可以重试；
- 未受保护的其他 Session 仍按远端列表正常更新。

在 `onBeforeUnmount` 中：

- 设置 disposed 并递增 `workspaceGeneration`；
- 清空弹窗、mutation revision/record、retry baseline；
- 所有 refresh/title mutation 的 `then/catch/finally` 写状态前检查 disposed、generation 和自己的 token；
- 旧 Promise 的 `finally` 不得清理其他 token，也不得在卸载后调度 R2/重试。

为该合并逻辑优先抽取纯函数并单元测试，避免把复杂竞争判断全部留在 Vue 方法内。

不得只在响应处比较 `workspaceId` 而保留原全局 `loadingSessions` 短路逻辑；这无法闭合“旧请求占用 loading，新 Workspace 请求未发出”的问题。

### 测试和手工验收

先调整 workspace 测试脚本，确保新增测试被标准命令覆盖：

- `packages/shared/tests/` 中新增契约测试，现有 `tests/*.test.ts` 自动覆盖；
- `apps/api/package.json` 新增 `test:session-title`，列出本功能涉及的 schema/helper/application/writeback/integration 测试，并将 `test` 改为依次执行现有 `test:session-model` 与 `test:session-title`；
- `apps/web/package.json` 将新增 `src/features/workspace/tools/agent/agentSessionTitle.test.ts` 加入当前固定 `test` 文件清单；
- Web 中应把规范化、历史标题校验、完整 record 保护与 R2 调度、workspaceGeneration/disposed token/重试判断抽成纯函数，使标准 `npm test -w apps/web` 覆盖；
- 若无 Vue mount 测试设施，按钮实际事件和弹窗回填保留手工验收，但不得因此缺失上述纯函数自动化测试。

标准命令固定为：

```bash
npm run build -w packages/shared
npm test -w packages/shared
npm test -w apps/api
npm run test:integration -w apps/api
npm test -w apps/web
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run typecheck
npm run build
```

按 [05-verification-and-acceptance.md](./05-verification-and-acceptance.md) 执行：

- 契约；
- schema migration；
- Store；
- 应用层；
- 路由；
- lifecycle；
- writeback append/update；
- Web 组件/合并纯函数；
- primary/subtask/draft/Fork；
- 运行中修改；
- OpenAPI 和构建。

## 推荐提交/审查批次

虽然本任务不要求执行 Git 提交，但代码变更应按以下逻辑批次组织，便于审查：

- 数据库列、Store 原子方法及测试；
- 自动标题三条路径条件化及回归测试；
- 共享契约、应用层、Service、路由及 API 测试；
- Web API、Tab 弹窗、i18n；
- 陈旧响应保护与前端测试；
- 文档实施记录和最终验收证据。

不要把无关格式化、命名清理或大规模 Agent composition 重构混入。

## 兼容性

### 数据兼容

- 历史行默认 `0`，行为保持自动命名；
- 无需回填或推断历史标题来源；
- 不修改现有 title；
- 不清洗、截断或替换不符合新手动输入规则的历史标题；
- 不修改时间戳；
- 新列只被新版 API/自动更新 SQL使用。

### API 兼容

- 新增接口，不修改既有请求；
- `AgentSessionRecord` 响应不增加字段；
- Worker 内部协议不变；
- 旧 Web 客户端可继续工作，只是没有设置入口。

### 行为兼容

- 未手动接管的 Session 完全保持现有自动标题规则；
- 创建/Fork 初始标题规则不变；
- 手动接管后是新增行为；
- 手动 API 不改变 active run、head、context、model override 或 archive。

## 发布顺序

Monorepo 通常整体部署，建议：

- 先确保 schema 初始化会在 API 提供服务前完成；
- 构建共享包、API、Web；
- 启动 API，确认旧库迁移成功；
- 验证 OpenAPI；
- 再开放 Web 设置入口；
- 完成一轮运行中手动改名和 todolist 不覆盖验证。

如果前后端不能原子发布，先部署支持新接口和数据库列的后端，再部署 Web；反向顺序会导致按钮请求 404，不推荐。

## 回滚策略

### 回滚 Web

可直接回滚/隐藏设置入口：

- 已保存的手动锁仍留在数据库；
- 自动标题仍应尊重锁，只要后端未回滚；
- 用户暂时不能再次手动修改。

### 回滚 API 代码但保留数据库列

不安全：旧自动标题 SQL不检查标记，会重新覆盖已手动接管的标题。

因此后端回滚必须满足以下之一：

- 保留自动 SQL 的 manual 条件保护，只回滚公开 API/UI；
- 或在明确接受数据语义损失后才回滚到完全旧版本。

推荐设计为可独立保留的兼容补丁：即使关闭功能，自动更新仍读取 `title_manually_set`。

### 删除数据库列

不建议自动回滚删除：

- SQLite 删除列可能需要重建表；
- 删除会永久丢失哪些 Session 已被用户接管的信息；
- 旧代码忽略额外列，不需要删除。

若必须彻底回滚，应先备份数据库并明确告知：手动接管语义将丢失，后续自动事件可能覆盖标题。

## 停止条件与需升级讨论的情况

开发中遇到以下情况应暂停并更新设计，而非自行扩展：

- 现有 Session 删除/同步机制使陈旧响应策略不足；
- `updated_at` 在其他 Context 写回中有未记录的强业务不变量；
- subtask Tab 实际不允许任何元数据编辑且产品要求变化；
- SQLite 运行版本无法安全增加带约束列；
- 标题需要跨浏览器实时推送；
- 产品要求改为“保存相同标题不应接管”；
- 产品要求恢复自动命名；
- 标题长度需要按可见字素或数据库字符计算。

这些都属于产品合同变化或范围扩大，必须先修订文档。
