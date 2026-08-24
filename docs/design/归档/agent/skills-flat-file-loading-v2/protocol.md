# Skills 扁平文件加载协议 V2：规范性协议

**状态：proposed**
**定位：本文件是 V2 协议细节的唯一真源。**

本文使用以下规范性用语：

- **必须**：不满足即不符合 V2。
- **应该**：强烈推荐；如有例外，必须证明不改变协议。
- **可以**：可选实现，不改变本协议的外部语义。

其他 V2 文档只能引用本文件；若有冲突，以本文件为准。

---

## 目标、边界与术语

V2 将 Skills 读取模型收敛为“一个顶层 skill 根目录 + 一个根说明文件 + 普通辅助文本文件”：

- 模型先以 `skillId` 传入稳定逻辑标识选择一个顶层 skill，再以相对 `filePath` 读取根内文件；
- 根读取返回根正文与扁平 `Skill files` 清单；清单每行可直接作为后续 `filePath`；
- 不采用树形结构，因为树形展示要求模型把层级转换成参数路径，增加填写错误；
- 嵌套 `SKILL.md` 是普通辅助文件，不能形成子 skill；
- builtin、workspace、repo roots，external roots 启用，`topLevelSkillCount` 与 run 级静态缓存维持现有模型。

| 术语 | 定义 |
|---|---|
| Skills root | 容纳顶层 skills 的目录，来源为 builtin、workspace 或 repo。 |
| skill 根目录 | Skills root 的一级子目录，例如 `skills/skill-authoring/`。 |
| 根 `SKILL.md` | skill 根目录直属、名称精确为 `SKILL.md` 的文件；唯一具有元数据语义的文件。 |
| 辅助文件 | skill 根目录内除根 `SKILL.md` 外的任何文件，包括任意深度的 `SKILL.md`。 |
| 稳定逻辑标识 | 不暴露绝对路径的定位键，例如 `builtin/skill-authoring`。 |
| 根读取 | `filePath` 缺失、为空字符串或仅由 U+0020 SPACE/U+0009 TAB 组成的字符串，或原始值精确为 `SKILL.md` 时的读取。 |
| 指定文件读取 | 对非根、有效相对 `filePath` 的读取。 |
| `Skill files` section | 根读取 `content` 中的文件发现段，包含它自己的前导分隔片段或标题；不是树，也不是白名单。 |
| 根源文本 | 根文件原始 bytes 经 `Buffer.toString("utf8")` 解码、尚未做 frontmatter 剥离或正文预算裁剪的文本。 |
| 规范化文本内容 | 当前 Worker 通用文本读取器对辅助文件解码、行尾规范化、长行处理和容量裁剪后产生的字符串。 |

本协议不重新定义 external roots 的候选发现、启用设置、默认启用规则、UI 或 run 缓存生命周期。它只规定这些既有机制向 V2 提供 root mapping 与稳定逻辑标识的方式。

---

## 顶层根资格与根源读取

### API 顶层发现与 `topLevelSkillCount`

顶层 skill 的发现资格**必须精确沿用**当前 `apps/api/src/modules/agent/top-level-skill.ts` 中 `scanReadableTopLevelSkills()`：

- Skills root 的一级目录项是 directory，且不是 symlink；
- 其直属 `SKILL.md` 经 `lstat` 是普通文件，且不是 symlink；
- `fs.readFile(skillMdPath)` 成功；
- 原始 bytes 不含 NUL（`0x00`）；
- 原始 bytes 使用 `Buffer.toString("utf8")` 解码，保留现有 replacement 行为。

frontmatter 是否存在、字段是否为空或格式异常，均**不得**影响顶层 skill 有效性。API 顶层发现、`topLevelSkillCount`、external roots 候选与共享 API contract 不得因为 V2 改为调用 `classifyTextSample()` 或辅助文件读取器。

### Worker 根资格与完整根源读取

Worker 用稳定逻辑标识定位根后，必须以与 API 等价的方式读取**完整**根文件、检查全文件 NUL 并按 `Buffer.toString("utf8")` 等价语义解码；可使用 `fs.readFile(..., { signal })` 或流式等价实现，但不得设置 V2 专用根源大小门槛。Worker 必须在完整解码文本上解析 frontmatter，随后才仅对输出根正文应用 40 KiB 预算。

Worker 根读取必须遵守：

- 根源文件的完整 bytes 必须检查 NUL，再以 `Buffer.toString("utf8")` 等价方式完整解码；
- 根读取**不得**先使用 `classifyTextSample()`、`readTextFileCapped()` 或其他通用辅助文件读取路径；
- 根源读取/解析不执行通用长行截断、BOM 移除或 CRLF/孤立 CR 规范化；根源文本中的解码后行尾序列在 frontmatter 剥离后正文部分继续保留，直到根正文 UTF-8 预算裁剪；
- 对同一未变更且可生成合规 stable identifier 的根，API 可发现即必须使 Worker 能够根读取。不能生成合规 identifier 的物理发现条目按本协议的标识过滤规则排除；其余例外仅限发现后的文件系统竞态、权限变化或读取中止，并仍按公开错误合同处理。

发现后的当前观察状态必须按公开错误合同分流：顶层 skill 目录已不存在时返回 `skill not found`；目录仍存在但直属根文件缺失、不可访问、是 symlink 或非普通文件、读取失败、含 NUL，或目录/根文件变成其他不安全对象时返回 `skill root is not readable`。两者均不得泄露真实路径。

---

## 根 `SKILL.md` 的 frontmatter

### 共用解析 helper 与精确边界

API 顶层摘要和 Worker 根读取**必须共享**同一个“已解码文本 frontmatter 解析 helper”；如因包边界无法共享代码，必须共享完全相同的测试向量并证明等价。二者均以完整根文件的 `readFile + Buffer.toString("utf8")` 等价语义提供已解码文本，再交给同一解析语义。

第一版只支持轻量、单行 `name` / `description` 解析，不引入完整 YAML 解析器、嵌套对象、数组、锚点或 block scalar。

根源文本具有**边界完整 frontmatter**，当且仅当满足：

- 第一个解码字符不是 BOM（U+FEFF）；BOM、前导空白、空行或任何前导字符都会使 frontmatter 不被识别；
- 首行内容精确为 `---`；该行终止符只能是 LF（`\n`）或 CRLF（`\r\n`）；
- 从第二行起，**首个**内容精确为 `---` 的 LF/CRLF 行，或 EOF 末尾的精确 `---` 行，是结束边界；后续正文中的 `---` 不参与 frontmatter；
- 解析只把 LF 与 CRLF 当作换行；孤立 CR（`\r`）不是换行，不能构成边界。

helper 必须保留结束边界后的文本原貌：若结束行带 LF/CRLF，正文从该终止符之后开始；若结束行位于 EOF，正文为空。除了剥离该完整 frontmatter block，helper 不得规范化正文的 CRLF 或孤立 CR。

### 字段解析、剥离与展示回退

在边界完整 block 内，解析规则必须为：

- 只识别 `name`、`description`，键名大小写不敏感；
- 每行只取首个冒号后的同一行内容；无冒号、空 key、未知 key 行忽略；
- 值先 `trim()`；若剩余值被一对匹配的单引号或双引号完整包裹，剥离恰好一层匹配引号后再次 `trim()`；
- 重复字段采用“首个非空值胜出”：空值不阻止后续同名非空值；得到第一个非空值后忽略后续值；
- 边界完整但字段均无法识别、为空或格式异常时，仍剥离整个 block；skill 仍有效。

```markdown
---
NAME: "  第一名称  "
name: 第二名称
description:
Description: '  可展示说明  '
ignored line
other: value
---
```

上例必须产生 `displayName = 第一名称`、语义 description 为 `可展示说明`。

未闭合、带 BOM 或有其他前导字符时，不解析、不剥离，全文是根正文。展示语义为：

```text
displayName = trim(name) 非空 ? trim(name) : skill 根目录名
semanticDescription = trim(description) 非空 ? trim(description) : undefined
```

- `name` 不得参与定位、授权、命名空间或冲突消解；
- 语义 description 为空时没有展示描述；
- 面向模型的 Skills prompt 必须省略 `description` 字段及多余分隔符；
- 当前 workspace top-level skills API/shared contract/UI 数据必须保持兼容：`name` 仍为必填展示字符串，`description` 仍返回必填 string，语义 description 为空时返回 `description: ""`；本期不得将 shared contract 改成 optional；UI 若渲染 description，必须在非空时才渲染。

辅助文件（包括嵌套 `SKILL.md`）不调用该 helper：其 frontmatter block 不得被解析或剥离。

---

## 稳定逻辑标识、schema 与提示词合同

### 精确稳定逻辑标识语法

`skillId` 必须是字符串。缺失、空字符串，或只由 U+0020 SPACE 与 U+0009 TAB 组成的字符串，必须报 `skill is required`；非字符串必须报 `invalid skill identifier`。公开错误字符串沿用既有固定合同，不随字段名改名。

为保留轻量调用容错，执行器只能在整体两端移除 U+0020 SPACE 与 U+0009 TAB，必须使用等价于下列语义的 `trimAsciiSpaceTab()`，不得调用 JavaScript `trim()`、`trimStart()` 或 `trimEnd()`：

```ts
const trimAsciiSpaceTab = (value: string): string =>
  value.replace(/^[\u0020\u0009]+|[\u0020\u0009]+$/g, "");
```

对 `skillId` 应用 `trimAsciiSpaceTab()` 后为空仍必须报 `skill is required`。其余规范值按 `/` 分段，必须满足以下通用规则：

- 分隔符只能是 `/`，并且每个 segment 必须独立通过本节字符校验；
- 调用方传入的每个 segment 必须是 well-formed Unicode scalar sequence，不得包含 lone surrogate；
- 不得包含反斜杠（U+005C）或 grave accent / 反引号（U+0060）；
- 不得包含 Unicode General Category `Cc`（含 U+0000–U+001F、U+007F–U+009F）或 `Cf`（如 bidi controls、zero-width format controls），以及 U+2028 LINE SEPARATOR、U+2029 PARAGRAPH SEPARATOR；
- 不得是 POSIX 或 Windows 绝对形式；
- 不得有空段、`.` 段或 `..` 段；
- 任一 segment 的首尾不得是 U+0020 SPACE、U+0009 TAB 或其他 Unicode whitespace；不得借助任何 trim/normalize 修正后接受；
- namespace 必须精确小写匹配，所有 mapping 字段匹配均大小写敏感，且不得 normalize。

因此 `" builtin/foo "` 与 `"\tbuiltin/foo\t"` 作为 `skillId` 的规范值均为 `builtin/foo`；前后包含 `\n`、`\r`、U+2028、U+2029、U+FEFF 或 NBSP 的输入不会被移除，必须按上述字符规则报 `invalid skill identifier`。稳定标识的 mapping、返回实体 `skillId` 与任何后续结果回显均必须使用 `trimAsciiSpaceTab()` 产生的规范值。

以上字符与 Unicode well-formed 限制是 V2 可调用标识语法的一部分，而不是物理顶层发现资格。若 `scanReadableTopLevelSkills()` 发现的实际顶层目录名（或组成其 stable identifier 的 external-root mapping segment）无法生成合规 identifier，物理发现与 `topLevelSkillCount` **必须保持不变**；但 prompt 的可用 Skills 列表、Worker 的可调用映射和 `listWorkspaceTopLevelSkills().items` **必须**排除该条目。prompt summaries、Worker mapping 与 workspace items 的过滤必须使用同一 well-formed segment 校验。不得新增 shared schema 字段，也不得把该条目以不可调用或“可直接调用”状态放入 `items`；因此该极端字符场景中 `items.length` 可以小于物理 `topLevelSkillCount`，这是有意差异，UI 无需新增 callable 状态。若现有 string-based physical scan 已无法无损定位某个非法文件名字节，仍按其现有物理发现行为处理，V2 不扩大该口径；实现必须记录受控内部诊断，且不得把物理路径泄露给模型。

合法形状只有：

| namespace | 精确段数与形状 |
|---|---|
| builtin | `builtin/<skillDir>`，恰好 2 段。 |
| workspace | `workspace/<rootDir>/<skillDir>`，恰好 3 段。 |
| repo | `repo/<repoId>/<rootDir>/<skillDir>`，恰好 4 段。 |

`builtin` 的 `skillDir` 必须精确匹配 builtin Skills root 的一级实际目录名。`workspace` / `repo` 的 `rootDir`、`repoId`、`skillDir` 必须精确匹配当前 prompt context 的已启用 external root mapping 及其顶层目录名。不得新增“rootDir 必须包含 skill”等 mapping 已有发现/启用流程之外的规则。

非字符串、字符、lone surrogate、段数或 namespace 结构非法时必须报 `invalid skill identifier`；仅缺失、空或 ASCII spaces/tabs-only `skillId` 报 `skill is required`。external root mapping 未启用/不存在，或其对应顶层 `skillDir` 目录不存在时必须报 `skill not found`。已定位且仍存在的顶层目录，其直属根文件失效时适用 `skill root is not readable`。

### 工具 schema 与模型说明

工具 schema 必须一次性切换为：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["skillId"],
  "properties": {
    "skillId": {
      "type": "string",
      "description": "Stable logical skill identifier shown in the available skills list, such as builtin/skill-authoring."
    },
    "filePath": {
      "type": "string",
      "description": "Optional file path relative to the skill root. Omit filePath, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md to read root instructions and available file paths."
    }
  }
}
```

schema 的 properties 必须**仅**包含 `skillId` 和可选 `filePath`；`skillId` 不得设置 `minLength`，以使空字符串到达 Worker 并精确映射为 `skill is required`。旧 `{ "id": "..." }`、未发布的 `{ "skill": "...", "path": "..." }` 及 `{ "skill_id": "...", "file_path": "..." }` 均不得保留为 property、别名、隐式转换或兼容入口。工具级 description 必须说明：`skillId` 使用可用列表中的稳定逻辑标识；省略 `filePath`、传空字符串或仅由 spaces/tabs 组成的字符串、或精确 `SKILL.md` 均读取根说明和文件路径；其他 `filePath` 返回当前 Worker 文本读取器产生的规范化文本内容。

Provider 与 Worker TypeScript 入参均直接使用 `skillId` / `filePath`，不得保留 snake_case 到 camelCase 的映射层。稳定 skill identifier 的领域概念、既有 helper 命名与 workspace top-level skills API/shared contract 的 `item.id` 均不因本次字段切换机械改名。

工具级 description、`skillId`/`filePath` descriptions 与 Skills 系统提示词必须在同一变更中同步更新。系统提示词和 authoring 手册也必须明确：omit `filePath`、pass an empty string or a string containing only spaces/tabs、or pass exactly `SKILL.md` 都是根读取；从扁平 `Skill files` 逐行完整复制到 `filePath` 读取辅助文件。它们不得提到或暗示 `id`、`skill`/`path`、`skill_id`/`file_path` 工具字段、skill node、child skill、`children`、目录读取或“任意 `SKILL.md` 形成节点”。

---

## `filePath` 算法与文件系统安全

### 逐步处理原始 `filePath`

执行器必须按下列顺序处理原始 `filePath`，不得交换：

1. `filePath` 缺失：根读取。
2. `filePath` 是字符串且仅由 U+0020 SPACE 与 U+0009 TAB 组成（允许空字符串）：根读取。
3. 原始 `filePath` 精确等于 `"SKILL.md"`：根读取。
4. 其他情况：不得 trim、normalize 或修正后接受；执行严格非根 filePath 验证。

只有第 2 步的 spaces/tabs-only 特例可以使 TAB（Cc）作为根读取输入；其他控制/格式/空白字符一律不具有根读取特权。`filePath` 非字符串必须报 `invalid skill path`。以下都不是根读取，必须报 `invalid skill path`：

```text
 SKILL.md
"SKILL.md<SPACE>"
\tSKILL.md
./SKILL.md
\n
\r
U+2028
U+2029
U+FEFF
NBSP-only
```

### 非根 `filePath` 语法与安全

非根 `filePath` 必须是原始、规范 POSIX 相对文件路径：

- 仅使用 `/` 分隔，不得有反斜杠；
- 不得是 POSIX 或 Windows 绝对形式；
- 调用方传入的每个 segment 必须是 well-formed Unicode scalar sequence，不得包含 lone surrogate；
- 每个 segment 不得含反引号（U+0060）、Unicode General Category `Cc`（含 U+0000–U+001F、U+007F–U+009F）或 `Cf`（如 bidi controls、zero-width format controls），以及 U+2028 或 U+2029；
- 不得有空段、`.` 段、`..` 段、开头/末尾 `/` 或 `//`；
- 每段首尾不得有空白；
- 验证前不得通过 filePath normalize/resolve 的结果修正输入。

因此辅助文件的实际相对路径只要任一 segment 含 lone surrogate、上述禁止字符或反引号，就不得进入 `Skill files`，也不得通过已知 `filePath` 读取。这同时保证固定的 ```` ```text ```` fence 不会被路径行关闭、拆分或扰乱。

允许：

```text
reference.md
references/api.md
references/API guide.md
中文资料/使用说明.md
.meta/guide.md
.notes.md
```

拒绝：

```text
/etc/passwd
C:/Windows/system32
../secret.md
docs/../secret.md
./docs/api.md
docs//api.md
docs/
docs\\api.md
 notes.md
"notes.md<SPACE>"
.
..
```

dotfile/dot-directory 不做隐式过滤；它们与其他名称采用同一资格规则。

### 辅助文件最终读取与 TOCTOU 重检

为确保 `Skill files` 中每一行可作为同一字符串重新访问，枚举时每个物理 path segment 必须可无损表示为 well-formed JavaScript Unicode 字符串：

- POSIX 平台必须使用 buffer filename 枚举或等价方式，以 fatal UTF-8 解码得到字符串，并验证 re-encode 后 bytes 与原 filename bytes 完全一致；非法 UTF-8 filename bytes 的条目必须跳过、记录受控诊断，且不得列出；
- Windows、macOS 等原生字符串平台也必须拒绝非 well-formed JavaScript 字符串；不得将 U+FFFD 一概拒绝，因为它可能是物理文件名中合法、可重新访问的字符；
- 列出的每个合格路径必须在同一稳定夹具中可按该路径字符串直接回读。此规则仅约束辅助文件枚举和可调用映射的 V2 展示/访问，不改变 API 顶层 physical scan 或 `topLevelSkillCount` 的既有口径。

对非根 `filePath`，Worker 必须作 lexical root-inside 检查、每级 `lstat`、根/目标 `realpath` root-inside 检查、普通文件检查与读时重检。目录必须报 `skill path must reference a file`；symlink、经 symlink 父目录、非目录特殊文件或其他不具安全可读资格的对象必须报 `skill path is not a readable file`。

列表资格检查与直接指定读取必须共用同一个辅助文件安全读取 helper；枚举成功后直接读取同一路径时，helper 必须再次完成下列完整检查，不能相信枚举时状态：

- 在打开前完成本协议既有的 lexical/root realpath 边界检查、每级父目录 `lstat` 非 symlink 检查与目标 `lstat`；目标必须是普通文件，并保存该次 `lstat` 的 regular-file identity，至少包括 `dev` 与 `ino`；若平台不可靠或不提供二者，必须使用可验证的等价 identity；
- 打开目标时，平台支持时必须使用 `O_NOFOLLOW`；打开前后均必须按本协议既有规则重检 root/target 边界及父级 symlink 状态；
- 打开后必须用 `FileHandle.stat()` / `fstat` 确认 fd 指向普通文件，并与打开前 identity 一致；不一致时必须拒绝为 `skill path is not a readable file`；
- 实施必须把通用文本算法抽为或新增 fd-based 等价 helper（例如 `classifyTextSampleFromHandle(handle, size)` 与 `readTextFileCappedFromHandle(handle, encoding, signal)`；名称可调整）。path-based 既有 helper 必须重构为调用 fd-based core 或仅供其他工具使用；V2 路径不得借其重新按 path 打开；
- 直接指定读取在 identity 重检后，文本分类与内容读取必须复用**同一个**已验证 `FileHandle`，禁止在验证后再次按目标 path 打开；
- `Skill files` 枚举资格也必须经同一安全打开 helper，以已验证 fd 采样完成文本分类后关闭；列表生成不需要读全文，但不得调用会自行按 path reopen 的 classifier；
- 若目标在 `lstat` / `realpath` 后被替换为 symlink、不同 inode 或其他不安全对象，必须拒绝为 `skill path is not a readable file`，不泄露路径；
- 平台无法提供 `O_NOFOLLOW`、`dev`/`ino` 或 fd stat 中任一能力时，必须实现等价防护并以平台说明和测试证明；不得静默省略检查。

---

## 读取行为、文本规范化与 `truncated`

### 根读取

根读取必须：

- 按根专用流程读取完整根源文本，不设置 V2 source-size cap；
- 在完整解码文本上解析首个结束边界并剥离边界完整 frontmatter；
- 保留语义正文中的解码后 LF、CRLF、孤立 CR 序列，不应用通用辅助文件读取器的行处理；
- 对语义正文及截断提示按 UTF-8 预算裁剪；
- 全量扫描、排序并序列化 `Skill files` section；
- 返回 `filePath: "SKILL.md"`。

根正文非空时：

````markdown
<根正文>

---

## Skill files

```text
checklist.md
examples.md
reference.md
```
````

根正文为空且列表非空时，content 必须直接从标题开始，不得有前导分隔线：

````markdown
## Skill files

```text
checklist.md
reference.md
```
````

### 指定文件读取：继承 Worker 规范化文本读取器

指定辅助文件读取**不是**字节级、编码字节级或换行级保真读取。它必须返回当前 Worker 通用文本读取器产生的**规范化文本内容**，并继承该读取能力的后续演进，而不是建立 V2 独立的通用文件格式合同。

具体继承边界：

- 通过已验证 fd 的 `classifyTextSampleFromHandle()` 或等价 fd-based core 选定编码；不得在 V2 路径按 path reopen；
- 使用现有流式 decoder 解码；编码 BOM 按当前 decoder 行为不出现在 `content`；
- CRLF 和孤立 CR 按当前读取器规范为 LF；
- 长行按当前 `MAX_LINE_LENGTH` 及其 suffix 处理；
- 内容按当前 `MAX_BYTES` 预算与既有 UTF-8 输出/截断规则处理；
- 空文件/空内容仍返回空字符串；
- 嵌套 `SKILL.md` 的保障仅是其 frontmatter block 不被解析或剥离；它的解码、BOM、行尾、长行和容量行为与其他辅助文件相同。

V2 必须以不改变通用读取器文本输出的包装/扩展结果暴露截断来源，至少等价于：

```ts
type NormalizedSkillFileRead = {
  content: string;
  truncatedByBytes: boolean;
  hasMoreLines: boolean;
  truncatedByLineLength: boolean;
};
```

`truncatedByLineLength` 在任一行因 `MAX_LINE_LENGTH` 被替换为前缀加 suffix 时为 `true`。指定文件的 V2 `truncated` 必须精确为 `truncatedByBytes || hasMoreLines || truncatedByLineLength`；普通未发生任何上述截断的指定文件必须为 `false`。因此未来通用 Worker 读取器的文本行为变化会同步影响 V2 指定文件读取；这属于继承读取能力，不是 V2 单独的读取格式 breaking contract。指定文件不追加 `Skill files` section。

### 结果实体与精确 `truncated`

```ts
type SkillToolResult = {
  skillId: string;
  filePath: string; // 根读取时精确为 "SKILL.md"
  content: string;
  truncated: boolean;
};
```

`truncated` 必须且只能按下列定义计算：根正文、指定文件内容、`Skill files` section 或最终 `content` 防御性兜底任一发生截断时为 `true`；四者均未截断时为 `false`。因此 section 单独因路径数、section 字节预算或防御性兜底被缩减时，`truncated` 必须为 `true`。

Runner 是模型可读文本展示层，不改变工具 JSON args 或成功结果实体的 camelCase。它必须从结果实体的 `skillId`、规范化 `filePath` 与 `truncated` 取值，并按固定 header 名渲染 `skill_id:`、`file_path:`、`truncated:`，随后按 `content` 原值输出；这些 snake_case headers 与项目既有 `exit_code`、`subtask_session_id` 风格一致。不得渲染 `id`、`skill`、`path`、`type: "skill"`、name、description 或 `children` headers。当 `content === ""` 时，结果实体仍是空字符串，Runner 在 headers 后不得合成 `(empty file content)`、`(empty skill content)` 或任何业务占位文本。

---

## `Skill files` 扫描、排序与容量

### 候选资格、隐藏项与遍历失败

辅助文件可列入列表，当且仅当：

- 位于 skill 根内且不是根 `SKILL.md`；
- 是普通文件，访问路径不含 symlink；
- 通过 lexical 与 realpath 双重边界检查；
- 每个物理 segment 可无损表示为 well-formed Unicode 字符串，POSIX filename bytes 完成 fatal UTF-8 decode/re-encode byte级 round-trip；
- 满足非根 path 语法，包括每个 segment 拒绝 lone surrogate、U+0060、`Cc`、`Cf`、U+2028 和 U+2029；
- 通过与指定读取相同的安全打开、fd-based Worker 文本分类/读取资格检查。

目录、symlink、二进制、设备文件、FIFO、socket 和不安全项不得列出。不得仅按扩展名判断。dotfile/dot-directory 不得隐式过滤，例如 `.notes.md`、`.meta/guide.md` 满足资格时必须可列出、可读取。

遍历必须扫描全部可安全遍历的后代候选，并定期检查 `AbortSignal`；不得因 500 项或 section 输出预算停止扫描。后代文件/目录不可读、消失或 I/O 失败时，必须跳过该项或子树、记录受控内部诊断并继续扫描兄弟项；根读取不得失败，也不得把失败路径泄露给模型。直接指定同一目标时，必须使用公开错误合同。

### 全量语义与有界选择

外部可观察语义必须与下列概念算法完全等价：扫描全部候选、对每个候选完成资格检查、收集全体合格规范 POSIX 相对路径、使用固定 comparator 全局排序，再按 500 项与 section UTF-8 预算取前缀。实现不得因输出预算提前停止任何候选扫描或资格检查。

实现**不要求**同时把全体路径保存在内存。首选且本期**应该**实现有界选择结构：

- 扫描时维护按固定 comparator 最小的 `MAX_SKILL_FILE_PATHS + 1` 条合格路径，即最多 501 条，并维护全体合格路径总数或等价 `hasMore`；
- 新合格路径进入时，保留该 501 条中的全局最小集合，丢弃当前集合中更大的路径；扫描仍继续至所有候选检查结束；
- 扫描结束后排序已保留集合；其前 500 条与概念算法全局排序的前 500 条完全一致，第 501 条或 `hasMore` 用于确定 500 项截断；随后再按 section 10 KiB 预算从该前缀中序列化；
- 因 section 10 KiB 使输出少于 500 条时，已知至少第一个未输出的候选是否存在，仍可从保留的 501 条或 `hasMore` 正确判定列表截断。

实现可以选择全量存储，但必须证明存在独立安全上限且不改变上述外部语义；不得将内存上限偷换为扫描、资格检查或输出前缀限制。

### 固定排序

使用固定、非 locale-aware 的 ECMAScript UTF-16 code-unit 升序比较器：

```ts
const compareSkillPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
```

不得使用 `localeCompare()`。大小写、ASCII、中文、dotfile、目录/文件交错都按该比较器排序。预算截断结果必须是概念算法全体排序结果的前缀，而不是文件系统遍历顺序的前缀。

### 精确 section 与 content 预算

所有容量必须使用 `Buffer.byteLength(text, "utf8")` 计算：

```ts
const MAX_ROOT_BODY_UTF8_BYTES = 40 * 1024;
const MAX_SKILL_FILES_SECTION_UTF8_BYTES = 10 * 1024;
const MAX_ROOT_CONTENT_UTF8_BYTES = 50 * 1024;
const MAX_SKILL_FILE_PATHS = 500;
```

```ts
const ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated.";
```

- 根正文预算对剥离边界完整 frontmatter 后的正文计量；没有边界完整 frontmatter 时对全文正文计量；
- `Skill files section` 预算不含 body，但**包含 section 自己的前导片段**：body 非空时的分隔线、标题、空行、code fence、路径行间换行、空列表文字和截断提示；
- 最终 `SkillToolResult.content` 预算不含 runner 的 `skill_id`/`file_path`/`truncated` text headers；
- 指定文件继续使用当前通用读取器的既有 `MAX_BYTES` 和输出截断行为，不把其数值复制为 V2 新常量。

若语义根正文的 UTF-8 字节数超过 `MAX_ROOT_BODY_UTF8_BYTES`，body 必须精确序列化为“最长有效 UTF-8 前缀 + `ROOT_BODY_TRUNCATION_SUFFIX`”。前缀与固定 suffix 合计必须 `<= 40 * 1024`，suffix 必须恰好出现一次；不得根据前缀是否以 LF、CRLF、孤立 CR 或其他字符结尾改变、折叠、移除或额外插入分隔字符。该情形令 `truncated: true`。

令 `body` 为处理后的根正文，令 `section` 为完整 `Skill files section`。此处“body 非空”**必须精确表示** JavaScript 字符串 `body.length > 0`，不得 `trim()`；只含空格、LF、CRLF 或孤立 CR 的正文仍为非空。精确拼装规则为：

- `body.length > 0`：section 从 `"\n\n---\n\n## Skill files\n\n"` 开始；
- body 为空：section 从 `"## Skill files\n\n"` 开始；
- 全体合格路径为空：继续追加 `"No additional readable text files."`，不得输出 code block 或截断提示；
- 全体合格路径非空且最大确定性前缀含至少一条路径：继续追加 `"```text\n" + 路径以 `"\n"` 连接 + `"\n```"`；若仍有路径因 500 项或 section 预算未输出，则在 code block 外追加 `"\n\nSkill file list truncated; additional files may be accessed if their paths are known."`；
- 全体合格路径非空但在 10 KiB section 预算内连第一条完整路径与必需序列化都无法容纳时，最大确定性前缀允许为 0。section 必须只追加 code block 外的 `"Skill file list truncated; additional files may be accessed if their paths are known."`，不得输出空 code block，也不得输出 `"No additional readable text files."`。因此 body 为空时精确为：

  ```text
  ## Skill files

  Skill file list truncated; additional files may be accessed if their paths are known.
  ```

  body 非空时仍使用 section 自己的前导分隔片段。此情形必须令 `truncated: true`；列表不是白名单，已知合规 path 仍可读取。

`content` 必须**精确等于** `body + section`，不得额外插入任何字符。代码块内只能有完整有效路径，不得有空行、占位、注释、截断提示或半条路径。

概念算法在全体合格路径全局排序后，把固定前导、fence、换行、路径、空列表/截断提示一起纳入 section 10 KiB 预算，求最大确定性路径前缀。实际实现只要完成全部候选扫描/资格检查并按本协议的 501 有界选择保留全局最小集合，再排序该集合，即可产生完全相同的外部结果；不要求全体路径同时驻留内存。由于 `body <= 40 KiB` 且 `section <= 10 KiB`，正常协议算法必然满足 `content <= 50 KiB`；不得双重计入或遗漏分隔字符。

最终 50 KiB 检查仅是防御性 invariant assertion，正常算法不应触发。若因程序错误或固定包装错误触发，必须记录内部 invariant-violation 诊断，只缩减 section、保持 body 不变、保持 UTF-8、完整路径行和闭合 fence，并令 `truncated: true`；不得改变公开错误或将该防护变成工具失败。

---

## 公开错误合同

下列英文字符串是面向调用方的**必须**错误合同。内部日志可保留诊断，但工具失败正文只能为相应字符串，不得包含绝对路径、物理 root、底层 `ENOENT`、权限详情或错误栈。

| 公开字符串 | 必须映射的场景 |
|---|---|
| `skill is required` | `skillId` 缺失、空字符串，或仅由 U+0020 SPACE/U+0009 TAB 组成。 |
| `invalid skill identifier` | `skillId` 非字符串，或经 `trimAsciiSpaceTab()` 后不符合稳定逻辑标识的 Unicode scalar sequence、字符、段数或 namespace 语法；前后 CR/LF、U+2028/U+2029、U+FEFF、NBSP 均属于本项。 |
| `skill not found` | 标识语法合法但 external root mapping 未启用/不存在，或相应顶层 `skillDir` 目录不存在；prompt 缓存后目录被删除也属于本项。 |
| `skill root is not readable` | 已定位且仍存在的顶层目录，其直属根 `SKILL.md` 缺失、不可访问、是 symlink/非普通文件、读取失败、含 NUL 或其他不满足 API 等价根资格的状态。 |
| `invalid skill path` | `filePath` 非字符串，或未触发 spaces/tabs-only/精确 `SKILL.md` 根读取且违反 Unicode scalar sequence 或原始 POSIX path 语法。 |
| `skill path must reference a file` | 有效非根 `filePath` 指向目录。 |
| `skill path is not a readable file` | `filePath`/父级是 symlink，目标是非目录特殊文件，或不具安全可读文件资格。 |
| `binary file is not supported` | 安全普通辅助文件被 Worker 文本分类为 binary。 |
| `skill file not found` | 有效非根 `filePath` 的目标不存在或在直接读取前消失。 |
| `skill file is not accessible` | 有效目标因权限或 I/O 在直接读取时不可访问。 |
| `skill tool failed to read target` | 未归入上述类别的内部读取失败。 |
| `operation aborted` | 任一阶段检测到 `AbortSignal` 已中止。 |

遍历后代失败不改变根读取成功结果；直接读取同一目标必须返回上表中对应的固定错误，而非遍历诊断。

---

## 必须同步的外部说明

实施 V2 时，必须在同一原子变更中同步：

- `toolDescription("skill")` 与 `skillId`/`filePath` 参数 descriptions；
- Skills 系统提示词及顶层摘要说明：模型 prompt 省略空 description、以 `skillId` 传入 stable identifier，并省略 `filePath` 读根或完整复制 `Skill files` 行到 `filePath`；
- 现有 workspace top-level skills API/shared contract/UI：保留 `description: ""` 兼容字段，UI 不渲染空描述；
- `skills/skill-authoring/SKILL.md`：移除 `id`、`children`、子 skill/skill node，写入新 schema、扁平可复制路径、平级优先与大 skill 分层建议；
- API、Worker、runner、external roots 与本协议测试；runner 的模型可读 text headers 固定为 `skill_id:` / `file_path:` / `truncated:`，但 JSON args/result 保持 camelCase。

不得只改参数名而保留旧输出模型，也不得保留 `{ skill_id, file_path? }`、`{ skill, path? }` 或 `{ id }` 作为兼容入口，更不得把辅助文件规范化读取表述为字节或换行保真读取。
