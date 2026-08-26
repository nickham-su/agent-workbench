# Workspace 静态预览页面编写指南

Workspace 静态预览是供 Agent 生成和查看轻量静态页面的受限运行环境。它会在独立 preview origin 中打开工作区文件，并以严格 CSP 和资源白名单响应。请按本指南生成页面，避免把它当作完整 Web 托管、开发服务器或 SPA 平台。

## 推荐写法

### 使用相对路径与工作区本地资源

页面入口和资源都应放在同一工作区内，并从 HTML 使用相对路径：

```html
<link rel="stylesheet" href="./assets/site.css" />
<script type="module" src="./assets/main.js"></script>
<img src="./assets/diagram.png" alt="架构图" />
<video controls src="./assets/demo.mp4"></video>
```

- 可以使用相对路径，例如 `./assets/site.css`、`../shared/logo.svg`。
- 资源必须是工作区内的本地文件，并且属于预览支持的资源类型。
- HTML、HTM、SVG、常见图片、音频和视频可作为文件树中的预览入口；CSS、JS/MJS 和字体是可被入口加载的本地资源，但不是独立预览入口。
- 工作区文件每次请求都会重新读取；Agent 修改后，在浏览器手动刷新即可看到结果。

## 不要使用的写法

### 不要使用根绝对路径

```html
<!-- 错误：会从 preview origin 根路径请求，而不是从当前文件所在目录解析。 -->
<script src="/assets/main.js"></script>
```

改用相对路径：

```html
<script src="./assets/main.js"></script>
```

### 不要依赖外部网络或 CDN

```html
<!-- 错误：外部 CDN 和网络请求不受支持。 -->
<link rel="stylesheet" href="https://cdn.example.invalid/site.css" />
<script src="https://cdn.example.invalid/app.js"></script>
```

请将依赖下载或构建到工作区本地目录，再使用相对路径引用。页面 CSP 只允许当前 preview origin 的连接；不要依赖外部 `fetch`、WebSocket、iframe、worker、service worker、表单提交或 popup。

## V1 不支持的站点能力

| 能力 | 行为与替代方式 |
|---|---|
| SPA history fallback | 不提供未知路由回退。为每个需要直接打开的页面创建实际 HTML 文件，并使用相对链接。 |
| 目录列表 | 请求目录不会显示文件列表。需要入口时在目录中提供 `index.html`。 |
| JSON / manifest / source map | 不提供 `.json`、`.webmanifest`、`.map` 等响应。将展示数据内联到页面或构建为受支持的本地 JS。 |
| WASM | 不提供 `.wasm`。使用普通本地 JavaScript 实现，或不要把 WASM 作为预览依赖。 |
| 任意文件下载/文本托管 | `.txt`、`.pdf`、`.xml`、未知或无扩展名文件不在静态资源白名单中。 |
| 自动刷新 / HMR | 不提供。修改文件后手动刷新浏览器页面。 |

预览同样不跟随 symlink，也不会暴露工作区中的 `.git` 或 `.awb` 内容。

## Agent 生成页面的检查清单

1. 选择实际存在的 `index.html`、其他 `.html/.htm` 或受支持媒体文件作为入口。
2. 将 CSS、JS、图片、字体和媒体放进工作区，并仅用相对路径引用。
3. 不要以 `/assets/...` 等根绝对 URL 引用资源。
4. 不要引入 CDN、第三方脚本、外部 API、外部字体或网络图片。
5. 不要假设有 SPA fallback、目录 listing、JSON、WASM、source map 或 HMR。
6. 修改后让用户刷新 preview 标签页确认结果；需要重新打开时，从 Agent Workbench 文件树的“预览”菜单操作。

## 故障排查

- **文件树没有“预览”菜单**：确认部署者已启用 preview；入口必须是受支持的 HTML、图片、音频或视频文件，目录、CSS、JS/MJS、字体不会显示入口。
- **资源加载失败**：检查路径是否相对于当前 HTML 文件，资源是否在工作区内、不是 symlink，并且属于支持类型。
- **刷新后预览失效**：preview session 有绝对过期时间，服务重启也会清空内存 session。返回 Agent Workbench 后重新打开预览。
- **页面依赖网络请求**：将所需资源作为本地文件随页面提供；不能通过放宽 CSP 或配置外部白名单解决。
