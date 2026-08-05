# Skills 扁平文件加载协议 V2：架构与实施方案

**状态：proposed**
**协议依据：** [protocol.md](./protocol.md) 是 V2 唯一协议真源。本文只映射当前代码、给出实施职责和顺序；容量、frontmatter、`file_path`、排序、错误和输出语义均以该文件为准。

## 架构目标与不变边界

V2 将当前“一个 `id` 可指向 skill 节点或文件”的读取模型改为“`skill_id` 传入顶层根的稳定逻辑标识，`file_path` 选择根内文件”。同一原子交付必须同步 API schema/description/prompt、Worker、runner、测试和 authoring 手册。

本期不改变：

- builtin/workspace/repo 的根来源与稳定命名空间；
- external roots 候选发现、启用设置、默认启用策略和 `topLevelSkillCount`；
- prompt context 的 `externalSkillRoots` 传递；
- `AgentService` 的 run 级静态 prompt cache 生命周期与“后续 run 生效”语义。

## 当前调用链

```text
Skills root
  └─ <top-level-skill>/SKILL.md
        │
        ▼
API：scanReadableTopLevelSkills()
  - root 一级非 symlink 目录
  - 直属 SKILL.md：非 symlink 普通文件、readFile 成功、原始 bytes 无 NUL
        ├─ scanTopLevelSkillSummaries() / listWorkspaceTopLevelSkills()
        └─ AgentService.getPromptContextForRun()
             - schema: { id }
             - buildSkillsInstructionSection(): by id
             - runPromptStaticCache
        │
        ▼
Worker：BuiltinToolProvider.execute("skill")
  - args.id → runSkillTool({ id })
        │
        ▼
runSkillTool()
  - id 可指节点或文件
  - 嵌套 SKILL.md 是子 skill
  - 根节点递归返回 children
        │
        ▼
runner 渲染 id/type/name/description/children/content
```

## V2 目标调用链

```text
Skills root
  └─ <skill-dir>/SKILL.md
        │
        ▼
API 顶层发现（口径不变）
  - scanReadableTopLevelSkills() 产生稳定逻辑标识和展示元数据
  - 根资格不调用 Worker classifyTextSample()
        │
        ▼
API prompt context（缓存模型不变）
  - schema: { skill_id, file_path? }
  - schema/tool description/prompt 使用同一 V2 术语
        │
        ▼
Worker provider
  - args.skill_id + optional args.file_path
        │
        ▼
runSkillTool({ skillId, filePath, externalSkillRoots })
  - 等价根资格检查后定位一个顶层根
  - file_path 判定：根读取或严格原始 POSIX 文件路径
  - 根读取：根专用完整 UTF-8 源读取/解析 + 正文 + 全量扫描后排序的扁平 Skill files 前缀
  - 指定读取：一个安全普通辅助文件的 Worker 规范化文本内容
        │
        ▼
runner 渲染 skill_id/file_path/truncated/content
```

## 实体设计

```ts
type PromptSkillSummary = {
  skill: string;
  displayName: string;
  // 仅模型提示词语义；空描述省略。
  description?: string;
};

type WorkspaceTopLevelSkillItem = {
  name: string;
  // 保持既有 shared contract：空语义描述也必须为 ""。
  description: string;
};

type ParsedRootFrontmatter = {
  hasCompleteBoundaries: boolean;
  name: string;
  description: string;
  body: string;
};

type SkillFilesSection = {
  content: string;
  paths: string[];
  truncated: boolean;
};

type SkillToolResult = {
  skill_id: string;
  file_path: string; // 根读取时精确为 "SKILL.md"
  content: string;
  // root body、requested file、Skill files section 或 final content fallback 任一截断即 true
  truncated: boolean;
};
```

`SkillNodeChild`、`type: "skill"`、`children`、子 skill metadata 均不是 V2 实体，必须删除或停止从 V2 路径生成。

```ts
const trimAsciiSpaceTab = (value: string): string =>
  value.replace(/^[\u0020\u0009]+|[\u0020\u0009]+$/g, "");

// 供 prompt summary 与 Worker 使用同一字符/segment 判定语义。
const isValidSkillIdentifierSegment = (segment: string): boolean => {
  // 先要求 well-formed Unicode scalar sequence，再拒绝空、点段、首尾空白、
  // U+005C、U+0060、Cc、Cf、U+2028、U+2029。
};
```

`trimAsciiSpaceTab()` 是稳定 identifier 的唯一整体修整 helper：只删除两端 U+0020 SPACE/U+0009 TAB，绝不能用 JavaScript `trim()`、`trimStart()` 或 `trimEnd()`。外部 `skill_id` 经该 helper 规范化后，Worker 内部使用 camelCase `skillId`；外部 `file_path` 对应 Worker 内部 `filePath`。实现还应提供 `isWellFormedSkillString()` 或等价公共 helper，拒绝 lone surrogate；prompt summaries、Worker identifier/file_path 校验与 `listWorkspaceTopLevelSkills().items` 过滤必须复用同一语义。

## 模块与代码集成点

| 文件 | 当前符号 | V2 实施职责 |
|---|---|---|
| `apps/api/src/modules/agent/top-level-skill.ts` | `scanReadableTopLevelSkills()` | 保持当前顶层根资格：一级非 symlink 目录、直属非 symlink 普通 `SKILL.md`、`readFile` 成功、无 NUL、`Buffer.toString("utf8")`。不得用辅助文件文本分类扩大/收紧 `topLevelSkillCount`。 |
| 同上 | `parseSkillFrontmatter()` | 改为与 Worker 共用“已解码文本” helper，或使用完全一致的测试向量；支持 protocol 规定的 LF/CRLF、BOM、首个结束边界、引号、大小写 key 和重复字段。API 仍以 `readFile + Buffer.toString("utf8")` 提供已解码文本。 |
| `apps/api/src/modules/agent/agent.service.ts` | `scanTopLevelSkillSummaries()`、`buildSkillsInstructionSection()` | 使用 `isValidSkillIdentifierSegment` 与 well-formed Unicode 公共/等价 helper 生成可调用 mapping；物理发现/count 不变，但目录名或 external-root mapping segment 不合规的条目不得注入 prompt，记录受控诊断。对模型公开文案必须使用 `skill_id` 作为工具字段，同时保留 stable skill identifier 的领域术语。 |
| 同上 | `toolArgsSchema("skill")`、`toolDescription("skill")`、`buildSkillsInstructionSection()` | 原子切换为 `{ skill_id, file_path? }`；工具级 description、`file_path` description 与系统提示词必须一致说明 omit `file_path`、empty string or string containing only spaces/tabs、or exactly `SKILL.md` 均为根读取，并要求从 `Skill files` 逐行完整复制到 `file_path`；不得保留可调用 `id`、`skill` 或 `path`。 |
| 同上 | `getPromptContextForRun()` / `runPromptStaticCache` | 缓存更新后的 schema、description、摘要和 external roots；同 run 静态语义不变。 |
| `apps/api/src/modules/workspaces/workspace.service.ts`、`packages/shared/src/contracts/workspaces.ts` | `scanTopLevelSkillCount()`、`listWorkspaceTopLevelSkills()`、`WorkspaceTopLevelSkillItemSchema` | 保持 count 使用物理顶层发现口径。`listWorkspaceTopLevelSkills().items` 必须用 segment + well-formed Unicode 公共/等价 helper 过滤不可生成合规 identifier 的条目；不新增 schema 字段，因此 `items.length` 可小于 `topLevelSkillCount`，UI 无 callable 状态。shared contract 的 `name`、`description` 仍为必填 string，空语义 description 序列化为 `""`。 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | `case "skill"` | 必填 `args.skill_id`，接收 optional `args.file_path`，并映射为内部 `skillId` / `filePath`；schema 不得以 `minLength` 先行拒绝空字符串，令 Worker 将缺失/空/ASCII SPACE/TAB-only `skill_id` 映射为 `skill is required`；非字符串 `file_path` 归一为 `invalid skill path`；不得读取 `args.id`、`args.skill` 或 `args.path`。 |
| `apps/agent-worker/src/runtime/fileTools.ts` | `runSkillTool()` | `skillId` 仅定位顶层根；使用 `isValidSkillIdentifierSegment` 公共/等价 helper 执行精确标识解析，随后作等价根资格检查、逐步 `filePath` 算法、固定错误合同、根正文/section/最终 content 容量控制；成功时序列化外部 `skill_id` / `file_path`。 |
| 同上 | 根专用读取 helper、`parseSkillFrontmatter()` | 新增根专用 helper：完整读取 raw bytes、检查全文件 NUL、`Buffer.toString("utf8")` 解码、调用已解码文本 frontmatter helper；不得设置 V2 根源大小上限，根不得先走 `classifyTextSample()` 或 `readTextFileCapped()`，且正文不做通用行规范化或长行截断。 |
| 同上 | `classifyTextSampleFromHandle()`、`readTextFileCappedFromHandle()` 或等价 fd-based core | 从既有 `classifyTextSample()`、`readTextFileCapped()` 抽取同一算法/输出行为；V2 的列表资格和直接指定读取只能以已验证 handle 调用 core，不能按 path reopen。包装/扩展读取结果暴露 `truncatedByBytes`、`hasMoreLines`、`truncatedByLineLength`，并将三者 OR 到 V2 `truncated`。 |
| 同上 | 辅助文件安全读取 helper | 列表资格与直接读取共用：保存目标 `lstat` 的 `dev` + `ino` identity，支持时 `O_NOFOLLOW` 打开，以 `FileHandle.stat()` / `fstat` 重检 regular file 与 identity；分类和读取复用同一 handle，列表完成 fd 采样后关闭；能力缺失必须有等价防护、平台说明和测试。 |
| 同上 | `SkillNodeChild`、`isRootSkillNode()`、`collectRecursiveRootSkillChildren()` | 删除/停用旧子节点逻辑，替换为全部候选扫描/资格检查、501 有界选择、固定 comparator 与 section 前缀序列化。 |
| 同上 | `sanitizeSkillToolError()` | 只公开 protocol 冻结的英文字符串；内部诊断不得进入工具返回。 |
| `apps/agent-worker/src/runtime/runner.ts` | skill success branch | 只渲染 `skill_id/file_path/truncated/content`；headers 后按 content 原值输出，空字符串不得生成旧 `(empty file content)` / `(empty skill content)` 占位。 |

## Worker 详细实施方案

### 根定位与资格

- 保留现有 builtin/workspace/repo 标识到 root 的映射及 `externalSkillRoots` 选择；未启用 root 不得回退扫描。
- `skill_id` 缺失、空字符串或 ASCII SPACE/TAB-only 时返回 `skill is required`；非字符串返回 `invalid skill identifier`。Provider 将其交给内部 `skillId`；其余输入仅先经 `trimAsciiSpaceTab()`，再只接受 `builtin/<skillDir>` 的 2 段、`workspace/<rootDir>/<skillDir>` 的 3 段、`repo/<repoId>/<rootDir>/<skillDir>` 的 4 段。不得使用 JavaScript `trim()`；前后 CR/LF、U+2028/U+2029、U+FEFF、NBSP 必须保留至 segment 校验并返回 `invalid skill identifier`。所有 segment 必须 well-formed，并通过 `isValidSkillIdentifierSegment`：拒绝 U+005C、U+0060、`Cc`、`Cf`、U+2028/U+2029、点段和首尾 Unicode whitespace。mapping 必须精确大小写匹配，不做 normalize；后续 mapping、结果 `skill_id` 均使用该 ASCII 包裹移除后的规范值。结构/字符非法为 `invalid skill identifier`；mapping 未启用/不存在或顶层目录不存在为 `skill not found`。
- 解析出顶层 skill 目录后，先区分目录不存在，再仅对仍存在目录按 `scanReadableTopLevelSkills()` 的精确口径检查直属根文件。
- prompt 缓存后目录删除仍为 `skill not found`；已定位且仍存在的目录中，根 `SKILL.md` 缺失、symlink、非普通、不可访问、读取失败或含 NUL 才是 `skill root is not readable`。
- Worker 根文件以专用 helper 完整读取：在完整 raw bytes 上先检查 NUL，再按 `Buffer.toString("utf8")` 解码并调用与 API 共用/等价的 helper；不得设置 V2 source-size cap。对同一未变更且可生成合规 identifier 的根，API 可发现即 Worker 可根读取；非法 identifier 的物理发现条目在 prompt/Worker mapping 阶段排除；仅发现后的竞态、权限变化或中止可以打破其余条目的关系。
- API/Worker 都使用同一已解码文本 frontmatter helper，或同一向量测试其等价行为；首个有效结束 `---` 结束 block，只要边界完整就剥离 block。根正文保留解码后的 CRLF/孤立 CR，直到 UTF-8 预算裁剪。

### file_path、安全与文件资格

- 先按 protocol 的四步算法区分根读取与非根 `file_path`；仅 `skill_id` 的非空验证可 trim，非根 `file_path` 的原始值不得 trim/normalize 后接受。
- 为 skill 新增专用 helper，避免改变 read/write 的通用 `ensureSafeRelativePath()` 行为。
- 根读取仅限 `file_path` 缺失、空字符串或仅由 SPACE/TAB 组成的字符串、以及原始精确 `SKILL.md`；不得以 `filePath.trim()` 或其他笼统 whitespace 判定。CR/LF、U+2028/U+2029、U+FEFF、NBSP-only 都进入严格验证并失败。
- 对非根 `file_path` 的每个 well-formed segment 先拒绝 lone surrogate、U+0060、`Cc`、`Cf`、U+2028/U+2029，再作词法 root-inside、每级 lstat、root/target realpath root-inside、普通文件和文本资格检查；禁止反引号使固定 ```text fence 不能被路径注入关闭或扰乱。
- POSIX 遍历用 buffer filename 或等价方式做 fatal UTF-8 decode/re-encode byte-for-byte round-trip；不能无损表示的物理 segment 跳过并记录受控诊断。原生字符串平台拒绝非 well-formed JS 字符串，但 U+FFFD 本身允许；每条列出路径必须可用相同字符串回读。
- 对列表与指定读取共享同一辅助文件安全/文本资格 helper；dotfile/dot-directory 不特殊过滤。直接读取不能信任枚举时状态，必须重新完成检查。
- 打开前完成 lexical/root realpath 边界与父级非 symlink 检查，对目标 `lstat` 为普通文件时保存 `dev` + `ino` identity；平台不能可靠提供时选择可验证等价 identity。
- 平台支持时以 `O_NOFOLLOW` 打开；打开前后重检 root/target 边界和父级 symlink。随后以 `FileHandle.stat()` / `fstat` 确认 fd 仍是普通文件、identity 与打开前相同；symlink 替换、different inode 或其他不安全对象一律映射为 `skill path is not a readable file`。
- 从现有 path-based `classifyTextSample()` / `readTextFileCapped()` 抽取 `classifyTextSampleFromHandle()` / `readTextFileCappedFromHandle()` 或等价 fd-based core。直接读取在 identity 重检后以**同一个**已验证 `FileHandle` 完成分类与内容读取；枚举资格也由该安全打开 helper 用 fd 采样分类后关闭；V2 任何路径不得 reopen。若缺少 `O_NOFOLLOW`、identity 或 fd stat 能力，必须提供等价防护、平台说明和测试，不得静默降级。
- 指定路径的 failure 必须映射到 protocol 的精确公开字符串；内部 errno、真实路径仅用于受控日志。

### 全量扫描、排序与 section 构造

- 递归扫描所有可安全遍历的后代候选，过程中检查 `AbortSignal`；不得因为 500 项或 section 输出预算而停止扫描；它们只是输出预算。
- 后代 I/O、不可读或消失时：跳过文件或子树、记录受控诊断、继续扫描兄弟项；根读取保持成功。
- 外部结果必须等价于全量合格路径的固定 comparator 排序前缀，但无需把全体路径同时保存在内存。扫描时维护 comparator 最小的 `MAX_SKILL_FILE_PATHS + 1` 条，即最多 501 条，以及总数或等价 `hasMore`；每个新合格路径进入时淘汰保留集合中更大的路径，扫描和资格检查仍持续至所有候选结束。
- 扫描结束后使用 `(a < b ? -1 : a > b ? 1 : 0)` 排序已保留集合；不得使用 `localeCompare()`。前 500 条必须等于概念全量排序前 500 条，第 501 条/`hasMore` 还必须在 10 KiB 先于 500 条耗尽时正确标记遗漏。
- 按 500 项和 10 KiB 的完整 section UTF-8 预算取最大确定性前缀。`body.length > 0` 时 section 从 `"\n\n---\n\n## Skill files\n\n"` 开始，否则从 `"## Skill files\n\n"` 开始；不得 trim body。前导、wrapper、fence、换行、空列表文本和截断提示都纳入 `Buffer.byteLength` 计算。无合格路径时输出空列表文字；合格路径非空但前缀为 0 时只输出标题与 code block 外截断提示，不输出空 fence 或空列表文字。
- 根正文超限时，在有效 UTF-8 边界截出最长前缀并精确追加一次 `ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated."`，两者合计不超过 40 KiB；不根据前缀行尾改变 suffix。随后构造 section，并令 `content = body + section`，不再插入任何字符。因 `body <= 40 KiB` 且 `section <= 10 KiB`，正常算法必须满足 50 KiB。
- 最终 50 KiB 检查只是防御性 invariant assertion，不是常规分支。若触发，记录内部 invariant-violation，只缩减 section，绝不侵占正文，且不得产生半行路径或未闭合 fence，也不得改变公开错误。

### 结果、截断与渲染

- `truncated` 不是选择性字段：root body、requested file、section 或 final fallback 任一截断即 `true`。
- 指定文件由同一已验证 handle 的 fd-based `classifyTextSampleFromHandle()` / `readTextFileCappedFromHandle()` 或等价 core 产生规范化文本内容：BOM 按 decoder 行为移除，CRLF/孤立 CR 规范为 LF，长行和既有预算依当前读取器处理；包装/扩展结果保留 `truncatedByBytes`、`hasMoreLines`、`truncatedByLineLength`，三者 OR 后写入 V2 `truncated`。嵌套 `SKILL.md` 只是不解析、不剥离 frontmatter，不是保真例外。
- 成功实体精确为 `{ skill_id, file_path, content, truncated }`；根读取返回 `file_path: "SKILL.md"`。Runner 在 header 回显 `skill_id`、`file_path`、`truncated`，然后按 `content` 原值输出；headers 不计入 50 KiB content 预算。`content === ""` 时结果保持空字符串，不得输出 `(empty file content)`、`(empty skill content)` 或其他业务占位。

## 性能、缓存与安全取舍

- V2 不缓存根正文、辅助文件正文或 `Skill files`；run 级缓存仍只处理静态 prompt、摘要和 external roots 映射。
- 全量扫描是确定性排序和预算前缀的前提，不能因输出预算提前停止；501 有界选择将路径保留内存限制在固定值，同时仍保证概念全量排序的外部前缀。代价通过不读取所有文件全文、使用现有文本采样、跳过失败项、支持 AbortSignal 和固定输出上限控制。
- 全量扫描的文件系统竞态不承诺“列出后永远可读”；协议承诺枚举时资格。直接读取时必须再次检查并返回固定脱敏错误。
- 为保持既有发现合同，本期不新增根源大小门槛；完整根读取的成本与 API 当前完整发现读取一致。若未来需要 source cap，必须在 API 发现、prompt、count 与 Worker 一致地另立版本设计。辅助文件仍继承现有流式读取器，不复制其内部常量为 V2 配置。
- path 检查比旧协议严格，但作用域限于 skill；不得顺带改变其他文件工具的输入语义。

## 实施顺序

| 阶段 | 工作项 | 完成条件 |
|---|---|---|
| 协议向量 | 编写/共享 frontmatter、标识、path、错误和 UTF-8 裁剪测试向量 | API 与 Worker 可证明边界/字段行为等价，含结束边界在大源文件后段的完整 frontmatter、U+0060/`Cc`/`Cf`/U+2028/U+2029 字符向量。 |
| Worker 基础 | 实现等价根资格、完整根专用读取 helper、逐步 filePath helper、错误映射、辅助文件资格与 fd 读取 helper | 根/直接 file_path 均无旧 node 分支；根不依赖通用辅助读取器或 V2 source-size cap；辅助读取具备 identity/fd TOCTOU 重检。 |
| 列表与容量 | 实现全量扫描、501 有界选择、固定排序、section/max-content 序列化与精确 `truncated` | 输出等价于概念全排序前缀，预算/fence/UTF-8、suffix 与所有截断来源均可断言。 |
| 工具接入 | 修改 provider、`runSkillTool` 结果、runner 渲染 | 只接受外部 `skill_id`/`file_path`，映射内部 `skillId`/`filePath`，并只输出 V2 `skill_id`/`file_path` 字段。 |
| API 接入 | 修改 schema、description、prompt、摘要展示回退 | 模型所见 `{ skill_id, file_path? }` 合同与 Worker 完全一致。 |
| roots 回归 | 验证 external roots、`topLevelSkillCount`、静态缓存 | 仅读取协议变化，无 roots 模型回归。 |
| 文档与验证 | 重写 authoring 手册、执行定向测试/typecheck/build | 满足 `test-and-acceptance.md`。 |

## 原子交付要求

合并请求必须同时包含：Worker 根专用/辅助文件规范化 V2 行为和固定错误、API schema/description/prompt、workspace shared contract 的 `description: ""` 兼容与空值 UI 行为、runner、测试、`skills/skill-authoring/SKILL.md` 重写、迁移说明。不得出现 schema 已切换而 Worker 仍读 `id`、`skill` 或 `path`，根读取仍依赖 `readTextFileCapped()`、Worker 已返回列表但 runner 仍渲染 `children`、或 authoring 手册仍教旧协议的中间状态。
