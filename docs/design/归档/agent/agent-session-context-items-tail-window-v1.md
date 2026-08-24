# Agent 会话消息加载优化: Tail Window + 向上分页

Status: draft

## 背景

- 前端 AI Agent 会话页面当前在首次进入某个 session 时会全量拉取历史消息.
  - 触发条件: `items.length === 0`.
  - 代码位置: `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` 的 `refreshAll(...)`.
- 后端 `GET /api/agent/sessions/:sessionId/context-items` 当前在 `afterId` 为空时会返回 transcript 全量.
  - transcript 通过 head -> prevId 链回溯.
  - 长会话会带来:
    - 后端链式回溯开销大
    - 网络 payload 大
    - 前端内存与响应式计算成本高(即使有虚拟列表,items 数组仍然常驻)

## 目标

- 不改变产品逻辑: 会话内容仍包含 archived items,与现状一致.
- 首次进入会话时只加载最近 N 条消息(N=100).
- 用户滚动到顶部时自动加载更早一页(每页 100).
- 当没有更多历史时给出提示.
- 保留现有增量刷新能力(afterId),用于轮询与新消息追更.

## 非目标

- 不改变 DB schema 或 agent_context_item 结构.
- 不引入归档工具用于前端展示(归档工具仍为模型侧能力).
- 不做消息内容精简/压缩(仅优化加载方式与接口性能).

## 关键决策

- 加载模型: Tail window(最近窗口) + 向上分页.
- 初始窗口大小: N = 100.
- 向上分页: 滚到顶自动触发.
- 无更多历史: 前端提示“已到最早”.

## 当前实现概览

### 前端

- API 调用封装: `apps/web/src/shared/api/api.ts:getAgentContextItems(sessionId, afterId?)`.
- 会话面板刷新逻辑: `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:refreshAll(...)`.
  - 首次/强制: 全量 `getAgentContextItems(sessionId)`.
  - 常规: `afterId=lastId` 增量拉取.
  - 发现 head 回退/链断/新 boundary marker 时 fallback 到全量.

### 后端

- 路由: `GET /api/agent/sessions/:sessionId/context-items`.
- Service: `apps/api/src/modules/agent/agent.service.ts:getContextItems(sessionId, afterId?)`.
- Store: transcript 通过 `listSessionItems(... includeArchived=true)` 从 head 反向回溯到最早.

## 问题与风险

- 首次全量在长会话下不可扩展.
- 现有 `afterId` 的实现如果以“先全量回溯再 filter”为主,即使前端传 afterId 也无法从根本减少后端工作.

## 方案设计

### 新的加载语义

- 首次进入会话:
  - 只加载 transcript 的尾部窗口(最近 100 条).
- 向下刷新(新消息):
  - 使用 `afterId=lastId` 增量拉取.
- 向上加载(更早历史):
  - 使用 `beforeId=oldestId&limit=100` 拉取更早一页.

### API 设计(兼容扩展)

扩展现有接口 `GET /api/agent/sessions/:sessionId/context-items` 的 querystring:

- `afterId?: number`(保持现状)
- `tailLimit?: number`
  - 语义: 从 head 向前取最近 tailLimit 条(包含 archived)
  - 用途: 首次加载/重置窗口
- `beforeId?: number`
- `limit?: number`
  - 语义: 从 beforeId 对应 item 的前驱开始,向更早方向取 limit 条
  - 用途: 向上分页

返回体保持原 shape(兼容前端既有处理):

- `sessionId`
- `headItemId`
- `appliedItemId`
- `items: AgentContextItemRecord[]`

建议新增可选字段(便于前端展示“已到最早”):

- `hasMoreBefore?: boolean`
  - 当 `beforeId/limit` 查询时指示是否还有更早历史.
  - 或返回 `nextBeforeId?: number | null`(等价).

### 后端实现要点(性能)

必须避免“全量回溯再截断”的实现方式.

建议使用 SQLite 递归 CTE 一次性取固定步数:

- tailLimit:
  - 从 headItemId 开始,沿 prev_id 递归走 tailLimit 步
- beforeId/limit:
  - 从 beforeId 的 prev_id 开始,递归走 limit 步
- afterId:
  - 可从 head 向前递归,当 id <= afterId 时停止,返回倒序结果

补充:

- 对 items 仍需按 id 升序输出,以保持前端现有逻辑.
- includeArchived=true,与 transcript 语义一致.

### 前端实现要点

在 `AgentClientPane` 的 `refreshAll(...)` 中:

- 首次加载/窗口重置:
  - 从 `getAgentContextItems(sessionId)` 改为 `getAgentContextItems(sessionId, { tailLimit: 100 })`.
- fallback 策略调整:
  - 现有遇到 headMovedBackward/chainBroken/boundaryMarker 时会 full refresh.
  - 新方案中将 full refresh 的含义改为“重置 tail window”,即再拉一次 tailLimit=100.
- 向上分页:
  - 监听滚动容器 scrollTop.
  - 当接近顶部(阈值例如 80px)且未在加载时触发 `beforeId=oldestId&limit=100`.
  - 将返回 items prepend.
  - 需要做滚动位置补偿(记录 prepend 前后首屏锚点的 offset,避免视图跳动).
- 无更多历史提示:
  - 当后端返回 `hasMoreBefore=false` 或返回 0 条 items,将 `reachedTop=true`.
  - UI 在顶部显示轻提示: “已到最早”.

### 并发与竞态

- 向上分页必须有 inFlight 锁,避免同一时刻多次触发.
- sessionId 切换时应取消或丢弃旧请求结果(使用递增 seq 或 AbortController).

## 验证路径(建议)

- 新会话短消息:
  - 首次加载能看到完整内容(少于 100 条时应返回全部)
- 长会话:
  - 首次进入只加载最近 100 条
  - 滚到顶自动加载上一页,直到提示“已到最早”
- 运行态刷新:
  - afterId 增量仍能追新
  - 遇到 clear/compaction 等 boundary marker 时窗口可正确重置
