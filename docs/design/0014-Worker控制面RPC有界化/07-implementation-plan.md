# 开发任务拆分与详细实施步骤

## 全局节奏

固定节奏：

```text
基线复核
  → 冻结/补测试 seam
  → policy 与 timeout 核心实现
  → 方法分类绑定
  → 配置与部署接入
  → 幂等集成证据
  → 全量回归与手工故障注入
  → 独立代码审查
  → 修复
  → 独立复审
```

原则：

- 每批开始前复核 [02-product-contract.md](./02-product-contract.md)、[03-decisions.md](./03-decisions.md) 和 [05-code-map.md](./05-code-map.md)；
- 发现当前代码与设计基线不一致，暂停编码并更新文档/测试证据；
- 每批只修改授权文件和必要测试；
- 不处理当前工作区已有的前端用户修改；
- 不执行 `git add/commit/push/reset/checkout`，除非用户另行明确允许；
- 每批通过独立审查与复审后才算完成，不以“测试通过”替代代码审查。

## P0：基线冻结与冲突复核

### 任务

- 再次列出 `AgentApiClient` 全部 public 方法；
- 逐方法确认调用点仍与本文冻结分类一致；P0 不得自行重分类；
- 特别确认三项外围读仍分别是 MCP 配置快照、plugin runtime snapshot、plugin-host `listTools` 只读发现；
- 复核 `request()` 当前 error/validation 语义；
- 复核 runner abort-like 判定；
- 复核 runner terminal fallback 最大调用次数；
- 复核 subtask parent tool unique/reuse；
- 复核 completeRun terminal/event idempotency；
- 复核 Docker Compose 环境注入规则；
- 记录当前相关测试命令和基线结果。

### 产物

- 更新后的代码地图行号；
- 方法分类表无遗漏；
- 现有测试基线；
- 所有暂停条件均未命中，或已提交设计变更评审。

### 完成条件

- 不修改生产逻辑；
- 能说明每个可重试写的安全依据；
- 能说明 timeout 如何避免被视为取消；
- 能说明最坏 attempts/耗时。

## P1：测试设施与配置解析

### 任务文件

```text
apps/agent-worker/src/config/env.ts
必要的 env test
apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

- 为本地 HTTP test server 增加 async/hang/body-hang/socket cleanup 能力；
- 增加可记录 attempts 的 handler；
- 增加 logger recorder；
- 设计短 timeout/sleep 注入 seam；
- 在 `WorkerEnv` 增加两个 timeout 字段；
- 以 `loadWorkerEnv()` 为唯一默认值权威，添加默认值、合法值和非法值测试；
- 暂不绑定所有生产方法 retry，先让测试设施稳定。

### 禁止

- 不用真实 15 秒等待；
- 不用无法清理的永久连接；
- 不为测试引入大型 DI 框架；
- 不把 `0` 当作测试便利开关。

### 审查重点

- 测试 server 在失败时也能关闭；
- seam 不泄漏到 public product API；
- env 默认与文档一致。

## P2：错误实体与单次 Attempt Timeout

### 任务文件

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

- 定义 `InternalRpcTimeoutError`；
- 定义安全的 HTTP/network/invalid-response error；所有逃逸 error 的 message/字段不得包含 body、服务端 message/code 或原始 cause；
- 定义 retry reason 分类；
- 抽取单次 attempt；
- 记录 `knownHttpStatus`，冻结“非 2xx status 优先于错误 body 失败/timer”的分类；
- attempt 开始时创建 controller/timer；
- `fetch` 使用 signal；
- 将 success/error body 消费纳入同一 timer；
- 在 finally 清 timer；
- 本地 timeout 后转换为自有 error；
- 保持 `409 + conflictAsError` 的固定 `ApiConflictError` 类型与安全 message；
- 保持非 `2xx` HTTP 失败语义与 strict/warn validation，但不保留任何由服务端 body 派生的 error message/code；
- 迁移“包含服务端 body 的旧错误文本”为安全元数据错误；
- 增加 headers 前 hang、body hang、timer cleanup 测试；
- 增加 timeout 不被 abort-like 判定的测试。

### 完成条件

- 单次 attempt 一定有界；
- 尚未启用 retry 也不能无限 pending；
- 正常路径和既有错误合同回归通过。

### 暂停条件

如果只能用 `Promise.race` 返回而无法终止底层 fetch，停止并修正；不得带着资源泄漏进入 P3。

## P3：命名 Policy 与 Retry 循环

### 任务文件

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

- 定义 `controlRead/controlWrite/subtaskStart/runComplete`；
- 定义固定 300ms 退避；
- 实现最多 `maxRetries + 1` attempts；
- 只允许五种 retry reason；
- 每次 attempt 使用新 controller；
- retry 使用相同 request 语义；
- 实现 timeout/retry/recovered/failed 日志；
- 增加 502/503/504、network、4xx、500、JSON/schema 矩阵测试；
- 增加“502/503/504 body 失败/hang 仍按 status retry；其他非 2xx body 失败/hang 不 retry”测试；
- 增加 off-by-one 与总 attempts 测试；
- 确保日志不接收 body/raw error。

### 完成条件

- `maxRetries=1` 精确等于最多两个 attempt；
- 读策略最坏有界；
- 普通写策略可配置但尚未全部绑定时不误 retry；
- 正常成功无新增日志。

## P4：Public 方法显式分类绑定

### 任务文件

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

- 按策略矩阵绑定九个读类方法；
- 绑定四个普通写；
- `startSubtaskRun` 绑定特殊策略；
- `completeRun` 绑定 5s 特殊策略；
- 为 plugin execute、archive、git-env 建立明确排除表达；
- 增加 policy map/行为表驱动测试；
- 确保未来新增 public method 会迫使分类测试失败或代码审查明显发现。

### 审查重点

- `getAgentMcpSettings` 仍只读 API MCP 配置；
- `getPluginRuntimeSnapshots` 仍只读 API runtime snapshot；
- `listPluginTools` 仍只调用 plugin-host `listTools`，没有 execute 副作用；
- `executePluginTool` 未被误套；
- `compactContext` 未 retry；
- 方法没有遗漏 policy 或隐式无限等待。

### 暂停条件

发现代码已偏离冻结分类时，暂停并更新设计；不得由实现者临场改变 policy。

## P5：启动与部署配置接入

### 任务文件

```text
apps/agent-worker/src/main.ts
docker-compose.yml
.env.example
docs/README.zh-CN.md
必要的英文文档（若当前项目要求同步）
```

### 实施步骤

- `main.ts` 将两个配置传给 client；
- Compose 使用空默认显式透传两个变量，不重复定义运行时默认；
- `.env.example` 给出示例值并指向 `loadWorkerEnv()` 权威默认；
- README 解释两变量不影响模型 timeout；
- 验证容器内 `printenv` 可见；
- 验证 worker child env 继承；
- 验证未设置时默认生效。

### 完成条件

- 本地源码、构建产物、Docker Compose 三种路径配置一致；
- 只有 Worker `loadWorkerEnv()` 定义运行时默认，API/Compose 不定义第二套默认；
- `0` 无法启动 worker。

## P6：`startSubtaskRun` 幂等集成证据

### 任务文件

```text
优先扩展现有 subtask integration test
必要时扩展 apps/agent-worker/src/runtime/apiClient.test.ts
```

### 实施步骤

- 构造首次服务端提交成功但客户端未确认；
- 重试同一 parent/tool 请求；
- 断言返回 reused child；
- 断言数据库只有一个 child run/session 关系；
- 断言 seed items 不重复；
- 断言新 child 不被递归执行两次；
- 运行 new/fork/existing 全量回归。

### 暂停条件

如果 existing/reuse 无法覆盖响应丢失，取消 `startSubtaskRun` retry，更新设计；不得通过扩大 unique catch 猜测修复。

## P7：`completeRun` 幂等与 Runner 收敛证据

### 任务文件

```text
现有 lifecycle integration test
apps/agent-worker/src/runtime/apiClient.test.ts
现有 runner terminal/cancel test
```

### 实施步骤

- 模拟首次终态已提交但响应丢失；
- 第二次 complete no-op；
- 断言 event 只一次；
- client 层验证最多两 attempts；
- runner 层通过 client 诊断或等价 seam 验证 fallback 后总 client 逻辑 attempts 不超过四；短 timeout 下不得以服务端 handler 的收到次数反推该值；
- 全失败时验证 `processRun` settle；
- 验证 activeCount/runningSessions 释放；
- 验证 timeout 为 failed 而非 cancelled。

### 完成条件

- 5s policy 独立生效；
- 约 20.6s 理论上限有测试证据；
- stale running 边界在测试名/注释/验收报告中准确说明。

## P8：回归、故障注入与文档核对

### 自动测试

- Worker apiClient；
- Worker env/config；
- runner cancel/terminal/model retry；
- subtask integration；
- lifecycle integration；
- Agent Worker/API 相关 typecheck/build；
- 项目要求的根测试。

### 手工/受控故障注入

- prompt-context headers 前 hang；
- prompt-context body hang；
- write completed 后下一轮 prompt-context hang；
- subtask status/result hang；
- completeRun hang；
- worker 仍能处理后续任务或槽位已释放。

### 文档核对

- 策略矩阵与代码一致；
- 默认值与 Compose/.env/README 一致；
- 日志字段与文档一致；
- 非目标没有被混入；
- 代码地图行号更新。

## P9：独立代码审查

审查者必须独立检查：

- 生产代码；
- 全部新增/修改测试；
- 配置与部署文件；
- 本设计合同；
- `git diff` 中是否混入用户前端修改。

审查输出至少包含：

- 是否通过；
- 阻断问题；
- 一般问题；
- 范围偏差；
- 测试缺口；
- 敏感信息风险；
- 与本文不一致之处。

不得由实现者用自我总结替代独立审查。

## P10：修复与独立复审

- 阻断和合理的一般问题必须修复；
- 不合理审查意见需记录取舍，并在需要扩大范围时向用户请示；
- 修复后重新运行受影响测试和完整关键回归；
- 委派独立复审，重点检查原问题是否真正关闭、是否引入新范围偏差；
- 复审未通过继续修复，直到通过或用户明确接受剩余风险。

## 每批完成报告模板

```text
批次：P?
修改文件：...
冻结决策：...
测试：命令 + 结果
已知边界：...
独立审查：通过/不通过
修复：...
复审：通过/不通过
```

不得声称运行过未实际执行的命令。

## 最终交付清单

- 实现 diff；
- 测试结果；
- 故障注入证据；
- 配置说明；
- 独立审查报告；
- 修复与复审报告；
- 准确的验收声明：

```text
Worker → API 控制面 RPC 已有界化；
安全请求仅做一次有限重试；
异常可诊断；
Worker 槽位可有界释放；
worker crash/OOM、工具本体和 stale run watchdog 不在本次交付范围。
```
