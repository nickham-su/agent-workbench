# 需求与产品规则

> 状态：**待实施（规范性设计基线）**
> 本文定义外部 Skill 与 `AGENTS.md` 的用户可见语义。实现细节见[技术设计](./02-technical-design.md)。

## 背景与目标

当前实现以 workspace 根、已挂载 repo 根和外部 Skill root 为管理单位：

- `workspace.service.ts` 中的 `detectWorkspaceAgentsInstructions()` 仅发现 workspace 根及 repo 根的 `AGENTS.md`。
- `detectWorkspaceExternalSkillRoots()`、`normalizeTopLevelSkillRootName()` 和 root settings 仅支持名称含 `skill` 的一级目录。
- `AgentClientPane.vue` 的 `openContextManager()` 分别调用两个 detect API，`saveContextSettings()` 分别保存两类选择。

这不适合按项目实际目录维护上下文：常见的 `.claude/skills/...`、普通子目录 `AGENTS.md` 无法自然管理，且 Skill 不能独立启停。

本方案将 workspace 的物理根目录作为唯一事实边界：一次完整、有界深度的扫描同时发现两类文件；用户只选择精确文件或 Skill，系统只把已选择的精确项用于运行时。

## 术语

| 名称 | 定义 |
|---|---|
| workspace 根 | `WorkspaceRecord.path` 对应的物理目录；本方案唯一的扫描和运行时 containment 边界。 |
| workspace 相对 POSIX 路径 | 相对 workspace 根、以 `/` 分隔且保留文件系统精确 Unicode/大小写的路径；不做 Unicode 规范化。 |
| 父目录深度 | 目标文件父目录相对 workspace 根的路径段数；根目录是 0。 |
| AGENTS 候选 | 通过安全元数据检查的普通、非软链 `AGENTS.md`；标识为相对文件路径。 |
| 外部 Skill 候选 | 通过安全元数据检查的普通、非软链 `SKILL.md`，其父目录深度为 1～4，且未被已识别祖先 Skill 屏蔽；标识为父目录相对路径。 |
| 内置 Skill | 应用仓库 `skills/<skillDir>/SKILL.md` 中的 Skill；保持 `builtin/<skillDir>` 标识，不参与本功能的发现或启停。 |
| 完整快照 | 一次扫描已完成所有可达、未忽略的深度范围目录，且未遇到权限或未知 I/O 错误；仅完整快照可用于显示和保存。 |
| 期望启用项 | V2 settings 中用户精确列出的 Skill ID 或 AGENTS 路径；settings 本身不是运行时可用性的权威。 |
| 可用外部 Skill | 当前完整候选快照与期望启用 Skill ID 的交集，经现有 Skill 摘要读取和安全校验成功后得到的唯一集合 `availableExternalSkills`。 |

## 发现规则

### 唯一根、深度与文件名

- 仅从 workspace 根扫描一次；不得对 mounted repo 单独扫描。
- mounted repo 目录只是普通 workspace 子目录；候选、settings、Prompt、内部协议和 Worker 中均不保留 repo 身份、`repoId`、`sourceType: repo` 或 root 身份。
- 最大父目录深度为 4：

| 文件 | 父目录深度 | AGENTS 候选 | 外部 Skill 候选 |
|---|---:|---:|---:|
| `AGENTS.md` | 0 | 是 | 不适用 |
| `SKILL.md` | 0 | 不适用 | 否 |
| `a/AGENTS.md` | 1 | 是 | 不适用 |
| `a/SKILL.md` | 1 | 不适用 | 是 |
| `a/b/c/d/AGENTS.md` | 4 | 是 | 不适用 |
| `a/b/c/d/SKILL.md` | 4 | 不适用 | 是，除非被祖先 Skill 屏蔽 |
| `a/b/c/d/e/AGENTS.md` | 5 | 否 | 不适用 |
| `a/b/c/d/e/SKILL.md` | 5 | 不适用 | 否 |

- 仅精确、区分大小写匹配 `AGENTS.md` 与 `SKILL.md`；`agents.md`、`AGENTS.MD`、`skill.md`、`SKILL.MD` 都不是候选。
- 不根据目录名是否含 `skill` 决定发现或注册。

### 路径、目录与安全元数据

- 扫描不跟随任何目录或文件软链；软链不成为候选，也不进入其子树。
- 必须跳过 `.git`、`node_modules` 与 `.agent-workbench` 及整棵子树。
  - `.agent-workbench` 已由 `apps/api/src/infra/fs/paths.ts` 的 `workspaceAgentRoot()` 核实为 workspace 内部目录；`workspaceAgentInternalRoot()` 位于其 `internal` 子目录。
- 不得笼统跳过隐藏目录；`.claude`、`.agents` 等目录可以产生候选。
- 每个相对路径段拒绝反斜杠、反引号、Unicode `Cc`、Unicode `Cf`、`U+2028`、`U+2029`、段首或段尾任意 Unicode whitespace、空段、`.` 和 `..`。
- 其它 Unicode 字符可用；不做 trim、NFC/NFD、大小写或其它规范化，路径始终按文件系统返回的精确字符串识别和比较。
- 候选文件和进入的目录均需通过 `lstat`、非软链检查及 `realpath` workspace containment 检查。扫描期间文件系统变化导致的检查失败按[技术设计](./02-technical-design.md)的错误策略处理。
- 如果一个目录名不能形成合法的 workspace 相对 POSIX 路径，该目录及其后代不能形成合法候选，扫描器必须剪枝；不能在下游用不同规则“修复”该路径。

### `AGENTS.md`

- 父目录深度 0～4 的合规文件均可发现；根 `AGENTS.md` 合法。
- 标识为精确相对文件路径，例如 `AGENTS.md`、`repo-a/src/AGENTS.md`。
- 每个候选独立启停；新候选默认禁用。
- 所有已启用文件按确定性相对路径顺序全局拼接为现有的 `[agents_instructions] <displayPath>` section；标签只能使用 workspace 相对路径。
- 系统不得因目录位置向模型增加适用范围、继承、覆盖、优先级、冲突处理或“只适用于某目录”的规则。文件作者自行写明内容的适用范围。
- 排序只保证可复现性，不赋予额外模型语义，也不在 Prompt 中解释顺序。

### 外部 Skill

- 父目录深度 1～4 的合规 `SKILL.md` 可形成外部 Skill；workspace 根的 `SKILL.md` 不形成 Skill，也不屏蔽后代。
- Skill ID 为 `SKILL.md` 父目录的 workspace 相对 POSIX 路径，例如：

```text
repo-a/.claude/skills/review/SKILL.md
→ skillId: repo-a/.claude/skills/review
```

- ID 不含 `workspace/` 前缀、`repoId` 或 `SKILL.md` 文件名。
- `builtin` 是保留命名空间：父目录相对路径的首段精确为 `builtin` 时，安全跳过该 `SKILL.md`，不注册为候选、不允许启用；这不使整个扫描失败，也不影响其他候选或其中的 `AGENTS.md` 发现。大小写不同的 `Builtin` 不是冲突。
- 同名但不同路径是不同 Skill，例如 `a/review` 与 `b/review`。
- 每个候选独立启停；新候选默认禁用。
- external Skill ID 不得 trim；API、settings、Prompt、internal prompt-context 和 Worker allowlist 必须以原始精确字符串比较。
- Prompt、`/skills/top-level` 和 Worker allowlist 只使用 `availableExternalSkills` 的 ID、API 摘要读取到的 frontmatter `name` 和 `description`。`name` 缺失时回退为目录最后一段，`description` 缺失不阻止使用。

### 发现身份与内容读取的分界

发现只依赖安全元数据，不读取 `SKILL.md` 正文：

- 直属 `SKILL.md` 经 `lstat` / `realpath` containment 验证为普通、非软链文件后立即成为候选，并屏蔽其后代 Skill 注册。
- detect 不做二进制判断、frontmatter 解析、文本可读性判断、内容截断或辅助文件枚举。
- 文件在元数据确认前因 `ENOENT`/`ENOTDIR` 消失，或因软链、类型、containment 等安全检查不合格时，不形成候选，也不屏蔽后代 Skill。
- 当前候选与 settings 交集的 API 摘要读取只安全读取直属根 `SKILL.md`，进行二进制判断和轻量 frontmatter 解析；摘要失败只使该 Skill 不进入本次 `availableExternalSkills`，不反向改写发现身份或放开后代 Skill。
- 只有模型调用 `skill` 工具时，Worker 才执行根正文处理、辅助文件枚举、`Skill files` 列表、输出截断和完整读取安全复验。

### Prompt AGENTS 与 Skill 读取职责

- Prompt 上下文 resolver 是 AGENTS 的唯一内容读取点：它返回可直接拼接的 `{ filePath, displayPath, content }`。`filePath` 仅 API 内部使用，`displayPath` 是 workspace 相对路径标签，`content` 已保留现有安全读取、二进制忽略、空内容跳过和单文件截断语义。
- Prompt assembler 只拼接 resolver 的 AGENTS 结果，不得再次读取文件。
- `/skills/top-level` 只计算当前候选、已启用且 API 摘要读取成功的 `availableExternalSkills`，不读取 AGENTS 内容。

### 嵌套 Skill

某目录直属 `SKILL.md` 成功形成候选后：

- 该目录后代的 `SKILL.md` 不再形成独立外部 Skill。
- 扫描仍必须遍历后代目录，继续发现其中的 `AGENTS.md`。
- 后代 `SKILL.md` 仍是父 Skill 可按需读取的普通辅助文件，遵循现有 V2 Skill 语义。

```text
engineering/SKILL.md                 # Skill: engineering
engineering/review/SKILL.md          # 不注册；父 Skill 的辅助文件
engineering/review/AGENTS.md         # 仍是 AGENTS 候选
```

## 启停、设置与生效

- detect 的 `enabled` 只表示当前完整候选是否被 V2 settings 精确选中，不从目录继承；detect 展示候选，不读取 Skill 正文，也不代表运行时摘要一定可用。
- 前端一次 detect 成功后获得完整快照；仅此状态允许用户保存。
- 一个统一 PUT 完整替换当前 workspace 的 `enabledSkillIds` 和 `enabledAgentsInstructionPaths`。服务端在写入前自行重新执行完整扫描；每一项必须存在于该次完整快照，否则返回明确 4xx 且不写入。
- 使用 last-write-wins：不设计 revision、`baseRevision`、乐观并发或 409 冲突。每个 PUT 必须保持单次 settings 写入的结构完整性，后完成的合法请求覆盖先完成请求的完整集合。
- settings 不存在或无法解析时统一视为空配置；不要求修改通用 settings store，也不要求记录 warning。
- 每个新 run 构造静态上下文时，必须复用唯一的 `discoverWorkspaceContextFiles()` 获得当前完整候选快照，再与 settings 期望启用项求交集；不得只按 settings 逐路径校验，也不得在运行时复制祖先 Skill 屏蔽逻辑。
- 文件删除、移动、改名、越界、软链化、因新增祖先 Skill 而被屏蔽，或摘要读取失败时，旧 settings 值在本 run 不进入 Prompt、`externalSkills` 或 Worker；detect 成功时不单独展示陈旧项，下一次成功完整 PUT 自然清理。
- 运行时完整扫描遇到阻断错误时，静态 Prompt 构造必须失败并沿用现有调用链错误传播；不得退回到只信任 settings 的旧集合。
- 设置或文件内容变化只保证新 run 生效；已启动 run 继续使用 `RunPromptStaticCache` 的静态 Prompt，不做热刷新。
- 管理界面应明确显示“更改将在新 run 中生效”。

## 非目标

本期不做：

- 旧 root/repo settings、旧 API 或旧 ID 的迁移与产品兼容；
- repo 身份、repo 专属发现、repoId 或 repo 根规则；
- `AGENTS.md` 的目录作用域、继承、覆盖、排序语义或自动模型提示；
- Skill/AGENTS 创建、编辑、安装、卸载、版本管理、分发或文件监视；
- 新的 AGENTS 总内容预算、自动裁剪、token 阈值或提示；
- 已启动 run 的静态 Prompt 热刷新；
- 账户、多租户、通用文件索引平台或后台扫描服务。

## 关键取舍

| 决策 | 原因 |
|---|---|
| workspace 相对路径作为外部 Skill ID | 与用户可见目录一致，删除 repo/root 双层模型；目录移动或改名自然形成新 ID。 |
| 一次完整扫描 | 避免两个 API 重复遍历，也避免把不完整快照用于完整替换 settings。 |
| 扫描只检查安全元数据 | 发现身份稳定、成本低；内容能否读取由既有运行时读取机制负责。 |
| 完整扫描遇权限/I/O错误即失败 | 不能把未知遗漏伪装成可保存的完整选择；这与内容 token 预算无关。 |
| 单一 settings PUT、last-write-wins | 个人项目中以最小实现保证一次写入完整性，不引入版本冲突协议。 |
| 精确 Worker allowlist | 是独立停用真实生效的必要条件，不能只从 Prompt 隐藏。 |
| 保留 builtin 命名空间 | 保持内置 Skill 稳定 ID，冲突目录安全跳过而不引入复杂命名转换。 |
