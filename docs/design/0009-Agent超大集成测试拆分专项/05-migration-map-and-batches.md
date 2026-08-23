# 迁移地图与分批实施计划

## 迁移规则

本文件冻结原 `agent.integration.test.ts` 的 `165` 个顶层测试标题、方案调研时的原行号、唯一目标文件和建议迁移批次。实施前若源码发生变化，P0 必须重新生成清单并记录差异，不能按旧行号机械剪切。

迁移必须遵循：

- 标题与核心断言保持；
- 每项最终只有一个活动副本；
- 旧测试块只有新位置验证通过并经独立复审后才能删除；
- 归属按主断言调用链，不按 helper 或行数；
- 文件名可在 P0 小幅调整，但必须同步更新本表；
- 禁止 `part1/part2/misc`；
- 禁止为迁移修改生产代码。

## 目标文件统计

| 目标文件 | 计划测试数 | 主要调用链 |
|---|---:|---|
| `agent-plugin-host.integration.test.ts` | 1 | Plugin Host process/socket/service reconcile |
| `agent-startup-recovery.integration.test.ts` | 6 | startup fail/recover、cancel race、runtime best-effort |
| `agent-events-sse.integration.test.ts` | 1 | SSE 连接、事件与 teardown |
| `agent-subtask-lineage.integration.test.ts` | 10 | lineage、orphan、reuse、SQLite 约束 |
| `agent-subtask-routes.integration.test.ts` | 7 | route validation、depth/mode、auth/schema |
| `agent-subtask-prefork-result.integration.test.ts` | 14 | prefork plan/summary/meta、result/partial output |
| `agent-session-routes.integration.test.ts` | 11 | create/fork/trigger、run route contract |
| `agent-session-control.integration.test.ts` | 14 | compact、clear、revert、workspace cleanup |
| `agent-read-context.integration.test.ts` | 16 | read-side、messages/context、reasoning |
| `agent-run-cancel.integration.test.ts` | 6 | cancel settlement 与 cascade |
| `agent-settings-profile.integration.test.ts` | 15 | settings/provider/profile/model |
| `agent-prompt-context.integration.test.ts` | 17 | locale、runtime constraints、tool messages |
| `agent-peripheral-status.integration.test.ts` | 18 | run-state、status、allowlist、tail/final-text |
| `agent-archive-compaction.integration.test.ts` | 6 | archive/search/read/compaction snippet |
| `agent-artifact-tool-output.integration.test.ts` | 11 | artifact/path/symlink/tool output |
| `agent-global-prompts-workspace.integration.test.ts` | 12 | global prompt、AGENTS.md、skills/workspace |

总数：`165`。表中数量由下方唯一归属清单汇总；实施时应以脚本再次核对。

## P0-P5 总览

| 批次 | 目标 | 计划迁移量 | 进入下一批门禁 |
|---|---|---:|---|
| P0 | 已完成：基线、inventory、runner/并发实测、最小 fixture 探针 | 1 个真实 app 测试 | 已通过：旧 `164` + 新 `1` 共 `165` 测试稳定；teardown、并发、命令和耗时均有实测结论；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P1 | 已实施：特殊资源与 Settings/Profile | 22 个测试（不含 P0 已迁移的 1 个 Settings/Profile 探针） | 定向与 165 项组合通过、唯一副本/资源清理已核对；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P2 | 已实施：Subtask 与 Session routes | 42 个测试 | 旧 `100` + 新 `65` = `165/165`、标题唯一/相关回归/typecheck 通过；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P3 | 已实施：Read Context、Run Cancel、Session Control | 36 个测试 | 旧 `64` + 新 `101` = `165/165`、标题唯一、三文件定向、相关回归、typecheck、diff 与资源清理通过；helper 显式接收 fixture，cancel 并发语义保持；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P4 | 已实施：Prompt、Peripheral、Archive、Artifact、Global/Workspace | 64 个测试 | 五文件定向 `64/64`、17 个相关既有测试文件回归 `51/51`、API/root typecheck、资源复查通过；旧文件 `0` 活动测试、新目录 `165` 且标题唯一；迁移期全量 TAP `166/166`（含空旧文件的文件级 subtest）；独立审查通过，无 H/M/L 问题与修复项，无需复审 |
| P5 | 已完成：删除旧综合文件、冻结 script、实现侧总验收 | 不新增业务测试 | 旧文件已删除；165 项新目录唯一；new integration `165/165`、API 全量 `334/334`、API/root 验证和资源复查通过；批次审查/复审通过、已由主会话暂存；全面独立终审通过，专项完成 |

> P0 建议选择原行 `1651` 的 `GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel` 作为真实 app/SQLite/workspace 多文件探针。若实施时发现它并非最小稳定探针，可在 P0 独立审查前改选一个等价真实 fixture 测试，但必须同步更新清单与理由。

## 原测试唯一归属清单

| 原行 | 原测试标题 | 唯一目标文件 | 批次 |
|---:|---|---|---|
| `204` | plugin-host services reconcile can start/stop feishu gateway | `agent-plugin-host.integration.test.ts` | P1 |
| `305` | agent startup recovery mode=fail 会终止 in-flight run 并回收 run-state | `agent-startup-recovery.integration.test.ts` | P1 |
| `489` | agent startup 会 best-effort reconcile archive pending sidecar | `agent-startup-recovery.integration.test.ts` | P1 |
| `555` | recover 在 enqueue 前最终 DB check 中让 cancel wins | `agent-startup-recovery.integration.test.ts` | P1 |
| `622` | recover enqueue 已发出后 cancel 仍以 DB cancelled 状态为准 | `agent-startup-recovery.integration.test.ts` | P1 |
| `681` | recover enqueue failure 只记录并继续处理后续 candidate | `agent-startup-recovery.integration.test.ts` | P1 |
| `741` | runtime cancel 失败仅 warning，DB cancel 保持收敛 | `agent-startup-recovery.integration.test.ts` | P1 |
| `801` | agent run mapper 对 SQLite 弱类型 lineage 值 fail-closed | `agent-subtask-lineage.integration.test.ts` | P2 |
| `848` | primary 普通继续会重置 depth 和 parent 字段，即使最近 run 尚未 terminal | `agent-subtask-lineage.integration.test.ts` | P2 |
| `893` | primary latest Run depth 为 null 时，下一条消息自愈为独立执行根 | `agent-subtask-lineage.integration.test.ts` | P2 |
| `927` | agent run 会保存 subtask depth lineage，并按 parent tool 查询 child run | `agent-subtask-lineage.integration.test.ts` | P2 |
| `977` | subtask cascade 以 run lineage 为准，不依赖 parent tool 的 subtaskSessionId 回填 | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1015` | subtask orphan scanner 仅删除满足全部条件的空壳 | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1100` | subtask orphan scanner 的单条删除异常不会阻断后续候选 | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1135` | startSubtask failure 仅补偿本次新建空壳，不删除 existing reuse | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1191` | agent run 的 parent tool partial unique index 仅约束 subtask lineage | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1228` | subtask parent tool unique 冲突判定仅匹配目标 SQLite 约束 | `agent-subtask-lineage.integration.test.ts` | P2 |
| `1247` | maxSubtaskDepth 更新规范化只接受有限整数范围 | `agent-settings-profile.integration.test.ts` | P1 |
| `1315` | agent settings 兼容缺省 scope/order 并按原顺序归一化 | `agent-settings-profile.integration.test.ts` | P1 |
| `1367` | agent settings 保存并回读 scratchpad，默认工具列表仍不包含它 | `agent-settings-profile.integration.test.ts` | P1 |
| `1409` | agent prompt-context 仅在 agent.tools 显式包含 scratchpad 时暴露该工具 | `agent-prompt-context.integration.test.ts` | P4 |
| `1442` | agent prompt-context 生成 subtask 描述时仅暴露 subtask/both agent | `agent-prompt-context.integration.test.ts` | P4 |
| `1478` | agent prompt-context 中的工具描述与 schema 说明使用英文 | `agent-prompt-context.integration.test.ts` | P4 |
| `1620` | agent scope 校验会拒绝错误场景的 agent 并在无可用 agent 时返回明确错误 | `agent-settings-profile.integration.test.ts` | P1 |
| `1651` | GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel | `agent-settings-profile.integration.test.ts` | P0 |
| `1737` | internal runs/trigger 支持 clientRequestId 去重 | `agent-session-routes.integration.test.ts` | P2 |
| `1779` | internal runs/:runId/final-text 返回最终 assistant 文本 | `agent-peripheral-status.integration.test.ts` | P4 |
| `1835` | internal events/sse 返回 run-complete 事件 chunk | `agent-events-sse.integration.test.ts` | P1 |
| `2142` | subtask start reports anchor validation codes at the Route | `agent-subtask-routes.integration.test.ts` | P2 |
| `2200` | subtask start stable validation codes are precise at Service boundaries | `agent-subtask-routes.integration.test.ts` | P2 |
| `2358` | primary compact Run 固定写入 depth 0 和双空 parent 字段 | `agent-session-routes.integration.test.ts` | P2 |
| `2389` | primary 上下文 fork 创建独立执行根，不携带来源的 subtask 嵌套深度 | `agent-session-routes.integration.test.ts` | P2 |
| `2536` | public 和 generic internal create 固定创建 primary，并拒绝未知字段 | `agent-session-routes.integration.test.ts` | P2 |
| `2574` | public fork 固定创建 primary，并拒绝非 primary source 和未知字段 | `agent-session-routes.integration.test.ts` | P2 |
| `2637` | P0 baseline: endpoint-local preValidation sees unknown keys before schema stripping | `agent-session-routes.integration.test.ts` | P2 |
| `2660` | P0 baseline: schema additionalProperties:false alone strips unknown body keys and permits the request | `agent-session-routes.integration.test.ts` | P2 |
| `2675` | subtask start 按 depth 执行限制、mode 和轻量幂等 | `agent-subtask-routes.integration.test.ts` | P2 |
| `2758` | subtask fork 无 boundary 时保留双空 metadata 并写入 guard→prompt | `agent-subtask-routes.integration.test.ts` | P2 |
| `2787` | subtask start 对 unknown 和超限 parent depth 返回明确错误 | `agent-subtask-routes.integration.test.ts` | P2 |
| `2815` | 已有 child 可在配置下调后复用，而新的同层调用按最新上限拒绝 | `agent-subtask-routes.integration.test.ts` | P2 |
| `2856` | subtask start preserves session union boundaries at the Route | `agent-subtask-routes.integration.test.ts` | P2 |
| `3120` | Run Routes: invalid token + invalid body is 401; valid token + invalid body is 400 | `agent-session-routes.integration.test.ts` | P2 |
| `3169` | Subtask Routes: invalid token wins over invalid body and valid token reaches schema validation | `agent-session-routes.integration.test.ts` | P2 |
| `3195` | Run Route: unknown top-level fields preserve the current accepted request behavior | `agent-session-routes.integration.test.ts` | P2 |
| `3215` | Run ignored: RS-1, RS-2, RS-3 and RC-1, RC-2, RC-3 return 200 ok without DB mutation | `agent-session-routes.integration.test.ts` | P2 |
| `3402` | prompt-context reuses one run static promise and clears it when the run reaches a terminal status | `agent-read-context.integration.test.ts` | P3 |
| `3536` | agent 消息去重与上下文项追加 | `agent-read-context.integration.test.ts` | P3 |
| `3566` | read-side execution-profile 与 prompt-context 不修改已有 run、session 或 context | `agent-read-context.integration.test.ts` | P3 |
| `3632` | agent messages-context 返回完整 messages 且支持 appendMessage | `agent-read-context.integration.test.ts` | P3 |
| `3705` | agent messages-context system 根据 active run 的 uiLocale 返回英文语言约束 | `agent-read-context.integration.test.ts` | P3 |
| `3743` | agent messages-context 在 activeRun 缺失时回退到当前 session 最近 run 的 uiLocale | `agent-read-context.integration.test.ts` | P3 |
| `3782` | agent messages-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale | `agent-read-context.integration.test.ts` | P3 |
| `3834` | agent messages-context 回退到全局最近 run 时会忽略非法 uiLocale 脏值 | `agent-read-context.integration.test.ts` | P3 |
| `3887` | agent context-items 支持 afterId 增量查询 | `agent-read-context.integration.test.ts` | P3 |
| `3918` | agent context-items 支持 assistant reasoning 字段的创建与读取 | `agent-read-context.integration.test.ts` | P3 |
| `3972` | agent context-items 支持 assistant reasoning 字段的更新 | `agent-read-context.integration.test.ts` | P3 |
| `4012` | assistant reasoning 不应进入 prompt-context | `agent-read-context.integration.test.ts` | P3 |
| `4063` | assistant reasoning 不应进入 archive line | `agent-read-context.integration.test.ts` | P3 |
| `4103` | assistant failed item 会通过 output.error 返回错误且正文不混入 [run] | `agent-read-context.integration.test.ts` | P3 |
| `4132` | prompt-context 仅注入最近一次且无 tool item 的 failed assistant | `agent-read-context.integration.test.ts` | P3 |
| `4185` | 非 system item 写入 boundaryReason 会被忽略 | `agent-read-context.integration.test.ts` | P3 |
| `4213` | agent cancel 仅终止执行并保留消息,活跃项标记为 cancelled | `agent-run-cancel.integration.test.ts` | P3 |
| `4319` | agent cancel 会将 subtask 工具项明确改写为 cancelled 并保留 subtask_session_id + existing 提示 | `agent-run-cancel.integration.test.ts` | P3 |
| `4413` | run-complete(cancelled) 会收敛该 run 下的非终态 context items | `agent-run-cancel.integration.test.ts` | P3 |
| `4514` | agent cancel 会收敛隐藏链上的未终态 items 与关联 run | `agent-run-cancel.integration.test.ts` | P3 |
| `4643` | agent cancel 不应把仅因脏 non-terminal item 命中的 terminal run 改写为 cancelled | `agent-run-cancel.integration.test.ts` | P3 |
| `4709` | agent cancel 会基于当前 active run 的 subtask 结果精确级联取消活动 child，且不误取消历史 fork child | `agent-run-cancel.integration.test.ts` | P3 |
| `4988` | agent runtime settings maxSubtaskDepth 默认值、边界和非法更新 | `agent-settings-profile.integration.test.ts` | P1 |
| `5033` | agent runtime settings 可通过 execution-profile 下发 | `agent-settings-profile.integration.test.ts` | P1 |
| `5082` | agent runtime compactionModel 支持保存、下发、清空和引用保护 | `agent-settings-profile.integration.test.ts` | P1 |
| `5220` | openai provider apiMode 会在 settings 与 execution-profile/single-call profile 中透传 | `agent-settings-profile.integration.test.ts` | P1 |
| `5402` | subtask session 的 execution-profile 按 subtask surface 校验 | `agent-settings-profile.integration.test.ts` | P1 |
| `5454` | run 创建后若 agent scope 改为不允许, execution-profile 会返回明确错误 | `agent-settings-profile.integration.test.ts` | P1 |
| `5495` | agent prompt-context 根据 run uiLocale 注入语言与时间运行时约束 | `agent-prompt-context.integration.test.ts` | P4 |
| `5537` | agent prompt-context 在 zh-CN locale 下使用中文 output/runtime sections 且完成判定约束只在 runtime_constraints 中 | `agent-prompt-context.integration.test.ts` | P4 |
| `5571` | agent prompt-context 在缺省 locale 下使用 locale-neutral 英文 output/runtime sections 且不附加语言要求 | `agent-prompt-context.integration.test.ts` | P4 |
| `5598` | agent prompt-context 对 store 中非法 uiLocale 回退为 locale-neutral 英文，避免中英混用 | `agent-prompt-context.integration.test.ts` | P4 |
| `5634` | agent prompt-context 在当前 run uiLocale 为空时回退到当前 session 最近 run 的 uiLocale | `agent-prompt-context.integration.test.ts` | P4 |
| `5689` | agent prompt-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale | `agent-prompt-context.integration.test.ts` | P4 |
| `5733` | agent compact 在 worker 不可用时仍接受 uiLocale 参数 | `agent-session-control.integration.test.ts` | P3 |
| `5741` | agent compact 在 worker 不可用时返回 503 | `agent-session-control.integration.test.ts` | P3 |
| `5757` | internal compact 需要 internal token | `agent-session-control.integration.test.ts` | P3 |
| `5772` | internal compact 在 worker 不可用时返回 503 | `agent-session-control.integration.test.ts` | P3 |
| `5792` | agent clear 会归档当前可见上下文并插入 clear 边界 marker | `agent-session-control.integration.test.ts` | P3 |
| `5896` | agent clear 在 en-US locale 下生成英文摘要，且缺省 locale 回退英文 | `agent-session-control.integration.test.ts` | P3 |
| `5952` | subtask 会话的 send、compact、clear 保持只读且不修改状态 | `agent-session-control.integration.test.ts` | P3 |
| `5996` | agent prompt-context 在 depth 达到上限时隐藏 subtask 工具 | `agent-prompt-context.integration.test.ts` | P4 |
| `6050` | agent prompt-context 在 depth=1、max=2 的 subtask run 中保留 subtask 工具 | `agent-prompt-context.integration.test.ts` | P4 |
| `6094` | agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示 | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6284` | subtask start with preforkSummaryText should inject summary->guard->prompt without copying parent history | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6415` | subtask start should reject preforkSummaryText when mode=new/existing | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6512` | subtask start should reject too long preforkSummaryText | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6589` | subtask start should allow description length 50 and silently truncate >50 | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6681` | subtask start should reject mismatched preforkMeta | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6771` | subtask prefork-plan should use default threshold and return correct shouldPrefork | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6906` | subtask prefork-plan should reject invalid thresholdPct | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `6964` | agent subtask fork 对父 run 非法 locale 做归一化回退，避免继续传播非法值 | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `7027` | subtask 失败时 getSubtaskRunResultFromWorker 仍返回 partial text | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `7079` | subtask result follows assistant, then system, then empty fallback and status exposes all terminal states | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `7261` | failed tool item 可保留 subtask partial result 且 error 不混入 partial 文本 | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `7300` | agent prompt-context 对 primary 会话保留 subtask 工具 | `agent-prompt-context.integration.test.ts` | P4 |
| `7376` | delete workspace 会清理 dataDir 下的 agent 归档目录 | `agent-session-control.integration.test.ts` | P3 |
| `7396` | agent clear 在空会话返回 AGENT_CLEAR_EMPTY | `agent-session-control.integration.test.ts` | P3 |
| `7411` | agent clear 在会话运行中返回 AGENT_CLEAR_NOT_IDLE | `agent-session-control.integration.test.ts` | P3 |
| `7452` | agent revert 在会话运行中返回 AGENT_REVERT_NOT_IDLE | `agent-session-control.integration.test.ts` | P3 |
| `7530` | agent revert 在 idle 且存在非终态残留 item 时返回 AGENT_REVERT_HAS_NON_TERMINAL_ITEMS | `agent-session-control.integration.test.ts` | P3 |
| `7580` | agent revert 在 idle 时可回退到可见 item 并隐藏后续分支 | `agent-session-control.integration.test.ts` | P3 |
| `7653` | agent clear 并发请求会串行执行且不会重复归档 | `agent-session-control.integration.test.ts` | P3 |
| `7721` | agent providers settings 要求 contextWindowTokens 必填且合法 | `agent-settings-profile.integration.test.ts` | P1 |
| `7784` | run-state 支持 runNoticeText 更新与 idle 自动清空 | `agent-peripheral-status.integration.test.ts` | P4 |
| `7820` | run-state 返回最近一次终态 run 结果 | `agent-peripheral-status.integration.test.ts` | P4 |
| `7854` | run-state 不应把旧 terminal run 误认为当前这次 idle 的终态 | `agent-peripheral-status.integration.test.ts` | P4 |
| `7889` | internal sessions/status-summary 返回 run 摘要（elapsed/contextWindowTokens/ratio） | `agent-peripheral-status.integration.test.ts` | P4 |
| `7999` | internal channels/allowlist/check 命中 allowlist 时返回 allowed=true 与 role | `agent-peripheral-status.integration.test.ts` | P4 |
| `8021` | internal channels/allowlist/check 未命中 allowlist 时返回 allowed=false 与 reason | `agent-peripheral-status.integration.test.ts` | P4 |
| `8043` | internal channels/allowlist/check 缺失或错误 internal token 返回 401 | `agent-peripheral-status.integration.test.ts` | P4 |
| `8074` | internal channels/allowlist/check plugin caller mismatch 返回 401 | `agent-peripheral-status.integration.test.ts` | P4 |
| `8093` | internal sessions/status-summary 需要 internal token 且 sessionId 必须存在 | `agent-peripheral-status.integration.test.ts` | P4 |
| `8122` | internal sessions/status-summary sessionId 为空白时返回 400 + SESSION_ID_REQUIRED | `agent-peripheral-status.integration.test.ts` | P4 |
| `8135` | internal sessions/status-summary agent 不存在时返回 400 + AGENT_NOT_FOUND | `agent-peripheral-status.integration.test.ts` | P4 |
| `8149` | internal agents/list 传入非法 surface 返回 400 | `agent-peripheral-status.integration.test.ts` | P4 |
| `8161` | subtask prefork-plan 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `8223` | internal sessions/context-items-tail 返回尾部上下文项 | `agent-peripheral-status.integration.test.ts` | P4 |
| `8282` | internal sessions/context-items-tail sessionId 为空白时返回 400 + SESSION_ID_REQUIRED | `agent-peripheral-status.integration.test.ts` | P4 |
| `8294` | internal sessions/context-items-tail 缺少 x-awb-plugin-id 时返回 400 + PLUGIN_ID_REQUIRED | `agent-peripheral-status.integration.test.ts` | P4 |
| `8307` | internal sessions/context-items-tail 缺少 body.pluginId 时返回 400 + PLUGIN_ID_REQUIRED | `agent-peripheral-status.integration.test.ts` | P4 |
| `8321` | internal sessions/context-items-tail header/body pluginId 不一致时返回 401 + PLUGIN_ID_MISMATCH | `agent-peripheral-status.integration.test.ts` | P4 |
| `8334` | single-call model profile 使用 agent 显式默认模型 | `agent-settings-profile.integration.test.ts` | P1 |
| `8434` | agent context 压缩后会归档并支持 archive_search/read | `agent-archive-compaction.integration.test.ts` | P4 |
| `8846` | agent prompt-context 未发生 compaction 时不应注入 compaction snippet | `agent-archive-compaction.integration.test.ts` | P4 |
| `8895` | agent prompt-context compaction snippet 缓存缺失时应即时重建 | `agent-archive-compaction.integration.test.ts` | P4 |
| `8983` | compaction snippet 在 zh-CN locale 下保持中文提示 | `agent-archive-compaction.integration.test.ts` | P4 |
| `9027` | archive v2 边界行为: 校验/大小写/跨文件pos/截断/半行过滤 | `agent-archive-compaction.integration.test.ts` | P4 |
| `9114` | archive_search snippet 模式返回命中窗口并限制单行窗口数量 | `agent-archive-compaction.integration.test.ts` | P4 |
| `9176` | agent prompt-context 使用结构化 tool-call/tool-result 消息 | `agent-prompt-context.integration.test.ts` | P4 |
| `9311` | agent prompt-context 对 apply_patch 保留 patchText 输入,并使用文本结果 | `agent-prompt-context.integration.test.ts` | P4 |
| `9501` | agent prompt-context 支持 todolist 工具输入输出 | `agent-prompt-context.integration.test.ts` | P4 |
| `9648` | agent prompt-context: todolist goal 超长时自动截断并更新 session title | `agent-prompt-context.integration.test.ts` | P4 |
| `9721` | agent prompt-context: todolist goal 为空白时不更新 session title | `agent-prompt-context.integration.test.ts` | P4 |
| `9756` | agent internal: 禁止 append completed apply_patch(必须走 update 写 artifact) | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `9788` | apply_patch artifact 文件缺失时返回 404 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `9872` | artifact Query 在 workspace artifact 目录为越界 symlink 时保持当前 400 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `9924` | artifact 写入目录为越界 symlink 时仍以 slim result 完成 update | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `9993` | write completed 后保留完整 args、瘦身 result 并支持 artifact 拉取 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10355` | write artifact 文件缺失时返回 404 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10433` | write 在 cancel 终态会保留完整 args.content | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10487` | write 在 failed 终态会保留完整 args.content | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10561` | agent tool 字符串结果保持原始字符串语义 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10642` | agent 兼容部分迁移数据: tool_call_json 缺失时回退 legacy output | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10752` | agent 兼容早期拆分数据: 缺少 resultFormat 时保留结构化工具结果 | `agent-artifact-tool-output.integration.test.ts` | P4 |
| `10861` | agent settings 兼容缺省 globalPromptIds | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `10887` | agent global prompts 保存选择指令后展开提示词内容配置 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `10954` | agent global prompts 拒绝非布尔的选择展开配置 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `10971` | agent global prompts 归一化历史选择展开配置且不重写缺失字段 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11016` | agent prompt-context 全局提示词按列表顺序注入(方案A) | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11142` | agent prompt-context 同时存在 global/workspace/agent 时按既定顺序拼接 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11252` | agent prompt-context 在 workspace 根 AGENTS.md 缺失时忽略 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11294` | agent startup seed 会修复脏的 global prompts settings | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11357` | agent prompt-context 在 agent prompt 为空且无 workspace/global 时仅注入全局系统提示词 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11421` | agent prompt-context 对 workspace AGENTS.md 做 32KB 截断并追加标记 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11469` | agent prompt-context 注入 skills 摘要并在同 run 缓存静态部分 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11632` | agent prompt-context 对 repo 根 symlink/路径失配安全跳过 | `agent-global-prompts-workspace.integration.test.ts` | P4 |
| `11719` | subtask start 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE | `agent-subtask-prefork-result.integration.test.ts` | P2 |
| `11784` | openai-compatible provider 可在 settings 与 profile 中保存透传 | `agent-settings-profile.integration.test.ts` | P1 |
| `11863` | openai-compatible provider 支持按 OpenAI 风格拉取远程模型列表 | `agent-settings-profile.integration.test.ts` | P1 |

## P0：基线、清单与多文件运行实测

### 实施内容

- 复核 Git status、HEAD 和工作区边界；
- 用脚本重新提取顶层测试标题，确认仍为 `165`；
- 冻结旧 `npm run test:integration` 的结果、耗时、warning 和资源遗留；
- 基于 `agent-testkit.ts` 设计最小 integration fixture；
- 迁移一个真实 app/SQLite/workspace 测试作为探针；
- 运行“新文件 + 尚未迁移的旧文件”组合；
- 实测 `tsx --test` 多文件发现、文件级并发和输出；
- 实测 `t.after()` 或局部 `try/finally` teardown；
- 检查 `.tmp-tests`、socket、SSE reader、Plugin Host 资源是否遗留；
- 冻结最终目录命名和 `test:integration` 候选命令，但此批是否修改 package script 由实测结论决定。

### P0 实际结论

- 已迁移原行 `1651` 的 `GET /api/settings/agent/agents 返回每个 agent 的 resolvedModel` 至 `integration/agent-settings-profile.integration.test.ts`；标题及两组 `resolvedModel` 深度断言保持，旧副本已删除。
- 新增 `testkit/agent-integration-testkit.ts`：仅组合现有底层 fixture、默认 workspace、默认 provider/agent 设置及 allowlist；options 仅为 `repoRoot`、`agentWorkerConcurrency`，没有引入领域 helper 或全局 fixture。
- 新测试使用 `t.after(() => fixture.dispose())`；单文件、默认多文件、显式 `--test-concurrency=1` 及旧+新组合均通过，且相关临时目录运行前/后均为 `0`。
- `test:integration` 在迁移期间更新为 `tsx --test src/modules/agent/integration/*.test.ts src/modules/agent/agent.integration.test.ts`；P5 删除旧文件后再收窄为只发现新目录。

### 独立审查点

- 165 项清单与源码是否一致；
- 探针迁移是否保持标题和断言；
- fixture 是否每测试独立；
- 是否错误地把 P0 route probe 或领域 seam 加入全局 testkit；
- runner 并发结论是否来自实际命令；
- 是否出现耗时、资源冲突或生产代码修改。

### 回滚边界

- 恢复探针到旧文件；
- 删除仅新增的新测试文件/testkit 增量；
- 旧综合文件其余部分不动；
- 不修改生产代码。

## P1：特殊资源与 Settings/Profile

### 迁移顺序

- Plugin Host 单独文件；
- Startup Recovery 文件；
- SSE 文件；
- Settings/Profile 文件剩余测试；
- 根据 P0 结论完善 fixture 的 Plugin Host/fault/initial settings 最小 seam。

### 关键验证

- Plugin Host process/socket 可稳定关闭；
- startup cancel race 和 runtime best-effort 断言保持；
- SSE reader/body/abort 完整 teardown；
- provider/profile 测试不引入真实外网依赖；
- 新旧组合运行无资源冲突；
- P1 定向与新旧组合、资源清理、唯一副本核对已通过；未参与实现的独立代码审查员审查通过，无 H/M/L 问题与修复项，因而无需修复后复审。

### 回滚边界

每个目标文件独立可回滚。不得为了一个特殊 fixture 失败而回滚 P0 已通过的通用 fixture，除非证据证明 P0 设计本身错误。

## P2：Subtask 与 Session Routes

### 迁移顺序

- Subtask Lineage；
- Subtask Routes；
- Subtask Prefork/Result；
- Session Routes；
- 已创建仅供四个 P2 文件复用的 `integration/subtask.helpers.ts`；它只承载 fixture 所有权、Subtask session/anchor/start 与显式 context/writeback。direct service、prompt/profile 与 polling helper 保持各自测试文件局部。

### 关键验证

- lineage、orphan、new-shell compensation、existing reuse、partial unique 全部保留；
- auth/schema/preValidation 顺序保持；
- P0 probe 不污染通用 fixture；
- prefork summary/meta/result/partial text 断言保持；
- create/fork/trigger route contract 保持；
- 相关 `subtask/*.test.ts` 与 route baseline 回归通过。
- P2 定向、旧+新组合、标题唯一、资源清理与 typecheck 已通过；未参与实现的独立代码审查员审查通过，无 H/M/L 问题与修复项，因而无需修复后复审。

### 回滚边界

按目标文件回滚，不允许同时重写 Subtask 生产 application 或 persistence。

## P3：Read Context、Run Cancel 与 Session Control

### 迁移顺序

- Read Context；
- Context writeback 窄 helper；
- Run Cancel；
- Session Control。

### 关键验证

- 已迁移 `agent-read-context.integration.test.ts`（16 项）、`agent-run-cancel.integration.test.ts`（6 项）和 `agent-session-control.integration.test.ts`（14 项）；
- 已创建 `integration/context-writeback.helpers.ts`，其中 `createContextItemInternal()`、`updateContextItemInternal()` 与 `updateRunStateInternal()` 等 helper 均显式接收 fixture，保留旧测试等价的自动 run/state 前置行为；
- reasoning、failed assistant、boundary reason 断言保持；
- cancel hidden chain、terminal dirty data、child cascade 保持；原 `{ concurrency: false }` 原样保留在 child cascade 场景；
- clear/revert/archive/concurrency 真实主链保留；
- 三个 P3 文件定向共 `36/36`、相关 context/writeback/lifecycle/query/read-side/session 回归 `67/67`、迁移期组合旧 `64` + 新 `101` = `165/165` 均已通过；标题唯一 `165`、重复 `0`；
- API 与根 `typecheck`、`git diff --check`、`git diff --cached --check` 已通过；全量结束后延迟复查未发现相关 fixture 目录残留；
- 未参与 P3 实现的独立代码审查员审查通过；无 H/M/L 问题与修复项，因而无需修复后复审。

### 回滚边界

helper 与调用它的目标文件应作为同一小批回滚；不得留下旧全局 `fixtureByApp` 与新显式 helper 混用的长期过渡状态。

## P4：Prompt、Peripheral、Archive、Artifact 与 Global/Workspace

### 迁移顺序

- Prompt Context；
- Peripheral Status；
- Archive/Compaction；
- Artifact/Tool Output；
- Global Prompts/Workspace。

### 关键验证

- 已迁移 `agent-prompt-context.integration.test.ts`（17）、`agent-peripheral-status.integration.test.ts`（18）、`agent-archive-compaction.integration.test.ts`（6）、`agent-artifact-tool-output.integration.test.ts`（11）及 `agent-global-prompts-workspace.integration.test.ts`（12），共 `64` 项；
- `p4-fixture.helpers.ts` 普通场景复用 integration fixture，仅为 archive write fault 与 global prompts 预 app 前置提供局部初始化；不向通用 testkit 吸收领域逻辑；
- prompt locale/runtime/tool message/todolist、peripheral internal auth/plugin id/tail/status/final-text、archive/search/read/snippet/v2、artifact missing/symlink/slim result/legacy data，以及 global prompt/AGENTS.md/skills/repo path 安全断言均已保持；
- Archive、Artifact 与 Prompt 的文件系统副作用继续由每测试 fixture 或局部 teardown 管理；archive rollback 的内层 fixture 显式绑定自身请求与状态前置；
- 五个 P4 文件定向共 `64/64` 通过；17 个 prompt/archive/artifact/peripheral/read-side/writeback 等相关既有测试文件共 `51/51` 通过；API 与根 `typecheck` 通过；延迟资源复查无相关临时目录残留；
- 删除旧综合文件中对应 `64` 个测试块后，旧文件无活动 `test(...)`，新目录活动测试 `165`，标题唯一 `165`、重复 `0`；
- 当前迁移期脚本仍显式载入旧文件，因此 `npm run test:integration` TAP 报告 `166/166` 通过：其中 `165` 是新目录活动测试，额外 `1` 是无活动测试旧文件的文件级 subtest；P5 删除旧文件后再收窄脚本；
- 未参与 P4 实现的独立审查员审查通过；无 H/M/L 问题与修复项，因此无需复审。

### 回滚边界

按语义文件回滚；Archive 与 Artifact 不因共享 filesystem helper 合并成通用文件服务式 testkit。

## P5：旧文件删除、脚本冻结与总验收

### 实施结果

P5 已完成以下动作：

- 从 `HEAD` 中旧综合文件的 `165` 个标题为基线，与 `integration/*.test.ts` 做机器比对：新目录活动测试 `165`、唯一 `165`、遗漏/额外/重复均为 `0`；旧 `agent.integration.test.ts` 已删除；
- 未保留 cross-domain smoke；
- `apps/api/package.json` 已冻结为：

  ```text
  test:integration = tsx --test src/modules/agent/integration/*.test.ts
  ```

- 收窄后 `npm run test:integration` 通过 `165/165`；API 全量 `334/334`、worker integration `3/3`、Feishu `11/11`、Web `24/24`、API typecheck、root build/typecheck 均通过；
- 延迟 `5s` 的 `.tmp-tests` 复查无相关 fixture 目录，生产代码 diff 名单为空；
- 审核 `agent-integration-testkit.ts` 与三个领域 helper：通用 testkit 仅保留 ready fixture、默认 settings/allowlist 与稳定 session/message helper；领域流程及文件系统断言仍局部/窄 helper 持有，未发现需扩大治理的明显可维护性问题。

### 审查门禁

未参与 P5 实施的独立审查员已审查通过：无 H/M 问题；唯一 README L1 已修复为实施记录与验收日志，且同一审查员复审通过。P5 已由主会话暂存。

未参与 P0-P5 实施及批次审查的新审查员已完成全面独立终审并通过：达到完成定义，无 H/M 问题，无必须补代码差距；专项完成。

### 已执行最终动作

- 已更新 `apps/api/package.json` 的 `test:integration`；
- 已运行新 integration 全量、API 全量/API typecheck、root build/typecheck 与 `git diff --check`；
- 已更新实施记录和实际代码地图；
- P5 L1 文档修复已由同一审查员复审通过；全面独立终审通过，专项完成。

## 全局停止条件

任一批出现以下情况应立即停止：

- 需要修改生产逻辑才能通过；
- 发现测试依赖前一个测试的数据或顺序；
- 多文件并发导致 DB、目录、socket、process 或 SSE 资源冲突；
- integration testkit 开始吸收领域规则或大量单用例开关；
- 重要断言无法等价迁移；
- 测试总耗时明显恶化且无法解释；
- 新文件不稳定而旧文件稳定；
- 发现工作区未知变更与本专项文件重叠。
