# 开发任务与实施步骤

## 开工条件

- 先阅读本目录契约与验收矩阵，核对当前 API 未漂移；有不成立的接口假设立即回报，不把新增后端改造藏在 CLI 任务里。
- `--kind` 兼容处理已裁决：默认primary、兼容弃用primary、拒绝subtask/all且本地退出2；独立文档复审通过后进入开发，不另设legacy能力或改API。
- 实施前只读检查工作区状态，保留用户已有变更；原文档阶段不授权 Git 写操作；本次用户已另行授权由首席助理在每阶段审查通过后执行 git add，仍不授权 commit/reset/checkout 等操作。
- 所有测试文件、临时HOME和夹具位于项目内隔离目录；不读取真实登录缓存、`.env.local`、密钥或运行数据库。

## 文件触点建议

下表是最小职责建议，不要求机械地创建每个文件；同一规则应只有一处实现。

| 现有/建议文件 | 改动职责 |
|---|---|
| `packages/cli/src/program.ts` | 命令树、统一别名、继承选项、帮助优先、参数互斥和兼容提示 |
| `packages/cli/src/cli.ts` | 进程退出与信号/EPIPE结果传播，不直接执行业务 |
| `packages/cli/src/errors.ts` | 保留原类别并补 phase/effect/context、Run终态/监听码，安全诊断 |
| `packages/cli/src/http.ts` | JSON/multipart/二进制传输、超时Abort、同源/manual redirect、零重试 |
| 现有 `config.ts/cookie.ts/login.ts` | 复用安全约定；为新命令复用必要适配，不改缓存版本/增加配置平台 |
| 现有 `session-query.ts/session-list.ts/session-list-output.ts` | 主会话默认、兼容处理、JSON模式；保留窗口/计数/验证 |
| 建议 `output.ts` | 人类/单JSON/JSONL、安全错误与stdout背压，一处定义输出协议 |
| 建议 `agent-api.ts` | 窄公开API客户端、DTO验证/投影、统一续签处理，不复刻服务端业务 |
| 建议 `discovery.ts/session-commands.ts` | 发现/详情/状态/取消/压缩调用组合，可按实际大小拆分 |
| 建议 `send.ts/input.ts` | 本地输入预检、固定Agent、一次创建发送、未知结果上下文 |
| 建议 `messages.ts/follow.ts` | 当前分支分页、普通消息投影、cursor/reset与固定Run排干 |
| 建议 `download.ts` | 二进制落临时文件、长度校验、无覆盖发布与本次资源清理 |
| `packages/cli/tests/*.test.ts` | 单元、受控HTTP/文件系统、时钟、子进程和构建闭包回归 |
| `packages/cli/README.md` | 完整命令、帮助示例、兼容迁移、输出/退出码、限制与风险 |

不改 `apps/api`、`apps/agent-worker`、`packages/shared` 产品代码；本次实施允许最小更新既有 API 目录 CLI 查询测试预期，并新增隔离公开 API CLI 集成测试；可在CLI测试中用现有公开类型或授权夹具，不依赖数据库直读验证业务结果。

## T-BASE：协议、命令与帮助基础

依赖：独立文档复审通过；落实已定兼容规则。

- 扩展 `CliExitCode` 和安全错误结构，先固定单JSON/JSONL事件schema以及effect语义，避免各命令自造格式。
- 为根级 --json/--timeout 定义位置/继承/重复校验；单值别名规范化后统一校验，不在原始字符串扫描器上继续堆分支。
- 最终注册全部分组和动作；可执行注册随所属阶段接通，不提交假成功占位。高频-w/-s/-a/-f/-n一致；保留login和version。
- 将帮助识别提前到配置/网络/本地输入之前，已知帮助不被缺必填/坏文件阻断；未知命令仍安全失败。
- 按已定规则实现 --kind，新增默认primary、显式primary等价、subtask/all本地拒绝且HTTP为0的断言；README/帮助明确有意收缩。
- 人类元信息复用escapeDisplayText；正文按契约保留LF/正常CRLF换行、转义ESC等控制字符，不向终端发送ANSI。JSON/JSONL投影保持原文，新增对比测试。
- 扩展可注入IO/HTTP/时钟/信号边界，测试不要依赖全局process残留handler。

阶段验证：`A-HELP-*`、`A-PARSE-*`、`A-COMPAT-KIND`、基础 `A-OUTPUT-*`，现有login/program/token-input测试仍正确。

## T-HTTP：传输、鉴权与安全错误

依赖：T-BASE。

- 保留现有JSON请求路径，添加明确multipart与stream方法，不改变Cookie来源/同源检查/manual redirect。
- 统一路径段ID构建：拒绝字面点段、原值一次编码，最终URL必须与预期编码路径结构一致；测试%2e%2e与/ ? #均作为数据，不双重解码，不仅验证origin/API前缀。
- 把每次响应续签的验证与原子保存提为唯一可复用调用流程，不复制三份Cookie逻辑；正确保留主HTTP错误与次级保存错误。
- 实现完整body时限和AbortSignal合并；所有请求零自动重试，明确dispatch前后effect。
- 使用白名单错误code、本地消息和已验证身份构造失败；不要让fetch异常/服务端body进入诊断。
- 针对副作用成功但本地续签失败，保证已知session/run被保留且不继续后续操作。
- 文件流路径不得response.text；FormData不手写boundary，不JSON序列化。

阶段验证：原http/cookie/config/login测试，以及401/409/503、恶意body、续签失败、同源跳转、超时/截断及请求计数用例。

## T-READ：发现、主会话列表、详情与忙闲

依赖：T-HTTP。

- 实现工作区/Agent窄投影；工作区名称稳定排序，Agent保留后端顺序。
- 实现/复用单一默认Agent选择函数，供send/compact共享；不做模型健康探测或配置写入。
- 主会话列表强制primary，使用现有90天窗口摘要端点，不用tabs/continuable拼列表。
- 详情与状态始终显式workspace；详情主子可读，status只输出idle/running。
- 验证列表响应完整后再输出，不降低原严格DTO/窗口/去重验证。

阶段验证：全部 `A-DISCOVER-*`、`A-SESSIONS-*`、`A-CONTROL-STATUS`，人类与JSON双模式。

## T-SEND：本地输入与一次创建发送

依赖：T-READ。

- 实现UTF-8/BOM/stdin显式读取、文件类型/字节上限、图片签名与大小预检，预读实际发送字节。
- 创建前准备请求ID与完整payload尺寸；先拒本地输入、无Agent、显式Agent不可用等错误。
- 已有session检查主类型；省略时创建一次，确认响应ID后发送一次。
- 按纯文本/有图片分别构造JSON/multipart；成功只表示受理，输出ID不查询历史猜Agent。
- 故障路径分别保存phase/effect/已知ID；创建失败不发送，发送失败不重建，任何失败不自动cancel/delete。
- 用请求捕获断言每次调用随机ID，send/compact不共用；不添加--request-id或跨进程恢复存储。

阶段验证：全部 `A-SEND-*`、`A-UNKNOWN-*`；必须有“服务端已经创建但客户端收不到响应”的故障测试，而非只模拟连接建立前失败。

## T-HISTORY：普通消息投影与分页

依赖：T-HTTP、T-READ；可与T-SEND并行开发，最后对齐公共输出实体。

- 先实现普通消息判定函数及parts裁剪，测试tool-only/reasoning-only/图片/compaction/superseded边界。
- 实现snapshot/before分页，固定首head，按原始游标前进而非普通消息游标；after必须找到锚点才成功。
- 对页身份、重复ID/revision、hasMore/游标进展做断言；错误不能输出半个非-f成功列表。
- 定义初始历史frame与增量revision的独立生命周期，禁止翻页时无条件推进follow水位。
- 非-f结果聚合并按depth正序输出；不截断超过3000字符的普通正文。

阶段验证：全部 `A-MESSAGES-*`，至少包含超过500原始消息、普通消息稀疏和中途游标失效夹具。

## T-FOLLOW：固定Run、reset与最终排干

依赖：T-SEND、T-HISTORY。

- 实现send响应锚点、compact压缩前head、messages首snapshot+run-state捕获各自初始化；先metadata再消息。
- messages捕获idle必须实现技术设计的单一有界收尾：K0只由初始head本身可证明的原生来源确定，禁止跨过nullable user或继承head向前找旧Run，也不按ID模式/正文/时间推断；实体保留known/unknown及原选中ID/锚点。
- K0已知时一次终态检查、一次收尾snapshot及必要有限分页，收齐同Run最终追加后重算原选择；K0未知时稳定终结历史正常成功，出现无法证明关系的追加则OBSERVATION_INCOMPLETE/6、complete=false。所选streaming单独按可证明来源各查一次终态，不能据此提升未知K0；不等新Run、不自动重读、不新增反查API。
- 增量固定originRunId目标，按message ID+revision做upsert；人类终结正文一次，不把生成中的片段重复累加。
- 将timelineReset作为重建路径完整实现；压缩保留previous链时补页，不丢旧根前消息。
- 用指定Run公开status查询判定终态，然后补读排干；新Run不能改变目标，失败/取消与输出完整性分开。
- 实现整体follow时限、每请求时限、SIGINT/SIGTERM/EPIPE；移除计时器和handler，不发cancel。
- 分支不可恢复时显式失败；不得以新增事件API或只打印最后回答逃避最后消息和改链处理。

阶段验证：全部 `A-FOLLOW-*`，特别 `A-FOLLOW-IDLE-*`；按验收明确载荷覆盖有来源assistant追加成功、nullable user追加失败、R0+新user+R1初始化完成必须失败，以及稳定user-only/纯继承/空session成功；再覆盖streaming收尾、随后新Run隔离或证据不足失败、收尾补页/锚点失效、fast-run、reset、信号。不以人工慢模型演示替代，不将user来源伪造成非空。

## T-CONTROL：取消与手动压缩

依赖：T-READ、T-FOLLOW。

- 取消仅CLI检查主会话并调用一次原API；帮助明确处理时当前Run和级联范围，不计划expectedRunId/API guard。
- 压缩主会话/idle预查、默认Agent/新请求ID，最终让后端处理竞争冲突；不排队。
- 解释scheduled、deduplicated、空会话错误与Run终态skip/fail，不将skip即时化或改后端。
- 保留原历史/文件不变语义，用受控API/Provider夹具验证而非模拟一条固定成功字符串。

阶段验证：全部 `A-CONTROL-*`、`A-COMPACT-*`，并回归send与compact请求ID隔离。

## T-DOWNLOAD：流与无覆盖发布

依赖：T-HTTP、T-BASE；不依赖新后端能力，可与跟随开发并行。

- 实现远端词法路径与本地输出参数独立验证，不误把远端绝对路径/Content-Disposition作为本地入口。
- 在目标同目录独占随机temp、流式写入与计数；HTTP业务错误和异常body不能存为成功文件。
- 实现flush/close后atomic no-clobber发布；目标并发出现、link不支持时失败，不降级覆盖rename。
- 以本次owned temp/published状态清理；发布后失败保留已完整目标，SIGKILL遗留不自动扫描处理。
- 保留.git/软链/100MiB/空目录现状；文档列出风险而不改API，不宣称客户端验证真实路径安全。

阶段验证：全部 `A-DOWNLOAD-*`；包括本地竞争创建、流半途断开、发布后清理失败和EPIPE。

## T-DELIVERY：回归、使用说明与最终验收

依赖：上述任务全部完成。

- 更新CLI README命令树、示例、兼容迁移、JSON/JSONL与退出码；示例使用虚构ID，不含密钥/真实路径。
- 补构建产物隔离测试，验证新增multipart/stream逻辑仍能打包为单文件，不导入API服务或外部运行文件。
- 先跑CLI范围门禁，再按改动影响决定全仓回归；不得为让测试通过放宽已有安全/身份校验。
- 在授权隔离工作区执行公开API smoke，记录环境限制；Node22/Docker/真实Worker不可用时明确未验。
- 独立代码审查对照需求/契约/验收，完成“修复—复审”；新增实质边界变更需先改设计再审查。

建议门禁命令（仓库根执行；文档编写本轮未执行）：

```bash
npm run build -w packages/shared
npm run typecheck -w packages/cli
npm test -w packages/cli
npm run build -w packages/cli
```

涉及安装/打包边界时补真实产物隔离与目标环境检查；最终可运行 `npm run typecheck`、`npm run build`、`npm test` 做全仓回归，按环境与用户授权执行并保存实际结果。不得把设计文档本轮的静态检查写成上述命令已经通过。

## 实施记录要求

- 在本目录后续增加实施/验收记录或在交付说明中记录：实际修改文件、测试命令/结果、矩阵覆盖、独立审查问题关闭、未验环境。
- 一项任务结束的最低标准是代码+针对性测试+对应文档一致，不是“已经写出命令”。
- 出现API漂移/不满足方案时报告具体endpoint/响应/最小复现，先裁决再改；没有为CLI修改API的默认权限。
