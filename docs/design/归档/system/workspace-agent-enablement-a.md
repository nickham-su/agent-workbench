# Workspace 级 Agent 启用状态管理方案（A 方案）

## 背景与目标

当前系统中的 agent 定义是**全局配置**（Settings -> Agent），Web 与飞书 `/a` 在工作区内选择 agent 时，实际读取的是“按 surface 过滤后的全局可用列表”。这导致：

- 不同 workspace 无法配置不同的 agent 启用范围；
- 飞书绑定会话后 `/a` 的候选集无法体现 workspace 差异；
- 运营/权限侧无法在 workspace 维度做“可用 agent 收敛”。

本方案目标：在**不改变 agent 全局定义模型**的前提下，新增 workspace 级启用状态管理能力，并统一作用于：

- Web 工作区 Agent 面板；
- 飞书 `/a` 命令；
- 后端运行时校验与兜底。

> 本期仅落地 **A 方案**。

---

## 核心约束（本方案必须满足）

1. **agent 全局定义，workspace 仅维护启用子集**。  
2. **默认全部启用**（workspace 未配置时，视为启用全部全局 agent）。  
3. 本期**不做排序**、**不做默认 agent**、**不做快速 agent 集合切换**。

---

## 本期范围 / 非目标

## 本期范围

- 新增 workspace 级 agent 启用配置的数据模型与读写接口；
- Web 端支持在 workspace 维度配置“启用 agent 子集”；
- Web 工作区会话内的候选 agent 列表按 workspace 启用集过滤；
- 飞书 `/a` 与会话绑定场景按 workspace 启用集过滤；
- 运行时发送消息/执行命令时校验 agent 是否在 workspace 启用集中。

## 非目标（本期不做）

- agent 排序能力（仍沿用全局 `order`）；
- workspace 默认 agent（不引入 `defaultAgentId`）；
- 多套 agent 组合快速切换（profile/preset）；
- 跨 workspace 批量复制策略；
- 细粒度 RBAC（谁可改 workspace agent 配置）。

---

## 当前现状分析

## Web 现状

- Workspace Agent 面板加载候选列表时，当前通过 `getAgentSettings()` 直接读取全局配置并本地过滤 `scope in ["user", "both"]`，未引入 workspace 维度过滤。
- 会话发送消息时使用 `effectiveAgentId`，未对“workspace 是否启用该 agent”做前置判断。

现状影响：同一 agent 列表在所有 workspace 等价，无法做工作区隔离。

## 后端现状

- 内部接口 `/api/internal/agent/agents/list` 当前固定 `surface = "user"`，并基于 `listAvailableAgentsForSurface` 返回全局可用 agent，再按 `scope` + `order` 排序。
- `resolveExecutionProfile` 的选择逻辑是：
  - 有请求 `requestedAgentId` 则校验存在性与 scope；
  - 无请求时回退到 surface 下第一个全局可用 agent。
- 当前无 workspace agent 启用集概念，因此不会拒绝“在该 workspace 不应使用”的 agent。

## 飞书现状

- `/a` 通过 `/api/internal/agent/agents/list` 拉取候选；
- `/ss`、`/n` 过程中会尝试保留既有 `agentId`，仅以“是否在当前候选列表中”判定可保留性；
- `/a <id|index>` 仅做列表成员校验。

现状影响：飞书行为与 Web 一样，无法体现 workspace 级启用差异。

---

## 方案设计（A 方案）

## 设计原则

- 保持全局 agent 定义不变（单一事实源）；
- workspace 仅存“启用子集”配置，不复制 agent 详情；
- 默认行为兼容历史：未配置 workspace 时 = 全部启用；
- 过滤口径统一下沉到后端，Web/飞书不各自实现业务规则。

## 数据模型

建议新增 workspace 级配置键（可沿用 workspace settings 的 map 组织方式）：

- `workspace_agent_enablement_v1`

建议结构：

```json
{
  "workspaces": {
    "<workspaceId>": {
      "enabledAgentIds": ["agent_a", "agent_b"],
      "updatedAt": 1760000000000
    }
  }
}
```

字段语义：

- `enabledAgentIds`：该 workspace 的启用子集（仅存 agent id）。
- `updatedAt`：配置更新时间。

默认规则（关键）：

- `enabledAgentIds` 缺失 / `null`：表示**默认全部启用**（继承全局全集）；
- `enabledAgentIds: []`：表示该 workspace 显式“全不选”（无可用 agent）；
- `enabledAgentIds: [x, y]`：表示显式启用子集；
- 读取时需自动忽略“已不存在的全局 agent id”（脏数据容错）。

## 可用 Agent 计算规则

定义统一函数（服务层）：

`listWorkspaceAvailableAgents(workspaceId, surface)`

计算流程：

1. 取全局候选：`listAvailableAgentsForSurface(surface)`；
2. 取 workspace 配置：`enabledAgentIds`；
3. 规则：
   - 未配置（`null/undefined`）=> 返回全局候选；
   - 已配置 => 返回 `id ∈ enabledAgentIds` 的子集；
4. 结果排序保持现有规则：`order asc`，再 `name`。

> 这样可保证 Web 与飞书拿到一致结果。

## 接口建议

### 1) Workspace 配置读写（Web 管理用）

- `GET /api/workspaces/:workspaceId/agent-enablement/settings`
  - 返回：`{ workspaceId, mode, enabledAgentIds, agents, updatedAt }`
  - 其中 `mode` 可为：`"all" | "subset"`（便于前端表达默认态）

- `PUT /api/workspaces/:workspaceId/agent-enablement/settings`
  - 请求：`{ mode: "all" | "subset", enabledAgentIds?: string[] }`
  - 语义：
    - `mode=all`：清空该 workspace 的显式子集配置（回到默认全部启用）；
    - `mode=subset`：按 `enabledAgentIds` 持久化；允许空数组表示“全不选”。

### 2) 可用 Agent 列表（Web/飞书统一消费）

- 复用/增强：`POST /api/internal/agent/agents/list`
  - 入参保留 `workspaceId`，并实际参与过滤；
  - `surface` 从“固定 user”改为“显式读取并校验，默认 user”。

- 可选补充（Web 非 internal 调用）：
  - `GET /api/workspaces/:workspaceId/agents/available?surface=user`

### 3) 运行时校验（强一致）

在 send / compact / 触发 run 的路径中，增加：

- 若传入 `agentId`，必须属于 `listWorkspaceAvailableAgents(workspaceId, surface)`；
- 否则返回 `400 AGENT_DISABLED_IN_WORKSPACE`；
- 若未传 `agentId`，fallback 应选择“workspace 可用集中的第一个”，而非全局第一个。

## 前端交互设计（Web）

入口建议：Workspace 内 Agent 面板增加“Agent 启用管理”（弹窗/抽屉）。

交互要点：

- 列表展示全局 agent（含 name/id/scope/模型摘要）；
- 勾选表示该 workspace 启用；
- 提供“全选 / 全不选”快捷动作；
- 保存时提示影响范围：会影响当前 workspace 的 Web 与飞书 `/a` 候选集；
- 若当前会话已选 agent 被禁用：
  - 会话内显示 warning；
  - 自动回退到当前可用集首项（若存在）；
  - 若无可用项，输入框禁用并展示 `noAgentHint`。

## 飞书适配

适配点：

1. `/a` 列表直接使用后端过滤后的 workspace 可用集；
2. `/ss` 与 `/n` 的“保留旧 agent”逻辑继续沿用，但依据新候选集；
3. 若绑定中 agent 因配置变化失效：
   - 下次 `/st` 或发送消息时提示“当前 agent 已在该 workspace 停用，请重新 /a 选择”；
4. 当候选为空时：
   - `/a` 返回“无可用 agent（该 workspace 当前未启用任何 agent）”；
   - 普通消息触发前置拦截。

## 运行时校验与错误码建议

新增/复用错误码：

- `AGENT_DISABLED_IN_WORKSPACE`：请求 agent 在该 workspace 不可用；
- `AGENT_NO_AVAILABLE_IN_WORKSPACE`：workspace 启用集为空且无 fallback。

错误语义：

- 前端收到 `AGENT_DISABLED_IN_WORKSPACE`：清理会话选中值并提示用户重选；
- 飞书收到对应错误：回复指引文案（`请使用 /a 重新选择 agent`）。

---

## 全选 / 全不选设计

## 语义定义

- **全选**：回到“默认全部启用”语义，建议实现为 `mode=all`（不落具体 ID 列表）；
- **全不选**：`mode=subset + enabledAgentIds=[]`。

## 采用该语义的原因

- “全选=默认态”可让后续新增全局 agent 自动在 workspace 生效，减少维护成本；
- 显式保存全量 ID 会导致新增 agent 在历史 workspace 默认不可用，不符合“默认全部启用”；
- “全不选”需可表达，因此保留空数组作为显式关闭态。

## UI 反馈建议

- 顶部状态标签：
  - `默认（全部启用）`
  - `已自定义（N/M 启用）`
- 点击“恢复默认”即等价于“全选并切回 mode=all”。

---

## 兼容性与风险

| 维度 | 影响 | 处理策略 |
|---|---|---|
| 历史数据 | 旧 workspace 无配置 | 读取时默认 `mode=all`，零迁移可用 |
| 新增全局 agent | 自定义子集 workspace 默认不包含 | 属于预期；在 UI 提示“当前为自定义子集” |
| 当前会话选中失效 agent | 发送失败/体验抖动 | 前端与飞书在刷新时尽早发现并提示重选 |
| 多端一致性 | Web 与飞书口径不一致风险 | 统一后端过滤函数，客户端不自定义规则 |
| 误操作（全不选） | workspace 无可用 agent | 保存前二次确认 + 明确风险提示 |

---

## 验收标准 / 测试建议

## 功能验收标准

1. 未配置 workspace agent 启用集时：
   - Web 与飞书 `/a` 均展示该 surface 下的全局 agent；
2. 配置子集后：
   - Web 候选与飞书 `/a` 同步收敛到子集；
3. 设为全不选后：
   - Web 不可发送并提示无可用 agent；
   - 飞书 `/a` 返回无可用 agent；
4. 运行时强校验生效：
   - 手工传入禁用 agent 会返回 `AGENT_DISABLED_IN_WORKSPACE`；
5. 全选恢复默认后：
   - 行为回到“全部启用”，且后续新增全局 agent 可自动出现。

## 测试建议

### 后端

- 单测：
  - `listWorkspaceAvailableAgents` 在 all/subset/empty 三种模式下的返回；
  - 脏数据（不存在 id）过滤；
  - fallback 逻辑改为 workspace 维度。
- 集成：
  - `/api/internal/agent/agents/list` 返回符合 workspace 配置；
  - send/compact 路径对禁用 agent 报错符合预期。

### Web

- 组件测试：
  - 管理弹窗勾选、全选/全不选、恢复默认；
  - 会话已选 agent 失效后的回退与提示。
- E2E：
  - 在同一全局 agent 配置下，不同 workspace 显示不同候选。

### 飞书

- 命令流测试：`/ws` + `/ss` + `/a` + 发送消息；
- 场景测试：绑定后修改 workspace 启用集，验证 `/a` 与发送错误提示。

---

## 后续可扩展方向（仅简述）

- B 方案：workspace 级“默认 agent”与回退策略；
- C 方案：agent 集合模板（preset）与一键切换；
- 审计能力：记录 workspace agent 配置变更历史；
- 权限能力：按角色限制“可见/可启用”的 agent。

---

## 实施取舍说明

1. **可用集过滤下沉到后端**，而不是在 Web/飞书分别过滤。  
   取舍原因：保证口径一致，降低客户端分叉与回归成本。

2. **全选采用“恢复默认（mode=all）”语义**，而不是保存全量 ID。  
   取舍原因：更符合“默认全部启用”原则，并让新增全局 agent 自动生效。

3. **不在本期引入默认 agent**。  
   取舍原因：默认 agent 会牵涉 UI、飞书与运行时 fallback 决策，超出 A 方案目标。
