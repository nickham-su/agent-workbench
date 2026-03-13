# 内置提示词按设置语言处理方案(v1)

本文档基于当前仓库代码现状，定义若干 **内置提示词 / 内置系统文案** 按设置语言(`uiLocale`)处理的改造方案。本文聚焦 4 项当前会直接进入模型上下文、或明显影响 agent 行为的内置文本：

1. 压缩提示词 `COMPACTION_USER_PROMPT`
2. 子任务 fork 防护文案 `SUBTASK_FORK_GUARD_SYSTEM_TEXT`
3. 压缩后归档摘录提示 `buildCompactionSnippetMessageText()`
4. clear 后摘要文案 `buildClearSummaryText()`

本方案的目标是在 **不改变“worker 负责执行期模型调用、API 负责持久化/归档/冲突控制”总体职责边界** 的前提下，让上述内置文案可按设置语言输出，减少英文运行环境下的中英混用。

相关背景文档：
- `docs/design/agent/system-prompt-assembly-rework-v1.md`
- `docs/design/agent/global-system-prompt-in-settings-v1.md`
- `docs/design/agent/run-locale-in-system-prompt-v1.md`
- `docs/design/agent/context-archive-search-compaction-v1.md`

---

## 背景与现状

### 已有 locale 链路

当前 agent run 已存在一条从前端语言设置到后端 run 记录的 `uiLocale` 链路：

- 前端发送消息时可带 `uiLocale`
  - `packages/shared/src/contracts/agent.ts:171-177`
- 前端手动触发 compact 时也可带 `uiLocale`
  - `packages/shared/src/contracts/agent.ts:188-194`
- API 在创建 run record 时写入 `uiLocale`
  - 普通消息：`apps/api/src/modules/agent/agent.service.ts:2001-2055`
  - 手动 compact：`apps/api/src/modules/agent/agent.service.ts:2212-2225`
- run record 中已持久化 `uiLocale`
  - `apps/api/src/modules/agent/agent.store.ts:340-352`
- API 侧构建 system prompt 时，`output_format_instructions` 与 `runtime_constraints` 已按 `run.uiLocale` 分支
  - `apps/api/src/modules/agent/agent.service.ts:783-859`
  - `apps/api/src/modules/agent/agent.service.ts:3450-3476`

这说明：
- **设置语言本身已经存在且可持久化**；
- 但除 system prompt 主体之外，其它若干内置文案还没有接入这条语言链路。

### 本次聚焦的 4 项内置文案

| 项目 | 定义位置 | 当前执行位置 | 当前语言状态 |
|---|---|---|---|
| 压缩提示词 `COMPACTION_USER_PROMPT` | `apps/agent-worker/src/runtime/runner.ts:53-73` | worker | 中文硬编码 |
| 子任务 fork 防护文案 `SUBTASK_FORK_GUARD_SYSTEM_TEXT` | `apps/api/src/modules/agent/agent.service.ts:910-916` | API | 中文硬编码 |
| 压缩后归档摘录提示 `buildCompactionSnippetMessageText()` | `apps/api/src/modules/agent/agent.service.ts:957-975` | API | 中文硬编码 |
| clear 后摘要文案 `buildClearSummaryText()` | `apps/api/src/modules/agent/agent.service.ts:868-875` | API | 中文硬编码 |

### 当前问题

1. 这些文本会作为 `system` / `messages` / 压缩 prompt 直接进入模型上下文，不是普通 UI 文案。
2. 在英文运行环境下，它们会和已 locale 化的 system prompt 主体混用，导致模型收到中英混杂信号。
3. 4 项文案所在调用链并不一致：
   - 有的发生在 API 侧；
   - 有的发生在 worker 侧；
   - 有的已有 `uiLocale`；
   - 有的当前拿不到语言。
4. 若为了解决语言问题而把 compaction 的模型调用整体下沉到 API，会打破当前职责边界，并导致自动压缩 / 手动压缩实现分叉或模型调用逻辑重复。

---

## 目标

- 让 4 项内置提示词/文案支持按设置语言(`uiLocale`)输出。
- 保持当前整体职责边界：
  - **worker 负责执行期模型调用**
  - **API 负责状态落库、归档、冲突控制、prompt 组装**
- 明确自动压缩与手动压缩场景中，为什么**不建议**把 compaction 总结生成整体下沉到 API。
- 明确每一项文案的语言来源方案：
  - 哪些当前可直接拿到 `uiLocale`
  - 哪些需要补字段透传
  - 哪些需要扩展请求 schema
- 尽量沿用现有语言链路与现有接口习惯，避免额外引入新的全局状态源。

---

## 非目标

- 不改动 provider 选择、模型配置解析或 compaction 阈值策略。
- 不把自动压缩或手动压缩的模型调用整体搬到 API 服务。
- 不重新设计 compaction 存储格式、archive 文件格式或 clear/compact 的业务语义。
- 不把所有 tool result 文案一次性都做 locale 化；本次仅聚焦上述 4 项。

---

## 现状调用链分析

## 场景 A：自动压缩（worker 自动触发）

### 触发链路

自动压缩由 worker 在正常 run 循环中根据 token 使用阈值判断：

1. worker 获取 execution profile 与 prompt context
   - `apps/agent-worker/src/runtime/runner.ts:1999-2003`
   - `apps/agent-worker/src/runtime/runner.ts:2062-2067`
2. worker 判断是否达到自动压缩阈值
   - `apps/agent-worker/src/runtime/runner.ts:1382-1395`
   - `apps/agent-worker/src/runtime/runner.ts:2082-2089`
3. 若触发，则 worker 在 `compactContext()` 中调模型生成 `summaryText`
   - `apps/agent-worker/src/runtime/runner.ts:1397-1433`
   - 当前附加的压缩提示词为 `COMPACTION_USER_PROMPT`
   - 关键调用：`messages: [...context.messages, { role: "user", content: COMPACTION_USER_PROMPT }]`
     - `apps/agent-worker/src/runtime/runner.ts:1413-1415`
4. worker 将 `summaryText` 提交给 API，由 API 完成真正 compact 落库
   - worker client：`apps/agent-worker/src/runtime/apiClient.ts:228-243`
   - API route：`apps/api/src/modules/agent/agent.routes.ts:641-677`
   - API service：`apps/api/src/modules/agent/agent.service.ts:3105-3208`

### 当前职责分工

| 步骤 | 当前负责方 |
|---|---|
| 判断是否需要自动压缩 | worker |
| 调模型生成 `summaryText` | worker |
| 归档旧上下文 | API |
| 插入 compaction summary system item | API |
| 处理 head 冲突与事务 | API |

### 当前语言可达性

- `COMPACTION_USER_PROMPT` 在 worker 侧定义，当前看不到 `uiLocale`
  - `apps/agent-worker/src/runtime/runner.ts:53-73`
- worker 执行 compaction 时拿到的对象是：`profile`、`run`、`context`
  - `apps/agent-worker/src/runtime/runner.ts:1397-1402`
- 其中：
  - `run` 当前仅包含队列执行必要信息，不含 `uiLocale`
  - `PromptContext` 当前也不含 `uiLocale`
    - `apps/agent-worker/src/runtime/apiClient.ts:73-90`

结论：
- **自动压缩当前无法直接按设置语言处理**；
- 但问题是“worker 路径缺少语言字段”，不是“compaction 应该搬到 API”。

---

## 场景 B：手动压缩（用户触发）

### 触发链路

手动压缩由前端经 API 创建一个特殊 run，再由 worker 执行一次 compaction：

1. 前端调用 `POST /api/agent/sessions/:sessionId/compact`
   - route：`apps/api/src/modules/agent/agent.routes.ts:245-287`
2. compact 请求 schema 已支持 `uiLocale`
   - `packages/shared/src/contracts/agent.ts:188-194`
3. API 在 `compactSession()` 中创建 run record，并写入 `uiLocale`
   - `apps/api/src/modules/agent/agent.service.ts:2155-2244`
   - `createRunRecord(... uiLocale ...)`
     - `apps/api/src/modules/agent/agent.service.ts:2212-2225`
4. API 将该 run 入队给 worker，输入文本使用手动压缩哨兵 `__awb_compact__`
   - `apps/api/src/modules/agent/agent.routes.ts:269-275`
5. worker 识别到手动压缩哨兵后，不进入正常 step 循环，只执行一次 compaction
   - `apps/agent-worker/src/runtime/runner.ts:2018-2059`
6. 后续与自动压缩一致：worker 生成 `summaryText`，API 完成 compact 落库

### 当前职责分工

| 步骤 | 当前负责方 |
|---|---|
| 接收用户 compact 请求 | API |
| 创建 run record 并持久化 `uiLocale` | API |
| 入队执行 | API/runtime |
| 调模型生成 `summaryText` | worker |
| 归档与落库 | API |

### 当前语言可达性

- **请求本身已经有 `uiLocale`**；
- run record 也已持久化 `uiLocale`；
- 但 worker compaction 路径当前仍拿不到该字段，因此 `COMPACTION_USER_PROMPT` 依然无法按语言变化。

结论：
- 手动压缩已经具备语言来源；
- 差的只是 **worker 侧 compaction 执行链路未消费该语言**。

---

## 为什么不建议把 compaction 总结生成下沉到 API

### 结论

**不建议为了语言问题，把 compaction 的模型调用整体下沉到 API。**

### 原因分析

| 维度 | 保持现状（worker 生成 summary、API 落库） | 改为 API 调模型生成 summary |
|---|---|---|
| 职责边界 | 清晰：worker 执行，API 持久化 | 模糊：API 也开始承担模型执行 |
| 自动/手动压缩一致性 | 高：两者都走 worker compaction | 容易分叉：手动/自动可能走不同执行面 |
| 模型调用实现复用 | 高：继续复用 worker 侧 provider/timeout/abort 逻辑 | 低：API 需要再实现一套模型调用与错误处理 |
| 并发/锁/冲突模型 | 清晰：API 专注事务与 head 冲突 | 更复杂：API 同时承担模型调用与 DB 事务边界协调 |
| 语言问题解决方式 | 补 `uiLocale` 透传即可 | 通过改变架构解决局部字段缺失，代价过大 |
| 长期维护成本 | 低 | 高 |

### 自动压缩视角

自动压缩本来就是 worker 在执行期根据 token 阈值即时判断：

- `shouldAutoCompact(...)`
  - `apps/agent-worker/src/runtime/runner.ts:1382-1395`
- run loop 内触发
  - `apps/agent-worker/src/runtime/runner.ts:2082-2089`

如果把生成总结改到 API，相当于把“执行期模型调用”拆成两类：
- 正常 step 在 worker
- compaction 在 API

这会带来：
- 模型调用职责分裂
- provider / timeout / abort / debug dump / retry 逻辑重复
- worker 检测到要压缩后，仍要转回 API 执行，时序更绕

### 手动压缩视角

手动压缩当前虽然由 API 接请求，但已经被建模成一个特殊 run：
- API 创建 run
- worker 识别 `__awb_compact__` 并只执行一次 compaction

这让手动压缩自动继承了：
- run-state
- dedup
- idle 检查
- worker 调度
- 与自动压缩统一的生成逻辑

如果 API 直接调模型完成手动压缩，而自动压缩仍在 worker，就会形成两套 compaction 生成路径，不利于一致性。

### 推荐结论

**语言问题应通过补齐语言字段透传解决，而不是通过调整 compaction 归属解决。**

---

## 推荐改造策略

### 总体策略

- 保持 compaction 当前职责分工不变：
  - **worker 生成 `summaryText`**
  - **API 落库/归档/插入 summary system item**
- 对 4 项内置文案分别按其所在执行面接入 `uiLocale`
- API 侧可直接拿到 `uiLocale` 的文案，优先本地化
- worker 侧拿不到 `uiLocale` 的文案，通过最小字段透传补足

### 语言来源与改造方式总表

| 优先级 | 项目 | 当前是否能直接拿到 `uiLocale` | 推荐语言来源 | 是否需要改接口/透传 | 推荐改造方式 |
|---|---|---|---|---|---|
| P0 | 子任务 fork 防护文案 `SUBTASK_FORK_GUARD_SYSTEM_TEXT` | 是 | `parentRun.uiLocale` | 否 | 将常量改成函数，按 `parentRun.uiLocale` 返回文本 |
| P0 | 压缩后归档摘录提示 `buildCompactionSnippetMessageText()` | 是 | `run.uiLocale` | 否 | 给函数增加 `uiLocale` 参数，在 `getPromptContextForRun()` 中传入 |
| P1 | clear 后摘要文案 `buildClearSummaryText()` | 否（当前 clear 路径无 `uiLocale`） | clear 请求体中的 `uiLocale` | **是**，需要扩 `AgentClearSessionRequest` | 将函数改成按 `uiLocale` 返回文本；前端 clear 请求显式带语言 |
| P1 | 压缩提示词 `COMPACTION_USER_PROMPT` | 否（worker 当前拿不到） | 透传到 worker 的 `uiLocale` | **是**，需要给 worker compaction 路径补字段 | 将常量改成函数，按 `uiLocale` 返回文本 |

### 推荐实施顺序

1. **先做 API 侧、路径最明确的两项**
   - fork 防护文案
   - 压缩后归档摘录提示
2. **再做 clear 摘要文案**
   - 因为 clear 请求显式带 `uiLocale` 的方案最直接
3. **最后做压缩提示词**
   - 需要先确定 worker 侧 `uiLocale` 透传方案

---

## 分项方案

## 1) 压缩提示词 `COMPACTION_USER_PROMPT`

### 现状

- 定义：`apps/agent-worker/src/runtime/runner.ts:53-73`
- 使用：`apps/agent-worker/src/runtime/runner.ts:1413-1415`
- 当前语言：中文硬编码

### 语言来源方案

推荐：**给 worker compaction 路径补 `uiLocale` 透传**。

### 字段透传建议

优先建议：**在 `PromptContext` 中增加 `uiLocale`**。

原因：
- worker 在自动压缩与手动压缩前都会先取 `PromptContext`
  - `apps/agent-worker/src/runtime/runner.ts:2020-2024`
  - `apps/agent-worker/src/runtime/runner.ts:2063-2067`
- compaction 本来就依赖 `context.system / context.messages / headItemId / lastResponseTotalTokens`
- `uiLocale` 作为 run/context 级信息，放入 `PromptContext` 比放入 `ExecutionProfile` 更自然

### 改造要点

- 将 `COMPACTION_USER_PROMPT` 从常量改为函数，例如 `buildCompactionUserPrompt({ uiLocale })`
- 在 worker compaction 调用点读取 `context.uiLocale`
- `null` / 非法 locale 继续采用 locale-neutral 英文或与 system prompt 主体一致的兜底策略

### 结论

- 改造方法**明确**；
- 但有一个前置条件：**worker 侧先拿到 `uiLocale`**。

---

## 2) 子任务 fork 防护文案 `SUBTASK_FORK_GUARD_SYSTEM_TEXT`

### 现状

- 定义：`apps/api/src/modules/agent/agent.service.ts:910-916`
- 注入：`apps/api/src/modules/agent/agent.service.ts:2908-2925`
- 子任务 run 继承父 run 的 `uiLocale`
  - `apps/api/src/modules/agent/agent.service.ts:2942-2949`

### 语言来源方案

直接使用：**`parentRun.uiLocale`**。

### 改造要点

- 将常量改为函数，例如 `buildSubtaskForkGuardSystemText({ uiLocale })`
- 在 fork 场景插入 system item 时，使用 `parentRun.uiLocale ?? null`
- 保持原有语义不变，仅做文案语言分支

### 结论

- 语言来源**已在当前调用链上**；
- 改造路径**明确且简单**。

---

## 3) 压缩后归档摘录提示 `buildCompactionSnippetMessageText()`

### 现状

- 定义：`apps/api/src/modules/agent/agent.service.ts:957-975`
- 注入位置：`apps/api/src/modules/agent/agent.service.ts:3531-3610`
- 该逻辑位于 `getPromptContextForRun()` 的 prompt 组装阶段
  - `apps/api/src/modules/agent/agent.service.ts:3450-3756`
- 同一个函数内已直接使用 `run.uiLocale` 构建其它 locale 化 section
  - `apps/api/src/modules/agent/agent.service.ts:3474-3476`

### 语言来源方案

直接使用：**`run.uiLocale`**。

### 改造要点

- 为 `buildCompactionSnippetMessageText()` 增加 `uiLocale` 参数
- 在 `getPromptContextForRun()` 中调用时传入 `run.uiLocale`
- 标题、archive 工具提示、使用说明都做语言分支

### 结论

- 语言来源**当前已在手上**；
- 改造路径**明确且简单**。

---

## 4) clear 后摘要文案 `buildClearSummaryText()`

### 现状

- 定义：`apps/api/src/modules/agent/agent.service.ts:868-875`
- 使用：`apps/api/src/modules/agent/agent.service.ts:3211-3257`
- clear 请求 schema 当前**没有** `uiLocale`
  - `packages/shared/src/contracts/agent.ts:203-207`
- route 当前 body 也只读取：`workspaceId`、`reason?`
  - `apps/api/src/modules/agent/agent.routes.ts:291-309`

### 语言来源方案

推荐：**由 clear 请求显式带 `uiLocale`**。

### 推荐原因

- 语言设置来自前端；
- clear 是前端主动触发的控制动作；
- 与 `sendMessage` / `compactSession` 已支持 `uiLocale` 的风格一致；
- 不需要定义“取哪个最近 run 的语言”这类隐式规则；
- 没有 run 历史、首次 clear 等边界下也仍然成立。

### 改造要点

- 为 `AgentClearSessionRequestSchema` 增加可选 `uiLocale`
- route 与 service 在 clear 入口做 `normalizeAgentUiLocale(...)`
- 将 `buildClearSummaryText()` 改成例如 `buildClearSummaryText({ reason, uiLocale })`

### 结论

- 改造方式**明确**；
- 需要一个轻量接口变更：**clear 请求显式带 `uiLocale`**。

---

## 兼容性

### 与现有 compaction 架构兼容

- 保持 `compactContext()` 仍在 worker 生成 `summaryText`
- 保持 `compactContextFromWorker()` 仍由 API 负责事务落库/归档
- 自动压缩与手动压缩继续共用同一条 compaction 生成逻辑

### 与现有 locale 链路兼容

- `sendMessage` 与 `compactSession` 已有 `uiLocale`，本方案沿用既有思路
- `clearSession` 仅需补齐 `uiLocale`
- `null` locale 仍可沿用当前 locale-neutral 英文兜底策略

### 与已有数据兼容

- 旧 run record 已存在 `uiLocale` 字段
- fork 场景继续复用父 run 的 `uiLocale`
- clear 场景在旧客户端未带 `uiLocale` 时，可继续回退为 `null`

---

## 风险与对策

### 1) 为了语言问题改动 compaction 归属，导致职责边界变坏

风险：
- API 开始承担模型执行职责，和 worker 执行面重叠。

对策：
- 明确本方案**不**把 compaction 总结生成下沉到 API。
- 仅补齐 `uiLocale` 透传与 API 侧文案 locale 化。

### 2) 自动压缩与手动压缩走出两套逻辑

风险：
- 若手动压缩改为 API 调模型、自动压缩保留在 worker，后续 prompt 文案、超时、provider 行为容易漂移。

对策：
- 两个场景继续统一由 worker 生成 `summaryText`。

### 3) clear 请求新增 `uiLocale` 的客户端兼容问题

风险：
- 老客户端可能不传该字段。

对策：
- schema 使用可选字段。
- 服务端对缺失值继续按 `null` 处理，保持兼容。

### 4) worker 透传 `uiLocale` 时字段位置选错

风险：
- 若把 `uiLocale` 放在与其语义不匹配的位置，会增加后续维护成本。

对策：
- 推荐放入 `PromptContext`，因为 compaction 与 prompt/context 消费关系更直接。

---

## 验证建议

### 单元/集成测试建议

围绕 4 项文案增加或更新测试，至少覆盖：

- `COMPACTION_USER_PROMPT`
  - worker 在 `uiLocale = zh-CN / en-US / null` 下生成不同语言的压缩提示词
  - 自动压缩与手动压缩共用同一套语言分支
- `SUBTASK_FORK_GUARD_SYSTEM_TEXT`
  - fork 子任务时继承父 run 的 `uiLocale`
  - `zh-CN / en-US / null` 下文案语言正确
- `buildCompactionSnippetMessageText()`
  - `getPromptContextForRun()` 中 compaction snippet 随 `run.uiLocale` 变化
- `buildClearSummaryText()`
  - clear 请求显式带 `uiLocale` 时，摘要文案语言正确
  - 缺失 `uiLocale` 时保持兼容兜底

### 手工验证建议

- 在英文环境中发起长任务，触发自动压缩，确认 compaction prompt 不再固定中文。
- 在英文环境中发起 `/compact`，确认手动压缩与自动压缩使用同语言总结提示词。
- fork 一个英文子任务会话，确认 fork 防护 system 文案为英文。
- 在已 compaction 的会话中继续运行，确认归档摘录提示语言与 run 的 `uiLocale` 一致。
- 在前端切换语言后执行 clear，确认 clear 后摘要文案使用当前语言。

### 回归关注点

- 不要改变 worker 生成 `summaryText`、API 落库的 compaction 边界。
- 不要让手动压缩绕过现有 run-state / dedup / enqueue 机制。
- 不要误把语言字段绑到不合适的全局 profile 上，导致 run 级语义丢失。

---

## 结论

本方案对 4 项内置提示词/文案的改造路径已经基本明确：

1. **压缩提示词 `COMPACTION_USER_PROMPT`**
   - 不建议为了解决语言问题把 compaction 模型调用下沉到 API。
   - 更合理的方案是保持“worker 生成 `summaryText`、API 落库/归档”的职责分工，只为 worker compaction 路径补 `uiLocale` 透传。
2. **子任务 fork 防护文案 `SUBTASK_FORK_GUARD_SYSTEM_TEXT`**
   - 当前 API 调用链上已可直接拿到 `parentRun.uiLocale`，改造路径明确。
3. **压缩后归档摘录提示 `buildCompactionSnippetMessageText()`**
   - 当前 API prompt 组装阶段已可直接拿到 `run.uiLocale`，改造路径明确。
4. **clear 后摘要文案 `buildClearSummaryText()`**
   - 建议由 clear 请求显式带 `uiLocale`；由于语言设置来源于前端，这是最直接、最方便且最稳定的方案。

总体上，语言问题的最佳解决路径是：
- **API 侧直接消费已有 `uiLocale` 的文案先改造**；
- **worker 侧通过最小字段透传补齐 `uiLocale`**；
- **不要为了 locale 化需求而改变 compaction 的执行归属。**
