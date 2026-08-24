# 技术设计

## 当前运行时链路

当前主链为：

```text
runModelStep()
  -> streamText(request)
  -> fullStream 收到 tool-call
  -> normalizeToolArgs(chunk.input)
  -> createContextItem(kind=tool, status=queued, output.args)
  -> 下一轮 PromptContext.pendingTools
  -> executePendingTools()
  -> executeToolBatch()
  -> executeToolSafely()
  -> executeTool()
  -> ToolRegistry.execute()
  -> ToolProvider.execute()
  -> buildToolSuccessText()/buildToolErrorText()
  -> updateContextItem(completed|failed)
  -> API 以后从 context item 重建模型消息
```

关键当前事实：

- `runModelStep()` 在 `tool-call` chunk 中取得 `chunk.input`，通过 `normalizeToolArgs()` 转为 `Record<string, unknown>`。
- queued 工具项的 `output.args` 保存该对象，后续 `PendingTool.args` 用于真实 Provider 执行。
- `ToolRegistry.execute()` 返回 `Promise<unknown>`；fulfilled 值是 Provider 原始 `result`，reject 时没有统一 result 合同。
- Worker 成功路径把 `result` 和格式化 `text` 组成 `AgentToolOutput`，再写回 API。
- API 的 Prompt 重建是后续独立阶段。当前主 composition 对 tool-call 调用 input projector，对 tool-result 优先读取 `output.error/text`，否则把 `result` 转成文本；代码库虽存在 result projector，文档编写时它尚未接入该主路径。Worker 不持有“最终发送给模型的 message”对象。

## 目标组件

建议新增以下 Worker 私有模块：

```text
apps/agent-worker/src/runtime/
  toolErrorCapture.ts       # 开关、阶段状态、即时快照、事件去重、最终 artifact 组装
  losslessValueGraph.ts     # 动态值保真图编码器
  toolErrorStore.ts         # 目录/文件名、身份校验、best-effort 发布、warning 限频
  workspaceSafeIo.ts        # containment、安全目录、no-follow、临时文件、排他发布原语
```

测试文件：

```text
apps/agent-worker/src/runtime/
  losslessValueGraph.test.ts
  toolErrorStore.test.ts
  runner.tool-error-store.test.ts
```

若团队倾向减少文件，可以将 `toolErrorCapture.ts` 与 `toolErrorStore.ts` 合并，但职责和测试边界必须保持；不得把保真编码、路径安全和 Runner 阶段判断全部重新塞入 `runner.ts`。

## 组件职责

### `toolErrorCapture.ts`

必须负责：

- 模块加载时读取 `AWB_TOOL_ERROR_STORE_ENABLED === "1"`，导出只读 enabled 状态；
- 为一次工具调用创建 `ToolFailureCapture`；
- 在数据取得时立即调用保真编码器生成不可变快照；
- 维护 Provider 是否开始、是否返回、返回值快照；
- 记录每次 `AgentToolOutput` writeback attempt 及结果；
- 把 Error/非 Error throw 分配稳定 `errorId`；
- 按固定 stage→kind 映射追加事件和去重；
- 在生命周期结束时按 kind 生成 artifact，并调用 store；
- 没有事件时不调用 store。

必须提供无开销关闭分支。建议 API：

```ts
const capture = createToolFailureCaptureIfEnabled(identity, initialArgs);
```

关闭时返回 `null`，Runner 的后续调用使用空值短路：

```ts
capture?.record...()
```

不得返回一个内部仍遍历数据的“空对象实现”。

### `losslessValueGraph.ts`

必须把任意 JS 值编码为 `LosslessValueGraphV1`，规则见“保真序列化设计”。编码结果必须只包含原生 JSON 可表达的数据，并能由普通 `JSON.stringify()` 输出。

### `toolErrorStore.ts`

必须负责：

- 固定目录和文件名；
- 调用安全 I/O 创建 `0700` 目录；
- 把完整 artifact JSON stringify 为 UTF-8；
- 在同目录创建 `0600` 临时文件；
- 排他、原子发布 canonical 或 conflict 文件；
- canonical 已存在时 no-follow 读取并校验身份；
- 清理本次未发布的临时文件；
- 吞掉自身异常并按规则限频 warning；
- 不向 Runner 暴露可抛异常的写入 API。

建议只导出：

```ts
writeToolErrorArtifactsBestEffort(artifacts, { logger }): Promise<void>
```

### `workspaceSafeIo.ts`

必须负责：

- `safePathSegment()`；
- `isPathInside()`；
- 对 workspace 与目标目录做 `resolve/realpath` containment；
- 检查 Node no-follow 打开能力；`O_NOFOLLOW` 不存在且没有项目认可的等价能力时安全失败，不得按 `0` 继续；
- 逐级 `lstat`，拒绝 symlink 和非目录；
- 创建目录时指定 `0o700`，已有目录不主动 chmod；
- no-follow 读取；
- 以 `O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY` 和 `0o600` 创建临时文件；
- 完整写入、`sync()`、关闭；
- 用同目录 hard link 将临时文件原子、排他发布为最终文件；成功后 unlink 临时文件；
- hard link 不支持、`EXDEV`、只读或权限不足时不发布 final，并尽力清理本次 temp；
- 发布失败时不使用会覆盖目标的普通 `rename()`。

API 端的 `safe-file-io.ts` 可作为实现参考，但 Worker 不得反向导入 API 私有模块。

## 捕获状态设计

### 调用身份

创建 capture 时固定：

```ts
type ToolCallIdentity = {
  workspacePath: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  itemId: number;
  toolName: string;
  toolCallId: string;
  initialStatus: PendingTool["status"];
};
```

`workspacePath` 只用于定位文件，不写入 artifact 的公共 identity；如需诊断可以写入 `workspacePath` 的保真快照，但本方案默认不重复写该绝对路径，避免 artifact 移动后产生误导。目录位置已经表达工作区。

### 执行快照

capture 内部至少维护：

```ts
type ExecutionCaptureState = {
  captureId: string;
  createdAt: number;
  nextSequence: number;
  argsSnapshot: LosslessSnapshot;
  provider: {
    startedAt?: number;
    settledAt?: number;
    returned: boolean;
    resultSnapshot?: LosslessSnapshot;
    partialResultSnapshots: PartialResultSnapshot[];
  };
  writebacks: WritebackAttempt[];
  errors: Map<string, CapturedThrownValue>;
  eventsByKind: Map<FailureKind, ToolErrorEvent[]>;
  eventDedupeKeys: Set<string>;
};
```

### 即时快照要求

启用时必须在以下时点立即编码：

| 数据 | 快照时点 | 原因 |
|---|---|---|
| `tool.args` | capture 创建、Provider/策略处理之前 | 防止 Provider 或后续代码原地修改参数 |
| Provider `result` | `await toolRegistry.execute()` fulfilled 后的下一条逻辑 | 补齐 completed writeback 数据丢失窗口，防止后处理修改 result |
| partial result | 从 Error/特例实际提取时 | 保留异常当时数据 |
| 候选 `AgentToolOutput` | 每次 `updateContextItem()` 发起前 | 保存拟写回精确值 |
| API 返回 context item/output | writeback fulfilled 后立即 | 保存已写回响应；不假定与候选完全相同 |
| Error/thrown value | catch 中首次观察时 | 保留 stack、自定义字段和 cause 的当时状态 |

关闭时上述诊断快照全部不执行。开启但最终成功时，内存快照被丢弃，不生成文件。

## Runner 接入点

## `executeToolSafely()`：生命周期拥有者

目标设计中，`executeToolSafely()` 必须创建并拥有 capture：

```ts
const capture = createToolFailureCaptureIfEnabled(identity, tool.args);
try {
  return await this.executeTool({ ...params, capture });
} catch (err) {
  // 保留现有 Abort 判断和兜底状态语义
  // 追加准确的 runtime 事件，而不是覆盖内层 tool 事件
} finally {
  await capture?.publishBestEffort(this.logger);
}
```

必须保证：

- publish 位于最外层 `finally`；
- publish error 不得替代 return/throw；
- Abort-only capture 没有事件，不调用 store；
- 外层 catch 先判断 Abort，再记录 `runner_outer_unhandled`；
- 若某异常已由 writeback wrapper 分配 `errorId`，外层复用同一 ID；
- 外层兜底 failed writeback 通过统一 wrapper 记录 `outer_failed_writeback_failed`。

## `executeTool()`：阶段推进者

`executeTool()` 接收可空 capture，并使用显式阶段状态，不再用一个大 catch 猜测错误来自何处。

建议阶段变量：

```ts
let phase:
  | "enable_check"
  | "running_writeback"
  | "provider_execute"
  | "completed_output_build"
  | "completed_writeback"
  | "failed_writeback" = "enable_check";
```

必须行为：

- `isToolEnabled()` 返回 false：追加 `policy/tool_disabled_execute_check`，构造完整 failed output，经 wrapper 写回。
- 初始 running 写回：使用 wrapper，失败记录 `runtime/running_writeback_failed` 并保持现有异常传播。
- Provider 调用前标记 startedAt；fulfilled 后立即快照 result，并设置 returned；reject 且非 Abort 时记录 `tool/provider_execute_rejected`。
- `buildToolSuccessText()`、`finalizeToolText()` 和 completed output 构造处更新 phase；只有导致调用失败的异常才记录 `completed_output_build_failed`。
- completed output 在 API 调用前快照；writeback 失败记录 `completed_writeback_failed`，其中必须可访问完整 result 与候选 output。
- Provider/后处理失败后构造的 failed output在写回前快照；写回失败记录 `failed_writeback_failed`。
- 现有 subtask partial result 逻辑继续构造 failed output，同时只从自有 data property 提取 `subtaskSessionId/subtaskResultText`；通用异常只提取自有 data property `partialResult/partialResults/result`。所有提取均通过 descriptor 完成，accessor 不调用、不提取；其他自定义字段仍由完整 thrown 图保存，不做启发式分类。

## 统一 writeback wrapper

所有本次工具调用相关的 context item update 必须通过一个 capture-aware wrapper，包括 Provider context 回调：

```ts
attemptToolWriteback({
  capture,
  role,
  itemId,
  status,
  output,
  invoke: () => apiClient.updateContextItem(...)
})
```

`role` 固定枚举：

```text
initial_running
provider_running_update
provider_running_report
completed
inner_failed
outer_failed
policy_failed
recovery_failed
```

wrapper 必须：

- 在 `invoke()` 前快照完整 output；
- 记录 attempt sequence/startedAt；
- fulfilled 后快照 API 返回值并标记 succeeded；
- reject 时先捕获 thrown value/errorId，再按 role 映射 runtime stage；
- 原样 rethrow，不包装、不替换 Error；
- 不在 Abort-like 情况下单独做判断，是否将该 writeback error视为取消由调用层结合 signal 决定；若最终被判定 Abort，应移除/抑制对应仅取消事件。实现上建议 wrapper 暂存 failed attempt，由调用层明确 `commitRuntimeFailure(errorId)` 或 `markAbort(errorId)`。

### Provider 回调

当前 `ToolExecutionContext` 暴露：

- `updateToolItem()`：类型签名允许 `running|completed|failed`；
- `reportRunningOutput()`：Runner 固定形成 running writeback。

文档编写时的实际 callsite 只有 builtin subtask 通过 `updateToolItem({ status: "running", ... })` 写 running output；没有 Provider callback 直接写 `completed` 或 `failed`。

本期支持边界固定为：

- 只使用 `provider_running_update` 包装实际的 running `updateToolItem()`；
- 只使用 `provider_running_report` 包装 `reportRunningOutput()`；
- 顶层 completed/failed 仍由 `executeTool()` 自己的 `completed/inner_failed/outer_failed` role 捕获；
- 不为未来可能出现的 Provider callback terminal status 编写通用映射；若新增此类 callsite，必须先扩展产品合同、stage/role 和测试，再接入 capture；
- 代码审查与测试必须阻断“把 callback completed/failed 自动映射到现有 role”的实现。

因此，目标设计必须让当前两个 running callback 走 wrapper，但不得把 `ToolExecutionContext` 类型层面的 terminal 可能性误写成本期已支持行为。

## `executePendingTools()`：policy 与 recovery

### pending 预检禁用

当前 pending 预检在进入 `executeToolSafely()` 之前。目标设计必须抽取统一 helper：

```ts
handleStandaloneToolFailure({
  kind: "policy",
  stage: "tool_disabled_pending_precheck",
  role: "policy_failed",
  ...
})
```

helper 必须：

- 开启时创建 capture 并立即快照 args；
- 追加 policy 事件；
- 构造与当前行为相同的 failed `AgentToolOutput`；
- 经 writeback wrapper 执行；失败时追加 runtime `failed_writeback_failed`；
- finally 发布 policy/runtime 文件；
- 保持当前 writeback 异常传播语义。

### 遗留 running 恢复

使用同一 standalone helper，固定：

```text
failureKind=recovery
stage=running_item_recovered_as_failed
role=recovery_failed
provider.returned=false
resultAvailability=not_started
```

不得重放 Provider，不得推断原执行是否真实成功，不得把 interrupted 当作用户取消。

### 双禁用路径

- `executePendingTools()` 预检通过后才进入 `executeTool()`；二次检查保留，用于防动态变化和防御性校验。
- 两条路径使用相同 capture API 和事件去重算法。
- 不得删除其中一个检查来“解决重复记录”；权限行为保持现状。

## 错误根因与多阶段时序

### Provider reject + failed writeback reject

```text
capture args snapshot
  -> running writeback success
  -> provider execute reject E1
     -> snapshot E1
     -> event tool/provider_execute_rejected(errorId=E1)
  -> build failed output F
  -> inner failed writeback reject E2
     -> writeback attempt(role=inner_failed, errorId=E2)
     -> event runtime/failed_writeback_failed(errorId=E2, causedBy=E1)
  -> outer catch receives E2
     -> event runtime/runner_outer_unhandled(errorId=E2) 仅当 E2 尚无更准确 stage；已有准确 stage 时不得重复追加
  -> outer failed output OF
  -> outer writeback ...
  -> finally publish tool.json + runtime.json
```

根因 E1 只在 tool 文件中出现为主事件；runtime 文件通过 `relatedErrorIds/causedByErrorId` 引用。完整 Error snapshot 可以在每个文件自包含地复制，也可以每文件只包含其引用到的 errors；不得让单文件依赖读取另一个文件才能解释自身事件。

### Provider fulfilled + completed writeback reject

```text
capture args
  -> provider fulfilled result R
  -> 立即 snapshot R
  -> build success text/output C
  -> snapshot C
  -> completed writeback reject E1
  -> runtime/completed_writeback_failed，引用 R/C/E1
  -> build failed output F（保持现状）
  -> failed writeback success或失败
  -> publish runtime.json
```

此时不得生成 `tool.json`，因为 Provider 没有失败。`runtime.json` 必须明确：

```text
provider.resultAvailability=returned
provider.result=<完整快照>
completed output=<完整快照>
```

### Provider running writeback 错误传播

Provider 调用 `ctx.updateToolItem()` 发生 writeback reject E1 时：

- wrapper 记录 `runtime/running_writeback_failed(E1)`；
- Provider Promise 通常以同一 E1 reject，外层 Provider catch 可记录 `tool/provider_execute_rejected(E1)`；
- `sameErrorId=E1` 表明 tool 事件是传播观察，不应在离线统计中计为第二个独立根因。

## 保真序列化设计

## 顶层格式

每个动态快照采用：

```ts
type LosslessSnapshot = {
  capturedAt: number;
  graph: LosslessValueGraphV1;
};

type LosslessValueGraphV1 = {
  format: "awb-lossless-value-graph";
  version: 1;
  root: EncodedValue;
  nodes: Record<string, EncodedNode>;
};
```

`nodes` 的 key 固定为本次快照内按首次遍历顺序分配的十进制字符串：`"1"`、`"2"`……；同一对象/函数/symbol 再次出现使用 `{ "type": "ref", "id": "..." }`，从而保留循环引用和共享引用。

## primitive 编码

| JS 值 | 编码 |
|---|---|
| `null` | `{ "type": "null" }` |
| `undefined` | `{ "type": "undefined" }` |
| boolean | `{ "type": "boolean", "value": true }` |
| string | `{ "type": "string", "value": "..." }`，不截断 |
| 普通有限 number | `{ "type": "number", "value": 1.5 }` |
| `-0` | `{ "type": "number", "special": "negative_zero" }` |
| `NaN` | `{ "type": "number", "special": "nan" }` |
| `Infinity` | `{ "type": "number", "special": "positive_infinity" }` |
| `-Infinity` | `{ "type": "number", "special": "negative_infinity" }` |
| BigInt | `{ "type": "bigint", "decimal": "123" }` |
| object/function/symbol | `{ "type": "ref", "id": "N" }` |

## object node

普通对象/数组/类实例至少记录：

```ts
{
  kind: "object" | "array" | "class_instance";
  tag: string;                 // 编码器根据已识别类型赋予的稳定标签，不调用对象的 toString/toJSON
  constructorName?: string;
  extensible?: boolean | ReflectionError;
  sealed?: boolean | ReflectionError;
  frozen?: boolean | ReflectionError;
  properties: EncodedOwnProperty[];
  reflectionErrors?: ReflectionError[];
}
```

属性枚举必须使用 `Object.getOwnPropertyDescriptors()` 或等价的 descriptor-only 反射。为支持 Proxy 局部降级，推荐等价实现为：先 `Reflect.ownKeys()`，再对每个 key 调用 `Reflect.getOwnPropertyDescriptor()`；不得使用 `obj[key]`。每个成功取得的属性记录：

- string key 原文，或 symbol key 的 ref；
- `enumerable/configurable`；
- data descriptor 的 `writable` 和完整 value；
- accessor descriptor 的 getter/setter function ref/标识；accessor 不包含计算后的 value。

编码器**不得调用普通对象或 Error 自定义 accessor/getter**，也不得调用对象 `toJSON()`、自定义 `toString()` 或 `Object.prototype.toString`（后者可能触发自定义 `Symbol.toStringTag` getter）。generic object 的 `tag/constructorName` 必须通过编码器类型分支和 prototype descriptor 取得。

若 `getPrototypeOf/ownKeys/getOwnPropertyDescriptor/getOwnPropertyDescriptors` 等反射操作因 Proxy 等抛错，记录 `reflection_error` 及 thrown value 并继续/局部降级。`reflection_error` 只代表 descriptor/原型反射本身失败；getter 从不执行。

编码器必须采用显式 work queue/stack 迭代展开待编码节点，不得依赖无界函数递归；这样在不设置深度上限的前提下，深层但有限对象图不会仅因 JavaScript 调用栈溢出而失败。对象总量导致的内存耗尽仍属于已接受的完整记录风险。

## Error node

Error 必须作为专用 node：

```ts
type ErrorSemanticObservation =
  | {
      availability: "data";
      owner: "own" | { prototypeDepth: number };
      descriptor: EncodedDataDescriptorMeta;
      value: EncodedValue;
    }
  | {
      availability: "unavailable_accessor";
      owner: "own" | { prototypeDepth: number };
      descriptor: EncodedAccessorDescriptor;
    }
  | { availability: "absent" }
  | { availability: "reflection_error"; error: EncodedValue };

{
  kind: "error";
  errorName: ErrorSemanticObservation;
  message: ErrorSemanticObservation;
  stack: ErrorSemanticObservation;
  cause: ErrorSemanticObservation;
  aggregateErrors: ErrorSemanticObservation;
  properties: EncodedOwnProperty[];
  reflectionErrors?: ReflectionError[];
}
```

- 自有 string/symbol properties 仍按 descriptor 全量记录；data property 编码 value，accessor 只编码 descriptor。
- `name/message/stack/cause` 与 AggregateError 的 `errors` 必须按字段名从 Error 自身开始沿原型链定位 descriptor，不得通过 `err.name` 等属性读取求值。
- 定位到 data property 时保存 value 和来源；`cause/errors` 的 data value递归进入同一对象图。
- 定位到 accessor 时保存 descriptor 并标记 `unavailable_accessor`，不得执行 getter。
- 原型链中不存在时标记 `absent`，不得伪造默认 name/message/stack/cause/errors。
- descriptor/原型反射抛错时标记 `reflection_error` 并保存对应 thrown value；不得改用属性读取兜底。
- 不调用 `String(err)` 或自定义 `toString()` 生成文件内数据。

“完整”指完整保存运行时已经持有的 data value；accessor 计算值需要主动执行用户代码，不属于本期已取得数据。

## Function 与 Symbol

Function node 记录：

- `name`、`length`；
- `Function.prototype.toString.call(fn)` 的完整结果；这是调用内建 intrinsic 获取函数表示，不调用函数自定义 `toString`，失败时记录 reflection error；
- 自有属性 descriptors。

不得在读取或恢复时执行函数。

Symbol node记录：

- `Symbol.keyFor(symbol)` 的 global key，若有；
- description；
- 本快照内 node id，用于保持唯一 symbol 的引用一致性。

## 内建对象

必须为下列可观察内部状态提供专用字段，同时保留额外自有属性：

| 类型 | 必须记录 |
|---|---|
| Date | `timeValue`，Invalid Date 用 special 标记 |
| RegExp | `source/flags/lastIndex` |
| Map | 按迭代顺序完整记录 key/value entries |
| Set | 按迭代顺序完整记录 values |
| ArrayBuffer/SharedArrayBuffer | 完整 bytes，base64 编码 |
| DataView/TypedArray/Buffer | constructor、byteOffset、length/byteLength、完整可见 bytes；避免重复记录规范化数字索引属性 |
| URL/URLSearchParams | 完整字符串表示和额外自有属性 |
| WeakMap/WeakSet | 类型和 `contentsObservable=false`；内容无法枚举，不得伪造 |
| Promise | 类型和 `stateObservable=false`；不得等待或探测内部状态 |

未知 host object 使用普通 descriptor 图；反射失败以 `reflection_error` 表达。

## JSON 发布序列化

- 顶层 artifact 字段顺序按实体设计固定。
- `events` 按 sequence 升序。
- `nodes` 按数字 node id 升序写入。
- 使用两空格缩进和结尾换行，便于审查和 diff。
- 不调用动态值的 `toJSON()`；保真编码器必须先把动态值转为纯 JSON 图。
- 不设置 replacer 截断、深度上限、数组上限、字符串上限或总字节上限。
- `JSON.stringify()` 若对已经编码的纯 JSON 实体仍失败，视为 writer bug/失败，只限频 warn，不回退到截断格式。

## 文件路径与安全写入

## fully supported 与 unsupported 工作区

本功能的 final 发布支持状态按目标工作区目录能力判定：

- fully supported：Node 运行时提供 `O_NOFOLLOW` 或项目经独立安全评审认可的等价 no-follow 能力，并且目标目录支持同目录 hard link；
- unsupported：缺少 no-follow、hard link 返回不支持/`EXDEV`、目录只读、权限不足或其他无法满足安全发布合同的情况。

项目主要验收基线为 Linux 本地运行环境，但不得仅凭 Linux 或具体文件系统名称宣称支持。能力证明来自真实操作：no-follow flag 可用且临时文件以 no-follow 方式排他打开，最终 hard link 成功。无需预先写入额外持久 probe 文件；实际 temp/open/link 即为本次能力验证。

unsupported 时必须：

- 不发布 canonical/conflict final；
- 尽力 unlink 本次创建的 temp；
- 输出限频且最多 512 个 JavaScript 字符单元的单行 warning；
- 保持 Agent 主流程不变；
- 不使用普通 rename、不去掉 no-follow、不回退到其他目录。

## 路径构造

固定相对路径：

```text
.awb/agent/tool-errors/by_run/
  <safeSessionId>/
    <safeRunId>/
      <itemId>-<safeToolCallId>.<failureKind>.json
```

`safePathSegment()` 必须与当前 `runner.ts` 规则一致：

- 先 `String(input || "").trim()`；
- 非 `[A-Za-z0-9._-]` 替换为 `_`；
- 空结果为 `unknown`；
- 最长 120 个 JavaScript 字符单元，超出截取前 120。

`failureKind` 来自闭合枚举，不经过外部输入。`itemId` 必须验证为正整数后转十进制；非法身份不尝试写入，只限频 warn。

## containment 与目录创建

必须：

- `workspaceResolved = path.resolve(workspacePath)`；
- workspace 必须已存在且 `realpath` 成功；
- 目标目录 `path.resolve` 后必须位于 workspace 内；
- 从 workspace 到目标目录逐级 `lstat`；
- 已存在段若是 symlink 或非目录立即拒绝；
- 新目录逐级创建为 `0o700`；处理并发 `EEXIST` 后重新 lstat/realpath；
- 每一级 realpath 后重新验证仍在 workspace realpath 内。

不得因为 `.awb` 已存在就跳过 `.awb/agent/...` 的逐级检查。

### 主动路径竞态边界

Node 当前跨平台文件 API 没有直接暴露 POSIX `openat/linkat` 的目录句柄相对发布能力，因此仅靠 path-based `lstat/realpath/link` 无法对“同一 OS 用户或同权限进程在校验与发布之间主动替换父目录”给出形式化无竞态保证。本期边界固定为：

- 必须在创建临时文件前、读取 canonical 前、发布 hard link 前分别重新执行父目录 lstat/realpath/containment 校验；
- 发布成功后必须再次确认 final 是普通文件、父目录 realpath 仍位于 workspace；检测到变化时限频 warning，并仅在能够确认 final 与本次 temp 是同一 inode 时尽力移除 final；
- 不得宣称能够抵御同权限主动竞态攻击；该剩余风险必须保留在审查结论中；
- 静态 symlink、预创建 symlink、普通路径穿越和意外目录替换仍必须被自动测试阻断。

这不是放宽 containment 要求，而是明确当前 Node 原语下的可证明边界。若未来要抵御主动竞态，需单独引入平台相关的 dirfd/openat/linkat 原语或受控原生扩展，不在本期用不安全降级伪装保证。

## 临时文件与排他发布

写入流程固定：

```text
在最终目录创建隐藏临时文件
  -> O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, mode 0600；若无 no-follow 能力则安全失败
  -> write all UTF-8 bytes
  -> fsync file
  -> close
  -> hard-link temp 到 canonical/conflict final path
  -> link 成功即完成原子、排他发布
  -> unlink temp
```

临时文件名固定包含 canonical base、进程 PID、captureId 安全片段和单调序号，例如：

```text
.<canonicalBase>.<pid>.<safeCaptureId>.<sequence>.tmp
```

- hard link 与 final 位于同目录，避免跨设备问题；
- `link()` 在 final 已存在时返回 `EEXIST`，不会覆盖；
- 不允许用普通 `rename(temp, final)`，因为 POSIX rename 可能覆盖现有 final；
- hard link/no-follow 不支持、`EXDEV`、只读或权限不足时，本次发布失败且不产生 final，不降级到不安全覆盖或其他目录；
- finally 尽力 unlink 本次 temp；清理失败只合并到 writer warning，不递归记录。

## canonical 已存在

使用 `lstat + O_RDONLY|O_NOFOLLOW` 读取：

- symlink、非普通文件：按身份冲突处理，不读取目标；
- 可解析且 identity/failureKind 完全一致：幂等成功，删除 temp，不再发布；
- 不可解析、未知 schema 或身份不同：设置 `publication.conflictWithCanonical=true`，为本次完整 artifact 生成 conflict 文件；
- conflict 名按 `recordedAt + attempt`，从 1 递增，最多尝试 1000 次；超过后 writer 失败并限频 warn，避免恶意预创建导致无界循环。

## 权限

- 新建目录 mode `0o700`；
- 临时/最终文件 mode `0o600`；hard link 保留 inode mode；
- 现有目录/文件不得自动 chmod，避免修改用户已有权限。若已有目录权限较宽，定稿行为是**继续使用并限频 warning**，因为工作区拥有者可能有意共享目录，且拒绝会降低诊断可用性。
- Windows/平台不完全支持 POSIX mode 时尽力设置，不因 mode 无法精确表达而写到工作区外。

## 错误隔离与 warning 限频

writer 最外层必须：

```ts
try {
  // safe publish
} catch (err) {
  warnRateLimited(...);
}
```

warning key 固定为：

```text
workspaceResolved + operation + normalizedErrorCode
```

- 时间窗口 60 秒；
- 窗口内第一次立即输出；
- 后续抑制并计数；
- 下一窗口首次 warning 附加 `suppressed=<n>`；
- 只输出固定前缀、相对目标、operation、Error name/code/message 摘要和 `suppressed=<n>`；
- 在拼接前把 `\r`、`\n`、Unicode 行分隔符统一替换为空格并压缩连续空白，确保单行；
- 拼接后整行最多 512 个 JavaScript 字符单元，超出部分截断；
- 不输出 args/result/output、完整 stack、完整 artifact JSON；
- 限频器仅在内存，进程重启后重置。

warning 的“整行最多 512 个 JavaScript 字符单元”截断只适用于日志摘要，不得复用到 artifact JSON、Error data value 或任何业务内容。

writer 错误不得进入 capture，不调用 `writeToolErrorArtifactsBestEffort()` 自身，不写 `.runtime.json`。

## 并发模型

当前 `bash` 和 `subtask` 可并行批处理。设计必须支持：

- 每次 tool item 独立 capture，无共享可变事件数组；
- 多 capture 可并行编码/发布；
- 目录创建处理 `EEXIST` 竞态并重新校验；
- canonical 发布以 hard link 排他；
- warning 限频器的 Map 更新在 JS 单线程事件循环内完成；
- 不使用共享 JSONL 或全局文件锁。

同一 `itemId` 被意外并发执行时，canonical 首次发布胜出；身份相同的后到发布视为幂等，不合并更新。这是 best-effort 诊断的明确行为。

## 不改变的现有逻辑

实现必须保持：

- 工具禁用的错误文本与 failed 状态；
- 遗留 running 工具项收敛失败的现有错误文本；
- Abort-like 直接返回行为；
- Provider 执行顺序与并行批次；
- `buildToolSuccessText/buildToolErrorText` 的产品文本；
- 成功长文本 artifact 的目录、截断和降级语义；
- `writeItemLog()` 与 `AWB_AGENT_DEBUG_DUMP` 行为；
- context update 的 status/output 业务合同；
- API Prompt 构建与 tool projector；
- shared schema 和 internal endpoint。

## 失败处理伪代码

```ts
async function executeToolSafely(params) {
  const capture = TOOL_ERROR_STORE_ENABLED
    ? createToolFailureCapture(params.identity, params.tool.args)
    : null;

  try {
    return await executeTool({ ...params, capture });
  } catch (err) {
    if (isAbortLikeError(err, params.signal)) {
      capture?.markAbort(err);
      return { paused: false };
    }

    capture?.recordOuterUnhandledIfUnclassified(err);
    const failedOutput = buildOuterFailedOutput(params.tool, err);
    try {
      await attemptToolWriteback({ capture, role: "outer_failed", output: failedOutput, ... });
    } catch {
      // 保持现有外层语义；attempt wrapper 已记录，writer 不抛
    }
    return { paused: false };
  } finally {
    await capture?.publishBestEffort();
  }
}
```

实际实现必须以当前 `executeToolSafely()` 的 return/throw 语义为准，不能因伪代码简化而吞掉当前会传播的异常；开发前用冻结测试锁定。

## 性能边界

- 关闭：除一次模块级布尔读取和每调用空值分支外，不得有诊断序列化/I/O。
- 开启：为保证时点完整性，即使最终成功，也会编码 args、各次 output 和 result；成功后丢弃。
- 不设置编码上限。若单次对象图极大，Worker 可能出现延迟或内存压力；这是用户选择完整记录后的已知风险。
- 编码器不得故意 `await` Promise、执行 Function、调用普通 getter 或遍历 Weak 集合来扩大可见数据。

## 技术完成标准

- 所有 stage 只能从中央枚举和映射表产生；Runner 不写裸字符串分类。
- 所有工具相关 context writeback 经过 capture-aware wrapper，关闭时行为等价。
- Provider result 在 fulfilled 后立即快照；completed writeback 失败测试能从文件还原该结果和候选 output。
- 保真图覆盖本文规定的特殊类型、循环/共享引用和 Error。
- 安全发布不存在覆盖 canonical 的代码路径。
- writer 所有错误都在边界吞掉并限频，不改变 Agent 状态机。
