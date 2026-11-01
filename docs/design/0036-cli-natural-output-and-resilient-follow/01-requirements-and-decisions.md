# 需求、业务范围与关键决策

## 背景与问题

### 设计前核查基线（非实施后现状）

- [program.ts：runCli](../../../packages/cli/src/program.ts) 将 `--json` 注册为全局选项，成功结果经 `writeSuccess` 输出单个 JSON，监听经 `FollowOutput` 输出 metadata/message/terminal JSONL；错误格式也取决于该选项。
- [follow-output.ts：FollowOutput.message](../../../packages/cli/src/follow-output.ts) 在 JSON 模式对每个新 revision 输出完整 MessageView，长文生成时会多次输出已有正文；默认文本模式只提示一次生成中，消息终结后打印一次全文。
- [follow.ts：observe](../../../packages/cli/src/follow.ts) 用 timeline delta 和指定 Run 状态进行轮询，成功的一轮后默认等待一秒；请求失败直接退出，不存在 CLI 请求重试。`runState.retryCount` 是后台执行信息，不是网络重试预算。
- [follow-chain.ts：assertRetained / assertVisible](../../../packages/cli/src/follow-chain.ts) 目前要求已输出消息仍在可见链；Worker 自动替换草稿会触发观察失败。
- [messages.ts：selectHistory](../../../packages/cli/src/messages.ts) 的 `--after` 使用 `slice(index + 1)`，排除锚点；普通可见消息限定为 user/assistant 的 text/image，工具、reasoning、系统、runtime、compaction 和 superseded 不输出。

### 产品目标

- REQ-NATURAL：CLI 主要供用户和 AI 模型调用，以易读自然语言和固定字段表达结果，不再承担结构化消息同步／导出协议职责。
- REQ-STREAM：等待任务时尽早看到 assistant 草稿，同时避免累计全文重复消耗输出额度。
- REQ-ID：只有消息内容完整输出并终结后才显示其 ID，降低用户用未完成消息 ID 配合 `--after` 而漏读内容的风险。
- REQ-REPLACE：后台正常自动重试不应使本地监听提前失败；必须区分可证明的重试替换与无关分支变化。
- REQ-READ-RETRY：短暂网络故障不能立即结束监听，但副作用操作不得自动重复。
- REQ-LIFETIME：最终结果准确区分执行成功／失败／取消与观察是否完整，保留必要错误诊断和安全边界。
- REQ-FINAL-DRAIN：后续 r2 的非相关变化不能无限拖住 r1 结束。结构协调遇到非目标后缀变化必须让出查询固定 r1；已知终态后最多两个局部重建 pass，每 pass 最多一个关闭 delta，耗尽时保留业务结果并明确观察不完整。

## 逐命令范围与影响

| 命令 | 改造后的输出 | 必须保留的业务含义与边界 |
| --- | --- | --- |
| `login` | 自然语言初始化／登录结果 | 不输出凭证；认证开启／关闭结果可理解；不自动重试登录写操作 |
| `workspace list` | ID、名称、总数 | 排序和发现规则不变；不增加自动选择 |
| `agent list` | Workspace、Agent ID、名称、用途、总数 | 不改变可用 Agent 过滤与默认选择 |
| `session list` | 筛选范围、条目字段、总数、查询结束标记 | 保持显式 Workspace／时间窗口、主会话范围、原生累计计数、时间语义 |
| `session show` | 必要 Session 字段及时间 | 可继续查看已知主／子会话；不承诺逐字段复刻原 JSON |
| `session status` | 固定状态字段 `idle/running` 配合可读说明 | 退出 0 代表查询成功，不代表 idle；不新增“忙碌退出码” |
| `session send` | 明确已受理及必要身份 | 非 follow 不等待任务成功；保留用户消息 ID、Session、Run、请求身份等已知受理信息，不自动重发 |
| `session messages` | 按链顺序的普通文本／图片和消息状态 | last 与 after 恰选一；after 排除自身；失败／取消消息不能伪装成成功答案；普通非 follow 读取不增加网络重试 |
| `session send/messages -f` | 任务头、assistant 增量正文、消息尾、任务收尾 | 固定一次 Run；不永久等待未来任务；监听中断不取消后台执行 |
| `session cancel` | 取消请求处理结果、实际会话状态 | 不是文件回滚；不删除历史；仅主会话；不得自动重试 POST |
| `session compact` | 受理信息，follow 时单独展示 Run 结果 | 保留 busy／空会话边界；区分完成、无需压缩、无进展、尾部过大、媒体重发等业务结果；不输出 compaction 正文 |
| `file download` | 本地目标、格式、字节数、发布状态 | 二进制不进入 stdout；不覆盖；`published=true` 后发生清理／输出失败也不能宣称文件不存在；不增加下载重试 |
| help／version／组帮助 | 离线自然语言帮助 | 不读取配置、不联网；移除对 AWB `--json` 的合法用法宣传 |

现状入口：[discovery.ts](../../../packages/cli/src/discovery.ts)、[session-list-output.ts](../../../packages/cli/src/session-list-output.ts)、[send.ts](../../../packages/cli/src/send.ts)、[control.ts](../../../packages/cli/src/control.ts)、[download.ts](../../../packages/cli/src/download.ts)。

## 已选决策与取舍

### 移除格式选项而非仅改变默认值

- 全面删除 CLI 成功与失败 JSON/JSONL 对外分支和 `--json` 选项识别；任何层级的该选项均为参数错误，退出 2，不联网。
- 不提供弃用兼容、隐藏别名、`--format json` 或另一套机器事件模式。
- 接受精确字段导出能力减少；未来根据实际缺失再添加必要文本字段，不在本次补齐全部 JSON 字段。
- 保留内部 HTTP JSON、TypeBox schema、配置 JSON、工具自身 JSON 参数和正文中的 JSON 内容。不得全仓库机械删除 `--json` 字符串。

### 头部身份与尾部消息 ID

- 任务头部展示稳定 Session／Run 身份；流式消息头只给角色与生成状态。
- 消息正文全部写出且进入 completed/failed/cancelled 后，消息尾才展示其 ID。
- 不输出作废草稿 ID；不输出未结束草稿的错误上下文 ID；不新增“建议续读位置”、恢复命令、游标字段或等价提示。
- 接受消息 ID 不在头部这一惯例差异，以减少漏读误操作；具体契约见[输出契约](02-output-contract.md)。
- 非 follow 快照即使业务仍 streaming，也在本次输出结束完整 flush 所读尾字符；这是局部输出完成，不是消息终结，不显示其 ID。follow 使用相同字符规范，但在业务封口前暂存不稳定尾字符。

### 继续轮询，先解决输出重复

- 继续使用现有 timeline/read-run 请求，正常轮询间隔保持一秒等待，不承诺逐 token 或严格一秒推送。
- 只改变 stdout 写入方式不会减少 HTTP 响应中的累计正文，不将网络差量协议优化加入本次。
- 后续 r2 未选择／未输出后缀的正常追加／更新不触发全局追尾或一律失败；受保护的其他 Run 历史、已选择／已输出消息非法变化仍失败。
- FinalDrain 的两 pass 是内部固定收尾预算，不新增 flags／配置、快照服务或持久化会话，网络重试不能重置它。
- TTY 与管道一致，不用 ANSI、光标回退、清屏或最终全文覆盖来“修正”已经写出的草稿。

### 两种重试分别建模

- 后台模型重试：依赖服务端可验证的替换关系，旧草稿作废，继续同一 Run。
- CLI 请求重试：只读请求每次最多四次尝试，固定 1／2／4 秒退避；不消耗整个 Run 的统一次数，不重复已确认成功的步骤。
- 只有网络／单请求超时及 HTTP 429/502/503/504 允许重试；HTTP 500 不自动重试，不以整个 exitCode 5 或 6 粗略分类。

### 必要 shared/API 支撑，不扩大历史读取权限

- 新增 `headReplacement` 是核查发现的必要支撑，设计前 API 没有该能力，现已按本目录实现。它解决旧草稿不在可见链、多次替换跨轮询遗漏时证据不足的问题。
- 复用 delta 已有 `knownHeadMessageId`，服务端验证替换链并返回常量大小摘要；最多 256 条边，超限不出具证明。
- [settings.ts](../../../packages/shared/src/contracts/settings.ts) 的 `modelRequestMaxRetries` 当前上限是 100；256 是独立的防损坏读侧资源边界，不是 CLI Run 生命周期或模型总尝试次数的新产品限制。
- 不新增表、不修改 Worker 替换事务、不开放任意不可见消息详情、不改变鉴权或 Workspace／Session 隔离。

## 非目标

- 不新增模型工具调用／结果／reasoning 展示，不改变普通消息可见性。
- 不改变 last/after、主子会话权限、Agent 选择、Fork、压缩、取消、文件发布语义。
- 不自动重新发送用户请求，不引入持久化恢复、跨进程游标、自动登录、无限网络重试或复杂重试配置。
- 不切换到下一 Run，不因 idle 永久等未来任务，不承诺外层工具实时转发或未截断。
- 不为假设的脚本继续保留机器接口；HTTP API 的安全边界不因此降低。

## 兼容性与发布要求

- 这是 CLI 输出契约的有意不兼容变化，旧脚本需移除 `--json` 或改调 HTTP API；不得静默返回另一种格式。
- 原 [CLI 集成测试](../../../apps/api/src/modules/agent/integration/agent-cli-agent.integration.test.ts) 的 设计前 runner 固定追加 `--json`，并 `JSON.parse` 成功与事件输出，已随实施迁移，不能仅更新 CLI 单测。
- 新 CLI 遇到未升级 API：普通读取可正常使用；需要替换证明而服务端未提供时明确观察不完整，不能猜测继续。API 与 shared 应先构建发布，新字段在响应 schema 中显式登记，避免 Fastify 丢弃。
- 开发时同步现有 CLI README／help／示例；历史设计按明确的替代说明更新，不把此前实现记录改写成“当时已实现”。详见[实施计划](07-implementation-plan.md)。
