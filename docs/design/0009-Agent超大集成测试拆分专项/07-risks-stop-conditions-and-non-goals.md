# 风险、停止条件与非目标

## 主要风险与控制

| 风险 | 表现 | 控制措施 |
|---|---|---|
| 测试覆盖丢失 | 剪切时漏掉测试或断言 | 165 项标题/原行号/目标文件清单；脚本核对；先新后删 |
| 断言弱化 | 为适配 helper 或并发而删除严格 assert | 独立审查逐项比对核心断言；禁止改产品预期 |
| 机械拆分 | 出现 part1/part2/misc，仅移动行数 | 按主断言调用链归属；新测试归属规则；结构审查 |
| 测试顺序依赖暴露 | 拆成多文件后测试找不到前序数据 | 每测试独立 DB/workspace；发现依赖立即停止并记录 |
| 文件级并发冲突 | DB、socket、Plugin Host、SSE、临时目录互相影响 | 唯一 dataDir/socket；P0 实测 runner 并发；保留 concurrency 语义 |
| teardown 不完整 | app/DB/process/reader/dataDir 遗留 | 幂等 `dispose()`；特殊资源局部 finally；失败路径测试 |
| 新 testkit 膨胀 | options 和 helper 不断吸收领域流程 | 只纳入稳定通用能力；领域 helper 就近；独立审查拒绝万能层 |
| helper 隐藏状态 | 调用者不知道 helper 创建 run 或改状态 | 显式 fixture 入参；副作用命名/注释；窄 helper |
| 主链被单元测试替代 | 为提速删除真实 SQLite/process/SSE 测试 | 关键主链验收矩阵；禁止以已有单元测试为删除理由 |
| 总耗时恶化 | 多文件各自初始化 app/DB，执行明显变慢 | P0/P5 记录基线和新耗时；先定位 runner/fixture 原因，不共享 DB |
| flaky 暴露 | Plugin Host 固定等待或 SSE 在并发下不稳定 | 特殊文件隔离；实测串行策略；不顺带修改生产启动逻辑 |
| package script 不可移植 | glob 或 shell expansion 在环境间不同 | P0 比较真实命令；必要时使用稳定显式发现方式 |
| 迁移范围膨胀 | 顺手改 Store/Worker/composition/产品逻辑 | 生产代码零 diff 门禁；发现问题另立任务 |
| 测试复制漂移 | 新旧长期重复，后续只改一份 | 每批结束删除已验证旧块；P5 检查唯一活动副本 |
| import/fixture 杂乱 | 每个新文件复制大量相同初始化 | 最小 integration testkit；仅稳定能力复用 |

## 强制停止条件

出现以下任一情况，必须停止当前批次，补充调研或与用户讨论，不能继续机械迁移：

- 为使迁移后的测试通过，需要修改生产逻辑、HTTP 合同、Shared 类型、DB schema、Archive/Artifact 格式或运行时行为；
- 发现一个测试依赖前一个测试创建的数据、设置、进程或缓存；
- 多文件并发导致 SQLite、临时目录、socket、Plugin Host、SSE reader 或端口资源冲突；
- 现有 `{ concurrency: false }` 等语义在新结构下无法等价保持；
- `agent-integration-testkit.ts` 需要吸收多个领域的状态编排或大量只服务单个测试的开关；
- 原测试的核心断言无法等价迁移，或只能通过降低断言强度解决；
- 关键跨域主链只能通过替换为 fake 单元测试才能拆分；
- 新目录测试持续不稳定，而旧综合文件稳定；
- 总耗时出现明显且无法解释的恶化；
- package script 无法在目标本地/CI 环境稳定发现全部新文件；
- 发现原测试数量、标题或源码结构已与 165 项方案基线显著不一致；
- 工作区存在与本专项目标文件重叠的未知改动；
- 任何生产文件出现非预期 diff。

停止后允许的动作：

- 记录现象、命令、日志和最小复现；
- 回滚当前小批测试迁移；
- 更新方案的事实基线；
- 向用户说明阻碍和可选处理方式。

停止后不允许的动作：

- 猜测 runner 行为并继续批量移动；
- 为了绿色修改生产实现；
- 共享 DB/app 绕过资源问题；
- 删除严格断言或主链；
- 擅自扩大为 Worker 或 Store 重构。

## 兼容性原则

### 测试行为

- 测试标题默认保持；
- 核心断言、状态准备和错误信息保持；
- 既有 skip/concurrency/options 保持；
- 既有 warning 若为预期，应在实施记录说明；
- 旧测试中的真实 I/O 不因拆分而默认 fake 化。

### API 与产品

- URL、HTTP method/schema/status/error code 不变；
- Shared internal contract 不变；
- Agent settings、prompt、session、run、subtask、archive、artifact 产品语义不变；
- 不新增或删除产品功能。

### 数据与文件

- 每测试继续使用真实 SQLite；
- DB schema 和 migration 不变；
- Archive/Artifact/sidecar/snippet 文件格式不变；
- symlink、containment、missing-file 等安全语义不变。

### 运行时与进程

- startup fail/recover 时机不变；
- enqueue/cancel race 预期不变；
- runtime cancel best-effort 预期不变；
- Plugin Host process/socket 生命周期不变；
- SSE 事件格式和连接清理不变。

## 非目标

- 继续 Agent 生产模块治理；
- 拆分 `agent.store.ts`；
- 拆分 `agent.composition.ts`；
- 修改 `AgentService`、routes、module 或 startup coordinator；
- 启动 Worker 结构评估；
- 优化模型请求超时、重试、取消或工具执行；
- 修改 Shared contract 或 API；
- 修改 DB schema、数据迁移、Archive/Artifact 格式；
- 重写测试框架；
- 引入新的通用 fixture 框架、DI 容器或测试 DSL；
- 追求所有测试文件完全等长；
- 删除“看起来与单元测试重复”的真实集成主链；
- 优化 Plugin Host 固定等待或生产进程行为；
- 性能优化项目；
- 测试以外的代码格式化或命名清理。

## 可接受差异

实施允许与初始目标文件列表存在小幅差异，但必须同时满足：

- 仍为约 `15-16` 个语义文件；
- 165 项唯一归属仍完整；
- 差异由真实 helper/import/资源耦合证据支持；
- 不产生 `misc` 或机械 part 文件；
- 独立审查接受并记录理由。

可能的可接受差异示例：

- `internal final-text` 实际归 Peripheral Status，符合主调用面判断；
- 一个很小的 route contract 测试文件与同语义 Session route 文件合并；
- 两个窄领域 helper 因实际只有单文件使用而不创建，改为就近保留。

不可接受差异示例：

- 为减少文件数把 Archive、Artifact、Prompt 全部放进 `agent-misc.integration.test.ts`；
- 将 fixture options 扩张成完整 AppContext builder；
- 为速度共享一个全局 DB；
- 删除 Plugin Host 或 SSE 主链。

## 后续事项边界

本专项完成后：

- Agent 生产模块治理仍保持“已完成并停止”；
- Worker 结构评估仍是未启动的独立候选任务；
- 若未来具体功能暴露测试缺口，应在对应语义文件新增测试；
- 若新文件再次持续膨胀，应基于真实调用链重新评估，而不是预先过度拆分。
