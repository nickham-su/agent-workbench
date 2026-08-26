# 产品合同与业务逻辑

返回 [README](./README.md)。本文件是外部行为、安全和兼容合同；开发、审查与验收必须以本文件为首要依据。

## 功能启用与配置合同

### 环境变量

目标实现必须支持：

```text
AWB_PREVIEW_ENABLED=true
AWB_PREVIEW_ORIGIN=https://preview.example.com
AWB_PREVIEW_HOST=127.0.0.1
AWB_PREVIEW_PORT=4311
AWB_PREVIEW_SESSION_TTL_SECONDS=3600
```

固定语义：

| 配置 | 默认值 | 合同 |
|---|---:|---|
| `AWB_PREVIEW_ENABLED` | `false` | 复用项目 `parseBool` 语义；只有显式 truthy 值启用 |
| `AWB_PREVIEW_ORIGIN` | 无 | 启用时必填，必须是纯 `http(s)` origin |
| `AWB_PREVIEW_HOST` | `127.0.0.1` | preview listener 内部监听地址 |
| `AWB_PREVIEW_PORT` | `4311` | 正整数，且不得与主 `AWB_PORT` 相同 |
| `AWB_PREVIEW_SESSION_TTL_SECONDS` | `3600` | 绝对 TTL，范围固定为 `60..86400` 秒 |

bootstrap code TTL 固定为 60 秒，不新增环境变量，避免部署者把一次性兑换码配置成长时凭据。

### `AWB_PREVIEW_ORIGIN` 校验

启用时必须满足：

- `new URL(value).protocol` 仅可为 `http:` 或 `https:`；
- 不得包含 username/password；
- pathname 必须为 `/`；尾随 `/` 必须规范化移除后存储；
- 不得包含 query 或 fragment；
- 必须包含有效 hostname；
- effective origin 必须与主站 public origin 不同；若当前部署没有显式主站 public origin，至少不得等于 listener 推导的 `http://{normalized AWB_HOST}:{AWB_PORT}`；生产部署责任仍需由文档明确；
- `https` origin 才能设置 `Secure` preview cookie；`http` 仅允许开发/受控本地环境。

不得把 `AWB_PREVIEW_ORIGIN` 同时用作监听地址。public origin、host、port 是三个不同概念。

### 启动合同

- preview 关闭时不得启动第二个 listener，health 返回 `previewEnabled: false`，文件树不得显示入口。
- preview 启用时，配置解析错误、origin 非法、端口冲突或 preview listen 失败必须使进程启动失败。
- 若 preview listener 已成功而主 listener 随后失败，进程必须关闭已启动的 preview listener 后退出；不得留下孤立服务。
- 进程收到正常关闭信号时必须同时关闭两个 listener，并清空内存会话。

## Main/Preview 路由归属合同

以下归属不随 `AWB_PREVIEW_ENABLED` 改变：

| 路径/前缀 | Main app | Preview app |
|---|---|---|
| `/api/*` | 按现有 API 合同处理；包含主站 open POST | 必须 404 |
| `/api/workspaces/:workspaceId/preview/open` | 仅允许 POST；负责认证、签发 code、303 | 必须 404 |
| `/__awb/bootstrap` | 必须 404 | 仅允许 GET，返回可信 bootstrap HTML |
| `/__awb/exchange` | 必须 404 | 仅允许 POST，兑换 code |
| `/__awb` 及其他子路径 | 必须 404 | 除上述精确路由外必须 404 |
| `/s/:sessionId/*` | 必须 404 | 仅允许合同规定的 GET/HEAD 静态响应 |
| `/s`、`/s/*` 非法形态 | 必须 404 | 按 session 路由合同返回 404/401/405 |
| `/preview`、`/preview/*` | 必须 404 | 必须 404；该前缀保留，V1 不使用 path-style preview |
| 其他非 `/api` 页面路由 | 可按现有 AWB Web UI SPA fallback | 不得返回 AWB Web UI，默认 404 |

主 app 的 preview 保留前缀固定为：

```text
/s
/__awb
/preview
```

匹配必须按“pathname 精确等于前缀，或以 `前缀 + /` 开始”，不得把 `/settings`、`/__awb2`、`/previewer` 误判为保留路径。

当前 `apps/api/src/app/webUi.ts` 会把未知 GET 且接受 HTML 的请求回退到 AWB `index.html`。目标实现必须修改 `registerWebUi()` 或其等价 not-found 调用边界，在 SPA fallback 前检查上述保留前缀并返回主站标准 404 `{ "message": "Not Found" }`。该行为：

- 无论 preview enabled/disabled 都生效；
- 不得 303 到 preview origin；
- 不得代理到 preview listener；
- 不得返回 AWB `index.html`；
- 对 GET/HEAD/POST 等所有方法都不得落入 Web UI fallback。

## 文件树入口合同

### 显示条件

“预览”菜单仅在以下条件全部成立时显示：

- `previewEnabled === true`；
- 当前节点 `kind === "file"`；
- 扩展名按 ASCII 小写归一化后属于 entry type 白名单。

Entry type 固定为：

- HTML：`.html`、`.htm`；
- 图片：`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.avif`、`.bmp`、`.ico`、`.svg`；
- 音频：`.mp3`、`.wav`、`.ogg`、`.m4a`、`.aac`、`.flac`；
- 视频：`.mp4`、`.webm`、`.ogv`、`.mov`。

CSS、JS/MJS、字体即使可作为页面资源，也不得显示直接“预览”入口。目录不得显示入口。

前端显示是体验优化，不是安全边界。后端 open 和静态服务必须独立重复校验。

### 点击行为

点击菜单后，前端必须同步：

- 创建临时 `<form method="POST" target="_blank">`；
- action 使用主站相对 URL `/api/workspaces/{encodeURIComponent(workspaceId)}/preview/open`；
- 添加隐藏字段 `path`，值为文件树提供的 workspace-relative path；
- 把 form 加入当前 document，调用 `submit()`，随后移除；
- 不先发 axios/fetch，不读取 `AWB_PREVIEW_ORIGIN`，不在前端生成 bootstrap code 或 session URL。

新标签页在主站 open 响应到达前可能短暂持有 opener；preview bootstrap 和资源响应必须使用 COOP/`frame-ancestors` 隔离。前端不得在 form 中传 token、origin、绝对磁盘路径或 MIME。

V1 对 open 失败不建设主站 HTML 错误页：认证失败、same-origin 校验失败、路径错误、preview disabled 等情况由主 app 按现有 JSON error handler 返回 JSON/纯错误响应，新标签页直接显示该响应。只有进入 preview origin 后的 bootstrap/session/file 错误才提供友好 HTML 提示。前端不得通过异步预检查或重试改变此行为。

## 主站 Open 接口合同

### 请求

```http
POST /api/workspaces/:workspaceId/preview/open
Content-Type: application/x-www-form-urlencoded

path=demo/index.html
```

接口仅供 AWB Web UI 使用：

- 必须位于现有 `/api/*` 鉴权保护下；auth 启用时未登录返回 401；
- 必须 fail-closed 要求 `Sec-Fetch-Site` 精确为 `same-origin`；缺失、`none`、`same-site`、`cross-site` 均返回 403；
- 如服务能够基于直接连接或显式可信代理配置可靠确定主站 origin，则 `Origin` 存在时必须精确匹配；不得盲信任任意 `X-Forwarded-Host/Proto`；
- V1 不新增可信代理配置，因此实现必须以 `Sec-Fetch-Site` 为强制主校验；只能使用 Fastify/Node 已可靠确定的 protocol/host 做附加 Origin 校验；
- 不得提供等价 GET 接口；不得接受 JSON API 作为 Web UI 绕过 form 的替代路径。

服务端必须校验：

- preview 已启用；
- workspace 存在；
- `path` 是非空 workspace-relative path；
- 目标是常规文件、未命中 symlink、denylist 和 workspace 越界；
- 目标扩展名属于 entry type 白名单。

成功时：

- 创建至少 128 bit 熵的随机 bootstrap code；
- code 绑定 `workspaceId`、规范化入口路径、创建时间、60 秒过期时间；
- 返回 `303 See Other`；
- `Location` 必须是 `${AWB_PREVIEW_ORIGIN}/__awb/bootstrap#${code}`；
- 响应必须 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。

## Bootstrap 与 Exchange 合同

### Bootstrap 页面

```http
GET /__awb/bootstrap
```

页面必须是 preview 服务内置的可信最小 HTML，不得从 workspace 读取。页面执行顺序固定为：

- 读取 `location.hash` 中的 code；
- 立即调用 `history.replaceState(null, "", "/__awb/bootstrap")` 清理地址栏；
- 再同源 `POST /__awb/exchange`，body 仅包含 code；
- 成功后 `location.replace(response.redirectPath)`；
- 失败显示本地静态错误，不导航主站，不向外部 origin 发请求。

bootstrap HTML 可以使用内联脚本，但必须有独立、精确 CSP；不得加载 workspace 或远程资源。

### Exchange 请求

```http
POST /__awb/exchange
Content-Type: application/json

{"code":"..."}
```

必须：

- fail-closed 要求 `Sec-Fetch-Site: same-origin`；缺失或非 `same-origin` 返回 403；
- `Origin` 存在时必须精确等于 `AWB_PREVIEW_ORIGIN`；preview listener 的 public origin 已有明确配置，因此这里必须校验；
- code 必须存在、未过期、未消费；
- 无论兑换最终成功或失败，只要成功命中该 code，必须原子删除后再继续，防止重放；
- workspace 和入口文件必须再次存在并通过安全/entry type 校验，避免 open 到 exchange 间 TOCTOU；
- workspace 或入口文件在 open 后消失时返回 410；入口路径在 open 后变成 symlink、denylist、非 regular file 或非 entry type 时返回 403；
- 创建 preview session 并设置 cookie。

成功 JSON：

```json
{
  "redirectPath": "/s/<sessionId>/demo/index.html"
}
```

`redirectPath` 必须是同 origin 相对路径，不得返回绝对 URL。

### Preview Cookie

固定要求：

- cookie 名称必须为 `awb_preview_{sessionId}`，其中 `{sessionId}` 使用该 session 的 base64url sessionId；每个 session 使用不同名称，避免同名不同 Path 的 Cookie header 解析歧义；
- cookie value 是独立、至少 128 bit 熵的随机 secret，不是 sessionId；
- `HttpOnly`；
- host-only，不设置 `Domain`；
- `SameSite=Strict`；
- `Path=/s/{sessionId}/`；
- preview origin 为 HTTPS 时必须 `Secure`；HTTP 时不得错误设置导致本地不可用；
- `Max-Age` 等于 session 剩余绝对 TTL；
- 不使用主站 `awb_session` cookie，不共享其签名格式。
- 清除 cookie 时必须使用相同 name/path，并设置 `Max-Age=0`。

## Preview Session 合同

- sessionId 与 cookie secret 必须独立随机生成；二者均至少 128 bit 熵、base64url 无填充编码。
- session 绑定一个 `workspaceId` 和绝对 `expiresAt`；不绑定单文件或单目录。
- 默认 TTL 3600 秒，不滑动续期。
- 每个 `/s/{sessionId}/...` 内容请求必须同时校验 sessionId、cookie secret、绝对 TTL 和 workspace 仍存在。精确的 `/s/{sessionId}` 仅可在不读取任何 workspace 状态的前提下先返回 308 到 `/s/{sessionId}/`，随后目标请求必须完成全部认证。
- 仅复制最终 URL 到无 cookie 的浏览器必须返回 401；最终 URL 不得成为 bearer URL。
- 进程重启清空所有 code/session；workspace 删除后下一次请求返回 410 并删除 session。
- V1 不新增 logout 或主站 session 到 preview session 的关联撤销；主站登出后，已建立 preview session 可继续到绝对 TTL。该行为必须记录为已知限制。
- V1 仅支持单 API 进程；多副本部署不保证 bootstrap/session 可用，必须通过部署约束禁止多副本或后续引入共享 store。

### 容量合同

内存 store 必须设置硬上限：

- bootstrap code：最多 1024 个；
- preview session：最多 256 个。

创建新记录前必须先清理过期项；仍达上限时淘汰最早创建记录。至少每 60 秒定时清理一次，并在访问时惰性清理。清理 timer 必须 `unref()`，不得阻止进程退出。

## URL 与路径合同

### URL 形式

```text
/s/{sessionId}/{workspaceRelativePath}
```

路径基准为 workspace 根。真实磁盘路径不得进入 URL、HTML、错误页或响应头。

### 相对引用

支持：

```text
./styles.css
../shared/app.js
../../assets/logo.png
```

浏览器完成 URL 归一化后，请求仍必须保留 `/s/{sessionId}/` 前缀。若 `..` 归一化导致离开该 session 前缀，请求不会命中 session 路由，必须返回 404；不得把它解释为另一个 workspace 路径。

不支持：

```text
/assets/app.js
```

该请求没有 session 前缀，必须返回 404。不得通过全局当前 session、Referer、cookie 扫描、HTML 重写或 fallback 猜测归属。

### URL 解析规则

- 路由层使用框架完成一次标准 percent-decoding；业务层不得二次 decode。
- 必须拒绝解码后包含 NUL、反斜杠、CR/LF 的路径。
- 必须拒绝原始 URL path 中编码的 `/` 或 `\`（大小写不敏感 `%2f/%5c`），避免代理/框架解析差异。
- workspace-relative path 规范化为 `/` 分隔；空段和 `.` 可以规范化消除。
- 业务解析后的 `..` 不得越出 workspace；最终 containment 必须以 `path.resolve` + `realpath` 验证，而非只靠字符串前缀。
- `.git`、`.awb` 按 ASCII 大小写不敏感的完整路径段拒绝；不是子串匹配。
- 任意祖先或目标 `lstat` 为 symlink 必须拒绝；不得跟随“仍在 workspace 内”的 symlink。
- 非常规文件（socket、FIFO、device 等）不得响应。

### 目录请求

- 文件树不提供目录入口，但静态服务支持目录 URL。
- 请求路径对应目录且 URL 不以 `/` 结尾时，返回 `308` 到相同 session 下的尾随 `/` URL。
- 尾随 `/` 的目录请求仅尝试同目录 `index.html`；不得尝试 `index.htm`、目录列表或 SPA fallback。
- `index.html` 不存在返回 404。

## 文件类型与 MIME 合同

前后端必须从 `@agent-workbench/shared` 共享一份规范定义，至少导出：

- entry extensions；
- resource extensions；
- extension 到 MIME 的固定映射；
- `isWorkspacePreviewEntryPath(path)`；
- `getWorkspacePreviewResourceType(path)`。

后端不得使用客户端传入 MIME；不得依靠 OS MIME database 产生环境差异。

### Resource type 白名单

除 entry type 外，页面可加载：

- `.css` → `text/css; charset=utf-8`；
- `.js`、`.mjs` → `text/javascript; charset=utf-8`；
- `.woff`、`.woff2`、`.ttf`、`.otf`；
- entry type 中列出的图片、音频和视频。

HTML/HTM MIME 为 `text/html; charset=utf-8`。SVG MIME 为 `image/svg+xml`。

禁止类型包括但不限于 `.json`、`.webmanifest`、`.wasm`、`.map`、`.pdf`、`.txt`、`.xml`、未知扩展和无扩展文件。

## 静态响应合同

### 方法

- `/s/*` 仅允许 `GET` 和 `HEAD`。
- 其他方法返回 405，并设置 `Allow: GET, HEAD`。
- `HEAD` 的状态码和响应头必须与对应 GET 一致，但不得发送 body。

### 通用响应头

所有 bootstrap、exchange 错误页、session 错误页和静态资源响应至少设置：

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
Cross-Origin-Resource-Policy: same-origin
```

HTML/bootstrap/顶层 SVG/错误 HTML 还必须设置：

```text
Cross-Origin-Opener-Policy: same-origin
Content-Security-Policy: ...
```

所有响应不得开放 CORS；不得反射任意 Origin。

### HTML 策略

workspace HTML 必须按不可信主动内容响应。CSP 固定目标闭包：

```text
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
media-src 'self' blob:;
connect-src 'self';
object-src 'none';
worker-src 'none';
frame-src 'none';
frame-ancestors 'none';
form-action 'none';
base-uri 'none';
manifest-src 'none';
sandbox allow-scripts allow-same-origin allow-modals;
```

说明：

- 允许经典脚本、module、内联脚本/样式和同 preview origin 资源；
- `connect-src 'self'` 仅允许请求本 preview origin，仍受路由和白名单约束；
- 不允许 worker/service worker、表单提交、popup、外部 frame 或顶层导航授权；
- 不提供配置放宽网络策略；
- V1 不默认开启 COEP。

HTML 还必须设置限制高权限能力的 `Permissions-Policy`，至少禁用 camera、microphone、geolocation、usb、serial、bluetooth、payment、midi、document-domain。

### 顶层 SVG 策略

当请求的导航目标直接是 SVG 时，必须使用不同于 HTML 的策略：

- `Content-Type: image/svg+xml`；
- `Content-Disposition: inline`；
- `Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; sandbox;`；
- 不允许脚本、网络连接、worker、frame、表单或导航。

作为 HTML 中 `<img>` 加载的 SVG 使用相同响应头；不得根据不可信 Referer 放宽策略。

### Range

音频和视频必须支持单区间 bytes Range：

- 无 Range：200，完整 `Content-Length`，`Accept-Ranges: bytes`；
- 合法 `bytes=start-end`、`bytes=start-`、`bytes=-suffixLength`：206，正确 `Content-Range` 与长度；
- 多区间（逗号）、非 bytes 单位、越界或无效范围：416，`Content-Range: bytes */{size}`；
- 图片、HTML、CSS、JS、字体无需处理 Range；携带 Range 时可以忽略并返回 200，但不得错误返回部分内容。

## 缓存与更新合同

- 所有响应 `no-store`；服务不得设置 ETag、Last-Modified 导致条件缓存语义成为验收前提。
- 每次请求从文件系统重新 stat/open；Agent 修改文件后用户手动刷新必须看到新内容。
- 不提供自动刷新或 HMR。

## 错误合同

| 场景 | 状态 | 响应 |
|---|---:|---|
| main origin `/s`、`/__awb`、`/preview` 保留前缀 | 404 | 主站标准 JSON/Not Found，不得返回 AWB `index.html` |
| preview 未启用的主站 open | 404 | 主站 JSON error |
| 主站未认证 | 401 | 现有 auth error |
| open/exchange Fetch Metadata 不合法 | 403 | 不创建/不兑换会话 |
| open path 缺失或语法非法 | 400 | 主站 JSON error |
| open 目标非 entry type、denylist、symlink、越界 | 403 | 主站 JSON error |
| workspace/文件不存在 | 404 | 主站 JSON error |
| exchange code 缺失或格式非法 | 400 | preview 本地 JSON，bootstrap 显示固定错误 |
| bootstrap code 未知、过期或已消费 | 410 | preview 本地 JSON；统一语义，不提供 code 状态枚举 |
| exchange 时 workspace/入口已消失 | 410 | code 已消费，不创建 session |
| exchange 时入口变为 unsafe/unsupported | 403 | code 已消费，不创建 session |
| session cookie 缺失/错误 | 401 | preview 本地错误页 |
| session 过期 | 410 | 清 cookie，preview 本地错误页 |
| workspace 已删除 | 410 | 删除 session、清 cookie |
| session 内文件不存在 | 404 | preview 本地错误页 |
| 资源扩展名不允许、denylist、symlink、越界 | 403 | preview 本地错误页 |
| 方法不允许 | 405 | `Allow` 头 |
| Range 无效 | 416 | 正确 `Content-Range` |

主站 open 失败新标签页显示主站 JSON/纯错误响应，这是 V1 明确接受的 UX，不要求定制 HTML。

preview origin 的错误页不得包含绝对磁盘路径、cookie、code、session secret、堆栈或主站敏感 URL；必须显示固定提示：“预览已失效或不可用，请返回 Agent Workbench 重新打开。”

## 已知限制

- 主站登出不会立即撤销已建立 preview session；最长持续到绝对 TTL。
- 进程重启会让所有打开标签失效。
- V1 单实例内存 store 不支持负载均衡多副本。
- 根绝对资源 URL、外部依赖和 JSON fetch 等常见网站能力不可用。
- symlink 即使目标仍在 workspace 内也不可用。
- CSP 是浏览器防御，不等于机密沙箱；扩展名伪装的敏感数据仍可能被页面读取。
- 文件树的 entry 识别只基于扩展名；服务端仍在 open 时验证文件状态和路径安全。
