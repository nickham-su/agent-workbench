# API、实体设计与 SQLite 查询

## 分层与改动边界

- public route 负责 query/path 校验、TypeBox 响应契约、统一 HTTP 错误映射。
- Agent application/read-side 负责 workspace/Session 归属、查询 scope 与 snapshot 编排；通过窄 store 方法调用，不把 SQL 放到 Vue 或路由。
- Tab 覆盖读取复用 workspaces store 的有效覆盖判定，不复制有差异的默认规则；Agent read-side 可组合该窄读取函数。禁止在同一事务中调用包含 `await` 的 service 来假定事务仍有效。
- DB store 负责参数绑定、元数据映射、读事务及 keyset SQL。
- 前端 API wrapper 使用判别式类型，提供单目标、tabs snapshot、continuable page 三个明确方法；不保留生产代码无 scope 的全量方法。

现有内部 `AgentService.getSession(sessionId)` 及runtime窄能力按ID工作，不能直接作为公开归属校验，也不应为本次公开GET改变其既有运行时契约。新增/复用明确带workspace的窄查询，在route前完成双条件校验；无需给内部运行时增加旧客户端兼容逻辑。

## 复用实体

### AgentSessionRecord

继续复用 `packages/shared/src/contracts/agent.ts` 的完整元数据：

| 字段 | 类型/语义 |
|---|---|
| id | 非空 string，会话 ID |
| workspaceId | 非空 string，所属工作区 |
| title | 非空 string，展示标题；历史纯空白值仍可能存在 |
| kind | `primary` / `subtask` |
| forkedFromSessionId | string / null，来源会话 |
| forkedFromMessageId | string / null，来源消息 |
| headMessageId | string / null，当前 head |
| contextRootMessageId | string / null，当前上下文根 |
| revision | 非负 integer，消息图 revision，不是元数据版本 |
| createdAt | number，创建时间 |
| updatedAt | number，更新时间，手动标题可不改变 |

不新增摘要实体，不暴露 `title_manually_set`，不增加 message count、run-state、模型设置或工具内容。

### WorkspaceAgentTabState

继续使用 `{workspaceId,closedSessionIds,openedSubtaskSessionIds}`。只包含归属正确、语义有效的覆盖，忽略孤儿、跨工作区和无意义覆盖；读请求不得顺便删除这些行。

### 新增响应类型

```ts
type AgentTabsSnapshotResponse = {
  scope: 'tabs';
  items: AgentSessionRecord[];
  tabState: WorkspaceAgentTabState;
};

type AgentContinuablePageResponse = {
  scope: 'continuable';
  items: AgentSessionRecord[];
  nextCursor: string | null;
};

type AgentSessionListResponse =
  | AgentTabsSnapshotResponse
  | AgentContinuablePageResponse;
```

TypeBox、生成/导出的共享类型、API wrapper、响应 schema 和测试同时变更。`scope=tabs` 响应没有 nextCursor；`scope=continuable` 响应没有 tabState。类型收窄后才访问各自字段。

### 本地控制实体不进入HTTP契约

MetadataReadToken/Watermark、VisibilityIntentReceipt/Outcome、TargetReadOutcome、confirmationEpoch、uncertainCommit和picker选择证明仅在Web局部使用，详见状态机；不加进AgentSessionRecord/TabState/PUT response，也不新增数据库字段。pane事件从裸session变为含本地发起token的对象；既有HTTP timeline response不变。

### 窄wrapper的时间与错误契约

- tabs/target/continuable每次实际GET显式 `timeout: 15000`；Tab可见性PUT同样15秒。阶段一临时初始化列表/独立Tab状态关键GET也有15秒上限。
- 不修改共享axios实例全局timeout，不给消息发送、stream、timeline等长请求加此上限。
- 当前toApiError只保留response的data.code，不保留Axios timeout code；窄wrapper在通用转换前识别ECONNABORTED/ETIMEDOUT，生成本地ApiError.code=`AGENT_METADATA_GET_TIMEOUT`或`AGENT_TAB_VISIBILITY_TIMEOUT`，loader映射为transportTimeout，其他错误沿用转换。此code为前端传输分类、不增加后端HTTP错误契约；不得根据message文本判断timeout。
- GET失败/timeout释放槽位并失效token；PUT timeout只是本次传输结束，不保证后端未提交，按原单飞队列处理不确定性。
- 30秒核实/确认UI deadline不改变HTTP状态，不随意删除真实queue/inFlight。一次选择最多2个实际GET，受保护结果不能伪装HTTP/业务成功；显式retry新建选择代次。
- 相应错误分类与订阅union分离；原onMutationError(sessionId,error:unknown)不接收UI status对象。参数与错误测试同时断言无全局长请求timeout变更。

## 单会话元数据 GET

```text
GET /api/agent/sessions/:sessionId?workspaceId=<workspaceId>
```

- workspaceId、sessionId 必须为非空字符串，使用现有 ID 字符串规则，不作 trim 后偷换目标。缺少 workspaceId 或格式非法返回 400。
- 成功 200，返回完整 `AgentSessionRecord`。
- workspace 不存在返回 404，code=`WORKSPACE_NOT_FOUND`；workspace 存在但目标不存在或不属于该 workspace，返回 404，code=`SESSION_NOT_FOUND`，不泄漏真实归属。
- 使用统一 Web 鉴权；配置 authToken 的未认证请求返回 401，未配置时遵循现有公开访问模式。不能使用 internal token 路径或绕过 auth hook。
- 只读请求不进入 Tab mutation gate、不写入可见性。工作区删除中的读取沿用现有只读生命周期：存在时允许读取，删除事务提交后返回相应 404；不引入新的写锁或清理动作。后续 Tab PUT 仍遵守原有 workspace 可写规则，可能因删除中返回 409。
- 单目标 response 的 ID/workspace 与请求不一致视为协议错误，不 upsert，不显示“已删除”。

SQL 骨架（列映射与已有 `getMessageSession` 复用）：

```sql
select <AgentSessionRecord columns>
from agent_session
where id = @sessionId and workspace_id = @workspaceId;
```

workspace 存在性检查和目标读取放在同一短读事务，避免删 workspace 的两次读取得到矛盾错误分类；不查消息、工具、模型、运行状态。

## 列表 GET 的 scope 契约

```text
GET /api/agent/sessions?workspaceId=<workspaceId>&scope=tabs
GET /api/agent/sessions?workspaceId=<workspaceId>&scope=continuable&limit=50&cursor=<opaque>
```

| 参数 | tabs | continuable |
|---|---|---|
| workspaceId | 必选非空 | 必选非空 |
| scope | 必选字面量 tabs | 必选字面量 continuable |
| limit | 不允许出现 | 缺省 50，integer 1..100 |
| cursor | 不允许出现 | 首屏不传，后续非空字符串 |
| 其他参数 | 拒绝 | 拒绝 |

缺少/未知 scope、tabs 携带分页参数、limit 为 0/101/小数/NaN/空串、cursor 空串/超长/非法均返回 400。重复关键 query 参数必须拒绝，不能任取第一个。不要依赖 Fastify 默认移除未知参数或数组强转；在 query parser/显式校验层保留并拒绝非法输入，并给出 API 测试。首屏未传 limit 与显式 50 等价。

不存在 workspace 返回 `WORKSPACE_NOT_FOUND`。其他 DB 错误通过统一错误处理返回 5xx，不伪装空数组。

阶段一仍维持旧列表 GET；以上 scope 契约在阶段二统一切换，不同时支持无 scope 的旧生产路径。

## tabs snapshot 的真实一致性读取

一次同步 `better-sqlite3` deferred read transaction 中执行：

- 检查 workspace 存在。
- 读取有效 Tab 覆盖，构造 tabState。
- 按有效可见性读取会话 records，全部返回，不加 LIMIT。
- 完成事务后返回 `{scope:'tabs',items,tabState}`。

事务首个实际 SELECT 建立一致性视图；函数中无 await，不跨 HTTP 请求。单独 GET Tab 状态仍可保留给现有必要消费者，但 Agent 初始化不再调用它，也不能宣称双 GET 是真实事务 snapshot。

SQL 骨架：

```sql
select <s.AgentSessionRecord columns>
from agent_session as s
where s.workspace_id = @workspaceId
  and (
    (s.kind = 'primary' and not exists (
      select 1 from workspace_session_tab_state as t
      where t.workspace_id = s.workspace_id
        and t.session_id = s.id and t.visible = 0
    ))
    or
    (s.kind = 'subtask' and exists (
      select 1 from workspace_session_tab_state as t
      where t.workspace_id = s.workspace_id
        and t.session_id = s.id and t.visible = 1
    ))
  )
order by s.updated_at desc, s.id desc;
```

无意义 `primary+visible=1` 不阻止默认可见；`subtask+visible=0` 不打开子任务。有效覆盖读取与此查询必须以同一 ID、workspace、kind 规则解释，且在同一事务中。

## continuable 查询与 trim 等价性

### 确定性 DB 函数

新增窄 helper `registerAgentQueryFunctions(db)`，注册：

```ts
db.function('agent_trim_title', { deterministic: true }, (value) => {
  return String(value ?? '').trim();
});
```

- 应用连接在 `openDb` 的 schema 初始化完成后、向服务暴露连接前注册；所有执行该候选 SQL 的独立测试连接也必须调用同一个 helper。
- 不能只在某条路由首次请求时注册，也不能只修改生产 openDb 而遗漏 direct `new Database` 的测试 fixture。
- helper 无业务写入、无 schema 迁移；连接重开需重新注册。
- 函数严格采用 JS trim，不调用手动标题的 `replace(/\s+/g,' ')`。SQLite 默认 trim 只处理有限字符，不能替代。
- 测试覆盖普通空格、制表/换行、NBSP、BOM、全角空格以及零宽空格（后者 JS trim 不移除）；确认同一字符串在 JS helper 和 SQL 返回完全一致。

### 先资格过滤后 LIMIT

```sql
select <AgentSessionRecord columns>
from agent_session
where workspace_id = @workspaceId
  and kind = 'primary'
  and head_message_id is not null
  and agent_trim_title(title) <> ''
  and agent_trim_title(title) <> '新会话'
  -- 首屏省略以下 cursor 条件
  and (
    updated_at < @cursorUpdatedAt
    or (updated_at = @cursorUpdatedAt and id < @cursorId)
  )
order by updated_at desc, id desc
limit @limitPlusOne;
```

- 执行参数 limit+1；只返回前 limit 条。
- 若存在额外一条，nextCursor 取“本次实际返回的最后一条”的 `(updatedAt,id)`；否则 null。
- exactly limit 且无额外条时，nextCursor 必须为 null；不让客户端多查一页来发现结束。
- 静态排序遵循 SQLite ID 的 BINARY 比较，不改 collation；cursor 条件和 ORDER BY 使用同一比较规则。
- 如果实现使用 JS 对返回页再排序，必须避免 localeCompare 与 SQLite BINARY 不同；推荐直接保留 SQL 页顺序。
- 禁止先从所有会话 LIMIT 后再筛资格，禁止按照本会话 origin 消息数或 `EXISTS(agent_message)` 替换 head 条件。

## 游标格式、校验与安全

游标是不透明 API 值，具体内部结构：

```ts
type ContinuableCursorV1 = {
  v: 1;
  workspaceId: string;
  scope: 'continuable';
  limit: number;
  updatedAt: number;
  id: string;
};
```

JSON UTF-8 之后使用无 padding base64url 编码。客户端只存储和回传，不解析。

- 编码字符串上限 8192 ASCII 字符；拒绝非 `[A-Za-z0-9_-]`、非规范编码、解码后非合法 UTF-8/JSON、数组、null、额外字段或缺字段。
- `v` 必须等于 1；scope 必须 continuable；workspaceId、limit 必须与当前请求精确相同。
- updatedAt 必须为非负 safe integer；id/workspaceId 必须为非空 string。生成游标同样校验这些边界；不截断已有 ID 或时间。
- 部署前核查历史 ID/workspace 长度与时间是否合法、编码长度是否超上限；若已有元数据不能合法生成游标，停止上线并提出数据策略，不静默丢弃、截断或重写记录。本次不假定用户已有数据天然符合新游标防御边界。
- 游标非法统一 400 code=`AGENT_SESSION_CURSOR_INVALID`，不暴露解码内容。服务器不能把数据库 SQL、cookie 或异常原文写入响应。
- 不签名是有意取舍：修改位置只会改变只读分页范围；安全必须依赖统一认证、请求 workspace 归属校验和 SQL `workspace_id=@workspaceId`，绝不依赖游标自称的 workspace。
- 所有条件参数绑定；游标字段不得拼接 SQL，scope 只能选择固定查询分支。
- 修改 limit 必须从首屏重启；不能沿用旧 cursor。

不提供浏览快照 token。并发更新期间的重排、漏项、重复遵循产品文档的活数据分页承诺。

## schema 与索引

- 当前已有 `agent_session(id PRIMARY KEY)` 和 `(workspace_id,updated_at DESC)`，Tab 覆盖有 `(workspace_id,session_id)` 主键。
- 本次默认无表迁移；函数注册不是持久索引。
- 若 EXPLAIN 显示页查询并列 ID 排序产生临时 B-tree，且代表性数据的排序代价达不到既定基线目标，可评估 `(workspace_id,updated_at DESC,id DESC)`。
- 必须同时报告静态页/深页、稀疏候选、全 primary、tabs 关联查询的 plan 和耗时；仅“返回更少字节”不是增加索引的证据。
- 增加 Agent 域索引前复核严格 schema 对索引对象的识别规则；做旧库启动与新库创建测试。不得靠修改 Agent schema version 引起清空数据。
