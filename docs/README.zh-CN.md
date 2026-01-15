# Agent Workbench（中文说明）

## 简介

面向 AI/CLI 编程代理的本地开发工作台，支持在 Web UI 中并行管理多个工作区与可重连终端，完成 Agent 执行 → 变更审查 → 验收提交的完整流程。

## 解决的问题

随着模型能力提升，AI Agent 能独立完成的任务越来越复杂，执行时间也越来越长。开发者需要同时运行多个 Agent 并行推进任务，甚至将长时间任务交给远程机器持续执行。传统的单一本地工作目录已无法满足这种工作模式：

- **并行瓶颈**：单一工作目录无法满足多 Agent 并行执行的需求
- **会话中断**：本地终端关闭后 Agent 进程丢失，无法恢复
- **变更分散**：多个工作区的 Git 变更难以集中审查

Agent Workbench 提供：多工作区隔离、终端会话持久化、Git 变更集中审查，支持一键本地运行或远程部署。

---

## 快速启动（Docker Compose）

**前置条件**：Docker Desktop（或 Linux Docker Engine）+ Compose v2

- 克隆仓库

```bash
git clone https://github.com/nickham-su/agent-workbench.git
```

- 可选配置（推荐）
  - 复制 `.env.docker.example` 为 `.env`，按需修改变量
  - 若不创建 `.env`，Docker Compose 会使用 `docker-compose.yml` 中的默认值

- 启动服务

```bash
docker compose up -d --build
```

**访问入口**

| 地址 | 说明 |
|------|------|
| `http://127.0.0.1:4310/` | Web UI |
| `http://127.0.0.1:4310/api/health` | 健康检查 |
| `http://127.0.0.1:4310/api/docs` | API 文档 |


**工作区开发端口**

为避免每新增/开发一个项目就需要修改 `docker-compose.yml` 并重启容器，默认 Compose 配置会额外发布一段端口给工作区内启动的服务（HTTP 服务、RPC 服务等）：

- 宿主机端口：`30000-30100`
- 容器端口：`30000-30100`
- 若端口冲突导致容器启动失败，可在 `docker-compose.yml` 调整端口段

**数据持久化**

默认使用两个 named volume：

| Volume | 容器路径 | 内容 |
|--------|----------|------|
| `agent-workbench-data` | `/data` | SQLite、repo mirror、worktree、密钥等 |
| `agent-workbench-home` | `/home/dev` | 用户配置、SSH、工具链等 |

> 注意：`docker compose down -v` 会删除 volume，数据将丢失。

**安全提示**

默认为了方便会对外发布端口 `4310` 与 `30000-30100`。如需更安全的部署，建议在 `docker-compose.yml` 的 `ports` 映射前加 `127.0.0.1:` 仅允许本机访问

当前 compose 已改为 `.env` 驱动，可通过设置以下变量仅允许本机访问：

- `PUBLISH_HOST=127.0.0.1`

**环境变量**

| 变量 | 说明 |
|------|------|
| `CREDENTIAL_MASTER_KEY` | 凭证加密密钥（32 字节 hex/base64/base64url）。未设置时自动生成并保存至 `/data/keys/credential-master-key.json`。迁移场景建议显式设置。 |
| `AUTH_TOKEN` | 访问 token 保护（可选）。设置后需要在首页输入 token 登录（会话 Cookie）才能访问 Web UI/API。 |
| `AUTH_COOKIE_SECURE` | HTTPS 场景建议设为 `1`（为会话 Cookie 添加 `Secure`）；本地 HTTP 开发保持 `0`。 |
| `PUBLISH_HOST` | 端口发布的宿主机绑定地址（Docker Compose）。设为 `127.0.0.1` 可仅允许本机访问。 |

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

- 复制 `.env.example` 为 `.env.local`，按需修改变量
  - `PORT`：后端监听端口（默认 `4310`）
  - `DEV_WEB_PORT`：仅前端开发期（Vite dev server）使用：前端 dev server 端口（可选）
  - `DEV_API_ORIGIN`：仅前端开发期使用：前端 dev proxy 的后端目标地址（可选；默认 `http://127.0.0.1:${PORT}`）

**其他脚本**

| 命令 | 说明 |
|------|------|
| `npm run dev:api` | 仅启动后端 |
| `npm run dev:web` | 仅启动前端 |
| `npm run build` | 构建生产版本 |
| `npm run typecheck` | 类型检查 |
