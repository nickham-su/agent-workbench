# 测试与验收标准

> 状态：**待实施**
> 本文是开发完成、代码审查与回归验收的共同检查表。所有“必须”项应有自动化测试，除非明确标注为人工验收。

## 验收总则

- 测试使用真实临时 workspace 与真实文件系统，不能只 mock 字符串路径而绕过软链、realpath、TOCTOU 和权限行为。
- 对外路径断言均使用 POSIX `/`，不依赖 `readdir()` 顺序、locale、本机路径分隔符或 Unicode 规范化。
- 日志、HTTP 响应、快照和断言失败信息不得输出绝对 workspace 路径、密钥或环境内容。
- 不增加旧 API、旧 settings、repo/root ID 的兼容测试；最终只验证新模型。
- 现有读取回归必须保留：AGENTS 单文件二进制忽略与截断、Skill V2 根/辅助文件读取、frontmatter、软链和竞态安全读取。

## 发现器与 API 验收

### 基础深度、身份和一次扫描

在一个 workspace 建立：

```text
AGENTS.md                         # AGENTS，深度 0
SKILL.md                          # 根 Skill，无效
one/AGENTS.md                     # AGENTS，深度 1
one/SKILL.md                      # Skill: one
one/two/AGENTS.md                 # AGENTS，深度 2
one/two/SKILL.md                  # 被 one 屏蔽
x/y/z/w/AGENTS.md                 # AGENTS，深度 4
x/y/z/w/SKILL.md                  # Skill: x/y/z/w
x/y/z/w/v/AGENTS.md               # 深度 5，无效
x/y/z/w/v/SKILL.md                # 深度 5，无效
```

必须断言：

- detect 一次调用同时返回 `skills` 与 `agentsInstructions`，且一次 HTTP GET 只调用一次完整 discovery 服务。
- `skills` 只有 `one` 与 `x/y/z/w`；不包含根 Skill、深度 5 或嵌套屏蔽项。
- `agentsInstructions` 包含深度 0、1、2、4 的精确路径，不包含深度 5。
- 初始候选均为 `enabled: false`；detect/settings 的初始 `updatedAt` 为 0。
- 重复 detect 的候选和排序完全一致。
- mounted repo 目录中的匹配文件只以 workspace 相对路径出现一次；响应不含 `repoId`、`sourceType` 或 root 身份。

### 名称、路径、类型和剪枝

| 输入/状态 | 必须断言 |
|---|---|
| `agents.md`、`AGENTS.MD`、`skill.md`、`SKILL.MD` | 不发现，文件名精确且区分大小写。 |
| 名为 `SKILL.md`/`AGENTS.md` 的目录 | 不形成对应候选。 |
| 目标文件或中间目录是软链 | 不形成候选；中间目录不进入。 |
| `.git/**`、`node_modules/**`、`.agent-workbench/**` | 不发现匹配文件，且不进入子树。 |
| `.claude/skills/review/SKILL.md`、`.agents/AGENTS.md` | 深度合规时发现，证明不笼统跳过隐藏目录。 |
| mounted repo 目录 | 作为普通子目录发现，不重复、不带 repo 元数据。 |
| `a/review/SKILL.md` 与 `b/review/SKILL.md` | 形成不同 ID。 |
| `builtin/review/SKILL.md` | 不注册，不阻断扫描；其它普通候选和其中 AGENTS 仍被发现。 |
| `Builtin/review/SKILL.md` | 大小写不同，不视为 builtin 冲突；深度合规时可注册。 |
| 包含 `/`、`\\`、盘符、空段、`.`、`..`、反引号、`Cc`、`Cf`、`U+2028`、`U+2029` 或格式错误 Unicode 的 settings 输入 | 400，settings 不变。 |
| 段首/尾为 ASCII 空格、Tab、非断行空格或其它 Unicode whitespace 的 Skill ID/AGENTS 路径 | 400；external ID 不得被隐式 trim 后接受。 |
| 合法 Unicode 目录名 | 按文件系统精确字符串发现、保存、运行；不做 Unicode 规范化。 |
| 段中间含合法空格的 Unicode/路径段 | 若不触及段首/尾且其它规则合规，则保持精确路径；不得被 UI/API trim。 |
| 大小写不同的合法 Skill ID/AGENTS 路径 | 作为不同精确字符串处理，不发生大小写折叠。 |
| 非法目录名 | 整个子树不形成合法候选，扫描器剪枝。 |

对跨平台无法稳定建立的非法文件名、权限或 Unicode 场景，可在文件系统集成测试中条件跳过，但共享 parser 的纯函数测试必须覆盖。

### 发现只检查安全元数据

建立：

```text
parent/SKILL.md
parent/child/SKILL.md
parent/child/AGENTS.md
```

必须断言：

- `parent/SKILL.md` 是普通非软链、在 workspace containment 内时，即使其正文是二进制、frontmatter 不完整、为空或后续内容读取会失败，detect 仍注册 `parent` 并屏蔽 `parent/child` Skill。
- detect 不打开/读取 `SKILL.md` 正文。单元测试可注入读取监视器，断言 discovery 不调用内容读取函数。
- `parent/child/AGENTS.md` 仍被发现，证明 Skill 屏蔽没有整体 prune 子树。
- `parent/SKILL.md` 在 metadata 确认前变为不存在、目录、软链或 containment 外对象时，`parent` 不注册也不屏蔽；合规 `parent/child/SKILL.md` 可以注册。
- 根 `SKILL.md` 不注册也不屏蔽 `child/SKILL.md`。

### 新增祖先 Skill 使旧 enabled 子 Skill 陈旧

建立并启用 `parent/child/SKILL.md`，先确认其在新 run、`/skills/top-level` 和 Worker allowlist 中可用；随后新增 `parent/SKILL.md`，不修改 settings。

必须断言：

- 新 run 的唯一完整扫描快照只把 `parent` 作为候选，不再把 `parent/child` 作为外部 Skill 候选。
- 新 run 的 Prompt、internal `externalSkills` 和 Worker allowlist 均不含 `parent/child`；Worker 猜测 `parent/child` 被归一化拒绝。
- `/skills/top-level` 复用同一候选/可用 resolver，亦不返回 `parent/child`。
- detect 仅显示 `parent`，可不显示陈旧 settings 中的 `parent/child`；直到用户提交下一次成功 PUT 前，原 settings 值允许保留但不生效。
- 该测试通过真实 `discoverWorkspaceContextFiles()` 验证祖先屏蔽；运行时不得实现第二套祖先检查。

### 完整扫描与错误语义

| 场景 | 必须断言 |
|---|---|
| workspace 根不存在、根为文件/软链、根 realpath 失败 | detect 返回 409 `WORKSPACE_CONTEXT_SCAN_FAILED`，无候选快照、无绝对路径。 |
| 任一需要扫描的目录或候选文件 `readdir`/`lstat`/`realpath` 返回 `EACCES`、`EPERM` 或未知 I/O | detect 返回同一 409，不返回部分候选。 |
| entry 在 `readdir` 后 `lstat` 前消失，返回 `ENOENT`/`ENOTDIR` | 该 entry 跳过；其它目录完成后仍返回完整可保存快照。 |
| 扫描中替换为软链或 workspace 外对象 | 不进入/不注册；不得泄露真实目标。 |
| 正常扫描 | 不含 partial 标记、issue 数组、目录/候选数量 limit 字段。 |

不得实现目录数、候选数、扫描时间、稳定前缀、partial result 或 scan issue UI。此项与内容总预算无关。

## Settings 与管理 API 验收

### 保存、完整替换与陈旧项

- `PUT /context-files/settings` 同时提交一个已发现 Skill 和一个已发现 AGENTS 时，返回单一 `WorkspaceContextFilesSettingsResponse`，两个集合保存成功。
- settings key 为 `workspace_context_files_v2`，每次成功 PUT 只对该 workspace 产生一次完整 payload 写入；不能出现 Skill 已写入而 AGENTS 未写入的中间状态。
- 空数组合法，代表禁用所有外部 Skill 和 AGENTS。
- PUT 必须自行重新完整扫描；GET 后删除、移动、改名、变为软链或变为目录的候选，在 PUT 中提交旧 ID/路径必须得到 `400 INVALID_CONTEXT_SELECTION`，settings 原样保留。
- 请求中重复、非法、根 Skill、深度 5、builtin 冲突或本次扫描不存在的项返回 400，整个请求不写入。
- 文件新增后默认 disabled；旧启用集合不自动扩大。
- 已启用项删除或移动后，detect 成功时不单独显示陈旧项，也不标为 enabled；运行时忽略。下一次成功 PUT 的完整替换自然清理陈旧值。
- settings 缺失或无法解析时视为空配置；不要求 warning 或 settings store 改造。

### 并发与扫描失败

- 两个合法 PUT 可以并发执行，采用 last-write-wins；最终 settings 必须是其中一个完整请求的两个数组，不能出现交叉拼接、损坏 JSON 或一类数组缺失。
- 不实现 `revision`、`baseRevision`、409 settings conflict 或冲突 UI。
- PUT 的服务端扫描遇到根异常、`EACCES`、`EPERM` 或未知 I/O 时返回 `409 WORKSPACE_CONTEXT_SCAN_FAILED`，不写入任何 settings。
- 前端 detect 失败时没有可保存候选；保存按钮禁用。保存过程中失败时保留用户的未保存勾选和安全错误提示。

## Prompt、Worker 与安全验收

### AGENTS 注入

- 启用多个 AGENTS 时，system prompt 生成多个现有形式的 section：

```text
[agents_instructions] AGENTS.md

...

[agents_instructions] a/AGENTS.md

...
```

- 标签只使用 workspace 相对路径；不得出现绝对路径、repoId、sourceType，或系统生成的层级、作用域、优先级和冲突解释。
- 多个 section 按 UTF-8 字节序稳定排序；乱序创建文件不改变结果顺序。
- 保留 `readAgentsInstructionFile()` 的内容语义：NUL 二进制忽略、单文件 32KB 截断标志、空内容跳过、非普通文件/软链不注入、读取失败跳过。
- 不增加多文件总内容预算、自动裁剪或 token 阈值；两个各自未超过现有单文件限制的启用 AGENTS 都进入结果。
- `resolvePromptWorkspaceContext()` 对每个 AGENTS 只读取一次，返回 `{ filePath, displayPath, content }`；`PromptStaticAssembler` 只拼接该结果，不得再次读取 AGENTS。用可注入读取计数或等价观察点断言一次读取。
- `filePath` 是 API 内部绝对路径，不得出现在 system prompt、detect/top-level/settings 对外响应、internal prompt-context、Worker 参数、日志快照或错误文本；`displayPath` 必须是 `[agents_instructions]` 标签中唯一的路径来源。

### Skill Prompt 摘要与 exact allowlist

建立：

```text
skills/enabled/SKILL.md
skills/enabled/helper.md
skills/disabled/SKILL.md
```

仅启用 `skills/enabled` 后必须断言：

- Prompt external skills 仅列 `skills/enabled`，不列 `skills/disabled`。
- API→Worker internal prompt-context 的 `externalSkills` 只含 `availableExternalSkills` 的精确 ID/目录映射；测试不输出真实绝对目录。
- Worker 读取 `skills/enabled` 根和 `helper.md` 成功，继续符合既有 V2 frontmatter、辅助文件列表、截断与安全读取测试。
- Worker 猜测 `skills/disabled` 时返回归一化不可用错误，不能读取根或辅助文件。
- Worker 即使收到内部错误映射，也拒绝 workspace 外、软链替换和打开前后被交换的目录/文件，保持 `O_NOFOLLOW`、identity revalidation 和 containment 防线。
- 内置 `builtin/<skillDir>` 行为不回归；`builtin/foo/bar` 与被保留命名空间跳过的外部路径不能绕过 parser 或 allowlist。
- API 摘要读取只读取直属根 `SKILL.md` 以得到 `skillId`、name/description；测试通过监视器断言它不递归枚举辅助文件、不构造根正文、不生成 `Skill files` 列表，也不执行 Worker 的 40KB/10KB/50KB 输出预算。
- `/skills/top-level` 只调用当前完整扫描、settings 与 API Skill 摘要子流程；测试断言该请求不读取任何 AGENTS 内容。
- 只有模型实际调用 `skill` 工具才触发根正文处理、辅助文件递归枚举、扁平文件列表和既有输出截断；调用前的 detect、Prompt resolver 与 top-level 均不得触发这些 Worker 行为。
- `/skills/top-level` 使用同一个可用 Skill resolver，其外部项与当前 resolver 结果中的 Prompt 列表、`externalSkills` allowlist 相同；detect 仍可显示仅具安全元数据的候选。

对已启用且仍在当前候选集合内的单个 Skill，分别制造根文件二进制、权限/读取失败、扫描后软链替换或安全校验失败；必须断言该 Skill：

- 仍可由 detect 作为候选显示（只要当次 detect 的安全元数据检查合规）。
- 在对应 resolver/new run 中同时不出现在 Prompt Skill 列表、internal `externalSkills` 和 `/skills/top-level`。
- Worker 因没有 allowlist 项而拒绝该 ID；即使 API 曾成功读取其它 Skill，Worker 仍独立执行所有现有安全校验。
- 空正文、无 frontmatter 或缺少 `description` 不属于失败：只要现有摘要读取成功，Skill 仍同时出现在三处，名称按既有回退规则生成。

### 内容读取与缓存

- Skill 候选发现不受二进制/无 frontmatter/内容读取失败影响；`availableExternalSkills` 则要求当前候选/settings 交集通过现有摘要读取与安全校验。
- 允许把 AGENTS/Skill 读取日志改为 workspace 相对路径；测试确认普通错误和 Prompt 不泄露绝对路径。
- 每个新 run 首次组装静态 Prompt 时只执行一次完整扫描/resolver；测试以可观测调用点断言 Prompt、internal allowlist 不会各自再次扫描或计算可用集合。
- 新 run 的完整扫描遇到 `EACCES`、`EPERM` 或未知 I/O 时，静态 Prompt 构造失败，不能使用旧 settings 或已缓存其它 run 的集合；同一已启动 run 仍保持自身缓存内容。
- `/skills/top-level` 的完整扫描遇到同类阻断错误时返回 `409 WORKSPACE_CONTEXT_SCAN_FAILED`，不返回仅按 settings 推导的外部 Skill 列表。
- 首次为某 run 组装静态 Prompt 后修改 settings、文件内容或 Skill 嵌套结构，同一 run 继续复用 `RunPromptStaticCache`；新 run 反映变化。
- 不引入文件监视、隐式 invalidation 或当前 run 热刷新。

## 前端验收

组件/交互测试或可复现人工验收必须覆盖：

- 打开管理弹窗只发起一次 context detect 请求；不再并发两个旧 detect 请求。
- Skill 和 AGENTS 都逐行勾选；Skill 显示稳定 ID，AGENTS 显示相对路径。
- 初始 checkbox 严格反映 detect 的 `enabled`；新候选未选中。
- detect 成功前和 detect 失败后保存不可用；失败时显示安全错误，不显示 partial 候选。
- 保存只发一次 unified PUT，body 含两个完整选择数组；成功关闭弹窗并发出 `agent-settings-updated`。
- 400 或 409 扫描失败时不关闭弹窗、不伪造已保存状态；不实现 revision conflict 提示。
- UI 显示“更改将在新 run 中生效”，不显示 repoId、rootDir、top-level count、绝对路径或 AGENTS 层级解释。

## 回归命令与通过门槛

实际命令应以 `package.json` 为准。至少执行：

```bash
npm run build -w packages/shared
npm run typecheck
npm run test -w apps/api
npm run test -w apps/agent-worker
npm run test -w apps/web
```

若命令不存在或因已知无关问题失败，必须记录命令、失败范围、关联判断与已通过的相关子集；不得把未执行测试写为通过。

最终通过门槛：

- 发现、settings、Prompt、Worker、UI、安全和缓存边界均有本页对应的测试或人工验收记录。
- 共享构建和根级 `npm run typecheck` 通过。
- API→Prompt-context→Worker 不存在公共 root 授权，禁用 Skill 无法猜测读取。
- 不残留旧 root/repo API、settings、契约或最终兼容层。
- 未引入内容总预算、AGENTS 层级提示、文件监视或当前 run 热刷新。
