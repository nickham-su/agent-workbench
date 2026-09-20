# 前端交互方案

## 设计目标

前端必须反映后端的新 Fork 合同，同时保持 Revert 的压缩边界：

- 压缩前的合法 User/Assistant message 可以 Fork。
- 压缩前 User message 不能 Revert。
- 当前范围内 User 仍可同时 Fork 与 Revert。
- 当前范围内合法 Assistant 只能 Fork。
- 不增加提示、确认、warning toast、i18n 文案或新的设置项。

后端始终是 Fork 合法性的最终权威；前端 eligibility 只负责展示和避免明显无效的操作入口。

## 时间线范围与可见性

后端 display chain 查询位于：

```text
apps/api/src/modules/agent/read-side/sqlite-message-query.ts
```

它会读取 Session 完整物理链，因此压缩前 message 仍可展示。读模型按当前 `contextRootMessageId` 标记：

```text
inCurrentOperationRange
```

压缩前消息通常为 `false`。该字段仍用于 Revert 等“修改当前 Session 指针”的操作边界，但不再用于排除 Fork。

## Eligibility 拆分

改造文件：

```text
apps/web/src/features/workspace/tools/agent/agentMessageTimeline.ts
```

现有 `canMutateAgentTimelineMessage()` 将 Fork 与 Revert 的资格耦合。必须替换为两个语义明确的 helper：

```ts
canForkAgentTimelineMessage(message)
canRevertAgentTimelineMessage(message)
```

### `canForkAgentTimelineMessage()`

必须：

- 不依赖 `message.inCurrentOperationRange`；
- 允许 `user` message；
- 允许 `assistant` message，不得因其没有 text part 而隐藏 Fork；
- 排除 `compaction`、`system`、`runtime`。

原因是后端 Fork 合同只限制 target 的 message 类型、终态、物理祖先关系及 Assistant 工具执行稳定性，并不要求 Assistant 含 text part。Assistant 可能只包含 tool call 或其他有效 part；前端不得以展示便利性缩小后端允许的 Fork 范围。

该 helper 不需要复制后端对 message status、物理祖先、Workspace、source idle、tool execution 状态的完整校验；这些信息未必都存在于前端时间线 payload，且必须由后端 transaction 作为权威。

### `canRevertAgentTimelineMessage()`

必须：

- 保持 `message.inCurrentOperationRange === true`；
- 仅允许 `user` message；
- 保持现有 Revert 确认流程和请求路径；
- 压缩前 message 必须返回 `false`。

`canMutateAgentTimelineMessage()` 不得继续作为 Fork/Revert 共用的操作资格。是否删除旧 helper 取决于全仓引用；若保留临时兼容包装，必须避免新 Fork 逻辑继续使用它。

## 每条 message 的唯一操作锚点

conversation timeline 按 message part 展开为多个 row；一条 message 可以：

- 没有 part；
- 只有 tool call；
- 只有 reasoning/image 等非 text part；
- 有多个 part，且最小 `position` 不保证为 `0`。

每条 message 必须恰好拥有一个操作锚点。推荐在 conversation row 建模中新增 `isFirstRowForMessage` 或等价字段：

- message 无 part 时，由该 message 的唯一空-part row 作为锚点；
- message 有 part 时，按既有排序规则得到该 message 的第一条 row，并标记为锚点；
- 判断的是排序后的第一条 row，不得假定 `row.part?.position === 0`；
- 仅锚点 row 可以渲染 `AgentMessageActions`；同一 message 的其他 part row 不得重复渲染操作。

Fork eligibility 与操作锚点是两个独立概念：`canForkAgentTimelineMessage()` 决定该 message 是否可 Fork，`isFirstRowForMessage` 决定在哪一条 row 显示唯一按钮。无 part、tool-only、reasoning-only、image-only Assistant 只要满足后端 target 合同，就必须在其唯一锚点显示 Fork。

## 操作组件 props

改造文件：

```text
apps/web/src/features/workspace/tools/agent/AgentMessageActions.vue
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
```

`AgentMessageActions` 必须使用相互独立的显示控制：

```text
showFork: boolean
showRevert: boolean
```

不得通过 `showRevert`、message type 或 `inCurrentOperationRange` 间接推导 Fork 是否显示。`AgentClientPane` 必须仅在每条 message 的操作锚点 row 上，分别计算并传入两个值。

强制 UI 矩阵：

| 消息 | 当前操作范围 | showFork | showRevert |
|---|---:|---:|---:|
| 压缩前 User | false | true | false |
| 压缩前 Assistant | false | true | false |
| 当前范围 User | true | true | true |
| 当前范围 Assistant | true | true | false |
| compaction | 任意 | false | false |
| system/runtime | 任意 | false | false |

无 part、tool-only、reasoning-only、image-only Assistant 适用“Assistant”行：只显示一次 Fork，不显示 Revert。

在历史 target 为非终态、非祖先、跨 Workspace、source running 或 tool execution 未终态等情况下，前端可能仍显示 Fork；请求失败时必须复用现有 `ApiError` 处理，不增加专项提示。正常时间线通常不会展示跨 Workspace/非祖先 target，但后端防护不可省略。

## 已有交互必须保持

Fork 当前没有确认框，本次必须保持：

```text
点击 Fork
  → runAgentSessionMessageMutation() 保持同 Session 结构操作互斥
  → forkAgentSession()
  → emit("forked", result.id)
  → AgentToolView 刷新 Session 列表
  → 激活新 Session tab
```

相关文件：

```text
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
apps/web/src/features/workspace/tools/agent/AgentToolView.vue
apps/web/src/shared/api/api.ts
```

不得修改：

- Fork API 的请求体；
- Fork 成功后的 refresh/navigate 行为；
- 现有 pending/mutation 锁；
- Revert 的确认交互；
- Session tab 的创建或切换语义。

## 失败与 pending 状态

Fork 请求失败时：

- source Session 不得被前端乐观修改；
- 新 tab 不得被激活；
- mutation pending 必须在 `finally` 或等价路径释放；
- 保持现有错误展示方式；
- 不得针对“压缩前 Fork”新增特殊 toast、确认或回退逻辑。

## 非范围

本次前端不实现：

- archive/history 专用 Fork 入口；
- timeline 中选择 compaction summary、tool call、tool result、reasoning part 作为 Fork 点；
- 历史 Fork 上下文大小预览；
- 恢复历史内容的风险提示；
- 将 Fork 与未来定时任务模板创建关联。
