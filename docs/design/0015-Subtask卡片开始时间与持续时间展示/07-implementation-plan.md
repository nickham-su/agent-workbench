# 开发任务拆分与详细实施步骤

## 全局节奏

固定实施顺序：

```text
基线复核
  → Shared 契约与契约测试
  → Store 批量查询
  → Query 统一投影
  → API 集成与 existing 证据
  → Web 纯 helper 与映射
  → 卡片模板/i18n/刷新一致性
  → 全量回归与手工验收
  → 独立代码审查
  → 修复
  → 独立复审
```

原则：

- 每批开始前复核 [02-product-contract.md](./02-product-contract.md)、[03-decisions.md](./03-decisions.md) 和 [05-code-map.md](./05-code-map.md)；
- 每批只修改授权文件与必要测试；
- 先建立失败测试，再改生产逻辑；
- 发现代码与设计前提不一致时暂停，更新文档并重新评审；
- 不执行数据库迁移；
- 不增加前端逐卡片请求；
- 不把测试通过替代独立代码审查；
- 工作区发现无关修改时视为用户修改，不覆盖、不恢复。

## 基线复核与暂停条件检查

### 任务

- 复核 `agent_run` 表字段和 parent tool unique index；
- 全仓搜索 `agent_run` 的所有 UPDATE，确认终态后没有正常更新旁路；
- 复核 child activation 写入 parentRunId、parentToolItemId、createdAt；
- 复核 `findSubtaskRunByParentTool()` 查询条件；
- 复核 `ContextQueryApplication` 的所有列表/单项入口；
- 复核 Fastify response schema 会序列化新增 optional 字段；
- 复核 `AgentSessionContextItemsTailResponseSchema` 与 internal tail route/消费者；
- 复核 Web full/tail/before/after/single refresh 链；
- 冻结 public `tailLimit/limit=500`、internal tail `500`、Web `100/100`、Store guard `1000` 的分层口径；
- 复核 `hasItemChanged()` 当前比较范围；
- 复核现有 i18n 与 test scripts；
- 验证运行环境 SQLite JSON1；若不可用，确定安全分块策略；
- 记录相关测试基线。

### 产物

- 更新后的代码行号；
- run 写路径清单；
- 批量查询技术选择；
- 基线测试结果；
- 未命中暂停条件的书面确认。

### 完成条件

- 能证明终态 `updatedAt` 可作为当前近似结束时间；
- 能证明 parent key 唯一性；
- 能说明唯一性异常时固定 fail-open合同、诊断码和发布门禁；
- 能解释 existing 模式为何不能使用 session lastRun；
- 能说明单项投影为何不可省略；
- 没有修改生产代码。

## Shared 契约与契约测试

### 任务文件

```text
packages/shared/src/contracts/agent.ts
packages/shared/tests/... 或 apps/api/src/modules/agent/context-item-contract.test.ts
```

### 实施步骤

- 增加 child terminal status schema；
- 增加 `AgentSubtaskRunSummarySchema` 可判别联合；
- `startedAt` 和 terminal `endedAt` 使用 `exclusiveMinimum: 0`；
- 导出静态 TypeScript 类型；
- 在 `AgentContextItemRecordSchema` 增加 optional `subtaskRun`；
- 保持非 subtask/旧响应缺失字段合法；
- 增加 running/terminal 合法矩阵；
- 增加非法字段组合拒绝测试；
- 验证 public 列表、public 单项和 internal tail response schema 都接受并输出字段；
- 验证 internal tail 现有消费者兼容；
- 执行 shared build/typecheck。

### 禁止

- 不增加 `createdAt/updatedAt` 的第二套 child 字段；
- 不将 `subtaskRun` 设为所有 item 必填；
- 不用 `Type.Any()`；
- 不把 queued/streaming/idle 纳入 child run status；
- 不同时定义 omitted 和 null 两种摘要缺失方式。

### 完成条件

- 编译期能按 status 缩窄 running/terminal；
- 运行时 schema 与产品矩阵一致；
- 旧 context item 仍通过契约。

## Store 批量 child run 查询

### 任务文件

```text
apps/api/src/modules/agent/agent.store.ts
apps/api/src/modules/agent/query/context-query-ports.ts
apps/api/src/modules/agent/query/sqlite-query-stores.ts
相关 store/query test
```

### 实施步骤

- 定义 query 侧 `SubtaskParentKey` 与最小 `SubtaskRunProjectionRecord`；
- 新增批量 store 函数；
- 实现输入校验、去重和空输入短路；`parentRunId.trim()` 只用于拒绝全空白值；
- 去重 key 与 SQL/JSON 查询参数必须使用 `item.runId` 原值，不得使用 trim 后的值；
- 采用基线复核阶段冻结的 JSON1 或受限分块参数化 SQL；
- 始终按 workspace 过滤；
- 只返回 runId、parent fields、status、times；
- 保留重复结果供 application 分组，不在 store 静默覆盖；
- 扩展 `ContextQueryStore`；
- 在 SQLite adapter 中转发；
- 增加单键、多键、部分命中、跨 workspace、重复输入测试；
- 增加 500 keys 与 full/after 超过 1000 keys 测试；
- 记录查询次数证据。

### 禁止

- 不在循环里调用 `findSubtaskRunByParentTool()`；
- 不动态拼接未转义 runId；
- 不按 sessionId 查询；
- 不以 `updated_at desc limit 1` 选 run；
- 不修改 parent tool unique index；
- 不修改 subtask application 的幂等查询。

### 完成条件

- JSON1 方案对非空 key 集合使用一次查询；
- 分块方案查询次数精确等于 `ceil(uniqueParentKeys / batchSize)`；
- 精确 parent key 和 workspace 隔离有测试；
- 现有 lineage/reuse 回归通过。

## 统一 API Read-side 投影

### 任务文件

```text
apps/api/src/modules/agent/query/context-query-application.ts
可选的相邻 projector 模块
apps/api/src/modules/agent/query/context-query-application.test.ts
```

### 实施步骤

- 实现 `toParentKey()`；
- 实现 `toSubtaskRunSummary()`；
- 实现批量 `enrichSubtaskRuns()`；
- 按 parent key 分组并实现冲突 fail-open；
- 扩展 logger error 或等价 diagnostics port，固定诊断码并按请求/key 去重；
- 覆盖 running/terminal/null/非法时间；
- duration 使用 `Math.max(0, ...)`；
- 在 `getContextItems()` 所有 window 路径统一调用；
- 在 `getContextItem()` 复用同一入口；
- 确认 artifact read 对非 subtask item 无额外查询或副作用；
- 增加 store 调用次数和 items 顺序测试；
- 验证无 subtask item 时不调用批量 store。
- 用 mock store 返回重复 records，验证冲突 item 省略、其他 item 正常、单次 error、接口不抛。

### 禁止

- 不在 route handler 重复拼投影；
- 不修改 transcript 持久化 mapper写入派生字段；
- 不因单个 child 缺失让整个响应失败；
- 不使用 parent item createdAt/updatedAt；
- 不解析 tool output 文本找 run。

### 完成条件

- 列表和单项同一 item 摘要一致；
- 非 subtask item结构无回归；
- 缺失/旧数据安全省略。

## API 集成、状态与 existing 证据

### 任务文件

优先从以下测试按职责扩展：

```text
apps/api/src/modules/agent/context-item-contract.test.ts
apps/api/src/modules/agent/integration/agent-read-context.integration.test.ts
apps/api/src/modules/agent/integration/agent-subtask-lineage.integration.test.ts
apps/api/src/modules/agent/integration/agent-subtask-routes.integration.test.ts
apps/api/src/modules/agent/integration/agent-run-cancel.integration.test.ts
apps/api/src/modules/agent/integration/agent-startup-recovery.integration.test.ts
```

### 实施步骤

- 建立真实 parent tool + child run fixture；
- 验证 running list/single；
- 提交 completed，验证 duration；
- 提交 failed/cancelled，验证 duration；
- 验证 terminal 后重复 complete 不改变摘要；
- 验证 tail/before/after；
- 验证 internal context-items-tail 正常摘要与 schema 序列化；
- 构造 existing 同 session 的 R1/R2，验证各卡片绑定各 run；
- 构造 `runId=null` copied item，验证不追溯；
- 构造 parent key missing child，验证响应成功且省略；
- 验证 response serializer 保留字段；
- 验证 public/internal 请求参数 500 上限，不与 Store 1000 guard 混用；
- 运行相关 cancel/recovery/subtask 回归。

### 审查重点

- existing fixture 必须真的是同一 child session 的两个 runs，不得用两个 session 伪代；
- 卡片关联断言必须检查 `runId` 和时间，不只检查字段存在；
- 测试不得通过手工在 response 中塞摘要绕开 store/query 链路。

### 完成条件

- 产品矩阵的 API 层证据完整；
- existing、copied item 和单项一致性为自动测试；
- 没有修改 run lifecycle 生产代码。

## Web 纯 helper、类型与变化检测

### 任务文件

```text
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
建议新增 apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.ts
建议新增 apps/web/src/features/workspace/tools/agent/subtaskRunDisplay.test.ts
apps/web/package.json（仅测试列表需要）
```

### 实施步骤

- 从 shared 导入 `AgentSubtaskRunSummary`；
- 抽取/实现开始时间格式化；
- 复用或抽取 duration formatter，保持 header 输出；
- 实现 effective status helper；
- 为 helper 增加稳定时区测试 seam；
- 扩展 `DisplayItem`；
- subtask mapping 只透传 `item.subtaskRun`；
- `hasItemChanged()` 比较 `subtaskRun`；
- 增加 running/terminal/fallback/非法值测试；
- 将新 test 加入 Web 显式 test script；
- 运行 Web tests/typecheck。

### 禁止

- 不在 Web 计算 terminal duration；
- 不从 parent createdAt/updatedAt构造；
- 不用 child session run-state；
- 不增加每卡片 timer；
- 不引入大型组件测试框架；
- 不改变现有 Session ID 解析优先级。

### 完成条件

- 所有展示决策有纯函数测试；
- child summary 更新能被变化检测识别；
- header elapsed 无回归。

## 卡片模板与 i18n

### 任务文件

```text
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
apps/web/src/shared/i18n/locales/zh-CN.ts
apps/web/src/shared/i18n/locales/en-US.ts
```

### 实施步骤

- 添加中文“开始时间/持续时间”；
- 添加英文“Started/Duration”；
- 在 Agent/模式与 Session ID 之间增加时间行；
- 摘要缺失时整行不渲染；
- running 只显示开始时间；
- terminal 显示开始时间和持续时间；
- icon、spin、class 使用同一 effective status；
- 保持 parent error 文本和 tone；
- 使用 flex-wrap 支持窄宽度；
- 验证卡片 click 与复制按钮事件不受影响；
- 运行 Web build。

### 完成条件

- 产品示例与实际布局一致；
- 中文/英文无 key 泄漏；
- 所有状态图标正确；
- 缺失摘要没有虚假占位。

## 刷新一致性、性能与回归

### 实施步骤

- 真实运行一个耗时 subtask，观察无摘要 → running 摘要 → terminal 摘要；
- 在 running 阶段刷新浏览器；
- 验证单项轮询不会丢 startedAt；
- 验证 settle poll 后 duration 出现；
- 验证 completed/failed/cancelled；
- 验证 existing 两次复用；
- 验证较早历史分页；
- 验证 fork copied item；
- 用 API query spy/trace 记录 0/1/多卡片查询次数；
- JSON1 验证 0/1 次；分块方案验证 `ceil(keys/batchSize)`；
- 覆盖 Web 100、public/internal 500、full/after 超过 1000 keys；
- 用浏览器网络面板确认无 per-card 请求；
- 验证 Web 100 条 tail/page、public/internal 500，以及 full/after 大集合；
- 回归其他 rich tool cards、header timer、点击/复制；
- 执行 [06-testing-acceptance.md](./06-testing-acceptance.md) 中自动命令；
- 记录实际命令、结果和手工证据。

### 暂停条件

如果 child terminal 不能通过现有刷新链到达卡片，停止并评审刷新方案。不得未经设计引入永久 per-card polling 或 timer。

### 完成条件

- 功能、兼容、性能和回归证据齐全；
- 没有已知阻断问题；
- 准备好独立审查材料。

## 独立代码审查

### 审查输入

必须提供：

- 本目录全部设计文档；
- 代码 diff；
- 测试变更；
- 实际执行命令与结果；
- 查询次数证据；
- existing/cancelled/copied item 手工或自动证据；
- 已知限制清单。

### 审查者要求

- 审查者不得是主要实现者；
- 必须独立按 [06-testing-acceptance.md](./06-testing-acceptance.md) 清单核对；
- 必须重点追踪数据从 parent item 到 child run 的关联，而不是只看 UI；
- 必须检查 SQL 是否 N+1、是否 workspace 隔离；
- 必须检查列表/单项序列化；
- 必须检查 internal tail schema、route 与消费者；
- 必须检查 existing 测试真实性；
- 必须检查冲突 fail-open 不存在任选/fail-close/静默覆盖；
- 必须检查固定诊断码、每请求每 key 一次 error 与发布门禁；
- 必须检查终态 `updatedAt` 假设未被新写路径破坏。

### 审查结果

只允许：

- 通过；
- 有条件不通过，列出必须修复项；
- 不通过，指出设计前提失效。

不得用“建议以后优化”掩盖本期阻断项。

## 修复与独立复审

### 修复原则

- 每个审查问题必须有处理结论；
- 合理问题必须修复并补测试；
- 如果审查意见要求越过本文冻结边界，实现者不得擅自采纳，必须更新设计并获得重新评审；
- 修复不得引入逐卡片请求、数据库字段或 session lastRun 猜测；
- 修复后重新运行受影响测试和必要全量回归。

### 复审要求

独立复审必须确认：

- 原问题已实际修复；
- 新增测试能在旧实现上失败；
- 没有引入范围外回归；
- 文档与最终代码一致；
- 所有阻断项关闭。

只有复审通过才可进入发布验收。

## 任务依赖关系

```text
基线复核
  → Shared 契约
  → Store 批量查询
  → API 投影与集成证据
  → Web helper、模板与 i18n
  → 刷新/性能/回归
  → 独立审查
  → 修复与独立复审
```

Shared 契约与 Store 查询的测试设施准备可部分并行，但生产投影必须等待契约与 store port 稳定。Web helper 可以在 Shared 契约冻结后开始，但最终联调必须等待 API 投影与集成证据稳定。

## 每批提交/审查粒度建议

为了可回滚和易审查，建议按以下逻辑批次组织 diff：

- Shared schema + contract tests；
- Store batch query + store tests；
- Query projector + query tests；
- API integration tests；
- Web pure helper + tests；
- Web template + i18n；
- 审查修复。

不得把无关格式化、AgentClientPane 大范围重排或 run lifecycle 重构混入。

## 发布前完成记录

实施完成后建议在本目录新增 `08-implementation-record.md`，记录：

- 实际改动文件；
- 与设计不同之处及批准原因；
- 测试命令和结果；
- 查询次数/性能证据；
- 独立审查问题与修复；
- 独立复审结论；
- 最终验收截图/场景；
- 已知限制和后续项。

该记录不是本次设计编写的必要文件，但属于正式发布的推荐交付物。

## 最终停止条件

在任何阶段发现以下情况，必须停止继续编码：

- 需要使用 parent item 时间才能显示；
- 需要使用 child session lastRun 才能关联；
- 需要修改数据库 schema；
- 需要修改 run lifecycle 才能冻结 `updatedAt`；
- 批量查询不可用，只能 N+1；
- 无法实现重复 key 的固定 fail-open/诊断合同；
- 测试、预发布或灰度出现 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；
- internal tail 影响无法验证；
- 现有刷新链无法到达终态且替代方案未评审；
- existing/copy 边界无法自动验证；
- 独立审查认为 run 时间语义前提不成立。

停止后先更新设计与决策，不得以“先做出来再说”继续。
