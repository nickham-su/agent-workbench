# 边界情况与不变量

## 核心不变量

实现、审查和验收必须同时满足以下不变量：

- child `headMessageId` 必须等于 Fork target。
- child `contextRootMessageId` 必须为 `null` 或 child head 的物理祖先；不得是 target 的后代。
- child root 存在时，必须属于同一 Workspace；若其类型为 compaction，必须由 target 向祖先回溯得到的最近 compaction。
- target 到最近 compaction 或物理起点的遍历必须完整、无循环、全链同 Workspace；没有 compaction 时只能在 `previous_message_id = null` 正常结束后使用 `null` root。
- Fork 不得携带 target 之后的普通消息、compaction summary、retained tail 或运行状态。
- Fork 不得修改 source Session 的 head、root、revision、run state 或消息图。
- Fork 不复制历史 message、part、tool execution、附件或 provider replay。
- 历史 Fork 的放开不得改变 Revert 在 compaction 边界前的拒绝。
- 公开 primary Fork 与内部 subtask Fork 共用 target-time root；内部 `boundaryPolicy` 只选 target，不得更改 root。
- 数据异常必须 fail-close；不得为了“尽量成功”将非法 root 改写为 `null`、target 或来源当前 root。

## 压缩与 root 矩阵

### 无 compaction

```text
M1 → M2 → M3
```

| target | 预期 child root | 预期逻辑上下文 |
|---|---|---|
| `M1` | `null` | `M1` |
| `M2` | `null` | `M1 → M2` |
| `M3` | `null` | `M1 → M2 → M3` |

### 单次 compaction

```text
M1 → M2 → C1 → M3 → M4
```

| target | 预期 child root | 说明 |
|---|---|---|
| `M1`、`M2` | `null` | 恢复 summary 产生前的原始前缀 |
| `M3`、`M4` | `C1` | 使用 C1 summary、C1 retained tail 与后续消息 |
| `C1` | 拒绝 | compaction 不是合法 target |

### 多次 compaction

```text
M1 → M2 → C1 → M3 → M4 → C2 → M5
```

| target | 预期 child root | 禁止行为 |
|---|---|---|
| `M1` | `null` | 不得引入 C1/C2 |
| `M2` | `null` | 不得引入 C1/C2 |
| `M3` | `C1` | 不得使用 C2 |
| `M4` | `C1` | 不得使用 C2 |
| `M5` | `C2` | 不得回灌 C1 前原始历史 |
| `C1`、`C2` | 拒绝 | 不得以 summary 作为 target |

### Retained tail

当 child root 为 compaction `C1` 时，Resolver 必须按既有规则构造：

```text
C1 summary
→ C1.retainedFromMessageId 指向的原始尾部
→ C1 后至 child head 的消息
```

- retained tail 属于 root 自身的历史语义，不因 child target 位于 summary 后而丢失。
- 更晚 compaction 的 retained tail 不得进入历史 child。
- 更早 compaction summary 不得因物理链存在而重复注入。
- retained anchor 不可达、不属于正确祖先关系或缺失时，必须 fail-close。

## target 与来源边界矩阵

| 场景 | Fork 预期 | Revert 预期 |
|---|---|---|
| 当前物理祖先链上的压缩前 terminal User | 允许 | 拒绝 `MESSAGE_TARGET_BEFORE_CONTEXT_ROOT` |
| 当前物理祖先链上的压缩前 terminal Assistant，工具均终态 | 允许，即使没有 text part | 不适用/隐藏 |
| 当前范围内合法 User | 允许 | 允许，保持现有确认流程 |
| 当前范围内合法 Assistant | 允许 | 不适用/隐藏 |
| compaction message | 拒绝 | 隐藏/拒绝 |
| system/runtime message | 拒绝 | 隐藏/拒绝 |
| target 不存在 | 拒绝 | 拒绝 |
| target 非 source 当前 head 的祖先 | 拒绝 | 拒绝 |
| source Revert 后已脱离当前分支的旧消息 | 拒绝 | 拒绝 |
| 跨 Workspace target | 拒绝 | 拒绝 |
| target 非终态 | 拒绝 | 保持现有规则 |
| Assistant 有 queued/running tool execution | 拒绝 | 不适用 |
| source running 或不稳定 | 公开 Fork 拒绝 `SESSION_NOT_IDLE` | 保持现有规则 |
| head/revision 在 transaction 期间变化 | 冲突并回滚 | 保持现有规则 |

这里的 terminal 采用 `messageTerminal()` 的兼容集合：`completed`、`failed`、`cancelled`、`superseded`。

## 共享 Fork 调用方边界

| 场景 | target-time root | 其他语义 |
|---|---|---|
| 公开 primary Fork | 由 `forkMessageSession()` 统一计算 | source 必须 idle；保持公开错误映射 |
| 内部 subtask，active parent run | 由同一 helper 统一计算 | 保持 `allowSourceWithActiveRun` 的既有窄特例 |
| 内部 subtask，internal-resolved boundary | 由同一 helper 统一计算 | `boundaryPolicy` 保持既有 target 解析，不改变 root |
| internal subtask 的 guard→prompt/prefork summary | 不得改变已选 target 的 root 算法 | 保持既有顺序、内容、lineage、locale/depth 与工具限制 |

本需求不得使公开 Fork 获得 active-run 例外，也不得使内部 subtask 因 root 改造失去既有 guard、prompt、summary 或权限边界。

## Fork 后的隔离矩阵

| 后续操作 | 对 source | 对 child |
|---|---|---|
| source 继续对话 | 自身 head/revision 前进 | 不变 |
| source 再次 compaction | 自身 head/root 更新 | 不变 |
| source Revert | 自身 head 变化 | 不变 |
| child 继续对话 | 不变 | 自身 head/revision 前进 |
| child 再次 Fork | 不变 | 按 child target 的历史 root 独立计算 |
| child compaction | 不变 | 只更新 child head/root |
| Workspace 删除 | 统一清理 | 统一清理 |

“互不影响”仅指 Session 消息图指针和上下文边界。source 与 child 仍对应同一 Workspace，运行时对同一文件系统、Git 仓库或外部服务的实际操作可能相互影响；本需求不引入 Workspace 并发隔离。

## 历史上下文的能力边界

| 材料 | 新 Fork Run 的表现 |
|---|---|
| 历史文本 | 按 child root/head 进入模型上下文 |
| 历史 compaction | 若为 child root，使用 summary 与 retained tail |
| 历史 tool call | 按既有 runtime transcript 投射 |
| 历史 tool result | 仅使用 preview、error、status 等既有投射；不是完整 artifact/structured result 回放 |
| 历史图片 | 转为占位说明，不重新作为 image attachment 发给模型 |
| 当前 trigger 图片 | 仅新消息按现有路径作为 attachment ref |
| provider replay | 是否被使用取决于当前 provider/model 与原 replay 的匹配条件 |
| source model override | 不继承；child 后续 Run 重新解析 profile |
| Workspace/Git/工具外部状态 | 不快照、不回滚、不保证与历史一致 |

## 资源限制与异常处理

历史 Fork 可能构造更长的历史上下文，但本次不增加 Fork 前 token 预估、阻止、自动压缩或提示。

- context/token 超限继续由现有 Worker、provider 和 auto-compaction/Run 失败收敛路径处理。
- 不得因历史 Fork 增加重试或无限 compaction 循环。
- provider 拒绝超限时，必须按既有 Run 失败语义收敛，source 与 child Session 图保持完整。

## 数据损坏 fail-close

### Fork transaction 必须阻断的异常

下列异常属于服务端数据不变量错误，必须记录诊断日志、rollback，不创建 child Session/run state，并返回 `500`；不得伪装成用户可以修正的 `400`：

- child root 不属于 target 物理祖先链；
- root 与 target 不在同一 Workspace；
- target 至最近 compaction/物理起点的 `previous_message_id` 链循环、缺行、跨 Workspace 或提前截断；
- 未找到 compaction，但链未以 `previous_message_id = null` 正常结束；
- 写入路径可用既有 helper 直接确认的 compaction predecessor/retained-tail 结构错误。

下列仍是既有可预期业务错误，保持当前领域错误和 HTTP 映射，而不是改报 `500`：

- target 非祖先、类型/终态非法或不存在；
- Assistant 有 queued/running tool execution；
- 公开 source busy；
- transaction fence 发现来源 head/revision 变化。

### Resolver 必须阻断的延迟发现异常

某些 retained tail 异常只有 Resolver 完整 hydrate summary、predecessor 与 anchor 后才能确认。此时 child 可能已经创建，但 Resolver 必须以 `ModelContextInvariantError` fail-close，后续 Run 不得构建部分 prompt。不得为了让已创建 child 可运行而静默跳过 retained tail 或回退到 `null` root。

无论在哪一层发现，实现都不得吞掉异常后创建或使用“空上下文 Fork”，因为这会隐藏数据一致性问题并使后续 Agent 行为不可审查。
