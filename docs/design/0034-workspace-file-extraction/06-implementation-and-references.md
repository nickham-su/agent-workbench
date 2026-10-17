# 开发任务、实施步骤与代码引用

## 实施前提

- 本目录只新增设计文档，不意味着业务实现已开始。开发应先通过门禁，再按职责逐步增量修改，避免先做菜单再补安全。
- 不修改无关文件，不重构整个文件服务，不引入后台任务、通用归档框架或数据库迁移。
- 所有安全/行为差异先修订设计并审查；不能在验收时以“库做不到”为理由降级。

## 开工验证门禁

| ID | 要做的验证 | 通过证据 | 失败处置 |
|---|---|---|---|
| GATE-DEPS | 核对已定 `tar@7.5.22`、`yauzl@3.4.0`、`buffer-crc32@1.0.0` 基线或不改设计的相容升级，公告/许可/Node20/22/类型 | 实际使用版本和来源记录；源码阅读不替代集成测试 | 如与公开证据矛盾，停止并报告；不擅自换库/自研扫描器/装系统命令 |
| GATE-ZIP | 固定四项 yauzl 选项、标准 UTF8/CP437/Unicode extra、lazy/backpressure、ZIP64、unsigned 增量 CRC、公开元数据长度 | A-FMT-03～06、12、A-LIMIT-03 的样本与结果，确认库兼容边界而非额外原始头保证 | 修复公开 API 适配并复测；不补完整 ZIP 扫描来凑旧稿要求 |
| GATE-TAR | Parser 公开 entry/ignoredEntry/meta/error/abort，PAX/GNU 最终值、sparse 标记、maxMetaEntrySize、完成/背压、Parser 前防二次 gzip | A-FMT-07～14、A-LIMIT-03；明确 strict 不自动使超额 ignoredEntry 失败，适配器负责转错 | 修复公开适配，发现基线 API 矛盾先报告，不继续把核心路线写成以后选库 |
| GATE-FS | lstat + O_RDONLY/NOFOLLOW/NONBLOCK + fstat、防 FIFO 阻塞、bigint 身份、同 FS no-replace link、排他 mkdir/权限/别名 | Linux 本地 FS、Node20/22 隔离测试，含无写端 FIFO 与 lstat 后替换，其他平台单独记录 | 明确不支持，不删打开标志、不退化覆盖原语 |
| GATE-FAILURE | 多顶层可见性、完整文件版本、内部别名基线、清理与未决 IO 收敛 | 发布第 N 步故障，同 inode 同长度改写、正常 unlink 后 stage 清理、commit 后清理失败 | 修复小方案并复审；不增加 hash/泛型恢复框架，不声称整体原子 |

- 门禁验证已经确定的接口路线与工程默认，不是重新选库或等待实施者猜测规则。升级若改变解析行为，记录差异并复核验收；改变不变量必须先修订设计。
- 2026-10-16 主会话已只读获取三个公开包并在内存核验 registry SHA512，没有安装/执行/落盘包；本文作者未运行功能样本。源码基线不等于安全审计、公告检查、集成/性能/平台测试通过。

## 开发任务与详细步骤

### T-GATE：核验已定路线与环境

- 阅读全部权威规则与相关当前代码，确认工作区未知变更并保留。
- 用测试专属样本完成 GATE-*，记录精确版本、能力与平台支持结果。
- 最早验证 Parser ignoredEntry/meta、TAR 层计量与 gzip magic 检查、ZIP 公开元数据累计和 CP437 正例，不在 UI 完成后补安全。
- 本轮工程默认已裁定，不再留下目的地/编码/限额/核心库路线待选；若证据与公开 API 不符先报告，而不是私自降级。
- 交付门禁记录与最小实验测试；通过后才进入解析器正式实施。

对应：全部 GATE-*，A-FMT-03～14、A-PATH-12、A-PUB-10、17～18、A-LIMIT-03。

### T-SHARED：共享格式与契约

- 增加后缀格式纯函数，明确复合后缀优先、ASCII 大小写处理，不修改真实名称。
- 增加解压请求/结果 TypeBox schema 和类型、共享入口导出。
- 请求 path schema 固定 minLength 1/maxLength 4096 字符；服务规范/字节校验另测，框架先拒绝不强行统一业务 code。
- 契约不包含目的地/覆盖等参数，不增加任务实体或文件列表字段。
- 增加纯函数/契约测试：格式匹配、根目录空字符串、计数边界、支持目录伪装输入的前端拒绝条件。
- 构建共享包后再开发前后端调用，避免依赖旧产物。

对应：A-UI-01、A-API-01～02、05、A-PATH-10～11、A-FMT-01、12。

### T-PARSER：安全暂存与格式适配

- 建立受控随机暂存根和逐项所有权登记；实现源私有快照、版本观察点、流式输入配额。
- 完整复制并验证输入快照后，ZIP 按随机访问使用 yauzl 固定公开解码/严格名称/lazy/尺寸选项；成功等待惰性枚举 end、需解出文件流/尺寸/CRC、库关闭和错误收敛。内容用 crc32.unsigned 增量校验，不要求每个 ZIP 原始字节都被读，不另扫前缀/尾部或猜 GBK。
- TAR 使用 `import { Parser } from "tar"`，只用公开事件和流接口；entry 最终 path/size 校验，任何 ignoredEntry 转错，meta 同步累计并保守 sparse 拒绝，不用 tar.x/t 或私有 Symbol。
- TAR 外层仅按后缀 gzip 一次，完整 TAR 计量后、Parser 前用两字节常量前缀防再次自动 gzip；成功须完整消费顺序输入，外层 gzip 结束校验、Parser/写流均完成，不能最后 entry 结束就成功；失败可提前停止。
- 实现唯一的包内路径规范化与清单：隐式目录、可重复目录、重复文件/碰撞、`.git`、FS 别名。
- 所有流逐块配额与背压；TAR 扩展由 maxMetaEntrySize+ignoredEntry，ZIP 单条库有界读取后用公开长度累计；公开条目计数，不伪造物理头精确计数。失败 abort/停止并等 IO 收敛。
- 实现受限权限/时间规则；不恢复 archive mode/owner/xattr。
- 完整校验后返回受限清单与计数，而不是立即输出到最终目录。

对应：A-FMT-01～14、A-PATH-01～09、A-LIMIT-01～04。

### T-PUBLISH：无覆盖发布与清理

- 实现全部顶层冲突预检，含源自身、链接、空目录、保留仓库名称和实际 FS 别名。
- 按设计使用排他 mkdir 与同 FS link，所有成功步骤立即登记；不要使用普通 rename 或 recursive mkdir 合并。
- 实现最终核验/逻辑 commit，区分 commit 前回滚和 commit 后暂存清理。
- 实现逆序、逐项、身份/版本确认的 unlink 与非递归 rmdir；不确定归属保留并输出清理不完整。
- 加入阶段性测试接点或注入 FS 接口，仅服务故障测试，不暴露 HTTP 调试参数、不引入全局生产开关。
- 冻结文件 dev/ino/size/mtimeNs/ctimeNs/预期 mode 核验，commit 不只身份/尺寸；每次内部 chmod/link/unlink 前验旧预期、后核验允许变化并更新全部存活别名。目录用身份/mode/已知子项，不以不可变 mtime/ctime 判断；不加全量 hash。

对应：A-PUB-01～11、15～18、A-PATH-05、08、A-API-03～04。

### T-API：Workspace 边界、锁与路由

- 在 Workspace 文件服务接入进程槽、withMutation、区域锁和锁内重检；全部副作用和清理留在正确锁范围。
- 服务源路径规范与 UTF-8/段长校验先于槽位/区域选择，拒绝 `./repo/a.zip` 等，不改既有文件 API；schema 与服务错误分层。
- 锁内先 lstat 拒绝已知非普通源，再用 O_RDONLY|O_NOFOLLOW|O_NONBLOCK 打开和 fstat 复核，覆盖无写端 FIFO 与 lstat 后替换，不等待写端或依赖 120 秒超时兜底。
- 不重复嵌套非重入区域锁；在 gate 内重读 Workspace/仓库映射，保护已登记仓库顶层。
- 路由直接复用共享 schema，注册全部成功/错误响应状态，复用现有认证。
- 在归档边界转换固定安全错误，日志只输出安全分类与计数；清理错误保留原始 code 但不泄漏原始异常。
- 实现协作 deadline，断连不自动取消，finally 等待所有 IO 后释放句柄、锁、槽。
- 扩展路由集成测试，沿用现有上传与删除 fence 的确定性 barrier，不依赖随机 sleep 判断顺序。

对应：A-PUB-11～16、A-PATH-10～12、A-LIMIT-04～05、A-API-01～05。

### T-WEB：菜单、操作与提示

- 新增 API 封装与错误码文案；菜单组件接收 `canExtract`、忙碌禁用条件，不自行调用后端。
- ToolView 点击捕获当前节点与 scope/token，防重入、加载消息和状态释放按产品流程实现。
- 成功刷新与成功提示分离，刷新失败不改判解压结果；使用 `loadDir` 或窄刷新辅助取得真实异常，不能照抄吞错的 `refreshDir`。业务失败刷新独立兜底，网络结果未知不自动重试。
- Workspace 切换/卸载使旧回调失效并清理旧消息，不能只复用上传流程中不完整的 catch/scope 行为。
- 不发送虚假的上传事件，不扩展编辑器协议；中英文菜单与错误提示一并补齐。
- 使用小型操作辅助或组件测试验证异步状态，而不是只测试后缀函数。

对应：A-UI-01～09、A-PUB-14、A-API-03。

### T-VERIFY：独立审查与交付

- 跑完定向测试、共享构建、全仓类型检查及前后端回归，核实新测试确实被现有 gate 收集。
- 独立审查代码与本目录全部不变量；修复后复审，未关闭安全、正确性或清理问题不交付。
- 完成浏览器、真实压缩工具及目标平台人工验收；未运行项明确列出。
- 记录精确依赖版本、支持范围、实际命令与结果、已知不支持特征、设计差异及残留处理方式。
- 回滚功能时只移除本功能接点/依赖与新增代码；不删除用户已解压结果或未知暂存目录，不擅自执行 Git 恢复命令。

对应：全部 A-*、人工验收、审查清单；任何实现偏差均需重新核对对应项。

## 建议的测试组织（均为拟新增，非当前已有）

- 后端：`workspace-archive-extract.test.ts` 负责格式/路径/配额；如单文件负担过大，按 ZIP/TAR/发布边界拆测试，而非机械拆业务层。
- 后端：`workspace-archive-publication.test.ts` 负责真实 FS no-replace、故障和清理；测试注入接点应受限于内部函数参数。
- 集成：扩展现有 `workspace-files.routes.integration.test.ts`，或新增 `workspace-files.extract.integration.test.ts`；按现有 `.integration.test.ts` 命名自动收集。
- 前端：新增 `extraction.test.ts` 覆盖后缀与异步操作；必要时增加 `.component.test.ts`，由现有 component runner 执行。
- 样本构造器不依赖 zip/tar CLI；所有环境外部影响（网络、终止、权限、磁盘空间）使用隔离 fixture/注入，不能操作真实 Workspace 或填满真实磁盘。

## 自检命令

在仓库根目录执行。以下是**后续实现阶段**命令，本次文档编写未运行构建/测试。

```bash
npm run build -w packages/shared
npm run typecheck
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm run test -w apps/web
npm run build -w apps/api
npm run build -w apps/web
```

- 联调前先构建 shared；针对性测试可使用项目现有 tsx/test runner 定位实际新增测试路径，不编造已经存在的脚本。
- API 完整 `npm run test -w apps/api` 还包含独立 Worker 集成门禁，按项目回归要求和改动影响执行；本功能不修改 Worker 协议。
- 根 `npm run typecheck` 覆盖共享包、CLI、Worker、API、插件与 Web；记录真实结果，不能只检查当前文件后宣称全仓通过。
- 文档自检至少校验相对链接存在、A-* 与 T-* 映射、当前/拟新增区分、无未裁定的行为占位，以及精确代码路径/符号仍存在。

## 公开依赖源码基线与证据

以下为主会话调研员在 **2026-10-16** 读取 npm 官方公开元数据与 tarball、内存比对 registry SHA512 后提供的源码证据。包未安装、未执行、未落盘；本文采用该只读证据，不把它记成实现测试/独立安全审计。实施前仍核对公告、许可证、类型与相容版本。

| 已定依赖/最低 Node | 公开元数据与源码包 | 优先按符号核对的依据 |
|---|---|---|
| `tar@7.5.22` / Node >=18 | [registry](https://registry.npmjs.org/tar/7.5.22)、[tarball](https://registry.npmjs.org/tar/-/tar-7.5.22.tgz) | `Parser` 导出、构造选项、`entry`/`ignoredEntry`/`meta`/`error`/`abort`、ReadEntry 初始暂停与 PAX 最终值、自动 gzip 识别、`Pax.parse` 固定键行为 |
| `yauzl@3.4.0` / Node >=12 | [registry](https://registry.npmjs.org/yauzl/3.4.0)、[tarball](https://registry.npmjs.org/yauzl/-/yauzl-3.4.0.tgz) | `lazyEntries`/`decodeStrings`/`validateEntrySizes`/`strictFileNames`、标准 UTF8/CP437/Unicode Path 解码、Entry 公开名称/extra/comment 长度及 `zipfile.comment`、惰性文件流 |
| `buffer-crc32@1.0.0` / Node >=8 | [registry](https://registry.npmjs.org/buffer-crc32/1.0.0)、[tarball](https://registry.npmjs.org/buffer-crc32/-/buffer-crc32-1.0.0.tgz) | `crc32.unsigned(chunk, previous)` 增量 API 与 unsigned 返回类型；`index.d.ts` 的调用签名 |

- `tar` 包内辅助定位：`dist/esm/index.js:8–12`；`parse.js:115–121,218–228,343–364,372–389,415–440,514–524`；`pax.js:21–38,128–175`；`read-entry.js:30–68`。URL、包版本和符号是权威定位依据，行号只辅助阅读。
- `yauzl` 辅助定位：包内 README `94–133,828–848,865–875`，`index.js:303–338,827–868`；`buffer-crc32` 辅助定位为 `index.d.ts:9,34`。远程行号不作为长期接口契约。
- 这些证据支持已定的小适配路线，不支持“默认库完成所有安全要求”的结论：TAR 超额 ignoredEntry 仍需转错，meta sparse 仍需保守拒绝，Parser 前须防二次 gzip，ZIP 内容 CRC 仍须自行流式接入。
- 若落地发现公开 API 与上述证据不一致，先停止并报告，不编造私有 API、不 silently fallback 到 tar-stream/系统命令，不用完整格式扫描器掩盖差异。

## 当前代码证据索引

本表行号已经按编写时源码核对。目录为 `agent-workbench/`，下列路径均相对仓库根；不是说这些文件已包含本功能。

| 证据 ID | 路径与行号/符号 | 当前事实与拟接点 |
|---|---|---|
| C-RULES | `AGENTS.md:45–52`，共享契约/最小自检 | 路由复用 TypeBox，shared 构建和类型检查约定 |
| C-LAYOUT | `apps/web/src/features/workspace/views/WorkspaceLayout.vue:138,187–196`，`FileExplorerToolView` | Workspace `files` 工具已注册，复用现有工具，不新建入口 |
| C-TREE | `apps/web/src/features/workspace/tools/file-explorer/components/FileExplorerTree.vue:28–71,89–109` | contextmenu dropdown、条件菜单与 props；拟增加条件菜单和禁用状态 |
| C-TOOL | `apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.vue:313–333,399–404,566–595,612–633`，`loadDir`、`refreshDir`、`uploadSelectedFiles`、`onContextMenuClick` | `loadDir` 可传播异常，`refreshDir` 提示后吞错；当前已有加载和动作分派，可参考但不能照抄错误/scope 行为 |
| C-SCOPE | 同上 `:113,830–865`，`scopeSeq`、Workspace watch、`onBeforeUnmount` | 切 Workspace 增加 scope；当前卸载只注销命令，拟补操作失效/消息释放 |
| C-PREVIEW-TEST | `apps/web/src/features/workspace/tools/file-explorer/preview.test.ts:59–76,102–108` | 现有纯函数菜单可见性与点击选中目标测试可参考；不是解压测试 |
| C-WEBAPI | `apps/web/src/shared/api/api.ts:145,167–190,821–858`，`ApiError`、`toApiError`、Workspace 文件调用 | 全局无 Axios 超时设置；错误 code/status 已可保留；拟新增 extract 封装，不能假设代理无超时 |
| C-I18N | `apps/web/src/shared/i18n/locales/zh-CN.ts:685–724`、`en-US.ts:687–726`，`files` | 中英文文件菜单/操作文案接点；不要沿用旧调研的过时行号 |
| C-CONTRACT | `packages/shared/src/contracts/workspace-files.ts:5–73`，`packages/shared/src/contracts/files.ts:5–17` | 已有文件操作契约与 `FileEntry` 的 name/path/kind，无解压契约，无需改列表实体 |
| C-EXPORT | `packages/shared/src/index.ts:13–14` | files/workspace-files 契约已有通配导出；格式纯函数新模块须另导出 |
| C-ERROR | `packages/shared/src/contracts/common.ts:4–9`；`apps/api/src/app/errors.ts:1–14`；`apps/api/src/app/createApp.ts:65–83` | 标准 message/code、HttpError、全局错误 handler；归档错误需预先安全分类，避免原始异常落日志 |
| C-ROUTES | `apps/api/src/modules/workspaces/workspace-files.routes.ts:86–244,257–272,276–314` | 当前文件操作/上传/下载；没有 extract；下载使用 archiver 生成 ZIP |
| C-LIFECYCLE | `apps/api/src/infra/locks/workspace-lifecycle-coordinator.ts:6–11,29–49`，`withMutation` | 单进程 admission 与删除 fence，不替代区域锁，不跨进程；全部 mutation 留在回调内 |
| C-LOCKS | `apps/api/src/infra/locks/workspaceLock.ts:25–32`；`workspaceRepoLock.ts:27–37` | 单进程队列锁、finally 释放；不是可取消、跨进程或可重入锁 |
| C-SCOPE-SERVICE | `apps/api/src/modules/workspaces/workspace-files.service.ts:273–302,379–386`，`buildWorkspaceScope`、`resolveWorkspaceDomain`、`resolveWorkspaceRepoRootAbs` | Workspace 预期根与 DB 路径校验，仓库映射与保护根；不操作全局仓库根 |
| C-PATH | 同上 `:105–138,304–358,397–442` | 相对路径、.git、lstat/realpath/父目录检查；文件树跳过链接；这些不自动覆盖归档内部路径，也不是无竞态证明 |
| C-UPLOAD | 同上 `:1070–1106,1153–1173`，`resolveWorkspaceUploadTarget`、`withWorkspaceUploadLock` | 现有区域解析/锁、wx 不覆盖写入可参考；现有失败清理不等于本方案逐项所有权协议 |
| C-REPO-FILES | `apps/api/src/modules/files/files.service.ts:202–246`，`getTargetInfoOrThrow`、路径检查 | 当前操作的是 Workspace repo 映射目录，未发现此文件链路中的独立 readOnly 标志；不凭空新增或绕过其他仓库访问入口 |
| C-INTEGRATION | `apps/api/src/modules/workspaces/workspace-files.routes.integration.test.ts:36–52,55–110` | 已有 restored fence/上传与删除竞争测试，使用 barrier 可参考扩展 |
| C-DEPS | `apps/api/package.json:18–39`；`package-lock.json:2379,6825` | API 直接依赖 archiver，无 yauzl/CRC/TAR 直接声明；锁文件含 tar-stream 间接依赖，不能当 API 契约 |
| C-DEPLOY | `Dockerfile:36–43` | Node22 Debian 镜像显式安装 zip/unzip；不代表本地部署有命令，本方案不依赖它们 |
| C-TEST-RUNNER | `apps/api/scripts/run-tests.mjs:24–44`；`apps/web/scripts/run-tests.mjs:13–30` | 后端按 integration 后缀分组，前端普通测试及 component runner 分流；确保新测试被 gate 收集 |
| C-SCRIPTS | 根 `package.json:14–16`；`apps/api/package.json:5–16`；`apps/web/package.json:5–10` | 构建/typecheck/test 的实际脚本，不新增无必要的测试运行框架 |

## 当前事实与拟新增内容的界线

- 已有：文件树条件菜单、Workspace 文件 API、路径与区域解析、生命周期/区域锁、上传加载/刷新、标准错误 code 和测试基础。
- 拟新增：extract 接口/契约、共享格式规则、解析依赖、受控解压/发布/清理实现、菜单交互及本功能测试。
- 主会话已提供上述公开依赖源码只读基线，核心接口路线已定；本轮没有安装/执行依赖、运行门禁样本或真实磁盘/浏览器解压，也未完成安全审计/性能/平台验收，这些仍由实施阶段提供真实结果。
