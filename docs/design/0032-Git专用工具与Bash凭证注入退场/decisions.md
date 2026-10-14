# 关键决策、取舍与边界

## 决策摘要

| 决策 | 原因 | 放弃的方案 |
|---|---|---|
| 一个原生 `git(repo,args,timeout)` 工具 | 易理解，复用本机 Git 能力，不跟踪版本功能 | action 枚举、任意 Shell 字符串 |
| 固定启动 Git，参数数组直接传递 | 消除 Shell 拼接和文本识别歧义 | `bash -lc "git ..."` |
| 每次准备项目环境 | 认证不再依赖识别命令是否访问远端 | Git 子命令白名单 |
| 仓库名动态描述、执行时校验 | 最新可选项与真实授权分离 | 入队快照、静态缓存、动态 enum 作为授权 |
| Worker 执行，API 管理认证 | 保留本地取消和进程树语义；Worker 不读 DB/master key | 把所有原生参数映射为现有业务 Git API |
| 通用认证规则只有一份 | 避免终端、API、工具长期分叉 | 新工具复制凭证选择和 askpass 规则 |
| 同次删除 Bash 注入 | 消除双入口和持续补丁 | Bash fallback、长期旧 RPC 兼容 |
| 不增加命令风险分类器 | 无法完整预测配置、hooks、alias 行为 | 持续扩充危险参数名单 |

## RULE-REPOS

### 权威名称与读取

- 权威实体为 `workspace_repos` 登记记录，名称为 `dirName`。`repo` 与登记名按字符串精确比较，大小写敏感，与文件系统的大小写行为无关。
- 在同一 Workspace 内名称唯一；跨 Workspace 可以相同。`repoId` 不向模型暴露为目标参数。
- 名称读取从登记记录产生，保留登记顺序，去重。安全名称规则在 API 与 Worker 独立执行，规则一致。
- 安全名称至少拒绝首尾空白、空字符串、`.`、`..`、`/`、`\`、绝对路径及 ASCII 控制字符（包括 NUL、CR/LF、TAB、DEL）。不得把不安全登记名转换成另一个可用名。
- 异常不安全登记记录不出现在描述或错误的可选列表中，不能被执行；记录安全错误码与记录数量，不打印原始异常名称。
- 新动态字段不调用有 100 项截断的入队 normalizer，不改变该入队字段的既有语义。
- 空列表与一百项以上列表的产品行为见 [RULE-DESCRIPTION](requirements.md#rule-description)。

### 执行时校验

- Workspace 从可信 run/session 归属确定，模型只传 `repo`。不能把工具调用的任意字段当 Workspace 来源。
- API 在每次准备租约时重新验证 run、session、工具执行和当前登记成员，并在删除 admission gate 内完成准备。Worker 完成 RPC/本地准备后，在 spawn 前执行最终本地目录检查。
- 登记路径必须与 `workspace.path + dirName` 一致；在最终检查时，目录必须存在、为目录，物理路径位于可信 Workspace 物理根内。最终检查前发生的缺失或越界软链替换必须拒绝，不能只靠字符串前缀判断。
- 最终 realpath/stat 检查与 spawn 不是原子操作。最终检查后发生的外部并发替换属于残余窗口；本方案不承诺完全杜绝，不新增隔离，不把窗口内可能的原生错误或实际目标当作已受沙箱限制。
- API 和 Worker 各自校验初始路径；API 通过既有登记路径解析、Worker 通过当前运行的 `workspacePath` 解析。API 不允许模型传 cwd；部署共享文件布局是前提。项目 detach 的保护与外部并发替换是不同边界。
- 名称不存在或已经移除，返回 `REPO_NOT_AVAILABLE` 与最新安全登记名。大小写拼错、同名后缀漏填等均不自动纠正。
- 描述生成和执行之间不是原子事务；“本轮描述中的仓库”不是执行授权快照。
- 租约准备成功是本次调用的 admission 点。后续新增仓库不影响本次调用；下一次调用和下一轮描述读取新状态。

## RULE-EXECUTION-BOUNDARY

- `repo` 确定初始 cwd 和本次项目认证来源，不是 Git 行为沙箱。
- 原生 argv 可以影响 Git 实际目标、访问的地址和子进程；本地 Git 配置、alias、hooks、helper 也可能运行程序。仅检查参数不能证明实际访问始终局限于所选仓库。
- 本次不根据子命令/参数进行风险分类，不新增完整执行隔离，也不声称解决了已有 Bash 的全部隔离问题。
- 不取消项目已有的 Workspace、数据目录、内部控制面和授权保护。初始目标及租约读写必须有确定性范围校验；不得为本工具把受保护的目录、凭证或内部 token 额外暴露给模型。
- 任意原生 Git 的后续行为仍属于受授权命令执行的信任边界，不是任意不可信代码的安全托管入口。需要硬沙箱的产品前提变化应单独立项，不能用提示词、`cwd` 或参数名单冒充完成。
- 用户授权写操作的模型指令继续有效；开启工具不授予任意强推、删除、重置或覆盖权限。没有新增逐条确认框，也不能在实现中自动代替用户给出授权。
- 工具不添加业务参数以限制 Git 版本，不补 `--ff-only`、不强制 `origin`、不自动修改原始命令。

## RULE-AUTH

### 项目认证选择

| 登记仓库状态 | 新工具行为 |
|---|---|
| 绑定有效凭证 | 选该凭证；不换另一项目身份 |
| 绑定 ID 不存在 | `CREDENTIAL_NOT_FOUND`，不启动 Git，不回退默认或无凭证 |
| 凭证解密失败 | `CREDENTIAL_DECRYPT_FAILED`，不启动 Git |
| 未绑定 ID | 复用既有 `buildGitEnv` 的 host/protocol 选择规则 |
| 未绑定且无可选项目凭证 | `kind=none`，使用网络/CA/禁交互环境，允许 Git 自身采用系统认证 |

- “未绑定”与“绑定失效”必须区分。只有未绑定时允许既有 host/protocol 自动选择，不得在失败后默默换身份。
- 既有选择规则实际是：协议可识别时，同 host 同 kind 默认凭证优先，其次同 kind 最近更新凭证；没有同 kind 时不跨协议回退。协议未知时仅选同 host 默认凭证。它不只是“只查默认凭证”。
- 凭证选择使用登记仓库的 URL，不从模型 args 推测目标，也不从 `terminalCredentialId` 读取。
- 原生参数和本地配置可能改变实际远端，系统 credential helper 也可能先于 askpass 提供身份。本工具保证项目准备环境的来源，不保证本机 Git 最终一定使用该项目身份或访问登记 URL。诊断、产品文案和验收不能作更强承诺。
- HTTPS token、SSH 私钥写入租约内临时文件；内部响应传路径，不把内容写进 argv 或 env。
- 代理、CA、askpass、SSH known_hosts 和 SSH 命令复用既有通用 Git 认证实现；实际 keys 和改造方法见[技术设计](technical-design.md#rule-auth-implementation)。
- 原生 Git 自己返回的认证失败仍是进程结果，不依据模糊文本自动换凭证。

## RULE-ENV

- 新 Git 子进程环境是“复制 Worker 环境并过滤”后再覆盖项目准备环境；不修改 Worker 的 `process.env`。
- 过滤全部 `AWB_*`。此外清除继承的项目认证专用覆盖项 `GIT_ASKPASS`、`GIT_ASKPASS_USERNAME`、`GIT_ASKPASS_TOKEN`、`GIT_ASKPASS_TOKEN_FILE`、`GIT_SSH`、`GIT_SSH_COMMAND`，防止上一次或宿主的这类覆盖项被误当作本次项目注入。
- 正常 `PATH`、`HOME`、系统代理、`SSH_AUTH_SOCK`、原生 Git 身份环境等可继承；注入环境同名项优先。
- 注入响应只允许通用 Git builder 产生的 keys，不能接受任意客户端 env。`AWB_*` 不得通过 extra env 重新进入。
- 新工具设置 `GIT_TERMINAL_PROMPT=0`，stdin 为 ignore，不提供交互输入。它不能阻止任意自定义 helper 弹窗或所有程序的交互行为，超时/取消仍必须有效。
- 环境过滤不是宿主秘密的完全隔离，SSH agent、HOME 下配置等原生能力仍存在。
- Bash 的环境继承保持原样，属于单独问题；不能借本次变更重构所有命令执行环境。

## RULE-RETRY

- Git 进程最多 spawn 一次；任何非零退出、超时、取消、输出超限、lease release 失败或结果写回失败均不触发自动重执行。
- Git 副作用可能已经发生。超时、取消不是事务回滚，输出失败也不代表提交/推送没有发生。
- prepare RPC 有界、无自动重试、按创建副作用处理；响应丢失后本次不启动 Git，已创建但未知 ID 的租约保持默认未确认保护，不能靠 janitor/TTL 猜测停止，须受保护定点运维恢复。
- 仅有prepare/release两个新增RPC；release有独立有界deadline，不复用已取消run signal，无自动重试。只有有效stopped已持久化的回收失败可交janitor；未确认默认持有，prepare/release故障也可能需要维护。没有运行状态报告或报告失败机制。
- 控制面写回可以依既有规则重放写回，但不能重新调用 provider；恢复中的 running 工具不能被默认为可重执行的 read。

## RULE-CONCURRENCY

- 不承诺新 Worker 原生 Git 与 API Git/交互式终端/外部 Bash 的全局互斥。API 现有仓库锁是单 API 进程锁，不能直接包住 Worker 进程。
- 本工具不因为参数像只读就跳过 admission；所有租约准备都按同样的当前运行和删除 fence 规则检查。
- 正常父退出、取消、超时和超限共用 TERM/KILL/同组停止确认。父 exit/close、stdio 关闭、run 终态或 Worker PID 退出均不能单独证明同组后代已经停止。
- 本次child对象与连续数值PGID观测是普通POSIX监督，不是强OS身份；kill(-pgid,0)成功只表示组存在。首次ESRCH后停止所有后续组信号，观测间消失/数值重用窗口明确残留。EPERM、未知、超时或zombie-only未消失均保守held，不声称KILL能清除僵尸，不新增cgroup/取证/监督器。
- Workspace 删除沿用现有 fence、取消并等待 Worker 流程，并在物理删除前检查 Git 停止保护；未确认停止的租约使删除保持 pending，不能仅依赖 cancelSessionAndWait 的 session 空闲判断。
- 单仓库 detach 在既有 gate/lock 内检查有效租约和持有状态：停止未确认时即使 TTL 已过仍返回 `REPO_GIT_BUSY`，不删目录/登记。prepare 和保护标记发布也在该 gate 内完成。
- 该检查按租约事实，不按 Git 子命令分类；不持有跨 RPC 的 DB 事务或长时间 API 锁。它只防止项目 UI detach 删除本工具的在途目标，不阻止用户通过原生命令或外部进程改动仓库。
- prepare在环境交付前持久化默认unconfirmed，交付前完成元数据发布；不依赖运行时网络报告。状态只取unconfirmed/stopped，不持久化不可靠的完整进程身份清单。release确认写失败仍保持保护，janitor保守处理，常规回收与恢复见[租约设计](technical-design.md#rule-lease)和[恢复流程](implementation.md#rule-lease-recovery)。
- release与janitor在同lease进程内短临界区串行化重读、停止确认、单调写stopped及删除；原子写文件本身不等于转换原子。已不存在幂等，不重建目录，不加分布式/跨进程锁，见 [RULE-LEASE-MUTATION](technical-design.md#rule-lease-mutation)。
- 同机维护CLI凭既有OS权限/受信目录，主服务已停且维护前提成立后直接调用同一租约服务；不启动网络/认证/运行时或自动删除恢复。helper只验证机械事实与显式确认，外部supervisor禁用及范围覆盖由操作者负责。未知/坏meta只能用已验证覆盖全部执行的受管环境全停或重启后服务未启动窗口；证据不足无安全现场恢复保证，保持hold。正常Worker RPC内部鉴权不变。
- 同一仓库并发命令的 Git lock 冲突按原生结果返回，不自动重试。修改 UI Git 锁为跨进程分布式锁是非目标。

## RULE-OUTPUT-SAFETY

- 不在日志、工具结果、清理诊断或 debug capture 中复制 env、凭证文件内容或完整 argv。
- 项目已知凭证原文、URL userinfo 及本次已知 token/key/askpass 租约路径应在输出进入 runner、结果 artifact、错误落盘和 UI 之前确定性替换；既不扩大为所有用户秘密识别，也不承诺清洗所有私有路径。
- 当前没有可假定为万能的原生 Git 输出脱敏函数；目标实现必须新增并测试有限的已知秘密脱敏路径，见[输出设计](technical-design.md#rule-output)。
- 原生 hook/helper 能自行编码或变换秘密；任意原生程序输出的通用秘密识别不可能完备。本工具不得宣传万能脱敏或把它当沙箱。
- 正常消息原始 tool_call args 仍按协议持久化；额外 Git 诊断统一使用安全投影，覆盖 capture 创建、事件 detail、writeback output、item/debug request，不仅改 provider 返回值。成功、前置失败、写回失败和禁用 pending 均适用；其他工具协议不变。用户不应把凭证放入 args。

## RULE-SCOPE-CONTROL

- 不改变已有合法 API Git/终端契约；通用 builder 的内部增量应保持默认调用行为兼容，新工具显式选择严格的失效绑定处理。
- 当前真实缺陷是 Bash 认证识别链不可靠，不以此改造全部 Git UI 或全部 Bash 安全模型。
- 不通过“兼容”长期维护两套项目凭证选择规则；内部 helper 的参数和 shared contract 变更必须有全调用方回归。
- 本方案没有等待“实现时决定”的参数、RPC 重试或迁移语义。安全隔离的非目标与残余风险已明确，不允许在实现中悄悄新增限制来改变原生接口。
