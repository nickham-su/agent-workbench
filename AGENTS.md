# 项目级 AGENTS.md（agent-workbench）

## 项目概览

- 这是一个面向 AI/CLI 编程代理的本地开发工作台
- 仓库形态：Monorepo，使用 `npm workspaces`

## 技术栈与模块

- 后端：Node.js + TypeScript（ESM）+ Fastify + SQLite（`better-sqlite3`）+ WebSocket + `tmux` + `node-pty`
- 前端：Vite + Vue3 + TypeScript + `ant-design-vue` + TailwindCSS + Monaco + xterm.js
- 共享包：`packages/shared`，用 TypeBox 维护前后端共享契约（schema + 类型）

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
- 构建：`npm run build`
- 类型检查：`npm run typecheck`
- 运行某个 workspace 脚本：`npm run <script> -w apps/api`、`npm run <script> -w apps/web`
- 给某个 workspace 安装依赖：`npm i <pkg> -w apps/web`（保持 workspace 依赖边界清晰）

## 环境变量与本地数据

- 环境变量文件使用仓库根目录的 `.env.local`（从 `.env.dev.example` 复制）
- 后端会在启动时读取根目录 `.env.local` 中的 `AWB_*` 变量，并且不会覆盖已存在的 `process.env`
  - 根目录定位规则：从 `process.cwd()` 开始向上查找，遇到包含 `workspaces` 字段的 `package.json` 即视为仓库根目录
- 前端 Vite 的 `envDir` 指向仓库根目录，开发期通过 proxy 把 `/api` 与 WebSocket 代理到后端

## 共享契约（TypeBox）约定

- 契约定义：`packages/shared/src/contracts/*`
- 对外导出：`packages/shared/src/index.ts`
- 后端路由应直接复用契约 schema 作为 Fastify `schema`，并保持 OpenAPI 文档可用

## 修改后的最小自检

- 共享契约/类型相关改动：`npm run build -w packages/shared`、`npm run typecheck`
- 后端改动：`npm run typecheck -w apps/api`
- 前端改动：`npm run typecheck -w apps/web`

## 指挥官意图（产品与工程决策准则）

本项目是面向个人开发者的自托管 AI 开发工具，核心使命是帮助开发者高效、可靠地完成“Agent 执行 → 变更审查 → 验收提交”的开发闭环。

### 总体意图

- 优先解决个人开发者在 AI 开发流程中的真实问题。
- 在满足需求的前提下，优先选择简单、直接、低成本、易部署、易维护的方案。
- 不默认按公开、多用户、多租户 SaaS 的标准建设系统；当产品使用边界明确变化时，再根据实际风险调整方案。
- 安全简化不等于放弃关键边界。必须保护工作区、代码、凭证、运行状态和内部控制能力。

### 决策优先级

当功能、正确性、兼容性、安全性和复杂度发生冲突时，按照以下顺序取舍：

- 优先保证开发者能够可靠完成真实的开发工作。
- 优先保护代码、数据、工作区和运行状态的正确性。
- 保持已经验证的业务语义、契约、事务边界和状态不变量。
- 在多个可行方案中，选择改动更小、依赖更少、验证和回滚更容易的方案。
- 优先解决已经存在或有充分证据的问题，不为假设性的未来需求提前增加复杂度。

### 默认非目标

除非用户明确提出需求，或者产品前提已经发生变化，否则不要主动引入：

- 账户注册、用户管理、组织体系、RBAC 或多租户隔离；
- 计费、配额、企业级审计、合规平台或中心化遥测；
- 面向大型公开服务的复杂网关、服务网格或高可用集群；
- 仅为理论完整性、形式分层或未来可能复用而建立的通用框架；
- 没有真实需求或故障证据支撑的重型一致性、恢复或分布式协调机制。

这些能力并非永远禁止。需要引入时，应先说明产品前提的变化，以及方案的收益、成本和影响。

### 不可降低的安全底线

本项目会操作代码、终端、Git、凭证和本机文件等高价值资源。不得以“个人使用”或“自托管”为理由削弱以下边界：

- 文件和工具操作必须限制在既定的 Workspace、数据目录和仓库范围内，防止路径穿越、软链绕过和意外越界读写。
- 不得泄露密钥、token、密码、凭证以及用户私有代码和数据。
- 保持内部控制面、Worker/API 调用和其他高权限入口的必要保护。
- 对删除、覆盖、重置等高影响操作保持明确边界，避免不可恢复的损失。
- 错误和诊断信息应帮助 Agent 正确行动，但不得泄露敏感信息或违反工具契约。

### 工程实施准则

- 先理解现状，再进行最小增量修改。
- 不要为了文件更小、目录更整齐或架构看起来更先进而机械重构。
- 职责边界应由业务不变量、状态边界、事务要求和可独立验证的行为决定。
- 不要仅因代码表面相似就建立通用框架；抽象必须带来明确的维护、测试或依赖收益。
- 同一业务规则应有唯一的权威实现，兼容层不应长期维护重复逻辑。
- 对合法的既有契约保持兼容；对会破坏数据、状态或安全边界的调用，应明确失败。
- 每项改动都应清晰、可测试、可审查、可回滚，不得以重构名义隐藏行为变化。
