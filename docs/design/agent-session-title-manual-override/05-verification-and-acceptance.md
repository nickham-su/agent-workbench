# 测试与验收标准

## 验收原则

功能只有在以下各层同时通过时才算完成：

- 共享契约能拒绝结构非法请求；
- 数据库迁移对新库和旧库均正确；
- Store 原子保证 manual 锁；
- 应用层固定输入、归属和错误语义；
- 首消息与 `todolist` append/update 三条自动路径均受锁约束；
- Web 交互、排序和陈旧响应行为符合产品合同；
- 回归测试证明未改变既有自动标题格式与业务写回结果。

不得仅以“UI 可以改名”作为验收结论。

## 共享契约测试

为 `AgentUpdateSessionTitleRequestSchema` 覆盖：

| 用例 | 固定阶段与结果 |
|---|---|
| 合法 `workspaceId/title` | Schema 通过 |
| 缺失 `workspaceId` | Schema `400`，不进入应用层 |
| 缺失 `title` | Schema `400`，不进入应用层 |
| 原始 `title === ""` | Schema `400`，不进入应用层 |
| 非字符串 title | Schema `400`，不进入应用层 |
| 原始 title 长度 1000 | Schema 通过，应用层继续业务校验 |
| 原始 title 长度 1001 | Schema `400`，不进入应用层 |
| 未知字段 | `assertOnlyAllowedBodyKeys` 返回 `400 AGENT_REQUEST_UNKNOWN_FIELD`，不进入应用层 |
| 纯空白但原始长度 1-1000 | Schema 通过，应用层返回 `400 AGENT_SESSION_TITLE_EMPTY` |
| 大量空白且原始长度不超 1000、规范化后不超 50 | Schema 通过，应用层可成功 |

共享契约测试文件必须位于 `packages/shared/tests/*.test.ts`，确保被现有 `test` 脚本覆盖。验证命令：

```bash
npm run build -w packages/shared
npm test -w packages/shared
```

## 数据库与 Store 测试

### 新数据库

- `agent_session.title_manually_set` 存在；
- 默认值为 `0`；
- `not null` 生效；
- 非 `0/1` 值被 `check` 拒绝；
- 普通创建显式或默认得到 `0`。

### 旧数据库升级

构造不含该列的旧 schema，执行初始化后验证：

- 新列被增加；
- 所有历史 Session 值为 `0`；
- 原 title、kind、head、fork 信息和时间戳保持不变；
- 迁移可重复执行；
- 第二次启动不会报 duplicate column；
- 历史 Session 仍可被自动命名，直到手动设置。

### 自动更新 Store

覆盖：

- `title_manually_set = 0`：更新 title 和 `updated_at`，返回 true；
- `title_manually_set = 1`：title 与 `updated_at` 均不变，返回 false；
- Session 不存在：返回 false，不抛 SQL 异常；
- 并发顺序“manual 后 auto”：最终保持 manual；
- SQL 是单条条件更新，而非先查后写。

### 手动更新 Store

覆盖：

- `0 -> 1`：title 和标记原子更新；
- `1 -> 1`：可再次改 title；
- 手动 Store SQL 执行前后 `updated_at` 精确不变；
- Workspace 匹配成功；
- Workspace 不匹配不更新；
- Session 不存在不更新；
- 标题通过绑定参数写入，特殊引号不破坏 SQL。

## 应用层测试

建议扩展：

- `apps/api/src/modules/agent/session/session-interaction-application.test.ts`

必须覆盖：

- 合法 primary 更新成功并返回规范化标题；
- 合法 subtask 更新成功；
- 首尾/连续空白被规范化；
- 规范化后为空返回 `400 AGENT_SESSION_TITLE_EMPTY`；
- 规范化后 50 长度成功；
- 规范化后 51 长度返回 `400 AGENT_SESSION_TITLE_TOO_LONG`；
- 禁止的控制字符返回 `400 AGENT_SESSION_TITLE_INVALID_CHARACTERS`；
- 保存与当前标题相同的合法值时仍调用 Store，并幂等返回成功；
- Session 不存在返回 404；
- Workspace 不匹配返回 400，且 Store mutation 未调用；
- Store 更新后记录消失返回 404；
- 不读取或检查 Run 状态；
- 不因 subtask 普通消息只读规则拒绝标题更新。

校验顺序按阶段固定：

- Fastify/TypeBox 与路由白名单先处理结构错误，不进入应用层、不查询 Session；
- 结构合法后，应用层严格按“Session 存在性 → Workspace 归属 → 规范化标题业务校验”执行；
- 因此结构合法但规范化后 51 长度的请求，若 Session 不存在则返回 404；若 Session 存在但 Workspace 不匹配则返回 400 mismatch；只有前两项通过后才返回 `AGENT_SESSION_TITLE_TOO_LONG`；
- 原始空字符串或原始长度 1001 则始终在 Schema 阶段返回 400。

## API 路由测试

新增路由集成测试覆盖：

- `PUT /api/agent/sessions/:sessionId/title` 返回 200 和完整 `AgentSessionRecord`；
- OpenAPI 中存在路由和请求/响应 Schema；
- 未知 body 字段固定返回 `400 AGENT_REQUEST_UNKNOWN_FIELD`；
- 缺字段、类型错误、原始空字符串、原始超过 1000 固定由 Schema 返回 400，且应用层 spy 证明未调用；
- 缺少 `:sessionId` 路径段固定为路由未命中的 404；已命中路由的 params 由 TypeBox 校验；
- 400/404 响应符合 `ErrorResponseSchema`；
- Workspace 不匹配时不返回其他 Workspace 标题；
- 请求不接受 `title_manually_set`、`mode`、`updatedAt`；
- 响应不暴露内部 `titleManuallySet`。
- 保存与当前标题相同的合法值仍返回 200，并通过数据库断言 `title_manually_set = 1`；
- 三个标题业务错误 code 均符合 `ErrorResponseSchema` 并保持精确值。

## 自动标题回归测试

### 首消息

必须新增或补强生命周期集成测试：

- 新 Session `manual=0`，首消息仍设置标题；
- 空白压缩与 50 截断结果不变；
- 空 Session 先手动设置，首消息正常进入 Context，但标题不变；
- manual 跳过不导致 Run 激活失败；
- 自动标题 Store 调用在 manual 下不写 `updated_at`；生命周期事务中的其他既有写入按各自职责单独断言，不要求事务最终时间戳绝对不变。

关键基线：

- `apps/api/src/modules/agent/lifecycle/sqlite-run-lifecycle-persistence.ts:89-125`

### `todolist` append

覆盖：

- auto + completed + 非空 goal：更新标题；
- manual + completed + 非空 goal：append 成功、标题不变；
- manual 下自动更新返回 false 不冒泡为错误；
- 空白 goal 不更新；
- 超长 goal 仍自动截断；
- 非 completed 或非 todolist 不更新。

### `todolist` update-to-completed

覆盖：

- auto：更新 item 和标题；
- manual：更新 item 成功，标题不变；
- unchanged：不重复尝试标题更新；
- ownership/run fence 失败语义不变。

现有用例位置：

- `apps/api/src/modules/agent/writeback/context-writeback-application.test.ts:333-350`
- `apps/api/src/modules/agent/integration/agent-prompt-context.integration.test.ts:1179-1257`

必须明确增加 manual 分支，不能只复用原有 auto 用例。

## Fork 与 Session 类型测试

- manual 源 Session Fork 后，新 Session 标记为 `0`；
- auto 源 Session Fork 后，新 Session 标记为 `0`；
- Fork 初始标题仍按现有规则生成；
- Fork 后下一次符合条件的 `todolist` 能更新新 Session 标题；
- 更新源 Session 标题不影响 Fork 标题；
- primary/subtask 都能调用手动 API；
- subtask 的普通消息只读限制不变。

## `updatedAt` 与排序测试

### 后端

Store 级别必须直接查询数据库断言手动标题 SQL 不写 `updated_at`。

idle API 场景在请求期间不安排其他业务写入，断言：

```text
after.updatedAt === before.updatedAt
```

运行中场景不得断言最终 `updatedAt` 绝对不变。应通过 Store 单元测试证明标题 SQL 不写该列，并允许 Context/Run 等其他并发路径按既有规则推进它。

自动更新现有测试应补充：

```text
auto successful update -> updated_at 使用传入时间
manual skipped update -> 标题更新函数不触碰 updated_at
```

### 前端

准备多个 Session，手动修改中间一个：

- `serverSessions` 数组位置不变；
- `visibleSessions` Tab 编号/顺序不变；
- activeKey 不变；
- 不调用排序产生位置变化；
- 下一次正常列表刷新按服务端 `updatedAt` 仍保持预期顺序。

## Web 组件测试与手工验收

### 设置按钮

- primary 已持久化 Tab 显示；
- subtask 已持久化 Tab 显示；
- draft 不显示；
- 点击不切换 Tab；
- 点击不关闭 Tab；
- 显式本地化 `aria-label` 存在，Tooltip 不能作为唯一可访问名称；
- 按钮可聚焦，Enter/Space 均可打开弹窗。

### 弹窗

- 首次打开回填当前标题；
- 取消后不保存；
- 再次打开重新读取当前标题；
- 空白输入显示字段错误；
- 51 长度显示字段错误；
- 50 长度可保存；
- 输入框不设置 DOM `maxlength`；
- 字段计数与错误按规范化后 JavaScript `string.length`；
- 原始输入超过 1000 时显示 Schema 请求上限预检错误并禁止提交；
- 保存提交规范化后的值；
- `AGENT_SESSION_TITLE_EMPTY`、`AGENT_SESSION_TITLE_TOO_LONG`、`AGENT_SESSION_TITLE_INVALID_CHARACTERS` 分别显示对应 i18n 字段错误；
- 保存说明明确告知永久停止自动命名；
- 保存中按钮 disabled/loading；
- API 失败保留输入和弹窗；
- API 成功立即更新 Tab 与 `AgentClientPane` 标题；
- 再次手动修改成功。

### 既有不合法标题

通过数据库 fixture 创建标题分别为“规范化后 51 长度”“原始长度 1001”“含禁止控制字符”“规范化后为空”的历史 Session，验证：

- 迁移后数据库标题逐字节/字符串值不变，`title_manually_set = 0`；
- 弹窗完整回填原值，不截断、不自动规范化、不替换控制字符；
- DOM 没有 `maxlength` 导致程序化回填截断；
- 每类不合法值显示对应错误并禁用保存；原始超过 1000 显示请求上限预检错误；
- 禁止提交期间不调用 API、不设置 manual 标记；
- 取消后标题与标记不变；
- 编辑为合法值后可保存并接管；
- 直接调用 API 提交同样的历史非法值仍按统一 Schema/业务规则失败，不存在历史数据例外。

### 保存相同标题

- 当前标题符合新手动输入规则，输入只改变可压缩空白且规范化后与当前标题相同：仍发送 API；
- API 成功后 Session 进入手动接管；
- 后续自动标题不能更新，证明相同标题保存也完成锁定；
- 弹窗正常关闭且排序不变。

### 运行中修改

手工或组件集成验证：

- Run 运行中打开弹窗并保存；
- 标题立即变化；
- Run 继续执行；
- 后续 `todolist` 完成不覆盖；
- Run 回 idle 后既有 `refreshSessions()` 不回滚标题。

## 陈旧响应测试

用可控 Promise 模拟：

```text
R1 开始时 session = { title: "旧", headItemId: 10, updatedAt: 100 }
随后服务端业务推进，M1 手动 API 成功响应 = { title: "手动", headItemId: 12, updatedAt: 120 }
R1 晚到的旧快照 = { title: "旧", headItemId: 10, updatedAt: 100 }
```

断言：

- M1 成功后缓存完整 API response record 并提升该 Session mutation revision；
- R1 的请求开始 revision 更早且远端仍含该 Session时，本地完整保留 M1 record；
- `title === "手动"`、`headItemId === 12`、`updatedAt === 120`，不得采用 R1 的任何字段；
- R1 不含 Session 时不复活；
- M1 失败时 R1 可正常应用；
- R1 使用过临时保护后，自动且去重地发起一次 R2；
- R2 在 M1 后开始，可完整采用服务端权威 record，并清理对应临时保护；
- R2 失败时继续保留 M1 完整 record，不回退 R1，并在清理 loading 后允许后续刷新重试；
- 后续 mutation 后开始的成功请求收敛后，临时完整 record 缓存被清理；
- 本来就在 M1 后开始的正常请求可完整采用服务端结果，不额外触发保护/R2；
- 多个受保护 Session 只调度一次 R2，不形成刷新风暴；
- Session A 的 mutation 不阻止 Session B 列表更新；
- Workspace 切换后旧响应不写入新 Workspace。

另用可控 Promise 验证 Workspace 代次闭环：

```text
G1/W1 的 R1 未结束
切换到 W2，generation 变为 G2
G2/W2 的 R2 必须立即发出，不能被 R1 的 loading 状态阻止
R1 返回或失败，只能丢弃，不能清理 R2 loading 或恢复 G1 retry
R2 成功写入 W2；或 R2 失败后清理 G2 loading，允许重试 R3
```

必须断言：

- 旧 generation 不阻塞新 generation；
- 旧请求 `finally` 不清除新请求 active token；
- 旧 `session-title-sync-needed` retry baseline 不进入新 Workspace；
- 新请求失败后不存在永久 loading，下一次激活或显式刷新能发起重试；
- 组件卸载后 refresh 和 title mutation 响应均不写状态。

组件卸载使用独立可控 Promise 用例断言：

- `onBeforeUnmount` 设置 disposed 或等价状态并递增 generation；
- 弹窗关闭，编辑目标、输入和字段错误清空；
- 卸载前发出的 refresh 成功/失败响应均不更新 Session、message 或 retry 状态；
- 卸载前发出的 title mutation 若服务端成功，其响应不更新本地 Session 或 mutation 缓存；
- 旧 refresh/title Promise 的 `finally` 不清理其他 token；
- 不出现卸载后调度 R2 或其他重试。

## 安全测试

- SQL 注入样式标题仅作为普通文本保存；
- HTML/脚本字符串以文本展示，不执行；
- 跨 Workspace 请求不修改且不泄露标题；
- 未知内部字段不能写入；
- 非法请求不产生部分写入；
- 日志不包含完整标题正文；
- manual 下高频 todolist 不产生 warning 噪声。

## 完整验收清单

### 功能

- 已持久化 Session Tab 有设置入口；
- 弹窗回填当前标题；
- 合法标题保存并立即显示；
- 手动后永久禁止首消息和 todolist 自动覆盖；
- 可再次手动修改；
- primary/subtask 支持；
- draft 不支持；
- Fork 恢复自动命名。

### 数据与一致性

- 新旧数据库均有合法默认列；
- 标题与 manual 标记原子写入；
- 自动更新使用 SQL 条件；
- 手动标题 Store SQL 不写 `updated_at`；idle API 场景值不变，运行中允许其他业务路径推进；
- 自动现有 `updatedAt` 行为保留；
- 运行中竞争结果确定；
- 旧列表响应不回退手动 API record 的任何字段，并由 R2 收敛到权威记录；
- 组件卸载使所有在途响应失效且不串扰 token。

### 错误与边界

- 空、纯空白、超长、非字符串、未知字段均明确失败；
- 50/51 长度边界准确；
- Workspace 不匹配和 Session 不存在区分；
- 历史不合法标题不迁移改写、不回填截断，编辑合法后才能接管；
- Unicode 按 JS length；
- Emoji/grapheme 改进不混入；
- manual 下 todolist 写回仍成功。

### 回归

- 现有首消息自动标题结果不变；
- 现有 todolist goal 正常、超长、空白结果不变；
- Context append/update fence 行为不变；
- Session 创建、Fork、clear/revert/cancel/compact 行为不变；
- API 文档可用；
- 前后端类型检查通过。

## 标准测试脚本与验证命令

当前脚本基线：

- 根 `package.json` 只有 `build/typecheck`，没有根 `test`；
- `packages/shared` 的 `test` 覆盖 `tests/*.test.ts`；
- `apps/api` 的 `test` 当前只转发固定的 `test:session-model` 文件集合；
- `apps/web` 的 `test` 是固定文件清单，不会自动发现新测试。

因此开发任务必须同步调整测试脚本：

- API 新增 `test:session-title`，包含 schema、session title helper、session application、context writeback 和 prompt-context integration 相关文件；根 workspace 的 `apps/api` `test` 脚本必须串行执行现有 `test:session-model` 与新 `test:session-title`；
- Web 将新增的 `agentSessionTitle.test.ts`（至少覆盖标题规范化、mutation revision、workspaceGeneration 合并/重试纯函数）加入现有固定 `test` 文件清单；
- Shared 新测试放入 `packages/shared/tests/*.test.ts`，无需修改其 glob 脚本。

完成脚本调整后，在仓库根目录执行以下可复制命令：

```bash
npm run build -w packages/shared
npm test -w packages/shared
npm test -w apps/api
npm run test:integration -w apps/api
npm test -w apps/web
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run typecheck
npm run build
```

`npm test -w apps/api` 必须实际覆盖新增的 context writeback manual 用例，不能只依赖当前未包含该文件的旧固定列表。`npm test -w apps/web` 必须实际覆盖新增纯函数测试。若仓库仍无 Vue 组件挂载测试基础，按钮事件、回填和运行中交互允许保留手工验收，但陈旧响应、workspaceGeneration 和规范化逻辑必须抽成纯函数并由标准 Web test 命令覆盖。

## 验收证据要求

开发完成时应提供：

- 变更文件清单；
- 数据库迁移测试结果；
- 关键单元/集成测试名称与结果；
- 类型检查和构建结果；
- API 请求/响应示例；
- primary、subtask、draft、Fork 的验证记录；
- 运行中修改和 todolist 不覆盖的验证记录；
- 陈旧响应完整 record 保护、`title/headItemId/updatedAt` 不回退和 R2 收敛的测试证据；
- 已知限制，与本文“非目标”一致。
