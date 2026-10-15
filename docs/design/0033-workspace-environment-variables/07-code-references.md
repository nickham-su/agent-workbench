# 相关代码引用与改动接点

## 引用口径

- 以下路径均相对仓库 `agent-workbench/`，除明确标记的工作区级原型。
- 引用来自文档编写时实际只读检查，不读取 `.env.local`、实际主密钥、token 或凭据文件。
- 行号会随其他开发变化；优先按路径和符号定位。下列行号保留设计期定位参考，可能已移动；新增实现按本章实际路径／符号及测试定位，不据旧行号推断当前行为。
- 需求与验收映射见[README矩阵](README.md#需求与验收导航矩阵)。

## C-SHARED：契约与规则出口

| 当前文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `packages/shared/src/contracts/workspaces.ts` | Workspace记录和基础配置契约 | 不把环境值加入WorkspaceDetail/Record |
| `packages/shared/src/index.ts:1–16` | 公共契约集中导出 | 导出新增公共环境契约和policy |
| `packages/shared/package.json:exports` | 内部契约显式subpath出口，不是通配 | 新内部契约显式增加exports |
| `packages/shared/src/internal-contracts/agent-api-read.ts` | 工具定义inputSchema传输，不是独立Bash env参数 | 不扩模型工具参数 |

## C-DB：基础实体与删除约束

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/infra/db/schema.ts:237–340`，`createBaseSchema` | 非Agent Workspace、terminal、settings等基表幂等建立 | 新配置表和独立attempt表在非Agent基础增量建立 |
| 同文件 `:266–283` | Workspace与deletion表 | 配置FK cascade、删除状态检查 |
| 同文件 `:304–313` | terminal→Workspace为ON DELETE RESTRICT | 不误认为终端自动cascade |
| 同文件 `:40–65,208–235`，`ensureTerminalAuthCleanupIntentSchema` | Git artifact enum/check与terminal FK RESTRICT | 不往此enum混env/status |
| 同文件 `:1128–1145`，`initSchema` | 先分类，受支持分类才createBaseSchema；current也执行基表创建 | 不触发Agent重建，不绕过unsupported |
| `apps/api/src/infra/db/db.ts:10–21` | 同步better-sqlite3，busy_timeout、FK和WAL | 支持同步读缓存/事务，保持FK开启 |
| `apps/api/src/modules/scheduled-tasks/scheduled-task.store.ts:78–83,100–162` | 事务检查Workspace deletion，按条目CRUD | 借鉴风格，不复制任务语义 |

## C-CRYPTO：主密钥与值加密

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/main.ts:28,37–45,68–89` | 启动无条件加载主密钥并传AppContext | 复用，不新建独立密钥系统 |
| `apps/api/src/infra/crypto/credentialMasterKey.ts:43–68` | 环境／已有文件／自动生成；非法配置失败 | 不读取实际值，沿用备份责任 |
| `apps/api/src/infra/crypto/secretBox.ts:11–37` | 同步AES-256-GCM加解密字符串 | 加密包括空串的value；缓存miss同步解密 |

## C-AUTH：鉴权与错误

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/app/auth.ts:25–48,50–72` | internal路径始终内部认证；公共网页Cookie鉴权 | 专用内部GET不因网页登录关闭而开放 |
| `apps/api/src/app/createApp.ts:28–37,59–74` | Fastify当前默认实例，先鉴权后业务模块；错误处理 | 不全局改AJV，固定错误不回显原body |
| `apps/api/src/app/errors.ts:1–14` | HttpError支持statusCode/code | 新错误按既有格式 |
| `apps/api/src/modules/credentials/credentials.routes.ts:30–41` | 专用敏感响应设置no-store先例 | 环境明文响应no-store |
| `apps/api/src/modules/workspaces/workspaces.routes.ts:48–65,93` | tab-state在preValidation严格检查body键和类型 | 环境请求在AJV变形前严格校验 |

## C-API：Workspace环境接口

环境变量 CRUD／内部只读接口已在 `workspace-environment.routes.ts` 实现，由 Workspace 模块注册；共享 schema、严格 preValidation 和 no-store 复用正式契约。相关接点：

- `apps/api/src/modules/workspaces/workspaces.routes.ts`：公共Workspace路由与共享schema使用。
- `apps/api/src/modules/workspaces/workspace-context.service.ts:24–25,34–39,71–95`：Workspace级配置先例，但它使用settings JSON，不能直接保存明文秘密。
- `apps/api/src/modules/settings/settings.store.ts:3–29`：JSON upsert没有加密／revision，不选作本需求条目存储。
- `apps/api/src/modules/scheduled-tasks/scheduled-task.routes.ts:48–68`：按条目CRUD／启停风格。

## C-CACHE：实例缓存

- `apps/api/src/app/context.ts`：db、credentialMasterKey 及 `workspaceEnvironment` 实例依赖；LRU 的权威实现位于 `workspace-environment.service.ts`。
- `apps/api/src/modules/settings/settings.service.ts:127,234–245`：现有Map缓存清理风格；其过期／全局作用域不照搬。
- 新环境服务必须实例绑定db，持有自己的容量128 LRU；命中只检查内存fence，不每次getWorkspace查库。

## C-WORKSPACE：生命周期与删除

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/infra/locks/workspace-lifecycle-coordinator.ts:29–49` | withAdmission支持ALS重入；withMutation检查fence | 配置写/create用mutation；终端delete/reconcile/settle/聚合收敛共用admission，允许fence存在 |
| `apps/api/src/modules/agent/lifecycle/workspace-deleting-fence.ts:10–35` | 内存删除Set与assertWritable | 缓存命中拒读，最终失效后才release |
| `apps/api/src/modules/workspaces/workspaces.module.ts:8–12` | 路由注册前恢复durable deletion fence | 新路由在恢复后注册 |
| `apps/api/src/modules/workspaces/workspace-deletion.store.ts:23–54` | 单个／全部intent及失败记录 | 事务持久状态检查、重启拒读 |
| `apps/api/src/modules/workspaces/workspace.service.ts:606–633` | 删除先落intent再begin fence | 开始删除使缓存读失败 |
| 同文件 `:645–704` | 初始admission之后的终端处理及最终DB删除，随后end fence | 全部终端副作用接同WS admission；新attempt先收敛，最终提交后invalidate再end |
| 同文件 `:719–722` | 删除意图恢复与续作 | pending时保留拒读，不强删 |

## C-BASH：Worker 执行与工具定义

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/modules/agent/agent.composition.ts:181–200`，`toolArgsSchema` | bash公开参数command/workdir/timeout | 保持不新增env |
| `apps/agent-worker/src/runtime/tools/types.ts:35–43,61–72` | run含workspaceId及apiClient/signal | 使用权威run身份，沿用取消 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts`，bash分支 | 目录检查→读取Workspace快照→runBashCommand；没有Git lease | 保留外cwd与公开参数，不恢复已移除的bash项目鉴权 |
| `apps/agent-worker/src/runtime/bash.ts:12–38` | process.env与extraEnv合并，bash -lc，detached用于原取消 | 新最终env过滤AWB，不改公开参数或进程组 |
| `apps/agent-worker/src/runtime/bashTools.ts:70–76,112–118` | 无WS的工具探测也用helper | 仅AWB隔离，不注入Workspace |
| `apps/agent-worker/src/runtime/apiClient.ts`，`getWorkspaceEnvironment`/`publicMethodPolicies` | controlRead有界一次重试；共享响应及语义校验 | 每次env读取，无二级缓存，取消/失败不执行 |
| `apps/api/src/modules/agent/agent.worker-manager.ts:100–114,238–244` | Worker继承API并带AWB内部控制环境 | 只过滤任务子进程，不破坏Worker控制连接 |
| `apps/agent-worker/src/runtime/git.ts`、`apps/api/src/modules/git-env/git-env.repo-service.ts` | 原生Git独立执行及lease链 | 保留原有鉴权/网络；不注入Workspace环境、不让bash申请lease |

## C-TERMINAL：创建、连接与恢复

| 实际文件／符号 | 当前行为与不变量 |
|---|---|
| `apps/api/src/modules/terminals/terminal.service.ts`，`TerminalRuntimeOperations` | 文件准备、状态等待及精确清理可窄注入；new-session presence 保持 exists／not_found／indeterminate 区分 |
| 同文件，`createTerminal` | 同 Workspace mutation 包含 creating 落库、snapshot、可信握手、presence、激活及补偿；Workspace 字面值不经过旧 envPairs sanitizer |
| 同文件，`buildTerminalNetworkEnvPairs`／`buildTerminalGitEnv` | 保持既有 cwd、网络／CA／Git 系统层，转入受保护 snapshot，不把值拼入 argv |
| 同文件，`stopTerminalSession`／`cleanupTerminalEnvironmentAttempts`／`settleTerminalAfterSessionStopped` | 共同 admission 内重读并收敛；允许 deletion fence 存在，未知 presence 或 env pending 保留定位 |
| 同文件，`deleteTerminal`／`reconcilePendingTerminals`／`reconcileWorkspaceActiveTerminals` | 候选入 admission 后重新读 terminal／attempt／presence，不把 gate 外旧 not_found 当授权；保留既有 Git-only 兼容 |
| 同文件，`getTerminalForAttachment`；`apps/api/src/modules/terminals/terminal.ws.ts` | 连接前短 admission 重读／probe／必要收敛，真实 attach 不长期持锁；pty 客户端过滤 AWB |
| `apps/api/src/modules/agent/agent.module.ts`／`agent.worker-manager.ts`（同目录） | 每代 Worker ready 都可能编排恢复；不能假设恢复只在启动时执行一次 |
| `apps/api/src/modules/terminals/terminal.store.ts` | creating／errored 不作为正常 active 列表发布 |
| `apps/api/src/infra/tmux/session.ts`／`tmuxExec.ts`（同目录） | new-session 采用固定 launcher 参数；客户端过滤 AWB／TMUX，不写全局 tmux 环境或更新旧 shell |
| `apps/api/src/modules/terminals/terminal-auth-cleanup-intent.store.ts`／`terminal.gitAuth.ts`（同目录） | Git 文件继续走原业务定位及 SSH 一类／HTTPS 两类约束，不混入 env/status |

## C-FS：可信文件原语

- `apps/api/src/infra/fs/secure-directory.ts:17–20`：Linux/macOS目录fd能力，不支持时fail-closed。
- 同文件 `:41–103`：拒软链、目录句柄、安全子目录、身份复核。
- 同文件 `:215–241,248–308`：私有删除槽、replacement保留和精确文件移除。
- 同文件`:132–175,369–371`：scope长度/编码与securePrivateSlotIdentity解析；新协议ep/es/ed稳定scope满足现有格式，但必须再匹配durable locator与实际身份。
- 同文件`:248–289`的cleanupSecureRetiredFiles不持本attempt durable locator且会泛判marker，不能作为新协议扫描授权；`:319–366`内部递归退休项清理不用于新空目录收敛。
- 此文件已新增窄函数 `removeRetiredEmptySecureDirectory`；实际恢复测试位于 `terminal-env-launch.test.ts`。仅精确身份且无后代的目录允许rmdir，不能递归。
- 同文件 `:504–563`：树清理与同步身份检查；新协议不得用递归树删除代替未知对象授权。
- `apps/api/src/modules/agent/artifact/safe-file-io.ts:50–55`：0644/O_TRUNC范式不适合秘密snapshot，不能直接复用。

## C-LAUNCHER／C-BUILD：构建与部署

| 文件／位置 | 当前事实 | 本次接入 |
|---|---|---|
| `apps/api/src/modules/analytics/analytics-supervisor.ts:70–84` | 明确子execArgv、import.meta.url邻近source/dist | 固定入口参考，不继承inspect/env-file |
| `apps/api/src/modules/agent/agent.plugin-host-manager.ts:40–57` | 生产dist缺失明确错误；源码模式显式入口 | 不自动下载或临时复制launcher |
| `apps/api/tsconfig.json:3–17` | src→dist tsc | launcher.ts自动产JS，不能假设mjs复制 |
| `apps/api/package.json:6–17` | dev tsx；build清dist后tsc；start node dist | 区分dev和prod依赖 |
| `README.md:194–198` | Node20/22及tmux前提 | 不依赖execve，双版本手动结果 |
| `Dockerfile:3,30–36,72–80` | Node22构建，prune devDependencies，复制API目录 | dist入口必须随构建存在，生产不依赖tsx |
| `package.json:9–16` | 现有build/typecheck/test工作区脚本 | 按实施计划运行，不编造脚本 |

## C-WEB：工具与列表

- `apps/web/src/features/workspace/types.ts:3`：ToolId联合类型。
- `apps/web/src/features/workspace/views/WorkspaceLayout.vue:152–164,187–269`：工具ID／元信息／view注册。
- 同文件 `:331–363,448–479,485–546`：完整Record默认值、顺序及老Dock缺省恢复，新增工具须全部补齐。
- `apps/web/src/shared/api/api.ts:448–455,516–534`：Workspace配置／terminal API封装范式，不把值并入普通Workspace响应。
- `apps/web/src/shared/i18n/locales/zh-CN.ts`、`en-US.ts`：正式文案。
- 工作区级 `.prototype/workspace-environment.html:177–227`：最终标题、明文、规则、直接保存交互；仅原型不是正式数据来源。

## C-HARNESS：手动验收隔离

- 已新增 `apps/api/tests/manual/terminal-environment-harness.mjs`，支持 source/dist、默认手动 UI／`--verify`、独立 Worker、hold 及四类故障；配套固定 Worker fixture 和两组显式测试。
- `apps/api/src/app/createApp.ts:27–37,87–96`与`apps/api/src/app/context.ts:9–58`支持显式测试ctx创建；harness不用main/env-loader，独立DB/密钥/loopback端口与.tmp-tests数据目录。
- `apps/api/src/modules/agent/agent.module.ts:139–144`在注册时启动Worker；`apps/api/src/modules/agent/agent.worker-manager.ts:219–234`按npm dev标记／argv后缀选择source/dist。harness必须在createApp前隔离env并选好API origin，bind失败停止Worker；生产模式缺dist不借tsx。
- `apps/api/src/infra/tmux/tmuxExec.ts:24–27`和`apps/api/src/modules/terminals/terminal.ws.ts:128–134`当前都按PATH启动tmux，可用测试进程PATH wrapper使真实API动作和pty attach命中同隔离socket。
- 生产未来若改绝对tmux路径，harness必须窄测试注入适配；不得静默落默认socket。命令、预检和清理权威说明见[手动harness](05-acceptance-and-review.md#测试专用-harness-与-socket-隔离)。

## C-TEST：测试接点

- `apps/api/scripts/run-tests.mjs:24–48`：扫描src和integration命名，worker单独组；新测试必须被发现。
- `apps/api/scripts/verify-test-gate.mjs`：现有测试gate，最终API测试不能跳过。
- `apps/api/src/modules/terminals/terminal.service.test.ts:59–78`：runtime fake及creating/active测试。
- 同文件 `:191–241,265–381`：Git cleanup、IO/replacement/root恢复及逻辑删除兼容。
- 同文件 `:404–506`：明确fallback、response-loss、orphan和激活收尾失败；新增握手不能删除这些断言。
- `apps/api/src/app/auth.integration.test.ts`：现有鉴权集成。
- `apps/agent-worker/src/runtime/tools/providers/*.test.ts`：内置工具执行测试位置。
- `apps/web/src/features/workspace/tools/terminal/TerminalView.component.test.ts`：现有正式工具组件测试范式。
- `.prototype/workspace-environment.test.mjs`：仅原型DOM测试，不能代替正式UI或真实终端验收。

## 实际新增位置

下列文件已实现。阶段审查状态和真实执行范围见[实施与验证记录](08-implementation-and-verification.md)。

| 实际新增文件 | 职责 |
|---|---|
| `packages/shared/src/contracts/workspace-environment.ts` | 公共实体及CRUD契约 |
| `packages/shared/src/workspace-environment-policy.ts` | 唯一校验／保留集合／额度规则 |
| `packages/shared/src/internal-contracts/workspace-environment.ts` | 内部只读env响应；需显式subpath export |
| `apps/api/src/modules/workspaces/workspace-environment.store.ts` | 按Workspace条目SQL存取 |
| `apps/api/src/modules/workspaces/workspace-environment.service.ts` | 加密／事务业务／实例缓存／失效 |
| `apps/api/src/modules/workspaces/workspace-environment.routes.ts` | 公共及内部路由、严格校验、no-store |
| `apps/api/src/modules/terminals/terminal-env-launch-attempt.store.ts` | 独立attempt定位与阶段 |
| `apps/api/src/modules/terminals/terminal-env-launch.protocol.ts` | payload/status/locator协议与固定错误 |
| `apps/api/src/modules/terminals/terminal-env-launch.files.ts` | fd 锚定、定位校验、文件与退休槽精确清理 |
| `apps/api/src/modules/terminals/terminal-env-launch.ts` | 安全准备、等待、精确清理、恢复能力 |
| `apps/api/src/modules/terminals/terminal-env-launcher.ts` | 固定Node入口、目标shell及状态写入 |
| `apps/web/src/features/workspace/tools/environment-variables/EnvironmentVariablesToolView.vue` | 正式配置工具 |
| `apps/api/tests/manual/terminal-environment-harness.mjs` | 测试专用真实API／pty同socket隔离及故障注入；非产品入口 |
| `apps/api/tests/manual/terminal-environment-worker-fixture.mjs` | 独立进程执行 built Worker 固定 bash 工具调用及内部鉴权读取 |
| `apps/api/tests/manual/terminal-environment-harness.test.mjs` | 参数、引用与项目边界纯函数测试 |
| `apps/api/tests/manual/terminal-environment-harness.lifecycle.test.mjs` | 真实 loader/占用端口拒绝与手动模式 SIGINT 清理 |

新增测试位置与执行命令见[实施计划](06-implementation-plan.md#实际聚焦测试位置)。其中包含 Worker `bash.test.ts`、终端 `terminal.workspace-environment.test.ts`、协议／启动测试及正式 Vue 组件测试；空目录 helper 覆盖归入 launch 测试，没有单独 env-retired 测试文件。
