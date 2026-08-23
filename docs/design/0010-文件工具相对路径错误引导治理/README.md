# 文件工具相对路径错误引导治理（v1）

> 状态：设计已确认，待实施。
> 适用范围：Agent Worker 内建 `read`、`apply_patch`、`write` 工具的失败错误文本；首期代码改动仅位于各工具实现及其私有 helper，不在 Runner 或其他工具外层增加统一改写逻辑。
> 本文档以当前代码基线为依据；代码位置以**文件路径 + 符号/职责**为准，行号仅用于辅助检索，不构成实现前提。

## 文档目的

本目录是一份可直接用于开发、代码审查和验收的完整设计。它解决的问题不是“隐藏绝对路径”或通用安全脱敏，而是：文件工具只接受 workspace 内相对路径，但现有失败错误可能返回内部解析后的绝对路径，模型下一轮容易复制该绝对路径重试，继而触发 `absolute path is not allowed`，形成错误工具使用引导和无效重试。

本方案通过**工具内错误文案规范化**，让高频、显式、会引导重试的错误只展示模型可直接提交的相对路径，或不展示路径；内部 `fullPath` 继续用于文件系统访问，但不得被当作对外重试路径。

## 快速结论

- 首期仅在文件工具内部修复，不修改 `runner.ts` 的错误写回职责，不新增跨工具 sanitizer、公共协议或 tool schema 字段。
- `read` 必须规范化根 `lstat` 的 `ENOENT`、`ENOTDIR` 错误，使错误中的目标路径为用户传入并校验后的 `safePath`；repo hint 继续保留，候选仍是可直接重试的 workspace 相对路径。
- `read` 的其他根文件系统错误继续按原样抛出；首期不承诺治理所有低频底层异常。
- `apply_patch` 的主问题修复必须系统移除现有显式对外错误中的 `fullPath`，优先使用已有 `path`、`fromPath`、`toPath`、`relativePath`；snapshot mismatch 删除冗余的绝对 `Path:` 行。
- `apply_patch` 的中间父组件错误也在首期内相对化，但明确归为“工具内补强覆盖项”：它处理遍历过程中派生的 `currentPath`，不是现有主问题示例的直接文案翻转。
- `apply_patch` 的 context mismatch 必须把传给 `deriveNewContentFromChunks` 的展示路径改为相对路径，避免其生成绝对路径错误。
- `apply_patch` 首期不要求包装所有未识别的底层 `throw err`；已显式分类的常见冲突、路径、快照、上下文、父目录和可重试 I/O 错误必须使用相对路径。
- `write` 首期不新增底层错误改写。原因是目标不存在属于正常创建流程，当前没有高频显式 `fullPath` 错误文案；只锁定其成功输出继续使用 `safePath`，低频底层 I/O 透传列为非目标。若实现新增 `runWriteTool` catch、错误重写或包装 helper，视为超范围，必须先同步修订并重新批准本设计。
- 不改变成功路径、状态语义、工具参数、workspace containment、symlink 约束、绝对路径输入拒绝策略或原子性保障。
- 首期追求显著降低模型被误导的概率，不承诺任何异常文本都绝不包含绝对路径。

## 阅读路径

| 文档 | 用途 |
|---|---|
| [01-overview.md](./01-overview.md) | 需求背景、业务链路、现状、目标、范围和术语 |
| [02-product-contract.md](./02-product-contract.md) | 各工具的外部行为、错误文本合同、兼容和明确非目标 |
| [03-decisions.md](./03-decisions.md) | 关键决策、替代方案、取舍与首期边界 |
| [04-technical-design.md](./04-technical-design.md) | 工具内 helper、错误分类、数据流和具体替换规则 |
| [05-code-map.md](./05-code-map.md) | 相关代码与测试地图、符号职责和实施核对入口 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、可执行验收标准和建议验证命令 |
| [07-implementation-review-release.md](./07-implementation-review-release.md) | 任务拆分、逐步实施、审查清单、发布与回滚 |

## 规范性约定

除非章节明确标为“背景说明”“建议”或“非目标”，本文中的“必须”“不得”“仅”均为实施和验收要求。发生冲突时，按以下优先级解释：

- [02-product-contract.md](./02-product-contract.md) 的外部行为合同；
- [04-technical-design.md](./04-technical-design.md) 的工具内实现边界；
- [06-testing-acceptance.md](./06-testing-acceptance.md) 的可验证标准；
- [07-implementation-review-release.md](./07-implementation-review-release.md) 的实施顺序。

## 逻辑边界

```text
模型传入相对路径
  -> 工具校验 safePath / relativePath
  -> 工具内部解析 fullPath 并访问文件系统
  -> 工具内部将高频、显式错误格式化为相对路径合同
  -> Runner 原样写回工具错误
  -> 模型看到可直接重试的相对路径，或无路径错误
```

Runner 继续是透传与持久化边界，不承担路径判断或文本替换。详细方案见 [04-technical-design.md](./04-technical-design.md)。
