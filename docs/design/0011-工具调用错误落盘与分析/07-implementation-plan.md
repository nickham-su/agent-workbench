# 开发任务拆分与实施计划

## 实施原则

- 按“小步、可验证、可回滚”实施；每批先补测试再改生产代码。
- 不操作或迁移历史 `.awb` 文件；新目录只有功能开启且发生应记录错误时才出现。
- 不同时推进 API/DB/UI/retention 等非目标事项。
- 每批完成后执行对应测试和独立审查；审查不通过先修复并复审，不带已知问题进入下一批。
- 下列步骤是有依赖的实施顺序，不是可由开发者任意选择的建议。

## 任务依赖图

```text
现状冻结
  -> 保真图编码器
  -> Worker 安全 I/O/Store
  -> Capture 实体与分类
  -> Runner writeback wrapper
  -> 普通执行 tool/runtime 接入
  -> policy/recovery 接入
  -> Abort/降级/并发回归
  -> 全量验证与独立审查
```

## 开发前基线复核

### 目标

确认当前代码仍符合本文引用，避免行号漂移或已有改动造成错误接入。

### 操作

按符号复核：

```text
runner.ts:
  buildToolSuccessText
  buildToolErrorText
  safePathSegment
  finalizeToolText
  writeItemLog
  executeTool
  executeToolSafely
  executePendingTools
  runModelStep

tools/types.ts:
  PendingToolExecution
  ToolExecutionContext
  ToolProvider
apiClient.ts:
  updateContextItem
agent.composition.ts:
  resolveToolOutputText
  terminal tool item message building
```

### 验证

- 运行现有 `runner.cancel.test.ts` 与 `runner.tool-output.test.ts`；
- 记录当前通过结果；
- 若当前行为与本文事实不一致，先更新本文“当前实现”引用，但不得改变已定稿产品合同。

### 回滚点

本步骤只新增/调整冻结测试，不改生产行为；测试断言错误时回退该断言并重新复核源码。

## 实施批次：冻结现有状态与错误语义

### 目标

在重构 `executeTool()` 前锁定现有行为。

### 任务

补充测试证明：

- Provider reject 时 failed output 的 `toolName/toolCallId/args/text/error`；
- disabled 两条路径的错误文本和 Provider 不执行；
- running recovery 的错误文本和不重放行为；
- Provider fulfilled 的 completed output；
- completed writeback reject 后现有外层/内层状态行为；
- Abort-like 直接返回；
- 成功 artifact 写入失败是降级而非工具失败；
- Debug Dump 与本功能无耦合。

### 验证

```bash
npx tsx --test \
  apps/agent-worker/src/runtime/runner.cancel.test.ts \
  apps/agent-worker/src/runtime/runner.tool-output.test.ts
```

### 审查重点

- 测试是否锁定业务行为而非实现细节；
- 是否使用虚构数据；
- 是否没有提前引入新目录或新 schema。

### 回滚点

仅回退本批测试；不得通过改生产代码让错误的冻结断言通过。

## 实施批次：保真值图编码器

### 目标

建立不脱敏、不截断、可表达特殊值和对象图的纯函数模块。

### 任务

新增：

```text
apps/agent-worker/src/runtime/losslessValueGraph.ts
apps/agent-worker/src/runtime/losslessValueGraph.test.ts
```

实施顺序：

- 定义 `LosslessValueGraphV1`、primitive/node 类型；
- 实现 node id/ref 和循环/共享引用；
- 使用 `Object.getOwnPropertyDescriptors()` 或等价 descriptor-only 反射实现普通对象自有 string/symbol 属性；data property 编码 value+元数据，accessor 只编码 descriptor/getter/setter 标识；
- 实现 Error `name/message/stack/cause/errors` 的 data/unavailable_accessor/absent/reflection_error 四态与来源；
- 实现 Map/Set/Date/RegExp/Buffer/typed arrays/URL；
- 实现 Function/Symbol；
- 实现 Proxy/descriptor/原型反射失败 `reflection_error`；
- 确保不调用普通对象或 Error 自定义 getter/accessor，不调用 `toJSON()`、自定义 `toString()`，不等待 Promise；
- partial result 只从合同规定的自有 data property 提取；
- 使用显式 work queue/stack 展开对象图，避免深对象触发调用栈溢出；
- 提供 `captureLosslessSnapshot(value, capturedAt)`。

### 详细验证

- 先写每类失败测试，确认原生 JSON 不能满足；
- 对循环引用、BigInt、undefined、Error 非枚举字段做精确断言；
- 对 Error `data | unavailable_accessor | absent | reflection_error` 四态做精确断言，getter 调用次数必须为 0；
- 对超长字符串断言全文相等；
- 对快照后原对象突变断言快照不变；
- PR 必跑使用 2,000 层深链；10,000~20,000 层归入慢测/专项或夜间测试；
- 运行 PR 必跑：

  ```bash
  npx tsx --test apps/agent-worker/src/runtime/losslessValueGraph.test.ts
  npm run typecheck -w apps/agent-worker
  ```

### 审查重点

- 有没有隐含深度/长度/数组项上限；
- 有没有调用普通/Error 自定义 getter、`toJSON()`、自定义 `toString()`；
- Error data property 与 accessor descriptor 是否分别正确，absent 不伪造；
- 是否只使用 `reflection_error` 表达反射本身失败，且局部降级；
- 是否完全移除任何“属性求值错误”语义；
- 类型 tag 是否版本化且可扩展。

### 回滚点

该模块尚未接入 Runner，可整体删除，不影响生产。

## 实施批次：Worker 安全文件原语

### 目标

建立工作区 containment、no-follow 和排他 hard-link 发布；能力不足时不可用但安全失败。

### 任务

新增：

```text
apps/agent-worker/src/runtime/workspaceSafeIo.ts
```

按 [04-technical-design.md](./04-technical-design.md) 固定实现：

- 抽取或复用当前 `safePathSegment/isPathInside`；
- 逐级安全目录创建，mode 0700；
- 检测 Node no-follow 打开能力；缺少 `O_NOFOLLOW` 且没有项目认可等价能力时安全失败；
- no-follow 读取，不得将缺失 flag 降级为 `0`；
- O_EXCL/O_NOFOLLOW 临时文件，mode 0600；
- write+sync+close；
- 同目录 hard link 排他发布；
- hard link 不支持、`EXDEV`、只读、权限不足时不发布 final；
- 尽力清理本次 temp；
- 不使用覆盖性 rename，不回退其他目录。

若把 `runner.ts` 当前 safe helper 抽到新模块：

- 必须保持 `finalizeToolText()` 的现有目录、路径和行为；
- 先让旧成功 artifact 测试通过，再继续。

### 验证

- 在 capability 成立的 Linux 本地/CI 环境用真实 open/link 证明 fully supported 并成功落盘；不得只按 OS/文件系统名称判定；
- 使用临时工作区覆盖正常、并发、symlink、路径逃逸、final 已存在；
- 注入 no-follow 不可用、hard link 不支持、`EXDEV`、只读和权限不足，证明 unsupported 安全失败；
- 确认工作区外 fixture 未改变；
- 运行相关 file/artifact 测试和现有 `runner.tool-output.test.ts`。

### 审查重点

- 每一级是否 lstat/realpath；
- 并发 EEXIST 后是否重新验证；
- final 是否绝无 truncate/overwrite 路径；
- fully supported 是否同时要求 hard link 与 no-follow；
- 平台能力不足是否不发布 final、清 temp、限频 warn且主流程不变；
- 是否不存在普通 rename、弱化 no-follow或其他目录 fallback。

### 回滚点

若已抽取旧 helper，回滚必须同时恢复 `runner.ts` import/实现与测试；不能只删除新模块。

## 实施批次：Tool Error Store

### 目标

把已组装 artifact 安全发布到固定目录，处理幂等、冲突和 warning。

### 任务

新增：

```text
apps/agent-worker/src/runtime/toolErrorStore.ts
apps/agent-worker/src/runtime/toolErrorStore.test.ts
```

实施：

- 定义固定路径构造；
- 验证 identity/itemId/failureKind；
- 组装 publication 字段；
- stringify 纯 JSON artifact，二空格+换行；
- 发布 canonical；
- EEXIST 时 no-follow 读取并身份校验；
- 身份一致幂等；否则按 recordedAt+attempt 发布 conflict；
- attempt 最大 1000；
- 新目录宽权限 warning；
- 60 秒 warning 限频；换行/Unicode 行分隔符替换为空格；整行最多 512 个 JavaScript 字符单元；
- warning 只含固定前缀、相对目标、operation、错误 name/code/message 摘要和 suppressed 计数；
- 导出只吞异常的 best-effort API。

### 详细验证

- canonical、幂等、safe collision conflict；
- 非 JSON/未知版本 canonical conflict；
- 并发发布；
- 每个 fs 操作失败注入；
- warning 不泄露完整 payload，始终单行且不超过 512 个 JavaScript 字符单元；
- 日志摘要截断不改变 artifact 完整内容；
- unsupported 环境不发布 final且清理 temp；
- writer 不递归；
- 运行 store + safe I/O 测试。

### 审查重点

- store API 是否真的不会抛；
- 是否无 max-bytes 和截断；
- 是否只有 warning 摘要受 512 字符限制；
- conflict 是否绝不覆盖；
- relative/canonical path 是否与文档完全一致。

### 回滚点

尚未接 Runner，可整体移除；已抽取 safe I/O 保留与否取决于成功 artifact 是否已使用。

## 实施批次：Capture、实体与配置

### 目标

建立每调用内存状态、即时快照、错误 ID、stage 映射和 artifact 组装。

### 任务

新增：

```text
apps/agent-worker/src/runtime/toolErrorCapture.ts
```

实施：

- 生产常量精确读取 env；
- 可测试纯解析函数，真实常量只读取一次；
- 定义四 kind 和固定 stage map；
- capture 创建时即时 args 快照；
- Provider start/fulfilled/reject API；
- partial result API；
- writeback attempt begin/succeed/fail API；
- Error/thrown value即时快照和稳定 errorId；
- event sequence、phaseAttempt、dedupe key；
- Abort 事件抑制；
- 按 kind 组装自包含 artifact；
- 没有 events 时不调用 store；
- publish 调 store best-effort。

### 测试依赖注入

当前 `AgentRunnerDeps` 已支持 `streamText/nowMs`。本功能可以：

- 给 `ToolFailureCapture` 直接注入 `nowMs/store` 做模块测试；
- Runner 集成测试通过 `AgentRunnerDeps` 增加内部 `toolErrorCaptureFactory`，默认使用生产 factory。

该依赖只用于 Worker 内部测试，不得进入 shared/API。

### 验证

- env 表格全部值；
- args 在创建时即快照；
- 同一 Error 跨阶段 ID 相同；
- stage map 精确；
- 同 key 去重；
- 不同 kind 组装不同文件；
- 成功无事件不调用 store。

### 审查重点

- 关闭时 factory 是否返回 null 且不编码 args；
- 动态值是否在取得时快照而非 publish 时；
- 是否存在裸 stage 字符串散落 Runner；
- 每 kind artifact 是否自包含所引用 Error/writeback。

### 回滚点

尚未接 Runner时可删除；接入后须和 Runner 批次一起回滚。

## 实施批次：统一 writeback wrapper

### 目标

捕获 Runner 顶层 running/completed/failed writeback，以及当前 Provider callback 实际存在的 running update/report；不宣称支持未来 callback terminal status。

### 任务

在 `runner.ts` 新增内部 helper 或使用 capture 方法：

- 顶层 initial running writeback；
- 当前实际 `ToolExecutionContext.updateToolItem({status:"running"})` callsite，role=`provider_running_update`；
- `reportRunningOutput()`，role=`provider_running_report`；
- completed writeback；
- inner failed writeback；
- outer failed writeback；
- policy/recovery failed writeback。

wrapper 必须保持原 API 调用参数和异常传播，不包装 Error。

虽然 `updateToolItem` 类型允许 completed/failed，本期不得自动归类 Provider callback terminal status。新增该 callsite 前必须扩展 stage/role/产品矩阵/测试；现阶段测试应阻断。

为准确处理 Abort：

- wrapper 先记录 pending failed attempt；
- 调用层判定 Abort-like 后标记该 error 为 cancelled observation，不生成 runtime event；
- 非 Abort 时 commit 对应 runtime stage。

### 验证

- 开关关闭前后，mock API 调用次数、顺序、参数、return/throw 相同；
- 开启时每个 output 在 invoke 前快照；
- API 返回 item 被快照；
- writeback reject 原始 Error identity 保持。

### 审查重点

- 是否漏掉当前 Provider 两个 running 回调；
- 是否错误地把类型允许的 callback completed/failed 当成本期支持；
- 是否因 wrapper 改变 `updatedAt` 时机或次数；
- 是否把 writer await 放进 API 调用热路径；最终 publish 只能在生命周期末端。

### 回滚点

wrapper 与 capture 接入作为一个原子批回滚；不得只回滚某些 writeback 造成捕获不完整。

## 实施批次：普通 executeTool/tool/runtime 接入

### 目标

补齐 Provider 根因和 completed writeback 数据窗口。

### 任务

- `executeToolSafely()` 创建 capture、finally 发布；
- `executeTool()` 接收 capture 和显式 phase；
- Provider 调用前 record start；
- fulfilled 后下一步立即快照 result；
- reject 非 Abort 记录 `provider_execute_rejected`；
- 仅从 subtask/通用合同规定的自有 data property 提取 partial result；accessor 不调用、不提取；
- completed output 在写回前快照；
- completed writeback reject 记录 `completed_writeback_failed`；
- failed writeback reject 记录 `failed_writeback_failed`；
- outer catch 只对未准确分类异常添加 `runner_outer_unhandled`；
- outer failed writeback 记录 `outer_failed_writeback_failed`；
- 保持现有 writeItemLog、输出文本和状态语义。

### 验证

优先运行阻断用例：

- Provider reject；
- Provider fulfilled + completed writeback reject；
- inner+outer 多阶段；
- Provider 中间 output；
- 成功无文件；
- writer 失败不影响主流程。

### 审查重点

- result 快照是否确实发生在任何后处理前；
- Provider fulfilled 是否绝不误生成 tool kind；
- Error 同一传播链是否没有重复根因；
- `AgentToolOutput` 是否包括 text/result/error 等实际字段。

### 回滚点

整体回退到统一 writeback wrapper前的冻结行为；capture/store 模块可保留未使用，但发布前应清理死代码。

## 实施批次：Policy 与 Recovery 接入

### 目标

覆盖不进入标准 Provider 成功/失败链的工具失败。

### 任务

抽取 standalone helper，分别接：

- pending 预检 disabled → `policy/tool_disabled_pending_precheck`；
- executeTool 二次 disabled → `policy/tool_disabled_execute_check`；
- initial running recovery → `recovery/running_item_recovered_as_failed`。

必须复用：

- capture factory；
- failed output 构造；
- writeback wrapper；
- finally publish；
- event dedupe。

### 验证

- 两条 policy stage 各自准确；
- Provider 均不执行；
- recovery 不重放；
- recovery resultAvailability=`not_started`；
- failed writeback 再失败时另有 runtime 文件；
- 重复 helper 事件去重。

### 审查重点

- 是否为避免重复错误地删除了任一禁用检查；
- 固定错误文本/状态是否保持；
- standalone helper 异常语义是否和当前分支一致。

### 回滚点

仅回滚 policy/recovery 接入，不影响已完成的普通 executeTool 捕获。

## 实施批次：取消、降级、并发与安全回归

### 目标

证明旁路能力没有扩大错误范围或破坏主流程。

### 任务

补齐：

- 调用前 abort；
- Provider AbortError；
- signal abort + 连接错误；
- 取消前已有独立非取消错误；
- finalizeToolText 降级不记录；
- Debug Dump 失败不记录；
- writer 失败不记录 writer 错误；
- bash/subtask 并行 capture；
- safe path collision/concurrent publish；
- fully supported capability 成功发布；
- unsupported no-follow/hard-link/EXDEV/只读/权限安全失败；
- callback terminal status 阻断；
- 关闭无 encoder/store 调用。

### 验证

运行所有 Worker tests、typecheck/build，并做隔离工作区手工 smoke test。

### 审查重点

- Abort 判定顺序；
- writer 是否在 finally 但不改变 return/throw；
- 并行是否共享错误 capture；
- warning 是否限频、单行、最多 512 个 JavaScript 字符单元且不输出 payload；该限制是否只作用日志。

### 回滚点

若发现状态机回归，优先回退最近接入批，不通过放宽测试掩盖。

## 文档与代码同步

实现定稿后必须回看本目录：

- 更新代码地图行号范围和实际文件名；
- 若内部函数名变化，更新引用；
- 确认环境变量、路径、枚举、stage 映射一个字符不差；
- 将状态从“设计定稿”更新为“已实现并验收”，前提是所有完成定义满足；
- 不把未实施的后续事项写成当前能力。

## 独立审查流程

每个关键批次至少有一次非作者审查；最终必须有一次全局审查，审查输入包括：

- 本目录全部文档；
- 实现 diff；
- 测试命令和输出；
- 手工验收证据；
- 已知非本次失败列表。

审查结果：

- 通过：记录通过范围和剩余非阻断风险；
- 不通过：列出阻断项、对应合同、修复方案；
- 修复后必须复审，不能由原作者自判关闭阻断项。

## 推荐提交/回滚边界

虽然本文不要求执行 Git 操作，但开发时建议保持以下原子变更边界：

| 边界 | 内容 | 回滚影响 |
|---|---|---|
| 编码器 | `losslessValueGraph` + tests | 无生产行为影响 |
| 安全存储 | safe I/O + store + tests | 无 Runner 行为影响 |
| capture | config/entity/capture + tests | 未接 Runner时无行为影响 |
| writeback 接入 | wrapper + 普通 executeTool + tests | 工具执行核心，必须整体回滚 |
| 特殊分支 | policy/recovery + tests | 可独立回滚 |
| 收尾 | cancel/concurrency/docs | 不应引入新业务行为 |

不得使用 git reset/checkout 等覆盖用户未知变更；发现非预期工作区改动时视为用户修改，停止并核对。

## 最终验证顺序

```bash
# 编码器和存储
npx tsx --test \
  apps/agent-worker/src/runtime/losslessValueGraph.test.ts \
  apps/agent-worker/src/runtime/toolErrorStore.test.ts

# Runner 聚焦
npx tsx --test \
  apps/agent-worker/src/runtime/runner.tool-error-store.test.ts \
  apps/agent-worker/src/runtime/runner.cancel.test.ts \
  apps/agent-worker/src/runtime/runner.tool-output.test.ts

# Worker 全量
npx tsx --test $(find apps/agent-worker/src -name '*.test.ts' -print | sort)
npm run typecheck -w apps/agent-worker
npm run build -w apps/agent-worker

# 仓库回归
npm run typecheck
npm run build
```

命令必须以执行时 package scripts 为准。不得声称运行/通过未实际执行的命令。

## 完成定义

开发完成必须同时满足：

- `AWB_TOOL_ERROR_STORE_ENABLED=1` 精确启用合同有自动测试和真实启动证据；
- 关闭路径零诊断编码、零诊断文件 I/O；
- 四种 failureKind 和所有固定 stage 实现、测试、文档一致；
- 完整 args/result/partial/output/Error 保真图测试通过；
- completed writeback 数据丢失窗口已补齐；
- policy 双路径、running recovery、Abort、降级均符合矩阵；
- canonical/conflict、symlink/no-follow、权限、临时文件、排他发布测试通过；
- writer 错误隔离和 warning 限频通过；
- shared/API/DB/Prompt/UI/Git 非目标未被修改；
- Worker 全量测试、typecheck/build 通过；
- 独立审查通过；若首次不通过，修复并复审通过；
- 文档没有关键 TODO 或由开发者自行决定的合同。
