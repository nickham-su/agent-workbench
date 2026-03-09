# Assistant Reasoning 持久化与 UI 展示方案(v1)

本方案只聚焦 **AI SDK reasoning 通道** 的采集、存储、接口透出与前端展示。

这里的 reasoning 特指 AI SDK `streamText()` / `generateText()` 返回的结构化 reasoning 能力,不包含模型把 `<think>...</think>` 或类似“思考草稿”直接输出到普通文本中的场景。

## 背景

当前 agent-workbench 的 assistant 输出链路只持久化最终可见正文:

- Worker 在 `apps/agent-worker/src/runtime/runner.ts` 中消费 `streamText(...).fullStream`
- 现有逻辑只处理 `text-delta` / `tool-call` / `finish` / `error`
- API/Store 只把 assistant 的 `output.text` 映射到 `agent_context_item.output_text`
- `AgentAssistantTextOutputSchema` 当前只有 `{ type: "assistant_text", text: string }`

因此即使 AI SDK 和底层 provider 返回了 reasoning 内容:

- DB 中没有对应字段
- `/context-items` 查询结果中没有 reasoning
- Web UI 无法展示 reasoning

同时,本项目已有 artifact 设计主要面向:

- 工具大输出
- 用户复制粘贴的大文本

assistant 模型输出本身风险相对更低,且本期目标是先验证 reasoning 对 UI 体验的真实价值。因此 v1 选择 **先以单字段落地 reasoning 文本**,暂不引入 reasoning artifact / truncation 机制。

## 目标

- 采集 AI SDK reasoning 通道,并与同一条 assistant context item 绑定持久化。
- Web UI 能在 assistant 正文之前展示 reasoning。
- reasoning 与 assistant 正文一起流式刷新,但避免过于频繁的 DB/API 写入。
- reasoning 不进入后续 prompt,避免模型回看自己的 reasoning。
- 保持 v1 改动范围可控,不引入新表、artifact、归档格式变更或额外轮询接口。

## 非目标

- 不处理模型把“思考内容”直接混入普通 assistant 正文文本的场景。
- 不实现 reasoning artifact / truncation / 独立拉取接口。
- 不把 reasoning 纳入 prompt-context、archive、compaction、transcript 主文本。
- 不新增 reasoning 搜索、权限隔离、统计分析或审计能力。
- 不对不同 provider 的 reasoning 质量做统一标准化,仅按 SDK 实际返回展示。

## 关键决策

- reasoning 不是新的 context item,而是 **assistant item 的附属展示数据**。
- v1 不新建独立表,直接给 `agent_context_item` 增加一列 `assistant_reasoning_text`。
- API/Shared Contract 对外不暴露裸 DB 列,而是把 reasoning 作为 `assistant_text` 的可选结构返回,为未来扩展预留空间。
- Worker 采用 **B 方案**: reasoning 与正文一起流式更新同一条 assistant item。
- 前端默认 **永久展示 reasoning**,位置在正文之前,字号为当前消息字号的 `0.85`,颜色弱化。
- v1 不做 reasoning artifact;若后续出现超长、性能或 UI 问题,再在保持 API 兼容的前提下补 `truncated/artifactPath`。

## 为什么不采用其他方案

### 不作为独立 context item

reasoning 不属于对话中的独立语义消息。如果写成单独 item:

- 会污染 transcript 与上下文链语义
- 会增加 prompt 构建误注入风险
- 会让 UI 列表出现“思考消息”和“正式回答”混排,可读性更差

### 不先做独立表

当前 reasoning 与 assistant item 是天然 1:1 关系,且目标是直接内联展示。独立表会带来:

- 额外查询/轮询成本
- 更多 Store/Service/API 复杂度
- 但第一期收益有限

因此先放在主表同一行更符合当前架构。

### 不塞到 `output_json`

`output_json` 在当前实现中主要是历史兼容字段,并非未来扩展主路径。继续复用该列会让读写逻辑混乱,不利于后续维护。

## AI SDK 行为约定

基于当前依赖版本(`ai@5.x`),`streamText()` 的 `fullStream` 会返回 reasoning 相关 chunk:

- `reasoning-start`
- `reasoning-delta`
- `reasoning-end`

并且 `StreamTextResult` 还可在结束后读取:

- `reasoning`
- `reasoningText`

v1 采用的消费原则:

- 以流式 chunk 为主进行实时展示与持久化
- 在 step 收尾阶段可再读取一次最终 `reasoningText`,作为兜底校正
- chunk 字段读取时采取宽松兼容:
  - 优先读 `chunk.text`
  - 若未来某些 SDK 内部形状变化,可兼容 `chunk.delta`

## 数据模型

### agent_context_item 新字段

在 `agent_context_item` 新增:

- `assistant_reasoning_text text null`

约束:

- 仅 `kind=assistant` 的记录允许写入该字段
- 其他 kind 必须为 `null`
- 没有 reasoning 或 provider 未返回 reasoning 时保持 `null`

### 为什么 v1 只加一个字段

- 当前 artifact 主要用于工具输出和用户大文本,assistant reasoning 先按普通文本处理更简单
- 先验证真实 UI 效果与数据规模,避免过早设计复杂容量治理
- 单字段足以支撑“采集 + 流式更新 + UI 展示”的主链路

### v2 扩展预留

若后续出现以下问题:

- reasoning 明显过长
- DB 行体积增大
- UI 渲染卡顿
- 需要展示完整 reasoning 与 preview 的区分

再扩展:

- `assistant_reasoning_truncated`
- `assistant_reasoning_artifact_path`

v1 的 API 结构会为该扩展预留兼容空间。

## Shared Contract 与 API 形状

### Assistant output 建议形状

将 assistant output 从:

```ts
{ type: "assistant_text", text: string }
```

扩展为:

```ts
{
  type: "assistant_text",
  text: string,
  reasoning?: {
    text: string
  }
}
```

说明:

- DB 层只新增一列,但 API 层直接采用对象结构,避免未来从 `reasoningText?: string` 再破坏式升级到对象。
- 当 `assistant_reasoning_text` 为空或 `null` 时,API 不返回 `reasoning` 字段。
- v2 若补 artifact/truncation,可平滑扩展为:

```ts
reasoning?: {
  text: string,
  truncated?: boolean,
  artifactPath?: string
}
```

### internal create/update context item

v1 建议继续沿用现有 create/update context item 主路径,只是 assistant output 增加可选 reasoning 字段:

- create assistant item 时:
  - `text = ""`
  - 不传 reasoning
- streaming update 时:
  - 传当前累计 `text`
  - 若已有 reasoning 内容,一并传 `reasoning.text`
- finish 时:
  - 用最终 `text + reasoning` 统一收口

## Store 层映射规则

### 写入

- `kind=assistant && output.type=assistant_text`
  - `output_text <- output.text`
  - `assistant_reasoning_text <- output.reasoning?.text ?? null`
- 非 assistant item
  - `assistant_reasoning_text <- null`

### 读取

- `row.kind === "assistant"` 时:
  - 基础输出仍为 `{ type: "assistant_text", text: row.outputText }`
  - 若 `assistantReasoningText` 非空,附加:

```ts
reasoning: { text: row.assistantReasoningText }
```

### 终态冻结规则

沿用现有规则:

- 非终态 assistant item 允许更新正文与 reasoning
- item 进入终态后冻结

## Worker 方案

### 总体流程

每个 step 中:

1. 创建 `assistant` item,`status=streaming`
2. 调用 `streamText()`
3. 同时累计:
   - `text`
   - `reasoningText`
4. 按节流策略合并更新同一条 item
5. step 完成后用最终内容收口

### 采集规则

处理以下 chunk:

- `text-delta`
  - 追加到 `text`
- `reasoning-delta`
  - 追加到 `reasoningText`
- `tool-call`
  - 保持现有逻辑
- `finish`
  - 保持现有 usage 逻辑
- `error`
  - 保持现有错误逻辑

`reasoning-start` / `reasoning-end` 在 v1 仅用于状态感知与调试,不单独持久化边界事件。

### 更新策略(B方案)

采用 **正文与 reasoning 合并更新**:

- Worker 维护当前累计值:
  - `text`
  - `reasoningText`
- 每次刷新同一条 assistant item 时,统一提交:

```ts
{
  status: "streaming",
  output: {
    type: "assistant_text",
    text,
    ...(reasoningText ? { reasoning: { text: reasoningText } } : {})
  },
  updatedAt: nowMs()
}
```

### 节流策略

为避免 reasoning 流导致写放大,v1 采用简单节流:

- 当满足任一条件时触发一次 update:
  - 距上次成功 update 已达到 `200-300ms`
  - 或自上次 update 以来新增正文/思考累计达到 `80` 个字符
  - 或遇到 `finish/error/abort` 等收尾事件

约束:

- text 与 reasoning 共享同一个 flush 定时器/阈值
- 不允许“正文单独更,reasoning 单独更”造成相互覆盖
- step 完成前必须执行最后一次强制 flush

### 收尾与兜底

在流结束后:

- 若需要,可读取一次 `await stream.reasoningText` 与本地累计值做简单兜底
- 最终 `completed` 更新时写入最终 `text + reasoning`
- 失败场景下,若已经采集到部分 reasoning,允许与失败态 assistant 一起保留

### 调试日志

assistant item debug log 中建议追加:

- `response.reasoningText`
- 可选 `response.reasoningPresent`

这样便于排查某模型到底有没有返回 reasoning,以及 UI 不显示时是采集问题还是 provider 未返回。

## Prompt / Archive / Compaction 规则

### Prompt Context

`getPromptContextForRun()` 继续只使用 assistant 正文 `text` 参与 prompt 构建。

明确禁止:

- 不把 `assistant_reasoning_text` 拼入 assistant message
- 不把 reasoning 作为 system snippet 注入
- 不把 reasoning 作为 tool result 或隐藏上下文传给模型

原因:

- 避免模型回看自己的 reasoning,影响后续生成稳定性
- 避免 prompt 冗余与 token 浪费
- 保持 reasoning 仅作为用户体验增强信息

### Archive / Search / Compaction

v1 保持忽略 reasoning:

- archive line 不写 reasoning
- archive_search / archive_read 不读取 reasoning
- compaction 输入不包含 reasoning
- transcript 主文本不包含 reasoning

这样可避免把 UI 辅助数据扩散到长期上下文体系中。

## Web UI 方案

### 展示规则

对于 assistant item:

- 若存在 `output.reasoning.text` 且非空:
  - 渲染 reasoning 区块
  - 位置在 assistant 正文之前
  - 永久展示,不折叠
- 若 reasoning 不存在或为空:
  - 不渲染 reasoning 区块

### 样式规则

v1 按以下固定样式试效果:

- 字号: `messageFontSize * 0.85`
- 颜色: 相比正文明显弱化
- 布局: reasoning 在上,正文在下
- 与正文之间保留轻微间距

建议可附轻量标签,例如:

- `思考过程`
- 或 `Thinking`

标签应弱化展示,避免喧宾夺主。

### 流式表现

- reasoning 与正文一起刷新
- 不需要单独的 loading skeleton
- reasoning 区块允许在正文之前先出现、先增长
- 最终完成后保持原位不折叠

### 交互说明

v1 不做以下复杂交互:

- 不支持单独展开/收起 reasoning
- 不支持复制 reasoning 的专门按钮
- 不支持 reasoning 单独搜索/定位
- 不支持用户隐藏 reasoning 的设置项

若首轮效果不佳,后续可再评估:

- 默认折叠
- hover/点击展开
- 用户级开关
- 不同 provider/model 的展示策略差异化

## 兼容性与迁移

### DB 迁移

- 为 `agent_context_item` 增加 `assistant_reasoning_text`
- 历史数据不回填,统一保持 `null`
- 老 session 的 assistant item 在 UI 中自然表现为“无 reasoning”

### 接口兼容

- 新增字段为可选字段,前端与 worker 都可渐进兼容
- 老前端即使忽略 `reasoning`,也不影响正文渲染
- 新前端面对旧数据时也能正常工作

## 风险与规避

### 1. 写入频率过高

风险:

- reasoning delta 可能比正文更细碎,导致 API/DB 写放大

规避:

- text 与 reasoning 合并更新
- 使用固定节流窗口 + 字符阈值
- finish 时强制刷最后一次

### 2. reasoning 为空或质量不稳定

风险:

- 不同 provider/model/config 下 reasoning 可能缺失、很短或噪音较大

规避:

- reasoning 设计为 optional
- UI 对无 reasoning 零占位
- debug log 中保留采集信息,便于观察模型差异

### 3. reasoning 抢占正文注意力

风险:

- 永久展示且在正文前,可能让用户误把 reasoning 当正式回复

规避:

- 小字号
- 弱化颜色
- 与正文有间距
- 可加轻量标签
- 若效果不好,下一期再调整为折叠或更弱样式

### 4. reasoning 过长

风险:

- 个别模型可能返回很长 reasoning,影响列表渲染与 DB 行大小

规避:

- v1 先观察真实数据
- 若出现问题,按预留路径补 `truncated/artifactPath`
- 不在本期提前引入复杂治理

## 代码改造范围

### API / Store / Schema

- `apps/api/src/infra/db/schema.ts`
  - 新增 `assistant_reasoning_text`
- `apps/api/src/modules/agent/agent.store.ts`
  - row 类型补字段
  - encode/decode assistant output 时映射 reasoning
  - append/update SQL 补列
- `packages/shared/src/contracts/agent.ts`
  - `AgentAssistantTextOutputSchema` 增加可选 `reasoning`

### Worker

- `apps/agent-worker/src/runtime/runner.ts`
  - 处理 `reasoning-*` chunk
  - 增加 text+reasoning 合并节流刷新逻辑
  - 完成/失败时写入最终 reasoning
  - debug log 附带 reasoning 信息

### Web

- assistant message 渲染组件
  - 在正文之前渲染 reasoning
  - 按既定字号与颜色样式展示
  - 支持流式刷新

## 验证点

### 基础链路

- 模型返回 reasoning 时:
  - assistant item 在 streaming 阶段持续更新 reasoning
  - completed 后 reasoning 保留在同一条 item 上
- 模型不返回 reasoning 时:
  - assistant item 正文链路不受影响
  - UI 不渲染 reasoning 区块

### Prompt 隔离

- reasoning 持久化后,下一轮 prompt-context 中不应包含 reasoning 文本

### UI 表现

- reasoning 显示在正文前
- 字号为正文字号 `0.85`
- 颜色弱化
- 长 reasoning 不导致正文错位或闪烁异常

### 失败链路

- 请求失败前已收到部分 reasoning 时,失败态 assistant 可保留已采集 reasoning
- cancel/abort 时不会产生 text/reasoning 相互覆盖

## 后续演进

若 v1 验证结果显示 reasoning 对体验有价值,可按优先级考虑:

1. reasoning artifact / truncation
2. reasoning 默认折叠或用户开关
3. 按 provider/model 定制展示策略
4. reasoning 搜索/审计/导出能力
5. 更细的前端样式与可读性优化

## 最终结论

v1 最合理的落地方式是:

- 在 `agent_context_item` 上增加单列 `assistant_reasoning_text`
- 在 API 输出上把 reasoning 作为 assistant output 的可选结构透出
- Worker 采用合并节流的流式更新策略(B方案)
- 前端把 reasoning 永久展示在正文之前,使用 `0.85` 字号和弱化颜色
- reasoning 只用于 UI 展示,不进入 prompt / archive / compaction 主链路

该方案能在尽量小的改动范围内验证 reasoning 的真实用户价值,并为后续是否需要 artifact、折叠或更复杂治理提供观察基础。
