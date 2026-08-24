# Compaction 后归档尾部摘录注入(懒生成 + 文件缓存)

## 背景

- 当前上下文压缩(compaction)流程:
  - worker 触发压缩时,让模型生成一段摘要文本(summaryText).
  - API 将压缩前的可见 context items 写入归档文件(`agent/archive/.../*.log`),并在 DB 中插入一条 system boundary marker(摘要),旧 items 标记为 archived.
- 现有问题:
  - 压缩后 prompt 中只保留摘要,细节损失较多,模型难以把握当前进度与未完成事项.
  - 模型虽可用 `archive_search/archive_read` 回看归档,但缺少“最近进展的原文锚点”,常导致需要更多轮交互才能定位关键内容.

## 目标

- 在 compaction 发生后,为模型输入追加一段“压缩前尾部摘录”(来自归档原文,带 `pos=` 虚拟编号),帮助模型快速恢复工作上下文.
- 摘录应突出:
  - 最近 4 条 user/assistant(体现用户需求与计划).
  - 最近 10 条归档行(覆盖全部类型,体现执行进度).
  - 合并去重并按 `pos` 升序输出,若 `pos` 不连续,在断开处插入一行 `...`.
- 摘录不写入 DB 的可见上下文,避免后续再次 compaction 时被重复归档导致膨胀.
- 需要在摘录后提醒模型可以使用归档工具继续向前查询.

## 非目标

- 不修改 worker 的压缩触发策略与压缩摘要生成提示词.
- 不改变归档文件格式与归档工具(`archive_search/archive_read`)的协议.
- 不要求 fork 后复用同一份 snippet 文件(使用懒生成策略,在 fork 会话内缺失则重新生成).

## 现状梳理

- 压缩摘要存储位置:
  - compaction 生成的 `summaryText` 作为 system context item 写入 DB(`agent_context_item.output_text`).
- 归档存储位置:
  - 归档行由 `buildArchiveLine(item)` 生成,写入 `agent/archive/<workspace>/<session>/*.log`.
- prompt 构建:
  - `getPromptContextForRun` 只会把可见 items 转为 `system/user/assistant` messages 发送给模型.
  - tool items 会作为 assistant 的 tool-call/tool-result parts 注入,但归档内容不会自动参与 prompt.

## 方案概述

### 注入时机

- 仅在 `getPromptContextForRun` 构建模型输入时进行注入.
- 当可见 messages 中存在 boundaryReason 为 `compaction` 的 system 摘要项时:
  - 在该摘要 message 之后,紧跟追加一条新的 system message,其内容为“压缩前尾部摘录 + 归档工具提示”.

### 摘录生成策略(懒生成)

- 在 `getPromptContextForRun` 内尝试读取 snippet 缓存文件.
  - 若存在,直接读取并注入.
  - 若不存在,立即生成并写入文件后注入.
- 生成摘录时:
  - 目标范围必须是“最近一次 compaction 写入归档的那一批 items”,避免混入更早归档.
  - 取最近 4 条 user/assistant(过滤掉空 assistant 的归档行,该过滤在归档生成阶段已存在).
  - 取最近 10 条全部类型归档行(空 assistant 在归档阶段被过滤,不计入 10 条配额).
  - 合并去重后按 `pos` 升序输出.
  - 合并后若出现 `pos` 断点,在断开处插入单独一行 `...`.
- 摘录行格式与 `archive_read` 保持一致:
  - `pos=<n> | <archive line>`

### 归档工具提示模板(定稿)

注入的 system message 使用如下结构:

```text
## 压缩前尾部摘录(归档原文; pos 可用于 archive_read 的 beforePos)

pos=<n> | <archive line>
...

## 归档工具提示(需要更多上下文时)

- 你可以使用 archive_read 继续向前读取更早的归档行:
  - 从更早的位置开始: 使用 beforePos=<上面最小的 pos>
  - 读取更多行: 增大 lineCount
- 你可以使用 archive_search 在全部归档中按关键词检索:
  - query 建议使用具体名词(文件名/函数名/错误码/工具名/关键短语)
  - 如果命中太多,配合 beforePos 向前翻页
```

### 缓存文件位置与命名

- 参考 apply_patch UI artifact 写文件的做法,使用 `AWB_DATA_DIR/tmp` 下的目录作为缓存落点.
- snippet 文件按 workspaceId/sessionId/summaryItemId 分桶,避免跨会话误读:
  - `<AWB_DATA_DIR>/tmp/agent/compaction-snippets/<workspaceId>/<sessionId>/<summaryItemId>.txt`
- 使用 summaryItemId 的原因:
  - 仅用于“同一会话内的 compaction 摘要项”定位,不需要跨 fork 复用.
  - fork 会话 itemId 会变化,天然 miss 并触发重新生成,避免复用源会话的 `pos` 造成错配.

## 关键细节

### 如何保证只取“本次 compaction 前的可见 items”

- compaction 时,API 会将本次压缩前的可见 items 统一设置相同的 `archive_at` 时间戳.
- 懒生成时,通过 transcript(含 archived)定位最近一次归档批次:
  - 取 `archive_at` 的最大值 `latestArchiveAt`.
  - 仅选择 `archive_at == latestArchiveAt` 的 items 作为候选.
- 由于压缩摘要 boundary marker 本身是可见的,而旧 items 已归档不可见,因此该批次与当前 boundary marker 对应.

### `pos` 的来源

- `pos` 是归档工具在读取 `.log` 行时计算出的虚拟编号,由文件序号与行号推导.
- 摘录生成需解析归档文件,为选中的归档行计算对应的 `pos`.

## 兼容性与风险

- 注入摘要后追加摘录:
  - 摘要在前,摘录在后,更符合“先总览后证据”的阅读顺序,同时让摘录在消息序列中更靠后以提高关注度.
- 不截断的权衡:
  - 摘录最多 10 条(合并后),通常可控.
  - 极端情况下某条归档行可能较长(例如 tool 输出),可能增加 token.
- 异常兜底:
  - snippet 生成失败或文件读写失败时,降级为仅注入原 compaction 摘要,不影响主流程.

## 验证与测试建议

- 新增 integration test 覆盖:
  - compaction 后 `getPromptContextForRun` 返回的 `messages` 中:
    - 存在 compaction 摘要 system message.
    - 且其后紧跟存在包含 `pos=` 的摘录 system message.
  - 摘录 system message 包含“归档工具提示”固定段落.
- 回归:
  - 无 compaction 的会话不应注入摘录.
  - fork 会话首次构建 prompt 时若缓存缺失应生成新的摘录文件(不强制复用源会话).
