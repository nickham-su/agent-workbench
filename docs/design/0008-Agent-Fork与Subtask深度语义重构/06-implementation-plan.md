# 开发任务拆分与实施步骤

## 实施原则

本方案建议按小批次推进。每批遵循：

```text
实施前复核
  → 小批修改
  → 定向测试
  → 独立审查
  → 修复
  → 复审
  → 下一批
```

禁止把 contract 收紧、fork 大拆分、primary depth 和全部测试一次性混成不可定位的大改。

本文中的候选函数名允许按项目风格调整，但批次依赖、调用方向和职责边界不得变化。任何把 public Route 重新接到私有 materializer、让 primary create 接收 fork metadata、让 clone 原语决定depth/权限的“命名调整”，都属于设计偏差而不是实现弹性。

## 批次总览

| 批次 | 目标 | 主要改动 |
|---|---|---|
| P0 | 冻结最新行为与测试基线 | characterization/contract 证据，不改生产语义 |
| P1 | 修正 ordinary primary Run 写入 | sendMessage、compact、删除 lineage helper |
| P2 | 收紧 session create contracts | public/internal create primary-only |
| P3 | 拆分 clone 与公开 primary fork | context clone 原语、public fork 校验 |
| P4 | 迁移内部 subtask fork/create | new/fork/existing 保持，去除对 public fork 的复用 |
| P5 | 测试迁移、文案与全量回归 | 替换旧规格测试，更新帮助文案，全面验收 |

批次可进一步拆小，但不得改变依赖顺序：P3 的 clone 原语准备好后，P4 才能移除 internal subtask 对旧 `forkSession()` 的依赖。

## P0：冻结基线

### 任务

- 复核当前 `git status`，未知变更不得处理；
- 记录最新路径与函数行号；
- 运行或补充最小 characterization tests：
  - 普通 fork 首 Run 当前继承 source depth；
  - copied item 当前 `runId = null`；
  - 二次 fork 当前产生 `null` depth；
  - prompt assembler 对 `null/max` depth 隐藏 subtask；
  - subtask child depth 为 parent+1；
  - internal subtask fork 当前 guard/summary 行为；
- 记录 public create/fork 携带 kind 的当前 HTTP 行为；
- 使用真实 `createApp()` 固定 Fastify + TypeBox 对 `additionalProperties:false`、unknown field和生命周期hook的当前行为；
- 建立最小HTTP探针，证明endpoint-local `preValidation` allowlist能在schema validation/strip之前观察原始body keys并返回自定义400；
- 冻结三个目标endpoint的字段allowlist和统一unknown-field错误格式；
- 记录 internal create 当前调用方，确认 Feishu 未传 kind。

### 交付

- 能证明旧 bug 和现有不变行为的测试证据；
- 确认 Shared/API/Web/Worker 测试命令和 cwd；
- 若代码已变化，先更新本目录 `09-code-map.md`。

### 门禁

如果不能证明 copied item ownership、internal subtask fork、prompt 深度过滤现状，或不能证明所选unknown-field拒绝机制在真实HTTP生命周期中有效，不得进入后续生产改动。若局部`preValidation`机制不可行，必须先回到设计，不得在P2临时选择静默strip或全局Ajv改造。

## P1：修正 Ordinary Primary Run

### 实施步骤

- 修改 `AgentService.sendMessage()`：
  - 保持 subtask read-only 校验；
  - Run 写入固定 depth `0`；
  - parent fields 双空。
- 修改 `AgentService.compactSession()`：
  - 固定相同值；
  - 保持 compact 其他行为。
- 确认 internal `/runs/trigger` 仍委派 sendMessage；
- 删除 `resolveRunLineageForSession()`；
- 清理不再需要的 imports；
- 替换现有“普通 UI fork 继承 depth”测试的核心断言，或先新增新规格测试再在 P5 整理。

### 定向测试

- root primary message Run depth `0`；
- first fork primary Run depth `0`；
- second fork copied user/assistant item Run depth `0`；
- existing primary session 历史 latest depth `null/2`，新 message Run depth `0`；
- compact depth `0`；
- parent fields 双空；
- subtask session send/compact/clear 仍返回 `400 AGENT_SUBTASK_READONLY`。

### 审查门禁

- 不得保留 source item/source Run DB 查询；
- 不得修改 `PromptStaticAssembler`；
- 不得影响 subtask child Run 创建。

## P2：收紧 Create Contract

### 实施步骤

- Shared：
  - `AgentCreateSessionRequestSchema` 移除 kind；
  - `AgentInternalCreateSessionRequestSchema` 移除 kind；
  - 声明 `additionalProperties:false`，作为类型/OpenAPI约束。
- API Route：
  - public/internal create body type 移除 kind；
  - 按P0证据落地endpoint-local `preValidation`字段allowlist，不修改全局Ajv；
  - 两者调用 primary-only service 方法。
- Service：
  - 引入/明确 `createPrimarySession()`；
  - 准备私有 `createSubtaskSessionInternal()`，但 P4 才完成所有迁移；
  - generic request 不再控制 entity kind。
- Web/Plugin：
  - 编译验证当前调用无需行为改动；
  - 不增加冗余 `kind="primary"`。

### 测试迁移

- P2开始前必须已有P0真实HTTP证据；缺失时不得用单元测试或类型检查替代；
- public create 正常创建 primary；
- internal create 正常创建 primary；
- public/internal create 携带 `kind="subtask"` 返回 `400`；
- 携带 `kind="primary"` 也返回 `400`，证明字段已移除而非只禁 subtask 值；
- public/internal create携带任意其他unknown key返回同一稳定400错误码；
- 验证service未被调用且没有session落盘；
- Feishu plugin 类型/测试通过；
- 原先通过 public create 构造 subtask 的测试，先改为 store/testkit/internal domain fixture。

### 兼容性记录

该批是 Shared HTTP request contract breaking change。实现记录必须列出：

- 被移除字段；
- 仓库内调用方验证；
- 仓库外客户端需升级；
- 请求失败的状态与错误格式。

## P3：提取 Clone 原语并建立 Public Primary Fork

### 实施步骤

- 从 `forkSession()` 提取私有 clone 原语；
- 保持 visible/archive 复制、status 规整、ID map、sidecar 和 rollback；
- 建立 `forkPrimarySession()`：
  - source exists；
  - source kind primary；
  - boundary user/assistant；
  - target primary；
- Shared fork request 移除 `kind`、声明`additionalProperties:false`；
- public fork Route使用同一endpoint-local unknown-field allowlist机制；
- Route 改调 `forkPrimarySession()`；
- 增加 `AGENT_FORK_SOURCE_KIND_INVALID` 或确认的稳定错误码；
- 暂时保留 internal subtask path 可调用的 private bridge，直到 P4 迁移完成。

### 测试

- primary -> primary 两种 mode；
- source subtask 被拒绝；
- request kind/任意unknown field被同一稳定400错误拒绝，service未调用、无target落盘；
- boundary item kind 校验保持；
- archived boundary、invalid item 行为保持；
- copied items `runId/turnId/step = null`；
- archive sidecar success/failure rollback；
- 多次 fork 的 archive/visible 语义不回归。

### 审查门禁

- clone 原语不得暴露到 Route；
- public API 不得存在 internal override；
- target kind 不得由请求决定；
- 不能先删除 internal subtask fork 所需能力。

## P4：迁移 Internal Subtask 创建和 Fork

### 实施步骤

- `startSubtaskRunFromWorker()` 的 `new`：调用 private subtask create；
- `fork`：
  - 保持 fork boundary 解析；
  - transcript clone 路径调用 private clone 原语；
  - prefork summary路径按真值表写parent/tool metadata，不复制历史，插入summary→guard→prompt；
  - non-summary boundary路径写parent/boundary metadata，复制历史后插入guard→prompt；
  - null boundary路径metadata双空且不复制历史，插入guard→prompt；
- `new`写parent/tool metadata，仅追加prompt；
- `existing`保持校验、复用和既有metadata，仅在head后追加prompt；
- child Run 继续写 parent+1 和真实 parent fields；
- 保持 created session cleanup；
- 删除 `allowAnyKindBoundary` 和旧通用 `forkSession()`；
- 确认只有 private subtask path 能创建 `kind=subtask`。

### 测试

- new/fork/existing 全模式；
- max depth/unknown depth；
- anchor ownership/invalid tool；
- same parent/tool 幂等；
- existing mismatch/missing/primary/foreign/running；
- prefork summary、guard、prompt 顺序；
- fork 不复制触发 assistant/tool；
- child context copied item runId null；
- nested processing 与结果读取；
- cancel cascade 和 orphan 处理；
- transaction/archive failure 不留 orphan session。

### 审查门禁

- `kind="subtask"` 的生产创建点必须可枚举且都位于 subtask domain；
- existing 不得读取 session latest depth；
- public fork 校验不得影响 internal boundary。

## P5：测试整理、文案与全量回归

### 测试整理

- 删除/改写旧测试：`普通 UI fork 首 run 继承来源 depth...`；
- 新测试命名必须反映新产品语义；
- public create subtask fixture 全部清除；
- 将异常 subtask fixture 封装为明确 testkit/store helper，不扩大生产 API；
- prompt/read-side 增加跨层结果证据，但不改生产规则；
- Shared internal contract existing 模式测试保留。

### 文案

- 更新中英文 `maxSubtaskDepth` help；
- 如 API 文档由 schema 自动生成，确认 create/fork 不再显示 kind；
- 发布说明标记 request contract 收紧。

### 回归

至少运行：

- Shared build/type/tests；
- API typecheck/build；
- Agent store/context contract tests；
- Agent integration tests；
- read-side/prompt tests；
- Worker API client、builtin subtask、nested run、cancel tests；
- Web typecheck/build；
- plugin Feishu tests/build（若仓库脚本提供）。

具体命令以仓库 package scripts 为准，实施前记录真实命令，不得在设计阶段编造。

## 详细文件级任务清单

### Shared

- `packages/shared/src/contracts/agent.ts`
  - 收紧 create/internal create/fork requests；
  - 保持 record kind。
- Shared contract tests
  - unknown/kind rejection；
  - internal subtask contract不变。

### API Routes

- `apps/api/src/modules/agent/agent.routes.ts`
  - public/internal create body；
  - public fork body与service委派；
  - internal subtask routes不变。

### API Service

- `apps/api/src/modules/agent/agent.service.ts`
  - primary Run 固定值；
  - create职责拆分；
  - clone/fork职责拆分；
  - internal subtask迁移；
  - 删除旧lineage。

### Store/Schema

- 原则上不改生产代码；
- 如测试 helper 需要 direct store，使用现有 `createAgentSession/createRunRecord`；
- 不新增 schema/migration。

### Prompt/Read-side

- 生产逻辑不改；
- 补测试证明工具投影结果。

### Web/Plugin

- Web 请求调用通常不需要改；
- 更新 i18n help；
- 编译验证 Shared type 收紧；
- plugin generic internal create 继续 primary。

## 回滚策略

每批可独立回滚：

- P1 回滚 ordinary Run 写入；
- P2 回滚 request contract；
- P3/P4 必须协调：若 P4 已迁移，回滚 P3 时必须恢复 internal clone 调用；
- 不涉及 DB schema，因此不存在不可逆迁移。

出现以下情况必须停止并回到设计：

- 发现仓库内存在合法生产调用依赖 generic create `kind=subtask`；
- internal subtask fork 无法在不改变 archive/guard 语义下拆分；
- Fastify validator 无法按当前项目机制拒绝 unknown field；
- endpoint-local `preValidation` 无法在schema strip前观察原始key，或必须改全局Ajv才能实现；
- 新增了从 subtask session 公开派生 primary 的产品需求；
- 需要修改 `PromptStaticAssembler` 才能通过新测试。
