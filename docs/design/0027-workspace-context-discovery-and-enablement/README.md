# Workspace 内 Skill 与 AGENTS.md 发现及独立启停

> 状态：**待实施（设计基线）**
> 适用范围：agent-workbench 的 workspace 上下文管理
> 本文档不表示代码已经完成，也不要求兼容现有 root/repo 级配置。

## 目标

将当前按 workspace/repo 来源、按外部 Skill root 管理的机制，收敛为以 **workspace 物理根目录** 为唯一边界的一次有界扫描：

- 在 workspace 内完成深度范围内的完整扫描，同时发现 `SKILL.md` 与 `AGENTS.md`；
- Skill 按单个 Skill 的 workspace 相对目录 ID 独立启停；
- `AGENTS.md` 按 workspace 相对文件路径独立启停；
- 只向 Prompt 和 Worker 下发当前候选且启用、并成功完成现有摘要读取的精确 Skill；
- 保留现有文本读取、frontmatter、截断和文件安全读取机制，不重新设计内容加载协议。

## 设计结论速览

| 主题 | 决定 |
|---|---|
| 发现边界 | 仅扫描一次 workspace 根目录；mounted repo 只是普通子目录，不再有 repo 身份或单独扫描。 |
| 完整性 | 扫描仅返回完整快照；`ENOENT`/`ENOTDIR` 竞态跳过，权限或未知 I/O 错误使 detect/PUT 失败，不返回部分候选。 |
| 深度 | 按目标文件父目录的相对路径段数计算，最大为 4。 |
| `AGENTS.md` | 深度 0～4；以 workspace 相对文件路径独立启停；所有已启用项全局拼接，并标注相对路径。 |
| Skill | 深度 1～4；父目录相对路径即 ID；根目录的 `SKILL.md` 无效；每项独立启停。 |
| 嵌套 Skill | 某目录直属 `SKILL.md` 被识别后，后代 `SKILL.md` 不再识别；但仍继续遍历后代以发现 `AGENTS.md`。 |
| 运行时权威 | 每个新 run 重新执行同一个完整扫描器；settings 仅表达期望启用项，实际以当前候选交集为准。 |
| 可用 Skill | 当前候选与已启用项交集经现有摘要读取成功后形成唯一 `availableExternalSkills`，同时用于 Prompt、top-level 与 Worker allowlist。 |
| 真禁用 | Worker 接收精确 Skill allowlist，不能从公共 root 猜测并读取已禁用 Skill。 |
| 内置 Skill | 继续使用 `builtin/<skillDir>`；workspace 相对路径首段精确为 `builtin` 的外部候选不注册。 |
| 路径安全 | 所有 workspace 相对路径按同一严格段规则原样比较：不 trim，拒绝反引号、控制/格式字符、行分隔符和首尾 Unicode 空白。 |
| AGENTS 读取 | Prompt context resolver 读取一次并返回 `{ filePath, displayPath, content }`；assembler 只拼接，绝对 `filePath` 不外泄。 |
| Skill 分层 | API 仅读取根 `SKILL.md` 的最小摘要；辅助文件枚举、根正文/文件列表和输出预算只由实际 Worker `skill` 调用执行。 |
| 设置 | 一个 V2 settings PUT 完整替换两类启用集合；服务端重扫后校验，采用 last-write-wins。 |
| 旧配置 | 不迁移、不兼容；删除/替换旧 root/repo 级接口、契约和设置逻辑。 |
| 生效时机 | 沿用 run 静态 Prompt 缓存；变更仅保证新 run 生效，不热刷新已经启动的 run。 |

## 文档导航

- [需求与产品规则](./01-requirements-and-product-rules.md)
  - 用户价值、范围、术语、可观察行为、非目标和决策取舍。
- [技术设计](./02-technical-design.md)
  - 唯一权威规则、遍历算法、API/契约/设置结构、Prompt/Worker 数据流、错误与安全边界、受影响代码。
- [测试与验收](./03-testing-and-acceptance.md)
  - 可自动化的验收矩阵、测试分层、回归要求和人工验收步骤。
- [实施计划](./04-implementation-plan.md)
  - 按依赖顺序拆分的开发任务、每阶段自检与审查完成标准。

## 阅读与实施顺序

- 开发前先以 [需求与产品规则](./01-requirements-and-product-rules.md) 的“规范性规则”为唯一产品语义来源。
- 实现 API、扫描、设置和运行时授权前，遵循 [技术设计](./02-technical-design.md) 的字段定义及算法。
- 每个阶段完成后，以 [测试与验收](./03-testing-and-acceptance.md) 的相应类别作为完成门槛。
- 合并前逐项核对 [实施计划](./04-implementation-plan.md) 的完成标准，而非只验证页面能显示候选项。

## 现状依据与拟议变更的边界

本文的“现状事实”基于当前工作树中的代码符号，而非归档设计文档中的旧描述。重点依据包括：

- `apps/api/src/modules/workspaces/workspace.service.ts`
  - 当前的 `detectWorkspaceAgentsInstructions()`、`detectWorkspaceExternalSkillRoots()`、各自的 settings 读取/写入和 repo/root 解析。
- `apps/api/src/modules/workspaces/workspaces.routes.ts`
  - 当前两组 detect/settings 路由和 `/skills/top-level` 路由。
- `packages/shared/src/contracts/workspaces.ts`
  - 当前 root/repo 导向的 TypeBox 契约。
- `packages/shared/src/skills-protocol.ts`
  - 当前 `parseStableSkillIdentifier()`、`isValidSkillRelativePath()` 与 `isValidSkillPathSegment()`。
- `apps/api/src/modules/agent/agent.composition.ts` 与 `apps/api/src/modules/agent/prompt/prompt-static-assembler.ts`
  - 当前 AGENTS 注入、Skill 摘要及静态 Prompt 组装。
- `packages/shared/src/internal-contracts/agent-api-read.ts` 与 `apps/agent-worker/src/runtime/fileTools.ts`
  - 当前 API→Worker prompt-context、Skill 身份解析与安全读取。
- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`
  - 当前上下文管理弹窗同时调用两个 detect API，并用两个 PUT 保存。
- `skills/skill-authoring/SKILL.md`
  - 当前 V2 Skill 根文件、frontmatter、辅助文件和按需读取约定。

“拟议”内容是本设计的实施要求；与上述现状不一致时，应以本设计为准。
