# API 与前端方案

## 公开接口

唯一范围型 Dashboard 接口：

```text
POST /api/analytics/dashboard/query
```

API 主进程只做认证、TypeBox/运行时校验、IPC 转发和受控错误映射；**所有 `analytics.sqlite` SQL 只能由 Analytics 子进程执行。**不保留范围型 Dashboard GET 子接口，不建设可复用的服务端 `rangeId` 上下文，也不接受 Workspace、Provider、Model、Repo、作者或路径筛选。

## 请求合同

```ts
type RangeKind =
  | 'preset_24h'
  | 'preset_7d'
  | 'preset_30d'
  | 'preset_90d'
  | 'custom';

type DashboardQueryRequest = {
  rangeKind: RangeKind;
  timezone: string; // runtime 验证 IANA
  from?: number;    // 仅 custom 必填，UTC Unix ms 安全整数
  to?: number;      // 仅 custom 必填，UTC Unix ms 安全整数
};
```

请求不接收本地时间字符串。客户端先按 IANA timezone 解析为 UTC ms；本地不存在/歧义时间无法解析时不发请求。服务端负责 IANA 分桶和 DST 边界。

| 无效条件 | HTTP 400 受控错误码 |
| --- | --- |
| 非法 rangeKind、preset 携带 from/to、custom 缺少 from/to、非安全整数、`from >= to` | `ANALYTICS_RANGE_INVALID` |
| custom 超过 366 天 | `ANALYTICS_RANGE_TOO_LARGE` |
| 非法 IANA timezone | `ANALYTICS_TIMEZONE_INVALID` |
| custom `to` 晚于 reportingLag anchor | `ANALYTICS_RANGE_NOT_READY` |

## TypeBox 判别联合

共享契约在 `packages/shared/src/contracts/*` 用 `Type.Union([...])` 和 `Type.Literal(...)` 表达下列判别联合；不得用单一平面 Object + 可空字段表达。

```ts
type AnalyticsDomain =
  | 'model' | 'run' | 'execution' | 'agent_duration'
  | 'tool' | 'message' | 'session' | 'worker' | 'git';

type PartialReason =
  | 'coverage_gap'
  | 'range_not_reconciled'
  | 'collector_degraded'
  | 'signal_loss'
  | 'dirty_hour'
  | 'open_fact'
  | 'configuration_changed'
  | 'repo_not_ready'
  | 'range_before_coverage'
  | 'scan_stale'
  | 'mixed_repo_coverage';

type UnavailableReason =
  | 'domain_disabled'
  | 'domain_unavailable'
  | 'no_safe_data'
  | 'no_ready_repo'
  | 'invalid_metric_state';

type ComparisonResult =
  | { status: 'available'; delta: number; kind: 'relative' | 'percentage_points' }
  | { status: 'range_too_large'; delta: null; kind: null }
  | { status: 'previous_not_covered'; delta: null; kind: null }
  | { status: 'previous_zero'; delta: null; kind: null }
  | { status: 'domain_unavailable'; delta: null; kind: null }
  | { status: 'not_applicable'; delta: null; kind: null };

type MetricResult<T> =
  | {
      status: 'available'; value: T; completeness: 'complete'; dataIncomplete: false;
      requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    }
  | {
      status: 'partial'; value: T; completeness: 'partial'; dataIncomplete: true;
      partialReason: PartialReason; requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    }
  | {
      status: 'unavailable'; value: null; dataIncomplete: true;
      unavailableReason: UnavailableReason; requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    };

type PanelResult<T> =
  | {
      status: 'available'; data: T; completeness: 'complete'; dataIncomplete: false;
      requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    }
  | {
      status: 'partial'; data: T; completeness: 'partial'; dataIncomplete: true;
      partialReason: PartialReason; requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    }
  | {
      status: 'unavailable'; data: null; dataIncomplete: true;
      unavailableReason: UnavailableReason; requiredDomains: AnalyticsDomain[]; comparison: ComparisonResult;
    };
```

`available` 和 `partial` 必须有非 null 值；`unavailable` 必须为 null。available comparison 才有非 null delta；`previous_zero` 及其他不可比较状态强制 null。TypeBox schema 必须以 `additionalProperties: false`（或等义约束）拒绝把 `partialReason` 塞入 available，或把 available 标为 incomplete 等非法组合。

## 顶层成功与错误响应

成功、非法输入和服务不可用为三个互斥合同：

```ts
type SafeError = {
  code:
    | 'ANALYTICS_RANGE_INVALID'
    | 'ANALYTICS_RANGE_TOO_LARGE'
    | 'ANALYTICS_TIMEZONE_INVALID'
    | 'ANALYTICS_RANGE_NOT_READY'
    | 'ANALYTICS_UNAVAILABLE';
};

type DashboardQuerySuccessResponse = {
  kind: 'success';
  rangeId: string;
  from: number;
  to: number;
  asOf: number;
  timezone: string;
  data: DashboardData;
};

type DashboardQueryErrorResponse = {
  kind: 'error';
  error: SafeError;
};
```

| 情况 | HTTP | Body |
| --- | --- | --- |
| 非法输入 | 400 | `DashboardQueryErrorResponse`，不含伪造 range 元数据 |
| Analytics 整体不可达、崩溃或查询超时 | 503 | `DashboardQueryErrorResponse`，`ANALYTICS_UNAVAILABLE`，不含 range 元数据 |
| 合法请求 | 200 | `DashboardQuerySuccessResponse`，始终含 range 和全部子资源结果 |

合法请求的单 Domain 异常仍为 200，且只以相应 Metric/Panel 的 partial/unavailable 表示。错误 schema 不包含 message、stack、SQL、路径、SHA、payload 或原始异常。

## DashboardData 与例外块时间

`DashboardData` 包含概览卡片、共享趋势、Run/Agent/Message/Tool/Model/Git/Worker 历史 Panel、监控数据量和 `exceptions`。全部范围型资源共享成功响应的 `from/to/asOf`。

```ts
type GitHeatmap180d = PanelResult<GitHeatmap> & {
  from: number;
  to: number;
  asOf: number;
  readyRepoCount: number;
  totalRepoCount: number;
};

type WorkerLiveSnapshot = MetricResult<WorkerSnapshot> & {
  snapshotAt: number | null;
  asOf: number;
};

type DomainHealth = PanelResult<DomainHealthRow[]> & {
  diagnosedAt: number;
  asOf: number;
};

type DashboardExceptions = {
  gitHeatmap180d: GitHeatmap180d;
  workerLiveSnapshot: WorkerLiveSnapshot;
  domainHealth: DomainHealth;
};
```

- Git heatmap 固定最近 180 个 IANA 本地日，有自己的 `from/to/asOf`。partial 原因只能是 `repo_not_ready`、`range_before_coverage`、`scan_stale` 或 `mixed_repo_coverage`；后端不传自由错误文本。
- Worker snapshot 是实时例外块，`snapshotAt` 可能晚于或早于 Analytics DB `asOf`，前端必须分别显示；过期时按判别联合返回 partial/unavailable。
- Domain health 的 `diagnosedAt` 是同一 Analytics 查询流程的诊断时刻，并明确关联响应 `asOf`；行中包含 expected/active slot-generation 状态和 coverage gap 摘要。查询必须用 gap 相交、stale 与开放 gap 阻止完整/零值认证。Analytics DB 相关例外块和范围资源尽量同一只读事务快照生成。

## 监控数据量元数据

```ts
type MonitoringVolumeData = {
  count: number;
  metricDefinitionVersion: 'dashboard_collected_fact_v1';
  collectionConfigVersion: string;
  configuredDomainsAtAsOf: Array<
    'run' | 'session' | 'message' | 'tool' | 'execution' | 'model' | 'worker' | 'git'
  >;
  configurationChangedWithinRange: boolean;
};
```

- 定义版本固定八个 Fact Domain，且留存内已采集 Fact 永远按 `collected_at` 计数。
- 后端按 `analytics_domain_config_version.effective_at` 计算每个八域 Fact Domain 在请求 `[from,to)` 的启用片段。仅对启用片段要求 coverage、`reconciledThrough` 和无相交 coverage gap；整个范围未启用的 Domain 不构成该范围完整性要求。
- 任一启用片段不可认证时，监控数据量按既有判别联合返回 partial/unavailable。已采集 Fact 计数不因之后停用而重解释。
- `collectionConfigVersion/configuredDomainsAtAsOf` 仅描述 asOf 配置，不能解释整个历史范围；范围内启停只设置 `configurationChangedWithinRange=true`，不提供 configSegments。
- asOf 未启用 Domain 从当前健康期待排除但 health 仍显示 `disabled`；agent_duration 始终随 execution，且不是监控数据量 Fact Domain。

## 前端行为

前端页面的结构、视觉和交互实现必须参考 [`docs/prototype/dashboard.html`](../../prototype/dashboard.html)。原型只提供 UI 基线，演示数据不得进入生产实现；数据口径、可用性状态和 API 行为仍以本正式方案为唯一合同。

- Workbench 壳内首次进入选择 `preset_7d`；每次刷新只发一个 POST，以 success `rangeId` 防止旧响应覆盖。
- 前端必须按 status 判别渲染，不能补零、二次聚合或缩短范围。partial 展示受控 `partialReason`，unavailable 展示受控 `unavailableReason`。
- Git partial 映射受控枚举为本地文案并标明“已知部分值/下界”、ready/total Repo；不显示后端自由错误文本。
- `configurationChangedWithinRange=true` 时标识“范围内采集配置发生变化”，但不将当前配置误称为历史范围配置。
- comparison 由后端返回驱动；`previous_zero`、`previous_not_covered`、`range_too_large` 不显示 Infinity、NaN 或“新增”。
