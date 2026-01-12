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

```bash
docker compose up -d --build
```

**访问入口**

| 地址 | 说明 |
|------|------|
| `http://127.0.0.1:4310/` | Web UI |
| `http://127.0.0.1:4310/api/health` | 健康检查 |
| `http://127.0.0.1:4310/api/docs` | API 文档 |

**数据持久化**

默认使用两个 named volume：

| Volume | 容器路径 | 内容 |
|--------|----------|------|
| `agent-workbench-data` | `/data` | SQLite、repo mirror、worktree、密钥等 |
| `agent-workbench-home` | `/home/dev` | 用户配置、SSH、工具链等 |

> 注意：`docker compose down -v` 会删除 volume，数据将丢失。

**安全提示**

默认仅绑定 `127.0.0.1:4310`。如需对外访问，建议配置反向代理与鉴权后再调整端口绑定。

**环境变量**

| 变量 | 说明 |
|------|------|
| `CREDENTIAL_MASTER_KEY` | 凭证加密密钥（32 字节 hex/base64/base64url）。未设置时自动生成并保存至 `/data/keys/credential-master-key.json`。迁移场景建议显式设置。 |

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

**其他脚本**

| 命令 | 说明 |
|------|------|
| `npm run dev:api` | 仅启动后端 |
| `npm run dev:web` | 仅启动前端 |
| `npm run build` | 构建生产版本 |
| `npm run typecheck` | 类型检查 |
