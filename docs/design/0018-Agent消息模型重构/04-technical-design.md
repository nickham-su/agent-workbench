# 技术设计

## 总体架构

```text
Worker
  ├─ 获取 Session Prompt Context
  ├─ 模型调用 / 工具执行
  ├─ 写回 Message / Part / ToolExecution
  └─ 前端轮询增量读取

API
  ├─ 维护共享 Message Graph
  ├─ 维护 Session Head / Context Root / Revision
  ├─ 由 session_run_state 权威管理运行状态
  ├─ 构建 Runtime Transcript 投影
  ├─ 执行 Fork / 回退 / 压缩
  └─ 提供 archive_read / archive_search

SQLite
  ├─ Message / Part / ToolExecution 权威数据
  ├─ FTS5 trigram 派生索引
  └─ attachment / run / session 元数据
```

## 数据表设计

以下为本方案的目标表结构。字段名可在实现中微调，但关系、唯一性与不变量不得削弱。

### `agent_message`

```sql
CREATE TABLE agent_message (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,

  previous_message_id TEXT,
  replaces_message_id TEXT,
  depth INTEGER NOT NULL,

  type TEXT NOT NULL CHECK (type IN ('user', 'assistant', 'system', 'compaction', 'runtime')),
  status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'failed', 'cancelled', 'superseded')),

  origin_session_id TEXT,
  origin_run_id TEXT,

  updated_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_message_id) REFERENCES agent_message(id) ON DELETE RESTRICT,
  FOREIGN KEY (replaces_message_id) REFERENCES agent_message(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_session_id) REFERENCES agent_session(id) ON DELETE SET NULL,
  FOREIGN KEY (origin_run_id) REFERENCES agent_run(id) ON DELETE SET NULL
);
```

### `agent_message_part`

```sql
CREATE TABLE agent_message_part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'reasoning', 'image', 'tool_call')),

  text TEXT,
  attachment_id TEXT,
  media_type TEXT,
  filename TEXT,
  tool_name TEXT,
  tool_input_json TEXT,
  provider_tool_call_id TEXT,

  updated_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (message_id, position),
  FOREIGN KEY (message_id) REFERENCES agent_message(id) ON DELETE RESTRICT,
  FOREIGN KEY (attachment_id) REFERENCES agent_attachment(id) ON DELETE RESTRICT
);
```

- `text` 用于 `text` / `reasoning`；
- `attachment_id/media_type/filename` 用于 `image`；
- `tool_name/tool_input_json/provider_tool_call_id` 用于 `tool_call`；
- 未使用字段保持 `NULL`。

### `agent_tool_execution`

`origin_session_id` / `origin_run_id` 仅保留来源与恢复语义，不作为可见性依据；Session 或 Run 删除后置空，ToolExecution 本身保留。

```sql
CREATE TABLE agent_tool_execution (
  id TEXT PRIMARY KEY,
  call_part_id TEXT NOT NULL UNIQUE,

  origin_session_id TEXT,
  origin_run_id TEXT,

  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),

  result_preview TEXT,
  result_truncated INTEGER NOT NULL DEFAULT 0,
  result_artifact_path TEXT,
  structured_result_json TEXT,
  error TEXT,

  updated_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  started_at INTEGER,
  completed_at INTEGER,

  FOREIGN KEY (call_part_id) REFERENCES agent_message_part(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_session_id) REFERENCES agent_session(id) ON DELETE SET NULL,
  FOREIGN KEY (origin_run_id) REFERENCES agent_run(id) ON DELETE SET NULL
);
```

### `agent_session`

```sql
CREATE TABLE agent_session (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,

  head_message_id TEXT,
  context_root_message_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,

  forked_from_session_id TEXT,
  forked_from_message_id TEXT,

  kind TEXT NOT NULL CHECK (kind IN ('primary', 'subtask')),
  title TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (head_message_id) REFERENCES agent_message(id) ON DELETE RESTRICT,
  FOREIGN KEY (context_root_message_id) REFERENCES agent_message(id) ON DELETE RESTRICT
);
```

### `session_run_state`

Session 不重复保存运行状态；运行状态继续由 `session_run_state` 权威管理。

```sql
CREATE TABLE session_run_state (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('idle', 'running')),
  active_run_id TEXT,

  run_notice_text TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,

  active_assistant_message_id TEXT,
  non_terminal_message_ids_json TEXT NOT NULL DEFAULT '[]',
  non_terminal_tool_execution_ids_json TEXT NOT NULL DEFAULT '[]',

  updated_at INTEGER NOT NULL,

  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (session_id) REFERENCES agent_session(id) ON DELETE CASCADE
);
```

`run` 相关记录继续保留 `runId`，recover、重复 recovery、重复 enqueue 均按 `runId` 幂等。Session 硬删除时 `session_run_state` 级联删除；共享 Message/Part/ToolExecution/FTS/附件不删除。

### `agent_archived_text_fts`

FTS 采用简单可实施的“映射表 + FTS rowid”方案，保证每个 eligible completed TextPart 全局唯一且 completed 事务幂等 upsert。

```sql
CREATE VIRTUAL TABLE agent_archived_text_fts USING fts5(
  text,
  message_depth UNINDEXED,
  part_position UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE agent_text_part_fts_map (
  part_id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
```

- 不保存 `session_id`；
- 每个 eligible completed TextPart 全局唯一索引；
- 查询时与指定 Session 的归档祖先链求交；
- streaming 阶段不更新；
- completed 事务中按 `part_id` 幂等 upsert；
- 写入失败时所在完成事务必须回滚；
- 可通过主表与映射表重建。

### ImagePart 关联调整

ImagePart 直接在 `agent_message_part.attachment_id` 上关联附件，一图一个 Part。
不再保留单独的 `agent_message_part_attachment` 表。

- 附件实体继续按 Workspace 存储，不归属于 Session。

### 旧附件表处理

删除旧：

```text
agent_context_item_attachment
```

不再新增对应新表；图片关系直接落在 Part 表。
## 数据库约束与应用约束

### 数据库层可表达约束

- 引用存在、枚举、主键与基础唯一性；
- `UNIQUE(message_id, position)`；
- `UNIQUE(call_part_id)`；
- ImagePart 的 `attachment_id` 引用存在；
- `agent_text_part_fts_map(part_id PRIMARY KEY, fts_rowid UNIQUE)`；
- FTS 虚表本身可重建。

### 应用事务必须保证的约束

以下约束由应用事务、CAS 与恢复流程保证，不强行依赖数据库复杂约束：

- `contextRootMessageId` 是当前 Head 的祖先或自身；
- `previousMessageId` 与 `replacesMessageId` 均同 Workspace；
- `replacesMessageId` 与被替代消息有相同 `previousMessageId`；
- `ToolExecution.callPartId` 指向同 Workspace 下 `type = 'tool_call'` 的 Part；
- FTS 只在 completed 且类型允许的 TextPart 上写入；
- `unknown` 不重新执行；
- queued/running 写回顺序满足恢复语义；
- 归档查询只返回指定 Session 的归档祖先范围；
- Workspace 一致性由应用事务保证，不由复杂数据库约束兜住。

### Workspace 生命周期

- 删除单个 Session：只删除 Session 私有数据与 Run State，不删除共享 Message/Part/ToolExecution/FTS/附件。
- 删除 Workspace：必须显式清理 Workspace 下所有 Message、Part、ToolExecution、FTS 条目、附件、Session 私有数据与运行状态。
- Run 记录删除时，来源引用通过 `ON DELETE SET NULL` 保留 ToolExecution/Message 审计能力。
- 本期不新增 Session 软删除，也不做共享 Message 自动 GC。

## 索引建议

```sql
CREATE INDEX idx_agent_message_workspace_depth
ON agent_message(workspace_id, depth);

CREATE INDEX idx_agent_message_origin_revision
ON agent_message(origin_session_id, updated_revision);

CREATE INDEX idx_agent_part_message_type_position
ON agent_message_part(message_id, type, position);

CREATE INDEX idx_agent_tool_execution_origin_revision
ON agent_tool_execution(origin_session_id, updated_revision);

CREATE INDEX idx_agent_tool_execution_status_origin
ON agent_tool_execution(origin_run_id, status);
```

说明：

- 祖先遍历主要走 `agent_message.id` 主键；
- `depth` 只做排序和预检；
- 不得用 `depth` 替代祖先验证。

## 事务与并发

### cancel wins

同一 `runId` 在 Worker 内只允许一个执行实例；重复 enqueue 幂等，enqueue 前必须做最终 DB 校验；cancel 与 recover 竞争时，取消优先，不恢复已取消 Run。

### Append Message

事务内容：

- 校验 Session Head 与 Revision；
- 创建 Message；
- 创建 Part；
- 更新 Session Head / Revision；
- 更新 session_run_state 中的 active assistant 或 non-terminal 列表。

### Assistant 流式更新

- 只允许更新同 Run 的 streaming Message；
- 更新 TextPart / ReasoningPart；
- 更新 Message.updatedRevision / Session.revision；
- 批量 flush，不逐 token 写库。

### Assistant 完成

事务内容：

- Message 状态从 streaming 到 completed；
- Part 冻结；
- 创建所有 ToolExecution(queued)；
- 写入 FTS；
- 更新 revision。

若 FTS 写入失败，整个完成事务必须回滚，避免主表与索引不一致。

### 自动重试替代

事务内容：

- 校验当前 active run 与 Head；
- 旧 Message 标记 `superseded`；
- 创建替代 Message；
- 更新 Head；
- 更新 revision；
- 更新 run_notice_text。

任何一步失败均回滚，不能留下 Head 指向已作废消息的中间态。

### Fork / 回退 / 压缩

全部使用：

```text
expectedHeadMessageId
expectedRevision
```

做 CAS。若 Head 或 revision 变化，则拒绝操作并返回冲突。

### 工具执行

事务顺序必须为：

```text
持久化 running
  ↓
调用工具
```

不允许先调用工具再补写 `running`。

### 崩溃恢复

Worker 重启时：

- 查找未完成 Run；
- 恢复空 streaming Assistant；
- 将有内容的 streaming Assistant 作废并重建；
- queued ToolExecution 重新入队；
- running ToolExecution 转 unknown；
- 更新 run_notice_text 为自动恢复说明；
- recover、重复 recovery、重复 enqueue 均按 runId 幂等。

### 用户终止

- streaming Assistant（有无部分输出）一律 `cancelled`；
- `superseded` 仅用于已创建替代消息的自动重试，不用于用户终止；
- `queued → cancelled`、`running → unknown`；
- Run 记录 → `cancelled`；
- `session_run_state → idle` 并清空 activeRun/activeAssistant/retry/nextRetry/nonterminal；
- `run_notice_text` 固定改为用户终止说明；
- 提交后旧写回由 fence 拒绝。

## 模型错误退避与提示

所有模型错误持续退避重试，不因错误码判定永久失败。包括：

- 超时、断流、限流、5xx；
- 凭证错误；
- 模型不存在；
- 请求格式错误；
- 其他 Provider 返回错误。

退避建议：

```text
2s → 4s → 8s → 16s → 30s → 60s
```

达到上限后按约 60 秒间隔持续重试，直到：

- 请求成功；
- 用户终止；
- Runtime 内部无法安全继续。

`run_notice_text` 更新规则：

- 模型错误自动重试时，写入最新错误、重试次数、下次重试时间；
- 成功收到有效输出后清除模型重试提示；
- Worker 重启恢复后可重置或改写恢复提示；
- 用户终止时固定写入用户终止说明；
- 错误提示不写入 Assistant TextPart。

Worker 重启后 `retryCount` 可重置为 0；不要求跨进程全局连续计数。

## 模型请求构建

### Runtime Transcript 投影

API 返回 Provider-neutral transcript：

```text
system
user(text + image refs)
assistant(text + tool_call[])
synthetic tool result envelope[]
```

规则：

- 只沿 `previousMessageId` 构建；
- 只包含当前 Session `contextRootMessageId ～ headMessageId`；
- ReasoningPart 过滤；
- Runtime Message 过滤；
- Compaction Message 映射为模型可见摘要；
- ImagePart 只在触发消息时物化，历史图片投影为占位说明；
- ToolExecution 结果只来自 completed Assistant 的 ToolCall。

### Tool Result 合成

每个 completed Assistant 中的每个 ToolCallPart 恰好生成一个合法结果信封，由单一 Runtime Transcript Projector 确定性生成，不回写 `ToolExecution` 权威字段。

通用约束：

- `queued/running` 不允许进入正常下一轮请求；
- 多工具并行完成顺序不影响输出顺序，输出顺序按 ToolCallPart.position；
- 不自动读取 artifact；
- `structuredResult` 仅供已支持的专用 API / UI 使用，不参与本期模型结果选择；
- `subtask` 只是 `resultPreview` 不截断的特例，进入模型的是格式化 `resultPreview`，不是任意 structured 对象。

按 `ToolExecution.status` 确定信封内容：

- `unknown`：固定不确定说明文本，明确该调用可能已执行并可能产生副作用，可附可靠的 `resultPreview`，但不得表述为成功；
- `cancelled`：若有 `error` 优先用 `error`；否则若有可靠 `resultPreview` 用 `resultPreview`；两者皆无使用固定说明“工具调用在执行前被取消，未执行”（对应 `queued → cancelled`，即尚未进入执行）；
- `failed`：`error` 优先，其次可靠 `resultPreview`；两者皆无使用固定内部失败说明；
- `completed`：使用 `resultPreview`；若为空，采用固定空成功结果说明，作为稳定文本处理，不视为不变量错误，不导致 Turn 失败。

`unknown` 的模型可见文本固定表达：

```text
Tool execution outcome is unknown because the runtime was interrupted.
The operation may or may not have completed and may have produced side effects.
Inspect the current workspace state before deciding whether to retry or take another action.
```

## archive_read 设计

### 范围

只返回：

- completed User Text
- completed Assistant Text
- System Text
- Compaction Text

明确排除：

- failed / cancelled / superseded Assistant
- Reasoning
- ToolCall
- ToolExecution
- Runtime
- Image

### Cursor 与失效

- 使用不透明 cursor，不直接暴露物理 rowid；
- cursor 至少包含：
  - `workspaceId`
  - `sessionId`
  - `contextRootMessageId`
  - `messageId`
  - `messageDepth`
  - `partId`
  - `partPosition`
- archive cursor 不绑定 revision，只绑定 `workspace/session/contextRoot + depth/message/position/part`；
- 普通 append / streaming / tool 更新不失效；
- `contextRoot` 变化后旧 cursor 失效；
- 若 cursor 伪造、跨 Workspace、不属于当前 Session 归档祖先链，必须拒绝；
- cursor 必须先做完整性与祖先校验，再应用 keyset 谓词，校验失败稳定拒绝；
- archive_read SQL 先按时间倒序取页，应用层 reverse 后按旧到新返回。

### 稳定 keyset 谓词

当前单父祖先链上，`messageDepth` 在一个 Session 当前归档路径中唯一对应一个 Message，但 cursor 中的 `messageId/partId` 仍必须做完整性与祖先校验。

对于“早于 cursor”的稳定严格关系，使用：

```text
m.depth < :cursor_depth
OR (
  m.depth = :cursor_depth AND m.id < :cursor_message_id
)
OR (
  m.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position < :cursor_part_position
)
OR (
  m.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position = :cursor_part_position AND p.id < :cursor_part_id
)
```

### SQL 思路

```sql
WITH RECURSIVE lineage AS (
  SELECT id, previous_message_id, depth
  FROM agent_message
  WHERE id = :start_message_id
    AND workspace_id = :workspace_id

  UNION ALL

  SELECT parent.id, parent.previous_message_id, parent.depth
  FROM agent_message parent
  JOIN lineage child ON parent.id = child.previous_message_id
)
SELECT p.id AS part_id, p.message_id, l.depth AS message_depth, p.position AS part_position, p.text
FROM lineage l
JOIN agent_message m ON m.id = l.id
JOIN agent_message_part p ON p.message_id = l.id
WHERE p.type = 'text'
  AND m.type IN ('user', 'assistant', 'system', 'compaction')
  AND m.status = 'completed'
  AND (
    :cursor_depth IS NULL
    OR l.depth < :cursor_depth
    OR (l.depth = :cursor_depth AND m.id < :cursor_message_id)
    OR (l.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position < :cursor_part_position)
    OR (l.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position = :cursor_part_position AND p.id < :cursor_part_id)
  )
ORDER BY l.depth DESC, m.id DESC, p.position DESC, p.id DESC
LIMIT :limit;
```

应用层将结果 reverse，响应按旧到新返回。

## archive_search 设计

### 范围

只返回：

- User Text
- completed Assistant Text
- System Text
- Compaction Text

排除：

- failed / cancelled / superseded Assistant
- Reasoning
- ToolCall
- ToolExecution
- Runtime
- Image

### SQL 思路

`archive_search` 必须显式通过以下链路关联：

```text
agent_archived_text_fts.rowid
  -> agent_text_part_fts_map.fts_rowid
  -> agent_text_part_fts_map.part_id
  -> agent_message_part
  -> agent_message / lineage
```

示意 SQL：

```sql
WITH RECURSIVE lineage AS (
  -- 当前 Session 从 contextRoot.previous 向前到根
)
SELECT
  map.part_id,
  p.message_id,
  m.depth,
  p.position,
  snippet(agent_archived_text_fts, 0, '[', ']', ' … ', 24) AS excerpt
FROM agent_archived_text_fts AS fts
JOIN agent_text_part_fts_map AS map
  ON map.fts_rowid = fts.rowid
JOIN agent_message_part AS p
  ON p.id = map.part_id
JOIN agent_message AS m
  ON m.id = p.message_id
JOIN lineage AS l
  ON l.id = m.id
WHERE agent_archived_text_fts MATCH :query
  AND m.workspace_id = :workspace_id
  AND m.type IN ('user', 'assistant', 'system', 'compaction')
  AND m.status = 'completed'
  AND p.type = 'text'
  AND (
    :cursor_depth IS NULL
    OR m.depth < :cursor_depth
    OR (m.depth = :cursor_depth AND m.id < :cursor_message_id)
    OR (m.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position < :cursor_part_position)
    OR (m.depth = :cursor_depth AND m.id = :cursor_message_id AND p.position = :cursor_part_position AND p.id < :cursor_part_id)
  )
ORDER BY m.depth DESC, m.id DESC, p.position DESC, p.id DESC
LIMIT :limit;
```

- `archive_search` 响应按新到旧返回；
- cursor 与 `archive_read` 一样不绑定 revision，只在 `contextRoot` 变化后失效；
- tokenizer 使用 `trigram`；
- 查询词至少 3 个字符；
- 查询词少于 3 个字符时稳定拒绝，不返回模糊匹配结果；
- 移除 `regex` 参数；
- 旧 `beforePos` 概念由不透明 cursor 替代；
- 必须同时满足 FTS 命中和当前 Session 归档祖先链可达；
- 伪造 cursor、跨 Workspace、超出当前归档范围都必须拒绝。

## FTS 写入、重建与 Workspace 删除

### completed 事务幂等写入

- 与 Message completed 处于同一 SQLite 事务；
- 对每个 eligible completed TextPart，先按 `part_id` 查询 `agent_text_part_fts_map`；
- 不存在：
  - 插入 `agent_archived_text_fts(text, message_depth, part_position)`
  - 取 `rowid`
  - 插入 `agent_text_part_fts_map(part_id, fts_rowid)`
- 已存在：
  - 复用既有 `fts_rowid`
  - completed 终态冻结，正常不更新文本
  - 恢复或重复提交只要求幂等，不重复插入
- 任一 FTS 写入失败，整个 completed 事务回滚；
- FTS 行与 map 行必须在同一 completed 事务中提交，任一方缺失即回滚，保证无孤儿。

### 受控重建

- 在受控事务中清空 `agent_archived_text_fts` 与 `agent_text_part_fts_map`；
- 扫描所有 eligible completed TextPart；
- 重新插入 FTS 并重建 map；
- 重建结果必须与主表查询一致。

### Workspace 删除

Workspace 删除从 durable `workspace_deletion` intent 开始，而不是从进程内 fence 开始。原则是：

- 先完成 Workspace 路径等无副作用校验，再短事务写入 intent；启动时先 hydrate intent 到 fence，防止重启后恢复为普通可写状态；
- intent 存在期间阻止新 Run、终端创建和 Workspace 写入；Worker drain、tmux kill 与文件操作均不得持 SQLite 写锁；
- 文件域（Workspace 根、附件及 apply_patch/write UI artifact）必须通过固定 `dataDir` 目录 fd 移入根内 quarantine，并验证 inode 后递归删除；普通 retire 槽固定编码为 `.delete-v1-<scope>-<type>-<dev>-<ino>-<nonce>`。扫描只有严格解析并验证 expected `dev/ino/type` 后才可清理；旧/未知格式、scope 不符、symlink、类型异常、identity mismatch、权限或 I/O 不确定均 fail-closed，保留 intent。`.delete-replacement-pending-*` 仅是可读诊断优化，marker rename EIO 时原 v1 名仍可在 restart/retry 中识别 pending；任一相关 pending 不得删除 tombstone 或 fence；
- 所有 tmux 都成功 kill 后，必须先依照每 artifact authority row 清理 Terminal 的 SSH key、askpass 与 askpass token，才可在最终事务统一删除 terminal 记录。认证文件直接在固定 trusted `dataDir` root 以 `O_DIRECTORY|O_NOFOLLOW`、`O_EXCL|O_NOFOLLOW` 建立，删除复用 v1 retire；`tmp` 不属于 auth live 生命周期。`dataDir` 是 durable locator trust anchor：root 不再 current 时 fail-closed，认证清理失败保留 intent/fence 与 records，供重试或启动恢复；
- 先删派生索引与私有引用，再删共享实体；
- 共享实体先解除外键引用，再批量删除；
- 最终 SQLite 事务只在外部副作用均收敛后执行；任一步失败保留 Workspace、intent 和 fence，下一次 DELETE 或 runtime ready 时继续；仅最终事务成功才释放 fence。
- Managed Worker health ready 后，先续作 durable Workspace deletion，再恢复剩余 Run，最后 best-effort reconcile Terminal；删除或 Terminal 续作失败只记录并保留 durable intent，不得杀死健康 Worker。
- startup Run recovery 对 deleting Workspace candidate 是预期 skip：可在锁前预检，但必须在 Session handoff lock 内再次确认 fence；fence 获胜时不得 prepare、enqueue 或建立 enqueue reconciliation timer，并且必须继续扫描其他 Workspace candidate。
- startup recovery 的 prepare 与最终 enqueue 是两次独立 Session handoff lock：若 prepare 成功、释放首锁后 deletion fence 建立，则第二次锁内的稳定 `WORKSPACE_DELETING` 是确定性停止，不是 Worker ACK/网络未知。它必须原样传播供 recovery skip，清除该 Run 已有 reconciliation timer/attempt，不转 `AGENT_WORKER_ENQUEUE_UNKNOWN`、不重排。已激活的 user Run 与 `manual_compaction` 复用同一规则；删除负责其最终收敛，不得擅自 failed/idle。
- 其他非预期 Run recovery 故障仍可使该 Worker generation ready 失败；Worker manager 仅在 health ready **且** ready 编排成功后重置 restart backoff/circuit history，避免确定性 ready hook 故障形成最短周期重启。

实际删除顺序：

```text
阻止新 Run / 写回，终止该 Workspace 内所有活动 Run
  -> 按 workspace 收集全部 part_id 及其 map.fts_rowid
  -> 删除 FTS row（agent_archived_text_fts）
  -> 删除 map（agent_text_part_fts_map）
  -> 删除 session_run_state
  -> 删除 run 记录（agent_run）
  -> 删除其他 Session 私有引用，并删除 Session（agent_session）
       从而解除 head_message_id / context_root_message_id 对 Message 的外键
  -> 删除 ToolExecution（agent_tool_execution）
  -> 删除 Part（agent_message_part）
  -> 在 workspace 范围内将 Message 的 previous_message_id / replaces_message_id 统一置 NULL
  -> 批量删除 Message（agent_message）
  -> 删除已无引用的附件（agent_attachment）
  -> 删除 Workspace（workspaces）
```

实施注意：

- 在进入删除事务之前，先设置 Workspace 级 deleting fence 阻止新 Run / 新写回，并等待活动 Worker 完成；等待过程不持有数据库写锁；
- 所有删除 SQL 必须严格按 `workspace_id` 过滤，禁止全表扫描式删除。

附件与 destructive upgrade 文件清理同样使用目录 fd 能力：

- temp 文件由固定 temp 目录以 `O_EXCL | O_NOFOLLOW` 创建；发布使用固定父目录 hard-link，并验证源/目标 inode；
- 业务名删除先 retire 到 `.delete-v1-<scope>-<type>-<dev>-<ino>-<nonce>` 私有槽，再验证 inode/type 并只删除私有槽。普通 stale 槽只有 v1 identity、scope 与当前对象完整匹配时才可在同域 retry 收敛；旧/未知格式、symlink、type 异常或 replacement 都是 pending，marker 永不自动删除，destructive upgrade 必须保持 `file_cleanup_pending`；
- attachment 私有 file 槽带关联的受限 prefix，temp/final 显式 remove 在业务名已缺失时仍会扫描并收敛同一对象的普通槽；若扫描到 replacement marker 则返回 cleanup pending，绝不以 `ENOENT` 伪报成功；
- final link 后 source 尚未确认清理时，commit error 分别报告 `finalCreated`、`finalCleanupPending` 与 `sourceCleanupPending`。catch 优先沿原 temp dirfd 清理 source；若仍可安全定位但常规 retire 不能完成，则移动到 `attachments/.attachment-cleanup` 这一稳定受控目录，启动 aged-temp janitor 重试其中普通槽；无法验证、移动或删除时才保持 `sourceCleanupPending`；
- 授权读取立即以 `O_RDONLY | O_NOFOLLOW` 打开，HTTP 流从该 fd 创建并在结束、错误或取消时关闭，不允许授权后按字符串路径重开；
- destructive upgrade 只将经验证的目录从固定 `dataDir` fd 原子移入 `.agent-upgrade-quarantine`，移动对象及 quarantine inode 均再次验证；目录 fd 能力不可用的平台不执行危险清理并保留 pending。

### 有限威胁模型

- 该协议覆盖 symlink、业务名替换、父目录变化、可检测 private-slot replacement、inode/type 不匹配、系统调用异常和不确定结果；这些情况一律 fail-closed。
- 随机私有槽、重复 `lstat` 与 `0700` 是缩小名称竞争面的组合协议，不是形式化 inode-bound unlink 保证。
- 明确排除同一 OS 用户的恶意进程在最终 syscall 前对不可预测私有槽进行无限精确抢占；本项目不为该排除威胁引入 helper、setuid、独立 UID 或独立服务。

说明：

- `agent_message.origin_session_id / origin_run_id`、`agent_tool_execution.origin_*` 是 `ON DELETE SET NULL`，在删除 Session / Run 时自动置空，与上述顺序一致；
- `session_run_state.session_id` 是 `ON DELETE CASCADE`，随 Session 删除级联，但此处显式先删以便终止活动 Run；
- Message 自引用外键 `previous_message_id / replaces_message_id` 是 `ON DELETE RESTRICT`，必须先在该 workspace 范围内统一置 NULL，再批量删除 Message；
- `agent_session.head_message_id / context_root_message_id` 是 `ON DELETE RESTRICT`，必须先删除全部 Session，解除其对 Message 的引用，再删除 Message。

## 前端增量设计

### 轮询响应

建议响应包含：

```ts
type ConversationDeltaResponse = {
  revision: number;
  timelineReset: boolean;
  messages: MessageView[];
  toolExecutions: ToolExecutionView[];
  nonTerminalMessageIds: string[];
  nonTerminalToolExecutionIds: string[];
};
```

### 触发 timelineReset 的情况

- 自动重试替代；
- 消息回退；
- 压缩；
- 非追加式 Head 变化。

### 大内容处理

- 列表与轮询接口不返回大型 ToolExecution 详情；
- 只返回摘要、状态、是否存在 artifact；
- 详情接口只返回实际已保存的 `structuredResult / resultPreview / artifact` 信息，不宣称保存了完整原始工具输出。

## Subtask 关联调整

当前 Subtask 使用 `parent_tool_item_id`。新模型必须迁移为：

```text
parent_tool_execution_id
```

子任务是工具执行的派生结果，而不是 ToolCall 声明本身。

## 压缩实现

### 压缩输入

- 当前 `contextRootMessageId ～ headMessageId`；
- 完整 TextPart；
- ToolExecution 结果沿用当前预览/artifact 摘要；
- Reasoning 不参与；
- failed/cancelled/superseded Assistant 不参与。

### 摘要生成失败

- 不改变 Head；
- 不改变 Context Root；
- 不标记任何历史 Message；
- Compaction Provider 错误持续退避重试；
- 用户终止 / SQLite 不变量失败 / 输入分块硬限制是压缩失败边界。

### 摘要超限

若压缩模型调用自身超限：

- 按 Message 边界分块；
- 中间摘要仅在 Worker 内存中累积；
- 成功后 CAS 事务直接创建 `completed` Compaction Message 并切 head/contextRoot；
- 不提前写 streaming Compaction Message；
- 600 秒定义为单次摘要 Provider 请求超时，超时继续退避重试；
- 8 块为输入硬限制，超过则压缩失败。

## 工具 artifact 规则

- 沿用当前 containment/realpath/symlink/safe segment 安全规则；
- 路径从 provider `toolCallId` 改为 `toolExecutionId`；
- 前端 `apply_patch` / `write` 卡片读取 artifact 时，以
  `workspaceId + sessionId + toolExecutionId + 组件 generation` 绑定请求；scope
  切换或组件卸载会 abort 请求，响应返回后仍需再次核验 scope，才允许调用宿主
  editor。晚到响应不可改变旧卡片 loading/error，亦不可打开旧 diff/preview；
- 允许同一 execution 幂等重写；
- 不承诺绝对不可覆盖；
- artifact 成功而数据库失败时，允许文件残留，后续同 execution 可重写；
- 200k 后内容丢失是接受取舍，不承诺完整。

## Web timeline 与控制面并发

- 单个 `workspaceId + sessionId + generation` scope 只有一个 timeline HTTP 请求；新
  刷新意图不能因在途请求丢弃。调度器把 tail freshness (`snapshot > delta`) 与
  pagination (`before`) 作为独立 pending intent：tail 可先执行一次，但有等待的 before 时必须
  随后运行，不得被 snapshot/delta waiter 吞掉或永久饥饿。`before` 只有在服务端确认
  `hasMore=false` 或无 cursor 时结算；成功取得一页后使用最新 cursor 继续。scope 切换或卸载会
  abort active HTTP、结算 pending waiter 并令旧响应失效。
- Revert 成功、Compaction 已提交或运行从 `running -> idle` 都属于非追加变更：前端
  提升本地 timeline epoch，并排队 `snapshot`。epoch 之前发出的响应即使晚到也
  不得覆盖新链；idle 后无条件最终刷新，确保 head/contextRoot 修改被 reset 或
  snapshot 捕获。结构 snapshot 在临时网络失败时保留 durable intent，按
  `250ms → 500ms → 1s → 2s → 4s` 退避重试；总尝试次数严格为初始一次加上 delay
  数组长度。耗尽后 reject 原 structural waiter，清除 structural intent、timer 与 retry index，
  使 Revert/Compact 的 `finally` 释放 disabled/sending，而非永久锁定交互。timer 存在时普通
  tail 只能排队，不能触发 structural 提前 drain；pagination 可独立按公平规则完成。scope 变更或
  dispose 会 abort active HTTP、清 timer 并结算 waiter。
- `before` 返回 `TIMELINE_CURSOR_NOT_FOUND` / 404 时不保留失效 cursor 反复报错，
  而是在同一调度链回退 `snapshot`，然后以新 cursor 重试原 before intent。
- ToolExecution detail 请求绑定 scope、execution 可见性、timeline 中的
  `updatedRevision` 与同 execution request sequence。timeline 抬升 execution
  revision 时清除旧 detail；旧 detail、不可见 execution 或旧 scope 响应不得回填。
- `/compact` 使用与普通消息相同的 pending attempt：同一 Session、Workspace、Agent
  和 locale 命令上下文在响应未知时复用 `clientRequestId`；确定成功才清除，Session
  或上下文变化才生成新 ID。network/timeout/5xx 仍属结果未知；
  `AGENT_WORKER_ENQUEUE_REJECTED` 和其他明确前置 4xx 清除 attempt，使下次点击生成新 ID。
- Fork/Revert 以前端 Session-wide、Vue 响应式 in-flight guard 互斥。操作中同一 Session
  的所有 Fork/Revert 控制都禁用，不影响其他 Session，且不为低频 UI 操作扩大后端契约。
- Web 组件测试保留 Node 原生 `node:test` 门禁，并以 `vite-node + happy-dom + @vue/test-utils`
  转换和挂载真实 SFC；不迁移至 Vitest。Artifact 卡片的 scope props 更新在 `onBeforeUpdate`
  同步推进 guard 并 abort 旧请求，watch 作为同一规则的响应式补充，避免更新周期内晚到结果打开新
  scope 的 editor。

## 图片规则

- 图片作为附件资源保存，一图一个 ImagePart；
- 当前 Run 触发消息中的 ImagePart 会被物化给 Provider；
- 历史 ImagePart 不重新发送；
- 历史图片在模型投影中变为明确占位说明。

## 升级方案

### 数据清理

升级脚本必须明确清理：

- `agent_context_item`
- 旧 `agent_context_item_attachment`
- 旧归档文件目录
- 旧 Run 与旧消息状态
- 依赖旧 Item ID 的 Subtask / artifact 关联

部署策略二选一：

- 保留 Workspace / Agent 配置，只清 Agent 历史；
- 或按部署环境直接重置整个 `.data`。

必须明确选择，不能隐式混用。

### 回滚策略

本方案是破坏性 schema 与数据升级，一旦上线新写模型，不回滚到旧 ContextItem 双模型。代码回滚必须依赖备份数据库或重新初始化 `.data`，不能要求运行时兼容旧新混合数据。

## 已删除能力的处理

- Clear API、共享契约、Worker 分支、前端入口完整移除；
- `boundaryReason = "clear"` 移除；
- 文件归档、`rg`、归档 reconcile 相关模块移除；
- 旧 `buildArchiveLine()` 不作为新实现参考数据源。

## 文件安全与 Workspace 删除围栏

### 破坏性升级与隔离区

Agent 旧文件清理从已固定的 `dataDir` 目录 fd 开始。目标目录会先被原子移动到根内随机 quarantine entry；移动后立即以 `O_DIRECTORY | O_NOFOLLOW` 打开并固定该目录 inode。不得重新按业务根路径解析目录，也不得使用 `fs.rm(path, { recursive: true })`。

每个子目录在递归前同样固定 inode。若任一步发现软链、替换、逃逸或平台不支持目录 fd 能力，操作 fail-closed，保留 `file_cleanup_pending` 供下次安全重试。遗留 quarantine entry 也遵循相同的固定后清理规则。

### Exact-object retire 协议与威胁边界

本部署采用受限威胁模型：应用会防御可检测的业务名替换、软链、父目录替换、私有槽 inode/type 不匹配、目录 fd 能力缺失与系统调用异常；明确排除同一 OS 用户的恶意进程在最终 syscall 前对不可预测私有槽进行无限精确抢占。该边界不排除任何已可检测的 replacement 风险。

在该边界内，业务 entry 必须先在固定、`0700` 的受控 parent 内原子 retire 到 `.delete-v1-<scope>-<type>-<dev>-<ino>-<nonce>` 私有槽，并在 retire 前后比对 `dev/ino/type`。所有递归 child、stale quarantine entry 和 attachment temp/final/aged-temp 均复用相同语义，且绝不在业务原名上执行最终 `unlink/rmdir`。扫描只允许删除 identity 与 scope 均严格匹配的 v1 槽；旧格式、未知格式、symlink、type 异常和不匹配均为 pending。replacement marker 只是诊断 rename：即使该 rename 发生 EIO，原 v1 名仍保存 expected identity，后续 retry/restart 绝不把未知对象删除。

私有槽删除 syscall 失败、目录能力异常或任何无法确定的结果均 fail-closed：destructive upgrade 保留 `file_cleanup_pending`，Workspace 删除保留 tombstone/fence，附件分别报告 `finalCleanupPending` 或 `sourceCleanupPending`。未标记 replacement 的 stale quarantine 槽在下一次启动/重试中可继续安全收敛。不得把这一协议宣传为跨越已排除同 UID 无限精确抢占模型的形式化 inode-bound unlink 保证。

### 附件发布与读取

附件目录链同时持有 `dataDir → agent → attachments → temp/by_workspace/workspace` 的目录 handle，并严格按子到父的顺序关闭。temp 使用 `O_EXCL | O_NOFOLLOW` 创建后，必须复验目录链和新文件 inode；父目录变化时只经原固定 temp fd 删除仍匹配本请求 inode 的文件，随后关闭 handle 并失败。

final 以 hard-link 发布。link 后任一目录复验失败时，只能经固定 workspace fd retire source inode 相同的 final；无法验证或删除时以 `finalCleanupPending` 返回。commit 全程保留固定 temp handle；final 发布后 source 尚未被确认清理（包括 temp 父目录 topology 变化）时，必须以 `sourceCleanupPending` 失败返回；`finalCleanupPending` 与 `sourceCleanupPending` 均禁止调用层退回到逻辑 pathname 清理。授权读取返回已打开的 fd，HTTP 响应只以该 fd 建流，不能在授权后重新按字符串路径打开。

### Workspace 生命周期 admission

### 递归私有槽、附件 janitor 与 Terminal auth 创建期恢复

- 递归删除枚举到任何 `.delete-*` 时，必须先进入私有槽协议；合法 v1 槽从名称恢复 expected `dev/ino/type/scope`，仅在当前对象完全匹配时按编码类型删除或递归。不得将 v1 槽再次作为业务 entry retire；marker、旧/未知格式、symlink、类型或 identity mismatch、I/O 不确定均为 `replacement_pending`。
- attachment aged janitor 仅将 `tmp_<safe-id>.part` 视为普通业务临时文件。所有 `.delete-*`（包括 marker、旧格式和未知格式）只由 `cleanupSecureRetiredFiles()` 按 identity 协议处理；其 pending 是诊断结果，普通 aged 扫描不得二次触碰。
- Terminal Git auth 的 live 文件从创建开始直接锚定已固定的 `dataDir` root dirfd，业务名为确定且安全的 `.terminal-auth-live-v1-<kind>-<terminalId>`。创建使用 `O_EXCL|O_NOFOLLOW` 和最小权限，写后复验 handle/path `dev/ino/type` 与 dataDir root current。writer 遇到业务名 `EEXIST` 一律 `pending`：不得用即时 `lstat` 推断 authority、不得删除/覆盖现有文件、不得写入新 secret。`dataDir/tmp` 不参与该协议，移动、替换或普通内容不得影响 root live 文件的定位或清理。
- `terminal_auth_cleanup_intents` 是每 artifact 一行的 secret 副作用前 fail-closed authority：复合主键为 `(terminal_id, artifact_kind)`，保存 root business name、artifact expected `dev/ino`、dataDir root `root_dev/root_ino`、诊断与 `armed|recoverable|unresolved` phase。每个 writer 前分别观测并 arm root identity，writer 在写入前再次比较同一 anchor；`armed`、`recoverable` 必须有有效安全整数 root identity，legacy migration 的 `unresolved` 才可为 null，正常 unresolved 更新保留最后可信 anchor。arm/update/clear 均要求 DML `changes === 1`，并对 arm/update 读回全部字段、对 clear 再读确认不存在。`RAISE(IGNORE)`、零行或读回异常都会回滚发布事务。armed insert 失败时不允许进入该 artifact writer。
- 若同一进程可靠证明 credential 读取、解密或网络环境构建在 artifact writer 进入前失败，则不存在 auth side effect window：同一短事务 clear armed latch 并转 `closed`，向调用方保留原始业务错误；clear/status 失败则整体回滚并保留 armed。此例外不适用于重启后的 armed，跨进程不得以路径缺失推断安全。
- `terminal_auth_cleanup_intents` 由专用 base-schema verifier 管理：缺表创建 canonical；仅支持项目演化中两种精确单行旧 DDL：四列无 phase，或五列且 `phase` 为精确 `armed|recoverable|unresolved` CHECK。两者都必须具有指定列顺序、`terminal_id` 单列 PK、Terminal `ON DELETE RESTRICT` FK、唯一命名且非 unique 的 `updated_at` 单列 index、无额外 index 与无 orphan；匹配后才在事务中 rebuild 为 `artifact_kind=legacy, phase=unresolved` 并保留诊断。任一 CHECK、FK、PK、列、index、row phase 或 orphan 异常均抛稳定 Unsupported 错误，且不 rename、rebuild 或猜测修复。
- `recoverable` 表示该 artifact 的 root business 文件或 identity 编码私有槽已可跨重启定位；正常 active Terminal 合法保留所有实际 artifact 的 recoverable rows，不能清除。`armed` 表示尚未证明是否创建，`unresolved` 表示定位未建立；任一此类行均阻断 closed 和删除。
- `cleanupTerminalGitAuthArtifacts`、启动 reconcile、Terminal 删除与 Workspace 删除打开当前配置路径的 dataDir root 后，必须先比较每行 `root_dev/root_ino`。root 被整体 rename、同路径重建或任一 HTTPS artifact anchor 不匹配时，均为稳定 pending：不得扫描/猜测旧 inode，不得把当前路径缺文件视为成功，不得 clear intent、closed Terminal 或删除 Workspace/tombstone/fence；只有人工恢复原 root 路径后才可安全重试。root identity 通过后，才按每行的 root business name、expected identity 和关联 scope 的 v1 私有槽收敛。所有 recoverable 行实际收敛后，才可在同一 SQLite 事务清行并转 `closed` 或删除 records。旧 `.terminal-auth-cleanup` 或中间 tmp 协议遗留不得猜测已清，必须保守保留为 legacy/unresolved 边界。
- multipart upload 的 lifecycle admission 覆盖 target 解析、upload lock、multipart 消费、保存与失败清理。删除 intent 在已入场 upload 退出前不得建立；intent 建立后新 upload 以 `WORKSPACE_DELETING` 拒绝且不落盘。

`WorkspaceLifecycleCoordinator` 是单 API 进程内、按 Workspace 分片的轻量 gate，不承担分布式锁职责。删除在 gate 内完成无副作用校验、durable tombstone 写入和 deleting fence 建立；随后释放 gate 执行 Worker drain、tmux、文件清理与最终 SQLite transaction。这样慢操作不阻塞 admission，但后续 mutation 入场时已经可见 durable fence。真实 multipart route 覆盖 restored fence 的 409/零落盘；已入场 upload 完成前 delete intent 必须等待，intent 建立后新的 upload 必须拒绝。

Files 与 Git 的所有写操作、Workspace title/settings/relation 与 last-used 元数据写入，以及 Terminal create/delete，必须在同一 gate 内先调用 `assertWritable`，并遵循 `lifecycle → workspace/repo lock → side effect`。workspace-files 的 write/create/mkdir/rename/delete 与 upload 的 target 解析、lock、multipart 消费、写入/失败清理均在 gate 内。相同异步链可对同 Workspace 受控重入，但首次 mutation 必定先检查 fence；另一 Workspace 不继承该重入能力。启动恢复 tombstone 后，同 Workspace mutation 一律拒绝，其他 Workspace 仍可独立执行。

### tmux 与 Terminal 可恢复 intent

`tmuxHasSession` 仅在明确的 `can't find session`、`no server running` 等定义 not-found 结果下返回不存在；spawn、超时、server 或未知错误均为 indeterminate 并抛出。`new-session` 抛错后必须先 probe 同名 session：明确 not-found 才能 fallback；exists 或 indeterminate 均保留 durable intent 并执行/retry cleanup。Workspace 删除遇到这些错误保留 tombstone/fence 和所有 terminal record，等待安全重试。

Terminal 创建先写 durable `creating` record；每个认证 artifact 在自己的 writer 前写 `armed` row，成功写入并验证 root identity 后更新为 `recoverable`。成功 active 时保留这些权威 locator，对外列表仍只返回 `active`。tmux 或 activation 收尾失败时，补偿 kill 并逐 artifact 清理；仅全部 recoverable row 实际收敛后才可清行并 closed。启动 runtime ready 与 Workspace 删除不得猜测 `armed`/`unresolved` 安全。
