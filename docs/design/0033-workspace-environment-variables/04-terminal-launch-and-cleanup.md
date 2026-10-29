# 终端启动、握手与清理

## 设计状态与边界

本章是已实施的固定 Node launcher 协议，不是所有平台的兼容声明。Node22/Linux 的 source/dist、真实 TTY、信号、job control 和冷／热 tmux 已实测；Node20、其他平台及生产部署仍按[验收标准](05-acceptance-and-review.md)执行。实际证据及未覆盖项见[实施与验证记录](08-implementation-and-verification.md)。

不能因当前环境不便测试而退回 `env KEY=VALUE`、`tmux -e KEY=VALUE`、命令字符串拼接或 tmux 全局环境。这些方式会把值放进 argv 或改变其他会话。

复用现有 terminal 的 `creating/active/errored/closed` 生命周期和 presence 判断；新快照／状态文件使用独立定位实体，不能混入 Git auth artifact 枚举或数量检查。

## 终端副作用的共同串行边界

所有同一 Workspace 的终端可变副作用共用现有 `WorkspaceLifecycleCoordinator.withAdmission(workspaceId)`，不是新增锁框架：

| 入口 | gate与删除fence语义 |
|---|---|
| create | 继续`withMutation`，内部取得同一admission并检查fence；从creating落库直到有界握手、清理、激活或补偿全部持有 |
| delete、pending/active reconcile、session-stopped settle | 用`withAdmission`，不因deletefence存在而拒绝收敛；入gate后重新读取状态、attempt和presence |
| Workspace聚合删除 | 终端处理、定位收敛及最终terminal/attempt删除在同一admission序列中；使用允许fence的收敛路径 |
| WebSocket发现会话不存在 | 短admission内重新读取terminal并probe，必要时调用同链settle；不能把gate外旧not_found当删除授权 |

- pending/active扫描仅给出候选ID。进入gate后对象已不存在则skip；当前已active不能按旧creating快照kill，应按active规则保留或重新probe；只有当前creating/errored按pending收敛。其他状态不按旧候选强行改写。
- active候选在gate内重读状态与presence；settle自行取得gate并重新probe，或仅接受同一gate调用链内刚确认的可信presence。不能跨gate／异步调用链复用旧结论。
- WebSocket attach前的状态验证和必要settle也遵守此协议；不持锁整个连接。释放gate后attach遇会话退出按正常连接失败处理，不使用旧probe直接删除资源。
- Worker每次ready会触发恢复，不只启动时一次；手动删除、列表reconcile与创建都必须遵守相同gate。握手等待期间不能释放gate让恢复杀掉正在创建的session。
- 使用既有ALS同链重入，避免内部重复加锁死锁。一个admission内同WS多个terminal顺序`await`处理，禁止用`Promise.all`在ALS重入链并发同WS副作用；不同WS可并发。
- 配置缓存同步读取并不因此变成异步generation框架；本节只规定终端生命周期的并发授权。

## 启动链路（R-LAUNCH）

```text
Workspace mutation 准入与配置快照
  → terminal creating 记录
  → attempt armed 定位记录
  → 安全准备根、尝试目录、payload 与 pending status
  → 持久化 prepared 定位
  → 固定可信 Node launcher 启动到 tmux pane
  → launcher 校验并读取 payload，spawn 目标 shell
  → 同 inode 写 spawned / spawn-error 状态
  → API 有界等状态并确认 tmux session 存在
  → 按身份清理临时文件和尝试目录
  → 激活事务清 attempt、校验既有 Git locators、标 active
```

- 配置读取故障在启动资源准备前终止；身份和快照时点见[需求作用域](01-requirements-and-decisions.md#作用域与生效边界)。
- 终端默认 cwd／shell 选择沿用现状；shell 是一个可执行文件字符串，不新增参数解析、`shell: true` 或用户命令拼接。
- `active` 的新前提是目标 shell 已成功 spawn、tmux session 经确认存在、一次性资源已安全清理，以及既有 Git auth 定位检查通过。
- 成功不承诺 shell 初始化脚本完成、提示符出现或后续命令不失败。spawn 成功后快速退出会使会话消失，应按 presence/reconcile 收敛，不把它当默认 shell 未找到而 fallback。

## 固定 launcher 与构建

### 入口

已新增 API `src/modules/terminals/terminal-env-launcher.ts`，由当前 tsc 产出对应 dist JS。

- 生产使用固定 `process.execPath` 与可信 dist 入口；不能依赖 devDependencies 中的 tsx。
- 开发参照 analytics/plugin-host 的 source/dist 解析方式，明确可信 tsx 源入口；不继承 API 调试、env-file 等任意 execArgv。
- 通过 `import.meta.url` 定位，不按 Workspace PATH、cwd 或用户传入的入口解析 launcher。
- 入口缺失明确失败；不临时复制脚本、不下载依赖、不假设 tsc 会复制 `.mjs`。
- Node 20/22 使用普通 `spawn`，不依赖非共同基线的 `process.execve`。

### launcher 自身环境与参数

tmux 启动参数只包含固定可执行路径、源码／产物入口、attemptId、路径定位和预期 inode/uid 等非秘密元数据。所有参数以 argv 数组传递，不构造 shell 命令字符串。

采用固定 `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH` 前缀，再执行固定 Node 路径；它只删除启动器加载配置，不在 argv 放任何变量值。开发 tsx 的入口必须由 API 按可信项目位置解析，不能被用户 PATH／NODE_PATH 替换。

- Workspace 环境在 payload 内，launcher 加载后才用于目标 shell，不能影响 Node 自身加载。
- 系统 NODE_OPTIONS/NODE_PATH 若应继承给目标 shell，仍保存在 payload 的基础层，不因上述前缀丢失目标环境。
- API 内部主密钥、内部 token 不进入 argv 或 payload。所有 env 层在序列化前都排除 `AWB_*`，launcher 对目标结果再过滤。
- 新文件仅针对 Linux/macOS 的既有 tmux／安全目录 fd 能力，不宣称新增 Windows 终端支持。缺少所需能力明确失败。

## 环境层

payload 记录创建时 API 环境基准，而不是依赖既有 tmux server 可能过期的普通环境。

```text
baseEnv：创建时 API process.env 副本，过滤 AWB_* 与继承 TMUX
  → launcher 的实际 TERM/TMUX/TMUX_PANE 运行时元数据
  → systemEnv：既有 applyToTerminal 网络与 Git 鉴权环境
  → workspaceEnv：已启用的普通 Workspace 覆盖
  → 最终 AWB_* 过滤
```

- 实际 TERM/TMUX/TMUX_PANE 只补充在系统层；用户明确配置普通同名键仍可覆盖，不暗加特殊限制。
- 基础环境中其他普通键不从 tmux server 混入，避免热 server 使结果与冷 server 不一致。
- 自动网络保持既有开关及大小写字段，Workspace 只覆盖精确同名键，不同步别名。
- Git auth 文件和生命周期保持既有语义；systemEnv 的 Git 保留字段可由系统托管，Workspace 层不可配置。
- 目标 shell 查找可受 Workspace PATH 影响，launcher 自身不可；找不到目标 shell 按协议失败／受限 fallback。
- 不使用现有会将 CR/LF 变为空串的 `sanitizeEnvValue` 处理用户值。自动网络／Git 的既有处理不因此被无关改写；Workspace 值独立按字面 map 传递。
- 各层map安全构造并复用[合法Unicode语义校验](02-data-api-and-cache.md#合法-unicode-与字节计量)；Workspace层同时遵守配置额度，系统层不误用Workspace条目数／总额度。不能修改缓存或全局环境。

## 启动尝试实体

已新增独立非 Agent 表 `terminal_env_launch_attempts`，配套专用 store 和服务。

| 字段组 | 内容／约束 |
|---|---|
| 身份 | `id` 服务端唯一 attemptId；`terminal_id` FK → terminals，ON DELETE RESTRICT |
| 阶段 | `phase` 为 `armed/prepared/launching/cleanup_pending`；不是公开 terminal 状态 |
| 根锚定 | dataDir 根、专用 launch 根的 dev/ino；所有者 uid；定位均来自安全打开后的 stat |
| 目录定位 | 服务端导出的安全目录段、attempt 目录 dev/ino、`directory_armed` |
| 文件定位 | payload/status 各自的 `*_armed`、dev/ino，创建前 nullable，创建后记录 |
| 诊断 | 固定非敏感 `error_code` 可空，不存原始异常或 payload |
| 时间 | `created_at/updated_at` 毫秒 |

具体 SQL 列以此为准：

| 列 | 类型／缺省与约束 |
|---|---|
| `id`、`terminal_id`、`directory_name` | TEXT NOT NULL；id主键；terminal外键RESTRICT；directory_name为服务端安全段 |
| `phase` | TEXT NOT NULL CHECK IN上述四阶段 |
| `owner_uid` | INTEGER NOT NULL，本次API OS账户uid |
| `data_root_dev`、`data_root_ino` | TEXT NOT NULL，精确十进制身份 |
| `launch_root_dev`、`launch_root_ino` | TEXT nullable，两项同时空或同时非空 |
| `attempt_dir_dev`、`attempt_dir_ino` | TEXT nullable，两项同时空或同时非空 |
| `payload_dev`、`payload_ino`、`status_dev`、`status_ino` | TEXT nullable，各对象成对为空／非空 |
| `directory_armed`、`payload_armed`、`status_armed` | INTEGER NOT NULL DEFAULT 0 CHECK IN(0,1) |
| `error_code` | TEXT nullable，只写本章固定码 |
| `created_at`、`updated_at` | INTEGER NOT NULL，毫秒 |

增加 `(terminal_id, created_at, id)` 索引。身份字符串由可信stat无损规范化，不能由客户端提交；现有number helper需先安全整数检查再转换为十进制，非安全整数时明确失败，不近似比较。`prepared/launching` 要求完整目录和文件定位；无定位的armed对象只能按保守恢复规则处理。

- 根／文件身份和每项 arm 状态是清理权威；phase 不能代替“某个文件是否曾进入写阶段”。
- dev/ino 应保留精确整数身份。若复用现有 number 型 helper，先验证 safe integer，再保存／比较；不得经浮点截断后当作同一对象。数据库序列化采用可无损比较的表示，不对数值做近似转换。
- 路径由服务端 terminalId＋attemptId 导出，客户端不得提交路径、inode、阶段或状态。
- 同一 terminal 允许保留失败 attempt 的定位，不能复用旧 attemptId。每个新尝试都新建记录、文件和状态。
- `armed` 先于对应副作用；`prepared` 要求目录及两个文件定位完整；`launching` 在调用 tmux 前持久化；任何无法安全收敛的分支进入 `cleanup_pending`。
- 私有退休槽scope按attemptId稳定导出，见[稳定scope与退休槽恢复](#稳定-scope-与退休槽恢复)；无需新增scope或随机槽名列。持久root/dir/file身份仍是授权依据，不能用scope代替。
- 清理完成后才可删除 attempt；RESTRICT 防止 terminal 记录先删后丢失定位。

### 不复用 Git auth 业务表的原因

当前 Git cleanup enum、路径、阶段和激活数量检查专用于 SSH key／askpass／token。SSH 要求一类、HTTPS 要求两类；新文件加进同表会破坏这一不变量。

允许复用安全目录 fd、身份校验、私有删除槽等业务无关底层原语，不把 env/status 改名成 legacy Git artifact，也不扩大已有 Git cleanup 数量条件。

## 启动协议

### 目录和文件

```text
dataDir/
  terminal-env-launch/                    # 共用专用根，0700
    <terminalId>-<attemptId>/             # 安全段，0700
      payload.json                       # 0600，API 写、launcher 只读
      status.json                        # 0600，API 预建、launcher 同 inode 更新
```

- 先有 terminal creating 和 attempt armed，再进行本次 fs 副作用。
- 初始记录可先保存已可信打开的 dataDir 锚定；创建／打开专用共用根后记录其身份，再 arm 并创建尝试目录。未建立根定位前不能 arm 子文件写入。
- 共用根不是每个 attempt 的一次性文件，不随成功清理删除。其初次建立必须仍由 dataDir 安全目录能力完成；现有目录必须检查权限、uid 和身份，不能因路径同名就信任。
- 每个目录／文件创建前先持久化对应 arm；创建后立即保存实际定位，再进入下一项。
- 创建用 `O_EXCL|O_NOFOLLOW`，不覆盖已有文件；打开后核对 regular file、uid、权限、dev/ino，秘密文件要求 nlink 为 1。
- 所有祖先使用安全目录 fd 锚定；仅检查最终文件 `O_NOFOLLOW` 不足以防止父目录替换。

### payload

```ts
type TerminalEnvironmentPayload = {
  version: 1;
  attemptId: string;
  shell: string;
  baseEnv: Record<string, string>;
  systemEnv: Record<string, string>;
  workspaceEnv: Record<string, string>;
};
```

- JSON 自带版本与 attemptId；读取前核对从 API 固定参数取得的根／文件预期身份，不以 payload 内自报身份授权访问。
- shell、map、保留键及结构再次校验。Workspace 层必须符合配置规则；base/system 是 API 生成的系统层，不能把用户配置装成 systemEnv 绕过保留规则。
- 序列化／读取有界，建议 payload 上限 1 MiB，避免损坏文件无限读取；Workspace 自身限额仍以配置章为准。过大的系统环境明确失败，不截断。
- 所有系统环境基准同样按敏感文件保护，不只保护看起来像 token 的键。
- launcher 只读并关闭 payload，不自行删除；清理由 API 统一执行。

### status

```ts
type TerminalLaunchStatus = {
  version: 1;
  attemptId: string;
  state: "pending" | "spawned" | "spawn-error";
  code?: "SHELL_NOT_FOUND" | "SHELL_SPAWN_FAILED" | "ENV_TOO_LARGE" |
         "SNAPSHOT_INVALID" | "STATUS_WRITE_FAILED";
};
```

- API 预创建 pending 文件并保存 inode；launcher 打开既有文件，只在同 inode 上更新，不能 rename 替换或重新创建。
- 成功仅在 child `spawn` 事件后写 `spawned`；`error` 事件写固定 `spawn-error`。ENOENT 映射 `SHELL_NOT_FOUND`，E2BIG 映射 `ENV_TOO_LARGE`，不写原始错误文本。
- 状态最长 4 KiB，结构、版本、attemptId、state/code 组合必须严格校验。pending/spawned 不带错误 code。
- API 用单次 10 秒 deadline、约 50 ms 间隔有界读取；JSON 正在同 inode 更新而暂不完整时可在 deadline 内重试，不能把部分文本当成功。
- 文件身份变化、错误版本、其他 attempt 状态等是协议错误，不重新授权新文件；不完整一直持续到 deadline 则超时。
- 读取成功状态后仍查 tmux presence，明确存在才进入成功收尾。不把 `new-session` 成功或 session 存在单独当 shell spawn 成功。
- 状态无法安全写入时 launcher 给固定诊断并停止本次 shell，不凭 stdout 文本触发 API 成功；API 按超时／presence 补偿。

### 进程与信号

- 目标 shell 用 `spawn(shell, [], { env: effectiveEnv, stdio: "inherit" })` 语义，继承 pane TTY，不用 `shell:true`，不额外 detached。
- launcher 不读取抢占标准输入，不设置全局 raw mode，等待目标 shell 退出后转译退出码／信号并结束自身。
- 在读取快照和 spawn 前建立 HUP/TERM 停止处理；收到停止后不得继续创建 shell。已拥有的 child 收到相应信号，父进程有界收敛，不能无限等待。
- 普通退出保留child退出码；信号退出采用`128 + os.constants.signals[signal]`，未知信号映射固定非零。停止请求先置stop标记，再转发给本次child；最多等待5秒，超时只向该child PID发送SIGKILL并结束父进程。父进程退出前关闭已打开的协议句柄，清理计时器；停止后不写迟到成功状态，不根据旧PID记录跨重启杀进程。
- 只针对本次拥有的 child／session 收敛，不盲杀整个系统进程组、tmux server 或他人会话。
- Ctrl+C、Ctrl+Z、fg、jobs、后台作业、TTY 前台进程组的真实行为是手动验收硬项，不能由 `stdio:inherit` 推断已兼容。若不兼容，修正启动器，不降低验收标准。

## fallback 与 presence

### 保留原有不确定性边界

现有 `newTmuxSessionWithPresence` 只有明确 `not_found` 才能认为未创建；`exists` 或 probe 本身不确定不能当失败未创建。本功能必须保留这一边界；明确未创建本身不证明目标 shell ENOENT，也不构成回退许可。

- tmux 请求异常但 session 存在／无法确定：保留定位，进入补偿，不直接再创建。
- tmux 请求异常而明确未创建时，清理本 attempt 后明确失败；不能凭 tmux 错误猜测 bash 缺失。只有下述可信 `SHELL_NOT_FOUND` 条件允许默认 bash→sh 回退，使用全新 attempt，不能重用文件或 pending 状态。
- 新增的 `SHELL_NOT_FOUND` 回退仅适用于未指定 shell 的默认 bash，且确认该 attempt 未成功 spawn shell；先终止旧 session，再确认 not_found，完成旧文件清理后才能新建 sh attempt。
- 用户指定 shell 失败不回退；其他 spawn 错误、状态超时、状态不确定、spawn 后退出均不自动回退。
- 迟到状态属于旧 attempt，永不使新 attempt 成功，也不重新发布 errored terminal。
- 最大仅一个默认回退，不循环重试，不因握手超时创建第二孤儿。

## 文件安全与精确清理（R-CLEANUP）

### 删除授权

- 使用`secure-directory`目录句柄、身份复核与retire原语；仅凭路径、scope或槽名编码不能授权删除。
- 本协议不能直接调用`cleanupSecureRetiredFiles`扫描清理：现有函数主要依据槽编码且没有本attempt的durable locator，也不能完成空目录退休槽收敛。
- 清理需检查业务名及本attempt对应scope的槽。业务名missing不表示全部完成；只有授权槽也收敛、无相关replacement/pending才可清记录。父根未知、权限或IO错误不能当不存在。
- launcher不删除payload/status或替换status inode，API统一负责；所有收敛动作在[共同串行边界](#终端副作用的共同串行边界)内完成。

### 稳定 scope 与退休槽恢复

稳定导出规则：`token = sha256(UTF8(attemptId)).hex.slice(0, 32)`；payload为`ep-<token>`、status为`es-<token>`、attempt目录为`ed-<token>`。每个scope长35字符，满足现有`[A-Za-z0-9_-]{1,48}`。scope不是授权凭据；随机槽nonce不必二次落库才能恢复。

- 先打开并核验持久dataDir／shared launch root身份。在原目录业务名或shared root中本attempt合法ed退休槽寻找持久attempt_dir身份；不能因原目录missing就清attemptrow。
- shared root只检查本attempt的原目录名与ed scope相关槽／marker；其他attempt的槽或未知对象不删除，也不把不相关marker作为本attempt的全局阻塞。
- payload/status的ep/es槽位于找到的原attempt目录或其合法退休目录内部。目录内部任何非本attempt授权后代均是未知对象，阻止删除目录；这不授权清理其他attempt。
- 用`securePrivateSlotIdentity`解析槽，先要求scope、kind、dev/ino等于durable locator，再lstat／安全open核验实际inode、uid、模式及文件nlink=1；不从当前stat反向补授权。
- 业务名存在replacement、多个候选、marker、对应scope的未知格式或identity不符均保留pending。marker去掉固定marker前缀后检查对应scope，未知格式按精确scope前缀识别；不能只信槽名字，也不能把退休槽重新retire为业务名。
- 文件rename后未unlink：原业务名可missing，仍通过稳定ep/es scope＋持久文件身份找到精确合法槽，构造已经durable校验的retired对象并调用`removeRetiredSecureFile`；仅清该目标文件。
- 目录rename后未rmdir：仍通过ed scope＋持久目录身份定位；先检查并收敛目录内本attempt授权文件／ep/es槽，任何未知后代或相关pending均阻挡。空目录使用窄helper `removeRetiredEmptySecureDirectory`，重新核验可信parent、scope/kind/identity/owner/mode和目录为空后安全rmdir。
- 新空目录helper不调用`removeValidatedRetiredEntry`、`removePinnedDirectoryContents`或递归树清理，不能扫描槽编码就删除全部后代。

每次清理和重启恢复都按相同顺序：

```text
确认session停止／不存在（或成功消费握手）
  → 在可信shared root定位原attemptdir或精确ed目录槽
  → 核验并清payload/status业务名及精确ep/es文件槽
  → 确认目录无未知后代／marker／多候选
  → 原目录retire到ed槽（已退休目录不再次retire）
  → 精确安全rmdir，复查业务名及相关槽均收敛
  → 清attempt持久记录
```

rename后的崩溃由稳定scope＋durable身份恢复，不依赖rename后再写随机槽名的窗口。身份尚未落库的armed对象仍按下节保守pending，不从scope猜授权。文件／目录业务路径和本attempt授权槽都已收敛，且没有相关replacement/pending，才允许清attemptrow。

### 创建与身份落库之间的崩溃

文件可能已创建，但对应身份尚未持久化。该窗口不能凭路径补授权。

- 若arm对象业务名确实不存在、父根可信且本attempt稳定scope关联槽／marker也不存在，才可清除对应pending定位；有相关槽但缺durable身份时仍pending，不从槽名认领对象。
- 若存在对象但没有可信身份，保留 `cleanup_pending` 和 terminal 记录，明确安全清理待处理。
- 不为未知对象重新读取 inode 后授权删除，不扫描目录把未知文件“认领”为本次 artifact。
- 共用根初建但子目录／文件尚未 arm 的窗口不含本次秘密；只可结束该空尝试，不删除共用根或其中其他对象。
- 需要人工处置时按受控检查确认归属；不打印 payload，不建议直接删除整个 dataDir 或 Workspace。恢复动作应有明确对象身份和影响说明。

这是刻意的 fail-closed 取舍：允许少量故障留下可诊断 pending，不以完全自动清理为由越界或误删。

## 补偿与恢复

### 成功收尾

同一admission内读取spawned并确认session存在后，API按稳定scope协议清payload/status及空attempt目录。清理完成才在激活事务中删除attempt定位、保持既有Git auth数量／身份检查并标active。

清理失败不返回 active；先补偿终止 session，保留 errored／cleanup_pending。文件已清理但激活事务失败也不能返回成功，应继续按 session/intent 收敛。

### 失败收敛

| 场景 | 必须行为 |
|---|---|
| 配置读失败 | 不准备文件／tmux，明确失败 |
| 文件准备失败 | 按已 arm 对象收敛；未知身份保留 pending |
| tmux 创建明确未创建 | 清理本 attempt 后明确失败，不凭 tmux 错误猜测 shell ENOENT 或自动回退 |
| tmux 创建可能已成功 | probe／停止该 session；不确定时保留 intent，不 fallback |
| shell error／握手超时／协议错误 | 停止可能存在的 session，确认停止后清文件；不返回 active |
| kill／probe 不确定 | 保留文件定位及 pending；不能在 launcher 仍可能读取时删除 |
| 已删部分文件后失败 | 业务名missing仍检查精确退休槽；授权槽未收敛或replacement保持定位，不清空整条记录 |
| API 在 creating／errored 时重启 | 复用现有 pending reconcile：先终止／确认 session，再清新文件与 Git auth；不是恢复成 active |
| active 会话不存在 | 既有 settle 路径也检查新 attempt 残留；正常 active 原则上无 attempt |
| 删除单终端 | 新 attempt 清完及 Git cleanup 成功后才删 terminal，RESTRICT 保证不丢定位 |
| 删除 Workspace | 所有终端新 attempt 和 Git资源安全收敛后才执行终端／Workspace 删除事务；失败保留 deletion intent/fence |

- 文件清理不能早于已确认 session 停止／不存在，除成功路径已消费完成并关闭文件的明确握手收尾。
- 未确认的会话消失不能凭一次 tmux 错误推断；沿用现有 indeterminate 分类。
- Workspace 的 `terminals` 当前为 RESTRICT，不是 cascade。新增配置表可 cascade，但新 attempt pending 时禁止强行删除 terminal 或跳过 RESTRICT。
- 删除事务中清 attempt 定位仅在实际资源已清理时进行；新 schema 不关闭 FK、不强制清记录、不改 Git locator 数量。

## 错误与诊断

| code | 含义 |
|---|---|
| `TERMINAL_ENV_PREPARE_FAILED` | 目录／文件／入口准备失败 |
| `TERMINAL_ENV_PROTOCOL_FAILED` | 定位、版本、状态或 payload 非法 |
| `TERMINAL_ENV_START_TIMEOUT` | deadline 内无可信最终状态 |
| `TERMINAL_ENV_SHELL_NOT_FOUND` | 目标 shell ENOENT，无许可回退或回退失败 |
| `TERMINAL_ENV_SPAWN_FAILED` | shell 启动失败，含无泄漏的 E2BIG 分类 |
| `TERMINAL_ENV_CLEANUP_PENDING` | session／文件无法安全收敛，定位保留 |

终端 create 的内部启动故障返回固定 500／依赖暂不可用 503；单终端或 Workspace 删除被新增 env pending 阻挡返回 409。必须区分 env pending 与既有 Git-only cleanup pending：后者沿用现有单终端“逻辑删除成功、保留errored记录”的兼容行为，不为本功能改写。无论对外何种结果，仍不得删除未收敛资源的权威记录。对应日志可包含 workspaceId、terminalId、attemptId、phase、固定 code，不含完整 env、payload、密文、原始 spawn 参数或未经处理 stderr。

目标 shell／用户命令主动输出值属于授权执行能力，不保证全面脱敏；但启动器自身诊断不得扩大泄漏。

## 取舍与手动验收门槛

- DB 静态加密不意味着瞬时 snapshot 加密。此方案以 0700/0600、可信身份和短生命周期保护临时明文，避免向 launcher 传主密钥。
- 不抵抗完全控制 API OS 账户／root 的攻击；同 OS 用户的授权命令能读取自身环境，不把文件权限称为 shell 沙箱。
- 当前可以先实现、mock 测试和独立代码审查，不要求先完成 PoC；但未通过 M-TTY/M-SECURITY/M-FAIL 前，必须记录运行时待验收。
- 实测若发现进程行为或安全传输不满足要求，应修 launcher／协议并复审，不退回 argv、全局 tmux 环境或不安全清理。
