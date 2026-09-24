# Git 采集方案

## 范围与安全边界

Git Dashboard 统计显式绑定仍存在的凭证的受管理 Repo 中，作者邮箱与 Settings 全局 Git `user.email` 匹配的当前可达提交历史，不以 Workspace、分支、remote 或路径作为公开筛选或展示维度。邮箱只是统计匹配条件，不证明提交者身份。

- Git scan 只读取显式绑定凭证的受管理 Repo，host 默认凭证不算；路径解析、防穿越和软链边界沿用现有 Workspace/数据目录安全规则。扫描子进程仍隔离全局 Git 配置，由可信调度侧读取与 Settings 相同来源的全局邮箱，并在流内按作者邮箱筛选；不读取凭证秘密。
- Git 采集不得阻断 Commit、Push、Sync、工作区操作或 Agent 执行。
- 工作树忙、锁冲突、scan 超时或命令失败时延后该 Repo；不得高频重试或输出 Git 原始错误。
- API/UI/日志只暴露受控 Repo 安全 ID、状态、coverage 和聚合数值；不返回目录、remote、ref、真实 SHA、Commit Message、Diff 或文件清单。

## Commit 安全身份

Analytics 持久 Commit 身份**只能**是：

```text
(repo_id, commit_identity)
```

其中：

```text
commit_identity = HMAC-SHA-256(installation_secret, repo_id + NUL + raw_SHA)
```

也可使用安全等价的安装级稳定不可逆派生，但必须满足相同输入稳定、跨 Repo 不可混同、无 installation secret 时不可反推真实 SHA。

- `raw_SHA` 仅在受控 Git scan 进程内瞬时读取和计算 `commit_identity`，随后立即丢弃。
- 真实 SHA 不得写入 Analytics DB、业务表扩展、IPC、私有 Outbox、API 响应、UI、日志、错误或测试 fixture。
- 首次启用 Git Analytics 时，仅在确认是没有既有 Git Analytics 数据的全新安装，才可原子创建 `installation_secret`。
- 密钥位于受控本地数据目录，使用最小文件权限；永不写入配置示例、日志、API 或 UI，并稳定长期使用。
- 已有 Git Analytics 数据时，密钥缺失、损坏或无法读取必须使 Git Domain unavailable/degraded，禁止静默重建后继续写入，否则会改变 commit_identity 并破坏去重。
- 首版不支持在线轮换。未来轮换必须显式执行 identity reset，并隔离/清理旧 Git generation 后再采集；不得把新旧 identity 混合计数。

## Source snapshot 与 generation

每次 Repo scan 建立不可变 source snapshot：

```text
analytics_git_scan
- scan_id
- repo_id
- started_at / completed_at
- source_state: running | ready | failed
- covered_from / covered_to
- current_generation boolean
- safe_error_code nullable
```

成功 scan 在单事务内：

- 写入本次安全 Commit Fact；
- 写入 `analytics_git_membership(scan_id, repo_id, commit_identity)`；
- 将该 Repo 的 `current_scan_id` 原子切换到本次 ready scan；
- 更新 Repo coverage 与 Domain 状态。

凭证绑定或全局邮箱变更不会立即清空旧快照；下一次后台扫描重新计算合格 Repo 的当前 membership，已不合格的 Repo 退出当前统计，因此历史日期数值可能改变。发布前尽力复核仓库绑定与全局邮箱，复核可观察到变更则放弃该次扫描；两者与 Analytics 发布不在同一事务中，复核与发布间的外部变更可能短时展示旧结果，由后续扫描纠正。无全局邮箱或无合格 Repo 时，不可认证完整零值。

Git 允许作者邮箱为空（如 `<>`）；结构完整的空邮箱记录按不匹配跳过，其余匹配提交仍可正常采集；邮箱中带控制字符、字段分隔符、零字节或损坏记录头则使扫描失败，不将原始邮箱写入事实或日志。

失败 scan 不替换原有 current generation。每个 Repo 同时最多一个 scan；无需通用 Lease 或 repair generation。

## 采集内容与指标字段

```text
analytics_git_commit_fact
- repo_id
- commit_identity
- committed_at
- parent_count
- files_changed nullable
- insertions nullable
- deletions nullable
- collected_at
- primary key(repo_id, commit_identity)
```

- Commit 按 Committer Date `[from,to)` 归属。
- Merge（父数大于一）只计 Commit；不计 changed files、insertions、deletions。
- 非 Merge 的文件数来自安全聚合后的 numstat；二进制 `-` 只计变更文件，不计行数。
- rebase/amend/force-push 后不再 current generation 的 Commit 不参与当前统计。

## Partial 与 coverage

Git 统计必须保留已知部分值，而不是因一个 Repo 未 ready 将全域抹成零或整体请求失败。

范围响应包含：

```text
completeness: complete | partial
partialReason: repo_not_ready | range_before_coverage | scan_stale | mixed_repo_coverage
readyRepoCount: number
totalRepoCount: number
```

- 有 ready current generation 且其 `coveredFrom <= from` 的 Repo 贡献完整已知值。
- 有 ready current generation、但请求范围早于其 `coveredFrom` 的 Repo 仍可贡献它已覆盖部分；总结果为 partial。
- 无 current generation 的 Repo 不贡献值，并使总结果 partial。
- 仅无 ready Repo 时不产生 partial 值，而是 unavailable；`partialReason` 不适用于 unavailable。
- 单一原因优先返回对应枚举：无 ready current generation 为 `repo_not_ready`，范围早于 coverage 为 `range_before_coverage`，ready generation 超过 freshness 预算为 `scan_stale`；多个原因并存为 `mixed_repo_coverage`。
- 没有任何 ready Repo 时，Git Metric/Panel 为 unavailable，`value/data=null`，绝不是 `0`。
- 部分值必须在 UI 标为“已知部分值/下界”，并显示 ready/total Repo 数；不能展示为完整系统总量。
- 后端不返回自由 partial 错误文本；前端仅将上述枚举映射为本地文案。
- Repo coverage 是诊断信息，不能被用作用户可筛选维度。

## 热力图

贡献热力图固定最近 180 个**本地日**，独立于范围型 Dashboard `[from,to)`：

- 使用请求 timezone 的 IANA 本地日边界分桶；DST 日由服务端正常换算。
- 同一单一 Dashboard 响应以例外子块返回自身 `from/to/asOf` 和上述 partial 信息。
- 仅当前 generation 的 Commit 参与；partial 时同样标为下界。
- 该热力图不参与范围型比较，也不迫使其它面板改为 180 天。

## 调度与留存

- 启动后与后台低频调度触发 scan；在业务繁忙、Repo 忙或资源预算不足时让步。
- 仅在 source snapshot 成功、membership 完整且 current 指针原子切换后推进 Git coverage。
- 非 Git Fact 的 400 天物理留存策略不删除 Git current generation 的必要 Commit Fact、membership 或 current scan 元数据。
- 移除 Repo 时按受控配置更新 Repo 集合与覆盖诊断，不执行无关业务 Git 操作。
