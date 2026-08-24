# 关键决策、取舍与边界

## 决策总表

| 决策 | 结论 | 主要理由 |
|---|---|---|
| 契约包 | 暂不新增 `packages/shared-contracts` | 单用户主力工具，新增 workspace 的迁移成本超过当前收益 |
| 契约位置 | `packages/shared/src/internal-contracts/` | 利用现有构建链，改动小且可形成清晰过渡边界 |
| 导入方式 | 显式 package exports 子路径 | 不污染 shared 根入口，为未来拆包保留迁移点 |
| 第一阶段范围 | 仅 health/enqueue/cancel | 先验证最小闭环，不触碰高频写回和插件链路 |
| 协议目标 | 记录并验证现状 | 重命名或改语义会把兼容改造变成协议重设计 |
| 请求校验 | Worker Server 边界校验 | 让不可信 JSON 在进入 Runner 前被处理 |
| 响应校验 | API Client 关键响应校验 | 在消费方尽早发现 Worker 返回漂移 |
| 动态字段 | 保留 `workspaceRepoDirNames` 宽松输入 | 严格数组会改变现有兼容和清洗行为 |
| 错误 | shared 内部模型提供轻量 `code/message`，既有 HTTP body 保持 message-only | 获得诊断能力，不触发全局错误重构或改变既有错误合同 |
| response envelope | 不引入 `ok/data/error` | 现有 `{ ok: true }` 已满足本阶段需要 |
| 降级 | 临时 `strict/warn` | 给主力工具一根窄保险丝，但不绕过安全边界 |
| 测试 | 分层小规模测试+真实主流程 | 覆盖主要回归风险，控制投入 |

## 为什么不新增独立契约 workspace

`packages/shared` 当前已有 `exports` 和 TypeScript 构建链，但同时包含公共契约、skills 协议和 LLM/AI SDK 依赖。长期看独立契约包更干净；短期新增 workspace 会带来依赖、根脚本、构建和导入迁移，且本阶段只处理三个 Worker endpoint。

因此采取过渡方案：

```text
现有 packages/shared
  -> 新增明确 internal-contracts 子路径
  -> 调用方从子路径迁移
  -> 后续根据实际规模复盘是否拆包
```

不能因为本次方案暂不拆包，就从 `shared` 根入口导出内部契约；根入口只保留现有公共导出。

## 为什么只做 1A

Worker → API 的 run state、completion、failure 和 context append 更接近 Agent 状态机，改造风险高；Plugin Host 只有启用插件时才参与主链路。health/enqueue/cancel 能验证唯一 schema、请求校验、enqueue/cancel response 校验和回滚机制；health 只验证 path 和独立 `{ ok: true }` schema，不接入 Manager ready probe，收益足够覆盖第一阶段目标。

## 为什么不改字段和路径

当前 enqueue 的 `workspaceRepoDirNames` 具有兼容清洗逻辑，且测试明确覆盖了宽松输入。把它收紧为字符串数组会改变既有行为；改名、改 nullable 语义或重设计 response 也会扩大回归面。本阶段把“统一来源”和“协议演进”分开。

## 为什么 response 校验不覆盖所有接口

本阶段 enqueue/cancel 的成功 response 都很小且稳定，可以低成本严格校验；1B 的高频写回接口暂不纳入。health 的真实消费者是 `AgentWorkerProcessManager.waitUntilReady()`，其当前合同是只按 2xx status 判定 ready。为避免同时修改 Unix Socket/fetch 两条 ready 分支、JSON 解析、超时和启动重试语义，本次只统一 health path 常量，并在独立 Worker Server/schema 测试中验证 `{ ok: true }`；不把 health body 校验接入 Manager，也不让 strict/warn 影响 health。`enqueue` request 中的 `workspaceRepoDirNames` 是刻意保留的动态兼容边界，不应为了追求形式上的全类型化而改变现有清洗行为。

`packages/shared/src/contracts/health.ts` 是公共 health 契约，与 Worker 内部 health response 不是同一协议；本次不复用它。

## 为什么保留 strict/warn

项目是单用户主力工具，严格校验误伤时需要快速恢复。`warn` 只允许响应 schema 失败继续，不能绕过 request validation、token、HTTP status 或业务逻辑；配置不进入 UI 和数据库，稳定后删除，避免变成长期产品功能。

## 不采用的方案

### 全面 RPC 框架

当前只迁移三个 endpoint，完整自动生成 client/server 会增加抽象和调试成本，延后到协议规模证明需要时。

### 双协议长期兼容

本次不同时维护新旧 endpoint 或两套 client/server。保留现有路径即可完成迁移，回滚通过小批次回退解决。

### 全局错误 envelope

`ok/data/error` 会波及现有所有内部和公共接口，收益不匹配本阶段目标。

### health body 接入 Manager ready

不采用在 Worker Manager 中解析和校验 health body。真实消费者是 Manager；接入会同时影响 Socket/fetch ready 分支、启动 timeout/retry 和 Worker 可用性判定，收益不足以抵消本阶段风险。

### 全仓 any 清理

本次只处理 1A 边界，普通业务代码的动态类型另行治理。

### 提前纳入 Plugin Host

Plugin Host 生命周期、插件能力和服务 reconcile 与 Worker 控制面不同，提前混入会扩大验收面。

## malformed JSON 与错误 body 的保守决策

当前 `readJsonBody` 的 `JSON.parse` 失败由 Worker Server 外层 catch 转为 `500` message-only body。本次保持该现状；只有 JSON 已成功解析但字段结构不符合 schema 时才返回 `400`。虽然将 malformed JSON 改为 400 在一般 API 设计中更常见，但会改变当前行为且不是本次协议来源统一的必要收益。

同理，本次不把 `code` 写入现有 401/400/404/500 HTTP body。shared errors 的 `code/message` 只用于内部错误模型、日志和未来安全新增路径；不以此声称全局错误系统已统一。

## 允许的实施自由度

开发者可以选择 schema 辅助函数、测试文件命名和内部函数拆分，但不得改变本文件列出的路径、字段、状态和兼容语义。若发现当前代码与文档合同不一致，应先暂停该 endpoint 迁移，补充代码地图和产品合同，不得默默改合同。
