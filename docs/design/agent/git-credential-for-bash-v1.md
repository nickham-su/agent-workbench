# Git 凭证接入 bash 工具（V1）

Status: draft

> 本文档描述“让 agent-worker 的内置 `bash` 工具在执行 `git` 命令时，复用项目现有 Credentials 体系”的 V1 方案。
>
> 设计目标是：**不破坏现有 terminal / API git service 的稳定路径**，最小增量地补齐 bash 场景的鉴权能力。

---

## 目录

- [背景与目标](#背景与目标)
- [非目标](#非目标)
- [核心原则与安全边界](#核心原则与安全边界)
- [前提假设（V1）与 V2 方向](#前提假设v1与-v2-方向)
- [总体时序流程](#总体时序流程)
- [Internal API 设计](#internal-api-设计)
  - [鉴权](#鉴权)
  - [`POST /api/internal/git-env/prepare`](#post-apiinternalgit-envprepare)
  - [`POST /api/internal/git-env/cleanup`](#post-apiinternalgit-envcleanup)
- [Lease 模型（一次性执行租约）](#lease-模型一次性执行租约)
  - [目录结构与权限建议](#目录结构与权限建议)
  - [meta.json 示例](#metajson-示例)
  - [幂等与 TTL 兜底策略](#幂等与-ttl-兜底策略)
- [凭证选择策略](#凭证选择策略)
- [Worker 触发策略（V1）与演进](#worker-触发策略v1与演进)
- [异常处理矩阵](#异常处理矩阵)
- [风险与缓解](#风险与缓解)
- [验证 / 测试建议](#验证--测试建议)
- [变更影响范围（建议，不含代码修改）](#变更影响范围建议不含代码修改)

---

## 背景与目标

### 背景

当前项目已实现一套 Git 凭证体系（HTTPS / SSH）：

- Credentials 存储于 DB（`credentials` 表，secret 加密存储），主密钥位于 `AWB_CREDENTIAL_MASTER_KEY` 或 `<dataDir>/keys/credential-master-key.json`。
- 在 **Web terminal / tmux** 场景中，API 创建终端时会根据 `workspace.terminalCredentialId` 动态注入 git 鉴权环境变量（`GIT_ASKPASS` / `GIT_SSH_COMMAND` 等）。
  - 代码参考：`apps/api/src/modules/terminals/terminal.service.ts`、`apps/api/src/modules/terminals/terminal.gitAuth.ts`
- 在 **API git service** 场景中，API 执行 push/pull/checkout 等操作前，会构造 `buildGitEnv(...)`，并在执行后 cleanup。
  - 代码参考：`apps/api/src/infra/git/gitEnv.ts`

但 **agent-worker 的内置 `bash` 工具** 当前仅继承 worker 进程的 `process.env`，并不会读取项目的 Credentials / Settings，也不会注入 askpass/ssh 环境：

- `bash` 工具执行：`apps/agent-worker/src/runtime/bash.ts`（`spawn("bash", ["-lc", ...], { env: process.env })`）
- `bash` 工具入口：`apps/agent-worker/src/runtime/tools/providers/builtin.ts`

因此，当模型通过 `bash` 执行如下命令时：

- `git clone https://...`
- `git pull` / `git fetch` / `git push`

若仓库需要鉴权，将无法自动复用项目中配置的凭证。

### 目标

在不下沉敏感能力到 worker 的前提下，让 `bash` 工具在执行 `git` 命令时具备鉴权能力：

- 支持 HTTPS / SSH 两类凭证（复用现有 credential 生成逻辑）。
- 仅使用 workspace terminal credential（与 Web terminal 行为一致）。
- 具备一次性资源的生命周期管理（prepare/use/cleanup + TTL 兜底）。
- 不改变现有终端与 API git service 的行为与稳定性。

---

## 非目标

- 不在 V1 将此能力泛化到所有工具（仅覆盖 `bash` 执行 `git` 命令的场景）。
- 不在 V1 让 worker 直接读 DB、直接解密 secret、直接读主密钥。
- 不在 V1 增加/修改 Git 全局配置（例如写入 `.gitconfig` / git credential helper）。
- 不在 V1 解决“脚本间接调用 git”的全覆盖（V1 仅对明显 git 命令触发，见后文）。

---

## 核心原则与安全边界

### 安全边界（必须遵守）

| 边界 | 规则 |
|---|---|
| Worker 不持主密钥 | worker **不得**读取 `AWB_CREDENTIAL_MASTER_KEY`、不得读取 `<dataDir>/keys/credential-master-key.json` |
| Worker 不查 DB | worker **不得**直接访问 `credentials` 表或 repo/workspace 绑定信息 |
| Worker 不打印敏感 env | worker 日志不得输出完整 env；仅允许记录 `leaseId/kind/结果` 等非敏感字段 |
| API 不返回明文 secret | API prepare 响应不得返回 token/私钥明文；应以“路径型 env + 租约”形式返回 |
| 最小暴露面 | 只在 **需要执行 git** 时注入；只注入到 **bash 子进程 env**，不污染 worker 全局 env |

### 责任划分

- API：
  - 决策与生成：选择 credential、解密 secret、生成临时文件（askpass/token/sshkey）、构造 env。
  - 生命周期：颁发租约（lease）并负责清理与 TTL 兜底。
- Worker：
  - 触发：判断是否需要 git env（V1 仅在明显 git 命令）。
  - 执行：将 API 返回的 env 合并后执行 bash。
  - 回收：在 `finally` 中调用 cleanup（best-effort）。

---

## 前提假设（V1）与 V2 方向

### V1 前提假设

**V1 假设 API 与 worker 共享同一台机器/同一文件系统视图，并且都能访问同一 `dataDir` 路径下的临时文件。**

原因：

- HTTPS askpass / SSH 私钥通常以“临时文件路径 + 环境变量”方式注入（例如 `GIT_ASKPASS=/data/tmp/.../askpass.sh`）。
- 若 worker 无法访问该路径，则 env 注入无法生效。

> 注：该假设与现有 worker 设计“同机子进程”（见 `docs/design/agent/worker.md`）一致。

### 若不满足（V2 方向）

若未来部署形态变为：API 与 worker 不共享文件系统（不同容器/不同机器），则需要 V2：

- API prepare 返回“凭证材料”（或加密后的材料）
- worker 本地落 askpass/token/sshkey 文件后执行
- worker 本地 cleanup

该方向会扩大 worker 侧敏感面，需要额外的传输加密、审计与落盘策略，因此不纳入 V1。

---

## 总体时序流程

### 概览

1. **prepare**（worker -> API）：请求一次性 git env（带 lease）
2. **bash exec**（worker）：以子进程 env 形式执行 `bash -lc <command>`
3. **cleanup**（worker -> API，finally）：回收临时文件
4. **TTL 兜底**（API）：worker crash / cleanup 失败时，API 定时清理过期 lease

### 时序图（文字版）

| 步骤 | 发起方 | 动作 | 结果 |
|---|---|---|---|
| 1 | Worker | 识别命令为 git，调用 prepare | 获取 `leaseId + env + expiresAt` |
| 2 | Worker | 合并 env，执行 bash | git 命令可使用 credential |
| 3 | Worker | `finally` 调用 cleanup | 临时文件删除，lease 标记 cleaned |
| 4 | API | 后台 TTL 扫描 | 清理未回收的过期 lease |

---

## Internal API 设计

> 约定：internal API 走现有 internal 路由风格（见 `docs/design/agent/api.md`），统一使用 header 鉴权。

### 鉴权

- Header：`x-awb-agent-internal-token: <token>`
- Content-Type：`application/json`
- Token 生成与注入方式沿用现有 internal agent 接口（worker 已具备调用 internal API 的客户端能力）。

### `POST /api/internal/git-env/prepare`

#### 语义

为 worker 即将执行的 bash 命令准备一次性 git 环境（可能包含临时文件），并返回租约信息。

#### 请求 JSON

```json
{
  "workspaceId": "w_...",
  "cwd": "/data/workspaces/w_.../worktree/...",
  "purpose": "bash",
  "timeoutMs": 120000
}
```

#### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `workspaceId` | string | 是 | 当前命令所属 workspace |
| `cwd` | string | 是 | worker 执行 bash 的当前工作目录；仅用于安全边界校验（必须位于 workspace root 之下） |
| `purpose` | string | 否 | 固定值 `bash`（便于审计/扩展） |
| `timeoutMs` | number | 否 | bash 本次执行的超时毫秒数；用于计算 lease 的 expiresAt |

#### 响应 JSON（有凭证时）

```json
{
  "ok": true,
  "leaseId": "lease_01H...",
  "kind": "https",
  "env": {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "/data/tmp/git-env/lease_01H.../askpass.sh",
    "GIT_ASKPASS_USERNAME": "oauth2",
    "GIT_ASKPASS_TOKEN_FILE": "/data/tmp/git-env/lease_01H.../token"
  },
  "expiresAt": "2026-03-17T01:30:00.000Z"
}
```

#### 响应 JSON（SSH 凭证示例）

```json
{
  "ok": true,
  "leaseId": "lease_01H...",
  "kind": "ssh",
  "env": {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_SSH_COMMAND": "ssh -i /data/tmp/git-env/lease_01H.../id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  },
  "expiresAt": "2026-03-17T01:30:00.000Z"
}
```

#### 响应 JSON（无凭证时）

```json
{
  "ok": true,
  "leaseId": null,
  "kind": "none",
  "env": {
    "GIT_TERMINAL_PROMPT": "0"
  },
  "expiresAt": null
}
```

#### 响应字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `leaseId` | string \| null | 有凭证时返回租约 ID；无凭证返回 null |
| `kind` | `https` \| `ssh` \| `none` | 本次准备的鉴权方式 |
| `env` | object | 注入到 bash 子进程的环境变量增量 |
| `expiresAt` | string \| null | 租约过期时间（ISO）；无租约则为 null |

#### 行为约束

- API **不得**返回明文 token/私钥。
- API 构造的 env 仅包含路径型信息与必要开关。
- 若构造凭证过程中发生解密失败/落盘失败，应返回 `ok:false` 并明确错误码（建议）。

#### 错误响应建议（`ok=false`）

> V1 可先仅返回 `error` 字符串；建议同时返回结构化 `errorCode`，便于 worker 做“是否可重试”的决策。

```json
{
  "ok": false,
  "errorCode": "CREDENTIAL_DECRYPT_FAILED",
  "error": "credential decrypt failed"
}
```

建议 `errorCode`（示例）：

| errorCode | 含义 | worker 建议行为 |
|---|---|---|
| `NO_REPO_MATCHED` | cwd 未命中 repo（可选） | 继续执行（仅注入 `GIT_TERMINAL_PROMPT=0`） |
| `CREDENTIAL_DECRYPT_FAILED` | 解密失败 | 直接失败，不执行 bash |
| `TEMP_FILE_WRITE_FAILED` | 临时文件落盘失败 | 直接失败，不执行 bash |
| `INTERNAL_TOKEN_INVALID` | internal token 错误 | 直接失败，并记录严重日志 |

---

### `POST /api/internal/git-env/cleanup`

#### 语义

回收一次性 git env 租约资源（临时文件/目录）。

#### 请求 JSON

```json
{
  "leaseId": "lease_01H..."
}
```

#### 响应 JSON

```json
{
  "ok": true
}
```

#### 幂等性要求

- lease 已被清理：返回 `ok:true`
- lease 目录不存在：返回 `ok:true`
- 未知 leaseId：可返回 `ok:true`（best-effort），并记录 warn

---

## Lease 模型（一次性执行租约）

### 目标

- 为“临时文件集合”提供统一生命周期：创建、使用、清理、过期兜底。
- 支持并发隔离：每次 prepare 都生成独立 lease。

### 目录结构与权限建议

建议落盘位置（绝对路径）：

- `<dataDir>/tmp/git-env/<leaseId>/`

目录结构示例：

```text
<dataDir>/tmp/git-env/lease_01H.../
  meta.json
  askpass.sh               # https
  token                    # https
  id_ed25519               # ssh（示例）
  known_hosts              # ssh（可选）
```

权限建议：

| 对象 | 权限 | 说明 |
|---|---:|---|
| lease 目录 | `0700` | 仅服务进程可读写 |
| `token` / `id_ed25519` | `0600` | 防止被其他用户读取 |
| `askpass.sh` | `0700` | 需要可执行 |

> 注意：V1 假设 worker 同机运行，但权限仍应尽量收紧。

### meta.json 示例

```json
{
  "schemaVersion": 1,
  "leaseId": "lease_01H...",
  "workspaceId": "w_...",
  "kind": "https",
  "tempDir": "/data/tmp/git-env/lease_01H...",
  "createdAt": "2026-03-17T01:10:00.000Z",
  "expiresAt": "2026-03-17T01:30:00.000Z",
  "status": "active"
}
```

### 幂等与 TTL 兜底策略

#### 幂等策略

- cleanup 必须幂等：多次调用、目录已删、lease 不存在都不应报硬错误。

#### TTL 兜底

- API 侧提供定时清理：扫描 `<dataDir>/tmp/git-env/` 下的 lease 目录
- 根据 `meta.json.expiresAt` 或目录 mtime 判断过期
- 过期即递归删除整个 lease 目录

TTL 建议值：

- `expiresAt = now + max(15min, bashTimeout + 5min buffer)`（可配置）

---

## 凭证选择策略

API 在 prepare 中仅使用 **Workspace 终端凭证**：

1. **Workspace 终端凭证**（`workspace.terminalCredentialId`）
2. 无凭证

无凭证时：

- 仍注入：`GIT_TERMINAL_PROMPT=0`
- 目的：避免 git 在 bash 中进入交互提示导致 run 卡死。

---

## Worker 触发策略（V1）与演进

### V1 触发策略：仅对明显 git 命令触发 prepare

worker 仅当命令满足下述规则之一时调用 prepare：

- 命令中出现 `git <subcommand>`（基于最小 tokenizer 的启发式扫描）：
  - `subcommand` 在白名单：`clone` / `fetch` / `pull` / `push` / `ls-remote` / `submodule`
  - 支持跳过最常见的 git 全局 options（如 `-C/-c/--git-dir/...`）

> 说明：为覆盖 `cd repo && git pull` 等写法，V1 不要求命令以 `git` 开头；但仍不试图解析复杂 shell（如 `sh ./deploy.sh` 间接调用 git）。
> 该触发策略可能误判（例如 `echo git pull`），从而导致多一次 prepare/cleanup，但不会改变 bash 命令本身的语义。

### 演进方向

- V2 可增加显式参数（tool schema 扩展），例如：
  - `useGitCredential: true`
- 或增加更智能的静态分析/拦截（但需评估误判风险与复杂度）。

---

## 异常处理矩阵

| 场景 | 现象 | V1 建议行为 | 备注 |
|---|---|---|---|
| prepare 成功 + 有凭证 | 返回 lease/env | 正常执行 bash，并 finally cleanup | - |
| prepare 成功 + 无凭证 | `kind=none` | 仍执行 bash（仅注入 `GIT_TERMINAL_PROMPT=0`） | git 可能报认证失败，但不会卡交互 |
| prepare 失败（解密失败/落盘失败/权限问题） | `ok=false` | **不执行 bash**，直接失败返回明确错误信息 | 避免产生更难诊断的 git 错误 |
| bash 执行超时 | worker kill 子进程 | 仍进入 finally 调 cleanup（best-effort） | cleanup 失败则依赖 TTL |
| cleanup 失败 | API 不可达/临时异常 | 不覆盖 bash 主错误；记录 warn；依赖 TTL 兜底 | 必须可观测 |
| worker crash / 进程被 kill -9 | cleanup 无法调用 | API TTL 扫描清理过期 lease | 这是必须的兜底 |
| 并发多次 bash git | 多个 lease 并存 | 每次 prepare 必须独立 lease 目录，互不影响 | 避免共享 token/key 文件 |

---

## 风险与缓解

| 风险 | 描述 | 缓解措施 |
|---|---|---|
| 敏感信息泄露（日志） | env 中包含路径，间接暴露 token/key 文件位置 | worker/API 日志禁止打印完整 env；仅记录 leaseId 等 |
| 临时文件残留 | cleanup 未调用或失败导致残留 askpass/token/sshkey | TTL 兜底清理；目录结构统一便于扫描 |
| 并发隔离不足 | 并发命令共享同一临时文件导致互相覆盖或提前清理 | 1 command = 1 lease；目录隔离 |
| 过期窗口过长 | TTL 太长导致残留时间过长 | TTL 与 bash timeout 绑定，并设上限 |
| 误触发注入 | 非 git 命令也 prepare，扩大敏感面 | V1 仅对白名单 git 命令触发 |
| 共享文件系统假设失效 | API 与 worker 不共享卷导致路径无效 | V1 明确前提；V2 改为 worker 本地落材料 |

---

## 验证 / 测试建议

### 最小集成用例清单

| 用例 | 前置条件 | 操作 | 期望 |
|---|---|---|---|
| HTTPS 凭证可用 | workspace 绑定 https terminal credential | `bash: git ls-remote <url>` | 能成功列出 refs |
| SSH 凭证可用 | workspace 绑定 ssh terminal credential | `bash: git ls-remote <url>` | 能成功列出 refs |
| workspace 终端凭证生效 | workspace 绑定 terminal credential | 在 workspace 内执行 git | 使用 workspace terminal credential |
| 无凭证不挂死 | 无任何 credential | `bash: git fetch` | 快速失败且不进入交互（`GIT_TERMINAL_PROMPT=0` 生效） |
| cleanup 生效 | 有凭证 | 执行后检查 `<dataDir>/tmp/git-env` | 对应 lease 目录被删除 |
| TTL 兜底 | 模拟 worker crash（不调用 cleanup） | 等待 TTL 任务 | 过期 lease 被删除 |
| 并发隔离 | 并发触发 2 次 git | 同时执行 | 生成 2 个 lease，不互相删除 |

### 观测建议

- 在 API 侧记录：prepare/cleanup 的 leaseId、kind、耗时、成功失败（不含 env 细节）。
- 在 worker 侧记录：是否触发 prepare、prepare 结果（ok/none/fail）、cleanup 结果（ok/fail）。

---

## 变更影响范围（建议，不含代码修改）

> 本文档不包含代码修改，但为实现 V1 预计涉及下列模块。

### API 侧

- 新增 internal 路由：
  - `apps/api/src/modules/...`（建议新建 `git-env` 模块或挂在现有 git/agent internal 体系中）
- 复用/参考：
  - `apps/api/src/infra/git/gitEnv.ts`（现有 git env + cleanup 模式）
  - `apps/api/src/modules/terminals/terminal.service.ts`（现有 askpass/ssh env 注入形式）

### Worker 侧

- `apps/agent-worker/src/runtime/tools/providers/builtin.ts`
  - 在 `bash` 分支增加“git 命令识别 + prepare/cleanup 调用 + env 合并”
- `apps/agent-worker/src/runtime/bash.ts`
  - 建议扩展 `runBashCommand` 支持 `extraEnv`（子进程级注入），避免污染 `process.env`
- `apps/agent-worker/src/runtime/apiClient.ts`
  - 新增 internal API 调用方法（prepare/cleanup）

---

## 附录：与现有 internal API 风格的对齐点

- internal agent 接口使用 `x-awb-agent-internal-token` 鉴权：见 `docs/design/agent/api.md`
- worker 同机子进程、通过 IPC/internal API 与 API 交互：见 `docs/design/agent/worker.md`、`docs/design/agent/ipc.md`
