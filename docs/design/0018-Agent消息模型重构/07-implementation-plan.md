# 实施计划

## 阶段零：冻结与准备

- 确认本设计文档为唯一权威方案。
- 确认升级脚本选择：
  - 仅清理 Agent 历史数据；或
  - 重置整个 `.data`。
- 删除旧实现分支前，先标记将被整体替换的模块。
- 不允许在旧 ContextItem 模型上继续叠加新功能。

## 阶段一：Shared 契约与数据库基座

### 任务

- 新增 `Message / Part / ToolExecution / Session / session_run_state` 契约。
- 删除或替换旧 `ContextItem` 契约。
- 新增目标 SQLite 表、索引、外键和唯一约束。
- 编写 schema migration / reset 脚本。
- 删除 Clear 相关契约字段与枚举值。
- 明确 Workspace 删除时的显式级联清理策略。

### 完成标准

- typecheck 通过。
- schema test 覆盖唯一约束与外键。
- 升级脚本能从干净状态初始化新库。
- Session 删除不删除共享 Message。
- Workspace 删除清理路径明确。
- `foreign_keys=ON` 集成测试通过：多层 previous/replaces 链、多 Session 共享、head/contextRoot、Execution、附件、FTS/map 全部清理，无孤儿。

## 阶段二：API 持久化与事务基座

### 任务

- 实现 Message append/update/query。
- 实现 ToolExecution append/update/query。
- 实现 Head/revision CAS。
- 实现 run fence 与终态冻结。
- 实现 session_run_state 权威运行状态。
- 实现 Fork/Revert 基础操作。
- 实现 Compaction Message 提交。
- 删除旧 ContextItem store 主路径。

### 完成标准

- 所有跨实体写入都在 SQLite 事务中完成。
- 不存在只更新 Head 或只更新 Message 的半提交路径。
- 单元测试覆盖 CAS、终态、Workspace 一致性和关联唯一性。

## 阶段三：Runtime Transcript 与工具结果投影

### 任务

- 实现当前 Session `contextRoot ～ head` 的祖先链读取。
- 实现 Provider-neutral transcript 投影。
- 实现 ToolCall + ToolExecution 的 Tool Result 合成。
- 实现 Reasoning 过滤。
- 实现历史图片占位规则。
- 删除旧相邻 Item 推断 prompt 构建。
- 工具结果投影采用阶段五冻结的确定性信封规则（unknown/cancelled/failed/completed 分支），不另行设计最小投影。

### 完成标准

- 一次 Assistant 多 ToolCall 可按 Part 顺序稳定重建。
- unknown/failed/cancelled 均能生成合法工具结果。
- 不存在 `runId + turnId + step` 推断残留。

## 阶段四：Worker 模型流与自动重试

### 任务

- Assistant Message 流式创建与更新。
- Text/Reasoning/ToolCall Part 流式写入。
- 模型错误持续退避重试。
- 空 Assistant 原地重试。
- 部分输出 Assistant 作废替代。
- 错误提示写回现有 Run 提示机制。
- Assistant completed 时创建 ToolExecution。

### 完成标准

- 前端能在请求进行中持续看到输出。
- Provider 错误不会结束 Turn。
- 部分输出重试不污染正常链。
- 用户终止后停止重试。

## 阶段五：工具执行与崩溃恢复

### 任务

- 将工具结果迁移到 ToolExecution。
- 沿用 8k/3k/200k artifact 规则。
- artifact 路径改用 `toolExecutionId`。
- 实现 artifact containment / realpath / symlink / safe segment 安全校验。
- 实现 artifact 成功而 DB 失败时允许残留、同 execution 幂等重写的语义。
- 实现工具模型结果投影唯一规则，由单一 Runtime Transcript Projector 生成，每个 completed Assistant 的每个 ToolCallPart 恰好一个结果信封，不回写 `ToolExecution` 权威字段：
  - `unknown`：固定不确定说明，明确可能已执行/有副作用，可附可靠 `resultPreview`，不作为成功；
  - `cancelled`：有 `error` 优先 `error`，否则有可靠 `resultPreview` 用 `resultPreview`，皆无固定说明“工具调用在执行前被取消，未执行”；
  - `failed`：`error` 优先，其次可靠 `resultPreview`，皆无固定内部失败说明；
  - `completed`：使用 `resultPreview`，为空时采用固定空成功结果说明，不视为不变量错误，不导致 Turn 失败；
  - 不自动读取 artifact；
  - `structuredResult` 不参与本期模型结果选择，仅供专用 API/UI；
  - `subtask` 进入模型的是不截断的格式化 `resultPreview`，不是任意 structured 对象。
- 实现 Fork 共享历史 ToolExecution 与 artifact 读取，不复制、不重跑。
- 实现 queued/running/unknown 状态机。
- Worker 重启恢复未完成 Run。
- Subtask 父关联迁移到 ToolExecution。
- 实现 startup recovery，recover、重复 recovery、重复 enqueue 按 runId 幂等。

### 完成标准

- running 崩溃后恢复为 unknown。
- unknown 作为模型结果继续下一轮。
- 历史工具不会在 Fork/回退后重新执行。
- Run 恢复与终止闭环测试通过。
- artifact 父/目标 symlink、containment、safe segment、200k 截断测试通过。
- artifact 成功而 DB 失败残留、同 execution 幂等重写测试通过。
- Fork 共享历史 ToolExecution 与 artifact 读取测试通过。
- 普通、结构化、`subtask` 三类工具模型重建测试通过。
- 工具结果信封投影规则测试通过：`queued → cancelled`、failed 空结果、completed 空结果、每 ToolCall 恰好一个结果、并行顺序稳定。
- 工具模型结果投影唯一规则测试通过，`structuredResult` 不进入模型请求。

## 阶段六：Fork / 回退 / 压缩

### 任务

- 替换 fork 为无复制实现。
- 替换回退为 Head 指针移动。
- 替换压缩为 Compaction Message + Session context root 更新。
- 删除 clear 全链路。
- 删除文件归档与 reconcile。
- Compaction 中间摘要不落库，Provider 错误持续重试，分块超限/不变量失败/用户终止才失败。

### 完成标准

- Fork 只新增 Session 记录，不复制历史。
- 回退不修改旧消息。
- 压缩不影响其他共享分支。

## 阶段七：归档查询与 FTS

### 任务

- 删除归档文件、`rg`、旧 archive reconcile。
- 实现 archive_read。
- 实现 FTS5 trigram archive_search。
- 实现 `agent_text_part_fts_map(part_id PRIMARY KEY, fts_rowid UNIQUE)` 映射表。
- 保证 FTS 行与 map 行在同一 completed 事务中提交，无孤儿。
- 实现 cursor 先做完整性与祖先校验，再应用 keyset 谓词。
- 实现 trigram 查询词少于 3 个字符时稳定拒绝。
- 实现 completed 事务内按 `part_id` 幂等 upsert FTS 与 map。
- 实现受控重建：清空 FTS 与 map 后从 eligible completed TextPart 重建。
- 实现 keyset 分页谓词与稳定排序。
- 实现 cursor 绑定 workspace/session/contextRoot，普通变化不失效、`contextRoot` 变化失效。
- 实现当前 Session 归档祖先范围过滤。
- FTS 不保存 `session_id`，避免按 Session 重复索引。
- 实现 Workspace 删除事务：先阻止新 Run/写回并终止活动 Run，按序清理 FTS、map、run_state、run、Session、ToolExecution、Part，将 Message 自引用置 NULL 后批量删除 Message，再清理无引用附件与 Workspace。

### 完成标准

- archive_read/search 只返回指定 Session 的已归档高价值 TextPart。
- FTS 不索引 Reasoning/ToolCall/ToolExecution。
- 中文 trigram 查询可用。
- trigram 查询词少于 3 个字符时稳定拒绝。
- cursor 先做完整性与祖先校验再应用 keyset 谓词。
- map/rowid 对应关系、completed 幂等写入无重复命中测试通过。
- 受控重建后查询结果与主表一致。
- 第二页分页无重复、无遗漏，archive_read 旧到新、archive_search 新到旧。
- 普通 append/stream/tool 更新后 cursor 有效，`contextRoot` 变化后 cursor 失效。
- Workspace 删除后 FTS 与 map 清理完成。
- `foreign_keys=ON` 下 Workspace 删除事务一次性成功，多层 previous/replaces 链、多 Session 共享、head/contextRoot、Execution、附件全部清理，无孤儿。

## 阶段八：前端 Conversation View

### 任务

- 从扁平 DisplayItem 迁移到 Message View。
- ToolCall 卡片内联 ToolExecution 状态。
- 实现 revision 增量刷新。
- 实现 timelineReset。
- 大型 ToolExecution 详情按需加载。
- 删除 Clear UI。

### 完成标准

- 流式输出、工具执行、重试、压缩、回退展示正确。
- 回退/压缩/重试后不会保留旧时间线脏状态。
- 默认轮询不重复传输大型工具详情。

## 阶段九：清理与验收

### 任务

- 删除旧 ContextItem 写路径和旧归档模块。
- 删除 Clear 全部代码与测试。
- 更新 OpenAPI / internal contracts。
- 运行 Shared、API、Worker、Web、插件和根类型检查矩阵。
- 执行破坏性升级演练，并复核升级识别路径是唯一允许保留历史表名的位置。

### 完成标准

- 不存在旧模型写路径。
- 不存在隐藏兼容层。
- 旧 `agent.store.ts`、legacy internal contract、旧公开消息路由和旧运行态投影均已退出。
- 旧强耦合测试的删除理由、替代测试与业务不变量已记录在 `08-legacy-test-rebuild-checklist.md`。
- Shared、API、Worker、Web、插件构建/类型检查/测试及根类型检查通过；升级演练覆盖干净初始化、Agent-only 清理、v18→v19 保留升级、fail-closed 和文件系统边界。

## 开发任务拆分原则

- 先建立 Message/Part/ToolExecution 权威数据，再做查询投影。
- 先完成 Worker 写回语义，再做前端实时刷新。
- 先替换 Fork/回退/压缩核心事务，再删除旧模块。
- 每阶段必须保持可测试，不允许一次提交混合过多行为变化。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 共享 Message 与 Session 边界实现混乱 | 始终通过 Head/contextRoot/祖先链验证，不写全局归档状态 |
| 自动重试出现双 Head | 替代切换必须单事务 CAS |
| 工具崩溃后误重跑 | 严格执行先写 running，再执行工具 |
| FTS 与主表不一致 | completed 事务内写入，失败回滚 |
| 前端增量错乱 | revision/updatedRevision/timelineReset 三层机制 |
| 升级残留旧数据 | 明确清理脚本和验收检查 |
| 归档查询泄露共享消息 | FTS 只索引 eligible TextPart，查询必须做 Session 祖先链过滤 |
| artifact 覆盖冲突 | 路径基于 toolExecutionId，同 execution 幂等重写 |
