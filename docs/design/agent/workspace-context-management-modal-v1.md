# Workspace 上下文管理弹窗：统一入口（AGENTS + Skills）方案 v1

> 目标：将 **AGENTS.md** 与 **Skills（external skill roots）** 的探测结果与启用设置，统一收敛到同一个 workspace 级“上下文管理（Context Management）”弹窗入口中。
>
> 关键约束：**前端统一入口、分组展示；后端保持分域实现；首版由前端聚合多个接口**。

---

## 一、背景与现状

### 1. 当前已存在的两类“会影响 agent 行为的 workspace 上下文来源”

1) **Workspace `AGENTS.md`（指令型上下文）**

- 现状（已实现）：
  - 仅支持 `<workspaceRoot>/AGENTS.md`
  - 文件存在即自动注入 system prompt（`workspace_instructions`）
  - 读取策略：不存在忽略、非普通文件/软链忽略、二进制忽略、32KB 截断
- 相关设计文档：
  - `docs/design/agent/system-prompts-v1.md`
  - `docs/design/agent/system-prompt-assembly-rework-v1.md`

2) **Skills（能力/知识型上下文）**

- 现状（已实现）：
  - builtin skills root：`./skills`
  - workspace skills root：`<workspaceRoot>/.awb/skills`
  - external skill roots（可选启用，opt-in）：通过探测候选 + settings 持久化 + 启用后参与 system prompt skills summary 与 skill tool 映射
  - runId 级缓存：同 run 内不感知变更（包括 AGENTS.md 与 skills 变更）
- 相关设计文档：
  - `docs/design/agent/skills-dual-roots-and-run-cache-v1.md`
  - `docs/design/agent/skills-repo-roots-optional-v1.md`
  - `docs/design/agent/skills-external-roots-unified-cutover-v1.md`

### 2. 当前前端入口割裂

在 Agent 页面（`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`）中，目前存在多个分散入口（例如 external skill roots 管理按钮）。

问题：
- 用户难以在一个地方回答“当前 workspace 到底启用了哪些上下文来源？”
- `AGENTS.md` 当前是“隐式生效”（文件存在即注入），缺少显式可控与可观测性
- 多 repo workspace 已是常态（参考：`docs/design/多仓工作区（Multi-Repo Workspace）方案.md`），但 `AGENTS.md` 不支持 repo 级候选与按需启用

---

## 二、目标

### 1) 功能目标

- 支持探测两级 `AGENTS.md` 候选：
  - `<workspaceRoot>/AGENTS.md`
  - `<repoRoot>/AGENTS.md`（workspace 下每个已挂载 repo）
- **默认不启用**：探测到候选 ≠ 自动注入
- 用户手动启用后：
  - 才将对应 `AGENTS.md` 内容嵌入 system prompt
  - 仅影响后续新 run（沿用 runId 级缓存语义）

### 2) 交互目标

- 将 **AGENTS（指令型）** 与 **Skills（能力型）** 的探测结果和设置入口，合并到同一个 workspace 级弹窗：
  - **统一入口**：一个按钮/入口
  - **分组展示**：按“指令上下文 / Skills”分组
  - **后端分域**：AGENTS 与 skills 各自独立 detect/settings API 与 settings key
  - **首版前端聚合**：弹窗打开时并发请求多个接口，前端合并渲染（不强制新增后端聚合 API）

### 3) 工程目标

- 最小改动、可回滚：复用已有 external skill roots 模式
- 不破坏现有 run 静态缓存机制（`runPromptStaticCache`）
- 强化可解释性：UI 与 prompt 中均能看到来源（displayPath）

---

## 三、非目标

- 不做目录级递归规则（例如 repo 任意子目录的 `AGENTS.md`）
- 不做 include 语法、结构化解析（AGENTS 按纯文本处理）
- 不做同 run 的动态刷新（启用设置/文件变化不影响当前 run）
- 不做“统一后端聚合接口”（v1 首版不强制）
- 不做在线编辑 AGENTS 内容（弹窗只管理“启用来源”，不编辑文件）

---

## 四、为什么采用“统一入口、分组展示、后端分域、前端聚合”

### 1) 统一入口：提升可发现性与可控性

AGENTS 与 Skills 虽实现不同，但在用户心智中同属：

- “会影响 agent 行为的 workspace 上下文来源”

统一入口能让用户在一个地方完成：
- 发现候选
- 查看当前启用状态
- 做启用/关闭决策

### 2) 分组展示：保持语义边界，避免误解

- `AGENTS.md` 是 **指令型**（直接进入 system prompt）
- Skills 是 **能力型**（影响可用技能摘要与 skill tool 可读范围）

混排会造成：
- 用户误以为两者同质（例如以为 AGENTS 也像 skills 一样按需加载内容）
- 难以解释“启用后到底影响 prompt 还是影响可用能力”

因此 v1 采用“统一入口 + 分组展示”最清晰。

### 3) 后端分域：降低耦合，保持演进自由

AGENTS 与 external skill roots 具备不同：
- 探测规则不同（文件 vs 目录 root）
- 注入点不同（system prompt 直接文本 vs skills summary + tool 映射）
- 安全边界/约束不同

后端强行统一数据模型/接口，会导致：
- 过早抽象、实现复杂度提升
- 后续演进（例如 skills v2）被绑定

因此保持后端分域更稳。

### 4) 前端聚合：首版最快落地且风险最低

v1 只需：
- 新增 AGENTS 的 detect/settings API
- 前端弹窗打开时并发请求：AGENTS + external skill roots

无需引入新的后端聚合层，也不改变已有 skills API 契约。

---

## 五、用户流程与交互方案（Web）

### 1) 入口

- 在 Agent 页面输入区工具栏保留一个统一入口按钮：
  - 文案/tooltip：`上下文管理`（或 `Workspace Context`）
  - 建议 icon：沿用 `AppstoreOutlined` 或使用更语义化的“层/堆叠”图标（实现细节不影响协议）

> v1 建议：**将现有 external skill roots 管理按钮升级为“上下文管理”按钮**，避免入口增多。

### 2) 弹窗结构（分组）

弹窗标题：`上下文管理`

- 分组 A：`指令上下文（AGENTS.md）`
  - 候选列表（checkbox 多选）：
    - `AGENTS.md`（workspace）
    - `<repoDirName>/AGENTS.md`（repo）
  - 说明：启用后会注入 system prompt（对新 run 生效）

- 分组 B：`Skills（外部 roots）`
  - 候选列表（checkbox 多选）：external skill roots detect 返回项
  - 说明：启用后会参与 skills 摘要注入与 skill tool 可读范围（对新 run 生效）

- 弹窗底部统一提示：
  - “保存成功后通常仅对后续新 run 生效（同 run 静态缓存不刷新）”

### 3) 交互与状态

- 打开弹窗：并发请求
  - AGENTS detect（含 enabled 叠加）
  - external skill roots detect（含 enabled 叠加）
- 用户勾选/取消勾选
- 点击保存：分别调用两个 settings 更新接口（后端分域）
  - 任一保存失败：提示失败原因，不自动回滚另一个域（v1 简化策略；可在 v2 做事务化）

---

## 六、后端方案（API）

### 1) 现有 external skill roots（保持不变）

- settings key（已存在）：`workspace_external_skill_roots_v1`
- routes（已存在）：
  - `GET /api/workspaces/:workspaceId/external-skill-roots/detect`
  - `GET /api/workspaces/:workspaceId/external-skill-roots/settings`
  - `PUT /api/workspaces/:workspaceId/external-skill-roots/settings`

### 2) 新增 AGENTS instructions 分域（v1 新增）

#### 2.1 探测范围

候选仅来自两类固定位置：
- workspace：`<workspaceRoot>/AGENTS.md`
- repo：对 workspace 已挂载 repo 列表（`listWorkspaceRepos`）逐个检查 `<repoRoot>/AGENTS.md`

> 说明：repoRoot 以 workspace 维护的 repo path 为准，不通过 git 推断。

#### 2.2 默认不启用（opt-in）

- 探测接口返回候选时，必须叠加 settings 中的启用列表
- settings 缺失时：视为“全部未启用”

#### 2.3 settings key（建议）

- `workspace_agents_instructions_v1`

#### 2.4 routes（建议）

- `GET /api/workspaces/:workspaceId/agents-instructions/detect`
  - 返回：候选列表（含 enabled）

- `GET /api/workspaces/:workspaceId/agents-instructions/settings`
  - 返回：已保存启用项

- `PUT /api/workspaces/:workspaceId/agents-instructions/settings`
  - 保存：覆盖式更新（只存 enabled 列表）

命名风格与 external skill roots 保持一致，便于前端聚合。

---

## 七、数据模型与持久化

### 1) AGENTS 候选项（detect response）

建议字段：

```ts
export type WorkspaceAgentsInstructionCandidate = {
  sourceType: "workspace" | "repo";
  repoId?: string;        // sourceType=repo 时必填
  repoDirName?: string;   // 展示用（可选）
  displayPath: string;    // 展示用："AGENTS.md" / "<repoDirName>/AGENTS.md"
  enabled: boolean;
};

export type WorkspaceAgentsInstructionsDetectResponse = {
  items: WorkspaceAgentsInstructionCandidate[];
};
```

### 2) AGENTS settings（持久化结构）

仅存“启用项标识”，不存绝对路径：

```ts
export type WorkspaceAgentsInstructionSourceKey =
  | { sourceType: "workspace" }
  | { sourceType: "repo"; repoId: string };

export type WorkspaceAgentsInstructionsSettings = {
  enabledSources: WorkspaceAgentsInstructionSourceKey[];
  updatedAt: number;
};
```

### 3) external skill roots settings（沿用既有）

- `workspace_external_skill_roots_v1`
- 不在本方案中变更其结构

---

## 八、接口建议（shared contracts）

新增 contracts（示例文件，需按仓库实际组织）：
- `packages/shared/src/contracts/workspaces.ts`

建议新增 schema：
- `WorkspaceAgentsInstructionsDetectResponseSchema`
- `WorkspaceAgentsInstructionsSettingsResponseSchema`
- `UpdateWorkspaceAgentsInstructionsSettingsRequestSchema`

请求示例：

```json
{
  "enabledSources": [
    { "sourceType": "workspace" },
    { "sourceType": "repo", "repoId": "repo_xxx" }
  ]
}
```

---

## 九、system prompt 注入与缓存/生效时机

### 1) 注入规则（v1）

- 仅注入 **enabled 的 AGENTS sources**
- 注入为一个或多个 section，建议 section 标签保持可解释性：
  - `[agents_instructions] AGENTS.md`
  - `[agents_instructions] <repoDirName>/AGENTS.md`

> 注：仓库现有 system prompt section 格式已在 `system-prompt-assembly-rework-v1.md` 中定义；本方案只要求“来源可追溯”，具体 section 容器格式遵循现行标准。

### 2) 读取策略

- 复用既有 `AGENTS.md` 读取安全策略：
  - ENOENT 忽略
  - 非普通文件/软链忽略
  - 二进制忽略
  - 32KB 截断（UTF-8 安全截断）

### 3) 生效时机（与现有 run 缓存保持一致）

- system prompt 静态部分存在 runId 级缓存（`runPromptStaticCache`）
- 因此：
  - 用户在弹窗保存“启用 AGENTS / 启用 external skill roots”后
  - **仅对后续新 run 生效**
  - 当前 run 不自动刷新（这是既有明确语义，参见 `skills-dual-roots-and-run-cache-v1.md`）

### 4) UI 提示

弹窗必须提示：
- “保存后通常在新对话 / 新 run 生效”

---

## 十、安全与边界约束

### 1) 路径约束

- AGENTS 候选来源仅允许：workspace 根 + repo 根固定路径
- settings 更新时必须校验：
  - `repoId` 属于当前 workspace 已挂载 repo
  - 不接受任意路径输入

### 2) 软链与绕过

- 读取 AGENTS 时继续忽略软链，避免路径绕过
- 探测时若发现候选为软链，也应忽略

### 3) prompt 体积控制

- 单文件 32KB 截断沿用
- v1 可不做总量上限；但应在风险章节明确：多 repo 启用会增大 system prompt

---

## 十一、风险与对策

### 风险 1：行为变更（从自动注入改为手动启用）

- 影响：现有用户习惯“放置 workspace/AGENTS.md 即生效”，升级后若默认不启用会产生落差
- v1 处理策略（建议择一）：
  - 策略 A（严格遵循 opt-in）：默认全部不启用；在弹窗中提供清晰提示与“一键启用 workspace AGENTS”快捷操作
  - 策略 B（迁移缓解）：若 settings 缺失且检测到 `<workspaceRoot>/AGENTS.md`，首次升级时自动写入 enabled（但这不满足“默认不启用”的严格定义）

> 本文档作为 v1 建议基线：**采用策略 A**，严格 opt-in，并通过 UI 降低迁移成本。

### 风险 2：保存后不立刻生效（run 缓存语义）

- 影响：用户误以为保存失败
- 对策：弹窗内明确“新 run 生效”，并在保存成功 toast 中再次提示

### 风险 3：system prompt 体积膨胀

- 影响：token 成本、噪音
- 对策：
  - 单文件 32KB 截断
  - UI 展示“启用项数量”
  - v2 可加入总量上限或优先级排序

### 风险 4：前端聚合保存的部分失败

- 影响：AGENTS 保存成功但 skills 保存失败（或相反）
- v1 对策：分别提示失败；不做事务化回滚
- v2 选项：新增后端聚合接口实现事务化保存

---

## 十二、实施步骤（建议拆分）

### Phase 0：文档与契约

- 新增本设计文档（本文件）
- 增加 shared contracts：AGENTS detect/settings/update schema

### Phase 1：后端（AGENTS 分域）

- `workspace.service.ts`：实现
  - detect workspace + repo `AGENTS.md` 候选
  - get/update settings
- `workspaces.routes.ts`：新增三条路由
- `settings.store.ts`：复用现有 JSON settings 存取

### Phase 2：prompt 注入

- `agent.service.ts`：
  - 在构建静态 prompt 时读取 enabled AGENTS sources 并注入
  - `buildSystemPrompt` 支持注入多条 agents instructions section（或将多条合并为一个 section，需保留来源 label）

### Phase 3：前端（统一弹窗）

- `AgentClientPane.vue`：
  - 将 external skill roots 管理入口升级为“上下文管理”入口
  - 弹窗内分组展示：AGENTS + Skills
  - 打开弹窗并发调用：
    - `/agents-instructions/detect`
    - `/external-skill-roots/detect`
  - 保存时分别 PUT 两类 settings

### Phase 4：测试与验收

- API 集成测试：
  - detect 返回 enabled 叠加正确
  - settings 缺失默认全 disabled
  - 启用后新 run 生效（结合 runPromptStaticCache 行为测试）

---

## 十三、验收标准

### 1) 探测

- 能探测到：
  - `<workspaceRoot>/AGENTS.md`
  - `<repoRoot>/AGENTS.md`（对 workspace 挂载的每个 repo）
- detect 返回项包含 `enabled`（由 settings 叠加）

### 2) 默认不启用

- settings 缺失时：AGENTS 候选全部 `enabled=false`
- 没有用户启用前：system prompt 不注入任何 AGENTS 内容

### 3) 手动启用后注入

- 用户在“上下文管理”弹窗启用后：
  - 后端 settings 持久化成功
  - 新 run 的 system prompt 包含对应 AGENTS 内容，且来源 label 可追溯

### 4) 统一入口分组展示

- 前端仅一个“上下文管理”入口
- 弹窗内有明确分组：
  - 指令上下文（AGENTS）
  - Skills（external skill roots）

### 5) 缓存语义一致

- 保存设置不影响当前 run
- 新 run 生效

---

## 十四、候选演进（v2+）

- 后端新增聚合接口：`GET/PUT /api/workspaces/:workspaceId/context-sources/*`，用于事务化保存与一次性加载
- 增加总量上限（多 AGENTS 总字节）与 UI 告警
- 增加“仅本次会话启用”能力（session-scoped override）
- 增加更多 workspace 级上下文源（例如 tools/mcp roots）并纳入统一弹窗
