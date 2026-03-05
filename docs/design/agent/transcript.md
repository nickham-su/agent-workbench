# Transcript 与 rg 搜索

本方案要求:

- agent 搜索的内容必须与 projection 一致
- 被 revert/cancel 的不可达分支不进入 transcript

## 目录结构

- workspace/.agent-workbench/history/primary/<sessionId>.md
- workspace/.agent-workbench/history/subtask/<sessionId>.md

约束:

- primary/subtask 目录下只放 md
- artifacts 放在 internal,避免被 rg 命中

## 生成来源

- transcript 从 projection 重建
  - 以 session.headEventId 为起点回溯可达 timeline 事件
  - realtime 事件不进入 transcript
  - 将事件映射为 markdown

建议包含:

- user 输入(使用 TextPayload.preview)
- assistant 文本(原文)
- tool 调用摘要(summary)
- tool 输出 preview(可选,默认可折叠)
- artifactPath
  - 用于模型或用户按需 read 获取完整内容

约束:

- transcript 内容必须与 projection 一致
- 不可达分支事件不进入 transcript

## 触发重建

- fork/revert/cancel 后必须重建
- 任意投影重建后可重建
- v1 可简单实现为:
  - 每次 session head 变化后重建该 session transcript

## 搜索约定

按近期优先(文件名排序):

```bash
rg -n --sortr path "关键词" .agent-workbench/history/primary/
```

说明:

- sessionId 使用单调 ULID,字典序与时间一致
- 仅搜 primary,避免 subtask 噪声
