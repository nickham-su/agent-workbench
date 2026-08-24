# `apply_patch` 优化方案设计文档

**状态**：草案，待开发实现

**目标读者**：`agent-workbench` 维护者、后端开发者、代码审查者、验收者

**适用范围**：

- `agent-worker` 内置文本编辑工具 `apply_patch`
- `api` 层对 `apply_patch` 的工具描述、结果瘦身、UI artifact 写入
- `agent` 调用链路中与 `apply_patch` 相关的提示词、错误反馈、重试决策
- 与 `write` 工具形成对比的编辑路径选择

---

## 背景与问题定义

当前项目中的 `apply_patch` 已经具备基础能力：

- 支持统一 diff 解析
- 支持多文件修改、删除、重命名/移动
- 支持对路径、文件类型、工作区边界的安全校验
- 对部分常见失败提供了更明确的报错
- 在 `prepareApplyPatchTool` 阶段已经有“准备”和“执行”两个函数入口

但在真实使用中，模型调用 `apply_patch` 仍然容易失败，并且在失败后常常退化为 `write`，直接重写文件。这样会带来几个实际问题：

- 局部修改被升级成整文件重写，token 成本增加
- 一次轻微格式错误会导致整个 patch 失效，浪费工具调用
- 失败信息不够结构化时，模型很难自行修正
- patch 失败后如果直接切换到 `write`，会扩大改动范围，降低审查效率

本次优化只先做三项，是因为这三项同时满足以下条件：

- 对成功率和体感收益高
- 不依赖大量历史数据才能判断价值
- 可以直接借鉴 Codex 与 OpenCode 中已经成熟的实现思路
- 能在不放宽安全底线的前提下提升可用性

这三项分别是：

- 两阶段 `apply_patch`：先完整验证并生成变更计划，再统一落盘
- 保守格式清洗 / LF 解析视图 + 精确报错
- 结构化失败信息（通过稳定文本模板输出）+ prepare 阶段对明确可恢复 IO 错误的一次安全补救重试

同时，本阶段已确认一个重要约束：**不改变 `apply_patch` 对外工具协议**。工具入参仍为 `patchText: string`，成功 / 失败结果仍以文本方式返回；内部可以引入结构化实体辅助实现，但不得要求调用方改用新的返回数据类型。

---

## 需求背景

### 为什么要优化 `apply_patch`

从当前实现和使用体验看，`apply_patch` 的痛点不是“完全不能用”，而是“太容易因为细节失败”。这些失败里，有一部分其实并不代表模型没有改对，而只是：

- patch 被外层代码块包裹
- diff 头部略有不规范
- 行尾 / 空白差异影响匹配
- 上下文不够精确，但改动意图是正确的

如果系统对这类问题的处理过于僵硬，模型就会逐渐形成习惯：

- 先尝试一次 `apply_patch`
- 失败后直接退化到 `write`

这会让 `apply_patch` 失去最核心的价值：**小改动、低成本、可审查**。

### 为什么只做这三项

因为当前阶段的目标不是建立完整观测体系，而是先把“最影响体感”的失败模式解决掉。

这三项的共同特点是：

- 足够具体，能直接落地
- 不需要复杂统计才能验证方向
- 与 Codex / OpenCode 已确认的代码逻辑高度一致
- 可以作为后续更高级模糊匹配、观测体系、数据闭环的基础

### 为什么不先做大规模观测

当前项目的用户规模和使用场景决定了：

- 很难积累足够多的失败样本
- 很难从日志中做出稳定的分桶分析
- 大量埋点会增加实现和维护成本，但不一定立刻带来体感收益

因此本阶段优先依赖：

- 代码行为本身的改进
- 清晰的错误分层
- 人工使用体感反馈

---

## 业务逻辑

### 期望的 agent 调用流程

理想情况下，`agent` 调用 `apply_patch` 时应遵循以下路径：

- 先识别当前是否适合局部修改
- 如果适合，优先调用 `apply_patch`
- `apply_patch` 内部先做保守格式清洗和严格解析
- 如果解析与校验都通过，再生成变更计划
- 变更计划全部就绪后，再统一落盘
- 成功后按稳定文本模板返回结果；内部可保留结构化计划和摘要用于实现、审查和 artifact 生成

### 失败时的目标行为

失败后不应立即退化为 `write`。正确的优先级应是：

- 先判断错误是否可恢复
- 若错误发生在 `prepare` 阶段且属于明确可恢复的 IO 问题，则仅进行一次安全补救重试
- 若仍失败，再通过稳定文本模板返回错误分类、失败文件、可重试性、细节和修复建议，供模型重新生成 patch
- 只有在模型重新评估后，才考虑 `write` 作为最后手段

### 如何避免退化到 `write`

本次设计的核心目标之一，就是让 `apply_patch` 的失败不再是“非黑即白”的终点，而是一个可继续处理的中间态。

因此，系统需要同时做到：

- 让不标准的 patch 有机会被修正后成功
- 让真正不安全或不可恢复的错误立刻失败并说明原因
- 让模型在失败后知道“下一步应该修补 patch，而不是直接重写文件”

---

## 关键决策

### 三项改进的优先级

- 第一优先级：两阶段验证 / 变更计划 / 统一落盘
- 第二优先级：保守格式清洗、LF 解析视图、精确错误定位；BOM / 原始行尾风格保持属于后续增强，不作为本轮阻塞项
- 第三优先级：结构化失败信息、稳定有限的错误分类、`retryable` 判定、prepare 阶段一次安全补救重试；对外仍渲染为文本结果

### 默认行为

- 默认启用保守格式清洗与 LF 解析视图
- 默认启用严格安全边界
- 默认启用两阶段流程
- 默认仅允许 prepare 阶段一次安全补救重试，且仅限明确可恢复的 IO 错误
- 默认不在工具内部自动降级为 `write`

### 对外协议不变

本阶段明确采用“**内部结构化、外部文本化**”的策略：

- 工具名称不变：仍为 `apply_patch`
- 入参不变：仍只要求 `patchText: string`
- 返回类型不变：成功 / 失败仍以文本方式返回
- 不新增模型必须填写的参数，如 `mode`、`attemptRepair`、`strictMode`
- 不要求调用方解析新的 JSON 结果结构
- `PatchApplyPlan`、`PatchValidationIssue`、`ApplyPatchToolFailure` 等只作为 worker 内部实现模型，用于组织流程、测试和渲染最终文本

这样可以在不破坏现有调用习惯、API 协议和上下文投影逻辑的前提下，提升工具的可诊断性和可恢复性。

### 文本结果固定模板

成功与失败结果都应使用稳定文本模板。模板可以返回更多信息，但必须仍然是文本。

成功模板建议：

```text
Success. Updated the following files:
M path/to/file.ts (+3 -1)
A path/to/new-file.ts (+20 -0)

Notes:
- Patch input was cleaned against the LF parse view before applying.
```

失败模板建议：

```text
apply_patch verification failed: CONTEXT_MISMATCH

Summary:
- Retryable: yes
- Repair attempted: yes
- Failed files: path/to/file.ts

Details:
- path/to/file.ts hunk #2: context did not match current file content.

Hint:
Read the latest target file content and regenerate a smaller patch with accurate context.
```

模板约束：

- 第一行必须出现稳定的错误分类，紧跟 `apply_patch verification failed:`
- `Summary` 中必须包含 `Retryable` 和 `Repair attempted`
- 若能定位文件，必须包含 `Failed files`
- `Details` 用于列出文件、hunk、行号或具体失败原因
- `Hint` 用于给出下一步建议，避免模型直接退化到 `write`
- 字段顺序保持稳定，避免每类错误随意改变输出格式
- `Retryable: yes` 仅表示调用方或模型可以重新尝试，不表示 provider 一定会自动重试
- `Repair attempted: yes` 仅表示 prepare 阶段触发过一次安全补救；apply 阶段不自动重试

### 边界

- 不放宽工作区边界
- 不放宽非法路径限制
- 不放宽二进制 patch、submodule、copy from/to 等不支持能力
- 不对歧义性高的上下文位置做猜测式应用
- 不允许无条件多次重试

---

## 取舍原因

### 为什么不简单放宽校验

简单放宽校验会带来两个风险：

- 把真正错误也当成可接受输入，掩盖模型问题
- 让系统的安全边界变模糊，增加误改风险

因此，正确方向不是“什么都收”，而是：

- 只对格式噪音放宽
- 对语义与安全边界保持严格

### 为什么暂缓模糊 / 锚点匹配

模糊 / 锚点匹配确实有收益，但它会显著增加误改风险。它适合放在后续阶段，前提是：

- 先有稳定的两阶段验证
- 先有清晰的错误分类
- 先有可控的单次补救重试

否则，模糊匹配会把失败变成“看似成功、实际可能改错”的更难排查问题。

### 为什么暂缓大规模观测

当前阶段最缺的不是统计图表，而是：

- 一次 patch 失败后，系统有没有给出足够可操作的反馈
- patch 是否能在小格式问题上自我恢复
- 模型是否还会频繁退化到 `write`

这些可以通过实现改进和体感观察先验证，不必先建设重型观测系统。

---

## 技术方案

### 两阶段验证 / 变更计划 / 统一落盘

#### 设计目标

把当前“解析 + 校验 + 写盘”的过程显式拆成两段：

- 阶段一：解析并验证补丁，生成变更计划
- 阶段二：在计划完整且通过验证后，统一执行写盘

#### 建议流程

- 读取 `patchText`
- 进行保守格式清洗并构建 LF 解析视图
- 解析统一 diff
- 对每个文件变更进行语义校验
- 对每个 hunk 做上下文验证
- 生成完整 `PatchApplyPlan`
- 如果任一变更不合法，返回失败，不写盘
- 如果计划完整，通过后统一执行 `applyPreparedPatch`

#### 关键点

- 阶段一必须具备“预检”语义
- 阶段二不是事务落盘：执行前做快照一致性校验，校验通过后顺序落盘
- 该设计避免校验失败导致的部分写入，但不承诺执行期 I/O 异常下具备事务回滚能力
- `PatchApplyPlan` 视为一次性快照：计划生成后，应基于同一份文件状态执行落盘
- 如果执行前发现目标文件状态与计划生成时明显不一致，应失败并提示重新读取 / 重新生成 patch，而不是边写边修

#### 参考实现启发

- OpenCode 的 `apply_patch.ts` 已体现“先验证、后执行”的组织方式
- Codex 的 `apply-patch` 相关实现强调变更 delta 与失败状态的可追踪性

---

### 保守格式清洗、LF 解析视图、精确错误定位

#### 设计目标

把“模型写得几乎正确但不够标准”的补丁，尽量挽救到可执行状态，但不替模型做语义决策，也不做模糊匹配或语义修补。

#### 建议清洗范围

清洗只做外层格式处理，不做语义修补。允许处理的范围包括：

- 去除首尾空白和首尾空行
- 去除外层 Markdown 代码块包裹，例如 ```diff / ```patch
- 剥离明显包裹性的说明文字，例如补丁前后的“下面是 patch”一类非 patch 文本
- 统一换行符到内部 LF 解析视图，便于解析和定位
- 识别并拒绝明显的 legacy patch 包装，不自动转换为 unified diff

本轮只要求输入解析与定位使用 LF 解析视图。目标文件 BOM / 原始行尾风格保持属于后续增强，不作为本轮阻塞项。

#### 禁止归一化 / 自动修补的内容

以下行为禁止在本阶段实现：

- 自动补全缺失 hunk
- 自动猜测目标文件或目标路径
- 自动改写 patch 语义
- 自动修正不完整的 diff 结构
- 自动把自然语言编辑描述转换成 patch
- 修改补丁正文中真实的增删内容
- 修改语义上必须保留的上下文
- 修改路径、文件名、hunk 结构本身
- 做锚点匹配、相似度匹配或自动语义修补

#### 精确错误定位原则

错误不能只返回“失败”，而应该至少指出：

- 失败类型
- 发生在哪个文件
- 发生在哪个 hunk 或哪类边界
- 是格式错误、路径错误，还是上下文错误
- 是否建议重新读取目标文件后重生成 patch

#### 参考实现启发

- Codex 的 `parser.rs` 与 `invocation.rs` 体现了“严格骨架 + 有限宽松”的思路
- OpenCode 的 `edit.ts` 已对行尾、空白、BOM、文本归一化做过处理；本轮只借鉴保守清洗与 LF 解析视图，BOM / 原始行尾风格保持后续再评估
- 当前项目的 `applyPatchUpdate.ts` 也已经具备部分上下文匹配和友好错误提示能力，可作为后续扩展基础

---

### 结构化失败信息、稳定有限分类、`retryable` 判定、prepare 阶段单次安全补救重试

#### 设计目标

让失败变成可操作的中间态，而不是直接逼迫模型切换到 `write`。

#### 建议分类方式

错误分类应保持少量、稳定、语义清晰，不需要写死某个固定前缀。实现可使用有限枚举或等价分类函数，只要对外文本稳定即可。

- 解析类示例：`EMPTY_INPUT`、`INVALID_FORMAT`、`LEGACY_PATCH_FORMAT`、`UNSUPPORTED_FORMAT`
- 安全类示例：`PATH_OUT_OF_SCOPE`、`BINARY_UNSUPPORTED`、`PERMISSION_DENIED`
- 上下文类示例：`CONTEXT_MISMATCH`、`CONFLICT`
- I/O 类示例：`IO_RETRYABLE`
- 结果类示例：`FILE_NOT_FOUND`

#### `retryable` 判定原则

可重试：

- 仅 `prepare` 阶段明确可恢复的 IO 问题，例如短暂文件系统抖动、临时读写失败、状态检查短暂不可用

不可重试：

- 路径越界、绝对路径、非法路径
- 非法文件类型、二进制 patch、submodule、copy from/to
- 明显歧义，例如多个可能匹配位置但无法唯一确定
- 权限拒绝、安全策略拒绝
- 语义不成立的 patch
- 任何 `apply` 阶段失败

#### 单次补救重试原则

- 只允许一次
- 只对 `prepare` 阶段明确可恢复的 IO 错误触发
- 仅执行一次安全补救重试，且不进入 `apply` 阶段自动重试链路
- 安全类、歧义类、权限类错误绝不自动重试
- 补救动作应可解释、可审计，并在最终文本结果的 `Notes` 或 `Summary` 中体现
- `Retryable: yes` 仅表示调用方或模型可以重新尝试，不表示 provider 一定会自动重试
- `Repair attempted: yes` 仅表示 prepare 阶段触发过一次安全补救；apply 阶段不自动重试

#### 参考实现启发

- Codex 的相关重试逻辑体现了“只对明确可恢复 IO 错误做一次安全重试”的模式
- OpenCode 的 `retry.ts` 和事件错误分层体现了有限、可控的重试思想

---

## 实体 / 数据结构设计

以下结构为设计示意，用于 worker 内部开发实现、审查和验收对齐。它们是**内部模型**，不是新的对外工具协议。当前实现可以继续使用 `ApplyPatchPrepared`、`ApplyPatchFileResult`、快照结构、分类函数和稳定文本模板承载这些信息，不要求逐字同名；本阶段也不要求把成功 / 失败结果改成 JSON 或其他结构化返回类型。最终仍应渲染为稳定文本结果返回给调用方。

```ts
type PatchApplyPlan = {
  rawText: string;
  normalizedText: string;
  dialect: "unified" | "legacy" | "unknown";
  isNormalized: boolean;
  fileChanges: PatchFileChange[];
  validationIssues: PatchValidationIssue[];
  summary: {
    fileCount: number;
    additions: number;
    deletions: number;
    movedCount: number;
  };
  exact: boolean;
  retryPolicy: {
    retryable: boolean;
    retryReason?: string;
    maxAttempts: number;
  };
};

type PatchFileChange = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  lineEnding: "lf" | "crlf" | "mixed" | "unknown";
  hasBom: boolean;
  hunks: Array<{
    header?: string;
    oldStart?: number;
    oldCount?: number;
    newStart?: number;
    newCount?: number;
    oldText: string;
    newText: string;
    exactMatch: boolean;
  }>;
  canApply: boolean;
  reasonIfBlocked?: string;
};

type PatchValidationIssue = {
  code: ApplyPatchErrorCode;
  severity: "error" | "warning";
  retryable: boolean;
  filePath?: string;
  hunkHeader?: string;
  lineNumber?: number;
  message: string;
  hint?: string;
};

enum ApplyPatchErrorCode {
  EmptyInput = "EMPTY_INPUT",
  InvalidFormat = "INVALID_FORMAT",
  LegacyPatchFormat = "LEGACY_PATCH_FORMAT",
  UnsupportedFormat = "UNSUPPORTED_FORMAT",
  PathOutOfScope = "PATH_OUT_OF_SCOPE",
  FileNotFound = "FILE_NOT_FOUND",
  ContextMismatch = "CONTEXT_MISMATCH",
  Conflict = "CONFLICT",
  BinaryUnsupported = "BINARY_UNSUPPORTED",
  PermissionDenied = "PERMISSION_DENIED",
  IoRetryable = "IO_RETRYABLE",
  InternalError = "INTERNAL_ERROR"
}

// 内部成功模型；对外仍渲染为文本结果。
type ApplyPatchToolResult = {
  status: "completed";
  text: string;
  summary: {
    fileCount: number;
    additions: number;
    deletions: number;
  };
  files: Array<{
    type: "add" | "update" | "delete" | "move";
    path: string;
    fromPath?: string;
    before: string;
    after: string;
    additions: number;
    deletions: number;
  }>;
  plan?: PatchApplyPlan;
};

// 内部失败模型；对外仍渲染为固定失败文本模板。
type ApplyPatchToolFailure = {
  status: "failed";
  code: ApplyPatchErrorCode;
  message: string;
  retryable: boolean;
  issues: PatchValidationIssue[];
  plan?: PatchApplyPlan;
  suggestion?: string;
};
```

### 字段说明

- `rawText`：模型原始输入
- `normalizedText`：归一化后的文本，便于复现和审查
- `dialect`：识别到的补丁类型
- `exact`：是否完全精确、无歧义地完成计划与应用
- `retryPolicy`：是否允许一次补救重试
- `fileChanges`：按文件拆分的变更计划，是审查和 UI 展示的核心数据
- `validationIssues`：所有阻断或警告问题
- `lineEnding` / `hasBom`：后续增强预留，本轮不作为验收项；实现可不填或统一视为内部调试信息
- `issues`：内部失败模型中的结构化错误集合，最终应渲染到固定文本模板中

### 与现有结果的关系

当前实现已经有类似的结果瘦身结构：

- worker 侧已有 `files`、`summary`、`text` 等内部结果信息
- API 侧会将 `apply_patch` 结果写入 UI artifact，并对入库结果做瘦身

本阶段的约束是：**对模型和调用方可见的工具结果仍保持文本语义，不要求外部消费 `plan` / `validationIssues` / `retryable` 等新结构化字段。**

建议做法是：

- worker 内部可使用 `PatchApplyPlan`、`PatchValidationIssue`、`ApplyPatchToolFailure` 或等价结构组织流程
- 最终通过固定文本模板渲染成功或失败结果
- API / UI artifact 如需保留结构化信息，应作为兼容性增强或调试信息处理，不应成为模型调用 `apply_patch` 的新协议要求
- prompt projector 应优先投影稳定文本摘要，而不是要求模型解析 JSON 结构

---

## 相关代码引用

### agent-workbench 当前相关文件

| 文件 | 现有作用 | 与本方案的关系 |
|---|---|---|
| `apps/agent-worker/src/runtime/applyPatch.ts` | `apply_patch` 主实现、统一 diff 解析、安全路径、准备与执行 | 两阶段流程的核心落点，现有 `prepareApplyPatchTool` / `applyPreparedPatch` 可作为直接演进基础 |
| `apps/agent-worker/src/runtime/applyPatchUpdate.ts` | 按行匹配、上下文搜索、精确错误提示 | 可作为上下文匹配与错误定位的基础；本方案要求进一步结构化错误输出 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | 工具执行入口、`apply_patch` 调用包装、错误前缀转换 | 需要承接内部失败对象、`retryable` 判定，并将其渲染为稳定文本结果 |
| `apps/api/src/modules/agent/agent.service.ts` | `apply_patch` 工具 schema、工具描述、结果瘦身、UI artifact 写入 | 需要同步更新工具提示，强调入参和返回类型不变、错误文本模板更稳定 |
| `apps/api/src/modules/agent/prompt/tool-projectors/apply-patch.ts` | `apply_patch` 结果投影到上下文 | 需要优先投影稳定文本摘要，避免要求模型消费内部结构化实体 |
| `apps/agent-worker/src/runtime/applyPatch.test.ts` | 现有测试覆盖 legacy patch、move 冲突、失败不落盘等 | 后续验收标准与回归测试的直接依据 |

### Codex 参考位置

以下位置已在调研中确认具有借鉴价值：

| 文件 | 可借鉴点 |
|---|---|
| `codex/codex-rs/apply-patch/src/lib.rs` | 变更 delta、`exact` 状态、失败时保留结构化上下文、明确可恢复 IO 场景的一次安全补救重试、稳定摘要输出 |
| `codex/codex-rs/apply-patch/src/parser.rs` | 严格骨架 + 保守清洗后的解析、行号级错误 |
| `codex/codex-rs/apply-patch/src/invocation.rs` | 显式调用校验、shell heredoc 识别、误触防护 |

### OpenCode 参考位置

以下位置已在调研中确认具有借鉴价值：

| 文件 | 可借鉴点 |
|---|---|
| `opencode/packages/opencode/src/tool/apply_patch.ts` | 两阶段验证 / 计划生成 / 统一落盘 |
| `opencode/packages/opencode/src/tool/edit.ts` | 保守清洗、LF 解析视图、文本处理思路 |
| `opencode/packages/core/src/util/retry.ts` | 有边界的重试策略 |
| `opencode/packages/llm/src/schema/events.ts` | 工具错误与 provider 错误分层 |
| `opencode/packages/opencode/test/tool/apply_patch.test.ts` / `edit.test.ts` | 以行为契约为中心的测试方式 |

---

## 实施步骤

### 阶段一：类型与流程骨架

- 在 worker 侧引入 `PatchApplyPlan`、`PatchFileChange`、`PatchValidationIssue`、`ApplyPatchErrorCode` 等内部结构或等价实现
- 明确这些结构只服务于内部实现、测试和文本渲染，不改变 `apply_patch` 对外入参和返回类型
- 将当前准备阶段拆成更明确的“解析 / 验证 / 计划”步骤
- 保持现有顺序写盘逻辑，但只允许在计划通过后进入 `apply`；不承诺事务回滚或 staging 语义
- 为内部失败对象增加 `retryable` 字段和结构化问题列表
- 实现成功 / 失败固定文本模板渲染，确保错误分类、`Retryable`、`Repair attempted`、`Failed files`、`Details`、`Hint` 等字段稳定输出

### 阶段二：保守格式清洗与 LF 解析视图

- 支持外层代码块、首尾空行、明显说明文本的保守清洗
- 统一换行符到 LF 解析视图，作为解析和定位的内部视图
- 将 legacy patch 和 unified diff 的识别与错误提示整理清楚；legacy patch 直接报错，不自动转换
- 对上下文匹配失败输出更清晰的文件 / hunk / line 信息
- BOM / 原始行尾风格保持在本轮不作为阻塞项，如需支持另行评估

### 阶段三：单次补救重试

- 建立仅包含 `prepare` 阶段明确可恢复 IO 错误的白名单
- 对这类错误允许一次安全补救重试
- 不对 `apply` 阶段失败做自动重试
- 重试失败后直接返回由内部结构化错误渲染出的最终失败文本，不再循环

### 阶段四：API 与提示词同步

- 更新 `apply_patch` 的工具描述，明确对外协议不变：入参仍为 `patchText: string`，结果仍为文本
- 更新工具描述和系统提示，使模型理解固定失败文本中的错误分类、`Retryable`、`Repair attempted`、`Details`、`Hint`
- 更新结果投影，优先投影稳定文本摘要；内部 `plan` / `issues` 不应成为模型必须解析的新数据结构
- 保持 UI artifact 与当前瘦身逻辑兼容，如保留额外结构化信息，也必须是兼容性增强

### 阶段五：测试与回归

- 新增保守格式清洗、错误分类、prepare 阶段安全重试、无部分写入等测试
- 回归 legacy patch、move 冲突、路径越界、文件不存在、重复应用等场景

---

## 安全边界与不可放宽规则

以下规则不得因为容错优化而放宽：

- 不允许写到工作区外
- 不允许绝对路径或带有控制字符的路径
- 不允许覆盖不应覆盖的目标文件
- 不允许二进制 patch、submodule diff、copy from/to
- 不允许歧义性匹配直接落盘
- 不允许无限重试
- 不允许把语义错误包装成“自动成功”
- 不允许在失败后静默回退为 `write`
- 不允许因为内部引入结构化实体而改变 `apply_patch` 对外工具协议
- 不允许把自然语言编辑描述自动转换为 patch
- 不要求本轮实现或验收 BOM / 原始行尾风格保持

---

## 测试与验收标准

### 功能测试

- `apply_patch` 入参仍只要求 `patchText: string`，不需要模型提供新增参数
- 成功和失败结果仍以文本方式返回，不要求调用方消费新的 JSON / object 结果
- 成功文本使用固定模板，包含变更文件列表和可选 `Notes`
- 失败文本使用固定模板，第一行包含稳定错误分类，并包含 `Retryable`、`Repair attempted`、`Failed files`、`Details`、`Hint`
- 代码块包裹的 unified diff 可被正确识别并执行
- 带多余说明文字的 patch 能在保守清洗后仍正确解析
- 输入在 LF 解析视图下可正确识别与定位
- 解析失败时返回稳定文本错误和可读提示
- `prepare` 阶段明确可恢复的 IO 错误可触发一次安全补救重试且只重试一次
- 计划生成后如果执行前目标文件状态明显变化，应失败并提示重新读取 / 重新生成 patch
- 本轮不要求测试 BOM / 原始行尾风格保持

### 边界测试

- 空输入
- legacy patch
- binary patch
- submodule diff
- copy from/to
- 路径越界
- 文件已存在但以 add 方式创建
- move 目标已存在
- 上下文不匹配
- 不要求实现或测试锚点 / 相似度匹配

### 回归测试

- 旧有 `applyPatch.test.ts` 中的失败不落盘语义必须保持
- 既有成功场景不得被容错逻辑破坏
- 工具结果瘦身后 UI artifact 与上下文投影仍然可读，且不要求模型解析内部结构化实体
- 现有 `write` 工具行为不受影响

### 人工体感验收标准

- 相同复杂度的小改动，`apply_patch` 一次成功率明显上升
- 原先经常因为格式噪音失败的 patch，现在能更稳定通过
- 失败后模型不再频繁直接切换到 `write`
- 失败信息能指导下一轮重新生成更合适的 patch
- 审查者能从文本结果中看清改了哪些文件、为什么失败、是否可重试、是否已尝试补救

---

## 代码审查清单

审查者应重点检查以下问题：

- 对外工具协议是否保持不变：入参仍为 `patchText: string`，成功 / 失败仍以文本方式返回
- `PatchApplyPlan`、`PatchValidationIssue`、`ApplyPatchToolFailure` 或等价内部结构是否仅作为 worker 内部结构或兼容性调试信息使用，没有成为模型必须消费的新协议
- 成功 / 失败文本模板是否固定，错误分类是否稳定、有限、语义清晰，是否稳定包含 `Retryable`、`Repair attempted`、`Failed files`、`Details`、`Hint`
- 输入清洗是否只处理格式噪音，没有偷偷修改语义内容，也没有做锚点、相似度或语义修补
- 归一化是否禁止自动补 hunk、猜文件、改写 patch 语义、把自然语言转 patch
- 两阶段流程是否真的做到“先全量验证，再生成计划，再顺序落盘”
- `PatchApplyPlan` 是否作为一次性快照使用；执行前状态变化时是否失败并提示重新生成，而不是边写边修
- 任一失败场景是否都能返回稳定文本错误，且文本由内部结构化错误渲染而来
- `retryable` 判定是否足够保守，是否误把安全类、歧义类、权限类错误当成可重试错误
- 单次补救重试是否只限 `prepare` 阶段明确可恢复的 IO 错误，是否会触发 `apply` 阶段自动重试
- `apply_patch` 是否仍然遵守路径、文件类型、工作区边界限制
- 失败时是否仍然可能出现部分写入而没有明确说明
- API 层的工具描述、结果瘦身、UI artifact 是否与“外部文本协议不变、内部结构化实现”一致
- 现有测试是否覆盖新增行为，是否存在回归空洞
- `write` 是否仍然只是最后退路，而不是默认回退路径
- BOM / 原始行尾风格保持是否被错误地作为本轮阻塞项

---

## 未解决问题与后续阶段

本阶段暂不做、但后续可考虑的内容包括：

- 模糊 / 锚点匹配降级链
- BOM / 原始行尾风格保持增强
- 更细粒度的 patch 代价评估
- 更完整的观测与统计面板
- 更复杂的多格式编辑协议
- 更强的上下文自动补全与重写策略

其中，**模糊 / 锚点匹配** 明确暂缓。原因是它收益高但误改风险更高，应在前三项稳定后再考虑。

其中，**BOM / 原始行尾风格保持** 也明确不属于本轮阻塞项，后续单独评估兼容性、测试成本与实现复杂度。

---

## 结论

本设计文档的目标不是把 `apply_patch` 变成一个“什么都能接受”的宽松编辑器，而是把它变成一个：

- 仍然严格
- 但更可恢复
- 更可诊断
- 更适合模型协作

的高质量局部编辑工具。

如果按本文档实施，预期可以先把最常见的失败模式压下去，并显著减少 `write` 退化。
