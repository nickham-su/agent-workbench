# 代码审查清单

## 使用方式

本文用于 Pull Request 审查和最终验收。任何标记为“阻断”的问题未解决前，不应认为功能完成。

## 产品语义

- 阻断：用户首次成功保存合法标题后，Session 永久停止自动命名；标题是否变化不影响接管语义。
- 阻断：不存在恢复自动的 UI、API 或隐式逻辑。
- 阻断：用户可以再次手动修改已接管标题。
- 阻断：保存相同标题也发请求并完成接管。
- 阻断：manual 下首消息和 `todolist` 均不能覆盖。
- 阻断：manual 下 `todolist` Context 写回仍成功。
- 已持久化 primary/subtask 均支持。
- draft 不展示入口。
- Fork 新 Session 不继承锁。

## 数据库与迁移

- 阻断：`title_manually_set` 为内部、非空、默认 `0`。
- 阻断：数据库 `CHECK` 约束仅允许 `0/1`，不得静默退化为仅靠应用约束。
- 新建库 DDL 包含该列。
- 旧库 `ensureColumn()` 迁移存在且幂等。
- 历史数据默认 `0`，没有基于旧 title 猜测来源。
- 普通创建和 Fork 均得到 `0`。
- 未修改历史 title、时间戳或 lineage。
- 有新库和旧库测试证据。

## Store 与并发

- 阻断：自动标题 SQL 在同一 `UPDATE` 中包含 `title_manually_set = 0`。
- 阻断：不能使用先查标记再无条件更新。
- 阻断：手动 SQL 同时设置 title 与标记。
- 阻断：手动 SQL包含 `workspace_id` 条件。
- 阻断：手动 SQL不更新 `updated_at`。
- 自动 SQL 保持现有 `updated_at` 更新行为。
- 自动与手动函数命名和类型语义清晰，不可误用。
- 自动更新零行是正常结果，不抛错。
- 两次手动并发按最后实际提交者获胜，没有伪造乐观锁。
- SQL 参数化，不拼接标题。

## 自动标题路径

- 阻断：首消息 `head == null` 路径已改用条件更新。
- 阻断：todolist append completed 路径已改用条件更新。
- 阻断：todolist update-to-completed 路径已改用条件更新。
- 三条路径均有 manual 测试。
- 原有空白压缩、空值处理、50 截断结果不变。
- update unchanged 不重复更新标题。
- 自动跳过不影响 Run、append/update、artifact/fence 错误语义。
- 自动跳过不产生高频 warning/error。

## API 与应用层

- 路由为 `PUT /api/agent/sessions/:sessionId/title`。
- 请求仅允许 `workspaceId/title`。
- 阻断：客户端不能提交或清除 manual 标记。
- 请求使用共享 TypeBox Schema，原始 title 固定 `minLength: 1, maxLength: 1000`。
- 缺字段、类型错误、原始空字符串、原始超过 1000 在 Schema 阶段返回 400，不进入应用层。
- 未知字段固定由白名单返回 `400 AGENT_REQUEST_UNKNOWN_FIELD`。
- 结构合法后，应用层顺序固定为 Session 存在性、Workspace 归属、标题业务校验。
- 纯空白固定为 `400 AGENT_SESSION_TITLE_EMPTY`。
- 规范化后超过 50 固定为 `400 AGENT_SESSION_TITLE_TOO_LONG`。
- 规范化后含禁止控制字符固定为 `400 AGENT_SESSION_TITLE_INVALID_CHARACTERS`。
- Session 不存在为 404。
- Workspace 不匹配为 400，且无数据泄露。
- primary/subtask 不分叉拒绝。
- 不要求 Session idle。
- 成功返回完整现有 `AgentSessionRecord`。
- 响应不暴露内部标记。
- 路由只解包并调用 Service，不直连 Store。
- Service/Composition 能力链完整，未建立旁路。
- OpenAPI 文档包含接口。

## 标题规范化

- 使用 `/\s+/g` 压缩并 `trim()`。
- 规范化后 1-50 个 JavaScript UTF-16 code unit。
- 输入框未设置任何 DOM `maxlength`，历史超长标题可完整回填。
- 原始 1000 上限由显式前端校验和 Schema 执行。
- 请求提交规范化后的标题。
- 手动超长拒绝，不截断。
- 自动超长继续截断。
- 50/51 边界有测试。
- Emoji/grapheme 没有引入半成品重构。
- 前端校验与后端一致，后端保持权威。
- HTML 字符按文本渲染，不使用 `v-html`。

## 前端交互

- 阻断：按钮仅展示于真实 Session。
- 按钮位于标题后，视觉上不遮挡状态/关闭按钮。
- 同时使用 `@mousedown.stop.prevent` 与 `@click.stop.prevent`。
- 使用可聚焦真实按钮，显式设置本地化 `aria-label`；Tooltip 不替代可访问名称。
- Enter/Space 均可打开弹窗。
- 弹窗每次从当前 Session 回填。
- 历史标题完整回填，不截断、不自动规范化或替换控制字符。
- 历史标题不合法时显示对应错误并禁用保存，编辑合法后才能接管。
- 打开/取消弹窗和数据库迁移均不修改历史标题。
- 永久接管说明清楚，不暗示可恢复。
- 保存中阻止重复请求。
- 当前标题合法时，相同标题保存仍请求；不合法标题禁用保存，只有编辑合法后才能接管。
- 失败保留弹窗和输入。
- 成功按 ID 原位替换，不 sort、不 prepend。
- 当前 Tab、Tab 编号、Session 顺序不变。
- `AgentClientPane` 接收到更新后的 `session-title`。
- Workspace 切换清理弹窗和请求上下文。
- primary/subtask/draft 显示规则有测试或手工证据。

## 陈旧响应与同步

- 阻断：较早发起的列表响应不能覆盖成功手动 API record 的任何字段。
- revision 只在 mutation 成功后提升。
- mutation 成功后缓存完整 `AgentSessionRecord`。
- 保护按 Session 粒度，不阻止其他 Session 更新。
- 请求开始 revision 更早且远端仍含 Session 时，完整保留 API record，不混用旧列表字段。
- `title`、`headItemId`、`updatedAt` 均不得回退。
- 远端缺失记录时不复活 Session。
- 使用过临时保护后去重触发一次 R2；R2 在 mutation 后开始并完整采用服务端权威记录。
- R2 失败继续保留 API record，清理自己的 loading 并允许后续刷新重试。
- mutation 后开始的正常请求可以直接完整采用服务端值。
- 存在 `workspaceGeneration` 或等价代次和按请求 token 的 active 状态。
- Workspace 切换后新 generation 请求立即发出，不被旧 generation loading 阻止。
- 旧响应不污染新状态、不清理新请求 token、不恢复旧 retry baseline。
- 新请求失败会清理自己的 loading，后续可重试。
- `onBeforeUnmount` 设置 disposed 并递增 generation，清理弹窗目标、mutation 缓存和 retry baseline。
- 在途 refresh/title mutation 响应在卸载后不写状态。
- 旧 Promise `finally` 只清理自己的 token，不清理其他 token。
- 卸载后不调度 R2 或重试。
- 不误以为 `loadingSessions` 已解决全部竞争。
- 未无需求新增 WebSocket/SSE、全局缓存或复杂状态框架。

## `updatedAt` 与排序

- 阻断：手动标题 Store SQL 本身不写数据库 `updated_at`。
- idle 且无其他业务写入时，API 返回 `updatedAt` 不变。
- 运行中允许其他 Context/Run 路径推进 `updatedAt`，不得要求最终值绝对不变。
- 自动标题成功仍使用原调用方时间更新。
- manual 自动跳过不由标题函数 touch。
- recent session 顺序不因手动改名变化。
- UI 不因本地更新改变 Tab 顺序。
- 未顺带重构全局 Session 活跃时间语义。

## 安全与隐私

- Workspace 归属在应用层和 mutation SQL 双重约束。
- 未调用内部 Worker 写回接口。
- 未引入文件、Git、终端或凭证操作。
- 错误不返回其他 Workspace 标题。
- 日志不打印完整标题正文。
- 未知字段和内部标记写入被拒绝。
- 失败无部分写入。
- 控制字符规则和固定错误 code 有实现、i18n 和测试。

## 测试质量

- 契约测试存在。
- Shared 新契约测试由 `npm test -w packages/shared` 覆盖。
- API `test` 脚本已纳入新增 session-title、writeback 和相关测试。
- Web 新纯函数测试已加入其固定 `test` 文件清单。
- schema 新库/旧库/幂等迁移测试存在。
- Store auto/manual 与 `updatedAt` 测试存在。
- 应用层输入、归属、primary/subtask 测试存在。
- API 路由/OpenAPI 测试存在。
- lifecycle 首消息 manual 测试存在。
- todolist append manual 测试存在。
- todolist update manual 测试存在。
- Fork reset 测试存在。
- 相同标题保存并锁定的测试存在。
- 历史超过 50/1000、空白、控制字符标题的完整回填、禁提交、取消和编辑后接管测试存在。
- 三个标题业务错误 code 的 API 精确断言和前端 i18n 映射测试存在。
- 陈旧列表响应完整 record 保护测试存在，明确断言 `title/headItemId/updatedAt` 不回退。
- 临时保护后只触发一次 R2，且 mutation 后请求可完整采用服务端结果。
- Workspace generation 新请求不被旧 loading 阻塞、失败可重试的测试存在。
- 组件卸载使 refresh/title mutation 失效且旧 finally 不串扰 token 的测试存在。
- 运行中修改有自动化或可复现手工记录。
- 原有自动标题回归测试保持通过。

## 变更范围与可维护性

- 无无关格式化和大规模重构。
- 内部字段未扩散到不需要的契约。
- Worker 协议未变化。
- 自动/手动 Store 方法职责单一。
- 错误信息可诊断但不过量。
- 注释解释业务不变量，而不是重复代码。
- 新 helper 没有为了未来需求建立通用框架。
- 设计文档与实现差异已同步更新。

## 发布与回滚

- API 启动前执行 schema 初始化。
- 后端先于或与 Web 同时发布。
- 已验证旧数据库迁移。
- 已验证 `/api/docs` 和 `/api/openapi.json`。
- 回滚方案不会让旧自动 SQL覆盖已接管标题。
- 不自动删除数据库列。
- 已记录任何已知限制。

## 最终阻断项摘要

以下任一情况出现即拒绝验收：

- 手动标题仍可被首消息或任一 todolist 路径覆盖；
- manual 导致 todolist 写回失败；
- 手动标题 Store SQL 写入 `updated_at`，或前端因手动保存主动改变排序；
- Fork 继承 manual 锁；
- draft 暴露不可用设置入口；
- 跨 Workspace 可修改；
- 标题与 manual 标记不是原子写入；
- 自动判断使用先读后写而存在竞争窗口；
- 较早列表响应能回滚手动 API record 的任一字段，或实现采用 title 与旧字段拼接；
- 使用临时保护后未触发 R2 收敛；
- 组件卸载后在途响应仍写状态或清理其他 token；
- 存在未约定的恢复自动入口；
- 缺少 append 和 update 两条 todolist manual 测试之一；
- 旧库迁移未验证。

## 最终交付记录模板

开发完成后可在 PR 或实施记录中填写：

```text
实现范围：
- ...

关键决策偏差：
- 无 / ...

数据库迁移验证：
- ...

自动化测试：
- ...

类型检查与构建：
- ...

手工验收：
- primary：...
- subtask：...
- draft：...
- Fork：...
- 运行中修改：...
- 陈旧响应：...

已知限制：
- Unicode 长度按 JS string.length
- 无跨页面实时推送
- 无恢复自动命名
- ...
```
