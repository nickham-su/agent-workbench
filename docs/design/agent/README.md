# Agent Runtime 设计(事件溯源版)

本文档描述 agent-workbench 的 agent-native 运行时与 Web 客户端支持方案。本版本采用事件溯源(event sourcing)作为核心抽象,并以事件循环驱动 user/assistant/tool/subtask 的运行。

## 目标

- 统一抽象
  - user message/assistant message/内置工具/MCP 工具/subtask 都是上下文事件
  - 运行时是事件循环: 观察状态 -> 决定副作用 -> 执行 -> 产出新事件
- 多客户端友好
  - 同一 workspace 可被多个 Web client 同时打开
  - 多 client 可指向同一 session,共享同一事件流
  - 断线可补拉,最终一致
- 工具可扩展
  - 内置工具与 MCP tools 使用统一 Tool 协议
  - 工具定义与状态机尽量对齐 opencode(B 级兼容),subtask 命名例外
- 可检索记忆
  - agent 的历史搜索必须与 projection 一致
  - history transcript 只包含当前可见分支(受 headEventId 控制)

## 本期范围

- 客户端
  - Web 端 agent 工具窗口(client)
  - session 切换、/new、fork、revert、cancel
  - SSE 订阅事件流与断线补拉
- 运行时
  - API + Worker(同机子进程)架构
  - 事件存储(EventStore)与投影(Projections)
  - 事件循环调度(Scheduler)
- 工具
  - 内置: read, write, bash
  - subtask/MCP tools 在后续迭代接入
- Provider 与 Agent
  - 全局 Provider 列表 + 模型列表
  - 全局 Agent 列表
  - 消息级别指定 agent,run 固化解析结果
  - Worker 按 run 拉取 ExecutionProfile
- 输出控制
  - 截断适用于所有非 assistant 的大文本(user 超长输入、tool 输出、MCP tool 输出)
  - 截断后的完整内容保存到 workspace 内部 artifact 文件,事件里仅存 preview + 文件路径

## 非目标

- 不做 IM 接入
- 不做文件状态回滚(revert 仅对话回退)
- 不做跨 session 冲突仲裁
- 不做 step-start/step-finish
- 不做累计成本统计
- 本次不接入 MCP tools/resources/prompts

## 名词定稿

- workspace: AWB 的工作区,根目录下包含多个 repo 子目录
- client: Web 端一个 agent 工具窗口实例,维护 currentSessionId
- session: 会话上下文,由事件链表示,可 fork
- run: 一次执行区间,用于归属与控制,由事件派生
- headEventId: 当前可见分支的链表头事件 id
- event: 不可变事实记录,追加写入 EventStore
- projection: 从事件计算出的读模型(用于 UI 查询、prompt 构建、transcript)
- tool: 可被 assistant 请求执行的能力,含 schema 与执行器
- subtask: 一种内置 tool,用于创建/复用 session 并在其上运行子任务

## 本轮复审后的关键修正

- `revert/cancel/fork` 改为 control lane
  - 不再作为 timeline 事件写入
  - 通过 `session.head.moved` 记录 head 变更结果

- fork 采用 `session.fork_base`
  - 新 session 首个 timeline 事件引用来源锚点
  - timeline 链不跨 session 引用 prev

- 副作用落账顺序强约束
  - 必须先写 `*.requested` 再执行副作用
  - 副作用结束后必须写 `*.completed|*.failed`

- API 单写入点保持不变
  - timeline/control 由 API 写入
  - Worker 仅通过 IPC 请求 append

- API 不可用时 Worker 进入 degraded
  - 暂停推进新副作用,避免“执行了但未落账”

## 文档索引

- `architecture.md`: 组件划分与数据流(API/Worker/Web/DB/文件)
- `event-model.md`: 事件模型、链表头(headEventId)、因果链(correlation/causation)
- `event-types.md`: 事件类型清单与 payload 约定(含 lane/timeline 规则)
- `projections.md`: 投影类型、构建策略、查询接口
- `projection-contracts.md`: 投影数据结构约定(供 Web UI 与 Scheduler 消费)
- `scheduler.md`: 事件循环、turn 模型、结束条件与重试边界
- `llm.md`: LLM 集成(消息编码、tool calling、流式 delta、修复与容错)
- `provider-agent.md`: Provider/Agent 配置结构、解析规则、ExecutionProfile
- `tools.md`: 工具协议、内置工具、tool 状态机、artifact 截断
- `assistant-reasoning-persistence-and-ui-v1.md`: assistant reasoning 的采集、持久化与 UI 展示方案(v1)
- `mcp-tools.md`: MCP tools 接入与命名、权限、刷新
- `api.md`: API 设计(写事件、读投影、SSE)
- `ipc.md`: API <-> Worker IPC 协议(单写入点、append 请求、cancel 低延迟)
- `worker.md`: Worker 设计(领 run、执行 LLM、执行工具、写事件)
- `security.md`: 权限、路径边界、外部目录、取消协作
- `reliability.md`: 并发冲突、故障降级、补偿与容量策略
- `transcript.md`: projection 驱动的 transcript、rg 搜索约定
- `storage.md`: EventStore/投影/文件的存储结构
- `truncation.md`: 截断算法、artifact 写入、prompt 注入策略
- `opencode-compat.md`: 与 opencode 的兼容目标(B)
- `client.md`: Web client 行为与多 client 场景
