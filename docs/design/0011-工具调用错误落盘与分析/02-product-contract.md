# 产品合同与业务逻辑

## 功能启用合同

### 环境变量

唯一启用开关为：

```text
AWB_TOOL_ERROR_STORE_ENABLED=1
```

必须遵循：

- 只有去除进程环境传递因素后的**精确字符串值** `1` 启用；实现必须直接使用 `process.env.AWB_TOOL_ERROR_STORE_ENABLED === "1"`，不得 trim、忽略大小写或接受 `true/on/yes`。
- 环境变量在 Agent Worker 模块加载/进程启动时读取并固化；运行中修改 `process.env` 不要求生效。
- 未设置、空字符串、`0`、`true`、`yes`、` 1 ` 和任何其他值均关闭。
- 不新增第二个配置源，不从 Settings、Agent profile、API 请求或工作区配置覆盖该开关。
- 关闭时：
  - 不得创建 `.awb/agent/tool-errors` 或其父目录；
  - 不得构造错误 artifact 实体；
  - 不得遍历、克隆或保真序列化 args/result/output/Error；
  - 不得执行 lstat、realpath、open、rename、link、unlink 等该功能相关 I/O；
  - 不得输出该功能的 warning。

### 开启后的提示责任

本期不增加 UI 提示。部署者显式开启即表示接受：诊断文件可能包含完整工具参数、文件正文、命令、错误堆栈和 Provider 返回。文档应提示用户按需把 `.awb/` 加入自己的 `.gitignore`，运行时不得自动修改。

## 记录对象

本功能以一次确定的 context tool item 为关联单位，其身份为：

```text
workspaceId + sessionId + runId + itemId + toolCallId
```

文件路径使用 `sessionId/runId/itemId/toolCallId/failureKind`；JSON 内必须保留原始身份字段，用于检测安全化路径片段碰撞和错误复用。

## 记录范围

### 必须记录

仅在功能开启时记录：

- 工具实际执行阶段的非取消异常；
- 工具禁用或策略拒绝；
- Worker 恢复遗留 `running` 工具项并将其收敛为失败；
- 同一工具调用相关的 running/completed/failed context writeback 失败；
- `executeTool()` 未完成归类而逃逸到 `executeToolSafely()` 的非取消运行时异常；
- Provider 成功返回后，成功结果构造或 completed writeback 相关的非取消异常；
- 现有 subtask 异常的自有 data property `subtaskSessionId/subtaskResultText`；
- Error 自有 data property 中已经持有的诊断数据，以及按固定规则识别的 partial result。

### 不得记录

- 成功完成且没有相关 runtime/writeback 失败的工具调用；
- 执行前 `signal.aborted`；
- `isAbortLikeError(err, signal)` 判定为取消的异常；
- 用户取消、父子 session 取消或 Run Abort 本身；
- 模型 stream 错误、模型重试错误、assistant item 错误等非工具执行错误；
- 成功展示文本 artifact 写入 `.awb/agent/artifacts` 失败；该分支当前是成功降级，不把工具调用判为失败；
- `AWB_AGENT_DEBUG_DUMP` 的 `writeItemLog()` 失败；
- error artifact writer 自身失败；
- 单纯的 queued/running/completed 状态变化。

## `failureKind` 和 stage 固定映射

开发不得按个人理解改变下表。`failureKind` 用于文件名；`stage` 用于文件内事件分类。

| `failureKind` | `stage` | 触发条件 | 根因对象 |
|---|---|---|---|
| `tool` | `provider_execute_rejected` | `ToolRegistry.execute()` / Provider execute reject，且不是 Abort-like | Provider 抛出的原始值 |
| `tool` | `provider_partial_result` | 上一异常实际携带可识别 partial result；与 rejected 事件一并记录，不单独触发文件 | partial result 的原始值和来源字段 |
| `policy` | `tool_disabled_pending_precheck` | `executePendingTools()` 的 available tool 快照校验判定禁用 | 固定 policy 错误和候选 failed output |
| `policy` | `tool_disabled_execute_check` | `executeTool()` 内二次 `isToolEnabled()` 判定禁用 | 固定 policy 错误和候选 failed output |
| `recovery` | `running_item_recovered_as_failed` | 执行 pending tools 时发现 item 初始状态为 `running` | 固定 interrupted 错误和候选 failed output |
| `runtime` | `running_writeback_failed` | Provider 前的 `status=running` 写回失败，或 Provider 中间 running output 写回失败并向上抛出 | API/writeback 异常、候选 running output |
| `runtime` | `completed_output_build_failed` | Provider 已返回，构造成功文本或候选 completed output 的非降级异常 | 运行时异常、已返回 result、已有候选/中间 output |
| `runtime` | `completed_writeback_failed` | Provider 已返回且候选 completed output 已构造，`status=completed` 写回失败 | API/writeback 异常、完整 result、候选 completed output |
| `runtime` | `failed_writeback_failed` | 工具/policy/recovery 失败后，首次 `status=failed` 写回失败 | API/writeback 异常、候选 failed output、前序根因引用 |
| `runtime` | `runner_outer_unhandled` | 非取消异常逃逸到 `executeToolSafely()`，且不能更准确归入上述 stage | 外层捕获的原始值和当前执行快照 |
| `runtime` | `outer_failed_writeback_failed` | `executeToolSafely()` 的兜底 failed 写回也失败 | 兜底 writeback 异常、兜底 failed output |

### 特殊归类规则

- `toolRegistry.isToolEnabled()` 自身抛异常不是“禁用”，归入 `runtime/runner_outer_unhandled`；Provider 尚未执行。
- Provider 的 `execute()` 已经进入并 reject，归入 `tool/provider_execute_rejected`，即使异常文本看起来像参数校验或远端权限错误。
- `ToolRegistry.execute()` 找不到 Provider 抛出的 `unsupported tool` 也归入 `tool/provider_execute_rejected`；policy 只表示显式禁用判断返回 false。
- Provider 通过 `ctx.updateToolItem()` 或 `reportRunningOutput()` 写回失败并导致 execute reject：
  - 必须记录 `runtime/running_writeback_failed`；
  - 若该异常从 Provider Promise reject 传播，仍可以同时记录 `tool/provider_execute_rejected`，但两个事件必须通过 `sameErrorId` 关联，表明同一异常跨边界传播；不得复制成两个无法关联的“独立根因”。
- 成功文本 artifact 的 `finalizeToolText()` 当前内部会捕获并降级；该 warn 不生成 error artifact。若未来其异常逃逸并导致工具调用失败，才归入 `runtime/completed_output_build_failed`。

## 行为矩阵

| 场景 | Provider 是否执行/返回 | context item 目标行为 | error artifact | 必须包含的关键数据 |
|---|---|---|---|---|
| 功能关闭，普通工具失败 | 按现状 | 按现状 failed | 不写 | 无诊断开销 |
| 功能开启，Provider reject | 已执行，未返回 result | 按现状 failed | `tool`；failed writeback 再失败则另有 `runtime` | 完整 args、原始异常、候选/成功 failed output；result 标记 `not_returned` |
| Provider reject 且异常携带 partial result | 已执行，未正常返回 | 按现状 failed | `tool` | 完整 args、异常、完整 partial result、提取依据 |
| Provider 成功，completed 写回成功 | 已返回 | completed | 不写 | 无错误文件，即使曾在内存捕获快照 |
| Provider 成功，completed 写回失败 | 已返回 | 按现状尝试收敛 failed | `runtime` | 完整 args、完整 result、完整候选 completed output、writeback Error、后续 failed output/结果 |
| pending 预检禁用 | 不执行 | failed | `policy` | 完整 args、固定错误、候选/已写回 failed output |
| executeTool 二次检查禁用 | 不执行 | failed | `policy` | 同上；同一 policy kind 幂等，不覆盖已有文件 |
| 遗留 running 恢复 | 不重放 | failed | `recovery` | 完整 args、恢复前状态、固定错误、候选/已写回 failed output |
| 执行前 signal aborted | 不执行 | 保持现状 | 不写 | 无 |
| Provider 抛 Abort-like | 可能执行，未正常返回 | 保持现状直接返回 | 不写 | 无错误文件 |
| 成功文本 artifact 写入失败但 completed 写回成功 | 已返回 | completed | 不写 | 继续依赖现有 warn |
| Debug Dump 写失败 | 不确定 | 按现状 | 不写 | 继续依赖现有 warn |
| error writer 失败 | 不确定 | 原流程不变 | 未成功发布 | 一条限频 warn，不递归记录 |

## 数据可用性合同

### 完整 `tool.args`

- 来源必须是待执行工具的 `tool.args`，它来自模型 `tool-call` 的 `chunk.input` 经 `normalizeToolArgs()` 后的真实对象。
- 必须完整记录，不按字段名脱敏，不截断字符串、数组或对象。
- 记录的是 Worker 实际执行使用的对象，不另行保存 AI SDK chunk 的原始非对象包装；当前归一化无法保留的数据不在本期恢复。

### Provider `result`

- `ToolRegistry.execute()` fulfilled 后，必须立即对原始返回值生成不可变保真快照，设置 `resultAvailability=returned`；不得只保存引用延迟到发布时再编码。
- 后续任意 runtime/writeback 失败必须直接使用该时点快照。
- Provider reject 时设置 `resultAvailability=not_returned`，不写伪造的 `null` 结果。
- 若异常或既有特例按下列固定规则携带 partial result，设置 `resultAvailability=partial_from_error`，并记录完整 partial value 与 `partialResultSources`。
- “完整”不包括工具内部生成但从未 return/reject 附带、从未通过 running output 回调暴露的数据。

Partial result 提取规则固定为：

| 来源 | 识别条件 | `source` | 记录值 |
|---|---|---|---|
| subtask 既有特例 | thrown object 自有 **data property** 精确名为 `subtaskSessionId` 或 `subtaskResultText` | `subtask_error_fields` | 由实际存在的 data property 组成完整对象，不补默认值 |
| 通用单值 | thrown object 自有 **data property** 精确名为 `partialResult` | `error.partialResult` | 该属性完整值 |
| 通用多值 | thrown object 自有 **data property** 精确名为 `partialResults` | `error.partialResults` | 该属性完整值，作为一个快照，不擅自拆解 |
| 通用结果字段 | thrown object 自有 **data property** 精确名为 `result` | `error.result` | 该属性完整值 |

- “自有 data property”必须通过 `Object.getOwnPropertyDescriptors()` 或等价 descriptor 反射判断；accessor 不调用、不提取。
- 同一个值被多个规则命中时，按上表顺序保留各来源，但保真图内部仍可表达共享引用。
- `stdout/stderr/output` 等其他自定义字段仍完整存在于 thrown Error 图中，但本期不把它们启发式认定为 Provider partial result。
- 未命中上述规则时保持 `not_returned`；这不表示 Error 没有其他自定义字段，只表示没有满足合同的 partial-result 来源。

### `AgentToolOutput`

必须记录本次工具调用中已经构造并拟用于 context writeback 的完整 output。每次尝试形成一条 writeback attempt：

- `status`：`running | completed | failed`；
- `output`：完整 `AgentToolOutput`；
- `attemptedAt`；
- `outcome`：`succeeded | failed | unknown`；
- 成功时必须记录 API 返回的完整 context item（只要调用已经取得响应）；
- 失败时记录关联 `errorId`。

为避免调用方在后续阶段修改同一对象，本功能开启时，动态值必须在对应阶段**立即生成保真快照**：args 在 Provider 执行前，result 在 Provider fulfilled 后，output 在 writeback 发起前，API 返回 output 在响应取得后，Error 在 catch 中。不得只保留对象引用到最终发布时再序列化。

因此，功能开启后，即使工具最终成功，也会承担 args/result/output 快照的 CPU 与内存开销；但没有失败事件时不得创建目录或写文件。该开销是完整时点保真的明确取舍。

包括：

- executeTool 初始 running output；
- `reportRunningOutput()` 的 running output；
- Provider 使用 `ctx.updateToolItem()` 的 output；
- completed 候选 output；
- 内层 failed 候选 output；
- 外层兜底 failed output。

只有在最终确实产生至少一个应记录失败事件时才发布；成功调用的内存快照不得落盘。

### Error 与非 Error throw

- 编码器不得调用普通对象或 Error 自定义 accessor/getter，不得调用 `toJSON()` 或自定义 `toString()`。
- 使用 `Object.getOwnPropertyDescriptors()` 或等价反射枚举 Error 的全部自有 string 与 symbol keys；data property 编码完整 value 和 descriptor 元数据，accessor property 只编码 descriptor 元数据及 getter/setter 函数引用/标识，不读取其值。
- Error 的 `name/message/stack/cause` 和 `AggregateError.errors` 必须沿“对象自身 → 原型链”定位 property descriptor：
  - 定位到 data property：编码完整 value，并记录来源是 `own` 或原型层级；
  - 定位到 accessor：不得调用，语义字段标记为 `unavailable_accessor`，同时保存 accessor descriptor；
  - 找不到：语义字段标记为 `absent`，不得填充 `Error`、空字符串、默认 stack 或其他推测值；
  - descriptor/原型反射因 Proxy 等抛错：记录 `reflection_error`，该语义字段标记为 `reflection_error`，不得改为调用 getter兜底。
- Error 自有 data property 中的 `code/stdout/stderr` 等按实际值完整保存；自有 accessor 只保存 descriptor，不属于“已取得数据”。
- 非 Error throw（字符串、对象、数组、BigInt 等）必须保真记录原始 thrown value，并提供用于检索的 `summary`，但不得用 summary 替代原值。
- `reflection_error` 只表示 `getOwnPropertyDescriptors/getPrototypeOf/getOwnPropertyDescriptor` 等反射操作自身抛错；它不表示调用 getter 失败，因为本方案从不调用 getter。

“完整”的边界固定为：完整保存运行时已经持有、反射可取得的 data value；不得为采集主动执行用户代码。accessor 计算值不属于本期已取得数据。

### Provider callback 边界

- 本期只包装和记录当前代码实际存在的 running callback：Provider 调用 `updateToolItem({ status: "running", ... })`，以及 `reportRunningOutput()` 形成的 running writeback。
- 当前 `ToolExecutionContext.updateToolItem` 类型签名允许 `running|completed|failed`，但文档编写时源码 callsite 只有 subtask 的 running update；类型能力不等于本期支持合同。
- 若未来 Provider callback 直接写 `completed` 或 `failed`，不得自动套用 `provider_running_update`、`completed`、`inner_failed` 等现有 role/stage；必须先扩展产品行为矩阵、`WritebackRole`/stage 映射和自动测试，再声明支持。
- 在未扩展前，这类未来 callsite 必须由代码审查/测试阻断；本期不得为了“兼容未来”加入无文档自动归类。

### API projector 边界

- Worker 的完整 args、Provider result 和 `AgentToolOutput` 是本期落盘合同。
- API 后续通过 `agent.composition.ts` 重建模型消息：当前主路径对 tool-call 使用 `projectToolCallInputForPrompt()`，对 tool-result 优先使用 `output.error/text`，否则由 `result` 转文本。仓库同时存在 `projectToolResultForPrompt()` 与 `apply_patch` result 缩减 projector，但文档编写时该 result projector 未接入主 composition。无论后续是否接入，Provider result 与模型最终消息都可能不是同一个对象。
- 本期不得从 Worker 导入 API projector，也不得新增 API 回传“最终模型消息”。
- 文档不宣称 error artifact 精确复刻 API 最终消息；它保存的是重建消息的 Worker 源数据和更原始的 Provider result。

## 多阶段与去重合同

### 单 kind 多事件

同一调用可能在同一 kind 下发生多个阶段，例如：

```text
completed_writeback_failed
  -> 内层 failed_writeback_failed
  -> 外层 outer_failed_writeback_failed
```

这些 runtime 事件必须保存在同一个 `.runtime.json` 的有序 `events` 数组中，顺序按 Worker 捕获顺序排列，并用单调递增 `sequence` 标识。

### 跨 kind 共存

Provider reject 后 failed writeback 又失败时，至少存在：

```text
<base>.tool.json
<base>.runtime.json
```

两个文件共享 `captureId`、调用身份和时间线摘要；不得互相覆盖。

### 禁用双路径去重

pending 预检和 executeTool 二次禁用检查正常情况下只会命中其一。为防未来流程变化：

- 两条路径必须调用同一 capture API；
- 同一 `failureKind=policy`、相同 stage、相同错误对象/固定错误和相同候选 output 只追加一次事件；
- 去重键固定为：

  ```text
  failureKind + stage + phaseAttempt + errorId
  ```

- 若两个禁用 stage 都真实发生，保留为两个事件，但仍只发布一个 policy 文件。

## 文件发布、幂等与冲突合同

最终路径固定为：

```text
.awb/agent/tool-errors/by_run/<safeSessionId>/<safeRunId>/<itemId>-<safeToolCallId>.<failureKind>.json
```

- `itemId` 使用十进制正整数原文；`toolCallId/sessionId/runId` 使用统一 `safePathSegment()`。
- 同一调用、同一 kind 的 writer 在内存收集完成后只发布一次。
- 最终文件已存在时，必须 no-follow 读取并校验原始 `workspaceId/sessionId/runId/itemId/toolCallId/failureKind`：
  - 身份完全一致：视为幂等成功，不覆盖已有文件；
  - 身份不同、文件不可解析或 schemaVersion 不可识别：不得覆盖，改写冲突文件。
- 冲突文件名固定模板：

  ```text
  <itemId>-<safeToolCallId>.<failureKind>.conflict-<safeRecordedAt>-<attempt>.json
  ```

  其中 `safeRecordedAt` 是本次记录 `recordedAt` 的十进制毫秒；`attempt` 从 `1` 开始，在排他发布冲突时递增，直到成功或遇到不可恢复 I/O 错误。
- 冲突文件也必须包含原始身份和 `publication.conflictWithCanonical=true`。
- 禁止覆盖、truncate 或修改已有 canonical/conflict 文件。

## 取消、异常与降级规则

### 取消

- 任何写入失败捕获前必须先执行现有 `isAbortLikeError(err, signal)` 判断。
- 如果同一调用在取消前已经捕获了非取消错误事件，该既有错误仍可发布；取消本身不得追加错误事件。
- 只有 Abort-like 事件、没有任何非取消事件时，不创建文件。

### writer 失败

- writer 的任何异常必须在 writer 边界内吞掉；调用方不 catch writer error 来改变业务逻辑。
- writer 不得调用自身记录错误。
- warning 必须限频；同一 Worker 进程、相同错误类别和目标根目录在 60 秒窗口内最多输出一次，窗口内重复计数可在下一次 warning 中汇总。
- warning 整行必须单行化：将 `\r`、`\n`、Unicode 行分隔符替换为空格；最终整行最多 512 个 JavaScript 字符单元，超出部分截断。
- warning 只允许包含固定前缀、目标相对路径、失败操作、错误 name/code/message 摘要和 `suppressed=<n>`；不得打印 args/result/output/Error stack 或 artifact JSON。
- 512 字符限制只作用于 Worker warning 日志，不属于 artifact 业务内容截断，不能复用于 JSON 文件。

### 发布平台与文件系统能力

- fully supported 工作区必须同时具备：
  - 同一目标目录内创建临时文件并建立 hard link 的能力；
  - Node no-follow 打开语义，即 `O_NOFOLLOW` 或项目经过独立安全评审认可的等价能力；不得把缺失 `O_NOFOLLOW` 时的 `0` 当作等价能力。
- 项目主要验收基线为 Linux 本地运行环境；具体工作区文件系统是否 fully supported 必须由真实能力测试证明，不因操作系统或文件系统名称直接推断。
- 不支持 hard link/no-follow、返回 `EXDEV`、只读、权限不足或其他能力失败时，本功能在该工作区定义为“不可用但安全失败”：
  - 不发布 canonical/conflict final 文件；
  - 尽力清理本次创建的 temp；
  - 输出符合“整行最多 512 个 JavaScript 字符单元”合同的限频 warning；
  - Agent 工具状态、Run 状态和原异常传播不受影响。
- 本期不提供降低安全性的 fallback：不用普通 rename 覆盖、不移除 no-follow、不回退到工作区外或其他目录。

### 磁盘与清理

- 不设置单文件内容/字节上限，不静默截断。
- 本期不自动清理；部署者负责磁盘容量与删除。
- 磁盘满、配额、权限和只读文件系统均按 writer 失败处理，不回退写入工作区外目录。

## 产品验收摘要

本合同通过的最低条件是：关闭无目录；fully supported 环境开启后四种 kind 的代表场景成功落盘；unsupported 环境不发布 final 且安全失败；完整 args/result/output/Error data property 经保真编码可恢复语义，accessor 不执行并准确标记；Abort 和成功调用无文件；多阶段不覆盖；writer 故障不影响 Agent；API/shared/Prompt 无协议改动。完整验收见 [06-testing-acceptance.md](./06-testing-acceptance.md)。
