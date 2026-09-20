# 测试与验收

## 验收原则

验收必须证明三件事：

- 历史 Fork 的 child root 正确对应 target 所在历史时点。
- 历史 Fork 不降低现有稳定性、安全边界和 Revert 限制。
- 前端仅放开 Fork 入口，不改变成功导航、失败处理或 Revert 交互。

只验证“接口返回 201”不构成验收通过。必须同时验证 child Session 指针、Resolver 生成的上下文、事务回滚和前端可操作性矩阵。

## 后端 Store 单元测试

主要位置：

```text
apps/api/src/modules/agent/agent-message.store.test.ts
```

必须覆盖：

- 无 compaction 时分别从早期/中间/末尾 User 和 Assistant Fork：child root 均为 `null`，并能保留 target 前缀。
- 单次 compaction 后，从 summary 前的 User/Assistant Fork 成功，root 为 `null`。
- 单次 compaction 后，从 summary 后的 User/Assistant Fork 成功，root 为该 summary。
- 多次 compaction 使用固定链：

```text
M1 → M2 → C1 → M3 → M4 → C2 → M5
```

  - `M1`、`M2` root 为 `null`；
  - `M3`、`M4` root 为 `C1`；
  - `M5` root 为 `C2`；
  - 断言从 `M4` Fork 时不会误用 `C2`。
- target 为 compaction、system、runtime 时拒绝。
- target 不存在、不属于 source 当前物理祖先、属于 Revert 后旧分支、跨 Workspace 时拒绝。
- target 非终态时拒绝。
- Assistant target 存在 queued/running tool execution 时继续拒绝。
- public source running、有 non-terminal message 或不稳定 tool execution 时继续返回 `SESSION_NOT_IDLE`。
- source head/revision 竞争变化时 transaction 失败且不创建 child。
- root 解析或 root 合法性校验失败时 transaction rollback：不得残留 child `agent_session` 或 `session_run_state`。
- target→最近 compaction/物理起点链循环、缺行、跨 Workspace、未以 null 正常结束时，记录诊断并返回 `500`；不得误判为合法 `null` root。
- target 非祖先、类型/状态非法、公开 source busy 与 Assistant 非终态 tool execution 继续走既有领域错误映射，不得误报为 `500`。
- 历史 Fork 不新增/复制 message、part、tool execution 行；只创建一个 child Session 和其 idle run state。
- `moveMessageHead()` 与 `revertBeforeUserMessage()` 对 context root 之前 target 仍返回 `MESSAGE_TARGET_BEFORE_CONTEXT_ROOT`。
- 当前已有“历史 Fork 被拒绝”的断言必须改为历史 Fork 成功且 root 正确；不得误删 Revert 的拒绝断言。

### 内部 subtask 回归

共享 `forkMessageSession()` 改造必须覆盖内部 subtask 调用路径。相关应用层编排参考：

```text
apps/api/src/modules/agent/session/session-interaction-application.ts
apps/api/src/modules/agent/integration/agent-subtask-lineage.integration.test.ts
```

必须覆盖：

- active parent run 下的 `allowSourceWithActiveRun` 特例仍可按既有条件创建 subtask，不放宽公开 Fork。
- `boundaryPolicy` 与 internal-resolved boundary 选定 target 后，child root 仍按 target-time 算法计算。
- guard→prompt 与 prefork summary 的既有顺序/内容不变。
- subtask lineage、locale、depth、父 run/tool 关联与工具限制保持既有语义。
- public primary Fork 与 internal subtask Fork 对同一消息图 target 得到相同 root；仅 source 稳定性和上游 target 解析策略不同。

## Resolver 与上下文块测试

主要位置：

```text
apps/api/src/modules/agent/read-side/model-context-resolver.test.ts
```

必须覆盖：

- child root 为 `null` 时读取从物理链起点到 target 的完整前缀。
- child root 为 `C1` 时，只包含 `C1` summary、`C1` retained tail、`C1` 后至 target 的消息。
- 从 `C1` 与 `C2` 之间的 target Fork 时，不包含 `C2` 或其 retained tail。
- 从 `C2` 后 target Fork 时，不错误回灌 `C1` 之前的全部原始内容。
- retained tail 的顺序和去重符合既有 Resolver 规则。
- child 后续追加一条 User message 时，新的 message 正确接在 target 后，Resolver 上下文正确延伸。
- root 不在 child head ancestry 时抛出 `ModelContextInvariantError`。
- transaction 可确认的 compaction predecessor 或 retained 结构异常必须 rollback/500。
- 仅在完整 hydrate 后发现的 retained anchor 异常必须由 Resolver fail-close；child 可存在，但不得产生部分 prompt。
- 历史 tool result 继续只投射 preview/error/status，不读取完整 artifact 或 structured result。
- 历史图片仅产生占位内容，不重新形成 image attachment；新触发消息的图片保持既有 attachment 路径。
- provider replay 在 provider/model 匹配和不匹配时保持既有安全行为。

## Application、Route 与集成测试

建议覆盖：

```text
apps/api/src/modules/agent/session/session-interaction-application.test.ts
apps/api/src/modules/agent/integration/agent-session-routes.integration.test.ts
apps/api/src/modules/agent/integration/agent-session-model-runtime.integration.test.ts
```

必须覆盖：

- `POST /api/agent/sessions/fork` 对压缩前合法 target 返回 `201`，请求/响应 schema 不变。
- source 不是 primary、source 不存在、source running、非法 target 的既有 HTTP 映射保持正确。
- 历史 Fork 成功后，可在 child 上 `sendMessage()` 并创建 Run；消息和 Run 归属 child，而非 source。
- child 的 execution profile 不继承 source Session model override。
- source 在 child 创建后继续对话、再次 compaction 或 Revert，child 的 head/root 不变化。
- child 后续 compaction 或再次 Fork 不影响 source。
- Workspace 删除仍能按现有清理链路处理 source、child 和共享消息图。

## 前端 helper 与组件测试

主要位置：

```text
apps/web/src/features/workspace/tools/agent/agentMessageTimeline.test.ts
apps/web/src/features/workspace/tools/agent/AgentMessageActions.component.test.ts
apps/web/src/features/workspace/tools/agent/AgentClientPane.component.test.ts
```

至少覆盖以下矩阵：

| message | `inCurrentOperationRange` | canFork | canRevert | 操作按钮 |
|---|---:|---:|---:|---|
| 压缩前 User | false | true | false | 仅 Fork |
| 压缩前 Assistant | false | true | false | 仅 Fork |
| 当前范围 User | true | true | true | Fork + Revert |
| 当前范围 Assistant | true | true | false | 仅 Fork |
| compaction | 任意 | false | false | 无 |
| system/runtime | 任意 | false | false | 无 |

还必须覆盖每条 message 的唯一操作锚点：

- 无 part、tool-only、reasoning-only、image-only Assistant 均能在唯一锚点显示一次 Fork。
- 多 part message 只显示一次操作，不产生重复 Fork/Revert。
- 最小 part `position` 非 `0` 时，排序后的第一条 row 仍是锚点；实现不得依赖 `row.part?.position === 0`。

还必须验证：

- 历史 Fork 直接调用既有 `forkAgentSession()`，不出现 confirm modal、warning toast 或新增 i18n 文案。
- Fork 成功后仍 refresh Session 列表并激活 child tab。
- 同一 Session 的结构操作 pending 互斥保持；请求成功、失败和异常时 pending 均能释放。
- Fork 失败后 source 时间线与已打开的 tab 不被乐观修改。
- 压缩前 User 的 Revert 入口不可见，不能因显示 Fork 而意外暴露 Revert。

## 手工验收场景

### 单次压缩后的历史 Fork

- 创建 primary Session，完成多条 User/Assistant 消息。
- 触发 compaction，确认时间线仍能显示压缩前消息。
- 对压缩前 User 和 Assistant 分别 Fork。
- 确认新 tab 打开、child session 创建成功。
- 在 child 发送一条新消息，确认 Agent 能从历史上下文继续，不出现 context root ancestry 错误。
- 回到 source，确认 source 的消息、head 和当前上下文不被修改。
- 确认压缩前 User 仍无 Revert 入口。

### 多次压缩后的历史 Fork

- 形成 `M1 → M2 → C1 → M3 → M4 → C2 → M5` 等价链。
- 分别从 `M2`、`M4`、`M5` Fork。
- 通过测试诊断或可观测上下文确认 root 分别为 `null`、`C1`、`C2`。
- 确认 `M4` child 不包含 `C2` 之后的内容。

### 失败边界

- 令 source 运行中或 target Assistant 的工具执行中，再尝试 Fork，确认失败且没有 child。
- 从 Revert 后不在当前分支的旧 message 发起请求，确认后端拒绝。
- 验证失败后 UI pending 释放、source 不变化。

## 最小自检命令

共享契约没有改动时，本需求原则上不要求单独构建 `packages/shared`。实现完成后，至少执行：

```bash
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run test -w apps/api
npm run test -w apps/web
```

如只需先验证相关后端测试，可使用项目已有的 API test gate：

```bash
npm run test:unit -w apps/api
npm run test:integration -w apps/api
```

命令以当前 `package.json` scripts 为准；若开发期间 scripts 被其他合法改动调整，执行前必须先核实对应 workspace 的实际脚本，不能臆造测试命令。完整回归可执行：

```bash
npm run typecheck
```

是否执行全量构建、Worker 集成测试或端到端手工启动，按改动面和 CI 约束补充；不得以类型检查替代上述行为验收。

## 代码审查通过条件

以下任一项不满足，审查不得通过：

- 仅删除 `FORK_TARGET_BEFORE_CONTEXT_ROOT` 校验，未按 target 重新计算 root。
- child root 可能是 target 后代或不在 child head ancestry。
- 历史 Fork 通过复制/改写消息图实现，或引入无必要 migration。
- Revert 的压缩边界被放开。
- 前端仍使用单个 `canMutateAgentTimelineMessage()` 同时决定 Fork/Revert。
- 历史 User 同时暴露 Fork 与 Revert，或合法历史 Assistant（包括无 text part）没有 Fork。
- 新增了未被需求允许的 warning、confirm、token 预估、自动压缩或重试。
- 内部 subtask 的 active parent、boundaryPolicy/internal-resolved、guard→prompt、prefork summary、lineage、locale/depth 或工具限制发生未授权变化。
- conversation row 用 `row.part?.position === 0` 作为唯一操作锚点，或无 part/multi-part message 缺少或重复操作。
- 缺少多次 compaction、retained tail、transaction rollback、Fork 后 sendMessage/Run 的自动测试。
