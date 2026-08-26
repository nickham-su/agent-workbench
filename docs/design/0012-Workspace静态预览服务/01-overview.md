# 需求背景与范围

返回 [README](./README.md)。本文件说明业务问题、用户链路、目标、范围、安全模型和术语。

## 背景

Agent Workbench 已允许用户和 AI Agent 在 workspace 文件树中创建、编辑、上传和下载文件。对于 HTML/CSS/JavaScript 页面，现有编辑器只能展示源码，用户无法从文件树直接打开浏览器渲染效果。临时启动 `python -m http.server` 虽可工作，但有以下问题：

- 需要用户自行选择目录、端口和启动命令；
- 与 workspace、文件树和 AWB 生命周期没有产品集成；
- 生产部署难以配置稳定域名；
- 通用静态服务器可能暴露整个目录或不具备统一文件白名单；
- 若直接复用主站 origin，workspace HTML/JS 会获得 AWB UI/API 的同源权限。

因此需要把静态预览建设为 AWB 后端正式能力，并在文件树提供明确入口。

## 业务目标

用户应能完成以下闭环：

```text
AI Agent 在 workspace 任意路径编写本地静态页面
  -> 用户在“文件”树右键 HTML 或媒体文件
  -> 点击“预览”
  -> 浏览器新标签页打开独立 preview origin
  -> 页面加载同 workspace 的 CSS/JS/图片/字体/音视频
  -> Agent 修改文件后，用户刷新看到最新效果
```

业务目标包括：

- 降低 HTML/CSS/JS 页面从生成到验证的操作成本；
- 不要求文件放在固定 `preview/` 子目录；
- 生产环境可以通过独立域名提供预览；
- 保持 AWB 主站认证与 preview 内容之间的浏览器安全隔离；
- 给开发、部署、代码审查和 QA 提供可重复验证的合同。

## 用户角色

### AWB 用户

- 在文件树选择可预览文件；
- 触发新标签页预览；
- 接受 V1 只支持本地依赖、相对路径静态页面；
- 对自己或 Agent 生成的页面内容负责。

### AI Agent

- 在 workspace 任意路径创建页面和资源；
- 应使用 `./`、`../` 和本地资源；
- 不应生成根绝对资源 URL、外部 CDN 依赖或 V1 禁止的资源类型。

### 部署者

- 显式启用 preview listener；
- 配置内部监听 host/port 和浏览器可访问的 public origin；
- 确保 public preview 域名仅反向代理到 preview listener；
- 接受 V1 单实例、内存会话和重启失效边界。

## 产品范围

### V1 范围内

- workspace 任意相对路径中的静态文件；
- HTML/HTM 页面入口；
- 浏览器可直接展示的图片、音频和视频入口；
- 页面加载本地 CSS、JS/MJS、图片、音频、视频和字体；
- 同 workspace 内的 `./` 与 `../` 相对引用；
- 目录 URL 规范化后读取 `index.html`；
- 独立 preview origin；
- 短时一次性 bootstrap 和有状态 preview session；
- 媒体单区间 Range；
- 文件变化后手动刷新生效。

### 明确非目标

- 通用静态站点托管、生产站点发布或公网分享；
- Vite/Webpack/TypeScript/Vue/React 编译、HMR 或自动刷新；
- npm 依赖解析、裸模块导入转换；
- 根绝对资源路径 `/assets/...`；
- HTML/CSS/JS 内容重写；
- SPA history fallback；
- JSON、webmanifest、WASM、source map、PDF；
- 外部 CDN、远程脚本、远程图片、外部 API、WebSocket；
- symlink 路径；
- 目录列表；
- 可分享的永久链接；
- 多用户 workspace ACL；当前 AWB 是单实例全局认证模型；
- 多副本共享 preview session；
- 单独的 logout 撤销机制；
- 把扩展名白名单当成敏感数据隔离系统。

## 安全模型

### 受保护对象

独立 preview origin 必须保护以下 AWB 主站能力不被 workspace 脚本同源访问：

- AWB UI DOM；
- AWB 主站 host-only session cookie；
- 主站 localStorage/sessionStorage/IndexedDB；
- `/api/*` 同源接口；
- 主站 Service Worker、缓存和页面导航上下文。

### 不受保护或仅尽力限制的对象

- preview 页面本身是不可信主动内容；
- session 范围内，页面脚本能够请求路径已知的白名单资源；
- CSP 限制常见外部网络出口，但 V1 不宣称是机密执行沙箱，也不承诺抵御浏览器漏洞或所有隐蔽通道；
- 当 AWB 主认证未启用时，系统本身没有私有访问边界；Fetch Metadata 仍防止普通浏览器跨站触发，但不抵御直接 HTTP 客户端。

### 预览授权粒度

一个 preview session 对应一个 workspace，并授权该 workspace 中符合白名单和路径规则的资源。选择 workspace 粒度是为了允许页面跨目录加载 CSS、JS、字体和媒体。

因此必须在产品文档中明确：

> 点击预览相当于允许该页面在 session TTL 内读取同 workspace 中路径已知的白名单资源。不要仅依赖文件扩展名保存敏感信息。

## 当前代码基线

当前实现具备以下可复用基础：

- `apps/api/src/main.ts`：只启动一个主 Fastify app；目标实现需增加 preview app 生命周期。
- `apps/api/src/app/createApp.ts`：主 UI/API app 的组装入口。
- `apps/api/src/app/webUi.ts`：使用 `@fastify/static` 服务 AWB 自身构建产物并对未知 HTML GET 做 SPA fallback。目标实现不得用它服务 preview 文件，但必须修改其 fallback：`/s`、`/__awb`、`/preview` 精确路径及子路径在 main origin 上显式 404，不得返回 AWB `index.html`。
- `apps/api/src/app/auth.ts`：主站 `/api/*` cookie 鉴权；open 路由自然落入现有鉴权保护。
- `apps/api/src/modules/workspaces/workspace-files.service.ts`：已有 workspace scope、containment、realpath 和 symlink 拒绝逻辑，但 denylist 当前主要为 `.git`，且既有普通文件 API 不允许输入 `..`；preview URL 需要专用解析器，不能不加区分地复用输入校验。
- `apps/web/src/features/workspace/tools/file-explorer/components/FileExplorerTree.vue`：文件树右键菜单入口。
- `apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.vue`：选择节点和菜单命令分发。
- `packages/shared/src/contracts/health.ts`：可增加 `previewEnabled` 运行时能力字段。

## 术语

| 术语 | 含义 |
|---|---|
| Main origin | AWB UI/API 的浏览器 origin，例如 `https://awb.example.com` |
| Preview origin | 独立预览 origin，例如 `https://preview.example.com` |
| Preview listener | 同一后端进程启动的第二个 Fastify listener |
| Entry type | 文件树可直接显示“预览”的文件类型 |
| Resource type | preview session 内可以响应的所有白名单类型 |
| Bootstrap code | 主站创建、60 秒内单次消费的随机兑换码，仅放在 URL fragment |
| Preview session | 绑定 workspace、sessionId、cookie secret 和绝对过期时间的内存实体 |
| Workspace-relative path | 相对 workspace 根的 POSIX 风格路径，不包含真实磁盘根 |
| Top-level SVG | 用户直接在标签页访问的 SVG 文档；安全策略不同于作为 `<img>` 子资源加载的 SVG |
