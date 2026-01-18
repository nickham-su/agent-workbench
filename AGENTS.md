# 项目级 AGENTS.md（agent-workbench）

## 沟通与输出

- 默认使用中文交流（含注释与文档）
- 文档内容优先用多级标题与无序列表组织，避免使用序号列表

## 项目概览

- 这是一个面向 AI/CLI 编程代理的本地开发工作台（MVP）
- 仓库形态：Monorepo，使用 `npm workspaces`

## 技术栈与模块

- 后端：Node.js + TypeScript（ESM）+ Fastify + SQLite（`better-sqlite3`）+ WebSocket + `tmux` + `node-pty`
- 前端：Vite + Vue3 + TypeScript + `ant-design-vue` + TailwindCSS + Monaco + xterm.js
- 共享包：`packages/shared`，用 TypeBox 维护前后端共享契约（schema + 类型）

## 环境准备

- Node.js：建议 LTS（例如 20.x 或 22.x）
- 必备命令：`git`、`tmux`
- 原生依赖编译：`better-sqlite3`、`node-pty` 可能需要本机具备基础构建工具链（macOS 通常需要 Xcode Command Line Tools）

## 编码约定（本项目常见模式）

- TypeScript ESM：保持 `type: "module"` 语义，内部相对导入通常使用 `.js` 扩展名（例如 `./config/env.js`）
- 路径拼接：统一走 `apps/api/src/infra/fs/paths.ts`，避免手写目录与避免写死 `/data`

## 目录结构（关键路径）

- `apps/api`
  - Fastify 服务入口：`apps/api/src/main.ts`
- `apps/web`
  - Vite 配置：`apps/web/vite.config.ts`
- `packages/shared`
  - 契约入口：`packages/shared/src/index.ts`
  - 契约目录：`packages/shared/src/contracts/*`
- `docs/`
  - 设计与开发说明：`docs/*`

## 常用命令（在仓库根目录执行）

- 安装依赖：`npm install`
- 启动前后端（会先构建 `packages/shared`）：`npm run dev`
- 仅启动后端：`npm run dev:api`
- 仅启动前端：`npm run dev:web`
- 构建：`npm run build`
- 类型检查：`npm run typecheck`

补充

- 运行某个 workspace 脚本：`npm run <script> -w apps/api`、`npm run <script> -w apps/web`
- 给某个 workspace 安装依赖：`npm i <pkg> -w apps/web`（保持 workspace 依赖边界清晰）

## 环境变量与本地数据

- 环境变量文件使用仓库根目录的 `.env.local`（从 `.env.example` 复制）
- 后端会在启动时读取根目录 `.env.local` 中的 `AWB_*` 变量，并且不会覆盖已存在的 `process.env`
  - 根目录定位规则：从 `process.cwd()` 开始向上查找，遇到包含 `workspaces` 字段的 `package.json` 即视为仓库根目录
- `GET /api/health` 的 `version` 为运行时探测值
  - 优先读 `AWB_APP_VERSION`，其次从启动目录或仓库内的 `apps/api/package.json` 探测，最终回退 `"0.0.0"`
- 前端 Vite 的 `envDir` 指向仓库根目录，开发期通过 proxy 把 `/api` 与 WebSocket 代理到后端

关键变量（示例见 `.env.example`）

- `AWB_DATA_DIR`
  - 默认 `.data`，后端会 `path.resolve` 成绝对路径
  - 数据目录结构由 `apps/api/src/infra/fs/paths.ts` 统一拼接（例如 `db.sqlite`、`repos/`、`workspaces/`）
- `AWB_HOST`、`AWB_PORT`
  - 后端监听地址与端口
- `AWB_DEV_WEB_PORT`
  - 仅前端开发期（Vite dev server）使用：前端 dev server 监听端口
- `AWB_DEV_API_ORIGIN`
  - 仅前端开发期使用：前端 dev proxy 的后端目标地址（不设则回退到 `http://127.0.0.1:<AWB_PORT|4310>`）
- `AWB_FILE_MAX_BYTES`
  - 后端用于文件内容读取/对比的大小阈值
- `AWB_MAX_TERMINALS`
  - 当前后端未实现终端会话全局上限控制（预留）

本地重置数据

- 如需重置本地数据，可删除 `.data/`（仅限仓库目录内）

## 路径与文件边界（当前实现）

- 所有由客户端传入的文件路径参数（例如 Git 审查 `path/oldPath`、暂存/取消暂存的 pathspec）遵循：
  - 必须为相对路径，且最终 resolve 后必须落在 Workspace 根目录下
  - 拒绝包含 `..` 段、拒绝绝对路径、拒绝以 `-` 或 `:` 开头、拒绝包含 `\\0`/换行符
- `file-compare` 的工作区侧读取会拒绝软链、非普通文件，并会做 `realpath` 二次边界校验
  - 触发时返回 `previewable: false` 且 `reason: "unsafe_path"`

## 共享契约（TypeBox）约定

- 契约定义：`packages/shared/src/contracts/*`
- 对外导出：`packages/shared/src/index.ts`
- 后端路由应直接复用契约 schema 作为 Fastify `schema`，并保持 OpenAPI 文档可用
- 在线文档：
  - Swagger UI：`GET /api/docs`
  - OpenAPI JSON：`GET /api/openapi.json`

## 安全边界与约束（对本仓库的改动要求）

- 文件操作严格限定在仓库目录内
- 后端涉及路径/文件系统的逻辑，默认只允许落在 `AWB_DATA_DIR` 派生目录下，避免写死 `/data`
- 原则上不修改 `node_modules/` 里的内容
  - 仅用于本地排障时允许最小化操作（例如修复 `node-pty` 的可执行权限问题）
- 不执行会改动 git 历史或工作区状态的命令（例如 `git add/commit/push/reset/rebase/checkout`）
  - 如需排查，仅允许读取：`git status`、`git diff`、`git log`、`git show` 等

## 修改后的最小自检

- 共享契约/类型相关改动：`npm run build -w packages/shared`、`npm run typecheck`
- 后端改动：`npm run typecheck -w apps/api`
- 前端改动：`npm run typecheck -w apps/web`
- 端到端手动验证：`npm run dev` 后确认 Web UI 可访问、`/api/health` 与 `/api/docs` 可用
