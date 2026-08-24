# 后续改造建议（独立于 1A 验收）

> 本文件只记录后续方向，不属于本次 API → Worker 1A 的开发、验收或完成条件。除非未来单独立项，不得把这里的建议混入 1A 代码审查。

## 后续顺序

```text
1A 控制面稳定
  ↓
1B Worker → API 写回面
  ↓
Plugin Host 协议
  ↓
根据规模复盘是否拆独立契约包
  ↓
根据重复度决定是否抽 RPC/进程基础设施
```

顺序不是硬性承诺；每一阶段都应先根据主力使用收益和风险重新决策。

## 1B：Worker → API 写回协议

### 内容

- run state 更新
- run completion
- run failure
- context item append
- context head/version 冲突
- compaction 写回
- subtask 状态写回

主要代码范围：

```text
apps/agent-worker/src/runtime/apiClient.ts
apps/agent-worker/src/runtime/runner.ts
apps/api/src/modules/agent/agent.routes.ts
apps/api/src/modules/agent/agent.service.ts
apps/api/src/modules/agent/agent.store.ts
```

### 为什么延后

这些接口调用频率高，并直接影响 run 终态、session head、context 顺序、恢复和并发一致性。1A 先验证共享契约和校验机制，再处理 1B，可以避免一次同时改变控制面、写回面和状态机。

### 进入条件

- 1A 真实主力场景稳定。
- strict 模式无未解释 response validation 告警。
- 1A 的子路径 exports 和测试方式已被证明可维护。
- 能为每个 1B endpoint 明确幂等、重试、冲突和终态语义。

### 实施建议

先处理 run state，再处理 completion/failure，再处理 context append，最后处理 compaction/subtask。每个 endpoint 先盘点真实字段和调用顺序，不先重构 `runner.ts` 或 `agent.service.ts`。

## Plugin Host 协议

### 内容

- Plugin Host health
- 插件加载和 snapshot/reconcile
- Plugin Tool invoke
- Plugin Service start/stop/status
- 插件事件和 SSE 广播
- plugin manifest、能力和生命周期协议

主要代码范围：

```text
apps/api/src/plugin-host/
apps/api/src/modules/agent/agent.plugin-host-client.ts
apps/api/src/modules/agent/agent.plugin-host-manager.ts
apps/api/src/modules/plugins/plugin.services-runtime.ts
plugins/feishu/src/
```

### 为什么延后

Plugin Host 只在插件能力启用时参与主链路，其对象、生命周期、重启和 reconcile 语义不同于 Worker 控制面。提前纳入会扩大协议、测试和真实场景验收范围，也可能迫使本次设计提前决定插件双运行路径。

### 进入条件

- 1A/1B 主链路稳定。
- 明确生产环境是否只允许 Plugin Host，API 进程内动态加载是否仅保留测试/fallback。
- 明确插件 Host 直接访问数据库的边界和生命周期状态。

## 独立 `packages/shared-contracts`

### 建议

当前不新增 workspace。待 internal contracts 规模扩大后再复盘是否拆出纯契约包。

### 触发条件

满足任一项时重新评估：

- shared 的 AI SDK 依赖给 API/Web 带来实际构建、安装或边界问题。
- 1B、Plugin Host 和公共接口都需要稳定复用大量纯契约。
- 子路径 exports 已明显膨胀，shared 根职责继续变模糊。
- 需要独立发布或独立测试纯契约包。

### 延后理由

独立 workspace 需要同步根 workspace、build/typecheck、依赖和导入路径。对当前单用户主力工具，先用现有 shared 的显式 internal 子路径，投入更小、回滚更直接。

## RPC 基础设施

### 可能内容

- 统一 JSON body 读取和大小限制
- 统一 `sendJson`、错误 payload、token 校验
- 统一 HTTP/Unix Socket Client
- 统一 timeout、health probe、socket 生命周期
- Worker/Plugin Host 的 ManagedChildProcess、restart policy、circuit breaker

主要重复位置：

```text
apps/agent-worker/src/server.ts
apps/api/src/plugin-host/server.ts
apps/api/src/modules/agent/agent.worker-client.ts
apps/api/src/modules/agent/agent.plugin-host-client.ts
apps/api/src/modules/agent/agent.worker-manager.ts
apps/api/src/modules/agent/agent.plugin-host-manager.ts
```

### 为什么延后

抽象基础设施有长期收益，但第一阶段只有三个 Worker endpoint；过早抽象可能把协议迁移变成 Server、Client、进程生命周期的大重构。先完成 1A/1B，观察真实重复和边界，再决定最小公共抽象。

### 进入条件

- 至少两个宿主实际使用相同且稳定的行为。
- 已有明确共享错误、body limit、timeout 和 socket 生命周期合同。
- 抽象可以通过适配器迁移，不改变现有重启和关闭行为。

## 其他治理项

以下事项也不属于 1A：

- Agent 巨型文件按 session/run/context/tools/subtask/recovery 拆分。
- Plugin SDK 正式化。
- `packages/shared` LLM/AI SDK 依赖瘦身。
- 根 workspace build/typecheck 覆盖率检查。
- 全仓 `any`、错误格式和跨模块依赖治理。

这些事项成本和收益差异较大，建议等主链路协议稳定后，按实际痛点逐项立项，而不是作为本次协议统一的隐含前置条件。
