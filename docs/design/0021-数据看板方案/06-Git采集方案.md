# Git 采集方案

## 统计边界

Git 看板表示：

> 当前由 Agent Workbench 管理的本地项目中，当前可达提交历史的提交数量与变更规模。

它不是 Agent 归因、个人贡献、仅 Workbench API 操作审计、远端全部 refs 或未提交变更统计。Workspace 仅是本地 refs 发现源，Git API 不支持 Workspace 筛选、分组或展示。

## 代码现状与候选来源

- `ensureRepoMirror()` 在 `apps/api/src/infra/git/mirror.ts` fetch 远端 `refs/heads/*` 至 Mirror `refs/remotes/origin/*`。
- `cloneFromMirror()` 在 `apps/api/src/infra/git/clone.ts` 从 Mirror 初始化工作树，之后将 origin 改回真实远端。
- `commitWorkspace()` 在 `apps/api/src/modules/git/git.service.ts` 仅对 Workspace 工作树 `git -C <path> commit` 并读 HEAD；不会回写 Mirror。

每个 Repo scan 的 source 快照：

| source | eligible refs | 作用 |
| --- | --- | --- |
| 受控 Mirror | `refs/remotes/origin/*` | 已同步远端分支历史 |
| scan 开始时关联的每个 Workspace 工作树 | `HEAD`、`refs/heads/*` | detached HEAD、本地分支、未 push Commit |

- source 列表必须在 scan 开始时一次性快照；扫描过程中 Workspace 新增/删除不改变本代要求。
- 只从现有 `workspace_repos` 解析受控工作树路径；不接受客户端路径。
- 不扫描 Workspace remote refs、tags、stash 或内部 refs；Mirror 已覆盖远端 refs。
- `analytics_git_scan_source` 只存安全 source ID、种类、ref 数、状态和安全 error code，不存绝对路径、remote URL、ref 名或 Git 输出。

## 全 source 成功规则

本期准确性优先：**开始快照中的所有 eligible source 都必须成功完成读取与解析，scan 才能切换 generation。**

- 某 source 路径不存在、无法读取、不是预期 Git 工作树、refs 枚举失败、`rev-list` 失败或未知 Commit 解析失败，均使整个 Repo scan `failed`。
- 任一 source 失败时，不写部分 membership、不改 `analytics_git_repo_state.current_*`、不标 Git Dirty。
- 之前 current generation 继续用于 Dashboard，并在 Git domain freshness 中暴露 scan error/stale。
- 没有 eligible source 的 Repo scan 也视为失败，除非 Repo 已被明确删除并停止调度；不能把空集合当作成功清空。

## 单调 generation 与原子切换

```text
短事务领取 repo_state.next_generation，创建 running scan 并将 next_generation + 1
    ↓
快照并成功扫描全部 eligible sources
    ↓
合并 SHA，按 (repo_id, sha) 去重，解析未知 Commit Fact
    ↓
同一 Analytics transaction：写 Fact、完整 membership、Scan coverage、scan completed、current pointer、Git Dirty
    ↓
新 generation 的 Scan 标 completed，且成为 current
```

- scan 开始时的短 transaction 必须读取并领取 `analytics_git_repo_state.next_generation`，创建 `(repo_id,generation)` 唯一的 running scan，再将 `next_generation` 递增。新 Repo 初始化 `next_generation=1`；若并发领取冲突，后者重读重试。
- generation 对同 Repo 单调递增；失败、崩溃恢复标 failed 的 generation **不回退且永不复用**。`analytics_git_repo_state.current_scan_id/current_generation` 是 current generation 唯一权威，禁止以最大 `completed_at` 选择。
- `(repo_id, sha)` 去重跨 Mirror/多 Workspace 同一 Commit。
- scan 失败仅写 `failed/error_code`；不触碰 pointer 或旧 membership。
- 切换事务必须比较旧/新 membership，将两侧受影响 Committer Date 桶全部标 Dirty；同一 transaction 必须包含 Fact、membership、Scan coverage、`scan.status='completed'/completed_at`、pointer、Dirty，缺一不可。coverage 字段只写本次 `analytics_git_scan`，不冗余写入 Repo State。
- 对切换 transaction 的任一 SQL 写入、约束或 fault injection 失败，必须整体 rollback；旧 current pointer、旧 membership、旧 completed Scan 不变。失败后以独立 transaction 将该 running Scan 标为 failed/error_code，不能让部分新 generation 被查询。
- 同 Repo 至多一个 running scan：数据库 fence 加进程内锁。进程崩溃遗留 running scan 需可安全标 failed 后重启；不可阻塞未来 generation。

## Commit 元数据

对每个 unknown `(repo_id, sha)` 从可到达该 SHA 的已成功 source 获取：

- Committer Date，转 UTC Unix 毫秒。
- 父提交数，父数大于一即 Merge。
- 非 Merge Commit 的文件数、insertions、deletions。

命令输出必须机器可解析，文件名必须 NUL 分隔或同等稳健解析；不得解析默认人类可读文本。

| 情形 | Commit | 文件数 | 行数 |
| --- | --- | --- | --- |
| 普通 Commit | 计一 | 变更文件数 | `numstat` 数值相加 |
| Merge Commit | 计一 | 不适用，不累计 | 不适用，不累计 |
| 二进制文件 | 正常 | 计文件 | `-` 不累计 insertions/deletions |
| rename/special path | 正常 | 正确计文件 | 安全解析，不因 tab/空格/换行失败 |
| 空 Commit | 计一 | 0 | 0 |

Merge 的 `files_changed/insertions/deletions` 推荐保存 `null`，聚合只累加非 Merge 值。

## 当前可达与历史改写

- Dashboard 仅 join `analytics_git_repo_state.current_scan_id` 的 membership。
- amend/rebase/force update 后旧 SHA 若不在新 generation membership，则不参与当前统计；Commit Fact 可留存以减少重复解析。
- scan 失败绝不以部分结果删除旧 SHA 或切换到空集合。
- UI 必须标注“当前可达提交历史”，避免把 rebase 后数字变化理解为数据丢失。

## 初次回填与 coverage

- 首次启用扫描当前可达历史，默认限制最近 365 天且每 Repo 最多 50,000 Commit。
- 达到任一限制仍可完成 generation，但必须在该 completed `analytics_git_scan` 写 `coverage_incomplete=1`、`covered_from`、`coverage_reason`。
- API 只可经 `analytics_git_repo_state.current_scan_id -> analytics_git_scan` 读取当前 coverage；Repo State 只保存 current pointer、`next_generation` 与更新时间。
- 未覆盖更早区间在 API 中是“覆盖不完整”，绝不能显示为零。
- 对每个受管理 Repo 返回诊断 coverage：

```ts
type GitRepoCoverage =
  | { repoId: string; status: 'ready'; currentGeneration: number;
      coveredFrom: number | null; coverageIncomplete: boolean;
      coverageReason: GitCoverageReason }
  | { repoId: string; status: 'preparing' | 'error'; currentGeneration: null;
      coveredFrom: null; coverageIncomplete: null; coverageReason: null }
```

- Shared TypeBox/OpenAPI 必须以 `Type.Union` 建模上述 `status` 判别联合，不能用一个带可选字段的伪结构。
- current pointer 指向 completed Scan 时为 `ready`，`currentGeneration` 必须为实际 generation，其他字段取该 current Scan；尚无 completed current Scan 为 `preparing`，最近 scan 错误且没有可用 current Scan 为 `error`。后两种所有 current coverage 字段都固定 `null`，不得使用 generation `0`、`coverageIncomplete=false` 或最近 failed scan 冒充完整 coverage。
- Git 指标数值继续从所有 current Repo 的 membership 全局汇总；Repo coverage 只用于诊断展示，不增加 Repo/Workspace 筛选或指标分组。
- 普通后续 scan 不自动无限扩大历史范围；扩大范围只能通过显式回填/全量维护操作。

## 调度、删除与留存

- Git scan 独立于十分钟聚合，默认每 30 分钟；Repo sync 成功和 Workbench Commit 成功可触发该 Repo 去重 scan 请求。
- scan 遵循既有 Workspace 删除 fence、Repo lock；扫描失败不阻断 Commit/Push/Sync/删除。
- Workspace 删除后，未来 source 快照不再包括其工作树；历史 Fact 继续保留。
- Repo 删除后停止调度，保留 current generation 和 Fact 供历史看板读取。
- 每 Repo 保留 current 加前两个 completed generation；failed/running scan 诊断保留 7 天。清理永不删除 current generation、其 membership 或 Repo state 指针。

## 审查清单

- 是否快照并成功扫描全部 eligible source，任一失败即不切换？
- 是否同时覆盖 Mirror 与 Workspace `HEAD + refs/heads/*`，发现未 push Commit？
- 是否按 `(repo_id, sha)` 去重，且 Workspace 不出现在 Git API 维度？
- 是否在 scan 开始事务领取并递增 `next_generation`，且 failed generation 永不复用？
- 是否使用单调 generation 和 current pointer，而不是 `completed_at max`？
- 是否在切换 transaction 一起写 Fact、membership、Scan coverage、completed 状态/时间、pointer、Dirty，并只在 Scan 存 coverage？
- 任意切换写入 fault injection 是否完整 rollback 并保留旧 current？无 current Scan 是否返回 preparing/error 而非零？
- Merge、二进制、rename、空 Commit、rebase 和失败 scan 是否符合本文件？
- 是否没有写入 Commit Message、路径、Diff、绝对路径、remote URL 或 Git 输出？
