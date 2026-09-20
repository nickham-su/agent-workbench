# AI Agent 会话 Tab 状态后端持久化与跨设备共享

## 文档目的

本设计定义 AI Agent 会话 Tab 的显示/关闭状态从浏览器本地存储迁移到后端 SQLite 的实现边界。它既是开发实施说明，也是代码审查与测试验收的依据。

适用对象：

- 开发者：按本文档的契约、状态机与任务拆分实施。
- 审查者：按 `05-review-and-acceptance.md` 检查关键决策没有被实现细节稀释。
- 测试者：按验收矩阵验证正常、失败、并发和生命周期场景。

## 阅读导航

- [01-overview-and-product.md](./01-overview-and-product.md)：背景、范围、术语、当前与目标行为、产品规则和关键决策。
- [02-technical-design.md](./02-technical-design.md)：数据库、共享契约、API、服务端流程、前端状态模型及初始化门控。
- [03-state-machine-and-edge-cases.md](./03-state-machine-and-edge-cases.md)：可靠单飞写入算法、失败处理、竞态、生命周期和安全边界。
- [04-implementation-plan.md](./04-implementation-plan.md)：开发任务、文件清单、实施顺序、准确测试命令与完成定义。
- [05-review-and-acceptance.md](./05-review-and-acceptance.md)：测试矩阵、可观测验收项和代码审查清单。
- [06-code-reference.md](./06-code-reference.md)：实施前调研得到的当前代码锚点与测试脚本索引。

## 一页摘要

- 状态以同一服务实例、同一 Workspace 为共享边界。
- 每个 Workspace 的 `AgentToolView` **新一轮完整初始化**只读取一次共享状态：页面刷新、组件重新挂载、切换到该 Workspace 时会触发；已成功初始化的 KeepAlive 工具仅最小化、切换工具后再次激活时不读取；初始化失败后再次激活可重试。
- 不提供实时推送、轮询或跨端即时同步；本需求不引入 SSE、WebSocket 或新的浏览器事件通道。
- 仅持久化已经存在于后端的 Agent Session 的显示偏好；草稿及设备偏好保持本地。
- 默认语义不变：主会话默认显示，子任务默认隐藏。
- 新表为 `workspace_session_tab_state`，按 `(workspace_id, session_id)` 保存偏离默认值的 `visible` 覆盖；`updated_at` 仅作数据库诊断字段，不向 API 暴露。
- 写接口以单 Session、幂等 `visible` 设值方式工作，避免整个数组覆盖造成跨端丢失更新。
- 客户端按 Session 使用对象化 `SessionWriteState` 的“单飞请求 + 最新意图合并”队列；面对超时/断网后服务端是否已提交的不确定性，有较新意图时仍必须补偿写入，不能以旧 `confirmed` 相等为由跳过。
- Session 列表和 Tab 状态读取完成前，模板只显示加载门控；读取失败显示错误与显式重试，不渲染普通 Tab、普通空态或新建按钮，也不得误建草稿。
- PUT 的 404 与其他最终 mutation 失败完全相同：只回滚对应 Session 并提示，不自动 GET、不启动完整初始化、不影响其他 Session 队列、草稿、activeKey 或初始化状态；下一次规定的新一轮完整初始化再由双 GET 收敛。

## 已确认且无需再次产品决策的事项

- 后端状态不迁移旧版 `localStorage` 中的 opened/closed 集合；上线后以后端记录及默认规则为准。
- 旧的 opened/closed 本地 key 停止读取与写入，但不主动删除。
- `activeKey`、Tab 编号、Dock 布局、草稿 Tab、草稿输入、每个 Session 暂选 Agent 等继续为本地或内存状态。
- 关闭 Tab 只改变展示，绝不取消运行、终止 Agent、删除 Session、删除消息或联动终端。
- 普通草稿没有后端 Session，关闭它绝不请求新 API；创建中的草稿被关闭时，真实 Session 创建成功后必须补写关闭状态。
- PUT 请求体未知字段通过 Workspace 路由局部的原始 body key 检查拒绝；不依赖 TypeBox `additionalProperties: false` 单独保证行为。

## 实施完成的定义

只有同时满足以下条件，本需求才可视为完成：

- 数据模型、API、前端行为和错误语义符合本文档，不以“暂时默认显示”代替读取失败处理。
- 快速关闭再打开、打开再关闭，以及“旧请求超时但服务端可能已提交”的场景中，客户端会按意图序号进行必要补偿写入；最终意图请求明确失败且无更新时回滚并提示，不进行无限自动重试。
- PUT 404 不会触发自动 GET、完整初始化或跨 Session 干扰；页面刷新、重挂载或其他规定的新一轮完整初始化才会收敛服务端事实。
- Workspace 切换、组件卸载、Workspace 删除和 Agent 域重建均不会造成越界写入、误建草稿或阻塞删除。
- 新增纯逻辑与组件测试确实被现有测试命令发现并执行。
- 通过本文档规定的构建、类型检查、自动测试和手工双设备验收。
