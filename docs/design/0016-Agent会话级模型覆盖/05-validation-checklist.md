# 测试、验收与代码审查清单

## 测试原则

- 先验证隔离和模型来源，再验证 UI；
- 必须用 `agent_run.provider_id/model_id` 或 Worker execution profile 作为实际运行证据，不能只看标签；
- 必须验证全局 Agent `defaultModel` 未被工具 Tab 操作修改；
- 保存、重置、刷新、失效、草稿和并发边界均需覆盖；
- 不以 typecheck/build 替代业务断言；
- 不以手工截图替代 Store/API/Run 集成测试；
- 压缩测试必须区分 Run 主模型与摘要模型；
- Fork/Subtask 不继承必须有明确自动测试或数据库证据；
- 旧 Session 无覆盖兼容是发布阻断项。

## Shared 契约测试

### 合法结构

必须接受：

- 无 override + `agent_default/ready`；
- 有 override + `session_override/ready`；
- 有 override + `session_override/invalid`；
- 无 override + `agent_default/missing`；
- DELETE 后返回无 override 状态；
- DELETE 后 Agent 不存在时返回 `agent_default/missing` 与稳定 `reasonCode`；
- Session 状态 API 中 `source` 只出现 `session_override | agent_default`；
- `effectiveModel = null` 的 invalid/missing；
- 正数 `updatedAt/contextWindowTokens`；
- GET items 空数组。

### 非法结构

必须拒绝或证明应用层不会生成：

- override 非空但 source 是 `agent_default`；
- override 为空但 source 是 `session_override`；
- ready 但 effectiveModel 为空；
- Session 状态 API 返回 `run_snapshot`；
- Session 状态 API 返回 vision/compaction 来源；
- 消费者只看 `source = agent_default` 就判定可用，而忽略 `status/reasonCode`；
- 空 sessionId/agentId/providerId/modelId；
- `updatedAt <= 0`；
- `contextWindowTokens < 1`；
- 未知 source/status；
- 请求 body 含额外字段；
- 响应含 Provider API key/options；
- 消息请求新增 providerId/modelId。

## 数据库与 Store 测试矩阵

| 场景 | 预期 |
|---|---|
| 新 Session 无记录 | list 为空 |
| 插入 Session A + Agent X | 可按键和 Session 读取 |
| 同键再次 PUT | 更新 provider/model/updatedAt，不增加行 |
| Session A + Agent Y | 与 Agent X 独立 |
| Session B + Agent X | 与 Session A 独立 |
| DELETE 已存在 | 行删除 |
| DELETE 不存在 | 不抛错 |
| 删除 Session A | A 的覆盖级联删除，B 保留 |
| 非法 Session 外键 | 插入失败 |
| 特殊字符 ID | 参数化处理，无 SQL 注入 |

阻断条件：

- 主键不是 `(session_id, agent_id)`；
- Session 删除后残留覆盖；
- upsert 覆盖其他 Session/Agent；
- 存储 API key、名称等派生/敏感字段。

## 领域解析测试矩阵

### 优先级

| Run snapshot | Session override | Agent default | 预期 |
|---|---|---|---|
| 有效 | 有效 | 有效 | Run snapshot |
| 有效 | 无 | 有效 | Run snapshot |
| 无 | 有效 | 有效 | Session override |
| 无 | 无 | 有效 | Agent default |
| 无 | 失效 | 有效 | 明确错误，不回退 |
| 无 | 无 | 失效/缺失 | 明确错误 |
| 有效 | 后续覆盖变化 | 任意 | 已有 Run 仍用 snapshot |

### 原子模型 pair

必须覆盖：

- 完整 snapshot；
- 完整 override；
- 完整 default；
- snapshot 只有 provider 或只有 model；
- override 数据只有 provider 或只有 model（可通过 fake store 构造）；
- 不允许 provider 取上一层、model 取下一层；
- model 必须属于 provider。

### Agent 与 Provider 校验

- Agent 不存在；
- Agent scope 不允许 user；
- Agent 对 workspace 禁用；
- Provider 不存在；
- Model 不存在；
- Model 属于另一 Provider；
- API key 缺失；
- override 有效但 default 失效，仍可运行；
- override 失效但 default 有效，仍拒绝。

## API 测试矩阵

### GET

- 返回当前 Session 所有可用 user Agents 的状态；
- 返回持久化但已失效的 orphan override 状态；
- 不泄漏其他 Session 覆盖；
- 不泄漏其他 Workspace Session；
- Primary 正常；
- Subtask 返回不可编辑错误；
- 无覆盖时显示当前全局默认；
- 当前没有任何可用 user Agent 时允许返回 `items = []`；
- 孤立 override 仅返回不可编辑状态，不能成为可选 Agent；
- DELETE 后 Agent 不存在时，断言 `source = agent_default` 且 `status = missing`，并依据 `reasonCode` 判定不可用；
- 修改全局默认后再次 GET 反映新默认；
- 有覆盖时全局默认变化不改变有效模型；
- 响应无凭据。

### PUT

- 正常新增；
- 正常更新；
- 响应是写后状态；
- 仅目标 Session-Agent 变化；
- `agent_agents_v1` 内容不变；
- Session 不存在/跨 Workspace 拒绝；
- Subtask 拒绝；
- Agent/scope/enablement/provider/model/API key 非法拒绝；
- 拒绝时不落库；
- 同键连续 PUT 最后写入生效。

### DELETE

- 删除有效 override；
- 删除失效 override；
- 无记录时幂等成功；
- 返回删除后当前默认状态；
- 默认失效时删除仍成功，返回 invalid/missing；
- 不修改全局默认；
- 不影响其他键；
- 跨 Workspace 拒绝；
- Subtask 拒绝。

## 新 Run 与 Worker 集成测试

### 普通消息

- 无覆盖的新 Run 写入 Agent 默认 provider/model；
- 保存覆盖后的新 Run 写入覆盖 provider/model；
- Session A 覆盖不影响 Session B；
- Agent X 覆盖不影响 Agent Y；
- 覆盖保存前已创建 Run 保持原 provider/model；
- 覆盖更新后下一新 Run 使用新值；
- 重置后下一新 Run使用当前默认；
- 覆盖失效时不创建新 Run或事务完整回滚；
- 消息 body 不包含模型权威字段；
- Worker execution profile 使用 Run snapshot。

### 手动压缩

- 手动压缩 Run 主 provider/model 按 Session override；
- 配置全局 `runtime.compactionModel` 时，摘要模型仍优先使用该配置；
- 未配置时，摘要回退手动压缩 Run 主模型；
- 覆盖更新不改变已创建手动压缩 Run；
- Subtask Session 仍拒绝手动压缩。

### 自动压缩

- 当前 Run 主模型为覆盖快照时，未配置 runtime compaction 可回退该主模型；
- 配置 runtime compaction 时不被 Session 主模型覆盖；
- 自动压缩不动态查询当前 Session 最新覆盖。

### Fork 与 Subtask

- 来源 Session 有覆盖，Fork 新 Session 无覆盖；
- Fork 新 Session 新 Run 使用全局默认；
- 来源 Session 后续更新不影响 Fork；
- 父 Primary Session 有覆盖，Subtask Run 不继承；
- Subtask 使用其 requested Agent 的全局默认；
- Subtask UI 无编辑入口/API 调用。

## Web 组件测试矩阵

### 模型展示

- Session state ready/override 显示覆盖模型与来源；
- ready/default 显示默认模型与来源；
- invalid override 显示覆盖不可用，不显示默认冒充；
- missing default 显示默认不可用；
- 加载中不长期显示 global `resolvedModel` 为最终值；
- 切换 Agent 更新到对应 state；
- 切换 Session 不串 state；
- API 重载后校正过期缓存。

### 无可用 user Agent

- Agent 选择器显示现有空状态；
- 模型入口隐藏，不能打开弹窗；
- 不因点击模型区域创建真实草稿 Session；
- 按钮发送、回车发送和其他消息提交入口均被现有 Agent 不可用逻辑阻止；
- localStorage 残留 Agent ID 和孤立 override 不得恢复发送或编辑能力。

### 弹窗

- 作用域说明包含“当前会话”；
- 初始值来自 effectiveModel；
- 保存调用新 PUT；
- 不调用 `updateAgentSettings()`；
- 有覆盖时重置可用；
- 无覆盖时重置禁用；
- 重置调用 DELETE；
- PUT/DELETE 用响应更新标签；
- 失败保留旧生效状态和用户选择；
- saving/resetting 防重复提交；
- i18n 文案完整。

### 发送竞态

- PUT pending 时按钮发送禁用；
- PUT pending 时回车发送禁用；
- DELETE pending 同样禁用；
- 成功后先更新状态再恢复发送；
- 失败后恢复发送；
- 其他 Session 可继续发送；
- 已发送/运行中的 Run 不受 UI 更新影响。

### 刷新与 localStorage

- 同浏览器刷新恢复 selected Agent；
- 模型覆盖从 GET 恢复，不依赖 localStorage；
- 清空 localStorage 后重新选择 Agent 可回显后端覆盖；
- 另一浏览器选择同 Agent 可读相同覆盖；
- localStorage 中失效 Agent ID 回退可用 Agent，且状态正确；
- 覆盖数据不写入 localStorage。

### 草稿 Session

- 点击模型入口先创建真实 Session；
- 不向 API 发送 `draft_*`；
- 使用 `ensureSessionCreated()` 返回 ID；
- Tab 替换/Pane 重建后弹窗仍打开一次；
- Agent 选择迁移；
- 创建失败不打开弹窗；
- 成功后取消弹窗，Session 保留；
- 双击不重复创建/打开。

## 手工验收场景

### 主流程

- 在 Session A 选择 Agent X，记录全局默认模型 D；
- 打开弹窗，确认显示 D 与“全局默认”；
- 选择模型 M1 保存；
- 确认标签显示 M1 与“本会话覆盖”；
- 刷新页面，确认 Agent 和 M1 回显；
- 发送消息，确认新 `agent_run` 使用 M1；
- 切换 Session B + Agent X，确认仍为 D；
- 回到 Session A，点击重置；
- 确认标签回到 D；
- 发送消息，确认新 Run 使用 D；
- 检查 Settings 页 Agent X 的 defaultModel 始终为 D。

### Agent 隔离

- Session A + Agent X 设置 M1；
- Session A 切换 Agent Y，确认显示 Y 自身默认/覆盖；
- 为 Y 设置 M2；
- X 与 Y 来回切换，各自状态保持；
- 重置 X 不影响 Y。

### 已运行 Run

- 使用 D 创建并保持一个运行中 Run；
- 保存覆盖为 M1；
- 运行中 Run 继续使用 D；
- 下一新 Run 使用 M1。

### 失效与恢复

- 创建 M1 覆盖；
- 在 Settings 删除/禁用 M1 或移除凭据；
- 刷新后显示“本会话覆盖不可用”；
- 发送被拒绝且不回退 D；
- 重置覆盖；
- 若 D 有效，恢复 D；若 D 无效，显示默认不可用；
- 修复配置后重新加载变 ready。

### Fork/Subtask/压缩

- 来源 Session 有 M1，Fork；新 Session 使用 D；
- 发起 Subtask，确认 child Run 未继承 M1；
- 手动压缩主 Run 快照按 M1；
- 有 runtime compaction 时摘要仍用 runtime 模型；
- 无 runtime compaction 时可回退 M1。

## 验收标准

### 阻断级功能标准

- [ ] 工具 Tab 保存模型不再修改全局 Agent 设置。
- [ ] 覆盖键为 `(sessionId, agentId)` 且数据库唯一。
- [ ] Session/Agent/Workspace 隔离全部通过。
- [ ] “重置为默认模型”删除覆盖，不复制默认值。
- [ ] 刷新后覆盖模型和来源正确回显。
- [ ] UI 展示与下一新 Run 的 provider/model 一致。
- [ ] 新 Run 优先级为 snapshot > override > default。
- [ ] Session 状态来源仅为 override/default，Run 执行诊断来源才使用 snapshot。
- [ ] `source` 仅表示配置层，可用性始终结合 `status/reasonCode` 判断。
- [ ] 已创建/运行中的 Run 不受配置变化影响。
- [ ] 覆盖失效不静默回退默认。
- [ ] 草稿 Session 先转换为真实 Session。
- [ ] Fork/Subtask 不继承，Subtask 不可编辑。
- [ ] vision/compaction runtime 独立边界保持。
- [ ] 消息请求未新增权威模型字段。
- [ ] 保存/重置期间当前 Session 发送被阻止。
- [ ] 无可用 user Agent 时模型入口隐藏且发送被阻止。

### 兼容标准

- [ ] 旧 Session 无覆盖时行为与原全局默认一致。
- [ ] 旧数据库可自动创建新表。
- [ ] Settings 页全局模型编辑仍正常。
- [ ] 现有 Agent 选择 localStorage 恢复未回归。
- [ ] Session 删除不会留下覆盖数据。
- [ ] 回滚无需 drop table 或清理用户数据。

### 质量标准

- [ ] Shared/API/Web/Worker 相关 typecheck/build 通过。
- [ ] Store、领域服务、Routes、Run integration、Web 组件测试通过。
- [ ] 错误码稳定且日志不含敏感数据。
- [ ] 无 N+1 API 请求到每个 Agent；单 Session 状态一次批量读取。
- [ ] 无复制模型状态到 localStorage 的第二事实源。
- [ ] 独立代码审查通过，修复后完成独立复审。

## 开发核对清单

### 数据与契约

- [ ] 新表字段仅保存必要 ID 与 updatedAt。
- [ ] 主键正确，外键级联正确。
- [ ] Shared schema 有 `additionalProperties: false`。
- [ ] source/status 分离。
- [ ] Session 状态 source 枚举不含 run/vision/compaction 来源。
- [ ] 标准 JSON 示例的四种字段组合均有契约或 API 测试。
- [ ] DELETE 返回写后 effective state。
- [ ] API 不返回 Provider 凭据。

### 后端

- [ ] Route 只委派，不内联业务逻辑。
- [ ] Workspace 归属由 Session 服务端数据校验。
- [ ] PUT 校验 Agent scope/enablement/provider/model/key。
- [ ] DELETE 能清理 stale override。
- [ ] GET 单项 invalid 不使全列表失败。
- [ ] 模型 pair 原子选择，不混层。
- [ ] 普通消息 resolver 收到 sessionId。
- [ ] 手动压缩 resolver 收到 sessionId。
- [ ] Subtask resolver 不读取父覆盖。
- [ ] Worker 读取 Run snapshot。

### 前端

- [ ] 标签读 Session state，不只读 agentOptions.resolvedModel。
- [ ] 弹窗保存改用 PUT。
- [ ] 弹窗有重置 DELETE。
- [ ] source/status/错误完整展示。
- [ ] API pending 时当前 Session 发送禁用。
- [ ] 刷新调用 GET。
- [ ] 不把覆盖写 localStorage。
- [ ] 草稿 pending intent 一次性消费。
- [ ] Subtask 无入口。
- [ ] i18n 完整。

## 代码审查清单

### 架构与边界

- [ ] 是否仍有工具 Tab 路径调用 `updateAgentSettings()` 修改模型？有则阻断。
- [ ] 是否把 override 放入全局 settings JSON？有则阻断。
- [ ] 是否给 `agent_session` 加单一模型字段？有则阻断。
- [ ] 是否让 Worker 动态读取 Session override？有则阻断。
- [ ] 是否修改 vision/compaction runtime 优先级？无单独设计则阻断。
- [ ] 是否实现 Fork/Subtask 隐式继承？有则阻断。
- [ ] 是否新增消息 body provider/model 权威字段？有则阻断。

### 正确性

- [ ] Run snapshot 是否绝对优先？
- [ ] Session 状态 API 是否错误返回 `run_snapshot` 或 vision/compaction 来源？
- [ ] 是否有代码只看 `source` 而忽略 `status/reasonCode`？有则阻断。
- [ ] Provider/model 是否作为同一来源 pair 选择？
- [ ] 覆盖 invalid 是否错误回退默认？
- [ ] 重置是否真正 DELETE？
- [ ] PUT/DELETE 响应后 UI 和新 Run 是否一致？
- [ ] Session A/B、Agent A/B 是否隔离？
- [ ] 已有 Run 是否稳定？
- [ ] 手动压缩主模型与摘要模型是否被正确区分？

### 安全

- [ ] 是否校验 Session workspace 归属？
- [ ] 是否防止跨 Workspace 读写？
- [ ] 是否校验 Agent scope 与 enablement？
- [ ] 是否校验 model 属于 provider？
- [ ] 是否避免日志/响应暴露 API key？
- [ ] SQL 是否参数化？

### 前端一致性

- [ ] 是否可能显示全局模型但实际运行覆盖模型？
- [ ] 加载/错误时是否冒充 ready？
- [ ] 无可用 user Agent 时是否仍能打开模型弹窗或发送？有则阻断。
- [ ] localStorage 是否被错误当成覆盖事实源？
- [ ] 保存失败是否错误更新 UI？
- [ ] 发送竞态是否被收窄？
- [ ] 草稿转换后是否使用真实 ID？

### 测试证据

- [ ] 是否有数据库行级隔离断言？
- [ ] 是否有 `agent_run` provider/model 断言？
- [ ] 是否有全局 defaultModel 未变化断言？
- [ ] 是否有刷新、草稿、重置、invalid、Fork/Subtask、compaction 测试？
- [ ] 是否有独立审查和复审记录？

## 发布与回滚门禁

不得发布：

- 任一阻断级功能标准失败；
- UI 与新 Run 实际模型不一致；
- 全局默认被工具 Tab 修改；
- 覆盖失效静默回退；
- Worker 重算最新 Session 配置；
- 数据隔离或跨 Workspace 校验失败；
- Fork/Subtask 意外继承；
- compaction 全局配置语义被改变；
- 缺少独立审查或复审。

允许回滚但必须保留数据：

- 隐藏/禁用编辑入口；
- 保留新表和覆盖记录；
- 保留新 API 可不调用；
- 不 drop 表、不清空覆盖；
- 回滚期间明确告知覆盖暂不可编辑/不生效。
