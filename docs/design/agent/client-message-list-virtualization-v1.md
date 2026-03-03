# Agent Client 对话列表虚拟化(v1)

## 背景

- Agent 会话页面的对话列表可能很长,且包含重组件(例如 Monaco diff/code view)。在全量渲染模式下,滚动和更新会明显变卡。
- 当前实现还在 Tabs 上强制渲染所有 pane,导致打开工具时对多个会话同时发生“拉历史 + 渲染”的峰值开销。

## 目标

- 将 `AgentClientPane` 的对话列表改为虚拟列表(virtual list),支持可变高度 item,并能承载 Monaco diff 等重组件。
- 优化多会话 tabs 的初始加载与渲染峰值,避免同时拉取所有 session 的历史。
- 滚动行为约定
  - 首次进入某个 session: 强制滚动到底部。
  - 后续: 仅当用户处于底部附近时才自动跟随新消息,用户上翻阅读时不强制拉回。

## 非目标

- 不修改后端 API 语义与存储结构。
- 不在 v1 中实现“跨刷新/跨页面恢复滚动位置”的持久化(后续可选)。
- 不在 v1 中重构消息卡片内容(例如 apply_patch 卡片内部的折叠/懒加载),仅保证在虚拟列表中可用。

## 现状梳理(关键约束)

### 全量渲染列表

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:21` 使用一个 `overflow-auto` 容器,对 `displayItems` 直接 `v-for` 全量渲染。
- 列表更新时多处调用 `scrollToBottom()` 强制贴底,见 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:670` 以及 `refreshAll()` 内多处调用。

### 重组件与可变高度

- tool 消息中的 `apply_patch` 会渲染 `MonacoDiffViewer`,见 `apps/web/src/features/workspace/tools/agent/AgentApplyPatchCard.vue:9`。
- `MonacoDiffViewer` 支持 autoHeight,并监听 diff/content size change 更新高度,见 `apps/web/src/shared/components/MonacoDiffViewer.vue:313`。
- 这属于典型的“渲染后高度变化”的场景,虚拟列表必须支持动态测量与尺寸更新。

### 消息间距规则依赖 sibling CSS

- 当前消息间距通过 sibling selector 控制,见 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1113`。
- 虚拟列表通常使用绝对定位渲染可视行,不再保留完整 DOM 相邻关系,需要把间距逻辑改为“每行自带”且计入测量。

### Tabs 强制渲染导致峰值开销

- Agent 会话 tabs 使用 `:forceRender="true"`,见 `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:27`。
- `AgentClientPane` 在 watch([sessionId, workspaceId]) 时,只要 sessionId 存在就会执行 `refreshAll(true)`,见 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:1064`。
- 结合 forceRender,会导致多个 session pane 在初次进入工具页时一起 mount 并拉取全量历史。

## 方案概述

- 对话列表虚拟化
  - 采用 `@tanstack/vue-virtual` 实现可变高度虚拟列表。
  - 以现有 `scrollEl` 作为 scroll container,在其内部构建 spacer + virtual rows 结构。
  - 使用动态测量(measureElement)适配 Monaco autoHeight 导致的高度变化。
- Tabs 渲染策略优化
  - 移除 `a-tab-pane` 的 `forceRender`,回到默认惰性渲染。
  - 保持 `destroyInactiveTabPane` 默认 false,避免切换 tab 时卸载 pane(便于保留滚动位置)。

## 详细设计

### Tabs: 去掉 forceRender

- 改动点
  - 移除 `apps/web/src/features/workspace/tools/agent/AgentToolView.vue:27` 的 `:forceRender="true"`。
- 预期收益
  - 未激活的 session 不会 mount `AgentClientPane`,从而不会触发 `refreshAll(true)` 全量拉历史。
  - 降低初次进入 agent 工具页的 CPU/内存/网络峰值。
- 预期成本
  - 某个 session tab 第一次被点开时会发生懒加载(首次拉历史 + 首次渲染)。
  - 由于不销毁 inactive pane,后续切换回该 tab 不会重复冷启动。

### 虚拟列表: 渲染结构

- 依赖
  - `apps/web/package.json` 增加 `@tanstack/vue-virtual`。
- DOM 结构(推荐固定为 TanStack 标准形态)
  - scroll container: 复用现有 `scrollEl` 容器(`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:21`)。
  - spacer: `position: relative; height: virtualizer.getTotalSize()`。
  - virtual row: `position: absolute; top: 0; left: 0; width: 100%; transform: translateY(row.start)`。
- 列表输入
  - `count = displayItems.length`。
  - `getItemKey(index) = displayItems[index].id`。

### 可变高度: 测量与更新

- virtualizer 配置要点
  - `estimateSize`: 提供保守估值以减少首次抖动。
  - `measureElement`: 通过 DOM 实测高度并随 ResizeObserver 更新。
  - `overscan`: 取偏大(例如 8-20),减少滚动时 Monaco 频繁 mount/unmount 的抖动。
- 与 Monaco 的适配逻辑
  - `MonacoDiffViewer` 在 mounted 后仍可能多次改变高度,virtualizer 需要能持续接收高度变化并更新布局。
  - v1 依赖 ResizeObserver 的自然触发,必要时在 pane 激活时调用一次整体 `measure` 兜底。

### 消息间距: 从 CSS sibling 迁移到行内 padding

- 现有规则(来自 sibling CSS)
  - 默认相邻消息间距 12px。
  - 前一条是 tool 且后一条非 tool: 8px。
  - 前一条非 tool 且后一条是 tool: 6px。
  - tool + tool: 2px。
- 迁移策略
  - 为每个虚拟行计算一个 `gapTopPx`。
  - 将间距用 `padding-top: gapTopPx` 施加在行 wrapper 上。
  - 不使用 `margin-top`,避免间距不被测量导致虚拟布局错误。

### 滚动策略: 首次强制贴底 + 后续按需跟随

- 状态
  - `stickToBottom`: 用户是否处于底部附近(由 scroll 事件计算 distanceToBottom 阈值判断)。
  - `didForceScroll`: 当前 session 是否已经执行过“首次进入强制滚到底部”。
- 首次进入强制贴底
  - 触发点以 `props.active` 首次变为 true 为准,避免 pane 在未显示时测量/滚动不可靠。
- 后续跟随
  - 列表追加新消息或末尾消息高度变化时,仅当 `stickToBottom=true` 才执行跟随贴底。
  - 上翻阅读时 `stickToBottom=false`,更新不会抢占用户滚动位置。

### 与 refreshAll() 的集成

- 现状
  - `refreshAll()` 在多处无条件调用 `scrollToBottom()`,见 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:745`、`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:760`、`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:800`。
- 改造
  - 将 `scrollToBottom()` 替换为统一的 `followBottom({ force })` 行为:
    - `force=true`: 仅用于首次进入 session 的贴底。
    - `force=false`: 仅在 `stickToBottom=true` 时触发。
  - 使用 raf/nextTick 合并多次触发,避免一次 refresh 中多次滚动抖动。

### displayItems 计算复杂度优化(建议同批纳入)

- 风险
  - `displayItems` 内部存在 `some` 套循环判断 tool child,在大列表下可能趋向 O(n^2),见 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue:459`。
- 建议
  - 先构建 `prevId -> hasToolChild` 的索引(Set/Map),再单次遍历生成 `displayItems`。
  - 目标是把该部分降为 O(n),避免虚拟化后 computed 本身成为瓶颈。

## 验证与回归检查

- 行为
  - 首次进入某个 session tab: 强制滚到底。
  - 底部附近: 新消息到来或末尾高度变化时保持贴底。
  - 上翻阅读: 新消息到来不拉回。
- 视觉
  - 消息间距与现状一致(包含 tool/tool, tool/non-tool 的特殊间距)。
- 稳定性
  - apply_patch 消息中的 MonacoDiffViewer 正常显示,滚动中不出现长期空白或错位。
  - tab 切换到包含 Monaco 的消息时不出现布局异常,必要时通过激活时 measure 兜底。
- 性能
  - 大历史(例如 1k+ 消息)滚动与增量更新时 DOM 数量与渲染时间明显下降。
  - 初次进入 agent 工具页不再同时加载多个 session 历史(去掉 forceRender 后)。

## 风险与回滚策略

- 风险
  - 可变高度在极端情况下可能出现短暂跳动,需要通过 overscan 与测量兜底降低发生概率。
  - Monaco 重建成本在快速滚动时仍可能可感知,后续可对 apply_patch 卡片做折叠/懒加载进一步优化。
- 回滚
  - 虚拟列表改造可通过 feature flag 方式切换回原有 `v-for` 全量渲染。
  - Tabs 去掉 forceRender 是低风险改动,如出现明显的首次切换延迟问题再评估是否需要局部开启。

## 后续可选优化

- apply_patch 卡片内部增加折叠/按需展开,减少单条消息内 Monaco 数量。
- 如果未来启用 `destroyInactiveTabPane=true` 以进一步降内存,需要额外实现 per-session 的 scroll offset 保存与恢复。
