# 实施计划与代码审查清单

> 状态：**待实施**
> 本计划按依赖关系拆分。不得把跨 workspace 契约修改拆成只更新一端的可合并阶段；每次变更都应可审查、可回滚。

## 开工前核对

- 阅读[需求与产品规则](./01-requirements-and-product-rules.md)、[技术设计](./02-technical-design.md)和[测试与验收](./03-testing-and-acceptance.md)。
- 检查各 workspace 的真实 `package.json` 脚本；记录实际可执行的 build、typecheck 和 test 命令。
- 确认 `.agent-workbench` 仍由 `apps/api/src/infra/fs/paths.ts` 的 `workspaceAgentRoot()` 定义。若权威路径函数变化，先同步扫描排除规则和设计文档，不能猜测内部目录名。
- 不读取 `.env`，不处理已有未提交变更，不执行 Git 修改命令。

共同约束：

- 最终产品没有旧 root/repo settings、API、ID 或兼容分支；开发中短暂的新旧符号共存只为完成一次垂直切换，不构成产品兼容。
- 不新增路径规则的重复实现、repo 身份、AGENTS 层级解释、内容总预算、文件监视或当前 run 热刷新。
- 每个影响共享包、HTTP API、内部 prompt-context、Worker 或 Web 的阶段都必须运行根级 `npm run typecheck`；涉及共享产物时先运行 `npm run build -w packages/shared`，必要时运行根级 `npm run build`。
- 所有错误、日志和测试快照遵守绝对路径不外泄边界。

## 阶段：独立路径规则与完整扫描器

此阶段只建立可独立测试的纯函数和 API 内部扫描器，不切换对外 API、shared contract、Prompt、Worker 或 Web 调用。旧功能继续工作；新扫描器尚不承载产品流量。

### 修改范围

- 拟议新增 `packages/shared/src/workspace-context-paths.ts` 及其纯函数测试。
- 拟议新增 `apps/api/src/modules/workspaces/workspace-context-discovery.ts` 及其测试。
- 仅为这些模块必要的导出/测试文件；不删除旧路由、旧 schema 或旧 settings。

### 实施步骤

- 实现 `parseWorkspaceRelativePosixPath()`、`parseExternalWorkspaceSkillId()`、`parseWorkspaceAgentsInstructionPath()` 与 UTF-8 字节排序函数。
- 从 `skills-protocol.ts` 提取或复用一个共享安全段函数，统一拒绝反斜杠、反引号、`Cc`、`Cf`、`U+2028`、`U+2029`、段首尾 Unicode whitespace、空段与 `.`/`..`；禁止 Skill 与 AGENTS 复制不同规则。外部 ID 不得 trim，现有 `trimAsciiSpaceTab()` 如保留只能用于 builtin 分支。
- 为基础 parser 覆盖 POSIX 分隔、空段、绝对/盘符、`.`/`..`、反斜杠、控制字符、Unicode 原样保留、大小写敏感、Skill 段数与 builtin 首段、AGENTS 根路径和深度。
- 实现一次完整扫描器：固定深度 4、`.git`/`node_modules`/`.agent-workbench` 剪枝、隐藏目录允许、realpath containment、稳定排序和嵌套 Skill 的独立屏蔽状态。
- 严格实施“发现只检查元数据”：不得读取 Skill 正文；普通非软链且 containment 合规的直属 `SKILL.md` 注册并屏蔽后代 Skill。`ENOENT`/`ENOTDIR` 不注册不屏蔽并继续；权限或未知 I/O 使整个扫描失败。
- 编写扫描器测试，不把 partial result、issue、数量上限或内容预算加入接口。

### 审查重点

- 非法目录段必须剪掉整个子树；不能在下游补做不同规则。
- 根 `SKILL.md` 不注册、不屏蔽；`builtin/...` 安全跳过、不阻断其它候选；已注册 Skill 仍允许发现后代 AGENTS。
- 纯函数和文件系统测试覆盖反引号、`Cf`、`U+2028`/`U+2029`、ASCII/Unicode 首尾空白、合法 Unicode、大小写和 external ID 不隐式 trim。
- 普通 Skill 文件的二进制、frontmatter 或内容读取失败不得影响发现结果。
- 扫描异常不会返回可保存的不完整候选。

### 自检与完成标准

```bash
npm run build -w packages/shared
npm run typecheck
npm run test -w apps/api
```

- parser 与扫描器测试覆盖[测试与验收](./03-testing-and-acceptance.md)中的发现、路径、嵌套和扫描失败矩阵。
- 新模块未被产品路由调用，旧产品行为未改变。

## 阶段：完整垂直契约切换

本阶段一次完成 shared schema、HTTP API、settings、Prompt、内部 prompt-context、Worker 和 Web 的切换。不得先合并只更新某一端的协议变更。可在开发分支中暂时保留旧符号以帮助编辑和测试，但合并前必须删除所有旧 context 路由、根/repo settings、旧字段和调用点。

### 修改范围

- `packages/shared/src/contracts/workspaces.ts`、共享出口与 `skills-protocol.ts`。
- `packages/shared/src/internal-contracts/agent-api-read.ts`。
- `apps/api/src/modules/workspaces/workspace.service.ts`、`workspaces.routes.ts`。
- `apps/api/src/modules/agent/agent.composition.ts`、`prompt/prompt-static-assembler.ts`、`read-side/prompt-context-projector.ts`。
- `apps/agent-worker/src/runtime/fileTools.ts`、`tools/providers/builtin.ts`。
- `apps/web/src/shared/api/api.ts`、`apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`。
- 所有受影响 API、Prompt、Worker、Web 测试。

### 实施步骤

- 将 `parseStableSkillIdentifier()` 收敛为 builtin/external 分类；外部 ID 委托新的 workspace 相对路径 parser。TypeScript 类型仅表达分类，实际合法性仍由运行时 parser 确认。
- 以 `WorkspaceContextFilesDetectResponse`、`UpdateWorkspaceContextFilesSettingsRequest`、`WorkspaceContextFilesSettingsResponse` 替换旧 root/source TypeBox schema；不要保留 revision、`baseRevision`、scan issues 或数量 limit 字段。
- 注册 `GET /api/workspaces/:workspaceId/context-files/detect` 与 `PUT /api/workspaces/:workspaceId/context-files/settings`；删除四个旧 detect/settings 路由。detect 执行一次完整扫描；PUT 重新完整扫描、校验完整集合、一次写入 settings。
- 新增 `workspace_context_files_v2` payload，缺失/不可解析时视为空配置；合法并发 PUT 采用 last-write-wins。删除 V1 root/repo settings 的读取、迁移和兼容逻辑。
- 令 `/skills/top-level` 从 builtin Skill 和当前可用且启用的外部 Skill 构建补全结果，绝不返回禁用、陈旧、已屏蔽或摘要读取失败的 Skill。
- 新增 `resolveAvailableExternalSkills()`：它只消费当前候选/settings 交集，安全读取直属根 `SKILL.md` 生成 name/description/skillId，并形成唯一 `availableExternalSkills`；不得枚举辅助文件、构造根正文/`Skill files` 或执行 Worker 输出预算。
- 新增 `resolvePromptWorkspaceContext()`：每个新 run 首次构造静态 Prompt 时调用一次 `discoverWorkspaceContextFiles()`，并调用上述 Skill 子流程。它是 AGENTS 的唯一读取点，返回已读 `{ filePath, displayPath, content }`；assembler 只能拼接，不得再次读取。扫描阻断错误必须使静态 Prompt 构造失败，不得退回旧 settings。
- `/skills/top-level` 不调用 Prompt resolver：它以本请求的当前完整扫描和 settings 调用 `resolveAvailableExternalSkills()`，不读取 AGENTS。detect 仍只返回全部当前候选供管理。不得在 top-level、Prompt 或 Worker 复制祖先 Skill 检查。
- 为 top-level 路由补充 `409 ErrorResponseSchema`；resolver 扫描失败时返回 `WORKSPACE_CONTEXT_SCAN_FAILED`，不返回 settings 降级结果。
- 在 Prompt 静态组装中只消费 Prompt resolver 返回的 AGENTS 与 `availableExternalSkills`。AGENTS 保持现有内容读取语义；Skill API 摘要仅保留根文件二进制/frontmatter读取，辅助文件枚举、根正文/文件列表与输出截断仅在 Worker 实际 `skill` 调用发生；允许把日志展示路径调整为 workspace 相对路径。
- 将内部 `externalSkillRoots` 一次性替换为 `externalSkills: [{ skillId, skillDirectoryPath }]`。不得下发 workspace 根、repo 根或公共 parent root。
- Worker external resolver 只接受精确 allowlist 命中；继续复用 containment、`O_NOFOLLOW` 和打开后 identity 校验。
- Web 弹窗改为一次 detect、一次 PUT、精确 ID/path checkbox；detect 未成功或保存失败时不可伪造完整快照，显示安全错误和“新 run 生效”提示。

### 审查重点

- settings PUT 遇扫描失败、非法、重复或未在该次完整扫描中的值，必须整体拒绝、不写入。
- 已启用项删除后，运行时忽略；detect 不展示陈旧项；下一次成功完整 PUT 清理陈旧值。
- AGENTS 只按稳定相对路径全局拼接原文；不写入层级规则。
- Prompt 列表、internal contract、Worker allowlist 与 `/skills/top-level` 必须使用同一 `availableExternalSkills`，而非仅 settings 交集；二进制、读取失败或安全校验失败 Skill 必须从四处同时省略。
- Prompt resolver 的每个 AGENTS 只读取一次，assembler 不得重复读；`filePath` 仅 API 内部使用，不得泄露至 Prompt、对外 API、internal prompt-context 或 Worker。
- API 摘要读取和 Worker 完整 Skill 加载必须有测试可观察地分层：top-level 不读 AGENTS，API 摘要不枚举辅助文件，只有 `skill` 工具调用触发根正文/文件列表/输出截断。
- 先启用 `parent/child` 后加入 `parent/SKILL.md` 时，新 run/top-level/allowlist 均不得保留 child；旧 settings 可在下一次 PUT 前保留但不生效。
- 没有旧 `repoId`、`sourceType`、`rootDir`、`enabledRoots`、`enabledSources`、`externalSkillRoots`、V1 settings key 或 API URL 残留。

### 自检与完成标准

```bash
npm run build -w packages/shared
npm run typecheck
npm run test -w apps/api
npm run test -w apps/agent-worker
npm run test -w apps/web
```

- 根级类型检查通过，所有跨 workspace import、路由、internal contract 和 Worker provider 同步。
- API→Prompt-context→Worker 集成测试证明 exact allowlist；禁用 Skill 无法读取。
- UI 测试证明不再使用双 detect/double PUT，且扫描失败时没有可保存 partial 状态。

## 阶段：清理、文档同步与全链路验收

此阶段不引入新产品语义，只删除已经在垂直切换中不可达的旧测试/fixture/说明，补齐验收测试并执行全链路检查。

### 修改范围

- 旧 root/repo context 相关测试、无效 fixture、无效 import。
- `skills/skill-authoring/SKILL.md` 中与外部 Skill ID/发现相关的说明。
- 本设计目录与受影响测试文件。

### 实施步骤

- 更新作者说明：外部 Skill ID 为 workspace 相对目录、最大深度、嵌套 Skill 不单独注册、`builtin` 保留；保留现有根/辅助文件 V2 加载说明。
- 对照[测试与验收](./03-testing-and-acceptance.md)补齐权限/I/O失败、TOCTOU、陈旧 settings、last-write-wins、AGENTS 路径标签、缓存边界和 UI 失败状态。
- 全仓库搜索旧符号和路由；builtin 正常 `builtin/...` 引用不应被误删。
- 人工创建包含 `.claude`、`.agents`、mounted repo 普通目录与 `.agent-workbench` 的 workspace，验证发现、启停、新 run 生效和禁用读取拒绝。

### 自检与完成标准

```bash
npm run build -w packages/shared
npm run typecheck
npm run test -w apps/api
npm run test -w apps/agent-worker
npm run test -w apps/web
```

如果根级命令或测试因已知无关问题失败，必须记录完整命令、失败范围、关联判断与已经执行的相关子集；不得将未执行或失败的检查写为通过。

最终审查必须确认：

- 所有候选由 workspace 根的一次完整扫描产生；mounted repo 无特殊身份。
- 深度、大小写、路径、隐藏目录、剪枝、软链、containment、嵌套 Skill 和扫描错误语义逐项符合设计。
- `AGENTS.md` 全局拼接只带相对路径与原文，无系统层级规则和总预算。
- 外部 Skill 是精确相对 ID，builtin 冲突安全跳过，根 Skill 不注册。
- settings 是单一 V2 完整写入、last-write-wins；无旧数据迁移、revision 或冲突协议。
- 每个新 run 与 `/skills/top-level` 都复用唯一扫描器和可用 Skill resolver；`availableExternalSkills` 是 Prompt、internal allowlist、Worker 与 top-level 的唯一外部 Skill 集合。
- 现有内容读取/截断安全保护未弱化，读取日志不泄露绝对路径。
- 新 run 生效边界保持，未引入热刷新。
- 最终不存在旧 API/契约/设置/兼容层，且测试与文档一致。
