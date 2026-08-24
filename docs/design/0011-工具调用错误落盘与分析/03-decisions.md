# 关键决策、取舍与风险

## 决策摘要

| 主题 | 定稿决策 |
|---|---|
| 启用方式 | 默认关闭，仅 `AWB_TOOL_ERROR_STORE_ENABLED=1` 启用，进程启动时读取 |
| 存储位置 | 工作区 `.awb/agent/tool-errors/by_run/...` |
| 数据定位 | 本地、best-effort、诊断/离线分析，不是集中遥测或审计源 |
| 记录对象 | 失败工具调用及其 policy/recovery/runtime/writeback 多阶段事件 |
| 成功与取消 | 成功不记录；Abort/用户取消不记录为错误 |
| 数据完整性 | 不脱敏、不做业务内容截断、不设 max-bytes；保存 Worker 已取得的完整 args/result/output/Error |
| 多阶段 | `tool/policy/recovery/runtime` 多文件；同 kind 内用 `events` 表达多个阶段 |
| 幂等 | canonical 排他发布；身份一致视为幂等，身份冲突写 conflict 文件，绝不覆盖 |
| 安全 | containment、safe segment、逐级拒绝 symlink、no-follow、严格权限、临时文件与原子/排他发布 |
| 系统边界 | 不改 shared schema/API/DB/Prompt，不上传，不自动清理，不自动改 `.gitignore` |

## 默认关闭而非默认开启

### 选择

```text
AWB_TOOL_ERROR_STORE_ENABLED=1
```

只有精确值 `1` 启用，其他值关闭。

### 原因

- 完整参数和结果可能体量很大并包含敏感业务数据；显式开启建立清晰的部署者选择边界。
- 本期不做自动清理和容量配额，默认开启会把磁盘增长风险施加给所有工作区。
- 诊断能力不是 Agent 正常完成任务的必要条件，不应默认增加序列化和文件 I/O。
- 模块级读取与现有 `AWB_AGENT_DEBUG_DUMP` 风格一致，行为简单可测。

### 不采用

- **默认开启**：与完整数据、不清理的组合风险过高。
- **Settings/UI 开关**：会扩大 API、数据库、前端和配置传播范围。
- **接受 truthy/yes/on**：增加歧义，不利于部署和验收。

## 记录完整数据而不脱敏、不截断

### 选择

必须完整记录 Worker 已经取得、可由保真编码器观察的数据：

- 模型 tool-call 的 `tool.args`；
- Provider returned result；
- 异常自有 data property 携带且符合固定提取规则的 partial result；
- 拟写回和已写回的完整 `AgentToolOutput`；
- Error 可定位的 data property、标准语义字段状态和自有属性 descriptor；
- 非 Error thrown value。

不做按字段名脱敏，不设置业务长度、数组项、递归深度或单文件字节截断。

### 原因

- 用户明确判断：能发送给模型的信息没有必要在本地诊断文件中再次脱敏。
- 工具错误优化常依赖真实参数、完整命令、完整输出和边界字段；摘要可能掩盖根因。
- Provider 成功后 writeback 失败的核心价值正是保留无法进入 context item 的完整 result。
- 默认关闭、不上传和严格工作区权限承担数据暴露风险。

### 代价

- 文件可能很大；序列化会有 CPU、内存和磁盘成本。
- 本地用户或其他同权限进程可以读取这些信息。
- 工作区若未忽略 `.awb/`，文件可能出现在 Git 未跟踪列表。
- 极端对象图可能导致序列化时间和内存显著增长。

### 对策

- 功能默认关闭；只在明确诊断环境开启。
- 不自动上传；不把路径放进模型上下文。
- 目录/文件权限尽可能严格；不跟随 symlink。
- best-effort writer 与 Agent 主流程隔离。
- 文档提示用户按需忽略 `.awb/`、监控磁盘并人工清理。
- 不通过静默截断“解决”磁盘风险；若未来需要 retention，单独设计并明确与完整合同的关系。

### 不采用

- **复用 `sanitizeForDebugDump()`**：它会把 token/secret/password 等字段改为 `***`，违反完整记录合同。
- **只保存 args shape/digest**：不足以定位真实工具调用问题。
- **单文件 max-bytes 截断**：会制造“存在文件但关键尾部数据缺失”的假完整性。

## 采用版本化保真图编码，而非原生 JSON 值

### 选择

顶层文件仍是 JSON，但所有动态运行时值通过 `LosslessValueGraphV1` 表达，而不是直接 `JSON.stringify(args/result/error)`。

### 原因

原生 JSON 无法无歧义表达：

- `undefined`、BigInt、Symbol、Function；
- `NaN`、`Infinity`、`-Infinity`、`-0`；
- 循环引用和共享引用；
- Error 的非枚举 `name/message/stack/cause`；
- Map、Set、Date、RegExp、URL、ArrayBuffer、typed array；
- accessor descriptor 与不可用语义；
- 对象的 symbol-key 自有属性。

直接 JSON stringify 还可能抛错或静默省略字段。保真图使用 node id/ref 保留对象图关系，并用明确 tagged node 表示特殊值。

### 边界

- 保真是“可观察值语义保真”，不是 JavaScript 进程内对象的可执行重建。
- “可观察值”只包含运行时已经持有、descriptor 反射可取得的 data value；编码器不得为采集执行普通对象或 Error 自定义 getter/accessor、`toJSON()` 或自定义 `toString()`。
- 自有 string/symbol property 通过 `Object.getOwnPropertyDescriptors()` 或等价反射取得；data property 保存 value 与元数据，accessor 只保存 descriptor 与 getter/setter 标识。
- Error `name/message/stack/cause/errors` 若定位到 accessor，标记 `unavailable_accessor`；不存在标记 `absent`；反射本身失败标记 `reflection_error`，不调用 getter兜底。
- Function 记录名称、源码字符串或原生表示，不反序列化执行。
- Symbol 记录 global key/description/唯一 node 身份，无法跨进程恢复原始唯一 Symbol 身份。
- Proxy 可能让 descriptor/原型反射抛错；编码器记录 `reflection_error` 并局部降级。该状态只表示反射操作自身失败，因为 getter 从不执行。
- Provider callback 本期只覆盖当前实际存在的 running `updateToolItem` 与 `reportRunningOutput`；类型虽允许 callback 写 `completed|failed`，但当前无 callsite，未来必须先扩展 stage、role、行为矩阵和测试，不能自动归类。
- WeakMap/WeakSet 内容不可枚举，只记录类型和不可观察标记。

不主动执行 accessor 会牺牲其计算值，但避免采集过程执行用户代码、产生副作用或改变错误现场；这是“完整保存已取得 data value”与运行时安全之间的定稿边界。

### 不采用

- **JSON replacer 仅转 BigInt/Circular**：无法保留共享引用、Error 非枚举字段和 symbol key，规则不完整。
- **Node `v8.serialize` 二进制**：不便人工审查和跨语言离线分析，且文件合同不是 JSON。
- **`util.inspect` 文本**：不是稳定结构化格式，无法可靠机器消费。

## 按 run 分目录

### 选择

```text
.awb/agent/tool-errors/by_run/<safeSessionId>/<safeRunId>/<itemId>-<safeToolCallId>.<failureKind>.json
```

### 原因

- 一次 Run 的失败自然聚合，便于本地复盘和按 Run 清理。
- `itemId` 加入文件基名，降低 safe toolCallId 碰撞风险。
- 不依赖 toolCallId 全局唯一。
- 工具名保留在 JSON 中，离线统计仍可按工具聚合。

### 不采用

- **按 toolName 目录**：人工按工具浏览方便，但同一 Run 时间线分散，toolCallId 唯一性要求更强。
- **共享 JSONL**：并行工具、多 Worker/重启下追加和锁语义复杂，单条损坏会影响整文件。
- **写入 API `.data`**：不再是工作区本地边界，并引入 Worker/API 共享存储假设。

## 多 kind 多文件，同 kind 单文件多事件

### 选择

固定四种 kind：

```text
tool | policy | recovery | runtime
```

- 不同 kind 使用不同文件并可共存。
- 同 kind 的多个 stage 写入同一文件 `events` 数组。

### 原因

- Provider 根因与 runtime/writeback 次生错误必须分开，便于统计时区分工具质量和宿主稳定性。
- 同一 runtime kind 可有多次写回失败；若每个 stage 单独文件会产生不受控文件数和命名分歧。
- 同 kind 单次发布可以在 `executeToolSafely()` 最外层收敛完整事件，避免内层先写后外层无法更新的问题。

### 不采用

- **每次调用只写一个文件**：混合根因分类，tool/runtime 分析困难。
- **每个 stage 一个文件**：文件名和阶段演进强耦合，新增 stage 破坏目录消费方。
- **内层 catch 立即发布**：后续 failed writeback/outer 异常无法追加；覆盖会丢根因，不覆盖会丢次生错误。

## 延迟发布而非每个 catch 立即写

### 选择

启用时，为每次工具调用创建内存 `ToolFailureCapture`。args、Provider result、writeback output/响应和 Error 在各自取得时立即编码为不可变保真快照，各阶段追加快照与事件；`executeToolSafely()` 在调用生命周期结束时统一发布所有非空 kind 文件。policy/recovery 等不经过标准 executeTool 生命周期的分支，也必须通过同一 capture helper 完成后发布。

### 原因

- 能收集 completed writeback、failed writeback、outer catch 的完整时间线。
- 每个 kind 只需一次 canonical 发布，无需修改已发布文件。
- 能对同一异常跨边界传播做 `errorId` 去重和关联。
- writer 失败集中处理，避免每个 catch 重复样板和递归风险。

### 代价和对策

- Worker 进程在发布前崩溃会丢失内存事件；本能力已定义为 best-effort，不保证完整审计。
- 极大 args/result 的立即保真编码会增加 CPU 和内存；只在开关开启时承担。
- 即使调用最终成功，开启状态也会发生内存快照，但不得落盘；这是防止异步突变导致错误文件不再反映获取时数据的必要代价。
- 捕获对象不得同时长期保留原始大对象和重复深拷贝；保真快照完成后只保留编码结果及业务流程本来需要的引用。

## 首次发布胜出、身份冲突另存

### 选择

canonical 文件通过排他原子发布。已存在时读取并校验原始身份：

- 身份一致：幂等成功，不覆盖；
- 身份不同或不可校验：写 `.conflict-<recordedAt>-<attempt>.json`，绝不覆盖。

### 原因

- 重启、重复 pending 或意外重复调用不会改写第一份诊断证据。
- safePathSegment 可能把不同原始 ID 映射为相同路径；JSON 身份校验可识别。
- `itemId` 大幅降低但不能数学上消除所有冲突，仍需确定性处理。

### 不采用

- **直接 overwrite**：根因证据可能被后续异常覆盖。
- **已存在一律忽略**：safe segment 冲突时会静默丢记录。
- **随机冲突名**：不利于可重复测试和离线排序；采用 timestamp + 递增 attempt。

## 仅在 hard-link 与 no-follow 同时支持时发布

### 选择

- fully supported 环境必须同时支持同目录 hard link 与 Node no-follow 打开语义（`O_NOFOLLOW` 或项目独立安全评审认可的等价能力）。
- 主要验收基线是项目当前 Linux 本地运行环境；是否支持由能力测试判定，不按文件系统名称直接承诺。
- 不支持 hard link/no-follow、跨设备、只读、权限不足等工作区安全失败，不发布 final 文件。

### 原因

- hard link 提供不覆盖既有 final 的排他发布；普通 rename 在目标存在时可能覆盖，违反首次发布胜出。
- no-follow 防止打开攻击者预置的 symlink；把缺失 `O_NOFOLLOW` 降级为 `0` 会制造虚假的安全保证。
- 功能是旁路 best-effort 诊断，能力不足时不落盘优于降低安全性后勉强落盘。

### 不采用

- **普通 rename fallback**：可能覆盖 final，不采用。
- **缺少 no-follow 时继续 open**：可能跟随 symlink，不采用。
- **回退到系统临时目录或 API 数据目录**：破坏工作区本地边界，不采用。
- **按 OS/文件系统名称白名单推断支持**：部署挂载与能力差异无法由名称可靠证明，不采用。

## 本地诊断而非集中审计

### 选择

`.awb/agent/tool-errors` 是工作区本地、best-effort 的诊断数据源。

### 原因

- Worker 已有 `workspacePath`，接入成本小。
- 不需要新增 API、数据库迁移、隐私上传合同和中心清理策略。
- 文件可跟随具体工作区复盘。

### 明确不承诺

- 每条错误必达；
- 跨 Worker/机器集中检索；
- 防篡改、签名、WORM、法务审计；
- 工作区删除后的保留；
- 统一 retention 和用户授权上传。

未来若要平台级统计，必须另行设计 API/DB 事件、授权、采样、保留和删除能力，不能把本地文件悄然升级为遥测。

## 不修改 shared/API/Prompt

### 选择

- 不修改 `AgentToolOutputSchema`；
- 不新增内部 endpoint；
- 不把错误路径写入 output；
- 不在 Worker 复制 API projector。

### 原因

错误文件是旁路诊断，不是业务状态。把路径放进 context 会扩大 schema、数据库、Prompt 和 UI 语义，还可能让模型主动读取完整错误文件。本期只保存 Worker 源数据，并明确 API 最终消息不在本期复刻。

## 不自动清理和不自动改 `.gitignore`

### 选择

- 本期不清理；由工作区拥有者删除。
- 不修改任何用户 Git 配置。

### 原因

- 自动清理需要产品定义保留期限、容量、并发删除和诊断证据优先级；本期没有这些授权。
- 运行时修改 `.gitignore` 是对用户项目的持久业务修改，可能不符合仓库策略。

### 使用建议

用户若不希望 Git 显示运行产物，应自行添加：

```gitignore
.awb/
```

该提示不是运行时行为。

## 主要风险与对策

| 风险 | 影响 | 本期对策 | 剩余风险 |
|---|---|---|---|
| 完整数据暴露 | 本地敏感信息可读 | 默认关闭、不上传、严格权限、不进 Prompt | 同用户权限进程仍可读 |
| 磁盘增长 | 超大 JSON 或大量错误耗尽磁盘 | 显式开启、best-effort、人工监控/清理 | 无自动配额，长期开启风险仍在 |
| 序列化 CPU/内存 | 极大/复杂对象图影响 Worker | 仅错误且仅开启时编码；捕获期不深拷贝 | 单条极端对象仍可能昂贵 |
| 进程崩溃 | 发布前事件丢失 | 临时文件+原子发布避免半文件 | 内存 capture 未发布不保证保留 |
| accessor 副作用 | 采集时执行用户代码、改变错误现场 | 只读 descriptor；accessor 不求值，语义字段固定为 data/unavailable_accessor/absent/reflection_error 四态 | accessor 计算值不会进入 artifact，这是明确边界 |
| 平台/文件系统能力不足 | 无法安全发布 final | hard-link 与 no-follow 同时满足才发布；否则清 temp、限频 warn、主流程不受影响 | unsupported 工作区没有错误文件 |
| symlink/路径逃逸 | 写出工作区或覆盖其他文件 | containment、逐级 lstat/realpath、no-follow、发布前后复核、排他 hard link | Node path-based API 无法形式化抵御同权限进程在校验/发布间主动替换父目录；本期明确为剩余风险 |
| safePath 碰撞 | 错误关联到错误调用 | itemId 基名、JSON 原始 ID 校验、conflict 文件 | 冲突文件可能积累 |
| 双 catch 重复 | 同一异常重复统计 | errorId、事件去重键、统一最终发布 | 非同一对象但同源包装异常仍会作为两个事件保留 |
| writer warning 洪泛 | 日志噪声或多行污染 | 60 秒限频；换行替换为空格；整行最多 512 个 JavaScript 字符单元；只含必要元数据和错误摘要 | 日志摘要会截断，但 artifact 不截断 |
| API projector 漂移 | 文件不等于模型最终消息 | 明确保存 Worker 源数据，不承诺最终 message | 离线消费者需理解该边界 |

## 后续但非本期事项

以下不是开发 TODO，不影响本期完成：

- 集中式 API/DB 采集与用户授权；
- retention、容量配额、压缩；
- UI 查看器和 lossless graph 展示工具；
- Provider 统一 partial result 合同；
- MCP 取消信号透传；
- API projector 最终消息的独立可观测能力。
