# 飞书插件 TS 重写与平台级 SSE 广播方案（最终版）

## 1. 文档目标与范围

本文档用于固化已确认的最终方案，作为后续实施、评审和回归验证的统一依据。

本方案仅定义 **一期实现**，并明确以下约束：

- 保持现有飞书 IM 交互大体不变（命令体系、@bot 规则、即时 ACK reply）。
- 实现 Web 触发 run 的“最终完成消息”在飞书可订阅接收。
- 废弃现有飞书插件 JS 产物式实现，使用 TypeScript 重写插件。
- 插件使用 sqlite 持久化渠道状态（binding、policy 等）。
- 宿主采用平台级全量 SSE 广播（best-effort），一期仅广播 `agent.run.completed.v1`。
- 本期不做轮询兜底、ack/retry/outbox/delivery。

> 注意：本文档是单一实现方案，不包含多分支备选路径。

---

## 2. 背景与现状问题

### 2.1 当前为什么只有“飞书触发 run”才会回飞书

（历史背景）旧版链路中，飞书最终回复依赖 `channel_reply_job`，并在 channels 的 `run/trigger` 路径创建。

- 飞书消息 -> channels `run/trigger` -> 创建 `channel_reply_job` -> dispatcher 发送飞书回复（旧）
- Web 消息 -> `sendMessage` -> 不创建 `channel_reply_job` -> 无飞书回传（旧）

因此旧版中，Web 触发 run 时，飞书侧收不到结果；现已改为 SSE `agent.run.completed.v1` + 插件自治过滤/发送。

### 2.2 当前飞书插件工程化问题

现有飞书插件以 `plugins/feishu/dist/index.js` 形式存在，缺少完整 TS 源码工程与脚本管理，导致：

- 可维护性低（难以模块化演进）
- 质量保障弱（缺少统一 typecheck/lint/test）
- 构建链路不可见（root build 不覆盖插件）

### 2.3 当前群聚合设计问题

群聊聚合依赖 watermark/aggregate 逻辑，复杂度高、维护成本高，且已被确认为错误设计，本期明确移除。

---

## 3. 需求定义

### 3.1 功能需求（FR）

FR-1 保持既有 IM 交互主体验
- 命令体系保持：`/ss /n /a /st /l /c /h`（新增 `/p`）
- 群聊仍需 @bot 才触发普通消息处理
- 收到消息后即时 ACK 仍采用 reply(messageId)

FR-2 支持 Web 触发 run 的飞书接收
- 当 chat 策略为 `session_all`，且该 chat 当前绑定到对应 session 时，Web 触发 run 完成后可在飞书接收最终消息。

FR-3 策略按 chat 存储，不按 session 存储
- `policy` 绑定 chatId（准确键见下文）
- chat 更换绑定 session 后策略保持不变
- 默认 `self_only`

FR-4 新增 `/p` 命令，循环切换策略
- 无参数
- 每次调用在 `self_only <-> session_all` 之间切换
- 当前策略在 `/st` 输出中展示

FR-5 移除群聚合
- 删除 watermark/aggregate 相关流程
- 群聊触发输入只取单条消息（去 mention 后文本）

FR-6 插件显式传 agentId 触发 run
- 插件调用宿主 internal API 传递：`agentId + sessionId + text + clientRequestId`

FR-7 最终消息发送策略
- 保留 `reply(messageId)`：命令回复、即时 ACK、IM 自触发 run 的最终线程回复
- 新增 `send(chatId)`：用于 `session_all` 广播（Web run 等）

### 3.2 非功能需求（NFR）

NFR-1 一期采用 best-effort
- SSE 允许少量丢失
- 不做 ack/retry/outbox/delivery
- 不做轮询兜底

NFR-2 部署前提
- 单实例本机部署
- 网络质量基本可靠

NFR-3 工程化
- 飞书插件使用 TS 重写
- 使用 `package.json` 管理 `build/typecheck/lint/test`
- 产物输出为 `dist/index.js`，兼容宿主插件加载

---

## 4. 术语表

- 宿主（Host）：核心服务端，管理 session/run/message 并提供插件运行接口。
- 插件（Plugin）：渠道适配层（本方案为飞书插件），负责命令、消息处理、过滤和发送。
- Chat：飞书会话目标（私聊或群聊），以 `chatId` 标识。
- Binding：chat 与 session 的绑定关系（本方案中由插件 sqlite 完全保存）。
- Policy：chat 级推送策略，取值 `self_only` 或 `session_all`。
- self_only：默认策略，仅接收本对话内触发交互结果（不接收 web 广播）。
- session_all：接收当前绑定 session 的所有最终完成消息（含 web 触发）。
- SSE：Server-Sent Events，宿主向插件推送平台事件流。
- run.completed：run 最终完成事件（一期唯一广播事件）。

---

## 5. 总体架构

### 5.1 设计原则

1) 宿主保持“平台核心”，不维护渠道 binding 细节。  
2) 插件保持“渠道自治”，自持状态并自行过滤。  
3) 事件通道平台化（SSE 全量流），非飞书专用。  
4) 一期优先可落地，接受 best-effort 可靠性边界。

### 5.2 架构图

```mermaid
flowchart LR
  U1[飞书用户] --> P1[Feishu Plugin TS]
  U2[Web 用户] --> H1[Host API]

  P1 -->|triggerRun(sessionId,agentId,text,clientRequestId)| H1
  H1 -->|enqueue/execute| R1[Run Runtime]
  R1 --> H1

  H1 -->|SSE 全量广播 agent.run.completed.v1| P1
  P1 -->|query final text by runId| H1

  P1 -->|reply(messageId)| FAPI[Feishu API]
  P1 -->|send(chatId)| FAPI

  P1 --> DB[(Plugin sqlite)]
  DB --> P1
```

### 5.3 关键边界

- 宿主不再保存 chat->session binding。
- 插件不再依赖宿主 aggregate/watermark 能力。
- Web 端不展示 IM 绑定状态。

---

## 6. 宿主侧接口契约

> 以下为建议契约，字段可按现有接口风格命名；语义必须保持一致。

### 6.1 SSE 事件流（全量）

- Endpoint: `GET /internal/events/sse`
- 事件类型（一期）：`agent.run.completed.v1`

事件 payload：

```json
{
  "eventId": "evt_xxx",
  "eventType": "agent.run.completed.v1",
  "occurredAt": "2026-03-14T09:00:00.000Z",
  "sessionId": "sess_xxx",
  "runId": "run_xxx",
  "finalStatus": "completed"
}
```

说明：
- 全量广播，不按插件、不按 session 路由。
- 不提供 ack/retry 语义。

### 6.2 Final Text Query（最小查询）

- Endpoint: `GET /api/internal/agent/runs/:runId/final-text`

Response:

```json
{
  "runId": "run_xxx",
  "text": "assistant final text",
  "status": "completed"
}
```

错误码建议：
- `404`：run 不存在
- `409`：run 未完成
- `500`：服务异常

### 6.3 插件触发 run API（显式 agentId）

- Endpoint: `POST /api/internal/agent/plugins/trigger-run`

Request:

```json
{
  "workspaceId": "ws_xxx",
  "sessionId": "sess_xxx",
  "agentId": "agent_xxx",
  "text": "user message text",
  "clientRequestId": "feishu:chat_xxx:msg_xxx"
}
```

Response:

```json
{
  "runId": "run_xxx",
  "deduplicated": false
}
```

约束：
- `clientRequestId` 参与宿主去重。
- `agentId`、`sessionId` 必须合法且可访问。

---

## 7. 插件侧详细设计（TS + sqlite）

## 7.1 目录结构（建议）

```text
plugins/feishu/
  package.json
  tsconfig.json
  src/
    index.ts
    app/
    config/
    domain/
    infra/
      db/
      host/
      feishu/
    services/
    handlers/
    types/
    utils/
  tests/
    unit/
    integration/
    contract/
  dist/
    index.js
```

### 7.2 核心模块划分

- `wsGateway`：接收飞书事件，解析命令/普通消息。
- `commandService`：处理 `/ss /n /a /st /p /h`。
- `messageService`：普通消息入口（私聊/群聊分流，@bot 校验、ACK）。
- `runService`：调用宿主 triggerRun，写入 runMap。
- `completionService`：消费 SSE run.completed，执行 reply/send。
- `sendService`：统一封装 reply 与 send。
- `internalApiClient`：宿主 internal API 封装。
- `sqlite repositories`：binding/policy/runMap/sentDedup 持久化。

### 7.3 sqlite schema（最小可用）

- sqlite 数据文件位置：`${dataDir}/plugin-data/feishu/feishu.sqlite`。
- 不在 `${dataDir}/plugins/<pluginId>/` 下写入运行时数据，避免被插件发现机制误识别为 user root 插件覆盖目录。

#### 表 1：`chat_binding`

- `chat_key TEXT PRIMARY KEY`（建议由 `accountId:chatId` 组合）
- `account_id TEXT NOT NULL`
- `chat_id TEXT NOT NULL`
- `chat_type TEXT NOT NULL`（p2p/group）
- `workspace_id TEXT NOT NULL`
- `session_id TEXT NOT NULL`
- `selected_agent_id TEXT`（可空，空表示需 `/a`）
- `updated_at INTEGER NOT NULL`

索引：
- `idx_chat_binding_session_id(session_id)`

#### 表 2：`chat_policy`

- `chat_key TEXT PRIMARY KEY`
- `policy TEXT NOT NULL CHECK(policy IN ('self_only','session_all'))`
- `updated_at INTEGER NOT NULL`

默认策略：无记录视为 `self_only`。

#### 表 3：`run_map`

用于 IM 自触发 run 的线程回复。

- `run_id TEXT PRIMARY KEY`
- `chat_key TEXT NOT NULL`
- `trigger_message_id TEXT NOT NULL`
- `created_at INTEGER NOT NULL`

#### 表 4：`sent_dedup`

用于 session_all 广播去重。

- `event_id TEXT NOT NULL`
- `chat_key TEXT NOT NULL`
- `sent_at INTEGER NOT NULL`
- `PRIMARY KEY(event_id, chat_key)`

### 7.4 命令行为定义

#### `/ss`
- 展示最近 session 列表（由宿主 API 获取）。
- 选择后更新 `chat_binding.session_id`。
- 尝试校验并保留 `selected_agent_id`；若不可用则清空并提示 `/a`。

#### `/n [workspaceId]`
- 调宿主创建 session。
- 更新当前 chat 的 `chat_binding.session_id`。

#### `/a [id|index]`
- 列出 agent 并选择。
- 更新 `chat_binding.selected_agent_id`。

#### `/st`
- 保持现有状态摘要逻辑。
- 追加输出当前策略：`Push policy: self_only|session_all`。

#### `/p`（新增）
- 无参数。
- 每次调用切换：`self_only <-> session_all`。
- 回复文案使用“当前对话/当前会话”，兼容私聊与群聊。

### 7.5 普通消息处理流程

#### 私聊
1) 非命令消息进入。
2) allowlist 校验。
3) 读取 `chat_binding`，若无 session/agent 则引导 `/ss`、`/a`。
4) 调 triggerRun（显式传 sessionId + agentId + text + clientRequestId）。
5) 写入 `run_map(runId->trigger_message_id)`。
6) reply ACK。

#### 群聊
1) 必须 @bot 才继续。
2) allowlist 校验。
3) 移除 mention 后只使用“单条文本”触发 run。
4) 后续步骤与私聊一致。

> 一期已删除 aggregate/watermark，群聊不再拼接窗口历史。

### 7.6 run.completed 消费与发送逻辑

收到 SSE 事件 `agent.run.completed.v1` 后：

1) 若 `runId` 命中 `run_map`
- 调 Query 获取 finalText。
- 调 `reply(trigger_message_id, text)` 线程回复。

2) 若 `runId` 未命中 `run_map`
- 视为 web 或其他来源触发。
- 通过 `sessionId` 从 `chat_binding` 找到当前绑定 chat 列表。
- 对每个 chat：读取 `chat_policy`，仅 `session_all` 执行发送。
- 发送前检查 `sent_dedup(eventId, chatKey)` 防重复。
- 使用 `send(chatId, text)` 主动发消息。

### 7.7 错误处理与重连策略

- SSE 断开：指数退避重连（如 1s/2s/5s/10s 上限）。
- 本期不做断线补偿重放。
- Query 返回 run 未完成：短暂重试 1-2 次后放弃（仅当前事件处理上下文）。
- 飞书发送失败：记录错误日志（chatKey/runId/eventId），不进入后台重试队列（本期边界）。

---

## 8. 关键决策与取舍

### 8.1 决策清单

1) 平台全量 SSE 广播，插件自治过滤（已定）。  
2) 一期仅广播 `agent.run.completed.v1`（已定）。  
3) best-effort，无 ack/retry/outbox/delivery（已定）。  
4) 本期不做轮询兜底（已定）。  
5) binding 完全放插件 sqlite，宿主不保存（已定）。  
6) 群聚合删除，仅保留 @bot 规则（已定）。  
7) 默认策略 `self_only`（已定）。  
8) 策略 chat 级，`/p` 无参循环切换，`/st` 展示（已定）。  
9) 发送能力拆分：reply + send（已定）。  
10) 飞书插件 TS 重写，root workspace 纳入 `plugins/*`（已定）。

### 8.2 取舍说明

- 放弃高可靠：换取实现成本低、迭代速度快。  
- 下放 binding 到插件：换取宿主通用性与边界清晰。  
- 删除群聚合：换取更简单、更可解释的交互模型。  
- 默认 self_only：避免默认噪音，用户主动开启广播。

---

## 9. 工程化实施要求

### 9.1 plugins/feishu 工程化

必须新增：
- `plugins/feishu/package.json`
- `plugins/feishu/tsconfig.json`
- `plugins/feishu/src/**`
- `plugins/feishu/tests/**`
- 构建产物：`plugins/feishu/dist/index.js`

### 9.2 package.json scripts（插件侧建议）

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint \"src/**/*.ts\" \"tests/**/*.ts\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist",
    "start": "node dist/index.js",
    "verify": "npm run typecheck && npm run lint && npm run test && npm run build"
  }
}
```

### 9.3 root 工程改造

1) root `package.json` 的 `workspaces` 纳入 `plugins/*`。  
2) root scripts 纳入插件 build/typecheck/test/lint。  
3) Dockerfile 在安装与构建阶段纳入插件包元数据与构建步骤。  
4) `dist` 是否提交由主工程发布策略决定（已确认由主工程决定）。

---

## 10. 任务拆分（按阶段/PR）

### 阶段 0：文档与契约冻结（当前）
- 冻结本设计文档。
- 冻结接口字段与命令语义。

### 阶段 1：宿主能力补齐
- PR-1: SSE 平台事件流（run.completed）。
- PR-2: Query finalText API。
- PR-3: 插件 triggerRun internal API（显式 agentId + dedup）。

### 阶段 2：飞书插件 TS 工程落地
- PR-4: 插件工程骨架（package.json/tsconfig/src/tests/build 输出）。
- PR-5: sqlite 层（schema + repo + migration）。
- PR-6: 命令层迁移（含 `/p`、`/st` policy 展示）。

### 阶段 3：消息与事件链路迁移
- PR-7: 普通消息触发 run（移除 aggregate/watermark）。
- PR-8: SSE 消费 run.completed + reply/send + sentDedup。

### 阶段 4：工程集成
- PR-9: root workspaces/scripts & Dockerfile 调整。
- PR-10: 回归测试与联调修正。

---

## 11. 改动范围（目录/文件级）

> 以下为预计改动范围，用于评估影响面。

### 11.1 宿主侧

- `apps/api/**`（新增 SSE 事件流、Query、triggerRun internal API）
- `apps/api/src/plugin-host/**`（必要时补充 send 能力代理）
- `packages/shared/**`（若需补充契约类型）

### 11.2 插件侧（重点）

- `plugins/feishu/package.json`（新增）
- `plugins/feishu/tsconfig.json`（新增）
- `plugins/feishu/src/**`（新增 TS 源码）
- `plugins/feishu/tests/**`（新增测试）
- `plugins/feishu/dist/index.js`（构建产物）
- `plugins/feishu/agent-workbench.plugin.json`（若 entry/metadata 需对齐）

### 11.3 工程根目录

- `package.json`（workspaces/scripts）
- `Dockerfile`（插件构建接入）

---

## 12. 回归验证清单（验收标准）

### 12.1 交互一致性

- `/ss /n /a /st /l /c /h` 主行为保持。  
- 群聊必须 @bot 才触发。  
- 即时 ACK 仍为 reply(messageId)。

### 12.2 新功能

- `/p` 每次调用循环切换策略。  
- `/st` 可显示当前 chat 的策略。  
- 默认策略为 self_only。  
- self_only 下，web run 不广播到飞书。  
- session_all 下，web run 完成可主动 send 到 chat。

### 12.3 移除项

- 群聊不再 aggregate，不再 watermark。  
- 输入仅使用单条消息文本。

### 12.4 发送路径

- IM 自触发 run 完成：线程 reply。  
- 非 IM 自触发 run（web 等）：按 session_all 决定 send。  
- sentDedup 生效，重复事件不重复发送。

### 12.5 工程化

- `npm run -w plugins/feishu build` 成功。  
- `typecheck/lint/test` 可执行并纳入 root 校验链。  
- Docker 构建包含插件构建步骤。

---

## 13. 风险与回滚方案

### 13.1 主要风险

1) SSE 断连期间事件丢失（本期接受）。  
2) 插件 sqlite 损坏导致 binding/policy 丢失。  
3) send/chat 广播文案或频率引发噪音。  
4) TS 重写初期行为回归不完整。

### 13.2 缓解措施

- 统一日志维度：`chatKey/sessionId/runId/eventId`。  
- sqlite 增加启动自检与基础备份策略。  
- 默认 self_only 降低噪音面。  
- 回归清单覆盖命令与触发主路径。

### 13.3 回滚策略

- 预留插件切换开关：可回滚到旧插件产物。  
- 宿主 SSE/Query/triggerRun 新接口保持向后兼容，不影响旧链路。  
- 回滚后恢复原有 JS 插件运行（若保留旧包）。

---

## 14. 发布与运维建议

1) 分阶段灰度：先私聊验证，再开放群聊。  
2) 先开启 self_only 默认，逐步引导用户用 `/p` 开启广播。  
3) 监控指标建议：
- SSE 连接状态与重连次数
- run.completed 消费总量
- reply/send 成功率与失败率
- sentDedup 命中率

---

## 15. 结论

本方案在保持现有飞书 IM 核心交互体验的前提下，通过“宿主全量 SSE + 插件自治 + TS 重写 + sqlite 持久化”，实现了 Web run 到飞书的可订阅广播能力，并显著降低了宿主渠道耦合度。

一期明确选择 best-effort 与低复杂度路径，适配单实例本机部署场景；后续若需增强可靠性，可在此基础上逐步引入 ack/retry/outbox 等机制。
