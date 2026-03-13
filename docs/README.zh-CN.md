# Agent Workbench（中文说明）

## 简介

面向 AI/CLI 编程代理的远程开发工作台，支持在 Web UI 中并行管理多个工作区与可重连终端，完成 Agent 执行 → 变更审查 → 验收提交的完整流程。

## 解决的问题

随着模型能力提升，AI Agent 能独立完成的任务越来越复杂，执行时间也越来越长。开发者需要同时运行多个 Agent 并行推进任务，甚至将长时间任务交给远程机器持续执行。传统的单一本地工作目录已无法满足这种工作模式：

- **并行瓶颈**：单一工作目录无法满足多 Agent 并行执行的需求
- **会话中断**：本地终端关闭后 Agent 进程丢失，无法恢复
- **信息分散**：前后端分离/微服务等架构往往对应多个仓库，信息分散

Agent Workbench 提供: 多工作区隔离, 终端会话持久化, Git 变更集中审查, 支持本地一键启动, 也适合部署到远程主机运行.

---

## 快速启动（Docker Compose）

**前置条件**：Docker Desktop（或 Linux Docker Engine）+ Compose v2

- 克隆仓库

```bash
git clone https://github.com/nickham-su/agent-workbench.git
```

- 可选配置（推荐）
  - 复制 `.env.example` 为 `.env`（推荐），按需修改变量
    - `.env.docker.example` 作为兼容保留，内容与 `.env.example` 一致
  - 若不创建 `.env`，Docker Compose 会使用 `docker-compose.yml` 的默认值（Compose 默认值），
    未指定的运行参数会回落到应用代码默认值

- 启动服务

```bash
docker compose up -d --build
```

**验证环境变量已注入容器（可选）**

```bash
docker compose exec agent-workbench printenv AWB_AGENT_WORKER_CONCURRENCY
docker compose exec agent-workbench printenv AWB_AGENT_LOOP_MAX_STEPS
```

**访问入口**

默认端口是 4310. 如果你在 `.env` 里修改了 `AWB_PORT`, 请把下面地址中的端口替换为你的值.

| 地址 | 说明 |
|------|------|
| `http://127.0.0.1:4310/` | Web UI |
| `http://127.0.0.1:4310/api/health` | 健康检查 |
| `http://127.0.0.1:4310/api/docs` | API 文档 |


**工作区开发端口**

为避免每新增/开发一个项目就需要修改 `docker-compose.yml` 并重启容器，默认 Compose 配置会额外发布一段端口给工作区内启动的服务（HTTP 服务、RPC 服务等）：

- 宿主机端口段: 由 `.env` 的 `AWB_WORKSPACE_PORT_RANGE` 控制, 默认 `30000-30100`
- 容器端口段: 同上
- 若端口冲突导致容器启动失败, 修改 `.env` 的 `AWB_WORKSPACE_PORT_RANGE` 后重启容器即可

**数据持久化**

默认使用两个 named volume：

| Volume | 容器路径 | 内容 |
|--------|----------|------|
| `agent-workbench-data` | `/data` | SQLite、repo mirror、worktree、密钥等 |
| `agent-workbench-home` | `/home/dev` | 用户配置、SSH、工具链等 |

> 注意：`docker compose down -v` 会删除 volume，数据将丢失。

**安全提示**

`docker-compose.yml` 为了方便默认会对外发布端口 `4310` 与 `AWB_WORKSPACE_PORT_RANGE`（当未创建 `.env` 时）。
推荐的 `.env.example` 模板默认仅绑定 localhost（`AWB_PUBLISH_HOST=127.0.0.1`）。如果你把服务部署在远程主机上, 建议优先按更安全的方式暴露服务:

- 通过 `.env` 设置 `AWB_PUBLISH_HOST=127.0.0.1`, 仅允许本机访问
- 在宿主机上使用 Nginx/Caddy 等做 HTTPS 反代对外提供访问
- 启用 `AWB_AUTH_TOKEN` 作为最小鉴权手段, 并在 HTTPS 场景设置 `AWB_AUTH_COOKIE_SECURE=1`
- 谨慎对外暴露 `AWB_WORKSPACE_PORT_RANGE`, 因为它会把工作区内启动的服务端口也一起发布出去(必要时缩小端口段, 或在自定义的 compose 配置中移除该段端口映射)

如果你需要在局域网/公网直接暴露端口, 可以使用 `AWB_PUBLISH_HOST=0.0.0.0`, 并配合防火墙规则与鉴权设置.

**环境变量**

> 说明：Docker Compose 的 `.env` 默认主要用于变量替换。只有在 `docker-compose.yml` 的
> `services.<name>.environment`（或 `env_file`）中显式注入的变量，才会进入容器内进程环境。

| 变量 | 说明 |
|------|------|
| `AWB_PORT` | Web UI + API 对外发布端口(默认 `4310`). |
| `AWB_WORKSPACE_PORT_RANGE` | 工作区端口段(默认 `30000-30100`), 用于发布工作区内启动的服务. |
| `AWB_FILE_MAX_BYTES` | 文件预览/对比最大字节数(默认 `1048576`). |
| `AWB_APP_VERSION` | 可选:显式指定 `/api/health` 的 version. |
| `AWB_CREDENTIAL_MASTER_KEY` | 凭证加密密钥（32 字节 hex/base64/base64url）。未设置时自动生成并保存至 `/data/keys/credential-master-key.json`。迁移场景建议显式设置。 |
| `AWB_AUTH_TOKEN` | 访问 token 保护（可选）。设置后需要在首页输入 token 登录（会话 Cookie）才能访问 Web UI/API。 |
| `AWB_AUTH_COOKIE_SECURE` | HTTPS 场景建议设为 `1`(为会话 Cookie 添加 `Secure`), 本地 HTTP 开发保持 `0`. |
| `AWB_PUBLISH_HOST` | 端口发布的宿主机绑定地址(Docker Compose). 设为 `127.0.0.1` 可仅允许本机访问. |
| `AWB_AGENT_STARTUP_RECOVERY_MODE` | Agent 启动恢复策略：`fail`（默认，终止未完成 run）或 `recover`（尝试恢复未完成 run）。 |
| `AWB_AGENT_WORKER_ENABLED` | 是否启用 agent worker 进程（默认 `true`）。设为 `0` 会回退到 API 进程内 runtime（一般仅用于排障）。 |
| `AWB_AGENT_WORKER_CONCURRENCY` | worker 并发执行 run 的上限（默认 `2`）。注意：同一个 sessionId 的 run 仍会串行。 |
| `AWB_AGENT_LOOP_MAX_STEPS` | worker 的 step-loop 最大轮数（默认 `128`），`<=0` 表示不限制。 |
| `AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD` | step-loop 中连续重复工具调用阈值（默认 `20`），`<=0` 表示不限制。 |
| `AWB_AGENT_DEBUG_DUMP` | 调试落盘开关（`1` 开启）。会在 `<workspace>/.debug/agent_context_item_logs/` 写入日志。 |

其他 Compose 相关变量(如 `AWB_HOST`, `AWB_DATA_DIR`, `AWB_SERVE_WEB`, `AWB_WEB_DIST_DIR`)请以 `.env.example` 为准.

---

## 使用流程

- 在 **Repos** 中添加仓库（支持 HTTPS/SSH），需要鉴权时先在 **Settings** 中配置凭证
- 在 **Workspaces** 中基于仓库与分支创建工作区，进入后即可使用
- 在终端中启动 Agent 或执行构建、测试等任务
- 在代码审查面板中查看 staged/unstaged 变更与双栏对比，完成验收后提交推送

---

## 终端操作提示

**选中文本**

终端中选中文本需配合修饰键：

| 平台 | 操作 |
|------|------|
| macOS | 按住 `Option(⌥)` 拖拽选中 |
| Windows / Linux | 按住 `Shift` 拖拽选中 |

选中后使用 `⌘C`（macOS）或 `Ctrl+Shift+C`（Windows/Linux）复制。

**滚动历史输出**

使用鼠标滚轮即可。在 `vim`、`top` 等全屏程序中，使用程序自身的滚动方式。

---

## 本地开发

**前置条件**

- Node.js LTS（20.x 或 22.x）
- `git`、`tmux`
- 基础构建工具链（macOS 需要 Xcode Command Line Tools，用于编译 `better-sqlite3`、`node-pty`）

**启动**

```bash
npm install
npm run dev
```

**本地环境变量**

- 复制 `.env.dev.example` 为 `.env.local`，按需修改变量
  - `AWB_PORT`：后端监听端口（默认 `4310`）
  - `AWB_DEV_WEB_PORT`：仅前端开发期（Vite dev server）使用：前端 dev server 端口（可选）
  - `AWB_DEV_API_ORIGIN`：仅前端开发期使用：前端 dev proxy 的后端目标地址（可选；默认 `http://127.0.0.1:${AWB_PORT}`）

**飞书插件本地调试（`npm run dev`）**

如需本地调试飞书 IM 插件，请至少设置：

- `AWB_AGENT_PLUGIN_HOST_ENABLED=true`
- `AWB_AGENT_PLUGIN_HOST_DEV=1`
- `AWB_AGENT_PLUGIN_SERVICES_ENABLED=true`

并确保 agent worker 正常运行（默认 `AWB_AGENT_WORKER_ENABLED=true`）。
若 worker 未运行，run 无法完成，reply dispatcher 不会派发最终回复。

允许触发 IM 会话运行的发送者请在设置页 `设置 -> Agent -> IM用户列表` 中配置。

**其他脚本**

| 命令 | 说明 |
|------|------|
| `npm run dev:api` | 仅启动后端 |
| `npm run dev:web` | 仅启动前端 |
| `npm run build` | 构建生产版本 |
| `npm run typecheck` | 类型检查 |
