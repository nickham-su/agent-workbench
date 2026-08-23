# 开发实施、代码审查、发布与回滚

返回 [README](./README.md)。本文件把设计转为按依赖顺序的小步任务和合并门槛；本文不要求或授权任何 Git 写操作。

## 任务拆分

| 阶段 | 主要文件/符号 | 产出 | 完成判定 |
|---|---|---|---|
| 测试基线更新 | `fileTools.test.ts`、`runner.tool-output.test.ts` | read 新合同的失败测试 | 测试先能证明当前绝对路径行为不符合合同 |
| read 工具内修复 | `fileTools.ts` | 缺失根错误规范化 + repo hint 拼接 | read 与 Runner 回归通过 |
| apply_patch 展示路径参数化 | `applyPatch.ts` 私有 helper | execution/display path 分离 | helper 错误只用相对路径 |
| prepare 显式错误修复 | `prepareApplyPatchTool`、`applyPatchUpdate.ts` 调用 | add/delete/update/move/context 错误相对化 | prepare 测试矩阵通过 |
| snapshot/apply 显式错误修复 | snapshot validation、`applyPreparedPatch` | drift 与已分类写错误相对化 | 原子性与分类回归通过 |
| write 回归 | `fileTools.test.ts` | 明确首期不改生产代码 | 成功、非法输入、symlink 回归通过 |
| 全量审查与验收 | 相关测试、typecheck、静态搜索 | 可发布变更 | 满足 `06-testing-acceptance.md` |

## 详细实施步骤

### 建立 read 失败测试

- 修改“read 根路径缺失且有 repo 候选”测试：
  - 将 `includes(workspacePath) === true` 翻转为 `false`；
  - 精确断言规范化 `ENOENT` 前缀；
  - 保留候选标题与相对候选断言。
- 修改零候选测试：不再要求原始错误，而要求规范化根错误。
- 修改 `ENOTDIR` 测试：断言固定模板和相对路径。
- 不建立特殊字符路径专项；使用普通合法相对路径断言错误不额外添加引号、不新增分隔符转义逻辑，且路径片段与输入 `safePath` 原字符串一致。
- 修改 Runner read 输出测试：`output.error`、`output.text` 都不含 workspacePath。

验证：只运行上述测试时，在生产代码未改前应按预期失败，证明测试命中问题而非无效断言。

### 实现 read 私有 helper

- 在 `fileTools.ts` 路径 helper 邻近位置新增根缺失错误 builder；
- helper 仅处理 `ENOENT`、`ENOTDIR`；
- 新 Error 可复制 `code`，不复制原始 `message`；
- `runReadToolInternal` catch 中先规范化缺失错误，再执行既有 probe；
- abort / 零候选分支抛规范化错误；
- 有候选分支把规范化错误传给 `appendRepoPathHint`；
- 不动 probe 算法、排序、上限和 symlink 规则。

验证：read fileTools 测试和 Runner read 输出测试通过，非缺失错误测试仍确认原样上抛。

### 建立 apply_patch 路径测试基线

按错误族补充或强化测试：

- formatter fixture 从绝对路径改为相对路径；
- context mismatch 同时断言源 error 和 formatted text；
- 主问题直接修复：add 已存在、move target 已存在、delete/update 缺失、最终目标目录/symlink 断言相对路径；
- snapshot drift 断言无 `Path:` 和无 workspacePath；
- 工具内补强：父组件 symlink / non-directory 独立断言失败组件相对路径，并在测试名中标明父组件遍历；
- 多文件失败继续断言无写入副作用。

formatter / classifier 测试必须从已相对化的源错误开始；不得将其实现为绝对路径清洗层。

不要一次加入无法稳定触发的所有 OS 错误；已分类 catch 可先通过小型纯 helper 测试覆盖。

### 重构 apply_patch 私有 helper 参数

按最小、可编译增量修改：

- `buildSnapshotMismatchMessage` 删除 `fullPath` 参数；
- `readCurrentFileStateForValidation` 增加 `displayPath`；
- `readVirtualFileState` 直接使用已有 `relativePath`；
- `verifyExistingRegularFile` 改对象参数并增加 `displayPath`；
- `ensureWritableParent` 增加 `displayPath`；
- `ensureParentDirectorySafe` 为中间组件生成相对 display path；该项作为工具内补强覆盖单独提交或单独验证。

每修改一个 helper，同步修改所有调用点并运行类型检查；不得用可选 `displayPath?: string` 或 `?? fullPath` 暂时兼容，因为这会保留错误回退路径。

### 修复 prepare 阶段显式错误

- add 使用 `relativePath`；
- delete 使用 `relativePath`；
- move-only 源使用 `fromPath`、目标使用 `toPath`；
- update 使用 `relativePath`；
- rename+modify 目标使用 `movePath`；
- `deriveNewContentFromChunks` 的错误标签使用源相对路径。

完成后运行静态搜索，确认本文列明的主动错误不再插入局部 absolute 变量。

### 修复 snapshot 和 apply 阶段错误

- snapshot 的目录/symlink 与 mismatch 使用 `snapshot.path`；
- add/update/move writable target 使用 `operation.path`；
- move source verify 使用 `operation.fromPath`；
- delete source verify 使用 `operation.path`；
- catch 中已识别的 `EEXIST`、`ENOENT`、retryable code 文案使用 `operation.path`；
- 未识别错误继续 `throw err`，不扩展首期范围；
- 保持 apply 前全量 snapshot validation 和多文件无部分写入语义。

### 更新分类与格式化测试

- `formatApplyPatchFailureTextFromMessage` fixture 使用 `a.txt` 或 `src/a.txt`；
- fixture 对应的源错误在进入 formatter 前已经相对化；
- 断言 `Failed files` 与 `Details` 都为相对路径；
- 分类 code、retryable、hint 保持；
- 不在 formatter / classifier 中引入 workspacePath 参数、`path.relative` 或 replace 逻辑。

### write 回归和范围确认

- 不修改 `runWriteTool` 生产逻辑；
- 不新增 `runWriteTool` catch、错误码映射、错误重写或包装 helper；发现此类改动直接判为超范围，除非设计已同步变更并批准；
- 增加或确认成功输出使用 `safePath`；
- 确认绝对、越界、symlink 输入行为；
- 变更说明明确：write 低频底层 I/O 错误不在首期治理范围。

### 最终验证

- 运行 `fileTools.test.ts`；
- 运行 `applyPatch.test.ts`；
- 运行 `runner.tool-output.test.ts`；
- 运行 Worker / 仓库既有 typecheck；
- 用 `rg` 审查显式错误插值；
- 完成手工 read 和 apply_patch 场景；
- 记录实际命令、结果和未覆盖低频边界。

## 代码审查清单

### 范围与分层

- 所有生产改动位于文件工具实现及其私有 helper；
- `runner.ts` 没有路径替换、workspace 前缀清洗或 toolName 特判；
- 没有新增公共协议、tool schema、数据库字段或共享 sanitizer；
- write 没有被顺手扩展为全面 fs 错误包装。

### read

- 仍先执行相对路径和 workspace 校验；
- repo probe 仍只由根错误对象的 `ENOENT` / `ENOTDIR` 触发；
- 缺失错误不再抛原始 `rootError`；
- 固定模板只使用 `safePath`，不额外添加引号或分隔符转义；测试路径片段与输入原字符串一致；
- 有/无候选均不含 workspacePath；
- 非缺失错误和取消语义不变；
- 候选排序、上限、symlink 和失败状态不变。

### apply_patch

- `buildSnapshotMismatchMessage` 无 `fullPath` 参数和 `Path:` 行；
- private helper 明确区分 execution path 与 display path；
- 不存在 `displayPath ?? fullPath` 或失败时回退 absolute 的逻辑；
- formatter / classifier 不负责路径重写，源错误在进入该层前已经相对化；
- `readVirtualFileState` 使用 `relativePath` 展示；
- 主问题直接修复和父组件工具内补强在代码、测试及验收记录中分层标识；
- 父组件 symlink/非目录补强错误显示相对组件；
- prepare 的 add/delete/update/move/rename 错误使用正确源或目标相对路径；
- context mismatch 使用源相对路径；
- apply 的 target 错误使用 `operation.path`，source 错误使用 `fromPath`；
- `failedFiles`、`Details` 不经二次清洗即可相对化；
- `fullPath` 仍用于 I/O、realpath、containment、缓存 key，不被错误地替换成相对路径执行。

### 行为与安全回归

- 绝对输入仍拒绝；
- `..` 逃逸和 symlink 约束未放宽；
- read 不自动读取候选；
- apply_patch 不自动修复、重试或覆盖冲突目标；
- snapshot drift 仍在写入前阻断所有 operation；
- 多文件 patch 不产生部分写入；
- completed/failed/cancelled 状态不变。

### 测试质量

- 测试不仅断言“不含 workspacePath”，还断言正确相对路径；
- 至少一个 Runner 最终输出测试覆盖模型可见文本；
- apply_patch 主问题显式错误族有自动覆盖；
- apply_patch 父组件补强场景有独立自动覆盖；
- write 回归符合“不改生产逻辑”的决策；
- 测试没有把 `<workspace>/...` 视为可接受结果；
- 验收报告不声称“所有绝对路径已清除”。

## 发布建议

该变更：

- 无数据库迁移；
- 无 API / Worker 协议变化；
- 无 tool schema 变化；
- 只改变失败错误文本中的路径表示；
- 不需要 feature flag。

可随 Agent Worker 常规版本发布。发布说明应表述为“文件工具错误改为给出可重试相对路径”，不要表述为通用安全脱敏或完全消除绝对路径。

## 观测建议

首期无需新增持久化指标。发布后可通过以下信号评估收益：

- 工具返回路径错误后，下一轮 `absolute path is not allowed` 的相邻失败是否下降；
- read repo hint 后模型是否更常使用候选相对路径；
- apply_patch context/conflict 后模型是否重读相对目标而非复制 workspace 绝对路径。

如现有日志含用户路径，不为本需求新增高基数路径日志。

## 回滚方案

变更无数据迁移，可按普通代码回滚：

- 回滚 read error builder 后恢复 Node 原始错误；
- 回滚 apply_patch display path 参数后恢复原错误文本；
- 不需要数据修复或文件内容回滚。

若仅某一工具出现兼容问题，应优先单独回滚该工具的文案改动，不应通过在 Runner 增加临时替换层绕过问题。
