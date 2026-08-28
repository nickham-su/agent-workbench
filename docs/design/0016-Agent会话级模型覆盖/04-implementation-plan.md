# 开发任务拆分与详细实施步骤

## 实施原则

- 固定采用“服务端持久化 + 新 Run 快照”方案，不做前端临时覆盖；
- 每个批次先增加或更新测试，再修改生产逻辑；
- 优先小步、可回滚改动；
- 不删除全局 Agent 设置 API；
- 不改消息请求为前端传 provider/model；
- 不扩大到 vision/compaction override、Fork/Subtask 继承或运行中切换；
- 发现代码与 [01-overview.md](./01-overview.md) 的暂停条件冲突时停止实现并更新设计；
- 不处理工作区无关变更。

## 固定依赖顺序

```text
基线复核
  → Shared 契约
  → SQLite 表与 Store
  → Session 模型领域服务
  → 公共 API
  → 新 Run profile 解析
  → Web API 与状态层
  → 模型标签与弹窗交互
  → 草稿 Session pending intent
  → 自动测试与手工验收
  → 独立代码审查
  → 修复
  → 独立复审
```

## 批次一：基线复核

### 任务

- 复核 [06-code-reference.md](./06-code-reference.md) 中路径、函数和行号；
- 全仓枚举所有生产 `createRunRecord()` / `startUserRun()` 调用；
- 确认普通消息、手动压缩、Subtask 和 Worker 恢复的模型来源；
- 复核 SQLite 外键已启用，`ON DELETE CASCADE` 在测试环境生效；
- 复核 Session 路由的 workspace 归属错误习惯；
- 复核 available agents API 的 enablement/scope 校验可复用范围；
- 复核当前 API 与 Web 的测试脚本；
- 记录修改前基线：相关测试、typecheck、build。

### 产物

- 已确认的新 Run 入口清单；
- Profile reader 端口影响清单；
- 数据库初始化与级联证据；
- 错误码复用清单；
- 更新后的代码地图。

### 完成条件

- 没有遗漏会为 Primary Session 创建主模型 Run 的入口；
- 能明确说明手动/自动压缩的主模型与摘要模型差异；
- 能证明 Worker 对已有 Run 使用快照；
- 没有修改生产代码。

## 批次二：Shared 契约

### 目标文件

```text
packages/shared/src/contracts/agent.ts
packages/shared/src/contracts/settings.ts（仅在来源枚举确有共享需求时）
相关 shared/API contract tests
```

### 实施步骤

- 增加 Session model source/status/ref/effective/override/state schema；
- 增加 GET response、PUT request、workspace query schema；
- 保持 `additionalProperties: false`；
- 时间戳使用正数约束；
- 导出静态 TypeScript 类型；
- 不修改 `AgentSendMessageRequestSchema` 增加 provider/model；
- 不复用只允许 `agent_default` 的旧 source schema；
- 增加合法/非法结构测试；
- 运行 shared build/typecheck。

### 测试要点

- ready 必须有 effectiveModel；
- override/source 不变量；
- invalid/missing reasonCode；
- 空 ID 和额外字段被拒绝；
- GET、PUT、DELETE 响应 schema 可序列化完整状态；
- 不泄漏 Provider options/API key。

### 完成门禁

- Shared 运行时 schema 与 TypeScript 类型一致；
- 消息请求契约未扩大；
- 产品状态矩阵可直接由契约表达。

## 批次三：SQLite 表与 Store

### 目标文件

```text
apps/api/src/infra/db/schema.ts
apps/api/src/modules/agent/agent.store.ts
或新建的 session-model-override store 文件
相关 schema/store tests
```

### 实施步骤

- 新增 `agent_session_agent_model_override` 表；
- 新增 Agent ID 辅助索引；
- 确认主键顺序支持按 Session 查询；
- 实现 get/list/upsert/delete；
- 使用参数化 SQL；
- `updatedAt` 从服务端时钟输入；
- 验证 `ON DELETE CASCADE`；
- 验证重复 PUT 更新而非新增；
- 验证不同 Session/Agent 组合隔离；
- 不保存 workspace、名称、上下文窗口、Provider 凭据等派生/敏感字段。

### Store 测试

- 空列表；
- 单条和多 Agent 列表；
- 同键 UPSERT；
- 同 Session 不同 Agent；
- 不同 Session 同 Agent；
- DELETE 存在/不存在；
- Session 删除级联；
- `updatedAt` 更新；
- SQL 注入字符按普通 ID 参数处理。

### 完成门禁

- 数据库唯一性和级联由自动测试证明；
- 旧数据库初始化路径可自动建表；
- 无破坏性迁移。

## 批次四：Session 模型领域服务

### 建议目标文件

```text
apps/api/src/modules/agent/session/session-agent-model-application.ts
apps/api/src/modules/agent/session/session-agent-model-ports.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/settings/settings.service.ts
相关 unit tests
```

具体命名可遵循现有模块分层，但职责必须独立清晰。

### 实施步骤

- 定义读/写端口和领域 DTO；
- 实现 Session 加载与 workspace 校验；
- 实现 Primary-only 编辑检查；
- 复用或提取 Agent scope/enablement 解析；
- 查询 `(sessionId, resolvedAgentId)` override；
- 将模型候选改为完整 pair，防止 provider/model 混层；
- 实现 read-state 投影：单项 invalid 不抛整个 GET；
- 实现 PUT：先校验 ready，再 UPSERT；
- 实现 DELETE：幂等删除，允许清理 stale override；
- 对 orphan/invalid override 返回稳定状态；
- 不自动删除、不自动回退。

### 决策门禁

代码审查必须检查：

- `resolveExecutionProfile()` 是否仍分别拼接 providerId/modelId；如是则不通过；
- Run snapshot 是否绝对优先；
- Session override 是否只在新 Run 解析输入中出现；
- vision/compaction 解析是否保持现状；
- read-state 与 create-run 是否复用相同核心校验。

### 单元测试

- 无覆盖 → 默认；
- 覆盖 → 覆盖；
- 覆盖失效 → invalid/创建 Run 抛错，不回退；
- 默认失效 → missing/invalid；
- 有效覆盖 + 失效默认 → 覆盖可运行；
- DELETE 后按当前默认投影；
- Agent 禁用/scope 不允许；
- Provider/Model/API key 失效；
- Run snapshot > override > default；
- 半对 snapshot/override 不与下层混合。

## 批次五：公共 API

### 目标文件

```text
apps/api/src/modules/agent/routes/agent-public.routes.ts
apps/api/src/modules/agent/agent.service.ts 或对应 façade
apps/api/src/modules/agent/agent.composition.ts
apps/web/src/shared/api/api.ts（后续批次可一起）
API route/integration tests
```

### 实施步骤

- 注册 GET/PUT/DELETE 路由；
- 使用 Shared params/query/body/response schema；
- 路由仅做解析与委派，不内联 SQL 或模型选择；
- GET 按 Session 返回状态集合；
- PUT/DELETE 返回操作后状态；
- DELETE 不返回 204；
- Session 不属于 workspace 时遵循现有防泄漏策略；
- 增加稳定错误码与 i18n 可映射消息；
- 对 GET 的 orphan override 进行可控诊断，不刷屏。

### API 集成测试

- 正常 GET/PUT/DELETE；
- PUT 不修改 `/settings/agent/agents` 返回的 defaultModel；
- Session A/B 隔离；
- Agent A/B 隔离；
- 跨 Workspace 拒绝；
- Subtask 拒绝；
- PUT invalid provider/model/key 拒绝且不落库；
- DELETE stale override 成功；
- DELETE 不存在幂等；
- 响应 schema 不含敏感配置；
- 全局默认变化后的 GET 状态正确。

### 完成门禁

- 仅通过公共 API 即可完整支持刷新、保存和重置；
- API 不依赖浏览器 localStorage；
- 工具 Tab 无需调用 Settings 更新接口。

## 批次六：新 Run 模型解析

### 普通消息

目标文件：

```text
apps/api/src/modules/agent/session/session-interaction-application.ts
apps/api/src/modules/agent/agent.composition.ts
apps/api/src/modules/agent/lifecycle/run-lifecycle-application.ts（若端口类型受影响）
```

步骤：

- 给 `profileReader.resolveUser` 增加 `sessionId`；
- `sendMessage()` 传当前真实 Session ID；
- 解析 Session override/default；
- 把最终 profile 传给 `startUserRun()`；
- 保持消息 body 不含模型字段；
- 保持 `createRunRecord()` 快照写入。

### 手动压缩

目标文件：

```text
apps/api/src/modules/agent/compaction/manual-compaction-application.ts
apps/api/src/modules/agent/agent.composition.ts
```

步骤：

- 给手动压缩 `resolveProfile` 增加 `sessionId`；
- 使用 Session 主模型解析 Run snapshot；
- 不修改 `runtime.compactionModel`；
- 验证 Worker `selectCompactionModel()` 仍按现有规则选择摘要模型。

### Subtask 与已有 Run

- 明确保留 Subtask 全局默认解析；
- 不向 Subtask resolver 传 parent Session override；
- Worker execution profile 只用 Run snapshot；
- 修正任何把 Run 来源固定标为 `agent_default` 的诊断字段；
- 不改变 worker API 协议中的实际 provider/model 结构，除非来源字段契约需要扩展。

### 集成测试

- 保存前 Run 使用旧/默认快照；
- 保存后新普通 Run 使用覆盖；
- 重置后新普通 Run 使用当前默认；
- 保存后手动压缩 Run 主快照使用覆盖；
- 配置了 runtime compaction model 时摘要候选仍是 runtime 模型；
- 未配置时回退 Run 主模型；
- 修改覆盖不改变已有 Run 的 execution profile；
- Fork 新 Session 使用默认；
- Subtask 使用其 Agent 全局默认，不继承父覆盖。

### 完成门禁

- 数据库断言可直接证明每个新 Run 的 provider/model；
- Worker profile 断言可证明已有 Run 不重算 Session 配置；
- 压缩独立边界有自动测试。

## 批次七：Web API 与 Session 模型状态层

### 目标文件

```text
apps/web/src/shared/api/api.ts
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
可选新增 useAgentSessionModelOverrides.ts
相关 Web tests
```

### 实施步骤

- 增加 GET/PUT/DELETE API 封装；
- 建立 `sessionId → agentId → state` 缓存；
- 为 pending GET 去重；
- 在 Session 激活/可见时加载；
- PUT/DELETE 用返回状态原子更新缓存；
- 全局 Agent settings 更新通知后刷新相关 Session states；
- Session 删除/关闭时清理内存缓存；
- 不写 localStorage；
- 保持 `selectedAgentBySession` 现有 localStorage 恢复。

### 完成门禁

- 刷新后覆盖来自 API；
- 切换 Session/Agent 不串状态；
- GET 失败时不把全局 resolvedModel 冒充最终有效模型。

## 批次八：模型标签与弹窗

### 目标文件

```text
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
i18n locale 文件
Web component tests
```

### 实施步骤

- 模型标签改读 Session state；
- 展示来源；
- 修改弹窗作用域说明；
- 用 effectiveModel 初始化选择器；
- 保存调用 PUT，不再调用 `updateAgentSettings()`；
- 增加“重置为默认模型”并调用 DELETE；
- 无覆盖时禁用重置；
- loading/saving/resetting 时禁用操作；
- 暴露当前 Session 配置提交中状态给发送逻辑；
- 保存/重置期间阻止按钮和回车发送；
- 错误时保留旧 effective state；
- 成功提示使用“当前会话”文案；
- 更新 tooltip、来源、不可用和错误 i18n。

### 禁止

- 不再在该弹窗组装完整 `UpdateAgentSettingsRequest`；
- 不触发全局 `agent-settings-updated` 作为保存覆盖的唯一刷新机制；
- 不直接改写所有 Session 共用的 `agentOptions.resolvedModel`；
- 不用前端选择值作为下一条消息 body 模型字段。

### 完成门禁

- UI 标签、弹窗状态和新 Run 数据三者一致；
- 重置后立即显示当前全局默认；
- Session A 的操作不刷新成 Session B 的模型。

## 批次九：草稿 Session pending intent

### 目标文件

```text
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
相关 Web tests
```

### 实施步骤

- 在点击模型入口时判断 `sessionReady`；
- 记录 `{ draftSessionId, agentId, action: openModelModal }`；
- 调用 `ensureSessionCreated()`；
- 使用返回的真实 ID；
- 确认选中 Agent 迁移已完成；
- 若 Pane 重建，在父组件保存真实 ID pending intent；
- 新 Pane 挂载后消费一次并清理；
- 加载真实 Session state，再开弹窗；
- 失败清理 intent 并提示；
- 防止双击打开两个弹窗/创建两个 Session。

### 测试

- 草稿点击后只创建一个真实 Session；
- 真实 ID 用于 GET/PUT；
- 不请求 `draft_*` API；
- 创建失败不打开弹窗；
- 创建成功后取消，Session 保留；
- Agent 选择正确迁移；
- pending intent 只消费一次。

## 批次十：回归、验收与发布门禁

### 自动化命令

实施者应根据仓库实际 scripts 运行并记录：

```text
shared typecheck/build
API typecheck/build
API agent/settings/schema/integration tests
Web typecheck/build
Web AgentToolView/AgentClientPane component tests
Worker profile/compaction tests
```

不得只运行全局 build 而不执行业务测试。

### 手工验收

按 [05-validation-checklist.md](./05-validation-checklist.md) 逐项记录：

- 操作步骤；
- Session/Agent/模型；
- UI 截图或录屏；
- API 请求/响应；
- `agent_run` 数据库证据；
- 全局设置未变化证据；
- 失效场景错误证据。

### 独立审查流程

```text
实现完成
  → 独立代码审查
  → 分类阻断/重要/建议问题
  → 修复阻断与重要问题
  → 重跑受影响测试和回归
  → 独立复审
  → 审查通过后验收
```

## 任务清单与依赖

| 任务 | 依赖 | 主要产物 |
|---|---|---|
| Shared 契约 | 基线 | schema/types/tests |
| DB 与 Store | 基线 | table/CRUD/tests |
| 领域服务 | Shared + Store | resolve/state/write logic |
| API 路由 | 领域服务 | GET/PUT/DELETE |
| 普通 Run 接入 | 领域服务 | new Run snapshot |
| 手动压缩接入 | 领域服务 | main profile snapshot |
| Web API/缓存 | API | refresh state |
| 弹窗/标签 | Web 缓存 | save/reset/display |
| 草稿 intent | 弹窗 + existing ensureSession | real Session flow |
| 测试验收 | 全部 | evidence |

## 回滚策略

如果上线后需要回滚：

- Web 可回滚为隐藏/禁用 Session 模型编辑，但不得恢复工具 Tab 修改全局模型的危险行为；
- API 可暂时保留新端点与新表，即使旧 Web 不调用；
- 新 Run resolver 回滚后无覆盖 Session 行为不变，有覆盖记录暂时不生效但数据保留；
- 不 drop 新表，不删除用户覆盖数据；
- 回滚期间必须在 UI 说明会话覆盖暂不可编辑/不生效，避免静默错配；
- 修复后恢复 resolver 并重新校验所有覆盖可用性。

## 开发完成记录模板

实施 PR 应附：

```text
实现批次：
修改文件：
数据库变更：
API 契约：
Run 解析入口：
明确未改范围：vision / compaction / fork / subtask / running run / selectedAgentId
自动测试：
手工验收：
独立审查结论：
已知限制：首版多窗口 last-write-wins
回滚说明：
```
