# 关键决策、取舍与风险

返回 [README](./README.md)。本文件记录已定稿选择、未采用方案、原因和代价。表中的决策不是实现时可重新选择的建议。

## 决策摘要

| 主题 | 定稿决策 |
|---|---|
| 浏览器安全域 | 使用独立 preview origin，禁止主 origin 下执行 workspace 内容 |
| 主站保留前缀 | `/s`、`/__awb`、`/preview` 在 main app 显式 404，并从 Web UI SPA fallback 排除 |
| 服务进程 | 同一 API 进程启动第二个 Fastify listener |
| 用户入口 | 文件树 HTML/媒体右键菜单；CSS/JS/字体不做入口 |
| Open 触发 | 同源 form POST 到主服务，303 到 preview bootstrap |
| 跨站防护 | open/exchange 对 `Sec-Fetch-Site` fail-closed；拒绝跨站 GET/POST |
| 授权模型 | fragment 一次性 code + 有状态 session + path-scoped HttpOnly cookie |
| 授权粒度 | 整个 workspace 的白名单资源，不是单文件或目录 |
| 路径根 | workspace 根；支持浏览器相对引用，不支持根绝对 URL |
| 文件安全 | deny `.git/.awb`，任意 symlink 链路拒绝，realpath containment |
| 产品定位 | 轻量、本地依赖静态页面预览，不是通用静态站点托管 |
| 文件类型 | shared 固定 entry/resource/MIME 映射；未知类型拒绝 |
| 静态实现 | 专用 resolver/streamer；不直接把 workspace 交给通用 static root |
| 主动内容 | HTML/JS 不可信；CSP 阻止常见外部网络出口，独立 origin 保护 AWB |
| 持久化 | code/session 仅进程内存；单实例；重启失效 |
| 失败策略 | 启用后配置或监听失败即启动失败 |

## 独立 Preview Origin，而不是主站 `/preview`

### 选择

主站和预览必须是不同 origin，例如：

```text
https://awb.example.com
https://preview.example.com
```

即使 preview URL 有 `/preview` 或 `/s` 路径，也只能位于独立 preview origin。

### 原因

workspace HTML/JavaScript 是用户或 AI 生成的不可信主动内容。同源部署会使脚本具备：

- 调用 `/api/*` 的同源能力；
- 携带主站 cookie 的能力；
- 读取主站 Web Storage/IndexedDB 的能力；
- 与主 UI DOM、Service Worker 和缓存共享安全域的机会。

路径前缀、CSP 或文件白名单都不能替代浏览器 origin 隔离。

### 不采用

- **主 origin `/preview/*`**：与核心安全目标冲突。
- **在 iframe 中使用同源 `/preview` + sandbox**：新标签页需求仍存在；iframe sandbox 配置容易因 `allow-scripts/allow-same-origin` 组合产生脆弱边界，也不能覆盖用户直接打开 URL 的情况。
- **仅设置 CSP**：CSP 是纵深防御，不是同源权限隔离。

### 代价

- 需要第二 listener、独立端口/域名和反向代理配置；
- 主站 cookie 不能直接用于 preview origin；
- 需要单独 bootstrap/session 流程。

该代价是实现安全产品语义的必要成本。

### 主站 SPA Fallback 的必要修改

独立 origin 不只要求“main app 不注册 preview route”，还要求 preview 约定路径误到 main app 时不能被现有 AWB SPA fallback 伪装成成功页面。因此必须修改 `registerWebUi()` 的 not-found 边界：

- `/s`、`/__awb`、`/preview` 精确路径和子路径先返回 404；
- 其他正常 AWB 前端路由继续回退 `index.html`；
- 保留前缀规则在 preview disabled 时也生效。

这不是在主站实现 preview，也不是把两个 origin 合并；它是防止错误反向代理、手工输入或未来路由冲突破坏 origin 隔离合同。

不采用“只依赖生产反向代理不会误路由”，因为应用自身测试无法证明该假设，且当前 `registerWebUi()` 对未知 HTML GET 会返回 200 AWB 页面，造成审查和运维歧义。

## 同一进程的第二 Fastify Listener

### 选择

同一 Node.js API 进程创建：

- main app：现有 UI/API；
- preview app：bootstrap、exchange、`/s/*` 静态响应。

### 原因

- 可以直接复用 DB、workspace store、路径解析和日志基础设施；
- code/session 可保存在同进程内存，无需首期引入 Redis/DB 表；
- 部署上只有一个应用进程，同时保留两个浏览器 origin。

### 不采用

- **独立 preview 微服务**：需要额外部署、内部鉴权、workspace 挂载和共享状态，超出 V1。
- **子进程静态服务器**：生命周期、端口、错误传播和安全策略更复杂。
- **复用 `registerWebUi()` 服务 preview 内容**：它把固定 dist 根挂到 `/` 并带 SPA fallback，不符合动态 workspace/session、denylist 和无 fallback 合同。只允许修改其 fallback 保留前缀拒绝逻辑。

### 代价与约束

- `main.ts` 必须管理两个 app 的原子启动与关闭；
- 测试必须分别注入 main/preview app；
- V1 多副本不可用，部署必须单实例。

## 使用 Form POST，而不是 GET 或异步 API

### 选择

文件树点击时同步提交 `target="_blank"` 的同源 form POST，由主服务返回 303。

### 原因

- 同步用户手势降低 popup blocker 风险；
- 现有主站 `SameSite=Lax` cookie 在同源 POST 中可用，而跨站表单 POST 不携带；
- `Sec-Fetch-Site: same-origin` 可以明确限制 Web UI 调用；
- 后端拥有 public preview origin 的唯一权威配置。

### 不采用

- **GET open**：跨站顶层导航会携带 Lax cookie，外部站点可能触发用户运行已知 workspace 页面。
- **axios/fetch 后 `window.open`**：异步返回时容易被 popup blocker 拦截。
- **前端拼接 preview URL**：需要把部署配置注入前端并可能与后端不一致，也无法安全签发会话。
- **通用 JSON open API**：扩大攻击面和兼容承诺，不符合仅 Web UI 使用的边界。

### 接受的限制

自动化客户端缺少浏览器 `Sec-Fetch-Site` 时不能调用 open/exchange。测试应直接构造所需 header；该接口不承诺第三方 API 使用。

## Fail-Closed Fetch Metadata

### 选择

open/exchange 仅接受 `Sec-Fetch-Site: same-origin`，缺失也拒绝。

### 原因

“缺失则放行”会使旧浏览器、脚本客户端和某些代理绕过跨站触发防护。功能只面向当前 Web UI，不需要为了通用兼容降低边界。

### Origin 校验取舍

- preview exchange 的 public origin 已由配置明确，`Origin` 存在时必须精确校验；
- main open 在当前代码没有可信代理模型，不能盲信任 `X-Forwarded-*`；
- 实现只能在能够可靠确定 direct request origin 时增加 Origin 精确比较，不能让不可靠 Origin 推导成为误拒绝生产请求的唯一依据；
- `Sec-Fetch-Site` 仍是强制、不可缺失的主合同。

后续若引入 `trustProxy`/public main origin，应单独设计并把 Origin 校验升级为始终强制。

## Fragment Bootstrap + 有状态 Session

### 选择

```text
主站 303 -> /__awb/bootstrap#code
bootstrap -> POST /__awb/exchange
exchange -> Set-Cookie + redirectPath
最终 -> /s/{sessionId}/path
```

### 原因

- fragment 不进入 HTTP 请求、反向代理访问日志或 Referer；
- code 单次、短 TTL，缩短初始凭据暴露窗口；
- 最终 URL 不包含 bearer secret；
- path-scoped HttpOnly cookie 让页面脚本不能读取 secret，并使复制 URL 到其他浏览器失效；
- session 有状态，可在 workspace 删除、过期、进程关闭时撤销。

### 不采用

- **签名/bearer query URL**：相对子资源不会自动继承 query；URL 会进入日志、历史和分享。
- **bearer path URL**：相对子资源可继承，但 secret 长期出现在地址栏和代理日志，复制即可重放整个 workspace 白名单访问。
- **共享主站 cookie Domain**：要求两个 origin 位于同一父域，扩大 cookie 暴露面，并让 preview 内容参与主认证边界。
- **单文件签名**：HTML 子资源无法自然加载；需要重写内容或逐资源签名。
- **localStorage token**：不可信 workspace JS 可直接读取。

### 代价与限制

- 需要 bootstrap 页面和内存 store；
- 每个 session 产生一个 path-scoped cookie；大量标签可能接近浏览器 cookie 限制，因此 session 上限固定 256；
- 主站 logout 不立即撤销已有 session；这是 V1 已知限制。

## Workspace 粒度授权

### 选择

session 绑定一个 workspace，允许读取其中所有白名单资源。

### 原因

页面可能从兄弟目录、父目录或共享资产目录加载资源；单文件/单目录授权会导致合法静态页面频繁失败，或要求复杂依赖图解析。

### 风险

不可信 JS 可以枚举/猜测路径并读取白名单文件，再通过浏览器能力尝试外传。CSP 阻止常见外部网络加载和连接，但不把 preview 当成机密沙箱。

### 应对

- 明确产品语义，不把白名单宣传为数据保密；
- deny `.git/.awb`；
- 只开放必要类型；
- 禁止外部连接、frame、form、worker、popup 和导航；
- 使用独立专用域名；
- 不提供放宽外网策略的配置。

### 不采用

- **只授权入口目录**：破坏跨目录共享资源。
- **自动扫描依赖并最小授权**：HTML/CSS/JS 动态加载无法可靠静态求解，复杂且产生错误安全感。

## Workspace 根 URL 与相对路径

### 选择

URL 显式包含 sessionId，剩余路径以 workspace 根为基准。页面应使用相对 URL。

### 原因

- 与现有文件树 `FileEntry.path` 一致；
- 不暴露 workspace 真实目录名或磁盘路径；
- 支持 workspace 根和多个 repo 目录间的共享资源；
- 浏览器自然处理 `./`、`../` 和目录 base URL。

### 不支持根绝对 URL 的原因

`/assets/app.js` 会离开 `/s/{sessionId}`。若要支持，必须引入：

- HTML/CSS/JS 内容重写；或
- 每 session 子域；或
- 全局“当前 session”状态。

这些方案分别有语义破坏、DNS/TLS/部署复杂度或并发歧义，V1 全部不采用。

## 全链路拒绝 Symlink

### 选择

目标和任意祖先路径命中 symlink 都拒绝，即使 `realpath` 最终仍在 workspace 内。

### 原因

- 降低 TOCTOU 和路径逃逸审查复杂度；
- 与现有 workspace 文件服务的安全倾向一致；
- 预览是便利能力，不应为了兼容 symlink 扩大文件系统攻击面。

### 代价

部分采用 symlink 组织 assets/node_modules 的现有站点无法预览。该行为是明确 V1 限制，不是实现缺陷。

## 显式资源白名单

### 选择

shared package 固定 entry/resource/MIME 表，前端和后端共用。

### 原因

- 防止菜单与服务端能力漂移；
- MIME 稳定，不依赖操作系统；
- 未知类型默认拒绝，便于审计；
- V1 范围可被测试完全枚举。

### 不采用

- **所有文件**：把源码、配置和潜在敏感文件直接暴露给页面。
- **仅按浏览器 MIME 猜测**：环境差异和 MIME sniffing 风险。
- **首期开放 JSON/WASM/manifest**：会把轻量页面预览扩成应用托管，没有当前业务证据。

## 自定义静态 Resolver/Streamer

### 选择

preview app 使用专用路径 resolver、授权检查和流式响应，不把 workspace 根直接注册为 `@fastify/static` root。

### 原因

- root 随 session/workspace 动态变化；
- 必须逐段拒绝 symlink、denylist 和编码歧义；
- 必须区分 entry/resource 和顶层 SVG；
- 必须实现 session cookie、目录 canonical redirect、单区间 Range 和稳定错误语义；
- 通用 static 插件的默认缓存、fallthrough、index 和 dotfile 语义难以证明完全符合合同。

`@fastify/static` 可以继续用于现有 AWB Web UI，但不得成为 preview 文件安全边界。

## 内存 Store、单实例和绝对 TTL

### 选择

code/session 保存在进程内存，session 绝对过期，不滑动续期。

### 原因

- V1 不需要分享和持久化；
- 重启失效符合临时预览语义；
- 避免新增 DB schema、清理迁移和跨服务密钥；
- 绝对 TTL 防止长期打开标签无限延长授权。

### 不采用

- **SQLite 持久化**：重启后继续有效不符合临时能力，且需保存/加密 secret。
- **无状态签名 session**：无法可靠立即撤销 workspace 删除，会回到 bearer URL/cookie 签名复杂度。
- **滑动 TTL**：后台页面或自动请求可能无限延长访问。

## 启动失败而非静默关闭

### 选择

启用后任何配置或监听失败都必须让进程失败。

### 原因

部署者已显式声明依赖 preview 功能。静默关闭会造成：

- health/UI 状态与部署期望不一致；
- 反向代理返回不可解释错误；
- 开发/验收环境误以为功能已覆盖。

关闭开关仍是明确的安全回滚方式。

## 明确接受的风险

- preview 页可读取同 workspace 白名单资源；
- 主站 logout 到 session TTL 之间仍可访问；
- CSP 不是绝对机密沙箱；
- 受信任的反向代理和浏览器仍可能记录不含 secret 的 sessionId/路径；
- 相对路径、本地资源限制会让部分已有网站无法完整运行；
- 单实例内存状态不支持水平扩展。

这些风险必须通过产品边界、部署文档和验收测试体现，不得在实现中悄然扩大或用模糊文案掩盖。
