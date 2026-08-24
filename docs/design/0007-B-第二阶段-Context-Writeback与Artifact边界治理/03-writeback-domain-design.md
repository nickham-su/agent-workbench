# Context Writeback 领域设计

## 设计目标

把 Worker context create/update 从 `AgentService` 的跨域实现中收敛为明确的应用边界，同时保持：

- Shared/Route/Worker 调用面不变；
- Store transaction/fence/CAS 不变；
- normal/ignored/unchanged/error 语义不变；
- P0 已确认纳入的 artifact 与 title 副作用顺序不变；
- 本地 fallback runtime 继续使用 `AgentService` 兼容入口。

候选组件名只表达职责，不冻结最终类名。

## 目标调用链

```text
Worker / local runtime
  → AgentService facade
  → ContextWritebackApplication
      ├─ CreateContextItem use-case
      ├─ UpdateContextItem use-case
      ├─ AtomicContextWritebackPersistence
      ├─ ContextArtifactWriter
      ├─ SessionTitleUpdater
      ├─ clock
      └─ logger
```

Route 继续调用 facade；本阶段不要求 Route 直接注入 application。

## Context Writeback application entry

建议暴露与当前 service 等价的内部 use-case：

```text
appendContextItemFromWorker(input)
updateContextItemFromWorker(input)
```

它负责：

- 一个完整 create/update 用例的编排；
- Store 原子结果到当前 response/`HttpError` 的映射；
- `apply_patch` create 禁止规则；
- title 更新的触发时机；
- artifact writer 的调用时机；
- full result 到 slim DB output 的转换编排；
- 记录有限、脱敏的 conflict/artifact warning/error。

它不得：

- 自己拆开 Store transaction 做 ownership/run/head 判断；
- 修改 run-state、complete/cancel/recovery；
- 读取 UI artifact 作为应用查询；
- 处理 compaction/archive/subtask；
- 接收完整 `AgentService` 或完整 `AppContext`；
- 修改 Shared response shape。

## Create / append 用例

### 输入

直接使用现有：

```text
AgentApiCreateContextItemRequest
```

application 不创建新的 transport DTO；如需内部类型，只能是对现有输入的窄别名或 persistence 参数，不得改变合同。

### 编排

```text
validate apply_patch completed-on-create prohibition
  → choose createdAt
  → persistence.appendWithRunFence(input)
  → map result
  → on appended completed todolist: update title
  → return normal response
```

### Persistence result

建议 capability 保留与当前 Store 等价的可判别 union：

```text
appended(item)
ignored
missing-session
workspace-mismatch
missing-run
run-mismatch
```

不要为了“统一错误”将其压成 boolean/null/exception；当前 union 精确表达 normal、late、missing 和 ownership。

### Head conflict

`AgentConflictError` 可以继续由 persistence 抛出并由 application 映射，也可以由窄 adapter 转为显式 `conflict` 结果；选择必须满足：

- Store 仍是 head CAS 权威；
- `currentHeadItemId` 的有限 warning 保留；
- HTTP 仍为 `409 session head conflict`；
- 不以 retry 掩盖 conflict。

阶段初稿推荐保留当前异常类型映射，减少行为变化。

### Side effect

`todolist` title 更新只发生在 append 成功后。推荐以窄 callback 表达：

```text
updateSessionTitle({ sessionId, title, updatedAt })
```

application 继续拥有“何时更新”的决定；callback 只执行持久化，不重新判断 tool 语义。

## Update 用例

### 为什么保留两次 fence

当前 update 有两个不同目的的 DB 边界：

- 初步 fence：在解析大 result、写 artifact 前快速拒绝 missing/ownership/late/terminal；
- 最终 fence：在文件副作用后、DB update 前再次原子确认 run/item 仍可更新。

本阶段默认保留这一结构。初步 fence 不是最终一致性保证，最终 `updateContextItemWithRunFence()` 才是 DB 权威。

### 编排

```text
persistence.inspectForUpdate(itemId)
  → missing / ownership / unchanged 映射
  → derive nextStatus / nextOutput
  → maybe prepare/write apply_patch artifact and slim result
  → [仅当 P0 决定纳入] maybe handle adjacent write artifact
  → persistence.updateWithRunFence(...)
  → missing / ownership / unchanged 映射
  → on updated completed todolist: update title
  → return item
```

### 初步 fence result

建议保持当前 union：

```text
updated(item)       # 表示当前可继续，不表示已写 DB
unchanged(item)
missing
ownership-mismatch
```

若命名 `updated` 容易误导，可在 adapter 内改名为 `writable/current`，但必须记录映射并保证 Store 原始语义不变。不得因此修改现有 Store 结果或生产行为，除非有独立审查理由。

### Update response

application 返回 `AgentContextItemRecord`，Route 保持包装：

```text
{ ok: true, item }
```

late/terminal update 返回 stored item，不返回 `ignored`，不新增 status code。

### 状态单向收敛

Store 继续负责终态保护：

- `completed`；
- `failed`；
- `cancelled`；

一旦 terminal，不允许 update 回非终态。application 不复制终态集合形成第二套规则；它只消费 persistence 的 unchanged 结果。

### Side effects

- apply_patch artifact 仅按现有 tool/status 条件尝试；write 只有在 P0 纳入后才进入同一编排；
- final Store unchanged 时不触发 title 更新；
- successful completed `todolist` 才更新 title；
- P0 已确认纳入的 artifact 若已写但最终 Store unchanged，其现有行为必须由证据冻结，P5 不得静默清理或回滚。

## Atomic persistence capability

### 设计原则

能力按原子业务操作表达，而不是按表建立通用 repository。

候选最小面：

```text
appendWithRunFence(input)
inspectForWorkerUpdate(itemId)
updateWithRunFence(input)
```

可直接使用现有 Store 函数作为函数式依赖，不要求新建 interface/class。只有在以下收益成立时才建立 adapter：

- 隐藏全域 Store import；
- 形成领域化导出边界；
- 便于 application 单测注入，同时真实 SQLite 测试仍验证 Store；
- 不弱化 transaction 和 result union。

### 禁止的伪分层

不得实现：

```text
application:
  getSession()
  getRun()
  getRunState()
  getHead()
  if (...) update/append()
```

该模式会把已解决的竞态重新引入 service/application。

### Persistence 测试

- Store 原子测试必须使用真实 SQLite；
- 可使用 transaction hook/受控顺序证明 final fence；
- application 单测可以 stub capability 验证映射，但不能替代 SQLite 证据；
- 不建立 fake Store 作为 writeback 正确性的主要证据。

## Facade 策略

迁移完成后：

```text
AgentService.appendContextItemFromWorker()
AgentService.updateContextItemFromWorker()
```

只能：

- 透传参数；
- 调用 Context Writeback application；
- 透传同步/异步返回与错误。

不得继续保留：

- apply_patch tool 判断，以及 P0 决定纳入后的 write tool 判断；
- Store result 映射；
- title 更新；
- artifact path/写文件；
- conflict warning；
- terminal/ownership 判断。

需要增加 facade 直接委派测试，沿用 0007-A 的 `agent.service.facade.test.ts` 风格或建立 writeback 专属测试，具体在 P2 设计时决定。

## 依赖与装配

### 允许依赖

- 三项原子 persistence function/capability；
- artifact writer capability；
- session title updater；
- `nowMs` 等 clock callback；
- logger 的最小 `warn/error` 能力；
- Shared request/response 类型。

### 禁止依赖

- 完整 `AppContext`；
- 完整 `AgentService`；
- runtime enqueue/cancel；
- read-side prompt application；
- Run Lifecycle service；
- archive/subtask/session 全域 service；
- UI Route 或 Fastify request。

### Composition

初期允许在 `AgentService` constructor 中装配函数式依赖，类似 0007-A 的 read-side 过渡方式。`agent.module.ts` 不应承载 writeback 业务判断，只构造 `AgentService` 和既有 runtime。

### P2 过渡边界

P2 的目的只是让 composition root、构造依赖和领域边界可审查，不是建立一个长期存在的 `application → legacy callback` 代理层。优先选择“只装配、不改调用链”的空骨架；若为了证明参数、错误和依赖方向必须引入 callback 过渡，则必须同时满足：

- callback 直接指向当前唯一 legacy 实现，不复制任何业务判断；
- 过渡链在代码和 `09` 中显式标记；
- P3 删除 create callback，P4 删除 update callback，artifact callback 最迟按 P5 决策删除；
- callback 没有明确下一批删除计划时，P2 不得合入；
- 不以统一接口为理由创建无行为的多余代理层。

## 测试结构建议

候选领域文件：

```text
apps/api/src/modules/agent/writeback/
  context-writeback-application.ts
  context-writeback-application.test.ts
  context-writeback-persistence.test.ts
```

文件名可调整。测试分层：

- application tests：结果映射、调用顺序、title/artifact 触发；
- persistence tests：真实 SQLite fence/CAS；
- Route/contract tests：真实 Fastify；
- Worker client tests：Shared endpoint/validation；
- API-managed Worker：真实请求顺序。

## 迁移与删除条件

- P2 默认只建装配和窄依赖骨架；如存在显式 legacy callback，必须按上述下一批删除条件处理，不得保留到 P6；
- P3 完成 create 后，create 规则的唯一权威必须在新 application；
- P4 完成 update 后，update/terminal/ownership 规则的唯一权威必须在新 application + persistence；
- P5 完成 artifact 后，service 内 artifact 写入 helper/编排应删除或只保留 Query 所需 capability 委派；
- P6 检索旧 helper/import/Store 直接调用，确认没有第二套规则。

## 方案允许的合理调整

可以调整：

- class 或函数式 application；
- persistence adapter 是否独立文件；
- create/update 是否同一 application 内两个方法；
- artifact capability 的具体方法数量；
- 测试文件拆分。

不得调整：

- 权威规则和依赖方向；
- Store 原子边界；
- Shared/HTTP/Worker 合同；
- late/conflict/not-found 语义；
- artifact 顺序和失败政策（除非触发停止并单独决策）。
