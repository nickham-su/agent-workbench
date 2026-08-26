# 实体设计与代码地图

返回 [README](./README.md)。本文件定义目标实体、共享合同、配置结构、代码基线和预计改动位置。

## Shared Preview Catalog

必须新增 `packages/shared/src/contracts/workspace-preview.ts`，并从 `packages/shared/src/index.ts` 导出。

### 资源类型

```ts
export type WorkspacePreviewResourceKind =
  | "html"
  | "css"
  | "script"
  | "image"
  | "audio"
  | "video"
  | "font";

export type WorkspacePreviewResourceDescriptor = {
  extension: string;
  mime: string;
  kind: WorkspacePreviewResourceKind;
  entry: boolean;
  range: boolean;
};
```

### 固定目录

```ts
export const WORKSPACE_PREVIEW_RESOURCES = {
  ".html": { mime: "text/html; charset=utf-8", kind: "html", entry: true, range: false },
  ".htm": { mime: "text/html; charset=utf-8", kind: "html", entry: true, range: false },
  ".css": { mime: "text/css; charset=utf-8", kind: "css", entry: false, range: false },
  ".js": { mime: "text/javascript; charset=utf-8", kind: "script", entry: false, range: false },
  ".mjs": { mime: "text/javascript; charset=utf-8", kind: "script", entry: false, range: false },
  ".png": { mime: "image/png", kind: "image", entry: true, range: false },
  ".jpg": { mime: "image/jpeg", kind: "image", entry: true, range: false },
  ".jpeg": { mime: "image/jpeg", kind: "image", entry: true, range: false },
  ".gif": { mime: "image/gif", kind: "image", entry: true, range: false },
  ".webp": { mime: "image/webp", kind: "image", entry: true, range: false },
  ".avif": { mime: "image/avif", kind: "image", entry: true, range: false },
  ".bmp": { mime: "image/bmp", kind: "image", entry: true, range: false },
  ".ico": { mime: "image/x-icon", kind: "image", entry: true, range: false },
  ".svg": { mime: "image/svg+xml", kind: "image", entry: true, range: false },
  ".mp3": { mime: "audio/mpeg", kind: "audio", entry: true, range: true },
  ".wav": { mime: "audio/wav", kind: "audio", entry: true, range: true },
  ".ogg": { mime: "audio/ogg", kind: "audio", entry: true, range: true },
  ".m4a": { mime: "audio/mp4", kind: "audio", entry: true, range: true },
  ".aac": { mime: "audio/aac", kind: "audio", entry: true, range: true },
  ".flac": { mime: "audio/flac", kind: "audio", entry: true, range: true },
  ".mp4": { mime: "video/mp4", kind: "video", entry: true, range: true },
  ".webm": { mime: "video/webm", kind: "video", entry: true, range: true },
  ".ogv": { mime: "video/ogg", kind: "video", entry: true, range: true },
  ".mov": { mime: "video/quicktime", kind: "video", entry: true, range: true },
  ".woff": { mime: "font/woff", kind: "font", entry: false, range: false },
  ".woff2": { mime: "font/woff2", kind: "font", entry: false, range: false },
  ".ttf": { mime: "font/ttf", kind: "font", entry: false, range: false },
  ".otf": { mime: "font/otf", kind: "font", entry: false, range: false }
} as const;
```

实际实现可以用数组/Map，但扩展名、MIME、entry/range 必须与此等价。新增类型必须先修改设计与测试矩阵。

### Shared Helper

```ts
export function getWorkspacePreviewResourceDescriptor(filePath: string): WorkspacePreviewResourceDescriptor | null;
export function isWorkspacePreviewEntryPath(filePath: string): boolean;
```

要求：

- 不访问文件系统；
- 使用 basename 最后扩展名；
- ASCII lower case；
- query/fragment 不属于 filesystem path，传入包含它们时应返回 null，而不是自行剥离；
- 未知/无扩展返回 null。

## Shared API Contract

### Health

当前 `HealthResponseSchema` 字段为 `ok/name/version/authEnabled/authed`。目标增加：

```ts
previewEnabled: Type.Boolean()
```

字段必须存在，不使用 optional，以便前后端版本同步由 workspace build 保证。

### Open Request

必须在 `workspace-preview.ts` 定义：

```ts
export const WorkspacePreviewOpenRequestSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 })
});
export type WorkspacePreviewOpenRequest = Static<typeof WorkspacePreviewOpenRequestSchema>;
```

Open 成功是 303 无 JSON schema。错误复用 `ErrorResponseSchema`。

Exchange 是 preview-only 内部浏览器合同，不从 `@agent-workbench/shared` 导出给 Web UI API client，避免形成通用客户端承诺；其私有类型放在 preview 模块。

## Env 与 Context 实体

### Env

`apps/api/src/config/env.ts` 的 `Env` 增加：

```ts
preview: PreviewConfig;
```

推荐避免增加五个松散顶层字段。若遵循现有平铺风格，也必须在构造后封装为 readonly config 传给 runtime。

```ts
type PreviewConfig =
  | { enabled: false }
  | {
      enabled: true;
      origin: string;
      host: string;
      port: number;
      sessionTtlMs: number;
      bootstrapTtlMs: 60_000;
    };
```

### AppContext

`apps/api/src/app/context.ts` 增加最小能力：

```ts
preview: {
  enabled: boolean;
  runtime: PreviewRuntime | null;
};
```

public origin 和内部监听配置不必暴露给所有业务模块；open route 可从 runtime/config 专用接口取得 redirect origin。避免把 code/session Maps 放入 `AppContext`。

## Runtime Entity

### BootstrapRecord

```ts
type PreviewBootstrapRecord = {
  code: string;
  workspaceId: string;
  entryPath: string;
  createdAt: number;
  expiresAt: number;
};
```

不持久化，不日志输出 code。

### PreviewSessionRecord

```ts
type PreviewSessionRecord = {
  sessionId: string;
  cookieSecret: string;
  cookieName: string;
  workspaceId: string;
  entryPath: string;
  createdAt: number;
  expiresAt: number;
};
```

说明：

- `entryPath` 用于 exchange 后首次跳转和诊断，不限制后续资源范围；
- `cookieName = awb_preview_${sessionId}`；
- cookieSecret 只存在内存和 HttpOnly cookie；
- Maps 分别以 code/sessionId 为 key。

### CreatedPreviewSession

```ts
type CreatedPreviewSession = {
  sessionId: string;
  cookieName: string;
  cookieSecret: string;
  cookiePath: string;
  redirectPath: string;
  expiresAt: number;
};
```

route 用该值设置 cookie；不得把 cookieSecret 返回 JSON。

## Resolver Entity

```ts
type ResolvedPreviewTarget =
  | {
      kind: "file";
      workspaceId: string;
      workspaceRootReal: string;
      relativePath: string;
      absolutePath: string;
      stat: Stats;
      resource: WorkspacePreviewResourceDescriptor;
    }
  | {
      kind: "directory";
      workspaceId: string;
      relativePath: string;
      absolutePath: string;
    };
```

目录解析 `index.html` 后最终必须转成 file target。公开 route/service 不应长期传裸 absolutePath；绝对路径只在 filesystem 层使用，不进入 response/log。

### Resolver Error

必须使用以下结构化私有失败枚举；类型名可按项目风格调整，但值和映射不得变化：

```ts
type PreviewPathFailure =
  | "invalid_path"
  | "encoded_separator"
  | "workspace_missing"
  | "path_missing"
  | "path_escape"
  | "denied_segment"
  | "symlink"
  | "not_regular"
  | "unsupported_type"
  | "permission_denied"
  | "changed_during_open";
```

统一映射到 [02-product-contract.md](./02-product-contract.md) 的 HTTP 状态。不要依赖 Node 原始 error message 对外响应。

## 当前代码地图

### API 启动与应用组装

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `apps/api/src/main.ts` | 加载 env、DB、context，创建单个 app 并 listen | 创建 preview runtime/app，管理两个 listener 的原子启动与关闭 |
| `apps/api/src/config/env.ts` | 解析 `AWB_*` host/port/auth/web 等配置 | 增加 preview enable/origin/host/port/TTL 解析与严格校验 |
| `apps/api/src/app/context.ts` | 主 app 共享上下文类型 | 增加最小 preview capability/runtime 引用 |
| `apps/api/src/app/createApp.ts` | 注册主 app 插件、auth、模块、Web UI | 注册 formbody 与 workspace preview open；不得注册 preview static |
| `apps/api/src/app/webUi.ts` | `@fastify/static` 服务 `apps/web/dist`，未知 HTML GET 做 SPA fallback | 必须修改 not-found：`/s`、`/__awb`、`/preview` 精确路径和子路径先返回 404；其他 AWB SPA fallback 保持不变；不得用它服务 preview 文件 |
| `apps/api/src/app/errors.ts` | `HttpError`/错误类型 | 可复用主 app 错误；preview app 建独立安全 error handler |

### 认证与浏览器请求

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `apps/api/src/app/auth.ts` | `/api/*` 主站 cookie guard；health/login 等例外 | open 自然受保护；新增 same-origin Fetch Metadata helper 可放独立安全模块 |
| `apps/api/src/infra/auth/sessionCookie.ts` | 主站 `awb_session` 创建、验证、cookie header、cookie parse | 可复用 cookie header 构造思路和 timing-safe helper；不得复用主站 cookie 作为 preview 授权 |
| `apps/api/src/modules/auth/auth.service.ts` | 登录设置 host-only Lax cookie | 不修改主登录语义；文档已考虑 Lax 与跨站 POST |

### Health 与 Shared

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `packages/shared/src/contracts/health.ts` | `HealthResponseSchema` | 增加必填 `previewEnabled` |
| `apps/api/src/modules/health/health.service.ts` | 返回 version/auth 状态 | 返回 preview enabled，不暴露 origin |
| `apps/api/src/modules/health/health.routes.ts` | `/api/health` schema route | schema 随 shared 更新 |
| `packages/shared/src/index.ts` | shared exports | 导出 workspace preview catalog/contract |
| `packages/shared/src/contracts/files.ts` | `FileEntry`、file stat/read 等 | `FileEntry.path/kind` 被前端入口复用；不向 FileEntry 增加 previewable 字段 |
| `packages/shared/src/contracts/workspace-files.ts` | workspace file CRUD/search body schema | open request 单独放 preview contract，不混入 read-text 语义 |

### Workspace 与文件安全

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `apps/api/src/modules/workspaces/workspaces.module.ts` | 注册 workspace 和 workspace files routes | 注册 `registerWorkspacePreviewRoutes` |
| `apps/api/src/modules/workspaces/workspace-files.routes.ts` | list/search/stat/read/write/create/upload/download | 不塞入 preview static；可参考 schema/error 风格 |
| `apps/api/src/modules/workspaces/workspace-files.service.ts` | workspace scope、safe resolve、deny `.git`、realpath、symlink、CRUD/search/upload/download | 抽取/复用安全基础；preview 需专用 URL parser，denylist 扩为 `.git/.awb`，不得改变现有 API 合同 |
| `apps/api/src/modules/files/files.service.ts` | repo-target file CRUD 与安全路径 | repo 目录中的现有安全模式可参考；preview 统一以 workspace root 解析 |
| `apps/api/src/modules/workspaces/workspace.store.ts` | `getWorkspace`、repo records | 每次 open/exchange/static 请求验证 workspace 存在；读取 `ws.path` |
| `apps/api/src/infra/fs/paths.ts` | data/workspace/repo 系统路径 | 不用 URL 暴露这些路径；preview 不从 workspaceId 自行拼磁盘目录，必须查 DB record |

### Web 文件树

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `apps/web/src/features/workspace/tools/file-explorer/components/FileExplorerTree.vue` | Ant Tree 与右键菜单渲染 | 增加 `canPreview` prop、菜单项 `preview` |
| `apps/web/src/features/workspace/tools/file-explorer/FileExplorerToolView.vue` | workspace 文件加载、selectedNode、菜单命令分发 | 调 shared entry helper；实现同步 form open；处理 preview action |
| `apps/web/src/features/workspace/tools/file-explorer/types.ts` | `TreeNode` 包装 `FileEntry` | 无需增加协议字段 |
| `apps/web/src/features/workspace/views/WorkspaceLayout.vue` | workspace/tool 组装和 props 传递 | 把运行时 `previewEnabled` 传给文件工具，具体传播方式按现有 context/props 风格 |
| `apps/web/src/features/auth/session.ts` | `/api/health` 缓存 auth/version | `AuthStatus` 增加 previewEnabled，health 失败默认 false |
| `apps/web/src/shared/i18n/locales/zh-CN.ts` | 中文文案 | 增加 `files.actions.preview` 及必要错误提示 |
| `apps/web/src/shared/i18n/locales/en-US.ts` | 英文文案 | 同步增加对应 key |
| `apps/web/src/shared/api/api.ts` | axios `/api` 客户端 | 不为 open 增加 axios 方法；form 直接提交 |

### Vite 与运行时 Env

| 当前文件 | 当前职责 | 目标改动/复用 |
|---|---|---|
| `apps/web/vite.config.ts` | dev `/api` proxy，构建期 `__DEV_API_TARGET__` | 不注入 preview origin；现有 proxy 支持 form POST |
| `apps/web/src/env.d.ts` | Vite build global 类型 | 不增加 preview origin global |
| `.env.example` | 部署环境示例 | 增加 preview 配置和独立 origin 注释 |
| `docker-compose.yml` | 容器端口/env/卷 | 显式发布/转发 preview port，生产文档提醒独立域名 |
| `Dockerfile` | 构建与运行镜像 | 通常无需代码改动；确认第二监听端口可由部署发布 |

### 包与依赖

| 当前文件 | 目标改动 |
|---|---|
| `apps/api/package.json` | 必须增加 `@fastify/formbody`；现有 Fastify/TypeBox 足够其他部分 |
| `packages/shared/package.json` | 通常无新依赖 |
| `apps/web/package.json` | 不得增加 DOM/E2E 测试依赖；helper/menu/form 测试必须使用现有 `tsx --test`、纯函数和最小 fake document |
| 根 `package.json` | 通常无需修改脚本；现有 build/typecheck 应覆盖 |

## 目标新增文件地图

下列路径固定为目标组织；测试文件可按现有相邻测试风格合并，但生产职责不得混淆：

```text
packages/shared/src/contracts/workspace-preview.ts

apps/api/src/modules/preview/preview-runtime.ts
apps/api/src/modules/preview/preview-runtime.test.ts
apps/api/src/modules/preview/preview-security.ts
apps/api/src/modules/preview/preview-security.test.ts
apps/api/src/modules/preview/preview-file.service.ts
apps/api/src/modules/preview/preview-file.service.test.ts
apps/api/src/modules/preview/preview-response.ts
apps/api/src/modules/preview/preview-response.test.ts
apps/api/src/modules/preview/preview.routes.ts
apps/api/src/modules/preview/preview.integration.test.ts
apps/api/src/app/createPreviewApp.ts

apps/api/src/modules/workspaces/workspace-preview.routes.ts
apps/api/src/modules/workspaces/workspace-preview.routes.test.ts
apps/api/src/modules/workspaces/workspace-path-safety.ts     # 若抽取现有基础原语

apps/web/src/features/workspace/tools/file-explorer/preview.ts
apps/web/src/features/workspace/tools/file-explorer/preview.test.ts
```

preview 生产模块必须放在 `apps/api/src/modules/preview`，并保证：

- main open route 是 workspace 主站模块；
- preview app 路由不注册到 main app；
- runtime/store 不依赖 Fastify，可单元测试；
- filesystem resolver 不依赖浏览器 response，可单元测试；
- shared catalog 是前后端唯一类型真相。

## 预计不应修改的区域

除非实现发现本文基线已变化并先修订设计，以下区域不应因本功能改动：

- DB schema/migrations；
- Agent Worker、tool protocol、Prompt；
- Git、terminal、credential、plugin 模块；
- workspace 文件 CRUD 对 `..` 的既有拒绝合同；
- 主站 auth cookie Domain/SameSite；
- Monaco editor 的 binary/text preview 语义。

`registerWebUi()` 属于本次明确必须修改区域，但改动边界仅限 preview 保留前缀 404。不得改变其他 AWB 前端路由的 SPA fallback、静态 dist root 或 `/api` 404 语义。
