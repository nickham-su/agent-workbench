# Agent 启动恢复策略（默认 fail）v1

## 背景

agent-workbench 的 agent runtime 由 API + worker（同机子进程）协作完成。为了让长任务在进程重启/崩溃后可继续推进，系统会将 run/session 状态持久化在 SQLite 中，并在 API 启动后对处于 `running` / `waiting_permission` 的 run 进行处理。

在开发阶段，worker 与工具（尤其 `bash`/`write`/`apply_patch`）存在副作用，且状态机/幂等等能力尚未完全稳定。

如果保持“启动即恢复”的策略，重启服务会带来两个风险：

- **重启无法止损**：原本希望通过“重启”终止异常状态，但系统会自动续跑，导致问题持续或扩大。
- **副作用风险**：恢复推进可能重复触发工具执行（写文件、执行命令），并进一步污染工作区。

因此引入一个可配置的“启动恢复策略”，并将默认值设为 **fail**：重启后不恢复，而是尽可能将未完成工作置为失败。

## 目标

- 默认 `fail`：API 启动后不恢复历史 in-flight run，尽可能将其标记为失败，并将会话状态重置为 idle。
- 可切换 `recover`：系统稳定后，通过环境变量启用启动恢复能力（延续旧行为）。
- 改动范围小、可回滚，不引入新依赖。

## 非目标

- 不在 v1 中实现工具副作用的 exactly-once / 可对账。
- 不在 v1 中实现跨机器/分布式 worker 的高可用。

## 配置

新增环境变量：

- `AWB_AGENT_STARTUP_RECOVERY_MODE`
  - `fail`（默认）：启动时终止所有可恢复 run，并将其状态置为 failed/idle。
  - `recover`：启动时尝试恢复这些 run（enqueue 到 worker 继续推进）。

解析位置：

- `apps/api/src/config/env.ts`

## 术语与判定

### Recoverable run

复用既有查询：

- `listRecoverableRuns(db)`
  - 表：`agent_session_run_state`
  - 条件：`status in ('running', 'waiting_permission') and active_run_id is not null`

该查询会补充 `agent_run.trigger_item_id` 用于恢复模式下的输入拼装（仅 `recover` 用）。

## 行为定义

### 启动时机

在 API 启动阶段执行：

- `apps/api/src/modules/agent/agent.module.ts`

选择原因：

- `fail` 模式需要尽量避免竞态，因此在 **listen 前**完成 DB 清理，保证外部请求进入前状态已落稳。
- `recover` 模式需要在 API 已 listen 后才能 enqueue 并让 worker 回调 API 内部接口，因此仍放在 `onListen`。

### 模式：fail（默认）

启动时对每个 recoverable run 执行以下动作（best-effort；尽可能推进清理，不阻塞 API 启动）：

1) **终止未落终态的 context items**

- 将该 `run_id` 下 `agent_context_item.status` 为以下值的记录统一改为 `failed`：
  - `streaming`, `queued`, `running`, `awaiting_permission`
- 目的：
  - 避免 UI 继续显示 pendingTools / streaming。
  - 避免 worker 后续通过 `pendingTools` 继续推进。

实现：

- `apps/api/src/modules/agent/agent.store.ts`
  - `failNonTerminalContextItemsByRunId(db, { runId, updatedAt })`

2) **将 run record 标记为 failed**

- `agent_run.status = 'failed'`

实现：

- `failRunRecordIfInFlight(db, { runId, updatedAt })`（仅当 run 仍处于 `running/waiting_permission` 才回收）

3) **追加一条 system 提示（best-effort）**

- 该步骤为 best-effort，且为了避免误导，v1 实现采用“条件追加”：
  - 仅当本次确实通过 CAS 回收了该 run 的 run-state（`active_run_id` 匹配）
  - 且确实发生了清理动作（例如 run record 被标记 failed 或有未终态 context items 被置为 failed）

可能出现的文案（示例）：

- `[run] marked failed on server restart (startup recovery mode: fail)`
- `[run] cleaned up inflight context on server restart (startup recovery mode: fail)`
- 目的：
  - 提供可观测性，便于用户理解“为什么 run 失败”。
  - 便于排查重启导致的终止次数。

注意：

- 该步骤使用 `appendContextItem`，带 `prevId=head` 的 CAS 约束；如遇 head 冲突则跳过。

4) **将会话 run-state 重置为 idle**

- `agent_session_run_state.status = 'idle'`
- 清空：`active_run_id`, `active_assistant_item_id`, `waiting_tool_item_id`
- `applied_item_id` 更新为最新 item id

实现：

- `setRunStateIdleIfActiveRunMatches(...)`（CAS：仅当 `active_run_id` 仍等于该 runId 才回收）

- **一致性约束（v1）**：
  - run-state 回收采用 CAS：仅当 `agent_session_run_state.active_run_id` 仍等于该 runId 且状态为 `running/waiting_permission` 时才回收为 idle。
  - run record 回收采用条件更新：仅当 run record 仍处于 in-flight（`running/waiting_permission`）时才写入 `failed`，避免破坏历史终态。

### 脏数据修复：in-flight 但 active_run_id 为空

历史 bug/异常退出等情况下，可能出现 `agent_session_run_state.status in ('running','waiting_permission')` 但 `active_run_id is null`。

fail 模式会额外执行一次清理（best-effort）：

- 扫描：`listInFlightSessionsWithoutActiveRunId(db)`
- 回收：`setRunStateIdleIfNoActiveRun(...)`（同样带 where 条件，避免覆盖其他状态）

### 模式：recover

沿用旧行为：

- 启动后调用 `enqueueRecoveringRuns()`
- 将 recoverable run enqueue 给 worker，worker 通过 `getPromptContext()` 继续推进。

实现位置：

- `apps/api/src/modules/agent/agent.module.ts` -> `enqueueRecoveringRuns()`

## 取舍与风险

### 为什么开发期默认 fail

- 将“重启”明确为最后手段的 **强制终止**，从运维/排障角度更可靠。
- 在工具存在副作用时，自动恢复通常需要：
  - 可重入的 tool 状态机
  - 幂等/去重
  - 副作用对账/补偿机制
  这些能力在开发早期很难一次性保证。

### fail 模式的代价

- 用户需要手动重新发起任务。
- run 历史中会存在更多 `failed` 记录（这是预期且可接受的开发期策略）。

### 未来启用 recover 的前置条件（建议）

- 工具副作用可重入/可对账（至少对 `write/apply_patch` 明确幂等策略）。
- 对“工具已执行但 completed 事件未落库”的场景提供更细粒度的恢复策略（而不是简单 fail）。
- 为 worker 增加更明确的 checkpoint/lease 机制（可选）。

## 关键代码位置

- 配置解析：`apps/api/src/config/env.ts`
- AppContext 透传：
  - `apps/api/src/app/context.ts`
  - `apps/api/src/main.ts`
- 启动策略入口：`apps/api/src/modules/agent/agent.module.ts`
- recoverable 查询：`apps/api/src/modules/agent/agent.store.ts` -> `listRecoverableRuns()`
- fail 批量更新：`apps/api/src/modules/agent/agent.store.ts`
  - `failNonTerminalContextItemsByRunId()`
  - `failRunRecordIfInFlight()`
  - `setRunStateIdleIfActiveRunMatches()`
  - `listInFlightSessionsWithoutActiveRunId()`
  - `setRunStateIdleIfNoActiveRun()`

## 运维建议

- 开发期建议保持默认：`AWB_AGENT_STARTUP_RECOVERY_MODE=fail`
- 系统稳定后，可通过环境变量灰度切换到 `recover`（例如仅在部分环境启用）。
