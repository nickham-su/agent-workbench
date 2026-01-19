# 终端 path:line 跳转支持 workspace 全路径(多 repo)

## 需求背景

- file-explorer 已支持 workspace 根视角,可以打开 workspace 内任意文件(含多个 repo).
- 终端工具目前只支持当前 repo 范围内的 path:line 跳转,并会过滤其他 repo 的前缀.
- 多 repo workspace 下,终端输出常出现 repo 前缀路径,需要可点击并跳转.

## 技术方案

### 总体思路

- 保留终端的 path:line 解析与点击行为,但把校验与跳转语义升级为 workspace 相对路径.
- 点击时先用 workspace 级 stat 校验 raw path,失败再尝试 current repo 前缀补全.
- 允许 repo 前缀路径直接跳转,不再过滤其他 repo dirName.

### 路径归一化

- 仅做轻量清洗:
  - 去掉前导 "./"
  - 将 "\\" 统一为 "/"
  - 合并重复 "/"
  - 去掉尾部 "/"
- 不再剥离当前 repo 前缀,避免把 "repoA/xxx" 误判为 workspace 根路径.

### 校验与跳转

- 触发点击后执行:
  - 调用 `/api/workspaces/:workspaceId/files/stat` 校验 `rawPath`.
  - 若 ok,使用 `normalizedPath || path` 作为最终路径,跳转 file-explorer.
  - 若 not ok 且存在 currentTarget,再尝试 `${currentTarget.dirName}/${rawPath}`.
  - 第二次 ok 则跳转,仍失败则静默退出.
- file-explorer 的 openAt 已接受 workspace 相对路径,无需自动补 repo 前缀.

### 缓存策略

- 缓存 key 以 workspaceId + path 为维度,与 repo 无关.
- 对 raw path 和 fallback path 分开缓存,避免互相污染.

## 业务逻辑

- 识别规则仍限定为 `path:line`,不引入 path:line:col.
- 链接只在鼠标左键点击时触发,按住 Alt/Option 不触发,保留文本选择体验.
- 当 path 包含 repo 前缀时,按 workspace 语义直接解析并跳转.
- 当 path 不含 repo 前缀时:
  - 优先视为 workspace 根路径.
  - 若失败再视为 current repo 的相对路径.
- currentTarget 为空时只尝试 workspace 根路径.

## 关键决策

- 使用 workspace 级 stat 作为唯一校验入口,避免 repo 维度限制.
- 不再过滤其他 repo 前缀,允许直接点击 repoA/xxx 形式.
- 采用 "先 workspace 根,再 current repo" 的双重校验策略.
- 保持解析格式简单,不扩展到 path:line:col 或复杂标点变体.

## 取舍原因

- 终端 cwd 无法可靠获取,只能接受相对路径的歧义与误判.
- 双重校验会增加一次请求,但只在点击时触发,且有缓存兜底.
- 保留简单格式可以降低误识别风险,同时避免复杂解析带来的维护成本.
- workspace 级 stat 可复用已有安全边界校验,避免前端自行判断路径合法性.

## 已知限制

- 若 workspace 根存在与 repo 同名的顶层目录或文件,会被视为 repo 域处理.
- path 不含 repo 前缀且 cwd 不在 workspace 根时,可能出现误判或无法跳转.

## 验证建议

- 单 repo workspace 下,无 repo 前缀的 `path:line` 仍可跳转.
- 多 repo workspace 下,`repoA/xxx:line` 和 `repoB/xxx:line` 均可跳转.
- workspace 根文件 `notes.md:1` 可跳转,并优先于 current repo 同名路径.
