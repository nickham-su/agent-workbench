# 测试与验收标准

返回 [README](./README.md)。本文件的矩阵是最终验收的最低验收线；测试名称可随项目风格调整，但行为不得减少。当前实现已补齐下列自动化覆盖，最终验收仍必须以实际测试结果为准。

## 验收原则

- 每一条新增行为必须同时有直接单元测试和至少一条跨运行时边界测试。
- 测试不允许只断言“错误存在”；必须断言失败/取消状态、原错误前缀、候选是否出现及稳定显示顺序。
- 路径测试必须使用临时 workspace 与真实目录/文件；只有难以稳定构造的权限/取消竞态允许使用最小范围 stub。
- 所有直接 `runReadTool` 测试必须显式传入 `workspaceRepoDirNames`（可为 `[]`），以验证该参数是内部必填合同。
- 测试完成后，未命中、非法路径、symlink、安全校验、正常 read 与既有取消行为必须无回归。

## `runReadTool` 单元测试矩阵

`apps/agent-worker/src/runtime/fileTools.test.ts` 已覆盖单/多/零候选、`ENOTDIR`、目录候选、真实执行路径错误码门控、symlink、安全名称、排序与显示上限、部分/全部 probe 异常、TOCTOU、正常根路径读取和取消。表中保留每项最终验收断言；仅受目标平台限制的场景按“适用时必须验证”的要求执行。

| 分类 | fixture / 输入 | 必须断言 |
|---|---|---|
| 单候选 | 根路径缺失，`repo-a/src/a.ts` 存在 | reject；错误以原 `ENOENT` 为前缀；含固定标题和 `- repo-a/src/a.ts`；新增提示不含绝对路径。 |
| 多候选 | `repo-z/src/a.ts`、`repo-a/src/a.ts` 都存在 | reject；两个候选完整出现；按 UTF-8 字节序为 `repo-a` 后 `repo-z`，不依赖 probe 完成顺序。 |
| 零候选 | 根和全部 repo 下都不存在 | reject；保留原 `ENOENT`；不含候选标题。 |
| `ENOTDIR` | workspace 根路径的一段是普通文件，repo 下同一路径有效 | reject；原 `ENOTDIR` 文本为前缀；带候选提示。 |
| 非缺失错误码门控 | 在真实 `runReadTool` root `lstat` 执行路径注入 `EACCES` 错误码，以及仅错误消息含 `ENOENT` 的普通错误 | 仅 `ENOENT` / `ENOTDIR` 错误码可触发 probe；两个错误均原样抛回、不含候选标题且 probe 未触发。 |
| 绝对/越界/非法路径 | 绝对路径、`../outside.txt`、NUL/CR/LF | 仍是既有校验错误；没有候选标题。 |
| 空名称数组 | 显式 `workspaceRepoDirNames: []` | 与现有缺失错误一致；不追加提示。 |
| repo 根 symlink | `repo-a` 本身是指向 workspace 内/外的 symlink | 不提示该 repo；不得跟随 repo 根链接。 |
| 最终候选 symlink | `repo-a/src/a.ts` 本身是 symlink | 不提示该路径。 |
| 中间 symlink 在 workspace 内 | `repo-a/src` 是指向 workspace 内目录的 symlink，最终候选不是 symlink | 可提示该候选；验证 realpath containment 是中间组件唯一安全条件。 |
| 中间 symlink 逃逸 | `repo-a/src` 指向 workspace 外 | 不提示；不得访问/暴露 workspace 外路径。 |
| 恶意 repo 名称 | `..`、`a/b`、绝对、重复、控制字符与合法 `repo-a` 混合 | 仅探测一次合法 `repo-a`；不输出异常名称、不访问 workspace 外。 |
| 目录候选 | repo 下存在同路径目录 | 仍提示目录候选；本次 root read 仍失败。 |
| 大于展示上限 | 至少 12 个 repo 命中 | 只显示 10 条；包含 `- ... and 2 more candidate(s) not shown`；顺序稳定。 |
| 部分 probe 异常 | 一个候选访问/IO/realpath 异常，另一个有效 | 有效候选仍提示；probe 异常不覆盖 root 错误。 |
| 全部 probe 异常 | 所有候选失败或不可访问 | 仅 root 原错误；不抛出 probe 内部错误。 |
| TOCTOU | 候选在 `lstat` 后、`realpath` 前删除 | 不作为匹配提示；本次不转成功、不掩盖 root 错误。 |
| 正常根路径读取 | 根路径本来存在 | 仍成功读取；不派发 repo probe。 |
| 取消前/中探测 | 用可控 lstat 或工作池 fixture 在首个 probe 后 abort signal | 不派发新的 probe；不追加候选提示；最终抛 root 原始错误，而非 probe/abort 错误。 |

无法在目标平台稳定构造 `EACCES` 或 probe 中途 abort 时，可对最小文件系统调用使用可还原 stub；其余路径、安全与 symlink 场景必须使用真实临时目录 fixture。

## Provider、Runner、IPC 与取消测试

| 层级 | 场景 | 必须断言 |
|---|---|---|
| 类型检查 | 四个 API `enqueueRun` 入口、`RuntimeQueuedRun`、`WorkerQueuedRun`、`QueuedRun`、`QueuedRunContext`、`NestedRunContext` | 字段均为必有 `string[]`；缺失字段产生 TypeScript 编译错误。仅 `EnqueuePayload` 可选。 |
| API helper | `getAgentWorkspaceRunContext(ctx, workspaceId)` | 返回 workspace path 和登记、过滤、去重后的 `dirName[]`；不返回绝对 repo path；不存在 workspace 返回 `null`。 |
| Provider | `read` 执行上下文有数组 | `runReadTool` 收到同一数组；Provider 不补默认值或改写错误。 |
| Nested subtask | parent 含多个 repo 名称 | `ctx.processNestedRun` 收到内容相同但非同一引用的数组；`startSubtaskRun` 响应无需 repo 字段。 |
| Runner 正常失败 | 真实 `runReadTool` 在 signal 未取消时返回 repo 路径提示错误 | tool item 为 `failed`；`output.error` 保存原错误与候选提示；`output.text` 为 `tool: read\nstatus: failed\n\n<错误内容>`，包含同一诊断；无 `result`。 |
| Runner 取消 | read probe/工具执行期间 signal abort | `executeTool` / `executeToolSafely` 不更新伪 `failed` tool item；`processRun` 按既有路径完成 run `cancelled`。 |
| Worker server | body 缺少字段 | 202；Runner 收到必有 `[]`。 |
| Worker server | 非数组或非法元素 | 202；归一化为 `[]` / 合法子集；无任意路径透传。 |
| Worker server | 重复且超过 100 个名称 | 202；保留首个、去重并截到 100。 |
| API Worker client | 正常入队 | JSON body 必含 `workspaceRepoDirNames`，且只含 `dirName`、不含 repo 绝对路径。 |
| API 四入口 | compact、普通消息、内部消息、恢复 | 四处都调用唯一 `agent-run-context.ts` helper；类型保证不能遗漏数组。 |
| 版本兼容 | 新 Worker 收旧 API body | 不报 400，归一化为 `[]`，`read` 降级为无提示的原失败。 |

## 手工验收情景

在含两个真实 repo 的 workspace 中：

- 请求读取仅在一个 repo 下存在、但省略 repo 前缀的文件。
- 确认 tool 调用失败，而非返回文件内容。
- 确认错误给出 `repoDirName/原路径`，新增提示不显示绝对路径。
- 用提示的完整相对路径重试 `read`，确认仍经过正常读取校验并在可读时返回内容。
- 制造双 repo 同路径，确认列出两个候选而不是读取其中一个。
- 对任一 repo 都不存在的路径，确认没有误导提示。
- 在候选 probe 期间取消 run，确认 run 为 cancelled，tool item 未被取消竞争写成 failed。

## 建议命令

```bash
npx tsx --test apps/agent-worker/src/runtime/fileTools.test.ts
npx tsx --test apps/agent-worker/src/runtime/runner.tool-output.test.ts
npx tsx --test apps/agent-worker/src/runtime/runner.cancel.test.ts
npx tsx --test apps/agent-worker/src/runtime/tools/providers/builtin.read.test.ts
npx tsx --test apps/api/src/modules/agent/agent-run-context.test.ts
npm run test:integration:worker -w apps/api
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm run typecheck
```

若项目测试组织后续移动，应运行覆盖同一层级与场景的实际文件；不得跳过覆盖类别。

## 最终验收门槛

以下全部成立才能验收：

- [产品合同](./02-product-contract.md) 所有输入输出和 symlink 规则满足。
- `workspaceRepoDirNames` 仅在 Worker server JSON / `EnqueuePayload` 可选；其余规定类型均为必有数组，且类型检查证明四个入口不能遗漏。
- 测试矩阵中的所有适用自动化用例通过，包含 fileTools 取消与 Runner 取消两层。
- `read` 正常成功、目录读取、分页、编码/二进制拒绝、路径安全、最终 symlink 拒绝和既有取消测试无回归。
- 旧 API payload 可被新 Worker 接受；新 API 始终发送字段。
- 所有 API enqueue 入口和 nested subtask 均不遗漏字段，subtask 只继承 parent 数组。
- 候选命中且未取消时仍为 `status: failed`，不产生伪成功 `result`；取消时不产生伪失败结果，run 遵循既有 `cancelled` 状态机。
- 代码审查清单见 [07-implementation-review-release.md](./07-implementation-review-release.md)。
