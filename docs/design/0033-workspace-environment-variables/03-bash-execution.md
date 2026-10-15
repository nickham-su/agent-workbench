# bash 执行接入

## 当前事实与改动范围

当前模型工具 schema 在 API `agent.composition.ts` 中，公开参数为 `command`、`workdir`、`timeout`；Worker `builtin.ts` 执行 bash，`runtime/bash.ts` 用 `spawn("bash", ["-lc", command])` 创建子进程。

当前 bash 已与原生 `git` 工具解耦：bash 不准备或清理项目 Git lease；鉴权 lease 仅属于 `runtime/git.ts` 的原生工具链。本次不恢复旧 bash Git 自动鉴权，也不把 Workspace 环境注入原生 Git 工具。

本次仅增加执行准备时的 Workspace 配置读取与安全环境合并：

- 不新增 `env` 参数，不改变既有参数 schema。
- 不解析、拼接或重写命令；模型临时覆盖依然写在命令中。
- 不限制 Workspace 外 cwd，不改变既有 timeout、取消、进程组或输出限制。
- `runBashCommand` 还用于无 Workspace 身份的工具探测；Workspace 读取只能放工具分支，不能塞到通用 helper。

具体位置见[代码引用 C-BASH](07-code-references.md#c-bashworker-执行与工具定义)。

## 执行顺序

```text
解析既有 command/workdir/timeout，沿用目录校验
  → 检查调用取消状态
  → 内部接口读取 run.workspaceId 的 Workspace 覆盖快照
  → 校验返回结构和保留字段
  → 再次检查调用取消状态
  → 构造子进程环境、执行原命令
```

- 配置读取失败不创建任务进程；bash 全程不创建 Git lease。
- 内部读取使用[内部接口与缓存](02-data-api-and-cache.md#内部只读接口)；每次工具调用请求 API，缓存命中不查库、不重复解密。
- 返回值使用共享[合法Unicode语义校验](02-data-api-and-cache.md#合法-unicode-与字节计量)，不让非法代理项在spawn编码时被替换后执行；TypeBox结构校验不能代替语义校验。
- 内部 RPC 失败、超时、非法响应、404、删除中或解密失败必须终止本次调用，不设置空覆盖、不使用 Worker 上次值。
- 配置响应取得后，本次按该快照执行；不因后续修改二次读取。不同调用快照不互相共享可变对象。
- 用户显式指定外部 cwd，仍获取 `run.workspaceId` 对应配置。不按 cwd 改变配置身份，也不将原生 Git 的目录约束引入 bash。

## 环境构建

### 普通值与保留字段

```text
filtered Worker process.env 副本
  → Workspace 已启用覆盖
  → 最终 AWB_* 过滤
```

- `filtered` 仅删除精确 `AWB_` 前缀，不修改 Worker 全局对象。
- Workspace 覆盖只包含校验后的字符串，空串不能忽略；大小写独立，不做代理同步。
- 共享[保留集合](01-requirements-and-decisions.md#awb-与-git-保留字段r-control)仍禁止 Workspace 配置系统 Git 托管字段；bash 不新增 Git 自动层，继承的普通系统 Git 环境按现状保留。终端既有 Git 注入与原生 Git 工具的 lease 链不受本节改动影响。
- 环境对象使用 own-property 安全构造；缓存对象不得被 `Object.assign`、删除键或执行期间修改。
- 系统 `process.env` 中不可用的 undefined 项按现有 Node 子进程规则处理；不能用 `if (value)` 丢弃空串。

`PATH`、`HOME`、`BASH_ENV`、`NODE_OPTIONS` 等普通变量可改变目标程序行为，这是用户授权配置能力；它们不进入 Worker 自身环境。不能据此声称提供沙箱或限制模型命令能力。

### 模型命令的覆盖

原命令直接交给 bash。命令内的 `FOO=x command`、`export`、`unset`、`env`、脚本及 profile/rc 的影响由 shell 决定，不新增工具参数或命令识别。

Workspace 的 `$PATH` 或 `$(...)` 值由环境对象注入，是字面值；命令随后显式解释该值是另一层用户执行行为，不属于配置工具自动展开。

### 系统网络边界

API network 配置目前不自动进入普通 bash，本次保持不变。终端系统网络层不复制到 bash；原生 Git 的鉴权与网络行为也不因配置工具扩范围。

### 工具探测

在通用 `runBashCommand` 的最终子进程环境中过滤 `AWB_*` 会同时作用于 Worker `bashTools` 探测，这是必要的控制环境隔离。

探测仍不读取 Workspace 配置，仍使用现有全局缓存和刷新策略。Workspace 改 PATH 后提示中工具可用性不保证同步变化；真实命令仍按本次环境执行。不为本功能重构探测系统。

## Git 边界、取消与错误

### 原生 Git 与 bash 边界

- `builtin.ts` 的 `git` 分支仍调用独立 `executeGitTool`；本次不修改 `runtime/git.ts` 或其 lease 准备／finally 清理。
- bash 中用户自行执行 `git`、嵌套 shell、函数、脚本或 `env git`，仍是普通 shell 命令；不解析命令、不申请项目凭据。
- Workspace 普通环境只注入 bash 及新终端，不注入原生 Git 工具。bash 可以继承系统已有 credential helper；这不是项目 Git 自动鉴权。

### 取消

- 读取开始前已取消：不发新读取／spawn。
- 读取中取消：遵守 apiClient 的 AbortSignal，不在 RPC 有界重试后偷偷执行。
- RPC 返回至 spawn 间取消：再次按现有执行入口检查，不创建任务进程。
- 运行后取消：沿用现有 bash 进程组清理，不改变为杀 Worker 或 API。

### 故障输出

- 环境读取错误只描述固定类别和非敏感 Workspace 身份，不附原 response body。
- 环境过大 E2BIG、spawn 失败等日志不能串行化 `env`、`extraEnv` 或原始 spawn 参数。原命令自身可能包含用户写入的秘密，新增诊断不能额外打印命令。
- 不把配置内容放入工具提示或错误结果；bash 实际输出可能包含用户主动读取的环境，现有输出／artifact 行为不提供全面脱敏保证。
- 不因失败改成不带 Workspace env 执行。不存在配置是正常空覆盖，读取失败不是。

## 开发与审查检查点

- 工具 schema 保持原样，新增读取方法使用共享响应 schema。
- 单次 Worker 调用的 Workspace 身份来自 `ctx.run.workspaceId`，没有 cwd 推断。
- 普通变量优先级、空串、大小写、特殊对象键均有真实环境 map 单测。
- 读失败先于 spawn；bash 不调用任何 Git lease API，原生 Git 既有 lease 回归仍通过。
- Worker `process.env`、API `process.env` 和缓存对象在调用前后不变。
- 两个 Workspace 并发调用、外部 cwd 和工具探测有回归测试。
- 具体动作及判定见[自动测试 A-BASH](05-acceptance-and-review.md#a-bashworker-环境与执行)；仅 helper mock 通过不能代表终端运行时验收。
