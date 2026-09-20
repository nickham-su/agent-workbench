# 实施计划与审查清单

## 实施原则

- 先以测试固定 target-time root 语义，再修改领域写入和 UI。
- 后端 root 算法必须是唯一权威实现；前端不计算或传递 root。
- Fork 与 Revert 的改动必须拆开审查，避免“放开历史 Fork”意外放开 Revert。
- 共享 `forkMessageSession()` 必须同时回归公开 primary Fork 与内部 subtask Fork；`boundaryPolicy` 只决定 target，不决定 root。
- 改动只限 Fork、上下文 root、时间线操作资格和对应测试；不得借机重构消息图、compaction 或 Run 生命周期。
- 每个阶段完成后运行其最小测试，最终按 [07-testing-and-acceptance.md](./07-testing-and-acceptance.md) 做完整回归。

## 开发任务拆分

### 后端领域规则与 store 测试

涉及：

```text
apps/api/src/modules/agent/agent-message.store.ts
apps/api/src/modules/agent/agent-message.store.test.ts
```

实施步骤：

- 在测试中先构造无 compaction、单次 compaction、多次 compaction 的 target/root 断言。
- 为 `forkMessageSession()` 写入路径新增按 target 回溯最近 compaction 的专用 helper，确保公开/内部 clone 共用。
- 在现有 SQLite transaction 中调用该 helper。
- 替换 child root 的来源当前 root 继承逻辑。
- 移除 Fork 专用的 current-root-before-target 拒绝；保留 Revert/移动 head 路径的同类限制。
- 验证 target→最近 compaction/物理起点完整链：无循环、全链同 Workspace、无 compaction 时正常以 `previous_message_id = null` 结束。
- 增加 root 必须是 `null` 或 target 祖先的显式防御检查；transaction 可确认图损坏时记录诊断、返回 `500` 并 rollback。
- 追加领域错误、并发 fence、工具执行、图损坏和 rollback 测试。

完成条件：

- `M1 → M2 → C1 → M3 → M4 → C2 → M5` 的 root 矩阵全部通过。
- 历史 Fork 不留半成品 Session/run state。
- Revert 的压缩前拒绝测试仍通过。

### Resolver 与运行链路验证

涉及：

```text
apps/api/src/modules/agent/read-side/model-context-resolver.test.ts
apps/api/src/modules/agent/integration/agent-session-routes.integration.test.ts
apps/api/src/modules/agent/integration/agent-session-model-runtime.integration.test.ts
```

实施步骤：

- 以 child head/root 验证 Resolver 对 null root、历史 compaction root 和 retained tail 的上下文块。
- 覆盖 root/retained anchor 异常 fail-close。
- 验证历史 Fork 后发送消息、创建 Run 的路径。
- 验证 source override 不继承、source/child 后续 compaction 和 Revert 互不影响。
- 回归内部 subtask 的 active parent run、internal-resolved boundary、guard→prompt、prefork summary、lineage、locale/depth 与工具限制；只改变 child root 的来源。

完成条件：

- 历史 Fork 可走完整 `sendMessage() → startUserRun()` 链路。
- Resolver 不会读入 target 后的 compaction 或消息。
- 非确定性材料仍采用既有投射/降级逻辑。

### 前端 eligibility 与操作组件

涉及：

```text
apps/web/src/features/workspace/tools/agent/agentMessageTimeline.ts
apps/web/src/features/workspace/tools/agent/AgentMessageActions.vue
apps/web/src/features/workspace/tools/agent/AgentClientPane.vue
apps/web/src/features/workspace/tools/agent/agentMessageTimeline.test.ts
apps/web/src/features/workspace/tools/agent/AgentMessageActions.component.test.ts
apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts
```

实施步骤：

- 拆分 `canForkAgentTimelineMessage()` 与 `canRevertAgentTimelineMessage()`。
- 让 Fork eligibility 忽略 `inCurrentOperationRange`，保持 `user`/`assistant` 类型限制，并移除 Assistant 必须有 text part 的限制；`hasAgentMessageTextPart()` 不再决定 Fork eligibility。
- 让 Revert eligibility 保留 current operation range + User 限制。
- 将 `AgentMessageActions` 改为独立的 `showFork`、`showRevert` props。
- 在 conversation row 建模中增加 `isFirstRowForMessage` 或等价能力：无 part row 自身为锚点；有 parts 时排序后的第一 row 为锚点，不假定 position 为 `0`。
- 让 pane 仅在操作锚点分别传入两个值，保留既有 mutation、API 调用和 forked 事件处理。
- 以组件测试覆盖历史 User 仅 Fork、历史 Assistant 仅 Fork、当前 User 双操作的矩阵。
- 追加无 part、tool-only、reasoning/image-only、最小 position 非 `0`、多 part 不重复按钮的组件测试。

完成条件：

- 历史 Fork 无新增确认/提示。
- Fork 成功仍刷新并导航至 child tab。
- Fork 失败后 pending 释放且 UI 不产生乐观分支。

### 最终类型检查、回归与手工验收

实施步骤：

- 执行 API 与 Web 类型检查。
- 执行 API unit/integration 与 Web test scripts。
- 手工完成单次和多次 compaction 的 Fork 场景。
- 对照 [07-testing-and-acceptance.md](./07-testing-and-acceptance.md) 逐项记录结果。

完成条件：

- 所有自动测试通过。
- 未出现无关 API/Schema/DB migration。
- 手工确认历史 Fork 与压缩前 Revert 的 UI 分离。

## 推荐提交粒度

如开发过程允许拆分可审查提交，建议保持以下逻辑粒度：

- 后端领域规则与 store/Resolver 测试。
- 前端 eligibility、action props 与组件测试。
- 路由/集成测试与最终验证修复。

是否拆分提交由实际协作流程决定；无论是否拆分，每次提交不得包含无关格式化、大规模重构或其他模块的既有变更。

## 开发前检查

开发者必须先确认：

- 工作树已有变更属于其他工作，不得恢复、覆盖或混入。
- `forkMessageSession()`、compaction commit、Resolver 和 Revert 路径的当前实现与本设计中的事实一致；如实现已变化，应先更新设计或明确兼容策略，不得盲目套用补丁。
- 前端 `AgentMessageActions` 的实际 props、`AgentClientPane` 的 mutation 包装和现有测试命名与本设计路径一致。
- 当前 workspace package scripts 仍提供文档中列出的 typecheck/test 命令；脚本变更时先核实再执行。

## 代码审查清单

### 后端正确性

- [ ] child `headMessageId` 始终等于 target。
- [ ] child root 由 target 向祖先回溯得到，不读取 source 当前 root。
- [ ] 无 compaction 时 child root 为 `null`，不是 target。
- [ ] 有多次 compaction 时 child 使用 target 前最近 summary，不使用未来 summary。
- [ ] root 是 `null` 或 child head 祖先，异常时 transaction rollback。
- [ ] target→最近 compaction/物理起点链无循环、全链同 Workspace；无 summary 时确实以 null 结束。
- [ ] transaction 可确认图损坏会记录诊断、rollback 并返回 `500`；用户领域错误仍保持既有 4xx 映射。
- [ ] 仅 Resolver hydrate 可发现的 retained 异常保持 fail-close，不产生部分 prompt。
- [ ] 保留 source idle、head/revision fence、同 Workspace、物理祖先、target 类型、终态与工具执行校验。
- [ ] 公开 primary 与内部 subtask 共用 target-time root；内部 active-run 与 boundaryPolicy 等既有语义未改变。
- [ ] Revert 和 move-head 的 `MESSAGE_TARGET_BEFORE_CONTEXT_ROOT` 分支未被放开。
- [ ] 不复制历史数据，不新增 schema migration/API 参数/响应字段。
- [ ] Fork 后 model override 仍不继承。

### 前端正确性

- [ ] Fork/Revert eligibility 已拆分；新的 Fork 路径不依赖 `inCurrentOperationRange`。
- [ ] Revert eligibility 仍依赖 `inCurrentOperationRange` 且仅允许 User。
- [ ] `showFork` 与 `showRevert` 独立传递，历史 User 仅显示 Fork。
- [ ] 每条 message 仅一个操作锚点；无 part row 和最小 position 非 `0` 的首 part 都可显示操作。
- [ ] 合法 tool-only、reasoning-only、image-only Assistant 不因无 text part 而失去 Fork，多 part 不重复按钮。
- [ ] compaction/system/runtime 不显示操作；合法 Assistant 不因无 text part 而失去 Fork。
- [ ] 未新增确认、提示、警告 toast 或 i18n 文案。
- [ ] Fork 成功 refresh/navigate、失败 pending 释放与既有行为一致。

### 测试与范围

- [ ] root 矩阵覆盖无压缩、单次压缩、多次压缩和 retained tail。
- [ ] 覆盖非祖先、跨 Workspace、非终态、运行中的 tool、source running、revision 冲突和图损坏。
- [ ] 覆盖历史 Fork 后 sendMessage/Run、source/child 后续互不影响。
- [ ] 覆盖前端完整操作矩阵、导航与失败释放 pending。
- [ ] 相关 workspace typecheck/test 命令已执行并记录。
- [ ] diff 不包含本设计范围外的文件与行为。

## 复审与验收记录建议

完成开发后，审查者应以以下顺序复核：

```text
先读 store root 算法与 transaction
  → 对照多次 compaction 测试
  → 读 Resolver context blocks
  → 确认 Revert 路径未改变
  → 检查前端 eligibility 与 props
  → 运行类型检查与测试
  → 手工验证 Fork/导航/失败场景
```

若发现实现只能通过“删除一个限制”而无法说明 child root 的历史来源，或测试未覆盖 C1/C2 的时间边界，则必须退回设计/实现阶段，不得以手工成功一次替代完整验收。
