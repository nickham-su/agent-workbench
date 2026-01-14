# Workspace 工具开发手册（Dock 架构）

## 背景与目标

- Workspace 页面采用 Dock 架构：左右工具栏 + Center 三分区（左上/右上/下方）
- 工具以“注册”的方式接入页面
- 本手册面向：
  - 新增工具（例如文件浏览/预览、搜索、任务列表等）
  - 为现有工具补充 Header 按钮、最小化、工具间跳转/传参能力

## 核心概念

- 区域（DockArea）
  - `leftTop`：左上
  - `leftBottom`：下方
  - `rightTop`：右上
- 工具状态（页面统一管理）
  - 每个区域同一时刻最多一个“激活工具”
  - “激活且可见”才会渲染工具视图、显示 Header 工具按钮
  - 点击已激活工具的 icon：切换最小化（显示 ↔ 最小化）
  - 右键 icon：显示“移动到…”菜单（来自工具 `allowedAreas`）
- 工具保活（keepAlive）
  - 区域内可选保活：复杂布局/重渲染成本高的工具建议开启
  - 跨区域移动允许重建：不要把业务正确性建立在 keepAlive 上

## 代码入口总览

- Workspace Host API（工具侧注入使用）
  - `apps/web/src/workspace/host.ts`
- Workspace 页面与工具注册（当前实现位置）
  - `apps/web/src/layouts/WorkspaceLayout.vue`
- 工具栏按钮（icon + 右键移动）
  - `apps/web/src/workspace/WorkspaceToolButton.vue`
- 参考工具
  - 代码审查工具包装：`apps/web/src/workspace/tools/CodeReviewToolView.vue`
  - 终端工具包装：`apps/web/src/workspace/tools/TerminalToolView.vue`

## 工具开发流程（建议）

### 新建工具视图组件

- 建议放置路径
  - `apps/web/src/workspace/tools/<YourTool>ToolView.vue`
- 组件 props 约定
  - 至少包含 `workspaceId`
  - 建议包含 `toolId`（用于在工具内部调用最小化等 Host API）

示例（工具内部提供“最小化”按钮）

```vue
<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="flex items-center justify-between px-2 py-1 border-b border-[var(--border-color-secondary)]">
      <div class="text-xs font-semibold">我的工具</div>
      <a-button size="small" type="text" @click="host.minimizeTool(toolId)">最小化</a-button>
    </div>
    <div class="flex-1 min-h-0 overflow-auto p-2">
      <!-- 你的内容 -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceHost } from "../host";

defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost();
</script>
```

### 在 WorkspaceLayout 注册工具

- 当前工具注册表在 `apps/web/src/layouts/WorkspaceLayout.vue`
- 每个工具定义包含（最小集合）
  - `toolId`
  - `icon`（工具栏 icon）
  - `view`（工具视图组件）
  - `defaultArea`
  - `allowedAreas`
  - `keepAlive`（可选）
  - `headerActions`（可选）

示例（新增一个只允许放左上的工具）

```ts
{
  toolId: "myTool",
  title: () => t("workspace.tools.myTool"),
  icon: SomeOutlined,
  view: MyToolView,
  defaultArea: "leftTop",
  allowedAreas: ["leftTop"],
  keepAlive: true
}
```

注意

- `allowedAreas` 会影响右键菜单中的“移动到…”选项
- `openTool(toolId)` 不支持指定区域
  - 被打开的工具只会在“工具当前所在区域”激活并显示
  - 如果你需要改变区域，使用“移动工具”（右键菜单）或提供自己的 UI 入口后调用页面的移动逻辑（未来可以扩展 Host API）

### 工具 Header 按钮注册

- 当前实现只支持按钮（不支持自定义复杂组件）
- Header 同时展示三个区域“激活且可见”的工具按钮
  - 顺序固定：`leftTop` → `leftBottom` → `rightTop`

示例（给工具加一个按钮）

```ts
headerActions: () => [
  {
    id: "myTool:refresh",
    label: "刷新",
    disabled: false,
    loading: false,
    onClick: () => void doRefresh()
  }
]
```

建议

- `id` 推荐使用 `toolId:actionId` 风格，避免不同工具间冲突
- `disabled/loading` 应来自响应式状态（例如 `ref/computed`），保持按钮与工具状态同步

## Host API 使用指南

### 注入 API

- 工具视图组件内部使用：
  - `useWorkspaceHost()`

Host API 包含（以 `apps/web/src/workspace/host.ts` 为准）

- `openTool(toolId)`
- `minimizeTool(toolId)`
- `toggleMinimize(toolId)`
- `registerToolCommands(toolId, commands)`
- `emitToolEvent(targetToolId, event)`
- `drainToolEvents(toolId)`

### 注册命令（替代 ref 调用）

- 用途
  - 页面级操作（例如 checkout/pull）完成后，需要触发工具刷新
  - 避免页面直接持有子组件 ref 并调用其方法

示例（注册 refresh 命令）

```ts
const unregister = host.registerToolCommands(toolId, {
  refresh: () => refreshAll()
});

onBeforeUnmount(() => unregister());
```

参考实现

- `apps/web/src/workspace/tools/CodeReviewToolView.vue`

### 工具间事件（激活工具 + 传参）

- 目标
  - 工具 A 发起“跳转到工具 B 并携带参数”的意图
  - 工具 B 可能当前未显示、甚至被卸载（最小化默认卸载）
- 当前实现方式
  - 发送方：
    - `host.openTool("targetTool")`
    - `host.emitToolEvent("targetTool", { type, payload, sourceToolId })`
  - 接收方：
    - 在视图挂载后通过 `drainToolEvents(toolId)` 一次性取出并消费

示例（发送方）

```ts
host.openTool("terminal");
host.emitToolEvent("terminal", {
  type: "open",
  payload: { hint: "hello" },
  sourceToolId: toolId
});
```

示例（接收方）

```ts
import { onMounted } from "vue";
import { useWorkspaceHost } from "../host";

const host = useWorkspaceHost();

onMounted(() => {
  const events = host.drainToolEvents(toolId);
  for (const evt of events) {
    if (evt.type === "open") {
      // 处理 payload
    }
  }
});
```

建议

- `type` 建议用字符串常量，并在工具内部集中定义
- `payload` 目前是 `unknown`，工具侧自行做解析与容错
- `drainToolEvents` 是“一次性消费”，适合“打开/跳转”类意图
  - 如需“持续订阅”，后续可以扩展为事件流或回调注册

## i18n 与命名建议

- 工具标题建议放在：
  - `workspace.tools.*`
  - 参考：`apps/web/src/i18n/locales/zh-CN.ts`、`apps/web/src/i18n/locales/en-US.ts`

## 最小自检

- 需要先构建共享包（确保 `@agent-workbench/shared` 的 `dist` 类型存在）
  - `npm run build -w packages/shared`
- 再对前端做类型检查
  - `npm run typecheck -w apps/web`

注意

- 本项目依赖的原生模块（例如 `node-pty`）在某些环境需要 Python/编译工具链
- 若仅做前端 typecheck，可用 `npm ci --workspaces --include=dev --ignore-scripts` 跳过原生模块脚本安装

