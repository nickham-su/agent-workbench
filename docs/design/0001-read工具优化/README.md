# Read 工具仓库路径探测与错误提示（v1）

> 状态：已实施并通过最终验收。
> 适用范围：Agent Worker 内建 `read` 工具，以及为其传递 workspace repo 目录名的 API ↔ Worker 运行时协议。
> 本文档以仓库当前代码基线为依据；代码位置以**文件路径 + 导出符号/职责**为准，行号仅供检索时辅助，不构成实现前提。

## 文档目的

本目录是一份可直接用于开发、代码审查和验收的完整设计。它解决一个明确问题：模型按单仓库习惯传入相对路径时，当前 `read` 只在 workspace 根目录解析；若真实文件在 workspace 下某个 repo 子目录内，工具返回 `ENOENT`，模型得不到可重试的正确路径。

本方案仅在原始 `read` 因路径缺失失败后，提供已登记 repo 下的**候选路径提示**；不改变本次读取的失败结果，也不引入搜索式读取。

## 快速结论

- 相对路径仍首先解析为 `<workspacePath>/<filePath>`。
- 仅当该读取在 `lstat` 阶段因 `ENOENT` 或 `ENOTDIR` 失败时，才探测 `<workspacePath>/<repoDirName>/<filePath>`。
- `repoDirName` 只来自 `workspace_repos` 的已登记记录，并由 API 在 run 入队时传给 Worker。
- 候选命中后，`read` 仍为 `failed`；原错误文本保持为前缀，后接英文、稳定格式的重试提示。
- 仅 Worker server 入站 JSON / `EnqueuePayload` 可缺失 repo 名称；其余 API、Worker、Tool 类型和 `runReadTool` 均必须携带必有数组。
- 不递归扫描 workspace、不扫描 `.git`、不自动改写路径、不自动读取候选、不跟随 repo 根或最终候选 symlink；中间 symlink 仅在 realpath 仍位于 workspace 时允许提示；不暴露绝对路径。

## 阅读路径

| 文档 | 用途 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、案例、目标、非目标、术语和范围边界 |
| [02-product-contract.md](./02-product-contract.md) | 产品行为、触发条件、候选语义、错误文案合同、兼容与降级 |
| [03-decisions.md](./03-decisions.md) | 关键决策、替代方案和取舍理由 |
| [04-technical-design.md](./04-technical-design.md) | 调用链、数据流、类型/接口、算法、安全、并发和性能 |
| [05-code-map.md](./05-code-map.md) | 相关代码地图、符号职责、基线核对方法 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、验收标准、建议命令、回归要求 |
| [07-implementation-review-release.md](./07-implementation-review-release.md) | 开发拆分、逐步实施、审查清单、发布与回滚 |

## 规范性约定

除非某一章节明确标为“背景说明”或“建议命令”，本文中的“必须”“不得”“仅”均为实施和验收要求。发生冲突时，以以下优先级解释：

- [02-product-contract.md](./02-product-contract.md) 的外部行为与错误文本合同；
- [04-technical-design.md](./04-technical-design.md) 的安全及协议设计；
- [06-testing-acceptance.md](./06-testing-acceptance.md) 的可验证标准；
- [07-implementation-review-release.md](./07-implementation-review-release.md) 的实施顺序。

## 关联关系

```text
API workspace_repos
  -> workspaceRepoDirNames（运行时上下文，不落库）
  -> API/Worker enqueue 协议
  -> Worker QueuedRun 与 ToolContext
  -> BuiltinToolProvider.read
  -> runReadTool 的失败后候选探测
  -> 既有 Runner 工具失败文本 / output.error
```

详细定义见 [04-technical-design.md](./04-technical-design.md)。
