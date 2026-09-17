# 测试与验收标准

## 总体验收标准

- 新写入路径只使用 `Message + Part + ToolExecution`，不再写 `agent_context_item`。
- 正常模型上下文、Fork、回退、压缩和归档搜索均基于同一权威数据投影。
- 所有自动重试、回退、压缩和 Head 切换满足原子性和 CAS 约束。
- Worker 崩溃后能自动恢复未完成 Run，不因为 `queued/running` 工具遗留而卡死。
- 前端在流式输出、工具执行、自动重试、压缩和回退场景下显示正确，不产生错序或脏数据。
- 旧数据被明确清理，没有静默混合新旧消息模型。

## 文件安全、durable cleanup 与删除恢复

- destructive upgrade、Workspace 文件域和附件目录删除均验证业务 entry、私有 retire 槽及目录拓扑；symlink、inode/type mismatch、可检测 replacement、syscall 异常和不确定结果均不得报告成功。
- 普通私有槽固定使用 v1 identity 编码：`.delete-v1-<scope>-<type>-<dev>-<ino>-<nonce>`。扫描前严格解析并比较 `dev/ino/type`；旧格式、未知格式、scope 不匹配、解析失败、symlink、类型异常、identity mismatch 或 I/O 不确定均为 durable pending，绝不猜测删除。
- `.delete-replacement-pending-*` 仅是便于诊断的最佳努力 rename，不是安全状态的唯一来源。即使 marker rename 返回 EIO，原 v1 槽仍包含 expected identity，下一次 retry/restart 必须继续报告 pending。upgrade 保持 `file_cleanup_pending`，Workspace 保持 tombstone/fence。
- 普通 v1 `.delete-*` stale 槽仅在同一受控目录、关联 scope 和 identity 全部匹配时可由 retry/janitor 收敛；attachment temp/final 在业务名已经缺失时仍要处理关联普通槽，不能把 `ENOENT` 当成已清理。
- final link 后 temp parent 移动时，source 必须由原 dirfd 清理、迁移到稳定 attachment cleanup root 后由 janitor 清理，或明确 `sourceCleanupPending=true`；上层不得重开失效逻辑 pathname。
- attachment 的 scope 是业务名 SHA-256 派生的受控 token；moved source 无论尚为业务名还是已 retire 槽，都迁入稳定 root 内重新发布的 v1 槽，再由 janitor 严格复验后清理。
- Workspace 删除在 terminal record 删除前，按 authority rows 清理 SSH key、askpass 和 token。live 文件直接在固定 trusted `dataDir` root dirfd 以确定的 `.terminal-auth-live-v1-<kind>-<terminalId>` 名创建，使用 `O_DIRECTORY|O_NOFOLLOW`、`O_EXCL|O_NOFOLLOW` 和共享 secure retire 协议；writer `EEXIST` 一律 pending，不得即时 `lstat` 后自行删除或覆盖。dataDir root 不再 current 时 fail-closed，`dataDir/tmp` 的移动/替换不参与此生命周期。
- 每个可能创建 auth secret 的 artifact 必须在 writer 前分别写 `(terminal_id, artifact_kind)` 的 `armed` row，并记录创建时 dataDir `root_dev/root_ino`；成功写入并复验 artifact 与同一 root identity 后分别更新为 `recoverable`。armed/recoverable root identity 必须为有效安全整数，legacy unresolved 才允许 null，普通 unresolved 更新保留最后可信 anchor。arm/update/clear 必须验证 `changes === 1`；arm/update 读回完整字段，clear 再读确认 row 已消失。INSERT/UPDATE/DELETE `RAISE(IGNORE)` 必须像 abort 一样阻断发布。active Terminal 必须保留全部 recoverable rows；`armed` 跨重启默认阻断，不能因当前路径为空被猜测为安全。
- credential 读取、解密或网络环境构建在 artifact writer 前失败时，测试必须证明 writer 未调用、无 secret、同事务 clear armed + `closed`，并向调用方返回原始错误；若 clear 被拒绝或零行，则事务回滚，armed 保留且不得伪造 `closed`。
- `terminal_auth_cleanup_intents` 的 schema 测试必须覆盖缺表、两种精确单行旧表（四列无 phase、五列精确 phase CHECK）及缺 root anchor 的中间 per-artifact 表到 `legacy/unresolved` 或 `unresolved/root=null` 的 rebuild。单行表测试必须拒绝缺失/宽松 CHECK、约束绕过的非法 phase row、错误 FK、缺失/错误/unique `updated_at` index、额外列或 index、orphan；init 失败时 `sqlite_master`、rows 与 Agent schema 状态均不得改写。
- root live 文件或关联私有槽 unlink EIO 后，recoverable row 必须保留并能在重启 reconcile 收敛；business file/private-slot replacement、marker EIO、unknown、artifact identity mismatch 或 root identity mismatch 必须保留 victim 和 pending。测试必须覆盖 dataDir 整体 rename 后同路径新建 root：SSH 与 HTTPS 所有 rows 阻断 reconcile、Terminal/Workspace 删除并保留 record、tombstone/fence，恢复原 root 路径后才可收敛。只有全部 recoverable rows 经实际扫描清空后才可同事务 clear intent + closed / 删除 records；`armed`、`unresolved` 和 legacy 不得被普通 reconcile 自动 closed，亦不得删除 terminal record、Workspace、tombstone 或 fence。
- workspace-files 的 write/create/mkdir/rename/delete 以及 multipart upload 从 target resolve 到 stream 消费、写入和失败清理全程处于 lifecycle mutation gate；真实 multipart route 在 restored fence 下返回 `WORKSPACE_DELETING` 且不落盘。已入场 upload 完成前 delete intent 不可越过；intent 建立后新 upload 必须被拒绝。
- tmux `new-session` response-loss 以三态 probe 处理：只有明确 `not_found` 才 fallback；`exists` 或 indeterminate 都保留可恢复 terminal intent，reconcile 后才 closed。
- startup recovery 必须覆盖两次 Session handoff 锁之间建立 Workspace deletion fence：首次 prepare 已完成后，第二次 enqueue lock 命中 `WORKSPACE_DELETING` 时，prepare 只执行一次、零 enqueue、零 reconciliation 重排/attempt、无 `AGENT_WORKER_ENQUEUE_UNKNOWN` warning，并继续恢复后续 Workspace candidate。
- user Run 与 manual compaction 在 durable activate 后、最终 enqueue handoff 前被 deletion fence 抢占时，API 返回稳定 `WORKSPACE_DELETING`；不得 enqueue、不得建立 reconciliation，不得将 Run 伪造为 failed/idle。已有 unknown 网络/ACK 丢失仍必须保持同一 `runId` reconciliation，不能被此分类回归。
- reconciliation timer 触发时 deletion fence 获胜，必须清除 timer/attempt 且不再次调度；cancel 与 lifecycle dispose 的终止语义保持不变。
- 两个真实 API/SQLite 生命周期组合必须覆盖：第一生命周期持久化 `workspace_deletion` intent、同 Workspace recoverable Run 与另一 Workspace recoverable Run；第二生命周期通过 `registerWorkspacesModule()` hydrate fence 后执行 Worker-ready 等价编排，删除目标 Workspace、从不 enqueue 其 Run、恢复另一 Workspace Run，ready 不失败。

有限威胁模型：不宣称随机私有槽是形式化 exact-object unlink；明确排除同一 OS 用户在最终 syscall 前对随机私有槽的无限精确抢占，但不排除并必须测试 symlink、父目录替换、业务名替换、可检测 private-slot replacement 与 I/O 异常。

## 单元测试矩阵

### Message / Part / ToolExecution

- 创建 User / Assistant / System / Compaction / Runtime Message。
- Assistant 多 Part 顺序稳定。
- ToolCallPart 与 ToolExecution 一对一关联。
- 同一 ToolCallPart 创建两个 ToolExecution 被拒绝。
- ToolExecution 跨 Workspace 关联被拒绝。
- ToolExecution 指向非 ToolCall Part 被拒绝。
- Fork 后历史 ToolExecution 可被读取，但不复制、不重新执行。
- Session 删除后 `originSessionId` 置空，共享 Message 保留。

### 流式写入

- TextPart 与 ReasoningPart 批量刷新后前端可见。
- streaming 阶段 Message 可更新。
- 进入 completed 后 Message 与 Part 冻结。
- failed / cancelled / superseded 默认不进入 FTS。

### 自动重试

- 空 streaming Assistant 出错后不创建替代 Message。
- 已产生 Text 的 streaming Assistant 出错后旧 Message 变 `superseded`。
- 新 Message 使用相同 `previousMessageId`，并通过 `replacesMessageId` 关联旧 Message。
- 旧 Message 中的 ToolCall 不产生 ToolExecution。
- 重试错误提示不进入 TextPart。
- 用户终止时停止后续重试。

### 工具执行

- Assistant completed 后才创建 queued ToolExecution。
- `queued → running` 在工具调用前持久化。
- `running` 崩溃后恢复为 `unknown`。
- `unknown` 作为终态结果参与下一轮模型请求。
- 多工具并行完成顺序不改变 ToolCall Part 顺序。

### 工具 artifact 安全与故障

- 父目录为 symlink 时，artifact 写入被拒绝或解析到真实路径后仍在 Workspace 内。
- 目标文件为 symlink 时，不穿透写入 Workspace 外。
- artifact 路径 containment 校验：解析后必须仍落在 Workspace artifact 根目录内。
- 路径段注入（`..`、绝对路径、非法字符）被拒绝。
- 超过 200,000 字符的 artifact 内容被截断，超出部分丢弃是接受行为。
- artifact 写入成功而 DB 提交失败时，允许文件残留，后续同 execution 可幂等重写。
- 同一 ToolExecution 重复写 artifact 是幂等重写，不视为错误，不生成新 execution。
- Fork 后子 Session 读取历史 ToolExecution 的 artifact 引用，路径仍指向原 Workspace 位置，不复制 artifact 文件。
- artifact 路径基于 `toolExecutionId`，不同 execution 之间不会互相覆盖。

### 模型请求重建

模型 tool result 由单一 Runtime Transcript Projector 确定性生成，每个 completed Assistant 中的每个 ToolCallPart 恰好生成一个合法结果信封，不回写 `ToolExecution` 权威字段。

信封内容规则：

- `unknown`：固定不确定说明文本，明确可能已执行/有副作用，可附可靠 `resultPreview`，不得表述为成功。
- `cancelled`：有 `error` 优先 `error`；否则有可靠 `resultPreview` 用 `resultPreview`；皆无固定说明“工具调用在执行前被取消，未执行”。
- `failed`：`error` 优先，其次可靠 `resultPreview`；皆无固定内部失败说明。
- `completed`：使用 `resultPreview`；为空时采用固定空成功结果说明，不视为不变量错误，不导致 Turn 失败。
- 不自动读取 artifact。
- `structuredResult` 仅供已支持的专用 API / UI 使用，不参与本期模型结果选择。
- `subtask` 只是 `resultPreview` 不截断的特例，进入模型的是格式化 `resultPreview`，不是任意 structured 对象。

补测试：

- `queued → cancelled` 后，新 Run 重建该 ToolCall 的结果信封使用“工具调用在执行前被取消，未执行”固定说明。
- `failed` 且 `error`/`resultPreview` 皆无：生成固定内部失败说明，不导致 Turn 失败。
- `completed` 且 `resultPreview` 为空：生成固定空成功结果说明，不导致 Turn 失败。
- 一个 completed Assistant 含多个 ToolCallPart：每个 ToolCallPart 恰好一个结果信封，无遗漏、无重复。
- 多工具并行完成：结果信封输出顺序按 ToolCallPart.position，与完成先后无关。

其他投影约束：

- 详情接口只返回实际已保存的 `structuredResult / resultPreview / artifact` 信息，不宣称保存完整原始工具输出。

### Fork / 回退 / 压缩

- Fork 不复制 Message/Part/ToolExecution。
- Fork 后子 Session 的祖先链正确。
- 非当前祖先链目标被拒绝。
- 带未完成 ToolExecution 的目标被拒绝。
- 回退只移动 Head，不修改消息内容。
- 压缩只修改当前 Session `contextRootMessageId`。
- 其他 Session 共享同一前缀时不受影响。

### archive_read / archive_search

- 只返回当前 Session 已归档范围中的 completed TextPart。
- 不返回 Reasoning、ToolCall、ToolExecution、Runtime、failed、cancelled、superseded。
- FTS 只在 completed 时写入，stream 阶段不写入。
- FTS 写入失败时完成事务回滚。
- `agent_archived_text_fts.rowid` 与 `agent_text_part_fts_map.fts_rowid` 一一对应，`map.part_id` 与主表 Part 主键一致。
- completed 重试 / 恢复重复提交时，同一 Part 在 FTS 与 map 中均不重复插入，仍只命中一次。
- 同一 eligible completed TextPart 全局只索引一次，不同 Session 查询共享前缀时结果一致且来源唯一。
- 受控重建后，FTS 命中集与主表查询结果一致。
- `archive_read` 第二页 keyset 分页无重复、无遗漏，响应始终按旧到新。
- `archive_search` 响应按新到旧，第二页无重复、无遗漏。
- 普通 append / streaming / tool 更新后，旧 cursor 仍然有效。
- `contextRoot` 变化后，旧 cursor 失效并被拒绝。
- 共享 Message 在一个 Session 已归档、另一个 Session 未归档时查询结果正确。
- `regex` 参数被移除或明确不支持。
- 中文 trigram 检索可命中。
- 伪造 cursor、跨 Workspace cursor、超出当前归档范围的 cursor 被拒绝。
- cursor 先做完整性与祖先校验，再应用 keyset 谓词，校验失败稳定拒绝。
- trigram 查询词少于 3 个字符时稳定拒绝，不返回模糊匹配结果。
- Workspace 删除后，其下 Message/Part 对应的 FTS 行与 map 行被一并清空。

### Run 恢复与提示

- startup recovery 能扫描并完成未完成 Run。
- recover、重复 recovery、重复 enqueue 按 `runId` 幂等。
- Worker 重启后空 streaming Assistant 恢复。
- Worker 重启后有内容 streaming Assistant 被替代。
- Worker 重启后 queued 工具自动执行，running 工具转 unknown。
- 用户终止在退避、请求、空 streaming、部分输出、queued/running 工具各阶段均能正确收敛。
- 用户终止时：streaming Assistant（无论有无部分输出）一律为 `cancelled`；`queued` 工具为 `cancelled`；`running` 工具为 `unknown`；Run 记录为 `cancelled`；`session_run_state` 回到 `idle` 并清空 activeRun/activeAssistant/retry/nextRetry/nonterminal；`runNoticeText` 固定为用户终止说明。
- 模型自动重试期间 `runNoticeText` 更新，成功后清除；用户终止后保留最终状态提示。

## 集成测试矩阵

### 端到端会话

- 用户发文本，Assistant 流式回复。
- 一次 Assistant 多 ToolCall，工具并行执行。
- 下一轮请求重建 ToolCall 顺序与 ToolExecution 结果一致。
- 历史图片只保留占位说明，不重发图片数据。

### 无人值守恢复

- Provider 超时后无限退避重试，前端显示错误提示。
- 凭证错误、模型不存在仍继续重试。
- Worker 重启后空 streaming Assistant 恢复。
- Worker 重启后有内容 streaming Assistant 被替代。
- Worker 重启后 queued 工具自动执行，running 工具转 unknown。

### Fork / 回退工作流

- Fork 后继续对话，源 Session 不受子 Session 新消息影响。
- 回退后追加新消息形成新分支。
- 分支中历史 ToolExecution 不重新执行。

### Workspace 删除

在 `foreign_keys=ON` 下，按技术设计的 Workspace 删除事务顺序执行并断言：

- worker drain、tmux 部分失败、文件权限/软链异常及 final SQLite 事务失败均留下 durable deletion intent 与 fence，重试或重启续作不会恢复普通可写状态；
- Workspace 根、附件和 UI artifact 在最终 DB 删除前完成固定目录 fd/quarantine 清理，外部 symlink victim 不得被删除；
- 其他 Workspace 在某个 Workspace pending deletion 时不受影响。

- 多层 `previous_message_id` 链、replaces 链全部清理，无孤儿 Message。
- 多 Session 共享同一前缀时，Workspace 删除后无残留共享 Message/Part。
- `head_message_id / context_root_message_id` 随 Session 删除解除引用，无残留 Session。
- ToolExecution、Part、FTS 行、`agent_text_part_fts_map` 行全部清理，无残留。
- 已无引用的附件全部清理。
- `origin_session_id / origin_run_id` 相关 Session / Run 删除后引用已按 `ON DELETE SET NULL` 处理，无悬挂外键。
- 整个删除事务在 `foreign_keys=ON` 下一次性成功，无 `RESTRICT` 触发失败，无部分提交。

### 压缩与归档

- 压缩后模型常规上下文从 Compaction Message 开始。
- archive_read 可读取已归档文本。
- archive_search 只搜索已归档高价值文本。
- 压缩失败不改变 Session Head 和 Context Root。
- 连续压缩范围正确。
- Compaction 中间摘要不落库，失败不修改 Head/contextRoot。

### 前端

- 初始加载、向上分页、尾部增量刷新正确。
- 自动重试触发 timelineReset。
- 回退触发 timelineReset。
- 压缩触发 timelineReset。
- ToolExecution 状态变化通过增量 upsert 更新。
- 大型工具结果不进入默认轮询热路径。

## 破坏性升级验收

- 升级脚本明确删除旧 Agent 历史数据。
- 升级后不存在旧 `agent_context_item` 参与运行。
- 不存在旧归档文件参与搜索。
- 不存在 Clear 入口。
- 旧接口不再以兼容名义保留隐藏写路径。

## Web timeline、控制面与 artifact 并发验收

- delta 或 before 在途时请求强制 snapshot，当前请求结束后必须执行 snapshot；刷新
  请求按 `snapshot > delta > before` 合并，不能长期展示旧分支。
- Revert 成功后旧 delta 晚到、Compaction commit/idle 早于旧 timeline 响应时，旧响应
  不得应用；运行 `running -> idle` 无条件最终 snapshot 刷新。
- before cursor 失效（包括 `404 TIMELINE_CURSOR_NOT_FOUND`）必须自动回退 snapshot。
- `/compact` 服务端已调度而 HTTP 响应丢失时，同命令重试必须复用 clientRequestId；
  Session 或命令上下文变化才使用新 ID。
- detail 请求先发、completion delta 先到、旧 detail 后到时，detail 不得覆盖新的
  `updatedRevision`；同 execution detail 乱序、不可见 execution 和 scope 切换都不得
  回填缓存。
- 延迟 `apply_patch` / `write` artifact 响应在卡片卸载或 Workspace/Session/execution
  切换后不得调用 editor host；请求应 abort，并在返回后再次核验 scope。
- 同一来源 Message 的 Fork/Revert 双击只发一个请求；响应乱序不得重复 emit。

## 代码审查标准

审查者应逐项确认：

- 是否仍然存在对 `runId + turnId + step + 相邻 Item` 的调用关联推断；
- 是否仍然把 Reasoning 放入模型请求、压缩输入或 FTS；
- 是否仍然把归档状态写到共享 Message；
- 是否仍然复制 Fork 历史；
- 是否保留 Clear 残留；
- 是否在 Assistant completed 前执行 ToolCall；
- 是否在工具调用前先写 running；
- 是否在模型错误时直接让 Turn 失败；
- 是否引入被否决的抽象；
- 是否用 `depth` 替代祖先校验；
- 是否把 `unknown` 当作可自动重跑状态；
- 是否让 FTS 保存 `session_id` 或重复索引同一 Part；
- 是否在模型请求中自动读取超长 artifact；
- 是否把 artifact 路径基于 provider `toolCallId`。

## 明确反模式

以下实现一律视为不通过：

- 新增 `ModelInvocation` / `ModelAttempt`。
- 新增 `tool_result` Message 或 `tool_call_return` Part。
- 新增 Provider 能力框架或 `provider_data` Part。
- 新增 Run `blocked` / `waiting_retry` 状态。
- 把 `unknown` 当作可自动重跑状态。
- 在 FTS 中索引 ToolExecution 或 Reasoning。
- 由 UI 再次加工文本，覆盖 `ToolExecution` 的 `resultPreview/error/structuredResult`；
- 把 artifact 当作 DB 事务内的权威工具执行状态；
- 宣称所有工具保存完整原始工具结果；
- Fork 时复制共享前缀。
- 为“模型输出完整保存”把 Compaction 中间摘要落库。

## 文件安全与删除并发验收

- 验收采用确认的有限威胁模型：不覆盖同一 OS 用户对随机私有槽最终 syscall 前的无限精确抢占；但软链、业务名/父目录替换、私有槽可检测 replacement、权限与系统调用异常均不被排除。
- destructive upgrade、Workspace 文件域与附件清理均先 retire 到固定 `0700` parent 中的随机私有槽，retire 前后验证 inode/type；不允许最终删除业务原名。
- quarantine 根、stale quarantine、递归 private file/directory slot 在可检测 replacement 注入下均保留 victim，标记/保留 pending，`file_cleanup_pending`、tombstone/fence 或 attachment cleanup pending 不得错误清除。
- 删除 syscall 失败或结果不确定时 fail-closed；未标记 replacement 的 stale private 槽必须可在后续启动/重试收敛。
- 文档不得宣称形式化 inode-bound unlink；必须说明已确认的同 UID 无限精确最终 syscall 抢占排除边界。
- attachment temp 创建后替换父目录时，不返回 handle；仅清理固定 temp fd 中属于本请求 inode 的文件。
- attachment hard-link 后替换 final 父目录时，只 retire/撤回 source inode 相同的 final；替换对象必须保留，不能报告正常 commit，无法安全撤回时标识 `finalCleanupPending`。
- attachment source temp 在 hard-link 后必须由固定 temp fd retire；source cleanup 失败、temp parent topology 变化或结果不确定时标识 `sourceCleanupPending`，上层不得回退到逻辑 pathname cleanup。
- aged temp 清理同样采用 retire，replacement victim 不得被删除。
- 附件读取在授权后替换 pathname，fd stream 仍只输出原授权 inode；流结束、错误和关闭均释放 handle。
- lifecycle gate 覆盖 Files/Git、Workspace title/settings/relation/last-used metadata、workspace-files write/create/mkdir/rename/delete/upload 与 Terminal create/delete：已通过旧检查的 mutation 与删除 intent 串行，intent 建立后不得留下文件、Git、tmux 或 terminal DB 副作用；同链重入不跳过首次 fence，跨 Workspace 不重入。
- restored tombstone 拒绝同 Workspace mutation，且不阻塞其他 Workspace；删除慢步骤不持有 SQLite 写事务或 lifecycle admission gate。
- `tmuxHasSession` 的 exists、显式 not-found、spawn、timeout、server/未知错误均有测试；只有显式 not-found 可继续删除，部分 kill 后失败保留 records/tombstone，重试才统一收敛。
- Terminal 按 `creating → active` 迁移；activation/补偿失败留下 `errored` cleanup intent，startup reconcile 成功后转 `closed`。对外 API 不返回非 active terminal。
- `new-session` response-loss 后必须 probe：明确 not-found 才尝试默认 shell fallback；exists/indeterminate 或补偿失败必须保留 `errored`，reconcile 成功 kill 后才可转 `closed`。
- tombstone hydrate 与 Managed Worker ready 组合必须覆盖：deleting Workspace 的 recoverable Run 不得被 recovery enqueue；ready 先续作删除，删除失败保留 tombstone/fence 但不杀健康 Worker；其他 Workspace candidate 仍继续恢复。
- recovery candidate 在锁前非 deleting、等待 Session handoff 期间 fence 建立时，锁内二次检查必须 skip；不得 prepare 或调度 reconciliation。
- Worker manager 的 restart attempt/circuit history 只能在 `onReady` 成功后清零；ready hook 失败必须保留累计退避。
- 使用真实 SQLite 的两次 API 生命周期测试 tombstone hydrate → runtime ready → resume → final DB 收敛；验证另一 Workspace 不受影响。文件域部分成功、stale quarantine、最终 DB transaction 失败必须继续保留 fence 并在后续安全重试。
- 递归 v1 private file/directory slot 的 identity mismatch 必须保留 victim；marker rename I/O 失败后 retry/restart 继续报告 pending，不能重新 retire 该槽。
- attachment janitor 仅删除超龄 `tmp_<safe-id>.part`；旧/未知 `.delete-*` 与 identity mismatch 槽均保留，同轮普通扫描不触碰它们。
- Terminal auth 覆盖 root live SSH 创建、active 保留逐 artifact recoverable row、HTTPS askpass/token 两行、任意 `tmp` 移动或替换不影响 root cleanup、root live/私有槽首次 unlink EIO 后 restart reconcile、business file/private-slot replacement 与 marker EIO victim 保留、逐行 `RAISE(IGNORE)`，以及仅全部 recoverable rows 实际收敛后同事务 clear + `closed`。Workspace delete 同时覆盖无 authority row 的 root live 文件 fail-closed。
- 真实 Fastify multipart route 通过局部 admission hook 验证：首个 upload 退出 gate 前 delete intent 不存在；其后 intent 建立；第二个 upload 以 `409 WORKSPACE_DELETING` 拒绝且零落盘。

## Web timeline 与控制面并发验收

- scheduler 必须把 tail freshness 与 `before` pagination 分开保留：active snapshot 后到达的 before 不能由 snapshot/delta 结算；持续 delta 最多获得一次公平优先机会，before 随后实际发起。
- cursor 失效覆盖 `before → snapshot → 使用新 cursor 的 before`；成功分页仅在 `hasMore=false` 或无 cursor 后结算 waiter。
- Revert、Compaction、`running → idle` 的 structural snapshot 覆盖 epoch 拒绝旧响应、临时失败退避重试和 dispose/scope 切换停止重试；总次数为初始一次加 delay 数组长度，永久失败必须 reject waiter、清 structural pending/timer/index，使对应 `finally` 释放 pending。退避 timer 期间 delta 不得绕过 structural retry，pagination 可独立完成；active request 必须接收 AbortSignal，dispose 后 active/pending waiter 均结算。
- `/compact` 覆盖 network/timeout/5xx 重用同一 `clientRequestId`、成功清除、scope 变化新建，以及 `AGENT_WORKER_ENQUEUE_REJECTED` / 明确 4xx 后清除并允许新尝试。
- ToolExecution detail 覆盖 revision 抬升、同 execution 请求乱序和不可见 execution/scope 响应丢弃。
- ApplyPatch/Write 卡片通过真实 artifact-open controller 覆盖 scope 切换或卸载后普通晚到 Error 静默、不打开 editor；current scope Error 仍展示。
- Fork/Revert 的 Pane mutation state 通过 Vue `ref/computed/watch` 接线覆盖：同 Session 全部控件响应式 disabled、交叉操作互斥、finally 释放、不同 Session 可并行。
- M8 组件门禁以 `vite-node + happy-dom + @vue/test-utils` 真实挂载 ApplyPatchCard、WriteCard 与 Pane 使用的 MessageActions：点击真实元素可观察 fetch `AbortSignal`、scope props 更新/卸载后的普通晚到结果不调用 host/message，以及异步 Fork 点击期间同 Session DOM buttons disabled、完成后恢复。
