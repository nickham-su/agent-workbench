# 产品合同与关键决策

## Fork 的目标时点语义

所有 Fork 必须遵循同一规则：

> 新 Session 继承 Fork target 所在历史时点的有效模型上下文，不继承来源 Session 在 target 之后形成的当前上下文边界。

该规则同时适用于：

- target 位于当前 `contextRootMessageId` 之后的常规 Fork；
- target 位于当前 `contextRootMessageId` 之前的历史 Fork；
- 来源 Session 尚未压缩的 Fork；
- 多次 compaction 后的 Fork。

`forkMessageSession()` 是所有基于消息图 clone 的 Fork child 写入权威实现。公开 primary Fork 与内部 subtask Fork 都必须使用同一 target-time root 规则；不得由不同调用方各自计算或覆写 child root。

新 Session 的固定字段语义：

| 字段 | 规则 |
|---|---|
| `headMessageId` | 必须等于用户选择的 `targetMessageId` |
| `contextRootMessageId` | 必须等于 target 祖先链中最近的 compaction message；不存在时为 `null` |
| `forkedFromSessionId` | 必须等于来源 Session ID，用于血缘展示 |
| `forkedFromMessageId` | 必须等于 targetMessageId，用于血缘展示 |
| `kind` | 公开 Fork 继续创建 `primary` Session |

`forkedFrom*` 仅表达血缘，不参与模型上下文解析。模型上下文的权威边界是 child 自身的 `headMessageId` 和 `contextRootMessageId`。

## 公开 Fork 与内部 subtask Fork

共享 `forkMessageSession()` 时，上游策略与 child root 语义必须分层：

| 范畴 | 公开 primary Fork | 内部 subtask Fork |
|---|---|---|
| source 稳定性 | 必须 idle | 保持现有 `allowSourceWithActiveRun` 特例 |
| target 解析 | HTTP 的 `fromMessageId` | 既有 `boundaryPolicy` / internal-resolved 流程 |
| child root | 一律按 target-time root 计算 | 一律按同一 target-time root 计算 |
| child 类型 | `primary` | 保持既有 `subtask` 语义 |
| 其他执行语义 | 保持现状 | guard→prompt、prefork summary、lineage、locale/depth、工具限制保持现状 |

`boundaryPolicy` 仅决定内部流程选择哪个稳定 target；它不得改变 `resolveForkContextRootAtTarget()` 的输入语义、不得传入任意 root、不得令 child 继承 source 当前 root。

本轮不重定义 subtask 业务行为。内部流程继续负责既有 active parent run、internal-resolved boundary、prefork summary 和 guard→prompt 编排；本轮仅要求其最终通过共享 `forkMessageSession()` 创建 child 时获得与公开 Fork 一致的 target-time root。

## 可 Fork target 合同

后端是最终权威。只有同时满足下列条件的 target 才能 Fork：

- target 属于来源 Session 所在 Workspace。
- target 位于来源 Session 当前 `headMessageId` 的物理祖先链上。
- target 类型为 `user` 或 `assistant`。
- target 满足现有 `messageTerminal()` 定义。
- target 为 Assistant 时，不存在状态为 `queued` 或 `running` 的关联 tool execution。
- 公开 Fork 的来源 Session 必须满足现有 idle 条件；内部 subtask 则按既有 `allowSourceWithActiveRun` 窄特例及其 active-parent 条件校验，不适用公开 idle 要求。
- 来源 Session 的 `headMessageId` 与 `revision` 在 transaction 中仍与请求预期一致。

### “已完成”的兼容性定义

产品描述中的“已完成消息”在本设计中不是仅指 `completed`，而是沿用现有 `messageTerminal()` 的技术定义：

```text
completed | failed | cancelled | superseded
```

这是兼容性决策，不得在本需求中收紧为仅 `completed`。原因是本轮只修改 compaction 前 Fork 的上下文边界；收紧 target 状态将改变既有 Fork 行为，需另立需求、审查 API/UI 语义并迁移测试。

## Revert 合同

Fork 与 Revert 必须分开定义：

- 历史 User/Assistant message 可以 Fork。
- 位于来源当前 `contextRootMessageId` 之前的 User message 继续不能 Revert。
- `MESSAGE_TARGET_BEFORE_CONTEXT_ROOT` 继续保护 `moveMessageHead()` 与 `revertBeforeUserMessage()`。
- 历史 Assistant、compaction、system、runtime 等消息均不得显示或执行 Revert。

放开历史 Fork 的理由是 Fork 只创建新的 Session 指针，不改写来源 Session。Revert 会移动现有 Session 的 head，可能破坏当前 compaction 与运行语义，因此不在本次放开范围内。

## 不变的公开接口

请求和返回合同不变：

```text
POST /api/agent/sessions/fork
{
  fromSessionId,
  fromMessageId,
  title?
}
→ 201 AgentSessionRecord
```

本次不得新增：

- HTTP 参数、响应字段或额外 error envelope；
- SQLite 表、字段、migration 或索引；
- 消息、part、tool execution、附件的复制逻辑；
- 前端设置项、确认弹窗、警告 toast 或 i18n 文案。

`FORK_TARGET_BEFORE_CONTEXT_ROOT` 不再应成为正常 Fork 路径的结果。是否删除其死错误码和 application 映射属于后续清理，不是功能正确性的前提；若同次改动删除，必须全仓确认无残留引用。

## 上下文恢复与非确定性边界

历史 Fork 能恢复：

- target 之前的有效 User/Assistant 文本；
- target 之前最近 compaction 的 summary；
- 该 summary 按 `retainedFromMessageId` 规定的原始尾部；
- summary 后至 target 的消息；
- 可由现有 runtime transcript 投射的历史工具调用和结果摘要。

历史 Fork 不保证恢复：

- 当前 Workspace 的文件、Git 分支、未提交改动或终端状态；
- 外部 API、网页、MCP、网络、时间和随机性；
- 历史工具结果的完整 artifact、完整 structured result 或被截断输出；
- 历史图片的实际图像内容；
- 不同 provider/model 下的私有 provider replay；
- 来源 Session 的 Agent/provider/model override。

因此，历史 Fork 是上下文分支，不是操作回放、环境快照或工作流重演。

## 关键取舍

### 统一按 target 计算 root

采用统一规则，而不是仅为压缩前 target 添加例外。

- 避免 child root 依赖来源 Session 在 target 之后的 compaction。
- 修复 `source.contextRootMessageId === null` 时普通 Fork 将 target 本身作为 root 的不一致行为。
- 保证 child root 始终为 `null` 或 target 的物理祖先。
- 代价是少数历史内部/测试 Session 的上下文可能从“仅 target”扩大为完整历史前缀；这是有意且必须测试的可观察行为调整。

### 不以 `null` 统一恢复全部历史

不得无条件把 child root 设为 `null`。

- 对 target 前存在 compaction 的情况，这会重新注入已由历史摘要替代的大量原始消息。
- 会破坏 token 控制与 compaction 语义。
- 正确规则是只选择 target 祖先链中最近的 compaction；无此 compaction 时才使用 `null`。

### 不继承来源当前 root

不得继续使用：

```text
source.contextRootMessageId ?? targetMessageId
```

当来源已在 target 之后压缩时，当前 root 是 target 的后代；放开校验后会创建 root 不在 child head 祖先链上的非法 Session，并使 Resolver fail-close。

### 不增加历史 Fork 提示

用户已明确决定不增加确认、警告或新文案。风险由稳定的后端边界、现有 context window/auto-compaction/Run 失败收敛链路处理；不得以本功能为由引入 token 预估或额外 UX 流程。

### 统一 root 不等于统一上游边界策略

不得为了复用 root 计算而移除 internal subtask 的专有语义。

- `allowSourceWithActiveRun` 是内部 subtask 的既有窄特例；公开 Fork 仍必须 idle。
- `boundaryPolicy` 和 internal-resolved 仍由 subtask 应用层决定 target，不能由公开 Fork UI/API 模拟或触发。
- guard→prompt、prefork summary、lineage、locale/depth 与工具限制不属于 root helper 的职责，也不得被其覆盖。
- root helper 只回答一个问题：给定已经合法解析的 target，child Session 的 `contextRootMessageId` 是什么。
