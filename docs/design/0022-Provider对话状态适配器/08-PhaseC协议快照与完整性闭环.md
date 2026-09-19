# Phase C 协议快照与完整性闭环

## 目标

DeepSeek Thinking experimental 需要保证：一段位于有效历史中的 Assistant reasoning 若属于 DeepSeek 协议，就不能因为其 `provider_replay_json` 整体丢失、版本损坏或未完成而被静默忽略后继续回放后续历史。

仅观察 Part 上是否存在 Envelope 不足以实现该保证：没有独立的历史协议身份时，系统无法区分“该 Assistant 从来不属于 DeepSeek”与“该 Assistant 曾属于 DeepSeek，但 Envelope 已整体缺失”。本章采用强保证方案：持久化 Assistant 创建时的最终协议快照，并为 DeepSeek reasoning 建立 terminal completion metadata。

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

快照只在 Worker 发起模型调用创建的 Assistant Message 上写入；System/User/Tool/Compaction 消息为 `NULL`。新建列可为空是为了兼容旧历史，而不是允许 Phase C 新 DeepSeek Assistant 漏写。

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

- 快照在 Assistant 创建前从**本次最终解析的 ExecutionProfile**产生，必须包含 protocol、npm、Provider 配置 ID、最终模型 ID 和版本。
- 快照不得从之后可变的 settings、Provider 名称、base URL 或模型前缀重新推断。
- `deepseek-chat-thinking` 只能搭配 `@ai-sdk/openai-compatible`；不合法组合在 settings、Worker、Factory 三层拒绝。
- 快照是该 Assistant Message 的不可变 provenance；不得在 flush、complete、retry、recovery 或设置变更时更新。
- `default` 只表示没有 Provider Conversation State 协议，不是 Registry Adapter；Registry 对它返回 `null`。
- `openai-responses` 新消息也可以写快照以形成一致 provenance，但 OpenAI Phase A 的损坏 replay 读取策略仍保持 0019 现状，不因新增快照改变为 fail closed。

最终字段名、TypeBox 导出位置和 JSON key 可按项目风格调整，但不得删除上述可关联性和不可变性。

## 数据库迁移与回滚

### 版本与 DDL 草案

当前 `AGENT_SCHEMA_VERSION` 为 v21。Phase C 必须新增**非破坏性、仅前向**的 v21 → v22 迁移：

```sql
alter table agent_message
  add column provider_protocol_snapshot_json text;

create index idx_agent_message_protocol_snapshot
  on agent_message(origin_session_id, type, status, id)
  where provider_protocol_snapshot_json is not null;
```

- 目标 schema 的 `agent_message` 列清单、建表 DDL、schema classification、upgradeable 判定、迁移测试都必须同步更新。
- 迁移仅新增可空列和索引；不重写旧消息、Part、Archive 或 settings，不扫描/猜测旧历史协议。
- 迁移在现有 `initSchema()` 单事务升级链中完成：添加列、创建索引、更新 `agent_schema_meta.version` 必须原子提交。失败时事务回滚，数据库保留 v21 状态。
- 索引是私有 read-side 的查询辅助；正确性不能依赖索引存在。实际查询仍以当前 `contextRoot..head` 有效链和 Assistant Message ID 集合为第一道范围。

### 回滚边界

- 当前 v21 二进制以严格 schema version 和目标列匹配分类数据库；因此 v21 二进制**不能直接启动**已升级为 v22 的数据库。不得假设“新增可空列会被旧代码忽略”。
- 默认功能回滚不是二进制/schema 回退：继续使用支持 v22 的应用版本，关闭或回滚 DeepSeek feature flag、模型设置/UI 入口和 `deepseek-chat-thinking` 协议消费。既有 snapshot、Envelope 与普通消息保留但不消费；不得删除或改写历史 JSON。
- 禁止通过降写 `agent_schema_meta.version`、删列、重建表或复制数据为旧结构来伪造 v21；这些操作会破坏严格分类、历史 provenance 或恢复语义。
- 若未来确有二进制回退需求，必须先发布并验证一个对 v21/v22 均具前向兼容能力的预备版本，再单独设计发布编排、自动化升级/回退测试与数据责任边界；这不是本方案的默认能力或交付承诺。
- 再使用 v22 应用启用协议后，带快照的新 DeepSeek history 重新接受完整性检查；旧无快照 completed history 仍不能被猜测为 DeepSeek。

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

- 对带非 `NULL` snapshot 的 streaming Assistant，recovery 认领时必须读取并校验其快照；不能重新解析 settings 覆盖旧快照。下述 v21 遗留 `NULL` snapshot 是唯一升级收敛例外，不允许认领续跑。
- 对 v21 遗留的 active Run + streaming Assistant，升级 v22 后发现 `provider_protocol_snapshot_json IS NULL` 时，恢复路径不得从当前 settings 推断、补写或伪造 snapshot，也不得认领后发送任何 Provider HTTP 请求。
- 此情形必须走既有 fenced recovery/fail-converge 收敛语义（实现可选当前最合适的失败收敛接口；优先复用 `failMessageRunAndConverge`）：在同一受 fence 保护的收敛操作中使遗留 Run 和其 streaming Assistant 不再处于 running/streaming，保留原 Message、Parts 与 `NULL` snapshot，并允许用户随后新建 Run。不得为该遗留消息创建可继续请求的 replacement。
- 因此旧 active streaming 的升级恢复不是“兼容续跑”：它是无 HTTP、无 snapshot 回填的安全终止；若 fence 已失效，操作只能被忽略，由当前 fence 持有者负责收敛，绝不能越权写入。
- `completeAssistant` 只改变 Message/Run 的终态，不改变快照。
- fail/converge、abort、timeout 或控制面失败使 Assistant 进入 failed/cancelled/superseded 时，快照可保留供诊断，但私有 read-side 不把该消息作为 source。
- 只有 `completed` Assistant 的 snapshot 和 Part metadata 可进入下一次 PromptContext 私有 source。

### compaction 与有效链

- read-side 始终先按 Session `contextRoot..head` 取得当前有效链，再关联这些 message IDs 的快照与 Parts。
- compaction 后被摘要替换、已不在有效链的 DeepSeek Assistant 即使保留快照和 Envelope，也不回放。
- compaction summary、messages-context、shared single-call 不读取快照，不启用 DeepSeek Factory/Adapter。

## DeepSeek terminal completion metadata

### 写入规则

DeepSeek 流中 `reasoning-delta` 到达时，Runner 继续即时创建/更新可见 reasoning Part.`text`，以维持现有流式 UI 行为；此时**不得**附着 DeepSeek replay Envelope。

只有当前 Attempt 同时满足下列条件时，DeepSeek Adapter 才能对本 Attempt 的每个 reasoning Part 产生 terminal metadata update：

- 已观察到一个已知且允许成功的 AI SDK finish reason；Phase C v1 allowlist 固定为 `stop` 与 `tool-calls`。
- 没有观察到 stream error、abort、timeout、外部取消或协议失败。
- finish reason 不是 `unknown`，也不是不在 allowlist 的值（含 `length`、`content-filter`、`error`、`other` 或未来未知值）。

terminal update 的 DeepSeek Envelope 必须至少包含：

```ts
item: {
  type: "reasoning";
  contentSource: "reasoning-part-text-v1";
  completion: "complete-v1";
}
```

`reasoning-end` 只表示一个流 part 结束，**不代表**整个 response 或 replay payload 完整，不能产生 `completion: "complete-v1"`。

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

对当前有效链中 `completed`、snapshot 匹配本次 DeepSeek profile、并在最后 User 后 scope 内的 Assistant：

- 每个 `type="reasoning"` Part 必须有可解析、匹配 Provider/模型/protocol 的 DeepSeek Envelope；
- Envelope 必须有 `contentSource: "reasoning-part-text-v1"` 和 `completion: "complete-v1"`；
- Part.`text` 必须非空；
- 关联 Part 的 position/Assistant 归属必须可解析；
- 任一项不满足时，私有 diagnostics 返回 `missing-required-metadata`、`missing-reasoning-text`、`incomplete-reasoning-text` 或具体 schema/version 类别，Worker 在请求前 Configuration fail closed。

这实现了强保证：通过 Message snapshot 可识别“DeepSeek Assistant 有 reasoning Part，但 Envelope 整体缺失”。没有快照的旧 Assistant 不属于强保证范围，不能被推断为 DeepSeek。

## 旧历史兼容策略

| 历史类型 | 行为 |
|---|---|
| v22 后新建、snapshot=`deepseek-chat-thinking` 且 scope 匹配 | 进行完整性闭环检查；损坏或缺失 fail closed |
| v22 后新建、snapshot 为其他合法协议/Provider/模型 | 正常跳过，不阻塞 DeepSeek |
| v21 及更早、已 completed、snapshot 为 `NULL` | 不猜测协议；不作为 DeepSeek replay source，也不以整体缺 Envelope 阻塞请求；普通读取保持可用 |
| v21 遗留 active Run + streaming Assistant、snapshot 为 `NULL` | 升级后不续跑、不发 HTTP、不补写 snapshot；通过 fenced recovery/fail-converge 收敛至非 running 状态，随后允许新 Run |
| 当前 OpenAI 历史 | 保持 0019 容错 parse/跳过策略；Phase A 不改变 |
| 非法 snapshot JSON 但可识别为本次 DeepSeek | 诊断并 fail closed |
| 完全无法识别归属的损坏 snapshot/Envelope | 安全跳过，不猜测为 DeepSeek |

## 必测证据

- v21 → v22 升级、空库建表、重复启动、升级失败事务回滚与 schema classification。
- v22 数据库被当前 v21 二进制启动时必须因严格 schema version/列匹配明确拒绝；默认 feature rollback 保持 v22 二进制并关闭 DeepSeek，不降写版本、不删列、不重建表。
- 新 DeepSeek Assistant 创建时快照原子写入；settings 后续改变不影响快照。
- replacement 复制同一快照；旧消息 superseded 后不进入 source；recovery 保留原快照。
- v21 active Run + streaming Assistant 升级 v22：不发送 Provider HTTP、不推断或补写 snapshot、Run 与 Assistant 经 fenced recovery/fail-converge 后均不再 running；原消息和 `NULL` snapshot 保留，用户可创建新 Run。
- 有 reasoning delta + `stop`、有 reasoning delta + `tool-calls`：completion metadata 只在 finish 后生成、强制 flush 成功才 complete。
- reasoning-end 后 EOF、unknown、length、error、abort、timeout：没有 `complete-v1`，Assistant 不完成，后续有效 source 不包含其部分 reasoning。
- snapshot 匹配 DeepSeek + reasoning Part 无 Envelope：read-side diagnostic 为 `missing-required-metadata`，下次请求前不发送 HTTP。
- snapshot 匹配但 completion 缺失、text 为空、版本/字段非法：全部 fail closed。
- 旧 `NULL` snapshot 不猜测、不阻塞，也不回放为 DeepSeek。
- compaction、provider/model/protocol 切换和非目标 history 均不误触发 fail closed。
