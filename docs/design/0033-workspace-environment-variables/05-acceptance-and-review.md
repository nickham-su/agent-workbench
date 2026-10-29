# 验收标准与代码审查

## 验收分层

- 自动测试验证业务、契约、缓存、文件授权和生命周期分支；mock/happy-dom 结果不能替代真实终端运行时结果。
- 用户已接受先实施，真实 TTY、信号、Node 20/22 和冷／热 tmux 项可在开发后手动执行。不要求先做 PoC 才能开发。
- 所有测试只用虚构值，例如 `prototype-placeholder-not-a-real-secret`；不得读取真实凭据、打印完整进程环境或为观察而关闭内部鉴权。
- 以下 A-*、M-* 是验收类别 ID，不是实际已执行记录。实际命令、版本、结果及尚未执行项见[实施与验证记录](08-implementation-and-verification.md)。

## 自动测试准备

- 配置单测使用临时数据库、独立 AppContext、测试主密钥和两个 Workspace；测试数据只放测试目录。
- 包含系统基础值、已启用覆盖、停用、空串、多行、大小写代理和特殊对象键。
- 捕获安全错误与日志，断言虚构标记值不进入错误、SQL 日志、普通 Workspace 响应、prompt、明文之外的持久数据。
- 缓存测试对 SQL 查询和解密入口计数；不能仅靠延时或字符串搜索推断命中。
- 终端测试扩展现有 `TerminalRuntimeOperations` 的文件准备、等待状态、清理注入点。fake `newSession` 不得因空实现就隐式代表 shell spawn 成功；成功测试必须显式给可信握手状态和 presence。
- 新测试文件放入既有 runner 可发现的位置；API 普通 `.test.ts`、`.integration.test.ts` 分组见[测试接点](07-code-references.md#c-test测试接点)。

## 自动测试矩阵

### A-VALIDATION：名称、值与限额

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 合法名称、大小写不同名称；空名、数字开头、空格、非 ASCII | 合法独立保存；非法 400，不自动修正 | trim 后接受、大小写合并或错误回显值 |
| 逐一配置 AWB 前缀及权威 Git 集合；另配置 GIT_AUTHOR_NAME/GIT_SSL_CAINFO | 保留项拒绝，普通项允许 | 黑名单漏项或禁止全部 GIT_* |
| 写空串、前后空格、CR/LF、中文、引号、`$PATH`、`$(...)` | 原样往返，不执行表达式 | 丢空串、换行变空、自动展开 |
| value/remark 含 NUL、null、错误类型、unknown 字段、空 PATCH | 固定 400，无写入 | 静默滤掉后保存或默认填空 |
| value/remark孤立UTF-16 high/low；合法emoji／组合字符及字节上限 | 非法400；合法原样、不normalize；持久非法配置500 WORKSPACE_ENV_INVALID_CONFIG | 丢失代理项后写入、browser共享规则依赖Buffer或故障当空配置 |
| 名称 128／129；备注 UTF-16 160／161，包括代理对字符 | 上限允许，超限拒绝；前后端一致 | 只按 JSON Schema 字符数导致分歧 |
| 值 UTF-8 16,384／16,385 字节，多字节字符构造边界 | 按字节判定 | 使用 JS.length 或截断 |
| 128／129 条；总编码 65,536／65,537 字节，含停用 | 恰好允许、超限拒绝，事务不部分提交 | 停用绕过额度、启用后才暴露超限 |
| 普通键 `__proto__`、constructor、toString | 作为 own-key 原样传递，不污染原型 | 原型变化、假命中或键丢失 |

### A-STORE：存储与迁移

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 已有受支持数据库运行 schema 初始化两次 | 新表幂等建立，已有 Workspace/Repo/Agent/任务记录不变 | Agent 重建、数据清空、重复初始化失败 |
| 不支持的 Agent schema 分类 | 保持原有 fail-closed | 为配置功能绕过分类 |
| 保存虚构值与空串，直接检查目标表和数据库相关测试输出 | DB 只有密文，可用测试密钥恢复原值 | 明文 value 列、值出现在日志 |
| 违反 FK／唯一约束／enabled check | DB 拒绝；API 安全映射错误 | 跨 Workspace 记录或非布尔状态落库 |
| 删除 Workspace 的正常事务 | 配置 cascade；其他 Workspace 保留 | 全表清空或漏删 |
| 存在 terminal env pending | terminal RESTRICT 阻挡无授权删除；定位不丢 | 强删记录、关闭 FK 或删除配置时跳过生命周期 |

### A-AUTH：鉴权与泄漏边界

- 开启网页登录时，无 Cookie 公共接口 401；合法 Cookie 可读取自身工作台配置。
- 关闭网页登录时内部接口仍要求内部认证，错误／缺失认证均 401。
- 公共明文响应及内部 env 响应 `no-store`；普通 Workspace、工具定义、prompt 和 Dock 缓存无值。
- 各错误注入中虚构值、密文、完整 body、原始 spawn argv 不出现在 message 或日志。
- 失败判定：新增接口绕过现有鉴权、内部 token 进入 payload／目标 env、原始错误对象序列化泄密。

### A-API：按条目与并发

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 创建缺省字段，GET 列表，改名再 GET | remark 空、enabled true；createdAt/id 稳定排序 | 编辑重排或错默认 |
| 两 Workspace 同名；同 Workspace 并发同名 POST | 跨 Workspace 允许；同 Workspace 一条成功、一条 409 | 双条重名、跨 Workspace 唯一冲突 |
| 用 WS-A 路径读改删 WS-B 条目 ID | 404，不泄漏 B 内容 | 全局 id 查询后暴露／修改 B |
| 不同条目并发 PATCH | 两次修改都保留 | 整表覆盖丢更新 |
| 同条目部分 PATCH 并发；随后完整编辑提交 | 只改提交字段；重叠字段最后提交生效 | 隐式 CAS、更新未提交字段或错误版本假设 |
| PATCH 空串／false，单独启停，DELETE 重复 | 空串/false保留；第二次 DELETE 404 | 真值判断吞字段或重复删除假成功 |
| 事务中加密／DB 写失败，捕获缓存与记录 | 无部分写入、无成功响应 | 先更新 UI／缓存或部分提交 |
| 写事务已提交但响应丢失 | 缓存已失效；重读能确认结果，不自动重复 POST | 按“失败未写入”恢复并覆盖服务器 |
| 损坏密文／非法持久数据／DB忙 | 固定 500/503，不当空配置 | 静默跳过、值出错仍执行 |

### A-UI：正式组件与请求状态

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 新增编辑、启停、确认删除，控制API请求延迟和失败 | 成功才关闭/更新；防重入；失败保留输入或恢复开关 | 全局二次保存、假成功或重复提交 |
| 未提交时取消/×/Escape/遮罩；保存发出后操作关闭 | 未提交直接丢弃；已发出请求期间关闭暂禁，不声称撤销 | 草稿确认、本地草稿或误承诺撤销写入 |
| 无变更保存；只改备注且原值含CRLF | 无变更不发空PATCH；备注PATCH不重写value | 400空PATCH、显示换行归一化改坏未编辑值 |
| 响应丢失后重读成功/失败 | 明确未确认状态，读取当前服务器结果，不重试POST | 以失败当未写入或重试重复创建 |
| 慢请求切Workspace/销毁，旧响应和错误随后返回 | 新视图不接收旧值、状态或toast | 跨Workspace数据残留 |
| 老Dock恢复、空列表/无匹配、空串/多行/特殊文本 | 缺省补齐、正确状态、纯文本渲染，无显隐/草稿/演示文案 | 布局重置、HTML执行或旧交互复活 |

### A-CACHE：缓存和生命周期

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 首次读取有效／空配置，连续再读 | miss 查库解密；hit 查询和解密计数都为零 | 命中又 getWorkspace 查库、空 map不缓存 |
| 同步写提交后下一次读 | 新值；失效在成功返回前 | 返回成功后命中旧值 |
| 写回滚／读失败后重试 | 回滚不发布部分值；读失败不负缓存 | 失败缓存 `{}` 或旧失败值 |
| 连续读 129 个 Workspace，再读最早淘汰项 | 容量128，LRU正确，重读重新查库得新值 | 无限缓存、淘汰改变语义 |
| 两 AppContext/DB 相同 workspaceId | 各自配置独立 | 跨实例全局 Map串数据 |
| 调用方合并／修改返回副本 | 后续缓存不变 | 把基础env/Git本次值写回缓存 |
| 开始删除后命中缓存；重启恢复 deletion fence | 409且不查DB命中；重启仍拒读 | fence只约束写，cache绕过删除 |
| 删除最终提交后释放 fence，再读取 | 缓存已失效且404 | 已删Workspace旧缓存复活 |
| 调用A读旧快照；写成功；调用B再读 | A可旧，B必须新 | 混合版本、强杀A或B仍旧 |

### A-SCOPE：作用域

- 两 Workspace 同时 bash／创建终端，使用不同标记，不串环境。
- bash 绝对或 Workspace 外 cwd 保持现有可执行行为，仍用 run.workspaceId 的覆盖。
- 配置修改不改变运行中命令和已有终端；重连不触发重新注入。
- 失败判定：按 cwd切配置、外部目录静默跳过、改配置时杀已有终端、修改全局 process.env。

### A-BASH：Worker 环境与执行

| 准备／动作 | 预期 | 失败判定 |
|---|---|---|
| 系统＋Workspace 同名、代理大小写独立、空串 | 精确键覆盖，其他系统键保留 | 系统普通值最后覆盖、别名同步 |
| 检查工具定义并执行旧参数调用 | command/workdir/timeout兼容，无新增env | 参数契约扩展或命令改写 |
| 读取故障／非法内部响应／取消 | 不 spawn，不当空配置；bash 不申请任何 Git lease | 当空配置继续或恢复旧 bash lease |
| bash 执行 git、嵌套 shell／函数／env git；原生 Git 工具回归 | bash 不申请项目 lease，原生 Git 原有 lease/finally 不变且不读 Workspace 环境 | 命令识别恢复旧鉴权或向原生 Git 扩散配置 |
| bash 指定外部绝对 cwd | 用 run.workspaceId 覆盖；现有目录行为不变 | 按 cwd 换配置或添加 Git 目录约束 |
| 继承AWB变量，执行工具与无WS探测 | 子进程无AWB；探测不读Workspace；Worker全局不变 | AWB继承泄漏或全局环境被删 |
| 基础env过大导致E2BIG | 固定错误，不泄env | 记录argv/env或降级无配置 |

### A-LAUNCH：入口、快照与握手

- 构建检查 launcher.ts 产出 dist JS；生产入口在 prune devDependencies 后仍可启动，不依赖 tsx；源码模式只用可信入口与显式参数。
- 检查所有 tmux/launcher argv不含虚构值，包含的仅固定路径和定位元数据；Workspace PATH/NODE_OPTIONS 不作用于 launcher 自身。
- payload 各层与运行时 TERM/TMUX/TMUX_PANE 按设计合并；普通键不从热 tmux server 环境偷偷引入；AWB/token不进入快照。
- payload字面值、上限、版本、保留键和结构校验；坏 payload不 spawn。
- status只原inode写；pending／部分JSON等待；spawned必须来源child spawn，session也存在才成功。
- 明确区别“shell spawn”与“初始化完成”；不得断言 profile已结束。
- 失败判定：值进argv、Node20依赖execve、mjs未复制、只因tmux存在发布active、状态换inode后重新认领。

### A-TERM：生命周期与 fallback

| 注入动作 | 预期 | 失败判定 |
|---|---|---|
| tmux存在但launcher／shell失败 | 不active，补偿并保留必要定位 | session存在即成功 |
| 状态超时、迟到、其他attempt、完整非法结构 | 明确失败；旧状态不影响新尝试 | 无限等、超时直接fallback |
| new-session异常，probe exists／indeterminate | 不fallback，按presence保留并收敛 | 再建第二孤儿 |
| 默认bashENOENT，旧session明确停止且文件清完 | 仅一次sh新attempt；用户指定shell不回退 | 重用attempt、未确认停止就回退 |
| shell已spawn随后退出 | presence/reconcile收敛，不当ENOENT | 用退出触发fallback |
| 成功清文件后激活事务失败 | 不报成功，停止session并收敛 | active假成功、丢定位 |
| kill／probe失败 | errored/pending，定位和文件保留 | 标closed或删仍可消费文件 |
| SSH/HTTPS凭据终端 | 原Git1/2类数量检查与lease语义保持 | env/status计入Git数量 |
| 可控barrier暂停create等待握手，触发Worker ready reconcile | 同WS恢复等待整个create admission，不能中途kill | 以启动时单次恢复假设绕过串行 |
| pending扫描creating，create完成active后才取得恢复gate | 重读active并保留／按active规则检查，绝不按旧候选kill | 用旧扫描状态收敛 |
| deletefence已建立，pending/settle/delete继续收敛 | 使用withAdmission，能cleanup；不以withMutation拒绝清理 | fence阻断恢复永远pending |
| WS旧not_found后状态改变，随后取得gate | 重读terminal/attempt并重新probe，不接受旧授权 | 误settle当前有效session |
| 同WS多terminal与不同WS交错 | 同WS顺序await；不同WS可并发；ALS同链不Promise.all绕锁 | 同WS副作用并发或跨调用死锁 |

### A-CLEANUP：文件授权与恢复

| 准备／故障注入 | 预期 | 失败判定 |
|---|---|---|
| 目录／文件正常创建 | 0700/0600，先arm再副作用，保存身份 | 0644、O_TRUNC覆盖、先写后无intent |
| 根／父目录／文件symlink、hardlink、inode替换、uid/mode不符 | fail-closed，victim不改不删 | 只校验最终文件、chmod未知对象、重认领 |
| 业务文件missing与根未知IO错误 | missing仍检查本attempt授权槽；根错误pending | 原名missing即清row、两者都当不存在 |
| arm后创建前崩溃；创建后身份落库前崩溃 | 前者确认无对象可清；后者有未知对象则pending | 为未知文件补身份自动删除 |
| status同inode写到一半、迟到更新 | 有界等，不误判成功；旧attempt无权发布 | 将部分状态成功或读错attempt |
| 部分文件删后失败、attemptdir含未知文件 | 保留剩余定位／pending，不recursive删 | 清空整条intent或误删未知文件 |
| 创建、删除、重启creating/errored、active缺session、Workspace删除 | 全部进入专用收敛；terminal/WS删除被pending阻挡 | 漏路径、先删DB定位后删文件 |
| 专用根替换、私有删除槽replacement | 维持身份权限，不删replacement | 路径猜授权或盲扫槽位 |
| 文件rename后unlink前crash；原payload/status名missing | 稳定ep/es scope＋durable文件身份找到精确槽并收敛 | 依赖随机槽名二次落库或漏删退休槽 |
| 空目录rename后rmdir前crash；原目录名missing | 稳定ed scope＋durable目录身份恢复，以窄空目录helper清理 | 清row遗留槽或递归删除目录 |
| 槽inode替换、marker、对应scope未知格式／多候选、目录槽未知后代 | pending且不认领／不删未知对象 | 只信槽名编码或从当前stat补授权 |
| sharedroot其他attempt scope/marker；本attempt的root replacement | 不触碰无关对象／不全局阻塞；本root替换fail-closed | 跨attempt误删、无关marker阻塞全部或忽略root身份 |

## 手动验收准备

- 使用隔离测试 Workspace、新建测试终端、虚构值及明确的测试数据目录；不要改正在运行任务的环境。
- 以下真实API／UI／Worker验收统一使用[测试专用harness](#测试专用-harness-与-socket-隔离)，不是只在用户命令中加tmux -S；不能为“冷启动”杀死默认server。
- 记录操作系统、Node、tmux版本和源码／构建模式。Node20与Node22分别有真实结果，否则未覆盖版本保持待验收。
- 测试观察只定位本测试 tmux/launcher/shell PID，不做系统全量 argv/env转储；不得打印真实秘密。
- 每项记录动作、实际结果、失败截图／固定错误码和是否遗留资源，不以“看起来正常”替代具体结论。

### 测试专用 harness 与 socket 隔离

已新增 `apps/api/tests/manual/terminal-environment-harness.mjs`，只用于验收，不作为生产入口，不新增 AWB socket 配置。默认在真实隔离预检通过后保持手动 UI；`--verify` 自动验证并清理退出。两组显式 harness 测试、固定 Worker fixture 和实际运行证据见[实施记录](08-implementation-and-verification.md)。

- harness在本项目`.tmp-tests/te-<随机安全短段>/`建立临时HOME、dataDir、DB、Workspace和wrapper目录。先在未prepend的受控基础PATH定位真实tmux绝对路径，再重置自身环境，只保留需要的基础项并设置测试HOME/PATH；在动态加载app／启动Worker前完成。
- 显式构造测试主密钥、AppContext和loopback独立端口，动态调用`createApp`；禁止import main.ts、调用dotenv加载器、读取用户.env.local或连接生产dataDir。内部token随机生成但不打印；preview/plugins/analytics关闭，serveWeb使用本项目已构建web dist，UI仅绑定127.0.0.1且测试ctx可关闭网页登录。
- `--port 0`表示先选择可用loopback端口并用于ctx.agentApiOrigin，再启动app；探测与bind之间若EADDRINUSE，停止并重选/报告，不能连接碰巧占用该端口的生产服务。Worker启用时使用测试ctx、独立Unix socket／端口和同一测试internal token，不复用生产Worker；测试bash调用使用固定工具调用／测试fixture，不要求真实LLM凭据。
- createApp注册Agent模块时已经调用workerManager.start，并非等待listen钩子。加载前必须备齐wrapper／ctx／端口及纯测试fixture；createApp完成后立即listen，listen失败须app.close停止已起Worker再退出，不在ready回调未完成时提交验收命令。全部通过API listen与Worker ready门槛后才开放测试UI／执行fixture，不扩大为生产启动框架重构。
- 生成0700的`tmux` PATH wrapper，以`#!/bin/sh`开头，执行体只有`exec '<真实tmux绝对路径>' -f '<本项目内独立空配置>' -S '<本项目内唯一测试socket绝对路径>' "$@"`。所有路径由harness生成和安全引用，不把用户env值写入脚本；先确定真实binary避免wrapper递归。socket绝对路径UTF-8长度须小于100字节，过长明确失败，不偷偷迁移到项目外。
- 仅harness进程PATH前置wrapper，所有runTmux的has/count/new/kill及node-pty.spawn("tmux") attach必须命中同wrapper。用户shell／系统PATH不修改；若生产未来改绝对tmux路径，harness须增加窄测试注入适配并预检，不能掉回default socket。

隔离预检是执行cold／kill前的硬门槛：

- wrapper list-sessions与真实tmux `-S <测试socket> list-sessions`匹配；创建测试session后，API probe/count和实际pty attach都属于该socket上的测试server。
- 记录实际launcher/shell与该测试server/session关联；任一调用落default socket立即停止验收，不执行cold或kill。
- cold 仅精确停止已归属 session，使测试 server 在最后一个 session 退出后自然停止，再新建并验证 server PID 变化；hot 复用测试 socket 创建多个 session。无需 kill-server，禁止操作默认 socket。

可执行命令示例（仓库根目录，先按[安全运行准备](08-implementation-and-verification.md#安全运行准备)建立 `safe` 和隔离 Vite 配置；禁止直接使用会读取真实 env 的默认 Web／根 build）：

```bash
safe npm run build -w packages/shared
safe npm run build -w apps/agent-worker
safe npm run build -w apps/api
safe npm run build -w apps/web -- --config "$verify_dir/vite.safe.config.mjs"
safe node apps/api/tests/manual/terminal-environment-harness.mjs --mode source --port 0 --with-worker
safe node apps/api/tests/manual/terminal-environment-harness.mjs --mode dist --port 0 --with-worker
```

- mode source 在脚本内用 `tsx/esm/api.register()` 加载源码，命令行不需要 `--import tsx`；mode dist 拒绝命令行 loader/import/require/env-file，动态加载 API dist 且必须由真实 dist launcher 启动目标 shell，不借 tsx 掩盖生产依赖。`--with-worker`使用已构建的独立Worker；harness清除影响源码选择的继承npm/dev标记，记录实际入口，缺dist时生产模式明确失败。
- harness打印测试UI URL（`http://127.0.0.1:<实际端口>/workspaces/<测试WorkspaceID>`）、版本、测试 Workspace ID 及安全清理范围，用户在该独立UI验收；不打印token、主密钥或payload。
- 支持 `--hold-launch-ms 5000`（范围 0–30000ms）及`--fault file-retire-crash|directory-retire-crash|status-timeout|kill-failed`，通过测试专用依赖注入／fixture暂停或故障，不添加生产控制接口或产品环境参数。在延长窗口内核对真实 launcher/shell argv 与文件权限，不打印 argv 内容。Linux 没有 ps 时，仅读取已由测试 tmux 证明归属的 pane PID／直接子进程的 `/proc` 元数据，核对 PPid；不枚举全系统、不读取 environ，也不以一次未观察到进程判安全。
- Ctrl+C退出harness时先停止其Worker／app，确认测试session归属后只对测试socket收敛；检查attempt/退休槽。未知对象仍保留pending并报告，不盲删整棵测试目录。测试 DB、fixture 和 `result.json` 保留在项目内作证据；只收敛已授权 session、Worker 及启动临时文件，不递归删除整棵目录，不打印 payload。
- crash恢复项使用同一测试DB／dataDir／socket在harness内停止并重新构造app；不得重启生产main。资源保留到定位收敛后再最终清理；测试fixture不读取用户Repo、凭据或旧Workspace。
- Node20／22分别运行并记录，source 和 dist 结果区分；当前 Node22/Linux 已实际通过，Node20 仍待验收。managed Worker 实际独立启动并健康；固定 bash 工具调用由另一个短命 fixture 进程执行已构建 Worker 的 AgentApiClient/BuiltinToolProvider，并真实经内部鉴权 API 读取配置，不冒称 managed Worker 经 LLM 完成该调用。

## 手动验收清单

### M-UI：正式工具

- 打开旧Workspace/Dock布局，新增工具可用，已有布局不被重置。
- 新增、编辑、启停、删除逐项验证：操作成功即持久化，刷新页面后仍在；无草稿栏、眼睛按钮或演示初始化数据。
- 未提交表单的取消/×/Escape/遮罩直接丢弃；保存中防重入；请求失败保留输入或回滚开关。
- 搜索、状态筛选、空列表与无匹配状态可用，空串和多行值可读。
- 慢请求时切Workspace，旧响应不填入新列表或表单；值不进入布局localStorage。
- 失败判定：二次全局保存、假成功、丢字段、跨Workspace残留或原型演示文案进入生产。

### M-ENV：实际环境与生效

- 配置测试普通值、空串、CR/LF、引号、`$PATH`、`$(...)`；用读取环境的测试程序逐项比较，避免测试shell自身展开误导。
- 同名系统变量被Workspace覆盖；模型式 `FOO=x command` 只按shell作用范围覆盖，不持久修改Workspace。
- 两种代理大小写同时存在时分别修改，确认不自动同步；用户决定程序读哪个。
- 开旧终端和长命令后改配置，再开新终端/调用新bash：新读新值、旧进程旧值，重连旧终端仍旧值。
- 两Workspace不同值连续、并发运行不串；外部workdir仍注入run所属配置。
- 失败判定：值被加工、模板被配置工具执行、旧会话被刷新、新读仍旧或按cwd换身份。

### M-TTY：真实运行时硬项

| 动作 | 预期／失败判定 |
|---|---|
| 输入命令、中文、连续输出、窗口缩放 | 输入回显、编码和尺寸正常；吞输入／乱码／尺寸不更新失败 |
| 前台长命令 Ctrl+C | 只中断预期前台程序，shell可继续；launcher或会话异常结束失败 |
| Ctrl+Z、jobs、fg、后台任务 | 与现有直接shell终端一致；无法恢复前台、僵死或进程组异常失败 |
| exit及异常shell退出 | pane与记录按既有生命周期收敛；孤立launcher、错误退出码或无法退出失败 |
| 断开、重连 | 作业和原环境保持；重建shell／更新旧环境失败 |
| 冷与热测试tmux server | 新会话均获得本次基准，不串系统旧值；测试不影响其他session |
| Node20/22＋源码/生产构建 | 两版本和生产无tsx均实际可用；未执行项不能标通过 |

### M-SECURITY：参数与文件

- 使用可控延迟延长启动窗口，定位测试客户端、launcher及shell，观察启动argv。不能因为一次 `ps` 没看到短命进程就判没有泄漏。
- 虚构敏感值不出现在任何启动argv、协议错误或诊断日志；出现即失败。
- 检查新文件0700/0600，启动成功后payload/status/attemptdir清完，公共根保留。
- 验证最终shell无系统继承AWB字段；不打印或读取真实内部token。API/Worker控制连接继续正常。
- 反复新建终端不积累成功attempt资源；权限、定位替换测试在受控目录内进行，不修改真实用户文件。

### M-FAIL：失败与恢复

- 模拟读取故障、坏配置、目标shell缺失、启动握手超时；本次明确失败，旧终端继续运行，无不带配置降级。
- 默认bash缺失时只在安全条件满足后sh回退；指定不存在shell不回退。
- 在creating、准备文件和启动等待阶段重启API，确认pending恢复不发布active假成功。
- 模拟kill/cleanup失败：保留errored/intent，恢复依赖后可重试；未知inode对象不被删。
- 有pending尝试时删除终端/Workspace，不强删定位，不解除Workspace删除fence冒充成功。
- 网络响应丢失后UI明确结果未确认，重读能确认已提交内容，不重复创建。

## 代码审查门槛

- 核对[需求矩阵](README.md#需求与验收导航矩阵)每项有对应实现及测试，不仅看UI。
- 不新增bash env参数、不改workdir、不代理归一化、不恢复草稿／显隐、不修改全局env。
- 校验权威实现只有一份；TypeBox结构与合法Unicode、UTF-8额度、UTF-16备注语义一致，非法持久配置明确500且不缓存。
- 所有查询按workspaceId＋id，事务检查持久deletion状态，提交与失效无await。
- 缓存实例隔离、命中零DB、空值与故障区分、删除fence恢复正确。
- 明文接口有鉴权/no-store；日志、prompt、布局、异常对象不含值。
- launcher固定入口、环境晚应用，值不进argv；成功来自可信握手＋presence。
- 文件副作用有先行intent，root/dir/file身份不丢，缺身份窗口保守pending。
- 默认回退不破坏presence语义，所有清理入口覆盖，Git数量和既有response-loss/orphan测试保留。
- 同WS所有终端副作用共用admission，恢复候选入gate重读；deletefence不阻断cleanup，ALS重入不Promise.all并发。
- 私有槽恢复同时匹配稳定scope与durable root/dir/file身份；不直接扫描cleanupSecureRetiredFiles授权，不按业务名missing清row，空目录helper不递归。
- 手动harness的真实API tmux和pty attach已预检同socket；未证明隔离时不能cold／kill，也不能标M-*完成。
- 测试mock明确区分tmux创建、shell spawn和初始化，不以空fake给出兼容结论。
- 审查问题逐项修复后复审；拒绝以“用户手动验收”免除可静态或自动发现的安全错误。

## 验收完成标准

完整验收需满足：

- A-* 核心自动项实际通过，类型检查／构建通过，代码审查与复审无未解决阻断项。
- A-TERM的共同admission交错、A-CLEANUP的两类rename崩溃恢复、A-VALIDATION的非法Unicode，以及harness全链路socket预检均有实际证据，不能只凭文档或mock兼容结论通过。
- M-UI、M-ENV、M-TTY、M-SECURITY、M-FAIL 的核心实际动作有结果；Node版本或部署模式未覆盖要明确记为待验收。
- 无值进入argv/错误日志、内部AWB泄漏、跨Workspace串扰、active假成功、未知文件误删或定位丢失。
- 清理pending只发生在明确故障注入/真实故障，保持可诊断与安全边界；正常成功路径不遗留资源。
- 当前环境无法完成手动项时可以交付代码供验收，但只能写“自动检查通过，手动运行时待验收”，不能写“完整功能已验收”或默认已兼容。
