# 开发任务拆分与实施计划

返回 [README](./README.md)。本文件定义有依赖关系的实施顺序、每批完成定义、审查重点、回滚点和发布步骤。

## 实施原则

- 按小步、可验证、可回滚实施；安全原语和测试先于 UI happy path。
- 每批必须完成对应测试和独立审查，阻塞问题修复并复审后才能进入下一批。
- 不同时引入 DB session、分享链接、外部 CDN 开关、通用站点托管或 HMR。
- 不通过修改主站 auth cookie Domain/SameSite 来简化 preview 鉴权。
- 不把 preview origin 注入前端构建产物。
- 若当前代码已漂移，先按符号复核并更新代码地图；不得未经设计批准改变产品合同。

## 任务依赖图

```text
基线冻结
  -> Shared catalog + health contract
  -> Env/config validation
  -> Preview runtime store + browser request guard
  -> Workspace path safety + resource resolver
  -> Response headers + Range streamer
  -> Preview Fastify app (bootstrap/exchange/static)
  -> Main open route + Web UI fallback exclusion + dual-listener lifecycle
  -> Web file tree integration
  -> Deployment docs/config
  -> Full integration/E2E/security review
```

## 开发前基线复核

### 目标

确认本文引用的现有行为仍成立。

### 必查符号

```text
apps/api/src/main.ts:
  loadEnv
  createApp
  app.listen

apps/api/src/app/createApp.ts:
  registerAuthGuards
  registerWorkspacesModule
  registerWebUi

apps/api/src/app/webUi.ts:
  registerWebUi
  setNotFoundHandler / SPA fallback

apps/api/src/app/auth.ts:
  isRequestAuthed
  registerAuthGuards

apps/api/src/modules/workspaces/workspace-files.service.ts:
  isValidRelativePath
  safeResolveUnderRoot
  hasDeniedSegment
  buildWorkspaceScope
  ensureRealPathUnderRoot
  statUnderRoot / readUnderRoot

apps/web/.../FileExplorerTree.vue:
  context menu

apps/web/.../FileExplorerToolView.vue:
  selectedNode
  onNodeContextMenu
  onContextMenuClick

packages/shared/src/contracts/health.ts:
  HealthResponseSchema
```

### 操作

- 运行当前 shared/API/web typecheck/build；
- 运行现有 workspace files/auth/health/file explorer 相关测试；
- 冻结 `registerWebUi()` 当前正常 SPA fallback，并新增预期失败测试证明 `/s`、`/__awb`、`/preview` 当前会误回退，作为后续修复基线；
- 记录当前 Web UI dev proxy 行为；
- 确认 `@fastify/formbody` 尚未存在以及 package lock 更新范围；
- 确认目标 preview port 在开发环境可发布。

### 完成定义

- 基线命令通过，或已有失败被记录且与本功能无关；
- 代码地图按符号复核；
- 没有提前修改生产行为。

### 回滚点

本批只允许新增冻结测试/记录；错误测试可单独回退。

## 实施批次：Shared Catalog 与 Health Contract

### 目标

建立前后端唯一 entry/resource/MIME 定义和运行时 enable 能力。

### 任务

- 新增 `workspace-preview` shared contract/catalog；
- 导出固定 descriptor 和 helper；
- 添加表驱动单元测试；
- `HealthResponseSchema` 增加必填 `previewEnabled`；
- API `getHealth()` 和 Web `AuthStatus` 同步字段；
- preview 尚未接入时先固定返回 false。

### 验证

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npx tsx --test packages/shared/src/contracts/workspace-preview.test.ts
```

### 审查重点

- 是否只有一份白名单；
- MIME 是否与设计完全一致；
- CSS/JS/字体 entry=false；
- health 是否未暴露 public origin。

### 完成定义

- shared 表测试完整；
- API/Web 类型同步；
- preview disabled 下现有 UI 无行为变化。

### 回滚点

可整体回退 catalog/health 字段，但后续批次未开始前不得留下 Web/API schema 不一致。

## 实施批次：配置解析与启动前校验

### 目标

把 preview 配置收敛为不可变、可测试结构。

### 任务

- 在 `env.ts` 增加 enable/origin/host/port/session TTL；
- 固定 bootstrap TTL 60 秒；
- 实现纯配置解析与 origin 校验；
- 检查 preview/main port 冲突；
- 更新 AppContext 最小 preview capability，runtime 暂可为空；
- 增加 env 单测。

### 验证

覆盖 [06-testing-acceptance.md](./06-testing-acceptance.md) 的全部配置矩阵。

```bash
npm run typecheck -w apps/api
npx tsx --test apps/api/src/config/*.test.ts
```

### 审查重点

- public origin 与监听 host/port 是否分离；
- enabled 时非法配置是否必然 throw；
- TTL 边界是否固定；
- 是否错误信任 forwarded headers；
- disabled 是否不要求 origin。

### 完成定义

- 所有非法配置启动前失败；
- disabled 配置不影响现有启动；
- 尚未监听第二端口。

### 回滚点

回退 Env/AppContext 与测试即可，生产行为仍未启用。

## 实施批次：Runtime Store 与 Same-Origin Guard

### 目标

建立无 Fastify/文件系统依赖的短时能力核心。

### 任务

- 实现 bootstrap/session 实体和 Maps；
- 注入 clock/random 便于测试；
- code 60 秒、单次原子消费；
- session 绝对 TTL、不滑动；
- 1024/256 上限、清过期、最早淘汰；
- cleanup timer `unref()` 和 `close()`；
- constant-time secret 比较；
- unique cookie name `awb_preview_<sessionId>` 与 path helper；
- 实现 fail-closed same-origin browser request guard。

### 验证

```bash
npx tsx --test \
  apps/api/src/modules/preview/preview-runtime.test.ts \
  apps/api/src/modules/preview/preview-security.test.ts
```

必须含并发 consume、边界时间、容量、timer/close 和 header 矩阵。

### 审查重点

- 是否先 delete code 再 await；
- code/session/secret 是否独立随机；
- secret 是否未进入公开实体；
- 缺 header 是否拒绝；
- timer 是否泄漏测试进程。

### 完成定义

- runtime 单测全通过；
- 仍未接入 HTTP；
- 该模块可整体删除而不影响现有功能。

### 回滚点

整体删除 runtime/security 模块。

## 实施批次：Workspace Path Safety 与 Resource Resolver

### 目标

在任何 HTTP streaming 前证明 workspace containment 和文件类型安全。

### 任务

- 决定抽取 `workspace-path-safety.ts` 或在 preview 模块实现专用 resolver；
- 复用 `getWorkspace()`，以 DB 的 `ws.path` 为根；
- 实现 raw URL encoded separator 检查；
- 只 decode 一次、拒绝 backslash/NUL/CRLF；
- `.git/.awb` case-insensitive segment denylist；
- 逐级 lstat 拒绝任意 symlink；
- realpath containment；
- regular file/directory 检查；
- 目录 canonical/index 解析；
- shared catalog MIME/类型校验；
- open 后 fstat/dev/ino 复核所需 filesystem adapter；
- 结构化错误映射，不暴露绝对路径。

### 兼容约束

如抽取现有 workspace files helper：

- 现有 CRUD API 继续拒绝 body 中 `..`；
- 现有错误状态和 repo 分派不变；
- 先跑现有测试后再接 preview。

### 验证

执行完整路径攻击矩阵，至少包含 workspace 内/外 symlink 和 TOCTOU 注入。

```bash
npx tsx --test apps/api/src/modules/preview/preview-file.service.test.ts
npm run typecheck -w apps/api
```

### 审查重点

- 是否只字符串 startsWith 而缺 realpath；
- 是否遗漏祖先 symlink；
- 是否二次 decode；
- Windows 分隔符是否拒绝；
- 是否把 `.gitignore` 误判为 `.git`（必须按完整 segment）；
- fd 是否所有分支关闭。

### 完成定义

- 攻击矩阵通过；
- workspace 外 fixture 从未被读取；
- 现有 workspace file API 回归通过。

### 回滚点

若为专用 resolver可整体删除；若抽取公共 helper，必须连同现有 service import 一起恢复，不能只删新文件。

## 实施批次：响应头、错误页与 Range Streamer

### 目标

建立统一、可表驱动测试的静态响应语义。

### 任务

- common/bootstrap/HTML/SVG/resource/error headers helper，按技术设计固定职责集中实现；
- 固定 CSP 和 Permissions-Policy；
- 安全内置错误 HTML renderer；
- GET/HEAD streamer；
- 单区间 Range parser；
- 200/206/416 Content-Length/Content-Range；
- no-store/no-referrer/nosniff/CORP/COOP；
- 禁止 CORS；
- stream error 与 fd cleanup。

### 验证

```bash
npx tsx --test apps/api/src/modules/preview/preview-response.test.ts
```

表驱动覆盖所有资源 MIME、HEAD、Range、CSP 禁止项。

### 审查重点

- HTML 与 SVG 是否不同；
- CSP 是否意外含 `*`、`https:`、`unsafe-eval`；
- worker/form/frame/popup/top navigation 是否被 sandbox/CSP 阻止；
- HEAD 是否读取/发送 body；
- Range 是否多区间拒绝；
- response 是否设置缓存 validator。

### 完成定义

- 响应单元测试通过；
- 不依赖 Fastify route 也可测试；
- 无外部模板/资源。

### 回滚点

整体删除 response 模块。

## 实施批次：Preview Fastify App

### 目标

把 runtime/resolver/response 组装为只含 preview 能力的独立 app。

### 任务

- 新增 `createPreviewApp()`；
- 不注册 websocket、multipart、swagger、AWB modules、Web UI；
- 注册 `GET /__awb/bootstrap`；
- 注册 `POST /__awb/exchange`；
- 注册 `/s/:sessionId` 与 wildcard GET/HEAD；
- exchange 再校验 workspace/entry；
- 设置 unique path-scoped cookie；
- session 请求验证 workspace 存在；
- 独立 error/not-found handler；
- 未匹配 `/api`、`/` 返回 404。

### 验证

完整 preview app inject 链路；断言：

- code 不在 bootstrap request；
- exchange 重放失败；
- 无 cookie static 401；
- preview `/api/health` 404；
- cookie/headers/Range 正确。

```bash
npx tsx --test apps/api/src/modules/preview/preview.integration.test.ts
```

### 审查重点

- preview app 是否意外复用 `createApp()`；
- 是否注册主 app auth/UI；
- exchange Origin 是否精确 public origin；
- 错误 handler 是否泄密；
- session path route 是否可被绝对 root request绕过。

### 完成定义

- preview app 独立测试通过；
- 尚未由 `main.ts` listen；
- main app 无新路由。

### 回滚点

删除 app/routes，保留已验证的基础模块也不改变生产。

## 实施批次：Main Open Route、Fallback 排除与双 Listener 生命周期

### 目标

打通主站授权入口并让启用配置真正监听第二端口。

### 任务

- 增加并注册 `@fastify/formbody`，open route `bodyLimit=8 KiB`；
- 主 app 注册 form parser；
- 修改 `registerWebUi()` not-found handler，在 SPA fallback 前按精确前缀规则拒绝 `/s`、`/__awb`、`/preview`；
- 保留普通 AWB client routes 的现有 SPA fallback；保留前缀拒绝无论 preview enabled/disabled 都生效；
- 新增 workspace preview open route；
- 现有 auth guard保护 open；
- same-origin guard；
- open 目标 entry/path 安全校验；
- issue code + 303 fragment；
- `main.ts` 创建 runtime、preview app、main app；
- 双 listener 原子启动、失败清理、正常关闭；
- health 根据实际 enabled config 返回 true。

### 验证

- main open 安全矩阵；
- 两 app 完整链路；
- 端口占用启动失败；
- main `/s`、`/__awb`、`/preview` 对 HTML Accept 显式 404 且不返回 AWB index；普通 AWB route 仍 fallback；preview `/api` 无主 API；
- disabled 时不创建 app/listener/store timer。

### 审查重点

- 是否存在 GET open；
- form parser 是否限制 body；
- code 是否写日志；
- preview listen 失败是否仍启动 main；
- `registerWebUi()` 是否按完整 path segment/prefix 排除，未误伤 `/settings`、`/__awb2`、`/previewer`；
- open 失败是否保持主站 JSON/纯错误响应，未额外建设 HTML 错误页或异步预检查。

### 完成定义

- API 层功能端到端可用；
- main preview 保留前缀 404 测试和普通 SPA fallback 回归测试通过；
- disabled 无行为回归；
- enabled 生命周期测试通过。

### 回滚点

设置 `AWB_PREVIEW_ENABLED=false` 是部署回滚；代码回滚需同时移除 open route、dual listen 和 health true，不能留下死菜单能力。

## 实施批次：Web 文件树集成

### 目标

提供符合入口矩阵且不持有 preview 配置的用户交互。

### 任务

- 把 `previewEnabled` 从 health/session 传播到 workspace 文件工具；
- `FileExplorerTree.vue` 增加菜单项；
- `FileExplorerToolView.vue` 使用 shared entry helper；
- 新增同步临时 form helper；
- helper 依赖最小 document 接口，使用手写 fake document 测试；不得新增 DOM/E2E 测试依赖；
- 菜单命令调用 helper；
- 增加中英文文案；
- health 失败/default false 隐藏入口。

### 验证

- 在现有 `tsx --test` 中验证 entry 显示矩阵；
- DOM form 属性和生命周期；
- selectedNode 不陈旧；
- 无 axios/fetch/window.open；
- Web typecheck/build。

```bash
npx tsx --test apps/web/src/features/workspace/tools/file-explorer/preview.test.ts
npm run typecheck -w apps/web
npm run build -w apps/web
```

### 审查重点

- 是否复制扩展名数组；
- 是否注入 preview origin；
- CSS/JS/字体是否误显示入口；
- action workspaceId 是否安全编码；
- 文件树其他操作和双击编辑是否回归。
- `apps/web/package.json` 是否未增加 jsdom、happy-dom、Playwright、Cypress 等测试依赖。

### 完成定义

- 用户可从菜单完成新标签页预览；
- disabled 时 UI 不显示；
- 前端 bundle 不含生产 preview origin 配置。

### 回滚点

可单独移除菜单/health 传播；后端保持 enabled 但无 UI 入口不影响安全，然而发布时必须保持产品一致，不能长期部分上线。

## 实施批次：部署配置与文档

### 目标

确保本地和生产能实际访问独立 origin。

### 任务

- `.env.example` 增加完整配置和限制；
- `docker-compose.yml` 发布 preview port；
- 部署手册增加两个域名反代示例；
- 明确 preview 域只到 preview listener、main 域只到 main listener；
- 明确 main listener 自身仍对 `/s`、`/__awb`、`/preview` 返回 404，反向代理分离不是唯一防线；
- 明确单实例；
- 明确 TLS/secure cookie；
- 明确不缓存、禁止复用其他应用域名；
- 增加 AI 页面编写指南：相对路径、本地资源、禁止项。

### 验证

- 使用 compose/local env 启动；
- 浏览器从 Web UI 打开 preview；
- 反向代理下 exchange Origin/cookie/303 正确；
- 错误域路由不暴露另一 app。

### 审查重点

- 是否只配置 origin 而忘记端口发布；
- 是否把两个 host 都转到 main；
- HTTPS origin 下 Secure cookie；
- 示例是否错误使用 path-style `https://awb/preview`。

### 完成定义

- 一套本地配置和一套生产反代示例可复现；
- 已知限制写入用户/部署文档。

### 回滚点

关闭 env + 移除 preview 域/端口转发；不需 DB 回滚。

## 实施批次：全量验证、安全审查与复审

### 目标

按设计进行最终代码审查、QA 和发布判断。

### 任务

- 执行 [06-testing-acceptance.md](./06-testing-acceptance.md) 全矩阵；
- 运行仓库 typecheck/build 和现有回归测试；
- 按文档执行实际双 origin 人工浏览器验收，不引入新 E2E 框架；
- 用恶意 HTML/SVG、symlink、encoded traversal、复制 URL fixture 验证；
- 检查日志不含 code/secret/绝对路径；
- 独立审查 main/preview 路由隔离、cookie/CSP/path resolver；
- 修复所有阻塞问题并由独立视角复审。

### 最低命令

```bash
npm run typecheck
npm run build
```

加实现新增的全部专项 tests，并保存人工浏览器验收记录。

### 完成定义

- 验收标准全通过；
- 无 open security/CSP/path/session 阻塞缺陷；
- 独立审查结论通过；
- 部署说明和 rollback 已验证；
- 代码与文档无未批准偏差。

## 发布策略

### 默认状态

preview 默认关闭。代码可先发布，部署者显式配置全部环境变量后启用。

### 启用前检查

- 独立 preview 域名/TLS 已配置；
- preview port 仅由预期代理访问；
- API 单实例；
- 主/preview 反代路由分离；
- CSP 浏览器验收通过；
- 监控 session 创建、4xx/5xx 和 listener 状态，但日志不含 secret。

### 回滚

最快安全回滚：

```text
AWB_PREVIEW_ENABLED=false
```

重启进程后：

- preview listener 不启动；
- 所有内存 session 失效；
- health false；
- 文件树菜单隐藏。

然后移除 preview 域名反代/端口发布。无 DB migration、文件转换或用户数据回滚。

## 风险与实施注意事项

| 风险 | 对策 |
|---|---|
| Vite proxy 导致 main Origin 推导不同 | Sec-Fetch-Site 为强制；Origin 只在可靠时附加校验，不盲信 forwarded headers |
| 同名 path cookie 解析歧义 | 每 session 唯一 cookie name + 唯一 Path |
| 文件检查与打开竞态 | 逐级 lstat、realpath、打开后 fstat/dev/ino 复核，失败关闭 fd |
| CSP 阻止预期本地脚本 | 浏览器 E2E 覆盖 classic/module/inline/local assets；不得为修测试放开外网 |
| 过多标签消耗内存/cookie | 256 session 上限、绝对 TTL、清理和最早淘汰 |
| 反代错误把 preview 到 main | 双向 404 路由测试 + 部署文档 + 独立域健康检查 |
| 媒体大文件占内存 | 全程 stream，不 `readFile`；Range 只读请求区间 |
| 既有网站不兼容 | 固定 V1 范围，Agent 指南使用相对路径/本地资源，不做隐式 fallback |
| auth disabled 时直接客户端可调用 | 明确 AWB 无私有边界；浏览器 Fetch Metadata 仍强制，不夸大防护 |

## 变更控制

开发中遇到以下需求必须停止并回到设计评审：

- 支持根绝对 URL；
- 放行外部 CDN/任意 connect；
- 放行 JSON/WASM/manifest/source map；
- 支持 symlink；
- 支持分享链接/无 cookie访问；
- 支持多副本；
- 主站 logout 立即撤销；
- 将 preview 挂到主 origin；
- 引入 SPA fallback/目录 listing/内容重写。

这些都改变安全或产品边界，不属于实现细节。
