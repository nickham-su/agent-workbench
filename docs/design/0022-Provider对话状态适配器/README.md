# Provider 对话状态适配器

## 文档状态

- 状态：部分实施；本轮仅完成 Phase A/B，Phase C/D 未实施。
- 目标：在不改变普通 transcript 与 Provider 私有状态隔离边界的前提下，将现有 OpenAI Responses 专用的 replay 逻辑演进为轻量 `ProviderConversationStateAdapter`，为 DeepSeek Thinking 及后续有对话续接状态要求的 Provider 提供可审查、可验证的扩展点。
- 读者：负责 shared contract、API、Worker、Provider 接入、测试和代码审查的开发者。
- 本文档是实施、代码审查与验收的共同标准；未在本文档中明确放开的行为，默认不得扩大。

## 结论摘要

- 普通 transcript 与 Provider 私有对话状态必须继续分离。
- Adapter 只管理 Provider 对话续接协议，不接管 Runner 的工具、重试、持久化或 Run 状态机。
- OpenAI 在 Phase A 中必须等价迁移；DeepSeek 是后续独立的 experimental 协议接入，不能混入等价重构。
- DeepSeek 第一版有意将 `reasoning_content` 作为既有 reasoning Part.`text` 保存和展示；私有 state 只保存回放匹配与完整性 metadata。若无法以真实 AI SDK mock SSE 证明该文本是完整原文，Phase C 必须停止并另立私有实体设计。
- DeepSeek 回放范围固定为当前有效链中最后一条 User 消息之后、当前请求之前的兼容 reasoning；Phase D 真实服务联调是升为 stable 的硬门禁。
- 调试日志应记录脱敏后的最终 AI SDK 入参投影，而不是原始 transcript、未脱敏对象或 HTTP body。
- Provider 协议选择必须是最终模型级的显式 `protocolAdapter`；禁止从 `baseURL`、显示名或模型前缀猜测 DeepSeek 等特殊协议。
- DeepSeek 的强完整性保证以 Assistant Message 的不可变协议快照和 `complete-v1` terminal metadata 为前提；两者的存储、回放和完整性边界见 08。
- 本项目当前不保留旧 Agent 数据兼容；Phase C 直接把协议快照纳入目标 schema，并通过现有不兼容 schema 收敛/重建机制应用，不设计旧版本数据库升级或旧二进制回滚。

## 阅读导航

| 文档 | 用途 |
|---|---|
| [01-需求与产品语义.md](./01-需求与产品语义.md) | 背景、术语、业务边界、目标与非目标 |
| [02-方案裁决与架构.md](./02-方案裁决与架构.md) | 方案取舍、架构、调用链与职责边界 |
| [03-接口数据与不变量.md](./03-接口数据与不变量.md) | 接口草案、实体、数据兼容与强制不变量 |
| [04-OpenAI等价迁移与DeepSeek预留.md](./04-OpenAI等价迁移与DeepSeek预留.md) | OpenAI 等价迁移细节、DeepSeek experimental 接入与参数策略 |
| [05-失败矩阵日志与安全.md](./05-失败矩阵日志与安全.md) | 失败策略、重试、日志与敏感数据边界 |
| [06-实施测试验收.md](./06-实施测试验收.md) | 分阶段任务、测试策略、审查标准、验收与回滚 |
| [07-代码索引与证据.md](./07-代码索引与证据.md) | 当前实现的路径、符号、测试与外部资料索引 |
| [08-PhaseC协议快照与完整性闭环.md](./08-PhaseC协议快照与完整性闭环.md) | Assistant 协议快照、DeepSeek terminal metadata 与完整性诊断 |

## 使用约定

- “必须”表示实现、测试和审查均不可放宽的约束。
- “应”表示默认实现；若偏离，变更说明必须列出原因、影响和新增验证证据。
- “草案”只允许按项目代码风格调整命名、文件拆分与 TypeScript 表达；不得改变文档明确的不变量、权限边界和失败语义。
- 代码行号会随演进漂移；审查时优先核对文件、导出符号和行为说明。

## 范围与版本关系

- 本设计以 [0019 OpenAI Responses 加密 Reasoning 回放](../0019-OpenAI-Responses加密Reasoning回放/01-OpenAI-Responses加密Reasoning回放核查.md) 已落地实现为行为基线。
- 目标 schema 版本号由实施时基于仓库当前版本顺延，不在设计中写死；不得复用已被其他变更占用的版本号。
- 本设计不要求修改既有数据库字段 `provider_replay_json` 或内部 API 字段 `providerReplay` 的名称。
- DeepSeek Chat Completions Thinking 的参数、scope、产品可见性和失败策略已在本文档中作出第一版 experimental 裁决；真实服务联调若推翻协议假设，必须按 Phase D 同步修订实现、fixture、验收标准和本文档后才能升级稳定性。

## 阶段门禁

- Phase A（OpenAI 等价提取）已完成：`ProviderConversationStateAdapter` 已等价承接 OpenAI Responses 的 replay 注入、chunk metadata、Attempt 终态协议校验与诊断；不接管 Runner 的持久化、工具、重试或生命周期。
- Phase B（debug 投影）已完成：Assistant debug record 已改为记录最终 AI SDK 入参的安全投影，私有 replay、加密 reasoning、附件、凭证与原始 HTTP/SSE 内容均 fail-closed 脱敏或省略。
- Phase C（DeepSeek Thinking experimental）与 Phase D（真实 DeepSeek 联调）尚未实施。DeepSeek 当前不可用，绝不得标记为 experimental 完成或 stable。
- Phase A（OpenAI 等价提取）与 Phase B（debug 投影）可独立审查和回滚；两者不得夹带 DeepSeek 行为或 schema 变更。
- Phase C 只能在以下事项全部实现并有自动化证据时标记为 **experimental 完成**：Assistant 协议快照、`complete-v1` 完整性 metadata 与强制 flush、experimental UI/产品告知、真实 AI SDK mock HTTP 与 SSE 证据。
- Phase C 缺少任何一项时，不得开放或宣称 DeepSeek Thinking 已完成。
- 只有完成 Phase D 真实 DeepSeek 服务最小联调，并确认 scope、工具回放和参数行为后，才可将该协议标为 **stable**。
- Phase C 开启后如需停止功能，可回滚协议接线或关闭 DeepSeek feature flag、设置/UI 入口；本项目不承诺保留既有 Agent 数据或旧二进制直接读取新 schema。
