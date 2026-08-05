# Skills 扁平文件加载协议 V2：测试与验收

**状态：proposed**
**协议依据：** [protocol.md](./protocol.md) 是唯一协议真源。本文件将其转化为可执行、可判定的测试、审查和验收要求；不得产生不同口径。

## 验收原则

V2 不能仅以“能加载一个 skill”验收。合入和发布前必须同时证明：

- schema、工具级 description、字段 descriptions、Skills 系统提示词、provider、Worker 与 runner 使用同一 `{ skill_id, file_path? }` 合同；
- 根资格、frontmatter、file_path、扫描排序、容量、`truncated`、输出和错误逐项符合协议；
- builtin、workspace、repo 三个来源具有等价读取和安全行为；
- external roots、`topLevelSkillCount` 和 run 级静态 prompt cache 没有意外变化；
- `skills/skill-authoring/SKILL.md` 已重写并只教授 V2。

除本文明确标记为“建议”的命令替代方式外，以下事项均为**必须**验收项。

## 测试层次与建议落点

| 层次 | 主要位置 | 必测职责 |
|---|---|---|
| 前端无关纯函数 | `apps/api/src/modules/agent/top-level-skill.ts`、`apps/agent-worker/src/runtime/fileTools.ts` | 根资格、frontmatter 向量、UTF-8 裁剪、file_path 判定、排序、section 序列化和错误映射。 |
| Worker 工具 | `apps/agent-worker/src/runtime/fileTools.test.ts` | `{ skill_id, file_path? }` 根/文件读取、全量扫描、三来源、安全与固定错误。 |
| provider 与 runner | `apps/agent-worker/src/runtime/tools/providers/builtin.ts`、`apps/agent-worker/src/runtime/runner.skill-output.test.ts` | 拒绝旧参数、传入新参数、V2 结果与 header 渲染。 |
| API / prompt | `apps/api/src/modules/agent/agent.integration.test.ts` | schema、tool description、字段 descriptions、提示词、展示回退与 run cache。 |
| external roots 回归 | `apps/api/src/modules/workspaces/workspace.service.test.ts` | 候选发现、启用、`topLevelSkillCount`、顶层展示与 roots 不变性。 |
| 文档审查 | `skills/skill-authoring/SKILL.md` 与本目录 | 新 schema、文件列表、平级优先、术语和迁移信息一致。 |

若实施中拆分测试文件，必须执行覆盖上述等价职责的 `tsx --test` 命令，并在实现变更说明中记录实际命令与结果。

## 完整测试矩阵

### 顶层发现、根资格与展示元数据

| 编号 | 场景 | 必须断言 |
|---|---|---|
| D-01 | root 一级非 symlink 目录，直属普通非 symlink `SKILL.md`，`readFile` 成功且 bytes 无 NUL | `scanReadableTopLevelSkills()` 发现 skill；Worker 用同一逻辑标识可读取。 |
| D-02 | 合法 identifier 的 external mapping 未启用/不存在，或顶层 skill 目录不存在（含 prompt 缓存后目录删除） | Worker 精确 `skill not found`；不得把目录不存在映射为 `skill root is not readable`。 |
| D-03 | 顶层 skill 目录仍存在，但直属根文件缺失、是目录/symlink、不可访问、读取失败或 bytes 含 NUL | API 不发现、不计入 `topLevelSkillCount`；Worker 精确 `skill root is not readable`。 |
| D-04 | 无效 UTF-8 但无 NUL | API 保留现有 `Buffer.toString("utf8")` replacement 行为；不得因辅助文件文本分类改变顶层发现/count。 |
| D-05 | 无 NUL 的根源文件大于 1 MiB，正文大于 40 KiB | API 发现与 `topLevelSkillCount` 口径不变；Worker 可根读取，并只按根正文 40 KiB 预算输出、`truncated: true`，不因源文件大小失败。 |
| D-06 | 根文件无 frontmatter | skill 有效；全文作为根正文。 |
| D-07 | frontmatter 结束边界位于大于 1 MiB 的根源文件后段 | Worker 以完整根源文本定位**首个**结束边界、剥离整个 block；不得因 `readTextFileCapped()` 预截断或 V2 source-size cap 误判/拒绝。 |
| D-08 | LF 边界完整 frontmatter | 解析/剥离正确。 |
| D-09 | CRLF 边界完整 frontmatter | 解析/剥离正确；正文 CRLF 序列保留。 |
| D-10 | 根正文含孤立 CR | 剥离后正文保留孤立 CR；不经通用读取器规范化。 |
| D-11 | BOM、前导空格、前导空行或其他前导字符 | 不识别、不剥离；全文作为正文，展示回退。 |
| D-12 | 只有开始 `---`、无结束边界；或只用 CR 构成伪换行 | 不识别、不剥离；全文作为正文。 |
| D-13 | 两个边界完整的 `---` block | 只以首个有效结束 `---` 结束 frontmatter；后续 `---` 保留在正文。 |
| D-14 | 大小写混合的 `NAME`、`Description` | key 大小写不敏感。 |
| D-15 | 重复字段：空值后非空、多个非空、全空 | 首个非空值胜出；空值允许后续非空；全空按回退/省略。 |
| D-16 | 匹配单/双引号、首个冒号后的值、未知/无冒号/空 key 行 | 恰剥离一层匹配引号后再次 trim；未知行忽略。 |
| D-17 | 完整边界但内部无识别字段或格式异常 | 仍剥离完整 block；skill 有效；name 回退、description 省略。 |
| D-18 | 同一夹具经 API 摘要和 Worker 根读取 | 共享已解码文本 helper，或使用同一向量证明解析、展示回退和正文剥离等价。 |
| D-19 | `name` 缺失/空白、`description` 缺失/空白 | name 始终回退为必填根目录名；prompt 省略 description 与多余分隔符；workspace API/shared contract 仍返回 `description: ""`，UI 不渲染空描述。 |

### schema、description 与系统提示词

| 编号 | 断言 | 必须结果 |
|---|---|---|
| C-01 | `toolArgsSchema("skill")` | `type: "object"`、`additionalProperties: false`、`required: ["skill_id"]`，且 properties **仅有** `skill_id` 和可选 `file_path`；`skill_id` 不得设置 `minLength`，以使空字符串进入 Worker 并精确映射为 `skill is required`。 |
| C-02 | schema | 不存在 `id`、`skill` 或 `path` property；传入旧 `id` 或未发布中间 `{ skill, path? }` 字段被 schema 拒绝。 |
| C-03 | `skill_id` description | 说明 stable logical identifier、可用列表来源，并给出 `builtin/...`。 |
| C-04 | `file_path` description | 精确包含 `Omit file_path, pass an empty string or a string containing only spaces/tabs, or pass exactly SKILL.md`；不得使用笼统的空白字符串说法或模糊为 trim 后任意 `SKILL.md`。 |
| C-05 | tool-level description | 明确 omit `file_path`、empty string or string containing only spaces/tabs、or exactly `SKILL.md` 均为根读取，并说明根说明 + 可用文件路径与指定文件规范化文本；不出现旧 node/children/id 或未发布的 skill/path 工具字段模型。 |
| C-06 | `buildSkillsInstructionSection()` | 指导先以 `skill_id` 省略 `file_path` 读根、再从 `Skill files` 逐行完整复制到 `file_path`；明确清单不是树，且 omit、empty string or string containing only spaces/tabs、or exactly `SKILL.md` 都读取根。 |
| C-07 | 空 description 的 prompt 语义 | prompt 省略 `description` 字段和多余分隔符，不输出空值。 |
| C-08 | 空 description 的 workspace API/shared contract/UI 数据 | `WorkspaceTopLevelSkillItemSchema` 对应响应继续为必填 `description: ""`；若 UI 有 description 显示，空字符串不渲染。 |
| C-09 | 实际目录名或 external-root mapping segment 含 lone surrogate、U+0060、`Cc`、`Cf`、U+2028/U+2029 | `scanReadableTopLevelSkills()` 与 `topLevelSkillCount` 物理口径不变；prompt summaries、Worker mapping 与 `listWorkspaceTopLevelSkills().items` 都过滤该条目；不得新增 shared schema 字段，`items.length < topLevelSkillCount` 是预期差异，UI 无 callable 状态，且记录受控诊断。 |
| C-10 | builtin、已启用 workspace、已启用 repo 的合规条目 | 都注入稳定逻辑标识；未启用 external roots 不注入。 |
| C-11 | prompt 内容与失败消息 | 不含 workspace/repo 绝对路径。 |
| C-12 | 同 run 重复 prompt context | 保持静态缓存；新 run 才反映 roots/摘要变更。 |

### 稳定逻辑标识

| 编号 | 输入/夹具 | 必须结果 |
|---|---|---|
| I-01 | `builtin/<skillDir>` | 只接受恰好 2 段，`skillDir` 精确匹配实际一级目录名。 |
| I-02 | `workspace/<rootDir>/<skillDir>` | 只接受恰好 3 段，两个 mapping 值精确匹配当前已启用 workspace root。 |
| I-03 | `repo/<repoId>/<rootDir>/<skillDir>` | 只接受恰好 4 段，三个 mapping 值精确匹配当前已启用 repo root。 |
| I-04 | 单/三反引号 U+0060、反斜杠 U+005C、`Cc`（含 U+0000–U+001F、U+007F–U+009F）、`Cf`（bidi/zero-width format controls）、U+2028、U+2029 | 任一 segment 命中时精确 `invalid skill identifier`。 |
| I-05 | JS 单测直接构造的 lone surrogate segment | 精确 `invalid skill identifier`。 |
| I-06 | 缺失段、多余段、空段、`.`、`..`、POSIX/Windows 绝对形式、任一段首尾空白 | 精确 `invalid skill identifier`。 |
| I-07 | `skill_id: " builtin/foo "`、`skill_id: "\tbuiltin/foo\t"` | 仅用 `trimAsciiSpaceTab()` 去除整体两端 ASCII SPACE/TAB 后接受；mapping、result entity `skill_id` 与 headers 均为规范值 `builtin/foo`。 |
| I-08 | 空字符串、`"   "`、`"\t\t"`、`" \t "` | 精确 `skill is required`。 |
| I-09 | 前后 `"\n"`、`"\r"`、U+2028、U+2029、U+FEFF、NBSP | 不调用 JavaScript `trim()`，上述字符不会被移除；精确 `invalid skill identifier`，不是 `skill is required`。 |
| I-10 | `Builtin/...`、`Workspace/...`、`Repo/...` | namespace 大小写不精确，精确 `invalid skill identifier`。 |
| I-11 | 形状合法但 repoId/rootDir/skillDir/builtin 目录大小写不精确或 mapping 未启用/不存在 | 精确 `skill not found`，不得做大小写折叠或 normalize。 |

### file_path 逐步判定与安全

| 编号 | 输入/夹具 | 必须结果 |
|---|---|---|
| P-01 | file_path 缺失 | 根读取，结果 `file_path: "SKILL.md"`。 |
| P-02 | `""`、`"   "`、`"\t"`、`" \t "` | 根读取；仅 U+0020 SPACE/U+0009 TAB 的组合适用该特例。 |
| P-03 | `"\n"`、`"\r"`、U+2028、U+2029、U+FEFF、NBSP-only | 精确 `invalid skill path`，不是根读取。 |
| P-04 | 原始 `"SKILL.md"` | 根读取。 |
| P-05 | `" SKILL.md"`、`"SKILL.md "`、`"\tSKILL.md"`、`"./SKILL.md"` | 精确 `invalid skill path`，不是根读取。 |
| P-06 | file_path 非字符串 | provider/schema 或 Worker 返回精确 `invalid skill path`。 |
| P-07 | `reference.md`、`references/api.md`、`.notes.md`、`.meta/guide.md`、中文和含内部空格路径 | 接受、以原始 POSIX file_path 读取。 |
| P-08 | 单/三反引号 U+0060、`Cc`（含 NUL/CR/LF、U+007F–U+009F）、`Cf`（bidi/zero-width format controls）、U+2028、U+2029 | 任一 segment 命中时精确 `invalid skill path`；含反引号的辅助文件不能列出或按已知 path 读取。 |
| P-09 | JS 单测直接构造的 lone surrogate file_path segment | 精确 `invalid skill path`。 |
| P-10 | 绝对路径、反斜杠、`.`/`..`、`./x`、`a/../b`、空段、末尾 `/`、段首尾空白 | 精确 `invalid skill path`。 |
| P-11 | file_path 指向目录 | 精确 `skill path must reference a file`。 |
| P-12 | file_path 目标/父路径 symlink，或特殊文件 | 精确 `skill path is not a readable file`。 |
| P-13 | lexical 或 realpath 逃逸 | 精确 `skill path is not a readable file`；不得泄露路径。 |
| P-14 | 完成 lstat/realpath 后、打开前将目标替换为 symlink | 经 `O_NOFOLLOW`、fd stat/identity 重检拒绝，精确 `skill path is not a readable file`；不得泄露路径。 |
| P-15 | 完成 lstat/realpath 后、打开前将目标替换为不同 inode 的普通文件 | `FileHandle.stat()` / `fstat` 的 `dev` + `ino` 与打开前不一致，精确 `skill path is not a readable file`；内容只允许经已验证 fd 读取。 |
| P-16 | 在 fd 分类与内容读取之间通过注入 hook 替换同一路径 | 分类与读取仍复用同一个已验证 `FileHandle`：只读取原对象，或安全拒绝；绝不能按 path 读取替换对象。 |
| P-17 | 平台缺少 `O_NOFOLLOW`、可靠 `dev`/`ino` 或 fd stat 能力 | 有等价防护的实施说明与平台测试；不得静默跳过任一读时安全检查。 |
| P-18 | 安全普通二进制文件 | 精确 `binary file is not supported`。 |
| P-19 | 指定 file_path 不存在/读取前消失 | 精确 `skill file not found`。 |
| P-20 | 指定 file_path 权限或 I/O 不可访问 | 精确 `skill file is not accessible`。 |
| P-21 | 未归类读取异常 | 精确 `skill tool failed to read target`。 |
| P-22 | 在任意阶段触发 AbortSignal | 精确 `operation aborted`。 |

上述 P-01 至 P-22 的根定位和安全用例必须跨 builtin、workspace、repo 覆盖；共享 helper 不得替代对三种命名空间解析的回归。

### 固定公开错误合同

每项必须精确断言工具失败正文仅等于该字符串，且不含绝对路径、底层 errno、物理 root 或目标路径。实现内部日志可更详细，但不属于断言输出。

| 编号 | 触发条件 | 必须精确等于 |
|---|---|---|
| E-01 | `skill_id` 缺失、空字符串或仅由 ASCII SPACE/TAB 组成 | `skill is required` |
| E-02 | `skill_id` 非字符串、lone surrogate、前后 CR/LF/U+2028/U+2029/U+FEFF/NBSP，或不符合 stable identifier 语法 | `invalid skill identifier` |
| E-03 | 合法格式 identifier 的 external mapping 未启用/不存在，或顶层 skill 目录不存在；prompt 缓存后目录删除亦同 | `skill not found` |
| E-04 | 已定位且仍存在的顶层目录，其直属 `SKILL.md` 缺失、变为不安全/非普通/symlink、不可读、读取失败或含 NUL | `skill root is not readable` |
| E-05 | 非字符串 file_path、lone surrogate，或未触发 spaces/tabs-only/精确 `SKILL.md` 根读取的严格原始 file_path 语法违规 | `invalid skill path` |
| E-06 | 安全有效 file_path 指向目录 | `skill path must reference a file` |
| E-07 | file_path 自身/父级为 symlink，或目标为非目录特殊文件/不具安全可读文件资格 | `skill path is not a readable file` |
| E-08 | 安全普通目标经文本分类为 binary | `binary file is not supported` |
| E-09 | 有效非根 file_path 的文件不存在或在直接读取前消失 | `skill file not found` |
| E-10 | 有效目标因权限或读取 I/O 不可访问 | `skill file is not accessible` |
| E-11 | 无法归类的内部读取故障 | `skill tool failed to read target` |
| E-12 | 任意根定位、扫描、读取、排序或序列化阶段已中止 | `operation aborted` |

### 根读取、全量扫描、排序与 `Skill files`

| 编号 | 场景 | 必须断言 |
|---|---|---|
| R-01 | file_path 缺失、空字符串、仅 SPACE/TAB 的字符串、精确 `SKILL.md` | 结果正文、section、`file_path: "SKILL.md"` 与 `truncated` 完全一致。 |
| R-02 | 根完整边界 frontmatter | 先剥离，再按剥离后的正文计量 40 KiB。 |
| R-03 | 根无完整边界 frontmatter | 全文按正文计量 40 KiB。 |
| R-04 | 根正文非空且列表非空 | 分隔线、标题、fence、路径和换行符合精确 section 序列化。 |
| R-05 | 根正文为空且列表非空 | content 从 `## Skill files` 开始，不出现前导 `---`。 |
| R-06 | 根正文只含空格、LF、CRLF 或孤立 CR，且列表非空 | `body.length > 0`，不得 trim；使用带 `\n\n---\n\n` 的 section 前导并保留正文原有字符。 |
| R-07 | 无合格辅助文件 | 输出 code block 外的空列表文字；不得出现伪 path 或 code block。 |
| R-08 | 合格路径集合非空，但第一条完整路径连同必需 section 序列化无法装入 10 KiB | 最大确定性前缀为 0；仅输出标题与 code block 外 `Skill file list truncated; additional files may be accessed if their paths are known.`；不得输出空 code block 或 `No additional readable text files.`，故也不得遗留未闭合 fence；`truncated: true`，已知合规 path 仍可读。 |
| R-09 | 根 `SKILL.md` 与嵌套 `notes/SKILL.md` | 根文件不列出；嵌套文件列出且直接读取时 frontmatter block 不解析、不剥离，内容仍遵循通用读取器规范化。 |
| R-10 | dotfile/dot-directory | `.notes.md`、`.meta/guide.md` 与普通文件同样列出和读取。 |
| R-11 | 二进制/symlink/目录/FIFO/socket/设备文件 | 不列出。 |
| R-12 | 不可读、消失或 I/O 失败后代文件/目录 | 根读取成功；跳过项/子树，继续兄弟项；模型输出不泄露失败路径；直接读取同一 path 返回固定公开错误。 |
| R-13 | POSIX 非 UTF-8 filename bytes | buffer filename 枚举以 fatal UTF-8 decode/re-encode round-trip 识别为不可无损表示；跳过、记录受控诊断，不进入 `Skill files`。 |
| R-14 | 真实合法 U+FFFD 文件名 | 不因 U+FFFD 字符本身被拒绝；能列出并以同一字符串读取。 |
| R-15 | 列表内每项 | 候选资格经同一安全打开 helper 的已验证 fd 采样分类后关闭；在稳定夹具中逐项按展示字符串直接读取均成功，证明 list path 可回读且与读取使用同一资格。 |
| R-16 | 候选数超过 500 或 section 超过 10 KiB | 先完整扫描/排序，再输出全排序的确定性前缀；不得因输出预算停止扫描；code block 内只含完整路径；code block 外有截断提示；`truncated: true`。 |
| R-17 | 大量乱序候选且目录遍历顺序不同 | 输出与概念算法“全体扫描、资格检查、全局 comparator 排序、取前缀”完全一致；未使用 `localeCompare()`。 |
| R-18 | 有界选择 helper/指标 | 全部候选仍完成扫描和资格检查；保留路径数始终 `<= MAX_SKILL_FILE_PATHS + 1`，即最多 501，不要求测量进程实际内存。 |
| R-19 | 第 501 条或等价 `hasMore` | 500 条仍可完整输出时不因数量截断；第 501 条/`hasMore` 能正确标记 500 项截断。 |
| R-20 | section 10 KiB 在 500 条之前耗尽 | 即使只序列化少于 500 条，保留的第一个遗漏路径或 `hasMore` 仍使列表正确输出截断提示并令 `truncated: true`。 |
| R-21 | 大小写、ASCII、中文、dotfile、目录/文件交错 | 输出符合 UTF-16 code-unit 升序；测试应显式写出预期排序。 |
| R-22 | 列表截断后未展示的安全文本文件 | 已知合法 path 仍可读取；列表不是白名单。 |

### 容量、UTF-8 与 `truncated`

| 编号 | 场景 | 必须断言 |
|---|---|---|
| T-01 | 多字节中文/emoji 根正文 | 所有上限用 `Buffer.byteLength(text, "utf8")`，不按 JS 字符数；裁剪不破坏 UTF-8。 |
| T-02 | 根正文超过 `MAX_ROOT_BODY_UTF8_BYTES` | 精确使用 `ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated."`：最长有效 UTF-8 前缀加 suffix 合计 `<= 40 * 1024`，suffix 恰好一次，`truncated: true`。前缀末尾为普通字符、LF、CRLF、孤立 CR 时 suffix 均不改变，不多加或少加分隔。 |
| T-03 | section 接近 `MAX_SKILL_FILES_SECTION_UTF8_BYTES` | body 非空时的 `\n\n---\n\n## Skill files\n\n`、body 为空时的 `## Skill files\n\n`、fence、路径换行、空列表/截断提示均纳入 10 KiB；不截断路径行或 fence。 |
| T-04 | 500 路径边界 | 500 条仍可完整输出时不因数量截断；第 501 条导致列表截断且 `truncated: true`。 |
| T-05 | body 非空 / body 为空两种序列化 | 都精确断言 `content === body + section`，无额外或双重分隔符。 |
| T-06 | 正文、section 均接近预算的正常算法 | 最终 `Buffer.byteLength(content, "utf8") <= 50 * 1024`，且不会触发 final fallback。 |
| T-07 | 通过测试 helper 模拟 final assertion 触发 | 记录内部 invariant-violation；仅减少 section、body 的字节序列不变；完整 UTF-8、路径行和闭合 fence；`truncated: true`，不返回工具错误。 |
| T-08 | 指定文件因 bytes、more-lines 或 line-length 截断 | 保持既有输出/UTF-8 规则；`truncatedByBytes || hasMoreLines || truncatedByLineLength` 映射为 V2 `truncated: true`。 |
| T-09 | 指定文件普通短行且无 bytes/more-lines/line-length 截断 | `truncatedByBytes`、`hasMoreLines`、`truncatedByLineLength` 均为 false，V2 `truncated: false`。 |
| T-10 | 仅列表截断 | 即使根正文未截断，`truncated: true`。 |
| T-11 | 无正文/文件/section/final fallback 截断 | `truncated: false`。 |

### 指定文件、结果与 runner

| 编号 | 场景 | 必须断言 |
|---|---|---|
| F-01 | 以 `file_path` 指定平级/嵌套普通文本文件 | 返回当前 Worker 通用读取器产生的规范化文本内容；不附 `Skill files`。 |
| F-02 | 指定文件含 CRLF 与孤立 CR | 返回值与通用读取器一致，均规范为 LF；不是换行保真。 |
| F-03 | 指定文件含 BOM | BOM 不出现在 `content`，与当前 decoder 行为一致。 |
| F-04 | 指定文件含超长行 | 与当前 `MAX_LINE_LENGTH` 和 suffix 处理结果一致；包装/扩展结果 `truncatedByLineLength: true`，V2 `truncated: true`。 |
| F-05 | fd-based classifier 可识别的非 UTF-8 文本夹具 | 解码内容与当前通用读取器算法/输出一致，且分类与读取使用同一个已验证 `FileHandle`。 |
| F-06 | 指定空文件 | `content === ""`。 |
| F-07 | 嵌套 `SKILL.md` 含 frontmatter、BOM/CRLF/长行或非 UTF-8 | frontmatter block 不解析、不剥离、不生成展示元数据；其余内容均与通用读取器规范化行为一致。 |
| F-08 | `file_path: "SKILL.md"` | 根读取，不能获得未剥离的根 frontmatter。 |
| F-09 | Worker success entity | 精确有 `skill_id`、规范 `file_path`、`content`、boolean `truncated`；根读取 `file_path === "SKILL.md"`；无 `id`、`skill`、`path`、type、name、description、children。 |
| F-10 | provider | 只读取 `args.skill_id` 和 optional `args.file_path`，映射为内部 `skillId`/`filePath`；不得读取/转换 `args.id`、`args.skill` 或 `args.path`。 |
| F-11 | runner 的非空 content | 回显 `skill_id/file_path/truncated` headers，随后按 `content` 原值输出；headers 不计入 50 KiB content 预算。 |
| F-12 | runner 的 `content === ""` | result entity 保持空字符串；headers 后不生成 `(empty file content)`、`(empty skill content)` 或任何业务占位文本。 |

## 可判定验收标准

以下条件全部满足才可宣布 V2 实现完成：

- `{ skill_id, file_path? }` 是唯一 schema/执行合同，旧 `id` 和未发布中间 `{ skill, path? }` 没有 property、别名或兼容分支。
- tool description、字段 descriptions、系统提示词、provider、Worker、runner 和 authoring 手册一致；模型可见说明精确包含 omit `file_path`、empty string or string containing only spaces/tabs、or exactly `SKILL.md` 根读取，并要求从 `Skill files` 逐行完整复制到 `file_path`。
- 根资格及 `topLevelSkillCount` 严格沿用 `scanReadableTopLevelSkills()`，Worker 使用等价资格；辅助文件文本资格不反向改变 API 顶层发现。
- 根读取使用独立的完整源读取路径，不设 V2 source-size cap；不得先走 `classifyTextSample()` 或 `readTextFileCapped()`；大于 1 MiB 的根、结束边界位于其后段的大 frontmatter、CRLF/孤立 CR、首个结束边界与 API 等价 frontmatter helper 均有自动化测试。
- 指定辅助文件的 CRLF/CR、BOM、长行、可识别非 UTF-8、截断和空内容均证明与当前 Worker 通用读取器一致；fd-based classifier/reader 复用同一已验证 handle，`truncatedByBytes || hasMoreLines || truncatedByLineLength` 必须映射为 V2 `truncated`；嵌套 `SKILL.md` 仅保证 frontmatter block 不解析、不剥离。
- frontmatter 的 LF/CRLF/BOM/边界/重复字段/引号/大小写 key 行为均自动化测试并一致。
- file_path 按四步原始值算法处理；仅 spaces/tabs-only 根特例有效，`" SKILL.md"`、CR/LF、U+2028/U+2029、U+FEFF 与 NBSP-only 均不被 trim 后误接受。
- stable identifier 仅以 `trimAsciiSpaceTab()` 移除 `skill_id` 整体两端 ASCII SPACE/TAB；空/ASCII SPACE/TAB-only 为 `skill is required`，前后 CR/LF/U+2028/U+2029/U+FEFF/NBSP 为 `invalid skill identifier`，规范 `skill_id` 必须进入结果和 mapping。其 2/3/4 段、well-formed Unicode/lone surrogate、U+0060/`Cc`/`Cf`/U+2028/U+2029 拒绝、段内空白、精确大小写 mapping 与非法/未命中错误分流均有测试；不可调用物理条目不得进入 prompt、Worker mapping 或 `listWorkspaceTopLevelSkills().items`，不新增 schema 状态字段，`items.length < topLevelSkillCount` 不改变发现/count。
- 根文件列表是全量扫描、固定 UTF-16 code-unit 排序后的确定性前缀，非树，且每行可直接完整复制为 file_path；501 有界选择的输出必须等价于概念全量排序前缀。
- POSIX 非 UTF-8 filename bytes 必须跳过，真实 U+FFFD 文件名可列出并回读，所有 `Skill files` 路径均可按原字符串回读。
- 所有容量以 UTF-8 字节计量，正文 40 KiB、section 10 KiB、content 50 KiB、最多 500 路径以及 `content === body + section` 均精确可断言；根超限精确使用一次 `ROOT_BODY_TRUNCATION_SUFFIX`；正常算法不触发 final fallback，测试 helper 才覆盖其 invariant protection。
- 任一正文/指定文件/列表/final fallback 截断都使 `truncated: true`。
- prompt 空 description 省略、workspace API/shared contract 的 `description: ""` 兼容和 UI 空描述不渲染均独立验收。
- 所有固定公开错误字符串和底层映射都有精确断言，且输出不泄露绝对路径。
- 辅助文件最终读取在 lstat/realpath 后完成 `dev`/`ino`、`O_NOFOLLOW`、`FileHandle.stat()` / `fstat` 和 fd 读取的 TOCTOU 重检；替换为 symlink/different inode 均被脱敏拒绝，平台能力缺失有等价防护测试。
- runner 对 `content === ""` 保持空结果，headers 后不出现 `(empty file content)`、`(empty skill content)` 或其他业务占位文本。
- builtin/workspace/repo、external roots、静态缓存及非 skill 工具回归通过。
- `skills/skill-authoring/SKILL.md` 已重写：移除 id/children/子 skill，首个目录示例为平级 `SKILL.md`、`reference.md`、`examples.md`、`checklist.md`；仅大型 skill 才展示多级结构。

## 代码审查清单

### 合同与实现

- 是否在同一提交更新 schema、工具级 description、字段 descriptions、prompt、provider、Worker、runner 与 authoring 手册？
- 是否不存在可到达的 `args.id`、`args.skill`、`args.path`、`skill.id`、旧 node 或 children 执行分支，且外部 snake_case 已映射为内部 `skillId`/`filePath`？
- API 与 Worker 的根资格、frontmatter helper/测试向量是否严格等价？
- 根正文是否精确使用一次 `ROOT_BODY_TRUNCATION_SUFFIX`，且不因前缀行尾调整其序列化？
- `truncated` 是否仅按协议的“任一截断即 true”实现，没有选择性条件，且指定文件包含 line-length 截断来源？
- `skill_id` 是否只使用 `trimAsciiSpaceTab()`（不使用 JavaScript `trim()` / `trimStart()` / `trimEnd()`），并把规范值写入 mapping、result entity `skill_id` 与 headers？
- file_path 根判定是否只接受缺失、empty、spaces/tabs-only 和精确 `SKILL.md`，从未使用 `filePath.trim()` 或笼统 whitespace 判定？
- identifier/path 输入是否拒绝 lone surrogate；POSIX 枚举是否完成 fatal UTF-8 round-trip 而未误拒绝真实 U+FFFD？
- runner 是否对空 `content` 保持为空、没有业务占位？

### 扫描、安全与序列化

- 是否完成全体候选扫描/资格检查，同时使用 `MAX_SKILL_FILE_PATHS + 1` 的 501 有界选择，而非无界保存路径？
- 是否未使用 `localeCompare()`，并且输出等价于全量排序前缀；第 501 条/`hasMore` 是否覆盖 500 项和 10 KiB 的截断判定？
- dotfile 是否确实与普通文件同等待遇？后代遍历失败是否仅记录受控诊断并继续？
- section 和 final content 是否全部按 `Buffer.byteLength(..., "utf8")` 计量？
- 兜底是否只缩减 section，不裁正文，不留下半行或未闭合 fence？
- 是否执行 lexical、lstat、realpath 和读取时 `dev`/`ino`、`O_NOFOLLOW`、`FileHandle.stat()` / `fstat` 重检，并由同一 fd-based classifier/reader 复用该 `FileHandle`、使用固定公开错误？
- `listWorkspaceTopLevelSkills().items` 是否过滤不可调用 identifier，且未新增 shared schema callable 状态字段？
- 顶层目录不存在是否映射为 `skill not found`，而目录仍在但直属根 `SKILL.md` 失效是否映射为 `skill root is not readable`？

### 文档与非目标

- 是否没有顺带改变 external roots 候选发现、启用、`topLevelSkillCount` 或 run cache？
- 是否未将辅助文件文本分类改成顶层根发现门槛？
- 是否没有把树形目录或 `children` 重新引入描述、prompt 或 authoring 手册？

## 建议验证命令

以下命令应在仓库根目录、实施完成后执行；本设计文档阶段不声称已执行或通过：

```bash
npx tsx --test apps/agent-worker/src/runtime/fileTools.test.ts
npx tsx --test apps/agent-worker/src/runtime/runner.skill-output.test.ts
npx tsx --test apps/api/src/modules/workspaces/workspace.service.test.ts
npm run test:integration -w apps/api
npm run typecheck
npm run build
```

若测试文件在实施中拆分，必须执行覆盖等价职责的 `tsx --test` 命令并记录实际结果；不得因为文件移动跳过 Worker、runner 或 workspace roots 回归。

## 文档一致性检查

实施评审前应检索当前协议残留，并逐项判定是否仅为历史迁移解释：

```bash
rg -n 'args\.id|skill\.id|required: \["id"\]|children:|skill node|子 skill' \
  apps/api apps/agent-worker skills/skill-authoring

rg -n 'toolArgsSchema\("skill"\)|toolDescription\("skill"\)|buildSkillsInstructionSection|runSkillTool|case "skill"' \
  apps/api apps/agent-worker
```

当前 schema、工具说明、prompt、运行时代码和内置 authoring 手册不得残留旧协议指导。审查者还必须对照 `protocol.md` 检查容量常量、比较器、公开错误和四步 file_path 算法，而不能仅依赖文本检索。
