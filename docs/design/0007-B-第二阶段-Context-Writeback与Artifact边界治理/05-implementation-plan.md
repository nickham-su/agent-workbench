# 分批实施计划

## 固定实施节奏

每个批次遵循：

```text
实施前复核
  → 小批实现
  → 定向测试 + 必要回归
  → 独立审查
  → 修复
  → 独立复审
  → 用户明确允许后暂存
  → 下一批
```

不得因为本方案已覆盖 P0-P6 就一次性实施全部内容。P0 没有冻结事实时不得进入 P1/P2；P2 骨架通过前不得迁移 create/update；P4 通过前不得处理 artifact 共享边界。

## 批次总览

| 批次 | 目标 | 生产代码范围 |
|---|---|---|
| P0 | 写侧基线冻结 | 原则上不修改；必要 characterization tests |
| P1 | 最小写回测试地基与证据索引 | 测试代码；仅必要时最小扩展 testkit |
| P2 | Writeback 骨架与窄依赖 | 最小 application/capability/装配骨架 |
| P3 | Create / append 迁移 | application、facade、create 领域测试 |
| P4 | Update / 状态收敛迁移 | application、persistence adapter、update 领域测试 |
| P5 | Artifact capability 与 apply_patch/write 边界 | artifact capability、Writeback/Query 委派、artifact tests |
| P6 | 清理、完整回归与最终审查 | 删除过渡实现、测试归属、文档/代码地图 |

批次可进一步拆小，不得将 P3-P5 合并。

## P0：写侧基线冻结

### 任务

- 首先完整记录 `git status --short --branch`，标明所有 staged/worktree/untracked 项及归属；非本阶段变更一律不可触碰；
- 复核 Shared create/update endpoint、schema、normal/ignored/update response；
- 复核 Worker client method/path/body/response validation/conflict；
- 复核 Route auth/schema/status/Service 连接；
- 逐行记录 `appendContextItemFromWorker()` / `updateContextItemFromWorker()`；
- 记录 create 的 apply_patch 禁止规则和 todolist title side effect；
- 记录 Store 三项原子能力的 transaction、result union 和 head CAS；
- 记录 artifact path、安全 I/O、full/slim split、失败政策和文件/DB 顺序；
- 运行并索引 `context-item-contract.test.ts` 的纯 writeback 场景；
- 索引 `agent.integration.test.ts` 的 apply_patch/write artifact 场景；P0 已以生产生成点和定向测试确认 write 纳入。
- 运行 Shared、Worker client、API-managed Worker 相关基线；
- 记录 cwd、命令、结果、耗时、预期日志和资源清理；
- 补缺失 characterization tests，但不移动生产逻辑。

### P0 必答问题

- create ignored 是否在所有 terminal/switch 分支不改 context/head/title/run-state；
- missing run 是否始终 404；
- head conflict 是否始终 409；
- update 初步/final fence 各自目的与竞态证据；
- update late 是否返回 stored item 且不写 DB；
- artifact 已写但 final fence unchanged 的现状；
- artifact 写失败/路径失败后的 DB/output 行为；
- write artifact 是否有明确生成源码、是否属于 API writeback 主链；
- 若证据成立，write completed/failed/cancelled 的 artifact 与 args/result 差异，以及是否纳入本阶段；
- artifact Query 的 realpath/containment/symlink 失败实际 status/body；
- 当前 fixture 是否可复用 0007-A testkit 而不削弱 archive 专属差异。

### 交付

- 更新 `02-baseline-and-evidence.md`；
- 更新 `07-code-map.md`；
- characterization tests；
- `09-implementation-record.md` 的命令、结果、缺口和 P0 门禁；
- P1 最小测试需求清单。

### 门禁

P0 已确认 write 主链、Query symlink `400 Invalid path` 与写入目录安全失败后仍 slim update；final fence 后文件副作用仍缺受控竞态证据。不得为 P0 扩大 fault seam；后续迁移若不能先补足该证据，必须停止。

## P1：最小写回测试地基与证据索引

### 原则

优先复用 0007-A 已冻结的：

```text
createAgentTestFixture()
createTestWorkspace()
injectJson()
```

但不得为了“统一 fixture”强制迁移 `context-item-contract.test.ts` 的 archive fault/sidecar setup。

### 任务

- 将纯 writeback 测试与 compaction/archive 测试建立清晰索引；
- 选择至少一组 Route/writeback 测试验证现有 testkit 可用；
- 选择至少一组真实 SQLite fence/CAS 测试作为后续 persistence 证据；
- 如多个本阶段测试确有相同 session/run/context 准备，先用领域文件私有 helper；
- 只有两个以上独立测试文件以相同语义复用时，才考虑最小 testkit 扩展；
- 任何公共 testkit 变化都必须记录默认值、所有权、teardown，并重新执行受影响的 0007-A testkit 审查门禁。

### 禁止项

- fake Store；
- 隐式 createEverything builder；
- 扩张 `AppContext.agentTestFaults`；
- 把 Worker 子进程/socket/LLM stub 纳入公共 fixture；
- 为 Run Lifecycle/Subtask/Archive 预建 builder；
- 以迁移测试为由删除关键事务/文件断言。

### 退出条件

- 真实 SQLite/Route/Worker 证据未减少；
- writeback 测试可独立定位；
- testkit 未扩张，或扩张已完成单独审查与复审；
- P2 不依赖尚未定义的公共 helper。

## P2：Writeback 骨架与窄依赖

### 任务

- 建立 Context Writeback application/coordinator 骨架；
- 定义三项原子 persistence 函数式依赖或窄 adapter；
- 定义 title updater、clock、logger 最小依赖；
- 定义 apply_patch artifact writer 占位边界，但不迁移完整 artifact 规则；
- 在 `AgentService` 中完成最小装配；
- 优先只建立装配边界和窄依赖对象，不改变调用链；只有证明 facade/application 参数和错误透传确有必要时，才允许短期显式 callback 指向唯一 legacy 实现；
- 增加骨架委派/依赖测试。

### 约束

- 新组件不接收完整 `AppContext`/`AgentService`；
- 不移动 create/update 业务规则；
- 不修改 Store、Shared、Route、Worker；
- 不让 application 依赖 lifecycle/read-side/archive/subtask；
- 不抽取不满足“无行为纯 helper”的函数；
- 不建立无删除计划的 application → legacy 代理层；如使用 callback，必须在代码和 `09` 标明 P3/P4/P5 的精确删除批次。

### 退出条件

- 依赖方向可审查；
- 编译和骨架测试通过；
- legacy 仍是唯一权威，或短期 callback 链清楚且不复制规则；
- 不存在计划保留到 P6 的多余代理层；
- P3 可单独迁 create 并独立回滚。

## P3：Create / append 迁移

### 任务

- 迁移 apply_patch completed-on-create 禁止规则；
- 迁移 createdAt default；
- 通过原子 capability 调用 append fence；
- 迁移 Store result 到 `HttpError`/response 的映射；
- 迁移 conflict warning 和 `409`；
- 迁移 todolist title side effect；
- `AgentService.appendContextItemFromWorker()` 变为纯委派；
- 删除 legacy create 实现；
- 建立 create domain/facade/persistence/Route 测试索引。

### 必测

- normal complete record；
- ignored union；
- missing session/run；
- workspace/run mismatch；
- head conflict；
- terminal/switch 不改 DB/head/title/run-state；
- Store transaction authoritative；
- apply_patch create prohibition；
- todolist title 只在成功分支触发。

### 停止条件

任何需要改变 response/status、head CAS、Store union、title 产品行为或 Shared schema的情况。

## P4：Update / 状态收敛迁移

### 任务

- 迁移初步 fence 结果映射；
- 保留 `nextStatus`/`nextOutput` 计算；
- 迁移最终 `updateWithRunFence()` 调用与结果映射；
- 保持 terminal 状态单向收敛由 Store 权威实现；
- 暂时可通过窄 legacy apply_patch artifact collaborator 调用现有编排，明确删除期限为 P5；write 只有 P0 纳入后才进入该 collaborator；
- 迁移 todolist title side effect；
- `AgentService.updateContextItemFromWorker()` 变为纯委派；
- 删除非 artifact 的 legacy update 规则。

### 必测

- normal update；
- missing item；
- ownership mismatch；
- terminal item unchanged；
- terminal/switch run unchanged；
- final fence race unchanged；
- unchanged 不触发 title；
- successful todolist update 触发 title；
- update response 始终 complete item，无 ignored。

### 停止条件

需要改 item status policy、ownership status/body、两次 fence、Store transaction 或 response shape。

## P5：Artifact capability 与 apply_patch 边界

### 建议拆分

若改动量较大，将 P5 拆为：

```text
P5-A 安全 Artifact capability
P5-B Writeback artifact 编排与 Query 复用
```

### 任务

- 盘点安全目录、realpath、no-follow I/O 的全部调用者，确认 compaction snippet 等相邻路径；
- 提取受限 artifact path 与 artifact wrapper；底层安全原语只有在不造成 Compaction/Archive 反向依赖时才机械等价迁移；
- 为 capability 建安全与失败测试；
- Writeback 迁移 apply_patch trigger、split、payload、日志和 slim output；
- Query 的 apply_patch artifact 读取改用同一 capability；
- 只有 P0 已记录生成源码、主链归属、行为矩阵并通过独立审查时，才在本批同时迁移 write；否则 write 明确后置；
- 保持 Query 的 item/tool 校验和 404 映射；
- 保持初步 fence → artifact write → final fence；
- 保持 artifact 失败后继续 slim DB update；
- 删除 service 内重复 artifact 写入编排；底层 fs helper 只有在其全部现有调用者已安全迁移时才删除；
- 不处理 compaction/archive filesystem。

### 必测

详见 `04-artifact-boundary-design.md` 与 `06-testing-review-acceptance.md`。

### 停止条件

需要改变 path/format/order/failure/orphan policy，或 capability 必须开放任意 path/接收完整 AppContext。

## P6：收尾、完整回归与最终审查

### 任务

- 检查两个 `AgentService` facade 只委派；
- 删除 legacy create/update/artifact helper/import；
- 检查新 application 无完整 AppContext/AgentService/runtime；
- 检查 Route/module 不承载 writeback 规则；
- 检查 Store 原子能力仍为唯一 transaction 权威；
- 迁移或索引 `context-item-contract.test.ts` 的本域测试，保留 archive/compaction 理由；
- 完成 Shared/API/Worker build/typecheck/test；
- 评估 UI artifact 手工验收；
- 更新 README、基线、代码地图、实施记录和偏差；
- 由新审查视角做阶段最终全面审查；
- 发现问题后修复并再次复审。

### 完整回归最低范围

- `packages/shared/tests/internal-contracts.test.ts`；
- `apps/api/src/modules/agent/context-item-contract.test.ts`；
- writeback/artifact domain tests；
- `apps/api/src/modules/agent/agent.integration.test.ts` 的相关场景或完整文件；
- `apps/api/src/modules/agent/agent.worker.integration.test.ts`；
- `apps/agent-worker/src/runtime/apiClient.test.ts`；
- 必要的 Worker runner tests，证明 writeback 调用顺序未因 API 结构断裂；
- 根级 build/typecheck/diff check。

## 回滚单元

- P1：回退测试迁移/testkit 扩展，不影响生产；
- P2：删除骨架和装配，恢复 facade 直接 legacy；
- P3：以 create 为单元恢复旧唯一实现；
- P4：以 update 为单元恢复旧唯一实现；
- P5：恢复 service 内 artifact 读写唯一实现，不保留两套 capability；
- P6：仅做收尾，不应引入难以独立回退的业务变化。

任何回滚都不得修改 Shared contract、DB schema 或已冻结数据。
