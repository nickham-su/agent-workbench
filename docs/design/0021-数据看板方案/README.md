# 数据看板正式方案

## 文档状态

- 本目录是数据看板唯一正式设计和开发合同。
- [`初稿/`](./初稿/) 仅作历史追溯，不作为开发依据。
- 本方案尚未实现；“必须”“不得”均是实施约束。

## 前端 UI 原型基线

- Dashboard 前端 UI 开发必须参考 [`docs/prototype/dashboard.html`](../../prototype/dashboard.html)。
- 原型用于约束页面结构、视觉层级、卡片布局、图表形态、状态展示和已演示的交互行为。
- 原型中的数据均为演示数据，不得被视为 API、Schema 或指标口径实现。
- 若原型与本目录正式方案在数据口径、状态语义、安全边界或 API 合同上冲突，以本目录正式方案为准，并同步修正原型后再开发。

## 最终架构

```text
业务 API / Agent Worker / Local Fallback / Worker observer / Git
        │
        ├─ 业务 SQLite 旁路只读轮询：Run / Session / Message / Tool
        └─ 非阻塞 Signal：Execution / Model / Worker + 监督控制消息
                                      │
                                      ▼
                       独立 Analytics 子进程（唯一 SQL 执行者）
                                      │
                                      ▼
                               analytics.sqlite
```

- **所有 `analytics.sqlite` SQL 和业务 SQLite 旁路只读都只能由 Analytics 子进程执行。**生产者私有 Outbox 不属于 `analytics.sqlite`。
- Analytics 不得改变业务结果、状态、调用顺序或成功条件；队列满、Outbox/checkpoint 故障、Collector busy 或 Analytics 故障只会造成统计降级/已知漏计。
- Model、Tool、Message 使用 UTC 1h Rollup；Run、Execution、Agent Duration、Session、Git、Worker 直接查询 Fact。
- 每个 Rollup 小时只读一个来源：仅完整 closed、`bucket_end <= rollupReadyThrough`、非 Dirty 且 coverage 已建立的小时读 Rollup；其余一律读 Fact。

## Producer checkpoint 与完整性边界

- Signal 生产者身份是 `producer_namespace + producer_id + producer_generation`。监督进程每次实例启动分配不可复用 generation；sequence 仅在 generation 内从 1 递增。
- 监督进程通过非阻塞 register/closing/closed 控制消息和配置 expected slot 共同声明预期生产者。slot 缺少新鲜 generation/checkpoint 时 Domain degraded，不能认证零值。
- checkpoint 至少含 generation、lastSequence、emittedThrough、earliestOpenStartedAt、outboxPending、oldestPendingAt、droppedSinceSequence/lossEpoch、sentAt。
- generation 状态固定为 `registered | closing | closed | stale | abandoned`。仅 closed，或 abandoned 且同一事务已建立 coverage gap，才能移出活跃阻塞集合；stale 仍阻止水位。
- 监督进程确认异常 exit 时必须标记 abandoned 并建立 `[gap_from,null)`；gap 从最后已认证水位（从未认证则 collectionStartedAt）开始，开放 gap 与任意 `to > gap_from` 的范围相交。
- 替代 generation 只在 checkpoint/receipt/outbox/open-Fact 规则认证到 `T` 后才能把 gap 关闭到 `T`。这允许 `T` 之后恢复健康，但 `[gap_from,T)` 永久保留；旧 Outbox 重投可补 Fact，不能自动关闭 gap，也不得重试 Provider。
- Model/Execution 的 open Fact 会把认证水位限制在最早 started_at；`agent_duration` 严格继承 execution。checkpoint 只认证已知链路，不承诺现实无漏计。

## 查询与结果合同

- 一次范围刷新只调用 `POST /api/analytics/dashboard/query`。成功 200 一定返回统一 `rangeId/from/to/asOf/timezone` 和全部子资源；非法输入为受控 400，Analytics 整体不可用为受控 503，二者均不伪造 range。
- `MetricResult<T>` / `PanelResult<T>` 是 TypeBox 判别联合：available 必有完整非 null 数据；partial 必有非 null 已知数据和受控 reason；unavailable 必为 null 和受控 reason。
- 单 Domain 问题只影响所需 Panel；成功响应不因单 Domain 异常整体失败或静默缩短其它范围。
- Git heatmap、Worker live snapshot 和 Domain health 作为同一 200 响应的例外块，分别返回自身时间戳；实时 Worker snapshot 可不同于 Analytics DB `asOf`。

## 监控数据量与留存

- 不可变 `metricDefinitionVersion=dashboard_collected_fact_v1` 统计首次插入的 `run/session/message/tool/execution/model/worker/git` Fact，按 `collected_at` 归属。
- Domain 启停只前瞻性影响新 Fact 采集与健康期待，不重写留存内历史 Fact 计数。响应以 `collectionConfigVersion`、`configuredDomainsAtAsOf`、`configurationChangedWithinRange` 说明配置语义。
- 后端按 `analytics_domain_config_version.effective_at` 切出范围内每个 Fact Domain 的启用片段，仅对启用片段认证 coverage、水位和 gap；任一启用片段不完整即为 partial/unavailable，整段未启用则不构成该范围完整性要求。
- `retentionFloor` 是业务事件时间边界。业务 Rollup 按 `bucket_end <= retentionFloor` 删除，collected Rollup 按自身 collected-at 桶删除，receipt 按 `committed_at` 清理。
- 未可靠结束的 Execution/Model 是 open Fact 留存例外，不能仅按 `collected_at` 删除；Git current generation 不套用非 Git 删除规则。

## Git 安全身份

Git Commit 在 Analytics 中仅用：

```text
(repo_id, commit_identity)
commit_identity = HMAC-SHA-256(installation_secret, repo_id + NUL + raw_SHA)
```

真实 SHA 仅在受控 scan 内瞬时存在。installation secret 首次启用 Git Analytics 时原子创建并长期稳定使用；已有 Git 数据时若密钥缺失/损坏，Git Domain 必须 unavailable/degraded，禁止静默重建。

## 文档导航

- [需求与产品合同](./01-需求与产品合同.md)
- [指标口径](./02-指标口径.md)
- [数据与实体设计](./03-数据与实体设计.md)
- [采集与运行生命周期](./04-采集与运行生命周期.md)
- [聚合与查询算法](./05-聚合与查询算法.md)
- [Git 采集方案](./06-Git采集方案.md)
- [API 与前端方案](./07-API与前端方案.md)
- [边界、安全与恢复](./08-边界安全与恢复.md)
- [验收与测试](./09-验收与测试.md)
- [实施计划](./10-实施计划.md)
