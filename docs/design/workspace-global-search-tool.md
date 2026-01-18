# Workspace 全局文本搜索工具(基于 rg)设计方案

## 背景

- Workspace 页面当前已具备 File Explorer + Monaco 预览能力,但缺少"在当前 repo 内全文搜索"的入口
- 期望交互:
  - 在 Workspace 页面提供一个全局文本搜索工具
  - 输入搜索内容后,在当前 repo 目录内查找包含该文本的文件与位置
  - 展示结果列表 + 预览
  - 点击结果后,跳转到 File Explorer 打开文件,并定位到行且高亮
- 工具接入方式采用 v2: runtime + store + view,跨工具跳转使用 call
  - 参考: `docs/manual/workspace-tool-development-v2.md`

## 目标与非目标

### 目标

- 搜索范围固定为"当前 repo"(即 Workspace 当前选中的 target)
- 搜索基于 ripgrep(`rg`)实现,并遵循 `.gitignore/.ignore`
- 忽略规则可配置(在 Settings 页面),默认包含 `.git` 与主流依赖目录(例如 `node_modules`)
- 结果展示:
  - 列表按 match 展示(1 个命中=1 条可点击项)
  - 预览按上下文块(block)合并展示(重叠/相邻合并)
  - 上下文固定 `-C 2`
- 点击结果联动:
  - 通过 `call` 揭示 File Explorer 工具
  - File Explorer 打开对应文件,并跳到目标行
  - 精确高亮仅对"纯文本模式"提供;正则模式降级为行级高亮
- 大仓库保护:
  - 命中上限 1000(超出则截断并提示)
  - 默认超时(建议 5s),超时返回部分结果并提示

### 非目标(先不做)

- 不做搜索时的增量触发(输入即搜),仅支持回车/点击搜索触发
- 不做主动 cancel 上一次搜索(新搜索发起时不 kill 旧搜索进程)
- 不做跨 repo 搜索(未来 Multi-Repo Workspace 再扩展)
- 不做返回值型 call(request/response),call 仅 event-only

## 关键决策(已确认)

- 上下文: `-C 2`(命中行上下各 2 行)
- 结果上限: 1000
- "大小写"开关: 开启=区分大小写,关闭=不区分大小写
- 隐藏文件默认纳入搜索: 使用 `rg --hidden`
- 正则与高亮:
  - 支持正则搜索
  - 仅对纯文本做精确高亮;正则只做行级高亮

## Settings: 忽略规则配置

### 配置项

- 新增 SearchSettings:
  - `excludeGlobs: string[]`
  - 语义: 以 `rg --glob '!<pattern>'` 的方式排除路径

### 默认值建议

- 强制忽略(不允许用户删除,服务端永远追加):
  - `.git/**`
- 默认忽略(可在 Settings 里编辑):
  - `node_modules/**`
  - `dist/**`, `build/**`, `out/**`
  - `coverage/**`
  - `.next/**`, `.nuxt/**`
  - `.turbo/**`
  - `.venv/**`, `venv/**`, `__pycache__/**`, `.pytest_cache/**`
  - `target/**`

### UI 提示

- 固定提示: 搜索遵循 `.gitignore/.ignore`,被忽略文件不会出现在结果中

### 校验与容错(推荐)

- 保存时对 `excludeGlobs` 做:
  - trim,过滤空行,去重
  - 最大条数限制(建议 200)
  - 单条长度限制(建议 200)
  - 禁止包含 `\\0`/换行符
- 运行时若发现 glob 参数导致 rg 报错:
  - 返回 400,提示"忽略规则无效"
  - 同时在 UI 提示用户检查 Settings 配置

## 后端: 搜索 API 与实现

### 新增接口

- Settings:
  - `GET /api/settings/search` -> `SearchSettings`
  - `PUT /api/settings/search` -> `SearchSettings`
- Files:
  - `POST /api/files/search` -> `FileSearchResponse`

### 契约定义(建议形状)

- `FileSearchRequest`:
  - `target: GitTarget`(当前 repo)
  - `query: string`
  - `useRegex: boolean`(false=纯文本, true=正则)
  - `caseSensitive: boolean`(true=区分, false=不区分)
  - `wholeWord?: boolean`(可选,对应 `rg -w`)
- `FileSearchResponse`:
  - `query`
  - `useRegex`
  - `caseSensitive`
  - `wholeWord`
  - `limit: number`(固定 1000,便于 UI 展示)
  - `matches: Array<...>`
  - `blocks: Array<...>`(预览块)
  - `truncated: boolean`
  - `timedOut: boolean`
  - `tookMs: number`
  - `ignoredByVcs: boolean`(固定 true,用于 UI 文案)
  - `ignoredByDotIgnore: boolean`(固定 true,用于 UI 文案)

### matches 字段(列表用)

- 每个 match(用于点击跳转):
  - `path: string`
  - `line: number`(1-based)
  - `lineText: string`(去掉末尾换行)
  - `highlight`:
    - 纯文本: `{ kind: "range"; startCol: number; endCol: number }`(1-based,Monaco 列)
    - 正则: `{ kind: 'line' }`

### blocks 字段(预览用)

- 每个 block(同一文件内的上下文块,重叠/相邻合并):
  - `path`
  - `fromLine: number`
  - `toLine: number`
  - `lines: Array<{ line: number; text: string; hits?: Array<{ kind: "range"; startCol:number; endCol:number }> }>`
  - `hitLines: number[]`(便于 UI 快速定位该块包含哪些命中行)

### rg 调用方式(推荐参数)

- 执行方式:
  - 使用 `spawn("rg", args, { cwd: repoPath })`
  - 禁止拼接 shell 字符串
  - 搜索路径固定为 `.`(repo 根)
- 通用参数:
  - `--json`(结构化输出,用于构建 matches/blocks)
  - `--hidden`(纳入隐藏文件)
  - `-C 2`(上下文)
  - `--`(结束 options,避免 query 以 `-` 开头被误识别为参数)
  - `.`(搜索路径)
- 模式参数:
  - 纯文本: `--fixed-strings`
  - 正则: 不加 `--fixed-strings`
- 大小写参数:
  - `caseSensitive=true`: 默认(不加 `-i`)
  - `caseSensitive=false`: `--ignore-case`
- 整词参数:
  - `wholeWord=true`: `-w`

### `.gitignore/.ignore` 行为

- 使用 rg 默认 ignore 机制:
  - 遵循 `.gitignore`(vcs ignore)
  - 遵循 `.ignore`(ripgrep ignore)
- 不提供开关,仅 UI 提示

### 忽略 globs 的注入方式

- 从 settings 读取 `excludeGlobs` 后转换为 args:
  - `--glob`, `!<glob>`
- 服务端永远追加 `.git/**` 的排除,避免扫描 `.git`
- 对 glob 值做基本校验:
  - 不允许包含 `\\0`/换行符
  - 数量与长度受限

### 解析与组装逻辑(推荐)

- 读取 stdout,按行解析 JSON
  - 关注 `type=match` 与 `type=context` 的事件
  - 以 `path.text` 作为文件维度聚合
- 生成 `matches`:
  - 每个 `match` 事件生成 1 条 match
  - 纯文本模式:
    - 从 `submatches[0].start/end` 获取字节偏移
    - 将字节偏移换算为 Monaco 列(UTF-16 code unit):
      - `prefix = Buffer.from(lineTextUtf8).subarray(0, startByte).toString('utf8')`
      - `startCol = prefix.length + 1`
      - `endCol` 同理
    - 若多处 submatch:
      - 列表只取第一个 submatch 做主高亮
      - block 内可存多处 hits(便于预览高亮多个命中)
  - 正则模式:
    - 不做 byte->col 的精确转换,统一标记行级高亮
- 生成 `blocks`:
  - 以 `-C 2` 的窗口为基础,对同一文件内的命中行做区间合并:
    - `range = [line-2, line+2]`
    - 同文件内重叠或相邻(range 间距为 0)的 range 合并为 1 个 block
  - block 的 `lines` 由 `context/match` 事件收集,按行号排序
- 上限与超时:
  - 收集到 1000 个 match 后停止读取 stdout,kill 进程,返回 `truncated=true`
  - 超时 kill 进程,返回 `timedOut=true`
  - 注意区分 rg exit code:
    - 0: 有命中
    - 1: 无命中(非错误)
    - 2: 执行错误(返回 500 或 400,视错误类型)

### 并发策略(推荐,与"不主动 cancel"兼容)

- 前端不 cancel 旧请求,但后端仍建议限制同一 target 的并发搜索,避免资源放大:
  - 方案 A(更简单): 允许并发,但每次都受超时与上限保护
  - 方案 B(更稳): 同一 `workspaceId:dirName` 只允许 1 个进行中的搜索,其余返回 409/429("search busy")
- 推荐方案: 先用 A,待真实仓库压力出现再切 B

## 前端: 工具拆分(v2 Runtime + Store + View)

### ToolId 与注册

- 新增 toolId: `search`
- WorkspaceLayout 工具注册字段:
  - `toolId/title/icon/view/defaultArea/allowedAreas/keepAlive`
  - `createRuntime`: 用于 repo 切换时重置 store

### Search store(建议字段)

- 查询与选项:
  - `query`
  - `useRegex`
  - `caseSensitive`
  - `wholeWord`
- 状态:
  - `loading`
  - `error`
  - `truncated`
  - `timedOut`
  - `tookMs`
- 数据:
  - `matches[]`
  - `blocks[]`
  - `activeMatchKey`/`activeBlockKey`(用于预览聚焦)
- 竞态处理:
  - `seq`(每次搜索递增,仅最后一次结果生效)

### Search runtime(建议职责)

- `start()`:
  - 初始化 store(不需要轮询)
- `onRepoChange(nextTarget)`:
  - 清空结果与错误,重置 `active` 状态
- `onVisibilityChange(visible)`:
  - 可忽略(不影响正确性)
- `onCall(envelope)`:
  - 本工具暂不消费 call

### Search view(建议交互)

- 输入区:
  - 输入框(回车触发)
  - 搜索按钮
  - 选项:
    - 正则(useRegex)
    - 大小写(caseSensitive)
    - 整词(wholeWord)
  - 提示文案:
    - 遵循 `.gitignore/.ignore`
    - 隐藏文件已包含
- 结果区:
  - 左侧列表: `path:line:col + lineText`(高亮主命中片段)
  - 右侧预览: block 展示,并在 block 内高亮所有 hits
- 点击列表项:
  - 使用 tool-scoped host:
    - `const host = useWorkspaceHost(props.toolId)`
  - 发起 call 到 `files`:
    - `host.call("files", { type: "files.openAt", payload: { path, line, highlight } })`

## File Explorer: 消费 call 并完成跳转/高亮

### call 协议

- `type: "files.openAt"`
- `payload`:
  - `path: string`
  - `line: number`
  - `highlight`:
    - 纯文本: `{ kind: "range"; startCol: number; endCol: number }`
    - 正则: `{ kind: "line" }`

### runtime/store/view 分工(推荐)

- file-explorer runtime:
  - `onCall(envelope)` 解析 `files.openAt`
  - 将 "待打开/待定位" 写入 file-explorer store(例如 `pendingOpenAt`)
  - 处理 repo 竞态:
    - 若 `envelope.targetAtCall` 与当前 target 不一致,丢弃
- file-explorer view:
  - watch `pendingOpenAt`:
    - 调用现有打开文件逻辑(或将其抽为可复用函数)
    - editor ready 后:
      - `revealLineInCenter(line)`
      - 根据 highlight.kind 追加 decoration:
        - range: 精确 range 高亮
        - line: 行级高亮

## UI/UX 细节建议

- 空状态:
  - 未选择 repo 时,搜索工具展示"请选择 repo"
  - query 为空时禁用搜索
- 提示:
  - truncated: "结果已截断(1000+),建议增加关键词或调整忽略规则"
  - timedOut: "搜索超时,已展示部分结果"
- 结果排序:
  - 默认按 rg 输出顺序(通常接近文件扫描顺序)
  - 暂不做按文件聚合排序(保持实现简单)

## 安全与边界

- 服务端只允许在当前 repo 根目录(`wsRepo.path`)下运行搜索
- 不跟随软链接(不启用 `--follow`)
- 通过 `spawn` 传参,并使用 `--` 结束 options,防止 query 以 `-` 触发参数注入
- 对 settings 中的 glob 做基础校验与上限约束

## 最小自检清单(实现完成后)

- 基础:
  - 纯文本搜索可用,结果点击能打开文件并精确高亮(包含中文字符的行)
  - 正则搜索可用,结果点击能打开文件并行级高亮
  - `-C 2` 的预览块合并符合预期(例如 100 行与 102 行命中合并为一个 block)
- 忽略:
  - `.git` 不会被扫描
  - `node_modules` 默认不扫描
  - `.gitignore/.ignore` 生效,UI 有提示
- 保护:
  - 命中过多时截断提示正确
  - 超时提示正确
- repo 切换:
  - 切换 repo 后搜索结果清空,旧请求结果不会覆盖新 repo 视图

## 实施拆分(建议任务粒度)

### 共享契约(packages/shared)

- 新增 `SearchSettings` 与更新请求 schema
- 新增 `FileSearchRequest/FileSearchResponse` schema
- 更新 `packages/shared/src/index.ts` 导出

### 后端(apps/api)

- Settings 模块:
  - 新增 `GET/PUT /api/settings/search`
  - 复用 `settings.store.ts` 的 JSON 存储,新增 key(例如 `search`)
- Files 模块:
  - 新增 `POST /api/files/search` 路由与 service
  - service 内:
    - target/path 安全校验复用现有逻辑
    - 读取 search settings 并组装 rg args
    - `rg --json` 解析为 matches/blocks,并处理上限/超时/exit code

### 前端(apps/web)

- Settings 页面:
  - 增加 Search 设置区块,可编辑 `excludeGlobs`
  - 增加提示文案: 遵循 `.gitignore/.ignore`
  - 新增对应的 API 调用封装
- Workspace 工具:
  - 新增 `search` 工具(按 v2: runtime + store + view)
  - view 内实现: 输入/按钮触发,结果列表,block 预览
  - 点击结果通过 `host.call("files", ...)` 跳转
- File Explorer:
  - runtime 实现 `onCall` 消费 `files.openAt`
  - store 增加 `pendingOpenAt` 之类的字段供 view watch
  - view 在 Monaco 中实现 reveal + decoration 高亮
- i18n:
  - 增加工具标题,按钮文案,提示文案等

### 验收与回归

- 使用包含中文字符的样例文件验证"精确高亮"的列计算
- 使用 `.gitignore/.ignore` 覆盖的文件验证"确实不出结果"
- 使用大目录(例如 node_modules)验证默认忽略生效
- 验证工具 call 揭示策略:
  - files 工具被最小化时,仍会被 call 唤起并定位
