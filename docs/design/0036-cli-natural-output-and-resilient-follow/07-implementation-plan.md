# 开发任务拆分、实施步骤与审查门禁

## 工作方式

- 本文保留批准时的任务拆分，实施已按五阶段开展并执行构建和测试，实际结果见[实施与验收证据](08-implementation-and-evidence.md)。实际顺序将“自然语言输出与安全增量渲染”提前于“替换协调与选择边界”，先建立权威输出／ID 发布事实，再接入协调，避免临时重复状态；产品边界不变。
- 每阶段按“开发 → 独立审查 → 修复 → 复审 → 验证记录”闭环，上一阶段阻塞问题未关闭不得宣布整体完成。
- 采用最小增量，不修改 Worker 模型重试业务、不增加通用事件／重试框架、不借格式改造重构整个 CLI。
- 开始实施前读取适用 AGENTS.md，检查工作区并保留未知变更；不得擅自提交、还原用户文件或操作目录外数据。

## 阶段：共享契约与 API 证明

### 开发任务

- 在 [agent-message.ts](../../../packages/shared/src/contracts/agent-message.ts) 定义严格 `AgentHeadReplacementProofSchema`、类型和可选 headReplacement 字段，核查 [index.ts](../../../packages/shared/src/index.ts) 的实际导出链。
- 在 [SqliteMessageQuery.getTimeline](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts) 将 session／messages／Part／execution／proof 纳入同一同步读快照。
- 实现受授权边界限制的 from 读取、当前链同槽位候选定位、最多 256 边的反向证明；摘要失败缺省，不输出旧内容。
- 核查 [agent-public.routes.ts](../../../apps/api/src/modules/agent/routes/agent-public.routes.ts) 的 response schema 及 service/composition 类型贯通，不新增任意历史查询参数。
- 不修改 [replaceStreamingAssistant](../../../apps/api/src/modules/agent/agent-message.store.ts) 和 [replaceAssistantForRetry](../../../apps/agent-worker/src/runtime/runner.ts) 的写入规则；只将其作为测试 fixture 和不变量来源。

### 审查与验收

- 对应 ACC-PROOF 全组：真实 A→B→C、旧槽位不在最终 head／尾页、256 边界、循环／断链／越界、revision、一致性视图、Fastify 序列化。
- 检查普通 getMessage 仍然拒绝不可见消息；不得把新摘要误做成历史详情接口。
- 检查正常无证明不会返回 500、不改变原 timelineReset 和分页含义。

### 验证命令（开发阶段执行）

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
./node_modules/.bin/tsx --test apps/api/src/modules/agent/read-side/sqlite-message-query.test.ts
```

- 路由／共享 schema 新测试加入对应测试门禁后执行；若拆成新文件，必须登记实际命令及验收 ID。

## 阶段：只读重试与错误分类

### 开发任务

- 在 [http.ts](../../../packages/cli/src/http.ts) 区分真正 transport、单请求 timeout、外部中断和 HTTP status。
- 在 [errors.ts](../../../packages/cli/src/errors.ts) 保留不可打印的 RetryEvidence；所有错误复制／包装路径显式传播。
- 在 [agent-api.ts](../../../packages/cli/src/agent-api.ts) 给 follow 显式启用的单个 GET 逻辑调用加有限 retry；POST 硬性禁用，普通 API 默认无策略。
- 保持 renew-before-error 的既有优先级，续签保存失败强制 blocked；将精确 cursor-not-found/message-not-found 安全码仅用于受限协调。
- 在 [follow-lifetime.ts](../../../packages/cli/src/follow-lifetime.ts) 复用可取消等待，确保退避能被时限／信号／输出失败立即终止。
- 在 follow 初始化及 control/send 的只读准备调用中传入能力，不包围整个 accept／observe 函数；配置加载、本地保存和写请求不重试。
- 以最小诊断写入调整实现有界自然语言重试提示，不暴露分类证据、URL、草稿 ID。

### 审查与验收

- 对应 ACC-RETRY 全组及 ACC-DIAGNOSTIC：四次尝试、固定延迟、每请求独立预算、无整轮重放、HTTP500不重试、Cookie 主次错误组合、普通非 follow 不受影响。
- 必须用假时钟断言退避与取消，不让测试真实等待七秒才证明次数。
- 验证输出异常不走网络 retry，所有副作用请求仍一次。

### 验证命令（开发阶段执行）

```bash
npm run typecheck -w packages/cli
./node_modules/.bin/tsx --test packages/cli/tests/http.test.ts packages/cli/tests/http-boundaries.test.ts packages/cli/tests/follow-lifetime.test.ts
```

- 新增 follow 只读重试测试文件，建议命名 `follow-read-retry.test.ts`；覆盖初始化、分页、状态、终态补读，不把通用 HttpClient 单测当作 follow 范围验证。

## 阶段：替换协调与选择边界

### 开发任务

- 在 [messages.ts](../../../packages/cli/src/messages.ts) 解析并严格校验可选证明，保留最小内部 LayoutPart 身份。
- 在 [follow.ts](../../../packages/cli/src/follow.ts) 将 explicitAfter、autoInitialHead、硬历史、mutable head、RebuildStage 分开；不全局删除 assertRetained/assertVisible。
- 消费证明映射唯一可变槽位，支持多次遗漏替换及候选在更老页、后面已有 D/E 的情况。
- reset 重建先定位新槽位和稳定保护前缀；before 页较新时用关闭 delta 消费更新，禁止跳 watermark。实现明确的结构协调让出点：非目标后缀 head/root 变化、reset 或可变 cursor 失效时，在下一轮重建前只读固定 r1 状态，避免 refresh 内部无限协调而无法发现终态。
- 增加局部 FinalDrain 状态与 ENTER/OPEN/BUILD/CHECK/DECIDE/DONE/FAIL 转换；冻结 r1 终态、选择／硬保护和每 pass 起始 head/revision/root。OPEN 扣除一次 pass，最多两次；CHECK 发出前标记 closeUsed，每 pass 最多一个关闭 delta。
- 固定前缀向较低 depth 分页，后来 r2 追加不扩充范围；第一次关闭需结构重定位才可使用第二 pass，第二次仍不充分以 OBSERVATION_INCOMPLETE/6 收尾并保留 r1 结果。proof、cursor 恢复、root 变化、网络重试均不得创建额外 pass／关闭读。
- 实现精确、受证明约束的可变页 cursor 失效协调；没有证明时不能无限 snapshot 重试。
- 迁移 [follow-idle.ts](../../../packages/cli/src/follow-idle.ts) 的有界关闭读为可带 knownHead 的 delta，保留 source 和 H0 不变量；不把 idle 变成等未来任务。
- 保留固定 Run 状态查询、终态后 final drain 和已知 Run 结果在观察失败时的传播。

### 审查与验收

- 对应 ACC-RECONCILE、ACC-SELECTION、ACC-FINAL-DRAIN 全组；断言最多两个 pass、每 pass 至多一个关闭逻辑读，r2 追加不触发第二 pass，网络四次尝试不重置结构预算。
- 显式 after=A 被替换必须失败；自动 head=A 合法替换则成功。两者必须成对测试，不能只测成功路径。
- 受保护的其他 Run 历史、已选择／已输出消息或硬锚点非法变化，即使同时有合法证明仍失败；未选择／未输出的 r2 后缀正常追加／更新／替换不能一律失败，证明也不能用于豁免相关保护范围。
- 仔细审查分页／reset／关闭 delta 的每次 watermark 来源、缓存 commit 时机和旧 proof 的失效条件；专门检查 readRun 前的 refresh 是否在每次非目标结构变化后及时让出。
- 用受控时序模拟 r2 连续替换／root 变化夹在分页与两次关闭读之间：第二 pass 仍不充分就退出，已知 r1 成功结果不能丢，也不能等待 r2。

### 验证命令（开发阶段执行）

```bash
npm run build -w packages/shared
npm run typecheck -w packages/cli
./node_modules/.bin/tsx --test packages/cli/tests/follow.test.ts packages/cli/tests/follow-context.test.ts packages/cli/tests/follow-idle.test.ts packages/cli/tests/messages.test.ts
```

- 建议新增 `follow-head-replacement.test.ts`，但不建立脱离现有 fixture 的大框架；后续完整 API/CLI 场景仍需验证真实证明。

## 阶段：自然语言输出与安全增量渲染

### 开发任务

- 从 [program.ts](../../../packages/cli/src/program.ts)、[arguments.ts](../../../packages/cli/src/arguments.ts)、dependencies 和各命令移除外部 json 布尔分支；未知 `--json` 保持本地参数错误。
- 清理 [output.ts](../../../packages/cli/src/output.ts) 的 JSON 成功／事件输出，保留文本背压与 best-effort 诊断；不删除用于内部解析的 JSON 代码。
- 重写 [FollowOutput](../../../packages/cli/src/follow-output.ts) 的消息渲染状态：规范稳定前缀、Part 身份／业务封口、局部 snapshot_end flush、CRLF／代理项暂存、独立尝试正文、footer 与 ReleasedIdentity。
- 快照 writer 结束时完整 flush 所读版本，但不把 streaming 改成终态、不授予 ID；follow 保持尾部暂存到业务封口。用 outputMode/pendingTail/localFlushComplete 将两类边界显式建模。
- metadata 改显式白名单；检查 readMessage、分页、proof、withErrorDetails 和错误模板，禁止草稿 ID 旁路。
- 所有命令文本结果保留必要状态／错误码／phase/effect／published；`session messages` snapshot 统一正文规范和尾部 ID，不增续读提示。
- 对作废草稿写清晰分隔和作废标记，新尝试独立开始；无 ANSI，不在终态重复正文。

### 审查与验收

- 对应 ACC-COMMAND、ACC-RENDER、ACC-ID、ACC-DIAGNOSTIC 全组。
- 使用可控 Writable 证明正文回调前无 ID；检查中断、EPIPE、footer 失败和异常上下文，而不只检查 happy path。
- 长文测试同时验证写出量、顺序和规范结果；raw delta 独立 escape 的实现即使 ASCII 测试通过也不得合入。
- 增加 follow／非 follow 的尾部 CR 与孤立高代理成对字节断言：快照局部 flush 无丢尾、仍 streaming 无 ID；follow 先只输出 A，后续补 LF／低代理或业务终态时产生正确后缀。
- 审查全部对外 ID 来源，区分触发用户消息 ID 与尚未终结 assistant ID。

### 验证命令（开发阶段执行）

```bash
npm run typecheck -w packages/cli
npm test -w packages/cli
```

- 建议新增 `follow-rendering.test.ts`；`npm test` 会先构建 CLI；实施使用实际新增的 `message-render.test.ts`。

## 阶段：测试、帮助与发布收尾

### 现有测试迁移清单

| 文件／组 | 调整与必须保留的断言 |
| --- | --- |
| `arguments.test.ts`、`program.test.ts`、`help-copy.test.ts`、`bundle.test.ts` | 全层级移除合法 JSON；保留离线 help、重复参数、未知参数和构建依赖闭包 |
| `discovery.test.ts`、`session-list*.test.ts`、`session-query.test.ts`、`login.test.ts` | 从 JSON 解析迁移文本断言，保留字段正确性、身份校验、时间／范围／认证安全 |
| `messages.test.ts`、`send.test.ts`、`control.test.ts` | 普通消息过滤、after/last、受理与终态区分、写操作单次、主子会话限制 |
| `follow-fixture.ts`、`follow.test.ts`、`follow-context.test.ts`、`follow-idle.test.ts` | 删除 JSONL 事件解析依赖，记录文本段与写入时序，不删除原分支／完整性用例 |
| `follow-process.test.ts`、`follow-options.test.ts`、`follow-backpressure.test.ts`、`follow-lifetime.test.ts` | 信号、deadline、背压、EPIPE、参数语义、退避即时中断 |
| `failure-output*.test.ts`、`output.test.ts` | 自然语言 code/serviceCode/effect/published；stderr 不读有界；晚到错误不失控 |
| `download*.test.ts`、`http*.test.ts`、`input.test.ts` | 移除格式假设，保留完整 body 时限、multipart、下载无覆盖、格式边界与本地 IO |
| `installation.test.ts`、`security-boundary.test.ts`、`cookie.test.ts` 等其余 CLI 测试 | 检索间接共享 fixture 依赖；保留安装、凭证与路径保护，不因没有显式 --json 就遗漏 |
| `agent-cli-agent.integration.test.ts` | 设计前 runner 固定追加 --json、`success/events` 解析 JSON；现已迁移文本断言，覆盖真实 API/Worker/CLI send/images/follow/history/compact/download；实际结果见实施证据 |
| `agent.worker.integration.test.ts` | 现有真实 Worker 调用 CLI 的安装/PATH/配置共享门禁继续有效，不改为只测 CLI 假 HTTP |
| `sqlite-message-query.test.ts` 与 API 路由测试 | 增加真实图证明、一致性读取及 response schema，保留分页／Fork／压缩历史边界 |

实际入口：[CLI 测试目录](../../../packages/cli/tests)、[API/CLI 集成测试](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts)、[真实 Worker 门禁](../../../apps/api/src/modules/agent/agent.worker.integration.test.ts)。

### 帮助与示例

- 更新 [packages/cli/README.md](../../../packages/cli/README.md)、program.ts 内的命令例子、输出／退出码说明和零重试旧描述。
- 复核 [0035 设计目录](../0035-awb-cli-agent/README.md) 的 README、01/02/03/04/05/06/07 文件。当前带 `--json` 的文件包括 01/02/04/05/06/07；没有字面参数的技术文档也可能写 JSONL 或零重试。
- 历史实现／验证记录加“被 0036 替代”的明确说明，不把历史成功记录伪造成新方案验收结果。新方案只维护本目录权威规则，避免双份冲突定义。
- 检索其他 AWB 示例、测试 helper、脚本，逐处判断归属。尤其 [file-search.ts](../../../apps/api/src/modules/files/file-search.ts) 调用的是 ripgrep `--json`，必须保留。
- 不机械删除所有 `JSON.parse/stringify`、内部 shared schema 或正文中的 JSON 示例。

### 最终验证命令（开发阶段执行）

```bash
npm run build -w packages/shared
npm run typecheck
npm test -w packages/cli
npm run test:unit -w apps/api
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
```

- Worker 门禁需要构建产物时，按原项目要求先构建 CLI／Worker；不把缺失产物误记为业务测试失败，也不忽略真实失败。
- 必要构建命令为 `npm run build -w packages/cli`、`npm run build -w apps/agent-worker`，必要时使用完整 `npm run build`；不得手工编辑 dist 代替源码构建。
- 报告每项命令是否执行及结果；环境不具备的人工终端/容器验证明确列为未覆盖，不声称通过。

## 代码审查核对清单

- 产品范围：没有 JSON 兼容模式、新恢复提示、新用户配置或推送协议。
- 写入安全：所有副作用操作最多一次；accepted/unknown/published 诊断没有缩水。
- 证明安全：同一读视图、当前可见候选、256 边上限、无旧内容、硬历史不豁免。
- 状态正确：自动 initial head 与显式 after 分开，分页不跳 watermark，固定 Run、不等待下一任务；结构协调及时查询 r1，终态 FinalDrain 严守两 pass／每 pass 一个关闭读，不追赶无关 r2。
- 输出正确：字符规范唯一，业务封口和快照局部 flush 分开；跨版本字符安全、非 follow 不丢尾且不误发 ID，正文完成才出 ID、重试作废不露 ID。
- 重试正确：白名单精确、每请求预算、配置保存 blocked、信号与 deadline 优先、输出失败不重试。
- 验证完整：验收 ID 有测试／证据映射；迁移旧断言而不是删掉困难用例。

## 交付与回滚边界

- 本次涉及 CLI、shared 和 API 只读查询的协调发布，无数据迁移；优先部署能提供可选摘要的 API，再部署新 CLI。
- 不通过改写数据库或清空历史恢复失败观察。旧 API 上无法证明替换时安全失败是预期降级，不猜测继续。
- CLI 格式删除是明确破坏兼容的发布项；回滚代码后旧 --json 能力是否恢复由版本决定，不维护长期双协议。
- 实施报告记录新增能力、确切验证结果和已知环境限制，不存真实凭证／用户数据作为证据。
