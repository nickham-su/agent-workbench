# 需求与产品方案

## 背景与现状

当前项目存在不同的 Git 执行入口：

| 入口 | 当前目标和认证来源 | 本次处理 |
|---|---|---|
| 界面 Git API | 已登记 Workspace 仓库；`repo.credentialId` 与通用 Git 网络环境 | 保留 |
| 交互式终端 | Workspace 终端；`terminalCredentialId` 与终端网络设置 | 保留 |
| 模型 Bash | 命令文本启发式识别；命中后从 `terminalCredentialId` 准备凭证租约 | 移除识别和项目认证 |
| 模型 Git 专用工具 | 当前尚无该内置工具 | 新增 |

现有 Bash tokenizer 主要按空白分词，不能完整解析 Shell 运算符、嵌套 Shell、脚本和 alias。合法命令可能漏过认证准备。继续修补只能增加覆盖率，不能可靠预测任意命令的执行行为。

用户已经多次修复 Bash Git 注入，当前目标是退出这条维护路线：提供原生 Git 参数入口，认证准备不再依赖命令识别。当前事实见[代码地图](code-map.md)。

## 用户目标

- 模型按直觉使用本机 Git 的参数，功能不受业务 `action` 枚举限制。
- 不需要猜测 Workspace 路径、仓库 URL、凭证文件或认证环境变量。
- 模型在调用工具时看到最新的有效仓库名。
- 开发者可以正常完成查阅、暂存、提交、推送及本机 Git 支持的其他已授权操作。
- 错误区分“工具尚未启动 Git”和“Git 已启动但退出非零”。
- Bash 退场一次完成，不再因为命令写法差异注入或漏注入凭证。

## RULE-INPUT

工具名称为 `git`，输入对象仅允许以下字段：

| 字段 | 必填 | 规则 |
|---|---|---|
| `repo` | 是 | 字符串，精确匹配当前 Workspace 的安全登记 `dirName`；不做 trim、大小写转换或模糊匹配 |
| `args` | 是 | 非空字符串数组；每个元素可以是合法空字符串，但不得包含 NUL；顺序、空白、换行、引号均原样保留 |
| `timeout` | 否 | 正整数秒，默认 `120`，范围 `1..3600`；超出范围明确报错，不静默钳制 |

- 拒绝未知字段，包括 `workspaceId`、`cwd`、`workdir`、`env`、`credentialId`、`command`、`action`。
- `repo` 不允许空字符串、首尾空白、`.`、`..`、斜杠、反斜杠、NUL、CR/LF 或绝对路径。对应安全名称规则见 [RULE-REPOS](decisions.md#rule-repos)。
- `args` 不包含可执行程序名；工具不会删除误填的 `git`。例如 `["git","status"]` 会交由本机 Git 返回相应原生错误，而不是被悄悄修正。
- 不进行 Shell 分词、环境变量展开、通配符展开或命令链拆分；`["status","&&","pwd"]` 中的 `&&` 是一个普通参数。
- 不设置 Git 子命令白名单，不重新引入危险命令或危险参数分类器。
- `timeout` 产品上限固定为一小时，换算结果最多 `3600000ms`；Node 的 `2147483647ms` 上限仅作底层溢出防御，不开放为产品允许时长。Bash 既有 timeout 行为不借机改动。
- 模型参数不是秘密传递通道，不应放入 token、密码、私钥或带秘密的 URL；认证由系统准备。历史工具调用保存模型输入是现有会话协议，不得声称所有 argv 都不持久化；日志和结果不得额外复制完整 argv。

### 输入示例

```json
{"repo":"agent-workbench","args":["status","--short"]}
```

```json
{"repo":"agent-workbench","args":["commit","-m","fix: correct credential handling"]}
```

```json
{"repo":"agent-workbench","args":["push","-u","origin","HEAD"],"timeout":120}
```

这些是参数形态示例，不构成对当前运行的提交或推送授权。

## RULE-DESCRIPTION

### 动态描述

基础描述静态保存，仓库名在每轮构建模型工具定义时追加；不得修改并污染静态缓存对象。

```text
在当前 Workspace 登记的仓库上下文中执行本机 Git。
执行目录和项目认证由系统准备，args 原样交给 Git。

当前有效 repo：
- agent-workbench
- shared-utils-2

repo 必须精确使用上述名称，不接受仓库 URL、路径或 ID。
args 是 git 后面的字符串参数数组，不包含 git，不支持 Shell 命令链。
timeout 单位为秒，默认 120，范围 1..3600；超时/取消不代表 Git 副作用回滚。
正常退出也会收尾同组后代；普通 POSIX 数值组监督不是强身份，不能把后台后代视为已空闲。
本工具以 Linux/POSIX 停止确认能力为发布基线；其他平台无经验证等价能力时明确拒绝调用。
只有已确认停止的常规残留才可按 TTL 回收，最长 65 分钟到期；
正常服务运行且清扫成功时最多再等待 5 分钟。停止未确认或 prepare/release 故障
可能需要维护，不能承诺 TTL 一定解锁。僵尸或未知组状态保守持有。
坏元数据/范围信息不齐须在已验证受管环境全停或重启后服务未启动窗口恢复；证据不足保持持有。
工具不是沙箱；写操作和高影响操作仍需已有授权。
需要项目 Git 认证时使用本工具，Bash 不再自动注入项目凭证。
```

- 描述内容进入每轮模型请求的工具定义，不另外追加一份不断累积的聊天消息。
- 每轮数据来自最新登记记录，不扫描 Workspace 磁盘、不使用入队快照、不把仓库 URL 或内部 ID 展示给模型。
- 首版 schema 的 `repo` 为 string；不依赖动态 enum。执行端成员校验不因描述变化而省略。
- 没有安全登记仓库时，描述明确写“当前无可用仓库”；已启用的 `git` 工具仍展示，以保持工具启用和空仓库状态可解释。任何调用返回 `REPO_NOT_AVAILABLE` 和空的可选列表，不分配租约、不启动进程。
- 一百个以上仓库也必须完整传递、展示和校验；不得复用现有入队列表的 100 项截断。如果模型上下文因真实列表大小超限，走现有上下文失败流程，不能悄悄隐藏合法仓库。

## RULE-PRODUCT

### 使用流程

```text
用户在 Agent 设置中显式启用 git
  → 模型读取本轮工具描述中的 repo
  → 选择 repo，填写 args
  → 工具校验上下文并准备环境
  → 本机 Git 执行
  → 模型依据退出码和已脱敏诊断决定后续行动
```

- `repo` 始终显式必填，不自动选择唯一仓库或最近使用仓库。
- 仓库名就是登记目录名，不另增加名称实体或别名系统；同名仓库使用实际登记的后缀名。
- `commit` 不自动暂存，也不自动写作者配置；缺身份时保留原生诊断并提示用户设置身份。
- `push` 不自动补 `-u`，没有 upstream 时保留原生错误；不强制 `origin`。
- 参数对本机 Git 的支持程度由本机版本决定；未知选项、子命令等不由工具翻译成别的操作。
- `repo` 约束的是选择字段、起始目录和本次项目凭证来源。`args` 中的原生地址、Git 全局选项、alias 或 hooks 不通过本工具的命令分类器限制；这不是仓库沙箱承诺，见 [RULE-EXECUTION-BOUNDARY](decisions.md#rule-execution-boundary)。
- 工具不因失败自行改用 Bash、不切仓库、不换项目身份、不重试原生命令。
- 父 Git 的 exitCode 与受管进程收尾状态分别展示；同组后代停止未确认时，即使父进程退出 0，也不得显示整体成功或释放删除保护。
- 普通数值PGID观测不提供强OS身份，观测间消失/复用竞态仍在；首次ESRCH后不再向同号发信号。zombie-only可能无法在收尾时限内消失，不能声称KILL必然解除持有。
- 运维CLI只做本地机械检查与显式确认，不证明整个宿主静止，也不自动检查外部服务管理器。维护窗口与部署证据不足时保持hold，不承诺所有故障自动恢复，见 [RULE-LEASE-RECOVERY](implementation.md#rule-lease-recovery)。
- 结果元数据不返回认证路径；原生输出只确定性替换本次已知secret和token/key/askpass/lease字面路径，不保证所有私有路径均已脱敏。已知匹配跨chunk、截断和收尾仍须生效。

### Agent 启用与迁移

- `git` 加入可配置工具选项，但不加入新 Agent 默认工具列表，也不自动写入已有 Agent 的 tools。
- 用户需要显式开启；没有开启时，Bash 自动认证仍按本次改造撤销，不做隐式 fallback。
- 前端中英文标签均为 Git，说明明确“使用登记仓库凭证；Bash 不再自动提供项目 Git 凭证”。
- 既有模型授权指令仍然有效。工具启用表示可以调用工具，不表示模型已经得到提交、强推、删除或覆盖授权。
- 编辑运行中的 Agent 设置不承诺热更新静态工具列表；启用后启动新 run 才保证新的工具集合。已返回给模型的工具可用快照与执行期检查按现有语义保留。

## RULE-BASH-EXIT

- 删除 Bash 的 `tokenizeShellCommand`、`shouldPrepareGitEnvForCommand`、`needsGitEnv` 与 Git prepare/cleanup 调用。
- 删除仅供旧 Bash 使用的 client 方法、policy、response 类型与旧路由契约；不能删除其他入口使用的通用认证构建或 janitor。
- Bash 保持普通 Shell 工具：仍可运行 Git，仍继承原有 Worker 环境与 Shell 启动行为。
- 移除的是“项目根据 Bash 命令自动注入的认证”，不是系统 credential helper、SSH agent 或宿主环境认证。
- 原分支注入的 `GIT_TERMINAL_PROMPT=0` 也随分支退出；不能继续承诺 Bash Git 的相同行为。新 `git` 工具单独设置该变量。
- 交互式终端的 `terminalCredentialId`、终端开关、网络设置和认证文件全部保留。
- 旧 Bash 凭证租约回收按 [RULE-UPGRADE](implementation.md#rule-upgrade)执行。

## 非目标

- 构建完整 Git 操作业务模型、action 枚举或 Git 功能版本矩阵。
- 自动提交、自动推送、自动配置身份、自动修复仓库、自动回滚 Git 副作用。
- 完整 Shell/Git 参数分析、危险参数名单、逐命令确认框。
- 新增沙箱、容器、网络出口控制或多租户权限平台。
- 修改界面 Git 与交互式终端的产品语义。
- 将 Bash 的环境过滤、安全隔离或所有历史调用整体重构为新的通用框架。
