# apply_patch 工具与 Prompt Projector 最小改造方案

## 背景

- 当前 `agent-workbench` 已支持 `bash/read/write/subtask/mcp_*` 的工具调用链路,但 `apply_patch` 仍未接入.
- 当前 prompt context 组装逻辑在 `agent.service.ts` 内部集中拼装,工具输入与结果是中心分支直连,新增工具容易继续堆分支.
- 需求目标是同时满足:
  - 保留 `apply_patch.patchText` 进入模型上下文,让模型知道历史操作语义.
  - 不把 `apply_patch` 的 full diff 结果注入模型上下文,避免上下文膨胀.
  - 前端可继续展示完整 diff 细节.

## 目标

- 先完成最小架构改造: 引入可扩展的 tool prompt projector 注册机制(method abstraction).
- 在该扩展点上实现 `apply_patch` 工具,避免在中心逻辑里增加工具特例分支.
- Agent 页面中 `apply_patch` 的 diff 固定为单视图(unified/inline),不改其他模块 diff 体验.

## 已确认决策

- `apply_patch` 不默认加入新 Agent 的默认工具集,需在 Agent Profile 中显式开启.
- `*** Add File:` 遇到已存在文件时允许覆盖.
- 路径策略保持和现有 `read/write` 一致,仅允许相对路径并限制在 workspace 内.
- 模型上下文保留 `patchText` 输入,不裁剪 tool-call input.
- 模型上下文不注入 `apply_patch` full diff 结果,仅注入摘要.

## 总体设计

### 设计原则

- 使用 method abstraction(策略注册),不引入重型类层级.
- API prompt 组装层只负责通用流程,工具特定行为下沉到 projector.
- 存储与展示保留 full result,模型消费走投影结果.

### Prompt Projector 抽象

- 新增注册式策略接口(示意):

```ts
type ToolPromptProjector = {
  projectCallInput: (args: Record<string, unknown>) => Record<string, unknown>;
  projectResult: (result: unknown, status: AgentContextItemStatus) => unknown;
};
```

- 运行时行为:
  - 按 `toolName` 取 projector.
  - 未命中时走 `default projector`(原样透传).
  - `apply_patch` 使用专用 projector.

### apply_patch projector 规则

- `projectCallInput(args)`:
  - 原样返回 `args`.
  - 保留 `patchText` 进入模型上下文.
- `projectResult(result, status)`:
  - 返回摘要对象,包含 `fileCount/additions/deletions/files/text` 等轻量信息.
  - 不返回 `diff/before/after` 等 full payload.

## 代码改造范围

### Phase A: 最小架构改造(先做)

- 在 API 模块新增 prompt projector registry 相关文件(建议目录):
  - `apps/api/src/modules/agent/prompt/tool-projectors/types.ts`
  - `apps/api/src/modules/agent/prompt/tool-projectors/default.ts`
  - `apps/api/src/modules/agent/prompt/tool-projectors/apply-patch.ts`
  - `apps/api/src/modules/agent/prompt/tool-projectors/index.ts`
- 改造 `apps/api/src/modules/agent/agent.service.ts` prompt 组装:
  - tool-call input 从直接读取 `toolItem.output.args` 改为 `projectCallInput(...)`.
  - tool-result output 从直接读取 `toolItem.output.result` 改为 `projectResult(...)`.
  - 其余流程(可见链遍历、toolCallId 关联、terminal 状态过滤)保持不变.

### Phase B: apply_patch 工具接入

- shared contracts:
  - `packages/shared/src/contracts/agent.ts` 增加 `apply_patch`.
  - `packages/shared/src/contracts/settings.ts` 增加 `apply_patch`.
- settings normalize:
  - `apps/api/src/modules/settings/settings.service.ts` 工具白名单允许 `apply_patch`.
- API internal schema:
  - `apps/api/src/modules/agent/agent.routes.ts` builtin tool union 增加 `apply_patch`.
  - `apps/api/src/modules/agent/agent.service.ts` 增加 `toolArgsSchema/toolDescription` 的 `apply_patch` 分支.
- worker runtime:
  - 新增 `apps/agent-worker/src/runtime/applyPatch.ts`.
  - `apps/agent-worker/src/runtime/runner.ts` 增加 `apply_patch` 执行分支.
  - `apply_patch` 归入 write 权限判断链路.

### Phase C: Web UI(仅 Agent apply_patch)

- 在 `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue` 增加 `apply_patch` 专用展示卡片.
- 复用 `apps/web/src/shared/components/MonacoDiffViewer.vue` 展示 diff.
- 对 `apply_patch` 强制 `sideBySide=false`,固定单视图.
- 不改 Code Review 等其他模块的 diff 展示方式.

## apply_patch 协议与执行策略

### 协议兼容目标

- 参数: `patchText`.
- patch 包裹: `*** Begin Patch` / `*** End Patch`.
- 支持头:
  - `*** Add File: <path>`
  - `*** Update File: <path>`
  - `*** Delete File: <path>`
  - `*** Move to: <path>`

### 执行模型

- 采用两阶段:
  - verify 阶段: 解析 + 路径/边界校验 + chunk 匹配 + 目标内容推导.
  - apply 阶段: verify 全通过后统一落盘.
- 错误语义:
  - 使用 `apply_patch verification failed: ...` 风格,便于模型自修复重试.

### 安全约束

- 路径必须是相对路径.
- 最终 realpath 必须位于 workspace 内.
- 拒绝 symlink 路径与越界路径.
- 任一 hunk verify 失败时不得产生部分写入.

## Prompt 与 UI 数据分流

- context item 持久化结果保留 full result(含 per-file diff 等),供 UI 展示和审计.
- prompt context 只使用 projector 输出:
  - 对 `apply_patch`: call input 保留原始 `patchText`.
  - 对 `apply_patch`: result 仅摘要,不注入 full diff.
  - 其他工具默认透传.

## 测试与验收

### API/Prompt 侧

- 验证默认 projector 对现有工具行为无回归.
- 验证 `apply_patch`:
  - tool-call input 中仍可见 `patchText`.
  - tool-result output 为摘要,不含 full diff.

### Worker 侧

- 覆盖 `add/update/delete/move` 正常路径.
- 覆盖 verify 失败无副作用.
- 覆盖路径越界与 symlink 拒绝.

### Web 侧

- Agent `apply_patch` 卡片可展示按文件 diff.
- diff 视图固定为单视图.
- 其他工具与其他模块 diff 体验不变.

## 风险与缓解

- 风险: `patchText` 可能较大,仍会占用上下文 token.
  - 缓解: 先按现有需求保留,后续可在独立上下文预算策略中处理超预算场景.
- 风险: projector 注册遗漏导致行为回落到默认透传.
  - 缓解: 为 `apply_patch` 增加专门测试断言,并在注册表初始化时做校验.

## 里程碑

- 先交付 Phase A(最小架构改造).
- 再交付 Phase B(`apply_patch` 全链路).
- 最后交付 Phase C(UI 单视图体验)与回归测试.
