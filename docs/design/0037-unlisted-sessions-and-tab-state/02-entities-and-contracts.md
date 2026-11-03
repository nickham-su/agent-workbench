# 实体、接口与不变量

## 权威实体

### Session

| 字段 | 设计 |
| --- | --- |
| `agent_session.visibility` | `TEXT NOT NULL DEFAULT 'listed' CHECK (visibility IN ('listed','unlisted'))` |
| API `AgentSessionRecord.visibility` | 必填枚举；所有公开／内部 Session 投影同步携带 |
| 创建输入 `visibility` | 可选请求意图；最终值必须通过后端继承规则计算 |
| 更新 | 不提供更新字段、路由或隐式转化；现有标题／控制接口不得接受该字段 |

- `kind` 保持 `primary | subtask`，不是可见性。
- `visibility` 是会话身份预期的一部分；预分配 ID 重用必须比较。Tab `visible` 不是身份，不得要求它仍等于初始值。
- `DEFAULT 'listed'` 用于兼容及迁移，不是绕过隐藏继承的理由。所有生产创建入口必须显式计算最终值。
- 数据库列序是目标结构的一部分：visibility 必须追加在 v23 的 `updated_at` 列之后；新建 v24 DDL、`TARGET_AGENT_TABLE_COLUMNS.agent_session` 与 `ALTER TABLE ... ADD COLUMN` 的升级结果必须保持相同顺序，不得把新字段插在 kind 旁。现有 `hasExactColumns()` 按位置比较，不放宽为集合比较，也不为调整列序重建表。
- 目标校验必须覆盖 visibility 的 `TEXT`、`NOT NULL`、默认值 `'listed'` 和枚举 `CHECK`，不能仅检查已有行恰好为 listed／unlisted。新建与升级两种库都需通过列属性检查及缺省插入、null／非法枚举拒绝的受控语义探针。
- Agent Run／Message 不另存一份可变 visibility。导出事件从真实 Session 判断，不能以 Tab 开闭代替。

### Workspace Session Tab State

复用当前表，不新增第二张 Tab 表：

```text
workspace_session_tab_state
  workspace_id TEXT NOT NULL
  session_id   TEXT NOT NULL
  visible      INTEGER NOT NULL CHECK (visible IN (0,1))
  updated_at   INTEGER NOT NULL
  PRIMARY KEY (workspace_id, session_id)
```

- 当前仅有 workspace 外键；本期不引入复杂双重外键重建，依靠原子创建、受控删除、迁移验证维持与 Session 的一致性。
- 每个真实 Session 恰有一行同归属状态，不再称 override；旧函数／类型命名需改为实际状态语义，避免保留误导性的 delete-to-default 入口。
- 状态写入使用更新既有行，影响行数必须恰为一。不得 PUT 时 upsert 来悄悄修复缺失行。
- 创建默认值集中在一个窄函数；只有 Session 首次创建及旧数据一次迁移可以使用默认规则。
- `updated_at` 记录状态写入时间，迁移保留有效旧记录时间，无记录回填使用 Session `created_at`。它不是客户端并发版本，不新增乐观锁协议。

### Scheduled Execution Snapshot

不向任务配置或公开请求新增可见性字段，不新增任务配置列。仅扩展内部 JSON 快照：

```ts
type ExecutionSnapshot = {
  // 现有字段不变
  sessionVisibility?: "unlisted";
};
```

- 新声明执行固定写 `sessionVisibility: "unlisted"`，包括手动运行、定时运行及 skipped 声明。
- 老快照无字段时解释为旧策略 listed；迁移不重写历史 JSON。
- 快照是执行身份的兼容标记，不是用户开关。解析器拒绝 null、其他字符串、错误类型；不得把非法值当缺省。
- `executionFrom()` 目前只做 `JSON.parse` 强制类型，实施必须加入该字段和既有必要结构的运行时验证，抛出固定 `SCHEDULED_EXECUTION_SNAPSHOT_INVALID` 存储错误；不得泄露 JSON 原文。
- 非法快照不得创建会话、发送消息、释放仍可能活跃的执行互斥位；错误在现有调度错误边界诊断，不凭猜测重写执行结果。

## 接口变更

### Fork

现有 `POST /api/agent/sessions/fork` 增加可选字段：

```json
{
  "fromSessionId": "<source-session>",
  "fromMessageId": "<observed-head>",
  "visibility": "unlisted"
}
```

- `fromMessageId` 继续必填，已有 `title` API 字段保留；CLI 不暴露 title。
- 省略 visibility 等价于“未显式要求隐藏”，不是强制 listed；来源隐藏仍返回 unlisted。
- 显式 `listed` 也不能提升隐藏来源；返回值以继承后的真实值为准。非法枚举、null、额外字段返回既有 400 校验错误，无创建。
- 同步修改 TypeBox、公开与内部重导出、Fastify body 声明、路由字段白名单及应用端口，防止 schema 接受但白名单拒绝。
- 成功仍为 201 `AgentSessionRecord`，新增必填 visibility。既有合法请求不需修改。

### 常规发现

- `GET /api/agent/sessions?scope=continuable`：在既有过滤中增加 `visibility='listed'`，保留原排序、游标及 limit+1 算法。
- `POST /api/agent/sessions/query`：候选与消息计数共同使用 listed 条件；total 基于过滤后的集合。
- 内部 recent：在排序取限额前过滤 listed，kind=all 也不例外。
- 不新增 `includeUnlisted`、隐藏列表或管理员发现开关。

### 完整 Tab 快照与独立状态读取

继续使用既有端点：

- `GET /api/agent/sessions?workspaceId=<ID>&scope=tabs`
- `GET /api/workspaces/:workspaceId/agent-tab-state`

`WorkspaceAgentTabState` 新增必填、去重、稳定排序的 `openedSessionIds: string[]`，作为新前端唯一状态投影。tabs 响应的 `items` 为同事务中所有 `visible=1` 的真实 Session 元信息，包含显式打开的 unlisted；`items` 的 ID 集合必须与 `openedSessionIds` 相等，items 原排序不变。

为现有合法 API 消费者保留旧字段，仅由同一实际状态派生，不双写：

| 字段 | 唯一投影定义 |
| --- | --- |
| `openedSessionIds` | 同 Workspace 真实 Session 中 `visible=1` 的全部 ID，与 kind／visibility 无关 |
| `closedSessionIds` | 同 Workspace、listed primary 且 `visible=0` 的 ID；不包含关闭的 unlisted |
| `openedSubtaskSessionIds` | 同 Workspace、kind=subtask 且 `visible=1` 的 ID，可含已主动打开的 unlisted |

- 新前端不读取旧数组推断状态或构造假 Session；兼容字段不能成为第二权威。
- 独立状态接口只返回打开集合及上述兼容投影，**不返回所有 Session 的逐行 visible**，以免枚举关闭的隐藏会话。
- 完整快照是该请求读事务时刻的事实，不是实时订阅，也不是跨客户端线性化状态承诺。
- 非打开的 Session 元信息缺失不意味着被删除；完整集合仅能用于 Tab 成员协调，不能清理通用元信息缓存。

### Tab mutation

继续 `PUT /api/workspaces/:workspaceId/agent-tab-state/:sessionId`：

```json
{ "visible": true }
```

- 响应继续 `{workspaceId, sessionId, visible}`，以实际提交状态确认请求；不修改 Session visibility，不增加 kind 分支。
- 同值写入成功且幂等，不要求运行 idle。开闭不发送消息、不启动／取消 Run。
- 开闭只有身份匹配的成功响应才构成提交确认；本地乐观隐藏、请求发出或创建成功都不能证明已关闭。明确失败提示及 unknown 的后续读取协调仅在有效上下文执行；失效后不追加关闭／补偿，既有请求仍可能提交。详见前端草稿四类结果，不增加跨组件补偿或重复创建。
- Session 未在此 Workspace：沿用 `404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE`。
- 真实 Session 存在而对应状态缺失／归属异常：`500 AGENT_TAB_STATE_INVALID`，不自动补行、不改变 Session。
- GET Tab 快照／状态也必须检查该 Workspace 真实 Session 的状态完整性，缺失时明确 500，不能 inner join 静默漏项。相应 Fastify response schema 补齐 500。
- 既有 Workspace 删除围栏及 409 行为保持不变。

## 错误与诊断契约

| 情况 | 对外结果 | 副作用边界 |
| --- | --- | --- |
| 隐藏父复用 listed 子会话 | 409，新增 `SUBTASK_SESSION_VISIBILITY_MISMATCH` 业务码 | 无新增消息／Run／队列任务；不修改既有目标 |
| 预分配 Session visibility 与执行预期不符 | 沿用 409 `SESSION_ID_CONFLICT` | 不发送、不重置 Tab；任务沿用 session_id_conflict 映射 |
| Tab 不变量损坏 | 500 `AGENT_TAB_STATE_INVALID` | 局限展示接口，不阻断已有会话的非 Tab 读取与恢复 |
| 定时快照非法 | 固定存储错误，由既有边界返回／诊断 | 无 dispatch，不臆测终态，不打印快照 |
| Fork 选点／来源／历史错误 | 沿用现有 400／404／409 | 不新增回退、等待或重试 |
| SSE 找不到真实 Session 或查询失败 | 不导出该条事件 | 内部发布／终结不回滚；固定诊断，不包含正文／凭证 |

错误码需加入对应 shared 枚举／OpenAPI 响应，并在 Worker／CLI 现有传递链验证，不只写成服务端字符串。

## 事务和状态不变量

| 标识 | 不变量 |
| --- | --- |
| INV-CREATE | 新 Session、初始 RunState 和实际 TabState 同事务提交或全部回滚 |
| INV-VIS | visibility 创建后不变；隐藏父／来源不能派生 listed |
| INV-TAB | 每个真实 Session 恰一行同 Workspace TabState；visible 是持久化唯一权威 |
| INV-IDEMPOTENT | 重试不重置 visible；预分配身份匹配包含 visibility |
| INV-REUSE | 隐藏父复用 listed 在所有捷径与执行副作用前拒绝 |
| INV-DISCOVER | 列表先过滤后分页／计数；打开 Tab 不恢复常规发现 |
| INV-RUN | 展示开闭不改变执行状态；任务结果绑定原 runID |
| INV-SNAPSHOT | 迟到快照不覆盖请求采集后发生的本地意图或确认；未知缓存不是持久化 false |
| INV-CONFIRM | 关闭刷新保证以实际提交确认及无后续打开写入为前提；创建响应上下文失效时不迁移／不发新关闭意图，允许已存初始状态在后续显示 |
| INV-MIGRATE | 迁移保留历史、原开闭结果及 cleanup 标记，失败回到完整 v23 |

## 兼容与部署边界

- API 的合法旧 Fork 请求继续接受；新 Session 响应及 Tab 状态增加字段，现有字段不删除。
- 新 CLI／前端必须验证新 visibility／openedSessionIds；不永久以缺字段默认为 listed 或按 kind 回退。旧后端与新客户端混用不在支持范围，应明确契约错误。
- 旧前端按 kind 推断的算法无法完整表达新模型，部署时必须整体更新并刷新旧页面；保留字段不等于承诺旧页面支持 unlisted。
- 实际 schema 升级、启动和回退规则以[迁移方案](03-backend-and-migration.md)为准。
