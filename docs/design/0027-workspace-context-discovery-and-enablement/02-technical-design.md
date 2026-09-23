# 技术设计

> 状态：**待实施（规范性设计基线）**
> 产品语义见[需求与产品规则](./01-requirements-and-product-rules.md)。本文定义唯一权威规则、字段、算法、错误策略与替换点。

## 架构原则与唯一权威

### 拟议模块与职责

新增下列拟议模块；名称可在实现时随现有目录风格微调，但职责不得拆散或复制：

| 拟议模块 | 权威职责 |
|---|---|
| `packages/shared/src/workspace-context-paths.ts` | workspace 相对 POSIX 路径基础规则、Skill ID/AGENTS 路径 parser、UTF-8 稳定比较。 |
| `apps/api/src/modules/workspaces/workspace-context-discovery.ts` | workspace 根安全检查、一次完整遍历、目录剪枝、候选形成、嵌套 Skill 屏蔽与排序。 |
| `workspace.service.ts` 中的 V2 context functions | settings 读写、detect/PUT 服务编排，以及统一的可用外部 Skill resolver。 |

前端、路由、Prompt 组装器和 Worker 只调用共享 parser 或接收已验证结果；不得自行以 `path.relative()`、`path.normalize()`、字符串替换、`includes("skill")` 或各自正则重新解释路径、深度或 ID。

### 共享路径规则

新增共享基础 parser，例如：

```ts
type ParsedWorkspaceRelativePath = {
  path: string;       // 保留原始、已验证的 POSIX 字符串
  segments: string[]; // 与 path 一一对应，不含空段
};

function parseWorkspaceRelativePosixPath(raw: unknown): ParsedWorkspaceRelativePath | null;
function parseExternalWorkspaceSkillId(raw: unknown): ParsedWorkspaceRelativePath | null;
function parseWorkspaceAgentsInstructionPath(raw: unknown): ParsedWorkspaceRelativePath | null;
function compareWorkspaceRelativePathsUtf8(a: string, b: string): number;
```

`parseWorkspaceRelativePosixPath()` 是所有 workspace 候选、settings 输入、运行时解析共用的基础规则：

- 输入必须是非空 string，以 `/` 分隔；不得以 `/` 开头、不得包含 `\\`、Windows 盘符绝对形式、空段、`.` 段或 `..` 段。
- 每个段必须是格式良好的 Unicode；拒绝反引号、Unicode 控制字符 `\p{Cc}`、Unicode 格式字符 `\p{Cf}`、`U+2028`、`U+2029`，以及段首或段尾任意 Unicode whitespace。
- 不做 trim、Unicode NFC/NFD、大小写或任何其它文本规范化；除上述拒绝字符外的 Unicode 按文件系统返回的精确字符串保留，比较时大小写敏感。
- parser 只验证逻辑路径。文件系统 containment 由 API 扫描器和运行时 resolver 对真实路径执行 `lstat` / `realpath` 检查。

派生规则：

| parser | 在基础规则上的额外约束 |
|---|---|
| `parseExternalWorkspaceSkillId()` | 路径段数为 1～4，首段不等于精确 `builtin`。 |
| `parseWorkspaceAgentsInstructionPath()` | 最后一段精确为 `AGENTS.md`，父目录段数为 0～4。根 `AGENTS.md` 合法。 |

`packages/shared/src/skills-protocol.ts` 当前的 `isValidSkillPathSegment()`、`isValidSkillRelativePath()`、`isWellFormedUnicode()` 和 `parseStableSkillIdentifier()` 是现状事实。拟议实现应将现有 Skill 段规则（反引号、`Cc`、`Cf`、`U+2028`、`U+2029`、首尾 Unicode whitespace 与格式良好 Unicode）提取或复用为新共享基础段函数；AGENTS 和外部 Skill 都调用这一函数，不能各自复制。现有 Skill 专用 validator 可继续服务 builtin Skill 和 Skill 内辅助文件，但**不得**被模糊地当作 AGENTS 路径规则。

更新 `parseStableSkillIdentifier()`，使类型表达分类而非取代运行时校验：

```ts
type ParsedStableSkillIdentifier =
  | { kind: "builtin"; skill: string; skillDir: string }
  | { kind: "external"; skill: string; relativeSkillDir: string };
```

- 两段、首段精确为 `builtin` 且 builtin 段合法的 ID 为 builtin。
- 首段为 `builtin` 但形状不符合 builtin 的 ID 为 invalid。
- 其它 ID 只有经 `parseExternalWorkspaceSkillId()` 成功后才是 external，且 external 分支不得 trim。
- 当前 `trimAsciiSpaceTab()` 如需保留，只能位于 builtin 旧形状的分支；它不得在 external 相对路径 ID 进入 parser、API、settings、Prompt、internal contract 或 Worker allowlist 前后生效。
- 上述 TypeScript 字面量和类型仅表达分类；真正合法性始终由运行时 parser 决定。

### 现状与最终替换

| 当前代码事实 | 最终拟议状态 |
|---|---|
| `workspace.service.ts` 的 `detectWorkspaceAgentsInstructions()` 以 `sourceType`/`repoId` 枚举 workspace/repo 根 AGENTS。 | 删除，改为单一扫描器返回 workspace 相对 AGENTS 文件。 |
| `detectWorkspaceExternalSkillRoots()`、`normalizeTopLevelSkillRootName()` 和 `ExternalSkillEnabledRoot` 按 root 管理。 | 删除，改为精确外部 Skill ID 管理。 |
| `workspaces.routes.ts` 暴露两组 detect/settings 路由。 | 删除，改为一组 V2 detect 和 PUT 路由。 |
| `contracts/workspaces.ts` 的 `WorkspaceExternalSkillRoots*`、`WorkspaceAgentsInstructions*` 带 repo/root 字段。 | 删除，改为 V2 workspace context schemas。 |
| `AgentClientPane.vue` 用 `Promise.all()` 调两次 detect，再调两次 PUT。 | 单次 detect、单次 PUT、按精确 ID/路径显示 checkbox。 |
| `fileTools.ts` 的 `externalSkillRoots` 将公共 root 下发给 Worker。 | 改为精确 `externalSkills` allowlist。 |

最终不得保留旧 API、settings key、repo/root 类型或兼容分支。开发期允许为完成垂直切换暂时存在新旧符号，但这不是产品兼容：最终全仓库搜索不应保留旧 context 模型引用。

## 完整扫描器

### 固定扫描边界

```ts
const WORKSPACE_CONTEXT_SCAN_MAX_PARENT_DEPTH = 4;
const WORKSPACE_CONTEXT_IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".agent-workbench",
]);
```

不设计目录数、候选数、扫描时间或内容总量上限。深度 4 与固定目录剪枝是本期唯一的扫描范围限制；这与 AGENTS 内容 token 预算无关。

workspace 根必须能 `lstat`、为非软链目录并能 `realpath`。扫描器用其 `workspaceRealPath` 作为 containment 根。根检查失败时没有完整快照，detect 和 PUT 都返回 `409 WORKSPACE_CONTEXT_SCAN_FAILED`；响应不得出现绝对路径。

每一个将进入的目录和将形成候选的目标文件必须：

- 先以其物理路径 `lstat`，确认类型正确且不是软链；
- 以 `realpath` 复核位于 `workspaceRealPath` 内；
- 在受 TOCTOU 影响的后续操作前按需再检查；安全不合格的条目不进入候选，也不作为目录递归入口。

扫描本身不授予内容读取权。已启用项进入运行时后仍会再次做精确解析；Worker 继续使用现有 `O_NOFOLLOW`、打开后 identity 校验、根和辅助文件复验等读取边界。

### 完整性与文件系统错误

一次扫描只会有两个结果：完整成功或失败。不存在部分结果、issue 列表、稳定前缀或限额结果。

| 事件 | 扫描行为 |
|---|---|
| `readdir`、`lstat`、`realpath` 遇 `ENOENT` 或 `ENOTDIR` | 视为自然扫描竞态，跳过该入口并继续；若是待确认的 `SKILL.md`，既不注册也不屏蔽后代。 |
| 目录/文件遇 `EACCES`、`EPERM` 或未知 I/O 错误 | 整次扫描失败；不返回候选快照。 |
| 目录/文件是软链、类型不符、realpath 越界或路径 parser 失败 | 安全跳过该入口；非法目录名的整个子树被剪枝。 |
| workspace 根失败 | 整次扫描失败。 |
| `builtin/.../SKILL.md` | 安全跳过该 Skill；不使扫描失败，不注册且不屏蔽后代 Skill；其中 AGENTS 仍正常发现。 |

API 层将非根的权限/I/O失败统一映射为 `409 WORKSPACE_CONTEXT_SCAN_FAILED`，日志可包含 workspaceId、稳定错误代码和安全相对路径，不能输出绝对路径或外部 realpath。PUT 在扫描失败时直接失败，原 settings 不变。

### 排序与相对路径

扫描器从真实 directory entry 名称建立相对路径，并通过共享 parser 验证；不得先进行 Unicode、大小写或分隔符规范化。

- 目录 entry 与最终的 `skills`、`agentsInstructions` 都使用 `compareWorkspaceRelativePathsUtf8()` 按 UTF-8 字节升序排序，不能依赖 `readdir()` 或 locale。
- 逻辑键重复时只保留一个；这是扫描器内部不变量，正常文件树不应产生重复。
- 在任意目录帧中，目标文件的父目录深度就是帧 `depth`。帧深度为 4 时仍检查该目录直属 `SKILL.md` 与 `AGENTS.md`，但不再进入子目录。

### 遍历算法

关键实现要求是：Skill 成功注册只传递“后代 Skill 被屏蔽”状态，绝不能剪掉 AGENTS 遍历。

```ts
type Frame = {
  absDir: string;
  relativeDir: string; // 根目录为 ""
  depth: number;
  skillBlockedByAncestor: boolean;
};

async function discoverWorkspaceContextFiles(workspacePath: string) {
  const root = await assertWorkspaceScanRoot(workspacePath);
  const stack: Frame[] = [{
    absDir: workspacePath,
    relativeDir: "",
    depth: 0,
    skillBlockedByAncestor: false,
  }];
  const skills = [];
  const agentsInstructions = [];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const entries = await readDirectoryOrFailWholeScan(frame);
    // 先以 UTF-8 字节序排序，反序入栈，使实际访问顺序稳定。

    const skillEntry = findExactName(entries, "SKILL.md");
    const agentsEntry = findExactName(entries, "AGENTS.md");
    let registeredSkillHere = false;

    if (frame.depth >= 1 && !frame.skillBlockedByAncestor) {
      const skillId = parseExternalWorkspaceSkillId(frame.relativeDir);
      if (skillId && await isContainedRegularNonSymlinkFile(skillEntry, root)) {
        skills.push({ skillId: skillId.path, skillFilePath: `${skillId.path}/SKILL.md` });
        registeredSkillHere = true;
      }
      // skillId 为 null 时不注册；首段 builtin 与非法路径均不屏蔽后代。
      // 文件 ENOENT/ENOTDIR、安全不合格时也不注册且不屏蔽后代。
    }

    const agentsPath = frame.relativeDir
      ? `${frame.relativeDir}/AGENTS.md`
      : "AGENTS.md";
    if (parseWorkspaceAgentsInstructionPath(agentsPath)
        && await isContainedRegularNonSymlinkFile(agentsEntry, root)) {
      agentsInstructions.push({ path: agentsPath });
    }

    if (frame.depth === 4) continue;
    for (const child of listChildDirectoriesInReverseStableOrder(entries)) {
      if (WORKSPACE_CONTEXT_IGNORED_DIR_NAMES.has(child.name)) continue;
      const childRelativePath = appendAndParseWorkspaceRelativePath(frame.relativeDir, child.name);
      if (!childRelativePath) continue; // 非法段：剪掉完整子树
      if (!(await isContainedNonSymlinkDirectory(child, root))) continue;
      stack.push({
        absDir: child.absPath,
        relativeDir: childRelativePath.path,
        depth: frame.depth + 1,
        skillBlockedByAncestor: frame.skillBlockedByAncestor || registeredSkillHere,
      });
    }
  }

  return sortAndDeduplicate({ skills, agentsInstructions });
}
```

伪代码中的文件检查函数区分自然竞态、应整体失败的 I/O 与安全跳过，不能把所有错误吞掉为 false。`SKILL.md` 候选确认只检查安全元数据，绝不读取其正文、二进制样本、frontmatter 或辅助文件。

## HTTP API、TypeBox 与 settings

### 最终路由

删除：

```text
GET/PUT /api/workspaces/:workspaceId/agents-instructions/settings
GET     /api/workspaces/:workspaceId/agents-instructions/detect
GET/PUT /api/workspaces/:workspaceId/external-skill-roots/settings
GET     /api/workspaces/:workspaceId/external-skill-roots/detect
```

新增或替换为：

```text
GET /api/workspaces/:workspaceId/context-files/detect
PUT /api/workspaces/:workspaceId/context-files/settings
GET /api/workspaces/:workspaceId/skills/top-level
```

- detect 执行一次完整扫描，读取 V2 settings 后为候选填充 `enabled`；扫描失败则整体 409，不返回可保存候选。
- PUT 重新执行一次完整扫描，校验完整请求集合，再进行一次 settings 写入。扫描失败或选择非法时不写入。
- `/skills/top-level` 保持输入补全职责：它独立调用同一个可用 Skill resolver，以请求时的当前完整扫描快照、settings 交集和摘要读取结果返回 builtin Skill 与可用外部 Skill。
- detect 的职责是展示所有当前候选供管理，因而不读 `SKILL.md` 正文；`/skills/top-level` 的职责是返回当前启用且可用的 Skill，因而不返回禁用、已被新增祖先屏蔽、已删除或摘要读取失败的外部 Skill。
- `workspaces.routes.ts` 中 top-level 路由的 response schema 也必须声明 `409 ErrorResponseSchema`；resolver 的完整扫描失败直接映射为 `409 WORKSPACE_CONTEXT_SCAN_FAILED`，不得改用 settings 降级。

### 共享 schema

在 `packages/shared/src/contracts/workspaces.ts` 中定义并导出以下 V2 契约。类型字段表达数据形状，不能取代 API 服务的 runtime parser 与本次扫描 membership 校验。

```ts
const WorkspaceContextSkillCandidateSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
  skillFilePath: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
});

const WorkspaceContextAgentsInstructionCandidateSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  enabled: Type.Boolean(),
});

const WorkspaceContextFilesDetectResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  skills: Type.Array(WorkspaceContextSkillCandidateSchema),
  agentsInstructions: Type.Array(WorkspaceContextAgentsInstructionCandidateSchema),
});

const UpdateWorkspaceContextFilesSettingsRequestSchema = Type.Object({
  enabledSkillIds: Type.Array(Type.String({ minLength: 1 })),
  enabledAgentsInstructionPaths: Type.Array(Type.String({ minLength: 1 })),
});

const WorkspaceContextFilesSettingsResponseSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  enabledSkillIds: Type.Array(Type.String({ minLength: 1 })),
  enabledAgentsInstructionPaths: Type.Array(Type.String({ minLength: 1 })),
});
```

请求校验规则：

- 每个 Skill ID 必须通过 `parseExternalWorkspaceSkillId()`，每个 AGENTS 路径必须通过 `parseWorkspaceAgentsInstructionPath()`。
- 两个数组中任何重复值、非法值或未出现在本次完整扫描候选集的值都返回 `400 INVALID_CONTEXT_SELECTION`；整个请求不写入，不做部分成功或静默去重。
- 允许两个空数组，代表关闭所有外部 Skill 与 AGENTS。
- 并发合法 PUT 采用 last-write-wins；每次请求只写一个 settings payload，数据库数据不能出现半个数组或一类成功一类失败。

### settings 实体

新 settings key：

```text
workspace_context_files_v2
```

JSON 结构：

```ts
type WorkspaceContextFilesSettingsPayload = {
  workspaces?: Record<string, {
    updatedAt: number;
    enabledSkillIds: string[];
    enabledAgentsInstructionPaths: string[];
  }>;
};
```

规则：

- settings 缺失或不能解析时视为该 workspace 空配置：`updatedAt: 0`，两个空数组。
- 成功 PUT 将两个已验证且无重复的集合以 UTF-8 字节序排序后完整替换，并以一次写入更新 `updatedAt`。
- 不读取、不迁移 `workspace_external_skill_roots_v1` 或 `workspace_agents_instructions_v1`；旧 key 不再由本功能引用。
- 陈旧 settings 不单独显示：detect 只显示新完整快照候选，`enabled` 仅当 settings 值仍匹配候选时为 true。下一次成功 PUT 用请求完整集合自然删除陈旧值。

## Prompt、运行时与 Worker

### 运行时精确解析

候选身份和祖先 Skill 屏蔽只由 `discoverWorkspaceContextFiles()` 判断。它的完整扫描结果由两个边界明确的拟议 resolver 消费；不得创建一个为了 top-level 而读取 AGENTS 的万能 resolver，也不得在任一 resolver 复制扫描或祖先检查。

```ts
type AvailableExternalSkill = {
  skillId: string;
  skillDirectoryPath: string;
  name: string;
  description?: string;
};

type PromptWorkspaceContext = {
  enabledAgentsInstructions: Array<{
    filePath: string;    // 安全解析后的绝对路径，仅 API 内部使用
    displayPath: string; // 已验证的 POSIX 相对路径；保留精确 Unicode/大小写
    content: string;     // 已可直接拼接的现有读取结果
  }>;
  availableExternalSkills: AvailableExternalSkill[];
};
```

拟议子流程 `resolveAvailableExternalSkills({ workspacePath, candidates, enabledSkillIds })` 只处理外部 Skill：

- 从当前完整候选快照与 `enabledSkillIds` 求交集。删除、移动、越界、软链化、重命名，以及新增祖先 `SKILL.md` 后被嵌套规则屏蔽的旧 ID 均不在交集中。
- 对交集中的每项执行 API 摘要读取：仅安全读取直属根 `SKILL.md`、进行二进制判断并解析轻量 frontmatter，以生成 `skillId`、`name` 和可选 `description`。frontmatter 可选，`name` 缺失回退为目录末段，空 `description` 仍可用。
- 只有摘要读取成功的项成为 `availableExternalSkills`。二进制、权限/读取失败或 API 侧安全校验失败项按现有安全日志语义诊断，并从该集合省略。
- 此子流程不得枚举辅助文件、读取并返回完整根正文、剥离正文 frontmatter、生成 `Skill files` 列表，或执行 Worker 的 40KB/10KB/50KB 输出预算。

拟议 `resolvePromptWorkspaceContext(workspaceId)` 只服务静态 Prompt：

- 每个新 run 首次构造静态 Prompt 时，`PromptStaticAssembler` 只调用它一次；它调用唯一的 `discoverWorkspaceContextFiles()` 取得当前完整快照。扫描发生阻断错误时，`PromptStaticAssembler` 不捕获后替换为 settings 结果，而是让异常沿现有静态 Prompt / prompt-context 读取调用链传播，使本次静态上下文构造失败；不得降级为逐路径检查 settings 或复用旧 run 的集合。
- 它读取 V2 settings，以当前候选快照与两个期望启用集合分别求交集；Skill 交集调用 `resolveAvailableExternalSkills()`。
- 它是 AGENTS 的唯一内容读取点：对 AGENTS 交集调用现有 `readAgentsInstructionFile()` 等价流程一次，并只保留成功结果。每个返回项的 `filePath` 是经过安全解析的绝对路径，仅 API 内部使用；`displayPath` 是已验证的 workspace 相对 POSIX 路径，保留精确 Unicode/大小写，用作 `[agents_instructions]` 标签；`content` 已通过普通非软链/安全路径复验、二进制忽略、空内容跳过和单文件 32KB 截断等现有语义。
- `PromptStaticAssembler` 只消费 `enabledAgentsInstructions` 并拼接，不得再次读取 AGENTS。

`/skills/top-level` 不调用 `resolvePromptWorkspaceContext()`：它在请求中调用一次 `discoverWorkspaceContextFiles()`、读取 settings，并只调用 `resolveAvailableExternalSkills()`。因此 top-level 使用当前候选 ∩ enabled settings ∩ API 摘要读取成功的相同定义，却不读取 AGENTS 内容。detect 仍只展示当前候选和 settings 的选择状态，不读取 Skill 正文。

内容读取边界如下：

- Skill：候选发现不读正文；API 摘要读取只处理根 `SKILL.md` 的最小内容。只有模型实际调用 `skill` 工具时，Worker 才执行现有完整根正文处理、frontmatter 剥离、辅助文件递归枚举、扁平 `Skill files` 列表、40KB/10KB/50KB 输出预算和完整读取安全复验。
- AGENTS：唯一读取点位于 `resolvePromptWorkspaceContext()`；二进制检测、单文件 32KB 前缀截断、空内容跳过与读取失败跳过语义不变。
- 允许调整这两个流程的日志标签为 workspace 相对路径，避免绝对路径泄露；“读取机制不变”不要求函数逐行不改。
- 陈旧 settings 不自动修复；detect 不单独显示，下一次成功 PUT 才以完整选择自然清理。

`apps/api/src/modules/agent/agent.composition.ts` 当前的 `scanTopLevelSkillSummaries()` 仅适合 root 下一级目录。拟议由 `resolveAvailableExternalSkills()` 从候选/settings 交集读取精确根摘要，复用 `parseSkillFrontmatter()`。`buildSkillsInstructionSection()` 继续格式化 builtin 与 external 列表，但 external 条目必须恰好是 `availableExternalSkills`，其 ID 是裸 workspace 相对路径，不带 `workspace/` 或 `repo/` 前缀。

`prompt-static-assembler.ts` 改为取得 global prompts、`resolvePromptWorkspaceContext()` 返回的 `enabledAgentsInstructions`、builtin Skills 和 `availableExternalSkills`；不再读取 external roots 或按 repo 扫描，也不得再次扫描或读取 AGENTS。

### 内部 prompt-context exact allowlist

替换 `packages/shared/src/internal-contracts/agent-api-read.ts` 中的 `AgentPromptContextExternalSkillRootSchema`/`externalSkillRoots`：

```ts
const AgentPromptContextExternalSkillSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
  skillDirectoryPath: Type.String({ minLength: 1 }),
});

// AgentPromptContext 中
externalSkills: Type.Array(AgentPromptContextExternalSkillSchema)
```

- 每项只对应本 run 已启用、API 已重新验证的一个精确 Skill。
- `skillDirectoryPath` 仅在 API→Worker 内部协议中存在；不得出现在 system prompt、模型工具参数、Web UI、普通错误文本或日志中。
- 不得下发 workspace 根、repo 根或任何公共 Skill root。未在 `availableExternalSkills` 中的禁用、陈旧、已屏蔽或摘要读取失败 Skill 没有 allowlist 项。

`prompt-context-projector.ts` 与 `apps/agent-worker/src/runtime/tools/providers/builtin.ts` 只投影 `externalSkills`，删除 `externalSkillRoots` 适配。

### Worker resolver

修改 `apps/agent-worker/src/runtime/fileTools.ts` 的 `resolveSkillDirectory()` / `runSkillToolInternal()`：

- 通过新的共享 stable ID parser 区分 builtin 与 external。
- builtin 继续映射应用仓库 `skills/<skillDir>`。
- external ID 必须完整精确命中 `externalSkills`；未命中返回现有风格的归一化不可用错误，不透露该 ID 是否对应禁用或不存在文件。
- 命中后仍以 `workspacePath` 作为 containment root，对 `skillDirectoryPath` 复用 `validateSkillRoot()`、`assertCurrentRootDirectory()`、`O_NOFOLLOW`、打开前后 identity 校验和辅助文件路径校验。
- API 摘要读取不会取代 Worker：只有实际 `skill` 工具调用才执行 `readSkillRootContent()`、根正文/frontmatter 处理、辅助文件递归枚举与扁平列表、通用文本读取及 40KB/10KB/50KB 输出截断。
- 不重写上述 Worker 读取语义；本次只替换 ID 到精确授权目录的映射，并确保 API 已经读取过摘要也不会放松 Worker 复验。

### Prompt 注入与缓存

- AGENTS 以确定性相对路径排序，使用现有 `[agents_instructions] <relativePath>` section 注入原文；不添加层级、作用域、优先级或冲突解释。
- Prompt 外部 Skill、internal `externalSkills` 与 Worker allowlist 都使用同一 run 的 `availableExternalSkills`，不得各自重新计算或仅依据 settings。
- `RunPromptStaticCache` 保持现有按 run 缓存边界：每个新 run 首次构造时执行一次 resolver；设置/文件/候选结构变化在新 run 生效，已启动 run 不隐式刷新。

## 错误策略汇总

| 场景 | detect | PUT | 运行时/Worker |
|---|---|---|---|
| 根目录异常或扫描遇权限、未知 I/O | 409 `WORKSPACE_CONTEXT_SCAN_FAILED`，不返回候选 | 同样失败，不写入 | resolver 传播静态 Prompt 构造失败；不得以旧 settings 降级。 |
| 入口扫描中 `ENOENT`/`ENOTDIR` | 跳过并继续；成功时返回其余完整快照 | 重新扫描后的不存在项不在集合，提交它则 400 | 新 run resolver 交集不含该项；不回退。 |
| 软链、类型不符、越界、非法目录名 | 安全跳过；非法目录名剪枝 | 不可提交，提交则 400 | 当前候选交集不含该项，或 Worker 独立拒绝；不能越界。 |
| `builtin/.../SKILL.md` | 安全跳过，不注册 | 不可提交，提交则 400 | 无 allowlist，无法读取。 |
| 非法、重复或未知 selection | 不适用 | 400 `INVALID_CONTEXT_SELECTION`，不写入 | 不适用。 |
| 并发合法 PUT | 不适用 | last-write-wins，一次完整写入 | 不适用。 |
| 陈旧 enabled setting | detect 不显示该项 | 成功完整 PUT 自然清理 | 当前候选/settings 交集不含该项。 |
| 摘要读取为二进制、无权限、读取或安全校验失败 | detect 仍展示候选 | 可保存该候选 | 当前 run 不加入 `availableExternalSkills`、Prompt 或 allowlist；按现有安全日志诊断。 |
| 猜测禁用 Skill ID | 不适用 | 不适用 | Worker 归一化拒绝。 |

## 前端模型与交互

`AgentClientPane.vue` 继续使用上下文管理弹窗，替换其 source/root model：

```ts
type ContextSkillRow = {
  skillId: string;
  skillFilePath: string;
  enabled: boolean;
};

type ContextAgentsRow = {
  path: string;
  enabled: boolean;
};
```

- 打开弹窗仅调用一次 `detectWorkspaceContextFiles(workspaceId)`；成功取得完整快照前禁止保存。
- Skill 行显示 `skillId`（可附 `skillFilePath`），AGENTS 行显示 `path`；不显示绝对路径、repoId、rootDir 或 top-level count。
- checkbox 精确以 `skillId`/`path` 为 value，不以展示文本作为键。
- 保存只调用一次 PUT，提交两个完整选择数组；成功后关闭并发送既有 `agent-settings-updated` 事件。
- detect 或保存因扫描失败/400 失败时保留弹窗与未保存勾选，显示安全的服务端错误；不提供 partial snapshot 或并发冲突 UI。
- 显示“更改将在新 run 中生效”。

## 受影响代码与测试

| 模块 | 当前相关符号/文件 | 拟议工作 |
|---|---|---|
| workspace service | `apps/api/src/modules/workspaces/workspace.service.ts`：旧 detect/settings、`listEnabledWorkspaceAgentsInstructions()`、`listEnabledWorkspaceExternalSkillRoots()` | 接入完整扫描、V2 settings 与精确 runtime resolver，删除旧 root/repo 模型。 |
| routes | `apps/api/src/modules/workspaces/workspaces.routes.ts` | 删除旧路由，注册 unified detect/PUT，补 400/409 response schema。 |
| shared contracts | `packages/shared/src/contracts/workspaces.ts`、`packages/shared/src/skills-protocol.ts` | 新路径 parser、V2 schema、新 stable Skill parser。 |
| composition/prompt | `apps/api/src/modules/agent/agent.composition.ts`：`readAgentsInstructionFile()`、`scanTopLevelSkillSummaries()`；`prompt-static-assembler.ts`、`run-prompt-static-cache.ts` | 由 Prompt resolver 唯一读取 AGENTS；新增根摘要读取子流程；assembler 仅拼接返回结果与 allowlist。 |
| internal contract | `packages/shared/src/internal-contracts/agent-api-read.ts`、`prompt-context-projector.ts` | `externalSkills` 替换 `externalSkillRoots`。 |
| Worker | `apps/agent-worker/src/runtime/fileTools.ts`：`resolveSkillDirectory()`、`runSkillToolInternal()`、`readSkillRootContent()`；`tools/providers/builtin.ts` | 新 parser 与 exact allowlist；仅实际 `skill` 调用保留完整根正文/辅助文件读取安全链。 |
| Web | `apps/web/src/shared/api/api.ts`、`AgentClientPane.vue` | 一次 detect/PUT、行级候选、完整扫描失败状态与新 run 提示。 |
| 测试与作者说明 | `workspace.service.test.ts`、`agent-global-prompts-workspace.integration.test.ts`、`prompt-static-assembler.test.ts`、`fileTools.test.ts`、`builtin.skill-args.test.ts`、`skills/skill-authoring/SKILL.md` | 删除旧 root/repo 断言，覆盖新规则并同步 Skill 作者说明。 |
