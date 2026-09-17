# 旧 ContextItem 测试核销与后续重建清单

> 状态：阶段二至八的重建与阶段九清理、升级演练、全仓验收均已完成。本清单保留被删除测试的业务不变量、替代测试和退出理由，作为后续维护 Message / Part / ToolExecution 唯一模型时的核对依据。
>
> 裁决：本次破坏性升级不维持旧扁平消息模型、数字 ID、旧泛化写回接口或旧公开路由的测试兼容。以下测试的 fixture、断言投影和接口入口三者均强耦合已退出模型；继续逐字段迁移会把已删除模型重新引入测试边界。因此删除源文件，而不是以 `skip`、缩减语料或 adapter 保留。
>
> 重建总规则：所有 fixture 必须创建真实 `Message / Part / ToolExecution / Run`。Run 引用真实 `triggerMessageId`；subtask 只使用 `parentRunId + parentToolExecutionId`；ToolExecution 只允许 `queued -> running -> terminal`。公共读取统一为 timeline、message detail、run-state 或 Message projection。禁止重新建立数字 ID 转换、双写或已退出的 HTTP 路由。

## 阶段九最终核销

### 文件安全与可恢复删除补充核销

- `secure-directory.ts` 的 destructive upgrade、Workspace 与附件目录清理共享 retire 协议：业务 entry 在固定 mode `0700` parent 中 rename 到 `.delete-v1-<scope>-<type>-<dev>-<ino>-<nonce>`，复验 `dev/ino/type` 后才删除私有名；递归 child、quarantine root 和遗留扫描同样适用。旧/未知格式、scope 不匹配、symlink、类型异常或 identity mismatch 都是 pending，不自动删除。
- 可检测 replacement 的 `.delete-replacement-pending-*` 是可读诊断优化，不是唯一持久安全状态；marker rename 出现 EIO 时，原 v1 identity 槽仍能使第二次 retry/restart 报告 `replacement_pending`，因此 diagnostic、tombstone、fence 与 `file_cleanup_pending` 不会被误清零。仅 identity 完整匹配的 v1 stale 私有槽可在后续 retry 收敛。
- 该核销采用确认的威胁模型：防御 symlink、父目录/业务名替换、可检测 private-slot replacement 与 syscall 错误；明确排除同 UID 恶意进程在最终 syscall 前对随机私有槽的无限精确抢占，不宣称形式化 inode-bound unlink。
- 附件 temp/final/source cleanup 由 `agent-attachment-storage.test.ts` 覆盖：attachment scope 为业务名派生 token；temp 创建后的 parent 替换不能返回 handle；hard-link 后 final replacement 只可撤回同 source inode；temp parent 在 final link 后变化时优先由原 fd 将业务名或已 retire 槽迁入稳定 cleanup root 内的 v1 槽，janitor 复验后重试，仍不能确认才标识 `sourceCleanupPending`。aged 普通扫描严格只接受 `tmp_<safe-id>.part`，全部 `.delete-*` 只由 private-slot janitor 处理；局部 hook 模拟 unlink EIO，不再 monkeypatch 全局 `fs`。
- `WorkspaceLifecycleCoordinator` 的单进程 admission race、restored tombstone、受控同链重入与跨 Workspace 隔离由 coordinator/service 测试覆盖。真实 Fastify multipart upload restored-fence route 验证 409 与零落盘；确定性竞争验证已入场 upload 结束前 delete intent 等待，intent 后新 upload 被拒绝。所有 Workspace 写入遵循 `lifecycle → workspace/repo lock → side effect`。
- tmux classifier 与 Workspace delete 测试覆盖 explicit not-found、spawn/timeout/unknown 与 partial kill retry；未知 presence 一律保留 tombstone/fence。Terminal auth 的 live 文件从创建起直接锚定 trusted `dataDir` root，以 `.terminal-auth-live-v1-<kind>-<terminalId>` 命名；`tmp` 不参与该协议，writer `EEXIST` 一律 pending，hardlink witness 证明无 authority victim 不被删除或覆盖。每个 secret artifact 分别建立 `(terminal_id, artifact_kind)` authority row，arm 时固定 `root_dev/root_ino`，arm/update/clear 均要求单行 DML 成功并读回验证，INSERT/UPDATE/DELETE `RAISE(IGNORE)` 与 abort 一样阻断状态发布。active 保留每个 recoverable artifact `dev/ino` 与 root anchor，SSH 与 HTTPS askpass/token 不可互相掩盖；root live 或关联 v1 槽首次 EIO 后仅全部 recoverable 行经实际扫描收敛，才可同事务 clear + closed/delete。dataDir root rename 后同路径替换、business/private-slot replacement、unknown、marker EIO、armed/unresolved/legacy 均保留 record、tombstone/fence 与 victim，恢复原 root 路径后才允许重试。schema verifier 仅迁移两种精确单行历史 DDL（四列无 phase，或五列精确 phase CHECK）；两者都要求既定列/PK/FK、唯一命名的普通 `updated_at` index、无额外 index 和无 orphan。缺失或宽松 CHECK、非法 row、错误 FK/index、额外列/index 等未知损坏表均稳定 fail-closed，且不得改写 schema、rows 或 Agent 状态。缺 root anchor 的中间 per-artifact 表仍迁为 `unresolved/root=null`。writer 前 credential/解密/网络环境失败仅在同一进程证明未进入 writer 时原子 clear + closed 并保留原始错误；跨服务 armed 仍阻断。旧 `.terminal-auth-cleanup` symlink 不被穿越。
- `terminal.service.test.ts` 覆盖 `creating → active`、activation 后补偿 kill 失败、new-session response-loss probe 与 fallback 边界；不确定或 cleanup 失败保留 `errored` intent，runtime reconcile 重试并转 `closed`；非 active terminal 不进入对外 active 列表。
- `workspace-deletion-restart.integration.test.ts` 使用真实 SQLite 运行两个 API 生命周期，覆盖 tombstone hydrate、runtime ready resume、最终 DB 删除和另一 Workspace 保持可用；组合场景还须在首生命周期同时保留 deleting Workspace recoverable Run 与另一 Workspace recoverable Run，第二生命周期仅通过 `registerWorkspacesModule()` hydrate fence 后进入 Worker-ready 等价编排，断言前者不 enqueue、后者恢复且 ready 不失败。
- Worker ready 编排覆盖：先续作 tombstone，再扫描 Run；deleting Workspace candidate 在锁前、prepare lock 内和 prepare 后的最终 enqueue lock 均按稳定 `WORKSPACE_DELETING` skip，不 enqueue/reconcile、不转 `AGENT_WORKER_ENQUEUE_UNKNOWN`，且不阻断其他 Workspace recovery。user Run、manual compaction 以及已触发 reconciliation 的 Run 均验证 deletion 赢得最终 handoff 后清 timer/attempt、不重排；删除/Terminal 续作失败保留 durable state 但不杀健康 Worker；只有 ready 编排成功才清零 Worker restart backoff。

- 生产边界只保留 `Session -> Message -> Part -> ToolExecution`：旧 `agent.store.ts`、旧 internal contract 入口、旧公开消息读取/写入路由及旧运行态投影均已删除；静态检索仅在 SQLite destructive upgrade 的旧库识别、清理和对应测试中保留历史表名。
- `apps/api/src/modules/agent/session-routes-module-p0-baseline.test.ts` 已删除。其 durable dedup 不重复创建 User Message / Run 的不变量由 `run-lifecycle-baseline.api.test.ts` 使用 `agent_message`、`agent_message_part` 与 `getMessageRunState()` 重建；enqueue 的网络异常、超时或 ACK 丢失不再错误收敛为 failed/idle，而是保持同一 Run 为 running 并按相同 `runId` reconciliation。
- `packages/shared/tests/agent-image-message.test.ts` 已删除。其旧附件关系 schema 断言由 `packages/shared/tests/agent-message.test.ts` 重建：User Message 的 TextPart 与 ImagePart 通过 timeline 校验，图片只携带 `attachmentId`、`mediaType`、`filename`，并拒绝不支持的 Part 和媒体类型。
- 取消与跨 Run 收敛由 `agent-message.store.test.ts` 的 cancel convergence、`run-lifecycle-application.test.ts`、`run-lifecycle.persistence.test.ts` 及 `agent.worker.integration.test.ts` 的真实 Worker 写回场景覆盖；这些测试以 Run、streaming Assistant Message 和 ToolExecution 状态机断言终态与 fence。
- enqueue 故障注入由 `agent.worker-client.test.ts`、`run-lifecycle-application.test.ts`、`manual-compaction-application.test.ts`、`run-lifecycle-baseline.api.test.ts` 与 `agent-startup-recovery.integration.test.ts` 覆盖：普通 Run 与 `manual_compaction` 复用 `enqueueActivatedRunOrReconcile`；Worker 明确 `4xx` 才是永久拒绝并安全 failed/idle，`5xx`、传输异常、超时和 ACK 丢失均为结果未知，Run/Session 保持 active，短暂 handoff 后按同一不可变 payload 与 `runId` 退避重试。retry sleep 不占用 Session coordinator；cancel 或 Workspace deleting fence 在后续 enqueue 前获胜时阻止 late enqueue，Workspace 删除仍可发现并 drain active Session。`dispose()` 会在模块关闭、Worker/DB 关闭前清除 timer 和 attempt，禁止关闭后重新调度。
- Worker 每个 ready generation 通过 `AgentStartupCoordinator.recoverWhenRuntimeReady()` 触发恢复，API `onListen` 与初始/替换 Worker ready 的重叠调用会合并；扫描中到达的新 generation 会在当前扫描结束后串行补跑一次，而同 generation 的重复通知不并发。恢复仍保持 queued ToolExecution、`running -> unknown`、partial streaming Assistant replacement 与 `manual_compaction` 的 `runKind`；首次 enqueue 结果未知后 integration 测试断言 durable Run 保持 running 并以同一 `runId` 自愈。
- streaming Assistant 的创建与 flush 精确重放已核销：`agent-message.store.test.ts` 要求相同 immutable create 请求返回既有 Message 且不推进 Head/revision，差异 fail closed；真实 Worker route 会先按 `messageId` 识别 existing replay、仅首次创建读取 Session head/CAS，因而 post-commit response-loss 不会被已移动 head 拒绝。Text/Reasoning 已有 Part 必须 type/position 一致，相同累计文本为 no-op，增长只能以前值为前缀。`runner.streaming-flush.test.ts` 模拟 post-commit response-loss，断言 Worker 重试完全相同 create 请求且取消能中断 backoff；ToolCall 的 position、输入和 provider call ID 重放约束不变。
- Prompt/read-side 语义由 `runtime-transcript-projector.test.ts`、`prompt-context-projector.test.ts`、`read-side.api.test.ts`、`sqlite-message-query.test.ts` 和 Web `agentMessageTimeline.test.ts` 覆盖，涵盖祖先链、pending boundary、timeline/detail、图片、ToolExecution 显式关联和 reset/delta/before 行为。
- Worker Message 写回、终态幂等与 Compaction 原子性分别由 `agent.worker.integration.test.ts`、`agent-message.store.test.ts`、`manual-compaction-application.test.ts` 及相关 lifecycle 测试覆盖；不恢复旧泛化写回接口、文件 archive 或 Clear。
- `schema.test.ts` 完成破坏性升级演练：干净库初始化、真实旧库识别和 Agent-only 清理、非 Agent Workspace 数据保留、v18 到 v19 的 `run_kind` 与 Message 图原地保留、unknown/malformed/mixed/future schema fail-closed，以及文件清理的 containment、realpath 与 symlink 边界。
- 附件数量与大小不变量保留，而非退出：`agent-attachment-limits.ts` 的唯一限额为最多 `4` 张、单图 `10 MiB`、总量 `20 MiB`。`agent-attachment-storage.test.ts` 断言常量和单图边界；`agent-message-attachments.integration.test.ts` 经真实 multipart route 验证 4 张接受、5 张拒绝、累计恰好 `20 MiB` 接受，以及由 `10 MiB + (10 MiB - 7) + 8 bytes` 构造的每图均合法、累计 `20 MiB + 1` 拒绝，并断言稳定错误码 `AGENT_IMAGE_TOTAL_BYTES_EXCEEDED` 与错误消息；同时覆盖 ImagePart/attachment 的原子持久化。
- subtask duration 不变量以 ToolExecution 重建，而非旧 child-summary projection：`AgentTimelineToolExecution.startedAt/completedAt` 是唯一时间来源，`AgentSubtaskCard.vue` 仅在两个时间均存在时计算差值并通过 `formatElapsedDuration()` 展示；`subtaskRunDisplay.test.ts` 覆盖负数、零、秒、分钟和小时格式化，`agentMessageTimeline.test.ts` 覆盖 timeline 时间字段的传输形状。旧 summary duration 字段已退出，不再保留兼容投影。
- 渠道 `/l`、`/t` 读取不恢复旧 tail：`agent-peripheral-status.integration.test.ts` 覆盖当前可见链的 completed Assistant 文本、最新 todolist ToolCall 的最小 Feishu 投影（仅 `resultPreview`、`structuredResult`）、空结果与 token/plugin/workspace 边界；`plugins/feishu/tests/session-read-client.test.ts` 覆盖客户端窄化路径与可注入 dispatch 的结果、空、未绑定、API 错误、structuredResult 优先和 preview 回退。
- Web 测试门禁由 `apps/web/scripts/run-tests.mjs` 递归发现 `src/**/*.test.ts`，若 `src` 缺失或发现零测试即失败；因此 `agentImageAttachments.test.ts`、恢复的 `subtaskRunDisplay.test.ts` 及后续新增测试均自动纳入，不再依赖易遗漏的手写清单。

## 阶段六旧文件 archive / Clear 核销记录

- 已删除 `archive-read-application`、`archive-storage`、startup reconcile、archive wiring 及 `compaction-archive` 的实现和单测；它们的原业务目标是旧文件 archive 的追加、读取、检索与启动补偿，但事务边界和可见性均绑定旧 ContextItem / 文件 archive。阶段七负责以 SQLite archive + FTS5 重建 `archive_read` / `archive_search`，不得恢复文件 archive、sidecar 或 reconcile 兼容层。
- 已删除 `agent-archive-compaction.integration.test.ts` 与 `agent-session-control.integration.test.ts`。前者验证旧 compaction 后 archive sidecar 的读取与检索，后者验证 Clear 及其 archive 写入、并发和 subtask 限制；两者均以已移除的文件 archive 和 `/clear` 为入口，不能迁移为新 Message 行为测试。
- Clear 的产品能力、Shared 契约、公开路由、Worker capability、提示词与前端 slash-command 文案均已退出。阶段九只需重建新的 Manual/Automatic Compaction Message 图 CAS、原子性和 UI 投影组合回归，不得重新引入 Clear、文件 archive sidecar 或 sidecar rollback。
- 已保留并继续扩展新模型的 Fork / 回退 / Compaction Store、应用层与 Worker 测试：其职责是覆盖共享 Message 前缀、CAS、`replacesMessageId = null`、唯一预期 TextPart、不可变请求精确重放、contextRoot 边界、终态 ToolExecution、Provider retry 与取消，不依赖 archive sidecar。

### 阶段七核销

- `apps/api/src/modules/agent/archive/agent-archive-store.test.ts` 已重建 SQLite `archive_read` / `archive_search` 与 FTS5 trigram 覆盖：completed eligible TextPart 写入、Reasoning/失败 Assistant 排除、map/rowid 一一对应、**公开重建入口自身事务原子且失败保留旧索引**、contextRoot 祖先范围、完整稳定 keyset 分页、`limit + 1` 精确 nextCursor 边界、共享前缀可见性、中文检索、短 query 与伪造/失效 cursor 拒绝。`archive_search` 将输入整体作为转义后的普通 phrase 文本，不开放 FTS 查询语法；特殊字符检索不会泄露 SQLite/FTS parser 错误。FTS/map 写入失败仍会使 completed Message 事务整体回滚。
- `apps/api/src/infra/db/workspace-agent-data-cleanup.test.ts` 已覆盖 `foreign_keys=ON` 下 FTS/map、Run、Session、共享 Message/Part、附件的单事务清理。`agent-message.store.test.ts` 覆盖 Workspace 范围 DB-first active Run 收敛（queued/running ToolExecution 终态、跨 Workspace 隔离）。删除服务先写 durable `workspace_deletion` intent 并恢复跨重启 fence，随后复用 `SessionRuntimeHandoffCoordinator` 在无 SQLite 写锁时 `cancel-and-wait` Worker queued/running drain；drain、tmux、文件安全清理或 final DB 失败均保留 intent/fence，重试或启动续作后才完成物理删除。附件 temp/final 与 upgrade quarantine 的 symlink、父目录替换以及读取 fd 绑定由附件/schema 单测覆盖，外部 victim 不得删除或泄露。

## 阶段八核销

- `AgentClientPane.vue` 已改用 `GET /timeline` 的 `Session.revision` / `sinceRevision` 增量读侧；普通响应只按 `Message.updatedRevision`、`ToolExecution.updatedRevision` upsert，`timelineReset` 时整体替换当前可见链并清空按需详情缓存。
- Conversation 以 `Message` 顺序与 `Part.position` 展示 Text、Reasoning、Image、ToolCall；ToolCall 仅通过 `ToolCallPart.id === ToolExecution.callPartId` 关联执行状态。Reasoning 完整展示，不参与任何模型写入或上下文逻辑。
- 高频 timeline 仍只使用轻量 `resultPreview/error/resultTruncated`。新增当前 Session 可见链受限的 ToolExecution detail 路由，详细 `structuredResult` 仅在用户点击支持的工具详情时读取，前端不从 preview 反序列化、推断或覆盖权威字段。
- Pane 已恢复 slash `/compact`、自定义全局 prompt、`@` skill/文件候选、图片粘贴与多图发送/预览、会话模型覆盖、Workspace AGENTS/skill/Agent 设置入口、stick-to-bottom、滚动到底部按钮、fork/revert/cancel 与子任务入口；均不依赖旧 ContextItem 读侧。
- `agentToolExecutionDisplay.test.ts` 断言富卡解析只接受按需 detail 的 `structuredResult`，子任务仅接受显式 `subtaskSessionId`；`read-side.api.test.ts` 断言 detail 受当前可见链限制，且 timeline 不泄漏 `structuredResult` 与 artifact path。
- `apps/web/src/features/workspace/tools/agent/agentMessageTimeline.test.ts` 已重建并纳入 web 测试脚本，覆盖正常 delta upsert、过期 revision 不回退、`timelineReset` 丢弃旧分支、混合 Part 的 `position` 顺序以及 `callPartId` 显式关联。
- Agent Conversation 主路径不再调用 `/context-items`，也不包含 `/clear` UI 或 slash command。
- H1 / M2：timeline 明确区分 `snapshot`、`delta`、`before`。snapshot 与 `timelineReset` 必定整体替换本地 Message/Execution；delta 携带已知 head/contextRoot 前提，失效时服务端返回受 `limit` 约束的尾部 reset snapshot。`SqliteMessageQuery` 覆盖有界尾页、before cursor 分页、失效 cursor、head/contextRoot 变化；前端 controller 覆盖替换、prepend、详情缓存清理和陈旧响应拒绝。
- H2：`apply_patch` / `write` artifact 改由 `workspaceId + sessionId + toolExecutionId` 唯一寻址；服务端仅允许当前可见链中、ToolCall 名称匹配的 execution。富卡 URL、缓存 key 和编辑器 tab key 均使用 execution ID。集成测试覆盖同一 Message 两个同名 `apply_patch` 分别读取对应 artifact，以及 toolName/session 不匹配返回 404。
- M1：slash 发送语义已提取为纯逻辑。`/compact` 始终优先；非展开自定义 prompt 在发送时精确展开；设置尚未加载时按需刷新；未知 slash 原样发送；自定义 `/clear` 只作为普通 prompt，绝不恢复 Clear 行为。
- M3 / L1：timeline 请求、响应序列、snapshot/reset、before 分页状态已抽到 `agentTimelineController.ts` 并有单测；工具展示、detail 按需加载和富卡渲染已拆入 `AgentConversationToolCall.vue`，子任务独立为 Message 模型 `AgentSubtaskCard.vue`。Pane 已正常格式化，不再以单行 40KB 形式维护。
- L2：SubtaskCard 仅组合 ToolCall `input`、轻量 execution 和 detail `structuredResult`：展示 description、agent、mode、权威 status、started/completed duration、`resultText` 与显式 `subtaskSessionId` 跳转；不解析 timeline preview。
- M4：普通 delta 仅更新 Message / ToolExecution 与 session 同步锚点，不覆盖已经加载的 `hasMore` / `nextBeforeMessageId`；仅 snapshot、reset 或 before page 应用服务端分页元数据。
- M5：timeline 与 ToolExecution detail 请求均绑定 `workspaceId + sessionId + generation`。scope 切换时清空 timeline/detail/loading、递增 generation 并可立即请求新 snapshot；旧 scope 的响应、错误与 finally 均不得写入或清理新 scope 状态。
- 前端专项复审核销：`agentTimelineRefreshScheduler.test.ts` 覆盖在途 delta/before 后
  snapshot 排队、`snapshot > delta > before` 优先级、Revert/Compaction epoch 失效和
  before cursor 回退 snapshot；`running -> idle` 在 Pane 中无条件请求最终 snapshot。
- `agentCompactAttempt.test.ts` 覆盖 `/compact` response-loss 重试复用同一
  `clientRequestId`；`agentToolDetailCache.test.ts` 覆盖 completion delta 先到后旧
  detail 丢弃、同 execution 乱序与不可见 execution；`agentArtifactRequestGuard.test.ts`
  覆盖 artifact 卡片卸载/scope 切换 abort 后不打开 editor。
- `agentMessageMutationGuard.test.ts` 覆盖同一来源 Message 的 Fork/Revert 双击互斥；
  `AgentClientPane` 将同一 guard 接入控件禁用和 emit 前请求路径。
- L3：SubtaskCard 的 mode 优先读取 ToolCall `input.session.mode`，顶层 `input.mode` 只保留早期数据兼容；子任务 session ID 仍只接受 detail `structuredResult.subtaskSessionId`。

## 阶段五核销记录

- `runner.tool-output.test.ts` 覆盖普通工具的 `8,000 / 3,000 / 200,000` 文本规则、`subtask` 不截断、artifact 基于 `toolExecutionId`、同 execution 的安全重写，以及非法 execution ID、父目录和目标符号链接拒绝。
- `runner.tool-output.test.ts` 覆盖遗留 `running` ToolExecution 不被 Worker 执行、写回或伪造为失败；恢复后的 `unknown` 由现有 Runtime Transcript Projector 投影固定不确定结果信封。
- `runner.cancel.test.ts` 覆盖同一 `runId` 在运行中重复 enqueue 不创建第二个 Worker 实例，完成后释放去重标记。
- `agent-startup-recovery.integration.test.ts` 覆盖启动恢复将 `running -> unknown`、保留 `queued`、partial streaming Assistant 原子 supersede + replacement，以及重复恢复不重复创建 replacement；已有用例覆盖最终 fence 下 cancel wins。
- `agent-subtask-lineage.integration.test.ts` 与 Subtask API/Worker 测试继续使用 `parentToolExecutionId`；生产与测试目录不存在 `parentToolItemId` 残留。
- Fork 继续共享 Message / Part / ToolExecution，artifact 路径只存于共享历史 execution；不复制 artifact，亦不将历史 terminal execution 放入 pending 执行集合。
- H1 / M1：启动恢复准备事务返回 `{ prepared, resumeAssistantMessageId }`；空 streaming Assistant 传原 ID，partial Assistant 传 replacement ID，无 Assistant 传 `null`。同一事务稳定写入“任务正在自动恢复”、`retryCount=0`、`nextRetryAt=null`，final fence 下 cancel wins。
- H1：恢复 enqueue 经 Runtime、Worker HTTP schema 和 `QueuedRun` 透传 continuation。Worker 仅在真正进入首次模型 step 前认领它，验证 run fence、workspace/session/run 归属、streaming status 与 active assistant；`ignored` 视为 stale 并停止，成功后复用且不创建新 Message。queued 工具优先执行，continuation 不会提前消费。
- M2 / M3：`agent.worker.integration.test.ts` 使用真实 API-managed Worker 与本地 LLM SSE stub 覆盖空 streaming 复用、partial replacement 复用、running execution → unknown（不调用工具、模型接收 unknown 信封）以及 queued execution 的单次恢复执行和重复 recovery/enqueue 去重；均断言最终 Run idle、非终态集合清空。
- D2：Worker 和 API composition 双层仅允许 `apply_patch`、`todolist`、`subtask`、`write`、`scratchpad` 持久化 `structuredResult`；普通工具保留 `resultPreview`，恶意 read 写回的结构化值也会被 API 丢弃。
- M4：`apiClient.test.ts` 明确将 `resumeStreamingAssistant` 分类为 `controlWrite`，并覆盖共享端点请求/响应；`server.test.ts` 覆盖旧 enqueue payload 缺少该 optional 字段时归一化为 `null`，以及恢复 Message ID 正例透传。
- M5：本地 fallback `AgentRuntime` 使用 `queuedRunIds + activeRunIds` 双层去重，终态 finally 释放 active 标记；单测覆盖 active 期间重复 enqueue 只执行一次，以及完成后的再次 enqueue 可执行。
- M6：Worker 通用 ToolExecution writeback 对五个白名单工具和 read/bash/plugin 普通工具使用表驱动覆盖；API 集成测试经完整 internal route 与真实 SQLite DB 验证所有白名单持久化、普通工具拒绝且保留 `resultPreview`。
- L1：四个 startup recovery API-managed Worker 集成用例共用终态断言：Run `completed`、state `idle`、active Run/Assistant 为空、两类 nonterminal 集合为空、notice 为空、`retryCount=0`、`nextRetryAt=null`。
- D1 Compaction 有限重试仍明确留在阶段六，本阶段未变更该行为。

## 阶段四 H1 / M1 / M2 / M3 / M4 重建记录

- **Fenced write 收敛**
  - Worker 仅将 `updated` 视为 flush、Assistant complete、replacement、notice 和 ToolExecution 写回成功；`ignored` 停止旧 Run，`missing` 作为可诊断不变量失败。
  - flush 网络异常保留内存中的完整 Text、Reasoning 与 provider 顺序 ToolCall 快照，并在当前写回恢复后重新提交。
- **retry notice 时机与原子替代**
  - 请求开始不再清理 retry notice；首个有效 Part 成功持久化后，或 Assistant 成功完成后，才清理 notice 并重置 `retryCount=0`、`nextRetryAt=null`。
  - 部分输出重试的 replacement RPC 同时携带 `runNoticeText`、`retryCount`、`nextRetryAt`；Store 在 supersede、新 Assistant、Head/revision/run-state 切换的同一事务内写入。
- **H2 / H4 控制面传输重试与错误边界**
  - 重试 notice 清理、Part flush、Assistant complete、replacement、retry notice 与 ToolExecution 写回均使用专用、可 abort 的固定短间隔重试；每次重试复用同一请求快照。
  - 仅内部 RPC 的 network、timeout，以及 HTTP `408`、`425`、`429`、`5xx` 可在控制面原地重试；`updated` 后继续，`ignored` 停止 stale Run，`missing` 进入 failed 收敛。
  - HTTP `400/401/403/404/405/409/422`、无效响应和程序错误会标记为永久控制面失败，直接进入 `processRun` 的 failed 收敛，绝不进入 Provider retry、replacement 或重复模型调用。
- **H3 精确重放幂等**
  - Store 对已完成 Assistant、已 superseded replacement、terminal ToolExecution 仅在请求与既有提交结果逐字段一致（包括 `updatedAt`、执行集合、状态、结构化结果、artifact、时间及 RunState retry metadata）时返回 `updated`；差异重放 fail closed 为 `ignored`。
  - flush 的既有 Part 重放和 notice 的等值写入保持幂等；Worker route 集成测试模拟首次真实提交成功后客户端丢失响应，再以同一 payload 重放 complete（含 ToolCall）、replacement 和 terminal ToolExecution。
- **阶段四默认门禁覆盖**
  - `runner.streaming-flush.test.ts` 覆盖 fenced flush 网络恢复、`ignored`/`missing`、complete `ignored`/`missing`、replacement stale 停止，以及携带 `status` / `statusCode` 的 HTTP 400/401/403/404/429/500、network 的 Provider 退避恢复。
  - 同文件通过真实 request controller 覆盖 idle（无事件 pending）和 total（持续事件不结束）timeout：超时后重试并成功，不误判为用户取消；并覆盖 retry notice 首次控制面网络失败恢复、持续失败由用户取消中断，均不会 replacement 或重发模型。
  - `runner.stop-condition.test.ts` 覆盖 model step 与 ToolExecution 写回 `ignored` 时整 Run 静默停止、不调用 `completeRun`，以及 `missing` 时 `completeRun("failed")` 恰好一次。
  - Store、RPC client 与 Worker route 覆盖 replacement retry metadata 的传输和原子落库。

## 阶段六 D1 待办

- 重建阶段六的历史组合回归时，继续覆盖 cancel 后所有晚到 fenced write 都不能覆盖取消 notice；不得重新引入 partial prompt continuation、普通模型有限重试或 `modelRetry` helper。

## 阶段四：已替换的旧模型重试测试

### `apps/agent-worker/src/runtime/modelRetry.test.ts`

- **原场景与不变量**
  - 以有限 `maxRetries` 决定模型请求是否失败。
  - 将 partial Assistant Text 追加到下次 provider prompt，以“续写”方式重试。
  - ToolCall 被视为不能重试的局部输出。
- **删除原因**
  - 有限次数重试与当前“模型错误持续退避、由用户取消”的产品契约冲突。
  - 将 partial Text 注入下一次 prompt 违反 `superseded + replacement` Message 语义，并会污染只沿 `previousMessageId` 的正常 transcript。
  - 旧 helper 无生产调用，且不能表示 Reasoning 或 ToolCall 的完整持久化与替代。
- **阶段四重建方式与核销证据**
  - `runner.streaming-flush.test.ts` 覆盖空输出复用同一 streaming Assistant、retry notice 元数据与清理、连续六次失败后恢复及单次退避上限。
  - 同文件覆盖 partial Text / Reasoning / ToolCall：先 flush 旧 Message，原子替代为新 Message；Reasoning 不进入下一模型请求；ToolCall 保持 provider 顺序且 superseded 尝试不创建 ToolExecution。
  - 同文件覆盖 cancel during backoff，不得发起下一次模型请求。
- **核销状态**：已删除旧 helper/测试；阶段四核心语义已重建。

## 已删除文件与阶段九重建项

### `apps/api/src/modules/agent/integration/agent-run-cancel.integration.test.ts`

- **原场景与不变量**
  - 用户 cancel 保留历史，但将 active streaming assistant 与正在运行工具收敛为 `cancelled`，RunState 回到 `idle`。
  - subtask 工具取消时保持结构化 child/session 结果，不把运行态文本误当作新的业务结果。
  - Worker `run-complete(cancelled)` 收敛同一 Run 的全部非终态对象；同一终态 complete 请求可安全重放。
  - 回退后的不可见分支仍能由 Run 归属收敛；仅含脏非终态对象的已终态 Run 不得被改写为 cancelled。
  - cancel 级联只取消当前 active parent run 的 child lineage，不能误取消历史 fork child。
- **旧模型耦合与删除原因**
  - 使用 `ContextItem`、`moveSessionHead`、`triggerItemId`、`parentToolItemId`、数字 `itemId`、旧 `/context-items` 投影与已删 run-state fixture。
- **阶段九重建方式**
  - 建立 `trigger user Message -> active Run -> streaming assistant Message -> ToolCall Part -> queued/running ToolExecution`。
  - 以 `/timeline`、`/messages/:messageId`、`/run-state` 断言 assistant/ToolExecution 的终态、Session `headMessageId/revision` 与 active fence。
  - 隐藏分支由共享 Message graph 的 Session head 回退制造；验证 `cancelRunAndConverge()` 对 run-owned detached Message/Execution 的收敛。
  - child 通过真实 `parentRunId + parentToolExecutionId` 建立，分别构造 active 与历史 child。
- **归属阶段**：阶段九（生命周期取消与跨 Run 清理回归）。
- **核销状态**：已重建；`agent-message.store.test.ts`、lifecycle 持久化/应用测试及 `agent.worker.integration.test.ts` 覆盖 Run 收敛、fence、子任务 lineage 与真实写回。

### `apps/api/src/modules/agent/integration/agent-prompt-context.integration.test.ts`

- **原场景与不变量**
  - 工具 allowlist、subtask 可见性、英文 schema/工具说明、depth/max-depth 的 subtask 过滤。
  - locale 对 output/runtime prompt 的影响、非法 locale 回退、session/global locale 回退。
  - ToolCall + ToolExecution 的 prompt 投影，包括 `apply_patch`、`todolist` 的输入/输出及 todolist 对标题的影响。
- **旧模型耦合与删除原因**
  - 大量 `createContextItemInternal`、旧 `uiLocale` Run 持久列预期、`pendingTools[].itemId`、旧工具 item/output 投影；该模型和当前 locale-neutral Run 定义冲突。
- **阶段九重建方式**
  - 从真实 user trigger Message 创建 Run，使用 assistant ToolCall Part 及关联 ToolExecution（完成必须经 running）。
  - 对 `POST /api/internal/agent/prompt-context` 断言 `messages`、`pendingTools.toolExecutionId/callPartId/assistantMessageId/status/toolName`，不再断言 itemId。
  - locale 仅验证现行可用来源与 `null` 的 locale-neutral 语义；若产品重新定义 locale 继承，先更新契约再添加相应案例。
  - 阶段三已由 `runtime-transcript-projector.test.ts` 重建祖先/context root、`previousMessageId` 单链、Reasoning/runtime 过滤、System 文本、历史图片占位、多 ToolCall 顺序及唯一结果信封、所有终态空结果、artifact/structured result 排除等核心投影规则。
  - Worker streaming 以 Provider 到达顺序维护有序 Part：相邻同类 delta 仅追加末尾 Part，类型切换新建稳定 `id/position`；`text → tool → text`、`reasoning → text → tool → reasoning` 与多 ToolCall 混排均不重排，ToolExecution 的 `callPartId` 直接取实际 ToolCallPart。
  - `runner.streaming-flush.test.ts` 覆盖多次 flush 后既有 Part 标识和位置稳定；`runtime-transcript-projector.test.ts` 与 Web `agentMessageTimeline.test.ts` 核销有序投影、Reasoning 排除和按 `position` 渲染。
  - artifact 在已验证真实目录中通过随机临时文件排他创建、保持打开的 fd 写入和同目录原子 rename 提交；发布前验证 temp pathname 仍为该 fd 的普通 inode，发布后验证 dirfd/正式读取路径均指向该 inode、大小和内容一致，再复验当前 artifact 目录 inode/realpath/containment。`runner.tool-output.test.ts` 覆盖 temp、目标或父目录在 rename 前后被替换为外部 symlink/其他路径：外部路径不被修改，目录变化时仅经 dirfd 撤回本次 inode 并 fail-closed；测试错误落盘统一使用 `mkdtemp` Workspace，不在仓库创建 `.awb` 副产物。
  - 阶段三已由 `read-side.api.test.ts` 重建真实 SQLite 路由契约：queued/running ToolExecution 返回 `200 + pendingTools` 且在所属 Assistant 前截断；终态后返回完整 ToolCall/Result 信封，并校验 shared response schema。
  - 阶段三 M3 已由 `agent.worker.integration.test.ts` 通过本地可控 OpenAI SSE provider 覆盖真实 API-managed Worker 闭环：首轮 ToolCall、queued PromptContext、`queued -> running -> completed` 写回、终态 ToolCall/Result 第二轮投影与 Run completed；同时验证 ToolCall ID、结果顺序与 Reasoning 不回传。`runtime-transcript-projector.test.ts` 和 `prompt-context-projector.test.ts` 另覆盖历史 terminal 轮次、同 Assistant 混合 terminal/pending 的整体边界，以及多 pending Assistant 的最早链上边界。
  - 阶段九保留工具 allowlist、subtask 深度、locale、todolist 标题/截断及复杂组合语料回归。
- **归属阶段**：阶段九（prompt projection 完整语料回归）。
- **核销状态**：已核销；现有 projector、read-side API 和真实 Worker 闭环共同覆盖新契约的核心与组合语料，不再持久化旧 locale 或 item 投影。

### `apps/api/src/modules/agent/integration/agent-read-context.integration.test.ts`

- **原场景与不变量**
  - 消息去重、静态 prompt cache、execution profile 只读性、image/placeholder 投影、reasoning 不回传、失败 assistant 文本投影、archive 隔离。
  - 增量读、单体详情、subtask child card 映射、冲突 fail-open、terminal elapsed 展示等读取边界。
- **旧模型耦合与删除原因**
  - 公开 `/context-items`、after/before numeric item window、ContextItem reasoning/output/boundary 字段和旧 child tool-card 归属均已不再是权威投影。
- **阶段九重建方式**
  - Timeline 测试从 `headMessageId` 沿 ancestor chain 读取，使用 `sinceRevision` 而非 numeric item window；detail 通过 Message ID。
  - reasoning 用 ReasoningPart，验证 prompt projection 排除 reasoning；image 用 ImagePart/attachment 关系。
  - child 映射只沿 `parentRunId + parentToolExecutionId`，ToolCall Part 与 ToolExecution 一一对应；冲突/缺失 child 必须不泄漏其他 fork 分支。
  - archive 断言属于阶段七的 SQLite archive + FTS5 `archive_read` / `archive_search` 覆盖，且不得作为正常 public timeline 回退；不重建文件 sidecar。
- **归属阶段**：阶段九（Message read-side、prompt 和 UI projection 回归）。
- **核销状态**：已重建；`sqlite-message-query.test.ts`、`read-side.api.test.ts`、`runtime-transcript-projector.test.ts` 与 Web timeline 测试覆盖 Message read-side、detail、pending boundary 和 UI 投影。

### `apps/api/src/modules/agent/context-item-contract.test.ts`

- **原场景与不变量**
  - 旧泛化 Context create/update、旧 compact/Clear、旧文件 archive rollback sidecar、旧 run-state token、旧 Context CAS/fence 的大规模契约语料。
- **旧模型耦合与删除原因**
  - 覆盖的泛化 Worker Context 写回端点、ContextItem schema 和 `agent_context_item` 事务均已删除；保留会鼓励恢复已禁用能力。
- **阶段九重建方式**
  - 分拆到 `agent-message.store.test.ts`、Worker Message 写回路由测试和 Compaction 测试。
  - 覆盖 append/flush/complete/update 的 fence、idempotency、CAS，以及 Compaction Message 提交的 Run fence 与原子性，使用 Message/Part/ToolExecution/Run 状态机。
- **归属阶段**：阶段九（消息写回与 Compaction 原子性回归）。
- **核销状态**：已重建；`agent-message.store.test.ts`、`manual-compaction-application.test.ts`、lifecycle 测试和 Worker 集成测试覆盖写回、精确重放、CAS、Run fence 与原子性。

### `apps/api/src/modules/agent/query/context-query-application.test.ts`

- **原场景与不变量**
  - 旧 transcript window、Context head rollback、artifact 通过可见 item 授权、旧 child summary/duration 投影与批量读取。
- **旧模型耦合与删除原因**
  - 被测 `ContextQueryApplication` 是旧 ContextItem read-side；artifact 已明确隔离为 `410 CONTEXT_ITEM_ARTIFACT_REMOVED`，不能作为正常读路径。
- **阶段九重建方式**
  - 使用 `SqliteMessageQuery`：ancestor timeline、Message detail、ToolExecution 轻量投影与 UI artifact 的 `Message ID -> ToolCall Part -> ToolExecution ID` 授权。
  - child duration/状态在新的 timeline or dedicated run projection 契约确定后重建；禁止从 provider toolCallId 或 numeric item 反推。
- **归属阶段**：阶段九（新 read-side 投影替代测试）。
- **核销状态**：已重建；`sqlite-message-query.test.ts`、`read-side.api.test.ts`、artifact 集成测试和 Web ToolExecution 展示测试覆盖可见链查询、轻量投影、详情与 execution-ID artifact 授权。

### `apps/api/src/modules/agent/writeback.api.test.ts`

- **原场景与不变量**
  - 旧 create/update Context 写回路由真实 wiring、终态幂等和不重写 SQLite 的行为。
- **旧模型耦合与删除原因**
  - 依赖已删除的 Context writeback application 和内部接口。
- **阶段九重建方式**
  - 针对 Message Worker 端点分别验证 streaming assistant 创建、Part flush、assistant complete、ToolExecution update、run notice/complete。
  - 终态重放需保持 Message/Execution 及 Run fence 不被晚到请求覆盖。
- **归属阶段**：阶段九（Worker Message API wiring 回归）。
- **核销状态**：已重建；`agent.worker.integration.test.ts` 覆盖内部端点令牌、流式替代、ToolExecution 写回、Run complete 及 response-loss 精确重放。

### `apps/api/src/modules/agent/archive/compaction-archive.persistence.test.ts`

- **原场景与不变量**
  - 摘要插入、请求 item 归档、head 移动、stale head 预检和事务回滚。
- **旧模型耦合与删除原因**
  - `agent_session_head`、ContextItem archive 标记和旧文件 archive persistence 事务已退出正常模型。
- **阶段九重建方式**
  - 用 `commitCompactionMessageWithRunFence()`：验证 Run fence、`expectedHeadMessageId + expectedRevision` CAS、精确幂等重放、summary Message 成为新的 head/context root，以及 SQLite 事务失败时不前移指针。
- **归属阶段**：阶段九（Message compaction 持久化回归）。
- **核销状态**：已重建；`agent-message.store.test.ts`、`manual-compaction-application.test.ts` 和 Worker compaction 集成场景覆盖 CAS、精确重放、context root 更新及失败不前移。

### `apps/api/src/modules/agent/agent-image-message.routes.test.ts`

- **原场景与不变量**
  - multipart 顺序、图片类型/数量/字段校验、临时文件清理、fork 后附件可见性及文件不重复复制。
- **旧模型耦合与删除原因**
  - 通过 ContextItem attachment relation、`messageItemId` 和旧 archive item 断言附件归属。
- **阶段九重建方式**
  - 阶段二已由 `agent-message-attachments.integration.test.ts` 重建 Message 附件基础：真实 staging、文件先行提交、`agent_attachment -> ImagePart -> User Message -> Run/dedup/run-state` 单 SQLite 事务激活，以及 activation 前/后失败的清理语义。
  - multipart 已覆盖 payload 位于图片前、中、后，以及非法 field、重复 payload、超 part 数、缺 boundary、非法 JSON/schema、非法签名和无暂存残留。
  - `run-lifecycle.persistence.test.ts` 的真实 SQLite/文件系统组合测试覆盖两图第二张 `EEXIST` 时保留既有 final、link 后 unlink 失败的 application cleanup，以及 attachment insert 后 SQLite trigger abort 的全事务回滚和本请求 final 清理。
  - multipart dedup 覆盖首次 final 保留、重复请求新 staging/final 清理，以及 attachment 记录不增加。
  - 生命周期已由 `run-lifecycle-application.test.ts` 覆盖第二张文件提交失败、link 成功后 unlink temp 失败、DB activation 失败清理 final，以及 cancel 在最终 enqueue fence 获胜时保留取消历史且不入队。
  - 阶段九只保留组合 UI 场景：图片展示/preview 交互，以及 fork、Compaction、revert 后的 UI 联动；不得重复或回退阶段二的基础安全回归。
- **归属阶段**：阶段二基础测试已完成；阶段九仅组合 UI 场景。
- **核销状态**：旧测试已删除，基础 Message 模型测试已重建。

### `apps/api/src/modules/agent/attachments/agent-attachment-content.routes.test.ts`

- **原场景与不变量**
  - 鉴权优先级、关系授权、inline header、流式响应、404 隐藏策略以及 symlink/realpath 边界。
- **旧模型耦合与删除原因**
  - 授权关系从 ContextItem attachment relation 出发，当前 Message ImagePart 授权尚需专门新投影入口。
- **阶段九重建方式**
  - 阶段二已由 `agent-message-attachments.integration.test.ts` 以 Session 当前 `contextRootMessageId ~ headMessageId` ancestor chain 的 ImagePart 为授权源，覆盖 detached branch、compaction root 前附件、关系缺失、storage/size 不一致均为 404，及 inline headers、streaming payload。
  - 文件安全矩阵已覆盖 attachment root、`by_workspace`、workspace、目标文件 symlink，目标缺失/目录与 realpath containment；其中 `agent-attachment-storage.test.ts` 为四个不同路径返回相应 directory/file `Stats`，记录并断言 root、workspace、target 三次 `realpath` 调用，且 target 返回越界路径实际触达 containment 拒绝分支。认证启用时未认证请求优先为 401，不探测文件状态。
  - `SessionRuntimeHandoffCoordinator` 是单 API 进程、按 Session 的进程内 handoff mutex；root send 的最终 fence/enqueue acknowledgment、cancel 的 DB 收敛/runtime cancel、startup recovery fence/enqueue，以及 manual compaction enqueue 使用同一实例。单测覆盖 throw/reject 后释放、相反 multi-lock 顺序无死锁、重复 ID 去重、多锁失败后全部释放；应用测试覆盖 send/recovery 和 manual compaction 与 cancel 的双向 deferred 竞争。
  - child activation 在同一 SQLite transaction 中执行 parent fence：parent Run 与 parent `session_run_state` 必须均为 running、`active_run_id` 匹配，且 `parentToolExecutionId` 必须属于 parent Run 的 running `subtask` ToolExecution。fence 失败返回 `AGENT_SUBTASK_PARENT_NOT_ACTIVE`，不创建 child Message/Run/state；child 先提交时 cancel lineage 可发现并收敛，cancel 先提交时 activation 不产生 recovery candidate。
  - M9 对本次 materialization 创建的 subtask Session 使用单 SQLite transaction 的严格补偿删除：绑定 `createdSessionId`、kind、预期 parent/fork metadata 和 idle run-state，拒绝任何该 Session 的 Run、origin Message/ToolExecution、dedup、model override、后代 fork/lineage 引用。fork 的共享 head 不阻止补偿，且绝不删除共享 Message / Part / Execution；真实 SQLite 覆盖 fork materialization 后 parent cancel 触发 `AGENT_SUBTASK_PARENT_NOT_ACTIVE`、activation trigger 失败，以及 existing Session 不被补偿。
  - `agent-attachment-storage.test.ts`、`run-lifecycle-application.test.ts`、`session-runtime-handoff-coordinator.test.ts`、`subtask-application.test.ts`、manual compaction 与 subtask activation persistence 测试均纳入默认 API `test:session-model`。
  - `run-lifecycle.persistence.test.ts` 已使用真实 Message / Part / Run / `session_run_state` fixture 覆盖 lifecycle fence 场景，并纳入 `test:session-model`。
  - 阶段九只保留图片 preview、fork/Compaction/revert 组合 UI 流程；不得恢复全局附件路由、ContextItem relation 或数字 ID fixture。
- **归属阶段**：阶段二基础安全测试已完成；阶段九仅组合 UI 场景。
- **核销状态**：旧测试已删除，基础 Message 模型测试已重建。

## 已删除的专用辅助代码

### `context-writeback.helpers.ts` 的旧导出

- **删除项**：`createP3Fixture`。
- **原因**：仅被已删除的 run-cancel 测试使用；名称与旧阶段语义绑定，不承载领域规则。
- **保留项**：`createSession`、`appendMessageFixture`、`createMessageRunFixture`、`createAssistantFixture`、`completeToolExecutionFixture`、`setRunNoticeFixture`，仍由阶段二 Message 测试使用。
- **阶段九要求**：新测试复用保留 helper，或在需要不同图形时新建 Message 专用 helper；不得恢复 Context fixture facade。

## 阶段二保留覆盖与核销准则

- 保留 `agent-message.store.test.ts`、`sqlite-message-query.test.ts`、Session interaction/lifecycle 测试、Message-model integration、startup recovery、subtask lineage/prefork、SQLite archive、Compaction、artifact ToolExecution 测试。
- `schema.test.ts` 保留 destructive upgrade 及旧表移除验证；其中为升级验证而临时创建旧表的 fixture 不构成生产兼容层。
- `agent-session-routes.integration.test.ts` 继续承载公共 Message 路由的错误映射，包括本阶段新增的 `SESSION_NOT_FOUND -> 404`。
- 阶段九重建前必须先冻结新的 read-side、attachment 和 prompt projection 契约；本清单不是恢复旧接口的授权。
- 后续故障复审补充：reconciliation 在后台 retry 遇到永久 enqueue 拒绝并完成 settlement 后，必须删除该 Run 的 retry attempt，避免保留无效进程内状态。
- 后续 generation 故障复审补充：generation 1 扫描阻塞期间 generation 2 ready，随后 generation 1 抛错时，协调器记录旧错误并仍串行执行 generation 2 recovery；失败的同一 generation 不会被自动无界重扫。
- 后续 streaming Assistant 重放复审补充：existing-ID 的不可变差异只映射为稳定 `409 AGENT_STREAMING_ASSISTANT_REPLAY_MISMATCH`，真实内部路由返回该代码；Worker 将其分类为永久 control error，不执行 100ms retry、不启动模型，并以 `completeRun(failed)` 收敛。未知 Store / SQLite 异常仍沿原内部错误路径传播。
- 前端专项复审核销：`agentTimelineRefreshScheduler.test.ts` 覆盖 tail/pagination 独立 intent、公平调度、cursor 失效后的 `before → snapshot → before`、多页耗尽结算、structural retry、epoch 与 abort/dispose；不得恢复单槽 `snapshot > delta > before` waiter 合并。
- M4 核销：structural retry 仅允许初始一次加 `structuralRetryDelaysMs.length` 次，永久失败 reject 并清理状态；timer 期间 delta 不得提前重试、pagination 可独立完成，成功和 dispose 均无残留 pending。`agentMessageMutationAction.test.ts` 覆盖 Revert/Compact 结构刷新耗尽后 finally 释放 pending。
- `agentCompactAttempt.test.ts` 以 `ApiError.code/status` 覆盖未知结果保留 ID、enqueue 明确拒绝/4xx 清除和 scope 新 ID，不允许匹配错误文案。
- `agentToolDetailCache.test.ts` 覆盖 timeline revision、可见性与 request sequence 防止旧 detail 回填。
- M8 核销：`agentArtifactCards.component.test.ts` 通过 `vite-node + happy-dom + @vue/test-utils` 挂载真实 ApplyPatch/Write SFC，验证真实 fetch signal、props scope 更新/卸载后的普通晚到结果静默；`AgentMessageActions.component.test.ts` 真实点击 DOM 后验证 Session-wide disabled 与完成恢复，而非只测试 helper。

- 文件安全复审 H1/H2/H3/M1/M2/M3 已由 `secure-directory`、`agent-attachment-storage`、`workspace-lifecycle-coordinator` 专项测试核销：quarantine 的固定 dirfd 递归删除和 inode 替换 victim 保护、附件 temp/final 晚替换撤回、fd 读取、restored tombstone 跨 Workspace 隔离及 mutation admission 竞争均已覆盖；不再依赖可替换 pathname 的 recursive rm 或授权后的字符串路径重开。
