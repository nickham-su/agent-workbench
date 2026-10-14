# 测试矩阵与验收标准

## 验收约定

- 所有下列项目均为必验项，除明确说明的平台/部署条件项。通过源码搜索不能替代行为测试。
- 只使用项目内测试fixture、临时测试仓库、伪造凭证和受控服务，不连接生产远端，不使用开发者真实身份/token/SSH配置。
- 每项证据记录测试名称、平台、断言和结果；输出不能含真实秘密、完整env或私有日志。
- 机械单测/集成与部署演练/人工证据分开。mock可检验分支选择和拒绝，不能证明外部supervisor禁用、容器/OS范围覆盖或重启后服务未启动；不具备某窗口证据时不得宣称该部署具备相应恢复能力，保持hold。
- 以下章节标识与[实施任务](implementation.md)互相对应；失败时不能用增加action白名单、Bashfallback或自动重试来使测试“通过”。

## AC-INPUT

对应 [RULE-INPUT](requirements.md#rule-input)。

| 用例 | 输入/条件 | 必须成立 |
|---|---|---|
| AC-INPUT-VALID | 明确repo，非空args数组，省略timeout | 默认120秒；参数原样传递 |
| AC-INPUT-EMPTY-ELEMENT | args含合法空字符串、空格、引号、换行、Unicode | 每项逐字保留，不trim/拆词；Git自行决定合法性 |
| AC-INPUT-NUL | 任一args元素含NUL | GIT_INPUT_INVALID；prepare/spawn次数0 |
| AC-INPUT-SHAPE | args为空数组/字符串/包含数字；timeout为null/字符串/小数/0/负数 | 明确拒绝，无副作用 |
| AC-INPUT-TIMEOUT | timeout=1、3600、3601与省略值 | 1/3600合法、3601拒绝，省略默认120；不钳制，Node上限仅底层防御，Bash不改 |
| AC-INPUT-EXTRA | workspaceId、cwd、env、credentialId、command、action等字段 | 拒绝；不能覆盖可信运行上下文 |
| AC-INPUT-REPO | URL、绝对/相对路径、repoId、首尾空白 | 拒绝作为repo；单仓库不自动修正 |
| AC-INPUT-GIT-PREFIX | args误包含git程序名 | 不剥离、不补救，由本机Git返回原生结果 |

## AC-CONTEXT

对应 [RULE-DESCRIPTION](requirements.md#rule-description)、[RULE-DYNAMIC-CONTEXT](technical-design.md#rule-dynamic-context)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-CONTEXT-REFRESH | 同一run先读描述，attach/detach后再读 | 下一轮反映最新登记列表，即使静态cache仍命中 |
| AC-CONTEXT-SNAPSHOT | 入队快照含A，当前登记已移除A并加入B | 新描述使用B，不使用旧快照 |
| AC-CONTEXT-NO-SCAN | 磁盘有未登记目录 | 不显示、不自动加入可选repo |
| AC-CONTEXT-EMPTY | 无安全登记仓库 | 明确空状态；调用返回空availableRepos，无租约/进程 |
| AC-CONTEXT-LARGE | 101个以上安全登记仓库 | 无100项截断；末项可显示且可执行 |
| AC-CONTEXT-UNSAFE | 登记含控制字符、路径段或异常名称 | 异常名不显示/不可执行；诊断不回显其原文 |
| AC-CONTEXT-ISOLATION | 两个Workspace有同名dirName | 描述各自隔离；不带URL/内部ID/路径 |
| AC-CONTEXT-CACHE | 多次listTools，改变返回名 | 静态工具对象不被污染，说明不重复累积 |
| AC-CONTEXT-PROVIDER | 已支持的模型provider请求序列化 | 能接收动态description+string参数；首版不要求动态enum |

## AC-REPO

对应 [RULE-REPOS](decisions.md#rule-repos)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-REPO-EXACT | 同名后缀、大小写拼错或唯一仓库省略repo | 精确匹配；不猜测目标 |
| AC-REPO-REMOVED | 描述生成后、prepare前移除repo | REPO_NOT_AVAILABLE，给最新安全可选名，不spawn |
| AC-REPO-FOREIGN | 伪造run/session/Workspace关联 | RUN_CONTEXT_INVALID；不泄露外国仓库列表/凭证 |
| AC-REPO-TOOL-OWNER | toolExecution属于另一run或toolName不是git | 拒绝prepare，无秘密文件 |
| AC-REPO-INITIAL-PATH | 目录缺失/非目录/登记路径不一致 | REPO_PATH_INVALID，不回退其他目录 |
| AC-REPO-SYMLINK | 最终检查前候选目录被替换为指向Workspace外的软链 | API/Worker物理路径检查拒绝，不spawn；not_started释放已知lease |
| AC-REPO-RACE | prepare后、最终检查前本地目录消失/非目录/被替换 | 最终realpath/stat必须在全部准备后拒绝；不自动切仓库，not_started释放 |
| AC-REPO-RACE-AFTER-CHECK | 最终检查返回后、spawn前控制外部并发替换 | 记录残余TOCTOU窗口，允许原生失败或实际目标改变，不断言必然拒绝/原子隔离；无自动重试 |
| AC-REPO-ADMISSION | run在准备中进入终止态 | 不交付可执行环境；已建租约回收 |

## AC-ARGV

对应 [RULE-EXECUTION-BOUNDARY](decisions.md#rule-execution-boundary)、[RULE-EXECUTOR](technical-design.md#rule-executor)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-ARGV-DIRECT | spy spawn或测试git可执行程序 | 程序名固定git；shell=false；args与模型数组逐项相等 |
| AC-ARGV-SHELL | args含`;`、`&&`、`$()`、通配符、引号 | 不产生额外Shell命令/展开；作为原生参数 |
| AC-ARGV-NATIVE | Git全局选项、未知/新子命令、不同本机版本 | 不按业务action/白名单限制；不偷偷改argv |
| AC-ARGV-NO-REWRITE | commit/push/pull等原生参数 | 不自动stage、写身份、加-u、固定origin或添加ff-only |
| AC-ARGV-HOOK | 受控fixture启用alias/hook执行测试程序 | 原生机制可执行；说明明确不是沙箱，不能误判为Shell拼接漏洞 |
| AC-ARGV-MISSING | PATH无git，或spawn返回EACCES/E2BIG | 安全前置错误；无私有绝对路径泄露，租约回收 |

## AC-AUTH

对应 [RULE-AUTH](decisions.md#rule-auth)、[RULE-AUTH-IMPLEMENTATION](technical-design.md#rule-auth-implementation)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-AUTH-BOUND | repo与terminalCredentialId使用不同伪造身份 | git租约来自repo；不是Workspace终端凭证 |
| AC-AUTH-MISSING | 绑定ID失效且host另有默认凭证 | CREDENTIAL_NOT_FOUND，不选默认、不spawn |
| AC-AUTH-DECRYPT | 已绑定但解密失败 | CREDENTIAL_DECRYPT_FAILED，不改用系统/其他项目身份执行 |
| AC-AUTH-UNBOUND | 未绑定，同host同kind有默认/最新记录 | 精确复用既有优先级；默认优先、其次最新 |
| AC-AUTH-PROTOCOL | 只有不同kind凭证 | 不跨协议注入；none环境仍可采用系统认证 |
| AC-AUTH-NONE | 无可用项目凭证 | kind=none仍有租约；无秘密文件；非认证命令可以执行 |
| AC-AUTH-HTTPS | 受控HTTPS端点 | askpass/token文件认证；token不在argv/env内容中 |
| AC-AUTH-SSH | 受控SSH端点 | 租约私钥和known_hosts策略生效；key不进入结果 |
| AC-AUTH-NETWORK | 项目代理/CA与宿主不同 | 注入项目配置覆盖同名项，沿用通用builder |
| AC-AUTH-SYSTEM | 无项目凭证但fixturehelper/agent有效 | 系统认证可成功；不得判为“项目仍有Bash注入” |
| AC-AUTH-RAW-TARGET | 原生args/配置影响目标 | 不通过参数识别改写命令；不承诺登记URL唯一出口，风险说明与实现一致 |
| AC-AUTH-ROTATE | 租约发出后修改凭证配置 | 在途使用已准备快照，后续调用使用新配置；无隐式重试 |

## AC-ENV

对应 [RULE-ENV](decisions.md#rule-env)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-ENV-INTERNAL | Worker含伪造AWB内部token与其他AWB_* | git及普通后代环境无AWB_*；Worker源环境不变 |
| AC-ENV-OVERRIDE | Worker已有askpass/token/SSH覆盖项 | 清除继承项后由本次环境覆盖；无身份串用 |
| AC-ENV-NORMAL | PATH/HOME/SSH_AUTH_SOCK/正常代理存在 | 按设计保留；不宣称HOME/agent被沙箱隔离 |
| AC-ENV-INJECT | RPC响应含未知key、AWB_*、非string值或kind与秘密文件/认证keys不符 | 校验失败，不spawn，尽力释放已知lease |
| AC-ENV-STDIN | Git尝试交互输入 | stdin ignore；项目禁终端prompt；超时/取消可收敛 |
| AC-ENV-BASH | 普通Bash环境回归 | 没有顺手改成Git环境过滤策略 |

## AC-RPC

对应 [RULE-RPC](technical-design.md#rule-rpc)、[RULE-RETRY](decisions.md#rule-retry)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-RPC-AUTH | prepare/release无或错误内部token | 均401，不分配/释放lease；同机CLI免HTTP不放松Worker RPC鉴权 |
| AC-RPC-SCHEMA | 请求携带cwd/purpose/env/args或非法上下文 | schema拒绝，不形成任意env/路径入口 |
| AC-RPC-PREPARE-TIMEOUT | prepare超时/网络断开 | 使用有界deadline，0自动重试，Gitspawn=0 |
| AC-RPC-RESPONSE-LOSS | API创建默认unconfirmed后响应丢失 | 工具失败、不spawn/重试；未知ID保持保护，TTL不自动回收，定点维护恢复 |
| AC-RPC-CANCEL | prepare中run被取消 | 客户端中止且不spawn；已知ID用not_started release，未知ID保持默认保护；API尚未交付的确定未启动路径可回收 |
| AC-RPC-RELEASE-CANCEL | 命令取消且停止已确认 | release使用独立deadline；未确认不得release，不能把原signal已abort当停止证据 |
| AC-RPC-VALIDATION | API返回不合法schema/env/路径 | Worker失败闭合，不执行；无response body秘密回显 |
| AC-RPC-POLICY | 新clientmethod和测试policy表 | 不是excluded；与实际deadline/0重试一致 |
| AC-RPC-SURFACE | 枚举新端点/client/policy/schema，并注入数值PGID、mode/维护字段 | 仅prepare/release两项；运行期间无Git-env状态更新请求，未知字段拒绝，数值PGID不能作为完整停止证明，无报告失败结果/警告 |

## AC-LEASE

对应 [RULE-LEASE](technical-design.md#rule-lease)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-LEASE-PERMISSIONS | POSIX租约创建 | dir/script0700，secret/meta0600；失败不宣称成功 |
| AC-LEASE-PARTIAL | 认证创建中途或权限操作失败，未交付env | 确定未启动路径即时尽力回收；回收失败的v2未知meta保守持有，不套v1兜底；不spawn |
| AC-LEASE-ROOT | leaseId点段、slash、反slash、软链、错误根 | 不删根或共享文件，不越界读写 |
| AC-LEASE-OWNER | worker release携带他人lease与run上下文 | 403，目标保持；正常owner仅携合法停止证据可清理 |
| AC-LEASE-IDEMPOTENT | Worker RPC/同机CLI安全释放后各自重复调用 | 合法ID已不存在时ok:true；不产生新lease、不误删；RPC鉴权/CLI OS权限与维护前提各自仍必需 |
| AC-LEASE-AFTER-RUN | run已终止或repo不再可用 | worker停止证据与meta owner仍验证，合法清理不要求run仍running |
| AC-LEASE-TTL | 默认120、1与最大3600秒，假时钟 | TTL分别15、15、65分钟；有效stopped可到期清扫，最多额外5分钟，未确认例外保留 |
| AC-LEASE-INSUFFICIENT | 响应剩余TTL不足 | GIT_LEASE_EXPIRED，不重新prepare、不spawn |
| AC-LEASE-CRASH | API/Worker崩溃后启动或到期 | v1按旧策略；v2恢复持有检查，未确认永不因重启/TTL解除，有效stopped可回收 |
| AC-LEASE-BAD-META | v1/v2无或损坏meta | v1保留30分钟mtime兜底；v2不回收，归属未知物理删除保守报错，不使用meta任意tempDir |
| AC-LEASE-CLEANUP-FAIL | release请求未到/确认写失败/删除失败/响应丢失 | 未持久化stopped则hold；有效stopped才可janitor，返回release_unconfirmed与警告，不重执行 |
| AC-LEASE-SCAN-FAIL | detach读取lease状态失败 | GIT_LEASE_STATE_UNAVAILABLE；目录和登记不删除 |
| AC-LEASE-DEFAULT-HOLD | prepare后未release、Worker崩溃或本地诊断丢失 | 发环境前已有原子unconfirmed，kind=none同样有；保护不依赖新增运行时网络报告 |
| AC-LEASE-HOLD-WRITE-FAIL | 默认保护原子写失败 | 不构建/交付认证环境、spawn=0；未交付目录尽力回收，残留v2保守持有 |
| AC-LEASE-HOLD-EXPIRED | stopState=unconfirmed，超过65分钟再扫描 | 不删敏感文件、不解除repo/Workspace保护，输出安全诊断与恢复提示 |
| AC-LEASE-STOP-WRITE-FAIL | 停止已确认但release持久化stopped失败 | 不删除、不将未知状态当已停止；警告与release_unconfirmed，仍busy |
| AC-LEASE-V2-CONTAINER | v2容器无自身meta，包含有效/坏meta租约 | janitor仅进入v2分发，不按旧30分钟mtime整棵删除 |
| AC-LEASE-UNKNOWN-WORKSPACE | v2坏meta无法确定Workspace归属 | 物理删除检查GIT_LEASE_STATE_UNAVAILABLE，不猜owner、不视为无租约 |
| AC-LEASE-SERIAL-RELEASE | 同lease两个release用屏障制造读/写/删竞争 | 共用withRepoLock逻辑lease键串行；锁内重读owner/state，先确认stopped再删，第二次幂等，无迟到写入/目录复活 |
| AC-LEASE-JANITOR-RACE | janitor锁外枚举旧快照后与release交错，两种先后顺序 | 同lease相同短临界区内重读；未确认不删，已删不重建，不按旧快照覆盖，其他lease可独立处理 |
| AC-LEASE-STOP-MONOTONIC | 已stopped、重复release、删除失败/目录已不存在 | 不降级unconfirmed，不mkdir/重建meta；原子写不是独立转换锁的替代，写失败不删 |
| AC-LEASE-STATE-SCHEMA | meta.stopState合法两值与第三种非法值 | 仅unconfirmed/stopped；非法meta保守unknown保护，不能把运行原因当状态 |
| AC-LEASE-META-MINIMAL | prepare交付及历史meta只读检查 | 无args/env/secret/Worker实例/PID/PGID/额外原因字段；交付前完成发布，inspect不假称有完整进程清单 |

## AC-EXECUTOR

对应 [RULE-EXECUTOR](technical-design.md#rule-executor)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-EXECUTOR-EARLY-ABORT | prepare前/prepare后/spawn前已abort | 不spawn；已知ID用not_started release，释放失败/未知ID保持默认保护，不假定必然回收 |
| AC-EXECUTOR-CANCEL | 运行中取消，父子进程fixture | 停止流程有界，cancelled=true；正常进程组后代停止 |
| AC-EXECUTOR-TIMEOUT | 超过timeout | timedOut=true；原始退出码/信号如实记录，未伪造成功 |
| AC-EXECUTOR-OUTPUT-LIMIT | stdout+stderr合计超512KiB | outputLimitExceeded=true，结束进程，结果内存有界 |
| AC-EXECUTOR-PARENT-EXIT | 父正常退出0，后代持stdio | 仍探测/TERM/KILL同组，确认组不存在前不release/成功；保留父exitCode=0 |
| AC-EXECUTOR-PARENT-EXIT-NO-STDIO | 父正常退出0，同组后代不持stdio | close提前发生仍不漏收尾，确认组停止后才release；不能靠输出管道证明停止 |
| AC-EXECUTOR-REASONS | 取消/超限/退出竞争 | 最多一次终止流程；flags保留实际原因；不重执行 |
| AC-EXECUTOR-WINDOWS | Windows等无经验证等价停止确认能力平台 | prepare/spawn前GIT_EXECUTION_PLATFORM_UNSUPPORTED；不凭taskkill=0通过，不改Bash |
| AC-EXECUTOR-NO-ROLLBACK | 命令副作用已发生后取消 | 不自动回滚/重置；说明结果需核实 |
| AC-EXECUTOR-STOP-CONFIRM | TERM后仍存活，KILL已发送但探测仍存在 | 最多200ms TERM+1000ms确认，轮询≤20ms；直到确认不存在才release，不能仅看kill调用成功 |
| AC-EXECUTOR-STOP-UNKNOWN | EPERM、探测未知、已知关联失信或确认超时 | GIT_PROCESS_STOP_UNCONFIRMED且held；已知关联不可信则停止发信号，不宣称能识别观测间全部数值重用 |
| AC-EXECUTOR-SETTLEMENT-TIMING | 正常exit/取消/超时/超限各触发 | 统一有界收尾且只触发一次；确认后stdio最多250ms，close不能取消强杀阶段 |
| AC-EXECUTOR-STOP-LATE | runner已返回失败/session idle，但受管组仍存活 | 产品明确停止未确认且受保护busy，不release；Worker退出不是证明 |
| AC-EXECUTOR-GROUP | Linux/POSIX真实受控父子进程 | spawn detached=true、独立pgid=父pid；受管信号不发送给Worker所属组，后代继承组且可探测 |
| AC-EXECUTOR-ESRCH-LATCH | 探测/信号首次ESRCH后同号再次出现，旧timer/取消/stdio事件触发 | groupAbsentObserved单调，取消所有后续TERM/KILL/补杀；之后向同号发送信号次数0 |
| AC-EXECUTOR-PGID-REUSE-WINDOW | stub模拟两次观测间原组消失/同号复用且返回存在 | 不把数值存在或Worker实例当强身份，不断言普通接口能自动拒绝所有复用；说明残余风险，发现未知关联则held |
| AC-EXECUTOR-ZOMBIE | 受控组只剩未被父回收的僵尸，探测一直存在 | KILL不是回收证明；确认时限后停止未确认、保留lease/删除保护，无无限补杀或假成功 |
| AC-EXECUTOR-LOCAL-LIFECYCLE | 极短命令、组尚未建立的取消窗口、exit/close竞争，准备后仅release可用 | 组未建立不以提前ESRCH虚构确认，确定未启动才not_started、启动未知held；child/本地生命周期驱动一次收尾/交付，无状态报告依赖或租约复活 |

## AC-OUTPUT

对应 [RULE-OUTPUT](technical-design.md#rule-output)、[RULE-OUTPUT-SAFETY](decisions.md#rule-output-safety)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-OUTPUT-SECRET | fixture输出本次伪造token/私钥 | stdout/stderr均替换，outputRedacted=true |
| AC-OUTPUT-TOKEN-FORM | HTTPS文件有CRLF/末尾换行，askpass输出有效首行token | 实际有效token也被匹配，不只匹配整个文件 |
| AC-OUTPUT-CHUNKS | 秘密跨chunk、跨UTF8边界、接近预算边界 | 不泄露原文或被截断的已知秘密前缀 |
| AC-OUTPUT-TAIL | 超限/取消时匹配器有秘密残留尾部 | 尾部安全收敛，没有绕过脱敏的finally输出 |
| AC-OUTPUT-URL | 原生诊断含带userinfo的URL | 输出移除userinfo，仍保留可操作的非秘密诊断 |
| AC-OUTPUT-GUARD | 秘密文件不存在、路径不可信、读取失败或超过1MiB | 有界读取、不spawn；GIT_OUTPUT_GUARD_FAILED；lease回收 |
| AC-OUTPUT-BUDGET | 持续重复秘密被替换，或替换文本膨胀 | 原始读取和最终输出均有512KiB合计上限，超限结束，不能靠脱敏绕过预算 |
| AC-OUTPUT-SINKS | result/preview/artifact/debug/errorcapture/itemlog | 所有sink只接收已脱敏结果；无raw备份 |
| AC-OUTPUT-ARGV | capture创建/event detail/writeback output/item-debug request | 全部使用同一Git安全投影，覆盖成功/前置失败/写回失败/禁用pending；正常tool_call原始args仍按协议保存 |
| AC-OUTPUT-LIMITATION | hook输出任意编码/变形内容 | 不把有限匹配测试通过宣传为万能secret识别/沙箱 |
| AC-OUTPUT-LEASE-PATH | 原生stdout/stderr打印token/key/askpass路径及lease目录 | 已知字面串确定性替换、outputRedacted=true；元数据无路径不能替代此测试 |
| AC-OUTPUT-PATH-CHUNKS | 上述路径跨chunk/UTF8、预算边界或取消/超限尾部 | 不输出完整字面串或被截断的已知路径前缀，缓存/最终结果均有界 |
| AC-OUTPUT-PATH-LIMITATION | 原生输出其他任意私有路径 | 不宣称所有路径已脱敏；只保证已知集合，非秘密诊断可保留 |

### AC-DIAGNOSTIC：四入口与分支矩阵

对应 [RULE-DIAGNOSTIC-PROJECTION](technical-design.md#rule-diagnostic-projection)。以下每行必须对成功、前置失败、running/completed写回失败、禁用pending分别执行，并在参数中放入伪造secret与路径哨兵，检查诊断存储无原始argv/env/异常对象。

| 用例 | 入口 | 各分支必须成立 |
|---|---|---|
| AC-DIAGNOSTIC-CAPTURE | capture创建及constructor snapshot | 只保存安全repo/argsCount/合法timeout，非法字段为null，禁用分支也无原始args |
| AC-DIAGNOSTIC-EVENT | recordEvent detail、错误/cause | 固定stage/code与安全result；不能spread原Error或outputBase；capture内部继续投影 |
| AC-DIAGNOSTIC-WRITEBACK | recordWritebackAttempt/Success/Failure | running/completed/policy_failed及写回失败再捕获只含投影，嵌套request/output不回流 |
| AC-DIAGNOSTIC-ITEM | item/debug request/response | request只含必要ID/tool名/投影，response仅安全结果/code；成功日志无request.args |
| AC-DIAGNOSTIC-PROTOCOL | 正常消息tool_call持久化及其他工具 | 原始Git args仍按协议保存并逐字执行，其他工具诊断协议不变，无诊断安全“补救”改写 |

## AC-RESULT

对应[输入与结果契约](technical-design.md#输入与结果契约)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-RESULT-SUCCESS | 原生退出0，普通组监督停止确认且无取消/超时/超限 | ok=true、exitCode=0、processStopConfirmed=true，flags准确，stderr可非空；不依赖状态报告 |
| AC-RESULT-NONZERO | 未知选项/无身份/无upstream/lock冲突 | 原始非零退出+安全stderr，不自动修复；UI不显示业务成功 |
| AC-RESULT-SIGNAL | 以信号终止，无数字退出码 | exitCode=null，signal真实或null；不虚构数字 |
| AC-RESULT-PREFLIGHT | 参数/归属/凭证/启动失败 | 稳定code与安全说明；无伪造Git结果 |
| AC-RESULT-STRUCTURED | 正常读取、历史重放、API校验 | 两端结果schema一致，结果元数据无env/lease路径/完整args；原生输出按已知匹配规则另验 |
| AC-RESULT-CLEANUP | Git成功且停止已确认，但release失败/响应丢失 | ok保留true、leaseDisposition=release_unconfirmed、warnings含LEASE_CLEANUP_FAILED，不猜已释放，不提示重复推送 |
| AC-RESULT-STOP-FAIL | 父退出0但组停止未确认 | ok=false、exitCode=0、processStopConfirmed=false、failureCode=GIT_PROCESS_STOP_UNCONFIRMED、leaseDisposition=retained |

## AC-RETRY

对应 [RULE-RETRY](decisions.md#rule-retry)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-RETRY-NATIVE | 非零退出/超时/超限/取消 | 原生spawn最多1次 |
| AC-RETRY-WRITEBACK | 成功后complete/toolwriteback丢响应 | 仅按既有规则重放写回；provider不再执行 |
| AC-RETRY-RECOVERY | running工具恢复为失败 | 不因“Git可能只读”而重执行 |
| AC-RETRY-FALLBACK | 准备/认证失败 | 不转Bash、不换repo、不换项目身份 |

## AC-CONCURRENCY

对应 [RULE-CONCURRENCY](decisions.md#rule-concurrency)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-CONCURRENCY-DETACH | 活动v2lease与detach同repo | REPO_GIT_BUSY，目录/登记未删除 |
| AC-CONCURRENCY-ADMISSION | prepare与detach并发先后 | 同gate使二者顺序明确：先detach则prepare失败，先lease则detachbusy |
| AC-CONCURRENCY-OTHER-REPO | A执行，detachB | 不因为A而误判B在途；B照既有规则处理 |
| AC-CONCURRENCY-RELEASE | 安全release后/有效stopped到期回收后detach | 重新检查该repo其他租约，无hold才继续detach；未确认不能TTL解锁 |
| AC-CONCURRENCY-DELETE | Workspace删除时Git运行或停止未确认 | fence拒绝新prepare，物理删除前检查持久化保护；即使session idle/Worker退出仍不删 |
| AC-CONCURRENCY-NATIVE | 同repo原生命令/界面Git并发冲突 | 原生lock结果可诊断，不伪称全局互斥、不重试 |
| AC-CONCURRENCY-IDLE-HOLD | run结束/session idle/Worker退出但lease未确认 | detach及Workspace物理删除仍拒绝，fence保持pending，TTL不解除 |
| AC-CONCURRENCY-STARTUP-GUARD | API重启且有pending Workspace删除及未确认/坏meta | guard先于恢复装配；Worker开启/关闭本地fallback两种模式均不删目录 |
| AC-CONCURRENCY-OPERATOR-RELEASE | 维护释放一个租约，repo另有hold | 其他hold继续busy；无剩余hold才解除，不误删其他lease |

## AC-ENABLEMENT

对应 [RULE-PRODUCT](requirements.md#rule-product)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-ENABLEMENT-DEFAULT | 新Agent/原有Agent升级 | 均不自动追加git，没有批量授权迁移 |
| AC-ENABLEMENT-EXPLICIT | 用户开启并新建run | 配置往返正确，描述/执行/内部RPC均可用 |
| AC-ENABLEMENT-DISABLED | 未开或工具不在模型可用快照 | 不prepare、不spawn；不能靠历史名字绕过 |
| AC-ENABLEMENT-LOCALE | 中英文设置 | Git标签与Bash认证迁移说明一致，terminal开关仍可理解 |
| AC-ENABLEMENT-AUTHORIZATION | 用户未授权写操作 | 原有模型授权约束仍在；工具开启不被描述为自动写权限 |

## AC-BASH-EXIT

对应 [RULE-BASH-EXIT](requirements.md#rule-bash-exit)。

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-BASH-EXIT-SOURCE | 搜索生产源码 | 无旧tokenizer/识别/prepare消费者；旧client方法/policy/types清理 |
| AC-BASH-EXIT-COMMANDS | 普通git、分号、嵌套Shell、绝对可执行路径 | 旧/新项目leaseRPC调用数均0，不创建项目认证文件 |
| AC-BASH-EXIT-ENDPOINTS | 调旧cwd接口 | 旧路径不可用，没有猜测repo适配或fallback |
| AC-BASH-EXIT-SYSTEM | fixture宿主helper/SSHagent认证成功 | 允许成功，不误报为退场失败 |
| AC-BASH-EXIT-PROMPT | Bash检查环境 | 不再由旧分支注入GIT_TERMINAL_PROMPT；普通Bash行为仍正常 |

## AC-HISTORY 与 AC-REGRESSION

| 用例 | 条件 | 必须成立 |
|---|---|---|
| AC-HISTORY-READ | 新git调用/结果已持久化 | 新版本read-side与UI可读，不需要重复执行 |
| AC-HISTORY-PENDING | 旧Bash或新gitpending遇升级 | 不改写、不隐式赋权，遵循取消/失败收敛规则 |
| AC-HISTORY-ROLLBACK | 使用兼容回滚构建 | git历史可读、不能调用、不丢profile、不删消息 |
| AC-HISTORY-VERSIONS | API/Worker版本错配 | 明确端点/schema失败，不退化成无凭证执行；部署步骤避免错配 |
| AC-REGRESSION-API | 界面Git/clone/mirror | 合法既有认证、网络和契约不回归 |
| AC-REGRESSION-TERMINAL | 交互终端/terminalCredentialId/开关 | 配置与长期认证不被删除，网络设置仍生效 |
| AC-REGRESSION-LEGACY-LEASE | 旧v1与新v2残留，含回滚构建 | v1原策略，v2有效stopped才到期回收，未确认/坏meta保留；绝不误删v2容器/共享SSH/CA/其他tmp |
| AC-REGRESSION-NO-HALF-RELEASE | 发布包与启动流程 | 替代工具、Bash退场、清理与说明一起交付 |

## AC-RECOVERY

对应 [TASK-LEASE-RECOVERY](implementation.md#task-lease-recovery)及 [RULE-LEASE-RECOVERY](implementation.md#rule-lease-recovery)。机械测试用项目内伪造配置/元数据和受控进程；部署条件项需后续在隔离演练环境留下人工证据，本轮文档修订不操作真实部署。

| 用例 | 证据类型 | 条件 | 必须成立 |
|---|---|---|---|
| AC-RECOVERY-PERMISSION | 机械单测/集成 | 非运行身份/权限不足/根或目标未知软链 | 拒绝，不越界、不读secret、不删目录 |
| AC-RECOVERY-QUIESCENCE | 机械单测/集成 | 已知PID/组存在、EPERM/未知，或只确认Worker PID退出 | 存在/未知检查拒绝；仅Worker退出不足以完成维护确认，不自动推导完整静止 |
| AC-RECOVERY-NO-RUNTIME | 机械单测/集成 | 启动inspect/release | HTTP/token创建及Agent/Worker/fallback/plugin host/调度/运行或删除恢复启动次数均0；不实例化完整API |
| AC-RECOVERY-INSPECT | 机械单测/集成 | inspect/默认mode列举有效/坏meta，主服务可仍运行 | 只读安全字段，坏meta=unreadable；不读key/token、不输出认证路径，不声称有PGID/完整执行清单 |
| AC-RECOVERY-EXPECTED | 机械单测/集成 | expectedOwner/state错配、通配符/批量选择 | 拒绝，目标与其他租约保持 |
| AC-RECOVERY-FINISHED | 机械单测/集成 | owner run已finished/cancelled，维护前提以fixture确认 | 可读归属/状态匹配可定点清理，不要求run仍running；fixture不证明真实部署静止 |
| AC-RECOVERY-UNREADABLE | 机械单测/集成 | 坏meta/范围信息不齐、unreadable/null | known_scope拒绝；仅后两个完整窗口及显式确认可定点删，不伪造owner/替代文件；实际前提另验 |
| AC-RECOVERY-STOP-EVIDENCE | 机械单测/集成 | 分支缺失/非法、覆盖确认不齐或无confirm | 拒绝；不公开删除、不整目录清空、不由helper杀未知PID |
| AC-RECOVERY-RELEASE-FAIL | 机械单测/集成 | 有效meta确认写/安全删除失败，或坏meta删除失败 | 共用同一服务；写失败不删、有效stopped可清扫，unconfirmed/坏meta仍保护，不造新状态文件 |
| AC-RECOVERY-VERIFY | 集成及恢复演练 | 定点释放后检查其他hold，再退出CLI恢复服务 | 指定目录不存在、其他hold保持；不能主服务运行时继续CLI删除，guard先于pending删除恢复，验证后再恢复调度 |
| AC-RECOVERY-REPEAT | 机械单测/集成 | 合法本地释放已不存在ID | OS权限与维护前提仍必需，ok:true，不新建/误删；记录无secret/token/认证路径 |
| AC-RECOVERY-DIRECT | 机械单测/集成 | spy本地CLI服务依赖与正常HTTP路由 | CLI直接调用同一租约服务/安全删除，不经过HTTP/内部client；RPC维护字段拒绝、Worker鉴权不变，无跨进程锁 |
| AC-RECOVERY-KNOWN-SCOPE | 条件部署演练/人工证据 | 负责人确有覆盖目标执行的当前可信范围信息 | 停主服务/启动源/自动拉起，按已知范围停止；记录范围覆盖及显式确认，机械不存在检查不替代覆盖证据；信息不齐不能选此分支 |
| AC-RECOVERY-MANAGED-ENV | 条件部署演练/人工证据 | 声称采用受管环境全停窗口 | 演练证明范围覆盖全部执行含detached组，环境全停/自动拉起禁用后CLI从环境外访问同一数据根；有逃逸或覆盖未验证则该分支不可用，不能归功于普通spawn |
| AC-RECOVERY-REBOOT-WINDOW | 条件部署演练/人工证据 | 采用系统重启后服务未启动窗口 | 重启前安排禁用部署自动拉起，重启后主API/Worker及其他启动源尚未启动；保留人工操作证据，不让helper宣称自动核实所有supervisor |
| AC-RECOVERY-MISSING-EVIDENCE | 分支单测及人工发布检查 | 无完整已知范围、无已验证全停环境且未建立重启维护窗口 | 不尝试现场释放，保持hold并明确无安全现场恢复保证；不新增监督器/认证/表来填空 |
| AC-RECOVERY-MECHANICAL-LIMIT | 单测及文案/人工检查 | 已知数值检查均通过，但外部启动源/覆盖状态未获运维确认 | 不从机械结果推导宿主静止；缺确认拒绝，外部真实状态由负责人负责，不能要求helper自动发现所有隐蔽supervisor |

## 最终验收证据包

- 全部相关workspace的typecheck与测试报告，注明平台条件项是否通过。
- 动态描述的安全示例，证明同一run连续请求刷新，而不是只看静态schema截图。
- 启用/禁用与默认profile无隐式迁移的证据。
- 原生argv逐项一致、spawn次数、取消/超时/输出预算与秘密跨chunk测试证据。
- 仅prepare/release有界policy、正常exit同组后代停止/失败持有、ESRCH封闭/数值复用窗口/zombie-only、同lease转换临界区/不复活、旧租约回收、四入口投影、detach/Workspace删除及升级/回滚证据。
- 直接CLI机械检查报告与适用维护窗口的部署演练/人工证据分开；不把mock或CLI成功当作外部supervisor禁用/全局静止已被证明。
- Bash没有任何项目Gitprepare/lease调用的行为证据，加生产源码退场检查。
- API Git/交互终端回归、代码审查与问题复审记录；没有未关闭阻碍项。

验收不能仅以“模型推送成功一次”替代上述边界检查。
