# 风险、兼容性与非目标

## 主要风险

### 公开 Contract 收紧影响外部客户端

风险：仓库外调用方可能向 create/fork 发送 `kind`。

影响：升级后请求返回 `400`。

措施：

- release note 明确 breaking field removal；
- HTTP 测试冻结错误；
- 不静默 strip；
- 部署后监控 validation 400；
- 内置 Web 和 Feishu 当前不传 kind，回归验证即可。

### 通用 Internal Create 的兼容性

风险：未知内部集成可能使用 `/api/internal/agent/sessions/create` 创建 subtask。

判断：该行为绕过 parent/tool/depth 校验，本身不应继续兼容。

措施：

- 仓库搜索生产调用方；
- 发布说明单列 internal breaking change；
- 若发现合法生产需求，必须迁移到 `/api/internal/agent/subtask/start`，不能保留后门。

### Fork 拆分引入 Archive 回归

风险：当前 `forkSession()` 集中处理 visible/archive clone、sidecar 和 rollback，拆分容易遗漏。

措施：

- 先 characterization；
- clone 原语整体迁移，不重写算法；
- public/internal 两个上层只增加权限与编排；
- 故障注入测试覆盖 session/dir清理。

### Internal Subtask Fork 回归

风险：直接收紧旧函数会打坏 `session.mode="fork"`、prefork summary、guard。

措施：

- P3/P4 顺序执行；
- 不在 internal迁移前删除旧能力；
- 逐模式测试；
- guard/summary/prompt顺序冻结。

### Existing 模式测试依赖公开 Create

风险：大量现有测试通过 public create `kind=subtask` 构造 fixture，contract收紧会造成测试大面积失败。

措施：

- 区分生产行为测试与异常数据构造；
- 正常 existing流程通过 internal start创建；
- 异常场景使用明确 testkit/store helper；
- 不为测试便利保留生产后门。

### Unknown Field 可能被 Strip

风险：TypeBox schema移除字段后，Fastify默认validation可能自动剔除额外字段并成功创建primary，未达到明确拒绝；也可能因生命周期顺序导致局部hook看不到原始key。

措施：

- P0先用真实`createApp()` HTTP探针冻结当前行为和hook顺序；
- 选定Shared schema `additionalProperties:false` + endpoint-local `preValidation` allowlist，不修改全局Ajv；
- 三个endpoint分别验证kind和任意unknown key均返回同一稳定400，service不执行、无数据落盘；
- 若`preValidation`无法可靠观察原始key，暂停并回到设计，不得临时接受strip或改全局Ajv；
- 以最终HTTP证据为验收，不以类型定义或schema单测为验收。

### 历史 Run 不热更新

风险：部署后用户在已启动Run中询问工具，仍看不到subtask。

措施：

- 发布说明提示新Run生效；
- UI无需强制迁移；
- 当前Run结束/取消后再发送消息；
- 不尝试修改prompt static cache语义。

### “Fork重置Depth”被误解为绕过

风险：团队可能认为primary fork把depth重置为0会绕过max。

边界：公开fork只从primary发起；subtask只读且不可公开fork。用户不是在同一subtask执行链中重置，而是创建新的用户执行根。

措施：

- 服务端强制source kind；
- generic create不允许subtask；
- 文案明确max只限制subtask工具链。

### 新增 Run 入口遗漏不变量

风险：未来新增 regenerate/retry/其他primary Run入口时重新复制旧lineage逻辑。

措施：

- 可抽取极小的primary Run lineage constant/helper；
- 在code review checklist加入所有 `createRunRecord()` 调用枚举；
- 测试断言新primary组合。

## 兼容性说明

### 行为变化

| 行为 | 之前 | 之后 |
|---|---|---|
| 普通 fork 首 Run depth | 继承source或unknown | 固定0 |
| 多次 fork copied item | 可能unknown | 固定0 |
| ordinary Run parentRunId | 首fork可能写sourceRun | 固定null |
| public create kind | 可传 | 字段非法 |
| internal generic create kind | 可传 | 字段非法 |
| public fork kind | 可传 | 字段非法 |
| public fork subtask source | 服务端可接受 | 明确拒绝 |
| copied item runId | null | 保持null |
| internal subtask depth | parent+1 | 保持 |
| existing模式 | 保留 | 保留 |
| prompt unknown过滤 | 隐藏 | 保持 |

### 数据兼容

- 无schema变更；
- 无DB回填；
- 历史旧组合继续可读；
- 新write遵守新不变量；
- store类型保持nullable。

### API兼容

- request字段移除属于breaking；
- response不变；
- internal subtask协议不变；
- Web当前调用兼容；
- plugin当前调用兼容。

## 安全与权限风险

收紧后安全性提高：

- 无法通过generic endpoint伪造subtask session；
- 无法绕过anchor/depth创建child；
- unknown depth继续fail closed；
- copied item不会伪造Run ownership。

实现不得为了兼容旧客户端增加：

- `kind=subtask`隐藏开关；
- query/header后门；
- internal token下generic create subtask例外；
- prompt层unknown放行。

## 非目标

本次明确不做：

- 不新增context item provenance字段；
- 不提供fork树可视化；
- 不修改archive文件格式；
- 不重构整个AgentService；
- 不迁移所有session逻辑到新模块；
- 不修改Worker nested run控制流；
- 不修改MCP/plugin tool registry；
- 不修改subtask agent选择、scope或workspace enablement；
- 不改变max depth范围和配置存储；
- 不限制primary fork数量、同层subtask数量、并发或token；
- 不删除existing模式；
- 不新增DB constraint或修复所有历史脏数据；
- 不让subtask session可写；
- 不开放subtask→primary promotion；
- 不热更新已启动Run的tools；
- 不把普通fork关系写入Run parent字段替代现有session metadata。

## 后续可选方向

不属于本次，但未来可独立评估：

- fork provenance：`originSessionId/originItemId`；
- DB约束保证parent字段成对出现；
- 诊断页面显示Run depth和tools快照；
- 正式的subtask→primary promotion产品；
- AgentService后续write-side领域拆分；
- API版本化/弃用周期。

任何后续方向都不能在本次开发中“顺手预建”。

## 停止条件

遇到以下情况暂停实施并更新设计：

- 产品要求从subtask session公开fork为primary；
- 产品要求普通primary fork继承安全预算；
- existing模式被发现依赖外部手工创建subtask；
- generic internal create存在无法迁移的合法subtask调用；
- clone抽取需要改变archive持久格式；
- 当前代码新增其他ordinary Run创建路径；
- 最新read-side改动改变了depth工具过滤权威；
- contract validator无法明确拒绝unknown字段且需要全局行为改变。

## 回退原则

- 无DB迁移，代码可回滚；
- 如contract收紧造成外部阻断，优先推动客户端迁移，不恢复subtask创建后门；
- 若必须短期兼容，应先与用户重新确认并更新本设计，采用显式版本化/弃用方案；
- 不允许通过复制runId或prompt放宽作为紧急回退。
