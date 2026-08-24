# 测试、代码审查与验收

## 总体规则

- 必须先用冻结测试证明当前工具状态、错误文本、Abort 和成功 artifact 行为，再接入诊断能力。
- 测试不得通过修改 shared schema、API projector 或工具返回合同来让错误存储“更好测”。
- 必须同时验证开关关闭和开启；关闭测试是性能与边界合同，不是可选负例。
- 完整性测试必须使用包含敏感键名、长文本、BigInt、undefined、循环引用和 Error 自定义字段的 fixture，断言**没有脱敏和业务截断**。
- 测试产生的完整数据只能使用虚构 fixture，不得使用真实 token、用户 prompt、仓库隐私内容或生产路径。
- 文件系统测试必须在临时工作区内进行，并在 finally 清理；不得访问工作区外真实用户文件。
- 每批实现完成后必须独立代码审查；发现问题先修复，再由独立视角复审。

## 测试分层

测试分为三个执行层级，不得把慢测全部塞入普通 PR，也不得因为平台差异取消安全失败验证。

### PR 必跑

每次相关变更必须执行：

| 层级 | 建议文件 | 重点 |
|---|---|---|
| 配置 | `toolErrorCapture.test.ts` 或独立配置测试 | 只有精确 `1` 启用、进程启动读取、关闭短路 |
| 保真编码 | `losslessValueGraph.test.ts` | 特殊值、descriptor-only accessor、Error data/unavailable_accessor/absent/reflection_error 四态、循环引用、无截断 |
| 安全存储单元 | `toolErrorStore.test.ts` | 路径、临时文件、canonical/conflict、能力失败、整行最多 512 个 JavaScript 字符单元的 warning |
| Runner 行为 | `runner.tool-error-store.test.ts` | tool/policy/recovery/runtime、多阶段、完整 result/output、writer 隔离、callback 边界 |
| 取消回归 | `runner.cancel.test.ts` | Abort/用户取消不写文件 |
| 成功输出回归 | `runner.tool-output.test.ts` | 成功不记录、现有 text artifact 行为不变 |
| 类型/构建 | 现有命令 | Worker strict typecheck/build |

PR 必跑的深链 fixture 固定为 2,000 层，证明实现使用迭代 work queue 而不是浅层递归，同时控制普通 CI 耗时。

### 平台条件测试

- 至少有一个项目主要 Linux 本地/CI 环境必须实际证明 no-follow 能力可用且同目录 hard link 成功；该 job 归类为 fully supported，必须验证成功落盘。
- 在任何平台都必须通过注入或受控 fixture 验证 unsupported 分支：no-follow 不可用、hard link 不支持、`EXDEV`、只读、权限不足时不发布 final、尽力清 temp、限频 warning、Agent 主流程不变。
- 若某 CI runner 的真实工作区不满足 fully supported 条件，可以跳过“真实成功发布”平台用例，但必须明确报告 capability skip，不能把该 runner 计入成功落盘验收证据；unsupported 安全失败用例仍必须执行。
- 不得以 `process.platform` 或文件系统名称代替真实能力测试。

### 慢测/专项或夜间测试

- 10,000 层深链为最低慢测规模，推荐夜间运行 20,000 层；
- 超大字符串、超大 Map/Set/typed array、复杂共享引用图和高并发发布可放入慢测；
- 慢测仍不得设置业务截断，只允许通过测试分层控制执行频率；
- 发布前、编码器结构重构后或排查栈/内存问题时必须执行慢测。

## 环境变量测试

由于开关在模块加载/进程启动时读取，测试不得在同一已导入模块实例中修改 `process.env` 后错误地期望生效。必须采用以下一种方式：

- 将纯解析函数 `isToolErrorStoreEnabled(env)` 导出给单元测试，同时生产常量在模块加载时调用一次；并额外用子进程证明真实启动时读取；
- 或每个 env case 启动隔离 Node/tsx 子进程导入模块。

必须覆盖：

| 值 | 期望 |
|---|---|
| 未设置 | 关闭 |
| `""` | 关闭 |
| `"0"` | 关闭 |
| `"1"` | 开启 |
| `"true"` | 关闭 |
| `"yes"` | 关闭 |
| `" 1 "` | 关闭 |
| `"01"` | 关闭 |

额外断言：

- 模块加载后修改 env，不改变已固化常量；
- 关闭时触发 Provider reject 后，`.awb/agent/tool-errors` 不存在；
- 关闭时注入 spy encoder/store，断言二者均未调用；
- 关闭时 logger 不出现 tool-error-store warning。

## 保真编码测试矩阵

### Primitive

必须覆盖并精确断言 tag/value：

- `null`、`undefined`；
- true/false；
- 空字符串、长字符串、包含 NUL/换行/Unicode 的字符串；
- 普通有限数、`-0`、`NaN`、正负 Infinity；
- 正负 BigInt。

长字符串至少超过现有 `TOOL_ARTIFACT_MAX_CHARS` 默认值，证明本功能不复用成功 artifact 截断逻辑。

### 引用关系

必须覆盖：

- 对象自循环；
- 数组自循环；
- 两对象互相引用；
- 同一子对象被多个属性引用；
- 同一 Symbol 被多处引用；
- node id 和 ref 能准确表示共享/循环，不复制成互不相关值。

### 属性与描述符

必须覆盖：

- enumerable/non-enumerable string key；
- symbol key；
- writable/configurable/enumerable；
- data property 保存完整 value 和 descriptor 元数据；
- getter/setter accessor 只保存 descriptor 与函数引用/标识；
- 普通对象和 Error 自定义 getter 有副作用或会抛错时，getter 调用次数必须为 0；
- 自定义 `Symbol.toStringTag` getter 不被调用；对象 `toString/toJSON` 不被调用；
- Proxy 的 ownKeys/getOwnPropertyDescriptor/getPrototypeOf 抛错时生成 `reflection_error` 并继续/局部降级，而不是让整个编码失败；
- 输出中不得出现任何“属性求值错误”语义；反射操作自身失败只能使用 `reflection_error`；
- PR 用 2,000 层有限深对象链证明不因 JavaScript 调用栈溢出；10,000~20,000 层只属于慢测/专项层。

### Error

必须覆盖：

- `name/message/stack/cause` 分别位于 own data property、原型 data property 时，value 和 owner 来源正确；
- `name/message/stack/cause` 分别为 accessor 时，getter 调用次数为 0，语义标记为 `unavailable_accessor` 并保存 accessor descriptor；
- 字段沿原型链不存在时标记为 `absent`，不得伪造默认值；
- descriptor/原型反射抛错时标记为 `reflection_error`；
- `AggregateError.errors` 同样覆盖 `data | unavailable_accessor | absent | reflection_error` 四态；
- 不可枚举 data 标准字段；
- 自有 string/symbol data property：`code`、`stdout`、`stderr`、`partialResult`；
- 自有 accessor `partialResult/partialResults/result/subtaskSessionId/subtaskResultText` 不调用、不提取；
- 上述字段为自有 data property 时按固定 partial-result 规则完整提取；
- Error 自循环 cause/custom field；
- 非 Error throw：字符串、对象、BigInt；
- 完整 message/stack 不被脱敏或截断。

若 summary 没有可用的 data message，必须省略 summary message 或使用实体合同中明确的检索占位；不得把占位误写为 Error 语义字段。

### 内建对象

必须覆盖：

- Date、Invalid Date；
- RegExp 与 lastIndex；
- Map/Set 顺序和共享引用；
- Buffer、ArrayBuffer、typed array、DataView 的完整 bytes；
- URL/URLSearchParams；
- Function 的 name/length/toString 且不执行；
- Promise/WeakMap/WeakSet 明确标记不可观察内容，不尝试等待/枚举。

### 稳定性

对同一个无突变 fixture 连续编码两次，除 `capturedAt` 外 graph 应深度相等；node 分配顺序必须确定。对对象编码后再修改原对象，已生成快照不得变化。

## 安全存储测试矩阵

### fully supported 环境：必须成功落盘

- 测试必须先通过真实操作证明 Node no-follow 能力可用、目标目录支持同目录 hard link；
- 在 capability 成立的工作区自动创建 `.awb/agent/tool-errors/by_run/<session>/<run>`；
- 新目录在支持 POSIX mode 的平台为 `0700`，文件为 `0600`；
- JSON 两空格缩进、结尾换行，可解析且 schemaVersion/identity 正确；
- canonical 路径与本文完全一致。

项目主要成功验收基线是 Linux 本地运行环境，但不得只按 OS/文件系统名称断言 capability。权限 mode 断言可按平台能力条件化，hard-link/no-follow 成功证据不可由名称替代。

### unsupported 环境：必须安全失败

分别模拟或注入：

- Node no-follow 能力不可用；
- hard link 不支持；
- `EXDEV`；
- `EROFS/EACCES/EPERM`；
- 目标目录或工作区只读。

每种情况必须断言：

- canonical/conflict final 均不存在；
- 本次创建的 temp 能清理时已清理；清理本身失败只进入同一限频 warning 路径；
- 不使用普通 rename、不移除 no-follow、不写其他目录；
- warning 单行且最多 512 个 JavaScript 字符单元；
- Runner/Agent 主流程结果与未启用 store 时一致。

### safe path

使用包含 `/`、`..`、反斜杠、空白、Unicode、控制字符和超过 120 字符的 session/run/toolCall ID，断言：

- 路径只含允许字符；
- 不逃逸工作区；
- JSON 内保留原始 ID；
- `itemId` 仍位于基名开头；
- 两个原始 ID safe 化碰撞时，canonical 身份校验能发现。

### symlink/no-follow

必须分别建立受控 symlink：

- `.awb` 指向工作区外；
- `.awb/agent` 指向工作区外；
- `tool-errors/by_run/<session>` 指向工作区外；
- canonical final path 是 symlink；
- 临时文件候选名被预创建为 symlink。

所有场景必须：

- 工作区外文件不被创建/修改；
- writer 返回而不抛；
- Agent 主流程结果不变；
- 只出现限频 warning。

### canonical 幂等与冲突

必须覆盖：

- canonical 不存在：成功发布；
- canonical 身份一致：第二次视为幂等，不修改 mtime/content；
- canonical 合法 JSON但原始 toolCallId 不同：生成 `.conflict-<recordedAt>-1.json`；
- canonical 非 JSON：生成 conflict；
- canonical schemaVersion 未知：生成 conflict；
- conflict attempt 1 已存在：排他尝试 2；
- attempt 1..1000 全占用：失败并 warning，不覆盖；
- 并发两个相同 identity 发布：只一个 canonical，另一个幂等；
- 并发两个冲突 identity：一个 canonical、另一个 conflict，不出现半文件。

### 临时文件和故障注入

注入：

- mkdir/lstat/realpath/open/write/sync/close/link/read/unlink 的失败；
- 磁盘满 `ENOSPC`；
- 权限 `EACCES/EROFS`；
- link 不支持和 `EXDEV`；
- no-follow capability 不可用；
- JSON stringify 理论性失败（通过注入破坏后的内部实体，证明 writer 边界）。

断言：

- 不向 Runner 抛出；
- 不生成部分 final 文件；
- 能清理的 temp 被清理；清理失败不递归；
- 不回退到 rename overwrite、弱化 no-follow 或工作区外路径。

## Runner 行为测试矩阵

### Provider reject：`tool`

fixture：Provider 接收完整 args 后抛带 `code/stack/cause/partialResult` 的 Error。

必须断言：

- 生成 `<base>.tool.json`；
- `stage=provider_execute_rejected`、`failureKind=tool`；
- args 原样可从保真图恢复，包括名为 `token/password` 的 fixture 字段，值不得为 `***`；
- Error 标准字段和自定义字段完整；
- `resultAvailability=partial_from_error`，partial result 完整；
- context item 仍按现状写为 failed；
- 没有无依据的正式 result。

另测没有 partial 的 Error：`resultAvailability=not_returned`，省略 result/partialResults。

### Provider fulfilled + completed writeback succeeded

必须断言：

- Provider/result/output 捕获逻辑即使执行，最终 `.awb/agent/tool-errors` 不存在；
- context item completed output 与改造前一致；
- 成功长文本仍按现有 `.awb/agent/artifacts/by_tool_call` 逻辑处理。

### Provider fulfilled + completed writeback failed：数据丢失窗口

这是阻断性验收用例。fixture result 必须包含：

- 超长字符串；
- BigInt；
- undefined；
- 循环/共享引用；
- 名为 `secret/token` 的字段；
- Provider 返回后被测试代码原地修改的对象。

必须断言：

- 只因 Provider 本身未失败，不生成 tool 文件；
- 生成 runtime 文件，含 `completed_writeback_failed`；
- `resultAvailability=returned`；
- 保存的是 Provider fulfilled 时的即时快照，不受后续突变影响；
- completed writeback 的完整候选 `AgentToolOutput` 存在，含完整 `text/result/args/textTruncated/textArtifactPath` 中实际出现的字段；
- writeback Error 完整；
- 后续 inner/outer failed writeback attempt 按实际结果记录；
- 原 Agent 流程的最终状态/返回语义不因 writer 改变。

### Provider 中间 writeback

使用 subtask 或 stub Provider 调用 `ctx.updateToolItem()` / `reportRunningOutput()`：

- 成功中间 output 后 Provider 最终失败：tool 文件的 writebacks 含完整 running output；
- 中间 writeback reject：runtime 文件含 `running_writeback_failed`；
- 同一 Error 传播为 Provider reject 时，tool event 使用 `sameErrorId` 关联，不产生两个不同根因 ID；
- Provider 已取得的 subtask session/result 字段完整。

callback 边界测试必须额外证明：

- 当前实际 running `updateToolItem` 使用 `provider_running_update`，`reportRunningOutput` 使用 `provider_running_report`；
- 扫描/静态测试确认当前 Provider callsite 不存在 callback `completed|failed`；
- 构造一个 terminal callback fixture 时，测试必须阻断或明确报“unsupported callback terminal status”，不得自动映射到现有 role/stage；
- 未来要支持该 fixture，必须先修改本设计、枚举和测试，不能只放宽实现。

### Policy 双路径

分别强制：

- pending availableToolNames 预检禁用；
- 预检通过但 executeTool 二次检查返回 false。

断言 stage 分别准确；只生成 policy 文件；Provider 未调用；args 和 failed output 完整。构造未来式双命中/重复 helper 调用，断言同一去重 key 只出现一次。

### Recovery

以初始 `status=running` 的 pending tool：

- Provider 不调用；
- 生成 recovery 文件；
- stage 为 `running_item_recovered_as_failed`；
- `resultAvailability` 固定为 `not_started`，不得写 `not_returned`；
- 恢复前状态、完整 args、候选/成功 failed output 存在。

### 多阶段文件

Provider reject E1，inner failed writeback reject E2，outer failed writeback reject E3：

- 生成 tool 和 runtime 两个 canonical 文件；
- tool 文件含 E1；
- runtime 文件 events 按 sequence 含 `failed_writeback_failed` 和 `outer_failed_writeback_failed`；
- `runner_outer_unhandled` 只有在 E2 未被更准确分类时才出现，本用例不得重复；
- E2/E3 与 causedBy E1 关系明确；
- 每 kind 只有一个文件，事件不覆盖。

### Abort/取消

覆盖：

- 调用前 signal 已 aborted；
- Provider 抛 `AbortError`；
- signal abort 后 Provider 抛普通连接错误但 `isAbortLikeError` 判为取消；
- parent/subtask 取消；
- 取消前已有真实非取消 writeback 错误，随后再 abort。

断言：

- 纯取消无文件；
- 取消不会追加 tool/runtime 错误事件；
- 取消前已经捕获的独立非取消错误仍可发布；
- 现有 context item 和 Run 取消语义不变。

### 不记录的降级

必须注入并断言不生成 tool error 文件：

- `finalizeToolText()` 成功 artifact 写入失败但降级完成；
- `writeItemLog()` 失败；
- writer 自身失败；
- 模型 stream 错误但没有进入工具执行。

## Warning 限频测试

使用可控时钟：

- 相同 workspace+operation+errorCode 第一次立即 warn；
- 60 秒内重复不再 warn；
- 下一窗口首次 warn 包含抑制计数；
- operation 或 errorCode 不同可分别 warn；
- warning 不包含 fixture 的 token、args、result、stack；
- error message 含 `\r/\n/\r\n/U+2028/U+2029` 时输出仍只有一行，所有行分隔符被替换为空格；
- 最终 warning 整行长度不得超过 512 个 JavaScript 字符单元；
- 该整行长度截断可以裁剪日志 message 摘要，但不得改变 artifact 中完整 Error data value；
- writer warning 不触发新的 artifact。

## 代码审查清单

### 范围与合同

- 是否只有精确 env 值 `1` 开启？
- 关闭时是否在创建 capture 前短路，没有编码器和 I/O 调用？
- 是否只记录本文矩阵场景，成功/Abort/Debug Dump/artifact 降级不记录？
- 是否未改 shared schema、API endpoint、数据库、Prompt、UI、`.gitignore`？

### 数据完整性

- args 是否在执行前即时快照，且不脱敏、不截断？
- Provider result 是否在 fulfilled 后立即快照？
- completed writeback 失败是否保留 result 和候选 output？
- 所有 running/completed/failed writeback 是否走统一 wrapper？
- Error 标准字段、cause、自定义字段和非 Error throw 是否完整？
- 未返回 result 是否明确标记而非虚构 null/空对象？
- API projector 边界是否仍清晰，未宣称/实现 Worker 复制最终 message？

### 分类与时序

- stage 是否只来自中央枚举/映射？
- Provider/tool、policy、recovery、runtime 是否按本文映射？
- 内外 catch 是否通过 errorId 关联并避免重复根因？
- 同 kind 是否单文件有序 events，不同 kind 共存？
- 禁用双路径是否统一 helper、统一去重？

### 文件系统安全

- 路径是否固定且所有外部片段 safe 化？
- JSON 是否保留原始 ID 并在 canonical 已存在时校验？
- 是否逐级拒绝 symlink/非目录并反复 containment？
- temp 是否 `O_EXCL|O_NOFOLLOW`、mode 0600、完整写入+sync？
- 发布是否 hard link 排他，绝无 rename overwrite/truncate final？
- conflict 是否确定性命名并有 1000 次上限？
- writer 失败是否吞掉、限频、不递归、不回退工作区外？

### 可维护性

- Runner 是否只负责阶段和业务值，不内嵌大型 serializer/path 代码？
- 编码器/store 是否有独立单元测试？
- 是否避免为测试加入生产后门？必要依赖是否通过已有 `AgentRunnerDeps` 风格注入？
- 是否保留当前 error/status/return 行为冻结测试？

## 手工验收

在可丢弃、无真实敏感数据的测试工作区执行：

### 关闭

```bash
unset AWB_TOOL_ERROR_STORE_ENABLED
# 启动 Worker，触发受控失败工具
```

确认：

- 工具按既有方式显示失败；
- `.awb/agent/tool-errors` 不存在；
- 无相关 warning。

### 开启

```bash
AWB_TOOL_ERROR_STORE_ENABLED=1 <启动 Worker 的现有命令>
```

依次触发受控 builtin、MCP 或 plugin 失败，确认：

- 路径按 session/run/item/toolCall/kind 生成；
- JSON 可解析；
- args、Error、自定义字段完整；
- 文件权限在平台支持时为 0600；
- 不出现在模型上下文和 UI 工具输出中。

### 故障隔离

将 `.awb/agent/tool-errors` 设置为只读或用测试 symlink 构造拒绝场景，确认：

- Agent 工具失败结果与未开启时一致；
- 只出现一条受控 warning；
- 工作区外没有文件改动。

## 建议验证命令

以仓库当前脚本为准，至少执行：

```bash
npm run typecheck -w apps/agent-worker
npm run build -w apps/agent-worker

npx tsx --test \
  apps/agent-worker/src/runtime/losslessValueGraph.test.ts \
  apps/agent-worker/src/runtime/toolErrorStore.test.ts \
  apps/agent-worker/src/runtime/runner.tool-error-store.test.ts \
  apps/agent-worker/src/runtime/runner.cancel.test.ts \
  apps/agent-worker/src/runtime/runner.tool-output.test.ts
```

若实现改动了 Worker 内公用安全原语，还必须运行所有 Worker runtime 测试：

```bash
npx tsx --test $(find apps/agent-worker/src -name '*.test.ts' -print | sort)
```

最终建议运行仓库级：

```bash
npm run typecheck
npm run build
```

若全仓命令受已知非本次问题阻塞，必须记录精确命令、错误和与本次无关的证据；不得声称已通过。

## 阻断性验收标准

以下任一不满足，验收不通过：

- 默认关闭或 env 精确值合同错误；
- 关闭时创建目录、执行诊断序列化或产生该功能文件 I/O；
- 成功调用或纯 Abort 生成 error 文件；
- args/result/output/Error 被按业务内容脱敏或截断；
- completed writeback 失败时丢失 Provider 已返回 result 或候选 completed output；
- Provider reject 时虚构 result；
- 特殊值/循环引用导致整个记录失败，或被原生 JSON 静默丢失；
- stage→failureKind 与本文不一致；
- 内外 catch 覆盖根因、同 kind 多文件或同一事件重复；
- canonical 可被覆盖、symlink 可逃逸、final 可能是半文件；
- writer 异常影响工具/Run 主流程或递归记录；
- 修改了 shared/API/Prompt/UI/Git 等非目标合同；
- 缺少关键自动测试和独立审查复审证据。

## 完成定义

只有同时满足以下条件才完成：

- 文档中的环境变量、路径、实体、枚举、stage 映射与实现一致；
- 新增单元/Runner 测试全部通过；
- Worker typecheck/build 通过；
- 关闭、开启、Abort、writeback 数据窗口、symlink 和 writer 故障手工/自动证据齐全；
- 代码审查逐项核对本清单，无阻断项；
- 独立审查若提出问题，修复后完成复审；
- 未留下由开发者自行选择的关键 TODO。
