# 截断与 artifact 策略

目标:

- 保护 EventStore 与 projection 不被巨型文本拖垮
- 保证模型在需要时可以获取完整输出
- UI 默认不刷屏

## 适用范围

- 所有非 assistant 的大文本字段
  - user 超长输入
  - 内置工具输出
  - MCP tool 输出
  - bash stdout/stderr

assistant 文本默认不截断,如需可后续扩展。

## 截断算法

输入:

- text: string
- options
  - maxLines
  - maxBytes
  - direction: head|tail

输出:

- TextPayload
  - preview
  - truncated
  - artifactPath

规则:

- 若行数与字节数均不超过阈值
  - preview=text
  - truncated=false
  - artifactPath=null

- 否则
  - preview 为 head 或 tail 截断内容
  - truncated=true
  - artifactPath 指向保存 full text 的文件路径

阈值建议(对齐 opencode 默认):

- maxLines=2000
- maxBytes=50KB

## artifact 写入

- artifactPath 生成
  - workspace/.agent-workbench/internal/artifacts/<ulid>.txt

- 写入要求
  - 原子写
    - 写临时文件后 rename
  - 权限
    - 文件权限应限制为当前用户可读写

## 事件 payload 表达

任何可能很长的文本字段都使用 TextPayload,不直接存 full text。

示例:

```json
{
  "text": {
    "preview": "...",
    "truncated": true,
    "artifactPath": ".agent-workbench/internal/artifacts/01J...txt"
  }
}
```

## prompt 注入策略

- 默认注入 preview
- 对当前触发本 run 的 user 输入:
  - 若 token 预算允许,优先注入 full
  - 超预算再回退为 preview + artifactPath
- 若模型认为需要完整内容
  - 调用 read 读取 artifactPath

建议在 preview 中附带 hint:

- artifactPath
- 推荐的 read 参数(offset/limit)

## 保留与清理

- v1 可不实现自动清理
- 后续可增加清理策略:
  - 按时间窗口删除 artifacts
  - 仅删除不再被任何可见事件引用的 artifacts

可选增强:

- 在 TextPayload 中额外保留 artifactId
  - v1 仍以 artifactPath 为主
  - 便于后续做路径迁移与跨环境恢复
