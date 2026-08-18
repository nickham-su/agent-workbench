# 测试、审查与验收

## 总体规则

- 每一批先为当前行为建立冻结测试，再进行 shared/Route/Client 原子迁移；测试失败不得通过删除断言、扩大 `any` 或改变 status 来掩盖。
- 测试优先覆盖协议漂移、数据状态、CAS、非法输入、配置传播和 Worker 主力链路，不追求全量 tool `args/result` 深层穷举。
- 独立审查必须在每批完成后进行；发现问题后先修复，再由新的独立审查视角复审。复审通过并暂存该批后才可继续。
- 所有自动测试都应避免输出 token、完整 prompt、tool result 或 archive 内容。

## 自动测试矩阵

| 层级 | 重点 | 最小证据 |
|---|---|---|
| shared contract | export、path/method、TypeBox 正反例、literal response | `agent-api` 可从 package export 导入；九 endpoint 定义完整；非法 schema 不通过 |
| API env / Manager | strict/warn 默认、非法 fail-fast、显式 child env 覆盖 | API 和独立 Worker 均验证四种值；spawn env 带规范化值 |
| API Route/Service | schema-first、token、业务 ignored/conflict/error、response serialization | Fastify injection + Store/Service fixture 验证 status/body/DB |
| Worker Client | request method/path/body、success schema、strict/warn、non2xx | mock fetch，断言 warning 与抛错类别 |
| Worker Runner/tool | context 合法 output、compact conflict、prefork 降级、cancel | 复用既有 runner/builtin 测试文件，不建设第二套 runner harness |
| API/Worker integration | 启动链、配置、核心写回 | 真实/近真实 Worker→API 主力流程 |

### Shared schema 负例与成功响应

必须覆盖：

- 所有 endpoint method/path；PATCH item path builder 的正例。
- `ok:true` 只接受 literal true；不得接受 `{ok:false}`。
- context create/update 接受四种合法 output 顶层类型、当前 builtin/MCP/plugin canonical tool name、动态 `args/result`。
- 非法 context output（至少非法 `toolName`）不通过；证明 Route 不再“接受后 500”。
- create/update response 必须完整符合 `AgentContextItemRecordSchema`，而不是只测 `item.id`。
- compact response 是 `compacted/summaryItemId/archivedCount`，不误测 `{ok:true}`。
- preforkMeta strict object 的未知字段在 Fastify 集成层被剥离；不要错误把该现象写成纯 `Value.Check` 的行为。

### API Route/Service 基线测试

#### 顺序与 unknown fields

- 对每个代表性 endpoint 至少确认无效 body + 无效 token 返回 `400`，且 Service 未调用；合法 body + 无效 token 返回 `401`。
- 对未 strict 的 object，追加未知顶层字段后请求通过且字段在 handler body 保留（可通过受控 fixture/spy 证实）。
- `subtask.start.preforkMeta` 的未知字段被剥离后请求继续。
- `subtask.start.session.mode=new|fork` 加额外 `sessionId` 必须通过宽松 union，进入 Service 并返回 `400 AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED`。
- `subtask.start.session.mode=existing` 缺 `sessionId` 必须在 Fastify schema validation 阶段返回 `400`，handler/Service 不调用，且 body 不含 `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED`。另用直接 Service 防御性测试覆盖该 stable code，不把它当作普通 Route 输入响应。

#### Run（P1-1）

| 场景 | 断言 |
|---|---|
| 正常 run-state | 200 literal ok，既有状态更新/事件行为不回归 |
| RS-1 activeRunId 不同 | 200 ok，DB 不变 |
| RS-2 workspace/session 不匹配 | 200 ok，DB 不变 |
| RS-3 active run terminal | 200 ok，DB 不变 |
| 正常 complete | 200 ok，run/session 收敛保持现状 |
| RC-1 run 不存在 | 200 ok，DB 不变 |
| RC-2 归属不匹配 | 200 ok，DB 不变 |
| RC-3 run terminal | 200 ok，DB 不变 |

#### Context（P1-2）

| 场景 | 断言 |
|---|---|
| 合法 Worker output create | 200，完整 record 符合 public schema；Worker 可取 item.id |
| 非法 tool name create/update | request validation `4xx`，不发生 response serializer 500 |
| create prevId/head mismatch | 409，`code=conflict_head:<id|null>`；Worker Client 转 `ApiConflictError` |
| update 正常 | 200，完整 record |
| update terminal item | 200 原 item，DB 未写；测试/文档不声称 artifact 绝无副作用 |
| output 未声明字段 | 不对其持久化/回显作兼容断言，只验证 schema 定义字段 |

#### Compaction（P1-3）

- Service 前置 head conflict：`409 {message:"session head conflict"}`，无 `code`，未写 archive/未进 Store transaction。
- Store CAS 二次 conflict：`409` 且 `code=conflict_head:<id|null>`；summary/context archive/head DB 未提交。
- 使用可控 archive fixture 验证 rollback 尝试是 best-effort：不可把“无文件残留”写成必过断言；若 rollback skipped，验证 warning/诊断路径而非假设全局原子。
- 两种 `409` 都由 Client 变为 `ApiConflictError("context conflict")`；Runner 不对 compact 自动 retry。

#### Subtask（P1-4）

- prefork 默认/边界：缺失阈值归一为 95，范围 `50..99`，非法阈值为 `AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID`；Worker 固定请求 95。
- prefork 后续摘要失败：记录/吞掉失败并走 normal fork，start 不被阻断。
- start new/fork 加 sessionId：schema 通过、Service 返回 `400 AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED`。
- start existing 缺 sessionId：schema validation `400`，不进入 Service；断言不是 `AGENT_SUBTASK_EXISTING_SESSION_REQUIRED`。后者仅以直接 Service 防御性测试覆盖，并标明它不是当前普通 HTTP Route 可达路径。
- 覆盖稳定 error code 表中每个 code 至少一个 Route 或 Service 断言，并精确断言其 HTTP status/可达层级。不得只断言 message 或“400/409 任意一个”。
- 同 parent identity 并发/unique 分支：同一 child run identity，至多一个 child run，reuse 语义正确。若真实并发测试不稳定，至少保留 Store unique-constraint 精确识别与 race 分支测试，不能因此重构事务。
- 空白 prompt：400 `AGENT_SUBTASK_PROMPT_REQUIRED`；允许 fixture 观察到 new/fork session 已先创建，避免错误承诺原子性。
- result 对 running/failed/cancelled partial assistant text、system fallback、空 fallback；status 返回四种合法状态。
- subtask `409` 在 Worker Client 是普通 raw-body Error，绝非 `ApiConflictError`；Worker 不基于 code 分支。

### Worker Client strict/warn 测试

每个九接口至少验证 method/path 与成功 response schema 绑定；可通过表驱动测试减少重复。必须额外验证：

| 场景 | strict | warn |
|---|---|---|
| 2xx + 合法 JSON + 合法 schema | 返回 typed body | 返回 typed body，无 warning |
| 2xx + 合法 JSON + schema mismatch | 调用失败 | 继续，并恰好记录可诊断 warning |
| 2xx + 非 JSON | 调用失败 | 调用失败 |
| 401/404/409/500 | raw-body 普通 Error；context 特例除外 | 同 strict |
| 网络失败/timeout | 调用失败 | 同 strict |

对 create/compact 另测 `conflictAsError:true` 的 `409 -> ApiConflictError("context conflict")`；对全部 subtask `409` 断言普通 Error 文本包含 raw body。warning 断言不得过松：至少包含 endpoint 和 validation failure 摘要，并确认不包含 token/完整 payload。

### 配置传播测试

- API `loadEnv`：缺失为 strict，大小写/trim 后 strict/warn 可接受，非法值 fail-fast。
- Worker `loadWorkerEnv`：同样覆盖缺失、strict、warn、非法值；独立启动不依赖 API。
- `AgentWorkerProcessManager`：构造输入 strict/warn 后 spawn env 显式传入同一规范值；父 `process.env` 含非法原值时仍被覆盖。
- `main.ts`/构造测试：AgentApiClient 获得 WorkerEnv 的 responseValidation 和 logger。

## 聚焦手测

在隔离工作区、可丢弃测试数据中执行：

- 启动 API 管理的 Worker，确认 Worker ready、创建会话并完成一轮普通 Agent run；检查 run-state、context create/update、run-complete 主链无回归。
- 触发较长会话的自动 compact，或使用受控接口建立 head conflict；确认 Runner 以既有方式停止，不无限 retry。
- 使用 subtask 工具分别尝试 new、existing、fork；确认结果/status 可读取，取消 parent 后 child 的 DB 状态被收敛且两个 runtime cancel 调用发生。
- 用独立 Worker 启动方式分别设置 strict/warn；对受控的成功 response mismatch 验证 strict 停止、warn 明确告警且仅此场景继续。
- 对非法 internal context tool name 做受控请求，确认在请求边界失败而非产生 500。不得在真实用户 session 注入故意非法数据。

## 最终验收与完成定义

建议最终执行（以实际 package scripts 为准）：

```bash
npm run build -w packages/shared
npm run typecheck
npm run typecheck -w apps/api
npm run typecheck -w apps/agent-worker
npm run test:integration -w apps/api
npm run test:integration:worker -w apps/api
```

完成必须同时满足：

- shared export/build、API/Worker typecheck、相关 unit/integration 测试及新增冻结测试通过。
- 九 endpoint 的 schema、method/path、status、success shape 与本文一致；不存在旧手写边界定义或硬编码路径残留。
- config 默认、非法值与显式 spawn 覆盖得到证明。
- 每批独立审查、修复、复审均留有结论；最终全目录/实现审查与主力手测通过。
- 未修改非目标模块，未引入 timeout/retry、全局 error envelope、DB/事务/状态机重构。

## 回滚边界

推荐回滚单位是每个已审查暂存的原子批次：shared+Route+Client+tests 必须一起回退，不能仅回退 schema 或仅回退 Client。若 P1-2 output 收紧发现合法 Worker payload 不兼容，立即回退/修正该批，不得先以 `Type.Any` 混合运行。Compaction/Subtask 发现业务合同根本错误时，停止后续批次，回修前批并重新审查/复审。
