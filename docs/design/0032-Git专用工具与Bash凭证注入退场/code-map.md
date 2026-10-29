# 改造前源码地图与当前目标实现定位

## 引用说明

- 本文前半部分是设计时（2026-10-14）只读核实的**改造前源码地图**，保留历史问题与改造意图，不是当前运行实现的陈述。功能现已实现并通过逐阶段及全面独立代码审查；当前目标定位见下方已落地实现表。
- 历史表中的旧行号仅保留改造前定位说明；保留文件的链接只指向文件，不把已漂移的旧行号伪装成当前源码锚点。已删除旧文件改为无链接的历史路径；当前源码行号和符号仅见已落地实现表。
- 链接相对于本设计目录，指向项目内代码；没有读取真实环境变量、数据库、凭证文件或私有日志。

## 改造前内置工具与模型请求

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [agent-primitives.ts:10-31](../../../packages/shared/src/contracts/agent-primitives.ts) `AgentCallableContextToolNameSchema` / `AgentContextToolNameSchema` | 可调用名单没有 git；历史读取 union 保留 retired 名称 | 加入 git；保留已有历史兼容规则 |
| [settings.ts:262-275](../../../packages/shared/src/contracts/settings.ts) `AgentToolNameSchema` | 用户可配置工具名单没有 git | 加入 git |
| [tools/types.ts:15-42,82-99](../../../apps/agent-worker/src/runtime/tools/types.ts) | list context 有 promptContext；run 有 Workspace/path/入队名快照；builtin 名单没有 git | 新工具加入名单，从动态 promptContext 读取名，不要求 list context 新增 run |
| [tools/registry.ts:12-35](../../../apps/agent-worker/src/runtime/tools/registry.ts) | list、启用检查、execute 已有 provider 分发 | 复用，不新建工具框架 |
| [builtin.ts:322-338](../../../apps/agent-worker/src/runtime/tools/providers/builtin.ts) `listTools` | Bash 环境 appendix 动态追加描述 | 为 git 增加动态仓库描述，复制定义 |
| [runner.ts:2621-2641](../../../apps/agent-worker/src/runtime/runner.ts) | 每轮 listTools，将 description/schema 交 AI SDK；生成可用工具快照 | 新工具沿用路径 |
| [runner.ts:1993-2016](../../../apps/agent-worker/src/runtime/runner.ts) | provider 前检查当前工具启用与快照 | 保留；新增 git 无隐式 bypass |
| [runner.ts:2067-2123](../../../apps/agent-worker/src/runtime/runner.ts) | provider 返回后构建文本/artifact，并写回；取消可能跳过写回 | git 只返回已脱敏数据；结果写回失败不得重执行 |
| [runner.ts:801,1975](../../../apps/agent-worker/src/runtime/runner.ts) 和 [agent.composition.ts:740-747](../../../apps/api/src/modules/agent/agent.composition.ts) | structured-result 名单两端维护，未含 git | 同步加入 git，使用共享结果 schema |

## 工具基础描述、设置与前端

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [agent.composition.ts:181-198](../../../apps/api/src/modules/agent/agent.composition.ts) `toolArgsSchema` | Bash timeout 默认 120 秒，模型 schema 未写最大值 | git 独立 schema 固定最大值，不改 Bash |
| [agent.composition.ts:477-499](../../../apps/api/src/modules/agent/agent.composition.ts) `toolDescription` | Bash 基础描述没有“自动 Git 认证”承诺 | 加 git 基础说明与迁移提示 |
| [settings.service.ts:788-807](../../../apps/api/src/modules/settings/settings.service.ts) `normalizeAgentTools` | 后端默认 bash/write/apply_patch/subtask；显式允许项名单 | git 加允许项，不加默认值，不改已有 profile |
| [agentTools.ts:3-47](../../../apps/web/src/features/settings/components/agentTools.ts) | 前端有默认、可配置列表、label 映射 | 加 Git 可选项和标签，不改默认列表 |
| [agentTools.test.ts](../../../apps/web/src/features/settings/components/agentTools.test.ts) | 前端有名单、默认值、label 测试 | 更新允许项与“默认不启用”测试 |
| [zh-CN.ts:1092](../../../apps/web/src/shared/i18n/locales/zh-CN.ts) | Agent 工具标签集中在设置语言区 | 同步中英文 Git 标签与认证迁移说明 |

## 最新仓库名与缓存

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [agent-run-context.ts:10-41](../../../apps/api/src/modules/agent/agent-run-context.ts) | 入队名来自登记记录，独立安全过滤去重 | 复用登记名来源概念，不把入队快照作为最新列表 |
| [workspaceRepoDirNames.ts:3-36](../../../apps/agent-worker/src/runtime/workspaceRepoDirNames.ts) | Worker 入队 normalizer 最多保留 100 项 | 新动态名不调用此截断逻辑；保留入队用途 |
| [workspace.store.ts:180-209](../../../apps/api/src/modules/workspaces/workspace.store.ts) | `listWorkspaceRepos` 按 Workspace 与 rowid 读取；可按 dirName 查登记 | 新动态投影与执行检查的数据源 |
| [db/schema.ts:289-301](../../../apps/api/src/infra/db/schema.ts) | 同 Workspace dirName 唯一；Repo/WorkspaceRepo 是既有实体 | 不新增名称表或业务表 |
| [agent-api-read.ts:282-309](../../../packages/shared/src/internal-contracts/agent-api-read.ts) | prompt context schema 包含 tools，但没有动态 repo 字段 | 加必填 workspaceRepoNames |
| [read-side-application.ts:80-115](../../../apps/api/src/modules/agent/read-side/read-side-application.ts) | prompt context 先检查 Workspace/session/run 归属 | 动态字段走受保护的当前运行路径 |
| [prompt-context-projector.ts:52-86](../../../apps/api/src/modules/agent/read-side/prompt-context-projector.ts) | 动态 resolve 与按 run 静态 tools 合并 | 新字段来自动态读取，不能放 assembleStatic |
| [run-prompt-static-cache.ts:1,25-43](../../../apps/api/src/modules/agent/prompt/run-prompt-static-cache.ts) | 30 分钟访问续期、按 run 缓存，不是固定时间必刷新 | 不用它缓存仓库成员 |
| [prompt-static-assembler.ts:74-106](../../../apps/api/src/modules/agent/prompt/prompt-static-assembler.ts) | baseline 为 read/skill；profile tools 形成静态定义 | git 按 profile 启用；动态说明在 Worker 加 |
| [agent.composition.ts:1727-1741](../../../apps/api/src/modules/agent/agent.composition.ts) | 装配 projector 依赖 | 接入每轮登记名读取器 |
| [agent-worker.routes.ts:559-575](../../../apps/api/src/modules/agent/routes/agent-worker.routes.ts) | prompt context 内部鉴权和共享 response schema | 更新 response 校验及 fixture |

## Bash 旧链路及退出范围

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [builtin.ts:120-217](../../../apps/agent-worker/src/runtime/tools/providers/builtin.ts) | tokenizer 与远端子命令白名单扫描 | 删除，不搬到新工具 |
| [builtin.ts:397-490](../../../apps/agent-worker/src/runtime/tools/providers/builtin.ts) | Bash 命中后 prepare，extraEnv 注入，finally cleanup | 删除认证分支，保持普通 Bash 执行和结果行为 |
| [apiClient.ts:284-296,356-357](../../../apps/agent-worker/src/runtime/apiClient.ts) | Bash prepare response 局部类型，RPC policy=excluded | 删除旧类型/方法项，新 RPC 使用共享契约和有界 policy |
| [apiClient.ts:1024-1045](../../../apps/agent-worker/src/runtime/apiClient.ts) | 唯一旧 prepare/cleanup client 方法 | 删除 |
| [apiClient.test.ts:724-725](../../../apps/agent-worker/src/runtime/apiClient.test.ts) | 测试将旧 Git-env RPC 列为 excluded | 移除旧项，测试新 policy 和无重试 |
| [git-env.routes.ts:15-89](../../../apps/api/src/modules/git-env/git-env.routes.ts) | 旧 schema 在路由内，输入任意 cwd/purpose | 旧路径退出；新端点不接受 cwd/purpose |
| `apps/api/src/modules/git-env/git-env.service.ts:58-103`（历史路径，旧 service 已删除） | 只读 terminalCredentialId；无凭证 none/null lease | 替换成登记仓库 lease v2 准备，不保留 Bash fallback |
| `apps/api/src/modules/git-env/git-env.service.ts:207-220`（历史路径，旧 service 已删除） | cleanup 有路径前缀检查、无 run/lease ownership | 新 release 加 ID/所有权/物理根检查 |

## 执行层与诊断

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [bash.ts:18-38](../../../apps/agent-worker/src/runtime/bash.ts) | Bash 合并 process.env/extraEnv，启动 login Shell、stdin ignore | Bash 保留；git 单独过滤 AWB_* 并直接 spawn |
| [builtin.ts:25,432](../../../apps/agent-worker/src/runtime/tools/providers/builtin.ts) | timer 上限 2147483647ms，Bash 120s 默认 | git 产品默认120秒、1..3600秒；Node上限只作防御，Bash不改 |
| [bash.ts:80-159](../../../apps/agent-worker/src/runtime/bash.ts) | 普通数值组/taskkill，200ms强杀宽限，无强OS身份 | 新Git持有child/连续数值组跟踪，首次ESRCH后封闭信号；复用竞态/zombie-only保守边界，不把taskkill成功当证据 |
| [bash.ts:237-254](../../../apps/agent-worker/src/runtime/bash.ts) | 父exit后的stdio销毁兜底并不证明同组后代停止 | 新Git独立TERM/KILL与组不存在确认，后代不持stdio也不能漏收尾 |
| [apiClient.ts:439-461](../../../apps/agent-worker/src/runtime/apiClient.ts) | RPC支持abortSignal、配置deadline与请求deadline取较小值 | 仅prepare/release，prepare传run signal，release独立deadline，无运行状态报告 |
| [config/env.ts:53-55](../../../apps/agent-worker/src/config/env.ts) | 默认内部 RPC 15000ms | 新 RPC 沿用配置，不能无限等待 |
| [toolErrorCapture.ts:129-143](../../../apps/agent-worker/src/runtime/toolErrorCapture.ts) | 创建capture时无损snapshot args | Git先投影，正常tool_call参数不变 |
| [toolErrorCapture.ts:160-180](../../../apps/agent-worker/src/runtime/toolErrorCapture.ts) | 事件detail与writeback output可无损snapshot | capture内部也对Git detail/output投影，防后续回流 |
| [runner.ts:1955-1966](../../../apps/agent-worker/src/runtime/runner.ts) | outputBase含args，recordWritebackAttempt接收output | Git running/completed/失败output采用同一安全投影 |
| [runner.ts:2115-2133](../../../apps/agent-worker/src/runtime/runner.ts) | completed输出及item/debug request可带args | 写回与item request分别接线，成功分支同样覆盖 |
| [runner.ts:2350-2371](../../../apps/agent-worker/src/runtime/runner.ts) | 禁用pending分支构造output.args、capture、event与writeback | provider未执行仍须四入口投影 |

## 通用认证与租约回收

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [gitEnv.ts:43-99](../../../apps/api/src/infra/git/gitEnv.ts) | 构造代理/CA；绑定不回退；未绑定按 host/kind 选择 | 保持单一权威算法；新工具失效绑定显式失败 |
| [credentials.store.ts:106-155](../../../apps/api/src/modules/credentials/credentials.store.ts) | 同 kind 默认优先、其次最新；无同 kind 不跨协议 | 必须按真实规则描述和测试，不误写成“仅默认凭证” |
| [gitEnv.ts:102-157](../../../apps/api/src/infra/git/gitEnv.ts) | 独立临时目录、askpass/key、cleanup closure | 加可信 artifactDir/有限元信息，异常回收；不复制认证实现 |
| [askpass.ts:1-23](../../../apps/api/src/infra/git/askpass.ts) | HTTPS 读取 token 文件首行、去 CR；旧 env token fallback | 复用，新工具不注入 token 内容；脱敏覆盖实际有效 token |
| `apps/api/src/modules/git-env/git-env.service.ts:109-132`（历史路径，旧 service 已删除） | v1 TTL 最少15分钟、timeout+5分钟、最多6小时 | v2 TTL=max(15分钟,timeout+5分钟)，常规最多65分钟；停止未确认例外持有 |
| [git-env.janitor.ts:7-8,18-89](../../../apps/api/src/modules/git-env/git-env.janitor.ts) | 旧根、过期清扫、坏meta30分钟mtime、启动/5分钟，当前无v2转换协议 | v1保留；v2有效stopped才清扫，与release同lease短临界区重读；坏meta/未确认不回收，不误删v2整棵 |
| [git-env.module.ts:6-8](../../../apps/api/src/modules/git-env/git-env.module.ts) | 模块同时注册旧路由和 janitor | 替换路由，不删除 janitor |
| [createApp.ts:23](../../../apps/api/src/app/createApp.ts) | API 注册 git-env 模块 | 更新模块注册，不丢清扫启动 |

## 改造前须保留的入口及并发边界

| 文件/符号 | 改造前事实 | 设计时目标处理（实施已完成） |
|---|---|---|
| [git.service.ts:590-604](../../../apps/api/src/modules/git/git.service.ts) | 登记目标、Workspace根下路径与登记路径一致检查 | 复用规则，新内部入口增加当前运行归属 |
| [git.service.ts:854-892](../../../apps/api/src/modules/git/git.service.ts) | 界面 commit 独立身份处理 | 保留；原生工具不自动写身份 |
| [git.service.ts:906-947,971-1018](../../../apps/api/src/modules/git/git.service.ts) | API push/pull 使用通用 builder，pull 固定 ff-only | 保留；原生工具不继承业务参数限制 |
| [terminal.service.ts:175-195](../../../apps/api/src/modules/terminals/terminal.service.ts) | 终端认证仍使用 terminalCredentialId | 不删除开关/绑定/长期终端认证 |
| [workspace.service.ts:420-443](../../../apps/api/src/modules/workspaces/workspace.service.ts) | attach 在gate/Workspace锁内，可改变登记成员 | 下一轮描述刷新 |
| [workspace.service.ts:513-548](../../../apps/api/src/modules/workspaces/workspace.service.ts) | detach 在gate/Workspace锁内先删目录后删登记；当前没有新租约busy检查 | 新增确定性在途lease检查，不按命令分类 |
| [workspace.service.ts:614-648](../../../apps/api/src/modules/workspaces/workspace.service.ts) | Workspace删除先fence/收敛run，再取消并等待Worker | 物理删除前新增lease停止保护，不能只等待session idle |
| [runner.ts:1800-1822](../../../apps/agent-worker/src/runtime/runner.ts) | 会话取消/等待空闲不检查同组后代 | executor确认与API持久化保护独立于session空闲 |
| [agent.worker-manager.ts:332-388](../../../apps/api/src/modules/agent/agent.worker-manager.ts) | stop/terminate确认Worker child退出，不证明detached Git组停止 | 运维不能只看Worker PID退出 |
| [agent.module.ts:67-73,114-116,129-131](../../../apps/api/src/modules/agent/agent.module.ts) | Worker禁用仍启动本地fallback、pending Workspace删除恢复及调度 | 正常启动先装lease guard；维护helper不启动这些模块 |
| [config/env.ts:157,184](../../../apps/api/src/config/env.ts) | AWB_AGENT_WORKER_ENABLED控制受管理Worker，并非全局执行暂停 | 同机CLI不启动API/fallback/调度；禁用Worker不等于建立维护窗口 |
| [config/env.ts:162,185](../../../apps/api/src/config/env.ts) | 正常API内部token由配置指定或随机生成 | Worker RPC鉴权不变；CLI直接服务调用，不生成/获取/传递token，不实例化完整API |
| [workspace-lifecycle-coordinator.ts:6-11,45-49](../../../apps/api/src/infra/locks/workspace-lifecycle-coordinator.ts) | API内admission gate，不跨进程、不替代细粒度锁 | prepare/detach短边界复用，不能宣称包住全部Worker副作用 |
| [workspaceRepoLock.ts:3-7,27-36](../../../apps/api/src/infra/locks/workspaceRepoLock.ts) | API内仓库互斥 | 不把它当Worker/终端全局锁 |
| [repoLock.ts:3-22](../../../apps/api/src/infra/locks/repoLock.ts) `withRepoLock` | 按字符串键串行、finally释放并只清除当前尾部的进程内Promise锁 | 复用逻辑键`git-env:v2:<leaseId>`串行化release/janitor；CLI依停机独占，不加跨进程锁 |

## 设计时计划新增位置（实施已完成）

以下保留原规划，不是待开发清单；当前目标文件已落地，定位见下一节。

- `packages/shared/src/internal-contracts/agent-git-tool.ts`：输入、结果及仅prepare/release的共享契约；结果无报告失败分支，release无数值PGID/远程维护字段，通过内部facade导出。
- `apps/agent-worker/src/runtime/git.ts`：原生Git executor、环境过滤、取消/结果；其具体局部helper可按独立可测职责拆分，但不抽象整个Bash。
- 对应的 `git.test.ts`、Git provider/动态描述测试、API租约和共享契约测试：具体文件名称以现有测试分组规则落地。
- `git-env`原服务/路由升级为仓库租约语义；release与janitor共用服务内短临界区/安全删除，stopped单调、不复活目录，不另建认证服务。
- `apps/api/src/maintenance/git-lease-recovery.ts`及根脚本`maintenance:git-lease`：原计划新增、现已落地inspect/release同机CLI，直接调用同一服务，不启动HTTP/token/API维护模式或执行/删除恢复；运维覆盖证明非代码现有能力。

## 当前目标实现定位（已落地）

下表定位当前生产实现；逐项 AC、实际测试与尚未闭环的部署条件以 [evidence.md](evidence.md) 为准。旧 `git-env.service.ts` 已删除，仓库 prepare 与租约状态分别由 repo-service / lease 承担，没有复制旧服务或保留 Bash fallback。

| 当前文件／符号 | 已落地职责 |
|---|---|
| [agent-git-tool.ts:19](../../../packages/shared/src/internal-contracts/agent-git-tool.ts#L19) `GitToolInputSchema`；同文件 `GitToolResultSchema` / `PrepareRepoGitEnvResponseSchema` | Git 输入、结果、prepare/release 的权威共享契约 |
| [prompt-context-projector.ts:57](../../../apps/api/src/modules/agent/read-side/prompt-context-projector.ts#L57)；[builtin.ts:237](../../../apps/agent-worker/src/runtime/tools/providers/builtin.ts#L237) | 每轮读取最新登记名，动态生成 Git 描述，不依赖入队截断快照 |
| [git-env.routes.ts:27](../../../apps/api/src/modules/git-env/git-env.routes.ts#L27) `registerGitEnvRoutes`；[git-env.repo-service.ts:73](../../../apps/api/src/modules/git-env/git-env.repo-service.ts#L73) `prepareRepoGitEnvLease` | 内部认证、运行归属与登记仓库校验、唯一认证 builder、租约准备 |
| [git-env.lease.ts:211](../../../apps/api/src/modules/git-env/git-env.lease.ts#L211) `releaseRepoGitEnvLease`；[git-env.lease.ts:325](../../../apps/api/src/modules/git-env/git-env.lease.ts#L325) `cleanupExpiredRepoGitEnvLeases` | owner release、同 lease 临界区、单调状态与安全回收；保留停止未确认保护 |
| [git-env.janitor.ts:30](../../../apps/api/src/modules/git-env/git-env.janitor.ts#L30) `cleanupExpiredGitEnvLeases` | 既有残留清理与新租约回收接线，不把兼容回滚条件当成已验收 |
| [git.ts:255](../../../apps/agent-worker/src/runtime/git.ts#L255) `executeGitTool`；[git.ts:33](../../../apps/agent-worker/src/runtime/git.ts#L33) `runGitProcess` | 原生 argv、环境过滤、输出保护、进程组监督及确认后的释放 |
| [gitErrors.ts:39](../../../apps/agent-worker/src/runtime/gitErrors.ts#L39) `GitToolError`；[runner.ts:2186](../../../apps/agent-worker/src/runtime/runner.ts#L2186) | 严格响应校验后保留最新安全名单，完整 JSON 模型错误写回；不自动纠正或重试 |
| [gitDiagnostic.ts:33](../../../apps/agent-worker/src/runtime/gitDiagnostic.ts#L33) `projectGitDiagnostic`；[toolErrorCapture.ts:145](../../../apps/agent-worker/src/runtime/toolErrorCapture.ts#L145) | 额外诊断维持安全投影，不复制完整 argv／名单／原始 payload |
| [gitEnv.ts:75](../../../apps/api/src/infra/git/gitEnv.ts#L75) `buildGitEnv` | 复用既有权威认证实现；旧 Bash 专用 service 已移除 |
| [git-lease-recovery.ts:79](../../../apps/api/src/maintenance/git-lease-recovery.ts#L79) `runGitLeaseRecoveryCli`；[git-env.recovery-policy.ts:27](../../../apps/api/src/modules/git-env/git-env.recovery-policy.ts#L27) | 已实现同机 inspect/release 与保守机械确认；真实停机、受管范围覆盖及重启窗口仍需部署证据 |

## 代码审查警示

- 看到复制 `getCredentialWithSecret`、host选择、askpass生成到第二个工具实现，应检查是否违反单一权威认证规则。
- 看到 `spawn("bash", ...)`、`exec("git ...")`、args join、args trim，应直接对照原生argv要求。
- 看到最新名来自 `ctx.run.workspaceRepoDirNames`、静态tools缓存或磁盘扫描，应拒绝作为最新授权实现。
- 看到Bash仍有prepare/cleanup或旧端点继续接受cwd，应检查是否退场不完整。
- 看到成功结果中含env/lease路径/完整argv、runner capture收到raw输出，应检查输出安全边界。
- 看到任意取消、写回重试或恢复逻辑再次调用executor，应检查重复副作用。
- 看到父exit/stdio close/Worker退出/session idle被当作组停止、未确认TTL自动解锁、v2坏meta被兜底删除，应检查默认保护闭环。
- 看到维护仅设置Worker=false却启动正常API、公开租约删除或手工整目录清空，应拒绝作为安全恢复流程。
- 看到只原子写meta却在同lease锁外做release/janitor转换、异步交付后修改状态或重建不存在目录，应检查转换不变量。
- 看到数值PGID/Worker实例被当作强OS身份、KILL被当作僵尸回收，或helper声称自动核实全部执行/外部supervisor静止，应核对残余风险与人工部署证据边界。
