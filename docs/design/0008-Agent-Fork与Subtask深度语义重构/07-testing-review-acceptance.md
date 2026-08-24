# 测试、代码审查与验收标准

## 验收原则

本方案不是只验证“模型重新看到 subtask”，而是验证新的领域边界完整成立。

验收证据必须覆盖：

- 写入数据；
- HTTP contract；
- context clone ownership；
- prompt tools 投影；
- internal subtask 生命周期；
- 历史 session 新 Run 自愈；
- 失败回滚和兼容性。

## 测试矩阵

### Primary Ordinary Run

| 场景 | 断言 |
|---|---|
| 新建 primary 首次发送消息 | depth=0，双空 parent |
| primary 继续发送消息 | 每个新 Run 仍为0 |
| source 历史 Run depth=2 后公开 fork | target ordinary Run=0 |
| source 历史 Run depth=null 后公开 fork | target ordinary Run=0 |
| 从一次 fork 的 copied user item 再 fork | target ordinary Run=0 |
| 从一次 fork 的 copied assistant item 再 fork | target ordinary Run=0 |
| 连续多次 fork | 每个 target ordinary Run=0 |
| 历史异常 primary 最近 Run=null | 下一新消息 Run=0 |
| 历史异常 primary 最近 Run=2 | 下一新消息 Run=0 |
| primary compact | compact Run=0，双空 parent |
| internal runs/trigger | 委派后 Run=0 |
| subtask session send/compact/clear | 均返回 `400 AGENT_SUBTASK_READONLY`，不修改head/run-state/archive |

### Public/Generic Session Contract

| 请求 | 结果 |
|---|---|
| public create 合法 body | 201 primary |
| public create 含 kind=primary | 400 |
| public create 含 kind=subtask | 400 |
| internal create 合法 body | 201 primary |
| internal create 含 kind | 400 |
| public fork primary source | 201 primary |
| public fork 含 kind | 400 |
| public fork source=subtask | 400 + 稳定 source kind 错误码 |
| public fork boundary=tool/system | 保持现有 boundary error |
| public fork invalid/archived item | 保持现有错误语义 |

Unknown field拒绝采用已选定的双层机制：Shared schema `additionalProperties:false` + 三个endpoint各自的`preValidation` key allowlist。验收必须包含：

- P0在真实`createApp()` HTTP链路中记录当前Fastify+TypeBox行为；
- P0证明`preValidation`拿到schema validation/strip前的原始keys；
- public create、internal create、public fork分别测试`kind=primary`、`kind=subtask`和另一个任意unknown key；
- 所有请求返回同一个稳定unknown-field错误码和`400`；
- handler/service未执行，数据库没有创建session；
- 合法body仍进入handler并成功。

如果上述生命周期证据无法成立，验收必须停止并回到设计。不得把字段被strip后成功、只在TypeScript报错、只验证schema object或修改全局Ajv视为通过。

### Context Clone Ownership

公开 primary fork和internal subtask fork都必须检查：

- copied item 在 target session 中有新 item id；
- `runId = null`；
- `turnId = null`；
- `step = null`；
- `prevId` 和 head 链正确；
- terminal status 规整保持；
- archiveAt 映射保持；
- source item 不被修改；
- source Run 查询结果不混入 copied item。

### Public Fork Archive

覆盖：

- `visible_only`；
- `with_archive`；
- archived boundary；
- archive sidecar 内容；
- sidecar 写失败删除 target session 和目录；
- 二次 fork 仍按 target session 当前 transcript 正确处理。

### Internal Subtask Depth

配置 `maxSubtaskDepth=2`：

| Run | Depth | 工具/创建结果 |
|---|---:|---|
| primary ordinary | 0 | subtask 可见 |
| child 1 | 1 | subtask 可见 |
| child 2 | 2 | subtask 不可见 |
| 尝试 child 3 | 3 | API 拒绝 MaxDepthExceeded |
| historical unknown parent | null | 工具隐藏，start拒绝 DepthUnknown |

### Internal Subtask Mode

所有模式必须按下表断言session metadata、context和Run创建。幂等命中是独立前置分支：只返回既有child，不创建新session/item/Run。

| 路径 | metadata断言 | clone断言 | item顺序 | Run断言 |
|---|---|---|---|---|
| `new` | parent session/tool | 无clone | prompt | 新child，parent+1，真实parent双字段 |
| `fork` + summary | parent session/tool | 无clone | summary→guard→prompt | 同上 |
| `fork` + boundary | parent session/boundary | visible clone | clone→guard→prompt | 同上 |
| `fork` + null boundary | 双空 | 无clone | guard→prompt | 同上 |
| `existing` | 原值不变 | 无clone | existing head→prompt | 新child，depth取本次parent+1 |

summary、guard、copied items的`runId`必须为null；prompt item的`runId`必须为本次child Run。任何新建session分支在事务失败后不得留下session；existing失败不得改写既有metadata。

#### New

- 创建 `kind=subtask` session；
- child depth parent+1；
- 真实 parent fields；
- prompt item 属于 child Run。

#### Fork

- 复制预期 parent context；
- 不复制触发轮不应传递的 assistant/tool；
- guard 位于 copied history 与 prompt 之间；
- copied items runId null；
- child Run 真实 parent fields；
- public primary source kind限制不误伤内部路径。

#### Prefork Summary

- summary path 不复制完整 parent history；
- summary → guard → prompt 顺序不变；
- summary/guard runId null；
- child prompt item runId=child Run。

#### Existing

- 可复用内部创建的 subtask session；
- missing sessionId；
- missing session；
- primary kind mismatch；
- foreign workspace；
- running session；
- idempotent child session mismatch；
- 本次 depth 来自当前 parent，不来自 existing session latest Run。

### Parent Relation 与幂等

- 同一 `(parentRunId,parentToolItemId)` 重试返回同一 child Run；
- 不同 existing session 请求与已有 child 冲突；
- parent tool 必须属于 parent Run；
- tool name 必须 subtask；
- ordinary primary Run 不写 parentRunId；
- `listSubtaskChildSessionIdsByRunId()` 只返回真实 subtask child；
- cancel cascade 不把普通 fork session 当 child。

### Prompt/Read-side

`PromptStaticAssembler` 单元测试继续覆盖：

- depth 0 + Agent enabled subtask → 包含；
- depth 1/max2 → 包含；
- depth 2/max2 → 不包含；
- null → 不包含；
- Agent tools 未启用 → 不包含。

API read-side/integration 增加：

- 二次 fork target 新 Run 的 prompt context 包含 subtask；
- 工具可见性来自 Run depth=0；
- 不向 prompt assembler传 session kind特殊旁路。

### 历史数据

构造旧 primary session：

- latest Run depth null；
- latest Run parentRunId 非空、parentToolItemId 空；
- copied item runId null。

新消息后断言：

- 新 Run depth 0；
- 新 Run parent双空；
- 历史记录未被改写；
- 新 Run tools 正常；
- 已启动旧 Run 的 tools 不要求热更新。

## 手工验收场景

### 用户问题复现路径

- 建立 primary A 并完成一轮；
- 从 A 某 user/assistant item fork B；
- 在 B 中选择 copied history item fork C；
- C 发送：“请列出你能看到的工具”；
- 确认模型工具请求实际包含 `subtask`；
- 让模型调用一次 subtask，确认 child 正常执行。

不能只依赖模型自然语言回答。应同时通过服务端测试/日志或 API prompt context 证据确认工具快照。

### 多层限制

- primary 调 child 1；
- child 1 调 child 2；
- child 2 不应看到 subtask；
- 验证 max depth 仍有效。

### UI

- 新建 session 正常；
- primary fork 正常；
- subtask session UI 无 fork/输入能力；
- session list kind 展示和只读策略不回归；
- 设置帮助文案符合新语义。

## 代码审查清单

### 领域语义

- ordinary primary Run 是否在所有入口固定 depth0？
- 是否仍有任何 source item/source Run depth 推导？
- public fork 是否仅 primary→primary？
- generic internal create 是否也 primary-only？
- subtask session 是否只有 internal start 可创建？
- subtask session的send/compact/clear是否全部保持同一只读错误？
- existing 是否只复用内部 subtask session？

### 数据完整性

- copied item 是否仍 runId=null？
- ordinary primary parent字段是否双空？
- child Run 是否同时写两个 parent字段？
- anchor ownership 与 toolName校验是否保留？
- 是否错误收紧 store nullable type导致历史数据不可读？

### 架构边界

- public fork 与 internal subtask fork 是否使用不同 application入口？
- clone primitive 是否只做复制，不计算 depth？
- `createPrimarySession`是否只接受workspace/title且不接fork metadata？
- public fork/subtask application是否只能经private materializer落盘？
- 函数虽可改名，但Route→application→materializer→store的调用方向是否保持？
- 是否仍存在 `allowAnyKindBoundary` 公开开关？
- public Route 是否可能调用 private subtask create？
- internal subtask是否绕过自身depth/anchor校验直接create？

### Contract

- Shared schema 是否移除 kind？
- unknown field 是否在真实 HTTP 层被拒绝？
- AgentSessionRecord.kind 是否误删？
- internal subtask contracts是否无漂移？
- 新错误码是否稳定且归属正确？

### Prompt/Worker

- PromptStaticAssembler规则是否保持？
- 是否增加了 session.kind旁路？
- Worker subtask start payload是否保持？
- tool registry/pending tool snapshot是否无关改动？

### 回归与清理

- 旧错误规格测试是否替换？
- public create subtask fixture是否全部清除？
- resolveRunLineageForSession是否删除？
- imports/dead code是否清理？
- archive rollback、orphan、cancel测试是否通过？

## 阻塞级审查问题

出现以下任一项，审查必须不通过：

- primary Run 仍可能写 null或非零depth；
- copied item保存source runId；
- public/internal generic create仍可创建subtask；
- public fork可从subtask source或创建subtask target；
- internal subtask fork因public规则被破坏；
- PromptStaticAssembler把unknown当0；
- existing模式从session历史继承depth；
- 只修改UI、未做服务端校验；
- HTTP unknown field被静默接受；
- unknown-field拒绝只存在于类型/schema单测，没有真实HTTP生命周期证据；
- 为实现局部请求拒绝而未经设计修改全局Ajv行为；
- 失败路径留下orphan subtask session。

## 验收标准

### 功能

- 用户报告的二次 fork 问题可稳定复现旧行为，并由新实现修复；
- primary fork次数不影响subtask可见性；
-真实subtask最大深度仍生效；
- existing/new/fork无回归。

### 数据

- 新 ordinary primary Run组合唯一：`0/null/null`；
- 新 child组合：`parent+1/non-null/non-null`；
- copied item ownership不变；
- 历史记录不被批量修改。

### Contract

- 三个generic create/fork request不再接受kind；
- 响应record仍能表示subtask；
- internal subtask contract保持。

### 质量

- 定向测试和相关回归通过；
- build/typecheck通过；
- 实际执行命令及未纳入门禁的已知 Worker 全量枚举失败，以[实施与验收记录](./10-implementation-record.md)为准；不得将该枚举测试表述为全量通过；
- 独立审查和修复复审通过；
- 无 schema migration；
- 非目标未混入。

## 发布后验证

- 观察 public/internal create/fork 400 是否暴露旧外部客户端；
- 验证插件 primary创建正常；
- 验证旧异常 primary session发起新Run后恢复；
- 若出现 subtask不可见，优先检查新Run记录的 depth和Agent tools，不回退prompt安全过滤。
