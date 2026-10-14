# 技术方案、契约与实体

## 目标架构

```text
API 每轮 prompt context
  ├─ 保留 run 静态 system/tools 缓存
  └─ 动态读登记仓库名 → workspaceRepoNames

Worker BuiltinToolProvider.listTools
  └─ 复制 git 基础定义，追加本轮仓库名

Worker git provider
  ├─ 校验输入、工具可用性、AbortSignal
  ├─ prepareRepoGitEnvLease：API 先持久化默认 unconfirmed，再交付环境
  ├─ 本地路径/脱敏准备 → 最终路径检查
  ├─ 直接 spawn git，持有 child 对象和本次分配的数值 PGID
  ├─ 正常退出/取消/超时/超限共享同组收尾；首次 ESRCH 后停止后续信号
  └─ 已确认：release 在同租约短临界区内确认、持久化 stopped、删除
       未确认：失败并保留租约/删除保护，进入有运维证据的维护窗口

同机维护 CLI（主服务已停）
  └─ 只读检查/显式运维确认 → 直接调用同一租约服务函数定点释放
```

- API 不执行模型原生命令，不接收 args，不访问 Worker 进程句柄。
- Worker 不读凭证数据库/master key。API/Worker 共享受信数据目录和 Workspace 文件布局，是已有 Bash 租约机制的部署前提；不支持凭证路径不同的独立远程 Worker 部署。
- Git executor 是 Worker 局部实现，不为两个入口新建通用执行框架，不顺手改变 Bash。
- 数值 POSIX 进程组监督不是强 OS 身份隔离；范围是本次组的连续本地生命周期观测，不覆盖逃逸组的原生程序。观测间数值重用的残余风险见 [RULE-PROCESS-SETTLEMENT](#rule-process-settlement)。

## 实体与存储

| 实体 | 既有/新增 | 用途 |
|---|---|---|
| Repo / WorkspaceRepo | 既有 | 登记名称、路径、URL、凭证绑定 |
| Run / Session / ToolExecution | 既有 | 当前运行归属、工具启用和执行状态 |
| `workspaceRepoNames` | 新动态响应字段 | 每轮安全登记名，不存静态缓存 |
| Git 工具输入/结果 | 新共享契约 | 原生参数、父退出结果与收尾状态 |
| Git 环境租约 v2 | 新命名空间内的文件元数据 | 认证、默认停止保护、确认后回收与定点维护释放 |

- 不新增业务数据库表、通用监督器或跨进程锁。
- 旧 v1 位于 `<dataDir>/tmp/git-env/<leaseId>`；新 v2 位于 `<dataDir>/tmp/git-env/v2/<leaseId>`。物理命名空间区别是为了坏 meta 时仍能保守持有，不是第二套认证实现。
- janitor 必须明确分发 v1/v2，绝不能把固定 `v2` 容器当作无 meta 的旧租约目录整棵删除。
- v1 仅按升级前原 metadata/兜底策略回收；不能作为新工具环境或新 release 的所有权实体。

## 输入与结果契约

### 模型输入

权威规则见 [RULE-INPUT](requirements.md#rule-input)：

```ts
type GitToolInput = {
  repo: string;
  args: string[];
  timeout?: number; // seconds, default 120, 1..3600
};
```

共享 schema/type 供工具描述、Worker 校验和测试复用；`additionalProperties:false`。数组非空，元素允许空字符串但拒绝 NUL；不 trim 或重写 argv。

### 进程结果

```ts
type GitToolResult = {
  repo: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  processStopConfirmed: boolean;
  failureCode: "GIT_PROCESS_STOP_UNCONFIRMED" | null;
  leaseDisposition: "released" | "release_unconfirmed" | "retained";
  outputRedacted: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  warnings: Array<"LEASE_CLEANUP_FAILED">;
};
```

- 不在结果元数据中返回完整 args、cwd、env、leaseId、文件路径或凭证内容。原生输出与元数据是不同通道：原生输出只保证 [RULE-OUTPUT](#rule-output) 明确列出的已知秘密/租约路径替换，不承诺所有原生路径都消失。
- 父原生 `exitCode`/`signal` 保留，即使后代收尾失败也不虚构新的父退出码。没有数字退出码为 null，不生成 `128+signal`。
- `ok` 要求父退出 0、无超时/取消/超限、停止已确认且无 failureCode。release 清理警告本身不修改 Git 原始执行结果。
- `processStopConfirmed=false` 必须整体失败，`failureCode=GIT_PROCESS_STOP_UNCONFIRMED`、`leaseDisposition=retained`。父退出 0 不能覆盖该状态。
- 成功收到 release 删除确认才是 released；请求失败或响应丢失是 release_unconfirmed，不假定文件已删。停止未确认时不调用 release。
- 原生非零退出仍交付结果，不进行模糊 stderr 分类、换身份或重试。工具“completed”表示已交付，文本必须显式展示 ok、父退出码和收尾状态；不能显示业务成功。
- 参数/上下文/准备/spawn 失败用安全前置错误，不伪造 Git 退出码。已获得租约但从未 spawn 的路径可用 `not_started` 停止证据 release。
- 取消可能使 runner 跳过模型写回，但 executor 的停止、保护与清理仍需完成并被测试。
- 两端 structured-result 名单和 schema 同步。关闭 stdio 只结束输出收集，不能直接生成 processStopConfirmed=true。

## RULE-DYNAMIC-CONTEXT

- `AgentApiPromptContextResponse` 新增必填 `workspaceRepoNames:string[]`，包括空数组；同步 fixture 和 `EMPTY_PROMPT_CONTEXT`。
- 每次已验证 run/session 的动态读取调用登记名读取器；这是读取时刻的最新记录，不与后续执行原子一致。
- 在 `PromptContextProjector` 动态依赖读取，不进入 `assembleStatic`/`RunPromptStaticCache`。
- Worker `listTools` 复制基础工具对象并追加本轮列表，不修改缓存，不累积聊天消息。
- API/Worker 独立检查安全名称、去重，名称 JSON 转义显示；不做100项截断，不依赖动态 enum。
- 入队 `workspaceRepoDirNames` 保留既有用途，不作为最新成员授权；不新增列表 RPC，不扫描磁盘。
- 工具可用快照沿用现有授权语义；仓库成员执行时刷新，两种快照不可混淆。

## RULE-RPC

### 内部端点

共享 request/response/TypeBox/endpoint 常量集中在 `internal-contracts/agent-git-tool.ts`，经内部 facade 导出。

| 方法 | 路径 | Client方法 | policy |
|---|---|---|---|
| POST | `/api/internal/agent/git-env/prepare` | `prepareRepoGitEnvLease` | controlWrite，有界，0重试 |
| POST | `/api/internal/agent/git-env/release` | `releaseRepoGitEnvLease` | idempotentControlWrite，有界，0自动重试 |

- 仅这两个新增 RPC，均保留 `x-awb-agent-internal-token`；非法 token 为401。正常 Worker 内部鉴权不因同机 CLI 直接调用服务而放松。
- 默认 RPC deadline 是既有 `internalRpcTimeoutMs=15000ms`。prepare 接收 run abortSignal；release 使用独立 deadline，不复用已中止 signal。
- prepare 和 release 均无自动网络重试，更不能重执行 Git。运行中不新增网络状态更新，命令正确性不依赖诊断信息成功上传。

```ts
type LeaseOwner = {
  workspaceId: string; // Worker可信上下文，不是模型字段
  sessionId: string;
  runId: string;
  toolExecutionId: string;
};
type PrepareRepoGitEnvRequest = LeaseOwner & {
  repo: string;
  timeoutMs: number; // 1000..3600000，整秒
};
type PrepareRepoGitEnvResponse =
  | { ok: true; repo: string; kind: "https" | "ssh" | "none";
      env: Record<string,string>; leaseId: string; expiresAt: string;
      sensitiveFilePaths: string[]; }
  | { ok: false; errorCode: string; error: string; availableRepos?: string[]; };
type ReleaseRepoGitEnvRequest = LeaseOwner & {
  leaseId: string;
  stopEvidence: "not_started" | "managed_group_absent";
};
type ReleaseRepoGitEnvResponse = { ok: true };
```

### 请求约束

- 两个RPC请求schema均拒绝未知字段；prepare不接受模型cwd、凭证ID、env、args。内部owner由可信执行上下文填充。
- 成功总有租约，包括 none。响应 env 只允许通用 builder keys：禁终端 prompt、HTTPS askpass三项、SSH command、代理大小写三组、CA两项；未知 key/AWB_* 非法。
- `sensitiveFilePaths` HTTPS/SSH恰好一个对应文件、none为空，必须位于本次v2租约。kind与keys/文件不一致是非法响应。askpass路径由已校验env取得，但不当作secret文件读取。
- prepare 不幂等且无自动重试；同一工具只调用一次。响应丢失后不 spawn；API无法据此确认是否启动，默认 unconfirmed 可能需要维护，不承诺普通 TTL 自动解除。
- release 的 `managed_group_absent` 是受信 Worker 按本地 executor 规则作出的停止确认，不是 API 独立核实 OS 身份的结果。API 不接受数值 PGID 作为完整停止证明，也不接受运行状态上报或远程维护参数。
- release 在 run 完成/取消、repo 不再可用时仍按 meta owner 校验，不要求 run 仍 running。坏 meta 拒绝正常 Worker release，留给有运维证据的同机 CLI。
- 已不存在且 ID 合法的重复 release 为 ok:true，内部鉴权仍必需；存在但 owner 不匹配403。确认、写入、删除须遵循 [RULE-LEASE-MUTATION](#rule-lease-mutation)，不得复活目录。
- 两端使用共享响应 schema、ID/owner 校验；API 错误不原样传播 response body/异常路径。

### prepare顺序

```text
内部鉴权/schema → run/session/toolExecution归属/启用/可执行状态
  → Workspace gate与删除fence → 最新安全repo和登记/物理初始目录
  → 排他创建v2目录，原子写默认stopState=unconfirmed
  → 通用builder写认证文件 → 完成元数据/环境校验 → 交付响应
```

- 默认保护写入失败，不构建/交付认证、不允许 spawn；回收未交付目录，失败残留按 v2 未知状态保留，不能按旧坏 meta 兜底删除。
- prepare 的构建与元数据发布在响应交付前结束，不在交付后继续异步改写租约。只有 prepare 可以创建新 ID 目录，release/janitor 均不创建目录。
- 返回前运行已终止且环境尚未交付时，API可按确定未启动状态回收；不能把“HTTP写失败/客户端消失”作为事后未启动证明。
- 初始目录检查时点与非原子窗口见 [RULE-PATH-CHECK](#rule-path-check)。归属错误不返回别的 Workspace 名。

## RULE-AUTH-IMPLEMENTATION

- 保留 `infra/git/gitEnv.ts` 的 `buildGitEnv` 为唯一凭证选择、网络/CA和环境构建实现。
- 增加可信内部 artifactDir，令文件写入已准备的v2目录；未传时保留既有mkdtemp行为。artifactDir不开放给模型或HTTP任意路径。
- 返回kind/sensitiveFilePaths；新工具显式启用失效绑定错误，默认调用兼容既有API。
- 不复制host/protocol选择、解密、askpass/SSH规则；全部创建失败分支有回收。builder cleanup只能在明确尚未交付执行的prepare异常路径或停止已确认路径调用，不能在运行不明时绕过lease保护。
- 租约服务释放不依赖内存closure；只按可信根和合法ID删除。共享CA/known_hosts不随lease删除。

| 类型 | 环境/文件 |
|---|---|
| 公共 | GIT_TERMINAL_PROMPT=0；既有代理/CA |
| HTTPS | GIT_ASKPASS、GIT_ASKPASS_USERNAME、GIT_ASKPASS_TOKEN_FILE；脚本/token |
| SSH | GIT_SSH_COMMAND；私钥，共享known_hosts |
| none | 无秘密文件，仍有停止保护meta；可用系统认证 |

POSIX目录/脚本0700、token/key/meta0600；权限失败明确失败。其他平台需等效权限和受管停止确认能力，不能只凭mode/taskkill代码宣称支持。

## RULE-LEASE

### v2元数据

```ts
type RepoGitEnvLeaseMeta = LeaseOwner & {
  schemaVersion: 2;
  purpose: "git";
  leaseId: string;
  repo: string;
  repoId: string;
  kind: "https" | "ssh" | "none";
  createdAt: string;
  expiresAt: string;
  timeoutMs: number;
  stopState: "unconfirmed" | "stopped";
};
```

- v2 schema按本版字段严格校验，不存args/env/secret或进程身份/原因字段；状态只取unconfirmed/stopped，未知状态/字段不能当有效stopped。Worker本地child/PGID仅用于本次执行和安全诊断，不承诺租约内有完整进程清单；历史Worker实例标识也不是OS强身份。
- API用 `newSortableId("lease")`，ID schema `^lease_[0-9a-z]{14}[0-9a-f]{12}$`；目录排他创建。禁止点段/分隔符/根目录删除。
- v2物理根为受信数据目录下固定容器；prepare/release/janitor不能跟随未知软链，不使用meta任意tempDir作为删除目标。
- TTL=`max(15分钟,timeoutMs+5分钟)`，timeout最多3600秒，常规到期最多65分钟；正常服务运行且清扫成功时，janitor启动/每5分钟扫描使到期后最多再等一个扫描间隔。
- expiresAt不是停止证明。unconfirmed及任何无法读取/校验的v2meta均保留；即使超过65分钟也不能自动删除凭证或解除detach/Workspace删除保护。
- 只有有效 stopped 已持久化的v2残留可按普通expiresAt回收。prepare/release故障可能需要维护，不要求所有失败自动恢复。
- 初始保护在环境发出和spawn之前写好。停止失败不需要另一个网络请求建立保护；Worker崩溃、本地诊断丢失也不解除保护。
- Worker停止成功但release未到API或确认写失败，API仍保持unconfirmed。确认写成功但删除失败/响应丢失，则按有效stopped与实际目录决定回收；Worker不能猜状态。
- v2meta损坏/丢失时不套用v1的30分钟mtime兜底。若无法确定Workspace归属，物理删除检查返回GIT_LEASE_STATE_UNAVAILABLE；恢复只能按 [RULE-LEASE-RECOVERY](implementation.md#rule-lease-recovery) 的固定维护窗口，不能仅停Worker PID。
- v1按旧expiresAt与坏meta30分钟兜底；升级前必须确认旧任务停止，不声称v1具备v2保护。
- detach/Workspace物理删除检查持有状态。正常API启动须先装配保护再恢复pending Workspace删除，覆盖Worker禁用的本地fallback；不依赖内存失败标记，fence保持pending直到持有解除。
- 剩余TTL不足覆盖timeout+收尾宽限时不spawn；用not_started证据release，不重新prepare。

### RULE-LEASE-MUTATION

- 正常API内同一lease的release和janitor共享短临界区：复用 `infra/locks/repoLock.ts` 的 `withRepoLock`，使用与真实repo ID分离的逻辑键 `git-env:v2:<leaseId>`。这是已有进程内串行能力，不是Worker进程锁或分布式锁。
- release在锁内重新检查物理根/目录是否存在、读取并验证当前meta/owner、核对可信停止证据、将unconfirmed单调持久化为stopped、删除目标目录。已stopped不降级；已不存在即幂等返回，不mkdir、不重建meta。
- janitor可在锁外枚举候选，但须在相同锁内重新读取当前meta/到期状态，仅有效stopped且到期才删除。不能凭锁外旧快照删除或写回覆盖release。
- 原子文件替换只保证单次写入不半写；上述锁才串行化读—确认—删除转换。写失败不删，删除失败不回写unconfirmed；下一次release或到期janitor可收尾。
- 临界区只做本租约校验及必要文件I/O，不等待Git结束、RPC或运维确认，不建立长DB事务。不同lease可独立处理。
- 同机维护CLI只在主API、Worker及执行已停止且自动拉起被运维禁用的窗口运行，直接调用同一服务；该独占前提由操作者保证，不引入跨进程锁。有效meta同样先stopped后删；坏meta在严格维护前提和期望状态确认后直接定点安全删除，不伪造owner、不创建替代确认文件，删失败继续unknown保护。

## RULE-PATH-CHECK

- API校验登记路径、Worker校验本地初始路径。Worker在全部RPC/本地准备后、spawn前做最终realpath/stat与可信Workspace物理根比较。
- 最终检查前的外部软链替换、缺失、非目录或越界必须拒绝；已有lease用not_started证据release。
- 最终检查返回至spawn之间有不可消除的TOCTOU窗口。本方案不使用原子目录句柄执行/沙箱，不承诺检查后外部并发替换必被拒绝；可能是原生spawn失败或不同实际目录，不能把结果作为硬隔离证明。
- 项目detach受lease保护；外部文件系统替换或原生args改目标不因该保护而消失。测试须分别控制“检查前”和“检查后”，不能用同一个拒绝断言掩盖窗口。

## RULE-EXECUTOR

### 启动

- 固定spawn git/原始args、shell:false、stdin ignore、stdout/stderr pipe；Linux/POSIX必须detached:true创建本次独立进程组，pgid=child.pid，不能继承Worker组却把child.pid误作pgid。PATH选择程序，不接受模型executable。
- 发布验收基线是具备普通进程组探测的Linux/POSIX；没有经验证等价能力的平台返回GIT_EXECUTION_PLATFORM_UNSUPPORTED。不把taskkill退出0当证明，也不把普通spawn说成强身份隔离，不改Bash。
- prepare前后、最终目录检查后和spawn前检查AbortSignal；已经取消不得先spawn再拒绝。
- timeout从spawn开始，产品1..3600秒。Node上限只作防御，RPC和清理各有deadline。
- 创建child后持有本次child对象、记录本地PGID并安装exit/close/取消/计时监听，连续跟踪本次生命周期；这些本地信息不是持久化完整进程清单或强OS身份证明。
- 必须在本次成功spawn/独立组建立的生命周期阶段使用PGID探测；尚未建立的组不能用提前ESRCH虚构停止确认。确定未启动可用not_started，启动状态未知则保守held。
- 启动后不发送状态更新；短命令可直接收尾并release，没有异步网络报告迟到覆盖stopped、复活目录或交付后追加报告失败的分支。
- 512KiB合计原始流预算和最终安全输出预算均有界；重复秘密被替换也不能绕过读取上限。

### RULE-PROCESS-SETTLEMENT

统一状态流为 `spawned → settling → stop_confirmed | stop_unconfirmed`，另有单调本地 `groupAbsentObserved` 标记；不得以stdout close作为完成条件。

| 阶段 | 动作与时限 | 证据与限制 |
|---|---|---|
| 开始收尾 | 父正常exit、取消、timeout或output-limit首次触发；保留父code/signal | 父退出只证明父 |
| 探测 | 本地持有child并连续跟踪分配的数值PGID；`kill(-pgid,0)`返回ESRCH表示本次观测时无该组 | 返回成功只表示数值组存在，不证明身份；EPERM/无法探测是未知 |
| 温和停止 | 未观察ESRCH且数值组仍存在时向该PGID发TERM，等待最多200ms并持续探测 | 信号依据是普通POSIX数值组监督，不是强身份句柄 |
| 强制停止 | 200ms后仍存在且未观察ESRCH则发KILL，最多再等1000ms确认，轮询间隔不超过20ms | 成功发送KILL不等于组已消失；不能保证清除僵尸 |
| 停止已确认 | 首次ESRCH后设置groupAbsentObserved、取消所有后续TERM/KILL与补杀；安全排空/关闭stdio最多250ms | 后续同号出现不再作为本次组追踪或发信号 |
| 停止未确认 | EPERM、探测未知、已知关联不再可信、超时，或zombie-only持续存在而未观察ESRCH | 明确失败，保留租约/删除保护，需维护恢复 |

- 正常父退出0也执行上述探测和必要TERM/KILL；后代是否继承stdio不改变规则。父退出状态独立保存，后代被终止不改写父exitCode。
- 首次ESRCH无论来自探测还是本次组信号调用都封闭后续组信号路径；定时回调、重复取消和stdio事件不得在已观察消失后再向同号发信号。
- 两次观测之间可能发生原组消失并复用同一数值的竞态，普通POSIX接口无法彻底排除。本方案接受该残余风险，不承诺识别所有复用、不把Worker实例ID当OS身份，不新增cgroup、PID取证或通用监督器。
- 若已知关联变得不可信则停止继续发信号并held；不能把“未知”伪装成不存在。无法自动识别的观测间数值重用风险不因此消失。
- zombie-only组可能仍使探测返回存在，SIGKILL不能替代父进程回收僵尸；无需新增僵尸分类器，未观察ESRCH并耗尽确认时限就按停止未确认处理，不能宣称KILL后必消失。
- 第一终止触发保持一致，后续事件不能二次spawn/回滚；现有Bash销毁stdio的1500ms兜底不是停止证据，不复制为新Git完成条件。
- 停止未确认不release、不调用builder.cleanup，只产生安全失败结果/本地诊断。prepare阶段默认unconfirmed已保护删除，无需新网络失败标记。
- 运行中meta变坏仍按v2未知状态保留；runner返回失败/session idle不能允许Workspace物理删除。
- 逃逸进程组不在本次停止确认范围内。维护证据范围与普通执行监督不同，按固定运维分支处理，不承诺全宿主自动静止证明。

## RULE-LOCAL-RECOVERY

- 同机CLI的inspect/release直接使用租约服务函数；只解析必要数据目录配置/元数据，不启动HTTP、生成临时认证token或增加API维护模式，不启动Agent模块、fallback、Worker/plugin host、调度或运行/删除恢复。
- 权限边界是既有同机OS权限、受信数据根与停机维护前提。正常Worker RPC仍内部鉴权，HTTP请求不能切换为本地维护权限。
- CLI仅机械检查数据物理根、权限、合法单个leaseId、当前meta及期望owner/state；对操作者从可靠部署信息提供的已知PID/组做有界存在性检查，存在/EPERM/未知则拒绝。数值存在性检查不是身份或全局静止证明。
- 操作者负责停止主服务/自动拉起、提供部署范围覆盖证据并显式确认；CLI不能自动判定外部supervisor是否关闭，也不能枚举/证明整个宿主静止。
- 可靠已知范围可按已知范围停止演练；坏meta或信息不齐仅接受经部署验证覆盖全部执行的受管环境全停，或系统重启后主API/Worker及自动拉起尚未启动的维护窗口。分支条件、人工证据和拒绝规则见 [RULE-LEASE-RECOVERY](implementation.md#rule-lease-recovery)。
- 可读meta必须匹配expectedOwner/expectedState；坏meta只接受unreadable/null，且满足上述完整维护窗口。已停止run可清理，缺少证据保持hold，无安全现场恢复保证，不增监督器。

## RULE-OUTPUT

### 元数据与原生输出区别

- 结果元数据不暴露cwd/env/lease/认证路径；原生stdout/stderr仍是Git输出通道，不保证任意私有路径都被识别。
- 确定性匹配集只有本次已知数据：secret原文、HTTPS实际首行去CR token、完整SSH私钥、已知token/key/askpass路径及本次lease目录的字面字符串；另处理URLuserinfo。
- 已知路径从可信响应和已验证env取得，按最长匹配优先替换为固定占位符，保留非秘密诊断。不解析所有args秘密，不识别所有用户路径，不泛化成危险内容分类器。
- 同组进程错误打印token/key/askpass位置时必须替换；仅把这些字段从结果对象删除不算通过。

### 有界匹配与sink

- provider只返回已脱敏数据，首版不输出raw运行chunk。秘密文件仅从已验证v2路径有界读取，单文件最多1MiB；失败报GIT_OUTPUT_GUARD_FAILED、不spawn。
- 已知secret和路径均跨各自stdout/stderr chunk匹配；安全处理UTF8、预算裁剪与终止尾部，不输出被截断的已知秘密/路径前缀。空秘密不作空串匹配。
- 原始读取与最终输出均合计512KiB；有限尾部不能变成无限缓存。超过预算结束并标记超限。
- 替换发生标记outputRedacted；不保存raw附件。已编码/变形秘密或任意其他私有路径不是万能识别范围，不宣传为沙箱。
- result/preview/artifact/structuredResult/capture/item/debug都接收安全结果；原生异常对象、env和raw输出不得绕过该路径。

### RULE-DIAGNOSTIC-PROJECTION

正常消息原始tool_call args按既有协议保存；本节只改变Git的额外诊断复制，不改变其他工具或模型实际执行参数。

```ts
type GitDiagnosticProjection = {
  toolName: "git";
  repo: string | null; // 仅安全名称，否则null，不复制非法输入
  argsCount: number | null;
  timeout: number | null; // 仅合法值
  stage?: string; // 固定诊断阶段
  code?: string; // 已知安全错误码
  result?: GitToolResult; // 已经过共享schema和输出安全处理
};
```

| 入口 | 必须采用的Git处理 | 不得回流 |
|---|---|---|
| capture创建 | 在无损snapshot前用安全投影取代完整args | constructor的argsSnapshot |
| 事件detail/错误 | 只构造固定stage/code和安全result，不能spread原Error/cause/outputBase | recordEvent(detail)、异常附加args/env |
| writeback output | recordWritebackAttempt/Success/Failure前投影，包括running/completed/policy_failed及失败再捕获 | outputBase.args、嵌套request/output的rawargs |
| item/debug request | request只含tool名/安全projection/必要ID，response只含安全result/code | completed或failed日志的request.args |

- 同一个Git安全投影helper为权威，实现中逐个入口接线，不以仅改provider返回值代替。capture自身收到的detail/output也需Git专属投影，防止后续新增事件把raw对象再次无损保存。
- 覆盖成功、前置失败、completed写回失败、running写回失败、工具禁用pending分支；其中禁用分支provider根本没执行，仍必须投影。
- 正常tool_call持久化继续使用原始参数，不能为了诊断安全修改用户命令或丢失历史。通用记录接口不为其他工具整体改变协议。

## 错误与结果

| code | 含义 | 时点 |
|---|---|---|
| GIT_INPUT_INVALID / GIT_TOOL_DISABLED | 参数非法/工具未启用 | 不spawn |
| RUN_CONTEXT_INVALID / RUN_NOT_EXECUTABLE | 归属或运行状态非法 | 不spawn |
| WORKSPACE_DELETING / REPO_NOT_AVAILABLE / REPO_PATH_INVALID | 删除fence/登记目标/检查时初始路径非法 | 不spawn |
| CREDENTIAL_NOT_FOUND / CREDENTIAL_DECRYPT_FAILED | 显式绑定失效/解密失败 | 不spawn |
| GIT_ENV_PREPARE_FAILED / GIT_ENV_RPC_FAILED | 环境创建/传输或响应失败 | 不spawn |
| GIT_LEASE_EXPIRED / GIT_OUTPUT_GUARD_FAILED | 剩余TTL不足/输出保护无法建立 | 不spawn，用not_started释放已知租约 |
| GIT_EXECUTION_PLATFORM_UNSUPPORTED | 无已验证普通受管组停止确认能力 | prepare/spawn前拒绝 |
| GIT_NOT_AVAILABLE / GIT_SPAWN_FAILED | 程序缺失/启动失败 | 不虚构父退出结果 |
| GIT_PROCESS_STOP_UNCONFIRMED | 普通受管组监督未确认停止 | 保留父code，整体失败并持有 |
| REPO_GIT_BUSY / GIT_LEASE_STATE_UNAVAILABLE | detach/删除保护忙碌或不可判定 | 不物理删除 |

- 已启动后的无身份、无upstream、未知参数、认证拒绝、lock冲突等保留原生结果，不做stderr分类器。
- transport/body/error内容映射安全code和固定说明；不转发完整异常路径或response body。
- 取消写回遵循现有runner，但物理删除不得只看run终态；维护恢复见[实施文档](implementation.md#rule-lease-recovery)。
