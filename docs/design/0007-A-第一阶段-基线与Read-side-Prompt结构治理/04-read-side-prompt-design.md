# 1B：Read-side / Prompt 结构治理

## 1B 定位

1B 是 0006 总体蓝图下第一轮生产结构治理。在 1A 提供最小测试地基后，把 API 侧 Read-side / Prompt 规则从跨域 `AgentService` 中提取为明确职责边界。

本阶段是结构迁移，不是 prompt 产品重设计，也不是 Shared contract 扩张。1B 的成功标准是权威规则归属、依赖方向和测试结构清晰，而不是追求 `agent.service.ts` 行数指标。

## 当前调用链

```text
Agent Worker Runner
  ├─ AgentApiClient.getExecutionProfile()
  ├─ AgentApiClient.getPromptContext()
  └─ AgentApiClient.getMessagesContext()
             ↓
Shared AgentApiEndpoints + request/response schemas
             ↓
agent.routes.ts
             ↓
AgentService
  ├─ getExecutionProfileForRun()
  ├─ getPromptContextForRun()
  └─ getMessagesContext()
             ↓
DB queries + workspace/settings/plugin readers
+ prompt templates + skill readers + tool projectors
+ compaction snippet + runPromptStaticCache
```

1B 保留链路上方的 Worker Client、Shared contract 和 Route 合同，把应用组装逻辑迁到 read-side/prompt 职责域，并由 `AgentService` facade 委派。

## 目标职责边界

候选名称只表达职责，不构成最终文件/类型命名承诺。

### Read-side / Prompt application entry

对内部调用方提供与当前 service 等价的用例：

```text
getExecutionProfileForRun(input)
getPromptContextForRun(input)
getMessagesContext(input)
```

Application entry 只负责编排一个完整 read-side 用例，不负责实现内部 profile/prompt/messages 投影规则。它是以下事项的最终责任方：

- 加载并校验请求对应的 workspace/session，以及 execution-profile/prompt-context 所需 run；
- 统一决定 session/run not found、workspace mismatch 等现有 `HttpError` status/message；
- 把已验证的上下文交给 resolver/assembler/projector，不让下游重复做 HTTP 语义归属判断；
- 按用例调用 profile resolver、static prompt cache 和 messages projector；
- 组合并返回现有 Shared response 外壳。

它不直接展开 system prompt、skills、tools、transcript 或 cache Map 操作。除最终 response 组合外，application entry 不复制下游投影规则。

不得：

- 写入 run/context/session；
- 调用 runtime enqueue/cancel；
- 处理 context writeback、archive rollback 或 subtask；
- 引入新的 endpoint 或 response 字段。

### Execution profile resolver

Execution profile resolver 只接收已通过 application entry 归属校验的 session/run identity 与必要 settings readers，负责：

- 根据 run 中固定的 agent/provider/model identity 调用既有 profile/settings 解析逻辑；
- 组装 resolved、agent、provider、model、vision、compaction、runtime；
- 保持 profile 选择和 options 字段语义。

它不负责查询请求归属、映射 400/404，也不读取 transcript、组装 system prompt 或操作 cache。

`getSingleCallModelProfileForRun()` 等相邻 profile helper 是否进入同一内部组件，需在实现前按真实调用者判断：只有共享同一 profile 规则且不会扩大本阶段范围时才迁移；否则保留 facade/旧位置并通过最小内部能力复用。

### Static prompt assembler/cache

负责当前 static 部分：

- system/global prompt；
- Agent instructions；
- workspace instructions；
- top-level skill summaries、external skill roots；
- tool definitions/projection；
- pending tool definitions中属于 static 的投影；
- locale/static configuration；
- `runPromptStaticCache` 的实际读、写、Promise reuse、TTL/续期和删除操作。

Application entry 决定 prompt-context 用例何时调用 static cache；assembler/cache 负责 cache 内部机制和 static 值构建。terminal clear 的业务时机仍由既有 lifecycle 路径决定，真正的 cache 删除由该组件暴露的窄 invalidation 操作完成。

不变量：

- cache key、TTL、Promise reuse、访问续期和清理时机不变；
- 同一 run static Promise 复用不变；
- static/dynamic 划分不变；
- cache 中不新增完整动态 transcript 或每步变化状态；
- terminal clear 仍由既有 lifecycle 路径触发；1B 只提供明确 invalidation 入口，不迁移 run lifecycle。

### Messages / transcript projector

负责：

- session transcript 和 one-shot system message；
- `appendMessage` 仅投影到响应，不写 DB；
- message 顺序、role/content 与 reasoning 过滤；
- locale fallback；
- 动态 tool/pending tool/message content 的既有保留策略；
- compaction snippet 等动态读取投影。

Messages projector 接收 application entry 已验证的 session 上下文，通过窄 transcript/context query 获取只读数据。它不负责 session/run 归属错误映射、不调用 static prompt cache，也不得写 context item、移动 head 或改变 archiveAt。

### 最终责任归属

| 规则 | 最终责任方 |
|---|---|
| workspace/session/run 归属校验与现有 400/404 映射 | application entry |
| execution profile 选择与 profile response 内部字段 | execution profile resolver |
| prompt-context 是否调用 static cache、static/dynamic 结果组合和 response 外壳 | application entry |
| cache key/TTL/reuse/续期/实际删除 | static prompt assembler/cache |
| terminal 时何时触发 clear | 既有 lifecycle 调用方；1B 不迁移该业务时机 |
| transcript 顺序、appendMessage 投影、reasoning 过滤、动态 message 内容 | messages projector |

同一规则不得在 facade、application entry 和下游组件重复实现。

### Collaborators

Read-side / Prompt 组件通过最小能力读取：

- session/run/context query；
- workspace、settings、agent/profile、plugin tool snapshot；
- instruction/skill/compaction snippet 文件；
- prompt template；
- clock/cache/logger。

本阶段允许先使用函数式依赖对象，不要求为每个函数创建 interface/class。新组件默认不接收完整 `AppContext`；若某项既有 helper 暂时只能使用 `AppContext`，阶段实现必须：

- 记录依赖面；
- 通过窄 adapter 包装；
- 不把完整 context 继续向领域内部传递；
- 给出在本阶段结束时保留或后续清理的理由。

## 目标依赖方向

```text
Agent Routes
    ↓
AgentService facade
    ↓
Read-side / Prompt application entry
    ├─ execution profile resolver
    ├─ static prompt assembler/cache
    ├─ messages/transcript projector
    └─ existing tool projectors
          ↓
query capabilities / settings readers / filesystem readers
```

禁止方向：

```text
Read-side / Prompt → Context Writeback service
Read-side / Prompt → Run Lifecycle service
Read-side / Prompt → full AgentService
Read-side / Prompt → runtime enqueue/cancel
Query capability → application entry
```

Run completion 对 cache 的清理由既有调用方通过最小 invalidation capability 触发，避免 Read-side 与 Run Lifecycle 双向注入完整 service。

## 迁移策略

### 保留兼容 facade

过渡期：

- `AgentService.getExecutionProfileForRun()` 继续存在并委派；
- `AgentService.getPromptContextForRun()` 继续存在并委派；
- `AgentService.getMessagesContext()` 继续存在并委派；
- Route handler 不需要在首批迁移中改为直接依赖新组件；
- 本地 runtime 和既有测试调用方保持兼容。

Facade 只转发和做必要参数适配，不保留同一规则的第二份实现。

### 逐用例迁移

建议顺序：

```text
execution profile
  → messages context / transcript projection
  → static prompt assembler + cache
  → prompt context composition
  → facade/module wiring cleanup
```

原因：execution profile 和 messages context 边界相对清晰，可先验证依赖注入和错误保持；prompt context 再复用前述能力迁移最复杂组装与 cache。

### 单一权威实现

每个用例迁移后：

- 旧 `AgentService` 方法不得保留原实现副本；
- 测试必须以新职责域为主要权威路径；
- facade/Route/Worker 的集成测试证明兼容入口仍可用；
- 禁止使用 feature flag 长期维护新旧双路径。

## 合同与行为不变量

### Shared contract

以下文件原则上不因 1B 生产结构迁移而修改：

```text
packages/shared/src/internal-contracts/agent-api-read.ts
packages/shared/src/internal-contracts/agent-api.ts
packages/shared/tests/internal-contracts.test.ts
```

如纯测试迁移需要调整 import 或测试组织，必须证明 schema、export、method/path 未改变。若真实需求要求合同变化，停止 1B 并独立立项。

### Route / HTTP

- internal token 检查顺序保持；
- method/path/body/response schema 保持；
- 400/401/404/status body 保持；
- terminal run 不新增特殊 read-side 状态；
- Route 不组装 prompt 或访问 Store。

### Execution profile

- run 固定的 agent/provider/model 选择保持；
- session/workspace/run 归属检查保持；
- runtime、vision、compaction 和 provider/model options 保持；
- dynamic options 不被过度规范化或删除。

### Prompt/messages

- message 顺序和截断/窗口策略保持；
- reasoning 不进入模型 prompt messages；
- `appendMessage` 只追加响应，不写入 context；
- locale fallback 保持；
- compaction snippet 保持；
- tools、pendingTools、external roots 保持；
- dynamic message content/inputSchema/args/options 保持宽松边界；
- 不记录完整 prompt/messages、apiKey、tool args/result。

### Worker

- `AgentApiClient` 三个方法和 validation 模式保持；
- Worker Runner 的调用顺序、模型循环、auto-compaction 和 tool execution 不变；
- API-managed Worker 与本地 fallback 路径保持。

## 1B 退出条件

- 三个用例有明确的单一权威实现；
- `AgentService` 对这三个入口只做兼容委派；
- 新组件依赖最小、可说明，不形成新的全能 service；
- cache/invalidation 没有与 lifecycle 形成循环依赖；
- 0005 contract 与 prompt cache 测试全部通过；
- read-side/prompt 领域测试可独立定位，Route/API↔Worker 证据保留；
- 没有纳入 archive、writeback、run lifecycle 或 Worker 主控制流；
- 独立审查和复审确认没有双实现、依赖反转或模型输入漂移。
