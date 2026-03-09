# 移除审批与运行时权限控制改造方案 v1

## 背景

- 当前 Agent 运行时同时存在两套约束:
  - Agent Profile 中的工具权限开关,例如 `allowRead`、`allowWrite`、`allowBash`
  - 工具执行过程中的人工审批流,例如 `awaiting_permission`、`waiting_permission`、`approve`、`deny`
- 这套机制的原始目标是为高风险工具提供人工兜底,但在当前项目定位与默认运行方式下,收益已经明显下降。
- 当前项目已经推荐在 Docker 环境中运行,并且代码改动还有 Git 兜底,整体风险边界相对清晰且可控。
- 在实际使用中,审批步骤多数情况下只是中断执行链路,降低效率,并没有提供足够稳定、可验证的安全收益。
- 运行时权限开关也很难形成严格可信的安全边界,因为真正的边界仍然依赖工作区隔离、路径校验、容器环境和代码审计能力。

## 本次改造的立场

- Agent 默认应当以“直接执行”作为主路径,而不是以“等待审批”作为主路径。
- 移除运行时审批,不等于移除所有安全约束。
- 本次改造仅针对 Agent 的“运行时权限控制与人工审批流”。
- 文件系统边界、路径合法性校验、工作区范围限制、软链防护、危险目录阻断等底层硬约束仍然保留。

## 目标

- 删除 Agent 运行时的人工审批链路。
- 删除 Agent Profile 中与运行时审批绑定的权限配置。
- 简化 run / tool 的状态机,去除等待审批相关状态。
- 保留 Agent 的工具声明能力,即 `tools` 列表继续存在。
- 保留底层路径与工作区安全边界,避免误删真正的硬约束。
- 为后续分阶段代码改造提供统一设计依据。

## 非目标

- 不在本次改造中重写历史设计文档。
- 不在本次改造中移除 Docker、Git、工作区目录等现有隔离与兜底方案。
- 不在本次改造中放宽文件越界、软链、非法路径、危险目录等底层校验。
- 不在本次改造中重新设计 Agent Profile 的工具列表模型。
- 不在本次改造中引入新的沙箱、审计或授权系统。

## 文档策略

- 历史文档保留原样,不做同步改写。
- 本文档作为“移除审批与运行时权限控制”的专项方案文档使用。
- 后续实施、联调和验收以本文档为准。
- 若后续方案继续演进,在本目录下追加新的 v2/v3 文档,而不是回写历史方案。

## 当前实现概览

## 运行时权限来源

- Agent Profile 中包含 `permissions` 字段。
- 当前字段至少包括:
  - `allowRead`
  - `allowWrite`
  - `allowBash`
- Worker 在执行工具前会根据这些字段推导是否需要审批。
- API 在构造 prompt context 时,也会把工具是否需要审批投影为 `requiresApproval`。

## 审批状态机

- run-state 目前包含 `waiting_permission`。
- tool item 目前包含 `awaiting_permission`。
- tool output 目前可能包含 `approved`。
- 外部接口中存在工具审批决策能力,允许用户执行 `approve` 或 `deny`。
- 前端会话 UI 中存在审批按钮与等待审批状态展示。

## 影响范围

- shared contracts
- settings 模型
- API routes / service / store
- worker prompt context 与执行循环
- Web 会话 UI
- Web settings UI
- 测试
- 环境变量说明
- 新增专项设计文档

## 问题陈述

## 审批对主流程的干扰

- 审批会把单次工具执行拆成“请求执行 -> 等待人工确认 -> 恢复执行”三段式流程。
- 这会把原本连续的 step-loop 打断,增加状态切换、轮询刷新和恢复逻辑。
- 在“默认允许执行”的用户习惯下,审批基本没有产生额外决策价值,反而成为高频摩擦点。

## 权限模型并不构成真正安全边界

- `allowRead`、`allowWrite`、`allowBash` 本质上是运行时开关,不是强隔离机制。
- 如果工作区隔离、容器隔离和路径边界本身不足够可靠,仅靠审批与权限开关也无法形成绝对安全。
- 如果底层隔离已经足够,审批的边际收益又会进一步下降。

## 系统复杂度被显著抬高

- shared contract 需要暴露等待审批相关状态。
- API 需要维护 `tool-permission` 接口与状态推进逻辑。
- worker 需要在执行中暂停、挂起、恢复。
- Web 需要显示审批按钮并额外处理等待状态。
- 测试需要覆盖 approve/deny 分支。
- 启动恢复与异常恢复也要把等待审批状态纳入考虑。

## 目标态

## 总体原则

- Agent 发起工具调用后,若该工具已在当前 Agent 的 `tools` 列表中启用,则直接执行。
- 系统不再为 `read`、`write`、`apply_patch`、`bash` 这类工具引入人工审批中断。
- Agent 是否“允许使用某工具”继续由 `tools` 列表表达。
- Agent 不再维护单独的运行时权限开关。

## 目标态下保留的能力

- Agent Profile 中的 `tools` 列表。
- 工具是否在当前 Agent 中启用的校验。
- workspace 内路径边界校验。
- 软链校验。
- 非法路径段校验。
- 危险目录或 denylist 的底层阻断。
- Docker 运行建议与 Git 回滚兜底。

## 目标态下删除的能力

- `permissions.allowRead`
- `permissions.allowWrite`
- `permissions.allowBash`
- `requiresApproval`
- `approve`
- `deny`
- `waiting_permission`
- `awaiting_permission`
- `approved`
- `/api/agent/sessions/:sessionId/tool-permission`

## 设计决策

## 保留 `tools`, 删除 `permissions`

- `tools` 表达的是“当前 Agent 可使用哪些工具”。
- `permissions` 表达的是“工具已存在但运行时还要不要再次人工放行”。
- 两者语义不同。
- 本次改造保留前者,删除后者,可以在简化系统的同时保留 Agent 能力边界。

## 删除审批状态,简化状态机

- run-state 从 `idle | running | waiting_permission` 收敛为更简单的运行态集合。
- tool item 从 `streaming | queued | running | awaiting_permission | completed | failed | denied | cancelled` 收敛为不包含审批态的集合。
- `denied` 若仅服务于审批拒绝语义,应一并退出主流程。
- 工具执行主路径收敛为:
  - `queued -> running -> completed`
  - `queued | running -> failed`
  - `queued | running -> cancelled`

## 删除审批接口,保留内部执行接口

- 保留 worker 所需 internal API,例如 prompt context、context item 更新、run complete 等。
- 删除面向前端的工具审批决策接口。
- 删除 prompt context 中为审批服务的冗余字段。

## 兼容历史数据,但不保留旧能力

- 系统应尽量能够读取历史数据,避免因旧记录导致服务异常。
- 但历史兼容不代表继续保留审批功能。
- 对旧状态的兼容目标应当是“可收敛、可恢复、可忽略”,而不是“继续完整运行旧审批链路”。

## 分层改造范围

## shared contracts

- 删除 Agent 协议中的审批相关 schema、类型和状态值。
- 删除 settings 中的 `AgentPermissionsSchema` 及其在 AgentItem 中的字段。
- 收敛前后端共享的 run-state / context-item status 枚举。

## settings 层

- 移除 Agent Profile 的 `permissions` 存储结构。
- 移除读写 `permissions` 的服务端默认值、序列化与校验逻辑。
- 保留 Agent 的 `tools`、`mcpServers`、`defaultModel` 等其他配置。

## API 层

- 删除 `tool-permission` 外部接口。
- 删除与审批决策相关的 service 逻辑。
- 删除 run-state 中等待审批的状态推进分支。
- 删除 prompt context 中 `requiresApproval` 的投影。
- 删除 pendingTools 中 `approved` 之类仅为审批服务的字段。

## worker 层

- 删除执行器中的 `needsApproval` 推导逻辑。
- 删除工具进入 `awaiting_permission` 的挂起逻辑。
- 删除 run 进入 `waiting_permission` 的逻辑。
- 工具一旦进入执行阶段,直接从 queued 推进到 running。
- 仅保留“工具是否已在当前 Agent 中启用”的检查。

## Web 会话 UI

- 删除 tool item 上的 approve / deny 按钮。
- 删除等待审批图标、颜色和提示文案。
- 删除围绕 `waiting_permission` 的轮询与展示分支。
- 收敛消息列表中的状态映射与运行中展示逻辑。

## Web 设置 UI

- 删除 Agent Profile 中的 Permissions 区块。
- 删除 Allow Read / Allow Write / Allow Bash 三个表单项。
- 删除与 `permissions` 相关的国际化文案。

## 测试

- 删除审批相关测试用例。
- 更新状态枚举断言。
- 增加“工具直通执行”相关回归测试。
- 增加“旧权限字段不再生效或被清理”的测试。

## 文档与配置

- 不回写历史设计文档。
- 新增专项设计文档说明本次改造背景与方案。
- 更新必要的环境变量示例说明,避免继续把 `waiting_permission` 作为当前主状态描述。

## 分阶段实施建议

## 阶段一: 方案冻结与影响面确认

- 完成专项设计文档。
- 确认保留范围与删除范围。
- 明确历史数据兼容策略。
- 明确测试与验收基线。

## 阶段二: shared 与 settings 模型收敛

- 删除 shared contract 中的审批相关类型。
- 删除 settings 中的 `permissions` 字段。
- 调整 API / worker / Web 对共享类型的引用。
- 让数据模型先完成“去权限化”。

## 阶段三: API 与 worker 主链路收敛

- 删除 `tool-permission` 接口。
- 删除 service 中审批流转逻辑。
- 删除 prompt context 中 `requiresApproval` 与相关 pending 字段。
- 删除 worker 中 pause / resume 审批分支。
- 将工具执行链路改为无审批直通。

## 阶段四: Web UI 与测试收敛

- 删除会话界面的审批交互。
- 删除设置页中的权限配置 UI。
- 更新 i18n。
- 调整集成测试与运行时测试。
- 补充新的直通执行回归测试。

## 阶段五: 历史数据收敛与验收

- 处理旧状态记录的兼容读取或启动收敛。
- 验证旧会话不会因历史审批状态导致前端异常。
- 验证新增会话不再生成任何审批相关状态。

## 历史数据兼容策略

## 原则

- 不要求保留旧审批流程的继续执行能力。
- 要求旧数据不会把系统卡死在不可恢复状态。
- 兼容处理优先选择“启动收敛”或“读取时忽略”。

## 建议策略

- run-state 中若仍出现 `waiting_permission`,在启动恢复或读取时收敛到当前支持的运行态。
- tool item 中若仍出现 `awaiting_permission`,在恢复逻辑中收敛到 `queued`、`failed` 或 `cancelled` 之一。
- `approved` 字段按历史冗余字段处理,读取时忽略,新写入路径不再产生。
- `denied` 若仅用于审批拒绝,历史记录可保留展示,但新链路不再产生。

## 风险与对策

## 风险: 改动横跨 shared / API / worker / Web

- 审批能力不是局部逻辑,而是跨层协议。
- 任一层残留旧字段,都可能造成类型错误或运行时不一致。

对策:

- 按 shared -> API/worker -> Web -> tests 的顺序推进。
- 每个阶段结束后执行对应 workspace 的类型检查。

## 风险: 历史状态枚举残留

- 数据库或上下文记录中可能仍有 `waiting_permission`、`awaiting_permission`、`approved`。
- 如果新代码完全不识别,可能导致前端展示异常或恢复逻辑异常。

对策:

- 在改造期间保留最小历史兼容读取。
- 在启动恢复和投影阶段增加一次性收敛逻辑。

## 风险: 误删硬约束

- 路径边界、软链校验、危险目录限制等并不属于审批系统。
- 若在“去权限化”过程中一并删除,会扩大真实风险面。

对策:

- 文档和代码评审中明确区分“运行时审批”与“底层安全约束”。
- 所有文件系统边界校验默认保留。

## 风险: 子任务状态协议联动

- subtask 或其他投影可能复用 run-state/status 枚举。
- 审批态删除后,这些链路可能需要一并收敛。

对策:

- 在 shared contract 收敛时统一盘点所有状态枚举消费者。
- 对子任务相关接口和前端映射做联动检查。

## 验收标准

- 新创建的 Agent Profile 不再包含 `permissions` 字段。
- 设置页不再展示 Permissions 区块。
- worker 执行工具时不再进入 `awaiting_permission`。
- session run-state 不再进入 `waiting_permission`。
- 前端不再出现 approve / deny 交互。
- prompt context 不再暴露 `requiresApproval`。
- 历史会话加载时不会因旧审批字段导致崩溃或卡死。
- 容器、路径、工作区边界等底层硬约束保持有效。

## 实施后的系统心智模型

- Agent 能否使用某个工具,由 Agent Profile 的 `tools` 决定。
- 工具一旦可用,执行时默认直接运行。
- 真正的风险控制来自:
  - 运行环境隔离
  - 工作区边界
  - 文件系统校验
  - Git 可回滚性
  - Docker 可重建性
- 系统不再假设人工审批是主安全机制。

## 后续执行建议

- 先从 shared contract 与 settings 模型开始,尽快消除“权限字段仍是主模型组成部分”的问题。
- 再处理 API 与 worker 的审批状态机,避免半新半旧协议长期并存。
- 最后收尾 Web UI、测试和启动恢复逻辑。
- 每个阶段单独提交,保证回滚粒度清晰。
