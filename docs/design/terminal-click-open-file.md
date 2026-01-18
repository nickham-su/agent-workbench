# 终端中点击 path:line 跳转到文件浏览器(带后端校验)

## 需求背景

- 在使用 codex 等 CLI 编程工具时,终端输出中经常出现类似 `relative/path/to/file.ts:123` 的字符串.
- 希望在 Web UI 的内置终端中,通过点击这类字符串后:
  - 自动切换到 File Explorer 工具.
  - 打开对应文件,并定位到指定行.
- 由于终端输出存在误识别/不可靠的问题,希望在跳转前先做一次后端校验,避免无效点击导致频繁切换与报错.
- 为减少重复请求,前端对校验结果做短期内存缓存(组合式 API store),不要求持久化与失效策略.

## 目标与非目标

### 目标

- 支持识别并点击 `path:line` 格式的文本.
- 点击时触发打开.
- 点击后先请求后端 `POST /api/files/stat` 校验路径在当前 repo(target)下是否可作为文件打开.
- 校验通过才跳转 File Explorer 并定位行号.
- 校验失败静默(不跳转,不提示).
- 前端缓存校验结果,并对相同 key 的并发请求做去重.

### 非目标(本阶段不做)

- 不支持 `path:line:col`.
- 不支持带尾部标点的复杂变体(例如 `path:123,` 或 `path:123)`).
- 不支持绝对路径(例如 `/home/user/a.ts:1`).
- 不在校验阶段验证行号是否越界(行号越界由 File Explorer 打开后自行处理/展示).
- 不做缓存失效策略与持久化(短生命周期内存缓存即可).

## 现状调研与可复用能力

### 终端实现概览

- 前端终端基于 xterm.js,初始化逻辑在 `apps/web/src/features/workspace/tools/terminal/TerminalView.vue`:
  - `new Terminal(...)` 并 `term.open(el)`.
  - 当前仅处理 ws 输出、输入、resize、复制等,未实现 link 识别与点击跳转.
- 后端终端通过 `node-pty` 承载 `tmux attach`,经 WebSocket 透传字节流:
  - ws 路由: `apps/api/src/modules/terminals/terminal.ws.ts`.

### File Explorer 打开并定位能力(可复用)

- 工具间调用模式已存在:
  - Search 工具会 `openTool("files")` 并发送 `files.openAt` 调用,让 File Explorer 打开文件并定位.
  - File Explorer runtime 接收 `files.openAt` 并执行打开+高亮/定位.
- Workspace host 的 `callFrom` 会自动保证目标工具可见,并在 envelope 中带上 `targetAtCall`(当前 repo target),便于多 repo 场景下正确路由.

### 后端路径安全校验能力(可复用)

- files 模块的 `readFileText` 已实现较完整的路径安全校验:
  - 非相对路径、包含 `..`、包含 NUL/换行、以 `-`/`:` 开头等会被拒绝.
  - denylist 目录(例如 `.git`)会被视为 `unsafe_path`.
  - 通过 `realpath` 二次校验防止软链逃逸.
- 错误处理风格:
  - 请求体/路径格式不合法: 多使用 `HttpError(400, ...)`.
  - 文件缺失/不可预览等业务态: 多返回 200 并在响应体里用 reason 表达(例如 `missing`, `unsafe_path`).

## 交互与业务逻辑

### 终端点击行为

- 识别规则只覆盖 `path:line`:
  - path: 仅允许相对路径风格的字符集合(例如 `[A-Za-z0-9_./-]+`),且不包含空白符.
  - line: 十进制正整数.
- 点击前会对 path 做轻量归一化,用于兼容工具输出包含 repo 目录前缀的情况:
  - 去掉前导 `./`
  - 将 `\\` 统一为 `/`
  - 若 path 以当前 repo 的 `dirName/` 开头,剥离该前缀后再进行后端校验与缓存
  - 若归一化后的 path 的第一级目录命中"其他 repo 的 dirName",则直接不生成可点击链接(避免误触与无效校验请求)
- 触发条件:
  - 鼠标左键点击触发(为避免影响选择文本,按住 Alt/Option 点击不会触发打开).
  - 普通点击/拖拽保持原有终端行为(聚焦、选择文本等).

### 点击后的业务流程(高层)

- 从 WorkspaceContext 获取当前 repo target:
  - target 为空则直接返回(不做任何事).
- 解析点击的文本得到 `{ path, line }`.
- 调用后端 `POST /api/files/stat` 做轻量校验:
  - 校验失败或请求异常: 静默返回.
  - 校验通过: 切换到 File Explorer,发送 `files.openAt`,并定位到 line.

## 技术方案设计

## 后端: POST /api/files/stat

### 接口语义

- 语义对齐常见 "stat" 概念: 对给定的相对路径在当前 repo(target)下做存在性与类型探测.
- 本需求中 `ok` 的定义更收敛:
  - `ok: true` 表示该 path 在当前 target 下可作为普通文件打开(不是目录,不是软链,不越界,权限允许).
  - `ok: false` 表示不可打开(缺失、越界/unsafe、非普通文件、权限不足等).

### 为什么用 stat 而不是 precheck/resolve

- `stat` 命名更通用,不绑定终端跳转场景,后续也可用于其他功能的轻量探测.
- `resolve` 容易演进成"尽力解析各种输入",范围膨胀.
- `precheck` 过于实现导向,难以复用与扩展.

### 请求与响应(共享契约)

- 新增 shared 合同(建议放在 `packages/shared/src/contracts/files.ts`):
  - `FileStatRequest`:
    - `target`: `GitTarget`(当前 workspace repo)
    - `path`: string(相对路径)
  - `FileStatResponse`:
    - `path`: string(原始输入或清洗后的路径,见 normalizedPath 说明)
    - `ok`: boolean
    - `kind`: 可选,`"file" | "dir"`(主要用于说明)
    - `reason`: 可选,用于说明 `ok=false` 的原因:
      - `"missing"`: 不存在
      - `"unsafe_path"`: denylist/越界/软链/非法段等
      - `"not_file"`: 存在但不是普通文件
      - `"permission_denied"`: 权限不足
    - `normalizedPath`: 可选,返回规范化后的相对路径

### 返回状态码策略(对齐现有项目风格)

- 400:
  - 请求体字段类型不对/缺失.
  - path 格式明显非法(例如绝对路径、包含 `..`、包含 NUL/换行、以 `-`/`:` 开头等).
  - 依据: `readFileText` 对无效 path 会 `HttpError(400, "Invalid path")`,而不是返回 200+reason.
- 404:
  - workspace 或 workspace repo 不存在(同 files 其他接口的 `getTargetInfoOrThrow` 行为).
- 200:
  - 业务态返回,用 `ok/reason` 表达:
    - 文件缺失: `ok:false, reason:"missing"`
    - denylist/软链/越界等: `ok:false, reason:"unsafe_path"`
    - 非普通文件: `ok:false, reason:"not_file"`
    - 权限不足: 返回 403,与现有 `readFileText` 保持一致(前端静默处理).

### normalizedPath 的取舍与决策

- 决策:
  - 接口返回 `normalizedPath`,前端跳转时优先使用它.
- 原因:
  - 终端输出里可能出现 `./a/b.ts:1`、`a//b.ts:1`、`a\\b.ts:1` 等形式.
  - File Explorer 的 tab key 与树选择通常以 path 字符串为主,不规范会导致:
    - 同一文件出现多个 tab(路径不同但指向同一文件).
    - 缓存 key 命中率降低.
  - 后端本身已经通过 `path.resolve` 做过规范化解析,在返回层把"规范化后的相对路径"回传更稳定.

### 后端实现要点

- 仅做轻量探测,不读取文件内容:
  - `lstat` 检查存在性与类型.
  - 拒绝软链.
  - `realpath` 二次校验防止逃逸.
- 复用 `withWorkspaceRepoLock`,避免与 rename/delete/write 并发时出现不一致.
- 路由注册位置:
  - `apps/api/src/modules/files/files.routes.ts` 增加 `/api/files/stat`.
  - `apps/api/src/modules/files/files.service.ts` 增加 `statFile`.

## 前端: 终端 link provider + 后端 stat + 跳转

### LinkProvider 设计

- 使用 xterm 的 `registerLinkProvider`,在终端初始化后注册.
- `provideLinks`:
  - 只扫描单行文本,返回匹配到的 range+text.
  - 不做网络请求.
  - 控制单行最大匹配数,避免极端输出导致性能问题.
- `activate(event, text)`:
  - 非鼠标左键点击直接返回;按住 Alt/Option 直接返回(保留为选择文本手势).
  - 解析出 `path` 与 `line`.
  - 从 WorkspaceContext 读取当前 `target`.
  - 调用 stat store 的 `ensureStat(...)` 获取校验结果(含缓存与 in-flight 去重).
  - `ok=true` 才触发跳转:
    - `host.openTool("files")`
    - `host.callFrom("terminal", "files", { type: "files.openAt", payload: { path, line, highlight:{ kind:"line" } } })`

### 为什么在 activate 才请求后端

- xterm 的 link provider 会在渲染/滚动过程中频繁调用 `provideLinks`.
- 若在 `provideLinks` 里请求后端,会导致:
  - 大量重复请求与严重性能问题.
  - 后端被滚动行为放大,不可控.
- 因此必须把网络行为放在用户明确意图的 `activate` 阶段.

### 终端侧 stat 缓存 store

- 采用组合式 API store(类似现有 file-explorer/search 的 store 风格),仅内存态.
- 缓存 key:
  - 包含 target 与 path: `${workspaceId}:${dirName}:${path}`
  - 原因: 多 repo workspace 下同名 path 可能指向不同实际文件.
- 缓存内容:
  - `ok`,可选 `reason`,可选 `normalizedPath`.
  - in-flight promise 用于并发去重:
    - 同 key 在请求中时复用 promise,避免重复发请求.
- 不做失效策略:
  - 这是明确取舍,短生命周期内误差影响可接受.
  - 即使 stale,也只会导致"点击无响应"或"偶尔打开失败",File Explorer 本身也能提示不可预览/缺失.

## 关键决策与取舍原因汇总

- 只支持 `path:line`:
  - 优先覆盖最常见格式,降低解析复杂度与误识别概率.
- 必须 `Cmd/Ctrl + Click`:
  - 兼容终端文本选择、tmux mouse mode 等交互.
  - 避免普通点击造成误触跳转.
- 增加后端 `/api/files/stat`:
  - 把路径合法性与越界/软链防护交给后端统一校验.
  - 避免前端自行做复杂的文件系统推断.
- 状态码策略采用 "无效输入 400,业务态 200+ok/reason,权限不足 403":
  - 与现有 `readFileText` 的处理风格保持一致.
  - 同时满足本需求"失败静默"的交互目标.
- 返回 `normalizedPath`:
  - 降低 path 表达差异引发的重复 tab 与缓存命中问题.

## 安全性与边界

- 所有 path 均以当前 target(repo)为根做校验,并执行 `realpath` 二次校验防止软链逃逸.
- 通过 denylist(例如 `.git`)阻断敏感目录的打开/探测.
- 前端即使误识别,也必须经过后端校验才能触发打开,降低误触风险.

## 性能评估

- 终端渲染与滚动不触发网络请求(仅点击触发).
- 缓存与 in-flight 去重可显著减少重复点击导致的请求.
- 单行匹配数限制可避免恶意输出导致 UI 卡顿.

## 兼容性与已知限制

- 若路径在终端中被自动折行拆开,本阶段不做跨行识别,可能无法点击.
- 多 repo workspace 下,点击的 path 默认按当前 repo target 解释:
  - 若输出来自其他 repo,stat 会失败并静默,属于已知限制.

## 后续可扩展方向

- 支持更多格式:
  - `path:line:col`
  - `path(line,col)` 等编译器风格
  - 容忍尾部标点并做更强的清洗
- 支持绝对路径:
  - 需要明确 workspace/repo 根路径映射策略,避免误打开.
- hover 提示:
  - 悬停时提示 "Cmd/Ctrl+Click to open".
