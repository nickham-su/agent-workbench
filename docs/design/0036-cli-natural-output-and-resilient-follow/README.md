# CLI 自然语言输出与可靠增量监听

## 文档定位

- 本目录是本次改造的开发、代码审查与验收基线。代码已按五阶段实施，**开发与独立源码复审完成**；原全面审查者最新 `existing` 已确认 M1～M5、D1/D2 全部关闭、无新增实质问题。最后完整门禁及总体验收确认边界见[实施与验收证据](08-implementation-and-evidence.md)，总体结论由主会话依据复审与证据给出，不以设计审查或测试全绿自动替代。
- 需求依据是本轮已确认的产品决策；技术事实依据是当前仓库源码。旧设计中的 JSON/JSONL、零请求重试、已输出草稿被替换即失败等规则由本目录明确替代。
- 设计编写阶段仅创建本目录；后续实施已修改 CLI、shared/API 只读证明及相应测试和说明，未改变 Worker 写入业务、数据库 schema 或依赖。实际门禁结果和未验环境见实施证据。
- 文中“必须／不得”属于验收要求，“现状”只描述核查结果。不得把示例输出中的占位 ID 当成真实数据。

## 阅读入口

| 文件 | 用途 |
| --- | --- |
| [需求、范围与决策](01-requirements-and-decisions.md) | 产品目标、逐命令影响、取舍和非目标 |
| [自然语言输出契约](02-output-contract.md) | 消息 ID 时机、正文与诊断、任务结果、异常展示 |
| [监听状态机与增量渲染](03-follow-state-and-rendering.md) | 客户端实体、分页与重建、选择边界、Unicode、流式草稿 |
| [同 Run 替换证明](04-head-replacement-proof.md) | 新增 shared/API 最小只读支撑、精确字段与服务端证明算法 |
| [只读请求重试](05-read-request-retry.md) | 分类、次数、退避、配置续签、取消与副作用边界 |
| [验收矩阵](06-acceptance.md) | 可执行场景、负向边界及需求追踪 |
| [实施与审查计划](07-implementation-plan.md) | 分阶段任务、受影响文件、测试迁移及验证命令 |
| [实施状态与验收证据](08-implementation-and-evidence.md) | 实际分阶段顺序、设计差异、95 项测试映射、门禁结果与审查边界 |

## 核心结论

- CLI 对外全面移除 `--json`；统一自然语言与固定字段，不保留隐藏兼容模式。
- `-f` 继续使用 HTTP 轮询；assistant 正文按已验证的前缀增量写出，不在终态重打全文。
- 当前流式 assistant 的消息 ID 只有在其正文全部写出且消息进入真正终态后才显示；作废或中断草稿不得通过其他字段旁路显示 ID。
- 同一 Run 的合法重试替换使旧草稿明确作废并继续观察；不切换目标 Run，不拼接不同尝试的正文。
- 仅监听流程中的逻辑只读请求允许首次加三次重试，退避为 1／2／4 秒；认证、契约、分支和本地保存失败等不重试。
- 不提供“建议续读位置”、恢复命令、续读游标或等价引导；`--after` 保持排除锚点本身。
- Run 结果与消息读取完整性独立；中断监听不等于取消后台任务。
- 非 follow 快照在本次输出结束时完整 flush 所读字符，业务 streaming 状态与 ID 资格不变；follow 等业务封口。
- 已知目标终态后进入 FinalDrain，最多两个重建 pass、每 pass 最多一个关闭 delta；不因后续 Run 持续变化无限追尾。

## 新发现的必要支撑项

- 原先以 CLI 为主的范围，需要最小 shared/API 只读契约增量，原因不是优化架构，而是现有公开读取接口无法证明跨轮询漏掉的 `A → B → C` 草稿替换链。
- 当前 `getTimeline` 和 `getMessage` 仅公开当前展示链，`replacesMessageId` 只指直接前驱。旧消息不可见后不能再通过普通详情取回。
- 已选定：复用 delta 请求的 `knownHeadMessageId`，增加可选、常量大小的 `headReplacement` 证明摘要；服务端在同一一致性读视图内验证，最多追溯 256 条替换边。不得下发旧正文或无界完整链，也不新增任意历史消息查询接口。
- 此支撑已实现并通过阶段一审查；真实 SQLite／Fastify／构建 CLI 的证据见实施记录。完整契约见[证明设计](04-head-replacement-proof.md)。

## 需求与验收追踪

| 需求 ID | 主题 | 权威设计 | 验收组 |
| --- | --- | --- | --- |
| REQ-NATURAL | 全命令移除 JSON，必要诊断不丢失 | 需求、输出契约 | ACC-COMMAND、ACC-DIAGNOSTIC |
| REQ-STREAM | assistant 前缀增量，正文不重复 | 状态机与渲染 | ACC-RENDER |
| REQ-ID | 终态后显示消息 ID，无草稿 ID 旁路 | 输出契约 | ACC-ID |
| REQ-REPLACE | 可证明的同 Run 重试继续观察 | 状态机、替换证明 | ACC-PROOF、ACC-RECONCILE |
| REQ-READ-RETRY | 监听读请求有界重试 | 只读请求重试 | ACC-RETRY |
| REQ-SELECTION | 保持 last/after、固定 Run、idle 语义 | 状态机 | ACC-SELECTION |
| REQ-LIFETIME | 背压、取消、时限及结果完整性 | 输出、状态机、请求重试 | ACC-LIFETIME |
| REQ-FINAL-DRAIN | 结构协调让出查询，目标终态后两 pass 有界收尾 | 状态机 FinalDrain、证明、请求重试 | ACC-FINAL-DRAIN |
| REQ-SCOPE | 最小变更，不改内部控制面与安全边界 | 需求、实施计划 | ACC-SCOPE |

## 事实核查入口

- [CLI 命令注册：runCli](../../../packages/cli/src/program.ts)
- [监听入口：observe / followMessages / followSend](../../../packages/cli/src/follow.ts)
- [协调状态：FollowState](../../../packages/cli/src/follow-state.ts)
- [增量渲染：MessageRenderer](../../../packages/cli/src/message-render.ts)
- [监听输出：FollowOutput](../../../packages/cli/src/follow-output.ts)
- [消息投影与历史选择：parseMessage / projectMessage / selectHistory](../../../packages/cli/src/messages.ts)
- [API 读取：SqliteMessageQuery.getTimeline / getMessage](../../../apps/api/src/modules/agent/read-side/sqlite-message-query.ts)
- [替换事务：replaceStreamingAssistant](../../../apps/api/src/modules/agent/agent-message.store.ts)
- [Worker 重试：replaceAssistantForRetry](../../../apps/agent-worker/src/runtime/runner.ts)
- [共享消息契约](../../../packages/shared/src/contracts/agent-message.ts)
- [原 CLI 设计](../0035-awb-cli-agent/README.md)
