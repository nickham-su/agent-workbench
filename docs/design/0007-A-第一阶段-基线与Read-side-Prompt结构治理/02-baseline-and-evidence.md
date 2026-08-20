# 当前基线与证据

## 基线口径

本阶段以实施前实际代码和测试结果为准。以下规模来自当前静态调研，只用于定位热点，不构成拆分阈值：

| 路径 | 约行数 | 与本阶段关系 |
|---|---:|---|
| `apps/api/src/modules/agent/agent.service.ts` | 4970 | Read-side/Prompt 当前主要编排中心，同时混合其他职责 |
| `apps/api/src/modules/agent/agent.integration.test.ts` | 11573 | 大型跨域回归集，含重复 fixture 与部分 prompt/read-side 场景 |
| `apps/api/src/modules/agent/agent.worker.integration.test.ts` | 531 | API-managed Worker 真实主链证据 |
| `apps/api/src/modules/agent/context-item-contract.test.ts` | 1078 | 本阶段原则上只保留/迁移与 read-side 无关的既有合同证据，不纳入 writeback 改造 |
| `apps/api/src/modules/agent/prompt/` | 当前已有 `tool-projectors/` | Read-side 领域内的能力提取先例 |
| `apps/agent-worker/src/runtime/apiClient.ts` | 362 | 三个 read-side client 方法和统一 request/schema validation |
| `apps/agent-worker/src/runtime/apiClient.test.ts` | 722 | Worker client strict/warn、错误和 response validation |
| `apps/agent-worker/src/runtime/runner.auto-compact.test.ts` | 858 | Worker 对 prompt/messages context 的调用替身和 auto-compact 回归 |
| `packages/shared/tests/internal-contracts.test.ts` | 541 | 0005 read-side contract/export/schema 基线 |

实施前必须重新执行规模、符号和测试命令核对，并把差异记录到阶段实施记录中。

## 0006 上位约束

以下内容直接继承 `../0006-Agent模块结构治理总方案/`：

- 按职责域、状态不变量和依赖方向治理，不按行数机械拆分；
- 先冻结语义，再移动结构；
- `AgentService` 过渡期作为兼容 facade；
- 测试治理随生产职责域迁移，1A testkit 仅为时间受限前置使能；
- 新组件使用显式最小能力依赖；
- 不把外围 internal 能力和 Worker 高风险主控制流混入本阶段。

## 0005 不变基线

### Shared read-side contract

已完成的 read-side contract 位于：

```text
packages/shared/src/internal-contracts/agent-api-read.ts
packages/shared/src/internal-contracts/agent-api.ts
```

三个 endpoint：

```text
POST /api/internal/agent/execution-profile
POST /api/internal/agent/prompt-context
POST /api/internal/agent/messages-context
```

本阶段不重新设计或扩大这些合同，只验证 1B 的 API 结构迁移仍使用现有唯一入口：

```text
@agent-workbench/shared/internal-contracts/agent-api
```

需要保持的内容包括：

- `AgentApiEndpoints` method/path；
- request/response TypeBox schema 与 `Static<>` 类型；
- stable envelope 与 dynamic content/options/args 的宽松边界；
- API Route 的 serializer/status/error 行为；
- Worker `AgentApiClient` 的 typed response 和 strict/warn validation；
- 敏感 response diagnostic 脱敏。

### Prompt/cache

`AgentService` 当前 read-side 相关方法包括：

- `getExecutionProfileForRun()`；
- `getPromptContextForRun()`；
- `getMessagesContext()`；
- `getSingleCallModelProfileForRun()` 等相邻 profile helper；
- prompt/tool/skill/settings 文件级 helper；
- `runPromptStaticCache` 及其清理/续期逻辑。

本阶段必须在实施前实际确认并记录：

- cache key 是否仍为当前实现的 run identity；
- TTL、Promise reuse、访问续期、terminal clear 的真实调用点；
- static prompt 与动态 transcript/message 的切分；
- prompt/messages 顺序、reasoning 过滤、pending tools、locale fallback、compaction snippet 和 external skill roots；
- profile 对 session/workspace/run 的校验及 provider/model/vision/compaction/runtime 字段。

若实施前发现上述事实与 0005 或本文件不一致，先更新基线，不直接迁移。

### API Route

`apps/api/src/modules/agent/agent.routes.ts` 已使用 Shared read-side endpoint/schema，并在 handler 中调用：

```text
params.service.getPromptContextForRun(body)
params.service.getMessagesContext(body)
params.service.getExecutionProfileForRun(body)
```

1B 的目标是让这些调用继续成立，或通过 facade 等价委派；不在 Route 中增加 prompt 组装、cache 逻辑或 workspace/run 判断。

### Worker Client / Runner

`apps/agent-worker/src/runtime/apiClient.ts` 已通过 shared endpoint/schema 调用：

```text
getExecutionProfile()
getPromptContext()
getMessagesContext()
```

`apps/agent-worker/src/runtime/runner.ts` 使用这些方法驱动模型输入、消息上下文和自动压缩。1B 不改变 Runner 控制流，仅验证 API 侧结构迁移不影响其输入和调用顺序。

## 测试证据基线

### Shared

```text
packages/shared/tests/internal-contracts.test.ts
```

用于证明 endpoint/export/schema 基线，不应因为纯 API 内部结构迁移而改变。

### API

```text
apps/api/src/modules/agent/agent.integration.test.ts
apps/api/src/modules/agent/agent.worker.integration.test.ts
apps/api/src/modules/agent/context-item-contract.test.ts
```

`agent.integration.test.ts` 是跨域综合集，不应一次性重切；1A 只提取它与其他 Agent 测试共同需要的 fixture 能力，1B 随 read-side 领域迁移相关用例。`agent.worker.integration.test.ts` 的真实 API-managed Worker 证据必须保留。

### Worker

```text
apps/agent-worker/src/runtime/apiClient.test.ts
apps/agent-worker/src/runtime/runner.auto-compact.test.ts
apps/agent-worker/src/runtime/runner.tool-output.test.ts
```

1B 若只迁移 API service 内部结构，Worker 测试原则上只运行和必要同步，不重写 Runner 主链测试。

## P0 证据沉淀位置

P0 证据必须按用途沉淀，不能只保留在对话、临时终端输出或审查者记忆中：

| 证据类别 | 权威沉淀位置 | 内容 |
|---|---|---|
| 设计基线 | 本文件 | contract、cache、prompt/messages/profile、错误语义和测试边界 |
| 代码定位 | [`07-code-map.md`](./07-code-map.md) | 当前路径、符号、调用链、规模和候选改动面 |
| 可执行行为证据 | 对应 Shared/API/Worker 测试文件 | characterization、contract、Route、cache、Worker 主链断言 |
| 运行结果与门禁 | [`09-implementation-record.md`](./09-implementation-record.md) | 命令、cwd、结果摘要、失败原因、批次审查/复审结论 |
| 方案偏差 | 本文件或对应设计文件，并在 `09-implementation-record.md` 建索引 | 新事实、影响、替代决策和批准状态 |

记录规则：

- 长期有效的行为事实必须更新本文件，不能只写在运行记录中；
- 符号、路径和调用者变化必须更新代码地图；
- 能自动证明的行为必须落到测试，文档描述不能替代测试；
- 命令完整日志不要求复制进设计文档，但 `09-implementation-record.md` 必须记录命令、cwd、结果摘要和必要的 artifact/失败定位；
- P3-P6 每批开始前，优先复核本文件、代码地图、相关测试和 `09-implementation-record.md` 中最近一次通过的门禁记录。

## 1A 基线冻结证据

1A 完成前必须形成一份可审查的基线记录，至少包括：

| 类别 | 必须记录 |
|---|---|
| 运行环境 | 各 workspace 测试 cwd、Node/TypeScript 构建入口、临时目录根 |
| fixture | dataDir、SQLite、AppContext、createApp、workspace/repo 初始化与清理顺序 |
| read-side contract | 三 endpoint 的实际 method/path/body/status/response schema |
| prompt | cache key/TTL/reuse/clear、messages 顺序与动态字段边界 |
| API | internal token 检查顺序、400/401/404、workspace/session/run 归属错误 |
| Worker | API client 方法、response validation、Runner 调用点和本地 fake seam |
| 证据 | 现有测试命令、通过结果、已知 cwd 限制与未覆盖点 |

上述长期事实必须更新本文件和代码地图；对应测试负责可执行证明；命令与审查结果统一记录到 `09-implementation-record.md`。三者未对齐时，P0 不得通过。
