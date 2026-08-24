# 需求背景、目标与范围

## 需求背景

Agent Worker 已经能够执行 builtin、MCP、本地插件和远端插件工具。工具失败时，当前主链会把 context item 更新为 `failed`，并把错误文本写入 `AgentToolOutput.error/text`。这足以支持模型继续推理和 UI 展示，但不适合作为长期的本地诊断样本：

- context item 主要服务会话语义，不区分 Provider 根因、运行时阶段和 writeback 次生错误；
- 普通失败只稳定保留错误消息，缺少完整 Error、执行阶段和已取得的中间结果；
- Provider 已成功返回但 completed writeback 失败时，完整 `result` 只存在于 `executeTool()` 局部变量，当前失败路径会丢失该结果；
- `AWB_AGENT_DEBUG_DUMP=1` 才会写 `.debug/agent_context_item_logs`，且现有 `sanitizeForDebugDump()` 会脱敏，也没有本方案需要的多阶段实体和幂等合同；
- `.awb/agent/artifacts/by_tool_call` 只保存部分成功工具的超长展示文本，不是失败诊断存储。

用户希望在明确启用时，把失败工具调用的完整可用输入、输出、写回候选与异常信息留在工作区 `.awb`，供以后人工复盘、离线聚类和运行时优化。该能力必须是旁路诊断，不能反过来降低 Agent 可用性。

## 当前问题

### 根因和次生错误混在一起

一次工具调用可能经历：

```text
Provider 执行失败
  -> Worker 构造 failed AgentToolOutput
  -> failed context writeback 又失败
  -> executeToolSafely 外层兜底再次尝试写回
```

也可能经历：

```text
Provider 成功并返回完整 result
  -> Worker 构造 completed AgentToolOutput
  -> completed context writeback 失败
  -> 工具项被尝试收敛为 failed
```

如果只保存一个错误字符串，无法判断是工具本身失败、权限策略拒绝、Worker 恢复失败，还是 Worker/API 写回失败。

### 已取得数据存在丢失窗口

当前 `ToolRegistry.execute()` 返回的 Provider `result` 先进入 `executeTool()` 局部变量，再用于构造 completed output。若后续写回失败，现有 catch 只使用 `args` 和异常消息构造 failed output，Provider 已返回的完整结果不再可见。本方案必须在 Provider 返回后立即保存执行快照，并在最终错误文件中保留它。

### “模型可见数据”存在多层对象

需要明确区分：

| 层次 | 含义 | 当前主要位置 |
|---|---|---|
| `tool.args` | 模型产生的 tool-call 输入，经 Worker `normalizeToolArgs()` 归一为对象 | `runner.ts` 的 `ToolCall.args`、queued `AgentToolOutput.args` |
| Provider `result` | `ToolRegistry.execute()` 返回的原始运行时值 | `executeTool()` 局部变量 |
| `AgentToolOutput` | Worker 拟写回/写回 context item 的源数据，包含 `args/text/result/error` 等 | `packages/shared/src/contracts/agent.ts` |
| 模型最终消息 | API 根据 context item 重建的 AI SDK message；当前主 composition 以 `output.args/text/error/result` 解析，仓库另有 projector 组件但 result projector 当前未接入该主路径 | `apps/api/src/modules/agent/agent.composition.ts`、`prompt/tool-projectors/` |

本期可靠捕获前三层中 Worker 已经取得的数据。错误文件不在 API 层重复构造最终模型消息，也不宣称逐字复刻当前或未来的 API composition/projector 结果；这是明确边界，不是待办。

## 目标

- 为非取消类工具失败生成结构化、版本化、本地错误文件。
- 完整保留模型 tool-call 输入 `tool.args`。
- 完整保留 Provider 已返回的 `result`；Provider reject 时只从合同规定的自有 data property 提取实际 partial result，不调用 accessor，不虚构不存在的数据。
- 完整保留本次调用中拟写回和已写回的 `AgentToolOutput`；Provider callback 边界仅覆盖当前实际存在的 running `updateToolItem` 与 `reportRunningOutput`。
- 完整保留运行时已经持有的 Error data property；Error 语义字段固定按 `data | unavailable_accessor | absent | reflection_error` 四态标记，采集不得执行普通对象或 Error 自定义 getter/accessor、`toJSON()` 或自定义 `toString()`。
- 区分 `tool`、`policy`、`recovery`、`runtime`，允许同一调用生成多个不同 kind 文件。
- 用有序事件表达同一 kind 内的多个阶段，避免 completed/failed writeback 次生错误互相覆盖。
- 在功能关闭时保持零目录创建、零诊断序列化、零诊断文件 I/O。
- 在功能开启时仍保持 best-effort：磁盘、权限、符号链接、序列化或发布失败不改变 Agent 主流程。
- 提供足以指导实现、代码审查、自动测试和验收的明确合同。

## 非目标

本期明确不做：

- 成功工具调用的常规记录；
- Abort、用户取消或仅由取消产生的异常记录；
- API/SQLite 中新增错误事件表；
- 跨工作区上传、中心日志、遥测、指标或审计平台；
- Web UI 查询、展示、下载或删除入口；
- 错误调用重放；
- 自动清理、容量配额、保留期限、压缩或采样；
- 单文件 max-bytes、字符串长度、字段数量或业务内容截断；
- 修改 shared Agent schema、Agent API endpoint 或数据库结构；
- 把 error artifact path 写入 context item、模型 Prompt 或工具结果；
- 修改用户工作区 `.gitignore`、`.git/info/exclude` 或 Git 全局配置；
- 改变工具状态机、重试策略、取消语义、Provider 接口返回合同；
- 恢复工具没有返回也没有附在异常上的 stdout、stderr 或 partial result。

## 角色与使用场景

### Agent 运行时开发者

- 对某个 `toolCallId` 同时查看 Provider 根因和 writeback 次生错误；
- 验证工具失败分类是否准确；
- 分析某类 Provider 返回值为何无法写回；
- 复盘特殊运行时值、循环引用、BigInt 或 Error 自定义字段导致的问题。

### 工具与插件开发者

- 查看模型实际传给工具的完整参数；
- 查看 Provider 已返回的完整结果或异常携带的 partial result；
- 对比 Provider result 与 Worker 构造的 `AgentToolOutput`；
- 判断失败来自工具实现、权限策略还是宿主 writeback。

### 工作区拥有者

- 在受控环境中通过环境变量显式开启；
- 本地保留或删除 `.awb/agent/tool-errors`；
- 按需在自己的项目中忽略 `.awb/`，但系统不得自动修改 Git 配置；
- 理解文件可能包含完整命令、文件内容、远端返回和其他模型可见信息，并自行控制目录访问。

## 典型使用场景

### Provider 直接失败

```text
模型调用 bash(args)
  -> Provider execute reject
  -> 生成 tool 文件，stage=provider_execute_rejected
  -> 若 failed writeback 也失败，再生成 runtime 文件
```

### Provider 成功、completed writeback 失败

```text
Provider 返回 result
  -> 捕获完整 result
  -> 构造 completed AgentToolOutput
  -> completed writeback 失败
  -> 生成 runtime 文件，含 result、completed output、writeback error
```

### 禁用工具

```text
pending 预检或 executeTool 二次校验判定 disabled
  -> 生成 policy 文件，stage=tool_disabled_pending_precheck 或 tool_disabled_execute_check
  -> Provider 不执行，因此没有 result
```

### Worker 恢复遗留 running 项

```text
PromptContext 返回 status=running 的 pending tool
  -> Worker 不重放工具，标记 interrupted/failed
  -> 生成 recovery 文件，stage=running_item_recovered_as_failed
```

## 实施范围

### 纳入范围

- `apps/agent-worker/src/runtime/runner.ts` 的工具执行与失败收口；
- 新增 Worker 私有的 capture、保真序列化和安全 writer 模块；
- `AWB_TOOL_ERROR_STORE_ENABLED` 的进程启动时解析；
- `.awb/agent/tool-errors/by_run` 目录和文件合同；
- Worker runtime 单元测试与必要的 runner 集成测试；
- 对现有成功 artifact 安全逻辑的复用或 Worker 内部抽取，但不得改变其产品行为。

### 不纳入范围

- `apps/api` 运行时代码改造；API 文件仅作为模型上下文重建边界的代码参考；
- `packages/shared` 契约变更；
- Provider 返回类型统一、partial result 新协议；
- MCP AbortSignal 能力补齐；
- `.debug` dump 替换或删除；
- 工作区搜索默认规则和 `.gitignore` 自动维护。

## 数据与信任边界

错误文件保存完整模型可见和 Worker 已取得数据，可能包含命令、文件正文、路径、远端服务返回、插件结果或其他敏感业务信息。本方案不进行字段脱敏，因为用户已明确选择“能发给模型的信息没有必要脱敏”，并要求完整记录。

“已取得”只包括运行时已经持有的 data value。accessor/getter 的计算值需要主动执行用户代码，不属于已取得数据，因此只保存 accessor descriptor 与 getter/setter 标识，不求值。

该选择不意味着降低文件系统安全：

- 功能默认关闭；
- 开启由部署者显式决定；
- 文件仅写入当前工作区；
- 新目录和文件使用当前用户尽可能严格权限；
- 不上传、不进入模型、不自动加入版本控制；
- fully supported 工作区必须同时支持同目录 hard link 与 Node no-follow 打开语义；
- 路径必须 containment、拒绝子路径 symlink、目标 no-follow、排他 hard-link 发布；
- 不支持 hard link/no-follow、跨设备、只读或权限不足时安全失败，不发布 final，不降低安全性 fallback，不回退其他目录。

## 成功标准

验收拆分为两类：

- fully supported 环境：项目主要基线为 Linux 本地运行环境，但具体工作区文件系统必须通过 hard-link/no-follow 能力测试；启用后必须从固定路径获得完整、可解析、可关联的 JSON 文件。
- unsupported 工作区：缺少 hard link/no-follow、跨设备、只读、权限不足或其他发布能力失败时，必须不发布 final 文件、尽力清理 temp、输出限频 warning，Agent 原有失败或取消语义保持不变。

关闭功能或触发纯 Abort 时不得创建错误目录。详细标准见 [06-testing-acceptance.md](./06-testing-acceptance.md)。
