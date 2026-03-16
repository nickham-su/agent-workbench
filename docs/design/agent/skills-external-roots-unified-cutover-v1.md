# Skills 功能改造设计/实施方案（统一 external roots，彻底切换）v1

本文档定义基于已确认方向的 Skills 功能改造完整方法，作为后续直接实施的基线。

说明：
- 本文档为新增基线文档，不修改历史文档。
- 本文档只描述设计与实施方案，不包含代码改动。

---

## 1. 背景与目标

### 1.1 背景
当前 Skills 方案经历了两次迭代：
- v1：`builtin + workspace(.awb/skills)` 双 roots
- v1 扩展：新增 repo roots（默认不启用，手动勾选）

现有实现在以下路径可见：
- Prompt 注入与 run 缓存：`apps/api/src/modules/agent/agent.service.ts`
- 外部 repo roots 探测与设置：`apps/api/src/modules/workspaces/workspace.service.ts`
- skill 工具解析：`apps/agent-worker/src/runtime/fileTools.ts`
- 前端管理入口：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`

### 1.2 已确认目标
1. 去掉 `<workspaceRoot>/.awb/skills`，不做兼容，直接彻底切换。
2. 保留 builtin skills 且默认启用。
3. 外部 roots 统一由前端管理，来源含：
   - workspaceRoot 下一级目录名包含 `skill` 的目录
   - 各 repo 下一级目录名包含 `skill` 的目录
4. 新命名空间：
   - `builtin/...`
   - `workspace/<rootDir>/...`
   - `repo/<repoId>/<rootDir>/...`
5. 外部 roots 默认不启用。
6. 前端入口命名改为通用名称，采用 `External Skill Roots`。
7. 候选显示由目录是否存在决定；顶级 skill 数量仅展示，可为 0。
8. 不修改历史文档（另起新文档管理迭代）。

---

## 2. 现状与问题

### 2.1 现状
- API 仍包含 `WORKSPACE_SKILLS_ROOT = ".awb/skills"` 并参与 prompt 注入。
- skill 工具仍接受 `ws/...` 前缀（`runSkillTool`）。
- 外部 roots 的 detect/settings 接口与 shared contracts 是 repo-centric 结构（依赖 `repoId + relativePath`）。
- 前端入口与文案仍是 “Repo skills roots”。

### 2.2 核心问题
1. 外部 roots 管理模型不统一：workspace `.awb/skills` 是“隐式固定 root”，repo roots 是“显式可选 root”。
2. 命名空间语义不一致：`ws/...` 与 `repo/...` 并存且来源策略不同。
3. 前端可视化信息不足：只展示路径，不展示每个 root 下可用顶级 skill 的规模。
4. 当前 detect/settings 数据结构无法自然表达 workspaceRoot 候选项。

---

## 3. 范围 / 非目标

### 3.1 本期范围
- 移除 `.awb/skills` 作为固定 root。
- 引入 workspaceRoot 候选 roots 探测，并与 repo 候选统一管理。
- 命名空间切换到 `workspace/...`（删除 `ws/...`）。
- detect 列表增加 `topLevelSkillCount` 并在前端展示。
- 前端入口更名为 `External Skill Roots`。
- 完整更新 API/shared/worker/web/tests 以匹配新模型。

### 3.2 非目标
- 不做向后兼容（不保留 `ws/...`）。
- 不做自动启用（探测到仍默认不启用）。
- 不做复杂权限系统。
- 不做历史文档回写。
- 不做同 run 动态刷新（沿用 run 静态缓存语义）。

---

## 4. 目标模型（roots、命名空间、默认启用规则）

### 4.1 roots 分类
1. builtin root（固定）：`<repoRoot>/skills`
2. external roots（可选）：
   - workspace 来源：`<workspaceRoot>/<rootDir>`
   - repo 来源：`<workspaceRoot>/<repoDir>/<rootDir>`

### 4.2 命名空间
- builtin：`builtin/...`
- workspace external：`workspace/<rootDir>/...`
- repo external：`repo/<repoId>/<rootDir>/...`

### 4.3 默认启用规则
- builtin：默认启用（始终有效）
- external（workspace/repo）：默认不启用，仅由用户勾选后生效

### 4.4 生效语义
- 外部 roots 设置变更仅影响后续新 run。
- 当前 run 不刷新（继承 runPromptStaticCache 语义）。

---

## 5. 探测规则与排序规则

### 5.1 探测范围
1. workspace 层：扫描 `<workspaceRoot>` 一级子目录。
2. repo 层：扫描每个 repo 根目录一级子目录。

### 5.2 命中规则（workspace/repo 一致）
- 仅一级目录（单段目录名）。
- 目录名包含 `skill`（大小写不敏感）。
- 必须存在、是目录、非 symlink。
- 真实路径必须在允许边界内：
  - workspace 候选需在 workspace root 内
  - repo 候选需在对应 repo root 内，且 repo root 本身已通过 inside-workspace 与非 symlink 防护

### 5.3 排序规则
detect 响应按以下顺序返回：
1. workspace 来源候选（统一在最前）
2. repo 来源候选（按 `displayName` 字典序）

> 注：如果 workspace 命中多个目录，全部置于 repo 候选前，并按目录名排序。

---

## 6. 顶级 skill 数量定义与展示规则

### 6.1 定义
`topLevelSkillCount` 定义为：
- 与现有 top-level skill 摘要扫描同口径：仅统计候选 root 下一级子目录型 skill 节点。
- 命中条件：一级子目录 + 子目录内存在非 symlink `SKILL.md` 文件。
- 不统计 root 下直系文件（即使 root 下直接有 `SKILL.md` 或其他文件，也不计入）。

该口径需与 prompt 注入使用的 top-level skill 扫描口径一致（复用同一 helper，避免 UI 数量与实际注入口径漂移）。

### 6.2 展示规则
- 列表项始终按“目录是否为合法候选”决定是否显示。
- `topLevelSkillCount` 仅用于展示，可为 `0`。
- 建议 UI 样式：
  - 主标题：`displayName`
  - 副信息：`sourceType + topLevelSkillCount`

---

## 7. 详细改动方案（API / shared / worker / 前端 / 测试）

## 7.1 API（`apps/api`）

### A. Prompt 注入改造（`modules/agent/agent.service.ts`）
1. 删除 workspace 固定 root：
   - 移除 `WORKSPACE_SKILLS_ROOT` 常量与扫描逻辑。
   - 不再注入 “Top-level workspace skills”（旧语义）。
2. skill 工具说明更新：
   - 从 `builtin/... or ws/... or repo/...` 改为 `builtin/... or workspace/... or repo/...`。
3. external roots 注入：
   - 由新的 enabled external roots 列表驱动（包含 workspace + repo 两种来源）。
4. PromptContext 回传：
   - 将当前 `repoSkillRoots` 替换为可表达两种来源的 `externalSkillRoots`（见第 8 节）。

### A2. PromptContext 路由 schema 同步（`modules/agent/agent.routes.ts`）
- 必须同步修改 `/api/internal/agent/prompt-context` 的响应 schema：字段从 `repoSkillRoots` 切换为 `externalSkillRoots`，确保 routes schema 与 service/worker 一致。

### B. workspace 模块改造（`modules/workspaces/workspace.service.ts`）
1. 将现有 repo-only 探测升级为 external roots 探测：
   - 在现有 `detectWorkspaceRepoSkillsRoots` 逻辑基础上，增加 workspaceRoot 扫描。
2. 设置存储结构升级：
   - 由 repo-only `workspace_repo_skills_roots_v1` 升级为 external roots 新 key（建议 `workspace_external_skill_roots_v2`）。
   - 由于不做兼容，可直接切换到新 key，并移除旧 key 读取路径。
3. settings 校验升级：
   - 校验输入 root 必须命中 detect 候选集合。
   - workspace/repo 两类都要通过“存在、目录、非 symlink、inside 边界”校验。
4. 封装公共扫描 helper：
   - 抽取 top-level skill 扫描 helper，供 prompt 与 detect 复用。

### C. workspaces routes（`modules/workspaces/workspaces.routes.ts`）
- 直接切换为新 URL：
  - `GET /api/workspaces/:workspaceId/external-skill-roots/detect`
  - `GET /api/workspaces/:workspaceId/external-skill-roots/settings`
  - `PUT /api/workspaces/:workspaceId/external-skill-roots/settings`

## 7.2 shared contracts（`packages/shared/src/contracts`）

### A. `workspaces.ts`
当前 `WorkspaceRepoSkillsRoot*` 系列需升级为 external roots 通用结构（见第 8 节）。
建议新增而非复用旧命名，避免语义污染。

### B. `agent.ts`（如有 PromptContext schema）
- 本期**必改项**是 `apps/api/src/modules/agent/agent.routes.ts` 的 `/api/internal/agent/prompt-context` 响应 schema。
- `packages/shared/src/contracts/agent.ts` 是否补充对应 PromptContext schema，不作为本期落地依赖项（可后续单独演进）。

## 7.3 worker（`apps/agent-worker`）

### A. `runtime/fileTools.ts::runSkillTool`
1. 删除 `ws` 分支。
2. 新增 `workspace` 分支，解析 `workspace/<rootDir>/...`。
3. 保留 `builtin` 与 `repo`，并更新报错文案：
   - `skill.id must start with builtin/ or workspace/ or repo/`
4. 参数映射：
   - 从 `repoSkillRoots` 升级为 `externalSkillRoots`（workspace/repo 两类）。

### B. `runtime/tools/providers/builtin.ts`
- 调用 `runSkillTool` 的参数字段改为新结构。

### C. `runtime/apiClient.ts`
- PromptContext 类型字段由 `repoSkillRoots` 升级为 `externalSkillRoots`。

## 7.4 前端（`apps/web`）

### A. AgentClientPane（`features/.../AgentClientPane.vue`）
1. 入口命名与文案改为 `External Skill Roots`。
2. 列表项结构升级：支持 workspace/repo 两类候选。
3. 列表展示 `topLevelSkillCount`。
4. 排序：workspace 候选在前，repo 候选在后。
5. 保存 payload 使用新 settings 输入结构。

### B. API 封装（`shared/api/api.ts`）
- `detect/get/update` 方法迁移到 external skill roots 命名与新类型。

### C. i18n
- 更新 `zh-CN.ts` / `en-US.ts`：
  - 标题、提示文案改为 external roots 语义
  - 增加数量展示文案与来源标签文案

## 7.5 测试

### API
- `apps/api/src/modules/agent/agent.integration.test.ts`
  - 去掉 `ws/...` 断言
  - 增加 `workspace/...` 与 `repo/...` 注入断言
- `apps/api/src/modules/workspaces/workspace.service.test.ts`
  - 覆盖 workspace 候选探测、置前排序、count=0 展示
  - 覆盖 settings 输入校验与非法候选拒绝

### worker
- `apps/agent-worker/src/runtime/fileTools.test.ts`
  - 删除 `ws/...` 用例，替换为 `workspace/...`
  - 覆盖三类命名空间解析、错误文案、映射缺失错误
- `apps/agent-worker/src/runtime/runner.skill-output.test.ts`
  - 同步更新示例 id

### web
- 如有组件测试，增加：
  - workspace 候选置前
  - 数量展示（含 0）
  - detect 失败时禁用保存（沿用当前行为）

---

## 8. detect/settings 接口结构建议

以下为建议结构（以 shared contracts 为准）。

### 8.1 Detect

```ts
GET /api/workspaces/:workspaceId/external-skill-roots/detect

response = {
  workspaceId: string,
  items: Array<{
    sourceType: "workspace" | "repo",
    // sourceType=repo 时必填
    repoId?: string,
    repoDirName?: string,

    // 候选根目录名（一级目录）
    rootDir: string,

    // 展示用
    displayName: string,

    // 顶级 skill 数量（可为 0）
    topLevelSkillCount: number,

    // 是否已启用（由 settings 回填）
    enabled: boolean
  }>,
  updatedAt: number
}
```

字段约束：
- `rootDir` 必须是单段目录名，且命中 `*skill*`。
- `displayName`：
  - workspace 候选建议为 `<rootDir>` 或 `workspace/<rootDir>`
  - repo 候选建议为 `<repoDirName>/<rootDir>`

### 8.2 Settings

```ts
GET /api/workspaces/:workspaceId/external-skill-roots/settings

response = {
  workspaceId: string,
  enabledRoots: Array<{
    sourceType: "workspace" | "repo",
    repoId?: string,
    rootDir: string,
    enabledAt: number
  }>,
  updatedAt: number
}
```

说明：settings 持久化建议以 identity 字段为准（`sourceType + repoId? + rootDir`），`displayName` 不作为强依赖持久化字段。

```ts
PUT /api/workspaces/:workspaceId/external-skill-roots/settings

request = {
  enabledRoots: Array<{
    sourceType: "workspace" | "repo",
    repoId?: string,
    rootDir: string
  }>
}

response: 同 GET settings
```

校验规则：
- 每个 enabled item 必须命中 detect 候选集合。
- `sourceType=workspace`：`repoId` 不允许出现。
- `sourceType=repo`：`repoId` 必填。
- 去重 key：
  - workspace：`workspace\u0000<rootDir>`
  - repo：`repo\u0000<repoId>\u0000<rootDir>`

---

## 9. Prompt 注入与 skill 工具解析规则

### 9.1 Prompt 注入
- 注入三段摘要：
  1. Top-level builtin skills
  2. Top-level enabled workspace external skills
  3. Top-level enabled repo external skills
- 注入项字段仍为 `id + name + description`。
- 不暴露真实路径。
- run 静态缓存语义不变：同 run 不刷新，time/timezone 继续实时更新。

### 9.2 skill 工具解析
输入 `id` 解析：
1. `builtin/...` -> `<repoRoot>/skills`
2. `workspace/<rootDir>/...` -> 从 `externalSkillRoots(sourceType=workspace, rootDir)` 映射
3. `repo/<repoId>/<rootDir>/...` -> 从 `externalSkillRoots(sourceType=repo, repoId, rootDir)` 映射

统一要求：
- 仅逻辑 id，不返回物理路径。
- skill/file 判定、children 规则、读取限制（二进制/50KB/长行截断）保持现有策略。

---

## 10. 错误处理与安全约束

### 10.1 错误处理
- detect 阶段：
  - 单个候选异常（权限/损坏）不应导致全量失败；记录日志并跳过。
- settings 阶段：
  - 非法候选直接 400。
- worker skill 解析：
  - 非法前缀、映射不存在、越界访问，返回脱敏错误信息。

### 10.2 安全约束
- 目录候选必须是目录且非 symlink。
- 路径安全基于“归一化 + inside 校验 + realpath 校验”，不依赖字符串黑名单。
- 不暴露真实磁盘路径到模型输出。
- 输入路径必须是相对路径语义，拒绝绝对路径与 `..`。

---

## 11. 验收标准

### 11.1 功能验收
1. `.awb/skills` 不再被扫描注入。
2. `ws/...` 不再可用；`workspace/...` 可用。
3. builtin skills 默认可用。
4. external roots（workspace/repo）默认不启用。
5. detect 列表包含 workspace 候选与 repo 候选，workspace 在前。
6. 每个候选展示 `topLevelSkillCount`，允许 0。
7. settings 保存后仅影响后续新 run。

### 11.2 安全验收
1. symlink 候选不可启用。
2. 越界路径不可启用不可读取。
3. skill 工具错误信息不泄露真实路径。

### 11.3 回归验收
1. builtin/read/write/apply_patch 等现有工具行为不回归。
2. prompt 静态缓存行为不回归。
3. repo skills 既有启用流与保存流在新模型下可用。

---

## 12. 实施步骤建议

建议按以下顺序实施：

### Step 1：shared contracts 先行
- 定义 external roots detect/settings 新 schema 与类型。
- 注：PromptContext schema 的本期强依赖在 API routes（见 Step 3）。

### Step 2：API workspace 模块
- 实现 workspace + repo 统一探测。
- 返回排序与 `topLevelSkillCount`。
- 实现 settings 新结构校验与持久化。

### Step 3：API prompt 组装
- 去掉 `.awb/skills` 注入。
- 接入 enabled external roots 扫描。
- 更新 skill tool 说明文案。
- 同步修改 `apps/api/src/modules/agent/agent.routes.ts`：
  - `/api/internal/agent/prompt-context` 响应 schema 字段从 `repoSkillRoots` 切换为 `externalSkillRoots`。

### Step 4：worker skill 解析
- 删除 `ws` 分支，新增 `workspace` 分支。
- 改造上下文映射字段。
- 更新错误文案。

### Step 5：前端交互
- 入口改名为 `External Skill Roots`。
- 列表展示来源与数量。
- 保存调用切换到新接口结构。

### Step 6：测试
- 按 API/worker/web 分层补齐用例。
- 覆盖 count=0、workspace 置前、非法候选拒绝。

### Step 7：联调与验收
- 跑通 detect -> 勾选 -> 新 run prompt 注入 -> skill 调用闭环。
- 完成验收清单。

---

## 附录：主要参考实现位置（现状）

- Prompt 组装：`apps/api/src/modules/agent/agent.service.ts`
- external roots 探测/设置（当前 repo-only）：`apps/api/src/modules/workspaces/workspace.service.ts`
- workspace routes：`apps/api/src/modules/workspaces/workspaces.routes.ts`
- skill 解析：`apps/agent-worker/src/runtime/fileTools.ts`
- worker provider：`apps/agent-worker/src/runtime/tools/providers/builtin.ts`
- worker prompt context：`apps/agent-worker/src/runtime/apiClient.ts`
- 前端弹窗：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
- 前端 API：`apps/web/src/shared/api/api.ts`
- i18n：`apps/web/src/shared/i18n/locales/zh-CN.ts`、`apps/web/src/shared/i18n/locales/en-US.ts`
- shared contracts：`packages/shared/src/contracts/workspaces.ts`
