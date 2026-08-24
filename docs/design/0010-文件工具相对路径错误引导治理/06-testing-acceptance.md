# 测试方案与验收标准

返回 [README](./README.md)。本文件定义实现完成的可验证条件。首期验收以列出的高频、显式错误为边界，不以“全局扫描零绝对路径”为目标。

## 验收原则

每个纳入范围的失败场景必须同时验证：

- 失败语义和错误分类未改变；
- 错误中包含语义正确的相对路径；
- 错误中不包含当前测试 workspace 的绝对路径；
- 错误不引导模型使用 `<workspace>/...`、`[workspace]/...` 等不可直接调用的伪路径；
- 若存在 repo hint、failedFiles、Details 等二次格式化区域，所有区域均满足相同要求；
- 文件系统没有产生非预期副作用。

首期不要求构造所有平台级 I/O 错误，也不要求对明确排除的原始 `throw err` 做“无绝对路径”断言。

## read 测试矩阵

| 场景 | 预期状态 | 必须断言 |
|---|---|---|
| 根文件 `ENOENT`，无 repo 候选 | rejected / failed | 固定 `ENOENT` 模板含 `safePath`；不含 `workspacePath`；无 hint |
| 根文件 `ENOENT`，一个候选 | rejected / failed | 规范化前缀 + 固定 hint + 相对候选；不含 `workspacePath` |
| 根文件 `ENOENT`，多个候选 | rejected / failed | 排序、上限不变；前缀和候选均相对 |
| 根路径 `ENOTDIR`，有候选 | rejected / failed | 固定 `ENOTDIR` 模板含 `safePath`；候选保留；不含绝对路径 |
| repo probe 零候选 | rejected / failed | 仅规范化根错误，不回退原始 rootError |
| repo probe 时 signal abort | 既有取消/根错误语义 | 不追加候选；若工具错误可见则使用规范化根错误 |
| 根 `EACCES` / 自定义非缺失错误 | rejected / failed | 对象/消息继续原样；不触发 probe；本测试不强求去绝对路径 |
| 绝对路径输入 | rejected / failed | `absolute path is not allowed`；无 fs 根读取 |
| 正常文件、目录读取 | completed | 输出完全回归，无行为变化 |

### read 关键断言示例

```ts
assert.match(error.message, /^ENOENT: no such file or directory, path: src\/a\.ts/);
assert.equal(error.message.includes(workspacePath), false);
assert.match(error.message, /- repo-a\/src\/a\.ts$/);
```

首期不要求建立特殊字符路径专项。使用普通、合法的相对路径 fixture，验证规范化错误不额外添加引号、不新增分隔符转义逻辑，并且错误中的路径片段与输入 `safePath` 原字符串一致。

## apply_patch 测试矩阵

### prepare 阶段

| 场景 | 展示路径 | 附加验收 |
|---|---|---|
| add 目标已存在 | add `path` | 文件未覆盖 |
| delete 源缺失 | delete `path` | 无其他文件写入 |
| delete 非空文件无 hunk | delete `path` | 文件保留 |
| move source 缺失 | `fromPath` | 目标未创建 |
| move target 已存在 | `toPath` | 源、目标内容不变 |
| update 源缺失 | update `path` | 无其他文件写入 |
| rename+modify 目标存在 | `movePath` | 源、目标不变 |
| update context mismatch | 源 `relativePath` | `Failed files` 与 `Details` 均相对 |
| delete hunk context mismatch | delete `relativePath` | 分类仍为 `CONTEXT_MISMATCH` |

### 主问题直接修复：文件类型错误

| 场景 | 展示路径 | 附加验收 |
|---|---|---|
| 目标为目录 | 目标相对路径 | `Path is a directory` |
| 目标为 symlink | 目标相对路径 | 分类仍为 `PATH_OUT_OF_SCOPE` |

以上场景验证当前最终目标、源、目标或 snapshot 的显式绝对路径错误被直接改为已有相对字段。

### 工具内补强覆盖：父组件错误

| 场景 | 展示路径 | 附加验收 |
|---|---|---|
| 中间父组件为 symlink | 中间组件相对路径 | 无 workspace 外副作用 |
| 中间父组件为普通文件 | 中间组件相对路径 | `Path is not a directory` |
| realpath 逃逸 | 可不展示路径 | `path is outside workspace` 保持 |

本组是首期必须通过的补强覆盖，但验收记录必须标记为“父组件遍历补强”，不得宣称它只是某个既有最终 `fullPath` 文案的机械替换。

### prepare/apply 快照漂移

至少覆盖：

- present 文件内容变化；
- present 文件消失；
- absent 目标被创建；
- 多文件 patch 任一文件漂移。

每个错误必须：

- 含 `Failed file: <snapshot.path>`；
- 不含 `Path:` 绝对行；
- 不含 `workspacePath`；
- 分类仍为 `CONFLICT`；
- apply 前验证失败时，不写入其他 operation。

### apply 阶段已分类写错误

可通过依赖注入、受控文件系统状态或现有测试机制覆盖：

| 错误 | 预期路径 |
|---|---|
| add `EEXIST` | `operation.path` |
| add/update/move `ENOENT` | `operation.path` |
| add/update/move `EBUSY` 等 retryable code | `operation.path` |
| move source verify 失败 | `operation.fromPath` |
| delete source verify 失败 | `operation.path` |
| writable target 为目录/symlink | `operation.path` |

如果当前测试架构无法稳定注入平台 I/O 错误，至少必须直接测试对应私有可测入口或重构后的纯错误 helper；不得仅靠代码审查覆盖所有已分类文案。

### apply_patch 格式化结果

formatter / classifier 不负责路径重写。测试必须先构造已经使用相对路径的源错误，再验证 `formatApplyPatchFailureTextFromMessage`：

- `Failed files` 为 `src/a.ts`，不是 `/tmp/workspace/src/a.ts`；
- `Details` 中同样只出现相对路径；
- failure code、retryable、hint 不变；
- snapshot mismatch 不复制绝对 `Path:` 行。

不得新增“向 formatter 传入绝对路径，然后期待其输出相对路径”的测试；该行为不属于产品合同，并会掩盖源错误生成点未修复的问题。

## write 回归矩阵

| 场景 | 必须断言 |
|---|---|
| 写入新文件 | 成功，父目录按既有行为创建，输出使用 `safePath` |
| 覆盖已有文件 | 成功，before/after 语义不变，输出使用 `safePath` |
| 绝对路径输入 | 在写入前拒绝，错误为 `absolute path is not allowed` |
| 越界路径 | 保持 `path is outside workspace` |
| symlink 目标 | 保持既有拒绝 |

不要求注入低频 `writeFile` 原始错误并断言路径归一化。首期若生产代码新增 `runWriteTool` catch、错误码映射、错误重写或包装 helper，应判定为超范围实现，除非设计文档已同步变更并获得批准。

## Runner 模型可见输出回归

read repo hint 的 Runner 测试必须验证最终持久化结果：

```text
output.error
output.text
```

二者均不得包含 `workspacePath`，且包含可重试相对路径。状态仍为 `failed`，不得出现 `result`。

`runner.ts` 不应新增测试专用分支或生产改写逻辑。

## 静态审查验收

### 必须通过

- `buildSnapshotMismatchMessage` 不再接收或输出 `fullPath`；
- `deriveNewContentFromChunks` 的 production 调用不再传执行绝对路径作为错误标签；
- `applyPatch.ts` 主问题直接修复的错误不插入 `fullPath` / `fromFullPath` / `toFullPath`；
- 父组件补强错误不插入 `currentPath`，而是展示相对组件路径；
- formatter / classifier 没有新增路径重写，且纳入范围源错误在进入该层前已相对化；
- `read` 缺失分支不再抛原始 `rootError`；
- Runner 无路径改写逻辑；
- write 生产逻辑没有新增 catch、错误重写或包装 helper。

### 允许存在

- 数据结构中的 `fullPath` / `fromFullPath`；
- `fs.*`、containment、缓存 key 使用绝对路径；
- 首期排除分支中的 `throw err`；
- 测试搭建临时 workspace 的绝对路径变量，只要断言其不进入纳入范围的错误。

## 建议测试命令

以项目当前 package scripts 为准。实施者应先核对 `package.json`，建议至少执行等价命令：

```bash
cd agent-workbench
npm test -- apps/agent-worker/src/runtime/fileTools.test.ts
npm test -- apps/agent-worker/src/runtime/applyPatch.test.ts
npm test -- apps/agent-worker/src/runtime/runner.tool-output.test.ts
npm run typecheck
```

若仓库使用 workspace 定向脚本，应使用项目既有命令替代；验收报告必须记录实际执行的命令和结果，不得声称运行未实际执行的命令。

## 手工验收情景

### read

- 在多 repo workspace 中调用不存在于根、但存在于登记 repo 的相对路径；
- 确认错误前缀使用原输入相对路径；
- 确认模型可直接复制候选再次调用；
- 确认错误中不出现 workspace 绝对目录。

### apply_patch

- 对已存在 add 目标提交 patch；
- 对内容不匹配的 update 提交 patch；
- prepare 后改变目标再 apply；
- 确认最终 failure text 的 `Failed files`、`Details`、`Failed file` 只出现相对路径。

## 首期验收门槛

以下条件全部满足才可验收：

- read 矩阵中纳入范围的场景全部通过；
- apply_patch 主问题直接修复的显式错误类别已有自动测试或可测试纯 helper 覆盖；
- apply_patch 父组件工具内补强场景已有独立测试，并在验收记录中单独标识；
- workspace 绝对路径反向断言覆盖工具源错误和至少一个 Runner 最终输出；
- write 回归矩阵通过；
- 相关测试与类型检查通过；
- 代码审查确认没有 Runner 层路径处理；
- 已知低频未覆盖项在变更说明中按本文边界列出，不能被误报为“绝对路径已完全清除”。
