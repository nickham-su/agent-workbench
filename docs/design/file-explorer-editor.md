# Workspace 文件浏览与编辑工具设计方案（MVP）

## 背景

- Agent Workbench 的核心场景是让开发者在 Web UI 中管理 Workspace,并配合 AI Agent 在终端里执行任务,然后在 UI 中审查与验收变更
- 当前 Workspace 页面已有:
  - CodeReview 工具: 基于 Git changes + file-compare 的只读 Diff 审查
  - Terminal 工具: 基于 tmux + WebSocket 的可重连交互终端
- 现阶段缺少一个面向"直接查看与编辑工作区文件"的工具,导致:
  - 修改小文件需要频繁在终端里用 vim/nano 或额外打开外部编辑器
  - AI Agent 产出的文件改动,开发者想快速定位并修补时不够顺手

## 目标

- 在 Workspace 页面新增一个工具: 文件浏览与编辑(File Explorer + Editor)
- 仅作用于当前选中 repo(currentTarget),不允许跨 repo 任意路径访问
- 提供:
  - 目录树: 支持逐级展开(按需 list),不做全量扫描
  - 编辑器 tabs: 支持多文件打开,切换与关闭,显示 dirty 状态
  - 基础文件操作: 新建文件/新建文件夹/重命名(文件或文件夹)/删除(文件或非空文件夹)
  - 保存: `Ctrl/Cmd+S` 快捷键 + 编辑器 blur 自动保存
- 安全边界:
  - 严格复用现有相对路径校验与 repo 根目录边界校验
  - 拒绝软链与非普通文件读取/写入
  - 增加 denylist 目录段机制,本期仅配置 `.git`,命中则不展示且禁止访问

## 非目标

- 文件名搜索与内容搜索
- 复杂的文件同步与协作编辑(多用户同时编辑同一文件)
- 强一致的变更监控(比如监听文件系统并实时刷新树)
- 本期不追求覆盖所有"失焦"场景
  - 先实现 Monaco 编辑器 blur 自动保存
  - 其他场景(如窗口失焦、tab 切换未触发 blur 等)由开发完成后手测补齐

## 关键决策与取舍

### 仅限当前选中 repo

- 选择
  - 所有文件接口均基于 `target: { kind: "workspaceRepo", workspaceId, dirName }`
  - `path/dir/from/to` 均为相对 repo 根目录的相对路径
- 原因
  - 与现有 Git 能力接口一致,前端不暴露绝对路径
  - 便于复用后端既有的 target 解析与安全校验

### denylist 目录段: 默认仅 `.git`

- 选择
  - denylist 做成后端常量列表
  - 命中 denylist 的目录不在目录树中展示
  - 任何读写与文件操作命中 denylist 都直接拒绝
- 原因
  - `.git` 目录本身不应被 UI 编辑器操作
  - 后续可按需添加其他目录(由开发者自行调整)

### 冲突检测使用 mtime+hash 混合策略,覆盖保存使用 force

- 选择
  - 默认保存使用混合策略:
    - 快路径: `stat` 比较 `mtimeMs/size` 未变化则直接写入
    - 慢路径: `mtimeMs/size` 变化时再读取当前内容并计算 hash,与 `expected.hash` 对比决定是否冲突
  - 覆盖保存使用 `force: true`,跳过 expected 校验直接写入
- 原因
  - 编辑保存属于高频动作,优先优化常见无冲突路径的性能
  - 在 `mtime` 不可靠或外部工具仅 touch 的情况下,hash 能减少误报
  - `force` 作为明确的用户意图,用于处理真实冲突

### 隐藏文件与忽略文件: 永远展示

- 选择
  - 不提供 toggle 开关
  - 默认展示隐藏文件(路径段以 `.` 开头)与 git ignored 文件
- 原因
  - 降低 UI 复杂度与状态分支
  - 面向开发者的工作台,更偏可控与透明
- 注意
  - 本期仍可在 UI 上做轻量标记(可选),但不作为必要能力

## 用户体验与交互设计

### 工具位置与 Dock 集成

- 新增工具 `files`(暂定 toolId)
- 默认区域建议:
  - `rightTop` 作为默认位置,便于与 CodeReview(leftTop)并排
  - allowedAreas 可放开 `leftTop/rightTop`,避免用户布局受限
- 与 Host API 的交互:
  - 工具内部可提供最小化按钮(可选)
  - 本期不要求与其他工具联动,后续可通过 `emitToolEvent/openTool` 实现"从 CodeReview 打开到编辑器"

### 目录树

- 根节点代表 repo 根目录
- 展开行为:
  - 点击目录节点展开时调用 `/api/files/list` 获取子节点
  - 不做递归扫描,不做全量预取
- 右键菜单或行内操作(按 UI 组件能力选一种):
  - 新建文件
  - 新建文件夹
  - 重命名
  - 删除

### Tabs 与编辑器

- 点击文件节点:
  - 若该文件已有 tab,切换到该 tab
  - 否则创建新 tab 并调用 `/api/files/read-text` 加载内容
- tab 状态:
  - dirty: 编辑内容与最后一次成功保存版本不一致
  - saving: 保存请求 in-flight
  - error: 最近一次保存失败的状态(用于提示)
- 关闭 tab:
  - dirty 时提示确认(放弃修改或取消关闭)

### 保存行为

- 快捷键保存:
  - `Ctrl+S`(Windows/Linux),`Cmd+S`(macOS)
  - 保存成功后清理 dirty
  - 遇到冲突(409)弹窗: `重新加载`,`强制覆盖`
- blur 自动保存:
  - 先实现 Monaco 编辑器 blur 触发
  - 触发条件: tab dirty 且无保存 in-flight
  - 冲突处理策略:
    - 首版可与快捷键一致: 直接弹窗 `重新加载`,`强制覆盖`
    - 若弹窗干扰较大,后续可调整为仅标记冲突,等用户显式保存时再弹窗

## 后端 API 设计

### 总体约束

- 所有接口均要求 `target` 且仅支持 `workspaceRepo`
- 所有路径字段均为相对路径:
  - `dir` 代表相对 repo 根的目录路径(空字符串代表根目录)
  - `path/from/to` 代表相对 repo 根的文件或目录路径
- 安全校验:
  - 拒绝绝对路径
  - 拒绝包含 `..` 段
  - 拒绝包含 `\\0`/换行符
  - 拒绝以 `-` 或 `:` 开头
  - resolve 后必须在 repo 根目录内
  - `lstat` 拒绝软链(避免指向 repo 外)
  - `realpath` 二次校验仍在 repo 根目录内
  - denylist 段命中则拒绝

### 端点列表(建议全部为 POST,与现有 git 接口风格保持一致)

- `POST /api/files/list`
  - 入参:
    - `target`
    - `dir: string`(可为空字符串)
  - 返回:
    - `dir`
    - `entries: [{ name, path, kind: "file" | "dir", size?, mtimeMs? }]`
  - 行为:
    - 只列出一层
    - denylist 命中目录不返回

- `POST /api/files/read-text`
  - 入参:
    - `target`
    - `path`
  - 返回:
    - `path`
    - `previewable: boolean`
    - `reason?: "too_large" | "binary" | "decode_failed" | "unsafe_path" | "missing"`
    - `bytes?: number`
    - `content?: string`
    - `language?: string`(用于 Monaco)
    - `version?: { mtimeMs: number, size: number, hash?: string }`
  - 行为:
    - 复用 `FILE_MAX_BYTES` 限制与二进制/解码失败降级
    - 命中 denylist 或路径不安全则返回 `previewable: false`

- `POST /api/files/write-text`
  - 入参:
    - `target`
    - `path`
    - `content: string`
    - `expected?: { mtimeMs: number, size: number, hash?: string }`
    - `force?: boolean`
  - 返回:
    - `path`
    - `version: { mtimeMs: number, size: number, hash?: string }`
  - 错误:
    - 409 冲突: 返回当前版本 `version`,前端弹窗 `重新加载`,`强制覆盖`
  - 行为:
    - `force: true` 跳过 expected 检查直接写入
    - `force: false` 默认走混合策略

- `POST /api/files/create`
  - 入参:
    - `target`
    - `path`
    - `content?: string`(默认空)
  - 行为:
    - 用于新建文件,避免引入"未落盘 tab"状态机
    - 若已存在则返回 409

- `POST /api/files/mkdir`
  - 入参:
    - `target`
    - `path`
  - 行为:
    - 递归创建可选,但需明确是否允许多层路径

- `POST /api/files/rename`
  - 入参:
    - `target`
    - `from`
    - `to`
  - 行为:
    - 支持文件与目录
    - 默认不覆盖(目标存在则 409)
    - 需要同时校验 `from/to` 都安全且不命中 denylist

- `POST /api/files/delete`
  - 入参:
    - `target`
    - `path`
    - `recursive: boolean`(本期固定 true,允许删除非空目录)
  - 行为:
    - 禁止删除 repo 根目录(例如 `path === ""` 或 `.`)
    - 需要拒绝软链,避免递归穿透到 repo 外

## 前端实现要点

### 状态模型(建议)

- Tree:
  - `expandedDirPaths: Set<string>`
  - `childrenByDirPath: Map<string, Entry[]>`
  - `loadingDirPaths: Set<string>`
- Tabs:
  - `tabs: [{ path, title, language?, model?, version?, dirty, saving, error? }]`
  - `activeTabPath`

### Monaco 集成

- 复用现有 `monacoEnv` 初始化逻辑
- 每个 tab 对应一个 Monaco model(按 path 作为 key)
- blur 保存:
  - 监听 Monaco 编辑器 blur 事件
  - blur 时若 dirty 且非 saving 则触发保存
- 快捷键保存:
  - 在 Monaco keybindings 中注册 `Ctrl/Cmd+S`
  - 或在页面层监听键盘事件并路由到当前 tab 保存

### 删除确认

- 删除文件/目录时弹窗确认
- 文件数提醒:
  - 本期不新增后端统计
  - 可用前端已展开树的节点数量做近似提示,并明确是"已加载的可见节点统计",不是全量精确值

## 安全与边界

- denylist:
  - 本期仅 `.git`
  - 命中 denylist 的目录不展示且禁止访问
- 路径校验:
  - 复用并统一到后端公共函数,避免多个模块重复实现产生差异
- 软链处理:
  - 读取与写入都拒绝软链
  - 删除目录递归时必须保证不跟随软链

## 测试与验证(最小自检)

- 接口层:
  - list/read/write/create/mkdir/rename/delete 的基本路径校验与 denylist 校验
  - write-text 的冲突行为:
    - mtime/size 未变直接写
    - mtime/size 变但 hash 相同允许写
    - hash 不同返回 409
    - force 覆盖写入
- 前端:
  - 目录树逐级展开与懒加载
  - tab 打开与切换,dirty 标记
  - `Ctrl/Cmd+S` 保存
  - Monaco blur 自动保存
  - 409 冲突弹窗 `重新加载`,`强制覆盖`

