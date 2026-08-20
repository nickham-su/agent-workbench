# 第一阶段：基线与最小 testkit 起步 + Read-side / Prompt 结构治理

> 状态：阶段性实施方案初稿，待评审。
> 上位依据：[`../0006-Agent模块结构治理总方案/`](../0006-Agent模块结构治理总方案/)。
> 行为基线：[`../0005-Worker-API读侧与生命周期治理/`](../0005-Worker-API读侧与生命周期治理/) 已完成并验收的 read-side contract 与 prompt cache 语义。
> 定位：0006 总体蓝图下的第一阶段方案；两部分一起设计，实施、测试、审查和回滚必须分步完成。

## 快速结论

本阶段建立第一套可复用的 Agent 职责域迁移模式：先用时间受限的最小 testkit 冻结行为并提供测试地基，再把 API 侧 Read-side / Prompt 规则从 `AgentService` 的跨域聚合中收敛为显式职责边界。

```text
1A  基线与最小 testkit 起步
    冻结现状证据
    建立最小 fixture / fake runtime / teardown
    迁移少量代表性测试证明 testkit 可用

    独立测试、审查、复审通过
                    ↓
1B  Read-side / Prompt 结构治理
    建立 read-side / prompt 组件
    保留 AgentService facade 与 Route/Worker 合同
    迁移 execution-profile / prompt-context / messages-context
    保持 prompt cache、消息投影与动态 payload 语义
```

1A 是 1B 的前置使能。P3 开始前，P0 基线记录、P1 最小公共面、P2 代表性迁移与 1A 独立复审必须全部完成并冻结；任一项缺失时不得进入 1B。

P3-P6 只允许增加当前职责域私有的测试 helper。若需要修改 testkit 已冻结的公共导出、fixture 生命周期、默认语义、fake runtime 合同或生产测试 seam，必须暂停 1B，回到 1A 边界补充证据、测试并重新审查；不得以“顺手补 helper”绕过门禁。

## 本阶段纳入

### 1A

- 复核并记录本阶段关键代码、合同、测试命令和 cwd 约束；
- 建立 API Agent 专属的最小测试支持边界；
- 统一临时目录、SQLite、基础 `AppContext`、`createApp()`、workspace/repository 与 teardown；
- 提供最小 fake runtime，记录 enqueue/cancel 调用并支持受控失败；
- 迁移少量代表性测试，证明公共 fixture 没有隐藏真实 HTTP、DB 或进程边界。

### 1B

- `execution-profile`、`prompt-context`、`messages-context` 的 API 应用层职责；
- prompt messages、system prompt、skills、tool projection、pending tools、locale、compaction snippet 等读取与组装；
- `runPromptStaticCache` 的封装与既有生命周期；
- `AgentService` facade 委派和 `agent.module.ts` 装配；
- 与本域相关测试的领域化迁移，同时保留 Shared contract、Route 和真实 API-managed Worker 证据。

## 明确排除

本阶段不得顺手纳入：

- 新增或扩大 Shared internal contract；
- `archive/search`、`archive/read` 的协议或结构治理；
- Context Writeback、artifact 写入、late fence；
- run lifecycle、cancel、recovery、enqueue failure；
- subtask、orphan、archive sidecar；
- Route 全面拆分或 `AgentService` 全量拆分；
- Worker `runner.ts` / builtin tools 主控制流治理；
- Plugin / MCP / Git environment 深度治理；
- 数据库 schema、HTTP/IPC contract、文件格式或 UI 行为变更。

## 不变基线

本阶段默认只做结构迁移，以下语义必须保持：

- `AgentApiEndpoints` 中三个 read-side endpoint 的 method/path；
- Shared request/response schema、唯一公开入口和 Worker success runtime validation；
- 现有 400/401/404 与鉴权顺序；
- execution profile 对 run/session/workspace 的归属校验和 profile 选择；
- prompt/messages 的顺序、过滤、动态 content、locale fallback、tools/pendingTools 与 external skill roots；
- `runPromptStaticCache` 的 runId key、TTL、Promise reuse、访问续期、terminal clear 和 static/dynamic 划分；
- API-managed Worker、本地 fallback runtime 与现有调用入口。

任何需要改变上述行为的发现都触发暂停和设计更新，不得以重构名义混入。

## 文档结构

| 文件 | 内容 |
|---|---|
| [01-overview-and-scope.md](./01-overview-and-scope.md) | 背景、目标、阶段关系、范围、非目标和完成定义 |
| [02-baseline-and-evidence.md](./02-baseline-and-evidence.md) | 当前代码、合同、cache、测试与运行基线 |
| [03-testkit-foundation-design.md](./03-testkit-foundation-design.md) | 1A 最小 testkit 能力、边界、退出条件和禁止项 |
| [04-read-side-prompt-design.md](./04-read-side-prompt-design.md) | 1B 目标职责、依赖方向、迁移策略和不变量 |
| [05-implementation-plan.md](./05-implementation-plan.md) | 分批实施顺序、批次边界、审查和暂存门禁 |
| [06-testing-review-acceptance.md](./06-testing-review-acceptance.md) | 测试矩阵、独立审查、回滚与验收标准 |
| [07-code-map.md](./07-code-map.md) | 关键路径、符号、调用链与候选改动面 |
| [08-risks-and-stop-conditions.md](./08-risks-and-stop-conditions.md) | 风险、停止条件、回退原则和后续边界 |
| [09-implementation-record.md](./09-implementation-record.md) | P0 基线索引、批次运行结果、审查结论与方案偏差记录 |

## 规范性约定

- “必须”表示本阶段设计、实现、测试和审查共同遵守的要求；“不得”表示禁止混入的内容。
- 文中的候选组件名和测试支持路径用于表达职责，不构成最终类名、文件名承诺；实施前可按项目风格微调，但必须同步代码地图和理由。
- 每个实施批次都遵循：实现 → 测试 → 独立审查 → 修复 → 独立复审 → 经用户允许后暂存 → 下一批。
- 发现当前代码与本方案基线不一致时，先暂停并更新设计证据，不直接按旧认知编码。

## 完成定义

本阶段只有在以下条件同时满足时完成：

- 1A 已按退出条件结束，没有形成长期独立 testkit 工程；
- 1B 的 read-side / prompt 权威实现已进入明确职责边界，`AgentService` 仅保留兼容委派；
- 三项 read-side Shared contract、Route、Worker client 和 runtime validation 均无漂移；
- prompt cache 与模型输入相关语义有冻结测试证明；
- 大型综合测试中的本域用例已按计划迁移或明确保留理由，真实集成证据仍存在；
- 相关 build、typecheck、Shared/API/Worker 测试与必要 UI 验收通过；
- 每批均通过独立审查和复审；
- 排除项未被混入。
