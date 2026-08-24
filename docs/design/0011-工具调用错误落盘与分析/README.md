# 工具调用错误落盘与分析

> 状态：设计定稿，面向开发、代码审查与验收。
> 范围：仅在 Agent Worker 内为工具调用失败生成工作区本地 `.awb` 诊断文件；不改变 Agent 对外产品流程、API 协议、模型上下文合同或工具成功行为。
> 基线：本方案以当前工作区代码为基线；代码路径与行号用于检索，后续会随实现漂移，开发前必须按符号名复核。

## 快速结论

- 功能默认关闭，仅当 Agent Worker **进程启动时**读取到 `AWB_TOOL_ERROR_STORE_ENABLED=1` 才启用；其他任何值均视为关闭。
- 关闭时不得创建 `.awb/agent/tool-errors` 目录，不得构造诊断实体、遍历/序列化动态值，也不得产生该功能的文件 I/O。
- 仅记录非取消类工具失败，以及同一工具调用关联的 runtime/writeback 多阶段失败；成功调用、Abort、用户取消均不记录。
- 文件固定写入：

  ```text
  .awb/agent/tool-errors/by_run/<safeSessionId>/<safeRunId>/<itemId>-<safeToolCallId>.<failureKind>.json
  ```

- `failureKind` 固定为 `tool | policy | recovery | runtime`。同一调用、同一 kind 只发布一个文件；不同 kind 可以同时存在。一个 kind 内的多个阶段写入同一文件的 `events` 数组。
- `tool.args`、Provider 已返回的 `result`、拟写回和已写回的完整 `AgentToolOutput` 必须按 Worker 实际取得的数据完整保存，不做字段脱敏、不做业务内容截断，也不设单文件 max-bytes 截断。
- 编码器只保存运行时已经持有的 data property 值；不得调用普通对象或 Error 自定义 accessor/getter，不调用 `toJSON()` 或自定义 `toString()`。Error 语义字段固定采用 `data | unavailable_accessor | absent | reflection_error` 四态，不得伪造默认值。
- 动态值采用版本化保真图编码，明确表示 `undefined`、`BigInt`、特殊 Number、Symbol、Function、循环引用、共享引用和 Error 非枚举字段，避免原生 `JSON.stringify` 静默丢字段或直接失败。
- fully supported 环境必须同时支持同目录 hard link 与 Node no-follow 打开语义（`O_NOFOLLOW` 或项目认可的等价能力）。项目主要验收基线是 Linux 本地运行环境；具体工作区文件系统是否支持必须由能力测试证明，不按文件系统名称作未经验证的承诺。
- 不支持 hard link/no-follow、跨设备、只读或权限不足的工作区，本功能必须不可用但安全失败：不发布 final 文件、尽力清理本次 temp、输出限频 warning，且不影响 Agent 主流程；不得使用普通 rename、弱化 no-follow 或回退到其他目录。
- 本期不自动上传、不做集中遥测/审计、不自动清理、不修改用户工作区 `.gitignore`、不改 shared Agent schema、不新增 API endpoint、不把错误文件路径送入模型上下文。

## 阅读路径

| 文档 | 内容 |
|---|---|
| [01-overview.md](./01-overview.md) | 需求背景、目标、非目标、角色、使用场景与范围边界 |
| [02-product-contract.md](./02-product-contract.md) | 启用合同、业务逻辑、行为矩阵、数据可用性、取消与降级规则 |
| [03-decisions.md](./03-decisions.md) | 关键决策、备选方案、取舍原因、风险与应对 |
| [04-technical-design.md](./04-technical-design.md) | 运行时链路、组件职责、接入点、捕获时序、序列化与安全写入 |
| [05-entity-and-code-map.md](./05-entity-and-code-map.md) | JSON 实体、枚举、目录命名、代码引用与改动清单 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、验收标准、失败注入、审查清单与可观测性 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 开发任务拆分、依赖、实施步骤、验证、回滚点与完成定义 |

## 规范性约定

- “必须”表示实现、代码审查和验收的强制要求，对应 `MUST`。
- “不得”表示禁止行为，对应 `MUST NOT`。
- “应该”表示除非有本文已列明的理由，否则必须遵循，对应 `SHOULD`。
- “可以”表示不影响合同的可选实现，对应 `MAY`。
- “当前实现”描述文档编写时的源码事实；“目标设计”描述本次开发完成后必须达到的状态。
- 发生冲突时，用户已定稿决策与 [02-product-contract.md](./02-product-contract.md) 优先于一般性调研建议；更具体的行为矩阵优先于概括性文字。
- “完整记录”指 Worker 在该调用生命周期内**已经持有的 data value** 完整保存；采集不得为了扩大可见数据而执行 getter/accessor、`toJSON()` 或自定义 `toString()`。accessor 的计算值不属于运行时已取得数据，也不代表能够恢复工具 reject 前从未返回、从未挂在异常或部分结果上的数据。
- “AgentToolOutput”指 `packages/shared/src/contracts/agent.ts` 中 `AgentToolOutputSchema` 表达的工具 context item output，而不是 API 后续构造出的最终 AI SDK message。
- “发布”指临时文件完整写入后，以排他、原子的方式生成最终文件名；未发布的临时文件不算成功记录。

## 关键不变量

- `AWB_TOOL_ERROR_STORE_ENABLED` 只有精确值 `1` 启用；环境变量在进程启动时读取，运行中修改不要求生效。
- 关闭时诊断功能是零文件 I/O 路径，且不执行重型序列化或动态对象遍历。
- Abort、用户取消、执行前已取消不得落入 `tool-errors`。
- 每个 stage 到 `failureKind` 的映射由本文固定，开发不得自行重新分类。
- `tool.args` 不脱敏、不做内容截断；已取得的 Provider result、partial result、AgentToolOutput 和 Error 信息同样不脱敏、不做业务截断。
- partial result 只从异常对象规定的自有 data property 提取；accessor 不调用、不提取。
- Provider 抛错且没有返回结果时，`resultAvailability` 必须为 `not_returned`，不得填充空对象或猜测 stdout/stderr。
- Provider 已成功返回后，任何后续 completed writeback/runtime 失败都必须保留完整 Provider result 与候选 completed `AgentToolOutput`。
- Provider callback 本期只支持当前实际存在的 running update/report；未来若直接 callback 写 completed/failed，必须先扩展 stage、role 和测试，不能自动归类。
- `executeTool()` 与 `executeToolSafely()` 可以共同贡献事件，但不得覆盖根因、不得为同一异常生成重复事件；每个 kind 最终只发布一份含有有序 `events` 的文件。
- writer 自身错误不得再次调用 writer，不得递归生成 error artifact。
- 工作区 containment、安全路径片段、逐级拒绝 symlink、目标 no-follow、严格创建权限、临时文件和排他发布不得因“本地文件”或“不脱敏”而省略。
- writer warning 必须单行化且整行最多 512 个 JavaScript 字符单元，只包含目标相对路径、操作、错误 name/code/message 摘要和抑制计数；该日志截断不等于 artifact 内容截断。
- 错误 artifact 不进入 context item、不进入 Prompt、不改变 API projector、不成为模型可调用的 artifact。
- 本期不承诺完整性、持久性、全局可查询性、保留期限或法务意义上的审计能力。
