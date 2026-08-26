# Workspace 静态预览服务（独立 Preview Origin）

> 状态：设计定稿，待实施。
> 适用范围：Agent Workbench workspace 文件树中的静态页面与多媒体预览；首期新增独立 preview listener、短时有状态预览会话、主站打开接口与文件树菜单。
> 基线：本文档以当前仓库代码为依据；代码位置以**文件路径 + 符号/职责**为准，行号仅用于辅助检索，不构成实现依赖。

## 文档目的

本目录是一套可直接用于开发、代码审查和验收的规范。它解决的核心问题是：AI Agent 可以在 workspace 任意路径编写 HTML、CSS、JavaScript 和本地媒体资源，用户需要从“文件”工具直接在浏览器新标签页查看效果，同时不得让不可信预览脚本获得 Agent Workbench UI/API 的同源权限。

方案不是把 workspace 目录挂到主站 `/preview`，而是由同一 API 进程启动第二个 Fastify listener，通过独立 public origin 提供受限静态预览。主站负责认证和启动预览；preview listener 只负责 bootstrap、会话兑换和静态文件响应。

## 快速结论

- 预览内容必须运行在与 AWB UI/API 不同的 origin；主 origin 下不得存在可执行 workspace 内容的预览路由。
- 主 app 必须把 `/s`、`/__awb`、`/preview` 作为 preview 保留前缀并显式返回 404；必须修改现有 `registerWebUi()` SPA fallback 排除这些前缀，禁止误返回 AWB `index.html`。
- 同一后端进程必须启动第二个 Fastify listener；启用后配置非法或监听失败必须导致进程启动失败，不得静默降级。
- 文件树仅对 `.html/.htm` 和浏览器可直接展示的图片、音频、视频显示“预览”；CSS、JS、字体只作为资源加载。
- 前端不得读取或拼接 preview origin；右键点击必须同步提交同源临时 form 到 `POST /api/workspaces/:workspaceId/preview/open`，由主服务返回 `303`。
- `open` 与 preview `exchange` 必须 fail-closed 要求 `Sec-Fetch-Site: same-origin`；不得接受跨站 GET/POST 触发。
- preview origin 使用 fragment bootstrap code、同源 exchange、path-scoped HttpOnly cookie 建立有状态 session；最终 URL 不是 bearer URL。
- URL 以 workspace 根为基准：`/s/{sessionId}/{workspaceRelativePath}`；允许相对引用跨目录，但不得越出 workspace。
- 首期是“面向 AI 生成的轻量、本地依赖静态页面预览”，不是通用静态站点托管；不支持根绝对资源路径、SPA fallback、外部 CDN、JSON、manifest、WASM、source map 或 symlink 路径。
- HTML/JS 是不可信主动内容。独立 origin 的目标是保护 AWB UI/API；资源扩展名白名单不是 workspace 数据保密边界。
- 所有静态响应必须 `no-store`、`no-referrer`、`nosniff`；HTML 与顶层 SVG 使用不同安全策略；媒体支持单区间 Range。

## 阅读路径

| 文档 | 用途 |
|---|---|
| [01-overview.md](./01-overview.md) | 背景、业务链路、目标、范围、角色、术语与安全边界 |
| [02-product-contract.md](./02-product-contract.md) | 配置、入口、接口、会话、路径、资源、响应、错误与非目标合同 |
| [03-decisions.md](./03-decisions.md) | 关键决策、替代方案、取舍原因、风险与明确接受的限制 |
| [04-technical-design.md](./04-technical-design.md) | 目标架构、请求时序、路径解析、会话存储、响应头、Range 与启动关闭设计 |
| [05-entity-and-code-map.md](./05-entity-and-code-map.md) | 实体、共享类型、配置结构、代码地图、预计新增/修改文件 |
| [06-testing-acceptance.md](./06-testing-acceptance.md) | 测试矩阵、攻击用例、可执行验收标准与代码审查清单 |
| [07-implementation-plan.md](./07-implementation-plan.md) | 任务拆分、依赖顺序、详细实施步骤、每步完成定义、回滚与发布 |

## 规范性用语

- “必须”对应 `MUST`，是开发、审查和验收的强制要求。
- “不得”对应 `MUST NOT`，违反即视为方案未实现。
- “应该”对应 `SHOULD`，只有本文已经列明的兼容或平台原因才可偏离，并必须在代码审查中说明。
- “可以”对应 `MAY`，是不改变外部合同的实现自由。
- “当前实现”描述文档编写时的代码事实；“目标设计”描述开发完成后必须达到的状态。

发生冲突时，按以下优先级解释：

- [02-product-contract.md](./02-product-contract.md) 的外部行为与安全合同；
- [04-technical-design.md](./04-technical-design.md) 的技术不变量和解析规则；
- [06-testing-acceptance.md](./06-testing-acceptance.md) 的可验证标准；
- [03-decisions.md](./03-decisions.md) 的动机与取舍说明；
- [07-implementation-plan.md](./07-implementation-plan.md) 的实施顺序。

任何实现若需要突破产品合同或技术不变量，必须先更新本设计并重新评审，不得以“实现方便”为由在代码中隐式改变边界。

## 核心信任边界

```text
可信 AWB 主站 origin
  └─ 已认证、same-origin POST open
       └─ 一次性 bootstrap code（仅在 fragment）
            └─ 不可信 preview origin 的可信 bootstrap 页面
                 └─ same-origin POST exchange
                      └─ path-scoped HttpOnly preview cookie
                           └─ workspace 白名单静态资源
                                └─ 不可信 HTML / JavaScript 执行
```

必须保持以下不变量：

- preview origin 不得注册或代理 AWB API/UI；主 origin 不得服务 workspace 可执行预览内容。
- 主 origin 的 `/s`、`/__awb`、`/preview` 精确路径及其子路径不得进入 AWB Web UI SPA fallback，无论 preview 功能是否启用都必须返回主站 404。
- 最终预览 URL 单独复制到另一浏览器或无对应 cookie 的客户端时不得可访问。
- 预览 session 授权的是一个 workspace 内的白名单资源集合，而不是主站权限、系统目录或其他 workspace。
- 页面脚本可以读取同一 preview session 下路径已知的白名单文件；这属于已接受的 V1 语义，不能宣传为文件级机密隔离。
