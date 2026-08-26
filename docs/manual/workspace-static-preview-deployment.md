# Workspace 静态预览部署手册

Workspace 静态预览用于在独立来源中打开工作区内的受支持静态页面。它不是通用静态站点托管服务：预览进程与 Agent Workbench 主站在同一进程中运行，但会启动两个独立 listener，并必须使用不同的 public origin。

## 部署前必须理解的边界

| 项目 | 要求 |
|---|---|
| Main listener | 提供 AWB Web UI、API 和预览打开入口，使用 `AWB_HOST:AWB_PORT`。 |
| Preview listener | 仅提供 bootstrap、exchange 与 `/s/:sessionId/*` 静态预览，使用 `AWB_PREVIEW_HOST:AWB_PREVIEW_PORT`。 |
| Public origin | `AWB_PREVIEW_ORIGIN` 是用户浏览器访问的 preview 公共来源，必须是纯 `http(s)` origin，不能包含路径、查询参数或 fragment。它不是监听地址。 |
| 域名隔离 | main 域名只能反代 main listener；preview 域名只能反代 preview listener。preview 域不得复用给其他应用。 |
| 单实例 | V1 的 bootstrap code 与 session 存在内存中。运行 API 的实例必须为单实例，不能在多个副本间负载均衡。 |

主站即使被错误地转发了 preview 保留路径，`/s`、`/__awb`、`/preview` 及其子路径仍会返回 404；这是应用内额外防线，而不是允许混用反代目标的理由。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `AWB_PREVIEW_ENABLED` | `false` | 只有显式启用后才启动第二个 listener 并显示文件树预览入口。 |
| `AWB_PREVIEW_ORIGIN` | 无 | 启用时必填。独立的纯 `http(s)` public origin。 |
| `AWB_PREVIEW_HOST` | `127.0.0.1` | preview listener 的实际监听地址。Docker 容器内通常设为 `0.0.0.0`。 |
| `AWB_PREVIEW_PORT` | `4311` | preview listener 端口；不能与 `AWB_PORT` 相同。 |
| `AWB_PREVIEW_SESSION_TTL_SECONDS` | `3600` | session 绝对 TTL，范围 `60..86400` 秒，不会因访问而续期。 |
| `AWB_PREVIEW_PUBLISH_HOST` | `127.0.0.1` | 仅 Compose 使用：将 preview 容器端口发布到宿主机的绑定地址。 |

一次性 bootstrap code 的 TTL 固定为 60 秒，不能通过环境变量延长。

启用时，`AWB_PREVIEW_ORIGIN` 必须与主站 public origin 不同。生产环境应使用 HTTPS；当 preview origin 是 HTTPS 时，preview session cookie 会带 `Secure`。`http` 仅适合本机或受控开发环境。

## 本地源码开发

1. 复制开发模板：

   ```bash
   cp .env.dev.example .env.local
   ```

2. 在 `.env.local` 设置独立本地 origin：

   ```dotenv
   AWB_PORT=4310
   AWB_PREVIEW_ENABLED=true
   AWB_PREVIEW_ORIGIN=http://127.0.0.1:4311
   AWB_PREVIEW_HOST=127.0.0.1
   AWB_PREVIEW_PORT=4311
   AWB_PREVIEW_SESSION_TTL_SECONDS=3600
   ```

3. 启动开发服务：

   ```bash
   npm run dev
   ```

主 API 监听 `127.0.0.1:4310`，preview listener 监听 `127.0.0.1:4311`。Vite/Web UI 仍只向主 API 发送同源 form POST；不要向前端开发环境注入或拼接 preview origin。

## Docker Compose

1. 复制模板：

   ```bash
   cp .env.example .env
   ```

2. 对于仅本机访问的 HTTP 开发，填写：

   ```dotenv
   AWB_PUBLISH_HOST=127.0.0.1
   AWB_PREVIEW_PUBLISH_HOST=127.0.0.1
   AWB_PORT=4310
   AWB_PREVIEW_ENABLED=true
   AWB_PREVIEW_ORIGIN=http://127.0.0.1:4311
   AWB_PREVIEW_HOST=0.0.0.0
   AWB_PREVIEW_PORT=4311
   AWB_PREVIEW_SESSION_TTL_SECONDS=3600
   ```

3. 启动并检查：

   ```bash
   docker compose up -d --build
   docker compose exec agent-workbench printenv AWB_PREVIEW_ENABLED
   docker compose exec agent-workbench printenv AWB_PREVIEW_ORIGIN
   curl -fsS http://127.0.0.1:4310/api/health
   ```

`docker-compose.yml` 已显式将 preview 变量注入容器，并发布 preview 端口。Compose 根目录 `.env` 本身只参与变量替换；未写入 `services.agent-workbench.environment` 的变量不会自动进入容器进程。

即使 preview 当前关闭，Compose 仍可能映射 4311 端口；实际 listener 只有在 `AWB_PREVIEW_ENABLED=true` 且所有配置通过校验时才会启动。

## 生产环境：双域名 Nginx 示例

以下示例假设 Compose 将两个端口都绑定到宿主机 loopback，主站和 preview 分别使用 `awb.example.com` 与 `preview.example.com`。证书路径请替换为实际证书；两个域名都必须配置有效 TLS。

`.env`：

```dotenv
AWB_PUBLISH_HOST=127.0.0.1
AWB_PREVIEW_PUBLISH_HOST=127.0.0.1
AWB_PORT=4310
AWB_PREVIEW_ENABLED=true
AWB_PREVIEW_ORIGIN=https://preview.example.com
AWB_PREVIEW_HOST=0.0.0.0
AWB_PREVIEW_PORT=4311
AWB_PREVIEW_SESSION_TTL_SECONDS=3600
AWB_AUTH_COOKIE_SECURE=1
```

Nginx 站点配置：

```nginx
server {
    listen 80;
    server_name awb.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name preview.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name awb.example.com;

    ssl_certificate     /etc/letsencrypt/live/awb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/awb.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name preview.example.com;

    ssl_certificate     /etc/letsencrypt/live/preview.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.example.com/privkey.pem;

    # Preview 域只允许到 preview listener，绝不能指向 4310。
    location / {
        proxy_pass http://127.0.0.1:4311;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache off;
        proxy_no_cache 1;
        proxy_cache_bypass 1;
    }
}
```

不要把两个 `server_name` 转发到同一个 upstream，也不要将 preview 作为 main 域名下的子路径。不要在 preview 域上再配置其他站点、静态文件、认证入口或第三方应用。

## 缓存、TLS 与运维要求

- preview app 对 bootstrap、exchange、错误页和静态资源均发送 `Cache-Control: no-store`；反向代理/CDN 不得覆盖、缓存或重新验证这些响应。
- 不要在 preview 域启用会忽略 origin 响应头的缓存规则。若前置 CDN 存在，必须为整个 preview 域禁用边缘缓存。
- 生产 preview origin 必须是 HTTPS，使 preview session cookie 自动携带 `Secure`。主站自身的认证 cookie 仍需按部署设置 `AWB_AUTH_COOKIE_SECURE=1`。
- 只运行一个 API/preview 进程副本。升级、重启或切换实例会使内存中的 preview session 失效，这是预期行为。
- 监控 listener 状态、session 创建量与 4xx/5xx；日志不得记录 bootstrap code、session secret 或工作区绝对路径。

## 启用前与回滚检查

启用前确认：

1. `AWB_PREVIEW_ORIGIN` 为独立 HTTPS origin，且与主站不同。
2. preview 端口已发布或仅供预期反代访问；两个域名的 upstream 分别正确。
3. 进程为单实例；反向代理与 CDN 不缓存 preview 响应。
4. 从 Web UI 的文件树打开 HTML、图片、音频或视频，确认跳转到 preview 域；直接访问错误域的 preview 路径应为 404。

最快的安全回滚：

```dotenv
AWB_PREVIEW_ENABLED=false
```

重启服务后，preview listener 不再启动、内存 session 立即失效、health 的 `previewEnabled` 变为 `false`，文件树入口隐藏。随后删除 preview 域名反代和端口发布即可；该功能没有数据库迁移需要回滚。
