# Workspace Tool Runtime + Call + 红点（Indicator）方案

## 背景

- Workspace 页面采用 Dock 架构: 左工具栏(上/下) + 右工具栏 + Center 三分区渲染工具视图
- 目前工具 view 的挂载与否受 "激活" 与 "最小化" 控制: 最小化后 view 会卸载
- 目标是把 Workspace 工具栏 icon 的 "红点" 用起来,并且让红点与工具内部状态保持一致,即使工具 view 从未打开或已最小化

## 目标与非目标

### 目标

- 红点是 "工具状态",由工具自己计算并上报,Workspace 只负责存储与渲染
- 本期只实现 `call`(event-only) 作为 "用户意图的跨工具操作" 通道
- 允许工具从未打开时仍能:
  - code-review 红点正常刷新(依赖轮询)
  - file-explorer 红点正常反映 "是否存在未保存的编辑"
- repo 切换时立即刷新(工具状态与红点都应切到新的 repo 语义)
- `keepAlive` 可继续作为 view 级性能优化,不影响工具状态正确性

### 非目标(本期不做)

- 不做发布订阅(领域事件总线)
- 不做 `call` 的 request/response(只做 event,不等待返回)
- 不要求 Workspace 理解工具业务语义(例如 changes 列表结构,编辑器 tab 状态等)

## 核心原则

- 逻辑拆分: tool = runtime + store + view
- 正确性归属: runtime/store 负责正确性,view/keepAlive 只负责展示与性能
- 通信边界:
  - `call` 只用于 "用户意图的跨工具操作",且一定触发 Workspace 的揭示(reveal)策略
  - 工具间不直接调用对方的 open/minimize/toggleMinimize 等 UI 操作

## 术语与现状约束

### Dock 与可见性

- DockArea: `leftTop` | `leftBottom` | `rightTop`
- 每个 area 同一时刻最多一个 active toolId
- 工具可见(visible)定义:
  - 该 toolId 是其所在 area 的 active toolId
  - 且 `toolMinimized[toolId] === false`
- 现状实现参考:
  - `apps/web/src/features/workspace/components/WorkspaceDock.vue`
  - `apps/web/src/features/workspace/views/WorkspaceLayout.vue`

### 红点(Indicator)

- 本期只做 boolean 红点,不做计数
- Workspace 工具栏 icon 上展示红点,数据由 `toolDotById[toolId]` 驱动

## 总体架构

### ToolDefinition(工具注册)

- 工具注册仍由 Workspace 维护,并包含 UI 相关静态信息与 runtime 工厂
- 关键字段:
  - `toolId`: 工具唯一 ID(例如 `files`, `codeReview`, `terminal`)
  - `title/icon/view`: 用于工具栏与渲染
  - `defaultArea`: 初始区域
  - `allowedAreas`: 允许移动的区域集合
  - `keepAlive`: 是否对 view 使用 KeepAlive(仅性能)
  - `createRuntime`: 创建常驻 runtime 的工厂函数

### runtime(常驻后台逻辑)

- runtime 是普通对象,不依赖 view 是否挂载
- runtime 负责:
  - 轮询与刷新策略
  - repo 切换时重置/立即刷新
  - 可见性变化时选择轻/重刷新路径
  - 接收 `call` 并更新自身 store
  - 通过 host 上报红点

### store(组合式API,工具私有)

- store 维护工具的响应式状态,可在 view 未挂载时更新
- store 生命周期由 runtime 管理
- 本方案默认 store 以 "每个 workspace + 当前 repo(dirName) 一份" 方式存在:
  - repo 切换时重建或强重置 store
  - store 内需处理异步竞态(丢弃过期请求,dispose 后不再写状态)

### view(渲染层)

- view 只绑定 store 渲染
- 不承载轮询定时器
- 可继续使用 `keepAlive` 缓存组件实例(仅性能)

## Host API 与接口定义(推荐稿)

> 说明: 这里的 "接口定义" 用 TypeScript 伪码表达,用于约束边界;实际落地可按仓库现有类型与文件结构调整.

### ToolId 与 DockArea

```ts
export type ToolId = "files" | "codeReview" | "terminal" | (string & {});
export type DockArea = "leftTop" | "leftBottom" | "rightTop";
```

### Call 消息

- 工具发起时只传 `type/payload`
- Workspace 转交给目标 runtime 时补充 envelope 字段(便于调试与竞态处理)

```ts
export type ToolCall = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ToolCallEnvelope = ToolCall & {
  fromToolId: ToolId;
  toToolId: ToolId;
  workspaceId: string;
  // call 发起时的 target 快照,用于避免 repo 切换竞态
  targetAtCall: { kind: "workspaceRepo"; workspaceId: string; dirName: string } | null;
  ts: number; // Date.now()
};
```

### Host API(提供给 runtime/store/view)

```ts
export type WorkspaceHostApi = {
  // event-only,只用于 "用户意图的跨工具操作",并且一定触发揭示策略
  call: (toToolId: ToolId, call: ToolCall) => void;

  // 上报红点状态,Workspace 负责存储与渲染
  setToolDot: (toolId: ToolId, dot: boolean) => void;
};
```

### Runtime 接口

```ts
export type ToolRuntimeContext = {
  workspaceId: string;
  toolId: ToolId;
  host: WorkspaceHostApi;

  // 由 Workspace 提供的只读能力,便于 runtime 实现策略,同时避免 runtime 直接依赖 view
  getCurrentTarget: () => ToolCallEnvelope["targetAtCall"];
  getVisible: () => boolean; // Workspace 定义的可见性

  // API 依赖按需注入(推荐注入函数而非全局 import,便于测试与分层)
  api: {
    // 轻接口: 例如 git/status
    getGitStatus?: (params: { target: ToolCallEnvelope["targetAtCall"] }) => Promise<unknown>;
    // 重接口: 例如 listChanges 或工具自定义 refreshAll
    // 具体签名由工具自己决定
  };
};

export type ToolRuntime = {
  start: () => void;
  dispose: () => void;
  onRepoChange: (nextTarget: ToolCallEnvelope["targetAtCall"]) => void;
  onVisibilityChange: (visible: boolean) => void;
  onCall: (envelope: ToolCallEnvelope) => void;
};
```

### ToolDefinition 接口

```ts
export type ToolDefinition = {
  toolId: ToolId;
  title: () => string;
  icon: unknown;
  view: unknown; // Vue component

  defaultArea: DockArea;
  allowedAreas: DockArea[];
  keepAlive?: boolean;

  createRuntime: (ctx: ToolRuntimeContext) => ToolRuntime;
};
```

## Workspace 揭示策略(对 call 的 UI 管理)

### 前置条件

- Workspace 内部维护:
  - `toolArea[toolId] -> DockArea`
  - `activeToolIdByArea[DockArea] -> ToolId | null`
  - `toolMinimized[toolId] -> boolean`
- "显示(visible)" 判定见前文定义

### 规则(已确认)

- 允许 A call A(Workspace 不做校验)
- call 到目标工具 B 时必须确保 B unminimize
- 显示策略:
  - A 与 B 在同一个 area:
    - B 显示,A 隐藏
  - A 与 B 不在同一个 area:
    - 若 B 未显示: B 显示,A 不变
    - 若 B 已显示: A/B 都不变

### 推荐实现要点

- Workspace 收到 `host.call(toToolId, {type,payload})` 时:
  - 构造 `ToolCallEnvelope`(补齐 from/to/workspaceId/targetAtCall/ts)
  - 按上述规则更新 `activeToolIdByArea` 与 `toolMinimized[toToolId] = false`
  - 触发 `toRuntime.onCall(envelope)`

## 红点规则与实现要点

### 全局

- Workspace 维护 `toolDotById: Record<ToolId, boolean>`
- 由 runtime 通过 `host.setToolDot(toolId, dot)` 更新
- Workspace 只负责渲染,不做业务判断

### code-review 红点与刷新策略

- 语义: 当前 repo 存在变更则亮(是否包含 untracked 由工具内部决定,推荐与后端 git/status 的 dirty 口径一致)
- 刷新策略:
  - runtime 轮询(例如 5s)
  - repo 切换时立即刷新
  - 可见性决定轻/重路径:
    - 不可见: 轻刷新(例如 `git/status`),只更新红点
    - 可见: 重刷新(例如 `listChanges/refreshAll`),更新 store(面板状态)并顺便更新红点
- 竞态与正确性:
  - store 需做 requestSeq/token,保证旧请求不会覆盖新 repo 状态
  - dispose 后不再写状态

### file-explorer 红点与状态来源

- 语义: 工具栏红点与 tab 标题右侧的小点一致
  - 只要存在任意 tab 满足 `tab.dirty && !tab.saving`,就亮红点
  - 现有 tab 小点逻辑参考: `apps/web/src/features/workspace/tools/file-explorer/components/FileExplorerTabs.vue`
- 现状约束:
  - 目前 tabs/dirty/saving 状态在 `FileExplorerToolView.vue` 内部维护,view 卸载会丢状态
- 本方案要求:
  - 将 tabs/dirty/saving 等状态搬到 tools 私有 store
  - view 只绑定 store 渲染 tabs 与 editor
  - store 在以下时机重新计算红点并上报:
    - Monaco 内容变化导致 dirty 变化
    - 保存开始/结束导致 saving 变化

## keepAlive 与本方案的关系

- keepAlive 只影响 view 组件实例是否复用,不影响:
  - runtime 是否运行
  - store 是否更新
  - 红点是否正确
- 实践建议:
  - 把轮询/副作用放在 runtime,避免 keepAlive 导致 view 在缓存状态下运行额外逻辑
  - view 必要的副作用可用 `onActivated/onDeactivated` 控制,但不应替代 runtime

## 未来演进(本期不做)

- 发布订阅(领域事件)用于状态扩散,替代点对点后台通信
  - 例如 `workspace.fileChanged`,由 code-review runtime 订阅后触发轻/重刷新
- `call` 扩展为 request/response(需要超时与错误模型),用于真正的跨工具 RPC

