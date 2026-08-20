# 分批实施计划

## 固定实施节奏

本阶段整体按 1A → 1B 推进；每个批次内部遵循：

```text
实施前复核
  → 小批实现
  → 定向测试 + 必要回归
  → 独立审查
  → 修复
  → 独立复审
  → 经用户明确允许后暂存该批
  → 下一批
```

1A 与 1B 一起设计，但不得合并为一个大改批次。1A 复审未通过时，1B 不得开始。

## 1A → 1B 硬门禁

P3 只有在以下内容全部完成并冻结后才允许开始：

- P0 已更新 [`02-baseline-and-evidence.md`](./02-baseline-and-evidence.md) 和 [`07-code-map.md`](./07-code-map.md)，相关 characterization/contract 测试已落盘；
- P0 命令、cwd、结果摘要和缺口已记录到 [`09-implementation-record.md`](./09-implementation-record.md)；
- P1 已冻结 testkit 公共导出、默认值、资源所有权、teardown 和 fake runtime 合同；
- P2 已完成代表性等价迁移，1A 最低测试矩阵通过；
- 1A 独立审查发现的问题已修复，独立复审结论为通过；
- 没有未关闭的阻塞问题，也没有以 P3 再补为前提的 testkit 公共面缺口。

### P3-P6 新 testkit 需求处理

发现新需求时先分类：

| 类型 | 处理 |
|---|---|
| 仅当前 read-side 领域测试文件使用、不导出、不改变公共默认值/生命周期 | 作为当前批次私有 helper 处理，随该批审查 |
| 复用现有公共 helper，但只增加显式调用参数且不改变默认语义 | 可在当前批次处理，必须补 testkit 回归并记录 |
| 新增/修改公共导出、fixture 生命周期、默认语义、资源所有权、fake runtime 合同或生产测试 seam | 暂停 P3-P6，回到 1A 边界更新设计/测试/运行记录，并重新执行 1A 独立审查和复审 |
| 需求无法证明为 1B 必需，或只是为未来阶段预建 | 不实施，留给对应后续阶段 |

### “无行为纯 helper”判定

P3 允许移动的“无行为纯 helper”必须同时满足：

- 输出只由显式输入决定；
- 不读取或修改 DB、文件、网络、环境变量、clock、random、cache、logger 或模块级可变状态；
- 不决定 HTTP status/错误文本、归属校验、消息顺序、截断、过滤、序列化或 cache 行为；
- 移动前后可用相同输入输出测试或机械等价审查证明；
- 不扩大导出面，不吸收后续领域规则。

不满足任一条件的 helper 都视为业务迁移，必须放入 P4/P5 对应批次，不得借 P3 提前移动。

## 批次总览

| 批次 | 子阶段 | 目标 | 生产代码 |
|---|---|---|---|
| P0 | 1A | 冻结 read-side/prompt 与测试运行基线 | 不修改 |
| P1 | 1A | 建立最小 Agent testkit | 原则上不修改 |
| P2 | 1A | 迁移代表性测试并冻结 testkit | 不修改或仅必要测试可见 seam，需单独审批 |
| P3 | 1B | 建立 Read-side / Prompt 内部骨架与依赖边界 | 最小新增组件/装配 |
| P4 | 1B | 迁移 execution profile 与 messages context | 修改 read-side 组件和 facade |
| P5 | 1B | 迁移 static prompt/cache 与 prompt context | 修改 prompt 组件和 facade |
| P6 | 1B | 测试领域化、装配收尾与阶段回归 | 删除过渡 helper、最小测试迁移 |

批次可以在实施前基于真实依赖进一步拆小，但不得跨越 1A/1B 门禁，也不得把多个高风险主题合并。

## P0：冻结基线

### 任务

- 复核 `AgentService` read-side/prompt 方法、文件级 helper 和 cache 调用点；
- 记录三个 Shared endpoint/schema/Route/Worker client 的当前对应关系；
- 记录 session/workspace/run 归属、400/401/404 与 terminal run 行为；
- 记录 prompt cache key、TTL、Promise reuse、访问续期、terminal clear、static/dynamic 划分；
- 记录 prompt/messages/profile 的关键字段和输入来源；
- 记录 API/Worker/Shared 测试命令、cwd、运行时长和现有结果；
- 盘点三个 API Agent 测试文件的 fixture 重复和特殊差异；
- 补充缺失的 characterization tests，但不得先移动生产逻辑。

### 交付

- `02-baseline-and-evidence.md` 中更新后的长期行为基线；
- `07-code-map.md` 中更新后的符号、路径和调用链；
- 对应测试文件中的 characterization/contract 证据；
- `09-implementation-record.md` 中的命令、cwd、结果摘要和 P0 门禁结论；
- 缺口测试及其理由、P1 testkit 最小公共交集清单。

### 门禁

如果无法证明 cache、prompt/messages/profile 当前行为，P0 不通过；不得用预期行为代替实际代码证据。

## P1：最小 Agent testkit

### 任务

- 建立测试支持目录和最小公开 API；
- 提取临时 dataDir、SQLite/AppContext、基础 workspace/repo、可选 `createApp()` 与统一 teardown；
- 提供显式 builder 参数和最小 fake runtime；
- 保持 cwd 和 `.tmp-tests` 等现有路径约束可诊断；
- 为测试支持代码增加自验证或代表性 fixture 生命周期测试。

### 批次边界

- 不迁移所有领域测试；
- 不引入 archive fault hooks；
- 不改 Shared contracts、AgentService 或 Runner；
- 若必须对生产代码增加 seam，先暂停并证明该 seam 是最小、通用且不会改变生产类型/行为，再更新方案。

### 审查重点

- 默认值是否透明；
- teardown 是否覆盖 app/DB/进程/socket/文件；
- 是否仍使用真实 SQLite/Fastify；
- 是否出现万能 builder、全局状态或生产反向依赖。

## P2：代表性测试迁移与 1A 冻结

### 任务

- 选取至少一组 read-side API/Service 测试使用新 testkit；
- 选取至少一组 fixture 生命周期/错误清理场景；
- 对迁移前后断言、状态、response 和资源清理做等价对比；
- 保留 API-managed Worker 专用 setup，除非公共部分可无损复用；
- 记录哪些重复 fixture 有意留到后续职责域；
- 完成 1A 全面独立审查和复审。

### 1A 结束门禁

P2 通过后停止 testkit 独立扩张，并在 `09-implementation-record.md` 记录已冻结公共面和复审结论。后续 testkit 变更必须按“P3-P6 新 testkit 需求处理”分类，触及冻结边界时重新进入 1A 审查门禁。

## P3：Read-side / Prompt 骨架与依赖边界

### 任务

- 根据 P0 调研冻结候选职责组件；
- 建立 read-side/prompt application entry 和最小依赖对象；
- 复用现有 `prompt/tool-projectors/`，不复制 tool projection；
- 为 session/run/context query、settings/workspace/plugin/skills/filesystem 提供窄 adapter；
- 建立 cache invalidation 的最小入口，保留 lifecycle 调用方；
- 在 module/service 中完成可编译装配，但不迁移三个用例的业务实现；只允许移动符合本文件判定口径的“无行为纯 helper”。

### 停止条件

若新组件必须持有完整 `AgentService`、直接调用 runtime 或形成 read-side ↔ lifecycle 双向依赖，暂停并调整边界。

### 审查重点

- 依赖方向；
- 命名是否表达职责而非技术分层；
- 是否过度接口化；
- 是否提前吸收后续领域。

## P4：Execution Profile 与 Messages Context

### 任务

- 先迁移 execution profile 的归属校验、profile/settings 解析和 response 组装；
- 再迁移 messages context 的 transcript、appendMessage、locale 和 compaction snippet 投影；
- 对应 `AgentService` 方法改为纯委派；
- 增加/迁移领域测试，同时运行 Route、Shared、Worker client 回归；
- 核对错误 status/body 和 dynamic payload 未漂移。

### 为什么同批但分步

两者都属于只读用例，可共享 query/adapters，但业务实现应先后迁移并分别验证。若变更面过大，P4 必须拆为两个独立可审查批次。

### 禁止

- 修改 Shared schema；
- 迁移 archive read；
- 改 transcript DB 查询策略或引入新分页；
- 重写 Worker Runner。

## P5：Static Prompt、Cache 与 Prompt Context

### 任务

- 迁移 static prompt assembler；
- 迁移/封装 `runPromptStaticCache`，保持 key/TTL/reuse/续期/清理；
- 迁移 prompt context 的 static + dynamic 组合；
- 复用 execution profile/messages/query 能力；
- 将 `AgentService.getPromptContextForRun()` 改为纯委派；
- 补充 cache 复用、失效、输入来源、message/tool/skill/locale 的 characterization tests；
- 验证完整 prompt/messages 不进入日志。

### 停止条件

以下任一情况必须暂停：

- 需要改变 cache key、TTL、失效或 static/dynamic 划分；
- 现有 profile/prompt helper 的共享依赖要求迁移 run lifecycle；
- 迁移造成模型输入顺序、内容或动态字段变化；
- 必须修改 Shared response schema 才能完成结构提取。

## P6：领域测试、装配与阶段收尾

### 任务

- 将 read-side/prompt 用例从综合测试迁到领域文件，或记录保留理由；
- 删除旧 service 中已无调用的 helper/import/cache 实现；
- 检查 `AgentService` 三个入口仅做委派；
- 检查 module/composition root 装配不承载 prompt 规则；
- 运行全阶段自动测试、build/typecheck、diff check；
- 执行必要 UI 手工验收；
- 由新审查视角做阶段全面审查，对照 0005/0006/本方案；
- 修复后再次复审。

### 完成门禁

- 无双实现、无循环依赖、无排除项；
- testkit 没有继续超出 1B 需要扩张；
- 真实 API-managed Worker 证据保留；
- 合同/cache/prompt/model input 语义有测试证明；
- 代码地图和文档与最终实现一致。

## 暂存与提交边界

- 每批通过独立复审后，只有在用户明确允许时才执行暂存；
- 不自动创建提交，不推送远程；
- 1A 与 1B 建议保持可独立回滚的暂存/提交边界；
- 若某批修复跨越前一批权威边界，必须回到相应批次重新测试和复审。
