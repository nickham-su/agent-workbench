# Archive Storage 与 Sidecar 设计

## 设计目标

建立一个只负责 Archive filesystem 与保守补偿的能力边界，使 application 不直接操作 path/fs/snapshot/sidecar，同时保持：

- archive 文件格式和分卷不变；
- append snapshot 语义不变；
- rollback 只在 exact-size 时 truncate；
- sidecar 只在 rollback skipped 时产生；
- multi-file sidecar 不自动 reconcile；
- search/read/excerpt 的现有文件读取语义不变；
- fault hook 生产默认 no-op、测试显式注入。

## 目标依赖方向

```text
CompactionArchiveApplication
  → ArchiveStorage
      ├─ archive path policy
      ├─ append + snapshots
      ├─ rollback best-effort
      ├─ pending sidecar write
      └─ per-session reconcile

Archive read facade / Read-side excerpt collaborator
  → ArchiveReader
      ├─ search
      ├─ read
      └─ excerpt by item ids / archive batch

ArchiveStorage implementation
  → filesystem primitives
  → ArchiveFaultHook
  → Logger

ArchiveStorage 不依赖：
  → DB
  → AgentService
  → Route/Fastify
  → Worker client
  → Read-side application
```

`ArchiveStorage` 与 `ArchiveReader` 可以由同一 adapter 实现，也可按文件拆分；consumer 注入面必须保持窄。

当前 helper 的 reconcile 返回值是 boolean、warning 位于 helper 内部。以下 `ReconcileResult` 等类型均为目标设计候选，不是当前代码事实。

## 候选能力面

以下命名是职责示意，不冻结最终 TypeScript API：

```ts
type ArchiveAppendSnapshot = {
  fileKey: string;
  beforeSize: number;
  expectedSize: number;
};

interface ArchiveWriteStorage {
  appendLines(command): Promise<{ snapshots: ArchiveAppendSnapshot[] }>;
  rollbackBestEffort(command): Promise<RollbackResult>;
  writePendingBestEffort(command): Promise<PendingWriteResult>;
}

interface ArchiveMaintenanceStorage {
  reconcilePendingBestEffort(command): Promise<ReconcileResult>;
}

interface ArchiveReadStorage {
  search(query): Promise<ArchiveSearchResult>;
  read(query): Promise<ArchiveReadResult>;
  findExcerptByItemIds(query): Promise<ArchiveExcerptResult>;
}
```

### Path 表达

public capability 优先使用 `fileKey` 或 opaque snapshot，不向 application 暴露任意绝对 `filePath`：

- adapter 内部将 fileKey 解析到当前 workspace/session archive root；
- rollback 与 sidecar 只接受本次 append 返回的 snapshot；
- 测试 fault 如需定位文件，应通过 hook context 或 adapter helper，不由 application 拼 path；
- 日志只记录 workspace/session/fileKey/size，不输出 archive 正文。

若为最小迁移暂时保留内部 absolute path，必须保证它不越过 adapter public surface，并在代码地图记录该取舍。

## Append 设计

### 固定行为

- 创建 session archive 目录；
- 只识别 8 位 `.log` 文件；
- 按 sequence 升序找到最后一卷；
- 使用完整行数计算当前容量；
- 每卷 100 行；
- 每 chunk append 后更新 snapshot expectedSize；
- payload 以 `\n` 结束；
- 空 lines 返回空 snapshots；
- snapshots 保持当前首次触达/追加顺序即可；当前实现没有显式排序，本阶段不新增可观察的排序契约。

### 错误模型

append 可能在：

- mkdir/readdir/read current file；
- stat；
- appendFile；
- fault hook after-chunk；

任一位置失败。

P0/P1 必须先冻结“部分 chunk 已写但 append 抛错”的现状。设计允许两种后续结论：

- **只做 characterization**：保持当前错误传播，明确这是既有局限，不新增自动恢复；
- **在不改变格式和 sidecar 政策前提下做局部安全修复**：只有能够返回/持有已写 snapshots，并用既有 exact-size rollback 证明安全时才可实施。

任何将 append 中途失败自动写成通用 pending sidecar、扩大 multi-file reconcile 或引入 staging 的方案均越界，必须另立设计。

## Rollback 设计

### 固定算法

```text
for snapshot in reverse order:
  currentSize = stat(file)
  if currentSize !== expectedSize:
    skipped
  else:
    truncate(beforeSize)
```

- rollback 是 best-effort；
- 单文件失败不阻止后续 snapshot 尝试；
- 原 DB error 永远优先；
- 返回 reverted/skipped 与 skipped snapshots；
- size mismatch 不可被“修复”为强制 truncate；
- 文件不存在、symlink/path 异常的处理必须保守。

### 为什么逆序

单次 append 可能跨卷。逆序 rollback 保持与追加相反的补偿顺序，也与当前实现一致；不得在无证据时改为并发 truncate。

## Pending sidecar 设计

### Sidecar 职责

pending sidecar 只表达：

> DB apply 未提交，Archive rollback 有文件因无法证明当前内容仍等于本次 append 结果而 skipped。

它不表达：

- DB 已提交但 run-state 后续写入失败；
- append 自身任意部分失败；
- Worker retry；
- 通用 archive repair；
- 多进程事务日志。

### 写入条件

application 只有在 rollback result 的 `skippedSnapshots.length > 0` 时调用 sidecar write。storage 不应在正常 append、成功 DB apply 或完整 rollback 时留下 sidecar。

### 原子写入

继续使用：

```text
serialize validated record
  → write tmp
  → rename tmp to fixed pending path
```

- sidecar write/rename failure 只 warning；
- 不掩盖原 DB error；
- tmp cleanup 是否需要保持/补充，应在 P0 按现状验证，不得虚构已存在；
- record version 与 operation 字段保持。

### Reconcile 安全门

自动 reconcile 必须同时满足：

- record schema/version 有效；
- workspace/session 完全匹配；
- snapshots 恰好 1 个；
- fileKey 是当前 session archive root 下合法 8 位 `.log`；
- 文件不是越界路径；
- 当前 size 精确等于 expectedSize。

只有满足全部条件才 truncate 到 beforeSize 并删除 sidecar。

### 多文件策略

多文件 sidecar：

- warning；
- 返回可诊断结果；
- 保留 sidecar；
- 不自动 truncate 任意一卷；
- 不因“各文件 size 都匹配”而顺手恢复。

该限制来自 `0006` 已冻结安全边界。改变它必须单独设计跨文件恢复一致性。

## Reconcile 结果模型

当前实现只返回 boolean，并在 helper 内直接 warning。以下 discriminated union 是后续 adapter 的候选目标，用于让 application/startup 获得可诊断结果；是否采用及具体字段由 P1/P2 定稿。

候选显式结果：

```ts
type ReconcileResult =
  | { status: "not_found" }
  | { status: "reconciled"; fileKey: string }
  | { status: "invalid"; reason: string }
  | { status: "size_mismatch"; fileKey: string }
  | { status: "failed"; reason: string };
```

最终结果可以更小，但应避免 application 通过解析 warning 文本判断状态。日志由 storage 或 maintenance use-case 负责其一，不能重复两层 warning。

## Archive read capability

### 可纳入的实现

- list files ascending；
- split complete lines，忽略潜在半行；
- archive read newest window；
- search fixed/regex；
- snippet windows 与 merge；
- `pos` 计算；
- maxChars 截断；
- itemId excerpt lookup。

### 必须保持的外部语义

- archive search/read method/path/body/response 不变；
- beforePos/lineCount/maxHits/maxChars 范围不变；
- newest-first 输出和 `pos` 不变；
- no archive 时 `noArchive` 语义不变；
- regex/snippet 行为不变；
- 最后半行过滤不变；
- truncated marker 不变。

### 不纳入

- Shared endpoint/schema；
- 新分页模型；
- body/response envelope；
- 全文索引；
- archive 内容日志；
- format migration。

## `ArchiveFaultHook` 设计

### 目标

- 由 Archive adapter 构造时显式注入；
- 生产使用 no-op；
- test fixture 注入受控实现；
- 不再读取 `ctx.agentTestFaults`；
- hook 只制造故障，不决定业务分支。

### 候选 hook

```ts
interface ArchiveFaultHook {
  afterAppendChunk?(context): Promise<void> | void;
  beforeRollback?(context): Promise<void> | void;
  beforePendingWrite?(context): Promise<void> | void;
  beforePendingRename?(context): Promise<void> | void;
}
```

实际 API 应最小化，避免为每个 fs 调用建立 hook。hook context 只包含 ids、fileKey、chunk index、size 等非正文信息。

### 迁移边界

- P1 先在独立 Archive tests 中使用 hook；
- P2 adapter 接收 hook；
- P3/P4 production wiring 从测试配置映射到 hook，生产默认 no-op；
- fork-with-archive 与其他复用 archive append primitive 的路径也必须接入同一窄 storage hook，但其 use-case 不进入 Compaction application；
- 只有上述路径全部完成窄 hook 接线后，阶段结束时才删除 `AppContext.AgentTestFaults` 的 archive 字段；若仍有路径未迁移，只允许在 composition root 保留过渡映射，并记录删除条件。

## 同 session 串行化归属

Archive storage 不拥有 session operation lock：

- lock 是 application/use-case 的调用串行策略；
- storage 对每次 command 仍必须独立做 path/size 安全校验；
- 不因有 lock 而省略 exact-size fence；
- 不在 adapter 内引入全局 map 锁，避免隐藏调用范围。

后续若提取通用 `SessionOperationSerializer`，只可作为 application collaborator，并须明确它仍仅进程内。

## 日志与隐私

允许记录：

- workspaceId、sessionId、runId；
- operation；
- fileKey；
- beforeSize/expectedSize/currentSize；
- reverted/skipped/count/status；
- error object。

禁止记录：

- summaryText；
- archive line 正文；
- prompt/messages；
- archive search query 命中正文；
- sidecar 中可能扩张的用户内容。

## 结构验收

- application 不 import `node:fs` 或 archive path helper；
- adapter 不依赖 DB、AgentService 或 RunLifecycleApplication；
- fault hook 不来自完整 `AppContext`；
- multi-file reconcile 无自动 truncate path；
- rollback 仍使用 expected-size fence；
- search/read/excerpt 共享底层读取能力但不强迫共享 transport contract；
- fork 可复用 storage primitive，但 Compaction application 不拥有 fork 业务。
