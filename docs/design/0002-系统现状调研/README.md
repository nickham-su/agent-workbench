# 系统现状调研

## 文档定位

本文记录 `agent-workbench` 当前版本的架构、模块边界、编码风格、重复实现和 AI Agent 持续开发带来的工程问题，并给出推荐的改造方案、实施顺序和验收标准。

本文是现状调研与改造建议，不是一次性重构设计。改造应遵循小步、可回滚、保持行为不变优先的原则。

## 背景与范围

### 项目背景

`agent-workbench` 是面向 AI/CLI 编程代理的远程开发工作台，目标是支持：

- 多工作区隔离
- 可重连的终端会话
- Agent 执行
- Web 端变更审查
- Git 提交与推送
- 插件扩展

项目采用 Monorepo 和 `npm workspaces`，项目级说明见 `AGENTS.md:10-17`，根目录 workspace 配置见 `package.json:4-14`。

### 本次调研范围

重点检查以下内容：

- `apps/api`：Fastify API、SQLite、工作区、Git、终端、Agent 协调和插件协调
- `apps/agent-worker`：模型调用、Agent step-loop、工具、上下文、压缩和子任务
- `apps/web`：工作区界面、Agent 面板和 API 调用
- `packages/shared`：当前的公共契约、类型和 LLM 相关代码；建议将稳定契约逐步迁移到独立的 `packages/shared-contracts`
- `plugins/feishu`：插件入口、内部客户端和插件服务
- `docs/`、`AGENTS.md`、根目录脚本和各 workspace manifest

### 调研方法与验证记录

- 阅读项目 README、项目级 `AGENTS.md`、中文说明和设计文档目录
- 检查 workspace 入口、模块依赖、内部 HTTP/Unix Socket 通信和进程管理代码
- 统计源代码文件行数、`any`/`as any` 使用情况和生成目录跟踪情况；统计值以本次复核快照为准
- 检查工具 schema、内部 endpoint、错误处理和配置定义的重复来源
- 执行 `npm run typecheck`，当前结果通过
- 未执行完整集成测试，因此本文不把类型检查通过等同于所有运行时行为正确

## 系统现状与总体架构

### 技术栈

项目级技术栈记录在 `AGENTS.md:13-17`：

- 后端：Node.js、TypeScript、ESM、Fastify、SQLite（`better-sqlite3`）、WebSocket、`tmux`、`node-pty`
- 前端：Vite、Vue 3、TypeScript、Ant Design Vue、TailwindCSS、Monaco、xterm.js
- 共享层：`packages/shared` 使用 TypeBox 维护 schema 和类型
- Agent 执行：Agent Worker 独立进程，可配置并发和启动恢复策略
- 插件运行：Plugin Host 独立进程，当前同时保留 API 进程内动态加载路径

### 当前运行链路

```text
apps/web
  │ HTTP / WebSocket / SSE
  ▼
apps/api
  ├── Fastify 对外 API
  ├── SQLite 状态和配置
  ├── 工作区、Git、文件、终端模块
  ├── AgentRuntimePort
  │     ├── Agent Worker 进程
  │     └── API 进程内 fallback runtime
  └── Plugin Host 进程
        └── plugins/feishu 等插件
```

API 入口和模块注册位于：

- `apps/api/src/main.ts:12-54`
- `apps/api/src/app/createApp.ts:73-86`

Agent 运行时选择、Worker 和 Plugin Host 启动逻辑集中在：

- `apps/api/src/modules/agent/agent.module.ts:165-237`
- `apps/api/src/modules/agent/agent.runtime.ts:11-66`
- `apps/api/src/modules/agent/agent.worker-manager.ts`
- `apps/api/src/modules/agent/agent.plugin-host-manager.ts`

Worker 入口和 Agent Runner 位于：

- `apps/agent-worker/src/main.ts:10-28`
- `apps/agent-worker/src/runtime/runner.ts`

### 架构优点

- API 与 Agent 执行职责基本分离，长时间模型调用不必阻塞 API 主进程。
- Worker 不直接维护 SQLite 权威状态，而是通过 API 内部接口更新 context、run、compaction、subtask 等状态。
- 已考虑同一 session 串行、不同 session 并行、取消、恢复、重试和 Worker 重启。
- Plugin Host 使用独立进程和 Unix Socket，具备较好的故障隔离方向。
- `packages/shared/src/index.ts:1-14` 已集中导出 health、repos、workspaces、terminals、git、files、plugin、settings、auth、agent 等公共契约。
- 文件路径边界和数据目录边界已经有明确约定，见 `AGENTS.md:67-70`、`AGENTS.md:85-91`。

### 当前架构判断

顶层架构方向合理，但内部边界没有完全跟上功能复杂度。当前主要矛盾不是 API、Worker、Web 的大方向错误，而是：

- Agent 核心领域代码过度集中
- API、Worker、Plugin Host 之间的内部协议未完全契约化
- 插件存在两条运行路径
- 内部 RPC、HTTP Server、Client 和子进程管理存在平行实现
- 模块目录边界清楚，但领域依赖已经出现横向耦合

## 模块职责与依赖现状

### `apps/api`

主要职责：

- 对外 HTTP、WebSocket、SSE API
- SQLite 数据库和持久化状态
- Repo、Workspace、Git、文件和终端管理
- Agent session/run/context 协调
- Worker 和 Plugin Host 生命周期管理
- 插件配置、服务 reconcile 和内部 RPC

主要入口：

- `apps/api/src/main.ts`
- `apps/api/src/app/createApp.ts`
- `apps/api/src/modules/agent/agent.module.ts`

当前问题是 `modules/agent` 内部承载的职责过多。`agent.routes.ts` 同时包含用户 API、Worker 内部 API、Plugin 相关 API、SSE、subtask、context、archive 和 execution profile 等路由，文件约 1551 行。

### `apps/agent-worker`

主要职责：

- Provider 初始化和模型调用
- Agent step-loop
- 内置工具和 MCP 工具
- 文件、补丁、bash 等工具
- 上下文构造和自动压缩
- 输出截断、重试、取消和停止条件
- 子任务和插件工具
- 通过 API Client 回写运行状态

核心文件 `apps/agent-worker/src/runtime/runner.ts` 约 2710 行，同时承担模型、循环、工具、上下文、压缩、重试和输出等职责，是典型的运行时上帝模块。

### `apps/web`

主要职责：

- 工作区布局和工具面板
- Agent session/run 展示和交互
- SSE/WebSocket 事件处理
- 文件、Git、终端和设置界面

主要问题是部分页面组件承担了过多状态和事件逻辑：

- `apps/web/src/features/workspace/tools/agent/AgentClientPane.vue`：约 3826 行
- `apps/web/src/features/workspace/views/WorkspaceLayout.vue`：约 1694 行

### `packages/shared`

主要职责：

- 前后端公共 schema 和类型
- TypeBox 契约
- Agent 公共数据结构
- 当前还包含 `packages/shared/src/llm/*` 和 AI SDK 依赖

`packages/shared/package.json:28-33` 直接依赖多个 AI SDK。这使 shared 不再是单纯的轻量契约包，Web/API 依赖 shared 时也会间接接触模型运行时依赖。

### `plugins/feishu`

主要职责：

- 飞书插件入口和事件处理
- IM 消息接收与回复
- Agent 完成事件处理
- 插件服务和内部 API 调用

当前插件没有依赖独立 Plugin SDK 或共享插件契约，插件入口 `plugins/feishu/src/index.ts` 约 1391 行，并且在多个跨边界位置使用 `any` 和动态 JSON 解析。

### 已观察到的跨模块依赖

当前依赖关系中存在以下横向耦合：

```text
workspaces -> settings
workspaces -> agent/top-level-skill
settings -> workspace.store
agent -> workspace
agent -> settings
agent -> plugins
plugins -> agent.plugin-host-client
```

具体证据包括：

- `apps/api/src/modules/workspaces/workspace.service.ts:27-29,59`
- `apps/api/src/modules/workspaces/workspace-files.service.ts:37`
- `apps/api/src/modules/settings/settings.service.ts:49`
- `apps/api/src/modules/agent/agent.service.ts:35-36,88-103`
- `apps/api/src/modules/plugins/plugin.services-runtime.ts:7`

其中 skill 扫描和 frontmatter 解析更适合移动到独立的 `infra/skills` 或 `packages/skills`，避免 Workspace 依赖 Agent 内部实现。

## 编码风格一致性

### 一致的部分

- TypeScript ESM 和 `.js` 相对导入约定基本统一，见 `AGENTS.md:25-28`。
- 共享契约基本采用 `TypeBox schema + Static<typeof Schema>`。
- 前端技术栈统一，没有出现多个 UI 框架或多个主要前端框架并存。
- 根脚本和 workspace manifest 结构清晰，开发、构建、类型检查命令可追踪。
- `npm run typecheck` 实际执行通过，说明当前各 workspace 在静态类型层面能够协同构建。

### 不一致的部分

#### 内部错误处理

不同模块同时使用：

- `HttpError`
- 普通 `Error`
- 动态附加 `statusCode`/`code`
- `{ message, code }` 和 `{ message, statusCode, code }`
- logger 与 `console.warn`

主要涉及：

- `apps/api/src/modules/agent/agent.routes.ts:72-86`
- `apps/api/src/modules/agent/agent.worker-client.ts:52-90`
- `apps/api/src/modules/agent/agent.plugin-host-client.ts:64-149`
- `apps/api/src/plugin-host/server.ts:10-54,139-195`
- `plugins/feishu/src/internal-client.ts:6-45`

#### 类型边界

核心跨边界代码中存在：

- `Type.Any()`
- `request.body as ...`
- `JSON.parse(...) as any`
- `response as any`
- `Record<string, any>`

静态统计结果（包含测试代码）：

```text
as any：约 551 处
any：约 730 处
@ts-ignore / @ts-expect-error：0 处
```

统计口径：在仓库根目录 `agent-workbench` 执行以下命令，扫描 `apps`、`packages`、`plugins` 下的 `*.ts` 和 `*.vue` 文件，排除 `**/dist/**`、`**/node_modules/**` 和本地生成数据目录；结果按文本匹配计数，包含测试文件，不等同于生产代码缺陷数量。

```bash
rg -g '*.ts' -g '*.vue' \
  --glob '!**/dist/**' \
  --glob '!**/node_modules/**' \
  --glob '!**/.data/**' \
  -o 'as any' apps packages plugins | wc -l

rg -g '*.ts' -g '*.vue' \
  --glob '!**/dist/**' \
  --glob '!**/node_modules/**' \
  --glob '!**/.data/**' \
  -o '\bany\b' apps packages plugins | wc -l

rg -g '*.ts' -g '*.vue' \
  --glob '!**/dist/**' \
  --glob '!**/node_modules/**' \
  -o '@ts-ignore|@ts-expect-error' apps packages plugins | wc -l
```

统计快照为本次调研复核时的约 `551 / 730 / 0`。源码继续变化后，应重新执行命令并在后续审查中记录新的快照。测试中的类型断言风险较低，生产代码中 API、Worker、Plugin Host 和持久化 JSON 边界的动态类型风险较高。

#### 配置和脚本

根目录 `package.json:10-14` 通过手工列出 workspace 执行 build/typecheck。新增 workspace 或插件时，存在只新增目录和 manifest、却忘记同步根脚本的风险。

`AGENTS.md:77-79` 已明确标注 `AWB_MAX_TERMINALS` 当前为预留配置，这是好的文档习惯，但建议在配置系统中进一步区分 implemented、experimental、reserved、deprecated。

## 重复实现与重复造轮子

### 子进程管理器重复

以下两个文件结构高度相似：

- `apps/api/src/modules/agent/agent.worker-manager.ts:16-219`
- `apps/api/src/modules/agent/agent.plugin-host-manager.ts:16-206`

重复逻辑包括：

- child process 启动和关闭
- stdout/stderr 转发
- exit 监听
- restart timer
- 指数退避
- circuit breaker
- health check
- shutdown timeout

合理差异只应保留在入口路径、环境变量和业务专属 stop hook；其余应抽为通用 `ManagedChildProcess`、`RestartPolicy`、`CircuitBreaker` 和 `HealthProbe`。

### 内部 HTTP/RPC Server 重复

以下两个 Server 都自行处理：

- `createServer`
- JSON body 读取
- body 解析
- token 校验
- `sendJson`
- URL 分派
- Unix Socket 清理
- close

对应文件：

- `apps/agent-worker/src/server.ts:14-139`
- `apps/api/src/plugin-host/server.ts:10-203`

目前行为已经出现分叉：Plugin Host 有 body 大小限制，而 Worker Server 的 `readJsonBody` 没有同等大小上限。建议统一内部 RPC Server 基础层。

### 内部 Client 重复

以下位置分别实现 HTTP 请求、JSON 解析和错误转换：

- `apps/api/src/modules/agent/agent.worker-client.ts:18-90`
- `apps/api/src/modules/agent/agent.plugin-host-client.ts:25-149`
- `apps/agent-worker/src/runtime/apiClient.ts:181-197`
- `plugins/feishu/src/internal-client.ts:6-45`

建议统一 `InternalRpcClient`，由 endpoint 契约推导 request/response 类型。

### 工具和 endpoint 定义重复

工具相关定义分布在：

- `packages/shared/src/contracts/agent.ts:12-28`
- `apps/api/src/modules/agent/agent.routes.ts:53-69`
- `apps/api/src/modules/agent/agent.service.ts:130-239`
- `apps/agent-worker/src/runtime/tools/registry.ts:9-37`

内部 endpoint 字符串分别散落于：

- `apps/agent-worker/src/runtime/apiClient.ts:228-476`
- `apps/api/src/modules/agent/agent.routes.ts:697-1497`
- `apps/api/src/modules/agent/agent.plugin-host-client.ts:92-145`
- `apps/api/src/plugin-host/server.ts:97-135`

这属于高风险重复，因为调用端和服务端各自修改时，TypeScript 很难发现路径或字段漂移。

## AI Agent 开发常见问题评估

### 上下文长度受限导致的局部视角问题

问题明显存在，证据包括多个超大文件：

- `agent.integration.test.ts`：9984 行
- `agent.service.ts`：4699 行
- `AgentClientPane.vue`：3826 行
- `runner.ts`：2710 行
- `settings.service.ts`：2206 行
- `agent.store.ts`：2067 行
- `agent.routes.ts`：1551 行
- `plugins/feishu/src/index.ts`：1391 行

这些文件会让 AI 在局部修改时容易遗漏：

- 其他调用者
- 状态转移
- 取消、恢复和超时路径
- 失败后的回收逻辑
- 对应的测试和文档

### 契约漂移

同一工具或内部消息在多个模块重复描述，是典型的“局部正确、整体漂移”问题。当前 API、Worker、Plugin Host 和 Web 没有形成一套覆盖所有内部协议的共享契约。

### 平行实现

Worker 和 Plugin Host 的 Server、Client、Process Manager 都有独立实现。后续 AI Agent 很容易复制已有文件而不是抽取公共能力，导致错误格式、body 限制、超时、重启策略逐渐分叉。

### 类型系统逃逸

`any` 和 `Type.Any()` 集中在跨边界和动态 JSON 位置，会使编译器失去反馈能力。其影响比普通 UI 局部变量更大。

### 巨型集成测试掩盖边界

API 的 Agent 集成测试约 9984 行，说明测试投入较多，但也说明行为验证过度集中。巨型测试不利于 AI 判断每个测试保护的不变量，容易继续堆叠 case 而不整理状态模型。

### 配置和文档漂移风险

当前没有发现严重的文档与代码硬冲突，但配置来源较多：

- API 配置解析：`apps/api/src/config/env.ts:46-114`
- Worker 配置：`apps/agent-worker/src/config/env.ts`
- API 启动子进程时再次注入配置：`agent.worker-manager.ts:58-70`、`agent.plugin-host-manager.ts:58-68`
- README 和 AGENTS 分别描述 Docker、本地开发和预留配置

这会增加后续 AI 修改配置时漏改某一层的概率。

## 已验证的优点与未发现问题

### 已验证的优点

- `npm run typecheck` 已实际执行通过。
- `packages/shared`、API、Worker、Web、Feishu 插件的静态类型检查均通过。
- `@ts-ignore` 和 `@ts-expect-error` 搜索结果为 0。
- `dist`、`.data`、`.tmp-tests` 等生成目录存在于工作区，但检查结果显示没有被 Git 跟踪。
- 没有发现大面积 TODO、FIXME、HACK 污染；仅发现少量明确的 MCP/runner/预留配置项。
- 没有发现明显使用 `eval`、`new Function`、`vm.runIn*` 等动态执行模式。
- 项目对文件路径边界、数据目录和软链校验已有明确约定，见 `AGENTS.md:85-91`。

### 本次未验证的内容

- 未执行完整单元测试和集成测试套件。
- 未对 Worker 崩溃恢复、Plugin Host 重启、SQLite 多进程并发等运行时场景做压力验证。
- 未验证 Docker Compose 在所有环境变量组合下的行为。
- 未对前端全部交互流程做人工端到端验收。

因此本文中关于运行时稳定性的判断主要基于代码结构和已有测试组织，不能替代完整测试报告。

## 问题分级

### P0：跨边界协议和唯一来源问题

#### 现象

- API ↔ Worker 内部请求/响应没有统一契约包。
- API route 存在 `Type.Any()` 和手写 body 类型。
- 工具名称和工具参数在多个模块重复定义。
- endpoint 字符串散落在 Client 和 Server 两侧。

#### 风险

协议修改可能类型检查通过，但运行时才失败；多个 AI Agent 并行开发时尤其容易出现一侧更新、另一侧遗漏。

#### 建议

优先建立独立 workspace `packages/shared-contracts`，统一 schema、类型、endpoint、工具定义和错误码。现有 `packages/shared` 可作为迁移过渡层：在迁移期间从新包重新导出兼容符号，迁移完成后再按依赖情况瘦身，保留其确有运行时职责的 LLM/prompt 能力，避免把 AI SDK 继续带入纯契约包。

### P1：Agent 核心模块过大

#### 现象

`agent.service.ts`、`agent.store.ts`、`agent.routes.ts`、`runner.ts` 和 Agent 集成测试承担过多职责。

#### 风险

修改一个局部功能时难以掌握全局状态，恢复、取消、并发和错误路径容易回归。

#### 建议

按 session、run、context、tools、subtask、archive、prompt、recovery 等垂直子域拆分，并优先保持行为不变。

### P1：RPC 与进程管理重复

#### 现象

Worker 和 Plugin Host 分别实现 Process Manager、HTTP Server、Client 和错误处理。

#### 风险

基础策略分叉；后续新增内部服务继续复制实现。

#### 建议

抽取统一内部 RPC 层和 `ManagedChildProcess` 等进程运行时基础设施。

### P1：插件双运行路径

#### 现象

插件服务既可以 API 进程内动态加载，也可以通过 Plugin Host 运行。

#### 风险

生命周期、错误、日志和故障隔离语义不一致。

#### 建议

生产路径统一为 Plugin Host；API 进程内加载仅作为测试适配器或明确标注的 fallback。现状证据：`apps/api/src/modules/plugins/plugin.services-runtime.ts:100-166` 同时包含 Plugin Host reconcile 和 API 进程内动态 import。

### P2：跨模块领域耦合

#### 现象

Workspace 依赖 Agent 内部 skill 实现，Agent 依赖 Workspace、Settings 和 Plugins，Plugin Runtime 依赖 Agent 目录下的 Host Client。

#### 建议

提取 `infra/skills`、`infra/plugin-host` 或对应独立 package，形成更稳定的依赖方向。

### P2：类型逃逸和错误格式不统一

#### 现象

生产代码跨边界存在 `any`、类型断言、动态 JSON；错误对象和日志方式不统一。

#### 建议

先处理 API ↔ Worker、API ↔ Plugin Host、插件 ↔ API 的边界，再逐步清理普通业务代码中的动态类型。

### P2：共享包职责和 AI SDK 依赖

#### 现象

`packages/shared/package.json:28-33` 依赖多个 AI SDK，同时导出契约和 LLM 相关代码。

#### 建议

将纯契约迁移到 `packages/shared-contracts`；现有 `packages/shared` 在过渡期兼容导出，后续根据实际依赖瘦身。该项归属阶段一的契约迁移，LLM 运行时拆分可作为阶段一完成后的延续工作。

### P2：配置与 workspace 脚本维护依赖人工同步

#### 风险

新增 workspace、插件或环境变量时容易漏改根脚本、Docker 配置和文档。现状证据：根目录 `package.json:10-14` 通过手工列表编排 build/typecheck，配置解析分布在 `apps/api/src/config/env.ts:46-114`、`apps/agent-worker/src/config/env.ts` 以及两个进程 manager 的环境变量注入代码中。

#### 建议

增加 workspace 覆盖率检查和配置状态标识，建立活的配置清单。

## 推荐改造方案

### 目标架构

```text
packages/shared-contracts
  ├── public contracts
  ├── internal agent-worker contracts
  ├── internal plugin-host contracts
  ├── tools
  ├── endpoints
  └── errors

packages/internal-rpc
  ├── typed client
  ├── typed server
  ├── JSON body limits
  ├── auth/token
  ├── timeout
  └── Unix Socket

apps/api/src/infra/process
  ├── ManagedChildProcess
  ├── RestartPolicy
  ├── CircuitBreaker
  └── HealthProbe

apps/api/src/modules/agent
  ├── sessions
  ├── runs
  ├── context
  ├── tools
  ├── subtask
  ├── archive
  ├── prompt
  └── recovery

apps/agent-worker/src/runtime
  ├── loop
  ├── model
  ├── tools
  ├── context
  ├── compaction
  ├── retry
  ├── output
  └── subtask
```

### 协议层改造

建议新增或逐步形成以下契约：

```text
packages/shared-contracts/src/
  agent-worker.ts
  plugin-host.ts
  tools.ts
  endpoints.ts
  errors.ts
```

迁移策略：先在 `packages/shared-contracts` 建立唯一来源，现有 `packages/shared` 可临时从该包重新导出原有公共符号，以减少一次性改动；调用方迁移完成后，再删除重复定义并根据依赖瘦身 `packages/shared`。全文所称“统一内部契约”均指向 `packages/shared-contracts`，不在 `packages/shared` 内新建第二套内部契约目录。

每个 endpoint 至少包含：

- request schema
- response schema
- TypeScript 类型
- endpoint 名称或路径
- 错误码
- 超时和幂等语义说明

工具定义至少统一：

- 工具名
- 参数 schema
- 结果 schema
- 是否允许模型调用
- 是否允许插件调用
- 是否支持取消

### RPC 和进程基础设施改造

建议统一以下能力：

```text
packages/internal-rpc/
  client.ts
  server.ts
  body.ts
  auth.ts
  errors.ts
  unix-socket.ts

apps/api/src/infra/process/
  managed-child-process.ts
  restart-policy.ts
  circuit-breaker.ts
  health-probe.ts
```

基础层负责通用行为，业务层只负责：

- 注册 endpoint
- 构造业务配置
- 处理业务请求
- 提供插件或 Worker 专属的启动钩子

### Agent 核心拆分方案

API 侧优先按垂直子域拆分：

- `sessions`：session 创建、读取、head 和并发约束
- `runs`：run 创建、派发、状态、完成和失败
- `context`：context item、投影、压缩和归档边界
- `tools`：工具元数据、工具参数和工具调用记录
- `subtask`：子任务生命周期
- `prompt`：prompt context 组装
- `recovery`：Worker 重启和未完成 run 恢复

Worker 侧优先拆分：

- model provider
- step loop
- tool registry
- tool execution
- context projection
- compaction
- retry
- output truncation
- cancellation
- subtask

拆分第一阶段只做职责提取和接口收敛，避免同时修改状态机语义。

### 插件改造方案

建议提供正式的 Plugin SDK：

```text
packages/plugin-sdk/
  manifest.ts
  tool-contracts.ts
  service-contracts.ts
  lifecycle.ts
  rpc.ts
```

插件应依赖 SDK，而不是通过动态结构检查猜测宿主接口。生产环境建议统一由 Plugin Host 加载插件，API 仅管理配置、快照和生命周期协调。

## 推荐改造顺序

推荐顺序是：

```text
统一内部协议
  ↓
统一 RPC 与进程管理基础设施
  ↓
拆分 Agent 核心模块
```

### 阶段一：统一内部协议

#### 目标

先明确系统各边界“传输什么”，在 `packages/shared-contracts` 建立唯一来源，不改变现有业务行为。

#### 主要工作

- 盘点 API ↔ Worker、API ↔ Plugin Host、插件 ↔ API 的所有 endpoint
- 在 `packages/shared-contracts` 新增内部 request/response schema
- 统一工具名、工具参数和工具结果定义
- 统一 endpoint 常量
- 统一错误 envelope 和错误码
- 将 API route、Worker Client、Plugin Host Client/Server 切换到 `packages/shared-contracts`
- 清理核心内部协议中的 `Type.Any()` 和 `as any`

#### 为什么先做

- 跨进程协议是当前最容易发生运行时漂移的地方。
- 改动可以主要停留在类型和适配层，行为风险相对较低。
- 后续拆 Agent 模块时可以围绕稳定接口移动代码。
- 可以直接降低多个 AI Agent 并行开发的局部视角风险。

#### 验收标准

- 工具名只有一个权威定义。
- 内部 endpoint 有统一常量或方法定义。
- API route 不再为同一内部请求重复手写 body 类型。
- Worker Client、API route、Plugin Host Client/Server 使用相同 request/response 类型。
- 核心内部协议不再使用 `Type.Any()`。
- `npm run typecheck` 通过。
- 现有 API、Worker 和插件集成测试行为不变。

阶段一同时处理或明确延期的事项：

- 处理：内部协议迁移、工具/endpoint/错误码唯一来源。
- 归属阶段一延续：将 `packages/shared` 中与纯契约无关的 AI SDK 依赖和 LLM 实现拆出或瘦身；迁移期间保留兼容导出。
- Deferred：若没有独立的功能需求，不在本阶段重写 LLM provider 实现。

### 阶段二：统一 RPC 与进程管理基础设施

#### 目标

先统一“怎么通信和运行”，避免继续复制 Server、Client 和 Process Manager。

#### 主要工作

- 抽取统一 JSON body 读取和大小限制
- 抽取统一 JSON 响应和错误格式
- 抽取统一 token 校验
- 抽取统一请求超时
- 抽取 Unix Socket listen/close/权限管理
- 抽取 `ManagedChildProcess`
- 抽取 restart/backoff/circuit breaker
- 迁移 Worker Manager 和 Plugin Host Manager
- 迁移 Worker Server、Plugin Host Server 和相关 Client

#### 为什么排在协议之后

RPC 基础设施需要先知道请求、响应和错误协议。如果协议未收敛，基础设施容易变成没有明确边界的泛化工具库。协议先稳定后，基础层可以只负责传输和生命周期，不承担业务解释。

#### 验收标准

- Worker 和 Plugin Host 共享同一套 RPC body、错误和认证实现。
- Worker Manager 和 Plugin Host Manager 共享同一套子进程生命周期实现。
- body size、超时、token 校验、关闭和重启策略有统一测试。
- 新增内部服务不需要复制完整 Server/Client/Manager 模板。
- Worker、Plugin Host 重启和关闭行为与改造前一致。
- `npm run typecheck`、相关构建和集成测试通过。

阶段二同时处理或明确延期的事项：

- 处理：Worker/Plugin Host 的 RPC Server、Client、进程管理和健康检查重复。
- Deferred：不在本阶段拆分 Agent 业务大文件，不改变 run/context 状态机。

### 阶段三：拆分 Agent 核心模块

#### 目标

降低单文件上下文复杂度，恢复 session、run、context、tools、subtask 和 recovery 的领域边界。

#### 主要工作

- 拆分 `agent.routes.ts`
- 拆分 `agent.service.ts`
- 拆分 `agent.store.ts`
- 拆分 `runner.ts`
- 拆分 Agent 集成测试
- 把前端 Agent 大组件中的状态和事件处理提取为 composable
- 为每个子域补充状态转移和不变量说明

#### 为什么最后做

这是三项中风险最高的工作，涉及最多隐式调用关系和状态机。先统一协议和运行时基础设施，可以避免拆分过程中同时改动通信细节、错误处理和进程生命周期。

#### 推荐的垂直拆分顺序

- run 创建、派发、状态更新、完成/失败
- session head 和并发约束
- context append、读取、投影和冲突处理
- tool registry、tool execution 和 tool result
- subtask 生命周期
- compaction、archive 和 prompt context
- recovery、取消和重试
- 按行为拆分巨型集成测试

#### 验收标准

- 每个已迁移子域具有明确的公开入口；跨子域引用不再直接依赖被迁移子域的内部实现文件。
- 迁移前后相同固定 fixture 的 session、run、context、取消、恢复、重试和并发测试结果一致。
- 现有 Agent 集成测试按行为拆分后，原有测试用例均可定位到新的测试文件；迁移过程中不得通过删除或放宽断言来降低覆盖。
- 对 run、session head、context append、取消和恢复等关键状态转移，至少各有一个可自动执行的成功路径和失败/边界路径断言。
- 阶段结束时记录迁移文件清单、删除的旧入口和保留的兼容入口；未完成的子域明确列入后续任务，不以“已拆分”表述。

## 问题到改造路线映射

下表把问题编号、改造阶段、处理范围和可验证的验收方式对应起来，避免问题分级与实施计划脱节。

| 问题编号 | 问题 | 归属阶段 | 是否处理 | 验收方式 |
|---|---|---|---|---|
| P0 | API、Worker、Plugin Host 内部协议多源，工具和 endpoint 定义重复 | 阶段一：统一内部协议 | 处理 | `packages/shared-contracts` 成为唯一契约来源；调用方不再维护同一请求的本地类型；类型检查和协议集成测试通过 |
| P1 | Agent 核心文件过大、状态和职责集中 | 阶段三：拆分 Agent 核心模块 | 处理 | 按子域迁移文件并保留行为测试；固定 fixture 下 session/run/context/取消/恢复测试结果与迁移前一致 |
| P1 | Worker 与 Plugin Host 的 RPC、Client、Server、Process Manager 重复 | 阶段二：统一 RPC 与进程管理基础设施 | 处理 | 两个宿主使用共同的 RPC、认证、错误、body 限制和子进程生命周期实现；重启/关闭测试通过 |
| P1 | 插件 API 进程内动态加载和 Plugin Host 两条运行路径并存 | 阶段一至阶段二：契约与运行时收敛 | 处理 | 生产配置下插件服务只走明确的 Plugin Host 路径；API 内加载仅保留有文档和测试覆盖的 fallback/测试适配器，或完成删除 |
| P2 | `packages/shared` 同时承载契约和 AI SDK/LLM 运行时 | 阶段一延续：shared 瘦身 | 处理 | 纯契约迁移到 `packages/shared-contracts`；`packages/shared` 通过兼容导出过渡，最终依赖图确认 Web/API 不再因纯契约而引入不需要的 AI SDK |
| P2 | Workspace、Agent、Settings、Plugin 之间横向依赖 | 阶段三之后 | Deferred | 暂不作为前三阶段的阻塞项；后续以模块依赖检查和禁止跨域内部文件导入作为验收 |
| P2 | 根目录 build/typecheck 手工列 workspace，配置和文档需人工同步 | 独立治理项 | Deferred | 暂不阻塞前三阶段；后续增加 workspace 覆盖率检查、配置清单或 CI 校验，并用新增 workspace fixture 验证 |
| P2 | 生产边界存在 `any`、`as any`、`Type.Any()` 和错误格式分叉 | 阶段一、阶段二 | 部分处理 | 优先消除内部协议边界的动态类型和统一错误 envelope；全仓动态类型清理不作为前三阶段完成条件 |

## 实施原则与风险控制

### 小步迁移

- 每次只迁移一个 endpoint、一个子域或一类基础设施。
- 保留旧接口适配层，确认调用方迁移完成后再删除。
- 每次改造都保留可回滚点。

### 行为与结构分离

- 协议抽取阶段不改变业务语义。
- RPC 抽取阶段不改变 endpoint 和状态机。
- Agent 拆分阶段优先移动代码，不同时改产品行为。

### 先建立不变量

重点记录并测试：

- 同一 session 的 run 串行约束
- session head 冲突不会覆盖新状态
- run 终态只能写入一次
- Worker 断开后的 run 可恢复或明确失败
- context append 和 compaction 的顺序
- 插件服务 reconcile 的最终状态

### 变更后的最小验证

根据 `AGENTS.md:111-116`，至少执行：

```bash
npm run build -w packages/shared
npm run typecheck
npm run typecheck -w apps/api
npm run typecheck -w apps/web
```

涉及 Worker 或插件时，应增加对应 workspace 的 typecheck/build 和相关测试。涉及运行时协议时，应执行 API、Worker、Plugin Host 的集成测试，并检查 `/api/health` 和 `/api/docs`。

## 结论

`agent-workbench` 的顶层架构方向成立，API、Web、Agent Worker、Plugin Host 和 shared 的分层具有继续演进的基础。当前主要风险来自内部治理，而不是顶层技术选型：

- Agent 核心代码过大
- 内部契约多源
- RPC 和进程管理重复
- 插件双运行路径
- 跨模块依赖横向扩张
- 动态类型集中在关键边界

推荐按照以下顺序治理：

```text
先统一内部协议
  ↓
再统一 RPC 与进程管理
  ↓
最后拆分 Agent 核心模块
```

这个顺序的核心理由是：先稳定跨边界契约，再收敛公共运行时，最后进行高风险业务重构。这样能够在不大幅改变现有行为的前提下，优先降低 AI Agent 局部视角造成的协议漂移和重复实现问题。
