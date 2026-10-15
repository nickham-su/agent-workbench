# 实体、API 与缓存

## 模块边界

- Workspace 模块拥有配置存取、校验、加密和缓存；终端与内部路由通过窄服务读取覆盖快照。
- 共享包拥有 TypeBox 契约、校验常量和保留名称判断的唯一实现。不能在前端、API、Worker 维护不同黑名单。
- Worker 不获得主密钥、不直接读配置表，不建立二级缓存。
- 正式命名及文件接点见[代码引用](07-code-references.md#实际新增位置)。不扩展 `WorkspaceRecord`／`WorkspaceDetail`，不使用 settings 全局 JSON 保存值。

## 实体与约束

### 配置表（R-STORE）

已新增非 Agent 表 `workspace_environment_variables`：

| SQL 字段 | 类型与约束 | 含义 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | 服务端 `newId` 生成的条目 ID |
| `workspace_id` | TEXT NOT NULL，FK → `workspaces(id)`，ON DELETE CASCADE | 所属 Workspace |
| `name` | TEXT NOT NULL COLLATE BINARY | 大小写敏感的名称 |
| `value_enc` | TEXT NOT NULL | `secretBox` AES-256-GCM 加密字符串；不是 JSON 明文 |
| `remark` | TEXT NOT NULL DEFAULT '' | 可选备注，默认空串 |
| `enabled` | INTEGER NOT NULL，CHECK IN (0,1) | 启用状态 |
| `created_at` | INTEGER NOT NULL | 创建时间，Unix 毫秒 |
| `updated_at` | INTEGER NOT NULL | 最后成功修改时间，Unix 毫秒；不是并发版本号 |

- 唯一约束为 `(workspace_id, name)`，使用 BINARY，不做大小写折叠。
- 增加列表索引 `(workspace_id, created_at, id)`。记录及查询必须按 Workspace 分组。
- 基础表创建中幂等新增；不能修改 Agent schema 版本、触发 Agent 域重建或重写已有配置／历史。
- 当前 `initSchema` 在已有受支持数据库上仍执行 `createBaseSchema`，可沿用其非 Agent 增量方式。对当前不支持的数据库分类继续 fail-closed，不为本功能绕过分类。
- Workspace 删除成功后配置随 FK 清理；终端启动资源的 RESTRICT 边界另见[尝试实体](04-terminal-launch-and-cleanup.md#启动尝试实体)。

### 对外条目

```ts
// 设计结构；实现时由 TypeBox 导出 schema 与 Static 类型。
type WorkspaceEnvironmentVariable = {
  id: string;
  workspaceId: string;
  name: string;
  value: string;
  remark: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
```

仅环境专用接口返回 `value` 明文；不得返回 `value_enc`，不得把它加入 Workspace 列表、Agent 配置、提示词、Dock 布局或调试快照。

### 校验限额（R-VALUE）

| 项目 | 规则 | 边界 |
|---|---|---|
| 名称 | `^[A-Za-z_][A-Za-z0-9_]*$`，长度 1～128 | ASCII；恰好 128 允许；带空格直接拒绝 |
| 保留名称 | [权威保护集合](01-requirements-and-decisions.md#awb-与-git-保留字段r-control) | 大小写精确，不 trim，不禁止全部 Git 键 |
| 值 | 可无损UTF-8往返的合法字符串，拒绝NUL；最多16 KiB | 空串允许；恰好16,384字节允许；CR/LF保留 |
| 备注 | 合法Unicode字符串，拒绝NUL；`JS.length`最多160 | UTF-16 code units，与输入框maxlength相同；不trim |
| 条目数 | 每 Workspace 最多 128 条 | 包含停用；恰好 128 允许 |
| Workspace 总额度 | 全部条目环境编码大小最多 64 KiB | 包含停用；恰好 65,536 字节允许；不含备注 |

总额度计算：

```text
sum(UTF8ByteLength(name) + 1 + UTF8ByteLength(value) + 1)
```

两个 `1` 分别对应 `=` 和环境条目的终止字节。使用 UTF-8 字节长度，不能用 `value.length` 替代。备注的 UTF-16 限制需要显式语义校验；不能只依赖 JSON Schema `maxLength` 的字符计数而产生前后端分歧。

### 合法 Unicode 与字节计量

- value／remark必须可以无损UTF-8往返，拒绝孤立UTF-16高代理项和低代理项。合法配对emoji、组合字符保留，不normalize、不trim；NUL仍独立拒绝。
- 共享语义校验使用逐UTF-16代理对检查或跨前端与Node20/22兼容的无损编码检查；不能把Node Buffer实现直接用于浏览器共享规则，也不能只依赖TypeBox字符串schema。
- 先确认合法Unicode，再计算UTF-8字节长度；备注仍按JS.length计算UTF-16上限，不改成字符／字节计数。
- 创建、PATCH、前端预校验、持久数据读取、缓存填充和snapshot构建复用同一语义规则。输入孤立代理项固定400 `WORKSPACE_ENV_INVALID_INPUT`；读取非法配置固定500 `WORKSPACE_ENV_INVALID_CONFIG`，不当空配置、不替换成占位字符继续执行。
- 这是异常编码技术约束，不改变普通字符串原样传递。测试必须覆盖孤立high/low、合法emoji、组合字符、UTF-8上限和备注UTF-16上限。

### 写入与读取的共同约束

- 新增、更新、改名及启停均在事务内保持全部限额。启停不改变计数，但不能成为绕过已损坏配置校验的入口。
- 值、备注、名称均不自动 trim；unknown 字段、null、错误类型、空 PATCH 均拒绝。
- 前端可预校验，服务器为权威；同一实现处理额度及保留集合。
- 读取持久数据时也检验名称、类型、限额和受保护字段；损坏或非法配置明确失败，不静默略过。缓存填充前验证全部条目，包括停用条目，再提取已启用覆盖。
- `__proto__`、`constructor`、`toString` 等若符合名称规则，仍按普通名称处理。环境 map 必须用 Map、无原型对象或安全的 own-property 构造，不使用原型链判存在或不安全赋值，不因此新增未约定黑名单。
- 操作系统总环境限制还包含基础环境。即使通过本限额，spawn 仍可能报 E2BIG；返回固定错误，不泄漏环境，也不承诺本限额能完全规避系统限制。

### 加密与修复边界

- 复用 API 已加载的 `credentialMasterKey` 与 `encryptUtf8/decryptToUtf8`；空串同样加密。正常启动已具备密钥，不要求另建配置密钥。
- `name`、`remark`、状态和时间不加密；用户不应把秘密写入名称或备注。
- 数据库只保存 `value_enc`；加密失败不提交写入。解密失败不返回密文或原始异常。
- 保持现有密钥备份责任：数据库备份不等于密钥备份，丢失主密钥不能保证恢复值。
- DELETE 可在事务中先去除目标条目，再校验剩余数据；PATCH 明确提交的新 `value` 可替换该条目损坏的旧值，无须先解密被替换值。其余剩余损坏数据仍阻止操作，不能给异常数据库静默“修正”全部条目。
- 不提供绕过鉴权的修复接口。若损坏导致无法正常列出配置，应给固定错误并通过受控运维处理，不能打印密文或明文。

## API 契约

### 公共接口

沿用现有网页鉴权，使用共享 TypeBox request/response，拒绝额外属性；明文接口设置 `Cache-Control: no-store`，错误响应同样不缓存。

新增写路由必须在框架可能删除额外字段、转换类型之前执行严格的共享请求校验（可沿用现有 Workspace tab-state 的 `preValidation` 范式）。不能仅写 `additionalProperties: false` 后依赖 Fastify 默认 AJV 行为，把 unknown 字段静默去掉或把字符串布尔值转换后接受；不为本功能修改全局 AJV 行为。缺省值由通过严格校验后的服务规范化，校验失败只返回固定错误，不打印 TypeBox error 中的输入值。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/workspaces/:workspaceId/environment-variables` | 无 body | 200，`WorkspaceEnvironmentVariable[]`；空列表 `[]` |
| `POST /api/workspaces/:workspaceId/environment-variables` | `name`、`value` 必需；`remark` 默认 `''`；`enabled` 默认 `true` | 201，完整条目 |
| `PATCH /api/workspaces/:workspaceId/environment-variables/:variableId` | `name/value/remark/enabled` 的非空部分字段集合 | 200，完整更新后条目 |
| `PUT /api/workspaces/:workspaceId/environment-variables/:variableId/enabled` | 仅 `{ enabled: boolean }` | 200，完整更新后条目 |
| `DELETE /api/workspaces/:workspaceId/environment-variables/:variableId` | 无 body | 204，无响应实体 |

- 列表按 `createdAt ASC, id ASC` 稳定排序；改名、编辑不改变 `createdAt`。
- 请求不能提交 id、workspaceId、时间或密文。id、Workspace 身份由路由和服务端决定。
- 所有单条查询使用 `workspace_id = ? AND id = ?`，不先按全局 ID 读取后把其他 Workspace 内容暴露到错误中。
- PATCH 未提交字段保持不变；`value: ""`、`remark: ""`、`enabled: false` 不被真假值判断吞掉。
- 重复 DELETE 返回 404，由 UI 重新读取确认；不把不存在的对象当作本次真实删除成功。

### 内部只读接口

```text
GET /api/internal/workspaces/:workspaceId/environment
200 { workspaceId: string, env: Record<string, string> }
```

- 仅包含已启用名称和值；无备注、密文、凭据、系统环境或缓存内部状态。
- 全局内部鉴权必须生效，不因关闭网页登录而开放。
- 路由归属 Workspace 模块，复用应用配置服务，不扩大 Agent composition。
- 空配置返回 `env: {}`；不存在、删除中及故障按错误协议返回，绝不混同。
- 返回共享 schema 校验的 own-property map；设置 `no-store`。Worker 不将该响应写入工具结果、提示词或日志。
- Worker apiClient 增加窄读取方法，使用现有 `controlRead`：内部 RPC 配置超时，有界最多一次重试，并遵守 AbortSignal；不是无限重试或缓存兜底。

## 错误协议

下表 code 为本功能错误规范，已有 `WORKSPACE_DELETING` 沿用。固定 message 仅描述类别，可附非敏感 field 名；不能附提交值、整 body、密文、env map、原始 spawn 参数或 stderr。

| 场景 | HTTP | code | 执行结果 |
|---|---|---|---|
| 类型、名称、NUL、空 PATCH、unknown 字段非法 | 400 | `WORKSPACE_ENV_INVALID_INPUT` | 不写入／不执行 |
| 显式受保护名称 | 400 | `WORKSPACE_ENV_RESERVED_NAME` | 不写入 |
| 单值、备注、数量或总额度超限 | 400 | `WORKSPACE_ENV_LIMIT_EXCEEDED` | 不写入 |
| Workspace 不存在 | 404 | `WORKSPACE_NOT_FOUND` | 不读为空、不执行 |
| 条目不存在或 Workspace 不匹配 | 404 | `WORKSPACE_ENV_VARIABLE_NOT_FOUND` | 不返回其他 Workspace 内容 |
| 同 Workspace 名称重名 | 409 | `WORKSPACE_ENV_NAME_CONFLICT` | 原数据保持 |
| Workspace 删除中 | 409 | `WORKSPACE_DELETING` | 拒绝读／写／新执行 |
| 持久数据非法，含非法Unicode配置 | 500 | `WORKSPACE_ENV_INVALID_CONFIG` | 不缓存、不执行 |
| 密文损坏或解密失败 | 500 | `WORKSPACE_ENV_DECRYPT_FAILED` | 不缓存、不执行 |
| 加密／持久化非可恢复内部错误 | 500 | `WORKSPACE_ENV_PERSIST_FAILED` | 不报告成功 |
| 数据库短暂不可用／忙、依赖不可用 | 503 | `WORKSPACE_ENV_UNAVAILABLE` | 不使用旧值兜底 |

- Fastify schema 验证错误必须转换为安全输入错误，避免框架原始校验结果回显输入值。
- 鉴权失败沿用 401；不得以配置空值避开鉴权。
- Worker RPC 超时、传输错误、响应校验失败，转换为固定的环境读取失败；不启动 bash，不附原始 response body。取消仍遵守现有取消语义，不包装成成功空配置。
- 终端启动／清理错误码见[终端协议](04-terminal-launch-and-cleanup.md#错误与诊断)。
- 写请求响应丢失不等于事务未提交。可诊断日志只含 workspaceId、variableId、阶段和固定 code，不记录明文响应。

## 事务与并发

### 按条目写入

写操作进入 Workspace lifecycle mutation gate；在同步 SQLite 事务中：

- 确认 Workspace 存在、持久化 deletion intent 不存在。
- 按 Workspace＋条目 ID 读取目标；应用仅提交字段。
- 校验最终条目集合、额度和名称唯一性；加密新值，执行对应条目 INSERT/UPDATE/DELETE。
- 提交成功后，在同一同步执行段失效缓存，再返回成功记录。

没有 `await` 放在 SQLite 事务内部，也不能在提交与失效之间异步让出事件循环。数据库唯一约束是最终重名防线；将约束错误转换为固定 409，不回显 SQL 参数。

### 并发结果

- 不同条目按条目更新，不因旧前端整表快照覆盖彼此。
- 同一条目本版采用最后成功提交生效，不增加 revision/CAS。PATCH 只修改提交字段；若编辑器提交同条目的多个字段，最后提交可覆盖先前对这些字段的修改。
- `updatedAt` 用于展示，不用于冲突检测；不得用毫秒相同误判未修改。
- 生命周期 gate 处理删除边界，不代替跨客户端版本检查。
- 一次有效写入返回成功前必须失效缓存；原值相同的成功操作也可统一失效，避免多分支漏掉失效。
- 事务回滚不发布部分结果、不丢弃仍正确的缓存；若提交结果不确定，应保守失效而不是保留可能过期缓存，并明确失败，不宣称提交成功。

## 缓存与生命周期

### 缓存内容（R-CACHE）

- 绑定当前应用／数据库实例，不能跨测试 AppContext 共用模块级 Map。
- key 为 workspaceId，value 为只读的已启用 Workspace 覆盖；不含基础环境、备注、Git lease 或本次命令状态。
- 空 map 是有效缓存条目；判断命中用 `has`，不能以真假值或条目数量代替。
- 启动空缓存，容量 128 个 Workspace；按访问顺序简单 LRU 淘汰，无 TTL、无 Worker 二级缓存。
- 淘汰只是下一次读重新查库，不允许过期值替代新值。容量控制与每 Workspace 64 KiB 额度共同限制内存规模。

### 同步读取

```text
检查内存 deletion fence
  → 命中：刷新 LRU 次序，返回只读视图／副本（零 DB、零解密）
  → miss：同步查 Workspace 与配置 → 同步解密、校验全部数据
          → 构造已启用 map → 同步填入缓存 → 返回
```

- 命中不额外调用查库版 `getWorkspace`；否则不满足减少高频查库目标。
- miss 中途无 `await`，不引入 Promise 缓存、generation 或后台刷新。
- 404、409、查询／解密错误不填空缓存、不保留失败结果为负缓存。
- 调用方合并必须创建新对象，不能修改缓存；使用 safe own-property map 避免特殊名称原型行为。

### 写与删除失效

- 任意成功新增／编辑／启停／删除：事务提交 → 同步 `invalidate(workspaceId)` → 返回成功。
- Workspace 开始删除：先持久 deletion intent、建立内存 fence；此后缓存命中也拒读，不能让命中绕过删除状态。
- Workspace 最终删除：完成相关资源清理及删除事务 → 同步失效 → 释放 fence。
- 如果最终删除失败，保留 intent/fence，缓存不能被继续读。重启时路由注册前恢复 fence；缓存本身不持久化。
- 单进程同步 miss 与同步提交失效不会交错产生旧回填；如果以后改变为异步查询，必须重新设计竞态，不能照搬这一保证。
- 完整读快照并发语义见[读取快照时点](01-requirements-and-decisions.md#读取快照时点)。

## 前端请求状态

- 同一行操作和编辑提交请求中禁用重入；不将待提交状态标为已保存。
- 编辑使用部分PATCH，只提交用户实际改动字段；保留原始字符串与是否发生值输入的临时表单信息。浏览器textarea可能将显示中的CR/CRLF规范成LF，不能因此在只修改备注／名称时重写未编辑的原始value。API往返保留CR/LF；用户主动编辑值时保存实际编辑器提交的字符串，不由服务再做换行转换。
- 编辑没有任何字段变化时，点击保存直接关闭并提示“没有更改”，不发送空PATCH、不宣称发生服务端写入；不引入全局草稿机制。
- 成功后基于完整条目替换该行；失败保留编辑表单，启停恢复原状态。删除只在成功后移除。
- 请求超时、连接中断或响应无法确认时提示“保存结果未确认”，重新 GET 列表确认当前服务器状态。确认前不自动重复 POST，也不承诺取消请求撤销服务器事务。
- 重读失败保留明确的未确认状态和刷新入口，不假定服务器未写入；不得盲目用旧列表覆盖服务器。
- 发送前捕获 Workspace ID 与请求世代；组件销毁或 Workspace 切换后旧响应、错误和 toast 不更新新视图。可以取消传输，但仍需忽略旧响应。
- 正式 UI 不使用演示数据初始化真实列表，不把环境值放入 localStorage、浏览器布局缓存、搜索历史或提示词；页面离开释放相关表单引用。
- 日志和前端错误上报不得序列化请求 body、axios/fetch 原始错误对象中的 body 或明文响应。
