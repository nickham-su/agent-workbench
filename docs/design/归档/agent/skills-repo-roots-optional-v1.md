# Skills 方案规格说明（repo roots 可选启用）v1

本文档定义在现有 Skills v1（双 roots + run 级缓存）基础上，新增“repo skills roots 可选启用”的补充方案。

本文档是对 `agent-workbench/docs/design/agent/skills-dual-roots-and-run-cache-v1.md` 的增量扩展，不推翻原有规格；未在本文显式修改的行为，继续沿用原文档。

本文档强调“规格可执行”，并尽量使用纯文本可读表达，不依赖 Markdown 渲染能力。


一、背景与目标

1. 现状（已实现）
- 当前 Skills roots 只有两类：
  - builtin root：`./skills`
  - workspace root：`<workspaceRoot>/.awb/skills`
- 现有 system prompt 注入与 skill 工具解析，仅覆盖 `builtin/` 与 `ws/` 前缀。
- 实现落点：
  - prompt 组装与 run 级缓存：`apps/api/src/modules/agent/agent.service.ts`
  - worker skill 工具：`apps/agent-worker/src/runtime/fileTools.ts`

2. 新目标（本期新增）
- 新增第三类 roots：repo skills roots。
- repo roots 默认不启用（opt-in），由用户在 workspace 内手动选择启用。
- 启用后参与后续新 run 的 top-level skills summary 与 skill 工具读取。

3. 为什么“前端探测 + 手动启用”，而不是默认纳入
- 降噪：workspace 下 repo 可能很多，且“包含 skill 字样目录”不一定真要给 Agent 使用；默认纳入会显著增大 prompt 噪音。
- 成本：默认纳入会增加每次静态 prompt 构建扫描成本（目录遍历 + SKILL.md 读取）。
- 稳定性：仓库目录常变化（切分支、重建、detach），默认自动纳入会导致行为不可预期。
- 安全与可控：让用户明确选择可暴露给 Agent 的 repo skill roots，符合最小暴露原则。
- 产品语义：与现有“同 run 缓存不刷新”语义匹配，避免“系统自动探测导致行为突然变化”。


二、范围与非目标

1. 本期范围
- 前端（Agent 页面）：
  - 在输入框区域新增 repo skills 管理 icon 按钮。
  - 点击后弹窗探测候选 roots，默认全不选，由用户勾选启用并保存。
- 后端（API）：
  - 新增 workspace 维度 repo skills roots 探测接口。
  - 新增 workspace 维度“已启用 roots”读写接口（持久化）。
- 持久化：
  - 基于 settings 表存储 workspace 维度启用配置。
- Prompt 注入扩展：
  - 将 enabled repo roots 纳入 top-level skills summary 扫描。
- Worker skill 工具扩展：
  - `runSkillTool` 支持新前缀（建议 `repo/`）并可映射到具体 repo root。

2. 非目标（本期不做）
- 不做自动启用（探测到即启用）。
- 不做权限系统细分（按 repo root 或子目录授权）。
- 不做同 run 动态刷新（启用状态/目录变化不影响当前 run）。
- 不做跨 workspace 共享配置。
- 不做复杂排序/打分推荐（仅提供候选与勾选）。
- 不做“扫描全目录深层模糊发现”，仅做 repo 一级目录命中规则。


三、用户流程

1. 入口位置
- 在 AI Agent 页面输入框下方工具区域新增一个 icon 按钮（repo skills roots 管理）。
- 建议落点：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`（输入区在该文件内）。

2. 交互流程
- 用户点击按钮。
- 前端打开弹窗，并调用“探测接口”。
- 弹窗展示候选 repo skills roots 列表（带已保存 enabled 状态）。
- 默认策略：首次无配置时全不选。
- 用户勾选后点击保存。
- 前端调用“更新启用配置接口”。

3. 生效语义
- 保存成功仅影响后续新 run。
- 当前已在运行或已创建的 run 不自动刷新（沿用 run 级静态缓存语义）。


四、探测规则

1. 探测范围
- 针对当前 workspace 下所有已挂载 repo。
- 数据来源建议：`listWorkspaceRepos`（`apps/api/src/modules/workspaces/workspace.store.ts`），可获得 `workspaceId/repoId/dirName/path`。

2. 命中规则（一级目录）
- 对每个 repo 的根目录进行一级目录遍历。
- 若一级子目录名包含 `skill`（大小写不敏感，例如 `skills`、`AI-SkillSet`），判定为候选 repo skills root。
- 本期仅检查一级目录名，不递归命名匹配。

3. 返回字段（至少）
- `repoId`：仓库唯一标识（用于避免冲突）。
- `repoDirName`：该 repo 在 workspace 下的目录名（用于展示）。
- `relativePath`：相对 repo 根目录路径（本期为一级目录名）。
- `displayName`：展示名（建议 `<repoDirName>/<relativePath>`）。
- `enabled`：当前 workspace 配置下是否启用。

4. 异常与类型处理
- repo 目录不存在（ENOENT）：跳过该 repo，不中断整体探测。
- repo 根路径不是目录：跳过。
- 候选路径不是目录：不纳入结果。
- 发现符号链接目录：跳过（不作为候选），避免路径绕过。


五、数据模型与持久化

1. 推荐存储位置
- 使用后端 `settings` 表（`apps/api/src/modules/settings/settings.store.ts`），按 workspaceId 维度组织。
- 理由：
  - 与现有 agent/settings 持久化方式一致。
  - 后端可直接参与 prompt 组装，避免前端状态与后端执行状态不一致。

2. 推荐 key 与 JSON 结构
- 推荐 settings key：`workspace_repo_skills_roots_v1`
- value 建议结构：

{
  "workspaces": {
    "<workspaceId>": {
      "enabledRoots": [
        {
          "repoId": "repo_xxx",
          "relativePath": "skills",
          "enabledAt": 1760000000000
        }
      ],
      "updatedAt": 1760000000000
    }
  }
}

说明：
- `enabledRoots` 仅存用户显式启用项；未出现即视为未启用。
- `relativePath` 采用 repo 相对路径，不存绝对路径。

3. 为什么不建议仅用前端 localStorage
- 多端不一致：不同浏览器/设备无法共享。
- 执行侧不可见：prompt 组装与 worker 执行在后端，localStorage 无法参与。
- 可追溯性差：缺少统一更新时间与服务端审计点。

4. repo 或目录失效后的行为
- repo 被 detach/delete：
  - 配置可保留（惰性清理）或在保存时顺带清理无效项，建议“读时过滤 + 写时清理”。
- 目录被删除：
  - 探测接口不再返回该候选。
  - prompt 组装扫描时跳过，不抛错中断。


六、ID 与 root 方案

1. 新前缀
- 新增命名空间前缀：`repo/`

2. 推荐 id 结构（最终建议）
- 顶级/任意节点统一逻辑 id：
  - `repo/<repoId>/<rootDir>/<...>`

示例：
- `repo/repo_abc123/skills`
- `repo/repo_abc123/skills/deploy`
- `repo/repo_abc123/skills/deploy/template.yaml`

3. 取舍说明
- 不推荐仅用 `repoDirName` 作为主键：同 workspace 历史上可能重名或变更，稳定性弱。
- 推荐使用 `repoId`：
  - 全局唯一、稳定、不受目录重命名影响。
  - 便于后端映射与容错处理。
- `rootDir` 仍保留在 id 中，保证同 repo 下多个候选 roots 可区分。

4. children id 生成
- 与现有 builtin/ws 一致，children 继承父命名空间。
- 子 skill/file 的 id 在父 id 后按相对路径拼接。

5. 路径暴露约束
- 对模型与前端仅暴露逻辑 id，不暴露真实文件系统绝对路径。


七、System Prompt 与缓存语义

1. 注入扩展
- 在现有 `builtin + workspace` 顶级 skills summary 基础上，新增 `repo(enabled)` 来源。
- 注入字段仍保持最小集合：`id + name + description`。
- 参考落点：`apps/api/src/modules/agent/agent.service.ts`
  - 当前函数：`scanTopLevelSkillSummaries`、`buildSkillsInstructionSection`、`getPromptContextForRun`。

2. 同 run 缓存语义保持不变
- 继续沿用 runId 级 `runPromptStaticCache`。
- 同一 run 内：
  - 不感知启用配置变化。
  - 不感知目录变化。
- 仅在后续新 run 生效。

3. 容错语义
- enabled repo root 若目录不存在/不可读：跳过该 root，记录 warn，不中断 system prompt 生成。

4. 与既有 v1 文档关系
- 本文是 `skills-dual-roots-and-run-cache-v1.md` 的补充（v1.x 扩展）。
- 双 roots 与 run cache 基础语义不变，只新增第三类可选 roots。


八、skill 工具扩展

1. 目标
- worker `runSkillTool` 识别并处理 `repo/` 前缀 id。
- 保持与 builtin/ws 同等安全边界。

2. 现状
- 当前 `runSkillTool` 仅接受 `builtin/`、`ws/`（见 `apps/agent-worker/src/runtime/fileTools.ts`）。
- 当前 root 映射来源固定：
  - builtin -> `<repoRoot>/skills`
  - ws -> `<workspacePath>/.awb/skills`

3. 扩展建议
- 新增 repo roots 运行时映射表（逻辑 root -> 真实 rootPath），由后端在 prompt-context 下发，并在 worker 本 run 内缓存使用。
- `runSkillTool` 输入扩展建议：
  - 增加 `repoSkillRoots?: Array<{ repoId: string; rootDir: string; rootPath: string }>` 或等价 Map。
- id 到路径映射：
  - 解析 `repo/<repoId>/<rootDir>/<rest...>`。
  - 在映射表中查找 `(repoId, rootDir)` 对应 rootPath。
  - 再按 `rest` 解析 skill/file。

4. 安全边界（必须与现有一致）
- 继续禁止绝对路径与路径穿越。
- 继续禁止符号链接路径。
- 继续做 realpath inside-root 校验。
- 继续复用文本/二进制判定、大小限制、输出截断约束。


九、后端接口建议

1. 探测接口（推荐在 workspace 模块）
- 路由建议：`GET /api/workspaces/:workspaceId/repo-skills-roots/detect`
- 响应示例：

{
  "workspaceId": "ws_xxx",
  "items": [
    {
      "repoId": "repo_1",
      "repoDirName": "openclaw",
      "relativePath": "skills",
      "displayName": "openclaw/skills",
      "enabled": false
    }
  ],
  "updatedAt": 1760000000000
}

2. 读取/更新启用配置接口
- 建议同样放在 workspace 模块（因为是 workspace 局部配置）。
- 路由建议：
  - `GET /api/workspaces/:workspaceId/repo-skills-roots/settings`
  - `PUT /api/workspaces/:workspaceId/repo-skills-roots/settings`

PUT 请求示例：

{
  "enabledRoots": [
    { "repoId": "repo_1", "relativePath": "skills" },
    { "repoId": "repo_2", "relativePath": "ai-skills" }
  ]
}

PUT 响应示例：

{
  "workspaceId": "ws_xxx",
  "enabledRoots": [
    { "repoId": "repo_1", "relativePath": "skills", "displayName": "openclaw/skills" }
  ],
  "updatedAt": 1760000000000
}

3. 放 workspace 模块而非 settings 模块的原因
- 语义上是 workspace 局部状态，不是全局设置。
- 调用链更短：探测依赖 workspace_repos，天然在 workspace 领域。
- settings 模块可仅承担底层存储 helper（通过 service 间调用或复用 store）。


十、前端交互建议

1. 弹窗行为
- 打开即触发探测请求，展示候选列表。
- 显示加载态、空态、错误态。
- 默认全不选（首次）。
- 已保存配置需回填勾选状态。

2. 保存语义
- 点击保存调用 PUT 接口。
- 成功后 toast：
  - 建议文案："Repo skills 设置已保存，将在后续新运行中生效"。
- 若当前 session 存在运行中的 run：
  - 不自动刷新当前 run。
  - 可在弹窗内给出提示："当前运行不受影响"。

3. UI 性能建议
- 候选较多时支持：
  - 本地搜索（按 repoDirName/relativePath）。
  - 列表虚拟滚动或分页（按实现复杂度择一）。

4. 前端落点建议
- Agent 页面：`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
- API 封装：`apps/web/src/shared/api/api.ts`
- 类型契约：`packages/shared/src/contracts/workspaces.ts`（或新增 workspace-repo-skills 合约文件）


十一、容错与边界

1. repo 被 detach/delete
- 探测接口自动忽略不存在 repo 路径。
- 已启用但失效项在 prompt 注入与工具读取时安全跳过。

2. 目录被删除
- 不报错中断；该项在探测时消失，在 prompt 扫描时跳过。

3. 同名目录冲突
- 不同 repo 下同名 root 通过 `repoId` 隔离，id 不冲突。

4. 符号链接与路径穿越
- 探测阶段：候选目录若为 symlink 则过滤。
- 读取阶段：沿用 `lstat + realpath + isPathInside` 约束，拒绝越界。

5. 大量候选时性能
- 探测仅做一级目录扫描。
- 后端可限制单 repo 返回上限（例如 200）并返回 `truncated` 标记（可选）。
- 前端采用 lazy 渲染/虚拟列表，避免卡顿。


十二、实现落点建议（代码级）

1. 后端 workspace
- 路由：`apps/api/src/modules/workspaces/workspaces.routes.ts`
- 服务：`apps/api/src/modules/workspaces/workspace.service.ts`
- 数据来源：`apps/api/src/modules/workspaces/workspace.store.ts`（`listWorkspaceRepos`）

2. 后端 settings 持久化
- 存储 helper：`apps/api/src/modules/settings/settings.store.ts`
- 结构与校验建议可在 workspace service 内实现，减少跨模块耦合。

3. agent prompt 组装
- `apps/api/src/modules/agent/agent.service.ts`
  - 扩展 `getPromptContextForRun` 的静态构建分支。
  - 在现有 `builtin/workspace` 扫描旁加入 enabled repo roots 扫描。
  - 扩展 `buildSkillsInstructionSection`，加入 repo 分组或统一列表输出。

4. worker skill 工具
- `apps/agent-worker/src/runtime/fileTools.ts`：扩展 `runSkillTool` 支持 `repo/`。
- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`：skill 分支向 `runSkillTool` 传入 repo roots 映射。
- `apps/agent-worker/src/runtime/apiClient.ts` 与 `apps/api/src/modules/agent/agent.routes.ts`：如需在 prompt-context 携带 roots 映射，需同步契约字段。

5. 前端
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`：按钮 + 弹窗交互。
- `apps/web/src/shared/api/api.ts`：新增 detect/get/update 调用。
- `packages/shared/src/contracts/*`：补充请求响应 schema 与类型。


十三、验收要点（最小可验证）

1. 探测结果正确
- 仅当前 workspace 已挂载 repo 参与。
- 仅命中一级目录名包含 skill（大小写不敏感）。
- 目录不存在/非目录/symlink 处理符合预期。

2. 配置持久化正确
- workspace 级启用配置可读可写。
- 切页面/重启后仍可恢复。

3. 新 run prompt 生效
- 启用项可出现在后续新 run 的 top-level skills summary。
- 注入字段仅 `id/name/description`。

4. 当前 run 不变
- 保存后当前 run system prompt 不变（run 缓存语义成立）。

5. skill 工具可读取 repo 前缀 id
- `skill` 工具可正确读取 `repo/...` skill 节点与文件节点。
- children id 生成正确且不冲突。

6. 目录失效时安全跳过
- repo/目录失效不导致 prompt 失败或 worker 崩溃。
- 错误对用户表现可诊断但不过度暴露路径。


附：兼容性与演进建议

- 本文属于 v1 增量，建议命名为 `skills-repo-roots-optional-v1.md`。
- 若后续引入自动发现策略、权限模型或同 run 热刷新，应在 v2 文档中显式升级，不隐式修改本规格。