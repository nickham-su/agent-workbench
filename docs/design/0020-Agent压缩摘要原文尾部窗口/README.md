# Agent 压缩摘要原文尾部窗口

## 文档定位

本文档集定义 Agent 压缩摘要保留最近原文尾部窗口的完整产品与技术方案，同时作为开发实现、代码审查、自动化测试和验收的权威基线。

方案面向尚未发布的新 Message 模型，不兼容旧消息数据，也不提供双读或旧数据迁移逻辑。

## 目标行为

```text
运行时静态 system
→ 摘要 S
→ 压缩前保留的最近原文尾部 B
→ 摘要提交后新增消息
```

尾部目标预算固定为 20,000 EstimatorV1 tokens。摘要只覆盖 B 之前的前缀 A。

## 核心结论

- `retainedFromMessageId` 只属于 `CompactionMessage`；尾部终点复用 `previousMessageId`。
- 尾部按安全原子块选择，不拆 Message，也不拆 Assistant/Tool 关系。
- API 输出 `ResolvedContextBlock`；Worker 分别生成主 profile 的 `PrimaryMaterializedBlock` 和 provider-neutral `SummaryInputBlock`。
- `PrimaryMaterializedBlock` 是附件展开前的 provider-neutral 请求语义；Estimator 在 `attachment_ref` 阶段运行，随后请求阶段才展开 file bytes。
- Plan 冻结来源 ID、A/B、成本和不含秘密的 `profileFingerprint`，不冻结跨 Provider wire message。
- Estimator生产接口固定为`estimatePrimaryMaterializedBlock(block)`；每Block以整个canonical消息数组为根，只做一次ceil/1.10，总成本逐Block求和。
- compaction source 请求固定为 `{workspaceId,sessionId,runId}`；API 在单个 SQLite deferred 只读事务中返回同一快照；locale 本次固定为 null。
- work deadline 在 source 调用前启动并覆盖 source、物化、规划、摘要、重试、CAS重规划、收益检查和 commit 尝试。
- proactive 总计15秒；manual总计120秒；recovery standard/full各45秒，只有转入full时重置为新的45秒。
- `agent_run.execution_phase` 与 intended terminal三元组是startup recovery的唯一终态意图权威。
- 无产物结果的intent与convergence共享独立10秒terminal-control预算；每阶段最多3个真实HTTP请求，合计最多6个，两个API Client均零重试。
- user/subtask终态Assistant必须无ToolCall/ToolExecution，并在同一事务完成Assistant、response tokens和intent；manual成功`commitCompaction`同一事务提交摘要、Session坐标和intent。原子成功后不写独立intent，首次convergence前新建10秒预算。
- 空Assistant由Worker在提交前依本地计数选择：前N-1次普通完成，第N次阈值完成走原子terminal Assistant入口。
- 分块上限固定为8最终叶、15 attempted partitions、30 logical Provider calls；网络上限为 proactive 30、manual 60、每级 recovery 60。
- `summary_input_limit` 立即失败，不进入 full；只有 standard 业务无进展或 standard 提交后主步骤仍 context-limit 可进入 full。
- 当前 trigger 媒体必须留在 B；无法在20k内保留时明确失败；full 检测到该媒体时直接结束恢复并要求重发。
- terminal result 属于 `agent_run`，不属于 `session_run_state`。全局 registry 冻结 runKind/status/code 合法组合；旧completeRun契约/端点/Client方法不保留。
- `convergeRunTerminal`只读intended，在一个事务内按workspace/session/run origin收敛Message、ToolExecution、Session revision、Run终态和session_run_state；返回`transitioned`或`already_converged`及finalStatus。completed存在非终态产物即失败；failed/cancelled收敛streaming Assistant与queued/running ToolExecution，后两类转为终态时`completedAt=convergence.updatedAt`，保留startedAt且不伪造result/error。
- 每次convergence成功或一致重放均清除runId的prompt static cache；仅`transitioned`发布既有`agent.run.completed.v1`。事件是best-effort内存SSE：发布失败不回滚数据库、记录错误，重放不补发且本次不引入outbox。
- 新增公共 Run 状态接口；manual 与普通 user send 的 runId 共用当前标签页 pending-run registry，刷新恢复并按 code 每 tab 消费一次。
- pending-run记录带schemaVersion；只轮询当前workspace/session，并定义损坏、stale、网络错误、删除清理和并发3条FIFO策略。
- fingerprint 使用 `providerModelId ?? model.id` 和真实 adapter identity；CAS 后 fingerprint 变化时 proactive skip，manual/recovery 为 `compaction_conflict`。
- timeline 展示当前分支从最早可达祖先到 head 的完整物理历史并显示 compaction；context root 之前的消息只读。retained tail 只改变模型私有上下文，不放开 revert/fork 等结构操作边界。
- Workspace清理固定为FTS行→FTS map→client request→session_run_state→session model override→ToolExecution→MessagePart→Run→Session→Message逆拓扑→Attachment；不得修改三类Message图边。
- Workspace删除使用`convergeWorkspaceRunsForDeletion`编排，而非独立artifact写入：持久deletion intent并设fence后，按稳定Session锁和稳定Run顺序逐Run复用intent+完整convergence；全部数据库收敛后才drain runtime，drain成功后才执行物理清理。失败保留deletion intent以便重试。

## 文档导航

- [现状、问题与目标](./01-现状问题与目标.md)
- [业务语义、术语与关键决策](./02-业务语义与关键决策.md)
- [领域实体与数据模型](./03-领域实体与数据模型.md)
- [ModelContext Resolver、物化层与尾部算法](./04-上下文解析与尾部算法.md)
- [压缩流程、模式与恢复状态机](./05-压缩流程与状态机.md)
- [API、数据库与共享契约改造](./06-接口数据库与契约改造.md)
- [边界情况、失败语义与可观测性](./07-边界失败与可观测性.md)
- [测试矩阵与验收标准](./08-测试与验收标准.md)
- [开发任务拆分与实施步骤](./09-开发任务与实施步骤.md)
- [代码映射与审查清单](./10-代码映射与审查清单.md)

## 核心不变量

- 有效动态上下文只有 S、B 和 S 后消息，不重复、不遗漏。
- B 为沿同 Workspace `previousMessageId` 祖先链的闭区间；旧 compaction 跳过且不递归。
- 主 profile 空投影块不计成本、不算进展、不能成为 retainedFrom。
- candidate/primary 切换不得改变 A/B 和 SummaryInputBlock 语义。
- CAS conflict 后旧 Plan 与摘要全部作废；重规划不重置当前 deadline。
- profileFingerprint 变化不得复用旧 Plan。
- CAS replan 不清零 partition、logical、network 计数；计数作用域为 proactive attempt、manual Run、recovery level。
- 所有 work RPC、Provider 请求和退避绑定 work deadline；intent/convergence只绑定独立10秒terminal-control budget。
- `terminal_intent_persisted`时status仍为running，公共查询不返回intended code；startup只调用完整convergence，不重跑业务。
- terminal Run 必须有 registry 内稳定 code；running result 必须为空；已终态 Run 不得被不同结果改写。
- Workspace删除不得覆盖已有不同terminal intent；必须先收敛该原intent，已terminal则幂等跳过。任一Run的intent/convergence不变量失败时，不得drain runtime或删除数据。
- ToolExecution由queued/running经convergence进入cancelled/unknown时，status、completedAt、updatedAt和updatedRevision必须同事务写入；一致重放不得改写completedAt。
- 用户取消不提交未完成摘要，不降级到 full。
- 安全错误、控制面永久错误和数据不变量错误不得被 proactive 吞掉。

## 非目标

本次不做：

- 持久化逐消息 token；
- 精确复现 Provider 计费 token；
- 在原子块内部截断；
- 放开 context root 之前历史消息的 revert、fork 或其他结构操作权限；
- 修改普通主模型步骤的非 context-limit 重试策略；本次只定义压缩摘要调用重试；
- 移除当前 trigger 媒体后继续让模型推理；
- 扩展实时事件协议传送 terminal result；
- 旧 Message 数据兼容。
