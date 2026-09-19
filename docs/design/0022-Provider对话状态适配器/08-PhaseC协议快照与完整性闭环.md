# Phase C 协议快照与完整性闭环

## 目标

DeepSeek Thinking experimental 需要保证：一段位于有效历史中的 Assistant reasoning 若属于 DeepSeek 协议，就不能因为其 `provider_replay_json` 整体丢失、版本损坏或未完成而被静默忽略后继续回放后续历史。

仅观察 Part 上是否存在 Envelope 不足以实现该保证：没有独立的协议身份时，系统无法区分“该 Assistant 不属于 DeepSeek”与“该 Assistant 属于 DeepSeek，但 Envelope 已整体缺失”。本章采用强保证方案：持久化 Assistant 创建时的最终协议快照，并为 DeepSeek reasoning 建立 terminal completion metadata。

本项目当前不保留旧 Agent 数据兼容。Phase C 直接把协议快照纳入目标 schema，通过现有不兼容 schema 收敛/重建机制应用，不设计旧版本数据库升级、双读、回填或旧二进制回滚。

## 协议快照实体

### 选择 `agent_message` 的理由

Phase C 在 `agent_message` 新增草案列：

```text
provider_protocol_snapshot_json text null
```

选择 Assistant Message，而不是 `agent_run`，原因如下：

| 方案 | 结论 | 原因 |
|---|---|---|
| `agent_run` | 不采用 | 一个 Run 可有多个模型 Step / Assistant；Run 级快照不能无歧义地关联每个历史 Assistant，且无法表达 replacement 后具体消息的状态来源 |
| `agent_message` | 采用 | 一个 Assistant Message 恰好是一次流式模型 Attempt 的持久化对象；Part、status、replacement、有效链和 compaction 都已以 message 为边界 |
| `agent_message_part` | 不采用 | 整体 Envelope 缺失时无法通过 Part 字段证明“应该有 state”；快照必须独立于 Part metadata 存在 |

该列允许 `NULL`，因为 User、System、Runtime、Compaction Message 不携带 Provider 协议快照。由 Worker 发起模型调用创建的 Assistant Message 必须写入合法快照；Assistant 上的 `NULL` 或损坏快照属于数据不变量错误，不是兼容分支。

### 快照 schema 草案

```ts
type ProviderProtocolSnapshotV1 = {
  version: 1;
  protocol: "openai-responses" | "deepseek-chat-thinking" | "default";
  npm: "@ai-sdk/openai" | "@ai-sdk/openai-compatible" | "@ai-sdk/anthropic";
  providerId: string;
  model: string; // 已按 providerModelId 优先、model.id 回退后的最终模型 ID
};
```

不变量：

- 快照在 Assistant 创建前从本次最终解析的 ExecutionProfile 产生，必须包含 protocol、npm、Provider 配置 ID、最终模型 ID 和版本。
- 快照不得从之后可变的 settings、Provider 名称、base URL 或模型前缀重新推断。
- `deepseek-chat-thinking` 只能搭配 `@ai-sdk/openai-compatible`；不合法组合在 settings、Worker、Factory 三层拒绝。
- 快照是该 Assistant Message 的不可变 provenance；不得在 flush、complete、retry、recovery 或设置变更时更新。
- `default` 只表示没有 Provider Conversation State 协议，不是 Registry Adapter；Registry 对它返回 `null`。
- `openai-responses` Assistant 同样写快照以形成一致 provenance；OpenAI Phase A 的损坏 replay 读取策略仍保持 0019 现状，不因快照改为 fail closed。

最终字段名、TypeBox 导出位置和 JSON key 可按项目风格调整，但不得删除上述可关联性和不可变性。

## 目标 Schema 与应用方式

目标 DDL 草案：

```sql
provider_protocol_snapshot_json text null
```

可增加私有查询索引：

```sql
create index idx_agent_message_protocol_snapshot
  on agent_message(origin_session_id, type, status, id)
  where provider_protocol_snapshot_json is not null;
```

实施要求：

- 目标 schema 的 `agent_message` 列清单、建表 DDL、schema classification/semantics 检测和测试必须同步更新。
- schema 版本号由实施时基于仓库当前版本顺延，不在设计中写死，也不得复用已被其他变更占用的版本号。
- 使用项目现有不兼容 schema 收敛/重建机制；不实现旧版本逐级升级、旧 Message 扫描、协议猜测或 snapshot 回填。
- 索引只是私有 read-side 的查询辅助；正确性不能依赖索引存在。实际查询仍以当前有效模型上下文的 Assistant Message ID 集合为第一道范围。
- 如需回到旧 schema，使用个人开发环境既有数据重置/重建流程；不降写 schema version，不维护双读或旧二进制兼容层。

## 写入时机、事务与生命周期

### 首次创建

在 `createStreamingAssistant` 的 API 请求中增加经过内部契约校验的 `providerProtocolSnapshot`。Worker 在以下条件都已成立后才发起创建：

- 最终 ExecutionProfile 已解析；
- 模型级 `protocolAdapter` 与 Factory 静态校验通过；
- Registry 已选择到目标 Adapter 或确认 `null`；
- 对 Phase A，保持当前 replay 注入和附件物化的先后；对 Phase C DeepSeek，遵循已定义的 Factory/Registry/工具发现顺序。

API 的 `createStreamingAssistant` 在现有创建 Assistant、更新 Session head 和 `session_run_state` 的同一数据库事务内写入快照。创建成功后快照不可修改。

配置/Factory/Registry 静态失败必须发生在创建之前，因此不产生没有快照的 streaming Assistant。

### retry replacement

若一个 Attempt 已输出后需要 replacement：

```text
旧 Assistant（snapshot S，status=streaming）
→ 同一事务：旧消息 status=superseded
→ 新 replacement Assistant（复制同一 snapshot S，status=streaming）
→ Session head 指向 replacement
```

- replacement 不重新从可能已改变的 settings 解析快照；必须复制当前 Step 已冻结的 `S`，并在 Worker/API 边界验证一致。
- 旧消息 `superseded`，不在有效链，不可成为 replay source；其未完成/部分 reasoning 不影响新 Assistant。
- replacement 失败时不创建可继续使用的新 source，Run 终止。

### recovery、完成与失败

- recovery 认领 streaming Assistant 时必须读取并校验其快照；不能重新解析 settings 覆盖旧快照。
- Assistant 快照缺失、损坏或与当前 Step 冻结快照冲突时，必须 fail closed：不得补写、不得创建可继续请求的 replacement、不得发送 Provider HTTP。
- 上述错误通过既有 fenced failure/convergence 路径使 Run 与 streaming Assistant 离开 running/streaming；若 fence 失效，只能由当前 fence 持有者负责收敛。
- `completeAssistant` 只改变 Message/Run 的终态，不改变快照。
- fail/converge、abort、timeout 或控制面失败使 Assistant 进入 failed/cancelled/superseded 时，快照可保留供诊断，但私有 read-side 不把该消息作为 source。
- 只有 `completed` Assistant 的 snapshot 和 Part metadata 可进入下一次 PromptContext 私有 source。

### compaction 与有效链

- read-side 必须先通过 ModelContext Resolver 取得当前有效模型上下文，再关联其中 Assistant 的快照与 Parts。
- 0020 启用 retained tail 后，位于 Timeline 的 context root 之前但被 resolver 选入 retained tail 的 Assistant 可以成为 state source；Timeline 的只读操作区间标记不得用于裁剪 Provider state。
- 已被 resolver 排除的旧历史即使仍在完整 Timeline 中可见，也不得回放。
- compaction summary、messages-context、shared single-call 不读取快照，不启用 DeepSeek Factory/Adapter。

## DeepSeek terminal completion metadata

### 写入规则

DeepSeek 流中 `reasoning-delta` 到达时，Runner 继续即时创建/更新可见 reasoning Part.`text`，以维持现有流式 UI 行为；此时不得附着 DeepSeek replay Envelope。

只有当前 Attempt 同时满足下列条件时，DeepSeek Adapter 才能对本 Attempt 的每个 reasoning Part 产生 terminal metadata update：

- 已观察到一个已知且允许成功的 AI SDK finish reason；Phase C v1 allowlist 固定为 `stop` 与 `tool-calls`。
- 没有观察到 stream error、abort、timeout、外部取消或协议失败。
- finish reason 不是 `unknown`，也不是不在 allowlist 的值，包括 `length`、`content-filter`、`error`、`other` 或未来未知值。

terminal update 的 DeepSeek Envelope 必须至少包含：

```ts
item: {
  type: "reasoning";
  contentSource: "reasoning-part-text-v1";
  completion: "complete-v1";
}
```

`reasoning-end` 只表示一个流 part 结束，不代表整个 response 或 replay payload 完整，不能产生 `completion: "complete-v1"`。

### flush 与完成门禁

```text
已知允许 finish
→ Adapter 生成 completion metadata updates
→ Runner 将 updates 附着到既有 reasoning Parts
→ 强制 flush，且 API/Store 成功持久化
→ finalizeAttempt
→ Runner 才可 completeAssistant
```

- terminal metadata flush 失败、被 fence 忽略、缺目标 Part、兼容性校验失败，均阻止 finalize/complete。
- EOF 没有 finish、unknown finish、stream error、abort、timeout、取消均为 DeepSeek `TerminalProtocol` 失败；不得 complete。
- 若 response 没有 reasoning Part，则没有 DeepSeek completion metadata 要写；这不是 `missing-required-metadata`。但一旦有 reasoning Part，且 snapshot 为匹配 DeepSeek，缺 Envelope 或 completion 绝不可被忽略。

### read-side 完整性判定

对当前 resolver 有效模型上下文中 `completed`、snapshot 匹配本次 DeepSeek profile、并在最后 User 后 scope 内的 Assistant：

- 每个 `type="reasoning"` Part 必须有可解析、匹配 Provider/模型/protocol 的 DeepSeek Envelope；
- Envelope 必须有 `contentSource: "reasoning-part-text-v1"` 和 `completion: "complete-v1"`；
- Part.`text` 必须非空；
- 关联 Part 的 position/Assistant 归属必须可解析；
- 任一项不满足时，私有 diagnostics 返回 `missing-required-metadata`、`missing-reasoning-text`、`incomplete-reasoning-text` 或具体 schema/version 类别，Worker 在请求前 Configuration fail closed。

这实现了强保证：通过 Message snapshot 可识别“DeepSeek Assistant 有 reasoning Part，但 Envelope 整体缺失”。目标 schema 下不存在需要猜测协议的旧 Assistant 兼容分支。

## 必测证据

- 空库目标 schema、重复启动、目标列/索引/semantics 检测。
- 新 DeepSeek Assistant 创建时快照原子写入；settings 后续改变不影响快照。
- replacement 复制同一快照；旧消息 superseded 后不进入 source；recovery 保留原快照。
- streaming Assistant 缺失、损坏或冲突 snapshot 时：不发送 Provider HTTP、不推断或补写 snapshot，并经 fenced failure/convergence 后不再 running。
- 有 reasoning delta + `stop`、有 reasoning delta + `tool-calls`：completion metadata 只在 finish 后生成、强制 flush 成功才 complete。
- reasoning-end 后 EOF、unknown、length、error、abort、timeout：没有 `complete-v1`，Assistant 不完成，后续有效 source 不包含其部分 reasoning。
- snapshot 匹配 DeepSeek + reasoning Part 无 Envelope：read-side diagnostic 为 `missing-required-metadata`，下次请求前不发送 HTTP。
- snapshot 匹配但 completion 缺失、text 为空、版本/字段非法：全部 fail closed。
- 0020 retained tail 中的兼容 Assistant state 可按 resolver 顺序回放；仅 Timeline 可见但不在 resolver 有效上下文中的旧历史不得回放。
- compaction、provider/model/protocol 切换和非目标 history 均不误触发 fail closed。
