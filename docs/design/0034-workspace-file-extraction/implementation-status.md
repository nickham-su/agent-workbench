# 实施状态与验证证据

本文件仅记录执行事实和设计适配，不替代 01～06 的权威需求、安全规则与验收矩阵。设计通过不等于功能已经交付。

## 阶段划分与执行调整

- 阶段一：依赖、共享格式/契约、安全解析与受控暂存；不开放 HTTP 或 UI，不写最终 Workspace 目录。
- 阶段二：源快照、生命周期/区域锁、进程槽、无覆盖发布、所有权回滚与真实 API。
- 阶段三：菜单/API 调用、异步状态与提示、前端测试及整体证据核验。
- 将 GATE 验证融入相应阶段的正式测试：解析依赖在阶段一验证，文件发布/失败门禁在阶段二实现时验证。避免要求尚未实现的发布算法先通过测试；安全不变量不变。
- 每阶段独立审查、修复与复审通过后，由主会话精确暂存；本文件不代替审查结论。

## 阶段一：独立审查与 H1 复审已通过

主会话已确认原独立审查者复审通过。以下保留阶段一实现与当时验证事实；阶段一通过不表示阶段二或完整功能通过。

### 实际范围

- `packages/shared/src/workspace-archive-formats.ts`：唯一后缀/格式检测函数；新增 extract 请求/响应 TypeBox 契约及入口导出。
- `workspace-archive-policy.ts`：生产配额、条目路径与源规范路径校验、安全错误分类。
- `workspace-archive-staging.ts`：空私有 payload 的排他写入、清单/身份登记、重复与实际 FS 名称冲突、背压、限额及最终暂存核验。
- `workspace-archive-extract.ts`：yauzl 公开随机读取适配、内容 CRC、tar.Parser 公开事件、gzip 单层解码/跨 chunk 前缀防二次解码、统一停止与收尾。
- 本阶段接口为内部 `extractArchiveToStaging({ inputPath, format, area, signal })`。输入必须是调用者已完整复制校验的私有快照，payload 必须是调用者拥有的空 `0700` 目录。
- **失败不会自行递归清理**：所有已创建节点（含失败部分文件）保留在 `ArchiveStagingArea.nodes`，未知身份不猜测。阶段二须在 IO 收敛后按所有权协议清理；不能直接将本函数暴露为 HTTP 操作。
- 最终权限保存在清单的 `finalMode`，暂存中仍为文件 `0600` / 目录 `0700`；最终 chmod 属阶段二发布。

### 已验证环境与依赖

2026-10-16，Linux 本地文件系统、Node **22.23.3**、npm **10.9.9**。没有安装系统解压工具，没有执行候选包安装脚本（npm 使用 `--ignore-scripts`）。

| API 直接依赖 | 实际精确版本 | 许可证 |
|---|---:|---|
| `tar` | 7.5.22 | BlueOak-1.0.0 |
| `yauzl` | 3.4.0 | MIT |
| `buffer-crc32` | 1.0.0 | MIT |
| `@types/yauzl`（开发） | 3.4.0 | MIT |

- 已检查包声明及随包许可证材料；上述许可为宽松许可，未引入系统二进制分发或商业解码器。
- 已执行 npm registry 公告核查（`npm audit --json`）。选定直接依赖及其依赖链名称 `@isaacs/fs-minipass/chownr/minipass/minizlib/yallist/pend` **没有命中本次返回的公告项**；这不是代码安全审计或未来无漏洞保证。
- 仓库整体 audit 返回 56 项（low 1 / moderate 18 / high 34 / critical 3）。本轮未对无关依赖进行升级或修复，也不宣称全仓依赖无漏洞。
- Node20、macOS、大小写不敏感/Unicode 规范化文件系统尚未运行，不能根据 Node22/Linux 结果宣称通过。

### 实测后的最小适配

- **合法空 TAR**：实测 `tar@7.5.22` 在 strict 下也对 1024 字节全零空包报告 `TAR_BAD_ARCHIVE`。已有 TAR 字节计量层以常量状态记录“完整输入均为零、至少两块且长度为 512 倍数”，仅对这一窄情形豁免该错误；零字节、单块和其他损坏输入仍拒绝。没有增加通用头/尾部扫描器。
- **PAX 被库静默修正的值**：Parser 会忽略负数/非数字 size，并截断 PAX path 的 NUL。为落实有效尺寸和名称规则，在公开、已有上限的 `meta` 文本中追加保守的 size 安全整数及 path/linkpath NUL 检查；不自研完整 PAX 解析器。该保守文本检查与 sparse 标记一样，可能拒绝含类似文本的描述字段。
- **ZIP 句柄所有权**：使用 yauzl 公开 `RandomAccessReader`，以受限的 positioned read 生成范围流，明确等待私有快照句柄关闭。避免范围流销毁时提前关闭被复用的 FileHandle，或失败时无法确认 close 已收敛。没有访问 yauzl 私有字段。
- **TAR EOF 后内存边界（H1）**：独立审查确认 `tar@7.5.22` 在 EOF 后继续接收 `write()` 会持续保留尾随字节，整体 TAR 字节额度不能替代内存边界。修复为监听 Parser 公开 `eof`，之后不再转发 chunk；此前仍按原 `write/drain` 背压消费有效条目，不提前丢弃尚未解析的数据。同一 chunk 内 EOF 后的剩余数据受源读取 64 KiB / 显式 gunzip 输出 16 KiB chunk 上限约束。完整源仍经过 guard 读取、计量并等待 gzip CRC/长度验证；仍调用 `parser.end()`、等待 Parser 和全部 entry IO 收敛。仅落实已认可的最小适配，保留既定尾部容忍规则，不新增扫描器或产品语义差异。
- **CRC 类型适配**：`buffer-crc32@1.0.0` 的 ESM 类型声明与实际 default 导出不匹配；使用 Node `createRequire` 加载其公开 CJS 导出，保留原有工程 tsconfig 和公开 unsigned 增量 API。
- **TAR 兼容边界**：缺少精确结束块的正常数据样本可被 Parser 接受；ZIP 尾随垃圾样本被当前 yauzl 拒绝。均按固定库公开行为测试，没有新增“必须接受/拒绝全部非规范结构”的产品保证。
- **版本检测测试**：部分本地 FS 可在同一时间戳粒度内合并两次写入。测试通过显式改变 mtime 验证“同 inode/同长度但可观察版本变化”的拒绝，不使用随机 sleep，也不声称替代内容哈希。

### 已执行命令与结果

| 命令 | 结果 |
|---|---|
| `npm run build -w packages/shared` | 通过 |
| `npm test -w packages/shared` | clean-build 门禁通过；133/133 测试通过（含新增 3 项） |
| `npm run typecheck -w apps/api` | 通过 |
| `npm run typecheck -w packages/shared` | 通过 |
| `npm run typecheck` | 全 workspace 类型检查通过 |
| `node --import tsx --test --test-timeout=20000 apps/api/src/modules/workspaces/workspace-archive-extract.test.ts` | H1 修复后 57/57 通过（原 51 项 + 新增 6 项） |
| `npm run test:unit -w apps/api` | H1 修复后两组共 1,277/1,277 通过（1,269 + 根 cwd 专属 8）；明确收集到全部 57 项归档测试 |
| `npm run build -w apps/api` | 通过 |

- 新增归档样本全部由项目内 raw fixture 构造，测试临时目录为仓库 `.tmp-tests/archive-parser-*`，逐个测试完成后清理；不调用系统归档命令、不读取用户真实包。
- 全量 API 单测最终执行将 `TMPDIR/TMP/TEMP` 指向仓库内 `.tmp-tests/extraction-unit-tmp`，npm cache 和日志在忽略的 `.awb/npm-cache`。第一次全量运行因工具 120 秒上限中断，后续使用 600 秒等待完整结果。
- **H1 回归（2026-10-16，Node22/Linux）**：新增 6 项通过公开 `Parser.write` 调用和 `eof/end` 事件观测，未访问内部 buffer/symbol，也未进行大内存分配。512 KiB 尾部样本验证普通 TAR / gzip 在 EOF 后无新 Parser 写入、总转发量受单个上游 chunk 限制，且同 chunk 内排队的 6 个有效文件完整写入并通过 staging 核验；两种格式的尾部仍触发 384 KiB TAR 流额度；gzip 尾部 CRC 和长度损坏均在已观察到 TAR EOF 后拒绝。
- H1 修复后重新执行解析定向、全量 API unit、`npm run typecheck -w apps/api` 和 `npm run typecheck`，最终均通过。一次 API unit 与全 workspace typecheck 并行时，共享包 clean-build 暂时移除 `dist`，导致 15 个测试文件 `ERR_MODULE_NOT_FOUND`；待共享包构建完成后重跑完整 API unit，1,277 项全部通过，未修改其他业务代码。最初新增的尾部限额用例把额度设为 64 KiB，会在有界 pipeline 预读且公开 EOF 尚被 entry IO 阻塞时先失败；现用 384 KiB 额度及 512 KiB 尾部，明确断言超额前已观察到 EOF。
- H1 全量 API unit 的 `TMPDIR/TMP/TEMP` 为仓库内 `.tmp-tests/extraction-h1-unit-tmp`；最终日志为 `.awb/npm-cache/extraction-h1-parser-test.log`、`extraction-h1-api-unit-final.log`、`extraction-h1-api-typecheck.log`、`extraction-h1-typecheck.log`。该轮仅修改解析模块、对应测试和本状态记录，未执行任何 Git 命令；随后由主会话确认独立复审通过。
- 测试失败样本同时检查源未变、边界哨兵未变、部分节点可检查且无后续写入；清理及最终发布的完整失败语义仍属阶段二。

### 验收覆盖与未完成项

| 验收范围 | 阶段一证据 | 尚需后续阶段 |
|---|---|---|
| A-FMT-01～14 | parser 单测涵盖 ZIP/TAR/gzip、空包、标准编码/Unicode extra、ZIP64、CRC/尺寸/损坏、PAX/GNU、类型白名单、meta 限额、gzip 错配/跨 chunk 嵌套防护 | 真实路由重验、UI 格式入口及人工常用包验收 |
| A-PATH-01～06、08～09 | 路径纯校验与真实 staging FS；重复/隐式目录、字节/深度、空格/Unicode、点文件、受限暂存与最终 mode 清单 | 最终发布权限、真实目标冲突及不同 FS 别名平台 |
| A-PATH-10～11 | 新接口源路径唯一性/UTF-8 纯函数边界 | 区域锁判定与真实路由；A-PATH-07/12 的完整源安全/FIFO 在阶段二 |
| A-LIMIT-01～04 | input stat、实际输出/单文件、节点/公开记录、元数据、完整 TAR 字节、写入背压与 live ZIP/TAR abort 收敛 | 源快照实际读取量、完整操作 deadline、发布期失败及进程槽；A-LIMIT-05 在阶段二 |
| A-UI-01、A-API-01/05 | 格式与 schema 的纯函数/契约部分 | HTTP/UI 接线和验收不计为完成 |
| A-PUB-01～18、其余 A-UI/A-API | 本阶段不开放对应行为，不标记通过 | 按阶段二/三及独立全面审查执行 |

阶段一结束时，GATE-DEPS/ZIP/TAR 已有 Node22/Linux 正式测试证据；GATE-FS/FAILURE 和真实 HTTP 尚待阶段二，浏览器与跨平台项尚待后续验收。不能将阶段一通过直接记为功能全部验收。

## 阶段二：独立审查与 H1 复审已通过

主会话已确认原独立审查者复审通过、H1 关闭，并已精确暂存阶段二变更。以下保留首轮问题、修复与红绿验证事实；阶段二通过不表示阶段三或完整功能通过。阶段二作者未执行 Git 命令、未自行暂存或启动审查，未修改前端。

### 实际范围

- `workspace-archive-owned.ts`：经 H1 修复后，从可信 Workspace 根（含根本身）经 repo 区域至源父目录的逐组件 lstat、新鲜 realpath 和持续身份重检；暂存/最终节点账本；普通文件完整版本及共享 inode 别名核验；只允许自身 chmod/link/unlink 的预期基线变化。异常文件及共享别名不重新认领；目录不按不可变 mtime/ctime 判断。
- `workspace-archive-operation.ts`：非阻塞、不跟随链接地打开普通源；私有同 FS 快照；接入阶段一安全解析；完整暂存清单核验；全部顶层预检；排他 mkdir/link 发布；最终受限权限和 commit 核验；commit 前保守回滚、commit 后仅清理暂存。
- 清理仅 unlink 已知文件、rmdir 自有空目录，不递归删除。commit 前先回滚 output，再清理 temporary；每次 unlink 后同步存活 stage/final 别名的 nlink/ctime，避免把自身操作误判为外部变化。
- `workspace-files.service.ts`：规范源字符串校验早于区域选择；全进程单槽覆盖生命周期/区域等锁、完整操作和清理；沿用 mutation admission、Workspace/repo 锁和删除 fence；锁内重读 Workspace/repo DB 映射；所有退出路径 finally 释放槽。
- `workspace-files.routes.ts`：真实 `POST /api/workspaces/:workspaceId/files/extract`，直接复用共享 schema，公开成功及全部错误响应；沿用 production 认证 guard；每次操作失败仅输出一条安全汇总，不含源绝对路径、条目名、内容或第三方异常消息。
- `workspace-archive-policy.ts`：补全本阶段固定业务消息；拒绝不能原样往返 UTF-8 的源字符串。额外请求字段不能控制目标、覆盖、合并、密码、限额或测试 hooks。
- 首轮审查前新增 `workspace-archive-operation.test.ts` 的 **41 项**真实 FS 操作测试，以及 `workspace-files.extract.integration.test.ts` 的 **18 项**SQLite-backed Fastify 集成测试；本轮 H1 再新增 3 项集成测试，HTTP 集成现为 **21 项**。断连用例使用真实 HTTP socket。

### 实测后的最小适配

- **源快照分块 IO**：采用 64 KiB FileHandle.read/write 顺序循环，逐块检查输入额度和 deadline，显式处理短写并保持背压；不额外引入读流及其句柄所有权。原源句柄一直保留到最后源版本观察，最终唯一关闭。已同步修正 04 中原“必须 autoClose:false 读流”的实现约束，源快照与检测语义不变。
- **源字符串 UTF-8 唯一性**：Node 会把未配对 UTF-16 surrogate 转为 U+FFFD，可能命中另一实际名称或改变区域选择。新增原样往返校验，合法 U+FFFD 仍可使用；不改变归档 decoder 兼容行为。已同步 02。
- **网络 FS 支持声明**：不增加 FS 品类自动探测器。网络 FS 未验证、不在首期支持声明内；实际 EXDEV/不支持原语等错误明确失败，不退化为覆盖 rename 或普通复制。对不支持错误的测试采用受控 errno 注入，不能冒充真实网络 FS 或跨设备部署验证。已同步 04。
- **deadline 与清理**：时间从进入已持锁操作起算，不包含等锁；父链及别名核验中也检查 abort，排他写入/发布前再次检查。已经发出的 IO 完成必要记账后收敛；清理不因同一个 abort 被跳过。timer 在 finally 清除，不使用 unref，避免仅等待 abort 时事件循环提前结束。
- **失败别名与提交边界**：同 inode 同长度改写、仅 mode 改动、外部替换和未知子项都保守保留；私有写入结束不能认可外部新增的 hard-link alias。输出全部核验后才逻辑 commit，commit 后清理失败保留完整输出并报告 `ARCHIVE_CLEANUP_INCOMPLETE`。
- 没有新增数据库、后台任务、CLI 依赖、密码支持或通用归档框架；没有改变阶段一 TAR EOF 后继续消费/计量上游但停止向 Parser.write 转发的实现。

### 首轮独立审查前执行的命令与结果

2026-10-16，Linux 本地文件系统，Node **22.23.3**、npm **10.9.9**。命令从仓库根执行；所有测试 TMPDIR/TMP/TEMP 指向仓库内 `.tmp-tests/extraction-stage2-tmp`，npm cache 显式指向 `.awb/npm-cache`。

| 命令 | 最终结果 |
|---|---|
| `npm test -w packages/shared` | clean-build 门禁通过；**133/133** 通过 |
| `npm run typecheck -w apps/api` | 通过 |
| `npm run build -w apps/api` | 通过 |
| `npm run test:unit -w apps/api` | 两组共 **1,318/1,318** 通过（1,310 + 根 cwd 专属 8）；含最新 41 项操作测试 |
| `npm run test:integration -w apps/api` | **443/443** 通过；含新增 18 项 HTTP 集成 |
| `node --import tsx --test --test-timeout=20000 apps/api/src/modules/workspaces/workspace-archive-extract.test.ts apps/api/src/modules/workspaces/workspace-archive-operation.test.ts apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts` | **116/116** 通过（阶段一解析 57 + 操作 41 + HTTP 18） |

- shared clean-build/test 先独立完成，再运行依赖 shared dist 的 API 验证；未把删 dist 的共享构建与 API 测试并行。
- 最终 integration 在生产实现最后修改后执行；随后仅追加 mode-only 操作单测，再重跑 unit、定向三文件、API typecheck/build，全部通过。
- 最终日志：`.awb/npm-cache/extraction-stage2-shared-final.log`、`extraction-stage2-api-typecheck-final.log`、`extraction-stage2-api-build-final.log`、`extraction-stage2-api-unit-final.log`、`extraction-stage2-api-integration-final.log`、`extraction-stage2-target-final.log`。
- 样本由现有 raw ZIP/TAR fixture 生成，不调用系统归档命令。Linux FIFO 样本仅用 mkfifo 创建；崩溃测试使用本项目内临时目录和受控子进程 SIGTERM，测试结束清理其隔离目录，不增加生产启动时盲清理。

### 阶段二验收证据映射

以下为自动化证据范围，不将含人工/前端分支的验收 ID 整体标成通过。

| 验收 ID | 本阶段证据 | 边界与后续项 |
|---|---|---|
| A-FMT-01～02、A-PATH-09 | 四格式真实 HTTP 解压，操作层空 ZIP/空 TAR、层级计数、源保留、受限最终权限及可执行位 | 常用真实包与浏览器验收仍待后续；其余格式恶意样本主要沿用阶段一 parser 单测 |
| A-PATH-07、10～12 | 源/父链接、目录/不存在源、父链身份变化、DB 路径失配；schema 与 canonical/UTF-8/段长边界；既存 FIFO 和 lstat 后替换 FIFO 及时拒绝；H1 修复后新增 Workspace 根静态链接及 repo 身份不变的 Workspace 祖先替换路由回归 | 首轮审查前未覆盖 repo 区域外层 Workspace 根，不能以原测试宣称已防该绕过；本轮新增证据见下节。FIFO 为 Linux 操作层实测；未验证其他 OS |
| A-PUB-01～04 | 既存文件、空/非空目录、链接、悬空链接、源包名和 DB 保留 repo 名整包冲突；预检后外部文件/目录竞争；目录发布竞争时保留外部空目录 inode | no-replace 在当前 Linux 本地 FS 实测；FS 名称别名平台未验证 |
| A-PUB-05～10 | 多阶段 EIO 注入、部分发布回滚；外部插入/替换/改写保留；暂存清理失败；commit 后输出保留；安全 errno 分类和汇总 | ENOSPC/EACCES/EXDEV/EOPNOTSUPP 等是注入验证，不是实际写满磁盘或异常 FS 部署 |
| A-PUB-11 | 源在 inspect/snapshot/staging 观察点被替换；同 inode 版本变化；复制中源增长触发实际读取额度 | 不承诺最后观察点后实时追踪外部源修改 |
| A-PUB-12～13 | 删除 fence；生命周期/Workspace/repo 等锁期间占槽；已准入解压及清理结束前普通文件 mutation 和 Workspace 删除等待 | 使用既有锁协议；普通 create 竞争已实测，未对上传/改名/删文件逐项重复竞争组合 |
| A-PUB-14～15 | 真实 HTTP 发布期间断连后继续完成；子进程部分发布后终止，重跑不盲目清残留 | 切页/UI 属阶段三；崩溃无整体原子回滚承诺，暂存期单独终止组合未重复执行 |
| A-PUB-16～18 | 父目录身份替换；同 inode 同长度改写与 mode-only 改动；正常内部 chmod/link/unlink 后别名同步；回滚先 final 后 stage；核验期间 abort 停止新发布但仍清理 | 不保证抵抗同 UID 恶意 TOCTOU；不使用全量内容 hash |
| A-LIMIT-01、04～05 | 源 stat/实际复制上限、操作 deadline；timeout/坏包后正常请求；等生命周期/区域锁时跨 Workspace 第二项立即忙碌；锁/槽覆盖清理 | 高压缩比、流背压与解析限额复用阶段一；不实际生成 2 GiB 样本 |
| A-API-01～05 | 根/repo 响应；production auth/OpenAPI；多余字段无效；安全错误及单条汇总；错误后再请求；schema/UTF-8/canonical 边界 | 不改变全局校验处理；UI 的本地化、提示和刷新尚未实现 |

### 未验证与交接边界

- Node20、macOS、大小写不敏感/Unicode 规范化 FS、网络 FS 未验证，不作支持通过声明。
- 前端、浏览器、人工常用归档包、完整用户闭环属于阶段三及后续验收；本阶段没有对应改动或通过结论。
- 本阶段未运行 API worker integration 或全仓根 npm test；未重跑全 workspace typecheck（已运行本阶段要求的 API typecheck）。
- 阶段二没有已确认需要用户裁决的产品阻碍；首轮审查曾暂不通过，H1 修复后已获原审查者复审确认。阶段三及整体交付结论另行核验，不以作者自测代替独立审查。

### 阶段二首轮审查 H1：完整 Workspace 边界修复与红绿证据

- **处置：Fix。** 原 repo 分支把词法映射得到的 repoRoot 直接作为 guard 起点，遗漏外层 Workspace 根；外层根预先是软链时，普通 repo 子目录的 lstat 不能发现越界。属于静态边界绕过，不属于排除的同 UID 恶意 TOCTOU。本轮没有扩大需求或降低安全边界。
- **最小修复**：service 仍在原区域锁内核对 repo DB 词法映射，但传入可信 Workspace 根和 repo 相对区域；operation 组合区域及源父目录相对路径，交给同一个现有 guard。guard 在任何 realpath 之前逐组件检查 Workspace 根本身至源父目录，整链身份一直保存在同一 guard 中，原源观察、暂存/发布、最终核验及 rollback/cleanup 均持续复核。普通 Workspace 区域保持空区域语义，没有新增通用框架。
- 生产修改仅涉及 `workspace-files.service.ts`、`workspace-archive-operation.ts`、`workspace-archive-owned.ts`；新增测试集中在 `workspace-files.extract.integration.test.ts`；同步更新 04 和本状态文档。未改其他文件、前端、共享契约或依赖。
- **真实红绿回归**：先加入测试再运行旧实现，3 项全部失败：静态 Workspace 链接下的 `repository/input.zip` 错误返回 200；两项 Workspace 祖先替换也错误返回 200。修复后同样 3 项全部通过。失败样本和链接目标均在测试 fixture 的项目内隔离目录，没有访问真实项目外路径。
- **A-PATH-07 静态链接证据**：Workspace 根指向项目内另一个隔离目录，目标同时含普通 `input.zip` 和 `repository/input.zip`。两个真实路由请求均返回 400/`ARCHIVE_PATH_INVALID`；目标两个目录的源字节、哨兵内容及完整条目集合不变，没有暂存或输出。恢复根目录后，普通区域和 repo 区域分别请求成功，验证槽及两类锁释放。
- **A-PATH-07/A-PUB-16 持续复核证据**：分别在 `before-publish` 和 `before-commit` 更换 Workspace 根目录，同时把原 repo 移回原绝对路径，明确断言 repo dev/ino 不变。这专门防止“只看 repo 身份”或“入口一次检查”的伪修复。两项均检测 Workspace 祖先变化，返回 500/`ARCHIVE_CLEANUP_INCOMPLETE`；不穿过变化边界继续清理，保留暂存及已发布的本次对象，源与新 Workspace 哨兵不变。恢复祖先后，两区域新请求成功，旧暂存仍保留、未被盲清理。原源父目录替换回归也继续通过。

本轮环境仍为 2026-10-16、Linux 本地 FS、Node 22.23.3。所有测试 `TMPDIR/TMP/TEMP` 为仓库 `.tmp-tests/extraction-stage2-tmp`，`npm_config_cache` 为仓库 `.awb/npm-cache`。

| 本轮命令 | 实际结果 |
|---|---|
| `node --import tsx --test --test-timeout=20000 --test-name-pattern='H1/' apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts`，修复前 | **0/3 通过、3 项按预期失败**，证明测试命中原缺陷 |
| 同一 H1 定向命令，修复后 | **3/3** 通过 |
| `node --import tsx --test --test-timeout=20000 apps/api/src/modules/workspaces/workspace-archive-extract.test.ts apps/api/src/modules/workspaces/workspace-archive-operation.test.ts apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts` | **119/119** 通过（解析 57 + 操作 41 + HTTP 21） |
| `npm run test:unit -w apps/api` | **1,318/1,318** 通过（1,310 + 根 cwd 专属 8） |
| `npm run test:integration -w apps/api` | **446/446** 通过 |
| `npm run typecheck -w apps/api` | 通过 |
| `npm run build -w apps/api` | 通过 |

精确日志路径：

- `.awb/npm-cache/extraction-stage2-h1-before.log`
- `.awb/npm-cache/extraction-stage2-h1-after.log`
- `.awb/npm-cache/extraction-stage2-h1-target.log`
- `.awb/npm-cache/extraction-stage2-h1-api-unit.log`
- `.awb/npm-cache/extraction-stage2-h1-api-integration.log`
- `.awb/npm-cache/extraction-stage2-h1-api-typecheck.log`
- `.awb/npm-cache/extraction-stage2-h1-api-build.log`

H1 修复轮未重跑 shared（未变更契约/依赖）、worker integration、全 workspace typecheck 或浏览器；平台未验证范围不变。**后续原独立审查者已确认 H1 关闭，主会话确认阶段二通过。** 阶段三的实际回归结果见下节。


## 阶段三：前端独立审查已通过（主会话确认）

主会话已确认阶段三独立审查通过。以下保留当时作者的实施与验证事实；阶段通过不等于最终全面审查或未执行的人工验收通过。阶段三作者没有执行 Git、处置已有变更或修改阶段一/二后端安全实现。

### 实际范围与实现决定

- `apps/web/src/shared/api/api.ts`：增加共享类型约束的 `extractWorkspaceArchive`，调用已有 POST 路由，编码 workspaceId，保留 `ApiError.code/status`。
- `apps/web/src/features/workspace/tools/file-explorer/extraction.ts`：复用共享格式判断；视图本地单操作控制器；点击同步捕获 Workspace/scope/源路径/源父目录；稳定错误 code 对应安全本地化文案，不显示 transport/raw message。
- 同目录 `FileExplorerToolView.vue`、`components/FileExplorerTree.vue`：普通支持格式文件才显示“解压”；busy 时禁用并防重入；源父目录直接使用会传播异常的 `loadDir`，不复用吞错/提示 raw error 的 `refreshDir`。成功、空包、成功但刷新失败、业务错误、结果未知分别提示；失败刷新异常不会覆盖原反馈。
- Workspace 同步 watch 和 scope/operation 对象身份共同隔离旧响应；卸载释放该操作 loading；旧 finally 不能清除新 busy。不增加 AbortSignal，不将 HTTP 断连当作后端取消；隐藏不取消，重新显示沿用 runtime refresh。不会发送 `editor.fsUploaded` 或操作编辑器内容。
- `apps/web/src/shared/i18n/locales/{zh-CN,en-US}.ts`：新增菜单与解压文案，覆盖 18 个 `ARCHIVE_*` code、Workspace 状态和安全通用 HTTP 提示；cleanup incomplete/未知结果明确可能已有输出。没有修理旧中文文件中原有的乱码内容。
- 同目录 `extraction.test.ts` 新增 13 项普通 Node 测试；`FileExplorerToolView.component.test.ts` 新增 10 项真实 Vue view/tree 挂载测试，只有 Ant overlay/渲染 plumbing 为 stub，Axios adapter 代替网络。不是浏览器或真实 HTTP 端到端测试。
- `apps/web/scripts/run-component-tests.mjs` 显式注册新组件文件（18 → 19），同步 `run-component-tests.test.mjs` 数量与包含断言。不引入框架、依赖、目的地/覆盖/密码/进度/取消界面或后台任务。
- 本目录 README 只同步设计编写基线与实施状态入口；阶段二状态依据主会话确认的复审结论更新，保留原 H1 修复和红绿证据。

### 本阶段真实命令与结果

2026-10-16，Linux 本地文件系统，Node **22.23.3**、npm **10.9.9**。命令默认从仓库根执行；TMPDIR/TMP/TEMP 均指向项目内 `.tmp-tests/extraction-stage3-tmp`，npm cache 为 `.awb/npm-cache`。没有读取敏感配置内容。shared clean-build/test 与根 typecheck 中的 shared 重建均先完成，再运行依赖 dist 的测试。

| 命令/入口 | 实际结果 | 项目内日志或说明 |
|---|---|---|
| `npm test -w packages/shared` | clean-build 门禁通过；**133/133** | `.awb/npm-cache/extraction-stage3-shared.log` |
| `npm run typecheck -w apps/web` | 通过 | 前端接线完成后定向运行 |
| `node --import tsx --test apps/web/src/features/workspace/tools/file-explorer/extraction.test.ts` | **13/13** | 后续完整 web gate 再次包含，不能重复加计 |
| `node --test apps/web/scripts/run-component-tests.test.mjs` | **20/20** | 后续完整 web gate 再次包含 |
| `componentCommand('src/features/workspace/tools/file-explorer/FileExplorerToolView.component.test.ts')` | **10/10** | 在 `apps/web` 使用既有 vite-node + DOM bootstrap；后续 gate 再次包含 |
| `npm test -w apps/web` | **806/806**，无失败/跳过：runner 自测 20 + 普通测试 372 + 19 个组件文件共 414 | `.awb/npm-cache/extraction-stage3-web-test.log`；`component:summary` completed=19、skipped=0、exitCode=0 |
| `npm run typecheck` | 所有 workspace 通过 | `.awb/npm-cache/extraction-stage3-typecheck.log` |
| `npm run build -w apps/web` | 通过 | `.awb/npm-cache/extraction-stage3-web-build.log`；有既有 Browserslist 数据旧和大 chunk 警告，不扩范围调整打包 |
| `npm run test:unit -w apps/api` | **1,318/1,318** | `.awb/npm-cache/extraction-stage3-api-unit.log`（1,310 + 根 cwd 专属 8） |
| `npm run test:integration -w apps/api` | 完整重跑 **446/446**，无失败/跳过 | `.awb/npm-cache/extraction-stage3-api-integration-rerun.log` |
| `npm run build -w apps/api` | 通过 | `.awb/npm-cache/extraction-stage3-api-build.log` |

一次合并执行 typecheck → web build → API unit → API integration → API build 的工具调用在总计 300 秒时超时；前三项已 exit 0，integration 当时仅部分执行，不能计为通过。确认原 runner 已退出后，以独立 600 秒上限完整重跑 integration（约 233 秒），并单独完成 API build。初次部分日志 `extraction-stage3-api-integration.log` 不是最终证据。没有运行根 `npm test` 或 API worker integration，不能以本表替代它们。

文档静态核验已执行：本表 63 项与权威矩阵集合相同且逐行唯一，README/本文件相对文件链接均存在，阶段二/三状态一致；各具名测试前缀能在对应最终日志中检索。完整 web 日志还单独核对了新增普通测试、组件文件正常结束及 19 文件 runner summary，避免只注册/只定向运行却漏过正式 gate。

### 63 项逐项验收证据

本表一项一行，完整对应 [05 的 63 个稳定 ID](05-acceptance-and-review.md)。引用的是**测试文件 + 可检索的真实测试名片段**，不是仅凭 ID 命中或作者声明推定通过。自动测试已执行不代表该 ID 的所有平台/人工组合通过；有未执行组合时在同一行明确列出。阶段一/二自动证据在阶段三和本次最终验证中重新执行；历史分阶段计数保留为当时快照，当前命令结果以文末最终验证表为准。

测试文件缩写：

- **S**：[workspace-archive-formats.test.ts](../../../packages/shared/tests/workspace-archive-formats.test.ts)。
- **P**：[workspace-archive-extract.test.ts](../../../apps/api/src/modules/workspaces/workspace-archive-extract.test.ts)（解析/暂存，57 项）。
- **O**：[workspace-archive-operation.test.ts](../../../apps/api/src/modules/workspaces/workspace-archive-operation.test.ts)（真实 FS 操作，当前 48 项）。
- **H**：[workspace-files.extract.integration.test.ts](../../../apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts)（SQLite + Fastify/真实 socket，当前 49 项）。
- **F**：[extraction.test.ts](../../../apps/web/src/features/workspace/tools/file-explorer/extraction.test.ts)（13 项）。
- **C**：[FileExplorerToolView.component.test.ts](../../../apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.component.test.ts)（10 项）。

| 验收 ID | 测试文件及测试名定位 | 实际证据与未执行边界 |
|---|---|---|
| A-UI-01 | F `file-only extraction visibility`；C `real tree menu only exposes supported ordinary files`；S `archive suffix detection` | 自动：四格式、大小写、复合后缀、目录/其他格式；真实右键视觉未验收 |
| A-UI-02 | F `capture primitives before awaiting`；C `menu dispatch captures the current node`、`nested source refresh uses the captured parent` | 自动：点击快照及请求中改选，不错解/错刷，无 editor upload 事件 |
| A-UI-03 | F `prevent double requests`、`pending refresh remains busy`；C `disables all extract menus`；H `second Workspace fails immediately` | 自动：视图禁用/入口防重入、API 进程单槽与等锁占槽，跨 Workspace 立即 busy |
| A-UI-04 | F `empty archive succeeds with distinct copy`；C `menu dispatch captures`、`empty results and post-success refresh failures` | 自动：正常/空包/失败的 loading 与源父目录刷新；真实浏览器消息视觉未验收 |
| A-UI-05 | F `switching scopes`、`scope identity is checked`、`switching while refreshing`、`disposal releases loading`；C `changing Workspace`、`unmount releases loading` | 自动：旧请求/旧 finally 不污染新 scope、busy 和消息；卸载不取消后端 |
| A-UI-06 | F `extraction success with refresh failure`；C `post-success refresh failures have distinct feedback` | 自动：明确已完成但刷新失败，不误报解压失败 |
| A-UI-07 | F `failed best-effort refresh`、`lost responses and unclassified proxy failures`；C `localized business failure survives`、`proxy failure is an unknown result` | 自动：未知结果、无重试、原错误保留；真实断网/代理浏览器实验未执行 |
| A-UI-08 | F `every stable archive code has safe Chinese and English copy`；C `translates Extract`、`cleanup failure warns about possible output` | 自动：完整 code 中英文、安全反馈、清理警告；真实布局/弹层无额外选项的人工检查未执行 |
| A-UI-09 | F `hiding preserves work`；C `hidden view stays busy`、`stale menu delegates source revalidation to API`；H `missing source, directories, source links and parent links` | 自动：隐藏/显示刷新、过时菜单交后端重检、源链接拒绝；真实浏览器待验收 |
| A-FMT-01 | P `preserves hierarchy, files, empty nodes and safe permissions`；O `all four filename routes`；H `real route extracts` | 自动：四后缀、结构/内容/计数/空节点/点文件/源保留；常用真实打包工具样本未验收 |
| A-FMT-02 | P `valid empty ZIP and TAR succeed`；O `empty archives preserve sources and clean temporaries`；C `empty results` | 自动：空 ZIP/TAR/gzip、零字节/不完整零块、零结果及清理 |
| A-FMT-03 | P `ZIP standard UTF-8, CP437 and Unicode Path extra`、`malformed UTF-8 and unmarked legacy bytes` | 自动：标准与畸形/非标准样本按库 decoder，解码后重复安全；常用工具真实中文包未验收 |
| A-FMT-04 | P `bounded ZIP64 entries, stored and deflated streams`、`ZIP64 EOCD, strong encryption and multi-disk` | 自动：stored/deflate、ZIP64 和不安全尺寸拒绝 |
| A-FMT-05 | P `CRC, declared size and truncated ZIP failures settle all writes`、`ZIP local-header differences` | 自动：错误流收敛、CRC/尺寸/截断、库容忍局部头差异；不另扫 ZIP 原始头尾 |
| A-FMT-06 | P `ZIP encryption, methods, special types and directory data`、`strong encryption and multi-disk archives` | 自动：加密/方法/特殊条目/分卷拒绝，无交互 |
| A-FMT-07 | P `TAR root, normalization, implicit directories and repeated directory declarations`、`PAX final path and size, global metadata and GNU long names` | 自动：兼容根声明、规范化、重复目录、PAX/GNU |
| A-FMT-08 | P `PAX invalid and overflowing effective sizes fail`、`PAX final path and size`、`TAR global size plus local path`、`TAR OldFile` | 自动：最终有效路径/尺寸、global/local、非整数及文本尺寸；路径字节上限另由 PATH-06 覆盖 |
| A-FMT-09 | P `TAR bad headers and truncated bodies fail`、H1 `stops Parser writes after EOF`、`long tail still exceeds TAR stream quota` | 自动：strict 错误、非规范结尾和 EOF 长尾的收敛/计量；不新增头尾扫描或宣称严格拒绝所有尾部 |
| A-FMT-10 | P `gzip CRC, truncation, non-TAR and concatenated members`、H1 `gzip trailer` | 自动：CRC/长度/截断、多 member、EOF 后 trailer 验证 |
| A-FMT-11 | P `TAR links, special and ignored objects are not silently skipped` | 自动：链接、设备、FIFO、contiguous、sparse、未知类型整包拒绝 |
| A-FMT-12 | S `archive suffix detection`；P `content mismatch fails and ZIP trailing data follows library` | 自动：后缀、内容错配及尾随库行为；未单独执行真实 SFX 样本，不承诺必拒绝 SFX |
| A-FMT-13 | P `outer format and nested gzip cannot trigger Parser auto-decompression` | 自动：格式不切换、双层 gzip、跨 chunk magic，计量不可绕过 |
| A-FMT-14 | P `metadata cap ignores are converted to 413`、`TAR links, special and ignored objects` | 自动：ignoredEntry、超额与 sparse meta 保守拒绝 |
| A-PATH-01 | P `TAR rejects dangerous effective name`；P 公用 `rejectsArchive` 哨兵断言 | 自动：遍历/绝对/UNC/盘符/反斜杠/冒号/NUL/CR/LF，失败不修改边界哨兵 |
| A-PATH-02 | P `root files, duplicate files, file parents and file/dir collisions`、`TAR root, normalization` | 自动：根普通文件拒绝、结构根跳过、路径规范化 |
| A-PATH-03 | P `TAR rejects dangerous effective name`、`PAX final path and size`、`ZIP Unicode extra path overrides` | 自动：各层大小写 .git、PAX/Unicode extra 最终路径，合法点文件保留 |
| A-PATH-04 | P `root files, duplicate files, file parents and file/dir collisions fail in either order`、`implicit directories and repeated directory declarations` | 自动：隐式/重复目录与重复文件/类型碰撞，双顺序失败 |
| A-PATH-05 | P `Linux names remain distinct, Unicode and whitespace are not rewritten` | 自动仅当前 Linux 区分名称 FS；大小写/Unicode 规范化别名 FS **未执行** |
| A-PATH-06 | P `output depth, path and UTF-8 segment exact boundaries`、`raw entry path limits include normalized and pre-normalized UTF-8 lengths` | 自动：深度/总字节/段字节边界与 +1、多字节名，无截断改名 |
| A-PATH-07 | H `source links and parent links never escape`、`mismatched Workspace/repository DB mappings`、H1 `static Workspace root symlink`；O `changed destination parent identity` | 自动：源/悬空/父链/Workspace 根、DB 映射与新鲜身份检查；原 H1 红绿证据保留于阶段二 |
| A-PATH-08 | P `safe permissions`；O `safe modes, alias unlink`、`all four filename routes`、`M4/PATH-08` 六种格式/属性组合 | 自动：危险位裁剪、暂存/最终权限；DOS/无 Unix type ZIP 不可执行，可靠 Unix/TAR 执行位保留；文件/目录 owner/group 为当前进程，固定归档 mtime 不恢复，源 mode/mtime/owner 不变；其他平台未执行 |
| A-PATH-09 | P `Unicode and whitespace are not rewritten`、`source canonical rules precede domain selection` | 自动：包内 Unicode/空格、源校验纯函数保持空格；带空格源的真实 HTTP 路由未专测 |
| A-PATH-10 | P `source canonical rules precede domain selection`；H `schema precedes canonical source rules` | 自动：规范化拒绝先于区域选择；繁简写法不切锁域 |
| A-PATH-11 | P `distinct byte errors`、`output depth, path and UTF-8 segment`；H `schema precedes canonical source rules` | 自动：源 400 与输出 413 分离、UTF-8/段长边界；不要求 OS 能创建所有理论上限名称 |
| A-PATH-12 | O `existing FIFO refuses promptly without a writer`、`lstat-then-replaced FIFO refuses promptly` | 自动仅 Linux：无写端及时拒绝且后续操作可用；macOS/其他平台未执行 |
| A-PUB-01 | O `top-level collision rejects entire archive` 六种对象 | 自动：文件、空/非空目录、链接/悬空、源自身整包冲突且既有对象不变；其他 FS 未验收 |
| A-PUB-02 | O `DB-reserved but absent repository root`；H `repository mapping, root response and absent reserved repository names` | 自动：已有/DB 保留仓库根保护、不创建伪仓库根 |
| A-PUB-03 | O `real no-replace publication`，结合发布竞争用例 | 自动：当前本地 FS 的排他发布和结果/权限；原语实现仍需独立审查，不以普通 rename 证明无覆盖 |
| A-PUB-04 | O `a concurrent`、`an empty directory racing directory publication` | 自动：预检后外部文件/目录竞争不替换、不清除外部对象，既有自有产物回滚 |
| A-PUB-05 | O `failure safely rolls back only owned output`、`is classified without exposing native paths`；H `parser/native errors are safe`、`M5/PUB` | 自动：多阶段 EIO 与 errno/身份异常；payload/owner/snapshot 首次处理错误不被 settle/close 覆盖，ZIP/TAR 格式/额度错误不被 handle close 覆盖，单独 close 失败不伪成功；真实磁盘写满/实际 OS 权限故障未执行，注入不冒充部署验证 |
| A-PUB-06 | O `failure safely rolls back only owned output`、`earlier files roll back` | 自动：部分发布后失败回滚，不返回部分成功；不承诺瞬时原子可见 |
| A-PUB-07 | O `unknown external children`、`replaced output inode`、`same-inode same-length external edits`、`externally added hard-link alias`；H `M1/PUB-07/18`（含 M5 日志断言） | 自动：保留外部插入/替换/修改；payload 写入成功/失败时新增未知 hardlink 均不登记可信、不发布或 chmod 该别名，返回清理不完整；失败分支日志保留首次 IO_FAILED，成功内容后的单独观察异常仍是 TARGET_CHANGED，均不记录假敏感原文；不递归误删 |
| A-PUB-08 | O `unknown external children prevent recursive cleanup`、`post-commit temporary cleanup failure`；H `M2/PUB-08/18` 六种组合 | 自动：commit 前后直接 mock 实际 unlink/rmdir 报错及 unlink 成功后别名观察失败，核对残留/不确定对象、独立节点继续清理、输出边界和后续准入；真实 OS 权限/存储故障未执行 |
| A-PUB-09 | O `post-commit temporary cleanup failure keeps complete output`；C `cleanup failure warns about possible output` | 自动：commit 后完整输出保留，UI 提示可能已完成并刷新 |
| A-PUB-10 | O `EXDEV is classified`、`EOPNOTSUPP is classified` | 自动为受控 errno 分类/不覆盖后备路径证据；真实跨设备、网络 FS/无能力 FS **未执行** |
| A-PUB-11 | O `source replacement at`、`source same-inode version changes during snapshot`、`actual snapshot bytes remain bounded` | 自动：多个观察点的 inode/版本/源增长，仅读私有快照解析；不承诺末次观察点后的实时追踪 |
| A-PUB-12 | H `restored deleting fence`、`deletion and file mutation wait for admitted extraction and cleanup` | 自动：删除 fence 下无暂存，已准入操作及清理结束后才删除 |
| A-PUB-13 | H `waiting for` 三种锁、`deletion and file mutation wait`、`M3/PUB-13` 六种动作/区域组合 | 自动：普通区/repo 的真实 multipart upload、rename、delete 在暂存和清理两个 barrier 均无副作用；upload 未准入、不调用 parts 消费；释放后成功。覆盖代表接点，不声称全部竞争排列 |
| A-PUB-14 | H `HTTP disconnect during publication`；F `lost responses`、`disposal`；C `changing Workspace`、`proxy failure` | 自动：发布中真实 socket 断连仍完成、UI 切 scope/卸载/未知不重试；暂存期断连及真实浏览器未单独执行 |
| A-PUB-15 | O `process termination can leave partial output`、`M3/PUB-15: stage-only process termination` | 自动：部分发布期终止保留残留并重试冲突；暂存期终止无最终输出，新请求可成功，旧暂存身份/目录/未知哨兵不变；不承诺崩溃原子回滚或盲目恢复 |
| A-PUB-16 | O `changed destination parent identity`、`abort during parent checks`；H1 `Workspace identity replacement` | 自动：父链/外层 Workspace 在发布前及 commit 前替换，保留 repo 身份也能拒绝；非同 UID 恶意 TOCTOU 完全隔离保证 |
| A-PUB-17 | O `same-inode same-length external edits`、`mode-only external changes` | 自动：完整版本异常发现、保留异常节点及 staging 别名，无全量 hash |
| A-PUB-18 | O `safe modes, alias unlink`、`rollback unlinks final before staging`、`settling a private writer cannot bless`；H `M1/PUB-07/18`、`M2/PUB-08/18` | 自动：私有 writer 规则唯一复用，异常身份/mode/nlink 不刷新可信记录；自身 chmod/link/unlink 更新存活别名，unlink 后同步失败保守保留不确定别名，回滚与后续准入正确 |
| A-LIMIT-01 | P `input, declared and actual output bounds allow equality`；O `input cap is checked before staging`、`actual snapshot bytes remain bounded` | 自动：缩小配额边界、实际流/声明双校验和源保留；未实际写满 2 GiB（验收允许） |
| A-LIMIT-02 | P `implicit directories, repeated records and roots count separately` | 自动：节点/公开条目/重复目录/根声明/隐式目录，隐藏物理头不虚构逐个计数 |
| A-LIMIT-03 | P `metadata cap ignores`、`TAR metadata exact cap and cumulative observed metadata`、H1 `long tail still exceeds` | 自动：TAR 单条/累计及全流、ZIP comment/EOCD/公开元数据累计；不声称分配前拒绝所有库字段 |
| A-LIMIT-04 | P `staging content iterator applies real write backpressure`、`a live TAR abort`、`a live ZIP abort`；O `processing deadline aborts`；H `timeout and malformed archive release` | 自动：压缩/字节额度、真实慢写背压、期限与 IO 收敛后释放；生产规模压力/实际 5 分钟等待未执行 |
| A-LIMIT-05 | H `process slot is held while waiting for` Workspace/repo/lifecycle | 自动：一个等锁、另一个立即 busy，第二 Workspace 无暂存，随后能成功 |
| A-API-01 | H `real route extracts`、`repository mapping, root response`；C `extract API wrapper uses shared request shape` | 自动：根/repo、空根 dir、计数与共享请求、URL 编码，不暴露内部路径数组 |
| A-API-02 | H `production auth guard`、`missing source, directories`、`restored deleting fence`、`body fields cannot enable behavior` | 自动：认证/不存在/删除中/额外字段边界，不允许目的地/覆盖/密码/hooks |
| A-API-03 | H `parser/native errors are safe, one summary log`；F `every stable archive code`；C `without leaking transport text` | 自动：HTTP/单条安全汇总/i18n 都不泄漏假路径内容，无 raw message 回退 |
| A-API-04 | H `next request can run`、`timeout and malformed archive release the global slot`、H1 `static Workspace root symlink`、`M1/PUB-07/18`、`M2/PUB-08/18`；P live abort | 自动：解析/超时/边界及实际清理失败后正常请求，流/锁/槽收敛；非无界长期资源 soak 保证 |
| A-API-05 | H `schema precedes canonical source rules`；P `source canonical rules precede domain selection` | 自动：缺失/空/字符数/schema 与 UTF-8 服务字节界限分离，规范响应 path/dir 原样保留 |

### 当前未执行项与交接要求

- **2026-10-16 最终审查状态**：三个开发阶段审查与全面复审全部通过，M1～M5 全部 Resolved，无剩余 Open 项（原全面审查者结论，主会话转达）；人工与平台未执行项仍保留下列边界，不因代码审查通过而视为通过。
- 真实浏览器视觉/右键浮层/断网/代理、普通目录与 repo 用户闭环、常用打包工具生成的真实归档包未执行。DOM 组件和原始 fixture 不冒充浏览器或常用工具人工验收。
- Node20、macOS、大小写不敏感/Unicode 规范化 FS、网络 FS、真实跨设备、实际磁盘/inode 耗尽或 OS 权限能力故障未执行，不声明平台通过；当前自动基线为 Linux 本地 FS + Node22。errno mock 不冒充真实异常部署。
- 原全面审查要求的权限元数据、实际清理原语及其后续别名同步、upload/rename/delete 代表竞争、暂存期终止重试均已补齐。暂存期 HTTP 断连未单列（与已验证发布期相同非取消机制，全面审查已认可此边界），带空格源的真实 HTTP 路由、所有竞争排列和长期资源压力未逐项执行，不宣称穷举验收。
- 其他依赖 audit 既有 56 项不在本轮修复范围。API worker integration 及全仓根测试已在本次真实执行，见下表；不得沿用阶段三历史“未运行”作为当前状态。
- 原全面审查者已明确最终通过；本轮仅作两份文档收尾，完成后交原审查者最终确认文本，不再安排代码复审或重跑全量测试；本作者未执行任何 Git 命令。

## 最终全面审查 M1～M4：修复与补测已获复审确认

### 四项处置与红绿证据

| 编号 | 处置及实际证据 | 范围与维护性 |
|---|---|---|
| M1 | Fix。先只增加两项真实 HTTP 回归，旧实现分别返回成功 200、`ARCHIVE_IO_FAILED`，均与要求的 `ARCHIVE_CLEANUP_INCOMPLETE` 不符（红 0/2）；修复后绿 2/2。覆盖内容完整成功及中途失败时新增未知 hardlink，未出现最终产物，未知别名仍是 0600/原内容，旧 payload 保留且下一请求可成功 | `settledArchivePrivateWriter` 为输入快照、owner、payload 唯一的私有 writer 收尾规则；仅允许合理尺寸/时间变化，身份/类型/0600/nlink=1 异常不刷新可信记录。payload 最终核验也包含 nlink，无新 FS 框架 |
| M2 | Fix（自动验收补齐，未发现需修改清理算法）。六项 HTTP 用例直接 mock 实际 `fs.unlink`、`fs.rmdir` 和 unlink 已成功后的存活别名 `lstat`，每类均测试 commit 前后；6/6 通过。确认原语确实失败、独立节点继续清理、不确定别名保留、最终输出按 commit 边界保留/回滚，源和外部哨兵不变，后续全局槽可再准入 | 使用现有 Node test mock + `syncBuiltinESMExports`，每项恢复 builtin；不增加生产注入层或 HTTP 调试字段 |
| M3 | Fix（自动验收补齐）。普通区/repo × 真实 upload/rename/delete 六项 barrier 测试，暂存与清理退出前均无副作用；upload 未准入也未开始 `parts()` 消费。另在 `staging-complete` 终止真实子进程，确认无最终输出；加入旧暂存哨兵后重试成功，旧目录身份/内容保持。7/7 通过 | 复用真实路由、multipart、区域/生命周期协调与内部 phase hook，不加恢复器、全排列或随机 sleep |
| M4 | Fix（自动验收补齐）。DOS ZIP、无 Unix type ZIP、可靠 Unix ZIP、TAR、TAR.GZ、TGZ 六项最终 FS 断言，6/6 通过。前两者不可执行，其余正常执行位保留，所有危险位裁剪；文件/目录 uid/gid 为当前进程、不恢复 archive owner/group/旧 mtime；源权限、mtime、owner、内容不变 | fixture 仅补显式 DOS mtime 与 TAR uid/gid/mtime 字段，复用原始造包；没有 chown、系统归档工具或随机 sleep |

新增 **21 项**功能回归：HTTP 14 项（M1 2 + M2 6 + M3 6），operation 7 项（M3 1 + M4 6）。原 parser 57 项不变，该轮归档三文件合计 **140 项**（57 + 48 + 35）。这些具名测试在下列完整门禁中重新执行，不与门禁总数重复加计。

### 本次真实命令与结果

2026-10-16，Linux 本地 FS、Node **22.23.3**、npm **10.9.9**。命令均从仓库根执行，统一环境如下；所有缓存/样本/临时目录在项目内，未安装新依赖、未执行 Git。shared clean-build 先独立完成，再启动依赖其 dist 的测试；根 `npm test` 按仓库既有编排实际运行，未改脚本绕过门禁。

```bash
export TMPDIR="$PWD/.tmp-tests/extraction-final-tmp"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export TSX_DISABLE_CACHE=1
export npm_config_cache="$PWD/.awb/npm-cache"
```

| 命令/入口 | 实际结果 | 项目内日志 |
|---|---|---|
| `node --import tsx --test --test-name-pattern='M1/PUB' apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts`（修复前/后） | 红 0/2 → 绿 2/2；红阶段退出 1 是预期回归证明 | `extraction-final-m1-red.log` / `extraction-final-m1-green.log` |
| 对应 `M2/PUB`、`M3/PUB`、`M4/PATH` 定向入口 | 6/6、7/7、6/6 | `extraction-final-m2.log` / `m3.log` / `m4.log`（均为同前缀） |
| `node --import tsx --test` 三个归档文件 | **140/140**，失败/取消/跳过均 0 | `extraction-final-targeted.log` |
| `npm test -w packages/shared` | clean-build 门禁及 **133/133** | `extraction-final-shared.log` |
| `npm run test:unit -w apps/api` | **1,325/1,325**（1,317 + 8），失败/跳过 0 | `extraction-final-api-unit.log` |
| `npm run test:integration -w apps/api` | **460/460**，失败/跳过 0 | `extraction-final-api-integration.log` |
| `npm test -w apps/web` | **806/806**；19 个组件文件全部执行，completed=19/skipped=0/exitCode=0 | `extraction-final-web-test.log` |
| `npm run typecheck -w apps/api` | 通过；首次新增 mock 回调缺显式类型曾报 TS7006，已补类型并重跑通过，根 typecheck 再次验证 | `extraction-final-api-typecheck.log` |
| `npm run typecheck` | 全 workspace 通过 | `extraction-final-typecheck.log` |
| `npm run build -w apps/api`、`npm run build -w apps/web` | 均通过；Web 仅既有 Browserslist/大 chunk 警告，未扩范围调整打包 | `extraction-final-api-build.log` / `extraction-final-web-build.log` |
| 根 `npm test`（含 API test gate/worker integration、worker、Web、shared、feishu、CLI） | **退出 0**，全部 6 workspace 退出 0，无 killed；下表为本次日志真实汇总，非历史记录 | `extraction-final-root-test.log`，exit 文件为 `extraction-final-root-test.exit`（0） |

所有以上日志均位于 `.awb/npm-cache/`。根测试中各 workspace 的 TAP 计数如下；每次门禁自身的子测试按 TAP 汇总计数，未把前面独立重跑再加进根总数：

| workspace | 根门禁通过数 | 组成/说明 |
|---|---:|---|
| API | 1,805 | unit 1,325 + integration 460 + worker integration 20；test gate 校验脚本亦退出 0 |
| agent-worker | 1,117 | 全 workspace 测试 |
| Web | 806 | runner 自测 20 + 普通 372 + 19 个组件文件 414 |
| shared | 133 | clean-build 后测试 |
| feishu | 12 | 插件回归 |
| CLI | 51 | CLI 回归 |
| 合计 | **3,924** | 失败、取消、跳过均 0；不代表未执行人工/平台项通过 |

本次没有新增产品语义或架构差异。此前已接受的空 TAR 窄适配、公开 meta 保守检查、Parser EOF 内存防护、有界 FileHandle 快照、源 surrogate 校验及完整 Workspace 根链全部保留。以上为 M1～M4 送审时的实现与验证记录；其后原全面审查者已将四项标记 Resolved（主会话转达）。本轮新增 M5 的处理与当前状态见下节。


## 最终全面复审 M5：已通过，M1～M5 全部 Resolved

### 处置与最小实现

M5 判定 **Fix**。保持已有安全边界、发布/清理规则与 API 契约；没有新增通用异常框架、系统解压、后台任务或 HTTP 调试参数。M1～M4 已 Resolved，本轮不扩大处置范围。

- `workspace-archive-staging.ts`：显式保存首次处理错误；无论内容成功或失败，结尾 stat/私有 writer 校验与 close 都继续执行。后续错误仅在没有先前原因时成为主因；未知 hardlink 导致校验失败时仍不更新可信 stat，保守清理不变。
- `workspace-archive-operation.ts`：owner 与输入 snapshot 共用局部 `writePrivateFile`，依次收敛处理、settle、close，保留首次原始原因供既有错误/errno 分类；没有通用 FS 抽象。
- `workspace-archive-owned.ts`：createFile 初始化失败后仍关闭 handle，后续 close 失败不覆盖初始化原因。
- `workspace-archive-extract.ts`：ZIP/TAR 及适配器接管前的 close 不覆盖已存在格式、I/O 或额度原因；无先前原因的 close 失败仍被报告。ZIP 关闭错误在已知 FS 操作边界安全分类，且保留既有处理 rejection 的权威性，避免 iterator teardown 伴随的 AbortError 遮盖原额度错误。

### 真实 HTTP 回归与红绿证据

更新原 M1 两项真实 HTTP 测试，新增 **14 项** `M5/PUB` 测试；HTTP 当前 **49 项**，归档三文件当前 **154 项**（parser 57 + operation 48 + HTTP 49）。

| 覆盖 | 实际断言 |
|---|---|
| 原 M1 两项增加日志断言 | final code 均为 CLEANUP_INCOMPLETE；内容先 EIO 时 originalCode 为 IO_FAILED，只有结尾 hardlink 观察异常时 originalCode 为 TARGET_CHANGED；未知 alias/payload 保留且为 0600，不发布、不 chmod，下一请求成功；假敏感原文不进日志 |
| payload close，两项 | 处理 EIO + close ENOSPC 保留 IO_FAILED；无先前错误的 close ENOSPC 返回 STORAGE_EXHAUSTED，不伪成功 |
| owner/snapshot，四项 | 各自覆盖 write EIO + 未知 hardlink settle 异常 + close ENOSPC，保留 IO_FAILED 并保守保留 alias；以及单独 close 失败。确认 settle/close 实际执行、无发布、后续请求可准入 |
| createFile 初始化，一项 | chmod EIO 不被 close ENOSPC 覆盖；日志安全，已知节点正常清理 |
| ZIP/TAR handle close，七项 | 两格式各覆盖无先前错误、格式失败、额度失败，并额外覆盖接管前空快照失败；close ENOSPC 不覆盖格式/额度原因，无先前错误则明确失败；清理及后续准入正常 |

先仅修改测试在旧实现执行 `--test-name-pattern='M1/PUB|M5/PUB'`：**16 项中通过 4、失败 12，退出 1（预期红）**，含 M5 报告的 M1 originalCode 错误。修复后对应 **16 项全部通过**，最终归档三文件完整重跑 **154/154**，失败/取消/跳过均为 0；不把定向重跑重复计入完整门禁总数。原有 ZIP 实际 outputBytes 配额边界测试亦通过，未以接受 AbortError 分类的方式调整契约。

### 本轮独立验证与日志

2026-10-16，Linux 本地 FS、Node 22.23.3、npm 10.9.9。从仓库根执行，`TMPDIR`/`TMP`/`TEMP` 均为 `$PWD/.tmp-tests/extraction-m5-tmp`，`TSX_DISABLE_CACHE=1`，`npm_config_cache=$PWD/.awb/npm-cache`。测试样本、缓存与临时目录均在项目内；未执行 Git 命令、未安装依赖。

| 命令/入口 | 本轮实际结果 | 项目内日志（均在 `.awb/npm-cache/`） |
|---|---|---|
| `node --import tsx --test --test-name-pattern='M1/PUB\|M5/PUB' apps/api/src/modules/workspaces/workspace-files.extract.integration.test.ts`（旧实现） | 红 4/16，退出 1 | `extraction-m5-red.log`、`extraction-m5-red.exit` |
| `node --import tsx --test` 三个归档文件 | **154/154**；其中上述 16 项均通过 | `extraction-m5-targeted.log`、`extraction-m5-targeted.exit`（0） |
| `npm run test:unit -w apps/api` | **1,325/1,325**（1,317 + 8），失败/取消/跳过均 0 | `extraction-m5-api-unit.log`、对应 `.exit`（0） |
| `npm run test:integration -w apps/api` | **474/474**，失败/取消/跳过均 0 | `extraction-m5-api-integration.log`、对应 `.exit`（0） |
| `npm run typecheck -w apps/api` | 通过 | `extraction-m5-api-typecheck.log` |
| 根 `npm run typecheck` | 全 workspace 通过 | `extraction-m5-typecheck.log`、对应 `.exit`（0） |
| `npm run build -w apps/api` | 通过；无前端/契约变更，不另重跑 Web build | `extraction-m5-api-build.log`、对应 `.exit`（0） |
| 根 `npm test` | **退出 0，6 workspace 均成功、无 killed；3,938 项通过，失败/取消/跳过均 0**。本轮最终代码实际重跑，不复用上一轮 3,924 项日志 | `extraction-m5-root-test.log`、`extraction-m5-root-test.exit`（0） |

本轮根门禁 TAP 汇总如下；单独重跑的定向、unit、integration 不重复加计：

| workspace | 本轮根门禁通过数 | 组成 |
|---|---:|---|
| API | 1,819 | unit 1,325 + integration 474 + worker integration 20 |
| agent-worker | 1,117 | 全 workspace 测试 |
| Web | 806 | runner 自测 20 + 普通 372 + 19 个组件文件 414 |
| shared | 133 | clean-build 后测试 |
| feishu | 12 | 插件回归 |
| CLI | 51 | CLI 回归 |
| 合计 | **3,938** | 失败、取消、跳过均 0 |

最终状态（2026-10-16）：**三个开发阶段审查与全面复审全部通过，M1～M5 全部 Resolved，无剩余 Open 项**（原全面审查者结论，主会话转达）。原审查者独立重跑归档 154 项 + shared/controller/runner 36 项 + 组件 10 项，合计 **200 项通过**，类型检查通过；作者本轮根 `npm test` **3,938 项**日志已由审查者独立核验，**不是审查者重跑根门禁**。真实浏览器、Node 20、macOS、大小写/Unicode 别名 FS 等未执行项不变；不将自动测试通过等同于这些人工/平台验收通过。
