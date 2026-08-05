# Skills 扁平文件加载协议 V2

**状态：proposed**

> 本目录定义 Skills 扁平文件加载协议 V2（下称“V2”），是本项改造的实现、代码审查和验收的唯一基线。
>
> 在读取协议、工具参数、子目录 `SKILL.md` 语义或文件列表语义上，本目录优先于历史设计文档。本文档不表示任何代码已经实现，也不表示任何测试已经通过。

## 背景与问题

Skills 用于将稳定、可按需读取的知识从常驻系统提示词中拆出：系统提示词仅注入顶层摘要，模型在需要时调用 `skill` 工具读取完整说明或辅助文件。

当前实现已经具备 builtin、workspace、repo 三类 roots、顶层摘要发现和按需读取能力，但读取协议把“skill 节点”和“文件”混合在单个 `id` 中：

- 任意包含 `SKILL.md` 的目录都会被视为 skill 节点；
- 子目录 `SKILL.md` 也被解析为元数据，而不是普通文件；
- 根节点读取会返回递归 `children`，模型还需从结构化子项中转换出后续读取目标；
- 工具、系统提示词和内置 authoring 手册均使用旧的 `id`、子 skill、`children` 概念。

该模型让目录名和 `SKILL.md` 文件名隐式改变协议语义，也使模型必须判断一个完整标识究竟代表节点还是文件。V2 将其收敛为“一个顶层 skill 根 + 根说明 + 按相对路径读取的普通文本文件”，从而减少作者和模型的认知负担。

## 目标

- 将一个顶层目录定义为一个独立 skill；根 `SKILL.md` 是唯一具元数据语义的文件。
- 使用 `skillId` 传入稳定逻辑标识选择 skill，并使用可选相对 `filePath` 选择 skill 内文件。
- 根读取返回根正文和可直接复制为 `filePath` 的扁平文件列表，而不是树或 `children`。
- 仅将 `name`、`description` 作为可选展示元数据，不因其缺失或异常阻止 skill 加载。
- 保持 builtin、workspace、repo roots 的发现、启用、命名空间和 run 级静态缓存模型。
- 明确文本、安全、容量、错误与迁移边界，使协议可独立实现、审查和验收。

## 非目标

本期不做以下事项：

- 不改造 external roots 的候选发现、启用设置、UI 管理、`topLevelSkillCount` 计算口径或默认启用策略。
- 不支持旧 `{ "id": "..." }` 工具参数，也不提供运行期兼容转换。
- 不引入子 skill、子 skill 元数据、`children`，或“目录即工具读取目标”的新替代概念。
- 不引入完整 YAML frontmatter 解析器；仅保留轻量、单行 `name` / `description` 解析。
- 不将 `Skill files` 列表作为访问白名单，不对未列出的合法文件追加权限限制。
- 不缓存根正文、辅助文件正文或文件列表；不改变同一 run 的静态 prompt 缓存语义。
- 本设计阶段仅更新本目录的协议文档；**实现 V2 时必须**原子同步业务代码、测试、prompt 与 `skills/skill-authoring/SKILL.md`。历史设计文档仅保留决策记录，不要求为此回写。

## 适用范围

V2 适用于每个已生效的 Skills root 下的顶层 skill：

- builtin：项目仓库中的 `skills/<skill-dir>/SKILL.md`；
- workspace external root：`<workspaceRoot>/<rootDir>/<skill-dir>/SKILL.md`；
- repo external root：`<repoRoot>/<rootDir>/<skill-dir>/SKILL.md`。

“顶层”指某个 Skills root 的一级子目录。V2 不扩大外部 root 的发现范围，也不改变 external root 仅在启用后进入 prompt context 的规则。

## 术语

| 术语 | 定义 |
|---|---|
| Skills root | 容纳多个顶层 skill 的目录；来源可为 builtin、workspace 或 repo。 |
| skill 根目录 | Skills root 下一个顶层 skill 的目录，例如 `skills/skill-authoring/`。 |
| 根 `SKILL.md` | skill 根目录直属的 `SKILL.md`；唯一具有 V2 元数据语义的文件。 |
| 辅助文件 | skill 根目录内除根 `SKILL.md` 外的任何文件；含任意深度的 `SKILL.md`，均按普通文本处理。 |
| 稳定逻辑标识 | 不暴露绝对路径、可供 `skillId` 参数传入的标识，如 `builtin/skill-authoring`。 |
| 根读取 | `filePath` 缺失、为空字符串或仅由 U+0020 SPACE/U+0009 TAB 组成，或精确为 `SKILL.md` 时的读取。 |
| 指定文件读取 | `filePath` 为其他有效相对路径时，对一个辅助文件的读取；返回现有 Worker 通用文本读取器产生的规范化文本内容。 |
| `Skill files` | 根读取结果末尾的扁平、可直接调用的辅助文件路径清单。 |
| 文本资格 | 文件同时满足 V2 安全限制和当前文本识别/读取限制，可被 skill 工具作为文本返回。 |

## 业务逻辑总览

```text
顶层 skill 摘要发现
  └─ 扫描每个生效 root 的一级目录
      └─ 根目录直属、安全且可读的 SKILL.md => 一个有效 skill
           └─ 解析可选展示元数据，向 prompt 注入稳定逻辑标识

模型调用 skill 工具
  ├─ skillId：传入一个已发现的稳定逻辑标识
  └─ filePath：
      ├─ 缺失 / 空 / 仅 spaces/tabs / SKILL.md
      │   └─ 根读取：根正文（按边界完整 frontmatter 剥离）+ Skill files
      └─ 其他有效相对路径
          └─ 指定文件读取：返回当前 Worker 通用文本读取器产生的规范化文本内容
```

V2 的关键原则是：`skillId` 只传入并定位顶层 skill 根的稳定逻辑标识，`filePath` 只定位该根内的文件；目录不是可读取目标；任意嵌套 `SKILL.md` 都不是子 skill。根读取中的文件发现清单是按完整相对路径排序的扁平列表，不采用树形结构，因为模型必须能不经路径转换直接完整复制某一行到 `filePath`。

## 关键决策总表

| 决策 | 已冻结口径 | 取舍原因 |
|---|---|---|
| 定位参数 | `skillId` 传入 `builtin/...`、`workspace/...`、`repo/...` 稳定逻辑标识 | 展示名可变且可重名；逻辑标识可跨来源无歧义定位。 |
| 参数切换 | 一次性从 `{ id }`、未发布的 `{ skill, path? }` 和 `{ skill_id, file_path? }` 切换至 `{ skillId, filePath? }`；无兼容层 | 避免模型在双协议间选择错误；旧子 skill 无法无歧义兼容。 |
| 元数据边界 | 仅根 `SKILL.md` 有元数据语义 | 消除“文件名决定子 skill”的隐式模型。 |
| frontmatter | 可选、容错、仅展示；不使用完整 YAML | 不让元数据问题阻断知识读取，同时避免新增解析依赖。 |
| 根源读取 | API 与 Worker 均以完整根文件、全文件 NUL 检查和 `Buffer.toString("utf8")` 等价语义解析根；Worker 不走辅助读取器 | 保持“API 可发现即 Worker 可根读取”的合同，同时避免通用读取器预截断、长行和换行规范化破坏根 frontmatter 与正文语义。 |
| 辅助文件读取 | 继承 `classifyTextSample()` 与 `readTextFileCapped()` 的规范化文本行为 | 复用成熟的编码、二进制和输出限制能力；不另建字节或换行保真协议。 |
| 根读取发现 | 正文后追加扁平 `Skill files` | 每行路径可直接完整复制到 `filePath`；不采用树形结构，避免模型把层级转换为参数路径。 |
| 文件组织建议 | 少量文件优先平级；仅大型或明显分类时多级 | 降低路径复杂度，保留大型 skill 的可维护性。 |
| 文件列表资格 | 只展示与读取共享安全/文本资格的文件 | 承诺“列表每一行原则上可直接读取”。 |
| 安全 | POSIX 相对 path + well-formed Unicode + lexical/realpath 双重边界 + 禁止 symlink、U+0060、`Cc`、`Cf`、U+2028/U+2029 | 防止路径穿越、编码失真和链接绕过，并确保固定 Markdown fence 不能被文件名注入关闭或扰乱。 |
| 标识语法 | 仅 `trimAsciiSpaceTab()` 移除整体两端 ASCII SPACE/TAB 后，接受 `builtin/<skillDir>`、`workspace/<rootDir>/<skillDir>`、`repo/<repoId>/<rootDir>/<skillDir>` 的 2/3/4 段精确形状；每段必须 well-formed，且拒绝 U+0060、`Cc`、`Cf`、U+2028/U+2029 | 容忍轻量 ASCII 包裹但不让 JS `trim()` 绕过控制/格式字符限制；将结构非法与映射未命中稳定分流为 `invalid skill identifier` / `skill not found`。 |
| description 兼容 | prompt 中空描述省略；workspace API/shared contract 仍返回 `description: ""`，UI 不渲染空描述 | 避免读取协议改造造成现有 shared API contract 的 optional-field breaking change。 |
| 容量与截断 | UTF-8 字节计量：正文 40 KiB、完整列表段 10 KiB、最终 content 50 KiB、最多 500 路径；根截断使用固定 suffix；任一部分截断即 `truncated: true` | 固定正文优先和确定性列表预算，保护上下文并保留可调用文件发现能力。 |
| section 拼装 | `body.length > 0` 时 section 自带前导分隔片段，`content = body + section`；空前缀与无候选路径分开序列化；50 KiB final fallback 只作防御性 invariant protection | 防止仅含空格或行尾的正文被错误 trim、分隔符漏算或双算；避免第一条路径无法装入预算时伪造空列表。 |
| 有界列表选择 | 扫描/资格检查全体候选，外部结果等价于全量全局排序；实现首选仅保留 comparator 最小的 501 条与 `hasMore` | 避免超大目录将“全量语义”误实现为无界内存占用，同时仍精确得到 500 项/10 KiB 前缀。 |
| 读时安全 | 列表与直接读取共用 fd 读取 helper：`lstat` identity、`O_NOFOLLOW`、`FileHandle.stat()` / `fstat` 二次确认，以及同一 handle 的分类/读取 core | 防止 lstat/realpath 与实际读取之间的 TOCTOU 替换、链接绕过和路径重开。 |
| 根资格、roots 与缓存 | 顶层发现/`topLevelSkillCount` 沿用 `scanReadableTopLevelSkills()`；Worker 用等价检查；维持 external roots 与 run 静态缓存模型 | 防止 prompt 可见 skill 无法加载，并将改造限制在读取协议。 |

## 已冻结的精确运行边界

协议细节以 [protocol.md](./protocol.md) 为准；以下摘要用于避免实现时遗漏关键约束：

- 所有容量使用 `Buffer.byteLength(text, "utf8")`，根正文、完整 `Skill files` 段和最终 `content` 分别受 `40 KiB`、`10 KiB`、`50 KiB` 常量约束；最多输出 500 个路径。
- 根正文超限时，body 精确为最长有效 UTF-8 前缀加一次 `ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated."`；两者合计不超过 40 KiB，不能因前缀行尾改变 suffix。
- `truncated` 在根正文、指定文件、文件列表或最终 content 兜底任一截断时均为 `true`，否则为 `false`。指定文件必须将 `truncatedByBytes || hasMoreLines || truncatedByLineLength` 映射为 V2 `truncated`。
- `body 非空` 精确为 `body.length > 0`，不得 trim；只有空格、LF、CRLF 或孤立 CR 的正文仍使用 `"\n\n---\n\n## Skill files\n\n"` 前导。`content` 精确为 `body + section`。正常算法的 `40 KiB + 10 KiB` 是 50 KiB 的数学不变量，最终检查只处理内部 invariant violation，且只能缩减 section。
- 全体合格路径为空时 section 输出 `No additional readable text files.`；若合格路径非空却连第一条完整路径也无法装入 10 KiB，最大确定性前缀可以为 0，section 只输出标题与 code block 外的截断提示，不输出空 code block 或空列表文字，且 `truncated: true`。
- 遍历必须完成全部安全候选的扫描与资格检查，结果等价于全量固定 UTF-16 code-unit 排序再取前缀；不得因输出预算停止扫描。首选有界选择，仅保留最小 501 条及总数/`hasMore`，而不是要求全体路径同时在内存中。
- `filePath` 仅对缺失、空字符串或仅由 U+0020 SPACE/U+0009 TAB 组成的字符串、或原始值精确为 `SKILL.md` 执行根读取；schema、工具级 description 与系统提示词必须同样表述为 omit `filePath`, pass an empty string or a string containing only spaces/tabs, or pass exactly `SKILL.md`。换行、U+2028/U+2029、U+FEFF、NBSP-only 及其他输入不得 trim/normalize 后接受。
- `skillId` 缺失、为空或仅由 ASCII SPACE/TAB 组成时为 `skill is required`；其他字符串只能先经 `trimAsciiSpaceTab()` 去除整体两端 ASCII SPACE/TAB，再满足固定 2/3/4 段 stable identifier 语法。不得使用 JavaScript `trim()`：前后 CR/LF、U+2028/U+2029、U+FEFF、NBSP 均为 `invalid skill identifier`。调用方传入的 skillId/filePath 每段必须是 well-formed Unicode scalar sequence，拒绝 lone surrogate、反斜杠、U+0060、`Cc`、`Cf`、U+2028/U+2029、段内首尾空白、空段、点段和绝对形式；结果 `skillId` 使用 ASCII 包裹移除后的规范值。辅助 filePath 使用同一禁止字符集，从而保护固定 ```` ```text ```` fence。
- 顶层有效性与 `topLevelSkillCount` 沿用现有 `scanReadableTopLevelSkills()`。Worker 根读取先做等价根资格检查，再读取完整根文件、检查全文件 NUL、按 `Buffer.toString("utf8")` 解码和解析 frontmatter；不设置 V2 根源大小门槛，且不走通用辅助读取器。对同一未变更且可生成合规 identifier 的根，API 可发现即 Worker 可根读取；根正文保留解码后的 CRLF/孤立 CR。
- 物理顶层发现与 count 不因不可生成合规 identifier 的目录或 external-root mapping 改变；但 prompt、Worker mapping 和 `listWorkspaceTopLevelSkills().items` 必须过滤该条目，不新增 shared schema callable 字段。因此 `items.length` 可以小于物理 `topLevelSkillCount`，UI 无需新增状态；记录受控诊断。
- POSIX 枚举必须以 buffer filename 或等价方式 fatal UTF-8 解码并 re-encode byte-for-byte round-trip；非法 UTF-8 bytes 的辅助文件跳过并记录诊断。真实合法 U+FFFD 不因字符本身被拒绝；每个列出路径都必须可按同一字符串回读。
- 辅助文件必须在实际读取前后完成既有边界/父级 symlink 检查，并保存 `lstat` 的 `dev` + `ino` identity；支持时用 `O_NOFOLLOW` 打开，通过 `FileHandle.stat()` / `fstat` 与 identity 二次确认。分类与内容读取必须使用同一个已验证 fd 的 fd-based core，不能按 path reopen；不支持时必须有等价防护和平台说明，不能静默降级。
- 合法 identifier 的 external mapping 未启用/不存在或顶层 skill 目录不存在时为 `skill not found`；目录仍在但直属 `SKILL.md` 缺失或失效时为 `skill root is not readable`。
- 指定辅助文件不是字节、BOM 或换行保真读取：它继承 Worker 通用读取器的编码选择、decoder、BOM 移除、CRLF/孤立 CR 规范化为 LF、长行处理与既有输出截断；嵌套 `SKILL.md` 只保证 frontmatter block 不解析、不剥离。
- 外部工具字段、Provider/Worker 入参和成功结果均为 `skillId` / `filePath`；stable skill identifier、相关 helper 以及 workspace top-level skills API/shared contract 的 `item.id` 均保持现有领域命名，不因字段重命名而改动。
- 成功结果精确为 `{ skillId, filePath, content, truncated }`；根读取的 `filePath` 为 `"SKILL.md"`。Runner 从 camelCase 结果取值，但在模型可读 headers 中固定回显 `skill_id:`、`file_path:`、`truncated:`；随后按 `content` 原值输出。空字符串不产生 `(empty file content)`、`(empty skill content)` 或其他占位文本。
- 语义 description 为空时，模型 prompt 省略字段和多余分隔符；workspace top-level skills API/shared contract 继续给必填 `description: ""`，相关 UI 仅在非空时渲染。
- 工具对外错误是固定英文合同；不得暴露真实绝对路径。

## 文档导航

| 文档 | 用途 |
|---|---|
| [protocol.md](./protocol.md) | **规范性协议真源**：目录、frontmatter、接口、输出、安全、容量和错误语义。 |
| [architecture-and-implementation.md](./architecture-and-implementation.md) | 现有调用链、目标架构、实体、代码集成点、实施步骤和工程取舍。 |
| [test-and-acceptance.md](./test-and-acceptance.md) | 可执行测试矩阵、验收门槛、代码审查与文档一致性清单。 |
| [migration-and-rollout.md](./migration-and-rollout.md) | breaking change、发布、回滚和历史协议替代关系。 |

除 `protocol.md` 外，各文档不应重新定义协议细节；如存在冲突，以 `protocol.md` 为准。

## 与历史设计的关系

V2 仅替代 **Skills 读取协议及其工具、提示词和展示关联语义**，不是对整个 Skills roots 系统的重写。

| 历史文档 | V2 继承内容 | V2 覆盖内容 |
|---|---|---|
| `skills-dual-roots-and-run-cache-v1.md` | 顶层摘要、按需加载、文本读取限制、run 级静态缓存的基本方向 | 任意目录 `SKILL.md` 即节点、单 `id`、skill/file 混合定位、`children`。 |
| `skills-repo-roots-optional-v1.md` | repo roots 的历史演进背景 | 其中涉及旧读取标识或节点的内容仅作历史参考。 |
| `skills-external-roots-unified-cutover-v1.md` | builtin/workspace/repo 命名空间、external root 发现与启用、后续 run 生效、静态缓存 | `runSkillTool` 的旧 `id`、节点、子 skill 与 `children` 读取说明。 |

历史文档不在本次设计阶段回写。实现合入后，可在其显著位置添加“读取语义已由 V2 覆盖”的链接，但不得通过修改历史正文掩盖旧协议曾经存在。

## 基线使用规则

- 开发者**必须**按 `protocol.md` 实现外部行为；任何实现差异都必须先更新本目录并经过评审。
- 代码审查者**必须**使用 `test-and-acceptance.md` 核验行为、契约和文档同步，而不仅检查单元测试是否通过。
- 验收者**必须**将 tool schema、工具级 description、参数 description、系统提示词与 `skills/skill-authoring/SKILL.md` 视为同一协议的组成部分。
- 本文档状态为 `proposed`；在实现、审查和验收均完成前，任何描述均不得被解读为已上线行为。
