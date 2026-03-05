# Bash 工具描述优化与 workdir 预检查

## 背景

- 近期观察到模型调用 `bash` 工具时经常失败,失败主要集中在参数形状与 `workdir` 误用.
- 当前 `bash` 工具的描述较短,未明确关键约束,模型容易套用其他框架的 shell/exec 工具习惯.
- 典型失败样例:
  - `command` 被传成 argv 数组(例如 `["bash","-lc", "pwd && ls -la"]`),触发类型校验错误.
  - `workdir` 被写成经验路径(例如 `/workspace`),在实际 workspace 路径不同的情况下导致 `spawn bash ENOENT`.

## 目标

- 降低 `bash` 工具调用失败率,让模型更稳定地产出可执行的 tool args.
- 对 `workdir` 相关错误提供更可诊断的错误信息,避免 `spawn bash ENOENT` 的歧义.
- 不在工具描述中嵌入 workspace 的绝对路径,避免模型将其误用到 `read/write` 的 `filePath` 等参数里.

## 非目标

- 不引入 `command: string[]` 的正式能力(仅通过描述纠偏,不改变能力边界).
- 不修改权限模型,不扩展 bash 的安全边界策略.
- 不改变 `bash` 的执行方式(仍为 `bash -lc <command>`),不引入新的 shell.

## 现状梳理

### 工具定义下发(API)

- `bash` 的描述与 input schema 由 API 在 prompt context 中下发.
  - 描述: `agent-workbench/apps/api/src/modules/agent/agent.service.ts:272`
  - schema: `agent-workbench/apps/api/src/modules/agent/agent.service.ts:81`

### worker 侧工具描述追加(探测附录)

- agent-worker 在构建 tools 时,会对 `bash` 的描述追加一段 probe appendix.
  - 追加位置: `agent-workbench/apps/agent-worker/src/runtime/runner.ts:1536`
  - 附录来源: `agent-workbench/apps/agent-worker/src/runtime/bashTools.ts:121`
  - 内容包括:
    - 运行环境信息(platform/arch/kernel/distro).
    - 已知可用工具列表(例如 git,node,npm,rg 等的 `--version` 首行).

### `workdir` 与执行逻辑

- `bash` 实际执行为 `spawn("bash", ["-lc", command], { cwd })`.
  - 实现: `agent-workbench/apps/agent-worker/src/runtime/bash.ts:21`
- `workdir` 的解析规则:
  - 不传 `workdir`: 使用 workspace 根目录.
  - 传相对路径: `path.resolve(workspacePath, workdir)`.
  - 传绝对路径: 直接作为 `cwd` 使用.
  - 逻辑位置: `agent-workbench/apps/agent-worker/src/runtime/runner.ts:1006`

## 问题分析

### 参数形状误用

- 当前 worker 侧对 `bash.command` 的运行时校验是 "必须为非空字符串".
  - 报错来源: `agent-workbench/apps/agent-worker/src/runtime/runner.ts:691`
- 模型若按其他工具习惯传 argv 数组,会直接失败,且错误对模型缺少纠偏信息.

### `spawn bash ENOENT` 的歧义

- Node.js `spawn` 报 `ENOENT` 时,常见含义至少包括:
  - 找不到可执行文件 `bash`(PATH 不含 bash).
  - `cwd` 路径不存在或不可用.
- 当前错误路径会把 `err.message` 原样暴露给用户与模型,可诊断性较差.

## 方案

### `bash` 工具描述优化

在 `toolDescription("bash")` 中补齐关键约束与建议,重点强调:

- `command` 必须是字符串.
  - 不支持 argv 数组.
  - `command` 直接写要执行的命令,不要在 `command` 里再写 `bash -lc ...`.
- `workdir` 可选且强烈建议不填.
  - 默认就是工作区根目录.
  - 如需指定,尽量使用相对路径(相对工作区),避免写类似 `/workspace` 的绝对路径.
- `timeout` 单位为毫秒,建议只传整数.

描述中增加少量示例(不包含 workspace 绝对路径),用于纠偏模型输出形态.

### `cwd/workdir` 预检查与错误信息

在执行 `runBashCommand()` 前,对最终 `cwd` 做预检查,并将常见歧义错误改写为可诊断的错误信息:

- 检查触发条件:
  - 每次执行 `bash` 都会对最终 `cwd` 执行一次 `fs.stat`.
  - 若用户显式传入 `workdir`,则错误消息使用 `bash.workdir.*` 前缀.
  - 若未传 `workdir`,则错误消息使用 `bash.cwd.*` 前缀,并使用固定 label `workspace root`(避免输出绝对路径).
- 检查逻辑:
  - 计算最终 `cwd` 后,对 `cwd` 执行 `fs.stat`.
  - 若 `stat` 报 `ENOENT`,抛出更明确的错误:
    - `bash.workdir not found: <workdir>` 或 `bash.cwd not found: workspace root`
  - 若存在但不是目录,或 `stat` 报 `ENOTDIR`,抛出:
    - `bash.workdir must be a directory: <workdir>` 或 `bash.cwd must be a directory: workspace root`
- 错误消息原则:
  - 仅使用用户传入的 `workdir` 文本(经 trim 后)或固定 label,不输出 resolve 后的绝对路径,避免泄露 workspace_root.
  - 仍保持 tool item 的失败语义不变(失败时 status=failed,并将 error 文本写入 output.text).

可选增强(非必需):

- 当 `spawn` 仍返回 `ENOENT` 且 `workdir` 预检查已通过时,可将错误文本改写为更直观的提示,例如:
  - `bash is not available in this environment (spawn bash ENOENT)`
  - 该增强不影响本方案核心收益.

## 兼容性与风险

- 不嵌入 workspace 绝对路径:
  - 避免模型将绝对路径误用于 `read/write` 的 `filePath`(这些工具通常只允许相对路径).
- `cwd` 预检查会引入一次 `fs.stat` 的轻量 IO 开销:
  - 作为交换,能显著减少 `/workspace` 这类误用带来的歧义,并覆盖默认 workspace 根目录缺失的极端边界.
- 不支持 `command: string[]` 不会造成能力缺失:
  - 当前 `bash` 工具的能力由 `bash -lc` 的脚本字符串提供,字符串形态是表达力更强的超集.

## 验证与测试建议

- 单测(建议放在 agent-worker runtime 侧):
  - 在 `agent-workbench/apps/agent-worker/src/runtime/runner.tool-output.test.ts` 附近新增用例,构造一个 `bash` tool 调用.
  - 传入不存在的 `workdir`,断言 tool item 最终 status=failed 且 `output.text` 包含 `bash.workdir not found`.
- 回归检查:
  - `workdir` 未传时行为不变.
  - `workdir` 传相对路径且存在时,命令可正常执行.
