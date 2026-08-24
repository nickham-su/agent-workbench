# Artifact 边界设计

## 定位

0006 已冻结：

```text
Context Writeback 决定 artifact 生成/写入时机
Context Query 负责 artifact 应用读取
共享 artifact capability 负责安全路径和文件 I/O
```

P5 已落实为如下窄边界：

```text
ContextWritebackApplication → UiArtifactCapability ← AgentService Query
```

- `ContextWritebackApplication` 仍决定初步/最终 fence 之间何时为哪种 tool/status 生成 artifact、何时 slim result，以及 best-effort 日志政策；
- `UiArtifactCapability` 仅封装固定的 apply_patch/write artifact 路径、JSON payload 读写和受限安全 I/O，不暴露任意路径或通用 filesystem API；
- Query 在完成自身 item/tool/toolCallId 校验后直接读取 capability，不依赖 Writeback；
- `safe-file-io.ts` 是机械提取的 root containment/no-follow 原语，compaction snippet 仍只依赖这些原语，不依赖 artifact capability 或 Writeback。

`prepareUpdateArtifactsLegacy()` 及其 P4 callback 已删除。

本阶段必须定稿该责任分界，但默认不改变 artifact 的文件格式、路径、写入/DB 顺序和失败政策。

## 当前已确认 artifact

### apply_patch UI artifact

路径：

```text
<tmpRoot>/agent/ui-artifacts/apply_patch/<workspace>/<toolCallId>.json
```

当前由 completed `apply_patch` update 生成。full result 经 `splitApplyPatchResult()` 拆分为：

- `artifact`：UI 展示需要的 before/after 等详细信息；
- `slim`：写入 context item DB 的精简 result。

## 已确认：write UI artifact

P0 已确认 write UI artifact 属于 API update writeback 主链。相关符号为：

```text
splitWriteResult()
writeUiArtifactPath()
getWriteUiArtifact()
write completed/cancelled/failed integration tests
```

`updateContextItemFromWorker()` 在初步 fence 后识别终态 write：

- completed 调用 `splitWriteResult()`，best-effort 写 `writeUiArtifactPath()`，并以 slim result 执行最终 fence；完整 args 保留；
- failed/cancelled 不 split、不写 artifact、不替换 result；
- `getWriteUiArtifact()` 是独立 Query 读取点；缺失文件为 404，workspace artifact 目录越界 symlink 实测为 `400 Invalid path`。

write 纳入 P5，但不能因共享 capability 抹平它与 apply_patch 的触发和内容差异。

## 当前写入顺序

apply_patch 与 completed write update 的当前顺序必须作为 P0 的冻结对象：

```text
初步 DB fence
  → 识别 tool/status
  → split full result
  → 构造 artifact path
  → 路径/目录/realpath 安全检查
  → best-effort 写 artifact
  → nextOutput 替换为 slim result
  → 最终 updateContextItemWithRunFence()
```

这意味着 artifact 文件写入发生在最终事务 fence 之前。可能出现：

- 初步 fence 允许；
- artifact 写入成功；
- 最终 fence 因 run terminal/切换而返回 unchanged；
- 文件存在但 DB item 未采用 slim output。

本阶段不能静默把它改成“DB 后写文件”、临时文件提交、回滚删除或 outbox。P0 已由源码和集成链路确认顺序；final fence 后文件副作用仍需受控竞态 characterization，若要改变则暂停并单独设计行为迁移。

## 当前失败政策

### 路径越界

写入侧发现目标目录不在 `tmpRoot` 下时：

- 记录有限 error；
- 跳过 artifact；
- 继续 slim result 和最终 DB update。

### 缺少 toolCallId/workspaceId

- 记录有限 warning；
- 跳过 artifact；
- 继续 slim result 和最终 DB update。

### 安全目录或写文件失败

- 记录 error；
- 不向 Worker 返回新错误；
- 继续最终 DB update。

### Query 读取失败

静态源码可确认以下情况显式映射为当前 `404 ... artifact not found`：

- item/tool 类型不匹配；
- toolCallId 缺失；
- 文件缺失或非普通文件；
- no-follow 读取失败；
- JSON 解析失败。

但 `ensureRealPathUnderRoot()` 当前位于读取 `try/catch` 之外；realpath 失败、symlink 逃逸或底层 `Invalid path` 是否已由全局错误处理稳定映射为 artifact 404，不能仅凭静态代码宣称。P0 必须通过 API 定向测试冻结：

- 路径 containment 失败的实际 status/body；
- symlink、目标消失等 realpath 失败的实际 status/body；
- apply_patch Query 的稳定映射；若 write 被纳入，再比较两条 Query 是否一致。

本阶段默认不改变已确认的映射；若产品基线要求将上述 realpath 失败统一改为 404，而当前实际不是 404，则属于行为修复，必须先触发停止并单独决策，不能在 capability 提取时顺手改变。

## 当前安全 I/O 基线

### Path constructors

```text
apps/api/src/infra/fs/paths.ts
  applyPatchUiArtifactPath()
  tmpRoot()
```

`writeUiArtifactPath()` 已由 P0 确认为 write completed 的受控写回路径。

workspaceId/toolCallId 通过受控 segment 清洗后进入路径。

### Safe directory creation

当前 helper：

```text
ensureDirSafeUnderRoot(rootAbs, dirAbs)
```

行为包括：

- resolved path 必须是 root 的严格子目录；
- root 创建后 realpath 校验；
- 逐层 `lstat`；
- 遇到 symlink 拒绝；
- 非目录返回冲突；
- 每层 realpath 均保持在 root 内。

### Realpath check

```text
ensureRealPathUnderRoot(rootAbs, targetAbs)
```

使用 root/target realpath，拒绝 escaping target。

### No-follow file I/O

```text
writeFileNoFollow()
readFileNoFollow()
```

使用 `O_NOFOLLOW`（平台可用时）打开文件，并确保 handle 关闭。

### 跨域复用现状

上述安全 helper 当前不仅服务 UI artifact，也被 compaction snippet cache 的读写路径复用。因此 P5 不得简单“把 helper 从 Service 移到 Artifact 目录”后迫使 Compaction / Archive 依赖 Context Writeback 或 UI artifact 业务层。

允许的处理只有两类：

- 提取真正无业务语义的受控文件安全原语，由 artifact capability 和既有 compaction snippet 路径分别依赖；
- 若无法在不扩大本阶段范围的前提下机械等价提取，则暂时保留底层 helper 位置，只为 apply_patch 建立更窄的 artifact wrapper/capability；write 仅在 P0 纳入后扩展。

无论选择哪一类，都必须满足：

- 不迁移或重写 compaction snippet 业务；
- 不让 Compaction / Archive 依赖 Context Writeback；
- 不为一次提取创建全局 filesystem service；
- 以现有 compaction snippet 回归证明安全 helper 的调用行为未漂移。

## 目标 Artifact capability

### 职责

共享 capability 只负责：

- 受控 artifact path；
- 安全目录创建；
- realpath/root containment；
- no-follow JSON 写入；
- 普通文件/no-follow JSON 读取；
- 将底层 fs 错误返回给调用方或以明确 result 表达。

它不负责：

- 判断何时生成 `apply_patch` artifact，或 P0 纳入后的 `write` artifact；
- 拆分 full/slim result；
- 决定 DB update；
- 映射 Worker response；
- 映射 Query 404；
- 记录业务语义日志；
- 清理所谓“孤儿 artifact”。

### 候选最小接口

具体名称在 P2/P5 前复核，候选：

```text
writeApplyPatchArtifact(input)
readApplyPatchArtifact(input)
```

或者更底层：

```text
writeJsonArtifact({ kind, workspaceId, toolCallId, payload })
readJsonArtifact({ kind, workspaceId, toolCallId })
```

选择标准：

- 不把业务判断塞进通用 kind switch；
- 不允许任意相对/绝对路径输入；
- payload 类型边界清晰；
- Query/Writeback 可共同依赖；
- 不为 compaction/archive 建立过度通用 filesystem framework。

初稿倾向先保留 apply_patch/write 显式方法，不开放任意 path。两者可共享底层安全原语，但业务 trigger/split/payload 继续分别表达。

## Writeback 与 capability 的分工

Writeback application 继续决定：

- 哪些 status/tool 触发；
- 何时 split result；
- payload 的业务字段和 createdAt；
- capability 失败时记录何种有限日志；
- 失败后是否继续 DB update；
- 将 nextOutput 改为 slim result；
- 最终 Store fence 调用顺序。

Artifact capability 只执行安全 I/O，不知晓 context item status、run fence 或 response。

## Query 与 capability 的分工

Context Query 继续决定：

- session/item ownership 查询；
- item 是否为目标 tool；
- toolCallId 提取；
- capability 的读取调用；
- 保持 P0 已确认的读取失败 status/body 映射。

Query 不得调用 Context Writeback application，Writeback 也不得反向调用 Query。

本阶段可以让 `AgentService.getApplyPatchUiArtifact()` 与 `getWriteUiArtifact()` 通过 capability 读取，以证明共享边界。这里不要求完成 Context Query 模块化或 Route 重组。

## Artifact 与 persistence 的非事务性

当前 filesystem 与 SQLite 不构成全局事务。本阶段明确不引入：

- 两阶段提交；
- outbox；
- artifact DB record；
- durable cleanup queue；
- generation/lease；
- 跨文件/DB rollback。

如果 P0 证明现有顺序会产生不可接受的真实产品问题，应停止本结构阶段并单独设计一致性方案；不能在 P5 顺手修正。

## P5 迁移策略

### P5-A：安全 I/O capability

- 先盘点 root/path/no-follow helper 的全部调用者，包括 compaction snippet cache；
- 仅提取与业务无关且可机械等价证明的受控文件安全原语，或保留原 helper 并建立 artifact 专属 wrapper；
- 先建立相同输入输出和安全失败测试；
- 不改 path constructors 和文件格式；
- Query 与 Writeback 均改为依赖 capability；
- 只有所有调用者都已安全迁移且未形成跨域反向依赖时，才删除 service 内重复 fs helper。

### P5-B：Writeback artifact 编排

- 将 apply_patch 触发、split、payload 和日志编排迁入 Writeback application/collaborator；
- 保持初步 fence → write → final fence 顺序；
- 保持失败后继续 slim DB update；
- 机械等价迁移 write 的 completed trigger/split/payload/失败行为，并保留 failed/cancelled 不写 artifact、不 slim 的差异；
- facade 仅委派。

P5-A/P5-B 若改动面过大，必须作为两个独立审查批次；不能以“P5 已设计”为由一次性合并。

## 必须测试的安全与顺序

- apply_patch completed 成功写 artifact、DB result 已瘦身、Query 可读；
- artifact 缺失返回 404；
- symlink/realpath/path containment 安全边界；
- realpath/containment 失败的当前 API status/body 已被定向 characterization 冻结，迁移后机械等价；
- 写失败/路径失败不改变 Worker update success 与 slim DB 行为；
- 初步 fence unchanged 时不尝试 artifact；
- final fence unchanged 时既有文件副作用事实被明确冻结；
- 日志不打印 artifact 内容、tool args/result 或敏感绝对路径。

write 已由 P0 纳入；P5 必须在上述矩阵基础上保留 completed/failed/cancelled、args/result、artifact 生成和 Query 读取证据；不得把测试名当作唯一依据。

## 停止条件

以下任一情况必须暂停：

- 需要改变 artifact JSON 格式或路径；
- 需要改变文件写入和 final DB fence 顺序；
- 需要将写失败改为 HTTP/Worker failure；
- 需要自动删除 final-fence 后的 orphan file；
- 需要把 archive/compaction 文件能力并入同一通用层；
- 共享 capability 必须接收任意 path 或完整 `AppContext`；
- Query 必须依赖 Writeback 才能读取；
- 为测试安全 I/O 必须关闭路径/realpath/no-follow 断言。
