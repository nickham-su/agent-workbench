# 状态机、并发、失败与生命周期边界

## 实现不变量

以下规则是实现、测试和审查都不可弱化的约束：

- 后端只接受已有且属于目标 Workspace 的 Session 的状态写入。
- 关闭 Tab 永远不调用 cancel、delete 或消息清理 API。
- 主会话默认显示，子任务默认隐藏；覆盖只表达偏离默认值。
- 一个客户端中，同一个 Session 同时最多一个 PUT 在途；不同 Session 可并发。
- 超时、断网、5xx 或 4xx 失败都不能证明服务端没有写入；若在途请求期间出现较新意图，必须发送该较新意图的补偿 PUT。
- 没有较新意图时，最后意图请求失败必须停止自动重试、回滚到最后明确确认/default 状态并提示。
- PUT 404 与其他最终 mutation 失败相同：仅处理当前 Session，不自动 GET、不启动完整初始化、不改变初始化状态、不影响其他 Session 队列、草稿或 activeKey。
- 初始化在 Session 列表和 Tab 状态均成功前，不得判断“所有 Tab 已关闭”并创建草稿。
- `loading/error` 初始化门控期间不得渲染普通 Tabs、普通空态或新建按钮。
- 旧 Workspace、已卸载组件或过期初始化响应不得写入当前 UI 状态或显示过期错误。
- GET 读取悬空或无意义覆盖时必须忽略，不能向客户端返回无效 ID。

## 单 Session 单飞与不确定提交补偿

### 问题：网络失败不等于服务端未提交

以下流程是必须处理的真实不确定性：

```text
最后明确确认：open
用户操作：close
PUT close：服务端已提交 close，但响应在网络层超时
用户在超时发生前或请求在途期间又操作：open
```

此时客户端最后明确 `confirmed` 仍可能是 `open`，新意图也为 `open`。若实现根据“`desired.visible === confirmed`”省略第二次 PUT，服务端会留在 `close`，违背最后用户意图。

因此，不能只比较 visible 值；必须使用 intent 序号和对象化 in-flight 快照判断是否需要补偿。

### 统一状态定义

所有前端实现、伪代码、纯逻辑测试和审查均使用以下核心结构：

```ts
type SessionWriteState = {
  // 最后收到与请求 target 一致的 HTTP 2xx 响应的明确状态。
  // 初始化成功时由 GET 的有效覆盖与 Session kind 默认规则建立；未定义时仍按 kind 默认值计算。
  confirmed?: boolean;

  // 仅用户对真实 Session 的打开/关闭意图递增；在当前组件生命周期中单调递增。
  nextIntentSeq: number;

  // 尚未明确完成的最后用户意图。
  desired?: {
    visible: boolean;
    intentSeq: number;
  };

  // 同一 Session 的唯一在途 PUT 快照。
  inFlight?: {
    visible: boolean;
    intentSeq: number;
  };
};
```

可额外保存仅用于错误提示去重的字段，但不得将其用于代替、拆分或重命名以上核心字段。

辅助函数：

```ts
function defaultVisibility(kind: "primary" | "subtask") {
  return kind === "primary";
}

function effectiveVisibility(session, state) {
  return state.desired?.visible ?? state.confirmed ?? defaultVisibility(session.kind);
}
```

`confirmed` 只可由明确 2xx 且回显值与 `inFlight.visible` 一致的响应更新。任何 catch，包括 4xx、网络中断、超时、5xx，以及 HTTP 2xx 但回显值不一致的协议错误，都不改变 `confirmed`，也不推断服务端数据库实际是否写入。

### 上下文与代次隔离

必须区分以下两类代次：

- `workspaceGeneration`：绑定 Workspace 生命周期。切换 Workspace 或组件卸载使其上下文失效。PUT 发起与回调只绑定并校验 `{ workspaceGeneration, workspaceId, disposed }`。
- `initializationAttemptId`：只绑定同一 Workspace 的关键 GET 初始化尝试。Session list 和 Tab state 的回调需要校验它，以丢弃较早尝试；PUT 回调**不得**依赖它。

这样，error 状态下同一 Workspace 的显式初始化重试不会让已有 PUT 的 finally 无法清理 `inFlight`，也不会让队列卡住。ready 状态下不会因 PUT 失败自动启动初始化。

### 请求算法伪代码

```ts
type PutContext = {
  workspaceId: string;
  workspaceGeneration: number;
};

function requestVisibility(session, visible) {
  assert(session is a persisted server Session);
  const state = ensureState(session.id);
  const intentSeq = state.nextIntentSeq + 1;
  state.nextIntentSeq = intentSeq;
  state.desired = { visible, intentSeq };     // 立即更新 UI
  void pumpSessionWrite(session.id, currentPutContext());
}

async function pumpSessionWrite(sessionId, context: PutContext) {
  const state = writeStates[sessionId];
  if (!state || state.inFlight || !state.desired) return;
  if (!isCurrentWorkspace(context) || disposed) return;

  const session = findCurrentServerSession(sessionId);
  if (!session) return;                        // 当前列表已不存在，不产生越界写

  const request = { ...state.desired };
  state.inFlight = request;

  let confirmed = false;
  let failure: unknown;
  try {
    const result = await setWorkspaceAgentSessionTabVisibility(
      context.workspaceId, sessionId, request.visible
    );
    if (!isCurrentWorkspace(context) || disposed) return;

    if (result.visible === request.visible) {
      confirmed = true;
      state.confirmed = result.visible;
    } else {
      failure = new Error("Agent tab visibility response does not match request target");
    }
  } catch (error) {
    failure = error;
  } finally {
    // PUT 回调只检查 Workspace 生命周期，不能检查 initializationAttemptId。
    if (!isCurrentWorkspace(context) || disposed) return;
    const latest = writeStates[sessionId];
    if (!latest || latest.inFlight?.intentSeq !== request.intentSeq) return;

    // 先释放唯一在途锁；随后根据 inFlight snapshot 与 desired 判断。
    delete latest.inFlight;
    const newerIntentExists = !!latest.desired
      && latest.desired.intentSeq > request.intentSeq;

    if (newerIntentExists) {
      // 无论旧请求明确成功、4xx、5xx、断网或超时，均发送最后意图。
      // 即使 latest.desired.visible === latest.confirmed 也不能省略：旧请求可能已提交。
      void pumpSessionWrite(sessionId, context);
      return;
    }

    if (confirmed) {
      // 没有较新意图，且本请求获得明确确认，才清除同序号 desired。
      if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
      return;
    }

    // 本请求是最后意图，且没有明确成功。禁止自动重试。
    // 404、其他 4xx、网络/超时、5xx 都走此分支。
    if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
    // UI 自动回到 latest.confirmed 或 Session kind 默认值。
    // 不发 GET、不改 initializationAttemptId/status、不影响其他 Session。
    showMutationError(failure);
  }
}
```

实现细节：

- `return` 位于 `try/catch` 时仍会执行 `finally`；`finally` 必须先检查 Workspace 生命周期，失效后不得写 UI、提示或继续 pump。
- 不能只以 `desired.visible === confirmed` 判断队列是否完成；只能以 `desired.intentSeq > request.intentSeq` 判断是否出现较新意图。
- 当同序号明确成功时才清除该 `desired`；如果用户在请求期间又点击，新的 `desired.intentSeq` 更大，必须保留并补偿写入。
- 请求因网络失败时，客户端无法判断服务端是否已提交；只有不存在较新意图时才停止自动重试并按最后明确状态回滚。
- 同一 Session 所有自动续写均由已有较新用户 intent 驱动；没有新用户 intent 的失败不得自动重试，因此不会无限请求。

### 结果决策表

| 在途请求结局 | 在途期间是否出现较新 `desired.intentSeq` | 客户端后续动作 | UI 最终语义 |
|---|---|---|---|
| 明确 2xx 成功 | 否 | 写入 confirmed，清除同序号 desired。 | 保持当前操作结果。|
| 明确 2xx 成功 | 是 | 保留较新 desired，必须再发一次 PUT。 | 保持较新意图。|
| 网络/超时/5xx/4xx 失败 | 否 | 清除同序号 desired，回滚并提示；不自动重试。 | 回到最后明确 confirmed/default。|
| 网络/超时/5xx/4xx 失败 | 是 | 不回滚、不提示旧失败，必须再发一次最新 desired。 | 保持较新意图，等待其结果。|
| 补偿请求失败且期间无更新 | 否 | 清除同序号 desired，回滚并提示；不自动重试。 | 回到最后明确 confirmed/default。|

### 重要测试样例：已提交但响应丢失

```text
初始：confirmed=open
intent #1：close，发送 PUT false
服务端：已提交 false；客户端：请求超时
intent #2：open，在 #1 在途期间产生，值恰好等于 confirmed
#1 finally：发现 desired.intentSeq(2) > request.intentSeq(1)
动作：必须发送 PUT true
#2 成功：confirmed=open，清除 desired
最终：服务端与 UI 均为 open
```

此案例必须是自动测试和验收项；它禁止以 `desired.visible === confirmed` 的优化替代补偿 PUT。

## 业务流程与边界预期

### 完整初始化与模板门控

“新一轮完整初始化”仅指页面刷新、组件重新挂载、切换进入某 Workspace、用户点击初始化错误态的显式重试，或上次初始化失败后 KeepAlive 工具再次激活。已经 ready 的 KeepAlive 工具最小化、切换工具、再次激活不重新读取。

```text
开始完整初始化
  → initializationStatus=loading；递增 initializationAttemptId；模板只显示加载 UI
  → 清除上一 Workspace 内存状态和 write queue；恢复 activeKey/Agent 暂选等允许保留的本地偏好
  → 并行请求 Session list、GET tab state、Agent options
  → 将 Session list 和 tab state 暂存到本 initializationAttemptId
  → 双响应均成功且 workspaceGeneration/workspaceId/initializationAttemptId/disposed 有效：同步应用
  → prune、active fallback、Tab 编号、status store
  → 无可见 Session：创建本地草稿
  → initializationStatus=ready；模板首次渲染普通 Tabs/空态/新建入口
```

预期：

- Session list 成功但 Tab state 尚慢时，不能渲染默认主会话、普通空态或新建按钮。
- 任一关键读取失败，`initializationStatus=error`，只显示错误和显式重试；不应用半份关键数据、不创建草稿、不执行普通 status store 同步。
- Agent options 失败不阻塞 ready；它遵循既有 Agent 选择功能的错误显示。
- 双关键响应成功后必须仅有一次最终同步提交；不得先写 Session、再异步覆盖 Tab state 产生可见闪烁。
- error 状态的显式重试仅重新执行关键 GET 初始化；它不由 mutation 失败触发。该同 Workspace 重试不改变 `workspaceGeneration`，且 PUT 回调不检查 `initializationAttemptId`，因此不会卡住已有队列。

### 关闭已有主会话

```text
点击关闭
  → 立即创建 desired={ visible:false, intentSeq }，当前 Tab 从 visibleSessions 排除，Tab 编号映射移除
  → activeKey 仅在当前 active Tab 已不可见时 fallback；若恢复的旧 Tab 不是 activeKey，不抢焦点
  → 单飞队列处理 PUT visible=false 及必要补偿
  → 最终失败且无新意图：回滚为 confirmed/default；重新计算可见性与编号
```

关闭最后一个可见真实 Session 时仍可立即创建本地草稿。若关闭最终失败、真实 Tab 恢复，草稿及其输入必须保留；恢复的真实 Tab 不得自动抢占仍有效的草稿 activeKey。

### 打开子任务与重开主会话

```text
点击打开子任务 / 重开主会话
  → 立即创建 desired={ visible:true, intentSeq } 并使其可见
  → 该 Tab 可被用户操作激活
  → 单飞队列处理 PUT visible=true 及必要补偿
  → 最终失败且无更新：按 confirmed/default 回滚；仅当 activeKey 已无效/不可见时 fallback
```

主会话重开在服务端对应删除覆盖；子任务打开对应写入覆盖。两种用户行为均由 PUT `{ visible: true }` 表达。

### PUT 404 与其他 mutation 失败

`404 WORKSPACE_NOT_FOUND`、`404 AGENT_SESSION_NOT_FOUND_IN_WORKSPACE` 与网络、超时、5xx、其他 4xx 使用同一单 Session 失败规则：

```text
PUT 404 且没有较新 desired
  → 释放该 Session inFlight
  → 删除该 Session 同序号 desired
  → 仅该 Session 按 confirmed/default 回滚，显示明确错误
  → 不发 GET；不修改 initializationAttemptId / initializationStatus；不创建草稿；不触碰其他 Session 队列或 activeKey
```

Session 已删除、移动到其他 Workspace 等服务端事实，不在 mutation 回调内自动收敛。它们在下一次正常新一轮完整初始化的 Session list + Tab state GET 中收敛：页面刷新、组件重挂载、Workspace 切换进入，或初始化 error 时用户显式重试/再次激活。

禁止为 mutation 失败提供隐式“完整重试”；初始化失败的显式重试入口只处理 GET 初始化错误，不能被 PUT 失败复用。

### 草稿与创建竞态

草稿 ID 是纯前端 ID，尚未在 `agent_session` 中存在。它的关闭状态仅在内存中保存。

| 时机 | 必须行为 |
|---|---|
| 草稿尚未创建，用户关闭 | 不调用 Tab 状态 API；草稿从本地可见列表隐藏。|
| 草稿可见且首次发送创建成功 | 新真实 primary Session 没有覆盖，默认可见；迁移 activeKey、选中 Agent、模型状态与 Tab 编号。|
| 草稿进入 `ensureSessionCreated()` 在途，用户关闭 | 记录草稿本地关闭意图；创建返回真实 ID 后，转交为真实 Session 的新 `desired={ visible:false, intentSeq }`，通过单飞队列提交。|
| 创建请求失败 | 不产生后端 Tab 状态；草稿及其本地关闭意图保持当前既有错误恢复逻辑。|

不得将草稿 ID 写入后端，也不得忽略“创建中已关闭”导致新建真实会话在另一设备默认重新出现。

### Workspace 切换、页面刷新与组件卸载

- 切换 Workspace 时递增 `workspaceGeneration` 与新的 `initializationAttemptId`，清空旧 Workspace 的 writeStates、在途意图和草稿本地意图，设置 `initializationStatus=loading`。
- 页面刷新或组件卸载时设置 `disposed=true`；旧 PUT 可能仍在服务端完成，但其回调不得写 UI、提示或继续 pump。新页面仅在其正常新一轮完整初始化 GET 时收敛该结果。
- 同 Workspace 的 initialization error 显式重试只递增 `initializationAttemptId`，不改变 `workspaceGeneration`，不使已有 PUT 队列失效。
- 不允许因切换而把 Workspace A 的 `sessionId` 写到 Workspace B；PUT URL、队列闭包和回调均绑定发起时 workspaceId/workspaceGeneration。

### 错误 UX 与重试边界

| 失败 | UI 与状态 | 重试规则 |
|---|---|---|
| Session list GET 失败 | `initializationStatus=error`，只显示错误与显式重试。 | 显式重试或该失败工具再次激活时，重新执行完整关键双读。|
| Tab state GET 失败 | 同上；绝不以默认规则代替。 | 同上。|
| Agent options GET 失败 | Tab 初始化仍可 ready；按既有 Agent 选择错误语义处理。 | 沿用既有选择功能路径。|
| PUT 任何失败，且无较新 intent | 清除最后意图，回滚为 confirmed/default，提示一次。 | 不自动重试、不触发 GET/初始化；用户后续点击才产生新 intent。|
| PUT 任何失败，且有较新 intent | 不回滚、不提示旧失败，发送一次最新 intent。 | 若补偿请求期间再有更新，继续按 intentSeq 补偿；每次只一个在途。|
| PUT 404 | 与上两行完全相同；只影响对应 Session。 | 不触发 GET、初始化、草稿创建或其他 Session 队列变化。|
| PUT 409 Workspace deleting | 适用上述最终失败规则；不得无限自动重试。 | 删除流程/路由离开处理。|

HTTP 业务 4xx、网络/超时、5xx 可统一按上述算法处理。前端不依赖错误类别判断旧请求是否已经在服务端提交。

### Workspace 删除

- PUT 在 `workspaceLifecycleCoordinator.withMutation()` 内执行，因此删除 intent 生效后的新写入会收到不可写错误而不是写入将被删除的 Workspace。
- 删除 Workspace 时，`workspace_id on delete cascade` 自动删除状态行。
- 前端收到 Workspace 删除造成的路由/数据变化时，旧请求回调必须受 `workspaceGeneration` / `disposed` 保护。

### Agent 域重建与悬空状态

- Agent schema 可能重建并清空 `agent_session`，而状态表因是基础域表仍存在。
- 这是预期且安全：GET 使用 inner join，不返回不再存在的 Session 覆盖；PUT 会因归属校验失败拒绝写入。
- 不在读 API 中把悬空记录暴露为错误，也不让其阻塞 Agent schema 重建。
- 可选的物理清理不属于本需求；如以后加入，必须是 best-effort、事务安全且不得使 GET 因清理失败而失败。

## localStorage 退役边界

### 必须停止的行为

从 `AgentToolView.vue` 删除/替换：

- `CLOSED_SESSION_STORAGE_PREFIX` 与 `OPENED_SUBTASK_SESSION_STORAGE_PREFIX`。
- `closedSessionStorageKey()` 与 `openedSubtaskSessionStorageKey()`。
- `persistClosedSessions()`、`persistOpenedSubtaskSessions()`。
- `restorePersistedState()` 中对 opened/closed 集合的读取。
- `onMounted()` 中会重放 opened/closed 的路径。

### 必须保留的本地行为

- `ACTIVE_KEY_STORAGE_PREFIX` 与 `persistActiveKey()`：当前焦点是设备偏好。
- `AGENT_PICK_STORAGE_PREFIX` 与 Agent 暂选：非共享 UI 偏好。
- `WorkspaceLayout.vue` 的 Dock 布局 localStorage：屏幕尺寸与设备偏好。
- 草稿、草稿输入、Tab 编号映射：短生命周期内存状态。

旧 closed/opened key 不读取、不写入、不迁移、不主动清理。

## 安全与数据边界

- 所有 API 调用必须使用当前已认证的 `/api` 通道，不能复用只面向内部 Worker 的 Agent SSE/token。
- 服务端以 `workspaceId + sessionId` 联合查询校验归属；不得仅按 Session ID 查询后写状态。
- PUT 的未知字段由 Workspace 路由局部 `preValidation` 原始 key 检查拒绝，并返回 `WORKSPACE_AGENT_TAB_STATE_UNKNOWN_FIELD`；TypeBox 不是唯一防线。
- 状态响应只包含 Session ID、可见性派生集合或当前 Session 可见性，不携带消息、提示词、模型配置、凭证或运行内容。
- 不新增文件系统、终端、Git 或凭证访问路径。
