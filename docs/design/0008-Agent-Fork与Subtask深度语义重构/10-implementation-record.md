# 实施与验收记录

> 状态：P0-P5 已按本方案实施；阶段级审查/复审和最终全面审查结论应以对应审查记录为准。
>
> 本文件只记录已经实际执行过的命令与可复现结果；不把未执行、失败或因仓库既有测试环境问题无法运行的命令表述为“通过”。

## 实施批次摘要

| 批次 | 已完成内容 | 阶段门禁结论 |
|---|---|---|
| P0 | 冻结二次 fork 旧缺陷、copied item ownership、prompt 深度过滤，并用真实 `createApp()` HTTP 探针确认 schema-only 会静默 strip unknown key、route-local `preValidation` 可在 strip 前拒绝请求。 | 通过 |
| P1 | ordinary primary Run 的消息与 compact 写入固定为 `0/null/null`；删除普通 Run 的 fork lineage 推导；补齐历史 null-depth 新 Run 自愈与 internal trigger 证据。 | 通过 |
| P2 | public 与 generic internal create request 移除 `kind`；以 endpoint-local allowlist 拒绝 unknown field；generic create 固定创建 primary。 | 通过 |
| P3 | public fork 收敛为 `primary -> primary`；抽取私有 context clone 原语；public fork request 移除 `kind`；internal subtask fork 保留私有桥接。 | 通过 |
| P4 | internal subtask `new`、`fork`、`existing` 收敛到专用 private 路径；清理旧通用 `forkSession()` 与 `allowAnyKindBoundary`。 | 通过 |
| P5 | 删除过时的手工 depth/compact 测试；更新 fork 测试语义；更新中英文深度帮助文案；执行跨包回归。 | 通过，适用下述验收口径 |

## P5 代码与文案整理

### 测试语义

- 删除旧测试 `agent run depth 为 root、继续和 compaction 传播`：它通过 direct store 写入模拟 compaction，且“传播”不符合 ordinary primary Run 固定为独立执行根的新语义。
- 保留真实 API 路径的 `primary compact Run 固定写入 depth 0 和双空 parent 字段`，作为 compact 行为证据。
- 将 fork 测试改名为 `primary 上下文 fork 创建独立执行根，不携带来源的 subtask 嵌套深度`。
- 已检索确认：没有测试通过 public create 或 generic internal create 的 HTTP body 传 `kind="subtask"` 来构造 subtask fixture；异常 subtask fixture 使用明确的 store/test helper。

### 用户可见文案

中英文 `maxSubtaskDepth` 帮助文案都已明确：

- 该设置只限制真实 `subtask` 工具调用链；
- 不限制 primary session 上下文被 fork 的次数；
- 每个 primary session 的 ordinary Run 都从 depth 0 开始。

### API 文档/Schema 口径

公开 create、generic internal create、public fork 的 Shared request schema 都不再声明 `kind`，且都使用 `additionalProperties: false`。因此由这些 schema 生成的 API 文档不会再展示已删除的 request `kind` 字段；响应 `AgentSessionRecord.kind` 仍保留。

## 已实际执行并通过的回归

以下命令均在对应 package cwd 中以退出码 `0` 完成。

### Shared

```bash
npm run build
npm run typecheck
find src -name '*test.ts' -print0 | xargs -0 npx tsx --test
```

### API

```bash
npm run typecheck
npm run build
npm run test:integration
npm run test:integration:worker
npx tsx --test \
  src/modules/agent/context-item-contract.test.ts \
  src/modules/agent/agent-run-context.test.ts \
  src/modules/agent/agent.service.facade.test.ts \
  src/modules/agent/agent.worker-client.test.ts \
  src/modules/agent/agent.worker-manager.test.ts \
  src/modules/agent/prompt/*.test.ts \
  src/modules/agent/read-side*.test.ts \
  src/modules/agent/read-side/*.test.ts \
  src/modules/agent/testkit/*.test.ts
```

### Agent Worker

```bash
npm run typecheck
npm run build
npx tsx --test \
  src/runtime/apiClient.test.ts \
  src/runtime/provider-subtask-cancel.test.ts \
  src/runtime/runner.cancel.test.ts \
  src/runtime/tools/providers/builtin.prefork.test.ts \
  src/runtime/tools/providers/builtin.read.test.ts \
  src/runtime/tools/registry.test.ts
```

以上覆盖 internal API client、subtask pre-fork、nested subtask payload、cancel 和 tool registry 等与 0008 有关的 Worker 边界。

### Web

```bash
npm run typecheck
npm run build
npm test
```

### Feishu

```bash
npm run typecheck
npm run build
npm test
```

### 补丁质量

```bash
git diff --check
```

## 未纳入通过门禁的 Worker 全量测试

曾尝试以如下无脚本的枚举命令运行 Worker 所有 `*test.ts`：

```bash
find src -name '*test.ts' -print0 | xargs -0 npx tsx --test
```

该命令**未通过**，不能作为“全量回归通过”的证据。失败情况如下：

| 文件/测试域 | 观察到的异常 | 与 0008 的关系 | P5 门禁处理 |
|---|---|---|---|
| `src/runtime/plugins/runtimeManager.test.ts` | 依赖的 `test/fixtures/plugins/debug-tools/dist/index.js` 不存在；仓库仅包含 fixture manifest、README 与 `package.json`。 | 0008 未修改 plugin runtime、fixture 或 Worker plugin manager。 | 不纳入 0008 阶段门禁；应由 fixture/plugin 测试所属工作流恢复构建产物后单独解决。 |
| `src/runtime/runner.streaming-flush.test.ts` | 单独执行也出现 `Promise resolution is still pending but the event loop has already resolved`，6 个测试均被取消。 | 0008 未修改 runner streaming flush 或 Worker runtime 主控制流。 | 不纳入 0008 阶段门禁；应由该测试/runner 所属工作流单独诊断，不能宣称该文件通过。 |

上述例外不是“忽略失败”：本方案的最终验收口径必须明确为 **0008 改动相关的定向 Worker 测试已通过，Worker 无脚本全量枚举未绿且有已记录的非本方案失败**。在这些独立问题修复前，不得把整个 Worker 测试集合表述为全部通过。

## 最终建议验收口径

可以接受本方案完成的前提是：

1. 本文件列出的 Shared、API、0008 相关 Worker、Web、Feishu 命令均持续通过；
2. 0008 的功能、数据、contract 与质量标准仍满足 [`07-testing-review-acceptance.md`](./07-testing-review-acceptance.md)；
3. Worker 全量枚举命令的两个已知失败被单独记录为仓库问题，既不被伪装为通过，也不以改动 0008 无关 Worker 逻辑的方式在本方案内修复；
4. 若交付要求升级为“整个仓库所有 Worker 测试全绿”，必须先由相关所有者修复或提供 `debug-tools` fixture 构建步骤及 streaming flush 测试稳定性，再重新执行全量 Worker 枚举。

## P5 结果

- 没有数据库 schema migration；
- 没有修改 `PromptStaticAssembler` 规则；
- 没有修改 P0-P4 已通过的领域逻辑；
- 未触碰 `docs/design/0007-B-第二阶段-Context-Writeback与Artifact边界治理/`；
- P5 的未暂存测试与 locale 改动应与本设计目录一起纳入本方案的最终暂存集合。
