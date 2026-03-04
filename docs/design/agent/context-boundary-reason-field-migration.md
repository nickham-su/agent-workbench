# boundary_reason 字段迁移设计

## 背景与问题

- 上下文压缩(compaction)会对一批历史 context items 执行归档(设置 `archive_at`),但归档发生在旧 items 上。
- 前端常用增量拉取(delta)更新消息列表,仅能拿到新增 items,无法可靠感知旧 items 的 `archive_at` 批量变化。
- 为解决该同步问题,当前实现引入了 `agent_context_item.purpose`,并在 compaction 生成的 system summary item 上写入特定值,前端检测到后触发一次全量刷新(full refresh),从服务端重新拉取整条 transcript。

当前 `purpose` 字段名语义过泛,且易被误用为“业务用途/枚举类型”。本设计将其替换为更贴合实际用途的字段: `boundary_reason`。

## 目标

- 将 `purpose` 更名为 `boundary_reason`,表达“这是一个边界 marker item,用于触发前端全量刷新,并可作为上下文窗口边界的锚点”。
- 将边界判定从“枚举值匹配”简化为“字段非空即为边界”,减少未来扩展的联动成本。
- 保持模型可见窗口逻辑不变: 仍由 `archive_at`/`archiveAt` 决定哪些 items 会进入 prompt。

## 非目标

- 不在本设计中定义 fork/清空等新功能的业务逻辑。
- 不引入兼容层/双写/回填。当前项目未上线,可以直接破坏性变更。

## 核心结论与约束

- `boundary_reason` 是 transcript item 的元数据字段,不属于 output payload,不会直接进入模型 prompt。
- 只允许 `kind=system` 的 item 写入 `boundary_reason`。
  - 约束目的: 避免普通消息或被归档的历史消息被误判为“边界 marker”。
- 前端边界判定规则:
  - `boundary_reason` 非空且 role/system 的 item 即视为边界 marker。
  - 在 delta 更新中检测到新边界 marker 时,触发 full refresh,以同步旧 items 的 `archiveAt` 批量变化。

## 数据库变更

### 表结构

- 表: `agent_context_item`
- 变更:
  - 删除列: `purpose text`(nullable)
  - 新增列: `boundary_reason text`(nullable)

说明:

- SQLite 列重命名/删除在不做兼容的前提下建议通过重建数据库处理。
- 若开发环境已有旧库,建议删除 workspace 的本地状态目录后重新初始化(由具体工程路径决定),确保新 schema 生效。

### 迁移策略(不考虑兼容)

- 直接修改 schema 初始化 SQL 与 ensureColumn。
- 不做旧列到新列的拷贝。

## 共享类型与 API 契约变更

### AgentContextItemRecord

- 字段替换:
  - `purpose: string | null` -> `boundaryReason: string | null`

约定:

- `boundaryReason` 仅在 system marker item 上有意义。
- 其他 kinds 返回 `null`。

## 后端写入与业务路径调整(仅涉及压缩)

### compaction summary item 写入

- compaction 插入的 system summary item:
  - `boundary_reason` 写入非空文本(例如 `"compaction"` 或简短说明)
  - 用于:
    - 前端检测边界并触发 full refresh
    - 服务端判断“是否仅剩边界 marker,无需再次压缩”

### compaction not needed 判断

- 现有逻辑依赖 `purpose=="compaction_summary"`。
- 迁移后应改为:
  - visible items 仅 1 条
  - 该条为 system
  - `boundary_reason` 非空
  - 则认为当前会话已处于“压缩后仅保留边界 summary”的状态,无需再次压缩

## 前端刷新策略调整

### 触发时机

- 在增量拉取(delta items)合并到本地列表时:
  - 若检测到任意新增 item 满足:
    - role/system
    - `boundaryReason` 非空
  - 则执行一次 full refresh:
    - 重新请求整条 transcript
    - 以同步旧 items 的 `archiveAt` 更新

### 去重/防抖

- 前端应记录“已处理过的最新边界 marker id”,避免同一 marker 重复触发全量刷新。

## 校验与测试建议

- 单元/集成测试:
  - compaction 后 summary item 返回 `boundaryReason` 非空
  - compaction 后旧 items 的 `archiveAt` 被设置
  - prompt context 不包含已归档 items(仍以 `archiveAt` 过滤)
- UI 行为验证:
  - 触发 compaction 后无需手动刷新页面,旧消息归档状态能自动同步显示

## 关键取舍与原因

- 选择 `boundary_reason` 而非继续扩展 `purpose`
  - `purpose` 语义过泛,容易被用作枚举类型承载业务含义,导致联动面扩大
  - `boundary_reason` 明确表达“边界 marker 的原因/说明”,并支持非空即边界的判定
- 不使用枚举值匹配
  - 边界 marker 的主要作用是触发 full refresh,判定只需“是否为边界”,无需区分具体类型
  - 具体原因可由文本表达,减少多处同步修改的风险

## 实施清单(本次范围)

- DB schema: `purpose` -> `boundary_reason`
- 后端 store/service:
  - 读写映射字段更名
  - compaction summary 写入 `boundary_reason`
  - compaction not needed 判断改为 `boundary_reason` 非空
- shared contracts: `purpose` -> `boundaryReason`
- web:
  - full refresh 触发条件从 purpose 枚举改为 `boundaryReason` 非空
  - item diff/渲染字段同步改名
- tests:
  - 更新断言与字段名
