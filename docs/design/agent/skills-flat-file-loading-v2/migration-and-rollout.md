# Skills 扁平文件加载协议 V2：迁移与发布

**状态：proposed**
**协议依据：** [protocol.md](./protocol.md) 是 V2 外部行为唯一真源。本文件仅规定破坏性迁移、发布、风险和回滚，不重新定义读取细节。

## 变更性质

V2 是 `skill` 工具的破坏性变更：旧协议用一个逻辑 `id` 选择顶层/子节点/文件；最终 V2 协议由 `skillId` 传入 stable skill identifier 选择一个顶层根，optional `filePath` 选择一个根内文件。

```json
{
  "skillId": "builtin/skill-authoring",
  "filePath": "reference.md"
}
```

- 根读取不再返回 `children`，而是正文后的扁平 `Skill files`；每一行均可直接完整复制到 `filePath`，因此不采用树形结构。
- 子目录 `SKILL.md` 不再是子 skill，而是普通文本文件。
- schema、prompt 和执行器一次性从 `{ id }`、未发布的 `{ skill, path? }` 及 `{ skill_id, file_path? }` 切换为 `{ skillId, filePath? }`；不得保留任一旧字段兼容、别名或隐式转换。
- 所有公开错误、filePath 判定、容量和 `truncated` 均以 protocol 的固定合同为准。

## 旧调用与新调用对照

| 旧协议 | V2 | 迁移说明 |
|---|---|---|
| `{ "id": "builtin/tooling" }` | `{ "skillId": "builtin/tooling" }` | 顶层根读取，返回正文 + 扁平可复制路径清单。 |
| `{ "id": "builtin/tooling/reference.md" }` | `{ "skillId": "builtin/tooling", "filePath": "reference.md" }` | 将顶层标识与根内文件路径拆分。 |
| `{ "id": "workspace/team-skills/deploy/docs/api.md" }` | `{ "skillId": "workspace/team-skills/deploy", "filePath": "docs/api.md" }` | 保留 namespace，filePath 始终相对 skill 根。 |
| `{ "id": "repo/repo-a/project-skills/release/examples" }` | 无目录读取替代 | V2 只允许文件。若旧目录是子 skill，迁移为 `examples/SKILL.md` 的普通读取或提升为独立顶层 skill。 |
| 消费 node 的 `children` | 根读取后从 `Skill files` 完整复制 filePath | 列表不是树、不是白名单；截断未列出的合法文件仍可按已知 filePath 读取。 |
| 解析嵌套 `SKILL.md` 元数据 | `{ "skillId": "...", "filePath": "nested/SKILL.md" }` | frontmatter block 不解析、不剥离；内容仍为当前 Worker 通用读取器产生的规范化文本内容。 |

## Skill 内容迁移

顶层根可保持原样：

```text
my-skill/
├── SKILL.md
├── reference.md
├── examples.md
└── checklist.md
```

根 frontmatter 可保留、删除或修正；它只影响展示。完整边界才被剥离，`name` 为空回退目录名，`description` 为空省略。小型 skill 应优先平级；只有大型或明确分类时保留多级目录。

“description 为空省略”只适用于模型 prompt 的展示语义：现有 workspace top-level skills API/shared contract 继续返回必填 `description: ""`，UI 不渲染空描述。该兼容边界不在本期迁移为 optional 字段。

旧子 skill 迁移规则：

| 旧内容意图 | 推荐迁移 |
|---|---|
| 嵌套 `SKILL.md` 是补充说明 | 保留普通文件，通过 `filePath: "deploy/SKILL.md"` 读取。 |
| 嵌套 frontmatter 曾用于展示 | 删除或保留为正文文本；不再依赖其生成摘要。 |
| 子目录只有一个文件 | 平移为根级语义文件，例如 `deploy.md`。 |
| 子目录有多份同类资料 | 保留目录，使用清晰路径如 `deploy/checklist.md`。 |
| 旧子 skill 需要独立摘要/选择 | 拆成独立顶层 skill，或在根正文导航到普通文件；不得复建子节点。 |

## external roots、顶层发现与缓存

V2 不改变下列系统模型：

| 项目 | 保持的规则 |
|---|---|
| builtin | `builtin/<skill-dir>`，默认可用。 |
| workspace external | `workspace/<rootDir>/<skill-dir>`，仍须用户启用。 |
| repo external | `repo/<repoId>/<rootDir>/<skill-dir>`，仍须用户启用。 |
| 顶层发现与 count | 严格沿用 `scanReadableTopLevelSkills()`：一级非 symlink 根、直属非 symlink 普通根文件、readFile 成功、无 NUL、现有 UTF-8 解码。frontmatter 不影响有效性。 |
| 辅助文件资格 | 继续使用 Worker 文本分类/读取能力；不得反向改造顶层发现或 `topLevelSkillCount`。 |
| run cache | root 设置或摘要变化在后续 run 生效；当前 run 静态 context 不动态刷新。 |

Worker 与 API 均按完整根文件读取、全文件 NUL 检查和 `Buffer.toString("utf8")` 等价语义处理根；根 frontmatter 在完整解码文本上解析，不经辅助读取器的行规范化或长行截断。对同一未变更且可生成合规 identifier 的根，API 可发现即 Worker 可根读取；非法 identifier 的物理发现条目按协议排除，其他失败只可能来自发现后的文件系统竞态、权限变化或中止。本期不新增根源大小门槛。

如未来需要 root source cap，必须在 API 发现、prompt、`topLevelSkillCount` 与 Worker 一致地另立版本设计；不得只在 Worker 添加拒绝。

指定辅助文件不是字节级或换行级保真读取：它继承 Worker 通用读取器的编码选择、decoder、BOM 行为、CRLF/孤立 CR 规范化、长行处理和既有输出截断。V2 必须由同一已验证 `FileHandle` 的 fd-based core 完成分类和读取，不能在安全检查后按 file path reopen；未来该通用能力变更会同步影响指定文件内容，不构成 V2 独立读取格式变更。

stable `skillId` 仅允许 `trimAsciiSpaceTab()` 移除整体两端 ASCII SPACE/TAB：缺失、空或 ASCII SPACE/TAB-only 为 `skill is required`，前后 CR/LF、U+2028/U+2029、U+FEFF、NBSP 不会被移除且为 `invalid skill identifier`；结果 `skillId` 和 mapping 使用规范值。stable identifier 和辅助 `filePath` 的每个 segment 必须是 well-formed Unicode scalar sequence，并拒绝 lone surrogate、U+0060 反引号、`Cc`、`Cf`、U+2028/U+2029，确保固定 ```text fence 不受路径行注入。POSIX 辅助文件枚举需用 buffer filename 或等价 fatal UTF-8 decode/re-encode round-trip 跳过不可无损表示的 bytes；真实 U+FFFD 不因字符本身被拒绝。物理发现/count 不因不可生成合规 identifier 的目录或 mapping 改变，但 prompt、Worker 可调用 mapping 与 `listWorkspaceTopLevelSkills().items` 必须过滤它；不得新增 shared schema callable 字段。因此 `items.length` 可以小于物理 `topLevelSkillCount`，这是有意差异，UI 无需 callable 状态；同时记录受控诊断。

发布前必须用三个命名空间验证根读取、指定读取、dotfile、嵌套 `SKILL.md`、固定错误与 `truncated`；stable identifier 只接受 `builtin/<skillDir>`、`workspace/<rootDir>/<skillDir>`、`repo/<repoId>/<rootDir>/<skillDir>` 的精确 2/3/4 段形状，同 display name 的不同 roots 仍只能靠该标识消歧。

## 一次性切换与发布步骤

### 原子变更

同一发布单元必须同步包含：

- `toolArgsSchema("skill")`、工具级 description、`skillId`/`filePath` descriptions、Skills 系统提示词和摘要呈现；
- provider 的 `args.skillId`/`args.filePath` 接收、直接传入内部 camelCase 入参的 `runSkillTool`、固定错误映射，以及从 camelCase result 取值、固定渲染 `skill_id:`/`file_path:` text headers 的 runner；
- 完整根读取/frontmatter helper 向量与固定 `ROOT_BODY_TRUNCATION_SUFFIX`、辅助文件规范化读取及 `truncatedByLineLength` 元数据、spaces/tabs-only 根 `filePath`、`trimAsciiSpaceTab()` `skillId` 规范化、lone surrogate/U+0060/`Cc`/`Cf`/U+2028/U+2029/U+FEFF/NBSP 回归、POSIX fatal UTF-8 round-trip、全量扫描/501 有界选择、UTF-8 section/content 容量与 `truncated` 测试；
- 辅助文件 `dev`/`ino` identity、`O_NOFOLLOW`、`FileHandle.stat()` / `fstat` 重检、同一 `FileHandle` fd-based classifier/reader 的 TOCTOU 测试，以及 external roots、`topLevelSkillCount`、`listWorkspaceTopLevelSkills().items` 过滤和 run cache 回归；
- workspace API/shared contract 的 `description: ""` 兼容与 UI 空描述渲染回归；
- runner 空 `content` 无业务占位文本的回归；
- `skills/skill-authoring/SKILL.md` 重写；
- 面向外部调用者的 breaking-change release note。

不得分批部署为“新 schema + 旧 Worker”或“新 Worker + 旧 prompt/authoring 手册”。若 API 与 Worker 独立部署，必须锁步发布或先在切流前验证两端均为 V2；回滚也必须是完整发布单元。

### 发布前

- 完成 `test-and-acceptance.md` 所列自动化测试、容量/排序/错误断言及人工审查。
- 检查只存在最终 V2 schema；任何 `{ id }`、未发布的 `{ skill, path? }` 或 `{ skill_id, file_path? }` 调用均应在验证/执行入口被拒绝，不添加运行期转换。
- 检查 schema 不以 `skillId.minLength` 抢先拒绝空字符串；缺失、空或 ASCII SPACE/TAB-only `skillId` 必须能到达 Worker 并精确返回 `skill is required`。
- 检查 tool description、字段 descriptions、prompt 与 authoring 手册都说明“扁平可复制 filePath”，而不是树/children；schema、工具说明和 prompt 对根读取均准确写为 omit `filePath`、empty string or string containing only spaces/tabs、or exactly `SKILL.md`，不得使用笼统的空白字符串说法。
- 检查完整根读取不设 V2 source-size cap，且无 NUL 的大根/API 可发现根均可由 Worker 根读取；只对输出正文应用 40 KiB 预算。
- 检查根正文使用精确 `ROOT_BODY_TRUNCATION_SUFFIX = "\n\nRoot skill content truncated."`：UTF-8 前缀加 suffix 合计不超过 40 KiB、suffix 恰好一次，且不因前缀行尾变化。
- 检查 40 KiB 根正文、10 KiB 完整 section、50 KiB content、500 路径都按 `Buffer.byteLength(..., "utf8")` 验证；`body.length > 0` 时 section 含自己的前导片段，`content = body + section`；空候选集合与非空集合但零路径前缀分别序列化；正常算法是数学不变量，final fallback 只记录内部 invariant violation 并缩减 section。任何截断均为 `truncated: true`。
- 检查指定辅助文件的 CRLF/CR、BOM、长行、可识别非 UTF-8、截断和嵌套 `SKILL.md` frontmatter block 行为均与 Worker 通用读取器一致；bytes、more-lines、line-length 任一截断均传递为 V2 `truncated: true`。
- 检查 runner 对 `content === ""` 不输出 `(empty file content)`、`(empty skill content)` 或其他业务占位。
- 检查物理 `topLevelSkillCount` 不变，而 prompt、Worker mapping 和 `listWorkspaceTopLevelSkills().items` 都过滤非法 identifier；确认 `items.length < topLevelSkillCount` 是有意 API 差异且 UI 无需 callable 状态。
- 检查所有候选均扫描并资格检查；501 有界选择的输出与概念全量排序前缀相同，即使 section 在 500 项前截断也能正确标记遗漏。
- 检查调用方 `skillId`/`filePath` segment 的 lone surrogate 被拒绝；POSIX filename 以 fatal UTF-8 decode/re-encode round-trip 枚举，非 UTF-8 bytes 不列出而真实 U+FFFD 可列出/回读。
- 检查 `skillId` 仅以 `trimAsciiSpaceTab()` 接受整体 ASCII SPACE/TAB 包裹，并在 result `skillId` 与 Runner `skill_id:` header 值中回显规范值；空或 ASCII SPACE/TAB-only 为 `skill is required`，而 CR/LF/U+2028/U+2029/U+FEFF/NBSP 包裹的输入为 `invalid skill identifier`。
- 检查辅助文件在最终读取时保存并复核 `dev`/`ino`，支持时使用 `O_NOFOLLOW`，通过 `FileHandle.stat()` / `fstat` 后由同一 handle 的 fd-based classifier/reader 完成读取；分类与内容读取之间替换路径不能读取替换对象，symlink 或 inode 替换被脱敏拒绝，能力缺失有等价防护和平台测试。
- 检查目录不存在（含 prompt 缓存后删除）精确为 `skill not found`，目录仍在但根 `SKILL.md` 缺失/失效精确为 `skill root is not readable`。
- 准备明确发布说明：旧 `{ id }`、未发布的 `{ skill, path? }` 与 `{ skill_id, file_path? }` 均不支持、目录不可作为 `filePath`、精确 stable identifier 段规则及 U+0060/`Cc`/`Cf`/U+2028/U+2029 限制、嵌套 `SKILL.md` 的 frontmatter block 不解析/不剥离但内容规范化、完整根读取与 API 可发现即可加载合同、固定根截断 suffix、prompt 空 description 省略而 workspace API 仍返回空字符串兼容字段，以及固定公开错误字符串可能影响外部调用者的错误处理。

### 发布后

- 对 builtin、workspace、repo 做黑盒冒烟：根读取、空正文列表、列表路径读取、dotfile、嵌套 `SKILL.md`、非法 path、目录、binary 与 inaccessible 目标。
- 观察按固定错误字符串聚合的脱敏指标；不得上报真实绝对路径。
- 观察大目录根读取时延和中止行为。性能优化可以改善扫描实现，但不得因 500 项或 section 输出预算提前停止候选扫描、改变固定排序或改变输出容量合同。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| schema/prompt/Worker 不同步 | 原子交付、锁步发布、provider/API/runner 集成测试。 |
| 旧 authoring 文档继续诱导旧调用 | 将该文件重写列为发布前硬门槛。 |
| 大目录排序不稳定、仅扫描前缀或路径数组无界膨胀 | 扫描/资格检查全体候选，使用固定 UTF-16 code-unit comparator 的 501 有界选择；输出与概念全量排序前缀一致。 |
| 多字节字符串突破预算/破坏 fence | 仅用 `Buffer.byteLength` 计量，UTF-8 边界裁剪，section 兜底只删除完整路径/结构。 |
| 根截断输出序列化歧义 | 冻结 `ROOT_BODY_TRUNCATION_SUFFIX`，以最长有效 UTF-8 前缀加固定 suffix，且 suffix 恰好一次。 |
| 根发现与 Worker 根定位不一致 | 共享/等价实现 `scanReadableTopLevelSkills()` 的根资格测试。 |
| 大 frontmatter 被通用读取器预截断 | 根专用 helper 在完整源文本上解析首个结束边界；根读取不得调用 `readTextFileCapped()` 或设置 V2 source-size cap。 |
| Markdown fence 被路径内容扰乱 | identifier/path segment 拒绝 U+0060、`Cc`、`Cf`、U+2028/U+2029；列表只序列化合规路径。 |
| 非空候选集合无法放入第一条路径 | 最大确定性前缀可为 0；只输出标题和 code block 外截断提示，且已知合规 path 仍可读。 |
| 通用读取器演进影响辅助文件内容或遗漏长行截断状态 | 明确指定读取继承该读取器的规范化文本行为；包装/扩展 `truncatedByLineLength`，并以三种截断来源的回归测试守护。 |
| 后代遍历失败导致根读取失败 | 跳过失败项/子树、记录受控诊断、继续兄弟项；直接读取走固定错误。 |
| 读取时路径/链接 TOCTOU 绕过 | 原始 path 逐步算法、lexical+lstat+realpath、`dev`/`ino` identity、`O_NOFOLLOW`、fd stat 重检和 fd 读取；能力缺失必须采用等价防护，所有失败均无绝对路径。 |
| 根/文件空内容被 runner 伪造成业务文本 | headers 后按原始 `content` 输出，空字符串保持空，不添加占位。 |
| 外部直接调用者仍传 id | release note 明示 breaking change；不提供兼容层。 |

## 回滚边界

允许的回滚只能是把 API、Worker、prompt 与内置文档一起回到上一完整协议版本。不得在 V2 Worker 临时接受 `id`，不得只回滚 schema/prompt/authoring 手册，也不得混合某些 roots 使用 V2、某些 roots 使用旧节点模型。

若上线后需更改 V2 的公开字符串、path、排序、容量或截断行为，必须先提出显式后续版本设计；不得静默扩大输入接受范围或恢复子 skill。

## 历史文档关系

历史文档保留决策记录，本期不改写其正文：

| 历史文档 | 仍有效内容 | 被 V2 覆盖内容 |
|---|---|---|
| `skills-dual-roots-and-run-cache-v1.md` | 顶层摘要、按需加载、静态缓存的历史方向 | 任意 `SKILL.md` 节点、单 id、目录读取、children。 |
| `skills-repo-roots-optional-v1.md` | roots 演进背景 | 旧标识/node 读取描述。 |
| `skills-external-roots-unified-cutover-v1.md` | builtin/workspace/repo、external root 发现/启用、后续 run 生效 | 旧 `runSkillTool` id、子 skill、children。 |

实现合入后可以在历史文档附近添加“读取协议已由 V2 覆盖”的链接，但不得通过改写历史正文掩盖旧协议。
