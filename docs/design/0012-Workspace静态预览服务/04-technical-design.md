# 技术设计

返回 [README](./README.md)。本文件定义目标架构、组件职责、请求时序、路径解析、会话存储、响应策略和生命周期。

## 总体架构

```text
                          same process
┌──────────────────────────────────────────────────────────────┐
│ Agent Workbench API process                                  │
│                                                              │
│ ┌────────────────────────┐  shared ctx/store  ┌────────────┐ │
│ │ Main Fastify App       │<------------------>| Preview    │ │
│ │ AWB_HOST:AWB_PORT      │                    │ Runtime    │ │
│ │                        │                    │ Store      │ │
│ │ /api/*                 │                    └─────┬──────┘ │
│ │ AWB Web UI             │                          │        │
│ └──────────┬─────────────┘              ┌───────────▼──────┐ │
│            │                            │ Preview Fastify   │ │
│            │ 303 public origin          │ App               │ │
│            └───────────────────────────>| PREVIEW_HOST:PORT │ │
│                                         │ /__awb/bootstrap │ │
│                                         │ /__awb/exchange  │ │
│                                         │ /s/:sessionId/*  │ │
│                                         └──────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 组件职责

| 组件 | 职责 | 明确不得承担 |
|---|---|---|
| Main app | 现有 auth、health、workspace API；创建 bootstrap code；303；preview 保留前缀显式 404 | 不服务 workspace 内容，不注册/代理 preview static 路由 |
| Preview app | bootstrap、exchange、session 静态资源与错误页 | 不注册 AWB API/UI、Swagger、terminal、agent、WebSocket |
| Preview runtime store | code/session 生命周期、原子消费、容量和清理 | 不持久化到 DB，不跨实例同步 |
| Shared preview catalog | entry/resource/MIME 判定 | 不做文件系统访问或用户输入授权 |
| Workspace preview resolver | workspace 查询、URL/路径规范化、denylist、symlink、realpath containment | 不信任扩展名以外的客户端 MIME，不跟随 symlink |
| Preview response service | CSP、安全头、HEAD/GET、Range、stream | 不做 SPA fallback、目录 listing、内容重写 |
| Web file explorer | 显示入口、form POST | 不读取 public origin，不生成 token/session URL |

## 路由归属与主站 Fallback 边界

### 路由总表

| App | 方法与路径 | Handler | 未匹配行为 |
|---|---|---|---|
| Main | `POST /api/workspaces/:workspaceId/preview/open` | workspace preview open route | 其他方法按 API 404/405，不创建 code |
| Main | `/api/*` | 现有 API modules/auth | 现有 API 404 |
| Main | `/s`、`/s/*` | 无 preview handler | 显式主站 404，不进 SPA fallback |
| Main | `/__awb`、`/__awb/*` | 无 preview handler | 显式主站 404，不进 SPA fallback |
| Main | `/preview`、`/preview/*` | 无 handler，V1 保留 | 显式主站 404，不进 SPA fallback |
| Main | 其他非 API 页面 GET | `@fastify/static`/Web UI | 可按现有合同回退 AWB `index.html` |
| Preview | `GET /__awb/bootstrap` | 内置 bootstrap | 精确路由 |
| Preview | `POST /__awb/exchange` | exchange route | 精确路由 |
| Preview | `GET/HEAD /s/:sessionId/*` | session static route | 按 session/文件合同响应 |
| Preview | `/api/*`、`/preview*`、`/` 和其他路径 | 无 handler | preview app 404，不返回 AWB UI |

### Main Web UI Fallback 修改

`apps/api/src/app/webUi.ts` 当前 `setNotFoundHandler()` 在未知 GET、Accept 包含 HTML 时执行 `reply.sendFile("index.html")`。目标实现必须在该 fallback 最前部加入保留前缀判断。

固定 helper 语义：

```ts
const MAIN_PREVIEW_RESERVED_PREFIXES = ["/s", "/__awb", "/preview"] as const;

function isMainPreviewReservedPath(pathname: string) {
  return MAIN_PREVIEW_RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
```

not-found 顺序固定为：

- 从 raw URL 提取 pathname，不做业务二次 decode；
- `/api/*` 保持现有 404；
- 命中 preview 保留前缀时立即 `reply.code(404).send({ message: "Not Found" })`；
- 非 GET 保持 404；HEAD 命中保留前缀时同样 404 且不发送 body；
- 只有剩余、接受 HTML 的普通页面 GET 才允许 AWB SPA fallback。

不得仅在反向代理配置中处理，也不得只在 preview enabled 时注册该保护。

## 应用启动与关闭

### 配置阶段

`loadEnv(process.env)` 必须在任何 listener 启动前完成所有 preview 校验，并形成不可变配置：

```ts
type PreviewConfig =
  | { enabled: false }
  | {
      enabled: true;
      origin: string;
      originUrl: URL;
      host: string;
      port: number;
      sessionTtlMs: number;
      bootstrapTtlMs: 60_000;
    };
```

环境配置不得散落在 route handler 中重复解析。

### 组装阶段

目标结构必须保持以下依赖方向；具体工厂参数命名可以遵循项目风格：

```ts
const previewRuntime = createPreviewRuntime({ ctx, config: env.preview });
const previewApp = env.preview.enabled
  ? await createPreviewApp({ ctx, previewRuntime, config: env.preview })
  : null;
const mainApp = await createApp({ ...ctx, previewRuntime });
```

`AppContext` 必须只保存只读 preview capability/runtime 接口，不得让普通模块直接操作内部 Map。

### 监听顺序

固定要求：

- 所有 app 必须先构造完成，再开始 listen；
- 必须先监听 preview app，再监听 main app，使主站不会在 preview 尚不可用时报告 enabled；
- 任一 listen 失败必须关闭已经监听的另一个 app，再抛出原错误；
- 只有两个 listen 都成功后才输出“服务已启动”日志。

### 关闭

- 捕获现有运行时的正常关闭路径时，同时 `close()` 两个 Fastify app；
- runtime store 的 timer 必须停止，Map 清空；
- close 应幂等；
- 不做 session 持久化或恢复。

## Main Open 请求时序

```text
FileExplorerToolView
  -> create temporary form(target=_blank)
  -> POST main /api/workspaces/:workspaceId/preview/open
       -> existing auth guard
       -> assertPreviewWebUiRequest(Sec-Fetch-Site, optional reliable Origin)
       -> validate workspace + entry path now
       -> previewRuntime.issueBootstrapCode(...)
       -> 303 Location: PREVIEW_ORIGIN/__awb/bootstrap#code
  -> browser navigates new tab to preview origin
```

open 任一校验失败时，主 app 继续通过现有 JSON error handler 响应；新标签页直接显示 JSON/纯错误，不渲染专用 HTML。不得为改善该 UX 增加异步预检查。

### Open Route

必须新增独立 workspace preview route 文件，不与 `workspace-files.routes.ts` 的 CRUD 路由混杂：

```ts
registerWorkspacePreviewRoutes(app, ctx)
```

请求 body schema 使用 TypeBox：

```ts
const WorkspacePreviewOpenRequestSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 })
});
```

Fastify 必须使用新增依赖 `@fastify/formbody` 解析 `application/x-www-form-urlencoded`，并只在 main app 注册。open route 的 `bodyLimit` 固定为 8 KiB。不得改成 JSON 或自定义宽松 parser 来回避表单合同。

### Web UI 请求校验

建议纯函数：

```ts
function assertSameOriginBrowserRequest(params: {
  secFetchSite: string | undefined;
  origin: string | undefined;
  expectedOrigin?: string;
}): void
```

固定行为：

- `secFetchSite !== "same-origin"` 直接 403；
- expectedOrigin 可靠且 Origin 存在时，用 URL effective origin 精确比较；
- Origin 格式非法时 403；
- 不读取任意 `X-Forwarded-*`；
- 不使用 Referer 替代 Origin/Fetch Metadata。

open 与 exchange 必须复用相同语义 helper，不得各写一套宽松程度不同的逻辑。

## Bootstrap 与 Exchange 时序

```text
GET /__awb/bootstrap#code
  -> server receives no code
  -> return built-in HTML + strict bootstrap CSP
  -> JS reads hash
  -> history.replaceState clears hash
  -> POST /__awb/exchange { code }
       -> same-origin metadata/origin guard
       -> consume code atomically
       -> revalidate workspace/entry
       -> create session
       -> Set-Cookie path=/s/sessionId/
       -> { redirectPath }
  -> location.replace(redirectPath)
```

### Bootstrap HTML

页面必须由 `modules/preview` 内的专用 renderer/源码常量构建，不得使用 workspace 模板；必须完全自包含，不依赖 Vue、AWB Web UI bundle 或外部库。

伪代码：

```js
const code = location.hash.startsWith("#")
  ? location.hash.slice(1)
  : "";
history.replaceState(null, "", "/__awb/bootstrap");
if (!code) return showError();
const response = await fetch("/__awb/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code }),
  credentials: "same-origin"
});
if (!response.ok) return showError();
const { redirectPath } = await response.json();
location.replace(redirectPath);
```

必须先清 fragment 再 fetch。错误处理不得输出 code。

Bootstrap CSP 固定为：

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
connect-src 'self';
img-src data:;
frame-ancestors 'none';
form-action 'none';
base-uri 'none';
```

同时 `COOP: same-origin`，使跳入 preview origin 后切断与 main tab 的 opener browsing context group。

### Code 原子消费

内存 JS 单线程下也必须采用“先 get，再 delete，再异步 revalidate”的顺序：

```ts
const record = codes.get(code);
if (!record) ...;
codes.delete(code);
if (record.expiresAt <= now) ...;
await revalidate(record);
```

不得在 await 后才 delete，否则并发 exchange 可重复消费。

## Runtime Store 设计

### 接口

```ts
interface PreviewRuntime {
  enabled: boolean;
  publicOrigin: string | null;
  issueBootstrap(input: { workspaceId: string; entryPath: string }): BootstrapRecord;
  consumeBootstrap(code: string): BootstrapRecord;
  createSession(input: { workspaceId: string; entryPath: string }): CreatedPreviewSession;
  authenticateSession(input: { sessionId: string; cookieSecret: string | null }): PreviewSessionRecord;
  revokeSession(sessionId: string): void;
  cleanupExpired(now?: number): void;
  close(): void;
}
```

`issueBootstrap` 只应由 main route 调用，`consumeBootstrap/createSession/authenticateSession` 由 preview app 调用。若实现合并 consume/create，原子性和测试边界仍必须保留。

### 随机值

使用 `crypto.randomBytes(24).toString("base64url")` 或更强值：

- 24 bytes = 192 bit 熵，满足至少 128 bit；
- code、sessionId、cookieSecret 分别独立生成；
- 日志不得记录完整值；最多记录 sessionId 截断摘要用于诊断，但默认不需要。

### 时间

- store 应依赖可注入 `nowMs()`，便于确定性测试；
- bootstrap `expiresAt = createdAt + 60_000`；
- session `expiresAt = createdAt + configured TTL`；
- 比较使用 `expiresAt <= now` 视为过期；
- session 请求不得更新 `expiresAt`。

### Secret 比较

cookie secret 必须使用 constant-time 比较；可抽取与 `sessionCookie.ts` 类似的 length check + `crypto.timingSafeEqual`。不得直接 `===` 比较 secret。

### Cookie 数量

目标实现必须采用**每 session 唯一 cookie 名**：

```text
awb_preview_<sessionId>
```

并同时设置 `Path=/s/{sessionId}/`。cookie 名中的 sessionId 已限定为 base64url，合法且公开。请求时只读取当前 session 对应名称，避免同名不同 Path 的 Cookie header 解析歧义。不得使用通用 `parseCookieHeader()` 后按固定 cookie 名取值。

清 cookie 必须用相同 name/path，并设置 `Max-Age=0`。

## Workspace Path Resolver

### 为什么必须专用模块

当前 `workspace-files.service.ts` 的 `isValidRelativePath()` 明确拒绝任何 `..` 输入，适合 API body，但 preview 浏览器 URL 可能在网络到达前已规范化 `../`。当前 helper 也主要 deny `.git`。因此应抽取安全基础原语或新增 preview resolver，不能直接调用私有 CRUD helper 后声称满足本合同。

必须新增并使用以下职责模块；若安全基础原语从现有 service 抽出，文件名按此固定：

```text
apps/api/src/modules/workspaces/workspace-path-safety.ts
apps/api/src/modules/preview/preview-file.service.ts
```

共享基础职责：

- 获取 workspace record，并以 `path.resolve(ws.path)` 为 root；
- 安全解析 workspace-relative POSIX path；
- 逐级 `lstat` 拒绝 symlink；
- 目标 `realpath` containment；
- denylist path segment；
- 返回经过验证的 fd/stat/absolute path 或结构化错误。

现有 workspace file API 可以后续复用抽取 helper，但本次不得为重构而改变其对 `..`、错误码或 repo domain 的既有合同。

### 原始 URL 校验

Fastify wildcard param 可能已经 decode。preview route 必须同时取得 `req.raw.url` 检查原始 pathname：

- 去掉 query（正常静态 URL 不使用 query，但可忽略 query；响应仍 no-store）；
- 大小写不敏感拒绝 `%2f`、`%5c`；
- malformed percent encoding 应由框架或业务返回 400；
- 不做 `decodeURIComponent` 第二次解码。

### Session 路由提取

路由固定为：

```text
/s/:sessionId/*
/s/:sessionId
```

- sessionId 必须符合固定 base64url 长度/字符模式；
- `/s/:sessionId` 必须 308 到 `/s/:sessionId/`，之后按 workspace 根目录 `index.html` 处理；
- wildcard 剩余路径视为已一次解码的 workspace-relative path；
- backslash 无论平台均拒绝，URL 只接受 `/`。

### 逐级安全打开

为尽量缩小 check/open TOCTOU：

- 从 workspace root 的真实路径开始；
- 对每个已有 segment `lstat`，任一 symlink 拒绝；
- 拒绝 `.git/.awb` 大小写变体；
- 目标必须 regular file 或 directory；
- 对最终目标 `realpath` 并确认仍在 root realpath 下；
- 获取 stat 后以 `fs.createReadStream(absPath, { fd? })` 流式响应。

Node 跨平台没有完整 openat/no-follow 链路；V1 必须通过逐级 lstat + realpath + 打开后 `fstat` 复核尽力缩小竞态：

- 打开文件 descriptor 后 `fstat` 必须仍是 regular file；
- 可比较打开前后 dev/ino（平台字段可用时）；不一致则关闭并返回 409/403 安全失败；
- 不得因为预览便利而跟随新出现的 symlink。

### Repo 目录

preview URL 不需要现有 `resolveWorkspaceDomain()` 的 repo 特殊分派。workspace record 的 `ws.path` 已是统一根，repo 是其一级目录。resolver 直接在 workspace 根处理，仍必须保护 `.git` 和 repo symlink。

## Entry/Resource Catalog

shared 文件固定为：

```text
packages/shared/src/contracts/workspace-preview.ts
```

固定结构示例：

```ts
type WorkspacePreviewResourceKind =
  | "html" | "css" | "script" | "image"
  | "audio" | "video" | "font";

type WorkspacePreviewResourceDescriptor = {
  extension: string;
  mime: string;
  kind: WorkspacePreviewResourceKind;
  entry: boolean;
  range: boolean;
};
```

表必须是唯一真相来源。前端只调用 `isWorkspacePreviewEntryPath`；后端调用完整 descriptor。扩展名从 basename 的最后一个 `.` 取得并转 ASCII lower case。无扩展、隐藏文件和多重后缀只看最后扩展，例如 `secret.json.js` 视为 JS；因此白名单不是数据保密边界。

## Preview Static Request 时序

```text
GET/HEAD /s/:sessionId/*
  -> validate raw URL encoding + sessionId syntax
  -> find expected unique cookie name
  -> constant-time authenticate session
  -> verify not expired; workspace still exists
  -> normalize/canonicalize workspace path
  -> safe resolve directory/file, reject denylist/symlink/escape
  -> directory? redirect or resolve index.html
  -> resource catalog lookup; reject unknown
  -> determine top-level SVG by resource kind/path (always strict SVG policy)
  -> stat/fd revalidate
  -> set common + type-specific headers
  -> GET stream body / HEAD omit body
```

不要依赖 `Accept` 进行 SPA fallback。静态文件存在且类型允许时按 MIME 返回；不存在始终 404。

## 安全响应头实现

必须集中使用以下职责 helper，禁止 route 分支手写遗漏：

```ts
applyCommonPreviewHeaders(reply)
applyBootstrapHeaders(reply)
applyWorkspaceHtmlHeaders(reply)
applySvgHeaders(reply)
applyBinaryResourceHeaders(reply)
applyPreviewErrorHtmlHeaders(reply)
```

### Common

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
Cross-Origin-Resource-Policy: same-origin
```

### HTML

使用 [02-product-contract.md](./02-product-contract.md) 固定 CSP。实现不得增加 `connect-src https:`、`script-src https:`、`frame-src` 或 `worker-src` 放行。

`Permissions-Policy` 建议序列化为：

```text
camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), midi=(), document-domain=()
```

### 顶层 SVG

所有 SVG 都用禁脚本 CSP。不要尝试通过 `Sec-Fetch-Dest` 区分“图片资源”后放宽，因为 Referer/dest 不是授权边界，统一严格更可审计。

### Error HTML

错误页不执行脚本，CSP：

```text
default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox;
```

## Range 设计

### 解析函数

```ts
function parseSingleByteRange(raw: string | undefined, size: number):
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "invalid" };
```

规则：

- 仅 `bytes=`；
- 逗号直接 invalid；
- start/end 必须十进制安全整数；
- `start >= size` invalid；
- end 缺失取 `size - 1`；end 超 size 截到 `size - 1`；
- suffix `-N` 中 N 必须 > 0，start 为 `max(0, size-N)`；
- 空文件上的任何 Range invalid；
- `end < start` invalid。

206：

```text
Content-Range: bytes {start}-{end}/{size}
Content-Length: end-start+1
Accept-Ranges: bytes
```

416：

```text
Content-Range: bytes */{size}
Accept-Ranges: bytes
```

HEAD + Range 必须返回与 GET 相同的 206/416 头，但无 body。

## 错误处理与日志

### 主 app

主 app 的 open/API 错误和 preview 保留前缀 404 使用 JSON/Not Found，不新增主站 HTML 错误 renderer。该响应可能直接显示在 form 打开的新标签页，属于 V1 合同。

继续使用现有 `HttpError` JSON error handler。preview-specific code 固定为：

```text
PREVIEW_DISABLED
PREVIEW_REQUEST_FORBIDDEN
PREVIEW_PATH_UNSAFE
PREVIEW_ENTRY_UNSUPPORTED
```

错误 message 不包含磁盘路径。

### Preview app

不得复用主 app JSON/Swagger 组装。应有独立 error handler：

- bootstrap exchange 始终返回最小 JSON error；
- `/s/*` 错误若 `Accept` 包含 `text/html`，返回固定 HTML；其他请求返回 `text/plain; charset=utf-8` 固定消息；HEAD 使用同状态/头但无 body；
- 无论格式都设置 common headers；
- 500 记录服务端错误摘要，但 response 不含堆栈、绝对路径、code/secret。

### 日志

可以记录：

- preview listener public origin、内部 host/port；
- session 创建/过期数量；
- status、workspaceId、规范化相对路径（项目日志若允许）；
- 安全拒绝原因枚举。

不得记录：

- bootstrap code；
- cookie secret/cookie header；
- 完整 Location fragment；
- 文件正文；
- 绝对 workspace 路径。

反向代理必须配置不记录 fragment（标准 HTTP 本就不可见），并应谨慎处理最终 URL 路径中的 workspace-relative path。

## Health 与前端运行时能力

`HealthResponse` 增加必填 boolean：

```ts
previewEnabled: boolean;
```

health 不返回 public origin、host、port、TTL 或内部状态。`getHealth()` 从 `ctx.preview.enabled` 返回。

前端 `AuthStatus` 增加 `previewEnabled` 并缓存；`resetAuthStatus()` 必须将其重置为 false。`WorkspaceLayout` 必须从已加载的运行时状态通过 props 传到 `FileExplorerToolView`，不得让文件树重复请求 health。

如果 health 请求失败，前端必须默认 `previewEnabled=false`，不显示菜单。

## 前端集成

### 共享 helper

```ts
import { isWorkspacePreviewEntryPath } from "@agent-workbench/shared";
```

`FileExplorerToolView` 增加：

```ts
const canPreviewSelectedNode = computed(() =>
  props.previewEnabled &&
  selectedNode.value?.data.kind === "file" &&
  isWorkspacePreviewEntryPath(selectedNode.value.data.path)
);
```

传给 `FileExplorerTree` 控制菜单。菜单 key 固定 `preview`，i18n 增加中英文文案。

### Form Helper

必须使用独立纯 helper，并把所需 document 能力缩小为最小接口，便于在现有 `tsx --test` 中使用 fake document 单测：

```ts
openWorkspacePreview({ workspaceId, path, documentRef = document })
```

必须：

- form style hidden；
- method `post`，target `_blank`；
- action 使用 encodeURIComponent workspaceId；
- input name `path`；
- append、submit、finally remove；
- 不加入 `rel`（form 无该属性）；opener 隔离由 preview COOP 完成。

V1 不得为该 helper 引入 jsdom、happy-dom、Playwright、Cypress 或其他 DOM/浏览器测试框架。菜单显示判定必须抽成纯函数/computed 可测逻辑；form 行为使用最小 fake document/element 对象验证。真实新标签、COOP 和 CSP 通过人工浏览器验收脚本验证。

若同步 `submit()` 抛错，主页面显示通用错误消息；新标签页被浏览器策略拦截时浏览器通常无可靠同步 API，文档只提示允许该站点打开新标签，不承诺自动检测。

## 部署拓扑

### 本地开发

```text
AWB main:    127.0.0.1:4310
Vite web:    可选独立 dev port，/api proxy 到 4310
Preview:     127.0.0.1:4311
Public origin: http://127.0.0.1:4311
```

注意：Vite UI origin 与 API origin 不同时，form action `/api/...` 由 Vite proxy 转发；浏览器看到的请求仍是 Vite same-origin，`Sec-Fetch-Site` 为 same-origin。main handler 不应依赖后端直接 Host 等于浏览器 UI host，进一步说明 V1 open 的 Origin 只能在可靠时附加校验。

### 生产

```text
awb.example.com      -> main listener 4310
preview.example.com  -> preview listener 4311
```

必须确保：

- preview 域不路由 `/api` 到 main；
- main 域不路由 `/s`、`/__awb` 或 `/preview` 到 preview；
- 即使反向代理误把 preview 路径发送到 main listener，main app 也必须返回 404，不得返回 AWB `index.html`；
- 两域分别设置 TLS；
- preview 域不与其他应用共用；
- 反代不缓存 preview 响应；
- 单 API 实例或会话粘滞不能替代共享 store 的声明，V1 直接要求单实例。
