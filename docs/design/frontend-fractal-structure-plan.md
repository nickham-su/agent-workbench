# 前端目录分型改造方案（两阶段）

## 背景

- 当前前端目录 `apps/web/src` 同时存在“按技术分层”和“按功能聚合”两种组织方式
  - `pages/`、`layouts/`、`sections/`、`state/`、`services/`、`utils/` 偏传统分层
  - `auth/`、`workspace/`、`terminal/`、`monaco/` 已经偏功能聚合
- 现状在规模变大时容易出现的问题
  - 业务单元边界不清晰：`sections/` 被多个功能域复用，容易变成“杂物间”
  - 大文件承载多职责：例如 `WorkspaceLayout.vue`、`FileExplorerToolView.vue`，维护与回归成本高
  - “状态/工具函数/类型”难以就近归属：容易被推到全局目录，导致跨层依赖加重

## 目标

- 以“分型架构”方式重组目录：任意功能单元可自带 `components/ stores/ utils/ types/` 等可选子目录
- 优先提升“功能内聚性”和“局部自治性”，让代码按真实业务单元聚合
- 采用渐进式迁移
  - 阶段一：仅目录搬迁与导入路径调整，不拆组件、不改行为；只做代码检测验证
  - 阶段二：在新目录结构稳定后，再拆分大文件（以最小行为变更为原则）

## 非目标（本次不做）

- 不引入新的状态管理框架（例如 Pinia）
- 不在阶段一做 API 层按域拆分（可作为阶段二或后续优化）
- 不做 UI/交互改版

## 当前结构速览（仅用于对照）

- 入口与基础
  - `main.ts`、`App.vue`、`router/`、`i18n/`、`styles/`
- 传统分层目录
  - `pages/`：路由页面
  - `layouts/`：页面布局壳
  - `sections/`：Workbench tabs + Workspace 内工具复用的 UI 块
  - `services/`：单体 API 客户端与接口函数
  - `state/`：全局内存态状态（repos 轮询、workbench 搜索词）
  - `utils/`：通用工具函数
- 已按功能聚合的目录
  - `auth/`、`workspace/`、`terminal/`、`monaco/`

## 目标目录形态（阶段一完成后的期望）

- 顶层只保留“可预测的少量根节点”
  - `app/`：应用装配（入口、路由、全局初始化）
  - `shared/`：跨域复用且相对稳定的能力（i18n、styles、monaco 基建、通用组件、通用设置等）
  - `features/`：按功能域聚合的分型单元（每个功能域可递归包含子单元）

### 建议的目标结构（初版）

> 命名可在确认时微调：`features/` 也可叫 `modules/`，本文用 `features/` 表达。

- `apps/web/src/app/`
  - `main.ts`
  - `App.vue`
  - `router/`
- `apps/web/src/shared/`
  - `i18n/`
  - `styles/`
  - `monaco/`
  - `settings/`（例如字体大小设置，若被多个功能域使用则放这里）
  - `components/`（跨域可复用的通用组件）
  - `api/`（阶段一可先保持单文件，阶段二再按域拆）
- `apps/web/src/features/`
  - `auth/`
  - `workbench/`（Workbench 页面与布局壳）
  - `repos/`（repos 相关 UI + 状态 + utils，供 workbench/workspace 复用）
  - `workspaces/`（workspaces 列表与管理）
  - `settings/`（设置页 tabs）
  - `workspace/`（单个 workspace 页面与 dock/tools）

### 目录边界约定（用于长期维护）

- `shared/` 放“跨功能域复用”的东西
  - 判断标准：至少两个功能域使用，且语义不属于某个具体业务域
- `features/<name>/` 内的 `stores/ utils/ types/` 默认只服务本功能域
  - 若后续被多域复用，再上移到 `shared/`
- 尽量避免出现新的“黑洞目录”
  - 不新增全局 `utils/`、全局 `state/`；新增内容优先就近放入功能域

## 阶段一：纯目录搬迁（不拆组件）

### 原则

- 仅做“文件位置调整 + import 路径更新”，不做逻辑改动
- 保持路由与页面行为一致
- 调整过程尽量减少“横跨多域”的引用
  - 例如把 `sections/TerminalTabs.vue` 与 `terminal/*` 归并到同一个工具域下，避免跨目录拉扯

### 搬迁映射（建议）

- 应用装配
  - `src/main.ts` -> `src/app/main.ts`
  - `src/App.vue` -> `src/app/App.vue`
  - `src/router/*` -> `src/app/router/*`
- shared
  - `src/i18n/*` -> `src/shared/i18n/*`
  - `src/styles/*` -> `src/shared/styles/*`
  - `src/monaco/*` -> `src/shared/monaco/*`
  - `src/settings/uiFontSizes.ts` -> `src/shared/settings/uiFontSizes.ts`（理由：被 terminal/monaco/设置页同时使用）
  - `src/components/*` -> `src/shared/components/*`（通用组件）
  - `src/services/api.ts` -> `src/shared/api/api.ts`
  - `src/api.ts` 保持为 re-export（或迁入 `shared/api/index.ts`，二选一）
- auth
  - `src/auth/*` -> `src/features/auth/*`
  - `src/pages/LoginPage.vue` -> `src/features/auth/views/LoginPage.vue`
- workbench
  - `src/pages/WorkbenchPage.vue` -> `src/features/workbench/views/WorkbenchPage.vue`
  - `src/layouts/WorkbenchLayout.vue` -> `src/features/workbench/views/WorkbenchLayout.vue`（或 `layouts/`，按偏好确定）
- repos（供 workbench + workspace 复用）
  - `src/sections/ReposTab.vue` -> `src/features/repos/views/ReposTab.vue`
  - `src/state/repos.ts` -> `src/features/repos/stores/repos.ts`
  - `src/utils/gitHost.ts`、`src/utils/repoUrl.ts` -> `src/features/repos/utils/*`（如后续多域复用再上移 `shared/`）
- workspaces
  - `src/sections/WorkspacesTab.vue` -> `src/features/workspaces/views/WorkspacesTab.vue`
- settings
  - `src/sections/SettingsTab.vue` -> `src/features/settings/views/SettingsTab.vue`
- workspace（单 workspace 页面与工具）
  - `src/pages/WorkspacePage.vue` -> `src/features/workspace/views/WorkspacePage.vue`
  - `src/layouts/WorkspaceLayout.vue` -> `src/features/workspace/views/WorkspaceLayout.vue`
  - `src/workspace/*` -> `src/features/workspace/*`（host/context/components/icons 等）
  - 工具归并（把 `sections/` 中与 workspace tools 强相关的内容搬回工具域）
    - code-review
      - `src/sections/CodeReviewPanel.vue`、`src/sections/CodeReviewPlaceholder.vue`
      - `src/workspace/tools/CodeReviewToolView.vue`
      - 目标：`src/features/workspace/tools/code-review/*`
    - terminal
      - `src/sections/TerminalTabs.vue`
      - `src/terminal/*`
      - `src/workspace/tools/TerminalToolView.vue`
      - 目标：`src/features/workspace/tools/terminal/*`
    - file-explorer
      - `src/workspace/tools/FileExplorerToolView.vue`
      - 目标：`src/features/workspace/tools/file-explorer/FileExplorerToolView.vue`

### 执行步骤（阶段一）

- 准备
  - 创建目标目录骨架（`app/ shared/ features/` 等）
  - 确认是否要保留“薄兼容层”
    - 例如保留 `src/services/api.ts` 作为 re-export 指向新位置，降低一次性改动量
- 搬迁与修正
  - 按“从入口向外扩散”的顺序搬迁，保持每次变更可编译
    - 先搬 `app/`（`main.ts`、`router/`、`App.vue`）
    - 再搬 `shared/`（i18n/styles/monaco/api）
    - 再搬各 `features/`（auth/workbench/repos/workspaces/settings/workspace）
  - 每次搬迁后，批量修正 import 路径（仅路径变化，不改逻辑）
- 检测（阶段一验收）
  - 运行前端类型检查：`npm run typecheck -w apps/web`
  - 运行前端构建：`npm run build -w apps/web`
  - 如需最小手动验证（可选）
    - `npm run dev -w apps/web` 后确认可进入登录页与 workbench/workspace 页面基本可渲染

### 阶段一完成标准

- `apps/web` 的 `typecheck` 与 `build` 通过
- 页面路由不变、核心页面可渲染（如做了可选的手动验证）
- 新增代码仅限于“路径调整/必要的 re-export 兼容”，不引入行为变化

## 阶段二：拆分大文件（在新目录稳定后进行）

### 总体原则

- 拆分只改变“物理组织”，尽量不改行为
- 先抽“纯 UI 子组件”和“纯状态/逻辑模块”，再做更细的递归
- 拆分后的单元遵循分型结构
  - `tools/<tool>/ToolView.vue`（入口）
  - `components/`（UI 子组件）
  - `stores/`（局部状态机/轮询/缓存）
  - `utils/`（不依赖 Vue 的纯函数、转换逻辑）
  - `types.ts`（局部类型）

### WorkspaceLayout.vue 拆分建议

> 目标：把“页面骨架渲染”与“dock/tool 宿主逻辑”分离，降低单文件复杂度。

- 拆分方向（候选）
  - `features/workspace/views/WorkspaceLayout.vue` 保留为页面入口与少量编排
  - `features/workspace/components/WorkspaceHeader.vue`
    - 标题、repo selector、header actions 容器
  - `features/workspace/components/WorkspaceDock.vue`
    - grid 布局、分割线拖拽、区域显隐
  - `features/workspace/stores/dockLayout.ts`
    - 面板比例、拖拽计算、持久化策略（如需要）
  - `features/workspace/stores/toolRuntime.ts`
    - active/minimized/keepAlive、工具移动规则、工具事件队列
  - `features/workspace/tools/registry.ts`
    - 工具注册表（toolId -> icon/view/allowedAreas 等）

### FileExplorerToolView.vue 拆分建议

> 目标：把“文件树 + tabs + editor + API 调用 + Monaco 生命周期”拆成可独立理解的子单元。

- 拆分方向（候选）
  - `features/workspace/tools/file-explorer/FileExplorerToolView.vue` 保留为工具入口与编排
  - `features/workspace/tools/file-explorer/components/FileTree.vue`
    - treeData/expandedKeys/loadedDirs、目录懒加载与请求序列控制
  - `features/workspace/tools/file-explorer/components/FileTabs.vue`
    - tabs 列表、dirty/saving/pendingSave、关闭与切换策略
  - `features/workspace/tools/file-explorer/components/EditorPane.vue`
    - Monaco editor 实例、model/disposable 生命周期、语言切换、diff/preview 展示（按现状拆）
  - `features/workspace/tools/file-explorer/stores/fileExplorerStore.ts`
    - 统一管理“当前目录/选中项/打开文件集合/请求并发控制”的状态机
  - `features/workspace/tools/file-explorer/utils/*`
    - path 处理、标题生成、错误归一化等纯函数
  - `features/workspace/tools/file-explorer/types.ts`

### 阶段二检测与验收

- 每次拆分后保持可编译与可运行
  - `npm run typecheck -w apps/web`
  - `npm run build -w apps/web`
- 最小手动验证（建议）
  - Workspace 页面可打开工具、切换/最小化正常
  - File Explorer 可浏览目录、打开文件、编辑保存、错误提示正常（按现有能力验证）

## 待确认点（进入开发前需要你拍板）

- 已确认决策
  - 顶层命名使用 `features/`
  - 阶段一引入路径别名：`@/` -> `src/`
    - 需要同步调整 `apps/web/vite.config.ts` 与 `apps/web/tsconfig.json`
    - 后续目录搬迁与大文件拆分将统一使用 `@/`，减少相对路径抖动
  - 不保留薄兼容层（re-export）
    - 阶段一搬迁时一次性改完 import 路径，避免旧路径长期存在导致边界继续模糊
