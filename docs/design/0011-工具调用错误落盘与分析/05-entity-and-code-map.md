# 实体设计与代码地图

## Artifact 顶层实体

每个 canonical/conflict 文件必须是一个独立、可解析的 UTF-8 JSON 对象，顶层 schema 固定为 `ToolErrorArtifactV1`：

```ts
type ToolErrorArtifactV1 = {
  schemaVersion: 1;
  kind: "tool_error";
  captureId: string;
  recordedAt: number;
  failureKind: FailureKind;
  identity: ToolCallArtifactIdentity;
  tool: ToolDescriptor;
  execution: ToolExecutionArtifact;
  writebacks: ToolWritebackAttemptArtifact[];
  errors: CapturedErrorArtifact[];
  events: ToolErrorEventArtifact[];
  publication: ToolErrorPublication;
};
```

顶层字段不得随 Provider 任意增加；动态值必须放入保真图快照字段。

## 枚举

### `FailureKind`

```ts
type FailureKind = "tool" | "policy" | "recovery" | "runtime";
```

含义：

| 值 | 含义 |
|---|---|
| `tool` | Provider 执行 Promise reject 或实际工具执行根因 |
| `policy` | 工具未执行，因显式启用/权限检查返回 disabled |
| `recovery` | Worker 恢复遗留 `running` item，并按现状收敛为 failed |
| `runtime` | Worker 阶段、context writeback 或外围兜底失败 |

### `ToolErrorStage`

```ts
type ToolErrorStage =
  | "provider_execute_rejected"
  | "provider_partial_result"
  | "tool_disabled_pending_precheck"
  | "tool_disabled_execute_check"
  | "running_item_recovered_as_failed"
  | "running_writeback_failed"
  | "completed_output_build_failed"
  | "completed_writeback_failed"
  | "failed_writeback_failed"
  | "runner_outer_unhandled"
  | "outer_failed_writeback_failed";
```

固定映射：

```ts
const FAILURE_KIND_BY_STAGE = {
  provider_execute_rejected: "tool",
  provider_partial_result: "tool",
  tool_disabled_pending_precheck: "policy",
  tool_disabled_execute_check: "policy",
  running_item_recovered_as_failed: "recovery",
  running_writeback_failed: "runtime",
  completed_output_build_failed: "runtime",
  completed_writeback_failed: "runtime",
  failed_writeback_failed: "runtime",
  runner_outer_unhandled: "runtime",
  outer_failed_writeback_failed: "runtime"
} as const;
```

不得在 Runner 各分支复制这张表。

### 其他枚举

```ts
type ResultAvailability =
  | "not_started"
  | "not_returned"
  | "returned"
  | "partial_from_error";

type WritebackRole =
  | "initial_running"
  | "provider_running_update"
  | "provider_running_report"
  | "completed"
  | "inner_failed"
  | "outer_failed"
  | "policy_failed"
  | "recovery_failed";

type WritebackOutcome = "succeeded" | "failed" | "unknown";

type ArtifactToolSource = "builtin" | "mcp" | "plugin" | "unknown";
```

`ArtifactToolSource` 是错误 artifact 私有类型，不得改名或替换源码现有 `apps/agent-worker/src/runtime/tools/types.ts` 的 `ToolSource`。其值应复用现有 `isBuiltinToolName/isMcpToolName/isPluginToolName` 判定；无法识别时写 `unknown`，不得猜测远端/本地插件。artifact 类型只区分 plugin，不区分 local/remote。

## 身份实体

```ts
type ToolCallArtifactIdentity = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  itemId: number;
  toolCallId: string;
};
```

约束：

- 所有字段必须保存原始值，不保存 safe 化后的值代替原值；
- `itemId` 必须为正整数；
- canonical 身份校验比较这五个字段和 `failureKind`；
- `workspacePath` 不属于身份，避免同一工作区挂载路径变化导致伪冲突。

## 工具实体

```ts
type ToolDescriptor = {
  name: string;
  source: ArtifactToolSource;
  initialStatus: "queued" | "running" | "streaming" | "completed" | "failed" | "cancelled";
  args: LosslessSnapshot;
};
```

- `args` 是 capture 创建时的即时快照；
- 不脱敏、不截断；
- 当前 `PendingTool.args` 固定为 object，但编码器仍使用通用图格式；
- `tool.name` 为 canonical tool name 原文。

## 执行实体

```ts
type ToolExecutionArtifact = {
  providerStartedAt?: number;
  providerSettledAt?: number;
  resultAvailability: ResultAvailability;
  result?: LosslessSnapshot;
  partialResults?: Array<{
    source: string;
    capturedAt: number;
    value: LosslessValueGraphV1;
  }>;
};
```

规则：

- Provider 未开始：`not_started`；
- Provider reject 且无 partial：`not_returned`，省略 `result`；
- Provider fulfilled：`returned`，必须有完整 `result`，即使返回值是 `undefined`；
- reject 且按产品合同固定提取规则命中 partial：`partial_from_error`，省略正式 `result`，必须有 `partialResults`；
- 多个 partial 来源全部保留，例如 `subtaskResultText` 和自定义 `partialResult`；
- 不使用 `result: null` 代表未返回，因为 Provider 合法结果本身可以是 `null`。

## Writeback 实体

```ts
type ToolWritebackAttemptArtifact = {
  attemptId: string;
  sequence: number;
  role: WritebackRole;
  startedAt: number;
  settledAt?: number;
  itemId: number;
  status: "running" | "completed" | "failed";
  output: LosslessSnapshot;
  outcome: WritebackOutcome;
  responseItem?: LosslessSnapshot;
  errorId?: string;
};
```

规则：

- `attemptId` 在 capture 内稳定，例如 `wb-1`；
- `output` 是 API 调用前的完整 `AgentToolOutput` 快照；
- API fulfilled 后 `outcome=succeeded`，`responseItem` 保存 `updateContextItem()` 返回的完整 context item；
- reject 后 `outcome=failed` 且必须有 `errorId`；
- 若进程在 settle 前崩溃，文件通常不会发布；若通过未来恢复机制得到未决记录，才使用 `unknown`，本期正常发布不应产生 `unknown`；
- artifact 可以只包含与本 `failureKind` 相关及其前置必要的 writeback attempts，但推荐每个 kind 文件都包含该调用截至发布时的完整 writeback 时间线，便于单文件分析。本文定稿为：**每个 kind 文件包含完整 writebacks 数组**。

Provider callback 边界：

- `provider_running_update` 只表示当前实际存在的 Provider `updateToolItem({status:"running"})` callsite；
- `provider_running_report` 只表示 `reportRunningOutput()`；
- 虽然当前 `ToolExecutionContext.updateToolItem` 类型允许 `completed|failed`，但没有对应 Provider callsite，本期不定义 callback terminal role；
- 未来新增 Provider callback completed/failed 前，必须扩展 `WritebackRole`、stage/行为矩阵和测试，不能自动复用顶层 `completed/inner_failed/outer_failed`。

## Error 实体

保真图中的属性 descriptor 和反射错误必须使用明确实体：

```ts
type EncodedOwnProperty = {
  key: EncodedPropertyKey;
  descriptor:
    | {
        kind: "data";
        enumerable: boolean;
        configurable: boolean;
        writable: boolean;
        value: EncodedValue;
      }
    | {
        kind: "accessor";
        enumerable: boolean;
        configurable: boolean;
        get: EncodedValue | { type: "absent" };
        set: EncodedValue | { type: "absent" };
      };
};

type ReflectionError = {
  kind: "reflection_error";
  operation:
    | "get_own_property_descriptors"
    | "own_keys"
    | "get_own_property_descriptor"
    | "get_prototype_of";
  propertyKey?: EncodedPropertyKey;
  thrown: EncodedValue;
};

type ErrorSemanticObservation =
  | { availability: "data"; owner: "own" | { prototypeDepth: number }; value: EncodedValue }
  | {
      availability: "unavailable_accessor";
      owner: "own" | { prototypeDepth: number };
      descriptor: Extract<EncodedOwnProperty["descriptor"], { kind: "accessor" }>;
    }
  | { availability: "absent" }
  | { availability: "reflection_error"; error: ReflectionError };
```

实体合同：

- 使用 `Object.getOwnPropertyDescriptors()` 或等价 descriptor 反射枚举自有 string/symbol keys；
- data property 保存完整 value 与 descriptor 元数据；
- accessor 只保存 descriptor 和 getter/setter 函数引用/标识，不读取值；
- Error node 的 `errorName/message/stack/cause/aggregateErrors` 均使用 `ErrorSemanticObservation`；
- `unavailable_accessor` 表示找到了 accessor 但未调用；`absent` 表示沿原型链找不到；`reflection_error` 只表示 descriptor/原型反射本身失败；
- 不定义任何“属性求值错误”实体，因为编码器不得执行 getter；反射操作自身失败只使用 `reflection_error`。

```ts
type CapturedErrorArtifact = {
  errorId: string;
  capturedAt: number;
  summary: {
    classification: "error" | "non_error_throw";
    name?: string;
    code?: string;
    message: string;
  };
  thrown: LosslessValueGraphV1;
};
```

规则：

- `errorId` 对同一 thrown 对象在一个 capture 中稳定。对象/函数使用 WeakMap 分配；primitive throw 使用“类型+值保真编码+首次 sequence”分配，并在同一 catch 传播链显式传递 ID；
- `summary` 仅用于索引，不替代 `thrown`；
- Error 自有 data properties 在 `thrown` 图中完整表达；自有 accessor 只表达 descriptor；
- Error 的 `name/message/stack/cause/errors` 按 data/unavailable_accessor/absent/reflection_error 表达，不伪造默认值；
- `summary.name/message/code` 只能从已编码的 data property 语义值派生；accessor/absent/reflection_error 时省略相应可选字段，`summary.message` 无 data value 时固定为 `"<unavailable>"`，该固定检索占位不得写入 Error 语义字段本身；
- 文件内 data message 不截断；writer warning 则单行化并将整行限制为 512 个 JavaScript 字符单元，该日志规则不改变 artifact。

## 事件实体

```ts
type ToolErrorEventArtifact = {
  eventId: string;
  sequence: number;
  occurredAt: number;
  stage: ToolErrorStage;
  failureKind: FailureKind;
  phaseAttempt: number;
  errorId?: string;
  sameErrorId?: string;
  causedByErrorId?: string;
  writebackAttemptId?: string;
  details?: LosslessSnapshot;
};
```

规则：

- `eventId` 在 capture 内固定为 `event-<sequence>`；
- `failureKind` 必须由中央映射产生；
- `phaseAttempt` 同一 stage 首次为 1，真实重入再递增；
- `sameErrorId` 用于说明某事件只是观察同一异常跨层传播；通常和 `errorId` 相同，可省略。为减少歧义，本文定稿：事件自己的错误填 `errorId`；传播观察填 `sameErrorId=<已有 errorId>`，且不再重复设置 `errorId`；
- `causedByErrorId` 表示次生错误由哪个前序根因触发，例如 failed writeback error 由 Provider error 导致的失败处理触发；
- `details` 保存 stage 特有数据，如 policy reason、恢复前状态、partial result 字段名，不重复复制 args/result/output。

事件去重键：

```text
failureKind + stage + phaseAttempt + (errorId || sameErrorId || "no-error")
```

完全相同的 key 只保留第一次。

## Publication 实体

```ts
type ToolErrorPublication = {
  relativePath: string;
  canonicalRelativePath: string;
  conflictWithCanonical: boolean;
  publishedAt: number;
  writer: "agent-worker";
};
```

- canonical 文件两条路径相同，`conflictWithCanonical=false`；
- conflict 文件 `relativePath` 为 conflict 路径、`canonicalRelativePath` 为原 canonical、布尔值为 true；
- `publishedAt` 需要在最终 JSON 写入前确定；临时文件写入/排他发布完成后会有少量时差，接受该语义；
- 若 canonical 已存在且身份一致，本次不发布新文件，因此不会生成新的 publication 实体。

## 保真值图实体

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

详细类型标签和行为以 [04-technical-design.md](./04-technical-design.md)“保真序列化设计”为准。实现必须在 `losslessValueGraph.ts` 中导出 TypeScript 类型和纯函数，不放入 shared package，因为它是诊断文件私有格式，不是 Agent 业务协议。

## 完整 JSON 示例

以下示例省略了保真图的部分 node 内容，仅用于展示结构；实际文件不得以 `...` 省略数据。

```json
{
  "schemaVersion": 1,
  "kind": "tool_error",
  "captureId": "toolerr_m4abc123_9f2d",
  "recordedAt": 1730000000300,
  "failureKind": "runtime",
  "identity": {
    "workspaceId": "ws_1",
    "sessionId": "session_1",
    "runId": "run_1",
    "itemId": 42,
    "toolCallId": "call_abc"
  },
  "tool": {
    "name": "bash",
    "source": "builtin",
    "initialStatus": "queued",
    "args": {
      "capturedAt": 1730000000000,
      "graph": {
        "format": "awb-lossless-value-graph",
        "version": 1,
        "root": { "type": "ref", "id": "1" },
        "nodes": {
          "1": {
            "kind": "object",
            "tag": "[object Object]",
            "properties": []
          }
        }
      }
    }
  },
  "execution": {
    "providerStartedAt": 1730000000050,
    "providerSettledAt": 1730000000100,
    "resultAvailability": "returned",
    "result": {
      "capturedAt": 1730000000100,
      "graph": {
        "format": "awb-lossless-value-graph",
        "version": 1,
        "root": { "type": "ref", "id": "1" },
        "nodes": {}
      }
    }
  },
  "writebacks": [
    {
      "attemptId": "wb-2",
      "sequence": 7,
      "role": "completed",
      "startedAt": 1730000000200,
      "settledAt": 1730000000250,
      "itemId": 42,
      "status": "completed",
      "output": {
        "capturedAt": 1730000000200,
        "graph": {
          "format": "awb-lossless-value-graph",
          "version": 1,
          "root": { "type": "ref", "id": "1" },
          "nodes": {}
        }
      },
      "outcome": "failed",
      "errorId": "err-1"
    }
  ],
  "errors": [
    {
      "errorId": "err-1",
      "capturedAt": 1730000000250,
      "summary": {
        "classification": "error",
        "name": "Error",
        "message": "request failed"
      },
      "thrown": {
        "format": "awb-lossless-value-graph",
        "version": 1,
        "root": { "type": "ref", "id": "1" },
        "nodes": {}
      }
    }
  ],
  "events": [
    {
      "eventId": "event-8",
      "sequence": 8,
      "occurredAt": 1730000000250,
      "stage": "completed_writeback_failed",
      "failureKind": "runtime",
      "phaseAttempt": 1,
      "errorId": "err-1",
      "writebackAttemptId": "wb-2"
    }
  ],
  "publication": {
    "relativePath": ".awb/agent/tool-errors/by_run/session_1/run_1/42-call_abc.runtime.json",
    "canonicalRelativePath": ".awb/agent/tool-errors/by_run/session_1/run_1/42-call_abc.runtime.json",
    "conflictWithCanonical": false,
    "publishedAt": 1730000000300,
    "writer": "agent-worker"
  }
}
```

## 文件目录和命名

固定目录：

```text
<workspace>/
  .awb/
    agent/
      tool-errors/
        by_run/
          <safeSessionId>/
            <safeRunId>/
              <itemId>-<safeToolCallId>.tool.json
              <itemId>-<safeToolCallId>.policy.json
              <itemId>-<safeToolCallId>.recovery.json
              <itemId>-<safeToolCallId>.runtime.json
```

canonical：

```text
<itemId>-<safeToolCallId>.<failureKind>.json
```

conflict：

```text
<itemId>-<safeToolCallId>.<failureKind>.conflict-<recordedAt>-<attempt>.json
```

临时文件：

```text
.<canonical-or-conflict-base>.<pid>.<safeCaptureId>.<sequence>.tmp
```

`safeSessionId/safeRunId/safeToolCallId/safeCaptureId` 统一使用同一 `safePathSegment()`；不得各自实现不同规则。

## 当前代码地图

> 下表行号以文档编写时工作区为基线，会随实现漂移。开发和审查必须优先按文件与符号检索，不得机械依赖行号。

### Agent Worker

| 文件 | 当前符号/行号范围 | 当前职责 | 本次关系 |
|---|---|---|---|
| `apps/agent-worker/src/runtime/runner.ts` | `27-60` | 环境变量和工具输出配置 | 新增 `AWB_TOOL_ERROR_STORE_ENABLED`，或从新模块导入启动时常量 |
| 同上 | `282-489` | `buildToolSuccessText()`、`buildToolErrorText()` | output 构造的源函数，产品文本保持不变 |
| 同上 | `492-615` | `isPathInside()`、`safePathSegment()`、`finalizeToolText()` | 现有 `.awb` 安全思路；建议抽取公用 Worker 安全原语且冻结成功 artifact 行为 |
| 同上 | `607-623` | `QueuedRun`、`PendingTool`、`ToolCall` | capture identity 和 args 来源 |
| 同上 | `804-853` | `sanitizeForDebugDump()`、`writeItemLog()` | 不复用脱敏序列化；Debug Dump 行为不变 |
| 同上 | `943-978` | `buildToolExecutionBatches()` | 并行工具要求 writer 并发安全 |
| 同上 | `1177-1390` | `executeTool()` | policy 二次检查、running writeback、Provider 调用、result/output 构造、内层失败接入 |
| 同上 | `1392-1442` | `executeToolSafely()` | capture 生命周期、外层 runtime 事件、finally 发布 |
| 同上 | `1444-1461` | `executeToolBatch()` | 并发调用边界，业务行为不改 |
| 同上 | `1463-1588` | `executePendingTools()` | pending policy、running recovery 的 standalone capture |
| 同上 | `1893-1915` | `listTools()` 与模型 request tools/messages | 工具定义和模型请求上下文 |
| 同上 | `2135-2142` | tool-call chunk 解析 | `tool.args` 最初来源 |
| 同上 | `2312-2352` | queued tool context item 创建 | `output.args` 的持久化来源 |
| 同上 | 文件尾 `executeToolForTest()` 等 | test exports | 可扩展测试入口，但不得为测试暴露生产内部过多细节 |
| `apps/agent-worker/src/runtime/tools/types.ts` | `5-13` | 现有源码 `ToolSource/ResolvedToolDefinition` | 只复用来源判定语义；artifact 新类型名必须是 `ArtifactToolSource`，不得修改现有 `ToolSource` |
| 同上 | `25-31` | `PendingToolExecution` | item/toolCall/args 类型 |
| 同上 | `58-76` | `ToolExecutionContext/ToolProvider`；`updateToolItem` 类型允许 running/completed/failed | 本期 callback 捕获只支持当前实际 running callsite 与 `reportRunningOutput`；terminal callback 必须先扩展合同 |
| 同上 | `95-106` | `isBuiltinToolName/isMcpToolName/isPluginToolName` | tool source 判定 |
| 同上 | `122-130` | `isJsonSerializable()` | 不能满足保真序列化，不复用为 writer 核心 |
| `apps/agent-worker/src/runtime/tools/registry.ts` | `24-35` | Provider 路由、enabled 检查和 execute | Provider reject 的统一观察点在 Runner，不建议 Registry 自行落盘 |
| `apps/agent-worker/src/runtime/tools/providers/builtin.ts` | `726` 附近 | 当前唯一检出的 Provider `ctx.updateToolItem()` callsite：subtask 写 running output | 包装为 `provider_running_update`；不得据类型签名宣称支持 callback completed/failed |
| `apps/agent-worker/src/runtime/apiClient.ts` | `173-199` | context item create/update；update 返回 `res.item` | writeback response snapshot 来源 |

### Shared 与 API 边界引用

| 文件 | 当前符号/行号范围 | 当前事实 | 本次边界 |
|---|---|---|---|
| `packages/shared/src/contracts/agent.ts` | `72-82` | `AgentToolOutputSchema` 含 `args/text/textTruncated/textArtifactPath/result/error` | 本期不改 schema；完整 output 以动态快照保存 |
| `apps/api/src/modules/agent/agent.composition.ts` | `694` 附近 | `resolveToolOutputText()` 优先 text，否则 stringify result | 说明模型结果文本来源 |
| 同上 | `2160-2252` 附近 | terminal tool item 重建 tool-call/tool-result；使用 output args/text/error | 本期不重复捕获最终 message |
| `apps/api/src/modules/agent/prompt/tool-projectors/index.ts` | `15-35` | call input/result projector registry | input projector 当前进入主 composition；result projector 文档编写时未进入该主路径，开发前按符号复核 |
| `apps/api/src/modules/agent/prompt/tool-projectors/default.ts` | `3-9` | 默认 args/result 原样返回 | 仅代码事实引用 |
| `apps/api/src/modules/agent/prompt/tool-projectors/apply-patch.ts` | `38-100` | args 保留、result projector 可缩减文件列表 | 证明 projector 具备改变 result 表达的能力；不声称当前主 composition 已调用它 |
| `apps/api/src/modules/agent/artifact/safe-file-io.ts` | `12-69` | containment、逐级目录、O_NOFOLLOW 读写参考 | Worker 可参考，不得跨层导入 |

## 目标改动清单

### 新增

| 文件 | 必须内容 |
|---|---|
| `apps/agent-worker/src/runtime/losslessValueGraph.ts` | V1 类型、descriptor-only 属性编码、Error 语义四态、reflection_error、特殊对象/循环引用处理 |
| `apps/agent-worker/src/runtime/toolErrorCapture.ts` | 开关、capture、stage→kind、即时快照、writeback attempts、Error ID、事件去重、artifact 组装 |
| `apps/agent-worker/src/runtime/toolErrorStore.ts` | 路径、canonical/conflict 身份、best-effort 发布、限频 warning |
| `apps/agent-worker/src/runtime/workspaceSafeIo.ts` | safe segment、containment、safe dirs、no-follow、临时文件、hard-link 排他发布 |
| 对应三个测试文件 | 编码器、文件存储、Runner 行为 |

### 修改

| 文件 | 必须改动 |
|---|---|
| `apps/agent-worker/src/runtime/runner.ts` | 注入 capture；统一 writeback wrapper；保存 result/output；policy/recovery standalone capture；finally 发布 |
| `apps/agent-worker/src/runtime/tools/types.ts` | 原则上不改现有 `ToolSource` 或 callback status 签名；如为内部 capture 注入必须修改，仍不得宣称新增 terminal callback 支持，也不得改变 shared schema/Provider 外部合同 |
| `apps/agent-worker/src/runtime/runner.tool-output.test.ts` 或新 runner 测试 | 冻结现有行为并验证 completed writeback 数据窗口 |
| `apps/agent-worker/src/runtime/runner.cancel.test.ts` | 验证 Abort 不落盘 |

### 不得修改

除测试为证明不回归外，本期不得业务修改：

- `packages/shared/src/contracts/agent.ts`；
- API internal contract、Route、Store、数据库；
- `apps/api/src/modules/agent/prompt/` 与 `agent.composition.ts`；
- 用户工作区 `.gitignore`；
- MCP/plugin/builtin Provider 返回协议；
- Agent UI。

## 代码审查引用规则

- 审查者必须按符号检索最新代码，不以本文旧行号判定遗漏。
- 若实现重命名模块，职责和合同仍必须逐项映射，文档中的路径变更应同步更新。
- 若发现当前 API projector 实际调用关系与文档引用变化，只更新“当前事实”描述；不得因此把 API 最终 message 捕获扩入本期。
- 任何新增 stage 必须先更新中央枚举、映射、产品矩阵和测试；不得在日志字符串中临时创造未文档化分类。
