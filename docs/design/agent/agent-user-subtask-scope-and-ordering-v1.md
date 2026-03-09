# Agent 用户/子任务可见范围与排序方案(v1)

本文档描述 `agent-workbench` 中 Agent Profiles 的筛选与排序改造方案。

目标是将 agent 分为 **用户可选**、**subtask 可选**、**两者通用** 三类，并在保持当前配置结构尽量稳定的前提下，实现：

- 用户侧与 subtask 侧只看到各自需要的 agent
- 不再维护单独的“默认 agent”配置
- 通过持久化顺序字段 + 设置页拖拽排序，统一展示顺序与默认选择规则
- 前端负责展示过滤，后端负责最终执行校验

---

## 背景

当前实现中，Agent Settings 只有一份全局列表：

- 用户侧的 agent 下拉选项，来自 `GET /api/settings/agent/agents`
- subtask 工具描述里展示给模型的“可选 Agent”列表，同样来自这份全量 settings
- 后端当前只校验 `agentId` 是否存在，不校验“该 agent 是否允许在当前场景使用”

这会带来两个问题：

1. 用户与 subtask 会看到同一份全量列表，无法按产品场景做筛选。
2. 仅靠前端或 prompt 隐藏不足以形成约束；若后端不做执行校验，仍可能绕过展示层直接使用不允许的 agent。

同时，当前 agent settings 中存在单独的 `default.agentId` 语义；随着 agent 列表改为按场景筛选后，“单独默认项”会与“展示顺序”“场景可见性”形成重复甚至冲突的配置。

---

## 目标

- 将 agent 按使用范围划分为：`user`、`subtask`、`both`
- 在 agent 数据模型中新增 `scope` 字段，并在历史数据读取时默认补为 `both`
- 移除单独的默认 agent 配置，不再维护 `default.agentId`
- 在 agent 数据模型中新增稳定顺序字段 `order`
- 设置页作为唯一配置入口，支持：
  - 创建 agent
  - 编辑 `scope`
  - 拖拽排序
- 用户侧接口仍返回全量 agent，由前端按 `scope` 过滤展示
- 后端在执行路径上强制校验 agent 的场景合法性
- 当前场景默认项 = 过滤后按顺序排列的第一项
- 当前场景没有可用 agent 时，后端返回明确错误码，前端展示可理解提示

---

## 非目标

- 不引入独立的多套 agent 列表（例如 userAgents / subtaskAgents / sharedAgents）
- 不引入角色/团队/RBAC 权限体系
- 不新增“内置 agent”或预置 seed 数据；初始状态允许 agent 列表为空
- 不改变 Provider/Model 的解析规则；agent 的 `defaultModel` 能力继续保留
- 不在本期引入单独的“subtask 默认 agent 配置”
- 不要求本期为了该能力新增专用过滤接口；仍复用现有 `GET /api/settings/agent/agents`
- 不改变 subtask 会话隐藏 `subtask` 工具的既有规则

---

## 现状实现(参考)

### Settings 与共享契约

- 共享契约：`packages/shared/src/contracts/settings.ts`
  - `AgentItemSchema`
  - `AgentItemViewSchema`
  - `AgentSettingsSchema`
  - `AgentSettingsViewSchema`
- 后端 settings 服务：`apps/api/src/modules/settings/settings.service.ts`
  - `AGENT_SETTINGS_KEY = "agent_agents_v1"`
  - `getAgentSettings()`
  - `updateAgentSettings()`
  - `resolveExecutionProfile()`

### 用户侧 agent 列表

- API 封装：`apps/web/src/shared/api/api.ts`
  - `getAgentSettings()`
  - `updateAgentSettings()`
- 工作区 Agent 工具页：`apps/web/src/features/workspace/tools/agent/AgentToolView.vue`
  - `refreshAgents()` 当前直接使用全量 `res.agents`

### subtask 展示与执行

- prompt-context 组装：`apps/api/src/modules/agent/agent.service.ts`
  - `buildSubtaskToolDescription(...)`
  - `getPromptContextForRun()` 中当前用全量 agent 构建 subtask 可选列表
- subtask 启动：`apps/api/src/modules/agent/agent.service.ts`
  - `startSubtaskRunFromWorker(...)`
  - 当前仅依赖 `resolveExecutionProfile()` 校验 agent 是否存在
- worker 侧参数：`apps/agent-worker/src/runtime/runner.ts`
  - 当前 `subtask.agentId` 仍为必填

### 设置页

- `apps/web/src/features/settings/components/AgentProfilesSettingsPanel.vue`
  - 当前支持增删改 agent
  - 当前仍维护 `selectedDefaultAgentId`
  - 自动保存 `PUT /api/settings/agent/agents`

---

## 设计原则

### 1) 单一事实来源

agent 的可见范围与顺序都应挂在单个 agent 元数据上，而不是拆成多份列表，避免重复维护与配置漂移。

### 2) 展示与执行双重约束

- 前端负责按场景过滤展示
- 后端负责最终执行校验

任何仅存在于前端或 prompt 文本中的约束，都不应被视为真正的权限边界。

### 3) 默认选择来自排序，不再单独配置

“默认 agent”不再作为独立设置项存在；默认项由当前场景可见列表的顺序自然决定。

### 4) 兼容旧数据，避免升级后 agent 突然消失

旧数据中没有 `scope` 时，统一按 `both` 处理；旧数据中没有 `order` 时，按原数组顺序补齐稳定值。

### 5) 设置页是唯一配置入口

因为项目没有内置 agent，且初始状态允许为空，所以 `scope` 与 `order` 必须能在设置页中直接维护。

---

## 设计结论

### 1. Agent 新增 `scope`

在 `AgentItem` 上新增：

```ts
type AgentScope = "user" | "subtask" | "both";
```

含义：

- `user`: 仅用户侧可见/可选
- `subtask`: 仅 subtask 可见/可选
- `both`: 用户侧与 subtask 侧都可见/可选

### 2. Agent 新增 `order`

在 `AgentItem` 上新增：

```ts
order: number;
```

规则：

- `order` 越小越靠前
- `order` 是持久化字段，不从数组下标临时推导
- 设置页通过拖拽调整顺序，落盘时写回 `order`
- 后端在读取时可对异常/重复/缺失 `order` 做归一化，保证顺序稳定

### 3. 移除单独的默认 agent 配置

从 Agent Settings 中移除：

```ts
default: { agentId: string } | null
```

新的默认规则：

- 用户场景默认项 = 过滤出 `user | both` 后按 `order` 升序的第一项
- subtask 场景默认项 = 过滤出 `subtask | both` 后按 `order` 升序的第一项

> 说明：当前 worker 侧 `subtask.agentId` 仍为必填，因此本期“subtask 默认项”主要用于：
> - subtask 工具描述中的展示顺序
> - 未来若允许省略 `agentId` 时复用同一回退规则
> - 保持前后端规则定义一致

### 4. 用户接口继续返回全量 agent，由前端过滤展示

维持现有接口：

- `GET /api/settings/agent/agents`
- `PUT /api/settings/agent/agents`

返回值仍为全量 agent；用户侧前端自行过滤：

- 保留 `scope === "user" || scope === "both"`

### 5. 后端必须做执行校验

所有实际执行路径必须显式区分场景，并校验 agent 的 `scope` 是否允许在当前场景使用：

- 用户侧：只能用 `user | both`
- subtask：只能用 `subtask | both`

若不满足，后端直接返回明确错误码。

此外，**模型请求时生成 subtask 工具描述的链路也必须同步改造**。当前该描述会被注入 prompt-context，直接影响模型能“看到”哪些 agent；因此不能继续基于全量 agent 构造描述，而必须与 subtask 执行规则保持一致：先过滤 `subtask | both`，再按 `order` 排序，再传给 `buildSubtaskToolDescription(...)`。这属于**必须改造项**，不是仅影响体验的可选优化。

### 6. 设置页支持拖拽排序

设置页中的 agent 列表改为支持拖拽排序，拖拽完成后：

- 立即更新本地数组顺序
- 重算各项 `order`
- 复用当前自动保存机制持久化

---

## 数据模型与协议

### Settings Key

继续复用：

- `agent_agents_v1`

### 新的数据形状

建议将 `agent_agents_v1` 规范为：

```ts
type AgentScope = "user" | "subtask" | "both";

type AgentItem = {
  id: string;
  name: string;
  summary: string;
  prompt: string;
  globalPromptIds?: string[];
  tools: AgentToolName[];
  mcpServers: string[];
  defaultModel: { providerId: string; modelId: string } | null;
  scope: AgentScope;
  order: number;
};

type AgentSettings = {
  agents: AgentItem[];
  updatedAt: number;
};
```

对外 view 结构继续带 `resolvedModel`：

```ts
type AgentItemView = AgentItem & {
  resolvedModel: AgentResolvedModel | null;
};
```

### 字段约束

- `scope`
  - 必填
  - 取值仅允许 `user | subtask | both`
- `order`
  - 必填
  - 整数
  - 建议 `>= 0`
  - 相同 `order` 允许 incoming 发生，但保存前应归一化为稳定唯一顺序

### 顺序归一化建议

为保持实现简单与可预测，建议：

- 存储时按当前数组顺序重写为单调递增的整数序列
- 建议使用带间隔的序列，如 `1000, 2000, 3000...`

这样可以：

- 让数据层顺序清晰可读
- 为未来插入/局部调整预留空间
- 避免把“数组顺序碰巧如此”误当成唯一顺序来源

---

## 过滤、排序与默认选择规则

### 场景过滤规则

| 场景 | 允许的 scope |
| --- | --- |
| 用户 UI 展示/选择 | `user`、`both` |
| subtask 工具描述展示 | `subtask`、`both` |
| 用户执行校验 | `user`、`both` |
| subtask 执行校验 | `subtask`、`both` |

### 排序规则

对任一场景下的候选列表：

1. 先按 `scope` 过滤
2. 再按 `order` 升序排序
3. 若 `order` 相同，按 `name` 升序兜底
4. 若仍相同，按 `id` 升序兜底

> 说明：后两条兜底规则主要用于兼容脏数据或归一化前的短暂状态。

### 默认选择规则

- 用户场景默认项：过滤并排序后的第一项
- subtask 场景默认项：过滤并排序后的第一项
- 若过滤后为空：视为“当前场景无可用 agent”

### 空列表规则

- 用户侧无可用 agent：
  - 前端显示空态与引导文案
  - 后端在需要解析 agent 时返回明确错误码
- subtask 侧无可用 agent：
  - subtask 工具描述中应明确说明“当前无可用 agent”
  - 若仍发起执行，后端返回明确错误码

---

## 后端设计

## A. Shared Contract 调整

文件：`packages/shared/src/contracts/settings.ts`

建议改动：

- 为 `AgentItemSchema / AgentItemViewSchema` 增加：
  - `scope`
  - `order`
- 从 `AgentSettingsSchema / AgentSettingsViewSchema / UpdateAgentSettingsRequestSchema` 中移除：
  - `default`

影响：

- 前后端共享类型同步收敛到“无单独默认 agent”的新语义

## B. Settings 读写与归一化

文件：`apps/api/src/modules/settings/settings.service.ts`

建议处理：

1. 读取旧数据时：
   - `scope` 缺失 → 自动补为 `both`
   - `order` 缺失 → 按原有数组顺序补值
   - 旧 `default` 字段存在 → 忽略，不再参与运行时解析
2. 保存新数据时：
   - 校验 `scope` 合法性
   - 校验/归一化 `order`
   - 不再接受或持久化 `default`
3. `getAgentSettings()`：
   - 返回带 `scope/order/resolvedModel` 的全量 agent 列表
4. `updateAgentSettings()`：
   - 继续校验 id/name/globalPromptIds/mcpServers/defaultModel 等既有规则
   - 新增 `scope/order` 的校验与归一化

## C. 运行时解析统一引入“场景”概念

文件：`apps/api/src/modules/settings/settings.service.ts`

当前 `resolveExecutionProfile()` 主要基于：

- `input.agentIdFromRun`
- `input.requestedAgentId`
- `agentSettings.default?.agentId`

本方案建议将其改为按场景解析，例如：

```ts
resolveExecutionProfile(ctx, {
  surface: "user" | "subtask",
  requestedAgentId?: string | null,
  agentIdFromRun?: string | null,
  providerIdFromRun?: string | null,
  modelIdFromRun?: string | null
})
```

解析顺序建议：

1. 若 `agentIdFromRun` 存在：优先使用（用于 run 重放/固化）
2. 否则若 `requestedAgentId` 存在：使用请求值
3. 否则：从当前 `surface` 的可用 agent 列表中取排序第一项
4. 若当前 `surface` 没有可用 agent：返回场景级空列表错误
5. 若指定 agent 不属于当前 `surface`：返回范围不允许错误

这样可以替代旧的 `default.agentId` 回退逻辑。

## D. subtask 工具描述过滤

文件：`apps/api/src/modules/agent/agent.service.ts`

当前 `getPromptContextForRun()` 在 `enabledToolNames` 包含 `subtask` 时，会基于全量 `getAgentSettings().agents` 构建 `buildSubtaskToolDescription(...)`。

这意味着，即使后续在 subtask 执行阶段补上了 `scope` 校验，只要工具描述仍然遍历全量 agent，模型依然会在提示中看到不应由 subtask 使用的 agent。这样会造成：

- 展示层告诉模型“这些 agent 都可选”
- 执行层却在真正调用时拒绝其中一部分 agent

上述不一致会直接降低模型选择正确 agent 的概率，也会增加无效调用与排查成本。因此，**subtask 工具描述的过滤与排序改造是本方案的强制要求，不是可选优化项**。

改造后应：

1. 先获取全量 agent settings
2. 过滤出 `scope === "subtask" || scope === "both"`
3. 按 `order` 升序排序
4. 再映射为 `id/name/summary` 传给 `buildSubtaskToolDescription(...)`
5. 当过滤结果为空时，description 应明确提示当前没有可用的 subtask agent

即：**subtask 工具描述所使用的 agent 列表，不得再直接复用未过滤的全量 `getAgentSettings().agents`**；必须先做与 subtask 场景一致的 `scope/order` 处理后，再参与描述拼装。

## E. subtask 执行校验

文件：`apps/api/src/modules/agent/agent.service.ts`

函数：`startSubtaskRunFromWorker(...)`

建议处理：

- 在调用 `resolveExecutionProfile(...)` 时显式传入 `surface: "subtask"`
- 若 `resolvedAgentId` 对应 agent 的 `scope === "user"`，返回明确错误
- 若当前没有任何 `subtask | both` agent，返回场景空列表错误

## F. 用户执行校验

凡是用户侧发起 run、切换 agent 或创建新会话时涉及 agent 解析的路径，都应统一走 `surface: "user"` 的解析规则。

目标是保证：

- UI 未展示的 agent，后端也不可使用
- 即使前端缓存或手工请求传入非法 agentId，也会被拒绝

---

## 前端设计

## A. 工作区用户选择区

文件：`apps/web/src/features/workspace/tools/agent/AgentToolView.vue`

当前 `refreshAgents()` 直接把 `res.agents` 转为 `agentOptions`。

改造后：

1. 获取全量 `res.agents`
2. 过滤出 `scope === "user" || scope === "both"`
3. 按 `order` 升序排序
4. 渲染为 `agentOptions`
5. 默认选中第一项（若存在）

额外约束：

- 若本地持久化的已选 agent 现在不在用户可用列表中，应清空该选择并回退到当前第一项
- 若过滤后为空，UI 应显示“暂无可用 Agent，请前往设置页配置”之类的空态提示

## B. 设置页交互

文件：`apps/web/src/features/settings/components/AgentProfilesSettingsPanel.vue`

当前设置页已经具备：

- 新建/编辑 agent
- 删除 agent
- 自动保存

本方案改造为：

1. 移除“设为默认 agent”相关 UI 与状态
   - 删除 `selectedDefaultAgentId`
   - 删除 `setDefaultAgent(...)`
   - 删除表单里的“设为默认”语义
2. 在新建/编辑 agent 表单中新增 `scope` 字段
   - 推荐使用单选或下拉：
     - 用户可选(`user`)
     - subtask 可选(`subtask`)
     - 两者通用(`both`)
3. 列表支持拖拽排序
   - 每一行增加拖拽手柄
   - 拖拽落定后，更新本地顺序并重算 `order`
   - 复用现有自动保存机制持久化
4. 空态支持
   - 初始 agent 列表为空时，明确提示“暂无 Agent，请先创建”

### 拖拽排序交互建议

- 仅在列表视图中支持拖拽，不在弹窗中做排序
- 拖拽过程中只更新本地 UI，不即时多次保存
- 仅在 drop 完成后触发一次 `persist({ toast: true | false })`
- 若保存失败：
  - 保留本地顺序
  - 延续当前设置页的自动保存重试语义

---

## 错误处理

### 错误码建议

建议新增/使用以下错误码：

- `AGENT_SCOPE_NOT_ALLOWED`
  - 指定 agent 存在，但不允许在当前场景使用
- `AGENT_NO_AVAILABLE_FOR_SURFACE`
  - 当前场景没有任何可用 agent
- `AGENT_SCOPE_INVALID`
  - settings 更新时传入了非法 `scope`
- `AGENT_ORDER_INVALID`
  - settings 更新时 `order` 非法且无法归一化（若实现选择严格校验）

建议错误详情中补充：

- `surface: "user" | "subtask"`
- `agentId`（如适用）

### 前端提示建议

- `AGENT_SCOPE_NOT_ALLOWED`
  - 用户侧：`所选 Agent 不允许在当前场景使用，请重新选择。`
  - subtask 侧：`该 Agent 不能用于子任务，请改用 subtask 或 both 类型的 Agent。`
- `AGENT_NO_AVAILABLE_FOR_SURFACE`
  - 用户侧：`当前没有可用 Agent，请前往设置页创建或调整 Agent 范围。`
  - subtask 侧：`当前没有可用于子任务的 Agent，请前往设置页配置 scope 为 subtask 或 both 的 Agent。`

---

## 设置页交互细化

### Agent 行展示建议

每一行可展示：

- `name`
- `id`
- `summary`
- `scope` 标签
- `resolvedModel` 简要信息（沿用现有能力）
- 拖拽手柄
- `Edit` / `Delete`

### 新建/编辑表单建议

在现有字段基础上新增：

- `scope`
  - 必填
  - 默认值建议为 `both`

不再保留：

- `Set as default` 或等价控件

### 排序与过滤的关系

设置页中的排序应作用于全量 agent 列表本身，而不是某个过滤子集。

原因：

- 设置页是配置入口，不是某一运行场景的投影视图
- `order` 应是全局稳定顺序，用户侧与 subtask 侧都基于同一顺序字段做各自过滤

示例：

全量顺序：`A(user) -> B(both) -> C(subtask) -> D(both)`

则：

- 用户侧看到：`A -> B -> D`
- subtask 侧看到：`B -> C -> D`

两侧都保留全局相对顺序。

---

## 迁移与兼容

### 历史数据迁移规则

对于已存量的 `agent_agents_v1`：

1. `scope` 缺失：补为 `both`
2. `order` 缺失：按原数组顺序补值
3. `default` 存在：忽略，不再参与运行时默认选择
4. 下次保存时，按新结构重写 settings

### 对旧前端的兼容性

若系统不存在旧前端与新后端并存的升级窗口，可直接升级共享契约并删除 `default` 字段。

若需要灰度兼容，可采用过渡方案：

- 服务端临时接受 incoming `default`，但忽略其语义
- 返回时可保留 `default: null` 一个版本
- 待前端全部升级后，再彻底移除 `default`

v1 推荐：**前后端同仓同步升级，直接移除 `default` 语义。**

### 空配置兼容

因为没有内置 agent，以下状态均被视为合法：

- 全新安装时 `agents = []`
- 用户删除了所有 agent

系统需要对“空列表”做良好空态和错误提示，而不是强行 seed 内置 agent。

---

## 测试建议

### 1. Shared / Settings 单元测试

- 旧数据无 `scope/order` 时读取结果正确补齐
- 保存时 `scope` 非法会报错
- 保存时 `order` 缺失/重复/乱序能正确归一化
- 旧 `default` 字段不会再影响运行时解析

### 2. API 集成测试

- `GET /api/settings/agent/agents`
  - 返回全量 agent
  - 每项带 `scope/order/resolvedModel`
- `PUT /api/settings/agent/agents`
  - 可保存 `scope/order`
  - 不再要求 `default`
- 用户执行路径
  - 指定 `subtask` 类型 agent 时被拒绝
  - 未指定 agent 且存在可用 agent 时，回退到过滤后第一项
  - 当前无可用 user agent 时返回 `AGENT_NO_AVAILABLE_FOR_SURFACE`
- subtask 执行路径
  - 指定 `user` 类型 agent 时被拒绝
  - 当前无可用 subtask agent 时返回 `AGENT_NO_AVAILABLE_FOR_SURFACE`
- prompt-context
  - subtask 工具描述只包含 `subtask | both`
  - 列表顺序符合 `order`

### 3. 前端交互测试 / 手工验证

- 设置页：
  - 新建 agent 时可设置 `scope`
  - 拖拽后顺序立即更新
  - drop 后自动保存
  - 刷新页面后顺序保持一致
- 工作区：
  - 仅展示 `user | both`
  - 默认选中第一项
  - 已缓存但已不可用的 agent 会被清空并回退
  - 无可用 agent 时显示空态
- subtask：
  - 模型看到的候选 agent 已按 scope 过滤并按顺序展示

---

## 风险与回滚

### 风险 1：移除 `default` 字段带来的兼容影响

风险：旧代码可能仍依赖 `default.agentId`。

对策：

- 在实现前统一检索 `default.agentId` 的所有读取点
- 优先改造 `resolveExecutionProfile()` 及设置页默认逻辑
- 若担心灰度升级风险，可采用一个过渡版本兼容 `default: null`

### 风险 2：仅做前端过滤导致误用

风险：若遗漏后端校验，仍可通过构造请求使用非法 agent。

对策：

- 强制所有执行路径通过带 `surface` 的统一解析函数
- 补 API 集成测试覆盖 user/subtask 两侧

### 风险 3：拖拽排序与自动保存叠加后出现顺序闪动

风险：drop 后本地顺序、服务端归一化顺序、重新拉取顺序若不一致，可能造成 UI 抖动。

对策：

- 约定保存前后使用同一套 `order` 归一化规则
- 前端提交前按当前数组顺序直接重算 `order`
- 保存成功后使用服务端返回值覆盖本地草稿

### 风险 4：场景无可用 agent 时体验中断

风险：如果空态提示不清晰，用户会误以为系统异常。

对策：

- 前端对空列表做明确引导：前往设置页创建 agent 或调整 `scope`
- 后端错误码稳定、文案可映射

### 回滚策略

若上线后需要快速回退：

1. 后端临时忽略 `scope` 校验，并将所有 agent 视为 `both`
2. 前端暂时停止过滤，恢复展示全量 agent
3. 保留 `order` 字段但不影响行为

这样可以在不清理新数据的前提下回到“单一全量列表”的旧行为。

---

## 落地改动点(代码级)

> 仅列关键文件与职责，具体实现以最小改动为原则。

### Shared

- `packages/shared/src/contracts/settings.ts`
  - 新增 `scope/order`
  - 移除 `default`

### API / Settings

- `apps/api/src/modules/settings/settings.service.ts`
  - 旧数据归一化
  - 更新校验
  - 引入按 `surface` 解析 agent 的逻辑
- `apps/api/src/modules/settings/settings.routes.ts`
  - 路由形状随 shared contract 同步

### API / Agent Runtime

- `apps/api/src/modules/agent/agent.service.ts`
  - subtask 工具描述按 `scope/order` 过滤与排序
  - subtask 启动时按 `surface=subtask` 校验
  - 用户执行路径按 `surface=user` 校验

### Web / Settings

- `apps/web/src/features/settings/components/AgentProfilesSettingsPanel.vue`
  - 移除默认 agent UI
  - 新增 `scope` 表单项
  - 新增拖拽排序

### Web / Workspace

- `apps/web/src/features/workspace/tools/agent/AgentToolView.vue`
  - 获取全量 agent 后按 `scope/order` 过滤展示
  - 默认选中第一项
  - 处理空态与非法缓存值

### API Client

- `apps/web/src/shared/api/api.ts`
  - shared contract 更新后的类型同步

---

## 最终结论

本方案以 **`scope + order`** 为核心，对现有统一 agent 列表做轻量增强：

- 用 `scope` 解决“谁能看到/使用哪个 agent”的问题
- 用 `order` 解决“展示顺序与默认选择”的问题
- 用“过滤后第一项”替代单独的默认 agent 配置
- 用“前端过滤 + 后端校验”同时保证体验与约束

它保持了当前 settings 单表结构与接口形态，避免引入多份列表或更重的权限系统，适合作为当前阶段的最小可落地方案。
