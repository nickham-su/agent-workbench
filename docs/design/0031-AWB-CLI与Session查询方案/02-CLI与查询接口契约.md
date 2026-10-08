# CLI 与查询接口契约

[返回导航](00-文档导航.md)｜[鉴权与缓存](03-鉴权续签与凭证缓存.md)

## 命令树

本方案建议固定：

```text
awb --help
awb --version
awb login --help
awb login --url <origin> [--token-stdin]
awb session --help
awb session list --help
awb session list --workspace <ID> --updated-within <duration> [--kind <kind>] [--status <status>]
```

- 顶层帮助仅列命令分组与简述；详细参数在叶子帮助披露。
- `--help/--version` 不访问网络、不读取或创建凭证缓存。
- 裸 `awb`、裸 `awb session` 展示相应帮助并返回 0；裸 `awb login/session list` 因缺少必填参数返回 2。
- 未知命令、未知参数、多余位置参数、重复单值选项均返回 2。重复检测不能依靠 commander 的“最后一个值覆盖”行为。
- 不提供 `--json/--all/--limit/--cursor/--since/--until/--updated-after/--updated-before`。
- 只有 `login` 可以交互；普通查询遇到认证错误立即退出，不等待输入。

## 登录接口与初始化

- `--url` 是必填 origin，合法性与缓存规则详见鉴权文档。
- 先无 Cookie 调用 `GET /api/health`，读取 `authEnabled`。
- 关闭认证：不读取token、不检查TTY、不消费stdin、不调用登录接口；无TTY且无stdin选项也保存origin和空Cookie并成功。
- 开启认证：读取 token，调用 `POST /api/auth/login`，请求体 `{ token, remember: true }`。
- 输入 token 不进入命令参数、stdout、日志、缓存。登录成功后缓存 Cookie，不缓存 token。
- 仅health确认认证开启且需读取token时，非交互环境才必须提供 `--token-stdin`，否则返回2；不能在health前因无TTY拒绝login。普通命令不自动登录。
- `login` 不覆盖旧缓存，直到新连接/认证/响应验证及缓存原子替换全部成功。

## 查询参数

| CLI 参数 | 必填 | 值与默认 | API 参数 |
|---|---|---|---|
| `--workspace` | 是 | 非空 ID，不能只含空白；不修改有效 ID | `workspaceId` |
| `--updated-within` | 是 | 正整数时长，最多 90 天，无默认 | `updatedWithinSeconds` |
| `--kind` | 否 | `primary/subtask/all`，默认 `all` | `kind` |
| `--status` | 否 | `idle/running/all`，默认 `all` | `status` |

### 时长解析

本方案建议固定严格语法 `^[1-9][0-9]*(s|m|h|d)$`：

- `s=1` 秒、`m=60` 秒、`h=3600` 秒、`d=86400` 秒。
- 合法结果为安全整数且 `1 <= seconds <= 7,776,000`，即 90×24×60×60。
- 支持 `1s/30m/24h/7d/90d/2160h`。
- 拒绝空值、`0h/-1h/+1h/01h/1.5h/1h30m/3mo/24H`、单位缺失和前后空白。
- 先检查数值是否安全，再乘单位并检查上限；不得用 `parseInt` 接受部分字符串、溢出或默默向下取整。
- CLI 只提交整数秒，不提交自己计算的起止时间。服务端独立验证相同的有效秒范围。

## 新增 HTTP 接口

本方案建议固定独立接口：

```text
GET /api/agent/sessions/query
  ?workspaceId=<ID>
  &updatedWithinSeconds=86400
  &kind=all
  &status=all
```

### 请求校验

- 允许的 query key 仅上述四项。`workspaceId/updatedWithinSeconds` 必填；`kind/status` 缺省为 `all`。
- 原始 query 中重复 key、未知 key 必须 400。使用原始 URL 校验，不能让 Fastify 自动剥离字段后伪装为有效。
- `updatedWithinSeconds` 原始表示必须是无前导零的正十进制整数，拒绝浮点、科学记数、空值、布尔值、空白和不安全整数。
- `kind/status` 严格小写枚举，空值不是缺省值。
- 参数错误 400 `AGENT_SESSION_QUERY_INVALID`；未知 Workspace 404 `WORKSPACE_NOT_FOUND`；有效 Workspace 零匹配返回 200 空数组。
- 新路由使用 `attachValidation: true` 并将请求校验错误统一转为上述参数错误，避免框架先返回没有 code 的另一套400。原始URL检查仍必须执行。
- 普通公开 Cookie 鉴权规则不变；关闭鉴权可无 Cookie 请求。

### 查询边界

- 在一个普通 SQLite 只读事务中取得一次服务端 `nowMs`。
- `updatedFrom = nowMs - updatedWithinSeconds*1000`，`updatedTo = nowMs`。
- 条件为 `updatedFrom <= session.updatedAt <= updatedTo`，上下边界都包含。
- 当前时间/差值须为安全、可转换为日期的整数毫秒；不使用客户端时区或客户端 now。
- 未来时间戳大于本次 `updatedTo` 的记录不匹配。
- 相对时长是固定秒数，不是日历月，不受夏令时影响。
- 按 Workspace、时间、kind、status 条件返回全部匹配，不用标题、head 是否为空、标签可见性或消息计数追加过滤。
- 排序固定为 `updatedAt DESC, id COLLATE BINARY DESC`；排序稳定但不承诺跨多次调用的数据快照。

## 响应 DTO

本方案建议固定 `AgentSessionQueryResponse`：

```typescript
{
  workspaceId: string;
  updatedWithinSeconds: number;
  updatedFrom: number; // UTC epoch milliseconds
  updatedTo: number;   // UTC epoch milliseconds
  kind: "primary" | "subtask" | "all";
  status: "idle" | "running" | "all";
  total: number;
  items: Array<{
    id: string;
    title: string;
    kind: "primary" | "subtask";
    status: "idle" | "running";
    createdAt: number; // 本 Session 自身创建时间，UTC epoch milliseconds
    updatedAt: number; // UTC epoch milliseconds
    userMessageCount: number;
    completedAssistantMessageCount: number;
  }>;
}
```

- DTO 不包含 nextCursor、token、Run 数、工具数、activeRunId、lastRunStatus 或业务用途字段。
- `total === items.length`，不增加独立 COUNT SQL。
- 数量必须为非负安全整数，不接受 null、浮点或负数；零数据明确返回 0。
- title 允许空字符串，空标题不能导致会话遗漏。id 非空；不截断 ID。
- `createdAt` 必填，来自本 Session 的 `created_at`；Fork 返回自身创建时间，不继承来源时间。与 `updatedAt` 一样须为 Date 可表达的整数毫秒。
- 创建时间仅展示，不施加更新时间窗口，也不新增 `createdAt <= updatedAt` 等跨字段比较。筛选与排序仍仅使用原有更新时间规则。
- API 不输出正文、工具参数、结果内容或 Cookie。
- Response schema 应显式限定字段；API 错误使用现有 `{message, code?}` 形状。
- API 与 CLI 须同步升级；包含条目的新旧版本响应因字段缺失或多余可能被严格校验拒绝（CLI退出6），不提供兼容模式。

### 状态和计数语义

- `status` 来自 `session_run_state.status`，是当前 idle/running，不是最近 Run 是否成功。
- 原生 user 条件：`origin_session_id = session.id AND type='user' AND status='completed'`。
- 原生 assistant 条件：`origin_session_id = session.id AND type='assistant' AND status='completed'`。
- 两者统计本 Session 历史累计记录，不对消息施加更新时间窗口。
- compaction/system/runtime、streaming/failed/cancelled/superseded assistant 不计。
- completed assistant 可以含中间工具调用响应；所属 Run 最终失败或取消也不改变该响应计数。
- Fork 继承消息属于原 Session，不重复算给副本。压缩不删原文，不减少累计值；回滚后仍保留的 completed 原生记录继续计数。
- 缺失、非法 RunState 或不可安全表达的数据库数值返回 500 `AGENT_SESSION_QUERY_STATE_INVALID`，不能静默补 idle 或生成不完整成功结果。

## 统一文本输出

CLI 只有固定模板，不调用模型生成叙述，不维护第二套 JSON 模式。HTTP 本身继续使用 JSON。

```text
Workspace：workspace-example
筛选：最近 24h；类型 all；状态 all
更新时间范围：2026-01-01T00:00:00.000Z 至 2026-01-02T00:00:00.000Z（含两端）
匹配总数：1

Session ID：session-example
标题：示例会话
类型：primary
状态：idle
创建时间：2025-12-31T10:00:00.000Z
最近更新时间：2026-01-01T12:00:00.000Z
用户消息累计数：2
已完成助手消息累计数：8

查询结束：已输出 1 个 Session。
```

- 时间统一 ISO 8601 UTC `Z`，不依赖终端时区。
- 固定字段顺序，每 Session 一个多行块，块间空行；不使用彩色、进度动画或截断 ID/标题。
- 标题中的换行、制表和控制字符转为可见转义序列，不让标题破坏模板；空标题显示 `（空标题）`，但 API 原值不变。
- 零匹配仍输出筛选信息、实际时间范围、`匹配总数：0`，退出 0。
- 正常完整输出以 `查询结束：已输出 N 个 Session。` 结束，N与total一致；零匹配也有结束标记。标记只便于识别前缀截断，不提高外层工具硬上限。
- CLI校验响应筛选回显与本次请求一致、窗口宽度等于请求秒数、total等于items长度、ID不重复、item满足回显筛选及更新时间边界，并校验创建时间数值合法；创建时间不需落入窗口。异常返回6，不部分输出。
- 成功结果写 stdout。所有参数、认证、缓存、网络、API/格式错误写 stderr，stdout 不输出伪成功结果。
- API 结果、续签处理全部成功后才开始渲染 stdout；校验错误不输出部分列表。
- 现有 bash/artifact 对最终工具结果的限制仍有效，详见技术文档；CLI 不因此截断服务端查询。

## 稳定退出码与失败顺序

| 退出码 | 含义 | 典型原因 |
|---|---|---|
| 0 | 成功 | help/version、初始化成功、空或非空查询 |
| 2 | 命令使用错误 | 缺参数、非法时长、重复参数；认证开启且需读token时无TTY又未指定stdin |
| 3 | 本地配置读取错误 | 缺配置、坏 JSON/版本/字段、无读取权限 |
| 4 | 认证错误 | HTTP 401，要求重新 login |
| 5 | 网络错误 | 连接失败、30秒请求超时、传输中断 |
| 6 | API/响应错误 | 非401的非2xx、重定向、非JSON、无效DTO、缺失登录Cookie |
| 7 | 凭证持久化错误 | 登录或续签后的创建/写入/原子替换失败 |

- Node fetch 采用 `redirect: 'manual'`，任何 3xx 明确失败，不把凭证转发到其他地址。
- 每个 HTTP 请求总超时建议固定 30 秒；首版不自动重试、不增加超时参数。
- HTTP 非2xx已形成业务错误时，它是主错误；即使同时续签缓存失败，保持主退出码，stderr 补充缓存错误。成功响应缓存失败使用 7。
- 2xx先校验续签Cookie并持久化，再解析JSON/校验业务DTO。有效续签写失败时，即使业务DTO无效也退出7，不继续业务校验，不输出成功结果。
- 2xx的续签Cookie无效时退出6，优先诊断Cookie，缓存不变；只有续签处理成功后才检查DTO。保存成功再发现JSON/DTO无效时退出6，已更新Cookie不回滚。
- 无续签的2xx直接校验JSON/DTO，无效退出6。Cookie属性接受规则以鉴权文档为准，不实现通用Cookie jar。
- 登录输入取消返回 2，不保存任何新配置。
- 错误诊断包含稳定类别、HTTP状态及安全的服务端错误 code；不得回显请求体、token、Cookie、完整 Set-Cookie 或堆栈中的凭证。
