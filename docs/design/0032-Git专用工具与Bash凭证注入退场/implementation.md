# 开发任务、详细实施与迁移

## 实施原则

- 开发阶段可以拆分小提交，发布必须作为完整能力切换。不得单独上线撤掉 Bash 认证而尚无可用 Git 工具的版本。
- 先契约和故障测试，再接入，再退出旧链路。所有任务对照[权威决策](decisions.md)和[验收矩阵](acceptance.md)。
- 此文档中的构建/测试命令用于后续开发，不表示文档编写阶段已经执行。
- 实现不能以“动态 enum 还没兼容”阻塞首版，也不能以方便为由重新设计 action 工具或 Shell 字符串。

## 依赖关系

```text
TASK-CONTRACT
  ├─ TASK-CONTEXT
  ├─ TASK-LEASE → TASK-EXECUTOR / TASK-LEASE-RECOVERY
  └─ TASK-ENABLEMENT
上述完成 → TASK-BASH-EXIT → TASK-INTEGRATION（含恢复演练）→ TASK-RELEASE
```

没有依赖的任务可以并行，但通用 builder、共享契约或同一文件的修改必须协调；不能在两个分支分别实现凭证选择。

## TASK-CONTRACT

### 目标

固定共享输入/输出、动态响应字段、内部RPC，以及工具名，不先写松散的any实现。

### 实施步骤

- 按 [RULE-INPUT](requirements.md#rule-input)和[技术契约](technical-design.md)新增TypeBox schema/type，拒绝未知字段；空字符串argv元素必须有正例，NUL必须有反例。
- 在可调用工具名、历史工具名、用户可配置工具名和Worker builtin名单中加入git。
- 仅新增prepare/release endpoint常量和共享内部契约，从内部facade导出；release只接受可信owner、leaseId及停止证据，不接受数值PGID/维护字段，检查shared package exports和生成dist可用性。
- prompt context schema增加必填`workspaceRepoNames`，同步`PromptContext`类型、`EMPTY_PROMPT_CONTEXT`及所有测试fixture，不能用optional字段悄悄容忍版本错配。
- 结果schema加入两端structured-result名单，processStopConfirmed、单一停止未确认failureCode与leaseDisposition按精简契约落地；父exitCode与整体ok分开，不引入报告失败结果/警告，错误文本不得夹带原始exception/URL凭证。
- 为两个RPC写policy条目、responseSchema、abort/deadline签名；均无自动重试，不能列为excluded，release使用独立signal。
- 契约单测覆盖字段边界、timeout上下界、extra字段、内部上下文和响应的不合法env keys。

### 完成证据

- AC-INPUT、AC-RPC、AC-RESULT对应契约测试通过。
- shared构建及各使用方typecheck通过，没有重复本地类型与shared契约漂移。

## TASK-CONTEXT

### 目标

每轮模型工具描述使用最新登记仓库，不依赖入队快照或静态缓存。

### 实施步骤

- 复用`listWorkspaceRepos`来源建立安全登记名读取器，明确与既有入队normalizer的区别；保持名称顺序、完整列表和异常过滤。
- 在已验证run/session的动态read-side接入读取，返回`workspaceRepoNames`；保证重复访问同一run仍进行该读取。
- 在BuiltinToolProvider.listTools给git复制基础描述并追加本轮名；不修改静态缓存数组或工具对象。
- 无仓库时仍展示已启用的git和明确空状态，执行失败无副作用。
- 描述中的名称使用JSON转义显示；schema保持string，执行授权不依赖provider接受enum。
- 新增同一run连续两轮attach/detach、不同Workspace同名仓库、100项以上、异常名和空列表的API/Worker测试。

### 完成证据

- AC-CONTEXT与AC-REPO通过，能明确证明列表刷新不是仅首次run装配时发生。

## TASK-LEASE

### 目标

从当前运行的登记仓库准备认证，复用单一builder，具备默认停止保护、确认后回收及未确认定点恢复的v2租约。

### 实施步骤

- 在git-env模块提供新内部端点，保留内部token校验；新端点不接受cwd/purpose/credentialId或原生命令参数。
- 实现run/session/toolExecution归属与执行状态验证；所属Workspace从可信上下文确定，归属错误不得返回另一个Workspace仓库名。
- 在现有Workspaceadmission gate内验证登记、安全初始目录和删除fence，完成lease发布；在返回前检查运行是否已经终止。
- 给`buildGitEnv`增加可信artifactDir、kind/敏感文件路径及新工具严格失效绑定选项。保持默认既有调用行为，所有凭证选择仍在同一个builder实现。
- 完善builder创建中途失败的清理，文件/目录权限失败明确失败；不要把部分成功的目录藏在cleanup闭包未返回的路径里。
- 在独立v2命名空间排他创建ID目录，认证交付前原子持久化默认stopState=unconfirmed；none也有meta和leaseId。默认保护写失败不构建/交付env、不spawn，残留保守持有。
- 元数据只维护unconfirmed/stopped，不存运行原因、Worker实例/PID/PGID等不可靠的完整进程信息。prepare交付前完成所有构建/元数据写入，不在交付后异步更新，不依赖新状态报告。
- worker release验证owner及可信本地停止证据，先持久化stopped再删除；确认写失败不得删除。完成run仍允许合法owner清理，不以run仍running为条件。
- 按 [RULE-LEASE-MUTATION](technical-design.md#rule-lease-mutation)复用withRepoLock与独立逻辑lease键，release和janitor在同一短临界区内重读、确认、写入/删除；stopped单调、已不存在幂等，不mkdir复活目录，不按锁外旧快照清扫。
- janitor明确分发v1/v2，不得把v2容器按旧坏meta兜底整棵删除。v1保留原metadata策略；v2只有有效stopped可到期清扫，坏meta/未确认永不按TTL自动解锁。
- 在单仓库detach既有gate/lock与Workspace物理删除fence内增加v2保护检查，覆盖未过期租约及任何过期未确认租约；扫描/归属无法判定保守报错。
- 正常API启动必须先装配上述保护再恢复pending Workspace删除，覆盖Worker管理模式及禁用Worker的本地fallback模式，session idle/Worker PID退出不能替代检查。
- TTL和剩余时长检查按照 [RULE-LEASE](technical-design.md#rule-lease)：timeout默认120秒、1..3600秒，TTL=max(15分钟,timeout+5分钟)，常规最多65分钟，额外扫描最多5分钟；未确认例外继续持有，Bash不改。
- 接入TASK-LEASE-RECOVERY的同机CLI，直接调用同一租约服务，不启动维护HTTP/认证/运行时；正常Worker RPC仍内部鉴权，不能接受本地维护权限请求。
- 新增repo绑定/未绑定/协议选择/绑定失效/解密失败、none、权限失败、部分写失败、owner mismatch、path traversal、response loss和janitor测试。

### 完成证据

- AC-AUTH、AC-LEASE、AC-CONCURRENCY、AC-REPO通过。
- API现有Git/clone/mirror/终端认证回归通过；没有第二套权威认证算法。

## TASK-EXECUTOR

### 目标

固定原生argv执行，取消/超时/输出/清理均可诊断且不重执行。

### 实施步骤

- 在Worker新增局部Git executor，固定spawn git、不经过Shell；Linux/POSIX用detached:true创建独立进程组并记录pgid=child.pid；逐字逐项保留args，不注入业务选项。
- 以可信run的workspacePath和repo生成cwd，在全部RPC/本地准备完成后、spawn前最终realpath/stat；检查前软链替换必须拒绝，检查后至spawn的TOCTOU窗口明确保留，不承诺原子隔离。
- 按 [RULE-ENV](decisions.md#rule-env)复制并过滤环境；APIextraEnv覆盖同名项，原process.env不变。
- prepare前后和spawn前检查取消；响应丢失、非法env/secret文件路径、剩余TTL不足均不spawn。
- 新增有限脱敏上下文：加载本租约已知secret，覆盖HTTPS实际首行去CR的有效token、完整SSH私钥、token/key/askpass路径和lease目录字面字符串；处理URLuserinfo。不泛化为所有私有路径识别器。
- 以有界方式处理chunk匹配、UTF-8、512KiB合计输出、超限强杀和尾部；不得把raw输出递交runner再洗日志。
- 按 [RULE-PROCESS-SETTLEMENT](technical-design.md#rule-process-settlement)实现正常父exit/取消/超时/超限共享收尾：同组TERM最多200ms，必要KILL后最多1000ms确认，确认后stdio排空/关闭最多250ms。持有本次child并连续跟踪数值组，首次ESRCH后封闭所有后续组信号，不沿用Bash仅关闭stdio的兜底。
- kill(-pgid,0)成功只表示数值组存在，不证明身份；观测间数值复用竞态明确残留，不以Worker实例ID作强OS身份。EPERM、未知、超时或zombie-only未消失均held，KILL不能保证清除僵尸；不新增cgroup/取证/监督器。
- 正常父退出后代保持/不保持stdio都要停止；父0但停止未确认则整体失败，保留父exitCode、租约与删除保护，不声称已空闲或安全释放。
- 返回共享结果形状并增加git专属文本渲染，明确非零Git结果与前置失败；不回显完整argv/env/租约路径。
- 仅not_started或普通受管组监督停止已确认时调用独立deadline的release；否则不release/cleanup，默认unconfirmed保护无需新增网络失败标记。短命令直接收尾/释放，清理警告不覆盖原结果，不产生第二次spawn。
- 实现唯一GitDiagnosticProjection，接入capture创建、event detail、writeback output、item/debug request四入口，capture内部detail/output再防回流；测试成功/前置失败/写回失败/禁用pending，正常原始tool_call协议与其他工具不变。
- prepare前检查平台能力：发布基线Linux/POSIX；无经验证等价停止确认能力的平台明确GIT_EXECUTION_PLATFORM_UNSUPPORTED，不凭taskkill成功宣称支持，不改Bash。
- 原生工具禁用、无作者身份、无upstream、未知参数和Gitlock冲突不触发自动修复或重执行。

### 完成证据

- AC-ARGV、AC-ENV、AC-EXECUTOR、AC-OUTPUT、AC-RETRY、AC-RESULT通过。
- 证明AbortSignal已经中止时spawn次数为0；任何完成/写回/清理失败时spawn次数不超过1。

## TASK-ENABLEMENT

### 目标

可配置但不隐式授予新能力，历史读取与pending行为明确。

### 实施步骤

- 后端normalize工具名单允许git，但保持默认工具和已有持久化profile不变。
- 前端可选名单、label映射和中英文本加入Git；默认不勾选，保存后可以正确往返读取。
- 增加Bash项目认证已移除的迁移说明，并区分终端凭证开关仍控制交互式终端。
- 检查new-run工具装配、模型请求工具快照、pending precheck、provider执行检查和内部prepare授权均认识git。
- 未开启工具的历史调用/pending不能因为名字已加入sharedunion就获得执行能力。
- 编辑运行中profile不承诺热更新；升级前停止旧run，用户开启git后创建新run。
- 中英文及配置名单测试覆盖新Agent默认、已有Agent不迁移、显式开启、显式关闭、历史结果读取。

### 完成证据

- AC-ENABLEMENT与AC-HISTORY通过；配置数据库没有批量给所有Agent追加git的迁移。

## TASK-BASH-EXIT

### 目标

同次完全退出Bash识别和主动注入，而不是保留另一认证入口。

### 实施步骤

- 删除tokenizer/shouldPrepare函数、needsGitEnv、extraEnv准备和Bashfinallycleanup；普通Bashcwd、计时、stdout/stderr行为不变。
- 删除旧prepareGitEnvForBash/cleanupGitEnvLeaseclient方法、Bashresponse类型、policy项与旧RPC测试项。
- 删除旧`/api/internal/git-env/prepare`和`/api/internal/git-env/cleanup`路由，不建立旧请求到新仓库RPC的猜测适配器。
- `git-env`模块保留新端点和janitor；旧v1租约仍可回收。共享askpass、SSHknown_hosts、网络/CA和builder不得删除。
- 不删除终端凭证开关、terminalCredentialId或交互终端认证。
- 更新当前有效产品说明；历史Bash认证设计如需引用，标识为已退场，不把历史内容伪装成新工具契约。
- 搜索生产源码验证旧符号/路径没有可执行消费者；历史归档文字可保留，但不能作为fallback。

### 完成证据

- AC-BASH-EXIT与AC-REGRESSION通过。
- 对普通、分号、嵌套Shell、绝对Git路径等Bash命令，均断言项目prepare/lease调用数为0；不能以网络认证失败作为证明。

## TASK-INTEGRATION

### 集成顺序

- 先用stub spawn证明argv和次数，再用本地临时Git仓库验证真实CLI结果。
- 认证测试使用本地受控HTTPS/SSH端点与伪造凭证，禁止生产远端和真实token。
- 同一run中变更仓库登记，验证模型描述刷新和执行期重新校验。
- 故障注入准备响应丢失、默认保护写失败、正常父exit仍有后代、数值PGID复用/首次ESRCH后回调、zombie-only确认失败、已知秘密/路径跨chunk与截断、四类诊断入口、release与janitor竞态/确认写/删除失败、API重启与v2坏meta。
- 并发detach与Workspace删除测试必须验证目录和登记记录未被删除，含session已idle、超65分钟持有和启动恢复，不只验证HTTPcode；执行定点维护恢复演练。
- 真实Git测试不得依赖开发者HOME中的身份/helper或已配置SSHagent；隔离测试配置，避免假阳性。
- 验证原生命令非零退出仍可被模型/界面正确识别，未误标成“推送成功”。

### 开发自检命令

在仓库根目录执行，按改动层逐步增加：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/agent-worker
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test -w packages/shared
npm run test -w apps/agent-worker
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
npm run test -w apps/web
npm run typecheck
```

- 使用仓库实际测试入口，不自创未注册的测试命令；新增API测试归入现有unit/integration/worker门禁。
- 首先运行受影响的定向测试，再运行上述相关workspace完整套件；共享契约修改最终必须跑全仓typecheck。
- Linux/POSIX进程组确认、权限和SSH集成是发布验收基线；其他平台没有经验证等价能力时新Git工具直接拒绝，不影响既有Bash。后续宣称支持必须先补实机/CI停止确认与权限证据。

## RULE-UPGRADE

### 同次升级前

- 通知用户Bash不再自动获得项目Git认证，并说明需显式启用git工具。
- 停止新任务调度和自动重启；让已有run完成，或明确取消并确认所有相关Worker及受管执行范围停止。Worker PID退出或session idle不充分；没有确认停止，不删除租约/目标目录。
- 记录部署版本与是否有在途任务，不记录secret/env/完整argv。
- 准备包含新git历史读取兼容能力的回滚构建，不把“直接启动任意旧二进制”作为可用回滚。

### 切换

- API与Worker使用同一版本协调重启；不支持旧Worker长时间连接新API。
- 新API不接受旧Bashcwd接口。若独立旧Worker仍调用，返回404/端点不存在；升级错误不能被掩盖成新工具无凭证执行。
- 启动保留的janitor，回收旧v1到期租约及坏meta残留。不要递归清空整个tmp目录、共享SSH或CA目录。
- 用户显式启用git后创建新run；未启用Agent没有项目Bash认证fallback，这是可预期的行为变化。
- 验证界面Git和交互终端认证仍有效，终端凭证开关仍然存在。

### 在途与恢复

- 已经running的工具若因升级中断，按现有恢复语义收敛失败；不能自动重执行可能有副作用的git或Bash调用。
- 历史queuedBash调用不改写成git工具。它若在新run中被合法执行，只遵循新的无项目注入Bash行为；升级操作建议取消原run，不让老任务意外继续。
- 新git pending必须通过工具快照/启用检查；不能仅根据历史名字允许执行。
- prepare创建后响应丢失可能留下默认unconfirmed租约；不spawn、不重试，但API不能确认是否启动，不能承诺TTL自动解除，进入 [RULE-LEASE-RECOVERY](#rule-lease-recovery)。常规有效stopped残留才按最多65分钟到期及最多额外5分钟扫描回收。
- 停止已确认后的release失败不把Git原结果改为失败重执行；leaseDisposition必须如实为release_unconfirmed。API未持久化停止确认时保持busy，不能等TTL绕过；有效stopped已持久化时才可等待janitor，其他情形用定点维护恢复。
- 用户切换凭证不会重写已发租约；新调用读新配置，旧调用用已准备快照，停止未确认时不因TTL到期删认证文件，确认停止后才安全回收。

## TASK-LEASE-RECOVERY

### 目标与实现边界

- 新增计划脚本 `apps/api/src/maintenance/git-lease-recovery.ts` 与仓库根脚本 `npm run maintenance:git-lease`，实现下述确定流程及AC-RECOVERY，不留给实施阶段自由选择。
- 固定两个CLI模式：inspect只读安全meta；release在满足固定维护窗口后直接调用同一租约服务函数，并逐个交互确认。无mode默认inspect，不接受通配符/批量清空。
- 仅同机可信数据目录操作者可用；要求该数据目录运行身份或具备等价权限，不引入账号/RBAC。数据根、v2容器、lease目录必须验证物理根、无未知软链及合理属主/权限，失败拒绝。
- CLI仅解析必要dataDir配置/元数据、装配租约服务的文件操作依赖，不创建HTTP服务/临时token/API维护模式，不实例化完整AppContext或凭证存储。不启动Agent模块、本地fallback、Worker/plugin host、调度、运行恢复或Workspace删除恢复。
- 正常API禁用Worker仍有本地fallback/调度，不能拿该开关当全局静止证明。CLI免HTTP依赖既有OS权限与维护前提，正常Worker的prepare/release内部token鉴权不变，RPC不接受维护字段。
- inspect只输出leaseId、owner、repo安全名、stopState、createdAt/expiresAt等必要安全字段；不读token/key，不输出认证文件路径/完整argv。元数据不含PGID/完整进程清单，必须明确显示“进程范围信息需由运维证据提供”，坏meta标unreadable。
- helper只实现数据根/权限/ID/meta/期望值、有界已知PID/组存在性检查及显式确认；不替操作者停止进程，不自动验证外部supervisor已关闭或证明全宿主静止。数值检查不能当强身份。
- 实施测试分为可模拟机械检查/服务集成和部署演练/人工证据。CLI与服务的维护调用依赖主服务已停的独占窗口，不加跨进程锁，不建立第二个删除实现。

## RULE-LEASE-RECOVERY

### 定位与职责划分

- 在仓库根目录用计划helper只读定位目标租约；inspect可以在主服务仍运行时使用，但不能据元数据推导完整执行清单：

```bash
npm run maintenance:git-lease -- inspect
```

- 操作者负责暂停任务入口/调度、停止主API与相关Worker/本地fallback/plugin host等启动源、禁用并保持外部服务自动拉起；helper不能自动核实这些外部管理状态，也不声称知道该部署所有进程。
- helper能机械验证受信根/权限、合法单个ID、当前meta与期望值，以及操作者提供且仍可信的已知PID/PGID存在性。存在、EPERM或无法探测则拒绝；数值不存在只是当前观测事实，不是完整范围/身份证明。
- 以下运维覆盖条件由部署负责人提供可审查证据并显式确认。不能仅凭Worker PID退出、run结束、stdio关闭、session idle、旧实例ID或未经核实的数值PGID推断所有执行停止。

### 固定维护窗口

| 分支 | 操作者必须建立的前提与证据 | helper能验证/不能验证 |
|---|---|---|
| known_scope：可靠已知范围 | 有当前可信、覆盖目标租约所有受管执行的部署/生命周期信息；停止相关执行与所有启动源，按已知范围停止演练并确认无遗漏。仅可读meta不意味着范围已知 | 可检查提供的已知PID/组、期望owner/state及确认；不能自动证明清单完整或外部自动拉起已停 |
| managed_environment_stopped：受管环境全停 | 已经部署演练验证容器/OS受管环境确实覆盖该部署全部执行，含detached Git组；停止整个已验证范围及自动拉起，主API/Worker均不运行。helper从环境外访问同一受信持久数据目录 | 可检查本地数据与已知进程；环境覆盖/全停/重启策略的证据来自部署负责人，不由helper推测。普通spawn本身不提供此保证 |
| reboot_before_services：重启后维护窗口 | 系统重启前已安排禁用该部署主API/Worker及服务自动拉起；重启后它们和其他执行启动源尚未启动，在该窗口直接运行CLI。重启与“服务未启动”是明确人工运维前提 | 可检查本地数据/已知进程与显式确认；不能自动检查所有supervisor、证明完整宿主静止或代替重启操作 |

- 坏meta、归属不明或执行范围信息不齐时，known_scope不可选，只能采用后两个完整维护窗口。若已验证受管环境并不覆盖全部执行，必须选择重启维护窗口；不能把普通停Worker服务升级成全停证据。
- 无法提供任一适用分支的证据时，无安全现场恢复保证；保持hold，不释放、不清空目录，不增加监督器/网络认证/数据库表来假造证明。
- release开始至结束期间操作者须保持窗口独占，主服务与自动拉起不恢复；“已停”不能由CLI重新启动正常API验证。

### 定位与定点释放

- 满足上述分支后，以数据目录运行身份、同配置/dataDir直接执行release模式，不启动任何服务：

```bash
npm run maintenance:git-lease -- release
```

- 操作者显式选择单个合法leaseId、维护分支、expectedOwner/expectedState并确认覆盖条件。可读meta须完全匹配，不要求owner run仍running；无确认、条件缺失或机械检查失败就拒绝。
- unreadable仅接受expectedState=unreadable、expectedOwner=null及后两个完整窗口；不能猜owner、接受known_scope或按TTL处理。
- CLI把本地维护确认传给同一租约服务函数，HTTP路由不能获得这一调用权限。有效meta先单调持久化stopped再定点删除；坏meta满足严格维护前提后直接定点安全删除，不造owner/替代状态文件。
- 写入或删除失败按当前有效meta处理：仍unconfirmed/坏meta则保持保护；有效stopped才可在正常服务恢复后交janitor。不改用手工rm或第二删除实现；缺失合法ID的重复释放幂等，不重建目录。

### 验证与恢复服务

- 确认指定lease已不存在，重新扫描busy/unknown状态；其他租约仍保持。不承诺清除一个lease就使仍有其他hold的仓库解锁。
- 如还有其他hold，留在同一维护窗口逐个处理，不启动正常API后继续CLI删除；不能绕过fence。
- 退出CLI后才按正常配置恢复主服务，验证lease guard先于pending Workspace删除恢复装配，目标repo/Workspace busy正确；必要检查完成后再恢复调度/自动拉起。
- 保留安全ID、维护分支/覆盖范围、操作者确认与结果时间的记录，不记录secret、token、认证路径或完整命令。部署演练证据与CLI机械检查结果分开，不能把“命令成功”当作前提已被自动证明。

### 完成证据

- AC-RECOVERY中的机械单测/集成全部通过，包含直接服务调用、OS权限、期望值、finished-run、定点删除、不启动网络/运行时，以及正常API禁用Worker仍有fallback的反例。
- 适用维护窗口须有部署演练/人工证据：尤其受管环境覆盖或重启后服务未启动不能用mock声称已证明。缺少所需部署证据则该部署不能宣称现场恢复可用，保持hold。

## RULE-ROLLBACK

- 回滚前同样停止调度/自动重启、结束或取消在途run，并确认相关Worker及受管执行范围停止；不能仅凭Worker PID退出解锁。避免新Worker调用旧API或旧Worker调用新API。
- 已产生git工具历史后，原始旧版本可能不认识新工具名或结果。支持的回滚必须保留git历史read-sideunion和结果读取兼容，但不暴露git为可调用工具。
- 回滚构建不得为了读取历史自动执行pendinggit；它必须失败收敛或要求新版本恢复。
- profile中的git项需可安全读取/显示“不支持”，不得悄悄保存归一化后把用户配置删除。若回滚构建不能保持此兼容，禁止带新历史/新配置直接回滚。
- 不以删除新消息、删除数据库、重置仓库或恢复数据库快照覆盖用户后续数据来实现兼容。
- 回滚构建必须携带v2独立命名空间、默认持有、坏meta保守保护、停止确认与维护恢复兼容；只会按expiresAt回收的旧janitor不可用，绝不能把v2容器按旧坏meta策略整棵删除。残留未安全处理前禁止启动不具备该保护的旧构建。
- 已经发生的Git副作用不回滚；上线前后提交/推送结果由用户检查，部署回滚不能替代Git操作验收。
- 回滚暂时恢复旧能力必须作为明确的部署回退，而不是新版本长期Bashfallback；重新上线仍应满足Bash退场验收。

## TASK-RELEASE

- 完成[验收矩阵](acceptance.md)全部必验项，保存安全测试报告与版本组合；禁止附真实凭证。
- 独立代码审查覆盖两个RPC契约、认证唯一性、数值组/ESRCH封闭及僵尸/复用边界、默认持有、release与janitor临界区/不复活、TOCTOU声明、已知路径脱敏、四入口诊断、3600秒timeout/65分钟TTL、直接CLI及运维证据窗口、旧RPC退场、profile默认和历史兼容。
- 每个审查问题写明对应RULE/AC、采纳或拒绝原因；不合理的架构扩展要求应上报裁决，不私自扩大范围。
- 修复后复跑对应故障测试和相关workspace门禁；复审直到无未关闭阻碍。
- 用户验收以“可用Git替代入口+Bash零项目注入+其他入口不回归+租约可回收”为整体，不按单文件完成率发布。
