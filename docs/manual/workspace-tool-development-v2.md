# Workspace 工具开发手册 v2(Runtime + Store + Call + Indicator)

## 适用范围

- 本手册描述 Workspace 工具在 v2 架构下的接入方式
- 目标读者:
  - 新增工具(例如 Search/Tasks/Lint/Notes)
  - 为现有工具增加红点(Indicator)或跨工具跳转(call)
  - 将工具从 "view 内自管理状态" 迁移为 "runtime + store + view"

## 核心结论(先记住这几条)

- 工具由三部分组成:
  - runtime: 常驻后台逻辑,不依赖 view 是否挂载
  - store(组合式 API): 工具私有响应式状态,由 runtime 管理生命周期
  - view: 纯渲染层,绑定 store,尽量不承载轮询
- 工具栏红点是工具状态:
  - 工具自己计算,通过 `host.setToolDot(toolId, boolean)` 上报
  - Workspace 只负责渲染红点,不理解业务含义
- 跨工具操作只用 `call`(event-only):
  - `call` 会触发 Workspace 的 "揭示策略"(显示/隐藏/取消最小化)
  - 本期不做发布订阅,也不做 call 的返回值
- `keepAlive` 只用于 view 性能优化:
  - 正确性由 runtime/store 保证,不要把正确性建立在 keepAlive 上

## Dock 与可见性

- DockArea:
  - `leftTop`
  - `leftBottom`
  - `rightTop`
- 同一 DockArea 同一时刻最多一个工具处于 active 状态
- 工具可见(visible)定义:
  - 工具是其当前所在 area 的 active tool
  - 且工具未被最小化

## 目录与入口

- Workspace 页面入口:
  - `apps/web/src/features/workspace/views/WorkspaceLayout.vue`
- 工具栏按钮与渲染:
  - `apps/web/src/features/workspace/components/WorkspaceDock.vue`
  - `apps/web/src/features/workspace/WorkspaceToolButton.vue`
- Host API 类型与注入:
  - `apps/web/src/features/workspace/host.ts`
- Runtime 类型:
  - `apps/web/src/features/workspace/runtime.ts`

## ToolDefinition(注册工具)

- 工具在 WorkspaceLayout 中注册,核心字段:
  - `toolId`: 工具唯一标识
  - `title/icon/view`: 工具栏展示与 view 渲染
  - `defaultArea`: 初始区域
  - `allowedAreas`: 允许移动的区域
  - `keepAlive`: 是否对 view 使用 KeepAlive
  - `createRuntime`: 创建 runtime 的工厂函数(可选,建议所有需要红点/后台能力的工具都提供)

## Host API(v2)

### useWorkspaceHost 的使用方式

- 在工具 view 内,推荐传入 `toolId` 获取 tool-scoped host:
  - `const host = useWorkspaceHost(props.toolId)`
- tool-scoped host 的 `call` 不需要传 `fromToolId`:
  - `host.call("files", { type: "...", payload: {...} })`
- 如不传 `toolId`,会返回 Workspace 全量 host(含内部 callFrom),一般不建议在工具内使用

### Call(event-only)

- 只用于 "用户意图的跨工具操作"
- 触发效果:
  - Workspace 会按规则揭示目标工具(可能切换可见工具,并取消最小化)
  - 然后把消息交给目标工具 runtime 的 `onCall`
- `call` 的参数形状:
  - `type: string`
  - `payload?: Record<string, unknown>`

### Indicator(工具栏红点)

- 工具通过 `host.setToolDot(toolId, boolean)` 上报红点
- 红点渲染由 Workspace 统一负责

### 仍然存在但不推荐跨工具使用的 API

- `openTool/minimizeTool/toggleMinimize`
  - 工具可以用于 "操作自己"(例如 Terminal 没有会话时最小化自己)
  - 不建议工具用它去控制其他工具的显示,跨工具跳转统一用 `call`

## Runtime 接口与生命周期

### ToolRuntimeContext(关键字段)

- `workspaceId/toolId`
- `host`:
  - `call(toToolId, call)`
  - `setToolDot(toolId, dot)`
- `getCurrentTarget()`: 当前 repo 的 target(可能为 null)
- `getVisible()`: 当前工具是否可见(按 Workspace 规则计算)
- `refreshView?()`: 请求刷新 view(等价于调用该工具在 view 中通过 `registerToolCommands` 注册的 `refresh`)
- `api?`: 由 Workspace 注入的 API 依赖(建议使用注入,避免 runtime 直接 import API)

### ToolRuntime(必须实现的方法)

- `start()`
  - runtime 启动时调用
  - 适合在此启动轮询,建立 watch,并做一次初始刷新
- `dispose()`
  - Workspace 页面销毁或 workspaceId 切换时调用
  - 适合清理定时器,stop effectScope,并重置红点
- `onRepoChange(nextTarget)`
  - 当前 repo 切换时调用,需要立即刷新工具状态与红点
  - 推荐在此重置 store 为 "每个 workspace + 当前 repo(dirName) 一份"
- `onVisibilityChange(visible)`
  - 可见性变化时调用
  - 推荐用于 "可见走重刷新,不可见走轻刷新"
- `onCall(envelope)`
  - 接收跨工具 call
  - 由工具自行解析 `type/payload`,并更新 store

## Store(组合式 API) 设计建议

- store 必须工具私有,不要被 Workspace 读取
- store 应当允许 view 未挂载时仍然更新:
  - 依赖注入不要用 `inject()`,改为由 runtime 创建时显式传入
- 处理异步竞态:
  - 建议在 store 内维护 `seq/token`,丢弃过期请求
  - dispose 后不要再写状态
- 推荐以 workspaceId 作为 store key:
  - 多 Workspace 页面并存时互不影响
  - 如工具语义强依赖 repo,可在 repo 切换时重建或 reset

## Workspace 的 call 揭示策略(行为定义)

- 允许 A call A(不做校验)
- call 到目标工具 B 时必须确保 B 取消最小化
- A 与 B 在同一 DockArea:
  - B 显示,A 隐藏
- A 与 B 不在同一 DockArea:
  - B 未显示: B 显示,A 不变
  - B 已显示: A/B 都不变

## 例子: code-review 的红点与轮询策略

- 需求:
  - code-review 工具即使从未打开也能更新红点
  - 工具可见时刷新面板数据(重刷新)
  - 工具不可见时只计算红点(轻刷新)
- 推荐实现:
  - runtime 内维护轮询定时器
  - `onVisibilityChange(true)` 后 tick 走 `refreshView()` + 轻接口补一次状态
  - `onVisibilityChange(false)` 后 tick 只走轻接口
  - 红点上报通过 `host.setToolDot("codeReview", dot)`

## 例子: file-explorer 的红点与 tab 状态一致

- 需求:
  - 工具栏红点与 tab 标题右侧的小点一致: 任意 tab 满足 `dirty && !saving` 即亮
  - 工具最小化后再打开,未保存编辑仍然存在,红点仍正确
- 推荐实现:
  - tabs/dirty/saving 放到 store 中,view 只渲染
  - runtime watch `hasDirtyNotSaving` 并 `setToolDot("files", ...)`
  - repo 切换时清空 tabs,并将红点置为 false

## keepAlive 使用建议

- keepAlive 仅作为 view 重建成本优化:
  - Monaco/xterm 等重组件建议开启
- 不要依赖 keepAlive 保证正确性:
  - 最小化可能导致 view 卸载,keepAlive 不一定保留实例
  - 正确性必须由 runtime/store 保证

## 最小自检清单

- 红点:
  - 工具从未打开时红点仍更新(如果需要后台能力)
  - 工具最小化后红点仍正确
- repo 切换:
  - 立即刷新红点与工具状态
  - 旧 repo 的异步结果不会覆盖新 repo 的状态
- call:
  - 触发目标工具揭示策略(含取消最小化)
  - 目标工具 runtime 正确消费 call 并更新 store

