# Workspace 搜索范围扩展方案

## 背景

- 现有搜索工具仅支持当前 repo,需要显式选择 repo 才可搜索.
- file-explorer 已支持 workspace 根目录下所有文件浏览与打开,但搜索范围未覆盖非 repo 文件.
- 需要在保持 .gitignore 生效的前提下,提供 workspace 全局搜索与多 repo 选择能力.

## 需求

- 覆盖 workspace 根目录下非 repo 文件的搜索.
- 提供 scope 选择:
  - global: workspace 根目录 + 所有 repo.
  - repos: 仅搜索选中的 repo,支持多选.
- .gitignore/.ignore 行为:
  - workspace 根目录的 .gitignore/.ignore 生效.
  - 各 repo 内的 .gitignore 也生效.
- 结果可打开并定位,与 file-explorer 联动.
- 保持现有超时与命中上限策略.

## 业务逻辑

- 用户在搜索工具中选择 scope:
  - global 时不需要选择 repo.
  - repos 时必须选择至少 1 个 repo.
- 搜索命中路径统一为 workspace 相对路径:
  - repo 内文件返回路径包含 repo 目录前缀.
  - workspace 根目录文件返回相对根路径.
- 点击搜索结果:
  - 打开文件并定位到命中行.
  - 纯文本模式支持精确高亮,正则模式降级为行高亮.

## 技术方案

### API 设计

- 新增 workspace 级搜索接口,避免扩展 GitTarget:
  - `POST /api/workspaces/:workspaceId/files/search`
- 请求体建议:
  - `query: string`
  - `useRegex: boolean`
  - `caseSensitive: boolean`
  - `wholeWord?: boolean`
  - `scope: "global" | "repos"`
  - `repoDirNames?: string[]`
- 响应复用 `FileSearchResponse`,路径为 workspace 相对路径.

### 后端实现

- 入口放在 workspace 模块,沿用 workspaceRoot 校验逻辑.
- 搜索流程:
  - 校验 workspaceId,获取 workspace root 与 repo 列表.
  - 校验 repoDirNames 必须属于 workspace repos.
  - 组装 rg 参数,复用现有 search settings 与强制排除项.
  - `cwd` 固定为 workspace root.
  - 搜索路径:
    - global: `.`.
    - repos: `repoDirName1 repoDirName2 ...`.
- 安全与健壮性:
  - repoDirNames 仅允许 workspace 真实 repo.
  - repoDirNames 去重,为空直接 400.
  - 继续使用 `--` 保护 query,避免被解析为参数.
  - 保持超时与命中上限逻辑.

### 前端实现

- SearchToolView 增加 scope 选择与 repo 多选控件.
- scope 与 repo 选择状态持久化在 store 中.
- repos 模式下未选择 repo 时:
  - 禁止搜索按钮.
  - 提示选择 repo.
- 请求调用新 workspace 搜索 API.
- repo 切换不再强制清空结果,改为 scope 或 repo 变化时清空.

### 文件打开联动

- 搜索结果路径统一为 workspace 相对路径.
- file-explorer 的 openAt 解析逻辑放开非 repo 路径:
  - 保留相对路径校验.
  - 当路径不属于 repo 前缀时,按 workspace 根目录文件处理.
- 对 repo 内路径保持现有逻辑不变.

### 兼容性与迁移

- 现有 `/api/files/search` 保持用于单 repo 搜索,不破坏现有功能.
- 新搜索 UI 与 API 仅在 workspace 搜索工具中使用.
- 设计文档需要补充说明 scope 行为变化.

## 关键决策

- 新增 workspace 级搜索接口,不扩展 GitTarget,减少影响面.
- scope 定义为 global 或 repos:
  - global 覆盖 workspace 根目录 + 所有 repo.
  - repos 仅搜索选中 repo.
- rg cwd 统一为 workspace root,确保路径稳定且 .gitignore 都生效.
- 返回路径统一为 workspace 相对路径,简化前端打开逻辑.

## 取舍原因

- 选择新接口而不是扩展 GitTarget:
  - GitTarget 广泛用于 git 操作,扩展会引入额外兼容成本.
  - workspace 搜索语义与 git repo target 不完全一致.
- repos 模式使用路径列表而非排除 glob:
  - 直接限定搜索范围,更直观且性能更可控.
  - 避免排除列表过长导致被截断.
- 路径统一为 workspace 相对路径:
  - 与 file-explorer 的 workspace 文件操作一致.
  - 便于跨 repo 与非 repo 文件统一打开.

## 风险与后续

- workspace 根目录的 .gitignore 可能影响全局搜索结果,符合当前预期但需在 UI 提示.
- global 搜索在大 workspace 下负载较高,需关注超时与截断提示.
- 需要补充 i18n 文案与 UI 交互细节,避免用户对 scope 产生歧义.
