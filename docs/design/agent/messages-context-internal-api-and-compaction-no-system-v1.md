# messages-context 内部接口与 compaction 去 system/tools（v1）

## 背景与问题

在当前 agent 运行链路中，worker 在触发 compaction（自动压缩 / 手动压缩）时，会调用模型生成 `summaryText`，并将其写入一个新的 `system_text` context item（`boundaryReason = "compaction"`），同时归档旧上下文。

近期在 UI 上观察到一个问题：**compaction 生成的 system 摘要消息中混入了工具调用与工具输出文本**，例如出现：

- 伪造的工具调用 JSON（示例）：`{"recipient":"functions.bash","parameters":{...}}`
- 工具输出块（示例）：`tool: bash\nstatus: completed\nstdout: ...`
- 随后才是结构化的压缩摘要（例如“任务目标（已确认）/ 已完成了什么（确认事实）...”）

该现象会导致：

- UI 上 compaction system 消息“夹带”噪声，不符合“只显示压缩摘要”的预期。
- 后续模型接手时，summaryText 的可靠性降低（被执行态噪声污染）。

### 根因分析（简述）

当前 compaction 调用模型时复用了正常 prompt-context 的 **request-level system prompt**（即模型调用参数里的 `system` 字段）。该 system prompt 中包含执行态运行时约束（例如“每次回复必须包含工具调用”）。

当 compaction 使用 single-call 调模型且本次调用不提供 tools 时，模型可能为了满足 system 约束而在输出中**伪造**工具调用文本；同时历史 messages 中既有的 tool 输出内容也可能被模型复述/引用。

因此，本期修复聚焦于：

1) compaction **不再使用 request-level system 参数**；
2) compaction 调模型时 **不提供 tools**；
3) 为实现上述目标，引入一个通用的内部接口，向调用方仅暴露完整的 `messages`。

> 注：本方案不要求过滤 `messages` 内历史的 tool/system 内容（用户强约束：messages 必须完整），以保持接口通用性；它解决的是“执行态 system/tools 影响 compaction 的模型行为”的问题。

---

## 目标

1. 新增一个通用内部接口：`messages-context`
   - 仅返回完整 `messages` 列表（用于模型调用）
   - **不返回** request-level `system`（即不返回 system prompt 字符串）
   - **不返回** `tools` / `pendingTools`
2. 支持调用者传入 `appendMessage`（role + content），追加到返回 messages 的末尾
   - 第一版限制：`role in {"system","user"}` 且 `content` 为非空字符串
3. compaction 改为：
   - 通过 `messages-context` 获取 messages，并用 `appendMessage` 附加 compaction 提示词
   - single-call 调模型时：**不传** `system`，**不传** `tools`
4. 新接口不要求 `runId`（通用性更强）

---

## 非目标

1. 不改变 UI 的展示逻辑（UI 仅展示后端写入的 `system_text` 内容）。
2. 不过滤/投影 `messages` 内历史内容（包括 tool 角色消息与历史 system 消息）。
3. 不在本期修改 compaction 摘要模板或摘要结构。
4. 不在本期调整 tool output 的统一文本格式、artifact 策略等。

---

## 核心决策

### 1) 新增内部 `messages-context`，与现有 `prompt-context` 职责拆分

- `prompt-context`：面向正常 agent 执行（执行态），包含：
  - request-level `system`
  - `tools` / `pendingTools`
  - 运行时约束等
- `messages-context`：面向内部单次模型调用（非执行态），仅提供：
  - 完整 `messages`
  - 可选 `appendMessage`

### 2) compaction 调用模型不再传 request-level `system`，不再提供 tools

- compaction 的模型调用语义是“生成摘要”，不是“继续执行任务”。
- request-level `system` 中的执行态约束会干扰摘要任务。
- tools 会让模型更倾向于工具调用式输出；当 tools 不可用时，可能出现伪造调用文本。

### 3) `appendMessage` 第一版先收敛为提示词语义

- `appendMessage.role` 仅允许：`"system" | "user"`
- `appendMessage.content` 为非空字符串

理由：该字段主要用于追加“提示词/指令”，不应成为注入 tool/assistant 结构化内容的通道。

### 4) 接口不要求 `runId`

- 提升通用性：很多内部一次性任务（摘要、分类、标题生成等）可能只拿得到 `sessionId`。
- 避免将该接口绑定为“执行态 run 上下文接口”，从而与 `prompt-context` 语义重叠。

---

## 方案概述

### 新增内部接口

- API：新增 `POST /api/internal/agent/messages-context`
- 输出：仅 `{ headItemId, messages }`
- 输入：`workspaceId/sessionId/appendMessage?`

### compaction 使用方式

1. worker 调用 `messages-context` 获取历史 `messages`，并使用 `appendMessage` 追加 compaction 提示词：
   - `appendMessage.role = "user"`
   - `appendMessage.content = buildCompactionUserPrompt({ uiLocale: context.uiLocale })`
2. worker 调用 single-call 模型生成摘要：
   - **不传** request-level `system`
   - **不传** `tools`
   - 仅传 `messages`
3. worker 调用现有 `/api/internal/agent/context/compact` 提交 `summaryText`，由 API 落库并归档。

---

## API 设计

### 路由

- 方法：`POST`
- 路径：`/api/internal/agent/messages-context`

命名对齐现有内部接口：

- `/api/internal/agent/prompt-context`
- `/api/internal/agent/execution-profile`

### 鉴权

与现有内部 agent 路由一致：

- header：`x-awb-agent-internal-token`
- handler 内调用：`assertInternalToken(req, service)`

### Body schema（TypeBox 风格草案）

```ts
body: Type.Object({
  workspaceId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  appendMessage: Type.Optional(
    Type.Object({
      role: Type.Union([Type.Literal("system"), Type.Literal("user")]),
      content: Type.String({ minLength: 1 })
    })
  )
})
```

### Response schema（TypeBox 风格草案）

```ts
response: {
  200: Type.Object({
    headItemId: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    messages: Type.Array(
      Type.Object({
        role: Type.Union([
          Type.Literal("system"),
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool")
        ]),
        content: Type.Any()
      })
    )
  }),
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema
}
```

### 语义约束

- `messages`：与现有 `prompt-context` 中的 messages 构造方式保持一致（完整 messages）。
- 本接口**不返回** request-level `system` 字符串，也不返回 `tools/pendingTools`。
- `appendMessage`：追加在 `messages` 尾部。

---

## 测试与验收

### API 验收

- `messages-context` 返回 `{ headItemId, messages }`，不包含 `system/tools/pendingTools`。
- `appendMessage` 生效：最后一条 message 为追加的提示词。

### compaction 回归验收（核心）

- compaction 新增的 `system_text` 摘要不应再出现伪造 tool-call JSON（例如 `{"recipient":"functions.bash"...}`）。

> 备注：由于本方案不过滤历史 messages，摘要可能仍会引用历史 tool 输出，这是可接受行为；本期主要防止执行态 system/tools 诱导而产生伪造调用。

---

## 风险与回滚

- 风险：messages 完整保留时，摘要仍可能引用工具输出。
  - 本期接受；如需进一步降噪，可后续引入可选投影参数（v2）。
- 回滚：保留旧 compaction 路径作为兜底；如上线后异常，可切回旧路径。

---

## 开发落点

- API
  - `apps/api/src/modules/agent/agent.routes.ts`：新增内部路由
  - `apps/api/src/modules/agent/agent.service.ts`：新增 service 方法，并抽取/复用 messages 组装逻辑
- Worker
  - `apps/agent-worker/src/runtime/apiClient.ts`：新增 getMessagesContext
  - `apps/agent-worker/src/runtime/runner.ts`：compaction 调用改为 messages-only + 无 system
- Tests
  - `apps/api/src/modules/agent/agent.integration.test.ts`：新增 messages-context 用例
