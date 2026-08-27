# 测试、代码审查与验收标准

## 测试原则

- 先验证关联正确性，再验证时间公式和 UI；
- running 与 terminal 必须分别测试，不能只测 completed；
- existing 多次复用是阻断级场景；
- 列表、分页、增量和单项必须覆盖一致性；
- 测试不得依赖真实长时间等待；
- 开始时间格式测试不得依赖 CI 机器默认时区；
- 不以截图手工验收替代契约和 API 自动测试；
- 不以 typecheck/build 替代业务断言；
- 不为了测试修改 run lifecycle 生产语义。

## Shared 契约测试

### 合法结构

必须接受：

- running：`endedAt = null`、`durationMs = null`；
- completed：number/number；
- failed：number/number；
- cancelled：number/number；
- `durationMs = 0`；
- `startedAt > 0`；
- terminal `endedAt > 0`；
- context item 缺少 `subtaskRun`；
- 非 subtask item 缺少 `subtaskRun`。

### 非法结构

必须拒绝或通过应用层测试证明不会生成：

- running + number `endedAt`；
- running + number `durationMs`；
- terminal + null `endedAt`；
- terminal + null `durationMs`；
- 负 `durationMs`；
- `startedAt = 0` 或负数；
- terminal `endedAt = 0` 或负数；
- 未知 status；
- 空 runId；
- 额外未声明字段（若 schema 使用 `additionalProperties: false`）。

同时必须验证以下三个响应 schema 的影响：

- public `AgentContextItemsResponseSchema`；
- public `AgentContextItemRecordSchema`；
- internal `AgentSessionContextItemsTailResponseSchema`。

## API Store 测试

### 批量查询正确性

必须覆盖：

- 空 parent keys 不执行 SQL并返回空；
- 单键命中；
- 多键命中；
- 部分命中；
- 输入重复 key 去重；
- 不同 workspace 相同 parent key 不越权命中；
- parentRunId 相同、parentToolItemId 不同正确区分；
- parentToolItemId 相同、parentRunId 不同正确区分；
- 结果保留 running/completed/failed/cancelled 与时间；
- public/internal 上限规模 500 keys 正常；
- full/after 超过 1000 unique keys 仍通过 JSON1 或分块安全工作；
- JSON1 查询次数为 1；分块次数精确为 `ceil(uniqueParentKeys / batchSize)`；
- 查询次数不等于 subtask 卡片数量。

### 唯一性

必须覆盖或复用现有集成证据：

- 同一 `(parentRunId, parentToolItemId)` 无法创建两个 child runs；
- 批量投影收到重复结果时不静默覆盖。

重复结果使用 mock/fake store 构造，必须精确断言唯一 fail-open 合同：

- 冲突 item 省略 `subtaskRun`；
- 同响应其他 items 正常投影；
- application 不抛错，public list/single/internal tail 维持成功语义；
- 不选择任何 run；
- 每请求每冲突 key 只调用一次 `logger.error`；
- `diagnosticCode` 精确等于 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；
- bindings 包含 parent key、排序 runIds、matchCount，不含 item output；
- 两个不同冲突 keys 各记录一次；分块返回同 key 时仍只记录一次。

## API Projector 单元测试

### item 识别

| 输入 | 预期 |
|---|---|
| `tool/subtask` + valid runId | 查询并可投影 |
| `tool/subtask` + `runId=null` | 不查询/不投影 |
| 其他 tool | 不查询/不投影 |
| assistant/user/system | 不查询/不投影 |
| 非法 item id | 不投影 |

### summary 生成

必须覆盖：

- running：startedAt 来自 createdAt，endedAt/durationMs 为 null；
- completed：duration 正确；
- failed：duration 正确；
- cancelled：duration 正确；
- `updatedAt < createdAt`：duration 为 0；
- `updatedAt = createdAt`：duration 为 0；
- 非有限/非正 startedAt：省略；
- terminal 非有限/非正 endedAt：省略；
- running 的 updatedAt 再新也不进入摘要；
- 任何摘要都不使用 parent item createdAt/updatedAt。

### 批量调用

`getContextItems()` 一页中有多张 subtask 卡片时：

- store 批量方法只调用一次或固定分块次数；
- 所有 parent keys 一次传入；
- 返回 items 顺序与原 transcript 一致；
- 非 subtask item 对象内容不改变；
- 没有 subtask parent key 时不调用 store。

## API 接口/集成测试

### 查询容量基线

必须断言并在审查中区分：

- public `tailLimit/limit` 接受 500、拒绝超过 500；
- internal tail 接受 500、拒绝超过 500；
- Web helper/常量仍使用 tail 100、page 100；
- Store 1000 clamp 不被测试或文档误当成 API 上限；
- full/after 大响应测试不因 500/1000 假设截断 child parent keys。

### 列表路径

分别验证：

- tail load；
- `beforeId`；
- `afterId`；
- full transcript（若公开/测试入口仍保留）；
- response schema 不剥离 `subtaskRun`。
- internal `context-items-tail` 正常摘要不被 schema 剥离。

每种路径至少断言一张可关联卡片；可以通过 table-driven 或共享 fixture 避免重复测试代码。

### 单项路径

`GET /context-items/:itemId` 必须：

- running 时返回 running summary；
- child terminal 后再次读取返回 terminal summary；
- 无关联时省略；
- 与列表同一 item 的摘要完全一致。

### existing 多次复用

这是发布阻断测试。构造：

```text
父 tool A → child session S → run R1(created1, ended1)
父 tool B → child session S → run R2(created2, ended2)
```

断言：

- A.subtaskRun.runId = R1；
- B.subtaskRun.runId = R2；
- A 的时间不随 R2 成为 session lastRun 而变化；
- 两张卡片可以有相同 `subtaskSessionId`；
- API 没有调用 session latest run 逻辑生成摘要。

### 旧历史与 copied item

必须覆盖：

- parent item `runId = null`；
- parent key 指向不存在的 child；
- fork copied subtask item；
- 返回成功且省略摘要；
- 不抛 404/500；
- 不按 output result/text/session ID 猜测。

### 状态路径

必须覆盖：

- 正常 completed；
- worker failed；
- user/system cancelled；
- startup recovery failed（可复用相关 fixture 或 projector 测试，至少一处集成证据）；
- 终态后重复完成回调不改变卡片 endedAt/durationMs。

## Web 单元测试

建议对纯 helper 测试：

### effective status

- child running 覆盖 parent queued/running；
- child completed 覆盖 parent running；
- child failed 覆盖 parent completed；
- child cancelled 覆盖 parent running；
- child 缺失回退 parent status。

### 开始时间格式

- 固定 epoch 在显式时区与注入 `now` 的测试 seam 下：今天输出 `HH:mm`，非今天输出 `MM-DD HH:mm`；
- 月、日、时、分补零；
- 非有限、0、负数或无效时区返回空；
- 无效 `now` 时按非今天格式展示；
- 不输出年份、秒和毫秒；
- locale 切换不导致缺少标签；
- 跨午夜、时区切换或夏令时变化时，今天判定和展示必须同时按同一展示时区变化，不改变 epoch。

### duration

- 0ms → `0s`；
- 999ms → `0s`；
- 1000ms → `1s`；
- 68s → `1min 8s`；
- 1h+ → 现有格式；
- 负/非有限值不被模板展示；
- 抽取 helper 后 session header 原输出不变。

### display mapping

- subtaskRun 从 API item 透传；
- 不从 parent createdAt/updatedAt 构造；
- 非 subtask item 不携带；
- `hasItemChanged()` 能检测 child summary running → terminal；
- 仅 child duration 改变时能检测变化；
- 单项 upsert 不丢摘要。

如果当前项目没有组件测试基础设施，至少把格式、状态和 mapping 抽为纯函数并纳入现有 `tsx --test`；模板行为通过 typecheck/build 和手工验收补充。不得为本需求引入重量级测试框架，除非另行评审。

## Web 手工验收矩阵

| 场景 | 操作 | 预期 |
|---|---|---|
| 新 subtask running | 发起耗时子任务 | child 建立后出现开始时间，无持续时间，图标旋转 |
| completed | 等待成功 | 开始时间保留，出现持续时间，完成图标 |
| failed | 触发可控失败 | 出现持续时间，失败图标；父错误文本按现有规则显示 |
| cancelled | 运行中取消 | 出现持续时间，取消图标 |
| 旧历史无关联 | 打开旧会话/fixture | 不显示时间行，卡片其余功能正常 |
| existing R1/R2 | 同一 child session 执行两次 | 两张卡片时间不同且各自稳定 |
| 刷新浏览器 | terminal 后刷新 | 时间与状态不变 |
| 运行中刷新 | running 时刷新 | 开始时间来自 run，终态后自动更新 duration |
| 向上分页 | 历史卡片在较早页 | 加载后时间正确，无逐卡片 loading |
| 增量读取 | 新卡片追加 | 摘要出现并更新 |
| 单项刷新 | 观察 running → terminal | 不闪失开始时间，最终持续时间出现 |
| fork copied item | 打开包含复制卡片的 fork session | 无时间，不错误关联原 run |
| 中文 | 切换中文 | “开始时间”“持续时间”正确 |
| 英文 | 切换英文 | “Started”“Duration”正确 |
| 小宽度 | 缩窄面板 | 时间行自然换行，无关键文本溢出 |
| 点击/复制 | 点击卡片、复制 ID | 现有行为无回归 |

## 性能验收

必须以测试 spy、SQLite trace 或等价证据证明：

- 无 subtask item 的 context page：0 次 child run 查询；
- JSON1 下有 1 张或多张卡片：1 次；分块下次数为 `ceil(uniqueParentKeys / batchSize)`；
- Web 网络面板没有因卡片数量增加新的 per-card 请求；
- 100 条 tail 页面加载无明显回归；
- public/internal 500 keys 不触发错误；
- full/after 超过 1000 keys 不触发参数上限或遗漏；
- 不增加 running 卡片 timer 数量。

不要求建立正式 benchmark，但必须记录查询次数与代表性页面手工响应表现。

## 代码审查清单

### 语义

- 是否只使用 child run 时间？
- 是否明确 running 不产生 final duration？
- terminal 是否包含 completed/failed/cancelled？
- duration 是否在 API 计算并 `max(0, ...)`？
- 文案是否没有夸大为模型耗时？

### 关联

- 是否使用 item.runId + item.id？
- 是否包含 workspace filter？
- 是否完全避免 session lastRun？
- existing 测试是否能证明不会串 run？
- copied item `runId=null` 是否省略而非追溯？

### 契约

- running/terminal 字段不变量是否可判别？
- startedAt/terminal endedAt 是否由 schema `exclusiveMinimum: 0` 直接约束？
- `subtaskRun` 是否 optional 且非 subtask 省略？
- 是否没有同时支持 omitted/null 两套缺失语义？
- route schema 是否实际输出新字段？
- internal tail response schema 和消费者是否已验证？
- 冲突是否严格 fail-open并使用固定诊断码？
- 是否保证每请求每 key 只记录一次 error？

### API 实现

- 列表是否批量查询？
- 是否没有循环单条 SQL？
- 单项是否复用同一 projector？
- store 是否检测重复 key？
- 非法数据是否保守省略？
- 是否没有把重复 key 混入普通“缺失/非法时间”降级，而是执行专用诊断合同？
- 是否未修改写路径和数据库 schema？

### Web 实现

- DisplayItem 是否透传 shared 类型？
- 是否没有使用 parent item 时间？
- icon/class/spin 是否统一使用 effective status？
- `hasItemChanged` 是否比较摘要？
- 开始时间是否本地绝对格式？
- terminal 才显示持续时间？
- 缺失摘要是否不显示占位？
- 中英文文案是否齐全？
- 卡片 click/copy/error/tone 是否无回归？

### 性能与范围

- 是否没有新前端 per-card API？
- 是否没有新增 timer？
- 是否没有数据库迁移？
- 是否没有修改 child session run-state 语义？
- 是否没有顺手重构整个 AgentClientPane？

## 自动测试命令

实施时按实际 package script 复核。建议至少执行：

```bash
# Shared
npm run build -w packages/shared
npm run typecheck -w packages/shared

# API 定向
npx tsx --test apps/api/src/modules/agent/query/context-query-application.test.ts
npx tsx --test apps/api/src/modules/agent/context-item-contract.test.ts
# 新增或扩展的相关 integration test
npx tsx --test apps/api/src/modules/agent/integration/<relevant>.test.ts

# Web 定向/全量显式列表
npm test -w apps/web
npm run typecheck -w apps/web

# API / 全仓类型与构建
npm run typecheck -w apps/api
npm run typecheck
npm run build
```

注意：仓库 API package 没有通用 unit test script，定向测试应使用实际 `tsx --test` 路径。若新增 Web test，必须确认已加入 `apps/web/package.json` 当前显式 test 列表，或经评审调整脚本。

## 验收阻断条件

以下任一项失败即不得验收：

- 使用 parent item 时间或 session lastRun；
- running 显示 `updatedAt - createdAt` 持续时间；
- existing 两张卡片串到同一最新 run；
- 列表存在后端或前端 N+1；
- 冲突 key 被任选、静默覆盖、整接口失败或没有固定 error 诊断；
- 测试/预发布/灰度出现 `AGENT_SUBTASK_RUN_PARENT_CONFLICT`；
- internal tail 未验证或剥离摘要；
- 单项刷新丢失 `subtaskRun`；
- terminal failed/cancelled 不显示持续时间；
- copied item 被追溯关联；
- route schema 剥离字段；
- child run 缺失导致整个 history 请求失败；
- 状态 icon 的不同属性使用不同状态来源；
- i18n key 缺失；
- 相关 typecheck/build/test 失败；
- 独立代码审查未完成或复审未通过。

## 回归范围

至少验证：

- 普通 user/assistant/system/tool 消息展示；
- apply_patch/write/todolist/scratchpad 卡片；
- subtask 卡片点击、Session ID 提取与复制；
- context history tail/before/after；
- archive/compaction 后 transcript；
- session header elapsed timer；
- run cancel/recovery；
- subtask new/fork/existing lineage；
- public context item schema validation。

## 回滚标准

若上线后出现：

- context-items 显著性能下降；
- 持续出现 `AGENT_SUBTASK_RUN_PARENT_CONFLICT` 数据完整性诊断；
- 历史接口因旧数据频繁失败；
- 时间串 run；
- 单项刷新造成卡片抖动或字段丢失；
- schema 兼容问题；

应回滚 Shared/API/Web 同批变更，恢复不含 `subtaskRun` 的旧读侧和卡片。数据库未迁移，无需数据回滚。不得仅回滚 Web 留下无人消费但高开销的 API 投影，也不得仅回滚 API 让 Web 假定字段存在。

## 最终验收口径

正确表述：

> 对能够通过父 Run 和父工具 item 精确关联 child run 的 subtask 卡片，展示 run 激活落库的开始时间，并在 completed、failed、cancelled 后展示到终态落库的墙钟持续时间；旧数据或无关联卡片安全降级。

不得表述：

> 已展示每个 subtask 的精确模型执行时间或精确结束时间。
