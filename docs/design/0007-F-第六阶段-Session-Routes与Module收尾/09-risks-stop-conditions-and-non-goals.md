# 风险、停止条件、兼容性与非目标

## 主要风险与控制

| 风险 | 表现 | 控制 |
|---|---|---|
| send transaction 弱化 | Session 层自行 append/create run/update state | 只调用 Lifecycle start capability；真 SQLite transaction tests |
| 错误顺序漂移 | empty/running/profile 等先后变化 | P0 characterization；逐项比对 status/code |
| fork/subtask 语义回退 | 共用 materializer 时公开了 subtask 或继承错误 lineage | 继承 0008 真值表；Subtask 只拿窄 port |
| revert 副作用漂移 | route 仍 sequencing，或未来 runtime 抛错导致成功 revert 变 5xx | application defensive catch + warn；DB-first best-effort；fake runtime fault test |
| Query/Writeback 反向依赖 | 为 artifact 方便直接调用 writeback | architecture test；共同依赖 artifact port |
| Query owner 再次模糊 | status/tail 经 Peripheral Query 转发，或 recent/agents 混入 Context Query | 固定 owner matrix；禁止两个 application 互持完整对象 |
| 错误映射混合 | application 与 route 随意各翻译一部分 domain error | application 直接抛 `HttpError`；route 仅冻结 generic/transport bridge |
| artifact 授权弱化 | 只凭全局 item/toolCallId 读文件 | visible transcript query tests |
| 机械拆 routes | 文件变多但 handler 仍做业务 | route source review + application fake-port tests |
| facade 永久膨胀 | 新逻辑继续进入 facade | facade import/method architecture test；新功能归属规则 |
| startup coordinator 膨胀 | 包含 SQL、TTL、sidecar、recovery policy | 只注入三类 startup capability；source import guard |
| 为清 Store import 破坏原子性 | 把 adapter transaction 拆成普通 CRUD | 允许命名 SQLite adapter 继续 import store |
| process lifecycle 漂移 | Worker/Plugin Host start/stop 时机改变 | module wiring/integration characterization |
| 外围 endpoint 被核心化 | Feishu/Plugin 规则污染 Session/Query | Peripheral route/adapter 独立分组 |
| 过度抽象 | 大量一函数 interface、registry、DI | 只在测试替身/依赖方向有收益时提取 |

## 强制停止条件

出现以下情况必须停止当前批次，补充调研或与用户讨论，不得自行猜测：

- 最新代码与本方案的 send/revert/startup 顺序不一致，且无法由既有测试判定权威行为；
- 迁移 Session/Fork 时必须改变 `0008` 的 primary/subtask、lineage/depth 或 clone 语义；
- 迁移 fork 时发现必须改变 `0007-E` archive append/rollback/fault seam；
- Context Query 拆分必须修改 public response、错误码、分页语义或 Artifact 格式；
- startup coordinator 无法保持 fail pre-listen / recover onListen 或 process start 顺序；
- route 分组要求修改 Shared contract 或外围调用方协议；
- 需要新增 DB schema、全局 DI、event bus、outbox 或跨进程一致性机制；
- 发现用户未知的工作区变更与本阶段文件重叠；
- 全量回归出现无法解释的 Worker/Plugin/Web 行为变化。

## 兼容性原则

### API/HTTP

- path/method/schema/status/code 保持；
- application 可以直接抛 `HttpError`，其既有 status/message/code 原样传播；
- route 仅保留 status summary generic 500 等已冻结 bridge，不统一翻译 domain error；
- body-key guard 与 token/plugin identity 顺序保持；
- SSE event 兼容；
- 不新增分页字段或改变 null/optional 形态。

### 数据与事务

- DB schema 不变；
- lifecycle/fork/revert 原子 helper 不被拆弱；
- no data migration；
- 不批量改历史 session/run/context。

### Filesystem

- Artifact 和 Archive path/format 不变；
- no-follow/realpath/containment 保持；
- 不新增通用文件 endpoint。

### 运行时

- runtime enqueue/cancel 与 DB 顺序保持；
- 当前本地 cancel 同步无抛错路径、远端 cancel 内部吞错并 warning 的观察事实保持；
- revert application 必须 defensive catch + warn，未来 runtime 抛错也不改变成功 revert HTTP 语义；
- startup fail/recover mode 保持；
- Worker/Plugin Host 进程协议与生命周期保持。

## 非目标

- Agent 新业务能力或 UI redesign；
- Context Query Shared contract 全面统一；
- archive search/read Shared contract 统一；
- Worker Runner、tool loop、auto-compaction 重构；
- Plugin/MCP/Git environment 深度领域治理；
- 通用 transport/process abstraction；
- 通用 repository、CQRS framework、event sourcing；
- 完整 Store 文件物理拆分；
- 性能优化项目。

## 后续方向

本阶段通过后，`0006` API Agent 核心结构治理基本完成。后续可按独立触发条件评估：

- Worker 结构治理；
- archive read Shared contract；
- Peripheral Plugin/MCP/Git environment 独立模块治理；
- `agent.store.ts` 的按域物理导出整理；
- 真实性能热点优化。

不得在本阶段为了“顺手完整”提前实施这些方向。
