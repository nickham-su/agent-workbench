# 测试、代码审查与验收

返回 [README](./README.md)。本文件定义测试分层、攻击矩阵、可执行验收标准和审查清单。

## 总体规则

- 必须用自动化测试证明 origin 隔离、跨站触发拒绝、最终 URL 非 bearer、路径 containment、symlink 拒绝和 CSP 资源闭包；这些不是仅人工检查项。
- 文件系统测试必须使用临时 workspace/DB，不得访问真实用户文件或仓库外目录。
- 所有 token、cookie 和 workspace 内容必须使用虚构 fixture；测试日志不得打印真实随机 secret。
- 必须同时覆盖 preview disabled/enabled；关闭路径是产品合同，不是可选负例。
- 必须测试 GET 与 HEAD、目录 canonical redirect、媒体 Range、HTML/SVG 不同头策略。
- 必须测试 main app 的 `/s`、`/__awb`、`/preview` 保留前缀显式 404 且不进入 AWB SPA fallback；preview app 不提供 `/api`/AWB UI。
- V1 前端自动化测试必须基于仓库现有 `tsx --test`，使用纯 helper 和最小 fake document；不得引入新的 DOM 或浏览器测试框架。
- 每个实施批次完成后必须独立审查；审查不通过先修复并复审。

## 测试分层

### Shared 单元测试

建议：

```text
packages/shared/src/contracts/workspace-preview.test.ts
```

必须覆盖：

- 每个固定扩展名的 MIME、kind、entry、range；
- 大小写扩展名；
- 无扩展、未知扩展、`.json/.wasm/.map/.pdf`；
- `.css/.js/.mjs/.woff2` resource=true、entry=false；
- `.html/.svg/.mp4` entry=true；
- `secret.json.js` 按 `.js`；
- 带 query/fragment 的输入不得被误识别为 filesystem path；
- 前端和后端导入的是同一 helper，不存在复制白名单。

### API 单元测试

| 模块 | 必测内容 |
|---|---|
| env config | enable、origin、host、port、TTL 默认/边界/非法值、端口冲突 |
| same-origin guard | `same-origin` 唯一放行；缺失/none/same-site/cross-site 拒绝；Origin 精确比较 |
| runtime store | 随机实体、单次 code、绝对 TTL、secret timing-safe 语义、容量淘汰、cleanup、close |
| path resolver | percent 编码、denylist、symlink、realpath containment、目录/index、非常规文件 |
| response headers | common/HTML/SVG/error/bootstrap CSP；不开放 CORS；no-store/no-referrer/nosniff |
| Range parser | 三种合法形式、越界、多区间、空文件、HEAD |
| cookie | unique name、Path、Strict、HttpOnly、Secure、清理 |

### API 集成测试

分别使用 `mainApp.inject()` 与 `previewApp.inject()`；filesystem streaming/Range 可使用 Fastify inject 或实际 ephemeral listener，至少有一组真实 HTTP 浏览器语义测试。

必须覆盖完整链路：

```text
POST open -> 303 fragment Location
GET bootstrap -> HTML
POST exchange -> Set-Cookie + redirectPath
GET redirectPath with cookie -> 200 HTML
GET resource with same cookie -> 200
GET redirectPath without cookie -> 401
```

### Web 单元测试

必须把 entry 判定和 form 创建抽为纯 helper，在现有 `tsx --test` 中用手写最小 fake document/element 测试。不得引入 jsdom、happy-dom、Playwright、Cypress 或其他测试运行时。

必须覆盖：

- preview disabled 时任何文件不显示；
- HTML/图片/音视频显示；
- CSS/JS/字体/目录不显示；
- 大小写扩展名；
- form method/target/action/hidden input；
- workspaceId 使用 encodeURIComponent；
- path 原样作为表单值，由浏览器 form encoding；
- append -> submit -> remove 顺序；
- 不调用 axios/fetch/window.open，不读取 preview origin。

### 人工浏览器验收

V1 不引入新的浏览器自动化框架。必须提供可重复执行的人工浏览器验收脚本，覆盖：

- 文件树右键菜单；
- 新标签页完整跳转；
- opener 在 preview 页不可用/被 COOP 切断；
- 页面 CSS/JS/图片/字体加载；
- 根绝对 `/assets` 失败；
- 外部 fetch/CDN 被 CSP 阻止；
- session 过期错误页；
- 修改文件后刷新更新。

## 配置测试矩阵

### Enable

| `AWB_PREVIEW_ENABLED` | 期望 |
|---|---|
| 未设置/空/`0`/`false` | disabled |
| `1`/`true`/`yes`/`on`（大小写按现有 parseBool） | enabled |
| 其他值 | 按现有 parseBool 为 false |

### Origin

| 值 | 期望 |
|---|---|
| `http://127.0.0.1:4311` | 合法 |
| `https://preview.example.com` | 合法 |
| `https://preview.example.com/` | 合法并规范化无尾 `/` |
| 空值（enabled） | 启动失败 |
| `ftp://...` / `file://...` | 启动失败 |
| 带 path/query/fragment | 启动失败 |
| 带 username/password | 启动失败 |
| 与 main effective origin 相同 | 启动失败 |
| 非法 URL | 启动失败 |

### Port/TTL

- preview port 与 main port 相同：失败；
- port 0、负数、非整数、>65535：失败；
- TTL 59、86401、非整数：失败；
- TTL 60、3600、86400：成功。

### 启动失败

使用被占用的 preview port：

- 进程/app 启动 Promise reject；
- main listener 不得继续可用；
- 已打开 listener 必须关闭；
- health 不得错误报告 enabled 后继续服务。

## Open 接口安全矩阵

基础请求：正确 workspace、HTML entry、已认证。

| 方法/Header/Body | 期望 |
|---|---|
| POST + `Sec-Fetch-Site: same-origin` | 303 |
| GET 同路径 | 404/405，不创建 code |
| POST 缺 `Sec-Fetch-Site` | 403 |
| `none` / `same-site` / `cross-site` | 403 |
| auth enabled、无主 cookie | 401 |
| reliable Origin 匹配 | 303 |
| reliable Origin 不匹配/非法 | 403 |
| path 缺失/空/超 4096 | 400 |
| CSS/JS/字体 path | 403，不创建 code |
| 目录 path | 403 |
| HTML symlink/祖先 symlink | 403 |
| `.git/index.html`、`.AWB/x.html` | 403 |
| workspace 不存在/文件不存在 | 404 |
| preview disabled | 404 |

断言成功 Location：

- origin 精确等于配置值；
- pathname `/__awb/bootstrap`；
- code 只在 fragment；
- query 为空；
- response `no-store/no-referrer`；
- 日志捕获器不含 code。

## Bootstrap/Exchange 矩阵

### Bootstrap 页面

- 响应不依赖 code，因为 fragment 不发送到服务器；
- 包含先 `history.replaceState` 后 exchange 的逻辑，可通过源码顺序单测和浏览器测试证明；
- 严格 bootstrap CSP；
- 不加载外部或 workspace 资源；
- COOP、frame-ancestors、no-store、no-referrer、nosniff 存在。

### Exchange

| Case | 期望 |
|---|---|
| same-origin + 正确 code | 200、Set-Cookie、redirectPath |
| 缺/错误 Fetch Metadata | 403，code 不应被跨站消费；之后合法请求仍可兑换 |
| Origin 不匹配 | 403，code 不消费 |
| code 缺失或格式非法 | 400 |
| code 未知或过期 | 410；过期记录删除 |
| code 第一次成功、第二次重放 | 第二次 410，不新建 session |
| workspace 或 entry 在 open 后消失 | 410，不建 session，code 已消费 |
| entry 在 open 后改成 symlink/denylist/非 entry | 403，不建 session，code 已消费 |
| 两个并发 exchange 同 code | 仅一个成功 |

Set-Cookie 必须断言：

```text
awb_preview_<sessionId>=<secret>
Path=/s/<sessionId>/
HttpOnly
SameSite=Strict
Secure（HTTPS origin）
Max-Age=TTL
```

不得有 Domain。JSON 不含 secret、workspaceId 或 public origin，只含相对 redirectPath。

## Session 与授权矩阵

- 正确 sessionId + 正确对应 cookie：允许；
- URL 无 cookie：401；
- 正确 URL + 其他 session cookie：401；
- 正确 cookie name + 错 secret：401；
- 复制 URL 到新 client（无 cookie）：401；
- session 过期：410、session 删除、清 cookie；
- workspace 删除：410、session 删除、清 cookie；
- session 访问不延长 expiresAt；
- 进程 runtime 重建后旧 session 无效；
- 主站 logout/清主 cookie不影响已建立 preview session，直到 TTL；用测试固化已知限制；
- 达到 256 session 后创建新 session：先清过期，再淘汰最早；
- 达到 1024 code 后行为同上；
- cleanup timer 不阻止测试/进程退出。

## 路径与文件系统攻击矩阵

临时 workspace 至少包含：

```text
demo/index.html
demo/styles.css
demo/app.js
shared/logo.png
media/video.mp4
.git/config
.awb/private.js
outside-secret.js             # workspace 外
link-out -> outside-secret.js
link-in -> demo/styles.css
parent-link/child.html        # 祖先是 symlink
```

必须覆盖：

| 请求 | 期望 |
|---|---|
| `/s/id/demo/index.html` | 200 |
| HTML 引用 `../shared/logo.png` 后的规范 URL | 200 |
| `/s/id/demo/` | `index.html` 200 |
| `/s/id/demo` | 308 到 `/s/id/demo/` |
| `/s/id/` 且根无 index | 404，无 listing |
| `/assets/app.js` | preview app 404，不猜 session |
| `/s/id/.git/config` / 大小写变体 | 403 |
| `/s/id/.awb/private.js` / 大小写变体 | 403 |
| symlink-in 与 symlink-out | 均 403 |
| 祖先 symlink | 403 |
| FIFO/socket/device fixture（平台可用时） | 403 |
| encoded `%2f/%5c` | 400/403，绝不解析 |
| malformed percent | 400 |
| decoded backslash/NUL/CRLF | 400 |
| 双编码 `%252e%252e` | 不二次 decode；不得逃逸，通常按字面不存在 404 |
| 浏览器归一化后离开 `/s/id` | 不命中 session route，404 |
| `unknown.json`、`file.txt` | 403 |
| `SECRET.HTML` | 允许，MIME 正确 |

### TOCTOU

通过注入 fs adapter 或受控并发，在 lstat/realpath 与 open 之间替换文件为 symlink：

- fstat/dev/ino 复核应检测并安全失败；
- 不得读取 workspace 外内容；
- 文件 descriptor 必须关闭；
- response 不得部分发送 secret 后再报错。

## 响应头与 CSP 验收

### HTML

精确断言：

- `Content-Type: text/html; charset=utf-8`；
- common headers；
- `COOP: same-origin`；
- CSP 包含且不放宽：`default-src 'none'`、`script-src 'self' 'unsafe-inline'`、`connect-src 'self'`、`worker-src 'none'`、`frame-src 'none'`、`frame-ancestors 'none'`、`form-action 'none'`、`base-uri 'none'`、`manifest-src 'none'`、sandbox；
- 不包含 `https:`、`http:`、`*`、`unsafe-eval`；
- Permissions-Policy 禁止合同列出的能力；
- 无 `Access-Control-Allow-Origin`。

浏览器测试：

- 本地经典脚本、module、inline script、CSS、图片、字体工作；
- `fetch("./allowed.js")` 可在同 preview session 内返回 JS 文本；
- `fetch("https://example.invalid")` 被 CSP 阻止；
- 外部 script/img/CDN 被阻止；
- Worker/ServiceWorker、form submit、popup、frame 被阻止；
- 根绝对资源失败。

### SVG

- MIME `image/svg+xml`；
- `script-src 'none'`、sandbox；
- 一个带 `<script>` 和外部 image 的 SVG fixture 不执行脚本、不发外部请求；
- 不能因 `Sec-Fetch-Dest: image` 放宽。

### 普通资源

每个 resource catalog 条目至少做 MIME 表驱动测试；common headers 存在；CSS/JS/字体无 HTML sandbox CSP 依赖但不得开放 CORS。

## GET/HEAD/Range 矩阵

### GET/HEAD

- 每种资源 GET body 正确；
- HEAD 无 body，Content-Length 等于完整/区间长度；
- POST/PUT/DELETE `/s/*` 返回 405 + `Allow: GET, HEAD`；
- 文件修改后第二次 GET 是新内容，响应始终 no-store。

### Range

对大小 100 bytes 媒体 fixture：

| Range | 状态 | 范围 |
|---|---:|---|
| 无 | 200 | 0-99 完整 |
| `bytes=0-9` | 206 | 0-9 |
| `bytes=90-` | 206 | 90-99 |
| `bytes=-10` | 206 | 90-99 |
| `bytes=90-200` | 206 | 90-99 |
| `bytes=100-` | 416 | `*/100` |
| `bytes=20-10` | 416 | `*/100` |
| `bytes=0-1,5-6` | 416 | 多区间拒绝 |
| `items=0-1` | 416 | 单位拒绝 |
| `bytes=-0` | 416 | 非法 suffix |

必须验证 body 字节精确，不把二进制转字符串。

## Origin 隔离验收

使用两个实际 ephemeral ports 或配置域名运行：

- main `/s`、`/s/id/file.html`、`/__awb`、`/__awb/bootstrap`、`/preview`、`/preview/x` 对 `Accept: text/html` 均返回 404，body 不得是 AWB `index.html`；preview enabled/disabled 都必须覆盖；
- main `/settings` 等正常 AWB client route 在 `serveWeb` 启用时仍按现有 SPA fallback 返回 `index.html`，证明保留前缀判断没有扩大；
- `/settings2`、`/__awb2`、`/previewer` 不得因子串匹配被错误保留；
- preview `/api/health`、`/api/docs`、`/api/workspaces` 返回 404；
- preview `/` 不返回 AWB Web UI；
- preview 页面请求 main `/api/*` 属跨 origin，主 API 不开放 CORS，脚本不能读取；
- 主站 host-only `awb_session` 不发送到 preview host；
- preview cookie 不发送到 main host，且 Path 限定 session。

## 前端验收

- health `previewEnabled=false`：菜单不存在；
- enabled：只有 entry type 菜单存在；
- 右键 A 后再右键 B，预览提交 B 的 path，不能使用陈旧 selectedNode；
- 点击预览不改变 editor 双击行为；
- 临时 form 提交后从 DOM 移除；
- action 不含 preview origin；
- 中文“预览”和英文“Preview”存在；
- open 返回 400/401/403/404 时，新标签页显示主站 JSON/纯错误响应；不要求主站 HTML 错误页；
- popup 被浏览器拦截时产品文档说明手动允许，不把异步重试作为 fallback。

## 可执行验证命令

具体新增测试文件名可按实现调整，最低验证命令应包括：

```bash
npm run build -w packages/shared
npm run typecheck -w apps/api
npm run typecheck -w apps/web
npm run build -w apps/api
npm run build -w apps/web
```

建议专项：

```bash
npx tsx --test packages/shared/src/contracts/workspace-preview.test.ts
npx tsx --test apps/api/src/modules/preview/*.test.ts
npx tsx --test apps/api/src/modules/workspaces/workspace-preview.routes.test.ts
npx tsx --test apps/web/src/features/workspace/tools/file-explorer/preview.test.ts
```

最终还必须运行仓库现有：

```bash
npm run typecheck
npm run build
```

前端 preview 单测必须由现有 Web `tsx --test` 脚本或等价直接命令执行；人工浏览器验收结果必须在发布记录中保存。

## 验收标准

以下全部满足才可验收：

### 产品

- 文件树入口显示矩阵完全符合合同；
- 点击在新标签页完成完整预览；
- AI 修改后刷新生效；
- 已知限制在部署/用户文档可见。

### 架构

- 两个独立 listener/origin；
- main/preview 路由注册严格分离；
- main preview 保留前缀 404，且正常 AWB SPA fallback 无回归；
- 前端不包含 preview origin；
- preview 配置失败导致启动失败。

### 授权

- 跨站或缺 Fetch Metadata 的 open/exchange 全拒绝；
- code 单次 60 秒；
- 最终 URL 无 cookie不可访问；
- session 绝对 TTL、删除 workspace/重启失效；
- secret 不出现在 URL/JSON/log。

### 文件安全

- workspace containment、denylist、全链 symlink 拒绝；
- 未知资源拒绝；
- 目录无 listing、无 SPA fallback；
- TOCTOU 用例不读取 workspace 外内容。

### 浏览器安全

- HTML/SVG CSP 分离；
- 外部网络、worker、frame、form、popup 被阻止；
- AWB API/UI 与 preview 不同 origin；
- no-store/no-referrer/nosniff/COOP 等头完整。

### 兼容与质量

- GET/HEAD/Range 正确；
- shared MIME 表前后端唯一；
- existing workspace files/auth/Web UI tests 无回归；
- typecheck/build 全通过；
- 独立代码审查通过且阻塞意见已修复复审。

## 代码审查清单

### 阻塞项

出现任一项必须拒绝合并：

- workspace 内容在主 origin 可执行；
- main `/s`、`/__awb`、`/preview` 任一保留前缀返回 AWB `index.html` 或其他 2xx fallback；
- 前端硬编码/拼接 preview origin；
- open 存在 GET 或缺失 Fetch Metadata 放行；
- 最终 URL 携带 bearer secret；
- preview cookie 可被 JS 读取、设置 Domain、Path 过宽或名称解析歧义；
- follow symlink 或仅字符串 startsWith containment；
- `.git/.awb` 可访问；
- 通用 static plugin 默认语义绕过专用 resolver；
- HTML CSP 允许外部网络/worker/frame/form；
- SVG 执行脚本；
- 监听失败静默禁用；
- code/secret 写日志或错误响应；
- 测试没有覆盖复制 URL 无 cookie、跨站触发和 symlink 逃逸。
- 为前端 preview 测试引入新的 DOM/E2E 框架，而不是使用 `tsx --test` + fake document。

### 重点审查

- main/preview app 生命周期是否原子；
- code delete 是否发生在 await 前；
- unique cookie name/path 是否与 sessionId 一致；
- runtime 是否有绝对 TTL/硬上限/cleanup；
- raw URL 与 decoded path 是否只 decode 一次；
- HEAD 是否不会意外发送 body；
- Range 是否只读所需区间并关闭 fd；
- stream 错误是否安全处理；
- error/log 是否泄露绝对路径；
- Vite proxy 场景是否仍可 same-origin form POST。
